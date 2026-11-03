import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { getEntitlements, invalidateEntitlements } from './src/services/subscriptions.js';
import { classifyIntentWithRegex } from './sakaAi.js';

let passed = 0;
function check(condition, message) { assert(condition, message); passed += 1; console.log("  ok " + message); }
const future = (d) => new Date(Date.now() + d * 86400000).toISOString();

console.log("=== SAKA FLEET - v1.57.1 REGRESSIONS ===");

check(classifyIntentWithRegex("Yes").intent !== "APPLY_COUPON", "a bare Yes is not APPLY_COUPON");
check(classifyIntentWithRegex("yes please").intent !== "APPLY_COUPON", "yes please is not APPLY_COUPON");
check(classifyIntentWithRegex("extend").intent !== "APPLY_COUPON", "a bare extend is not APPLY_COUPON");
check(classifyIntentWithRegex("EXT30-ABC123").intent === "APPLY_COUPON", "an explicit code is APPLY_COUPON");
check(classifyIntentWithRegex("apply coupon").intent === "APPLY_COUPON", "apply coupon is APPLY_COUPON");

invalidateEntitlements();
const trialMock = createMockSupabase({
  profiles: [{ id: "p-trial", phone_number: "+254700000099", email: "x@example.com", full_name: "T", subscription_tier: "free", subscription_status: "TRIALING", trial_used_at: new Date().toISOString(), billing_interval: "monthly", addon_quantity: 0 }],
  trial_sessions: [{ id: "ts1", owner_id: "p-trial", tier: "growth", status: "ACTIVE", source: "welcome", started_at: new Date().toISOString(), ends_at: future(20), activated: false }],
  usage_counters: [],
  vehicles: []
});
const ent = await getEntitlements({ supabase: trialMock.client, ownerId: "p-trial", useCache: false });
check(ent.tierKey === "growth", "TRIALING resolves the tier from the live trial row");
check(ent.isTrial === true, "the account is reported as on trial");
check(ent.effectiveVehicleCapacity >= 3, "a trial user gets multi-vehicle capacity");

console.log("ALL v1.57.1 TESTS PASSED (" + passed + " assertions).");