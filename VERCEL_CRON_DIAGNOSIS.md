# VERCEL_CRON_DIAGNOSIS.md

Tugas untuk agent yang PUNYA akses dashboard Vercel (browser/Chrome atau
CLI/MCP Vercel) untuk project **swing-ihsg**. Ini murni DIAGNOSIS — baca
status, JANGAN ubah kode di repo, JANGAN ubah pengaturan apa pun di
dashboard kecuali diminta eksplisit di poin tertentu di bawah.

Konteks: fitur "Flush Kuota API" (cron `/api/admin?resource=quota-flush`)
sudah beberapa kali dijalankan (manual + cron) tapi hasil di tabel
`quota_flush_data` selalu KOSONG (CSV export cuma ada header, nol baris
data). Perlu tahu PERSIS di mana gagalnya.

## Yang perlu dicek — jawab tiap poin, kutip PERSIS teks/angka yang terlihat,
jangan diringkas atau ditebak

1. **Plan/tier project ini** — buka Project Settings (atau Account/Team
   Settings) → cek nama plan (Hobby/Pro/Enterprise) yang aktif untuk akun
   ini.

2. **Batas maxDuration Serverless Function untuk plan ini** — buka
   dokumentasi Vercel (Settings → Functions, atau
   vercel.com/docs/functions/runtimes#maxduration) dan catat: berapa detik
   maksimum yang diizinkan untuk plan yang ditemukan di poin 1. (Dugaan
   kami: Hobby dibatasi 60 detik, sedangkan `vercel.json` project ini
   menyetel `api/admin.js` ke `maxDuration: 280` — kalau dugaan ini benar,
   itu kemungkinan besar akar masalahnya: function langsung di-kill
   platform sebelum sempat simpan data ke database.)

3. **Riwayat invocation cron `/api/admin?resource=quota-flush`** — Project
   Settings → Cron Jobs → klik entry ini → lihat daftar run terakhir. Untuk
   3 run TERAKHIR (atau semua yang ada kalau kurang dari 3), catat persis:
   - Timestamp
   - Status (Success/Error/Timeout)
   - Duration (berapa detik function berjalan sebelum selesai/berhenti)
   - Response status code (200/401/403/502/504/dst)
   - Isi error message kalau ada (bagian "Logs" biasanya menampilkan
     stack trace atau pesan error mentah)

4. **Riwayat invocation cron `/api/screener?mode=momentum_sniper`** — sama
   seperti poin 3, tapi untuk cron kedua ini.

5. **Env var `CRON_SECRET`** — Project Settings → Environment Variables →
   konfirmasi variabel ini ADA (jangan buka nilainya, cukup konfirmasi
   keberadaannya) dan scope-nya mencakup **Production** (bukan cuma
   Preview/Development — cron production HARUS baca dari environment
   Production).

6. **Deployment terakhir** — Deployments tab → konfirmasi deployment
   PALING BARU statusnya "Ready" (bukan "Error"/"Building" lama yang gagal)
   dan tanggalnya SETELAH env var `CRON_SECRET` terakhir di-set/diubah
   (kalau deployment lebih lama dari perubahan env var, itu berarti cron
   masih jalan dengan konfigurasi/env var LAMA sampai ada deploy baru).

7. **Function Logs mentah** (kalau tersedia di plan ini) — Project →
   Observability/Logs tab → filter path `/api/admin` → screenshot/salin
   baris log dari waktu-waktu cron dijadwalkan jalan (lihat jadwal di
   `vercel.json` project ini: cari blok `"crons"`). Ini paling berharga
   kalau Cron Jobs tab sendiri tidak menampilkan detail error.

## Format jawaban

Jawab per nomor 1-7. Untuk setiap angka/status/pesan, salin PERSIS apa yang
tertulis di dashboard — jangan parafrase atau bulatkan angka (misal
"duration: 58.2s" bukan "sekitar 1 menit"). Kalau satu poin tidak bisa
diakses/tidak ada datanya, tulis `<nomor>. NOT FOUND — <alasan>` (misal
plan tidak menyediakan fitur Logs).

JANGAN mengubah `maxDuration` di kode, JANGAN redeploy, JANGAN ubah env var
apa pun — ini murni pengumpulan informasi untuk agent lain (di sesi
terpisah) yang akan memperbaiki kodenya berdasarkan temuan ini.
