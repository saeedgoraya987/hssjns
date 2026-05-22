import express from "express";
import cors from "cors";
import pLimit from "p-limit";
import * as QRCode from "qrcode";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore
} from "@alannxd/baileys";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import NodeCache from "node-cache";
import pino from "pino";

// ---------- basic setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- config ----------
const MAX_CONCURRENCY = 16;
const PHONE_RE = /^\+?\d{8,18}$/;
const limit = pLimit(MAX_CONCURRENCY);
const PORT = process.env.PORT || 8080;

// Custom pairing code configuration
const USE_CUSTOM_PAIRING = process.env.USE_CUSTOM_PAIRING === "true";
const CUSTOM_PAIRING_CODE = process.env.CUSTOM_PAIRING_CODE || "12345678";

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

// ---------- Simple logger for production ----------
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV === "production" ? undefined : {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

// ---------- Baileys lifecycle ----------
let sock = null;
let connectionState = { connected: false, lastDisconnect: null };
let latestQR = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const msgRetryCounterCache = new NodeCache();

async function startBaileys() {
  // Don't try to reconnect if we already have a connection in progress
  if (sock && sock.user) {
    logger.info("Socket already exists, skipping...");
    return;
  }

  try {
    const authDir = path.join(__dirname, "auth");
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    // Check if we're already logged in
    if (state.creds.registered) {
      logger.info("Found existing session, attempting to connect...");
    }

    const { version } = await fetchLatestBaileysVersion();
    logger.info(`Using Baileys version: ${version.join(".")}`);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: true,
      browser: ["API", "Chrome", "1.0"],
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      qrTimeout: 40000,
      defaultQueryTimeoutMs: 60000,
      // Pairing code configuration
      pairingCode: USE_CUSTOM_PAIRING ? CUSTOM_PAIRING_CODE : undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;
      
      if (qr) {
        latestQR = qr;
        logger.info("📱 New QR code received");
      }

      if (connection === "open") {
        connectionState = { connected: true, lastDisconnect: null };
        latestQR = null;
        reconnectAttempts = 0; // Reset reconnect attempts on successful connection
        logger.info("✅ WhatsApp connected successfully");
        
        try {
          logger.info(`👤 Connected as: ${sock.user?.name || 'Unknown'}`);
        } catch (e) {
          // Ignore
        }
      } else if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        connectionState = { 
          connected: false, 
          lastDisconnect: lastDisconnect?.error?.message || statusCode || "unknown" 
        };
        
        logger.warn(`❌ Connection closed: ${JSON.stringify(connectionState.lastDisconnect)}`);

        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000); // Exponential backoff, max 30s
          logger.info(`🔄 Reconnecting in ${delay/1000}s... (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          
          // Clean up old socket
          sock = null;
          
          setTimeout(() => {
            startBaileys().catch(err => {
              logger.error("Reconnection failed:", err.message);
            });
          }, delay);
        } else if (statusCode === DisconnectReason.loggedOut) {
          logger.info("🚫 Logged out. Delete the 'auth' folder to re-link.");
        } else {
          logger.error("❌ Max reconnection attempts reached. Please restart the service.");
        }
      } else if (connection === "connecting") {
        logger.info("🔄 Connecting to WhatsApp...");
      }
    });

  } catch (error) {
    logger.error(`Failed to initialize Baileys: ${error.message}`);
    logger.error(error.stack);
    
    // Retry with delay if it's an initialization error
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = Math.min(10000 * reconnectAttempts, 60000);
      logger.info(`Retrying initialization in ${delay/1000}s...`);
      setTimeout(() => {
        startBaileys().catch(err => {
          logger.error("Retry failed:", err.message);
        });
      }, delay);
    } else {
      logger.error("Max initialization attempts reached. Service will continue without WhatsApp.");
    }
  }
}

// Start the server first, then try to connect to WhatsApp
app.listen(PORT, () => {
  logger.info(`🚀 Server running on http://0.0.0.0:${PORT}`);
  logger.info(`📱 QR Code: http://0.0.0.0:${PORT}/auth/qr`);
  logger.info(`🔑 Pairing: http://0.0.0.0:${PORT}/auth/pair`);
  
  if (USE_CUSTOM_PAIRING) {
    logger.info(`⚡ Custom pairing code enabled: ${CUSTOM_PAIRING_CODE}`);
  }
  
  // Initialize WhatsApp connection after server is ready
  startBaileys().catch(err => {
    logger.error("Failed to start Baileys:", err.message);
  });
});

// ---------- routes ----------

// Health & status
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    connected: connectionState.connected,
    lastDisconnect: connectionState.lastDisconnect ? String(connectionState.lastDisconnect) : null,
    reconnectAttempts,
    user: sock?.user ? {
      name: sock.user.name,
      number: sock.user.id?.split(':')[0]
    } : null
  });
});

