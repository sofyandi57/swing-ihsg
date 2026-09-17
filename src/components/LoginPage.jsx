import { useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("loading");
    setError("");

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(signInError.message);
      setStatus("error");
      return;
    }
    // Berhasil — App.jsx mendengarkan onAuthStateChange, tidak perlu redirect manual
  }

  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="card" style={{ width: "100%", maxWidth: 360 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div className="app-badge" style={{ margin: "0 auto 12px" }}>📈</div>
          <h1 style={{ fontSize: 18, margin: 0 }}>Volume Scalping Screener</h1>
          <p className="sub" style={{ marginTop: 4 }}>Masuk untuk melanjutkan</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 10 }}>
            <div className="result-metric-label" style={{ marginBottom: 6 }}>EMAIL</div>
            <input
              className="input"
              style={{ minHeight: 44 }}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <div className="result-metric-label" style={{ marginBottom: 6 }}>PASSWORD</div>
            <input
              className="input"
              style={{ minHeight: 44 }}
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          {error && <div className="error-box">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={status === "loading"}>
            {status === "loading" ? "Masuk..." : "Masuk"}
          </button>
        </form>

        <p className="sub" style={{ marginTop: 14, marginBottom: 0, textAlign: "center" }}>
          Belum punya akun? Hubungi admin untuk dibuatkan.
        </p>
      </div>
    </div>
  );
}
