import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { SYSTEM_CONFIG_KEYS, planSystemConfigCopies, knownSystemConfigKeys } from '../src/services/systemConfigKeys.js';

/**
 * Saka Fleet — system_config key namespacing migration (v1.72.1, Phase 8C / P2-6).
 * -------------------------------------------------------------------------------
 * COPY-then-DELETE across two releases:
 *   release A (this script, default): copy every legacy row to its namespaced
 *   name and KEEP the legacy row — the dual-read window must stay rolling-deploy
 *   safe (a rename would open a moment where neither key holds the value, and a
 *   booting instance could re-announce the deploy).
 *   release B (v1.73.0, `--drop-legacy`): delete the legacy rows only after the
 *   dual window has been the only serving version for a full cycle.
 *
 * Idempotent: a re-run copies nothing twice. `--dry-run` prints the plan only.
 * Run: npm run migrate:system-config-keys [-- --dry-run] [-- --drop-legacy]
 */

export async function applySystemConfigKeyMigration({ dryRun = false, dropLegacy = false } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
    return { success: false, reason: 'no_credentials' };
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: rows, error } = await supabase.from('system_config').select('key,value,updated_by,updated_at');
  if (error) {
    console.error('Could not read system_config:', error.message);
    return { success: false, reason: 'read_failed' };
  }
  const copies = planSystemConfigCopies(rows || []);
  console.log(`system_config: ${(rows || []).length} row(s) read; ${copies.length} cop${copies.length === 1 ? 'y' : 'ies'} planned${dryRun ? ' (dry-run — nothing written)' : ''}.`);
  for (const copy of copies) console.log(`  ${copy.legacyKey}  ->  ${copy.namespacedKey}`);
  if (copies.length === 0) console.log('  (already migrated — nothing to copy)');
  if (!dryRun) {
    for (const copy of copies) {
      const { error: writeError } = await supabase.from('system_config').upsert(
        [{ key: copy.namespacedKey, value: copy.value, updated_by: copy.updated_by, updated_at: copy.updated_at }],
        { onConflict: 'key' }
      );
      if (writeError) {
        console.error(`  x ${copy.namespacedKey}: ${writeError.message}`);
        return { success: false, reason: 'write_failed' };
      }
    }
  }
  const known = knownSystemConfigKeys();
  const unknown = (rows || []).map((row) => row.key).filter((k) => (
    !known.has(k)
    && !String(k).startsWith('budget.alert.')
    && !String(k).startsWith('ai_budget_alert_')
  ));
  if (unknown.length) console.log(`Left untouched (unregistered keys): ${unknown.join(', ')}`);
  if (dropLegacy) {
    const fixedLegacy = Object.values(SYSTEM_CONFIG_KEYS).map((descriptor) => descriptor.legacyKey);
    if (!dryRun) {
      const { error: fixedError } = await supabase.from('system_config').delete().in('key', fixedLegacy);
      if (fixedError) {
        console.error('Legacy fixed-key delete failed:', fixedError.message);
        return { success: false, reason: 'delete_failed' };
      }
      const { error: dynamicError } = await supabase.from('system_config').delete().like('key', 'ai_budget_alert_%');
      if (dynamicError) {
        console.error('Legacy dynamic-key delete failed:', dynamicError.message);
        return { success: false, reason: 'delete_failed' };
      }
    }
    console.log(`Legacy rows ${dryRun ? 'would be' : 'were'} deleted (${fixedLegacy.length} fixed + ai_budget_alert_*).`);
  }
  if (!dryRun && copies.length) {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'SYSTEM',
      action: 'SYSTEM_CONFIG_KEY_MIGRATED',
      details: { copied: copies.map((copy) => ({ from: copy.legacyKey, to: copy.namespacedKey })), drop_legacy: dropLegacy },
      created_at: new Date().toISOString()
    }]);
  }
  return { success: true, copied: copies.length, dropLegacy };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applySystemConfigKeyMigration({
    dryRun: process.argv.includes('--dry-run'),
    dropLegacy: process.argv.includes('--drop-legacy')
  })
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
