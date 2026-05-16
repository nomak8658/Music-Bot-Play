import { Bot, InlineKeyboard, InputFile, InlineQueryResultBuilder } from "grammy";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { unlink, readFile, writeFile } from "node:fs/promises";
import { existsSync, createReadStream, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger";
import { voiceManager } from "./voice_manager";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const bot = new Bot(BOT_TOKEN);

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

// ── File-ID cache ─────────────────────────────────────────────────────────
const CACHE_FILE = join(__dirname, "..", "cache.json");
const fileIdCache = new Map<string, string>();

async function loadCache() {
  try {
    const obj = JSON.parse(await readFile(CACHE_FILE, "utf-8")) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) fileIdCache.set(k, v);
    logger.info({ count: fileIdCache.size }, "Cache loaded");
  } catch { /* first run */ }
}
async function saveCache() {
  try { await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(fileIdCache))); }
  catch (err) { logger.warn({ err }, "Cache save failed"); }
}

// ── Types & queue ─────────────────────────────────────────────────────────
type VideoResult = { id: string; title: string; duration: string; uploader: string; thumbnail: string };
type QueueItem = { videoId: string; title: string; uploader: string };

const voiceQueue = new Map<number, QueueItem[]>();
const nowPlaying = new Map<number, string>();
const pendingQR = new Map<number, number>();

function fmtDuration(sec: number): string {
  if (!sec || isNaN(sec)) return "?:??";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function safeEdit(api: Bot["api"], chatId: number, msgId: number, text: string) {
  try { await api.editMessageText(chatId, msgId, text, { parse_mode: "Markdown" }); }
  catch { try { await api.sendMessage(chatId, text, { parse_mode: "Markdown" }); } catch { /**/ } }
}

// ── Cookie args helper ────────────────────────────────────────────────────
function cookieArgs(): string[] {
  return COOKIE_PATH ? ["--cookies", COOKIE_PATH] : [];
}

// ── Search (flat-playlist — no format resolution needed) ──────────────────
async function searchYouTube(query: string, limit = 5): Promise<VideoResult[]> {
  const args = [
    `ytsearch${limit}:${query}`,
    "-J", "--flat-playlist",
    "--no-check-certificates",
    "--socket-timeout", "20",
    "--no-warnings",
    ...cookieArgs(),
  ];
  let stdout = "";
  try {
    const r = await execFileAsync(YT_DLP_BIN, args, { timeout: 45_000 });
    stdout = r.stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stdout) stdout = e.stdout;
    else throw new Error(((e.stderr ?? "") + "").slice(0, 400) || "البحث فشل");
  }
  const playlist = JSON.parse(stdout) as {
    entries?: Array<{ id?: string; title?: string; duration?: number; uploader?: string; channel?: string; thumbnail?: string; thumbnails?: Array<{ url: string }>; }>;
  };
  return (playlist.entries ?? []).filter(e => e.id).map(e => ({
    id: e.id!,
    title: e.title ?? "Unknown",
    duration: fmtDuration(e.duration ?? 0),
    uploader: e.uploader ?? e.channel ?? "Unknown",
    thumbnail: e.thumbnail ?? e.thumbnails?.[0]?.url ?? "",
  }));
}

