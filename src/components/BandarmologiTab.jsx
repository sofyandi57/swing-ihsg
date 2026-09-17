import { useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";

function fmtNum(n) {
  if (n === null || n === undefined || n === "") return "-";
  const num = Number(n);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString("id-ID");
}

function SectionError({ section }) {
  if (section.ok) return null;
  return <div className="error-box" style={{ marginTop: 8 }}>Tidak tersedia: {section.error}</div>;
}

function BrokerRankingTable({ ranking }) {
  if (!ranking || ranking.length === 0) return <p className="sub">Tidak ada data broker.</p>;
  const topBuy = ranking.slice(0, 5);
  const topSell = [...ranking].reverse().slice(0, 5);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div>
        <div className="result-metric-label">TOP NET BUY (akumulasi)</div>
        {topBuy.map((b) => (
          <div key={b.broker} className="cross-hit" style={{ marginTop: 4, display: "flex", justifyContent: "space-between" }}>
            <b>{b.broker}</b> <span>{fmtNum(b.netValue)}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="result-metric-label">TOP NET SELL (distribusi)</div>
        {topSell.map((b) => (
          <div key={b.broker} className="error-box" style={{ marginTop: 4, display: "flex", justifyContent: "space-between" }}>
            <b>{b.broker}</b> <span>{fmtNum(b.netValue)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryChart({ section }) {
  if (!section.ok || !Array.isArray(section.data)) return <SectionError section={section} />;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
      {section.data.map((row, i) => (
        <div key={i} className="cross-hit" style={{ minWidth: 100 }}>
          <div className="result-metric-label">{row.label}</div>
          <b>{fmtNum(row.value)}</b>
        </div>
      ))}
    </div>
  );
}

function SankeyTable({ section }) {
  if (!section.ok) return <SectionError section={section} />;
  const links = section.data?.links || [];
  if (links.length === 0) return <p className="sub">Tidak ada crossing broker hari ini.</p>;
  const sorted = [...links].sort((a, b) => b.value - a.value).slice(0, 10);
  return (
    <div style={{ marginTop: 8 }}>
      {sorted.map((l, i) => (
        <div key={i} className="cross-hit" style={{ marginTop: 4, display: "flex", justifyContent: "space-between" }}>
          <span>{(l.source || "").trim()} → {(l.target || "").trim()}</span>
          <b>{fmtNum(l.value)}</b>
        </div>
      ))}
    </div>
  );
}

function MomentumTable({ section }) {
  if (!section.ok || !Array.isArray(section.data)) return <SectionError section={section} />;
  const rows = section.data.filter((r) => r.buy_lot || r.sell_lot).slice(0, 12);
  if (rows.length === 0) return <p className="sub">Belum ada aktivitas signifikan hari ini.</p>;
  return (
    <div style={{ marginTop: 8, maxHeight: 260, overflowY: "auto" }}>
      {rows.map((r, i) => (
        <div key={i} className="cross-hit" style={{ marginTop: 4, display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span>{r.time}</span>
          <span>Buy: {fmtNum(r.buy_lot)}</span>
          <span>Sell: {fmtNum(r.sell_lot)}</span>
        </div>
      ))}
    </div>
  );
}

function OwnershipTable({ section, columns }) {
  if (!section.ok) return <SectionError section={section} />;
  const rows = section.data?.data || [];
  if (rows.length === 0) return <p className="sub">Tidak ada perubahan kepemilikan pada rentang ini.</p>;
  return (
    <div style={{ marginTop: 8, overflowX: "auto" }}>
      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ textAlign: "left", padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} style={{ padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  {c.format ? c.format(row[c.key]) : row[c.key] ?? "-"}
                </td>
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
          intraday, dan perubahan kepemilikan &gt;5%/&gt;1%/insider. Endpoint ini per-kode (bukan screener massal —
          Invezgo tidak menyediakan versi batch untuk data broker/insider).
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
          <div className="card">
            <h2>📊 Broker Summary (Institusi vs Ritel)</h2>
            <SummaryChart section={result.summaryChart} />
          </div>

          <div className="card">
            <h2>🏆 Ranking Broker ({result.from} s/d {result.to})</h2>
            {result.inventoryChart.ok ? (
              <BrokerRankingTable ranking={result.brokerRanking} />
            ) : (
              <SectionError section={result.inventoryChart} />
            )}
          </div>

          <div className="card">
            <h2>🔀 Crossing Broker Hari Ini</h2>
            <SankeyTable section={result.sankeyChart} />
          </div>

          <div className="card">
            <h2>⚡ Arus Beli/Jual Intraday</h2>
            <MomentumTable section={result.momentumChart} />
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
