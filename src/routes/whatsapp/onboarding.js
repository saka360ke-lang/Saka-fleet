/**
 * Saka Fleet — legacy two-stage onboarding lane (Phase 11, v1.73.1).
 * -------------------------------------------------------------------
 * Extracted verbatim from messages.js: the v1.69.0 section 191 branch A
 * (two-stage progressive onboarding, legacy fallback) and the branch B
 * registration starter. Leaf route module: it may import src/services/*
 * and ./helpers.js only — NEVER ./messages.js (state in, data out, the same
 * contract as quiz.js / pending.js). It mutates the passed session and
 * onboardingStore in place and returns the reply as data; the processor
 * performs every send.
 */
import { shortenUrl } from '../../services/linkShortener.js';
import { formatUsdInLocalCurrency } from '../../services/paystack.js';
import { evaluateVehicleCapacity, checkoutForTier, checkoutForAddon } from '../../services/subscriptions.js';
import { startWelcomeTrial } from '../../services/trialEngine.js';
import { getTierLabel } from '../../services/subscriptionTiers.js';
import { composeMessage } from '../../services/conversationEngine.js';
import { handleStage1CoreCapture, handleStage2OptionalWeaving } from '../../services/onboarding.js';
import { checkIsConversationalFeedback } from './helpers.js';

/** The single legacy onboarding seed shape (v1.73.1 — D2 dedupe of three literals). */
function buildOnboardingSeed({ plateNumber = null, ownerEmail = null } = {}) {
  const plate = plateNumber || null;
  return {
    stage: 1,
    step: plate ? 2 : 1,
    core: { plate_number: plate, make_model: null, yom: null, owner_email: ownerEmail, fuel_type: null, current_mileage: null, vin: null, email_verified: false },
    optional: { engine_number: null, color: null, transmission: null, tire_size: null, insurance_policy: null, insurance_expiry: null, inspection_expiry: null, purchase_cost: null, custom_attributes: {} },
    registered_plate: null,
    token: null,
    role: 'Owner',
    plate_number: plate,
    make_model: null
  };
}

