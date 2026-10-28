import dotenv from 'dotenv';
dotenv.config();

export async function ensureVehicleTableColumns(providedSupabase = null) {
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    try {
      const projectRef = (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0];
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
      `;
      const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: sql })
      });
      if (!res.ok) {
        const errText = await res.text();
        console.warn('ensureVehicleTableColumns warning:', errText);
      } else {
        console.log('✅ Supabase vehicles table columns verified and ensured.');
      }
    } catch (err) {
      console.warn('ensureVehicleTableColumns error:', err.message);
    }
  }
}


/**
 * Check if owner can register an additional vehicle under their subscription tier
 */
export async function checkOwnerVehicleTierLimit({ ownerId, subscriptionTier = 'free', supabase }) {
  const TIER_LIMITS = {
    free: 1,
    solo_pro: 3,
    growth: 5,
    scale: 10,
    fleet_starter: 10,
    unlimited: Infinity,
    enterprise: Infinity
  };

  const limit = TIER_LIMITS[subscriptionTier] !== undefined ? TIER_LIMITS[subscriptionTier] : 1;

  let nextTierKey = 'solo_pro';
  if (subscriptionTier === 'solo_pro') nextTierKey = 'growth';
  else if (subscriptionTier === 'growth') nextTierKey = 'scale';
  else if (subscriptionTier === 'scale') nextTierKey = 'unlimited';

  if (limit === Infinity) {
    return { canAdd: true, currentCount: 0, limit, tier: subscriptionTier, nextTierKey: null };
  }

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
    tier: subscriptionTier,
    nextTierKey
  };
}

/**
 * Asset-Bound Trial Engine:
 * Every unique vehicle VIN gets a one-time 1-month (30-day) free trial upon its first-ever registration passbook creation.
 * Subsequent registrations or transfers preserve the existing trial or require active subscription slots.
 */
export async function getOrCreateVinTrial({ vin, ownerId, vehicleId, supabase }) {
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
  const { data, error } = await supabase
    .from('vehicles')
    .update({ assigned_driver_id: null })
    .eq('id', vehicleId)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
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

