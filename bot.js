// ================================
// WebCrypto polyfill (REQUIRED)
// ================================
import { webcrypto } from "crypto";
globalThis.crypto = webcrypto;

// ================================
// Imports
// ================================
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";

import { getOrCreateSession } from "./waSessionManager.js";
import { normalizeNumber, toJid } from "./utils.js";

// ================================
// ⚠️ TEMP TOKEN PLACEHOLDER
// ================================
// CHANGE THIS STRING TO YOUR REAL TOKEN LATER
const BOT_TOKEN = "8473295403:AAHByeYr00mJgx3GxlULrID09Kc-hiLKG0k";

// Safety check so it doesn't silently fail
if (BOT_TOKEN.includes("REPLACE_WITH")) {
  console.log("⚠️ Using placeholder Telegram token");
}

// ================================
// Telegram Bot Init
// ================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on("polling_error", (err) => {
  console.error("🚨 POLLING ERROR:", err.message);
});

console.log("🤖 Telegram bot started");

// ================================
// /start
// ================================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🤖 *WhatsApp Checker Bot*

/pair <number> – Link WhatsApp
/check <number> – Check number
/logout – Logout WhatsApp`,
    { parse_mode: "Markdown" }
  );
});

// ================================
// /pair <number>
// ================================
bot.onText(/\/pair (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const number = normalizeNumber(match[1]);
  if (!number) {
    return bot.sendMessage(chatId, "❌ Invalid phone number");
  }

  const session = await getOrCreateSession(userId);

  if (session.connected) {
    return bot.sendMessage(chatId, "⚠️ Already linked. Use /logout.");
  }

  await new Promise((r) => setTimeout(r, 1500));

  try {
    const code = await session.sock.requestPairingCode(
      number.replace(/\D/g, "")
    );

    bot.sendMessage(
      chatId,
      `📱 *Pairing Code*

WhatsApp → Linked Devices → Link with phone number

*${code}*`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, "❌ Pairing failed. Use /logout and try again.");
  }
});

// ================================
// /check <number>
// ================================
bot.onText(/\/check (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const number = normalizeNumber(match[1]);
  if (!number) return bot.sendMessage(chatId, "❌ Invalid number");

  const session = await getOrCreateSession(userId);
  if (!session.connected) {
    return bot.sendMessage(chatId, "❌ WhatsApp not linked");
  }

  const r = await session.sock.onWhatsApp(toJid(number));
  const exists = r?.[0]?.exists;

  bot.sendMessage(chatId, exists ? "✅ On WhatsApp" : "❌ Not on WhatsApp");
});

// ================================
// /logout
// ================================
bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  await fs.promises.rm(`sessions/${userId}`, {
    recursive: true,
    force: true
  });

  bot.sendMessage(chatId, "✅ Logged out");
});
