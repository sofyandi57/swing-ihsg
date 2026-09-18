# SUPABASE_AGENT_SETUP.md

Briefing untuk agent (Chrome/browser, atau agent dengan akses Supabase
MCP/CLI) yang mengurus **database Supabase** untuk project **swing-ihsg**.
Dokumen ini adalah **satu-satunya sumber kebenaran** soal state database yang
DIHARAPKAN saat ini — kalau ada tugas "urus database", "jalankan migration",
"sinkronkan schema", dsb., dokumen ini + `supabase/schema.sql` sudah cukup
untuk menyelesaikannya SENDIRI tanpa perlu bertanya balik ke User soal apa
saja yang berubah.

Jangan menebak — kalau ada percabangan keputusan di bawah, cek dulu kondisi
aktualnya di dashboard/koneksi sebelum lanjut.

---

## 0. Prinsip kerja agent ini

1. **`supabase/schema.sql` di repo adalah source of truth, dan SELALU
   idempotent** (`create table if not exists`, `alter table add column if
   not exists`, `create index if not exists`). Menjalankan ULANG seluruh isi
   file ini — bukan cuma potongan yang "kelihatannya baru" — selalu aman,
   tidak pernah menghapus/menimpa data yang sudah ada. **Kalau tugasnya
   "sinkronkan database dengan schema terbaru", cukup jalankan SELURUH isi
   file ini apa adanya**, tidak perlu diff manual dulu.
2. Sesi coding (Claude di repo ini) MENGUBAH `supabase/schema.sql` cukup
   sering setiap menambah fitur yang butuh tabel/kolom baru — dan SETIAP KALI
   itu terjadi, User diberi tahu "wajib re-run schema.sql", tapi eksekusinya
   manual (copy-paste ke SQL Editor). **Tugas agent Supabase = menutup gap
   itu**: pastikan apa yang ada di `supabase/schema.sql` (versi commit
   terbaru di branch yang dipakai) BENAR-BENAR sudah diterapkan di project
   Supabase yang sebenarnya.
3. Kalau berhasil menjalankan schema.sql, **verifikasi** dengan mengecek tabel
   di Section 2 (daftar lengkap + kolom kunci) benar-benar ada — jangan cuma
   percaya "query jalan tanpa error", karena sebagian statement idempotent
   bisa silently no-op.
4. Setelah tugas ini selesai, **update Section 7 (Riwayat Perubahan Schema)**
   di file ini kalau ada tabel/kolom baru yang belum tercatat di situ — supaya
   dokumen ini tetap sinkron dengan `schema.sql` untuk sesi berikutnya.

---

## 1. Cek dulu: sudah ada project Supabase atau belum?

Buka https://supabase.com/dashboard (atau pakai MCP/CLI yang sudah terhubung
ke akun yang benar).

- **Kalau sudah ada project** (biasanya bernama mirip `swing-ihsg` /
  `invezgo-screener` / sejenisnya) → lanjut ke **Section 3** (jalankan/
  sinkronkan schema di project yang sudah ada — ini kasus PALING UMUM untuk
  agent ini, karena project sudah eksis sejak awal).
- **Kalau belum ada project sama sekali** → lanjut ke **Section 2** dulu
  (buat project baru), baru ke Section 3.

## 2. Buat project Supabase baru (skip kalau sudah ada)

1. Di dashboard, klik **New Project**.
2. **Name**: `swing-ihsg` (konsisten dengan nama repo).
3. **Database Password**: generate password kuat, **simpan di tempat aman**
   (password manager User) — dibutuhkan lagi kalau nanti perlu akses langsung
   via `psql`/connection string.
4. **Region**: Singapore (`ap-southeast-1`) — paling masuk akal untuk user
   IDX/Indonesia, latensi rendah ke Vercel.
5. **Pricing Plan**: Free tier cukup untuk tahap awal.
6. Klik **Create new project**, tunggu provisioning (~2 menit).

## 3. Jalankan/sinkronkan `supabase/schema.sql`

1. Di project Supabase (baru atau existing), buka **SQL Editor**.
2. Klik **New query**.
3. Copy **SELURUH ISI** file `supabase/schema.sql` dari repo GitHub
   `sofyandi57/swing-ihsg` — **pakai branch yang sedang aktif dikerjakan**
   (biasanya `claude/tender-darwin-jzi6dv` sampai di-merge ke `main` — cek
   branch mana yang paling baru di-push kalau ragu), path: `supabase/schema.sql`.
