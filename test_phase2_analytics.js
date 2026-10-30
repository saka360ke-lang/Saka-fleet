import dotenv from 'dotenv';
dotenv.config();
import { createTestSupabaseClient, runWithCleanup } from './scripts/testCleanup.js';

const {
  AI_USAGE_TABLE,
  AI_USAGE_PAGE_SIZE,
  AI_USAGE_DEFAULT_WINDOW_HOURS,
  AI_USAGE_MAX_WINDOW_HOURS,
  getAiUsageSummary,
  estimateAiUsageCostUsd,
  logAiUsage
} = await import('./src/services/aiUsageLog.js');
const { AI_TIERS } = await import('./src/services/aiClient.js');
const { ESCALATION_RULES, classifyIntentTier } = await import('./sakaAi.js');
const {
  parseSuperadminCommand,
  handleAiStatsCommand,
  formatAiStatsReply
} = await import('./src/services/superadmin.js');

/**
 * Saka Fleet — Phase 2 telemetry analytics tests (v1.13.0).
 *
 * ZERO live network calls: aggregation runs against an in-memory PostgREST
 * double and every superadmin parse hits the deterministic regex path with the
 * DeepSeek key removed. DB assertions are skipped when credentials are absent
 * and always delete the rows they create.
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

const supabase = createTestSupabaseClient();

function makeFakeSupabase(rows, { fail = false } = {}) {
  const calls = { range: 0 };
  return {
    calls,
    from(table) {
      if (table !== AI_USAGE_TABLE) throw new Error(`Unexpected table: ${table}`);
      const api = {
        select() { return api; },
        gte() { return api; },
        order() { return api; },
        async range(from, to) {
          calls.range += 1;
          if (fail) return { data: null, error: { message: 'telemetry offline' } };
          return { data: rows.slice(from, to + 1), error: null };
        }
      };
      return api;
    }
  };
}

const fixtureRows = [
  { id: 'r6', tier: 1, provider: 'deepseek', model: 'deepseek-chat', purpose: 'extraction', latency_ms: 300, ok: true, prompt_tokens: 100, completion_tokens: 50 },
  { id: 'r5', tier: 1, provider: 'deepseek', model: 'deepseek-chat', purpose: 'extraction', latency_ms: 500, ok: false, prompt_tokens: null, completion_tokens: null },
  { id: 'r4', tier: 2, provider: 'anthropic', model: 'claude-sonnet-4-5', purpose: 'intent_classify', latency_ms: 2000, ok: true, prompt_tokens: 1000, completion_tokens: 200 },
  { id: 'r3', tier: 2, provider: 'anthropic', model: 'claude-sonnet-4-5', purpose: 'intent_classify', latency_ms: 3000, ok: true, prompt_tokens: 1000, completion_tokens: 200 },
  { id: 'r2', tier: 2, provider: 'deepseek', model: 'deepseek-chat', purpose: 'prose_render', latency_ms: 1000, ok: true, prompt_tokens: 400, completion_tokens: 100 },
  { id: 'r1', tier: null, provider: null, model: null, purpose: null, latency_ms: 100, ok: false, prompt_tokens: null, completion_tokens: null }
];

async function runTests() {
  console.log('=== SAKA FLEET — PHASE 2 TELEMETRY ANALYTICS TESTS ===\n');

  console.log('--- Test 1: approximate pricing rules ---');
  check(estimateAiUsageCostUsd('deepseek', 'deepseek-chat', 1000000, 0) === 0.27, 'deepseek-chat input pricing');
  check(Math.abs(estimateAiUsageCostUsd('anthropic', 'claude-sonnet-4-5', 1000000, 0) - 2) < 1e-9, 'Claude Sonnet input pricing');
  check(Math.abs(estimateAiUsageCostUsd('anthropic', 'claude-haiku-4-5', 0, 1000000) - 0.5) < 1e-9, 'Claude Haiku output pricing');
  check(estimateAiUsageCostUsd('mystery', 'unknown-model', 100, 100) === null, 'unknown provider pricing is null, never guessed');

  console.log('\n--- Test 2: aggregation math (tiers, providers, purposes) ---');
  const summary = await getAiUsageSummary(makeFakeSupabase(fixtureRows), 24);
  check(summary.ok === true && summary.error === null, 'summary query succeeds');
  check(summary.hours === 24 && summary.since && summary.generatedAt, 'window metadata is present');
  check(summary.totalRequests === 6, 'total requests');
  check(summary.okRequests === 4 && summary.errorRequests === 2, 'ok/error split');
  check(Math.abs(summary.errorRate - 2 / 6) < 1e-9, 'error rate');
  check(summary.avgLatencyMs === 1150, 'average latency');
  check(summary.p50LatencyMs === 500, 'lower-median latency');
  check(summary.promptTokens === 2500 && summary.completionTokens === 550 && summary.totalTokens === 3050, 'token totals');
  check(Math.abs(summary.approxCostUsd - 0.0083) < 1e-6, 'approximate cost totals');
  check(summary.byTier['1'].requests === 2 && summary.byTier['2'].requests === 3 && summary.byTier.unknown.requests === 1, 'tier buckets');
  check(summary.byProvider.deepseek.requests === 3 && summary.byProvider.anthropic.requests === 2, 'provider buckets');
  check(summary.byPurpose.intent_classify.requests === 2, 'purpose buckets');
  check(summary.byTier['2'].p50LatencyMs === 2000, 'per-bucket latency');

  console.log('\n--- Test 3: window clamping ---');
  const high = await getAiUsageSummary(makeFakeSupabase([]), 9999);
  check(high.hours === AI_USAGE_MAX_WINDOW_HOURS, `window clamps to ${AI_USAGE_MAX_WINDOW_HOURS}h`);
  const low = await getAiUsageSummary(makeFakeSupabase([]), 0);
  check(low.hours === AI_USAGE_DEFAULT_WINDOW_HOURS, `invalid window falls back to ${AI_USAGE_DEFAULT_WINDOW_HOURS}h`);

  console.log('\n--- Test 4: PostgREST pagination past 1000 rows ---');
  const manyRows = Array.from({ length: 1205 }, (_, index) => ({
    id: `id-${index}`, tier: 1, provider: 'deepseek', model: 'deepseek-chat', purpose: 'extraction',
    latency_ms: 100, ok: true, prompt_tokens: 10, completion_tokens: 5
  }));
  const paged = makeFakeSupabase(manyRows);
  const pagedSummary = await getAiUsageSummary(paged, 24);
  check(pagedSummary.totalRequests === 1205, 'all 1205 rows are aggregated');
  check(paged.calls.range === Math.ceil(1205 / AI_USAGE_PAGE_SIZE), 'page count matches the page size');
  check(pagedSummary.truncated === false, 'complete window is not marked truncated');

  console.log('\n--- Test 5: fail-soft contract ---');
  const failed = await getAiUsageSummary(makeFakeSupabase([], { fail: true }), 6);
  check(failed.ok === false && failed.totalRequests === 0 && /telemetry offline/.test(failed.error), 'query failure returns ok:false with zeroed totals');
  check(failed.byTier && Object.keys(failed.byTier).length === 0, 'failure keeps empty buckets');

  console.log('\n--- Test 6: Superadmin digest (deterministic, no AI) ---');
  const digest = await handleAiStatsCommand(makeFakeSupabase(fixtureRows), 24);
  check(digest.reply.includes('Saka AI Telemetry — Last 24h'), 'digest header');
  check(digest.reply.includes('By Tier') && digest.reply.includes('Tier 2 (conversational)'), 'tier breakdown');
  check(digest.reply.includes('By Provider') && digest.reply.includes('anthropic'), 'provider breakdown');
  check(digest.reply.includes('Top Purposes') && digest.reply.includes('intent_classify'), 'top purposes');
  check(digest.reply.includes('Est. cost:'), 'cost line');
  check(digest.details.total_requests === 6 && digest.details.error_requests === 2, 'audit details carry totals');
  check(digest.details.approx_cost_usd > 0, 'audit details carry approximate cost');
  const emptyDigest = formatAiStatsReply(await getAiUsageSummary(makeFakeSupabase([]), 24));
  check(emptyDigest.includes('No AI calls'), 'empty window digest');
  const failureDigest = formatAiStatsReply(await getAiUsageSummary(makeFakeSupabase([], { fail: true }), 24));
  check(failureDigest.includes('Telemetry unavailable'), 'failure digest');

  console.log('\n--- Test 7: escalation precision matrix (Phase 2 tuning) ---');
  check(ESCALATION_RULES.longTurnChars === 160 && ESCALATION_RULES.minFactDigits === 3 && ESCALATION_RULES.minHistoryTurns === 6, 'exported thresholds');
  check(classifyIntentTier('Hi there') === AI_TIERS.ROUTER, 'greeting stays Tier 1');
  check(classifyIntentTier('What can you do for my fleet?') === AI_TIERS.ROUTER, 'short FAQ stays Tier 1');
  check(classifyIntentTier('please request a report') === AI_TIERS.ROUTER, 'request no longer escalates (precision)');
  check(classifyIntentTier('Log 5 km today') === AI_TIERS.ROUTER, 'single-digit entry stays Tier 1');
  check(classifyIntentTier('I am stuck, the bot is broken again') === AI_TIERS.CONVERSATIONAL, 'frustration escalates');
  check(classifyIntentTier('Please assign driver to +254700000000') === AI_TIERS.CONVERSATIONAL, 'driver handshake escalates');
  check(classifyIntentTier('I want to book a pickup for tomorrow morning') === AI_TIERS.CONVERSATIONAL, 'booking escalates');
  check(classifyIntentTier('Log fuel 3000 at 50350 km') === AI_TIERS.CONVERSATIONAL, 'fact-dense action escalates');
  check(classifyIntentTier('x'.repeat(200)) === AI_TIERS.CONVERSATIONAL, 'long turn escalates');
  const sixTurns = Array.from({ length: 6 }, () => ({ role: 'user', content: 'hello' }));
  check(classifyIntentTier('why is my report missing', sixTurns) === AI_TIERS.CONVERSATIONAL, 'deep-history why-question escalates');
  check(classifyIntentTier('why is my report missing', []) === AI_TIERS.ROUTER, 'why-question without history stays Tier 1');

  console.log('\n--- Test 8: admin ai-stats parsing (offline, regex path) ---');
  const savedKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const plain = await parseSuperadminCommand('admin ai-stats');
    check(plain.intent === 'ADMIN_AI_STATS' && plain.hours === 24, 'default 24h window');
    const custom = await parseSuperadminCommand('admin usage 48h');
    check(custom.intent === 'ADMIN_AI_STATS' && custom.hours === 48, 'custom 48h window');
    const clampedHigh = await parseSuperadminCommand('admin ai usage 999h');
    check(clampedHigh.hours === AI_USAGE_MAX_WINDOW_HOURS, 'upper clamp');
    const clampedLow = await parseSuperadminCommand('admin ai-stats 0h');
    check(clampedLow.hours === 1, 'lower clamp');
    const telemetry = await parseSuperadminCommand('admin ai telemetry');
    check(telemetry.intent === 'ADMIN_AI_STATS', 'telemetry alias');
    const fallthrough = await parseSuperadminCommand('what is my fuel efficiency?');
    check(fallthrough.intent === 'UNKNOWN', 'normal conversation falls through');
  } finally {
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedKey;
  }

  console.log('\n--- Test 9: ai_usage_logs analytics round-trip (DB, self-cleaning) ---');
  if (!supabase) {
    console.log('  ⚠️ Supabase credentials missing — DB assertions skipped.');
  } else {
    const purpose = 'phase2_telemetry_test';
    try {
      await logAiUsage(supabase, { purpose, tier: 1, provider: 'deepseek', model: 'deepseek-chat', latencyMs: 120, ok: true, inputChars: 10, promptTokens: 100, completionTokens: 20 });
      await logAiUsage(supabase, { purpose, tier: 2, provider: 'anthropic', model: 'claude-sonnet-4-5', latencyMs: 2000, ok: false, inputChars: 20, promptTokens: null, completionTokens: null });
      await logAiUsage(supabase, { purpose, tier: 1, provider: 'deepseek', model: 'deepseek-chat', latencyMs: 180, ok: true, inputChars: 15, promptTokens: 50, completionTokens: 10 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const live = await getAiUsageSummary(supabase, 1);
      check(live.ok === true, 'live summary query succeeds');
      const bucket = live.byPurpose[purpose];
      check(bucket && bucket.requests >= 3, 'test rows are aggregated by purpose');
      check(bucket.promptTokens >= 150 && bucket.completionTokens >= 30, 'token totals aggregate');
      check(bucket.errors >= 1, 'error rows aggregate');
      check(bucket.approxCostUsd > 0, 'approximate cost aggregates');
    } finally {
      await supabase.from(AI_USAGE_TABLE).delete().eq('purpose', purpose);
      const { data } = await supabase.from(AI_USAGE_TABLE).select('id').eq('purpose', purpose);
      check((data || []).length === 0, 'phase-2 telemetry rows were cleaned up');
    }
  }

  console.log(`\n=== ALL ${passed} PHASE 2 ANALYTICS ASSERTIONS PASSED ===`);
}

runWithCleanup({ testFn: runTests })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Phase 2 analytics tests failed:', err.message);
    process.exit(1);
  });
