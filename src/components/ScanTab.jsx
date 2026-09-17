import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";

const CRITERIA = [
  { id: "global", icon: "🌐", label: "Scan Global", desc: "Semua ~950 saham, tanpa kriteria tambahan." },
  { id: "sektor", icon: "🏷️", label: "Sektor & Subsektor", desc: "Pilih sektor (dan opsional subsektor) dari dropdown." },
  { id: "value", icon: "💰", label: "Berdasarkan Value", desc: "Nilai transaksi hari ini minimum sekian Rupiah." },
  { id: "volume_spike", icon: "📈", label: "Volume Spike", desc: "Rata-rata volume 3 hari terakhir jauh di atas rata-rata 20 hari." },
];

const SORT_FIELDS_BY_MODE = {
  global: [
    { id: "volumeRatio", label: "Volume Ratio" },
    { id: "value", label: "Value" },
    { id: "priceChangePct", label: "Change %" },
  ],
  sektor: [
    { id: "volumeRatio", label: "Volume Ratio" },
    { id: "value", label: "Value" },
    { id: "priceChangePct", label: "Change %" },
  ],
  value: [
    { id: "value", label: "Value" },
    { id: "volumeRatio", label: "Volume Ratio" },
  ],
  volume_spike: [
    { id: "volRatio3v20", label: "Rasio Volume 3v20" },
    { id: "priceChange3d", label: "Change 3 Hari %" },
  ],
  special_if2x: [
    { id: "volumeVsMA20", label: "Volume vs MA20" },
    { id: "value", label: "Value" },
    { id: "freq", label: "Frekuensi" },
  ],
};

function formatNumber(n) {
  return new Intl.NumberFormat("id-ID").format(Math.round(n));
}

