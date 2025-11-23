// index.js
// Multi-session WhatsApp checker (pairing-code login only) + Telegram bot + admin UI

// --- WebCrypto fix for some hosts (Node >= 18)
import { webcrypto } from "crypto";
globalThis.crypto = webcrypto;

// --- Imports
import express from "express";
import cors from "cors";
import * as baileys from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";
import TelegramBot from "node-telegram-bot-api";
import { parse as csvParse } from "csv-parse/sync";

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;

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

// rate-limit config
const LIMITS = {
  windowMs: 24 * 60 * 60 * 1000,
  maxChecksPerWindow: 200,
  cooldownMs: 2000
};

// ensure sessions folder
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// in-memory stores
const sessions = {}; // userId -> { sock, pairingCode, connected, sessionId, createdAt }
const usage = {};    // userId -> { windowStart, count, lastCheckAt }

// -------------------- HELPERS --------------------
function normalizeNumberRaw(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[()\s-]/g, "");
  return /^\+?\d{8,18}$/.test(s) ? s : null;
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
    } catch (e) {
      resolve(null);
    }
  });
}

// -------------------- CREATE SESSION (pairing-code) --------------------
/**
 * createSession(userId, phoneNumber)
 * - Creates or returns existing in-memory session & socket
 * - If phoneNumber provided and session not registered, requests pairing code (digits-only)
 * - Returns session object
 */
async function createSession(userId, phoneNumber) {
  // if socket exists, return it
  if (sessions[userId] && sessions[userId].sock) return sessions[userId];

  const sessionId = `user_${userId}`;
  const sessionDir = getSessionPath(userId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  let connected = false;

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["WPChecker", "Chrome", "1.0"],
    syncFullHistory: false,
    connectTimeoutMs: 30_000
  });

  // skeleton
  sessions[userId] = {
    sock,
    pairingCode: null,
    connected: false,
    sessionId,
    createdAt: Date.now()
  };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    const code = lastDisconnect?.error?.output?.statusCode;

    if (connection === "open") {
      connected = true;
      sessions[userId].connected = true;
      sessions[userId].pairingCode = null;
      console.log(`[${userId}] WhatsApp connected`);
      // notify user when connected if we have bot available
      try { bot.sendMessage(Number(userId), "✅ WhatsApp connected successfully!"); } catch (e) {}
    }

    if (connection === "close") {
      connected = false;
      sessions[userId].connected = false;
      console.log(`[${userId}] WhatsApp disconnected:`, code);

      if (code === DisconnectReason.loggedOut || code === 401) {
        console.log(`[${userId}] logged out — removing session files to allow re-link`);
        try {
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) { console.warn("failed remove session dir", e); }
        delete sessions[userId];
      } else {
        // attempt reconnect
        setTimeout(() => createSession(userId).catch(e => console.error("reconnect fail", e)), 2500);
      }
    }
  });

  sock.ev.on("messages.upsert", async () => {
    // no forwarding by default
  });

  // store in sessions
  sessions[userId].sock = sock;
  sessions[userId].pairingCode = null;
  sessions[userId].connected = connected;

  // if not registered and phoneNumber supplied -> request pairing code
  try {
    const registered = sock.authState?.creds?.registered;
    if (!registered && phoneNumber) {
      // Baileys pairing requires digits-only (no +); we'll strip non-digits
      const digits = String(phoneNumber).replace(/\D/g, "");
      if (!/^\d{7,20}$/.test(digits)) throw new Error("invalid phone digits for pairing");
      const code = await sock.requestPairingCode(digits);
      if (code) {
        sessions[userId].pairingCode = code;
      }
    }
  } catch (e) {
    // record error on pairingCode field for caller to inspect
    console.warn(`[${userId}] pairing request error:`, e?.message || e);
    sessions[userId].pairingError = e?.message || String(e || "");
  }

  return sessions[userId];
}

// -------------------- CONTACT INFO --------------------
async function fetchContactInfo(sock, number) {
  const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
  const out = { exists: false, name: null, profilePic: null };
  try {
    const r = await sock.onWhatsApp(jid);
    out.exists = Array.isArray(r) && r[0] ? Boolean(r[0].exists) : false;
    if (!out.exists) return out;

    try {
      if (typeof sock.getName === "function") out.name = await sock.getName(jid);
    } catch (e) { out.name = null; }

    try {
      if (typeof sock.profilePictureUrl === "function") {
        const url = await sock.profilePictureUrl(jid, "image").catch(() => null);
        if (url) {
          const imgBuf = await fetchBufferFromUrl(url);
          if (imgBuf) out.profilePic = `data:image/jpeg;base64,${imgBuf.toString("base64")}`;
        }
      }
    } catch (e) { out.profilePic = null; }

    return out;
  } catch (e) {
    return out;
  }
}

