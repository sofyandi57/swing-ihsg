# INVEZGO_BANDARMOLOGI_RESEARCH.md

Tugas untuk agent Claude yang PUNYA akses browser/internet ke
`https://docs.invezgo.com` (agent di sandbox lain tidak bisa akses domain ini
karena diblokir egress proxy-nya). Ini murni riset dokumentasi, BUKAN tugas
ubah kode. Jangan ubah file apa pun di repo ini.

## Konteks

App ini (`swing-ihsg`) mau menambah fitur "bandarmologi" (analisis jejak
broker/institusi/asing per saham — siapa akumulasi, siapa distribusi, broker
mana yang "jaga" harga). Semua data pasar saat ini ditarik dari Invezgo API.
Sebelum implementasi, perlu tahu persis skema endpoint-endpoint broker di
bawah ini — dari sidebar dokumentasi terlihat ada, tapi belum pernah dipakai
di kode kita.

## Sumber

Buka: https://docs.invezgo.com/api (index), lalu cari tiap endpoint di bawah
di sidebar kiri (grup di luar "Screener"/"Batch"/"Usage" yang sudah pernah
diriset — cari grup semacam "Broker"/"Insider"/dsb).

## Yang perlu dicari — UNTUK SETIAP endpoint berikut, jawab poin a-f, atau
tulis "NOT FOUND" kalau memang tidak ada di dokumentasi setelah dicari:

1. **Stock Broker Stalker**
2. **Broker Stalker List**
3. **Stock Broker Summary Chart**
4. **Broker Broker Summary Chart**
5. **Stock Inventory Chart**
6. **Broker Inventory Chart**
7. **[REALTIME] Stock Momentum Chart**
8. **Stock Distribution Chart**
9. **Stock Insider KSEI** (+ **Stock Insider KSEI Chart**)
10. **Stock Insider 1%** (+ **Stock Insider 1% Chart**)
11. **Stock Insider IDX** (+ **Stock Insider IDX Chart**)

Untuk tiap nomor di atas, catat:

a. **Method + path lengkap** (contoh: `GET /analysis/broker/stalker/{code}`).
b. **Path/query parameter** — wajib vs opsional, terutama: apakah butuh kode
   saham (single atau bisa banyak dipisah `|`/`,` seperti Batch endpoint
   yang sudah kita ketahui), rentang tanggal (`from`/`to`), kode broker
   (misal `YP`, `PD`, dst — kalau ada param semacam itu, sebutkan formatnya).
c. **Contoh response 200 LENGKAP** (salin persis dari dokumentasi, jangan
   diringkas) — terutama nama field per broker (misal `broker_code`,
   `net_buy`, `net_sell`, `buy_value`, `sell_value`, `buy_lot`, `sell_lot`,
   `accumulated_lot`, dst — salin nama field ASLI, jangan diterjemahkan).
d. **Granularitas data**: per hari (EOD) per broker? Kumulatif dari tanggal
   tertentu? Real-time?
e. **Rate limit** khusus endpoint ini (kalau ada, seperti "1 request per
   menit" yang ditemukan di endpoint Screener kemarin).
f. **Requirement tier/paket** — apakah endpoint ini butuh tier langganan
   lebih tinggi dari yang sudah dipakai (Advance) untuk diakses (kode 402
   biasanya menandakan ini di dokumentasi Invezgo)?

## Tambahan

12. Apakah ada versi **Batch** untuk salah satu endpoint broker di atas
    (pola sama seperti `/batch/intraday-data`, `/batch/order-book` yang
    sudah kita pakai) — supaya bisa tarik banyak kode saham sekaligus dalam
    satu request, bukan satu-satu?

13. Apakah ada daftar **kode broker resmi** (misal endpoint
    `GET /broker/list` semacamnya) yang memetakan kode broker (YP, PD, dst)
    ke nama broker aslinya (Mirae, Indo Premier, dst)? Kalau ada, catat
    method+path-nya.

## Format jawaban

Balas terstruktur per nomor 1-13, kutip PERSIS dari dokumentasi (jangan
parafrase nama field/parameter/rate-limit — harus akurat kata demi kata
karena akan dipakai untuk menulis kode). Kalau satu poin tidak ketemu di
dokumentasi manapun, tulis: `<nomor>. NOT FOUND — <dimana sudah dicari>`.
Jangan menebak atau mengarang nilai apa pun yang tidak benar-benar terlihat
di halaman dokumentasi.
