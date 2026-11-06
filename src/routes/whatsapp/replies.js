/**
 * Saka Fleet - WhatsApp outbound sender (Phase 5B-1 of the whatsapp.js split, v1.66.0).
 * ------------------------------------------------------------------------------------
 * The Meta Cloud API transport moved verbatim out of messages.js: one function,
 * one POST, delivery-guarded. Imports only src/services/* - never messages.js, so
 * the split boundary stays clean and the dependency graph stays acyclic.
 */

import { isDeliveryBlocked } from '../../services/deliveryGuard.js';

// Helper function to dispatch WhatsApp message via Meta Cloud API
async function sendWhatsAppReply(toPhone, messageBody) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) return;
  // v1.58.23 - never re-send to a recipient whose delivery permanently failed
  // (live 2026-11-04: a doomed number produced ~1 failed send every 7 seconds).
  if (isDeliveryBlocked(toPhone)) return;

  try {
    const cleanPhone = toPhone.startsWith('+') ? toPhone.slice(1) : toPhone;
    await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: messageBody }
      })
    });
  } catch (err) {
    console.error('[WhatsApp Service Error]:', err.message);
  }
}

export { sendWhatsAppReply };
