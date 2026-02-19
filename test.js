import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import P from "pino";

// 🔴 CHANGE THIS — full international format, NO +
// Example: 923001234567
const phoneNumber = "923091731496";

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["PairingBot", "Chrome", "1.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection } = update;

    if (connection === "connecting") {
      if (!sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(phoneNumber);

          console.log("\n🔐 YOUR PAIRING CODE:\n");
          console.log(code);
          console.log("\nOpen WhatsApp → Linked Devices → Link with phone number\n");
        } catch (err) {
          console.log("❌ Failed to generate pairing code:");
          console.log(err.message);
        }
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp successfully linked!");
    }

    if (connection === "close") {
      console.log("❌ Connection closed.");
    }
  });
}

start();
