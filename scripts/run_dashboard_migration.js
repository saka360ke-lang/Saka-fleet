import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { DASHBOARD_SQL } from '../src/services/dashboard.js';

/**
 * Saka Fleet — dashboard session store migration (v1.74.0, Phase 13).
 * Creates public.dashboard_sessions (idempotent) so magic-link + email-OTP
 * logins survive Cloud Run instances. Tokens are stored as sha256 hashes only.
 *
 * Run: npm run migrate:dashboard
 */

export async function applyDashboardMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing dashboard migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(DASHBOARD_SQL, { label: 'dashboardMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Dashboard migration applied (public.dashboard_sessions).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyDashboardMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
