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
let MIN_VOLUME_RATIO = 3.0;
let MIN_PREV_VOLUME = 1_000_000;
let MIN_PRICE = 50;
let TOP_N = 25;
let CONCURRENCY = 30; // jumlah slot paralel yang SELALU terisi (lihat runPool)

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
    volumeRatio: Number(r.volume_ratio),
    price: r.price,
    prevPrice: r.prev_price,
    priceChangePct: Number(r.price_change_pct),
    sector: r.sector,
    subsector: r.subsector,
    value: Number(r.value),
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
      if (row.key === "min_price") MIN_PRICE = Number(row.value);
      if (row.key === "top_n") TOP_N = Number(row.value);
      if (row.key === "concurrency") CONCURRENCY = Number(row.value);
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

  if (resp.status === 401) throw new Error("401: API key tidak valid.");
  if (resp.status === 402) throw new Error("402: Paket subscription tidak cukup / API key expired.");
  if (resp.status === 429) throw new Error("429: Rate limit tercapai.");
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

// Frekuensi transaksi (jumlah kali transaksi terjadi hari ini) HANYA tersedia
// di endpoint intraday-data, TIDAK ada di /analysis/chart/stock/ yang dipakai
// getDailyMetrics — jadi mode "special_if2x" (butuh syarat Frequency > 1) perlu
// panggilan Invezgo TAMBAHAN. Untuk menjaga biaya API tetap rendah (pelajaran
// dari sesi sebelumnya), ini HANYA dipanggil untuk saham yang SUDAH lolos
// semua filter murah lainnya (harga, volume, value) — bukan untuk semua ~900
// saham di universe.
async function getFrequency(code) {
  try {
    const d = await invezgoGet(`/analysis/intraday-data/${code}`);
    return Number(d?.freq) || 0;
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
async function getIntradaySnapshotsBatch(codes) {
  const dataByCode = new Map();
  const bookByCode = new Map();

  for (const group of chunkArray(codes, BATCH_SIZE)) {
    try {
      const results = await invezgoGet(`/batch/intraday-data/${group.join("|")}`, { market: "RG" });
      if (Array.isArray(results)) for (const r of results) dataByCode.set(r.code, r);
    } catch (e) {
      // skip chunk ini, lanjut chunk berikutnya
    }
  }
  for (const group of chunkArray(codes, BATCH_SIZE)) {
    try {
      const results = await invezgoGet(`/batch/order-book/${group.join("|")}`, { market: "RG" });
      if (Array.isArray(results)) for (const r of results) bookByCode.set(r.code, r);
    } catch (e) {
      // skip chunk ini, lanjut chunk berikutnya
    }
  }

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

// Fetch mentah + retry 429 — dipisah dari perhitungan supaya bisa dipakai
// ULANG untuk fetch "murah" (10 hari) MAUPUN fetch "mahal" (40 hari) tanpa
// duplikasi logic retry. Lihat getDailyMetrics/getExtendedMetrics di bawah
// untuk kenapa dipisah dua tahap begini (multistage filter, hemat kuota).
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

// lookbackDays: 10 hari cukup untuk metrik 2-hari (dipakai SEMUA mode di
// STAGE 1 — global/sektor/value/momentum_sniper langsung, volume_spike/
// special_if2x pakai ini dulu SEBELUM fetch tambahan 40-hari). Payload 10
// hari jauh lebih kecil/cepat daripada 40 hari — inilah yang bikin scan
// murah untuk ~900 saham sekaligus.
async function getDailyMetrics(code, lookbackDays = 10) {
  const rows = await fetchChartRows(code, lookbackDays);
  if (!rows) return null;

  const today = rows[rows.length - 1];
  const prev = rows[rows.length - 2];

  const volume = Number(today.volume); // volume dari Invezgo adalah string, wajib di-cast
  const prevVolume = Number(prev.volume);
  const price = Number(today.close);
  const prevPrice = Number(prev.close);
  const open = Number(today.open); // dipakai mode "momentum_sniper" (syarat candle hijau: close > open)
  const low = Number(today.low);
  const high = Number(today.high);

  if (!prevVolume || !Number.isFinite(volume) || !Number.isFinite(prevVolume)) return null;

  return {
    code,
    volume,
    prevVolume,
    price,
    prevPrice,
    open,
    low,
    high,
    avgVolume3d: null,
    avgVolume20d: null,
    volRatio3v20: null,
    priceChange3d: null,
  };
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
//   global       — volume ratio >= MIN_VOLUME_RATIO (default 3x, Admin panel),
//                  prevVolume >= MIN_PREV_VOLUME, price >= MIN_PRICE — floor
//                  yang sama dipakai sejak awal project, supaya rasio yang
//                  tampil memang "berkali lipat" (bukan cuma naik sedikit dari
//                  base volume yang kecil banget)
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

  // STAGE 1 — SEMUA mode, SELALU 10 hari (murah), untuk SELURUH universe.
  // Sebelumnya volume_spike/special_if2x langsung minta 40 hari untuk ~900
  // saham sekaligus (payload 4x lebih besar per saham, terlepas hampir semua
  // di antaranya bakal gagal filter likuiditas dasar). Sekarang data 40-hari
  // (Stage 2, lihat di bawah) HANYA diminta untuk saham yang sudah lolos
  // saringan likuiditas murah dari Stage 1 — multistage filter, sama
  // prinsipnya dengan mode "momentum_sniper" dan "special_if2x"-nya freq.
  const pooledResults = await runPool(codes, CONCURRENCY, (code) => getDailyMetrics(code, 10));
  const rawResults = pooledResults.filter(Boolean);

  // sector diambil dari daftar saham (gratis, sudah di memori) — value = estimasi
  // nilai transaksi hari ini (price x volume).
  const allWithRatio = rawResults.map((r) => {
    const volumeRatio = r.volume / r.prevVolume;
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
    // volumeChangePct — dipakai preset IF2X sebagai floor "> -100%" (volume
    // tidak anjlok sampai nol). Selalu true kecuali volume hari ini benar-benar
    // 0, jadi dampaknya kecil, tapi tetap diterapkan persis sesuai preset asli.
    const volumeChangePct = ((r.volume - r.prevVolume) / r.prevVolume) * 100;
    return {
      ...r,
      volumeRatio,
      priceChangePct,
      volumeVsMA20,
      volumeChangePct,
      quietAccumulation,
      sudahNaikTajam,
      sector: sectorByCode.get(r.code) || null,
      value: r.price * r.volume,
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
    matched = allWithRatio
      .filter((r) =>
        r.priceChangePct >= -10 &&
        r.volumeChangePct > -100 &&
        r.volumeVsMA20 !== null && r.volumeVsMA20 >= 2 &&
        r.volume >= 5_000_000 &&
        r.value > 3_000_000_000 &&
        r.prevVolume > 0
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
    matched = (subsector ? allWithRatio.filter((r) => r.subsector === subsector) : allWithRatio)
      .filter((r) => r.volumeRatio >= MIN_VOLUME_RATIO && r.prevVolume >= MIN_PREV_VOLUME && r.price >= MIN_PRICE)
      .sort((a, b) => b.volumeRatio - a.volumeRatio);
  } else {
    // global — TETAP butuh volume ratio minimum (default 3x, bisa diubah di
    // Admin panel) dan volume dasar (prevVolume) minimum, supaya tidak ada
    // "rasio menipu" dari saham yang base volume-nya kecil banget (misal dari
    // 100 lembar ke 5.000 lembar = rasio 50x tapi tidak berarti apa-apa).
    // Ini persis langkah 3 di metode Sherly: "pilih yang volume jauh/berkali
    // lipat dari prev volume" — bukan cuma "lebih tinggi sedikit".
    matched = allWithRatio
      .filter((r) => r.volumeRatio >= MIN_VOLUME_RATIO && r.prevVolume >= MIN_PREV_VOLUME && r.price >= MIN_PRICE)
      .sort((a, b) => b.volumeRatio - a.volumeRatio);
  }

  // Lengkapi rule "Frequency > 1" preset IF2X — HANYA untuk shortlist yang
  // sudah lolos filter murah di atas (biasanya puluhan saham, bukan ~900),
  // sama prinsipnya dengan getSubsector() di mode "sektor".
  if (mode === "special_if2x" && matched.length > 0) {
    const freqBatch = await Promise.all(matched.map((r) => getFrequency(r.code)));
    matched.forEach((r, i) => {
      r.freq = freqBatch[i];
    });
    matched = matched.filter((r) => r.freq !== null && r.freq > 1);
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

async function saveToSupabase({ all, matched, totalScanned, durationMs, scannedAtIso, criteria }) {
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
      min_price: MIN_PRICE,
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

  if (!isCronBsjp) {
    const user = await requireUser(req, res);
    if (!user) return;
  }

  if (!API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }

  await loadSettingsOverrides();

  const VALID_MODES = new Set(["global", "sektor", "value", "volume_spike", "special_if2x", "momentum_sniper"]);
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
    const supabaseForCache = mode === "special_if2x" || mode === "momentum_sniper" ? null : getSupabaseAdmin();
    if (supabaseForCache) {
      const cached = await findCachedRun(supabaseForCache, criteria);
      if (cached) {
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
        });
        return;
      }
    }

    const { all, matched: stage1Matched, totalScanned } = await runScan({
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

    // Simpan ke Supabase — kalau gagal, tetap kembalikan hasil scan ke browser
    // (jangan gagalkan scan yang sudah berhasil hanya karena penyimpanan histori gagal)
    const saveResult = await saveToSupabase({
      all,
      matched,
      totalScanned,
      durationMs,
      scannedAtIso,
      criteria,
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
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
