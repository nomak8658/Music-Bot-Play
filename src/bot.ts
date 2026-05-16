import { Bot, InlineKeyboard, InputFile, InlineQueryResultBuilder } from "grammy";
import { execFile } from "node:child_process";
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

// ── Cache: videoId -> Telegram file_id ─────────────────────────────────────
const CACHE_FILE = join(__dirname, "..", "cache.json");
const fileIdCache = new Map<string, string>();

async function loadCache() {
  try {
    const data = await readFile(CACHE_FILE, "utf-8");
    const obj = JSON.parse(data) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) fileIdCache.set(k, v);
    logger.info({ count: fileIdCache.size }, "Song cache loaded");
  } catch { /* no cache file yet */ }
}

async function saveCache() {
  try {
    const obj = Object.fromEntries(fileIdCache);
    await writeFile(CACHE_FILE, JSON.stringify(obj));
  } catch (err) { logger.warn({ err }, "Failed to save cache"); }
}

// ── Voice call queue ────────────────────────────────────────────────────────
const voiceQueue = new Map<number, Array<{ videoId: string; title: string; uploader: string }>>();
const nowPlaying = new Map<number, string>();
const pendingQR = new Map<number, number>();

// ── yt-dlp common flags ────────────────────────────────────────────────────
const YT_FLAGS = [
  "--extractor-args", "youtube:player_client=android,web",
  "--add-header", "User-Agent:Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
  "--no-check-certificates",
];

type VideoResult = {
  id: string;
  title: string;
  duration: string;
  uploader: string;
  thumbnail: string;
  views: string;
};

async function searchYouTube(query: string, limit = 5): Promise<VideoResult[]> {
  const { stdout } = await execFileAsync("yt-dlp", [
    `ytsearch${limit}:${query}`,
    "--print", "%(id)s|||%(title)s|||%(duration_string)s|||%(uploader)s|||%(thumbnail)s|||%(view_count)s",
    "--no-download", "--no-playlist",
    "--socket-timeout", "20", "--quiet",
    ...YT_FLAGS,
  ], { timeout: 35_000 });

  return stdout.trim().split("\n")
    .filter(l => l.includes("|||"))
    .map(l => {
      const p = l.split("|||");
      return {
        id: p[0]!.trim(),
        title: p[1]!.trim(),
        duration: p[2]!.trim(),
        uploader: p[3]!.trim(),
        thumbnail: p[4]!.trim(),
        views: Number(p[5]!.trim()).toLocaleString("ar"),
      };
    });
}

async function downloadAudio(videoId: string): Promise<string> {
  const outPath = `${tmpdir()}/tg_${videoId}.mp3`;
  // Return cached file if still on disk
  if (existsSync(outPath)) return outPath;

  await execFileAsync("yt-dlp", [
    `https://www.youtube.com/watch?v=${videoId}`,
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "-o", outPath.replace(".mp3", ".%(ext)s"),
    "--no-playlist", "--socket-timeout", "30", "--quiet",
    ...YT_FLAGS,
  ], { timeout: 120_000 });
  return outPath;
}

// ── Send audio (uses cache) ─────────────────────────────────────────────────
async function sendCachedAudio(
  chatId: number,
  video: Pick<VideoResult, "id" | "title" | "uploader" | "duration">,
  api: Bot["api"],
  statusMsgId?: number,
): Promise<void> {
  const cachedId = fileIdCache.get(video.id);

  if (cachedId) {
    // ⚡ Instant send from cache
    if (statusMsgId) await api.deleteMessage(chatId, statusMsgId).catch(() => {});
    await api.sendAudio(chatId, cachedId, {
      caption: `🎵 *${video.title}*\n👤 ${video.uploader} • ⏱ ${video.duration}\n⚡ من الكاش`,
      parse_mode: "Markdown",
    });
    return;
  }

  // Not cached — download
  const dlMsg = statusMsgId
    ? await api.editMessageText(chatId, statusMsgId, `⬇️ جارٍ التحميل: *${video.title}*\n👤 ${video.uploader}`, { parse_mode: "Markdown" }).catch(() => null)
    : await api.sendMessage(chatId, `⬇️ جارٍ التحميل: *${video.title}*\n👤 ${video.uploader}`, { parse_mode: "Markdown" });

  const dlMsgId = (dlMsg && "message_id" in dlMsg) ? dlMsg.message_id : statusMsgId;

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

    // Save file_id to cache
    if (sent.audio?.file_id) {
      fileIdCache.set(video.id, sent.audio.file_id);
      await saveCache();
    }

    if (dlMsgId) await api.deleteMessage(chatId, dlMsgId).catch(() => {});
  } catch (err) {
    logger.error({ err, videoId: video.id }, "Download failed");
    const errMsg = (err as Error).message?.slice(0, 300) ?? "خطأ غير معروف";
    if (dlMsgId) {
      await api.editMessageText(chatId, dlMsgId, `❌ فشل التحميل:\n\`${errMsg}\``, { parse_mode: "Markdown" }).catch(() => {});
    }
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
  }
}

