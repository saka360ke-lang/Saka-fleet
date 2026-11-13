/** Saka Fleet - Resend inbound email tests (v1.58.14, stateless) */
import assert from 'assert';
import crypto from 'node:crypto';
import { verifyResendSignature, parseInboundEmail, handleInboundEmail, htmlToPlainText, fetchInboundEmailBody, SUPPORT_INBOX } from './src/services/inboundEmail.js';
import { normalizeThreadKey } from './src/services/careConsole.js';
import { routeCareInternalReply } from './src/services/careLearning.js';
import { createMockSupabase } from './scripts/mockSupabase.js';

let passed = 0;
function check(cond, label) { assert.ok(cond, label); passed += 1; console.log('  ok ' + label); }

// v1.97.3 — pin the Amina kill switch OFF for this stateless suite. The runner
// (`scripts/run_tests.js`) loads dotenv for its children, so a developer's local
// CARE_AI_ENABLED=on must never leak into the disabled-path assertions below
// (rule 52 test isolation; mirrors test_care_ai.js's save/delete/restore).
const PREV_CARE_AI_ENABLED = process.env.CARE_AI_ENABLED;
delete process.env.CARE_AI_ENABLED;
check(!process.env.CARE_AI_ENABLED, 'the suite pins CARE_AI_ENABLED off (a local .env cannot leak into the disabled-path assertions)');

const SECRET = 'whsec_' + Buffer.from('saka-test-signing-key').toString('base64');
const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
const RAW = JSON.stringify({ type: 'email.received', data: { email_id: 'e1', from: 'customer@example.com', to: ['support@reports.sakafleet.com'], subject: 'Help with my truck' } });
const TS = String(Math.floor(Date.now() / 1000));
const ID = 'msg_test_1';
const SIG = 'v1,' + crypto.createHmac('sha256', key).update(ID + '.' + TS + '.' + RAW).digest('base64');

console.log('--- signature ---');
check(verifyResendSignature({ headers: {}, rawBody: RAW, secret: null }).skipped === true, 'no secret means verification is skipped (legacy mode)');
check(verifyResendSignature({ headers: {}, rawBody: RAW, secret: SECRET }).reason === 'missing-headers', 'missing svix headers are rejected');
check(verifyResendSignature({ headers: { 'svix-id': ID, 'svix-timestamp': TS, 'svix-signature': SIG }, rawBody: RAW, secret: SECRET }).ok === true, 'a valid Svix signature verifies');
check(verifyResendSignature({ headers: { 'svix-id': ID, 'svix-timestamp': TS, 'svix-signature': 'v1,deadbeef' }, rawBody: RAW, secret: SECRET }).reason === 'bad-signature', 'a tampered signature is rejected');
check(verifyResendSignature({ headers: { 'svix-id': ID, 'svix-timestamp': '1000', 'svix-signature': SIG }, rawBody: RAW, secret: SECRET }).reason === 'timestamp-out-of-range', 'a stale timestamp is rejected');

console.log('--- payload parsing ---');
const parsed = parseInboundEmail(JSON.parse(RAW));
check(parsed.type === 'email.received', 'the event type is parsed');
check(parsed.emailId === 'e1', 'the email id is parsed');
check(parsed.fromEmail === 'customer@example.com', 'the sender is lower-cased');
check(parsed.toEmails.length === 1 && parsed.toEmails[0] === 'support@reports.sakafleet.com', 'the recipients are parsed');
check(parsed.toEmails[0] === SUPPORT_INBOX, 'the parsed recipient is the canonical support inbox');
check(parsed.subject === 'Help with my truck', 'the subject is parsed');

console.log('--- html-only body fallback (v1.59.7) ---');
check(htmlToPlainText('<p>Hello <b>there</b></p><br/>Second &amp; last') === 'Hello there\n\nSecond & last', 'html-only mail converts to plain text (tags stripped, entities decoded)');
check(htmlToPlainText('<style>x</style><script>y</script><div>Ok</div>') === 'Ok', 'style/script blocks never leak into the ticket body');
check(htmlToPlainText('') === '', 'an empty html part is empty text');

