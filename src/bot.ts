import { Bot, InlineKeyboard, InputFile, InlineQueryResultBuilder } from "grammy";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { unlink, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
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

// ── yt-dlp binary detection ───────────────────────────────────────────────
function findYtDlp(): string {
  const candidates = [
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
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

// ── Voice queue ───────────────────────────────────────────────────────────
type QueueItem = { videoId: string; title: string; uploader: string };
const voiceQueue = new Map<number, QueueItem[]>();
const nowPlaying = new Map<number, string>();
const pendingQR = new Map<number, number>();

// ── Utilities ─────────────────────────────────────────────────────────────
function fmtDuration(sec: number): string {
  if (!sec || isNaN(sec)) return "?:??";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function safeEdit(api: Bot["api"], chatId: number, msgId: number, text: string) {
  try { await api.editMessageText(chatId, msgId, text, { parse_mode: "Markdown" }); }
  catch { try { await api.sendMessage(chatId, text, { parse_mode: "Markdown" }); } catch { /* ignore */ } }
}

// ── SEARCH — uses --flat-playlist (NO format resolution, NO signature needed) ──
type VideoResult = { id: string; title: string; duration: string; uploader: string; thumbnail: string };

async function searchYouTube(query: string, limit = 5): Promise<VideoResult[]> {
  // -J with --flat-playlist gives a single JSON with entries[]
  // No format resolution = no PO token, no signature issues
  const args = [
    `ytsearch${limit}:${query}`,
    "-J",
    "--flat-playlist",
    "--no-check-certificates",
    "--socket-timeout", "20",
    "--no-warnings",
  ];

  let stdout = "";
  try {
    const r = await execFileAsync(YT_DLP_BIN, args, { timeout: 45_000 });
    stdout = r.stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stdout) stdout = e.stdout;
    else throw new Error((e.stderr ?? "yt-dlp search failed").slice(0, 400));
  }

  try {
    const playlist = JSON.parse(stdout) as {
      entries?: Array<{
        id?: string; title?: string; duration?: number;
        uploader?: string; channel?: string; thumbnails?: Array<{ url: string }>;
        thumbnail?: string; url?: string;
      }>;
    };
    return (playlist.entries ?? [])
      .filter(e => e.id || e.url)
      .map(e => ({
        id: e.id ?? (e.url ?? "").replace("https://www.youtube.com/watch?v=", ""),
        title: e.title ?? "Unknown",
        duration: fmtDuration(e.duration ?? 0),
        uploader: e.uploader ?? e.channel ?? "Unknown",
        thumbnail: e.thumbnail ?? e.thumbnails?.[0]?.url ?? "",
      }))
      .filter(v => v.id);
  } catch {
    throw new Error("فشل في قراءة نتائج البحث");
  }
}

// ── DOWNLOAD — no extractor-args, bestaudio, convert with ffmpeg ──────────
async function downloadAudio(videoId: string): Promise<string> {
  const mp3Path = join(tmpdir(), `tgbot_${videoId}.mp3`);
  if (existsSync(mp3Path)) return mp3Path;

  const rawOut = join(tmpdir(), `tgbot_${videoId}.%(ext)s`);

  // Step 1: download best audio (no extractor-args = yt-dlp picks best client)
  const dlArgs = [
    `https://www.youtube.com/watch?v=${videoId}`,
    "--format", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
    "-o", rawOut,
    "--no-playlist",
    "--socket-timeout", "30",
    "--no-check-certificates",
    "--no-warnings",
    "--quiet",
  ];

  // Try with cookies env var if set
  if (process.env["YOUTUBE_COOKIES_B64"]) {
    const cookiePath = join(tmpdir(), "yt_cookies.txt");
    if (!existsSync(cookiePath)) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(cookiePath, Buffer.from(process.env["YOUTUBE_COOKIES_B64"], "base64").toString());
    }
    dlArgs.push("--cookies", cookiePath);
  }

  let downloadedPath: string | undefined;
  try {
    const r = await execFileAsync(YT_DLP_BIN, dlArgs, { timeout: 180_000 });
    // Find downloaded file
    const exts = ["m4a", "webm", "opus", "ogg", "mp3", "mp4"];
    for (const ext of exts) {
      const p = join(tmpdir(), `tgbot_${videoId}.${ext}`);
      if (existsSync(p)) { downloadedPath = p; break; }
    }
    if (!downloadedPath && r.stdout) {
      // Parse from stdout
      const match = r.stdout.match(/\[download\] Destination: (.+)/);
      if (match?.[1] && existsSync(match[1])) downloadedPath = match[1];
    }
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    // Check if file was created despite error
    const exts = ["m4a", "webm", "opus", "ogg", "mp3", "mp4"];
    for (const ext of exts) {
      const p = join(tmpdir(), `tgbot_${videoId}.${ext}`);
      if (existsSync(p)) { downloadedPath = p; break; }
    }
    if (!downloadedPath) throw new Error((e.stderr ?? e.message ?? "فشل التحميل").slice(0, 400));
  }

  if (!downloadedPath) throw new Error("ملف الصوت لم يُنشأ");
  if (downloadedPath === mp3Path) return mp3Path;

  // Step 2: convert to mp3 with ffmpeg
  await new Promise<void>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", downloadedPath!,
      "-vn", "-acodec", "libmp3lame", "-q:a", "2",
      "-y", mp3Path,
    ], { stdio: "pipe" });
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    ff.on("error", reject);
  });

  // Remove raw file
  await unlink(downloadedPath).catch(() => {});
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

  const dlMsgId = statusMsgId ?? (
    await api.sendMessage(chatId, `⬇️ جارٍ التحميل…\n*${video.title}*`, { parse_mode: "Markdown" })
  ).message_id;

  if (statusMsgId) await safeEdit(api, chatId, statusMsgId, `⬇️ جارٍ التحميل…\n*${video.title}*`);

  let filePath: string | undefined;
  try {
    filePath = await downloadAudio(video.id);
    const sent = await api.sendAudio(
      chatId,
      new InputFile(createReadStream(filePath), `${video.title.slice(0, 50)}.mp3`),
      {
        title: video.title.slice(0, 64),
        performer: video.uploader.slice(0, 64),
        caption: `🎵 *${video.title}*\n👤 ${video.uploader} · ⏱ ${video.duration}`,
        parse_mode: "Markdown",
      },
    );
    if (sent.audio?.file_id) { fileIdCache.set(video.id, sent.audio.file_id); await saveCache(); }
    await api.deleteMessage(chatId, dlMsgId).catch(() => {});
  } catch (err) {
    logger.error({ err, videoId: video.id }, "sendAudio failed");
    const msg = (err as Error).message?.replace(/WARNING:.*\n?/g, "").trim().slice(0, 300) ?? "خطأ";
    await safeEdit(api, chatId, dlMsgId, `❌ فشل التحميل:\n\`${msg}\``);
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
  }
}

