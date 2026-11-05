import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AI_PURPOSES, AI_TIERS, USER_FACING_PURPOSES } from './src/services/aiClient.js';
import {
  CONVERSATION_CASES,
  validateCase,
  loadSyntheticCases,
  SYNTHETIC_CASES,
  SYNTHETIC_CASE_ERRORS,
  countryBucketsOf
} from './src/services/convEvalCases.js';
import { runConvEvalBatch } from './src/services/convEval.js';
import {
  SYNTH_REGIONS,
  DEFAULT_COUNTRIES,
  buildSynthSystem,
  buildSynthPrompt,
  sanitizeSyntheticCase,
  parseSyntheticBatch,
  syntheticFilename,
  writeSyntheticBatch,
  parseArgs,
  generateForCountry
} from './scripts/generate_synthetic_cases.js';

/**
 * Saka Fleet — global synthetic scenario generator suite (v1.61.0). Stateless.
 *
 * Proves the generator contract WITHOUT a provider call: purpose registry,
 * country-bucket registry, prompt laws, schema sanitizer (PII/bucket/reply),
 * batch parsing, atomic writes, corpus isolation, per-case thresholds and the
 * injectable DeepSeek bridge. Temporary files live in the OS temp dir and are
 * always removed (rule 10).
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — SYNTHETIC SCENARIO GENERATOR TESTS (v1.61.0) ===\n');

console.log('--- Test 1: purpose registry (rule 20 single hub) ---');
check(Boolean(AI_PURPOSES.conversation_synth), 'conversation_synth is registered in AI_PURPOSES');
check(AI_PURPOSES.conversation_synth?.tier === AI_TIERS.REASONING, 'the generator rides the reasoning tier');
check(AI_PURPOSES.conversation_synth?.jsonMode === true, 'JSON mode is enforced');
check(AI_PURPOSES.conversation_synth?.maxTokens === 2000, 'the token budget is 2000');
check(AI_PURPOSES.conversation_synth?.temperature === 0.75, 'temperature is 0.75 for regional variety');
check(!USER_FACING_PURPOSES.has('conversation_synth'), 'the generator is never a front-user purpose');

console.log('\n--- Test 2: country-bucket registry (global coverage) ---');
for (const bucket of ['KE', 'NG', 'ZA', 'GLOBAL']) {
  check(Boolean(SYNTH_REGIONS[bucket]), `${bucket} is a supported bucket`);
}
check(Object.keys(SYNTH_REGIONS).every((code) => code === 'GLOBAL' || /^[A-Z]{2}$/.test(code)), 'every bucket is an ISO-3166 alpha-2 code or GLOBAL');
check(Object.values(SYNTH_REGIONS).every((region) => region.currency && region.phraseology && region.examples?.length >= 1), 'every bucket declares a currency, phraseology and examples');
check(DEFAULT_COUNTRIES.every((code) => SYNTH_REGIONS[code]), 'the default bucket list is valid');
check(new Set(Object.values(SYNTH_REGIONS).map((region) => region.currency)).size >= 6, 'at least six distinct local currencies are represented');

console.log('\n--- Test 3: prompt laws ---');
const system = buildSynthSystem();
check(/country bucket/i.test(system), 'the system prompt scopes one country bucket');
check(/Never use a real phone number/i.test(system) && /email/i.test(system), 'the system prompt bans PII');
check(/NEVER an invented amount/i.test(system), 'the system prompt bans invented figures');
check(/LAST turn must be from the user/i.test(system), 'the turn order contract is explicit');
check(/Persona v4/.test(system) && /ONE question/i.test(system), 'the ideal reply follows Persona v4');
check(/Do NOT recap earlier entries/i.test(system) && /Need anything else/i.test(system), 'the reply shape bans recaps and menu trailers');
check(/NEVER claim an action already happened/i.test(system), 'a write may never be claimed without confirmation');
check(/ACK VARIETY/i.test(system), 'ack variety is a generator law');
check(/"country_bucket"/.test(system) && /"expected_metrics"/.test(system), 'the JSON schema names the bucket and metrics fields');
const prompt = buildSynthPrompt({ countryBucket: 'NG', count: 3, seed: 'fuel queue' });
check(prompt.includes('NG') && prompt.includes(SYNTH_REGIONS.NG.currency), 'the user prompt carries the bucket and its currency');
check(prompt.includes('GENERATE: 3'), 'the user prompt states the requested count');
check(prompt.includes('fuel queue'), 'a seed topic is forwarded');
check(prompt.includes(SYNTH_REGIONS.NG.examples[0]), 'regional example lines are forwarded');

console.log('\n--- Test 4: sanitizer maps model drift into the strict schema ---');
const rawCase = {
  id: 'syn_ke_20261105_01',
  country_bucket: 'KE',
  scenario_title: 'Fuel shorthand',
  regional_context: 'Sheng + KES',
  tags: ['Shorthand'],
  friction_type: 'LOOPING_PROMPTS',
  turns: [
    { role: 'user', content: 'nimeweka 40l diesel 5k' },
    { role: 'assistant', text: 'Logged ✓ 40 L diesel · KES 5,000.' },
    { role: 'user', text: 'sasa mileage?' }
  ],
  reply: 'Logged ✓ 40 L diesel · KES 5,000. Send the odometer reading or reply SKIP.',
  lessons: ['Kenyans say "nimeweka" for "I have put in".'],
  expected_metrics: { min_loop_avoidance_score: 0.9, requires_shorthand_parsing: true }
};
const clean = sanitizeSyntheticCase(rawCase, { countryBucket: 'KE', index: 1, timestamp: '20261105120000' });
check(clean.ok === true, 'a valid regional case passes the sanitizer');
check(clean.value.countryBucket === 'KE', 'the country bucket is preserved');
check(clean.value.turns[0].text === 'nimeweka 40l diesel 5k', '`content` maps to `text`');
check(clean.value.tags.includes('synth') && clean.value.tags.includes('ke'), 'synthetic + bucket tags are added');
check(clean.value.tags.includes('shorthand'), 'requires_shorthand_parsing adds the shorthand tag');
check(clean.value.minScore === null, 'the loop metric never becomes a case-wide bar');
check(clean.value.criterionMins?.loop_avoidance === 0.9, 'min_loop_avoidance_score raises ONLY the loop-avoidance bar');
check(clean.value.source === 'synthetic', 'the source is synthetic');
check(clean.value.expected === 'pass', 'the ideal reply is expected to pass');
check(clean.value.id === 'syn_ke_20261105120000_01', 'the case id is always engine-namespaced (model ids never leak)');

const trailing = sanitizeSyntheticCase({
  turns: [{ role: 'user', text: 'abeg log 20k petrol' }, { role: 'assistant', text: 'Logged ✓ NGN 20,000 petrol.' }]
}, { countryBucket: 'NG', index: 2, timestamp: '20261105120000' });
check(trailing.ok === true && trailing.value.reply.includes('NGN 20,000'), 'a trailing assistant turn becomes the reply');
check(trailing.ok === true && trailing.value.turns.length === 1, 'the moved turn leaves the transcript');
check(/^syn_ng_20261105120000_02$/.test(trailing.value.id), 'a missing id is generated as syn_<cc>_<stamp>_<nn>');

console.log('\n--- Test 5: rejection gates (bucket, turns, reply, PII) ---');
check(sanitizeSyntheticCase({ ...rawCase, country_bucket: 'XX' }).ok === false, 'an unsupported country bucket is rejected');
check(sanitizeSyntheticCase({ ...rawCase, country_bucket: 'ke' }).ok === true, 'a lowercase bucket is normalised');
check(sanitizeSyntheticCase({ ...rawCase, turns: [{ role: 'assistant', text: 'hi there' }], reply: '' }).ok === false, 'a case without a user turn is rejected');
check(sanitizeSyntheticCase({ ...rawCase, reply: '' , turns: [{ role: 'user', text: 'hello' }] }).ok === false, 'a case without a reply is rejected');
check(sanitizeSyntheticCase({ ...rawCase, reply: 'Call me on +254712345678 to confirm the litres.' }).ok === false, 'a real phone number is rejected');
check(sanitizeSyntheticCase({ ...rawCase, reply: 'Email owner@fleet.co.ke to confirm the litres.' }).ok === false, 'an email address is rejected');
check(sanitizeSyntheticCase({ ...rawCase, reply: 'short' }).ok === false, 'a too-short reply is rejected');
check(sanitizeSyntheticCase(null).ok === false, 'a null case is rejected');

console.log('\n--- Test 6: lessons are scrubbed, not smuggled ---');
const scrubbed = sanitizeSyntheticCase({
  ...rawCase,
  lessons: ['Use KES not dollars.', 'Call +254712345678 for fuel.', 'Say "nimeweka".']
});
check(scrubbed.ok === true, 'a PII lesson does not kill the case');
check(scrubbed.value.lessons.length === 2, 'the PII lesson is dropped');
check(!scrubbed.value.lessons.some((lesson) => lesson.includes('+2547')), 'no phone survives in the lessons');

console.log('\n--- Test 7: ids are engine-namespaced, never model-collided ---');
const runA = sanitizeSyntheticCase({ ...rawCase, id: 'syn_ke_01' }, { index: 1, timestamp: '20261105120000' });
const runB = sanitizeSyntheticCase({ ...rawCase, id: 'syn_ke_01' }, { index: 1, timestamp: '20261105120017' });
check(runA.value.id === 'syn_ke_20261105120000_01', 'a model-invented id is replaced by the stamped id');
check(runB.value.id !== runA.value.id, 'two runs 17s apart never collide on the same model id');
const seenDup = new Set(['syn_ke_20261105120000_03']);
const dup = sanitizeSyntheticCase({ ...rawCase, id: 'syn_ke_dup_01' }, { index: 3, timestamp: '20261105120000', seen: seenDup });
check(dup.ok === true && dup.value.id !== 'syn_ke_20261105120000_03', 'an in-batch collision still gets a suffix');
check(dup.value.id.length <= 61, 'the id stays inside the validator bound');

console.log('\n--- Test 8: batch parsing is tolerant, never throws ---');
check(parseSyntheticBatch('{"cases":[{"id":"x"}]}').ok === true, 'an object with cases parses');
check(parseSyntheticBatch('[{"id":"x"}]').ok === true, 'a bare array parses');
check(parseSyntheticBatch('not json').ok === false, 'garbage is rejected');
check(parseSyntheticBatch('{"items":[]}').ok === false, 'a missing cases array is rejected');
check(/^syn_br_20260101-120000\.json$/.test(syntheticFilename('BR', new Date('2026-01-01T12:00:00Z'))), 'filenames are deterministic and bucket-namespaced');
check(syntheticFilename('BR', new Date('2026-01-01T12:00:00Z'), '-1').endsWith('-1.json'), 'a collision suffix is supported');

console.log('\n--- Test 9: atomic write + loader isolation ---');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saka-synth-'));
try {
  const written = writeSyntheticBatch({ dir: tmpDir, countryBucket: 'ZA', cases: [clean.value], now: new Date('2026-11-05T12:00:00Z') });
  check(written.ok === true && fs.existsSync(written.path), 'the batch is written atomically');
  const payload = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  check(payload.generated_by === 'generate_synthetic_cases' && payload.prompt === 'conversation_synth', 'the batch records provenance');
  check(payload.country_bucket === 'ZA' && payload.cases.length === 1, 'the batch carries its bucket and cases');
  const second = writeSyntheticBatch({ dir: tmpDir, countryBucket: 'ZA', cases: [{ ...clean.value, id: 'syn_ke_20261105_02' }], now: new Date('2026-11-05T12:00:00Z') });
  check(second.ok === true && second.filename !== written.filename, 'a same-second write never overwrites');
  fs.writeFileSync(
    path.join(tmpDir, 'syn_ng_bad.json'),
    JSON.stringify({ cases: [{ id: 'bad case id!!', turns: [{ role: 'user', text: 'hi' }], reply: 'hello there', tags: ['tone'] }] }),
    'utf8'
  );
  const loaded = loadSyntheticCases(tmpDir);
  check(loaded.cases.length === 2, 'the loader merges every valid synthetic batch');
  check(loaded.cases.every((caseDef) => caseDef.source === 'synthetic'), 'loaded cases are marked synthetic');
  check(loaded.errors.length === 1 && loaded.errors[0].includes('syn_ng_bad.json'), 'a bad batch is reported, not thrown');
  check(loaded.files.length === 3, 'all batch files are listed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  check(!fs.existsSync(tmpDir), 'temporary fixtures are always removed (rule 10)');
}
check(loadSyntheticCases(path.join(tmpDir, 'missing')).errors[0].includes('unreadable'), 'a missing directory is reported, not thrown');
check(CONVERSATION_CASES.every((caseDef) => caseDef.source === 'corpus'), 'the hand-written corpus is never marked synthetic');
check(CONVERSATION_CASES.length >= 12, 'the hand-written corpus is untouched by synthetic files');
check(Array.isArray(SYNTHETIC_CASES) && Array.isArray(SYNTHETIC_CASE_ERRORS), 'the module always exposes synthetic collections');
check(Array.isArray(countryBucketsOf([{ countryBucket: 'KE' }, { countryBucket: 'KE' }, { countryBucket: 'GLOBAL' }])), 'bucket reporting is a pure helper');

console.log('\n--- Test 10: per-case threshold plumbing ---');
const captured = [];
const batch = await runConvEvalBatch({
  persist: false,
  threshold: 0.7,
  judge: { provider: null, model: null },
  judgeFn: async ({ caseDef, judge }) => {
    captured.push({ id: caseDef.id, threshold: judge.threshold, criterionMins: judge.criterionMins });
    return { ok: true, scores: {}, aggregate: 0.9, passed: true, failing: [], threshold: judge.threshold, judge: { provider: 'stub', model: null } };
  },
  cases: [
    { id: 'case-strict', countryBucket: 'KE', minScore: 0.85, turns: [{ role: 'user', text: 'hi' }], reply: 'hello there' },
    { id: 'case-loop', countryBucket: 'KE', criterionMins: { loop_avoidance: 0.9 }, turns: [{ role: 'user', text: 'hi' }], reply: 'hello there' }
  ]
});
check(captured[0].threshold === 0.85, 'a case-wide minScore raises the bar for that case');
check(captured[1].threshold === 0.7, 'an untagged case keeps the batch threshold');
check(captured[1].criterionMins?.loop_avoidance === 0.9, 'per-criterion minimums reach the judge');
check(batch.results[0].countryBucket === 'KE', 'the bucket rides the result for tracking');
check(batch.total === 2 && batch.passed === 2, 'the batch summary counts both cases');

console.log('\n--- Test 11: the hub bridge is injectable and bounded ---');
const rawCaseFor = (bucket, index = 1) => ({
  id: `syn_${bucket.toLowerCase()}_test_${index}`,
  country_bucket: bucket,
  turns: [{ role: 'user', text: 'filled 40 litres for 50 dollars' }],
  reply: 'Logged ✓ 40 L · 50 · send the odometer or reply SKIP.',
  tags: ['shorthand'],
  expected_metrics: { min_loop_avoidance_score: 0.9 }
});
const calls = [];
const fakeComplete = async (payload) => {
  calls.push(payload);
  return {
    ok: true,
    model: 'stub-model',
    text: JSON.stringify({ cases: [rawCaseFor('BR', 1), rawCaseFor('BR', 2), { ...rawCaseFor('BR', 3), country_bucket: 'ZZ' }] })
  };
};
const generated = await generateForCountry({ countryBucket: 'BR', count: 2, complete: fakeComplete, now: new Date('2026-11-05T12:00:00Z') });
check(calls.length === 1 && calls[0].purpose === 'conversation_synth', 'one generation call rides the synth purpose');
check(calls[0].jsonMode === true && calls[0].temperature === 0.75 && calls[0].maxTokens === 2000, 'the purpose defaults reach the hub');
check(generated.ok === true && generated.cases.length === 2, 'cases are validated and capped at the batch size');
check(generated.rejected.length === 1, 'invalid cases are reported, not shipped');
check(generated.model === 'stub-model', 'the serving model is reported for the audit trail');
const unsupported = await generateForCountry({ countryBucket: 'ZZ', complete: fakeComplete });
check(unsupported.ok === false, 'an unsupported bucket never reaches the provider');
const providerDown = await generateForCountry({ countryBucket: 'KE', complete: async () => ({ ok: false, error: new Error('down') }) });
check(providerDown.ok === false, 'a provider outage returns a plain error');
const args = parseArgs(['--countries=ke, ng ,ZA', '--batch=999', '--preview', '--seed=fuel', '--out=tmp/cases']);
check(args.countries.join(',') === 'KE,NG,ZA', 'country codes are normalised');
check(args.batch === 24, 'the batch size clamps at 24');
check(args.preview === true && args.seed === 'fuel', 'preview and seed parse');
check(path.isAbsolute(args.out), 'the output directory resolves to an absolute path');

console.log(`\n🎉 ${passed} synthetic-scenario assertions passed.`);


