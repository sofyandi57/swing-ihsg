import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";

const CRITERIA = [
  { id: "global", icon: "🌐", label: "Scan Global", desc: "Semua ~950 saham, tanpa kriteria tambahan." },
  { id: "sektor", icon: "🏷️", label: "Sektor & Subsektor", desc: "Pilih sektor (dan opsional subsektor) dari dropdown." },
  { id: "value", icon: "💰", label: "Berdasarkan Value", desc: "Nilai transaksi hari ini minimum sekian Rupiah." },
  { id: "volume_spike", icon: "📈", label: "Volume Spike", desc: "Rata-rata volume 3 hari terakhir jauh di atas rata-rata 20 hari." },
  {
    id: "momentum_sniper",
    icon: "🎯",
    label: "Momentum Sniper (BPJP/BPJS/BSJP)",
    desc: "Percepatan frekuensi transaksi + ticket size + volume + harga. Top 5-15 kandidat, diklasifikasi per strategi.",
  },
  {
    id: "ara_hunter",
    icon: "🚀",
    label: "ARA Hunter",
    desc: "Kandidat Auto Reject Atas sedini mungkin setelah bursa buka — kombinasi info sektor, volume/value breakout, frekuensi, dan tape reading bid/offer. Otomatis jalan tiap pagi jam 09:01 WIB.",
  },
];

