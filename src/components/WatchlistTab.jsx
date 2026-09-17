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

function WatchlistCard({ item }) {
  const scan = item.latestScan;
  const isHot = scan && scan.passedFilter;

  return (
    <div className="result-card">
      <div className="result-card-top">
        <span className="result-code">{item.code}</span>
        <span className="ratio-pill" style={{ background: "var(--panel)", color: "var(--muted)" }}>
          {SOURCE_LABEL[item.source] || item.source}
        </span>
      </div>
      {item.notes && <div className="sub" style={{ marginBottom: 8 }}>{item.notes}</div>}
      {scan ? (
        <div className={isHot ? "cross-hit" : "cross-miss"}>
          {isHot ? "✓" : "—"} Ratio {Number(scan.volumeRatio).toFixed(2)}x, harga {formatNumber(scan.price)},{" "}
          {isHot ? "lolos filter sekarang" : "belum lolos filter"} · terakhir scan{" "}
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
        <h2>⭐ Watchlist Aktif</h2>
        <p className="sub">Digabung dengan status scan terkini setiap kali dibuka.</p>

        {error && <div className="error-box">Gagal memuat watchlist: {error}</div>}
        {items === null && !error && <div className="state-box">Memuat watchlist...</div>}
        {items && items.length === 0 && <div className="state-box">Watchlist masih kosong — upload PDF atau cross-check pesan mentor untuk mulai isi.</div>}

        {items && items.length > 0 && (
          <div className="result-list">
            {items.map((item) => (
              <WatchlistCard key={item.code} item={item} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
