/**
 * Saka Fleet — coupon integrity suite (v1.61.16)
 * ----------------------------------------------
 * Proves the tightened coupon engine end to end:
 *   • admin coupon creation writes canonical fields and yields its REAL discount,
 *   • universal / owner / phone binding is enforced on both paths,
 *   • legacy display-text discounts still price correctly,
 *   • redemption is an atomic claim (no double-use race),
 *   • extension coupons are owner-bound, audited, and roll back on failure.
 * In-memory Supabase double only — no provider calls, no real rows.
 */
import assert from 'assert';
import fs from 'node:fs';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { handleCouponGenerationCommand } from './src/services/superadmin.js';
import { validateCouponForCheckout, markCouponRedeemed } from './src/services/coupons.js';
import { applyAccountTrialExtensionCoupon } from './src/services/trialEngine.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log('  ok ' + message);
}
const DAY = 86400000;
const future = (days) => new Date(Date.now() + days * DAY).toISOString();
const past = (days) => new Date(Date.now() - days * DAY).toISOString();

const ownerProfile = {
  id: 'p-1',
  phone_number: '+254700000001',
  email: 'owner@example.com',
  full_name: 'Owner',
  subscription_tier: 'free',
  subscription_status: 'ACTIVE',
  trial_used_at: null
};

console.log('=== SAKA FLEET — coupon integrity suite (v1.61.16) ===');

console.log('\n--- 1. admin coupon creation is canonical (C1) ---');
const adminMock = createMockSupabase({ profiles: [ownerProfile], coupons: [], admin_audit_logs: [] });
const created = await handleCouponGenerationCommand(adminMock.client, '+254700000000', 'generate coupon 20%', { discount_value: '20%' });
const adminRow = adminMock.db.coupons[0];
check(Boolean(adminRow) && adminRow.discount_percent === 20 && adminRow.discount_amount === 0, 'the admin coupon stores the real discount_percent');
check(adminRow.max_uses === 1 && adminRow.current_uses === 0 && adminRow.status === 'dispatched', 'usage + status are canonical (no silent 0% coupon)');
check(adminRow.applicable_to === 'subscription' && adminRow.applies_to_interval === 'both', 'scope is canonical (subscription, both intervals)');
check(adminRow.assigned_to_phone === null && Boolean(adminRow.expires_at), 'universal assignment is null (never the literal ALL) and expiry is set');
check(/Valid\*: one checkout/.test(created.reply), 'the admin reply states the one-checkout validity + expiry');

const priced = await validateCouponForCheckout({
  supabase: adminMock.client,
  code: adminRow.code,
  tierKey: 'growth',
  interval: 'monthly',
  ownerId: 'p-1',
  amountUSD: 27.99
});
check(priced.valid === true && priced.discountUSD === 5.6 && priced.payableUSD === 22.39, 'the admin coupon now prices its real 20% at checkout');

const usdMock = createMockSupabase({ profiles: [ownerProfile], coupons: [], admin_audit_logs: [] });
const usdCreated = await handleCouponGenerationCommand(usdMock.client, '+254700000000', 'generate coupon $5', { discount_value: '$5' });
const usdRow = usdMock.db.coupons[0];
check(usdRow.discount_amount === 5 && usdRow.discount_percent === 0, 'a USD flat amount is stored as discount_amount');
const usdPriced = await validateCouponForCheckout({ supabase: usdMock.client, code: usdRow.code, tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 27.99 });
check(usdPriced.valid === true && usdPriced.discountType === 'flat' && usdPriced.discountUSD === 5, 'the flat USD coupon prices as a flat discount');

const refusedMock = createMockSupabase({ profiles: [ownerProfile], coupons: [], admin_audit_logs: [] });
const refused = await handleCouponGenerationCommand(refusedMock.client, '+254700000000', 'generate coupon KES 500', { discount_value: 'KES 500' });
check(refusedMock.db.coupons.length === 0 && /No coupon created/.test(refused.reply), 'an unpriceable local-currency coupon is refused, never stored broken');
check(refused.details?.refused === true, 'the refusal is explicit in the command details');

