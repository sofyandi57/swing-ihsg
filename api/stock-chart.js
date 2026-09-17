// api/stock-chart.js
// Vercel Serverless Function — proxy ke Invezgo multi-timeframe chart endpoint,
// dipakai untuk grafik OHLCV di tab Chart (dipakai user untuk baca candlestick
// sebelum ambil keputusan, bukan cuma lihat angka rasio volume).
//
// GET /api/stock-chart?code=BBCA&timeframe=15
//
// GET /api/stock-chart?code=BBCA&action=bandarmologi[&lookbackDays=180] — dipakai
// tab Bandarmologi baru. Gabungan 5 dimensi jejak broker/insider Invezgo untuk
// SATU kode saham (tidak ada versi Batch untuk endpoint-endpoint ini — lihat
// INVEZGO_BANDARMOLOGI_RESEARCH.md): Broker Summary Chart (D/F buy-sell),
// Stock Inventory Chart (+ ranking broker top net-buy/sell hasil olahan kita),
// Stock Distribution/Sankey Chart (crossing hari ini), Stock Momentum Chart
// (arus beli/jual intraday), tiga endpoint kepemilikan (>5%, >1%, insider
// IDX), dan tape reading: Order Book (bid/offer level 1 realtime), Order
// Queue (antrean di best bid/best offer — otomatis diambil dari harga Order
// Book, bukan input manual), dan Running Trade (time & sales/tape, 50
// transaksi terakhir hari ini). Tiap dimensi di-fetch independen — satu
// gagal tidak menggagalkan yang lain.
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
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const VALID_TIMEFRAMES = new Set(["1", "5", "15", "30", "60", "D", "W", "M"]);

// Rentang tanggal REQUEST jauh lebih pendek dari batas maksimal yang
// didokumentasikan Invezgo (1 menit boleh maks 3 bulan, dst) — data menit-per-
// menit riil biasanya cuma disimpan beberapa hari-minggu terakhir oleh
// provider data manapun, walau kuota API-nya mengizinkan rentang lebih jauh.
// Minta rentang sependek mungkin dulu supaya kemungkinan besar dapat data,
// bukan 204 kosong karena melampaui retensi riil.
const LOOKBACK_DAYS_BY_TIMEFRAME = {
  "1": 7,
  "5": 14,
  "15": 30,
  "30": 60,
  "60": 90,
  D: 365,
  W: 730,
  M: 730,
};

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// --- action=bandarmologi ----------------------------------------------
// Ditambahkan sebagai sub-resource di file INI (bukan file api/*.js baru)
// karena project sudah pas di batas 12 Serverless Function Vercel Hobby —
// lihat VERCEL_AGENT_SETUP.md. Menggabungkan 5 dimensi jejak broker/insider
// dari Invezgo untuk SATU kode saham (bukan screener massal — endpoint-
// endpoint ini tidak punya versi Batch, lihat INVEZGO_BANDARMOLOGI_RESEARCH.md).
// Tiap dimensi di-fetch independen (Promise.allSettled) — kalau satu gagal
// (402/rate limit/dsb), dimensi lain tetap tampil, bukan semua ikut gagal.
async function invezgoGetRaw(path, params = {}) {
  const url = new URL(INVEZGO_BASE_URL + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, v); });
  const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return resp.json();
}

// Ringkas array {broker, data:[{date, value}]} (Broker/Stock Inventory
// Chart) jadi ranking top net-buy/net-sell — dijumlah sepanjang rentang
// tanggal yang diminta, bukan cuma hari terakhir.
function rankBrokersFromInventory(brokerRows) {
  if (!Array.isArray(brokerRows)) return [];
  return brokerRows
    .map((b) => ({
      broker: b.broker || b.code || "?",
      netValue: (Array.isArray(b.data) ? b.data : []).reduce((sum, d) => sum + (Number(d.value) || 0), 0),
    }))
    .sort((a, b) => b.netValue - a.netValue);
}