function formatCompact(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}Jt`;
  return formatNumber(n);
}

// Ringkasan angka scan saat itu — dipakai sebagai "notes" watchlist supaya
// kelak di tab Watchlist/Mentor kelihatan konteks kenapa kode ini ditambahkan
// (bukan cuma kode polos tanpa alasan).
function buildScanNote(row, mode) {
  const ratioLabel =
    mode === "volume_spike"
      ? `ratio 3v20 ${row.volRatio3v20?.toFixed(2)}x`
      : mode === "special_if2x"
      ? `volume vs MA20 ${row.volumeVsMA20?.toFixed(2)}x`
      : `volume ratio ${row.volumeRatio?.toFixed(2)}x`;
  return `Dari Run Scan (${mode}): ${ratioLabel}, harga ${Math.round(row.price)} (${row.priceChangePct >= 0 ? "+" : ""}${row.priceChangePct.toFixed(2)}%).`;
}

function AddToWatchlistButton({ code, notes }) {
  const [state, setState] = useState("idle"); // idle | loading | added | error

  async function add() {
    setState("loading");
    try {
      const resp = await authFetch("/api/mentor-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add-watchlist", code, notes }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setState("added");
    } catch (e) {
      setState("error");
    }
  }

  if (state === "added") {
    return <span className="cross-hit" style={{ marginTop: 0 }}>⭐ Di Watchlist</span>;
  }

  return (
    <button className="btn btn-ghost" onClick={add} disabled={state === "loading"} style={{ fontSize: 12 }}>
      {state === "loading" ? "Menambahkan..." : state === "error" ? "Gagal, coba lagi" : "+ Watchlist"}
    </button>
  );
}

function ResultCard({ row, mode, aiPick }) {
  const isUp = row.priceChangePct >= 0;
  return (
    <div className="result-card" style={aiPick ? { borderColor: "var(--accent)" } : undefined}>
      <div className="result-card-top">
        <span className="result-code">
          {row.code} {aiPick && <span title={aiPick.reason}>🌟</span>}
        </span>
        <span className="ratio-pill">
          {mode === "volume_spike"
            ? `${row.volRatio3v20.toFixed(2)}x (20h)`
            : mode === "special_if2x"
            ? `${row.volumeVsMA20.toFixed(2)}x (MA20)`
            : `${row.volumeRatio.toFixed(2)}x`}
        </span>
      </div>
      {aiPick && <div className="cross-hit" style={{ marginTop: 0, marginBottom: 8 }}>🤖 {aiPick.reason}</div>}
      {row.sudahNaikTajam && (
        <div className="cross-miss" style={{ marginTop: 0, marginBottom: 8 }}>
          ⚠️ Sudah naik tajam hari ini (+{row.priceChangePct.toFixed(1)}%) — kemungkinan dekat/sudah ARA, hati-hati kejar harga.
        </div>
      )}
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
        {mode === "volume_spike" && (
          <>
            <div className="result-metric">
              <span className="result-metric-label">Avg Vol 3d</span>
              <span className="result-metric-value">{formatCompact(row.avgVolume3d)}</span>
            </div>
            <div className="result-metric">
              <span className="result-metric-label">Avg Vol 20d</span>
              <span className="result-metric-value">{formatCompact(row.avgVolume20d)}</span>
            </div>
          </>
        )}
        {mode === "special_if2x" && (
          <>
            <div className="result-metric">
              <span className="result-metric-label">Avg Vol 20d</span>
              <span className="result-metric-value">{formatCompact(row.avgVolume20d)}</span>
            </div>
            <div className="result-metric">
              <span className="result-metric-label">Frekuensi</span>
              <span className="result-metric-value">{formatNumber(row.freq)}</span>
            </div>
          </>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <AddToWatchlistButton code={row.code} notes={buildScanNote(row, mode)} />
      </div>
    </div>
  );
}

export default function ScanTab() {
  const [criteriaMode, setCriteriaMode] = useState(null); // null = pilih kriteria dulu

  // Konfigurasi mode "sektor"
  const [sectorsList, setSectorsList] = useState(null);
  const [sectorsError, setSectorsError] = useState("");
  const [selectedSector, setSelectedSector] = useState("");
  const [subsectorsList, setSubsectorsList] = useState(null);
  const [subsectorsStatus, setSubsectorsStatus] = useState("idle"); // idle | loading | error
  const [selectedSubsector, setSelectedSubsector] = useState("");

  // Konfigurasi mode "value" & "volume_spike"
  const [minValue, setMinValue] = useState("100000000");
  const [minRatio, setMinRatio] = useState("1.5");
  // Centang di bawah kriteria "value" — beralih ke preset khusus "IF2X" (di-decode
  // dari screenshot screener eksternal User): threshold sudah tetap (bukan minValue
  // input manual), lihat komentar lengkap di api/screener.js runScan().
  const [useSpecialIf2x, setUseSpecialIf2x] = useState(false);

  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [insight, setInsight] = useState("");
  const [insightStatus, setInsightStatus] = useState("idle");

  const [sortField, setSortField] = useState("volumeRatio");
  const [sortDir, setSortDir] = useState("desc");

  const [aiStatus, setAiStatus] = useState("idle"); // idle | loading | done | error
  const [aiPicks, setAiPicks] = useState([]);
  const [aiError, setAiError] = useState("");
  const [aiGroqUsed, setAiGroqUsed] = useState(true);
  const [aiGroqSkipReason, setAiGroqSkipReason] = useState("");

  useEffect(() => {
    if (criteriaMode !== "sektor" || sectorsList !== null) return;
    (async () => {
      try {
        const resp = await authFetch("/api/sectors");
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
        setSectorsList(json.sectors || []);
      } catch (e) {
        setSectorsError(e.message);
      }
    })();
  }, [criteriaMode, sectorsList]);

  async function handleSectorChange(sector) {
    setSelectedSector(sector);
    setSelectedSubsector("");
    setSubsectorsList(null);
    if (!sector) return;

    setSubsectorsStatus("loading");
    try {
      const resp = await authFetch(`/api/sectors?sector=${encodeURIComponent(sector)}`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setSubsectorsList(json.subsectors || []);
      setSubsectorsStatus("idle");
    } catch (e) {
      setSubsectorsStatus("error");
    }
  }

  function selectCriteria(id) {
    setCriteriaMode(id);
    setStatus("idle");
    setResults([]);
    setMeta(null);
    setUseSpecialIf2x(false);
    setSortField(SORT_FIELDS_BY_MODE[id][0].id);
    setSortDir("desc");
  }

  function toggleSpecialIf2x(checked) {
    setUseSpecialIf2x(checked);
    setSortField(SORT_FIELDS_BY_MODE[checked ? "special_if2x" : "value"][0].id);
  }

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

  async function requestAiHelp() {
    setAiStatus("loading");
    setAiError("");
    setAiPicks([]);

    try {
      const rowsPayload = sortedResults.map((r) => ({
        code: r.code,
        volumeRatio: r.volumeRatio,
        value: r.value,
        priceChangePct: r.priceChangePct,
        volRatio3v20: r.volRatio3v20,
      }));
      const resp = await authFetch("/api/ai-shortlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: rowsPayload }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      setAiPicks(json.picks || []);
      setAiGroqUsed(json.groqUsed);
      setAiGroqSkipReason(json.groqSkipReason || "");
      setAiStatus("done");
    } catch (e) {
      setAiError(e.message);
      setAiStatus("error");
    }
  }

  async function runScan() {
    setStatus("loading");
    setError("");
    setInsight("");
    setInsightStatus("idle");
    setAiStatus("idle");
    setAiPicks([]);

    const effectiveMode = criteriaMode === "value" && useSpecialIf2x ? "special_if2x" : criteriaMode;
    const params = new URLSearchParams({ mode: effectiveMode });
    if (criteriaMode === "sektor") {
      params.set("sector", selectedSector);
      if (selectedSubsector) params.set("subsector", selectedSubsector);
    } else if (criteriaMode === "value" && !useSpecialIf2x) {
      params.set("minValue", minValue || "0");
    } else if (criteriaMode === "volume_spike") {
      params.set("minRatio", minRatio || "1");
    }

    try {
      const resp = await authFetch(`/api/screener?${params.toString()}`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      setResults(json.data || []);
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

  const sortedResults = useMemo(() => {
    const sorted = [...results].sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return sorted;
  }, [results, sortField, sortDir]);

  const canRun =
    criteriaMode === "global" ||
    (criteriaMode === "sektor" && selectedSector) ||
    (criteriaMode === "value" && (useSpecialIf2x || minValue)) ||
    (criteriaMode === "volume_spike" && minRatio);

  return (
    <>
      {criteriaMode === null && (
        <div className="card">
          <h2>⚡ Pilih Kriteria Scan</h2>
          <p className="sub">Pilih kriteria dulu — hasil yang keluar sudah langsung final sesuai pilihan ini.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {CRITERIA.map((c) => (
              <button
                key={c.id}
                className="btn btn-ghost"
                style={{ justifyContent: "flex-start", textAlign: "left", minHeight: 56, padding: "10px 14px" }}
                onClick={() => selectCriteria(c.id)}
              >
                <span style={{ fontSize: 20, marginRight: 10 }}>{c.icon}</span>
                <span>
                  <div style={{ fontWeight: 700 }}>{c.label}</div>
                  <div className="sub" style={{ marginBottom: 0, fontSize: 11.5 }}>{c.desc}</div>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {criteriaMode !== null && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <h2 style={{ marginBottom: 0 }}>
              {CRITERIA.find((c) => c.id === criteriaMode)?.icon} {CRITERIA.find((c) => c.id === criteriaMode)?.label}
            </h2>
            <button className="btn btn-ghost" onClick={() => setCriteriaMode(null)}>
              ← Ganti Kriteria
            </button>
          </div>

          {criteriaMode === "sektor" && (
            <>
              <p className="sub">Scan dipersempit ke sektor ini saja — lebih cepat dari scan global.</p>
              {sectorsError && <div className="error-box">Gagal memuat daftar sektor: {sectorsError}</div>}
              <div style={{ marginBottom: 10 }}>
                <div className="result-metric-label" style={{ marginBottom: 6 }}>SEKTOR</div>
                <select
                  className="input"
                  style={{ minHeight: 44 }}
                  value={selectedSector}
                  onChange={(e) => handleSectorChange(e.target.value)}
                  disabled={sectorsList === null}
                >
                  <option value="">{sectorsList === null ? "Memuat sektor..." : "— Pilih sektor —"}</option>
                  {(sectorsList || []).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              {selectedSector && (
                <div style={{ marginBottom: 10 }}>
                  <div className="result-metric-label" style={{ marginBottom: 6 }}>SUBSEKTOR (OPSIONAL)</div>
                  <select
                    className="input"
                    style={{ minHeight: 44 }}
                    value={selectedSubsector}
                    onChange={(e) => setSelectedSubsector(e.target.value)}
                    disabled={subsectorsStatus === "loading"}
                  >
                    <option value="">
                      {subsectorsStatus === "loading" ? "Memuat subsektor..." : "Semua subsektor"}
                    </option>
                    {(subsectorsList || []).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  {subsectorsStatus === "error" && <div className="error-box">Gagal memuat subsektor.</div>}
                </div>
              )}
            </>
          )}

          {criteriaMode === "value" && (
            <div style={{ marginBottom: 10 }}>
              {!useSpecialIf2x && (
                <>
                  <div className="result-metric-label" style={{ marginBottom: 6 }}>NILAI TRANSAKSI MINIMUM HARI INI (RP)</div>
                  <input
                    className="input"
                    style={{ minHeight: 44 }}
                    type="number"
                    placeholder="Contoh: 100000000 (100 juta)"
                    value={minValue}
                    onChange={(e) => setMinValue(e.target.value)}
                  />
                </>
              )}

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  cursor: "pointer",
                  marginTop: useSpecialIf2x ? 0 : 12,
                }}
              >
                <input
                  type="checkbox"
                  checked={useSpecialIf2x}
                  onChange={(e) => toggleSpecialIf2x(e.target.checked)}
                />
                🎯 Pakai Special Screener (preset IF2X)
              </label>
              {useSpecialIf2x && (
                <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>
                  Preset tetap (bukan diisi manual): return harga 1 hari ≥ -10%, volume hari ini
                  ≥ 2x rata-rata volume 20 hari, frekuensi transaksi &gt; 1, volume ≥ 5 juta lembar,
                  value &gt; Rp 3 M. Butuh minimal 23 hari data perdagangan per saham.
                </p>
              )}
            </div>
          )}

          {criteriaMode === "volume_spike" && (
            <div style={{ marginBottom: 10 }}>
              <div className="result-metric-label" style={{ marginBottom: 6 }}>
                MINIMUM RASIO VOLUME (3 HARI TERAKHIR vs RATA-RATA 20 HARI SEBELUMNYA)
              </div>
              <input
                className="input"
                style={{ minHeight: 44 }}
                type="number"
                step="0.1"
                placeholder="Contoh: 1.5 (artinya 1.5x lebih tinggi)"
                value={minRatio}
                onChange={(e) => setMinRatio(e.target.value)}
              />
              <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>
                Butuh minimal 23 hari data perdagangan per saham — saham yang baru IPO/lama suspend otomatis dilewati.
              </p>
            </div>
          )}

          <button className="btn btn-primary btn-block" onClick={runScan} disabled={!canRun || status === "loading"}>
            {status === "loading" ? "⏳ Memindai..." : "▶ Jalankan Scan"}
          </button>
        </div>
      )}

      {meta && status !== "loading" && (
        <div className="meta-text">
          Terakhir dipindai: {new Date(meta.scannedAt).toLocaleTimeString("id-ID")} ·{" "}
          Mode: <b>{meta.mode}</b>
          {meta.criteria?.sector && (
            <>
              {" "}
              · Sektor: <b>{meta.criteria.sector}</b>
              {meta.criteria.subsector && <> / {meta.criteria.subsector}</>}
            </>
          )}{" "}
          · {meta.totalScanned} saham dicek · {results.length} cocok kriteria ·{" "}
          {(meta.durationMs / 1000).toFixed(1)}s ·{" "}
          {meta.saved ? "✓ tersimpan ke histori" : `⚠ tidak tersimpan (${meta.saveError || "?"})`}
          {meta.cached && (
            <>
              {" "}
              · ⚡ dari cache ({meta.cacheAgeSec}s lalu — teman lain baru scan kriteria yang sama)
            </>
          )}
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

      {status === "done" && results.length === 0 && (
        <div className="state-box">Tidak ada saham yang cocok dengan kriteria ini.</div>
      )}

      {status === "done" && results.length > 0 && (
        <>
          <div className="card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="result-metric-label">URUTKAN</span>
            <select className="input" style={{ minHeight: 36, flex: 1 }} value={sortField} onChange={(e) => setSortField(e.target.value)}>
              {SORT_FIELDS_BY_MODE[criteriaMode].map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
            <button className="btn btn-ghost" onClick={() => setSortDir(sortDir === "desc" ? "asc" : "desc")}>
              {sortDir === "desc" ? "↓ Descending" : "↑ Ascending"}
            </button>
          </div>

          <div className="card">
            <h2>🤖 Bantuan AI</h2>
            <p className="sub">
              Dari {results.length} saham ini, minta AI bantu pilih yang paling menarik berdasarkan
              volume spike, frekuensi transaksi hari ini, value, dan risiko spread bid-offer —
              semua ditarik langsung dari Invezgo, bukan tebakan AI.
            </p>
            <button className="btn btn-primary btn-block" onClick={requestAiHelp} disabled={aiStatus === "loading"}>
              {aiStatus === "loading" ? "⏳ Menganalisa..." : "🤖 Minta Bantuan AI"}
            </button>
            {aiError && <div className="error-box" style={{ marginTop: 10 }}>{aiError}</div>}
            {aiStatus === "done" && !aiGroqUsed && (
              <div className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
                ⚠ Groq nonaktif{aiGroqSkipReason ? `: ${aiGroqSkipReason}` : ""} — coba lagi setelah GROQ_API_KEY diset.
              </div>
            )}
            {aiStatus === "done" && aiGroqUsed && aiPicks.length === 0 && (
              <div className="sub" style={{ marginTop: 10, marginBottom: 0 }}>AI tidak menemukan pilihan yang cukup menonjol.</div>
            )}
          </div>

          {aiPicks.length > 0 && (
            <div className="card">
              <h2>🌟 Rekomendasi AI ({aiPicks.length})</h2>
              {aiPicks.map((p) => (
                <div className="mentor-code-block" key={p.code}>
                  <div className="mentor-code-head">
                    <span className="code-tag" style={{ fontSize: 15 }}>{p.code}</span>
                  </div>
                  {p.levels ? (
                    <div className="insight-box" style={{ marginBottom: 10 }}>
                      <b>Rekomendasi AI: Saham Pilihan → {p.code}</b>
                      <br />
                      Beli di {p.levels.buyLow}-{p.levels.buyHigh}
                      <br />
                      Jual di {p.levels.sellLow}-{p.levels.sellHigh}
                      <br />
                      Stop Loss {p.levels.stopLossLow}-{p.levels.stopLossHigh}
                    </div>
                  ) : (
                    <div className="sub" style={{ marginBottom: 10 }}>
                      ⚠ Data candle {p.code} belum cukup untuk hitung area beli/jual/stop-loss.
                    </div>
                  )}
                  <div className="cross-hit">✓ {p.reason}</div>
                  <div className="cross-miss">⚠ {p.risk}</div>
                </div>
              ))}
            </div>
          )}

          <div className="result-list">
            {sortedResults.map((row) => (
              <ResultCard key={row.code} row={row} mode={meta?.mode || criteriaMode} aiPick={aiPicks.find((p) => p.code === row.code)} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
