// api/mentor-call.js
// Vercel Serverless Function — terima pesan mentor (paste manual dari WA), ekstrak
// kode saham yang disebut, cross-check dengan histori scan Invezgo di Supabase, dan
// simpan pesan ini sebagai histori (mentor_calls) supaya arah sebaliknya juga bisa
// dicek nanti: "saham X di hasil scan hari ini, pernah disebut mentor kapan?".
//
// Mentor menandai nama saham dengan **bold** di WA (misal "**Bank BCA**" atau
// "**BBCA**") justru untuk menghindari ambigu dengan kata umum ("Laba", "Naik",
// dst yang kadang tertulis kapital juga). Teks di dalam **...** diperlakukan
// sebagai SINYAL KUAT nama/kode saham: kalau sudah berupa kode resmi langsung
// dipakai, kalau berupa nama perusahaan (bukan ticker) di-mapping ke kode lewat
// Groq, lalu tetap divalidasi ke daftar saham resmi (anti-halusinasi).
//
// Watchlist TIDAK auto-ditulis lagi dari cross-check ini — user diberi pilihan
// per kode via tombol "+ Tambah ke Watchlist" di UI (POST action=add-watchlist),
// supaya bukan mentor yang menentukan isi watchlist, tapi user yang memilih.
//
// POST body: { message: "teks pesan mentor" }
// POST body: { action: "add-watchlist", code, notes } — tambah SATU kode ke watchlist
// GET (tanpa body): kembalikan mentor_calls terbaru, untuk ditampilkan di UI
// GET ?action=check-stock&code=BBCA: cek volume ratio satu saham saja (dipakai
// tombol "Cek Scan Sekarang" di hasil cross-check) — digabung ke sini (bukan file
// api/ terpisah lagi) karena Vercel Hobby plan membatasi maksimal 12 Serverless
// Functions per deployment, dan penambahan chatbot.js sempat membuat totalnya 13.

import { createClient } from "@supabase/supabase-js";
import { requireUser } from "./_lib/auth.js";
import { rejectIfInvezgoPaused } from "./_lib/invezgoPause.js";

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
// Cache in-memory (per warm lambda instance) — daftar ~900 saham resmi praktis
// statis, tapi sebelumnya di-fetch ULANG di setiap cross-check pesan mentor,
// bahkan saat beberapa pesan di-paste berturut-turut dalam hitungan detik.
// TTL 1 jam langsung memangkas satu hit Invezgo penuh per cross-check.
let _validCodesCache = null;
let _validCodesCachedAt = 0;
const VALID_CODES_TTL_MS = 60 * 60 * 1000;