// ── Voice queue ───────────────────────────────────────────────────────────
async function processVoiceQueue(chatId: number, api: Bot["api"]) {
  const queue = voiceQueue.get(chatId);
  if (!queue?.length) { voiceQueue.delete(chatId); nowPlaying.delete(chatId); return; }
  const item = queue[0]!;
  try {
    const filePath = await downloadAudio(item.videoId);
    const result = await voiceManager.joinAndPlay(chatId, filePath);
    if (!result.ok) throw new Error((result.error as string) ?? "فشل التشغيل");
    nowPlaying.set(chatId, item.title);
    if (queue[1]) downloadAudio(queue[1].videoId).catch(() => {});
  } catch (err) {
    logger.error({ err }, "Voice play failed");
    await api.sendMessage(chatId, `❌ فشل تشغيل: ${item.title}`, { parse_mode: "Markdown" });
    queue.shift();
    processVoiceQueue(chatId, api);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────
bot.command("start", (ctx) =>
  ctx.reply(
    "أهلاً! 🎵 *بوت الموسيقى*\n\n" +
    "`يوت [أغنية]` — تحميل وإرسال\n" +
    "`بحث [أغنية]` — بحث واختيار من القائمة\n" +
    "`شغل [أغنية]` — تشغيل في مكالمة صوتية\n" +
    "`قائمة` / `التالي` / `وقف` — إدارة الطابور\n\n" +
    "💡 أو اكتب `@البوت اسم_الأغنية` في أي محادثة",
    { parse_mode: "Markdown" },
  )
);

bot.command("status", async (ctx) => {
  const ytVer = (() => { try { return execFileSync(YT_DLP_BIN, ["--version"], { stdio: "pipe" }).toString().trim(); } catch { return "غير موجود ❌"; } })();
  const voiceStatus = voiceManager.isReady()
    ? await voiceManager.checkSession().then(r => r.ok ? `✅ ${String(r.name)} (${String(r.phone)})` : "❌ لا يوجد حساب — /qr")
    : "❌ الخدمة لم تبدأ";
  await ctx.reply(`*الحالة:*\nyt-dlp: \`${ytVer}\`\n💾 كاش: ${fileIdCache.size} أغنية\n📞 حساب: ${voiceStatus}`, { parse_mode: "Markdown" });
});

bot.command("qr", async (ctx) => {
  if (!voiceManager.isReady()) return ctx.reply("⏳ خدمة المكالمات لم تبدأ بعد.");
  const msg = await ctx.reply("🔄 جارٍ إنشاء رمز QR…");
  const result = await voiceManager.qrLogin();
  if (!result.ok || !result.url) { await safeEdit(ctx.api, ctx.chat.id, msg.message_id, `❌ ${String(result.error ?? "فشل")}`); return; }
  const qrUrl = result.url as string;
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
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (/^(يوت|يوتيوب)\s+/u.test(text)) {
    const query = text.replace(/^(يوت|يوتيوب)\s+/u, "").trim();
    if (!query) return ctx.reply("⚠️ مثال: `يوت محمد عبده`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث: *${query}*…`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) { await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج — جرّب كلمات مختلفة"); return; }
      await sendAudio(chatId, results[0]!, ctx.api, msg.message_id);
    } catch (err) {
      logger.error({ err }, "يوت error");
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ خطأ:\n\`${(err as Error).message?.slice(0, 300)}\``);
    }
    return;
  }

  if (text.startsWith("بحث ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `بحث ماجد المهندس`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث: *${query}*…`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 5);
      if (!results.length) { await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج — جرّب كلمات مختلفة"); return; }
      await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      const kb = new InlineKeyboard();
      for (const v of results) {
        const prefix = fileIdCache.has(v.id) ? "⚡" : "🎵";
        kb.text(`${prefix} ${v.title.slice(0, 35)} [${v.duration}]`,
          `dl:${v.id}:${Buffer.from(v.uploader).toString("base64url").slice(0, 20)}:${Buffer.from(v.title).toString("base64url").slice(0, 40)}:${v.duration}`
        ).row();
      }
      await ctx.reply(`🎵 *نتائج "${query}":*`, { parse_mode: "Markdown", reply_markup: kb });
    } catch (err) {
      logger.error({ err }, "بحث error");
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ خطأ:\n\`${(err as Error).message?.slice(0, 300)}\``);
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
      if (!results.length) { await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج."); return; }
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
      logger.error({ err }, "شغل error");
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ خطأ:\n\`${(err as Error).message?.slice(0, 300)}\``);
    }
    return;
  }

  if (text === "وقف") {
    voiceQueue.delete(chatId); nowPlaying.delete(chatId);
    if (!voiceManager.isReady()) return ctx.reply("⏹ تم تفريغ الطابور.");
    const r = await voiceManager.stop(chatId);
    await ctx.reply(r.ok ? "⏹ تم الإيقاف وتفريغ الطابور." : `❌ ${String(r.error)}`);
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
    const current = nowPlaying.get(chatId);
    if (!queue.length && !current) return ctx.reply("📋 الطابور فارغ.");
    let m = "📋 *الطابور:*\n";
    if (current) m += `▶️ *${current}*\n`;
    queue.forEach((t, i) => { m += `${i + 1}. ${t.title}\n`; });
    await ctx.reply(m, { parse_mode: "Markdown" });
    return;
  }
});

// ── Inline mode ───────────────────────────────────────────────────────────
bot.on("inline_query", async (ctx) => {
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
  } catch (err) {
    logger.error({ err }, "inline_query error");
    await ctx.answerInlineQuery([], { cache_time: 5 });
  }
});

// ── Callback ──────────────────────────────────────────────────────────────
bot.callbackQuery(/^dl:([^:]+):([^:]+):([^:]+):(.*)$/, async (ctx) => {
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
export async function startBot() {
  await loadCache();
  voiceManager.start();
  voiceManager.once("ready", async () => {
    logger.info("VoiceService ready");
    const s = await voiceManager.checkSession();
    logger.info(s.ok ? { name: s.name } : {}, s.ok ? "User session active" : "No user session — use /qr");
  });
  voiceManager.on("message", async (msg: Record<string, unknown>) => {
    const notifyAll = async (text: string) => {
      for (const [uid, cid] of pendingQR.entries()) {
        try { await bot.api.sendMessage(cid, text, { parse_mode: "Markdown" }); } catch { /* ignore */ }
        pendingQR.delete(uid);
      }
    };
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
