// api/ai-shortlist.js
// Vercel Serverless Function — tahap KEDUA setelah scan (mode apapun): dari
// hasil yang sudah ditampilkan (misal 20+ saham lolos kriteria), AI (Groq)
// bantu pilih yang paling menarik berdasarkan volume spike, frekuensi
// transaksi, value, dan risiko likuiditas.
//
// SEMUA angka yang dinilai AI ditarik LANGSUNG dari Invezgo — freq, spread,
// imbalance bid/offer dihitung dari /analysis/intraday-data/{code} (snapshot
// hari ini), BUKAN diminta AI menebak. AI cuma menarasikan & meranking angka
// yang sudah dihitung deterministik di server, sama prinsipnya dengan
// api/technical-analysis.js.
//
// Setelah Groq memilih kandidat (biasanya 5-15 dari puluhan/ratusan hasil
// scan), untuk KANDIDAT ITU SAJA (bukan semua hasil scan) di-fetch data
// candle historis dan dihitung support/resistance (persis logika di
// api/technical-analysis.js) — supaya bisa langsung kasih area beli, area
// jual, dan stop-loss dalam SATU respons, tanpa User harus buka tab Chart
// manual satu-satu. Tetap cepat karena cuma dihitung untuk saham yang
// benar-benar terpilih, bukan seluruh hasil scan.
//
// POST body: { rows: [{ code, value, priceChangePct,
//   volRatio3v20?, priceChange3d?, sector?, subsector? }, ...] }
// (rows = hasil scan yang SEDANG ditampilkan di browser, tidak difetch ulang)

import { requireUser } from "./_lib/auth.js";

const INVEZGO_BASE_URL = "https://api.invezgo.com";
const API_KEY = process.env.INVEZGO_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CONCURRENCY = 15;
const MAX_ROWS = 150; // jaring pengaman — kalau hasil scan lebih dari ini, minta User persempit kriteria dulu

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

async function getIntradaySnapshot(code) {
  try {
    const resp = await fetch(`${INVEZGO_BASE_URL}/analysis/intraday-data/${code}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!resp.ok) return { code, freq: null, spreadPct: null, imbalance: null };

    const d = await resp.json();
    const bidPrice = Number(d.bid_price);
    const offerPrice = Number(d.offer_price);
    const bidLot = Number(d.bid_lot);
    const offerLot = Number(d.offer_lot);
    const price = Number(d.close);

    const spreadPct = price > 0 && offerPrice > 0 && bidPrice > 0 ? ((offerPrice - bidPrice) / price) * 100 : null;
    const totalLot = bidLot + offerLot;
    // imbalance positif = minat beli (bid) lebih besar dari minat jual (offer) — proxy tekanan beli/jual, bukan jaminan arah harga
    const imbalance = totalLot > 0 ? (bidLot - offerLot) / totalLot : null;

    return { code, freq: Number(d.freq) || null, spreadPct, imbalance };
  } catch (e) {
    return { code, freq: null, spreadPct: null, imbalance: null };
  }
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// Sama persis dengan findSupportResistance di api/technical-analysis.js —
// swing high/low dari 80 candle terakhir, ambil level terdekat dari harga
// sekarang. Diduplikasi (bukan di-import) karena masing-masing api/*.js di
// Vercel adalah function terpisah — pola yang sama juga dipakai di file lain.
function findSupportResistance(candles, currentPrice, lookback = 3) {
  const window = candles.slice(-80);
  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < window.length - lookback; i++) {
    const slice = window.slice(i - lookback, i + lookback + 1);
    const current = window[i];
    if (current.high === Math.max(...slice.map((c) => c.high))) swingHighs.push(current.high);
    if (current.low === Math.min(...slice.map((c) => c.low))) swingLows.push(current.low);
  }

  const resistances = [...new Set(swingHighs)].filter((h) => h > currentPrice).sort((a, b) => a - b);
  const supports = [...new Set(swingLows)].filter((l) => l < currentPrice).sort((a, b) => b - a);

  return {
    nearestSupport: supports[0] ?? null,
    nearestSupport2: supports[1] ?? null,
    nearestResistance: resistances[0] ?? null,
    nearestResistance2: resistances[1] ?? null,
  };
}

// Ambil area beli/jual/stop-loss dari support/resistance saham TERPILIH saja.
// - Area beli: sekitar support terdekat (support s/d support+2%)
// - Area jual/target: sekitar resistance terdekat (resistance-2% s/d resistance,
//   pakai resistance kedua sebagai target lanjutan kalau ada)
// - Stop-loss: sedikit di bawah support (support-6% s/d support-3%) — tempat
//   tesis "dijaga di atas support" dinyatakan gagal
async function getTradeLevels(code) {
  const to = new Date();
  const from = new Date(to.getTime() - 120 * 24 * 60 * 60 * 1000); // ~80+ hari perdagangan

  try {
    const resp = await fetch(
      `${INVEZGO_BASE_URL}/analysis/chart/stock/${code}?from=${ymd(from)}&to=${ymd(to)}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } }
    );
    if (!resp.ok) return null;

    const raw = await resp.json();
    if (!Array.isArray(raw) || raw.length < 20) return null;

    const candles = [...raw]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((c) => ({ high: Number(c.high), low: Number(c.low), close: Number(c.close) }));

    const currentPrice = candles[candles.length - 1].close;
    const { nearestSupport, nearestResistance, nearestResistance2 } = findSupportResistance(candles, currentPrice);

    if (!nearestSupport || !nearestResistance) return null;

    const round = (n) => Math.round(n);
    const target = nearestResistance2 || nearestResistance * 1.05;

    return {
      buyLow: round(nearestSupport),
      buyHigh: round(nearestSupport * 1.02),
      sellLow: round(nearestResistance * 0.98),
      sellHigh: round(target),
      stopLossLow: round(nearestSupport * 0.94),
      stopLossHigh: round(nearestSupport * 0.97),
    };
  } catch (e) {
    return null;
  }
}

