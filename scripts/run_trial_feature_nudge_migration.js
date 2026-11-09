import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { TRIAL_FEATURE_NUDGE_SQL } from '../src/services/trialSchema.js';

/**
 * Saka Fleet - drip-feed feature-tip migration (v1.95.0, Phase 32 Task 3).
 * Adds trial_sessions.feature_nudge_sent_at / feature_nudge_followup_sent_at /
 * feature_nudge_key so the trial sweep can send ONE feature tip at T+12h and one
 * follow-up at T+48h (only while that feature is still unexplored). Idempotent.
 * Run: npm run migrate:trial-feature-nudge
 */

export async function applyTrialFeatureNudgeMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing trial feature-nudge migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(TRIAL_FEATURE_NUDGE_SQL, { label: 'trialFeatureNudgeMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK trial feature-nudge migration applied (feature_nudge_sent_at, feature_nudge_followup_sent_at, feature_nudge_key).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyTrialFeatureNudgeMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}