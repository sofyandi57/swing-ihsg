import { useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";

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

export default function BandarmologiTab() {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  async function runAnalysis() {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setStatus("loading");
    setError("");
    setResult(null);
    try {
      const resp = await authFetch(`/api/stock-chart?action=bandarmologi&code=${encodeURIComponent(trimmed)}`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setResult(json);
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
        <>
          <div className="card bdm-narrative-card">
            <h2>🧠 Kesimpulan</h2>
            <NarrativePanel narrative={result.narrative} />
          </div>

          <div className="card">
            <h2>📊 Broker Summary (Institusi vs Ritel)</h2>
            <SummarySection section={result.summaryChart} />
          </div>

          <div className="card">
            <h2>🏆 Ranking Broker ({result.from} s/d {result.to})</h2>
            <BrokerRankingSection inventorySection={result.inventoryChart} ranking={result.brokerRanking} />
          </div>

          <div className="card">
            <h2>🔀 Crossing Broker Hari Ini</h2>
            <SankeySection section={result.sankeyChart} />
          </div>

          <div className="card">
            <h2>⚡ Arus Beli/Jual Intraday</h2>
            <MomentumSection section={result.momentumChart} />
          </div>

          <div className="card">
            <h2>👥 Kepemilikan &gt;5%</h2>
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

          <div className="card">
            <h2>👤 Kepemilikan &gt;1%</h2>
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

          <div className="card">
            <h2>🧑‍💼 Insider (Direksi/Komisaris/Pengendali)</h2>
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
        </>
      )}
    </div>
  );
}
