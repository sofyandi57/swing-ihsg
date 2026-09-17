-- supabase/schema.sql
--
-- Jalankan ini sekali di Supabase SQL Editor (dashboard project Anda) sebelum
-- deploy. Dua tabel:
--   scan_runs    — satu baris per klik "Run Scan" (metadata: waktu, durasi, total saham)
--   scan_results — banyak baris per run, satu per saham yang di-scan (SEMUA saham,
--                  bukan hanya yang lolos filter — sesuai permintaan)
--
-- Kolom passed_filter menandai mana yang lolos kriteria screener saat itu, supaya
-- Anda tetap bisa membedakan "semua data mentah" vs "yang ditampilkan sebagai hasil"
-- tanpa perlu dua tabel terpisah untuk itu.

create table if not exists scan_runs (
  id uuid primary key default gen_random_uuid(),
  scanned_at timestamptz not null default now(),
  duration_ms integer not null,
  total_scanned integer not null,
  total_passed_filter integer not null,
  min_volume_ratio numeric not null,
  min_prev_volume bigint not null,
  min_price numeric not null
);

-- Kolom kriteria scan (mode/sector/subsector/minValue/minRatio) ditambahkan
-- belakangan untuk fitur CACHE — supaya run dengan kriteria yang SAMA dalam
-- beberapa menit terakhir bisa dipakai ulang tanpa scan Invezgo lagi. Lihat
-- CACHE_TTL_MINUTES di api/screener.js.
alter table scan_runs add column if not exists mode text;
alter table scan_runs add column if not exists sector text;
alter table scan_runs add column if not exists subsector text;
alter table scan_runs add column if not exists min_value numeric;
alter table scan_runs add column if not exists min_ratio numeric;

-- Index untuk lookup cache cepat: "cari run dengan kriteria persis sama,
-- dalam beberapa menit terakhir"
create index if not exists idx_scan_runs_cache_lookup on scan_runs(mode, scanned_at desc);

create table if not exists scan_results (
  id bigint generated always as identity primary key,
  run_id uuid not null references scan_runs(id) on delete cascade,
  code text not null,
  volume bigint not null,
  prev_volume bigint not null,
  volume_ratio numeric not null,
  price numeric not null,
  prev_price numeric not null,
  price_change_pct numeric not null,
  passed_filter boolean not null,
  sector text,
  subsector text,
  value numeric
);

-- Kolom sector/subsector/value ditambahkan belakangan (fitur filter screener) —
-- alter terpisah supaya aman dijalankan ulang di project yang tabelnya sudah ada
-- sebelum kolom ini ditambahkan.
alter table scan_results add column if not exists sector text;
alter table scan_results add column if not exists subsector text;
alter table scan_results add column if not exists value numeric;

-- Kolom kriteria "akumulasi diam-diam" (volume 3 hari terakhir rata-rata lebih
-- tinggi dari volume 20 hari sebelumnya, TAPI harga cuma naik 0-10%) — beda
-- dari volume_ratio yang menangkap lonjakan tajam 1-2 hari.
alter table scan_results add column if not exists avg_volume_3d numeric;
alter table scan_results add column if not exists avg_volume_20d numeric;
alter table scan_results add column if not exists vol_ratio_3v20 numeric;
alter table scan_results add column if not exists price_change_3d numeric;
alter table scan_results add column if not exists quiet_accumulation boolean;

-- Proxy "sudah naik tajam hari ini" (priceChangePct >= 20%) — heuristik untuk
-- kemungkinan sudah/dekat ARA, BUKAN deteksi ARA resmi. Badge peringatan saja,
-- tidak menyaring hasil keluar dari mode manapun.
alter table scan_results add column if not exists sudah_naik_tajam boolean;

-- Index untuk query histori yang umum: "tampilkan semua run terbaru",
-- "tampilkan semua hasil untuk saham X dari waktu ke waktu"
create index if not exists idx_scan_results_run_id on scan_results(run_id);
create index if not exists idx_scan_results_code on scan_results(code);
create index if not exists idx_scan_runs_scanned_at on scan_runs(scanned_at desc);

-- mentor_calls — pesan mentor yang di-paste manual, plus kode saham yang berhasil
-- diekstrak dari teksnya. Satu baris per PESAN (bukan per kode saham) — kalau satu
-- pesan menyebut beberapa kode, semua disimpan di kolom codes (array), supaya konteks
-- kalimat aslinya tidak hilang dan tetap bisa ditelusuri.
create table if not exists mentor_calls (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  raw_message text not null,
  codes text[] not null default '{}'
);

create index if not exists idx_mentor_calls_received_at on mentor_calls(received_at desc);
-- GIN index supaya query "cari semua mentor_calls yang menyebut kode X" cepat
create index if not exists idx_mentor_calls_codes on mentor_calls using gin(codes);

-- pdf_extracts — histori mentah tiap PDF riset/rekomendasi saham yang di-upload.
-- Mirip mentor_calls tapi teksnya lebih panjang, dan ai_notes menyimpan ringkasan
-- AI PER KODE (bukan cuma daftar kode), karena PDF riset biasanya punya konteks
-- lebih kaya (target harga, alasan rekomendasi) yang sayang dibuang.
create table if not exists pdf_extracts (
  id uuid primary key default gen_random_uuid(),
  uploaded_at timestamptz not null default now(),
  filename text not null,
  raw_text text not null,
  detected_codes text[] not null default '{}',
  ai_notes jsonb  -- {"BBCA": "target 4500, alasan...", "ANTM": "..."} per kode
);

