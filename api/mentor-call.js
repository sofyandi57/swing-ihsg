// api/mentor-call.js
// Vercel Serverless Function — terima pesan mentor (paste manual dari WA), ekstrak
// kode saham yang disebut, cross-check dengan histori scan Invezgo di Supabase, dan
// simpan pesan ini sebagai histori (mentor_calls) supaya arah sebaliknya juga bisa
// dicek nanti: "saham X di hasil scan hari ini, pernah disebut mentor kapan?".
// Kode yang terdeteksi JUGA di-upsert ke watchlist (source: "mentor_call") —
// sebelumnya cross-check ini hanya membaca histori, tidak pernah menulis ke
// watchlist, beda dengan alur PDF (api/pdf-watchlist.js) yang sejak awal begitu.
//
// POST body: { message: "teks pesan mentor" }
// GET (tanpa body): kembalikan mentor_calls terbaru, untuk ditampilkan di UI

import { createClient } from "@supabase/supabase-js";
import { requireUser } from "./_lib/auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INVEZGO_BASE_URL = "https://api.invezgo.com";
const INVEZGO_API_KEY = process.env.INVEZGO_API_KEY;

// Berapa hari ke belakang histori scan yang dicek untuk cross-check
const LOOKBACK_DAYS_FOR_CROSSCHECK = 7;