// Total value gabungan SEMUA broker per bulan (YYYY-MM), dibandingkan
// dengan pergerakan harga di bulan yang sama — ini yang membedakan fase
// akumulasi/markup/distribusi/markdown ala Wyckoff dari sekadar "total 6
// bulan net-nya berapa": broker bisa net-buy di bulan 1-3 (akumulasi) lalu
// net-sell di bulan 4-6 (distribusi) walau totalnya kelihatan netral.
function monthlyFlowVsPrice(brokerRows, priceRows) {
  const flowByMonth = new Map();
  for (const b of Array.isArray(brokerRows) ? brokerRows : []) {
    for (const d of Array.isArray(b.data) ? b.data : []) {
      const month = String(d.date).slice(0, 7);
      flowByMonth.set(month, (flowByMonth.get(month) || 0) + (Number(d.value) || 0));
    }
  }

  const priceByMonth = new Map();
  for (const p of Array.isArray(priceRows) ? priceRows : []) {
    const month = String(p.date).slice(0, 7);
    if (!priceByMonth.has(month)) priceByMonth.set(month, { open: Number(p.close), close: Number(p.close) });
    priceByMonth.get(month).close = Number(p.close);
  }

  const months = [...new Set([...flowByMonth.keys(), ...priceByMonth.keys()])].sort();
  return months.map((month) => ({
    month,
    netBrokerValue: flowByMonth.get(month) || 0,
    priceOpen: priceByMonth.get(month)?.open ?? null,
    priceClose: priceByMonth.get(month)?.close ?? null,
    priceChangePct:
      priceByMonth.get(month)?.open && priceByMonth.get(month)?.close
        ? Number((((priceByMonth.get(month).close - priceByMonth.get(month).open) / priceByMonth.get(month).open) * 100).toFixed(2))
        : null,
  }));
}