async function getValidStockCodes() {
  const now = Date.now();
  if (_validCodesCache && now - _validCodesCachedAt < VALID_CODES_TTL_MS) return _validCodesCache;

  const resp = await fetch(`${INVEZGO_BASE_URL}/analysis/list/stock`, {
    headers: { Authorization: `Bearer ${INVEZGO_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Gagal ambil daftar saham: HTTP ${resp.status}`);
  const stocks = await resp.json();
  _validCodesCache = new Set(stocks.map((s) => s.code.toUpperCase()));
  _validCodesCachedAt = now;
  return _validCodesCache;
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
// huruf yang SUDAH tertulis kapital SEMUA di teks asli — bukan di-uppercase dulu),
// buang yang ada di blocklist kata umum. TIDAK memanggil text.toUpperCase() di sini
// — itu bug yang bikin kata biasa Title-Case seperti "Jawa", "Naik", "Laba" (huruf
// pertama kapital karena awal kalimat/nama tempat, sisanya huruf kecil) ikut
// ter-uppercase jadi "JAWA"/"NAIK"/"LABA" dan salah kena tangkap sebagai kode saham
// begitu kebetulan cocok dengan kode ticker resmi. Kode saham asli yang mentor
// maksud memang selalu ditulis FULL CAPS ("MIKA"), jadi mempertahankan case asli
// adalah sinyal pembeda yang penting, bukan cuma detail kecil.
function extractCandidatesRegex(text) {
  const candidates = text.match(/\b[A-Z]{4}\b/g) || [];
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

// Ekstrak teks di dalam **bold** markdown — mentor menandai nama/kode saham
// begini justru untuk menghindari ambigu dengan kata umum. Kembalikan teks ASLI
// di dalamnya (bisa berupa kode "BBCA" atau nama perusahaan "Bank BCA"), belum
// divalidasi/di-resolve di sini.
function extractBoldSegments(text) {
  const matches = [...text.matchAll(/\*\*([^*\n]{2,40})\*\*/g)];
  const segments = matches.map((m) => m[1].trim()).filter(Boolean);
  return [...new Set(segments)];
}

// Mapping nama perusahaan (dari dalam **bold**) ke kode ticker resmi via Groq —
// dipakai HANYA untuk segmen bold yang bukan sudah berupa kode 4 huruf kapital.
// PENTING: hasil mapping ini tetap divalidasi ke daftar saham resmi oleh pemanggil,
// sama seperti sumber lain — Groq bisa saja salah/berhalusinasi kode.
async function resolveCompanyNamesToCodes(names) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || names.length === 0) return { mappings: [], skipped: true };

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
              "Anda mengubah nama perusahaan tercatat di Bursa Efek Indonesia (IDX/BEI) menjadi kode " +
              "ticker resminya (4 huruf kapital, contoh: Bank BCA -> BBCA, Astra International -> ASII). " +
              "Untuk setiap nama di daftar input, kembalikan kode ticker yang paling sesuai. Kalau nama " +
              "itu SUDAH berupa kode ticker, kembalikan apa adanya (huruf besar). Kalau ragu atau nama " +
              "tidak dikenali sebagai emiten IDX, kembalikan code: null — jangan mengarang kode.",
          },
          { role: "user", content: JSON.stringify(names) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "company_name_to_ticker",
            strict: true,
            schema: {
              type: "object",
              properties: {
                mappings: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      code: { type: ["string", "null"] },
                    },
                    required: ["name", "code"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["mappings"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    if (!resp.ok) return { mappings: [], skipped: true };

    const data = await resp.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    return { mappings: parsed.mappings || [], skipped: false };
  } catch (e) {
    return { mappings: [], skipped: true };
  }
}

// Gabungkan kandidat dari regex+blocklist, Groq (baca kalimat penuh), DAN segmen
// **bold** (sinyal kuat dari mentor — union semua, saling melengkapi), lalu
// validasi SEMUA terhadap daftar saham resmi. Ini langkah yang sebenarnya
// menentukan apakah kode itu benar-benar ada dan aktif — tidak peduli metode
// mana yang mengusulkannya.
async function extractStockCodes(text, validCodes) {
  const regexCandidates = extractCandidatesRegex(text);
  const groqResult = await extractCandidatesGroq(text);

  const boldSegments = extractBoldSegments(text);
  // Segmen bold yang sudah berbentuk kode 4-6 huruf kapital (setelah di-uppercase,
  // tanpa spasi) langsung jadi kandidat — tidak perlu lewat Groq lagi.
  const boldDirectCodes = boldSegments
    .map((s) => s.toUpperCase().replace(/\s+/g, ""))
    .filter((s) => /^[A-Z]{4,6}$/.test(s));
  // Sisanya (nama perusahaan, bukan kode) di-mapping via Groq
  const boldNamesNeedingLookup = boldSegments.filter(
    (s) => !/^[A-Z]{4,6}$/.test(s.toUpperCase().replace(/\s+/g, ""))
  );
  const nameMapping = await resolveCompanyNamesToCodes(boldNamesNeedingLookup);
  const boldMappedCodes = nameMapping.mappings
    .map((m) => (m.code || "").toUpperCase())
    .filter(Boolean);
  const boldCodesRaw = [...new Set([...boldDirectCodes, ...boldMappedCodes])];

  const merged = [...new Set([...regexCandidates, ...groqResult.candidates, ...boldCodesRaw])];
  const validated = merged.filter((code) => validCodes.has(code));
  const boldCodes = boldCodesRaw.filter((code) => validCodes.has(code));

  // Untuk tiap kode, simpan teks ASLI yang jadi rujukan (kode itu sendiri, atau
  // nama perusahaan dari **bold** yang di-mapping ke kode ini) — dipakai untuk
  // mencari kalimat konteks yang BENAR per kode, bukan snippet global yang sama
  // untuk semua kode (bug sebelumnya: semua kartu watchlist dari satu pesan
  // menampilkan cuplikan kalimat pertama yang sama persis, padahal tiap kode
  // biasanya disebut di kalimat berbeda).
  const codeSourceText = {};
  for (const m of nameMapping.mappings) {
    const code = (m.code || "").toUpperCase();
    if (code && !codeSourceText[code]) codeSourceText[code] = m.name;
  }
  for (const code of validated) {
    if (!codeSourceText[code]) codeSourceText[code] = code;
  }

  return {
    codes: validated,
    boldCodes, // subset dari `codes` yang berasal dari penandaan **bold** mentor
    codeSourceText,
    groqUsed: !groqResult.skipped,
    groqSkipReason: groqResult.skipped ? groqResult.reason : undefined,
  };
}

// Cari kalimat (dipisah oleh . ! ? atau baris baru) yang benar-benar menyebut
// `sourceText` (kode atau nama perusahaan asalnya) — supaya konteks yang
// ditampilkan/disimpan sebagai notes per kode relevan dengan kode itu, bukan
// selalu kalimat pertama pesan.
function buildCodeContext(text, code, sourceText) {
  const sentences = text.split(/(?<=[.!?\n])\s+/).filter(Boolean);
  const escaped = sourceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`, "i");
  const hit = sentences.find((s) => pattern.test(s)) || sentences.find((s) => new RegExp(`\\b${code}\\b`, "i").test(s));
  return (hit || text).trim().slice(0, 200);
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

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// Ambil harga penutupan terakhir SATU kode — dipakai untuk catat "harga saat
// masuk watchlist" di watchlist_history. Best-effort: gagal di sini TIDAK
// menggagalkan penambahan ke watchlist, cuma bikin price null di histori.
async function fetchLatestPrice(code) {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000);
    const url = new URL(`${INVEZGO_BASE_URL}/analysis/chart/stock/${code}`);
    url.searchParams.set("from", ymd(from));
    url.searchParams.set("to", ymd(to));
    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${INVEZGO_API_KEY}` } });
    if (!resp.ok) return null;
    const chart = await resp.json();
    if (!Array.isArray(chart) || chart.length === 0) return null;
    const rows = [...chart].sort((a, b) => new Date(a.date) - new Date(b.date));
    const price = Number(rows[rows.length - 1].close);
    return Number.isFinite(price) ? price : null;
  } catch (e) {
    return null;
  }
}