console.log('--- handler ---');
function mock() {
  const db = { support_tickets: [] };
  return { __db: db, from(name) { const r = db[name] || (db[name] = []); return { insert(p) { const items = Array.isArray(p) ? p : [p]; for (const it of items) r.push({ id: 't-' + r.length, ...it }); return { select: () => ({ maybeSingle: async () => ({ data: r[r.length - 1] }) }) }; } }; } };
}

const rejected = await handleInboundEmail(mock(), { payload: JSON.parse(RAW), headers: {}, rawBody: RAW, secret: SECRET, skipFetch: true });
check(rejected.rejected === true, 'a bad signature is rejected before any write');

const db = mock();
let notified = null;
const ok = await handleInboundEmail(db, { payload: JSON.parse(RAW), headers: { 'svix-id': ID, 'svix-timestamp': TS, 'svix-signature': SIG }, rawBody: RAW, secret: SECRET, notify: async (phone, text) => { notified = { phone, text }; return true; }, notifyPhone: '+254700000000', skipFetch: true });
check(ok.ok === true && ok.verified === true, 'a verified email is handled');
check(db.__db.support_tickets.length === 1, 'a support ticket is opened');
check(db.__db.support_tickets[0].issue_category === 'vehicle', 'the ticket is categorised from its content (vehicle)');
check(db.__db.support_tickets[0].status === 'OPEN' && db.__db.support_tickets[0].source === 'email', 'the ticket carries the care lifecycle fields');
check(Boolean(db.__db.support_tickets[0].priority) && Boolean(db.__db.support_tickets[0].thread_key), 'the ticket carries priority + thread key');
check(db.__db.support_tickets[0].whatsapp_number === 'customer@example.com', 'the ticket carries the sender');
check(notified && notified.phone === '+254700000000', 'the customer-care worker is pinged');
check(notified && notified.text.indexOf('Help with my truck') !== -1, 'the ping carries the subject');
check(notified && notified.text.indexOf('support@reports.sakafleet.com') !== -1, 'the care ping names the support inbox');

console.log('--- recipient gate ---');
const offInbox = await handleInboundEmail(mock(), { payload: { type: 'email.received', data: { email_id: 'e9', from: 'customer@example.com', to: ['someone@example.com'], subject: 'Not support' } }, headers: {}, rawBody: '{}', secret: null, skipFetch: true });
check(offInbox.ok === true && offInbox.ignored === 'not-support-recipient', 'mail addressed outside the support inbox is ignored');

console.log('--- self-sender guard ---');
const selfMail = await handleInboundEmail(mock(), { payload: { type: 'email.received', data: { email_id: 'e10', from: 'support@reports.sakafleet.com', to: ['support@reports.sakafleet.com'], subject: 'Support Escalation Ticket: +254700000000 (User)' } }, headers: {}, rawBody: '{}', secret: null, skipFetch: true });
check(selfMail.ok === true && selfMail.ignored === 'self-sender', 'our own outbound mail is never re-ingested (no ticket loop)');

console.log('--- long sender fallback ---');
function mockLimited() {
  const db = { support_tickets: [] };
  return { __db: db, from(name) { const r = db[name] || (db[name] = []); return { insert(p) { const items = Array.isArray(p) ? p : [p]; const tooLong = items.find((it) => String(it.whatsapp_number || '').length > 20); if (tooLong) return { select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'value too long for type character varying(20)' } }) }) }; for (const it of items) r.push({ id: 't-' + r.length, ...it }); return { select: () => ({ maybeSingle: async () => ({ data: r[r.length - 1], error: null }) }) }; } }; } };
}
const dbLong = mockLimited();
const longSender = await handleInboundEmail(dbLong, { payload: { type: 'email.received', data: { email_id: 'e3', from: 'verylongcustomername@example.com', to: ['support@reports.sakafleet.com'], subject: 'Long sender' } }, headers: { 'svix-id': ID, 'svix-timestamp': TS, 'svix-signature': SIG }, rawBody: RAW, secret: SECRET, skipFetch: true });
check(longSender.ok === true && Boolean(longSender.ticketId), 'a long sender still opens a ticket (truncated fallback)');
check(dbLong.__db.support_tickets.length === 1 && dbLong.__db.support_tickets[0].whatsapp_number.length === 20, 'the fallback trims the sender to the legacy column width');

