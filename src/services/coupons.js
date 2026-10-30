import crypto from 'crypto';

/**
 * Schedule a 30-day trial extension coupon upon email OTP confirmation
 */
export async function scheduleTrialExtensionCoupon({
  vin,
  ownerId,
  ownerPhone,
  ownerEmail,
  trialEndAt,
  supabase
}) {
  // @deprecated v1.16.0 — VIN-bound trial extensions are retired. Kept for
  // historical replays/tests only; production registration no longer calls it.
  console.warn('[Coupons] scheduleTrialExtensionCoupon is deprecated — account trials use trialEngine.scheduleAccountTrialExtensionCoupon.');
  if (!vin || !supabase) return null;
  const cleanVin = vin.toUpperCase().trim();

  try {
    const { data: existingCoupon } = await supabase
      .from('coupons')
      .select('*')
      .eq('vin', cleanVin)
      .eq('applicable_to', 'trial_extension')
      .maybeSingle();

    if (existingCoupon) {
      return existingCoupon;
    }

    const code = `EXT30-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const baseEnd = trialEndAt ? new Date(trialEndAt).getTime() : Date.now() + 30 * 24 * 60 * 60 * 1000;
    // Exactly 3 days before trial ends
    const scheduledDispatchAt = new Date(baseEnd - 3 * 24 * 60 * 60 * 1000).toISOString();

    const couponRecord = {
      code,
      discount_percent: 100,
      trial_extension_days: 30,
      max_uses: 1,
      current_uses: 0,
      created_by: 'EMAIL_OTP_CONFIRMATION',
      vin: cleanVin,
      assigned_to_phone: ownerPhone || null,
      applicable_to: 'trial_extension',
      scheduled_dispatch_at: scheduledDispatchAt,
      status: 'scheduled',
      expires_at: new Date(baseEnd + 7 * 24 * 60 * 60 * 1000).toISOString()
    };

    const { data: inserted, error } = await supabase
      .from('coupons')
      .insert([couponRecord])
      .select()
      .single();

    if (error) {
      console.warn('[Coupons] Failed to schedule trial extension coupon:', error.message);
      return null;
    }

    await supabase
      .from('vin_registry')
      .update({ trial_extension_coupon_id: inserted.id })
      .eq('vin', cleanVin);

    console.log(`[Coupons] Scheduled 30-day extension coupon ${code} for VIN ${cleanVin}`);
    return inserted;
  } catch (err) {
    console.error('[Coupons] Error scheduling coupon:', err.message);
    return null;
  }
}

/**
 * Apply trial extension coupon to vehicle and VIN registry
 */
export async function applyTrialExtensionCoupon({
  vin,
  phone,
  couponCode,
  supabase
}) {
  // @deprecated v1.16.0 — legacy VIN-bound redemption for historical coupons.
  // New redemptions route through trialEngine.applyAccountTrialExtensionCoupon.
  console.warn('[Coupons] applyTrialExtensionCoupon is deprecated — use the account trial engine.');
  if (!supabase) return { success: false, error: 'Database client required' };

  try {
    let query = supabase.from('coupons').select('*');

    if (couponCode) {
      query = query.eq('code', couponCode.toUpperCase().trim());
    } else if (vin) {
      query = query.eq('vin', vin.toUpperCase().trim()).eq('applicable_to', 'trial_extension');
    } else if (phone) {
      const cleanPhone = phone.startsWith('+') ? phone : `+${phone.replace(/[^\d]/g, '')}`;
      query = query.eq('assigned_to_phone', cleanPhone).eq('applicable_to', 'trial_extension');
    }

    const { data: couponsList, error } = await query;
    if (error || !couponsList || couponsList.length === 0) {
      return { success: false, error: 'No applicable extension coupon found' };
    }

    const coupon = couponsList.find(c => c.status !== 'applied' && c.current_uses < (c.max_uses || 1)) || couponsList[0];

    if (coupon.status === 'applied' || coupon.current_uses >= (coupon.max_uses || 1)) {
      return { success: false, error: 'Extension coupon has already been redeemed for this vehicle.' };
    }

    const targetVin = coupon.vin;

    let targetVeh = null;
    if (targetVin) {
      const { data: veh } = await supabase
        .from('vehicles')
        .select('*')
        .eq('vin', targetVin)
        .is('deleted_at', null)
        .maybeSingle();
      targetVeh = veh;
    }

    if (!targetVeh && phone) {
      const cleanPhone = phone.startsWith('+') ? phone : `+${phone.replace(/[^\d]/g, '')}`;
      const { data: veh } = await supabase
        .from('vehicles')
        .select('*')
        .eq('owner_phone', cleanPhone)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      targetVeh = veh;
    }

    const currentExpiry = targetVeh?.trial_end_at ? new Date(targetVeh.trial_end_at).getTime() : Date.now();
    const extensionMs = (coupon.trial_extension_days || 30) * 24 * 60 * 60 * 1000;
    const newTrialEndAt = new Date(Math.max(Date.now(), currentExpiry) + extensionMs).toISOString();

    await supabase.from('coupons').update({
      status: 'applied',
      current_uses: (coupon.current_uses || 0) + 1,
      dispatched_at: coupon.dispatched_at || new Date().toISOString()
    }).eq('id', coupon.id);

    if (targetVeh) {
      await supabase.from('vehicles').update({
        trial_end_at: newTrialEndAt,
        trial_status: 'extended',
        updated_at: new Date().toISOString()
      }).eq('id', targetVeh.id);
    }

    if (targetVin) {
      await supabase.from('vin_registry').update({
        trial_extended: true,
        trial_status: 'extended',
        trial_end_at: newTrialEndAt,
        updated_at: new Date().toISOString()
      }).eq('vin', targetVin);
    }

    return {
      success: true,
      couponCode: coupon.code,
      vin: targetVin,
      plateNumber: targetVeh?.plate_number || 'Vehicle',
      newTrialEndAt,
      daysAdded: coupon.trial_extension_days || 30
    };
  } catch (err) {
    console.error('[Coupons] Error applying extension coupon:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Generate 40% OFF Annual Subscription Win-back Coupon (15 days TTL)
 */
export async function generateWinback40Coupon({
  ownerPhone,
  ownerId,
  vin,
  supabase
}) {
  if (!supabase) return null;
  const cleanPhone = ownerPhone ? (ownerPhone.startsWith('+') ? ownerPhone : `+${ownerPhone.replace(/[^\d]/g, '')}`) : null;
  const code = `WINBACK40-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const record = {
      code,
      discount_percent: 40,
      max_uses: 1,
      current_uses: 0,
      created_by: 'WINBACK_15D_OVERDUE',
      assigned_to_phone: cleanPhone,
      vin: vin || null,
      applicable_to: 'annual_subscription',
      status: 'dispatched',
      dispatched_at: new Date().toISOString(),
      expires_at: expiresAt,
      // v1.16.0 — account-first binding for commercial coupons.
      owner_id: ownerId || null
    };

    let { data: inserted, error } = await supabase.from('coupons').insert([record]).select().single();
    if (error) {
      // Pre-migration fallback: retry without the owner_id column.
      const { owner_id, ...fallback } = record;
      const retry = await supabase.from('coupons').insert([fallback]).select().single();
      inserted = retry.data;
      error = retry.error;
    }

    if (error) {
      console.warn('[Coupons] Error creating winback coupon:', error.message);
      return null;
    }
    return inserted;
  } catch (err) {
    console.error('[Coupons] Winback coupon exception:', err.message);
    return null;
  }
}

