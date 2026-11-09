import assert from 'assert';
import {
  COUNTRY_STT_LOCALES,
  REGIONS,
  EXTRA_REGIONS,
  planSttLocaleBackfill
} from './src/services/globalization.js';

/**
 * Saka Fleet — STT locale map + backfill planner (v1.89.0, Phase 27C)
 * ------------------------------------------------------------------
 * Pure and stateless: proves the bundled per-country languages, the GLOBAL
 * fallback and that the country_kb backfill is idempotent and never overwrites
 * an existing (superadmin-edited) row.
 *
 * Run: node test_stt_locales.js
 */

let passed = 0;
function check(condition, label) {
  if (!condition) throw new Error(`❌ ${label}`);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

console.log('=== SAKA FLEET — STT LOCALES (v1.89.0) ===\n');

console.log('--- Test 1: the bundled map (rule 7) ---');
check(COUNTRY_STT_LOCALES.KE.primary === 'sw-KE' && COUNTRY_STT_LOCALES.KE.alternates.join(',') === 'en-KE,en-US', 'Kenya: sw-KE + en-KE/en-US');
check(COUNTRY_STT_LOCALES.TZ.primary === 'sw-TZ', 'Tanzania leads with sw-TZ');
check(COUNTRY_STT_LOCALES.UG.primary === 'sw-UG', 'Uganda leads with sw-UG');
check(COUNTRY_STT_LOCALES.RW.primary === 'rw-RW' && COUNTRY_STT_LOCALES.RW.alternates.includes('fr-FR'), 'Rwanda: rw-RW + French alternate');
check(COUNTRY_STT_LOCALES.FR.primary === 'fr-FR' && COUNTRY_STT_LOCALES.DE.primary === 'de-DE', 'France and Germany lead with their own language');
check(COUNTRY_STT_LOCALES.ES.primary === 'es-ES' && COUNTRY_STT_LOCALES.BE.primary === 'nl-BE', 'Spain and Belgium lead with their own language');
check(COUNTRY_STT_LOCALES.GLOBAL.primary === 'en-US' && COUNTRY_STT_LOCALES.GLOBAL.alternates.join(',') === 'sw-KE', 'GLOBAL falls back to en-US + sw-KE');
check(Object.values(COUNTRY_STT_LOCALES).every((entry) => entry.primary && Array.isArray(entry.alternates)), 'every entry carries a primary + alternates array');

console.log('\n--- Test 2: every REGIONS/EXTRA country is covered ---');
for (const region of [...REGIONS, ...EXTRA_REGIONS]) {
  check(Boolean(COUNTRY_STT_LOCALES[region.country_code]), `${region.country_code} has a speech locale`);
}

console.log('\n--- Test 3: the backfill planner is complete + idempotent ---');
const firstPlan = planSttLocaleBackfill([]);
check(firstPlan.length === Object.keys(COUNTRY_STT_LOCALES).length, 'an empty table plans one row per mapped country');
const keRow = firstPlan.find((row) => row.country_code === 'KE');
check(keRow && keRow.category === 'stt_locale' && keRow.rule_key === 'stt_locale' && keRow.stt_locale === 'sw-KE' && keRow.is_active === true, 'the plan row carries category/rule_key/stt_locale/is_active');
check(firstPlan.every((row) => row.required === false && row.curated_by === 'bundled'), 'backfilled rows are optional and bundled-curated');
const secondPlan = planSttLocaleBackfill(firstPlan);
check(secondPlan.length === 0, 're-planning against its own output writes nothing (idempotent)');
const partial = planSttLocaleBackfill([
  { country_code: 'KE', category: 'stt_locale', is_active: true, stt_locale: 'en-KE' },
  { country_code: 'DE', category: 'stt_locale', is_active: false, stt_locale: 'de-DE' }
]);
check(!partial.some((row) => row.country_code === 'KE'), 'an existing active row is never overwritten (superadmin edits win)');
check(partial.some((row) => row.country_code === 'DE'), 'an inactive row is re-planned (the locale comes back)');
check(!partial.some((row) => row.category !== 'stt_locale'), 'unrelated country_kb rows never enter the plan');

console.log(`\n🎉 ALL STT LOCALE TESTS PASSED (${passed} assertions).`);
console.log('Stateless suite: pure planning only; nothing was written.');
