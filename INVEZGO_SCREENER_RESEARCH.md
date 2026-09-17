# INVEZGO_SCREENER_RESEARCH.md

Tugas untuk agent Claude yang PUNYA akses browser/internet ke
`https://docs.invezgo.com` (agent di sandbox lain tidak bisa akses domain ini
karena diblokir egress proxy-nya). Ini murni riset dokumentasi, BUKAN tugas
ubah kode. Jangan ubah file apa pun di repo ini.

## Sumber

Buka: https://docs.invezgo.com/api/#tag/screener/POST/screener/screen

Kalau halaman tidak bisa diakses, coba juga:
- https://docs.invezgo.com/api/#tag/screener (index tag Screener)
- Cari link "Formula Reference" / "Available Variables" / "Available Fields"
  di navigasi kiri atau di dalam halaman `POST /screener/screen`.

## Yang perlu dicari (jawab tiap poin, atau tulis "NOT FOUND" kalau memang
tidak ada di dokumentasi setelah dicari)

1. **Rate limit lengkap untuk `POST /screener/screen`.**
   Di halaman terlihat teks terpotong: "Rate Limit: Khusus endpoint ini
   terdapat batas maksimum 1 request per **___**" — isi bagian yang hilang
   ini persis (per menit? per jam? per hari? per API key?).

2. **Daftar lengkap field/variabel yang valid dipakai di dalam string
   `formula`** (field seperti `prev`, `close` sudah diketahui dari contoh
   `"prev < close"`). Untuk tiap field, catat:
   - Nama field persis (case-sensitive kalau ada bedanya)
   - Artinya (harga penutupan hari ini? volume? frekuensi transaksi?
     order book level berapa? dsb)
   - Apakah realtime atau EOD (harian)
   - Tipe data (number/string/boolean)

3. **Operator dan sintaks formula yang didukung** — operator perbandingan
   (`<`, `>`, `==`, dst), operator logika (`AND`/`OR`/`&&`/`||`), apakah
   bisa pakai fungsi (misal `avg()`, `sum()`, referensi ke N hari lalu
   seperti `close[-1]` atau `ma20`), dan batas panjang formula (di skema
   terlihat `max length: 1024`, konfirmasi ini juga).

4. **Semua contoh formula lain** yang ditampilkan di dokumentasi (selain
   `"prev < close"`) — salin persis.

5. **Field `category`** — konfirmasi daftar lengkap enum value-nya (yang
   sudah terlihat: COMPOSITE, SYARIAH, IDXENERGY, IDXBASIC, IDXINDUST,
   IDXNONCYC, IDXCYCLIC, IDXHEALTH — ada tombol "Show all values" yang
   belum di-expand, klik itu dan salin sisanya).

6. **Endpoint `GET /screener` (Daftar Preset Screener)** — apakah response
   200-nya berisi preset BAWAAN dari Invezgo (preset publik/global) atau
   HANYA preset yang sudah pernah kita simpan sendiri lewat
   `POST /screener` (Simpan Preset Screener)? Ini penting: kalau Invezgo
   punya preset publik siap pakai (mis. "Volume Breakout", "Value Growth"),
   sebutkan nama-namanya dan formula-nya kalau terlihat.

7. **Endpoint `GET /usage` (API Usage)** — salin skema response 200
   lengkap (field apa saja yang dikembalikan: sisa kuota, kuota terpakai,
   limit bulanan, reset date, dsb — nama field persis dan tipe datanya).
   Ini dibutuhkan untuk bikin gauge kuota di admin panel aplikasi kita.

8. **Endpoint Batch** (`[REALTIME] Batch Stock Order Book`,
   `[REALTIME] Batch Stock Intraday Data`, `[REALTIME] Batch Index
   Intraday Data`) — untuk masing-masing: method, path, request body
   (apakah menerima array kode saham sekaligus, berapa maksimal kode per
   request), rate limit, dan contoh response.

## Format jawaban

Balas sebagai satu pesan terstruktur per nomor (1-8 di atas), pakai kutipan
teks PERSIS dari dokumentasi (jangan parafrase field/rate-limit/formula —
itu harus akurat kata demi kata karena akan dipakai untuk menulis kode).
Kalau satu poin tidak ketemu di dokumentasi manapun, tulis:
`<nomor>. NOT FOUND — <dimana sudah dicari>`.

Jangan menebak atau mengarang nilai apa pun yang tidak benar-benar terlihat
di halaman dokumentasi.
