// api/dashboard.js
// Vercel Serverless Function — mesin scoring "IDX Advisor" (recommend() +
// calcARA()) dari LOGIC.md, di-port dari JS browser ke server Node, dengan
// sumber data Invezgo (bukan Yahoo Finance seperti versi aslinya):
//   - OHLCV harian ~370 hari (cukup untuk indikator + posisi 52 minggu) dari
//     /analysis/chart/stock/{code} — endpoint yang SAMA dipakai tab Chart.
//   - Harga/volume terkini dari /analysis/intraday-data/{code} (snapshot hari
//     berjalan) kalau tersedia, fallback ke candle harian terakhir kalau tidak
//     (mis. di luar jam bursa atau paket API tidak termasuk data intraday).
//
// SEMUA rumus indikator & skor mengikuti LOGIC.md apa adanya. Bagian yang
// TIDAK dirinci di LOGIC.md (formula persis conf%, lebar zona entry, bobot
// calcARA) diberi implementasi masuk akal dan DITANDAI eksplisit di komentar
// — supaya jelas mana yang port persis vs mana yang interpretasi kami.
//
// GET /api/dashboard?code=BBCA&mode=swing&priceOverride=4200(opsional)
// mode: scalping | intraday | swing | dividen

import { requireUser } from "./_lib/auth.js";
import { rejectIfInvezgoPaused } from "./_lib/invezgoPause.js";

const INVEZGO_BASE_URL = "https://api.invezgo.com";
const API_KEY = process.env.INVEZGO_API_KEY;
const VALID_MODES = new Set(["scalping", "intraday", "swing", "dividen"]);

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

