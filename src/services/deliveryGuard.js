/**
 * Saka Fleet — delivery guard (v1.58.23)
 * --------------------------------------
 * Per-instance blocklist for recipients whose WhatsApp delivery permanently
 * fails (131026 = not on WhatsApp, 131047 = re-engagement required,
 * 131051 = unsupported message). A blocked recipient is not re-sent to until
 * the TTL passes, so a doomed target can never produce a retry storm
 * (live 2026-11-04: ~1 failed send every 7 seconds to the same number).
 * In-memory on purpose: no DDL, fail-open, per Cloud Run instance.
 */
const blocked = new Map();
const DEFAULT_HOURS = 24;

export const PERMANENT_FAILURE_CODES = new Set(['131026', '131047', '131051']);

export function normalizeRecipient(phone = '') {
  return String(phone || '').replace(/[^\d]/g, '');
}

export function markDeliveryBlocked(phone, code = null, { hours = Number(process.env.DELIVERY_BLOCK_HOURS || DEFAULT_HOURS) } = {}) {
  const key = normalizeRecipient(phone);
  if (!key) return false;
  if (code && !PERMANENT_FAILURE_CODES.has(String(code))) return false;
  const ttl = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS;
  blocked.set(key, { until: Date.now() + ttl * 60 * 60 * 1000, code: code ? String(code) : null });
  return true;
}

export function isDeliveryBlocked(phone = '') {
  const key = normalizeRecipient(phone);
  if (!key) return false;
  const entry = blocked.get(key);
  if (!entry) return false;
  if (Date.now() >= entry.until) { blocked.delete(key); return false; }
  return true;
}

export function clearDeliveryBlock(phone = '') {
  return blocked.delete(normalizeRecipient(phone));
}

export function deliveryBlockInfo(phone = '') {
  return blocked.get(normalizeRecipient(phone)) || null;
}

export default { markDeliveryBlocked, isDeliveryBlocked, clearDeliveryBlock, deliveryBlockInfo, normalizeRecipient, PERMANENT_FAILURE_CODES };