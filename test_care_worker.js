/** Saka Fleet - Care console tests (v1.58.18, stateless, mock DB) */
import {
  normalizeThreadKey,
  isCareWorker,
  careCommandOf,
  openOrAppendEmailTicket,
  getCareTicket,
  handleCareCommand,
  formatCareTicket
} from './src/services/careConsole.js';

let pass = 0;
let fail = 0;
const check = (c, l) => { if (c) { pass += 1; console.log('  ok ' + l); } else { fail += 1; console.error('  FAIL ' + l); } };

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const iso = () => new Date().toISOString();

function makeMock({ tickets = [], messages = [], audits = [] } = {}, options = {}) {
  const db = {
    support_tickets: tickets.map((r) => ({ ...r })),
    support_ticket_messages: messages.map((r) => ({ ...r })),
    admin_audit_logs: audits.map((r) => ({ ...r }))
  };
  let seq = 1000;
  function query(table) {
    const state = { filters: [], limit: null, orderBy: null };
    const rows = () => db[table] || (db[table] = []);
    const match = (r) => state.filters.every(([c, v, op]) => {
      if (op === 'in') return v.indexOf(r[c]) !== -1;
      if (op === 'gte') return String(r[c] || '') >= String(v);
      if (op === 'ilike') return String(r[c] || '').toLowerCase().indexOf(String(v).split('%').join('').toLowerCase()) !== -1;
      return r[c] === v;
    });
    const result = () => {
      let out = rows().filter(match);
      if (state.orderBy) {
        const [c, asc] = state.orderBy;
        out = out.slice().sort((a, b) => (String(a[c] || '') < String(b[c] || '') ? -1 : 1) * (asc ? 1 : -1));
      }
      return state.limit ? out.slice(0, state.limit) : out;
    };
    const q = {
      select: () => { state.fail = typeof options.beforeSelect === 'function' ? options.beforeSelect(table) === true : false; return q; },
      eq: (c, v) => { state.filters.push([c, v, 'eq']); return q; },
      in: (c, v) => { state.filters.push([c, v, 'in']); return q; },
      gte: (c, v) => { state.filters.push([c, v, 'gte']); return q; },
      ilike: (c, v) => { state.filters.push([c, v, 'ilike']); return q; },
      or: () => q,
      order: (c, opts) => { state.orderBy = [c, !(opts && opts.ascending === false)]; return q; },
      limit: (n) => { state.limit = n; return q; },
      maybeSingle: async () => {
        if (state.fail) { state.fail = false; return { data: null, error: { message: 'simulated transient lookup failure' } }; }
        return { data: result()[0] || null, error: null };
      },
      then: (resolve) => {
        if (state.fail) { state.fail = false; return resolve({ data: null, error: { message: 'simulated transient lookup failure' } }); }
        return resolve({ data: result(), error: null });
      },
      insert: (payload) => {
        const items = Array.isArray(payload) ? payload : [payload];
        const saved = items.map((it) => ({ id: it.id || ('id-' + (seq += 1)), ...it }));
        for (const it of saved) rows().push(it);
        return { select: () => ({ maybeSingle: async () => ({ data: saved[0], error: null }) }) };
      },
      update: (patch) => ({
        eq: async (c, v) => {
          if (typeof options.beforeUpdate === 'function') {
            const rejection = options.beforeUpdate(table, patch);
            if (rejection && rejection.error) return { error: rejection.error };
          }
          for (const r of rows()) if (r[c] === v) Object.assign(r, patch);
          return { error: null };
        }
      })
    };
    return q;
  }
  return { __db: db, from: (t) => query(t) };
}

function seeded() {
  return makeMock({
    tickets: [
      { id: T1, whatsapp_number: '+254700000000', sender_email: 'user@example.com', issue_category: 'billing', message_body: 'Charged twice for renewal', subject: 'Charged twice for renewal', status: 'OPEN', priority: 'high', source: 'email', thread_key: 'k1', assigned_to: null, internal_note: null, created_at: iso(), updated_at: iso() },
      { id: T2, whatsapp_number: 'other@example.com', sender_email: 'other@example.com', issue_category: 'feature', message_body: 'Please add CSV export', subject: 'Please add CSV export', status: 'CLOSED', priority: 'low', source: 'email', thread_key: 'k2', assigned_to: null, internal_note: null, created_at: iso(), updated_at: iso() }
    ],
    messages: [{ id: 'm1', ticket_id: T1, direction: 'in', channel: 'email', message_body: 'Charged twice for renewal', created_at: iso() }]
  });
}

