import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { SIGNUP_GUARD_SQL } from '../src/services/webOnboarding.js';

/**
 * Saka Fleet — DB-level signup guards (v1.59.2).
 * Partial UNIQUE indexes on profiles.phone_number and lower(profiles.email):
 * a second account for the same number or email becomes physically impossible,
 * even in a concurrent race. Idempotent; requires zero existing duplicates
 * (verified: 0 phone / 0 email duplicates on the live table).
 *
 * Run: npm run migrate:signup-guards
 */

export async function applySignupGuardMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing signup-guard migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(SIGNUP_GUARD_SQL, { label: 'signupGuardIndexes' });
  if (!result.ok) {
    console.error('Signup-guard migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK signup guards applied (unique phone_number + lower(email) partial indexes).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applySignupGuardMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
