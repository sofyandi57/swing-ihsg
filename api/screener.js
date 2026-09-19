// api/screener.js
// Vercel Serverless Function — proxy ke Invezgo API, dijalankan HANYA saat browser
// memanggilnya (lewat salah satu dari 4 tombol kriteria di tab Run Scan). Tidak
// ada cache, tidak ada auto-polling — setiap panggilan = satu scan penuh.
//
// User memilih KRITERIA DULU (mode) sebelum scan berjalan — bukan filter sesudah
// hasil keluar. GET /api/screener?mode=<global|sektor|value|volume_spike>&...
//   mode=global                              — semua saham, tanpa kriteria
//   mode=sektor&sector=X&subsector=Y(opsional) — hanya sektor/subsektor itu
//   mode=value&minValue=100000000            — value transaksi >= itu
//   mode=volume_spike&minRatio=1.5           — rata2 volume 3 hari >= 1.5x rata2 20 hari
//
// Hasil yang dikembalikan SUDAH FINAL (server-side filtered) — frontend cuma
// sort ascending/descending, tidak ada filter lanjutan di browser.
//
// Setelah scan selesai, SEMUA saham yang berhasil di-scan (bukan hanya yang
// cocok kriteria) disimpan ke Supabase sebagai histori: satu baris di scan_runs
// (metadata run), dan satu baris per saham di scan_results (ditandai
// passed_filter true/false — true berarti cocok kriteria run itu).
//
// Durasi: dengan Fluid Compute (default Vercel sekarang), Hobby plan punya default
// maxDuration 300 detik — cukup untuk scan 900 saham dengan concurrency terbatas.
// Tetap diset eksplisit di vercel.json untuk jaga-jaga.

import { createClient } from "@supabase/supabase-js";
import { requireUser } from "./_lib/auth.js";

const INVEZGO_BASE_URL = "https://api.invezgo.com";
const API_KEY = process.env.INVEZGO_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// CRON_SECRET (env var sama dengan yang dipakai resource quota-flush di
// api/admin.js) — di sini SENGAJA hanya membolehkan mode "momentum_sniper",
// dipakai cron sore otomatis (lihat vercel.json "crons" — jadwal 15:00 WIB,
// window BSJP) supaya kandidat BSJP tersimpan ke scan_results tanpa perlu ada
// Admin yang klik manual tiap sore. Mode lain TETAP wajib login user biasa.
const CRON_SECRET = process.env.CRON_SECRET;

// Nilai default — bisa di-override lewat Admin panel (tabel app_settings),
// tanpa perlu edit kode/redeploy. Lihat loadSettingsOverrides().
//
// RIWAYAT: MIN_VALUE_ACTIVITY/MIN_FREQ sempat MENGGANTIKAN MIN_VOLUME_RATIO/
// MIN_PREV_VOLUME supaya Stage 1 bisa pakai /batch/intraday-data (hemat
// request). TERNYATA endpoint Batch DITOLAK 402 "Minimum max role required"
// oleh akun Invezgo kita — bukan soal kuota, tapi role akun di bawah minimum
// yang disyaratkan endpoint ini (dikonfirmasi dari body respons asli, lihat
// commit "Show real Invezgo error body..."). SELAMA role belum di-upgrade,
// Stage 1 global/sektor DIKEMBALIKAN ke /analysis/chart/stock/{code} satu-
// per-satu ("metode Sherly" semula) — jadi MIN_VOLUME_RATIO/MIN_PREV_VOLUME
// DIPAKAI LAGI. MIN_VALUE_ACTIVITY/MIN_FREQ TETAP ADA untuk mode "value" dan
// referensi historis (value di-estimasi price×volume sekarang, freq null).
let MIN_VOLUME_RATIO = 3.0;
let MIN_PREV_VOLUME = 1_000_000;
let MIN_VALUE_ACTIVITY = 500_000_000;
let MIN_FREQ = 50;
let MIN_PRICE = 50;
let TOP_N = 25;
let CONCURRENCY = 30; // jumlah slot paralel yang SELALU terisi (lihat runPool)

// Kode warrant/rights (-W/-R) — likuiditas sangat rendah, derivatif dari
// saham induk, bukan sinyal mandiri. Dibuang dari universe SEBELUM fetch apa
// pun (bukan cuma disaring dari tampilan) — potongan pertama dari "1200 →
// ~600 kode per scan" yang diminta User untuk hemat kuota Invezgo.
const WARRANT_RIGHTS_SUFFIX = /-(W|R)\d*$/;

// Proxy "tidak likuid sama sekali" (User: contoh CITA, maks ~1000 SID unik
// sehari) — Invezgo TIDAK punya endpoint data unique-SID/notasi khusus
// papan pemantauan, jadi ini heuristik dari HISTORI SCAN KITA SENDIRI
// (scan_results), bukan data Invezgo baru — tidak menelan kuota tambahan.
// Kode dengan value transaksi di bawah ini pada scan TERAKHIR yang tercatat
// (14 hari terakhir) dibuang dari universe. Kode yang belum pernah discan
// (histori kosong) TIDAK terpengaruh — aman untuk cold-start / kode baru IPO.
const LOW_LIQUIDITY_VALUE_THRESHOLD = 30_000_000;
const LOW_QUALITY_HISTORY_LOOKBACK_DAYS = 14;

// "Max global search 3x per hari per user" (User) — dihitung rolling 24 jam
// (lebih sederhana & tahan zona waktu daripada "hari kalender WIB"), per
// user_id, HANYA mode "global" (paling boros: seluruh universe, bukan
// subset sektor). Admin bisa override lewat app_settings kalau perlu.
let GLOBAL_SCAN_DAILY_LIMIT = 3;

// On/off toggle scheduler (dikontrol dari tab Run Scan, admin only) — dibaca
// SETIAP kali endpoint ini dipanggil lewat CRON_SECRET (mode=ara_hunter atau
// momentum_sniper). Cron Vercel sendiri tetap terjadwal (vercel.json statis,
// tidak bisa diubah runtime), tapi kalau toggle ini false, handler langsung
// skip TANPA hit Invezgo sama sekali — bukan cuma disembunyikan di UI.
let ARA_HUNTER_CRON_ENABLED = true;
let MOMENTUM_SNIPER_CRON_ENABLED = true;

// Kill-switch darurat GLOBAL (toggle di Admin panel, gauge kuota) — kalau
// true, endpoint ini menolak SEMUA mode (manual klik ATAU cron) sebelum
// satu pun request ke Invezgo terkirim. Beda dari ARA_HUNTER/MOMENTUM_SNIPER
// _CRON_ENABLED di atas (yang cuma matikan jadwal otomatis) — ini juga
// memblokir klik manual dari tab Run Scan.
let INVEZGO_PAUSED = false;

// Hardcode, BUKAN lewat app_settings — sengaja tidak bisa diubah dari Admin
// panel supaya konsisten jadi lantai minimum di semua mode. Lihat pemakaian
// di runScan() untuk alasan lengkapnya.
const MIN_VALUE_HARDCODE = 1_000_000_000;

// Cache: kalau ada scan_runs dengan kriteria PERSIS SAMA (mode+sector+subsector+
// minValue+minRatio) dalam CACHE_TTL_MINUTES terakhir, pakai ulang hasilnya —
// TIDAK panggil Invezgo lagi sama sekali. Ini yang bikin "cuma satu user yang
// direct API": begitu satu teman scan, teman lain yang scan dengan kriteria
// sama dalam beberapa menit berikutnya langsung dapat hasil dari Supabase,
// bukan nembak Invezgo lagi (menghindari rate-limit bentrok saat dipakai
// beberapa orang bersamaan).
const CACHE_TTL_MINUTES = 5;

function getSupabaseAdmin() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Kembalikan { scanRun, rows } kalau ada cache valid, atau null kalau tidak ada.
// "freq_analyzer" (baseline frekuensi transaksi) yang diminta spek Momentum
// Sniper TIDAK tersedia dari Invezgo (tidak ada histori freq harian, cuma
// snapshot live hari ini via intraday-data) — jadi baseline dibangun SENDIRI
// di sini: setiap kali mode ini dijalankan, freq+ticket_size hari ini
// disimpan ke tabel freq_baseline (lihat saveFreqSnapshot), dan baseline
// untuk hari-hari berikutnya dihitung dari rata-rata histori yang sudah
// terkumpul. Cold-start jujur: kalau belum ada histori sama sekali untuk
// suatu kode, baseline-nya null (frequencyRatio/ticketRatio tidak bisa
// dihitung) - bukan mengarang angka baseline dari mana pun.
async function getFreqBaselines(supabase, codes) {
  if (!supabase || codes.length === 0) return {};
  const todayStr = ymd(new Date());
  const { data, error } = await supabase
    .from("freq_baseline")
    .select("code, freq, ticket_size")
    .in("code", codes)
    .neq("date", todayStr);
  if (error || !data) return {};

  const byCode = {};
  for (const row of data) {
    if (!byCode[row.code]) byCode[row.code] = { freqs: [], tickets: [] };
    byCode[row.code].freqs.push(Number(row.freq));
    if (row.ticket_size != null) byCode[row.code].tickets.push(Number(row.ticket_size));
  }
  const baselines = {};
  for (const code of Object.keys(byCode)) {
    const { freqs, tickets } = byCode[code];
    baselines[code] = {
      freqAnalyzer: freqs.length > 0 ? average(freqs) : null,
      baselineTicket: tickets.length > 0 ? average(tickets) : null,
      sampleDays: freqs.length,
    };
  }
  return baselines;
}