const ignored = await handleInboundEmail(mock(), { payload: { type: 'email.sent', data: {} }, headers: {}, rawBody: '{}', secret: null, skipFetch: true });
check(ignored.ok === true && ignored.ignored === 'email.sent', 'non-inbound events are ignored');

console.log('--- Amina hook (v1.80.0) ---');
check(ok.ai && ok.ai.action === 'disabled', 'with CARE_AI_ENABLED off the hook is a no-op (the human path is byte-identical)');
const aiMock = createMockSupabase({ support_tickets: [], support_ticket_messages: [], admin_audit_logs: [] });
let aiTicketPayload = null;
let aiNotified = 0;
const aiHandled = await handleInboundEmail(aiMock.client, {
  payload: JSON.parse(RAW),
  headers: { 'svix-id': ID, 'svix-timestamp': TS, 'svix-signature': SIG },
  rawBody: RAW,
  secret: SECRET,
  skipFetch: true,
  notify: async () => { aiNotified += 1; return true; },
  notifyPhone: '+254700000000',
  processEmail: async (_client, payload) => { aiTicketPayload = payload; return { handled: true, action: 'resolved' }; }
});
check(aiHandled.ai && aiHandled.ai.action === 'resolved', 'the AI result rides the handler result');
check(aiHandled.notified === false || aiNotified === 0, 'a resolved ticket does not double-ping the care worker');
check(aiTicketPayload && aiTicketPayload.ticketId && aiTicketPayload.fromEmail === 'customer@example.com',
  'Amina receives the ticket id + sender');
check(aiTicketPayload && aiTicketPayload.category === 'vehicle' && aiTicketPayload.created === true,
  'Amina receives the classification + created flag');

console.log('--- human reply routing ([SFC-]) ---');
const SFC_RAW = JSON.stringify({ type: 'email.received', data: { email_id: 'e20', from: 'support@sakafleet.com', to: ['support@reports.sakafleet.com'], subject: '[SFC-abc12345] Re: Help with my truck' } });
const SFC_TS = String(Math.floor(Date.now() / 1000));
const SFC_SIG = 'v1,' + crypto.createHmac('sha256', key).update('msg_sfc.' + SFC_TS + '.' + SFC_RAW).digest('base64');
const sfcMock = createMockSupabase({ support_tickets: [] });
let routedPayload = null;
const internal = await handleInboundEmail(sfcMock.client, {
  payload: JSON.parse(SFC_RAW),
  headers: { 'svix-id': 'msg_sfc', 'svix-timestamp': SFC_TS, 'svix-signature': SFC_SIG },
  rawBody: SFC_RAW,
  secret: SECRET,
  skipFetch: true,
  routeInternalReply: async (_client, payload) => { routedPayload = payload; return { ok: true, ticketId: 't-sfc', learned: true }; }
});
check(internal.internalReply === true && internal.ticketId === 't-sfc' && internal.learned === true,
  'a tagged human reply lands on the existing ticket and teaches Amina');
check(routedPayload && routedPayload.subject.indexOf('[SFC-abc12345]') === 0, 'the router receives the tagged subject');
check(sfcMock.db.support_tickets.length === 0, 'a human reply never opens a duplicate ticket');
const untaggedInternal = await handleInboundEmail(sfcMock.client, {
  payload: { type: 'email.received', data: { email_id: 'e21', from: 'support@sakafleet.com', to: ['support@reports.sakafleet.com'], subject: 'Just checking in' } },
  headers: {}, rawBody: '{}', secret: null, skipFetch: true
});
check(untaggedInternal.ignored === 'internal-sender-no-tag', 'internal mail without a tag never becomes a ticket');