async function handleBandarmologi(req, res) {
  const code = (req.query?.code || "").toUpperCase().trim();
  if (!code || !/^[A-Z0-9]{3,7}$/.test(code)) {
    res.status(400).json({ error: "Parameter 'code' wajib diisi dengan kode saham yang valid." });
    return;
  }

  const today = new Date();
  const todayStr = ymd(today);
  // Default 6 bulan (bukan 30 hari) — rentang pendek tidak cukup untuk baca
  // fase akumulasi/distribusi/markup/markdown ala Wyckoff, yang butuh
  // konteks broker berbulan-bulan, bukan cuma sebulan. Endpoint broker/
  // inventory Invezgo dibatasi 2 tahun untuk tier non-Enterprise (lihat
  // INVEZGO_BANDARMOLOGI_RESEARCH.md), jadi 180 hari masih jauh di bawahnya.
  const lookbackDays = Number(req.query?.lookbackDays) || 180;
  const from = ymd(new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000));

  const [summary, inventory, sankey, momentum, ownAbove, ownOne, ownInsider, orderBook, runningTrade] =
    await Promise.allSettled([
      invezgoGetRaw(`/analysis/summary-chart/stock/${code}`, { from, to: todayStr, scope: "value", market: "RG" }),
      invezgoGetRaw(`/analysis/inventory-chart/stock/${code}`, { from, to: todayStr, scope: "val", investor: "all", market: "ALL" }),
      invezgoGetRaw(`/analysis/sankey-chart/${code}`, { date: todayStr, type: "value", buyer: "ALL", seller: "ALL", market: "RG" }),
      invezgoGetRaw(`/analysis/momentum-chart/${code}`, { date: todayStr, range: "15", scope: "value" }),
      invezgoGetRaw(`/analysis/shareholder-above`, { code, from, to: todayStr, limit: 20 }),
      invezgoGetRaw(`/analysis/shareholder-one`, { code, from, to: todayStr, limit: 20 }),
      invezgoGetRaw(`/analysis/shareholder-insider`, { code, from, to: todayStr, limit: 20 }),
      invezgoGetRaw(`/analysis/order-book/${code}`, { market: "RG" }),
      invezgoGetRaw(`/analysis/running-trade/${code}`, { date: todayStr, page: 1, limit: 50, sort: "DESC", orderby: "TIME", market: "RG" }),
    ]);

  function pack(result) {
    if (result.status === "fulfilled") return { ok: true, data: result.value };
    return { ok: false, error: String(result.reason?.message || result.reason) };
  }

  const inventoryPacked = pack(inventory);
  const brokerRanking =
    inventoryPacked.ok && inventoryPacked.data?.broker ? rankBrokersFromInventory(inventoryPacked.data.broker) : [];
  const monthlyFlow = inventoryPacked.ok
    ? monthlyFlowVsPrice(inventoryPacked.data?.broker, inventoryPacked.data?.price)
    : [];

  const summaryPacked = pack(summary);
  const sankeyPacked = pack(sankey);
  const ownAbovePacked = pack(ownAbove);
  const ownOnePacked = pack(ownOne);
  const ownInsiderPacked = pack(ownInsider);
  const orderBookPacked = pack(orderBook);
  const runningTradePacked = pack(runningTrade);

  // Order Queue butuh price+side spesifik — otomatis diarahkan ke best
  // bid/offer dari Order Book di atas (antrean paling depan, paling relevan
  // untuk tape reading), bukan dipanggil dulu terpisah tanpa konteks harga.
  let queueBuy = { ok: false, error: "Order Book tidak tersedia — tidak bisa tentukan harga antrean." };
  let queueSell = { ok: false, error: "Order Book tidak tersedia — tidak bisa tentukan harga antrean." };
  if (orderBookPacked.ok) {
    const bestBid = orderBookPacked.data?.bid?.[0]?.bid1price;
    const bestOffer = orderBookPacked.data?.offer?.[0]?.offer1price;
    const [qb, qs] = await Promise.allSettled([
      bestBid ? invezgoGetRaw(`/analysis/queue/${code}`, { price: bestBid, side: "BUY", limit: 20 }) : Promise.reject(new Error("Tidak ada best bid.")),
      bestOffer ? invezgoGetRaw(`/analysis/queue/${code}`, { price: bestOffer, side: "SELL", limit: 20 }) : Promise.reject(new Error("Tidak ada best offer.")),
    ]);
    queueBuy = { ...pack(qb), price: bestBid };
    queueSell = { ...pack(qs), price: bestOffer };
  }

  const narrative = await generateBandarmologiNarrative({
    code,
    from,
    to: todayStr,
    summary: summaryPacked.ok ? summaryPacked.data : null,
    brokerRanking,
    monthlyFlow,
    sankey: sankeyPacked.ok ? sankeyPacked.data?.links : null,
    ownershipAbove: ownAbovePacked.ok ? ownAbovePacked.data?.data : null,
    ownershipOne: ownOnePacked.ok ? ownOnePacked.data?.data : null,
    ownershipInsider: ownInsiderPacked.ok ? ownInsiderPacked.data?.data : null,
    orderBook: orderBookPacked.ok ? orderBookPacked.data : null,
    runningTrade: runningTradePacked.ok ? runningTradePacked.data?.data?.slice(0, 20) : null,
    monthlyFlow,
  });

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    code,
    from,
    to: todayStr,
    narrative,
    summaryChart: summaryPacked,
    inventoryChart: inventoryPacked,
    brokerRanking,
    monthlyFlow,
    sankeyChart: sankeyPacked,
    momentumChart: pack(momentum),
    ownershipAbove: ownAbovePacked,
    ownershipOne: ownOnePacked,
    ownershipInsider: ownInsiderPacked,
    orderBook: orderBookPacked,
    runningTrade: runningTradePacked,
    queueBuy,
    queueSell,
  });
}

