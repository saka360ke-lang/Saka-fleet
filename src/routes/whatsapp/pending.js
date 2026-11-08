/**
 * Saka Fleet - WhatsApp pending turn handlers (Phase 5B-3 of the whatsapp.js split, v1.68.0).
 * ---------------------------------------------------------------------------------------------
 * The Phase 4 pending state family consumed as data: every per-kind handler below was moved
 * verbatim out of the processor. The migration-on-read shim (hydrateTurnSession) still folds
 * the legacy fields into ONE `session.pending` slot and re-exposes the legacy names as
 * accessors, so these handlers keep mutating `session.pendingClearChat`, … exactly as before.
 *
 * BOUNDARY CONTRACT (section 190): pending.js is a leaf route module. It may import from
 * src/services/* and from ./helpers.js (a leaf), but NEVER from ./messages.js. It takes
 * state as arguments and returns data; the processor performs every send, every
 * chatSessions.set and every `return { status }`. The two early lanes' inline sends are the
 * only sanctioned send->return deltas.
 *
 * The live dispatch stays POSITIONAL in the processor (byte-identical claim order). The
 * optional `classifyPendingLane()` wrapper exposes the tested `resolvePendingTurn()`
 * contract for the future single-point adoption; it is not wired into the live path.
 *
 * pending.js imports NOTHING from routes except the leaf helpers.js - no cycles.
 */

import { CHAT_HISTORY_MAX_MESSAGES } from '../../services/chatHistory.js';
import { handleCareRequest } from '../../services/customerCare.js';
import {
  setBuyerDetailsAndSendReleaseOtp,
  verifyOwnerReleaseOtpAndNotifyBuyer,
  completePassbookTransfer
} from '../../services/transfers.js';
import {
  cancelPendingAssignment,
  verifyOwnerAssignmentOtp,
  createDriverAssignment,
  submitDriverCompliance,
  getDriverComplianceStatus,
  getActiveAssignment,
  notifyOwnerComplianceCleared
} from '../../services/driverAssignments.js';
import { findVehicleByCandidate, deleteVehicle } from '../../services/vehicles.js';
import {
  getEntitlements,
  checkoutForTier,
  checkoutForAddon,
  cancelSubscription,
  resumeSubscription,
  formatSubscriptionSummary,
  formatTierChoices,
  selectVehiclesToKeep
} from '../../services/subscriptions.js';
import {
  startAccountTrial,
  buildTrialEndOffer,
  applyAccountTrialExtensionCoupon
} from '../../services/trialEngine.js';
import { getTierLabel, getAnnualDiscountPercent } from '../../services/subscriptionTiers.js';
import { shortenUrl } from '../../services/linkShortener.js';
import { resolveBundledCatalog } from '../../services/complianceCatalog.js';
import { resolveVehicleComplianceCatalog, submitVehicleCompliance } from '../../services/vehicleCompliance.js';
// v1.84.0 (Phase 23) — link a vaulted certificate to the compliance row it proved.
import { linkSavedComplianceDocument } from '../../services/vehicleDocuments.js';
import {
  catalogCandidates,
  pickComplianceContextVehicle,
  mergeComplianceCapture,
  complianceCapturePrompt,
  formatComplianceSaved,
  isComplianceCaptureCancel,
  complianceCaptureCancelText,
  isComplianceCaptureExpired,
  isPhotoIntent,
  isUnreadableMediaNote,
  detectDocumentTypeCorrection,
  extractFromPastedDocument
} from '../../services/complianceCapture.js';
import { resolveUserTimezone } from '../../services/globalization.js';
import { composeMessage } from '../../services/conversationEngine.js';
import {
  resolveNarrativeBatchTurn,
  renderNarrativeBatchCard,
  narrativeDraftFields,
  narrativeDraftExtras,
  describeNarrativeDraft
} from '../../services/narrativeDraft.js';
import { handleQuizTurn } from '../../services/quizEngine.js';
import { sendEmailOtp } from '../../services/mailer.js';
import { resolvePendingTurn } from '../../services/pendingState.js';
import { parseTierFromMessage, parseIntervalFromMessage } from './helpers.js';
/* ------------------------------------------------------------------ */
/* 1. clear-chat (early lane)                                           */
/* ------------------------------------------------------------------ */

/**
 * Start the clear-chat confirmation (moved verbatim from messages.js L388-399).
 * The processor performs the chatSessions.set + send + saveChatMessage and returns
 * the `clear_chat_confirm` status.
 */
export function startClearChatTurn({ session, messageText }) {
  session.pendingClearChat = true;
  const confirmClear = "This only clears our chat history - your vehicles, expenses and reminders stay safe. Reply *CLEAR* to confirm, or *cancel* to keep chatting.";
  session.history = session.history || [];
  session.history.push({ role: "user", parts: [{ text: messageText }] });
  session.history.push({ role: "model", parts: [{ text: confirmClear }] });
  if (session.history.length > CHAT_HISTORY_MAX_MESSAGES) session.history = session.history.slice(-CHAT_HISTORY_MAX_MESSAGES);
  return { reply: confirmClear, status: "clear_chat_confirm" };
}

/**
 * Resolve the clear-chat confirmation turn (moved verbatim from messages.js L400-427).
 * Returns `{ reply, status, saveHistory }`, or null when the message is neither CLEAR
 * nor cancel (the pending is cleared and the turn continues). The processor performs
 * the sends/saves it used to do inline.
 */