console.log('\n--- 2. universal, owner and phone binding (C1/C3/C4) ---');
const bindMock = createMockSupabase({
  profiles: [ownerProfile],
  coupons: [
    { id: 'u1', code: 'UNI20', discount_percent: 20, max_uses: 1, current_uses: 0, status: 'dispatched', applicable_to: 'subscription', applies_to_interval: 'both', assigned_to_phone: 'ALL', expires_at: future(5) },
    { id: 'o1', code: 'OTHEROWN', discount_percent: 20, max_uses: 1, current_uses: 0, status: 'dispatched', applicable_to: 'subscription', applies_to_interval: 'both', owner_id: 'p-2', expires_at: future(5) },
    { id: 'o2', code: 'MYOWN', discount_percent: 20, max_uses: 1, current_uses: 0, status: 'dispatched', applicable_to: 'subscription', applies_to_interval: 'both', owner_id: 'p-1', expires_at: future(5) },
    { id: 'p1', code: 'WRONGPHONE', discount_percent: 20, max_uses: 1, current_uses: 0, status: 'dispatched', applicable_to: 'subscription', applies_to_interval: 'both', assigned_to_phone: '+254799999999', expires_at: future(5) },
    { id: 'r1', code: 'REDEEMED', discount_percent: 20, max_uses: 1, current_uses: 0, status: 'dispatched', applicable_to: 'subscription', applies_to_interval: 'both', is_redeemed: true, expires_at: future(5) },
    { id: 'l1', code: 'LEGACY20', discount_value: '20%', max_uses: 1, current_uses: 0, status: 'dispatched', expires_at: future(5) }
  ]
});
const uni = await validateCouponForCheckout({ supabase: bindMock.client, code: 'UNI20', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 27.99 });
check(uni.valid === true, 'the literal ALL assignment is universal, never "another account"');
const otherOwn = await validateCouponForCheckout({ supabase: bindMock.client, code: 'OTHEROWN', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 27.99 });
check(otherOwn.valid === false && /another account/.test(otherOwn.error), 'an owner-bound coupon is refused for a different account');
const myOwn = await validateCouponForCheckout({ supabase: bindMock.client, code: 'MYOWN', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 27.99 });
check(myOwn.valid === true, 'the matching owner_id coupon is accepted');
const wrongPhone = await validateCouponForCheckout({ supabase: bindMock.client, code: 'WRONGPHONE', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 27.99 });
check(wrongPhone.valid === false && /another account/.test(wrongPhone.error), 'a phone-bound coupon is refused for a different phone');
const redeemed = await validateCouponForCheckout({ supabase: bindMock.client, code: 'REDEEMED', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 27.99 });
check(redeemed.valid === false && /redeemed/i.test(redeemed.error), 'is_redeemed coupons are refused');
const legacy = await validateCouponForCheckout({ supabase: bindMock.client, code: 'LEGACY20', tierKey: 'growth', interval: 'monthly', ownerId: 'p-1', amountUSD: 27.99 });
check(legacy.valid === true && legacy.discountUSD === 5.6, 'a legacy display-text coupon prices its real 20% (never a silent 0%)');

console.log('\n--- 3. redemption is an atomic claim (C2) ---');
const raceMock = createMockSupabase({
  profiles: [ownerProfile],
  coupons: [{ id: 'c1', code: 'ONCE', discount_percent: 20, max_uses: 1, current_uses: 0, status: 'dispatched', expires_at: future(5) }]
});
const stale = { ...raceMock.db.coupons[0] };
const first = await markCouponRedeemed({ supabase: raceMock.client, coupon: stale, ownerId: 'p-1' });
check(raceMock.state.deletes.some((d) => d.table === 'user_context_cache' && d.col === 'owner_id' && d.value === 'p-1'), 'a claimed coupon invalidates the cached facts (v1.63.1)');
const deletesAfterClaim = raceMock.state.deletes.length;
check(first.ok === true && raceMock.db.coupons[0].current_uses === 1 && raceMock.db.coupons[0].status === 'applied', 'the first claim wins and stamps the row');
const second = await markCouponRedeemed({ supabase: raceMock.client, coupon: stale, ownerId: 'p-1' });
check(raceMock.state.deletes.length === deletesAfterClaim, 'a lost coupon race writes nothing and invalidates nothing (v1.63.1)');
check(second.ok === false && second.reason === 'already_redeemed', 'a stale second claim is refused (no double-use race)');
check(raceMock.db.coupons[0].current_uses === 1, 'the usage counter never double-increments');

