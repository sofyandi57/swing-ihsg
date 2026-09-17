import { useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

export default function LoginPage() {
  const [mode, setMode] = useState("login"); // login | register
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [error, setError] = useState("");
  const [registerNotice, setRegisterNotice] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("loading");
    setError("");
    setRegisterNotice("");

    if (mode === "login") {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        setStatus("error");
        return;
      }
      // Berhasil — App.jsx mendengarkan onAuthStateChange, tidak perlu redirect manual
    } else {
      // Daftar akun baru — user hasil signUp SELALU non-admin (tabel app_admins
      // hanya diisi manual oleh admin lewat SQL Editor), jadi aman dibuka untuk
      // teman-teman testing tanpa risiko mereka dapat akses panel Admin.
      const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
      if (signUpError) {
        setError(signUpError.message);
        setStatus("error");
        return;
      }
      if (data.session) {
        // Konfirmasi email nonaktif di project ini — langsung login otomatis
        return;
      }
      setRegisterNotice("Akun dibuat. Cek email untuk konfirmasi, lalu masuk di sini.");
      setStatus("idle");
      setMode("login");
    }
  }

  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="card" style={{ width: "100%", maxWidth: 360 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div className="app-badge" style={{ margin: "0 auto 12px" }}>📈</div>
          <h1 style={{ fontSize: 18, margin: 0 }}>Volume Scalping Screener</h1>
          <p className="sub" style={{ marginTop: 4 }}>
            {mode === "login" ? "Masuk untuk melanjutkan" : "Daftar akun baru"}
          </p>
        </div>

        {registerNotice && <div className="insight-box" style={{ marginBottom: 14 }}>{registerNotice}</div>}

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
              minLength={mode === "register" ? 6 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>

          {error && <div className="error-box">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={status === "loading"}>
            {status === "loading" ? "Memproses..." : mode === "login" ? "Masuk" : "Daftar"}
          </button>
        </form>

        <button
          className="btn btn-ghost btn-block"
          style={{ marginTop: 10 }}
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
            setRegisterNotice("");
          }}
        >
          {mode === "login" ? "Belum punya akun? Daftar di sini" : "Sudah punya akun? Masuk di sini"}
        </button>
      </div>
    </div>
  );
}
