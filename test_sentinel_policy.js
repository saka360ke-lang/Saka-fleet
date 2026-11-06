/**
 * Saka Fleet - Sentinel policy tests (v1.58.14, stateless)
 * Sentinel detects friction/errors but never offers proposals unless the
 * master switch is on; findings go to the friction log instead.
 */
import assert from 'assert';
import fs from 'node:fs';
import { isSentinelProposalsEnabled, SENTINEL_PROPOSALS_DEFAULT } from './src/services/sentinelPolicy.js';
import { isConversationDiagnosisEnabled, recordConversationProposal } from './src/services/conversationDiagnosis.js';
import { mintFindingLog, mintFindingProposal } from './src/services/deepAudit.js';
import { recordFriction } from './src/services/frictionTracker.js';
import { markDeliveryBlocked, isDeliveryBlocked, clearDeliveryBlock, PERMANENT_FAILURE_CODES } from './src/services/deliveryGuard.js';
import { sendProactiveWhatsApp } from './src/workers/sentinel.js';

let passed = 0;
function check(cond, label) { assert.ok(cond, label); passed += 1; console.log('  ok ' + label); }

function mock() {
  const db = { chat_friction_logs: [], error_logs: [] };
  return { __db: db, from(name) {
    const r = db[name] || (db[name] = []);
    return {
      insert(payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const it of items) r.push({ id: 'id-' + (r.length + 1), ...it });
        return { select: () => ({ maybeSingle: async () => ({ data: { id: r[r.length - 1].id }, error: null }) }) };
      },
      update() { return { eq: async () => ({ error: null }), in: async () => ({ error: null }) }; },
      select() { const q = { eq: () => q, in: () => q, gte: () => q, order: () => q, limit: async () => ({ data: r }), maybeSingle: async () => ({ data: r[0] || null }) }; return q; }
    };
  } };
}

console.log('--- delivery guard (v1.58.23) ---');
check(markDeliveryBlocked('+254799000512', '131026') === true, 'a permanent failure blocks the recipient');
check(isDeliveryBlocked('254799000512') === true, 'the block matches without the +');
check(isDeliveryBlocked('+254700000000') === false, 'other recipients stay open');
check(markDeliveryBlocked('+254700000000', '131000') === false, 'transient codes do not block');
check(clearDeliveryBlock('254799000512') === true && isDeliveryBlocked('+254799000512') === false, 'a block can be cleared');
check(PERMANENT_FAILURE_CODES.has('131026'), '131026 is a permanent-failure code');

console.log('--- policy switch ---');
check(SENTINEL_PROPOSALS_DEFAULT === 'off', 'the default is off');
check(isSentinelProposalsEnabled({}) === false, 'unset is off');
check(isSentinelProposalsEnabled({ SENTINEL_PROPOSALS_ENABLED: 'on' }) === true, 'on enables');
check(isSentinelProposalsEnabled({ SENTINEL_PROPOSALS_ENABLED: '1' }) === true, '1 enables');
check(isSentinelProposalsEnabled({ SENTINEL_PROPOSALS_ENABLED: 'off' }) === false, 'off stays off');

console.log('--- diagnosis needs the switch ---');
const savedP = process.env.SENTINEL_PROPOSALS_ENABLED;
const savedD = process.env.CONVERSATION_DIAGNOSIS_ENABLED;
delete process.env.SENTINEL_PROPOSALS_ENABLED;
process.env.CONVERSATION_DIAGNOSIS_ENABLED = 'on';
check(isConversationDiagnosisEnabled() === false, 'diagnosis is gated off by the master switch');
process.env.SENTINEL_PROPOSALS_ENABLED = 'on';
check(isConversationDiagnosisEnabled() === true, 'diagnosis runs only when both switches are on');
if (savedP === undefined) delete process.env.SENTINEL_PROPOSALS_ENABLED; else process.env.SENTINEL_PROPOSALS_ENABLED = savedP;
if (savedD === undefined) delete process.env.CONVERSATION_DIAGNOSIS_ENABLED; else process.env.CONVERSATION_DIAGNOSIS_ENABLED = savedD;

console.log('--- proposals are refused while off ---');
process.env.SENTINEL_PROPOSALS_ENABLED = 'off';
check((await recordConversationProposal({ supabase: {}, diagnosis: { rootCause: 'x', minimalChange: 'y' } })).reason === 'proposals_disabled', 'conversation proposals are refused');
check((await mintFindingProposal({}, { runKey: 'R', finding: { title: 't', slug: 's' } })).reason === 'proposals_disabled', 'deep-audit proposals are refused');

