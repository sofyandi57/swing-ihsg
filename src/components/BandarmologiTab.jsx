import { useEffect, useRef, useState } from "react";
import { createChart } from "lightweight-charts";
import { authFetch } from "../lib/supabaseClient.js";

function toUnixTime(dateStr) {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

// Sama persis dengan ChartTab.jsx — swing high/low dari 80 candle terakhir,
// dipakai untuk garis Support/Resistance di candlestick Laporan Lengkap.
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
  return { nearestSupport: supports[0] ?? null, nearestResistance: resistances[0] ?? null };
}

function fmtNum(n) {
  if (n === null || n === undefined || n === "") return "-";
  const num = Number(n);
  if (!Number.isFinite(num)) return "-";
  if (Math.abs(num) >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}M`;
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}jt`;
  return num.toLocaleString("id-ID");
}

function ErrorNote({ section }) {
  if (section.ok) return null;
  return <div className="bdm-empty">Tidak tersedia: {section.error}</div>;
}

// Bar chart horizontal generik — dipakai di semua section supaya konsisten,
// panjang bar proporsional terhadap nilai maksimum absolut di dataset yang
// sama (bukan skala tetap), jadi baik dataset kecil maupun besar tetap
// terbaca.
function BarChart({ items, colorFor }) {
  if (!items || items.length === 0) return null;
  const maxAbs = Math.max(...items.map((it) => Math.abs(it.value)), 1);
  return (
    <div className="bdm-barchart">
      {items.map((it, i) => (
        <div key={i} className="bdm-bar-row">
          <div className="bdm-bar-label">{it.label}</div>
          <div className="bdm-bar-track">
            <div
              className="bdm-bar-fill"
              style={{
                width: `${Math.min(100, (Math.abs(it.value) / maxAbs) * 100)}%`,
                background: colorFor ? colorFor(it) : "#3fb950",
              }}
            />
          </div>
          <div className="bdm-bar-value">{fmtNum(it.value)}</div>
        </div>
      ))}
    </div>
  );
}

function NarrativePanel({ narrative }) {
  if (!narrative) return null;
  if (narrative.skipped || !narrative.text) {
    return (
      <div className="bdm-empty">
        Narasi AI tidak tersedia{narrative.reason ? ` (${narrative.reason})` : ""} — data mentah tetap
        ditampilkan di bawah.
      </div>
    );
  }
  return <div className="bdm-narrative">🧠 {narrative.text}</div>;
}

function SummarySection({ section }) {
  if (!section.ok || !Array.isArray(section.data)) return <ErrorNote section={section} />;
  const items = section.data.map((row) => ({ label: row.label, value: Number(row.value) || 0 }));
  const colorFor = (it) => {
    const isBuy = it.label.includes("Buy");
    const isForeign = it.label.startsWith("F");
    return isBuy ? (isForeign ? "#8b5cf6" : "#22c55e") : isForeign ? "#c026d3" : "#ef4444";
  };
  return <BarChart items={items} colorFor={colorFor} />;
}

function BrokerRankingSection({ inventorySection, ranking }) {
  if (!inventorySection.ok) return <ErrorNote section={inventorySection} />;
  if (!ranking || ranking.length === 0) return <div className="bdm-empty">Tidak ada data broker.</div>;
  const topBuy = ranking.slice(0, 5).map((b) => ({ label: b.broker, value: b.netValue }));
  const topSell = [...ranking]
    .reverse()
    .slice(0, 5)
    .map((b) => ({ label: b.broker, value: b.netValue }));
  return (
    <div className="bdm-two-col">
      <div>
        <div className="bdm-subtitle">TOP AKUMULASI</div>
        <BarChart items={topBuy} colorFor={() => "#22c55e"} />
      </div>
      <div>
        <div className="bdm-subtitle">TOP DISTRIBUSI</div>
        <BarChart items={topSell} colorFor={() => "#ef4444"} />
      </div>
    </div>
  );
}

