// --- Fix crypto not defined on some hosts ---
import { webcrypto } from "crypto";
globalThis.crypto = webcrypto;

// --- Imports ---
import TelegramBot from "node-telegram-bot-api";
import * as baileys from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

// --- Telegram token ---
const TELEGRAM_TOKEN = "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc";
if (!TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_TOKEN in environment.");

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// --- Session management ---
const sessions = {}; // userId -> { sock, connected, pairingCode }
const getSessionPath = (userId) => path.join("./sessions", String(userId));

// --- WhatsApp session starter ---
async function startWhatsApp(userId, phoneNumber) {
  const sessionDir = getSessionPath(userId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    browser: ["TelegramBot", "Chrome", "1.0"],
    auth: state
  });

  sessions[userId] = { sock, connected: false, pairingCode: null };
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    const code = lastDisconnect?.error?.output?.statusCode;

    if (connection === "open") {
      sessions[userId].connected = true;
      sessions[userId].pairingCode = null;
      bot.sendMessage(userId, "✅ WhatsApp connected successfully!");
    } else if (connection === "close") {
      sessions[userId].connected = false;
      console.log(`❌ [${userId}] Connection closed:`, code);

      if (code === DisconnectReason.loggedOut || code === 401) {
        bot.sendMessage(userId, "⚠️ WhatsApp logged out. Please use /login again.");
        fs.rmSync(sessionDir, { recursive: true, force: true });
        delete sessions[userId];
      } else {
        bot.sendMessage(userId, "🔁 Connection lost, trying to reconnect...");
        setTimeout(() => startWhatsApp(userId, phoneNumber).catch(console.error), 4000);
      }
    }
  });

  // --- Generate pairing code if needed ---
  if (!sock.authState.creds?.registered) {
    if (!phoneNumber) throw new Error("Phone number required for pairing.");
    const code = await sock.requestPairingCode(phoneNumber.replace(/\+/g, ""));
    sessions[userId].pairingCode = code;
    bot.sendMessage(
      userId,
      `🔗 *Your WhatsApp Pairing Code:* \`${code}\`\n\nOpen WhatsApp → *Linked Devices* → *Link with phone number* → enter this code.`,
      { parse_mode: "Markdown" }
    );
  } else {
    sessions[userId].connected = true;
    bot.sendMessage(userId, "✅ Already linked with WhatsApp!");
  }

  return sessions[userId];
}

// --- Telegram Commands ---

bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "user";
  bot.sendMessage(
    msg.chat.id,
    `👋 Welcome, ${name}!\nEach Telegram user gets a private WhatsApp session.\n\n` +
      `Commands:\n` +
      `/login <phone> – Link WhatsApp (get pairing code)\n` +
      `/status – Check WhatsApp connection\n` +
      `/check <number> – Check if number exists on WhatsApp\n` +
      `/send <number> <text> – Send WhatsApp message\n` +
      `/logout – Unlink & delete session\n` +
      `/reset – Force-delete your WhatsApp session folder (no shell needed)`
  );
});

// /login <phone>
bot.onText(/\/login (.+)/, async (msg, match) => {
  const userId = msg.chat.id;
  const phone = match[1].trim();

  try {
    await startWhatsApp(userId, phone);
  } catch (e) {
    console.error(e);
    bot.sendMessage(userId, "❌ " + e.message);
  }
});

// /status
bot.onText(/\/status/, (msg) => {
  const userId = msg.chat.id;
  const s = sessions[userId];
  if (!s)
    return bot.sendMessage(userId, "ℹ️ No active WhatsApp session. Use /login <phone>");
  bot.sendMessage(
    userId,
    s.connected ? "✅ WhatsApp connected and active." : "⏳ Not connected yet or reconnecting..."
  );
});

// /check <number>
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

// /send <number> <message>
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
  if (!s) return bot.sendMessage(userId, "ℹ️ No session to log out.");

  try {
    await s.sock.logout();
    fs.rmSync(getSessionPath(userId), { recursive: true, force: true });
    delete sessions[userId];
    bot.sendMessage(userId, "👋 Logged out and session deleted.");
  } catch (e) {
    bot.sendMessage(userId, "⚠️ Logout error: " + e.message);
  }
});

// /reset  →  delete user’s session folder directly
bot.onText(/\/reset/, async (msg) => {
  const userId = msg.chat.id;
  const dir = getSessionPath(userId);

  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      delete sessions[userId];
      await bot.sendMessage(
        userId,
        "🧹 Session data deleted. Now run /login +<your phone> to generate a new pairing code."
      );
    } else {
      await bot.sendMessage(userId, "ℹ️ No saved session folder found for you.");
    }
  } catch (err) {
    await bot.sendMessage(userId, "❌ Error clearing session: " + err.message);
  }
});

console.log("🤖 Telegram WhatsApp bot running...");
