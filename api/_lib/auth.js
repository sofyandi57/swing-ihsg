// api/_lib/auth.js
// Helper bersama untuk endpoint yang butuh user login (bukan endpoint route
// sendiri — tidak ada default export handler, jadi Vercel tidak menganggapnya
// sebagai function/route terpisah).
//
// Dipakai di SEMUA endpoint selain api/admin.js (yang punya verifikasi admin
// sendiri, lebih ketat). Di sini cukup verifikasi: token valid → user memang
// login. Tidak mengecek status admin — endpoint biasa (screener, mentor-call,
// dst) boleh diakses siapa saja yang sudah login, bukan cuma admin.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function requireUser(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Supabase belum dikonfigurasi (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY kosong)." });
    return null;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "Belum login. Silakan login ulang." });
    return null;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "Sesi login tidak valid atau kedaluwarsa. Silakan login ulang." });
    return null;
  }

  return data.user;
}
