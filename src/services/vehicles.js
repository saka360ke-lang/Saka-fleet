import dotenv from 'dotenv';
dotenv.config();
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import {
  normalizeTierKey,
  getTierDefinition,
  getEffectiveVehicleLimit,
  getNextTierKey,
  getAddonPriceUSD
} from './subscriptionTiers.js';
import { notifyDriverUnassigned } from './followups.js';

/**
 * Resolve the driver phone BEFORE the vehicle row changes (v1.16.4). Metadata
 * beats a profile lookup; never throws.
 */
async function resolveDriverPhone({ supabase, vehicle }) {
  if (!supabase || !vehicle) return null;
  let phone = vehicle.metadata?.assigned_driver_phone || null;
  if (!phone && vehicle.assigned_driver_id) {
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('phone_number')
        .eq('id', vehicle.assigned_driver_id)
        .maybeSingle();
      phone = profile?.phone_number || null;
    } catch { phone = null; }
  }
  return phone;
}

export async function ensureVehicleTableColumns(providedSupabase = null) {
  if (hasSqlAccess()) {
    try {
      const sql = `
        ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_subscription_status_check;
        ALTER TABLE public.profiles ADD CONSTRAINT profiles_subscription_status_check CHECK (UPPER(subscription_status) = ANY (ARRAY['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'CANCELLED', 'TRIAL']));
        ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;
        ALTER TABLE public.profiles ADD CONSTRAINT profiles_subscription_tier_check CHECK (LOWER(subscription_tier) = ANY (ARRAY['free', 'solo', 'solo_pro', 'growth', 'scale', 'fleet_starter', 'pro', 'fleet_scale', 'enterprise', 'unlimited']));
        ALTER TABLE public.profiles ALTER COLUMN id SET DEFAULT gen_random_uuid();
        ALTER TABLE public.vehicles ALTER COLUMN id SET DEFAULT gen_random_uuid();
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
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS custom_attributes jsonb DEFAULT '{}'::jsonb;
        CREATE INDEX IF NOT EXISTS idx_vehicles_plate_status ON public.vehicles(plate_number, status);
        CREATE TABLE IF NOT EXISTS public.chat_history (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          user_phone text NOT NULL,
          role text NOT NULL,
          message text NOT NULL,
          created_at timestamp with time zone DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_chat_history_phone_time ON public.chat_history(user_phone, created_at DESC);

        -- VIN Registry & Asset-Bound Trials
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

        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
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

        ALTER TABLE public.passbook_transfers ALTER COLUMN to_owner_phone DROP NOT NULL;
        ALTER TABLE public.passbook_transfers ALTER COLUMN status TYPE text;
        ALTER TABLE public.passbook_transfers DROP CONSTRAINT IF EXISTS passbook_transfers_status_check;
        ALTER TABLE public.passbook_transfers ADD CONSTRAINT passbook_transfers_status_check CHECK (status = ANY (ARRAY['PENDING_TARGET_DETAILS', 'PENDING_OWNER_RELEASE_OTP', 'PENDING_BUYER_ACCEPTANCE', 'PENDING_BUYER_OTP', 'PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED']));
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

        -- v1.8 Maintenance Reminder Engine: distance (canonical km) + operating hours
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS operating_hours numeric DEFAULT 0;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS hours_updated_at timestamp with time zone;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS unit_system text DEFAULT 'metric';

        -- v1.9 Universal Reminder Engine: first-class date-based expiries
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS road_license_expiry date;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS road_license_number text;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS permit_expiry date;
        ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS permit_number text;
        ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS timezone text;
        ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS timezone_confirmed_at timestamp with time zone;

        -- v1.9.1 OTP-gated driver assignments + compliance onboarding
        ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS compliance_type text;
        ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS compliance_number text;
        ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS compliance_expiry date;
        ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS compliance_updated_at timestamp with time zone;
        CREATE TABLE IF NOT EXISTS public.driver_assignments (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          vehicle_id uuid NOT NULL,
          owner_id uuid,
          driver_id uuid,
          driver_phone text NOT NULL,
          handover_odometer numeric,
          owner_otp text,
          owner_otp_expires_at timestamp with time zone,
          owner_otp_attempts integer DEFAULT 0,
          owner_otp_verified_at timestamp with time zone,
          invalid_compliance_attempts integer DEFAULT 0,
          compliance_snapshot jsonb DEFAULT '{}'::jsonb,
          compliance_completed_at timestamp with time zone,
          compliance_report_sent_at timestamp with time zone,
          status text NOT NULL DEFAULT 'PENDING_OWNER_OTP',
          cancelled_reason text,
          accepted_at timestamp with time zone,
          activated_at timestamp with time zone,
          rejected_at timestamp with time zone,
          cancelled_at timestamp with time zone,
          created_at timestamp with time zone DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_driver_assignments_vehicle ON public.driver_assignments(vehicle_id, status);
        CREATE INDEX IF NOT EXISTS idx_driver_assignments_driver ON public.driver_assignments(driver_phone, status);
        CREATE TABLE IF NOT EXISTS public.driver_compliances (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          driver_id uuid NOT NULL,
          type text NOT NULL,
          label text NOT NULL,
          number text,
          expiry date,
          lifetime boolean DEFAULT false,
          country_code text,
          asset_type text,
          verified_at timestamp with time zone,
          created_at timestamp with time zone DEFAULT now(),
          updated_at timestamp with time zone DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_compliances_unique ON public.driver_compliances(driver_id, type);
        CREATE TABLE IF NOT EXISTS public.compliance_catalog (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          country_code text UNIQUE NOT NULL,
          minimal jsonb NOT NULL DEFAULT '{}'::jsonb,
          additional jsonb DEFAULT '[]'::jsonb,
          lifetime_allowed boolean DEFAULT false,
          effective_from date,
          reviewed_at timestamp with time zone,
          next_review_at date,
          source text DEFAULT 'bundled',
          catalog_version text,
          is_active boolean DEFAULT true,
          created_at timestamp with time zone DEFAULT now(),
          updated_at timestamp with time zone DEFAULT now()
        );

        DO $v18$
        BEGIN
          IF to_regclass('public.reminders') IS NOT NULL THEN
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS threshold_unit text';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS threshold_input_unit text';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS target_value numeric';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS last_service_value numeric DEFAULT 0';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS remaining_value numeric';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS remaining_updated_at timestamp with time zone';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS display_unit text';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notes text';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notified_overdue boolean DEFAULT false';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS category text';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS kind text';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS due_at timestamp with time zone';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS timezone text';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS linked_column text';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS subject_type text DEFAULT ''vehicle''';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS subject_id uuid';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS completed_on_time boolean';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notified_14d boolean DEFAULT false';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS notified_24h boolean DEFAULT false';
            EXECUTE 'ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS expiry_tier_at timestamp with time zone';
            EXECUTE 'CREATE INDEX IF NOT EXISTS idx_reminders_active_threshold ON public.reminders(status, threshold_unit)';
            EXECUTE 'CREATE INDEX IF NOT EXISTS idx_reminders_due_active ON public.reminders(status, due_date)';
            EXECUTE 'CREATE INDEX IF NOT EXISTS idx_reminders_subject ON public.reminders(subject_type, subject_id)';
          END IF;
          IF to_regclass('public.expiry_notification_log') IS NULL THEN
            EXECUTE 'CREATE TABLE public.expiry_notification_log (
              id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
              reminder_id uuid,
              vehicle_id uuid,
              category text,
              tier text NOT NULL,
              phone text NOT NULL,
              channel text DEFAULT ''whatsapp'',
              message text,
              sent_at timestamp with time zone DEFAULT now()
            )';
            EXECUTE 'CREATE INDEX IF NOT EXISTS idx_expiry_log_reminder ON public.expiry_notification_log(reminder_id, sent_at DESC)';
            EXECUTE 'CREATE INDEX IF NOT EXISTS idx_expiry_log_vehicle ON public.expiry_notification_log(vehicle_id, sent_at DESC)';
          END IF;
        END
        $v18$;
      `;
      const result = await runSql(sql, { label: 'ensureVehicleTableColumns' });
      if (!result.ok) {
        console.warn('ensureVehicleTableColumns warning:', result.error || result.body);
      } else {
        console.log('✅ Supabase vehicles table columns verified and ensured.');
      }
    } catch (err) {
      console.warn('ensureVehicleTableColumns error:', err.message);
    }
  }
}


