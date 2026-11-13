/**
 * Saka Fleet — Amina's learning loop (v1.80.0, Phase 19, stateless).
 * Proves: the [SFC-] routing tag, human-reply routing into the SAME ticket,
 * PII-safe lesson extraction (`care_learning`), the newest-ten injection, and
 * that a lesson can never carry prices, refunds or personal data.
 */
import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  parseCareAiJson,
  sanitizeCareLesson,
  careTicketTag,
  extractCareTicketTag,
  isCareInternalSender,
  getRecentCareLearnings,
  formatCareLearnings,
  extractCareLesson,
  routeCareInternalReply,
  CARE_LEARNING_SYSTEM_PROMPT
} from './src/services/careLearning.js';

let passed = 0;
function check(cond, label) { assert.ok(cond, label); passed += 1; console.log('  ok ' + label); }

const TICKET_ID = '22222222-2222-2222-2222-222222222222';

function seed() {
  return {
    support_tickets: [{
      id: TICKET_ID,
      subject: 'Receipt photo not showing',
      status: 'ESCALATED',
      priority: 'high',
      issue_category: 'logging',
      sender_email: 'customer@example.com',
      whatsapp_number: 'customer@example.com',
      message_body: 'I uploaded a receipt but it is not showing in my receipts list.',
      assigned_to: null,
      created_at: '2026-11-08T05:00:00Z',
      updated_at: '2026-11-08T05:00:00Z'
    }],
    support_ticket_messages: [],
    admin_audit_logs: [],
    care_learnings: [
      { id: 'l-old', trigger_context: 'old', lesson: 'Old lesson', created_at: '2026-11-01T00:00:00Z' },
      { id: 'l-new', trigger_context: 'new', lesson: 'Newest lesson', created_at: '2026-11-08T00:00:00Z' }
    ]
  };
}

console.log('=== SAKA FLEET — AMINA LEARNING LOOP (v1.80.0) ===\n');

console.log('--- Test 1: tag + internal-sender recognition ---');
check(careTicketTag(TICKET_ID) === '[SFC-22222222]', 'a ticket tag is the first 8 hex chars');
check(extractCareTicketTag('Re: [SFC-22222222] Receipt photo not showing') === '22222222', 'the tag survives a Re: prefix');
check(extractCareTicketTag('No tag here') === null, 'a subject without a tag returns null');
check(isCareInternalSender('support@sakafleet.com') === true, 'the human care inbox is internal');
check(isCareInternalSender('agent@reports.sakafleet.com') === false, 'the platform subdomain is NOT the human care inbox');
check(isCareInternalSender('customer@example.com') === false, 'a customer is never internal');

console.log('\n--- Test 2: the JSON reader + PII-safe lesson sanitizer ---');
check(parseCareAiJson('```json\n{"lesson":"x"}\n```')?.lesson === 'x', 'fenced JSON is parsed');
check(parseCareAiJson('Sure! {"lesson":"y"} hope that helps')?.lesson === 'y', 'prose around JSON is tolerated');
check(parseCareAiJson('not json at all') === null, 'unparseable output returns null');
check(parseCareAiJson({ ok: true, text: '{"lesson":"wrapped"}' })?.lesson === 'wrapped', 'the aiClient { ok, text } wrapper is unwrapped (v1.97.7)');
check(parseCareAiJson({ lesson: 'plain object' })?.lesson === 'plain object', 'a pre-parsed object still parses as-is');
const scrubbed = sanitizeCareLesson('Email jane@example.com or call +254700000001 and ref 123456789012 about it');
check(!scrubbed.includes('jane@example.com') && scrubbed.includes('[email]'), 'emails are scrubbed from a lesson');
check(!scrubbed.includes('+254700000001') && scrubbed.includes('[phone]'), 'phone numbers are scrubbed');
check(!scrubbed.includes('123456789012') && scrubbed.includes('[number]'), 'long numeric identifiers are scrubbed');
check(sanitizeCareLesson('a'.repeat(900)).length === 500, 'a lesson is bounded to 500 characters');

console.log('\n--- Test 3: lesson extraction stores ONE safe rule ---');
const extractMock = createMockSupabase(seed());
let lessonPrompt = null;
const extracted = await extractCareLesson(
  extractMock.client,
  { ticket: seed().support_tickets[0], humanReply: 'Tell them to re-upload the receipt photo — the Meta 24h window expired, so the image must be sent again.' },
  { aiCall: async (payload) => { lessonPrompt = payload; return JSON.stringify({ lesson: 'When a receipt photo is missing, ask the customer to re-upload it — the WhatsApp 24h media window expired.', trigger_context: 'missing receipt photo', confidence: 0.9 }); } }
);
check(extracted.ok === true, 'a human reply yields a stored lesson');
check(lessonPrompt.purpose === 'care_learning' && lessonPrompt.jsonMode === true, 'extraction is purpose-tagged care_learning');
check(/human_reply/.test(lessonPrompt.messages[0].content), 'the prompt carries the human reply verbatim');
check(/Never include names, phone numbers, emails/.test(CARE_LEARNING_SYSTEM_PROMPT), 'the prompt forbids personal data');
check(/never change code, schema, prices or permissions/.test(CARE_LEARNING_SYSTEM_PROMPT), 'the prompt states lessons are prompt-only hints');
check(extractMock.db.care_learnings.some((row) => row.ticket_id === TICKET_ID && /re-upload/.test(row.lesson)), 'the lesson is stored against the ticket');
check(extractMock.db.admin_audit_logs.some((row) => row.action === 'CARE_TICKET_LEARNED'), 'the lesson is audited');