// Lapisan interpretasi — TANPA ini, tab Bandarmologi cuma dump tabel angka
// mentah (keluhan User: "tidak sekelas skill analisa transaksi", yang memang
// selalu menyimpulkan naratif, bukan cuma menyajikan angka). Pola sama persis
// dengan api/scan-insight.js: best-effort, gagal/GROQ_API_KEY kosong TIDAK
// menggagalkan seluruh response — cuma narrative jadi string kosong.
async function generateBandarmologiNarrative(ctx) {
  if (!GROQ_API_KEY) return { text: "", skipped: true, reason: "GROQ_API_KEY belum diset." };

  const topBuy = ctx.brokerRanking.slice(0, 5);
  const topSell = [...ctx.brokerRanking].reverse().slice(0, 5);
  const topCrossing = Array.isArray(ctx.sankey) ? [...ctx.sankey].sort((a, b) => b.value - a.value).slice(0, 5) : [];
  const ownershipChanges = [
    ...(ctx.ownershipAbove || []).slice(0, 5).map((r) => ({ ...r, tier: ">5%" })),
    ...(ctx.ownershipOne || []).slice(0, 5).map((r) => ({ ...r, tier: ">1%" })),
    ...(ctx.ownershipInsider || []).slice(0, 5).map((r) => ({ ...r, tier: "insider" })),
  ];

  const payload = {
    kode: ctx.code,
    periode: `${ctx.from} s/d ${ctx.to}`,
    trenNetBrokerPerBulanVsHarga: ctx.monthlyFlow,
    ringkasanBuySellDF: ctx.summary,
    topBrokerAkumulasi: topBuy,
    topBrokerDistribusi: topSell,
    crossingBrokerHariIni: topCrossing,
    perubahanKepemilikan: ownershipChanges,
    orderBookTerkini: ctx.orderBook,
    tapeTerakhir: ctx.runningTrade,
  };

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content:
              "Anda analis bandarmologi pasar saham Indonesia (IDX/BEI), paham kerangka fase Wyckoff " +
              "(akumulasi/markup/distribusi/markdown). Diberi data jejak broker (tren net broker PER " +
              "BULAN dibandingkan pergerakan harga bulan yang sama selama ~6 bulan terakhir, ranking " +
              "akumulasi/distribusi broker, crossing antar-broker hari ini, perubahan kepemilikan " +
              ">5%/>1%/insider, order book bid/offer terkini, dan tape/running-trade transaksi " +
              "terakhir) untuk SATU saham, buat kesimpulan naratif 5-7 kalimat dalam Bahasa Indonesia: " +
              "(1) dari tren bulanan, identifikasi fase saat ini — akumulasi (net broker positif, harga " +
              "sideways/turun), markup (net broker positif, harga naik), distribusi (net broker " +
              "negatif, harga sideways/naik), atau markdown (net broker negatif, harga turun) — sebutkan " +
              "kapan pergantian fase terjadi kalau terlihat, (2) broker mana yang paling dominan di fase " +
              "TERKINI (bukan total 6 bulan) dan apakah konsisten, (3) apakah crossing hari ini dan " +
              "perubahan kepemilikan MENDUKUNG atau BERTENTANGAN dengan fase di atas (validasi silang), " +
              "(4) dari tape/order book: tekanan beli/jual dominan di harga terkini dan apakah searah " +
              "dengan fase yang teridentifikasi. Kalau data kosong/tidak cukup di suatu dimensi (misal " +
              "kurang dari 6 bulan data), sebutkan itu jujur, jangan mengarang atau memaksakan fase. " +
              "JANGAN memberi saran beli/jual eksplisit — ini alat bantu baca data, bukan rekomendasi " +
              "transaksi. Gaya bahasa ringkas seperti catatan analis ke rekan kerja.",
          },
          { role: "user", content: JSON.stringify(payload) },
        ],
        temperature: 0.4,
      }),
    });

    if (!resp.ok) return { text: "", skipped: true, reason: `Groq HTTP ${resp.status}` };

    const json = await resp.json();
    const text = json.choices?.[0]?.message?.content?.trim() || "";
    return { text, skipped: false };
  } catch (e) {
    return { text: "", skipped: true, reason: String(e.message || e) };
  }
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }

  if (req.query?.action === "bandarmologi") {
    try {
      await handleBandarmologi(req, res);
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
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
      const isIntraday = timeframe !== "D" && timeframe !== "W" && timeframe !== "M";
      res.status(200).json({
        code,
        timeframe,
        candles: [],
        note: isIntraday
          ? "Data tidak tersedia untuk kombinasi kode/timeframe/periode ini — untuk timeframe menit-per-menit, kemungkinan data historis sudah tidak tersimpan sejauh itu, atau paket API Invezgo Anda tidak termasuk data intraday (butuh tier 'Advance')."
          : "Data tidak tersedia untuk kode/periode ini.",
      });
      return;
    }
    if (resp.status === 401) throw new Error("401: API key tidak valid.");
    if (resp.status === 402) throw new Error("402: Paket API Invezgo Anda tidak termasuk data multi-timeframe intraday — butuh tier 'Advance'. Cek di dashboard Invezgo Anda.");
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
