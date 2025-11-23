// index.js
// Multi-session Telegram + WhatsApp pairing-code bot
// Uses Baileys pairing (digits-only phone input) + makeCacheableSignalKeyStore + Browsers.macOS("Safari")

// --- Fix webcrypto for some hosts (Node >=18) ---
import { webcrypto } from "crypto";
globalThis.crypto = webcrypto;

// --- Imports ---
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from "@whiskeysockets/baileys";

import P from "pino";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";
import TelegramBot from "node-telegram-bot-api";
import { parse as csvParse } from "csv-parse/sync";

// -------------------- CONFIG --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TG_TOKEN = "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc";
if (!TG_TOKEN) throw new Error("Missing TG_TOKEN env var (set your Telegram bot token).");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const MAIN_CHANNEL = process.env.MAIN_CHANNEL || "@OPxOTP";
const BACKUP_CHANNEL = process.env.BACKUP_CHANNEL || "@OPxOTPChat";

const PORT = parseInt(process.env.PORT || "8000", 10);
const SESSIONS_DIR = path.join(__dirname, "sessions");

// Rate-limits & settings
const LIMITS = {
  windowMs: 24 * 60 * 60 * 1000,
  maxChecksPerWindow: 200,
  cooldownMs: 2000
};

// Ensure session dir exists
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// In-memory
const sessions = {}; // userId => { sock, pairingCode, pairingError, connected, sessionId, createdAt }
const usage = {};    // rate-limit buckets

// -------------------- HELPERS --------------------
function normalizeNumberRaw(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[()\s-]/g, "");
  return /^\+?\d{7,20}$/.test(s) ? s : null; // allow + optional but we expect digits-only for pairing
}
function nowMs(){ return Date.now(); }

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
function getSessionPath(userId) {
  return path.join(SESSIONS_DIR, `user_${userId}`);
}

async function fetchBufferFromUrl(url) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith("https") ? https : http;
      lib.get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", () => resolve(null));
      }).on("error", () => resolve(null));
    } catch (e) { resolve(null); }
  });
}

// -------------------- CREATE SESSION (pairing-mode) --------------------
/**
 * createSession(userId, phoneDigitsOptional)
 * phoneDigitsOptional = digits-only string like "923001234567" if caller wants to request pairing
 */
async function createSession(userId, phoneDigitsOptional) {
  // return if exists
  if (sessions[userId] && sessions[userId].sock) return sessions[userId];

  const sessionId = `user_${userId}`;
  const sessionDir = getSessionPath(userId);
  fs.mkdirSync(sessionDir, { recursive: true });

  // useMultiFileAuthState stores creds under sessionDir
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  // Build auth with cached key store (anti-bad-mac)
  const auth = {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" }))
  };

  const sock = makeWASocket({
    version,
    auth,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    browser: Browsers.macOS("Safari"),
    syncFullHistory: false,
    connectTimeoutMs: 30_000
  });

  // skeleton
  sessions[userId] = {
    sock,
    pairingCode: null,
    pairingError: null,
    connected: false,
    sessionId,
    createdAt: Date.now()
  };

  // persist creds
  sock.ev.on("creds.update", saveCreds);

  // connection handling
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    const code = lastDisconnect?.error?.output?.statusCode;

    if (connection === "open") {
      sessions[userId].connected = true;
      sessions[userId].pairingCode = null;
      sessions[userId].pairingError = null;
      console.log(`[${userId}] WhatsApp connected`);
      // notify the user (bot exists when invoked later)
      try { bot.sendMessage(Number(userId), "✅ WhatsApp connected successfully!"); } catch (e) {}
    }

    if (connection === "close") {
      sessions[userId].connected = false;
      console.log(`[${userId}] WhatsApp disconnected:`, code);

      if (code === DisconnectReason.loggedOut || code === 401) {
        // remove session files to allow fresh re-link
        console.log(`[${userId}] logged out — deleting auth files`);
        try { if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { console.warn(e); }
        delete sessions[userId];
        try { bot.sendMessage(Number(userId), "⚠️ Your WhatsApp session was logged out. Use /login to re-link."); } catch(e){}
      } else {
        // transient: attempt reconnect
        setTimeout(() => createSession(userId).catch(err => console.error("reconnect fail", err)), 2500);
      }
    }
  });

  // keep alive event handlers
  sock.ev.on("messages.upsert", () => {});
  sock.ev.on("chats.update", () => {});
  sock.ev.on("contacts.update", () => {});

  // store sock
  sessions[userId].sock = sock;

  // If not registered and phoneDigits provided, request pairing code
  try {
    const registered = sock.authState?.creds?.registered;
    if (!registered && phoneDigitsOptional) {
      // phoneDigitsOptional should already be digits-only. For safety:
      const digits = String(phoneDigitsOptional).replace(/\D/g, "");
      if (!/^\d{7,20}$/.test(digits)) throw new Error("invalid phone digits for pairing");
      // requestPairingCode exists in Baileys 6.x
      const code = await sock.requestPairingCode(digits);
      sessions[userId].pairingCode = code;
      console.log(`[${userId}] pairing code requested for ${digits}: ${code}`);
    }
  } catch (e) {
    console.warn(`[${userId}] pairing request failed:`, e?.message || e);
    sessions[userId].pairingError = e?.message || String(e || "");
  }

  return sessions[userId];
}