// ── Download audio ────────────────────────────────────────────────────────
async function downloadAudio(videoId: string): Promise<string> {
  const mp3Path = join(tmpdir(), `tgbot_${videoId}.mp3`);
  if (existsSync(mp3Path)) return mp3Path;

  const outTpl = join(tmpdir(), `tgbot_${videoId}.%(ext)s`);
  const exts   = ["mp3", "m4a", "webm", "opus", "ogg", "mp4", "mkv"];

  const common = [
    "--no-playlist", "--socket-timeout", "30",
    "--no-check-certificates", "--no-warnings",
    ...cookieArgs(),
  ];

  // Try multiple URL strategies — YouTube Music is less restricted than YouTube
  const attempts = [
    // 1. YouTube Music URL (different CDN, less bot-blocking)
    [`https://music.youtube.com/watch?v=${videoId}`, ["-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", outTpl, ...common]],
    // 2. YouTube with no format filter (let yt-dlp pick anything)
    [`https://www.youtube.com/watch?v=${videoId}`,   ["-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", outTpl, ...common]],
    // 3. YouTube with explicit bestaudio (no ext filter)
    [`https://www.youtube.com/watch?v=${videoId}`,   ["--format", "bestaudio/best", "-o", outTpl, ...common]],
  ] as [string, string[]][];

  let rawPath: string | undefined;
  let lastErr = "";

  for (const [ytUrl, args] of attempts) {
    // Clean up any partial files before retry
    for (const ext of exts) {
      const p = join(tmpdir(), `tgbot_${videoId}.${ext}`);
      if (existsSync(p)) { try { (await import("node:fs")).unlinkSync(p); } catch {/**/ } }
    }

    try {
      await execFileAsync(YT_DLP_BIN, [ytUrl, ...args], { timeout: 180_000 });
    } catch (err: unknown) {
      lastErr = ((err as { stderr?: string }).stderr ?? (err as Error).message ?? "").slice(0, 600);
    }
    for (const ext of exts) {
      const p = join(tmpdir(), `tgbot_${videoId}.${ext}`);
      if (existsSync(p)) {
        const { statSync } = await import("node:fs");
        if (statSync(p).size > 1000) { rawPath = p; break; }
      }
    }
    if (rawPath) { logger.info({ videoId, url: ytUrl }, "Download succeeded"); break; }
    logger.warn({ videoId, url: ytUrl, err: lastErr.slice(0, 120) }, "attempt failed");
  }

  if (!rawPath) {
    if (lastErr.includes("Sign in") || lastErr.includes("bot")) {
      throw new Error("YouTube يطلب تسجيل دخول — تأكد من YOUTUBE_COOKIES في Railway");
    }
    throw new Error("فشل التحميل من YouTube — " + lastErr.slice(0, 200));
  }

  if (rawPath === mp3Path) return mp3Path;

  // Convert to mp3 with ffmpeg
  await new Promise<void>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", rawPath!, "-vn", "-acodec", "libmp3lame", "-q:a", "2", "-y", mp3Path,
    ], { stdio: "pipe" });
    let ffErr = "";
    ff.stderr?.on("data", (d: Buffer) => { ffErr += d.toString(); });
    ff.on("close", code => {
      if (code === 0 && existsSync(mp3Path)) resolve();
      else reject(new Error(`ffmpeg (${code}): ${ffErr.slice(-200)}`));
    });
    ff.on("error", reject);
    setTimeout(() => { ff.kill(); reject(new Error("ffmpeg timeout")); }, 120_000);
  });

  await unlink(rawPath).catch(() => {});
  return mp3Path;
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
    if (statusMsgId) await api.deleteMessage(chatId, statusMsgId).catch(() => {});
    await api.sendAudio(chatId, cached, {
      caption: `🎵 *${video.title}*\n👤 ${video.uploader} · ⏱ ${video.duration}\n⚡ من الكاش`,
      parse_mode: "Markdown",
    });
    return;
  }

  let dlMsgId = statusMsgId;
  if (!dlMsgId) {
    dlMsgId = (await api.sendMessage(chatId, `⬇️ جارٍ التحميل…\n*${video.title}*`, { parse_mode: "Markdown" })).message_id;
  } else {
    await safeEdit(api, chatId, dlMsgId, `⬇️ جارٍ التحميل…\n*${video.title}*`);
  }

  let filePath: string | undefined;
  try {
    filePath = await downloadAudio(video.id);
    const sent = await api.sendAudio(
      chatId,
      new InputFile(createReadStream(filePath), `${video.title.slice(0, 50)}.mp3`),
      { title: video.title.slice(0, 64), performer: video.uploader.slice(0, 64),
        caption: `🎵 *${video.title}*\n👤 ${video.uploader} · ⏱ ${video.duration}`, parse_mode: "Markdown" },
    );
    if (sent.audio?.file_id) { fileIdCache.set(video.id, sent.audio.file_id); await saveCache(); }
    await api.deleteMessage(chatId, dlMsgId!).catch(() => {});
  } catch (err) {
    logger.error({ err, videoId: video.id }, "sendAudio failed");
    await safeEdit(api, chatId, dlMsgId!, `❌ ${(err as Error).message?.slice(0, 400) ?? "خطأ غير معروف"}`);
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
  }
}

