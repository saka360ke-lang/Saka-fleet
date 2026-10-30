import 'dotenv/config';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { FEATURE_NOTICE_SQL, FEATURE_NOTICE_VERSION, getFeatureRolloutStatus } from '../src/services/featureNotice.js';
import { FUEL_ECONOMY_SQL } from '../src/services/fuelEconomy.js';
import { RECEIPTS_SQL } from '../src/services/receipts.js';
import { AI_MODEL_REGISTRY_SQL } from '../src/services/aiModelRegistry.js';
import { createClient } from '@supabase/supabase-js';

/**
 * Saka Fleet — existing-user feature rollout (v1.19.1).
 *
 * Backfills the schema that older accounts lack (feature_notice columns, fuel
 * fill_type, receipt vault, model registry) and reports who is still waiting for
 * the once-only "What's new" digest.
 *
 * Dry-run is the default. Writes only with `--apply`.
 *   npm run rollout:features
 *   npm run rollout:features -- --apply
 */

const APPLY = process.argv.includes('--apply');

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function runFeatureRollout({ apply = APPLY } = {}) {
  const supabase = adminClient();
  console.log(`Saka v${FEATURE_NOTICE_VERSION} feature rollout — ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Project: ${getProjectRef()}`);

  const before = supabase ? await getFeatureRolloutStatus(supabase) : { counts: {}, pending: null };
  console.log('Counts before:', JSON.stringify(before.counts), '| pending notices:', before.pending);

  if (!apply) {
    console.log('Planned migrations: feature_notice columns, fuel fill_type, receipts vault, ai_model_registry.');
    console.log('No changes written. Re-run with --apply to execute.');
    return { success: true, applied: false, before };
  }

  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false, applied: false, before };
  }

  const sql = [FEATURE_NOTICE_SQL, FUEL_ECONOMY_SQL, RECEIPTS_SQL, AI_MODEL_REGISTRY_SQL].join('\n');
  const result = await runSql(sql, { label: 'featureRollout' });
  if (!result.ok) {
    console.error('Rollout failed:', result.error || result.body);
    return { success: false, applied: false, before, error: result.error || null };
  }

  const after = supabase ? await getFeatureRolloutStatus(supabase) : { counts: {}, pending: null };
  console.log('✅ Rollout applied.');
  console.log('Counts after:', JSON.stringify(after.counts), '| pending notices:', after.pending);
  console.log('Each existing user receives the ✨ digest once on their next normal turn.');
  return { success: true, applied: true, before, after };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/feature_rollout.js')) {
  runFeatureRollout()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Rollout error:', err);
      process.exit(1);
    });
}