console.log('--- thread keys ---');
check(normalizeThreadKey({ senderEmail: 'User@X.com', subject: 'Re: Charged twice' }) === normalizeThreadKey({ senderEmail: 'user@x.com', subject: 'Fwd: Charged twice' }), 'Re:/Fwd: prefixes normalize to one thread key');
check(normalizeThreadKey({ senderEmail: 'a@x.com', subject: 'Hi' }) !== normalizeThreadKey({ senderEmail: 'b@x.com', subject: 'Hi' }), 'different senders never share a thread');
check(normalizeThreadKey({ senderEmail: 'a@x.com', subject: 'RE: [EXTERNAL] Help!' }).indexOf('|help') !== -1, 'bracketed tags and punctuation are stripped');

console.log('--- role + command detection ---');
delete process.env.CUSTOMER_CARE_PHONE;
check(isCareWorker('+254711111111') === false, 'care role is OFF until CUSTOMER_CARE_PHONE is set');
process.env.CUSTOMER_CARE_PHONE = '+254711111111';
check(isCareWorker('254711111111') === true, 'the configured worker is recognised (digits match)');
check(isCareWorker('+254799999999') === false, 'other numbers are not the worker');
check(careCommandOf('care inbox') === 'inbox' && careCommandOf(' CARE ') === '' && careCommandOf('hello') === null, 'only `care ...` is captured');

console.log('--- email intake: classify + thread ---');
const emailMock = makeMock();
const first = await openOrAppendEmailTicket(emailMock, { fromEmail: 'customer@example.com', subject: 'I was charged twice', text: 'Please refund the duplicate charge' });
check(first.ok === true && first.created === true, 'a first email opens a ticket');
check(first.category === 'billing' && first.priority === 'high', 'the email is classified (billing/high)');
const stored = emailMock.__db.support_tickets[0];
check(stored.status === 'OPEN' && stored.source === 'email' && stored.sender_email === 'customer@example.com', 'the ticket carries status/source/sender');
check(emailMock.__db.support_ticket_messages.length === 1 && emailMock.__db.support_ticket_messages[0].direction === 'in', 'the first message lands in the thread');
const second = await openOrAppendEmailTicket(emailMock, { fromEmail: 'customer@example.com', subject: 'Re: I was charged twice', text: 'Any update?' });
check(second.created === false && second.ticketId === first.ticketId, 'a reply threads into the same open ticket');
check(emailMock.__db.support_tickets.length === 1 && emailMock.__db.support_ticket_messages.length === 2, 'no duplicate ticket is created');
const feature = await openOrAppendEmailTicket(emailMock, { fromEmail: 'fan@example.com', subject: 'Feature idea', text: 'Would like an export feature' });
check(feature.category === 'feature' && feature.priority === 'low', 'a feature request is classified low priority');

console.log('--- read one ticket ---');
const readMock = seeded();
const ticket = await getCareTicket(readMock, '11111111');
check(ticket && ticket.id === T1, 'a short id prefix resolves to the ticket');
check((ticket.messages || []).length === 1, 'the thread comes with the ticket');
check(formatCareTicket(ticket).indexOf('Thread') !== -1 && formatCareTicket(ticket).indexOf('OPEN') !== -1, 'the rendered ticket shows status and thread');

const worker = '+254711111111';

console.log('--- permissions ---');
const permMock = seeded();
check((await handleCareCommand(permMock, { phone: '+254799999999', text: 'care inbox' })) === null, 'a non-worker cannot use care commands');
check((await handleCareCommand(permMock, { phone: worker, text: 'hello there' })) === null, 'normal chat is never hijacked');
check((await handleCareCommand(permMock, { phone: worker, text: 'admin help' })) === null, 'the worker cannot reach admin commands');
check((await handleCareCommand(permMock, { phone: worker, text: 'admin help', isSuperadminActor: true })) === null, 'care never captures non-care admin text');

