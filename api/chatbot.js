// api/chatbot.js
// Vercel Serverless Function — chat asisten Groq yang TAHU DATA APLIKASI ini:
// hasil scan terakhir, watchlist aktif, dan histori pesan mentor tersimpan di
// Supabase, plus snapshot harga terkini dari Invezgo untuk kode saham yang
// disebut di pesan User. Tidak menjalankan aksi apa pun (bukan agentic) —
// murni tanya-jawab berbasis data yang sudah ada, sama seperti fitur AI lain
// di app ini: hitung/tarik data dulu secara deterministik, baru Groq
// menarasikan jawabannya.
//
// POST body: { messages: [{ role: "user"|"assistant", content: string }, ...] }
// (riwayat percakapan dikirim penuh dari browser setiap kali — tidak ada
// state percakapan di server, sesuai pola stateless endpoint lain di app ini)

import { createClient } from "@supabase/supabase-js";
import { requireUser } from "./_lib/auth.js";
import { isInvezgoPaused } from "./_lib/invezgoPause.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INVEZGO_BASE_URL = "https://api.invezgo.com";
const INVEZGO_API_KEY = process.env.INVEZGO_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const MAX_HISTORY_MESSAGES = 20; // jaring pengaman biar payload ke Groq tidak membengkak

function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function invezgoGet(path) {
  const resp = await fetch(`${INVEZGO_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${INVEZGO_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// Cache in-memory (per warm lambda instance) untuk /analysis/list/stock — lihat
// screener.js untuk rasionalnya. Daftar saham praktis statis, TTL 1 jam.
let _stockListCache = null;
let _stockListCachedAt = 0;
const STOCK_LIST_TTL_MS = 60 * 60 * 1000;

async function getStockListCached() {
  const now = Date.now();
  if (_stockListCache && now - _stockListCachedAt < STOCK_LIST_TTL_MS) return _stockListCache;
  _stockListCache = await invezgoGet("/analysis/list/stock");
  _stockListCachedAt = now;
  return _stockListCache;
}

// BEDA dengan mentor-call.js/pdf-watchlist.js: di sana teks SUMBER ditulis
// mentor/dokumen resmi yang konsisten full caps untuk kode saham, jadi
// mempertahankan case adalah sinyal anti-ambigu yang penting (menghindari
// "Jawa"/"Naik" Title-Case ikut ter-uppercase dan salah tangkap). Di chatbot
// ini teksnya PERTANYAAN USER YANG DIKETIK BEBAS — wajar ditulis huruf kecil
// ("saham dpum gimana?"), jadi kalau regex mensyaratkan huruf besar dari teks
// asli, chatbot GAGAL TOTAL mengenali kode yang ditanyakan (persis laporan
// "AI ga bisa baca" - bukan soal mentor, tapi soal chatbot tidak mendeteksi
// kode yang diketik lowercase). Uppercase teks dulu di sini, false-positive
// kata umum tetap dicegah oleh validasi ke daftar saham resmi di bawah -
// risiko rendah untuk konteks tanya-jawab satu kode (beda dengan ekstraksi
// dari narasi panjang mentor yang rawan banyak kata umum 4-huruf).
async function extractMentionedCodes(text) {
  const candidates = [...new Set((text.toUpperCase().match(/\b[A-Z]{4,6}\b/g) || []))];
  if (candidates.length === 0) return [];
  try {
    const stockList = await getStockListCached();
    const validCodes = new Set(stockList.map((s) => s.code.toUpperCase()));
    return candidates.filter((c) => validCodes.has(c)).slice(0, 3); // maks 3 kode per pesan, biar tidak berat
  } catch (e) {
    return [];
  }
}

async function getLiveSnapshot(code) {
  try {
    const d = await invezgoGet(`/analysis/intraday-data/${code}`);
    return {
      code,
      price: Number(d.close),
      prevClose: Number(d.prev),
      changePct: d.prev ? ((Number(d.close) - Number(d.prev)) / Number(d.prev)) * 100 : null,
      volume: Number(d.volume),
      value: Number(d.value),
      freq: Number(d.freq),
    };
  } catch (e) {
    return null;
  }
}

async function gatherContext(supabase, mentionedCodes) {
  const context = {};

  // 1. Snapshot harga live untuk kode yang disebut di pesan
  if (mentionedCodes.length > 0) {
    const snapshots = await Promise.all(mentionedCodes.map(getLiveSnapshot));
    context.liveSnapshots = snapshots.filter(Boolean);

    // 2. Histori scan_results TERBARU untuk kode itu (kalau pernah lolos scan)
    const { data: scanRows } = await supabase
      .from("scan_results")
      .select("code, volume_ratio, price, value, sector, subsector, passed_filter, run_id, scan_runs!inner(scanned_at)")
      .in("code", mentionedCodes)
      .order("scanned_at", { foreignTable: "scan_runs", ascending: false })
      .limit(mentionedCodes.length * 3);
    context.recentScanRows = scanRows || [];

    // 3. Status watchlist untuk kode itu
    const { data: watchRows } = await supabase.from("watchlist").select("*").in("code", mentionedCodes);
    context.watchlistRows = watchRows || [];

    // 4. Pesan mentor yang pernah menyebut kode itu
    const { data: mentorRows } = await supabase
      .from("mentor_calls")
      .select("received_at, raw_message, codes")
      .overlaps("codes", mentionedCodes)
      .order("received_at", { ascending: false })
      .limit(5);
    context.mentorMentions = mentorRows || [];
  }

  // 5. Selalu sertakan ringkasan scan_run TERAKHIR (apa pun kodenya) — untuk
  //    pertanyaan umum seperti "saham apa yang lolos scan tadi?"
  const { data: lastRun } = await supabase
    .from("scan_runs")
    .select("*")
    .order("scanned_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastRun) {
    const { data: lastRunResults } = await supabase
      .from("scan_results")
      .select("code, volume_ratio, price, value, sector, passed_filter")
      .eq("run_id", lastRun.id)
      .eq("passed_filter", true)
      .order("volume_ratio", { ascending: false })
      .limit(15);
    context.lastRun = { ...lastRun, results: lastRunResults || [] };
  }

  // 6. Watchlist aktif (ringkas) — untuk "apa isi watchlist saya?"
  const { data: watchlist } = await supabase
    .from("watchlist")
    .select("code, source, notes, updated_at")
    .order("updated_at", { ascending: false })
    .limit(20);
  context.watchlist = watchlist || [];

  return context;
}

function buildSystemPrompt(context) {
  let ctx = "=== DATA APLIKASI (dari database & Invezgo, per saat ini) ===\n\n";

  if (context.invezgoPausedNote) {
    ctx += `CATATAN: ${context.invezgoPausedNote}\n\n`;
  }
  if (context.liveSnapshots?.length > 0) {
    ctx += "Harga terkini (live snapshot):\n" + JSON.stringify(context.liveSnapshots) + "\n\n";
  }
  if (context.recentScanRows?.length > 0) {
    ctx += "Histori scan terbaru untuk kode yang disebut User:\n" + JSON.stringify(context.recentScanRows) + "\n\n";
  }
  if (context.watchlistRows?.length > 0) {
    ctx += "Status watchlist untuk kode yang disebut User:\n" + JSON.stringify(context.watchlistRows) + "\n\n";
  }
  if (context.mentorMentions?.length > 0) {
    ctx += "Pesan mentor yang pernah menyebut kode ini:\n" + JSON.stringify(context.mentorMentions) + "\n\n";
  }
  if (context.lastRun) {
    ctx += `Scan terakhir dijalankan: ${context.lastRun.scanned_at} (${context.lastRun.total_scanned} saham dicek, ${context.lastRun.total_passed_filter} cocok kriteria). Top hasil:\n${JSON.stringify(context.lastRun.results)}\n\n`;
  }
  if (context.watchlist?.length > 0) {
    ctx += "Watchlist aktif saat ini (20 terbaru):\n" + JSON.stringify(context.watchlist) + "\n\n";
  }

  return (
    "Anda asisten chat di dalam aplikasi screener saham Indonesia (IDX/BEI) bernama " +
    "Volume Scalping Screener. Jawab pertanyaan User berdasarkan DATA APLIKASI di bawah " +
    "ini — data ini nyata (dari hasil scan/watchlist/histori mentor tersimpan, dan harga " +
    "live dari Invezgo), BUKAN training data Anda. Kalau data yang dibutuhkan tidak ada di " +
    "konteks ini, katakan terus terang tidak tahu / minta User jalankan scan atau cek tab " +
    "terkait — JANGAN mengarang angka. Jawab ringkas, dalam Bahasa Indonesia. Anda BUKAN " +
    "penasihat keuangan — selalu framing sebagai bantuan baca data, bukan rekomendasi " +
    "transaksi eksplisit.\n\n" +
    ctx
  );
}

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method tidak didukung. Gunakan POST." });
    return;
  }
  if (!GROQ_API_KEY) {
    res.status(200).json({
      reply: "Fitur chat butuh GROQ_API_KEY yang belum diset di environment variable Vercel. Minta admin untuk mengaturnya dulu.",
      groqUsed: false,
    });
    return;
  }

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Field 'messages' wajib diisi (array riwayat percakapan)." });
    return;
  }

  const trimmedHistory = messages.slice(-MAX_HISTORY_MESSAGES);
  const lastUserMessage = [...trimmedHistory].reverse().find((m) => m.role === "user")?.content || "";

  try {
    const mentionedCodes = await extractMentionedCodes(lastUserMessage);

    // Kill-switch global — chatbot TETAP bisa dipakai untuk obrolan biasa
    // saat Invezgo di-pause (beda dari endpoint scan/chart yang seluruh
    // fungsinya bergantung Invezgo), cuma konteks data saham live-nya
    // dilewati (degradasi graceful, bukan tolak total).
    const invezgoPaused = await isInvezgoPaused();
    const supabase = getSupabaseClient();
    const context = supabase && !invezgoPaused ? await gatherContext(supabase, mentionedCodes) : {};
    if (invezgoPaused && mentionedCodes.length > 0) {
      context.invezgoPausedNote =
        "Invezgo API sedang di-pause dari Admin panel — data saham live tidak tersedia sampai diaktifkan lagi.";
    }
    const systemPrompt = buildSystemPrompt(context);

    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [{ role: "system", content: systemPrompt }, ...trimmedHistory],
        temperature: 0.4,
      }),
    });

    if (!resp.ok) {
      res.status(200).json({ reply: `Groq gagal merespons (HTTP ${resp.status}). Coba lagi sebentar.`, groqUsed: false });
      return;
    }

    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "Maaf, tidak ada jawaban yang bisa diberikan.";

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ reply, groqUsed: true, mentionedCodes });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