// ── Voice call queue player ─────────────────────────────────────────────────
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
      // Pre-download next track in background
      const nextTrack = queue[1];
      if (nextTrack) downloadAudio(nextTrack.videoId).catch(() => {});
    } else {
      throw new Error((result.error as string) ?? "Unknown error");
    }
  } catch (err) {
    logger.error({ err }, "Voice play failed");
    await api.sendMessage(chatId, `❌ فشل تشغيل: ${next.title}`);
    queue.shift();
    processVoiceQueue(chatId, api);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────
bot.command("start", (ctx) =>
  ctx.reply(
    "أهلاً! 🎵 بوت الموسيقى\n\n" +
    "*أوامر التحميل:*\n" +
    "🎵 `يوت [أغنية]` — تحميل وإرسال\n" +
    "🔍 `بحث [أغنية]` — بحث واختيار\n\n" +
    "*أوامر المكالمات:*\n" +
    "📞 `شغل [أغنية]` — تشغيل في مكالمة\n" +
    "📋 `قائمة` — عرض الطابور\n" +
    "⏭ `التالي` — الأغنية التالية\n" +
    "⏹ `وقف` — إيقاف التشغيل\n\n" +
    "*البوت يدعم Inline Mode:*\n" +
    "اكتب `@اسم_البوت اسم_الأغنية` في أي محادثة 🔥",
    { parse_mode: "Markdown" },
  ),
);

bot.command("qr", async (ctx) => {
  if (!voiceManager.isReady()) return ctx.reply("⏳ خدمة المكالمات لم تبدأ بعد.");
  await ctx.reply("🔄 جارٍ إنشاء رمز QR...");
  const result = await voiceManager.qrLogin();
  if (!result.ok || !result.url) return ctx.reply(`❌ ${result.error ?? "فشل"}`);
  const qrUrl = result.url as string;
  const img = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`;
  try {
    await ctx.replyWithPhoto(img, {
      caption: "📱 *امسح بتطبيق تلغرام*\nالإعدادات ← الأجهزة ← ربط جهاز جديد\n\n⏳ صالح لمدة دقيقتين",
      parse_mode: "Markdown",
    });
  } catch {
    await ctx.reply(`📱 \`${qrUrl}\``, { parse_mode: "Markdown" });
  }
  if (ctx.from?.id) pendingQR.set(ctx.from.id, ctx.chat.id);
});

bot.command("status", async (ctx) => {
  if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");
  const r = await voiceManager.checkSession();
  if (r.ok) await ctx.reply(`✅ متصل: *${r.name}* (${r.phone})\n💾 كاش: ${fileIdCache.size} أغنية`, { parse_mode: "Markdown" });
  else await ctx.reply("❌ غير مسجل دخوله. استخدم /qr");
});

