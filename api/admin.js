// api/admin.js
// Vercel Serverless Function — semua operasi admin dalam satu endpoint, dipilah
// lewat query param `resource`. Setiap request WAJIB header:
//   Authorization: Bearer <access_token dari supabase.auth session di browser>
//
// Alur verifikasi: token → supabase.auth.getUser(token) untuk dapat email user
// yang login → cek email itu ada di tabel app_admins. TIDAK ada tabel role
// terpisah di Supabase Auth sendiri, jadi app_admins inilah satu-satunya sumber
// kebenaran siapa yang boleh akses resource selain `whoami`.
//
// GET  ?resource=whoami            — cek status login + admin (dipakai semua user)
// GET  ?resource=users             — daftar semua akun yang bisa login (admin only)
// POST ?resource=users             — buat akun baru { email, password } (admin only)
// DELETE ?resource=users&userId=x  — hapus akun (admin only)
// GET  ?resource=settings          — parameter screener saat ini (admin only)
// POST ?resource=settings          — update satu parameter { key, value } (admin only)
// GET  ?resource=history           — ringkasan scan_runs/mentor_calls/pdf_extracts terakhir (admin only)
// GET  ?resource=screener-results[&limit=N] — daftar SEMUA saham yang lolos filter
//                                    (passed_filter=true) dari histori scan_results,
//                                    lengkap kode/harga/value/freq/sektor + mode &
//                                    waktu scan-nya (join scan_runs). Default limit 200,
//                                    maks 1000. (admin only)
// GET  ?resource=secrets           — status ADA/TIDAK env var penting, BUKAN nilainya (admin only)
// GET  ?resource=activity          — log login/logout semua user, terbaru dulu (admin only)
// POST ?resource=activity          — catat SATU event { event: "login"|"logout" } milik diri
//                                    sendiri (bukan admin-only — user manapun yang login boleh
//                                    lapor aktivitasnya sendiri, dipanggil dari LoginPage.jsx
//                                    dan tombol Logout di App.jsx)
// GET  ?resource=quota-flush[&maxRequests=N] — admin only. Tarik banyak dimensi data
//                                    (chart harian, sektor/subsektor, snapshot live) untuk
//                                    saham "paling direkomendasikan" (dari histori scan
//                                    terbaru) + sisanya, dipacing SESUAI rate limit Invezgo
//                                    (250/menit) supaya tidak 429 percuma, sampai budget waktu
//                                    function/quota habis. Balikan CSV langsung (bukan JSON) —
//                                    lihat catatan jujur soal kenapa TIDAK bisa "habiskan semua
//                                    kuota sekaligus" di komentar handleQuotaFlush. Hasil SELALU
//                                    disimpan ke tabel quota_flush_data (upsert per kode), jadi
//                                    tetap berguna meski dipicu cron tanpa ada yang menonton CSV-nya.
//                                    Bisa dipicu VERCEL CRON (lihat vercel.json "crons") dengan
//                                    header "Authorization: Bearer <CRON_SECRET>" (env var, set
//                                    sendiri di Vercel project settings) SEBAGAI GANTI token admin
//                                    biasa — cuma berlaku untuk resource ini, bukan resource admin
//                                    lain. PENTING: saat dipicu CRON (bukan klik manual admin),
//                                    endpoint ini CEK DULU sisa kuota (GET /usage/api, 1 request
//                                    murah) dan SKIP TOTAL kalau kuota terpakai masih di bawah
//                                    QUOTA_FLUSH_THRESHOLD_PCT (env var, default 80%) — jadi cron
//                                    harian cuma benar-benar flush saat kuota mepet, bukan flush
//                                    buta tiap hari tanpa syarat. Klik manual dari Admin panel
//                                    TIDAK kena gate ini (keputusan sadar user). ?force=true
//                                    melewati gate ini (buat testing cron). JUGA ada LOCK
//                                    (app_settings key "quota_flush_lock_until") supaya dua run
//                                    (cron eksternal + klik manual, atau dua klik manual menumpuk)
//                                    tidak jalan BERSAMAAN — ditemukan lewat log Invezgo User yang
//                                    menunjukkan kode saham sama diminta berkali-kali berdekatan
//                                    (429 beruntun karena rate gabungan tembus limit). Lock
//                                    self-healing (expiry, bukan flag permanen) — tidak akan macet
//                                    kalau function mati mendadak.
// GET  ?resource=quota-flush&action=export — admin ATAU cron secret. Export SEMUA data yang
//                                    sudah terkumpul di quota_flush_data sebagai CSV, TANPA
//                                    memanggil Invezgo sama sekali (baca database saja).
// GET  ?resource=quota-usage       — admin only. Satu kali panggil Invezgo GET /usage/api
//                                    (murah, TIDAK dipacing/dihitung seperti quota-flush) untuk
//                                    dapat sisa kuota bulanan { usage, remaining, limit,
//                                    isBlocked, expire } — dipakai gauge di panel Admin.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INVEZGO_BASE_URL = "https://api.invezgo.com";
const INVEZGO_API_KEY = process.env.INVEZGO_API_KEY;

function getAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getRequestUser(req, supabase) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function isAdminEmail(supabase, email) {
  if (!email) return false;
  const { data } = await supabase.from("app_admins").select("email").eq("email", email).maybeSingle();
  return !!data;
}

async function handleWhoami(req, res, supabase) {
  const user = await getRequestUser(req, supabase);
  if (!user) {
    res.status(200).json({ loggedIn: false, isAdmin: false });
    return;
  }
  const admin = await isAdminEmail(supabase, user.email);
  res.status(200).json({ loggedIn: true, email: user.email, isAdmin: admin });
}

async function requireAdmin(req, res, supabase) {
  const user = await getRequestUser(req, supabase);
  if (!user) {
    res.status(401).json({ error: "Belum login." });
    return null;
  }
  const admin = await isAdminEmail(supabase, user.email);
  if (!admin) {
    res.status(403).json({ error: "Akun ini tidak punya akses admin." });
    return null;
  }
  return user;
}

async function handleUsers(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  if (req.method === "GET") {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    const users = data.users.map((u) => ({
      id: u.id,
      email: u.email,
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at,
    }));
    res.status(200).json({ users });
    return;
  }

  if (req.method === "POST") {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: "Field 'email' dan 'password' wajib diisi." });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password minimal 8 karakter." });
      return;
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    res.status(200).json({ id: data.user.id, email: data.user.email });
    return;
  }

  if (req.method === "DELETE") {
    const userId = req.query?.userId;
    if (!userId) {
      res.status(400).json({ error: "Parameter 'userId' wajib diisi." });
      return;
    }
    if (userId === admin.id) {
      res.status(400).json({ error: "Tidak bisa hapus akun sendiri yang sedang login." });
      return;
    }
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    res.status(200).json({ deleted: userId });
    return;
  }

  res.status(405).json({ error: "Method tidak didukung untuk resource 'users'." });
}

const SETTINGS_DEFAULTS = {
  // min_volume_ratio/min_prev_volume DIHAPUS — Stage 1 scan pindah ke batch
  // endpoint yang tidak punya volume kemarin (lihat komentar
  // MIN_VALUE_ACTIVITY di api/screener.js). Diganti min_value_activity +
  // min_freq ("aktivitas tidak biasa hari ini").
  min_value_activity: 500_000_000,
  min_freq: 50,
  min_price: 50,
  top_n: 25,
  concurrency: 20,
  // On/off toggle untuk cron terjadwal (dibaca api/screener.js saat dipicu
  // CRON_SECRET — lihat blok isCronAraHunter/isCronBsjp di handler). Cron
  // Vercel sendiri TETAP terjadwal jalan (vercel.json tidak bisa diubah saat
  // runtime), tapi begitu jalan langsung cek flag ini dan skip total (0
  // request ke Invezgo) kalau di-nonaktifkan lewat toggle di tab Run Scan.
  ara_hunter_cron_enabled: true,
  momentum_sniper_cron_enabled: true,
  // Kill-switch darurat GLOBAL — kalau true, SEMUA endpoint yang memanggil
  // Invezgo (scan di api/screener.js, flush di api/admin.js) langsung
  // menolak sebelum sempat kirim satu request pun. Beda dari toggle cron di
  // atas (yang cuma matikan JADWAL OTOMATIS) — ini juga memblokir klik
  // manual, dipakai kalau kuota mendadak kritis dan User butuh berhenti
  // total sementara, dari mana pun sumber requestnya.
  invezgo_paused: false,
};

