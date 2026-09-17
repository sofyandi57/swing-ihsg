// api/scan-insight.js
// Vercel Serverless Function — terima hasil scan (dari respons api/screener.js di
// browser, TIDAK query ulang ke Supabase/Invezgo) dan minta Groq membuat ringkasan
// naratif singkat: pola apa yang menonjol hari ini, saham mana yang paling ekstrem
// rasionya, dsb. Murni lapisan penyajian di atas data yang sudah ada — tidak
// menyimpan apa pun, tidak mengubah data scan.
//
// POST body: { scannedAt, totalScanned, data: [...] } — bentuk sama seperti respons
// api/screener.js (field `data`).

import { requireUser } from "./_lib/auth.js";

const GROQ_API_KEY = process.env.GROQ_API_KEY;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method tidak didukung. Gunakan POST." });
    return;
  }

  if (!GROQ_API_KEY) {
    res.status(200).json({ insight: "", skipped: true, reason: "GROQ_API_KEY belum diset." });
    return;
  }

  const { data, totalScanned } = req.body || {};
  if (!Array.isArray(data) || data.length === 0) {
    res.status(200).json({ insight: "", skipped: true, reason: "Tidak ada hasil scan untuk dianalisis." });
    return;
  }

  // Kirim hanya field yang relevan, top 15 saja — cukup untuk konteks narasi,
  // tidak perlu kirim seluruh 25 baris kalau memang lolos filter banyak.
  const top = data.slice(0, 15).map((r) => ({
    code: r.code,
    volumeRatio: Number(r.volumeRatio.toFixed(2)),
    priceChangePct: Number(r.priceChangePct.toFixed(2)),
    price: r.price,
  }));

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
              "Anda analis pasar saham Indonesia (IDX/BEI). Diberi hasil screening volume " +
              "scalping (saham dengan lonjakan volume >=3x), buat ringkasan singkat 2-4 kalimat " +
              "dalam Bahasa Indonesia: pola yang menonjol (misal banyak saham sektor tertentu, " +
              "rasio volume ekstrem, kombinasi volume tinggi + harga naik/turun tajam). Sebutkan " +
              "maksimal 3-4 kode saham paling menonjol dengan alasan singkat. JANGAN memberi saran " +
              "beli/jual eksplisit — ini alat bantu baca data, bukan rekomendasi transaksi. Gaya " +
              "bahasa ringkas, seperti catatan analis ke rekan kerja, bukan laporan formal.",
          },
          {
            role: "user",
            content: `Total saham dipindai: ${totalScanned}. Saham yang lolos filter volume>=3x (diurutkan rasio tertinggi):\n${JSON.stringify(top)}`,
          },
        ],
        temperature: 0.4,
      }),
    });

    if (!resp.ok) {
      res.status(200).json({ insight: "", skipped: true, reason: `Groq HTTP ${resp.status}` });
      return;
    }

    const json = await resp.json();
    const text = json.choices?.[0]?.message?.content?.trim() || "";
    res.status(200).json({ insight: text, skipped: false });
  } catch (e) {
    res.status(200).json({ insight: "", skipped: true, reason: String(e.message || e) });
  }
}
