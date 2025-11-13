import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState
} from "@whiskeysockets/baileys";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import TelegramBot from "node-telegram-bot-api";

// -----------------------------
// Basic Setup
// -----------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const TG_TOKEN = "8433791774:AAGag52ZHTy_fpRqadc8CB_K-ckP5HqoSOc";
const bot = new TelegramBot(TG_TOKEN, { polling: true });

const sessions = {};   // { telegramUserId: { sock, qr, connected, sessionId } }

// -----------------------------
// HELPERS
// -----------------------------

function normalize(num) {
    if (!num) return null;
    let s = num.replace(/\s+/g, "").replace(/-/g, "");
    return /^\+?\d{8,18}$/.test(s) ? s : null;
}

async function isWhatsapp(sock, number) {
    try {
        const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
        const r = await sock.onWhatsApp(jid);
        return r[0]?.exists ? true : false;
    } catch {
        return false;
    }
}

// -----------------------------
// CREATE NEW SESSION FOR USER
// -----------------------------
async function createSession(userId) {
    const sessionId = "user_" + userId;

    const folder = path.join(__dirname, "sessions", sessionId);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(folder);
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

    sock.ev.on("connection.update", (u) => {
        const { connection, qr, lastDisconnect } = u;

        if (qr) latestQR = qr;

        if (connection === "open") {
            connected = true;
            latestQR = null;
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            connected = false;

            if (code !== DisconnectReason.loggedOut) {
                createSession(userId);
            }
        }
    });

    sessions[userId] = { sock, qr: latestQR, connected, sessionId };

    return sessions[userId];
}

// -----------------------------
// EXPRESS: QR PAGE PER USER
// -----------------------------
app.get("/qr/:userId", async (req, res) => {
    const userId = req.params.userId;

    let ses = sessions[userId];
    if (!ses) ses = await createSession(userId);

    if (ses.connected) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding-top:100px">
                <h2>✅ Connected to WhatsApp</h2>
                <p>User ID: ${userId}</p>
            </body></html>
        `);
    }

    if (!ses.qr) {
        return res.send(`
            <html><meta http-equiv="refresh" content="4">
            <body style="font-family:sans-serif;text-align:center;padding-top:100px">
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

    const qrLink = `http://YOUR_SERVER_IP:8000/qr/${uid}`;

    bot.sendMessage(
        uid,
        "👋 *Welcome!*\n\n" +
        "Each user has their *own WhatsApp session*.\n" +
        "Scan your QR to login:\n\n" +
        `🔗 *Your QR:* ${qrLink}\n\n` +
        "After login, send any number to check WhatsApp registration.\n\n" +
        "*Example:*\n`+923001234567`",
        { parse_mode: "Markdown" }
    );
});

// STATUS
bot.onText(/\/status/, async (msg) => {
    const uid = msg.from.id;

    let ses = sessions[uid];
    if (!ses) ses = await createSession(uid);

    if (ses.connected)
        bot.sendMessage(uid, "🟢 *WhatsApp Connected*", { parse_mode: "Markdown" });
    else
        bot.sendMessage(uid, "🔴 *Not Connected*\nUse /start to scan QR", {
            parse_mode: "Markdown",
        });
});

// CHECK COMMAND
bot.onText(/\/check (.+)/, async (msg, match) => {
    const uid = msg.from.id;
    let number = match[1].trim();

    number = normalize(number);
    if (!number) return bot.sendMessage(uid, "❌ Invalid number.");

    let ses = sessions[uid];
    if (!ses) ses = await createSession(uid);

    if (!ses.connected)
        return bot.sendMessage(uid, "❌ Not connected. Use /start");

    bot.sendMessage(uid, "⏳ Checking WhatsApp…");

    const exists = await isWhatsapp(ses.sock, number);

    if (exists)
        bot.sendMessage(uid, `✅ *${number} is on WhatsApp*`, { parse_mode: "Markdown" });
    else
        bot.sendMessage(uid, `❌ *${number} is NOT on WhatsApp*`, { parse_mode: "Markdown" });
});

// AUTO CHECK — ANY MESSAGE
bot.on("message", async (msg) => {
    const uid = msg.from.id;
    const text = msg.text?.trim();

    if (!text || text.startsWith("/")) return;

    const number = normalize(text);
    if (!number) return bot.sendMessage(uid, "❌ Invalid number format.");

    let ses = sessions[uid];
    if (!ses) ses = await createSession(uid);

    if (!ses.connected)
        return bot.sendMessage(uid, "🔴 Not connected. Use /start");

    bot.sendMessage(uid, "⏳ Checking WhatsApp…");

    const exists = await isWhatsapp(ses.sock, number);

    if (exists)
        bot.sendMessage(uid, `✅ *${number} is on WhatsApp*`, { parse_mode: "Markdown" });
    else
        bot.sendMessage(uid, `❌ *${number} is NOT on WhatsApp*`, { parse_mode: "Markdown" });
});

// -----------------------------
const PORT = 8000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