// ── Voice queue ───────────────────────────────────────────────────────────
async function processVoiceQueue(chatId: number, api: Bot["api"]) {
  const queue = voiceQueue.get(chatId);
  if (!queue?.length) { voiceQueue.delete(chatId); nowPlaying.delete(chatId); return; }
  const item = queue[0]!;
  try {
    const fp = await downloadAudio(item.videoId);
    const r = await voiceManager.joinAndPlay(chatId, fp);
    if (!r.ok) throw new Error(String(r.error ?? "فشل"));
    nowPlaying.set(chatId, item.title);
    if (queue[1]) downloadAudio(queue[1].videoId).catch(() => {});
  } catch (err) {
    logger.error({ err }, "Voice failed");
    await api.sendMessage(chatId, `❌ فشل: ${item.title}\n${(err as Error).message?.slice(0, 200) ?? ""}`);
    queue.shift(); processVoiceQueue(chatId, api);
  }
}

// ── /start ────────────────────────────────────────────────────────────────
bot.command("start", ctx => ctx.reply(
  "أهلاً! 🎵 *بوت الموسيقى*\n\n" +
  "`يوت [أغنية]` — تحميل وإرسال\n" +
  "`بحث [أغنية]` — بحث واختيار\n" +
  "`شغل [أغنية]` — تشغيل في مكالمة صوتية\n" +
  "`قائمة` · `التالي` · `وقف`\n\n" +
  "💡 `@البوت اسم_الأغنية` في أي محادثة",
  { parse_mode: "Markdown" },
));

// ── /status ───────────────────────────────────────────────────────────────
bot.command("status", async ctx => {
  const ytVer = (() => { try { return execFileSync(YT_DLP_BIN, ["--version"], { stdio: "pipe" }).toString().trim(); } catch { return "❌ غير موجود"; } })();
  const cookieStatus = COOKIE_PATH ? "✅ محمّلة" : "❌ غير موجودة (أضف YOUTUBE_COOKIES)";
  const vs = voiceManager.isReady()
    ? await voiceManager.checkSession().then(r => r.ok ? `✅ ${String(r.name)}` : "❌ لا يوجد حساب — /qr")
    : "❌ لم تبدأ";
  await ctx.reply(
    `*الحالة:*\nyt-dlp: \`${ytVer}\`\n🍪 كوكيز: ${cookieStatus}\n💾 كاش: ${fileIdCache.size} أغنية\n📞 حساب: ${vs}`,
    { parse_mode: "Markdown" },
  );
});

// ── /cookies — instructions ───────────────────────────────────────────────
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