/**
 * Worker: Process Impending Trial Reminders (3 days out) and 15-day Overdue Winback
 */
export async function processImpendingTrialReminders({ supabase } = {}) {
  // v1.16.0 — RETIRED as a messaging worker. Trials are account-bound and the
  // single lifecycle worker is trialEngine.runTrialLifecycleSweep (account
  // extension offers + 15-day winback live there). This shim only retires
  // legacy VIN-bound scheduled coupons so they can never fire phantom messages.
  if (!supabase) return { retired: 0 };

  try {
    const { data: legacyCoupons } = await supabase
      .from('coupons')
      .select('id')
      .eq('applicable_to', 'trial_extension')
      .eq('status', 'scheduled')
      .limit(200);

    const ids = (legacyCoupons || []).map((row) => row.id);
    if (ids.length === 0) return { retired: 0 };

    await supabase.from('coupons').update({
      status: 'superseded',
      updated_at: new Date().toISOString()
    }).in('id', ids);

    console.log(`[Coupons] Superseded ${ids.length} legacy VIN-bound trial coupon(s) — account-bound trials since v1.16.0.`);
    return { retired: ids.length };
  } catch (err) {
    console.warn('[Coupons] Legacy VIN coupon retire skipped:', err.message);
    return { retired: 0, error: err.message };
  }
}