export async function resolveClearChatTurn({ session, cleanCmd, senderPhone, supabaseClient }) {
  if (/^clear$/i.test(cleanCmd)) {
    try {
      if (supabaseClient) {
        await supabaseClient.from("chat_history").delete().eq("user_phone", senderPhone);
        await supabaseClient.from("chat_transcripts").delete().eq("phone_number", senderPhone);
        await supabaseClient.from("processed_webhooks").delete().eq("phone_number", senderPhone);
      }
    } catch { }
    session.history = [];
    session.pendingClearChat = false;
    session.sakaIntroduced = false;
    session.quiz = null;
    const cleared = "Fresh start! Our chat is cleared - your vehicles, expenses and reminders are safe. What would you like to do?";
    return { reply: cleared, status: "chat_cleared", saveHistory: true };
  } else if (/^(cancel|no|stop)$/i.test(cleanCmd)) {
    session.pendingClearChat = false;
    const keepChat = "Okay, I have not cleared anything.";
    return { reply: keepChat, status: "clear_chat_cancelled", saveHistory: false };
  } else {
    session.pendingClearChat = false;
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 2. support intake (early lane, v1.58.22 owns the NEXT turn)          */
/* ------------------------------------------------------------------ */

/**
 * Resolve the pending support intake (moved verbatim from messages.js L432-449).
 * Returns the reply text; the processor performs the chatSessions.set + send + save
 * and returns the `support_intake_handled` status.
 */
export async function resolveSupportIntakeTurn({ session, messageText, senderPhone, supabaseClient }) {
  const cleanSupport = messageText.trim().toLowerCase();
  let supportReply;
  if (/^(cancel|exit|stop)$/i.test(cleanSupport)) {
    session.pendingSupportEscalation = false;
    supportReply = 'Okay — support escalation cancelled. What would you like to do next?';
  } else {
    const care = await handleCareRequest(supabaseClient, { phone: senderPhone, text: messageText.trim() });
    session.pendingSupportEscalation = false;
    supportReply = care?.ticketCreated
      ? "🎫 Thank you — I've logged this for our support team at support@reports.sakafleet.com. They'll reach out to you here on WhatsApp."
      : "Thanks — I couldn't open a support ticket automatically just now. Please email support@reports.sakafleet.com with a line about what happened, or reply *Support* to try again.";
  }
  return supportReply;
}

/**
 * The tested Phase 4 resolver, exposed for the future single-point adoption. The LIVE
 * dispatch in the processor stays positional; this wrapper changes nothing today.
 */
export function classifyPendingLane(session, text, ctx) {
  return resolvePendingTurn(session, text, ctx);
}
/* ------------------------------------------------------------------ */
/* 3. passbook transfer release flow (transferFlow, steps 2 & 3)        */
/* ------------------------------------------------------------------ */

/**
 * The in-flight owner transfer turn (moved verbatim from messages.js L1087-1155).
 * `sendWhatsApp` is the processor's Meta sender (passed in - pending.js never sends).
 */
export async function handleTransferFlowTurn({ session, messageText, supabaseClient, sendWhatsApp, targetLang, countryInfo, profileData }) {
  let reply = null;
  if (session.transferFlow) {
    const cleanText = messageText.trim().toLowerCase();
    if (/^(cancel|exit|stop|cancel transfer)$/i.test(cleanText)) {
      if (session.transferFlow.transferId && supabaseClient) {
        await supabaseClient.from('passbook_transfers').update({ status: 'CANCELLED' }).eq('id', session.transferFlow.transferId);
      }
      session.transferFlow = null;
      reply = await composeMessage({
        purpose: 'flow_cancellation_ack',
        facts: { flow: 'Passbook transfer', cancelled: true },
        language: targetLang,
        countryInfo,
        profile: profileData,
        fallbackText: 'Passbook transfer cancelled. You are back in main menu mode.'
      });
    } else if (session.transferFlow.step === 2) {
      const phoneMatch = messageText.match(/\+?[0-9]{9,15}/);
      const emailMatch = messageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

      if (phoneMatch && emailMatch) {
        const res = await setBuyerDetailsAndSendReleaseOtp({
          transferId: session.transferFlow.transferId,
          buyerPhone: phoneMatch[0],
          buyerEmail: emailMatch[0],
          supabase: supabaseClient
        });

        if (res.success) {
          session.transferFlow.step = 3;
          session.transferFlow.buyerPhone = res.buyerPhone;
          session.transferFlow.ownerEmail = res.ownerEmail;
          reply = `🔒 *Step 3 of 5: Security Authorization*\n\nWe dispatched a 6-digit release PIN to your email (*${res.ownerEmail}*).\n\nPlease reply with the 6-digit code to authorize releasing ownership of *${session.transferFlow.vehicle.plate_number}* to ${res.buyerPhone}.\n\n_(Reply 'cancel' to abort)_`;
        } else {
          reply = `⚠️ ${res.error}\n\nPlease reply with both the buyer's WhatsApp number and email address, or reply 'cancel'.`;
        }
      } else {
        reply = await composeMessage({
          purpose: 'transfer_buyer_details_prompt',
          facts: {
            step: 'Step 2 of 5',
            askedFor: ["the buyer's WhatsApp number", "the buyer's email address"],
            example: '+254712345678 buyer@example.com',
            cancelWord: 'cancel'
          },
          language: targetLang,
          countryInfo,
          profile: profileData,
          fallbackText: `👉 *Step 2 of 5: Buyer Details*\n\nPlease provide both the buyer's WhatsApp phone number and email address (e.g. \`+254712345678 buyer@example.com\`).\n\n_(Reply 'cancel' to abort)_`
        });
      }
    } else if (session.transferFlow.step === 3) {
      const pinCandidate = messageText.trim();
      const res = await verifyOwnerReleaseOtpAndNotifyBuyer({
        transferId: session.transferFlow.transferId,
        providedOtp: pinCandidate,
        supabase: supabaseClient,
        sendWhatsAppFn: sendWhatsApp
      });

      if (res.success) {
        const plate = session.transferFlow.vehicle.plate_number;
        session.transferFlow = null;
        reply = `✅ *Asset Release Authorized!*\n\nWe have notified the buyer on WhatsApp at *${res.buyerPhone}*.\n\nAwaiting the buyer's reply to claim ownership of *${plate}*.`;
      } else {
        reply = `❌ ${res.error}\n\nPlease enter the correct 6-digit release code sent to your email, or reply 'cancel' to abort.`;
      }
    }
  }
  return { reply };
}
/* ------------------------------------------------------------------ */
/* 4. owner driver-assignment OTP (legacy command path)                 */
/* ------------------------------------------------------------------ */

/**
 * The assignment-OTP turn (moved verbatim from messages.js L1195-1260). The processor
 * keeps the shape-gated guard; this handler returns null only when there is no Supabase
 * client (the branch is claimed but nothing can run, exactly as before).
 */
export async function handleAssignmentOtpTurn({ session, messageText, supabaseClient, profileData, existingVehicles = [], targetVeh = null, sendWhatsApp, targetLang, countryInfo }) {
  let handled = false;
  let reply = null;
  if (supabaseClient) {
    const clean = messageText.trim();
    if (/^(cancel|exit|stop)$/i.test(clean)) {
      await cancelPendingAssignment({
        supabase: supabaseClient,
        assignmentId: session.pendingAssignmentOtp.assignmentId,
        ownerId: profileData?.id
      });
      session.pendingAssignmentOtp = null;
      handled = true;
      reply = await composeMessage({
        purpose: 'assignment_cancelled',
        facts: { cancelled: true, driverNotified: false },
        language: targetLang,
        countryInfo,
        profile: profileData,
        fallbackText: 'Driver assignment cancelled. No driver was notified.'
      });
    } else if (/^(resend|resend code|new code|send again)$/i.test(clean)) {
      const vehicle = existingVehicles.find((v) => v.id === session.pendingAssignmentOtp.vehicleId) || targetVeh;
      const resent = await createDriverAssignment({
        supabase: supabaseClient,
        ownerProfile: profileData,
        vehicle,
        driverPhone: session.pendingAssignmentOtp.driverPhone,
        handoverOdometer: Number(vehicle?.current_mileage || vehicle?.odometer_reading || 0) || null,
        countryInfo,
        sendWhatsApp: sendWhatsApp
      });
      handled = true;
      if (resent.ok) {
        session.pendingAssignmentOtp = {
          assignmentId: resent.assignment.id,
          vehicleId: resent.assignment.vehicle_id,
          driverPhone: resent.driverPhone,
          expiresAt: resent.expiresAt
        };
        reply = await composeMessage({
          purpose: 'otp_dispatched',
          facts: { deliveredTo: 'your verified email', action: 'Reply with the code to continue.' },
          language: targetLang,
          countryInfo,
          profile: profileData,
          fallbackText: '🔐 A fresh 6-digit code has been emailed to you. Reply with it to continue.'
        });
      } else {
        reply = `❌ ${resent.error}`;
      }
    } else {
      const verified = await verifyOwnerAssignmentOtp({
        supabase: supabaseClient,
        assignmentId: session.pendingAssignmentOtp.assignmentId,
        ownerId: profileData?.id,
        code: clean,
        sendWhatsApp: sendWhatsApp
      });
      handled = true;
      if (verified.ok) {
        session.pendingAssignmentOtp = null;
        reply = `✅ *Assignment Verified*\n\nWe notified *${verified.driverPhone}* about *${verified.plate}*. They must reply *ACCEPT* to take over the vehicle.\n\nOnce they accept, Saka will guide them through email verification and their ${verified.vehicle?.asset_type ? 'compliance details' : 'driving licence'} before they can manage it.`;
      } else {
        if (verified.cancelled || verified.expired) session.pendingAssignmentOtp = null;
        reply = `❌ ${verified.error}`;
      }
    }
  }
  return handled ? { reply } : null;
}
/* ------------------------------------------------------------------ */
/* 5. buyer email OTP (passbook transfer step 5)                        */
/* ------------------------------------------------------------------ */

/**
 * The buyer-OTP turn (moved verbatim from messages.js L1264-1290). The processor keeps
 * the guard (including the pinned stateless 6-digit sink); this handler returns null when
 * the code was not accepted so the turn continues exactly as before.
 */
export async function handleBuyerOtpTurn({ session, messageText, supabaseClient, senderPhone, profileData, formattedPhone, entitlements, countryInfo, sendWhatsApp }) {
  let handled = false;
  let reply = null;
  if (supabaseClient) {
    const transferCompleteRes = await completePassbookTransfer({
      buyerPhone: senderPhone,
      providedOtp: messageText.trim(),
      supabase: supabaseClient,
      sendWhatsAppFn: sendWhatsApp
    });
    if (transferCompleteRes.success) {
      handled = true;
      session.pendingTransferBuyerOtp = null;
      session.state = 'ACTIVE';
      reply = `🎉 *Congratulations!* You are now the official registered owner of *${transferCompleteRes.plateNumber}* on Saka Fleet! 🚗\n\n• *VIN:* \`${transferCompleteRes.vin}\`\n• *Passbook Token:* \`${transferCompleteRes.newToken}\`\n\nYour official digital passbook has been sent to *${transferCompleteRes.buyerEmail}*.\nType *"What can I do?"* to explore your owner tools!`;
    } else if (transferCompleteRes.needsUpgrade) {
      // Simple Rule R2 — buyer over capacity: send the upgrade link,
      // keep the transfer paused, and accept the same code afterwards.
      handled = true;
      const cap = transferCompleteRes.capacity || {};
      const upgrade = await checkoutForTier({
        supabase: supabaseClient,
        owner: { id: profileData?.id, phone_number: formattedPhone, email: profileData?.email },
        targetTierKey: cap.nextTierKey || 'team_fleet',
        interval: entitlements?.billingInterval || 'monthly',
        currency: countryInfo?.currency || 'USD'
      });
      reply = `⚠️ *Upgrade needed to accept this passbook*\n\nYour *${cap.tierName || 'current'}* plan allows ${cap.capacity || 1} active vehicle(s) and you already have ${cap.currentCount || 0}.\n\nUpgrade to *${getTierLabel(cap.nextTierKey || 'team_fleet')}* to accept the transfer:\n👉 ${await shortenUrl(supabaseClient, upgrade.ok ? upgrade.checkoutUrl : 'https://sakafleet.com/pricing')}\n\nAfter payment, reply *resend* to get a fresh verification code and finish the handover. The seller's vehicle stays untouched until then.`;
    }
  }
  return handled ? { reply } : null;
}

/* ------------------------------------------------------------------ */
/* 6. subscription / trial turn + cancel-subscription pending           */
/* ------------------------------------------------------------------ */

/**
 * The engine-owned subscription lane (moved verbatim from messages.js L1332-1347). The
 * processor keeps the guard; entitlements overrides ride back as data.
 */
export async function handleSubscriptionTurn({ intent, messageText, mergedExt, session, profileData, supabaseClient, countryInfo, senderPhone, entitlements, existingVehicles }) {
  const subTurn = await maybeHandleSubscriptionTurn({
    intent,
    messageText,
    mergedExt,
    session,
    profileData,
    supabaseClient,
    countryInfo,
    senderPhone,
    entitlements,
    existingVehicles
  });
  return { reply: subTurn.reply, entitlements: subTurn.entitlements || null };
}
/* ------------------------------------------------------------------ */
/* 7. pending compliance capture (v1.58.25 owns its follow-up turn)     */
/* ------------------------------------------------------------------ */

/**
 * The pending compliance capture (moved verbatim from messages.js L1451-1547). The
 * processor keeps the guard (incl. the unreadable-media note and the fresh-log test).
 * Returns `{ reply }` (all reply-producing branches set isSpecialFlowHandled) or null
 * when the capture expired/was unknown (pending cleared, turn continues).
 */
export async function handleComplianceCaptureTurn({ session, messageText, supabaseClient, profileData, existingVehicles, countryInfo }) {
  let handled = false;
  let reply = null;
  const pending = session.pendingComplianceCapture;
  const pendingScope = pending.scope === 'vehicle' ? 'vehicle' : 'driver';
  const context = pickComplianceContextVehicle({ vehicles: existingVehicles, profileId: profileData?.id });
  const pendingAssetType = context.vehicle?.asset_type || context.vehicle?.metadata?.asset_type || null;
  const pendingCatalog = pendingScope === 'vehicle'
    ? resolveVehicleComplianceCatalog({ countryCode: countryInfo?.country_code || 'GLOBAL', assetType: pendingAssetType, includeAll: true })
    : resolveBundledCatalog({ countryCode: countryInfo?.country_code || 'GLOBAL', assetType: pendingAssetType, includeAll: true });
  const pendingItem = catalogCandidates(pendingCatalog).find((entry) => entry.type === pending.type) || null;
  if (isComplianceCaptureCancel(messageText)) {
    session.pendingComplianceCapture = null;
    handled = true;
    reply = complianceCaptureCancelText();
  } else if (isComplianceCaptureExpired(pending) || !pendingItem) {
    session.pendingComplianceCapture = null;
  } else if (pendingScope === 'driver' && detectDocumentTypeCorrection(messageText)) {
    // v1.61.3 — "This is a psv licence not drivers license" re-buckets
    // the pending capture instead of looping on the wrong document.
    const correctedType = detectDocumentTypeCorrection(messageText);
    const correctedItem = catalogCandidates(pendingCatalog).find((entry) => entry.type === correctedType) || pendingItem;
    session.pendingComplianceCapture = { ...pending, scope: 'driver', type: correctedItem.type, at: new Date().toISOString() };
    handled = true;
    reply = `Got it — switching to your *${correctedItem.label}* (a DRIVER document, not a vehicle permit).\n\nSend the number and expiry in one line — e.g. _${correctedItem.label} TSV2026 expires 8 Aug 2027_.`;
  } else if (isUnreadableMediaNote(messageText)) {
    // v1.61.3 — an unreadable photo during a capture never falls to the
    // menu (the old system note tripped the fresh-log guard).
    session.pendingComplianceCapture = { ...pending, at: new Date().toISOString() };
    handled = true;
    reply = `📸 I couldn't read that photo. Send the number and expiry in one line — e.g. _${pendingItem.label} 445566 expires 8 Aug 2027_ — or a clearer photo.`;
  } else if (isPhotoIntent(messageText)) {
    // v1.61.3 — "Can I share a picture?" gets a warm yes + the rule
    // (confirm before save), not a looped typed-only example.
    session.pendingComplianceCapture = { ...pending, at: new Date().toISOString() };
    handled = true;
    reply = `📸 Yes — send the photo now. I'll read the number and expiry and confirm with you before saving.${pendingScope === 'driver' ? '\n\n_Driver documents are saved on your profile, never on the vehicle._' : ''}`;
  } else {
    const timeZone = resolveUserTimezone({ countryInfo, profile: profileData });
    // v1.61.3 — a pasted document paragraph is read label-anchored (a
    // whole licence pasted into chat), never by grabbing a random token.
    const pasted = extractFromPastedDocument(messageText, { timeZone });
    const pastedDaysLeft = pasted ? Math.ceil((new Date(pasted.expiry).getTime() - Date.now()) / 86400000) : null;
    const merged = pasted
      ? {
        ok: true,
        parsed: {
          ok: true,
          number: pasted.number,
          expiry: pasted.expiry,
          dueAt: null,
          lifetime: false,
          daysLeft: pastedDaysLeft,
          expired: pastedDaysLeft !== null && pastedDaysLeft < 0,
          timeZone,
          catalogItem: pendingItem
        }
      }
      : mergeComplianceCapture(pending, messageText, {
      item: pendingItem,
      countryCode: countryInfo?.country_code || 'GLOBAL',
      locale: countryInfo?.locale || 'en-US',
      timeZone
    });
    handled = true;
    if (merged?.ok) {
      const saved = await persistCapturedCompliance({
        supabaseClient,
        profileData,
        scope: pendingScope,
        item: pendingItem,
        parsed: merged.parsed,
        vehicle: context.vehicle,
        isSelfProfile: context.isSelfProfile,
        isMinimal: pendingScope === 'driver' && !context.isSelfProfile && pendingItem.type === pendingCatalog.minimal?.type,
        countryCode: countryInfo?.country_code || 'GLOBAL',
        assetType: pendingAssetType,
        timeZone,
        // v1.84.0 (Phase 23) — a photo vaulted this turn links to the saved row.
        documentId: pending?.document_id || session.pendingVehicleDocument?.document_id || null
      });
      session.pendingComplianceCapture = null;
      reply = saved.ok
        ? formatComplianceSaved({ item: pendingItem, parsed: merged.parsed, scope: pendingScope, contextLabel: context.vehicle?.plate_number || null })
        : `❌ ${saved.error}`;
    } else {
      const nextNumber = merged?.number || pending.number || null;
      const nextExpiry = merged?.expiry || pending.expiry || null;
      session.pendingComplianceCapture = {
        ...pending,
        number: nextNumber,
        expiry: nextExpiry,
        at: new Date().toISOString()
      };
      reply = complianceCapturePrompt({
        item: pendingItem,
        scope: pendingScope,
        have: { number: nextNumber, expiry: nextExpiry, lifetime: merged?.lifetime ?? pending.lifetime },
        contextLabel: context.vehicle?.plate_number || null
      });
    }
  }
  return handled ? { reply } : null;
}
/**
 * Persist a parsed compliance item (moved verbatim from messages.js L4034-4092).
 * Exported because the in-processor direct driver-document lane still uses it.
 */
export async function persistCapturedCompliance({
  supabaseClient,
  profileData,
  scope = 'driver',
  item,
  parsed,
  vehicle = null,
  isSelfProfile = false,
  isMinimal = false,
  countryCode = 'GLOBAL',
  assetType = null,
  timeZone = null,
  // v1.84.0 (Phase 23) — the vaulted document id carried from the media turn.
  documentId = null
} = {}) {
  if (!supabaseClient || !profileData?.id || !item?.type || !parsed?.ok) {
    return { ok: false, error: 'I need the document number and expiry first.' };
  }
  try {
    if (scope === 'vehicle') {
      if (!vehicle) return { ok: false, error: 'Add your vehicle first, then I can save that.' };
      const result = await submitVehicleCompliance({
        supabase: supabaseClient,
        vehicle,
        item,
        parsed,
        countryCode,
        assetType,
        ownerId: profileData.id,
        timeZone
      });
      if (!result?.ok) return { ok: false, error: result?.error || 'That could not be saved yet.' };
      // v1.84.0 (Phase 23) — the stored certificate links to the row it proved
      // (explicit prefill id wins; the newest matching file is the fallback).
      await linkSavedComplianceDocument({
        supabase: supabaseClient,
        vehicleId: vehicle.id,
        complianceType: item.type,
        documentId
      });
      return { ok: true };
    }

    const result = await submitDriverCompliance({
      supabase: supabaseClient,
      driverId: profileData.id,
      item,
      parsed,
      isMinimal: Boolean(isMinimal) && !isSelfProfile,
      countryCode,
      assetType,
      timeZone
    });
    if (!result?.ok) {
      return { ok: false, error: result?.error || 'That could not be saved yet.' };
    }
    if (isMinimal && !isSelfProfile && vehicle?.id) {
      try {
        const status = await getDriverComplianceStatus({ supabase: supabaseClient, driverId: profileData.id, assetType });
        const assignment = await getActiveAssignment({ supabase: supabaseClient, driverId: profileData.id, vehicleId: vehicle.id });
        if (status.canManage && assignment) {
          await notifyOwnerComplianceCleared({ supabase: supabaseClient, assignment, status });
        }
      } catch { /* owner notice is best-effort */ }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'That could not be saved yet.' };
  }
}
/* ------------------------------------------------------------------ */
/* 8. narrative batch (D4: SAVE ALL / edit N / cancel)                  */
/* ------------------------------------------------------------------ */

/**
 * The pending multi-record batch (moved verbatim from messages.js L1784-1854). Returns:
 *   null                                  nothing matched (incl. no pending card);
 *   { handled:true, reply, suppressQuiz } a card/cancel outcome owns the turn;
 *   { handled:false, forcedFlow, aiExtracted } "edit N" reopens that draft in the quiz.
 */
export async function handleNarrativeBatchTurn({ session, messageText, narrativeBatchCardReply = null, quizCtx, mergedExt, targetLang, countryInfo, profileData }) {
  const pendingBatch = session.narrativeBatch || null;
  const batchTurn = pendingBatch
    ? resolveNarrativeBatchTurn({ batch: pendingBatch, text: messageText })
    : { type: 'none' };
  if (batchTurn.dropBatch) session.narrativeBatch = null;
  if (pendingBatch && batchTurn.type !== 'none') {
    if (batchTurn.type === 'save-all') {
      const saved = [];
      for (const draft of pendingBatch.drafts) {
        try {
          const flow = draft.kind === 'earning' ? 'log_earnings' : (draft.kind === 'mileage' ? 'log_mileage' : 'log_expense');
          const batchSession = {};
          await handleQuizTurn({
            session: batchSession,
            messageText: '',
            startFlow: flow,
            aiExtracted: { ...narrativeDraftFields(draft), _narrative: narrativeDraftExtras(draft) },
            ctx: quizCtx
          });
          const confirmed = await handleQuizTurn({ session: batchSession, messageText: '1', ctx: quizCtx });
          if (confirmed.completed) {
            saved.push(describeNarrativeDraft(draft, {
              locale: countryInfo?.locale || 'en-US',
              currency: countryInfo?.currency || 'USD'
            }));
          }
        } catch (batchErr) {
          console.warn('[narrative] batch row failed:', batchErr.message);
        }
      }
      session.narrativeBatch = null;
      const reply = saved.length
        ? `✅ *Saved ${saved.length} of ${pendingBatch.drafts.length} records* 📝\n\n${saved.map((line, i) => `${i + 1}. ${line}`).join('\n')}`
        : '⚠️ I could not save those records just now — nothing was written.';
      return { handled: true, reply, suppressQuiz: true };
    } else if (batchTurn.type === 'cancel') {
      const reply = await composeMessage({
        purpose: 'batch_cancelled',
        facts: { saved: false },
        language: targetLang,
        countryInfo,
        profile: profileData,
        fallbackText: '❌ Nothing was saved.'
      });
      return { handled: true, reply, suppressQuiz: true };
    } else if (batchTurn.type === 'invalid-edit') {
      const reply = renderNarrativeBatchCard(pendingBatch.drafts, {
        locale: countryInfo?.locale || 'en-US',
        currency: countryInfo?.currency || 'USD'
      });
      return { handled: true, reply, suppressQuiz: true };
    } else if (batchTurn.type === 'edit') {
      const editDraft = pendingBatch.drafts[batchTurn.index];
      const forcedFlow = editDraft.kind === 'earning' ? 'log_earnings' : (editDraft.kind === 'mileage' ? 'log_mileage' : 'log_expense');
      const aiExtracted = {
        ...(mergedExt || {}),
        ...narrativeDraftFields(editDraft),
        _narrative: narrativeDraftExtras(editDraft)
      };
      return { handled: false, forcedFlow, aiExtracted };
    }
  } else if (narrativeBatchCardReply) {
    // The plan card was rendered for this paragraph; suppress the quiz so
    // the card is the ONLY reply and the batch waits for its turn.
    return { handled: true, reply: narrativeBatchCardReply, suppressQuiz: true };
  }
  return null;
}
/* ------------------------------------------------------------------ */
/* 9. owner vehicle-deletion confirmation gate                          */
/* ------------------------------------------------------------------ */

/**
 * The owner deletion confirmation gate (moved verbatim from messages.js L2430-2473).
 * The processor keeps the `if (session.pendingDeleteVehicle)` guard.
 */
export async function handleDeleteVehicleTurn({ session, messageText, profileData, supabaseClient, existingVehicles, targetLang, countryInfo }) {
  let reply = null;
  const cleanConfirmation = messageText.trim().toLowerCase();
  const pendingDeletion = session.pendingDeleteVehicle;

  if (/^(yes|y|confirm|delete|proceed)$/i.test(cleanConfirmation)) {
    const deletionResult = await deleteVehicle({
      vehicleId: pendingDeletion.vehicleId,
      requesterId: profileData?.id,
      supabase: supabaseClient
    });
    session.pendingDeleteVehicle = null;

    if (deletionResult.success) {
      if (session.active_vehicle_id === pendingDeletion.vehicleId) {
        session.active_vehicle_id = null;
      }
      const remaining = existingVehicles.filter(v => v.id !== pendingDeletion.vehicleId);
      const deletedCardText = `🗑️ *Vehicle Deleted Successfully*\n\n` +
        `• *Vehicle:* ${pendingDeletion.plateNumber}\n` +
        `• *Driver:* ${deletionResult.cleanup?.driverUnassigned ? 'unassigned ✅' : 'none assigned'}\n` +
        `• *Pending transfers:* ${deletionResult.cleanup?.transfersCancelled || 0} cancelled\n` +
        `• *Historical logs:* preserved for audit 🔒\n` +
        `• *VIN ledger:* retained (one trial per VIN forever) 🔒\n\n` +
        (remaining.length > 0
          ? `Remaining active vehicles: ${remaining.map(v => v.plate_number).join(', ')}`
          : `You have no active vehicles left. Type *Register* to add a new vehicle.`);
      reply = await composeMessage({
        purpose: 'flow_outcome_card',
        facts: { cardText: deletedCardText, instruction: 'Re-render this engine card conversationally: keep EVERY figure, label, emoji anchor and next step exactly as written. Never drop or invent a figure.' },
        language: targetLang,
        countryInfo,
        profile: profileData,
        fallbackText: deletedCardText
      });
    } else {
      reply = `❌ *Vehicle Deletion Failed*\n\n${deletionResult.error}`;
    }
  } else if (/^(cancel|exit|stop|no|abort)$/i.test(cleanConfirmation)) {
    session.pendingDeleteVehicle = null;
    reply = `Deletion cancelled. *${pendingDeletion.plateNumber}* remains in your fleet.`;
  } else {
    reply = `⚠️ Please reply *YES* to confirm deletion of *${pendingDeletion.plateNumber}*, or *Cancel* to abort.`;
  }
  return { reply };
}
/* ------------------------------------------------------------------ */
/* 10. driver assignment (trigger + pendingDriverAssignment)            */
/* ------------------------------------------------------------------ */

/**
 * The driver-assignment lane (moved verbatim from messages.js L2475-2531). The processor
 * keeps the guard; `sendWhatsApp` is the processor's Meta sender (never sent from here).
 */
export async function handleDriverAssignmentTurn({ session, messageText, mergedExt = {}, existingVehicles, targetVeh = null, profileData, supabaseClient, countryInfo, sendWhatsApp, targetLang }) {
  let reply = null;
  let assignTarget = targetVeh;
  if (mergedExt.plate_number) {
    const found = findVehicleByCandidate(existingVehicles, mergedExt.plate_number);
    if (found) assignTarget = found;
  } else if (session.pendingDriverAssignment) {
    const found = existingVehicles.find(v => v.id === session.pendingDriverAssignment.vehicleId);
    if (found) assignTarget = found;
  }

  if (!assignTarget) {
    reply = await composeMessage({
      purpose: 'vehicle_not_found_notice',
      facts: { issue: 'No matching vehicle found in the registered fleet' },
      language: targetLang,
      countryInfo,
      profile: profileData,
      fallbackText: '⚠️ I could not find that vehicle in your registered fleet.'
    });
    session.pendingDriverAssignment = null;
  } else {
    let driverPhone = mergedExt.driver_phone;
    const manualPhoneMatch = messageText.match(/(?:\+?254|0)[17]\d{8}|\+?\d{9,15}/);
    if (!driverPhone && manualPhoneMatch) {
      driverPhone = manualPhoneMatch[0];
    }

    // TODO(PROP-2026-11-06-02): pendingDriverAssignment does not
    // honour "cancel" — real bug; preserved here for the Phase 4
    // refactor, tracked for a dedicated release.
    if (!driverPhone) {
      session.pendingDriverAssignment = { vehicleId: assignTarget.id, plateNumber: assignTarget.plate_number };
      reply = `🚗 *Assign Driver to Vehicle*\n\n• Target Vehicle: *${assignTarget.plate_number}*\n\nPlease reply with the driver's WhatsApp phone number (e.g. *+254712345678*).\n\n_(Reply 'cancel' to abort)_`;
    } else {
      session.pendingDriverAssignment = null;
      const created = await createDriverAssignment({
        supabase: supabaseClient,
        ownerProfile: profileData,
        vehicle: assignTarget,
        driverPhone,
        handoverOdometer: Number(mergedExt.odometer || mergedExt.current_mileage || assignTarget.current_mileage || assignTarget.odometer_reading || 0) || null,
        countryInfo,
        sendWhatsApp: sendWhatsApp
      });

      if (!created.ok) {
        reply = `❌ *Driver Assignment Blocked*\n\n${created.error}`;
      } else {
        session.pendingAssignmentOtp = {
          assignmentId: created.assignment.id,
          vehicleId: created.assignment.vehicle_id,
          driverPhone: created.driverPhone,
          expiresAt: created.expiresAt
        };
        reply = `🔐 *Verify Driver Assignment*\n\nWe emailed a 6-digit code to *${created.ownerEmail}*. Reply with the code to assign *${created.driverPhone}* to *${assignTarget.plate_number}*.\n\n_(Reply *Resend* for a new code or *Cancel* to abort.)_`;
      }
    }
  }
  return { reply };
}
/* ------------------------------------------------------------------ */
/* 11. account-deletion OTP                                             */
/* ------------------------------------------------------------------ */

/**
 * The account-deletion verification turn (moved verbatim from messages.js L3145-3188).
 * The processor keeps the guard and passes its onboarding map in (state in, data out).
 */
export async function handleAccountDeletionOtpTurn({ session, messageText, mergedExt = {}, profileData, supabaseClient, senderPhone, onboardingStore, targetLang, countryInfo }) {
  let reply = null;
  const cleanTrimmed = messageText.trim();
  const providedOtp = mergedExt.otp_code || (cleanTrimmed.match(/^\d{6}$/) ? cleanTrimmed : null);
  if (/^(cancel|exit|stop)$/i.test(cleanTrimmed)) {
    session.pendingAccountDeletion = null;
    reply = await composeMessage({
      purpose: 'flow_cancellation_ack',
      facts: { flow: 'Account deletion', cancelled: true },
      language: targetLang,
      countryInfo,
      profile: profileData,
      fallbackText: 'Account deletion cancelled. Your account remains active.'
    });
  } else if (providedOtp && session.pendingAccountDeletion.code === providedOtp && Date.now() <= session.pendingAccountDeletion.expiresAt) {
    session.pendingAccountDeletion = null;
    if (supabaseClient && profileData) {
      const nowIso = new Date().toISOString();
      await supabaseClient
        .from('vehicles')
        .update({ deleted_at: nowIso, status: 'DELETED', assigned_driver_id: null, updated_at: nowIso })
        .eq('owner_id', profileData.id)
        .is('deleted_at', null);
      await supabaseClient
        .from('profiles')
        .update({ is_active: false, deleted_at: nowIso, updated_at: nowIso })
        .eq('id', profileData.id);
      await supabaseClient.from('chat_history').delete().eq('user_phone', senderPhone);
      await supabaseClient.from('chat_transcripts').delete().eq('phone_number', senderPhone);
      await supabaseClient.from('processed_webhooks').delete().eq('phone_number', senderPhone);
    }
    onboardingStore.delete(senderPhone);
    session.state = 'IDLE';
    session.active_vehicle_id = null;
    session.history = [];
    reply = await composeMessage({
    purpose: 'flow_outcome_card',
    facts: { cardText: `🗑️ *Account Deleted*\n\nYour Saka Fleet account has been soft-deleted, your vehicles released, and active sessions cleared. Historical audit logs are retained for compliance.\n\nYou can register again anytime by typing *Register*.`, instruction: 'Re-render this engine card conversationally: keep EVERY figure, label, emoji anchor and next step exactly as written. Never drop or invent a figure.' },
    language: targetLang,
    countryInfo,
    profile: profileData,
    fallbackText: `🗑️ *Account Deleted*\n\nYour Saka Fleet account has been soft-deleted, your vehicles released, and active sessions cleared. Historical audit logs are retained for compliance.\n\nYou can register again anytime by typing *Register*.`
  });
  } else {
    reply = `❌ *Invalid or Expired Code*\n\nPlease reply with the 6-digit code sent to **${profileData?.email}**, or reply *Cancel* to abort.`;
  }
  return { reply };
}
/* ------------------------------------------------------------------ */
/* 12. email-update OTP + start                                        */
/* ------------------------------------------------------------------ */

/**
 * The pending email-update verification turn (moved verbatim from messages.js L3243-3271).
 */
export async function handleEmailUpdateOtpTurn({ session, messageText, mergedExt = {}, profileData, supabaseClient, targetLang, countryInfo }) {
  let reply = null;
  const cleanTrimmed = messageText.trim();
  const providedOtp = mergedExt.otp_code || (cleanTrimmed.match(/^\d{6}$/) ? cleanTrimmed : null);
  if (providedOtp && session.pendingEmailUpdate.code === providedOtp && Date.now() <= session.pendingEmailUpdate.expiresAt) {
    const newEmail = session.pendingEmailUpdate.newEmail;
    if (supabaseClient && profileData) {
      await supabaseClient.from('profiles').update({
        email: newEmail,
        email_verified: true,
        updated_at: new Date().toISOString()
      }).eq('id', profileData.id);
      await supabaseClient.from('vehicles').update({
        owner_email: newEmail
      }).eq('owner_id', profileData.id);
    }
    session.pendingEmailUpdate = null;
    reply = `✅ *Email Successfully Verified & Updated!* 📧\n\nYour account and vehicle passbooks are now linked to **${newEmail}**.`;
  } else if (/^(cancel|exit|stop)$/i.test(cleanTrimmed)) {
    session.pendingEmailUpdate = null;
    reply = await composeMessage({
      purpose: 'flow_cancellation_ack',
      facts: { flow: 'Email update', cancelled: true },
      language: targetLang,
      countryInfo,
      profile: profileData,
      fallbackText: 'Email update cancelled. You are back in main menu mode.'
    });
  } else {
    reply = `❌ *Invalid or Expired Verification Code*\n\nPlease check your inbox for **${session.pendingEmailUpdate.newEmail}** and reply with the 6-digit code, or reply **'cancel'** to abort.`;
  }
  return { reply };
}

/**
 * The email-update start turn (moved verbatim from messages.js L3274-3294).
 */
export async function handleEmailUpdateStartTurn({ session, messageText, mergedExt = {}, profileData, targetLang, countryInfo }) {
  let reply = null;
  const emailCandidate = mergedExt.owner_email || (messageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) ? messageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)[0] : null);
  if (emailCandidate) {
    const targetEmail = emailCandidate.toLowerCase().trim();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    session.pendingEmailUpdate = {
      newEmail: targetEmail,
      code: otpCode,
      expiresAt: Date.now() + 10 * 60 * 1000
    };
    await sendEmailOtp(targetEmail, otpCode);
    reply = `📧 *Email Verification Required*\n\nWe dispatched a 6-digit verification code to **${targetEmail}**.\n\nPlease reply with the 6-digit code to confirm and finalize updating your registered email.`;
  } else {
    reply = await composeMessage({
      purpose: 'quiz_intro_prompt',
      facts: { flow: 'Update email', example: 'update email to user@example.com' },
      language: targetLang,
      countryInfo,
      profile: profileData,
      fallbackText: `📧 *Update Email Address*\n\nPlease reply with your new email address (e.g. *"update email to user@example.com"*).`
    });
  }
  return { reply };
}

