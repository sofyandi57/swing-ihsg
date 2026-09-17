# CLAUDE_CODE_BRIEFING.md

Dokumen ini adalah briefing untuk melanjutkan pengembangan project ini di Claude Code.
`README.md` (di folder yang sama) adalah dokumentasi teknis detail (setup Supabase,
Groq, endpoint) — baca itu untuk detail implementasi. Dokumen ini menjelaskan **konteks
dan keputusan** di baliknya, supaya tidak diulang dari nol atau dibalik tanpa sadar.

---

## 1. Apa yang sudah ada (state saat ini)

Screener saham IDX (Bursa Efek Indonesia) berbasis volume-ratio ("volume scalping"),
dijalankan lewat tombol manual di web app, dengan histori tersimpan di Supabase dan
fitur cross-check pesan mentor trading. Semua sudah **berfungsi secara teknis** (syntax
tervalidasi, endpoint API terverifikasi terhadap OpenAPI spec resmi Invezgo), tapi
**UI-nya masih fungsional-minimal — belum didesain, belum mobile-optimized.**

### Struktur project (`screener-web/`)
```
api/
  screener.js       — scan ~900 saham, hitung volume ratio, simpan ke Supabase
  mentor-call.js     — cross-check pesan mentor (regex+Groq+validasi) vs histori scan
  check-stock.js     — cek cepat 1 saham (bukan full scan)
public/
  index.html         — SATU file HTML+CSS+JS, tanpa build step, tanpa framework
supabase/
  schema.sql         — 3 tabel: scan_runs, scan_results, mentor_calls
spec/
  invezgo-openapi.json / .yaml — spec resmi Invezgo (94 endpoint), SUMBER KEBENARAN
                                  untuk semua path/parameter/field — cek ini, bukan
                                  tebak dari training data atau SDK pihak ketiga
vercel.json          — maxDuration config
package.json         — cuma 1 dependency: @supabase/supabase-js
.env.example          — daftar env var yang dibutuhkan
README.md             — dokumentasi teknis detail (setup, endpoint per file)
```

### Fitur yang sudah jalan
1. **Run Scan** — scan manual ~900 saham BEI, filter volume_ratio ≥ 3x, simpan SEMUA
   hasil (bukan cuma yang lolos filter) ke Supabase sebagai histori.
2. **Cross-Check Pesan Mentor** — paste teks pesan WhatsApp mentor trading, sistem
   ekstrak kode saham yang disebut (regex + blocklist kata umum + Groq LLM opsional
   untuk pemahaman konteks kalimat), validasi ke daftar saham resmi Invezgo, lalu
   cross-check dua arah: apakah saham itu ada di histori scan 7 hari terakhir, dan
   apakah mentor pernah menyebutnya sebelumnya.
3. **Cek Scan Sekarang** — tombol per-kode untuk cek volume ratio 1 saham saja
   (detik, bukan menit) tanpa full scan.

---

## 2. Keputusan yang SUDAH diambil — jangan dibalik tanpa alasan baru

Ini bukan preferensi sepele — masing-masing punya alasan konkret dari iterasi
sebelumnya. Kalau Claude Code (atau Anda) mempertimbangkan mengubah salah satu ini,
baca dulu alasannya di bawah.

### 2.1 TIDAK ADA automasi WhatsApp — dan ini keputusan final, bukan TODO
**Dian dengan sengaja meminta fitur WhatsApp**, tapi solusinya adalah **paste
manual** ke textarea, BUKAN membaca pesan WA secara otomatis. Alasannya:
- WhatsApp tidak punya API resmi untuk membaca pesan pribadi/grup secara otomatis.
- WhatsApp Business Cloud API resmi ADA, tapi mengharuskan mentor Dian mengirim ke
  nomor bisnis terpisah (bukan WA pribadi seperti biasa) — mengubah kebiasaan orang
  lain, bukan cuma keputusan teknis Dian.
- Automasi tidak resmi (reverse-engineering WhatsApp Web, library seperti
  whatsapp-web.js/Baileys) **melanggar Terms of Service WhatsApp** dan berisiko akun
  di-banned. Ini ditolak secara eksplisit, bukan karena sulit tapi karena melanggar.
- **Kalau nanti butuh otomatis penuh**, jalur yang direkomendasikan adalah pindah
  channel komunikasi pagi dari WhatsApp ke **Telegram** (Bot API resmi, gratis,
  tidak perlu approval bisnis) — tapi ini tetap butuh mentor Dian mau pindah
  platform, jadi belum dibangun, hanya didiskusikan sebagai opsi masa depan.

**Kalau README/prompt manapun bilang "WhatsApp message" sebagai fitur yang diinginkan,
itu berarti UI untuk paste manual + cross-check, TIDAK berarti baca otomatis dari WA.**