// -------------------- EXPRESS APP --------------------
const app = express();
app.use(cors());
app.use(express.json());

function requireAdmin(req, res, next) {
  const pass = req.headers["x-admin-pass"] || req.query?.admin || "";
  if (pass === ADMIN_PASSWORD) return next();
  res.status(401).send("Unauthorized");
}

// admin page
app.get("/admin", requireAdmin, (req, res) => {
  const list = Object.keys(sessions).map(uid => {
    const s = sessions[uid];
    const u = usage[uid] || { windowStart: 0, count: 0, lastCheckAt: 0 };
    return {
      userId: uid,
      sessionId: s.sessionId,
      connected: Boolean(s.connected),
      createdAt: s.createdAt || null,
      usageCount: u.count,
      usageWindowStart: u.windowStart
    };
  });

  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title>
<style>body{font-family:Inter,system-ui;background:#081426;color:#fff;padding:20px}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid rgba(255,255,255,0.04)}</style>
</head><body>
<h1>Admin</h1>
<table><thead><tr><th>User</th><th>Session</th><th>Connected</th><th>Usage(24h)</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table>
<script>const data=${JSON.stringify(list)};const t=document.getElementById('rows');data.forEach(r=>{const tr=document.createElement('tr');tr.innerHTML='<td>'+r.userId+'</td><td>'+r.sessionId+'</td><td>'+(r.connected?'✅':'❌')+'</td><td>'+r.usageCount+'</td><td><a href="/admin/logout?user='+r.userId+'&admin=${ADMIN_PASSWORD}'>Logout</a></td>';t.appendChild(tr);});</script>
</body></html>`);
});

// admin logout
app.get("/admin/logout", requireAdmin, async (req, res) => {
  const user = String(req.query.user || "");
  if (!user || !sessions[user]) return res.status(404).send("No session");
  try { await sessions[user].sock.logout().catch(()=>{}); } catch(e){}
  delete sessions[user];
  const dir = getSessionPath(user);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.redirect(`/admin?admin=${ADMIN_PASSWORD}`);
});

// API: check single number
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
  if (!ses) ses = await createSession(uid); // creates socket (no pairing code unless phone provided)

  if (!ses.connected) return res.status(503).json({ error: "not_connected" });

  rateLimitRecord(uid);
  const info = await fetchContactInfo(ses.sock, normalized);
  return res.json(info);
});

app.get("/health", (req, res) => res.json({ ok: true }));
app.listen(PORT, "0.0.0.0", () => console.log(`Server listening on http://0.0.0.0:${PORT}`));

// -------------------- TELEGRAM BOT --------------------
const bot = new TelegramBot(TG_TOKEN, { polling: true });

// ---------- Force-join checks ----------
async function isUserJoined(uid) {
  try {
    const main = await bot.getChatMember(MAIN_CHANNEL, uid).catch(()=>null);
    const backup = await bot.getChatMember(BACKUP_CHANNEL, uid).catch(()=>null);
    const okMain = main && ["member","administrator","creator"].includes(main.status);
    const okBackup = backup && ["member","administrator","creator"].includes(backup.status);
    return okMain && okBackup;
  } catch (e) {
    return false;
  }
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
    if (joined) bot.sendMessage(q.from.id, "✅ Verified — use /login <phone>");
    else showForceJoin(q.from.id);
  }
});

// -------------------- BOT COMMANDS (pairing flow) --------------------

// /start
bot.onText(/\/start/, async (msg) => {
  const uid = String(msg.from.id);
  const joined = await isUserJoined(uid);
  if (!joined) return showForceJoin(uid);

  return bot.sendMessage(uid,
    `👋 Welcome!\nUse /login <phone> to link WhatsApp via pairing code.\nExample: /login +14151234567\nCommands:\n/login <phone>\n/status\n/check <number>\n/send <number> <text>\n/logout\n/reset`);
});

// /login <phone>
bot.onText(/\/login (.+)/, async (msg, match) => {
  const uid = String(msg.from.id);
  if (!(await isUserJoined(uid))) return showForceJoin(uid);

  const phoneRaw = match[1].trim();
  const phone = normalizeNumberRaw(phoneRaw);
  if (!phone) return bot.sendMessage(uid, "Invalid phone format. Example: +14151234567");

  try {
    // create session and request pairing code (createSession will strip non-digits)
    const ses = await createSession(uid, phone);
    if (ses.pairingCode) {
      // send the pairing code text to user
      await bot.sendMessage(uid,
        `🔗 Pairing code for ${phone}:\n\n*${ses.pairingCode}*\n\nOpen WhatsApp → Linked Devices → Link with phone number → Enter this code (do it quickly).`,
        { parse_mode: "Markdown" });
      console.log(`[${uid}] Pairing code generated for ${phone}: ${ses.pairingCode}`);
    } else {
      if (ses.connected) bot.sendMessage(uid, "✅ Already connected.");
      else {
        const err = ses.pairingError || "Could not generate pairing code. Try again in a few minutes.";
        bot.sendMessage(uid, `❌ ${err}`);
      }
    }
  } catch (e) {
    console.error("login error", e);
    bot.sendMessage(uid, `❌ Error requesting pairing code: ${e?.message || e}`);
  }
});

// /status
bot.onText(/\/status/, async (msg) => {
  const uid = String(msg.from.id);
  const s = sessions[uid];
  if (!s) return bot.sendMessage(uid, "No session. Use /login <phone>");
  return bot.sendMessage(uid, s.connected ? "✅ Connected" : "🔴 Not connected");
});

// /check <number>
bot.onText(/\/check (.+)/, async (msg, match) => {
  const uid = String(msg.from.id);
  const raw = match[1];
  const normalized = normalizeNumberRaw(raw);
  if (!normalized) return bot.sendMessage(uid, "Invalid number format. Example: +447712345678");

  if (!(await isUserJoined(uid))) return showForceJoin(uid);

  const rl = rateLimitAllow(uid);
  if (!rl.ok) {
    if (rl.reason === "slow_down") return bot.sendMessage(uid, "⏳ Slow down.");
    return bot.sendMessage(uid, "⚠️ Daily limit reached.");
  }

  let ses = sessions[uid] || await createSession(uid);
  if (!ses.connected) return bot.sendMessage(uid, "🔴 WhatsApp not connected. Use /login <phone>");

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

// free-text number auto-check
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
  if (!ses.connected) return bot.sendMessage(uid, "🔴 Not connected. Use /login <phone>");

  rateLimitRecord(uid);
  await bot.sendMessage(uid, "⏳ Checking...");

  const info = await fetchContactInfo(ses.sock, normalized);
  if (!info.exists) return bot.sendMessage(uid, `❌ ${normalized} is NOT on WhatsApp`);

  let caption = `✅ ${normalized} is on WhatsApp\n`;
  if (info.name) caption += `Name: ${info.name}\n`;
  if (info.profilePic) {
    try { await bot.sendPhoto(uid, info.profilePic, { caption }); return; } catch(e) {}
  }
  return bot.sendMessage(uid, caption);
});

// /send <number> <message>
bot.onText(/\/send ([^\s]+) (.+)/, async (msg, match) => {
  const uid = String(msg.from.id);
  const s = sessions[uid];
  if (!s || !s.connected) return bot.sendMessage(uid, "❌ Not connected. Use /login <phone>");

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

// /reset — delete saved session folder
bot.onText(/\/reset/, async (msg) => {
  const uid = String(msg.from.id);
  const dir = getSessionPath(uid);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      delete sessions[uid];
      await bot.sendMessage(uid, "🧹 Session data deleted. Now run /login +<phone> to re-link.");
    } else {
      await bot.sendMessage(uid, "ℹ️ No saved session folder found for you.");
    }
  } catch (err) {
    await bot.sendMessage(uid, "❌ Error clearing session: " + err.message);
  }
});

// -------------------- FILE UPLOAD HANDLER (TXT & CSV) --------------------
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
    if (lower.endsWith(".txt")) {
      numbers = buf.toString("utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } else {
      const parsed = csvParse(buf.toString("utf8"), { relax_column_count: true });
      numbers = parsed.flat().map(c => String(c).trim()).filter(Boolean);
    }

    if (!numbers.length) return bot.sendMessage(uid, "❌ No numbers found in file.");
    numbers = numbers.map(n => n.replace(/[^\d+]/g, "")).filter(Boolean);

    await bot.sendMessage(uid, `🔎 Found ${numbers.length} numbers. Starting checks...`);

    const ses = sessions[uid] || await createSession(uid);
    if (!ses.connected) return bot.sendMessage(uid, "🔴 WhatsApp not connected. Use /login <phone>");

    const results = [];
    for (const raw of numbers) {
      const allow = rateLimitAllow(uid);
      if (!allow.ok) {
        if (allow.reason === "slow_down") {
          await new Promise(r => setTimeout(r, LIMITS.cooldownMs));
        } else {
          await bot.sendMessage(uid, "⚠️ Daily limit reached. Stopping checks.");
          break;
        }
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

console.log("🤖 Telegram-WhatsApp pairing-code bot running...");