// -------------------- fetchContactInfo --------------------
async function fetchContactInfo(sock, number) {
  const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
  const out = { exists: false, name: null, profilePic: null };
  try {
    const r = await sock.onWhatsApp(jid);
    out.exists = Array.isArray(r) && r[0] ? Boolean(r[0].exists) : false;
    if (!out.exists) return out;

    try { if (typeof sock.getName === "function") out.name = await sock.getName(jid); } catch(e){ out.name = null; }

    try {
      if (typeof sock.profilePictureUrl === "function") {
        const url = await sock.profilePictureUrl(jid, "image").catch(()=>null);
        if (url) {
          const imgBuf = await fetchBufferFromUrl(url);
          if (imgBuf) out.profilePic = `data:image/jpeg;base64,${imgBuf.toString("base64")}`;
        }
      }
    } catch(e){ out.profilePic = null; }

    return out;
  } catch (e) {
    return out;
  }
}

// -------------------- EXPRESS (admin + api) --------------------
const app = express();
app.use(cors());
app.use(express.json());

function requireAdmin(req, res, next) {
  const pass = req.headers["x-admin-pass"] || req.query?.admin || "";
  if (pass === ADMIN_PASSWORD) return next();
  res.status(401).send("Unauthorized");
}

app.get("/admin", requireAdmin, (req, res) => {
  const list = Object.keys(sessions).map(uid => {
    const s = sessions[uid];
    const u = usage[uid] || { windowStart: 0, count: 0, lastCheckAt: 0 };
    return { userId: uid, sessionId: s.sessionId, connected: Boolean(s.connected), usageCount: u.count, usageWindowStart: u.windowStart };
  });
  res.send(`<html><body><pre>${JSON.stringify(list,null,2)}</pre></body></html>`);
});

app.get("/admin/logout", requireAdmin, async (req, res) => {
  const user = String(req.query.user || "");
  if (!user || !sessions[user]) return res.status(404).send("No session");
  try { await sessions[user].sock.logout().catch(()=>{}); } catch(e){}
  delete sessions[user];
  const dir = getSessionPath(user);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.redirect(`/admin?admin=${ADMIN_PASSWORD}`);
});

