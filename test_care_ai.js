/**
 * Saka Fleet — Amina, the autonomous care agent (v1.80.0, Phase 19, stateless).
 * Proves: the OFF gate, the zero-token pre-gate, the investigation tool loop
 * (named tools, bounded rounds), resolve vs escalate, the named-investigation
 * escalation email, the [SFC-] routing tag, and every failure degrades to the
 * human path (never a silent drop).
 */
import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  processCareEmail,
  runCareInvestigation,
  buildCareInvestigationPrompt,
  carePreGate,
  careReplySubject,
  careEscalationSubject,
  buildCareEscalationEmail,
  careConfidenceFloor,
  isCareAiEnabled,
  AMINA_NAME
} from './src/services/careAi.js';
import { CARE_STATUS } from './src/services/careConsole.js';

let passed = 0;
function check(cond, label) { assert.ok(cond, label); passed += 1; console.log('  ok ' + label); }

const TICKET_ID = '11111111-1111-1111-1111-111111111111';
const PREV_ENABLED = process.env.CARE_AI_ENABLED;
const PREV_FLOOR = process.env.CARE_AI_CONFIDENCE_FLOOR;
const PREV_ESC = process.env.CARE_ESCALATION_EMAIL;

function seed() {
  return {
    profiles: [{ id: 'p1', full_name: 'Jane Doe', email: 'jane@example.com', phone_number: '+254700000001', country: 'Kenya', subscription_tier: 'solo_pro', created_at: '2026-01-01T00:00:00Z' }],
    vehicles: [{ id: 'v1', owner_id: 'p1', plate_number: 'KAS 628T', make_model: 'Toyota Hilux', status: 'ACTIVE', current_mileage: 120000, deleted_at: null }],
    trial_sessions: [{ owner_id: 'p1', status: 'ACTIVE', tier: 'growth', ends_at: '2026-12-01T00:00:00Z', activated: false }],
    error_logs: [{ id: 'e1', error_message: 'DB timeout [phone=+254700000001]', route: '/webhook/whatsapp', status: 'unresolved', created_at: '2026-11-08T05:00:00Z' }],
    chat_history: [
      { id: 'c1', user_phone: '+254700000001', role: 'user', message: 'I am trying to log fuel', created_at: '2026-11-08T04:59:00Z' },
      { id: 'c2', user_phone: '+254700000001', role: 'assistant', message: 'Which vehicle?', created_at: '2026-11-08T04:59:30Z' }
    ],
    subscriptions: [{ id: 's1', owner_id: 'p1', tier: 'solo_pro', interval: 'monthly', status: 'ACTIVE', current_period_end: '2026-12-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z' }],
    paystack_webhook_events: [{ event_id: 'ev1', event_type: 'invoice.payment_failed', processed_at: '2026-11-07T10:00:00Z', payload: { metadata: { user_id: 'p1' } } }],
    support_tickets: [{
      id: TICKET_ID,
      subject: 'I cannot log fuel',
      status: 'OPEN',
      priority: 'medium',
      issue_category: 'logging',
      sender_email: 'jane@example.com',
      whatsapp_number: 'jane@example.com',
      message_body: 'I am trying to log fuel but nothing happens',
      thread_key: 'jane@example.com|i cannot log fuel',
      ai_draft: null,
      internal_note: null,
      created_at: '2026-11-08T05:00:00Z',
      updated_at: '2026-11-08T05:00:00Z'
    }],
    support_ticket_messages: [],
    admin_audit_logs: [],
    care_learnings: [{ id: 'l1', trigger_context: 'fuel logging failure', lesson: 'When a fuel log fails mid-quiz, ask the customer to reply "log expense" again in five minutes.', created_at: '2026-11-07T00:00:00Z' }]
  };
}

function ticket(overrides = {}) {
  return {
    ticketId: TICKET_ID,
    fromEmail: 'jane@example.com',
    subject: 'I cannot log fuel',
    text: 'I am trying to log fuel but nothing happens. I was in the middle of the quiz.',
    created: true,
    category: 'logging',
    priority: 'medium',
    ...overrides
  };
}

function ticketRow(mock) {
  return mock.db.support_tickets.find((row) => row.id === TICKET_ID) || {};
}

function audits(mock, action) {
  return mock.db.admin_audit_logs.filter((row) => row.action === action);
}

console.log('=== SAKA FLEET — AMINA AUTONOMOUS CARE AGENT (v1.80.0) ===\n');

