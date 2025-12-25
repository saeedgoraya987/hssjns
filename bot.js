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
import pLimit from "p-limit";

import { getOrCreateSession } from "./waSessionManager.js";
import { normalizeNumber, toJid } from "./utils.js";

// ================================
// Telegram Bot Init (POLLING SAFE)
// ================================
if (!process.env.TG_TOKEN) {
  console.error("❌ TG_TOKEN is missing");
  process.exit(1);
}

const bot = new TelegramBot(process.env.TG_TOKEN, {
  polling: true
});

// Log polling errors (IMPORTANT)
bot.on("polling_error", (err) => {
  console.error("🚨 POLLING ERROR:", err.message);
});

console.log("🤖 Telegram bot started");

const limit = pLimit(10);

// ================================
// /start
// ================================
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `🤖 *WhatsApp Checker Bot*

/pair <number> – Link WhatsApp
/check <number> – Check number
/logout – Logout WhatsApp

Each user has their own WhatsApp.`,
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

  let session;
  try {
    session = await getOrCreateSession(userId);
  } catch {
    return bot.sendMessage(chatId, "❌ Failed to create WhatsApp session");
  }

  if (session.connected) {
    return bot.sendMessage(
      chatId,
      "⚠️ WhatsApp already linked.\nUse /logout first."
    );
  }

  // Allow socket to initialize
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const code = await session.sock.requestPairingCode(
      number.replace(/\D/g, "")
    );

    await bot.sendMessage(
      chatId,
      `📱 *WhatsApp Pairing Code*

Open WhatsApp → Linked Devices  
Tap *Link with phone number*  
Enter this code:

*${code}*`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("PAIR ERROR:", err);
    await bot.sendMessage(
      chatId,
      "❌ Pairing failed.\n\n" +
      "1️⃣ Send /logout\n" +
      "2️⃣ Wait 10 seconds\n" +
      "3️⃣ Try /pair again"
    );
  }
});

// ================================
// /check <number>
// ================================
bot.onText(/\/check (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const number = normalizeNumber(match[1]);
  if (!number) {
    return bot.sendMessage(chatId, "❌ Invalid number");
  }

  const session = await getOrCreateSession(userId);
  if (!session.connected) {
    return bot.sendMessage(chatId, "❌ WhatsApp not linked. Use /pair");
  }

  try {
    const res = await session.sock.onWhatsApp(toJid(number));
    const exists = res?.[0]?.exists;
    await bot.sendMessage(
      chatId,
      exists ? "✅ Number is on WhatsApp" : "❌ Not on WhatsApp"
    );
  } catch (err) {
    console.error("CHECK ERROR:", err);
    await bot.sendMessage(chatId, "❌ Check failed");
  }
});

// ================================
// /logout
// ================================
bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  try {
    await fs.promises.rm(`sessions/${userId}`, {
      recursive: true,
      force: true
    });
  } catch {}

  await bot.sendMessage(
    chatId,
    "✅ Logged out.\nYou can now use /pair again."
  );
});
