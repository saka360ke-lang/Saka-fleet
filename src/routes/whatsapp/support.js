/**
 * Saka Fleet - WhatsApp support intake flow (Phase 5B-4 of the whatsapp.js split, v1.69.0).
 * ---------------------------------------------------------------------------------------
 * The support-escalation trigger and its pending branch moved verbatim out of the processor.
 * The LIVE next-turn intake handler stays in ./pending.js (resolveSupportIntakeTurn, early
 * gate claim order); this module owns the trigger + the (unreachable but pinned) pending
 * branch that test_customer_care asserts on `ticketCreated`.
 *
 * BOUNDARY CONTRACT (section 191): leaf route module - src/services/* only. Never ./messages.js.
 */

import { handleCareRequest } from '../../services/customerCare.js';
import { composeMessage } from '../../services/conversationEngine.js';

/**
 * Resolve the support family for one turn. Returns `{ isSupportFlow, reply }`; the processor
 * assigns the reply and skips every other special flow when isSupportFlow is true.
 */

export async function resolveSupportFlowTurn({ session, messageText, hasVehicleRegistered, profileData, existingVehicles, senderPhone, supabaseClient, targetLang, countryInfo }) {
  let reply;
  let isSupportFlow = false;
  // --- SUPPORT ESCALATION FLOW (support@reports.sakafleet.com) ---
  if (session.pendingSupportEscalation) {
    isSupportFlow = true;
    const cleanText = messageText.trim().toLowerCase();
    if (/^(cancel|exit|stop)$/i.test(cleanText)) {
      session.pendingSupportEscalation = false;
      reply = `Support escalation cancelled. ${hasVehicleRegistered ? "You are back in active menu mode." : "How can I assist you today?"}`;
    } else {
      // v1.58.10 — autonomous customer care: open a ticket + email
      // support@ + ping the superadmin for high-priority cases.
      const care = await handleCareRequest(supabaseClient, {
        phone: senderPhone,
        text: messageText.trim(),
        profile: profileData,
        userEmail: profileData?.email,
        vehiclesList: existingVehicles
      });
      session.pendingSupportEscalation = false;
      // v1.58.22 - only claim "forwarded" when a ticket row actually exists.
      reply = care?.ticketCreated
        ? await composeMessage({
            purpose: 'support_escalation',
            facts: { supportEmail: 'support@reports.sakafleet.com', forwarded: true },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: "I've forwarded your message to our support team at support@reports.sakafleet.com. They will reach out to you shortly!"
          })
        : "Thanks — I couldn't open a support ticket automatically just now. Please email support@reports.sakafleet.com with a line about what happened, or reply *Support* to try again.";
    }
  } else if (
    /\b(support team|contact support|talk to support|human help|help from (?:a )?human|talk to (?:a )?(?:human|person|agent|representative)|human (?:agent|support)|customer (?:care|support)|file a complaint|escalat(?:e|ion)|dispute|admin intervention|confus(?:ed|ing)|doesn'?t make sense|not clear)\b/i.test(messageText)
  ) {
    isSupportFlow = true;
    session.pendingSupportEscalation = true;
    reply = await composeMessage({
      purpose: 'support_intake',
      facts: {
        instruction: 'Ask the user to describe the issue in one message so it can be forwarded to support.',
        supportEmail: 'support@reports.sakafleet.com'
      },
      language: targetLang,
      countryInfo,
      profile: profileData,
      fallbackText: 'Please describe your issue in one message and I will forward it to support@reports.sakafleet.com.'
    });
  }
  return { isSupportFlow, reply };
}
