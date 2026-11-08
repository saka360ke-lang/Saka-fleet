import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — dashboard session-role migration (v1.76.0, Phase 15).
 * One additive, idempotent column: existing sessions default to 'owner' (rule 56).
 * Run: npm run migrate:dashboard-role
 */

export const DASHBOARD_ROLE_SQL = `
  ALTER TABLE public.dashboard_sessions ADD COLUMN IF NOT EXISTS session_role text NOT NULL DEFAULT 'owner';
`;

export async function applyDashboardRoleMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Applying dashboard session_role on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(DASHBOARD_ROLE_SQL, { label: 'dashboardRoleMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ dashboard_sessions.session_role ready (default owner).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyDashboardRoleMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err.message);
      process.exit(1);
    });
}
