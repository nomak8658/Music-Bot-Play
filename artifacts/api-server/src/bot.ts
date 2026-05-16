import { Bot, InlineKeyboard, InputFile } from "grammy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { logger } from "./lib/logger";
import { voiceManager } from "./voice_manager";

const execFileAsync = promisify(execFile);

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const bot = new Bot(BOT_TOKEN);

// State
const voiceQueues = new Map<number, string[]>();  // chatId -> queue of audio files
const nowPlaying = new Map<number, string>();      // chatId -> song title
// Track who is waiting for QR scan (userId -> chatId so we can reply when done)
const pendingQR = new Map<number, number>();

type VideoResult = { id: string; title: string; duration: string; uploader: string };

async function searchYouTube(query: string, limit = 5): Promise<VideoResult[]> {
  const { stdout } = await execFileAsync("yt-dlp", [
    `ytsearch${limit}:${query}`,
    "--print", "%(id)s|||%(title)s|||%(duration_string)s|||%(uploader)s",
    "--no-download", "--no-playlist", "--socket-timeout", "15", "--quiet",
  ]);
  return stdout.trim().split("\n")
    .filter(l => l.includes("|||"))
    .map(l => {
      const p = l.split("|||");
      return { id: p[0].trim(), title: p[1].trim(), duration: p[2].trim(), uploader: p[3].trim() };
    });
}

async function downloadAudio(videoId: string): Promise<string> {
  const outTemplate = `${tmpdir()}/tg_${videoId}_${Date.now()}.%(ext)s`;
  await execFileAsync("yt-dlp", [
    `https://www.youtube.com/watch?v=${videoId}`,
    "-x", "--audio-format", "mp3", "--audio-quality", "128K",
    "-o", outTemplate, "--no-playlist", "--socket-timeout", "30", "--quiet",
  ]);
  return outTemplate.replace("%(ext)s", "mp3");
}

async function sendAudioFile(
  chatId: number,
  videoId: string,
  title: string,
  uploader: string,
  api: Bot["api"],
): Promise<string | null> {
  const statusMsg = await api.sendMessage(chatId, `⏳ جارٍ تحميل: ${title}`);
  let filePath: string | null = null;
  try {
    filePath = await downloadAudio(videoId);
    if (!existsSync(filePath)) throw new Error("File not found");
    const { createReadStream } = await import("node:fs");
    await api.sendAudio(chatId, new InputFile(createReadStream(filePath), `${title.slice(0, 50)}.mp3`), {
      title: title.slice(0, 64),
      performer: uploader.slice(0, 64),
      caption: `🎵 ${title}\n👤 ${uploader}`,
    });
    await api.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    return filePath;
  } catch (err) {
    logger.error({ err, videoId }, "Download/send failed");
    await api.editMessageText(chatId, statusMsg.message_id, "❌ فشل التحميل، جرب أغنية ثانية.").catch(() => {});
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
    return null;
  }
}

async function playInCall(chatId: number, videoId: string, title: string, uploader: string, api: Bot["api"]) {
  const statusMsg = await api.sendMessage(chatId, `⏳ تحميل للمكالمة: ${title}`);
  let filePath: string | null = null;
  try {
    filePath = await downloadAudio(videoId);
    if (!existsSync(filePath)) throw new Error("File not found");

    const result = await voiceManager.joinAndPlay(chatId, filePath);
    if (result.ok) {
      nowPlaying.set(chatId, title);
      await api.editMessageText(chatId, statusMsg.message_id,
        `🎵 يشغّل الآن في المكالمة:\n*${title}*\n👤 ${uploader}\n\n⏹ *وقف* — لإيقاف التشغيل`,
        { parse_mode: "Markdown" });
    } else {
      throw new Error(result.error as string ?? "Unknown error");
    }
  } catch (err) {
    logger.error({ err }, "Voice call play failed");
    await api.editMessageText(chatId, statusMsg.message_id,
      `❌ فشل التشغيل في المكالمة: ${(err as Error).message}`).catch(() => {});
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
  }
}

// ─── Bot commands ───────────────────────────────────────────────────

