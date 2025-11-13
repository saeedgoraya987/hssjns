// bot.js
// Multi-session WhatsApp checker with Telegram bot + Premium QR UI + Admin dashboard + per-user limits
// Edit: set TG_TOKEN, ADMIN_PASSWORD, SERVER_URL (or use env variables)

import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import baileys from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import TelegramBot from "node-telegram-bot-api";
import crypto from "crypto";

// -------------------- CONFIG --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TG_TOKEN = process.env.TG_TOKEN || "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "saeedg110"; // simple admin password for dashboard
const SERVER_URL = process.env.SERVER_URL || "https://wpchecker.up.railway.app"; // e.g. https://your-app.up.railway.app

const PORT = process.env.PORT || 8000;
const SESSIONS_DIR = path.join(__dirname, "sessions");

// per-user limits
const LIMITS = {
  windowMs: 24 * 60 * 60 * 1000, // 24h reset
  maxChecksPerWindow: 200,        // per-user daily limit (change as needed)
  cooldownMs: 2000                // minimum ms between checks for same user (anti-spam)
};

// Ensure sessions dir exists
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// In-memory store (keeps stats & sessions)
const sessions = {}; // { userId: { sock, qr, connected, sessionId, createdAt } }
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

// -------------------- CREATE SESSION --------------------
async function createSession(userId) {
  // return existing session if active
  if (sessions[userId] && sessions[userId].sock) return sessions[userId];

  const sessionId = `user_${userId}`;
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  let latestQR = null;
  let connected = false;

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: ["WPChecker", "Chrome", "1.0"]
  });

  // Save session skeleton early so event handlers can refer to it
  sessions[userId] = {
    sock,
    qr: null,
    connected: false,
    sessionId,
    createdAt: Date.now()
  };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      latestQR = qr;
      sessions[userId].qr = qr;
    }

    if (connection === "open") {
      connected = true;
      sessions[userId].connected = true;
      sessions[userId].qr = null;
      console.log(`[${userId}] WhatsApp connected`);
    }

    if (connection === "close") {
      connected = false;
      sessions[userId].connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${userId}] WhatsApp disconnected:`, code);

      // if not logged out, try recreate socket
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => createSession(userId).catch(e => console.error("reconnect fail", e)), 2000);
      } else {
        // fully logged out; keep session dir but mark disconnected
        console.log(`[${userId}] logged out — delete ./sessions/${sessionId} to re-link`);
      }
    }
  });

  // add a small messages.upsert handler to keep connection responsive (optional)
  sock.ev.on("messages.upsert", async (m) => {
    // we won't auto-reply here - just keep logs for debugging
    // console.log(`[${userId}] messages.upsert`, m.type);
  });

  // store
  sessions[userId].sock = sock;
  sessions[userId].qr = latestQR;
  sessions[userId].connected = connected;

  return sessions[userId];
}

// -------------------- BEST-EFFORT CONTACT INFO --------------------
async function fetchContactInfo(sock, number) {
  // returns { exists: bool, name: string|null, profilePic: dataUrl|null }
  const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
  const out = { exists: false, name: null, profilePic: null };

  try {
    const r = await sock.onWhatsApp(jid);
    out.exists = Array.isArray(r) && r[0] ? Boolean(r[0].exists) : false;
    if (!out.exists) return out;

    // Name lookup: try sock.getName if available, then fallback to jid
    try {
      if (typeof sock.getName === "function") {
        out.name = await sock.getName(jid);
      } else if (sock.user && sock.user.name) {
        // fallback: contact store may have the name under sock.user or sock.chats - limited
        out.name = sock.user.name || null;
      } else {
        out.name = null;
      }
    } catch (e) {
      out.name = null;
    }

    // Profile pic: try profilePictureUrl and fetch image as dataURL
    try {
      if (typeof sock.profilePictureUrl === "function") {
        const url = await sock.profilePictureUrl(jid, "image").catch(() => null);
        if (url) {
          // fetch binary via simple HTTPS (Baileys returns full url)
          const imgBuf = await fetchBufferFromUrl(url);
          if (imgBuf) {
            out.profilePic = `data:image/jpeg;base64,${imgBuf.toString("base64")}`;
          }
        }
      }
    } catch (e) {
      // ignore - may fail due to API restrictions
      out.profilePic = null;
    }

    return out;
  } catch (e) {
    // If onWhatsApp threw, return exists=false
    return out;
  }
}

// helper to fetch image buffer (native node fetchless)
import https from "https";
import http from "http";

async function fetchBufferFromUrl(url) {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith("https") ? https : http;

      client.get(url, (res) => {
        const data = [];
        res.on("data", (chunk) => data.push(chunk));
        res.on("end", () => resolve(Buffer.concat(data)));
      }).on("error", () => resolve(null));
    } catch (err) {
      resolve(null);
    }
  });
}

// -------------------- EXPRESS APP + UI --------------------
const app = express();
app.use(cors());
app.use(express.json());

// simple admin auth middleware (password via header x-admin-pass or query ?admin)
function requireAdmin(req, res, next) {
  const pass = req.headers["x-admin-pass"] || req.query?.admin || "";
  if (pass === ADMIN_PASSWORD) return next();
  res.status(401).send("Unauthorized");
}

// Premium QR UI (connected / waiting / QR) with meta tags and animations
app.get("/qr/:userId", async (req, res) => {
  const userId = String(req.params.userId);
  let ses = sessions[userId];
  if (!ses) ses = await createSession(userId);

  // Connected page
  if (ses.connected) {
    res.send(`<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp Connected</title>
