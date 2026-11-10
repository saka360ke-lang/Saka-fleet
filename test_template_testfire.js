/**
 * Saka Fleet — superadmin template test-fire + reply-button audit (v1.96.0).
 * Stateless: injected env, stubbed fetch, spy audit/send, zero DB rows.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import {
  TEMPLATE_TEST_FIXTURES,
  TEMPLATE_SUGGESTED_NAMES,
  PROACTIVE_TEMPLATE_KINDS,
  templateVariablesForKind,
  templateButtonState
} from './src/services/proactiveTemplates.js';
import {
  TEMPLATE_TEST_WINDOW_MS,
  TEMPLATE_TEST_MAX_SENDS,
  TEMPLATE_TEST_KINDS,
  templateTestAllowance,
  recordTemplateTestFire,
  runTemplateTestFire,
  formatTemplateTestReply,
  buildTemplateButtonAudit,
  runTemplateButtonAudit,
  formatTemplateButtonDigest
} from './src/services/templateTestFire.js';
import {
  sendWhatsAppText,
  sendWhatsAppTemplate,
  sendWhatsAppTemplateProbe
} from './src/services/metaMessenger.js';
import { markDeliveryBlocked, clearDeliveryBlock } from './src/services/deliveryGuard.js';
import { BUTTON_TITLE_PHRASES } from './src/services/interactiveReply.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(calls.length, url, options);
  };
  return calls;
}
const okBody = () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.testing.1' }] }) });
const failBody = () => ({ ok: false, json: async () => ({ error: { code: 132000 } }) });
const CREDS = { META_PHONE_NUMBER_ID: '123456', META_WHATSAPP_TOKEN: 'test-token' };

console.log('=== TEMPLATE TEST-FIRE + BUTTON AUDIT (v1.96.0) ===');

try {
  console.log('\n--- 1. fixtures satisfy every kind (18/18) ---');
  check(TEMPLATE_TEST_KINDS.length === 18, 'the probe covers all 18 registered kinds');
  check(TEMPLATE_TEST_KINDS.every((kind) => TEMPLATE_TEST_FIXTURES[kind] && typeof TEMPLATE_TEST_FIXTURES[kind] === 'object'), 'every kind has a fixture object (18/18)');
  check(TEMPLATE_TEST_KINDS.every((kind) => templateVariablesForKind(kind, TEMPLATE_TEST_FIXTURES[kind]) !== null), 'every fixture satisfies its declared body variables');
  check(TEMPLATE_TEST_KINDS.every((kind) => templateButtonState(kind, TEMPLATE_TEST_FIXTURES[kind]).buttons !== null), 'every fixture satisfies its declared buttons');
  check(Object.isFrozen(TEMPLATE_TEST_FIXTURES) && Object.isFrozen(TEMPLATE_SUGGESTED_NAMES), 'the fixtures and suggested names are frozen');

  const reengageState = templateButtonState('re_engagement', TEMPLATE_TEST_FIXTURES.re_engagement);
  check(reengageState.status === 'ready' && reengageState.buttons.length === 4 && reengageState.buttons.every((button) => button.sub_type === 'quick_reply' && !('parameters' in button)), 're_engagement fires FOUR parameter-free Quick Replies (indexes 0-3)');
  const otpState = templateButtonState('auth_otp', TEMPLATE_TEST_FIXTURES.auth_otp);
  check(otpState.status === 'ready' && otpState.buttons.length === 1 && otpState.buttons[0].sub_type === 'url' && otpState.buttons[0].parameters[0].text === '123456', 'auth_otp fires its URL button with the fixture code parameter');
  const digestState = templateButtonState('overdue_digest', TEMPLATE_TEST_FIXTURES.overdue_digest);
  check(digestState.status === 'ready' && digestState.buttons.length === 1 && digestState.buttons[0].sub_type === 'quick_reply', 'overdue_digest fires ONE parameter-free Quick Reply');

  console.log('\n--- 2. sliding-window limiter (5 per 10 min) ---');
  const limiterPhone = '+254700000101';
  check(templateTestAllowance(limiterPhone, { now: 1_000_000 }).allowed, 'a fresh phone is allowed');
  for (let i = 0; i < TEMPLATE_TEST_MAX_SENDS; i += 1) recordTemplateTestFire(limiterPhone, { now: 1_000_000 });
  const exhausted = templateTestAllowance(limiterPhone, { now: 1_000_000 });
  check(exhausted.allowed === false && exhausted.remaining === 0, `the ${TEMPLATE_TEST_MAX_SENDS}-send window is enforced`);
  check(exhausted.retryMinutes >= 1 && exhausted.retryMinutes <= 10, 'the cooled-down reply always carries 1-10 minutes');
  check(templateTestAllowance('+254700000199', { now: 1_000_000 }).allowed, 'a different phone keeps its own window');
  check(templateTestAllowance(limiterPhone, { now: 1_000_000 + TEMPLATE_TEST_WINDOW_MS + 1 }).allowed, 'the window slides once 10 minutes pass');

  console.log('\n--- 3. probe transport (sent / rejected / blocked / no credentials) ---');
  const probePhone = '+254700000102';
  let calls = stubFetch(okBody);
  const sentProbe = await sendWhatsAppTemplateProbe(probePhone, 'saka_reengage', { variables: [{ type: 'text', text: 'Operator' }], buttons: [], env: CREDS, capture: {} });
  check(sentProbe.ok === true && sentProbe.status === 'sent' && sentProbe.wamid === 'wamid.testing.1', 'a 2xx returns sent + the parsed wamid (passthrough)');
  check(calls.length === 1 && JSON.parse(calls[0].options.body).type === 'template', 'the probe posts ONE template payload through the shared transport');

  calls = stubFetch(failBody);
  const rejectedProbe = await sendWhatsAppTemplateProbe(probePhone, 'saka_reengage', { env: CREDS, capture: {} });
  check(rejectedProbe.ok === false && rejectedProbe.status === 'rejected' && rejectedProbe.wamid === null, 'a non-2xx returns rejected with no wamid');

  markDeliveryBlocked(probePhone);
  calls = stubFetch(okBody);
  const blockedProbe = await sendWhatsAppTemplateProbe(probePhone, 'saka_reengage', { env: CREDS, capture: {} });
  check(blockedProbe.ok === false && blockedProbe.status === 'delivery_blocked' && blockedProbe.wamid === null, 'a blocked recipient returns delivery_blocked with no wamid');
  check(calls.length === 0, 'the blocklist check runs BEFORE posting (zero network calls)');
  clearDeliveryBlock(probePhone);

  calls = stubFetch(okBody);
  const noCredsProbe = await sendWhatsAppTemplateProbe(probePhone, 'saka_reengage', { env: {}, capture: {} });
  check(noCredsProbe.status === 'no_credentials' && calls.length === 0, 'missing Meta credentials refuse before any network call');

  calls = stubFetch(okBody);
  const textResult = await sendWhatsAppText(probePhone, 'hello', { env: CREDS });
  const templateResult = await sendWhatsAppTemplate(probePhone, 'saka_deploy_live', { env: CREDS });
  check(textResult === true && templateResult === true, 'the existing boolean senders stay boolean on 2xx (one transport, two contracts)');
  check(calls.length === 2, 'both boolean senders still use the same single transport');

  console.log('\n--- 4. runner statuses (usage / unknown / no recipient / unset knob / sent) ---');
  const auditRows = [];
  const audit = async (row) => { auditRows.push(row); };
  const usage = await runTemplateTestFire({ kind: null, env: { SUPERADMIN_PHONE: probePhone }, audit });
  check(usage.status === 'usage' && usage.kinds.length === 18 && auditRows[0]?.status === 'usage', 'bare `admin tpl test` prints usage naming every kind');
  const unknown = await runTemplateTestFire({ kind: 'nope', env: { SUPERADMIN_PHONE: probePhone }, audit });
  check(unknown.status === 'unknown_kind' && unknown.kinds.length === 18, 'an unknown kind names the registry instead of guessing');
  const noRecipient = await runTemplateTestFire({ kind: 'all', env: {}, audit });
  check(noRecipient.status === 'no_recipient' && noRecipient.results.length === 0, 'SUPERADMIN_PHONE unset refuses gracefully (nothing sent)');
  check(auditRows.some((row) => row.status === 'no_recipient'), 'the refusal is still audited');

  auditRows.length = 0;
  const sendCalls = [];
  const sendStub = async (to, name, options) => {
    sendCalls.push({ to, name, options });
    return { ok: true, wamid: 'wamid.stub.1', status: 'sent' };
  };
  const unset = await runTemplateTestFire({ kind: 're_engagement', env: { SUPERADMIN_PHONE: probePhone }, audit, send: sendStub });
  check(unset.results[0].status === 'unset_knob' && unset.results[0].expectedName === 'saka_reengage' && unset.results[0].env === 'META_TPL_RE_ENGAGEMENT', 'an unset knob is refused and names the expected template');
  check(sendCalls.length === 0 && auditRows.length === 1 && auditRows[0].status === 'unset_knob', 'the unset-knob refusal sends nothing and still audits the attempt');
  check(auditRows[0].fixtureVars?.name === 'Operator', 'the audit row carries the fixture vars');

  auditRows.length = 0;
  const sentRun = await runTemplateTestFire({ kind: 're_engagement', env: { SUPERADMIN_PHONE: probePhone, META_TPL_RE_ENGAGEMENT: 'saka_reengage' }, audit, send: sendStub });
  check(sentRun.status === 'done' && sentRun.results[0].status === 'sent' && sentRun.results[0].wamid === 'wamid.stub.1', 'a configured knob sends and carries the wamid');
  check(sendCalls[0]?.to === probePhone && sendCalls[0]?.name === 'saka_reengage', 'the send targets SUPERADMIN_PHONE with the registry template name');
  check(sendCalls[0]?.options.buttons.length === 4, 'the probe forwards the registry button components');
  check(auditRows.length === 1 && auditRows[0].kind === 're_engagement' && auditRows[0].templateName === 'saka_reengage' && auditRows[0].wamid === 'wamid.stub.1', 'each send writes ONE ADMIN_TEMPLATE_TEST row (kind, template, wamid)');

  console.log('\n--- 5. `all` pacing stops at the window and says when to rerun ---');
  const pacedPhone = '+254700000103';
  const pacedEnv = { SUPERADMIN_PHONE: pacedPhone };
  for (const [kind, def] of Object.entries(PROACTIVE_TEMPLATE_KINDS)) pacedEnv[def.env] = TEMPLATE_SUGGESTED_NAMES[kind];
  const pacedSends = [];
  const paced = await runTemplateTestFire({
    kind: 'all',
    env: pacedEnv,
    now: 2_000_000,
    send: async (to, name, options) => { pacedSends.push(name); return { ok: true, wamid: `wamid.${pacedSends.length}`, status: 'sent' }; }
  });
  check(paced.status === 'cooling_down' && paced.results.length === TEMPLATE_TEST_MAX_SENDS && pacedSends.length === TEMPLATE_TEST_MAX_SENDS, '`all` sends exactly 5 and stops at the window');
  check(paced.remaining.length === 13 && paced.remaining[0] === TEMPLATE_TEST_KINDS[5], 'the remaining 13 kinds are listed in registry order');
  check(paced.retryMinutes === 10, 'the reply window is reported in whole minutes');
  const pacedReply = formatTemplateTestReply(paced);
  check(pacedReply.includes('Cooling down') && pacedReply.includes('run again in 10 minute(s)') && pacedReply.includes('Remaining:'), 'the reply says cooling down and names the remaining kinds');

  console.log('\n--- 6. reply copy is honest about wamid outcomes (sent / rejected / blocked) ---');
  const sentCopy = formatTemplateTestReply({ status: 'done', results: [{ kind: 'deploy_live', templateName: 'saka_deploy_live', status: 'sent', wamid: 'wamid.x', ok: true }], remaining: [] });
  check(sentCopy.includes('sent — wamid wamid.x') && sentCopy.includes('1/1 sent'), 'sent copy names the wamid');
  const rejectedCopy = formatTemplateTestReply({ status: 'done', results: [{ kind: 'deploy_live', templateName: 'saka_deploy_live', status: 'rejected', wamid: null, ok: false }], remaining: [] });
  check(rejectedCopy.includes('rejected by Meta — no wamid'), 'rejected copy says no wamid');
  const blockedCopy = formatTemplateTestReply({ status: 'done', results: [{ kind: 'deploy_live', templateName: 'saka_deploy_live', status: 'delivery_blocked', wamid: null, ok: false }], remaining: [] });
  check(blockedCopy.includes('delivery blocked') && blockedCopy.includes('no wamid'), 'blocked copy also says no wamid (never a fake delivery claim)');
  const unsetCopy = formatTemplateTestReply({ status: 'done', results: [{ kind: 'winback', templateName: null, status: 'unset_knob', wamid: null, env: 'META_TPL_WINBACK', expectedName: 'saka_winback' }], remaining: [] });
  check(unsetCopy.includes('META_TPL_WINBACK is unset') && unsetCopy.includes('saka_winback'), 'unset-knob copy names the expected template');
  const noRecipientCopy = formatTemplateTestReply({ status: 'no_recipient' });
  check(noRecipientCopy.includes('SUPERADMIN_PHONE is not set') && noRecipientCopy.includes('nothing was sent'), 'the no-recipient refusal is graceful and explicit');
  check(sentCopy.includes('Cloud Logging') && sentCopy.includes('Meta console') && sentCopy.includes('no database delivery trail'), 'the delivery-status line never claims a DB trail');

  console.log('\n--- 7. side-effect-free import scan + dispatch position ---');
  const probeSource = fs.readFileSync('./src/services/templateTestFire.js', 'utf8');
  const importPaths = [...probeSource.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)].map((match) => match[1]);
  check(importPaths.length === 2 && importPaths.includes('./proactiveTemplates.js') && importPaths.includes('./metaMessenger.js'), 'the probe module imports ONLY proactiveTemplates + metaMessenger');
  check(!probeSource.includes('sendWhatsAppText(') && !probeSource.includes('sendWhatsAppTemplate('), 'the probe never calls the boolean senders (one probe path only)');
  check(!probeSource.includes('createClient') && !probeSource.includes('chat_sessions'), 'the probe cannot touch a sender session or open its own DB client');
  const superadminSource = fs.readFileSync('./src/services/superadmin.js', 'utf8');
  check(superadminSource.indexOf("parsedCommand.intent === 'ADMIN_TEMPLATE_TEST'") > superadminSource.indexOf('SESSION_TTL_MS'), 'the test-fire dispatch sits AFTER the 30-minute session gate');
  check(superadminSource.includes("'ADMIN_TEMPLATE_TEST', 'ADMIN_TEMPLATE_BUTTONS'"), 'both intents are in the ADMIN_INTENTS whitelist');

  console.log('\n--- 8. button audit: declared → mapped → captured (exact match) ---');
  const historyRows = [
    { message: 'fuel', created_at: '2026-11-10T10:00:00Z' },
    { message: 'i need fuel', created_at: '2026-11-10T10:01:00Z' },
    { message: 'set reminder', created_at: '2026-11-10T10:02:00Z' }
  ];
  const errorRows = [{
    error_message: 'Unrecognized WhatsApp interactive reply (type=button_reply) [phone=254700000109]',
    stack_trace: JSON.stringify({ interactive: { type: 'button_reply', button_reply: { id: 'generated_1', title: 'Track order' } } }),
    created_at: '2026-11-10T10:03:00Z'
  }];
  const auditData = buildTemplateButtonAudit({ titlePhrases: BUTTON_TITLE_PHRASES, historyRows, errorRows });
  check(auditData.declared.length === 3 && auditData.declared.map((entry) => entry.kind).join(',') === 're_engagement,auth_otp,overdue_digest', 'the declared column lists the 3 button-bearing kinds');
  check(auditData.declared[0].buttons.length === 4 && auditData.declared[0].buttons[0].title === 'Log Fuel', 'declared carries the approved titles (re_engagement 4)');
  check(auditData.mapped.length === 7, 'the mapped column carries all 7 title phrases');
  check(auditData.captured.length === 3, 'the captured column reads exact taps + titled error rows');
  check(auditData.captured[0].title === 'log fuel' && auditData.captured[0].phrase === 'fuel' && auditData.captured[0].kind === 're_engagement', 'a "fuel" tap renders captured → declared → mapped with its kind');
  check(!auditData.captured.some((entry) => entry.at === '2026-11-10T10:01:00Z'), 'a substring message ("i need fuel") is never captured (exact match only)');
  check(auditData.unrecognized.length === 1 && auditData.unclaimed.length === 1, 'an unrecognized tapped title is flagged as unclaimed');
  const digestText = formatTemplateButtonDigest(auditData);
  check(digestText.includes('Log Fuel') && digestText.includes('Track order') && digestText.includes('NO CLAIMANT'), 'the digest names the unclaimed tap');
  check(digestText.includes('Declared (registry)') && digestText.includes('Mapped (BUTTON_TITLE_PHRASES)') && digestText.includes('Captured'), 'the digest renders all three columns');

  const queryLog = [];
  const mockSupabase = {
    from(table) {
      queryLog.push(table);
      const api = {
        select() { return api; },
        eq(col, value) { queryLog.push(['eq', table, col, value]); return api; },
        in(col, values) { queryLog.push(['in', table, col, values]); return api; },
        order() { return api; },
        limit: async () => ({ data: table === 'error_logs' ? errorRows : historyRows, error: null })
      };
      return api;
    }
  };
  const queried = await runTemplateButtonAudit({ supabase: mockSupabase, adminPhone: '254700000109', titlePhrases: BUTTON_TITLE_PHRASES });
  const phraseFilter = queryLog.find((entry) => Array.isArray(entry) && entry[0] === 'in' && entry[2] === 'message');
  check(phraseFilter && phraseFilter[3].join(',') === 'reminders,fuel,set reminder,log expense,dashboard', 'the chat_history query filters EXACTLY on the 5 target phrases (MF1)');
  const phoneFilter = queryLog.find((entry) => Array.isArray(entry) && entry[0] === 'in' && entry[2] === 'user_phone');
  check(phoneFilter && phoneFilter[3].includes('254700000109') && phoneFilter[3].includes('+254700000109'), 'the chat_history read covers both stored phone forms');
  check(queried.unclaimed.length === 1, 'the live read path flags the unclaimed tap end-to-end');
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n🎉 ${passed} template test-fire / button audit assertions passed.`);
