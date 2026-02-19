import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@itsukichan/baileys";

import P from "pino";

const phoneNumber = "923091731496"; // change

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

  let pairingRequested = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection } = update;

    if (connection === "connecting" && !pairingRequested) {
      pairingRequested = true;

      if (!sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(phoneNumber);

          console.log("\n🔐 PAIRING CODE:\n");
          console.log(code);
          console.log("\nOpen WhatsApp → Linked Devices → Link with phone number\n");
        } catch (err) {
          console.log("❌ Pairing error:", err?.message);
        }
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
