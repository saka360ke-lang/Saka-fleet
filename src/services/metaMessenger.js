/**
 * Saka Fleet — Meta WhatsApp text transport (v1.82.0, Phase 21).
 * --------------------------------------------------------------
 * ONE never-throwing free-form text sender shared by the Sentinel worker and the
 * dashboard sign-in OTP (Phase 21 extracts the exact text path that lived inside
 * `sendProactiveWhatsApp`, so the two senders can never drift). Template routing
 * stays where it belongs: `sendProactiveWhatsApp` resolves a proactive template
 * first and falls back to this transport inside the 24-hour window.
 *
 * Contract: returns `true` only on a 2xx; every failure (missing env, empty
 * recipient, delivery blocklist, network) returns `false` and never throws.
 */

import { isDeliveryBlocked } from './deliveryGuard.js';

/** Read the Meta credentials once, without throwing on a missing env. */
export function whatsappTextConfig(env = process.env) {
  return {
    phoneNumberId: env.META_PHONE_NUMBER_ID || null,
    token: env.META_WHATSAPP_TOKEN || null
  };
}

/** `+254 712 345 678` / `whatsapp:+254…` -> `254712345678` (Meta's format). */
export function cleanWhatsAppRecipient(toPhone) {
  return String(toPhone || '').replace(/[^\d]/g, '');
}

/**
 * Send ONE free-form WhatsApp text. Never throws; `false` means "not delivered"
 * and every caller degrades honestly (rule 50).
 */
export async function sendWhatsAppText(toPhone, text, { env = process.env } = {}) {
  const { phoneNumberId, token } = whatsappTextConfig(env);
  if (!phoneNumberId || !token || !toPhone || !text) return false;

  const cleanPhone = cleanWhatsAppRecipient(toPhone);
  if (!cleanPhone) return false;
  // v1.58.23 — respect the delivery blocklist (permanent 131026-style failures).
  if (isDeliveryBlocked(cleanPhone)) return false;

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: text }
      })
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default { sendWhatsAppText, cleanWhatsAppRecipient, whatsappTextConfig };
