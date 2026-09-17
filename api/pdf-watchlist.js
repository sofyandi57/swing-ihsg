// api/pdf-watchlist.js
// Vercel Serverless Function — alur PDF → AI → Watchlist (briefing section 4).
//
// POST body: { filename: string, base64: string } — PDF dikirim sebagai base64
// dalam JSON (bukan multipart/form-data) supaya tidak perlu parser multipart
// manual di serverless function polos ini. Body limit default Vercel functions
// ~4.5MB — cukup untuk PDF riset/rekomendasi beberapa halaman (bukan laporan
// keuangan tebal dengan banyak gambar/tabel kompleks).
//
// Alur (sama prinsipnya dengan mentor-call.js): ekstrak teks PDF di server →
// regex+blocklist DAN Groq (union) → validasi ke /analysis/list/stock resmi →
// simpan histori mentah ke pdf_extracts → upsert state aktif ke watchlist.
//
// GET: kembalikan watchlist LEFT JOIN status scan_results terbaru per kode,
// untuk ditampilkan di tab Watchlist.

import { createClient } from "@supabase/supabase-js";
import pdfParse from "pdf-parse";
import { requireUser } from "./_lib/auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INVEZGO_BASE_URL = "https://api.invezgo.com";
const INVEZGO_API_KEY = process.env.INVEZGO_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Sama seperti mentor-call.js — kata umum yang kebetulan 4 huruf kapital,
// diblokir sebelum validasi resmi.
const COMMON_WORD_BLOCKLIST = new Set([
  "YANG", "SAMA", "KALI", "BISA", "SAJA", "PADA", "ATAU", "DARI", "OLEH",
  "TAPI", "LAIN", "DULU", "LUAR", "AKAN", "JADI", "NILA",
  "ESDM", "ILAP", "RKAB", "OJK", "BEI", "IDX", "LRT", "MRT", "KRL", "TOD",
]);

export const config = {
  maxDuration: 60,
};

function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Cache in-memory (per warm lambda instance) — lihat mentor-call.js untuk
// rasionalnya. Daftar saham praktis statis, TTL 1 jam.
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

// Sama seperti mentor-call.js: JANGAN text.toUpperCase() dulu — itu bikin kata
// Title-Case biasa ("Jawa", "Naik", "Laba") ikut ter-uppercase dan salah kena
// tangkap kalau kebetulan cocok kode ticker resmi. Kode saham asli selalu
// ditulis FULL CAPS di teks aslinya.
function extractCandidatesRegex(text) {
  const candidates = text.match(/\b[A-Z]{4}\b/g) || [];
  return [...new Set(candidates)].filter((c) => !COMMON_WORD_BLOCKLIST.has(c));
}

// Cari kalimat (dipisah . ! ? atau baris baru) yang benar-benar menyebut kode
// ini di teks PDF — dipakai sebagai FALLBACK saat Groq tidak memberi ringkasan
// untuk kode tsb (misal kode itu hanya lolos lewat regex, bukan lewat daftar
// "stocks" yang dikembalikan Groq). Sebelumnya kode begini masuk watchlist
// dengan notes: null — user tidak tahu sama sekali kenapa kode itu menarik/
// relevan, padahal PDF-nya sendiri menyebut konteksnya di suatu tempat.
function buildCodeContext(text, code) {
  const sentences = text.split(/(?<=[.!?\n])\s+/).filter(Boolean);
  const hit = sentences.find((s) => new RegExp(`\\b${code}\\b`).test(s));
  return hit ? hit.trim().slice(0, 300) : null;
}

