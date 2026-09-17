// api/admin.js
// Vercel Serverless Function — semua operasi admin dalam satu endpoint, dipilah
// lewat query param `resource`. Setiap request WAJIB header:
//   Authorization: Bearer <access_token dari supabase.auth session di browser>
//
// Alur verifikasi: token → supabase.auth.getUser(token) untuk dapat email user
// yang login → cek email itu ada di tabel app_admins. TIDAK ada tabel role
// terpisah di Supabase Auth sendiri, jadi app_admins inilah satu-satunya sumber
// kebenaran siapa yang boleh akses resource selain `whoami`.
//
// GET  ?resource=whoami            — cek status login + admin (dipakai semua user)
// GET  ?resource=users             — daftar semua akun yang bisa login (admin only)
// POST ?resource=users             — buat akun baru { email, password } (admin only)
// DELETE ?resource=users&userId=x  — hapus akun (admin only)
// GET  ?resource=settings          — parameter screener saat ini (admin only)
// POST ?resource=settings          — update satu parameter { key, value } (admin only)
// GET  ?resource=history           — ringkasan scan_runs/mentor_calls/pdf_extracts terakhir (admin only)
// GET  ?resource=secrets           — status ADA/TIDAK env var penting, BUKAN nilainya (admin only)

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getRequestUser(req, supabase) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function isAdminEmail(supabase, email) {
  if (!email) return false;
  const { data } = await supabase.from("app_admins").select("email").eq("email", email).maybeSingle();
  return !!data;
}

async function handleWhoami(req, res, supabase) {
  const user = await getRequestUser(req, supabase);
  if (!user) {
    res.status(200).json({ loggedIn: false, isAdmin: false });
    return;
  }
  const admin = await isAdminEmail(supabase, user.email);
  res.status(200).json({ loggedIn: true, email: user.email, isAdmin: admin });
}

async function requireAdmin(req, res, supabase) {
  const user = await getRequestUser(req, supabase);
  if (!user) {
    res.status(401).json({ error: "Belum login." });
    return null;
  }
  const admin = await isAdminEmail(supabase, user.email);
  if (!admin) {
    res.status(403).json({ error: "Akun ini tidak punya akses admin." });
    return null;
  }
  return user;
}

async function handleUsers(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  if (req.method === "GET") {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    const users = data.users.map((u) => ({
      id: u.id,
      email: u.email,
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at,
    }));
    res.status(200).json({ users });
    return;
  }

  if (req.method === "POST") {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: "Field 'email' dan 'password' wajib diisi." });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password minimal 8 karakter." });
      return;
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    res.status(200).json({ id: data.user.id, email: data.user.email });
    return;
  }

  if (req.method === "DELETE") {
    const userId = req.query?.userId;
    if (!userId) {
      res.status(400).json({ error: "Parameter 'userId' wajib diisi." });
      return;
    }
    if (userId === admin.id) {
      res.status(400).json({ error: "Tidak bisa hapus akun sendiri yang sedang login." });
      return;
    }
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    res.status(200).json({ deleted: userId });
    return;
  }

  res.status(405).json({ error: "Method tidak didukung untuk resource 'users'." });
}

const SETTINGS_DEFAULTS = {
  min_volume_ratio: 3.0,
  min_prev_volume: 1_000_000,
  min_price: 50,
  top_n: 25,
  concurrency: 20,
};

async function handleSettings(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  if (req.method === "GET") {
    const { data, error } = await supabase.from("app_settings").select("key, value");
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    const overrides = Object.fromEntries((data || []).map((row) => [row.key, row.value]));
    res.status(200).json({ settings: { ...SETTINGS_DEFAULTS, ...overrides }, defaults: SETTINGS_DEFAULTS });
    return;
  }

  if (req.method === "POST") {
    const { key, value } = req.body || {};
    if (!key || !(key in SETTINGS_DEFAULTS)) {
      res.status(400).json({ error: `Key tidak dikenal. Pilihan valid: ${Object.keys(SETTINGS_DEFAULTS).join(", ")}` });
      return;
    }
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    res.status(200).json({ key, value });
    return;
  }

  res.status(405).json({ error: "Method tidak didukung untuk resource 'settings'." });
}

async function handleHistory(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  const [{ data: runs }, { data: mentorCalls }, { count: pdfCount }, { count: watchlistCount }] = await Promise.all([
    supabase.from("scan_runs").select("*").order("scanned_at", { ascending: false }).limit(20),
    supabase.from("mentor_calls").select("*").order("received_at", { ascending: false }).limit(20),
    supabase.from("pdf_extracts").select("id", { count: "exact", head: true }),
    supabase.from("watchlist").select("code", { count: "exact", head: true }),
  ]);

  res.status(200).json({
    recentRuns: runs || [],
    recentMentorCalls: mentorCalls || [],
    totalPdfExtracts: pdfCount || 0,
    totalWatchlistItems: watchlistCount || 0,
  });
}

async function handleSecrets(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  // HANYA status ada/tidak — nilai asli TIDAK PERNAH dikirim ke browser.
  res.status(200).json({
    secrets: {
      INVEZGO_API_KEY: !!process.env.INVEZGO_API_KEY,
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY,
      GROQ_API_KEY: !!process.env.GROQ_API_KEY,
      VITE_SUPABASE_URL: !!process.env.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: !!process.env.VITE_SUPABASE_ANON_KEY,
    },
  });
}

export default async function handler(req, res) {
  const supabase = getAdminClient();
  if (!supabase) {
    res.status(500).json({ error: "Supabase belum dikonfigurasi (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY kosong)." });
    return;
  }

  const resource = req.query?.resource;

  switch (resource) {
    case "whoami":
      await handleWhoami(req, res, supabase);
      return;
    case "users":
      await handleUsers(req, res, supabase);
      return;
    case "settings":
      await handleSettings(req, res, supabase);
      return;
    case "history":
      await handleHistory(req, res, supabase);
      return;
    case "secrets":
      await handleSecrets(req, res, supabase);
      return;
    default:
      res.status(400).json({ error: "Parameter 'resource' tidak valid. Pilihan: whoami, users, settings, history, secrets." });
  }
}
