import {
  DEEPSEEK_OFF_PEAK_DISCOUNT_FACTOR,
  evaluateDeepSeekOffPeakGate,
  formatEatTime,
  formatOffPeakGateMessage,
  getDeepSeekDiscountFactor,
  getDeepSeekPricingState,
  isChinesePublicHoliday,
  isDeepSeekPeakTime
} from './src/services/deepseekSchedule.js';
import {
  AI_USAGE_TABLE,
  estimateAiUsageCostUsd,
  getAiUsageCostBreakdownUsd,
  getAiUsageSummary
} from './src/services/aiUsageLog.js';

/**
 * Saka Fleet — DeepSeek off-peak scheduling tests (v1.62.0, rule 61).
 * Stateless: zero network, zero DB writes (the summary runs on an in-memory
 * PostgREST double). Boundaries pinned to the official docs:
 * peak = Mon-Fri 01:00-04:00 & 06:00-10:00 UTC, excluding Chinese public holidays.
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

const iso = (value) => new Date(value).toISOString();

async function run() {
  console.log('=== SAKA FLEET — DEEPSEEK OFF-PEAK SCHEDULE TESTS ===\n');

  console.log('--- 1. UTC window boundaries (2026-11-09 is a Monday) ---');
  check(isDeepSeekPeakTime('2026-11-09T00:59:00Z') === false, '00:59 UTC is off-peak (before the first window)');
  check(isDeepSeekPeakTime('2026-11-09T01:00:00Z') === true, '01:00 UTC starts peak');
  check(isDeepSeekPeakTime('2026-11-09T03:59:59Z') === true, '03:59:59 UTC is still peak');
  check(isDeepSeekPeakTime('2026-11-09T04:00:00Z') === false, '04:00 UTC ends the first peak window');
  check(isDeepSeekPeakTime('2026-11-09T05:59:00Z') === false, 'the 04:00-06:00 gap is off-peak');
  check(isDeepSeekPeakTime('2026-11-09T06:00:00Z') === true, '06:00 UTC starts the second peak window');
  check(isDeepSeekPeakTime('2026-11-09T09:59:00Z') === true, '09:59 UTC is still peak');
  check(isDeepSeekPeakTime('2026-11-09T10:00:00Z') === false, '10:00 UTC ends the second peak window');

  console.log('\n--- 2. EAT equivalents (10:00 EAT / 14:00 EAT / Saturday) ---');
  check(isDeepSeekPeakTime('2026-11-09T10:00:00+03:00') === true, '10:00 EAT (07:00 UTC) is peak');
  check(isDeepSeekPeakTime('2026-11-09T14:00:00+03:00') === false, '14:00 EAT (11:00 UTC) is off-peak');
  check(isDeepSeekPeakTime('2026-11-07T08:00:00+03:00') === false, 'Saturday morning is off-peak');
  check(isDeepSeekPeakTime('2026-11-08T11:00:00Z') === false, 'Sunday mid-morning is off-peak');
  check(getDeepSeekPricingState('2026-11-07T02:00:00Z').reason === 'weekend', 'weekend reason is explicit');

  console.log('\n--- 3. Chinese public holidays are off-peak all day ---');
  check(isChinesePublicHoliday('2026-10-01T02:00:00Z') === true, 'National Day (Beijing Oct 1) is a holiday');
  check(isDeepSeekPeakTime('2026-10-01T02:00:00Z') === false, 'a holiday inside a peak window is off-peak');
  check(isChinesePublicHoliday('2025-12-31T20:00:00Z') === true, 'Beijing-date resolution: Dec 31 20:00 UTC is Jan 1 in Beijing');
  check(getDeepSeekPricingState('2026-10-01T02:00:00Z').reason === 'chinese_holiday', 'holiday reason is explicit');
  check(isDeepSeekPeakTime('2026-09-30T02:00:00Z') === true, 'the same window a day earlier is peak');
  const savedHolidays = process.env.DEEPSEEK_CN_HOLIDAYS;
  process.env.DEEPSEEK_CN_HOLIDAYS = '2026-11-09';
  try {
    check(isDeepSeekPeakTime('2026-11-09T02:00:00Z') === false, 'DEEPSEEK_CN_HOLIDAYS override makes a lunar holiday off-peak');
  } finally {
    if (savedHolidays === undefined) delete process.env.DEEPSEEK_CN_HOLIDAYS;
    else process.env.DEEPSEEK_CN_HOLIDAYS = savedHolidays;
  }

  console.log('\n--- 4. next transition math ---');
  check(iso(getDeepSeekPricingState('2026-11-09T02:00:00Z').nextTransition) === iso('2026-11-09T04:00:00Z'), 'peak -> next off-peak is the window end');
  check(iso(getDeepSeekPricingState('2026-11-09T05:00:00Z').nextTransition) === iso('2026-11-09T06:00:00Z'), 'gap -> next peak start');
  check(iso(getDeepSeekPricingState('2026-11-09T11:00:00Z').nextTransition) === iso('2026-11-10T01:00:00Z'), 'weekday afternoon -> next day 01:00 UTC');
  check(iso(getDeepSeekPricingState('2026-11-13T11:00:00Z').nextTransition) === iso('2026-11-16T01:00:00Z'), 'Friday afternoon -> Monday 01:00 UTC (weekend skipped)');
  check(iso(getDeepSeekPricingState('2026-11-07T08:00:00Z').nextTransition) === iso('2026-11-09T01:00:00Z'), 'Saturday -> Monday 01:00 UTC');

  console.log('\n--- 5. gate + force + kill switch ---');
  const blocked = evaluateDeepSeekOffPeakGate({ now: new Date('2026-11-09T02:00:00Z') });
  check(blocked.allowed === false && blocked.reason === 'peak_window', 'peak blocks a batch run');
  check(blocked.message.includes('peak') && blocked.message.includes('EAT'), 'the deferral message is explicit and localised');
  check(blocked.message.includes('--force'), 'the deferral message names the escape hatch');
  check(blocked.message.includes('07:00 EAT'), 'gate copy names the exact next off-peak time in EAT');
  check(evaluateDeepSeekOffPeakGate({ now: new Date('2026-11-09T02:00:00Z'), force: true }).reason === 'forced', '--force overrides the gate');
  check(evaluateDeepSeekOffPeakGate({ now: new Date('2026-11-09T14:00:00Z') }).allowed === true, 'off-peak runs pass');
  const savedGate = process.env.DEEPSEEK_OFF_PEAK_GATE;
  process.env.DEEPSEEK_OFF_PEAK_GATE = 'off';
  try {
    check(evaluateDeepSeekOffPeakGate({ now: new Date('2026-11-09T02:00:00Z') }).reason === 'gate_disabled', 'DEEPSEEK_OFF_PEAK_GATE=off disables the gate');
  } finally {
    if (savedGate === undefined) delete process.env.DEEPSEEK_OFF_PEAK_GATE;
    else process.env.DEEPSEEK_OFF_PEAK_GATE = savedGate;
  }
  check(formatEatTime('2026-11-09T10:00:00Z') === '13:00 EAT', 'EAT formatting (UTC+3)');
  check(formatOffPeakGateMessage(new Date('2026-11-09T02:00:00Z')).includes('Mon 07:00 EAT'), 'the message carries the weekday + EAT time');

  console.log('\n--- 6. discount factor + cost breakdown ---');
  check(DEEPSEEK_OFF_PEAK_DISCOUNT_FACTOR === 0.5, 'official off-peak factor is 0.5');
  check(getDeepSeekDiscountFactor(null) === 1, 'an unknown timestamp is priced gross');
  check(getDeepSeekDiscountFactor('2026-11-09T02:00:00Z') === 1, 'peak timestamps pay list price');
  check(getDeepSeekDiscountFactor('2026-11-09T11:00:00Z') === 0.5, 'off-peak timestamps are half price');
  check(estimateAiUsageCostUsd('deepseek', 'deepseek-chat', 1000000, 0) === 0.30, 'deepseek-chat peak input is $0.30/M');
  check(estimateAiUsageCostUsd('deepseek', 'deepseek-chat', 1000000, 0, '2026-11-09T02:00:00Z') === 0.30, 'peak timestamp keeps the list price');
  check(estimateAiUsageCostUsd('deepseek', 'deepseek-chat', 1000000, 0, '2026-11-09T11:00:00Z') === 0.15, 'off-peak input is half price');
  check(estimateAiUsageCostUsd('deepseek', 'deepseek-reasoner', 1000000, 0, '2026-11-09T11:00:00Z') === 0.66, 'off-peak reasoner input is half of $1.32');
  check(estimateAiUsageCostUsd('anthropic', 'claude-sonnet-4-5', 1000000, 0, '2026-11-09T11:00:00Z') === 2, 'non-DeepSeek providers are never discounted');
  const breakdown = getAiUsageCostBreakdownUsd('deepseek', 'deepseek-chat', 1000000, 0, '2026-11-09T11:00:00Z');
  check(breakdown.offPeak === true && breakdown.discountFactor === 0.5, 'breakdown reports the off-peak factor');
  check(Math.abs(breakdown.grossCostUsd - 0.30) < 1e-9 && Math.abs(breakdown.costUsd - 0.15) < 1e-9, 'breakdown splits gross vs net');

  console.log('\n--- 7. summary integration (in-memory PostgREST double) ---');
  const rows = [
    { id: 'a', tier: 3, provider: 'deepseek', model: 'deepseek-chat', purpose: 'conversation_synth', latency_ms: 900, ok: true, prompt_tokens: 1000000, completion_tokens: 0, created_at: '2026-11-09T02:00:00Z' },
    { id: 'b', tier: 3, provider: 'deepseek', model: 'deepseek-chat', purpose: 'conversation_synth', latency_ms: 900, ok: true, prompt_tokens: 1000000, completion_tokens: 0, created_at: '2026-11-09T11:00:00Z' },
    { id: 'c', tier: 2, provider: 'anthropic', model: 'claude-sonnet-4-5', purpose: 'conversation_eval', latency_ms: 800, ok: true, prompt_tokens: 1000000, completion_tokens: 0, created_at: '2026-11-09T11:00:00Z' }
  ];
  const fake = {
    from(table) {
      if (table !== AI_USAGE_TABLE) throw new Error(`Unexpected table: ${table}`);
      const api = {
        select: () => api,
        gte: () => api,
        order: () => api,
        range: async (from, to) => ({ data: rows.slice(from, to + 1), error: null })
      };
      return api;
    }
  };
  const summary = await getAiUsageSummary(fake, 24);
  check(summary.ok === true, 'summary aggregates with timestamps');
  check(Math.abs(summary.approxCostUsd - 2.45) < 1e-9, 'net cost = 0.30 + 0.15 + 2.00');
  check(Math.abs(summary.approxCostSavedUsd - 0.15) < 1e-9, 'savings = gross 2.60 minus net 2.45');
  check(summary.offPeakTokens === 1000000, 'off-peak tokens are counted');
  check(Math.abs(summary.byPurpose.conversation_synth.approxCostUsd - 0.45) < 1e-9, 'per-purpose buckets carry discounted cost');
  check(Math.abs(summary.byProvider.deepseek.approxCostSavedUsd - 0.15) < 1e-9, 'per-provider buckets carry savings');

  console.log(`\n=== ALL ${passed} DEEPSEEK SCHEDULE ASSERTIONS PASSED ===`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
