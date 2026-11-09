/**
 * Saka Fleet - WhatsApp outbound sender (Phase 5B-1 of the whatsapp.js split, v1.66.0).
 * ------------------------------------------------------------------------------------
 * v1.87.1 (Phase 26B) — this wrapper now delegates to the ONE shared transport
 * (`metaMessenger.sendWhatsAppText`), so the delivery guard, the recipient
 * cleaning, the never-throws contract and the approved-template routing can
 * never drift between the chat lane and the workers (rule 55). The signature is
 * unchanged; an optional third argument carries `{ kind, templateVars }` for
 * business-initiated messages (driver invite, buyer invite).
 */

import { sendWhatsAppText } from '../../services/metaMessenger.js';

// Helper function to dispatch WhatsApp message via Meta Cloud API
async function sendWhatsAppReply(toPhone, messageBody, options = {}) {
  await sendWhatsAppText(toPhone, messageBody, options);
}

export { sendWhatsAppReply };