app.post("/api/check", express.json(), async (req, res) => {
  const { userId, number } = req.body || {};
  if (!userId || !number) return res.status(422).json({ error: "userId and number required" });

  const uid = String(userId);
  const normalized = normalizeNumberRaw(number);
  if (!normalized) return res.status(422).json({ error: "invalid number" });

  const rl = rateLimitAllow(uid);
  if (!rl.ok) {
    if (rl.reason === "slow_down") return res.status(429).json({ error: "slow_down" });
    return res.status(429).json({ error: "limit_reached" });
  }

  let ses = sessions[uid];
  if (!ses) ses = await createSession(uid);

  if (!ses.connected) return res.status(503).json({ error: "not_connected" });

  rateLimitRecord(uid);
  const info = await fetchContactInfo(ses.sock, normalized);
  return res.json(info);
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => console.log(`Server listening on http://0.0.0.0:${PORT}`));

// -------------------- TELEGRAM BOT --------------------
const bot = new TelegramBot(TG_TOKEN, { polling: true });

// ---------- Force-join ----------
async function isUserJoined(uid) {
  try {
    const main = await bot.getChatMember(MAIN_CHANNEL, uid).catch(()=>null);
    const backup = await bot.getChatMember(BACKUP_CHANNEL, uid).catch(()=>null);
    const okMain = main && ["member","administrator","creator"].includes(main.status);
    const okBackup = backup && ["member","administrator","creator"].includes(backup.status);
    return okMain && okBackup;
  } catch (e) { return false; }
}

function showForceJoin(uid) {
  bot.sendMessage(uid,
    `⚠️ To use this bot you must join the channels.\nAfter joining, tap '✅ I Joined'.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 Join Backup", url: `https://t.me/${BACKUP_CHANNEL.replace("@","")}` }],
          [{ text: "🚀 Join Main", url: `https://t.me/${MAIN_CHANNEL.replace("@","")}` }],
          [{ text: "✅ I Joined", callback_data: "joined_check" }]
        ]
      }
    });
}

bot.on("callback_query", async (q) => {
  if (!q) return;
  if (q.data === "joined_check") {
    const joined = await isUserJoined(q.from.id);
    await bot.answerCallbackQuery(q.id, { text: joined ? "✅ Joined" : "❌ Please join both channels" });
    if (joined) bot.sendMessage(q.from.id, "✅ Verified — use /login <digits> to link WhatsApp");
    else showForceJoin(q.from.id);
  }
});

// -------------------- BOT COMMANDS --------------------

// /start
bot.onText(/\/start/, async (msg) => {
  const uid = String(msg.from.id);
  const joined = await isUserJoined(uid);
  if (!joined) return showForceJoin(uid);
  return bot.sendMessage(uid, `👋 Welcome!\nUse /login <digits> to link your WhatsApp (digits-only, e.g. 923001234567)\nCommands: /login /status /check /send /logout /reset`);
});

// /login digits-only
bot.onText(/\/login (.+)/, async (msg, match) => {
  const uid = String(msg.from.id);
  if (!(await isUserJoined(uid))) return showForceJoin(uid);

  const phoneRaw = match[1].trim();
  // User agreed to B: digits-only. We'll accept digits-only input only.
  const digits = String(phoneRaw).replace(/\D/g, "");
  if (!/^\d{7,20}$/.test(digits)) return bot.sendMessage(uid, "Invalid phone. Send digits only, e.g. 923001234567");

  try {
    const ses = await createSession(uid, digits);
    if (ses.pairingCode) {
      await bot.sendMessage(uid, `🔗 Pairing code:\n\n*${ses.pairingCode}*\n\nOpen WhatsApp → Linked Devices → Link with phone number → Enter this code (do it quickly).`, { parse_mode: "Markdown" });
      console.log(`[${uid}] pairingCode for ${digits}: ${ses.pairingCode}`);
    } else {
      if (ses.pairingError) {
        await bot.sendMessage(uid, `❌ Pairing error: ${ses.pairingError}`);
      } else if (ses.connected) {
        await bot.sendMessage(uid, "✅ Already connected.");
      } else {
        await bot.sendMessage(uid, "❌ Could not generate pairing code. Try again in a few minutes.");
      }
    }
  } catch (e) {
    console.error("login error", e);
    bot.sendMessage(uid, `❌ Unexpected error: ${e?.message || e}`);
  }
});