// ── Text handler ─────────────────────────────────────────────────────────────
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  // يوت
  if (text.startsWith("يوت ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `يوت محمد عبده`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث عن: *${query}*`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) { await ctx.api.editMessageText(chatId, msg.message_id, "❌ ما لقيت نتائج."); return; }
      await sendCachedAudio(chatId, results[0]!, ctx.api, msg.message_id);
    } catch (err) {
      logger.error({ err }, "يوت error");
      await ctx.api.editMessageText(chatId, msg.message_id, `❌ \`${(err as Error).message?.slice(0, 200)}\``, { parse_mode: "Markdown" }).catch(() => {});
    }
    return;
  }

  // بحث
  if (text.startsWith("بحث ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `بحث ماجد المهندس`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث عن: *${query}*`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 5);
      if (!results.length) { await ctx.api.editMessageText(chatId, msg.message_id, "❌ ما لقيت نتائج."); return; }
      await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      const keyboard = new InlineKeyboard();
      for (const v of results) {
        const cached = fileIdCache.has(v.id) ? "⚡" : "⬇️";
        keyboard.text(`${cached} ${v.title.slice(0, 30)} [${v.duration}]`, `dl:${v.id}:${encodeURIComponent(v.uploader).slice(0, 20)}:${encodeURIComponent(v.title).slice(0, 30)}`).row();
      }
      await ctx.reply(`🎵 *نتائج البحث:* ${query}`, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (err) {
      logger.error({ err }, "بحث error");
      await ctx.api.editMessageText(chatId, msg.message_id, `❌ \`${(err as Error).message?.slice(0, 200)}\``, { parse_mode: "Markdown" }).catch(() => {});
    }
    return;
  }

  // شغل
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
      await ctx.api.editMessageText(chatId, msg.message_id, `❌ \`${(err as Error).message?.slice(0, 200)}\``, { parse_mode: "Markdown" }).catch(() => {});
    }
    return;
  }

  // وقف
  if (text === "وقف") {
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");
    voiceQueue.delete(chatId);
    const r = await voiceManager.stop(chatId);
    if (r.ok) { nowPlaying.delete(chatId); await ctx.reply("⏹ تم الإيقاف وتفريغ الطابور."); }
    else await ctx.reply(`❌ ${r.error}`);
    return;
  }

  // التالي
  if (text === "التالي") {
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");
    const queue = voiceQueue.get(chatId);
    if (!queue?.length) return ctx.reply("📋 الطابور فارغ.");
    queue.shift();
    await voiceManager.stop(chatId);
    if (queue.length) {
      await ctx.reply(`⏭ التالي: *${queue[0]!.title}*`, { parse_mode: "Markdown" });
      processVoiceQueue(chatId, ctx.api);
    } else {
      nowPlaying.delete(chatId);
      await ctx.reply("✅ انتهى الطابور.");
    }
    return;
  }

  // قائمة
  if (text === "قائمة") {
    const queue = voiceQueue.get(chatId);
    const current = nowPlaying.get(chatId);
    if (!queue?.length && !current) return ctx.reply("📋 الطابور فارغ.");
    let msg = `📋 *الطابور:*\n`;
    if (current) msg += `▶️ يشغّل: ${current}\n`;
    queue?.forEach((t, i) => { msg += `${i + 1}. ${t.title}\n`; });
    await ctx.reply(msg, { parse_mode: "Markdown" });
    return;
  }
});

// ── Inline mode ─────────────────────────────────────────────────────────────
bot.on("inline_query", async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  if (query.length < 2) {
    return ctx.answerInlineQuery([], { cache_time: 1 });
  }
  try {
    const results = await searchYouTube(query, 5);
    const answers = results.map((v) => {
      const cached = fileIdCache.has(v.id) ? "⚡ " : "";
      return InlineQueryResultBuilder
        .article(`yt:${v.id}`, `${cached}${v.title}`, {
          description: `👤 ${v.uploader} • ⏱ ${v.duration}`,
          thumbnail_url: v.thumbnail,
          input_message_content: {
            message_text: `🎵 *${v.title}*\n👤 ${v.uploader} • ⏱ ${v.duration}`,
            parse_mode: "Markdown",
          },
          reply_markup: new InlineKeyboard()
            .text(cached ? "⚡ إرسال (من الكاش)" : "⬇️ تحميل وإرسال", `iq:${v.id}:${encodeURIComponent(v.uploader).slice(0, 20)}:${encodeURIComponent(v.title).slice(0, 40)}:${v.duration}`),
        });
    });
    await ctx.answerInlineQuery(answers, { cache_time: 60, is_personal: false });
  } catch (err) {
    logger.error({ err }, "inline_query error");
    await ctx.answerInlineQuery([], { cache_time: 5 });
  }
});

// ── Callbacks ────────────────────────────────────────────────────────────────
bot.callbackQuery(/^dl:([^:]+):([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: fileIdCache.has(ctx.match[1]!) ? "⚡ إرسال من الكاش!" : "⬇️ جارٍ التحميل..." });
  const [, videoId, uploader, title] = ctx.match;
  const chatId = ctx.chat?.id;
  if (!chatId || !videoId || !uploader || !title) return;
  await sendCachedAudio(chatId, {
    id: videoId,
    title: decodeURIComponent(title),
    uploader: decodeURIComponent(uploader),
    duration: "",
  }, ctx.api);
});

bot.callbackQuery(/^iq:([^:]+):([^:]+):([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: fileIdCache.has(ctx.match[1]!) ? "⚡ إرسال من الكاش!" : "⬇️ جارٍ التحميل..." });
  const [, videoId, uploader, title, duration] = ctx.match;
  const chatId = ctx.chat?.id ?? ctx.message?.chat.id;
  if (!chatId || !videoId || !uploader || !title || !duration) return;
  await sendCachedAudio(chatId, {
    id: videoId,
    title: decodeURIComponent(title),
    uploader: decodeURIComponent(uploader),
    duration,
  }, ctx.api);
});

// ── Bot startup ───────────────────────────────────────────────────────────────
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

  bot.start({
    onStart: () => logger.info("Bot polling started"),
  }).catch((err) => logger.error({ err }, "Bot error"));

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
}