async function saveFreqSnapshot(supabase, snapshots) {
  if (!supabase || snapshots.length === 0) return;
  const todayStr = ymd(new Date());
  const rows = snapshots
    .filter((s) => s && s.freq != null)
    .map((s) => ({ code: s.code, date: todayStr, freq: s.freq, ticket_size: s.ticketSize }));
  if (rows.length === 0) return;
  await supabase.from("freq_baseline").upsert(rows, { onConflict: "code,date" });
}

async function findCachedRun(supabase, { mode, sector, subsector, minValue, minRatio }) {
  const since = new Date(Date.now() - CACHE_TTL_MINUTES * 60 * 1000).toISOString();

  let query = supabase
    .from("scan_runs")
    .select("id, scanned_at, duration_ms, total_scanned, total_passed_filter")
    .eq("mode", mode)
    .gte("scanned_at", since)
    .order("scanned_at", { ascending: false })
    .limit(1);

  // .eq() dengan null tidak match apa pun di Postgres — pakai .is() untuk field
  // yang memang kosong, supaya cache tetap kena walau parameternya tidak diisi.
  query = sector ? query.eq("sector", sector) : query.is("sector", null);
  query = subsector ? query.eq("subsector", subsector) : query.is("subsector", null);
  query = minValue != null ? query.eq("min_value", Number(minValue)) : query.is("min_value", null);
  query = minRatio != null ? query.eq("min_ratio", Number(minRatio)) : query.is("min_ratio", null);

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;

  const { data: rows, error: rowsError } = await supabase
    .from("scan_results")
    .select("*")
    .eq("run_id", data.id)
    .eq("passed_filter", true);

  if (rowsError || !rows) return null;

  return { scanRun: data, rows };
}

// scan_results (snake_case, dari database) → bentuk yang dipakai frontend
// (camelCase, sama seperti hasil runScan() langsung dari Invezgo).
function rowFromDb(r) {
  return {
    code: r.code,
    volume: r.volume,
    prevVolume: r.prev_volume,
    price: r.price,
    prevPrice: r.prev_price,
    priceChangePct: Number(r.price_change_pct),
    sector: r.sector,
    subsector: r.subsector,
    value: Number(r.value),
    freq: r.freq != null ? Number(r.freq) : null,
    avgVolume3d: r.avg_volume_3d != null ? Number(r.avg_volume_3d) : null,
    avgVolume20d: r.avg_volume_20d != null ? Number(r.avg_volume_20d) : null,
    volRatio3v20: r.vol_ratio_3v20 != null ? Number(r.vol_ratio_3v20) : null,
    priceChange3d: r.price_change_3d != null ? Number(r.price_change_3d) : null,
    quietAccumulation: r.quiet_accumulation,
    sudahNaikTajam: r.sudah_naik_tajam,
  };
}

async function loadSettingsOverrides() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return; // Admin panel belum dipakai — pakai default

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await supabase.from("app_settings").select("key, value");
    if (error || !data) return;

    for (const row of data) {
      if (row.key === "min_volume_ratio") MIN_VOLUME_RATIO = Number(row.value);
      if (row.key === "min_prev_volume") MIN_PREV_VOLUME = Number(row.value);
      if (row.key === "min_value_activity") MIN_VALUE_ACTIVITY = Number(row.value);
      if (row.key === "min_freq") MIN_FREQ = Number(row.value);
      if (row.key === "min_price") MIN_PRICE = Number(row.value);
      if (row.key === "top_n") TOP_N = Number(row.value);
      if (row.key === "concurrency") CONCURRENCY = Number(row.value);
      if (row.key === "global_scan_daily_limit") GLOBAL_SCAN_DAILY_LIMIT = Number(row.value);
      if (row.key === "ara_hunter_cron_enabled") ARA_HUNTER_CRON_ENABLED = row.value !== false;
      if (row.key === "momentum_sniper_cron_enabled") MOMENTUM_SNIPER_CRON_ENABLED = row.value !== false;
      if (row.key === "invezgo_paused") INVEZGO_PAUSED = row.value === true;
    }
  } catch (e) {
    // Gagal baca override bukan alasan gagalkan scan — tetap pakai default di atas
  }
}

