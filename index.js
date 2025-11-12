import { webcrypto } from "crypto";
globalThis.crypto = webcrypto;

import TelegramBot from "node-telegram-bot-api";
import * as baileys from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

const TELEGRAM_TOKEN = "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc";
if (!TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_TOKEN");

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const sessions = {};
const getSessionPath = (userId) => path.join("./sessions", String(userId));

async function startWhatsApp(userId) {
  const sessionDir = getSessionPath(userId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    browser: ["TelegramBot", "Chrome", "1.0"]
  });

  sessions[userId] = { sock, connected: false, qr: null };
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, qr, lastDisconnect } = u;

    if (qr) {
      const qrPng = await QRCode.toDataURL(qr, { width: 300 });
      await bot.sendPhoto(userId, qrPng, {
        caption:
          "📱 Scan this QR from WhatsApp → *Linked Devices* → *Link a device*",
        parse_mode: "Markdown"
      });
      sessions[userId].qr = qr;
    }

    if (connection === "open") {
      sessions[userId].connected = true;
      sessions[userId].qr = null;
      bot.sendMessage(userId, "✅ WhatsApp connected successfully!");
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      sessions[userId].connected = false;
      if (code === DisconnectReason.loggedOut || code === 401) {
        bot.sendMessage(userId, "⚠️ Logged out. Use /login again.");
        fs.rmSync(sessionDir, { recursive: true, force: true });
        delete sessions[userId];
      } else {
        bot.sendMessage(userId, "🔁 Connection closed. Reconnecting...");
        setTimeout(() => startWhatsApp(userId).catch(console.error), 4000);
      }
    }
  });
}

// ---------- Telegram Commands ----------

bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "user";
  bot.sendMessage(
    msg.chat.id,
    `👋 Welcome, ${name}!
Each Telegram user gets a private WhatsApp session.

Commands:
/login – Get QR to link WhatsApp
/status – Check WhatsApp connection
/check <number> – Check if number exists
/send <number> <text> – Send WhatsApp message
/logout – Unlink & delete session`
  );
});

// /login
bot.onText(/\/login/, async (msg) => {
  const userId = msg.chat.id;
  try {
    await startWhatsApp(userId);
  } catch (e) {
    bot.sendMessage(userId, "❌ " + e.message);
  }
});

// /status
bot.onText(/\/status/, (msg) => {
  const userId = msg.chat.id;
  const s = sessions[userId];
  if (!s) return bot.sendMessage(userId, "ℹ️ No session yet. Use /login.");
  bot.sendMessage(
    userId,
    s.connected ? "✅ WhatsApp connected." : "⏳ Waiting for QR scan / reconnecting..."
  );
});

// /check
bot.onText(/\/check (.+)/, async (msg, match) => {
  const userId = msg.chat.id;
  const s = sessions[userId];
  if (!s || !s.connected)
    return bot.sendMessage(userId, "❌ Not connected. Use /login first.");

  const number = match[1].trim().replace(/[^\d+]/g, "");
  try {
    const res = await s.sock.onWhatsApp(number.replace(/\D/g, "") + "@s.whatsapp.net");
    const exists = Array.isArray(res) && res[0]?.exists;
    bot.sendMessage(userId, exists ? "✅ Number has WhatsApp." : "❌ Number not on WhatsApp.");
  } catch (e) {
    bot.sendMessage(userId, "⚠️ Error checking number: " + e.message);
  }
});

// /send
bot.onText(/\/send ([^\s]+) (.+)/, async (msg, match) => {
  const userId = msg.chat.id;
  const s = sessions[userId];
  if (!s || !s.connected)
    return bot.sendMessage(userId, "❌ Not connected. Use /login first.");

  const number = match[1].trim().replace(/[^\d+]/g, "");
  const text = match[2];
  try {
    await s.sock.sendMessage(number.replace(/\D/g, "") + "@s.whatsapp.net", { text });
    bot.sendMessage(userId, "📤 Message sent successfully!");
  } catch (e) {
    bot.sendMessage(userId, "⚠️ Send error: " + e.message);
  }
});

// /logout
bot.onText(/\/logout/, async (msg) => {
  const userId = msg.chat.id;
  const s = sessions[userId];
  if (!s) return bot.sendMessage(userId, "ℹ️ No active session.");
  try {
    await s.sock.logout();
    fs.rmSync(getSessionPath(userId), { recursive: true, force: true });
    delete sessions[userId];
    bot.sendMessage(userId, "👋 Logged out and session deleted.");
  } catch (e) {
    bot.sendMessage(userId, "⚠️ Logout error: " + e.message);
  }
});

console.log("🤖 Telegram WhatsApp bot (QR login) running...");
