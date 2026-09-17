# VERCEL_AGENT_SETUP.md

Briefing untuk agent (browser/Chrome, atau agent dengan akses Vercel
MCP/CLI) yang mengoperasikan **Vercel dashboard** untuk project
**swing-ihsg**. Tugas: import repo, set env vars, deploy, verifikasi,
dan — sejak fitur "Flush Kuota API" ditambahkan — pastikan **Vercel Cron**
terkonfigurasi benar. Jangan menebak nilai apa pun yang tidak ada di sini —
tanyakan ke User kalau ada langkah yang butuh keputusan (misal nama domain
custom).

Dokumen ini adalah **satu-satunya sumber kebenaran** soal state Vercel yang
DIHARAPKAN saat ini. Kalau tugasnya "redeploy", "cek env var", "pastikan
cron jalan", dsb., dokumen ini cukup untuk menyelesaikannya sendiri tanpa
bertanya balik ke User soal apa saja yang berubah sejak setup awal.

---

## 1. Sumber kode

- **Repo GitHub**: `sofyandi57/swing-ihsg`
- **Branch aktif dikerjakan**: `claude/tender-darwin-jzi6dv` — cek dulu commit
  terbaru sebelum asumsi ini masih branch yang benar; kalau User sudah
  merge ke `main`, pakai `main` sebagai source branch.

## 2. Langkah import project di Vercel (skip kalau project sudah ada)

1. Buka https://vercel.com/new
2. Pilih **Import Git Repository** → cari `sofyandi57/swing-ihsg` → **Import**.
   (Kalau repo belum muncul di daftar, klik "Adjust GitHub App Permissions" dan
   pastikan akses ke repo ini diberikan.)
3. **Framework Preset**: Vercel akan auto-detect **Vite**. Kalau tidak otomatis,
   set manual:
   - Build Command: `vite build` (atau biarkan default `npm run build`)
   - Output Directory: `dist`
   - Install Command: default (`npm install`)
4. **Root Directory**: biarkan default (`.`) — project ada di root repo, bukan subfolder.
5. **Branch**: pilih branch aktif (Section 1) sebelum deploy pertama.

## 3. Environment Variables — WAJIB diisi sebelum deploy pertama

Masuk ke tab **Environment Variables** saat setup (atau nanti di Project Settings →
Environment Variables). Isi variabel ini, scope **Production, Preview, Development**
(centang semua):

| Key | Wajib? | Keterangan |
|---|---|---|
| `INVEZGO_API_KEY` | **Wajib** | Tanpa ini, endpoint scan (`api/screener.js`, dan sub-resource `check-stock` di `api/mentor-call.js`) akan gagal total (500 error). |
| `SUPABASE_URL` | **Wajib** | Dari Supabase Dashboard → Project Settings → API. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Wajib** | Dari Supabase Dashboard → Project Settings → API. **PAKAI service_role key, BUKAN anon/public key** — service_role diperlukan untuk insert data dari server. JANGAN PERNAH taruh key ini di kode frontend. |
| `GROQ_API_KEY` | Opsional | Tanpa ini, semua fitur AI (chatbot, ekstraksi kode saham dari pesan mentor/PDF, AI Insight/Bantuan AI di tab Run Scan) tetap jalan tapi fallback ke regex-only / insight kosong — tidak error, hanya kurang pintar. |
| `VITE_SUPABASE_URL` | **Wajib** untuk fitur login | Sama nilainya dengan `SUPABASE_URL` di atas — tapi harus diisi TERPISAH dengan prefix `VITE_` supaya Vite meng-expose-nya ke kode frontend (browser). Tanpa ini, halaman login gagal total (layar hitam, lihat `src/lib/supabaseClient.js`). |
| `VITE_SUPABASE_ANON_KEY` | **Wajib** untuk fitur login | Dari Supabase Dashboard → Project Settings → API — **PAKAI anon/public key di sini, BUKAN service_role**. anon key memang didesain aman dipakai di browser. |
| `CRON_SECRET` | **Wajib** untuk fitur "Flush Kuota API" (Admin) | **Buat sendiri** — string acak yang panjang, BUKAN dari Supabase/Invezgo. Vercel otomatis mengirim ini sebagai header `Authorization: Bearer <CRON_SECRET>` setiap kali Vercel Cron memanggil `/api/admin?resource=quota-flush` (lihat Section 6). Tanpa ini, cron akan selalu gagal auth (401/403) — fitur manual klik di panel Admin tetap jalan normal tanpa env var ini (pakai token login biasa). |

Nilai aktual dari key-key ini **User sudah punya** (pernah di-generate sebelumnya, lihat
`.env.example` di repo untuk format) — KECUALI `CRON_SECRET` yang memang harus dibuat baru.
Kalau agent tidak tahu nilai yang lain, **STOP dan minta User paste nilainya** — jangan
isi dengan placeholder atau string kosong.

## 4. Deploy

1. Klik **Deploy** (atau **Redeploy** untuk deployment existing setelah env var berubah —
   env var baru TIDAK otomatis berlaku di deployment lama, wajib redeploy).
