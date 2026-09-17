import { useEffect, useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";
import ChatTab from "./ChatTab.jsx";

function CodeCheckResult({ code }) {
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function checkNow() {
    setStatus("loading");
    setError("");
    try {
      const resp = await authFetch(`/api/mentor-call?action=check-stock&code=${encodeURIComponent(code)}`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setResult(json.result);
      setStatus("done");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  return (
    <div>
      <button className="btn btn-ghost" onClick={checkNow} disabled={status === "loading"}>
        {status === "loading" ? "Mengecek..." : "Cek Scan Sekarang"}
      </button>
      {status === "done" && result && (
        <div className={result.volumeRatio >= 3 ? "cross-hit" : "cross-miss"}>
          Live: volume ratio {result.volumeRatio.toFixed(2)}x, harga {Math.round(result.price)} (
          {result.priceChangePct >= 0 ? "+" : ""}
          {result.priceChangePct.toFixed(2)}%)
        </div>
      )}
      {status === "done" && !result && <div className="cross-miss">Data tidak tersedia untuk {code}</div>}
      {status === "error" && <div className="cross-miss">⚠ Gagal cek: {error}</div>}
    </div>
  );
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
    return <span className="cross-hit">⭐ Ditambahkan ke Watchlist</span>;
  }

  return (
    <button className="btn btn-ghost" onClick={add} disabled={state === "loading"}>
      {state === "loading" ? "Menambahkan..." : "+ Tambah ke Watchlist"}
      {state === "error" && " (gagal, coba lagi)"}
    </button>
  );
}

function CrossCheckResult({ json, sourceMessage }) {
  const { detectedCodes, boldCodes, scanCrossCheck, pastMentions, receivedAt, groqUsed, groqSkipReason } = json;
  const boldSet = new Set(boldCodes || []);
  const notesSnippet = (sourceMessage || "").slice(0, 200);

  if (detectedCodes.length === 0) {
    return (
      <div className="mentor-code-block">
        <div className="sub" style={{ marginBottom: 0 }}>
          {groqUsed ? "✓ Deteksi dibantu AI (Groq)" : `⚠ Hanya regex+blocklist (Groq nonaktif${groqSkipReason ? ": " + groqSkipReason : ""})`}
          . Tidak ada kode saham terdeteksi — pesan tetap disimpan sebagai histori.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sub">
        {groqUsed ? "✓ Deteksi dibantu AI (Groq) untuk memahami konteks kalimat" : `⚠ Hanya regex+blocklist (Groq nonaktif${groqSkipReason ? ": " + groqSkipReason : ""})`}
      </div>
      {detectedCodes.map((code) => {
        const scanHits = scanCrossCheck[code] || [];
        const mentionHits = (pastMentions[code] || []).filter((m) => m.received_at !== receivedAt);
        const isBold = boldSet.has(code);

        return (
          <div className="mentor-code-block" key={code}>
            <div className="mentor-code-head">
              <span className="code-tag">{code}</span>
              {isBold && (
                <span className="sub" style={{ margin: 0 }}>
                  ✱ ditandai tegas oleh mentor (**bold**)
                </span>
              )}
            </div>
            {scanCrossCheck._error ? (
              <div className="cross-miss">⚠ Gagal cek histori scan: {scanCrossCheck._error}</div>
            ) : scanHits.length > 0 ? (
              <div className="cross-hit">
                ✓ Terdeteksi di scan: ratio {Number(scanHits[0].volume_ratio).toFixed(2)}x, harga{" "}
                {Math.round(scanHits[0].price)}, {scanHits[0].passed_filter ? "lolos filter" : "tidak lolos filter"} (
                {scanHits.length}x dalam 7 hari terakhir)
              </div>
            ) : (
              <div className="cross-miss">— Belum terdeteksi lonjakan volume di scan 7 hari terakhir</div>
            )}
            {mentionHits.length > 0 && (
              <div className="cross-hit">🔁 Mentor pernah sebut kode ini {mentionHits.length}x sebelumnya</div>
            )}
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <CodeCheckResult code={code} />
              <AddToWatchlistButton code={code} notes={notesSnippet} />
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function MentorTab() {
  const [subTab, setSubTab] = useState("crosscheck"); // crosscheck | chat
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [crossCheckJson, setCrossCheckJson] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState("");

  async function loadHistory() {
    try {
      const resp = await authFetch("/api/mentor-call");
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setHistory(json.calls || []);
    } catch (e) {
      setHistoryError(e.message);
    }
  }

  useEffect(() => {
    loadHistory();
  }, []);

  async function runCrossCheck() {
    const trimmed = message.trim();
    if (!trimmed) return;

    setStatus("loading");
    setError("");
    setCrossCheckJson(null);

    try {
      const resp = await authFetch("/api/mentor-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      setCrossCheckJson({ ...json, sourceMessage: trimmed });
      setMessage("");
      setStatus("done");
      loadHistory();
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  return (
    <>
      <div className="card" style={{ display: "flex", gap: 6 }}>
        <button
          className="btn btn-ghost"
          style={{
            flex: 1,
            background: subTab === "crosscheck" ? "var(--accent-bg)" : "var(--panel-2)",
            color: subTab === "crosscheck" ? "var(--accent)" : "var(--text)",
            borderColor: subTab === "crosscheck" ? "var(--accent)" : "var(--border)",
          }}
          onClick={() => setSubTab("crosscheck")}
        >
          💬 Cross-Check
        </button>
        <button
          className="btn btn-ghost"
          style={{
            flex: 1,
            background: subTab === "chat" ? "var(--accent-bg)" : "var(--panel-2)",
            color: subTab === "chat" ? "var(--accent)" : "var(--text)",
            borderColor: subTab === "chat" ? "var(--accent)" : "var(--border)",
          }}
          onClick={() => setSubTab("chat")}
        >
          🤖 Chat Asisten
        </button>
      </div>

      {subTab === "chat" && <ChatTab />}

      {subTab === "crosscheck" && (
        <>
      <div className="card">
        <h2>💬 Cross-Check Pesan Mentor</h2>
        <p className="sub">
          Paste pesan mentor (misal dari WhatsApp). Sistem cari kode saham yang
          disebut, lalu cek apakah muncul di histori scan 7 hari terakhir.
        </p>
        <textarea
          className="input"
          placeholder="Contoh: Beli BBRI area 4200, target 4500. Watch juga GOTO."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div style={{ height: 10 }} />
        <button className="btn btn-primary btn-block" onClick={runCrossCheck} disabled={status === "loading" || !message.trim()}>
          {status === "loading" ? "Memproses..." : "Cross-Check"}
        </button>
      </div>

      {error && <div className="error-box">Gagal cross-check: {error}</div>}

      {crossCheckJson && (
        <div className="card">
          <CrossCheckResult json={crossCheckJson} sourceMessage={crossCheckJson.sourceMessage} />
        </div>
      )}

      <div className="card">
        <h2>🕓 Histori Pesan Mentor</h2>
        <p className="sub">20 pesan terakhir yang pernah di-paste.</p>
        {historyError && <div className="error-box">Gagal memuat histori: {historyError}</div>}
        {history === null && !historyError && <div className="state-box">Memuat histori...</div>}
        {history && history.length === 0 && <div className="state-box">Belum ada pesan yang di-paste.</div>}
        {history && history.length > 0 && (
          <div>
            {history.map((call) => (
              <div className="history-item" key={call.id}>
                <div className="history-time">{new Date(call.received_at).toLocaleString("id-ID")}</div>
                <div className="history-msg">{call.raw_message}</div>
                <div>
                  {(call.codes || []).length > 0 ? (
                    call.codes.map((c) => (
                      <span className="code-tag" key={c}>
                        {c}
                      </span>
                    ))
                  ) : (
                    <em style={{ color: "var(--muted)", fontSize: 12 }}>tidak ada kode terdeteksi</em>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
        </>
      )}
    </>
  );
}
