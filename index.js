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

// -----------------------------
// BASICS
// -----------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const TG_TOKEN = "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc";  // CHANGE THIS
const SERVER_URL = "https://wpchecker.up.railway.app"; // CHANGE THIS

const bot = new TelegramBot(TG_TOKEN, { polling: true });

const sessions = {}; // each Telegram user --> own WhatsApp session

// -----------------------------
// HELPERS
// -----------------------------
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
    } catch (e) {
        return false;
    }
}

// -----------------------------
// SESSION CREATION
// -----------------------------
async function createSession(userId) {
    const sessionId = `user_${userId}`;
    const sessionDir = path.join(__dirname, "sessions", sessionId);

    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    let latestQR = null;
    let connected = false;

    const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        browser: ["MultiSessionBot", "Chrome", "1.0"]
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
            console.log(`User ${userId} connected to WhatsApp.`);
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            connected = false;
            sessions[userId].connected = false;

            console.log(`User ${userId} disconnected:`, code);

            if (code !== DisconnectReason.loggedOut) {
                console.log("Reconnecting...");
                await new Promise(r => setTimeout(r, 2000));
                createSession(userId);
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

// -----------------------------
// QR PAGE FOR USER
// -----------------------------
app.get("/qr/:userId", async (req, res) => {
    const userId = req.params.userId;

    let ses = sessions[userId];
    if (!ses) ses = await createSession(userId);

    if (ses.connected) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding-top:50px">
            <h2>✅ WhatsApp Connected</h2>
            </body></html>
        `);
    }

    if (!ses.qr) {
        return res.send(`
            <html><meta http-equiv="refresh" content="5">
            <body style="text-align:center;font-family:sans-serif;padding-top:50px">
            <h2>⏳ Waiting for QR…</h2>
            </body></html>
        `);
    }

    const dataUrl = await QRCode.toDataURL(ses.qr);

    res.send(`
        <html><meta http-equiv="refresh" content="10">
        <body style="text-align:center;font-family:sans-serif;padding-top:50px">
            <h2>Scan QR to Login WhatsApp</h2>
            <img src="${dataUrl}" width="300" />
        </body></html>
    `);
});

// -----------------------------
// TELEGRAM BOT COMMANDS
// -----------------------------
bot.onText(/\/start/, async (msg) => {
    const uid = msg.from.id;

    if (!sessions[uid]) await createSession(uid);

    const qrLink = `${SERVER_URL}/qr/${uid}`;

    bot.sendMessage(
        uid,
        `👋 *Welcome!*\n\nScan your WhatsApp QR here:\n${qrLink}\n\nAfter login, send any number.\nExample:\n\`+923001234567\``,
        { parse_mode: "Markdown" }
    );
});

bot.onText(/\/status/, async (msg) => {
    const uid = msg.from.id;

    let ses = sessions[uid];
    if (!ses) ses = await createSession(uid);

    if (ses.connected)
        bot.sendMessage(uid, "🟢 *WhatsApp CONNECTED*", { parse_mode: "Markdown" });
    else
        bot.sendMessage(uid, "🔴 *WhatsApp NOT connected*\nUse /start", {
            parse_mode: "Markdown"
        });
});

bot.onText(/\/check (.+)/, async (msg, match) => {
    const uid = msg.from.id;
    let number = normalize(match[1].trim());

    if (!number)
        return bot.sendMessage(uid, "❌ Invalid number.");

    let ses = sessions[uid];
    if (!ses) ses = await createSession(uid);

    if (!ses.connected)
        return bot.sendMessage(uid, "❌ WhatsApp not connected. Use /start");

    bot.sendMessage(uid, "⏳ Checking WhatsApp…");

    const exists = await isWhatsapp(ses.sock, number);

    if (exists)
        bot.sendMessage(uid, `✅ *${number} is on WhatsApp*`, { parse_mode: "Markdown" });
    else
        bot.sendMessage(uid, `❌ *${number} is NOT on WhatsApp*`, { parse_mode: "Markdown" });
});

// Auto-check numbers
bot.on("message", async (msg) => {
    const uid = msg.from.id;
    const text = msg.text?.trim();

    if (!text || text.startsWith("/")) return;

    const number = normalize(text);
    if (!number) return bot.sendMessage(uid, "❌ Invalid number.");

    let ses = sessions[uid];
    if (!ses) ses = await createSession(uid);

    if (!ses.connected)
        return bot.sendMessage(uid, "❌ WhatsApp not connected. Use /start");

    bot.sendMessage(uid, "⏳ Checking WhatsApp…");

    const exists = await isWhatsapp(ses.sock, number);

    if (exists)
        bot.sendMessage(uid, `✅ *${number} is on WhatsApp*`, { parse_mode: "Markdown" });
    else
        bot.sendMessage(uid, `❌ *${number} is NOT on WhatsApp*`, { parse_mode: "Markdown" });
});

// -----------------------------
// START SERVER
// -----------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port", PORT);
});
