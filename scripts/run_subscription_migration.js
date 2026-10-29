/**
 * Saka Fleet — Subscription & Trial schema migration (v1.15.0)
 * -----------------------------------------------------------
 * Applies `src/db/subscriptionSchema.js` over the configured SQL transport:
 *   - profiles trial/add-on/cancel/period columns + tier/status constraints
 *   - subscriptions, paystack_webhook_events, usage_counters, trial_sessions
 *   - coupons checkout-scope columns, passbook_transfers.blocked_reason
 *   - ai_usage_logs.owner_id attribution
 *   - legacy tier remap (solo_pro>1 -> team_fleet; scale/enterprise -> fleet_command)
 *
 * Usage: npm run migrate:subscriptions
 */

import dotenv from 'dotenv';
dotenv.config();
import { hasSqlAccess } from '../src/db/sqlRunner.js';
import { ensureSubscriptionSchema } from '../src/db/subscriptionSchema.js';

export async function applySubscriptionMigration() {
  if (!hasSqlAccess()) {
    console.error('❌ Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { ok: false, error: 'no SQL transport' };
  }
  console.log('⏳ Applying subscription & trial schema (v1.15.0)...');
  const result = await ensureSubscriptionSchema({ label: 'applySubscriptionMigration' });
  if (result.ok) {
    console.log(`✅ Subscription schema applied via ${result.via}. Legacy tiers remapped.`);
  } else {
    console.error('❌ Subscription migration failed:', result.error);
  }
  return result;
}

const invokedDirectly = process.argv[1] && /run_subscription_migration\.js$/i.test(process.argv[1]);
if (invokedDirectly) {
  applySubscriptionMigration()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('❌ Subscription migration crashed:', err.message);
      process.exit(1);
    });
}

export default { applySubscriptionMigration };
