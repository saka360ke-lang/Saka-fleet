import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import {
  REGIONS,
  REGION_FALLBACK,
  detectCountryFromPhone,
  resolveTimezoneFromCountry
} from '../src/services/globalization.js';

/**
 * Saka Fleet — legacy profile context reconciliation (v1.78.0, Phase 17).
 * ----------------------------------------------------------------------
 * Over Phases 1-16 the `profiles` table gained nullable display-context columns
 * (`timezone`, `currency`, `locale`). Rows created before those columns existed
 * carry NULLs, and every reader then falls back to GLOBAL defaults (rule 50
 * degrade chains). This script fills the NULLs from the SAME country data the
 * app already resolves from the phone (REGIONS + COUNTRY_TIMEZONES) so existing
 * accounts fall cleanly into the new structure (rule 56).
 *
 * COALESCE contract (nothing is ever overwritten):
 *  - only NULL columns are patched; a stored value always wins;
 *  - an explicit `country_code` (which may be a user choice,
 *    `country_source='user'`) wins over phone detection;
 *  - `timezone_confirmed_at` and `trial_used_at` are NEVER touched — a
 *    backfilled zone is a default, not a confirmation, and a NULL
 *    trial_used_at means "never used a trial", which is correct.
 *
 * Safety:
 *  - idempotent (a second run patches nothing);
 *  - profiles-only; every change audited as PROFILE_CONTEXT_RECONCILED;
 *  - `--dry-run` reports without writing; `--limit=N` bounds the scan.
 *
 * Run: npm run reconcile:profiles [-- --dry-run] [-- --limit=500]
 */

export const PROFILE_CONTEXT_RECONCILED_ACTION = 'PROFILE_CONTEXT_RECONCILED';

/** Mask a phone for audit details (+254****852529). */
export function maskReconcilePhone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (digits.length < 6) return '+***';
  return '+' + digits.slice(0, Math.min(4, digits.length - 4)) + '***' + digits.slice(-3);
}

/** The REGIONS row for an explicit country code, else the phone's region, else GLOBAL. */
function resolveRegion({ phone_number = null, country_code = null } = {}) {
  const code = String(country_code || '').trim().toUpperCase();
  if (code && code !== REGION_FALLBACK.country_code) {
    const explicit = REGIONS.find((region) => region.country_code === code);
    if (explicit) return explicit;
  }
  return detectCountryFromPhone(phone_number) || REGION_FALLBACK;
}

/** Country-resolved display defaults (`timezone`, `currency`, `locale`). */
export function resolveProfileContextDefaults({ phone_number = null, country_code = null } = {}) {
  const region = resolveRegion({ phone_number, country_code });
  const code = region?.country_code || REGION_FALLBACK.country_code;
  return {
    timezone: resolveTimezoneFromCountry(code),
    currency: region?.currency || REGION_FALLBACK.currency,
    locale: region?.locale || REGION_FALLBACK.locale
  };
}

/**
 * Pure COALESCE decision for ONE profile row: only the columns that are NULL
 * are patched. Returns `{}` when the row is already complete (idempotence).
 */
export function buildProfileContextPatch(row = {}) {
  const defaults = resolveProfileContextDefaults(row);
  const patch = {};
  if (!row.timezone && defaults.timezone) patch.timezone = defaults.timezone;
  if (!row.currency && defaults.currency) patch.currency = defaults.currency;
  if (!row.locale && defaults.locale) patch.locale = defaults.locale;
  return patch;
}

/**
 * Reconcile every profile that still has a NULL display-context column.
 * Idempotent, profiles-only, audited; never throws.
 */
export async function reconcileProfileContexts(supabase, { dryRun = false, limit = 500 } = {}) {
  if (!supabase) return { ok: false, error: 'no_client', scanned: 0, patched: 0, failed: 0, samples: [] };
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, phone_number, country_code, timezone, currency, locale')
      .limit(Math.max(1, Math.min(Number(limit) || 500, 2000)));
    if (error) return { ok: false, error: error.message, scanned: 0, patched: 0, failed: 0, samples: [] };

    let patched = 0;
    let failed = 0;
    const samples = [];
    for (const row of data || []) {
      const patch = buildProfileContextPatch(row);
      if (Object.keys(patch).length === 0) continue;
      // Snapshot BEFORE the write: the audit must describe the original values
      // even if the client mutates the row object it handed us.
      const before = { timezone: row.timezone || null, currency: row.currency || null, locale: row.locale || null };
      if (samples.length < 10) samples.push({ id: row.id, phone: maskReconcilePhone(row.phone_number), patch });
      if (dryRun) { patched += 1; continue; }
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updateError) { failed += 1; continue; }
      patched += 1;
      try {
        await supabase.from('admin_audit_logs').insert([{
          admin_phone: 'PROFILE_CONTEXT_RECONCILE',
          action: PROFILE_CONTEXT_RECONCILED_ACTION,
          details: {
            profile_id: row.id,
            phone: maskReconcilePhone(row.phone_number),
            before,
            after: patch
          }
        }]);
      } catch { /* audit is best-effort */ }
    }
    return { ok: true, scanned: (data || []).length, patched, failed, dryRun: Boolean(dryRun), samples };
  } catch (err) {
    return { ok: false, error: err.message, scanned: 0, patched: 0, failed: 0, samples: [] };
  }
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.find((arg) => /^--limit=\d+$/.test(arg));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 500;
  const supabase = createClient(url, key);

  const result = await reconcileProfileContexts(supabase, { dryRun, limit });
  if (!result.ok) {
    console.error('Profile context reconciliation failed:', result.error);
    process.exit(1);
  }
  console.log(`Scanned ${result.scanned} profile(s); ${dryRun ? 'would patch' : 'patched'} ${result.patched}; failed ${result.failed}.`);
  for (const sample of result.samples) {
    const fields = Object.entries(sample.patch).map(([field, value]) => `${field}=${value}`).join(', ');
    console.log(`  ${sample.phone}: ${fields}`);
  }
  process.exit(result.failed === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Profile context reconciliation error:', err);
    process.exit(1);
  });
}

