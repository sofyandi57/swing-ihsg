// api/_lib/invezgoPause.js
// Helper bersama — kill-switch darurat GLOBAL (toggle "⏸️ Pause Invezgo" di
// Admin panel, card gauge kuota). Dipakai di SEMUA endpoint yang memanggil
// Invezgo, tanpa kecuali — sebelumnya cuma dipasang di screener.js/admin.js/
// stock-chart.js, User menemukan tab Conviction (dashboard.js) masih tembus
// karena belum ikut dipasangi. Taruh di _lib (bukan file api/*.js baru)
// supaya tidak nambah hitungan Serverless Function Vercel Hobby.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function isInvezgoPaused() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await supabase.from("app_settings").select("value").eq("key", "invezgo_paused").maybeSingle();
    return data?.value === true;
  } catch (e) {
    return false;
  }
}

// Dipanggil di awal handler, SEBELUM request Invezgo pertama. Mengirim
// respons 503 sendiri kalau paused (return true), jadi caller cukup:
//   if (await rejectIfInvezgoPaused(req, res)) return;
export async function rejectIfInvezgoPaused(req, res) {
  if (await isInvezgoPaused()) {
    res.status(503).json({ error: "Invezgo API sedang di-pause dari Admin panel." });
    return true;
  }
  return false;
}
