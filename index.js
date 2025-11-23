// bot.js
// Multi-session WhatsApp checker with Telegram bot (pairing-code login only)
// Keeps original JSON/in-memory usage limits (no DB changes)

// --- Fix crypto not defined on some hosts ---
import { webcrypto } from "crypto";
globalThis.crypto = webcrypto;

// --- Imports ---
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

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

// -------------------- CONFIG --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use env vars in production — fallback values are for local testing only
const TG_TOKEN = "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc"; // MUST be set in env
if (!TG_TOKEN) throw new Error("Missing TG_TOKEN env var. Set your Telegram bot token in env.");
const SERVER_URL = process.env.SERVER_URL || "https://wpchecker.up.railway.app"; // not used for pairing mode
const MAIN_CHANNEL = process.env.MAIN_CHANNEL || "@OPxOTP";
const BACKUP_CHANNEL = process.env.BACKUP_CHANNEL || "@OPxOTPChat";

const PORT = process.env.PORT || 8000;
const SESSIONS_DIR = path.join(__dirname, "sessions");

// per-user limits
const LIMITS = {
  windowMs: 24 * 60 * 60 * 1000,
  maxChecksPerWindow: 200,
  cooldownMs: 2000
};

// Ensure sessions dir exists
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// In-memory stores
const sessions = {}; // { userId: { sock, pairingCode, connected, sessionId, createdAt } }
const usage = {};    // { userId: { windowStart, count, lastCheckAt } }

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
      lib
        .get(url, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", () => resolve(null));
        })
        .on("error", () => resolve(null));
    } catch (e) {
      resolve(null);
    }
  });
}

// -------------------- SESSION CREATION (pairing code mode) --------------------
/*
  createSession(userId, phoneNumber)
  - If phoneNumber provided and session not registered, generates a pairing code via Baileys
  - Returns session skeleton object
*/
async function createSession(userId, phoneNumber /* optional for pairing */) {
  // return existing session if active
  if (sessions[userId] && sessions[userId].sock) return sessions[userId];

  const sessionId = `user_${userId}`;
  const sessionDir = getSessionPath(userId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  let latestPairing = null;
  let connected = false;

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: ["WPChecker", "Chrome", "1.0"],
    mobile: false,
    syncFullHistory: false,
    connectTimeoutMs: 30_000
  });

  // early skeleton
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
      // optionally notify user if needed (we notify at pairing time)
    }

    if (connection === "close") {
      connected = false;
      sessions[userId].connected = false;
      console.log(`[${userId}] WhatsApp disconnected:`, code);

      if (code === DisconnectReason.loggedOut || code === 401) {
        console.log(`[${userId}] logged out — deleting session folder to force re-link`);
        try {
          // remove session files on logout to allow fresh pairing next time
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) { console.warn("failed remove session dir", e); }
        delete sessions[userId];
      } else {
        // try reconnect after a delay (no phone required)
        setTimeout(() => createSession(userId).catch(e => console.error("reconnect fail", e)), 2000);
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    // no auto-reply / forwarding by default
  });

  // store latest state
  sessions[userId].sock = sock;
  sessions[userId].pairingCode = null;
  sessions[userId].connected = connected;

  // If not registered and phoneNumber provided, request pairing code
  try {
    const registered = sock.authState?.creds?.registered;
    if (!registered && phoneNumber) {
      const clean = phoneNumber.replace(/\+/g, "");
      // requestPairingCode returns a code (string)
      const code = await sock.requestPairingCode(clean);
      if (code) {
        sessions[userId].pairingCode = code;
        latestPairing = code;
        // send pairing code to the user via Telegram (bot is defined later; push to queue if not ready)
        // We will send pairing code from caller (createSession is called from bot context), so return it
      }
    }
  } catch (e) {
    console.warn(`[${userId}] pairing request failed`, e && e.message ? e.message : e);
    // keep session created; caller will show error to user
  }

  return sessions[userId];
}

// -------------------- CONTACT INFO (best-effort) --------------------
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

// -------------------- EXPRESS APP (admin + API) --------------------
const app = express();
app.use(cors());
app.use(express.json());

function requireAdmin(req, res, next) {
  const pass = req.headers["x-admin-pass"] || req.query?.admin || "";
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
  if (pass === ADMIN_PASSWORD) return next();
  res.status(401).send("Unauthorized");
}

