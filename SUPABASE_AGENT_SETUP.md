# SUPABASE_AGENT_SETUP.md

Briefing untuk agent (browser/Chrome) yang akan menyiapkan **database Supabase**
untuk project **swing-ihsg**. Agent ini bekerja lewat Supabase Dashboard di browser.
Jangan menebak — kalau ada percabangan keputusan di bawah, cek dulu kondisi
aktualnya di dashboard sebelum lanjut.

---

## 0. Cek dulu: sudah ada project Supabase atau belum?

Buka https://supabase.com/dashboard

- **Kalau sudah ada project** (biasanya bernama mirip `swing-ihsg` / `invezgo-screener`
  / sejenisnya) → lanjut ke **Section 2** (jalankan schema di project yang sudah ada).
- **Kalau belum ada project sama sekali** → lanjut ke **Section 1** dulu (buat project
  baru), baru ke Section 2.

## 1. Buat project Supabase baru (skip kalau sudah ada)

1. Di dashboard, klik **New Project**.
2. **Name**: `swing-ihsg` (atau nama lain yang jelas — konsisten dengan nama repo
   supaya tidak bingung nanti).
3. **Database Password**: generate password kuat, **simpan di tempat aman** (password
   manager User) — dibutuhkan lagi kalau nanti perlu akses langsung via `psql`.
4. **Region**: pilih yang paling dekat dengan traffic (Singapore — `ap-southeast-1`
   — paling masuk akal untuk user IDX/Indonesia, latensi rendah ke Vercel juga kalau
   Vercel deploy region default).
5. **Pricing Plan**: Free tier cukup untuk tahap awal (500MB storage, cukup untuk
   histori scan harian dalam skala bulanan).
6. Klik **Create new project**, tunggu provisioning (~2 menit).

## 2. Jalankan schema.sql

1. Di project Supabase (baru atau existing), buka **SQL Editor** (ikon di sidebar kiri).
2. Klik **New query**.
3. Copy **seluruh isi** file `supabase/schema.sql` dari repo GitHub
   `sofyandi57/swing-ihsg` (branch `claude/tender-darwin-jzi6dv`, atau `main` kalau
   sudah di-merge) — path: `supabase/schema.sql`.
4. Paste ke SQL Editor, klik **Run** (atau Ctrl/Cmd+Enter).
5. Harus sukses tanpa error. Script ini **aman dijalankan berkali-kali** (semua
   `create table if not exists` / `create index if not exists`) — kalau tabel sudah
   ada, tidak akan menimpa data yang sudah ada.
6. Verifikasi: buka tab **Table Editor** di sidebar, pastikan 7 tabel ini muncul:
   - `scan_runs`
   - `scan_results`
   - `mentor_calls`
   - `pdf_extracts`
   - `watchlist`
   - `app_admins`
   - `app_settings`

## 3. Aktifkan fitur Login — buat akun pertama + jadikan admin

Fitur login pakai **Supabase Auth bawaan** (bukan tabel custom). Langkahnya:

1. Di sidebar, buka **Authentication** → **Users** → **Add user** → **Create new user**.
2. Isi email dan password User sendiri, centang **Auto Confirm User** (supaya tidak
   perlu verifikasi email dulu).
3. Buka **SQL Editor**, jalankan (ganti dengan email yang baru dibuat):
   ```sql
   insert into app_admins (email) values ('email_user_disini@contoh.com');
   ```
   Ini WAJIB — tanpa baris ini, akun bisa login tapi tab **Admin** di aplikasi
   tidak akan muncul (tidak dianggap admin).
4. Kalau nanti User minta tambah akun lain (tim/partner) yang JUGA admin, ulangi
   langkah 3 dengan email itu. Kalau cuma mau bisa login (bukan admin), cukup
   langkah 1-2 saja tanpa insert ke `app_admins`.

## 4. Ambil kredensial untuk dipasang di Vercel

1. Di sidebar, buka **Project Settings** (ikon gear) → **API**.
2. Catat dua nilai ini (untuk `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY`):
   - **Project URL** → ini nilai untuk env var `SUPABASE_URL` di Vercel.
   - **service_role key** (di bagian "Project API keys") → ini nilai untuk env var
     `SUPABASE_SERVICE_ROLE_KEY` di Vercel.

   **PENTING**: Ada dua key di halaman itu — `anon` `public` dan `service_role`.
   **PAKAI service_role**, BUKAN anon. Service_role diperlukan supaya server (Vercel
   functions) bisa insert data tanpa terhalang Row Level Security. JANGAN taruh
   service_role key di kode frontend/browser manapun — hanya untuk environment
   variable server-side di Vercel.

3. Masukkan kedua nilai ini ke Vercel Project Settings → Environment Variables
   (lihat `VERCEL_AGENT_SETUP.md` section 3 di repo yang sama untuk detail
   lengkapnya — `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY`).
4. Di halaman API yang sama, catat juga **anon/public key** (bukan service_role) →
   jadi env var `VITE_SUPABASE_ANON_KEY` di Vercel, dan Project URL yang sama →
   jadi env var `VITE_SUPABASE_URL` (nilainya identik dengan `SUPABASE_URL`, tapi
   harus diisi terpisah dengan prefix `VITE_` supaya sampai ke frontend). Ini
   WAJIB supaya fitur login jalan — lihat `VERCEL_AGENT_SETUP.md` untuk detail.

## 5. Row Level Security — sudah dihandle otomatis oleh schema.sql

`schema.sql` sudah mengaktifkan RLS di semua tabel di baris terakhirnya
(`alter table ... enable row level security`), TANPA policy untuk `anon`/
`authenticated`. Ini disengaja: aplikasi hanya menulis lewat `service_role` key
di server (yang otomatis bypass RLS) dan tidak ada akses langsung dari browser ke
Supabase. **Jangan tambahkan policy RLS apa pun** kecuali User memintanya secara
eksplisit — menambah policy tanpa alasan jelas berisiko membuka akses baca/tulis
yang tidak diinginkan dari luar.

## 6. Yang TIDAK perlu dilakukan agent ini

- **Jangan** ubah/hapus tabel yang sudah ada isinya kalau ini project Supabase
  existing dengan data histori — `schema.sql` sudah idempotent, cukup dijalankan
  ulang apa adanya.
- **Jangan** buat tabel tambahan di luar yang ada di `schema.sql`.
- **Jangan** expose `service_role` key di tempat manapun selain env var Vercel
  (jangan commit ke git, jangan taruh di kode, jangan share di chat/screenshot publik).
- **Jangan** ubah region/plan project existing tanpa User minta eksplisit.

---

**Kontak balik**: kalau `schema.sql` gagal jalan (error SQL), atau tidak yakin ini
project baru vs existing, laporkan ke User dengan pesan error lengkapnya — jangan
menebak atau modifikasi schema sendiri.
