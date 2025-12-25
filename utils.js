export const PHONE_RE = /^\+?\d{8,18}$/;

export const normalizeNumber = (raw) => {
  if (!raw) return null;
  const s = String(raw).replace(/[^\d+]/g, "");
  return PHONE_RE.test(s) ? s : null;
};

export const toJid = (n) => n.replace(/\D/g, "") + "@s.whatsapp.net";