// admin dashboard (shows sessions and actions) — no QR links in pairing mode
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
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Dashboard</title>
<style>
body{font-family:Inter,system-ui;background:#081426;color:#fff;margin:0;padding:20px}
.container{max-width:1100px;margin:0 auto}
h1{margin:0 0 14px}
.card{background:rgba(255,255,255,0.03);padding:16px;border-radius:12px}
.table{width:100%;border-collapse:collapse;margin-top:12px}
.table th,.table td{padding:10px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.04)}
.btn{background:#0ea5a1;color:#012;padding:8px 10px;border-radius:8px;text-decoration:none;display:inline-block}
.small{opacity:0.7;font-size:13px}
</style>
</head>
<body>
<div class="container">
  <h1>Admin Dashboard</h1>
  <div class="card">
    <div class="small">Sessions</div>
    <table class="table">
      <thead><tr><th>UserID</th><th>Session</th><th>Connected</th><th>Usage (24h)</th><th>Actions</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div style="margin-top:14px"><a class="btn" href="#" onclick="refresh()">Refresh</a></div>
  </div>
</div>
<script>
const data = ${JSON.stringify(list)};
function render(){
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  data.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>'+r.userId+'</td><td>'+r.sessionId+'</td><td>'+(r.connected? '✅':'❌')+'</td><td>'+r.usageCount+'</td><td><a href="/admin/logout?user='+r.userId+'&admin=${process.env.ADMIN_PASSWORD || "changeme"}" class="btn">Logout</a></td>';
    tbody.appendChild(tr);
  })
}
render();
function refresh(){ location.reload(); }
</script>
</body>
</html>`);
});

// admin: force logout (deletes session folder + attempts logout)
app.get("/admin/logout", requireAdmin, async (req, res) => {
  const user = String(req.query.user || "");
  if (!user || !sessions[user]) return res.status(404).send("No session");

  try {
    try { await sessions[user].sock.logout(); } catch {}
    delete sessions[user];
    const dir = getSessionPath(user);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn("admin logout error", e);
  }
  res.redirect(`/admin?admin=${process.env.ADMIN_PASSWORD || "changeme"}`);
});

// API: check single number
app.post("/api/check", express.json(), async (req, res) => {
  const { userId, number } = req.body || {};
  if (!userId || !number) return res.status(422).json({ error: "userId and number required" });

  const uid = String(userId);
  const normalized = normalizeNumberRaw(number);
  if (!normalized) return res.status(422).json({ error: "invalid number" });

  // rate limit
  const rl = rateLimitAllow(uid);
  if (!rl.ok) {
    if (rl.reason === "slow_down") return res.status(429).json({ error: "slow_down" });
    return res.status(429).json({ error: "limit_reached" });
  }

  let ses = sessions[uid];
  if (!ses) ses = await createSession(uid); // creates socket but does not generate pairing unless phone given

  if (!ses.connected) return res.status(503).json({ error: "not_connected" });

  rateLimitRecord(uid);

  const info = await fetchContactInfo(ses.sock, normalized);
  return res.json(info);
});

// health
app.get("/health", (req, res) => res.json({ ok: true }));

// start express
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});

// -------------------- TELEGRAM BOT --------------------
const bot = new TelegramBot(TG_TOKEN, { polling: true });

// ---------- FORCE JOIN SYSTEM ----------
async function isUserJoined(uid) {
  try {
    const main = await bot.getChatMember(MAIN_CHANNEL, uid).catch(() => null);
    const backup = await bot.getChatMember(BACKUP_CHANNEL, uid).catch(() => null);

    const okMain = main && ["member", "administrator", "creator"].includes(main.status);
    const okBackup = backup && ["member", "administrator", "creator"].includes(backup.status);

    return okMain && okBackup;
  } catch (e) {
    return false;
  }
}

function showForceJoin(uid) {
  bot.sendMessage(
    uid,
    `⚠️ To use this bot, please join our Backup and Main channels.\nAfter joining, tap the button '✅ I Joined'.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 Join Backup Channel", url: `https://t.me/${BACKUP_CHANNEL.replace("@", "")}` }],
          [{ text: "🚀 Join Main Channel", url: `https://t.me/${MAIN_CHANNEL.replace("@", "")}` }],
          [{ text: "✅ I Joined", callback_data: "joined_check" }]
        ]
      }
    }
  );
}

bot.on("callback_query", async (q) => {
  if (!q) return;
  if (q.data === "joined_check") {
    const joined = await isUserJoined(q.from.id);
    await bot.answerCallbackQuery(q.id, { text: joined ? "✅ Joined!" : "❌ Please join both channels" });
    if (joined) {
      bot.sendMessage(q.from.id, "✅ Verified — you can now use the bot. Use /login <phone> to link your WhatsApp.");
    } else {
      showForceJoin(q.from.id);
    }
  }
});

// -------------------- BOT COMMANDS (pairing-code flow) --------------------

// /start - friendly info (tell user to /login)
bot.onText(/\/start/, async (msg) => {
  const uid = String(msg.from.id);
  const joined = await isUserJoined(uid);
  if (!joined) return showForceJoin(uid);

  return bot.sendMessage(uid,
    `👋 Welcome!
Use /login <phone> to link your WhatsApp via pairing code (no QR).
Example: /login +14151234567

Commands:
/login <phone> — Get pairing code (enter it in WhatsApp → Linked Devices → Link with phone number)
/status — Check connection
/check <number> — Check if number exists
/send <number> <text> — Send WhatsApp message
/logout — Unlink & delete session
/reset — Delete saved session files (if stuck)`
  );
});

