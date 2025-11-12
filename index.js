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

const TELEGRAM_TOKEN = "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc";
if (!TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_TOKEN environment variable.");

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// -------- store WhatsApp sessions --------
const sessions = {}; // userId → { sock, pairingCode, connected }

const getSessionPath = (userId) => path.join("./sessions", String(userId));

// -------- WhatsApp session handler --------
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

  sessions[userId] = { sock, pairingCode: null, connected: false };
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect } = u;

    if (connection === "open") {
      sessions[userId].connected = true;
      sessions[userId].pairingCode = null;
      bot.sendMessage(userId, "✅ WhatsApp connected successfully!");
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      sessions[userId].connected = false;
      if (code === DisconnectReason.loggedOut) {
        bot.sendMessage(userId, "⚠️ You were logged out. Send /login again to re-link WhatsApp.");
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  });

  // request pairing code if not already linked
  if (!sock.authState.creds?.registered) {
    if (!phoneNumber) throw new Error("Phone number required for pairing code session.");
    const code = await sock.requestPairingCode(phoneNumber.replace(/\+/g, ""));
    sessions[userId].pairingCode = code;
    bot.sendMessage(
      userId,
      `🔗 *Your WhatsApp pairing code:* \`${code}\`\n\nOpen WhatsApp → *Linked Devices* → *Link with phone number* and enter this code.`,
      { parse_mode: "Markdown" }
    );
  } else {
    sessions[userId].connected = true;
    bot.sendMessage(userId, "✅ Already linked with WhatsApp!");
  }

  return sessions[userId];
}

// -------- Telegram Commands --------

// /start
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "user";
  bot.sendMessage(
    msg.chat.id,
    `👋 Welcome, ${name}!
Each Telegram user gets a private WhatsApp session.

Commands:
/login <phone> — Link your WhatsApp (get pairing code)
/status — Check if you're connected
/check <number> — Check if a number has WhatsApp
/send <number> <text> — Send WhatsApp message
/logout — Unlink and delete your WhatsApp session`
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
    bot.sendMessage(userId, "❌ Error: " + e.message);
  }
});

// /status
bot.onText(/\/status/, async (msg) => {
  const userId = msg.chat.id;
  const s = sessions[userId];
  if (!s)
    return bot.sendMessage(userId, "You haven't linked WhatsApp yet. Use /login <phone>");
  if (s.connected) bot.sendMessage(userId, "✅ WhatsApp connected and active!");
  else bot.sendMessage(userId, "⏳ Not connected yet, please wait or re-login.");
});

// /check <number>
bot.onText(/\/check (.+)/, async (msg, match) => {
  const userId = msg.chat.id;
  const s = sessions[userId];
  if (!s || !s.connected)
    return bot.sendMessage(userId, "❌ Not connected to WhatsApp. Use /login first.");

  const number = match[1].trim().replace(/[^\d+]/g, "");
  try {
    const result = await s.sock.onWhatsApp(number.replace(/\D/g, "") + "@s.whatsapp.net");
    const exists = Array.isArray(result) && result[0]?.exists;
    bot.sendMessage(userId, exists ? "✅ Number has WhatsApp." : "❌ Number not on WhatsApp.");
  } catch (e) {
    bot.sendMessage(userId, "⚠️ Error checking number: " + e.message);
  }
});

// /send <number> <message>
bot.onText(/\/send (.+) (.+)/, async (msg, match) => {
  const userId = msg.chat.id;
  const s = sessions[userId];
  if (!s || !s.connected)
    return bot.sendMessage(userId, "❌ Not connected to WhatsApp. Use /login first.");

  const number = match[1].trim().replace(/[^\d+]/g, "");
  const text = match[2];
  try {
    await s.sock.sendMessage(number.replace(/\D/g, "") + "@s.whatsapp.net", { text });
    bot.sendMessage(userId, "📤 Message sent successfully!");
  } catch (e) {
    bot.sendMessage(userId, "⚠️ Error sending message: " + e.message);
  }
});

// /logout
bot.onText(/\/logout/, async (msg) => {
  const userId = msg.chat.id;
  const s = sessions[userId];
  if (!s)
    return bot.sendMessage(userId, "No active WhatsApp session found.");

  try {
    await s.sock.logout();
    fs.rmSync(getSessionPath(userId), { recursive: true, force: true });
    delete sessions[userId];
    bot.sendMessage(userId, "👋 Logged out and session deleted.");
  } catch (e) {
    bot.sendMessage(userId, "⚠️ Error logging out: " + e.message);
  }
});

console.log("🤖 Telegram WhatsApp bot is running...");