/**
 * Check if owner can register an additional vehicle under their subscription.
 * v1.15.0: capacity comes from the frozen registry AND the owner's Fleet
 * Command add-on quantity — there is no local tier table any more.
 */
export async function checkOwnerVehicleTierLimit({ ownerId, subscriptionTier = 'free', addonQuantity = null, supabase }) {
  const tierKey = normalizeTierKey(subscriptionTier);
  const tier = getTierDefinition(tierKey);
  const nextTierKey = getNextTierKey(tierKey);

  let addons = addonQuantity;
  if (addons === null && ownerId && supabase) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('addon_quantity')
        .eq('id', ownerId)
        .maybeSingle();
      addons = Number(data?.addon_quantity || 0);
    } catch {
      addons = 0;
    }
  }
  const effectiveAddons = tier.addonEligible ? Math.max(0, Math.floor(Number(addons) || 0)) : 0;
  const limit = getEffectiveVehicleLimit(tierKey, effectiveAddons);

  const { count, error } = await supabase
    .from('vehicles')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId)
    .is('deleted_at', null);

  const currentCount = error ? 0 : (count || 0);
  const canAdd = currentCount < limit;

  return {
    canAdd,
    currentCount,
    limit,
    tier: tierKey,
    nextTierKey,
    addonEligible: Boolean(tier.addonEligible),
    addonQuantity: effectiveAddons,
    addonPriceUSD: tier.addonEligible ? getAddonPriceUSD(tierKey, 'monthly') : 0
  };
}

