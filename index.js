// ---------------------------------------------
// IMPORTS (Railway compatible)
// ---------------------------------------------
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

// ---------------------------------------------
// BASIC SETUP
// ---------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// ENV CONFIG
// -----------------------------
const TG_TOKEN = "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc"; // CHANGE ME
const SERVER_URL = "https://wpchecker.up.railway.app"; // CHANGE ME

const bot = new TelegramBot(TG_TOKEN, { polling: true });

const sessions = {};  // Multi session per user

// ---------------------------------------------
// HELPERS
// ---------------------------------------------
function normalize(num) {
    if (!num) return null;
    num = num.replace(/\s+/g, "").replace(/-/g, "");
    return /^\+?\d{8,18}$/.test(num) ? num : null;
}

async function isWhatsapp(sock, number) {
    try {
        const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
        const r = await sock.onWhatsApp(jid);
        return r[0]?.exists || false;
    } catch {
        return false;
    }
}

// ---------------------------------------------
// CREATE WA SESSION FOR TELEGRAM USER
// ---------------------------------------------
async function createSession(userId) {
    const sessionId = "user_" + userId;
    const sessionDir = path.join(__dirname, "sessions", sessionId);

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

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
        const { connection, qr, lastDisconnect } = u;

        if (qr) {
            latestQR = qr;
            sessions[userId].qr = qr;
        }

        if (connection === "open") {
            connected = true;
            sessions[userId].connected = true;
            sessions[userId].qr = null;
        }

        if (connection === "close") {
            connected = false;
            sessions[userId].connected = false;

            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                await createSession(userId);
            }
        }
    });

    sessions[userId] = {
        sock,
        qr: latestQR,
        connected,
        sessionId
    };

    return sessions[userId];
}

// ---------------------------------------------
// BEAUTIFUL QR PAGE
// ---------------------------------------------
app.get("/qr/:userId", async (req, res) => {
    const userId = req.params.userId;

    let ses = sessions[userId];
    if (!ses) ses = await createSession(userId);

    if (ses.connected) {
        return res.send(`
<!DOCTYPE html>
<html>
<head>
<title>WhatsApp Connected</title>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body {
   margin:0; padding:0;
   background:linear-gradient(135deg,#061224,#0f1b33);
   font-family: Poppins, sans-serif;
   display:flex; justify-content:center; align-items:center;
   height:100vh; color:white;
}
.card {
   background:rgba(255,255,255,0.08);
   padding:40px; border-radius:20px;
   backdrop-filter:blur(12px);
   text-align:center; width:300px;
}
h2 { margin:0 0 10px; }
p { opacity:0.7; }
</style>
</head>
<body>
  <div class="card">
     <h2>✅ Connected</h2>
     <p>Your WhatsApp is linked.</p>
  </div>
</body>
</html>
        `);
    }

    if (!ses.qr) {
        return res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Loading QR...</title>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<style>
body {
   background:#0d1528;
   color:white; display:flex;
   justify-content:center; align-items:center;
   height:100vh; font-family:Poppins,sans-serif;
}
.loading { font-size:24px; animation:blink 1s infinite; }
@keyframes blink {
  0%{opacity:0.4;}50%{opacity:1;}100%{opacity:0.4;}
}
</style>
</head>
<body>
  <div class="loading">⏳ Generating QR…</div>
</body>
</html>
        `);
    }

    const dataUrl = await QRCode.toDataURL(ses.qr);

    res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Scan WhatsApp QR</title>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="12">
<style>
body {
   margin:0; padding:0;
   background:linear-gradient(135deg,#0c1224,#0a0f1d);
   font-family:Poppins,sans-serif;
   color:white; display:flex;
   justify-content:center; align-items:center;
   height:100vh;
}
.card {
   background:rgba(255,255,255,0.10);
   padding:30px 35px;
   border-radius:20px;
   backdrop-filter:blur(10px);
   box-shadow:0 10px 30px rgba(0,0,0,0.4);
   animation:fade .5s ease-out;
}
@keyframes fade { from{opacity:0; transform:scale(.95);} to{opacity:1; transform:scale(1);} }
h2 { margin-bottom:20px; }
img {
   background:white; padding:10px;
   border-radius:12px; width:280px;
}
.note { color:#ccc; margin-top:10px; font-size:14px; }
</style>
</head>
<body>
   <div class="card">
      <h2>Scan QR to Login WhatsApp</h2>
      <img src="${dataUrl}" />
      <div class="note">QR refreshes automatically</div>
   </div>
</body>
</html>
    `);
});

// ---------------------------------------------
// TELEGRAM BOT COMMANDS
// ---------------------------------------------
bot.onText(/\/start/, async (msg) => {
    const uid = msg.from.id;

    if (!sessions[uid]) await createSession(uid);

    const link = `${SERVER_URL}/qr/${uid}`;

    bot.sendMessage(
        uid,
        `👋 *Welcome!*\nScan your WhatsApp QR here:\n${link}\n\nThen send any number to check WhatsApp.`,
        { parse_mode: "Markdown" }
    );
});

bot.on("message", async (msg) => {
    const uid = msg.from.id;
    const text = msg.text?.trim();
    if (!text || text.startsWith("/")) return;

    const number = normalize(text);
    if (!number) return bot.sendMessage(uid, "❌ Invalid number format");

    let ses = sessions[uid];
    if (!ses) ses = await createSession(uid);

    if (!ses.connected)
        return bot.sendMessage(uid, "❌ WhatsApp not connected. Use /start");

    bot.sendMessage(uid, "⏳ Checking…");

    const exists = await isWhatsapp(ses.sock, number);

    if (exists)
        bot.sendMessage(uid, `✅ *${number} is on WhatsApp*`, { parse_mode: "Markdown" });
    else
        bot.sendMessage(uid, `❌ *${number} is NOT on WhatsApp*`, { parse_mode: "Markdown" });
});

// ---------------------------------------------
// START SERVER (RAILWAY SAFE)
// ---------------------------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port:", PORT);
});
