/**
 * Saka Fleet - WhatsApp admin gates (Phase 5B-4 of the whatsapp.js split, v1.69.0).
 * -------------------------------------------------------------------------------
 * The care console (worker role; CUSTOMER_CARE_PHONE OFF by default) and the superadmin
 * intercept moved out of the processor. Data in, data out: this module returns the reply and
 * the status family (care_handled / superadmin_handled); the processor keeps the status
 * literals, performs the send, the transcript pair, the snapshot persist and the return.
 *
 * BOUNDARY CONTRACT (section 191): leaf route module - src/services/* plus ./helpers.js only.
 * It never imports ./messages.js.
 */

import { handleSuperadminFlow, isSuperadminPhone } from '../../services/superadmin.js';
import { handleCareCommand } from '../../services/careConsole.js';
import { escalateCareToSuperadmin } from '../../services/customerCare.js';
import { sendCareReplyEmail } from '../../services/mailer.js';
import { generateRoleBasedActionDiscovery } from './helpers.js';

/**
 * Resolve the care-console and superadmin intercepts for one turn.
 * Returns `{ status, reply }` (status: care_handled | superadmin_handled) or null when the
 * turn belongs to the normal owner/driver flows.
 */
export async function handleAdminIntercepts({ supabaseClient, senderPhone, messageText, sendWhatsApp, isInteractiveTap = false }) {
  // v1.96.3 — an explicit button/list tap bypasses BOTH gates (care console and
  // superadmin hub). A tap can never be an admin directive or a care command;
  // letting the hub answer it swallowed "Log Fuel"/"Accept" taps as "not sure
  // which admin action that is" (live 2026-11-10). Taps keep normal routing.
  if (isInteractiveTap) return null;
  if (!supabaseClient) return null;

  // v1.58.18 - Care console (worker role). CUSTOMER_CARE_PHONE is OFF by
  // default; the superadmin can always run `care ...` too. Anything that is
  // not a care command falls through untouched.
  const careRes = await handleCareCommand(supabaseClient, {
    phone: senderPhone,
    text: messageText,
    sendWhatsApp,
    sendEmail: sendCareReplyEmail,
    notifySuperadmin: (payload) => escalateCareToSuperadmin(payload),
    isSuperadminActor: isSuperadminPhone(senderPhone)
  });
  if (careRes && careRes.reply) {
    return { status: 'care_handled', reply: careRes.reply };
  }

  // Superadmin Intercept Middleware
  const superadminRes = await handleSuperadminFlow(supabaseClient, senderPhone, messageText);
  if (superadminRes.isSuperadmin) {
    return { status: 'superadmin_handled', reply: superadminRes.reply || null };
  }
  // v1.50.0 — superadmin is superadmin-only: a non-admin message from the
  // superadmin phone is answered with the admin hub instead of falling
  // through to owner/driver flows.
  if (isSuperadminPhone(senderPhone)) {
    const hub = generateRoleBasedActionDiscovery({ profileData: null, vehicles: [], senderPhone });
    return { status: 'superadmin_handled', reply: hub };
  }

  return null;
}
