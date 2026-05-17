import { Bot } from "grammy";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE  = join(__dirname, "..", "challenge.json");

// ── Types ─────────────────────────────────────────────────────────────────
export type ChallengeState = {
  active: boolean;
  chatId: number;
  day: number;           // current day (1-based)
  baseTarget: number;    // messages needed on day 1
  stepPerDay: number;    // how much target grows each day
  startTs: number;       // unix ms when current day started
  dayMs: number;         // ms per day (default 24h)
  counts: Record<string, number>;    // userId → message count this day
  userNames: Record<string, string>; // userId → display name
  totalEarned: Record<string, number>; // userId → total money won (SAR)
};

const DEFAULT_STATE: ChallengeState = {
  active: false, chatId: 0, day: 1,
  baseTarget: 900, stepPerDay: 100,
  startTs: 0, dayMs: 24 * 60 * 60 * 1000,
  counts: {}, userNames: {}, totalEarned: {},
};

// ── Persistence ───────────────────────────────────────────────────────────
let state: ChallengeState = { ...DEFAULT_STATE };

export async function loadChallenge() {
  try {
    state = JSON.parse(await readFile(DATA_FILE, "utf-8")) as ChallengeState;
    logger.info({ day: state.day, active: state.active }, "Challenge loaded");
  } catch { /* first run */ }
}

async function save() {
  try { await writeFile(DATA_FILE, JSON.stringify(state, null, 2)); }
  catch (err) { logger.warn({ err }, "Challenge save failed"); }
}

// ── Helpers ───────────────────────────────────────────────────────────────
export function isActive() { return state.active; }
export function getChatId() { return state.chatId; }

/** Target for a given day */
function targetForDay(day: number) {
  return state.baseTarget + (day - 1) * state.stepPerDay;
}

/** Prize money for successfully completing a day (in SAR) */
function prizeForDay(day: number) {
  // Day 1 = 20,000 SAR, grows 5,000 each day
  return 20_000 + (day - 1) * 5_000;
}

/** How many ms remain in the current day */
export function msLeft() {
  return Math.max(0, state.startTs + state.dayMs - Date.now());
}

