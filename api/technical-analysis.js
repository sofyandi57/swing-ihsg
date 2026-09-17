// api/technical-analysis.js
// Vercel Serverless Function — analisa teknikal dari candle yang SUDAH dimuat di
// browser (dikirim balik dari tab Chart, tidak fetch ulang ke Invezgo). Server
// menghitung indikator numerik (SMA20/50, RSI14, support/resistance dari swing
// high/low) secara deterministik di JS — BUKAN ditebak oleh LLM — lalu Groq
// hanya bertugas menarasikan angka-angka itu jadi area beli/jual yang mudah
// dibaca. Kalau Groq tidak aktif, tetap kembalikan angka mentahnya tanpa narasi.
//
// POST body: { code, timeframe, candles: [{ time, open, high, low, close, volume }] }

const GROQ_API_KEY = process.env.GROQ_API_KEY;

function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Support/resistance sederhana: cari swing low/high (titik yang lebih rendah/
// tinggi dari N candle di kiri-kanannya) dari 60 candle terakhir, ambil level
// yang paling dekat dengan harga terkini di atas (resistance) dan di bawah
// (support). Ini heuristik price-action dasar, bukan machine learning.
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

function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const { nearestSupport, nearestSupport2, nearestResistance, nearestResistance2 } = findSupportResistance(
    candles,
    currentPrice
  );

  let trend = "sideways";
  if (sma20 && sma50) {
    if (sma20 > sma50 && currentPrice > sma20) trend = "uptrend";
    else if (sma20 < sma50 && currentPrice < sma20) trend = "downtrend";
  }

  return {
    currentPrice,
    sma20,
    sma50,
    rsi14,
    trend,
    nearestSupport,
    nearestSupport2,
    nearestResistance,
    nearestResistance2,
  };
}

async function narrateWithGroq({ code, timeframe, indicators }) {
  if (!GROQ_API_KEY) return { narrative: null, skipped: true, reason: "GROQ_API_KEY belum diset" };

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
              "Anda analis teknikal saham Indonesia (IDX/BEI). Diberi angka indikator (harga " +
              "terkini, SMA20, SMA50, RSI14, support/resistance dari swing high/low), buat " +
              "kesimpulan area beli dan area jual dalam Bahasa Indonesia, RINGKAS (maks 5 kalimat). " +
              "Sebutkan: (1) tren saat ini, (2) area beli yang masuk akal berdasarkan support, " +
              "(3) area jual/target berdasarkan resistance, (4) level stop-loss yang wajar kalau " +
              "tesis gagal (biasanya sedikit di bawah support terdekat). WAJIB tutup dengan kalimat: " +
              "'Ini alat bantu baca data, bukan rekomendasi transaksi — keputusan akhir tetap di tangan Anda.' " +
              "JANGAN gunakan bahasa yang terdengar seperti jaminan pasti profit.",
          },
          {
            role: "user",
            content: `Kode: ${code}, Timeframe: ${timeframe}. Data: ${JSON.stringify(indicators)}`,
          },
        ],
        temperature: 0.3,
      }),
    });

    if (!resp.ok) return { narrative: null, skipped: true, reason: `Groq HTTP ${resp.status}` };

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    return { narrative: text, skipped: false };
  } catch (e) {
    return { narrative: null, skipped: true, reason: String(e.message || e) };
  }
}

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method tidak didukung. Gunakan POST." });
    return;
  }

  const { code, timeframe, candles } = req.body || {};
  if (!code || !Array.isArray(candles) || candles.length < 20) {
    res.status(400).json({ error: "Butuh minimal 20 candle untuk analisa teknikal yang bermakna." });
    return;
  }

  const indicators = computeIndicators(candles);
  const groqResult = await narrateWithGroq({ code, timeframe, indicators });

  res.status(200).json({
    code,
    timeframe,
    indicators,
    narrative: groqResult.narrative,
    groqUsed: !groqResult.skipped,
    groqSkipReason: groqResult.skipped ? groqResult.reason : undefined,
  });
}
