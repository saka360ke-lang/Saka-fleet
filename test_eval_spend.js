/**
 * Saka Fleet — eval spend suite (v1.61.15)
 * ----------------------------------------
 * Proves the call-based spend controls never weaken quality:
 *   • the tick selector always keeps live + calibration cases,
 *   • a proven-green case rests, ONE failure returns it to the hot lane,
 *   • the judge call budget (re-judges included) is a hard cap,
 *   • the deterministic-lane cooldown stops heal churn (generate never called),
 *   • the digest carries exact eval calls + approximate list-price cost.
 * Pure / in-memory only: no provider calls, no real rows.
 */
import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  getConvEvalConfig,
  selectCasesForTick,
  shouldSendEvalCallAlert,
  runConvEvalBatch
} from './src/services/convEval.js';
import { healCooldownStatus, healFailedCase } from './src/services/convEvalHealer.js';
import { buildEvalDigest, formatEvalDigestEmail } from './src/services/evalDigest.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log('  ok ' + message);
}

const now = new Date('2026-11-06T10:00:00Z');
const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60000).toISOString();
const run = (caseId, isPassed, minutes) => ({ case_id: caseId, passed: isPassed, created_at: minutesAgo(minutes) });
const baseCase = (id, extra = {}) => ({
  id,
  source: 'corpus',
  expected: 'pass',
  turns: [{ role: 'user', text: 'hello there' }],
  reply: 'A perfectly good reply for the test.',
  ...extra
});
const config = { maxJudgeCallsPerTick: 0, passStreak: 3, restTicks: 5, intervalMs: 15 * 60000 };

console.log('=== SAKA FLEET — eval spend suite (v1.61.15) ===');

console.log('\n--- 1. config: spend knobs parse and stay bounded ---');
const tuned = getConvEvalConfig({
  CONV_EVAL_MAX_JUDGE_CALLS_PER_TICK: '7',
  CONV_EVAL_PASS_STREAK: '2',
  CONV_EVAL_PASS_REST_TICKS: '4',
  CONV_EVAL_MAX_REFUSALS_PER_CASE: '5',
  CONV_EVAL_REFUSAL_COOLDOWN_HOURS: '12',
  EVAL_DAILY_CALL_ALERT: '900'
});
check(tuned.maxJudgeCallsPerTick === 7 && tuned.passStreak === 2 && tuned.restTicks === 4, 'the judge/pass/rest knobs parse from env');
check(tuned.maxRefusalsPerCase === 5 && tuned.refusalCooldownHours === 12 && tuned.evalDailyCallAlert === 900, 'the refusal + alert knobs parse from env');

console.log('\n--- 2. rest lane: proven-green cases rest, one failure wakes them ---');
const resting = selectCasesForTick({
  cases: [baseCase('green'), baseCase('fresh')],
  recentRuns: [run('green', true, 15), run('green', true, 30), run('green', true, 45)],
  config,
  now
});
check(resting.cases.map((caseDef) => caseDef.id).join(',') === 'fresh', 'three consecutive passes put a case to rest');
check(resting.skippedRest.includes('green'), 'the rested case is reported, never silently dropped');

const awake = selectCasesForTick({
  cases: [baseCase('green')],
  recentRuns: [run('green', true, 90), run('green', true, 105), run('green', true, 120)],
  config,
  now
});
check(awake.cases.length === 1 && awake.skippedRest.length === 0, 'the rest expires after REST_TICKS and the case re-checks');

const regressed = selectCasesForTick({
  cases: [baseCase('green'), baseCase('other')],
  recentRuns: [run('green', false, 5), run('green', true, 20), run('green', true, 35)],
  config,
  now
});
check(regressed.cases.some((caseDef) => caseDef.id === 'green'), 'one failure returns a rested case to the hot lane immediately');

console.log('\n--- 3. priority + cap: quality lanes are cut last ---');
const capped = selectCasesForTick({
  cases: [
    baseCase('c1'),
    baseCase('s1', { source: 'synthetic' }),
    baseCase('cal', { expected: 'fail' }),
    baseCase('lv', { source: 'live' }),
    baseCase('recentfail')
  ],
  recentRuns: [run('recentfail', false, 10)],
  config: { ...config, maxJudgeCallsPerTick: 3 },
  now
});
check(capped.cases.map((caseDef) => caseDef.id).join(',') === 'lv,cal,recentfail', 'the budget cuts corpus/synthetic first: live > calibration > recently failed');
check(capped.capped === 2, 'the trimmed count is reported');

const immune = selectCasesForTick({
  cases: [baseCase('lv', { source: 'live' }), baseCase('cal', { expected: 'fail' })],
  recentRuns: [
    run('lv', true, 5), run('lv', true, 10), run('lv', true, 15),
    run('cal', true, 5), run('cal', true, 10), run('cal', true, 15)
  ],
  config,
  now
});
check(immune.cases.length === 2 && immune.skippedRest.length === 0, 'live and calibration cases never rest');

console.log('\n--- 4. judge call budget is a hard cap (re-judges included) ---');
let calls = 0;
const budgeted = await runConvEvalBatch({
  cases: [baseCase('a'), baseCase('b')],
  persist: false,
  threshold: 0.7,
  callBudget: 1,
  judgeFn: async () => {
    calls += 1;
    return { ok: true, passed: true, aggregate: 0.95, failing: [], scores: {} };
  }
});
check(calls === 1 && budgeted.results.length === 1, 'a call budget of 1 judges exactly one case');