// /status
bot.onText(/\/status/, async (msg) => {
  const uid = String(msg.from.id);
  const s = sessions[uid];
  if (!s) return bot.sendMessage(uid, "No session. Use /login <digits>");
  return bot.sendMessage(uid, s.connected ? "✅ Connected" : "🔴 Not connected");
});

// /check <number>
bot.onText(/\/check (.+)/, async (msg, match) => {
  const uid = String(msg.from.id);
  const raw = match[1].trim();
  const normalized = normalizeNumberRaw(raw);
  if (!normalized) return bot.sendMessage(uid, "Invalid number format. Example: +447712345678");

  if (!(await isUserJoined(uid))) return showForceJoin(uid);

  const rl = rateLimitAllow(uid);
  if (!rl.ok) {
    if (rl.reason === "slow_down") return bot.sendMessage(uid, "⏳ Slow down.");
    return bot.sendMessage(uid, "⚠️ Daily limit reached.");
  }

  let ses = sessions[uid] || await createSession(uid);
  if (!ses.connected) return bot.sendMessage(uid, "🔴 Not connected. Use /login <digits>");

  rateLimitRecord(uid);
  await bot.sendMessage(uid, "⏳ Checking WhatsApp...");

  const info = await fetchContactInfo(ses.sock, normalized);
  if (!info.exists) return bot.sendMessage(uid, `❌ ${normalized} is NOT on WhatsApp`);

  let caption = `✅ ${normalized} is on WhatsApp\n`;
  if (info.name) caption += `Name: ${info.name}\n`;
  if (info.profilePic) {
    try { await bot.sendPhoto(uid, info.profilePic, { caption }); return; } catch(e) {}
  }
  return bot.sendMessage(uid, caption);
});

// free-text checking
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const uid = String(msg.from.id);
  const text = msg.text.trim();
  if (text.startsWith("/")) return;

  const normalized = normalizeNumberRaw(text);
  if (!normalized) return;

  if (!(await isUserJoined(uid))) return showForceJoin(uid);

  const rl = rateLimitAllow(uid);
  if (!rl.ok) {
    if (rl.reason === "slow_down") return bot.sendMessage(uid, "⏳ Slow down.");
    return bot.sendMessage(uid, "⚠️ Daily limit reached.");
  }

  let ses = sessions[uid] || await createSession(uid);
  if (!ses.connected) return bot.sendMessage(uid, "🔴 Not connected. Use /login <digits>");

  rateLimitRecord(uid);
  await bot.sendMessage(uid, "⏳ Checking...");

  const info = await fetchContactInfo(ses.sock, normalized);
  if (!info.exists) return bot.sendMessage(uid, `❌ ${normalized} is NOT on WhatsApp`);

  let caption = `✅ ${normalized} is on WhatsApp\n`;
  if (info.name) caption += `Name: ${info.name}\n`;
  if (info.profilePic) {
    try { await bot.sendPhoto(uid, info.profilePic, { caption }); return; } catch(e){}
  }
  return bot.sendMessage(uid, caption);
});

// /send <number> <text>
bot.onText(/\/send ([^\s]+) (.+)/, async (msg, match) => {
  const uid = String(msg.from.id);
  const s = sessions[uid];
  if (!s || !s.connected) return bot.sendMessage(uid, "❌ Not connected. Use /login <digits>");

  const number = match[1].trim().replace(/[^\d+]/g, "");
  const text = match[2];
  try {
    await s.sock.sendMessage(number.replace(/\D/g, "") + "@s.whatsapp.net", { text });
    bot.sendMessage(uid, "📤 Message sent successfully!");
  } catch (e) {
    bot.sendMessage(uid, "⚠️ Error sending message: " + (e?.message || e));
  }
});

