import { useEffect, useRef, useState } from "react";
import { authFetch } from "../lib/supabaseClient.js";

const WELCOME = {
  role: "assistant",
  content:
    "Halo! Saya asisten chat aplikasi ini — bisa jawab pertanyaan soal hasil scan terakhir, watchlist, atau saham tertentu (sebut kodenya, misal BBCA). Saya baca data yang benar-benar ada di aplikasi, bukan mengarang. Ini bukan rekomendasi transaksi.",
};

export default function ChatTab() {
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [error, setError] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  async function sendMessage(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || status === "loading") return;

    const nextMessages = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setStatus("loading");
    setError("");

    try {
      // Kirim histori TANPA pesan welcome (itu cuma tampilan lokal, bukan
      // bagian percakapan asli dengan Groq)
      const historyForApi = nextMessages.filter((m) => m !== WELCOME);
      const resp = await authFetch("/api/chatbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyForApi }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      setMessages((prev) => [...prev, { role: "assistant", content: json.reply }]);
      setStatus("idle");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100dvh - 220px)" }}>
      <div className="card" style={{ marginBottom: 8 }}>
        <h2>💭 Chat Asisten</h2>
        <p className="sub" style={{ marginBottom: 0 }}>
          Tahu data hasil scan, watchlist, dan histori mentor di aplikasi ini — bukan chat umum.
        </p>
      </div>

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "4px 2px" }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%",
              background: m.role === "user" ? "var(--accent-bg)" : "var(--panel-2)",
              color: m.role === "user" ? "var(--accent)" : "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 14,
              padding: "10px 14px",
              fontSize: 13.5,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {m.content}
          </div>
        ))}
        {status === "loading" && (
          <div style={{ alignSelf: "flex-start", padding: "10px 14px" }}>
            <div className="spinner" style={{ margin: 0, width: 18, height: 18 }} />
          </div>
        )}
        {error && <div className="error-box">Gagal kirim pesan: {error}</div>}
        <div ref={scrollRef} />
      </div>

      <form onSubmit={sendMessage} style={{ display: "flex", gap: 8, paddingTop: 8 }}>
        <input
          className="input"
          style={{ minHeight: 44, flex: 1 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tanya soal hasil scan, watchlist, atau saham..."
        />
        <button className="btn btn-primary" type="submit" style={{ minHeight: 44 }} disabled={status === "loading" || !input.trim()}>
          Kirim
        </button>
      </form>
    </div>
  );
}