let nearCalls = 0;
const nearMissRun = await runConvEvalBatch({
  cases: [baseCase('n')],
  persist: false,
  threshold: 0.7,
  rejudgeMargin: 0.2,
  rejudgeMax: 5,
  callBudget: 1,
  judgeFn: async () => {
    nearCalls += 1;
    return { ok: true, passed: false, aggregate: 0.6, failing: ['tone_compliance'], scores: { tone_compliance: { score: 0.6 } } };
  }
});
check(nearCalls === 1 && nearMissRun.results[0].judged.rejudged !== true, 'a borderline re-judge never exceeds the call budget');

console.log('\n--- 5. digest: exact calls, approximate list-price cost ---');
const digest = buildEvalDigest(
  [{ case_id: 'x', source: 'corpus', status: 'passed', passed: true, average_score: 0.9, criteria: { tone_compliance: { score: 0.9 } }, created_at: now.toISOString() }],
  [],
  { hours: 6, usage: { byPurpose: { conversation_eval: { requests: 42, approxCostUsd: 0.1234 } } } }
);
check(digest.evalSpend?.calls === 42 && digest.evalSpend?.approxCostUsd === 0.12, 'the digest carries eval calls and rounded approximate cost');
const digestEmail = formatEvalDigestEmail(digest);
check(digestEmail.includes('Eval AI spend: 42 calls') && digestEmail.includes('approximate list price'), 'the email labels cost as approximate, never a bill');
check(buildEvalDigest([], [], {}).evalSpend === null, 'no usage data degrades cleanly (no invented spend line)');

console.log('\n--- 6. daily call alert: soft, once per Nairobi day ---');
check(shouldSendEvalCallAlert({ calls: 999999, threshold: 0 }) === false, 'threshold 0 disables the alert');
check(shouldSendEvalCallAlert({ calls: 10, threshold: 1500, todayKey: '2026-11-06' }) === false, 'below threshold stays quiet');
check(shouldSendEvalCallAlert({ calls: 1500, threshold: 1500, todayKey: '2026-11-06' }) === true, 'crossing the threshold alerts');
check(shouldSendEvalCallAlert({ calls: 1600, threshold: 1500, todayKey: '2026-11-06', lastAlertKey: '2026-11-06' }) === false, 'one alert per Nairobi day');

console.log('\n--- 7. deterministic-lane cooldown stops heal churn ---');
process.env.CONV_EVAL_MAX_REFUSALS_PER_CASE = '3';
process.env.CONV_EVAL_REFUSAL_COOLDOWN_HOURS = '24';
const auditRow = (caseId, minutes) => ({
  action: 'CONV_EVAL_ERROR',
  details: { case_id: caseId, reason: 'no_improvement' },
  created_at: minutesAgo(minutes)
});
const coolMock = createMockSupabase({
  admin_audit_logs: [auditRow('loop', 10), auditRow('loop', 20), auditRow('loop', 30), auditRow('other', 10)],
  saka_dynamic_rules: [],
  conversation_eval_runs: []
});
const cooling = await healCooldownStatus({ supabase: coolMock.client, caseId: 'loop', now });
check(cooling.cooling === true && cooling.count === 3, 'three ab_gate refusals put the case into cooldown');
const notCooling = await healCooldownStatus({ supabase: coolMock.client, caseId: 'other', now });
check(notCooling.cooling === false && notCooling.count === 1, 'refusals are counted per case');

process.env.CONV_EVAL_HEAL_ENABLED = 'on';
let generated = 0;
const failedJudged = {
  ok: true,
  passed: false,
  aggregate: 0.3,
  threshold: 0.7,
  failing: ['tone_compliance'],
  scores: { tone_compliance: { score: 0.3, reason: 'robotic' } }
};
const skipped = await healFailedCase({
  supabase: coolMock.client,
  caseDef: { id: 'loop', expected: 'pass', turns: [{ role: 'user', text: 'hello' }], reply: 'A long enough failing reply.' },
  judged: failedJudged,
  generate: async () => { generated += 1; return '{}'; },
  now
});
check(skipped.ok === false && skipped.reason === 'heal_cooldown' && generated === 0, 'a cooling case never spends a generate call');
check(coolMock.db.admin_audit_logs.some((row) => row.action === 'CONV_EVAL_HEAL_SKIPPED_COOLDOWN'), 'the skip is audited, never silent');

const proceeded = await healFailedCase({
  supabase: coolMock.client,
  caseDef: { id: 'other', expected: 'pass', turns: [{ role: 'user', text: 'hello' }], reply: 'A long enough failing reply.' },
  judged: failedJudged,
  generate: async () => { generated += 1; return '{}'; },
  now
});
check(generated === 1 && proceeded.reason === 'patch_rejected', 'an uncooled case still attempts the heal');

delete process.env.CONV_EVAL_HEAL_ENABLED;
delete process.env.CONV_EVAL_MAX_REFUSALS_PER_CASE;
delete process.env.CONV_EVAL_REFUSAL_COOLDOWN_HOURS;

console.log(`\n🎉 ALL EVAL SPEND TESTS PASSED (${passed} assertions).`);


