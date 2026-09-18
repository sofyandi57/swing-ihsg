// api/intraday-value.js
// Vercel Serverless Function — hitung total NILAI TRANSAKSI (value) 30 menit
// terakhir per saham, dari data intraday menit-per-menit Invezgo. Dipakai untuk
// filter "Value 30 Menit Terakhir" di tab Run Scan.
//
// HANYA dipanggil untuk kode yang SEDANG DITAMPILKAN di layar (~25-50 saham),
// TIDAK untuk seluruh ~900 saham — data intraday per menit terlalu berat untuk
// dipanggil sebanyak itu setiap kali filter diubah.
//
// POST body: { codes: ["BBCA", "ANTM", ...] }

import { requireUser } from "./_lib/auth.js";
import { rejectIfInvezgoPaused } from "./_lib/invezgoPause.js";

const INVEZGO_BASE_URL = "https://api.invezgo.com";
const API_KEY = process.env.INVEZGO_API_KEY;
const CONCURRENCY = 15;
const MAX_CODES = 60; // jaring pengaman — jangan sampai dipanggil untuk terlalu banyak kode sekaligus

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

async function getValue30m(code) {
  try {
    const resp = await fetch(`${INVEZGO_BASE_URL}/analysis/intraday/${code}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!resp.ok) return { code, value30m: null };

    const candles = await resp.json();
    if (!Array.isArray(candles) || candles.length === 0) return { code, value30m: null };

    // Data intraday berupa candle per menit — ambil 30 candle TERAKHIR yang ada
    // (bukan 30 menit wall-clock, supaya tetap benar di luar jam bursa/data EOD).
    const sorted = [...candles].sort((a, b) => new Date(a.date) - new Date(b.date));
    const last30 = sorted.slice(-30);
    const total = last30.reduce((sum, c) => sum + Number(c.value || 0), 0);

    return { code, value30m: total };
  } catch (e) {
    return { code, value30m: null };
  }
}

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }
  if (await rejectIfInvezgoPaused(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method tidak didukung. Gunakan POST." });
    return;
  }

  const codes = req.body?.codes;
  if (!Array.isArray(codes) || codes.length === 0) {
    res.status(400).json({ error: "Field 'codes' wajib diisi (array kode saham)." });
    return;
  }
  if (codes.length > MAX_CODES) {
    res.status(400).json({ error: `Maksimal ${MAX_CODES} kode per panggilan.` });
    return;
  }

  const results = await runPool(codes, CONCURRENCY, getValue30m);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ results });
}
