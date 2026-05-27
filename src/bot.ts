import { Bot, InlineKeyboard, InputFile, InlineQueryResultBuilder } from "grammy";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { unlink, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { existsSync, createReadStream, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { logger } from "./lib/logger";
import { voiceManager } from "./voice_manager";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// Big buffer prevents freezes on long yt-dlp output (was the silent killer).
const EXEC_OPTS = { maxBuffer: 64 * 1024 * 1024 } as const;

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const bot = new Bot(BOT_TOKEN);
let BOT_USERNAME = "MusicBot";

// ── Persistent data dir (Railway Volume aware) ────────────────────────────
// Set DATA_DIR=/data and attach a Railway Volume to /data for persistence.
// Without a volume, cache resets on every redeploy (ephemeral filesystem).
const DATA_DIR = process.env["DATA_DIR"] ?? join(__dirname, "..");
try { if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
logger.info({ DATA_DIR }, "Data directory");

// ── yt-dlp detection ──────────────────────────────────────────────────────
function findYtDlp(): string {
  const candidates = [
    "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp",
    "/root/.local/bin/yt-dlp",
    join(__dirname, "..", ".venv", "bin", "yt-dlp"),
    "yt-dlp",
  ];
  for (const c of candidates) {
    try { execFileSync(c, ["--version"], { stdio: "pipe" }); return c; } catch { /* next */ }
  }
  throw new Error("yt-dlp not found");
}
let YT_DLP_BIN = "yt-dlp";
try {
  YT_DLP_BIN = findYtDlp();
  const ver = execFileSync(YT_DLP_BIN, ["--version"], { stdio: "pipe" }).toString().trim();
  logger.info({ bin: YT_DLP_BIN, ver }, "yt-dlp ready");
} catch (err) { logger.error({ err }, "yt-dlp NOT found"); }

// ── Cookies: write once to disk from env var ──────────────────────────────
const COOKIE_FILE = join(tmpdir(), "yt_cookies.txt");
function setupCookies(): string | null {
  const raw = process.env["YOUTUBE_COOKIES"];
  const b64 = process.env["YOUTUBE_COOKIES_B64"];
  try {
    if (raw && raw.trim().length > 10) {
      writeFileSync(COOKIE_FILE, raw);
      return COOKIE_FILE;
    }
    if (b64 && b64.trim().length > 10) {
      writeFileSync(COOKIE_FILE, Buffer.from(b64, "base64").toString());
      return COOKIE_FILE;
    }
  } catch (err) { logger.error({ err }, "Failed to write cookies"); }
  return null;
}
const COOKIE_PATH = setupCookies();
if (COOKIE_PATH) logger.info("YouTube cookies loaded ✓");
else logger.warn("No YouTube cookies — bot may get blocked. Add YOUTUBE_COOKIES env var.");

function cookieArgs(): string[] {
  return COOKIE_PATH ? ["--cookies", COOKIE_PATH] : [];
}

// ── Proxy support (set PROXY_URL on Railway to bypass CDN blocks) ──────────
const PROXY_URL = process.env["PROXY_URL"] ?? "";
if (PROXY_URL) logger.info("Proxy configured ✓");
else logger.warn("No PROXY_URL set — Railway IP may be blocked by YouTube CDN");

function proxyArgs(): string[] {
  return PROXY_URL ? ["--proxy", PROXY_URL] : [];
}

// ── File-ID cache (Telegram file_id → instant resend) ─────────────────────
const CACHE_FILE = join(DATA_DIR, "cache.json");
const fileIdCache = new Map<string, { fileId: string; title: string; uploader: string; duration: string }>();
const fileIdToVideo = new Map<string, string>(); // reverse: file_id → videoId
let cacheDirty = false;
let cacheFlushTimer: NodeJS.Timeout | null = null;

async function loadCache() {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, string | { fileId: string; title: string; uploader: string; duration: string }>;
    for (const [videoId, v] of Object.entries(obj)) {
      // Backward-compat: old cache stored just string file_id
      const entry = typeof v === "string"
        ? { fileId: v, title: "", uploader: "", duration: "" }
        : v;
      fileIdCache.set(videoId, entry);
      fileIdToVideo.set(entry.fileId, videoId);
    }
    logger.info({ count: fileIdCache.size }, "Cache loaded");
  } catch { /* first run */ }
}
function scheduleCacheSave() {
  cacheDirty = true;
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(async () => {
    cacheFlushTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    try { await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(fileIdCache))); }
    catch (err) { logger.warn({ err }, "Cache save failed"); }
  }, 2000);
}

// ── Search-result cache (5 min) ───────────────────────────────────────────
type VideoResult = { id: string; title: string; duration: string; durationSec: number; uploader: string; thumbnail: string };
type QueueItem = { videoId: string; title: string; uploader: string; requesterId: number; localFile?: string };

const searchCache = new Map<string, { at: number; results: VideoResult[] }>();
const SEARCH_TTL_MS = 5 * 60 * 1000;

function fmtDuration(sec: number): string {
  if (!sec || isNaN(sec)) return "?:??";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] ?? "0") * 3600) + (parseInt(match[2] ?? "0") * 60) + parseInt(match[3] ?? "0");
}

async function safeEdit(api: Bot["api"], chatId: number, msgId: number, text: string) {
  try { await api.editMessageText(chatId, msgId, text, { parse_mode: "Markdown" }); }
  catch { try { await api.sendMessage(chatId, text, { parse_mode: "Markdown" }); } catch { /**/ } }
}

