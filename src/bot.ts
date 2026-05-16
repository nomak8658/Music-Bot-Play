import { Bot, InlineKeyboard, InputFile, InlineQueryResultBuilder } from "grammy";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { unlink, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

// ── Detect yt-dlp binary path ──────────────────────────────────────────────
function findYtDlp(): string {
  const candidates = [
    "yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "/root/.local/bin/yt-dlp",
    join(__dirname, "..", ".venv", "bin", "yt-dlp"),
  ];
  for (const c of candidates) {
    try { execFileSync(c, ["--version"], { stdio: "pipe" }); return c; } catch { /* try next */ }
  }
  throw new Error("yt-dlp not found. Check nixpacks build.");
}

let YT_DLP_BIN = "yt-dlp";
try { YT_DLP_BIN = findYtDlp(); logger.info({ bin: YT_DLP_BIN }, "yt-dlp found"); }
catch (err) { logger.error({ err }, "yt-dlp not found"); }

// ── Cache: videoId -> Telegram file_id ────────────────────────────────────
const CACHE_FILE = join(__dirname, "..", "cache.json");
const fileIdCache = new Map<string, string>();

async function loadCache() {
  try {
    const data = await readFile(CACHE_FILE, "utf-8");
    const obj = JSON.parse(data) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) fileIdCache.set(k, v);
    logger.info({ count: fileIdCache.size }, "Song cache loaded");
  } catch { /* no cache yet */ }
}

async function saveCache() {
  try { await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(fileIdCache))); }
  catch (err) { logger.warn({ err }, "Failed to save cache"); }
}

// ── Voice queue ────────────────────────────────────────────────────────────
const voiceQueue = new Map<number, Array<{ videoId: string; title: string; uploader: string }>>();
const nowPlaying = new Map<number, string>();
const pendingQR = new Map<number, number>();

// ── yt-dlp common flags ───────────────────────────────────────────────────
const YT_FLAGS = [
  "--extractor-args", "youtube:player_client=android,web",
  "--add-header", "User-Agent:Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36",
  "--no-check-certificates",
];

type VideoResult = { id: string; title: string; duration: string; uploader: string; thumbnail: string };

async function searchYouTube(query: string, limit = 5): Promise<VideoResult[]> {
  const { stdout } = await execFileAsync(YT_DLP_BIN, [
    `ytsearch${limit}:${query}`,
    "--print", "%(id)s|||%(title)s|||%(duration_string)s|||%(uploader)s|||%(thumbnail)s",
    "--no-download", "--no-playlist",
    "--socket-timeout", "20", "--quiet",
    ...YT_FLAGS,
  ], { timeout: 35_000 });

  return stdout.trim().split("\n")
    .filter(l => l.includes("|||"))
    .map(l => {
      const p = l.split("|||");
      return { id: p[0]!.trim(), title: p[1]!.trim(), duration: p[2]!.trim(), uploader: p[3]!.trim(), thumbnail: p[4]!.trim() };
    });
}

async function downloadAudio(videoId: string): Promise<string> {
  const outPath = join(tmpdir(), `tg_${videoId}.mp3`);
  if (existsSync(outPath)) return outPath;
  await execFileAsync(YT_DLP_BIN, [
    `https://www.youtube.com/watch?v=${videoId}`,
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "-o", outPath.replace(".mp3", ".%(ext)s"),
    "--no-playlist", "--socket-timeout", "30", "--quiet",
    ...YT_FLAGS,
  ], { timeout: 120_000 });
  return outPath;
}