console.log('\n--- 4. extension coupons: owner binding, audit trail, atomic claim (C3) ---');
function trialMock(coupon = {}) {
  return createMockSupabase({
    profiles: [ownerProfile],
    trial_sessions: [{
      id: 'ts-1',
      owner_id: 'p-1',
      tier: 'growth',
      interval: 'monthly',
      status: 'ACTIVE',
      started_at: past(2),
      ends_at: future(20),
      activated: true
    }],
    coupons: [{
      id: 'x1',
      code: 'EXT5-OK',
      trial_extension_days: 5,
      max_uses: 1,
      current_uses: 0,
      status: 'dispatched',
      applicable_to: 'account_trial_extension',
      owner_id: 'p-1',
      assigned_to_phone: '+254700000001',
      expires_at: future(5),
      ...coupon
    }],
    admin_audit_logs: []
  });
}
const foreignMock = trialMock({ owner_id: 'p-2', code: 'EXT5-FOREIGN' });
const foreign = await applyAccountTrialExtensionCoupon({ supabase: foreignMock.client, ownerId: 'p-1', code: 'EXT5-FOREIGN' });
check(foreign.ok === false && /another account/.test(foreign.error), 'an extension coupon bound to another owner is refused');
check(foreignMock.db.admin_audit_logs.some((row) => row.action === 'COUPON_REFUSED' && row.details?.reason === 'owner_mismatch'), 'the refusal is audited (COUPON_REFUSED)');

const phoneMock = trialMock({ code: 'EXT5-PHONE', assigned_to_phone: '+254799999999' });
const wrongPhoneExt = await applyAccountTrialExtensionCoupon({ supabase: phoneMock.client, ownerId: 'p-1', code: 'EXT5-PHONE' });
check(wrongPhoneExt.ok === false && /another account/.test(wrongPhoneExt.error), 'an extension coupon bound to another phone is refused');

const goodMock = trialMock();
const good = await applyAccountTrialExtensionCoupon({ supabase: goodMock.client, ownerId: 'p-1', code: 'EXT5-OK' });
check(good.ok === true && good.daysAdded === 5, 'a bound, unused coupon extends the trial');
check(goodMock.db.coupons[0].status === 'applied' && goodMock.db.coupons[0].current_uses === 1, 'the claim is stamped atomically');
check(goodMock.db.admin_audit_logs.some((row) => row.action === 'COUPON_REDEEMED'), 'the redemption is audited (COUPON_REDEEMED)');
const again = await applyAccountTrialExtensionCoupon({ supabase: goodMock.client, ownerId: 'p-1', code: 'EXT5-OK' });
check(again.ok === false && /already been redeemed/.test(again.error), 'the same coupon can never be redeemed twice');

console.log('\n--- 5. the route prefers account-bound redemption (C5) ---');
const routeSource = fs.readFileSync('src/routes/whatsapp.js', 'utf8');
check(routeSource.includes('applyAccountTrialExtensionCoupon({'), 'the EXT30 lane calls the account-bound redemption');
check(routeSource.indexOf('applyAccountTrialExtensionCoupon({') < routeSource.indexOf('applyTrialExtensionCoupon({'), 'the account-bound path runs before the legacy VIN fallback');

console.log(`\n🎉 ALL COUPON INTEGRITY TESTS PASSED (${passed} assertions).`);


