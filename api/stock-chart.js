// api/stock-chart.js
// Vercel Serverless Function — proxy ke Invezgo multi-timeframe chart endpoint,
// dipakai untuk grafik OHLCV di tab Chart (dipakai user untuk baca candlestick
// sebelum ambil keputusan, bukan cuma lihat angka rasio volume).
//
// GET /api/stock-chart?code=BBCA&timeframe=15
//
// Timeframe yang didukung Invezgo (/analysis/chart/multi-time/{code}):
//   1, 5, 15, 30, 60 (menit), D (daily), W (weekly), M (monthly)
// TIDAK ADA opsi 3 menit — itu batasan API Invezgo, bukan pilihan kami.
//
// Limitasi historis per timeframe (dari spec resmi Invezgo) menentukan `from`
// default supaya request tidak query di luar rentang yang didukung:
//   1  → maks 3 bulan terakhir
//   5  → maks 6 bulan terakhir
//   15 → maks 1 tahun terakhir
//   30, 60, D, W, M → maks 2 tahun terakhir

import { requireUser } from "./_lib/auth.js";

const INVEZGO_BASE_URL = "https://api.invezgo.com";
const API_KEY = process.env.INVEZGO_API_KEY;

const VALID_TIMEFRAMES = new Set(["1", "5", "15", "30", "60", "D", "W", "M"]);

const LOOKBACK_DAYS_BY_TIMEFRAME = {
  "1": 30, // default request jendela pendek meski limit API 3 bulan — payload tetap ringan untuk 1 menit
  "5": 60,
  "15": 180,
  "30": 365,
  "60": 365,
  D: 365,
  W: 730,
  M: 730,
};

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }

  const code = (req.query?.code || "").toUpperCase().trim();
  const timeframe = (req.query?.timeframe || "D").toUpperCase();

  if (!code || !/^[A-Z0-9]{3,7}$/.test(code)) {
    res.status(400).json({ error: "Parameter 'code' wajib diisi dengan kode saham/index yang valid." });
    return;
  }
  if (!VALID_TIMEFRAMES.has(timeframe)) {
    res.status(400).json({
      error: `Timeframe '${timeframe}' tidak didukung. Pilihan valid: ${[...VALID_TIMEFRAMES].join(", ")}.`,
    });
    return;
  }

  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS_BY_TIMEFRAME[timeframe] * 24 * 60 * 60 * 1000);

  try {
    const url = new URL(`${INVEZGO_BASE_URL}/analysis/chart/multi-time/${code}`);
    url.searchParams.set("from", ymd(from));
    url.searchParams.set("to", ymd(to));
    url.searchParams.set("timeframe", timeframe);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (resp.status === 204) {
      res.status(200).json({ code, timeframe, candles: [], note: "Data tidak tersedia untuk kode/periode ini." });
      return;
    }
    if (resp.status === 401) throw new Error("401: API key tidak valid.");
    if (resp.status === 402) throw new Error("402: Paket subscription tidak cukup untuk multi-timeframe chart.");
    if (resp.status === 422) throw new Error("422: Kode saham tidak valid.");
    if (resp.status === 429) throw new Error("429: Rate limit tercapai.");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

    const raw = await resp.json();
    // Cast eksplisit — beberapa field Invezgo dikembalikan sebagai string
    const candles = (Array.isArray(raw) ? raw : []).map((c) => ({
      time: c.date,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }));

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ code, timeframe, candles });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