async function sendCachedAudio(
  chatId: number,
  video: Pick<VideoResult, "id" | "title" | "uploader" | "duration">,
  api: Bot["api"],
  statusMsgId?: number,
): Promise<void> {
  const cachedId = fileIdCache.get(video.id);
  if (cachedId) {
    if (statusMsgId) await api.deleteMessage(chatId, statusMsgId).catch(() => {});
    await api.sendAudio(chatId, cachedId, {
      caption: `🎵 *${video.title}*\n👤 ${video.uploader} • ⏱ ${video.duration}\n⚡ من الكاش`,
      parse_mode: "Markdown",
    });
    return;
  }

  const dlMsg = statusMsgId
    ? await api.editMessageText(chatId, statusMsgId, `⬇️ جارٍ التحميل: *${video.title}*`, { parse_mode: "Markdown" }).catch(() => null)
    : await api.sendMessage(chatId, `⬇️ جارٍ التحميل: *${video.title}*`, { parse_mode: "Markdown" });
  const dlMsgId = dlMsg && "message_id" in dlMsg ? dlMsg.message_id : statusMsgId;

  let filePath: string | null = null;
  try {
    filePath = await downloadAudio(video.id);
    const { createReadStream } = await import("node:fs");
    const sent = await api.sendAudio(chatId, new InputFile(createReadStream(filePath), `${video.title.slice(0, 50)}.mp3`), {
      title: video.title.slice(0, 64),
      performer: video.uploader.slice(0, 64),
      caption: `🎵 *${video.title}*\n👤 ${video.uploader} • ⏱ ${video.duration}`,
      parse_mode: "Markdown",
    });
    if (sent.audio?.file_id) { fileIdCache.set(video.id, sent.audio.file_id); await saveCache(); }
    if (dlMsgId) await api.deleteMessage(chatId, dlMsgId).catch(() => {});
  } catch (err) {
    logger.error({ err, videoId: video.id }, "Download failed");
    if (dlMsgId) await api.editMessageText(chatId, dlMsgId, `❌ فشل التحميل:\n\`${(err as Error).message?.slice(0, 300)}\``, { parse_mode: "Markdown" }).catch(() => {});
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
  }
}

