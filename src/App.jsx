import { useEffect, useState } from "react";
import ScanTab from "./components/ScanTab.jsx";
import MentorTab from "./components/MentorTab.jsx";
import WatchlistTab from "./components/WatchlistTab.jsx";
import ChartTab from "./components/ChartTab.jsx";
import AdminTab from "./components/AdminTab.jsx";
import LoginPage from "./components/LoginPage.jsx";
import { supabase, authFetch } from "./lib/supabaseClient.js";

const BASE_TABS = [
  { id: "scan", label: "Run Scan", icon: "⚡" },
  { id: "chart", label: "Chart", icon: "📊" },
  { id: "mentor", label: "Mentor", icon: "💬" },
  { id: "watchlist", label: "Watchlist", icon: "⭐" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("scan");
  const [session, setSession] = useState(undefined); // undefined = belum dicek, null = belum login
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
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

  const tabs = isAdmin ? [...BASE_TABS, { id: "admin", label: "Admin", icon: "🛠️" }] : BASE_TABS;

  return (
    <>
      <header className="app-header">
        <div className="app-title">
          <h1>Volume Scalping Screener</h1>
          <span>{session.user.email}</span>
        </div>
        <button className="btn btn-ghost" onClick={() => supabase.auth.signOut()}>
          Logout
        </button>
      </header>

      <main>
        <div style={{ display: activeTab === "scan" ? "block" : "none" }}>
          <ScanTab />
        </div>
        <div style={{ display: activeTab === "chart" ? "block" : "none" }}>
          <ChartTab />
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
    </>
  );
}
