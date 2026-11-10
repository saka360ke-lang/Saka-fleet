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
import { resolveProactiveMode } from './proactiveTemplates.js';

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
 * ONE Meta POST (text or template) behind ONE guard + ONE catch, so the
 * transport, the blocklist and the never-throws contract can never drift
 * between the two message shapes (rule 55). True only on 2xx.
 *
 * v1.96.0 — optional `capture` sink: when provided, a 2xx body is parsed once
 * and its wamid exposed as `capture.wamid` / `capture.body`. Existing callers
 * pass no capture, so their boolean contract and wire behaviour are unchanged
 * (the response body is never read on the plain path).
 */
async function postWhatsAppMessage(body, env = process.env, capture = null) {
  const { phoneNumberId, token } = whatsappTextConfig(env);
  if (!phoneNumberId || !token) return false;
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body })
    });
    if (!res.ok) return false;
    if (capture && typeof capture === 'object') {
      const parsed = await res.json().catch(() => null);
      capture.body = parsed;
      capture.wamid = parsed?.messages?.[0]?.id || null;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * v1.87.1 (Phase 26B) — an approved-template send (business-initiated; delivers
 * outside the 24-hour customer-service window). `variables` are the ordered body
 * parameters ({ type: 'text', text }) built by `resolveProactiveMode`.
 */
export async function sendWhatsAppTemplate(toPhone, templateName, { languageCode = 'en', variables = [], buttons = [], env = process.env } = {}) {
  if (!toPhone || !templateName) return false;
  const cleanPhone = cleanWhatsAppRecipient(toPhone);
  if (!cleanPhone) return false;
  if (isDeliveryBlocked(cleanPhone)) return false;
  // v1.87.3 — the body component comes first; decorative/functional buttons
  // (e.g. the Authentication template's URL button) follow in their index order.
  const components = [{ type: 'body', parameters: variables }];
  for (const button of Array.isArray(buttons) ? buttons : []) components.push(button);
  return postWhatsAppMessage({
    to: cleanPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components
    }
  }, env);
}

/**
 * v1.96.0 — superadmin template PROBE. Wraps the SAME internal
 * `postWhatsAppMessage` as `sendWhatsAppTemplate` (one transport, one guard,
 * one never-throws contract), but returns a structured outcome so the operator
 * sees exactly what happened:
 *   { ok: true,  wamid: 'wamid.…', status: 'sent' }
 *   { ok: false, wamid: null, status: 'rejected' | 'delivery_blocked' | 'no_credentials' }
 * The blocklist is checked BEFORE any network call. Nothing else is touched —
 * no nudge stamps, no markers, no queue rows (the caller owns the audit row).
 */
export async function sendWhatsAppTemplateProbe(toPhone, templateName, { languageCode = 'en', variables = [], buttons = [], env = process.env, capture = null } = {}) {
  const { phoneNumberId, token } = whatsappTextConfig(env);
  if (!phoneNumberId || !token) return { ok: false, wamid: null, status: 'no_credentials' };
  if (!toPhone || !templateName) return { ok: false, wamid: null, status: 'rejected' };
  const cleanPhone = cleanWhatsAppRecipient(toPhone);
  if (!cleanPhone) return { ok: false, wamid: null, status: 'rejected' };
  if (isDeliveryBlocked(cleanPhone)) return { ok: false, wamid: null, status: 'delivery_blocked' };
  const components = [{ type: 'body', parameters: variables }];
  for (const button of Array.isArray(buttons) ? buttons : []) components.push(button);
  const sink = capture && typeof capture === 'object' ? capture : {};
  const ok = await postWhatsAppMessage({
    to: cleanPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components
    }
  }, env, sink);
  return { ok, wamid: ok ? (sink.wamid || null) : null, status: ok ? 'sent' : 'rejected' };
}

/**
 * Send ONE WhatsApp message. v1.87.1: when `kind` names a registered proactive
 * kind AND its META_TPL_<KIND> template is configured, the message rides the
 * approved template (delivers outside the 24-hour window); otherwise — or when
 * Meta rejects the template — the free-form text path is byte-identical to the
 * pre-v1.87.1 behaviour. Never throws; `false` means "not delivered" and every
 * caller degrades honestly (rule 50).
 */
export async function sendWhatsAppText(toPhone, text, { env = process.env, kind = null, templateVars = null } = {}) {
  if (kind) {
    const mode = resolveProactiveMode({ kind, templateVars });
    if (mode.mode === 'template') {
      const templateSent = await sendWhatsAppTemplate(toPhone, mode.templateName, {
        variables: mode.variables || [],
        buttons: mode.buttons || [],
        env
      });
      if (templateSent) return true;
      // Fall through: the text path still delivers inside the 24-hour window.
    }
  }

  if (!toPhone || !text) return false;
  const cleanPhone = cleanWhatsAppRecipient(toPhone);
  if (!cleanPhone) return false;
  // v1.58.23 — respect the delivery blocklist (permanent 131026-style failures).
  if (isDeliveryBlocked(cleanPhone)) return false;

  return postWhatsAppMessage({
    to: cleanPhone,
    type: 'text',
    text: { body: text }
  }, env);
}

export default { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsAppTemplateProbe, cleanWhatsAppRecipient, whatsappTextConfig };
