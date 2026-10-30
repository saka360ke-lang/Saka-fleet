import 'dotenv/config';
import assert from 'assert';
import { createTestSupabaseClient, runWithCleanup } from './scripts/testCleanup.js';
import {
  AI_MODEL_MAX_CANARY_PCT,
  AI_MODEL_STATUS,
  applyModelRollout,
  classifyModelVersion,
  createModelUpdateProposal,
  discoverProviderModels,
  ensureAiModelRegistryTables,
  formatModelRegistryReply,
  getModelWatchdogSummary,
  getRegistryRows,
  installModelRuntime,
  monitorModelHealth,
  normalizeDiscoveredModels,
  pickModelForSlot,
  probeModelCapabilities,
  recommendModelUpdate,
  resetModelRuntime,
  rollbackModel,
  runModelBenchmark,
  tierSlotForTier,
  validateAiModelUpdatePlan,
  verifyModelUpdateAgainstRegistry
} from './src/services/aiModelRegistry.js';
import { parseSuperadminCommand } from './src/services/superadmin.js';
import { sanitizeRemediationPlan } from './src/workers/remediation.js';

/**
 * Saka Fleet — Model Watchdog test suite (v1.17.0).
 *
 * ZERO live API calls: provider discovery/probe/benchmark use injected fetch
 * stubs. Database round-trips create their own rows and ALWAYS clean them up
 * (`.clinerules` rule 10) via runWithCleanup + an explicit model-scoped sweep.
 *
 * Run: node scripts/run_tests.js test_model_scout.js
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const MODEL_A = 'deepseek-chat-test-legacy';
const MODEL_B = 'deepseek-chat-test-1017';
const TEST_MODELS = [MODEL_A, MODEL_B];
const TEST_CATEGORY = 'ai_model_update';
const supabase = createTestSupabaseClient();

const discoveryStub = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id: MODEL_A }, { id: MODEL_B }] })
});

const probeStub = async (_url, options) => {
  const body = JSON.parse(options.body);
  if (Array.isArray(body.tools)) {
    return { ok: false, status: 400, json: async () => ({ error: 'tools unsupported' }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: body.response_format ? '{"ok":true}' : 'OK' } }] })
  };
};

const benchmarkStub = async (_url, options) => {
  const body = JSON.parse(options.body);
  const prompt = String(body.messages?.[0]?.content || '');
  let content = 'unknown';
  if (/diesel/.test(prompt)) content = 'LOG_EXPENSE';
  else if (/odometer/.test(prompt)) content = 'UPDATE_MILEAGE';
  else if (/truck/.test(prompt)) content = 'REGISTER_VEHICLE';
  else if (/\{"ok":true\}/.test(prompt)) content = '{"ok":true}';
  else if (/VIN/.test(prompt)) content = 'FALSE';
  else if (/OTP/.test(prompt)) content = 'FALSE';
  else if (/15th October/.test(prompt)) content = '2026-10-15';
  else if (/03\/04\/2026/.test(prompt)) content = '2026-03-04';
  else if (/twice/.test(prompt)) content = 'EMPATHY_FIRST';
  else if (/3000/.test(prompt)) content = '3000';
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
  };
};

async function cleanupModelRows() {
  if (!supabase) return;
  const steps = [
    () => supabase.from('model_eval_runs').delete().in('model_id', TEST_MODELS),
    () => supabase.from('ai_usage_logs').delete().in('model', TEST_MODELS),
    () => supabase.from('ai_model_registry').delete().in('model_id', TEST_MODELS),
    () => supabase.from('remediation_proposals').delete().like('target_signature', 'model:deepseek-chat-test-%'),
    () => supabase.from('admin_audit_logs').delete().eq('action', 'MODEL_UPDATE_ADOPTED').contains('details', { model_id: MODEL_A }),
    () => supabase.from('admin_audit_logs').delete().eq('action', 'MODEL_UPDATE_ADOPTED').contains('details', { model_id: MODEL_B }),
    () => supabase.from('admin_audit_logs').delete().eq('action', 'MODEL_ROLLBACK').contains('details', { from_model: MODEL_B }),
    () => supabase.from('admin_audit_logs').delete().eq('action', 'MODEL_AUTO_ROLLBACK').contains('details', { from_model: MODEL_B })
  ];
  for (const step of steps) {
    try { await step(); } catch { /* best effort */ }
  }
}