### 2.2 Run-on-demand (tombol), BUKAN polling otomatis
Awalnya dibangun sebagai polling 5-10 detik sementara tab terbuka. Dian mengubah
keputusan ini sendiri karena:
- Terlalu agresif untuk rate limit Invezgo (900 saham per scan).
- Dian sebenarnya hanya perlu jalankan sesekali sehari, bukan real-time terus-menerus.
- Kalau nanti diminta "buat otomatis jalan sendiri", itu perlu arsitektur BERBEDA
  (cron job terjadwal, misal GitHub Actions atau Vercel Cron) — bukan kembali ke
  polling browser. Jangan asumsikan "otomatis" = "polling browser" lagi.

### 2.3 Semua saham disimpan ke Supabase, bukan cuma yang lolos filter
Eksplisit diminta: `scan_results` menyimpan SEMUA ~900 saham per run (ditandai
`passed_filter` true/false), bukan cuma top 25 yang lolos. Ini untuk analisis historis
di masa depan (misal: "saham apa yang selalu gagal lolos filter — kenapa?").

### 2.4 Groq TIDAK menggantikan validasi resmi — union, bukan pengganti
Ekstraksi kode saham dari teks mentor pakai DUA metode paralel (regex+blocklist DAN
Groq LLM), hasilnya di-union, lalu KEDUANYA tetap wajib divalidasi ke
`/analysis/list/stock` (endpoint resmi Invezgo). Alasan: LLM bisa halusinasi
menyebut kode yang sebenarnya tidak ada. Jangan hilangkan langkah validasi resmi ini
demi "menyederhanakan", walaupun Groq kelihatan cukup akurat.

### 2.5 Semua endpoint API sudah diverifikasi terhadap OpenAPI spec resmi, bukan ditebak
Draft pertama sempat salah total (asumsi SDK generik yang field/authnya tidak cocok).
Setelah itu, **spec resmi Invezgo** (94 endpoint, di `spec/invezgo-openapi.json` dan
`.yaml` di folder ini) jadi sumber kebenaran satu-satunya untuk path, auth
(`Authorization: Bearer <JWT>`), dan tipe data (`volume` adalah STRING di response,
bukan number — wajib di-cast). **Selalu cek spec ini dulu sebelum mengasumsikan
endpoint/parameter/field baru** — jangan menebak dari nama fungsi SDK pihak ketiga
atau dari training data, itu yang menyebabkan kesalahan berulang sebelumnya.

---

## 3. Visi yang diminta sekarang — redesign total

Permintaan Dian saat ini: **"beautiful, banyak fitur (AI, one-button scalping, API
Invezgo, WhatsApp message, dll), mobile-compatible tinggi (S24 Ultra + iPhone 11)."**

Ini artinya rebuild tampilan (bukan logika backend yang sudah benar) dengan standar
jauh lebih tinggi dari yang ada sekarang. Baca `README.md` untuk detail backend yang
sudah ada — bagian ini fokus ke apa yang BELUM ada dan perlu dibangun.

### 3.1 Kondisi UI saat ini — JUJUR, bukan optimis
UI sekarang (`public/index.html`) itu **satu file HTML/CSS/JS polos**, dark theme
sederhana, TIDAK ADA media query, TIDAK ADA horizontal-scroll handling untuk tabel
7-kolom di layar kecil, TIDAK ADA touch-target sizing khusus mobile. Ini prototype
fungsional, bukan produk jadi. Redesign dari sini bukan "polish", tapi rebuild
tampilan.

### 3.2 Constraint mobile yang konkret (S24 Ultra + iPhone 11)
- **iPhone 11**: Safari iOS, viewport ~375×812pt (CSS px), notch di atas — perhatikan
  `safe-area-inset` kalau ada elemen fixed di top/bottom. Safari iOS punya perilaku
  address-bar yang mengubah `100vh` secara dinamis — hindari `height: 100vh` untuk
  elemen kritis, pertimbangkan `100dvh` atau JS-based fallback.
- **S24 Ultra**: Chrome Android, viewport lebih besar (~480×1080dp), tapi tetap mobile
  — jangan asumsikan desktop breakpoint cukup.
- **Tabel 7 kolom** (Symbol, Volume, Prev Volume, Ratio, Price, Prev Price, Change%)
  TIDAK akan muat di layar <400px tanpa strategi: opsi umum adalah card-based layout
  untuk mobile (satu card per saham, bukan baris tabel), atau horizontal scroll
  dengan sticky first-column.
- **Touch target minimum** ~44×44px (Apple HIG) / ~48×48dp (Material Design) untuk
  semua tombol termasuk "Cek Scan Sekarang" yang sekarang kecil.
