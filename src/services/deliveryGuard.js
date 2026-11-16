/**
 * Saka Fleet — delivery guard (v1.58.23; superadmin exemption v1.97.9)
 * -------------------------------------------------------------------
 * Per-instance blocklist for recipients whose WhatsApp delivery permanently
 * fails (131026 = not on WhatsApp, 131047 = re-engagement required,
 * 131051 = unsupported message). A blocked recipient is not re-sent to until
 * the TTL passes, so a doomed target can never produce a retry storm
 * (live 2026-11-04: ~1 failed send every 7 seconds to the same number).
 * In-memory on purpose: no DDL, fail-open, per Cloud Run instance.
 *
 * v1.97.9 — the superadmin is NEVER blocked. Live 2026-11-16: the 20:00 EAT
 * remediation digest (free-form, refused by Meta with 131047) armed a 24h
 * block that locked SUPERADMIN_PHONE out of /d/admin/login — a self-inflicted
 * daily lockout. The admin door must never depend on a background send.
 */
import { isSuperadminPhone } from './superadminIdentity.js';

const blocked = new Map();
const DEFAULT_HOURS = 24;

export const PERMANENT_FAILURE_CODES = new Set(['131026', '131047', '131051']);

export function normalizeRecipient(phone = '') {
  return String(phone || '').replace(/[^\d]/g, '');
}

export function markDeliveryBlocked(phone, code = null, { hours = Number(process.env.DELIVERY_BLOCK_HOURS || DEFAULT_HOURS) } = {}) {
  const key = normalizeRecipient(phone);
  if (!key) return false;
  // v1.97.9 — never block the superadmin (the admin door must not depend on
  // a background send's delivery outcome).
  if (isSuperadminPhone(phone)) return false;
  if (code && !PERMANENT_FAILURE_CODES.has(String(code))) return false;
  const ttl = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS;
  blocked.set(key, { until: Date.now() + ttl * 60 * 60 * 1000, code: code ? String(code) : null });
  return true;
}

export function isDeliveryBlocked(phone = '') {
  const key = normalizeRecipient(phone);
  if (!key) return false;
  // v1.97.9 — defence in depth: a stale map entry (marked before the number
  // became the superadmin, or by an older revision) never blocks it.
  if (isSuperadminPhone(phone)) return false;
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