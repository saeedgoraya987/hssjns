// ---- WebCrypto polyfill ----
import { webcrypto } from "crypto";
globalThis.crypto = webcrypto;

// ---- Imports ----
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import pLimit from "p-limit";

import { getOrCreateSession } from "./waSessionManager.js";
import { normalizeNumber, toJid } from "./utils.js";

const bot = new TelegramBot(process.env.TG_TOKEN, { polling: true });
const limit = pLimit(10);

console.log("🤖 Telegram bot started");

// ---------- /start ----------
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

// ---------- /pair ----------
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
    return bot.sendMessage(chatId, "❌ Failed to create session");
  }

  if (session.connected) {
    return bot.sendMessage(chatId, "⚠️ Already linked. Use /logout first.");
  }

  // ⏳ allow socket to initialize
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const code = await session.sock.requestPairingCode(
      number.replace(/\D/g, "")
    );

    await bot.sendMessage(
      chatId,
      `📱 *Pairing Code*

WhatsApp → Linked Devices → Link with phone number

*${code}*`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("PAIR ERROR:", err);
    await bot.sendMessage(
      chatId,
      "❌ Pairing failed.\n\nUse:\n/logout\nthen try again."
    );
  }
});

// ---------- /check ----------
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
    const r = await session.sock.onWhatsApp(toJid(number));
    const exists = r?.[0]?.exists;
    bot.sendMessage(chatId, exists ? "✅ On WhatsApp" : "❌ Not on WhatsApp");
  } catch {
    bot.sendMessage(chatId, "❌ Check failed");
  }
});

// ---------- /logout ----------
bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  try {
    await fs.promises.rm(`sessions/${userId}`, {
      recursive: true,
      force: true
    });
  } catch {}

  bot.sendMessage(chatId, "✅ Logged out. Use /pair again.");
});
