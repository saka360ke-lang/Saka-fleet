import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { checkOwnerVehicleTierLimit, ensureVinRegistryEntry } from './src/services/vehicles.js';
import {
  scheduleTrialExtensionCoupon,
  applyTrialExtensionCoupon,
  generateWinback40Coupon
} from './src/services/coupons.js';
import { generateRoleBasedActionDiscovery } from './src/routes/whatsapp.js';
import {
  initiatePassbookTransfer,
  setBuyerDetailsAndSendReleaseOtp,
  verifyOwnerReleaseOtpAndNotifyBuyer,
  handleBuyerAcceptance,
  completePassbookTransfer
} from './src/services/transfers.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function runTests() {
  console.log('=== STARTING NEW SAKA FLEET CORE FEATURES TEST SUITE ===\n');

  const testOwnerPhone = '+254711998877';
  const testBuyerPhone = '+254722334455';
  const testOwnerEmail = 'owner_test@sakafleet.com';
  const testBuyerEmail = 'buyer_test@sakafleet.com';
  const testVin = `TESTVIN${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const testPlate = `KZZ ${Math.floor(100 + Math.random() * 900)}X`;

  try {
    // -------------------------------------------------------------
    // MODULE 1: Asset-Bound VIN Trials & Subscription Tier Limits
    // -------------------------------------------------------------
    console.log('--- TEST MODULE 1: Asset-Bound VIN Trials & Subscription Slot Caps ---');

    await supabase.from('vehicles').delete().or(`owner_phone.eq.${testOwnerPhone},vin.eq.${testVin}`);
    await supabase.from('profiles').delete().in('phone_number', [testOwnerPhone, testBuyerPhone]);
    await supabase.from('vin_registry').delete().eq('vin', testVin);

    const { data: ownerProfile, error: pErr } = await supabase.from('profiles').insert([{
      phone_number: testOwnerPhone,
      email: testOwnerEmail,
      email_verified: true,
      full_name: 'Test Fleet Owner',
      subscription_tier: 'free',
      subscription_status: 'active'
    }]).select().single();
    if (pErr) throw pErr;
    console.log('✅ Created test owner profile (Free Plan, 1 slot limit)');

    // 1.2 First-Ever Registration of VIN -> provenance only (v1.16.0)
    const registry1 = await ensureVinRegistryEntry({
      vin: testVin,
      ownerId: ownerProfile.id,
      supabase
    });
    console.log('VIN Registry 1 Creation:', { isFirstRegistration: registry1.isFirstRegistration });
    if (!registry1.isFirstRegistration) {
      throw new Error('Expected first-ever registration to be recorded in the VIN provenance ledger');
    }
    const { data: vinRow1 } = await supabase.from('vin_registry').select('*').eq('vin', testVin).maybeSingle();
    if (!vinRow1 || vinRow1.trial_granted !== false || vinRow1.trial_status !== 'account_bound') {
      throw new Error('Expected an account-bound provenance row with NO asset trial granted');
    }
    console.log('✅ VIN provenance recorded; no asset-bound trial is minted (trials bind to the owner account)');

    // 1.3 Subsequent registration of same VIN -> provenance preserved
    const registry2 = await ensureVinRegistryEntry({
      vin: testVin,
      ownerId: ownerProfile.id,
      supabase
    });
    console.log('VIN Registry 2 (Re-query same VIN):', { isFirstRegistration: registry2.isFirstRegistration });
    if (registry2.isFirstRegistration !== false) {
      throw new Error('Expected subsequent registration to preserve the provenance row');
    }
    console.log('✅ VIN immutability verified: subsequent registrations never mint a second trial artifact');

    // 1.4 Register Vehicle in DB
    const { data: testVeh, error: vErr } = await supabase.from('vehicles').insert([{
      owner_id: ownerProfile.id,
      owner_phone: testOwnerPhone,
      owner_email: testOwnerEmail,
      plate_number: testPlate,
      make_model: 'Toyota Land Cruiser',
      yom: 2021,
      fuel_type: 'Diesel',
      current_mileage: 45000,
      vin: testVin,
      qr_passbook_token: 'SK-PASSBOOK-TEST01'
    }]).select().single();
    if (vErr) throw vErr;
    console.log(`✅ Registered vehicle ${testPlate} under owner`);

    // 1.5 Subscription Slot Cap Check (Free plan allows 1 vehicle)
    const tierCheck = await checkOwnerVehicleTierLimit({
      ownerId: ownerProfile.id,
      subscriptionTier: 'free',
      supabase
    });
    console.log('Tier Slot Cap Check (Free Plan, 1 car owned):', {
      canAdd: tierCheck.canAdd,
      currentCount: tierCheck.currentCount,
      limit: tierCheck.limit,
      nextTierKey: tierCheck.nextTierKey
    });
    if (tierCheck.canAdd !== false || tierCheck.limit !== 1 || tierCheck.currentCount !== 1) {
      throw new Error('Expected Free Tier owner with 1 car to be blocked from adding 2nd car');
    }
    console.log('✅ Subscription slot cap successfully enforced (Blocked adding car beyond 1-slot limit)\n');
    // -------------------------------------------------------------
    // MODULE 2: Email OTP Confirmation & Pre-Expiry Coupons
    // -------------------------------------------------------------
    console.log('--- TEST MODULE 2: Email OTP Confirmation & Trial Extension Coupons ---');

    // 2.1 Pre-Expiry Coupon Scheduling
    const scheduledCoupon = await scheduleTrialExtensionCoupon({
      vin: testVin,
      ownerId: ownerProfile.id,
      ownerPhone: testOwnerPhone,
      ownerEmail: testOwnerEmail,
      trialEndAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      supabase
    });
    console.log('Scheduled Coupon Result:', {
      code: scheduledCoupon.code,
      status: scheduledCoupon.status,
      scheduled_dispatch_at: scheduledCoupon.scheduled_dispatch_at,
      days_to_add: scheduledCoupon.trial_extension_days
    });
    if (!scheduledCoupon.code.startsWith('EXT30-') || scheduledCoupon.status !== 'scheduled') {
      throw new Error('Expected coupon code starting with EXT30- and status scheduled');
    }
    console.log('✅ Pre-expiry trial extension coupon successfully scheduled upon email confirmation');

    // 2.2 Conversational Coupon Application ("Yes" simulation)
    const applyRes = await applyTrialExtensionCoupon({
      vin: testVin,
      phone: testOwnerPhone,
      couponCode: scheduledCoupon.code,
      supabase
    });
    console.log('Apply Extension Coupon Result:', {
      success: applyRes.success,
      couponCode: applyRes.couponCode,
      daysAdded: applyRes.daysAdded,
      newTrialEndAt: applyRes.newTrialEndAt
    });
    if (!applyRes.success || applyRes.daysAdded !== 30) {
      throw new Error('Failed to apply extension coupon');
    }
    const newEndMs = new Date(applyRes.newTrialEndAt).getTime();
    const extendedDays = Math.round((newEndMs - Date.now()) / (1000 * 60 * 60 * 24));
    if (extendedDays < 29 || extendedDays > 30) throw new Error(`Expected ~30 days added, got ${extendedDays}`);
    console.log('✅ Conversational extension coupon successfully added 30 free days to vehicle trial');

    // 2.3 Prevent Duplicate Redemption
    const duplicateRes = await applyTrialExtensionCoupon({
      vin: testVin,
      couponCode: scheduledCoupon.code,
      supabase
    });
    if (duplicateRes.success) throw new Error('Expected duplicate coupon redemption to be blocked');
    console.log('✅ Duplicate coupon redemption blocked');

    // 2.4 Overdue 15-Day Win-Back Offer (40% OFF Annual Subscription)
    const winbackCoupon = await generateWinback40Coupon({
      ownerPhone: testOwnerPhone,
      ownerId: ownerProfile.id,
      vin: testVin,
      supabase
    });
    console.log('15-Day Overdue Winback Coupon:', {
      code: winbackCoupon.code,
      discount: winbackCoupon.discount_percent,
      applicable_to: winbackCoupon.applicable_to,
      expires_at: winbackCoupon.expires_at
    });
    if (!winbackCoupon.code.startsWith('WINBACK40-') || winbackCoupon.discount_percent !== 40 || winbackCoupon.applicable_to !== 'annual_subscription') {
      throw new Error('Expected 40% OFF annual subscription winback coupon');
    }
    console.log('✅ 15-day overdue win-back coupon successfully generated with 40% annual discount\n');

    // -------------------------------------------------------------
    // MODULE 3: Conversational Action Discovery (Driver, Owner, Superadmin)
    // -------------------------------------------------------------
    console.log('--- TEST MODULE 3: Conversational Action Discovery ---');

    // 3.1 Owner Action Discovery
    const ownerActions = generateRoleBasedActionDiscovery({
      profileData: ownerProfile,
      vehicles: [testVeh],
      senderPhone: testOwnerPhone,
      targetVeh: testVeh
    });
    if (!ownerActions.includes('Owner Command Center') || !ownerActions.includes('transfer passbook')) {
      throw new Error('Owner action discovery missing expected owner command list');
    }
    console.log('✅ Owner Action Discovery returned tailored tools (Passbook transfer, fleet, reports)');

    // 3.2 Driver Action Discovery
    const driverProfile = { id: crypto.randomUUID(), full_name: 'Fleet Driver', phone_number: '+254700000000' };
    const driverVeh = { ...testVeh, owner_id: 'another_owner_id', assigned_driver_id: driverProfile.id };
    const driverActions = generateRoleBasedActionDiscovery({
      profileData: driverProfile,
      vehicles: [driverVeh],
      senderPhone: '+254700000000',
      targetVeh: driverVeh
    });
    if (!driverActions.includes('Driver Hub') || !driverActions.includes('Odometer') || driverActions.includes('transfer passbook')) {
      throw new Error('Driver action discovery must include odometer/logs and NOT allow passbook transfer');
    }
    console.log('✅ Driver Action Discovery returned tailored daily tools and enforced role boundaries');

    // 3.3 Superadmin Action Discovery
    const adminPhone = process.env.SUPERADMIN_PHONE || '+254720641985';
    const adminActions = generateRoleBasedActionDiscovery({
      profileData: { id: crypto.randomUUID() },
      vehicles: [],
      senderPhone: adminPhone,
      targetVeh: null
    });
    if (!adminActions.includes('Superadmin Command Hub') || !adminActions.includes('admin report')) {
      throw new Error('Superadmin action discovery missing executive hub commands');
    }
    console.log('✅ Superadmin Action Discovery returned verified admin commands\n');
    // -------------------------------------------------------------
    // MODULE 4: 5-Step Secure Passbook Transfer Flow & Fee Structure
    // -------------------------------------------------------------
    console.log('--- TEST MODULE 4: 5-Step Secure Passbook Transfer & Fee Engine ---');

    // Step 1: Initiation
    const step1 = await initiatePassbookTransfer({
      fromPhone: testOwnerPhone,
      vehicleCandidate: testPlate,
      supabase
    });
    console.log('Step 1 (Initiation):', {
      success: step1.success,
      transferId: step1.transferId,
      isFreeTransfer: step1.isFreeTransfer,
      feeAmount: step1.feeAmount,
      error: step1.error
    });
    if (!step1.success || !step1.isFreeTransfer || step1.feeAmount !== 0) {
      throw new Error('Step 1 failed: Expected initial annual transfer to be FREE ($0 fee)');
    }
    console.log('✅ Step 1: Owner initiated transfer, 1st annual quota validated as FREE');

    // Step 2: Target Capture
    const step2 = await setBuyerDetailsAndSendReleaseOtp({
      transferId: step1.transferId,
      buyerPhone: testBuyerPhone,
      buyerEmail: testBuyerEmail,
      supabase
    });
    console.log('Step 2 (Target Capture):', {
      success: step2.success,
      releasePin: step2.releasePin,
      buyerPhone: step2.buyerPhone,
      ownerEmail: step2.ownerEmail
    });
    if (!step2.success || !step2.releasePin || step2.releasePin.length !== 6) {
      throw new Error('Step 2 failed: Expected 6-digit release PIN generated');
    }
    console.log('✅ Step 2: Buyer details captured and 6-digit release PIN generated');

    // Step 3: Owner Security Authorization
    let whatsAppMessagesDispatched = [];
    const mockSendWhatsApp = async (to, msg) => {
      whatsAppMessagesDispatched.push({ to, msg });
    };

    const step3 = await verifyOwnerReleaseOtpAndNotifyBuyer({
      transferId: step1.transferId,
      providedOtp: step2.releasePin,
      supabase,
      sendWhatsAppFn: mockSendWhatsApp
    });
    console.log('Step 3 (Security Check):', {
      success: step3.success,
      buyerPhone: step3.buyerPhone,
      vin: step3.vin
    });
    if (!step3.success) throw new Error('Step 3 failed: Release PIN verification rejected');
    if (!whatsAppMessagesDispatched.some(m => m.to === testBuyerPhone && m.msg.includes('ACCEPT'))) {
      throw new Error('Expected buyer to be messaged on WhatsApp with ACCEPT prompt');
    }
    console.log('✅ Step 3: Owner verified release PIN; WhatsApp handshake sent to buyer');

    // Step 4: Buyer Acceptance Handshake
    const step4 = await handleBuyerAcceptance({
      buyerPhone: testBuyerPhone,
      supabase,
      sendWhatsAppFn: mockSendWhatsApp
    });
    console.log('Step 4 (Buyer Handshake):', {
      status: step4?.status,
      buyerEmail: step4?.buyerEmail
    });
    if (!step4 || step4.status !== 'OTP_SENT') {
      throw new Error('Step 4 failed: Expected OTP_SENT status for free transfer');
    }
    console.log('✅ Step 4: Buyer replied ACCEPT, email verification OTP dispatched to buyer');

    // Get the generated buyer OTP from DB
    const { data: trfDb } = await supabase.from('passbook_transfers').select('buyer_otp').eq('id', step1.transferId).single();
    const buyerOtp = trfDb.buyer_otp;

    // Step 5: Execution & Re-Anchoring
    const step5 = await completePassbookTransfer({
      buyerPhone: testBuyerPhone,
      providedOtp: buyerOtp,
      supabase,
      sendWhatsAppFn: mockSendWhatsApp
    });
    console.log('Step 5 (Execution & Re-Anchoring):', {
      success: step5.success,
      plateNumber: step5.plateNumber,
      newToken: step5.newToken,
      vin: step5.vin
    });
    if (!step5.success || !step5.newToken.startsWith('SK-PASSBOOK-')) {
      throw new Error('Step 5 failed: Passbook re-anchoring failed');
    }

    // Verify Vehicle In Database Now Belongs to Buyer
    const { data: reanchoredVeh } = await supabase.from('vehicles').select('*').eq('id', testVeh.id).single();
    console.log('Re-anchored Vehicle Verification:', {
      owner_phone: reanchoredVeh.owner_phone,
      qr_passbook_token: reanchoredVeh.qr_passbook_token,
      assigned_driver_id: reanchoredVeh.assigned_driver_id,
      transfer_count_current_year: reanchoredVeh.transfer_count_current_year
    });
    if (reanchoredVeh.owner_phone !== testBuyerPhone) {
      throw new Error(`Vehicle owner_phone expected to be ${testBuyerPhone}, was ${reanchoredVeh.owner_phone}`);
    }
    if (reanchoredVeh.qr_passbook_token !== step5.newToken) {
      throw new Error('Passbook token was not updated to new token');
    }
    if (reanchoredVeh.assigned_driver_id !== null) {
      throw new Error('Assigned driver was not cleared during transfer');
    }
    if (reanchoredVeh.transfer_count_current_year !== 1) {
      throw new Error(`Expected transfer count current year = 1, got ${reanchoredVeh.transfer_count_current_year}`);
    }
    console.log('✅ Step 5: Vehicle successfully re-anchored to buyer with new passbook token, driver cleared');

    // Test Subsequent Transfer in same year -> Must require USD 3 fee
    const subsequentTransfer = await initiatePassbookTransfer({
      fromPhone: testBuyerPhone,
      vehicleCandidate: testPlate,
      supabase
    });
    console.log('Subsequent Transfer in Same Year Quota Check:', {
      success: subsequentTransfer.success,
      isFreeTransfer: subsequentTransfer.isFreeTransfer,
      feeAmount: subsequentTransfer.feeAmount
    });
    if (subsequentTransfer.isFreeTransfer !== false || subsequentTransfer.feeAmount !== 3.00) {
      throw new Error('Expected 2nd transfer in same calendar year to require flat USD 3 fee');
    }
    console.log('✅ Transfer Quota Rule Verified: 2nd transfer in same calendar year charges flat USD 3 equivalent fee!\n');

    console.log('=====================================================');
    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! ZERO ERRORS FOUND! 🎉');
    console.log('=====================================================');

    // Clean up test records
    await supabase.from('passbook_transfers').delete().eq('vehicle_id', testVeh.id);
    await supabase.from('vehicles').delete().eq('id', testVeh.id);
    await supabase.from('vin_registry').delete().eq('vin', testVin);
    await supabase.from('coupons').delete().eq('vin', testVin);
    await supabase.from('profiles').delete().in('phone_number', [testOwnerPhone, testBuyerPhone]);

  } catch (err) {
    console.error('\n❌ TEST FAILED WITH ERROR:', err);
    process.exit(1);
  }
}

runTests();


