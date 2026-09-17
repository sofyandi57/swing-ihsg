import { useEffect, useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";

const MODES = [
  { id: "scalping", label: "Scalping", desc: "Menit-jam" },
  { id: "intraday", label: "Intraday", desc: "Hari ini" },
  { id: "swing", label: "Swing", desc: "2-4 minggu" },
  { id: "dividen", label: "Dividen", desc: "3-12 bulan" },
];

const CLS_COLOR = {
  buy: { bg: "var(--green-bg)", fg: "var(--green)" },
  hold: { bg: "var(--panel-2)", fg: "var(--muted)" },
  sell: { bg: "var(--red-bg)", fg: "var(--red)" },
};

function formatNumber(n) {
  if (n == null) return "—";
  return new Intl.NumberFormat("id-ID").format(Math.round(n));
}

function SigItem({ sig }) {
  const icon = sig.b === true ? "✓" : sig.b === false ? "✗" : "•";
  const cls = sig.b === true ? "cross-hit" : sig.b === false ? "cross-miss" : "sub";
  return <div className={cls}>{icon} {sig.t}</div>;
}

export default function DashboardTab() {
  const [inputValue, setInputValue] = useState("");
  const [code, setCode] = useState("BBCA");
  const [mode, setMode] = useState("swing");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const [priceOverride, setPriceOverride] = useState("");
  const [overrideActive, setOverrideActive] = useState(null);
  const [watchlist, setWatchlist] = useState([]);

  // Ambil watchlist gabungan (PDF/mentor/manual) supaya bisa langsung klik pilih
  // simbol untuk dianalisa, reuse endpoint yang sama dengan tab Watchlist.
  useEffect(() => {
    (async () => {
      try {
        const resp = await authFetch("/api/pdf-watchlist");
        const json = await resp.json();
        if (resp.ok) setWatchlist(json.items || []);
      } catch (e) {
        // Diamkan — watchlist di tab Conviction cuma shortcut, bukan fitur inti
      }
    })();
  }, []);

  async function runAnalysis(symbolCode, symbolMode, override) {
    setStatus("loading");
    setError("");
    try {
      const params = new URLSearchParams({ code: symbolCode, mode: symbolMode });
      if (override) params.set("priceOverride", override);
      const resp = await authFetch(`/api/dashboard?${params.toString()}`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      if (json.error) {
        setError(json.error);
        setStatus("error");
        return;
      }
      setResult(json);
      setStatus("done");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  function selectFromWatchlist(watchCode) {
    setInputValue(watchCode);
    setCode(watchCode);
    setOverrideActive(null);
    setPriceOverride("");
    runAnalysis(watchCode, mode, null);
  }

  function handleSearch(e) {
    e.preventDefault();
    const trimmed = inputValue.trim().toUpperCase();
    if (!trimmed) return;
    setCode(trimmed);
    setOverrideActive(null);
    setPriceOverride("");
    runAnalysis(trimmed, mode, null);
  }

  function handleModeChange(m) {
    setMode(m);
    runAnalysis(code, m, overrideActive);
  }

  function applyOverride() {
    const v = Number(priceOverride);
    if (!v || v <= 0) return;
    setOverrideActive(v);
    runAnalysis(code, mode, v);
  }

  function clearOverride() {
    setOverrideActive(null);
    setPriceOverride("");
    runAnalysis(code, mode, null);
  }

  const colors = result ? CLS_COLOR[result.cls] : null;

  return (
    <>
      <div className="card">
        <h2>🧭 Conviction — IDX Advisor</h2>
        <p className="sub">
          Skor komposit 6 kategori (tren, momentum, mean-reversion, volume, pola,
          mikrostruktur) dari data OHLCV Invezgo. Alat bantu baca data, bukan
          rekomendasi transaksi.
        </p>
        <form onSubmit={handleSearch} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            className="input"
            style={{ minHeight: 44, flex: 1 }}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Kode saham, misal BBCA"
          />
          <button className="btn btn-primary" type="submit" style={{ minHeight: 44 }}>
            Analisa
          </button>
        </form>

        {watchlist.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {watchlist.map((item) => (
              <button
                key={item.code}
                className="code-tag"
                style={{
                  border: "none",
                  cursor: "pointer",
                  background: item.code === code ? "var(--accent)" : "var(--accent-bg)",
                  color: item.code === code ? "#fff" : "var(--accent)",
                }}
                onClick={() => selectFromWatchlist(item.code)}
                disabled={status === "loading"}
                title="Watchlist"
              >
                {item.code}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {MODES.map((m) => (
            <button
              key={m.id}
              className="btn btn-ghost"
              style={{
                background: mode === m.id ? "var(--accent-bg)" : "var(--panel-2)",
                color: mode === m.id ? "var(--accent)" : "var(--text)",
                borderColor: mode === m.id ? "var(--accent)" : "var(--border)",
              }}
              onClick={() => handleModeChange(m.id)}
              disabled={status === "loading"}
            >
              {m.label} <span style={{ opacity: 0.7, fontSize: 10 }}>({m.desc})</span>
            </button>
          ))}
        </div>
      </div>

      {status === "loading" && (
        <div className="state-box">
          <div className="spinner" />
          Menghitung skor...
        </div>
      )}

      {error && <div className="error-box">{error}</div>}

      {status === "done" && result && (
        <>
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div>
                <span className="result-code" style={{ fontSize: 18 }}>{result.code}</span>
                <div className="sub" style={{ marginBottom: 0 }}>
                  Harga: {formatNumber(result.currentPrice)}
                  {overrideActive && (
                    <>
                      {" "}
                      <span
                        style={{ color: "var(--accent)", cursor: "pointer" }}
                        onClick={clearOverride}
                        title="Klik untuk hapus override"
                      >
                        ✏️ Override: {formatNumber(overrideActive)} ✕
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div
                style={{
                  background: colors.bg,
                  color: colors.fg,
                  padding: "8px 14px",
                  borderRadius: 10,
                  textAlign: "center",
                  fontWeight: 800,
                  fontSize: 13,
                }}
              >
                {result.action}
                <div style={{ fontSize: 10, fontWeight: 600, opacity: 0.85 }}>
                  Skor {result.sc.toFixed(2)} · {result.strength}
                </div>
              </div>
            </div>

            <p className="sub">{result.desc}</p>

            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input
                className="input"
                style={{ minHeight: 36, flex: 1 }}
                type="number"
                placeholder="Override harga manual (opsional)"
                value={priceOverride}
                onChange={(e) => setPriceOverride(e.target.value)}
              />
              <button className="btn btn-ghost" onClick={applyOverride}>Terapkan</button>
            </div>

            <div className="result-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 4 }}>
              <div className="result-metric">
                <span className="result-metric-label">Confidence</span>
                <span className="result-metric-value">{result.conf}%</span>
              </div>
              <div className="result-metric">
                <span className="result-metric-label">Horizon</span>
                <span className="result-metric-value">{result.hor}</span>
              </div>
              <div className="result-metric">
                <span className="result-metric-label">RSI14</span>
                <span className="result-metric-value">{result.rsiV ? result.rsiV.toFixed(1) : "—"}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>📊 Breakdown Skor</h2>
            <div className="result-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {[
                ["Tren", result.trendSc],
                ["Momentum", result.momSc],
                ["Mean-Rev", result.mrSc],
                ["Volume", result.volSc],
                ["Pola", result.patSc],
                ["Mikro", result.microSc],
              ].map(([label, val]) => (
                <div className="result-metric" key={label}>
                  <span className="result-metric-label">{label}</span>
                  <span className={`result-metric-value ${val >= 0 ? "up" : "down"}`}>
                    {val >= 0 ? "+" : ""}
                    {val.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {result.sigs?.length > 0 && (
            <div className="card">
              <h2>🔍 Sinyal Terdeteksi</h2>
              {result.sigs.map((sig, i) => (
                <SigItem key={i} sig={sig} />
              ))}
            </div>
          )}

          <div className="card">
            <h2>🎯 Zona Strategi ({result.hor})</h2>
            <div className="result-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
              <div className="result-metric">
                <span className="result-metric-label">Entry Zone</span>
                <span className="result-metric-value">
                  {formatNumber(result.strat.elow)} - {formatNumber(result.strat.ehigh)}
                </span>
              </div>
              <div className="result-metric">
                <span className="result-metric-label">Stop Loss</span>
                <span className="result-metric-value down">{formatNumber(result.strat.sl)}</span>
              </div>
              <div className="result-metric">
                <span className="result-metric-label">Target 1</span>
                <span className="result-metric-value up">{formatNumber(result.strat.t1)}</span>
              </div>
              <div className="result-metric">
                <span className="result-metric-label">Target 2</span>
                <span className="result-metric-value up">{formatNumber(result.strat.t2)}</span>
              </div>
              <div className="result-metric">
                <span className="result-metric-label">Risk/Reward</span>
                <span className="result-metric-value">{result.strat.rr ? result.strat.rr.toFixed(2) : "—"}</span>
              </div>
            </div>
          </div>

          {result.ara?.araLvl && (
            <div className="card">
              <h2>🚨 ARA/ARB Watch</h2>
              <p className="sub">
                Proksi kemungkinan Auto Reject Atas/Bawah — heuristik dari RSI, volume,
                posisi 52 minggu, dan pola candle. Bukan deteksi resmi.
              </p>
              <div className="result-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                <div className="result-metric">
                  <span className="result-metric-label">Peluang ARA</span>
                  <span className="result-metric-value up">{result.ara.araLvl} ({result.ara.score.toFixed(1)})</span>
                </div>
                <div className="result-metric">
                  <span className="result-metric-label">Peluang ARB</span>
                  <span className="result-metric-value down">{result.ara.arbLvl || "—"} ({result.ara.arbScore.toFixed(1)})</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