async function handleSettings(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  if (req.method === "GET") {
    const { data, error } = await supabase.from("app_settings").select("key, value");
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    const overrides = Object.fromEntries((data || []).map((row) => [row.key, row.value]));
    res.status(200).json({ settings: { ...SETTINGS_DEFAULTS, ...overrides }, defaults: SETTINGS_DEFAULTS });
    return;
  }

  if (req.method === "POST") {
    const { key, value } = req.body || {};
    if (!key || !(key in SETTINGS_DEFAULTS)) {
      res.status(400).json({ error: `Key tidak dikenal. Pilihan valid: ${Object.keys(SETTINGS_DEFAULTS).join(", ")}` });
      return;
    }
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    res.status(200).json({ key, value });
    return;
  }

  res.status(405).json({ error: "Method tidak didukung untuk resource 'settings'." });
}

async function handleHistory(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  const [{ data: runs }, { data: mentorCalls }, { count: pdfCount }, { count: watchlistCount }] = await Promise.all([
    supabase.from("scan_runs").select("*").order("scanned_at", { ascending: false }).limit(20),
    supabase.from("mentor_calls").select("*").order("received_at", { ascending: false }).limit(20),
    supabase.from("pdf_extracts").select("id", { count: "exact", head: true }),
    supabase.from("watchlist").select("code", { count: "exact", head: true }),
  ]);

  res.status(200).json({
    recentRuns: runs || [],
    recentMentorCalls: mentorCalls || [],
    totalPdfExtracts: pdfCount || 0,
    totalWatchlistItems: watchlistCount || 0,
  });
}

// GET ?resource=screener-results[&limit=N] — admin only. Daftar SEMUA saham
// yang LOLOS FILTER (passed_filter=true) dari histori scan_results, join ke
// scan_runs untuk dapat mode/metode + waktu scan-nya. Beda dari
// resource=history (yang cuma ringkasan run, bukan daftar sahamnya).
async function handleScreenerResults(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  const limit = Math.min(Number(req.query?.limit) || 200, 1000);

  const { data, error } = await supabase
    .from("scan_results")
    .select("code, price, price_change_pct, value, freq, volume, sector, subsector, run_id, scan_runs!inner(mode, scanned_at)")
    .eq("passed_filter", true)
    .order("scanned_at", { foreignTable: "scan_runs", ascending: false })
    .limit(limit);

  if (error) {
    res.status(502).json({ error: error.message });
    return;
  }

  const rows = (data || []).map((r) => ({
    code: r.code,
    price: r.price,
    priceChangePct: r.price_change_pct,
    value: r.value,
    freq: r.freq,
    volume: r.volume,
    sector: r.sector,
    subsector: r.subsector,
    mode: r.scan_runs?.mode || null,
    scannedAt: r.scan_runs?.scanned_at || null,
  }));

  res.status(200).json({ rows });
}

