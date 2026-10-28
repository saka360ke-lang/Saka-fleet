import crypto from 'crypto';
import { onboardingStore, chatSessions } from '../routes/whatsapp.js';
import { sendEmailOtp, sendPassbookWelcomeEmail } from './mailer.js';
import { checkOwnerVehicleTierLimit, getOrCreateVinTrial } from './vehicles.js';
import { scheduleTrialExtensionCoupon } from './coupons.js';

export async function handleStage2OptionalWeaving({
  obState,
  mergedExt,
  messageText,
  senderPhone,
  session,
  countryInfo,
  supabaseClient
}) {
  const cleanText = messageText.trim().toLowerCase().replace(/[!.,?;:]+$/g, '');
  const isSkipOrDone = mergedExt.skip_or_done || /^(skip|done|later|no|finish|not now|no thanks|exit|great|ok|okay|awesome|cool|thanks|thank you|none|good|perfect|all set|got it|nice|alright|sure|yes)$/i.test(cleanText);
  const regPlate = obState.registered_plate || obState.core?.plate_number || obState.plate_number;

  // Detect whether the message carried any real optional spec payload
  const SPEC_KEYS = ['insurance_expiry', 'insurance_policy', 'engine_number', 'color', 'transmission', 'tire_size', 'inspection_expiry', 'purchase_cost', 'custom_attributes'];
  const hasSpecPayload = SPEC_KEYS.some((k) => {
    const v = mergedExt ? mergedExt[k] : null;
    if (v === null || v === undefined || v === '') return false;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  });

  if (isSkipOrDone || !hasSpecPayload) {
    onboardingStore.delete(senderPhone);
    session.state = 'ACTIVE';
    session.onboardingStep = null;
    session.onboardingStage = null;
    chatSessions.set(senderPhone, session);

    return `🎉 *Your Vehicle Asset Record is Active!* 🚀\n\n🚘 *Vehicle:* ${regPlate}\n\n📋 *What would you like to do next?*\n1️⃣ *Log Expense / Fuel* (e.g. "Logged fuel KES 3000")\n2️⃣ *Update Mileage* (e.g. "Odometer 366700 km")\n3️⃣ *Set Service Reminder* (e.g. "Remind oil change in 5000 km")\n4️⃣ *Log Earnings* (e.g. "Earned KES 5000 today")\n5️⃣ *View Reports & Summary*\n\nReply with a number or type what you want to do!`;
  }

  const optUpdates = {};
  if (mergedExt.insurance_expiry) optUpdates.insurance_expiry = mergedExt.insurance_expiry;
  if (mergedExt.insurance_policy) optUpdates.insurance_policy = mergedExt.insurance_policy;
  // Note: VIN is immutable and permanently locked to passbook; never updated in Stage 2
  if (mergedExt.engine_number) optUpdates.engine_number = mergedExt.engine_number;
  if (mergedExt.color) optUpdates.color = mergedExt.color;
  if (mergedExt.transmission) optUpdates.transmission = mergedExt.transmission;
  if (mergedExt.tire_size) optUpdates.tire_size = mergedExt.tire_size;
  if (mergedExt.inspection_expiry) optUpdates.inspection_expiry = mergedExt.inspection_expiry;
  if (mergedExt.purchase_cost) optUpdates.purchase_cost = mergedExt.purchase_cost;
  if (mergedExt.custom_attributes) {
    optUpdates.custom_attributes = {
      ...(obState.optional?.custom_attributes || {}),
      ...(mergedExt.custom_attributes || {})
    };
  }

  if (supabaseClient && Object.keys(optUpdates).length > 0 && regPlate) {
    const { data: updatedVeh } = await supabaseClient
      .from('vehicles')
      .update(optUpdates)
      .eq('plate_number', regPlate)
      .select()
      .maybeSingle();

    if (optUpdates.insurance_expiry && updatedVeh) {
      await supabaseClient.from('reminders').insert([{
        vehicle_id: updatedVeh.id,
        reminder_type: 'Insurance Renewal',
        due_date: optUpdates.insurance_expiry,
        status: 'active'
      }]);
    }
  }

  const bullets = [];
  if (optUpdates.insurance_expiry) bullets.push(`• *Insurance Expiry:* ${optUpdates.insurance_expiry}`);
  if (optUpdates.inspection_expiry) bullets.push(`• *Inspection Expiry:* ${optUpdates.inspection_expiry}`);
  if (optUpdates.vin) bullets.push(`• *VIN/Chassis:* ${optUpdates.vin}`);
  if (optUpdates.transmission) bullets.push(`• *Transmission:* ${optUpdates.transmission}`);
  if (optUpdates.color) bullets.push(`• *Color:* ${optUpdates.color}`);
  if (optUpdates.tire_size) bullets.push(`• *Tire Size:* ${optUpdates.tire_size}`);
  if (optUpdates.purchase_cost) bullets.push(`• *Purchase Cost:* ${countryInfo.currency} ${Number(optUpdates.purchase_cost).toLocaleString()}`);

  const bulletsText = bullets.length > 0 ? bullets.join('\n') + '\n\n' : '';

  onboardingStore.delete(senderPhone);
  session.state = 'ACTIVE';
  session.onboardingStep = null;
  session.onboardingStage = null;
  chatSessions.set(senderPhone, session);

  return `🛡️ *Compliance & Mechanical Specs Saved!* ✅\n\n• *Vehicle:* ${regPlate}\n${bulletsText}Proactive compliance & service alerts are now active!\n\n📋 *What would you like to do next?*\n1️⃣ *Log Expense / Fuel* (e.g. "Logged fuel KES 3000")\n2️⃣ *Update Mileage* (e.g. "Odometer 366700 km")\n3️⃣ *Set Service Reminder* (e.g. "Remind oil change in 5000 km")\n4️⃣ *Log Earnings* (e.g. "Earned KES 5000 today")\n5️⃣ *View Reports & Summary*\n\nReply with a number or type what you want to do!`;
}