console.log('--- inbox / read / stats / search ---');
const help = await handleCareCommand(permMock, { phone: worker, text: 'care' });
check(help.reply.indexOf('care inbox') !== -1 && help.reply.indexOf('care escalate') !== -1, 'care help lists the console commands');
const inbox = await handleCareCommand(permMock, { phone: worker, text: 'care inbox' });
check(inbox.reply.indexOf('Care inbox') !== -1 && inbox.reply.indexOf('Charged twice') !== -1, 'the inbox lists open tickets');
const inboxAll = await handleCareCommand(permMock, { phone: worker, text: 'care inbox all' });
check(inboxAll.reply.indexOf('CSV export') !== -1, 'care inbox all includes closed tickets');
const readOne = await handleCareCommand(permMock, { phone: worker, text: 'care read 11111111' });
check(readOne.reply.indexOf('Thread') !== -1, 'care read renders the thread');
const stats = await handleCareCommand(permMock, { phone: worker, text: 'care stats' });
check(stats.reply.indexOf('open:') !== -1 && stats.reply.indexOf('high priority') !== -1, 'care stats reports counters');
const search = await handleCareCommand(permMock, { phone: worker, text: 'care search Charged' });
check(search.reply.indexOf('Care inbox') !== -1, 'care search finds by body text');

console.log('--- lifecycle + escalation ladder ---');
const escMock = seeded();
let alerted = null;
const esc = await handleCareCommand(escMock, { phone: worker, text: 'care escalate 11111111', notifySuperadmin: async (p) => { alerted = p; return { alerted: true }; } });
check(esc.reply.indexOf('Superadmin alerted') !== -1, 'escalate alerts the superadmin');
check(alerted && alerted.priority === 'high', 'the superadmin alert carries high priority');
check(escMock.__db.support_tickets[0].priority === 'high', 'the ticket priority is high');
const de = await handleCareCommand(escMock, { phone: worker, text: 'care deescalate 11111111' });
check(de.reply.indexOf('medium') !== -1 && escMock.__db.support_tickets[0].priority === 'medium', 'de-escalate returns the ticket to medium');
const close = await handleCareCommand(escMock, { phone: worker, text: 'care close 11111111' });
check(close.reply.indexOf('Closed') !== -1 && escMock.__db.support_tickets[0].status === 'CLOSED', 'close sets CLOSED');
const reopen = await handleCareCommand(escMock, { phone: worker, text: 'care reopen 11111111' });
check(reopen.reply.indexOf('Reopened') !== -1 && escMock.__db.support_tickets[0].status === 'OPEN', 'reopen sets OPEN');
const note = await handleCareCommand(escMock, { phone: worker, text: 'care note 11111111 Customer is on a call' });
check(note.reply.indexOf('Note saved') !== -1 && String(escMock.__db.support_tickets[0].internal_note).indexOf('call') !== -1, 'the internal note is saved');
const take = await handleCareCommand(escMock, { phone: worker, text: 'care take 11111111' });
check(escMock.__db.support_tickets[0].assigned_to === worker && take.reply.indexOf('handling') !== -1, 'take assigns the worker');
await handleCareCommand(escMock, { phone: worker, text: 'care release 11111111' });
check(escMock.__db.support_tickets[0].assigned_to === null, 'release unassigns');

console.log('--- reply loop ---');
const replyMock = seeded();
const sentWhatsApp = [];
const sentEmail = [];
const reply = await handleCareCommand(replyMock, {
  phone: worker,
  text: 'care reply 11111111 We have refunded the duplicate charge',
  sendWhatsApp: async (to, body) => { sentWhatsApp.push([to, body]); return true; },
  sendEmail: async (m) => { sentEmail.push(m); return true; }
});
check(reply.reply.indexOf('whatsapp+email') !== -1, 'the reply goes out on both channels');
check(sentWhatsApp.length === 1 && sentWhatsApp[0][0] === '+254700000000', 'WhatsApp reaches the ticket phone');
check(sentEmail.length === 1 && sentEmail[0].to === 'user@example.com', 'email reaches the sender');
check(replyMock.__db.support_tickets[0].status === 'IN_PROGRESS', 'replying moves the ticket to in progress');
const outMsg = replyMock.__db.support_ticket_messages.filter((m) => m.direction === 'out');
check(outMsg.length === 1 && outMsg[0].channel === 'whatsapp+email', 'the outbound message is in the thread');

