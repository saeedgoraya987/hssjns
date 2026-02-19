import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@itsukichan/baileys";

import P from "pino";

const phoneNumber = "923091731496"; // CHANGE THIS

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  // 🔹 Request pairing code only once after socket created
  if (!sock.authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(phoneNumber);
      console.log("\n🔐 YOUR PAIRING CODE:\n");
      console.log(code);
      console.log("\nOpen WhatsApp → Linked Devices → Link with phone number\n");
    } catch (err) {
      console.log("❌ Pairing error:", err?.message);
    }
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ WhatsApp linked successfully!");
    }

    if (connection === "close") {
      console.log("❌ Connection closed.");
      if (lastDisconnect?.error) {
        console.log("Reason:", lastDisconnect.error?.message);
      }
    }
  });
}

start();
