import { countryCodeForPhone, deriveCountryLearnings } from "./src/services/countryLearnings.js";

let passed = 0;
function check(cond, label) {
  if (!cond) throw new Error("FAIL: " + label);
  passed += 1;
  console.log("  ok " + label);
}

console.log("=== SAKA FLEET - COUNTRY LEARNINGS TESTS (v1.57.0) ===");

check(countryCodeForPhone("+254734852529") === "KE", "a Kenyan number buckets to KE");
check(countryCodeForPhone("+393331234567") === "IT", "an Italian number buckets to IT");
check(countryCodeForPhone("+256771234567") === "UG", "a Ugandan number buckets to UG");
check(countryCodeForPhone("") === "GLOBAL", "an unknown number falls back to GLOBAL");

const rows = deriveCountryLearnings([
  { phone_number: "+256771112222", message_text: "Hi" },
  { phone_number: "+256771112223", message_text: "Hi there" },
  { phone_number: "+393331112222", message_text: "Ciao" },
  { phone_number: "+393331112223", message_text: "Ciao bella" }
]);
const ug = rows.find((r) => r.country_code === "UG");
const it = rows.find((r) => r.country_code === "IT");
check(Boolean(ug), "Uganda gets its own learning bucket");
check(Boolean(it), "Italy gets its own learning bucket");
check(ug && it && ug.learnings !== it.learnings, "Ugandan and Italian lessons are separate");
check(ug ? !/ciao/i.test(ug.learnings) : false, "an Italian greeting never leaks into the Ugandan bucket");
check(it ? /ciao/i.test(it.learnings) : false, "the Italian bucket learns the local greeting");

console.log("ALL COUNTRY-LEARNINGS TESTS PASSED (" + passed + " assertions).");