console.log('--- Test 1: the kill switch is OFF by default (rule 46) ---');
delete process.env.CARE_AI_ENABLED;
check(isCareAiEnabled() === false, 'CARE_AI_ENABLED defaults to OFF');
const offMock = createMockSupabase(seed());
let offCalls = 0;
const offResult = await processCareEmail(offMock.client, ticket(), { aiCall: async () => { offCalls += 1; return '{}'; } });
check(offResult.action === 'disabled' && offResult.handled === false, 'disabled: Amina never runs and the human path stays intact');
check(offCalls === 0, 'disabled: zero model calls (zero tokens)');
check(ticketRow(offMock).status === 'OPEN' && offMock.db.support_ticket_messages.length === 0, 'disabled: the ticket is untouched');

console.log('\n--- Test 2: the zero-token pre-gate ---');
check(carePreGate('Please refund the duplicate charge', 'medium') === 'billing', 'money/dispute text is pre-gated as billing');
check(carePreGate('I will take legal action', 'medium') === 'dangerous-action', 'legal/account actions are pre-gated');
check(carePreGate('hello there', 'high') === 'priority-high', 'a high-priority ticket is pre-gated');
check(carePreGate('How do I add a driver?', 'medium') === null, 'a plain how-to question reaches the investigation');

console.log('\n--- Test 3: subjects + escalation copy ---');
check(careReplySubject({ subject: 'Re: Re: I cannot log fuel' }) === 'Re: I cannot log fuel', 'the customer reply carries exactly one Re: and no internal tag');
check(careEscalationSubject({ ticketId: TICKET_ID, subject: 'I cannot log fuel' }).indexOf('[SFC-11111111]') === 0, 'the human escalation subject starts with the [SFC-] routing tag');
const escalationText = buildCareEscalationEmail({
  ticket: ticket(),
  steps: [{ tool: 'get_recent_errors', result: { matches: 1 } }, { tool: 'get_recent_chat', result: { matches: 2 } }],
  reason: 'confidence below the 0.7 floor',
  draft: 'Draft reply'
});
check(/What I investigated/.test(escalationText) && /get_recent_errors/.test(escalationText) && /get_recent_chat/.test(escalationText),
  'the escalation names every tool Amina ran');
check(/Where I am stuck: confidence below the 0.7 floor/.test(escalationText), 'the escalation names exactly where she stopped');
check(/NOT sent to the customer/.test(escalationText) && /Draft reply/.test(escalationText), 'the human sees the best draft, labelled as unsent');

console.log('\n--- Test 4: the investigation directive + learned rules in the prompt ---');
const prompt = buildCareInvestigationPrompt({
  learnings: [{ lesson: 'Ask for a fresh "log expense" after a quiz timeout.' }]
});
check(new RegExp('You are ' + AMINA_NAME).test(prompt), 'the prompt names Amina verbatim');
check(/INVESTIGATION DIRECTIVE \(absolute\)/.test(prompt), 'the investigation directive is pinned in the prompt');
check(/Exhaust every tool before you escalate/.test(prompt), 'the "exhaust all avenues" law is pinned');
check(/Ask for a fresh "log expense" after a quiz timeout/.test(prompt), 'the newest learned rule is injected');
check(/get_profile_context/.test(prompt) && /get_recent_errors/.test(prompt) && /get_recent_chat/.test(prompt) && /get_payment_status/.test(prompt),
  'all four investigation tools are named in the prompt');
check(/Never promise an action you cannot take/.test(prompt) && /Never ask for a PIN, OTP, password or card number/.test(prompt),
  'the hard boundaries are pinned in the prompt');
check(careConfidenceFloor() === 0.7, 'the confidence floor defaults to 0.7');

