// api/check-stock.js
// Vercel Serverless Function — cek volume ratio SATU saham saja (bukan scan 900
// saham penuh). Dipakai oleh tombol "Cek Scan Sekarang" di hasil cross-check mentor,
// supaya bisa cek cepat tanpa menunggu full scan 30 detik - 2 menit.
//
// GET /api/check-stock?code=BBCA

const INVEZGO_BASE_URL = "https://api.invezgo.com";
const API_KEY = process.env.INVEZGO_API_KEY;

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }

  const code = (req.query && req.query.code || "").toUpperCase().trim();
  if (!code || !/^[A-Z]{4,6}$/.test(code)) {
    res.status(400).json({ error: "Parameter 'code' wajib diisi dengan kode saham valid (4-6 huruf)." });
    return;
  }

  const to = new Date();
  const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000); // buffer 10 hari

  try {
    const url = new URL(`${INVEZGO_BASE_URL}/analysis/chart/stock/${code}`);
    url.searchParams.set("from", ymd(from));
    url.searchParams.set("to", ymd(to));

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (resp.status === 404) {
      res.status(200).json({ result: null, note: "Kode saham tidak ditemukan." });
      return;
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }

    const chart = await resp.json();
    if (!Array.isArray(chart) || chart.length < 2) {
      res.status(200).json({ result: null, note: "Data tidak cukup (kurang dari 2 hari perdagangan)." });
      return;
    }

    const rows = [...chart].sort((a, b) => new Date(a.date) - new Date(b.date));
    const todayRow = rows[rows.length - 1];
    const prevRow = rows[rows.length - 2];

    const volume = Number(todayRow.volume); // volume dari Invezgo adalah string
    const prevVolume = Number(prevRow.volume);
    const price = Number(todayRow.close);
    const prevPrice = Number(prevRow.close);

    if (!prevVolume) {
      res.status(200).json({ result: null, note: "Previous volume nol, tidak bisa hitung rasio." });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      result: {
        code,
        volume,
        prevVolume,
        volumeRatio: volume / prevVolume,
        price,
        prevPrice,
        priceChangePct: ((price - prevPrice) / prevPrice) * 100,
        asOfDate: todayRow.date,
      },
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
