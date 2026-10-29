/**
 * Saka Fleet — Subscription & Trial Schema (v1.15.0)
 * --------------------------------------------------
 * Idempotent DDL shared by `scripts/run_subscription_migration.js`
 * (`npm run migrate:subscriptions`) and the boot-time
 * `ensureSubscriptionSchema()` call in `index.js`.
 *
 * Tables:
 *   subscriptions            — event-sourced subscription ledger (one row per Paystack subscription code)
 *   paystack_webhook_events  — webhook idempotency ledger (keyed on Paystack event.id)
 *   usage_counters           — per-owner monthly counters (Free = 1 report/month)
 *   trial_sessions           — owner-bound 30-day trial state machine + funnel timestamps
 *
 * Profiles gains trial/add-on/cancel/period columns; coupons gains discount
 * scoping columns; passbook_transfers gains `blocked_reason`.
 */

import { runSql } from './sqlRunner.js';

export const SUBSCRIPTION_SCHEMA_SQL = `
-- ============================================================
-- 1. profiles: subscription lifecycle columns
-- ============================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS billing_interval varchar DEFAULT 'monthly';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS paystack_customer_code text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS paystack_subscription_code text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS paystack_email_token text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS trial_used_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS addon_quantity integer DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_period_start timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_period_end timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS downgraded_at timestamptz;

-- Tier + status checks (legacy keys stay accepted for migration safety).
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_subscription_tier_check
  CHECK (LOWER(subscription_tier) = ANY (ARRAY[
    'free','solo','solo_pro','growth','team_fleet','fleet_command',
    'scale','fleet_starter','pro','fleet_scale','enterprise','unlimited'
  ]));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_subscription_status_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_subscription_status_check
  CHECK (UPPER(subscription_status) = ANY (ARRAY[
    'TRIALING','ACTIVE','PAST_DUE','CANCELED','CANCELLED','CANCELING','TRIAL','EXPIRED'
  ]));

-- ============================================================
-- 2. subscriptions — event-sourced ledger
-- ============================================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan_code text,
  tier varchar NOT NULL,
  interval varchar DEFAULT 'monthly',
  status varchar DEFAULT 'ACTIVE',
  quantity integer DEFAULT 1,
  addon_quantity integer DEFAULT 0,
  paystack_subscription_code text,
  paystack_customer_code text,
  paystack_email_token text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_end_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_paystack_code
  ON public.subscriptions(paystack_subscription_code)
  WHERE paystack_subscription_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_owner_status
  ON public.subscriptions(owner_id, status);

-- ============================================================
-- 3. paystack_webhook_events — idempotency
-- ============================================================
CREATE TABLE IF NOT EXISTS public.paystack_webhook_events (
  id bigserial PRIMARY KEY,
  event_id text UNIQUE,
  event_type text,
  reference text,
  payload jsonb,
  processed_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_paystack_events_type ON public.paystack_webhook_events(event_type, processed_at);

-- ============================================================
-- 4. usage_counters — monthly report quotas (Nairobi month key)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.usage_counters (
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  period_key text NOT NULL,
  report_count integer DEFAULT 0,
  last_report_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (owner_id, period_key)
);

-- ============================================================
-- 5. trial_sessions — owner-bound 30-day trial state machine
-- ============================================================
CREATE TABLE IF NOT EXISTS public.trial_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tier varchar NOT NULL,
  interval varchar DEFAULT 'monthly',
  status varchar DEFAULT 'ACTIVE',
  started_at timestamptz DEFAULT now(),
  ends_at timestamptz NOT NULL,
  activated boolean DEFAULT false,
  activated_at timestamptz,
  activation_events jsonb DEFAULT '[]'::jsonb,
  coupon_code text,
  nudge_activation_sent_at timestamptz,
  nudge_midpoint_sent_at timestamptz,
  nudge_t3_sent_at timestamptz,
  nudge_t24_sent_at timestamptz,
  expiry_processed_at timestamptz,
  checkout_started_at timestamptz,
  converted_at timestamptz,
  paystack_subscription_code text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_sessions_owner
  ON public.trial_sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_trial_sessions_status_ends
  ON public.trial_sessions(status, ends_at);

-- ============================================================
-- 6. coupons — checkout discount scoping
-- ============================================================
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS discount_currency text DEFAULT 'USD';
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS applies_to_tier text;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS applies_to_interval text DEFAULT 'both';
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS redeemed_at timestamptz;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS redemption_type text;

-- ============================================================
-- 7. passbook_transfers — buyer upgrade gate reason
-- ============================================================
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS blocked_reason text;

-- ============================================================
-- 8. ai_usage_logs — per-owner attribution (trial engagement)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ai_usage_logs'
  ) THEN
    ALTER TABLE public.ai_usage_logs ADD COLUMN IF NOT EXISTS owner_id uuid;
  END IF;
END $$;

-- ============================================================
-- 9. Legacy tier remap (idempotent, run after checks are updated)
--    solo_pro owners with >1 active vehicle -> team_fleet
--    scale/fleet_starter/enterprise/unlimited -> fleet_command + add-ons
-- ============================================================
UPDATE public.profiles p
SET subscription_tier = 'team_fleet', updated_at = now()
WHERE LOWER(p.subscription_tier) = 'solo_pro'
  AND (
    SELECT COUNT(*) FROM public.vehicles v
    WHERE v.owner_id = p.id AND v.deleted_at IS NULL
  ) > 1;

UPDATE public.profiles p
SET subscription_tier = 'fleet_command',
    addon_quantity = GREATEST(
      0,
      (SELECT COUNT(*) FROM public.vehicles v WHERE v.owner_id = p.id AND v.deleted_at IS NULL) - 5
    ),
    updated_at = now()
WHERE LOWER(p.subscription_tier) IN ('scale', 'fleet_starter', 'fleet_scale', 'enterprise', 'unlimited');
`;

/**
 * Apply the subscription schema over the configured SQL transport.
 * Never throws; returns `{ ok, via, error }`.
 */
export async function ensureSubscriptionSchema({ label = 'ensureSubscriptionSchema' } = {}) {
  const result = await runSql(SUBSCRIPTION_SCHEMA_SQL, { label });
  return { ok: Boolean(result.ok), via: result.via, error: result.error || null };
}

export default { SUBSCRIPTION_SCHEMA_SQL, ensureSubscriptionSchema };