// QR Code page
app.get("/auth/qr", async (req, res) => {
  if (connectionState.connected) {
    res.send(`
      <html>
        <head><title>WhatsApp QR</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;margin:0">
          <div style="background:white;padding:2rem;border-radius:10px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,0.1)">
            <h2>✅ WhatsApp Connected</h2>
            <p>Connected as: ${sock?.user?.name || 'Unknown'}</p>
            <p><a href="/auth/pair">Switch to pairing code</a></p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  if (!latestQR) {
    res.send(`
      <html>
        <head><title>WhatsApp QR</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="5">
        </head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;margin:0">
          <div style="background:white;padding:2rem;border-radius:10px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,0.1)">
            <h2>⏳ Generating QR Code...</h2>
            <p>This page refreshes every 5 seconds</p>
            <p><a href="/auth/pair">Use pairing code instead</a></p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  try {
    const dataUrl = await QRCode.toDataURL(latestQR, { 
      margin: 2, 
      width: 400 
    });
    
    res.send(`
      <html>
        <head>
          <title>WhatsApp QR Code</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="20">
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #f0f2f5;
              padding: 20px;
            }
            .container {
              background: white;
              padding: 2rem;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              text-align: center;
              max-width: 450px;
              width: 100%;
            }
            img {
              border: 3px solid #25D366;
              border-radius: 10px;
              max-width: 100%;
              height: auto;
            }
            .hint { color: #666; margin-top: 1rem; font-size: 14px; }
            .pair-link { margin-top: 1rem; }
            .pair-link a { color: #128C7E; text-decoration: none; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>📱 Scan QR Code</h2>
            <p>Open WhatsApp → Settings → Linked Devices</p>
            <img src="${dataUrl}" alt="WhatsApp QR" />
            <p class="hint">Page auto-refreshes every 20 seconds</p>
            <p class="pair-link">
              <a href="/auth/pair">Use Pairing Code →</a>
            </p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    logger.error("QR generation error:", err);
    res.status(500).send("Error generating QR image");
  }
});

// JSON QR endpoint
app.get("/auth/qr-raw", async (req, res) => {
  if (connectionState.connected) {
    return res.json({ connected: true, qr: null });
  }
  
  if (!latestQR) {
    return res.json({ connected: false, qr: null, message: "QR not yet generated" });
  }
  
  try {
    const dataUrl = await QRCode.toDataURL(latestQR, { margin: 1, width: 320 });
    return res.json({ connected: false, qr: dataUrl });
  } catch (err) {
    return res.status(500).json({ error: "Failed to generate QR" });
  }
});

// Pairing code page
app.get("/auth/pair", async (req, res) => {
  if (connectionState.connected) {
    res.send(`
      <html>
        <head><title>WhatsApp Pairing</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;margin:0">
          <div style="background:white;padding:2rem;border-radius:10px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,0.1)">
            <h2>✅ WhatsApp Connected</h2>
            <p>Connected as: ${sock?.user?.name || 'Unknown'}</p>
            <p><a href="/auth/qr">Back to QR code</a></p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  res.send(`
    <html>
      <head>
        <title>WhatsApp Pairing Code</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            display: flex; 
            flex-direction: column;
            align-items: center; 
            justify-content: center; 
            min-height: 100vh; 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f0f2f5;
            padding: 20px;
          }
          .container {
            background: white;
            padding: 2rem;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 450px;
            width: 100%;
          }
          h2 { color: #075e54; margin-bottom: 1rem; text-align: center; }
          .info { color: #666; margin-bottom: 1rem; font-size: 14px; text-align: center; }
          input {
            width: 100%;
            padding: 12px;
            margin: 8px 0;
            border: 1px solid #ddd;
            border-radius: 5px;
            font-size: 16px;
          }
          button {
            width: 100%;
            padding: 12px;
            background: #25D366;
            color: white;
            border: none;
            border-radius: 5px;
            font-size: 16px;
            cursor: pointer;
            margin-top: 10px;
          }
          button:hover { background: #128C7E; }
          button:disabled { background: #ccc; cursor: not-allowed; }
          #result {
            margin-top: 15px;
            padding: 15px;
            border-radius: 5px;
            display: none;
            text-align: center;
          }
          .success { background: #d4edda; color: #155724; display: block !important; }
          .error { background: #f8d7da; color: #721c24; display: block !important; }
          .code-display {
            font-size: 48px;
            letter-spacing: 8px;
            font-weight: bold;
            color: #075e54;
            margin: 15px 0;
          }
          .qr-link { 
            margin-top: 15px; 
            text-align: center;
          }
          .qr-link a { color: #128C7E; text-decoration: none; }
          ${USE_CUSTOM_PAIRING ? `
            .custom-code-info { 
              background: #fff3cd; 
              color: #856404; 
              padding: 10px; 
              border-radius: 5px; 
              margin: 10px 0;
              font-size: 14px;
              text-align: center;
            }
          ` : ''}
        </style>
      </head>
      <body>
        <div class="container">
          <h2>🔑 WhatsApp Pairing</h2>
          <p class="info">Link your WhatsApp account using a pairing code</p>
          
          ${USE_CUSTOM_PAIRING ? `
            <div class="custom-code-info">
              ⚡ Custom pairing mode enabled<br>
              Your code: <strong>${CUSTOM_PAIRING_CODE}</strong>
            </div>
          ` : ''}
          
          <input type="text" id="phoneNumber" placeholder="Phone number (e.g., +1234567890)" />
          <button id="requestBtn" onclick="requestPairingCode()">
            Get Pairing Code
          </button>
          <div id="result"></div>
          <p class="qr-link">
            <a href="/auth/qr">← Use QR Code</a>
          </p>
        </div>

        <script>
          async function requestPairingCode() {
            const phoneNumber = document.getElementById('phoneNumber').value.trim();
            const resultDiv = document.getElementById('result');
            const requestBtn = document.getElementById('requestBtn');
            
            if (!phoneNumber) {
              resultDiv.className = 'error';
              resultDiv.textContent = '❌ Please enter a phone number';
              return;
            }

            const cleaned = phoneNumber.replace(/\\D/g, '');
            if (cleaned.length < 8 || cleaned.length > 18) {
              resultDiv.className = 'error';
              resultDiv.textContent = '❌ Invalid phone number format';
              return;
            }

            requestBtn.disabled = true;
            requestBtn.textContent = 'Requesting...';
            resultDiv.className = '';
            resultDiv.textContent = '⏳ Requesting pairing code...';
            resultDiv.style.display = 'block';

            try {
              const response = await fetch('/auth/pair-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber })
              });

              const data = await response.json();
              
              if (data.success) {
                resultDiv.className = 'success';
                resultDiv.innerHTML = \`
                  <strong>✅ Pairing Code:</strong>
                  <div class="code-display">\${data.code}</div>
                  <p>Enter this code in WhatsApp</p>
                  <small>Settings → Linked Devices → Link with Phone Number</small>
                \`;
              } else {
                resultDiv.className = 'error';
                resultDiv.textContent = '❌ ' + (data.message || 'Failed to get code');
              }
            } catch (error) {
              resultDiv.className = 'error';
              resultDiv.textContent = '❌ Error: ' + error.message;
            } finally {
              requestBtn.disabled = false;
              requestBtn.textContent = 'Get Pairing Code';
            }
          }
        </script>
      </body>
    </html>
  `);
});

// API endpoint for pairing code
app.post("/auth/pair-code", async (req, res) => {
  if (connectionState.connected) {
    return res.json({ success: false, message: "Already connected to WhatsApp" });
  }

  if (!sock) {
    return res.json({ success: false, message: "WhatsApp client not initialized yet. Please wait..." });
  }

  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.json({ success: false, message: "Phone number is required" });
  }

  try {
    const cleaned = phoneNumber.replace(/\D/g, "");
    
    if (cleaned.length < 8 || cleaned.length > 18) {
      return res.json({ success: false, message: "Invalid phone number format" });
    }

    logger.info(`Requesting pairing code for: ${cleaned}`);
    const code = await sock.requestPairingCode(cleaned);
    
    if (code) {
      logger.info(`Pairing code generated: ${code}`);
      return res.json({ 
        success: true, 
        code: code,
        message: "Enter this code in WhatsApp (Linked Devices → Link with Phone Number)" 
      });
    } else {
      return res.json({ 
        success: false, 
        message: "Failed to generate pairing code. Try scanning QR code instead." 
      });
    }
  } catch (error) {
    logger.error("Pairing code error:", error);
    return res.json({ 
      success: false, 
      message: "Error: " + error.message 
    });
  }
});

// Check single number
app.post("/check", async (req, res) => {
  if (!connectionState.connected) {
    return res.status(503).json(envelopeError(503, req.path, "WhatsApp not connected"));
  }
  
  const raw = req.body?.number;
  const number = normalizeNumber(raw);
  
  if (!number) {
    return res.status(422).json(envelopeError(422, req.path, "Invalid phone number format"));
  }

  try {
    const resultArr = await sock.onWhatsApp(toJid(number));
    const exists = Array.isArray(resultArr) && resultArr[0] ? Boolean(resultArr[0].exists) : false;
    return res.json({ number, existsWhatsapp: exists });
  } catch (e) {
    return res.status(502).json(envelopeError(502, req.path, "Baileys error: " + String(e)));
  }
});

// Batch check
app.post("/batch", async (req, res) => {
  if (!connectionState.connected) {
    return res.status(503).json(envelopeError(503, req.path, "WhatsApp not connected"));
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

// Logout
app.post("/auth/logout", async (req, res) => {
  if (sock && connectionState.connected) {
    try {
      await sock.logout();
      connectionState.connected = false;
      latestQR = null;
      reconnectAttempts = 0;
      return res.json({ success: true, message: "Logged out successfully" });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Logout failed: " + error.message });
    }
  }
  return res.json({ success: false, message: "Not connected" });
});

// Error handler
app.use((err, req, res, _next) => {
  logger.error("Unhandled error:", err);
  res.status(400).json(envelopeError(400, req?.path || "/", "Unexpected error"));
});
