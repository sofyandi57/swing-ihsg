import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// anon key AMAN untuk frontend — bukan service_role. Kalau ini kosong, login
// tidak akan bisa jalan; pesan error jelas di console daripada gagal diam-diam.
if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY belum diset — login tidak akan berfungsi. " +
      "Set kedua env var ini di Vercel (Project Settings → Environment Variables)."
  );
}

export const supabase = createClient(supabaseUrl || "", supabaseAnonKey || "");

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
