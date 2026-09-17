# VERCEL_AGENT_SETUP.md

Briefing untuk agent (browser/Chrome) yang akan mengoperasikan **Vercel dashboard**
untuk membuat infrastruktur website project **swing-ihsg**. Agent ini bekerja lewat
UI Vercel di browser — bukan lewat kode. Tugas: import repo, set env vars, deploy,
verifikasi. Jangan menebak nilai apa pun yang tidak ada di sini — tanyakan ke User
kalau ada langkah yang butuh keputusan (misal nama domain custom).

---

## 1. Sumber kode

- **Repo GitHub**: `sofyandi57/swing-ihsg`
- **Branch yang sudah siap deploy**: `claude/tender-darwin-jzi6dv`
  (berisi migrasi React+Vite, dark theme mobile-first — lihat commit terbaru)
- Kalau User sudah merge branch ini ke `main`, pakai `main` sebagai source branch.
  Kalau belum, tetap pakai `claude/tender-darwin-jzi6dv` untuk deploy awal.

## 2. Langkah import project di Vercel

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
5. **Branch**: pilih `claude/tender-darwin-jzi6dv` di bagian Git branch sebelum deploy
   pertama (atau `main` kalau sudah di-merge).

## 3. Environment Variables — WAJIB diisi sebelum deploy pertama

Masuk ke tab **Environment Variables** saat setup (atau nanti di Project Settings →
Environment Variables). Isi 4 variabel ini, scope **Production, Preview, Development**
(centang semua):

| Key | Wajib? | Keterangan |
|---|---|---|
| `INVEZGO_API_KEY` | **Wajib** | Tanpa ini, endpoint scan (`api/screener.js`, `api/check-stock.js`) akan gagal total (500 error). |
| `SUPABASE_URL` | **Wajib** | Dari Supabase Dashboard → Project Settings → API. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Wajib** | Dari Supabase Dashboard → Project Settings → API. **PAKAI service_role key, BUKAN anon/public key** — service_role diperlukan untuk insert data dari server. JANGAN PERNAH taruh key ini di kode frontend. |
| `GROQ_API_KEY` | Opsional | Tanpa ini, fitur AI (ekstraksi kode saham dari pesan mentor + AI Insight di tab Run Scan) tetap jalan tapi fallback ke regex-only / insight kosong — tidak error, hanya kurang pintar. |

Nilai aktual dari 4 key ini **User sudah punya** (pernah di-generate sebelumnya, lihat
`.env.example` di repo untuk format). Kalau agent tidak tahu nilainya, **STOP dan minta
User paste nilainya** — jangan isi dengan placeholder atau string kosong.

## 4. Deploy

1. Klik **Deploy**.
2. Tunggu build selesai (~1-2 menit untuk Vite build).
3. Kalau build gagal, cek log:
   - Error `Cannot find module` → kemungkinan `package.json`/`package-lock.json`
     tidak lengkap ter-commit, laporkan ke User, jangan coba modifikasi kode dari
     browser.
   - Error terkait environment variable kosong saat runtime (bukan build time) itu
     NORMAL sampai langkah 3 di atas diisi — functions (`api/*.js`) baru dipanggil
     saat user klik "Run Scan" di browser, bukan saat build.

## 5. Verifikasi setelah deploy sukses

1. Buka domain `*.vercel.app` yang diberikan Vercel.
2. Pastikan UI React (dark theme, tab "Run Scan" / "Mentor") muncul dengan benar.
3. Klik **Run Scan** — kalau `INVEZGO_API_KEY` benar, proses scan berjalan (~30 detik–2
   menit) dan hasil muncul sebagai card list. Kalau error 500, cek kembali env var
   di langkah 3.
4. Cek tab **Mentor** — paste contoh pesan, pastikan cross-check jalan (butuh
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` benar).

## 6. Yang TIDAK perlu dilakukan agent ini

- **Jangan** membuat project Supabase baru — itu langkah terpisah (lihat section 7).
- **Jangan** mengubah kode di repo GitHub dari sisi Vercel dashboard.
- **Jangan** mengaktifkan Vercel Cron atau fitur automasi lain — project ini
  sengaja run-on-demand (tombol manual), bukan polling/cron otomatis (lihat
  `CLAUDE_CODE_BRIEFING.md` section 2.2 di repo untuk alasannya).
- **Jangan** set custom domain kecuali User memintanya secara eksplisit dengan
  nama domain yang jelas.

## 7. Langkah setelah ini (bukan tugas agent Vercel — dikerjakan terpisah)

Setelah deploy Vercel sukses, **database Supabase** (tabel `scan_runs`,
`scan_results`, `mentor_calls`, `pdf_extracts`, `watchlist`) perlu disiapkan lewat
Supabase SQL Editor menjalankan `supabase/schema.sql` dari repo ini. Ini dikerjakan
lewat sesi Claude Code terpisah (butuh kredensial Supabase User), bukan lewat
agent Chrome/Vercel ini.

---

**Kontak balik**: kalau ada langkah yang gagal atau butuh keputusan (nama domain,
apakah reuse project Vercel lama, dsb), laporkan ke User — jangan menebak.