<style>
:root{--bg1:#071024;--bg2:#12243b;--card:rgba(255,255,255,0.06)}
*{box-sizing:border-box}
body{margin:0;height:100vh;background:linear-gradient(135deg,var(--bg1),var(--bg2));font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,"Helvetica Neue",Arial;color:#fff;display:flex;align-items:center;justify-content:center}
.container{width:min(720px,92%);display:flex;flex-direction:column;gap:18px;align-items:center}
.card{background:var(--card);padding:28px;border-radius:16px;backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,0.5);text-align:center}
h1{margin:0;font-size:20px}
.pulse{display:inline-block;margin-top:12px;padding:8px 14px;border-radius:999px;background:linear-gradient(90deg,#0ea5a1,#06b6d4);color:#012; font-weight:700}
.small{opacity:0.8;font-size:14px;margin-top:8px}
.footer{margin-top:12px;opacity:0.6;font-size:13px}
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <h1>✅ WhatsApp Connected</h1>
    <div class="pulse">Your device is linked</div>
    <div class="small">You can now use the Telegram bot to check numbers.</div>
    <div class="footer">Session: ${ses.sessionId}</div>
  </div>
</div>
</body>
</html>`);
    return;
  }

  // Waiting page
  if (!ses.qr) {
    res.send(`<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Generating QR…</title>
<meta http-equiv="refresh" content="4">
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,#081029,#0b1530);font-family:Inter,system-ui;color:#fff}
.loader{display:flex;flex-direction:column;align-items:center;gap:14px}
.spinner{width:72px;height:72px;border-radius:12px;background:linear-gradient(135deg,#0ea5a1,#06b6d4);filter:blur(6px);opacity:.12}
.text{font-size:18px}
</style>
</head>
<body>
<div class="loader">
  <div class="spinner"></div>
  <div class="text">⏳ Preparing QR — open WhatsApp and scan</div>
</div>
</body>
</html>`);
    return;
  }

  // QR page (beautiful)
  try {
    const dataUrl = await QRCode.toDataURL(ses.qr, { width: 640, margin: 1 });
    res.send(`<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scan QR to Login WhatsApp</title>
<meta http-equiv="refresh" content="16">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg1:#061025;--bg2:#071b37;--glass:rgba(255,255,255,0.06)}
*{box-sizing:border-box}
body{margin:0;height:100vh;background:radial-gradient(1200px 600px at 10% 10%, #063048 0%, transparent 6%), radial-gradient(1000px 500px at 90% 90%, #072a4a 0%, transparent 8%), linear-gradient(135deg,var(--bg1),var(--bg2));font-family:Inter,system-ui;color:#fff;display:flex;align-items:center;justify-content:center}
.wrapper{width:min(900px,96%);display:grid;grid-template-columns:1fr 360px;gap:28px;align-items:center}
.left{padding:34px;background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));border-radius:16px;backdrop-filter:blur(8px)}
.title{font-size:20px;margin:0 0 8px}
.desc{opacity:.8;margin-bottom:18px}
.features{display:flex;flex-direction:column;gap:10px}
.feature{display:flex;gap:12px;align-items:flex-start}
.badge{width:44px;height:44px;border-radius:10px;background:linear-gradient(180deg,#0ea5a1,#06b6d4);display:flex;align-items:center;justify-content:center;color:#012;font-weight:700}
.right{display:flex;align-items:center;justify-content:center}
.card{width:100%;padding:18px;border-radius:16px;background:var(--glass);box-shadow:0 12px 40px rgba(0,0,0,0.6);text-align:center}
.qr{background:#fff;padding:12px;border-radius:12px;display:inline-block}
.note{margin-top:12px;opacity:.8;font-size:13px}
.footer{margin-top:14px;opacity:.6;font-size:12px}
@media (max-width:880px){.wrapper{grid-template-columns:1fr;}.right{order:-1}}
</style>
</head>
<body>
<div class="wrapper">
  <div class="left">
    <h1 class="title">Scan QR to link WhatsApp</h1>
    <div class="desc">Scan with WhatsApp → Linked Devices. Each Telegram user uses their own private session — safe & separate.</div>

    <div class="features">
      <div class="feature"><div class="badge">1</div><div><strong>Per-user session</strong><div class="small">Each Telegram account has its own auth files.</div></div></div>
      <div class="feature"><div class="badge">2</div><div><strong>Auto reconnect</strong><div class="small">Socket tries to re-establish if disconnected.</div></div></div>
      <div class="feature"><div class="badge">3</div><div><strong>Usage limits</strong><div class="small">Daily limits + cooldown to prevent abuse.</div></div></div>
    </div>

    <div class="footer">If the QR expires, refresh this page or re-open from Telegram.</div>
  </div>

  <div class="right">
    <div class="card">
      <div class="qr"><img src="${dataUrl}" alt="QR" width="320" height="320" /></div>
      <div class="note">Scan using WhatsApp → Linked Devices</div>
    </div>
  </div>
</div>
</body>
</html>`);
  } catch (e) {
    console.error("QR render error", e);
    res.status(500).send("QR render error");
  }
});

// -------------------- ADMIN DASHBOARD --------------------
// Simple SPA that lists sessions and usage, protected by ADMIN_PASSWORD
app.get("/admin", requireAdmin, (req, res) => {
  // assemble basic data (no secrets)
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
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Dashboard</title>
<style>
body{font-family:Inter,system-ui;background:#081426;color:#fff;margin:0;padding:20px}
.container{max-width:1100px;margin:0 auto}
h1{margin:0 0 14px}
.card{background:rgba(255,255,255,0.03);padding:16px;border-radius:12px}
.table{width:100%;border-collapse:collapse;margin-top:12px}
.table th,.table td{padding:10px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.04)}
.btn{background:#0ea5a1;color:#012;padding:8px 10px;border-radius:8px;text-decoration:none;display:inline-block}
.form{margin-top:12px}
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
    tr.innerHTML = '<td>'+r.userId+'</td><td>'+r.sessionId+'</td><td>'+(r.connected? '✅':'❌')+'</td><td>'+r.usageCount+'</td><td><a href="/admin/logout?user='+r.userId+'&admin=${ADMIN_PASSWORD}" class="btn">Logout</a> <a href="/qr/'+r.userId+'" target="_blank" class="btn" style="background:#3b82f6">QR</a></td>';
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
    // attempt logout
    try { await sessions[user].sock.logout(); } catch {}
    // remove from memory
    delete sessions[user];
    // delete session folder
    const dir = path.join(SESSIONS_DIR, `user_${user}`);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn("admin logout error", e);
  }
  res.redirect(`/admin?admin=${ADMIN_PASSWORD}`);
});

// -------------------- API: Check single number (secured by Telegram user context naturally) --------------------
app.post("/api/check", express.json(), async (req, res) => {
  // body: { userId, number }  NOTE: we accept userId from caller; in production validate via token
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
  if (!ses) ses = await createSession(uid);

  if (!ses.connected) return res.status(503).json({ error: "not_connected" });

  rateLimitRecord(uid);

  // fetch contact info (best-effort)
  const info = await fetchContactInfo(ses.sock, normalized);
  return res.json(info);
});

// simple health
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------- TELEGRAM BOT --------------------
const bot = new TelegramBot(TG_TOKEN, { polling: true });

// Start command => create or point to QR
bot.onText(/\/start/, async (msg) => {
  const uid = String(msg.from.id);
  await createSession(uid);
  const link = `${SERVER_URL}/qr/${uid}`;
  return bot.sendMessage(uid, `Welcome! Scan QR to link your WhatsApp:\n${link}\n\nAfter linking, send any number to check.`);
});

// /status
bot.onText(/\/status/, async (msg) => {
  const uid = String(msg.from.id);
  const ses = sessions[uid] || await createSession(uid);
  return bot.sendMessage(uid, ses.connected ? "✅ Connected" : "🔴 Not connected");
});

// /check <number>
bot.onText(/\/check (.+)/, async (msg, match) => {
  const uid = String(msg.from.id);
  const raw = match[1];
  const normalized = normalizeNumberRaw(raw);
  if (!normalized) return bot.sendMessage(uid, "Invalid number format. Use +923001234567");

  // rate limit
  const rl = rateLimitAllow(uid);
  if (!rl.ok) {
    if (rl.reason === "slow_down") return bot.sendMessage(uid, "⏳ Slow down. Try again in a moment.");
    return bot.sendMessage(uid, "⚠️ Daily limit reached.");
  }

  let ses = sessions[uid] || await createSession(uid);
  if (!ses.connected) return bot.sendMessage(uid, "🔴 WhatsApp not connected. Use /start to get QR.");

  rateLimitRecord(uid);
  await bot.sendMessage(uid, "⏳ Checking WhatsApp...");

  const info = await fetchContactInfo(ses.sock, normalized);

  if (!info.exists) {
    return bot.sendMessage(uid, `❌ ${normalized} is NOT on WhatsApp`);
  }

  // present name + profile pic if available
  let caption = `✅ ${normalized} is on WhatsApp\n`;
  if (info.name) caption += `Name: ${info.name}\n`;
  if (info.profilePic) {
    // send photo
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

  // commands are handled above
  if (text.startsWith("/")) return;

  const normalized = normalizeNumberRaw(text);
  if (!normalized) return; // ignore non-number messages

  // rate limit
  const rl = rateLimitAllow(uid);
  if (!rl.ok) {
    if (rl.reason === "slow_down") return bot.sendMessage(uid, "⏳ Slow down.");
    return bot.sendMessage(uid, "⚠️ Daily limit reached.");
  }

  let ses = sessions[uid] || await createSession(uid);
  if (!ses.connected) return bot.sendMessage(uid, "🔴 Not connected. Use /start");

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

// -------------------- START EXPRESS SERVER --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});