export async function saveVehicleAssetRecord({
  obState,
  profileData,
  countryInfo,
  supabaseClient,
  formattedPhone
}) {
  const token = `SK-PASSBOOK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const coreYom = parseInt(obState.core.yom, 10);
  const coreMileage = parseInt(obState.core.current_mileage, 10) || 0;
  const coreEmail = (obState.core.owner_email || profileData?.email || '').toLowerCase().trim();
  const coreFuel = (obState.core.fuel_type || 'Petrol').trim();
  const corePlate = obState.core.plate_number.toUpperCase().trim();
  const coreModel = obState.core.make_model.trim();
  const coreVin = (obState.core.vin || '').toUpperCase().trim();

  const customAttrs = {
    ...(obState.optional?.custom_attributes || {}),
    ...(obState.custom_attributes || {})
  };

  let trialInfo = {
    isFirstRegistration: true,
    trialStartAt: new Date().toISOString(),
    trialEndAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    trialStatus: 'active'
  };

  if (supabaseClient && coreVin) {
    trialInfo = await getOrCreateVinTrial({
      vin: coreVin,
      ownerId: profileData?.id,
      supabase: supabaseClient
    });
  }

  const vehRecord = {
    owner_id: profileData?.id,
    plate_number: corePlate,
    make_model: coreModel,
    yom: coreYom,
    year_of_manufacture: coreYom,
    owner_email: coreEmail,
    fuel_type: coreFuel,
    current_mileage: coreMileage,
    odometer_reading: coreMileage,
    owner_phone: formattedPhone,
    status: 'ACTIVE',
    vin: coreVin,
    trial_start_at: trialInfo.trialStartAt,
    trial_end_at: trialInfo.trialEndAt,
    trial_status: trialInfo.trialStatus,
    asset_type: (/electric|ev/i.test(coreFuel)) ? 'EV' : (/hybrid/i.test(coreFuel) ? 'HYBRID' : 'ICE'),
    unit_system: profileData?.unit_system || countryInfo?.default_units || 'metric',
    qr_passbook_token: token,
    custom_attributes: customAttrs,
    metadata: {
      role: obState.role || 'Owner',
      vin_locked: true,
      vin_locked_at: new Date().toISOString(),
      onboarding_completed_at: new Date().toISOString()
    }
  };

  if (obState.optional?.engine_number) vehRecord.engine_number = obState.optional.engine_number;
  if (obState.optional?.color) vehRecord.color = obState.optional.color;
  if (obState.optional?.transmission) vehRecord.transmission = obState.optional.transmission;
  if (obState.optional?.tire_size) vehRecord.tire_size = obState.optional.tire_size;
  if (obState.optional?.insurance_policy) vehRecord.insurance_policy = obState.optional.insurance_policy;
  if (obState.optional?.insurance_expiry) vehRecord.insurance_expiry = obState.optional.insurance_expiry;
  if (obState.optional?.inspection_expiry) vehRecord.inspection_expiry = obState.optional.inspection_expiry;
  if (obState.optional?.purchase_cost) vehRecord.purchase_cost = obState.optional.purchase_cost;

  if (supabaseClient && profileData) {
    const { error: insErr } = await supabaseClient.from('vehicles').insert([vehRecord]);
    if (insErr) {
      if (insErr.code === '23505') {
        await supabaseClient.from('vehicles').update(vehRecord).eq('plate_number', corePlate);
      } else {
        console.error('[saveVehicleAssetRecord Error]:', insErr);
      }
    }
    await supabaseClient.from('profiles').update({
      email: coreEmail || profileData.email,
      email_verified: true,
      updated_at: new Date().toISOString()
    }).eq('id', profileData.id);

    // Auto-schedule pre-expiry 30-day extension coupon upon email OTP verification
    if (coreVin) {
      await scheduleTrialExtensionCoupon({
        vin: coreVin,
        ownerId: profileData.id,
        ownerPhone: formattedPhone,
        ownerEmail: coreEmail,
        trialEndAt: trialInfo.trialEndAt,
        supabase: supabaseClient
      });
    }
  }

  // Automatically dispatch generated passbook details and token directly to verified email address
  try {
    await sendPassbookWelcomeEmail({
      targetEmail: coreEmail,
      plateNumber: corePlate,
      makeModel: coreModel,
      yom: coreYom,
      vin: coreVin,
      token,
      fuelType: coreFuel,
      mileage: coreMileage
    });
  } catch (emailErr) {
    console.warn('[saveVehicleAssetRecord] Warning: Could not dispatch passbook email:', emailErr.message);
  }

  return { token, coreYom, coreMileage, coreEmail, coreFuel, corePlate, coreModel, coreVin };
}

export async function handleStage1CoreCapture({
  obState,
  mergedExt,
  messageText,
  senderPhone,
  session,
  profileData,
  countryInfo,
  supabaseClient,
  formattedPhone
}) {
  if (!obState.core) {
    obState.core = {
      plate_number: obState.plate_number || null,
      make_model: obState.make_model || null,
      yom: null,
      owner_email: profileData?.email || null,
      fuel_type: null,
      current_mileage: null,
      vin: null,
      email_verified: !!(profileData?.email && profileData?.email_verified)
    };
  }
  if (!obState.optional) {
    obState.optional = {};
  }
  if (mergedExt.plate_number && !obState.core.plate_number) {
    obState.core.plate_number = mergedExt.plate_number.toUpperCase().trim();
  }
  if (mergedExt.make_model) {
    const isPlate = /\b([A-Z]{1,4}\s?\d{1,4}[A-Z]{0,2}|\d[A-Z]{3}\d{3})\b/i.test(mergedExt.make_model);
    const cleanPlate = (obState.core.plate_number || '').replace(/\s+/g, '').toUpperCase();
    if (!isPlate && (!cleanPlate || mergedExt.make_model.replace(/\s+/g, '').toUpperCase() !== cleanPlate)) {
      obState.core.make_model = mergedExt.make_model.trim();
    }
  }
  if ((mergedExt.yom || mergedExt.year) && !obState.core.yom) {
    obState.core.yom = parseInt(mergedExt.yom || mergedExt.year, 10);
  }
  if (mergedExt.owner_email && (!obState.core.owner_email || obState.core.owner_email !== mergedExt.owner_email.toLowerCase().trim())) {
    obState.core.owner_email = mergedExt.owner_email.toLowerCase().trim();
    obState.core.email_verified = false;
    obState.pending_otp = null;
  }
  if (mergedExt.fuel_type && !obState.core.fuel_type) {
    obState.core.fuel_type = mergedExt.fuel_type;
  }
  if (mergedExt.current_mileage !== null && mergedExt.current_mileage !== undefined && obState.core.current_mileage === null) {
    obState.core.current_mileage = parseInt(mergedExt.current_mileage, 10);
  }
  if (mergedExt.vin && !obState.core.vin) {
    obState.core.vin = mergedExt.vin.toUpperCase().trim();
  }
  if (mergedExt.role) obState.role = mergedExt.role;

  if (mergedExt.engine_number) obState.optional.engine_number = mergedExt.engine_number;
  if (mergedExt.color) obState.optional.color = mergedExt.color;
  if (mergedExt.transmission) obState.optional.transmission = mergedExt.transmission;
  if (mergedExt.tire_size) obState.optional.tire_size = mergedExt.tire_size;
  if (mergedExt.insurance_policy) obState.optional.insurance_policy = mergedExt.insurance_policy;
  if (mergedExt.insurance_expiry) obState.optional.insurance_expiry = mergedExt.insurance_expiry;
  if (mergedExt.inspection_expiry) obState.optional.inspection_expiry = mergedExt.inspection_expiry;
  if (mergedExt.purchase_cost) obState.optional.purchase_cost = mergedExt.purchase_cost;
  if (mergedExt.custom_attributes) {
    obState.optional.custom_attributes = {
      ...(obState.optional.custom_attributes || {}),
      ...mergedExt.custom_attributes
    };
  }

  obState.plate_number = obState.core.plate_number;
  obState.make_model = obState.core.make_model;

  if (!obState.core.plate_number) {
    const rawPlateMatch = messageText.match(/\b([A-Z]{1,4}\s?\d{1,4}[A-Z]{0,2}|\d[A-Z]{3}\d{3})\b/i);
    if (rawPlateMatch && !/^(register|onboard|add car|help|cancel|exit|stop|reset)$/i.test(rawPlateMatch[0])) {
      obState.core.plate_number = rawPlateMatch[0].toUpperCase().trim();
      obState.plate_number = obState.core.plate_number;
    }
  }

  if (!obState.core.vin) {
    const rawVinMatch = messageText.match(/\b(?:vin|chassis)?\s*[:=]?\s*([A-HJ-NPR-Z0-9]{11,17})\b/i);
    if (rawVinMatch && !/^(diesel|petrol|hybrid|toyota|nissan|fielder|automatic|owner|driver|register|onboard)$/i.test(rawVinMatch[1])) {
      obState.core.vin = rawVinMatch[1].toUpperCase().trim();
    }
  }

  const hasPlate = !!obState.core.plate_number;
  const hasModel = !!obState.core.make_model;
  const hasYom = !!obState.core.yom;
  const hasFuel = !!obState.core.fuel_type;
  const hasMileage = obState.core.current_mileage !== null && obState.core.current_mileage !== undefined;
  const hasVin = !!obState.core.vin;
  const hasEmail = !!(obState.core.owner_email || profileData?.email);

  // When all 7 mandatory core fields are captured:
  if (hasPlate && hasModel && hasYom && hasFuel && hasMileage && hasVin && hasEmail) {
    const cleanTrimmed = messageText.trim();
    const providedOtp = mergedExt.otp_code || (cleanTrimmed.match(/^\d{6}$/) ? cleanTrimmed : null) || (cleanTrimmed.match(/\b\d{6}\b/) ? cleanTrimmed.match(/\b\d{6}\b/)[0] : null);
    const isResendReq = /^(resend|resend otp|resend code|send code again)$/i.test(cleanTrimmed);

    // If email is not yet verified via OTP
    if (!obState.core.email_verified) {
      if (providedOtp && obState.pending_otp) {
        if (obState.pending_otp.code === providedOtp && Date.now() <= obState.pending_otp.expiresAt) {
          obState.core.email_verified = true;
          obState.pending_otp = null;
        } else {
          return `❌ *Invalid or Expired Verification Code*\n\nThe code \`${providedOtp}\` does not match or has expired. Please check your inbox for **${obState.core.owner_email}** or reply **'resend'** to request a new verification code.`;
        }
      } else if (isResendReq || !obState.pending_otp) {
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        obState.pending_otp = {
          code: otpCode,
          email: obState.core.owner_email,
          expiresAt: Date.now() + 10 * 60 * 1000
        };
        await sendEmailOtp(obState.core.owner_email, otpCode);
        obState.step = 3;
        onboardingStore.set(senderPhone, obState);
        return `📧 *Email Verification Required*\n\nWe have dispatched a 6-digit verification code to **${obState.core.owner_email}**.\n\n🔒 *VIN Lock Reminder:* Your vehicle passbook will be permanently bound to VIN \`${obState.core.vin}\`.\n\nPlease reply with the 6-digit code sent to your email to verify and issue your passbook.\n\n_(Reply **'resend'** if you need a new code.)_`;
      } else {
        return `📧 *Email Verification Pending*\n\nPlease enter the 6-digit verification code sent to **${obState.core.owner_email}** to complete registration.\n\n🔒 *VIN Lock:* Once confirmed, this passbook will be permanently locked to VIN \`${obState.core.vin}\`.\n\n_(Reply **'resend'** if you need a new code.)_`;
      }
    }

    // Email is verified AND all 7 core fields are present: issue VIN-locked passbook
    try {
      if (profileData?.id && supabaseClient) {
        const tierCheck = await checkOwnerVehicleTierLimit({
          ownerId: profileData.id,
          subscriptionTier: profileData.subscription_tier || 'free',
          supabase: supabaseClient
        });
        if (!tierCheck.canAdd) {
          onboardingStore.delete(senderPhone);
          session.state = 'IDLE';
          return `⚠️ *Vehicle Capacity Limit Reached*\n\nYour current plan (*${tierCheck.tier}*) allows a maximum of ${tierCheck.limit} vehicle(s). Please upgrade your subscription to register additional vehicles.`;
        }
      }


      const saved = await saveVehicleAssetRecord({
        obState,
        profileData,
        countryInfo,
        supabaseClient,
        formattedPhone
      });

      obState.stage = 2;
      obState.step = 3;
      obState.registered_plate = saved.corePlate;
      obState.token = saved.token;
      onboardingStore.set(senderPhone, obState);
      session.state = 'ONBOARDING_STAGE_2';
      chatSessions.set(senderPhone, session);

      return `🎉 *Vehicle Registration Complete & Passbook Issued!* 🚀\n\n🚘 *Vehicle Asset Record:*\n• *Plate Number:* ${saved.corePlate}\n• *VIN (Chassis):* \`${saved.coreVin}\` *(Permanently Locked 🔒)*\n• *Make & Model:* ${saved.coreModel} (${saved.coreYom})\n• *Fuel:* ${saved.coreFuel} | *Odometer:* ${saved.coreMileage.toLocaleString()} km\n• *Email:* ${saved.coreEmail} *(Verified ✅)*\n• *Passbook Token:* \`${saved.token}\`\n\n📧 *Your official digital passbook and token have been sent directly to ${saved.coreEmail}!*\n\n🛡️ *Unlock Proactive Compliance & Maintenance Reminders:*\nWould you like to optionally add details like **Insurance Expiry Date**, **Inspection/NTAC Date**, **Color**, **Transmission** (Auto/Manual), or any **Custom Modifications** (e.g. Bullbar, Winch)?\n\nAdding insurance expiry enables Saka to send proactive renewal alerts before expiration!\n\n💡 *Reply with any details (e.g. "Insurance expires 2027-05-15, automatic, color White"), or simply type **'Skip'** or **'Done'** to finish.*`;
    } catch (regErr) {
      console.error('[handleStage1CoreCapture] Registration Error:', regErr);
      onboardingStore.delete(senderPhone);
      session.state = 'IDLE';
      session.onboardingStep = null;
      return `Failed to complete registration. Please try typing **'Register'** again.`;
    }
  }

  if (!hasPlate) {
    obState.step = 1;
    onboardingStore.set(senderPhone, obState);
    return `🚘 *Step 1 of 2: Vehicle Registration Plate*\n\nPlease reply with your vehicle's registration plate number (e.g. *KDA 123A* or *KBC 456X*).`;
  }

  obState.step = 2;
  onboardingStore.set(senderPhone, obState);

  const missing = [];
  if (!hasModel) missing.push("Make & Model (e.g. 80 series / Fielder)");
  if (!hasYom) missing.push("Year of Manufacture [YOM] (e.g. 1991 / 2018)");
  if (!hasFuel) missing.push("Fuel Type (Diesel, Petrol, Hybrid, EV)");
  if (!hasMileage) missing.push("Current Mileage (e.g. 366700 km)");
  if (!hasVin) missing.push("VIN / Chassis Number (11-17 alphanumeric, permanently locked to your passbook)");
  if (!hasEmail) missing.push("Email Address (for OTP verification and passbook delivery)");

  if (missing.length >= 3) {
    return `🚘 *Step 2 of 2: Vehicle Core Details* 📝\n\nGot registration plate *${obState.core.plate_number}*!\n\nCould you share the **Make & Model**, **Year of Manufacture (YOM)**, **Fuel Type (Diesel/Petrol/Hybrid/EV)**, **Current Mileage**, **VIN / Chassis Number**, and your **Email**?\n\n💡 *Tip: You can send them all together in one message (e.g., "1991 diesel 80 series, mileage 366700, VIN 1HGCR2F83HA123456, email user@mail.com")!*\n\n⚠️ *VIN Reminder: Please verify your VIN accurately, as your passbook is permanently locked to it.*`;
  } else if (!hasVin) {
    return `Almost done! 🔒 What is your vehicle's **VIN / Chassis Number** (11–17 characters)?\n\n⚠️ *Verification Reminder:* Please verify and confirm your VIN accurately, as your official passbook will be permanently tied to it.`;
  } else if (!hasEmail) {
    return `📧 What email address should we send your OTP verification code and automated passbook to?`;
  } else if (!hasMileage) {
    return `What is the vehicle's current mileage/odometer reading (e.g. 366,700 km)?`;
  } else if (!hasFuel) {
    return `What fuel type does this vehicle use (Diesel, Petrol, Hybrid, or Electric)?`;
  } else if (!hasYom) {
    return `What year was the vehicle manufactured (e.g. 1991, 2018)?`;
  } else {
    return `Please specify the make and model of your vehicle (e.g., *Toyota Land Cruiser 80 series*).`;
  }
}


