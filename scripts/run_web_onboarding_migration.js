import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { WEB_ONBOARD_OTP_SQL } from '../src/services/webOnboarding.js';

/**
 * Saka Fleet — Web onboarding OTP store migration (v1.39.0).
 * Creates public.web_onboard_otps (idempotent) so the sakafleet.com signup
 * handshake can store 6-digit codes durably across Cloud Run instances.
 *
 * Run: npm run migrate:web-onboard
 */

export async function applyWebOnboardingMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing web onboarding migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(WEB_ONBOARD_OTP_SQL, { label: 'webOnboardingMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Web onboarding migration applied (public.web_onboard_otps).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyWebOnboardingMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
