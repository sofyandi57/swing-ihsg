import { useEffect, useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";

const SETTINGS_LABELS = {
  min_volume_ratio: "Min Volume Ratio",
  min_prev_volume: "Min Prev Volume",
  min_price: "Min Price",
  top_n: "Top N Hasil",
  concurrency: "Concurrency Pool",
};

function UsersSection() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [createStatus, setCreateStatus] = useState("idle");
  const [createError, setCreateError] = useState("");

  async function loadUsers() {
    try {
      const resp = await authFetch("/api/admin?resource=users");
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setUsers(json.users || []);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setCreateStatus("loading");
    setCreateError("");
    try {
      const resp = await authFetch("/api/admin?resource=users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail, password: newPassword }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setNewEmail("");
      setNewPassword("");
      setCreateStatus("idle");
      loadUsers();
    } catch (e) {
      setCreateError(e.message);
      setCreateStatus("error");
    }
  }

  async function handleDelete(userId) {
    try {
      const resp = await authFetch(`/api/admin?resource=users&userId=${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      loadUsers();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="card">
      <h2>👤 Kelola User</h2>
      <p className="sub">Siapa saja yang boleh login ke aplikasi ini.</p>

      <form onSubmit={handleCreate} style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ minHeight: 40, flex: "1 1 160px" }}
            type="email"
            placeholder="Email user baru"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            required
          />
          <input
            className="input"
            style={{ minHeight: 40, flex: "1 1 140px" }}
            type="password"
            placeholder="Password (min 8 karakter)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        {createError && <div className="error-box">{createError}</div>}
        <button className="btn btn-primary btn-block" type="submit" disabled={createStatus === "loading"}>
          {createStatus === "loading" ? "Membuat..." : "+ Buat Akun"}
        </button>
      </form>

      {error && <div className="error-box">{error}</div>}
      {users === null && !error && <div className="state-box">Memuat daftar user...</div>}
      {users && users.length === 0 && <div className="state-box">Belum ada user.</div>}
      {users && users.length > 0 && (
        <div className="result-list">
          {users.map((u) => (
            <div className="result-card" key={u.id}>
              <div className="result-card-top">
                <span className="result-code" style={{ fontSize: 13 }}>{u.email}</span>
                <button className="btn btn-ghost" onClick={() => handleDelete(u.id)}>Hapus</button>
              </div>
              <div className="sub" style={{ marginBottom: 0 }}>
                Dibuat {new Date(u.createdAt).toLocaleDateString("id-ID")} · Login terakhir{" "}
                {u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleDateString("id-ID") : "belum pernah"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const EVENT_LABEL = {
  login: { text: "Login", cls: "cross-hit" },
  logout: { text: "Logout", cls: "cross-miss" },
};

function ActivitySection() {
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const resp = await authFetch("/api/admin?resource=activity");
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
        setActivity(json.activity || []);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  return (
    <div className="card">
      <h2>🕓 Aktivitas Login/Logout</h2>
      <p className="sub">200 kejadian terakhir — siapa login/logout, kapan.</p>
      {error && <div className="error-box">{error}</div>}
      {activity === null && !error && <div className="state-box">Memuat aktivitas...</div>}
      {activity && activity.length === 0 && <div className="state-box">Belum ada aktivitas tercatat.</div>}
      {activity && activity.length > 0 && (
        <div>
          {activity.map((a) => {
            const label = EVENT_LABEL[a.event] || { text: a.event, cls: "sub" };
            return (
              <div className="history-item" key={a.id}>
                <div className="history-time">
                  {new Date(a.created_at).toLocaleDateString("id-ID")}{" "}
                  {new Date(a.created_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}
                </div>
                <div className="history-msg">
                  <span style={{ fontWeight: 700 }}>{a.email}</span>{" "}
                  <span className={label.cls} style={{ marginTop: 0 }}>{label.text}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SettingsSection() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [savingKey, setSavingKey] = useState(null);
  const [draft, setDraft] = useState({});

  async function loadSettings() {
    try {
      const resp = await authFetch("/api/admin?resource=settings");
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setSettings(json.settings);
      setDraft(json.settings);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    loadSettings();
  }, []);

  async function saveOne(key) {
    setSavingKey(key);
    try {
      const resp = await authFetch("/api/admin?resource=settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: Number(draft[key]) }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      loadSettings();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="card">
      <h2>⚙️ Parameter Screener</h2>
      <p className="sub">
        Berlaku untuk scan berikutnya, tanpa perlu redeploy. Kosongkan lagi
        (hapus baris di tabel app_settings via Supabase) untuk kembali ke default kode.
      </p>

      {error && <div className="error-box">{error}</div>}
      {settings === null && !error && <div className="state-box">Memuat parameter...</div>}

      {settings &&
        Object.keys(SETTINGS_LABELS).map((key) => (
          <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <div className="result-metric-label" style={{ marginBottom: 4 }}>{SETTINGS_LABELS[key]}</div>
              <input
                className="input"
                style={{ minHeight: 36 }}
                type="number"
                step="any"
                value={draft[key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </div>
            <button
              className="btn btn-ghost"
              style={{ marginTop: 18 }}
              onClick={() => saveOne(key)}
              disabled={savingKey === key || Number(draft[key]) === settings[key]}
            >
              {savingKey === key ? "..." : "Simpan"}
            </button>
          </div>
        ))}
    </div>
  );
}

function HistorySection() {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const resp = await authFetch("/api/admin?resource=history");
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
        setHistory(json);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  return (
    <div className="card">
      <h2>📜 Histori Aktivitas</h2>
      {error && <div className="error-box">{error}</div>}
      {history === null && !error && <div className="state-box">Memuat histori...</div>}

      {history && (
        <>
          <div className="result-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginBottom: 14 }}>
            <div className="result-metric">
              <span className="result-metric-label">Total PDF Diupload</span>
              <span className="result-metric-value">{history.totalPdfExtracts}</span>
            </div>
            <div className="result-metric">
              <span className="result-metric-label">Item Watchlist</span>
              <span className="result-metric-value">{history.totalWatchlistItems}</span>
            </div>
          </div>

          <div className="result-metric-label" style={{ marginBottom: 6 }}>20 SCAN TERAKHIR</div>
          {history.recentRuns.map((r) => (
            <div className="history-item" key={r.id}>
              <div className="history-time">{new Date(r.scanned_at).toLocaleString("id-ID")}</div>
              <div>{r.total_scanned} saham dicek · {r.total_passed_filter} lolos filter · {(r.duration_ms / 1000).toFixed(1)}s</div>
            </div>
          ))}

          <div className="result-metric-label" style={{ margin: "14px 0 6px" }}>20 PESAN MENTOR TERAKHIR</div>
          {history.recentMentorCalls.map((c) => (
            <div className="history-item" key={c.id}>
              <div className="history-time">{new Date(c.received_at).toLocaleString("id-ID")}</div>
              <div>{c.raw_message}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function SecretsSection() {
  const [secrets, setSecrets] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const resp = await authFetch("/api/admin?resource=secrets");
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
        setSecrets(json.secrets);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  return (
    <div className="card">
      <h2>🔑 Status Environment Variable</h2>
      <p className="sub">Cuma status ada/tidak — nilai asli tidak pernah ditampilkan di sini.</p>
      {error && <div className="error-box">{error}</div>}
      {secrets === null && !error && <div className="state-box">Memuat status...</div>}
      {secrets && (
        <div className="result-list">
          {Object.entries(secrets).map(([key, isSet]) => (
            <div className="result-card" key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontFamily: "monospace" }}>{key}</span>
              <span className={isSet ? "cross-hit" : "cross-miss"} style={{ marginTop: 0 }}>
                {isSet ? "✓ Terpasang" : "✕ Kosong"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "Flush Kuota API" — tarik banyak dimensi data (chart, sektor, snapshot
// live) untuk saham yang paling direkomendasikan (dari histori scan
// terbaru) + sisa universe, dipacing sesuai rate limit Invezgo (230/menit,
// buffer aman di bawah limit resmi 250/menit), sampai budget waktu function
// (~280 detik) atau jumlah request yang diminta habis. TIDAK BISA "habiskan
// semua kuota sekaligus" dalam satu klik — rate limit + batas durasi
// serverless function bikin itu mustahil (lihat komentar lengkap di
// api/admin.js handleQuotaFlush) — klik beberapa kali kalau mau lanjutkan
// dalam sisa waktu sebelum reset kuota bulanan.
function QuotaGaugeSection() {
  const [status, setStatus] = useState("loading"); // loading | ok | error
  const [error, setError] = useState("");
  const [usage, setUsage] = useState(null);

  async function load() {
    setStatus("loading");
    setError("");
    try {
      const resp = await authFetch(`/api/admin?resource=quota-usage`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setUsage(json);
      setStatus("ok");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  useEffect(() => {
    load();
  }, []);

  const pct = usage && usage.limit ? Math.min(100, Math.round((usage.usage / usage.limit) * 100)) : null;
  const barColor = pct === null ? "#666" : pct >= 90 ? "#e5484d" : pct >= 70 ? "#f5a623" : "#3fb950";

  return (
    <div className="card">
      <h2>📊 Sisa Kuota API Invezgo</h2>
      {status === "loading" && <p className="sub">Memuat...</p>}
      {status === "error" && <div className="error-box">Gagal memuat kuota: {error}</div>}
      {status === "ok" && usage && (
        <>
          <div
            style={{
              width: "100%",
              height: 20,
              borderRadius: 10,
              background: "rgba(255,255,255,0.08)",
              overflow: "hidden",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: barColor,
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <div className="sub" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span>
              Terpakai: <b>{usage.usage.toLocaleString("id-ID")}</b> / {usage.limit.toLocaleString("id-ID")} ({pct}%)
            </span>
            <span>
              Sisa: <b>{usage.remaining.toLocaleString("id-ID")}</b>
            </span>
          </div>
          <div className="sub" style={{ marginTop: 4 }}>
            Reset: {new Date(usage.expire).toLocaleString("id-ID")}
            {usage.isBlocked ? " · ⚠️ STATUS: DIBLOKIR SEMENTARA" : ""}
          </div>
          <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={load}>
            🔄 Refresh
          </button>
        </>
      )}
    </div>
  );
}

function QuotaFlushSection() {
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState(null);
  const [maxRequests, setMaxRequests] = useState("");
  const [exportStatus, setExportStatus] = useState("idle");
  const [exportError, setExportError] = useState("");

  async function downloadCsv(url, filename) {
    const resp = await authFetch(url);
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      throw new Error(json.error || `HTTP ${resp.status}`);
    }
    const headers = {
      requestsUsed: resp.headers.get("X-Requests-Used"),
      codesProcessed: resp.headers.get("X-Codes-Processed"),
      codesTotal: resp.headers.get("X-Codes-Total"),
      rowsTotal: resp.headers.get("X-Rows-Total"),
    };
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
    return headers;
  }

  async function runFlush() {
    setStatus("loading");
    setError("");
    try {
      const params = new URLSearchParams();
      if (maxRequests) params.set("maxRequests", maxRequests);
      const headers = await downloadCsv(
        `/api/admin?resource=quota-flush${params.toString() ? "&" + params.toString() : ""}`,
        `invezgo-quota-flush-${Date.now()}.csv`
      );
      setLastResult(headers);
      setStatus("idle");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  async function runExport() {
    setExportStatus("loading");
    setExportError("");
    try {
      await downloadCsv(`/api/admin?resource=quota-flush&action=export`, `invezgo-quota-flush-export-${Date.now()}.csv`);
      setExportStatus("idle");
    } catch (e) {
      setExportError(e.message);
      setExportStatus("error");
    }
  }

  return (
    <div className="card">
      <h2>🚀 Flush Kuota API (Admin)</h2>
      <p className="sub">
        Tarik banyak dimensi data (chart 10 hari, sektor/subsektor, snapshot live: freq/bid/offer)
        untuk saham paling direkomendasikan (dari scan terbaru) + sisa universe, dipacing 230
        request/menit (buffer aman di bawah limit resmi Invezgo 250/menit) selama ~4-5 menit per
        klik. Klik beberapa kali untuk lanjutkan kalau belum habis — rate limit + batas durasi
        function bikin "sekali klik habis semua kuota" mustahil secara teknis.
      </p>
      <p className="sub">
        📅 <b>Otomatis via Vercel Cron</b>: jalan sendiri 1x/hari (jadwal di{" "}
        <code>vercel.json</code>) memakai secret <code>CRON_SECRET</code> (set env var ini di
        Vercel Project Settings). Paket Hobby membatasi cron maksimal 1x/hari — TIDAK bisa
        berulang tiap beberapa menit semalaman tanpa upgrade ke Pro. Setiap kali flush jalan
        (manual klik ATAU cron), hasilnya disimpan ke database — pakai tombol "Export" di bawah
        untuk unduh CSV dari data yang sudah terkumpul kapan saja, tanpa perlu jalankan flush baru.
      </p>
      <div style={{ marginBottom: 10 }}>
        <div className="result-metric-label" style={{ marginBottom: 6 }}>
          BATAS JUMLAH REQUEST (OPSIONAL — KOSONGKAN UNTUK PAKAI BUDGET WAKTU PENUH)
        </div>
        <input
          className="input"
          style={{ minHeight: 40 }}
          type="number"
          placeholder="Contoh: 1000"
          value={maxRequests}
          onChange={(e) => setMaxRequests(e.target.value)}
        />
      </div>
      {error && <div className="error-box">Gagal flush: {error}</div>}
      {lastResult && (
        <div className="cross-hit" style={{ marginBottom: 10 }}>
          ✓ Terakhir: {lastResult.requestsUsed} request terpakai, {lastResult.codesProcessed} dari{" "}
          {lastResult.codesTotal} kode diproses (tersimpan ke database).
        </div>
      )}
      <button className="btn btn-primary btn-block" onClick={runFlush} disabled={status === "loading"}>
        {status === "loading" ? "⏳ Menjalankan (bisa beberapa menit)..." : "📥 Jalankan & Download CSV"}
      </button>

      <div style={{ height: 12 }} />
      {exportError && <div className="error-box">Gagal export: {exportError}</div>}
      <button className="btn btn-ghost btn-block" onClick={runExport} disabled={exportStatus === "loading"}>
        {exportStatus === "loading" ? "⏳ Mengekspor..." : "📤 Export CSV dari Data Terkumpul (tanpa hit API)"}
      </button>
    </div>
  );
}

export default function AdminTab() {
  return (
    <>
      <UsersSection />
      <ActivitySection />
      <QuotaGaugeSection />
      <QuotaFlushSection />
      <SettingsSection />
      <SecretsSection />
      <HistorySection />
    </>
  );
}
