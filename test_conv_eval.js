import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { AI_PURPOSES, AI_TIERS, USER_FACING_PURPOSES } from './src/services/aiClient.js';
import {
  CONV_EVAL_CRITERIA,
  CONV_EVAL_CRITERIA_KEYS,
  CONV_EVAL_DEFAULT_THRESHOLD,
  CONV_EVAL_SQL,
  aggregateScores,
  buildJudgePrompt,
  buildJudgeSystem,
  caseHash,
  evaluateCriteriaResult,
  formatConvEvalReply,
  getConvEvalConfig,
  isConvEvalEnabled,
  isConvEvalHealEnabled,
  isNearMiss,
  resolveJudgeConfig,
  runConvEvalBatch,
  sanitizeJudgeScores,
  summarizeConvEvalRows
} from './src/services/convEval.js';
import {
  CONVERSATION_CASES,
  CASE_VALIDATION_ERRORS,
  REQUIRED_TAGS,
  buildLiveCasesFromFriction,
  buildLiveCasesFromChatHistory,
  corpusTags,
  parseFrictionSnippet,
  sampleCorpusCases,
  validateCase
} from './src/services/convEvalCases.js';
import { sanitizeHealPatch, formatHealNotice, isCalibrationCase, enforceActiveRuleCap, healFailedCase, HEAL_PATCH_MAX_CHARS } from './src/services/convEvalHealer.js';
import { buildEvalDigest, formatEvalDigestEmail, formatEvalDigestPing, sendEvalDigest, EVAL_DIGEST_CONFIG_KEY, EVAL_DIGEST_ATTEMPT_KEY } from './src/services/evalDigest.js';
import { formatBatchFailures, handleConvEvalCommand } from './src/services/convEvalConsole.js';
import { healsFromAuditRows, selectCorpusUpdates, applyCorpusUpdates } from './src/services/convEvalCorpusSync.js';
import { FLOW_GUIDANCE, guidanceForFlow, SAKA_QUIZ_FLOWS, buildToneCompassBlock } from './src/services/flowKnowledge.js';
import { ENV_SECTIONS } from './src/services/envAudit.js';

