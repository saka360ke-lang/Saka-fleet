/**
 * Saka Fleet - WhatsApp message processor (Phase 5B-1 of the whatsapp.js split, v1.66.0).
 * --------------------------------------------------------------------------------------
 * Everything the webhook hands off: session hydration, OCR / Document Lens, the quiz
 * engine, deterministic reads, billing turns, compliance capture and the reply send.
 * src/routes/whatsapp/webhook.js imports processIncomingWhatsAppMessage from here;
 * this module never imports the webhook, so the dependency graph stays acyclic.
 * Since v1.66.0 the pure helpers live in ./helpers.js and the outbound Meta sender
 * lives in ./replies.js; this module imports both (one-way, no cycles).
 */

import crypto from 'crypto';
import { handleSuperadminFlow, isSuperadminPhone } from '../../services/superadmin.js';
import { processSakaMessage, extractVehicleAttributes, classifyIntentWithRegex } from '../../../sakaAi.js';
import { logChatTranscript, logSystemError } from '../../workers/sentinel.js';
import { verifyPaystackSignature, formatUsdInLocalCurrency } from '../../services/paystack.js';
import {
  ensureVehicleTableColumns,
  unassignDriverFromVehicle,
  checkOwnerVehicleTierLimit,
  getActiveVehicle,
  setActiveVehicle,
  findVehicleByCandidate,
  updateVehicleDetails,
  deleteVehicle,
  sanitizeVehicleUpdates
} from '../../services/vehicles.js';
import { calculateFuelConsumption } from '../../services/analytics.js';
import { normalizeFillType } from '../../services/fuelEconomy.js';
import { resolveExpenseType, normalizeExpenseType, hasExpenseTypeMarker } from '../../services/expenseCatalog.js';
import { resolveEarningType, normalizeEarningType, hasEarningTypeMarker } from '../../services/earningCatalog.js';
import { shortenUrl } from '../../services/linkShortener.js';
import { sakaIntroText, isFirstContact, isIntroCopy, wantsIntroduction, asksForPlateDirectly, shouldReplaceIntroCopy, isRepeatedReply, isStopRequest, PAUSE_REPLY, pickRepeatNudge, pickNewcomerNudge, isFirstTimeMessage, shouldReplacePlateAsk, isIncompleteReplyComplaint, replyContinuationRequestFor, asksToUploadLogbook, isLegacyWelcomeCopy, websiteSignupNextStep, isConfusedUnverifiedTurn } from '../../services/greetings.js';
import { matchProductQa, buildProductFactsContext, buildLocalPricingFacts, stripUsdFigures, sanitizeSakaReply } from '../../services/productQa.js';
import { shouldSuggestContactSave, isLostChatMessage, buildContactSaveFacts, markContactSaveSuggested } from '../../services/contactNudge.js';
import { buildUserContextSnapshot, buildUserFactsLines } from '../../services/userContextSnapshot.js';
import { buildConversationMemory } from '../../services/conversationMemory.js';
import { resolveSlowAckMs, pickSlowAckLine, shouldSendSlowAck } from '../../services/turnAck.js';
import {
  buildFeatureNotice,
  shouldShowFeatureNotice,
  markFeatureNoticeSeen,
  ensureFeatureNoticeSchema
} from '../../services/featureNotice.js';
import { buildFleetReport, resolveReportType } from '../../services/fleetReports.js';
import { resolveAnyReportType, buildReportForLane } from '../../services/reportDelivery.js';
import { resolveMetricIds, customMetricMenu } from '../../services/reportMetrics.js';
import { resolveReportAccess } from '../../services/reportAccess.js';
import {
  createDriverAssignment,
  verifyOwnerAssignmentOtp,
  cancelPendingAssignment,
  handleDriverResponse,
  canManageVehicle,
  getDriverComplianceStatus,
  getActiveAssignment,
  submitDriverCompliance,
  notifyOwnerComplianceCleared
} from '../../services/driverAssignments.js';
import { resolveBundledCatalog } from '../../services/complianceCatalog.js';
import {
  DRIVER_DOC_RE,
  VEHICLE_DOC_RE,
  catalogCandidates,
  findMentionedComplianceItem,
  pickComplianceContextVehicle,
  detectComplianceAddRequest,
  extractComplianceDetails,
  mergeComplianceCapture,
  complianceCapturePrompt,
  formatComplianceSaved,
  isComplianceCaptureCancel,
  complianceCaptureCancelText,
  looksLikeFreshLogLine,
  isComplianceCaptureExpired,
  isPhotoIntent,
  isUnreadableMediaNote,
  detectDocumentTypeCorrection,
  extractFromPastedDocument
} from '../../services/complianceCapture.js';
// v1.59.0 — optional per-record labels on the quick-log lanes.
import { sanitizeEntryLabel, extractEntryLabel } from '../../services/entryLabels.js';
// v1.63.1 — quick-log lanes land through the shared after-write hook.
import { markUserDataChanged } from '../../services/afterWrite.js';
import { parseVehicleComplianceParagraph, submitVehicleCompliance, resolveVehicleComplianceCatalog } from '../../services/vehicleCompliance.js';
import { handleStage1CoreCapture, handleStage2OptionalWeaving } from '../../services/onboarding.js';
import { saveChatMessage, getRecentChatHistory, getReengagementContext, CHAT_HISTORY_MAX_MESSAGES } from '../../services/chatHistory.js';
import { getUserContextCache, formatUserFactsBlock } from '../../services/userContextCache.js';
import { sendEmailOtp, sendSupportEscalationEmail, sendMfaEmail, sendCareReplyEmail } from '../../services/mailer.js';
import { handleCareRequest, escalateCareToSuperadmin } from '../../services/customerCare.js';
import { handleCareCommand } from '../../services/careConsole.js';
import {
  initiatePassbookTransfer,
  setBuyerDetailsAndSendReleaseOtp,
  verifyOwnerReleaseOtpAndNotifyBuyer,
  handleBuyerAcceptance,
  completePassbookTransfer
} from '../../services/transfers.js';
import { applyTrialExtensionCoupon } from '../../services/coupons.js';
import {
  getEntitlements,
  evaluateVehicleCapacity,
  getReportQuota,
  recordReportUsage,
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
  startWelcomeTrial,
  applyAccountTrialExtensionCoupon,
  buildTrialEndOffer,
  recordActivationEvent,
  ACTIVATION_EVENTS
} from '../../services/trialEngine.js';
import { normalizeTierKey, getTierLabel, getAnnualDiscountPercent } from '../../services/subscriptionTiers.js';
import { resolveUserTimezone, resolveTimezoneFromCountry } from '../../services/globalization.js';
import { getCountryCommStyleLine } from '../../services/countryCommStyles.js';
import { ensureCountryBucket, getCountryLearningsLine } from '../../services/countryLearnings.js';
import { applyOdometerReading, applyOperatingHours } from '../../services/maintenanceReminders.js';
import { handleQuizTurn, detectQuizStart, shouldPauseQuizForChat, getCurrentQuizField, detectFlowSwitch, getFlowDefinition, looksLikeReportRequest, getActiveQuiz, markQuizTurn, abandonQuiz } from '../../services/quizEngine.js';
import { matchNarrativeVehicle, buildNarrativeDraft, narrativeDraftFields, narrativeDraftExtras, shouldPrefillNarrativeDraft, isNarrativeIntakeEnabled, isNarrativeEligibleText, buildNarrativeParagraphDrafts, renderNarrativeBatchCard, resolveNarrativeBatchTurn, describeNarrativeDraft } from '../../services/narrativeDraft.js';
import { recordFriction } from '../../services/frictionTracker.js';
import { renderActionDiscovery, composeMessage } from '../../services/conversationEngine.js';
import { enqueueFollowUp, FOLLOWUP_KINDS, followUpAckText } from '../../services/followups.js';
import { loadSessionSnapshot, persistSessionSnapshot } from '../../services/sessionStore.js';
import { hydrateSessionPending } from '../../services/pendingState.js';
import { ocrWhatsAppMedia, extractDocumentHints, isOcrEnabled, isOcrAckFirstEnabled, buildMediaAckText, classifyOcrDocument } from '../../services/ocrService.js';
import { parseDocumentFields, uploadHintFor } from '../../services/documentLens.js';
import { semanticOcrTopUp } from '../../services/ocrSemantic.js';
import {
  normalizeAssetKind,
  getCountryBucket,
  buildJurisdictionContext,
  resolveCountryInput
} from '../../services/countryBucket.js';
import {
  findReceiptByMediaId,
  findRecentReceiptByTextSha,
  recordReceipt,
  uploadReceiptImage,
  listReceipts,
  deleteReceipt,
  formatDuplicateReceiptReply,
  OCR_CONFIRM_THRESHOLD,
  OCR_LOW_CONFIDENCE_NOTE,
  OCR_UNREADABLE_NOTE
} from '../../services/receipts.js';
import { recordOcrRequest, buildOcrTextSha } from '../../services/ocrTelemetry.js';
import { isDuplicateExpense } from '../../services/expenseGuard.js';
import { logTurnLatency } from '../../services/turnLatency.js';
import { resolveReadCommand, inspectRecordQuestion, isVehicleSummaryCommand } from '../../services/readCommands.js';
// v1.66.0 — Phase 5B-1 module split: pure helpers + the outbound Meta sender.
import {
  detectCountryFromPhone,
  detectMessageLanguage,
  languageSwitchConfirmation,
  checkIsConversationalFeedback,
  extractNumberFromText,
  extractOdometerFromText,
  buildRoleContext,
  generateRoleBasedActionDiscovery,
  parseTierFromMessage,
  parseIntervalFromMessage
} from './helpers.js';
import { sendWhatsAppReply } from './replies.js';

export const onboardingStore = new Map();
export const chatSessions = new Map();

export async function renderRoleActions({ profileData, vehicles, senderPhone, language, countryInfo }) {
  const { roles, commands } = buildRoleContext(profileData, vehicles, senderPhone);
  return renderActionDiscovery({
    roles,
    commands,
    vehicles,
    language,
    countryInfo,
    profile: profileData,
    exhaustive: roles.includes('Superadmin')
  });
}

