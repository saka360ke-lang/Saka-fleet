import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { FRICTION_TRACKER_SQL } from '../src/services/frictionTracker.js';

/**
 * Saka Fleet - Friction-point tracker migration (v1.56.4).
 * Adds status/resolved_at/resolution to chat_friction_logs (idempotent) so the
 * tracker can mark points PENDING -> DEPLOYED and auto-clear deployed ones
 * after 4 h while keeping the permanent log. Run: npm run migrate:friction
 */

export async function applyFrictionTrackerMigration() {  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log('Executing friction-tracker migration on Supabase project: ${getProjectRef()}...');
  const result = await runSql(FRICTION_TRACKER_SQL, { label: 'frictionTrackerMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK friction-tracker migration applied (chat_friction_logs.status/resolved_at/resolution).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyFrictionTrackerMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