async function invezgoGet(path, params = {}) {
  const url = new URL(INVEZGO_BASE_URL + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ===== Indikator dasar =====

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function smaEndingAt(values, period, offsetFromEnd) {
  // SMA dari `period` nilai yang berakhir `offsetFromEnd` hari sebelum data terakhir
  // — dipakai untuk ma20Slope (MA20 sekarang vs MA20 5 hari lalu).
  const end = values.length - offsetFromEnd;
  if (end < period) return null;
  const slice = values.slice(end - period, end);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaSeries(values, period) {
  if (values.length < period) return new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function rsi(closes, period) {
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
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcMACD(closes) {
  if (closes.length < 34) return null; // butuh 26 (EMA26 seed) + 9 (signal) - overlap minimal
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null));
  const firstValid = macdLine.findIndex((v) => v != null);
  if (firstValid < 0) return null;
  const macdValid = macdLine.slice(firstValid);
  const signalValid = emaSeries(macdValid, 9);
  const line = macdValid[macdValid.length - 1];
  const signal = signalValid[signalValid.length - 1];
  const signalPrev = signalValid[signalValid.length - 2];
  const linePrev = macdValid[macdValid.length - 2];
  if (line == null || signal == null) return null;
  const hist = line - signal;
  const histPrev = linePrev != null && signalPrev != null ? linePrev - signalPrev : null;
  return { line, signal, hist, histPrev };
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, c) => sum + (c - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

function calcStoch(closes, highs, lows, period = 14) {
  if (closes.length < period + 2) return null;
  function kAt(endIndex) {
    const hi = Math.max(...highs.slice(endIndex - period + 1, endIndex + 1));
    const lo = Math.min(...lows.slice(endIndex - period + 1, endIndex + 1));
    if (hi === lo) return 50;
    return ((closes[endIndex] - lo) / (hi - lo)) * 100;
  }
  const lastIdx = closes.length - 1;
  const kVals = [];
  for (let i = Math.max(period - 1, lastIdx - 2); i <= lastIdx; i++) kVals.push(kAt(i));
  const k = kVals[kVals.length - 1];
  const d = kVals.reduce((a, b) => a + b, 0) / kVals.length;
  return { k, d };
}

function roc(closes, period) {
  if (closes.length < period + 1) return null;
  const cur = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  if (!past) return null;
  return ((cur - past) / past) * 100;
}

function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ===== Sesi bursa IDX (WIB = UTC+7) =====
function getSession() {
  const now = new Date();
  const wibMinutes = (Math.floor(now.getTime() / 60000) + 7 * 60) % (24 * 60);
  const h = Math.floor(wibMinutes / 60);
  const m = wibMinutes % 60;
  const t = h * 60 + m;
  const mins = (hh, mm) => hh * 60 + mm;

  if (t >= mins(8, 45) && t < mins(9, 0)) return "preopen";
  if (t >= mins(9, 0) && t < mins(12, 0)) return "sesi1";
  if (t >= mins(12, 0) && t < mins(13, 30)) return "break";
  if (t >= mins(13, 30) && t < mins(15, 50)) return "sesi2";
  return "after";
}

const SESSION_MULT = {
  preopen: { mom: 0.7, mr: 0.7, vol: 0.3 },
  sesi1: { mom: 1.2, mr: 1.0, vol: 1.2 },
  break: { mom: 0.8, mr: 0.9, vol: 0.5 },
  sesi2: { mom: 1.0, mr: 1.3, vol: 0.9 },
  after: { mom: 1.0, mr: 1.0, vol: 0.6 },
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ===== recommend() — port dari LOGIC.md =====
export function recommend(d, mode) {
  const { closes, opens, highs, lows, volumes } = d;
  if (closes.length < 26) return null;

  const cur = d.meta.regularMarketPrice;
  const prevClose = d.meta.previousClose;
  const priceChangePct = prevClose ? ((cur - prevClose) / prevClose) * 100 : 0;

  const rsi14 = rsi(closes, 14);
  const rsi9 = rsi(closes, 9);
  const ma20 = sma(closes, 20);
  const ma50 = closes.length >= 50 ? sma(closes, 50) : null;
  const ma20_5dAgo = smaEndingAt(closes, 20, 5);
  const ma20Slope = ma20 != null && ma20_5dAgo ? ((ma20 - ma20_5dAgo) / ma20_5dAgo) * 100 : 0;
  const macd = calcMACD(closes);
  const bb = calcBB(closes);
  const stoch = calcStoch(closes, highs, lows);
  const roc5 = roc(closes, 5);
  const roc10 = roc(closes, 10);
  const atr = calcATR(highs, lows, closes, 14);

  const avgVol20 = sma(volumes.slice(0, -1), 20) || sma(volumes, 20);
  const volRatio = avgVol20 ? (d.meta.regularMarketVolume || volumes[volumes.length - 1]) / avgVol20 : null;

  const sigs = [];

  // ----- 1. TREND (max ±2.5) -----
  let trendSc = 0;
  if (ma20Slope > 1.5) {
    trendSc += 1.0;
    sigs.push({ t: "MA20 naik tajam (slope > 1.5%)", b: true });
  } else if (ma20Slope >= 0.3) {
    trendSc += 0.5;
    sigs.push({ t: "MA20 naik moderat", b: true });
  } else if (ma20Slope < -1.5) {
    trendSc -= 1.0;
    sigs.push({ t: "MA20 turun tajam (slope < -1.5%)", b: false });
  } else if (ma20Slope <= -0.3) {
    trendSc -= 0.5;
    sigs.push({ t: "MA20 turun moderat", b: false });
  }
  if (ma50 != null) {
    if (cur > ma20 && ma20 > ma50) {
      trendSc += 1.5;
      sigs.push({ t: "Struktur uptrend kuat: harga > MA20 > MA50", b: true });
    } else if (cur < ma20 && ma20 < ma50) {
      trendSc -= 1.5;
      sigs.push({ t: "Struktur downtrend kuat: harga < MA20 < MA50", b: false });
    } else if (cur > ma50 && ma20 > ma50) {
      trendSc += 0.5;
      sigs.push({ t: "Uptrend moderat (di atas MA50)", b: true });
    } else if (cur < ma50 && ma20 < ma50) {
      trendSc -= 0.5;
      sigs.push({ t: "Downtrend moderat (di bawah MA50)", b: false });
    }
  }
  trendSc = clamp(trendSc, -2.5, 2.5);
  const trendUp = trendSc >= 1.5;
  const trendDn = trendSc <= -1.5;

  // ----- 2. MOMENTUM (max ±2.0) -----
  let momSc = 0;
  if (roc5 != null) {
    if (roc5 > 5) {
      momSc += 1.5;
      sigs.push({ t: `ROC5 kuat (+${roc5.toFixed(1)}%)`, b: true });
    } else if (roc5 >= 2) {
      momSc += 0.8;
    } else if (roc5 < -5) {
      momSc -= 1.5;
      sigs.push({ t: `ROC5 lemah (${roc5.toFixed(1)}%)`, b: false });
    } else if (roc5 <= -2) {
      momSc -= 0.8;
    }
  }
  if (macd) {
    if (macd.histPrev != null && macd.histPrev <= 0 && macd.hist > 0) {
      momSc += 1.0;
      sigs.push({ t: "MACD golden cross (histogram tembus ke atas)", b: true });
    } else if (macd.histPrev != null && macd.histPrev >= 0 && macd.hist < 0) {
      momSc -= 1.0;
      sigs.push({ t: "MACD death cross (histogram tembus ke bawah)", b: false });
    } else if (macd.hist > 0 && macd.histPrev != null && macd.hist > macd.histPrev) {
      momSc += 0.5;
    } else if (macd.hist < 0 && macd.histPrev != null && macd.hist < macd.histPrev) {
      momSc -= 0.5;
    }
  }
  momSc = clamp(momSc, -2.0, 2.0);

  // ----- 3. MEAN REVERSION (max ±2.5) -----
  let mrSc = 0;
  const oversold = [rsi14 != null && rsi14 < 35, stoch != null && stoch.k < 25, bb != null && cur < bb.lower].filter(Boolean).length;
  const overbought = [rsi14 != null && rsi14 > 65, stoch != null && stoch.k > 75, bb != null && cur > bb.upper].filter(Boolean).length;
  if (oversold >= 2) {
    mrSc += 2.0;
    sigs.push({ t: "Oversold terkonfirmasi (RSI+Stoch+BB)", b: true });
    if (rsi14 != null && rsi14 < 25) mrSc += 0.5;
  } else if (oversold === 1) {
    mrSc += 1.0;
  }
  if (overbought >= 2) {
    mrSc -= 2.0;
    sigs.push({ t: "Overbought terkonfirmasi (RSI+Stoch+BB)", b: false });
    if (rsi14 != null && rsi14 > 75) mrSc -= 0.5;
  } else if (overbought === 1) {
    mrSc -= 1.0;
  }
  if (bb) {
    const bbRange = bb.upper - bb.lower;
    const bbPos = bbRange > 0 ? (cur - bb.lower) / bbRange : 0.5;
    if (bbPos <= 0.25) mrSc += 0.3;
    else if (bbPos >= 0.75) mrSc -= 0.3;
  }
  mrSc = clamp(mrSc, -2.5, 2.5);

  // ----- 4. VOLUME (max ±1.5) -----
  let volSc = 0;
  const priceUp = priceChangePct >= 0;
  if (volRatio != null) {
    if (volRatio > 3.0) {
      volSc = priceUp ? 1.5 : -1.5;
      sigs.push({ t: `Volume meledak (${volRatio.toFixed(1)}x rata-rata 20 hari)`, b: priceUp });
    } else if (volRatio >= 1.8) {
      volSc = priceUp ? 1.0 : -1.0;
    } else if (volRatio >= 1.3) {
      volSc = priceUp ? 0.4 : -0.4;
    } else if (volRatio < 0.5 && Math.abs(priceChangePct) > 1) {
      volSc = 0; // pergerakan tidak terkonfirmasi volume
    }
  }
  volSc = clamp(volSc, -1.5, 1.5);

  // ----- 5. PATTERN (max ±1.5) -----
  let consGreen = 0;
  let consRed = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] > opens[i]) {
      if (consRed > 0) break;
      consGreen++;
    } else if (closes[i] < opens[i]) {
      if (consGreen > 0) break;
      consRed++;
    } else break;
  }
  let patSc = 0;
  if (consGreen >= 4) {
    patSc += 1.0;
    sigs.push({ t: `${consGreen} candle hijau beruntun`, b: true });
  } else if (consGreen >= 2) patSc += 0.3;
  if (consRed >= 4) {
    patSc -= 1.0;
    sigs.push({ t: `${consRed} candle merah beruntun`, b: false });
  } else if (consRed >= 2) patSc -= 0.3;

  const high52 = Math.max(...highs);
  const low52 = Math.min(...lows);
  const pos52 = high52 > low52 ? ((cur - low52) / (high52 - low52)) * 100 : 50;
  if (pos52 > 90) {
    patSc -= 0.5;
    sigs.push({ t: "Dekat harga tertinggi 52 minggu", b: false });
  } else if (pos52 < 10) {
    patSc += 0.3;
    sigs.push({ t: "Dekat harga terendah 52 minggu", b: true });
  }
  patSc = clamp(patSc, -1.5, 1.5);

  // ----- 6. MICROSTRUCTURE (max ±1.0) -----
  const todayHigh = highs[highs.length - 1];
  const todayLow = lows[lows.length - 1];
  const todayOpen = opens[opens.length - 1];
  const range = todayHigh - todayLow;
  const bodyPos = range > 0 ? (cur - todayLow) / range : 0.5;
  let microSc = 0;
  if (bodyPos >= 0.75) microSc += 0.5;
  else if (bodyPos <= 0.25) microSc -= 0.5;
  const upperWick = range > 0 ? (todayHigh - Math.max(todayOpen, cur)) / range : 0;
  if (upperWick > 0.5 && bodyPos < 0.4) microSc -= 0.35;
  else if (upperWick < 0.1 && bodyPos > 0.7) microSc += 0.2;

  const last3BodyPos = [];
  for (let i = closes.length - 3; i < closes.length; i++) {
    if (i < 0) continue;
    const r = highs[i] - lows[i];
    last3BodyPos.push(r > 0 ? (closes[i] - lows[i]) / r : 0.5);
  }
  const avgBody3 = last3BodyPos.reduce((a, b) => a + b, 0) / last3BodyPos.length;
  if (avgBody3 > 0.65) microSc += 0.25;
  else if (avgBody3 < 0.35) microSc -= 0.25;

  if (mode === "scalping" || mode === "intraday") microSc *= 1.3;
  microSc = clamp(microSc, -1.0, 1.0);

  // ----- Komposisi akhir -----
  const session = getSession();
  const sm = SESSION_MULT[session];
  const ampBull = trendUp ? 1.2 : trendDn ? 0.75 : 1.0;
  const ampBear = trendDn ? 1.2 : trendUp ? 0.75 : 1.0;
  // Mode "dividen" mematikan multiplier sesi (LOGIC.md: "Session multipliers off")
  const sessMom = mode === "dividen" ? 1.0 : sm.mom;
  const sessMR = mode === "dividen" ? 1.0 : sm.mr;
  const sessVol = mode === "dividen" ? 1.0 : sm.vol;

  const bullishNonTrend =
    Math.max(0, momSc) * ampBull * sessMom +
    Math.max(0, mrSc) * ampBull * sessMR +
    Math.max(0, volSc) * ampBull * sessVol +
    Math.max(0, patSc) * ampBull;
  const bearishNonTrend =
    Math.min(0, momSc) * ampBear * sessMom +
    Math.min(0, mrSc) * ampBear * sessMR +
    Math.min(0, volSc) * ampBear * sessVol +
    Math.min(0, patSc) * ampBear;

  const sc = trendSc + bullishNonTrend + bearishNonTrend + microSc;

  let action;
  let cls;
  if (sc >= 5.5) {
    action = "STRONG BUY";
    cls = "buy";
  } else if (sc >= 2.5) {
    action = "BUY";
    cls = "buy";
  } else if (sc >= 0.5) {
    action = "HOLD";
    cls = "hold";
  } else if (sc >= -2.5) {
    action = "SELL / REDUCE";
    cls = "sell";
  } else {
    action = "STRONG SELL";
    cls = "sell";
  }

  const absSc = Math.abs(sc);
  const strength = absSc >= 5.5 ? "Sangat Kuat" : absSc >= 2.5 ? "Kuat" : absSc >= 0.5 ? "Moderat" : "Lemah";

  // conf: TIDAK dirinci formula persisnya di LOGIC.md (cuma range 15-88 dan
  // "display confidence %, not probability") — interpretasi kami: makin
  // ekstrem skornya (menjauh dari 0/netral), makin tinggi confidence-nya,
  // terlepas dari arah bullish/bearish.
  const conf = Math.round(clamp(15 + (Math.min(absSc, 10) / 10) * 73, 15, 88));

  const horLabel = { scalping: "Menit–Jam", intraday: "Hari Ini", swing: "2–4 Minggu", dividen: "3–12 Bulan" }[mode];

  // ----- Stop Loss & Target (ATR-based, fallback ke persentase tetap) -----
  const atrMult = mode === "scalping" ? 1.0 : mode === "intraday" ? 1.3 : 1.8;
  let sl, t1, t2;
  if (atr != null) {
    sl = cur - atr * atrMult;
    t1 = cur + atr * (atrMult * 1.5);
    t2 = cur + atr * (atrMult * 3.0);
  } else {
    const pct = { scalping: [1.2, 2.5, 5], intraday: [2, 4, 8], swing: [4, 7, 15], dividen: [4, 7, 15] }[mode];
    sl = cur * (1 - pct[0] / 100);
    t1 = cur * (1 + pct[1] / 100);
    t2 = cur * (1 + pct[2] / 100);
  }
  const rr = cur - sl > 0 ? (t1 - cur) / (cur - sl) : null;

  // Zona entry — TIDAK dirinci di LOGIC.md; interpretasi kami: pita ±0.5% di
  // sekitar harga terkini, cukup ketat untuk scalping/intraday.
  const elow = cur * 0.995;
  const ehigh = cur * 1.005;

  const desc = `${action} — skor komposit ${sc.toFixed(2)} (tren ${trendSc >= 0 ? "+" : ""}${trendSc.toFixed(1)}, momentum ${momSc >= 0 ? "+" : ""}${momSc.toFixed(1)}, mean-reversion ${mrSc >= 0 ? "+" : ""}${mrSc.toFixed(1)}, volume ${volSc >= 0 ? "+" : ""}${volSc.toFixed(1)}, pola ${patSc >= 0 ? "+" : ""}${patSc.toFixed(1)}, mikrostruktur ${microSc >= 0 ? "+" : ""}${microSc.toFixed(1)}).`;

  return {
    action,
    cls,
    desc,
    sc,
    conf,
    strength,
    hor: horLabel,
    sigs,
    trendSc,
    momSc,
    mrSc,
    volSc,
    patSc,
    microSc,
    rsiV: rsi14,
    ma20,
    ma50,
    macdV: macd,
    bb,
    pos52,
    session,
    strat: { elow, ehigh, sl, t1, t2, rr, hor: horLabel },
  };
}

// ===== calcARA() — port dari LOGIC.md =====
// LOGIC.md tidak merinci bobot/formula persis (cuma daftar input yang
// dipakai) — implementasi di bawah adalah interpretasi kami yang masuk akal
// dari daftar itu, DITANDAI jelas bukan port 1:1.
export function calcARA(d) {
  const { closes, highs, lows } = d;
  if (closes.length < 26) return { score: 0, araLvl: null, arbLvl: null, sigs: [] };

  const cur = d.meta.regularMarketPrice;
  const rsi14 = rsi(closes, 14);
  const avgVol20 = sma(d.volumes.slice(0, -1), 20);
  const volRatio = avgVol20 ? d.meta.regularMarketVolume / avgVol20 : null;
  const high52 = Math.max(...highs);
  const low52 = Math.min(...lows);
  const pos52 = high52 > low52 ? ((cur - low52) / (high52 - low52)) * 100 : 50;
  const atr = calcATR(highs, lows, closes, 14);
  const atrPct = atr != null ? (atr / cur) * 100 : 0;

  let consGreen = 0;
  let consRed = 0;
  const { opens } = d;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] > opens[i]) {
      if (consRed > 0) break;
      consGreen++;
    } else if (closes[i] < opens[i]) {
      if (consGreen > 0) break;
      consRed++;
    } else break;
  }

  const sigs = [];
  let araScore = 0;
  if (rsi14 != null && rsi14 > 70) {
    araScore += 3;
    sigs.push({ t: "RSI overbought (momentum naik kuat)", b: true });
  } else if (rsi14 != null && rsi14 > 60) araScore += 1.5;

  if (volRatio != null && volRatio > 2) {
    araScore += 3;
    sigs.push({ t: `Volume ${volRatio.toFixed(1)}x rata-rata`, b: true });
  } else if (volRatio != null && volRatio > 1.3) araScore += 1.5;

  if (pos52 > 90) {
    araScore += 2;
    sigs.push({ t: "Dekat ATH 52 minggu", b: true });
  }
  if (consGreen >= 3) {
    araScore += 1.5;
    sigs.push({ t: `${consGreen} hari hijau beruntun`, b: true });
  }
  if (atrPct > 5) araScore += 0.5;
  araScore = clamp(araScore, 0, 10);

  let arbScore = 0;
  if (rsi14 != null && rsi14 < 30) arbScore += 3;
  if (volRatio != null && volRatio > 2 && d.meta.regularMarketPrice < d.meta.previousClose) arbScore += 3;
  if (pos52 < 10) arbScore += 2;
  if (consRed >= 3) arbScore += 1.5;
  if (atrPct > 5) arbScore += 0.5;
  arbScore = clamp(arbScore, 0, 10);

  const levelOf = (s) => (s >= 7.5 ? "SANGAT TINGGI" : s >= 5 ? "TINGGI" : s >= 3 ? "MODERAT" : s >= 1 ? "RENDAH" : null);

  return {
    score: araScore,
    araLvl: levelOf(araScore),
    arbScore,
    arbLvl: levelOf(arbScore),
    sigs,
  };
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

  const code = (req.query?.code || "").toUpperCase().trim();
  const mode = req.query?.mode || "swing";
  const priceOverride = req.query?.priceOverride ? Number(req.query.priceOverride) : null;

  if (!code || !/^[A-Z0-9]{3,7}$/.test(code)) {
    res.status(400).json({ error: "Parameter 'code' wajib diisi dengan kode saham yang valid." });
    return;
  }
  if (!VALID_MODES.has(mode)) {
    res.status(400).json({ error: `mode '${mode}' tidak valid. Pilihan: ${[...VALID_MODES].join(", ")}.` });
    return;
  }

  try {
    const to = new Date();
    const from = new Date(to.getTime() - 400 * 24 * 60 * 60 * 1000); // ~370 hari perdagangan + buffer indikator

    const raw = await invezgoGet(`/analysis/chart/stock/${code}`, { from: ymd(from), to: ymd(to) });
    if (!Array.isArray(raw) || raw.length < 26) {
      res.status(200).json({ error: "Data historis tidak cukup (minimal 26 hari perdagangan) untuk saham ini." });
      return;
    }

    const rows = [...raw].sort((a, b) => new Date(a.date) - new Date(b.date));
    const d = {
      closes: rows.map((r) => Number(r.close)),
      opens: rows.map((r) => Number(r.open)),
      highs: rows.map((r) => Number(r.high)),
      lows: rows.map((r) => Number(r.low)),
      volumes: rows.map((r) => Number(r.volume)),
      dates: rows.map((r) => r.date),
      meta: {
        regularMarketPrice: Number(rows[rows.length - 1].close),
        previousClose: Number(rows[rows.length - 2].close),
        regularMarketVolume: Number(rows[rows.length - 1].volume),
      },
    };

    // Snapshot intraday untuk harga/volume LEBIH SEGAR dari candle harian
    // terakhir (kalau tersedia) — fallback diam-diam ke data harian kalau
    // gagal (di luar jam bursa, atau paket API tidak termasuk data ini).
    try {
      const snap = await invezgoGet(`/analysis/intraday-data/${code}`);
      if (snap?.close) {
        d.meta.regularMarketPrice = Number(snap.close);
        d.meta.regularMarketVolume = Number(snap.volume) || d.meta.regularMarketVolume;
        d.meta.previousClose = Number(snap.prev) || d.meta.previousClose;
      }
    } catch (e) {
      // abaikan — pakai data harian
    }

    // Price override manual (fitur UI dari LOGIC.md) — timpa harga sebelum
    // recommend() dijalankan, supaya semua skor/SL/TP ikut hitung ulang.
    if (priceOverride && priceOverride > 0) {
      d.meta.regularMarketPrice = priceOverride;
      d.closes[d.closes.length - 1] = priceOverride;
    }

    const rec = recommend(d, mode);
    if (!rec) {
      res.status(200).json({ error: "Data tidak cukup untuk menghitung rekomendasi." });
      return;
    }
    const ara = calcARA(d);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      code,
      mode,
      priceOverride,
      currentPrice: d.meta.regularMarketPrice,
      previousClose: d.meta.previousClose,
      ...rec,
      ara,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
