-- Migration: Saka Fleet Complete Schema Sync & Performance Indexes

-- 1. Vehicle Table Extensions & Comprehensive Asset Record
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS yom integer;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS owner_email text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS fuel_type text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS current_mileage integer DEFAULT 0;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS owner_phone text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS status text DEFAULT 'ACTIVE';
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS vin text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS engine_number text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS transmission text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS tire_size text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS insurance_policy text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS insurance_expiry date;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS inspection_expiry date;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS purchase_cost numeric;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS year_of_manufacture integer;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS other_details text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS is_business boolean DEFAULT false;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS opt_in_earnings boolean DEFAULT false;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS audit_report_frequency text DEFAULT 'on_demand';

-- 2. Reminders Table Extensions
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notified_48h boolean DEFAULT false;

-- 3. Private Earnings Column Alignment
ALTER TABLE public.private_earnings ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE public.private_earnings ALTER COLUMN driver_id DROP NOT NULL;

-- 4. High-Performance B-Tree Indexes for Webhooks & Auto-Audits
CREATE INDEX IF NOT EXISTS idx_profiles_phone ON public.profiles(phone_number);
CREATE INDEX IF NOT EXISTS idx_vehicles_owner ON public.vehicles(owner_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON public.vehicles(plate_number);
CREATE INDEX IF NOT EXISTS idx_expense_vehicle_date ON public.expense_logs(vehicle_id, created_at);
CREATE INDEX IF NOT EXISTS idx_earnings_vehicle_date ON public.private_earnings(vehicle_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_reminders_status_due ON public.reminders(status, due_date);

-- 5. Profiles Dual-Roles & License Extensions
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS driver_license_number text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS driver_license_expiry timestamp with time zone;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS license_notified_30d boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS license_notified_7d boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS license_notified_48h boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS license_notified_1d boolean DEFAULT false;

-- 6. Vehicles Assigned Driver Relationship
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS assigned_driver_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 7. Delayed Owner Notification Queue Table
CREATE TABLE IF NOT EXISTS public.pending_owner_notifications (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE CASCADE,
    driver_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    action_type text NOT NULL,
    details_summary text NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    processed boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);

-- 8. Performance Indexes for New Features
CREATE INDEX IF NOT EXISTS idx_vehicles_assigned_driver ON public.vehicles(assigned_driver_id);
CREATE INDEX IF NOT EXISTS idx_pending_notifications ON public.pending_owner_notifications(processed, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_profiles_license_expiry ON public.profiles(driver_license_expiry);


-- 9. Universal Measurement Units & Telemetry Extensions
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS unit_system text DEFAULT 'metric';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS country_code text;

ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS unit_system text DEFAULT 'metric';
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS operating_hours numeric DEFAULT 0;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS charge_cycles numeric DEFAULT 0;

-- 10. Reminders Dynamic Threshold Extensions
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS threshold_unit text DEFAULT 'date';
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS target_value numeric;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS last_service_value numeric DEFAULT 0;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS interval_value numeric;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS interval_months integer DEFAULT 12;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notified_75p boolean DEFAULT false;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notified_25p boolean DEFAULT false;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notified_5p boolean DEFAULT false;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notified_0p boolean DEFAULT false;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notified_overdue boolean DEFAULT false;

-- 11. Expense Logs kWh & Operating Hours Extensions
ALTER TABLE public.expense_logs ADD COLUMN IF NOT EXISTS kwh_charged numeric;
ALTER TABLE public.expense_logs ADD COLUMN IF NOT EXISTS operating_hours numeric;

-- 12. Indexes for Threshold Engine
CREATE INDEX IF NOT EXISTS idx_reminders_threshold ON public.reminders(vehicle_id, status, threshold_unit);
CREATE INDEX IF NOT EXISTS idx_vehicles_deleted ON public.vehicles(deleted_at);
CREATE INDEX IF NOT EXISTS idx_profiles_deleted ON public.profiles(deleted_at);

-- 13. Subscriptions, Paystack & Local Currency Exchange Rates Cache
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_tier text DEFAULT 'free';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'active';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS billing_interval text DEFAULT 'monthly';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_expires_at timestamp with time zone;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS paystack_customer_code text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS paystack_subscription_code text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS country_code text;

CREATE TABLE IF NOT EXISTS public.exchange_rates_cache (
    currency text PRIMARY KEY,
    baseline_rate numeric NOT NULL,
    current_rate numeric NOT NULL,
    last_monthly_reset timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_subscription ON public.profiles(subscription_tier, subscription_status);
CREATE INDEX IF NOT EXISTS idx_profiles_country ON public.profiles(country_code);

-- 14. Saka Sentinel Worker & Self-Healing Telemetry Tables
CREATE TABLE IF NOT EXISTS public.system_config (
    key text PRIMARY KEY,
    value text,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.error_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    error_message text,
    stack_trace text,
    route text,
    status text DEFAULT 'unresolved',
    ai_diagnosis text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversation_analytics (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    insights jsonb,
    prompt_adjustments text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chat_transcripts (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    phone_number text,
    sender text,
    message_text text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_error_logs_status ON public.error_logs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_transcripts_created ON public.chat_transcripts(created_at);


-- 15. VIN Registry, Asset-Bound Trials, Extension Coupons & Passbook Transfers
CREATE TABLE IF NOT EXISTS public.vin_registry (
    vin text PRIMARY KEY,
    first_registered_at timestamp with time zone DEFAULT now(),
    first_owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    trial_granted boolean DEFAULT true,
    trial_start_at timestamp with time zone DEFAULT now(),
    trial_end_at timestamp with time zone DEFAULT (now() + interval '30 days'),
    trial_extended boolean DEFAULT false,
    trial_extension_coupon_id uuid,
    trial_status text DEFAULT 'active',
    current_vehicle_id uuid,
    updated_at timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vin_registry_status ON public.vin_registry(trial_status, trial_end_at);

ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS trial_start_at timestamp with time zone;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS trial_end_at timestamp with time zone;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS trial_status text DEFAULT 'trial';
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS transfer_count_current_year integer DEFAULT 0;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS last_transfer_year integer DEFAULT EXTRACT(YEAR FROM CURRENT_DATE);

ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS assigned_to_phone text;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS vin text;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS applicable_to text DEFAULT 'trial_extension';
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS scheduled_dispatch_at timestamp with time zone;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS dispatched_at timestamp with time zone;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS email_notified boolean DEFAULT false;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS whatsapp_notified boolean DEFAULT false;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS status text DEFAULT 'scheduled';
CREATE INDEX IF NOT EXISTS idx_coupons_scheduled_dispatch ON public.coupons(status, scheduled_dispatch_at);
CREATE INDEX IF NOT EXISTS idx_coupons_vin_status ON public.coupons(vin, status);

ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS to_owner_email text;
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS to_owner_id uuid REFERENCES public.profiles(id);
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS vin text;
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS release_otp text;
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS release_otp_expires_at timestamp with time zone;
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS buyer_otp text;
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS buyer_otp_expires_at timestamp with time zone;
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS is_free_transfer boolean DEFAULT true;
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS fee_amount numeric DEFAULT 0;
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS fee_currency text DEFAULT 'USD';
ALTER TABLE public.passbook_transfers ADD COLUMN IF NOT EXISTS checkout_url text;
CREATE INDEX IF NOT EXISTS idx_transfers_vehicle_year ON public.passbook_transfers(vehicle_id, status, completed_at);
CREATE INDEX IF NOT EXISTS idx_transfers_buyer_phone ON public.passbook_transfers(to_owner_phone, status);


-- 15. Superadmin Feature Set Tables
CREATE TABLE IF NOT EXISTS public.superadmin_sessions (
    phone_number text PRIMARY KEY,
    is_active boolean DEFAULT false,
    last_active_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.coupons (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    code text UNIQUE,
    discount_value text,
    assigned_to_phone text,
    is_redeemed boolean DEFAULT false,
    created_by text DEFAULT 'SUPERADMIN_WHATSAPP',
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    admin_phone text,
    action text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupons_code ON public.coupons(code);
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON public.admin_audit_logs(admin_phone, created_at);


-- 16. Chat History (Conversational Memory) & Vehicles Custom Attributes
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS custom_attributes jsonb DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.chat_history (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_phone text NOT NULL,
    role text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_history_phone_time ON public.chat_history(user_phone, created_at DESC);


-- 17. Sentinel Real-Time Optimization & Strict 1-to-1 Driver Constraints
CREATE TABLE IF NOT EXISTS public.chat_friction_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_phone text,
    session_id text,
    friction_type text,
    transcript_snippet text,
    detected_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.saka_dynamic_rules (
    id serial PRIMARY KEY,
    rule_key text UNIQUE,
    rule_description text,
    patch_instruction text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_friction_logs_phone ON public.chat_friction_logs(user_phone, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_dynamic_rules_active ON public.saka_dynamic_rules(is_active);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_unique_active_driver 
ON public.vehicles(assigned_driver_id) 
WHERE assigned_driver_id IS NOT NULL AND deleted_at IS NULL;


-- 18. Meta WhatsApp Webhook Deduplication & Idempotency Cache
CREATE TABLE IF NOT EXISTS public.processed_webhooks (
    wamid text PRIMARY KEY,
    phone_number text,
    processed_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_processed_at ON public.processed_webhooks(processed_at);

