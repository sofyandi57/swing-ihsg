# Volume Scalping Screener — Web (Vercel + Supabase, Gratis, Run-on-Demand)

Website screener dengan tombol "Run Scan" — memindai ~900 saham BEI sekali per klik,
dan menyimpan SEMUA hasil scan (bukan hanya yang lolos filter) ke Supabase sebagai
histori. Ditambah fitur cross-check manual: paste pesan mentor (misal dari WhatsApp),
sistem otomatis mendeteksi kode saham yang disebut dan mencocokkannya dengan histori
scan. API key Invezgo dan Supabase service key disimpan aman di server, tidak pernah
terkirim ke browser.

## Arsitektur

```
Browser (klik tombol "Run Scan")
   │  fetch('/api/screener')  ← tidak ada API key di sini
   ▼
api/screener.js (Vercel Serverless Function)
   │  1. Scan ~900 saham dari Invezgo (concurrency 10)
   │  2. Simpan SEMUA hasil ke Supabase (scan_runs + scan_results)
   │  3. Kembalikan hasil yang sudah difilter (top 25) ke browser
   ▼
   ├──► Invezgo API (https://api.invezgo.com)
   └──► Supabase (Postgres) — histori setiap run tersimpan permanen

Browser (paste pesan mentor, klik "Cross-Check")
   │  fetch('/api/mentor-call', { method: 'POST', body: { message } })
   ▼
api/mentor-call.js (Vercel Serverless Function)
   │  1. Ambil daftar kode saham resmi dari Invezgo (untuk validasi)
   │  2a. Regex kasar (4 huruf kapital) + blocklist kata umum
   │  2b. Groq (openai/gpt-oss-20b, opsional) — baca teks dengan konteks kalimat,
   │      sebutkan kode saham yang benar-benar dimaksud sebagai emiten
   │  3. Gabungkan (2a) + (2b), validasi SEMUA terhadap daftar saham resmi
   │  4. Simpan pesan + kode terdeteksi ke Supabase (mentor_calls)
   │  5. Cross-check kode terdeteksi dengan scan_results 7 hari terakhir
   │  6. Cross-check kode terdeteksi dengan mentor_calls sebelumnya (riwayat mentor)
   ▼
   ├──► Groq API (opsional, https://api.groq.com)
   └──► Supabase (baca + tulis)

Browser (klik "Cek Scan Sekarang" pada satu kode)
   │  fetch('/api/check-stock?code=BBCA')
   ▼
api/check-stock.js (Vercel Serverless Function)
   │  Cek volume ratio SATU saham saja (bukan 900) — hasil dalam hitungan detik
   ▼
   └──► Invezgo API
```

**Catatan penting soal WhatsApp**: fitur ini TIDAK membaca pesan WhatsApp secara
otomatis. Anda tetap menerima pesan mentor seperti biasa di WA, lalu copy-paste
teksnya ke kotak input di halaman ini. WhatsApp tidak menyediakan API resmi untuk
membaca pesan pribadi/grup secara otomatis tanpa migrasi ke WhatsApp Business API
(yang mengharuskan mentor Anda mengirim ke nomor bisnis, bukan WA pribadi seperti
biasa) — automasi tidak resmi (reverse-engineering WhatsApp Web) melanggar Terms of
Service WhatsApp dan berisiko akun di-banned, jadi sengaja tidak dibangun.

