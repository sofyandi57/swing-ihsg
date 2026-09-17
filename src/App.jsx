import { useEffect, useState } from "react";
import ScanTab from "./components/ScanTab.jsx";
import MentorTab from "./components/MentorTab.jsx";
import WatchlistTab from "./components/WatchlistTab.jsx";
import ChartTab from "./components/ChartTab.jsx";
import DashboardTab from "./components/DashboardTab.jsx";
import AdminTab from "./components/AdminTab.jsx";
import LoginPage from "./components/LoginPage.jsx";
import { supabase, authFetch, isSupabaseConfigured } from "./lib/supabaseClient.js";

const BASE_TABS = [
  { id: "scan", label: "Run Scan", icon: "⚡" },
  { id: "chart", label: "Chart", icon: "📊" },
  { id: "dashboard", label: "Conviction", icon: "🧭" },
  { id: "mentor", label: "Mentor", icon: "💬" },
  { id: "watchlist", label: "Watchlist", icon: "⭐" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("scan");
  const [session, setSession] = useState(undefined); // undefined = belum dicek, null = belum login
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured) return; // tampilkan pesan konfigurasi di bawah, jangan panggil auth sama sekali
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) setIsAdmin(false);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const resp = await authFetch("/api/admin?resource=whoami");
        const json = await resp.json();
        setIsAdmin(!!json.isAdmin);
      } catch (e) {
        setIsAdmin(false);
      }
    })();
  }, [session]);

  if (!isSupabaseConfigured) {
    return (
      <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div className="card" style={{ maxWidth: 420 }}>
          <h2>⚠️ Konfigurasi Belum Lengkap</h2>
          <p className="sub" style={{ marginBottom: 0 }}>
            Environment variable <code>VITE_SUPABASE_URL</code> dan/atau{" "}
            <code>VITE_SUPABASE_ANON_KEY</code> belum diset di Vercel. Login tidak bisa
            jalan tanpa ini. Set keduanya di Project Settings → Environment Variables
            (ambil dari Supabase Dashboard → Project Settings → API — pakai anon/public
            key, bukan service_role), lalu redeploy.
          </p>
        </div>
      </div>
    );
  }

  if (session === undefined) {
    return (
      <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="spinner" />
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  const tabs = BASE_TABS;

  return (
    <>
      <header className="app-header">
        <div className="app-title">
          <h1>Volume Scalping Screener</h1>
          <span>{session.user.email}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {isAdmin && (
            <button
              className="btn btn-ghost"
              title="Admin"
              style={{ padding: "6px 8px", fontSize: 12, minHeight: "auto" }}
              onClick={() => setActiveTab("admin")}
            >
              🛠️
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => supabase.auth.signOut()}>
            Logout
          </button>
        </div>
      </header>

      {/* Nav diletakkan SEBELUM <main> di DOM (bukan sesudah) supaya di layar
          tablet/desktop — di mana .tabbar bukan lagi position:fixed, lihat
          styles.css — posisinya konsisten tepat di bawah header, bukan ikut
          urutan alami setelah konten <main> yang tingginya beda-beda per tab
          (form scan pendek vs chat panjang), yang sebelumnya bikin nav
          kelihatan "loncat-loncat" pindah lokasi antar halaman. Di mobile,
          position:fixed membuat urutan DOM ini tidak berpengaruh visual. */}
      <nav className="tabbar">
        <div className="tabbar-inner">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab-btn${activeTab === tab.id ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="tab-icon">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <main>
        <div style={{ display: activeTab === "scan" ? "block" : "none" }}>
          <ScanTab />
        </div>
        <div style={{ display: activeTab === "chart" ? "block" : "none" }}>
          <ChartTab />
        </div>
        <div style={{ display: activeTab === "dashboard" ? "block" : "none" }}>
          <DashboardTab />
        </div>
        <div style={{ display: activeTab === "mentor" ? "block" : "none" }}>
          <MentorTab />
        </div>
        <div style={{ display: activeTab === "watchlist" ? "block" : "none" }}>
          <WatchlistTab />
        </div>
        {isAdmin && (
          <div style={{ display: activeTab === "admin" ? "block" : "none" }}>
            <AdminTab />
          </div>
        )}
      </main>
    </>
  );
}
