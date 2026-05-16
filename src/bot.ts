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

// ── Detect yt-dlp binary ──────────────────────────────────────────────────
function findYtDlp(): string {
  const candidates = [
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "/root/.local/bin/yt-dlp",
    join(__dirname, "..", ".venv", "bin", "yt-dlp"),
    "yt-dlp",
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "pipe" });
      return c;
    } catch { /* try next */ }
  }
  throw new Error("yt-dlp not found");
}

let YT_DLP_BIN = "yt-dlp";
try {
  YT_DLP_BIN = findYtDlp();
  const ver = execFileSync(YT_DLP_BIN, ["--version"], { stdio: "pipe" }).toString().trim();
  logger.info({ bin: YT_DLP_BIN, ver }, "yt-dlp ready");
} catch (err) {
  logger.error({ err }, "yt-dlp not found!");
}

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
  catch (err) { logger.warn({ err }, "Failed to save cache"); }
}

// ── Voice queue ───────────────────────────────────────────────────────────
type QueueItem = { videoId: string; title: string; uploader: string };
const voiceQueue = new Map<number, QueueItem[]>();
const nowPlaying = new Map<number, string>();
const pendingQR = new Map<number, number>();

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtDuration(sec: number): string {
  if (!sec || isNaN(sec)) return "?:??";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Safe edit — falls back to new message on failure
async function safeEdit(api: Bot["api"], chatId: number, msgId: number, text: string) {
  try { await api.editMessageText(chatId, msgId, text, { parse_mode: "Markdown" }); }
  catch { await api.sendMessage(chatId, text, { parse_mode: "Markdown" }); }
}

// ── YouTube search (robust — uses --dump-json) ────────────────────────────
type VideoResult = { id: string; title: string; duration: string; uploader: string; thumbnail: string };

async function searchYouTube(query: string, limit = 5): Promise<VideoResult[]> {
  const args = [
    `ytsearch${limit}:${query}`,
    "--dump-json",
    "--no-playlist",
    "--ignore-errors",
    "--socket-timeout", "30",
    "--no-check-certificates",
    "--extractor-args", "youtube:player_client=ios,mweb",
    "--add-header", "Accept-Language:ar-SA,ar;q=0.9,en;q=0.8",
  ];

  let stdout = "";
  try {
    const result = await execFileAsync(YT_DLP_BIN, args, { timeout: 60_000 });
    stdout = result.stdout;
  } catch (err: unknown) {
    // execFile throws when exit code != 0, but stdout may still have results
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout) stdout = e.stdout;
    else throw new Error(e.stderr?.slice(0, 500) ?? e.message ?? "yt-dlp failed");
  }

  const results: VideoResult[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const j = JSON.parse(trimmed) as {
        id?: string; title?: string; duration?: number;
        uploader?: string; channel?: string; thumbnail?: string;
      };
      if (!j.id) continue;
      results.push({
        id: j.id,
        title: j.title ?? "Unknown",
        duration: fmtDuration(j.duration ?? 0),
        uploader: j.uploader ?? j.channel ?? "Unknown",
        thumbnail: j.thumbnail ?? "",
      });
    } catch { /* skip malformed line */ }
  }
  return results;
}

// ── Download audio ────────────────────────────────────────────────────────
async function downloadAudio(videoId: string): Promise<string> {
  const outPath = join(tmpdir(), `tgbot_${videoId}.mp3`);
  if (existsSync(outPath)) return outPath;

  const args = [
    `https://www.youtube.com/watch?v=${videoId}`,
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "-o", join(tmpdir(), `tgbot_${videoId}.%(ext)s`),
    "--no-playlist",
    "--socket-timeout", "30",
    "--no-check-certificates",
    "--ignore-errors",
    "--extractor-args", "youtube:player_client=ios,mweb",
    "--add-header", "Accept-Language:ar-SA,ar;q=0.9,en;q=0.8",
    "--quiet", "--no-warnings",
  ];

  try {
    await execFileAsync(YT_DLP_BIN, args, { timeout: 180_000 });
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const stderr = e.stderr ?? e.message ?? "";
    // If the mp3 was created despite non-zero exit, use it
    if (!existsSync(outPath)) throw new Error(stderr.slice(0, 500));
  }
  return outPath;
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

  const dlMsgId = statusMsgId
    ? (await safeEdit(api, chatId, statusMsgId, `⬇️ جارٍ التحميل…\n*${video.title}*`), statusMsgId)
    : (await api.sendMessage(chatId, `⬇️ جارٍ التحميل…\n*${video.title}*`, { parse_mode: "Markdown" })).message_id;

  let filePath: string | undefined;
  try {
    filePath = await downloadAudio(video.id);
    const { createReadStream } = await import("node:fs");
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
    if (sent.audio?.file_id) {
      fileIdCache.set(video.id, sent.audio.file_id);
      await saveCache();
    }
    await api.deleteMessage(chatId, dlMsgId).catch(() => {});
  } catch (err) {
    logger.error({ err, videoId: video.id }, "Download/send failed");
    const msg = (err as Error).message?.slice(0, 300) ?? "خطأ غير معروف";
    await safeEdit(api, chatId, dlMsgId, `❌ فشل التحميل:\n\`${msg}\``);
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
  }
}

