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
// POST body: { rows: [{ code, volumeRatio, value, priceChangePct,
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
              `screening dengan metrik: volumeRatio (lonjakan volume vs kemarin), value (nilai ` +
              `transaksi hari ini, proxy likuiditas), priceChangePct, freq (frekuensi transaksi ` +
              `hari ini — makin tinggi makin banyak trader terlibat, bukan cuma 1-2 order besar), ` +
              `spreadPct (selisih bid-offer terhadap harga, makin besar makin ILIKUID/BERISIKO ` +
              `untuk keluar-masuk posisi), imbalance (positif = minat beli lebih besar dari jual). ` +
              `Pilih maksimal ${n} saham PALING MENARIK berdasarkan kombinasi: volume spike tinggi, ` +
              `frekuensi tinggi (partisipasi luas, bukan cuma 1-2 order), value cukup besar ` +
              `(likuid), DAN risiko wajar (spread tidak terlalu lebar). Beri alasan 1 kalimat per ` +
              `pilihan DAN catatan risiko 1 kalimat (kalau ada, misal spread lebar/freq rendah). ` +
              `JANGAN merekomendasikan beli/jual eksplisit — ini alat bantu prioritas baca data.`,
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
  maxDuration: 45,
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
      volumeRatio: r.volumeRatio ?? null,
      value: r.value ?? null,
      priceChangePct: r.priceChangePct ?? null,
      volRatio3v20: r.volRatio3v20 ?? null,
      freq: snap.freq ?? null,
      spreadPct: snap.spreadPct ?? null,
      imbalance: snap.imbalance ?? null,
    };
  });

  const groqResult = await askGroq(enrichedRows);

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    enrichedRows,
    picks: groqResult.picks,
    groqUsed: !groqResult.skipped,
    groqSkipReason: groqResult.skipped ? groqResult.reason : undefined,
  });
}
