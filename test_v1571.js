import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { getEntitlements, invalidateEntitlements } from './src/services/subscriptions.js';
import { classifyIntentWithRegex } from './sakaAi.js';
import { parseRegistrationFieldCorrection, stripFieldNotes, getFlowDefinition } from './src/services/quizEngine.js';
import { reminderTypeMenu, reminderTypeChoices } from './src/services/reminderCatalog.js';

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

const regDef = { fields: [{ key: "make_model" }, { key: "plate_number" }] };
const fc = parseRegistrationFieldCorrection("Make and model: TOYOTA HIACE VAN", regDef);
check(fc && fc.field === "make_model" && fc.value === "TOYOTA HIACE VAN", "a confirm-phase field correction parses to make_model");
const stripped = stripFieldNotes(["Make and model: TOUOTA HIACE VAN", "bought in Mombasa"], "make_model");
check(stripped.length === 1 && stripped[0] === "bought in Mombasa", "a corrected field drops its stale duplicate note");

const remDef = getFlowDefinition("set_reminder", { vehicles: [{ id: "v1", plate_number: "KAS628T" }], countryInfo: { country_code: "KE", locale: "en-KE" }, profile: {} });
const remType = remDef.fields.find((f) => f.key === "reminder_type");
const remChoices = reminderTypeChoices("vehicle").map((c) => c.value);
check(remType.parse("3") === remChoices[2], "a bare number selects the Nth reminder type");
check(remType.parse("99") === null, "an out-of-range number is rejected");
check(reminderTypeMenu("vehicle").includes("1. "), "the reminder menu is numbered");

console.log("ALL v1.57.1 TESTS PASSED (" + passed + " assertions).");