async function processVoiceQueue(chatId: number, api: Bot["api"]) {
  const queue = voiceQueue.get(chatId);
  if (!queue?.length) { voiceQueue.delete(chatId); return; }
  const next = queue[0]!;
  let filePath: string | null = null;
  try {
    filePath = await downloadAudio(next.videoId);
    const result = await voiceManager.joinAndPlay(chatId, filePath);
    if (result.ok) {
      nowPlaying.set(chatId, next.title);
      const nextTrack = queue[1];
      if (nextTrack) downloadAudio(nextTrack.videoId).catch(() => {});
    } else throw new Error((result.error as string) ?? "Unknown");
  } catch (err) {
    logger.error({ err }, "Voice play failed");
    await api.sendMessage(chatId, `❌ فشل تشغيل: ${next.title}`);
    queue.shift();
    processVoiceQueue(chatId, api);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────
bot.command("start", (ctx) =>
  ctx.reply(
    "أهلاً! 🎵 بوت الموسيقى\n\n" +
    "*أوامر التحميل:*\n" +
    "🎵 `يوت [أغنية]` — تحميل وإرسال\n" +
    "🔍 `بحث [أغنية]` — بحث واختيار\n\n" +
    "*أوامر المكالمات:*\n" +
    "📞 `شغل [أغنية]` — تشغيل في المكالمة\n" +
    "📋 `قائمة` — عرض الطابور\n" +
    "⏭ `التالي` — الأغنية التالية\n" +
    "⏹ `وقف` — إيقاف التشغيل\n\n" +
    "💡 يدعم Inline Mode: اكتب `@البوت اسم_الأغنية` في أي محادثة",
    { parse_mode: "Markdown" },
  ),
);

bot.command("qr", async (ctx) => {
  if (!voiceManager.isReady()) return ctx.reply("⏳ خدمة المكالمات لم تبدأ بعد.");
  await ctx.reply("🔄 جارٍ إنشاء رمز QR...");
  const result = await voiceManager.qrLogin();
  if (!result.ok || !result.url) return ctx.reply(`❌ ${result.error ?? "فشل"}`);
  const qrUrl = result.url as string;
  try {
    await ctx.replyWithPhoto(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`, {
      caption: "📱 *امسح بتطبيق تلغرام*\nالإعدادات ← الأجهزة ← ربط جهاز جديد\n\n⏳ صالح لمدة دقيقتين",
      parse_mode: "Markdown",
    });
  } catch { await ctx.reply(`📱 \`${qrUrl}\``, { parse_mode: "Markdown" }); }
  if (ctx.from?.id) pendingQR.set(ctx.from.id, ctx.chat.id);
});

bot.command("status", async (ctx) => {
  const version = (() => { try { return execFileSync(YT_DLP_BIN, ["--version"], { stdio: "pipe" }).toString().trim(); } catch { return "غير معروف"; } })();
  if (!voiceManager.isReady()) return ctx.reply(`ℹ️ yt-dlp: ${version}\n❌ خدمة المكالمات غير متاحة.`);
  const r = await voiceManager.checkSession();
  await ctx.reply(
    `ℹ️ *الحالة:*\n` +
    `yt-dlp: \`${version}\`\n` +
    `💾 كاش: ${fileIdCache.size} أغنية\n` +
    (r.ok ? `✅ حساب: *${r.name}* (${r.phone})` : "❌ لا يوجد حساب — استخدم /qr"),
    { parse_mode: "Markdown" },
  );
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (text.startsWith("يوت ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `يوت محمد عبده`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث: *${query}*`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) { await ctx.api.editMessageText(chatId, msg.message_id, "❌ ما لقيت نتائج."); return; }
      await sendCachedAudio(chatId, results[0]!, ctx.api, msg.message_id);
    } catch (err) {
      logger.error({ err }, "يوت error");
      await ctx.api.editMessageText(chatId, msg.message_id, `❌ \`${(err as Error).message?.slice(0, 300)}\``, { parse_mode: "Markdown" }).catch(() => {});
    }
    return;
  }

  if (text.startsWith("بحث ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `بحث ماجد المهندس`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث: *${query}*`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 5);
      if (!results.length) { await ctx.api.editMessageText(chatId, msg.message_id, "❌ ما لقيت نتائج."); return; }
      await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      const keyboard = new InlineKeyboard();
      for (const v of results) {
        const cached = fileIdCache.has(v.id) ? "⚡ " : "⬇️ ";
        keyboard.text(`${cached}${v.title.slice(0, 30)} [${v.duration}]`, `dl:${v.id}:${encodeURIComponent(v.uploader).slice(0, 20)}:${encodeURIComponent(v.title).slice(0, 30)}:${v.duration}`).row();
      }
      await ctx.reply(`🎵 *نتائج:* ${query}`, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (err) {
      logger.error({ err }, "بحث error");
      await ctx.api.editMessageText(chatId, msg.message_id, `❌ \`${(err as Error).message?.slice(0, 300)}\``, { parse_mode: "Markdown" }).catch(() => {});
    }
    return;
  }

  if (text.startsWith("شغل ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `شغل محمد عبده`", { parse_mode: "Markdown" });
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة. استخدم /qr أولاً.");
    const msg = await ctx.reply(`🔍 أبحث: *${query}*`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) { await ctx.api.editMessageText(chatId, msg.message_id, "❌ ما لقيت نتائج."); return; }
      await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      const v = results[0]!;
      const queue = voiceQueue.get(chatId) ?? [];
      queue.push({ videoId: v.id, title: v.title, uploader: v.uploader });
      voiceQueue.set(chatId, queue);
      if (queue.length === 1) {
        await ctx.reply(`▶️ جارٍ التشغيل: *${v.title}*\n👤 ${v.uploader}`, { parse_mode: "Markdown" });
        processVoiceQueue(chatId, ctx.api);
      } else {
        await ctx.reply(`➕ أضيف للطابور (#${queue.length}): *${v.title}*`, { parse_mode: "Markdown" });
      }
    } catch (err) {
      logger.error({ err }, "شغل error");
      await ctx.api.editMessageText(chatId, msg.message_id, `❌ \`${(err as Error).message?.slice(0, 300)}\``, { parse_mode: "Markdown" }).catch(() => {});
    }
    return;
  }

  if (text === "وقف") {
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");
    voiceQueue.delete(chatId);
    const r = await voiceManager.stop(chatId);
    if (r.ok) { nowPlaying.delete(chatId); await ctx.reply("⏹ تم الإيقاف وتفريغ الطابور."); }
    else await ctx.reply(`❌ ${r.error}`);
    return;
  }

  if (text === "التالي") {
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");
    const queue = voiceQueue.get(chatId);
    if (!queue?.length) return ctx.reply("📋 الطابور فارغ.");
    queue.shift();
    await voiceManager.stop(chatId);
    if (queue.length) { await ctx.reply(`⏭ التالي: *${queue[0]!.title}*`, { parse_mode: "Markdown" }); processVoiceQueue(chatId, ctx.api); }
    else { nowPlaying.delete(chatId); await ctx.reply("✅ انتهى الطابور."); }
    return;
  }

  if (text === "قائمة") {
    const queue = voiceQueue.get(chatId);
    const current = nowPlaying.get(chatId);
    if (!queue?.length && !current) return ctx.reply("📋 الطابور فارغ.");
    let m = `📋 *الطابور:*\n`;
    if (current) m += `▶️ يشغّل: ${current}\n`;
    queue?.forEach((t, i) => { m += `${i + 1}. ${t.title}\n`; });
    await ctx.reply(m, { parse_mode: "Markdown" });
    return;
  }
});

// ── Inline mode ──────────────────────────────────────────────────────────
bot.on("inline_query", async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  if (query.length < 2) return ctx.answerInlineQuery([], { cache_time: 1 });
  try {
    const results = await searchYouTube(query, 5);
    const answers = results.map((v) =>
      InlineQueryResultBuilder.article(`yt:${v.id}`, `${fileIdCache.has(v.id) ? "⚡ " : ""}${v.title}`, {
        description: `👤 ${v.uploader} • ⏱ ${v.duration}`,
        thumbnail_url: v.thumbnail,
        input_message_content: { message_text: `🎵 *${v.title}*\n👤 ${v.uploader} • ⏱ ${v.duration}`, parse_mode: "Markdown" },
        reply_markup: new InlineKeyboard().text(
          fileIdCache.has(v.id) ? "⚡ إرسال (كاش)" : "⬇️ تحميل وإرسال",
          `dl:${v.id}:${encodeURIComponent(v.uploader).slice(0, 20)}:${encodeURIComponent(v.title).slice(0, 30)}:${v.duration}`,
        ),
      }),
    );
    await ctx.answerInlineQuery(answers, { cache_time: 60, is_personal: false });
  } catch (err) {
    logger.error({ err }, "inline_query error");
    await ctx.answerInlineQuery([], { cache_time: 5 });
  }
});

// ── Callbacks ────────────────────────────────────────────────────────────
bot.callbackQuery(/^dl:([^:]+):([^:]+):([^:]+):(.*)$/, async (ctx) => {
  const [, videoId, uploader, title, duration] = ctx.match;
  await ctx.answerCallbackQuery({ text: fileIdCache.has(videoId!) ? "⚡ إرسال من الكاش!" : "⬇️ جارٍ التحميل..." });
  const chatId = ctx.chat?.id ?? ctx.message?.chat.id;
  if (!chatId || !videoId || !uploader || !title) return;
  await sendCachedAudio(chatId, { id: videoId, title: decodeURIComponent(title), uploader: decodeURIComponent(uploader), duration: duration ?? "" }, ctx.api);
});

// ── Startup ──────────────────────────────────────────────────────────────
export async function startBot() {
  await loadCache();
  voiceManager.start();
  voiceManager.once("ready", async () => {
    logger.info("VoiceService ready");
    const check = await voiceManager.checkSession();
    if (check.ok) logger.info({ name: check.name }, "Session active");
    else logger.warn("No user session — use /qr");
  });
  voiceManager.on("message", async (msg: { ok: boolean; event?: string; [k: string]: unknown }) => {
    if (msg.event === "qr_logged_in") {
      for (const [userId, chatId] of pendingQR.entries()) {
        try {
          let txt = `✅ تم تسجيل الدخول!\n👤 ${msg.name} (${msg.phone})`;
          if (msg.session_string) txt += `\n\n💾 *Session String:*\n\`${msg.session_string}\`\n\nضعه في \`TELEGRAM_SESSION_STRING\``;
          await bot.api.sendMessage(chatId, txt, { parse_mode: "Markdown" });
        } catch { /* ignore */ }
        pendingQR.delete(userId);
      }
    } else if (msg.event === "qr_timeout") {
      for (const [userId, chatId] of pendingQR.entries()) {
        try { await bot.api.sendMessage(chatId, "⏰ انتهت صلاحية QR. استخدم /qr مجدداً."); } catch { /* ignore */ }
        pendingQR.delete(userId);
      }
    } else if (msg.event === "qr_error") {
      for (const [userId, chatId] of pendingQR.entries()) {
        try { await bot.api.sendMessage(chatId, `❌ خطأ: ${msg.error}`); } catch { /* ignore */ }
        pendingQR.delete(userId);
      }
    }
  });
  bot.start({ onStart: () => logger.info("Bot polling started") }).catch((err) => logger.error({ err }, "Bot error"));
  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
}