function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Ambil daftar kode saham resmi dari Invezgo untuk validasi — supaya kata biasa yang
// kebetulan 4 huruf kapital (misal "AREA", "JUAL", "BUMN") tidak salah terdeteksi
// sebagai kode saham. Di-cache in-memory per invocation (tidak lintas-request), jadi
// tiap panggilan tetap fetch ulang — untuk pemakaian sesekali sehari ini cukup ringan.
async function getValidStockCodes() {
  const resp = await fetch(`${INVEZGO_BASE_URL}/analysis/list/stock`, {
    headers: { Authorization: `Bearer ${INVEZGO_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Gagal ambil daftar saham: HTTP ${resp.status}`);
  const stocks = await resp.json();
  return new Set(stocks.map((s) => s.code.toUpperCase()));
}

// Kata bahasa Indonesia/Inggris umum yang sering muncul dalam huruf kapital di teks
// (judul di antara *bintang*, singkatan lembaga, dsb) dan SECARA KEBETULAN 4 huruf —
// diblokir sebagai lapisan pertahanan kedua SEBELUM validasi ke daftar saham resmi.
// Ini bukan pengganti validasi (beberapa kode saham BEI memang memakai kata umum,
// misal KEJU, IKAN — jadi daftar ini harus pendek dan hanya berisi kata yang MUSTAHIL
// jadi nama emiten: kata sambung, kata tanya, singkatan lembaga pemerintah/regulasi).
const COMMON_WORD_BLOCKLIST = new Set([
  // Kata sambung & kata ganti
  "YANG", "SAMA", "KALI", "BISA", "SAJA", "PADA", "ATAU", "DARI", "OLEH",
  "TAPI", "LAIN", "DULU", "LUAR", "AKAN", "JADI", "NILA",
  // Singkatan lembaga/istilah regulasi yang sering dibahas di narasi saham
  "ESDM", "ILAP", "RKAB", "OJK", "BEI", "IDX", "LRT", "MRT", "KRL", "TOD",
]);

// Ekstrak kandidat kode saham dari teks bebas via regex kasar (cari semua kata 4
// huruf kapital), buang yang ada di blocklist kata umum. Ini TIDAK divalidasi di sini
// — union-kan dengan hasil Groq dulu, baru validasi bersama di pemanggil.
function extractCandidatesRegex(text) {
  const candidates = text.toUpperCase().match(/\b[A-Z]{4}\b/g) || [];
  return [...new Set(candidates)].filter((c) => !COMMON_WORD_BLOCKLIST.has(c));
}

// Groq (openai/gpt-oss-20b, strict JSON schema) — baca teks ASLI dengan konteks
// kalimat, sebutkan kode saham yang benar-benar dimaksud sebagai emiten (bukan
// singkatan lembaga/kata umum yang kebetulan 4 huruf kapital). strict:true menjamin
// output selalu sesuai schema (constrained decoding), tidak perlu try/catch parsing.
//
// PENTING: ini TIDAK menggantikan validasi ke daftar saham resmi — LLM bisa saja
// menyebut kode yang sebenarnya tidak ada / halusinasi. Hasil Groq digabung dengan
// hasil regex, lalu KEDUANYA tetap harus lolos validasi /analysis/list/stock.
async function extractCandidatesGroq(text) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { candidates: [], skipped: true, reason: "GROQ_API_KEY belum diset" };

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content:
              "Anda menganalisis pesan seputar saham Indonesia (IDX/BEI). Sebutkan HANYA kode saham " +
              "(4 huruf kapital, contoh: BBCA, ANTM) yang benar-benar dimaksud sebagai nama emiten/perusahaan " +
              "tercatat dalam konteks kalimat. JANGAN sebutkan singkatan lembaga (ESDM, OJK, RKAB, ILAP, dst), " +
              "kata sambung, atau kata umum lain meskipun 4 huruf kapital. Kalau ragu apakah sebuah kata " +
              "adalah kode saham, JANGAN sertakan — lebih baik melewatkan daripada salah tangkap.",
          },
          { role: "user", content: text },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "stock_code_extraction",
            strict: true,
            schema: {
              type: "object",
              properties: {
                codes: {
                  type: "array",
                  items: { type: "string" },
                  description: "Kode saham 4 huruf kapital yang disebut sebagai emiten dalam teks",
                },
              },
              required: ["codes"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    if (!resp.ok) {
      return { candidates: [], skipped: true, reason: `Groq HTTP ${resp.status}` };
    }

    const data = await resp.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    const codes = (parsed.codes || []).map((c) => c.toUpperCase());
    return { candidates: codes, skipped: false };
  } catch (e) {
    // Kalau Groq gagal/timeout, jangan gagalkan seluruh request — fallback ke regex saja
    return { candidates: [], skipped: true, reason: String(e.message || e) };
  }
}

// Gabungkan kandidat dari regex+blocklist DAN Groq (union — saling melengkapi, saling
// menutupi celah masing-masing), lalu validasi SEMUA terhadap daftar saham resmi.
// Ini langkah yang sebenarnya menentukan apakah kode itu benar-benar ada dan aktif —
// tidak peduli metode mana yang mengusulkannya.
async function extractStockCodes(text, validCodes) {
  const regexCandidates = extractCandidatesRegex(text);
  const groqResult = await extractCandidatesGroq(text);

  const merged = [...new Set([...regexCandidates, ...groqResult.candidates])];
  const validated = merged.filter((code) => validCodes.has(code));

  return {
    codes: validated,
    groqUsed: !groqResult.skipped,
    groqSkipReason: groqResult.skipped ? groqResult.reason : undefined,
  };
}

async function crossCheckWithScanHistory(supabase, codes) {
  if (codes.length === 0) return {};

  const since = new Date(Date.now() - LOOKBACK_DAYS_FOR_CROSSCHECK * 24 * 60 * 60 * 1000).toISOString();

  // !inner diperlukan supaya filter .gte('scan_runs.scanned_at', ...) benar-benar
  // membatasi baris (bukan hanya filter tampilan pada relasi yang di-embed).
  const { data, error } = await supabase
    .from("scan_results")
    .select("code, volume_ratio, price, price_change_pct, passed_filter, run_id, scan_runs!inner(scanned_at)")
    .in("code", codes)
    .gte("scan_runs.scanned_at", since)
    .order("scanned_at", { foreignTable: "scan_runs", ascending: false });

  if (error) {
    // Kalau query gagal, jangan gagalkan seluruh request — kembalikan kosong dan catat pesannya
    return { _error: error.message };
  }

  const byCode = {};
  for (const code of codes) {
    byCode[code] = (data || []).filter((row) => row.code === code);
  }
  return byCode;
}

async function findPastMentorMentions(supabase, codes) {
  if (codes.length === 0) return {};

  const { data, error } = await supabase
    .from("mentor_calls")
    .select("received_at, raw_message, codes")
    .overlaps("codes", codes)
    .order("received_at", { ascending: false })
    .limit(50);

  if (error) return { _error: error.message };

  const byCode = {};
  for (const code of codes) {
    byCode[code] = (data || []).filter((row) => row.codes.includes(code));
  }
  return byCode;
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const supabase = getSupabaseClient();
  if (!supabase) {
    res.status(500).json({ error: "Supabase belum dikonfigurasi (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY kosong)." });
    return;
  }

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("mentor_calls")
      .select("*")
      .order("received_at", { ascending: false })
      .limit(20);

    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    res.status(200).json({ calls: data });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method tidak didukung. Gunakan GET atau POST." });
    return;
  }

  const message = (req.body && req.body.message) || "";
  if (!message.trim()) {
    res.status(400).json({ error: "Field 'message' kosong." });
    return;
  }

  try {
    const validCodes = await getValidStockCodes();
    const extraction = await extractStockCodes(message, validCodes);
    const detectedCodes = extraction.codes;

    // Simpan pesan ini sebagai histori — supaya "vice versa" (screener → WA) bisa
    // dicek di masa depan, terlepas dari apakah cross-check sekarang berhasil
    const { data: savedRow, error: saveError } = await supabase
      .from("mentor_calls")
      .insert({ raw_message: message, codes: detectedCodes })
      .select("id, received_at")
      .single();

    if (saveError) {
      res.status(502).json({ error: `Gagal menyimpan pesan: ${saveError.message}` });
      return;
    }

    // Upsert ke watchlist — SEBELUMNYA cross-check cuma baca histori scan,
    // tidak pernah menulis kode yang terdeteksi ke watchlist (beda dengan
    // pdf-watchlist.js yang sejak awal sudah begitu). Sekarang disamakan:
    // kode yang terdeteksi dari pesan mentor otomatis masuk watchlist juga,
    // ON CONFLICT (code) DO UPDATE — tidak duplikat kalau kode yang sama
    // sudah ada dari sumber lain (PDF/manual).
    let watchlistError = null;
    if (detectedCodes.length > 0) {
      const notesSnippet = message.trim().slice(0, 200);
      const watchlistRows = detectedCodes.map((code) => ({
        code,
        updated_at: savedRow.received_at,
        source: "mentor_call",
        source_ref_id: savedRow.id,
        notes: notesSnippet,
      }));
      const { error: upsertErr } = await supabase.from("watchlist").upsert(watchlistRows, { onConflict: "code" });
      if (upsertErr) watchlistError = upsertErr.message;
    }

    const scanCrossCheck = await crossCheckWithScanHistory(supabase, detectedCodes);
    const pastMentions = await findPastMentorMentions(supabase, detectedCodes);

    res.status(200).json({
      savedCallId: savedRow.id,
      receivedAt: savedRow.received_at,
      detectedCodes,
      groqUsed: extraction.groqUsed,
      groqSkipReason: extraction.groqSkipReason,
      scanCrossCheck, // per kode: histori scan_results dalam LOOKBACK_DAYS_FOR_CROSSCHECK hari
      pastMentions, // per kode: kapan saja mentor pernah sebut kode ini sebelumnya
      addedToWatchlist: detectedCodes.length > 0 && !watchlistError,
      watchlistError,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