async function handleCheckStock(req, res) {
  if (!INVEZGO_API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }

  const code = ((req.query && req.query.code) || "").toUpperCase().trim();
  if (!code || !/^[A-Z]{4,6}$/.test(code)) {
    res.status(400).json({ error: "Parameter 'code' wajib diisi dengan kode saham valid (4-6 huruf)." });
    return;
  }

  const to = new Date();
  const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000); // buffer 10 hari

  try {
    const url = new URL(`${INVEZGO_BASE_URL}/analysis/chart/stock/${code}`);
    url.searchParams.set("from", ymd(from));
    url.searchParams.set("to", ymd(to));

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${INVEZGO_API_KEY}` },
    });

    if (resp.status === 404) {
      res.status(200).json({ result: null, note: "Kode saham tidak ditemukan." });
      return;
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }

    const chart = await resp.json();
    if (!Array.isArray(chart) || chart.length < 2) {
      res.status(200).json({ result: null, note: "Data tidak cukup (kurang dari 2 hari perdagangan)." });
      return;
    }

    const rows = [...chart].sort((a, b) => new Date(a.date) - new Date(b.date));
    const todayRow = rows[rows.length - 1];
    const prevRow = rows[rows.length - 2];

    const volume = Number(todayRow.volume);
    const prevVolume = Number(prevRow.volume);
    const price = Number(todayRow.close);
    const prevPrice = Number(prevRow.close);

    if (!prevVolume) {
      res.status(200).json({ result: null, note: "Previous volume nol, tidak bisa hitung rasio." });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      result: {
        code,
        volume,
        prevVolume,
        volumeRatio: volume / prevVolume,
        price,
        prevPrice,
        priceChangePct: ((price - prevPrice) / prevPrice) * 100,
        asOfDate: todayRow.date,
      },
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
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

  if (req.method === "GET" && req.query && req.query.action === "check-stock") {
    if (await rejectIfInvezgoPaused(req, res)) return;
    await handleCheckStock(req, res);
    return;
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    res.status(500).json({ error: "Supabase belum dikonfigurasi (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY kosong)." });
    return;
  }

  // GET tanpa action=check-stock cuma baca histori mentor_calls dari Supabase
  // — tidak menyentuh Invezgo sama sekali, TIDAK perlu kena gate.
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

  // Sisa path di bawah ini (add-watchlist via fetchLatestPrice, cross-check
  // pesan via getValidStockCodes/crossCheckWithScanHistory) SEMUA memanggil
  // Invezgo — gate satu titik di sini.
  if (await rejectIfInvezgoPaused(req, res)) return;

  // Tambah SATU kode ke watchlist atas pilihan eksplisit user (tombol "+ Tambah
  // ke Watchlist" di hasil cross-check) — menggantikan upsert otomatis semua
  // kode terdeteksi yang dipakai sebelumnya.
  if (req.body && req.body.action === "add-watchlist") {
    const code = (req.body.code || "").toUpperCase().trim();
    if (!code || !/^[A-Z]{2,6}$/.test(code)) {
      res.status(400).json({ error: "Kode saham tidak valid." });
      return;
    }
    const notes = (req.body.notes || "").trim().slice(0, 200);
    const { error: upsertErr } = await supabase
      .from("watchlist")
      .upsert(
        [{ code, updated_at: new Date().toISOString(), source: "mentor_call", notes }],
        { onConflict: "code" }
      );
    if (upsertErr) {
      res.status(502).json({ error: upsertErr.message });
      return;
    }
    const price = await fetchLatestPrice(code);
    await supabase.from("watchlist_history").insert([{ code, price, source: "mentor_call" }]);
    res.status(200).json({ added: true, code });
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

    const scanCrossCheck = await crossCheckWithScanHistory(supabase, detectedCodes);
    const pastMentions = await findPastMentorMentions(supabase, detectedCodes);

    // Konteks per kode — kalimat yang benar-benar menyebut kode/nama itu, BUKAN
    // cuplikan kalimat pertama pesan yang sama untuk semua kode (bug sebelumnya).
    const codeContext = {};
    for (const code of detectedCodes) {
      codeContext[code] = buildCodeContext(message, code, extraction.codeSourceText[code] || code);
    }

    res.status(200).json({
      savedCallId: savedRow.id,
      receivedAt: savedRow.received_at,
      detectedCodes,
      boldCodes: extraction.boldCodes, // kode yang mentor tandai tegas dengan **bold**
      codeContext, // per kode: kalimat konteks yang relevan (dipakai sebagai notes watchlist)
      groqUsed: extraction.groqUsed,
      groqSkipReason: extraction.groqSkipReason,
      scanCrossCheck, // per kode: histori scan_results dalam LOOKBACK_DAYS_FOR_CROSSCHECK hari
      pastMentions, // per kode: kapan saja mentor pernah sebut kode ini sebelumnya
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