// /login <phone> — generate pairing code and send via Telegram
bot.onText(/\/login (.+)/, async (msg, match) => {
  const uid = String(msg.from.id);
  if (!(await isUserJoined(uid))) return showForceJoin(uid);

  const phoneRaw = match[1].trim();
  const phone = normalizeNumberRaw(phoneRaw);
  if (!phone) return bot.sendMessage(uid, "Invalid phone format. Use +14151234567");

  try {
    // create session and request pairing
    const ses = await createSession(uid, phone);
    // pairing code should be set on sessions[uid].pairingCode if request succeeded
    if (ses.pairingCode) {
      await bot.sendMessage(uid,
        `🔗 Pairing code generated for ${phone}:\n\n*${ses.pairingCode}*\n\nOpen WhatsApp → Linked Devices → Link with phone number → Enter this code (do it quickly).`,
        { parse_mode: "Markdown" });
      // also log
      console.log(`[${uid}] Pairing code ${ses.pairingCode} for ${phone}`);
    } else {
      // if not generated, the session may already be registered or error occurred
      if (ses.connected) {
        bot.sendMessage(uid, "✅ Already connected to WhatsApp.");
      } else {
        bot.sendMessage(uid, "❌ Couldn't generate pairing code. Try again in a moment.");
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
  if (!normalized) return bot.sendMessage(uid, "Invalid number format. Use +923001234567");

  if (!(await isUserJoined(uid))) return showForceJoin(uid);

  // rate limit
  const rl = rateLimitAllow(uid);
  if (!rl.ok) {
    if (rl.reason === "slow_down") return bot.sendMessage(uid, "⏳ Slow down. Try again in a moment.");
    return bot.sendMessage(uid, "⚠️ Daily limit reached.");
  }

  let ses = sessions[uid] || await createSession(uid);
  if (!ses.connected) return bot.sendMessage(uid, "🔴 WhatsApp not connected. Use /login <phone> to generate a pairing code.");

  rateLimitRecord(uid);
  await bot.sendMessage(uid, "⏳ Checking WhatsApp...");

  const info = await fetchContactInfo(ses.sock, normalized);

  if (!info.exists) return bot.sendMessage(uid, `❌ ${normalized} is NOT on WhatsApp`);

  let caption = `✅ ${normalized} is on WhatsApp\n`;
  if (info.name) caption += `Name: ${info.name}\n`;
  if (info.profilePic) {
    try {
      await bot.sendPhoto(uid, info.profilePic, { caption });
      return;
    } catch (e) {
      // fallback to text
    }
  }
  return bot.sendMessage(uid, caption);
});

// free-text number auto-check
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const uid = String(msg.from.id);
  const text = msg.text.trim();

  // ignore commands
  if (text.startsWith("/")) return;

  const normalized = normalizeNumberRaw(text);
  if (!normalized) return; // ignore non-number messages

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
    try {
      await bot.sendPhoto(uid, info.profilePic, { caption });
      return;
    } catch (e) {
      // continue to text
    }
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

  try {
    await s.sock.logout();
  } catch (e) { /* ignore */ }
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
      await bot.sendMessage(uid, "🧹 Session data deleted. Now run /login +<phone> to generate a new pairing code.");
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
  if (!lower.endsWith(".txt") && !lower.endsWith(".csv")) {
    return bot.sendMessage(uid, "❌ Only .txt and .csv files are supported right now.");
  }

  try {
    await bot.sendMessage(uid, "📥 Downloading file…");
    const fileUrl = await bot.getFileLink(doc.file_id);
    const resp = await fetch(fileUrl);
    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(ab);

    let numbers = [];
    if (lower.endsWith(".txt")) {
      numbers = buf.toString("utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } else if (lower.endsWith(".csv")) {
      const parsed = csvParse(buf.toString("utf8"), { relax_column_count: true });
      numbers = parsed.flat().map(c => String(c).trim()).filter(Boolean);
    }

    if (!numbers.length) return bot.sendMessage(uid, "❌ No numbers found in file.");

    numbers = numbers.map(n => n.replace(/[^\d+]/g, "")).filter(Boolean);

    await bot.sendMessage(uid, `🔎 Found ${numbers.length} numbers. Starting checks (this may take a while)...`);

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
      if (!normalized) {
        results.push({ number: raw, exists: "INVALID", name: "" });
        continue;
      }

      const info = await fetchContactInfo(ses.sock, normalized);
      results.push({ number: normalized, exists: info.exists ? "YES" : "NO", name: info.name || "" });

      // short delay to reduce risk of rate limiting
      await new Promise(r => setTimeout(r, 700));
    }

    // prepare CSV output
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

console.log("🤖 Telegram-WhatsApp bot (pairing-code) running...");