/**
 * VIN provenance ledger (v1.16.0 — account-bound trial era)
 * ---------------------------------------------------------
 * VINs and passbook tokens are permanent ASSET identifiers. Commercial state
 * (trial, tier, billing) is bound to `profiles.id` only — the VIN registry no
 * longer grants or tracks asset trials. It records provenance immutably:
 * first registration, first owner, current vehicle.
 *
 * The legacy trial_* columns remain untouched for historical rows and are
 * never written again (VIN immutability: no history is deleted or rewritten).
 */
export async function ensureVinRegistryEntry({ vin, ownerId, vehicleId, supabase }) {
  if (!vin) return { ok: false, reason: 'vin required', isFirstRegistration: false };
  const cleanVin = String(vin).toUpperCase().trim();
  if (!supabase) return { ok: true, isFirstRegistration: false, vin: cleanVin, persisted: false };

  const nowIso = new Date().toISOString();
  try {
    const { data: existing } = await supabase
      .from('vin_registry')
      .select('vin, first_owner_id, current_vehicle_id')
      .eq('vin', cleanVin)
      .maybeSingle();

    if (!existing) {
      await supabase.from('vin_registry').insert([{
        vin: cleanVin,
        first_registered_at: nowIso,
        first_owner_id: ownerId || null,
        // Account-bound trials: this row must never mint an asset trial.
        trial_granted: false,
        trial_status: 'account_bound',
        current_vehicle_id: vehicleId || null,
        updated_at: nowIso
      }]);
      return { ok: true, isFirstRegistration: true, vin: cleanVin, persisted: true };
    }

    if (vehicleId && existing.current_vehicle_id !== vehicleId) {
      await supabase.from('vin_registry').update({
        current_vehicle_id: vehicleId,
        updated_at: nowIso
      }).eq('vin', cleanVin);
    }
    return { ok: true, isFirstRegistration: false, vin: cleanVin, persisted: true };
  } catch (err) {
    console.error('[ensureVinRegistryEntry] provenance write skipped:', err.message);
    return { ok: false, error: err.message, isFirstRegistration: false, vin: cleanVin };
  }
}

