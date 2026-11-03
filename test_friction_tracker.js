import {
  FRICTION_STATUS,
  FRICTION_CLEARED_AFTER_HOURS,
  normalizeFrictionPhone,
  isFrictionDeployedCleared,
  activeFrictionOf,
  formatFrictionReply
} from "./src/services/frictionTracker.js";

let passed = 0;
function check(cond, label) {
  if (!cond) throw new Error("FAIL: " + label);
  passed += 1;
  console.log("  ok " + label);
}

console.log("=== SAKA FLEET - FRICTION-POINT TRACKER TESTS (v1.56.4) ===");

check(FRICTION_CLEARED_AFTER_HOURS === 4, "deployed points clear after 4 hours");
check(normalizeFrictionPhone("254734852529") === "+254734852529", "bare phone is normalised to E.164");
check(normalizeFrictionPhone("+254734852529") === "+254734852529", "already-E.164 phone is stable");

const now = new Date("2026-11-03T20:00:00Z");
check(isFrictionDeployedCleared({ status: "DEPLOYED", resolved_at: "2026-11-03T15:00:00Z" }, now) === true, "a 5-hour-old deployed point is cleared");
check(isFrictionDeployedCleared({ status: "DEPLOYED", resolved_at: "2026-11-03T18:00:00Z" }, now) === false, "a 2-hour-old deployed point is still active");
check(isFrictionDeployedCleared({ status: "PENDING" }, now) === false, "a pending point is never cleared");

const rows = [
  { id: "aaaa1111", status: "PENDING", friction_type: "USER_FRUSTRATION", user_phone: "+254734852529" },
  { id: "bbbb2222", status: "DEPLOYED", resolved_at: "2026-11-03T18:00:00Z", friction_type: "LOOPING_PROMPTS", user_phone: "+254734852529" },
  { id: "cccc3333", status: "DEPLOYED", resolved_at: "2026-11-03T15:00:00Z", friction_type: "CONVERSATION_STALL", user_phone: "+254734852529" }
];
check(activeFrictionOf(rows, now).length === 2, "active list drops the cleared deployed point");
check(activeFrictionOf(rows, now).some((r) => r.id === "cccc3333") === false, "cleared point is absent from active");

const activeReply = formatFrictionReply(rows, "active", now);
check(activeReply.includes("USER_FRUSTRATION") && activeReply.includes("LOOPING_PROMPTS") && !activeReply.includes("CONVERSATION_STALL"), "active reply lists pending + recent deployed, not cleared");
const logReply = formatFrictionReply(rows, "log", now);
check(logReply.includes("CONVERSATION_STALL"), "the log keeps cleared points forever");

console.log("ALL FRICTION-TRACKER TESTS PASSED (" + passed + " assertions).");