import { useEffect, useRef, useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";

function formatNumber(n) {
  return new Intl.NumberFormat("id-ID").format(Math.round(n));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result = "data:application/pdf;base64,XXXX" — buang prefix-nya
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const SOURCE_LABEL = {
  pdf: "dari PDF",
  mentor_call: "dari mentor",
  manual: "manual",
};

// Warna baris ratio berdasarkan arah harga: hijau = naik (positif), merah =
// turun (negatif), kuning = netral/nyaris flat (|perubahan| < 0.5%).
function changeColorClass(priceChangePct) {
  if (priceChangePct == null) return "neutral";
  if (priceChangePct > 0.5) return "up";
  if (priceChangePct < -0.5) return "down";
  return "neutral";
}

function WatchlistCard({ item, onRemove }) {
  const scan = item.latestScan;
  const isHot = scan && scan.passedFilter;
  const [removing, setRemoving] = useState(false);

  async function handleRemove() {
    if (!window.confirm(`Hapus ${item.code} dari watchlist?`)) return;
    setRemoving(true);
    await onRemove(item.code);
  }

  return (
    <div className="result-card">
      <div className="result-card-top">
        <span className="result-code">{item.code}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="ratio-pill" style={{ background: "var(--panel)", color: "var(--muted)" }}>
            {SOURCE_LABEL[item.source] || item.source}
          </span>
          <button
            onClick={handleRemove}
            disabled={removing}
            title="Hapus dari watchlist"
            aria-label={`Hapus ${item.code} dari watchlist`}
            style={{
              appearance: "none",
              border: "1px solid var(--border)",
              background: "var(--panel)",
              color: "var(--muted)",
              borderRadius: "999px",
              width: 24,
              height: 24,
              minHeight: 24,
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      </div>
      {item.notes && <div className="sub" style={{ marginBottom: 8 }}>{item.notes}</div>}
      {scan ? (
        <div className={changeColorClass(scan.priceChangePct)}>
          {isHot ? "✓" : "—"} Ratio {Number(scan.volumeRatio).toFixed(2)}x, harga {formatNumber(scan.price)}
          {scan.priceChangePct != null && (
            <> ({scan.priceChangePct >= 0 ? "+" : ""}{Number(scan.priceChangePct).toFixed(2)}%)</>
          )}
          , {isHot ? "lolos filter sekarang" : "belum lolos filter"} · terakhir scan{" "}
          {new Date(scan.scannedAt).toLocaleDateString("id-ID")}
        </div>
      ) : (
        <div className="cross-miss">— Belum pernah muncul di hasil scan</div>
      )}
    </div>
  );
}

export default function WatchlistTab() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("idle"); // idle | loading | error
  const [uploadError, setUploadError] = useState("");
  const [lastResult, setLastResult] = useState(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState("");
  const fileInputRef = useRef(null);

  async function loadWatchlist() {
    try {
      const resp = await authFetch("/api/pdf-watchlist");
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setItems(json.items || []);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    loadWatchlist();
  }, []);

  async function removeFromWatchlist(code) {
    try {
      const resp = await authFetch(`/api/pdf-watchlist?code=${encodeURIComponent(code)}`, { method: "DELETE" });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setItems((prev) => (prev || []).filter((it) => it.code !== code));
    } catch (e) {
      setError(`Gagal hapus ${code}: ${e.message}`);
    }
  }

  async function deleteAllWatchlist() {
    if (!items || items.length === 0) return;
    if (!window.confirm(`Hapus SEMUA ${items.length} kode dari watchlist? Tindakan ini tidak bisa dibatalkan.`)) return;
    setDeletingAll(true);
    try {
      const resp = await authFetch("/api/pdf-watchlist?all=true", { method: "DELETE" });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setItems([]);
    } catch (e) {
      setError(`Gagal hapus semua: ${e.message}`);
    } finally {
      setDeletingAll(false);
    }
  }

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next && history === null) {
      try {
        const resp = await authFetch("/api/pdf-watchlist?history=true");
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
        setHistory(json.history || []);
      } catch (e) {
        setHistoryError(e.message);
      }
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadStatus("loading");
    setUploadError("");
    setLastResult(null);

    try {
      const base64 = await fileToBase64(file);
      const resp = await authFetch("/api/pdf-watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, base64 }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      setLastResult(json);
      setUploadStatus("idle");
      loadWatchlist();
    } catch (e) {
      setUploadError(e.message);
      setUploadStatus("error");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <>
      <div className="card">
        <h2>📄 Upload PDF Riset/Rekomendasi</h2>
        <p className="sub">
          Upload PDF riset atau rekomendasi saham. Sistem ekstrak kode saham +
          ringkasan AI per kode, lalu tambahkan ke watchlist (upsert — tidak
          duplikat kalau kode yang sama muncul lagi dari sumber lain).
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          onChange={handleFileChange}
          disabled={uploadStatus === "loading"}
          style={{ display: "none" }}
          id="pdf-input"
        />
        <button
          className="btn btn-primary btn-block"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadStatus === "loading"}
        >
          {uploadStatus === "loading" ? "⏳ Memproses PDF..." : "📎 Pilih File PDF"}
        </button>
      </div>

      {uploadError && <div className="error-box">Gagal upload: {uploadError}</div>}

      {lastResult && (
        <div className="card">
          <h2>✓ Hasil Ekstraksi Terakhir</h2>
          <div className="sub" style={{ marginBottom: 10 }}>
            {lastResult.groqUsed
              ? "✓ Ringkasan dibantu AI (Groq)"
              : `⚠ Hanya regex+blocklist, tanpa ringkasan AI (Groq nonaktif${lastResult.groqSkipReason ? ": " + lastResult.groqSkipReason : ""})`}
          </div>
          {lastResult.detectedCodes.length === 0 ? (
            <div className="sub" style={{ marginBottom: 0 }}>Tidak ada kode saham terdeteksi di PDF ini.</div>
          ) : (
            lastResult.detectedCodes.map((code) => (
              <div key={code} style={{ marginBottom: 8 }}>
                <span className="code-tag">{code}</span>
                {lastResult.aiNotes[code] && (
                  <div className="sub" style={{ marginTop: 2, marginBottom: 0 }}>{lastResult.aiNotes[code]}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div>
            <h2>⭐ Watchlist Aktif</h2>
            <p className="sub" style={{ marginBottom: 0 }}>Digabung dengan status scan terkini setiap kali dibuka.</p>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button className="btn btn-ghost" onClick={toggleHistory}>
              {showHistory ? "Tutup Histori" : "🕓 Histori"}
            </button>
            <button
              className="btn btn-ghost"
              onClick={deleteAllWatchlist}
              disabled={deletingAll || !items || items.length === 0}
              style={{ color: "var(--red)", borderColor: "oklch(66% 0.20 22 / 0.35)" }}
            >
              {deletingAll ? "Menghapus..." : "🗑️ Hapus Semua"}
            </button>
          </div>
        </div>

        {error && <div className="error-box" style={{ marginTop: 12 }}>Gagal memuat watchlist: {error}</div>}
        {items === null && !error && <div className="state-box">Memuat watchlist...</div>}
        {items && items.length === 0 && <div className="state-box">Watchlist masih kosong — upload PDF atau cross-check pesan mentor untuk mulai isi.</div>}

        {items && items.length > 0 && (
          <div className="result-list" style={{ marginTop: 12 }}>
            {items.map((item) => (
              <WatchlistCard key={item.code} item={item} onRemove={removeFromWatchlist} />
            ))}
          </div>
        )}
      </div>

      {showHistory && (
        <div className="card">
          <h2>🕓 Histori Watchlist</h2>
          <p className="sub">
            Catatan setiap kali sebuah kode ditambahkan ke watchlist — kode, harga saat
            itu, tanggal, dan jam. 200 kejadian terakhir.
          </p>
          {historyError && <div className="error-box">Gagal memuat histori: {historyError}</div>}
          {history === null && !historyError && <div className="state-box">Memuat histori...</div>}
          {history && history.length === 0 && <div className="state-box">Belum ada histori penambahan watchlist.</div>}
          {history && history.length > 0 && (
            <div>
              {history.map((h) => (
                <div className="history-item" key={h.id}>
                  <div className="history-time">
                    {new Date(h.added_at).toLocaleDateString("id-ID")}{" "}
                    {new Date(h.added_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div className="history-msg">
                    <span className="code-tag">{h.code}</span>
                    {h.price != null ? ` Rp ${formatNumber(h.price)}` : " harga tidak tersedia"}
                    {" · "}
                    {SOURCE_LABEL[h.source] || h.source}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
