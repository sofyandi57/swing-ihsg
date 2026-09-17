# Volume Scalping Screener — Web (React + Vercel + Supabase)

Website screener saham IDX berbasis volume-ratio, dengan chart candlestick multi-timeframe,
analisa teknikal berbantuan AI, cross-check pesan mentor, dan watchlist dari PDF riset.
Frontend React (Vite), backend serverless functions di Vercel, histori tersimpan permanen
di Supabase. API key Invezgo/Supabase/Groq disimpan di server, tidak pernah terkirim ke browser.

## Empat Tab

1. **⚡ Run Scan** — scan on-demand ~900 saham BEI, filter volume ratio ≥3x, dengan AI
   insight otomatis dan filter sektor/subsektor/value/abjad depan atas hasilnya.
2. **📊 Chart** — candlestick OHLCV multi-timeframe (1m/5m/15m/30m/1h/Daily) + tombol
   **Analisa Teknikal** (SMA20/50, RSI14, support/resistance, narasi area beli/jual dari AI).
3. **💬 Mentor** — paste manual pesan mentor (misal dari WhatsApp), cross-check kode saham
   yang disebut terhadap histori scan.
4. **⭐ Watchlist** — upload PDF riset/rekomendasi, AI ekstrak kode saham + ringkasan per
   kode, digabung status scan terkini.

## Arsitektur

```
Browser (React app, Vite build — src/App.jsx + 4 tab component)
   │
   ├─ Tab Run Scan ──────────────────────────────────────────────────────┐
   │  fetch('/api/screener')                                             │
   │  ▼                                                                   │
   │  api/screener.js                                                     │
   │    1. Ambil daftar ~900 saham dari Invezgo (+ sector per saham)      │
   │    2. Scan semua kode via rolling worker pool (concurrency 20,       │
   │       retry sekali kalau kena 429) — jauh lebih cepat dari batch     │
   │       tetap karena slot tidak pernah menganggur                      │
   │    3. Hitung volume ratio, value (price×volume), tandai passed_filter│
   │    4. Fetch subsector HANYA untuk ~25 yang lolos filter (hemat API)  │
   │    5. Simpan SEMUA hasil ke Supabase (scan_runs + scan_results)      │
   │    6. Kembalikan top 25 ke browser                                   │
   │  ▼                                                                   │
   │  fetch('/api/scan-insight', { data: hasil scan })                    │
   │  ▼ Groq meringkas pola hasil scan jadi narasi 2-4 kalimat            │
   │  Filter sektor/subsektor/abjad/value dijalankan di BROWSER           │
   │  (client-side) atas 25 hasil yang sudah diterima — tanpa scan ulang │
   │  └──► Invezgo API + Supabase + Groq (opsional)                       │
   │                                                                       │
   ├─ Tab Chart ──────────────────────────────────────────────────────────┤
   │  fetch('/api/stock-chart?code=X&timeframe=Y')                        │
   │  ▼ api/stock-chart.js — proxy ke /analysis/chart/multi-time/{code}   │
   │    (timeframe 1/5/15/30/60 menit, D/W/M — TIDAK ADA opsi 3 menit,   │
   │    itu batasan Invezgo). Render candlestick + volume via             │
   │    lightweight-charts di browser.                                    │
   │  │                                                                    │
   │  Tombol "Analisa Teknikal Sekarang"                                  │
   │  fetch('/api/technical-analysis', { candles yang sudah dimuat })     │
   │  ▼ api/technical-analysis.js                                         │
   │    1. Hitung SMA20/50, RSI14, support/resistance dari swing high/low │
   │       — DETERMINISTIK di server, bukan ditebak AI                    │
   │    2. Groq narasikan angka itu jadi area beli/jual/stop-loss          │
   │       (fallback: tampilkan angka mentah kalau Groq mati)             │
   │  └──► Invezgo API + Groq (opsional)                                   │
   │                                                                       │
   ├─ Tab Mentor ─────────────────────────────────────────────────────────┤
   │  fetch('/api/mentor-call', { method: 'POST', body: { message } })    │
   │  ▼ api/mentor-call.js                                                │
   │    1. Ambil daftar kode saham resmi Invezgo (validasi)                │
   │    2a. Regex 4-huruf-kapital + blocklist kata umum                   │
   │    2b. Groq (opsional) — baca teks dengan konteks kalimat            │
   │    3. Union (2a)+(2b), validasi SEMUA ke daftar resmi                │
   │    4. Simpan ke Supabase (mentor_calls)                               │
   │    5. Cross-check ke scan_results 7 hari terakhir + mentor_calls lama│
   │  Tombol "Cek Scan Sekarang" per kode → fetch('/api/check-stock')     │
   │  ▼ api/check-stock.js — cek 1 saham saja, hitungan detik             │
   │  └──► Invezgo API + Supabase + Groq (opsional)                       │
   │                                                                       │
   └─ Tab Watchlist ──────────────────────────────────────────────────────┘
      Upload PDF → base64 → fetch('/api/pdf-watchlist', POST)
      ▼ api/pdf-watchlist.js
        1. Ekstrak teks PDF di server (pdf-parse)
        2. Regex+blocklist DAN Groq (union) — Groq juga bikin ringkasan
           1 kalimat per kode (target harga/alasan kalau disebut)
        3. Validasi SEMUA kode ke daftar saham resmi Invezgo
        4. Simpan histori mentah ke pdf_extracts, upsert state aktif ke
           watchlist (ON CONFLICT code DO UPDATE — tidak duplikat)
      GET (tanpa body) → watchlist LEFT JOIN status scan_results terbaru
      └──► Invezgo API + Supabase + Groq (opsional)
```

