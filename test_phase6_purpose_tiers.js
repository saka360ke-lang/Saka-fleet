import dotenv from 'dotenv';
dotenv.config();

import {
  AI_PROVIDERS,
  AI_TIERS,
  AI_PURPOSES,
  DEFAULT_ANTHROPIC_TIER1_MODEL,
  PURPOSE_TIER_OVERRIDES,
  PURPOSE_TIER_OVERRIDE_HONORS_FORCED,
  USER_FACING_PURPOSES,
  resolveTier
} from './src/services/aiClient.js';
import { routerPurposeForCompose } from './src/services/conversationEngine.js';
import { runWithCleanup } from './scripts/testCleanup.js';

/**
 * Saka Fleet — Phase 6 per-purpose tier optimization tests (v1.70.0).
 *
 * Pure routing assertions — ZERO provider calls. Pins the Phase 6 contract:
 * mechanical purposes cap at Tier 1 on paid plans, quality-critical purposes
 * keep the plan tier, the canary's forced verdict still wins for
 * intent_classify, and PREMIUM_MODEL_MODE / PREMIUM_MODEL_ENABLED keep their
 * escape-hatch and kill-switch semantics. Also pins the complaint_recovery
 * compose-purpose remap and its sibling sweep (rule 51).
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

// Paid/live-trial context with the premium tier live: mode defaults to 'all'.
const PAID_ENV = {
  PREMIUM_MODEL_ENABLED: 'on',
  PREMIUM_MODEL_MODE: undefined,
  AI_TIER1_PROVIDER: 'anthropic',
  AI_MODEL_TIER_1_ANTHROPIC: undefined,
  CONVERSATIONAL_PROVIDER: 'anthropic',
  AI_MODEL_TIER_2: 'claude-sonnet-test'
};

async function runTests() {
  console.log('=== SAKA FLEET — PHASE 6 PURPOSE TIER TESTS (v1.70.0) ===\n');

  console.log('--- Test 1: registry shape ---');
  check(Object.isFrozen(PURPOSE_TIER_OVERRIDES), 'the override registry is frozen');
  check(Object.keys(PURPOSE_TIER_OVERRIDES).length === 3, 'exactly three mechanical purposes are capped (A1 eval gate)');
  check(['question_render', 'stall_nudge', 'small_talk']
    .every((purpose) => PURPOSE_TIER_OVERRIDES[purpose] === AI_TIERS.ROUTER), 'every override pins Tier 1');
  check(PURPOSE_TIER_OVERRIDES.intent_classify === undefined, 'intent_classify is parked out of the registry (A1 eval gate)');
  check(PURPOSE_TIER_OVERRIDE_HONORS_FORCED.size === 1
    && PURPOSE_TIER_OVERRIDE_HONORS_FORCED.has('intent_classify'), 'the honor-forced plumbing stays parked for re-enable');
  check(USER_FACING_PURPOSES.has('complaint_recovery'), 'complaint_recovery rides the front provider set');

  console.log('\n--- Test 2: mechanical purposes stay on Haiku for paid plans ---');
  withEnv(PAID_ENV, () => {
    for (const purpose of ['question_render', 'stall_nudge', 'small_talk']) {
      const resolved = resolveTier(purpose, { maxTier: 3 });
      check(resolved.tier === AI_TIERS.ROUTER, `${purpose}: paid plan caps to Tier 1`);
      check(resolved.provider === AI_PROVIDERS.ANTHROPIC, `${purpose}: Tier-1 rides the front Anthropic provider`);
      check(resolved.model === DEFAULT_ANTHROPIC_TIER1_MODEL, `${purpose}: Tier-1 is Haiku (${resolved.model})`);
    }
  });

  console.log('\n--- Test 3: intent_classify keeps the plan floor (override parked by A1) ---');
  withEnv(PAID_ENV, () => {
    const simple = resolveTier('intent_classify', { maxTier: 3, tier: AI_TIERS.ROUTER });
    check(simple.tier === AI_TIERS.CONVERSATIONAL, 'paid plan: the v1.58.24 floor still raises the canary Tier-1 verdict');
    const unforced = resolveTier('intent_classify', { maxTier: 3 });
    check(unforced.tier === AI_TIERS.CONVERSATIONAL, 'paid unforced intent_classify stays on the plan tier');
    const highStakes = resolveTier('intent_classify', { maxTier: 3, tier: AI_TIERS.CONVERSATIONAL });
    check(highStakes.tier === AI_TIERS.CONVERSATIONAL, 'the canary high-stakes verdict keeps Tier 2');
    check(highStakes.provider === AI_PROVIDERS.ANTHROPIC && highStakes.model === 'claude-sonnet-test', 'high-stakes intent_classify is served by Sonnet');
  });

  console.log('\n--- Test 4: quality-critical purposes keep the plan tier ---');
  withEnv(PAID_ENV, () => {
    for (const purpose of ['prose_render', 'complaint_recovery']) {
      const resolved = resolveTier(purpose, { maxTier: 3 });
      check(resolved.tier === AI_TIERS.CONVERSATIONAL, `${purpose}: paid plan keeps Tier 2`);
      check(resolved.model === 'claude-sonnet-test', `${purpose}: Tier 2 is the conversational model`);
    }
    const extraction = resolveTier('extraction', { maxTier: 3, tier: AI_TIERS.ROUTER });
    check(extraction.tier === AI_TIERS.CONVERSATIONAL, 'extraction keeps the plan floor (quality-critical)');
    const adminParse = resolveTier('admin_parse', { maxTier: 3 });
    check(adminParse.tier === AI_TIERS.CONVERSATIONAL, 'admin_parse stays on the plan tier (deliberately uncapped)');
  });

  console.log('\n--- Test 5: background purposes are untouched ---');
  withEnv(PAID_ENV, () => {
    const health = resolveTier('health_synthesis', {});
    check(health.tier === AI_TIERS.REASONING && health.provider === AI_PROVIDERS.DEEPSEEK, 'health_synthesis stays Tier 3 DeepSeek');
    const sentinel = resolveTier('sentinel_diagnosis', { maxTier: 3 });
    check(sentinel.tier === AI_TIERS.REASONING, 'sentinel_diagnosis keeps Tier 3 even with an entitlement cap');
    const bench = resolveTier('model_benchmark', { maxTier: 3 });
    check(bench.tier === AI_TIERS.ROUTER && bench.provider === AI_PROVIDERS.DEEPSEEK, 'model_benchmark stays on the background DeepSeek tier');
  });

  console.log('\n--- Test 6: free plans are unchanged ---');
  withEnv(PAID_ENV, () => {
    for (const purpose of ['question_render', 'intent_classify', 'prose_render', 'complaint_recovery']) {
      check(resolveTier(purpose, { maxTier: 1 }).tier === AI_TIERS.ROUTER, `${purpose}: free clamp stays Tier 1`);
    }
    const freeRecovery = resolveTier('complaint_recovery', { maxTier: 1 });
    check(freeRecovery.provider === AI_PROVIDERS.ANTHROPIC && freeRecovery.model === DEFAULT_ANTHROPIC_TIER1_MODEL, 'free complaint_recovery rides Haiku (front set)');
  });

  console.log('\n--- Test 7: PREMIUM_MODEL_MODE=escalate ignores every override ---');
  withEnv({ ...PAID_ENV, PREMIUM_MODEL_MODE: 'escalate' }, () => {
    const unforced = resolveTier('intent_classify', { maxTier: 3 });
    check(unforced.tier === AI_TIERS.CONVERSATIONAL, 'escalate: intent_classify falls back to its registry default (Tier 2)');
    const forcedRouter = resolveTier('intent_classify', { maxTier: 3, tier: AI_TIERS.ROUTER });
    check(forcedRouter.tier === AI_TIERS.ROUTER, 'escalate: the canary Tier-1 verdict stays Tier 1');
    const question = resolveTier('question_render', { maxTier: 3 });
    check(question.tier === AI_TIERS.ROUTER, 'escalate: question_render keeps the legacy canary tier');
    const prose = resolveTier('prose_render', { maxTier: 3 });
    check(prose.tier === AI_TIERS.CONVERSATIONAL, 'escalate: the legacy canary never lowers quality-critical prose below Tier 2');
  });

  console.log('\n--- Test 8: the premium kill switch still degrades everyone ---');
  withEnv({ ...PAID_ENV, PREMIUM_MODEL_ENABLED: 'off' }, () => {
    for (const purpose of ['prose_render', 'complaint_recovery', 'question_render']) {
      check(resolveTier(purpose, { maxTier: 3 }).tier === AI_TIERS.ROUTER, `premium off: ${purpose} degrades to Tier 1`);
    }
    check(resolveTier('intent_classify', { maxTier: 3, tier: AI_TIERS.CONVERSATIONAL }).tier === AI_TIERS.ROUTER, 'premium off: even a forced Tier-2 classify degrades to Tier 1');
  });

  console.log('\n--- Test 9: compose-purpose mapping (coupling fix + sibling sweep) ---');
  check(routerPurposeForCompose('complaint_recovery') === 'complaint_recovery', 'complaint_recovery maps to its OWN AI purpose');
  check(routerPurposeForCompose('quiz_intro_question') === 'question_render', 'quiz intro stays on question_render');
  check(routerPurposeForCompose('quiz_next_question') === 'question_render', 'quiz steps stay on question_render');
  check(routerPurposeForCompose('conversation_stall_nudge') === 'stall_nudge', 'stall nudge stays on stall_nudge');
  check(routerPurposeForCompose('website_signup_gate_clarify') === 'question_render', 'signup gate clarifier stays mechanical (question_render)');
  check(routerPurposeForCompose('product_answer') === 'prose_render', 'product answers fall through to quality prose');
  check(routerPurposeForCompose('user_data_answer') === 'prose_render', 'user data answers fall through to quality prose');
  check(routerPurposeForCompose('feedback_ack') === 'prose_render', 'feedback acknowledgements fall through to quality prose');

  console.log('\n--- Test 10: the downgrade cannot drag complaint_recovery down ---');
  withEnv(PAID_ENV, () => {
    check(resolveTier('question_render', { maxTier: 3 }).tier === AI_TIERS.ROUTER, 'question_render is capped');
    check(resolveTier('complaint_recovery', { maxTier: 3 }).tier === AI_TIERS.CONVERSATIONAL, 'complaint_recovery stays Tier 2 in the same context');
    check(AI_PURPOSES.complaint_recovery.tier === AI_TIERS.CONVERSATIONAL, 'the registry keeps complaint_recovery at Tier 2 by default');
  });

  console.log(`\n=== ALL ${passed} PHASE 6 ASSERTIONS PASSED ===`);
}

runWithCleanup({ testFn: runTests });