async function invezgoGet(path, params = {}) {
  const url = new URL(INVEZGO_BASE_URL + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  // Untuk 401/402/429 tampilkan BODY ASLI dari Invezgo, bukan label generik
  // tebakan — 402 di endpoint Batch ternyata bisa berarti "fitur ini butuh
  // add-on paket terpisah" (API key & paket dasar tetap valid, terbukti dari
  // endpoint lain yang sukses 200), bukan cuma "API key expired" seperti
  // asumsi awal.
  if (resp.status === 401 || resp.status === 402 || resp.status === 429) {
    const bodyText = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} di ${path}: ${bodyText || "(tanpa detail dari Invezgo)"}`);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

  return resp.json();
}

// Cache in-memory (per warm lambda instance) untuk /analysis/list/stock — daftar
// ~900 saham resmi ini praktis statis (cuma berubah kalau ada listing/delisting
// baru), tapi sebelumnya di-fetch ULANG di setiap scan, termasuk saat container
// masih warm dari request sebelumnya beberapa detik lalu. TTL 1 jam cukup aman
// dan langsung memangkas satu hit Invezgo penuh per scan.
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

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// Worker pool dengan slot yang SELALU terisi — begitu satu task selesai, slot
// langsung diisi task berikutnya. Ini jauh lebih cepat daripada batch tetap
// (ambil 10, tunggu SEMUA 10 selesai, baru ambil 10 lagi) karena batch tetap
// membiarkan slot menganggur selama menunggu request paling lambat di batch
// itu — dengan latensi Invezgo yang bervariasi per saham, ini idle time yang
// signifikan dikalikan ~90 batch.
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    await runNext();
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
  await Promise.all(workers);
  return results;
}

// Subsector TIDAK ada di /analysis/list/stock (cuma sector) — perlu panggilan
// terpisah ke /analysis/information/{code}. Terlalu mahal dipanggil untuk ~900
// saham per scan, jadi hanya dipanggil untuk saham yang LOLOS FILTER (~25),
// dengan concurrency terbatas seperti scan utama.
async function getSubsector(code) {
  try {
    const info = await invezgoGet(`/analysis/information/${code}`);
    return info?.subsector || null;
  } catch (e) {
    return null;
  }
}


// Snapshot live SATU kode untuk mode "momentum_sniper" — freq, value/volume
// hari ini, dan bid/offer LEVEL 1 SAJA (best bid/offer lot). PENTING: spesifikasi
// "Momentum Sniper" yang diminta User menyebut sum_bid_volume(5)/sum_offer_volume(5)
// (kedalaman order book 5 level) — Invezgo (tier yang dipakai app ini,
// /analysis/intraday-data) HANYA mengekspos level 1 (bid_lot/offer_lot), tidak
// ada endpoint depth-5 yang tersedia. Daripada mengarang angka level 2-5,
// tekanan order book di mode ini SENGAJA cuma pakai level 1 — didokumentasikan
// eksplisit di UI juga, bukan disembunyikan sebagai "level 5" palsu.
// Batch endpoints (/batch/intraday-data, /batch/order-book) menerima banyak
// kode sekaligus (dipisah "|") dalam SATU request — dokumentasi Invezgo sebut
// maks 10 kode untuk Role MAX, 25 untuk Role ELITE/OWNER/ADMIN. Tier akun ini
// belum diketahui, jadi pakai 10 (paling aman). Ini mengganti kebutuhan 1
// request PER KODE kandidat (dulu lewat runPool concurrency 15 di atas
// /analysis/intraday-data/{code}) jadi 1 request per 10 kode — penghematan
// kuota besar untuk shortlist Momentum Sniper yang bisa puluhan kode.
const BATCH_SIZE = 10;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Snapshot live BANYAK kode sekaligus untuk mode "momentum_sniper" — freq,
// value/volume hari ini, dan bid/offer LEVEL 1 SAJA (best bid/offer lot).
// PENTING: spesifikasi "Momentum Sniper" yang diminta User menyebut
// sum_bid_volume(5)/sum_offer_volume(5) (kedalaman order book 5 level) —
// Invezgo (tier yang dipakai app ini) HANYA mengekspos level 1 lewat batch
// endpoint (bid1lot/offer1lot), tidak ada endpoint depth-5 yang tersedia.
// Daripada mengarang angka level 2-5, tekanan order book di mode ini SENGAJA
// cuma pakai level 1 — didokumentasikan eksplisit di UI juga, bukan
// disembunyikan sebagai "level 5" palsu.
// Chunk batch di-fetch PARALEL (concurrency terbatas, lihat runPool), BUKAN
// sekuensial satu-satu — untuk universe ~1200 saham itu ~120 chunk, kalau
// sekuensial bisa 30-60+ detik sendirian (risiko timeout function, gejala
// yang User laporkan: tombol "Scan Sekarang" macet di "Memindai..." tanpa
// hasil). Concurrency 15 dipilih sama dengan CONCURRENCY default scan lain —
// cukup cepat tanpa membombardir Invezgo 120 request bersamaan sekaligus.
const BATCH_FETCH_CONCURRENCY = 15;

async function getIntradaySnapshotsBatch(codes) {
  const dataByCode = new Map();
  const bookByCode = new Map();

  await runPool(chunkArray(codes, BATCH_SIZE), BATCH_FETCH_CONCURRENCY, async (group) => {
    try {
      const results = await invezgoGet(`/batch/intraday-data/${group.join("|")}`, { market: "RG" });
      if (Array.isArray(results)) for (const r of results) dataByCode.set(r.code, r);
    } catch (e) {
      // skip chunk ini, lanjut chunk berikutnya
    }
  });
  await runPool(chunkArray(codes, BATCH_SIZE), BATCH_FETCH_CONCURRENCY, async (group) => {
    try {
      const results = await invezgoGet(`/batch/order-book/${group.join("|")}`, { market: "RG" });
      if (Array.isArray(results)) for (const r of results) bookByCode.set(r.code, r);
    } catch (e) {
      // skip chunk ini, lanjut chunk berikutnya
    }
  });

  return codes.map((code) => {
    const d = dataByCode.get(code);
    const book = bookByCode.get(code);
    const bid = book?.bid?.[0];
    const offer = book?.offer?.[0];

    const freq = Number(d?.freq);
    const value = Number(d?.value);
    const volume = Number(d?.volume);
    const bidLot = Number(bid?.bid1lot);
    const offerLot = Number(offer?.offer1lot);
    if (!Number.isFinite(freq) || freq <= 0) return null;
    return {
      code,
      freq,
      value: Number.isFinite(value) ? value : null,
      volume: Number.isFinite(volume) ? volume : null,
      bidLot: Number.isFinite(bidLot) ? bidLot : null,
      offerLot: Number.isFinite(offerLot) ? offerLot : null,
      bidOfferRatioL1: Number.isFinite(bidLot) && Number.isFinite(offerLot) && offerLot > 0 ? bidLot / offerLot : null,
      ticketSize: Number.isFinite(value) && freq > 0 ? value / freq : null,
    };
  });
}

function average(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Stage 1 murah untuk ARA Hunter — HANYA /batch/intraday-data (harga+volume+
// freq+value hari ini), TANPA order book (itu Stage 2, cuma untuk shortlist).
// Dipakai untuk seluruh universe (~90 chunk untuk ~900 kode), beda dari
// getIntradaySnapshotsBatch (dipakai Momentum Sniper) yang SEKALIGUS fetch
// order book untuk semua kode yang diberikan — kalau dipakai untuk universe
// penuh itu 2x lebih mahal dari yang dibutuhkan ARA Hunter di Stage 1.
async function getIntradayPriceSnapshotsBatch(codes) {
  const map = new Map();
  let chunkErrorCount = 0;
  let lastChunkError = null;
  await runPool(chunkArray(codes, BATCH_SIZE), BATCH_FETCH_CONCURRENCY, async (group) => {
    try {
      const results = await invezgoGet(`/batch/intraday-data/${group.join("|")}`, { market: "RG" });
      if (Array.isArray(results)) for (const r of results) map.set(r.code, r);
    } catch (e) {
      // Chunk gagal (429/5xx/timeout dll) — lanjut chunk berikutnya SUPAYA satu
      // chunk gagal tidak menggagalkan seluruh scan, tapi catat errornya:
      // kalau SEMUA chunk gagal (map tetap kosong), caller butuh info ini
      // untuk membedakan "batch fetch total gagal" dari "threshold ketat"
      // (dulu di sini errornya ditelan diam-diam, jadi 0 hasil terlihat sama
      // dengan filter ketat padahal sebenarnya data tidak pernah masuk).
      chunkErrorCount += 1;
      lastChunkError = String(e?.message || e);
    }
  });
  map.__chunkErrorCount = chunkErrorCount;
  map.__lastChunkError = lastChunkError;
  return map;
}

async function getOrderBookBatch(codes) {
  const map = new Map();
  await runPool(chunkArray(codes, BATCH_SIZE), BATCH_FETCH_CONCURRENCY, async (group) => {
    try {
      const results = await invezgoGet(`/batch/order-book/${group.join("|")}`, { market: "RG" });
      if (Array.isArray(results)) for (const r of results) map.set(r.code, r);
    } catch (e) {
      // skip chunk ini, lanjut chunk berikutnya
    }
  });
  return map;
}

// ARA Hunter — cari kandidat "Auto Reject Atas" (batas kenaikan harga harian)
// SEDINI mungkin setelah bursa buka (dirancang jalan ~09:01 WIB via cron,
// lihat vercel.json), pakai 4 sinyal yang diminta User:
//   1. Info    — sektor (dari daftar saham resmi, gratis)
//   2. Volume  — value transaksi hari ini (proxy "volume breakout" sedini
//                mungkin — belum ada baseline volume harian di menit
//                pertama, jadi dipakai VALUE bukan rasio vs kemarin)
//   3. Frequency — jumlah transaksi hari ini (banyak partisipan ikut,
//                  bukan cuma satu order nyasar)
//   4. Bid/Offer — rasio lot bid vs offer level 1 (tape reading proxy —
//                  offer menipis relatif ke bid = sedikit resistance jual,
//                  pola klasik menuju ARA)
// JUJUR: Invezgo TIDAK punya endpoint "deteksi ARA" resmi (butuh tabel batas
// auto-reject per rentang harga yang tidak tersedia di API ini) — ini
// heuristik dari 4 sinyal mentah di atas, BUKAN prediksi bergaransi. Kode
// warrant/rights (-W/-R) dikecualikan karena pergerakannya turunan saham
// induk, bukan sinyal ARA mandiri.
async function runAraHunterScan() {
  const stockList = await getStockListCached();
  const sectorByCode = new Map(stockList.map((s) => [s.code, s.sector || null]));
  const codes = stockList.map((s) => s.code).filter((c) => !WARRANT_RIGHTS_SUFFIX.test(c));

  const snapMap = await getIntradayPriceSnapshotsBatch(codes);

  const all = codes
    .map((code) => {
      const d = snapMap.get(code);
      if (!d) return null;
      const close = Number(d.close);
      const prev = Number(d.prev);
      const open = Number(d.open);
      const volume = Number(d.volume);
      const freq = Number(d.freq);
      const value = Number(d.value);
      if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(close)) return null;
      return {
        code,
        sector: sectorByCode.get(code) || null,
        price: close,
        prevPrice: prev,
        open: Number.isFinite(open) ? open : null,
        priceChangePct: ((close - prev) / prev) * 100,
        volume: Number.isFinite(volume) ? volume : 0,
        prevVolume: null,
        volumeRatio: null,
        freq: Number.isFinite(freq) ? freq : 0,
        value: Number.isFinite(value) ? value : 0,
      };
    })
    .filter(Boolean);

  // STAGE 1 gate — kandidat ARA realistis: harga sudah bergerak naik cukup
  // signifikan sedini ini, candle hijau (close > open, bukan spike lalu
  // turun), likuiditas minimal (value + freq) supaya bukan 1 lot nyasar.
  let stage1 = all.filter(
    (r) => r.priceChangePct >= 5 && r.open !== null && r.price > r.open && r.value >= 20_000_000 && r.freq >= 5
  );

  // Spek User: HARUS minimal 10 kandidat tampil. Kalau gate ketat di atas
  // menghasilkan kurang dari 10 (hari sepi/market lesu), longgarkan gate
  // TANPA menghilangkan syarat dasar (candle hijau, ada transaksi) — supaya
  // tetap ada isi, bukan mengarang kandidat yang tidak punya dasar sama
  // sekali.
  if (stage1.length < 10) {
    stage1 = all.filter((r) => r.open !== null && r.price > r.open && r.priceChangePct > 0 && r.freq >= 1);
  }

  const stage1Ranked = [...stage1].sort((a, b) => b.priceChangePct - a.priceChangePct).slice(0, 40);

  // STAGE 2 — order book (sinyal ke-4) HANYA untuk shortlist di atas, bukan
  // seluruh universe (jauh lebih hemat kuota).
  const bookMap = await getOrderBookBatch(stage1Ranked.map((r) => r.code));
  stage1Ranked.forEach((r) => {
    const book = bookMap.get(r.code);
    const bidLot = Number(book?.bid?.[0]?.bid1lot);
    const offerLot = Number(book?.offer?.[0]?.offer1lot);
    r.bidLot = Number.isFinite(bidLot) ? bidLot : null;
    r.offerLot = Number.isFinite(offerLot) ? offerLot : null;
    r.bidOfferRatio = Number.isFinite(bidLot) && Number.isFinite(offerLot) && offerLot > 0 ? bidLot / offerLot : null;
  });

  // Skor komposit 4 sinyal — dinormalisasi kasar (cap tiap komponen) supaya
  // tidak ada satu sinyal mendominasi cuma karena skalanya lebih besar
  // (value dalam rupiah vs priceChangePct dalam persen, dsb).
  stage1Ranked.forEach((r) => {
    const priceScore = Math.min(r.priceChangePct, 35);
    const freqScore = Math.min(r.freq / 10, 30);
    const valueScore = Math.min(r.value / 100_000_000, 30);
    const bidOfferScore = r.bidOfferRatio !== null ? Math.min(r.bidOfferRatio * 5, 30) : 0;
    r.araScore = priceScore + freqScore + valueScore + bidOfferScore;
  });

  const matched = [...stage1Ranked].sort((a, b) => b.araScore - a.araScore).slice(0, 15);

  return { all, matched, totalScanned: all.length };
}

// Fetch mentah + retry 429 — dipakai getDailyMetrics (Stage 1, 10 hari) DAN
// getExtendedMetrics (Stage 2, 40 hari, HANYA shortlist volume_spike/
// special_if2x yang sudah lolos Stage 1).
async function fetchChartRows(code, lookbackDays) {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  let chart;
  try {
    chart = await invezgoGet(`/analysis/chart/stock/${code}`, {
      from: ymd(from),
      to: ymd(to),
    });
  } catch (e) {
    // Retry sekali kalau kena rate limit — tanpa ini, begitu 429 muncul di
    // tengah scan, SEMUA batch sesudahnya ikut gagal terus-menerus dan hasil
    // scan jadi bias ke saham yang kebetulan diproses lebih dulu (biasanya
    // urutan alfabetis dari Invezgo — makanya sering "cuma keluar huruf A").
    if (String(e.message || e).startsWith("429")) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        chart = await invezgoGet(`/analysis/chart/stock/${code}`, { from: ymd(from), to: ymd(to) });
      } catch (e2) {
        return null;
      }
    } else {
      return null; // kode tidak valid / data kosong / error sementara — skip, jangan gagalkan seluruh scan
    }
  }

  if (!Array.isArray(chart) || chart.length < 2) return null;
  return [...chart].sort((a, b) => new Date(a.date) - new Date(b.date));
}

// STAGE 1 (dipulihkan) — "metode Sherly" satu-per-satu via chart harian,
// GANTI batch endpoint yang ditolak 402 role. Cuma OHLCV — TIDAK ada freq/
// value asli, jadi volumeRatio (hari ini vs KEMARIN) yang jadi kriteria
// utama lagi, bukan value/freq hari ini.
async function getDailyMetrics(code, lookbackDays = 10) {
  const rows = await fetchChartRows(code, lookbackDays);
  if (!rows) return null;

  const today = rows[rows.length - 1];
  const prev = rows[rows.length - 2];

  const volume = Number(today.volume);
  const prevVolume = Number(prev.volume);
  const price = Number(today.close);
  const prevPrice = Number(prev.close);
  const open = Number(today.open);

  if (!prevVolume || !Number.isFinite(volume) || !Number.isFinite(prevVolume)) return null;

  return { code, volume, prevVolume, price, prevPrice, open };
}

// Heuristik "tidak likuid" dari HISTORI SCAN KITA SENDIRI (bukan panggilan
// Invezgo baru) — lihat komentar LOW_LIQUIDITY_VALUE_THRESHOLD di atas.
// Ambil catatan TERBARU per kode dalam LOW_QUALITY_HISTORY_LOOKBACK_DAYS
// terakhir; kode yang harganya di bawah MIN_PRICE atau value-nya di bawah
// ambang tersebut dibuang dari universe scan berikutnya. Kode tanpa histori
// (belum pernah discan) tidak masuk daftar buang ini sama sekali.
async function getKnownLowQualityCodes(supabase) {
  if (!supabase) return new Set();
  try {
    const since = new Date(Date.now() - LOW_QUALITY_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("scan_results")
      .select("code, price, value, scan_runs!inner(scanned_at)")
      .gte("scan_runs.scanned_at", since)
      .order("scanned_at", { foreignTable: "scan_runs", ascending: false })
      .limit(20000);
    if (error || !data) return new Set();

    const latestByCode = new Map();
    for (const r of data) {
      if (!latestByCode.has(r.code)) latestByCode.set(r.code, r); // data sudah terurut terbaru dulu
    }

    const excluded = new Set();
    for (const [code, r] of latestByCode) {
      const price = Number(r.price);
      const value = Number(r.value);
      if (Number.isFinite(price) && price > 0 && price < MIN_PRICE) excluded.add(code);
      else if (Number.isFinite(value) && value > 0 && value < LOW_LIQUIDITY_VALUE_THRESHOLD) excluded.add(code);
    }
    return excluded;
  } catch (e) {
    return new Set(); // gagal baca histori bukan alasan gagalkan scan — universe penuh (minus warrant/rights)
  }
}

// "Max 3x scan Global per user per 24 jam" (User) — dihitung dari scan_runs
// yang BENAR-BENAR fresh (bukan cache-hit, lihat pemanggilnya di handler).
async function checkGlobalScanLimit(supabase, userId) {
  if (!supabase || !userId) return { blocked: false, count: 0 };
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("scan_runs")
      .select("id", { count: "exact", head: true })
      .eq("mode", "global")
      .eq("user_id", userId)
      .gte("scanned_at", since);
    if (error) return { blocked: false, count: 0 }; // gagal cek jangan blokir user gara-gara error kita sendiri
    return { blocked: (count || 0) >= GLOBAL_SCAN_DAILY_LIMIT, count: count || 0 };
  } catch (e) {
    return { blocked: false, count: 0 };
  }
}

// STAGE 2 khusus mode volume_spike/special_if2x — fetch ULANG dengan 40 hari,
// TAPI HANYA untuk kode yang sudah lolos filter likuiditas murah dari Stage 1
// (biasanya seperlima s/d sepersepuluh dari total universe, bukan ~900).
// Butuh minimal 23 hari PERDAGANGAN (3 hari terakhir + 20 hari sebelum itu)
// untuk rata-rata volume 3-vs-20-hari — kalau kurang (saham baru IPO, lama
// suspend, dll), semua field balik null, tidak menggagalkan baris (row itu
// nanti otomatis tersaring keluar karena volRatio3v20 null di filter mode).
async function getExtendedMetrics(code) {
  const rows = await fetchChartRows(code, 40);
  if (!rows || rows.length < 23) {
    return { avgVolume3d: null, avgVolume20d: null, volRatio3v20: null, priceChange3d: null };
  }

  const price = Number(rows[rows.length - 1].close);
  const last3 = rows.slice(-3);
  const prior20 = rows.slice(-23, -3);
  const avgVolume3d = average(last3.map((r) => Number(r.volume)));
  const avgVolume20d = average(prior20.map((r) => Number(r.volume)));
  const volRatio3v20 = avgVolume20d > 0 ? avgVolume3d / avgVolume20d : null;
  const closeStart3d = Number(rows[rows.length - 3].close);
  const priceChange3d = closeStart3d > 0 ? ((price - closeStart3d) / closeStart3d) * 100 : null;

  return { avgVolume3d, avgVolume20d, volRatio3v20, priceChange3d };
}

// Empat mode kriteria — dipilih User SEBELUM scan (bukan filter sesudahnya):
//   global       — value >= MIN_VALUE_ACTIVITY, freq >= MIN_FREQ, price >=
//                  MIN_PRICE (default Admin panel) — "aktivitas tidak biasa"
//                  hari ini, MENGGANTIKAN volume ratio vs kemarin (lihat
//                  komentar MIN_VALUE_ACTIVITY di atas untuk kenapa)
//   sektor       — sama seperti global, TAPI codes DIPERSEMPIT ke sektor (dan
//                  opsional subsektor) yang dipilih SEBELUM fetch chart, jadi
//                  scan-nya lebih cepat (bukan cuma filter tampilan)
//   value        — value (price x volume) hari ini >= minValue
//   volume_spike — rata-rata volume 3 hari terakhir >= minRatio x rata-rata
//                  volume 20 hari sebelumnya (butuh >=23 hari data — dihitung
//                  di STAGE 2, lihat getExtendedMetrics dan blok Stage 2 di
//                  bawah, HANYA untuk kandidat yang lolos saringan Stage 1)
//   special_if2x — preset "IF2X" (di-decode dari screenshot screener eksternal
//                  User, OCR): 1-day price return >= -10%, volume hari ini >=
//                  2x rata-rata volume 20 hari (BUKAN 3-hari seperti
//                  volume_spike — ini murni "hari ini vs MA20"), frequency
//                  transaksi > 1, volume >= 5 juta lembar, value > Rp 3 M,
//                  previous volume > 0. Threshold tetap (bukan input User),
//                  sesuai preset aslinya — makanya tidak butuh param minValue/
//                  minRatio dari UI, beda dengan mode "value"/"volume_spike".
async function runScan({ mode, sector, subsector, minValue, minRatio }) {
  const stockList = await getStockListCached();
  const sectorByCode = new Map(stockList.map((s) => [s.code, s.sector || null]));

  let codes = stockList.map((s) => s.code);
  if (mode === "sektor" && sector) {
    codes = stockList.filter((s) => s.sector === sector).map((s) => s.code);
  }

  // Penyaringan universe SEBELUM fetch apa pun (User: turunkan jumlah kode
  // yang benar-benar dipanggil ke Invezgo, ~1200 → ~600) — lihat komentar
  // WARRANT_RIGHTS_SUFFIX/LOW_LIQUIDITY_VALUE_THRESHOLD di atas.
  codes = codes.filter((c) => !WARRANT_RIGHTS_SUFFIX.test(c));
  const lowQualityCodes = await getKnownLowQualityCodes(getSupabaseAdmin());
  if (lowQualityCodes.size > 0) {
    codes = codes.filter((c) => !lowQualityCodes.has(c));
  }

  // STAGE 1 — /analysis/chart/stock/{code} SATU-PER-SATU ("metode Sherly"
  // semula). Batch endpoint (/batch/intraday-data) DITOLAK 402 "Minimum max
  // role required" oleh akun Invezgo kita — role akun di bawah minimum yang
  // disyaratkan endpoint Batch, BUKAN soal kuota (lihat komentar
  // MIN_VOLUME_RATIO di atas). Penyaringan universe di atas (warrant/rights +
  // histori tidak likuid) MENGGANTIKAN penghematan yang tadinya didapat dari
  // batch — jumlah request tetap terkendali walau kembali per-kode.
  const dailyMetrics = await runPool(codes, CONCURRENCY, (code) => getDailyMetrics(code));
  const rawResults = codes
    .map((code, i) => {
      const d = dailyMetrics[i];
      if (!d) return null;
      return {
        code,
        price: d.price,
        prevPrice: d.prevPrice,
        open: Number.isFinite(d.open) ? d.open : null,
        low: null,
        high: null,
        volume: d.volume,
        prevVolume: d.prevVolume,
        volumeRatio: d.prevVolume > 0 ? d.volume / d.prevVolume : null,
        // freq TIDAK tersedia dari /analysis/chart/stock (cuma OHLCV) — null
        // (bukan 0), supaya filter yang butuh freq tahu ini "tidak diketahui".
        freq: null,
        // value diestimasi price×volume — Invezgo tidak expose value asli
        // lewat endpoint per-kode ini (beda dari batch endpoint yang punya
        // field value langsung). Kurang presisi, tapi konsekuensi jujur dari
        // kembali ke endpoint per-kode karena role akun tidak cukup.
        value: d.price * d.volume,
        avgVolume3d: null,
        avgVolume20d: null,
        volRatio3v20: null,
        priceChange3d: null,
      };
    })
    .filter(Boolean);

  // sector diambil dari daftar saham (gratis, sudah di memori).
  const allWithRatio = rawResults.map((r) => {
    const priceChangePct = ((r.price - r.prevPrice) / r.prevPrice) * 100;
    // Metadata informatif (ditampilkan sebagai badge di card) — TIDAK dipakai
    // untuk menyaring hasil di mode manapun kecuali "volume_spike" (yang pakai
    // volRatio3v20 mentah, tanpa syarat harga 0-10% ini).
    const quietAccumulation =
      r.volRatio3v20 !== null && r.priceChange3d !== null && r.volRatio3v20 >= 1.0 && r.priceChange3d >= 0 && r.priceChange3d <= 10;
    // Proxy "sudah naik tajam duluan" (kemungkinan sudah/dekat ARA) — heuristik
    // dari priceChangePct hari ini, BUKAN deteksi ARA resmi (butuh data batas
    // auto-reject per tier harga yang tidak tersedia di endpoint ini). Dipakai
    // sebagai badge peringatan, TIDAK menyaring hasil keluar — sesuai metode
    // Sherly (langkah 5-6): tetap tampilkan, tapi kasih tahu risikonya supaya
    // User yang putuskan, bukan otomatis dibuang.
    const sudahNaikTajam = priceChangePct >= 20;
    // volumeVsMA20 — volume HARI INI dibagi rata-rata volume 20 hari (bukan
    // rata-rata 3 hari seperti volRatio3v20/"volume_spike"). Ini definisi
    // "volume breakout" yang dipakai preset IF2X: satu hari lonjakan volume
    // relatif terhadap baseline sebulan terakhir, bukan tren 3 hari.
    const volumeVsMA20 = r.avgVolume20d ? r.volume / r.avgVolume20d : null;
    return {
      ...r,
      priceChangePct,
      volumeVsMA20,
      quietAccumulation,
      sudahNaikTajam,
      sector: sectorByCode.get(r.code) || null,
    };
  });

  // Subsector: mode "sektor" sudah mempersempit codes ke satu sektor (biasanya
  // puluhan-ratusan saham, bukan 900) — jadi terjangkau untuk fetch subsector
  // SEMUA baris di mode ini, bukan cuma top-N seperti sebelumnya.
  if (mode === "sektor") {
    const subsectorBatch = await Promise.all(allWithRatio.map((r) => getSubsector(r.code)));
    allWithRatio.forEach((r, i) => {
      r.subsector = subsectorBatch[i];
    });
  }

  // STAGE 2 — HANYA mode volume_spike/special_if2x (butuh avgVolume20d/
  // volRatio3v20 yang perlu 40 hari data). Saring dulu pakai likuiditas MURAH
  // dari Stage 1 (value >= Rp200jt — sengaja LEBIH LONGGAR dari threshold
  // akhir mode manapun, supaya tidak salah buang kandidat sebelum data
  // 40-harinya sendiri sempat dicek) SEBELUM fetch mahal 40-hari. Untuk scan
  // ~900 saham, biasanya cuma tersisa puluhan-ratusan yang lolos saringan
  // longgar ini — jauh lebih murah daripada fetch 40-hari untuk semua 900.
  if (mode === "volume_spike" || mode === "special_if2x") {
    const stage2Candidates = allWithRatio.filter((r) => r.value >= 200_000_000);
    const extendedBatch = await runPool(stage2Candidates, CONCURRENCY, (r) => getExtendedMetrics(r.code));
    stage2Candidates.forEach((r, i) => {
      const ext = extendedBatch[i];
      r.avgVolume3d = ext.avgVolume3d;
      r.avgVolume20d = ext.avgVolume20d;
      r.volRatio3v20 = ext.volRatio3v20;
      r.priceChange3d = ext.priceChange3d;
      // volumeVsMA20 dihitung ulang di sini karena di Stage 1 avgVolume20d
      // masih null (belum ada data 40-hari) — quietAccumulation juga
      // bergantung volRatio3v20/priceChange3d yang baru terisi di Stage 2 ini.
      r.volumeVsMA20 = r.avgVolume20d ? r.volume / r.avgVolume20d : null;
      r.quietAccumulation =
        r.volRatio3v20 !== null && r.priceChange3d !== null && r.volRatio3v20 >= 1.0 && r.priceChange3d >= 0 && r.priceChange3d <= 10;
    });
  }

  let matched;
  if (mode === "value") {
    const threshold = Number(minValue) || 0;
    matched = allWithRatio.filter((r) => r.value >= threshold).sort((a, b) => b.value - a.value);
  } else if (mode === "volume_spike") {
    const threshold = Number(minRatio) || 1;
    matched = allWithRatio
      .filter((r) => r.volRatio3v20 !== null && r.volRatio3v20 >= threshold)
      .sort((a, b) => b.volRatio3v20 - a.volRatio3v20);
  } else if (mode === "special_if2x") {
    // Rule 1-3, 5-6, 8 dari preset IF2X (lihat komentar di atas fungsi ini).
    // Rule "Frequency > 1" (rule 4 & 7 di screenshot, sama-sama syarat freq —
    // dianggap satu syarat freq > 1) BELUM diterapkan di sini karena freq
    // butuh panggilan Invezgo terpisah (lihat getFrequency) — diterapkan
    // SESUDAH ini, hanya untuk saham yang sudah lolos semua filter murah di
    // bawah, supaya tidak menambah ratusan hit API percuma ke universe penuh.
    // Rule "volumeChangePct > -100%" versi asli butuh volume KEMARIN (tidak
    // lagi tersedia sejak Stage 1 pindah ke batch endpoint — lihat komentar
    // MIN_VALUE_ACTIVITY di atas) — DIHAPUS, bukan disamarkan. Dampaknya kecil:
    // floor "volume >= 5jt" di bawah sudah cukup menyaring saham nyaris tidak
    // bertransaksi, tujuan asli rule ini.
    matched = allWithRatio
      .filter((r) =>
        r.priceChangePct >= -10 &&
        r.volumeVsMA20 !== null && r.volumeVsMA20 >= 2 &&
        r.volume >= 5_000_000 &&
        r.value > 3_000_000_000
      )
      .sort((a, b) => b.volumeVsMA20 - a.volumeVsMA20);
  } else if (mode === "momentum_sniper") {
    // STAGE 1 (Liquidity Gate + harga) dari spek "Momentum Sniper" User — cuma
    // pakai data EOD murah (chart harian) untuk mempersempit ~900 saham jadi
    // top 50 KANDIDAT, SEBELUM fetch data live (freq/order book) per kode di
    // deep analysis (dilakukan di handler, bukan di sini — lihat runMomentumSniperDeepAnalysis).
    // Floor value dipakai yang PALING RENDAH di antara 3 strategi (Rp500jt,
    // dipakai BPJP/BPJS) supaya kandidat BSJP (floor Rp1M) tidak keburu
    // terbuang di stage ini — floor Rp1M BSJP diterapkan lagi nanti saat
    // klasifikasi final per strategi.
    matched = allWithRatio
      .filter((r) =>
        r.priceChangePct > 1 &&
        r.price > r.open &&
        r.value >= 500_000_000
      )
      .sort((a, b) => b.value - a.value)
      .slice(0, 50);
  } else if (mode === "sektor") {
    // "Metode Sherly": volume ratio hari ini vs KEMARIN — dipulihkan (lihat
    // komentar MIN_VOLUME_RATIO di atas untuk kenapa value/freq tidak lagi
    // dipakai di sini).
    matched = (subsector ? allWithRatio.filter((r) => r.subsector === subsector) : allWithRatio)
      .filter((r) => r.volumeRatio !== null && r.volumeRatio >= MIN_VOLUME_RATIO && r.prevVolume >= MIN_PREV_VOLUME && r.price >= MIN_PRICE)
      .sort((a, b) => b.volumeRatio - a.volumeRatio);
  } else {
    // global — "metode Sherly" semula: volume ratio hari ini vs KEMARIN >=
    // MIN_VOLUME_RATIO, dengan lantai prevVolume (bukan cuma satu-dua lot
    // nyasar) dan lantai harga.
    matched = allWithRatio
      .filter((r) => r.volumeRatio !== null && r.volumeRatio >= MIN_VOLUME_RATIO && r.prevVolume >= MIN_PREV_VOLUME && r.price >= MIN_PRICE)
      .sort((a, b) => b.volumeRatio - a.volumeRatio);
  }

  // Rule "Frequency > 1" preset IF2X — freq TIDAK tersedia lagi dari Stage 1
  // per-kode (lihat komentar di atas rawResults) — filter ini DILEWATI
  // (bukan digagalkan) kalau freq null, supaya preset IF2X tidak selalu
  // kosong hasil hanya karena data freq tidak ada. Trade-off jujur: sedikit
  // lebih longgar dari preset aslinya sampai ada sumber freq lain.
  if (mode === "special_if2x") {
    matched = matched.filter((r) => r.freq == null || r.freq > 1);
  }

  // Batas keras (hardcode, berlaku di SEMUA mode termasuk "value" — sebagai
  // lantai minimum, bukan pengganti threshold yang User isi sendiri): saham
  // dengan nilai transaksi hari ini < 1 miliar dibuang. Dua alasan: (1) value
  // kecil = kemungkinan besar bukan pergerakan "big money", cuma noise beberapa
  // lot; (2) hasil scan tetap ringkas untuk diproses AI Insight/Bantuan AI
  // (dibatasi MAX_ROWS di api/ai-shortlist.js) — value kecil sering mendominasi
  // jumlah baris tanpa relevansi.
  // "momentum_sniper" PENGECUALIAN dari floor 1M ini — BPJP/BPJS punya floor
  // sendiri Rp500jt (lebih rendah), diterapkan di atas dan lagi saat
  // klasifikasi strategi final. Floor generik di sini akan salah membuang
  // kandidat BPJP/BPJS legitimate yang value-nya 500jt-1M.
  if (mode !== "momentum_sniper") {
    matched = matched.filter((r) => r.value >= MIN_VALUE_HARDCODE);
  }

  return { all: allWithRatio, matched, totalScanned: codes.length };
}

// Jendela operasi utama per strategi (WIB) — cuma REKOMENDASI/informasi di
// respons (dipakai UI buat kasih tahu "sedang di luar jam ideal"), BUKAN
// pemblokiran keras. Spek User: 08:00-10:00 (BPJP/BPJS), 15:00-16:00 (BSJP).
function getWibHourMinute() {
  const wib = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  return { hour: wib.getHours(), minute: wib.getMinutes() };
}

function inWindow(hour, minute, startH, endH) {
  const mins = hour * 60 + minute;
  return mins >= startH * 60 && mins <= endH * 60;
}

// 0-100, dinormalisasi dari rasio terhadap baseline masing-masing (BUKAN
// membandingkan angka mentah antar saham) — sesuai instruksi spek: "Normalize
// variables against their own baselines rather than comparing raw values."
function normalize(value, cap) {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / cap)) * 100;
}

function computeHumanSpeedScore({ frequencyRatio, ticketRatio, volumeRatio, priceChangePct, value, bidOfferRatioL1 }) {
  const freqScore = normalize(frequencyRatio, 3); // 3x baseline = skor penuh di komponen ini
  const ticketScore = normalize(ticketRatio, 2); // 2x baseline = skor penuh
  const volScore = normalize(volumeRatio, 3);
  const priceScore = normalize(priceChangePct, 5); // +5% = skor penuh
  const liqScore = value >= 1_000_000_000 ? 100 : value >= 500_000_000 ? 60 : 30;
  const orderScore = bidOfferRatioL1 != null ? normalize(bidOfferRatioL1 - 1, 1) : 0; // rasio 2.0x = skor penuh

  return Math.round(
    0.25 * freqScore + 0.2 * ticketScore + 0.15 * volScore + 0.15 * priceScore + 0.1 * liqScore + 0.15 * orderScore
  );
}

// Deep analysis Momentum Sniper — HANYA dipanggil untuk shortlist (top 50)
// hasil Stage 1 gate di runScan(), bukan universe penuh (lihat komentar di
// getIntradaySnapshot soal kenapa ini mahal per-kode). Mengembalikan top 15
// (atau lebih sedikit kalau yang lolos klasifikasi strategi kurang dari itu)
// diurutkan Human-Speed Score tertinggi.
async function runMomentumSniperDeepAnalysis(stage1Candidates, supabase) {
  if (stage1Candidates.length === 0) return [];

  const snapshots = await getIntradaySnapshotsBatch(stage1Candidates.map((r) => r.code));
  await saveFreqSnapshot(supabase, snapshots);
  const baselines = await getFreqBaselines(supabase, stage1Candidates.map((r) => r.code));

  // FALLBACK cold-start — kalau histori freq_baseline belum ada sama sekali
  // (baru pertama kali mode ini dijalankan, atau kode yang belum pernah lolos
  // Stage 1 sebelumnya), frequencyRatio jadi PERMANEN null dan strategi TIDAK
  // PERNAH bisa lolos ("hasBaseline" selalu false) — ini bug nyata yang
  // dilaporkan User: "Susah dapat kandidat" (selalu 0, bukan cuma jarang).
  // Sambil histori historis terkumpul, dipakai baseline SEMENTARA dari rata-
  // rata (median) freq/ticket_size ANTAR KANDIDAT hari ini sendiri (cross-
  // sectional) — bukan mengarang angka, tapi memakai kandidat lain sebagai
  // pembanding relatif sampai baseline historis per-kode tersedia. Ditandai
  // eksplisit (baselineSource) supaya User tahu ini estimasi sementara, bukan
  // baseline "asli" berbasis histori kode itu sendiri.
  const validSnaps = snapshots.filter(Boolean);
  const freqValues = validSnaps.map((s) => s.freq).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const ticketValues = validSnaps.map((s) => s.ticketSize).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const median = (arr) => (arr.length === 0 ? null : arr[Math.floor(arr.length / 2)]);
  const crossSectionalFreqBaseline = median(freqValues);
  const crossSectionalTicketBaseline = median(ticketValues);

  const { hour, minute } = getWibHourMinute();
  const morningWindow = inWindow(hour, minute, 8, 10);
  const afternoonWindow = inWindow(hour, minute, 15, 16);

  const enriched = stage1Candidates
    .map((r, i) => {
      const snap = snapshots[i];
      if (!snap) return null; // gagal ambil data live — skip, jangan gagalkan seluruh scan

      const baseline = baselines[r.code] || { freqAnalyzer: null, baselineTicket: null, sampleDays: 0 };
      // Baseline historis (dari histori kode itu sendiri) diprioritaskan kalau
      // ada — cross-sectional cuma fallback saat histori belum terkumpul.
      const freqAnalyzer = baseline.freqAnalyzer ?? crossSectionalFreqBaseline;
      const baselineTicket = baseline.baselineTicket ?? crossSectionalTicketBaseline;
      const baselineSource = baseline.freqAnalyzer ? "historis" : freqAnalyzer ? "sementara (antar-kandidat hari ini)" : null;
      const frequencyRatio = freqAnalyzer ? snap.freq / freqAnalyzer : null;
      const ticketRatio = baselineTicket && snap.ticketSize ? snap.ticketSize / baselineTicket : null;

      // Klasifikasi strategi — formula PERSIS dari spek User, kecuali syarat
      // sum_bid_volume(5)/sum_offer_volume(5) (kedalaman order book 5 level)
      // yang DIGANTI level 1 saja (lihat catatan di getIntradaySnapshot) —
      // ambang batasnya sedikit dinaikkan (x1.2 makin dipertegas jadi syarat
      // sendiri) supaya level-1 tetap jadi sinyal yang cukup ketat meski lebih
      // sempit dari level-5 aslinya.
      const strategies = [];
      const hasBaseline = frequencyRatio !== null;
      if (
        hasBaseline &&
        r.priceChangePct > 1 &&
        r.price > r.open &&
        frequencyRatio > 3 &&
        snap.volume != null && snap.freq > 0 && snap.volume / snap.freq > 500 && // "Share Ticket": volume > freq*500
        snap.value > 500_000_000 &&
        snap.bidOfferRatioL1 !== null && snap.bidOfferRatioL1 > 1.2
      ) {
        strategies.push("BPJP");
      }
      if (
        hasBaseline &&
        r.priceChangePct > 1 &&
        r.price > r.open &&
        frequencyRatio > 2 &&
        snap.volume != null && snap.freq > 0 && snap.volume / snap.freq > 500 &&
        snap.value != null && snap.value > 500_000_000 &&
        snap.bidOfferRatioL1 !== null && snap.bidOfferRatioL1 > 1
      ) {
        strategies.push("BPJS");
      }
      if (
        hasBaseline &&
        r.priceChangePct > 1 &&
        r.price > r.open &&
        frequencyRatio > 2 &&
        snap.volume != null && snap.freq > 0 && snap.volume / snap.freq > 500 &&
        snap.value != null && snap.value > 1_000_000_000 &&
        snap.bidOfferRatioL1 !== null && snap.bidOfferRatioL1 > 1
      ) {
        strategies.push("BSJP");
      }

      const closeLocation = r.high > r.low ? (r.price - r.low) / (r.high - r.low) : null;

      return {
        code: r.code,
        price: r.price,
        priceChangePct: r.priceChangePct,
        value: snap.value,
        volume: snap.volume,
        freq: snap.freq,
        freqAnalyzer,
        frequencyRatio,
        ticketSize: snap.ticketSize,
        ticketRatio,
        volumeRatio: r.volumeRatio,
        bidLot: snap.bidLot,
        offerLot: snap.offerLot,
        bidOfferRatioL1: snap.bidOfferRatioL1,
        closeLocation,
        baselineSampleDays: baseline.sampleDays,
        baselineSource,
        strategies,
        recommendedWindow: {
          morningActive: morningWindow,
          afternoonActive: afternoonWindow,
        },
        humanSpeedScore: computeHumanSpeedScore({
          frequencyRatio,
          ticketRatio,
          volumeRatio: r.volumeRatio,
          priceChangePct: r.priceChangePct,
          value: snap.value,
          bidOfferRatioL1: snap.bidOfferRatioL1,
        }),
      };
    })
    .filter(Boolean)
    .filter((r) => r.strategies.length > 0)
    .sort((a, b) => b.humanSpeedScore - a.humanSpeedScore)
    .slice(0, 15);

  return enriched;
}

async function saveToSupabase({ all, matched, totalScanned, durationMs, scannedAtIso, criteria, userId }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { saved: false, reason: "Supabase belum dikonfigurasi (env var kosong)." };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const matchedCodes = new Set(matched.map((r) => r.code));

  // 1. Insert satu baris scan_runs, ambil ID-nya untuk foreign key di scan_results.
  //    Kriteria (mode/sector/subsector/minValue/minRatio) disimpan supaya scan
  //    berikutnya dengan kriteria SAMA bisa ketemu run ini lewat findCachedRun().
  const { data: runRow, error: runError } = await supabase
    .from("scan_runs")
    .insert({
      scanned_at: scannedAtIso,
      duration_ms: durationMs,
      total_scanned: totalScanned,
      total_passed_filter: matched.length,
      min_volume_ratio: MIN_VOLUME_RATIO,
      min_prev_volume: MIN_PREV_VOLUME,
      min_value_activity: MIN_VALUE_ACTIVITY,
      min_freq: MIN_FREQ,
      min_price: MIN_PRICE,
      user_id: userId || null,
      mode: criteria.mode,
      sector: criteria.sector || null,
      subsector: criteria.subsector || null,
      min_value: criteria.minValue != null ? Number(criteria.minValue) : null,
      min_ratio: criteria.minRatio != null ? Number(criteria.minRatio) : null,
    })
    .select("id")
    .single();

  if (runError) {
    return { saved: false, reason: `Gagal insert scan_runs: ${runError.message}` };
  }

  // 2. Insert SEMUA saham yang berhasil di-scan (bukan hanya yang cocok kriteria
  //    yang dipilih), dalam batch supaya tidak mengirim satu payload raksasa sekaligus
  const rows = all.map((r) => ({
    run_id: runRow.id,
    code: r.code,
    volume: r.volume,
    prev_volume: r.prevVolume,
    volume_ratio: r.volumeRatio,
    price: r.price,
    prev_price: r.prevPrice,
    price_change_pct: r.priceChangePct,
    passed_filter: matchedCodes.has(r.code),
    sector: r.sector,
    subsector: r.subsector || null, // hanya terisi untuk mode "sektor"
    value: r.value,
    freq: r.freq ?? null,
    avg_volume_3d: r.avgVolume3d,
    avg_volume_20d: r.avgVolume20d,
    vol_ratio_3v20: r.volRatio3v20,
    price_change_3d: r.priceChange3d,
    quiet_accumulation: r.quietAccumulation,
    sudah_naik_tajam: r.sudahNaikTajam,
  }));

  const INSERT_BATCH_SIZE = 200;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const { error: resultsError } = await supabase.from("scan_results").insert(batch);
    if (resultsError) {
      return {
        saved: false,
        reason: `scan_runs tersimpan tapi scan_results gagal di batch ${i}: ${resultsError.message}`,
      };
    }
  }

  return { saved: true, runId: runRow.id };
}

export const config = {
  maxDuration: 120, // detik — scan 900 saham dengan pool concurrency 20 biasanya jauh di bawah ini
};

export default async function handler(req, res) {
  const mode = req.query?.mode || "global";

  const authHeader = req.headers.authorization || "";
  const isCronBsjp = !!CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}` && mode === "momentum_sniper";
  const isCronAraHunter = !!CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}` && mode === "ara_hunter";

  let user = null;
  if (!isCronBsjp && !isCronAraHunter) {
    user = await requireUser(req, res);
    if (!user) return;
  }

  if (!API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }

  await loadSettingsOverrides();

  // Kill-switch global — berlaku untuk SEMUA pemanggil (manual klik ATAU
  // cron), beda dari toggle scheduler di bawah yang cuma untuk cron.
  if (INVEZGO_PAUSED) {
    res.status(503).json({ error: "Invezgo API sedang di-pause dari Admin panel." });
    return;
  }

  // Toggle scheduler — HANYA berlaku untuk trigger cron (cron secret), bukan
  // klik manual admin/user biasa lewat tab Run Scan. Skip di sini, SEBELUM
  // scan sungguhan jalan — 0 request ke Invezgo kalau dinonaktifkan.
  if (isCronAraHunter && !ARA_HUNTER_CRON_ENABLED) {
    res.status(200).json({ skipped: true, reason: "Jadwal ARA Hunter sedang dinonaktifkan lewat tab Run Scan." });
    return;
  }
  if (isCronBsjp && !MOMENTUM_SNIPER_CRON_ENABLED) {
    res.status(200).json({ skipped: true, reason: "Jadwal Momentum Sniper sedang dinonaktifkan lewat tab Run Scan." });
    return;
  }

  const VALID_MODES = new Set(["global", "sektor", "value", "volume_spike", "special_if2x", "momentum_sniper", "ara_hunter"]);
  if (!VALID_MODES.has(mode)) {
    res.status(400).json({ error: `mode '${mode}' tidak valid. Pilihan: ${[...VALID_MODES].join(", ")}.` });
    return;
  }
  if (mode === "sektor" && !req.query?.sector) {
    res.status(400).json({ error: "Mode 'sektor' butuh parameter 'sector'." });
    return;
  }

  const criteria = {
    mode,
    sector: req.query?.sector || null,
    subsector: req.query?.subsector || null,
    minValue: req.query?.minValue || null,
    minRatio: req.query?.minRatio || null,
  };

  const startedAt = Date.now();
  const scannedAtIso = new Date(startedAt).toISOString();

  try {
    // Cek cache DULU — kalau ada scan lain dengan kriteria persis sama dalam
    // CACHE_TTL_MENIT terakhir (misal teman lain baru scan barusan), pakai
    // hasil itu, JANGAN panggil Invezgo lagi. Ini yang mencegah beberapa user
    // bersamaan "bentrok" kena rate-limit Invezgo secara bersamaan.
    // special_if2x TIDAK pakai cache — field "freq"-nya tidak ikut disimpan ke
    // scan_results (lihat saveToSupabase), jadi cache-hit akan kehilangan freq.
    // Ini mode "special/manual" yang dijalankan sesekali, bukan scan rutin
    // banyak user, jadi selalu fresh tidak masalah dari sisi biaya API.
    // "momentum_sniper" juga TIDAK pakai cache — datanya live (freq/order book
    // detik-ke-detik), sengaja selalu fresh tiap dijalankan (spek: "on-demand,
    // not continuously polling").
    const supabaseForCache =
      mode === "special_if2x" || mode === "momentum_sniper" || mode === "ara_hunter" ? null : getSupabaseAdmin();
    if (supabaseForCache) {
      const cached = await findCachedRun(supabaseForCache, criteria);
      if (cached) {
        // Sama seperti scan fresh — kalau cache-hit ternyata 0 hasil, tarik
        // SEMUA baris run itu (bukan cuma yang lolos) untuk diagnostik,
        // supaya "0 cocok kriteria dari cache" juga bisa diverifikasi, bukan
        // cuma tampilan kosong tanpa penjelasan.
        let debugStats = null;
        if (cached.rows.length === 0 && (mode === "global" || mode === "sektor" || mode === "value")) {
          const { data: allRows, error: debugError } = await supabaseForCache
            .from("scan_results")
            .select("code, value, freq, price")
            .eq("run_id", cached.scanRun.id);
          // JANGAN diam-diam anggap 0 baris kalau query-nya sendiri ERROR
          // (misal kolom "freq" belum ada di skema live — migrasi
          // supabase/schema.sql belum dijalankan ulang) — itu beda kasus
          // total dari "memang tidak ada saham yang lolos", dan sebelumnya
          // dua kasus ini kelihatan SAMA PERSIS di UI (diagnostik jadi
          // menyesatkan, seperti yang User temukan).
          if (debugError) {
            debugStats = {
              queryFailed: true,
              queryError: debugError.message,
              hint: "Query diagnostik gagal — kemungkinan besar skema Supabase belum sinkron (kolom baru dari migrasi terakhir belum ada). Jalankan ulang supabase/schema.sql.",
            };
            res.setHeader("Cache-Control", "no-store");
            res.status(200).json({
              mode,
              criteria,
              data: cached.rows.map(rowFromDb),
              totalScanned: cached.scanRun.total_scanned,
              scannedAt: new Date(cached.scanRun.scanned_at).getTime(),
              durationMs: cached.scanRun.duration_ms,
              saved: true,
              cached: true,
              cacheAgeSec: Math.round((Date.now() - new Date(cached.scanRun.scanned_at).getTime()) / 1000),
              debug: debugStats,
            });
            return;
          }
          const rows = allRows || [];
          const top5ByValue = [...rows]
            .sort((a, b) => (b.value || 0) - (a.value || 0))
            .slice(0, 5)
            .map((r) => ({ code: r.code, value: r.value, freq: r.freq, price: r.price }));
          debugStats = {
            totalRowsWithData: rows.length,
            passedPriceFloor: rows.filter((r) => r.price >= MIN_PRICE).length,
            passedValueFloor: rows.filter((r) => r.value >= MIN_VALUE_ACTIVITY).length,
            passedFreqFloor: rows.filter((r) => r.freq >= MIN_FREQ).length,
            currentThresholds: { minValueActivity: MIN_VALUE_ACTIVITY, minFreq: MIN_FREQ, minPrice: MIN_PRICE },
            top5ByValue,
          };
        }
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json({
          mode,
          criteria,
          data: cached.rows.map(rowFromDb),
          totalScanned: cached.scanRun.total_scanned,
          scannedAt: new Date(cached.scanRun.scanned_at).getTime(),
          durationMs: cached.scanRun.duration_ms,
          saved: true,
          cached: true,
          cacheAgeSec: Math.round((Date.now() - new Date(cached.scanRun.scanned_at).getTime()) / 1000),
          debug: debugStats,
        });
        return;
      }
    }

    // "Max 3x scan Global per user per 24 jam" (User) — HANYA cache-miss yang
    // benar-benar akan hit Invezgo sampai di sini; cache-hit di atas sudah
    // return duluan dan tidak menelan kuota, jadi tidak perlu dihitung.
    if (mode === "global" && user) {
      const { blocked, count } = await checkGlobalScanLimit(getSupabaseAdmin(), user.id);
      if (blocked) {
        res.status(429).json({
          error: `Batas scan Global tercapai (maks ${GLOBAL_SCAN_DAILY_LIMIT}x per 24 jam per user, sudah dipakai ${count}x). Coba mode Sektor/Value yang lebih hemat kuota, atau tunggu beberapa jam.`,
        });
        return;
      }
    }

    const { all, matched: stage1Matched, totalScanned } =
      mode === "ara_hunter"
        ? await runAraHunterScan()
        : await runScan({
            mode,
            sector: req.query?.sector,
            subsector: req.query?.subsector,
            minValue: req.query?.minValue,
            minRatio: req.query?.minRatio,
          });

    // Momentum Sniper: stage1Matched di atas baru top-50 KANDIDAT (stage 1 —
    // liquidity gate murah, EOD). Deep analysis (freq/order book live, per
    // kandidat) dijalankan di sini, HASIL AKHIRNYA (top 5-15 yang lolos
    // klasifikasi BPJP/BPJS/BSJP) yang jadi `matched` final — bukan top-50
    // mentah — supaya scan_results/history juga konsisten dengan apa yang
    // ditampilkan ke User.
    const matched =
      mode === "momentum_sniper"
        ? await runMomentumSniperDeepAnalysis(stage1Matched, getSupabaseAdmin())
        : stage1Matched;

    const durationMs = Date.now() - startedAt;

    // Diagnostik — HANYA dibangun kalau 0 saham lolos filter di mode yang
    // pakai MIN_VALUE_ACTIVITY/MIN_FREQ/MIN_PRICE (global/sektor/value).
    // Tanpa ini, "0 cocok kriteria" tidak bisa dibedakan dari "data batch
    // gagal total" vs "threshold memang ketat" — User sempat laporkan hasil
    // 0 yang mencurigakan tanpa cara memverifikasi dari UI sama sekali.
    let debugStats = null;
    if (matched.length === 0 && (mode === "global" || mode === "sektor" || mode === "value")) {
      const top5ByValue = [...all]
        .sort((a, b) => (b.value || 0) - (a.value || 0))
        .slice(0, 5)
        .map((r) => ({ code: r.code, value: r.value, volumeRatio: r.volumeRatio, price: r.price }));
      debugStats = {
        totalRowsWithData: all.length,
        passedPriceFloor: all.filter((r) => r.price >= MIN_PRICE).length,
        passedVolumeRatioFloor: all.filter((r) => r.volumeRatio !== null && r.volumeRatio >= MIN_VOLUME_RATIO).length,
        passedPrevVolumeFloor: all.filter((r) => r.prevVolume >= MIN_PREV_VOLUME).length,
        currentThresholds: { minVolumeRatio: MIN_VOLUME_RATIO, minPrevVolume: MIN_PREV_VOLUME, minPrice: MIN_PRICE },
        top5ByValue,
        hint:
          all.length === 0 && totalScanned > 0
            ? "Fetch per-kode ke Invezgo (/analysis/chart/stock) tidak menghasilkan baris apa pun untuk seluruh universe yang di-scan — kemungkinan besar error di sisi Invezgo (rate limit/role/paket), bukan threshold terlalu ketat. Coba lagi beberapa saat lagi."
            : all.length > 0 && matched.length === 0
              ? "Data berhasil diambil, tapi tidak ada saham yang lolos volume ratio hari ini vs kemarin — threshold memang cukup ketat untuk kondisi pasar saat ini."
              : undefined,
      };
    }

    // Simpan ke Supabase — kalau gagal, tetap kembalikan hasil scan ke browser
    // (jangan gagalkan scan yang sudah berhasil hanya karena penyimpanan histori gagal)
    const saveResult = await saveToSupabase({
      all,
      matched,
      totalScanned,
      durationMs,
      scannedAtIso,
      criteria,
      userId: user?.id || null,
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      mode,
      // Echo kriteria yang BENAR-BENAR dipakai server — supaya kalau ada
      // kejanggalan (misal totalScanned kelihatan seperti scan global padahal
      // User pilih mode sektor), langsung ketahuan dari respons ini apa yang
      // sebenarnya diproses, bukan tebak-tebakan dari UI semata.
      criteria,
      data: matched,
      totalScanned,
      scannedAt: startedAt,
      durationMs,
      saved: saveResult.saved,
      cached: false,
      saveError: saveResult.saved ? undefined : saveResult.reason,
      debug: debugStats,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
