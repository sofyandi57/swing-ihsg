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

function average(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// lookbackDays: 10 hari cukup untuk metrik 2-hari (dipakai mode global/sektor/
// value). HANYA mode "volume_spike" butuh ~40 hari kalender (>=23 hari
// PERDAGANGAN) untuk rata-rata volume 3-vs-20-hari — meminta 40 hari untuk
// SEMUA mode (versi sebelumnya) membuat payload per saham 4x lebih besar dan
// scan jadi jauh lebih lambat (bahkan untuk mode yang tidak butuh data itu
// sama sekali) — ini penyebab scan terasa sangat lambat di semua mode.
async function getDailyMetrics(code, lookbackDays = 10) {
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

  const rows = [...chart].sort((a, b) => new Date(a.date) - new Date(b.date));
  const today = rows[rows.length - 1];
  const prev = rows[rows.length - 2];

  const volume = Number(today.volume); // volume dari Invezgo adalah string, wajib di-cast
  const prevVolume = Number(prev.volume);
  const price = Number(today.close);
  const prevPrice = Number(prev.close);

  if (!prevVolume || !Number.isFinite(volume) || !Number.isFinite(prevVolume)) return null;

  // Kriteria "akumulasi diam-diam" — butuh minimal 23 hari perdagangan
  // (3 hari terakhir + 20 hari sebelum itu). Kalau data kurang (saham baru
  // IPO, suspend lama, dll), field ini null — tidak menggagalkan baris.
  let avgVolume3d = null;
  let avgVolume20d = null;
  let volRatio3v20 = null;
  let priceChange3d = null;

  if (rows.length >= 23) {
    const last3 = rows.slice(-3);
    const prior20 = rows.slice(-23, -3);
    avgVolume3d = average(last3.map((r) => Number(r.volume)));
    avgVolume20d = average(prior20.map((r) => Number(r.volume)));
    volRatio3v20 = avgVolume20d > 0 ? avgVolume3d / avgVolume20d : null;
    const closeStart3d = Number(rows[rows.length - 3].close);
    priceChange3d = closeStart3d > 0 ? ((price - closeStart3d) / closeStart3d) * 100 : null;
  }

  return {
    code,
    volume,
    prevVolume,
    price,
    prevPrice,
    avgVolume3d,
    avgVolume20d,
    volRatio3v20,
    priceChange3d,
  };
}

// Empat mode kriteria — dipilih User SEBELUM scan (bukan filter sesudahnya):
//   global       — semua saham yang berhasil di-scan, tanpa kriteria tambahan
//   sektor       — hanya saham di sektor (dan opsional subsektor) yang dipilih;
//                  codes DIPERSEMPIT sebelum fetch chart, jadi scan-nya lebih
//                  cepat (bukan cuma filter tampilan)
//   value        — value (price x volume) hari ini >= minValue
//   volume_spike — rata-rata volume 3 hari terakhir >= minRatio x rata-rata
//                  volume 20 hari sebelumnya (butuh >=23 hari data — lihat
//                  getDailyMetrics)
async function runScan({ mode, sector, subsector, minValue, minRatio }) {
  const stockList = await invezgoGet("/analysis/list/stock");
  const sectorByCode = new Map(stockList.map((s) => [s.code, s.sector || null]));

  let codes = stockList.map((s) => s.code);
  if (mode === "sektor" && sector) {
    codes = stockList.filter((s) => s.sector === sector).map((s) => s.code);
  }

  const lookbackDays = mode === "volume_spike" ? 40 : 10;
  const pooledResults = await runPool(codes, CONCURRENCY, (code) => getDailyMetrics(code, lookbackDays));
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
    return {
      ...r,
      volumeRatio,
      priceChangePct,
      quietAccumulation,
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

  let matched;
  if (mode === "value") {
    const threshold = Number(minValue) || 0;
    matched = allWithRatio.filter((r) => r.value >= threshold).sort((a, b) => b.value - a.value);
  } else if (mode === "volume_spike") {
    const threshold = Number(minRatio) || 1;
    matched = allWithRatio
      .filter((r) => r.volRatio3v20 !== null && r.volRatio3v20 >= threshold)
      .sort((a, b) => b.volRatio3v20 - a.volRatio3v20);
  } else if (mode === "sektor") {
    matched = (subsector ? allWithRatio.filter((r) => r.subsector === subsector) : allWithRatio).sort(
      (a, b) => b.volumeRatio - a.volumeRatio
    );
  } else {
    // global — tanpa kriteria tambahan
    matched = [...allWithRatio].sort((a, b) => b.volumeRatio - a.volumeRatio);
  }

  // Batas keras (hardcode, berlaku di SEMUA mode termasuk "value" — sebagai
  // lantai minimum, bukan pengganti threshold yang User isi sendiri): saham
  // dengan nilai transaksi hari ini < 1 miliar dibuang. Dua alasan: (1) value
  // kecil = kemungkinan besar bukan pergerakan "big money", cuma noise beberapa
  // lot; (2) hasil scan tetap ringkas untuk diproses AI Insight/Bantuan AI
  // (dibatasi MAX_ROWS di api/ai-shortlist.js) — value kecil sering mendominasi
  // jumlah baris tanpa relevansi.
  matched = matched.filter((r) => r.value >= MIN_VALUE_HARDCODE);

  return { all: allWithRatio, matched, totalScanned: codes.length };
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
  const user = await requireUser(req, res);
  if (!user) return;

  if (!API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }

  await loadSettingsOverrides();

  const mode = req.query?.mode || "global";
  const VALID_MODES = new Set(["global", "sektor", "value", "volume_spike"]);
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
    const supabaseForCache = getSupabaseAdmin();
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

    const { all, matched, totalScanned } = await runScan({
      mode,
      sector: req.query?.sector,
      subsector: req.query?.subsector,
      minValue: req.query?.minValue,
      minRatio: req.query?.minRatio,
    });
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