create index if not exists idx_pdf_extracts_uploaded_at on pdf_extracts(uploaded_at desc);
create index if not exists idx_pdf_extracts_codes on pdf_extracts using gin(detected_codes);

-- watchlist — STATE AKTIF (bukan histori log seperti mentor_calls/pdf_extracts).
-- Satu baris per kode saham, di-upsert setiap kali kode itu muncul lagi dari sumber
-- manapun (PDF baru, pesan mentor, atau ditambah manual) — TIDAK membuat duplikat.
create table if not exists watchlist (
  code text primary key,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null,           -- 'pdf' | 'mentor_call' | 'manual'
  source_ref_id uuid,             -- id ke pdf_extracts.id atau mentor_calls.id
  notes text                      -- ringkasan AI terkini untuk kode ini
);

-- watchlist_history — LOG (bukan state aktif seperti watchlist di atas). Satu baris
-- BARU tiap kali kode di-tambahkan ke watchlist (bisa berkali-kali untuk kode yang
-- sama kalau ditambahkan lagi di lain waktu) — dipakai tombol "Histori" di tab
-- Watchlist untuk menunjukkan kapan (tanggal+jam) dan di harga berapa suatu kode
-- pertama kali menarik perhatian, tanpa hilang begitu upsert watchlist meng-update
-- baris state aktifnya.
create table if not exists watchlist_history (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  price numeric,          -- harga saat ditambahkan (null kalau gagal ambil harga live)
  source text not null,   -- 'pdf' | 'mentor_call' | 'manual'
  added_at timestamptz not null default now()
);

create index if not exists idx_watchlist_history_added_at on watchlist_history(added_at desc);
create index if not exists idx_watchlist_history_code on watchlist_history(code);

-- RLS (Row Level Security) diaktifkan secara default oleh Supabase untuk tabel baru
-- di beberapa setup. Karena aplikasi ini hanya menulis lewat service_role key di
-- server (yang otomatis bypass RLS), dan TIDAK ADA akses langsung dari browser,
-- RLS tidak perlu dikonfigurasi khusus untuk kasus ini — tapi diaktifkan sebagai
-- praktik aman, dengan tidak ada policy untuk anon/authenticated (jadi anon key
-- tidak bisa baca/tulis apa pun di tabel ini kalau suatu saat ke expose).
alter table scan_runs enable row level security;
alter table scan_results enable row level security;
alter table mentor_calls enable row level security;
alter table pdf_extracts enable row level security;
alter table watchlist enable row level security;
alter table watchlist_history enable row level security;

-- ===== Auth & Admin (login/logout + admin panel) =====
--
-- Login/logout dipakai Supabase Auth bawaan (tabel auth.users, dikelola Supabase,
-- bukan tabel custom kita). Dua tabel di bawah ini HANYA untuk mengatur siapa yang
-- boleh masuk ke halaman Admin, dan menyimpan parameter screener yang bisa diubah
-- dari UI Admin tanpa redeploy.

-- app_admins — daftar email yang boleh akses halaman Admin (kelola user, ubah
-- parameter, lihat histori). TIDAK otomatis terisi — Anda WAJIB insert email
-- pertama Anda sendiri secara manual setelah membuat akun pertama:
--   insert into app_admins (email) values ('email_anda@contoh.com');
create table if not exists app_admins (
  email text primary key,
  added_at timestamptz not null default now()
);

-- app_settings — parameter screener yang bisa di-override dari Admin panel
-- (MIN_VOLUME_RATIO, MIN_PREV_VOLUME, MIN_PRICE, TOP_N, CONCURRENCY). Kalau
-- kosong/belum diisi, api/screener.js pakai nilai default yang di-hardcode di
-- kodenya — tabel ini murni opsional override, bukan wajib diisi.
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- auth_activity_log — LOG login/logout tiap user, untuk ditampilkan di Admin
-- panel ("Aktivitas Login/Logout"). Supabase Auth sendiri cuma menyimpan
-- last_sign_in_at (satu titik waktu, ke-overwrite tiap login baru) - tidak ada
-- histori logout sama sekali dari bawaan Supabase, jadi dicatat manual di sini
-- setiap kali event login/logout terjadi di sisi klien (lihat LoginPage.jsx dan
-- tombol Logout di App.jsx).
create table if not exists auth_activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text not null,
  event text not null, -- 'login' | 'logout'
  created_at timestamptz not null default now()
);

create index if not exists idx_auth_activity_log_created_at on auth_activity_log(created_at desc);

-- freq_baseline — histori frekuensi transaksi (freq) + rata-rata nilai per
-- transaksi (ticket_size) HARIAN per kode, dipakai fitur "Momentum Sniper"
-- (mode scan momentum_sniper di api/screener.js) untuk menghitung baseline
-- ("freq_analyzer" di spek asli User) sendiri — Invezgo TIDAK punya endpoint
-- histori freq harian, cuma snapshot live hari ini, jadi baseline dibangun
-- dari data yang terkumpul tiap kali mode ini dijalankan. Satu baris per
-- kode per tanggal — di-upsert (ON CONFLICT kode+tanggal), bukan insert
-- berulang di hari yang sama.
create table if not exists freq_baseline (
  code text not null,
  date date not null,
  freq bigint not null,
  ticket_size numeric,
  updated_at timestamptz not null default now(),
  primary key (code, date)
);

create index if not exists idx_freq_baseline_code on freq_baseline(code);

alter table app_admins enable row level security;
alter table app_settings enable row level security;
alter table auth_activity_log enable row level security;
alter table freq_baseline enable row level security;