```

Tidak ada cache, tidak ada auto-polling. Function hanya "hidup" selama scan berjalan
(30 detik - 2 menit), lalu berhenti sampai Anda klik tombol lagi.

## Setup Supabase (Sekali Saja)

### 1. Buat project Supabase gratis
Daftar/login di https://supabase.com, buat project baru (pilih region terdekat, misal
Singapore untuk latensi terbaik dari Indonesia).

### 2. Jalankan skema tabel
Buka **SQL Editor** di dashboard Supabase Anda, copy-paste seluruh isi
`supabase/schema.sql` dari repo ini, lalu klik **Run**. Ini membuat tiga tabel:
- `scan_runs` — satu baris per klik "Run Scan" (waktu, durasi, jumlah saham)
- `scan_results` — satu baris per saham per run (SEMUA saham, ditandai `passed_filter`)
- `mentor_calls` — satu baris per pesan mentor yang di-paste, dengan kode saham yang
  terdeteksi disimpan sebagai array

### 3. Ambil URL dan service_role key
Di dashboard: **Project Settings → API**.
- Copy **Project URL** → ini jadi `SUPABASE_URL`
- Copy **service_role key** (bukan `anon`/`public` key!) → ini jadi
  `SUPABASE_SERVICE_ROLE_KEY`

⚠️ **service_role key punya akses penuh ke database Anda, bypass semua keamanan RLS.**
Jangan pernah taruh di kode frontend atau commit ke git — hanya sebagai environment
variable di server (Vercel), sama seperti `INVEZGO_API_KEY`.

## Setup Groq (Opsional — untuk Deteksi Kode Saham Berbasis Konteks)

Regex + blocklist kata umum sudah cukup untuk kasus sederhana, tapi tidak paham
konteks kalimat (misal "emas ANTM" — regex bisa salah tangkap "EMAS" sebagai kandidat
kalau kebetulan ada collision dengan kode saham asli). Groq (gratis, tanpa kartu
kredit) membaca teks dengan pemahaman bahasa, sehingga lebih akurat membedakan mana
yang benar-benar dimaksud sebagai nama emiten.

1. Daftar di https://console.groq.com (gratis, tanpa kartu kredit)
2. Buat API key di https://console.groq.com/keys
3. Set sebagai environment variable:
   ```bash
   vercel env add GROQ_API_KEY
   ```

**Kalau tidak diisi**: sistem tetap jalan normal, hanya mengandalkan regex+blocklist
(kurang akurat untuk kalimat kompleks, tapi tidak akan error). UI akan menunjukkan
status "Deteksi hanya pakai regex+blocklist" kalau Groq tidak aktif.

**Catatan desain penting**: Groq TIDAK menggantikan validasi terhadap daftar saham
resmi Invezgo — LLM tetap bisa berhalusinasi (menyebut kode yang sebenarnya tidak
ada). Hasil dari regex DAN Groq digabung (union), lalu SEMUA kandidat tetap harus
lolos validasi `/analysis/list/stock` sebelum dianggap valid. Model yang dipakai:
`openai/gpt-oss-20b` dengan `strict: true` (structured output, dijamin sesuai JSON
schema — tidak perlu parsing manual yang rawan gagal).

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
cd screener-web
vercel
```

### 4. Set environment variables — WAJIB sebelum jalan
```bash
vercel env add INVEZGO_API_KEY
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add GROQ_API_KEY
```
Pilih semua environment (Production, Preview, Development) untuk masing-masing.
`GROQ_API_KEY` opsional — lihat bagian "Setup Groq" di atas.

Atau lewat dashboard: Project Settings → Environment Variables → tambahkan ketiganya.

### 5. Deploy ke production
```bash
vercel --prod
```