function SankeySection({ section }) {
  if (!section.ok) return <ErrorNote section={section} />;
  const links = section.data?.links || [];
  if (links.length === 0) return <div className="bdm-empty">Tidak ada crossing broker hari ini.</div>;
  const items = [...links]
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map((l) => ({ label: `${(l.source || "").trim()} → ${(l.target || "").trim()}`, value: l.value }));
  return <BarChart items={items} colorFor={() => "#f59e0b"} />;
}

function MomentumSection({ section }) {
  if (!section.ok || !Array.isArray(section.data)) return <ErrorNote section={section} />;
  const rows = section.data.filter((r) => r.buy_lot || r.sell_lot).slice(0, 10);
  if (rows.length === 0) return <div className="bdm-empty">Belum ada aktivitas signifikan hari ini.</div>;
  const items = rows.flatMap((r) => [
    { label: `${r.time} Buy`, value: Number(r.buy_lot) || 0, group: "buy" },
    { label: `${r.time} Sell`, value: Number(r.sell_lot) || 0, group: "sell" },
  ]);
  return <BarChart items={items} colorFor={(it) => (it.group === "buy" ? "#22c55e" : "#ef4444")} />;
}

function OwnershipTable({ section, columns }) {
  if (!section.ok) return <ErrorNote section={section} />;
  const rows = section.data?.data || [];
  if (rows.length === 0) return <div className="bdm-empty">Tidak ada perubahan kepemilikan pada rentang ini.</div>;
  return (
    <div className="bdm-table-wrap">
      <table className="bdm-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 15).map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key}>{c.format ? c.format(row[c.key]) : row[c.key] ?? "-"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Candlestick 1 tahun + garis S/R, dirender di dalam Laporan Lengkap — sama
// persis library & pola visual dengan ChartTab.jsx (lightweight-charts),
// supaya identitas visual chart konsisten di seluruh app.
function ReportCandleChart({ candles }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !candles || candles.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#8b909c", fontSize: 11 },
      grid: { vertLines: { color: "#1b1e24" }, horzLines: { color: "#1b1e24" } },
      rightPriceScale: { borderColor: "#262930" },
      timeScale: { borderColor: "#262930", timeVisible: false },
      height: 320,
      autoSize: true,
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    const volumeSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "volume" });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    const candleData = candles.map((c) => ({ time: toUnixTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }));
    const volumeData = candles.map((c) => ({
      time: toUnixTime(c.time),
      value: c.volume,
      color: c.close >= c.open ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)",
    }));
    candleSeries.setData(candleData);
    volumeSeries.setData(volumeData);

    const currentPrice = candles[candles.length - 1].close;
    const { nearestSupport, nearestResistance } = findSupportResistance(candles, currentPrice);
    if (nearestSupport) {
      candleSeries.createPriceLine({ price: nearestSupport, color: "#22c55e", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "Support" });
    }
    if (nearestResistance) {
      candleSeries.createPriceLine({ price: nearestResistance, color: "#ef4444", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "Resistance" });
    }

    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [candles]);

  if (!candles || candles.length === 0) return <div className="bdm-empty">Data candlestick tidak tersedia.</div>;
  return <div ref={containerRef} style={{ width: "100%", height: 320 }} />;
}