console.log('--- findings go to the friction log ---');
const db = mock();
const logged = await mintFindingLog(db, { runKey: 'RUN-1', finding: { title: 'Mojibake', description: 'bad bytes', slug: 'mojibake', severity: 'high', files: ['src/a.js'] } });
check(logged.ok === true && logged.logged === true, 'a finding is logged instead of proposed');
check(db.__db.chat_friction_logs.length === 1, 'one friction row is written');
check(db.__db.chat_friction_logs[0].source === 'deep_audit', 'the row is tagged deep_audit');
check(db.__db.chat_friction_logs[0].friction_type === 'DEEP_AUDIT_FINDING', 'the row type is DEEP_AUDIT_FINDING');
check(db.__db.chat_friction_logs[0].diagnosis && db.__db.chat_friction_logs[0].diagnosis.slug === 'mojibake', 'the diagnosis carries the slug');

console.log('--- recordFriction links errors ---');
const rf = await recordFriction(db, { frictionType: 'CONVERSATION_STALL', snippet: 'stalled', errorLogIds: ['e1', 'e2'] });
check(rf.ok === true, 'recordFriction writes a row');
check(db.__db.chat_friction_logs.some((r) => Array.isArray(r.error_log_ids) && r.error_log_ids.length === 2), 'error log ids are linked');

console.log('--- plan dispatch is gated ---');
check(fs.readFileSync('src/workers/remediation.js', 'utf8').includes('SENTINEL_PROPOSALS_ENABLED is off'), 'plan dispatch returns skipped when the switch is off');

// v1.61.9 — the micro-rule optimizer is part of the same gate: with the switch
// off Sentinel detects/logs friction only, and prompt patches come solely from
// the A/B-verified DeepEval healer.
const sentinelSource = fs.readFileSync('src/workers/sentinel.js', 'utf8');
const optimizerIndex = sentinelSource.indexOf('Saka Sentinel Micro-Rule Optimizer');
const gateIndex = sentinelSource.lastIndexOf('if (isSentinelProposalsEnabled()) {', optimizerIndex);
check(optimizerIndex > 0 && gateIndex > 0 && optimizerIndex - gateIndex < 600, 'the micro-rule optimizer is gated by SENTINEL_PROPOSALS_ENABLED');
check(sentinelSource.includes('Sentinel keeps detecting and logging friction'), 'the gate is documented in the source');


console.log('--- proactive template routing (v1.63.0, sec 182) ---');
const savedPhoneId = process.env.META_PHONE_NUMBER_ID;
const savedWaToken = process.env.META_WHATSAPP_TOKEN;
const savedTpl = process.env.META_TPL_SERVICE_REMINDER;
const originalFetch = global.fetch;
const payloads = [];
process.env.META_PHONE_NUMBER_ID = '1234567890';
process.env.META_WHATSAPP_TOKEN = 'test-token';
delete process.env.META_TPL_SERVICE_REMINDER;
global.fetch = async (url, options) => { payloads.push(JSON.parse(options.body)); return { ok: true }; };
const textSent = await sendProactiveWhatsApp('+254700000099', 'Hello there', 'service_reminder', { plate: 'KDA 123A' });
check(textSent === true && payloads.length === 1 && payloads[0].type === 'text' && payloads[0].text.body === 'Hello there', 'unset knob sends the byte-identical free-form text');
process.env.META_TPL_SERVICE_REMINDER = 'saka_service_reminder';
payloads.length = 0;
const templateSent = await sendProactiveWhatsApp('+254700000099', 'Hello there', 'service_reminder', { plate: 'KDA 123A' });
check(templateSent === true && payloads.length === 1 && payloads[0].type === 'template' && payloads[0].template.name === 'saka_service_reminder', 'a configured knob sends the approved template');
check(payloads[0].template.components[0].parameters[0].text === 'KDA 123A', 'the template carries the ordered body variable');
payloads.length = 0;
const degradedSent = await sendProactiveWhatsApp('+254700000099', 'Hello there', 'service_reminder', {});
check(degradedSent === true && payloads.length === 1 && payloads[0].type === 'text' && payloads[0].text.body === 'Hello there', 'a missing variable degrades to the free-form text');
payloads.length = 0;
const plainSent = await sendProactiveWhatsApp('+254700000099', 'Plain line');
check(plainSent === true && payloads.length === 1 && payloads[0].type === 'text' && payloads[0].text.body === 'Plain line', 'kinds are optional (legacy two-argument calls unchanged)');
global.fetch = originalFetch;
if (savedPhoneId === undefined) delete process.env.META_PHONE_NUMBER_ID; else process.env.META_PHONE_NUMBER_ID = savedPhoneId;
if (savedWaToken === undefined) delete process.env.META_WHATSAPP_TOKEN; else process.env.META_WHATSAPP_TOKEN = savedWaToken;
if (savedTpl === undefined) delete process.env.META_TPL_SERVICE_REMINDER; else process.env.META_TPL_SERVICE_REMINDER = savedTpl;

console.log('');
console.log(passed + ' sentinel-policy assertions passed.');