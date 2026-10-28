import crypto from 'crypto';
import { sendEmailOtp, sendTransferReleasePinEmail, sendPassbookWelcomeEmail } from './mailer.js';
import { getEffectiveExchangeRate } from './paystack.js';
import { findVehicleByCandidate } from './vehicles.js';

/**
 * Step 1: Initiate passbook transfer by current owner
 */
export async function initiatePassbookTransfer({ fromPhone, vehicleCandidate, supabase }) {
  if (!supabase || !fromPhone) {
    return { success: false, error: 'Database client and sender phone are required' };
  }

  const cleanFromPhone = fromPhone.startsWith('+') ? fromPhone : `+${fromPhone.replace(/[^\d]/g, '')}`;

  try {
    const { data: ownerProfile } = await supabase
      .from('profiles')
      .select('id, phone_number, full_name, email')
      .eq('phone_number', cleanFromPhone)
      .maybeSingle();

    if (!ownerProfile) {
      return { success: false, error: 'Owner profile not found.' };
    }

    const { data: vehicles, error: vErr } = await supabase
      .from('vehicles')
      .select('*')
      .eq('owner_id', ownerProfile.id)
      .is('deleted_at', null);

    if (vErr || !vehicles || vehicles.length === 0) {
      return { success: false, error: `Vehicle "${vehicleCandidate || ''}" was not found in your registered fleet.` };
    }

    let targetVeh = vehicles[0];
    if (vehicleCandidate) {
      const found = findVehicleByCandidate(vehicles, vehicleCandidate);
      if (found) {
        targetVeh = found;
      } else {
        return { success: false, error: `Vehicle "${vehicleCandidate}" was not found in your registered fleet.` };
      }
    }

    // Check if there's already a pending transfer in flight
    const { data: activeTransfer } = await supabase
      .from('passbook_transfers')
      .select('*')
      .eq('vehicle_id', targetVeh.id)
      .in('status', ['PENDING_TARGET_DETAILS', 'PENDING_OWNER_RELEASE_OTP', 'PENDING_BUYER_ACCEPTANCE', 'PENDING_BUYER_OTP'])
      .maybeSingle();

    if (activeTransfer) {
      return {
        success: false,
        isExistingPending: true,
        transferId: activeTransfer.id,
        error: `There is already an active transfer in progress for ${targetVeh.plate_number}. Reply "cancel transfer" to abort it first.`
      };
    }

    // Check Annual Transfer Quota: 1 free transfer per vehicle per calendar year
    const currentYear = new Date().getFullYear();
    const yearStartIso = new Date(currentYear, 0, 1).toISOString();

    const { count: completedTransfersCount } = await supabase
      .from('passbook_transfers')
      .select('id', { count: 'exact', head: true })
      .eq('vehicle_id', targetVeh.id)
      .eq('status', 'COMPLETED')
      .gte('completed_at', yearStartIso);

    const isFreeTransfer = (completedTransfersCount || 0) === 0;
    const feeAmount = isFreeTransfer ? 0 : 3.00;

    const { data: newTransfer, error: insErr } = await supabase
      .from('passbook_transfers')
      .insert([{
        vehicle_id: targetVeh.id,
        vin: targetVeh.vin,
        from_owner_id: ownerProfile.id,
        is_free_transfer: isFreeTransfer,
        fee_amount: feeAmount,
        fee_currency: 'USD',
        transfer_fee_paid: isFreeTransfer,
        status: 'PENDING_TARGET_DETAILS',
        initiated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (insErr) {
      return { success: false, error: `Failed to initiate transfer: ${insErr.message}` };
    }

    return {
      success: true,
      transferId: newTransfer.id,
      vehicle: targetVeh,
      ownerProfile,
      isFreeTransfer,
      feeAmount
    };
  } catch (err) {
    console.error('[Transfers] Error initiating transfer:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Step 2: Capture buyer's phone and email, and dispatch 6-digit release PIN to owner
 */
export async function setBuyerDetailsAndSendReleaseOtp({ transferId, buyerPhone, buyerEmail, supabase }) {
  if (!supabase || !transferId || !buyerPhone || !buyerEmail) {
    return { success: false, error: 'Transfer ID, buyer phone, and buyer email are required' };
  }

  const cleanBuyerPhone = buyerPhone.startsWith('+') ? buyerPhone : `+${buyerPhone.replace(/[^\d]/g, '')}`;
  const cleanBuyerEmail = buyerEmail.toLowerCase().trim();

  try {
    const { data: transfer, error: tErr } = await supabase
      .from('passbook_transfers')
      .select('*, vehicles!passbook_transfers_vehicle_id_fkey(*), profiles!passbook_transfers_from_owner_id_fkey(*)')
      .eq('id', transferId)
      .single();

    if (tErr || !transfer) {
      return { success: false, error: 'Transfer record not found' };
    }

    const releasePin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase.from('passbook_transfers').update({
      to_owner_phone: cleanBuyerPhone,
      to_owner_email: cleanBuyerEmail,
      release_otp: releasePin,
      release_otp_expires_at: expiresAt,
      status: 'PENDING_OWNER_RELEASE_OTP'
    }).eq('id', transferId);

    const ownerEmail = transfer.vehicles?.owner_email || transfer.profiles?.email;
    const ownerName = transfer.profiles?.full_name || 'Fleet Owner';
    const plate = transfer.vehicles?.plate_number || 'Vehicle';
    const vin = transfer.vin || transfer.vehicles?.vin || 'N/A';

    if (ownerEmail) {
      await sendTransferReleasePinEmail({
        targetEmail: ownerEmail,
        ownerName,
        plateNumber: plate,
        vin,
        releasePin
      });
    }

    return {
      success: true,
      releasePin,
      ownerEmail,
      buyerPhone: cleanBuyerPhone,
      buyerEmail: cleanBuyerEmail,
      vehicle: transfer.vehicles
    };
  } catch (err) {
    console.error('[Transfers] Error in Step 2:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Step 3: Owner enters release PIN -> Authorize asset release & message buyer on WhatsApp
 */
export async function verifyOwnerReleaseOtpAndNotifyBuyer({ transferId, providedOtp, supabase, sendWhatsAppFn }) {
  if (!supabase || !transferId || !providedOtp) {
    return { success: false, error: 'Transfer ID and OTP are required' };
  }

  const cleanOtp = providedOtp.toString().trim();

  try {
    const { data: transfer, error: tErr } = await supabase
      .from('passbook_transfers')
      .select('*, vehicles!passbook_transfers_vehicle_id_fkey(*), profiles!passbook_transfers_from_owner_id_fkey(*)')
      .eq('id', transferId)
      .single();

    if (tErr || !transfer) {
      return { success: false, error: 'Transfer record not found' };
    }

    if (transfer.status !== 'PENDING_OWNER_RELEASE_OTP') {
      return { success: false, error: `Transfer is not awaiting release PIN (current status: ${transfer.status})` };
    }

    if (transfer.release_otp !== cleanOtp) {
      return { success: false, error: 'Invalid 6-digit release PIN. Please check your email and try again.' };
    }

    if (new Date() > new Date(transfer.release_otp_expires_at)) {
      return { success: false, error: 'Release PIN has expired. Please initiate a new transfer request.' };
    }

    await supabase.from('passbook_transfers').update({
      status: 'PENDING_BUYER_ACCEPTANCE'
    }).eq('id', transferId);

    const buyerPhone = transfer.to_owner_phone;
    const sellerName = transfer.profiles?.full_name || 'Fleet Owner';
    const sellerPhone = transfer.profiles?.phone_number || '';
    const plate = transfer.vehicles?.plate_number || 'Vehicle';
    const makeModel = transfer.vehicles?.make_model || 'Vehicle';
    const vin = transfer.vin || transfer.vehicles?.vin || 'N/A';

    if (buyerPhone && sendWhatsAppFn) {
      const buyerMsg = `🚗 *Saka Fleet Passbook Transfer Request*\n\nHello! *${sellerName}* (${sellerPhone}) has initiated a passbook transfer for *${makeModel}* (Plate: *${plate}*, VIN: \`${vin}\`).\n\nReply *"ACCEPT"* to claim ownership of this vehicle passbook.\n_(Or reply "DECLINE" to reject)_`;
      await sendWhatsAppFn(buyerPhone, buyerMsg);
    }

    return {
      success: true,
      buyerPhone,
      plateNumber: plate,
      vin,
      isFreeTransfer: transfer.is_free_transfer
    };
  } catch (err) {
    console.error('[Transfers] Error in Step 3:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Step 4: Buyer replies "ACCEPT" -> Check fee or dispatch buyer email OTP
 */
export async function handleBuyerAcceptance({ buyerPhone, supabase, sendWhatsAppFn }) {
  if (!supabase || !buyerPhone) return null;

  const cleanPhone = buyerPhone.startsWith('+') ? buyerPhone : `+${buyerPhone.replace(/[^\d]/g, '')}`;

  try {
    const { data: transfer, error } = await supabase
      .from('passbook_transfers')
      .select('*, vehicles!passbook_transfers_vehicle_id_fkey(*), profiles!passbook_transfers_from_owner_id_fkey(*)')
      .eq('to_owner_phone', cleanPhone)
      .eq('status', 'PENDING_BUYER_ACCEPTANCE')
      .order('initiated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !transfer) {
      return null;
    }

    const plate = transfer.vehicles?.plate_number || 'Vehicle';
    const vin = transfer.vin || transfer.vehicles?.vin || 'N/A';

    if (!transfer.is_free_transfer && !transfer.transfer_fee_paid) {
      const rate = await getEffectiveExchangeRate(supabase, 'KES');
      const localKES = Math.round(3.0 * rate);

      return {
        status: 'PAYMENT_REQUIRED',
        transferId: transfer.id,
        isFreeTransfer: false,
        feeAmount: 3.0,
        localPriceStr: `KES ${localKES.toLocaleString()}`,
        plateNumber: plate,
        vin,
        replyMessage: `💳 *Passbook Transfer Fee Required*\n\nThis vehicle (*${plate}*) has already utilized its 1 free transfer for this calendar year.\n\nA flat transfer fee of *USD 3.00* (~KES ${localKES}) is required before completing the passbook handover.\n\n👉 *Pay Transfer Fee securely:* https://sakafleet.com/pay-transfer?id=${transfer.id}\n\nOnce payment is confirmed, reply *"PAID"* to finalize!`
      };
    }

    const buyerOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase.from('passbook_transfers').update({
      buyer_otp: buyerOtp,
      buyer_otp_expires_at: expiresAt,
      status: 'PENDING_BUYER_OTP'
    }).eq('id', transfer.id);

    if (transfer.to_owner_email) {
      await sendEmailOtp(transfer.to_owner_email, buyerOtp);
    }

    return {
      status: 'OTP_SENT',
      transferId: transfer.id,
      buyerEmail: transfer.to_owner_email,
      plateNumber: plate,
      vin,
      replyMessage: `📧 *Step 5 of 5: Buyer Email Verification*\n\nWe sent a 6-digit verification code to your email (*${transfer.to_owner_email}*).\n\nPlease reply with the 6-digit code to finalize claiming *${plate}* (VIN: \`${vin}\`) and receive your official digital passbook!`
    };
  } catch (err) {
    console.error('[Transfers] Error in Step 4:', err);
    return null;
  }
}

/**
 * Step 5: Buyer enters email OTP -> Execute Re-anchoring to new owner
 */
export async function completePassbookTransfer({ buyerPhone, providedOtp, supabase, sendWhatsAppFn }) {
  if (!supabase || !buyerPhone || !providedOtp) {
    return { success: false, error: 'Phone and OTP are required' };
  }

  const cleanPhone = buyerPhone.startsWith('+') ? buyerPhone : `+${buyerPhone.replace(/[^\d]/g, '')}`;
  const cleanOtp = providedOtp.toString().trim();

  try {
    const { data: transfer, error: tErr } = await supabase
      .from('passbook_transfers')
      .select('*, vehicles!passbook_transfers_vehicle_id_fkey(*), seller:profiles!passbook_transfers_from_owner_id_fkey(*)')
      .eq('to_owner_phone', cleanPhone)
      .eq('status', 'PENDING_BUYER_OTP')
      .order('initiated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (tErr || !transfer) {
      return { success: false, error: 'No transfer found pending email verification.' };
    }

    if (transfer.buyer_otp !== cleanOtp) {
      return { success: false, error: 'Invalid verification code. Please check your email or reply "resend".' };
    }

    if (new Date() > new Date(transfer.buyer_otp_expires_at)) {
      return { success: false, error: 'Verification code expired. Please request a new code.' };
    }

    let { data: buyerProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('phone_number', cleanPhone)
      .maybeSingle();

    if (!buyerProfile) {
      const { data: newP } = await supabase
        .from('profiles')
        .insert([{
          id: crypto.randomUUID(),
          phone_number: cleanPhone,
          email: transfer.to_owner_email,
          email_verified: true,
          full_name: 'Fleet Owner',
          subscription_tier: 'free',
          subscription_status: 'active'
        }])
        .select()
        .single();
      buyerProfile = newP;
    } else {
      await supabase.from('profiles').update({
        email: transfer.to_owner_email,
        email_verified: true,
        updated_at: new Date().toISOString()
      }).eq('id', buyerProfile.id);
    }

    const newToken = `SK-PASSBOOK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const vehicleId = transfer.vehicle_id;
    const oldVeh = transfer.vehicles;

    const { error: vUpErr } = await supabase.from('vehicles').update({
      owner_id: buyerProfile.id,
      owner_phone: cleanPhone,
      owner_email: transfer.to_owner_email,
      assigned_driver_id: null,
      qr_passbook_token: newToken,
      transfer_count_current_year: (oldVeh?.transfer_count_current_year || 0) + 1,
      last_transfer_year: new Date().getFullYear(),
      updated_at: new Date().toISOString()
    }).eq('id', vehicleId);

    if (vUpErr) {
      console.error('[completePassbookTransfer] Error updating vehicle:', vUpErr);
      return { success: false, error: vUpErr.message };
    }

    if (transfer.vin) {
      await supabase.from('vin_registry').update({
        current_vehicle_id: vehicleId,
        updated_at: new Date().toISOString()
      }).eq('vin', transfer.vin);
    }

    await supabase.from('passbook_transfers').update({
      status: 'COMPLETED',
      to_owner_id: buyerProfile.id,
      completed_at: new Date().toISOString()
    }).eq('id', transfer.id);

    if (transfer.to_owner_email) {
      await sendPassbookWelcomeEmail({
        targetEmail: transfer.to_owner_email,
        plateNumber: oldVeh?.plate_number || 'Vehicle',
        makeModel: oldVeh?.make_model || 'Vehicle',
        yom: oldVeh?.yom || oldVeh?.year_of_manufacture || 2020,
        vin: transfer.vin,
        token: newToken,
        fuelType: oldVeh?.fuel_type || 'Petrol',
        mileage: oldVeh?.current_mileage || 0
      }).catch(err => console.warn('Could not send passbook email:', err.message));
    }

    const sellerPhone = transfer.seller?.phone_number;
    if (sellerPhone && sendWhatsAppFn) {
      const sellerMsg = `✅ *Passbook Transfer Complete!*\n\nOwnership of *${oldVeh?.plate_number}* (VIN: \`${transfer.vin}\`) has been successfully transferred to *${buyerProfile.full_name || cleanPhone}*.\n\nThe vehicle has been unlinked from your fleet roster.`;
      await sendWhatsAppFn(sellerPhone, sellerMsg);
    }

    return {
      success: true,
      plateNumber: oldVeh?.plate_number || 'Vehicle',
      vin: transfer.vin,
      newToken,
      buyerEmail: transfer.to_owner_email,
      sellerPhone
    };
  } catch (err) {
    console.error('[Transfers] Error in Step 5:', err);
    return { success: false, error: err.message };
  }
}
