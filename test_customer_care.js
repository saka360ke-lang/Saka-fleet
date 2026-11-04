// v1.58.10 - autonomous customer care (mock; stateless, no real email/WhatsApp).
import { classifyCareRequest, shouldEscalateCare, openCareTicket, handleInboundSupportEmail, handleCareRequest } from './src/services/customerCare.js';

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