console.log('\n--- Test 5: billing is escalated with zero model calls ---');
process.env.CARE_AI_ENABLED = 'on';
process.env.CARE_ESCALATION_EMAIL = 'support@sakafleet.com';
const billingMock = createMockSupabase(seed());
let billingCalls = 0;
let forwarded = null;
let alerted = null;
const billingResult = await processCareEmail(billingMock.client, ticket({ text: 'I was charged twice on Paystack, please refund me', priority: 'high' }), {
  aiCall: async () => { billingCalls += 1; return '{}'; },
  sendEmail: async () => { throw new Error('Amina must never email a billing reply'); },
  sendEscalationEmail: async (payload) => { forwarded = payload; return true; },
  notifySuperadmin: async (payload) => { alerted = payload; return { alerted: true }; }
});
check(billingResult.action === 'escalated' && billingResult.handled === true, 'billing is escalated');
check(billingCalls === 0, 'billing never reaches the model (zero tokens)');
check(ticketRow(billingMock).status === CARE_STATUS.ESCALATED, 'the ticket is marked ESCALATED');
check(/pre-gate: billing/.test(String(ticketRow(billingMock).internal_note)), 'the note names the pre-gate reason');
check(forwarded && forwarded.to === 'support@sakafleet.com', 'the escalation is forwarded to the HUMAN inbox');
check(forwarded && forwarded.subject.indexOf('[SFC-11111111]') === 0, 'the forward carries the routing tag');
check(/charge|billing|pre-gate/i.test(forwarded.text) && /Where I am stuck/.test(forwarded.text), 'the forward states where Amina stopped');
check(alerted && alerted.priority === 'high', 'the superadmin is pinged');
check(audits(billingMock, 'CARE_TICKET_AI_ESCALATED').length === 1, 'the escalation is audited');

console.log('\n--- Test 6: investigate → resolve (the good path) ---');
const resolveMock = createMockSupabase(seed());
const replies = [
  JSON.stringify({ tool: 'get_recent_errors', args: { phone: '+254700000001' } }),
  JSON.stringify({ tool: 'get_profile_context', args: { email: 'jane@example.com' } }),
  JSON.stringify({ action: 'reply', reply: 'Hi Jane — a database timeout stopped that quiz. Reply "log expense" once more and it will save; nothing was charged.', confidence: 0.93, reason: 'known timeout' })
];
const aiCalls = [];
let sentEmail = null;
const resolveResult = await processCareEmail(resolveMock.client, ticket(), {
  aiCall: async (payload) => { aiCalls.push(payload); return replies[aiCalls.length - 1]; },
  sendEmail: async (payload) => { sentEmail = payload; return true; },
  sendEscalationEmail: async () => { throw new Error('no escalation expected'); },
  notifySuperadmin: async () => ({ alerted: false })
});
check(resolveResult.action === 'resolved' && resolveResult.handled === true, 'a confident investigation resolves the ticket');
check(aiCalls.length === 3, 'two tool rounds + one decision = three purpose-tagged calls');
check(aiCalls.every((call) => call.purpose === 'care_investigation' && call.jsonMode === true), 'every call is purpose-tagged care_investigation (rule 20)');
check(/TOOL RESULT get_recent_errors/.test(JSON.stringify(aiCalls[1].messages)), 'the engine returned the first tool result into the conversation');
check(/TOOL RESULT get_profile_context/.test(JSON.stringify(aiCalls[2].messages)), 'the engine returned the second tool result into the conversation');
check(/INVESTIGATION DIRECTIVE/.test(aiCalls[0].system) && /log expense/.test(aiCalls[0].system), 'the system prompt carries the directive + FAQ');
check(/fuel log fails mid-quiz/.test(aiCalls[0].system), 'the learned rule is injected into the live prompt');
check(sentEmail && sentEmail.to === 'jane@example.com' && /^Re: I cannot log fuel$/.test(sentEmail.subject), 'the reply goes to the customer with a clean subject');
check(String(ticketRow(resolveMock).status).toUpperCase() === CARE_STATUS.RESOLVED, 'the ticket is RESOLVED');
check(String(ticketRow(resolveMock).ai_draft || '').indexOf('database timeout') !== -1, 'Amina\'s draft is stored on the ticket');
check(resolveMock.db.support_ticket_messages.some((row) => row.direction === 'out' && row.channel === 'email'), 'the sent reply is in the thread');
check(audits(resolveMock, 'CARE_TICKET_AI_RESOLVED').length === 1, 'the resolution is audited');
check(resolveResult.tools.join(',') === 'get_recent_errors,get_profile_context', 'the result names the tools she used');

console.log('\n--- Test 7: low confidence escalates with the named investigation ---');
const lowMock = createMockSupabase(seed());
let lowForward = null;
const lowReplies = [
  JSON.stringify({ tool: 'get_recent_chat', args: { phone: '+254700000001' } }),
  JSON.stringify({ action: 'reply', reply: 'I think you should try again.', confidence: 0.2, reason: 'not sure' })
];
let lowIndex = 0;
const lowResult = await processCareEmail(lowMock.client, ticket(), {
  aiCall: async () => lowReplies[lowIndex++],
  sendEmail: async () => { throw new Error('a low-confidence draft must never be sent'); },
  sendEscalationEmail: async (payload) => { lowForward = payload; return true; },
  notifySuperadmin: async () => ({ alerted: true })
});
check(lowResult.action === 'escalated', 'below-floor confidence escalates');
check(lowReplies.length === lowIndex, 'exactly two calls (one tool + one decision)');
check(/confidence 0\.2 below the 0\.7 floor/.test(lowResult.reason), 'the reason names the exact confidence and the floor');
check(/get_recent_chat/.test(lowForward.text) && /What I investigated/.test(lowForward.text), 'the forward names the tool she ran');
check(/Best draft I could prepare \(NOT sent to the customer\)/.test(lowForward.text) && /I think you should try again/.test(lowForward.text),
  'the human receives the best-effort draft, explicitly unsent');