console.log('--- reopen semantics (v1.80.0) ---');
const reopenMock = createMockSupabase({
  support_tickets: [{
    id: 't-resolved',
    whatsapp_number: 'customer@example.com',
    sender_email: 'customer@example.com',
    issue_category: 'vehicle',
    message_body: 'Help with my truck',
    subject: 'Help with my truck',
    status: 'RESOLVED',
    priority: 'medium',
    source: 'email',
    thread_key: normalizeThreadKey({ senderEmail: 'customer@example.com', subject: 'Help with my truck' }),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }],
  support_ticket_messages: [],
  admin_audit_logs: []
});
const reopened = await handleInboundEmail(reopenMock.client, {
  payload: JSON.parse(RAW),
  headers: { 'svix-id': ID, 'svix-timestamp': TS, 'svix-signature': SIG },
  rawBody: RAW,
  secret: SECRET,
  skipFetch: true,
  processEmail: async () => ({ handled: false, action: 'disabled' })
});
check(reopened.reopened === true && reopened.ticketId === 't-resolved', 'a follow-up on a RESOLVED ticket reopens the SAME ticket');
check(reopenMock.db.support_tickets.length === 1, 'no duplicate ticket is created on the follow-up');
check(String(reopenMock.db.support_tickets[0].status) === 'OPEN', 'the reopened ticket returns to OPEN for triage');

console.log('--- body-fetch failures are logged (v1.97.5) ---');
// Live 2026-11-13: a human [SFC-] reply reached the router with its body
// missing, so the "human reply" was only the subject and no lesson could be
// learned. A failed/empty Resend body fetch must always leave an error_logs row.
const bodyFailMock = createMockSupabase({ support_tickets: [], support_ticket_messages: [], admin_audit_logs: [], error_logs: [] });
const bodyFail = await handleInboundEmail(bodyFailMock.client, {
  payload: { type: 'email.received', data: { email_id: 'e30', from: 'support@sakafleet.com', to: ['support@reports.sakafleet.com'], subject: '[SFC-abc12345] Re: Help with my truck' } },
  headers: {}, rawBody: '{}', secret: null,
  fetchBody: async () => ({ ok: false, reason: 'http-404' }),
  routeInternalReply: async (_client, payload) => { routedPayload = payload; return { ok: true, ticketId: 't-sfc', learned: false, bodyAvailable: payload.bodyAvailable }; }
});
await new Promise((resolve) => setTimeout(resolve, 25));
check(bodyFailMock.db.error_logs.some((row) => String(row.route || '').indexOf('inboundEmail.fetchInboundEmailBody') !== -1),
  'a failed Resend body fetch is written to error_logs (never silent)');
check(bodyFail.internalReply === true && bodyFail.bodyAvailable === false && routedPayload.bodyAvailable === false,
  'the router is told the body never arrived (bodyAvailable:false)');
check(routedPayload.text === '[SFC-abc12345] Re: Help with my truck',
  'the subject is the honest fallback text, never an invented reply');
const bodyEmptyMock = createMockSupabase({ support_tickets: [], support_ticket_messages: [], admin_audit_logs: [], error_logs: [] });
await handleInboundEmail(bodyEmptyMock.client, {
  payload: { type: 'email.received', data: { email_id: 'e31', from: 'support@sakafleet.com', to: ['support@reports.sakafleet.com'], subject: '[SFC-abc12345] Re: Help with my truck' } },
  headers: {}, rawBody: '{}', secret: null,
  fetchBody: async () => ({ ok: true, text: null, html: null }),
  routeInternalReply: async () => ({ ok: true, ticketId: 't-sfc', learned: false })
});
await new Promise((resolve) => setTimeout(resolve, 25));
check(bodyEmptyMock.db.error_logs.some((row) => String(row.route || '').indexOf('inboundEmail.fetchInboundEmailBody') !== -1),
  'an empty Resend body is logged as an incident too');

