/** Saka Fleet - Resend inbound email tests (v1.58.14, stateless) */
import assert from 'assert';
import crypto from 'node:crypto';
import { verifyResendSignature, parseInboundEmail, handleInboundEmail, SUPPORT_INBOX } from './src/services/inboundEmail.js';

let passed = 0;
function check(cond, label) { assert.ok(cond, label); passed += 1; console.log('  ok ' + label); }

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
check(db.__db.support_tickets[0].issue_category === 'email', 'the ticket is categorised email');
check(db.__db.support_tickets[0].whatsapp_number === 'customer@example.com', 'the ticket carries the sender');
check(notified && notified.phone === '+254700000000', 'the customer-care worker is pinged');
check(notified && notified.text.indexOf('Help with my truck') !== -1, 'the ping carries the subject');
check(notified && notified.text.indexOf('support@reports.sakafleet.com') !== -1, 'the care ping names the support inbox');

console.log('--- recipient gate ---');
const offInbox = await handleInboundEmail(mock(), { payload: { type: 'email.received', data: { email_id: 'e9', from: 'customer@example.com', to: ['someone@example.com'], subject: 'Not support' } }, headers: {}, rawBody: '{}', secret: null, skipFetch: true });
check(offInbox.ok === true && offInbox.ignored === 'not-support-recipient', 'mail addressed outside the support inbox is ignored');

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

console.log('');
console.log(passed + ' inbound-email assertions passed.');