/** Arabic countdown string */
function fmtCountdown(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}س ${m}د ${s}ث`;
}

function displayName(userId: string): string {
  return state.userNames[userId] ?? `مستخدم ${userId.slice(-4)}`;
}

// ── Count a message ───────────────────────────────────────────────────────
export function countMessage(userId: string, name: string) {
  if (!state.active) return;
  state.counts[userId] = (state.counts[userId] ?? 0) + 1;
  if (name) state.userNames[userId] = name;
}

// ── Start challenge ───────────────────────────────────────────────────────
export async function startChallenge(
  chatId: number,
  api: Bot["api"],
  opts?: { baseTarget?: number; stepPerDay?: number; dayHours?: number },
) {
  state = {
    ...DEFAULT_STATE,
    active: true,
    chatId,
    baseTarget: opts?.baseTarget ?? 900,
    stepPerDay: opts?.stepPerDay ?? 100,
    dayMs: (opts?.dayHours ?? 24) * 60 * 60 * 1000,
    day: 1,
    startTs: Date.now(),
    counts: {},
    userNames: {},
    totalEarned: state.totalEarned ?? {},
  };
  await save();

  const target = targetForDay(1);
  const prize  = prizeForDay(1);
  await api.sendMessage(chatId,
    `🏆 *انطلق التحدي!*\n\n` +
    `📅 *اليوم الأول*\n` +
    `🎯 الهدف: *${target} رسالة*\n` +
    `💰 الجائزة: *${prize.toLocaleString()} ريال لكل واحد*\n` +
    `⏰ المهلة: *${Math.round(state.dayMs / 3_600_000)} ساعة*\n\n` +
    `📈 كل يوم الهدف يزيد ${state.stepPerDay} رسالة والجائزة تزيد 5,000 ريال!\n\n` +
    `ابدأوا التحدث الآن! 💪`,
    { parse_mode: "Markdown" },
  );

  scheduleEndCheck(api);
}

// ── Stop challenge ────────────────────────────────────────────────────────
export async function stopChallenge(api: Bot["api"], reason = "أوقفه الأدمن") {
  if (!state.active) return;
  state.active = false;
  await save();
  await api.sendMessage(state.chatId,
    `⛔ *توقّف التحدي*\nالسبب: ${reason}\n_كان الفريق في اليوم ${state.day}_`,
    { parse_mode: "Markdown" },
  );
}

// ── Status message ────────────────────────────────────────────────────────
export async function sendStatus(api: Bot["api"]) {
  if (!state.active) {
    await api.sendMessage(state.chatId, "📋 لا يوجد تحدٍّ نشط حالياً.");
    return;
  }
  const target = targetForDay(state.day);
  const total  = Object.values(state.counts).reduce((a, b) => a + b, 0);
  const remain = Math.max(0, target - total);
  const pct    = Math.min(100, Math.round((total / target) * 100));
  const bar    = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));

  // Top 5 contributors
  const sorted = Object.entries(state.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topTxt = sorted.length
    ? sorted.map(([uid, cnt], i) => `${["🥇","🥈","🥉","4️⃣","5️⃣"][i]} ${displayName(uid)}: ${cnt}`).join("\n")
    : "لا يوجد رسائل بعد";

  await api.sendMessage(state.chatId,
    `📊 *حالة التحدي — اليوم ${state.day}*\n\n` +
    `${bar} ${pct}%\n` +
    `💬 المُرسَل: *${total}* / *${target}*\n` +
    `📉 المتبقي: *${remain}*\n` +
    `⏳ الوقت المتبقي: *${fmtCountdown(msLeft())}*\n` +
    `💰 الجائزة: *${prizeForDay(state.day).toLocaleString()} ريال*\n\n` +
    `🏅 *المتصدّرون:*\n${topTxt}`,
    { parse_mode: "Markdown" },
  );
}

// ── End of day logic ──────────────────────────────────────────────────────
let _timer: ReturnType<typeof setTimeout> | null = null;

function scheduleEndCheck(api: Bot["api"]) {
  if (_timer) clearTimeout(_timer);
  const delay = msLeft();
  if (delay <= 0) { void endDay(api); return; }
  _timer = setTimeout(() => void endDay(api), delay);
}

async function endDay(api: Bot["api"]) {
  if (!state.active) return;

  const target = targetForDay(state.day);
  const total  = Object.values(state.counts).reduce((a, b) => a + b, 0);
  const prize  = prizeForDay(state.day);
  const success = total >= target;

  if (success) {
    // ── WIN ───────────────────────────────────────────────────────────────
    const winners = Object.entries(state.counts)
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1]);

    for (const [uid] of winners) {
      state.totalEarned[uid] = (state.totalEarned[uid] ?? 0) + prize;
    }

    const topList = winners.slice(0, 5)
      .map(([uid, cnt], i) => `${["🥇","🥈","🥉","4️⃣","5️⃣"][i]} ${displayName(uid)}: ${cnt} رسالة`)
      .join("\n");

    // Advance to next day
    state.day += 1;
    state.startTs = Date.now();
    state.counts = {};
    await save();

    const nextTarget = targetForDay(state.day);
    const nextPrize  = prizeForDay(state.day);

    await api.sendMessage(state.chatId,
      `🎉 *اليوم ${state.day - 1} — اجتزتموه بنجاح!*\n\n` +
      `✅ أرسلتم *${total}* رسالة (الهدف ${target})\n` +
      `💰 كل مشارك ربح: *${prize.toLocaleString()} ريال*\n\n` +
      `🏅 *أكثر المشاركين:*\n${topList}\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `📅 *اليوم ${state.day} يبدأ الآن!*\n` +
      `🎯 الهدف الجديد: *${nextTarget} رسالة*\n` +
      `💰 الجائزة: *${nextPrize.toLocaleString()} ريال*\n\n` +
      `واصلوا التحدي! 🔥`,
      { parse_mode: "Markdown" },
    );

    scheduleEndCheck(api);

  } else {
    // ── FAIL ──────────────────────────────────────────────────────────────
    const shortfall = target - total;
    const lowestList = Object.entries(state.counts)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3)
      .map(([uid, cnt]) => `• ${displayName(uid)}: ${cnt} رسالة فقط`)
      .join("\n");

    // Pick a random punishment
    const punishments = [
      "🔇 *العقوبة:* المجموعة مفتوحة 24 ساعة — الكل يقدر يزرف بحرية!",
      "💸 *العقوبة:* خصم 5,000 ريال من رصيد كل مشارك خامل!",
      "👺 *العقوبة:* أقل 3 مشاركين ملعونون ومكتومون بكرة!",
      "😔 *العقوبة:* الجائزة تنقص 10,000 ريال في اليوم القادم!",
    ];
    const punishment = punishments[Math.floor(Math.random() * punishments.length)]!;

    state.active = false;
    await save();

    await api.sendMessage(state.chatId,
      `💀 *فشلتم في اليوم ${state.day}!*\n\n` +
      `❌ أرسلتم *${total}* فقط (المطلوب ${target})\n` +
      `📉 الناقص: *${shortfall} رسالة*\n\n` +
      `😴 *الأقل نشاطاً:*\n${lowestList || "ما أحد شارك!"}\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `${punishment}\n\n` +
      `_أعد التحدي بـ_ \`تحدي ابدأ\` _لمحاولة جديدة_`,
      { parse_mode: "Markdown" },
    );
  }
}

// ── Resume after restart ──────────────────────────────────────────────────
export function resumeIfActive(api: Bot["api"]) {
  if (!state.active) return;
  logger.info({ day: state.day }, "Resuming active challenge");
  scheduleEndCheck(api);
}