console.log('--- the receiving endpoint (v1.97.6) ---');
// Live 2026-11-13: GET /emails/{id} is Resend's SENT-email API and 404s for a
// received email ("Email not found"), while /emails/receiving/{id} returns the
// full text+html. The stub pins the URL so the wrong endpoint can never return.
const originalFetch = globalThis.fetch;
let fetchedUrl = null;
globalThis.fetch = async (url) => {
  fetchedUrl = String(url);
  return {
    ok: true,
    status: 200,
    json: async () => ({ object: 'email', id: 'e5302c09', text: 'For future reference: answer fuel-log questions with the WhatsApp line.', html: '<div>For future reference: answer fuel-log questions with the WhatsApp line.</div>' })
  };
};
const bodyHit = await fetchInboundEmailBody('e5302c09-e6c4-417b-95dd-82dc644ddafb', 're_test_key');
check(fetchedUrl === 'https://api.resend.com/emails/receiving/e5302c09-e6c4-417b-95dd-82dc644ddafb',
  'the fetch uses the receiving endpoint, never the sent-email endpoint');
check(bodyHit.ok === true && /For future reference/.test(bodyHit.text) && /<div>/.test(bodyHit.html),
  'text and html are both read from the receiving response');
globalThis.fetch = async (url) => {
  fetchedUrl = String(url);
  return { ok: true, status: 200, json: async () => ({ data: { text: null, html: '<div>HTML only reply</div>' } }) };
};
const htmlOnlyBody = await fetchInboundEmailBody('e31', 're_test_key');
check(htmlOnlyBody.ok === true && htmlOnlyBody.text === null && /HTML only/.test(htmlOnlyBody.html),
  'an HTML-only received email still returns its html for the plain-text fallback');
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ message: 'Email not found' }) });
const notFoundBody = await fetchInboundEmailBody('e404', 're_test_key');
check(notFoundBody.ok === false && notFoundBody.reason === 'http-404',
  'a 404 is an honest refusal (fed to the v1.97.5 error_logs path)');
globalThis.fetch = originalFetch;

console.log('--- the human-reply audit records body availability (v1.97.5) ---');
const TICKET_UUID = 'a1b2c3d4-0000-4000-8000-000000000000';
const routeAuditMock = createMockSupabase({
  support_tickets: [{
    id: TICKET_UUID, subject: 'Fuel log stuck', sender_email: 'jane@example.com', issue_category: 'logging',
    status: 'ESCALATED', priority: 'high', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }],
  support_ticket_messages: [],
  care_learnings: [],
  admin_audit_logs: []
});
const routedReal = await routeCareInternalReply(
  routeAuditMock.client,
  { subject: '[SFC-a1b2c3d4] Re: Fuel log stuck', text: 'Re: [SFC-a1b2c3d4] Re: Fuel log stuck', fromEmail: 'support@sakafleet.com', bodyAvailable: false },
  { aiCall: async () => JSON.stringify({ lesson: '' }) }
);
check(routedReal && routedReal.bodyAvailable === false, 'the router reports bodyAvailable:false back to the webhook');
check(routeAuditMock.db.admin_audit_logs.some((row) => row.action === 'CARE_TICKET_HUMAN_REPLY' && /"bodyAvailable":false/.test(String(row.details))),
  'the CARE_TICKET_HUMAN_REPLY audit carries bodyAvailable:false (no more guessing)');

// Restore the caller's environment exactly as found (rule 50 hygiene).
if (PREV_CARE_AI_ENABLED === undefined) delete process.env.CARE_AI_ENABLED; else process.env.CARE_AI_ENABLED = PREV_CARE_AI_ENABLED;

console.log('');
console.log(passed + ' inbound-email assertions passed.');