### 6. Buka URL-nya, klik "Run Scan"
Setelah scan selesai, status penyimpanan akan muncul di bawah tombol ("✓ tersimpan ke
histori" atau pesan error kalau gagal).

## Testing Lokal (opsional)

```bash
cp .env.example .env.local
# edit .env.local, isi ketiga env var
npm install
vercel dev
```
Buka `http://localhost:3000`.

## Melihat Histori di Supabase

Buka **Table Editor** di dashboard Supabase, atau query lewat SQL Editor:

```sql
-- Semua run, terbaru dulu
select * from scan_runs order by scanned_at desc;

-- Hasil satu run tertentu (semua saham, termasuk yang tidak lolos filter)
select * from scan_results where run_id = 'uuid-run-tertentu' order by volume_ratio desc;

-- Histori satu saham dari waktu ke waktu (lintas semua run)
select r.scanned_at, s.volume_ratio, s.passed_filter
from scan_results s
join scan_runs r on r.id = s.run_id
where s.code = 'BBCA'
order by r.scanned_at desc;

-- Semua pesan mentor yang pernah menyebut kode saham tertentu
select * from mentor_calls where 'BBCA' = any(codes) order by received_at desc;
```

## Cross-Check Pesan Mentor

Di bagian bawah halaman ada kotak "Cross-Check Pesan Mentor". Cara pakai:

1. Copy teks pesan dari WhatsApp mentor Anda (misal: "Beli BBRI area 4200, target 4500").
2. Paste ke kotak teks, klik **Cross-Check**.
3. Sistem akan:
   - Mendeteksi kode saham di teks (regex 4 huruf kapital, divalidasi terhadap daftar
     kode saham resmi dari Invezgo — supaya kata seperti "AREA" atau "JUAL" tidak salah
     terdeteksi sebagai kode saham)
   - Menyimpan pesan ini ke tabel `mentor_calls` (permanen, untuk cross-check arah
     sebaliknya di masa depan)
   - Menampilkan apakah kode yang terdeteksi muncul di histori `scan_results` 7 hari
     terakhir (dan rasio volumenya kalau ada)
   - Menampilkan apakah mentor pernah menyebut kode yang sama di pesan-pesan sebelumnya

**Kenapa harus paste manual, bukan otomatis dari WhatsApp?** Lihat penjelasan di bagian
Arsitektur di atas — WhatsApp tidak punya API resmi untuk membaca pesan pribadi secara
otomatis tanpa migrasi ke WhatsApp Business API (perlu mentor Anda kirim ke nomor bisnis
terpisah) atau memakai automasi tidak resmi yang melanggar Terms of Service WhatsApp.
Kalau nanti Anda ingin upgrade ke otomatis, opsi paling ringan adalah pindah channel ke
Telegram (Bot API resmi, gratis) — bukan tetap di WhatsApp.

## Cek Cepat Satu Saham (Tanpa Full Scan)

Di setiap kode saham yang terdeteksi dari cross-check mentor, ada tombol **"Cek Scan
Sekarang"**. Ini memanggil `api/check-stock.js` — endpoint terpisah yang cuma cek
volume ratio SATU saham (bukan 900 saham seperti "Run Scan" utama). Hasilnya muncul
dalam hitungan detik, cocok untuk verifikasi cepat tanpa menunggu full scan.

Endpoint: `GET /api/check-stock?code=BBCA` — mengembalikan volume ratio, harga, dan
persentase perubahan saham itu berdasarkan 2 hari perdagangan terakhir.

## Durasi Function & Limit Vercel

Vercel Hobby (gratis) dengan Fluid Compute (default sekarang) punya batas durasi function
**300 detik**. `vercel.json` men-set `maxDuration: 120` sebagai jaring pengaman eksplisit —
kalau scan Anda butuh lebih lama, naikkan angka ini (maksimal 300 untuk Hobby plan).

## Batasan yang Perlu Disadari

- **Bukan proses background**: scan hanya jalan saat Anda klik tombol.
- **Volume data di Supabase**: tiap klik "Run Scan" menulis ~900 baris ke `scan_results`.
  Untuk pemakaian sesekali sehari, ini jauh di bawah limit Free tier Supabase (500MB
  database, cukup untuk puluhan ribu run sebelum mendekati limit).
- **Kalau penyimpanan Supabase gagal** (env var salah, koneksi timeout, dll), hasil scan
  tetap ditampilkan ke Anda — hanya histori yang tidak tersimpan untuk run itu. Pesan
  error akan muncul di UI.
- **Rate limit Invezgo tetap berlaku** — untuk pemakaian sesekali sehari, risiko kena
  rate limit sangat kecil.

## Menyesuaikan Parameter Screener

Edit langsung di `api/screener.js`:
```js
const MIN_VOLUME_RATIO = 3.0;
const MIN_PREV_VOLUME = 1_000_000;
const MIN_PRICE = 50;
const TOP_N = 25;
const CONCURRENCY = 10;
```
Setelah edit, `vercel --prod` lagi untuk redeploy.

## Referensi

Dibangun dari skill `invezgo-screener` (endpoint, auth scheme, tipe data — semua sudah
diverifikasi terhadap OpenAPI spec resmi Invezgo). Lihat juga notebook
`volume_scalping_screener.ipynb` di repo terpisah untuk versi Jupyter dengan inspeksi
candlestick manual dan exclude-ARA opsional (belum ada di versi web ini).