// ── Voice queue processor ─────────────────────────────────────────────────
async function processVoiceQueue(chatId: number, api: Bot["api"]) {
  const queue = voiceQueue.get(chatId);
  if (!queue?.length) { voiceQueue.delete(chatId); nowPlaying.delete(chatId); return; }
  const item = queue[0]!;
  try {
    const filePath = await downloadAudio(item.videoId);
    const result = await voiceManager.joinAndPlay(chatId, filePath);
    if (!result.ok) throw new Error((result.error as string) ?? "فشل التشغيل");
    nowPlaying.set(chatId, item.title);
    // Pre-download next track
    if (queue[1]) downloadAudio(queue[1].videoId).catch(() => {});
  } catch (err) {
    logger.error({ err }, "Voice play failed");
    await api.sendMessage(chatId, `❌ فشل تشغيل: ${item.title}\n\`${(err as Error).message?.slice(0, 200)}\``, { parse_mode: "Markdown" });
    queue.shift();
    processVoiceQueue(chatId, api);
  }
}

// ── /start ────────────────────────────────────────────────────────────────
bot.command("start", (ctx) =>
  ctx.reply(
    "أهلاً! 🎵 *بوت الموسيقى*\n\n" +
    "*تحميل:*\n`يوت [أغنية]` — تحميل وإرسال مباشر\n`بحث [أغنية]` — بحث واختيار\n\n" +
    "*مكالمات صوتية:*\n`شغل [أغنية]` — تشغيل في المكالمة\n`قائمة` — الطابور الحالي\n`التالي` — تخطي الأغنية\n`وقف` — إيقاف التشغيل\n\n" +
    "💡 *Inline:* `@البوت اسم_الأغنية` في أي محادثة",
    { parse_mode: "Markdown" },
  )
);

// ── /status ───────────────────────────────────────────────────────────────
bot.command("status", async (ctx) => {
  const ytVer = (() => {
    try { return execFileSync(YT_DLP_BIN, ["--version"], { stdio: "pipe" }).toString().trim(); }
    catch { return "غير موجود ❌"; }
  })();
  const voiceStatus = voiceManager.isReady()
    ? await voiceManager.checkSession().then(r => r.ok ? `✅ ${r.name} (${r.phone})` : "❌ لا يوجد حساب — /qr")
    : "❌ الخدمة لم تبدأ";
  await ctx.reply(
    `*الحالة:*\nyt-dlp: \`${ytVer}\`\n💾 كاش: ${fileIdCache.size} أغنية\n📞 حساب: ${voiceStatus}`,
    { parse_mode: "Markdown" },
  );
});

// ── /qr ───────────────────────────────────────────────────────────────────
bot.command("qr", async (ctx) => {
  if (!voiceManager.isReady()) return ctx.reply("⏳ خدمة المكالمات لم تبدأ بعد.");
  const msg = await ctx.reply("🔄 جارٍ إنشاء رمز QR…");
  const result = await voiceManager.qrLogin();
  if (!result.ok || !result.url) {
    await safeEdit(ctx.api, ctx.chat.id, msg.message_id, `❌ ${result.error ?? "فشل"}`);
    return;
  }
  const qrUrl = result.url as string;
  try {
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    await ctx.replyWithPhoto(
      `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`,
      { caption: "📱 *امسح بتطبيق تلغرام*\nالإعدادات ← الأجهزة ← ربط جهاز جديد\n\n⏳ صالح لمدة دقيقتين", parse_mode: "Markdown" },
    );
  } catch { await ctx.reply(`📱 \`${qrUrl}\``, { parse_mode: "Markdown" }); }
  if (ctx.from?.id) pendingQR.set(ctx.from.id, ctx.chat.id);
});