// /logout
bot.onText(/\/logout/, async (msg) => {
  const uid = String(msg.from.id);
  const s = sessions[uid];
  if (!s) return bot.sendMessage(uid, "No active WhatsApp session found.");

  try { await s.sock.logout().catch(()=>{}); } catch(e){}
  try { if (fs.existsSync(getSessionPath(uid))) fs.rmSync(getSessionPath(uid), { recursive: true, force: true }); } catch(e){}
  delete sessions[uid];
  bot.sendMessage(uid, "👋 Logged out and session deleted.");
});

// /reset
bot.onText(/\/reset/, async (msg) => {
  const uid = String(msg.from.id);
  const dir = getSessionPath(uid);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      delete sessions[uid];
      await bot.sendMessage(uid, "🧹 Session data deleted. Now run /login <digits> to re-link.");
    } else {
      await bot.sendMessage(uid, "ℹ️ No saved session folder found for you.");
    }
  } catch (err) {
    await bot.sendMessage(uid, "❌ Error clearing session: " + err.message);
  }
});

// file upload handling (TXT/CSV)
bot.on("document", async (msg) => {
  const uid = String(msg.from.id);
  const doc = msg.document;
  if (!doc) return;

  if (!(await isUserJoined(uid))) return showForceJoin(uid);

  const fname = doc.file_name || "";
  const lower = fname.toLowerCase();
  if (!lower.endsWith(".txt") && !lower.endsWith(".csv")) return bot.sendMessage(uid, "❌ Only .txt and .csv supported.");

  try {
    await bot.sendMessage(uid, "📥 Downloading file…");
    const fileUrl = await bot.getFileLink(doc.file_id);
    const resp = await fetch(fileUrl);
    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(ab);

    let numbers = [];
    if (lower.endsWith(".txt")) numbers = buf.toString("utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    else {
      const parsed = csvParse(buf.toString("utf8"), { relax_column_count: true });
      numbers = parsed.flat().map(c => String(c).trim()).filter(Boolean);
    }

    if (!numbers.length) return bot.sendMessage(uid, "❌ No numbers found in file.");
    numbers = numbers.map(n => n.replace(/[^\d+]/g, "")).filter(Boolean);

    await bot.sendMessage(uid, `🔎 Found ${numbers.length} numbers. Starting checks...`);

    const ses = sessions[uid] || await createSession(uid);
    if (!ses.connected) return bot.sendMessage(uid, "🔴 WhatsApp not connected. Use /login <digits>");

    const results = [];
    for (const raw of numbers) {
      const allow = rateLimitAllow(uid);
      if (!allow.ok) {
        if (allow.reason === "slow_down") await new Promise(r => setTimeout(r, LIMITS.cooldownMs));
        else { await bot.sendMessage(uid, "⚠️ Daily limit reached. Stopping checks."); break; }
      }

      rateLimitRecord(uid);

      const normalized = normalizeNumberRaw(raw);
      if (!normalized) { results.push({ number: raw, exists: "INVALID", name: "" }); continue; }

      const info = await fetchContactInfo(ses.sock, normalized);
      results.push({ number: normalized, exists: info.exists ? "YES" : "NO", name: info.name || "" });

      await new Promise(r => setTimeout(r, 700));
    }

    let out = "number,exists,name\n";
    for (const r of results) {
      const safeName = (r.name || "").replace(/"/g, '""');
      out += `"${r.number}","${r.exists}","${safeName}"\n`;
    }
    const outBuf = Buffer.from(out, "utf8");
    await bot.sendDocument(uid, outBuf, {}, { filename: "wp-check-results.csv", contentType: "text/csv" });
    await bot.sendMessage(uid, "✅ Done. Results sent as wp-check-results.csv");
  } catch (e) {
    console.error("file handler error", e);
    await bot.sendMessage(uid, "❌ Failed to process file.");
  }
});

console.log("🤖 Pairing-code multi-session bot running (Baileys pairing, digits-only).");
