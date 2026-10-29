import dotenv from 'dotenv';
dotenv.config();
import { createTestSupabaseClient, runWithCleanup } from './scripts/testCleanup.js';

const {
  AI_PROVIDERS,
  AI_TIERS,
  buildProviderChain,
  isProviderCircuitOpen,
  recordProviderOutcome,
  resetProviderBreakers,
  setBudgetGuard,
  getBudgetGuard,
  resolveTier,
  chatCompletion,
  setAiUsageSink,
  getAiUsageSink
} = await import('./src/services/aiClient.js');
const {
  AI_USAGE_TABLE,
  ensureAiUsageLogsTable,
  logAiUsage,
  getAiUsageSummary,
  computeAiBudgetStatus,
  checkAiDailyBudget,
  getAiDailyBudgetUsd
} = await import('./src/services/aiUsageLog.js');
const {
  formatAiStatsReply,
  maybeSendAiBudgetAlert
} = await import('./src/services/superadmin.js');

/**
 * Saka Fleet — Phase 3 resilience tests (v1.14.0).
 *
 * ZERO live network calls:
 *  - Anthropic + DeepSeek are intercepted through a global fetch stub.
 *  - OPENAI_API_KEY is explicitly cleared in every execution test, so the
 *    OpenAI SDK leg can never open a socket (it is validated via pure chain
 *    construction and the skipped_missing_key path).
 *  - Budget/alert tests use an in-memory Supabase double.
 * DB assertions are skipped when credentials are absent and always clean up.
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

async function withEnvAsync(vars, fn) {
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

const originalFetch = global.fetch;
let fetchHandler = null;
global.fetch = async (url, options) => {
  if (fetchHandler) return fetchHandler(String(url), options);
  return originalFetch(url, options);
};

function setFetchHandler(handler) {
  fetchHandler = handler;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function deepseekOk(content) {
  return jsonResponse({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  });
}

const supabase = createTestSupabaseClient();

function makeBudgetSupabase({ rows = [], config = new Map(), audit = [] } = {}) {
  return {
    config,
    audit,
    from(table) {
      if (table === AI_USAGE_TABLE) {
        const api = {
          select() { return api; },
          gte() { return api; },
          order() { return api; },
          async range(from, to) {
            return { data: rows.slice(from, to + 1), error: null };
          }
        };
        return api;
      }
      if (table === 'system_config') {
        return {
          select() {
            return {
              eq: (column, key) => ({
                maybeSingle: async () => ({
                  data: config.has(key) ? { value: config.get(key) } : null,
                  error: null
                })
              })
            };
          },
          upsert(entries) {
            for (const entry of entries) config.set(entry.key, entry.value);
            return Promise.resolve({ error: null });
          }
        };
      }
      if (table === 'admin_audit_logs') {
        return {
          insert: async (entries) => {
            audit.push(...entries);
            return { error: null };
          }
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }
  };
}

const PREMIUM_ENV = {
  PREMIUM_MODEL_ENABLED: 'on',
  CONVERSATIONAL_PROVIDER: 'anthropic',
  AI_MODEL_TIER_2: 'claude-test',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  OPENAI_API_KEY: undefined,
  DEEPSEEK_API_KEY: 'test-deepseek-key',
  AI_CB_FAILURE_THRESHOLD: '3',
  AI_CB_WINDOW_MS: '60000',
  AI_CB_OPEN_MS: '30000'
};

async function runTests() {
  console.log('=== SAKA FLEET — PHASE 3 RESILIENCE TESTS ===\n');

  console.log('--- Test 1: Tier-2 failover chain order ---');
  await withEnvAsync({ ...PREMIUM_ENV, OPENAI_API_KEY: 'test-openai-key' }, async () => {
    const routing = resolveTier('intent_classify');
    check(routing.tier === AI_TIERS.CONVERSATIONAL && routing.provider === AI_PROVIDERS.ANTHROPIC, 'intent_classify resolves Tier 2 on Anthropic');
    check(routing.model === 'claude-test', 'primary model uses AI_MODEL_TIER_2');
    const { chain, steps } = buildProviderChain(routing);
    check(chain[0].provider === AI_PROVIDERS.ANTHROPIC && chain[0].model === 'claude-test', 'primary leg is Anthropic');
    check(chain[1].provider === AI_PROVIDERS.OPENAI && chain[1].model === 'gpt-4o', 'secondary leg is OpenAI (gpt-4o)');
    check(chain[chain.length - 1].provider === AI_PROVIDERS.DEEPSEEK, 'DeepSeek is always the terminal leg');
    check(steps.every((step) => step.skipReason === null), 'no legs skipped when all keys are present');
  });

  console.log('\n--- Test 2: missing-key premium leg is skipped and logged ---');
  await withEnvAsync(PREMIUM_ENV, async () => {
    const { chain, steps } = buildProviderChain(resolveTier('intent_classify'));
    check(!chain.some((leg) => leg.provider === AI_PROVIDERS.OPENAI), 'OpenAI leg is not executed without a key');
    check(steps.some((step) => step.provider === AI_PROVIDERS.OPENAI && step.skipReason === 'skipped_missing_key'), 'skip reason is recorded');
    check(chain[chain.length - 1].provider === AI_PROVIDERS.DEEPSEEK, 'DeepSeek still terminates the chain');
  });

  console.log('\n--- Test 3: Tier-3 reasoning binding is autonomy-gated ---');
  await withEnvAsync({ REMEDIATION_AUTONOMY: 'on', AI_MODEL_TIER_3: undefined, AI_REASONING_PROVIDER: undefined }, async () => {
    const routing = resolveTier('health_synthesis');
    check(routing.tier === AI_TIERS.REASONING && routing.provider === AI_PROVIDERS.DEEPSEEK, 'reasoning stays on DeepSeek by default');
    check(routing.model === 'deepseek-reasoner', 'autonomy ON opts into deepseek-reasoner');
  });
  await withEnvAsync({ REMEDIATION_AUTONOMY: 'off', AI_MODEL_TIER_3: undefined, AI_REASONING_PROVIDER: undefined }, async () => {
    check(resolveTier('health_synthesis').model === 'deepseek-chat', 'autonomy OFF keeps deepseek-chat');
  });
  await withEnvAsync({ REMEDIATION_AUTONOMY: 'on', AI_REASONING_PROVIDER: 'anthropic', AI_MODEL_TIER_3: 'claude-opus-test', ANTHROPIC_API_KEY: 'test-anthropic-key', OPENAI_API_KEY: undefined }, async () => {
    const routing = resolveTier('remediation_synthesis');
    check(routing.provider === AI_PROVIDERS.ANTHROPIC && routing.model === 'claude-opus-test', 'AI_REASONING_PROVIDER=anthropic binds the reasoning tier');
    const { chain } = buildProviderChain(routing);
    check(chain[0].provider === AI_PROVIDERS.ANTHROPIC, 'reasoning chain leads with Anthropic');
    check(chain[chain.length - 1].provider === AI_PROVIDERS.DEEPSEEK, 'reasoning chain still falls back to DeepSeek');
  });

  console.log('\n--- Test 4: Anthropic 429 → DeepSeek (attempts logged) ---');
  resetProviderBreakers();
  const sinkBeforeFailover = getAiUsageSink();
  const failoverRecords = [];
  try {
    await withEnvAsync(PREMIUM_ENV, async () => {
      let anthropicCalls = 0;
      let deepseekCalls = 0;
      setFetchHandler(async (url) => {
        if (url.includes('api.anthropic.com')) {
          anthropicCalls += 1;
          return jsonResponse({ error: { type: 'rate_limit_error' } }, 429);
        }
        if (url.includes('api.deepseek.com')) {
          deepseekCalls += 1;
          return deepseekOk('{"intent":"GREETING"}');
        }
        throw new Error(`Unexpected provider call: ${url}`);
      });
      setAiUsageSink((record) => failoverRecords.push(record));
      const result = await chatCompletion({
        system: 'Return json only.',
        messages: [{ role: 'user', content: 'hi' }],
        jsonMode: true,
        purpose: 'intent_classify'
      });
      check(result.ok === true && result.model === 'deepseek-chat', 'turn completes on the DeepSeek fallback');
      check(anthropicCalls === 1 && deepseekCalls === 1, 'exactly one attempt per provider');
      check(failoverRecords.length === 1, 'one usage record per outcome');
      const attempts = failoverRecords[0].attempts || [];
      check(attempts.some((a) => a.provider === 'anthropic' && a.outcome === 'failed'), 'Anthropic failure is logged');
      check(attempts.some((a) => a.provider === 'openai' && a.outcome === 'skipped_missing_key'), 'OpenAI skip is logged');
      check(attempts[attempts.length - 1].provider === 'deepseek' && attempts[attempts.length - 1].outcome === 'ok', 'DeepSeek success is the final entry');
    });
  } finally {
    setFetchHandler(null);
    setAiUsageSink(sinkBeforeFailover);
    resetProviderBreakers();
  }

  console.log('\n--- Test 5: circuit breaker state machine ---');
  resetProviderBreakers();
  await withEnvAsync({ AI_CB_FAILURE_THRESHOLD: '3', AI_CB_WINDOW_MS: '60000', AI_CB_OPEN_MS: '30000' }, async () => {
    const base = Date.now();
    recordProviderOutcome(AI_PROVIDERS.ANTHROPIC, false, base);
    recordProviderOutcome(AI_PROVIDERS.ANTHROPIC, false, base + 1);
    recordProviderOutcome(AI_PROVIDERS.ANTHROPIC, true, base + 2);
    recordProviderOutcome(AI_PROVIDERS.ANTHROPIC, false, base + 3);
    recordProviderOutcome(AI_PROVIDERS.ANTHROPIC, false, base + 4);
    check(isProviderCircuitOpen(AI_PROVIDERS.ANTHROPIC, base + 5) === false, 'success resets; two consecutive failures do not open');
    recordProviderOutcome(AI_PROVIDERS.ANTHROPIC, false, base + 6);
    check(isProviderCircuitOpen(AI_PROVIDERS.ANTHROPIC, base + 7) === true, 'third failure opens the breaker');
    check(isProviderCircuitOpen(AI_PROVIDERS.ANTHROPIC, base + 6 + 30001) === false, 'breaker closes after the cooldown');
    for (let i = 0; i < 5; i += 1) recordProviderOutcome(AI_PROVIDERS.DEEPSEEK, false, base + i);
    check(isProviderCircuitOpen(AI_PROVIDERS.DEEPSEEK, base + 10) === false, 'DeepSeek is never breaker-blocked');
  });
  resetProviderBreakers();

  console.log('\n--- Test 6: open breaker bypasses the provider (logged) ---');
  resetProviderBreakers();
  const sinkBeforeBreaker = getAiUsageSink();
  const breakerRecords = [];
  try {
    await withEnvAsync(PREMIUM_ENV, async () => {
      let anthropicCalls = 0;
      let deepseekCalls = 0;
      setFetchHandler(async (url) => {
        if (url.includes('api.anthropic.com')) {
          anthropicCalls += 1;
          return jsonResponse({ error: { type: 'server_error' } }, 500);
        }
        if (url.includes('api.deepseek.com')) {
          deepseekCalls += 1;
          return deepseekOk('{"ok":true}');
        }
        throw new Error(`Unexpected provider call: ${url}`);
      });
      setAiUsageSink((record) => breakerRecords.push(record));
      for (let turn = 0; turn < 3; turn += 1) {
        const result = await chatCompletion({ system: 'json', messages: [{ role: 'user', content: 'hi' }], purpose: 'intent_classify' });
        check(result.ok === true, `turn ${turn + 1} falls back to DeepSeek`);
      }
      check(anthropicCalls === 3, 'Anthropic was attempted three times');
      check(isProviderCircuitOpen(AI_PROVIDERS.ANTHROPIC) === true, 'breaker is open after three failures');
      const callsBefore = anthropicCalls;
      const fourth = await chatCompletion({ system: 'json', messages: [{ role: 'user', content: 'hi' }], purpose: 'intent_classify' });
      check(fourth.ok === true && anthropicCalls === callsBefore, 'fourth turn bypasses the open provider');
      const lastAttempts = breakerRecords[breakerRecords.length - 1].attempts || [];
      check(lastAttempts.some((a) => a.provider === 'anthropic' && a.outcome === 'skipped_circuit_open'), 'circuit skip is logged');
      check(deepseekCalls === 4, 'DeepSeek served all four turns');
    });
  } finally {
    setFetchHandler(null);
    setAiUsageSink(sinkBeforeBreaker);
    resetProviderBreakers();
  }

  console.log('\n--- Test 7: budget guard skips premium legs ---');
  resetProviderBreakers();
  const previousGuard = getBudgetGuard();
  const sinkBeforeBudget = getAiUsageSink();
  const budgetRecords = [];
  try {
    setBudgetGuard(async () => true);
    await withEnvAsync(PREMIUM_ENV, async () => {
      let anthropicCalls = 0;
      let deepseekCalls = 0;
      setFetchHandler(async (url) => {
        if (url.includes('api.anthropic.com')) {
          anthropicCalls += 1;
          return jsonResponse({ error: {} }, 500);
        }
        if (url.includes('api.deepseek.com')) {
          deepseekCalls += 1;
          return deepseekOk('{"ok":true}');
        }
        throw new Error(`Unexpected provider call: ${url}`);
      });
      setAiUsageSink((record) => budgetRecords.push(record));
      const result = await chatCompletion({ system: 'json', messages: [{ role: 'user', content: 'hi' }], purpose: 'intent_classify' });
      check(result.ok === true && anthropicCalls === 0 && deepseekCalls === 1, 'over-budget premium legs are skipped');
      const attempts = budgetRecords[0].attempts || [];
      check(attempts.some((a) => a.provider === 'anthropic' && a.outcome === 'skipped_budget'), 'budget skip is logged');
    });
    setBudgetGuard(async () => false);
    await withEnvAsync(PREMIUM_ENV, async () => {
      let anthropicCalls = 0;
      setFetchHandler(async (url) => {
        if (url.includes('api.anthropic.com')) {
          anthropicCalls += 1;
          return jsonResponse({ content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 5, output_tokens: 3 } });
        }
        if (url.includes('api.deepseek.com')) return deepseekOk('{"ok":true}');
        throw new Error(`Unexpected provider call: ${url}`);
      });
      const result = await chatCompletion({ system: 'json', messages: [{ role: 'user', content: 'hi' }], purpose: 'intent_classify' });
      check(result.ok === true && anthropicCalls === 1, 'within-budget premium routing is unaffected');
    });
  } finally {
    setBudgetGuard(previousGuard);
    setFetchHandler(null);
    setAiUsageSink(sinkBeforeBudget);
    resetProviderBreakers();
  }

  console.log('\n--- Test 8: budget status + alert state machine (offline) ---');
  await withEnvAsync({ AI_DAILY_BUDGET_USD: '0.10', AI_BUDGET_ALERT_PCT: '80' }, async () => {
    check(getAiDailyBudgetUsd() === 0.10, 'budget env is read dynamically');
    const within = computeAiBudgetStatus({ approxCostUsd: 0.09, unpricedTokens: 0 });
    check(within.enabled === true && within.overBudget === false && Math.abs(within.pct - 0.9) < 1e-9, '90% of budget is within the cap');
    const over = computeAiBudgetStatus({ approxCostUsd: 0.12, unpricedTokens: 0 });
    check(over.overBudget === true, 'spend at/above the cap is flagged');

    const config = new Map();
    const audit = [];
    const rows = [{
      id: 'r1', tier: 1, provider: 'deepseek', model: 'deepseek-chat', purpose: 'extraction',
      latency_ms: 100, ok: true, prompt_tokens: 1000000, completion_tokens: 0,
      attempts: [{ provider: 'deepseek', outcome: 'ok' }]
    }];
    const fake = makeBudgetSupabase({ rows, config, audit });
    const status = await checkAiDailyBudget(fake);
    check(status.enabled === true && status.overBudget === true, 'checkAiDailyBudget uses the summary cost');

    const sent = [];
    const senders = {
      whatsapp: async () => { sent.push('whatsapp'); return true; },
      email: async () => { sent.push('email'); return true; }
    };
    const first = await maybeSendAiBudgetAlert(fake, { senders });
    check(first.status === 'success' && first.threshold === 100, '100% threshold alerts');
    check(sent.length === 2, 'both notification channels are attempted');
    check([...config.keys()].some((key) => key.startsWith('ai_budget_alert_100_')), 'dedupe key is persisted');
    check(audit.some((row) => row.action === 'AI_BUDGET_ALERT'), 'alert is audit-logged');
    const second = await maybeSendAiBudgetAlert(fake, { senders });
    check(second.status === 'skipped' && sent.length === 2, 'second alert is deduped for the day');

    const lowRows = [{
      id: 'r2', tier: 1, provider: 'deepseek', model: 'deepseek-chat', purpose: 'extraction',
      latency_ms: 100, ok: true, prompt_tokens: 333333, completion_tokens: 0, attempts: []
    }];
    const lowFake = makeBudgetSupabase({ rows: lowRows, config: new Map(), audit: [] });
    const low = await maybeSendAiBudgetAlert(lowFake, { senders: { whatsapp: async () => true, email: async () => true } });
    check(low.status === 'success' && low.threshold === 80, '80% threshold alerts first');
  });
  await withEnvAsync({ AI_DAILY_BUDGET_USD: undefined }, async () => {
    const fake = makeBudgetSupabase({ rows: [], config: new Map(), audit: [] });
    const disabled = await maybeSendAiBudgetAlert(fake, { dryRun: true });
    check(disabled.status === 'skipped' && /disabled/i.test(disabled.reason), 'disabled guard skips alerts');
  });

  console.log('\n--- Test 9: digest surfaces fallbacks + budget ---');
  await withEnvAsync({ AI_DAILY_BUDGET_USD: '1' }, async () => {
    const summary = {
      ok: true, hours: 24, totalRequests: 2, okRequests: 2, errorRequests: 0, fallbacks: 1,
      successRate: 1, errorRate: 0, avgLatencyMs: 100, p50LatencyMs: 90,
      promptTokens: 10, completionTokens: 5, totalTokens: 15,
      approxCostUsd: 0.9, unpricedTokens: 0, truncated: false,
      byTier: {}, byProvider: {}, byPurpose: {}
    };
    const reply = formatAiStatsReply(summary, computeAiBudgetStatus(summary));
    check(reply.includes('Fallbacks: 1'), 'digest shows the fallback count');
    check(reply.includes('Budget:') && reply.includes('90.0%'), 'digest shows the budget percentage');
  });

  console.log('\n--- Test 10: attempts persist + aggregate (DB, self-cleaning) ---');
  if (!supabase) {
    console.log('  ⚠️ Supabase credentials missing — DB assertions skipped.');
  } else {
    const purpose = 'phase3_resilience_test';
    try {
      const tableStatus = await ensureAiUsageLogsTable(supabase);
      check(['exists', 'created'].includes(tableStatus[AI_USAGE_TABLE]), 'ai_usage_logs is available');
      const { error: columnError } = await supabase.from(AI_USAGE_TABLE).select('attempts').limit(1);
      if (columnError) {
        console.log('  ⚠️ attempts column unavailable (no SQL transport) — DB assertions skipped.');
      } else {
        const inserted = await logAiUsage(supabase, {
          purpose, tier: 2, provider: 'deepseek', model: 'deepseek-chat',
          latencyMs: 250, ok: true, inputChars: 10, promptTokens: 100, completionTokens: 20,
          attempts: [
            { provider: 'anthropic', model: 'claude-sonnet-4-5', outcome: 'failed', latencyMs: 120, error: 'Anthropic API 429' },
            { provider: 'deepseek', model: 'deepseek-chat', outcome: 'ok', latencyMs: 130, error: null }
          ]
        });
        check(inserted === true, 'telemetry row with attempts inserted');
        await new Promise((resolve) => setTimeout(resolve, 400));
        const summary = await getAiUsageSummary(supabase, 1);
        check(summary.ok === true && summary.fallbacks >= 1, 'fallback count aggregates from attempts');
        const { data } = await supabase.from(AI_USAGE_TABLE).select('attempts').eq('purpose', purpose).limit(1);
        check(Array.isArray(data?.[0]?.attempts) && data[0].attempts.length === 2, 'attempts jsonb round-trips');
      }
    } finally {
      await supabase.from(AI_USAGE_TABLE).delete().eq('purpose', purpose);
      const { data } = await supabase.from(AI_USAGE_TABLE).select('id').eq('purpose', purpose);
      check((data || []).length === 0, 'phase-3 telemetry rows were cleaned up');
    }
  }

  console.log(`\n=== ALL ${passed} PHASE 3 RESILIENCE ASSERTIONS PASSED ===`);
}

runWithCleanup({ testFn: runTests })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Phase 3 resilience tests failed:', err.message);
    process.exit(1);
  });
