import express from "express";
import cors from "cors";
import pLimit from "p-limit";
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

async function startBaileys() {
  const authDir = path.join(__dirname, "auth");
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // QR is no longer used
    browser: ["API", "Chrome", "1.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect } = u;
    // ignore qr events – we use pairing code instead

    if (connection === "open") {
      connectionState = { connected: true, lastDisconnect: null };
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

// --- PAIRING CODE page (replaces QR) ---
app.get("/auth/qr", async (req, res) => {
  // If already connected, no need for pairing
  if (connectionState.connected) {
    res.send(`
      <html>
        <head><title>WhatsApp Pairing</title></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
          <h2>✅ WhatsApp is already connected.</h2>
        </body>
      </html>
    `);
    return;
  }

  const phoneRaw = req.query.phone;
  // If no phone number provided, show a simple form
  if (!phoneRaw) {
    res.send(`
      <html>
        <head><title>WhatsApp Pairing</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
          <h2>Enter your phone number to receive a pairing code</h2>
          <form method="get" style="margin-top:20px">
            <input type="text" name="phone" placeholder="e.g. +1234567890" 
                   style="padding:10px;width:250px;font-size:16px" />
            <button type="submit" style="padding:10px 20px;font-size:16px;margin-left:10px">Get Code</button>
          </form>
          <p style="color:#666;margin-top:20px">Include country code, no spaces or dashes.</p>
        </body>
      </html>
    `);
    return;
  }

  // Normalize and validate the phone number
  const number = normalizeNumber(phoneRaw);
  if (!number) {
    res.status(400).send(`
      <html>
        <head><title>WhatsApp Pairing</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
          <h2 style="color:red">Invalid phone number format</h2>
          <p>Please use international format, e.g. +1234567890</p>
          <a href="/auth/qr">Try again</a>
        </body>
      </html>
    `);
    return;
  }

  try {
    // Request a pairing code from WhatsApp
    const pairingCode = await sock.requestPairingCode(number);
    // The code is usually returned as a string like "ABCD-EFGH"
    res.send(`
      <html>
        <head>
          <title>WhatsApp Pairing Code</title>
          <meta http-equiv="refresh" content="60"> <!-- optional: refresh after 1 minute -->
        </head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
          <h2>Your pairing code</h2>
          <div style="font-size:48px;letter-spacing:8px;background:#f0f0f0;padding:20px;border-radius:8px;margin:20px">
            ${pairingCode}
          </div>
          <p>Open WhatsApp on your phone → Linked Devices → Link a Device</p>
          <p style="color:#666">Enter the code above. This page will refresh in 60 seconds if not used.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Pairing code error:", err);
    res.status(500).send(`
      <html>
        <head><title>WhatsApp Pairing</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
          <h2 style="color:red">Failed to generate pairing code</h2>
          <p>${err.message || "Unknown error"}</p>
          <a href="/auth/qr">Try again</a>
        </body>
      </html>
    `);
  }
});

// check a single number
// body: { "number": "+13039003684" }
app.post("/check", async (req, res) => {
  if (!connectionState.connected) {
    return res.status(503).json(envelopeError(503, req.path, "WhatsApp not connected; open /auth/qr and pair your phone"));
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
    return res.status(503).json(envelopeError(503, req.path, "WhatsApp not connected; open /auth/qr and pair your phone"));
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
