import dotenv from 'dotenv';
dotenv.config();
import { createTestSupabaseClient, runWithCleanup } from './scripts/testCleanup.js';

/**
 * Saka Fleet — Phase 1 canary routing tests (v1.12.1).
 *
 * ZERO live network calls:
 *  - the Anthropic leg is a native fetch call, intercepted below before the
 *    provider modules are imported;
 *  - the DeepSeek leg (openai SDK) also resolves through global fetch in Node 20;
 *  - any non-provider URL (e.g. Supabase REST) passes straight through to the
 *    real fetch, so telemetry assertions keep working.
 */

const realFetch = globalThis.fetch;
let fetchHandler = null;

globalThis.fetch = (url, options = {}) => {
  const target = String(url);
  if (fetchHandler && (target.includes('api.anthropic.com') || target.includes('api.deepseek.com'))) {
    return fetchHandler(target, options);
  }
  return realFetch(url, options);
};

const {
  AI_PROVIDERS,
  AI_TIERS,
  resolveTier,
  chatCompletion,
  setAiUsageSink,
  getAiUsageSink,
  toAnthropicMessages,
  normalizeAnthropicResponse
} = await import('./src/services/aiClient.js');
const { classifyIntentTier } = await import('./sakaAi.js');
const { installAiUsageSink, AI_USAGE_TABLE } = await import('./src/services/aiUsageLog.js');

const supabase = createTestSupabaseClient();
let passed = 0;

