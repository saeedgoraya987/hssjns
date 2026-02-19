import baileys from "@itsukichan/baileys";
import P from "pino";

const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = baileys;

// 🔥 Fix for default export
const makeWASocket = baileys.default || baileys;

const phoneNumber = "923091831496"; // change

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

  if (!sock.authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(phoneNumber);
      console.log("\n🔐 PAIRING CODE:\n");
      console.log(code);
      console.log("\nWhatsApp → Linked Devices → Link with phone number\n");
    } catch (err) {
      console.log("❌ Pairing error:", err?.message);
    }
  }

  sock.ev.on("connection.update", ({ connection }) => {
    if (connection === "open") {
      console.log("✅ Linked successfully!");
    }
    if (connection === "close") {
      console.log("❌ Connection closed.");
    }
  });
}

start();
