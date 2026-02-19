// ---- Baileys ----
import baileys from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

const sessions = new Map();

export async function getOrCreateSession(tgUserId, notify = async () => {}) {
  if (sessions.has(tgUserId)) return sessions.get(tgUserId);

  const baseDir = path.join("sessions", String(tgUserId));
  const authDir = path.join(baseDir, "auth");
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ["TelegramBot", "Chrome", "1.0"]
  });

  const session = { sock, connected: false };
  sessions.set(tgUserId, session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      const qr = await QRCode.toBuffer(u.qr);
      await notify({ type: "qr", data: qr });
    }

    if (u.connection === "open") {
      session.connected = true;
      await notify({ type: "text", data: "✅ WhatsApp linked successfully" });
    }

    if (u.connection === "close") {
      session.connected = false;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        sessions.delete(tgUserId);
      }
    }
  });

  return session;
}
