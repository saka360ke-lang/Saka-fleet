import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { AI_MODEL_REGISTRY_SQL } from '../src/services/aiModelRegistry.js';

/**
 * Saka Fleet — Model Watchdog registry migration (v1.17.0).
 *
 * Creates:
 *   - public.ai_model_registry : discovered/benchmarked/active/standby models.
 *   - public.model_eval_runs    : deterministic benchmark history.
 *
 * Both tables are PRESERVED by scripts/reset-db.js (runtime model governance,
 * like system_config) — a fresh onboarding wipe must never silently downgrade
 * the model that is currently serving users.
 *
 * Idempotent: CREATE ... IF NOT EXISTS throughout.
 * Run: npm run migrate:model-registry
 */

export async function applyModelRegistryMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }

  console.log(`Executing model registry migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(AI_MODEL_REGISTRY_SQL, { label: 'modelRegistryMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Model registry migration applied (ai_model_registry + model_eval_runs).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyModelRegistryMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}