**Catatan penting soal WhatsApp**: fitur Mentor TIDAK membaca pesan WhatsApp secara
otomatis. Anda tetap menerima pesan mentor seperti biasa di WA, lalu copy-paste
teksnya ke tab Mentor. WhatsApp tidak menyediakan API resmi untuk membaca pesan
pribadi/grup secara otomatis tanpa migrasi ke WhatsApp Business API (mentor Anda
harus kirim ke nomor bisnis terpisah) — automasi tidak resmi (reverse-engineering
WhatsApp Web) melanggar Terms of Service WhatsApp dan berisiko akun di-banned,
jadi sengaja tidak dibangun. Kalau nanti ingin upgrade ke otomatis, opsi paling
ringan adalah pindah channel ke Telegram (Bot API resmi, gratis).

Tidak ada cache, tidak ada auto-polling di manapun. Setiap function hanya "hidup"
selama diminta (klik tombol / buka tab), lalu berhenti.

## Setup Supabase (Sekali Saja)

### 1. Buat project Supabase gratis
Daftar/login di https://supabase.com, buat project baru (pilih region terdekat, misal
Singapore untuk latensi terbaik dari Indonesia).

### 2. Jalankan skema tabel
Buka **SQL Editor** di dashboard Supabase Anda, copy-paste seluruh isi
`supabase/schema.sql` dari repo ini, lalu klik **Run**. Aman dijalankan berkali-kali
(semua `create table if not exists` / `alter table add column if not exists`) —
tidak menimpa data yang sudah ada. Membuat lima tabel:
- `scan_runs` — satu baris per klik "Run Scan" (waktu, durasi, jumlah saham)
- `scan_results` — satu baris per saham per run (SEMUA saham, ditandai `passed_filter`,
  plus `sector`/`subsector`/`value` untuk filter di tab Run Scan)
- `mentor_calls` — satu baris per pesan mentor yang di-paste, kode saham terdeteksi
  disimpan sebagai array
- `pdf_extracts` — histori mentah tiap PDF yang di-upload di tab Watchlist
- `watchlist` — state aktif per kode saham (upsert, bukan log) — digabung dari PDF,
  mentor, atau manual

### 3. Ambil URL dan service_role key
Di dashboard: **Project Settings → API**.
- Copy **Project URL** → ini jadi `SUPABASE_URL`
- Copy **service_role key** (bukan `anon`/`public` key!) → ini jadi
  `SUPABASE_SERVICE_ROLE_KEY`

⚠️ **service_role key punya akses penuh ke database Anda, bypass semua keamanan RLS.**
Jangan pernah taruh di kode frontend atau commit ke git — hanya sebagai environment
variable di server (Vercel), sama seperti `INVEZGO_API_KEY`.

## Setup Groq (Opsional — untuk Fitur AI)

