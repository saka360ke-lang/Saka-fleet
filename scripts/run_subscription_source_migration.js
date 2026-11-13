import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — subscription ledger source migration (v1.97.0).
 * Adds the additive `subscriptions.source` column so a superadmin manual tier
 * override leaves a distinguishable ledger line ('paystack' | 'manual').
 * Idempotent.
 * Run: npm run migrate:subscription-source
 */

export const SUBSCRIPTION_SOURCE_SQL = `
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS source text;
`;

export async function applySubscriptionSourceMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing subscription-source migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(SUBSCRIPTION_SOURCE_SQL, { label: 'subscriptionSourceMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK subscription-source migration applied (subscriptions.source).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applySubscriptionSourceMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