4. Paste ke SQL Editor, klik **Run** (atau Ctrl/Cmd+Enter).
5. Harus sukses tanpa error. Aman dijalankan berkali-kali (lihat Section 0).
6. **Verifikasi** — buka tab **Table Editor**, pastikan SEMUA 11 tabel ini
   ada (bukan cuma sebagian — kalau ada yang hilang, schema.sql yang
   dijalankan kemungkinan versi lama, ambil ulang dari branch terbaru):

   | Tabel | Fungsi singkat |
   |---|---|
   | `scan_runs` | Metadata tiap klik "Run Scan" (waktu, durasi, kriteria, mode) |
   | `scan_results` | Satu baris per saham per scan (semua saham, bukan cuma yang lolos filter) |
   | `mentor_calls` | Histori pesan mentor yang di-paste manual + kode yang terdeteksi |
   | `pdf_extracts` | Histori PDF riset yang di-upload + ringkasan AI per kode |
   | `watchlist` | State AKTIF watchlist — satu baris per kode, di-upsert |
   | `watchlist_history` | LOG tiap kali kode ditambahkan ke watchlist (kode, harga, tanggal, jam) — beda dari `watchlist` yang cuma state aktif |
   | `app_admins` | Daftar email yang boleh akses panel Admin |
   | `app_settings` | Parameter screener yang bisa di-override dari panel Admin |
   | `auth_activity_log` | LOG login/logout tiap user (Supabase Auth bawaan tidak punya ini) |
   | `freq_baseline` | Baseline frekuensi transaksi harian per kode, untuk fitur "Momentum Sniper" |
   | `quota_flush_data` | Hasil terkumpul dari fitur "Flush Kuota API" (Admin), di-upsert per kode |

   Kalau tugasnya spesifik "tambahkan tabel X" dan X sudah ada di daftar di
   atas dengan schema.sql sudah dijalankan — **tugas sudah selesai**, tidak
   perlu langkah tambahan apa pun.

## 4. Aktifkan fitur Login — buat akun pertama + jadikan admin

Fitur login pakai **Supabase Auth bawaan** (bukan tabel custom).

1. Di sidebar, buka **Authentication** → **Users** → **Add user** → **Create
   new user**.
2. Isi email dan password User sendiri, centang **Auto Confirm User**.
3. Buka **SQL Editor**, jalankan (ganti email sesuai):
   ```sql
   insert into app_admins (email) values ('email_user_disini@contoh.com')
   on conflict (email) do nothing;
   ```
   `on conflict do nothing` supaya aman dijalankan ulang kalau email itu
   ternyata sudah terdaftar sebagai admin. Ini WAJIB — tanpa baris ini, akun
   bisa login tapi tab **Admin** tidak akan muncul.
4. Untuk akun tambahan (tim/partner) yang JUGA admin, ulangi langkah 3 dengan
   email itu. Kalau cuma perlu bisa login (bukan admin), cukup langkah 1-2.

## 5. Kredensial yang dibutuhkan Vercel (env var)

Kalau agent ini JUGA punya akses Vercel, atau cuma perlu memastikan User tahu
apa yang harus dipasang, berikut daftar env var yang bergantung ke Supabase +
fitur lain yang butuh env var terkait database:

| Env var | Dari mana | Dipakai untuk |
|---|---|---|
| `SUPABASE_URL` | Project Settings → API → **Project URL** | Server-side (Vercel functions) akses Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → **service_role key** (BUKAN anon) | Server-side, bypass RLS |
| `VITE_SUPABASE_URL` | Sama dengan `SUPABASE_URL` | Frontend (login) |
| `VITE_SUPABASE_ANON_KEY` | Project Settings → API → **anon/public key** | Frontend (login) |
| `CRON_SECRET` | **Buat sendiri** — string acak panjang, bukan dari Supabase | Otorisasi Vercel Cron memanggil `/api/admin?resource=quota-flush` tanpa sesi browser (lihat Section 6) |

**PENTING**: `service_role` key TIDAK PERNAH ditaruh di kode frontend/browser
manapun — hanya sebagai environment variable server-side di Vercel. Lihat
`VERCEL_AGENT_SETUP.md` untuk detail lengkap cara memasang env var ini.

## 6. Fitur yang bergantung pada konfigurasi TAMBAHAN (bukan cuma schema)

Beberapa fitur di app ini butuh langkah setup DI LUAR `schema.sql` — kalau
agent ini menemukan fitur ini "tidak jalan" padahal tabelnya sudah ada, cek
poin berikut sebelum menyimpulkan ada bug:

- **Flush Kuota API + Cron otomatis** (`quota_flush_data`) — butuh env var
  `CRON_SECRET` diset di Vercel (lihat Section 5) DAN `vercel.json` punya
  blok `"crons"` yang mengarah ke `/api/admin?resource=quota-flush`. Vercel
  Cron di paket **Hobby dibatasi maksimal 1x/hari** — kalau User mengeluh
  "cron tidak jalan tiap beberapa menit", itu bukan bug, itu batasan paket
  (butuh upgrade ke Pro untuk jadwal lebih sering).
- **Momentum Sniper** (`freq_baseline`) — baseline frekuensi transaksi
  historis BARU terkumpul setelah mode `momentum_sniper` dijalankan beberapa
  hari berturut-turut. Di hari pertama, sistem otomatis fallback ke baseline
  "sementara" (median antar-kandidat hari itu) — ini SENGAJA, bukan bug.

