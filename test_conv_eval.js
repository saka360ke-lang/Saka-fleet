import assert from 'assert';
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
  resolveJudgeConfig,
  sanitizeJudgeScores,
  summarizeConvEvalRows
} from './src/services/convEval.js';
import {
  CONVERSATION_CASES,
  CASE_VALIDATION_ERRORS,
  REQUIRED_TAGS,
  buildLiveCasesFromFriction,
  corpusTags,
  parseFrictionSnippet,
  sampleCorpusCases,
  validateCase
} from './src/services/convEvalCases.js';
import { sanitizeHealPatch, formatHealNotice, HEAL_PATCH_MAX_CHARS } from './src/services/convEvalHealer.js';
import { formatBatchFailures, handleConvEvalCommand } from './src/services/convEvalConsole.js';
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
withEnv({ CONV_EVAL_INTERVAL_HOURS: undefined, CONV_EVAL_MAX_CASES_PER_RUN: undefined, CONV_EVAL_MIN_SCORE: undefined, CONV_EVAL_JUDGE_PROVIDER: undefined, CONV_EVAL_JUDGE_MODEL: undefined }, () => {
  const cfg = getConvEvalConfig();
  check(cfg.threshold === 0.7 && cfg.maxCases === 12, 'defaults: 0.70 threshold, 12 cases');
  check(cfg.intervalMs === 6 * 60 * 60 * 1000, 'default cadence is 6 h');
  check(cfg.maxPatches === 2 && cfg.dedupeHours === 24, 'defaults: 2 patches, 24 h dedupe');
  check(cfg.judgeProvider === 'deepseek', 'judge defaults to the DeepSeek background policy');
  const judge = resolveJudgeConfig();
  check(judge.provider === null && judge.model === null, 'default judge uses the standard purpose chain');
});
withEnv({ CONV_EVAL_INTERVAL_HOURS: '999', CONV_EVAL_MAX_CASES_PER_RUN: '999', CONV_EVAL_MIN_SCORE: '5' }, () => {
  const cfg = getConvEvalConfig();
  check(cfg.intervalMs === 168 * 60 * 60 * 1000, 'interval clamps to 168 h');
  check(cfg.maxCases === 50, 'case budget clamps to 50');
  check(cfg.threshold === 1, 'threshold clamps to 1');
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
check(/BANNED PHRASES/.test(judgeSystem), 'the judge prompt carries the banned-phrase law');
for (const key of CONV_EVAL_CRITERIA_KEYS) {
  check(judgeSystem.includes(key), `judge prompt names the ${key} criterion`);
}
const judgePrompt = buildJudgePrompt({ id: 'unit-case', turns: [{ role: 'user', text: '40l diesel 5k' }] }, 'Logged ✓ 40 L diesel · KES 5,000.');
check(judgePrompt.includes('USER: 40l diesel 5k'), 'the prompt renders the transcript');
check(judgePrompt.includes('Logged ✓ 40 L diesel'), 'the prompt renders the reply under evaluation');
check(judgePrompt.includes('Grade the reply now.'), 'the prompt ends with the grading instruction');

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

console.log('\n--- Test 13: tracking schema + env parity + command routing ---');
check(CONV_EVAL_SQL.includes('CREATE TABLE IF NOT EXISTS public.conversation_eval_runs'), 'the migration creates the tracking table idempotently');
check((CONV_EVAL_SQL.match(/CREATE INDEX IF NOT EXISTS/g) || []).length === 2, 'both tracking indexes are idempotent');
check(CONV_EVAL_SQL.includes('before_score') && CONV_EVAL_SQL.includes('after_score') && CONV_EVAL_SQL.includes('transcript_hash'), 'the table tracks before/after scores and hashes (no message bodies)');
const evalSection = ENV_SECTIONS.find((section) => section.section === 'CONVERSATION EVAL');
check(Boolean(evalSection), 'the env registry declares the CONVERSATION EVAL section');
for (const key of ['CONV_EVAL_ENABLED', 'CONV_EVAL_HEAL_ENABLED', 'CONV_EVAL_MIN_SCORE', 'CONV_EVAL_JUDGE_PROVIDER', 'CONV_EVAL_MAX_PATCHES_PER_RUN']) {
  check(evalSection.keys.includes(key), `env registry carries ${key}`);
}
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




