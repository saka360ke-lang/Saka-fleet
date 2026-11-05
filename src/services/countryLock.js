/**
 * Saka Fleet — Phone-primary country lock (v1.59.0)
 * ------------------------------------------------
 * The country code of the WhatsApp number (E.164) is the PRIMARY determinant of
 * a profile's country. This service is the single place that:
 *   1. decides the country patch for a profile row (`countryPatchForProfile`),
 *   2. backfills signups that missed the rule (`reconcileProfileCountries`),
 *   3. owns the idempotent DDL for `profiles.country_source`.
 *
 * Rules (permanent):
 *  - An explicit user choice (`my country` / `country <name>`, stamped
 *    `country_source='user'`) is NEVER overwritten by reconciliation.
 *  - The GLOBAL fallback never locks a country.
 *  - Reconciliation is idempotent, profiles-only and audited
 *    (`COUNTRY_RECONCILED` in `admin_audit_logs`).
 *  - Never throws; every function returns `{ ok, ... }`.
 */

import { resolvePhoneCountryLock } from './globalization.js';

export const COUNTRY_SOURCE_DEFAULT = 'phone';
export const COUNTRY_SOURCE_VALUES = Object.freeze(['phone', 'user']);
export const COUNTRY_RECONCILED_ACTION = 'COUNTRY_RECONCILED';

/** Idempotent DDL — rule 50: additive, IF NOT EXISTS. */
export const COUNTRY_SOURCE_SQL = `
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS country_source text DEFAULT 'phone';
`;

/**
 * Pure decision: which country patch (if any) does this phone impose on a
 * stored profile row? Returns `null` when nothing should change.
 */
export function countryPatchForProfile(existing = {}, phone = null) {
  const lock = resolvePhoneCountryLock(phone);
  if (!lock) return null;
  if (String(existing?.country_source || '').toLowerCase() === 'user') return null;
  const currentCode = String(existing?.country_code || '').toUpperCase();
  const missing = !existing?.country || !existing?.country_code;
  const mismatch = currentCode !== lock.country_code;
  const notYetPhoneStamped = String(existing?.country_source || '').toLowerCase() !== COUNTRY_SOURCE_DEFAULT;
  if (!missing && !mismatch && !notYetPhoneStamped) return null;
  return {
    country: lock.country,
    country_code: lock.country_code,
    country_source: COUNTRY_SOURCE_DEFAULT
  };
}

/** Mask a phone for audit details (+254****852529). */
function maskPhone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (digits.length < 6) return '+***';
  return '+' + digits.slice(0, Math.min(4, digits.length - 4)) + '***' + digits.slice(-3);
}

/**
 * Backfill profiles whose stored country is missing, mismatched against the
 * phone's E.164 code, or not yet stamped as phone-sourced. Owner-only: touches
 * `profiles` and writes one `COUNTRY_RECONCILED` audit row per change.
 */
export async function reconcileProfileCountries(supabase, { dryRun = false, limit = 500 } = {}) {
  if (!supabase) return { ok: false, error: 'no_client', scanned: 0, patched: 0, failed: 0, samples: [] };
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, phone_number, country, country_code, country_source')
      .not('phone_number', 'is', null)
      .limit(Math.max(1, Math.min(Number(limit) || 500, 2000)));
    if (error) return { ok: false, error: error.message, scanned: 0, patched: 0, failed: 0, samples: [] };

    let patched = 0;
    let failed = 0;
    const samples = [];
    for (const row of data || []) {
      const patch = countryPatchForProfile(row, row.phone_number);
      if (!patch) continue;
      if (samples.length < 10) {
        samples.push({ id: row.id, phone: maskPhone(row.phone_number), from: row.country_code || null, to: patch.country_code });
      }
      if (dryRun) { patched += 1; continue; }
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updateError) { failed += 1; continue; }
      patched += 1;
      try {
        await supabase.from('admin_audit_logs').insert([{
          admin_phone: 'COUNTRY_RECONCILE',
          action: COUNTRY_RECONCILED_ACTION,
          details: {
            profile_id: row.id,
            phone: maskPhone(row.phone_number),
            before: { country: row.country || null, country_code: row.country_code || null, country_source: row.country_source || null },
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

export default {
  COUNTRY_SOURCE_DEFAULT,
  COUNTRY_SOURCE_VALUES,
  COUNTRY_RECONCILED_ACTION,
  COUNTRY_SOURCE_SQL,
  countryPatchForProfile,
  reconcileProfileCountries
};
