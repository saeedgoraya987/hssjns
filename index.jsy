import express from "express";
import cors from "cors";
import pLimit from "p-limit";
import * as QRCode from "qrcode";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------- basic setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- config ----------
const MAX_CONCURRENCY = 16;                 // tweak for speed
const PHONE_RE = /^\+?\d{8,18}$/;           // simple validation
const limit = pLimit(MAX_CONCURRENCY);

// ---------- helpers ----------
const normalizeNumber = (raw) => {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim().replace(/[()\-\s]/g, "");
  return PHONE_RE.test(s) ? s : null;
};
const toJid = (number) => number.replace(/\D/g, "") + "@s.whatsapp.net";
const envelopeError = (statusCode, path, message) => ({
  statusCode,
  timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  path,
  message
});

// ---------- Baileys lifecycle ----------
let sock = null;
let connectionState = { connected: false, lastDisconnect: null };
let latestQR = null; // store the most recent QR string from Baileys

async function startBaileys() {
  const authDir = path.join(__dirname, "auth");
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true, // also prints QR in the server logs
    browser: ["API", "Chrome", "1.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) latestQR = qr;

    if (connection === "open") {
      connectionState = { connected: true, lastDisconnect: null };
      latestQR = null; // clear QR on successful connect
      console.log("✅ WhatsApp connected.");
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      connectionState = { connected: false, lastDisconnect: code || "unknown" };
      console.log("❌ Connection closed:", code);

      if (code !== DisconnectReason.loggedOut) {
        // attempt to reconnect
        try { await startBaileys(); } catch (e) { console.error("reconnect fail", e); }
      } else {
        console.log("Logged out. Delete ./auth to re-link.");
      }
    }
  });
}
await startBaileys();

// ---------- routes ----------

// health & status
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    connected: connectionState.connected,
    lastDisconnect: connectionState.lastDisconnect ? String(connectionState.lastDisconnect) : null
  });
});

// --- UPDATED: render QR as an IMAGE page (not JSON) ---
app.get("/auth/qr", async (req, res) => {
  if (connectionState.connected) {
    res.send(`
      <html>
        <head><title>WhatsApp QR</title></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
          <h2>✅ WhatsApp is already connected.</h2>
        </body>
      </html>
    `);
    return;
  }

  if (!latestQR) {
    res.send(`
      <html>
        <head><title>WhatsApp QR</title>
          <meta http-equiv="refresh" content="5">
        </head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
          <h2>⏳ QR not generated yet. This page refreshes every 5s…</h2>
        </body>
      </html>
    `);
    return;
  }

  try {
    const dataUrl = await QRCode.toDataURL(latestQR, { margin: 1, width: 320 });
    res.send(`
      <html>
        <head>
          <title>WhatsApp QR</title>
          <!-- auto-refresh every 15s because QR expires quickly -->
          <meta http-equiv="refresh" content="15">
        </head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
          <h2>Scan this QR with WhatsApp → Linked Devices</h2>
          <img src="${dataUrl}" alt="WhatsApp QR" style="width:320px;height:320px" />
          <p style="margin-top:10px;color:#666">This page auto-refreshes to keep the QR fresh.</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send("Error generating QR image");
  }
});

// check a single number
// body: { "number": "+13039003684" }
app.post("/check", async (req, res) => {
  if (!connectionState.connected) {
    return res.status(503).json(envelopeError(503, req.path, "WhatsApp not connected; open /auth/qr and scan the code"));
  }
  const raw = req.body?.number;
  const number = normalizeNumber(raw);
  if (!number) {
    return res.status(422).json(envelopeError(422, req.path, "Invalid 'number' (expected +optional and 8–18 digits)"));
  }

  try {
    const resultArr = await sock.onWhatsApp(toJid(number));
    const exists = Array.isArray(resultArr) && resultArr[0] ? Boolean(resultArr[0].exists) : false;
    return res.json({ number, existsWhatsapp: exists });
  } catch (e) {
    return res.status(502).json(envelopeError(502, req.path, "Baileys error: " + String(e)));
  }
});

// batch check many numbers
// body: { "numbers": ["+13039003684", "+441234567890", ...] }
app.post("/batch", async (req, res) => {
  if (!connectionState.connected) {
    return res.status(503).json(envelopeError(503, req.path, "WhatsApp not connected; open /auth/qr and scan the code"));
  }

  const arr = Array.isArray(req.body?.numbers) ? req.body.numbers : null;
  if (!arr || arr.length === 0) {
    return res.status(422).json(envelopeError(422, req.path, "'numbers' must be a non-empty array"));
  }

  const indexed = arr.map((raw, i) => ({ raw, i, number: normalizeNumber(raw) }))
                     .filter(x => !!x.number);

  try {
    const results = await Promise.all(indexed.map((item) =>
      limit(async () => {
        try {
          const r = await sock.onWhatsApp(toJid(item.number));
          const exists = Array.isArray(r) && r[0] ? Boolean(r[0].exists) : false;
          return { idx: item.i, number: item.number, existsWhatsapp: exists, statusCode: 200, message: "" };
        } catch (e) {
          return { idx: item.i, number: item.number, existsWhatsapp: undefined, statusCode: 502, message: String(e) };
        }
      })
    ));

    // place back into original order and mark invalids
    const out = arr.map((raw, i) => {
      const ok = results.find(r => r.idx === i);
      if (ok) return { number: ok.number, existsWhatsapp: ok.existsWhatsapp, statusCode: ok.statusCode, message: ok.message };
      return { number: String(raw), existsWhatsapp: undefined, statusCode: 422, message: "Invalid number format" };
    });

    return res.json({ count: out.length, results: out });
  } catch (e) {
    return res.status(500).json(envelopeError(500, req.path, "Batch failed: " + String(e)));
  }
});

// fallback error handler
app.use((err, req, res, _next) => {
  console.error("Unhandled:", err);
  res.status(400).json(envelopeError(400, req?.path || "/", "Unexpected error"));
});

// start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`HTTP API listening on http://0.0.0.0:${PORT}`));
