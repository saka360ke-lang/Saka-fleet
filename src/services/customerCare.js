/**
 * Saka Fleet — Autonomous Customer Care (v1.58.10)
 * ------------------------------------------------
 * Handles support requests from WhatsApp AND from support@reports.sakafleet.com email:
 *  - classifies the request (category + priority) deterministically;
 *  - opens a `support_tickets` row;
 *  - emails support@ (existing channel) and pings the superadmin for high-priority;
 *  - relays an inbound support@ reply back to the user's WhatsApp.
 * Never throws. Guardrail: it only reads/writes support_tickets + sends messages.
 */
import { sendSupportEscalationEmail, sendSuperadminEscalationEmail } from './mailer.js';
import { sendProactiveWhatsApp } from '../workers/sentinel.js';

const CARE_RULES = [
  { category: 'bug', priority: 'high', re: /\b(bug|broken|error|crash|failing|not working|stuck|loop|wrong|doesn'?t work|can'?t|cannot)\b/i },
  { category: 'billing', priority: 'high', re: /\b(charge|charged|billing|payment|invoice|refund|subscription|paystack|price|pricing|cost|upgrade|downgrade|trial|expire|expired)\b/i },
  { category: 'feature', priority: 'low', re: /\b(feature|suggestion|suggest|would like|feature request)\b/i },
  { category: 'driver', priority: 'medium', re: /\b(driver|assign|assignment|compliance|licence|license)\b/i },
  { category: 'vehicle', priority: 'medium', re: /\b(vehicle|car|truck|plate|registration|vin|passbook|transfer|add|remove|delete)\b/i },
  { category: 'logging', priority: 'medium', re: /\b(log|logging|expense|fuel|odometer|entry|record|save|duplicate)\b/i }
];
const ESCALATE_RE = /\b(escalat(?:e|ion)|complaint|dispute|manager|supervisor|refund|urgent|asap|furious|angry)\b/i;

export function classifyCareRequest(text = '') {
  const s = String(text || '');
  for (const r of CARE_RULES) if (r.re.test(s)) return { category: r.category, priority: r.priority };
  return { category: 'other', priority: ESCALATE_RE.test(s) ? 'high' : 'medium' };
}

export function shouldEscalateCare(text = '', priority = 'medium') {
  return priority === 'high' || ESCALATE_RE.test(String(text || ''));
}

export async function openCareTicket(supabase, { phone, body, category = 'other', source = 'whatsapp', priority = 'medium', senderEmail = null } = {}) {
  if (!supabase) return { ok: false, reason: 'no client' };
  // v1.58.22 - the care-console migration added lifecycle columns; a bare
  // four-column insert failed silently on the live table (2026-11-04: Saka
  // promised "passed to support" while support_tickets stayed empty).
  const bodyText = String(body || '').slice(0, 2000);
  const base = {
    whatsapp_number: phone,
    issue_category: category,
    message_body: bodyText,
    created_at: new Date().toISOString()
  };
  const full = {
    ...base,
    status: 'OPEN',
    priority,
    source,
    subject: String(bodyText || 'WhatsApp support request').slice(0, 200),
    thread_key: `${source}:${String(phone || '').replace(/[^0-9]/g, '')}`,
    updated_at: new Date().toISOString()
  };
  if (senderEmail) full.sender_email = String(senderEmail).slice(0, 200);
  try {
    let { data, error } = await supabase.from('support_tickets').insert([full]).select();
    if (error && /column|schema|does not exist/i.test(error.message || '')) {
      // Legacy slim table: fall back to the four guaranteed columns.
      ({ data, error } = await supabase.from('support_tickets').insert([base]).select());
    }
    if (error) return { ok: false, reason: error.message };
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: true, id: row?.id || null, source };
  } catch (err) { return { ok: false, reason: err.message }; }
}

export async function escalateCareToSuperadmin({ phone, text, category, priority } = {}) {
  const adminPhone = process.env.SUPERADMIN_PHONE;
  let pinged = false;
  if (adminPhone) {
    try {
      const msg = `🎫 *New ${priority} support ticket* (${category})\n\n👤 ${phone}\n\n"${String(text || '').slice(0, 500)}"\n\n_Reply from support@reports.sakafleet.com — Saka will relay it to the user's WhatsApp._`;
      pinged = Boolean(await sendProactiveWhatsApp(adminPhone, msg, 'care_escalation'));
    } catch { pinged = false; }
  }
  let emailed = false;
  try { emailed = await sendSuperadminEscalationEmail({ userPhone: phone, category, priority, text }); } catch { emailed = false; }
  return { pinged, emailed, alerted: pinged || emailed };
}

/** Orchestrator: open ticket + email support@ + (high-priority) ping superadmin. */
export async function handleCareRequest(supabase, { phone, text, profile = null, userEmail = null, vehiclesList = [] } = {}) {
  const { category, priority } = classifyCareRequest(text);
  const ticket = await openCareTicket(supabase, { phone, body: text, category, source: 'whatsapp', priority, senderEmail: userEmail || profile?.email || null });
  // v1.58.22 - a failed ticket is never silent: without a row the assistant
  // must not claim the issue was "passed to support".
  if (!ticket?.ok) {
    try {
      const { logSystemError } = await import('../workers/sentinel.js');
      const failure = new Error(`Support ticket insert failed: ${ticket?.reason || 'unknown'}`);
      await logSystemError(supabase, failure, '/services/customerCare');
    } catch { /* best effort */ }
  }
  let emailed = false;
  try {
    emailed = await sendSupportEscalationEmail({
      userPhone: phone,
      userEmail: userEmail || profile?.email,
      userName: profile?.full_name,
      subscriptionTier: profile?.subscription_tier,
      issueParagraph: String(text || ''),
      vehiclesList: vehiclesList || []
    });
  } catch { emailed = false; }
  let superadminPinged = false;
  if (shouldEscalateCare(text, priority)) {
    const alert = await escalateCareToSuperadmin({ phone, text, category, priority });
    superadminPinged = Boolean(alert && alert.alerted);
  }
  return { category, priority, ticket, ticketCreated: Boolean(ticket && ticket.ok), emailed, superadminPinged };
}

/** Inbound email (support@reports.sakafleet.com reply) → relay to the user's WhatsApp. */
export async function handleInboundSupportEmail(supabase, { fromEmail = null, subject = null, text = null, sendWhatsApp = null } = {}) {
  if (!supabase) return { ok: false, reason: 'no client' };
  const email = String(fromEmail || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no-sender' };
  let profile = null;
  try {
    const { data } = await supabase.from('profiles').select('id, phone_number, full_name, email').ilike('email', email).limit(1);
    profile = data && data[0] ? data[0] : null;
  } catch { profile = null; }
  if (!profile?.phone_number) return { ok: false, reason: 'no-matching-profile', email };
  const reply = String(text || subject || '').trim() || 'Our support team replied to your request.';
  let sent = false;
  if (typeof sendWhatsApp === 'function') {
    try { sent = (await sendWhatsApp(profile.phone_number, `📩 *Support reply*\n\n${reply.slice(0, 1200)}`)) !== false; } catch { sent = false; }
  }
  return { ok: true, phone: profile.phone_number, sent };
}

export default { classifyCareRequest, shouldEscalateCare, openCareTicket, escalateCareToSuperadmin, handleCareRequest, handleInboundSupportEmail };