bot.command("start", (ctx) =>
  ctx.reply(
    "مرحباً! 🎵\n\n*أوامر البوت:*\n\n" +
    "🎵 `يوت [أغنية]` — تحميل وإرسال الأغنية\n" +
    "🔍 `بحث [أغنية]` — بحث وعرض نتائج\n" +
    "📞 `شغل [أغنية]` — تشغيل في مكالمة المجموعة\n" +
    "⏹ `وقف` — إيقاف التشغيل\n\n" +
    "لتفعيل المكالمات: `/qr` ثم امسح الكود بتطبيق تلغرام",
    { parse_mode: "Markdown" },
  ),
);

// QR login flow
bot.command("qr", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId) return;

  if (!voiceManager.isReady()) {
    return ctx.reply("⏳ خدمة المكالمات لم تبدأ بعد، انتظر لحظة وحاول مجدداً.");
  }

  await ctx.reply("🔄 جارٍ إنشاء رمز QR...");

  const result = await voiceManager.qrLogin();

  if (!result.ok || !result.url) {
    return ctx.reply(`❌ فشل إنشاء رمز QR: ${result.error ?? "خطأ غير معروف"}`);
  }

  const qrUrl = result.url as string;

  // Fetch QR image from public QR API
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`;

  try {
    await ctx.replyWithPhoto(qrImageUrl, {
      caption:
        "📱 *امسح هذا الرمز بتطبيق تلغرام*\n\n" +
        "الإعدادات ← الأجهزة ← ربط جهاز جديد\n\n" +
        "⏳ الرمز صالح لمدة دقيقتين.",
      parse_mode: "Markdown",
    });

    // Remember who is waiting so we can notify them when scanned
    pendingQR.set(userId, chatId);
  } catch (err) {
    logger.error({ err }, "Failed to send QR photo");
    await ctx.reply(
      `📱 *رابط تسجيل الدخول (نسخه في تلغرام):*\n\`${qrUrl}\`\n\n` +
      "⏳ الرمز صالح لمدة دقيقتين.",
      { parse_mode: "Markdown" },
    );
    pendingQR.set(userId, chatId);
  }
});

bot.command("status", async (ctx) => {
  if (!voiceManager.isReady()) {
    return ctx.reply("❌ خدمة المكالمات غير متاحة.");
  }
  const result = await voiceManager.checkSession();
  if (result.ok) {
    await ctx.reply(`✅ الحساب متصل: *${result.name}* (${result.phone})`, { parse_mode: "Markdown" });
  } else {
    await ctx.reply("❌ الحساب غير مسجل دخوله. استخدم /qr");
  }
});

// ─── Text handler ────────────────────────────────────────────────────
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  // ── يوت ──
  if (text.startsWith("يوت ") || text === "يوت") {
    const query = text.slice(4).trim();
    if (!query) {
      return ctx.reply("⚠️ اكتب اسم الأغنية بعد *يوت*\nمثال: `يوت محمد عبده`", { parse_mode: "Markdown" });
    }
    await ctx.reply(`🔍 أبحث عن: ${query}`);
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) return ctx.reply("❌ ما لقيت نتائج.");
      const top = results[0];
      await sendAudioFile(chatId, top.id, top.title, top.uploader, ctx.api);
    } catch (err) {
      logger.error({ err }, "يوت error");
      await ctx.reply("❌ صار خطأ، جرب مرة ثانية.");
    }
    return;
  }

  // ── بحث ──
  if (text.startsWith("بحث ") || text === "بحث") {
    const query = text.slice(4).trim();
    if (!query) {
      return ctx.reply("⚠️ اكتب اسم الأغنية بعد *بحث*\nمثال: `بحث ماجد المهندس`", { parse_mode: "Markdown" });
    }
    const searchMsg = await ctx.reply(`🔍 أبحث عن: ${query}`);
    try {
      const results = await searchYouTube(query, 5);
      if (!results.length) {
        await ctx.api.editMessageText(chatId, searchMsg.message_id, "❌ ما لقيت نتائج.");
        return;
      }
      await ctx.api.deleteMessage(chatId, searchMsg.message_id).catch(() => {});
      const keyboard = new InlineKeyboard();
      for (const v of results) {
        const label = `${v.title.slice(0, 33)} [${v.duration}]`;
        keyboard.text(label, `dl:${v.id}:${v.uploader.slice(0, 18)}:${v.title.slice(0, 28)}`).row();
      }
      await ctx.reply(`🎵 *نتائج:* ${query}\n\nاختر أغنية:`, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } catch (err) {
      logger.error({ err }, "بحث error");
      await ctx.api.editMessageText(chatId, searchMsg.message_id, "❌ صار خطأ.").catch(() => {});
    }
    return;
  }

  // ── شغل (مكالمة) ──
  if (text.startsWith("شغل ") || text === "شغل") {
    const query = text.slice(4).trim();
    if (!query) {
      return ctx.reply("⚠️ اكتب اسم الأغنية بعد *شغل*\nمثال: `شغل محمد عبده`", { parse_mode: "Markdown" });
    }
    if (!voiceManager.isReady()) {
      return ctx.reply("❌ خدمة المكالمات غير متاحة. تأكد من /qr أولاً.");
    }
    await ctx.reply(`🔍 أبحث عن: ${query}`);
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) return ctx.reply("❌ ما لقيت نتائج.");
      const top = results[0];
      await playInCall(chatId, top.id, top.title, top.uploader, ctx.api);
    } catch (err) {
      logger.error({ err }, "شغل error");
      await ctx.reply("❌ صار خطأ.");
    }
    return;
  }

  // ── وقف ──
  if (text === "وقف" || text === "⏹ وقف") {
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");
    const result = await voiceManager.stop(chatId);
    if (result.ok) {
      nowPlaying.delete(chatId);
      await ctx.reply("⏹ تم إيقاف التشغيل.");
    } else {
      await ctx.reply(`❌ ${result.error}`);
    }
    return;
  }
});