/**
 * @deprecated v1.16.0 — the asset-bound trial is RETIRED. Kept as a safe
 * shim so legacy callers degrade to provenance-only behaviour instead of
 * minting a phantom vehicle trial. Set LEGACY_VIN_TRIALS=on only for
 * historical replays/tests.
 */
export async function getOrCreateVinTrial({ vin, ownerId, vehicleId, supabase }) {
  if (String(process.env.LEGACY_VIN_TRIALS || 'off').toLowerCase() !== 'on') {
    const registry = await ensureVinRegistryEntry({ vin, ownerId, vehicleId, supabase });
    return {
      isFirstRegistration: registry.isFirstRegistration,
      trialStartAt: null,
      trialEndAt: null,
      trialStatus: 'account_bound',
      trialExtended: false,
      accountBound: true,
      registry
    };
  }
  const now = new Date();
  if (!vin) {
    const trialStartAt = now.toISOString();
    const trialEndAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return { isFirstRegistration: true, trialStartAt, trialEndAt, trialStatus: 'active', trialExtended: false };
  }

  const cleanVin = vin.toUpperCase().trim();
  if (!supabase) {
    const trialStartAt = now.toISOString();
    const trialEndAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return { isFirstRegistration: true, trialStartAt, trialEndAt, trialStatus: 'active', trialExtended: false };
  }

  try {
    const { data: existing, error } = await supabase
      .from('vin_registry')
      .select('*')
      .eq('vin', cleanVin)
      .maybeSingle();

    if (!existing) {
      // First-ever registration of this VIN! One-time 30-day trial granted
      const trialStartAt = now.toISOString();
      const trialEndAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await supabase.from('vin_registry').insert([{
        vin: cleanVin,
        first_registered_at: trialStartAt,
        first_owner_id: ownerId || null,
        trial_granted: true,
        trial_start_at: trialStartAt,
        trial_end_at: trialEndAt,
        trial_extended: false,
        trial_status: 'active',
        current_vehicle_id: vehicleId || null
      }]);

      return {
        isFirstRegistration: true,
        trialStartAt,
        trialEndAt,
        trialStatus: 'active',
        trialExtended: false
      };
    }

    // Existing VIN! Re-registration preserves the original trial clock
    const trialEnd = new Date(existing.trial_end_at);
    const isStillActive = trialEnd > now;
    const trialStatus = isStillActive ? (existing.trial_extended ? 'extended' : 'active') : 'expired';

    if (vehicleId && existing.current_vehicle_id !== vehicleId) {
      await supabase.from('vin_registry').update({
        current_vehicle_id: vehicleId,
        updated_at: now.toISOString()
      }).eq('vin', cleanVin);
    }

    return {
      isFirstRegistration: false,
      trialStartAt: existing.trial_start_at,
      trialEndAt: existing.trial_end_at,
      trialStatus,
      trialExtended: !!existing.trial_extended
    };
  } catch (err) {
    console.error('[getOrCreateVinTrial Error]:', err.message);
    const trialStartAt = now.toISOString();
    const trialEndAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return { isFirstRegistration: true, trialStartAt, trialEndAt, trialStatus: 'active', trialExtended: false };
  }
}


/**
 * Strict 1-to-1 Driver Assignment Validator:
 * - A driver can only be assigned to ONE vehicle across the platform at any given time.
 * - A vehicle can only have ONE active driver.
 */