/* ------------------------------------------------------------------ */
/* 13. subscription / trial engine turn (moved verbatim, L4095-4445)   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Subscription / trial turn handling (v1.15.0)                        */
/* ------------------------------------------------------------------ */

/**
 * Engine-owned subscription turn handler. Returns `{ handled, reply, entitlements }`.
 * Every branch is deterministic (zero AI tokens) so billing copy can never drift.
 */
export async function maybeHandleSubscriptionTurn({
  intent,
  messageText = '',
  mergedExt = {},
  session = null,
  profileData = null,
  supabaseClient = null,
  countryInfo = {},
  senderPhone = null,
  entitlements = null,
  existingVehicles = []
} = {}) {
  const ownerId = profileData?.id || null;
  if (!ownerId || !supabaseClient) {
    return { handled: false, reply: null };
  }
  const text = String(messageText || '').trim();
  const lower = text.toLowerCase();
  const currency = countryInfo?.currency || 'USD';
  const owner = { id: ownerId, phone_number: senderPhone, email: profileData?.email };

  const refresh = async () => {
    try {
      return await getEntitlements({ supabase: supabaseClient, ownerId, profile: profileData, useCache: false });
    } catch {
      return entitlements;
    }
  };

  // ---- pending cancellation confirmation (runs before every other branch) ----
  if (session?.pendingCancelSubscription) {
    if (/^(yes|y|confirm|do it|cancel it)$/i.test(lower)) {
      session.pendingCancelSubscription = null;
      const res = await cancelSubscription({ supabase: supabaseClient, ownerId, profile: profileData });
      if (!res.ok) return { handled: true, reply: `⚠️ ${res.error}` };
      const until = res.effectiveAt ? new Date(res.effectiveAt).toLocaleDateString() : 'today';
      const reply = res.trial
        ? `✅ *Trial cancelled* — no payment was taken. Your account is back on the Free plan (1 vehicle, 1 report/month). Data is preserved.`
        : `✅ *Cancellation scheduled*\n\nYou keep full access until *${until}*. After that your account moves to Free (1 vehicle) and extra vehicles are paused — never deleted.\n\nChanged your mind? Reply *"resume subscription"* before then.`;
      return { handled: true, reply, entitlements: await refresh() };
    }
    if (/^(no|n|keep|stop|abort|never mind)$/i.test(lower)) {
      session.pendingCancelSubscription = null;
      return { handled: true, reply: 'No changes — your plan stays active. 👍' };
    }
    // v1.16.2 — accepting the annual save-offer from the same turn.
    if (/\b(annual|yearly|year)\b/i.test(lower)) {
      session.pendingCancelSubscription = null;
      const annual = await checkoutForTier({
        supabase: supabaseClient,
        owner,
        targetTierKey: ent.tierKey,
        interval: 'annual',
        currency
      });
      return {
        handled: true,
        reply: annual.ok
          ? `🚀 *${ent.tierName} — annual*\n\n• Price: ${annual.priceInfo?.formattedPrice || ''} for a full year\n\n👉 *Switch to annual:* ${await shortenUrl(supabaseClient, annual.checkoutUrl)}\n\nYour plan never gets cancelled — billing simply moves to annual.`
          : `⚠️ ${annual.error}`
      };
    }
    return { handled: true, reply: 'Please reply *YES* to cancel or *NO* to keep your plan.' };
  }

  // ---- v1.61.16 — trial-end decision window: keep everything / fit the plan ----
  const wantsFit = /^(?:keep|fit)\s+(?:all|everything)\b/i.test(lower)
    || /\b(?:what|which)\s+(?:plan\s+)?fits\b/i.test(lower)
    || /\bplan\s+that\s+fits\b/i.test(lower);
  if (entitlements?.trialPhase === 'GRACE' && wantsFit) {
    const offer = await buildTrialEndOffer({ supabase: supabaseClient, owner, ownerId, interval: 'monthly', currency });
    const planLine = offer.fitted.addonQuantity > 0
      ? `${offer.fitted.tierLabel} + ${offer.fitted.addonQuantity} extra slot(s)`
      : offer.fitted.tierLabel;
    return {
      handled: true,
      reply: [
        `✅ *${planLine} fits all ${offer.assetCount} ${offer.assetCount === 1 ? 'asset' : 'assets'}*${offer.monthlyLabel ? ` — around ${offer.monthlyLabel}` : ''}`,
        offer.checkoutUrl ? `👉 *Activate:* ${offer.checkoutUrl}` : 'The payment link is temporarily unavailable — reply *upgrade* and I will retry.',
        offer.addonCheckoutUrl ? `👉 *Add the extra slots:* ${offer.addonCheckoutUrl}` : null,
        '',
        `Everything stays active until ${entitlements.graceEndsAt ? new Date(entitlements.graceEndsAt).toLocaleDateString() : 'the window closes'} — nothing is ever deleted.`
      ].filter(Boolean).join('\n')
    };
  }

  const wantsView = intent === 'VIEW_SUBSCRIPTION'
    || /^(?:subscription|my\s+(?:plan|subscription)|billing|plan\s+details)\b/i.test(lower)
    // v1.72.2 (Phase 9, P3-6) — deterministic trial-status aliases (exact
    // phrase; "my trial ended…" and "extend my trial" never match this anchor).
    || /^(?:my\s+)?trial(?:\s+status)?[.!?]*$/i.test(lower)
    || /\b(?:which|what)\s+tier\b|\bshould\s+be\s+on\b|\b(?:less|fewer|more)\s+than\s+\d+\s+(?:assets?|vehicles?)\b|\b(?:put|move|enroll)\s+me\s+(?:on|to|in)\b|\b(?:first|second|third|1st|2nd|3rd)\s+tier\b|\bconfirm\s+(?:which|what)\s+tier\b|\bwhat\s+tier\s+am\s+i\b/i.test(lower);
  const wantsResume = /^resume\s+(?:my\s+)?(?:subscription|plan)\b/i.test(lower);
  const wantsCancel = intent === 'CANCEL_SUBSCRIPTION'
    || /^(?:cancel|stop)\s+(?:my\s+)?(?:subscription|plan|billing)\b/i.test(lower)
    || /^unsubscribe\b/i.test(lower);
  const wantsUpgrade = intent === 'UPGRADE_SUBSCRIPTION' || /\b(?:upgrade|subscribe)\b/i.test(lower);
  const wantsAddon = intent === 'MANAGE_ADDONS' || /\b(?:add[- ]?on|extra\s+(?:car|vehicle|slot))\b/i.test(lower);
  const wantsKeep = intent === 'KEEP_VEHICLE' || /^keep\s+(?:vehicle\s+|car\s+)?\S/i.test(lower);
  const wantsExtend = intent === 'EXTEND_TRIAL' || /\bextend\s+(?:my\s+)?trial\b/i.test(lower);

  const ent = entitlements || await refresh();

  // ---- resume a pending cancellation ----
  if (wantsResume) {
    if (!ent?.cancelAtPeriodEnd && ent?.status !== 'CANCELING') {
      return { handled: true, reply: 'Your plan is not scheduled for cancellation.' };
    }
    const res = await resumeSubscription({ supabase: supabaseClient, ownerId, profile: profileData });
    return {
      handled: true,
      entitlements: await refresh(),
      reply: res.ok
        ? '✅ *Subscription resumed* — auto-renewal is back on and your plan continues unchanged.'
        : `⚠️ Could not resume automatically: ${res.error}. Please contact support.`
    };
  }

  // ---- view plan ----
  if (wantsView && !wantsUpgrade && !wantsCancel && !wantsAddon && !wantsKeep && !wantsExtend) {
    const fresh = await refresh();
    const planReply = await formatSubscriptionSummary({ supabase: supabaseClient, entitlements: fresh, currency });
    // v1.58.21 - tier-math follow-ups ("I have less than 3 assets...") get the
    // count-aware truth instead of the free-tier pitch.
    const assetCount = (existingVehicles || []).filter((v) => v.owner_id === ownerId).length;
    return {
      handled: true,
      entitlements: fresh,
      reply: planReply + `\n\n📊 You have *${assetCount}* asset(s) on file; this ${fresh.isTrial ? 'trial' : 'plan'} covers *${fresh.effectiveVehicleCapacity}*.`
    };
  }

  // ---- cancel (confirmation gate) ----
  if (wantsCancel) {
    if (!ent?.isPaid) {
      return { handled: true, reply: 'You are on the Free plan — there is no paid subscription to cancel. Reply *"upgrade"* to see paid plans.' };
    }
    const until = ent.currentPeriodEnd ? new Date(ent.currentPeriodEnd).toLocaleDateString() : null;

    // v1.16.2 — save-offer before cancelling: annual switch at the engine's own
    // discount for monthly payers (never on a trial).
    const annualPct = getAnnualDiscountPercent(ent.tierKey);
    if (!ent.isTrial && ent.billingInterval !== 'annual' && annualPct > 0) {
      const annual = await checkoutForTier({
        supabase: supabaseClient,
        owner,
        targetTierKey: ent.tierKey,
        interval: 'annual',
        currency
      });
      if (annual.ok) {
        session.pendingCancelSubscription = { requestedAt: Date.now(), trial: false };
        return {
          handled: true,
          reply: `💡 *Before you cancel — keep ${ent.tierName} and save ${annualPct}%*\n\nSwitch to annual: ${annual.priceInfo?.formattedPrice || ''} for a full year.\n\n👉 *Switch to annual:* ${await shortenUrl(supabaseClient, annual.checkoutUrl)}\n\nOr reply *YES* to cancel — ${until ? `you keep access until ${until}` : 'access continues until the paid period ends'}.`
        };
      }
    }

    session.pendingCancelSubscription = { requestedAt: Date.now(), trial: ent.isTrial };
    const detail = ent.isTrial
      ? 'Your trial ends immediately (no payment was taken).'
      : `You keep full access until *${until || 'the end of the paid period'}*.`;
    return {
      handled: true,
      reply: `⚠️ *Cancel ${ent.tierName}?*\n\n${detail}\n\nReply *YES* to confirm or *NO* to keep your plan.`
    };
  }



  // ---- Fleet Command add-ons ----
  if (wantsAddon) {
    if (!ent?.addonEligible) {
      const upgrade = await checkoutForTier({
        supabase: supabaseClient,
        owner,
        targetTierKey: 'fleet_command',
        interval: ent?.billingInterval || 'monthly',
        currency
      });
      return {
        handled: true,
        reply: `🚚 *Fleet Command* is the plan with per-vehicle add-ons: it covers *5 vehicles* and then *$4.99/month per extra car*.\n\n👉 Switch to Fleet Command: ${await shortenUrl(supabaseClient, upgrade.ok ? upgrade.checkoutUrl : 'https://sakafleet.com/pricing')}\n\nAlready on Fleet Command? Reply *"add-on"* to buy extra slots.`
      };
    }
    const qtyMatch = lower.match(/(\d+)\s*(?:car|vehicle|slot)/);
    const quantity = Math.max(1, Number(qtyMatch?.[1] || 1));
    const addon = await checkoutForAddon({
      supabase: supabaseClient,
      owner,
      addonQuantity: quantity,
      interval: ent.billingInterval || 'monthly',
      currency
    });
    if (!addon.ok) return { handled: true, reply: `⚠️ ${addon.error}` };
    return {
      handled: true,
      reply: `➕ *Fleet Command add-on*\n\n+${quantity} garage slot(s) — ${addon.amountUSD} for this cycle.\n\n👉 ${await shortenUrl(supabaseClient, addon.checkoutUrl)}\n\nYour slots activate automatically after payment.`
    };
  }

  // ---- keep vehicles after a downgrade ----
  if (wantsKeep) {
    const rawPlate = String(mergedExt.target_vehicle || mergedExt.plate_number || text.replace(/^keep\s+(?:vehicle\s+|car\s+)?/i, '')).trim().toUpperCase();
    const matched = existingVehicles.find((v) => String(v.plate_number || '').toUpperCase() === rawPlate)
      || existingVehicles[Number(rawPlate) - 1]
      || null;
    if (!matched) {
      const list = existingVehicles.map((v, i) => `${i + 1}. ${v.plate_number}${String(v.status || '').toUpperCase() === 'PAUSED' ? ' (paused)' : ''}`).join('\n');
      return { handled: true, reply: `Which vehicle should stay active?\n\n${list}\n\nReply *keep <plate>*.` };
    }
    const kept = await selectVehiclesToKeep({ supabase: supabaseClient, ownerId, keepVehicleIds: [matched.id] });
    if (!kept.ok) return { handled: true, reply: `⚠️ ${kept.error}` };
    // v1.61.16 — inside the decision window the fit is recomputed on the KEPT
    // (ACTIVE) garage, so the offered plan shrinks with the choice.
    if (entitlements?.trialPhase === 'GRACE') {
      const offer = await buildTrialEndOffer({ supabase: supabaseClient, owner, ownerId, interval: 'monthly', currency, activeOnly: true });
      const planLine = offer.fitted.addonQuantity > 0
        ? `${offer.fitted.tierLabel} + ${offer.fitted.addonQuantity} extra slot(s)`
        : offer.fitted.tierLabel;
      return {
        handled: true,
        entitlements: await refresh(),
        reply: [
          `✅ *${matched.plate_number} is active* — every other asset is paused, never deleted.`,
          '',
          `*${planLine}* fits your kept ${offer.assetCount === 1 ? 'asset' : 'assets'}${offer.monthlyLabel ? ` — around ${offer.monthlyLabel}` : ''}.`,
          offer.checkoutUrl ? `👉 ${offer.checkoutUrl}` : 'Reply *upgrade* for the payment link.',
          '',
          'Changed your mind? Reply *keep all* to keep every asset instead.'
        ].filter(Boolean).join('\n')
      };
    }
    return {
      handled: true,
      entitlements: await refresh(),
      reply: `✅ *${matched.plate_number} is active*\n\nEvery other vehicle is paused — history and passbook tokens are preserved. Reply *"upgrade"* to reactivate them all.`
    };
  }

  // ---- extend the active trial with a coupon ----
  if (wantsExtend) {
    let couponCode = mergedExt.coupon_code || (text.match(/\b[A-Z0-9][A-Z0-9-]{4,}\b/i) || [])[0] || null;
    if (!couponCode) {
      // v1.16.0 — account-first lookup (owner_id), phone as legacy fallback.
      let openCoupon = null;
      try {
        const { data } = await supabaseClient
          .from('coupons')
          .select('code')
          .eq('owner_id', ownerId)
          .eq('applicable_to', 'account_trial_extension')
          .neq('status', 'applied')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        openCoupon = data;
      } catch { openCoupon = null; }
      if (!openCoupon?.code) {
        const { data } = await supabaseClient
          .from('coupons')
          .select('code')
          .eq('assigned_to_phone', senderPhone)
          .eq('applicable_to', 'account_trial_extension')
          .neq('status', 'applied')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        openCoupon = data;
      }
      couponCode = openCoupon?.code || null;
    }
    if (!couponCode) {
      return {
        handled: true,
        reply: '🎟️ I could not find an unused trial-extension coupon on your account. Reply *"subscription"* to review your plan or *"upgrade"* to convert early.'
      };
    }
    const extended = await applyAccountTrialExtensionCoupon({ supabase: supabaseClient, ownerId, code: couponCode });
    if (!extended.ok) return { handled: true, reply: `⚠️ ${extended.error}` };
    return {
      handled: true,
      entitlements: await refresh(),
      reply: `🎁 *Trial extended!*\n\n• Coupon: *${extended.couponCode}*\n• Days added: +${extended.daysAdded}\n• New end date: ${new Date(extended.endsAt).toLocaleDateString()}\n\nEnjoy the full Saka toolkit.`
    };
  }

  // ---- upgrade / start the one-time trial ----
  if (wantsUpgrade) {
    // v1.61.16 — inside the decision window, "upgrade" without a named tier
    // answers with the engine's fitted-plan card (never the generic menu).
    if (entitlements?.trialPhase === 'GRACE' && !parseTierFromMessage([mergedExt.subscription_tier, lower].filter(Boolean).join(' '))) {
      const offer = await buildTrialEndOffer({ supabase: supabaseClient, owner, ownerId, interval: 'monthly', currency });
      const planLine = offer.fitted.addonQuantity > 0
        ? `${offer.fitted.tierLabel} + ${offer.fitted.addonQuantity} extra slot(s)`
        : offer.fitted.tierLabel;
      return {
        handled: true,
        reply: [
          `✅ *${planLine} fits all ${offer.assetCount} ${offer.assetCount === 1 ? 'asset' : 'assets'}*${offer.monthlyLabel ? ` — around ${offer.monthlyLabel}` : ''}`,
          offer.checkoutUrl ? `👉 *Activate:* ${offer.checkoutUrl}` : 'Reply again in a moment for a fresh link.',
          offer.addonCheckoutUrl ? `👉 *Extra slots:* ${offer.addonCheckoutUrl}` : null,
          '',
          'Want a smaller plan instead? Reply *keep <plate>* and I\'ll pause the rest — never delete.'
        ].filter(Boolean).join('\n')
      };
    }
    const tierFromText = parseTierFromMessage(
      [mergedExt.subscription_tier, lower].filter(Boolean).join(' ')
    );
    if (!tierFromText) {
      return { handled: true, reply: await formatTierChoices({ supabase: supabaseClient, currency }) };
    }
    const interval = parseIntervalFromMessage(mergedExt.billing_interval || lower);

    const trialEligible = !ent?.profile?.trial_used_at && !ent?.isPaid;
    if (trialEligible) {
      const trial = await startAccountTrial({ supabase: supabaseClient, ownerId, tierKey: tierFromText, interval });
      if (trial.started) {
        return {
          handled: true,
          entitlements: await refresh(),
          reply: `🎁 *Your ${trial.days}-day ${getTierLabel(tierFromText)} trial is live!*\n\n• No card needed — nothing is charged today\n• Full access: Tiers 0-3 AI, unlimited reports, compliance tracking\n• Ends: ${new Date(trial.endsAt).toLocaleDateString()}\n\nI'll check in with your value summary before it ends. Reply *"subscription"* anytime to see the plan.`
        };
      }
    }

    const checkout = await checkoutForTier({
      supabase: supabaseClient,
      owner,
      targetTierKey: tierFromText,
      interval,
      currency,
      couponCode: mergedExt.coupon_code || null
    });
    if (!checkout.ok) return { handled: true, reply: `⚠️ ${checkout.error}` };
    const couponLine = checkout.coupon?.code ? `\n🎟️ Coupon *${checkout.coupon.code}* applied` : '';
    return {
      handled: true,
      reply: `🚀 *${getTierLabel(tierFromText)} — ${interval}*\n\n• Price: ${checkout.priceInfo?.formattedPrice || ''}${couponLine}\n\n👉 *Activate now:* ${await shortenUrl(supabaseClient, checkout.checkoutUrl)}\n\n${checkout.recurring ? 'Billing renews automatically — cancel anytime.' : 'One-time payment; renewal reminders keep you posted.'}`
    };
  }

  return { handled: false, reply: null };
}