console.log('--- reply on an ESCALATED ticket (v1.97.4) ---');
const escalatedReplyMock = makeMock({
  tickets: [{ id: T1, whatsapp_number: 'esc@example.com', sender_email: 'esc@example.com', issue_category: 'logging', message_body: 'Fuel log stuck', subject: 'Fuel log stuck', status: 'ESCALATED', priority: 'high', source: 'email', thread_key: 'k-esc', assigned_to: null, internal_note: 'Amina escalated', created_at: iso(), updated_at: iso() }]
});
const escalatedReply = await handleCareCommand(escalatedReplyMock, { phone: worker, text: 'care reply 11111111 Type Log 40L diesel', sendEmail: async () => true });
check(escalatedReplyMock.__db.support_tickets[0].status === 'IN_PROGRESS', 'replying to an ESCALATED ticket moves it to IN_PROGRESS');
check(escalatedReplyMock.__db.support_ticket_messages.some((m) => m.direction === 'out' && String(m.message_body).indexOf('Log 40L diesel') !== -1), 'the reply lands in the thread as an out message');
check(escalatedReply.reply.indexOf('could not update') === -1, 'a clean status write carries no warning');

console.log('--- the silent status swallow is dead (v1.97.4) ---');
const blockedMock = makeMock(
  { tickets: [{ id: T1, whatsapp_number: '+254700000000', sender_email: 'user@example.com', issue_category: 'logging', message_body: 'Help', subject: 'Help', status: 'OPEN', priority: 'medium', source: 'email', thread_key: 'k-block', assigned_to: null, internal_note: null, created_at: iso(), updated_at: iso() }] },
  { beforeUpdate: (table) => (table === 'support_tickets' ? { error: { message: 'new row for relation "support_tickets" violates check constraint "support_tickets_status_check"' } } : null) }
);
const blocked = await handleCareCommand(blockedMock, { phone: worker, text: 'care reply 11111111 Try this now', sendEmail: async () => true });
await new Promise((resolve) => setTimeout(resolve, 25));
check(blocked.reply.indexOf('could not update the ticket status') !== -1, 'a refused status write is reported honestly (no false success)');
check(blockedMock.__db.support_ticket_messages.some((m) => m.direction === 'out'), 'the customer reply is still sent and threaded');
check((blockedMock.__db.error_logs || []).some((r) => String(r.route || '').indexOf('updateCareTicket') !== -1), 'the refusal is written to error_logs');

console.log('--- the lookup flake is dead (v1.97.4) ---');
let flakePulse = true;
const flakeMock = makeMock(
  { tickets: [{ id: T1, whatsapp_number: '+254700000000', sender_email: 'user@example.com', issue_category: 'logging', message_body: 'Help', subject: 'Help', status: 'OPEN', priority: 'medium', source: 'email', thread_key: 'k-flake', assigned_to: null, internal_note: null, created_at: iso(), updated_at: iso() }] },
  { beforeSelect: (table) => { if (table === 'support_tickets' && flakePulse) { flakePulse = false; return true; } return false; } }
);
const flaked = await handleCareCommand(flakeMock, { phone: worker, text: 'care reply 11111111 Retry works', sendEmail: async () => true });
await new Promise((resolve) => setTimeout(resolve, 25));
check(flaked.reply.indexOf('not found') === -1, 'a transient lookup failure never masquerades as "ticket not found"');
check(flakeMock.__db.support_tickets[0].status === 'IN_PROGRESS', 'the retried lookup completes the reply and the status write');
check((flakeMock.__db.error_logs || []).some((r) => String(r.route || '').indexOf('resolveCareTicketId') !== -1), 'the transient lookup failure is logged');

console.log('--- audit trail ---');
const audit = await handleCareCommand(replyMock, { phone: worker, text: 'care audit' });
check(audit.reply.indexOf('Care audit') !== -1, 'care audit renders');
const actions = replyMock.__db.admin_audit_logs.map((a) => a.action);
check(actions.indexOf('CARE_TICKET_REPLIED') !== -1, 'replies are audited');
check(replyMock.__db.admin_audit_logs.length > 0 && replyMock.__db.admin_audit_logs.every((a) => a.admin_phone), 'every audit row names the actor');