// ── Concurrency limiter ────────────────────────────────────────────────────
function createLimiter(maxConcurrent: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>(res => waiting.push(res));
    }
    active++;
    try { return await fn(); }
    finally {
      active--;
      const next = waiting.shift();
      if (next) next();
    }
  };
}
const searchLimit = createLimiter(8);
const downloadLimit = createLimiter(4);

// ── Search via YouTube Data API v3 ─────────────────────────────────────────
const YOUTUBE_API_KEY = process.env["GOOGLE_API_KEY"] ?? process.env["YOUTUBE_API_KEY"] ?? "";
if (YOUTUBE_API_KEY) logger.info("YouTube Data API v3 key loaded ✓");
else logger.warn("GOOGLE_API_KEY not set — falling back to yt-dlp search");

async function _searchViaYouTubeAPI(query: string, limit: number): Promise<VideoResult[]> {
  // Step 1: search
  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search?part=snippet` +
    `&q=${encodeURIComponent(query)}&type=video&maxResults=${limit}` +
    `&key=${YOUTUBE_API_KEY}`;
  const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(15_000) });
  if (!searchRes.ok) {
    const body = await searchRes.text().catch(() => "");
    throw new Error(`YouTube API ${searchRes.status}: ${body.slice(0, 200)}`);
  }
  const searchData = await searchRes.json() as {
    items?: Array<{
      id: { videoId: string };
      snippet: {
        title: string;
        channelTitle: string;
        thumbnails: { default?: { url: string }; medium?: { url: string } };
      };
    }>;
    error?: { message: string };
  };
  if (searchData.error) throw new Error(`YouTube API: ${searchData.error.message}`);
  // Filter: only keep items that actually have a videoId (API sometimes returns channels/playlists)
  const items = (searchData.items ?? []).filter(i => !!i.id.videoId);
  if (!items.length) return [];

  // Step 2: fetch durations in one batch
  const ids = items.map(i => i.id.videoId).join(",");
  const detailsUrl =
    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails` +
    `&id=${ids}&key=${YOUTUBE_API_KEY}`;
  const detailsRes = await fetch(detailsUrl, { signal: AbortSignal.timeout(10_000) });
  const durationMap = new Map<string, number>();
  if (detailsRes.ok) {
    const dd = await detailsRes.json() as {
      items?: Array<{ id: string; contentDetails: { duration: string } }>;
    };
    for (const v of dd.items ?? []) durationMap.set(v.id, parseDuration(v.contentDetails.duration));
  }

  return items.map(item => {
    const videoId = item.id.videoId;
    const durSec = durationMap.get(videoId) ?? 0;
    const thumb = item.snippet.thumbnails.medium?.url ?? item.snippet.thumbnails.default?.url ?? "";
    return {
      id: videoId,
      title: item.snippet.title,
      duration: fmtDuration(durSec),
      durationSec: durSec,
      uploader: item.snippet.channelTitle,
      thumbnail: thumb,
    };
  });
}

// ── Search via yt-dlp (fallback) ───────────────────────────────────────────
async function _searchViaYtDlp(query: string, limit: number): Promise<VideoResult[]> {
  const args = [
    `ytsearch${limit}:${query}`,
    "-J", "--flat-playlist",
    "--no-check-certificates",
    "--socket-timeout", "15",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android_vr,mweb",
    ...cookieArgs(),
    ...proxyArgs(),
  ];
  let stdout = "";
  try {
    const r = await execFileAsync(YT_DLP_BIN, args, { timeout: 30_000, ...EXEC_OPTS });
    stdout = r.stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stdout && e.stdout.trim().startsWith("{")) stdout = e.stdout;
    else throw new Error(((e.stderr ?? "") + "").slice(0, 400) || "البحث فشل");
  }
  const playlist = JSON.parse(stdout) as {
    entries?: Array<{ id?: string; title?: string; duration?: number; uploader?: string; channel?: string; thumbnail?: string; thumbnails?: Array<{ url: string }>; }>;
  };
  return (playlist.entries ?? []).filter(e => e.id).map(e => ({
    id: e.id!,
    title: e.title ?? "Unknown",
    duration: fmtDuration(e.duration ?? 0),
    durationSec: e.duration ?? 0,
    uploader: e.uploader ?? e.channel ?? "Unknown",
    thumbnail: e.thumbnail ?? e.thumbnails?.[0]?.url ?? "",
  }));
}

