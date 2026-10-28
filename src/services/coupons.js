import crypto from 'crypto';
import { sendTrialExtensionReminderEmail } from './mailer.js';
import { initializePaystackCheckout } from './paystack.js';

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
    const { data: inserted, error } = await supabase.from('coupons').insert([{
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
      expires_at: expiresAt
    }]).select().single();

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
export async function processImpendingTrialReminders({
  supabase,
  sendWhatsAppMessageFn
}) {
  if (!supabase) return;

  const nowIso = new Date().toISOString();

  // 1. Process 3-Day Pre-Expiry Coupons
  try {
    const { data: pendingCoupons, error: cErr } = await supabase
      .from('coupons')
      .select('*')
      .eq('status', 'scheduled')
      .lte('scheduled_dispatch_at', nowIso)
      .limit(50);

    if (!cErr && pendingCoupons && pendingCoupons.length > 0) {
      for (const coup of pendingCoupons) {
        let vehicle = null;
        if (coup.vin) {
          const { data: v } = await supabase
            .from('vehicles')
            .select('*, profiles!vehicles_owner_id_fkey(full_name, phone_number, email)')
            .eq('vin', coup.vin)
            .is('deleted_at', null)
            .maybeSingle();
          vehicle = v;
        }

        const ownerPhone = coup.assigned_to_phone || vehicle?.owner_phone || vehicle?.profiles?.phone_number;
        const ownerEmail = vehicle?.owner_email || vehicle?.profiles?.email;
        const ownerName = vehicle?.profiles?.full_name || 'Fleet Owner';
        const plate = vehicle?.plate_number || 'Vehicle';
        const vin = coup.vin || vehicle?.vin || 'N/A';

        if (ownerEmail) {
          await sendTrialExtensionReminderEmail({
            targetEmail: ownerEmail,
            ownerName,
            plateNumber: plate,
            vin,
            couponCode: coup.code,
            trialEndDate: vehicle?.trial_end_at ? new Date(vehicle.trial_end_at).toLocaleDateString() : '3 days'
          });
        }

        if (ownerPhone && sendWhatsAppMessageFn) {
          const waMsg = `Hi ${ownerName}! 👋 Your trial for VIN ${vin} (${plate}) ends in 3 days!\n\nWould you like me to apply your extension coupon (*${coup.code}*) to add 30 free days? Reply *"Yes"* to activate!`;
          await sendWhatsAppMessageFn(ownerPhone, waMsg);
        }

        await supabase.from('coupons').update({
          status: 'dispatched',
          email_notified: !!ownerEmail,
          whatsapp_notified: !!ownerPhone,
          dispatched_at: new Date().toISOString()
        }).eq('id', coup.id);

        console.log(`[Coupons] Dispatched 3-day reminder for VIN ${vin} to ${ownerPhone || ownerEmail}`);
      }
    }
  } catch (err) {
    console.error('[Coupons Worker Error (3-day reminders)]:', err);
  }

  // 2. Process 15-Day Overdue Winback Offers (40% OFF Annual Subscription)
  try {
    const fifteenDaysAgoIso = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const sixteenDaysAgoIso = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString();

    const { data: overdueVehicles, error: vErr } = await supabase
      .from('vehicles')
      .select('*, profiles!vehicles_owner_id_fkey(id, full_name, phone_number, email, subscription_tier, subscription_status)')
      .lte('trial_end_at', fifteenDaysAgoIso)
      .gte('trial_end_at', sixteenDaysAgoIso)
      .neq('trial_status', 'subscribed')
      .is('deleted_at', null)
      .limit(20);

    if (!vErr && overdueVehicles && overdueVehicles.length > 0) {
      for (const v of overdueVehicles) {
        const ownerPhone = v.owner_phone || v.profiles?.phone_number;
        if (!ownerPhone) continue;

        const { data: existingWb } = await supabase
          .from('coupons')
          .select('id')
          .eq('assigned_to_phone', ownerPhone)
          .eq('applicable_to', 'annual_subscription')
          .maybeSingle();

        if (existingWb) continue;

        const wbCoupon = await generateWinback40Coupon({
          ownerPhone,
          ownerId: v.owner_id,
          vin: v.vin,
          supabase
        });

        if (wbCoupon && sendWhatsAppMessageFn) {
          const checkout = await initializePaystackCheckout({
            supabase,
            userPhone: ownerPhone,
            targetTierKey: 'solo_pro',
            billingInterval: 'annual',
            userEmail: v.owner_email || v.profiles?.email,
            userId: v.owner_id,
            currency: 'USD'
          }).catch(() => null);

          const expiryDateStr = new Date(wbCoupon.expires_at).toLocaleDateString();
          const winbackMsg = `🎁 *Special Offer from Saka Fleet!*\n\nWe noticed your Saka Fleet trial expired 15 days ago. For the next 15 days only, enjoy *40% OFF* your first year of an Annual Subscription!\n\n• *Coupon Code:* *${wbCoupon.code}*\n• *Discount:* 40% OFF (Annual Only)\n• *Expires:* ${expiryDateStr}\n\n👉 *Claim Your Offer:* ${checkout?.checkoutUrl || 'https://sakafleet.com/pricing'}`;

          await sendWhatsAppMessageFn(ownerPhone, winbackMsg);
          console.log(`[Coupons] Dispatched 15-day overdue winback offer to ${ownerPhone}`);
        }
      }
    }
  } catch (err) {
    console.error('[Coupons Worker Error (15-day winback)]:', err);
  }
}


