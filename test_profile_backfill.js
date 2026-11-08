import fs from 'node:fs';
import { REGIONS, resolveTimezoneFromCountry } from './src/services/globalization.js';
import {
  PROFILE_CONTEXT_RECONCILED_ACTION,
  maskReconcilePhone,
  resolveProfileContextDefaults,
  buildProfileContextPatch,
  reconcileProfileContexts
} from './scripts/reconcile_profiles.js';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { runWithCleanup } from './scripts/testCleanup.js';

/**
 * Saka Fleet — legacy profile backfill tests (v1.78.0, Phase 17, section 206).
 * ---------------------------------------------------------------------------
 * Pins the COALESCE contract of `npm run reconcile:profiles`:
 *  - country-resolved defaults come from the SAME REGIONS/tz data the app uses;
 *  - an explicit country_code (a user choice) wins over phone detection;
 *  - only NULL columns are patched (a stored value always wins, idempotent);
 *  - `timezone_confirmed_at` / `trial_used_at` are never touched;
 *  - every write is audited PROFILE_CONTEXT_RECONCILED with a masked phone.
 */

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

async function runTests() {
  console.log('=== SAKA FLEET — LEGACY PROFILE BACKFILL TESTS (v1.78.0) ===\n');

  console.log('--- Test 1: REGIONS-driven defaults ---');
  const ke = resolveProfileContextDefaults({ phone_number: '+254712345678' });
  check(ke.timezone === 'Africa/Nairobi' && ke.currency === 'KES' && ke.locale === 'en-KE', 'a Kenyan number resolves KE defaults (Africa/Nairobi, KES, en-KE)');
  const us = resolveProfileContextDefaults({ phone_number: '+14155550123' });
  check(us.timezone === 'America/New_York' && us.currency === 'USD' && us.locale === 'en-US', 'a US number resolves US defaults (America/New_York, USD, en-US)');
  const gb = resolveProfileContextDefaults({ phone_number: '+447700900123' });
  check(gb.timezone === 'Europe/London' && gb.currency === 'GBP' && gb.locale === 'en-GB', 'a UK number resolves GB defaults');
  const globalDefault = resolveProfileContextDefaults({});
  check(globalDefault.timezone === 'Africa/Nairobi' && globalDefault.currency === 'USD' && globalDefault.locale === 'en-US', 'an unresolvable profile falls back to GLOBAL (Africa/Nairobi, USD, en-US)');
  check(REGIONS.every((region) => region.currency && region.locale && resolveTimezoneFromCountry(region.country_code)), 'every REGIONS entry carries currency + locale + an IANA timezone (no drift possible)');

  console.log('\n--- Test 2: an explicit country wins over the phone (user choice respected) ---');
  const uganda = resolveProfileContextDefaults({ phone_number: '+254712345678', country_code: 'UG' });
  check(uganda.timezone === 'Africa/Kampala' && uganda.currency === 'UGX' && uganda.locale === 'en-UG', 'country_code UG on a KE number resolves Uganda (country_source=user is never fought)');

  console.log('\n--- Test 3: COALESCE contract (NULL-only patches) ---');
  const nullRow = buildProfileContextPatch({ phone_number: '+254712345678', country_code: 'KE', timezone: null, currency: null, locale: null });
  check(nullRow.timezone === 'Africa/Nairobi' && nullRow.currency === 'KES' && nullRow.locale === 'en-KE', 'a fully NULL row is patched with all three defaults');
  const partialRow = buildProfileContextPatch({ phone_number: '+254712345678', country_code: 'KE', timezone: 'Europe/Paris', currency: null, locale: null });
  check(partialRow.timezone === undefined && partialRow.currency === 'KES' && partialRow.locale === 'en-KE', 'a stored timezone always wins; only the NULL columns are filled');
  const completeRow = buildProfileContextPatch({ phone_number: '+254712345678', country_code: 'KE', timezone: 'Africa/Nairobi', currency: 'KES', locale: 'en-KE' });
  check(Object.keys(completeRow).length === 0, 'a complete row yields an empty patch (idempotent decision)');
  const lockedKeys = Object.keys(nullRow);
  check(!lockedKeys.includes('timezone_confirmed_at') && !lockedKeys.includes('trial_used_at'), 'the patch never carries timezone_confirmed_at or trial_used_at');
  check(!lockedKeys.includes('country') && !lockedKeys.includes('country_code') && !lockedKeys.includes('country_source'), 'the patch never rewrites country identity (that is reconcile:country work)');

  console.log('\n--- Test 4: masked phones ---');
  check(maskReconcilePhone('+254712345678') === '+2547***678', 'audit phones are masked (+2547***678)');
  check(maskReconcilePhone('123') === '+***', 'a too-short phone is fully masked');

  console.log('\n--- Test 5: live reconciliation against the mock DB ---');
  const mock = createMockSupabase({
    profiles: [
      { id: 'p-legacy', phone_number: '+254712345678', country_code: 'KE', timezone: null, currency: null, locale: null },
      { id: 'p-custom', phone_number: '+14155550123', country_code: 'US', timezone: 'Pacific/Honolulu', currency: null, locale: null },
      { id: 'p-done', phone_number: '+447700900123', country_code: 'GB', timezone: 'Europe/London', currency: 'GBP', locale: 'en-GB' }
    ],
    admin_audit_logs: []
  });
  const first = await reconcileProfileContexts(mock.client, {});
  check(first.ok === true && first.scanned === 3 && first.patched === 2 && first.failed === 0, 'two legacy rows are patched, the complete row is untouched');
  const legacy = mock.db.profiles.find((row) => row.id === 'p-legacy');
  check(legacy.timezone === 'Africa/Nairobi' && legacy.currency === 'KES' && legacy.locale === 'en-KE', 'the NULL row received its country defaults');
  const custom = mock.db.profiles.find((row) => row.id === 'p-custom');
  check(custom.timezone === 'Pacific/Honolulu' && custom.currency === 'USD' && custom.locale === 'en-US', 'the stored custom timezone survived; only currency/locale were filled');
  const done = mock.db.profiles.find((row) => row.id === 'p-done');
  check(done.timezone === 'Europe/London' && done.currency === 'GBP' && done.locale === 'en-GB', 'the complete row is byte-identical after the run');
  check(mock.db.admin_audit_logs.filter((row) => row.action === PROFILE_CONTEXT_RECONCILED_ACTION).length === 2, 'every change wrote one PROFILE_CONTEXT_RECONCILED audit row');
  const audit = mock.db.admin_audit_logs.find((row) => row.details?.profile_id === 'p-legacy');
  check(audit.details.phone === '+2547***678' && audit.details.after.currency === 'KES' && audit.details.before.currency === null, 'the audit carries masked phone + before/after');
  const patchKeys = mock.state.updates
    .filter((entry) => entry.table === 'profiles')
    .flatMap((entry) => Object.keys(entry.patch));
  check(!patchKeys.includes('timezone_confirmed_at') && !patchKeys.includes('trial_used_at'), 'no write ever touched timezone_confirmed_at or trial_used_at');

  console.log('\n--- Test 6: idempotence + dry-run ---');
  const second = await reconcileProfileContexts(mock.client, {});
  check(second.ok === true && second.patched === 0, 'a second run patches nothing (idempotent)');
  const dryMock = createMockSupabase({
    profiles: [{ id: 'p-dry', phone_number: '+254712345678', country_code: 'KE', timezone: null, currency: null, locale: null }],
    admin_audit_logs: []
  });
  const dry = await reconcileProfileContexts(dryMock.client, { dryRun: true });
  check(dry.ok === true && dry.patched === 1 && dry.dryRun === true, 'a dry run reports what it would patch');
  check(dryMock.db.profiles[0].timezone === null && dryMock.db.admin_audit_logs.length === 0, 'a dry run writes NOTHING (no updates, no audits)');

  console.log('\n--- Test 7: wiring ---');
  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  check(pkg.scripts['reconcile:profiles'] === 'node scripts/reconcile_profiles.js', 'package.json exposes npm run reconcile:profiles');
  const scriptSrc = fs.readFileSync('./scripts/reconcile_profiles.js', 'utf8');
  check(/REGIONS/.test(scriptSrc) && /resolveTimezoneFromCountry/.test(scriptSrc), 'the script resolves defaults from globalization.js (one source of truth)');
  check(/--dry-run/.test(scriptSrc) && /import\.meta\.url === pathToFileURL/.test(scriptSrc), 'the CLI supports --dry-run and never runs on import');

  console.log(`\n🎉 ALL ${passed} PROFILE BACKFILL ASSERTIONS PASSED`);

}

runWithCleanup({ testFn: runTests });
