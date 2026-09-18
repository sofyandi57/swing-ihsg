// api/sectors.js
// Vercel Serverless Function — populate dropdown Sektor & Subsektor di tab Run
// Scan dengan DATA ASLI dari Invezgo (bukan daftar yang dihafal/ditebak).
//
// GET /api/sectors                → daftar sektor (dari /analysis/list/stock, gratis)
// GET /api/sectors?sector=Keuangan → daftar subsektor UNTUK sektor itu saja
//   (fetch /analysis/information/{code} per saham DI SEKTOR ITU SAJA — biasanya
//   puluhan-ratusan saham, bukan ~900, jadi terjangkau dipanggil on-demand
//   setiap kali User memilih sektor di dropdown)

import { requireUser } from "./_lib/auth.js";
import { rejectIfInvezgoPaused } from "./_lib/invezgoPause.js";

const INVEZGO_BASE_URL = "https://api.invezgo.com";
const API_KEY = process.env.INVEZGO_API_KEY;
const CONCURRENCY = 20;

async function invezgoGet(path) {
  const resp = await fetch(INVEZGO_BASE_URL + path, {
    headers: { Authorization: `Bearer ${API_KEY}` },
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

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
  return results;
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

  try {
    const stockList = await getStockListCached();
    const sector = req.query?.sector;

    if (!sector) {
      const sectors = [...new Set(stockList.map((s) => s.sector).filter(Boolean))].sort();
      res.status(200).json({ sectors });
      return;
    }

    const codesInSector = stockList.filter((s) => s.sector === sector).map((s) => s.code);
    if (codesInSector.length === 0) {
      res.status(200).json({ sector, totalStocks: 0, subsectors: [] });
      return;
    }

    const infos = await runPool(codesInSector, CONCURRENCY, async (code) => {
      try {
        const info = await invezgoGet(`/analysis/information/${code}`);
        return info?.subsector || null;
      } catch (e) {
        return null;
      }
    });

    const subsectors = [...new Set(infos.filter(Boolean))].sort();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ sector, totalStocks: codesInSector.length, subsectors });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
