// v1.58.10 - autonomous customer care (mock; stateless, no real email/WhatsApp).
import { classifyCareRequest, shouldEscalateCare, openCareTicket, handleInboundSupportEmail, handleCareRequest } from './src/services/customerCare.js';
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const check = (c, l) => { if (c) { pass += 1; console.log('✅', l); } else { fail += 1; console.error('❌', l); } };

function makeMock({ profile = null } = {}) {
  const inserts = [];
  const builder = (table) => {
    const chain = {
      select() { return chain; },
      ilike() { return chain; },
      eq() { return chain; },
      limit() { return chain; },
      insert(rows) { inserts.push({ table, rows }); return { select: () => Promise.resolve({ data: [{ id: 't1' }], error: null }) }; },
      then(resolve) {
        if (table === 'profiles') resolve({ data: profile ? [profile] : [] });
        else resolve({ data: [] });
      }
    };
    return chain;
  };
  return { inserts, client: { from: builder } };
}

async function run() {
  check(classifyCareRequest('I was charged twice').category === 'billing', 'billing classified');
  check(classifyCareRequest('the app is broken, not working').category === 'bug', 'bug classified');
  check(classifyCareRequest('how do I log fuel').category === 'logging', 'logging classified');
  check(classifyCareRequest('can you add a feature to export').category === 'feature', 'feature classified');
  check(classifyCareRequest('random words here').category === 'other', 'other classified');
  check(shouldEscalateCare('I want a refund', 'high') === true, 'refund/high escalates');
  check(shouldEscalateCare('how do I log fuel', 'medium') === false, 'routine does not escalate');

  const m1 = makeMock();
  const t = await openCareTicket(m1.client, { phone: '+254700000000', body: 'help', category: 'bug' });
  check(t.ok === true && m1.inserts.length === 1 && m1.inserts[0].table === 'support_tickets', 'ticket inserted into support_tickets');
  // v1.58.22 - the lifecycle columns ride the insert (the live table rejected a
  // bare four-column insert and the promise went out with no ticket row).
  const ticketRow = m1.inserts[0].rows[0];
  check(ticketRow.status === 'OPEN' && ticketRow.priority === 'medium' && ticketRow.source === 'whatsapp' && Boolean(ticketRow.thread_key), 'the ticket carries the care lifecycle fields');

  const legacy = {
    inserts: [],
    client: {
      from() {
        return {
          insert(rows) {
            legacy.inserts.push(rows);
            const row = Array.isArray(rows) ? rows[0] : rows;
            if ('status' in row) return { select: () => Promise.resolve({ data: null, error: { message: 'column "status" of relation "support_tickets" does not exist' } }) };
            return { select: () => Promise.resolve({ data: [{ id: 'legacy-1' }], error: null }) };
          }
        };
      }
    }
  };
  const legacyTicket = await openCareTicket(legacy.client, { phone: '+254700000000', body: 'help' });
  check(legacyTicket.ok === true && legacy.inserts.length === 2, 'an unknown lifecycle column falls back to the slim insert');

  const savedPhone = process.env.SUPERADMIN_PHONE;
  const savedMail = process.env.SUPERADMIN_EMAIL;
  delete process.env.SUPERADMIN_PHONE;
  delete process.env.SUPERADMIN_EMAIL;
  const brokenClient = { from() { return { insert() { return { select: () => Promise.resolve({ data: null, error: { message: 'permission denied for table support_tickets' } }) }; }, select() { return this; }, limit: async () => ({ data: [], error: null }) }; } };
  const brokenCare = await handleCareRequest(brokenClient, { phone: '+254700000000', text: 'help with fuel logging' });
  check(brokenCare.ticketCreated === false, 'a failed ticket insert is reported (never claimed as forwarded)');
  if (savedPhone !== undefined) process.env.SUPERADMIN_PHONE = savedPhone;
  if (savedMail !== undefined) process.env.SUPERADMIN_EMAIL = savedMail;

  // v1.58.22 - route-level guards for the live 2026-11-04 frictions.
  const wa = fs.readFileSync('./src/routes/whatsapp/messages.js', 'utf8');
  // v1.68.0 — Phase 5B-3: the statement park lives in src/routes/whatsapp/quiz.js.
  const quizSrc = fs.readFileSync('./src/routes/whatsapp/quiz.js', 'utf8');
  check(/support_intake_handled/.test(wa) && wa.indexOf('support_intake_handled') < wa.indexOf('isStopRequest(cleanCmd)'), 'the support intake lock runs before stop/quiz handling');
  check(/ticketCreated\s*\?/.test(wa), 'the forwarded copy is gated on a real ticket');
  check(/statement_not_answer/.test(quizSrc), 'a statement mid-draft parks the draft instead of looping');

  const m2 = makeMock({ profile: { id: 'p1', phone_number: '+254700000000', email: 'd@x.com' } });
  const sent = [];
  const r2 = await handleInboundSupportEmail(m2.client, { fromEmail: 'D@X.com', text: 'Your issue is fixed', sendWhatsApp: async (p, m) => { sent.push([p, m]); return true; } });
  check(r2.ok === true && r2.phone === '+254700000000' && sent.length === 1, 'inbound email relays to WhatsApp');

  const m3 = makeMock({ profile: null });
  const r3 = await handleInboundSupportEmail(m3.client, { fromEmail: 'nobody@x.com', text: 'hi', sendWhatsApp: async () => true });
  check(r3.ok === false && r3.reason === 'no-matching-profile', 'unknown sender is not relayed');

  const m4 = makeMock();
  const saved = process.env.SUPERADMIN_PHONE;
  const savedEmail = process.env.SUPERADMIN_EMAIL;
  delete process.env.SUPERADMIN_PHONE;
  delete process.env.SUPERADMIN_EMAIL;
  const r4 = await handleCareRequest(m4.client, { phone: '+254700000000', text: 'urgent, I want a refund', profile: null });
  check(r4.category === 'billing' && r4.priority === 'high', 'care request classified');
  check(m4.inserts.some((i) => i.table === 'support_tickets'), 'care request opens a ticket');
  if (saved !== undefined) process.env.SUPERADMIN_PHONE = saved;
  if (savedEmail !== undefined) process.env.SUPERADMIN_EMAIL = savedEmail;
}

run().then(() => {
  console.log(`\n${fail === 0 ? '✅ ALL CUSTOMER CARE TESTS PASSED' : '❌ CUSTOMER CARE TESTS FAILED'} (${pass} assertions).`);
  if (fail > 0) process.exit(1);
}).catch((e) => { console.error('Customer care test crashed:', e); process.exit(1); });
