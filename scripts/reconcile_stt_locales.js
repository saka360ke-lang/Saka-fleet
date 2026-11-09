import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { planSttLocaleBackfill, COUNTRY_STT_LOCALES } from '../src/services/globalization.js';

/**
 * Saka Fleet — STT locale backfill (v1.89.0, Phase 27C)
 * ----------------------------------------------------
 * Writes ONE `country_kb` row per country that has no active stt_locale row yet
 * (category='stt_locale', rule_key='stt_locale'). Existing rows — including a
 * superadmin's own choice — always win and are never overwritten. Idempotent.
 *
 * DRY-RUN BY DEFAULT (prints the plan only). Writes require `--apply`.
 * Every insert is audited as STT_LOCALE_RECONCILED.
 *
 * Run: npm run reconcile:stt-locales [-- --apply]
 */

export async function reconcileSttLocales({ apply = false } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
    return { success: false, reason: 'no_credentials' };
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: rows, error } = await supabase
    .from('country_kb')
    .select('country_code,category,is_active');
  if (error) {
    console.error('Could not read country_kb:', error.message);
    return { success: false, reason: 'read_failed' };
  }

  const plan = planSttLocaleBackfill(rows || []);
  console.log(`country_kb: ${(rows || []).length} row(s) read; ${plan.length} STT locale row(s) ${apply ? 'to insert' : 'planned'} (${Object.keys(COUNTRY_STT_LOCALES).length} countries mapped).`);
  for (const row of plan) console.log(`  ${row.country_code} -> ${row.stt_locale} (${row.summary})`);
  if (plan.length === 0) console.log('  (already backfilled — nothing to insert)');
  if (!apply) {
    console.log('Dry-run: nothing written. Re-run with --apply to insert.');
    return { success: true, planned: plan.length, inserted: 0, dryRun: true };
  }

  let inserted = 0;
  for (const row of plan) {
    const { error: insertError } = await supabase.from('country_kb').insert([row]);
    if (insertError) {
      console.error(`  x ${row.country_code}: ${insertError.message}`);
      return { success: false, reason: 'insert_failed', inserted };
    }
    inserted += 1;
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'SYSTEM',
      action: 'STT_LOCALE_RECONCILED',
      details: { country_code: row.country_code, stt_locale: row.stt_locale, summary: row.summary },
      created_at: new Date().toISOString()
    }]).then(() => {}, () => {});
  }
  console.log(`✅ Inserted ${inserted} STT locale row(s), audited STT_LOCALE_RECONCILED.`);
  return { success: true, planned: plan.length, inserted, dryRun: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reconcileSttLocales({ apply: process.argv.includes('--apply') })
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error('Reconcile error:', err);
      process.exit(1);
    });
}
