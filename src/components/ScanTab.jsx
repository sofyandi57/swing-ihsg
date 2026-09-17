import { useMemo, useState } from "react";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function formatNumber(n) {
  return new Intl.NumberFormat("id-ID").format(Math.round(n));
}

function formatCompact(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}M`; // Miliar
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}Jt`;
  return formatNumber(n);
}

function ResultCard({ row }) {
  const isUp = row.priceChangePct >= 0;
  return (
    <div className="result-card">
      <div className="result-card-top">
        <span className="result-code">{row.code}</span>
        <span className="ratio-pill">{row.volumeRatio.toFixed(2)}x</span>
      </div>
      {(row.sector || row.subsector) && (
        <div className="sub" style={{ marginBottom: 8 }}>
          {row.sector || "—"}
          {row.subsector ? ` · ${row.subsector}` : ""}
        </div>
      )}
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
          <span className="result-metric-label">Value</span>
          <span className="result-metric-value">{formatCompact(row.value)}</span>
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

const ALL = "__ALL__";

function FilterChip({ active, onClick, children }) {
  return (
    <button
      className="btn btn-ghost"
      style={{
        background: active ? "var(--accent-bg)" : "var(--panel-2)",
        color: active ? "var(--accent)" : "var(--text)",
        borderColor: active ? "var(--accent)" : "var(--border)",
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function ScanTab() {
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [insight, setInsight] = useState("");
  const [insightStatus, setInsightStatus] = useState("idle"); // idle | loading | done | error

  const [sectorFilter, setSectorFilter] = useState(ALL);
  const [subsectorFilter, setSubsectorFilter] = useState(ALL);
  const [letterFilter, setLetterFilter] = useState(ALL);
  const [minValue, setMinValue] = useState("");

  const sectors = useMemo(
    () => [...new Set(results.map((r) => r.sector).filter(Boolean))].sort(),
    [results]
  );
  const subsectors = useMemo(
    () => [...new Set(results.map((r) => r.subsector).filter(Boolean))].sort(),
    [results]
  );
  const availableLetters = useMemo(
    () => new Set(results.map((r) => r.code[0])),
    [results]
  );

  const filteredResults = useMemo(() => {
    const minVal = minValue ? Number(minValue) : 0;
    return results.filter((r) => {
      if (sectorFilter !== ALL && r.sector !== sectorFilter) return false;
      if (subsectorFilter !== ALL && r.subsector !== subsectorFilter) return false;
      if (letterFilter !== ALL && r.code[0] !== letterFilter) return false;
      if (minVal > 0 && r.value < minVal) return false;
      return true;
    });
  }, [results, sectorFilter, subsectorFilter, letterFilter, minValue]);

  function resetFilters() {
    setSectorFilter(ALL);
    setSubsectorFilter(ALL);
    setLetterFilter(ALL);
    setMinValue("");
  }

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
    resetFilters();

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

  const hasActiveFilter =
    sectorFilter !== ALL || subsectorFilter !== ALL || letterFilter !== ALL || minValue !== "";

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
        <div className="card">
          <h2>🔍 Filter Hasil</h2>
          <p className="sub">
            Saring hasil scan berdasarkan sektor, subsektor, nilai transaksi
            minimum, atau huruf depan kode saham.
          </p>

          <div style={{ marginBottom: 10 }}>
            <div className="result-metric-label" style={{ marginBottom: 6 }}>SEKTOR</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <FilterChip active={sectorFilter === ALL} onClick={() => setSectorFilter(ALL)}>Semua</FilterChip>
              {sectors.map((s) => (
                <FilterChip key={s} active={sectorFilter === s} onClick={() => setSectorFilter(s)}>
                  {s}
                </FilterChip>
              ))}
            </div>
          </div>

          {subsectors.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="result-metric-label" style={{ marginBottom: 6 }}>SUBSEKTOR</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <FilterChip active={subsectorFilter === ALL} onClick={() => setSubsectorFilter(ALL)}>Semua</FilterChip>
                {subsectors.map((s) => (
                  <FilterChip key={s} active={subsectorFilter === s} onClick={() => setSubsectorFilter(s)}>
                    {s}
                  </FilterChip>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginBottom: 10 }}>
            <div className="result-metric-label" style={{ marginBottom: 6 }}>ABJAD DEPAN</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <FilterChip active={letterFilter === ALL} onClick={() => setLetterFilter(ALL)}>Semua</FilterChip>
              {ALPHABET.filter((l) => availableLetters.has(l)).map((l) => (
                <FilterChip key={l} active={letterFilter === l} onClick={() => setLetterFilter(l)}>
                  {l}
                </FilterChip>
              ))}
            </div>
          </div>

          <div>
            <div className="result-metric-label" style={{ marginBottom: 6 }}>NILAI TRANSAKSI MINIMUM (RP)</div>
            <input
              className="input"
              style={{ minHeight: 40 }}
              type="number"
              placeholder="Contoh: 1000000000 (1 miliar)"
              value={minValue}
              onChange={(e) => setMinValue(e.target.value)}
            />
          </div>

          {hasActiveFilter && (
            <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={resetFilters}>
              ✕ Reset Filter
            </button>
          )}
        </div>
      )}

      {status === "done" && results.length > 0 && (
        <>
          <div className="meta-text">
            Menampilkan {filteredResults.length} dari {results.length} saham lolos filter.
          </div>
          {filteredResults.length === 0 ? (
            <div className="state-box">Tidak ada saham yang cocok dengan filter ini.</div>
          ) : (
            <div className="result-list">
              {filteredResults.map((row) => (
                <ResultCard key={row.code} row={row} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