async function askGroq(enrichedRows) {
  if (!GROQ_API_KEY) return { picks: [], skipped: true, reason: "GROQ_API_KEY belum diset" };

  const n = Math.min(15, Math.max(5, Math.round(enrichedRows.length / 4)));

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
              `Anda analis screening saham Indonesia (IDX/BEI). Diberi daftar saham hasil ` +
              `screening dengan metrik: value (nilai transaksi hari ini, proxy likuiditas), ` +
              `priceChangePct, freq (frekuensi transaksi hari ini — makin tinggi makin banyak ` +
              `trader terlibat, bukan cuma 1-2 order besar), spreadPct (selisih bid-offer ` +
              `terhadap harga, makin besar makin ILIKUID/BERISIKO untuk keluar-masuk posisi), ` +
              `imbalance (positif = minat beli lebih besar dari jual). Pilih maksimal ${n} saham ` +
              `PALING MENARIK berdasarkan kombinasi: frekuensi tinggi (partisipasi luas, bukan ` +
              `cuma 1-2 order), value cukup besar (likuid), pergerakan harga signifikan, DAN ` +
              `risiko wajar (spread tidak terlalu lebar). Beri alasan 1 kalimat per pilihan DAN ` +
              `catatan risiko 1 kalimat (kalau ada, misal spread lebar/freq rendah). JANGAN ` +
              `merekomendasikan beli/jual eksplisit — ini alat bantu prioritas baca data.`,
          },
          { role: "user", content: JSON.stringify(enrichedRows) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "ai_shortlist",
            strict: true,
            schema: {
              type: "object",
              properties: {
                picks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      code: { type: "string" },
                      reason: { type: "string" },
                      risk: { type: "string" },
                    },
                    required: ["code", "reason", "risk"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["picks"],
              additionalProperties: false,
            },
          },
        },
        temperature: 0.3,
      }),
    });

    if (!resp.ok) return { picks: [], skipped: true, reason: `Groq HTTP ${resp.status}` };

    const data = await resp.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    // Validasi: kode yang disebut AI HARUS ada di input asli — kalau tidak, buang (anti halusinasi)
    const validCodes = new Set(enrichedRows.map((r) => r.code));
    const picks = (parsed.picks || []).filter((p) => validCodes.has(p.code));
    return { picks, skipped: false };
  } catch (e) {
    return { picks: [], skipped: true, reason: String(e.message || e) };
  }
}

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method tidak didukung. Gunakan POST." });
    return;
  }

  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "Field 'rows' wajib diisi (array hasil scan yang sedang ditampilkan)." });
    return;
  }
  if (rows.length > MAX_ROWS) {
    res.status(400).json({
      error: `Terlalu banyak saham (${rows.length}). Persempit kriteria scan dulu (maks ${MAX_ROWS} saham) supaya AI bisa menilai dengan cermat.`,
    });
    return;
  }

  const snapshots = await runPool(
    rows.map((r) => r.code),
    CONCURRENCY,
    getIntradaySnapshot
  );
  const snapshotByCode = new Map(snapshots.map((s) => [s.code, s]));

  const enrichedRows = rows.map((r) => {
    const snap = snapshotByCode.get(r.code) || {};
    return {
      code: r.code,
      value: r.value ?? null,
      priceChangePct: r.priceChangePct ?? null,
      volRatio3v20: r.volRatio3v20 ?? null,
      freq: snap.freq ?? null,
      spreadPct: snap.spreadPct ?? null,
      imbalance: snap.imbalance ?? null,
    };
  });

  const groqResult = await askGroq(enrichedRows);

  // Hanya untuk saham yang BENAR-BENAR terpilih (biasanya 5-15) — bukan semua
  // hasil scan — supaya tetap cepat berapa pun banyaknya saham yang di-scan.
  const tradeLevelsList = await runPool(
    groqResult.picks.map((p) => p.code),
    CONCURRENCY,
    getTradeLevels
  );
  const tradeLevelsByCode = new Map(groqResult.picks.map((p, i) => [p.code, tradeLevelsList[i]]));

  const picksWithLevels = groqResult.picks.map((p) => ({
    ...p,
    levels: tradeLevelsByCode.get(p.code) || null, // null kalau data candle tidak cukup
  }));

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    enrichedRows,
    picks: picksWithLevels,
    groqUsed: !groqResult.skipped,
    groqSkipReason: groqResult.skipped ? groqResult.reason : undefined,
  });
}