const SORT_FIELDS_BY_MODE = {
  global: [
    { id: "value", label: "Value" },
    { id: "freq", label: "Frekuensi" },
    { id: "priceChangePct", label: "Change %" },
  ],
  sektor: [
    { id: "value", label: "Value" },
    { id: "freq", label: "Frekuensi" },
    { id: "priceChangePct", label: "Change %" },
  ],
  value: [
    { id: "value", label: "Value" },
    { id: "freq", label: "Frekuensi" },
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
  momentum_sniper: [
    { id: "humanSpeedScore", label: "Human-Speed Score" },
    { id: "frequencyRatio", label: "Rasio Frekuensi" },
    { id: "value", label: "Value" },
  ],
  ara_hunter: [
    { id: "araScore", label: "ARA Score" },
    { id: "priceChangePct", label: "Change %" },
    { id: "bidOfferRatio", label: "Rasio Bid/Offer" },
    { id: "value", label: "Value" },
  ],
};

const STRATEGY_INFO = {
  BPJP: { desc: "Buy Pagi → Sell Pagi" },
  BPJS: { desc: "Buy Pagi → Sell Sore" },
  BSJP: { desc: "Buy Sore → Sell Pagi Berikutnya" },
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
      : `freq ${formatNumber(row.freq)}, value ${formatCompact(row.value)}`;
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
            : `Freq ${formatNumber(row.freq)}`}
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
        {(mode === "global" || mode === "sektor" || mode === "value") && (
          <div className="result-metric">
            <span className="result-metric-label">Frekuensi</span>
            <span className="result-metric-value">{formatNumber(row.freq)}</span>
          </div>
        )}
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

// Kartu ala "alert" untuk Momentum Sniper — bentuk datanya beda total dari
// ResultCard (freq/ticket/order-book, bukan volumeRatio/sector biasa), jadi
// dipisah komponennya sendiri, bukan dipaksa masuk ResultCard.
function MomentumSniperCard({ row }) {
  const isUp = row.priceChangePct >= 0;
  const notes =
    `Momentum Sniper (${row.strategies.join("/")}) — freq ${row.frequencyRatio != null ? row.frequencyRatio.toFixed(2) + "x baseline" : "baseline belum cukup data"}, ` +
    `ticket ${row.ticketRatio != null ? row.ticketRatio.toFixed(2) + "x" : "n/a"}, Human-Speed Score ${row.humanSpeedScore}/100.`;

  return (
    <div className="result-card">
      <div className="result-card-top">
        <span className="result-code">{row.code}</span>
        <div style={{ display: "flex", gap: 4 }}>
          {row.strategies.map((s) => (
            <span key={s} className="ratio-pill" title={STRATEGY_INFO[s]?.desc}>
              {s}
            </span>
          ))}
        </div>
      </div>

      <div className="sub" style={{ marginBottom: 8 }}>
        Harga {formatNumber(row.price)} ({isUp ? "+" : ""}
        {row.priceChangePct.toFixed(2)}%) · Human-Speed Score{" "}
        <b style={{ color: "var(--accent)" }}>{row.humanSpeedScore}/100</b>
      </div>

      <div className="result-grid">
        <div className="result-metric">
          <span className="result-metric-label">Frekuensi</span>
          <span className="result-metric-value">
            {formatNumber(row.freq)}
            {row.frequencyRatio != null && ` (${row.frequencyRatio.toFixed(2)}x)`}
          </span>
        </div>
        <div className="result-metric">
          <span className="result-metric-label">Ticket Size</span>
          <span className="result-metric-value">
            {row.ticketSize != null ? formatCompact(row.ticketSize) : "—"}
            {row.ticketRatio != null && ` (${row.ticketRatio.toFixed(2)}x)`}
          </span>
        </div>
        <div className="result-metric">
          <span className="result-metric-label">Value</span>
          <span className="result-metric-value">{formatCompact(row.value)}</span>
        </div>
        <div className="result-metric">
          <span className="result-metric-label">Order Book (L1)</span>
          <span className="result-metric-value">
            {row.bidOfferRatioL1 != null ? `${row.bidOfferRatioL1.toFixed(2)}x` : "—"}
          </span>
        </div>
        {row.closeLocation != null && (
          <div className="result-metric">
            <span className="result-metric-label">Close Location</span>
            <span className="result-metric-value">{(row.closeLocation * 100).toFixed(0)}%</span>
          </div>
        )}
        <div className="result-metric">
          <span className="result-metric-label">Sampel Baseline</span>
          <span className="result-metric-value">{row.baselineSampleDays} hari</span>
        </div>
      </div>

      {row.baselineSource === "sementara (antar-kandidat hari ini)" && (
        <div className="cross-miss" style={{ marginTop: 8 }}>
          ⚠ Baseline historis belum ada (kode ini belum pernah tercatat dari scan
          sebelumnya) — rasio memakai pembanding SEMENTARA (median kandidat hari ini),
          bukan histori kode ini sendiri. Akurasi membaik setelah dijalankan beberapa hari.
        </div>
      )}
      {row.frequencyRatio === null && (
        <div className="cross-miss" style={{ marginTop: 8 }}>
          ⚠ Tidak ada data pembanding sama sekali (baik historis maupun antar-kandidat)
          untuk menghitung rasio frekuensi.
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <AddToWatchlistButton code={row.code} notes={notes} />
      </div>
    </div>
  );
}

// Kartu ARA Hunter — 4 sinyal yang diminta User: info (sektor), volume/value
// breakout, frekuensi, dan tape reading bid/offer. Skor komposit ditampilkan
// paling menonjol supaya urutan prioritas kandidat langsung kelihatan.
function AraHunterCard({ row }) {
  const notes =
    `ARA Hunter — ARA Score ${row.araScore.toFixed(1)}, harga +${row.priceChangePct.toFixed(2)}% dari kemarin, ` +
    `freq ${formatNumber(row.freq)}, value ${formatCompact(row.value)}, ` +
    `bid/offer ${row.bidOfferRatio != null ? row.bidOfferRatio.toFixed(2) + "x" : "n/a"}.`;

  return (
    <div className="result-card">
      <div className="result-card-top">
        <span className="result-code">{row.code}</span>
        <span className="ratio-pill" title="Skor komposit 4 sinyal (info+volume+frekuensi+bid/offer)">
          ARA {row.araScore.toFixed(0)}
        </span>
      </div>

      <div className="sub" style={{ marginBottom: 8 }}>
        {row.sector || "Sektor tidak diketahui"} · Harga {formatNumber(row.price)} (+{row.priceChangePct.toFixed(2)}%)
      </div>

      <div className="result-grid">
        <div className="result-metric">
          <span className="result-metric-label">Value</span>
          <span className="result-metric-value">{formatCompact(row.value)}</span>
        </div>
        <div className="result-metric">
          <span className="result-metric-label">Frekuensi</span>
          <span className="result-metric-value">{formatNumber(row.freq)}</span>
        </div>
        <div className="result-metric">
          <span className="result-metric-label">Bid/Offer (Tape)</span>
          <span className="result-metric-value">
            {row.bidOfferRatio != null ? `${row.bidOfferRatio.toFixed(2)}x` : "—"}
          </span>
        </div>
      </div>

      {row.bidOfferRatio === null && (
        <div className="cross-miss" style={{ marginTop: 8 }}>
          ⚠ Order book tidak tersedia untuk kode ini — skor dihitung tanpa sinyal bid/offer.
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <AddToWatchlistButton code={row.code} notes={notes} />
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

  const [sortField, setSortField] = useState("value");
  const [sortDir, setSortDir] = useState("desc");

  const [aiStatus, setAiStatus] = useState("idle"); // idle | loading | done | error
  const [aiPicks, setAiPicks] = useState([]);
  const [aiError, setAiError] = useState("");
  const [aiGroqUsed, setAiGroqUsed] = useState(true);
  const [aiGroqSkipReason, setAiGroqSkipReason] = useState("");

  const [isAdmin, setIsAdmin] = useState(false);
  const [schedulerSettings, setSchedulerSettings] = useState(null);
  const [schedulerBusy, setSchedulerBusy] = useState(null); // key yang sedang di-toggle, atau null

  // Manual Scan (kriteria bebas, semua mode) vs Automated Scan (khusus
  // BPJS/BSJP dari Momentum Sniper, sudah difilter+dibersihkan, maks 5
  // rekomendasi terbaik) — dua alur terpisah, bukan cuma tampilan beda.
  const [viewMode, setViewMode] = useState("manual"); // manual | automated
  const [automatedStatus, setAutomatedStatus] = useState("idle"); // idle | loading | done | error
  const [automatedResults, setAutomatedResults] = useState([]);
  const [automatedError, setAutomatedError] = useState("");

  // Toggle jadwal cron (ARA Hunter/Momentum Sniper) SENGAJA hanya untuk admin
  // — bukan pengaturan per-user, ini mematikan/menyalakan cron GLOBAL untuk
  // semua orang. Fetch whoami dulu untuk tahu status admin (ScanTab tidak
  // menerima prop isAdmin dari App.jsx).
  useEffect(() => {
    (async () => {
      try {
        const whoamiResp = await authFetch("/api/admin?resource=whoami");
        const whoamiJson = await whoamiResp.json();
        if (!whoamiResp.ok || !whoamiJson.isAdmin) return;
        setIsAdmin(true);

        const settingsResp = await authFetch("/api/admin?resource=settings");
        const settingsJson = await settingsResp.json();
        if (settingsResp.ok) setSchedulerSettings(settingsJson.settings);
      } catch (e) {
        // Diamkan — toggle scheduler cuma kemudahan admin, bukan fitur inti scan
      }
    })();
  }, []);

  async function toggleScheduler(key, currentValue) {
    setSchedulerBusy(key);
    try {
      const resp = await authFetch("/api/admin?resource=settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: !currentValue }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setSchedulerSettings((prev) => ({ ...prev, [key]: !currentValue }));
    } catch (e) {
      // Diamkan — kalau gagal, toggle di UI tidak berubah, user bisa coba lagi
    } finally {
      setSchedulerBusy(null);
    }
  }

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

  // Automated Scan — HANYA strategi BPJS/BSJP (BPJP sengaja dikecualikan
  // sesuai spek User), dibersihkan (dedup per kode, ambil skor tertinggi
  // kalau kode sama lolos >1 strategi), maks 5 rekomendasi terbaik.
  async function runAutomatedScan() {
    setAutomatedStatus("loading");
    setAutomatedError("");
    try {
      const resp = await authFetch("/api/screener?mode=momentum_sniper");
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      const bpjsBsjp = (json.data || []).filter(
        (r) => Array.isArray(r.strategies) && r.strategies.some((s) => s === "BPJS" || s === "BSJP")
      );
      const byCode = new Map();
      for (const r of bpjsBsjp) {
        const existing = byCode.get(r.code);
        if (!existing || r.humanSpeedScore > existing.humanSpeedScore) byCode.set(r.code, r);
      }
      const cleaned = [...byCode.values()].sort((a, b) => b.humanSpeedScore - a.humanSpeedScore).slice(0, 5);

      setAutomatedResults(cleaned);
      setAutomatedStatus("done");
    } catch (e) {
      setAutomatedError(e.message);
      setAutomatedStatus("error");
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
    criteriaMode === "momentum_sniper" ||
    criteriaMode === "ara_hunter" ||
    (criteriaMode === "sektor" && selectedSector) ||
    (criteriaMode === "value" && (useSpecialIf2x || minValue)) ||
    (criteriaMode === "volume_spike" && minRatio);

  return (
    <>

      <div className="card" style={{ padding: 8 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className={`btn ${viewMode === "manual" ? "btn-primary" : "btn-ghost"}`}
            style={{ flex: 1 }}
            onClick={() => setViewMode("manual")}
          >
            🔧 Manual Scan
          </button>
          <button
            className={`btn ${viewMode === "automated" ? "btn-primary" : "btn-ghost"}`}
            style={{ flex: 1 }}
            onClick={() => setViewMode("automated")}
          >
            🤖 Automated Scan
          </button>
        </div>
      </div>

      {viewMode === "automated" && (
        <div className="card">
          <h2>🤖 Automated Scan — BPJS &amp; BSJP</h2>
          <p className="sub">
            Rekomendasi otomatis dari Momentum Sniper, KHUSUS strategi BPJS (Buy Pagi Jual Sore) dan BSJP (Buy
            Sore Jual Pagi) — BPJP sengaja tidak disertakan di sini. Sudah dibersihkan (dedup per kode, ambil
            skor tertinggi) dan dibatasi maksimal 5 rekomendasi terbaik.
          </p>
          {isAdmin && schedulerSettings && (() => {
            // Satu slot toggle, dua cron — konten berganti sesuai jam WIB
            // sekarang: pagi (sebelum 12:00) kontrol ARA Hunter (09:01 WIB,
            // penyuplai kandidat pagi), siang/sore kontrol Momentum Sniper
            // (15:00 WIB, penyuplai BSJP). Tidak perlu dua tombol terpisah —
            // yang relevan buat User cuma yang jadwalnya belum lewat hari itu.
            const wibHour = Number(
              new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", hour12: false }).format(new Date())
            );
            const isMorning = wibHour < 12;
            const key = isMorning ? "ara_hunter_cron_enabled" : "momentum_sniper_cron_enabled";
            const label = isMorning ? "Auto-Scan Pagi — ARA Hunter (09:01 WIB)" : "Auto-Scan Sore — Momentum Sniper (15:00 WIB)";
            const enabled = schedulerSettings[key] !== false;
            return (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)", marginBottom: 10 }}>
                <span>{label}</span>
                <button
                  className={`btn ${enabled ? "btn-primary" : "btn-ghost"}`}
                  style={{ minHeight: 36, padding: "6px 14px", fontSize: 12.5 }}
                  onClick={() => toggleScheduler(key, enabled)}
                  disabled={schedulerBusy === key}
                >
                  {schedulerBusy === key ? "⏳" : enabled ? "✅ Aktif" : "⛔ Nonaktif"}
                </button>
              </div>
            );
          })()}
          <button className="btn btn-primary btn-block" onClick={runAutomatedScan} disabled={automatedStatus === "loading"}>
            {automatedStatus === "loading" ? "⏳ Memindai..." : "🔄 Scan Sekarang"}
          </button>
          {automatedError && <div className="error-box" style={{ marginTop: 10 }}>{automatedError}</div>}
          {automatedStatus === "done" && automatedResults.length === 0 && (
            <div className="cross-miss" style={{ marginTop: 10 }}>
              Tidak ada kandidat BPJS/BSJP saat ini — window strategi ini aktif 08:00-10:00 WIB (BPJS) dan
              15:00-16:00 WIB (BSJP), di luar jam itu wajar hasilnya kosong.
            </div>
          )}
          {automatedResults.length > 0 && (
            <div className="result-list" style={{ marginTop: 10 }}>
              {automatedResults.map((row) => (
                <MomentumSniperCard key={row.code} row={row} />
              ))}
            </div>
          )}
        </div>
      )}

      {viewMode === "manual" && (
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

          {criteriaMode === "momentum_sniper" && (
            <p className="sub">
              Stage 1: ~900 saham disaring cepat (harga naik + candle hijau + value ≥ Rp500jt) jadi
              top 50 kandidat. Stage 2: tiap kandidat dicek live (frekuensi transaksi, ticket size,
              order book level 1) lalu diklasifikasi BPJP/BPJS/BSJP. Baseline frekuensi dibangun
              otomatis dari histori tiap kali scan ini dijalankan — akurasi membaik setelah beberapa
              hari pemakaian. Jendela ideal: 08:00–10:00 (BPJP/BPJS) dan 15:00–16:00 (BSJP), tapi
              tetap bisa dijalankan kapan saja. <b>Bukan rekomendasi transaksi</b> — alat bantu baca
              percepatan aktivitas pasar.
            </p>
          )}

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
        <div className="state-box">
          Tidak ada saham yang cocok dengan kriteria ini.
          {meta?.debug?.queryFailed && (
            <div className="error-box" style={{ marginTop: 10, textAlign: "left" }}>
              ⚠ Diagnostik gagal dibaca: {meta.debug.queryError}
              <br />
              {meta.debug.hint}
            </div>
          )}
          {meta?.debug && !meta.debug.queryFailed && (
            <div className="sub" style={{ marginTop: 10, textAlign: "left" }}>
              <b>Diagnostik ({meta.debug.totalRowsWithData} saham dicek):</b>
              <br />
              Lolos batas harga (≥{meta.debug.currentThresholds.minPrice}): {meta.debug.passedPriceFloor}
              <br />
              Lolos batas value (≥{formatCompact(meta.debug.currentThresholds.minValueActivity)}): {meta.debug.passedValueFloor}
              <br />
              Lolos batas frekuensi (≥{meta.debug.currentThresholds.minFreq}): {meta.debug.passedFreqFloor}
              <br />
              <br />
              Top 5 value tertinggi hari ini:
              {meta.debug.top5ByValue.map((r) => (
                <div key={r.code}>
                  {r.code}: value {formatCompact(r.value)}, freq {r.freq}, harga {r.price}
                </div>
              ))}
            </div>
          )}
        </div>
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
            {(meta?.mode || criteriaMode) === "momentum_sniper" ? (
              sortedResults.map((row) => <MomentumSniperCard key={row.code} row={row} />)
            ) : (meta?.mode || criteriaMode) === "ara_hunter" ? (
              sortedResults.map((row) => <AraHunterCard key={row.code} row={row} />)
            ) : (
              sortedResults.map((row) => (
                <ResultCard key={row.code} row={row} mode={meta?.mode || criteriaMode} aiPick={aiPicks.find((p) => p.code === row.code)} />
              ))
            )}
          </div>
        </>
      )}
        </>
      )}
    </>
  );
}
