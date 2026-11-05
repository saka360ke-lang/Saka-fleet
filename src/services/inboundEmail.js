/** Saka Fleet - Resend inbound email (v1.58.14). Verifies Svix, parses email.received, fetches the body, opens a ticket and pings the care worker. */
import crypto from 'node:crypto';

/** v1.58.17 - the one inbox that opens care tickets (Resend inbound domain). */
export const SUPPORT_INBOX = 'support@reports.sakafleet.com';
import { openOrAppendEmailTicket } from './careConsole.js';
import { logWriteFailure } from './systemErrors.js';

function headerOf(headers, name) {
  if (!headers) return null;
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(headers)) if (String(key).toLowerCase() === lower) return headers[key];
  return null;
}

export function verifyResendSignature({ headers = {}, rawBody = '', secret = null, toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!secret) return { ok: true, skipped: true };
  const id = headerOf(headers, 'svix-id');
  const ts = headerOf(headers, 'svix-timestamp');
  const sig = headerOf(headers, 'svix-signature');
  if (!id || !ts || !sig) return { ok: false, reason: 'missing-headers' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bad-timestamp' };
  if (Math.abs(Math.floor(now / 1000) - tsNum) > toleranceSeconds) return { ok: false, reason: 'timestamp-out-of-range' };
  try {
    const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
    const expected = crypto.createHmac('sha256', key).update(id + '.' + ts + '.' + rawBody).digest('base64');
    const provided = String(sig).split(' ').map((p) => p.split(',')[1]).filter(Boolean);
    const match = provided.some((c) => {
      const a = Buffer.from(c);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    return match ? { ok: true, verified: true } : { ok: false, reason: 'bad-signature' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function parseInboundEmail(payload = {}) {
  const type = payload.type || payload.event || null;
  const data = payload.data || payload;
  const rawFrom = typeof data.from === 'string' ? data.from : (data.from && data.from.email) || null;
  const to = Array.isArray(data.to) ? data.to : (data.to ? [data.to] : (Array.isArray(data.received_for) ? data.received_for : []));
  return {
    type,
    emailId: data.email_id || data.id || null,
    fromEmail: rawFrom ? String(rawFrom).trim().toLowerCase() : null,
    toEmails: to.map((x) => String(x).trim().toLowerCase()).filter(Boolean),
    subject: data.subject ? String(data.subject).slice(0, 500) : '(no subject)',
    messageId: data.message_id || null,
    receivedAt: data.created_at || payload.created_at || new Date().toISOString()
  };
}

export async function fetchInboundEmailBody(emailId, apiKey = process.env.RESEND_API_KEY) {
  if (!emailId || !apiKey) return { ok: false, reason: 'missing' };
  try {
    const res = await fetch('https://api.resend.com/emails/' + encodeURIComponent(emailId), {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    });
    if (!res.ok) return { ok: false, reason: 'http-' + res.status };
    const body = await res.json();
    const row = body && body.data ? body.data : body;
    return { ok: true, text: row.text || null, html: row.html || null };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** v1.59.7 — HTML-only mail must never become a subject-only ticket. */
export function htmlToPlainText(html = '') {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

export async function handleInboundEmail(supabase, { payload = {}, headers = {}, rawBody = '', secret = null, notify = null, notifyPhone = null, skipFetch = false } = {}) {
  const verify = verifyResendSignature({ headers, rawBody, secret });
  if (!verify.ok) return { ok: false, rejected: true, reason: verify.reason };
  const email = parseInboundEmail(payload);
  if (email.type && email.type !== 'email.received') return { ok: true, ignored: email.type };
  // v1.58.17 - only mail addressed to the support inbox opens a ticket; a reply
  // to security@ (OTP sender) or any other alias must not become a care ticket.
  if (email.toEmails.length && !email.toEmails.includes(SUPPORT_INBOX)) {
    return { ok: true, ignored: 'not-support-recipient', toEmails: email.toEmails };
  }
  if (!email.fromEmail) return { ok: false, reason: 'no-sender' };
  // v1.58.19 - never re-ingest our own outbound mail. Escalation/reply emails are
  // addressed TO the support inbox, so a self-sender would loop tickets forever.
  if (/@reports\.sakafleet\.com$/i.test(String(email.fromEmail))) {
    return { ok: true, ignored: 'self-sender', fromEmail: email.fromEmail };
  }
  let body = null;
  if (!skipFetch && email.emailId) {
    const fetched = await fetchInboundEmailBody(email.emailId);
    if (fetched.ok) body = fetched;
  }
  // v1.59.7 — prefer the text part, fall back to the HTML part, and only use
  // the subject when neither exists (live audit: an HTML-only enquiry became a
  // ticket whose whole body was "Enquiry").
  const bodyText = (body && body.text && String(body.text).trim())
    ? String(body.text).trim()
    : (body && body.html ? htmlToPlainText(body.html) : '');
  let ticketId = null;
  let careCategory = null;
  let carePriority = null;
  let careCreated = null;
  if (supabase) {
    // v1.58.18 - classify + thread every email into a tracked care ticket.
    const outcome = await openOrAppendEmailTicket(supabase, {
      fromEmail: email.fromEmail,
      subject: email.subject,
      text: bodyText || email.subject
    }).catch(() => null);
    ticketId = outcome ? outcome.ticketId : null;
    if (outcome) {
      careCategory = outcome.category || null;
      carePriority = outcome.priority || null;
      careCreated = outcome.created;
    }
    // Never lose the failure silently: a body-less ticket says why.
    if (ticketId && !bodyText) {
      try {
        await supabase.from('support_tickets').update({
          internal_note: 'Body fetch returned no text (HTML-only mail or fetch failure) - subject stored. Open it in the Resend dashboard.'
        }).eq('id', ticketId);
      } catch (noteErr) { logWriteFailure(supabase, 'inboundEmail.internalNote', noteErr); }
    }
  }
  let notified = false;
  if (typeof notify === 'function' && notifyPhone) {
    const snippet = String(bodyText || '').slice(0, 900);
    const label = careCreated === false ? ' (update)' : '';
    const meta = [careCategory, carePriority].filter(Boolean).join(' · ');
    const text = '[Support email' + label + ']\n\nFrom: ' + email.fromEmail + '\nSubject: ' + email.subject + (meta ? '\n' + meta : '') + (snippet ? '\n\n' + snippet : '') + '\n\n_Tend it: care reply <id> — or reply from support@reports.sakafleet.com._';
    try { notified = (await notify(notifyPhone, text)) !== false; } catch { notified = false; }
  }
  return { ok: true, email, textBody: bodyText || null, ticketId, notified, verified: Boolean(verify.verified), category: careCategory, priority: carePriority, threadUpdate: careCreated === false };
}

export default { verifyResendSignature, parseInboundEmail, fetchInboundEmailBody, handleInboundEmail };/** List recent inbound support emails (stored as support_tickets category=email). */
export async function listInboundEmails(supabase, limit = 10) {
  if (!supabase) return [];
  try {
    const { data } = await supabase.from('support_tickets').select('id, whatsapp_number, issue_category, message_body, created_at').eq('issue_category', 'email').order('created_at', { ascending: false }).limit(limit);
    return data || [];
  } catch { return []; }
}

export async function getInboundEmail(supabase, id) {
  if (!supabase || !id) return null;
  try {
    const { data } = await supabase.from('support_tickets').select('*').eq('id', id).maybeSingle();
    return data || null;
  } catch { return null; }
}

export function formatInboxReply(rows) {
  if (!rows || !rows.length) return '*Support inbox*\n\n- none';
  const lines = rows.slice(0, 10).map((r, i) => (i + 1) + '. ' + String(r.id).slice(0, 8) + ' ' + (r.whatsapp_number || 'unknown') + (r.status ? ' [' + r.status + (r.priority ? '/' + r.priority : '') + ']' : '') + ' - ' + String(r.message_body || '(no body)').slice(0, 60));
  return '*Support inbox*\n\n' + lines.join('\n') + '\n\n_Open one:_ admin inbox read <id>';
}

export function formatInboundEmailReply(row) {
  if (!row) return 'That inbound email was not found.';
  return '*Email from ' + (row.whatsapp_number || 'unknown') + '*\n' +
    'Received: ' + String(row.created_at || '') + '\n\n' +
    String(row.message_body || '(body not available - open it in the Resend dashboard)').slice(0, 2500);
}