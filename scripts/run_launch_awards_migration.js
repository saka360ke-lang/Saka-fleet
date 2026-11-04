import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { LAUNCH_AWARD_SQL, LAUNCH_UTM_SQL } from '../src/services/launchAwards.js';

/**
 * Saka Fleet — launch campaign migration (v1.58.26).
 * Creates `launch_awards` (first-N welcome-trial award ledger) and adds the
 * optional UTM attribution columns to `profiles`. Idempotent by construction
 * (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 *
 * Run: npm run migrate:launch-awards
 */

export async function applyLaunchAwardsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing launch-award migration on Supabase project: ${getProjectRef()}...`);
  const table = await runSql(LAUNCH_AWARD_SQL, { label: 'launchAwardsTable' });
  if (!table.ok) {
    console.error('launch_awards DDL failed:', table.error || table.body);
    return { success: false, ...table };
  }
  console.log('OK launch_awards table + indexes ready.');
  const utm = await runSql(LAUNCH_UTM_SQL, { label: 'launchUtmColumns' });
  if (!utm.ok) {
    console.error('profiles UTM columns failed:', utm.error || utm.body);
    return { success: false, ...utm };
  }
  console.log('OK profiles.utm_source / utm_medium / utm_campaign ready.');
  return { success: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyLaunchAwardsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