async function handleActivity(req, res, supabase) {
  if (req.method === "POST") {
    // Bukan admin-only — user manapun yang sedang login boleh mencatat event
    // login/logout MILIKNYA SENDIRI (user.id dari token, tidak bisa dipalsukan
    // jadi user lain karena diambil dari getRequestUser, bukan dari body).
    const user = await getRequestUser(req, supabase);
    if (!user) {
      res.status(401).json({ error: "Belum login." });
      return;
    }
    const event = req.body?.event;
    if (event !== "login" && event !== "logout") {
      res.status(400).json({ error: "Field 'event' wajib 'login' atau 'logout'." });
      return;
    }
    const { error } = await supabase
      .from("auth_activity_log")
      .insert({ user_id: user.id, email: user.email, event });
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    res.status(200).json({ logged: true });
    return;
  }

  if (req.method === "GET") {
    const admin = await requireAdmin(req, res, supabase);
    if (!admin) return;

    const { data, error } = await supabase
      .from("auth_activity_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    res.status(200).json({ activity: data || [] });
    return;
  }

  res.status(405).json({ error: "Method tidak didukung untuk resource 'activity'." });
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

async function invezgoGet(path, params = {}) {
  const url = new URL(INVEZGO_BASE_URL + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${INVEZGO_API_KEY}` } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Invezgo tier "Advance" User: 30.000 request/bulan, 250 request/menit, TANPA
// batch endpoint (lihat spek Momentum Sniper sesi sebelumnya). "Habiskan
// semua sisa kuota sekaligus" secara LITERAL TIDAK MUNGKIN dalam satu HTTP
// request: 250/menit berarti ~3800 sisa kuota butuh MINIMAL ~15 menit
// nonstop — jauh melebihi batas maxDuration serverless function manapun
// (Vercel Hobby plan maksimal ~300 detik/5 menit). Mengirim lebih cepat dari
// 250/menit JUGA TIDAK menambah kuota terpakai — cuma bikin sebagian besar
// request gagal 429 (dihitung tetap terhadap kuota, TAPI hasilnya kosong -
// jelas lebih buruk daripada dipacing benar). Jadi endpoint ini JUJUR:
// jalankan pacing SEDIKIT DI BAWAH limit (230/menit, buffer aman) selama
// budget waktu function (280 detik, di bawah cap 300 detik Vercel Hobby),
// lalu kembalikan apa pun yang berhasil dikumpulkan sebagai CSV — Admin bisa
// klik lagi beberapa kali dalam sisa 3 jam sebelum reset untuk melanjutkan.
const RATE_LIMIT_PER_MIN = 230;
const PACING_MS = Math.ceil(60000 / RATE_LIMIT_PER_MIN);
const TIME_BUDGET_MS = 280_000;
const CRON_SECRET = process.env.CRON_SECRET;

// Batch endpoints (/batch/intraday-data, /batch/order-book, /batch/intraday-index)
// menerima banyak kode sekaligus (dipisah "|") dalam SATU request — dokumentasi
// Invezgo sebut maks 10 kode untuk Role MAX, 25 untuk Role ELITE/OWNER/ADMIN.
// Tier akun ini belum diketahui, jadi pakai 10 (paling aman, tidak akan pernah
// ditolak). Ini mengganti kebutuhan 1 request PER KODE untuk snapshot live
// (freq/value/volume/bid/offer) jadi 1 request per 10 kode — penghematan besar
// dibanding versi awal quota-flush yang panggil /analysis/intraday-data/{code}
// satu-satu.
const BATCH_SIZE = 10;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function numOrNull(v) {
  return v === "" || v === null || v === undefined ? null : Number(v);
}

// Simpan hasil harvest ke tabel (bukan cuma CSV sekali unduh) — supaya cron
// otomatis (yang jalan tanpa ada browser yang "menonton" responsnya) tetap
// berguna: hasilnya menumpuk di database, Admin export CSV-nya kapan saja
// lewat action=export, terlepas dari trigger-nya manual klik atau cron.
async function saveFlushRows(supabase, rows) {
  if (!supabase || rows.length === 0) return;
  const upsertRows = rows.map((r) => ({
    code: r.code,
    sector: r.sector || null,
    subsector: r.subsector || null,
    is_recommended: r.isRecommended === "yes",
    price: numOrNull(r.price),
    prev_price: numOrNull(r.prevPrice),
    price_change_pct: numOrNull(r.priceChangePct),
    open: numOrNull(r.open),
    high: numOrNull(r.high),
    low: numOrNull(r.low),
    volume: numOrNull(r.volume),
    prev_volume: numOrNull(r.prevVolume),
    volume_ratio: numOrNull(r.volumeRatio),
    value: numOrNull(r.value),
    live_freq: numOrNull(r.liveFreq),
    live_value: numOrNull(r.liveValue),
    live_volume: numOrNull(r.liveVolume),
    bid_price: numOrNull(r.bidPrice),
    offer_price: numOrNull(r.offerPrice),
    bid_lot: numOrNull(r.bidLot),
    offer_lot: numOrNull(r.offerLot),
    updated_at: new Date().toISOString(),
  }));
  await supabase.from("quota_flush_data").upsert(upsertRows, { onConflict: "code" });
}

function rowsToCsv(rows, columns) {
  const header = columns.join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

async function handleQuotaFlush(req, res, supabase) {
  // Cron Vercel mengirim header "Authorization: Bearer <CRON_SECRET>" (env var
  // yang sama diset di Vercel project settings) — TIDAK ada sesi browser/token
  // Supabase saat dipanggil dari cron (bukan dari user yang login), jadi
  // requireAdmin() biasa akan selalu gagal untuk trigger otomatis. Cron secret
  // ini SENGAJA cuma berlaku untuk resource quota-flush (bukan requireAdmin
  // global) — resource admin lain (users/settings/dst) tetap wajib token admin
  // asli, prinsip least-privilege.
  const authHeader = req.headers.authorization || "";
  const isCron = !!CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isCron) {
    const admin = await requireAdmin(req, res, supabase);
    if (!admin) return;
  }

  // action=export — TIDAK memanggil Invezgo sama sekali, cuma baca data yang
  // sudah terkumpul dari harvest sebelumnya (manual atau cron) dan kembalikan
  // sebagai CSV. Dipakai Admin buat lihat/download hasil semalaman tanpa
  // menunggu flush baru selesai.
  if (req.query?.action === "export") {
    const { data, error } = await supabase
      .from("quota_flush_data")
      .select("*")
      .order("is_recommended", { ascending: false })
      .order("updated_at", { ascending: false });
    if (error) {
      res.status(502).json({ error: error.message });
      return;
    }
    const columns = [
      "code", "sector", "subsector", "is_recommended",
      "price", "prev_price", "price_change_pct", "open", "high", "low",
      "volume", "prev_volume", "volume_ratio", "value",
      "live_freq", "live_value", "live_volume", "bid_price", "offer_price", "bid_lot", "offer_lot",
      "updated_at",
    ];
    const csv = rowsToCsv(data || [], columns);
    const filename = `invezgo-quota-flush-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Rows-Total", String((data || []).length));
    res.status(200).send(csv);
    return;
  }

  if (!INVEZGO_API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum diset di environment variable Vercel." });
    return;
  }

  // Kill-switch global (lihat komentar invezgo_paused di SETTINGS_DEFAULTS)
  // — dicek TEPAT SEBELUM request Invezgo pertama, jadi klik manual maupun
  // cron sama-sama dihentikan, tapi action=export (baca database saja, di
  // atas) TETAP jalan normal saat di-pause.
  const { data: pauseRow } = await supabase.from("app_settings").select("value").eq("key", "invezgo_paused").maybeSingle();
  if (pauseRow?.value === true) {
    res.status(200).json({ skipped: true, reason: "Invezgo API sedang di-pause dari Admin panel." });
    return;
  }

  // Cron TIDAK boleh flush buta tiap hari — cek dulu sisa kuota (1 request
  // murah, TIDAK dipacing/dihitung ke budget di bawah) dan SKIP total kalau
  // belum mendekati limit. Ini yang membedakan "flush kalau kuota mepet" dari
  // "flush terjadwal tiap hari tanpa syarat" (User eksplisit menolak yang
  // kedua). Klik manual dari Admin panel TIDAK kena gate ini — itu keputusan
  // sadar user, bukan otomatis. ?force=true bisa dipakai admin untuk lewati
  // gate ini saat testing, meski dipanggil via cron secret.
  const QUOTA_FLUSH_THRESHOLD_PCT = Number(process.env.QUOTA_FLUSH_THRESHOLD_PCT) || 80;
  if (isCron && req.query?.force !== "true") {
    try {
      const usage = await invezgoGet("/usage/api");
      const pct = usage.limit ? (usage.usage / usage.limit) * 100 : 0;
      if (pct < QUOTA_FLUSH_THRESHOLD_PCT) {
        res.status(200).json({
          skipped: true,
          reason: `Kuota terpakai baru ${pct.toFixed(1)}% dari limit (ambang ${QUOTA_FLUSH_THRESHOLD_PCT}%) — flush tidak perlu dijalankan hari ini.`,
          usage,
        });
        return;
      }
    } catch (e) {
      // Gagal cek kuota sendiri — lebih aman SKIP daripada flush buta tanpa
      // tahu kondisi kuota saat ini.
      res.status(200).json({ skipped: true, reason: `Gagal cek kuota sebelum flush: ${String(e.message || e)}` });
      return;
    }
  }

  // Lock sederhana lewat app_settings — mencegah DUA run flush jalan
  // BERSAMAAN (misal cron-job.org tiap 5 menit + klik manual admin di waktu
  // yang sama, atau dua klik manual menumpuk). Root cause 429 beruntun yang
  // ditemukan User: kode yang SAMA muncul berkali-kali dalam rentang waktu
  // berdekatan di log Invezgo — tanda run overlap, gabungan rate-nya tembus
  // limit 250/menit walau tiap run individual taat pacing sendiri-sendiri.
  // Lock pakai EXPIRY (bukan flag boolean polos) supaya self-healing kalau
  // function mati mendadak (timeout/crash) tanpa sempat lepas lock manual —
  // lock kedaluwarsa otomatis setelah TIME_BUDGET_MS + buffer, tidak pernah
  // macet permanen.
  const LOCK_KEY = "quota_flush_lock_until";
  const LOCK_DURATION_MS = TIME_BUDGET_MS + 30_000;
  const { data: lockRow } = await supabase.from("app_settings").select("value").eq("key", LOCK_KEY).maybeSingle();
  const lockUntil = lockRow?.value ? new Date(lockRow.value).getTime() : 0;
  if (lockUntil > Date.now()) {
    res.status(200).json({
      skipped: true,
      reason: `Run flush lain sedang berjalan (lock aktif sampai ${new Date(lockUntil).toISOString()}) — dilewati supaya tidak overlap dan kena rate limit gabungan.`,
    });
    return;
  }
  await supabase
    .from("app_settings")
    .upsert({ key: LOCK_KEY, value: new Date(Date.now() + LOCK_DURATION_MS).toISOString(), updated_at: new Date().toISOString() }, { onConflict: "key" });

  async function releaseLock() {
    try {
      await supabase.from("app_settings").upsert({ key: LOCK_KEY, value: new Date(0).toISOString(), updated_at: new Date().toISOString() }, { onConflict: "key" });
    } catch (e) {
      // Gagal lepas lock manual TIDAK fatal — lock akan expire sendiri
      // setelah LOCK_DURATION_MS berkat mekanisme expiry di atas.
    }
  }

  const requestedMax = Number(req.query?.maxRequests);
  const startedAt = Date.now();
  let requestsUsed = 0;

  function budgetLeft() {
    const timeLeft = Date.now() - startedAt < TIME_BUDGET_MS;
    const countLeft = !Number.isFinite(requestedMax) || requestedMax <= 0 || requestsUsed < requestedMax;
    return timeLeft && countLeft;
  }

  async function paced(path, params) {
    requestsUsed += 1;
    const result = await invezgoGet(path, params);
    await new Promise((r) => setTimeout(r, PACING_MS));
    return result;
  }

  try {
    // 1. Daftar saham resmi (1 request) — juga sumber sector per kode (gratis,
    //    sudah termasuk di respons ini, tidak perlu request terpisah).
    const stockList = await paced("/analysis/list/stock");
    const sectorByCode = new Map(stockList.map((s) => [s.code, s.sector || null]));

    // 2. "Paling direkomendasikan" DULU — kode yang lolos filter di scan_run
    //    TERBARU (mode apapun), diurutkan volume_ratio tertinggi. Sisanya
    //    (universe penuh dikurangi yang sudah masuk daftar rekomendasi)
    //    menyusul di belakang, urutan asli dari Invezgo.
    let recommendedCodes = [];
    try {
      const { data: lastRun } = await supabase
        .from("scan_runs")
        .select("id")
        .order("scanned_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastRun) {
        const { data: passedRows } = await supabase
          .from("scan_results")
          .select("code")
          .eq("run_id", lastRun.id)
          .eq("passed_filter", true)
          .order("volume_ratio", { ascending: false });
        recommendedCodes = (passedRows || []).map((r) => r.code);
      }
    } catch (e) {
      // Gagal ambil rekomendasi bukan alasan gagalkan flush — lanjut tanpa prioritas
    }
    const recommendedSet = new Set(recommendedCodes);
    const restCodes = stockList.map((s) => s.code).filter((c) => !recommendedSet.has(c));
    const orderedCodes = [...recommendedCodes, ...restCodes];

    // 2b. Snapshot live (freq/value/volume + bid/offer level 1) ditarik LEBIH
    //     DULU secara batch (10 kode/request), bukan satu-satu di dalam loop
    //     per-kode di bawah — jauh lebih hemat kuota.
    //
    //     BUG YANG DIPERBAIKI (ditemukan lewat log Vercel — lihat
    //     VERCEL_CRON_DIAGNOSIS.md): versi sebelumnya prefetch batch ini untuk
    //     SELURUH `orderedCodes` (~900 saham, ~90 chunk x 2 endpoint), yang
    //     sendirian sudah bisa menghabiskan seluruh budget 280 detik SEBELUM
    //     loop per-kode di bawah (yang mengisi `rows[]`) sempat mulai sama
    //     sekali — makanya tabel quota_flush_data SELALU kosong walau function
    //     "sukses" jalan penuh. Sekarang prefetch batch DIBATASI ke
    //     `recommendedCodes` saja (jauh lebih sedikit, biasanya puluhan) —
    //     sisanya (restCodes) tidak diprefetch, kolom live/bid/offer-nya
    //     akan kosong di baris tabel jika loop sempat menjangkau kode itu,
    //     itu partial yang bisa diterima, LEBIH BAIK daripada kosong total.
    const liveByCode = new Map();
    const bookByCode = new Map();
    for (const group of chunkArray(recommendedCodes, BATCH_SIZE)) {
      if (!budgetLeft()) break;
      try {
        const results = await paced(`/batch/intraday-data/${group.join("|")}`, { market: "RG" });
        if (Array.isArray(results)) for (const r of results) liveByCode.set(r.code, r);
      } catch (e) {
        // skip chunk ini, lanjut chunk berikutnya
      }
    }
    for (const group of chunkArray(recommendedCodes, BATCH_SIZE)) {
      if (!budgetLeft()) break;
      try {
        const results = await paced(`/batch/order-book/${group.join("|")}`, { market: "RG" });
        if (Array.isArray(results)) for (const r of results) bookByCode.set(r.code, r);
      } catch (e) {
        // skip chunk ini, lanjut chunk berikutnya
      }
    }

    // 3. Untuk tiap kode (sesuai urutan prioritas), tarik 2 dimensi tambahan
    //    yang TIDAK bisa di-batch: chart harian 10 hari (harga/volume) dan
    //    information (subsektor) — snapshot live sudah didapat di atas.
    //    Berhenti begitu budget waktu/jumlah request habis — baris yang
    //    sudah sempat diproses SEBELUM budget habis tetap masuk CSV
    //    (partial, bukan dibuang semua).
    const rows = [];
    const unsavedRows = [];
    for (const code of orderedCodes) {
      if (!budgetLeft()) break;

      const row = {
        code,
        sector: sectorByCode.get(code) || "",
        isRecommended: recommendedSet.has(code) ? "yes" : "no",
        subsector: "",
        price: "", prevPrice: "", priceChangePct: "", open: "", high: "", low: "",
        volume: "", prevVolume: "", volumeRatio: "", value: "",
        liveFreq: "", liveValue: "", liveVolume: "", bidPrice: "", offerPrice: "", bidLot: "", offerLot: "",
      };

      if (budgetLeft()) {
        try {
          const info = await paced(`/analysis/information/${code}`);
          row.subsector = info?.subsector || "";
        } catch (e) {
          // skip dimensi ini untuk kode ini, lanjut ke dimensi berikutnya
        }
      }

      if (budgetLeft()) {
        try {
          const to = new Date();
          const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000);
          const chart = await paced(`/analysis/chart/stock/${code}`, { from: ymd(from), to: ymd(to) });
          if (Array.isArray(chart) && chart.length >= 2) {
            const sorted = [...chart].sort((a, b) => new Date(a.date) - new Date(b.date));
            const today = sorted[sorted.length - 1];
            const prev = sorted[sorted.length - 2];
            const price = Number(today.close);
            const prevPrice = Number(prev.close);
            const volume = Number(today.volume);
            const prevVolume = Number(prev.volume);
            row.price = price;
            row.prevPrice = prevPrice;
            row.priceChangePct = prevPrice > 0 ? (((price - prevPrice) / prevPrice) * 100).toFixed(2) : "";
            row.open = today.open;
            row.high = today.high;
            row.low = today.low;
            row.volume = volume;
            row.prevVolume = prevVolume;
            row.volumeRatio = prevVolume > 0 ? (volume / prevVolume).toFixed(2) : "";
            row.value = Number.isFinite(price) && Number.isFinite(volume) ? Math.round(price * volume) : "";
          }
        } catch (e) {
          // skip
        }
      }

      const live = liveByCode.get(code);
      if (live) {
        row.liveFreq = live.freq ?? "";
        row.liveValue = live.value ?? "";
        row.liveVolume = live.volume ?? "";
      }
      const book = bookByCode.get(code);
      const bid = book?.bid?.[0];
      const offer = book?.offer?.[0];
      if (bid) {
        row.bidPrice = bid.bid1price ?? "";
        row.bidLot = bid.bid1lot ?? "";
      }
      if (offer) {
        row.offerPrice = offer.offer1price ?? "";
        row.offerLot = offer.offer1lot ?? "";
      }

      rows.push(row);
      unsavedRows.push(row);

      // Simpan BERTAHAP tiap 20 kode, BUKAN cuma sekali di akhir loop —
      // bug sebelumnya: kalau function di-kill platform (timeout hard-kill,
      // bukan return biasa) di TENGAH loop, save-sekali-di-akhir ini tidak
      // pernah sempat jalan sama sekali, jadi progress yang sudah didapat
      // hilang total. Simpan tiap batch kecil supaya progress tetap ada
      // di database walau function mati mendadak sebelum loop selesai.
      if (unsavedRows.length >= 20) {
        await saveFlushRows(supabase, unsavedRows);
        unsavedRows.length = 0;
      }
    }

    // Sisa baris yang belum sempat ke-flush oleh batch periodik di atas
    // (kurang dari 20 baris terakhir) — dan sebagai jaring pengaman kalau
    // dipicu manual klik lewat action lama yang mengharapkan save sekali di
    // akhir juga tetap benar.
    if (unsavedRows.length > 0) {
      await saveFlushRows(supabase, unsavedRows);
    }

    const columns = Object.keys(rows[0] || { code: "" });
    const csv = rowsToCsv(rows, columns);

    const filename = `invezgo-quota-flush-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Requests-Used", String(requestsUsed));
    res.setHeader("X-Codes-Processed", String(rows.length));
    res.setHeader("X-Codes-Total", String(orderedCodes.length));
    res.status(200).send(csv);
    await releaseLock();
  } catch (e) {
    await releaseLock();
    res.status(502).json({ error: String(e.message || e), requestsUsed });
  }
}

async function handleSecrets(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  // HANYA status ada/tidak — nilai asli TIDAK PERNAH dikirim ke browser.
  res.status(200).json({
    secrets: {
      INVEZGO_API_KEY: !!process.env.INVEZGO_API_KEY,
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY,
      GROQ_API_KEY: !!process.env.GROQ_API_KEY,
      VITE_SUPABASE_URL: !!process.env.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: !!process.env.VITE_SUPABASE_ANON_KEY,
    },
  });
}

async function handleQuotaUsage(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  if (!INVEZGO_API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum dikonfigurasi." });
    return;
  }

  try {
    const data = await invezgoGet("/usage/api");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}

// GET  ?resource=broker-tier-check — admin only. Test SATU KALI panggil
// endpoint bandarmologi termurah (/analysis/list/broker, tanpa parameter)
// untuk konfirmasi apakah tier akun Invezgo saat ini (Advance) bisa akses
// endpoint broker/insider sama sekali, atau butuh upgrade ke Enterprise
// (dokumentasi Invezgo tandai SEMUA endpoint broker/insider dengan
// "[ENTERPRISE]" tanpa menjelaskan apakah itu gating akses total atau cuma
// pembatasan histori). TIDAK menyimpan data apa pun, cuma cek status.
async function handleBrokerTierCheck(req, res, supabase) {
  const admin = await requireAdmin(req, res, supabase);
  if (!admin) return;

  if (!INVEZGO_API_KEY) {
    res.status(500).json({ error: "INVEZGO_API_KEY belum dikonfigurasi." });
    return;
  }

  try {
    const resp = await fetch(`${INVEZGO_BASE_URL}/analysis/list/broker`, {
      headers: { Authorization: `Bearer ${INVEZGO_API_KEY}` },
    });
    const bodyText = await resp.text();
    let bodyPreview = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      bodyPreview = Array.isArray(parsed) ? parsed.slice(0, 3) : parsed;
    } catch (e) {
      // bukan JSON, biarkan bodyPreview jadi teks mentah
    }

    res.status(200).json({
      httpStatus: resp.status,
      accessible: resp.ok,
      verdict:
        resp.status === 402
          ? "Tier akun TIDAK CUKUP — endpoint broker/insider butuh upgrade ke Enterprise."
          : resp.ok
            ? "Tier akun CUKUP — endpoint broker/insider bisa diakses."
            : `Status tidak terduga (${resp.status}) — cek bodyPreview.`,
      bodyPreview,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}

export default async function handler(req, res) {
  const supabase = getAdminClient();
  if (!supabase) {
    res.status(500).json({ error: "Supabase belum dikonfigurasi (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY kosong)." });
    return;
  }

  const resource = req.query?.resource;

  switch (resource) {
    case "whoami":
      await handleWhoami(req, res, supabase);
      return;
    case "users":
      await handleUsers(req, res, supabase);
      return;
    case "settings":
      await handleSettings(req, res, supabase);
      return;
    case "history":
      await handleHistory(req, res, supabase);
      return;
    case "screener-results":
      await handleScreenerResults(req, res, supabase);
      return;
    case "secrets":
      await handleSecrets(req, res, supabase);
      return;
    case "activity":
      await handleActivity(req, res, supabase);
      return;
    case "quota-flush":
      await handleQuotaFlush(req, res, supabase);
      return;
    case "quota-usage":
      await handleQuotaUsage(req, res, supabase);
      return;
    case "broker-tier-check":
      await handleBrokerTierCheck(req, res, supabase);
      return;
    default:
      res.status(400).json({
        error:
          "Parameter 'resource' tidak valid. Pilihan: whoami, users, settings, history, screener-results, secrets, activity, quota-flush, quota-usage, broker-tier-check.",
      });
  }
}