async function searchYouTube(query: string, limit = 5): Promise<VideoResult[]> {
  const key = `${limit}:${query.toLowerCase().trim()}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.results;

  let results: VideoResult[] = [];
  if (YOUTUBE_API_KEY) {
    try {
      results = await searchLimit(() => _searchViaYouTubeAPI(query, limit));
    } catch (err) {
      logger.warn({ err }, "YouTube API search failed — falling back to yt-dlp");
    }
    // fall back if API returned nothing (quota, no results, etc.)
    if (!results.length) {
      logger.info({ query }, "YouTube API returned empty — using yt-dlp fallback");
      results = await searchLimit(() => _searchViaYtDlp(query, limit));
    }
  } else {
    results = await searchLimit(() => _searchViaYtDlp(query, limit));
  }

  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > 500) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) searchCache.delete(oldest[0]);
  }
  return results;
}

// ── Dedupe simultaneous downloads ──────────────────────────────────────────
const downloadingNow = new Map<string, Promise<string>>();

function downloadAudio(videoId: string): Promise<string> {
  const existing = downloadingNow.get(videoId);
  if (existing) return existing;
  const promise = downloadLimit(() => _doDownload(videoId))
    .finally(() => downloadingNow.delete(videoId));
  downloadingNow.set(videoId, promise);
  return promise;
}

const AUDIO_EXTS = ["m4a", "opus", "webm", "ogg", "mp3", "mp4", "aac", "mka"] as const;

function findCachedFile(videoId: string): string | null {
  const dir = tmpdir();
  for (const ext of AUDIO_EXTS) {
    const p = join(dir, `tgbot_${videoId}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

// Download strategies.
// android_vr is first — yt-dlp 2026 falls back to it when no JS runtime is found,
// which is exactly what succeeds on server IPs. Also add --js-runtimes node so yt-dlp
// can use the Node.js binary available on Railway for proper JS decoding.
const DOWNLOAD_STRATEGIES: Array<{ label: string; clientArgs: string[] }> = [
  { label: "android_vr",  clientArgs: ["--extractor-args", "youtube:player_client=android_vr"] },
  { label: "auto",        clientArgs: [] },
  { label: "tv_embedded", clientArgs: ["--extractor-args", "youtube:player_client=tv_embedded"] },
  { label: "mweb",        clientArgs: ["--extractor-args", "youtube:player_client=mweb"] },
  { label: "ios",         clientArgs: ["--extractor-args", "youtube:player_client=ios"] },
  { label: "android",     clientArgs: ["--extractor-args", "youtube:player_client=android"] },
];

async function _doDownload(videoId: string): Promise<string> {
  const cached = findCachedFile(videoId);
  if (cached) { logger.info({ videoId }, "cache hit"); return cached; }

  const cacheDir = tmpdir();
  const outTemplate = join(cacheDir, `tgbot_${videoId}.%(ext)s`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  let lastErr = "";

  for (const { label, clientArgs } of DOWNLOAD_STRATEGIES) {
    const args: string[] = [
      ...cookieArgs(),
      "--no-playlist",
      "--no-warnings",
      "--no-check-certificates",
      "--no-mtime",
      "--no-part",
      "--socket-timeout", "30",
      "--retries", "2",
      "--fragment-retries", "3",
      "--add-header", "Accept-Language:en-US,en;q=0.9",
      "--geo-bypass",
      ...proxyArgs(),
      "-x",                      // extract audio via ffmpeg
      "--audio-format", "best",
      "--audio-quality", "0",
      ...clientArgs,
      "-o", outTemplate,
      url,
    ];

    try {
      await execFileAsync(YT_DLP_BIN, args, { timeout: 120_000, ...EXEC_OPTS });
      const found = findCachedFile(videoId);
      if (found) { logger.info({ videoId, label }, "download ok"); return found; }
      lastErr = "file not produced";
    } catch (err) {
      lastErr = String((err as { stderr?: string }).stderr ?? err).slice(0, 400);
      logger.warn({ videoId, label, err: lastErr.slice(0, 150) }, "attempt failed");

      // Fatal errors — no point retrying
      if (/unavailable|private|removed|This video is not available/i.test(lastErr)) {
        throw new Error("❌ الفيديو غير متاح أو خاص أو محذوف");
      }
      if (/age.restrict|Sign in to confirm your age/i.test(lastErr)) {
        throw new Error("❌ الفيديو مقيد عمرياً — الكوكيز لازم تكون من حساب مسجّل");
      }
      if (/copyright|not available in your country/i.test(lastErr)) {
        throw new Error("❌ الفيديو محجوب في منطقة السيرفر بسبب حقوق النشر");
      }
      if ((/Sign in|confirm you're not a bot/i.test(lastErr)) && !COOKIE_PATH) {
        throw new Error("❌ يوتيوب يطلب تسجيل دخول — أرسل /cookies");
      }

      // Transient errors — continue to next strategy
      logger.info({ videoId, label }, "retrying with next strategy...");
    }
  }

  throw new Error(
    `❌ فشل التحميل بعد ${DOWNLOAD_STRATEGIES.length} محاولات\n` +
    `السبب: ${lastErr.slice(0, 200)}`
  );
}

// ── Download an arbitrary Telegram file (for reply-to-audio voice play) ───
async function downloadTelegramFile(fileId: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("Telegram getFile returned no path");
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const ext = filePath.split(".").pop() ?? "mp3";
  const localPath = join(tmpdir(), `tgreply_${fileId.slice(0, 16)}_${randomBytes(4).toString("hex")}.${ext}`);
  if (existsSync(localPath)) return localPath;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Telegram file download ${res.status}`);
  const { Readable } = await import("node:stream");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(localPath));
  return localPath;
}

// ── Send audio (cache-aware) ──────────────────────────────────────────────
async function sendAudio(
  chatId: number,
  video: Pick<VideoResult, "id" | "title" | "uploader" | "duration">,
  api: Bot["api"],
  statusMsgId?: number,
): Promise<void> {
  const cached = fileIdCache.get(video.id);
  if (cached) {
    if (statusMsgId) api.deleteMessage(chatId, statusMsgId).catch(() => {});
    try {
      await api.sendAudio(chatId, cached.fileId, {
        caption: `• @${BOT_USERNAME} ♪ ${video.duration}`,
      });
      return;
    } catch (err) {
      logger.warn({ err, videoId: video.id }, "cached file_id rejected, re-downloading");
      fileIdToVideo.delete(cached.fileId);
      fileIdCache.delete(video.id);
      scheduleCacheSave();
    }
  }

  let dlMsgId = statusMsgId;
  if (!dlMsgId) {
    dlMsgId = (await api.sendMessage(chatId, `⬇️ جارٍ التحميل…\n${video.title}`)).message_id;
  } else {
    safeEdit(api, chatId, dlMsgId, `⬇️ جارٍ التحميل…\n*${video.title}*`).catch(() => {});
  }

  let filePath: string | undefined;
  try {
    filePath = await downloadAudio(video.id);
    const st = await stat(filePath).catch(() => null);
    if (st && st.size > 49 * 1024 * 1024) {
      throw new Error(`❌ الملف كبير جداً (${(st.size / 1024 / 1024).toFixed(1)}MB) — حد تيليجرام 50MB`);
    }
    const fileName = `audio.${filePath.split(".").pop() ?? "m4a"}`;
    const sent = await api.sendAudio(
      chatId,
      new InputFile(createReadStream(filePath), fileName),
      {
        title: video.title.slice(0, 64),
        performer: video.uploader.slice(0, 64),
        caption: `• @${BOT_USERNAME} ♪ ${video.duration}`,
      },
    );
    if (sent.audio?.file_id) {
      const entry = { fileId: sent.audio.file_id, title: video.title, uploader: video.uploader, duration: video.duration };
      fileIdCache.set(video.id, entry);
      fileIdToVideo.set(sent.audio.file_id, video.id);
      scheduleCacheSave();
    }
    api.deleteMessage(chatId, dlMsgId!).catch(() => {});
  } catch (err) {
    logger.error({ err, videoId: video.id }, "sendAudio failed");
    await safeEdit(api, chatId, dlMsgId!, `❌ ${(err as Error).message?.slice(0, 400) ?? "خطأ غير معروف"}`);
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
  }
}

// ── Voice queue (per chat) ────────────────────────────────────────────────
const voiceQueue = new Map<number, QueueItem[]>();
const nowPlaying = new Map<number, QueueItem>();
const pendingQR = new Map<number, number>();
const playbackMsg = new Map<number, { messageId: number; paused: boolean }>(); // chatId → control msg
const playbackGen = new Map<number, number>(); // chatId → generation (incremented on manual skip/stop)
const currentTrackTmp = new Map<number, string>(); // chatId → tmp file path of current track (for cleanup)

function bumpGen(chatId: number): number {
  const n = (playbackGen.get(chatId) ?? 0) + 1;
  playbackGen.set(chatId, n);
  return n;
}

async function cleanupCurrentTrackTmp(chatId: number) {
  const fp = currentTrackTmp.get(chatId);
  currentTrackTmp.delete(chatId);
  if (fp && fp.includes("/tgreply_") && existsSync(fp)) {
    await unlink(fp).catch(() => {});
  }
}

function playbackKeyboard(chatId: number, paused: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(paused ? "▶️ استئناف" : "⏸ إيقاف مؤقت", `vc:${paused ? "resume" : "pause"}:${chatId}`)
    .text("⏭ التالي", `vc:next:${chatId}`)
    .text("⏹ ايقاف", `vc:stop:${chatId}`);
}

async function sendPlaybackControls(chatId: number, api: Bot["api"], item: QueueItem) {
  // Delete old controls (if any)
  const old = playbackMsg.get(chatId);
  if (old) api.deleteMessage(chatId, old.messageId).catch(() => {});

  try {
    const sent = await api.sendMessage(
      chatId,
      `▶️ *${item.title}*\n👤 ${item.uploader}`,
      { parse_mode: "Markdown", reply_markup: playbackKeyboard(chatId, false) },
    );
    playbackMsg.set(chatId, { messageId: sent.message_id, paused: false });
  } catch (err) {
    logger.warn({ err }, "sendPlaybackControls failed");
  }
}

async function processVoiceQueue(chatId: number, api: Bot["api"]) {
  const queue = voiceQueue.get(chatId);
  if (!queue?.length) {
    voiceQueue.delete(chatId);
    nowPlaying.delete(chatId);
    await cleanupCurrentTrackTmp(chatId);
    const old = playbackMsg.get(chatId);
    if (old) { api.deleteMessage(chatId, old.messageId).catch(() => {}); playbackMsg.delete(chatId); }
    return;
  }
  const item = queue[0]!;
  try {
    const fp = item.localFile ?? await downloadAudio(item.videoId);
    const r = await voiceManager.joinAndPlay(chatId, fp);
    if (!r.ok) throw new Error(String(r.error ?? "فشل"));
    // New track started — bump generation so old stream_end events are ignored
    bumpGen(chatId);
    await cleanupCurrentTrackTmp(chatId);
    currentTrackTmp.set(chatId, fp);
    nowPlaying.set(chatId, item);
    await sendPlaybackControls(chatId, api, item);
    if (queue[1] && !queue[1].localFile) downloadAudio(queue[1].videoId).catch(() => {});
  } catch (err) {
    logger.error({ err }, "Voice failed");
    await api.sendMessage(chatId, `❌ فشل: ${item.title}\n${(err as Error).message?.slice(0, 200) ?? ""}`).catch(() => {});
    queue.shift();
    processVoiceQueue(chatId, api);
  }
}

// ── Admin check (for "ايقاف" permission) ──────────────────────────────────
async function isAdmin(api: Bot["api"], chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, userId);
    return member.status === "creator" || member.status === "administrator";
  } catch { return false; }
}

async function canControlPlayback(api: Bot["api"], chatId: number, userId: number): Promise<boolean> {
  const cur = nowPlaying.get(chatId);
  if (cur && cur.requesterId === userId) return true;
  return isAdmin(api, chatId, userId);
}

// ── Short callback-token store (fixes Telegram's 64-byte callback_data limit) ──
// Old code encoded title/uploader in callback_data and overflowed silently.
type CallbackPayload = { videoId: string; title: string; uploader: string; duration: string };
const callbackTokens = new Map<string, { at: number; payload: CallbackPayload }>();
const CALLBACK_TTL_MS = 30 * 60 * 1000;

function newCallbackToken(payload: CallbackPayload): string {
  // 8 hex chars = 32 bits ≈ 4 billion combos. Plenty for our scope.
  const token = randomBytes(4).toString("hex");
  callbackTokens.set(token, { at: Date.now(), payload });
  // GC
  if (callbackTokens.size > 5000) {
    const cutoff = Date.now() - CALLBACK_TTL_MS;
    for (const [k, v] of callbackTokens.entries()) {
      if (v.at < cutoff) callbackTokens.delete(k);
    }
  }
  return token;
}

// ── /start ────────────────────────────────────────────────────────────────
bot.command("start", ctx => ctx.reply(
  "أهلاً! 🎵 *بوت الموسيقى*\n\n" +
  "`يوت [أغنية]` — تحميل وإرسال\n" +
  "`بحث [أغنية]` — بحث واختيار\n" +
  "`شغل [أغنية]` — تشغيل في مكالمة صوتية\n" +
  "💡 *رد* على أي أغنية واكتب `شغل` لتشغيلها بالمكالمة\n" +
  "`قائمة` · `التالي` · `ايقاف`\n\n" +
  "🔎 `@البوت اسم_الأغنية` في أي محادثة",
  { parse_mode: "Markdown" },
));

// ── /status ───────────────────────────────────────────────────────────────
bot.command("status", async ctx => {
  const ytVer = (() => { try { return execFileSync(YT_DLP_BIN, ["--version"], { stdio: "pipe" }).toString().trim(); } catch { return "❌ غير موجود"; } })();
  const cookieStatus = COOKIE_PATH ? "✅ محمّلة" : "❌ غير موجودة — /cookies للمساعدة";
  const apiStatus = YOUTUBE_API_KEY ? "✅ مفعّل (بحث سريع)" : "❌ غير موجود — أضف GOOGLE_API_KEY";
  const proxyStatus = PROXY_URL ? `✅ ${PROXY_URL.replace(/\/\/.*@/, "//***@")}` : "❌ غير مفعّل — أضف PROXY_URL لحل مشكلة 403";
  const vs = voiceManager.isReady()
    ? await voiceManager.checkSession().then(r => r.ok ? `✅ ${String(r.name)}` : "❌ لا يوجد حساب — /qr").catch(() => "❌ خطأ")
    : "❌ لم تبدأ";
  await ctx.reply(
    `*الحالة:*\n` +
    `yt-dlp: \`${ytVer}\`\n` +
    `🔑 YouTube API: ${apiStatus}\n` +
    `🍪 كوكيز: ${cookieStatus}\n` +
    `🌐 بروكسي: ${proxyStatus}\n` +
    `💾 كاش: ${fileIdCache.size} أغنية\n` +
    `📁 مجلد: \`${DATA_DIR}\`\n` +
    `🔍 بحث محفوظ: ${searchCache.size}\n` +
    `📞 حساب صوتي: ${vs}`,
    { parse_mode: "Markdown" },
  );
});

// ── /cookies ──────────────────────────────────────────────────────────────
bot.command("cookies", ctx => ctx.reply(
  "🍪 *كيف تضيف كوكيز YouTube:*\n\n" +
  "1️⃣ افتح Chrome/Edge\n" +
  "2️⃣ ثبّت إضافة: *Get cookies.txt LOCALLY*\n" +
  "3️⃣ افتح youtube.com وتأكد أنك مسجّل دخول\n" +
  "4️⃣ اضغط الإضافة ← Export\n" +
  "5️⃣ روح Railway → Variables → أضف:\n" +
  "   `YOUTUBE_COOKIES` = (محتوى الملف)\n\n" +
  "✅ بعد الإضافة أعد تشغيل البوت من Railway",
  { parse_mode: "Markdown" },
));

// ── /qr ── owner-only ────────────────────────────────────────────────────
const OWNER_USERNAMES = new Set(
  (process.env.BOT_OWNER_USERNAMES ?? "g2n_e")
    .split(",")
    .map(s => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean),
);

function isOwner(ctx: { from?: { username?: string; id?: number } }): boolean {
  const u = ctx.from?.username?.toLowerCase();
  return !!u && OWNER_USERNAMES.has(u);
}

bot.command("qr", async ctx => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ هذا الأمر مخصص لمالك البوت فقط.");
  }
  if (!voiceManager.isReady()) return ctx.reply("⏳ خدمة المكالمات لم تبدأ.");
  const msg = await ctx.reply("🔄 جارٍ إنشاء رمز QR…");
  const r = await voiceManager.qrLogin();
  if (!r.ok || !r.url) { await safeEdit(ctx.api, ctx.chat.id, msg.message_id, `❌ ${String(r.error ?? "فشل")}`); return; }
  const qrUrl = r.url as string;
  await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
  try {
    await ctx.replyWithPhoto(
      `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`,
      { caption: "📱 *امسح بتطبيق تلغرام*\nالإعدادات ← الأجهزة ← ربط جهاز جديد\n⏳ صالح لمدة دقيقتين", parse_mode: "Markdown" },
    );
  } catch { await ctx.reply(`📱 \`${qrUrl}\``, { parse_mode: "Markdown" }); }
  if (ctx.from?.id) pendingQR.set(ctx.from.id, ctx.chat.id);
});