console.log('--- Amina escalation lifecycle (v1.80.0) ---');
const aminaEscMock = makeMock({
  tickets: [
    { id: T1, whatsapp_number: 'esc@example.com', sender_email: 'esc@example.com', issue_category: 'logging', message_body: 'Fuel log stuck', subject: 'Fuel log stuck', status: 'ESCALATED', priority: 'high', source: 'email', thread_key: 'k-esc', assigned_to: null, internal_note: 'Amina investigated (2 steps) and escalated: pre-gate: billing', ai_draft: 'Sorry about that — we are checking.', created_at: iso(), updated_at: iso() }
  ],
  messages: [],
  audits: []
});
const aminaEscInbox = await handleCareCommand(aminaEscMock, { phone: worker, text: 'care inbox' });
check(aminaEscInbox.reply.indexOf('Fuel log stuck') !== -1, 'the default inbox includes ESCALATED tickets (never silently dropped)');
const aminaEscFilter = await handleCareCommand(aminaEscMock, { phone: worker, text: 'care inbox escalated' });
check(aminaEscFilter.reply.indexOf('Fuel log stuck') !== -1 && aminaEscFilter.reply.indexOf('Care inbox') !== -1, 'care inbox escalated filters precisely');
const aminaEscStats = await handleCareCommand(aminaEscMock, { phone: worker, text: 'care stats' });
check(aminaEscStats.reply.indexOf('escalated: 1') !== -1, 'care stats counts escalated tickets');
const aminaEscRead = await handleCareCommand(aminaEscMock, { phone: worker, text: 'care read 11111111' });
check(aminaEscRead.reply.indexOf('Amina draft') !== -1, 'care read shows the draft Amina left behind');
check(aminaEscRead.reply.indexOf('ESCALATED') !== -1, 'care read names the escalated status');

console.log('--- reopen semantics + human ownership (v1.80.0) ---');
const reopenResolvedMock = makeMock({
  tickets: [
    { id: T1, whatsapp_number: 'back@example.com', sender_email: 'back@example.com', issue_category: 'logging', message_body: 'Fuel log', subject: 'Fuel log', status: 'RESOLVED', priority: 'medium', source: 'email', thread_key: normalizeThreadKey({ senderEmail: 'back@example.com', subject: 'Fuel log' }), created_at: iso(), updated_at: iso() }
  ]
});
const reopenFollowUp = await openOrAppendEmailTicket(reopenResolvedMock, { fromEmail: 'back@example.com', subject: 'Re: Fuel log', text: 'It happened again today' });
check(reopenFollowUp.created === false && reopenFollowUp.reopened === true && reopenFollowUp.ticketId === T1, 'a follow-up reopens the RESOLVED ticket (no duplicate)');
check(reopenResolvedMock.__db.support_tickets[0].status === 'OPEN', 'the reopened ticket is OPEN again');
check(reopenResolvedMock.__db.support_tickets.length === 1 && reopenResolvedMock.__db.support_ticket_messages.length === 1, 'one ticket, one new inbound message');
const humanOwnedMock = makeMock({
  tickets: [
    { id: T2, whatsapp_number: 'human@example.com', sender_email: 'human@example.com', issue_category: 'billing', message_body: 'Charged twice', subject: 'Charged twice', status: 'ESCALATED', priority: 'high', source: 'email', thread_key: normalizeThreadKey({ senderEmail: 'human@example.com', subject: 'Charged twice' }), created_at: iso(), updated_at: iso() }
  ]
});
const humanOwnedFollowUp = await openOrAppendEmailTicket(humanOwnedMock, { fromEmail: 'human@example.com', subject: 'Re: Charged twice', text: 'Any update?' });
check(humanOwnedFollowUp.humanOwned === true && humanOwnedFollowUp.reopened === false, 'a follow-up on an ESCALATED ticket stays human-owned');
check(humanOwnedMock.__db.support_tickets[0].status === 'ESCALATED', 'Amina never takes back an escalated ticket');

console.log('');
console.log((fail === 0 ? 'ALL CARE CONSOLE TESTS PASSED' : 'CARE CONSOLE TESTS FAILED') + ' (' + pass + ' assertions).');
process.exit(fail === 0 ? 0 : 1);


