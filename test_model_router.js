import dotenv from 'dotenv';
dotenv.config();

import {
  AI_PROVIDERS,
  AI_TIERS,
  AI_PURPOSES,
  isPremiumModelEnabled,
  getTierModel,
  resolveTier,
  routeModelForPurpose,
  getProviderClient,
  chatCompletion,
  setAiUsageSink,
  getAiUsageSink,
  normalizeHistory,
  parseJsonSafely
} from './src/services/aiClient.js';
import {
  ensureAiUsageLogsTable,
  logAiUsage,
  isAiUsageLoggingEnabled,
  AI_USAGE_TABLE
} from './src/services/aiUsageLog.js';
import { createTestSupabaseClient, runWithCleanup } from './scripts/testCleanup.js';

/**
 * Saka Fleet — Model Router unit tests (Phase 0, v1.12.0).
 *
 * ZERO live API calls: the only chatCompletion() exercised runs with the
 * DeepSeek key removed, which fails inside getAIClient() before any socket is
 * opened. Provider routing is verified through pure resolution functions.
 */

let passed = 0;

function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${message}`);
    return;
  }
  throw new Error(`Assertion failed: ${message}`);
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const supabase = createTestSupabaseClient();

async function runTests() {
  console.log('=== SAKA FLEET — MODEL ROUTER TESTS (PHASE 0) ===\n');

  // Environment-independent baseline: a unit suite must not inherit the local
  // .env kill switch. Test 2 explicitly re-enables premium in isolation.
  const premiumEnvironmentBefore = isPremiumModelEnabled();
  process.env.PREMIUM_MODEL_ENABLED = 'off';
  console.log(`  ℹ️ Premium switch forced off for the suite (local value: ${premiumEnvironmentBefore ? 'on' : 'off'}).\n`);

  console.log('--- Test 1: every purpose resolves to DeepSeek while premium is off ---');
  const premiumBefore = isPremiumModelEnabled();
  withEnv({ PREMIUM_MODEL_ENABLED: 'off', CONVERSATIONAL_PROVIDER: undefined, AI_MODEL_TIER_2: undefined }, () => {
    check(isPremiumModelEnabled() === false, 'premium routing is off when the kill switch is off');
    for (const purpose of Object.keys(AI_PURPOSES)) {
      const resolved = resolveTier(purpose);
      check(resolved.provider === AI_PROVIDERS.DEEPSEEK, `${purpose}: provider is deepseek`);
      check(typeof resolved.model === 'string' && resolved.model.startsWith('deepseek'), `${purpose}: DeepSeek model (${resolved.model})`);
      check(resolved.tier === AI_TIERS.ROUTER || resolved.tier === AI_TIERS.REASONING, `${purpose}: tier is 1/3 while premium is off`);
    }
  });
  check(isPremiumModelEnabled() === premiumBefore, 'premium switch restored to its pre-test value');

  console.log('\n--- Test 2: PREMIUM_MODEL_ENABLED upgrades the conversational tier ---');
  withEnv({
    PREMIUM_MODEL_ENABLED: 'on',
    CONVERSATIONAL_PROVIDER: 'anthropic',
    AI_MODEL_TIER_2: 'claude-sonnet-test'
  }, () => {
    const intent = resolveTier('intent_classify');
    check(intent.tier === AI_TIERS.CONVERSATIONAL, 'intent_classify resolves Tier 2 when premium is on');
    check(intent.provider === 'anthropic', 'intent_classify uses the configured provider');
    check(intent.model === 'claude-sonnet-test', 'intent_classify uses AI_MODEL_TIER_2');
    const extraction = resolveTier('extraction');
    check(extraction.tier === AI_TIERS.ROUTER && extraction.provider === AI_PROVIDERS.DEEPSEEK, 'extraction stays on the DeepSeek router tier');
  });
  check(isPremiumModelEnabled() === premiumBefore, 'premium toggle restored after the test');

  console.log('\n--- Test 3: Tier 0 is deterministic (no model) ---');
  const deterministic = resolveTier('intent_classify', { tier: AI_TIERS.DETERMINISTIC });
  check(deterministic.provider === null && deterministic.model === null, 'Tier 0 resolves no provider/model');
  check(routeModelForPurpose('intent_classify', { tier: AI_TIERS.DETERMINISTIC }).candidates.length === 0, 'Tier 0 produces no candidates');

  console.log('\n--- Test 4: unknown purposes fall back to the default route ---');
  const unknown = routeModelForPurpose('not_a_real_purpose');
  check(unknown.tier === AI_TIERS.ROUTER && unknown.provider === AI_PROVIDERS.DEEPSEEK, 'unknown purpose → router tier on DeepSeek');
  check(unknown.candidates[0] === getTierModel(AI_TIERS.ROUTER), 'default route leads with the router-tier model');

  console.log('\n--- Test 5: chatCompletion degrades gracefully and emits telemetry ---');
  const captured = [];
  const previousSink = getAiUsageSink();
  const savedKey = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    setAiUsageSink((record) => captured.push(record));
    const result = await chatCompletion({
      system: 'Return json only.',
      messages: [{ role: 'user', content: 'Route this message.' }],
      jsonMode: true,
      maxTokens: 32,
      temperature: 0.2,
      purpose: 'intent_classify'
    });
    check(result.ok === false && result.text === '', 'missing API key returns { ok:false } without throwing');
    check(captured.length === 1, 'exactly one usage record was emitted');
    check(captured[0].ok === false && captured[0].purpose === 'intent_classify', 'usage record carries the purpose');
    check(captured[0].tier === AI_TIERS.ROUTER && captured[0].provider === AI_PROVIDERS.DEEPSEEK, 'usage record carries the downgraded tier + provider');
    check(Number.isFinite(captured[0].latencyMs), 'usage record carries latency');
  } finally {
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedKey;
    setAiUsageSink(previousSink);
  }
  check(getAiUsageSink() === previousSink, 'previous sink restored');

  console.log('\n--- Test 6: provider clients are lazy and cached ---');
  const deepseekClient = getProviderClient(AI_PROVIDERS.DEEPSEEK);
  check(deepseekClient && typeof deepseekClient.chat?.completions?.create === 'function', 'DeepSeek client exposes chat.completions.create');
  check(getProviderClient(AI_PROVIDERS.DEEPSEEK) === deepseekClient, 'DeepSeek client is cached');
  check(getProviderClient(AI_PROVIDERS.ANTHROPIC) === null, 'Anthropic is a fail-soft Phase 0 stub');

  console.log('\n--- Test 7: pure helpers keep their contract ---');
  check(normalizeHistory([{ role: 'model', parts: [{ text: 'hi' }] }])[0].role === 'assistant', 'model → assistant history mapping');
  check(parseJsonSafely('```json\n{"a":1}\n```').a === 1, 'fenced JSON is parsed');
  check(parseJsonSafely('noise {"a":2} tail').a === 2, 'embedded JSON is extracted');
  check(parseJsonSafely('not json') === null, 'invalid JSON returns null');

  console.log('\n--- Test 8: ai_usage_logs provisioning + insert (DB) ---');
  if (!supabase) {
    console.log('  ⚠️ Supabase credentials missing — DB assertions skipped.');
  } else {
    const status = await ensureAiUsageLogsTable(supabase);
    check(['exists', 'created'].includes(status[AI_USAGE_TABLE]), `${AI_USAGE_TABLE} exists or was provisioned (${status[AI_USAGE_TABLE]})`);
    check(isAiUsageLoggingEnabled() === true, 'usage logging is enabled by default');
    try {
      // PostgREST's schema cache can lag a few seconds behind DDL; retry briefly.
      let inserted = false;
      for (let attempt = 0; attempt < 6 && !inserted; attempt += 1) {
        inserted = await logAiUsage(supabase, {
          purpose: 'unit_test', tier: 1, provider: 'deepseek', model: 'deepseek-chat',
          latencyMs: 12, ok: true, error: null, inputChars: 42, promptTokens: 10, completionTokens: 5
        });
        if (!inserted) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      check(inserted === true, 'a telemetry row was inserted');
      const { data } = await supabase
        .from(AI_USAGE_TABLE)
        .select('purpose,ok,latency_ms')
        .eq('purpose', 'unit_test')
        .order('created_at', { ascending: false })
        .limit(1);
      check(data && data.length === 1 && data[0].ok === true && data[0].latency_ms === 12, 'the telemetry row is readable');
    } finally {
      await supabase.from(AI_USAGE_TABLE).delete().eq('purpose', 'unit_test');
      const { data: leftovers } = await supabase.from(AI_USAGE_TABLE).select('id').eq('purpose', 'unit_test');
      check((leftovers || []).length === 0, 'unit-test telemetry rows were cleaned up');
    }
  }

  console.log(`\n=== ALL ${passed} MODEL ROUTER ASSERTIONS PASSED ===`);
}

runWithCleanup({ testFn: runTests })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Model router tests failed:', err.message);
    process.exit(1);
  });