export async function canAssignDriverToVehicle({ vehicleId, driverId, supabase }) {
  if (!driverId || !vehicleId) {
    return { allowed: false, message: 'Vehicle ID and Driver ID are required.' };
  }

  // 1. Check if driver is already assigned to any other active vehicle
  const { data: driverExistingVeh, error: driverErr } = await supabase
    .from('vehicles')
    .select('id, plate_number')
    .eq('assigned_driver_id', driverId)
    .neq('id', vehicleId)
    .is('deleted_at', null)
    .maybeSingle();

  if (driverExistingVeh) {
    return {
      allowed: false,
      reason: 'DRIVER_ALREADY_ASSIGNED',
      conflict_plate: driverExistingVeh.plate_number,
      message: `Driver is already assigned to vehicle ${driverExistingVeh.plate_number}. Under Saka Fleet strict 1-to-1 rules, a driver can only be assigned to one vehicle at a time.`
    };
  }

  // 2. Check if the vehicle already has an active driver assigned
  const { data: targetVeh, error: vehErr } = await supabase
    .from('vehicles')
    .select('id, plate_number, assigned_driver_id, driver:profiles!vehicles_assigned_driver_id_fkey(full_name, phone_number)')
    .eq('id', vehicleId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!targetVeh) {
    return { allowed: false, message: 'Vehicle not found.' };
  }

  if (targetVeh.assigned_driver_id && targetVeh.assigned_driver_id !== driverId) {
    const existingDriverName = targetVeh.driver?.full_name || targetVeh.driver?.phone_number || 'another driver';
    return {
      allowed: false,
      reason: 'VEHICLE_ALREADY_HAS_DRIVER',
      conflict_driver: existingDriverName,
      message: `Vehicle ${targetVeh.plate_number} already has active driver ${existingDriverName} assigned. Unassign the current driver first.`
    };
  }

  // 3. OTP-gated assignments reserve both sides while pending/active.
  try {
    const { data: pending } = await supabase
      .from('driver_assignments')
      .select('id, vehicle_id, driver_id, status')
      .eq('driver_id', driverId)
      .limit(20);
    const conflict = (pending || []).find((row) =>
      ['PENDING_OWNER_OTP', 'PENDING_DRIVER_ACCEPTANCE', 'ACTIVE'].includes(row.status) && row.vehicle_id !== vehicleId
    );
    if (conflict) {
      return {
        allowed: false,
        reason: 'DRIVER_ASSIGNMENT_PENDING',
        message: 'This driver already has an active or pending vehicle assignment. Complete or cancel it first.'
      };
    }

    const { data: vehiclePending } = await supabase
      .from('driver_assignments')
      .select('id, vehicle_id, driver_id, status')
      .eq('vehicle_id', vehicleId)
      .limit(20);
    const vehicleConflict = (vehiclePending || []).find((row) =>
      ['PENDING_OWNER_OTP', 'PENDING_DRIVER_ACCEPTANCE'].includes(row.status) && row.driver_id !== driverId
    );
    if (vehicleConflict) {
      return {
        allowed: false,
        reason: 'VEHICLE_ASSIGNMENT_PENDING',
        message: 'This vehicle already has a pending driver assignment awaiting verification or acceptance.'
      };
    }
  } catch {
    // Assignment table unavailable (legacy deployment) — active checks above still apply.
  }

  return { allowed: true, vehicle: targetVeh };
}

/**
 * Assign driver to vehicle enforcing strict 1-to-1 validation
 */
export async function assignDriverToVehicle({ vehicleId, driverId, supabase }) {
  const check = await canAssignDriverToVehicle({ vehicleId, driverId, supabase });
  if (!check.allowed) {
    return { success: false, error: check.message, reason: check.reason };
  }

  const { data, error } = await supabase
    .from('vehicles')
    .update({ assigned_driver_id: driverId })
    .eq('id', vehicleId)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, vehicle: data };
}

/**
 * Unassign driver from vehicle
 */