async function runSuite() {
  console.log('=== SAKA FLEET — MODEL WATCHDOG TESTS (v1.17.0) ===\n');

  console.log('--- Test 1: version classification ---');
  const meta = classifyModelVersion('deepseek-chat-v4.1-flash-1017');
  check(meta.family === 'deepseek-chat', 'V4.1 Flash stays in the deepseek-chat family');
  check(meta.versionLabel === 'v4.1-flash-1017', `version label parsed (${meta.versionLabel})`);
  check(/V4\.1 Flash 1017/.test(meta.alias), `alias is human readable (${meta.alias})`);
  check(classifyModelVersion('deepseek-reasoner').family === 'deepseek-reasoner', 'reasoner family detected');
  check(tierSlotForTier(3) === 'tier_3' && tierSlotForTier(2) === 'tier_2' && tierSlotForTier(1) === 'tier_1', 'tier → slot mapping');

  console.log('--- Test 2: discovery normalisation (stubbed, zero API calls) ---');
  const discovered = await discoverProviderModels({ fetchImpl: discoveryStub, apiKey: 'test-key' });
  check(discovered.ok === true && discovered.models.length === 2, 'provider listing normalised');
  check(discovered.models.every((row) => row.status === 'discovered' && row.provider === 'deepseek'), 'models enter as discovered candidates');
  check(normalizeDiscoveredModels({ data: [] }).length === 0, 'empty payload is safe');
  const missingKey = await discoverProviderModels({ fetchImpl: discoveryStub, apiKey: '' });
  check(missingKey.ok === false, 'missing API key fails soft');

  console.log('--- Test 3: capability probe ---');
  const capabilities = await probeModelCapabilities({ modelId: MODEL_B, fetchImpl: probeStub, apiKey: 'test-key' });
  check(capabilities.ok === true && capabilities.jsonMode === true, 'JSON mode verified');
  check(capabilities.webSearch === false && capabilities.fetch === false, 'unsupported web search is reported honestly');

  console.log('--- Test 4: deterministic benchmark ---');
  const benchmark = await runModelBenchmark({ modelId: MODEL_B, fetchImpl: benchmarkStub, apiKey: 'test-key' });
  check(benchmark.casesTotal === 10, 'all 10 benchmark cases ran');
  check(benchmark.score === 1, `perfect score on compliant behaviour (${benchmark.score})`);
  check(benchmark.latencyMs >= 0 && benchmark.promptTokens === 100, 'latency + tokens captured');

  console.log('--- Test 5: plan guardrails ---');
  const goodPlan = {
    category: 'ai_model_update',
    model_id: MODEL_B,
    traffic_split: AI_MODEL_MAX_CANARY_PCT,
    rollback: 'admin model rollback tier_2',
    changes: [{ file: 'src/services/aiModelRegistry.js', change: 'activate benchmarked model' }],
    tests: ['test_model_scout.js', 'test_model_router.js', 'test_agent_training.js']
  };
  check(validateAiModelUpdatePlan(goodPlan).ok, 'model plan with allowlisted scope passes');
  check(validateAiModelUpdatePlan({ ...goodPlan, rollback: '' }).ok === false, 'missing rollback is rejected');
  check(validateAiModelUpdatePlan({ ...goodPlan, traffic_split: AI_MODEL_MAX_CANARY_PCT + 10 }).ok === false, 'canary ceiling is enforced');
  check(validateAiModelUpdatePlan({ ...goodPlan, changes: [{ file: 'src/services/paystack.js' }] }).ok === false, 'non-allowlisted file is rejected');
  check(validateAiModelUpdatePlan({ ...goodPlan, tests: [] }).ok === false, 'mandatory suites are required');
  check(sanitizeRemediationPlan(goodPlan).ok, 'remediation sanitizer accepts a valid model plan');
  check(sanitizeRemediationPlan({ ...goodPlan, rollback: '' }).ok === false, 'remediation sanitizer blocks an invalid model plan');
  check(validateAiModelUpdatePlan({ category: 'error_cluster', changes: [], tests: [] }).applicable === false, 'non-model plans are untouched');

  console.log('--- Test 6: superadmin command parsing (offline) ---');
  const savedKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = '';
  try {
    check((await parseSuperadminCommand('admin models')).intent === 'ADMIN_MODELS', 'admin models parsed');
    check((await parseSuperadminCommand('admin model scout')).intent === 'ADMIN_MODEL_SCOUT', 'admin model scout parsed');
    const adopt = await parseSuperadminCommand(`admin model adopt ${MODEL_B} 25`);
    check(adopt.intent === 'ADMIN_MODEL_ADOPT' && adopt.model_id === MODEL_B && adopt.traffic_split === 25, 'admin model adopt parsed with split');
    const rollbackCommand = await parseSuperadminCommand('admin model rollback tier_2');
    check(rollbackCommand.intent === 'ADMIN_MODEL_ROLLBACK' && rollbackCommand.tier_slot === 'tier_2', 'admin model rollback parsed');
    check((await parseSuperadminCommand('admin model nonsense')).intent === 'UNKNOWN', 'invalid model command falls through');
  } finally {
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedKey;
  }

  if (!supabase) {
    console.log('\n  ⚠️ Supabase unavailable — DB round-trip skipped.');
    return;
  }

  console.log('--- Test 7: registry provisioning + DB gate ---');
  const tables = await ensureAiModelRegistryTables(supabase);
  check(['exists', 'created'].includes(tables.ai_model_registry), 'ai_model_registry available');
  check(['exists', 'created'].includes(tables.model_eval_runs), 'model_eval_runs available');
  await cleanupModelRows();

  const { error: seedError } = await supabase.from('ai_model_registry').upsert([
    {
      provider: 'deepseek', model_id: MODEL_A, family: 'deepseek-chat', alias: 'Test Legacy',
      tier_slot: 'tier_2', status: AI_MODEL_STATUS.BENCHMARKED, traffic_split: 0, source: 'test',
      benchmark: { score: 0.9, latencyMs: 900 }
    },
    {
      provider: 'deepseek', model_id: MODEL_B, family: 'deepseek-chat', alias: 'Test Flash 1017',
      tier_slot: 'tier_2', status: AI_MODEL_STATUS.BENCHMARKED, traffic_split: 0, source: 'test',
      benchmark: { score: 0.95, latencyMs: 700 }
    }
  ], { onConflict: 'provider,model_id' });
  check(!seedError, `test registry rows seeded${seedError ? `: ${seedError.message}` : ''}`);

  check((await verifyModelUpdateAgainstRegistry(supabase, { model_id: MODEL_A })).ok, 'benchmarked model passes the DB gate');
  check((await verifyModelUpdateAgainstRegistry(supabase, { model_id: 'deepseek-chat-missing' })).ok === false, 'unknown model fails the DB gate');
  await supabase.from('ai_model_registry').update({ benchmark: { score: 0.4, latencyMs: 900 } }).eq('model_id', MODEL_A);
  check((await verifyModelUpdateAgainstRegistry(supabase, { model_id: MODEL_A })).ok === false, 'below-threshold benchmark fails the DB gate');
  await supabase.from('ai_model_registry').update({ benchmark: { score: 0.9, latencyMs: 900 } }).eq('model_id', MODEL_A);

  console.log('--- Test 8: recommendation + rollout + rollback ---');
  const recommendation = await recommendModelUpdate(supabase);
  check(recommendation.recommended === true && recommendation.modelId === MODEL_B, 'highest-scoring candidate recommended');
  check(recommendation.tierSlot === 'tier_2', 'recommendation targets the candidate slot');

  const firstRollout = await applyModelRollout(supabase, { modelId: MODEL_A, tierSlot: 'tier_2', trafficSplit: 100, activatedBy: 'test' });
  check(firstRollout.ok === true, 'first rollout activates the seed candidate');
  const secondRollout = await applyModelRollout(supabase, { modelId: MODEL_B, tierSlot: 'tier_2', trafficSplit: 100, activatedBy: 'test' });
  check(secondRollout.ok === true && secondRollout.previous.includes(MODEL_A), 'second rollout demotes the previous model to standby');

  await installModelRuntime(supabase);
  check(pickModelForSlot('tier_2') === MODEL_B, 'runtime resolver returns the active model');
  await applyModelRollout(supabase, { modelId: MODEL_B, tierSlot: 'tier_2', trafficSplit: 25, activatedBy: 'test' });
  check(pickModelForSlot('tier_2', () => 0.1) === MODEL_B, 'canary keeps the new model under the split');
  check(pickModelForSlot('tier_2', () => 0.9) === MODEL_A, 'canary overflows to the standby model');
  check(pickModelForSlot('tier_1', () => 0.5) === 'deepseek-chat', 'tier_1 seed model remains active');

  const manualRollback = await rollbackModel(supabase, { tierSlot: 'tier_2', reason: 'test' });
  check(manualRollback.ok === true && manualRollback.from === MODEL_B && manualRollback.to === MODEL_A, 'manual rollback swaps back to standby');

  console.log('--- Test 9: health watchdog auto-rollback ---');
  await applyModelRollout(supabase, { modelId: MODEL_B, tierSlot: 'tier_2', trafficSplit: 100, activatedBy: 'test' });
  const usageRows = [
    ...Array.from({ length: 40 }, (_, index) => ({
      purpose: 'model_benchmark', tier: 1, provider: 'deepseek', model: MODEL_B,
      latency_ms: 120, ok: index >= 30, input_chars: 10, created_at: new Date().toISOString()
    })),
    ...Array.from({ length: 40 }, () => ({
      purpose: 'model_benchmark', tier: 1, provider: 'deepseek', model: MODEL_A,
      latency_ms: 140, ok: true, input_chars: 10, created_at: new Date().toISOString()
    }))
  ];
  const { error: usageError } = await supabase.from('ai_usage_logs').insert(usageRows);
  check(!usageError, `health samples inserted${usageError ? `: ${usageError.message}` : ''}`);
  const health = await monitorModelHealth(supabase, { minSamples: 10 });
  const tier2Rollback = (health.rollbacks || []).find((row) => row.tierSlot === 'tier_2');
  check(Boolean(tier2Rollback), 'regressed canary detected');
  check(tier2Rollback?.rolledBack === true && tier2Rollback?.to === MODEL_A, 'watchdog auto-rolled back to the standby model');

  console.log('--- Test 10: proposal creation + digest ---');
  await supabase.from('ai_model_registry')
    .update({ status: AI_MODEL_STATUS.BENCHMARKED, benchmark: { score: 0.95, latencyMs: 700 } })
    .eq('model_id', MODEL_B);
  const nextRecommendation = await recommendModelUpdate(supabase);
  check(nextRecommendation.recommended === true && nextRecommendation.modelId === MODEL_B, 'candidate re-recommended after rollback');
  const proposal = await createModelUpdateProposal(supabase, nextRecommendation);
  check(proposal.ok === true && Boolean(proposal.proposal_code), `model proposal created (${proposal.proposal_code || proposal.error})`);
  const duplicate = await createModelUpdateProposal(supabase, nextRecommendation);
  check(duplicate.ok === true && duplicate.duplicate === true, 'duplicate proposal suppressed');

  const summary = await getModelWatchdogSummary(supabase);
  check(summary.candidates.some((row) => row.modelId === MODEL_B), 'summary lists the benchmarked candidate');
  const digest = formatModelRegistryReply(summary);
  check(digest.includes('Saka Model Watchdog') && digest.includes('admin model scout'), 'digest is deterministic and actionable');
  check(digest.includes('Scout OFF'), 'digest reports the kill-switch state truthfully');

  const rows = await getRegistryRows(supabase);
  check(Array.isArray(rows) && rows.some((row) => row.model_id === MODEL_A), 'registry rows readable');
}

await runWithCleanup({
  testFn: runSuite,
  supabase,
  verbose: false
});

// Model-scoped sweep (runs after the generic cleanup, pass or fail).
await cleanupModelRows();
resetModelRuntime();

console.log(`\n🎉 ${passed} model watchdog assertions passed.`);
process.exit(0);