## 7. Riwayat Perubahan Schema (changelog)

Dicatat kronologis supaya jelas KAPAN dan KENAPA tiap tabel/kolom ditambahkan.
**Tambahkan entri baru di PALING BAWAH setiap kali `supabase/schema.sql`
berubah** (jangan sisipkan di tengah — urutan kronologis harus tetap benar).

1. **Awal project** — `scan_runs`, `scan_results` (histori tiap Run Scan +
   hasil per saham), `mentor_calls` (histori pesan mentor), `pdf_extracts`
   (histori PDF riset), `watchlist` (state aktif watchlist), `app_admins`,
   `app_settings` (kelola user & parameter screener dari panel Admin).
2. **Fitur cache scan** — kolom `mode`/`sector`/`subsector`/`min_value`/
   `min_ratio` di `scan_runs`, supaya scan dengan kriteria identik dalam
   beberapa menit terakhir bisa pakai ulang hasil tanpa hit Invezgo lagi
   (mencegah banyak user "bentrok" kena rate limit bersamaan).
3. **Filter screener sektor/value** — kolom `sector`/`subsector`/`value` di
   `scan_results`.
4. **Mode Volume Spike ("akumulasi diam-diam")** — kolom
   `avg_volume_3d`/`avg_volume_20d`/`vol_ratio_3v20`/`price_change_3d`/
   `quiet_accumulation`/`sudah_naik_tajam` di `scan_results`.
5. **Watchlist: hapus semua + histori kapan/harga masuk** — tabel baru
   `watchlist_history` (log append-only, beda dari `watchlist` yang cuma
   state aktif per kode).
6. **Login/logout tracking di panel Admin** — tabel baru `auth_activity_log`
   (Supabase Auth bawaan cuma simpan `last_sign_in_at`, tidak ada histori
   logout sama sekali).
7. **Fitur "Momentum Sniper" (BPJP/BPJS/BSJP)** — tabel baru `freq_baseline`,
   dipakai membangun baseline frekuensi transaksi harian sendiri (Invezgo
   tidak punya endpoint histori freq).
8. **Fitur "Flush Kuota API" (Admin) + otomasi Vercel Cron** — tabel baru
   `quota_flush_data` (upsert per kode), supaya hasil harvest data (manual
   klik ATAU cron 1x/hari) tersimpan dan bisa di-export CSV kapan saja.
9. **Rewrite Stage 1 Run Scan ke batch endpoint** (menggantikan
   ~1200 request/scan yang menghabiskan kuota bulanan dalam beberapa klik —
   dilaporkan User lewat log Invezgo) — `prev_volume`/`volume_ratio` di
   `scan_results` DIUBAH dari NOT NULL jadi nullable (SELALU null di baris
   baru mulai sekarang, kolom historis lama tetap ada, TIDAK dihapus), kolom
   baru `freq` ditambahkan (kriteria filter inti sekarang, bukan cuma
   badge). Kolom baru `min_value_activity`/`min_freq` di `scan_runs`
   (`min_volume_ratio`/`min_prev_volume` lama TETAP ADA — NOT NULL, tidak
   di-drop — tapi diisi 0 mulai sekarang, sudah tidak dipakai).

---

## 8. Row Level Security

`schema.sql` mengaktifkan RLS di SEMUA tabel di baris-baris terakhirnya
(`alter table ... enable row level security`), TANPA policy untuk `anon`/
`authenticated`. Ini disengaja: aplikasi hanya menulis lewat `service_role`
key di server (bypass RLS otomatis), tidak ada akses langsung dari browser
ke Supabase. **Jangan tambahkan policy RLS apa pun** kecuali User memintanya
secara eksplisit.

## 9. Yang TIDAK boleh dilakukan agent ini

- **Jangan** ubah/hapus tabel yang sudah ada isinya — `schema.sql` idempotent,
  cukup dijalankan ulang apa adanya.
- **Jangan** buat tabel/kolom di luar yang ada di `schema.sql`. Kalau tugas
  minta sesuatu yang belum ada di file itu, itu artinya sesi coding (Claude di
  repo) belum menambahkannya — laporkan balik, jangan improvisasi schema
  sendiri di database tanpa mengubah `schema.sql` juga (nanti jadi tidak
  sinkron dengan kode aplikasi).
- **Jangan** expose `service_role` key di tempat manapun selain env var
  Vercel (jangan commit ke git, jangan taruh di kode, jangan share di
  chat/screenshot publik).
- **Jangan** ubah region/plan project existing tanpa User minta eksplisit.

---

**Kontak balik**: kalau `schema.sql` gagal jalan (error SQL), tabel di
Section 3 tidak lengkap setelah dijalankan, atau tidak yakin ini project
baru vs existing, laporkan ke User dengan pesan error lengkapnya — jangan
menebak atau modifikasi schema sendiri di luar apa yang ada di
`supabase/schema.sql`.