export async function processIncomingWhatsAppMessage({ messageObj, fastify, supabaseClient }) {
  const sessionPhone = messageObj?.from || '';
  const formattedPhoneForSession = sessionPhone.startsWith('+') ? sessionPhone : `+${sessionPhone.replace(/[^\d]/g, '')}`;
  const persistSnap = async () => {
    if (!supabaseClient || !sessionPhone) return;
    try {
      await persistSessionSnapshot(supabaseClient, formattedPhoneForSession, {
        session: chatSessions.get(sessionPhone) || null,
        onboarding: onboardingStore.get(sessionPhone) || null
      });
    } catch {}
  };
  // Overlaps the two user-log writes with AI processing; awaited before the
  // assistant log so transcript ordering stays correct.
  let userLogPromise = Promise.resolve();

  // v1.24.1 - user-perceived reply latency (webhook receipt to final reply).
  const turnStartedAt = Date.now();
  // v1.24.2 - slow-turn ack state (function scope so the final send can clear it).
  let slowAckTimer = null;
  let turnFinalized = false;
  // v1.58.x — set once the final reply is dispatched, so the crash fallback
  // only fires when the user genuinely received nothing.
  let replyDispatched = false;
  // v1.32.1 — `session` is hoisted to function scope so the catch block can
  // never reference an undeclared binding (live crash 2026-11-01: the masking
  // ReferenceError "session is not defined" silently killed two photo uploads).
  let session = null;
  // v1.24.3 - phase markers so a slow turn names its own bottleneck.
  const phaseMarks = { profileReadyAt: null, aiStartedAt: null, aiDoneAt: null };

  try {
    const senderPhone = messageObj.from;

    // --- MEDIA / OCR INGESTION (parallel with durable session hydration) ------
    // WhatsApp photos and documents carry no `.text`. Download them from Meta,
    // OCR with Google Cloud Vision, and treat the extracted text as the turn.
    const imageObj = messageObj.image || null;
    const documentObj = messageObj.document || null;
    const audioObj = messageObj.audio || null;
    const mediaObj = imageObj || documentObj;
    const mediaCaption = (imageObj?.caption || documentObj?.caption || '').trim();
    const mediaMimeType = imageObj?.mime_type || documentObj?.mime_type || null;

    // v1.61.15 — voice notes carry no text and no OCR path. Answer them
    // deterministically (zero tokens, zero menu wall) instead of letting an
    // empty turn fall through to the generic help menu. The transcript keeps a
    // durable marker so eval/digest can see these turns.
    if (audioObj && !messageObj.text?.body) {
      const voiceReply = '🎙️ I can\'t listen to voice notes yet — type it in and I\'ll take it from there.';
      try {
        await logChatTranscript(supabaseClient, senderPhone, 'user', '[voice note]');
        await saveChatMessage(supabaseClient, senderPhone, 'user', '[voice note]');
        await sendWhatsAppReply(senderPhone, voiceReply);
        await logChatTranscript(supabaseClient, senderPhone, 'assistant', voiceReply);
        await saveChatMessage(supabaseClient, senderPhone, 'assistant', voiceReply);
      } catch (err) {
        console.warn('[VoiceNote] fallback reply failed:', err?.message || 'unknown');
      }
      return { status: 'voice_note_fallback' };
    }

    // v1.51.6 — an unverified number never gets the OCR ack or runs Vision:
    // short-circuit to the website line BEFORE any media download/OCR.
    if (mediaObj?.id && supabaseClient && !isSuperadminPhone(senderPhone)) {
      const { data: earlyProfile } = await supabaseClient
        .from('profiles')
        .select('email_verified')
        .eq('phone_number', formattedPhoneForSession)
        .maybeSingle();
      if (!earlyProfile || earlyProfile.email_verified !== true) {
        const verifyReply = '🔒 Please sign up first at https://sakafleet.com — tap *Get Started Free* and verify your email, then I\'ll meet you right back here on WhatsApp.';
        try {
          await logChatTranscript(supabaseClient, senderPhone, 'user', mediaCaption || '[document]');
          await saveChatMessage(supabaseClient, senderPhone, 'user', mediaCaption || '[document]');
          await sendWhatsAppReply(senderPhone, verifyReply);
          await logChatTranscript(supabaseClient, senderPhone, 'assistant', verifyReply);
          await saveChatMessage(supabaseClient, senderPhone, 'assistant', verifyReply);
        } catch { /* best-effort */ }
        return { status: 'unverified_gated_media' };
      }
    }

    // v1.22.0 — Snappy Saka: when Vision is enabled, acknowledge the media
    // immediately (deterministic, no AI) so the user never waits in silence
    // while the document is downloaded and read. The parsed result arrives as
    // the follow-up message.
    const ocrPaused = Boolean(mediaObj?.id)
      && !/pdf/i.test(String(mediaMimeType || ''))
      && !isOcrEnabled();
    if (mediaObj?.id && !ocrPaused && isOcrAckFirstEnabled()) {
      try {
        const ack = buildMediaAckText({ mimeType: mediaMimeType });
        await sendWhatsAppReply(senderPhone, ack);
        if (supabaseClient) {
          await logChatTranscript(supabaseClient, senderPhone, 'assistant', ack);
          await saveChatMessage(supabaseClient, senderPhone, 'assistant', ack);
        }
      } catch { /* the ack is best-effort; the turn still proceeds */ }
    }

    // OCR and session hydration are independent and side-effect free: run them
    // together so media turns do not pay two serial round trips.
    const ocrPromise = mediaObj?.id
      ? ocrWhatsAppMedia({
          mediaId: mediaObj.id,
          mimeType: mediaMimeType,
          token: process.env.META_WHATSAPP_TOKEN
        }).catch((err) => ({ text: '', error: err?.message || 'ocr_failed' }))
      : Promise.resolve({ text: '', error: null });
    const ocrStartedAt = Date.now();

    // Durable session hydration — restores quiz/onboarding/OTP state from
    // Supabase so any Cloud Run instance can continue the conversation.
    const hydrationPromise = supabaseClient
      ? loadSessionSnapshot(supabaseClient, formattedPhoneForSession).catch(() => null)
      : Promise.resolve(null);

    const [ocrResult, snapshot] = await Promise.all([ocrPromise, hydrationPromise]);
    const ocrText = (ocrResult?.text || '').trim();
    const ocrError = ocrResult?.error || null;
    if (ocrError) console.warn('[OCR] Media could not be read:', ocrError);

    const baseText = messageObj.text?.body || mediaCaption || '';
    let messageText = baseText;
    if (ocrText) {
      messageText = `${baseText ? `${baseText}\n\n` : ''}${ocrText}`.slice(0, 4000);
    } else if (mediaObj && !baseText) {
      messageText = '[Saka system note: the user sent an image/document that could not be read by OCR. Apologize ONCE with 📸 and 🙏, never claim anything was saved, and offer a clearer photo or typed details (e.g. "Logged 40L at 50350 km for KES 5500 — full tank"). If it was a PDF scan without a text layer, ask them to send the pages as photos.]';
    }

    const ocrCountry = detectCountryFromPhone(formattedPhoneForSession);

    // Safe, deterministic family classification (guarded; never throws) — used
    // for the telemetry row so a crash in the richer Document Lens below can
    // never make a media turn invisible.
    let safeKind = 'unknown';
    try { safeKind = ocrText ? classifyOcrDocument(ocrText) : 'unknown'; } catch { /* guarded */ }

    const ocrLowConfidence = Boolean(
      ocrText
      && Number.isFinite(Number(ocrResult?.confidence))
      && Number(ocrResult.confidence) > 0
      && Number(ocrResult.confidence) < OCR_CONFIRM_THRESHOLD
    );

    // v1.32.1 — OCR request telemetry (Rule 36): one durable row per media turn,
    // written BEFORE the crash-prone Document Lens parsing. A dead turn is now
    // diagnosable and countable; country_code always comes from the WhatsApp
    // number (E.164).
    const ocrTextSha = buildOcrTextSha(ocrText);
    if (mediaObj?.id) {
      const ocrStatus = ocrPaused
        ? 'paused'
        : (ocrResult?.kind === 'pdf'
          ? (ocrText ? 'pdf_text' : 'pdf_scanned')
          : (ocrText ? (ocrLowConfidence ? 'low_confidence' : 'read') : 'failed'));
      void recordOcrRequest(supabaseClient, {
        mediaId: mediaObj.id,
        phone: senderPhone,
        countryCode: ocrCountry?.country_code || null,
        mimeType: mediaMimeType,
        provider: ocrResult?.kind === 'pdf' ? 'local_pdf' : 'google_vision',
        documentKind: safeKind || null,
        status: ocrStatus,
        confidence: ocrResult?.confidence ?? null,
        attempts: ocrResult?.attempts ?? null,
        latencyMs: Math.max(0, Date.now() - ocrStartedAt),
        error: ocrError || null
      }).catch(() => {});
    }

    // v1.51.7 — Document Lens parsing is best-effort: a crash here must never
    // kill the turn (live 2026-11-02 logbook crash: "toUpperCase of undefined").
    // Degrade to the raw OCR text and let the normal turn continue.
    let lens = null;
    let ocrKind = safeKind;
    let receiptHints = {};
    try {
      lens = ocrText
        ? parseDocumentFields(ocrText, { countryCode: ocrCountry?.country_code || 'GLOBAL' })
        : null;
      ocrKind = lens?.family || safeKind;
      // Deterministic Vision hints + the richer Document Lens field map (v1.20.0).
      // v1.32.1 — the country-aware extractor wins on the keys it knows (amount,
      // vendor, policy, expiry), so a lens misread can never override a labelled
      // value (e.g. EXPIRING vs COMMENCING on an insurance certificate).
      receiptHints = ocrText
        ? {
          ...(lens?.hints || {}),
          ...extractDocumentHints(ocrText, ocrKind, { countryCode: ocrCountry?.country_code || 'GLOBAL' })
        }
        : {};
    } catch (lensErr) {
      console.warn('[OCR] Document Lens failed (degrading to raw OCR text):', lensErr?.message || lensErr);
    }

    // v1.54.1 — zero-shot extraction top-up (OCR_AI_EXTRACTION, default off).
    // The deterministic lens is ALWAYS the authority: the AI may only fill
    // fields the lens genuinely missed, every value is re-validated through
    // the country-resolved normalizers, and everything still lands in the
    // confirm-before-save gate. Any failure keeps today's behavior.
    if (lens && ocrText) {
      try {
        const semanticHints = await semanticOcrTopUp({
          text: ocrText,
          family: lens.family,
          countryCode: ocrCountry?.country_code || 'GLOBAL',
          locale: ocrCountry?.locale || null,
          existing: receiptHints
        });
        if (semanticHints && Object.keys(semanticHints).length) {
          receiptHints = { ...semanticHints, ...receiptHints };
          for (const [key, value] of Object.entries(semanticHints)) {
            lens.fields[key] = { value, confidence: 0.7, source: 'ai_topup' };
          }
          lens.found = Object.keys(lens.fields);
          lens.missing = (lens.missing || []).filter((key) => !(key in lens.fields));
        }
      } catch (semanticErr) {
        console.warn('[OCR] semantic top-up failed (deterministic hints stand):', semanticErr?.message || semanticErr);
      }
    }

    if (snapshot) {
      if (snapshot.session && !chatSessions.has(senderPhone)) chatSessions.set(senderPhone, snapshot.session);
      if (snapshot.onboarding && !onboardingStore.has(senderPhone)) onboardingStore.set(senderPhone, snapshot.onboarding);
    }

    if (fastify?.log) fastify.log.info(`Incoming WhatsApp message from ${senderPhone}: "${messageText}"`);
    if (supabaseClient) {
      userLogPromise = Promise.all([
        logChatTranscript(supabaseClient, senderPhone, 'user', messageText),
        saveChatMessage(supabaseClient, senderPhone, 'user', messageText)
      ]).catch(() => {});
    }

    // v1.58.18 - Care console (worker role). CUSTOMER_CARE_PHONE is OFF by
    // default; the superadmin can always run `care ...` too. Anything that is
    // not a care command falls through untouched.
    if (supabaseClient) {
      const careRes = await handleCareCommand(supabaseClient, {
        phone: senderPhone,
        text: messageText,
        sendWhatsApp: sendWhatsAppReply,
        sendEmail: sendCareReplyEmail,
        notifySuperadmin: (payload) => escalateCareToSuperadmin(payload),
        isSuperadminActor: isSuperadminPhone(senderPhone)
      });
      if (careRes && careRes.reply) {
        await sendWhatsAppReply(senderPhone, careRes.reply);
        await logChatTranscript(supabaseClient, senderPhone, 'assistant', careRes.reply);
        await saveChatMessage(supabaseClient, senderPhone, 'assistant', careRes.reply);
        await userLogPromise;
        await persistSnap();
        return { status: 'care_handled' };
      }
    }

    // Superadmin Intercept Middleware
    if (supabaseClient) {
      const superadminRes = await handleSuperadminFlow(supabaseClient, senderPhone, messageText);
      if (superadminRes.isSuperadmin) {
        if (superadminRes.reply) {
          await sendWhatsAppReply(senderPhone, superadminRes.reply);
          await logChatTranscript(supabaseClient, senderPhone, 'assistant', superadminRes.reply);
          await saveChatMessage(supabaseClient, senderPhone, 'assistant', superadminRes.reply);
        }
        await userLogPromise;
        await persistSnap();
        return { status: 'superadmin_handled' };
      }
      // v1.50.0 — superadmin is superadmin-only: a non-admin message from the
      // superadmin phone is answered with the admin hub instead of falling
      // through to owner/driver flows.
      if (isSuperadminPhone(senderPhone)) {
        const hub = generateRoleBasedActionDiscovery({ profileData: null, vehicles: [], senderPhone });
        await sendWhatsAppReply(senderPhone, hub);
        await logChatTranscript(supabaseClient, senderPhone, 'assistant', hub);
        await saveChatMessage(supabaseClient, senderPhone, 'assistant', hub);
        await userLogPromise;
        await persistSnap();
        return { status: 'superadmin_handled' };
      }
    }

    // v1.64.0 — ONE pending state object (Phase 4). The migration-on-read shim
    // folds every legacy pending* field of a restored snapshot into
    // `session.pending` and re-exposes the legacy names as accessors, so the
    // branch code below is byte-identical while the physical state is unified.
    session = hydrateSessionPending(chatSessions.get(senderPhone) || { history: [], lastActive: Date.now() });
    session.lastActive = Date.now();
    session.slowAckSent = false;

    const cleanCmd = messageText.trim().toLowerCase();

    // v1.25.2 — explicit stop/pause: acknowledge once, stay quiet, and resume on
    // the user's next message. Deterministic (no AI, no marketing follow-up).
    // v1.57.1 - user can wipe the conversation and start fresh; fleet data is untouched.
    if (/^(?:clear|reset)\s+(?:the\s+)?(?:chat|conversation|history)$|^start\s+over$|^clear\s+chat$/i.test(cleanCmd) && !session.pendingClearChat) {
      session.pendingClearChat = true;
      const confirmClear = "This only clears our chat history - your vehicles, expenses and reminders stay safe. Reply *CLEAR* to confirm, or *cancel* to keep chatting.";
      session.history = session.history || [];
      session.history.push({ role: "user", parts: [{ text: messageText }] });
      session.history.push({ role: "model", parts: [{ text: confirmClear }] });
      if (session.history.length > CHAT_HISTORY_MAX_MESSAGES) session.history = session.history.slice(-CHAT_HISTORY_MAX_MESSAGES);
      chatSessions.set(senderPhone, session);
      try { await sendWhatsAppReply(senderPhone, confirmClear); } catch { }
      if (supabaseClient) { try { await saveChatMessage(supabaseClient, senderPhone, "assistant", confirmClear); } catch { } }
      return { status: "clear_chat_confirm" };
    }
    if (session.pendingClearChat) {
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
        chatSessions.set(senderPhone, session);
        const cleared = "Fresh start! Our chat is cleared - your vehicles, expenses and reminders are safe. What would you like to do?";
        try { await sendWhatsAppReply(senderPhone, cleared); } catch { }
        if (supabaseClient) { try { await saveChatMessage(supabaseClient, senderPhone, "assistant", cleared); } catch { } }
        return { status: "chat_cleared" };
      } else if (/^(cancel|no|stop)$/i.test(cleanCmd)) {
        session.pendingClearChat = false;
        chatSessions.set(senderPhone, session);
        const keepChat = "Okay, I have not cleared anything.";
        try { await sendWhatsAppReply(senderPhone, keepChat); } catch { }
        return { status: "clear_chat_cancelled" };
      } else {
        session.pendingClearChat = false;
      }
    }

    // v1.58.22 - a pending support intake OWNS the next turn: an open draft must
    // never swallow the user's issue description (live 2026-11-04: "KAS 628T"
    // was answered by the expense quiz while support intake was waiting).
    if (session.pendingSupportEscalation) {
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
      chatSessions.set(senderPhone, session);
      try { await sendWhatsAppReply(senderPhone, supportReply); } catch { }
      if (supabaseClient) { try { await saveChatMessage(supabaseClient, senderPhone, 'assistant', supportReply); } catch { } }
      return { status: 'support_intake_handled' };
    }

    if (isStopRequest(cleanCmd)) {
      session.paused = true;
      session.history = session.history || [];
      const pauseReply = await composeMessage({
        purpose: 'pause_confirmation',
        facts: { paused: true, resumeHint: 'Message me anytime and I will pick up where we left off.' },
        countryInfo: detectCountryFromPhone(formattedPhoneForSession),
        fallbackText: PAUSE_REPLY
      });
      session.history.push({ role: 'user', parts: [{ text: messageText }] });
      session.history.push({ role: 'model', parts: [{ text: pauseReply }] });
      if (session.history.length > CHAT_HISTORY_MAX_MESSAGES) session.history = session.history.slice(-CHAT_HISTORY_MAX_MESSAGES);
      chatSessions.set(senderPhone, session);
      try { await sendWhatsAppReply(senderPhone, pauseReply); } catch { /* best-effort */ }
      if (supabaseClient) {
        try {
          await logChatTranscript(supabaseClient, senderPhone, 'assistant', pauseReply);
          await saveChatMessage(supabaseClient, senderPhone, 'assistant', pauseReply);
        } catch { /* best-effort */ }
      }
      await userLogPromise;
      await persistSnap();
      return { status: 'paused' };
    }
    // A paused user simply writing again resumes the conversation.
    if (session.paused) session.paused = false;

    // Circuit Breaker State Check & Reset on user navigation commands
    if (/^(cancel|exit|stop|reset|restart|start over|start again|1|2|3|4|5)$/i.test(cleanCmd) || /^(log|update|set|request|help)/i.test(cleanCmd)) {
      session.circuitBreakerStage = null;
      session.consecutivePromptCount = 0;
      session.lastAssistantPrompt = null;
      session.loopSignature = null;
      // v1.24.4 — after an explicit restart/menu request the welcome (and its
      // REGISTER call to action) is the correct response, not a repeat guard.
      session.sakaIntroduced = false;
      session.nudgeCount = 0;
      session.lastAssistantPrompt = null;
    } else if (session.circuitBreakerStage === 'HARD_TRIP') {
      // Circuit breaker is in hard trip: bypass DeepSeek and send a short,
      // AI-rendered recovery message (deterministic fallback if AI is down).
      const fallbackReply = "⚠️ I've paused automated replies for this step. Type Restart to begin again, or contact support@reports.sakafleet.com — we will update you here once resolved.";
      const recoveryReply = await composeMessage({
        purpose: 'circuit_breaker_recovery',
        facts: {
          reason: 'Repeated identical assistant prompt detected',
          nextSteps: ['Type Restart to begin again', 'Type Cancel to exit', 'Email support@reports.sakafleet.com'],
          supportEmail: 'support@reports.sakafleet.com'
        },
        fallbackText: fallbackReply
      });
      await sendWhatsAppReply(senderPhone, recoveryReply);
      if (supabaseClient) {
        try {
          await supabaseClient.from('chat_transcripts').insert([{ phone_number: senderPhone, sender: 'assistant', message_text: recoveryReply }]);
          await supabaseClient.from('chat_history').insert([{ user_phone: senderPhone, role: 'assistant', message: recoveryReply }]);
        } catch {}
      }
      await userLogPromise;
      await persistSnap();
      return { status: 'circuit_breaker_active' };
    }

        const formattedPhone = formattedPhoneForSession;
        const countryInfo = detectCountryFromPhone(formattedPhone);

        let profileData = null;
        if (supabaseClient) {
          const { data: pData } = await supabaseClient
            .from('profiles')
            .select('*')
            .eq('phone_number', formattedPhone)
            .maybeSingle();

          if (!pData) {
            const { data: newProfile } = await supabaseClient
              .from('profiles')
              .insert([{
                id: crypto.randomUUID(),
                phone_number: formattedPhone,
                full_name: null,
                country: countryInfo.country,
                country_code: countryInfo.country_code,
                unit_system: countryInfo.default_units,
                preferred_language: 'English',
                // v1.39.3 — explicit Free: the live schema's legacy default
                // tier ('SOLO') resolves to solo_pro entitlements on a null
                // status. New accounts are Free until a trial or payment.
                subscription_tier: 'free',
                subscription_status: 'ACTIVE',
                // v1.58.13 — never inherit the legacy now()+90d trial_ends_at default.
                trial_ends_at: null,
                is_active: true
              }])
              .select()
              .maybeSingle();
            profileData = newProfile;
          } else {
            profileData = pData;
          }
        }

        // v1.51.5 — HARD gate: an unverified number gets ONLY a short website-signup
        // line. No chatting, no intros, no product answers, no registration, until
        // the profile is email_verified (web signup).
        if (supabaseClient && profileData?.country_code) {
          ensureCountryBucket(supabaseClient, { countryCode: profileData.country_code }).catch(() => {});
        }
        if (supabaseClient && profileData && profileData.email_verified !== true) {
          // v1.58.13 — PROP-2026-11-04-01: a confused/repeat turn ("Huh?",
          // "What?", "Still confused") from an unverified number gets a short
          // clarification + a human-help path instead of the identical gate line
          // re-firing on loop.
          const confusedGateTurn = isConfusedUnverifiedTurn(messageText);
          const verifyReply = await composeMessage({
            purpose: confusedGateTurn ? 'website_signup_gate_clarify' : 'website_signup_gate',
            facts: {
              websiteUrl: 'https://sakafleet.com',
              offerHumanHelp: confusedGateTurn,
              reason: confusedGateTurn
                ? 'Acknowledge in one short line that the previous message was the website signup step, apologise briefly for the repetition, then restate it plainly (sign up at the website and verify the email) and offer HELP to reach a human.'
                : 'Saka chats with you once your email is verified from the website signup.'
            },
            language: profileData?.preferred_language || 'English',
            countryInfo,
            profile: profileData,
            fallbackText: confusedGateTurn
              ? 'Sorry for repeating myself 🙂 — I can only chat after a quick website signup. Tap https://sakafleet.com and choose *Get Started Free*, verify your email, or reply *HELP* to reach a human. I\'ll wait right here.'
              : '🔒 Please sign up first at https://sakafleet.com — tap *Get Started Free* and verify your email, then I\'ll meet you right back here on WhatsApp.'
          });
          session.history = session.history || [];
          session.history.push({ role: 'user', parts: [{ text: messageText }] });
          session.history.push({ role: 'model', parts: [{ text: verifyReply }] });
          if (session.history.length > CHAT_HISTORY_MAX_MESSAGES) session.history = session.history.slice(-CHAT_HISTORY_MAX_MESSAGES);
          chatSessions.set(senderPhone, session);
          try {
            await sendWhatsAppReply(senderPhone, verifyReply);
            await logChatTranscript(supabaseClient, senderPhone, 'assistant', verifyReply);
            await saveChatMessage(supabaseClient, senderPhone, 'assistant', verifyReply);
          } catch { /* best-effort */ }
          await userLogPromise;
          await persistSnap();
          return { status: confusedGateTurn ? 'unverified_gated_clarify' : 'unverified_gated' };
        }

        let existingVehicles = [];
        let dbHistory = [];

        // Subscription entitlements — resolved once per turn from the frozen
        // registry (cached 60s). Drives the AI tier clamp, registration gate,
        // report quota and every upgrade prompt.
        let entitlements = null;
        try {
          entitlements = await getEntitlements({
            supabase: supabaseClient,
            ownerId: profileData?.id,
            profile: profileData
          });
        } catch (entErr) {
          console.warn('[WhatsApp] entitlements lookup failed:', entErr.message);
        }
        // v1.58.24 - carry the plan's AI cap on the per-request profile object so
        // every composed front message (conversationEngine) routes by plan:
        // paid/trial = Sonnet, free = Haiku.
        if (profileData && entitlements) profileData.maxAiTier = entitlements.maxAiTier;
        const planSummary = entitlements
          ? `${entitlements.tierName}${entitlements.isTrial ? ` (trial, ${entitlements.trialDaysLeft} day(s) left)` : ''} — ${entitlements.effectiveVehicleCapacity} vehicle slot(s), ${Number.isFinite(entitlements.reportsPerMonth) ? `${entitlements.reportsPerMonth} report(s)/month` : 'unlimited reports'}, ${entitlements.maxAiTier >= 3 ? 'full AI (Tiers 0-3)' : 'Tier-1 AI'}`
          : null;
        if (supabaseClient && profileData) {
          // v1.21.3 — history is ALWAYS read: it is the only reliable signal
          // that a conversation really exists. A warm Cloud Run instance can
          // outlive a database wipe, and its in-memory flags must never make a
          // brand-new account look like a returning one.
          const [vehiclesRes, historyRes] = await Promise.all([
            supabaseClient
              .from('vehicles')
              .select('*')
              .is('deleted_at', null)
              .or(`owner_id.eq.${profileData.id},assigned_driver_id.eq.${profileData.id}`),
            getRecentChatHistory(supabaseClient, senderPhone, CHAT_HISTORY_MAX_MESSAGES)
          ]);
          existingVehicles = vehiclesRes?.data || [];
          // v1.24.3 — this turn's own user row can land before the history read on
          // a slow database; filter it out so a first-time user is never mistaken
          // for a returning one and the current message is not duplicated.
          dbHistory = (historyRes || []).filter((row) => {
            const at = row?.created_at ? Date.parse(row.created_at) : NaN;
            return !Number.isFinite(at) || at < turnStartedAt - 1500;
          });
        }

        // v1.61.14 — per-user context cache. Saka must never rely on chat
        // history alone: a conversation START (no fresh history) rebuilds the
        // user's engine facts once (plan, assets, expiries, trial, compliance,
        // month spend, missing-field steps) and every later turn reuses the
        // 15-minute cache. Any write that changes the facts invalidates it.
        let userFactsContext = null;
        try {
          const userContext = await getUserContextCache(supabaseClient, senderPhone, {
            forceRefresh: dbHistory.length === 0,
            profile: profileData,
            vehicles: existingVehicles,
            entitlements,
            countryInfo
          });
          userFactsContext = formatUserFactsBlock(userContext.payload);
        } catch (factsErr) {
          console.warn('[WhatsApp] user-context cache skipped:', factsErr.message);
        }

        const hasVehicleRegistered = existingVehicles.length > 0;
        phaseMarks.profileReadyAt = Date.now();
        const messageLang = detectMessageLanguage(messageText);
        const targetLang = messageLang !== 'English' ? messageLang : (profileData?.preferred_language || 'English');
        let languageSwitchNote = null;
        const languageChanged = messageLang !== 'English' && messageLang !== (profileData?.preferred_language || 'English');
        if (languageChanged) {
          languageSwitchNote = languageSwitchConfirmation(messageLang);
          if (profileData && supabaseClient) {
            try {
              await supabaseClient.from('profiles').update({ preferred_language: messageLang }).eq('id', profileData.id);
              profileData.preferred_language = messageLang;
            } catch {}
          }
        }

        // v1.49.2 — in-WhatsApp web-signup OTP verification removed: signup + OTP
        // verification happen on the website (sakafleet.com) only.

        let currentActiveVehicle = null;
        if (hasVehicleRegistered) {
          currentActiveVehicle = getActiveVehicle({ senderPhone, vehicles: existingVehicles, chatSessions });
          if (!session.active_vehicle_id && currentActiveVehicle) {
            session.active_vehicle_id = currentActiveVehicle.id;
          }
        }

        // Session state determination:
        const isCurrentlyOnboarding = onboardingStore.has(senderPhone);
        if (!isCurrentlyOnboarding && hasVehicleRegistered) {
          session.state = 'ACTIVE';
          session.onboardingStep = null;
        } else if (isCurrentlyOnboarding) {
          session.state = 'ONBOARDING';
          session.onboardingStep = onboardingStore.get(senderPhone)?.step || 1;
        }

        let conversationHistory = session.history || [];
        if (conversationHistory.length === 0 && dbHistory.length > 0) {
          conversationHistory = dbHistory;
        }
        const firstContact = isFirstContact({ session, dbHistory, hasVehicleRegistered, profile: profileData });

        // v1.21.0 — every user lives in a Country Bucket: detected from the
        // WhatsApp number and confirmed at onboarding. The active asset kind
        // selects the right compliance/legal knowledgebase.
        const bucketAssetKind = normalizeAssetKind(
          currentActiveVehicle?.asset_kind
          || currentActiveVehicle?.metadata?.asset_kind
          || currentActiveVehicle?.asset_type
          || 'vehicle'
        );
        const bucketCountryCode = profileData?.country_code || countryInfo.country_code;
        let jurisdictionContext = buildJurisdictionContext(
          getCountryBucket({ countryCode: bucketCountryCode, assetKind: bucketAssetKind })
        );
        // v1.28.8 — country communication style (cached, deterministic) rides
        // with the jurisdiction context so Saka mirrors local register.
        const commStyleLine = await getCountryCommStyleLine({
          supabase: supabaseClient,
          countryCode: bucketCountryCode
        }).catch(() => '');
        if (commStyleLine) jurisdictionContext = `${jurisdictionContext}\n${commStyleLine}`;

        // --- Receipt intelligence (v1.19.0): dedupe + vault ---
        const countryLearningsLine = await getCountryLearningsLine({ supabase: supabaseClient, countryCode: bucketCountryCode }).catch(() => "");
        if (countryLearningsLine) jurisdictionContext = jurisdictionContext + "\n" + countryLearningsLine;

        let duplicateReceipt = null;
        if (mediaObj?.id && supabaseClient && !ocrPaused && (ocrKind === 'receipt_fuel' || ocrKind === 'receipt_general')) {
          try {
            // v1.32.1 — a re-uploaded document gets a NEW WhatsApp media id, so
            // content matching (text hash, 48 h) is what actually stops the
            // second quiz/expense. Media-id matching stays for Meta retries.
            duplicateReceipt = await findReceiptByMediaId(supabaseClient, mediaObj.id)
              || await findRecentReceiptByTextSha(supabaseClient, {
                textSha: ocrTextSha,
                windowHours: Number(process.env.OCR_DUPLICATE_WINDOW_HOURS || 48)
              });
            if (!duplicateReceipt) {
              // v1.23.1 - Free tier keeps the parsed data but NOT the document (no bucket upload without receiptVaultStorage).
              const vaultAllowed = entitlements?.receiptVaultStorage !== false;
              const imageUrl = vaultAllowed && ocrResult?.buffer
                ? await uploadReceiptImage(supabaseClient, ocrResult.buffer, mediaObj.id, ocrResult.mimeType)
                : null;
              await recordReceipt(supabaseClient, {
                mediaId: mediaObj.id,
                ownerId: existingVehicles.some((v) => v.owner_id === profileData?.id) ? profileData?.id : null,
                driverId: existingVehicles.some((v) => v.assigned_driver_id === profileData?.id) ? profileData?.id : null,
                vehicleId: currentActiveVehicle?.id || existingVehicles[0]?.id || null,
                documentKind: ocrKind || 'unknown',
                status: ocrText ? (ocrLowConfidence ? 'low_confidence' : 'read') : 'failed',
                confidence: ocrResult?.confidence ?? null,
                currency: receiptHints.currency || countryInfo?.currency || null,
                amount: receiptHints.amount ?? null,
                fuelLiters: receiptHints.fuel_liters ?? null,
                odometer: receiptHints.odometer ?? null,
                // v1.32.4 — the vendor column carried the raw OCR notes line
                // ("Shell Thika|Diesel"), so receipts printed junk. `vendor` is
                // the real merchant (ocrService.extractDocumentHints).
                vendor: receiptHints.vendor || null,
                imageUrl,
                textSha: ocrTextSha,
                // v1.59.7 — a receipt can carry its own searchable label.
                label: extractEntryLabel(messageText),
                error: ocrError
              });
            }
          } catch { /* the receipt vault is best-effort */ }
        }

        // v1.51.11 — a registration certificate (logbook) is a registration
        // document, never a receipt. Extract the vehicle fields so the
        // registration quiz can be prefilled and confirmed.
        let logbookPrefill = null;
        if (mediaObj?.id && ocrKind === 'logbook' && ocrText) {
          try {
            const lbHints = extractDocumentHints(ocrText, 'logbook', { countryCode: ocrCountry?.country_code || 'GLOBAL' });
            const picked = {};
            for (const key of ['plate_number', 'vin', 'make_model', 'yom', 'fuel_type', 'engine_number', 'color']) {
              if (lbHints?.[key] !== undefined && lbHints[key] !== null && String(lbHints[key]).trim() !== '') picked[key] = lbHints[key];
            }
            if (Object.keys(picked).length > 0) logbookPrefill = picked;
          } catch { /* best-effort */ }
        }

        // Pass message through DeepSeek Intent Classifier (sakaAi.js) with Active Fleet Context
        const activeVehicleContext = hasVehicleRegistered ? {
          activeVehicle: currentActiveVehicle,
          allVehicles: existingVehicles
        } : null;

        // Speed fast-path: an active quiz already owns the conversation state.
        // Skip the DeepSeek intent call — regex classification is instant and
        // the quiz's deterministic parsers handle the answer. This removes the
        // duplicate AI call that previously ran on every quiz turn.
        const quizForFastPath = getActiveQuiz(session);
        const quizPhaseLocked = !!quizForFastPath && (quizForFastPath.phase === 'pin' || quizForFastPath.phase === 'account_otp');
        const fastQuizTurn = !!quizForFastPath && !quizPhaseLocked;

        // Phase 3 (v1.63.3) — every deterministic read lane lives in
        // src/services/readCommands.js, ordered by the OLD dispatch precedence.
        // Detection order no longer matters: the registry is the one decision point.
        const commandText = String(messageText || '').trim();

        // v1.58.15 — deterministic receipt delete stays a WRITE lane in the
        // route (rule 37); no read lane can ever claim "delete receipt N".
        const receiptDeleteMatch = commandText.match(/^(?:delete|remove)\s+receipts?\s+([1-5])(?:\s+(DELETE))?$/i);
        const receiptDeleteCommand = receiptDeleteMatch ? { index: Number(receiptDeleteMatch[1]), confirmed: Boolean(receiptDeleteMatch[2]) } : null;




        // Vehicle registration summary ("send me registration summary as PDF").
        const summaryCommand = isVehicleSummaryCommand(String(messageText || ''));

        // v1.21.0 — Country Bucket commands (deterministic, zero tokens).
        const textForCommands = String(messageText || '').trim();
        const countryChangeCandidate = textForCommands.match(/^(?:change|set|switch)\s+country\s+(?:to\s+)?(.+)$/i)?.[1]
          || textForCommands.match(/^country\s+(.+)$/i)?.[1]
          || null;
        // "country rules/documents/example" are knowledge commands, not a country.
        const isKnowledgeSuffix = Boolean(countryChangeCandidate)
          && /^(?:rules?|documents?|docs?|requirements?|examples?)$/i.test(countryChangeCandidate.trim());
        const countryChangeMatch = countryChangeCandidate && !isKnowledgeSuffix
          ? [null, countryChangeCandidate]
          : null;
        const wantsCountryInfo = /^(?:my\s+country|country|where\s+am\s+i)$/i.test(textForCommands);
        const myRulesCommand = /^(?:my\s+rules?|country\s+rules?|what\s+(?:are\s+)?my\s+rules?|compliance\s+rules?)$/i.test(textForCommands);
        const requiredDocsCommand = /^(?:required\s+(?:documents?|docs?)|what\s+documents?\s+do\s+i\s+need|my\s+document\s+requirements?)$/i.test(textForCommands);
        const exampleComplianceCommand = /^(?:example\s+(?:compliance|document|submission)|give\s+me\s+an\s+example|example\s+text)$/i.test(textForCommands);

        // Country change is a profile write — resolved before any AI call.
        let countryCommandResult = null;
        if (countryChangeMatch) {
          const resolved = resolveCountryInput(countryChangeMatch[1]);
          if (!resolved) {
            countryCommandResult = {
              intent: 'GENERAL_CHAT',
              extracted_data: {},
              reply_message: `🌍 I could not match *${countryChangeMatch[1]}*. Reply *country Kenya* (or another country name) and I will switch your rules, units and documents.`
            };
          } else {
            try {
              // v1.59.0 — an explicit user choice is stamped country_source='user'
              // so reconciliation never overrides it with the phone-derived country.
              const countryUpdate = {
                country: resolved.country,
                country_code: resolved.country_code,
                unit_system: resolved.default_units,
                timezone: resolveTimezoneFromCountry(resolved.country_code),
                jurisdiction_confirmed: true,
                jurisdiction_updated_at: new Date().toISOString(),
                country_source: 'user'
              };
              let { error: countryUpdateError } = await supabaseClient.from('profiles').update(countryUpdate).eq('id', profileData.id);
              if (countryUpdateError && /country_source/i.test(countryUpdateError.message || '')) {
                delete countryUpdate.country_source;
                await supabaseClient.from('profiles').update(countryUpdate).eq('id', profileData.id);
              }
              profileData.country_code = resolved.country_code;
              profileData.country = resolved.country;
              profileData.country_source = 'user';
            } catch { /* best-effort */ }
            countryCommandResult = {
              intent: 'GENERAL_CHAT',
              extracted_data: {},
              reply_message: `🌍 Country bucket updated to *${resolved.country}* (${resolved.country_code}). Your compliance rules, examples, units and documents now follow ${resolved.country}.\n\nReply *required documents* to see what your ${bucketAssetKind.replace(/_/g, ' ')} needs.`
            };
          }
        } else if (wantsCountryInfo) {
          countryCommandResult = {
            intent: 'GENERAL_CHAT',
            extracted_data: {},
            reply_message: `🌍 Your country bucket is *${countryInfo.country}* (${countryInfo.country_code})${profileData?.jurisdiction_confirmed ? ' ✅ confirmed' : ''}.\n\nIt sets your compliance rules, document examples, currency, units and dates. Reply *country <name>* to change it.`
          };
        }

        // v1.24.0 - perceived speed: long free-form paragraphs get an instant ack
        // while this turn parses and records in the background.
        const instantAckEnabled = !/^(?:off|false|0)$/i.test(String(process.env.INSTANT_ACK_ENABLED || 'on'));
        const instantAckChars = Number(process.env.INSTANT_ACK_CHARS || 180);
        if (instantAckEnabled && !mediaObj && !session.quiz && !countryCommandResult
          && String(messageText || '').trim().length >= instantAckChars) {
          try {
            await sendWhatsAppReply(senderPhone, '📖 Got it - reading that now.');
            session.instantAckSent = true;
            if (supabaseClient) await logChatTranscript(supabaseClient, senderPhone, 'assistant', 'Got it - reading that now.');
          } catch { /* ack is best-effort */ }
        }

        // v1.24.2 - slow-turn ack: no user should ever stare at silence while a
        // provider times out. v1.25.1 — 8s threshold, rotating copy and a 60s
        // anti-spam floor so it never feels like a metronome.
        const slowAckMs = resolveSlowAckMs(process.env);
        if (instantAckEnabled && !session.instantAckSent && !mediaObj && !session.quiz
          && !countryCommandResult && slowAckMs > 0) {
          slowAckTimer = setTimeout(async () => {
            if (!shouldSendSlowAck({ turnFinalized, now: Date.now(), lastAckAt: session.lastSlowAckAt || 0 })) return;
            session.slowAckSent = true;
            session.lastSlowAckAt = Date.now();
            const line = pickSlowAckLine(session.slowAckCount || 0);
            session.slowAckCount = (session.slowAckCount || 0) + 1;
            try {
              await sendWhatsAppReply(senderPhone, line);
              if (supabaseClient) {
                await logChatTranscript(supabaseClient, senderPhone, 'assistant', line);
              }
            } catch { /* ack is best-effort */ }
          }, slowAckMs);
          if (typeof slowAckTimer.unref === 'function') slowAckTimer.unref();
        }

        const productQaMatch = matchProductQa(textForCommands);

        // Phase 3 (v1.63.3) — the Read Command Registry snapshot. The registry
        // and the post-hoc records intent fix both read THIS context, so a
        // message can never be parsed two different ways in one turn.
        const readCtx = {
          quizPhaseLocked,
          quizForFastPath: fastQuizTurn,
          hasVehicleRegistered,
          session,
          profile: profileData,
          supabaseClient,
          countryInfo,
          vehicles: existingVehicles,
          activeVehicle: currentActiveVehicle,
          senderPhone,
          targetLang,
          conversationHistory,
          messageText,
          commandText,
          bucketCountryCode,
          bucketAssetKind
        };
        readCtx.recordSpec = inspectRecordQuestion(commandText, readCtx);

        let aiResult;
        phaseMarks.aiStartedAt = Date.now();
        if (ocrPaused) {
          // (unchanged) photo reading paused guard — checked before the registry.
          aiResult = {
            intent: 'APP_HELP',
            extracted_data: {},
            reply_message: '📸 Photo reading is paused right now — please type the details instead (e.g. *"Insurance ABC-123 expires 2027-05-15"*), or send the document as a PDF (PDFs are read instantly).'
          };
        } else if (countryCommandResult) {
          aiResult = countryCommandResult;
        } else {
          // Phase 3 — the Read Command Registry owns every deterministic read.
          // A matched lane returns its complete aiResult here; nothing below
          // can ever see the message (no accidental fall-through).
          const resolveReadTurn = async () => {
            const readLane = resolveReadCommand(commandText, readCtx);
            if (!readLane) return null;
            if (readLane.parksNow && quizForFastPath && !quizPhaseLocked) {
              abandonQuiz(session, { reason: readLane.abandonReason });
            }
            return await readLane.render(readCtx);
          };
          const readTurn = await resolveReadTurn();
          if (readTurn) {
            aiResult = readTurn;
          } else if (receiptDeleteCommand) {
            const isOwner = existingVehicles.some((v) => v.owner_id === profileData?.id);
            const rows = await listReceipts(supabaseClient, {
              ownerId: isOwner ? profileData?.id : null,
              driverId: isOwner ? null : profileData?.id,
              vehicleIds: existingVehicles.map((v) => v.id)
            });
            const target = rows[receiptDeleteCommand.index - 1];
            if (!target) {
              aiResult = { intent: 'GENERAL_CHAT', extracted_data: {}, reply_message: 'I could not find receipt ' + receiptDeleteCommand.index + '. Type *receipts* to see the numbered list.' };
            } else if (!receiptDeleteCommand.confirmed) {
              const label = target.vendor ? String(target.vendor).split('|')[0].trim() : (target.document_kind || 'receipt');
              aiResult = { intent: 'GENERAL_CHAT', extracted_data: {}, reply_message: 'Delete receipt ' + receiptDeleteCommand.index + ' (' + label + ')? Reply *delete receipt ' + receiptDeleteCommand.index + ' DELETE* to confirm. Your expense log stays untouched.' };
            } else {
              const del = await deleteReceipt(supabaseClient, { receiptId: target.id, ownerId: isOwner ? profileData?.id : null, driverId: isOwner ? null : profileData?.id });
              if (del.ok) {
                try {
                  await supabaseClient.from('admin_audit_logs').insert([{ admin_phone: senderPhone, action: 'RECEIPT_DELETED', details: { receipt_id: target.id, media_id: target.media_id || null, vehicle_id: target.vehicle_id || null, objects: del.objects || 0 } }]);
                } catch { /* audit best effort */ }
                aiResult = { intent: 'GENERAL_CHAT', extracted_data: {}, reply_message: 'Receipt ' + receiptDeleteCommand.index + ' deleted, along with its photo. Your expense entry is still in the ledger - use *my entries* to edit or delete it.' };
              } else {
                aiResult = { intent: 'GENERAL_CHAT', extracted_data: {}, reply_message: 'I could not delete that receipt (' + (del.error || 'unknown') + '). It may already be gone.' };
              }
            }
          } else if (fastQuizTurn) {
            const quick = classifyIntentWithRegex(messageText);
            aiResult = { intent: quick.intent, extracted_data: {}, reply_message: null };
          } else {
            aiResult = await processSakaMessage(targetLang, messageText, conversationHistory, [], supabaseClient, activeVehicleContext, {
              maxAiTier: entitlements?.maxAiTier ?? null,
              ownerId: profileData?.id || null,
              planSummary,
              jurisdictionContext,
              workingMemory: buildConversationMemory({ quiz: session?.quiz || null }),
              // v1.61.14 — the cached engine facts ride with every AI turn.
              userFactsContext,
              // v1.59.4 — returning after the fresh window: give the model the last
              // few turns as LABELLED context (never as live turns) so Saka can pick
              // up where the conversation stopped.
              reengagementContext: dbHistory.length === 0
                ? await getReengagementContext(supabaseClient, senderPhone)
                : null
            });
          }
        }
        phaseMarks.aiDoneAt = Date.now();
        let intent = aiResult.intent;
        // v1.58.6 — a clear past-tense expense statement ("Repaired a puncture,
        // cost me 300kes") is LOGGED, never answered as a query, even if the
        // classifier hedged (live 2026-11-04: it kept replying "Nothing logged").
        if (readCtx.recordSpec.question.reason === 'looks-like-log' && !['LOG_EXPENSE', 'LOG_EARNINGS'].includes(intent)) {
          intent = 'LOG_EXPENSE';
        }
        let customReply = aiResult.reply_message;

        // v1.36.0 — a QUERY_RECORDS message the engine could not parse gets a
        // deterministic nudge instead of an AI answer (figures are never invented).
        if (intent === 'QUERY_RECORDS' && !aiResult.__deterministicRecords) {
          customReply = await composeMessage({
            purpose: 'records_query_hint',
            facts: {
              examples: '"how much did I spend on fuel last week?" or "what did I log yesterday?"',
              note: 'The numbers come straight from the user\'s own ledger.'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: '📊 Ask me like this: *"how much did I spend on fuel last week?"* or *"what did I log yesterday?"* — I read the numbers straight from your ledger.'
          });
        }

        // A receipt photo that was already processed never re-enters the
        // expense flow — the duplicate reply below is deterministic.
        if (duplicateReceipt) {
          intent = 'GENERAL_CHAT';
          aiResult = { ...aiResult, intent, extracted_data: {}, reply_message: null };
        }

        // v1.28.6 — report/summary/analysis requests always route to the report
        // engine, even when the classifier leans LOG_EXPENSE because the
        // message mentions fuel ("Give me a fuel report for kas").
        if (looksLikeReportRequest(messageText)
            && ['LOG_EXPENSE', 'LOG_EARNINGS', 'UPDATE_MILEAGE', 'QUERY_FUEL_EFFICIENCY'].includes(intent)) {
          intent = 'REQUEST_REPORT';
          aiResult = { ...aiResult, intent, reply_message: null };
        }

        // Extract and merge structured vehicle attributes
        const regexAttrs = extractVehicleAttributes(messageText);
        const mergedExt = {
          ...regexAttrs,
          ...(aiResult.extracted_data || {})
        };

        // OCR receipt hints prefill the quiz when AI/regex did not capture them
        for (const [hintKey, hintValue] of Object.entries(receiptHints)) {
          if (hintValue === null || hintValue === undefined || hintValue === '') continue;
          if (mergedExt[hintKey] === null || mergedExt[hintKey] === undefined || mergedExt[hintKey] === '') {
            mergedExt[hintKey] = hintValue;
          }
        }

        const isRegisterCommand = /^\s*(register|onboard|add car|add vehicle|new vehicle)\b/i.test(messageText)
          || /\b(?:add|register|onboard)\b[^.!?]{0,24}\b(?:my\s+)?(?:vehicle|car|truck|bike|bus|machine|boat|asset|mower|generator|equipment|compressor|pump)\b/i.test(messageText)
          || /\b(?:upload|send)\b[^.!?]{0,24}\b(?:reg(?:istration)?\s*(?:cert|certificate)|log\s?book)\b/i.test(messageText)
          // v1.56.0 — an existing owner adding another asset ("I have another
          // car", "a second vehicle", "one more truck") is a register command.
          || /\b(?:another|second|one\s+more|an?\s+extra)\s+(?:vehicle|car|truck|bike|motorbike|bus|machine|boat|asset)\b/i.test(messageText);
        const hasVehicleAttributes = !!(mergedExt.plate_number || (mergedExt.yom && (mergedExt.fuel_type || mergedExt.make_model)) || (mergedExt.fuel_type && mergedExt.current_mileage) || mergedExt.vin);

        let isSupportFlow = false;
        // --- SUPPORT ESCALATION FLOW (support@reports.sakafleet.com) ---
        if (session.pendingSupportEscalation) {
          isSupportFlow = true;
          const cleanText = messageText.trim().toLowerCase();
          if (/^(cancel|exit|stop)$/i.test(cleanText)) {
            session.pendingSupportEscalation = false;
            customReply = `Support escalation cancelled. ${hasVehicleRegistered ? "You are back in active menu mode." : "How can I assist you today?"}`;
          } else {
            // v1.58.10 — autonomous customer care: open a ticket + email
            // support@ + ping the superadmin for high-priority cases.
            const care = await handleCareRequest(supabaseClient, {
              phone: senderPhone,
              text: messageText.trim(),
              profile: profileData,
              userEmail: profileData?.email,
              vehiclesList: existingVehicles
            });
            session.pendingSupportEscalation = false;
            // v1.58.22 - only claim "forwarded" when a ticket row actually exists.
            customReply = care?.ticketCreated
              ? await composeMessage({
                  purpose: 'support_escalation',
                  facts: { supportEmail: 'support@reports.sakafleet.com', forwarded: true },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: "I've forwarded your message to our support team at support@reports.sakafleet.com. They will reach out to you shortly!"
                })
              : "Thanks — I couldn't open a support ticket automatically just now. Please email support@reports.sakafleet.com with a line about what happened, or reply *Support* to try again.";
          }
        } else if (
          /\b(support team|contact support|talk to support|human help|help from (?:a )?human|talk to (?:a )?(?:human|person|agent|representative)|human (?:agent|support)|customer (?:care|support)|file a complaint|escalat(?:e|ion)|dispute|admin intervention|confus(?:ed|ing)|doesn'?t make sense|not clear)\b/i.test(messageText)
        ) {
          isSupportFlow = true;
          session.pendingSupportEscalation = true;
          customReply = await composeMessage({
            purpose: 'support_intake',
            facts: {
              instruction: 'Ask the user to describe the issue in one message so it can be forwarded to support.',
              supportEmail: 'support@reports.sakafleet.com'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: 'Please describe your issue in one message and I will forward it to support@reports.sakafleet.com.'
          });
        }

        if (!isSupportFlow) {

        let isSpecialFlowHandled = false;

        // 1. In-flight Passbook Transfer Handler (Current Owner Steps 2 & 3)
        if (session.transferFlow) {
          isSpecialFlowHandled = true;
          const cleanText = messageText.trim().toLowerCase();
          if (/^(cancel|exit|stop|cancel transfer)$/i.test(cleanText)) {
            if (session.transferFlow.transferId && supabaseClient) {
              await supabaseClient.from('passbook_transfers').update({ status: 'CANCELLED' }).eq('id', session.transferFlow.transferId);
            }
            session.transferFlow = null;
            customReply = await composeMessage({
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
                customReply = `🔒 *Step 3 of 5: Security Authorization*\n\nWe dispatched a 6-digit release PIN to your email (*${res.ownerEmail}*).\n\nPlease reply with the 6-digit code to authorize releasing ownership of *${session.transferFlow.vehicle.plate_number}* to ${res.buyerPhone}.\n\n_(Reply 'cancel' to abort)_`;
              } else {
                customReply = `⚠️ ${res.error}\n\nPlease reply with both the buyer's WhatsApp number and email address, or reply 'cancel'.`;
              }
            } else {
              customReply = await composeMessage({
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
              sendWhatsAppFn: sendWhatsAppReply
            });

            if (res.success) {
              const plate = session.transferFlow.vehicle.plate_number;
              session.transferFlow = null;
              customReply = `✅ *Asset Release Authorized!*\n\nWe have notified the buyer on WhatsApp at *${res.buyerPhone}*.\n\nAwaiting the buyer's reply to claim ownership of *${plate}*.`;
            } else {
              customReply = `❌ ${res.error}\n\nPlease enter the correct 6-digit release code sent to your email, or reply 'cancel' to abort.`;
            }
          }
        }
        // 2. Buyer Acceptance ("ACCEPT") / Driver Assignment Response
        else if (/^\s*(accept|decline|reject|claim passbook|claim ownership)\b/i.test(messageText)) {
          if (supabaseClient) {
            const acceptRes = await handleBuyerAcceptance({
              buyerPhone: senderPhone,
              supabase: supabaseClient,
              sendWhatsAppFn: sendWhatsAppReply
            });
            if (acceptRes) {
              isSpecialFlowHandled = true;
              if (acceptRes.status === 'OTP_SENT') {
                session.pendingTransferBuyerOtp = { transferId: acceptRes.transferId };
              }
              customReply = acceptRes.replyMessage;
            } else if (/^\s*(accept|decline|reject)\b/i.test(messageText.trim())) {
              const driverRes = await handleDriverResponse({
                driverPhone: senderPhone,
                response: /^\s*accept/i.test(messageText.trim()) ? 'ACCEPT' : 'DECLINE',
                supabase: supabaseClient,
                sendWhatsAppFn: sendWhatsAppReply,
                countryInfo
              });
              if (driverRes) {
                isSpecialFlowHandled = true;
                if (driverRes.status === 'ACCEPTED') {
                  session.driverOnboarding = !driverRes.compliance?.canManage;
                  session.active_vehicle_id = driverRes.vehicle?.id || session.active_vehicle_id;
                }
                customReply = driverRes.replyMessage;
              }
            }
          }
        }
        // 2b. Owner driver-assignment OTP (legacy command path)
        else if (session.pendingAssignmentOtp && (
          /^\d{6}$/.test(messageText.trim()) ||
          /^(resend|resend code|new code|send again)$/i.test(messageText.trim()) ||
          /^(cancel|exit|stop)$/i.test(messageText.trim())
        )) {
          if (supabaseClient) {
            const clean = messageText.trim();
            if (/^(cancel|exit|stop)$/i.test(clean)) {
              await cancelPendingAssignment({
                supabase: supabaseClient,
                assignmentId: session.pendingAssignmentOtp.assignmentId,
                ownerId: profileData?.id
              });
              session.pendingAssignmentOtp = null;
              isSpecialFlowHandled = true;
              customReply = await composeMessage({
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
                sendWhatsApp: sendWhatsAppReply
              });
              isSpecialFlowHandled = true;
              if (resent.ok) {
                session.pendingAssignmentOtp = {
                  assignmentId: resent.assignment.id,
                  vehicleId: resent.assignment.vehicle_id,
                  driverPhone: resent.driverPhone,
                  expiresAt: resent.expiresAt
                };
                customReply = await composeMessage({
                  purpose: 'otp_dispatched',
                  facts: { deliveredTo: 'your verified email', action: 'Reply with the code to continue.' },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: '🔐 A fresh 6-digit code has been emailed to you. Reply with it to continue.'
                });
              } else {
                customReply = `❌ ${resent.error}`;
              }
            } else {
              const verified = await verifyOwnerAssignmentOtp({
                supabase: supabaseClient,
                assignmentId: session.pendingAssignmentOtp.assignmentId,
                ownerId: profileData?.id,
                code: clean,
                sendWhatsApp: sendWhatsAppReply
              });
              isSpecialFlowHandled = true;
              if (verified.ok) {
                session.pendingAssignmentOtp = null;
                customReply = `✅ *Assignment Verified*\n\nWe notified *${verified.driverPhone}* about *${verified.plate}*. They must reply *ACCEPT* to take over the vehicle.\n\nOnce they accept, Saka will guide them through email verification and their ${verified.vehicle?.asset_type ? 'compliance details' : 'driving licence'} before they can manage it.`;
              } else {
                if (verified.cancelled || verified.expired) session.pendingAssignmentOtp = null;
                customReply = `❌ ${verified.error}`;
              }
            }
          }
        }
        // 3. Buyer Email OTP Verification (Step 5)
        else if (session.pendingTransferBuyerOtp || (messageText.trim().match(/^\d{6}$/) && !session.quiz && !isCurrentlyOnboarding && !session.pendingEmailUpdate && !session.pendingDeleteVehicle && !session.pendingAccountDeletion && !onboardingStore.has(senderPhone))) {
          if (supabaseClient) {
            const transferCompleteRes = await completePassbookTransfer({
              buyerPhone: senderPhone,
              providedOtp: messageText.trim(),
              supabase: supabaseClient,
              sendWhatsAppFn: sendWhatsAppReply
            });
            if (transferCompleteRes.success) {
              isSpecialFlowHandled = true;
              session.pendingTransferBuyerOtp = null;
              session.state = 'ACTIVE';
              customReply = `🎉 *Congratulations!* You are now the official registered owner of *${transferCompleteRes.plateNumber}* on Saka Fleet! 🚗\n\n• *VIN:* \`${transferCompleteRes.vin}\`\n• *Passbook Token:* \`${transferCompleteRes.newToken}\`\n\nYour official digital passbook has been sent to *${transferCompleteRes.buyerEmail}*.\nType *"What can I do?"* to explore your owner tools!`;
            } else if (transferCompleteRes.needsUpgrade) {
              // Simple Rule R2 — buyer over capacity: send the upgrade link,
              // keep the transfer paused, and accept the same code afterwards.
              isSpecialFlowHandled = true;
              const cap = transferCompleteRes.capacity || {};
              const upgrade = await checkoutForTier({
                supabase: supabaseClient,
                owner: { id: profileData?.id, phone_number: formattedPhone, email: profileData?.email },
                targetTierKey: cap.nextTierKey || 'team_fleet',
                interval: entitlements?.billingInterval || 'monthly',
                currency: countryInfo?.currency || 'USD'
              });
              customReply = `⚠️ *Upgrade needed to accept this passbook*\n\nYour *${cap.tierName || 'current'}* plan allows ${cap.capacity || 1} active vehicle(s) and you already have ${cap.currentCount || 0}.\n\nUpgrade to *${getTierLabel(cap.nextTierKey || 'team_fleet')}* to accept the transfer:\n👉 ${await shortenUrl(supabaseClient, upgrade.ok ? upgrade.checkoutUrl : 'https://sakafleet.com/pricing')}\n\nAfter payment, reply *resend* to get a fresh verification code and finish the handover. The seller's vehicle stays untouched until then.`;
            }
          }
        }
        // 4. Trial Extension Coupon ("Yes" or coupon code)
        //
        // v1.32.3 — a bare "yes" only redeems a coupon when Saka actually offered
        // one. Live bug 2026-11-01 09:31: the owner answered the compliance
        // question with "yes" and the coupon branch swallowed the turn.
        else if (!session.quiz && !session.pendingDeleteVehicle && !session.pendingAccountDeletion && !session.pendingCancelSubscription && intent !== 'EXTEND_TRIAL' && (intent === 'APPLY_COUPON' || /^EXT30-[A-Z0-9]+$/i.test(messageText.trim()) || mergedExt?.coupon_code || (/^(apply coupon|redeem coupon|extend trial)$/i.test(messageText.trim()) && /(?:coupon|EXT30-|extend\s+(?:your|the|my)?\s*trial|trial\s+extension)/i.test(String(session.lastAssistantPrompt || ''))))) {
          if (supabaseClient) {
            const couponCode = mergedExt.coupon_code || (messageText.trim().startsWith('EXT30-') ? messageText.trim() : null);
            // v1.61.16 — account-bound redemption first (owner binding + atomic
            // claim + audits); the legacy VIN path only serves historical EXT30
            // rows that predate account binding.
            const accountRes = await applyAccountTrialExtensionCoupon({
              supabase: supabaseClient,
              ownerId: profileData?.id,
              code: couponCode
            });
            const extRes = accountRes.ok
              ? {
                  success: true,
                  couponCode: accountRes.couponCode,
                  daysAdded: accountRes.daysAdded,
                  newTrialEndAt: accountRes.endsAt,
                  plateNumber: currentActiveVehicle?.plate_number || existingVehicles[0]?.plate_number || 'your account'
                }
              : await applyTrialExtensionCoupon({ phone: senderPhone, couponCode, supabase: supabaseClient });
            if (extRes.success) {
              isSpecialFlowHandled = true;
              customReply = `🎉 *Trial Extension Applied!* 🚗💨\n\n• *Account:* ${extRes.plateNumber}\n• *Coupon Code:* *${extRes.couponCode}*\n• *Days Added:* +${extRes.daysAdded} Days\n• *New Trial Expiration:* ${new Date(extRes.newTrialEndAt).toLocaleDateString()}\n\nYour free trial has been successfully extended. Type *"What can I do?"* to explore your fleet tools!`;
            } else if (accountRes?.error) {
              isSpecialFlowHandled = true;
              customReply = `🎟️ ${accountRes.error}`;
            }
          }
        }
        // 4b. Subscription, trial & add-on intents (v1.15.0) — engine-owned.
        else if (!session.quiz && !session.pendingDeleteVehicle && !session.pendingAccountDeletion
          && (session.pendingCancelSubscription
            || ['VIEW_SUBSCRIPTION', 'UPGRADE_SUBSCRIPTION', 'CANCEL_SUBSCRIPTION', 'MANAGE_ADDONS', 'KEEP_VEHICLE', 'EXTEND_TRIAL'].includes(intent)
            || /^(?:subscription|billing)\b/i.test(messageText.trim())
            || /\b(?:my\s+(?:plan|subscription)|upgrade|subscribe|cancel\s+(?:my\s+)?(?:subscription|plan)|unsubscribe|keep\s+(?:vehicle|car)\b|extra\s+(?:car|vehicle|slot)|add[- ]?on|extend\s+(?:my\s+)?trial|which\s+tier|should\s+be\s+on|(?:less|fewer|more)\s+than\s+\d+\s+(?:assets?|vehicles?)|put\s+me\s+on|move\s+me\s+to|enroll\s+me|confirm\s+(?:which|what)\s+tier|what\s+tier\s+am\s+i)\b/i.test(messageText.trim()))) {
          isSpecialFlowHandled = true;
          const subTurn = await maybeHandleSubscriptionTurn({
            intent,
            messageText,
            mergedExt,
            session,
            profileData,
            supabaseClient,
            countryInfo,
            senderPhone: formattedPhone,
            entitlements,
            existingVehicles
          });
          customReply = subTurn.reply;
          if (subTurn.entitlements) entitlements = subTurn.entitlements;
        }
        // 4c. PASSBOOK SNAPSHOT (v1.16.2) — deterministic, zero AI tokens.
        else if (!session.quiz && existingVehicles.length > 0
          && /^(?:passbook(?:\s+details)?|my\s+passbook|vehicle\s+snapshot)$/i.test(messageText.trim())) {
          isSpecialFlowHandled = true;
          const snapshotVehicle = currentActiveVehicle || existingVehicles[0];
          let expenseLines = [];
          if (supabaseClient && snapshotVehicle?.id) {
            try {
              const { data: recentExpenses } = await supabaseClient
                .from('expense_logs')
                .select('expense_type,amount,created_at')
                .eq('vehicle_id', snapshotVehicle.id)
                .order('created_at', { ascending: false })
                .limit(5);
              expenseLines = (recentExpenses || []).map((row) =>
                `• ${row.expense_type || 'Expense'}: ${countryInfo?.currency || 'USD'} ${Number(row.amount || 0).toLocaleString()}`
              );
            } catch { expenseLines = []; }
          }
          const planLine = entitlements?.isTrial
            ? `🎁 Trial: ${entitlements.tierName} — ${entitlements.trialDaysLeft} day(s) left`
            : `📦 Plan: ${entitlements?.tierName || 'Free'}${entitlements?.isPaid ? ' (paid)' : ''}`;
          const vehicleLines = existingVehicles.map((v) =>
            `• ${v.plate_number} — ${Number(v.current_mileage || v.odometer_reading || 0).toLocaleString()} km${v.id === snapshotVehicle.id ? ' *(active)*' : ''}`
          ).join('\n');
          customReply = `📘 *Your Saka passbook*\n\n${vehicleLines}\n\n${planLine}\n\n${expenseLines.length
            ? `🧾 *Recent expenses — ${snapshotVehicle.plate_number}*\n${expenseLines.join('\n')}`
            : '🧾 No expenses logged yet — reply *"log expense"* to add your first one.'}`;
        }

        // 5. Action Discovery & Role Help (AI-rendered from the role index)
        else if (!session.quiz && (intent === 'ACTION_DISCOVERY' || intent === 'APP_HELP' || /\b(?:what\s+can\s+i\s+do|show\s+my\s+actions|my\s+actions|show\s+actions|what\s+are\s+my\s+commands|available\s+commands)\b/i.test(messageText.trim()))) {
          isSpecialFlowHandled = true;
          customReply = await renderRoleActions({
            profileData,
            vehicles: existingVehicles,
            senderPhone,
            language: targetLang,
            countryInfo
          });
          if (profileData?.driver_profile_pending) {
            customReply += `\n\n👤 *Your driver profile is incomplete.* Reply *"driver profile"* to add your licence — it powers renewal reminders and driver assignments.`;
          }
        }

        // VEHICLE compliance intake — strictly separate from DRIVER compliance.
        // A vehicle carries asset permits (insurance, inspection/MOT, PSL, road
        // tax, speed-limiter…); drivers carry licences/badges. One paragraph can
        // save several vehicle items at once.
        if (!isSpecialFlowHandled && !session.quiz && supabaseClient && profileData?.id
          && !['LOG_EXPENSE', 'LOG_EARNINGS'].includes(intent)
          && /\b(insurance|insured|inspection|mot\b|roadworthy|road\s*service|psl\b|road\s*tax|licence\s*disc|license\s*disc|speed\s*limiter|registration|emissions|policy)\b/i.test(messageText)
          && /\d/.test(messageText)
          && (/\b(expires?|expiry|expiring|due|renew|renewal|valid\s+(?:until|till|for))\b/i.test(messageText) || /\b\d{4}-\d{2}-\d{2}\b/.test(messageText))) {
          const ownedVehicles = existingVehicles.filter((v) => v.owner_id === profileData.id);
          const targetVehicle = ownedVehicles.find((v) => v.id === currentActiveVehicle?.id)
            || (ownedVehicles.length === 1 ? ownedVehicles[0] : null);
          if (targetVehicle) {
            const assetType = targetVehicle.asset_type || targetVehicle.metadata?.asset_type || null;
            const countryCode = countryInfo?.country_code || 'GLOBAL';
            const vehicleTimeZone = resolveUserTimezone({ countryInfo, profile: profileData });
            const parsedItems = parseVehicleComplianceParagraph(messageText, {
              countryCode,
              assetType,
              locale: countryInfo?.locale || 'en-US',
              timeZone: vehicleTimeZone
            });
            if (parsedItems.length > 0) {
              isSpecialFlowHandled = true;
              const savedLines = [];
              for (const entry of parsedItems) {
                const result = await submitVehicleCompliance({
                  supabase: supabaseClient,
                  vehicle: targetVehicle,
                  item: entry.item,
                  parsed: entry.parsed,
                  countryCode,
                  assetType,
                  ownerId: profileData.id,
                  timeZone: vehicleTimeZone
                });
                if (result.ok) {
                  const expiryLabel = entry.parsed.lifetime ? 'valid for life' : entry.parsed.expiry;
                  // v1.32.2 — show days-left so a misread date is visible instantly.
                  const days = Number(entry.parsed.daysLeft);
                  const when = Number.isFinite(days)
                    ? (days < 0 ? ` — expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago` : ` — in ${days} day${days === 1 ? '' : 's'}`)
                    : '';
                  savedLines.push(`• ${entry.item.label}: ${expiryLabel}${when}${entry.parsed.number ? ` (${entry.parsed.number})` : ''}`);
                }
              }
              customReply = savedLines.length
                ? `🛡️ *Vehicle compliance saved — ${targetVehicle.plate_number}*\n\n${savedLines.join('\n')}\n\n_Vehicle permits are tracked separately from your personal driver compliance._\n\nRenewal reminders are active 30/14/7/24h before expiry.`
                : 'I could not read those vehicle compliance details. Try: _"Insurance policy ABC123 expires 2027-05-15, PSL 445566 expires 30 Nov 2026"_.';
            }
          }
        }

        // v1.58.25 — a pending compliance capture owns its follow-up turn, so a
        // half-answer ("445566", "8 Aug 2027") lands on the document instead of
        // the generic menu (live PSV loop 2026-11-04).
        if (!isSpecialFlowHandled && !session.quiz && session.pendingComplianceCapture
          && (isUnreadableMediaNote(messageText) || !looksLikeFreshLogLine(messageText))) {
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
            isSpecialFlowHandled = true;
            customReply = complianceCaptureCancelText();
          } else if (isComplianceCaptureExpired(pending) || !pendingItem) {
            session.pendingComplianceCapture = null;
          } else if (pendingScope === 'driver' && detectDocumentTypeCorrection(messageText)) {
            // v1.61.3 — "This is a psv licence not drivers license" re-buckets
            // the pending capture instead of looping on the wrong document.
            const correctedType = detectDocumentTypeCorrection(messageText);
            const correctedItem = catalogCandidates(pendingCatalog).find((entry) => entry.type === correctedType) || pendingItem;
            session.pendingComplianceCapture = { ...pending, scope: 'driver', type: correctedItem.type, at: new Date().toISOString() };
            isSpecialFlowHandled = true;
            customReply = `Got it — switching to your *${correctedItem.label}* (a DRIVER document, not a vehicle permit).\n\nSend the number and expiry in one line — e.g. _${correctedItem.label} TSV2026 expires 8 Aug 2027_.`;
          } else if (isUnreadableMediaNote(messageText)) {
            // v1.61.3 — an unreadable photo during a capture never falls to the
            // menu (the old system note tripped the fresh-log guard).
            session.pendingComplianceCapture = { ...pending, at: new Date().toISOString() };
            isSpecialFlowHandled = true;
            customReply = `📸 I couldn't read that photo. Send the number and expiry in one line — e.g. _${pendingItem.label} 445566 expires 8 Aug 2027_ — or a clearer photo.`;
          } else if (isPhotoIntent(messageText)) {
            // v1.61.3 — "Can I share a picture?" gets a warm yes + the rule
            // (confirm before save), not a looped typed-only example.
            session.pendingComplianceCapture = { ...pending, at: new Date().toISOString() };
            isSpecialFlowHandled = true;
            customReply = `📸 Yes — send the photo now. I'll read the number and expiry and confirm with you before saving.${pendingScope === 'driver' ? '\n\n_Driver documents are saved on your profile, never on the vehicle._' : ''}`;
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
            isSpecialFlowHandled = true;
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
                timeZone
              });
              session.pendingComplianceCapture = null;
              customReply = saved.ok
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
              customReply = complianceCapturePrompt({
                item: pendingItem,
                scope: pendingScope,
                have: { number: nextNumber, expiry: nextExpiry, lifetime: merged?.lifetime ?? pending.lifetime },
                contextLabel: context.vehicle?.plate_number || null
              });
            }
          }
        }


        // v1.58.25 — a vehicle permit request without details ("add insurance")
        // gets the exact one-line example, never the generic menu (rule 51 sibling).
        if (!isSpecialFlowHandled && !session.quiz && supabaseClient && profileData?.id
          && VEHICLE_DOC_RE.test(messageText)) {
          const ownedVehicles = existingVehicles.filter((v) => v.owner_id === profileData.id);
          const targetVehicle = ownedVehicles.find((v) => v.id === currentActiveVehicle?.id)
            || (ownedVehicles.length === 1 ? ownedVehicles[0] : null);
          if (targetVehicle) {
            const assetType = targetVehicle.asset_type || targetVehicle.metadata?.asset_type || null;
            const catalog = resolveVehicleComplianceCatalog({ countryCode: countryInfo?.country_code, assetType, includeAll: true });
            const addRequest = detectComplianceAddRequest(messageText, { catalog, scope: 'vehicle' });
            if (addRequest?.item) {
              isSpecialFlowHandled = true;
              session.pendingComplianceCapture = {
                scope: 'vehicle',
                type: addRequest.item.type,
                number: null,
                expiry: null,
                at: new Date().toISOString()
              };
              customReply = complianceCapturePrompt({
                item: addRequest.item,
                scope: 'vehicle',
                contextLabel: targetVehicle.plate_number || null
              });
            }
          }
        }


        // Driver documents — any OWNER or assigned driver can add or refresh a
        // compliance item from chat ("PSV badge 445566 expires 15 Dec 2028").
        // v1.58.25: owners keep their own documents too (rule 51 sibling: the
        // old lane required vehicles.assigned_driver_id and silently dead-ended).
        if (!isSpecialFlowHandled && !session.quiz && supabaseClient && profileData?.id
          && DRIVER_DOC_RE.test(messageText)) {
          const context = pickComplianceContextVehicle({ vehicles: existingVehicles, profileId: profileData.id });
          if (context.vehicle) {
            const assetType = context.vehicle.asset_type || context.vehicle.metadata?.asset_type || null;
            const catalog = resolveBundledCatalog({ countryCode: countryInfo?.country_code, assetType, includeAll: true });
            const item = findMentionedComplianceItem(messageText, catalog);
            const addRequest = detectComplianceAddRequest(messageText, { catalog, scope: 'driver' });
            if (item && (addRequest || /\d/.test(messageText))) {
              const timeZone = resolveUserTimezone({ countryInfo, profile: profileData });
              const details = extractComplianceDetails(messageText, {
                item,
                countryCode: countryInfo?.country_code || 'GLOBAL',
                locale: countryInfo?.locale || 'en-US',
                timeZone
              });
              isSpecialFlowHandled = true;
              if (details.ok) {
                const isMinimal = !context.isSelfProfile && item.type === catalog.minimal?.type;
                const saved = await persistCapturedCompliance({
                  supabaseClient,
                  profileData,
                  scope: 'driver',
                  item,
                  parsed: details.parsed,
                  vehicle: context.vehicle,
                  isSelfProfile: context.isSelfProfile,
                  isMinimal,
                  countryCode: countryInfo?.country_code || 'GLOBAL',
                  assetType,
                  timeZone
                });
                session.pendingComplianceCapture = null;
                customReply = saved.ok
                  ? formatComplianceSaved({ item, parsed: details.parsed, scope: 'driver', contextLabel: context.isSelfProfile ? null : context.vehicle.plate_number || null })
                  : `❌ ${saved.error}`;
              } else {
                session.pendingComplianceCapture = {
                  scope: 'driver',
                  type: item.type,
                  number: details.number || null,
                  expiry: details.expiry || null,
                  lifetime: Boolean(details.lifetime),
                  at: new Date().toISOString()
                };
                customReply = complianceCapturePrompt({
                  item,
                  scope: 'driver',
                  have: { number: details.number || null, expiry: details.expiry || null, lifetime: Boolean(details.lifetime) },
                  contextLabel: context.isSelfProfile ? null : context.vehicle.plate_number || null
                });
              }
            }
          }
        }

        // v1.49.0 — point of entry is the website. An email-unverified WhatsApp
        // user is sent to sakafleet.com instead of starting the registration quiz;
        // the quiz only proceeds once the profile is email_verified (web signup).
        const registrationEmailGated = !hasVehicleRegistered
          && profileData?.email_verified !== true
          && !session.quiz
          && !isSuperadminPhone(senderPhone)
          && (isRegisterCommand || intent === 'REGISTER_VEHICLE' || intent === 'ONBOARDING_INPUT' || hasVehicleAttributes);
        if (registrationEmailGated) {
          customReply = await composeMessage({
            purpose: 'website_signup_gate',
            facts: {
              websiteUrl: 'https://sakafleet.com',
              reason: 'Vehicle registration needs a verified email from the website signup first.'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: '🚀 *Set up in about a minute on the website*\n\nTap *Get Started Free* at https://sakafleet.com — I\'ll meet you on WhatsApp once your email is verified.'
          });
          onboardingStore.delete(senderPhone);
          session.state = 'IDLE';
          session.onboardingStep = null;
          isSpecialFlowHandled = true;
        }

        if (!isSpecialFlowHandled) {

        // --- SAKA QUIZ ENGINE: one-piece-at-a-time flows + confirmation ---
        // Driver compliance gate: accepted drivers must verify their email and
        // submit a valid minimal compliance item before managing the vehicle.
        let driverGate = null;
        if (supabaseClient && profileData?.id && currentActiveVehicle?.assigned_driver_id === profileData.id) {
          try {
            driverGate = await canManageVehicle({ supabase: supabaseClient, profile: profileData, vehicle: currentActiveVehicle });
          } catch {
            driverGate = null;
          }
        }
        const VEHICLE_BOUND_INTENTS = new Set([
          'LOG_EXPENSE', 'LOG_EARNINGS', 'UPDATE_MILEAGE', 'LOG_OPERATING_HOURS',
          'SET_REMINDER', 'COMPLETE_REMINDER', 'EDIT_VEHICLE', 'DELETE_VEHICLE',
          'TRANSFER_PASSBOOK', 'QUERY_FLEET_SUMMARY', 'REQUEST_REPORT',
          'QUERY_FUEL_EFFICIENCY', 'MANAGE_VEHICLE', 'LIST_VEHICLES'
        ]);
        const gateRedirect = Boolean(driverGate?.gated) && VEHICLE_BOUND_INTENTS.has(intent);

        const quizStartFlow = detectQuizStart({
          intent,
          messageText,
          hasVehicleRegistered,
          isRegisterCommand,
          hasVehicleAttributes,
          driverOnboardingPending: session.driverOnboarding === true || gateRedirect
        });

        // Receipt photos always confirm before any write — a paper trail is
        // never silently auto-logged, even when every number is readable.
        const isReceiptDocument = ocrKind === 'receipt_fuel' || ocrKind === 'receipt_general';
        const receiptQuizStart = (mediaObj && isReceiptDocument && intent === 'LOG_EXPENSE')
          ? 'log_expense'
          : quizStartFlow;

        // --- NARRATIVE INTAKE (v1.34.0) ---
        // One free-text sentence ("spent 5500 on diesel yesterday at Shell,
        // 40L at 50350km, full tank") becomes a deterministic draft that
        // pre-fills the quiz. Deterministic fields always win over AI output.
        let narrativeDraft = null;
        let narrativeExt = mergedExt;
        let narrativeBatchCardReply = null;
        let narrativeSuppressQuiz = false;
        let forcedNarrativeFlow = null;
        if (isNarrativeIntakeEnabled()
            && !session.quiz
            && !mediaObj
            && isNarrativeEligibleText(messageText)
            && ['LOG_EXPENSE', 'LOG_EARNINGS', 'UPDATE_MILEAGE'].includes(intent)) {
          try {
            const candidate = buildNarrativeDraft({
              text: messageText,
              ctx: { countryInfo, profile: profileData },
              vehicles: existingVehicles,
              activeVehicle: currentActiveVehicle
            });
            if (candidate.ok && shouldPrefillNarrativeDraft(candidate)) {
              narrativeDraft = candidate;
              narrativeExt = {
                ...(mergedExt || {}),
                ...narrativeDraftFields(candidate),
                _narrative: narrativeDraftExtras(candidate)
              };
            } else {
              // v1.38.0 (D4) — one paragraph, several records: show a numbered
              // plan card and keep a 15-minute batch state for SAVE ALL.
              const paragraph = buildNarrativeParagraphDrafts({
                text: messageText,
                ctx: { countryInfo, profile: profileData },
                vehicles: existingVehicles,
                activeVehicle: currentActiveVehicle
              });
              if (paragraph.ok && paragraph.drafts.length >= 2) {
                session.narrativeBatch = { drafts: paragraph.drafts, at: new Date().toISOString() };
                narrativeBatchCardReply = renderNarrativeBatchCard(paragraph.drafts, {
                  locale: countryInfo?.locale || 'en-US',
                  currency: countryInfo?.currency || 'USD'
                });
              }
            }
          } catch (narrativeErr) {
            console.warn('[narrative] draft skipped:', narrativeErr.message);
          }
        }

        // v1.58.3 - one-line write intents with several vehicles and no named
        // vehicle must ask which vehicle instead of silently defaulting to the
        // active one. A single-vehicle account (or a named plate) is unaffected.
        const writeIntents = ['LOG_EXPENSE', 'LOG_EARNINGS', 'UPDATE_MILEAGE', 'LOG_OPERATING_HOURS', 'SET_REMINDER', 'EDIT_VEHICLE'];
        const namedVehicle = matchNarrativeVehicle(String(messageText || ''), existingVehicles, null);
        const hasNamedVehicle = ['plate', 'ordinal', 'label', 'single'].includes(namedVehicle.reason);
        const forceVehiclePrompt = !session.quiz
          && writeIntents.includes(intent)
          && existingVehicles.length >= 2
          && !hasNamedVehicle;
        const quizCtx = {
          supabase: supabaseClient,
          profile: profileData,
          vehicles: existingVehicles,
          activeVehicle: forceVehiclePrompt ? null : currentActiveVehicle,
          countryInfo,
          senderPhone,
          formattedPhone,
          language: targetLang,
          intent,
          aiExtracted: narrativeExt,
          messageText,
          fastQuiz: fastQuizTurn,
          driverGate,
          sendWhatsApp: sendWhatsAppReply
        };

        // v1.38.0 (D4) — the pending multi-record batch answers its own turns:
        // SAVE ALL writes every row through the normal audited quiz path, edit N
        // reopens that row's draft card, cancel clears without a write.
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
            customReply = saved.length
              ? `✅ *Saved ${saved.length} of ${pendingBatch.drafts.length} records* 📝\n\n${saved.map((line, i) => `${i + 1}. ${line}`).join('\n')}`
              : '⚠️ I could not save those records just now — nothing was written.';
            isSpecialFlowHandled = true;
            narrativeSuppressQuiz = true;
          } else if (batchTurn.type === 'cancel') {
            customReply = await composeMessage({
              purpose: 'batch_cancelled',
              facts: { saved: false },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: '❌ Nothing was saved.'
            });
            isSpecialFlowHandled = true;
            narrativeSuppressQuiz = true;
          } else if (batchTurn.type === 'invalid-edit') {
            customReply = renderNarrativeBatchCard(pendingBatch.drafts, {
              locale: countryInfo?.locale || 'en-US',
              currency: countryInfo?.currency || 'USD'
            });
            isSpecialFlowHandled = true;
            narrativeSuppressQuiz = true;
          } else if (batchTurn.type === 'edit') {
            const editDraft = pendingBatch.drafts[batchTurn.index];
            forcedNarrativeFlow = editDraft.kind === 'earning' ? 'log_earnings' : (editDraft.kind === 'mileage' ? 'log_mileage' : 'log_expense');
            narrativeExt = {
              ...(mergedExt || {}),
              ...narrativeDraftFields(editDraft),
              _narrative: narrativeDraftExtras(editDraft)
            };
            quizCtx.aiExtracted = narrativeExt;
          }
        } else if (narrativeBatchCardReply) {
          // The plan card was rendered for this paragraph; suppress the quiz so
          // the card is the ONLY reply and the batch waits for its turn.
          isSpecialFlowHandled = true;
          customReply = narrativeBatchCardReply;
          narrativeSuppressQuiz = true;
        }

        // Quiz ↔ Conversation arbitration — a greeting/question mid-quiz is
        // answered conversationally and the quiz resumes where it paused.
        // v1.58.6 — an explicit "switch to <plate/number>" is navigation, not a
        // quiz answer: drop any open draft so the switch handler runs cleanly
        // (live 2026-11-04: it got stuck asking for litres, then garbled the
        // plate "KBJ 819C" into "KES 819").
        if (session.quiz && /^\s*(?:switch(?:\s+to)?|manage|select)\s+\S/i.test(String(messageText || ''))) {
          abandonQuiz(session, { reason: 'switch_command' });
        }
        const activeQuiz = session.quiz || null;
        const pauseQuizForChat = activeQuiz && shouldPauseQuizForChat({ messageText, intent, quiz: activeQuiz });
        const switchQuizFlow = activeQuiz && !pauseQuizForChat
          ? detectFlowSwitch({ quiz: activeQuiz, messageText, intent })
          : null;

        const buildPausedQuizReply = async (quizState) => {
          const isHelp = intent === 'ACTION_DISCOVERY' || intent === 'APP_HELP' ||
            /^(help|hint|what can i do|what do i do next|guide me)$/i.test(messageText.trim());

          const field = getCurrentQuizField(quizState, quizCtx);

          if (isHelp) {
            const discovery = await renderRoleActions({
              profileData,
              vehicles: existingVehicles,
              senderPhone,
              language: targetLang,
              countryInfo
            });
            if (!field) return discovery;
            const nudge = await composeMessage({
              purpose: 'quiz_resume_nudge',
              facts: {
                currentQuestion: field.label,
                questionHint: field.hint,
                instruction: 'In ONE short sentence, invite the user back to the pending question.'
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: `When you're ready: ${field.label} — ${field.hint}`
            });
            return `${discovery}\n\n${nudge}`;
          }

          // Single AI call: answer the interruption, then end with the pending
          // question exactly once (no duplicate questions).
          return composeMessage({
            purpose: 'quiz_pause_conversation',
            facts: {
              userMessage: messageText,
              quizFlow: quizState?.flow,
              workingMemory: buildConversationMemory({ quiz: quizState, pendingLabel: field?.label || null }),
              pendingQuestion: field ? { label: field.label, hint: field.hint } : null,
              instruction: field
                ? 'Answer the user conversationally and helpfully, then end with EXACTLY ONE short sentence asking the pending question. Ask nothing else. Do not claim anything was saved.'
                : 'Answer the user conversationally and helpfully. Do not claim anything was saved.'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: field
              ? `Happy to help.\n\nWhen you're ready: ${field.label} — ${field.hint}`
              : 'Happy to help — ask me anything about Saka Fleet.'
          });
        };

        let quizTurn = { handled: false };
        // v1.58.22 - a request/statement mid-draft is never an answer to the
        // pending question. Live 2026-11-04: "For parts entry, I should be able
        // to identify which part incurred the expense" was re-asked 7 times.
        const statementEscapeRe = /\b(?:should be able to|why can(?:no|'|’)?t i|why can i not|why do i (?:not|n'?t)|i want to be able to|not captured|add a feature|to be able to|i can(?:no|'|’)?t\s+(?:label|add|see|find|edit|change|get|set))\b/i;
        if (session.quiz && statementEscapeRe.test(messageText) && !pauseQuizForChat && !switchQuizFlow) {
          const parkedFlow = getFlowDefinition(session.quiz.flow, quizCtx)?.label || session.quiz.flow;
          abandonQuiz(session, { reason: 'statement_not_answer' });
          isSpecialFlowHandled = true;
          customReply = `Thanks — I've noted this: “${messageText.trim().slice(0, 180)}”\n\nI've parked your ${parkedFlow} draft so nothing is lost. Reply *Support* to pass this to our team (support@reports.sakafleet.com), or tell me what you'd like to do next.`;
        } else if (pauseQuizForChat) {
          isSpecialFlowHandled = true;
          customReply = await buildPausedQuizReply(activeQuiz);
        } else if (switchQuizFlow) {
          // The user explicitly asked for a different task mid-quiz. Discard the
          // current draft and start the requested flow (audit fix: "Set reminder"
          // must never be trapped inside the expense quiz).
          const previousLabel = getFlowDefinition(activeQuiz.flow, quizCtx)?.label || activeQuiz.flow;
          session.quiz = null;
          quizTurn = await handleQuizTurn({
            session,
            messageText,
            aiExtracted: mergedExt,
            startFlow: switchQuizFlow,
            ctx: quizCtx
          });

          if (quizTurn.handled) {
            const switchNote = await composeMessage({
              purpose: 'flow_switch',
              facts: {
                previousFlow: previousLabel,
                newFlow: switchQuizFlow,
                instruction: 'In ONE short sentence, tell the user the previous draft was discarded and the new task is starting.'
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: `Switched to ${switchQuizFlow}. Your previous draft was discarded.`
            });
            quizTurn.reply = `${switchNote}\n\n${quizTurn.reply}`;
          }
        } else if (logbookPrefill && !session.quiz && !hasVehicleRegistered) {
          // v1.51.11 — a logbook upload starts registration prefilled with the
          // fields read from the certificate, then confirms the rest.
          quizTurn = await handleQuizTurn({
            session,
            messageText: '',
            aiExtracted: {},
            startFlow: 'vehicle_registration',
            prefill: logbookPrefill,
            ctx: quizCtx
          });
        } else {
          quizTurn = narrativeSuppressQuiz
            ? { handled: false }
            : await handleQuizTurn({
                session,
                messageText,
                aiExtracted: narrativeExt,
                startFlow: forcedNarrativeFlow || receiptQuizStart,
                ctx: quizCtx
              });
        }
        // v1.32.3 — every handled quiz turn refreshes the inactivity clock, so an
        // abandoned draft expires within QUIZ_MAX_AGE_MINUTES (default 20) instead
        // of holding the conversation hostage for 45 minutes.
        if (session.quiz) markQuizTurn(session);
        if (logbookPrefill && quizTurn.handled && session.quiz?.flow === 'vehicle_registration') {
          const readParts = [
            logbookPrefill.plate_number ? `plate *${logbookPrefill.plate_number}*` : null,
            logbookPrefill.make_model || null,
            logbookPrefill.vin ? `VIN ${logbookPrefill.vin}` : null,
            logbookPrefill.fuel_type || null,
            logbookPrefill.yom ? `year ${logbookPrefill.yom}` : null
          ].filter(Boolean);
          if (readParts.length) {
            quizTurn.reply = `📄 I read these from your registration certificate: ${readParts.join(', ')}. Let me fill in the rest —\n\n${quizTurn.reply}`;
          }
        }

        if (quizTurn.pausedForChat) {
          isSpecialFlowHandled = true;
          customReply = await buildPausedQuizReply(session.quiz);
        } else if (quizTurn.handled) {
          isSpecialFlowHandled = true;
          const gateNotice = gateRedirect && !activeQuiz
            ? `🔒 *Finish your driver profile first*\n\nSaka needs to verify your email and your ${driverGate?.status?.catalog?.minimal?.label || 'driving licence'} so it can remind you before it expires. This protects you and the vehicle owner.\n\n`
            : '';
          customReply = `${gateNotice}${quizTurn.reply}`;

          if (quizTurn.flow === 'driver_onboarding' && quizTurn.completed) {
            session.driverOnboarding = false;
          }

          if (quizTurn.flow === 'vehicle_registration') {
            onboardingStore.delete(senderPhone);
            session.state = quizTurn.completed ? 'ACTIVE' : 'ONBOARDING';
            if (quizTurn.completed) session.onboardingStep = null;

            // v1.16.0 — EVERY owner immediately starts their own driver profile
            // at onboarding completion. The email is already verified, so this
            // is one short step (minimal compliance) and remains skippable.
            if (quizTurn.completed && supabaseClient) {
              try {
                await supabaseClient.from('profiles').update({
                  driver_profile_pending: true,
                  updated_at: new Date().toISOString()
                }).eq('id', profileData.id);
                const { data: freshProfile } = await supabaseClient
                  .from('profiles')
                  .select('*')
                  .eq('id', profileData.id)
                  .maybeSingle();
                const driverProfile = freshProfile || profileData;
                const driverIntro = await handleQuizTurn({
                  session,
                  messageText: '',
                  startFlow: 'driver_onboarding',
                  prefill: { driver_email: driverProfile.email || null },
                  ctx: {
                    ...quizCtx,
                    profile: driverProfile,
                    intent: 'DRIVER_PROFILE',
                    driverSelfProfile: true
                  }
                });
                if (driverIntro.handled) {
                  customReply = `${quizTurn.reply}\n\n👤 *One quick thing — your own driver profile*\n\n${driverIntro.reply}`;
                }
              } catch (driverErr) {
                console.warn('[Onboarding] Owner driver profile start skipped:', driverErr.message);
              }
            }

            // v1.28.0 — once-only contact-save nudge. Fires at the first real
            // milestone (vehicle registered + passbook issued), never mid-flow,
            // never for a frustrated/paused user, and stamped per profile.
            if (quizTurn.completed && shouldSuggestContactSave({
              profile: profileData,
              session,
              hasVehicle: true,
              hasQuiz: Boolean(session.quiz),
              isFrustrated: Boolean(session.circuitBreakerStage)
            })) {
              try {
                const contactFacts = buildContactSaveFacts({
                  plateNumber: activeQuiz?.answers?.plate_number || mergedExt?.plate_number || null,
                  name: profileData?.full_name
                });
                const contactLine = sanitizeSakaReply(
                  await composeMessage({
                    purpose: 'contact_save_nudge',
                    facts: contactFacts,
                    language: targetLang,
                    countryInfo,
                    profile: profileData,
                    fallbackText: contactFacts.fallbackLine
                  }),
                  contactFacts.fallbackLine,
                  { historyLength: conversationHistory.length }
                );
                customReply = `${customReply}\n\n${contactLine}`;
                session.contactSaveNudged = true;
                if (supabaseClient) markContactSaveSuggested(supabaseClient, profileData?.id).catch(() => {});
              } catch { /* the nudge is best-effort and never blocks registration */ }
            }
          }

          if (quizTurn.completed && quizTurn.flow === 'delete_account') {
            session.state = 'IDLE';
            session.active_vehicle_id = null;
            session.history = [];
          }
        }

        // --- BRANCH A: TWO-STAGE PROGRESSIVE ONBOARDING FLOW (legacy fallback) ---
        if (!isSpecialFlowHandled && (
          isCurrentlyOnboarding ||
          (!hasVehicleRegistered && (intent === 'REGISTER_VEHICLE' || intent === 'ONBOARDING_INPUT' || intent === 'VERIFY_OTP' || isRegisterCommand || hasVehicleAttributes))
        )) {
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
            onboardingStore.set(senderPhone, {
              stage: 1,
              step: 1,
              core: { plate_number: null, make_model: null, yom: null, owner_email: profileData?.email || null, fuel_type: null, current_mileage: null, vin: null, email_verified: false },
              optional: { engine_number: null, color: null, transmission: null, tire_size: null, insurance_policy: null, insurance_expiry: null, inspection_expiry: null, purchase_cost: null, custom_attributes: {} },
              registered_plate: null,
              token: null,
              role: 'Owner',
              plate_number: null,
              make_model: null
            });
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
            let obState = onboardingStore.get(senderPhone) || {
              stage: 1,
              step: 1,
              core: {
                plate_number: null,
                make_model: null,
                yom: null,
                owner_email: profileData?.email || null,
                fuel_type: null,
                current_mileage: null,
                vin: null,
                email_verified: false
              },
              optional: {
                engine_number: null,
                color: null,
                transmission: null,
                tire_size: null,
                insurance_policy: null,
                insurance_expiry: null,
                inspection_expiry: null,
                purchase_cost: null,
                custom_attributes: {}
              },
              registered_plate: null,
              token: null,
              role: 'Owner',
              plate_number: null,
              make_model: null
            };
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
        }

        // --- BRANCH B: ACTIVE USER FLOW (POST-ONBOARDING INPUT ROUTING - Fix 2) ---
        else if (hasVehicleRegistered || session.state === 'ACTIVE') {
          session.state = 'ACTIVE';

          const cleanTrimmed = messageText.trim();
          const numericMatch = cleanTrimmed.match(/^(1|1️⃣|2|2️⃣|3|3️⃣|4|4️⃣|5|5️⃣)$/);

          let activeIntent = intent;
          if (numericMatch) {
            const choice = numericMatch[1].replace('️⃣', '');
            if (choice === '1') activeIntent = 'LOG_EXPENSE';
            else if (choice === '2') activeIntent = 'UPDATE_MILEAGE';
            else if (choice === '3') activeIntent = 'SET_REMINDER';
            else if (choice === '4') activeIntent = 'LOG_EARNINGS';
            else if (choice === '5') activeIntent = 'REQUEST_REPORT';
          }

          if (activeIntent === 'REGISTER_VEHICLE') {
            const explicitRegPattern = /^\s*(register|onboard|add car|add vehicle|new vehicle)\b/i;
            if (!explicitRegPattern.test(messageText)) {
              if (/^(?:delete|remove|discard|scrap|decommission)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(messageText)) {
                activeIntent = 'DELETE_VEHICLE';
              } else if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(messageText) ||
                         /^(?:edit|update|change|modify)\s+(?:the\s+)?(?:make|model|year|yom|fuel|color|colour|transmission|engine|tire|tyre|insurance|inspection|plate)\b/i.test(messageText)) {
                activeIntent = 'EDIT_VEHICLE';
              } else if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:profile|details|name|language|units?|unit\s+system|settings|contact)\b/i.test(messageText)) {
                activeIntent = 'EDIT_PROFILE';
              } else if (/^(?:delete|deactivate|close|remove)\s+(?:my\s+)?account\b/i.test(messageText)) {
                activeIntent = 'DELETE_ACCOUNT';
              } else if (/\b(?:fuel\s+consumption|fuel\s+efficiency|km\/l|km\s*per\s*liter|consumption|mpg)\b/i.test(messageText)) {
                activeIntent = 'QUERY_FUEL_EFFICIENCY';
              } else if (/^(?:switch|manage|select)\s+/i.test(messageText)) {
                activeIntent = 'SWITCH_VEHICLE';
              } else if (/odometer|km|mileage/i.test(messageText)) {
                activeIntent = 'UPDATE_MILEAGE';
              } else if (/fuel|kes|usd|spent|cost|paid|expense|liters/i.test(messageText)) {
                activeIntent = 'LOG_EXPENSE';
              } else if (/earned|revenue|earnings|income|fare/i.test(messageText)) {
                activeIntent = 'LOG_EARNINGS';
              } else {
                activeIntent = 'GENERAL_CHAT';
              }
            } else {
              const capacity = await evaluateVehicleCapacity({
                supabase: supabaseClient,
                ownerId: profileData?.id,
                profile: profileData
              });
              if (!capacity.allowed) {
                const ownerPayload = {
                  id: profileData?.id,
                  phone_number: senderPhone,
                  email: profileData?.email
                };
                const interval = entitlements?.billingInterval || 'monthly';
                if (capacity.addonEligible) {
                  const addon = await checkoutForAddon({
                    supabase: supabaseClient,
                    owner: ownerPayload,
                    addonQuantity: Math.max(1, capacity.overBy),
                    interval,
                    currency: countryInfo?.currency || 'USD'
                  });
                  const addonPriceLabel = await formatUsdInLocalCurrency(supabaseClient, capacity.addonPriceUSD || 4.99, countryInfo?.currency || 'USD', countryInfo?.locale || 'en-US');
                  customReply = `⚠️ *Garage Full — Fleet Command Add-on Needed*\n\nYour Fleet Command plan includes *${capacity.capacity}* active vehicle slots (base ${entitlements?.baseLimit || 5} + add-ons).\n\nTo add this vehicle, activate *+${Math.max(1, capacity.overBy)} slot${Math.max(1, capacity.overBy) > 1 ? 's' : ''}* at *${addonPriceLabel}/month each*.\n\n👉 *Add-on Link:* ${await shortenUrl(supabaseClient, addon.ok ? addon.checkoutUrl : 'https://sakafleet.com/pricing')}\n\nOnce payment is confirmed, register the vehicle again.`;
                } else {
                  const nextTier = capacity.nextTierKey || 'fleet_command';
                  const upgrade = await checkoutForTier({
                    supabase: supabaseClient,
                    owner: ownerPayload,
                    targetTierKey: nextTier,
                    interval,
                    currency: countryInfo?.currency || 'USD'
                  });
                  customReply = `⚠️ *Vehicle Capacity Limit Reached*\n\nYour current plan (*${capacity.tierName}*) allows ${capacity.capacity} active vehicle(s).\n\nUpgrade to *${getTierLabel(nextTier)}* to add more vehicles.\n👉 *Upgrade Link:* ${await shortenUrl(supabaseClient, upgrade.ok ? upgrade.checkoutUrl : 'https://sakafleet.com/pricing')}\n\n💡 Reply *"subscription"* to review your plan.`;
                }
              } else {
                const initPlate = mergedExt.plate_number ? mergedExt.plate_number.toUpperCase().trim() : null;
                onboardingStore.set(senderPhone, {
                  stage: 1,
                  step: initPlate ? 2 : 1,
                  core: {
                    plate_number: initPlate,
                    make_model: null,
                    yom: null,
                    owner_email: profileData?.email || null,
                    fuel_type: null,
                    current_mileage: null,
                    vin: null,
                    email_verified: false
                  },
                  optional: {
                    engine_number: null,
                    color: null,
                    transmission: null,
                    tire_size: null,
                    insurance_policy: null,
                    insurance_expiry: null,
                    inspection_expiry: null,
                    purchase_cost: null,
                    custom_attributes: {}
                  },
                  registered_plate: null,
                  token: null,
                  role: 'Owner',
                  plate_number: initPlate,
                  make_model: null
                });
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
              }
            }
          }

          if (!isSpecialFlowHandled && session.state === 'ACTIVE') {
            // Resolve active or target vehicle
            let targetVeh = null;
            if (mergedExt.plate_number) {
              targetVeh = findVehicleByCandidate(existingVehicles, mergedExt.plate_number);
            }
            if (!targetVeh && mergedExt.target_vehicle) {
              targetVeh = findVehicleByCandidate(existingVehicles, mergedExt.target_vehicle);
            }
            if (!targetVeh) {
              targetVeh = getActiveVehicle({ senderPhone, vehicles: existingVehicles, chatSessions }) || existingVehicles[0];
            }

            // Owner vehicle-deletion confirmation gate (must run before other intents)
            if (session.pendingDeleteVehicle) {
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
                  customReply = await composeMessage({
                    purpose: 'flow_outcome_card',
                    facts: { cardText: deletedCardText, instruction: 'Re-render this engine card conversationally: keep EVERY figure, label, emoji anchor and next step exactly as written. Never drop or invent a figure.' },
                    language: targetLang,
                    countryInfo,
                    profile: profileData,
                    fallbackText: deletedCardText
                  });
                } else {
                  customReply = `❌ *Vehicle Deletion Failed*\n\n${deletionResult.error}`;
                }
              } else if (/^(cancel|exit|stop|no|abort)$/i.test(cleanConfirmation)) {
                session.pendingDeleteVehicle = null;
                customReply = `Deletion cancelled. *${pendingDeletion.plateNumber}* remains in your fleet.`;
              } else {
                customReply = `⚠️ Please reply *YES* to confirm deletion of *${pendingDeletion.plateNumber}*, or *Cancel* to abort.`;
              }
            }
            else if (activeIntent === 'ASSIGN_DRIVER' || session.pendingDriverAssignment || /^(?:assign\s+driver|assign)\b/i.test(messageText)) {
              let assignTarget = targetVeh;
              if (mergedExt.plate_number) {
                const found = findVehicleByCandidate(existingVehicles, mergedExt.plate_number);
                if (found) assignTarget = found;
              } else if (session.pendingDriverAssignment) {
                const found = existingVehicles.find(v => v.id === session.pendingDriverAssignment.vehicleId);
                if (found) assignTarget = found;
              }

              if (!assignTarget) {
                customReply = await composeMessage({
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
                  customReply = `🚗 *Assign Driver to Vehicle*\n\n• Target Vehicle: *${assignTarget.plate_number}*\n\nPlease reply with the driver's WhatsApp phone number (e.g. *+254712345678*).\n\n_(Reply 'cancel' to abort)_`;
                } else {
                  session.pendingDriverAssignment = null;
                  const created = await createDriverAssignment({
                    supabase: supabaseClient,
                    ownerProfile: profileData,
                    vehicle: assignTarget,
                    driverPhone,
                    handoverOdometer: Number(mergedExt.odometer || mergedExt.current_mileage || assignTarget.current_mileage || assignTarget.odometer_reading || 0) || null,
                    countryInfo,
                    sendWhatsApp: sendWhatsAppReply
                  });

                  if (!created.ok) {
                    customReply = `❌ *Driver Assignment Blocked*\n\n${created.error}`;
                  } else {
                    session.pendingAssignmentOtp = {
                      assignmentId: created.assignment.id,
                      vehicleId: created.assignment.vehicle_id,
                      driverPhone: created.driverPhone,
                      expiresAt: created.expiresAt
                    };
                    customReply = `🔐 *Verify Driver Assignment*\n\nWe emailed a 6-digit code to *${created.ownerEmail}*. Reply with the code to assign *${created.driverPhone}* to *${assignTarget.plate_number}*.\n\n_(Reply *Resend* for a new code or *Cancel* to abort.)_`;
                  }
                }
              }
            }
            else if (activeIntent === 'UNASSIGN_DRIVER' || /^unassign\s+driver/i.test(messageText.trim()) || /^remove\s+driver/i.test(messageText.trim())) {
              let unassignTarget = targetVeh;
              if (mergedExt.plate_number) {
                const found = findVehicleByCandidate(existingVehicles, mergedExt.plate_number);
                if (found) unassignTarget = found;
              }

              if (!unassignTarget) {
                customReply = await composeMessage({
                  purpose: 'unassign_driver_notice',
                  facts: { issue: 'The vehicle for the driver unassignment could not be identified' },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: '⚠️ Could not identify the vehicle to unassign the driver from.'
                });
              } else {
                await unassignDriverFromVehicle({ vehicleId: unassignTarget.id, supabase: supabaseClient });
                customReply = `✅ Driver unassigned from vehicle *${unassignTarget.plate_number}*. Vehicle is now available for a new driver.`;
              }
            }
            else if (activeIntent === 'VIEW_PROFILE' || /^(?:view|show|display|see)\s+(?:my\s+)?(?:profile|account)|^my\s+profile\b|^profile\s+details$|^profile$|^account\s+details$|^who\s+am\s+i$/i.test(messageText.trim())) {
              const roles = buildRoleContext(profileData, existingVehicles, senderPhone).roles;
              const assigned = existingVehicles.find((v) => v.assigned_driver_id === profileData?.id) || null;
              let complianceLine = null;
              if (assigned && supabaseClient) {
                try {
                  const st = await getDriverComplianceStatus({
                    supabase: supabaseClient,
                    driverId: profileData.id,
                    countryCode: countryInfo?.country_code,
                    assetType: assigned.asset_type || assigned.metadata?.asset_type || null
                  });
                  const min = st.minimal;
                  complianceLine = `${min.label}: ${min.status}${min.lifetime ? ' (valid for life)' : min.expiry ? ` (expires ${min.expiry})` : ''}`;
                } catch {
                  complianceLine = null;
                }
              }
              const facts = {
                name: profileData?.full_name || 'Not set',
                phone: formattedPhone,
                email: profileData?.email || 'Not set',
                emailVerified: Boolean(profileData?.email_verified),
                language: targetLang,
                unitSystem: profileData?.unit_system || countryInfo?.default_units || 'metric',
                timezone: resolveUserTimezone({ countryInfo, profile: profileData }),
                country: countryInfo?.country,
                roles,
                subscriptionTier: profileData?.subscription_tier || 'free',
                compliance: complianceLine,
                instruction: 'Present a compact read-only profile snapshot. Do not start an edit flow or ask for new values.'
              };
              const fallback = `👤 *Your Profile*\n\n` +
                `• Name: ${facts.name}\n` +
                `• Phone: ${facts.phone}\n` +
                `• Email: ${facts.email} (${facts.emailVerified ? 'verified ✅' : 'not verified ⚠️'})\n` +
                `• Language: ${facts.language}\n` +
                `• Units: ${facts.unitSystem}\n` +
                `• Timezone: ${facts.timezone}` +
                (complianceLine ? `\n• ${complianceLine}` : '') +
                `\n\nTo change something, say e.g. *"update my language to Swahili"*.`;
              isSpecialFlowHandled = true;
              customReply = await composeMessage({
                purpose: 'profile_overview',
                facts,
                language: targetLang,
                countryInfo,
                profile: profileData,
                fallbackText: fallback
              });
            }
            else if (activeIntent === 'EDIT_VEHICLE' || /^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(messageText.trim())) {
              const editTarget = mergedExt.plate_number
                ? (findVehicleByCandidate(existingVehicles, mergedExt.plate_number) || targetVeh)
                : targetVeh;

              if (!editTarget) {
                customReply = await composeMessage({
                  purpose: 'vehicle_not_found_notice',
                  facts: { issue: 'No matching vehicle found in the registered fleet' },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: '⚠️ I could not find that vehicle in your registered fleet.'
                });
              } else {
                const fieldAliasMap = {
                  make: 'make_model', model: 'make_model', make_model: 'make_model', make_and_model: 'make_model',
                  year: 'yom', yom: 'yom',
                  fuel: 'fuel_type', fuel_type: 'fuel_type',
                  color: 'color', colour: 'color',
                  transmission: 'transmission',
                  engine: 'engine_number', engine_number: 'engine_number',
                  tire: 'tire_size', tyre: 'tire_size', tire_size: 'tire_size',
                  insurance: 'insurance_expiry', insurance_expiry: 'insurance_expiry',
                  inspection: 'inspection_expiry', inspection_expiry: 'inspection_expiry',
                  plate: 'plate_number', plate_number: 'plate_number',
                  mileage: 'current_mileage', odometer: 'current_mileage', current_mileage: 'current_mileage',
                  email: 'owner_email', owner_email: 'owner_email',
                  phone: 'owner_phone', owner_phone: 'owner_phone',
                  vin: 'vin'
                };

                const candidateUpdates = {};
                // Note: plate_number is excluded from auto-merge so that mentioning
                // the target plate never accidentally renames the vehicle.
                const attrKeys = ['make_model', 'yom', 'year_of_manufacture', 'fuel_type', 'current_mileage', 'color', 'transmission', 'engine_number', 'tire_size', 'insurance_expiry', 'insurance_policy', 'inspection_expiry', 'purchase_cost', 'custom_attributes', 'owner_email', 'owner_phone'];
                for (const key of attrKeys) {
                  const value = mergedExt[key];
                  if (value !== undefined && value !== null && value !== '') candidateUpdates[key] = value;
                }

                // Flexible "<field> to <value>" parser (tolerates plates/digits in the middle).
                const explicitFieldMatch = messageText.match(/\b(make(?:\s*(?:&|and|\/)\s*model)?|model|year|yom|fuel(?:\s*type)?|mileage|odometer|color|colour|transmission|engine(?:\s*number)?|tire|tyre|insurance(?:\s*expiry)?|inspection(?:\s*expiry)?|plate(?:\s*number)?|email|owner\s*email|phone|owner\s*phone)\b\s*(?:to|as|=)\s*(.+)$/i);
                if (explicitFieldMatch) {
                  const rawFieldName = explicitFieldMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                  const rawFieldValue = explicitFieldMatch[2].trim().replace(/^["']|["']$/g, '');
                  const mappedField = fieldAliasMap[rawFieldName] || rawFieldName;
                  const numericFields = ['current_mileage', 'odometer_reading', 'yom', 'year_of_manufacture', 'purchase_cost'];
                  if (numericFields.includes(mappedField)) {
                    const numericValue = Number(rawFieldValue.replace(/[^\d.]/g, ''));
                    if (!Number.isNaN(numericValue)) candidateUpdates[mappedField] = numericValue;
                  } else {
                    candidateUpdates[mappedField] = rawFieldValue;
                  }
                }

                // Honour explicit field/value pairs supplied by the AI classifier.
                if (mergedExt.edit_field && mergedExt.edit_value) {
                  const aiField = String(mergedExt.edit_field).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                  candidateUpdates[fieldAliasMap[aiField] || aiField] = mergedExt.edit_value;
                }

                // VIN is immutable — always reject an attempted VIN change.
                if (mergedExt.vin || candidateUpdates.vin) {
                  delete candidateUpdates.vin;
                  customReply = await composeMessage({
                    purpose: 'vin_lock_notice',
                    facts: { invariant: 'The VIN / chassis number is permanently tied to the passbook and can never be edited; all other vehicle details can still be updated.' },
                    language: targetLang,
                    countryInfo,
                    profile: profileData,
                    fallbackText: `🔒 *VIN Is Permanently Locked*\n\nYour VIN / chassis number is permanently tied to your passbook and can never be edited. All other vehicle details can still be updated.`
                  });
                } else if (Object.keys(candidateUpdates).length === 0) {
                  const currentList = `• Plate: ${editTarget.plate_number}\n• Make/Model: ${editTarget.make_model || '-'}\n• Year: ${editTarget.yom || editTarget.year_of_manufacture || '-'}\n• Fuel: ${editTarget.fuel_type || '-'}\n• Odometer: ${(editTarget.current_mileage || editTarget.odometer_reading || 0).toLocaleString()} km\n• VIN: ${editTarget.vin || '-'} 🔒`;
                  customReply = `🛠️ *Edit Vehicle — ${editTarget.plate_number}*\n\n${currentList}\n\nReply with the change, e.g. *"update vehicle ${editTarget.plate_number} color to White"* or *"change fuel for ${editTarget.plate_number} to Diesel"*.\n\n🔒 *Note:* The VIN is permanently immutable.`;
                } else {
                  const editRes = await updateVehicleDetails({
                    vehicleId: editTarget.id,
                    requesterId: profileData?.id,
                    updates: candidateUpdates,
                    supabase: supabaseClient
                  });

                  if (!editRes.success) {
                    customReply = `❌ *Vehicle Update Failed*\n\n${editRes.error}`;
                  } else {
                    const appliedLines = Object.entries(editRes.applied || {})
                      .filter(([k]) => k !== 'updated_at')
                      .map(([k, v]) => `• *${k}:* ${v}`)
                      .join('\n');
                    customReply = `✅ *Vehicle Details Updated!* 🚗\n\n• *Vehicle:* *${editRes.vehicle?.plate_number || editTarget.plate_number}*\n${appliedLines ? appliedLines + '\n' : ''}${editRes.rejected?.length ? '\n🔒 VIN / passbook token remain permanently locked and unchanged.' : ''}`;
                  }
                }
              }
            }
            else if (activeIntent === 'DELETE_VEHICLE' || /^(?:delete|remove|discard|scrap|decommission)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(messageText.trim())) {
              const deleteTarget = mergedExt.plate_number
                ? (findVehicleByCandidate(existingVehicles, mergedExt.plate_number) || targetVeh)
                : targetVeh;

              if (!deleteTarget) {
                customReply = await composeMessage({
                    purpose: 'vehicle_not_found_notice',
                    facts: { issue: 'The vehicle to delete could not be identified', example: 'delete vehicle KDA 123A' },
                    language: targetLang,
                    countryInfo,
                    profile: profileData,
                    fallbackText: `⚠️ I could not identify the vehicle to delete. Please reply with the plate number, e.g. *"delete vehicle KDA 123A"*.`
                  });
              } else if (deleteTarget.owner_id !== profileData?.id) {
                customReply = `🔒 *Owner Authorization Required*\n\nOnly the registered owner of *${deleteTarget.plate_number}* can delete this vehicle.`;
              } else {
                session.pendingDeleteVehicle = { vehicleId: deleteTarget.id, plateNumber: deleteTarget.plate_number };
                customReply = `⚠️ *Confirm Vehicle Deletion*\n\nYou are about to delete *${deleteTarget.plate_number}* (${deleteTarget.make_model || 'Vehicle'}) from your active fleet.\n\n• Assigned driver will be unassigned\n• Pending passbook transfers will be cancelled\n• Historical expense / earnings / reminder logs will be preserved for audit\n• The VIN trial ledger entry is permanent and cannot be removed\n\nReply *YES* to confirm, or *Cancel* to abort.`;
              }
            }
            else if (activeIntent === 'SWITCH_VEHICLE') {
              const candidate = mergedExt.target_vehicle || mergedExt.plate_number || messageText.replace(/^(?:switch(?:\s+to)?|manage|select)\s+(?:car|vehicle)?\s*/i, '').trim();
              const found = findVehicleByCandidate(existingVehicles, candidate);
              if (found) {
                setActiveVehicle({ senderPhone, vehicleId: found.id, chatSessions });
                targetVeh = found;
                const switchCardText = `🔄 *Switched Active Vehicle!*\n\n` +
                  `Now managing: *${found.plate_number}* (${found.make_model || 'Vehicle'})\n` +
                  `• Fuel Type: ${found.fuel_type || 'Fuel'}\n` +
                  `• Current Odometer: ${(found.current_mileage || found.odometer_reading || 0).toLocaleString()} ${found.unit_system === 'imperial' ? 'mi' : 'km'}\n\n` +
                  `All subsequent fuel logs, mileage updates, and queries will automatically apply to this vehicle.`;
                customReply = await composeMessage({
                  purpose: 'flow_outcome_card',
                  facts: { cardText: switchCardText, instruction: 'Re-render this engine card conversationally: keep EVERY figure, label, emoji anchor and next step exactly as written. Never drop or invent a figure.' },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: switchCardText
                });
              } else {
                const vList = existingVehicles.map((v, i) => `${i + 1}️⃣ *${v.plate_number}* (${v.make_model || 'Vehicle'})`).join('\n');
                const generic = !candidate || /^(?:car|vehicle|truck|asset|one|another|other)$/i.test(String(candidate).trim());
                customReply = generic
                  ? `🔄 *Which vehicle should be active?*\n\n${vList}\n\nReply with a number or plate (e.g. *"switch to 1"*).`
                  : `⚠️ Could not find "${candidate}" in your fleet.\n\nYour registered vehicles:\n${vList}\n\nReply with a number or plate (e.g. *"switch to 1"* or *"switch to ${existingVehicles[0]?.plate_number}"*) to select.`;
              }
            }
            else if (activeIntent === 'QUERY_FUEL_EFFICIENCY') {
              const fuelAnalysis = await calculateFuelConsumption({
                supabase: supabaseClient,
                vehicleId: targetVeh?.id,
                plateNumber: mergedExt.plate_number || targetVeh?.plate_number,
                targetUnit: targetVeh?.unit_system || countryInfo.default_units,
                currency: countryInfo?.currency || null
              });

              if (fuelAnalysis && fuelAnalysis.explanation) {
                customReply = fuelAnalysis.explanation;
                if (existingVehicles.length > 1) {
                  customReply += `\n\n📌 *(Vehicle: ${targetVeh.plate_number}. Type "switch to [plate]" to analyze another)*`;
                }
              } else {
                customReply = `Could not calculate fuel consumption for ${targetVeh?.plate_number || 'vehicle'}.`;
              }
            }
            else if (activeIntent === 'QUERY_FLEET_SUMMARY') {
              const fleetReport = await buildFleetReport({
                supabase: supabaseClient,
                type: 'fleet',
                ownerId: existingVehicles.some((v) => v.owner_id === profileData?.id) ? profileData?.id : null,
                driverId: existingVehicles.some((v) => v.assigned_driver_id === profileData?.id) ? profileData?.id : null,
                countryInfo,
                profile: profileData
              });
              customReply = fleetReport?.ok && fleetReport.text
                ? fleetReport.text
                : `Could not retrieve the fleet summary right now.`;
            }
            else if (activeIntent === 'GREETING') {
              customReply = aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant') && !isLegacyWelcomeCopy(aiResult.reply_message)
                ? aiResult.reply_message
                : await composeMessage({
                    purpose: 'greeting',
                    facts: {
                      activeVehicle: targetVeh?.plate_number || null,
                      makeModel: targetVeh?.make_model || null,
                      fleetSize: existingVehicles.length,
                      nextSteps: ['log expense/fuel', 'update odometer', 'set a reminder', 'log earnings', 'view summary']
                    },
                    language: targetLang,
                    countryInfo,
                    profile: profileData,
                    fallbackText: `👋 ${targetVeh?.plate_number || 'Fleet'} — what would you like to do today?`
                  });
            }
            else if (activeIntent === 'LOG_EXPENSE') {
              const extAmount = mergedExt.amount || extractNumberFromText(messageText);
              const extLiters = mergedExt.fuel_liters || mergedExt.liters || null;
              const extOdo = mergedExt.odometer || mergedExt.current_mileage || extractOdometerFromText(messageText);
              // v1.30.0 — canonicalise the expense type from the catalog so a
              // one-liner like "repaired a puncture... front tyre" lands in Tyres.
              const expType = normalizeExpenseType(
                mergedExt.expense_type
                || (hasExpenseTypeMarker(messageText) ? resolveExpenseType(messageText) : null)
              );
              const extFillType = normalizeFillType(mergedExt.fill_type) || normalizeFillType(messageText);

              if ((extAmount && extAmount > 0) || (extLiters && extLiters > 0)) {
                // v1.32.1 — write-time duplicate guard: the same expense (plate +
                // amount + type + Nairobi day, within 3 h) is never written twice,
                // even when a receipt is uploaded repeatedly. A different odometer
                // reading proves a separate fill and passes through.
                const duplicateExpense = (supabaseClient && targetVeh && extAmount && extAmount > 0)
                  ? await isDuplicateExpense(supabaseClient, {
                    plate: targetVeh.plate_number,
                    amount: extAmount,
                    expenseType: expType,
                    odometer: extOdo || null,
                    windowHours: Number(process.env.OCR_EXPENSE_DEDUPE_HOURS || 3)
                  })
                  : { duplicate: false };
                if (duplicateExpense.duplicate) {
                  customReply = `⚠️ *Already logged* — I found *${countryInfo.currency} ${Number(extAmount).toLocaleString()}* (${expType}) for *${targetVeh.plate_number}* in the last few hours, so I did *not* save a duplicate. ✅\n\nIf this is a genuinely separate fill, send the new odometer reading (e.g. *"Logged ${extLiters || ''}L at 367,500 km"*) and I will log it.`;
                } else if (supabaseClient && targetVeh) {
                  // v1.58.6 — never claim "Saved" without a VERIFIED write (live
                  // 2026-11-04: a one-line fuel log rendered "Saved ✅" while the
                  // expense_logs row was never persisted; the old code also showed
                  // success for a duplicate or when no client was present).
                  const quickExpenseLabel = sanitizeEntryLabel(mergedExt.label || extractEntryLabel(messageText));
                  const quickExpenseRow = {
                    vehicle_id: targetVeh.id,
                    driver_id: profileData?.id,
                    expense_type: expType,
                    amount: extAmount || 0,
                    fuel_liters: extLiters || 0,
                    fill_type: extFillType,
                    odometer_reading: extOdo || null,
                    notes: messageText.trim(),
                    // v1.59.0 — optional searchable label ("label: karen", "#karen").
                    label: quickExpenseLabel || null
                  };
                  let { error: quickLogErr } = await supabaseClient.from('expense_logs').insert([quickExpenseRow]);
                  if (quickLogErr && /label/i.test(quickLogErr.message || '')) {
                    // Rule 50 — an un-migrated optional column never blocks a save.
                    const { label, ...legacyQuickRow } = quickExpenseRow;
                    ({ error: quickLogErr } = await supabaseClient.from('expense_logs').insert([legacyQuickRow]));
                  }
                  if (quickLogErr) {
                    customReply = `⚠️ I could not save that expense just now — *nothing was written*. Please try again in a moment, or send it as *"amount type"* (e.g. *"1000 fuel"*).`;
                  } else {
                    await supabaseClient.from('expenses').insert([{
                      plate: targetVeh.plate_number,
                      expense_type: expType,
                      amount: extAmount || 0,
                      liters: extLiters || 0,
                      odometer_reading: extOdo || null
                    }]).select().maybeSingle();

                    if (extOdo && extOdo > (targetVeh.current_mileage || 0)) {
                      await supabaseClient.from('vehicles').update({
                        current_mileage: extOdo,
                        odometer_reading: extOdo,
                        updated_at: new Date().toISOString()
                      }).eq('id', targetVeh.id);
                      targetVeh.current_mileage = extOdo;
                    }
                    // v1.63.1 — the quick-log expense changed the ledger facts.
                    markUserDataChanged({ supabase: supabaseClient, phone: senderPhone, ownerId: profileData?.id, reason: 'whatsapp.quickLogExpense' });
                    const expenseCardText = `⛽ *Expense Logged Successfully!* 📝\n\n` +
                      `• *Vehicle:* *${targetVeh.plate_number}* (${targetVeh.make_model || 'Vehicle'})\n` +
                      `• *Category:* ${expType}\n` +
                      (extAmount ? `• *Amount:* ${countryInfo.currency} ${Number(extAmount).toLocaleString()}\n` : '') +
                      (extLiters ? `• *Volume:* ${extLiters} Liters\n` : '') +
                      (extFillType ? `• *Fill:* ${extFillType === 'full' ? 'Full tank' : 'Top-up'}\n` : '') +
                      (extOdo ? `• *Odometer:* ${Number(extOdo).toLocaleString()} km\n` : '') +
                      `\n✅ Saved to database under *${targetVeh.plate_number}*.` +
                      (expType.toLowerCase().includes('fuel') && !extFillType
                        ? `\n\n💡 *Tip:* say *"full tank"* or *"top-up"* with your next fuel log so I can measure exact fuel economy.`
                        : '');
                    customReply = await composeMessage({
                      purpose: 'flow_outcome_card',
                      facts: { cardText: expenseCardText, instruction: 'Re-render this engine card conversationally: keep EVERY figure, label, emoji anchor and next step exactly as written. Never drop or invent a figure.' },
                      language: targetLang,
                      countryInfo,
                      profile: profileData,
                      fallbackText: expenseCardText
                    });
                    if (existingVehicles.length > 1) {
                      customReply += `\n*(Active vehicle: ${targetVeh.plate_number}. Type "switch to [car]" to change)*`;
                    }
                  }
                } else {
                  customReply = `⛽ I can't save that right now — please try again in a moment.`;
                }
              } else {
                customReply = `⛽ *Log Expense / Fuel for ${targetVeh.plate_number}*\n\nPlease reply with expense details. For example:\n• *"Logged 45L fuel at 368000 km for KES 8500"*\n• *"Oil change KES 5000"*`;
              }
            }
            else if (activeIntent === 'UPDATE_MILEAGE') {
              const extOdometer = mergedExt.odometer || mergedExt.current_mileage || extractOdometerFromText(messageText);
              if (extOdometer && extOdometer > 0) {
                const inputUnit = targetVeh?.unit_system === 'imperial' ? 'mi' : 'km';
                let odometerSaveError = null;
                if (supabaseClient && targetVeh) {
                  const recorded = await applyOdometerReading({
                    supabase: supabaseClient,
                    vehicle: targetVeh,
                    reading: extOdometer,
                    inputUnit,
                    sendFn: (phone, text) => sendWhatsAppReply(phone, text),
                    canDeliver: (phone) => String(phone || '').replace(/[^\d]/g, '') !== String(senderPhone || '').replace(/[^\d]/g, '')
                  });
                  if (recorded?.ok === false) odometerSaveError = recorded.error;
                  if (recorded?.canonicalKm) targetVeh.current_mileage = recorded.canonicalKm;
                }
                if (supabaseClient && targetVeh && !odometerSaveError) {
                  // v1.63.1 — the odometer update changed the asset facts.
                  markUserDataChanged({ supabase: supabaseClient, phone: senderPhone, ownerId: profileData?.id, reason: 'whatsapp.quickLogMileage' });
                }
                if (odometerSaveError) {
                  customReply = `⚠️ Could not update the odometer for *${targetVeh.plate_number}*: ${odometerSaveError}`;
                } else {
                  customReply = `📈 *Odometer Updated!* 🚗

` +
                    `• *Vehicle:* *${targetVeh.plate_number}* (${targetVeh.make_model || 'Vehicle'})
` +
                    `• *New Odometer:* ${Number(extOdometer).toLocaleString()} ${inputUnit}

` +
                    `✅ Saved to database under *${targetVeh.plate_number}*!`;
                  if (existingVehicles.length > 1) {
                    customReply += `
*(Active vehicle: ${targetVeh.plate_number})*`;
                  }
                }
              } else {
                customReply = `📈 *Update Mileage / Odometer*

Please reply with your updated odometer reading (e.g. *"Odometer 45000 km"*).`;
              }
            }
            else if (activeIntent === 'LOG_OPERATING_HOURS') {
              const extHours = mergedExt.operating_hours !== undefined && mergedExt.operating_hours !== null
                ? Number(mergedExt.operating_hours)
                : extractNumberFromText(messageText);
              if (supabaseClient && targetVeh && extHours !== null && Number.isFinite(extHours) && extHours >= 0) {
                const recorded = await applyOperatingHours({
                  supabase: supabaseClient,
                  vehicle: targetVeh,
                  hours: extHours,
                  sendFn: (phone, text) => sendWhatsAppReply(phone, text),
                  canDeliver: (phone) => String(phone || '').replace(/[^\d]/g, '') !== String(senderPhone || '').replace(/[^\d]/g, '')
                });
                if (recorded.ok) {
                  // v1.63.1 — the hour-meter update changed the asset facts.
                  markUserDataChanged({ supabase: supabaseClient, phone: senderPhone, ownerId: profileData?.id, reason: 'whatsapp.quickLogHours' });
                }
                if (!recorded.ok) {
                  customReply = `⚠️ Could not update operating hours for *${targetVeh.plate_number}*: ${recorded.error}`;
                } else {
                  targetVeh.operating_hours = extHours;
                  customReply = `⏱️ *Operating Hours Updated!*

` +
                    `• *Vehicle:* *${targetVeh.plate_number}* (${targetVeh.make_model || 'Vehicle'})
` +
                    `• *New Hour Meter:* ${Number(extHours).toLocaleString()} operating hours

` +
                    `✅ Saved to database under *${targetVeh.plate_number}*!`;
                  if (existingVehicles.length > 1) {
                    customReply += `
*(Active vehicle: ${targetVeh.plate_number})*`;
                  }
                }
              } else {
                customReply = `⏱️ *Log Operating Hours*

Please reply with the current hour-meter reading (e.g. *"1250 engine hours"*).`;
              }
            }
            else if (activeIntent === 'LOG_EARNINGS') {
              const extAmount = mergedExt.amount || extractNumberFromText(messageText);
              const earnType = mergedExt.earning_type
                ? normalizeEarningType(mergedExt.earning_type)
                : (hasEarningTypeMarker(messageText) ? resolveEarningType(messageText) : null);
              if (extAmount && extAmount > 0) {
                let earningSaveError = null;
                const quickEarningLabel = sanitizeEntryLabel(mergedExt.label || extractEntryLabel(messageText));
                if (supabaseClient && targetVeh) {
                  // v1.58.8 — verify the write before claiming "Recorded" (same
                  // assurance as the expense path).
                  const quickEarningRow = {
                    vehicle_id: targetVeh.id,
                    revenue_amount: extAmount,
                    currency: countryInfo.currency,
                    earning_type: earnType,
                    // v1.59.0 — optional searchable label.
                    label: quickEarningLabel || null,
                    logged_at: new Date().toISOString()
                  };
                  let { error: earnErr } = await supabaseClient.from('private_earnings').insert([quickEarningRow]);
                  if (earnErr && /label/i.test(earnErr.message || '')) {
                    const { label, ...legacyEarningRow } = quickEarningRow;
                    ({ error: earnErr } = await supabaseClient.from('private_earnings').insert([legacyEarningRow]));
                  }
                  if (earnErr) earningSaveError = earnErr.message;
                } else {
                  earningSaveError = 'no vehicle or database';
                }
                if (!earningSaveError) {
                  // v1.63.1 — the quick-log earning changed the ledger facts.
                  markUserDataChanged({ supabase: supabaseClient, phone: senderPhone, ownerId: profileData?.id, reason: 'whatsapp.quickLogEarning' });
                }
                if (earningSaveError) {
                  customReply = `⚠️ I could not save that earning just now — *nothing was written*. Please try again in a moment.`;
                } else {
                  customReply = `💰 *Earnings Logged!* 🎉\n\n• *Vehicle:* *${targetVeh.plate_number}*\n• *Revenue:* ${countryInfo.currency} ${Number(extAmount).toLocaleString()}${earnType ? `\n• *Type:* ${earnType}` : ''}${quickEarningLabel ? `\n• *Label:* #${quickEarningLabel}` : ''}\n\n✅ Recorded under *${targetVeh.plate_number}*!`;
                  if (existingVehicles.length > 1) {
                    customReply += `\n*(Active vehicle: ${targetVeh.plate_number})*`;
                  }
                }
              } else {
                customReply = await composeMessage({
                  purpose: 'quiz_intro_prompt',
                  facts: { flow: 'Log earnings', example: 'Earned KES 5000 today' },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: `💰 *Log Earnings*\n\nPlease reply with your revenue details (e.g. *"Earned KES 5000 today"*).`
                });
              }
            }
            else if (activeIntent === 'SET_REMINDER') {
              customReply = `🔔 *Set Reminder for ${targetVeh.plate_number}*\n\nReply with the item and its date, distance or operating hours. Examples:\n• *"Insurance expires on 15th Dec 2026"*, *"Inspection due next month"*, *"License renewal in 14 days"*\n• *"Road license expires 2027-03-31"* or *"Permit due in 30 days"*\n• *"Oil change in 5000 km"*, *"Brake pads in 3000 miles"* or *"Spare part change in 36 operating hours"*`;
            }
            else if (activeIntent === 'REQUEST_REPORT') {
              const quota = await getReportQuota({
                supabase: supabaseClient,
                ownerId: profileData?.id,
                profile: profileData
              });
              if (!quota.canGenerate) {
                const upgrade = await checkoutForTier({
                  supabase: supabaseClient,
                  owner: {
                    id: profileData?.id,
                    phone_number: senderPhone,
                    email: profileData?.email
                  },
                  targetTierKey: entitlements?.nextTierKey || 'solo_pro',
                  interval: entitlements?.billingInterval || 'annual',
                  currency: countryInfo?.currency || 'USD'
                });
                customReply = `📊 *Monthly Report Limit Reached*\n\nThe Free plan includes *${quota.limit} report per month* and you have used it (resets monthly).\n\nUnlock unlimited reports, full AI and compliance tracking with *${getTierLabel(entitlements?.nextTierKey || 'solo_pro')}*:\n👉 ${await shortenUrl(supabaseClient, upgrade.ok ? upgrade.checkoutUrl : 'https://sakafleet.com/pricing')}\n\n💡 Annual billing saves *${getAnnualDiscountPercent(entitlements?.nextTierKey || 'solo_pro')}%* — reply *"upgrade annual"* to see it.`;
              } else {
              const reportType = resolveAnyReportType(mergedExt.report_type || messageText, 'fleet');
              const metricIds = resolveMetricIds(messageText);
              const dateRange = /last\s*(?:3|three)\s*months?/i.test(messageText)
                ? 'last_3_months'
                : /(this\s*year|yearly|annual|year\s*review)/i.test(messageText) ? 'this_year' : 'this_month';
              // v1.16.0 — slow-report lane: ACK instantly (zero AI tokens),
              // build in the background, deliver the result as a follow-up while
              // the user keeps chatting.
              const queued = (reportType === 'custom' && metricIds.length === 0) ? false : await enqueueFollowUp({
                supabase: supabaseClient,
                phone: senderPhone,
                kind: FOLLOWUP_KINDS.FLEET_REPORT,
                payload: {
                  ownerId: existingVehicles.some((v) => v.owner_id === profileData?.id) ? profileData?.id : null,
                  driverId: existingVehicles.some((v) => v.assigned_driver_id === profileData?.id) ? profileData?.id : null,
                  profileId: profileData?.id || null,
                  reportType,
                  metricIds,
                  range: dateRange,
                  roles: profileData?.roles || [],
                  plate: targetVeh?.plate_number || null,
                  countryCode: countryInfo?.country_code || null,
                  locale: countryInfo?.locale || 'en-US',
                  currency: countryInfo?.currency || 'USD',
                  country: countryInfo?.country || null,
                  language: targetLang,
                  unitSystem: profileData?.unit_system || 'metric',
                  timeZone: resolveUserTimezone({ countryInfo, profile: profileData }),
                  phone: senderPhone,
                  email: profileData?.email || null
                }
              });
              if (queued) {
                customReply = followUpAckText(reportType);
              } else if (reportType === 'custom' && metricIds.length === 0) {
                const access = resolveReportAccess({
                  reportType: 'custom',
                  profile: profileData,
                  vehicles: existingVehicles,
                  roles: profileData?.roles || []
                });
                customReply = `📊 *Bespoke report — pick your metrics*\n\nAvailable: ${customMetricMenu(access)}\n\n` +
                  'Reply, for example:\n_"custom report: fuel economy, total spend and distance for last 3 months"_\n\n' +
                  'You can also ask for "fuel economy report", "driver daybook", "vehicle health" or "compliance card".';
              } else {
                const laneReport = await buildReportForLane({
                  supabase: supabaseClient,
                  reportType,
                  ownerId: existingVehicles.some((v) => v.owner_id === profileData?.id) ? profileData?.id : null,
                  driverId: existingVehicles.some((v) => v.assigned_driver_id === profileData?.id) ? profileData?.id : null,
                  plate: targetVeh?.plate_number || null,
                  profile: profileData,
                  countryInfo,
                  metricIds,
                  range: dateRange
                });
                customReply = laneReport.ok
                  ? laneReport.text
                  : (laneReport.text || `📊 *Fleet Reports & Summary*\n\nYou have ${existingVehicles.length} active vehicle(s).\n\nAsk for *fleet status*, *compliance report*, *maintenance report* or *financial report*.`);
                if (profileData?.id && laneReport?.ok) {
                  try {
                    await recordReportUsage({ supabase: supabaseClient, ownerId: profileData.id });
                    // Trial activation #3: first fleet report generated.
                    await recordActivationEvent({
                      supabase: supabaseClient,
                      ownerId: profileData.id,
                      event: ACTIVATION_EVENTS.REPORT_GENERATED
                    });
                    entitlements = await getEntitlements({
                      supabase: supabaseClient,
                      ownerId: profileData.id,
                      profile: profileData,
                      useCache: false
                    });
                  } catch { /* quota/activation are best-effort */ }
                }
              }
              }
            }
            else if (activeIntent === 'MANAGE_VEHICLE' || activeIntent === 'LIST_VEHICLES') {
              const vehicleList = existingVehicles.map((v, i) => {
                const isActive = v.id === targetVeh?.id;
                return `${i + 1}️⃣ *${v.plate_number}* - ${v.make_model || 'Vehicle'} (${v.fuel_type || 'Fuel'}, ${(v.current_mileage || v.odometer_reading || 0).toLocaleString()} km)${isActive ? ' 👉 *(ACTIVE)*' : ''}`;
              }).join('\n');
              customReply = `🚗 *Your Registered Fleet:*\n\n${vehicleList}\n\n💡 *To switch active vehicle:* Reply *"switch to [plate]"* or *"switch to [number]"*!`;
            }
            else if (session.pendingAccountDeletion) {
              const cleanTrimmed = messageText.trim();
              const providedOtp = mergedExt.otp_code || (cleanTrimmed.match(/^\d{6}$/) ? cleanTrimmed : null);
              if (/^(cancel|exit|stop)$/i.test(cleanTrimmed)) {
                session.pendingAccountDeletion = null;
                customReply = await composeMessage({
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
                customReply = await composeMessage({
                purpose: 'flow_outcome_card',
                facts: { cardText: `🗑️ *Account Deleted*\n\nYour Saka Fleet account has been soft-deleted, your vehicles released, and active sessions cleared. Historical audit logs are retained for compliance.\n\nYou can register again anytime by typing *Register*.`, instruction: 'Re-render this engine card conversationally: keep EVERY figure, label, emoji anchor and next step exactly as written. Never drop or invent a figure.' },
                language: targetLang,
                countryInfo,
                profile: profileData,
                fallbackText: `🗑️ *Account Deleted*\n\nYour Saka Fleet account has been soft-deleted, your vehicles released, and active sessions cleared. Historical audit logs are retained for compliance.\n\nYou can register again anytime by typing *Register*.`
              });
              } else {
                customReply = `❌ *Invalid or Expired Code*\n\nPlease reply with the 6-digit code sent to **${profileData?.email}**, or reply *Cancel* to abort.`;
              }
            }
            else if (activeIntent === 'DELETE_ACCOUNT' || /^(?:delete|deactivate|close|remove)\s+(?:my\s+)?account\b/i.test(messageText.trim())) {
              if (!profileData?.email) {
                customReply = await composeMessage({
                  purpose: 'email_required_gate',
                  facts: { issue: 'Account deletion needs a verified email for the confirmation code', oneStep: 'reply "update email to your@email.com"' },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: `🔒 *Email Required*\n\nPlease add a verified email first (reply *"update email to your@email.com"*) so we can send the account-deletion verification code.`
                });
              } else {
                const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
                session.pendingAccountDeletion = { code: otpCode, expiresAt: Date.now() + 10 * 60 * 1000 };
                try {
                  await sendMfaEmail(profileData.email, otpCode);
                  customReply = `🔒 *Confirm Account Deletion*\n\nWe dispatched a 6-digit verification code to **${profileData.email}**.\n\nReply with the code to soft-delete your account. Your vehicles will be released, active sessions cleared, and historical logs retained for audit.\n\nReply *Cancel* to abort.`;
                } catch (mailErr) {
                  session.pendingAccountDeletion = null;
                  customReply = `⚠️ Could not dispatch the verification code: ${mailErr.message}`;
                }
              }
            }
            else if (activeIntent === 'EDIT_PROFILE' || /^(?:edit|update|change|modify)\s+(?:my\s+)?(?:profile|details|name|language|units?|unit\s+system|settings|contact)\b/i.test(messageText.trim())) {
              const profileUpdates = {};
              const nameMatch = messageText.match(/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:full\s+)?name\s+(?:to|as|=)\s+(.+)$/i);
              const langMatch = messageText.match(/\b(english|swahili|french|spanish|german|arabic)\b/i);
              const unitMatch = messageText.match(/\b(metric|imperial)\b/i);

              if (nameMatch) profileUpdates.full_name = nameMatch[1].trim();
              if (mergedExt.full_name) profileUpdates.full_name = mergedExt.full_name;
              if (langMatch) profileUpdates.preferred_language = langMatch[1][0].toUpperCase() + langMatch[1].slice(1).toLowerCase();
              if (mergedExt.preferred_language) profileUpdates.preferred_language = mergedExt.preferred_language;
              if (unitMatch) profileUpdates.unit_system = unitMatch[1].toLowerCase();
              if (mergedExt.unit_system) profileUpdates.unit_system = mergedExt.unit_system;

              if (Object.keys(profileUpdates).length === 0) {
                customReply = `⚙️ *Profile & Settings*\n\n• Name: ${profileData?.full_name || '-'}\n• Email: ${profileData?.email || '-'}\n• Language: ${profileData?.preferred_language || 'English'}\n• Units: ${profileData?.unit_system || 'metric'}\n\nReply with a change, e.g. *"update my name to Jane Doe"*, *"change my language to Swahili"*, or *"change my units to imperial"*.\n\n_(Use "update email to ..." to change your email with OTP verification.)_`;
              } else if (supabaseClient && profileData) {
                profileUpdates.updated_at = new Date().toISOString();
                const { error: profileErr } = await supabaseClient.from('profiles').update(profileUpdates).eq('id', profileData.id);
                if (profileErr) {
                  customReply = `❌ *Profile Update Failed*\n\n${profileErr.message}`;
                } else {
                  Object.assign(profileData, profileUpdates);
                  const changed = Object.entries(profileUpdates)
                    .filter(([k]) => k !== 'updated_at')
                    .map(([k, v]) => `• *${k}:* ${v}`)
                    .join('\n');
                  customReply = `✅ *Profile Updated!* ⚙️\n\n${changed}\n\nThese settings now apply across your whole fleet.`;
                }
              }
            }
            else if (session.pendingEmailUpdate) {
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
                customReply = `✅ *Email Successfully Verified & Updated!* 📧\n\nYour account and vehicle passbooks are now linked to **${newEmail}**.`;
              } else if (/^(cancel|exit|stop)$/i.test(cleanTrimmed)) {
                session.pendingEmailUpdate = null;
                customReply = await composeMessage({
                  purpose: 'flow_cancellation_ack',
                  facts: { flow: 'Email update', cancelled: true },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: 'Email update cancelled. You are back in main menu mode.'
                });
              } else {
                customReply = `❌ *Invalid or Expired Verification Code*\n\nPlease check your inbox for **${session.pendingEmailUpdate.newEmail}** and reply with the 6-digit code, or reply **'cancel'** to abort.`;
              }
            }
            else if (activeIntent === 'UPDATE_EMAIL' || /^(update|change)\s+email\b/i.test(messageText.trim())) {
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
                customReply = `📧 *Email Verification Required*\n\nWe dispatched a 6-digit verification code to **${targetEmail}**.\n\nPlease reply with the 6-digit code to confirm and finalize updating your registered email.`;
              } else {
                customReply = await composeMessage({
                  purpose: 'quiz_intro_prompt',
                  facts: { flow: 'Update email', example: 'update email to user@example.com' },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: `📧 *Update Email Address*\n\nPlease reply with your new email address (e.g. *"update email to user@example.com"*).`
                });
              }
            }
            else if (activeIntent === 'TRANSFER_PASSBOOK' || /^transfer\s+passbook\b/i.test(messageText.trim())) {
              if (supabaseClient) {
                const candidate = mergedExt.target_vehicle || mergedExt.plate_number || targetVeh?.plate_number;
                const initRes = await initiatePassbookTransfer({
                  fromPhone: senderPhone,
                  vehicleCandidate: candidate,
                  supabase: supabaseClient
                });

                if (initRes.success) {
                  session.transferFlow = { step: 2, transferId: initRes.transferId, vehicle: initRes.vehicle };
                  customReply = `🚗 *Passbook Transfer Initiation — ${initRes.vehicle.plate_number}* (${initRes.vehicle.make_model || 'Vehicle'})\n` +
                    `• VIN: \`${initRes.vehicle.vin}\`\n` +
                    `• Transfer Quota: ${initRes.isFreeTransfer ? "✅ Free Transfer (1 per calendar year)" : "💳 Transfer Fee: USD 3.00 equivalent"}\n\n` +
                    `👉 *Step 2 of 5: Buyer Details*\n` +
                    `Please reply with the new owner's:\n` +
                    `1. International WhatsApp Number (e.g. \`+254712345678\`)\n` +
                    `2. Email Address\n\n` +
                    `*(You can reply with both together: e.g. "+254712345678 buyer@gmail.com")*\n\n` +
                    `_(Reply 'cancel' at any time to abort)_`;
                } else {
                  customReply = `⚠️ ${initRes.error}`;
                }
              }
            }
            else if (activeIntent === 'APP_HELP' || activeIntent === 'ACTION_DISCOVERY') {
              customReply = await renderRoleActions({
                profileData,
                vehicles: existingVehicles,
                senderPhone,
                language: targetLang,
                countryInfo
              });
            }
            else {
              if (aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant. How can I help with your vehicle') && !isLegacyWelcomeCopy(aiResult.reply_message)) {
                customReply = aiResult.reply_message;
              } else {
                customReply = await composeMessage({
                  purpose: 'active_user_default',
                  facts: {
                    activeVehicle: targetVeh?.plate_number || null,
                    makeModel: targetVeh?.make_model || null,
                    fleetSize: existingVehicles.length
                  },
                  language: targetLang,
                  countryInfo,
                  profile: profileData,
                  fallbackText: `How can I help with ${targetVeh?.plate_number || 'your fleet'} today?`
                });
              }
            }
          }
        }

        // --- BRANCH C: UNREGISTERED / IDLE USER DEFAULT ---
        else if (!isSpecialFlowHandled) {
          const clean = messageText.trim().toLowerCase();

          // 1. User asks to pause / stop
          if (/^(stop|pause|halt|quiet|exit|cancel)$/i.test(clean)) {
            customReply = await composeMessage({
              purpose: 'pause_acknowledgement',
              facts: { state: 'paused', note: 'Acknowledge the pause warmly and say they can return anytime.' },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: 'Paused — message me anytime to continue.'
            });
          }
          // 1b. Farewell — a goodbye must never fall through to the welcome.
          else if (/^(?:ok(?:ay)?[\s.,!]*)?(?:bye|goodbye|good bye|see you|see ya|talk later|good ?night|kwaheri|tutaonana)\b[\s!.…]*$/i.test(messageText.trim())) {
            customReply = await composeMessage({
              purpose: 'farewell',
              facts: { note: 'One warm line of goodbye. No sales pitch, no question, keep the door open.' },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: '👋 Anytime — I am here whenever you need me. Just say Hi. 🚗'
            });
          }
          // 1b-2. Reply-quality complaint ("your last reply was incomplete") —
          // v1.28.1. NEVER answer this with the welcome. Recover the answer, and
          // if the complaint mentions a fleet size, answer it now in local currency.
          else if (asksToUploadLogbook(messageText)) {
            customReply = await composeMessage({
              purpose: 'logbook_upload_invite',
              facts: {
                whatToSend: 'a clear photo of the logbook or registration certificate',
                whatHappens: 'Saka reads the plate, make and model from it and finishes registration together.',
                alternative: 'reply REGISTER for a few quick questions instead'
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: 'Yes! 📄 Send a clear photo of your logbook or registration certificate and I will read the plate, make and model from it — then we finish registration together. If the photo is tricky, reply *REGISTER* and I will ask a few quick questions instead. 🙂'
            });
          }
          else if (isIncompleteReplyComplaint(messageText)) {
            // v1.51.9 — one shared grammar; the fleet count is parsed in ONE place.
            const continuation = replyContinuationRequestFor(messageText);
            const complaintFleet = continuation.detectedFleetCount;
            let recoveryFacts = null;
            if (complaintFleet) {
              try {
                recoveryFacts = await buildLocalPricingFacts({
                  supabase: supabaseClient,
                  currency: countryInfo?.currency || 'USD',
                  locale: countryInfo?.locale,
                  fleetCount: complaintFleet
                });
              } catch { recoveryFacts = null; }
            }
            const recoveryTotal = recoveryFacts
              ? (recoveryFacts.find((line) => /For \d+ vehicles/.test(line)) || recoveryFacts[0])
              : null;
            const recoveryDetail = {};
            // v1.54.0 — ANSWER LAW v2: the user's own data rides this turn too,
            // so a cut-off answer about their fleet is finished from facts.
            let recoveryUserFacts = '';
            try {
              recoveryUserFacts = await buildUserFactsLines({
                supabase: supabaseClient,
                profile: profileData,
                vehicles: existingVehicles,
                currency: countryInfo?.currency || 'USD'
              });
            } catch { recoveryUserFacts = ''; }
            const recoveryReply = await composeMessage({
              purpose: 'complaint_recovery',
              facts: {
                userNote: messageText,
                fleetCount: complaintFleet || null,
                pricedAnswer: recoveryTotal || 'None supplied.',
                userDataFacts: recoveryUserFacts || 'No account data on file yet.',
                instruction: recoveryTotal
                  ? 'In 1-2 short lines, acknowledge the previous reply was cut short and give the full recommendation now using pricedAnswer ONLY. Never mention $, USD or any dollar amount. No re-introduction, no welcome, no menu. userDataFacts is the user\'s own data — never claim you lack access to it.'
                  : 'In 1-2 short lines, acknowledge the previous reply was cut short and say you will give the full answer now. Ask for the one detail you need, if any. No re-introduction, no welcome, no menu, no defensiveness. userDataFacts is the user\'s own data — never claim you lack access to it.'
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              detail: recoveryDetail,
              fallbackText: recoveryTotal
                ? `You are right — that reply was cut short. ${recoveryTotal}`
                : 'You are right — that reply was cut short. Tell me again and I will give you the full answer in one message. 🙏'
            });
            const acknowledgementRe = /(?:sorry|apolog|cut short|incomplete|again|redo|full answer|complete)/i;
            const ackReply = acknowledgementRe.test(String(recoveryReply || ''))
              ? recoveryReply
              : (recoveryTotal
                ? `You are right — that reply was cut short. ${recoveryTotal}`
                : 'You are right — that reply was cut short. Tell me again and I will give you the full answer in one message. 🙏');
            // v1.51.9 — if the composer itself was cut short, use the deterministic facts.
            customReply = (recoveryDetail.stoppedAtCap && recoveryTotal)
              ? stripUsdFigures(`You are right — that reply was cut short. ${recoveryTotal}`, { currency: countryInfo?.currency || 'USD' })
              : (recoveryFacts
                ? stripUsdFigures(ackReply, { currency: countryInfo?.currency || 'USD' })
                : ackReply);
            if (supabaseClient) {
              try {
                // v1.58.25 — a complaint is linked to the delivery errors that
                // explain it (live 2026-11-04: an INCOMPLETE_REPLY_COMPLAINT row
                // carried no error ids while 131026 failures piled up for the
                // same number). `admin friction done` now clears both sides.
                const recentErrors = await supabaseClient
                  .from('error_logs')
                  .select('id,stack_trace')
                  .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
                  .order('created_at', { ascending: false })
                  .limit(40);
                const digits = String(senderPhone || '').replace(/\D/g, '');
                const relatedIds = (recentErrors?.data || [])
                  .filter((row) => digits && String(row.stack_trace || '').includes(digits))
                  .map((row) => row.id)
                  .slice(0, 10);
                await recordFriction(supabaseClient, {
                  phone: senderPhone,
                  frictionType: 'INCOMPLETE_REPLY_COMPLAINT',
                  snippet: `Reply complaint [recovered: ${recoveryTotal ? 'pricing' : 'no-facts'}]: "${messageText}"`,
                  source: 'chat',
                  errorLogIds: relatedIds
                });
              } catch { /* logging is best effort */ }
            }
          }
          // 1c. Feedback / tester notes v1.27.0 — acknowledge the specific point,
          // never a canned apology for an opinion. Logged for the team.
          else if (/\b(feedback|tester|testing|notes?|suggestion|improve|improvement|canned|templates?|robotic|scripted)\b/i.test(messageText)
            && /\b(stupid|bad|wrong|hate|annoy|boring|canned|template|robotic|scripted|pre-?made|prewritten|pre-written|dumb)\b/i.test(messageText)) {
            if (supabaseClient) {
              try {
                await supabaseClient.from('chat_friction_logs').insert([{
                  user_phone: senderPhone,
                  session_id: senderPhone,
                  friction_type: 'USER_FEEDBACK',
                  transcript_snippet: `Feedback: "${messageText}"`.slice(0, 500)
                }]);
              } catch { /* logging is best effort */ }
            }
            customReply = await composeMessage({
              purpose: 'feedback_ack',
              facts: {
                userNote: messageText,
                instruction: 'Answer in 1-2 short lines. Acknowledge their specific point in plain words, no apology theatre, no corporate phrasing, no defensiveness. State the one concrete thing you will do about it. Thank them once, briefly.'
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: 'Noted — fair point. I will keep the answers fresh and specific instead of scripted. 🙏'
            });
          }
          // 1d. ANY question — product or the user's own data — gets a composed
          // answer from realtime facts (v1.27.0). Never the welcome, never a menu.
          else if (!productQaMatch && messageText.trim().length >= 5
            && (/^(?:what|how|why|when|where|which|who|is|are|was|were|do|does|did|can|could|should|would|tell me|explain|show me|give me|list|any)\b/i.test(messageText.trim()) || /\?\s*$/.test(messageText.trim()))) {
            let userFacts = [];
            try {
              const snapshot = await buildUserContextSnapshot({
                supabase: supabaseClient,
                profile: profileData,
                vehicles: existingVehicles,
                currency: countryInfo?.currency || 'USD'
              });
              userFacts = snapshot.lines;
            } catch { userFacts = []; }
            const questionFallback = userFacts.length
              ? userFacts.slice(0, 3).join('\n')
              : 'I do not have that on file yet — tell me in one line what you need and I will handle it.';
            // v1.28.1 — money questions from a non-USD user are answered in their
            // currency only; no dollar figure may appear anywhere in the reply.
            let localPricingFacts = null;
            const dataFleetMatch = messageText.match(/\b(\d{1,3})\s*(?:cars?|vehicles?|units?|machines?|trucks?|bikes?|motorbikes?|matatus?|lorries?|pickups?)\b/i);
            if (countryInfo?.currency && String(countryInfo.currency).toUpperCase() !== 'USD') {
              try {
                localPricingFacts = await buildLocalPricingFacts({
                  supabase: supabaseClient,
                  currency: countryInfo.currency,
                  locale: countryInfo.locale,
                  fleetCount: dataFleetMatch ? Number(dataFleetMatch[1]) : null
                });
              } catch { localPricingFacts = null; }
            }
            const dataAnswer = await composeMessage({
              purpose: 'user_data_answer',
              facts: {
                userQuestion: messageText,
                userDataFacts: userFacts.length ? userFacts.join('\n') : 'No account data on file yet.',
                productFacts: localPricingFacts
                  ? buildProductFactsContext().split('\n').filter((line) => !/\$|\bUSD\b/i.test(line)).join('\n')
                  : buildProductFactsContext(),
                localPricingFacts: localPricingFacts ? localPricingFacts.join('\n') : 'None supplied.',
                instruction: localPricingFacts
                  ? 'Answer the question directly in 1-4 short conversational lines using ONLY these facts. userDataFacts is the user\'s own data — read from it FIRST. Account data lives in userDataFacts; product knowledge in productFacts. If the answer involves money, quote ONLY the local-currency figures in localPricingFacts — NEVER mention $, USD or any dollar amount. If neither can answer it, say exactly which field is missing and offer the single most useful next step. No menus, no corporate phrasing, never the word plate, and never claim you lack information or access when the facts above contain it.'
                  : 'Answer the question directly in 1-4 short conversational lines using ONLY these facts. userDataFacts is the user\'s own data — read from it FIRST. Account data lives in userDataFacts; product knowledge in productFacts. If neither can answer it, say exactly which field is missing and offer the single most useful next step. No menus, no corporate phrasing, never the word plate, and never claim you lack information or access when the facts above contain it.'
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: questionFallback
            });
            customReply = sanitizeSakaReply(
              localPricingFacts ? stripUsdFigures(dataAnswer, { currency: countryInfo.currency }) : dataAnswer,
              questionFallback,
              { historyLength: conversationHistory.length }
            );
          }
          // 2. Conversational feedback / frustration / message looping detected
          // v1.26.0 — a recognised product question always outranks the apology.
          else if (!productQaMatch && (checkIsConversationalFeedback(messageText, 1) || /\b(many replies|lot of responses|too many messages|repeating|looping|frustrat|bot broken|why so many)\b/i.test(clean))) {
            if (supabaseClient) {
              try {
                await supabaseClient.from('chat_friction_logs').insert([{
                  user_phone: senderPhone,
                  session_id: senderPhone,
                  friction_type: 'LOOPING_PROMPTS',
                  transcript_snippet: `User reported loop/friction in idle state: "${messageText}"`
                }]);
              } catch {}
            }
            customReply = await composeMessage({
              purpose: 'friction_apology',
              facts: {
                issue: 'The user reported too many or repeating messages',
                actionTaken: 'Automated prompts paused for this chat',
                nextSteps: ['Type Support to reach support@reports.sakafleet.com', 'Send a vehicle plate when ready to onboard'],
                // v1.54.0 — ANSWER LAW v2: the user's own data rides this turn.
                userDataFacts: (await buildUserFactsLines({
                  supabase: supabaseClient,
                  profile: profileData,
                  vehicles: existingVehicles,
                  currency: countryInfo?.currency || 'USD'
                })) || 'No account data on file yet.',
                instruction: 'In 1-2 short lines, acknowledge the issue in plain words without apology theatre. State what was paused and give ONE next step. userDataFacts is the user\'s own data — never claim you lack access to it.'
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: 'Apologies for the message overload — I have paused automated prompts. Type Support for help, or send your plate when ready.'
            });
          }
          // 3. Greetings — Saka introduces itself on first contact (deterministic),
          // otherwise a warm AI-rendered one-liner.
          else if (/^(habari|mambo|jambo|hujambo|salama)\b/i.test(clean) || intent === 'GREETING') {
            // v1.51.4 — an unverified number is pointed to the website, never invited to register.
            const unverified = !profileData || profileData.email_verified !== true;
            const firstName = profileData?.full_name ? String(profileData.full_name).split(/\s+/)[0] : '';
            if (firstContact) {
              customReply = sakaIntroText({ countryInfo, profile: profileData, nextStep: unverified ? websiteSignupNextStep() : null });
              session.sakaIntroduced = true;
            } else if (!unverified && !hasVehicleRegistered) {
              // v1.58.11 — a verified user with no vehicle already met Saka on the
              // web: ADVANCE to the first vehicle, never re-introduce (live 2026-11-04).
              customReply = `Hi${firstName ? ` ${firstName}` : ''}! 👋 You're all set ✅ — what do you drive? One line is enough, e.g. *"Toyota Probox"*.`;
            } else {
              customReply = aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant') && !isLegacyWelcomeCopy(aiResult.reply_message)
                ? aiResult.reply_message
                : await composeMessage({
                    purpose: 'first_time_welcome',
                    facts: {
                      prompt: unverified
                        ? 'Introduce Saka warmly in two short lines (what it does for their machine) and invite them to set up at https://sakafleet.com (Get Started Free). The word "plate" must not appear in your reply.'
                        : 'Greet warmly in ONE short line and offer ONE next step (log a fuel/expense, check the fleet, or set a reminder). Never ask them to introduce themselves again. The word "plate" must not appear in your reply.',
                      region: countryInfo,
                      plateExample: countryInfo.plate_example,
                      setupSteps: ['plate number', 'make/model, year, fuel, odometer', 'email OTP', 'VIN-locked passbook'],
                      helpHint: 'Type Help anytime, Restart or Cancel to recover.'
                    },
                    language: targetLang,
                    countryInfo,
                    profile: profileData,
                    fallbackText: `Hi${firstName ? ` ${firstName}` : ''}! 👋 What would you like to do — log a fuel/expense, or check your fleet?`
                  });
            }
          }
          // 4. General informational questions answered by Saka AI
          else if (aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant. How can I help with your vehicle') && !isLegacyWelcomeCopy(aiResult.reply_message)) {
            customReply = aiResult.reply_message;
          }
          // 5. Default: AI-rendered single next step
          else {
            const unverified = !profileData || profileData.email_verified !== true;
            customReply = await composeMessage({
              purpose: 'first_time_default',
              facts: {
                prompt: unverified
                  ? 'Give exactly ONE warm next step: invite them to https://sakafleet.com (Get Started Free). The word "plate" must not appear in your reply.'
                  : 'Give exactly ONE warm next step: ask what they drive (one line is enough), or invite them to https://sakafleet.com. The word "plate" must not appear in your reply.',
                plateExample: countryInfo.plate_example,
                region: countryInfo
              },
              language: targetLang,
              countryInfo,
              profile: profileData,
              fallbackText: `What do you drive? Tell me in one line — or set up at https://sakafleet.com.`
            });
          }
        }
        }
        }

        // Fast-path safety: if no flow produced a reply, render a minimal one.
        if (!customReply) {
          customReply = await composeMessage({
            purpose: 'fallback_reply',
            facts: { userMessage: messageText },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: 'How can I help with your fleet today?'
          });
        }

        const sanitizedReply = customReply.trim();
        // v1.25.8 — the repeat guard must compare against the PREVIOUS turn's
        // assistant message. The loop-signature block below overwrites
        // session.lastAssistantPrompt with THIS turn's reply, so reading it after
        // that point compared the reply with itself and turned every genuine
        // answer (pricing card, trial card, welcome) into a "nudge".
        const previousAssistantPrompt = session.lastAssistantPrompt || null;

        // State Machine Circuit Breaker Check: Track consecutive identical assistant prompts
        const normalizedReply = sanitizedReply.toLowerCase().replace(/\s+/g, ' ');
        const loopSig = (session.loopSignature || '').toLowerCase().replace(/\s+/g, ' ');

        if (loopSig && loopSig === normalizedReply) {
          // Same prompt again -> advance the strike counter
          session.consecutivePromptCount = (session.consecutivePromptCount || 1) + 1;
        } else {
          // A genuinely different prompt -> new loop signature
          session.loopSignature = sanitizedReply;
          session.lastAssistantPrompt = sanitizedReply;
          session.consecutivePromptCount = 1;
          if (session.circuitBreakerStage !== 'HARD_TRIP') session.circuitBreakerStage = null;
        }

        let finalReply = sanitizedReply;
        if (languageSwitchNote) finalReply = `${languageSwitchNote}\n\n${finalReply}`;

        // First contact that did not arrive as a greeting (e.g. a plate sent
        // straight away) still gets Saka's polite introduction once.
        if (firstContact && !session.sakaIntroduced) {
          const plateGiven = Boolean(mergedExt?.plate_number);
          finalReply = `${sakaIntroText({ countryInfo, profile: profileData, nextStep: plateGiven ? '' : undefined })}${finalReply ? `\n\n${finalReply}` : ''}`;
          session.sakaIntroduced = true;
        }

        // v1.28.8 - upload hints follow the OCR unpause: ON by default; opt out
        // with UPLOAD_HINTS_ENABLED=off. The hint is shown once per field so it
        // never nags.
        if (/^(?:on|true|1)$/i.test(String(process.env.UPLOAD_HINTS_ENABLED || 'on')) && session.quiz && session.quiz.phase === 'question') {
          const pendingField = getCurrentQuizField(session.quiz, {
            countryInfo,
            vehicles: existingVehicles,
            profile: profileData
          });
          const uploadHint = pendingField?.key ? uploadHintFor(pendingField.key) : null;
          if (uploadHint && session.uploadHintField !== pendingField.key) {
            finalReply = `${finalReply}\n\n${uploadHint}`;
            session.uploadHintField = pendingField.key;
          }
        } else if (!session.quiz) {
          session.uploadHintField = null;
        }

        // Receipt outcomes override any AI prose: a duplicate is never re-logged,
        // and a low-confidence read asks the user to double-check first.
        if (duplicateReceipt) {
          session.quiz = null;
          finalReply = await composeMessage({
            purpose: 'receipt_duplicate',
            facts: {
              alreadyRead: true,
              vendor: duplicateReceipt?.vendor || null,
              amount: duplicateReceipt?.amount || null,
              currency: duplicateReceipt?.currency || countryInfo?.currency || null
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: formatDuplicateReceiptReply(duplicateReceipt, { fallbackCurrency: countryInfo?.currency || null })
          });
        } else if (ocrLowConfidence && session.quiz) {
          finalReply = `${finalReply}\n\n${OCR_LOW_CONFIDENCE_NOTE}`;
        }

        // v1.19.2 / v1.24.4 — never re-introduce Saka to a conversation that is
        // already past onboarding. A zero-vehicle user who has NOT started
        // onboarding keeps the welcome (it carries the REGISTER call to action);
        // replacing it used to trap first-time users on "still here with you".
        if (shouldReplaceIntroCopy({
          firstContact,
          historyLength: conversationHistory.length,
          hasQuiz: Boolean(session.quiz),
          hasVehicle: hasVehicleRegistered,
          isIntro: isIntroCopy(finalReply),
          wantsIntro: wantsIntroduction(messageText)
        })) {
          finalReply = '🙂 I\'m still here with you — no need to start over.\n\nSend your next answer in your own words, or type *Help* to see what I can do.';
        }

        // v1.24.4 — an identical repeat outside a quiz is a dead end; always hand
        // the user a next step instead of echoing the same sentence again.
        // v1.25.4 — the nudge ROTATES, so a stuck user never sees one line on loop.
        // v1.25.5 — newcomers (no vehicle, no quiz) never get the "Let's keep
        // moving" line; a first contact also drops stale in-memory repeat state.
        const isNewcomer = !hasVehicleRegistered && !session.quiz;
        if (firstContact && !session.sakaIntroduced) {
          session.lastAssistantPrompt = null;
          session.nudgeCount = 0;
        }
        if (session.quiz || hasVehicleRegistered) session.nudgeCount = 0;
        if (isNewcomer && isFirstTimeMessage(messageText)) {
          finalReply = sakaIntroText({ countryInfo, profile: profileData, nextStep: 'Set up in about a minute at https://sakafleet.com — I\'ll meet you on WhatsApp.' });
          session.sakaIntroduced = true;
        } else if (isRepeatedReply({ quizActive: Boolean(session.quiz), reply: finalReply, lastPrompt: previousAssistantPrompt })) {
          // v1.26.1 — never swap in a canned nudge. Ask for a fresh, different,
          // warmer phrasing; the short line below is only the AI-outage fallback.
          finalReply = await composeMessage({
            purpose: 'repeat_variation',
            facts: {
              lastReply: previousAssistantPrompt,
              userMessage: messageText,
              instruction: 'You already said something very similar last turn. Say it differently now — warmer, shorter, with one concrete next step. Never repeat the same sentence.'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: '🙂 Let me put that differently — what would help most right now?'
          });
        }

        // v1.26.2 — the plate ask belongs ONLY to the registration quiz. If any
        // composed reply mentions "plate" outside registration, it is replaced by
        // a warm one-line invitation instead. The model can never re-add it.
        if (!session.quiz && !hasVehicleRegistered
          && !/^\s*(?:register|onboard|add)\b/i.test(messageText)
          && /\bplates?\b/i.test(finalReply)) {
          finalReply = await composeMessage({
            purpose: 'drive_nudge',
            facts: {
              example: '"Toyota Fielder 2016, diesel, 120,000 km"',
              alternative: 'reply REGISTER and Saka asks a few quick questions instead'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: 'Tell me what you drive — one line is enough (e.g. *"Toyota Fielder 2016, diesel, 120,000 km"*). Or reply *REGISTER* and I\'ll ask a few quick questions. 🙂'
          });
        }

        // v1.21.3 — a zero-vehicle user must never be asked for a plate before
        // the Country Bucket onboarding (asset kind first). Route to REGISTER.
        if (shouldReplacePlateAsk({
          asksPlate: asksForPlateDirectly(finalReply),
          hasVehicle: hasVehicleRegistered,
          hasQuiz: Boolean(session.quiz),
          firstContact,
          isWelcome: isIntroCopy(finalReply),
          explicitRegister: /^\s*(?:register|onboard|add)\b/i.test(messageText)
        })) {
          finalReply = '🚗 Let\'s set up your first asset.\n\nReply *REGISTER* and I\'ll start with one question: what kind of asset it is (car, truck, bus, motorcycle, machinery, generator…). Then the plate or serial — or send a document and I\'ll read it.';
        }

        // v1.19.2 — OCR recovery ladder: two unreadable photos on the same quiz
        // step unlock one typed-or-skip escape so the identical question is
        // never repeated a third time.
        if (!ocrPaused && mediaObj && !ocrText && session.quiz) {
          const quizKey = `${session.quiz.flow || ''}|${session.quiz.phase || ''}|${JSON.stringify(session.quiz.answers || {})}`;
          if (session.ocrFailuresStep !== quizKey) {
            session.ocrFailures = 0;
            session.ocrFailuresStep = quizKey;
          }
          session.ocrFailures = (session.ocrFailures || 0) + 1;
          if (session.ocrFailures >= 2) {
            finalReply = `${finalReply}\n\n${OCR_UNREADABLE_NOTE}`;
            session.ocrFailures = 0;
          }
        } else if (!mediaObj) {
          session.ocrFailures = 0;
          session.ocrFailuresStep = null;
        }

        // Stage 1 (Soft Trip): Prompt repeated 3 times. Grace retry.
        if (session.consecutivePromptCount === 3) {
          session.circuitBreakerStage = 'SOFT_TRIP';
          finalReply = await composeMessage({
            purpose: 'soft_trip_retry',
            facts: {
              issue: 'The same prompt repeated without progress',
              instruction: 'Invite the user to resend that one answer in a slightly different way. Keep it to one short question.'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: "Let's try that once more — please resend your last answer."
          });
          session.lastAssistantPrompt = finalReply;
          if (fastify?.log) fastify.log.warn(`[Circuit Breaker] SOFT TRIP for ${senderPhone}! Same assistant prompt repeated 3 times.`);
          if (supabaseClient) {
            try {
              await supabaseClient.from('chat_friction_logs').insert([{
                user_phone: senderPhone,
                session_id: senderPhone,
                friction_type: 'LOOPING_PROMPTS',
                transcript_snippet: `[user]: ${String(messageText || '').slice(0, 600)}\n[assistant]: ${String(sanitizedReply || '').slice(0, 600)}\n[breaker]: SOFT_TRIP strike 3`
              }]);
            } catch {}
          }
        } 
        // Stage 2 (Hard Trip): Prompt repeated 4 times. Support escalation.
        else if (session.consecutivePromptCount >= 4) {
          session.circuitBreakerStage = 'HARD_TRIP';
          if (fastify?.log) fastify.log.warn(`[Circuit Breaker] HARD TRIP for ${senderPhone}! Escalating to support.`);

          try {
            await sendSupportEscalationEmail({
              userPhone: senderPhone,
              userEmail: profileData?.email,
              userName: profileData?.full_name,
              subscriptionTier: profileData?.subscription_tier,
              issueParagraph: `[AUTOMATIC CIRCUIT BREAKER TRIPPED - HARD TRIP]\n\nThe assistant generated the exact same prompt 4 consecutive times without user state progression.\n\nRepeated Prompt:\n${sanitizedReply}\n\nLast User Input:\n${messageText}`,
              vehiclesList: existingVehicles
            });
            if (supabaseClient) {
              await supabaseClient.from('chat_friction_logs').insert([{
                user_phone: senderPhone,
                session_id: senderPhone,
                friction_type: 'SYSTEM_ERROR',
                transcript_snippet: `[user]: ${String(messageText || '').slice(0, 600)}\n[assistant]: ${String(sanitizedReply || '').slice(0, 600)}\n[breaker]: HARD_TRIP strike 4 — escalated to support`
              }]);
            }
          } catch (escErr) {
            if (fastify?.log) fastify.log.error('Failed to dispatch circuit breaker escalation email:', escErr?.message);
          }

          finalReply = await composeMessage({
            purpose: 'hard_trip_support_escalation',
            facts: {
              issue: 'Repeated identical prompt; support has been emailed automatically',
              supportEmail: 'support@reports.sakafleet.com',
              nextSteps: ['Type Restart to begin again', 'Type Cancel to exit', 'Wait for a WhatsApp update from support'],
              // v1.54.0 — ANSWER LAW v2: even a breaker trip carries the
              // user's own data; never claim a lack of access to it.
              userDataFacts: (await buildUserFactsLines({
                supabase: supabaseClient,
                profile: profileData,
                vehicles: existingVehicles,
                currency: countryInfo?.currency || 'USD'
              })) || 'No account data on file yet.'
            },
            language: targetLang,
            countryInfo,
            profile: profileData,
            fallbackText: "I've escalated this step to support@reports.sakafleet.com. Type Restart to begin again, or Cancel to exit."
          });
          session.lastAssistantPrompt = finalReply;
        }

        // v1.28.0 — a lost-chat moment ("I can't find you") is the one other
        // natural time to suggest saving the number. Same 30-day cooldown,
        // never mid-quiz, never during a breaker trip.
        if (!summaryCommand && !session.quiz && !session.circuitBreakerStage
          && existingVehicles.length > 0
          && isLostChatMessage(messageText)
          && shouldSuggestContactSave({ profile: profileData, session, hasVehicle: true, hasQuiz: false })) {
          try {
            const contactFacts = buildContactSaveFacts({
              plateNumber: existingVehicles[0]?.plate_number || null,
              name: profileData?.full_name
            });
            const contactLine = sanitizeSakaReply(
              await composeMessage({
                purpose: 'contact_save_nudge',
                facts: contactFacts,
                language: targetLang,
                countryInfo,
                profile: profileData,
                fallbackText: contactFacts.fallbackLine
              }),
              contactFacts.fallbackLine,
              { historyLength: conversationHistory.length }
            );
            finalReply = `${finalReply}\n\n${contactLine}`;
            session.contactSaveNudged = true;
            if (supabaseClient) markContactSaveSuggested(supabaseClient, profileData?.id).catch(() => {});
          } catch { /* best-effort */ }
        }

        // v1.19.1 — once-only "What's new" digest for existing users. Appended to
        // a normal turn only (never during a quiz/confirmation, breaker trip or
        // the summary command) and stamped so it can never repeat.
        if (!summaryCommand && !session.circuitBreakerStage && shouldShowFeatureNotice({
          profile: profileData,
          session,
          hasQuiz: Boolean(session.quiz),
          hasVehicleRegistered: existingVehicles.length > 0
        })) {
          const driverLane = !existingVehicles.some((vehicle) => vehicle.owner_id === profileData?.id);
          finalReply = `${finalReply}\n\n${buildFeatureNotice({ lane: driverLane ? 'driver' : 'owner' })}`;
          session.featureNoticeShown = true;
          if (supabaseClient) markFeatureNoticeSeen(supabaseClient, profileData.id).catch(() => {});
        }

        session.history.push({ role: 'user', parts: [{ text: messageText }] });
        session.history.push({ role: 'model', parts: [{ text: finalReply }] });
        if (session.history.length > CHAT_HISTORY_MAX_MESSAGES) session.history = session.history.slice(-CHAT_HISTORY_MAX_MESSAGES);
        chatSessions.set(senderPhone, session);

        turnFinalized = true;
        if (slowAckTimer) {
          clearTimeout(slowAckTimer);
          slowAckTimer = null;
        }
        await sendWhatsAppReply(senderPhone, finalReply);
        replyDispatched = true;
        const phaseMs = {
          setup: phaseMarks.profileReadyAt ? phaseMarks.profileReadyAt - turnStartedAt : null,
          preAi: phaseMarks.profileReadyAt && phaseMarks.aiStartedAt ? phaseMarks.aiStartedAt - phaseMarks.profileReadyAt : null,
          ai: phaseMarks.aiStartedAt && phaseMarks.aiDoneAt ? phaseMarks.aiDoneAt - phaseMarks.aiStartedAt : null,
          postAi: phaseMarks.aiDoneAt ? Math.max(0, Date.now() - phaseMarks.aiDoneAt) : null
        };
        void logTurnLatency(supabaseClient, {
          phone: senderPhone,
          turnMs: Date.now() - turnStartedAt,
          ackSent: session.instantAckSent === true || session.slowAckSent === true,
          phaseMs
        });
        await userLogPromise;
        if (supabaseClient) {
          await Promise.all([
            logChatTranscript(supabaseClient, senderPhone, 'assistant', finalReply),
            saveChatMessage(supabaseClient, senderPhone, 'assistant', finalReply),
            persistSnap()
          ]);
        } else {
          await persistSnap();
        }

        return { status: 'success' };
      } catch (err) {
        if (fastify?.log) fastify.log.error(err);
        turnFinalized = true;
        if (slowAckTimer) {
          clearTimeout(slowAckTimer);
          slowAckTimer = null;
        }
        await userLogPromise;
        await persistSnap();
        // v1.32.1 — never mask the original failure: `session` is hoisted, and
        // the real error is persisted to error_logs (the 2026-11-01 photo turns
        // died silently because this line threw "session is not defined").
        await logSystemError(supabaseClient, err, '/webhook/whatsapp').catch(() => {});
        void logTurnLatency(supabaseClient, { phone: messageObj?.from || null, turnMs: Date.now() - turnStartedAt, ackSent: session?.slowAckSent === true });
        // v1.58.x — never leave the user in silence: if the turn crashed before
        // any reply was dispatched, send one short deterministic recovery line.
        if (!replyDispatched && messageObj?.from) {
          try {
            await sendWhatsAppReply(messageObj.from, '🙂 Something hiccupped on my side just now — your message is safe. Please send it once more, or type *Help*.');
          } catch { /* best-effort */ }
        }
        return { status: 'error', error: err?.message };
      }
}

// (removed) The unused `whatsappRoutes` plugin duplicated the /webhook routes
// already registered in index.js; it was never `fastify.register()`ed (v1.58.x cleanup).

/* ------------------------------------------------------------------ */
/* Compliance capture persistence (v1.58.25)                           */
/* ------------------------------------------------------------------ */

/**
 * Save one captured document for either role. Vehicle permits go to
 * `vehicle_compliances`; driver documents (owner self-profile or an assigned
 * driver) go to `driver_compliances`. An owner's own minimal item is NEVER
 * `isMinimal` (owner self-profiles are skippable per §40.1 — only a gated
 * driver's minimal item runs the 3-strike/assignment logic).
 */
async function persistCapturedCompliance({
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
  timeZone = null
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
      return result?.ok ? { ok: true } : { ok: false, error: result?.error || 'That could not be saved yet.' };
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
/* Subscription / trial turn handling (v1.15.0)                        */
/* ------------------------------------------------------------------ */

/**
 * Engine-owned subscription turn handler. Returns `{ handled, reply, entitlements }`.
 * Every branch is deterministic (zero AI tokens) so billing copy can never drift.
 */
async function maybeHandleSubscriptionTurn({
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
      reply: `➕ *Fleet Command add-on*\n\n+${quantity} garage slot(s) — $${addon.amountUSD} for this cycle.\n\n👉 ${await shortenUrl(supabaseClient, addon.checkoutUrl)}\n\nYour slots activate automatically after payment.`
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