export default function BandarmologiTab() {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [candles, setCandles] = useState(null);

  async function runAnalysis() {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setStatus("loading");
    setError("");
    setResult(null);
    setCandles(null);
    try {
      const [bdmResp, chartResp] = await Promise.all([
        authFetch(`/api/stock-chart?action=bandarmologi&code=${encodeURIComponent(trimmed)}`),
        authFetch(`/api/stock-chart?code=${encodeURIComponent(trimmed)}&timeframe=D`),
      ]);
      const bdmJson = await bdmResp.json();
      if (!bdmResp.ok) throw new Error(bdmJson.error || `HTTP ${bdmResp.status}`);
      setResult(bdmJson);

      const chartJson = await chartResp.json().catch(() => null);
      if (chartResp.ok && chartJson?.candles) setCandles(chartJson.candles);

      setStatus("done");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <div className="card">
        <h2>🕵️ Bandarmologi</h2>
        <p className="sub">
          Jejak broker per saham: siapa akumulasi/distribusi, broker mana crossing hari ini, arus beli/jual
          intraday, dan perubahan kepemilikan &gt;5%/&gt;1%/insider — dengan kesimpulan naratif AI, bukan
          cuma tabel angka. Per-kode (bukan screener massal — Invezgo tidak menyediakan versi batch untuk
          data broker/insider).
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            style={{ minHeight: 44 }}
            placeholder="Kode saham, contoh: BBCA"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runAnalysis()}
          />
          <button className="btn btn-primary" onClick={runAnalysis} disabled={status === "loading" || !code.trim()}>
            {status === "loading" ? "⏳" : "Analisa"}
          </button>
        </div>
        {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {result && (
        <div className="bdm-report">
          <div className="bdm-report-header">
            <div>
              <div className="bdm-report-title">Laporan Bandarmologi — {result.code}</div>
              <div className="bdm-report-meta">
                Periode data broker: {result.from} s/d {result.to} · Dibuat {new Date().toLocaleString("id-ID")}
              </div>
            </div>
          </div>

          <div className="bdm-report-section">
            <h3>📈 Candlestick 1 Tahun + Support/Resistance</h3>
            <ReportCandleChart candles={candles} />
          </div>

          <div className="bdm-report-section bdm-narrative-card">
            <h3>🧠 Struktur &amp; Kesimpulan</h3>
            <NarrativePanel narrative={result.narrative} />
          </div>

          <div className="bdm-report-section">
            <h3>📊 Broker Summary (Institusi vs Ritel)</h3>
            <SummarySection section={result.summaryChart} />
          </div>

          <div className="bdm-report-section">
            <h3>🏆 Ranking Broker (Top Buy vs Top Sell)</h3>
            <BrokerRankingSection inventorySection={result.inventoryChart} ranking={result.brokerRanking} />
          </div>

          <div className="bdm-report-section">
            <h3>🔀 Crossing Broker Hari Ini</h3>
            <SankeySection section={result.sankeyChart} />
          </div>

          <div className="bdm-report-section">
            <h3>⚡ Arus Beli/Jual Intraday</h3>
            <MomentumSection section={result.momentumChart} />
          </div>

          <div className="bdm-report-section">
            <h3>👥 Kepemilikan &gt;5%</h3>
            <OwnershipTable
              section={result.ownershipAbove}
              columns={[
                { key: "date", label: "Tanggal", format: (v) => (v ? v.slice(0, 10) : "-") },
                { key: "name", label: "Nama" },
                { key: "next_pct", label: "%", format: (v) => (v != null ? `${Number(v).toFixed(2)}%` : "-") },
                { key: "change", label: "Perubahan Lembar", format: fmtNum },
                { key: "nationality", label: "Asal" },
              ]}
            />
          </div>

          <div className="bdm-report-section">
            <h3>👤 Kepemilikan &gt;1%</h3>
            <OwnershipTable
              section={result.ownershipOne}
              columns={[
                { key: "date", label: "Tanggal", format: (v) => (v ? v.slice(0, 10) : "-") },
                { key: "name", label: "Nama" },
                { key: "next_pct", label: "%", format: (v) => (v != null ? `${Number(v).toFixed(2)}%` : "-") },
                { key: "status", label: "Status" },
              ]}
            />
          </div>

          <div className="bdm-report-section">
            <h3>🧑‍💼 Insider (Direksi/Komisaris/Pengendali)</h3>
            <OwnershipTable
              section={result.ownershipInsider}
              columns={[
                { key: "date", label: "Tanggal", format: (v) => (v ? v.slice(0, 10) : "-") },
                { key: "name", label: "Nama" },
                { key: "badge", label: "Jabatan" },
                { key: "change", label: "Perubahan %", format: (v) => (v != null ? `${Number(v).toFixed(2)}%` : "-") },
                { key: "purpose", label: "Tujuan" },
              ]}
            />
          </div>

          <div className="bdm-report-footer">
            📖 Laporan ini alat bantu baca data (reader/edukasi), BUKAN ajakan atau rekomendasi
            transaksi. Keputusan beli/jual sepenuhnya tanggung jawab pengguna.
          </div>
        </div>
      )}
    </div>
  );
}