2. Tunggu build selesai (~1-2 menit untuk Vite build).
3. Kalau build gagal, cek log:
   - Error `Cannot find module` → kemungkinan `package.json`/`package-lock.json`
     tidak lengkap ter-commit, laporkan ke User, jangan coba modifikasi kode dari
     browser.
   - Error `"No more than 12 Serverless Functions can be added..."` (Hobby plan) →
     project ini SENGAJA dijaga persis di 12 file `api/*.js` (batas Hobby plan) —
     kalau ada penambahan fitur baru yang butuh endpoint baru, endpoint itu
     seharusnya digabung sebagai sub-resource di file `api/*.js` yang sudah ada
     (lihat pola `?resource=` di `api/admin.js` atau `?action=` di
     `api/mentor-call.js`), BUKAN file baru. Kalau error ini muncul, berarti ada
     file `api/*.js` baru yang seharusnya digabung — laporkan ke User, jangan
     hapus file existing sendiri untuk "membuat ruang".
   - Error terkait environment variable kosong saat runtime (bukan build time) itu
     NORMAL sampai Section 3 di atas diisi lengkap — functions (`api/*.js`) baru
     dipanggil saat user berinteraksi di browser, bukan saat build.

## 5. Verifikasi setelah deploy sukses

1. Buka domain `*.vercel.app` yang diberikan Vercel.
2. Pastikan UI React (dark theme, bottom-nav: Run Scan/Chart/Conviction/Mentor/
   Watchlist) muncul dengan benar.
3. Klik **Run Scan** — kalau `INVEZGO_API_KEY` benar, proses scan berjalan dan
   hasil muncul sebagai card list. Kalau error 500, cek kembali env var di Section 3.
4. Cek tab **Mentor** — paste contoh pesan, pastikan cross-check jalan (butuh
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` benar).
5. Login sebagai admin (email harus sudah ada di tabel `app_admins` — lihat
   `SUPABASE_AGENT_SETUP.md` Section 4) → ikon 🛠️ di header → panel Admin harus
   muncul dengan section "Flush Kuota API" — ini konfirmasi env var lengkap
   sampai `CRON_SECRET`.

## 6. Vercel Cron — fitur "Flush Kuota API"

Sejak fitur ini ditambahkan, project ini **PUNYA SATU cron job** (bukan lagi
murni run-on-demand seperti versi awal) — dikonfigurasi di `vercel.json`
bagian `"crons"`, memanggil `/api/admin?resource=quota-flush` untuk
mengumpulkan data multi-dimensi saham secara otomatis.

1. **Verifikasi cron terdaftar**: Project Settings → **Cron Jobs** di dashboard
   Vercel. Harus muncul satu entry mengarah ke `/api/admin?resource=quota-flush`.
   Kalau tidak muncul padahal `vercel.json` sudah berisi blok `"crons"`,
   kemungkinan deployment belum di-refresh — redeploy dulu (Vercel membaca
   ulang konfigurasi cron setiap deploy, bukan real-time).
2. **Batasan paket Hobby**: cron di paket Hobby dibatasi maksimal **1x/hari**,
   apa pun jadwal cron expression yang ditulis di `vercel.json` — Vercel akan
   otomatis menyesuaikan/menolak jadwal yang lebih sering. Ini BUKAN bug kalau
   User mengeluh "cron tidak jalan tiap beberapa menit" — jelaskan batasan ini,
   jangan coba akali dengan trik lain di sisi Vercel (butuh upgrade plan Pro
   kalau memang perlu jadwal lebih sering).
3. **Auth cron**: cron TIDAK memakai sesi login browser — otorisasinya lewat
   env var `CRON_SECRET` (Section 3). Kalau env var ini belum diset, cron akan
   selalu gagal (401/403) meski terdaftar dan terjadwal benar — cek log
   invocation di tab **Cron Jobs** kalau ada laporan "cron gagal".
4. Fitur cron ini HANYA untuk resource `quota-flush` — TIDAK ada polling/cron
   lain di project ini untuk fitur apa pun (scan, mentor, chatbot, dst tetap
   run-on-demand murni, tombol manual).

## 7. Yang TIDAK boleh dilakukan agent ini

- **Jangan** membuat project Supabase baru dari sini — itu tugas terpisah,
  lihat `SUPABASE_AGENT_SETUP.md`.
- **Jangan** mengubah kode di repo GitHub dari sisi Vercel dashboard.
- **Jangan** menambah cron job LAIN di luar yang sudah didefinisikan di
  `vercel.json` — kalau User minta fitur otomatis baru, itu perlu perubahan
  kode (`vercel.json` + endpoint-nya) lewat sesi Claude Code, bukan diatur
  manual dari dashboard Vercel (config cron dari dashboard tidak akan
  ke-commit ke repo, jadi akan hilang di deploy berikutnya).
- **Jangan** menaikkan `maxDuration` fungsi mana pun di luar yang sudah diatur
  di `vercel.json` tanpa User minta eksplisit — ini juga berarti perubahan
  kode, bukan pengaturan dashboard.
- **Jangan** set custom domain kecuali User memintanya secara eksplisit dengan
  nama domain yang jelas.

## 8. Langkah setelah ini (bukan tugas agent Vercel — dikerjakan terpisah)

Setelah deploy Vercel sukses, **database Supabase** perlu disiapkan/
disinkronkan lewat `supabase/schema.sql` — lihat `SUPABASE_AGENT_SETUP.md`
untuk daftar lengkap tabel yang harus ada dan cara verifikasinya. Ini
dikerjakan lewat sesi/agent terpisah (butuh kredensial Supabase User), bukan
lewat agent Chrome/Vercel ini.

---

**Kontak balik**: kalau ada langkah yang gagal atau butuh keputusan (nama
domain, apakah reuse project Vercel lama, upgrade plan untuk cron lebih
sering, dsb.), laporkan ke User — jangan menebak.
