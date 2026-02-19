import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import P from "pino";

const phoneNumber = "923091731496"; // CHANGE THIS

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update;

    if (qr) {
      // ignore QR
    }

    if (connection === "connecting") {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log("\n🔐 PAIRING CODE:\n", code);
        console.log("\nOpen WhatsApp → Linked Devices → Link with phone number\n");
      } catch (err) {
        console.log("❌ Pairing error:", err?.message);
      }
    }

    if (connection === "open") {
      console.log("✅ Linked successfully!");
    }

    if (connection === "close") {
      console.log("❌ Connection closed.");
    }
  });
}

start();
