import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { ADMIN_IMPERSONATIONS_SQL } from '../src/services/dashboard.js';

/**
 * Saka Fleet — admin impersonation store migration (v1.91.0, Phase 28A).
 * Creates public.admin_impersonations (idempotent): the superadmin's 30-minute
 * READ-ONLY sessions. Only the sha256 of the `saka_dash_as` cookie token is
 * stored; the raw value never leaves the cookie.
 *
 * Run: npm run migrate:admin-impersonations
 */

export async function applyAdminImpersonationsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing admin_impersonations migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(ADMIN_IMPERSONATIONS_SQL, { label: 'adminImpersonationsMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Admin impersonation migration applied (public.admin_impersonations).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyAdminImpersonationsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