export async function unassignDriverFromVehicle({ vehicleId, supabase }) {
  // Capture the vehicle + driver phone BEFORE the release so the driver can be
  // notified (the row is mutated by the update).
  let previous = null;
  try {
    const { data } = await supabase.from('vehicles').select('*').eq('id', vehicleId).maybeSingle();
    previous = data || null;
  } catch { previous = null; }
  const previousPhone = await resolveDriverPhone({ supabase, vehicle: previous });

  const { data, error } = await supabase
    .from('vehicles')
    .update({ assigned_driver_id: null })
    .eq('id', vehicleId)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  if (previousPhone) {
    try {
      await notifyDriverUnassigned({
        supabase,
        driverPhone: previousPhone,
        plate: previous?.plate_number,
        reason: 'owner'
      });
    } catch (notifyErr) {
      console.warn('[vehicles] Driver unassignment notice skipped:', notifyErr.message);
    }
  }

  return { success: true, vehicle: data };
}


/**
 * Get the currently active/selected vehicle for a user session
 */
export function getActiveVehicle({ senderPhone, vehicles = [], chatSessions }) {
  if (!vehicles || vehicles.length === 0) return null;
  if (vehicles.length === 1) return vehicles[0];

  const session = chatSessions?.get?.(senderPhone);
  if (session && session.active_vehicle_id) {
    const found = vehicles.find(v => v.id === session.active_vehicle_id);
    if (found) return found;
  }

  // Default to first vehicle if none explicitly selected
  return vehicles[0];
}

/**
 * Set the currently active/selected vehicle for a user session
 */
export function setActiveVehicle({ senderPhone, vehicleId, chatSessions }) {
  if (!chatSessions) return;
  const session = chatSessions.get(senderPhone) || { history: [], lastActive: Date.now() };
  session.active_vehicle_id = vehicleId;
  session.lastActive = Date.now();
  chatSessions.set(senderPhone, session);
}

/**
 * Match vehicle by plate number, make/model keyword, or list index (1-based)
 */
export function findVehicleByCandidate(vehicles = [], candidate = '') {
  if (!vehicles || vehicles.length === 0) return null;
  if (!candidate) return null;

  const clean = candidate.trim().toUpperCase();
  const cleanNoSpaces = clean.replace(/\s+/g, '');

  // 1. Check exact or condensed plate match
  const plateMatch = vehicles.find(v => {
    const p = (v.plate_number || '').replace(/\s+/g, '').toUpperCase();
    return p === cleanNoSpaces || p.includes(cleanNoSpaces);
  });
  if (plateMatch) return plateMatch;

  // 2. Check numeric index (e.g., "1", "2")
  if (/^\d+$/.test(clean)) {
    const idx = parseInt(clean, 10) - 1;
    if (idx >= 0 && idx < vehicles.length) {
      return vehicles[idx];
    }
  }

  // 3. Check make/model match (e.g. "demio", "fielder", "land cruiser")
  const lowerCand = candidate.toLowerCase();
  const modelMatch = vehicles.find(v => (v.make_model || '').toLowerCase().includes(lowerCand));
  if (modelMatch) return modelMatch;

  return null;
}

/**
 * Columns that may be edited after registration.
 * VIN and the passbook token are intentionally excluded — they are immutable.
 */
export const EDITABLE_VEHICLE_FIELDS = [
  'plate_number',
  'make_model',
  'yom',
  'year_of_manufacture',
  'fuel_type',
  'current_mileage',
  'odometer_reading',
  'status',
  'owner_email',
  'owner_phone',
  'engine_number',
  'color',
  'transmission',
  'tire_size',
  'insurance_policy',
  'insurance_expiry',
  'inspection_expiry',
  'road_license_expiry',
  'road_license_number',
  'permit_expiry',
  'permit_number',
  'purchase_cost',
  'custom_attributes',
  'metadata',
  'other_details',
  'is_business',
  'opt_in_earnings',
  'audit_report_frequency'
];

/** Permanently locked fields — VIN + passbook token never change. */
export const IMMUTABLE_VEHICLE_FIELDS = ['vin', 'qr_passbook_token'];

export const PENDING_TRANSFER_STATUSES = [
  'PENDING_TARGET_DETAILS',
  'PENDING_OWNER_RELEASE_OTP',
  'PENDING_BUYER_ACCEPTANCE',
  'PENDING_BUYER_OTP',
  'PENDING'
];

