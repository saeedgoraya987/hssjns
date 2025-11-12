import express from "express";
import cors from "cors";
import pLimit from "p-limit";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- config ----------
const MAX_CONCURRENCY = 16;
const limit = pLimit(MAX_CONCURRENCY);
const PHONE_RE = /^\+?\d{8,18}$/;

// ---------- helpers ----------
const normalizeNumber = (raw) => {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[()\-\s]/g, "");
  return PHONE_RE.test(s) ? s : null;
};
const toJid = (num) => num.replace(/\D/g, "") + "@s.whatsapp.net";
const envelopeError = (statusCode, path, message) => ({
  statusCode,
  timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  path,
  message
});

// ---------- store sessions ----------
const sessions = {}; // sessionId → { sock, connectionState, pairingCode }

// ---------- start a session ----------
async function startSession(sessionId, phoneNumber) {
  if (sessions[sessionId]?.sock) return sessions[sessionId]; // already started

  const authDir = path.join(__dirname, "sessions", sessionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    browser: ["API", "Chrome", "1.0"],
    auth: state,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  const session = {
    id: sessionId,
    sock,
    connectionState: { connected: false, lastDisconnect: null },
    pairingCode: null,
    saveCreds,
  };
  sessions[sessionId] = session;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      session.connectionState = { connected: true, lastDisconnect: null };
      session.pairingCode = null;
      console.log(`✅ [${sessionId}] Connected`);
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      session.connectionState = { connected: false, lastDisconnect: code || "unknown" };
      console.log(`❌ [${sessionId}] Disconnected: ${code}`);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startSession(sessionId, phoneNumber), 5000);
      } else {
        console.log(`[${sessionId}] Logged out, delete auth folder to relink`);
      }
    }
  });

  // Only generate pairing code if not already paired
  if (!sock.authState.creds?.registered) {
    if (!phoneNumber) throw new Error("Phone number required for pairing code session.");
    const code = await sock.requestPairingCode(phoneNumber.replace(/\+/g, ""));
    session.pairingCode = code;
    console.log(`🔗 [${sessionId}] Pairing code for ${phoneNumber}: ${code}`);
  }

  return session;
}

// ---------- routes ----------

// Start a session (with pairing code)
app.post("/session/start/:id", async (req, res) => {
  const id = req.params.id;
  const phone = normalizeNumber(req.query.phone || req.body?.phone);
  if (!phone)
    return res.status(400).json(envelopeError(400, req.path, "Missing valid 'phone' (+XXXXXXXXXXX)"));

  try {
    const s = await startSession(id, phone);
    res.json({
      ok: true,
      session: id,
      connected: s.connectionState.connected,
      pairingCode: s.pairingCode || null,
      note: s.pairingCode
        ? "Enter this code in WhatsApp > Linked Devices > Link with phone number"
        : "Already linked"
    });
  } catch (e) {
    console.error(e);
    res.status(500).json(envelopeError(500, req.path, String(e)));
  }
});

// Get all sessions
app.get("/sessions", (req, res) => {
  const all = Object.entries(sessions).map(([id, s]) => ({
    id,
    connected: s.connectionState.connected,
    lastDisconnect: s.connectionState.lastDisconnect,
    pairingCode: s.pairingCode || null
  }));
  res.json({ count: all.length, sessions: all });
});

// Check single number
app.post("/:id/check", async (req, res) => {
  const id = req.params.id;
  const s = sessions[id];
  if (!s || !s.connectionState.connected)
    return res.status(503).json(envelopeError(503, req.path, "Session not connected"));
  const raw = req.body?.number;
  const number = normalizeNumber(raw);
  if (!number)
    return res.status(422).json(envelopeError(422, req.path, "Invalid number"));
  try {
    const resultArr = await s.sock.onWhatsApp(toJid(number));
    const exists = Array.isArray(resultArr) && resultArr[0] ? Boolean(resultArr[0].exists) : false;
    return res.json({ number, existsWhatsapp: exists });
  } catch (e) {
    return res.status(502).json(envelopeError(502, req.path, "Baileys error: " + String(e)));
  }
});

// Batch check
app.post("/:id/batch", async (req, res) => {
  const id = req.params.id;
  const s = sessions[id];
  if (!s || !s.connectionState.connected)
    return res.status(503).json(envelopeError(503, req.path, "Session not connected"));
  const arr = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
  if (arr.length === 0)
    return res.status(422).json(envelopeError(422, req.path, "'numbers' must be array"));

  const indexed = arr.map((raw, i) => ({ raw, i, number: normalizeNumber(raw) })).filter(x => !!x.number);

  try {
    const results = await Promise.all(indexed.map((item) =>
      limit(async () => {
        try {
          const r = await s.sock.onWhatsApp(toJid(item.number));
          const exists = Array.isArray(r) && r[0] ? Boolean(r[0].exists) : false;
          return { idx: item.i, number: item.number, existsWhatsapp: exists, statusCode: 200, message: "" };
        } catch (e) {
          return { idx: item.i, number: item.number, existsWhatsapp: undefined, statusCode: 502, message: String(e) };
        }
      })
    ));
    const out = arr.map((raw, i) => {
      const ok = results.find(r => r.idx === i);
      if (ok) return ok;
      return { number: String(raw), existsWhatsapp: undefined, statusCode: 422, message: "Invalid number format" };
    });
    res.json({ count: out.length, results: out });
  } catch (e) {
    res.status(500).json(envelopeError(500, req.path, String(e)));
  }
});

// Delete session
app.delete("/session/:id", async (req, res) => {
  const id = req.params.id;
  const s = sessions[id];
  if (!s) return res.status(404).json(envelopeError(404, req.path, "Session not found"));
  try {
    await s.sock.logout();
    delete sessions[id];
    res.json({ ok: true, deleted: id });
  } catch (e) {
    res.status(500).json(envelopeError(500, req.path, String(e)));
  }
});

// fallback
app.use((err, req, res, _next) => {
  console.error("Unhandled:", err);
  res.status(400).json(envelopeError(400, req?.path || "/", "Unexpected error"));
});

// start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Pairing Code API running at http://0.0.0.0:${PORT}`));
