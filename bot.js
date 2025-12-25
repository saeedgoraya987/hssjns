import TelegramBot from "node-telegram-bot-api";
import "dotenv/config";
import pLimit from "p-limit";

import { getOrCreateSession } from "./waSessionManager.js";
import { normalizeNumber, toJid } from "./utils.js";

const bot = new TelegramBot(process.env.TG_TOKEN, { polling: true });
const limit = pLimit(10);

// ---------- START ----------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🤖 *WhatsApp Checker Bot*

/link – Link WhatsApp (QR)
/pair <number> – Pair via code
/check <number> – Check single
/batch – Batch check

Each user has their own WhatsApp.`,
    { parse_mode: "Markdown" }
  );
});

// ---------- LINK VIA QR ----------
bot.onText(/\/link/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  await getOrCreateSession(userId, async (payload) => {
    if (payload.type === "qr") {
      await bot.sendPhoto(chatId, payload.data, {
        caption: "📱 Scan this QR in WhatsApp → Linked Devices"
      });
    } else {
      await bot.sendMessage(chatId, payload.data);
    }
  });
});

// ---------- PAIR VIA CODE ----------
bot.onText(/\/pair (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const number = normalizeNumber(match[1]);

  if (!number) {
    return bot.sendMessage(chatId, "❌ Invalid phone number");
  }

  const session = await getOrCreateSession(userId, (p) =>
    bot.sendMessage(chatId, p.data)
  );

  const code = await session.sock.requestPairingCode(number.replace("+", ""));
  bot.sendMessage(chatId, `📲 Pairing Code:\n\n*${code}*`, {
    parse_mode: "Markdown"
  });
});

// ---------- CHECK SINGLE ----------
bot.onText(/\/check (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const number = normalizeNumber(match[1]);

  if (!number) {
    return bot.sendMessage(chatId, "❌ Invalid number");
  }

  const session = await getOrCreateSession(userId, (p) =>
    bot.sendMessage(chatId, p.data)
  );

  if (!session.connected) {
    return bot.sendMessage(chatId, "❌ WhatsApp not linked. Use /link");
  }

  const res = await session.sock.onWhatsApp(toJid(number));
  const exists = res?.[0]?.exists;

  bot.sendMessage(
    chatId,
    exists ? "✅ On WhatsApp" : "❌ Not on WhatsApp"
  );
});

// ---------- BATCH ----------
bot.onText(/\/batch/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "📄 Send numbers separated by space or newline");
});

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const numbers = msg.text
    .split(/\s+/)
    .map(normalizeNumber)
    .filter(Boolean);

  if (!numbers.length) return;

  const session = await getOrCreateSession(userId, (p) =>
    bot.sendMessage(chatId, p.data)
  );

  if (!session.connected) {
    return bot.sendMessage(chatId, "❌ WhatsApp not linked");
  }

  const results = await Promise.all(
    numbers.map((n) =>
      limit(async () => {
        const r = await session.sock.onWhatsApp(toJid(n));
        return `${n}: ${r?.[0]?.exists ? "✅" : "❌"}`;
      })
    )
  );

  bot.sendMessage(chatId, results.join("\n"));
});