Dipakai di empat tempat: AI Insight (tab Run Scan), narasi Analisa Teknikal (tab Chart),
deteksi kode saham berkonteks (tab Mentor), dan ringkasan per-kode dari PDF (tab
Watchlist). Tanpa Groq, semuanya tetap jalan dengan fallback (regex-only untuk deteksi
kode, angka mentah tanpa narasi untuk insight/analisa teknikal) — tidak pernah error.

1. Daftar di https://console.groq.com (gratis, tanpa kartu kredit)
2. Buat API key di https://console.groq.com/keys
3. Set sebagai environment variable:
   ```bash
   vercel env add GROQ_API_KEY
   ```

**Catatan desain penting**: Groq TIDAK PERNAH menggantikan validasi terhadap daftar
saham resmi Invezgo di manapun dalam aplikasi ini — LLM tetap bisa berhalusinasi
(menyebut kode yang sebenarnya tidak ada). Kandidat dari regex DAN Groq selalu
digabung (union) dulu, baru SEMUA kandidat divalidasi ke `/analysis/list/stock`.
Model yang dipakai: `openai/gpt-oss-20b`, sebagian dengan `strict: true` (structured
output, dijamin sesuai JSON schema).

## Langkah Deploy (Vercel, Gratis)

### 1. Install Vercel CLI (kalau belum punya)
```bash
npm install -g vercel
```

### 2. Login ke Vercel
```bash
vercel login
```

### 3. Deploy dari folder ini
```bash
vercel
```
Vercel auto-detect Vite (`vite build`, output `dist`) dari `vercel.json`.

### 4. Set environment variables — WAJIB sebelum jalan
```bash
vercel env add INVEZGO_API_KEY
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add GROQ_API_KEY
```
Pilih semua environment (Production, Preview, Development) untuk masing-masing.
`GROQ_API_KEY` opsional — lihat bagian "Setup Groq" di atas.

Atau lewat dashboard: Project Settings → Environment Variables.

### 5. Deploy ke production
```bash
vercel --prod
```