/**
 * Saka Fleet — DeepEval-style conversation eval suite (v1.60.0). Stateless.
 *
 * Proves the whole judge contract WITHOUT a provider call: purpose registry,
 * kill-switch defaults, criteria/threshold math, judge prompt laws, corpus
 * integrity, live-friction parsing, healing gates, digests and env parity.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const envSnapshot = {};
function withEnv(vars, fn) {
  for (const [key, value] of Object.entries(vars)) {
    envSnapshot[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  }
}

console.log('=== SAKA FLEET — CONVERSATION EVAL TESTS (v1.60.0) ===\n');

console.log('--- Test 1: purpose registry (rule 20 single hub) ---');
check(AI_PURPOSES.conversation_eval?.tier === AI_TIERS.ROUTER, 'conversation_eval stays on the background router tier');
check(AI_PURPOSES.conversation_eval?.jsonMode === true, 'the judge always asks for JSON');
check(AI_PURPOSES.conversation_heal?.tier === AI_TIERS.REASONING, 'conversation_heal rides the reasoning tier');
check(!USER_FACING_PURPOSES.has('conversation_eval') && !USER_FACING_PURPOSES.has('conversation_heal'), 'eval purposes never join the front-user allow-list');
check(CONV_EVAL_CRITERIA.length === 5, 'five permanent criteria');
check(new Set(CONV_EVAL_CRITERIA_KEYS).size === 5, 'criteria keys are unique');
check(CONV_EVAL_DEFAULT_THRESHOLD === 0.7, 'default pass bar is 0.70');

console.log('\n--- Test 2: kill switches default OFF (never enabled silently) ---');
check(isConvEvalEnabled({ CONV_EVAL_ENABLED: undefined }) === false, 'evals are off when unset');
check(isConvEvalEnabled({ CONV_EVAL_ENABLED: 'on' }) === true, 'on enables evals');
check(isConvEvalEnabled({ CONV_EVAL_ENABLED: '0' }) === false, '0 stays off');
check(isConvEvalHealEnabled({ CONV_EVAL_HEAL_ENABLED: undefined }) === false, 'healing is off when unset');
check(isConvEvalHealEnabled({ CONV_EVAL_HEAL_ENABLED: 'true' }) === true, 'true enables healing');

console.log('\n--- Test 3: config defaults + clamps ---');
withEnv({ CONV_EVAL_INTERVAL_HOURS: undefined, CONV_EVAL_INTERVAL_MINUTES: undefined, CONV_EVAL_MAX_CASES_PER_RUN: undefined, CONV_EVAL_MIN_SCORE: undefined, CONV_EVAL_JUDGE_PROVIDER: undefined, CONV_EVAL_JUDGE_MODEL: undefined, CONV_EVAL_MAX_PATCHES_PER_RUN: undefined, CONV_EVAL_DEDUPE_HOURS: undefined }, () => {
  const cfg = getConvEvalConfig();
  check(cfg.threshold === 0.7 && cfg.maxCases === 100, 'defaults: 0.70 threshold, 100 cases (0 = unlimited)');
  check(cfg.intervalMs === 15 * 60 * 1000, 'default cadence is 15 minutes (always-on)');
  check(cfg.maxPatches === 10 && cfg.dedupeHours === 1, 'defaults: 10 heals (0 = all), 1 h dedupe');
  check(cfg.judgeProvider === 'deepseek', 'judge defaults to the DeepSeek background policy');
  const judge = resolveJudgeConfig();
  check(judge.provider === null && judge.model === null, 'default judge uses the standard purpose chain');
});
withEnv({ CONV_EVAL_INTERVAL_HOURS: '999', CONV_EVAL_MAX_CASES_PER_RUN: '999', CONV_EVAL_MIN_SCORE: '5' }, () => {
  const cfg = getConvEvalConfig();
  check(cfg.intervalMs === 168 * 60 * 60 * 1000, 'hours knob clamps to 168 h');
  check(cfg.maxCases === 500, 'case budget clamps to 500');
  check(cfg.threshold === 1, 'threshold clamps to 1');
});
withEnv({ CONV_EVAL_MAX_CASES_PER_RUN: '0', CONV_EVAL_MAX_PATCHES_PER_RUN: '0', CONV_EVAL_DEDUPE_HOURS: '0.25' }, () => {
  const cfg = getConvEvalConfig();
  check(cfg.maxCases === 0 && cfg.maxPatches === 0, '0 means unlimited cases and heals');
  check(cfg.dedupeHours === 0.25, 'the dedupe window accepts quarter-hours');
});
withEnv({ CONV_EVAL_JUDGE_PROVIDER: 'anthropic', CONV_EVAL_JUDGE_MODEL: undefined }, () => {
  const judge = resolveJudgeConfig();
  check(judge.provider === 'anthropic' && /haiku/i.test(judge.model), 'the Anthropic opt-in routes the judge to Claude Haiku through aiClient');
});
withEnv({ CONV_EVAL_JUDGE_PROVIDER: 'anthropic', CONV_EVAL_JUDGE_MODEL: 'claude-sonnet-test' }, () => {
  check(resolveJudgeConfig().model === 'claude-sonnet-test', 'an explicit judge model wins (Sonnet opt-in)');
});

console.log('\n--- Test 4: judge score sanitizer + threshold math ---');
const fullScores = sanitizeJudgeScores({
  scores: {
    loop_avoidance: { score: 0.9, reason: 'no repeats' },
    tone_compliance: { score: 1.4, reason: 'warm' },
    shorthand_precision: { score: '0.8', reason: 'exact data' },
    single_question: 0.7,
    boundary_safety: { score: 0.6, reason: 'invented nothing' }
  }
});
check(Boolean(fullScores), 'a full judge payload passes the sanitizer');
check(fullScores.tone_compliance.score === 1, 'scores clamp at 1');
check(fullScores.shorthand_precision.score === 0.8, 'string scores are parsed');
check(fullScores.single_question.score === 0.7, 'bare numeric scores are accepted');
const missing = sanitizeJudgeScores({ scores: { loop_avoidance: { score: 0.9 } } });
check(missing && missing.boundary_safety.score === 0 && missing.boundary_safety.missing === true, 'a missing criterion scores 0 (safety-first)');
check(sanitizeJudgeScores(null) === null, 'null is rejected');
check(sanitizeJudgeScores({ scores: {} }) === null, 'an empty score map is rejected');
check(aggregateScores(fullScores) === 0.8, `equal-weight aggregate is 0.80 (${aggregateScores(fullScores)})`);
const verdict = evaluateCriteriaResult({ scores: fullScores, threshold: 0.7 });
check(verdict.passed === false && verdict.failing.join(',') === 'boundary_safety', 'one criterion below the bar fails the case');
const passVerdict = evaluateCriteriaResult({
  scores: sanitizeJudgeScores({ scores: Object.fromEntries(CONV_EVAL_CRITERIA_KEYS.map((key) => [key, { score: 0.8 }])) }),
  threshold: 0.7
});
check(passVerdict.passed === true && passVerdict.aggregate === 0.8, 'all criteria at 0.80 pass the 0.70 bar');
const strictLoopScores = sanitizeJudgeScores({
  scores: {
    loop_avoidance: { score: 0.85 },
    tone_compliance: { score: 0.9 },
    shorthand_precision: { score: 0.9 },
    single_question: { score: 0.9 },
    boundary_safety: { score: 1 }
  }
});
const strictLoop = evaluateCriteriaResult({ scores: strictLoopScores, threshold: 0.7, thresholds: { loop_avoidance: 0.9 } });
check(strictLoop.passed === false && strictLoop.failing.join(',') === 'loop_avoidance', 'a per-criterion bar fails only that criterion (v1.61.1 mapping)');
const strictLoopPass = evaluateCriteriaResult({
  scores: sanitizeJudgeScores({ scores: { ...Object.fromEntries(CONV_EVAL_CRITERIA_KEYS.map((key) => [key, { score: 0.9 }])), loop_avoidance: { score: 0.95 } } }),
  threshold: 0.7,
  thresholds: { loop_avoidance: 0.9 }
});
check(strictLoopPass.passed === true, 'the same case passes when loop avoidance clears its bar');

console.log('\n--- Test 5: the judge prompt carries the live laws (no drift) ---');
const judgeSystem = buildJudgeSystem();
check(/PERSONA V4/.test(judgeSystem), 'the judge prompt carries the Persona v4 brand compass');
check(/BOUNDARY LAWS/.test(judgeSystem), 'the judge prompt carries the boundary laws');
check(/Honest workflow commitments are allowed/.test(judgeSystem), 'honest workflow commitments are explicitly allowed (report links, reminders)');
check(/ENGINE FACTS are authoritative/.test(judgeSystem), 'engine-supplied ledger facts are authoritative, never invention');
check(/BANNED PHRASES/.test(judgeSystem), 'the judge prompt carries the banned-phrase law');
for (const key of CONV_EVAL_CRITERIA_KEYS) {
  check(judgeSystem.includes(key), `judge prompt names the ${key} criterion`);
}
const judgePrompt = buildJudgePrompt({ id: 'unit-case', turns: [{ role: 'user', text: '40l diesel 5k' }] }, 'Logged ✓ 40 L diesel · KES 5,000.');
check(judgePrompt.includes('USER: 40l diesel 5k'), 'the prompt renders the transcript');
check(judgePrompt.includes('Logged ✓ 40 L diesel'), 'the prompt renders the reply under evaluation');
check(judgePrompt.includes('Grade the reply now.'), 'the prompt ends with the grading instruction');
const judgedWithFacts = buildJudgePrompt({
  id: 'facts-case',
  turns: [{ role: 'user', text: 'confirm my psv badge' }],
  engineFacts: ['driver_compliances: PSV badge — number TSV2026, expiry 2027-08-08']
}, '✅ On file ✓ PSV badge — TSV2026 · 08 Aug 2027');
check(judgedWithFacts.includes('ENGINE FACTS') && judgedWithFacts.includes('TSV2026'), 'engine facts are rendered as authoritative context');

console.log('\n--- Test 6: hash stability ---');
const hashA = caseHash({ id: 'stable', turns: [{ role: 'user', text: 'hi' }], reply: 'hello there' });
const hashB = caseHash({ id: 'stable', turns: [{ role: 'user', text: 'hi' }], reply: 'hello there' });
const hashC = caseHash({ id: 'stable', turns: [{ role: 'user', text: 'hi' }], reply: 'different reply' });
check(hashA === hashB && /^[a-f0-9]{32}$/.test(hashA), 'identical cases hash identically (32 hex chars)');
check(hashA !== hashC, 'a different reply changes the hash');

console.log('\n--- Test 7: offline corpus integrity + calibration coverage ---');
check(CONVERSATION_CASES.length >= 12, `corpus carries ${CONVERSATION_CASES.length} cases`);
check(CASE_VALIDATION_ERRORS.length === 0, `every corpus case validates (${CASE_VALIDATION_ERRORS.join('; ') || 'no errors'})`);
const ids = CONVERSATION_CASES.map((caseDef) => caseDef.id);
check(new Set(ids).size === ids.length, 'case ids are unique');
const tags = corpusTags();
for (const tag of REQUIRED_TAGS) {
  check(tags.includes(tag), `corpus covers the ${tag} persona class`);
}
check(CONVERSATION_CASES.some((caseDef) => caseDef.expected === 'pass'), 'corpus carries passing calibration cases (false-positive guard)');
check(CONVERSATION_CASES.some((caseDef) => caseDef.expected === 'fail'), 'corpus carries failing calibration cases (false-negative guard)');
check(CONVERSATION_CASES.every((caseDef) => caseDef.turns.every((turn) => ['user', 'assistant'].includes(turn.role))), 'every turn uses a supported role');
check(CONVERSATION_CASES.every((caseDef) => !/\+\d{9,}/.test(caseDef.reply)), 'no corpus reply embeds a real phone number');

console.log('\n--- Test 8: case validator rejects unsafe shapes ---');
check(validateCase({ id: 'x' }).ok === false, 'a missing conversation is rejected');
check(validateCase({ id: 'bad id!', turns: [{ role: 'user', text: 'hi' }], reply: 'hello there', tags: ['tone'] }).ok === false, 'a malformed id is rejected');
check(validateCase({ id: 'ok-id', turns: [{ role: 'system', text: 'hi' }], reply: 'hello there', tags: ['tone'] }).ok === false, 'an unsupported role is rejected');
check(validateCase({ id: 'ok-id', turns: [{ role: 'user', text: 'hi' }], reply: 'short', tags: ['tone'] }).ok === false, 'a too-short reply is rejected');
check(validateCase({ id: 'ok-id', turns: [{ role: 'user', text: 'hi' }], reply: 'hello there', tags: [] }).ok === false, 'a case without tags is rejected');
check(validateCase({ id: 'ok-id', turns: [{ role: 'user', text: 'hi' }], reply: 'hello there', tags: ['tone'], expected: 'maybe' }).ok === false, 'an unknown expected verdict is rejected');
check(validateCase({ id: 'ok-id', turns: [{ role: 'user', text: 'hi' }], reply: 'hello there', tags: ['tone'] }).ok === true, 'a clean case passes');
const seen = new Set(['dup-case']);
check(validateCase({ id: 'dup-case', turns: [{ role: 'user', text: 'hi' }], reply: 'hello there', tags: ['tone'] }, seen).ok === false, 'a duplicate id is rejected');

console.log('\n--- Test 9: live friction transcripts become cases ---');
const snippet = '[user]: fuel 5000\n[assistant]: How many litres?\n[user]: 40 litres\n[assistant]: Which vehicle is this for?';
const parsed = parseFrictionSnippet(snippet);
check(parsed.ok === true && parsed.turns.length === 4, 'the Sentinel snippet format parses into turns');
check(parsed.reply === 'Which vehicle is this for?', 'the final assistant line becomes the evaluated reply');
check(parseFrictionSnippet('[user]: hello there\nnoise').ok === false, 'an unparseable snippet is skipped, never guessed');
check(parseFrictionSnippet('[assistant]: only a bot line').ok === false, 'a snippet without a user turn is skipped');
const liveBuilt = buildLiveCasesFromFriction([
  { id: 'aaaaaaaa-1111', friction_type: 'LOOPING_PROMPTS', transcript_snippet: snippet },
  { id: 'bbbbbbbb-2222', friction_type: 'LOOPING_PROMPTS', transcript_snippet: snippet },
  { id: 'cccccccc-3333', friction_type: 'USER_FRUSTRATION', transcript_snippet: 'noise only' }
], { limit: 5 });
check(liveBuilt.cases.length === 1, 'live cases are de-duplicated by transcript hash');
check(liveBuilt.cases[0].source === 'live' && liveBuilt.cases[0].frictionLogId === 'aaaaaaaa-1111', 'the live case keeps its friction-log link');
check(liveBuilt.skipped.length === 2, 'duplicate and unparseable rows are reported as skipped');

console.log('\n--- Test 9b: live chat exchanges are paired into cases (v1.61.3) ---');
const chatRows = [
  { user_phone: 'p1', role: 'assistant', message: 'Nothing under licences & permits expenses all time yet.', created_at: '2026-11-05T11:06:00Z' },
  { user_phone: 'p1', role: 'user', message: 'List all driver compliances', created_at: '2026-11-05T11:05:00Z' },
  { user_phone: 'p1', role: 'assistant', message: 'Your Land Cruiser is active.', created_at: '2026-11-05T11:00:00Z' },
  { user_phone: 'p1', role: 'user', message: 'Driver licenses', created_at: '2026-11-05T10:59:00Z' },
  { user_phone: 'p2', role: 'user', message: 'lonely user turn with no reply', created_at: '2026-11-05T10:58:00Z' }
];
const chatBuilt = buildLiveCasesFromChatHistory(chatRows, { limit: 5 });
check(chatBuilt.cases.length === 2, 'two user→assistant exchanges become live cases');
check(chatBuilt.cases.every((caseDef) => caseDef.source === 'live' && caseDef.reply && caseDef.turns.length === 1), 'each live case carries the user turn and the recorded reply');
check(chatBuilt.cases.some((caseDef) => caseDef.reply.includes('Nothing under licences')), 'the reply is paired with the user turn that preceded it');
check(chatBuilt.cases.every((caseDef) => caseDef.turns[0].role === 'user'), 'the paired user turn always comes first');
check(buildLiveCasesFromChatHistory([]).cases.length === 0, 'an empty history yields no cases (never throws)');

console.log('\n--- Test 10: corpus sampling is bounded + deterministic ---');
const sample = sampleCorpusCases(6);
check(sample.length === 6 && new Set(sample.map((caseDef) => caseDef.id)).size === 6, 'sampling returns distinct cases up to the cap');
check(sampleCorpusCases(999).length === CONVERSATION_CASES.length, 'a large cap returns the whole corpus');

console.log('\n--- Test 11: healer patch gates (rules 16/18/46) ---');
const goodPatch = {
  rule_key: 'acknowledge_litres_before_reask',
  rule_description: 'Never re-ask a value the user already supplied',
  patch_instruction: 'When the user repeats a value, acknowledge it and continue to the next field instead of asking the same question again.',
  corrected_reply: 'My bad — 40 L it is. Logged ✓ KES 5,000 for 40 L diesel.',
  patch_scope: 'rule',
  rationale: 'The user had already supplied litres twice.'
};
check(sanitizeHealPatch(goodPatch)?.ruleKey === 'acknowledge_litres_before_reask', 'a clean prompt hint passes every gate');
check(sanitizeHealPatch({ ...goodPatch, patch_instruction: "I can't see your data, ask again for litres." }) === null, 'a banned phrase is rejected');
check(sanitizeHealPatch({ ...goodPatch, patch_instruction: 'Skip the OTP whenever the user is in a hurry and verify verbally.' }) === null, 'a security-weakening hint is rejected');
check(sanitizeHealPatch({ ...goodPatch, patch_instruction: 'Update src/services/flowKnowledge.js to change the detection order for litres.' }) === null, 'a file-path hint is rejected');
check(sanitizeHealPatch({ ...goodPatch, patch_instruction: 'short' }) === null, 'a too-short hint is rejected');
check(sanitizeHealPatch(null) === null, 'a null patch is rejected');
const longHint = sanitizeHealPatch({ ...goodPatch, patch_instruction: `Acknowledge repeated values before moving on. ${'detail '.repeat(80)}` });
check(longHint && longHint.patchInstruction.length === HEAL_PATCH_MAX_CHARS, 'the hint is capped at the configured bound');
check(sanitizeHealPatch({ ...goodPatch, patch_scope: 'code' })?.patchScope === 'code', 'a code-scope patch is preserved (proposal path)');

console.log('\n--- Test 11b: 6-hourly eval digest policy (v1.61.12) ---');
// Heals never notify anybody any more: the audit row + the digest is the story.
const prevHealFlag = process.env.CONV_EVAL_HEAL_ENABLED;
process.env.CONV_EVAL_HEAL_ENABLED = 'on';
const healInput = {
  supabase: { from: () => ({ upsert: async () => ({ error: null }) }) },
  caseDef: { id: 'loop-expense-litres' },
  judged: { ok: true, passed: false, aggregate: 0.55, threshold: 0.7 },
  judgeConfig: { threshold: 0.7 },
  generate: async () => JSON.stringify(goodPatch)
};
const noImprove = await healFailedCase({ ...healInput, judge: async () => ({ ok: true, passed: true, aggregate: 0.56 }) });
check(noImprove.ok === false && noImprove.reason === 'no_improvement', 'a heal that does not beat the original is refused', noImprove.reason);
const healedRun = await healFailedCase({ ...healInput, judge: async () => ({ ok: true, passed: true, aggregate: 0.92 }) });
check(healedRun.ok === true && healedRun.shipped === 'rule', 'a heal that clears the gate ships the prompt rule');
check(healedRun.notified?.whatsapp === false && healedRun.notified?.email === false, 'a shipped heal notifies nobody (digest only)');

// The digest is the only notification: counts, heals, refusals, weakest criterion.
const digestRuns = [
  { case_id: 'a', source: 'live', status: 'passed', passed: true, average_score: 0.9, criteria: { tone_compliance: { score: 0.9 }, loop_avoidance: { score: 0.6 } } },
  { case_id: 'b', source: 'live', status: 'failed', passed: false, average_score: 0.4, criteria: { tone_compliance: { score: 0.4 }, loop_avoidance: { score: 0.5 } } },
  { case_id: 'c', source: 'corpus', status: 'healed', passed: true, average_score: 0.88, before_score: 0.3, after_score: 0.88, patch_id: 'rule_c', criteria: {} },
  { case_id: 'd', source: 'corpus', status: 'error', criteria: {} }
];
const digestAudits = [
  { action: 'CONV_EVAL_PROPOSED', details: { case_id: 'x', proposal_code: 'PROP-2026-11-05-01' } },
  { action: 'CONV_EVAL_ERROR', details: { case_id: 'loop', stage: 'ab_gate', reason: 'no_improvement' } },
  { action: 'CONV_EVAL_ERROR', details: { case_id: 'loop', stage: 'ab_gate', reason: 'no_improvement' } },
  { action: 'CONV_EVAL_ERROR', details: { case_id: 'loop', stage: 'ab_gate', reason: 'no_improvement' } }
];
const evalDigest = buildEvalDigest(digestRuns, digestAudits, { hours: 6 });
check(evalDigest.total === 4 && evalDigest.passed === 2 && evalDigest.failed === 1 && evalDigest.errored === 1, 'the digest counts passed/failed/errored', evalDigest);
check(evalDigest.healedCount === 1 && evalDigest.healed[0].caseId === 'c' && evalDigest.healed[0].before === 0.3, 'the digest carries each heal with before/after');
check(evalDigest.proposals.length === 1 && evalDigest.proposals[0].code === 'PROP-2026-11-05-01', 'the digest lists drafted proposals');
check(evalDigest.refusals[0].caseId === 'loop' && evalDigest.refusals[0].count === 3, 'the digest groups refusals per case');
check(evalDigest.deterministicCandidates.includes('loop'), '3+ refusals flag a deterministic-lane candidate');
check(evalDigest.weakestCriterion === 'loop_avoidance' && evalDigest.weakestAverage === 0.55, 'the weakest criterion is averaged across the window', evalDigest.weakestCriterion);
const digestEmail = formatEvalDigestEmail(evalDigest);
check(/Conversation eval — last 6 hours/.test(digestEmail) && /Healed: 1/.test(digestEmail), 'the email body carries the window and the heal count');
check(/Needs a code fix/.test(digestEmail) && digestEmail.includes('loop'), 'the email flags cases that need code');
const digestPing = formatEvalDigestPing(evalDigest);
check(/summary emailed/.test(digestPing) && digestPing.includes('Healed: 1'), 'the WhatsApp ping announces the email and its headline counts');

// sendEvalDigest: not due, no activity, and a real send (one email + one ping).
function digestMock(state) {
  return {
    from(table) {
      if (table === 'system_config') {
        return {
          select: () => ({ in: () => ({ limit: async () => ({ data: state.configRows || [] }) }) }),
          upsert: async (rows) => { state.upserts.push(rows[0]); return { error: null }; }
        };
      }
      if (table === 'conversation_eval_runs') {
        return { select: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: state.runs }) }) }) }) };
      }
      if (table === 'admin_audit_logs') {
        return {
          select: () => ({ in: () => ({ gte: () => ({ limit: async () => ({ data: state.audits }) }) }) }),
          insert: async (rows) => { state.audits.push(rows[0]); return { error: null }; }
        };
      }
      return {};
    }
  };
}
const digestNow = new Date('2026-11-05T18:00:00Z');
const dueState = { configRows: [], runs: digestRuns, audits: [], upserts: [] };
const duePingArgs = [];
const dueSent = await sendEvalDigest({ supabase: digestMock(dueState), hours: 6, now: digestNow, email: async () => true, whatsapp: async (...args) => { duePingArgs.push(args); return true; } });
check(dueSent.sent === true && dueSent.emailed === true, 'a due digest is emailed');
check(dueState.upserts.length === 1 && dueState.upserts[0].key === EVAL_DIGEST_CONFIG_KEY, 'a SENT digest stores the dispatch time (window consumed)');
check(dueState.audits.some((row) => row.action === 'CONV_EVAL_DIGEST_SENT'), 'the digest dispatch is audited');
check(duePingArgs.length === 1 && duePingArgs[0][2] === 'eval_digest_ping', 'the digest ping carries the eval_digest_ping template kind');
const recentState = { configRows: [{ key: EVAL_DIGEST_CONFIG_KEY, value: '2026-11-05T17:00:00Z' }], runs: digestRuns, audits: [], upserts: [] };
const recentSent = await sendEvalDigest({ supabase: digestMock(recentState), hours: 6, now: digestNow, email: async () => true, whatsapp: async () => true });
check(recentSent.sent === false && recentSent.reason === 'not_due', 'an already-sent window never double-sends');
const failedState = { configRows: [], runs: digestRuns, audits: [], upserts: [] };
const failedSent = await sendEvalDigest({ supabase: digestMock(failedState), hours: 6, now: digestNow, email: async () => false, whatsapp: async () => true });
check(failedSent.sent === false && failedSent.reason === 'email_failed', 'a failed email is reported honestly (quota outage)', failedSent.reason);
check(failedSent.pinged === false, 'no WhatsApp ping when the email did not send');
check(failedState.upserts.length === 1 && failedState.upserts[0].key === EVAL_DIGEST_ATTEMPT_KEY, 'a failed attempt records only the attempt time (window NOT consumed)');
const retryState = { configRows: [{ key: EVAL_DIGEST_ATTEMPT_KEY, value: '2026-11-05T17:55:00Z' }], runs: digestRuns, audits: [], upserts: [] };
const retryWait = await sendEvalDigest({ supabase: digestMock(retryState), hours: 6, now: digestNow, email: async () => true, whatsapp: async () => true });
check(retryWait.sent === false && retryWait.reason === 'retry_wait', 'a retry waits out the 15-minute floor');
const emptyState = { configRows: [], runs: [], audits: [], upserts: [] };
const emptySent = await sendEvalDigest({ supabase: digestMock(emptyState), hours: 6, now: digestNow, email: async () => true, whatsapp: async () => true });
check(emptySent.sent === false && emptySent.reason === 'no_activity', 'a quiet window sends nothing at all');

// v1.61.9 — calibration cases are never healed; rule keys are reused; the
// active-rule table is capped (oldest retires, audited).
console.log('\n--- Test 11c: calibration guard, key reuse, rule cap (v1.61.9) ---');
check(isCalibrationCase({ expected: 'fail' }) === true, 'expected:fail is a calibration case');
check(isCalibrationCase({ expected: 'pass' }) === false, 'expected:pass is not a calibration case');
check(isCalibrationCase({}) === false, 'a case without an expectation is not calibration');
check(isCalibrationCase(null) === false, 'null is handled');
process.env.CONV_EVAL_HEAL_ENABLED = 'on';
const calibrationCalls = [];
const calibrationRun = await healFailedCase({
  supabase: null,
  caseDef: { id: 'loop-expense-litres', expected: 'fail' },
  judged: { ok: true, passed: false, aggregate: 0.2, threshold: 0.7 },
  generate: async () => JSON.stringify(goodPatch),
  judge: async () => ({ ok: true, passed: true, aggregate: 0.9 }),
  notify: async (text, subject, options) => { calibrationCalls.push({ text, subject, options }); return { whatsapp: true, email: false }; }
});
check(calibrationRun.ok === false && calibrationRun.reason === 'calibration_case', 'a calibration case is refused before any judge spend');
check(calibrationCalls.length === 0, 'a calibration case never notifies the superadmin');

function chainMock(result, hooks = {}) {
  const obj = {
    select: () => obj,
    eq: () => obj,
    not: () => obj,
    order: () => obj,
    limit: () => Promise.resolve(result),
    insert: () => Promise.resolve({ error: null }),
    update: (patch) => ({ eq: (col, value) => { if (hooks.update) hooks.update(col, value, patch); return Promise.resolve({ error: null }); } }),
    upsert: (payload) => { if (hooks.upsert) hooks.upsert(payload); return Promise.resolve({ error: null }); }
  };
  return obj;
}
const reusedUpserts = [];
const reuseSupabase = {
  from: (table) => {
    if (table === 'conversation_eval_runs') return chainMock({ data: [{ patch_id: 'prior_rule_key' }] });
    if (table === 'saka_dynamic_rules') return chainMock({ data: [] }, { upsert: (payload) => reusedUpserts.push(payload) });
    return chainMock({ data: [] });
  }
};
const reuseRun = await healFailedCase({
  supabase: reuseSupabase,
  caseDef: { id: 'report-recovery' },
  judged: { ok: true, passed: false, aggregate: 0.6, threshold: 0.7 },
  judgeConfig: { threshold: 0.7 },
  generate: async () => JSON.stringify(goodPatch),
  judge: async () => ({ ok: true, passed: true, aggregate: 0.9 }),
  notify: async () => ({ whatsapp: true, email: false })
});
check(reuseRun.ok === true && reuseRun.ruleKey === 'prior_rule_key', 'a repeat heal reuses the case\'s existing rule key', reuseRun.ruleKey);
check(reusedUpserts.length === 1 && reusedUpserts[0].rule_key === 'prior_rule_key', 'the upsert writes the reused key (no duplicate row)');

const capUpdates = [];
const capSupabase = {
  from: (table) => chainMock({ data: [
    { id: 1, rule_key: 'oldest_rule', updated_at: '2026-11-01T00:00:00Z' },
    { id: 2, rule_key: 'middle_rule', updated_at: '2026-11-02T00:00:00Z' },
    { id: 3, rule_key: 'newest_rule', updated_at: '2026-11-03T00:00:00Z' }
  ] }, { update: (col, value, patch) => capUpdates.push({ col, value, patch }) })
};
const capped = await enforceActiveRuleCap(capSupabase, { maxActive: 2 });
check(capped.retired.length === 1 && capped.retired[0] === 'oldest_rule', 'the oldest rule retires when above the cap', capped.retired);
check(capUpdates.length === 1 && capUpdates[0].patch.is_active === false, 'retirement deactivates (never deletes) the rule');
const underCap = await enforceActiveRuleCap(capSupabase, { maxActive: 5 });
check(underCap.retired.length === 0, 'a table under the cap retires nothing');
const noCap = await enforceActiveRuleCap(capSupabase, { maxActive: 0 });
check(noCap.retired.length === 0, 'cap 0 means unlimited');

// v1.61.10 — borderline re-judge + corpus sync.
console.log('\n--- Test 11d: borderline re-judge + corpus sync (v1.61.10) ---');
const nearMissAgg = { ok: true, passed: false, aggregate: 0.66, threshold: 0.7 };
check(isNearMiss(nearMissAgg, { threshold: 0.7, margin: 0.1 }) === true, 'an aggregate within the margin is a near miss');
check(isNearMiss({ ...nearMissAgg, aggregate: 0.4 }, { threshold: 0.7, margin: 0.1 }) === false, 'a wide miss is never re-judged');
const oneCrit = { ok: true, passed: false, aggregate: 0.5, failing: ['tone_compliance'], scores: { tone_compliance: { score: 0.62 } } };
check(isNearMiss(oneCrit, { threshold: 0.7, margin: 0.1 }) === true, 'one criterion just under its bar is a near miss');
check(isNearMiss({ ...oneCrit, failing: ['tone_compliance', 'boundary_safety'] }, { threshold: 0.7, margin: 0.1 }) === false, 'several failing criteria are never re-judged');
check(isNearMiss(nearMissAgg, { threshold: 0.7, margin: 0 }) === false, 'margin 0 disables re-judging');
check(isNearMiss({ ok: true, passed: true, aggregate: 0.9 }, { threshold: 0.7, margin: 0.1 }) === false, 'a pass is never re-judged');

let flakyCalls = 0;
const flakyJudge = async () => {
  flakyCalls += 1;
  return flakyCalls === 1
    ? { ok: true, passed: false, aggregate: 0.68, failing: ['tone_compliance'], scores: { tone_compliance: { score: 0.68 } } }
    : { ok: true, passed: true, aggregate: 0.79, failing: [], scores: { tone_compliance: { score: 0.79 } } };
};
const flakyBatch = await runConvEvalBatch({
  cases: [{ id: 'flaky-case', turns: [{ role: 'user', text: 'hi' }], reply: 'hello there' }],
  judgeFn: flakyJudge, persist: false, threshold: 0.7, rejudgeMargin: 0.1, rejudgeMax: 5
});
check(flakyBatch.rejudged === 1, 'a borderline case is re-judged once', flakyBatch.rejudged);
check(flakyBatch.results[0].judged.passed === true && flakyBatch.results[0].judged.rejudged === true, 'the better verdict wins and is marked rejudged');
check(flakyBatch.results[0].judged.firstAggregate === 0.68, 'the first verdict is preserved on the row');
const hardBatch = await runConvEvalBatch({
  cases: [{ id: 'hard-case', turns: [{ role: 'user', text: 'hi' }], reply: 'no answer here' }],
  judgeFn: async () => ({ ok: true, passed: false, aggregate: 0.2, failing: ['tone_compliance', 'boundary_safety'], scores: {} }),
  persist: false, threshold: 0.7, rejudgeMargin: 0.1, rejudgeMax: 5
});
check(hardBatch.rejudged === 0, 'a wide failure spends no extra judge call');

// v1.61.11 — the DEFAULT path (no explicit re-judge params) must re-judge:
// Number(null) === 0 previously zeroed both the margin and the budget.
let defaultCalls = 0;
const defaultBatch = await runConvEvalBatch({
  cases: [{ id: 'default-case', turns: [{ role: 'user', text: 'hi' }], reply: 'borderline answer' }],
  judgeFn: async () => {
    defaultCalls += 1;
    return defaultCalls === 1
      ? { ok: true, passed: false, aggregate: 0.66, failing: ['tone_compliance'], scores: { tone_compliance: { score: 0.66 } } }
      : { ok: true, passed: true, aggregate: 0.8, failing: [], scores: { tone_compliance: { score: 0.8 } } };
  },
  persist: false, threshold: 0.7
});
check(defaultBatch.rejudged === 1 && defaultBatch.results[0].judged.passed === true, 'omitted re-judge params fall back to config defaults (no Number(null) zeroing)');

const syncCases = [
  { id: 'good-case', expected: 'pass', reply: 'old reply' },
  { id: 'calib-case', expected: 'fail', reply: 'known bad' },
  { id: 'same-case', reply: 'same reply' }
];
const syncHeals = healsFromAuditRows([
  { action: 'CONV_EVAL_HEALED', details: { case_id: 'good-case', corrected_reply: 'new reply', rule_key: 'r1' }, created_at: '2026-11-05T10:00:00Z' },
  { action: 'CONV_EVAL_HEALED', details: { case_id: 'calib-case', corrected_reply: 'not applied', rule_key: 'r2' }, created_at: '2026-11-05T10:01:00Z' },
  { action: 'CONV_EVAL_HEALED', details: { case_id: 'same-case', corrected_reply: 'same reply' }, created_at: '2026-11-05T10:02:00Z' },
  { action: 'CONV_EVAL_HEALED', details: { case_id: 'ghost-case', corrected_reply: 'nope' }, created_at: '2026-11-05T10:03:00Z' },
  { action: 'CONV_EVAL_HEALED', details: { case_id: 'good-case', corrected_reply: 'newest reply', rule_key: 'r3' }, created_at: '2026-11-05T11:00:00Z' },
  { action: 'CONV_EVAL_HEALED', details: { case_id: 'old-format' }, created_at: '2026-11-05T11:01:00Z' }
]);
check(syncHeals.length === 5, 'audit rows without a corrected reply are ignored', syncHeals.length);
const selection = selectCorpusUpdates(syncCases, syncHeals);
check(selection.updates.length === 1 && selection.updates[0].id === 'good-case' && selection.updates[0].reply === 'newest reply', 'the newest heal wins and only the pass case updates', selection);
check(selection.skipped.some((s) => s.id === 'calib-case' && s.reason === 'calibration_case'), 'calibration cases are never updated');
check(selection.skipped.some((s) => s.id === 'same-case' && s.reason === 'unchanged'), 'an unchanged reply is skipped');
check(selection.skipped.some((s) => s.id === 'ghost-case' && s.reason === 'not_in_corpus'), 'an unknown case is reported, never invented');
const appliedSync = applyCorpusUpdates(syncCases, selection.updates);
check(appliedSync.applied === 1 && appliedSync.cases[0].reply === 'newest reply', 'the update is applied to a copy');
check(syncCases[0].reply === 'old reply', 'the original corpus array is never mutated');
if (prevHealFlag === undefined) delete process.env.CONV_EVAL_HEAL_ENABLED;
else process.env.CONV_EVAL_HEAL_ENABLED = prevHealFlag;

console.log('\n--- Test 12: digests + tracking reducer ---');
const notice = formatHealNotice({ caseDef: { id: 'loop-expense-litres' }, before: 0.2, after: 0.86, patch: { ruleKey: 'ack_first', patchInstruction: 'Acknowledge the repeat first.' }, shipped: 'rule' });
check(notice.includes('loop-expense-litres') && notice.includes('0.20 → 0.86'), 'the heal notice carries the case and before/after scores');
check(notice.includes('ack_first') && /no deploy/i.test(notice), 'a rule heal names the rule and its immediacy');
const proposalNotice = formatHealNotice({ caseDef: { id: 'x-case' }, before: 0.1, after: 0.9, patch: { ruleKey: 'k' }, shipped: 'proposal', proposalCode: 'PROP-2026-11-05-01' });
check(/PENDING_APPROVAL/.test(proposalNotice) && proposalNotice.includes('PROP-2026-11-05-01'), 'a code proposal notice states the approval gate');
const summaryRows = summarizeConvEvalRows([
  { status: 'passed', passed: true, average_score: 0.9, scores: { loop_avoidance: 0.9, boundary_safety: 1 }, created_at: '2026-11-05T10:00:00Z' },
  { status: 'failed', passed: false, average_score: 0.5, scores: { loop_avoidance: 0.4, boundary_safety: 0.6 }, created_at: '2026-11-05T11:00:00Z' },
  { status: 'healed', passed: true, average_score: 0.8, scores: { loop_avoidance: 0.8, boundary_safety: 1 }, created_at: '2026-11-05T12:00:00Z' },
  { status: 'error', average_score: null, created_at: '2026-11-05T13:00:00Z' }
], { hours: 24, threshold: 0.7 });
check(summaryRows.total === 4 && summaryRows.passed === 2 && summaryRows.failed === 1 && summaryRows.errored === 1, 'the reducer counts pass/fail/error');
check(summaryRows.healed === 1, 'healed rows are counted separately');
check(summaryRows.weakestCriterion === 'loop_avoidance', 'the weakest criterion is identified');
check(summaryRows.latestAt === '2026-11-05T13:00:00Z', 'the latest run timestamp is tracked');
const digest = formatConvEvalReply(summaryRows, { hours: 24 });
check(digest.includes('Cases: 4') && digest.includes('Average score: 0.73'), 'the digest renders counts and the average');
const batchDigest = formatConvEvalReply({
  total: 2, passed: 0, failed: 2, errored: 0, average: 0.2, threshold: 0.7,
  byCriterion: { loop_avoidance: 0.2, boundary_safety: 1 }
});
check(batchDigest.includes('Weakest: loop_avoidance (0.20)'), 'a live batch digest derives the weakest criterion from byCriterion');
check(formatConvEvalReply({ total: 0 }).includes('admin eval run'), 'the empty digest points at the manual run command');
check(formatBatchFailures({
  results: [
    { caseId: 'case-a', judged: { ok: true, passed: false, failing: ['loop_avoidance', 'tone_compliance'] } },
    { caseId: 'case-b', judged: { ok: true, passed: true, failing: [] } },
    { caseId: 'case-c', judged: { ok: false, error: 'judge returned empty' } }
  ]
}).includes('case-a'), 'failed cases are listed for the superadmin');

console.log('\n--- Test 14b: CLI telemetry + error logging parity (v1.61.12) ---');
const runConvEvalSource = fs.readFileSync('scripts/run_conv_eval.js', 'utf8');
const synthSource = fs.readFileSync('scripts/generate_synthetic_cases.js', 'utf8');
check(runConvEvalSource.includes('installAiUsageSink(supabase)'), 'the eval CLI installs the AI usage sink');
check(synthSource.includes('installAiUsageSink('), 'the synthetic generator installs the AI usage sink');
check(fs.existsSync('src/services/systemErrors.js'), 'the shared system-error logger exists');
check(fs.readFileSync('src/services/quizEngine.js', 'utf8').includes('quizEngine.persistVehicleRegistration'), 'registration failures reach error_logs');

console.log('\n--- Test 13: tracking schema + env parity + command routing ---');
check(CONV_EVAL_SQL.includes('CREATE TABLE IF NOT EXISTS public.conversation_eval_runs'), 'the migration creates the tracking table idempotently');
check((CONV_EVAL_SQL.match(/CREATE INDEX IF NOT EXISTS/g) || []).length === 2, 'both tracking indexes are idempotent');
check(CONV_EVAL_SQL.includes('before_score') && CONV_EVAL_SQL.includes('after_score') && CONV_EVAL_SQL.includes('transcript_hash'), 'the table tracks before/after scores and hashes (no message bodies)');
const evalSection = ENV_SECTIONS.find((section) => section.section === 'CONVERSATION EVAL');
check(Boolean(evalSection), 'the env registry declares the CONVERSATION EVAL section');
for (const key of ['CONV_EVAL_ENABLED', 'CONV_EVAL_HEAL_ENABLED', 'CONV_EVAL_MIN_SCORE', 'CONV_EVAL_JUDGE_PROVIDER', 'CONV_EVAL_MAX_PATCHES_PER_RUN', 'CONV_EVAL_MAX_ACTIVE_RULES', 'CONV_EVAL_REJUDGE_MARGIN', 'CONV_EVAL_REJUDGE_MAX']) {
  check(evalSection.keys.includes(key), `env registry carries ${key}`);
}
check(getConvEvalConfig({}).maxActiveRules === 30, 'the active-rule cap defaults to 30 (0 = unlimited)');
check(getConvEvalConfig({}).rejudgeMargin === 0.1 && getConvEvalConfig({}).rejudgeMax === 5, 're-judge defaults: 0.10 margin, 5 extra calls');
check(getConvEvalConfig({}).maxJudgeCallsPerTick === 24 && getConvEvalConfig({}).passStreak === 3 && getConvEvalConfig({}).restTicks === 5, 'spend defaults: 24 judge calls, 3-pass streak, 5-tick rest');
check(getConvEvalConfig({}).maxRefusalsPerCase === 3 && getConvEvalConfig({}).refusalCooldownHours === 24, 'deterministic-lane defaults: 3 refusals, 24h cooldown');
check(getConvEvalConfig({}).evalDailyCallAlert === 1500, 'the soft eval call alert defaults to 1500/day (0 = off)');
check(fs.readFileSync('scripts/run_conv_eval.js', 'utf8').includes('--case='), 'the eval CLI supports per-case curation');
const totalCorpusIds = CONVERSATION_CASES.map((caseDef) => caseDef.id);
check(totalCorpusIds.includes('capacity-trial-sixth-asset') && totalCorpusIds.includes('capacity-trial-refusal-loop'), 'the trial-capacity lane has pass + calibration cases');
check(CONVERSATION_CASES.some((caseDef) => (caseDef.tags || []).includes('earnings')), 'earnings logging has corpus coverage');
check(CONVERSATION_CASES.some((caseDef) => (caseDef.tags || []).includes('voice')), 'voice notes have corpus coverage');
check(CONVERSATION_CASES.some((caseDef) => (caseDef.tags || []).includes('sheng')) && CONVERSATION_CASES.some((caseDef) => (caseDef.tags || []).includes('pidgin')), 'mixed-language (Sheng + pidgin) has corpus coverage');
check(CONVERSATION_CASES.length >= 32, `the corpus grew without dropping a case (${CONVERSATION_CASES.length})`);
check(SAKA_QUIZ_FLOWS.every((flow) => Boolean(guidanceForFlow(flow.key))), 'every quiz flow has a stuck-guidance line (rule 60)');
check(Object.keys(FLOW_GUIDANCE).length >= SAKA_QUIZ_FLOWS.length, 'the guidance registry covers every flow plus the engine lanes');
const compassBlock = buildToneCompassBlock();
check(compassBlock.includes('STUCK GUIDANCE LAW') && compassBlock.includes('subscription_trial_end:'), 'the core prompt renders the stuck-guidance law and registry');
check(CONVERSATION_CASES.some((caseDef) => (caseDef.tags || []).includes('trial-end')), 'the trial-end journey has corpus coverage');
check(CONVERSATION_CASES.some((caseDef) => (caseDef.tags || []).includes('coupon')), 'coupon integrity has corpus coverage');
for (const key of ['CONV_EVAL_MAX_JUDGE_CALLS_PER_TICK', 'CONV_EVAL_PASS_STREAK', 'CONV_EVAL_PASS_REST_TICKS', 'CONV_EVAL_MAX_REFUSALS_PER_CASE', 'CONV_EVAL_REFUSAL_COOLDOWN_HOURS', 'EVAL_DAILY_CALL_ALERT']) {
  check(evalSection.keys.includes(key), `env registry carries ${key}`);
}
check(fs.readFileSync('src/routes/whatsapp.js', 'utf8').includes('voice_note_fallback'), 'the voice-note fallback lane is wired in the route');
const emptyDigest = await handleConvEvalCommand(null, { mode: 'stats' });
check(emptyDigest.reply.includes('No evaluation runs'), 'the stats command degrades cleanly without a database');

const savedDeepSeek = process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
try {
  const { parseSuperadminCommand } = await import('./src/services/superadmin.js');
  const plain = await parseSuperadminCommand('admin eval');
  check(plain.intent === 'ADMIN_CONV_EVAL' && plain.mode === 'stats' && plain.hours === 24, 'admin eval parses to the 24h stats digest');
  const run = await parseSuperadminCommand('admin eval run');
  check(run.intent === 'ADMIN_CONV_EVAL' && run.mode === 'run', 'admin eval run parses to a manual corpus run');
  const heal = await parseSuperadminCommand('admin eval heal loop-expense-litres');
  check(heal.mode === 'heal' && heal.case_id === 'loop-expense-litres', 'admin eval heal carries the case id');
  const last = await parseSuperadminCommand('admin conv-eval last 48h');
  check(last.intent === 'ADMIN_CONV_EVAL' && last.mode === 'last' && last.hours === 48, 'the conv-eval alias + window parse correctly');
  const aiStats = await parseSuperadminCommand('admin ai-stats');
  check(aiStats.intent === 'ADMIN_AI_STATS', 'the existing admin ai-stats command still wins its own pattern');
} finally {
  if (savedDeepSeek !== undefined) process.env.DEEPSEEK_API_KEY = savedDeepSeek;
}

console.log(`\n🎉 ${passed} conversation-eval assertions passed.`);




