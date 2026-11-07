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
import { isSuperadminPhone } from '../../services/superadmin.js';
import { extractVehicleAttributes } from '../../../sakaAi.js';
import { logSystemError } from '../../workers/sentinel.js';
import { getActiveVehicle, findVehicleByCandidate } from '../../services/vehicles.js';
import { shortenUrl } from '../../services/linkShortener.js';
import { sakaIntroText, isFirstContact, isIntroCopy, wantsIntroduction, asksForPlateDirectly, shouldReplaceIntroCopy, isRepeatedReply, isStopRequest, PAUSE_REPLY, isFirstTimeMessage, shouldReplacePlateAsk, isConfusedUnverifiedTurn } from '../../services/greetings.js';
import { sanitizeSakaReply } from '../../services/productQa.js';
import { isLostChatMessage } from '../../services/contactNudge.js';
import { buildUserFactsLines } from '../../services/userContextSnapshot.js';
import { resolveSlowAckMs, pickSlowAckLine, shouldSendSlowAck } from '../../services/turnAck.js';
import {
  buildFeatureNotice,
  shouldShowFeatureNotice,
  markFeatureNoticeSeen
} from '../../services/featureNotice.js';
import {
  handleDriverResponse,
  canManageVehicle
} from '../../services/driverAssignments.js';
import { resolveBundledCatalog } from '../../services/complianceCatalog.js';
import {
  DRIVER_DOC_RE,
  VEHICLE_DOC_RE,
  findMentionedComplianceItem,
  pickComplianceContextVehicle,
  detectComplianceAddRequest,
  extractComplianceDetails,
  complianceCapturePrompt,
  formatComplianceSaved,
  looksLikeFreshLogLine,
  isUnreadableMediaNote
} from '../../services/complianceCapture.js';
import { parseVehicleComplianceParagraph, submitVehicleCompliance, resolveVehicleComplianceCatalog } from '../../services/vehicleCompliance.js';
import { formatUsdInLocalCurrency } from '../../services/paystack.js';
import { saveChatMessage, getRecentChatHistory, CHAT_HISTORY_MAX_MESSAGES } from '../../services/chatHistory.js';
import { sendSupportEscalationEmail, sendMfaEmail } from '../../services/mailer.js';
import {
  initiatePassbookTransfer,
  handleBuyerAcceptance
} from '../../services/transfers.js';
import { applyTrialExtensionCoupon } from '../../services/coupons.js';
import {
  getEntitlements,
  evaluateVehicleCapacity,
  checkoutForTier,
  checkoutForAddon
} from '../../services/subscriptions.js';
import {
  startWelcomeTrial,
  applyAccountTrialExtensionCoupon
} from '../../services/trialEngine.js';
import { getTierLabel } from '../../services/subscriptionTiers.js';
import { resolveUserTimezone } from '../../services/globalization.js';
import { getCountryCommStyleLine } from '../../services/countryCommStyles.js';
import { ensureCountryBucket, getCountryLearningsLine } from '../../services/countryLearnings.js';
import { detectQuizStart, getCurrentQuizField, getActiveQuiz } from '../../services/quizEngine.js';
import { matchNarrativeVehicle, buildNarrativeDraft, narrativeDraftFields, narrativeDraftExtras, shouldPrefillNarrativeDraft, isNarrativeIntakeEnabled, isNarrativeEligibleText, buildNarrativeParagraphDrafts, renderNarrativeBatchCard } from '../../services/narrativeDraft.js';
import { composeMessage } from '../../services/conversationEngine.js';
import { uploadHintFor } from '../../services/documentLens.js';
import {
  normalizeAssetKind,
  getCountryBucket,
  buildJurisdictionContext
} from '../../services/countryBucket.js';
import {
  formatDuplicateReceiptReply,
  OCR_LOW_CONFIDENCE_NOTE,
  OCR_UNREADABLE_NOTE
} from '../../services/receipts.js';
import { inspectRecordQuestion } from '../../services/readCommands.js';
// v1.66.0 — Phase 5B-1 module split: pure helpers + the outbound Meta sender.
import {
  detectCountryFromPhone,
  detectMessageLanguage,
  languageSwitchConfirmation
} from './helpers.js';
import { sendWhatsAppReply } from './replies.js';
// v1.67.0 — Phase 5B-2 module split: the media intake lane + the per-turn hooks.
import {
  VOICE_NOTE_REPLY,
  VOICE_NOTE_USER_TEXT,
  resolveMediaEnvelope,
  resolveMediaGate,
  prepareMediaAck,
  startMediaOcr,
  finalizeMediaOcr,
  resolveReceiptVault
} from './media.js';
import {
  persistTurnSnapshot,
  loadTurnSnapshot,
  logUserTurn,
  finalizeAssistantTurn,
  logTurnPairSequential,
  logAssistantTranscript,
  hydrateTurnSession,
  loadUserFactsContext,
  loadReengagementContext,
  queueReportFollowUp,
  recordTurnLatency
} from './hooks.js';
// v1.68.0 — Phase 5B-3 module split: reads + pending + quiz (turn-owners separated).
import { dispatchReadTurn } from './reads.js';
import {
  startClearChatTurn,
  resolveClearChatTurn,
  resolveSupportIntakeTurn,
  handleTransferFlowTurn,
  handleAssignmentOtpTurn,
  handleBuyerOtpTurn,
  handleSubscriptionTurn,
  handleComplianceCaptureTurn,
  handleNarrativeBatchTurn,
  handleDeleteVehicleTurn,
  handleDriverAssignmentTurn,
  handleAccountDeletionOtpTurn,
  handleEmailUpdateOtpTurn,
  handleEmailUpdateStartTurn,
  persistCapturedCompliance
} from './pending.js';
import { arbitrateQuizTurn, finalizeQuizOutcome, renderRoleActions } from './quiz.js';
// v1.69.0 — Phase 5B-4: the final leaf modules (commands + admin + conversation + support).
import {
  resolveCountryCommand,
  resolveWeeklyReportToggle,
  parseReceiptDeleteCommand,
  parseVehicleSummaryCommand,
  handleReceiptDeleteTurn,
  renderPassbookSnapshot,
  handleUnassignDriverTurn,
  handleViewProfileTurn,
  handleEditVehicleTurn,
  handleSwitchVehicleTurn,
  handleFuelEfficiencyTurn,
  handleFleetSummaryTurn,
  handleGreetingTurn,
  handleLogExpenseTurn,
  handleUpdateMileageTurn,
  handleOperatingHoursTurn,
  handleLogEarningsTurn,
  renderReminderPrompt,
  handleReportRequestTurn,
  renderVehicleList,
  handleEditProfileTurn,
  renderActiveDefault
} from './commands.js';
import { handleAdminIntercepts } from './admin.js';
import { runSakaAiTurn, applyPostAiIntentFixes, renderIdleConversationTurn } from './conversation.js';
import { resolveSupportFlowTurn } from './support.js';
// v1.73.1 — Phase 11: the legacy onboarding lane (section 191 branch A + registration starter).
import { handleLegacyOnboardingTurn, startLegacyRegistrationFlow } from './onboarding.js';
// The public surface stays identical: renderRoleActions is re-exported from here.
export { renderRoleActions };

