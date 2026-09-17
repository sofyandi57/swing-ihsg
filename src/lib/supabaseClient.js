import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = !!(supabaseUrl && supabaseAnonKey);

// anon key AMAN untuk frontend — bukan service_role. Kalau env var ini kosong,
// login tidak akan bisa jalan — tapi PENTING: createClient() dari supabase-js
// throw SYNCHRONOUS kalau URL-nya kosong/tidak valid (new URL("") invalid),
// yang me-crash SELURUH modul React sebelum sempat render apa pun (layar jadi
// hitam polos, tanpa pesan error yang terlihat — cuma masuk ke console).
// Pakai URL placeholder yang valid secara format supaya createClient() tidak
// crash; App.jsx yang menampilkan pesan "belum dikonfigurasi" ke pengguna
// lewat isSupabaseConfigured, bukan lewat exception yang tidak tertangkap.
if (!isSupabaseConfigured) {
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY belum diset — login tidak akan berfungsi. " +
      "Set kedua env var ini di Vercel (Project Settings → Environment Variables)."
  );
}

export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder-anon-key"
);

export async function authFetch(url, options = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
