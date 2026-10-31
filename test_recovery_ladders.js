/**
 * Saka Fleet — Recovery ladders & country comm styles (v1.28.8)
 * ------------------------------------------------------------
 * Offline (mock Supabase). Guards the abandoned-checkout ladder
 * (T+30 min / T+24 h / coupon T-2d, max 3), the post-expiry benefit ladder
 * (D+7 / D+30 with the D+15 winback in between), the deterministic copy
 * (local currency, no guilt) and the country style derivation/injection.
 *
 * Run: node test_recovery_ladders.js
 */

import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  abandonedCheckoutText,
  renewalBenefitText,
  resolveAbandonedCheckoutStage,
  resolveRenewalNudgeStage,
  CHECKOUT_REMINDER_MAX,
  RENEWAL_NUDGE_MAX
} from './src/services/trialEngine.js';
import {
  deriveCountryCommStyles,
  upsertCountryCommStyles,
  getCountryCommStyleLine
} from './src/services/countryCommStyles.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

const DAY = 24 * 60 * 60 * 1000;

async function run() {
  console.log('=== SAKA FLEET — RECOVERY LADDERS & COUNTRY STYLES (v1.28.8) ===\n');

  console.log('--- Test 1: abandoned-checkout stage ladder ---');
  check(resolveAbandonedCheckoutStage({ reminderCount: 0, elapsedMs: 5 * 60 * 1000 }) === null, 'No nudge inside the first 5 minutes');
  check(resolveAbandonedCheckoutStage({ reminderCount: 0, elapsedMs: 31 * 60 * 1000 }) === 0, 'T+30 min stage fires');
  check(resolveAbandonedCheckoutStage({ reminderCount: 1, elapsedMs: 23 * 60 * 60 * 1000 }) === null, 'Second stage waits for 24 hours');
  check(resolveAbandonedCheckoutStage({ reminderCount: 1, elapsedMs: 25 * 60 * 60 * 1000 }) === 1, 'T+24 h stage fires');
  check(resolveAbandonedCheckoutStage({ reminderCount: 2, elapsedMs: 3 * DAY, couponLeftMs: 1 * DAY }) === 2, 'Coupon T-2 days stage fires');
  check(resolveAbandonedCheckoutStage({ reminderCount: 2, elapsedMs: 3 * DAY, couponLeftMs: 5 * DAY }) === null, 'No coupon urgency before the T-2 window');
  check(resolveAbandonedCheckoutStage({ reminderCount: CHECKOUT_REMINDER_MAX, elapsedMs: 10 * DAY, couponLeftMs: DAY }) === null, 'Hard cap stops the ladder');

  console.log('\n--- Test 2: abandoned-checkout copy ---');
  const cart0 = abandonedCheckoutText({
    stage: 0, tierLabel: 'Solo Pro', priceLabel: 'KES 1,299/month',
    coupon: { code: 'ACTIVATE20', discount_percent: 20 }, checkoutUrl: 'https://pay.test/abc'
  });
  check(/Still deciding/.test(cart0) && cart0.includes('KES 1,299/month'), 'Stage 0 restates the local price');
  check(cart0.includes('ACTIVATE20') && cart0.includes('https://pay.test/abc'), 'Stage 0 re-sends the same checkout link');
  check(!/\$|USD/.test(cart0), 'No dollar figures in the recovery copy');
  const cart2 = abandonedCheckoutText({
    stage: 2, tierLabel: 'Solo Pro', coupon: { code: 'ACTIVATE20', discount_percent: 20 },
    couponExpiryLabel: '7 Nov 2026', checkoutUrl: 'https://pay.test/abc'
  });
  check(/does not add free days/.test(cart2), 'Coupon urgency says it is a discount, not free days');
  check(cart2.includes('7 Nov 2026'), 'Coupon expiry is stated in the local date format');

  console.log('\n--- Test 3: post-expiry benefit ladder ---');
  check(resolveRenewalNudgeStage({ nudgeCount: 0, daysSince: 6 }) === null, 'No nudge before D+7');
  check(resolveRenewalNudgeStage({ nudgeCount: 0, daysSince: 7 }) === 0, 'D+7 benefit nudge fires');
  check(resolveRenewalNudgeStage({ nudgeCount: 1, daysSince: 20 }) === null, 'D+15 winback owns the middle (no duplicate nudge)');
  check(resolveRenewalNudgeStage({ nudgeCount: 1, daysSince: 30 }) === 1, 'D+30 data-safe nudge fires');
  check(resolveRenewalNudgeStage({ nudgeCount: RENEWAL_NUDGE_MAX, daysSince: 60 }) === null, 'Renewal ladder is capped');

  const renew0 = renewalBenefitText({ stage: 0, tierLabel: 'Solo Pro', priceLabel: 'KES 1,299/month', annualLabel: 'KES 12,990/year' });
  check(/nothing was deleted/i.test(renew0) && /KES 1,299\/month/.test(renew0), 'D+7 copy is benefit-led and reassures data safety');
  check(/KES 12,990\/year/.test(renew0), 'D+7 copy shows the annual option');
  const renew1 = renewalBenefitText({ stage: 1, tierLabel: 'Solo Pro', priceLabel: 'KES 1,299/month' });
  check(/Your data is safe/i.test(renew1) && /only send this once/i.test(renew1), 'D+30 copy is final and gentle');
  check(!/sorry|failed|guilt/i.test(renew1), 'No guilt language in renewal nudges');

  console.log('\n--- Test 4: country communication style derivation ---');
  const styles = deriveCountryCommStyles([
    { phone_number: '+254700000001', message_text: 'Habari' },
    { phone_number: '+254700000002', message_text: 'Habari yako, please' },
    { phone_number: '+254700000003', message_text: 'Nimefika 🚗' },
    { phone_number: '+12025550123', message_text: 'Hello there, could you kindly help' },
    { phone_number: 'invalid', message_text: 'ignored' }
  ]);
  const ke = styles.find((s) => s.country_code === 'KE');
  const us = styles.find((s) => s.country_code === 'US');
  check(Boolean(ke) && ke.message_count === 3, 'Kenyan messages are grouped under KE');
  check(ke.top_greeting === 'habari', 'Top local greeting is detected');
  check(ke.short_reply_rate >= 0.5, 'Short-reply preference is measured');
  check(/opens with "habari"/.test(ke.notes), 'Style notes describe the greeting');
  check(Boolean(us) && us.formal_rate > 0, 'Formality markers are measured per country');
  check(styles.length === 2, 'Invalid phone numbers never create a style row');

  console.log('\n--- Test 5: style persistence + per-turn injection ---');
  const mock = createMockSupabase({ country_comm_styles: [] });
  const saved = await upsertCountryCommStyles({ supabase: mock.client, styles });
  check(saved.ok && saved.updated === 2, 'Derived styles are persisted per country');
  const line = await getCountryCommStyleLine({ supabase: mock.client, countryCode: 'KE' });
  check(/COUNTRY COMMUNICATION STYLE \(KE/.test(line) && /habari/i.test(line), 'The per-turn prompt line carries the local style');
  const missing = await getCountryCommStyleLine({ supabase: mock.client, countryCode: 'ZZ' });
  check(missing === '', 'Countries without a style add nothing to the prompt');

  console.log(`\n🎉 ${passed} recovery/country-style assertions passed.`);
}

run().catch((err) => {
  console.error('\n❌ Recovery ladder suite failed:', err.message);
  process.exit(1);
});