export const onboardingStore = new Map();
export const chatSessions = new Map();

export async function processIncomingWhatsAppMessage({ messageObj, fastify, supabaseClient }) {
  const sessionPhone = messageObj?.from || '';
  const formattedPhoneForSession = sessionPhone.startsWith('+') ? sessionPhone : `+${sessionPhone.replace(/[^\d]/g, '')}`;
  const persistSnap = async () => persistTurnSnapshot({
    supabaseClient,
    sessionPhone,
    formattedPhoneForSession,
    session: chatSessions.get(sessionPhone) || null,
    onboarding: onboardingStore.get(sessionPhone) || null
  });
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
    // v1.67.0 — Phase 5B-2: the intake lane lives in ./media.js (state in, data out).
    const envelope = resolveMediaEnvelope(messageObj);
    const { mediaObj, mediaCaption, mediaMimeType } = envelope;

    // v1.61.15 — voice notes carry no text and no OCR path. Answer them
    // deterministically (zero tokens, zero menu wall) instead of letting an
    // empty turn fall through to the generic help menu. The transcript keeps a
    // durable marker so eval/digest can see these turns.
    if (envelope.isVoiceNote) {
      const voiceReply = VOICE_NOTE_REPLY;
      try {
        await logTurnPairSequential(supabaseClient, senderPhone, 'user', VOICE_NOTE_USER_TEXT);
        await sendWhatsAppReply(senderPhone, voiceReply);
        await logTurnPairSequential(supabaseClient, senderPhone, 'assistant', voiceReply);
      } catch (err) {
        console.warn('[VoiceNote] fallback reply failed:', err?.message || 'unknown');
      }
      return { status: 'voice_note_fallback' };
    }

    // v1.51.6 — an unverified number never gets the OCR ack or runs Vision:
    // short-circuit to the website line BEFORE any media download/OCR.
    if (mediaObj?.id) {
      const mediaGate = await resolveMediaGate({
        supabaseClient,
        formattedPhoneForSession,
        isSuperadmin: isSuperadminPhone(senderPhone)
      });
      if (mediaGate) {
        const verifyReply = mediaGate.replyText;
        try {
          await logTurnPairSequential(supabaseClient, senderPhone, 'user', mediaCaption || '[document]');
          await sendWhatsAppReply(senderPhone, verifyReply);
          await logTurnPairSequential(supabaseClient, senderPhone, 'assistant', verifyReply);
        } catch { /* best-effort */ }
        return { status: 'unverified_gated_media' };
      }
    }

    // v1.22.0 — Snappy Saka: when Vision is enabled, acknowledge the media
    // immediately (deterministic, no AI) so the user never waits in silence
    // while the document is downloaded and read. The parsed result arrives as
    // the follow-up message.
    const { ocrPaused, ackText: mediaAckText } = prepareMediaAck({ mediaObj, mediaMimeType });
    if (mediaAckText) {
      try {
        const ack = mediaAckText;
        await sendWhatsAppReply(senderPhone, ack);
        if (supabaseClient) {
          await logTurnPairSequential(supabaseClient, senderPhone, 'assistant', ack);
        }
      } catch { /* the ack is best-effort; the turn still proceeds */ }
    }

    // OCR and session hydration are independent and side-effect free: run them
    // together so media turns do not pay two serial round trips.
    const { ocrPromise, startedAt: ocrStartedAt } = startMediaOcr({ mediaObj, mediaMimeType });

    // Durable session hydration — restores quiz/onboarding/OTP state from
    // Supabase so any Cloud Run instance can continue the conversation.
    const hydrationPromise = loadTurnSnapshot(supabaseClient, formattedPhoneForSession);

    const [ocrResult, snapshot] = await Promise.all([ocrPromise, hydrationPromise]);
    const {
      ocrText,
      ocrError,
      messageText,
      ocrCountry,
      ocrKind,
      ocrLowConfidence,
      ocrTextSha,
      receiptHints
    } = await finalizeMediaOcr({
      ocrResult,
      ocrPaused,
      ocrStartedAt,
      mediaObj,
      mediaCaption,
      mediaMimeType,
      senderPhone,
      formattedPhoneForSession,
      supabaseClient,
      messageObj
    });

    if (snapshot) {
      if (snapshot.session && !chatSessions.has(senderPhone)) chatSessions.set(senderPhone, snapshot.session);
      if (snapshot.onboarding && !onboardingStore.has(senderPhone)) onboardingStore.set(senderPhone, snapshot.onboarding);
    }

    if (fastify?.log) fastify.log.info(`Incoming WhatsApp message from ${senderPhone}: "${messageText}"`);
    userLogPromise = logUserTurn(supabaseClient, senderPhone, messageText);

    // v1.69.0 — Phase 5B-4: the care-console + superadmin gates live in ./admin.js.
    const adminIntercept = await handleAdminIntercepts({ supabaseClient, senderPhone, messageText, sendWhatsApp: sendWhatsAppReply });
    if (adminIntercept) {
      if (adminIntercept.reply) {
        await sendWhatsAppReply(senderPhone, adminIntercept.reply);
        await logTurnPairSequential(supabaseClient, senderPhone, 'assistant', adminIntercept.reply);
      }
      await userLogPromise;
      await persistSnap();
      return { status: adminIntercept.status };
    }

    // v1.64.0 — ONE pending state object (Phase 4). The migration-on-read shim
    // folds every legacy pending* field of a restored snapshot into
    // `session.pending` and re-exposes the legacy names as accessors, so the
    // branch code below is byte-identical while the physical state is unified.
    session = hydrateTurnSession(chatSessions.get(senderPhone) || { history: [], lastActive: Date.now() });
    session.lastActive = Date.now();
    session.slowAckSent = false;

    const cleanCmd = messageText.trim().toLowerCase();

    // v1.25.2 — explicit stop/pause: acknowledge once, stay quiet, and resume on
    // the user's next message. Deterministic (no AI, no marketing follow-up).
    // v1.57.1 - user can wipe the conversation and start fresh; fleet data is untouched.
    if (/^(?:clear|reset)\s+(?:the\s+)?(?:chat|conversation|history)$|^start\s+over$|^clear\s+chat$/i.test(cleanCmd) && !session.pendingClearChat) {
      // v1.68.0 — Phase 5B-3: the clear-chat lanes live in ./pending.js.
      const clearStart = startClearChatTurn({ session, messageText });
      chatSessions.set(senderPhone, session);
      try { await sendWhatsAppReply(senderPhone, clearStart.reply); } catch { }
      if (supabaseClient) { try { await saveChatMessage(supabaseClient, senderPhone, "assistant", clearStart.reply); } catch { } }
      return { status: clearStart.status };
    }
    if (session.pendingClearChat) {
      const clearTurn = await resolveClearChatTurn({ session, cleanCmd, senderPhone, supabaseClient });
      if (clearTurn) {
        chatSessions.set(senderPhone, session);
        try { await sendWhatsAppReply(senderPhone, clearTurn.reply); } catch { }
        if (clearTurn.saveHistory && supabaseClient) { try { await saveChatMessage(supabaseClient, senderPhone, "assistant", clearTurn.reply); } catch { } }
        return { status: clearTurn.status };
      }
    }

    // v1.58.22 - a pending support intake OWNS the next turn: an open draft must
    // never swallow the user's issue description (live 2026-11-04: "KAS 628T"
    // was answered by the expense quiz while support intake was waiting).
    if (session.pendingSupportEscalation) {
      // v1.68.0 — Phase 5B-3: the intake capture lives in ./pending.js.
      const supportReply = await resolveSupportIntakeTurn({ session, messageText, senderPhone, supabaseClient });
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
          await logTurnPairSequential(supabaseClient, senderPhone, 'assistant', pauseReply);
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
            await logTurnPairSequential(supabaseClient, senderPhone, 'assistant', verifyReply);
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
        const userFactsContext = await loadUserFactsContext({
          supabaseClient,
          senderPhone,
          forceRefresh: dbHistory.length === 0,
          profileData,
          existingVehicles,
          entitlements,
          countryInfo
        });

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

        const { duplicateReceipt, logbookPrefill } = await resolveReceiptVault({
          supabaseClient,
          mediaObj,
          ocrPaused,
          ocrKind,
          ocrText,
          ocrTextSha,
          ocrLowConfidence,
          ocrResult,
          ocrError,
          receiptHints,
          countryInfo,
          entitlements,
          profileData,
          existingVehicles,
          currentActiveVehicle,
          messageText,
          ocrCountry
        });

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
        // v1.58.15 — deterministic receipt delete stays a WRITE lane (rule 37).
        // v1.69.0 — Phase 5B-4: the parse lives in ./commands.js.
        const receiptDeleteCommand = parseReceiptDeleteCommand({ commandText });




        // Vehicle registration summary ("send me registration summary as PDF").
        // v1.69.0 — Phase 5B-4: the flag parse lives in ./commands.js.
        const summaryCommand = parseVehicleSummaryCommand({ messageText });

        // v1.21.0 — Country Bucket commands (deterministic, zero tokens).
        // v1.69.0 — Phase 5B-4: the country command (parse + profile write) lives in ./commands.js.
        const countryCommandResult = await resolveCountryCommand({ messageText, profileData, supabaseClient, bucketAssetKind });

        // v1.73.0 (Phase 10, P3-4) — the weekly-report toggle is a PRE-READ
        // profile-write lane (the read registry's contract keeps writes out).
        // A bare "weekly report" is answered as a state read so the phrase can
        // never be misclassified as a report request (quota hijack).
        const weeklyReportToggleResult = await resolveWeeklyReportToggle({ messageText, profileData, supabaseClient });

        // v1.24.0 - perceived speed: long free-form paragraphs get an instant ack
        // while this turn parses and records in the background.
        const instantAckEnabled = !/^(?:off|false|0)$/i.test(String(process.env.INSTANT_ACK_ENABLED || 'on'));
        const instantAckChars = Number(process.env.INSTANT_ACK_CHARS || 180);
        if (instantAckEnabled && !mediaObj && !session.quiz && !countryCommandResult && !weeklyReportToggleResult
          && String(messageText || '').trim().length >= instantAckChars) {
          try {
            await sendWhatsAppReply(senderPhone, '📖 Got it - reading that now.');
            session.instantAckSent = true;
            if (supabaseClient) await logAssistantTranscript(supabaseClient, senderPhone, 'Got it - reading that now.');
          } catch { /* ack is best-effort */ }
        }

        // v1.24.2 - slow-turn ack: no user should ever stare at silence while a
        // provider times out. v1.25.1 — 8s threshold, rotating copy and a 60s
        // anti-spam floor so it never feels like a metronome.
        const slowAckMs = resolveSlowAckMs(process.env);
        if (instantAckEnabled && !session.instantAckSent && !mediaObj && !session.quiz
          && !countryCommandResult && !weeklyReportToggleResult && slowAckMs > 0) {
          slowAckTimer = setTimeout(async () => {
            if (!shouldSendSlowAck({ turnFinalized, now: Date.now(), lastAckAt: session.lastSlowAckAt || 0 })) return;
            session.slowAckSent = true;
            session.lastSlowAckAt = Date.now();
            const line = pickSlowAckLine(session.slowAckCount || 0);
            session.slowAckCount = (session.slowAckCount || 0) + 1;
            try {
              await sendWhatsAppReply(senderPhone, line);
              if (supabaseClient) {
                await logAssistantTranscript(supabaseClient, senderPhone, line);
              }
            } catch { /* ack is best-effort */ }
          }, slowAckMs);
          if (typeof slowAckTimer.unref === 'function') slowAckTimer.unref();
        }


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
        } else if (weeklyReportToggleResult) {
          // v1.73.0 (Phase 10, P3-4) — deterministic weekly-report toggle/state.
          aiResult = weeklyReportToggleResult;
        } else {
          // Phase 3 — the Read Command Registry owns every deterministic read.
          // A matched lane returns its complete aiResult here; nothing below
          // can ever see the message (no accidental fall-through).
          // v1.68.0 — Phase 5B-3: the registry dispatch lives in ./reads.js.
          const readTurn = await dispatchReadTurn({ commandText, readCtx, quizForFastPath, quizPhaseLocked, session });
          if (readTurn) {
            aiResult = readTurn;
          } else if (receiptDeleteCommand) {
            // v1.69.0 — Phase 5B-4: the receipt-delete write lane lives in ./commands.js.
            aiResult = await handleReceiptDeleteTurn({ supabaseClient, profileData, existingVehicles, receiptDeleteCommand, senderPhone });
          } else {
            // v1.69.0 — Phase 5B-4: the AI turn (fast-quiz regex or provider call) lives in ./conversation.js.
            aiResult = await runSakaAiTurn({
              targetLang, messageText, conversationHistory, supabaseClient, activeVehicleContext,
              entitlements, profileData, planSummary, jurisdictionContext, session, senderPhone, dbHistory,
              userFactsContext, fastQuizTurn, loadReengagementContext
            });
          }
        }
        phaseMarks.aiDoneAt = Date.now();
        // v1.69.0 — Phase 5B-4: post-AI intent fixes + the reply seed live in ./conversation.js.
        const postAi = await applyPostAiIntentFixes({ aiResult, duplicateReceipt, messageText, readCtx, targetLang, countryInfo, profileData });
        aiResult = postAi.aiResult;
        let intent = postAi.intent;
        let customReply = postAi.reply;

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

        // --- SUPPORT ESCALATION FLOW (support@reports.sakafleet.com) ---
        // v1.69.0 — Phase 5B-4: the support intake flow lives in ./support.js.
        const supportFlow = await resolveSupportFlowTurn({
          session, messageText, hasVehicleRegistered, profileData, existingVehicles,
          senderPhone, supabaseClient, targetLang, countryInfo
        });
        const isSupportFlow = supportFlow.isSupportFlow;
        if (isSupportFlow) customReply = supportFlow.reply;

        if (!isSupportFlow) {

        let isSpecialFlowHandled = false;

        // 1. In-flight Passbook Transfer Handler (Current Owner Steps 2 & 3)
        if (session.transferFlow) {
          isSpecialFlowHandled = true;
          // v1.68.0 — Phase 5B-3: the in-flight transfer turn lives in ./pending.js.
          const transferTurn = await handleTransferFlowTurn({ session, messageText, supabaseClient, sendWhatsApp: sendWhatsAppReply, targetLang, countryInfo, profileData });
          customReply = transferTurn.reply;
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
          // v1.68.0 — Phase 5B-3: the assignment-OTP lane lives in ./pending.js.
          const otpTurn = await handleAssignmentOtpTurn({ session, messageText, supabaseClient, profileData, existingVehicles, targetVeh, sendWhatsApp: sendWhatsAppReply, targetLang, countryInfo });
          if (otpTurn) {
            isSpecialFlowHandled = true;
            customReply = otpTurn.reply;
          }
        }
        // 3. Buyer Email OTP Verification (Step 5)
        else if (session.pendingTransferBuyerOtp || (messageText.trim().match(/^\d{6}$/) && !session.quiz && !isCurrentlyOnboarding && !session.pendingEmailUpdate && !session.pendingDeleteVehicle && !session.pendingAccountDeletion && !onboardingStore.has(senderPhone))) {
          // v1.68.0 — Phase 5B-3: the buyer-OTP lane lives in ./pending.js.
          const buyerTurn = await handleBuyerOtpTurn({ session, messageText, supabaseClient, senderPhone, profileData, formattedPhone, entitlements, countryInfo, sendWhatsApp: sendWhatsAppReply });
          if (buyerTurn) {
            isSpecialFlowHandled = true;
            customReply = buyerTurn.reply;
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
            // v1.72.2 (Phase 9, P3-6) — deterministic trial-status aliases. A
            // separate `^…$` anchor: the trailing \b of the next line cannot
            // express the exact phrase, and "my trial ended…" must stay out.
            || /^(?:my\s+)?trial(?:\s+status)?[.!?]*$/i.test(messageText.trim())
            || /\b(?:my\s+(?:plan|subscription)|upgrade|subscribe|cancel\s+(?:my\s+)?(?:subscription|plan)|unsubscribe|keep\s+(?:vehicle|car)\b|extra\s+(?:car|vehicle|slot)|add[- ]?on|extend\s+(?:my\s+)?trial|which\s+tier|should\s+be\s+on|(?:less|fewer|more)\s+than\s+\d+\s+(?:assets?|vehicles?)|put\s+me\s+on|move\s+me\s+to|enroll\s+me|confirm\s+(?:which|what)\s+tier|what\s+tier\s+am\s+i)\b/i.test(messageText.trim()))) {
          isSpecialFlowHandled = true;
          // v1.68.0 — Phase 5B-3: the subscription/trial lane lives in ./pending.js.
          const subTurn = await handleSubscriptionTurn({
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
        // v1.69.0 — Phase 5B-4: the snapshot lives in ./commands.js.
        else if (!session.quiz && existingVehicles.length > 0
          && /^(?:passbook(?:\s+details)?|my\s+passbook|vehicle\s+snapshot)$/i.test(messageText.trim())) {
          const passbookTurn = await renderPassbookSnapshot({ supabaseClient, existingVehicles, currentActiveVehicle, entitlements, countryInfo });
          customReply = passbookTurn.reply;
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
          // v1.68.0 — Phase 5B-3: the pending capture lives in ./pending.js.
          const captureTurn = await handleComplianceCaptureTurn({ session, messageText, supabaseClient, profileData, existingVehicles, countryInfo });
          if (captureTurn) {
            isSpecialFlowHandled = true;
            customReply = captureTurn.reply;
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
        // v1.68.0 — Phase 5B-3: the pending multi-record batch lives in ./pending.js.
        const narrativeTurn = await handleNarrativeBatchTurn({
          session,
          messageText,
          narrativeBatchCardReply,
          quizCtx,
          mergedExt,
          targetLang,
          countryInfo,
          profileData
        });
        if (narrativeTurn) {
          if (narrativeTurn.handled) {
            isSpecialFlowHandled = true;
            customReply = narrativeTurn.reply;
            narrativeSuppressQuiz = true;
          }
          if (narrativeTurn.forcedFlow) {
            forcedNarrativeFlow = narrativeTurn.forcedFlow;
            narrativeExt = narrativeTurn.aiExtracted;
            quizCtx.aiExtracted = narrativeExt;
          }
        }

        // Quiz ↔ Conversation arbitration + turn (v1.68.0 — Phase 5B-3: ./quiz.js).
        // The GLOBAL circuit breaker (loop detection + SOFT/HARD trip) deliberately
        // stays here: it is a quiz-agnostic, final-reply-stage guard.
        const quizArbitration = await arbitrateQuizTurn({
          session,
          messageText,
          intent,
          mergedExt,
          narrativeExt,
          quizCtx,
          logbookPrefill,
          forcedNarrativeFlow,
          receiptQuizStart,
          narrativeSuppressQuiz,
          hasVehicleRegistered,
          targetLang,
          countryInfo,
          profileData,
          existingVehicles,
          senderPhone
        });
        if (quizArbitration.earlyHandled) {
          isSpecialFlowHandled = true;
          customReply = quizArbitration.earlyReply;
        } else {
          const quizOutcome = await finalizeQuizOutcome({
            quizTurn: quizArbitration.quizTurn,
            session,
            activeQuiz: quizArbitration.activeQuiz,
            gateRedirect,
            driverGate,
            profileData,
            onboardingStore,
            senderPhone,
            supabaseClient,
            targetLang,
            countryInfo,
            quizCtx,
            existingVehicles,
            mergedExt,
            historyLength: conversationHistory.length
          });
          if (quizOutcome?.handled) {
            isSpecialFlowHandled = true;
            customReply = quizOutcome.reply;
          }
        }

        // --- BRANCH A: TWO-STAGE PROGRESSIVE ONBOARDING FLOW (legacy fallback) ---
        if (!isSpecialFlowHandled && (
          isCurrentlyOnboarding ||
          (!hasVehicleRegistered && (intent === 'REGISTER_VEHICLE' || intent === 'ONBOARDING_INPUT' || intent === 'VERIFY_OTP' || isRegisterCommand || hasVehicleAttributes))
        )) {
          // v1.73.1 — Phase 11: the legacy onboarding lane lives in ./onboarding.js.
          const legacyOnboardingTurn = await handleLegacyOnboardingTurn({
            session, messageText, mergedExt, senderPhone, profileData, entitlements,
            existingVehicles, countryInfo, supabaseClient, targetLang, formattedPhone,
            onboardingStore, hasVehicleRegistered
          });
          customReply = legacyOnboardingTurn.reply;
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
                // v1.73.1 — Phase 11: the legacy registration starter lives in ./onboarding.js.
                const legacyRegistration = await startLegacyRegistrationFlow({
                  session, mergedExt, senderPhone, profileData, targetLang, countryInfo, onboardingStore
                });
                customReply = legacyRegistration.reply;
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
              // v1.68.0 — Phase 5B-3: the deletion confirmation gate lives in ./pending.js.
              const deleteTurn = await handleDeleteVehicleTurn({ session, messageText, profileData, supabaseClient, existingVehicles, targetLang, countryInfo });
              customReply = deleteTurn.reply;
            }
            else if (activeIntent === 'ASSIGN_DRIVER' || session.pendingDriverAssignment || /^(?:assign\s+driver|assign)\b/i.test(messageText)) {
              // v1.68.0 — Phase 5B-3: the driver-assignment lane lives in ./pending.js.
              const assignTurn = await handleDriverAssignmentTurn({ session, messageText, mergedExt, existingVehicles, targetVeh, profileData, supabaseClient, countryInfo, sendWhatsApp: sendWhatsAppReply, targetLang });
              customReply = assignTurn.reply;
            }
            else if (activeIntent === 'UNASSIGN_DRIVER' || /^unassign\s+driver/i.test(messageText.trim()) || /^remove\s+driver/i.test(messageText.trim())) {
              // v1.69.0 — Phase 5B-4: the unassign lane lives in ./commands.js.
              const unassignTurn = await handleUnassignDriverTurn({ mergedExt, messageText, existingVehicles, targetVeh, supabaseClient, targetLang, countryInfo, profileData });
              customReply = unassignTurn.reply;
            }
            else if (activeIntent === 'VIEW_PROFILE' || /^(?:view|show|display|see)\s+(?:my\s+)?(?:profile|account)|^my\s+profile\b|^profile\s+details$|^profile$|^account\s+details$|^who\s+am\s+i$/i.test(messageText.trim())) {
              // v1.69.0 — Phase 5B-4: the profile snapshot lane lives in ./commands.js.
              const profileTurn = await handleViewProfileTurn({ profileData, existingVehicles, senderPhone, formattedPhone, supabaseClient, countryInfo, targetLang });
              customReply = profileTurn.reply;
            }
            else if (activeIntent === 'EDIT_VEHICLE' || /^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(messageText.trim())) {
              // v1.69.0 — Phase 5B-4: the edit-vehicle lane lives in ./commands.js.
              const editTurn = await handleEditVehicleTurn({ mergedExt, messageText, existingVehicles, targetVeh, profileData, supabaseClient, targetLang, countryInfo });
              customReply = editTurn.reply;
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
              // v1.69.0 — Phase 5B-4: the switch-vehicle lane lives in ./commands.js.
              const switchTurn = await handleSwitchVehicleTurn({ mergedExt, messageText, existingVehicles, senderPhone, sessions: chatSessions, targetLang, countryInfo, profileData });
              customReply = switchTurn.reply;
              if (switchTurn.vehicle) targetVeh = switchTurn.vehicle;
            }
            else if (activeIntent === 'QUERY_FUEL_EFFICIENCY') {
              // v1.69.0 — Phase 5B-4: the fuel-efficiency lane lives in ./commands.js.
              const fuelTurn = await handleFuelEfficiencyTurn({ mergedExt, targetVeh, existingVehicles, supabaseClient, countryInfo });
              customReply = fuelTurn.reply;
            }
            else if (activeIntent === 'QUERY_FLEET_SUMMARY') {
              // v1.69.0 — Phase 5B-4: the fleet-summary lane lives in ./commands.js.
              const fleetTurn = await handleFleetSummaryTurn({ supabaseClient, profileData, existingVehicles, countryInfo });
              customReply = fleetTurn.reply;
            }
            else if (activeIntent === 'GREETING') {
              // v1.69.0 — Phase 5B-4: the greeting lane lives in ./commands.js.
              const greetingTurn = await handleGreetingTurn({ aiResult, targetVeh, existingVehicles, targetLang, countryInfo, profileData });
              customReply = greetingTurn.reply;
            }
            else if (activeIntent === 'LOG_EXPENSE') {
              // v1.69.0 — Phase 5B-4: the quick-log expense lane lives in ./commands.js.
              const expenseTurn = await handleLogExpenseTurn({ mergedExt, messageText, targetVeh, supabaseClient, profileData, senderPhone, countryInfo, targetLang, existingVehicles, sendWhatsApp: sendWhatsAppReply });
              customReply = expenseTurn.reply;
            }
            else if (activeIntent === 'UPDATE_MILEAGE') {
              // v1.69.0 — Phase 5B-4: the odometer lane lives in ./commands.js.
              const mileageTurn = await handleUpdateMileageTurn({ mergedExt, messageText, targetVeh, supabaseClient, senderPhone, profileData, existingVehicles, sendWhatsApp: sendWhatsAppReply });
              customReply = mileageTurn.reply;
            }
            else if (activeIntent === 'LOG_OPERATING_HOURS') {
              // v1.69.0 — Phase 5B-4: the hour-meter lane lives in ./commands.js.
              const hoursTurn = await handleOperatingHoursTurn({ mergedExt, messageText, targetVeh, supabaseClient, senderPhone, profileData, existingVehicles, sendWhatsApp: sendWhatsAppReply });
              customReply = hoursTurn.reply;
            }
            else if (activeIntent === 'LOG_EARNINGS') {
              // v1.69.0 — Phase 5B-4: the quick-log earning lane lives in ./commands.js.
              const earningTurn = await handleLogEarningsTurn({ mergedExt, messageText, targetVeh, supabaseClient, profileData, senderPhone, countryInfo, targetLang, existingVehicles });
              customReply = earningTurn.reply;
            }
            else if (activeIntent === 'SET_REMINDER') {
              // v1.69.0 — Phase 5B-4: the reminder prompt lives in ./commands.js.
              customReply = renderReminderPrompt({ targetVeh }).reply;
            }
            else if (activeIntent === 'REQUEST_REPORT') {
              // v1.69.0 — Phase 5B-4: the report-request lane lives in ./commands.js.
              const reportTurn = await handleReportRequestTurn({ mergedExt, messageText, supabaseClient, profileData, senderPhone, existingVehicles, targetVeh, entitlements, countryInfo, targetLang, queueReportFollowUp });
              customReply = reportTurn.reply;
              if (reportTurn.entitlements) entitlements = reportTurn.entitlements;
            }
            else if (activeIntent === 'MANAGE_VEHICLE' || activeIntent === 'LIST_VEHICLES') {
              // v1.69.0 — Phase 5B-4: the vehicle-list card lives in ./commands.js.
              customReply = renderVehicleList({ existingVehicles, targetVeh }).reply;
            }
            else if (session.pendingAccountDeletion) {
              // v1.68.0 — Phase 5B-3: the account-deletion verification lives in ./pending.js.
              const accountTurn = await handleAccountDeletionOtpTurn({ session, messageText, mergedExt, profileData, supabaseClient, senderPhone, onboardingStore, targetLang, countryInfo });
              customReply = accountTurn.reply;
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
              // v1.69.0 — Phase 5B-4: the profile-edit lane lives in ./commands.js.
              const profileEditTurn = await handleEditProfileTurn({ messageText, mergedExt, profileData, supabaseClient });
              customReply = profileEditTurn.reply;
            }
            else if (session.pendingEmailUpdate) {
              // v1.68.0 — Phase 5B-3: the email-update verification lives in ./pending.js.
              const emailOtpTurn = await handleEmailUpdateOtpTurn({ session, messageText, mergedExt, profileData, supabaseClient, targetLang, countryInfo });
              customReply = emailOtpTurn.reply;
            }
            else if (activeIntent === 'UPDATE_EMAIL' || /^(update|change)\s+email\b/i.test(messageText.trim())) {
              // v1.68.0 — Phase 5B-3: the email-update lane lives in ./pending.js.
              const emailStartTurn = await handleEmailUpdateStartTurn({ session, messageText, mergedExt, profileData, targetLang, countryInfo });
              customReply = emailStartTurn.reply;
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
              // v1.69.0 — Phase 5B-4: the active-user default lane lives in ./commands.js.
              customReply = (await renderActiveDefault({ aiResult, targetVeh, existingVehicles, targetLang, countryInfo, profileData })).reply;
            }
          }
        }

        // --- BRANCH C: UNREGISTERED / IDLE USER DEFAULT ---
        else if (!isSpecialFlowHandled) {
          // v1.69.0 — Phase 5B-4: the idle/unregistered conversation lanes live in ./conversation.js.
          const idleTurn = await renderIdleConversationTurn({
            session, messageText, intent, aiResult, firstContact, hasVehicleRegistered,
            profileData, existingVehicles, countryInfo, targetLang, supabaseClient, senderPhone, conversationHistory
          });
          customReply = idleTurn.reply;
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
        void recordTurnLatency({
          supabaseClient,
          phone: senderPhone,
          turnStartedAt,
          ackSent: session.instantAckSent === true || session.slowAckSent === true,
          phaseMarks
        });
        await userLogPromise;
        if (supabaseClient) {
          await Promise.all([
            finalizeAssistantTurn(supabaseClient, senderPhone, finalReply),
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
        void recordTurnLatency({
          supabaseClient,
          phone: messageObj?.from || null,
          turnStartedAt,
          ackSent: session?.slowAckSent === true
        });
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