/**
 * Validate a coupon for a subscription checkout (v1.15.0).
 * Supports percentage discounts, flat reductions and tier/interval scoping.
 * Trial-extension coupons are deliberately NOT checkout discounts — they are
 * redeemed through `trialEngine.applyAccountTrialExtensionCoupon`.
 */
export async function validateCouponForCheckout({
  supabase,
  code,
  tierKey = 'free',
  interval = 'monthly',
  ownerId = null,
  currency = 'USD',
  amountUSD = null
} = {}) {
  if (!supabase || !code) return { valid: false, error: 'Coupon code required' };
  const cleanCode = String(code).toUpperCase().trim();
  const canonicalInterval = interval === 'annual' ? 'annual' : 'monthly';

  try {
    const { data: coupon, error } = await supabase
      .from('coupons')
      .select('*')
      .eq('code', cleanCode)
      .maybeSingle();
    if (error || !coupon) return { valid: false, error: 'Coupon not found.' };

    if (coupon.status === 'applied') return { valid: false, error: 'Coupon already redeemed.' };
    if (coupon.status === 'expired') return { valid: false, error: 'Coupon expired.' };
    if (Number(coupon.current_uses || 0) >= Number(coupon.max_uses || 1)) {
      return { valid: false, error: 'Coupon usage limit reached.' };
    }
    if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) {
      return { valid: false, error: 'Coupon expired.' };
    }

    const applicableTo = String(coupon.applicable_to || '').toLowerCase();
    if (applicableTo === 'trial_extension' || applicableTo === 'account_trial_extension') {
      return { valid: false, error: 'This coupon extends a trial — reply *"extend trial"* to redeem it.' };
    }
    if (applicableTo === 'annual_subscription' && canonicalInterval !== 'annual') {
      return { valid: false, error: 'This coupon applies to the annual plan only.' };
    }
    if (coupon.assigned_to_phone && ownerId) {
      const { data: owner } = await supabase
        .from('profiles')
        .select('phone_number')
        .eq('id', ownerId)
        .maybeSingle();
      if (owner?.phone_number && owner.phone_number.replace(/[^\d]/g, '') !== String(coupon.assigned_to_phone).replace(/[^\d]/g, '')) {
        return { valid: false, error: 'This coupon belongs to another account.' };
      }
    }

    const tierScope = String(coupon.applies_to_tier || '').toLowerCase();
    if (tierScope && tierScope !== 'all') {
      const allowed = tierScope.split(',').map((t) => t.trim());
      if (!allowed.includes(String(tierKey).toLowerCase())) {
        return { valid: false, error: 'This coupon does not apply to the selected plan.' };
      }
    }
    const intervalScope = String(coupon.applies_to_interval || 'both').toLowerCase();
    if (intervalScope !== 'both' && intervalScope !== 'all' && intervalScope !== canonicalInterval) {
      return { valid: false, error: `This coupon applies to ${intervalScope} billing only.` };
    }

    const baseAmount = Number.isFinite(Number(amountUSD)) && Number(amountUSD) > 0
      ? Number(amountUSD)
      : 0;
    const percent = Number(coupon.discount_percent || 0);
    const flat = Number(coupon.discount_amount || 0);
    const isFlat = flat > 0 && percent <= 0;
    const discountType = isFlat ? 'flat' : 'percent';
    let discountUSD = 0;
    if (isFlat) {
      discountUSD = Math.min(baseAmount || flat, flat);
    } else if (percent > 0) {
      discountUSD = Number(((baseAmount || 0) * percent / 100).toFixed(2));
    }

    return {
      valid: true,
      coupon,
      code: coupon.code,
      discountType,
      discountPercent: isFlat ? 0 : percent,
      discountUSD,
      currency: coupon.discount_currency || currency,
      payableUSD: Math.max(0, Number(((baseAmount || 0) - discountUSD).toFixed(2)))
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/** Mark a coupon redeemed (idempotent enough for a single checkout flow). */
export async function markCouponRedeemed({ supabase, coupon, ownerId = null, redemptionType = 'subscription' } = {}) {
  if (!supabase || !coupon?.id) return { ok: false };
  try {
    await supabase.from('coupons').update({
      status: 'applied',
      current_uses: Number(coupon.current_uses || 0) + 1,
      redeemed_at: new Date().toISOString(),
      redemption_type: redemptionType,
      dispatched_at: coupon.dispatched_at || new Date().toISOString()
    }).eq('id', coupon.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