check(lowMock.db.support_ticket_messages.some((row) => row.channel === 'ai' && row.direction === 'internal'),
  'the investigation log is stored as internal AI messages');

console.log('\n--- Test 8: the tool-round limit is bounded ---');
const loopMock = createMockSupabase(seed());
let loopCalls = 0;
const loopResult = await runCareInvestigation({
  supabase: loopMock.client,
  ticket: ticket(),
  deps: {
    aiCall: async () => {
      loopCalls += 1;
      return JSON.stringify({ tool: 'get_profile_context', args: { email: 'jane@example.com' } });
    }
  }
});
check(loopCalls === 3, 'the loop stops at exactly three tool rounds');
check(loopResult.action === 'escalate' && /loop limit/.test(loopResult.reason), 'an undecided loop escalates honestly');
check(loopResult.steps.length === 3, 'all three investigation steps are recorded');

console.log('\n--- Test 9: tool outputs are honest + engine-owned ---');
const careAi = await import('./src/services/careAi.js');
const toolErrors = await careAi.toolGetRecentErrors(loopMock.client, { phone: '+254799999999' });
check(toolErrors.matches === 0 && Array.isArray(toolErrors.errors), 'no matching errors is an honest empty result (never invented)');
const chatTool = await careAi.toolGetRecentChat(loopMock.client, { phone: '+254700000001' });
check(chatTool.matches === 2 && chatTool.messages[0].from === 'user', 'the recent chat is chronological and labelled');
const payTool = await careAi.toolGetPaymentStatus(loopMock.client, { email: 'jane@example.com' });
check(payTool.found === true && payTool.recentEvents.length === 1 && /human-owned/.test(payTool.note),
  'the payment mirror is read-only and labels human-owned outcomes');
const profileTool = await careAi.toolGetProfileContext(loopMock.client, { email: 'jane@example.com' });
check(profileTool.found && profileTool.vehicles[0].plate === 'KAS 628T' && profileTool.plan === 'solo_pro', 'profile context carries plan + vehicles');

console.log('\n--- Test 10: failures degrade to the human, never silently ---');
const failMock = createMockSupabase(seed());
const failResult = await processCareEmail(failMock.client, ticket(), {
  aiCall: async () => { throw new Error('provider down'); },
  sendEscalationEmail: async () => { throw new Error('mail down'); },
  notifySuperadmin: async () => { throw new Error('ping down'); }
});
check(failResult.action === 'escalated', 'even a total provider+mail failure escalates rather than answering blindly');
check(audits(failMock, 'CARE_TICKET_AI_ESCALATED').length === 1, 'the degraded path is still audited');
const skipped = await processCareEmail(createMockSupabase(seed()).client, ticket({ humanOwned: true }), { aiCall: async () => { throw new Error('must not run'); } });
check(skipped.action === 'skipped' && /human owns/.test(skipped.reason), 'a human-owned (ESCALATED) ticket is never re-answered by Amina');
const noTicket = await processCareEmail(createMockSupabase(seed()).client, {}, {});
check(noTicket.action === 'skipped', 'no ticket id = a safe skip');

// restore the environment for every other suite in the same process
if (PREV_ENABLED === undefined) delete process.env.CARE_AI_ENABLED; else process.env.CARE_AI_ENABLED = PREV_ENABLED;
if (PREV_FLOOR === undefined) delete process.env.CARE_AI_CONFIDENCE_FLOOR; else process.env.CARE_AI_CONFIDENCE_FLOOR = PREV_FLOOR;
if (PREV_ESC === undefined) delete process.env.CARE_ESCALATION_EMAIL; else process.env.CARE_ESCALATION_EMAIL = PREV_ESC;

console.log('\n🎉 ' + passed + ' Amina care-agent assertions passed.');
console.log('Stateless suite: in-memory mock only; nothing was written to the database.');