function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${message}`);
    return;
  }
  throw new Error(`Assertion failed: ${message}`);
}

function setFetchHandler(handler) {
  fetchHandler = handler;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function anthropicOk(text) {
  return jsonResponse({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 11, output_tokens: 7 }
  });
}

function deepseekOk(content) {
  return jsonResponse({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const PREMIUM_ENV = {
  PREMIUM_MODEL_ENABLED: 'on',
  CONVERSATIONAL_PROVIDER: 'anthropic',
  AI_MODEL_TIER_2: 'claude-test',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  DEEPSEEK_API_KEY: 'test-deepseek-key'
};

async function runTests() {
  console.log('=== SAKA FLEET — PHASE 1 CANARY ROUTING TESTS ===\n');

  console.log('--- Test 1: Anthropic message translation + response normalization ---');
  const translated = toAnthropicMessages('System rules', [
    { role: 'system', content: 'Extra rules' },
    { role: 'user', content: 'hello' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'hi' }
  ], true);
  check(translated.system.includes('System rules') && translated.system.includes('Extra rules'), 'system entries are hoisted');
  check(translated.system.toLowerCase().includes('json'), 'jsonMode adds the JSON instruction');
  check(translated.messages.length === 2 && translated.messages[0].role === 'user', 'consecutive user turns merge');
  check(translated.messages[0].content === 'hello\nagain', 'merged user content is preserved');

  const normalized = normalizeAnthropicResponse({
    content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }],
    usage: { input_tokens: 4, output_tokens: 2 }
  });
  check(normalized.text === 'a\nb' && normalized.promptTokens === 4 && normalized.completionTokens === 2, 'response normalizes text and usage');

  console.log('\n--- Test 2: premium tier resolution binds to Anthropic ---');
  await withEnv(PREMIUM_ENV, async () => {
    const intent = resolveTier('intent_classify');
    check(intent.tier === AI_TIERS.CONVERSATIONAL, 'premium on → intent_classify resolves Tier 2');
    check(intent.provider === AI_PROVIDERS.ANTHROPIC && intent.model === 'claude-test', 'Tier 2 binds to Anthropic + AI_MODEL_TIER_2');
    const extraction = resolveTier('extraction');
    check(extraction.tier === AI_TIERS.ROUTER && extraction.provider === AI_PROVIDERS.DEEPSEEK, 'extraction stays Tier 1 DeepSeek');
  });

  console.log('\n--- Test 3: Tier-2 Anthropic success path ---');
  const captured = [];
  const previousSink = getAiUsageSink();
  try {
    setAiUsageSink((record) => captured.push(record));
    let payload = null;
    setFetchHandler(async (url, options) => {
      if (!url.includes('api.anthropic.com')) throw new Error(`Unexpected provider call: ${url}`);
      payload = JSON.parse(options.body || '{}');
      return anthropicOk('{"intent":"GREETING","extracted_data":{},"reply_message":"Hi"}');
    });
    const result = await withEnv(PREMIUM_ENV, () => chatCompletion({
      system: 'You are Saka.',
      messages: [{ role: 'user', content: 'Hello there, how are you doing today?' }],
      jsonMode: true,
      maxTokens: 100,
      temperature: 0.2,
      purpose: 'intent_classify',
      tier: AI_TIERS.CONVERSATIONAL
    }));
    check(result.ok === true && result.model === 'claude-test', 'Tier-2 call succeeds on Anthropic');
    check(payload && payload.model === 'claude-test' && Array.isArray(payload.messages), 'request body uses the Messages API shape');
    check(typeof payload.system === 'string' && payload.system.toLowerCase().includes('json'), 'jsonMode instruction reaches the Anthropic system prompt');
    check(captured.length === 1 && captured[0].provider === AI_PROVIDERS.ANTHROPIC, 'telemetry records the Anthropic provider');
    check(captured[0].promptTokens === 11 && captured[0].completionTokens === 7, 'telemetry carries Anthropic token usage');
  } finally {
    setFetchHandler(null);
    setAiUsageSink(previousSink);
  }

  console.log('\n--- Test 4: Anthropic rate limit falls back to DeepSeek ---');
  const fallbackRecords = [];
  const sinkBeforeFallback = getAiUsageSink();
  try {
    setAiUsageSink((record) => fallbackRecords.push(record));
    let anthropicCalls = 0;
    let deepseekCalls = 0;
    setFetchHandler(async (url) => {
      if (url.includes('api.anthropic.com')) {
        anthropicCalls += 1;
        return jsonResponse({ error: { type: 'rate_limit_error' } }, 429);
      }
      deepseekCalls += 1;
      return deepseekOk('{"intent":"GREETING","extracted_data":{},"reply_message":"Hi"}');
    });
    const result = await withEnv(PREMIUM_ENV, () => chatCompletion({
      system: 'JSON only.',
      messages: [{ role: 'user', content: 'hello' }],
      jsonMode: true,
      maxTokens: 64,
      temperature: 0.2,
      purpose: 'intent_classify',
      tier: AI_TIERS.CONVERSATIONAL
    }));
    check(result.ok === true && result.model === 'deepseek-chat', 'rate-limited Tier-2 call completes on DeepSeek');
    check(anthropicCalls === 1 && deepseekCalls === 1, 'both providers were attempted exactly once');
    check(fallbackRecords.length === 1 && fallbackRecords[0].ok === true && fallbackRecords[0].provider === AI_PROVIDERS.DEEPSEEK, 'telemetry reports the DeepSeek fallback truthfully');
  } finally {
    setFetchHandler(null);
    setAiUsageSink(sinkBeforeFallback);
  }

  console.log('\n--- Test 5: Anthropic timeout falls back to DeepSeek ---');
  const timeoutRecords = [];
  const sinkBeforeTimeout = getAiUsageSink();
  try {
    setAiUsageSink((record) => timeoutRecords.push(record));
    setFetchHandler(async (url) => {
      if (url.includes('api.anthropic.com')) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return deepseekOk('{"intent":"GREETING","extracted_data":{},"reply_message":"Hi"}');
    });
    const result = await withEnv(PREMIUM_ENV, () => chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      jsonMode: true,
      maxTokens: 64,
      temperature: 0.2,
      purpose: 'intent_classify',
      tier: AI_TIERS.CONVERSATIONAL
    }));
    check(result.ok === true && result.model === 'deepseek-chat', 'timed-out Tier-2 call completes on DeepSeek');
    check(timeoutRecords.length === 1 && timeoutRecords[0].ok === true, 'one success usage record emitted');
  } finally {
    setFetchHandler(null);
    setAiUsageSink(sinkBeforeTimeout);
  }

  console.log('\n--- Test 6: AI_PREMIUM_MAX_CONCURRENCY caps Anthropic in-flight requests ---');
  let anthropicInFlight = 0;
  let maxAnthropicInFlight = 0;
  let anthropicCalls = 0;
  let deepseekCalls = 0;
  try {
    setFetchHandler(async (url) => {
      if (url.includes('api.anthropic.com')) {
        anthropicCalls += 1;
        anthropicInFlight += 1;
        maxAnthropicInFlight = Math.max(maxAnthropicInFlight, anthropicInFlight);
        await delay(120);
        anthropicInFlight -= 1;
        return anthropicOk('{"intent":"GREETING","extracted_data":{},"reply_message":"Hi"}');
      }
      deepseekCalls += 1;
      return deepseekOk('{"intent":"GREETING","extracted_data":{},"reply_message":"Hi"}');
    });
    const results = await withEnv({ ...PREMIUM_ENV, AI_PREMIUM_MAX_CONCURRENCY: '2' }, () =>
      Promise.all([0, 1, 2].map(() => chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
        jsonMode: true,
        maxTokens: 64,
        temperature: 0.2,
        purpose: 'intent_classify',
        tier: AI_TIERS.CONVERSATIONAL
      }))));
    check(results.every((result) => result.ok === true), 'all three concurrent turns complete');
    check(maxAnthropicInFlight <= 2, `Anthropic in-flight never exceeded the cap (max ${maxAnthropicInFlight})`);
    check(anthropicCalls === 2 && deepseekCalls === 1, 'the third turn overflowed to DeepSeek');
  } finally {
    setFetchHandler(null);
  }

  console.log('\n--- Test 7: canary escalation classifier ---');
  check(classifyIntentTier('Hi there') === AI_TIERS.ROUTER, 'greeting stays Tier 1');
  check(classifyIntentTier('What can you do for my fleet?') === AI_TIERS.ROUTER, 'short FAQ stays Tier 1');
  check(classifyIntentTier('I am stuck, the bot is broken again') === AI_TIERS.CONVERSATIONAL, 'frustration escalates to Tier 2');
  check(classifyIntentTier('Please assign driver to +254700000000') === AI_TIERS.CONVERSATIONAL, 'driver handshake escalates to Tier 2');
  check(classifyIntentTier('I want to book a pickup for tomorrow morning') === AI_TIERS.CONVERSATIONAL, 'booking/dispatch escalates to Tier 2');
  check(classifyIntentTier('Log fuel 3000 at 50350 km') === AI_TIERS.CONVERSATIONAL, 'multi-fact action escalates to Tier 2');
  check(classifyIntentTier('x'.repeat(200)) === AI_TIERS.CONVERSATIONAL, 'long complex turn escalates to Tier 2');
  const sixTurns = Array.from({ length: 6 }, () => ({ role: 'user', content: 'hello' }));
  check(classifyIntentTier('why is my report missing', sixTurns) === AI_TIERS.CONVERSATIONAL, 'deep-history why-question escalates to Tier 2');
  check(classifyIntentTier('why is my report missing', []) === AI_TIERS.ROUTER, 'why-question without history stays Tier 1');

  console.log('\n--- Test 8: premium off downgrades the canary tier (Phase 0 invariant) ---');
  let anthropicTouched = 0;
  let deepseekTouched = 0;
  const downgradeSink = getAiUsageSink();
  const downgradeRecords = [];
  try {
    setAiUsageSink((record) => downgradeRecords.push(record));
    setFetchHandler(async (url) => {
      if (url.includes('api.anthropic.com')) {
        anthropicTouched += 1;
        return anthropicOk('{}');
      }
      deepseekTouched += 1;
      return deepseekOk('{"intent":"GREETING","extracted_data":{},"reply_message":"Hi"}');
    });
    const result = await withEnv({
      PREMIUM_MODEL_ENABLED: undefined,
      CONVERSATIONAL_PROVIDER: 'anthropic',
      AI_MODEL_TIER_2: 'claude-test',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      DEEPSEEK_API_KEY: 'test-deepseek-key'
    }, () => chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      jsonMode: true,
      maxTokens: 64,
      temperature: 0.2,
      purpose: 'intent_classify',
      tier: AI_TIERS.CONVERSATIONAL
    }));
    check(result.ok === true && result.model === 'deepseek-chat', 'premium off keeps Tier-2 turns on DeepSeek');
    check(anthropicTouched === 0 && deepseekTouched === 1, 'Anthropic is never contacted while premium is off');
    check(downgradeRecords.length === 1 && downgradeRecords[0].tier === AI_TIERS.ROUTER, 'telemetry records the downgraded tier');
  } finally {
    setFetchHandler(null);
    setAiUsageSink(downgradeSink);
  }

  console.log('\n--- Test 9: telemetry lands in ai_usage_logs (DB, self-cleaning) ---');
  if (!supabase) {
    console.log('  ⚠️ Supabase credentials missing — DB assertion skipped.');
  } else {
    const sinkBeforeDb = getAiUsageSink();
    try {
      installAiUsageSink(supabase);
      setFetchHandler(async (url) => {
        if (url.includes('api.anthropic.com')) return jsonResponse({ error: { type: 'rate_limit_error' } }, 429);
        return deepseekOk('{"intent":"GREETING","extracted_data":{},"reply_message":"Hi"}');
      });
      const result = await withEnv(PREMIUM_ENV, () => chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
        jsonMode: true,
        maxTokens: 64,
        temperature: 0.2,
        purpose: 'unit_test',
        tier: AI_TIERS.CONVERSATIONAL
      }));
      check(result.ok === true, 'fallback turn completed for telemetry write');

      let row = null;
      for (let attempt = 0; attempt < 6 && !row; attempt += 1) {
        const { data } = await supabase.from(AI_USAGE_TABLE)
          .select('purpose,provider,model,tier,ok')
          .eq('purpose', 'unit_test')
          .order('created_at', { ascending: false })
          .limit(1);
        row = (data || [])[0] || null;
        if (!row) await delay(300);
      }
      check(row && row.ok === true && row.provider === AI_PROVIDERS.DEEPSEEK, 'ai_usage_logs row records the DeepSeek fallback');
      check(row.tier === AI_TIERS.CONVERSATIONAL, 'ai_usage_logs row keeps the canary tier');
    } finally {
      setFetchHandler(null);
      setAiUsageSink(sinkBeforeDb);
      await supabase.from(AI_USAGE_TABLE).delete().eq('purpose', 'unit_test');
      const { data: leftovers } = await supabase.from(AI_USAGE_TABLE).select('id').eq('purpose', 'unit_test');
      check((leftovers || []).length === 0, 'unit-test telemetry rows were cleaned up');
    }
  }

  console.log(`\n=== ALL ${passed} PHASE 1 CANARY ASSERTIONS PASSED ===`);
}

runWithCleanup({ testFn: runTests })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Phase 1 canary tests failed:', err.message);
    process.exit(1);
  });