console.log('\n--- Test 3b: the REAL aiClient shape teaches a lesson (v1.97.7) ---');
// Live 2026-11-13: chatCompletion returns { ok, text, model, error, stopReason }.
// The old parser fed that wrapper straight in, so parsed.lesson was undefined
// and every real human reply silently produced "no-reusable-lesson". This pin
// fails if the string-returning test stub ever hides that again.
const liveShapeMock = createMockSupabase(seed());
const liveShape = await extractCareLesson(
  liveShapeMock.client,
  { ticket: seed().support_tickets[0], humanReply: 'For future reference: ask the customer to re-upload the receipt image.' },
  { aiCall: async () => ({ ok: true, text: JSON.stringify({ lesson: 'Ask for a re-upload when a receipt image is missing.', trigger_context: 'missing receipt', confidence: 0.9 }), model: 'deepseek-chat', error: null, stopReason: 'stop' }) }
);
check(liveShape.ok === true && /re-upload/.test(liveShape.lesson), 'the provider wrapper { ok, text } no longer swallows the lesson (mock-vs-prod pin)');
check(liveShapeMock.db.care_learnings.some((row) => /re-upload/.test(row.lesson)), 'the lesson is stored from the real response shape');

console.log('\n--- Test 4: refusals are honest, never invented ---');
const shortReply = await extractCareLesson(createMockSupabase(seed()).client, { ticket: seed().support_tickets[0], humanReply: 'ok' }, { aiCall: async () => '{}' });
check(shortReply.ok === false && shortReply.reason === 'reply-too-short', 'a two-letter reply never becomes a lesson');
const emptyLesson = await extractCareLesson(createMockSupabase(seed()).client, { ticket: seed().support_tickets[0], humanReply: 'We refunded the customer in full, twice.' }, { aiCall: async () => JSON.stringify({ lesson: '' }) });
check(emptyLesson.ok === false && emptyLesson.reason === 'no-reusable-lesson', 'a refund-only reply yields no lesson');
const unparseable = await extractCareLesson(createMockSupabase(seed()).client, { ticket: seed().support_tickets[0], humanReply: 'Re-upload the image from the original message.' }, { aiCall: async () => 'nope' });
check(unparseable.ok === false && unparseable.reason === 'unparseable', 'unparseable output is refused');


console.log('\n--- Test 5: the newest ten lessons are injected, numbered ---');
const recent = await getRecentCareLearnings(createMockSupabase(seed()).client);
check(recent.length === 2 && recent[0].id === 'l-new', 'lessons come newest first');
check((await getRecentCareLearnings(createMockSupabase({}).client)).length === 0, 'a missing table degrades to an empty list (rule 50)');
const formatted = formatCareLearnings([{ lesson: 'Rule one' }, { lesson: 'Rule two' }]);
check(/^1\. Rule one\n2\. Rule two$/.test(formatted), 'the prompt block is numbered');
check(formatCareLearnings([]).indexOf('none yet') !== -1, 'the empty state is honest');

console.log('\n--- Test 6: a human reply routes into the SAME ticket ---');
const routeMock = createMockSupabase(seed());
const routed = await routeCareInternalReply(
  routeMock.client,
  { subject: '[SFC-22222222] Re: Receipt photo not showing', text: 'Ask them to re-upload the image — the media window expired.', fromEmail: 'support@sakafleet.com' },
  { aiCall: async () => JSON.stringify({ lesson: 'Ask for a re-upload when a receipt image is missing.', trigger_context: 'missing receipt' }) }
);
check(routed && routed.ok === true && routed.ticketId === TICKET_ID, 'the reply lands on the tagged ticket');
check(routeMock.db.support_tickets.length === 1, 'no duplicate ticket is opened');
check(routeMock.db.support_ticket_messages.some((row) => row.direction === 'internal' && /Human reply/.test(row.message_body)),
  'the human reply is stored as an internal message');
check(String(routeMock.db.support_tickets[0].status) === 'IN_PROGRESS', 'a human reply puts the ticket in progress');
check(routeMock.db.support_tickets[0].assigned_to === 'support@sakafleet.com', 'the human is recorded as the assignee');
check(routed.learned === true, 'the same reply teaches Amina one lesson');
check(routeMock.db.admin_audit_logs.some((row) => row.action === 'CARE_TICKET_HUMAN_REPLY'), 'the human reply is audited');
const untagged = await routeCareInternalReply(routeMock.client, { subject: 'Just a note', text: 'hello', fromEmail: 'support@sakafleet.com' });
check(untagged === null, 'mail without a tag is not treated as a ticket reply');
const missing = await routeCareInternalReply(routeMock.client, { subject: '[SFC-99999999] Re: nope', text: 'hello there', fromEmail: 'support@sakafleet.com' });
check(missing && missing.ok === false && missing.reason === 'ticket-not-found', 'an unknown tag is refused honestly');

console.log('\n🎉 ' + passed + ' Amina learning-loop assertions passed.');
console.log('Stateless suite: in-memory mock only; nothing was written to the database.');