// ── Text commands ─────────────────────────────────────────────────────────
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  // يوت
  if (text.startsWith("يوت ") || text.startsWith("يوتيوب ")) {
    const query = text.replace(/^(يوت|يوتيوب)\s+/, "").trim();
    if (!query) return ctx.reply("⚠️ مثال: `يوت محمد عبده`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث: *${query}*…`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) {
        await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج — جرّب كلمات مختلفة");
        return;
      }
      await sendAudio(chatId, results[0]!, ctx.api, msg.message_id);
    } catch (err) {
      logger.error({ err }, "يوت error");
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ خطأ:\n\`${(err as Error).message?.slice(0, 300)}\``);
    }
    return;
  }

  // بحث
  if (text.startsWith("بحث ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `بحث ماجد المهندس`", { parse_mode: "Markdown" });
    const msg = await ctx.reply(`🔍 أبحث: *${query}*…`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 5);
      if (!results.length) {
        await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج — جرّب كلمات مختلفة");
        return;
      }
      await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      const kb = new InlineKeyboard();
      for (const v of results) {
        const prefix = fileIdCache.has(v.id) ? "⚡" : "🎵";
        const label = `${prefix} ${v.title.slice(0, 35)} [${v.duration}]`;
        kb.text(label, `dl:${v.id}:${Buffer.from(v.uploader).toString("base64url").slice(0, 20)}:${Buffer.from(v.title).toString("base64url").slice(0, 40)}:${v.duration}`).row();
      }
      await ctx.reply(`🎵 *نتائج "${query}":*`, { parse_mode: "Markdown", reply_markup: kb });
    } catch (err) {
      logger.error({ err }, "بحث error");
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ خطأ:\n\`${(err as Error).message?.slice(0, 300)}\``);
    }
    return;
  }

  // شغل
  if (text.startsWith("شغل ")) {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ مثال: `شغل محمد عبده`", { parse_mode: "Markdown" });
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة. استخدم /qr أولاً.");
    const msg = await ctx.reply(`🔍 أبحث: *${query}*…`, { parse_mode: "Markdown" });
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) {
        await safeEdit(ctx.api, chatId, msg.message_id, "❌ ما لقيت نتائج.");
        return;
      }
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
      await safeEdit(ctx.api, chatId, msg.message_id, `❌ خطأ:\n\`${(err as Error).message?.slice(0, 300)}\``);
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
    const queue = voiceQueue.get(chatId) ?? [];
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
    const queue = voiceQueue.get(chatId) ?? [];
    const current = nowPlaying.get(chatId);
    if (!queue.length && !current) return ctx.reply("📋 الطابور فارغ.");
    let m = "📋 *الطابور:*\n";
    if (current) m += `▶️ *يشغّل:* ${current}\n`;
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
    const answers = results.map((v) =>
      InlineQueryResultBuilder.article(`yt:${v.id}`, `${fileIdCache.has(v.id) ? "⚡ " : ""}${v.title}`, {
        description: `👤 ${v.uploader} · ⏱ ${v.duration}`,
        thumbnail_url: v.thumbnail || undefined,
        input_message_content: { message_text: `🎵 *${v.title}*\n👤 ${v.uploader} · ⏱ ${v.duration}`, parse_mode: "Markdown" },
        reply_markup: new InlineKeyboard().text(
          fileIdCache.has(v.id) ? "⚡ إرسال (كاش)" : "⬇️ تحميل",
          `dl:${v.id}:${Buffer.from(v.uploader).toString("base64url").slice(0, 20)}:${Buffer.from(v.title).toString("base64url").slice(0, 40)}:${v.duration}`,
        ),
      }),
    );
    await ctx.answerInlineQuery(answers, { cache_time: 60 });
  } catch (err) {
    logger.error({ err }, "inline_query error");
    await ctx.answerInlineQuery([], { cache_time: 5 });
  }
});

// ── Callback: download button ─────────────────────────────────────────────
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

// ── Voice events ──────────────────────────────────────────────────────────
async function notifyQR(text: string) {
  for (const [userId, chatId] of pendingQR.entries()) {
    try { await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" }); } catch { /* ignore */ }
    pendingQR.delete(userId);
  }
}

// ── Bot startup ───────────────────────────────────────────────────────────
export async function startBot() {
  await loadCache();
  voiceManager.start();
  voiceManager.once("ready", async () => {
    logger.info("VoiceService ready");
    const s = await voiceManager.checkSession();
    logger.info(s.ok ? { name: s.name } : {}, s.ok ? "Session active" : "No user session");
  });
  voiceManager.on("message", async (msg: Record<string, unknown>) => {
    if (msg["event"] === "qr_logged_in") {
      let txt = `✅ تم تسجيل الدخول!\n👤 ${msg["name"]} (${msg["phone"]})`;
      if (msg["session_string"]) txt += `\n\n💾 *Session String:*\n\`${msg["session_string"]}\`\n\nضعه في \`TELEGRAM_SESSION_STRING\``;
      await notifyQR(txt);
    } else if (msg["event"] === "qr_timeout") {
      await notifyQR("⏰ انتهت صلاحية QR. استخدم /qr مجدداً.");
    } else if (msg["event"] === "qr_error") {
      await notifyQR(`❌ خطأ QR: ${msg["error"]}`);
    }
  });
  bot.start({ onStart: () => logger.info("Bot polling started") }).catch((err) => logger.error({ err }, "Bot crashed"));
  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
}
