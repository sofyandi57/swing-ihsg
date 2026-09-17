import { useState } from "react";

function formatNumber(n) {
  return new Intl.NumberFormat("id-ID").format(Math.round(n));
}

function ResultCard({ row }) {
  const isUp = row.priceChangePct >= 0;
  return (
    <div className="result-card">
      <div className="result-card-top">
        <span className="result-code">{row.code}</span>
        <span className="ratio-pill">{row.volumeRatio.toFixed(2)}x</span>
      </div>
      <div className="result-grid">
        <div className="result-metric">
          <span className="result-metric-label">Price</span>
          <span className="result-metric-value">{formatNumber(row.price)}</span>
        </div>
        <div className="result-metric">
          <span className="result-metric-label">Change</span>
          <span className={`result-metric-value ${isUp ? "up" : "down"}`}>
            {isUp ? "+" : ""}
            {row.priceChangePct.toFixed(2)}%
          </span>
        </div>
        <div className="result-metric">
          <span className="result-metric-label">Volume</span>
          <span className="result-metric-value">{formatNumber(row.volume)}</span>
        </div>
        <div className="result-metric">
          <span className="result-metric-label">Prev Price</span>
          <span className="result-metric-value">{formatNumber(row.prevPrice)}</span>
        </div>
        <div className="result-metric">
          <span className="result-metric-label">Prev Volume</span>
          <span className="result-metric-value">{formatNumber(row.prevVolume)}</span>
        </div>
      </div>
    </div>
  );
}

export default function ScanTab() {
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [insight, setInsight] = useState("");
  const [insightStatus, setInsightStatus] = useState("idle"); // idle | loading | done | error

  async function fetchInsight(scanPayload) {
    setInsightStatus("loading");
    setInsight("");
    try {
      const resp = await fetch("/api/scan-insight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scanPayload),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setInsight(json.insight || "");
      setInsightStatus(json.insight ? "done" : "error");
    } catch (e) {
      setInsightStatus("error");
    }
  }

  async function runScan() {
    setStatus("loading");
    setError("");
    setInsight("");
    setInsightStatus("idle");

    try {
      const resp = await fetch("/api/screener");
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      setResults(json.data || []);
      setMeta(json);
      setStatus("done");

      if ((json.data || []).length > 0) {
        fetchInsight({
          scannedAt: json.scannedAt,
          totalScanned: json.totalScanned,
          data: json.data,
        });
      }
    } catch (e) {
      setStatus("error");
      setError(e.message);
    }
  }

  return (
    <>
      <div className="card">
        <h2>⚡ One-Button Scalping Scan</h2>
        <p className="sub">
          Pindai ~900 saham BEI, cari lonjakan volume ≥3x. Proses ini memanggil
          Invezgo API satu per satu dengan concurrency terbatas — bisa memakan
          waktu 30 detik sampai 2 menit.
        </p>
        <button className="btn btn-primary btn-block" onClick={runScan} disabled={status === "loading"}>
          {status === "loading" ? "⏳ Memindai..." : "▶ Run Scan"}
        </button>
      </div>

      {meta && status !== "loading" && (
        <div className="meta-text">
          Terakhir dipindai: {new Date(meta.scannedAt).toLocaleTimeString("id-ID")} ·{" "}
          {meta.totalScanned} saham dicek · {results.length} lolos filter · durasi{" "}
          {(meta.durationMs / 1000).toFixed(1)}s ·{" "}
          {meta.saved ? "✓ tersimpan ke histori" : `⚠ tidak tersimpan (${meta.saveError || "?"})`}
        </div>
      )}

      {error && <div className="error-box">Gagal menjalankan scan: {error}</div>}

      {status === "loading" && (
        <div className="state-box">
          <div className="spinner" />
          Memindai saham... jangan tutup tab.
        </div>
      )}

      {status === "done" && results.length === 0 && (
        <div className="state-box">Tidak ada saham yang memenuhi kriteria saat ini.</div>
      )}

      {(insightStatus === "loading" || insight) && (
        <div className="insight-box">
          <div className="insight-label">🤖 AI Insight</div>
          {insightStatus === "loading" ? "Meracik insight dari hasil scan..." : insight}
        </div>
      )}

      {status === "done" && results.length > 0 && (
        <div className="result-list">
          {results.map((row) => (
            <ResultCard key={row.code} row={row} />
          ))}
        </div>
      )}
    </>
  );
}