// ── /qr ───────────────────────────────────────────────────────────────────
bot.command("qr", async ctx => {
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

// ── Text handler ──────────────────────────────────────────────────────────
bot.on("message:text", async ctx => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;

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
        kb.text(
          `${fileIdCache.has(v.id) ? "⚡" : "🎵"} ${v.title.slice(0, 35)} [${v.duration}]`,
          `dl:${v.id}:${Buffer.from(v.uploader).toString("base64url").slice(0, 20)}:${Buffer.from(v.title).toString("base64url").slice(0, 40)}:${v.duration}`,
        ).row();
      }
      await ctx.reply(`🎵 *نتائج "${query}":*`, { parse_mode: "Markdown", reply_markup: kb });
    } catch (err) {
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ ${(err as Error).message?.slice(0, 400) ?? "خطأ"}`);
    }
    return;
  }

  if (text.startsWith("شغل ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `شغل محمد عبده`", { parse_mode: "Markdown" });
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");
    const msg = await ctx.reply(`🔍 أبحث: *${query}*…`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) { await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج"); return; }
      await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      const v = results[0]!;
      const queue = voiceQueue.get(chatId) ?? [];
      queue.push({ videoId: v.id, title: v.title, uploader: v.uploader });
      voiceQueue.set(chatId, queue);
      if (queue.length === 1) {
        await ctx.reply(`▶️ *${v.title}*\n👤 ${v.uploader}`, { parse_mode: "Markdown" });
        processVoiceQueue(chatId, ctx.api);
      } else {
        await ctx.reply(`➕ طابور (#${queue.length}): *${v.title}*`, { parse_mode: "Markdown" });
      }
    } catch (err) {
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ ${(err as Error).message?.slice(0, 400) ?? "خطأ"}`);
    }
    return;
  }

  if (text === "وقف") {
    voiceQueue.delete(chatId); nowPlaying.delete(chatId);
    if (voiceManager.isReady()) await voiceManager.stop(chatId);
    await ctx.reply("⏹ تم الإيقاف.");
    return;
  }
  if (text === "التالي") {
    const queue = voiceQueue.get(chatId) ?? [];
    queue.shift();
    if (voiceManager.isReady()) await voiceManager.stop(chatId);
    if (queue.length) {
      await ctx.reply(`⏭ التالي: *${queue[0]!.title}*`, { parse_mode: "Markdown" });
      processVoiceQueue(chatId, ctx.api);
    } else { nowPlaying.delete(chatId); await ctx.reply("✅ انتهى الطابور."); }
    return;
  }
  if (text === "قائمة") {
    const queue = voiceQueue.get(chatId) ?? [];
    const cur = nowPlaying.get(chatId);
    if (!queue.length && !cur) return ctx.reply("📋 الطابور فارغ.");
    let m = "📋 *الطابور:*\n";
    if (cur) m += `▶️ *${cur}*\n`;
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
    const answers = results.map(v =>
      InlineQueryResultBuilder.article(`yt:${v.id}`, `${fileIdCache.has(v.id) ? "⚡ " : ""}${v.title}`, {
        description: `👤 ${v.uploader} · ⏱ ${v.duration}`,
        thumbnail_url: v.thumbnail || undefined,
        input_message_content: { message_text: `🎵 *${v.title}*\n👤 ${v.uploader} · ⏱ ${v.duration}`, parse_mode: "Markdown" },
        reply_markup: new InlineKeyboard().text(
          fileIdCache.has(v.id) ? "⚡ إرسال (كاش)" : "⬇️ تحميل",
          `dl:${v.id}:${Buffer.from(v.uploader).toString("base64url").slice(0, 20)}:${Buffer.from(v.title).toString("base64url").slice(0, 40)}:${v.duration}`,
        ),
      })
    );
    await ctx.answerInlineQuery(answers, { cache_time: 60 });
  } catch { await ctx.answerInlineQuery([], { cache_time: 5 }); }
});

// ── Callback ──────────────────────────────────────────────────────────────
bot.callbackQuery(/^dl:([^:]+):([^:]+):([^:]+):(.*)$/, async ctx => {
  const [, videoId, uploaderB64, titleB64, duration] = ctx.match;
  if (!videoId || !titleB64 || !uploaderB64) return ctx.answerCallbackQuery({ text: "❌ بيانات ناقصة" });
  const title = Buffer.from(titleB64, "base64url").toString();
  const uploader = Buffer.from(uploaderB64, "base64url").toString();
  await ctx.answerCallbackQuery({ text: fileIdCache.has(videoId) ? "⚡ إرسال من الكاش!" : "⬇️ جارٍ التحميل…" });
  const chatId = ctx.chat?.id ?? ctx.message?.chat?.id;
  if (!chatId) return;
  await sendAudio(chatId, { id: videoId, title, uploader, duration: duration ?? "?:??" }, ctx.api);
});

// ── Startup ───────────────────────────────────────────────────────────────
async function notifyAll(text: string) {
  for (const [uid, cid] of pendingQR.entries()) {
    try { await bot.api.sendMessage(cid, text, { parse_mode: "Markdown" }); } catch { /**/ }
    pendingQR.delete(uid);
  }
}

export async function startBot() {
  await loadCache();
  voiceManager.start();
  voiceManager.once("ready", async () => {
    logger.info("VoiceService ready");
    const s = await voiceManager.checkSession();
    logger.info(s.ok ? { name: s.name } : {}, s.ok ? "Session active" : "No session — use /qr");
  });
  voiceManager.on("message", async (msg: Record<string, unknown>) => {
    if (msg["event"] === "qr_logged_in") {
      let txt = `✅ تم تسجيل الدخول!\n👤 ${String(msg["name"])} (${String(msg["phone"])})`;
      if (msg["session_string"]) txt += `\n\n💾 *Session String:*\n\`${String(msg["session_string"])}\`\n\nضعه في \`TELEGRAM_SESSION_STRING\``;
      await notifyAll(txt);
    } else if (msg["event"] === "qr_timeout") {
      await notifyAll("⏰ انتهت صلاحية QR. استخدم /qr مجدداً.");
    } else if (msg["event"] === "qr_error") {
      await notifyAll(`❌ خطأ QR: ${String(msg["error"])}`);
    }
  });
  bot.start({ onStart: () => logger.info("Bot polling started") })
    .catch(err => logger.error({ err }, "Bot crashed"));
  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
}