// ── Download callback ──
bot.callbackQuery(/^dl:([^:]+):([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "⏳ جارٍ التحميل..." });
  const [, videoId, uploader, title] = ctx.match;
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await sendAudioFile(chatId, videoId, title, uploader, ctx.api);
});

// ── Play in call callback ──
bot.callbackQuery(/^play_call:([^:]+):([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "⏳ جارٍ التشغيل في المكالمة..." });
  const [, videoId, uploader, title] = ctx.match;
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (!voiceManager.isReady()) {
    await ctx.reply("❌ خدمة المكالمات غير متاحة. تأكد من /qr أولاً.");
    return;
  }
  await playInCall(chatId, videoId, title, uploader, ctx.api);
});

export function startBot() {
  voiceManager.start();

  voiceManager.once("ready", async () => {
    logger.info("VoiceService is ready");
    const check = await voiceManager.checkSession();
    if (check.ok) {
      logger.info({ name: check.name }, "User session active");
    } else {
      logger.warn("No active user session — use /qr to log in");
    }
  });

  // Handle async QR events (fired after user scans or timeout)
  voiceManager.on("message", async (msg: { ok: boolean; event?: string; [k: string]: unknown }) => {
    if (msg.event === "qr_logged_in") {
      const sessionString = msg.session_string as string | undefined;
      logger.info({ name: msg.name }, "QR login successful");

      // Notify all users who were waiting for QR scan
      for (const [userId, chatId] of pendingQR.entries()) {
        try {
          let text = `✅ تم تسجيل الدخول بنجاح!\n👤 ${msg.name} (${msg.phone})`;
          if (sessionString) {
            text +=
              "\n\n💾 *احفظ هذا الـ Session String* لتجنب تسجيل الدخول مرة أخرى:\n" +
              `\`${sessionString}\`\n\n` +
              "ضعه في متغير البيئة `TELEGRAM_SESSION_STRING`";
          }
          await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
        } catch (e) {
          logger.error({ e, userId }, "Failed to notify QR login success");
        }
        pendingQR.delete(userId);
      }
    } else if (msg.event === "qr_timeout") {
      logger.warn("QR login timed out");
      for (const [userId, chatId] of pendingQR.entries()) {
        try {
          await bot.api.sendMessage(chatId, "⏰ انتهت صلاحية رمز QR. استخدم /qr مرة أخرى.");
        } catch (e) {
          logger.error({ e, userId }, "Failed to notify QR timeout");
        }
        pendingQR.delete(userId);
      }
    } else if (msg.event === "qr_error") {
      logger.error({ error: msg.error }, "QR login error");
      for (const [userId, chatId] of pendingQR.entries()) {
        try {
          await bot.api.sendMessage(chatId, `❌ خطأ في تسجيل الدخول: ${msg.error}`);
        } catch (e) {
          logger.error({ e }, "Failed to notify QR error");
        }
        pendingQR.delete(userId);
      }
    }
  });

  bot.start().catch((err) => {
    logger.error({ err }, "Bot launch error");
  });

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  logger.info("Telegram bot started with voice call support");
}
