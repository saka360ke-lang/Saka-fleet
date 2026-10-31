import dotenv from 'dotenv';
dotenv.config();
import { createTestSupabaseClient } from './scripts/testCleanup.js';

const {
  TURN_LATENCY_TABLE,
  TURN_LATENCY_DEFAULT_WINDOW_HOURS,
  TURN_LATENCY_MAX_WINDOW_HOURS,
  TURN_LATENCY_PAGE_SIZE,
  percentile,
  getTurnLatencySummary,
  logTurnLatency,
  ensureTurnLatencyTable
} = await import('./src/services/turnLatency.js');
const {
  formatTurnLatencyReply,
  formatAiStatsReply,
  formatAdminHelpReply,
  handleTurnLatencyCommand,
  parseSuperadminCommand
} = await import('./src/services/superadmin.js');

/**
 * v1.24.1 - Reply-speed telemetry tests.
 * Offline aggregation against an in-memory PostgREST double; the DB round-trip
 * is optional, skipped without credentials and always deletes what it wrote.
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

function makeFakeSupabase(rows, { fail = false } = {}) {
  const calls = { range: 0 };
  return {
    calls,
    from(table) {
      if (table !== TURN_LATENCY_TABLE) throw new Error(`Unexpected table: ${table}`);
      const api = {
        select() { return api; },
        gte() { return api; },
        order() { return api; },
        async range(from, to) {
          calls.range += 1;
          if (fail) return { data: null, error: { message: 'latency offline' } };
          return { data: rows.slice(from, to + 1), error: null };
        }
      };
      return api;
    }
  };
}

const fixtureRows = [
  { id: 't1', turn_ms: 1200, ack_sent: true, phase_ms: { setup: 300, preAi: 100, ai: 700, postAi: 100 } },
  { id: 't2', turn_ms: 800, ack_sent: false },
  { id: 't3', turn_ms: 5000, ack_sent: true, phase_ms: { setup: 500, preAi: 200, ai: 4000, postAi: 300 } },
  { id: 't4', turn_ms: 300, ack_sent: false },
  { id: 't5', turn_ms: 2500, ack_sent: true }
];

async function runTests() {
  console.log('=== REPLY-SPEED TELEMETRY TESTS (v1.24.1) ===\n');

  console.log('--- Test 1: percentile math ---');
  check(percentile([], 50) === null, 'empty sample is null');
  check(percentile([300], 95) === 300, 'single value');
  check(percentile([5, 1, 3], 50) === 3, 'odd sample median');
  check(percentile([1, 2, 3, 4], 50) === 2, 'even sample keeps the lower median');
  check(percentile([1, 2, 3, 4], 100) === 4, 'p100 is the maximum');
  check(percentile([1, 2, 3], 0) === 1, 'p0 is the minimum');

  console.log('\n--- Test 2: aggregation ---');
  const summary = await getTurnLatencySummary(makeFakeSupabase(fixtureRows), 24);
  check(summary.ok === true && summary.error === null, 'summary query succeeds');
  check(summary.turns === 5, 'counts every turn');
  check(summary.avgMs === 1960, 'average latency');
  check(summary.p50Ms === 1200, 'p50 latency');
  check(summary.p95Ms === 5000, 'p95 latency (slow tail)');
  check(summary.p99Ms === 5000, 'p99 latency');
  check(summary.ackTurns === 3 && Math.abs(summary.ackRate - 0.6) < 1e-9, 'instant-ack rate');
  check(summary.avgPhaseMs && summary.avgPhaseMs.setup === 400 && summary.avgPhaseMs.preAi === 150, 'phase averages aggregate the setup and pre-AI stages');
  check(summary.avgPhaseMs.ai === 2350 && summary.avgPhaseMs.postAi === 200, 'phase averages aggregate the AI and post-AI stages');
  check(summary.hours === 24 && summary.since && summary.generatedAt, 'window metadata');

  console.log('\n--- Test 3: window clamping & pagination ---');
  const high = await getTurnLatencySummary(makeFakeSupabase([]), 9999);
  check(high.hours === TURN_LATENCY_MAX_WINDOW_HOURS, 'window clamps upward');
  const low = await getTurnLatencySummary(makeFakeSupabase([]), 0);
  check(low.hours === TURN_LATENCY_DEFAULT_WINDOW_HOURS, 'invalid window falls back to the default');
  const manyRows = Array.from({ length: 1205 }, (_, index) => ({ id: `id-${index}`, turn_ms: 100, ack_sent: false }));
  const paged = makeFakeSupabase(manyRows);
  const pagedSummary = await getTurnLatencySummary(paged, 24);
  check(pagedSummary.turns === 1205, 'all 1205 rows aggregate');
  check(paged.calls.range === Math.ceil(1205 / TURN_LATENCY_PAGE_SIZE), 'page count matches the page size');
  check(pagedSummary.truncated === false, 'complete window is not truncated');



  console.log('\n--- Test 4: fail-soft ---');
  const failed = await getTurnLatencySummary(makeFakeSupabase([], { fail: true }), 6);
  check(failed.ok === false && failed.turns === 0 && /latency offline/.test(failed.error), 'query failure returns ok:false');

  console.log('\n--- Test 5: digest copy ---');
  const fast = formatTurnLatencyReply({ ...summary, p95Ms: 2500, p99Ms: 3000 });
  check(fast.includes('p50') && fast.includes('p95'), 'digest names p50 and p95');
  check(/Healthy: the slow tail stays under 4 seconds/.test(fast), 'fast tail is called healthy');
  const slow = formatTurnLatencyReply(summary);
  check(/two-lane background worker/.test(slow), 'slow tail recommends the two-lane worker');
  check(/Phases \(avg\):/.test(slow) && /pre-AI/.test(slow), 'the digest names the slow phase');
  const empty = formatTurnLatencyReply({ ok: true, hours: 24, turns: 0 });
  check(/No replies measured/.test(empty), 'empty window is reassuring');
  const broken = formatTurnLatencyReply({ ok: false, error: 'db down' });
  check(/Metrics unavailable/.test(broken), 'failure digest is explicit');
  const stats = formatAiStatsReply(
    { ok: true, hours: 24, totalRequests: 1, okRequests: 1, errorRequests: 0, fallbacks: 0, successRate: 1, errorRate: 0, avgLatencyMs: 500, p50LatencyMs: 500, promptTokens: 10, completionTokens: 5, approxCostUsd: 0, unpricedTokens: 0, truncated: false, byTier: {}, byProvider: {}, byPurpose: {} },
    null,
    summary
  );
  check(/Conversation replies: p50 1\.2 s · p95 5\.0 s over 5 turns/.test(stats), 'ai-stats footer carries reply speed');

  console.log('\n--- Test 6: command parsing ---');
  const parsed = await parseSuperadminCommand('admin latency 48h');
  check(parsed.intent === 'ADMIN_TURN_LATENCY' && parsed.hours === 48, 'admin latency 48h parses');
  const parsedDefault = await parseSuperadminCommand('admin reply latency');
  check(parsedDefault.intent === 'ADMIN_TURN_LATENCY' && parsedDefault.hours === 24, 'admin reply latency parses');
  const parsedClamp = await parseSuperadminCommand('admin latency 999h');
  check(parsedClamp.hours === TURN_LATENCY_MAX_WINDOW_HOURS, 'hours clamp to 168');
  const parsedHelp = await parseSuperadminCommand('superadmin commands');
  check(parsedHelp.intent === 'ADMIN_HELP', 'superadmin commands parses deterministically');
  const parsedAdminHelp = await parseSuperadminCommand('admin help');
  check(parsedAdminHelp.intent === 'ADMIN_HELP', 'admin help parses deterministically');
  const helpReply = formatAdminHelpReply();
  check(helpReply.includes('Saka admin commands') && helpReply.includes('admin latency'), 'the help reply lists the command families');

  console.log('\n--- Test 7: DB round-trip (optional, self-cleaning) ---');
  const supabase = createTestSupabaseClient();
  const phone = '+254700000124';
  if (!supabase) {
    console.log('  ⏭️  Skipped (no Supabase credentials).');
  } else {
    try {
      await ensureTurnLatencyTable(supabase);
      const written = await logTurnLatency(supabase, { phone, turnMs: 1234, ackSent: true, phaseMs: { setup: 120, preAi: 30, ai: 900, postAi: 40 } });
      check(written === true, 'turn latency row inserts');
      const live = await getTurnLatencySummary(supabase, 1);
      check(live.turns >= 1, 'live summary sees the row');
      check(live.avgPhaseMs && live.avgPhaseMs.ai >= 900, 'phase breakdown round-trips');
      const digest = await handleTurnLatencyCommand(supabase, 1);
      check(digest.reply.includes('Saka Reply Speed') && digest.details.turns >= 1, 'command handler renders the digest');
    } finally {
      await supabase.from(TURN_LATENCY_TABLE).delete().eq('phone', phone);
    }
  }

  console.log(`\nALL REPLY-SPEED TESTS PASSED (${passed} assertions).`);
}

runTests().catch((err) => {
  console.error('\n❌ TEST FAILURE:', err.message);
  process.exit(1);
});
