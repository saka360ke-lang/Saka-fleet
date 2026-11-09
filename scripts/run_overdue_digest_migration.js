import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { OVERDUE_DIGEST_SQL } from '../src/services/maintenanceReminders.js';

/**
 * Saka Fleet — overdue compliance digest migration (v1.92.0, Phase 29).
 * Creates `public.overdue_digest_log`: ONE row per owner episode that anchors
 * the T+3 / T+7 consolidated digests (D1 hybrid). Idempotent.
 *
 * Run: npm run migrate:overdue-digest
 */

export async function applyOverdueDigestMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing overdue-digest migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(OVERDUE_DIGEST_SQL, { label: 'overdueDigestMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Overdue digest migration applied (public.overdue_digest_log).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyOverdueDigestMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err.message);
      process.exit(1);
    });
}
