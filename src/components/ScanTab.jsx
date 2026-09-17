import { useMemo, useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const ALL = "__ALL__";
const MODES = [
  { id: "global", label: "Global (950+ Saham)" },
  { id: "sektor", label: "Sektor & Subsektor" },
  { id: "value30m", label: "Value 30 Menit Terakhir" },
];

function formatNumber(n) {
  return new Intl.NumberFormat("id-ID").format(Math.round(n));
}

function formatCompact(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}M`; // Miliar
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}Jt`;
  return formatNumber(n);
}

function ResultCard({ row, value30m }) {
  const isUp = row.priceChangePct >= 0;
  return (
    <div className="result-card">
      <div className="result-card-top">
        <span className="result-code">{row.code}</span>
        <span className="ratio-pill">{row.volumeRatio.toFixed(2)}x</span>
      </div>
      {(row.sector || row.subsector) && (
        <div className="sub" style={{ marginBottom: 4 }}>
          {row.sector || "—"}
          {row.subsector ? ` · ${row.subsector}` : ""}
        </div>
      )}
      {row.quietAccumulation && (
        <div className="cross-hit" style={{ marginTop: 0, marginBottom: 8 }}>
          🤫 Akumulasi diam-diam: vol 3 hari {row.volRatio3v20.toFixed(2)}x rata-rata 20 hari, harga +
          {row.priceChange3d.toFixed(1)}%
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
        {value30m !== undefined && (
          <div className="result-metric">
            <span className="result-metric-label">Value 30m</span>
            <span className="result-metric-value">{value30m === null ? "—" : formatCompact(value30m)}</span>
          </div>
        )}
        <div className="result-metric">
          <span className="result-metric-label">Prev Price</span>
          <span className="result-metric-value">{formatNumber(row.prevPrice)}</span>
        </div>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, children }) {
  return (
    <button
      className="btn btn-ghost"
      style={{
        flex: 1,
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
  const [results, setResults] = useState([]); // top-N lolos filter volume ratio (punya subsector)
  const [allResults, setAllResults] = useState([]); // SEMUA saham yang berhasil di-scan (tanpa subsector)
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [insight, setInsight] = useState("");
  const [insightStatus, setInsightStatus] = useState("idle");

  const [filterMode, setFilterMode] = useState("sektor");
  const [quietOnly, setQuietOnly] = useState(false);

  // Mode Sektor & Subsektor
  const [sectorFilter, setSectorFilter] = useState(ALL);
  const [subsectorFilter, setSubsectorFilter] = useState(ALL);
  const [letterFilter, setLetterFilter] = useState(ALL);
  const [minValue, setMinValue] = useState("");

  // Mode Global
  const [globalMinValue, setGlobalMinValue] = useState("");
  const [globalSectorFilter, setGlobalSectorFilter] = useState(ALL);

  // Mode Value 30 Menit
  const [value30mData, setValue30mData] = useState({}); // code -> nilai atau null
  const [value30mStatus, setValue30mStatus] = useState("idle"); // idle | loading | error
  const [value30mThreshold, setValue30mThreshold] = useState("100000000");

  async function fetchInsight(scanPayload) {
    setInsightStatus("loading");
    setInsight("");
    try {
      const resp = await authFetch("/api/scan-insight", {
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
    setValue30mData({});
    setValue30mStatus("idle");

    try {
      const resp = await authFetch("/api/screener");
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      setResults(json.data || []);
      setAllResults(json.allData || []);
      setMeta(json);
      setStatus("done");

      if ((json.data || []).length > 0) {
        fetchInsight({ scannedAt: json.scannedAt, totalScanned: json.totalScanned, data: json.data });
      }
    } catch (e) {
      setStatus("error");
      setError(e.message);
    }
  }

  async function fetchValue30m(codes) {
    setValue30mStatus("loading");
    try {
      const resp = await authFetch("/api/intraday-value", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      const map = {};
      (json.results || []).forEach((r) => {
        map[r.code] = r.value30m;
      });
      setValue30mData(map);
      setValue30mStatus("idle");
    } catch (e) {
      setValue30mStatus("error");
    }
  }

  // ===== Dataset dasar per mode =====
  const sectors = useMemo(() => [...new Set(results.map((r) => r.sector).filter(Boolean))].sort(), [results]);
  const subsectors = useMemo(() => [...new Set(results.map((r) => r.subsector).filter(Boolean))].sort(), [results]);
  const availableLetters = useMemo(() => new Set(results.map((r) => r.code[0])), [results]);
  const globalSectors = useMemo(() => [...new Set(allResults.map((r) => r.sector).filter(Boolean))].sort(), [allResults]);

  const filteredResults = useMemo(() => {
    let base;

    if (filterMode === "global") {
      const minVal = globalMinValue ? Number(globalMinValue) : 0;
      base = allResults.filter((r) => {
        if (globalSectorFilter !== ALL && r.sector !== globalSectorFilter) return false;
        if (minVal > 0 && r.value < minVal) return false;
        return true;
      });
    } else if (filterMode === "sektor") {
      const minVal = minValue ? Number(minValue) : 0;
      base = results.filter((r) => {
        if (sectorFilter !== ALL && r.sector !== sectorFilter) return false;
        if (subsectorFilter !== ALL && r.subsector !== subsectorFilter) return false;
        if (letterFilter !== ALL && r.code[0] !== letterFilter) return false;
        if (minVal > 0 && r.value < minVal) return false;
        return true;
      });
    } else {
      // value30m — dasar dari hasil filtered (top-N), disaring lagi kalau data value30m sudah dimuat
      const threshold = value30mThreshold ? Number(value30mThreshold) : 0;
      base = results.filter((r) => {
        if (Object.keys(value30mData).length === 0) return true; // belum dicek, tampilkan semua dulu
        const v = value30mData[r.code];
        if (v === undefined) return true;
        if (v === null) return false; // gagal diambil datanya
        return v >= threshold;
      });
    }

    if (quietOnly) base = base.filter((r) => r.quietAccumulation);
    return [...base].sort((a, b) => b.volumeRatio - a.volumeRatio);
  }, [
    filterMode,
    allResults,
    results,
    globalSectorFilter,
    globalMinValue,
    sectorFilter,
    subsectorFilter,
    letterFilter,
    minValue,
    value30mData,
    value30mThreshold,
    quietOnly,
  ]);

  const hasActiveFilter =
    filterMode === "sektor"
      ? sectorFilter !== ALL || subsectorFilter !== ALL || letterFilter !== ALL || minValue !== "" || quietOnly
      : filterMode === "global"
      ? globalSectorFilter !== ALL || globalMinValue !== "" || quietOnly
      : quietOnly;

  function resetFilters() {
    setSectorFilter(ALL);
    setSubsectorFilter(ALL);
    setLetterFilter(ALL);
    setMinValue("");
    setGlobalSectorFilter(ALL);
    setGlobalMinValue("");
    setQuietOnly(false);
  }

  return (
    <>
      <div className="card">
        <h2>⚡ One-Button Scalping Scan</h2>
        <p className="sub">
          Pindai ~900 saham BEI, cari lonjakan volume ≥3x sekaligus pola akumulasi
          diam-diam 3 vs 20 hari. Proses ini bisa memakan waktu 30 detik sampai 2 menit.
        </p>
        <button className="btn btn-primary btn-block" onClick={runScan} disabled={status === "loading"}>
          {status === "loading" ? "⏳ Memindai..." : "▶ Run Scan"}
        </button>
      </div>

      {meta && status !== "loading" && (
        <div className="meta-text">
          Terakhir dipindai: {new Date(meta.scannedAt).toLocaleTimeString("id-ID")} ·{" "}
          {meta.totalScanned} saham dicek · {results.length} lolos filter volume ·{" "}
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

      {(insightStatus === "loading" || insight) && (
        <div className="insight-box">
          <div className="insight-label">🤖 AI Insight</div>
          {insightStatus === "loading" ? "Meracik insight dari hasil scan..." : insight}
        </div>
      )}

      {status === "done" && (
        <div className="card">
          <h2>🔍 Filter Hasil</h2>
          <p className="sub">Pilih salah satu mode filter di bawah, lalu saring lebih lanjut.</p>

          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {MODES.map((m) => (
              <ModeButton key={m.id} active={filterMode === m.id} onClick={() => setFilterMode(m.id)}>
                {m.label}
              </ModeButton>
            ))}
          </div>

          <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={quietOnly} onChange={(e) => setQuietOnly(e.target.checked)} />
              🤫 Hanya "Akumulasi Diam-Diam" (volume 3 hari &gt; rata-rata 20 hari, harga naik 0-10%)
            </label>
          </div>

          {filterMode === "global" && (
            <>
              <p className="sub">
                Menampilkan SEMUA {allResults.length} saham yang berhasil di-scan hari ini (bukan
                cuma yang lolos filter volume ratio ≥3x) — subsektor tidak tersedia di mode ini
                (terlalu berat dipanggil untuk 900 saham sekaligus).
              </p>
              <div style={{ marginBottom: 10 }}>
                <div className="result-metric-label" style={{ marginBottom: 6 }}>SEKTOR</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <FilterChip active={globalSectorFilter === ALL} onClick={() => setGlobalSectorFilter(ALL)}>Semua</FilterChip>
                  {globalSectors.map((s) => (
                    <FilterChip key={s} active={globalSectorFilter === s} onClick={() => setGlobalSectorFilter(s)}>
                      {s}
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
                  value={globalMinValue}
                  onChange={(e) => setGlobalMinValue(e.target.value)}
                />
              </div>
            </>
          )}

          {filterMode === "sektor" && (
            <>
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
            </>
          )}

          {filterMode === "value30m" && (
            <>
              <p className="sub">
                Cek total nilai transaksi 30 menit terakhir untuk {results.length} saham yang
                lolos filter volume ratio. Data intraday, dipanggil khusus saat tombol diklik
                (tidak otomatis, supaya hemat panggilan API).
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <div className="result-metric-label" style={{ marginBottom: 6 }}>MINIMUM VALUE 30 MENIT (RP)</div>
                  <input
                    className="input"
                    style={{ minHeight: 40 }}
                    type="number"
                    placeholder="Contoh: 100000000 (100 juta)"
                    value={value30mThreshold}
                    onChange={(e) => setValue30mThreshold(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  style={{ minHeight: 40 }}
                  onClick={() => fetchValue30m(results.map((r) => r.code))}
                  disabled={value30mStatus === "loading" || results.length === 0}
                >
                  {value30mStatus === "loading" ? "Mengecek..." : "Cek Sekarang"}
                </button>
              </div>
              {value30mStatus === "error" && <div className="error-box">Gagal mengambil data intraday.</div>}
              {Object.keys(value30mData).length === 0 && value30mStatus !== "loading" && (
                <div className="sub">Klik "Cek Sekarang" untuk memuat data — sebelum itu semua saham ditampilkan.</div>
              )}
            </>
          )}

          {hasActiveFilter && (
            <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={resetFilters}>
              ✕ Reset Filter
            </button>
          )}
        </div>
      )}

      {status === "done" && (
        <>
          <div className="meta-text">
            Menampilkan {filteredResults.length} saham
            {filterMode === "global" ? ` dari ${allResults.length} total di-scan` : ` dari ${results.length} lolos filter volume`}.
          </div>
          {filteredResults.length === 0 ? (
            <div className="state-box">Tidak ada saham yang cocok dengan filter ini.</div>
          ) : (
            <div className="result-list">
              {filteredResults.map((row) => (
                <ResultCard
                  key={row.code}
                  row={row}
                  value30m={filterMode === "value30m" ? value30mData[row.code] : undefined}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