### 6. Buka URL-nya, coba tab Run Scan
Setelah scan selesai, status penyimpanan muncul di bawah tombol ("✓ tersimpan ke
histori" atau pesan error kalau gagal).

## Testing Lokal (opsional)

```bash
cp .env.example .env.local
# edit .env.local, isi 4 env var
npm install
npm run dev      # Vite dev server, hot reload untuk frontend
# atau
vercel dev        # frontend + semua api/*.js serverless functions
```

## Melihat Histori di Supabase

Buka **Table Editor** di dashboard Supabase, atau query lewat SQL Editor:

```sql
-- Semua run, terbaru dulu
select * from scan_runs order by scanned_at desc;

-- Hasil satu run tertentu (semua saham, termasuk yang tidak lolos filter)
select * from scan_results where run_id = 'uuid-run-tertentu' order by volume_ratio desc;

-- Histori satu saham dari waktu ke waktu (lintas semua run)
select r.scanned_at, s.volume_ratio, s.sector, s.passed_filter
from scan_results s
join scan_runs r on r.id = s.run_id
where s.code = 'BBCA'
order by r.scanned_at desc;

-- Semua pesan mentor yang pernah menyebut kode saham tertentu
select * from mentor_calls where 'BBCA' = any(codes) order by received_at desc;

-- Watchlist aktif, digabung sumbernya
select * from watchlist order by updated_at desc;
```

## Fitur per Tab

### Run Scan
Klik **▶ Run Scan** — memindai ~900 saham BEI (30 detik – 2 menit), lalu tampilkan
top 25 dengan volume ratio ≥3x sebagai card (bukan tabel — mobile-friendly). AI Insight
otomatis muncul di atas hasil (ringkasan pola hari itu). Di bawah tombol Run Scan
tersedia filter **Sektor**, **Subsektor**, **Abjad Depan** (A-Z), dan **Value minimum**
— semuanya jalan instan di browser tanpa scan ulang, karena beroperasi atas 25 hasil
yang sudah diterima.

### Chart
Cari kode saham, pilih timeframe (1m/5m/15m/30m/1h/Daily), chart candlestick +
volume muncul otomatis. Klik **🎯 Analisa Teknikal Sekarang** untuk dapat SMA20/50,
RSI14, support/resistance, dan kesimpulan area beli/jual/stop-loss dari AI berdasarkan
angka-angka itu (bukan rekomendasi transaksi — alat bantu baca data).

### Mentor
Paste teks pesan mentor, klik **Cross-Check**. Sistem mendeteksi kode saham (regex +
opsional Groq untuk konteks kalimat), lalu tunjukkan apakah kode itu muncul di histori
scan 7 hari terakhir dan apakah mentor pernah menyebutnya sebelumnya. Tombol **Cek Scan
Sekarang** per kode memanggil `api/check-stock.js` untuk cek cepat 1 saham tanpa full scan.

### Watchlist
Upload PDF riset/rekomendasi saham. Sistem ekstrak teks, deteksi kode saham + ringkasan
AI per kode, validasi ke daftar resmi, lalu upsert ke watchlist (kode yang sama dari
sumber lain tidak jadi duplikat — hanya update catatan & sumber terbaru). Watchlist
digabung dengan status scan terkini setiap kali tab dibuka.

## Durasi Function & Limit Vercel

Vercel Hobby (gratis) dengan Fluid Compute punya batas durasi function **300 detik**.
`vercel.json` men-set `maxDuration` eksplisit per function (120 untuk screener, 60 untuk
pdf-watchlist, 30 untuk scan-insight/technical-analysis, 20 untuk stock-chart) — kalau
butuh lebih lama, naikkan (maksimal 300 untuk Hobby plan).

## Batasan yang Perlu Disadari

- **Bukan proses background**: semua fitur hanya jalan saat Anda klik tombol / buka tab.
- **Volume data di Supabase**: tiap klik "Run Scan" menulis ~900 baris ke `scan_results`.
  Untuk pemakaian sesekali sehari, ini jauh di bawah limit Free tier Supabase (500MB).
- **Kalau penyimpanan Supabase gagal**, hasil tetap ditampilkan ke Anda — hanya histori
  yang tidak tersimpan untuk run itu. Pesan error muncul di UI.
- **Rate limit Invezgo**: `api/screener.js` sudah retry sekali kalau kena 429 di tengah
  scan (tanpa ini, hasil bisa bias ke saham yang diproses lebih dulu — biasanya urutan
  alfabetis dari daftar saham Invezgo).
- **Timeframe chart 3 menit tidak tersedia** — itu batasan API Invezgo
  (`/analysis/chart/multi-time`), pilihannya 1/5/15/30/60 menit, Daily/Weekly/Monthly.
- **Subsektor hanya terisi untuk saham yang lolos filter scan** (~25 dari ~900) — fetch
  detail per kode terlalu mahal untuk dilakukan ke semua saham setiap scan.

## Menyesuaikan Parameter Screener

Edit langsung di `api/screener.js`:
```js
const MIN_VOLUME_RATIO = 3.0;
const MIN_PREV_VOLUME = 1_000_000;
const MIN_PRICE = 50;
const TOP_N = 25;
const CONCURRENCY = 20; // slot paralel di rolling worker pool (lihat runPool)
```
Setelah edit, `vercel --prod` lagi untuk redeploy.

## Struktur Project

```
api/
  screener.js            — scan ~900 saham (rolling pool), simpan histori
  scan-insight.js        — AI insight naratif dari hasil scan
  stock-chart.js         — proxy OHLCV multi-timeframe
  technical-analysis.js  — indikator + narasi AI area beli/jual
  mentor-call.js         — cross-check pesan mentor
  check-stock.js         — cek cepat 1 saham
  pdf-watchlist.js       — upload PDF → AI extract → watchlist
src/
  App.jsx                — shell + bottom tab navigation
  components/
    ScanTab.jsx, ChartTab.jsx, MentorTab.jsx, WatchlistTab.jsx
  styles.css              — dark theme, mobile-first
supabase/
  schema.sql              — 5 tabel, idempotent
spec/
  invezgo-openapi.json / .yaml — spec resmi Invezgo, SUMBER KEBENARAN untuk
                                  semua path/parameter/field
vercel.json                — build Vite + maxDuration per function
```

## Referensi

Dibangun dari skill `invezgo-screener` (endpoint, auth scheme, tipe data — semua
diverifikasi terhadap OpenAPI spec resmi Invezgo di `spec/`). Lihat juga
`CLAUDE_CODE_BRIEFING.md` untuk konteks keputusan desain (kenapa WA manual, kenapa
run-on-demand bukan polling, dll) sebelum mengubah arsitektur.