export async function handleLegacyOnboardingTurn({
  session,
  messageText,
  mergedExt,
  senderPhone,
  profileData,
  entitlements,
  existingVehicles,
  countryInfo,
  supabaseClient,
  targetLang,
  formattedPhone,
  onboardingStore,
  hasVehicleRegistered
}) {
  let customReply = null;
  session.state = 'ONBOARDING';
  const currentVehicleCount = existingVehicles.filter((v) => v.owner_id === profileData?.id).length;
  // v1.58.20 - lazy welcome-trial heal: an owner whose account never got
  // its one-per-lifetime trial (the live profiles table was missing
  // currency/locale, so every startWelcomeTrial call silently returned
  // "profile not found") receives it BEFORE a capacity block can fire.
  let capacityProfile = profileData;
  const capacityTier = entitlements?.tierKey || profileData?.subscription_tier || 'free';
  if (String(capacityTier) === 'free' && !profileData?.trial_used_at && profileData?.id) {
    try {
      // v1.58.21 - heal with the ASSET anchor: the trial counts from the
      // day the passbook was issued, never from this repair moment.
      const firstAssetAt = existingVehicles
        .filter((v) => v.owner_id === profileData.id)
        .map((v) => v.created_at)
        .filter(Boolean)
        .sort()[0] || null;
      const welcome = await startWelcomeTrial({ supabase: supabaseClient, ownerId: profileData.id, startedAt: firstAssetAt });
      if (welcome && welcome.started) {
        capacityProfile = {
          ...profileData,
          subscription_status: 'TRIALING',
          subscription_tier: welcome.tierKey,
          trial_used_at: new Date().toISOString()
        };
      }
    } catch { /* the heal never blocks onboarding */ }
  }
  const branchCapacity = await evaluateVehicleCapacity({
    supabase: supabaseClient,
    ownerId: profileData?.id,
    profile: capacityProfile
  });
  // Honest copy when a block is genuine: never imply a missing trial.
  const capacityTrialNote = (capacityProfile?.trial_used_at && !entitlements?.isTrial)
    ? '\n\n_Trials are one per account — yours was already used, so Free capacity applies._'
    : '';
  const isNewRegistrationStart = !onboardingStore.has(senderPhone);

  const cleanText = messageText.trim().toLowerCase();

  if (/^(cancel|exit|stop)$/i.test(cleanText)) {
    onboardingStore.delete(senderPhone);
    session.state = hasVehicleRegistered ? 'ACTIVE' : 'IDLE';
    session.onboardingStep = null;
    session.onboardingStage = null;
    customReply = `Vehicle onboarding cancelled. ${hasVehicleRegistered ? "You are back in active menu mode." : "Type **'Register'** whenever you're ready!"}`;
  } else if (/^(reset|restart|start over)$/i.test(cleanText)) {
    onboardingStore.set(senderPhone, buildOnboardingSeed({ ownerEmail: profileData?.email || null }));
    session.onboardingStep = 1;
    session.onboardingStage = 1;
    customReply = await composeMessage({
      purpose: 'onboarding_reset_card',
      facts: {
        reset: true,
        nextStep: 'reply with the registration plate number',
        examples: ['KDA 123A', 'KBC 456X']
      },
      language: targetLang,
      countryInfo,
      profile: profileData,
      fallbackText: `🔄 *Onboarding Reset*\n\nPlease reply with your vehicle's registration plate number (e.g. *KDA 123A* or *KBC 456X*).`
    });
  } else if (isNewRegistrationStart && currentVehicleCount >= branchCapacity.capacity) {
    const branchOwner = { id: profileData?.id, phone_number: senderPhone, email: profileData?.email };
    if (branchCapacity.addonEligible) {
      const addon = await checkoutForAddon({
        supabase: supabaseClient,
        owner: branchOwner,
        addonQuantity: Math.max(1, branchCapacity.overBy),
        interval: entitlements?.billingInterval || 'monthly',
        currency: countryInfo?.currency || 'USD'
      });
      const addonPriceLabel = await formatUsdInLocalCurrency(supabaseClient, branchCapacity.addonPriceUSD || 4.99, countryInfo?.currency || 'USD', countryInfo?.locale || 'en-US');
      customReply = `⚠️ *Garage Full — Fleet Command Add-on Needed*\n\nYour plan allows *${branchCapacity.capacity}* active vehicle(s). Add a slot at *${addonPriceLabel}/month*:\n👉 ${await shortenUrl(supabaseClient, addon.ok ? addon.checkoutUrl : 'https://sakafleet.com/pricing')}`;
    } else {
      const nextTier = branchCapacity.nextTierKey || 'fleet_command';
      const upgrade = await checkoutForTier({
        supabase: supabaseClient,
        owner: branchOwner,
        targetTierKey: nextTier,
        interval: entitlements?.billingInterval || 'monthly',
        currency: countryInfo?.currency || 'USD'
      });
      customReply = `⚠️ *Vehicle Capacity Limit Reached*\n\nYour current plan (*${branchCapacity.tierName}*) allows ${branchCapacity.capacity} vehicle(s).\n\nUpgrade to *${getTierLabel(nextTier)}*:\n👉 ${await shortenUrl(supabaseClient, upgrade.ok ? upgrade.checkoutUrl : 'https://sakafleet.com/pricing')}`;
    }
    customReply = String(customReply || '') + capacityTrialNote;
    onboardingStore.delete(senderPhone);
    session.state = hasVehicleRegistered ? 'ACTIVE' : 'IDLE';
    session.onboardingStep = null;
  } else {
    let obState = onboardingStore.get(senderPhone) || buildOnboardingSeed({ ownerEmail: profileData?.email || null });
    onboardingStore.set(senderPhone, obState);

    const isFeedbackOrUnrelated = checkIsConversationalFeedback(messageText, obState.step);

    if (isFeedbackOrUnrelated) {
      if (obState.stage === 2) {
        customReply = `I noticed your message ("${messageText.trim()}").\n\nYou can optionally share specs like insurance expiry, VIN, transmission, or simply reply **'Skip'** or **'Done'** to finish.`;
      } else if (!obState.core.plate_number) {
        customReply = await composeMessage({
          purpose: 'onboarding_weave_nudge',
          facts: {
            nextStep: 'reply with the registration plate number',
            examples: ['KDA 123A'],
            cancelWord: 'cancel'
          },
          language: targetLang,
          countryInfo,
          profile: profileData,
          fallbackText: `I noticed your message. If you want to cancel, reply **'cancel'**.\n\nOtherwise, please reply with your vehicle's registration plate number (e.g. *KDA 123A*).`
        });
      } else {
        customReply = `I noticed your message ("${messageText.trim()}").\n\nIf you want to restart or cancel onboarding, reply **'reset'** or **'cancel'**.\nOtherwise, please share your vehicle's details (e.g. *"1991 diesel 80 series, mileage 366700, email user@mail.com"*).`;
      }
    } else if (obState.stage === 2) {
      customReply = await handleStage2OptionalWeaving({
        obState,
        mergedExt,
        messageText,
        senderPhone,
        session,
        countryInfo,
        supabaseClient
      });
    } else {
      customReply = await handleStage1CoreCapture({
        obState,
        mergedExt,
        messageText,
        senderPhone,
        session,
        profileData,
        countryInfo,
        supabaseClient,
        formattedPhone
      });
    }
  }
  return { handled: true, reply: customReply };
}

export async function startLegacyRegistrationFlow({
  session,
  mergedExt,
  senderPhone,
  profileData,
  targetLang,
  countryInfo,
  onboardingStore
}) {
  let customReply = null;
  const initPlate = mergedExt.plate_number ? mergedExt.plate_number.toUpperCase().trim() : null;
  onboardingStore.set(senderPhone, buildOnboardingSeed({ plateNumber: initPlate, ownerEmail: profileData?.email || null }));
  session.state = 'ONBOARDING';
  session.onboardingStep = initPlate ? 2 : 1;
  session.onboardingStage = 1;
  if (initPlate) {
    customReply = `🚘 *Vehicle core details* 📝\n\nGot registration plate *${initPlate}*!\n\nCould you share the **Make & Model**, **Year of Manufacture (YOM)**, **Fuel Type (Diesel/Petrol/Hybrid/EV)**, **Current Mileage**, and your **Email**?\n\n💡 *Tip:* Send them all together in one message (e.g. "1991 diesel 80 series, mileage 366700, email user@mail.com").\n\n_(Type *Cancel* to stop, or *Restart* to begin again.)_`;
  } else {
    customReply = await composeMessage({
      purpose: 'registration_plate_question',
      facts: {
        stage: 'Vehicle registration',
        nextStep: 'reply with the registration plate number for the new vehicle',
        examples: ['KDA 123A', 'KBC 456X'],
        cancelWord: 'Cancel'
      },
      language: targetLang,
      countryInfo,
      profile: profileData,
      fallbackText: `🚘 *Stage 1 of 2 · Step 1 of 4: Vehicle Registration Plate*\n\nPlease reply with the registration plate number for your new vehicle (e.g. *KDA 123A* or *KBC 456X*).\n\n_(Type *Cancel* to stop.)_`
    });
  }
  return { handled: true, reply: customReply };
}