/**
 * Strip immutable/unknown keys from an update payload.
 * Returns { updates, rejected } where rejected lists immutable keys the caller tried to change.
 */
export function sanitizeVehicleUpdates(updates = {}) {
  const safe = {};
  const rejected = [];

  for (const [key, value] of Object.entries(updates || {})) {
    if (IMMUTABLE_VEHICLE_FIELDS.includes(key)) {
      rejected.push(key);
      continue;
    }
    if (!EDITABLE_VEHICLE_FIELDS.includes(key)) continue;
    safe[key] = value;
  }

  // Keep alias pairs in sync so downstream analytics stay consistent.
  if (safe.yom !== undefined && safe.year_of_manufacture === undefined) safe.year_of_manufacture = safe.yom;
  if (safe.year_of_manufacture !== undefined && safe.yom === undefined) safe.yom = safe.year_of_manufacture;
  if (safe.current_mileage !== undefined && safe.odometer_reading === undefined) safe.odometer_reading = safe.current_mileage;
  if (safe.odometer_reading !== undefined && safe.current_mileage === undefined) safe.current_mileage = safe.odometer_reading;

  return { updates: safe, rejected };
}

/**
 * Confirm that requesterId is the registered owner of an active vehicle.
 */
export async function isVehicleOwner({ vehicleId, requesterId, supabase }) {
  if (!vehicleId || !requesterId || !supabase) return false;
  const { data } = await supabase
    .from('vehicles')
    .select('id, owner_id')
    .eq('id', vehicleId)
    .is('deleted_at', null)
    .maybeSingle();
  return !!(data && data.owner_id === requesterId);
}

/**
 * Update editable vehicle details.
 * VIN is rejected at the service layer in addition to the database trigger,
 * guaranteeing it remains immutable once registered.
 */
export async function updateVehicleDetails({ vehicleId, requesterId, updates = {}, supabase }) {
  if (!supabase) return { success: false, error: 'Database client unavailable.' };
  if (!vehicleId) return { success: false, error: 'Vehicle ID is required.' };
  if (!requesterId) return { success: false, error: 'Requester identity is required.' };

  const { data: vehicle, error: fetchErr } = await supabase
    .from('vehicles')
    .select('*')
    .eq('id', vehicleId)
    .is('deleted_at', null)
    .maybeSingle();

  if (fetchErr) return { success: false, error: fetchErr.message };
  if (!vehicle) return { success: false, error: 'Vehicle not found or already deleted.' };
  if (vehicle.owner_id !== requesterId) {
    return { success: false, error: 'Only the registered vehicle owner can edit these details.', reason: 'NOT_OWNER' };
  }

  const { updates: safeUpdates, rejected } = sanitizeVehicleUpdates(updates);

  // Block plate collisions with another active vehicle.
  if (safeUpdates.plate_number) {
    const nextPlate = String(safeUpdates.plate_number).toUpperCase().trim();
    safeUpdates.plate_number = nextPlate;
    const { data: clash } = await supabase
      .from('vehicles')
      .select('id, plate_number')
      .eq('plate_number', nextPlate)
      .neq('id', vehicleId)
      .is('deleted_at', null)
      .maybeSingle();
    if (clash) {
      return {
        success: false,
        error: `Plate ${nextPlate} is already registered to another active vehicle.`,
        reason: 'PLATE_CONFLICT'
      };
    }
  }

  if (Object.keys(safeUpdates).length === 0) {
    return {
      success: false,
      error: rejected.length
        ? 'The VIN and passbook token are permanently immutable and cannot be edited.'
        : 'No editable vehicle fields were supplied.',
      reason: rejected.length ? 'IMMUTABLE_FIELD' : 'NO_EDITABLE_FIELDS',
      rejected
    };
  }

  safeUpdates.updated_at = new Date().toISOString();

  const { data: updated, error } = await supabase
    .from('vehicles')
    .update(safeUpdates)
    .eq('id', vehicleId)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (error) return { success: false, error: error.message, rejected };

  // Keep the owner profile email in sync when the contact email changes.
  if (safeUpdates.owner_email && vehicle.owner_id) {
    try {
      await supabase
        .from('profiles')
        .update({ email: safeUpdates.owner_email, updated_at: new Date().toISOString() })
        .eq('id', vehicle.owner_id);
    } catch {}
  }

  return { success: true, vehicle: updated, applied: safeUpdates, rejected };
}