// Beda dengan mentor-call.js: di sini Groq juga diminta ringkasan/insight PER
// KODE (target harga, alasan rekomendasi), bukan cuma daftar kode — karena PDF
// riset biasanya punya konteks lebih kaya yang sayang dibuang (briefing 4.1).
async function extractWithGroq(text) {
  if (!GROQ_API_KEY) return { codes: [], notes: {}, skipped: true, reason: "GROQ_API_KEY belum diset" };

  // Teks PDF riset bisa panjang — batasi supaya tidak melampaui context window model
  const trimmedText = text.slice(0, 20000);

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content:
              "Anda menganalisis dokumen riset/rekomendasi saham Indonesia (IDX/BEI). Sebutkan " +
              "kode saham (4 huruf kapital, contoh: BBCA, ANTM) yang benar-benar dimaksud sebagai " +
              "emiten, beserta ringkasan singkat 1 kalimat per kode (target harga kalau disebut, " +
              "rekomendasi buy/hold/sell kalau ada, alasan singkat). JANGAN sebutkan singkatan " +
              "lembaga (ESDM, OJK, RKAB, dst) atau kata umum lain. Kalau ragu, jangan sertakan.",
          },
          { role: "user", content: trimmedText },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "pdf_stock_extraction",
            strict: true,
            schema: {
              type: "object",
              properties: {
                stocks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      code: { type: "string" },
                      note: { type: "string" },
                    },
                    required: ["code", "note"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["stocks"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    if (!resp.ok) return { codes: [], notes: {}, skipped: true, reason: `Groq HTTP ${resp.status}` };

    const data = await resp.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    const notes = {};
    const codes = [];
    for (const s of parsed.stocks || []) {
      const code = s.code.toUpperCase();
      codes.push(code);
      notes[code] = s.note;
    }
    return { codes, notes, skipped: false };
  } catch (e) {
    return { codes: [], notes: {}, skipped: true, reason: String(e.message || e) };
  }
}

// Hapus SATU kode dari watchlist — dipanggil tombol "×" di tab Watchlist.
// Tidak menghapus histori pdf_extracts/mentor_calls, cuma baris di watchlist
// aktif (kalau kode itu disebut lagi nanti dari sumber manapun, akan masuk
// lagi lewat upsert seperti biasa).
async function handleDelete(req, res, supabase) {
  const code = ((req.query && req.query.code) || "").toUpperCase().trim();
  if (!code) {
    res.status(400).json({ error: "Parameter 'code' wajib diisi." });
    return;
  }
  const { error } = await supabase.from("watchlist").delete().eq("code", code);
  if (error) {
    res.status(502).json({ error: error.message });
    return;
  }
  res.status(200).json({ deleted: true, code });
}

async function handleUpload(req, res, supabase) {
  const { filename, base64 } = req.body || {};
  if (!filename || !base64) {
    res.status(400).json({ error: "Field 'filename' dan 'base64' wajib diisi." });
    return;
  }

  let text;
  try {
    const buffer = Buffer.from(base64, "base64");
    const parsed = await pdfParse(buffer);
    text = parsed.text || "";
  } catch (e) {
    res.status(400).json({ error: `Gagal parsing PDF: ${String(e.message || e)}` });
    return;
  }

  if (!text.trim()) {
    res.status(400).json({ error: "Tidak ada teks yang bisa diekstrak dari PDF ini (mungkin hasil scan gambar tanpa OCR)." });
    return;
  }

  try {
    const validCodes = await getValidStockCodes();
    const regexCandidates = extractCandidatesRegex(text);
    const groqResult = await extractWithGroq(text);

    const merged = [...new Set([...regexCandidates, ...groqResult.codes])];
    const validated = merged.filter((code) => validCodes.has(code));

    // Prioritas catatan per kode: ringkasan Groq (paling informatif) → kalau
    // tidak ada, kalimat asli di PDF yang menyebut kode ini (fallback) → kalau
    // benar-benar tidak ketemu di manapun, tetap null (kode cuma nongol di
    // tabel/daftar tanpa konteks kalimat sama sekali).
    const aiNotes = {};
    for (const code of validated) {
      aiNotes[code] = groqResult.notes[code] || buildCodeContext(text, code) || null;
    }

    // 1. Simpan histori mentah — selalu, terlepas kode terdeteksi atau tidak
    const { data: extractRow, error: extractError } = await supabase
      .from("pdf_extracts")
      .insert({
        filename,
        raw_text: text,
        detected_codes: validated,
        ai_notes: aiNotes,
      })
      .select("id, uploaded_at")
      .single();

    if (extractError) {
      res.status(502).json({ error: `Gagal menyimpan hasil ekstraksi: ${extractError.message}` });
      return;
    }

    // 2. Upsert watchlist per kode — ON CONFLICT (code) DO UPDATE, tidak duplikat
    if (validated.length > 0) {
      const rows = validated.map((code) => ({
        code,
        updated_at: new Date().toISOString(),
        source: "pdf",
        source_ref_id: extractRow.id,
        notes: aiNotes[code],
      }));
      const { error: upsertError } = await supabase.from("watchlist").upsert(rows, { onConflict: "code" });
      if (upsertError) {
        res.status(502).json({ error: `Ekstraksi tersimpan tapi gagal update watchlist: ${upsertError.message}` });
        return;
      }
    }

    res.status(200).json({
      extractId: extractRow.id,
      uploadedAt: extractRow.uploaded_at,
      detectedCodes: validated,
      aiNotes,
      groqUsed: !groqResult.skipped,
      groqSkipReason: groqResult.skipped ? groqResult.reason : undefined,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}

async function handleGetWatchlist(req, res, supabase) {
  const { data: watchlist, error: watchlistError } = await supabase
    .from("watchlist")
    .select("*")
    .order("updated_at", { ascending: false });

  if (watchlistError) {
    res.status(502).json({ error: watchlistError.message });
    return;
  }

  if (!watchlist || watchlist.length === 0) {
    res.status(200).json({ items: [] });
    return;
  }

  const codes = watchlist.map((w) => w.code);

  // Ambil scan_results terbaru per kode (dari run manapun) — join manual di
  // JS karena Supabase-js tidak mendukung LATERAL JOIN langsung.
  const { data: recentResults, error: resultsError } = await supabase
    .from("scan_results")
    .select("code, volume_ratio, price, price_change_pct, passed_filter, run_id, scan_runs!inner(scanned_at)")
    .in("code", codes)
    .order("scanned_at", { foreignTable: "scan_runs", ascending: false });

  if (resultsError) {
    // Tetap kembalikan watchlist tanpa status scan kalau query ini gagal
    res.status(200).json({ items: watchlist.map((w) => ({ ...w, latestScan: null })) });
    return;
  }

  const latestByCode = {};
  for (const row of recentResults || []) {
    if (!latestByCode[row.code]) latestByCode[row.code] = row;
  }

  const items = watchlist.map((w) => ({
    ...w,
    latestScan: latestByCode[w.code]
      ? {
          volumeRatio: latestByCode[w.code].volume_ratio,
          price: latestByCode[w.code].price,
          priceChangePct: latestByCode[w.code].price_change_pct,
          passedFilter: latestByCode[w.code].passed_filter,
          scannedAt: latestByCode[w.code].scan_runs.scanned_at,
        }
      : null,
  }));

  res.status(200).json({ items });
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
    await handleGetWatchlist(req, res, supabase);
    return;
  }

  if (req.method === "POST") {
    await handleUpload(req, res, supabase);
    return;
  }

  if (req.method === "DELETE") {
    await handleDelete(req, res, supabase);
    return;
  }

  res.status(405).json({ error: "Method tidak didukung. Gunakan GET, POST, atau DELETE." });
}