// ── Helper: enqueue & start voice playback ────────────────────────────────
async function enqueueVoice(
  ctx: Parameters<Parameters<typeof bot.on<"message:text">>[1]>[0],
  item: QueueItem,
) {
  const chatId = ctx.chat.id;
  const queue = voiceQueue.get(chatId) ?? [];
  queue.push(item);
  voiceQueue.set(chatId, queue);
  if (queue.length === 1) {
    await ctx.reply(`▶️ *${item.title}*\n👤 ${item.uploader}`, { parse_mode: "Markdown" });
    processVoiceQueue(chatId, ctx.api);
  } else {
    await ctx.reply(`➕ طابور (#${queue.length}): *${item.title}*`, { parse_mode: "Markdown" });
  }
}

// ── Text handler ──────────────────────────────────────────────────────────
bot.on("message:text", async ctx => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id ?? 0;

  // ── يوت / يوتيوب ── direct download & send
  if (/^(يوت|يوتيوب)\s+/u.test(text)) {
    const query = text.replace(/^(يوت|يوتيوب)\s+/u, "").trim();
    if (!query) return ctx.reply("⚠️ مثال: `يوت محمد عبده`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث: *${query}*…`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) { await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج، جرّب كلمات أخرى"); return; }
      await sendAudio(chatId, results[0]!, ctx.api, msg.message_id);
    } catch (err) {
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ ${(err as Error).message?.slice(0, 400) ?? "خطأ"}`);
    }
    return;
  }

  // ── بحث ── shows 5 results with inline buttons
  if (text.startsWith("بحث ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `بحث ماجد المهندس`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث: *${query}*…`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 5);
      if (!results.length) { await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج، جرّب كلمات أخرى"); return; }
      await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      const kb = new InlineKeyboard();
      for (const v of results) {
        // SHORT token (fixes 64-byte callback_data overflow that was killing بحث).
        const token = newCallbackToken({ videoId: v.id, title: v.title, uploader: v.uploader, duration: v.duration });
        kb.text(
          `${fileIdCache.has(v.id) ? "⚡" : "🎵"} ${v.title.slice(0, 40)} [${v.duration}]`,
          `dl:${token}`,
        ).row();
      }
      await ctx.reply(`🎵 *نتائج "${query}":*`, { parse_mode: "Markdown", reply_markup: kb });
    } catch (err) {
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ ${(err as Error).message?.slice(0, 400) ?? "خطأ"}`);
    }
    return;
  }

  // ── شغل ── play in voice call (search OR reply-to-audio)
  if (text === "شغل" || text.startsWith("شغل ")) {
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");

    // CASE 1: reply to a message with audio → play that audio directly
    const replied = ctx.message.reply_to_message;
    const repliedAudio = replied?.audio ?? replied?.voice ?? replied?.document;
    if (text === "شغل" && replied && repliedAudio) {
      const fileId = repliedAudio.file_id;
      const msg = await ctx.reply("⬇️ جارٍ تحضير الأغنية…");
      try {
        // Reverse-lookup: is this one of our cached YouTube downloads?
        const videoId = fileIdToVideo.get(fileId);
        if (videoId) {
          const meta = fileIdCache.get(videoId);
          await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
          await enqueueVoice(ctx, {
            videoId,
            title: meta?.title || "أغنية",
            uploader: meta?.uploader || "غير معروف",
            requesterId: userId,
          });
          return;
        }
        // Otherwise download arbitrary Telegram file
        const localFile = await downloadTelegramFile(fileId);
        const title = ("title" in repliedAudio && repliedAudio.title) ? String(repliedAudio.title)
          : ("file_name" in repliedAudio && repliedAudio.file_name) ? String(repliedAudio.file_name)
          : "أغنية مرفوعة";
        const uploader = ("performer" in repliedAudio && repliedAudio.performer) ? String(repliedAudio.performer) : "Telegram";
        await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
        await enqueueVoice(ctx, {
          videoId: `tg_${fileId.slice(0, 12)}`,
          title, uploader, requesterId: userId,
          localFile,
        });
      } catch (err) {
        await safeEdit(ctx.api, chatId, msg.message_id, `❌ ${(err as Error).message?.slice(0, 200)}`);
      }
      return;
    }

    // CASE 2: شغل <query> → search YouTube and play
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ اكتب `شغل اسم الأغنية` أو رد على أغنية واكتب `شغل`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث: *${query}*…`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) { await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج"); return; }
      await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      const v = results[0]!;
      await enqueueVoice(ctx, { videoId: v.id, title: v.title, uploader: v.uploader, requesterId: userId });
    } catch (err) {
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ ${(err as Error).message?.slice(0, 400) ?? "خطأ"}`);
    }
    return;
  }

  // ── ايقاف ── only requester or admins can stop
  if (text === "ايقاف" || text === "إيقاف") {
    const cur = nowPlaying.get(chatId);
    if (!cur && !(voiceQueue.get(chatId)?.length)) return ctx.reply("لا يوجد شيء قيد التشغيل.");
    if (!await canControlPlayback(ctx.api, chatId, userId)) {
      return ctx.reply("⛔ فقط من طلب الأغنية أو المشرفون يقدرون يوقفون.");
    }
    bumpGen(chatId);
    voiceQueue.delete(chatId); nowPlaying.delete(chatId);
    await cleanupCurrentTrackTmp(chatId);
    const oldMsg = playbackMsg.get(chatId);
    if (oldMsg) { ctx.api.deleteMessage(chatId, oldMsg.messageId).catch(() => {}); playbackMsg.delete(chatId); }
    if (voiceManager.isReady()) await voiceManager.stop(chatId).catch(() => {});
    await ctx.reply("⏹ تم الإيقاف.");
    return;
  }

  // ── التالي ── only requester of current track or admins
  if (text === "التالي") {
    const cur = nowPlaying.get(chatId);
    if (!cur) return ctx.reply("لا يوجد شيء قيد التشغيل.");
    if (!await canControlPlayback(ctx.api, chatId, userId)) {
      return ctx.reply("⛔ فقط من طلب الأغنية أو المشرفون يقدرون يتخطون.");
    }
    const queue = voiceQueue.get(chatId) ?? [];
    queue.shift();
    bumpGen(chatId);
    nowPlaying.delete(chatId);
    await cleanupCurrentTrackTmp(chatId);
    if (voiceManager.isReady()) await voiceManager.stop(chatId).catch(() => {});
    if (queue.length) {
      await ctx.reply(`⏭ التالي: *${queue[0]!.title}*`, { parse_mode: "Markdown" });
      processVoiceQueue(chatId, ctx.api);
    } else {
      const oldMsg2 = playbackMsg.get(chatId);
      if (oldMsg2) { ctx.api.deleteMessage(chatId, oldMsg2.messageId).catch(() => {}); playbackMsg.delete(chatId); }
      await ctx.reply("✅ انتهى الطابور.");
    }
    return;
  }

  if (text === "قائمة") {
    const queue = voiceQueue.get(chatId) ?? [];
    const cur = nowPlaying.get(chatId);
    if (!queue.length && !cur) return ctx.reply("📋 الطابور فارغ.");
    let m = "📋 *الطابور:*\n";
    if (cur) m += `▶️ *${cur.title}*\n`;
    queue.forEach((t, i) => { m += `${i + 1}. ${t.title}\n`; });
    await ctx.reply(m, { parse_mode: "Markdown" });
    return;
  }
});

// ── Inline ────────────────────────────────────────────────────────────────
bot.on("inline_query", async ctx => {
  const query = ctx.inlineQuery.query.trim();
  if (query.length < 2) return ctx.answerInlineQuery([], { cache_time: 1 });
  try {
    const results = await searchYouTube(query, 5);
    const answers = results.map(v => {
      const token = newCallbackToken({ videoId: v.id, title: v.title, uploader: v.uploader, duration: v.duration });
      return InlineQueryResultBuilder.article(`yt:${v.id}`, `${fileIdCache.has(v.id) ? "⚡ " : ""}${v.title}`, {
        description: `👤 ${v.uploader} · ⏱ ${v.duration}`,
        thumbnail_url: v.thumbnail || undefined,
        input_message_content: { message_text: `🎵 *${v.title}*\n👤 ${v.uploader} · ⏱ ${v.duration}`, parse_mode: "Markdown" },
        reply_markup: new InlineKeyboard().text(
          fileIdCache.has(v.id) ? "⚡ إرسال (كاش)" : "⬇️ تحميل",
          `dl:${token}`,
        ),
      });
    });
    await ctx.answerInlineQuery(answers, { cache_time: 60 });
  } catch { await ctx.answerInlineQuery([], { cache_time: 5 }); }
});

// ── Callback ──────────────────────────────────────────────────────────────
bot.callbackQuery(/^dl:(.+)$/, async ctx => {
  const token = ctx.match[1];
  if (!token) return ctx.answerCallbackQuery({ text: "❌ بيانات ناقصة" });
  const entry = callbackTokens.get(token);
  if (!entry) {
    return ctx.answerCallbackQuery({ text: "⌛ انتهت صلاحية الزر، ابحث مرة ثانية", show_alert: true });
  }
  const { videoId, title, uploader, duration } = entry.payload;
  await ctx.answerCallbackQuery({ text: fileIdCache.has(videoId) ? "⚡ إرسال من الكاش!" : "⬇️ جارٍ التحميل…" });
  const chatId = ctx.chat?.id ?? ctx.message?.chat?.id;
  if (!chatId) return;
  sendAudio(chatId, { id: videoId, title, uploader, duration }, ctx.api)
    .catch(err => logger.error({ err, videoId }, "sendAudio (callback) failed"));
});

// ── Voice control callbacks (pause/resume/next/stop) ─────────────────────
bot.callbackQuery(/^vc:(pause|resume|next|stop):(-?\d+)$/, async ctx => {
  const action = ctx.match[1] as "pause" | "resume" | "next" | "stop";
  const chatId = Number(ctx.match[2]);
  const userId = ctx.from?.id;
  if (!userId || !chatId) return ctx.answerCallbackQuery();

  if (!await canControlPlayback(ctx.api, chatId, userId)) {
    return ctx.answerCallbackQuery({ text: "⛔ فقط من طلب الأغنية أو المشرفون", show_alert: true });
  }

  const cur = nowPlaying.get(chatId);
  if (!cur && action !== "stop") return ctx.answerCallbackQuery({ text: "لا يوجد شيء قيد التشغيل" });

  try {
    if (action === "pause") {
      const r = await voiceManager.pause(chatId);
      if (!r.ok) throw new Error(String(r.error));
      const st = playbackMsg.get(chatId);
      if (st) {
        st.paused = true;
        await ctx.api.editMessageReplyMarkup(chatId, st.messageId, {
          reply_markup: playbackKeyboard(chatId, true),
        }).catch(() => {});
      }
      await ctx.answerCallbackQuery({ text: "⏸ تم الإيقاف المؤقت" });
    } else if (action === "resume") {
      const r = await voiceManager.resume(chatId);
      if (!r.ok) throw new Error(String(r.error));
      const st = playbackMsg.get(chatId);
      if (st) {
        st.paused = false;
        await ctx.api.editMessageReplyMarkup(chatId, st.messageId, {
          reply_markup: playbackKeyboard(chatId, false),
        }).catch(() => {});
      }
      await ctx.answerCallbackQuery({ text: "▶️ استئناف" });
    } else if (action === "next") {
      const queue = voiceQueue.get(chatId) ?? [];
      queue.shift();
      bumpGen(chatId);
      nowPlaying.delete(chatId); // marks track as "not playing" so stale stream_end is ignored
      await cleanupCurrentTrackTmp(chatId);
      if (voiceManager.isReady()) await voiceManager.stop(chatId).catch(() => {});
      await ctx.answerCallbackQuery({ text: "⏭ التالي" });
      if (queue.length) processVoiceQueue(chatId, ctx.api);
      else {
        const old = playbackMsg.get(chatId);
        if (old) { ctx.api.deleteMessage(chatId, old.messageId).catch(() => {}); playbackMsg.delete(chatId); }
        await ctx.api.sendMessage(chatId, "✅ انتهى الطابور.").catch(() => {});
      }
    } else if (action === "stop") {
      bumpGen(chatId);
      voiceQueue.delete(chatId); nowPlaying.delete(chatId);
      await cleanupCurrentTrackTmp(chatId);
      if (voiceManager.isReady()) await voiceManager.stop(chatId).catch(() => {});
      const old = playbackMsg.get(chatId);
      if (old) { ctx.api.deleteMessage(chatId, old.messageId).catch(() => {}); playbackMsg.delete(chatId); }
      await ctx.answerCallbackQuery({ text: "⏹ تم الإيقاف" });
      await ctx.api.sendMessage(chatId, "⏹ تم الإيقاف.").catch(() => {});
    }
  } catch (err) {
    logger.error({ err, action, chatId }, "vc callback failed");
    await ctx.answerCallbackQuery({ text: `❌ ${(err as Error).message?.slice(0, 100) ?? "خطأ"}`, show_alert: true });
  }
});

// ── yt-dlp auto-update ───────────────────────────────────────────────────
async function autoUpdateYtDlp() {
  try {
    const { stdout, stderr } = await execFileAsync(YT_DLP_BIN, ["-U"], { timeout: 90_000, ...EXEC_OPTS });
    const out = (stdout + stderr).trim().slice(0, 300);
    logger.info({ out }, "yt-dlp self-update");
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "yt-dlp self-update failed (read-only install?)");
  }
}

// ── Startup ───────────────────────────────────────────────────────────────
async function notifyAll(text: string) {
  for (const [uid, cid] of pendingQR.entries()) {
    try { await bot.api.sendMessage(cid, text, { parse_mode: "Markdown" }); } catch { /**/ }
    pendingQR.delete(uid);
  }
}

export async function startBot() {
  try {
    const me = await bot.api.getMe();
    BOT_USERNAME = me.username ?? BOT_USERNAME;
    logger.info({ username: BOT_USERNAME }, "Bot username");
  } catch { /* use default */ }
  await loadCache();
  autoUpdateYtDlp().catch(() => {});
  setInterval(() => autoUpdateYtDlp().catch(() => {}), 24 * 60 * 60 * 1000);
  voiceManager.start();
  voiceManager.once("ready", async () => {
    logger.info("VoiceService ready");
    try {
      const s = await voiceManager.checkSession();
      logger.info(s.ok ? { name: s.name } : {}, s.ok ? "Session active" : "No session — use /qr");
    } catch (err) {
      logger.warn({ err }, "checkSession failed");
    }
  });
  voiceManager.on("message", async (msg: Record<string, unknown>) => {
    if (msg["event"] === "qr_logged_in") {
      let txt = `✅ تم تسجيل الدخول!\n👤 ${String(msg["name"])} (${String(msg["phone"])})`;
      if (msg["persisted"]) {
        txt += `\n\n💾 تم حفظ الجلسة تلقائياً على القرص الدائم.\nلن تحتاج تسجيل دخول مرة ثانية حتى بعد إعادة النشر.`;
      } else if (msg["session_string"]) {
        txt += `\n\n⚠️ لم يُحفظ تلقائياً. ضع هذا في \`TELEGRAM_SESSION_STRING\`:\n\`${String(msg["session_string"])}\``;
      }
      await notifyAll(txt);
    } else if (msg["event"] === "stream_end") {
      const chatId = Number(msg["chat_id"]);
      if (!chatId) return;
      // Ignore stream_end if nothing is currently playing — it's likely
      // a stale event from a track that was just manually skipped/stopped.
      if (!nowPlaying.has(chatId)) return;
      const queue = voiceQueue.get(chatId) ?? [];
      queue.shift();
      await cleanupCurrentTrackTmp(chatId);
      if (queue.length) {
        processVoiceQueue(chatId, bot.api);
      } else {
        voiceQueue.delete(chatId);
        nowPlaying.delete(chatId);
        const old = playbackMsg.get(chatId);
        if (old) { bot.api.deleteMessage(chatId, old.messageId).catch(() => {}); playbackMsg.delete(chatId); }
        if (voiceManager.isReady()) voiceManager.stop(chatId).catch(() => {});
        bot.api.sendMessage(chatId, "✅ انتهى الطابور.").catch(() => {});
      }
    } else if (msg["event"] === "qr_timeout") {
      await notifyAll("⏰ انتهت صلاحية QR. استخدم /qr مجدداً.");
    } else if (msg["event"] === "qr_error") {
      await notifyAll(`❌ خطأ QR: ${String(msg["error"])}`);
    }
  });

  bot.catch(err => logger.error({ err }, "grammy handler error"));
  bot.start({ onStart: () => logger.info("Bot polling started") })
    .catch(err => logger.error({ err }, "Bot crashed"));
  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
}