/**
 * Delete a vehicle for its owner.
 * - Soft-deletes the vehicle row (deleted_at + status = 'DELETED')
 * - Unassigns any linked driver (keeps the strict 1-to-1 invariant intact)
 * - Cancels in-flight passbook transfers
 * - Retires active reminders
 * - Preserves historical logs and the permanent VIN trial ledger
 */
export async function deleteVehicle({ vehicleId, requesterId, supabase }) {
  if (!supabase) return { success: false, error: 'Database client unavailable.' };
  if (!vehicleId) return { success: false, error: 'Vehicle ID is required.' };
  if (!requesterId) return { success: false, error: 'Requester identity is required.' };

  const { data: vehicle, error: fetchErr } = await supabase
    .from('vehicles')
    .select('*')
    .eq('id', vehicleId)
    .is('deleted_at', null)
    .maybeSingle();

  if (fetchErr) return { success: false, error: fetchErr.message };
  if (!vehicle) return { success: false, error: 'Vehicle not found or already deleted.' };
  if (vehicle.owner_id !== requesterId) {
    return { success: false, error: 'Only the registered vehicle owner can delete this vehicle.', reason: 'NOT_OWNER' };
  }

  const nowIso = new Date().toISOString();
  const cleanup = { driverUnassigned: !!vehicle.assigned_driver_id, transfersCancelled: 0 };
  const driverPhone = cleanup.driverUnassigned ? await resolveDriverPhone({ supabase, vehicle }) : null;

  // 1. Cancel in-flight passbook transfers for this vehicle.
  try {
    const { data: pending } = await supabase
      .from('passbook_transfers')
      .select('id')
      .eq('vehicle_id', vehicleId)
      .in('status', PENDING_TRANSFER_STATUSES);

    if (pending && pending.length > 0) {
      await supabase
        .from('passbook_transfers')
        .update({ status: 'CANCELLED' })
        .eq('vehicle_id', vehicleId)
        .in('status', PENDING_TRANSFER_STATUSES);
      cleanup.transfersCancelled = pending.length;
    }
  } catch (err) {
    console.warn('[deleteVehicle] Transfer cleanup skipped:', err.message);
  }

  // 2. Soft-delete the vehicle and release the driver in a single update.
  const { data: deleted, error } = await supabase
    .from('vehicles')
    .update({
      assigned_driver_id: null,
      status: 'DELETED',
      deleted_at: nowIso,
      updated_at: nowIso
    })
    .eq('id', vehicleId)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (error) return { success: false, error: error.message };

  // 3. Retire active reminders so they stop firing (history is retained).
  try {
    await supabase
      .from('reminders')
      .update({ status: 'cancelled' })
      .eq('vehicle_id', vehicleId)
      .eq('status', 'active');
  } catch {}

  // 4. Tell the released driver the vehicle is gone (v1.16.4, fail-soft).
  if (driverPhone) {
    try {
      await notifyDriverUnassigned({ supabase, driverPhone, plate: vehicle.plate_number, reason: 'vehicle_deleted' });
    } catch (notifyErr) {
      console.warn('[deleteVehicle] Driver notice skipped:', notifyErr.message);
    }
  }

  return {
    success: true,
    vehicle: deleted || vehicle,
    cleanup,
    preserved: {
      vin: vehicle.vin,
      vinLedgerRetained: true,
      historicalLogsRetained: true
    }
  };
}

