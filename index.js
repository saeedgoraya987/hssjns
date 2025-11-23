// index.js
// MULTI-SESSION WHATSAPP BOT (PAIRING CODE) — FINAL FIXED VERSION
// Baileys v6.7.8 + Telegram + Multi Sessions + No QR + Stable Imports

//-------------------------------------------------------------//
// REQUIRED FIX FOR NODE 18/20 (Railway uses this)
//-------------------------------------------------------------//
import { webcrypto } from "crypto";
globalThis.crypto = webcrypto;

//-------------------------------------------------------------//
// BAILEYS IMPORT (THE ONLY CORRECT ONE FOR V6.7.8)
//-------------------------------------------------------------//
import * as baileys from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = baileys;

//-------------------------------------------------------------//
import P from "pino";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import TelegramBot from "node-telegram-bot-api";
import { parse as csvParse } from "csv-parse/sync";

//-------------------------------------------------------------//
// CONFIG
//-------------------------------------------------------------//
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import "dotenv/config";

const TG_TOKEN = "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc";
if (!TG_TOKEN) throw new Error("Missing TG_TOKEN in .env");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const MAIN_CHANNEL = process.env.MAIN_CHANNEL || "@OPxOTP";
const BACKUP_CHANNEL = process.env.BACKUP_CHANNEL || "@OPxOTPChat";
const PORT = process.env.PORT || 8000;

const SESSIONS_DIR = path.join(__dirname, "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// rate limits
const LIMITS = {
  windowMs: 24 * 60 * 60 * 1000,
  maxChecksPerWindow: 200,
  cooldownMs: 2000
};

const sessions = {}; // userId -> session info
const usage = {};    // rate limit buckets

//-------------------------------------------------------------//
// HELPERS
//-------------------------------------------------------------//
function normalizeNumberRaw(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[()\s-]/g, "");
  return /^\+?\d{7,20}$/.test(s) ? s : null;
}

function nowMs() { return Date.now(); }

function ensureUsageBucket(userId) {
  const u = usage[userId];
  const t = nowMs();
  if (!u || (t - u.windowStart) > LIMITS.windowMs) {
    usage[userId] = { windowStart: t, count: 0, lastCheckAt: 0 };
  }
  return usage[userId];
}

function rateLimitAllow(userId) {
  const u = ensureUsageBucket(userId);
  const t = nowMs();
  if (t - u.lastCheckAt < LIMITS.cooldownMs) return { ok: false, reason: "slow_down" };
  if (u.count >= LIMITS.maxChecksPerWindow) return { ok: false, reason: "limit_reached" };
  return { ok: true };
}

function rateLimitRecord(userId) {
  const u = ensureUsageBucket(userId);
  u.count++;
  u.lastCheckAt = nowMs();
}

async function fetchBufferFromUrl(url) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith("https") ? https : http;
      lib.get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }).on("error", () => resolve(null));
    } catch (e) { resolve(null); }
  });
}

//-------------------------------------------------------------//
// CREATE SESSION (PAIRING CODE MODE)
//-------------------------------------------------------------//
async function createSession(userId, phoneDigits) {
  if (sessions[userId] && sessions[userId].sock) return sessions[userId];

  const sessionFolder = path.join(SESSIONS_DIR, `user_${userId}`);
  fs.mkdirSync(sessionFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestBaileysVersion();

  const auth = {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" }))
  };

  const sock = makeWASocket({
    version,
    auth,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Safari"),
    syncFullHistory: false
  });

  sessions[userId] = {
    sock,
    pairingCode: null,
    pairingError: null,
    connected: false,
    sessionId: `user_${userId}`
  };

  sock.ev.on("creds.update", saveCreds);

  //-------------------------------------------------------------//
  // REQUEST PAIRING CODE (DIGITS ONLY)
  //-------------------------------------------------------------//
  try {
    if (!state.creds.registered && phoneDigits) {
      const digits = String(phoneDigits).replace(/\D/g, "");
      const code = await sock.requestPairingCode(digits);
      sessions[userId].pairingCode = code;
      console.log(`[${userId}] Pairing code: ${code}`);
    }
  } catch (e) {
    sessions[userId].pairingError = e.message;
    console.log(`[${userId}] Pairing code error:`, e);
  }

  //-------------------------------------------------------------//
  // CONNECTION HANDLER
  //-------------------------------------------------------------//
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    const code = lastDisconnect?.error?.output?.statusCode;

    if (connection === "open") {
      sessions[userId].connected = true;
      console.log(`[${userId}] WhatsApp connected`);
    }

    if (connection === "close") {
      console.log(`[${userId}] Disconnected:`, code);

      if (code === DisconnectReason.loggedOut || code === 401) {
        try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch {}
        delete sessions[userId];
        console.log(`[${userId}] Logged out. Session removed.`);
      } else {
        setTimeout(() => createSession(userId).catch(() => {}), 2000);
      }
    }
  });

  return sessions[userId];
}