- Test di kedua browser nyata (atau minimal Chrome DevTools device emulation +
  Safari Responsive Design Mode) sebelum menganggap selesai.

### 3.3 Fitur yang disebut Dian — pemetaan ke yang sudah ada vs yang baru
| Fitur yang disebut | Status |
|---|---|
| "AI" | Sudah ada (Groq, di mentor cross-check) — mungkin dimaksud diperluas ke fitur AI lain, TANYAKAN ke Dian sebelum menambah scope baru yang tidak jelas |
| "One button scalping" | Sudah ada (tombol "Run Scan") — redesign visual, bukan logika baru |
| "API Invezgo" | Sudah ada, terverifikasi terhadap OpenAPI spec resmi |
| "WhatsApp message" | Sudah ada SEBAGAI PASTE MANUAL (lihat 2.1) — JANGAN diartikan sebagai automasi baca WA otomatis |
| "dll" (fitur lain) | Tidak spesifik — Claude Code sebaiknya tanya Dian dulu daripada menebak scope, karena riwayat project ini menunjukkan asumsi yang tidak diverifikasi berulang kali menyebabkan rework |

### 3.4 Keputusan yang SUDAH dijawab Dian (update dari draft briefing sebelumnya)
1. **Framework: React, dikonfirmasi.** Ini mengubah `public/index.html` (satu file
   statis) menjadi struktur React dengan build step (Vite direkomendasikan — paling
   umum dipasangkan dengan Vercel, minim konfigurasi). `api/*.js` (serverless
   functions) TIDAK perlu diubah — mereka endpoint HTTP biasa, kompatibel dengan
   frontend apa pun. Yang berubah murni di sisi `public/` → jadi `src/` dengan
   komponen React, plus `vite.config.js`, `index.html` sebagai shell, dan build
   output yang di-serve Vercel.

### 3.5 Yang masih perlu diklarifikasi SEBELUM redesign besar dimulai
Supaya Claude Code tidak menebak dan berujung rework (seperti yang terjadi berkali-kali
di riwayat project ini), sebaiknya konfirmasi ke Dian dulu:
1. **"AI" yang dimaksud di luar PDF Watchlist**: PDF Watchlist (lihat section 4) sudah
   menjawab sebagian, tapi apakah ada fitur AI lain yang dibayangkan (misal: AI kasih
   insight/narasi otomatis dari hasil scan harian)?
2. **Desain visual**: ada referensi visual/mood board yang disuka (misal: aplikasi
   trading tertentu, dark/light mode preference, warna brand)?
3. **Priority fitur**: kalau semua tidak bisa dikerjakan sekaligus dalam satu sesi,
   urutan prioritas: migrasi React dulu (fondasi UI baru), atau PDF Watchlist dulu
   (fitur baru di atas UI lama), atau paralel?

---

## 4. Fitur baru: PDF → AI → Watchlist Tab

Diminta Dian setelah briefing awal ditulis. Alurnya sama secara prinsip dengan mentor
cross-check (`api/mentor-call.js`) yang sudah ada — regex+blocklist+Groq+validasi
resmi — TAPI beda tujuan akhir: mentor cross-check itu histori pasif sekali cek,
watchlist ini adalah **state aktif yang terus dipantau**, digabung dengan status scan
terkini tiap kali dilihat.

**Konteks dari Dian**: isi PDF biasanya riset/rekomendasi saham (mirip pesan mentor
tapi lebih panjang) — bukan laporan keuangan dengan tabel angka kompleks (belum
perlu OCR/table-extraction khusus untuk versi awal).

### 4.1 Alur data
```
Upload PDF (UI baru, tab "Watchlist")
   ↓
Ekstrak teks dari PDF di server (library seperti pdf-parse di Node — Claude Code
pilih yang paling stabil untuk Vercel serverless, perhatikan ukuran bundle & apakah
butuh native binary yang tidak jalan di serverless)
   ↓
Kirim teks ke Groq (openai/gpt-oss-20b, strict JSON schema) — BUKAN cuma ekstrak
kode saham seperti mentor-call.js, tapi juga ringkasan/insight singkat PER KODE
(misal: "target 4500, rekomendasi buy, alasan: ..."), karena PDF riset biasanya
punya konteks lebih kaya yang sayang dibuang kalau cuma diambil kodenya
   ↓
Union dengan regex+blocklist (pola SAMA seperti mentor-call.js) — SAMA-SAMA WAJIB
divalidasi ke /analysis/list/stock sebelum dipercaya (jangan lewati langkah ini
demi PDF, sama seperti mentor cross-check)
   ↓
Simpan ke DUA tabel:
  - pdf_extracts   (histori mentah — kapan, file apa, isi apa, kode apa yang terdeteksi)
  - watchlist      (state aktif — UPSERT per kode: kalau kode sudah ada di watchlist,
                     update source/notes-nya, bukan duplikat baris)
   ↓
Tab "Watchlist" — LEFT JOIN watchlist dengan scan_results TERBARU per kode (query
per kode: ambil satu baris scan_results paling baru untuk kode itu, dari run
manapun) → tampilkan kode + catatan AI + status scan terkini (volume ratio, lolos
filter atau belum, kapan terakhir di-scan)
```

