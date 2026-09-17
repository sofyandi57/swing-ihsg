// api/screener.js
// Vercel Serverless Function — proxy ke Invezgo API, dijalankan HANYA saat browser
// memanggilnya (lewat tombol "Run Scan" di frontend). Tidak ada cache, tidak ada
// auto-polling — setiap panggilan = satu scan penuh ke ~900 saham.
//
// Setelah scan selesai, SEMUA hasil (bukan hanya yang lolos filter) disimpan ke
// Supabase sebagai histori: satu baris di scan_runs (metadata run), dan satu baris
// per saham di scan_results (ditandai passed_filter true/false).
//
// Durasi: dengan Fluid Compute (default Vercel sekarang), Hobby plan punya default
// maxDuration 300 detik — cukup untuk scan 900 saham dengan concurrency terbatas.
// Tetap diset eksplisit di vercel.json untuk jaga-jaga.

import { createClient } from "@supabase/supabase-js";

const INVEZGO_BASE_URL = "https://api.invezgo.com";
const API_KEY = process.env.INVEZGO_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIN_VOLUME_RATIO = 3.0;
const MIN_PREV_VOLUME = 1_000_000;
const MIN_PRICE = 50;
const TOP_N = 25;
const CONCURRENCY = 10; // request paralel ke Invezgo per batch — jangan terlalu tinggi

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

async function getLastTwoDays(code) {
  const to = new Date();
  const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000); // buffer 10 hari

  let chart;
  try {
    chart = await invezgoGet(`/analysis/chart/stock/${code}`, {
      from: ymd(from),
      to: ymd(to),
    });
  } catch (e) {
    return null; // kode tidak valid / data kosong / error sementara — skip, jangan gagalkan seluruh scan
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

  return { code, volume, prevVolume, price, prevPrice };
}

async function runFullScan() {
  const stockList = await invezgoGet("/analysis/list/stock");
  const codes = stockList.map((s) => s.code);

  const rawResults = [];
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(getLastTwoDays));
    rawResults.push(...batchResults.filter(Boolean));
  }

  // Hitung rasio & tandai lolos filter atau tidak — INI SEMUA SAHAM, belum di-slice
  const allWithRatio = rawResults.map((r) => {
    const volumeRatio = r.volume / r.prevVolume;
    const priceChangePct = ((r.price - r.prevPrice) / r.prevPrice) * 100;
    const passedFilter =
      volumeRatio >= MIN_VOLUME_RATIO &&
      r.prevVolume >= MIN_PREV_VOLUME &&
      r.price >= MIN_PRICE;
    return { ...r, volumeRatio, priceChangePct, passedFilter };
  });

  const filtered = allWithRatio
    .filter((r) => r.passedFilter)
    .sort((a, b) => b.volumeRatio - a.volumeRatio)
    .slice(0, TOP_N);

  return { all: allWithRatio, filtered, totalScanned: codes.length };
}

async function saveToSupabase({ all, filtered, totalScanned, durationMs, scannedAtIso }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { saved: false, reason: "Supabase belum dikonfigurasi (env var kosong)." };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Insert satu baris scan_runs, ambil ID-nya untuk foreign key di scan_results
  const { data: runRow, error: runError } = await supabase
    .from("scan_runs")
    .insert({
      scanned_at: scannedAtIso,
      duration_ms: durationMs,
      total_scanned: totalScanned,
      total_passed_filter: filtered.length,
      min_volume_ratio: MIN_VOLUME_RATIO,
      min_prev_volume: MIN_PREV_VOLUME,
      min_price: MIN_PRICE,
    })
    .select("id")
    .single();

  if (runError) {
    return { saved: false, reason: `Gagal insert scan_runs: ${runError.message}` };
  }

  // 2. Insert SEMUA saham (bukan hanya yang lolos filter) ke scan_results,
  //    dalam batch supaya tidak mengirim satu payload raksasa sekaligus
  const rows = all.map((r) => ({
    run_id: runRow.id,
    code: r.code,
    volume: r.volume,
    prev_volume: r.prevVolume,
    volume_ratio: r.volumeRatio,
    price: r.price,
    prev_price: r.prevPrice,
    price_change_pct: r.priceChangePct,
    passed_filter: r.passedFilter,
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
  maxDuration: 120, // detik — scan 900 saham dengan concurrency 10 biasanya jauh di bawah ini
};

export default async function handler(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }

  const startedAt = Date.now();
  const scannedAtIso = new Date(startedAt).toISOString();

  try {
    const { all, filtered, totalScanned } = await runFullScan();
    const durationMs = Date.now() - startedAt;

    // Simpan ke Supabase — kalau gagal, tetap kembalikan hasil scan ke browser
    // (jangan gagalkan scan yang sudah berhasil hanya karena penyimpanan histori gagal)
    const saveResult = await saveToSupabase({
      all,
      filtered,
      totalScanned,
      durationMs,
      scannedAtIso,
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      data: filtered,
      totalScanned,
      scannedAt: startedAt,
      durationMs,
      saved: saveResult.saved,
      saveError: saveResult.saved ? undefined : saveResult.reason,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