//-------------------------------------------------------------//
// FETCH WHATSAPP PROFILE
//-------------------------------------------------------------//
async function fetchContactInfo(sock, number) {
  const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
  const out = { exists: false, name: null, profilePic: null };

  try {
    const r = await sock.onWhatsApp(jid);
    out.exists = Array.isArray(r) && r[0] ? Boolean(r[0].exists) : false;
    if (!out.exists) return out;

    try { out.name = await sock.getName(jid); } catch {}
    try {
      const url = await sock.profilePictureUrl(jid, "image").catch(() => null);
      if (url) {
        const buf = await fetchBufferFromUrl(url);
        if (buf) out.profilePic = `data:image/jpeg;base64,${buf.toString("base64")}`;
      }
    } catch {}
    return out;
  } catch {
    return out;
  }
}

//-------------------------------------------------------------//
// EXPRESS SERVER
//-------------------------------------------------------------//
const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

//-------------------------------------------------------------//
// TELEGRAM BOT
//-------------------------------------------------------------//
const bot = new TelegramBot(TG_TOKEN, { polling: true });

//---------- Force Join ----------
async function isUserJoined(uid) {
  try {
    const a = await bot.getChatMember(MAIN_CHANNEL, uid).catch(() => null);
    const b = await bot.getChatMember(BACKUP_CHANNEL, uid).catch(() => null);
    const okA = a && ["member", "administrator", "creator"].includes(a.status);
    const okB = b && ["member", "administrator", "creator"].includes(b.status);
    return okA && okB;
  } catch {
    return false;
  }
}

function showForceJoin(uid) {
  bot.sendMessage(uid,
    "⚠️ You must join both channels to use the bot.",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Main Channel", url: `https://t.me/${MAIN_CHANNEL.replace("@", "")}` }],
          [{ text: "Backup Channel", url: `https://t.me/${BACKUP_CHANNEL.replace("@", "")}` }],
          [{ text: "I Joined", callback_data: "joined_check" }]
        ]
      }
    });
}

bot.on("callback_query", async (q) => {
  if (q.data === "joined_check") {
    const ok = await isUserJoined(q.from.id);
    if (ok) bot.sendMessage(q.from.id, "✅ Verified. Use /login <digits>");
    else showForceJoin(q.from.id);
  }
});

//-------------------------------------------------------------//
// COMMANDS
//-------------------------------------------------------------//
bot.onText(/\/start/, async (msg) => {
  const uid = msg.from.id;
  if (!(await isUserJoined(uid))) return showForceJoin(uid);
  bot.sendMessage(uid, "Welcome! Use /login <digits> to link WhatsApp.");
});

// /login <digits>
bot.onText(/\/login (.+)/, async (msg, match) => {
  const uid = msg.from.id;
  const digits = match[1].trim().replace(/\D/g, "");
  if (!/^\d{7,20}$/.test(digits)) return bot.sendMessage(uid, "❌ Invalid digits. Use: 923001234567");

  if (!(await isUserJoined(uid))) return showForceJoin(uid);

  const ses = await createSession(uid, digits);

  if (ses.pairingCode) {
    bot.sendMessage(uid, `🔑 Pairing Code:\n\n*${ses.pairingCode}*\n\nEnter on WhatsApp → Link with phone number`, { parse_mode: "Markdown" });
  } else if (ses.pairingError) {
    bot.sendMessage(uid, `❌ Error: ${ses.pairingError}`);
  } else if (ses.connected) {
    bot.sendMessage(uid, "✅ Already connected.");
  } else {
    bot.sendMessage(uid, "⏳ Try again in a moment.");
  }
});

// /status
bot.onText(/\/status/, (msg) => {
  const uid = msg.from.id;
  if (!sessions[uid]) return bot.sendMessage(uid, "No session.");
  bot.sendMessage(uid, sessions[uid].connected ? "✅ Connected" : "❌ Not connected");
});

// /check
bot.onText(/\/check (.+)/, async (msg, match) => {
  const uid = msg.from.id;
  if (!sessions[uid] || !sessions[uid].connected) return bot.sendMessage(uid, "❌ Not connected.");

  const number = normalizeNumberRaw(match[1]);
  if (!number) return bot.sendMessage(uid, "❌ Invalid number.");

  const info = await fetchContactInfo(sessions[uid].sock, number);

  if (!info.exists) return bot.sendMessage(uid, "❌ Not on WhatsApp");

  let txt = `✅ WhatsApp User\nNumber: ${number}\n`;
  if (info.name) txt += `Name: ${info.name}\n`;

  if (info.profilePic) {
    return bot.sendPhoto(uid, info.profilePic, { caption: txt });
  }

  bot.sendMessage(uid, txt);
});

// /logout
bot.onText(/\/logout/, async (msg) => {
  const uid = msg.from.id;
  const dir = path.join(SESSIONS_DIR, `user_${uid}`);

  if (sessions[uid]) {
    try { await sessions[uid].sock.logout(); } catch {}
    delete sessions[uid];
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  bot.sendMessage(uid, "👋 Logged out.");
});

console.log("BOT READY — Pairing Code Multi-Session v6.7.8");