### 4.2 Skema tabel baru — SUDAH digabung ke `supabase/schema.sql`
Tabel `pdf_extracts` dan `watchlist` sudah ada di `supabase/schema.sql` (tidak perlu
ditambahkan manual lagi) — Dian masih perlu re-run seluruh file itu di Supabase SQL
Editor karena `create table if not exists` aman dijalankan ulang tanpa merusak data
yang sudah ada. Ringkasan strukturnya:
```sql
create table if not exists pdf_extracts (
  id uuid primary key default gen_random_uuid(),
  uploaded_at timestamptz not null default now(),
  filename text not null,
  raw_text text not null,
  detected_codes text[] not null default '{}',
  ai_notes jsonb  -- {"BBCA": "target 4500, alasan...", "ANTM": "..."} per kode
);

create table if not exists watchlist (
  code text primary key,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null,           -- 'pdf' | 'mentor_call' | 'manual'
  source_ref_id uuid,             -- id ke pdf_extracts.id atau mentor_calls.id
  notes text                      -- ringkasan AI terkini untuk kode ini
);
```

**Catatan upsert watchlist**: kalau kode yang sama muncul lagi dari sumber baru
(misal disebut lagi di PDF lain, atau juga disebut mentor via WA), upsert
`updated_at`, `source`, `source_ref_id`, `notes` — jangan buat baris duplikat.
`code` sebagai primary key memaksa ini secara alami lewat `ON CONFLICT (code) DO
UPDATE`.

### 4.3 Query "status scan terkini" untuk tab Watchlist
Per kode di watchlist, ambil baris `scan_results` terbaru (dari run manapun, tidak
harus run hari ini — kalau saham itu tidak lolos scan hari ini, tunjukkan kapan
terakhir dia muncul, jangan kosong begitu saja):
```sql
select w.*, sr.volume_ratio, sr.passed_filter, sr.price, r.scanned_at
from watchlist w
left join lateral (
  select sr.*, sr.run_id from scan_results sr where sr.code = w.code
  order by sr.run_id desc limit 1
) sr on true
left join scan_runs r on r.id = sr.run_id
order by w.updated_at desc;
```
(Sesuaikan kalau struktur query Supabase client butuh bentuk berbeda — ini contoh
SQL mentah untuk menjelaskan logikanya, bukan kode Supabase-js final.)

### 4.4 UI Watchlist tab — poin desain
- Satu tab terpisah (konsisten dengan struktur tab yang mulai terbentuk: Run Scan,
  Cross-Check Mentor, sekarang Watchlist).
- Tiap baris/card: kode saham, sumber (badge "dari PDF" / "dari mentor" / "manual"),
  catatan AI singkat, status scan terkini (rasio volume dengan indikator visual
  jelas kalau sedang lolos filter SEKARANG vs cuma histori lama).
- Upload PDF: drag-drop atau file picker biasa, tampilkan progress (ekstraksi PDF +
  panggilan Groq bisa beberapa detik, jangan biarkan UI diam tanpa feedback).
- Mobile: pertimbangkan camera upload langsung (kalau Dian foto laporan fisik) selain
  file picker — tapi ini enhancement, bukan requirement inti; tanya dulu kalau ingin
  ditambahkan.

---

## 5. Environment variables yang dibutuhkan (sudah aktif di Vercel Dian)

Lihat `.env.example` untuk daftar lengkap. Ringkasan:
- `INVEZGO_API_KEY` — wajib, untuk semua data saham
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — wajib, untuk histori
- `GROQ_API_KEY` — opsional, untuk ekstraksi kode saham berbasis konteks (fallback ke
  regex kalau kosong, tidak error)

Semua sudah pernah di-generate dan disimpan di Vercel Dian — Claude Code tidak perlu
membuat baru kecuali diminta, cukup pastikan kode membacanya dengan benar.

## 6. Preferensi Dian yang berlaku ke semua deliverable
- Script Python (kalau ada) selalu `.ipynb`, bukan `.py`.
- Jangan gunakan Google Drive untuk deliverable — file di-deliver langsung.
