import { useState } from "react";
import ScanTab from "./components/ScanTab.jsx";
import MentorTab from "./components/MentorTab.jsx";

const TABS = [
  { id: "scan", label: "Run Scan", icon: "⚡" },
  { id: "mentor", label: "Mentor", icon: "💬" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("scan");

  return (
    <>
      <header className="app-header">
        <div className="app-title">
          <h1>Volume Scalping Screener</h1>
          <span>IDX · powered by Invezgo</span>
        </div>
        <div className="app-badge">📈</div>
      </header>

      <main>
        <div style={{ display: activeTab === "scan" ? "block" : "none" }}>
          <ScanTab />
        </div>
        <div style={{ display: activeTab === "mentor" ? "block" : "none" }}>
          <MentorTab />
        </div>
      </main>

      <nav className="tabbar">
        <div className="tabbar-inner">
          {TABS.map((tab) => (
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
