/**
 * Saka Fleet - WhatsApp quiz turn orchestration (Phase 5B-3 of the whatsapp.js split, v1.68.0).
 * -----------------------------------------------------------------------------------------
 * The processor-side quiz logic: the mid-quiz arbitration (switch command, statement park,
 * pause ladder, flow switch, logbook prefill), the quiz turn itself and the outcome wiring
 * (confirm-gate consumption, gate notice, the owner driver-profile chain, the contact-save
 * nudge and the delete-account teardown). The engine (src/services/quizEngine.js) stays the
 * only state machine; this module decides WHICH quiz turn happens and what the reply is.
 *
 * BOUNDARY CONTRACT (section 190): quiz.js is a leaf route module. It may import from
 * src/services/* and from ./helpers.js (a leaf that imports no route modules), but NEVER
 * from ./messages.js. It takes state as arguments and returns data; the processor performs
 * every send and owns every final-reply decision.
 *
 * SEPARATION (locked decision, rule 58): the GLOBAL circuit breaker (loop detection +
 * SOFT/HARD trip) deliberately STAYS in messages.js - it is a quiz-agnostic, final-reply-
 * stage guard. quiz.js owns only the quiz PAUSE ladder (`buildPausedQuizReply`).
 *
 * quiz.js -> pending.js has NO edge today. Composite flows that need a pending decision
 * receive it as an argument from the processor; a future one-way quiz.js -> pending.js
 * import is reserved but unnecessary.
 */

import {
  handleQuizTurn,
  shouldPauseQuizForChat,
  getCurrentQuizField,
  detectFlowSwitch,
  getFlowDefinition,
  markQuizTurn,
  abandonQuiz,
  // v1.89.2 — a one-line edit command ("edit KAS 628T nickname to Teddy")
  // prefills the edit_vehicle flow instead of re-asking what is already said.
  parseVehicleEditRequest
} from '../../services/quizEngine.js';
import { renderActionDiscovery, composeMessage } from '../../services/conversationEngine.js';
import { buildConversationMemory } from '../../services/conversationMemory.js';
import { sanitizeSakaReply } from '../../services/productQa.js';
import { shouldSuggestContactSave, buildContactSaveFacts, markContactSaveSuggested } from '../../services/contactNudge.js';
import { buildRoleContext } from './helpers.js';

/**
 * The role/action discovery reply (moved verbatim from messages.js L188-199). It lives
 * here because the quiz pause ladder renders it; the processor imports it back for the
 * action-discovery lanes (a one-way messages.js -> quiz.js edge).
 */
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

/**
 * The quiz pause ladder (moved verbatim from the inline `buildPausedQuizReply`,
 * messages.js L1871-1921). A help request gets discovery + a one-line nudge back;
 * anything else gets ONE AI call that answers the interruption and re-asks the pending
 * question exactly once.
 */
async function buildPausedQuizReply(quizState, { messageText, intent, quizCtx, targetLang, countryInfo, profileData, existingVehicles, senderPhone }) {
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
}


/**
 * v1.87.4 — WHICH quiz a receipt photo starts. Pure so the rule is provable offline.
 *
 * Live 2026-11-09 walkthrough: the old condition required the AI classifier to
 * return `LOG_EXPENSE` for a bare receipt photo. It did not, so the vaulted
 * receipt id (`receiptPrefill`) never rode the draft; Saka answered narratively
 * ("type fuel 3,000 KES at [litres] L"), the user's typed reply opened a FRESH
 * expense quiz, and the confirmed expense saved with `receipt_id = NULL` — the
 * records page could not link the receipt image.
 *
 * Contract:
 *  - A freshly VAULTED receipt (`hasReceiptPrefill`) ALWAYS opens the expense
 *    quiz, whatever intent the classifier chose — receipts confirm before any
 *    write (v1.49.3) and the prefill is the only carrier of the durable link.
 *  - No prefill (duplicate / unreadable / Free-tier dedupe) keeps the legacy
 *    rule: an explicit expense intent still starts the quiz, anything else does
 *    not — a duplicate receipt must never silently open a second draft.
 *  - Non-receipt media keeps whatever the normal detector decided.
 */
export function receiptQuizStartFor({
  hasMedia = false,
  isReceiptDocument = false,
  intent = null,
  quizStartFlow = null,
  hasReceiptPrefill = false,
  isDuplicateReceipt = false
} = {}) {
  if (!hasMedia || !isReceiptDocument) return quizStartFlow || null;
  if (hasReceiptPrefill) return 'log_expense';
  // v1.96.2 — a FRESH receipt with no vault row (storage unavailable, a bucket
  // write failure, or a Free-tier read-only vault) is still a receipt: it opens
  // the confirmation quiz so a photo-only turn can never be answered as a
  // ledger query (live 2026-11-10: five re-sends answered "Nothing under fuel +
  // repairs expenses ... yet"). Only a DUPLICATE stays out — a re-send must
  // never open a second draft.
  if (isDuplicateReceipt) return intent === 'LOG_EXPENSE' ? 'log_expense' : (quizStartFlow || null);
  return 'log_expense';
}

/**
 * v1.96.2 — a mid-quiz reply may never claim a save. Live 2026-11-10: the
 * receipt turn answered "Saved the fuel expense. ✓ How many litres did you put
 * in?" while nothing had been written (the confirmation card came later). The
 * engine's own "Logged ✓" card is untouched: it only composes on a COMPLETED
 * flow, and this filter only runs while the draft is still open.
 */
export function stripPrematureSaveClaim(text = '') {
  return String(text || '')
    // A claim sentence that ends the line ("Saved the fuel expense. ✓").
    .replace(/^[^\S\n]*(?:✅\s*)?(?:saved|logged|recorded)\b[^\n]*[.!✓]\s*$/gim, '')
    // A short standalone claim without punctuation ("Saved ✓").
    .replace(/^[^\S\n]*(?:✅\s*)?(?:saved|logged|recorded)\b[^\n]{0,40}$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Quiz <-> Conversation arbitration + the quiz turn (moved verbatim from messages.js
 * L1856-2002). Returns `{ quizTurn, earlyHandled, earlyReply, activeQuiz }`:
 *   - earlyHandled:true  the turn was answered without handing it to the engine
 *                        (statement park or pause ladder); earlyReply is the reply.
 *   - quizTurn           the engine result (handled / pausedForChat / completed / flow).
 * The processor turns the returned data into `isSpecialFlowHandled`/`customReply`.
 */
export async function arbitrateQuizTurn({
  session,
  messageText,
  intent,
  mergedExt,
  narrativeExt,
  quizCtx,
  logbookPrefill = null,
  // v1.81.0 (Phase 20) — the vaulted receipt id ({ receipt_id }) carried through
  // the engine-only prefill seam (never user text, never AI output).
  receiptPrefill = null,
  // v1.84.0 (Phase 23) — the vaulted DOCUMENT id ({ document_id }) rides the
  // same seam so a registration quiz can link its stored certificate.
  documentPrefill = null,
  forcedNarrativeFlow = null,
  receiptQuizStart = null,
  narrativeSuppressQuiz = false,
  hasVehicleRegistered = false,
  targetLang,
  countryInfo,
  profileData,
  existingVehicles = [],
  senderPhone = null
}) {
  const replyCtx = { messageText, intent, quizCtx, targetLang, countryInfo, profileData, existingVehicles, senderPhone };

  // v1.89.2 — a deterministic edit prefill. When the edit_vehicle flow starts,
  // the sentence itself supplies the field (and the value when it is stated):
  // "edit KAS 628T nickname to Teddy" runs the whole flow in one turn instead of
  // re-asking what the user just said.
  const editPrefillFor = (flow) => (flow === 'edit_vehicle'
    ? parseVehicleEditRequest(messageText, { vehicles: existingVehicles })
    : {});

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

  let quizTurn = { handled: false };
  let earlyHandled = false;
  let earlyReply = null;
  // v1.58.22 - a request/statement mid-draft is never an answer to the
  // pending question. Live 2026-11-04: "For parts entry, I should be able
  // to identify which part incurred the expense" was re-asked 7 times.
  const statementEscapeRe = /\b(?:should be able to|why can(?:no|'|’)?t i|why can i not|why do i (?:not|n'?t)|i want to be able to|not captured|add a feature|to be able to|i can(?:no|'|’)?t\s+(?:label|add|see|find|edit|change|get|set))\b/i;
  if (session.quiz && statementEscapeRe.test(messageText) && !pauseQuizForChat && !switchQuizFlow) {
    const parkedFlow = getFlowDefinition(session.quiz.flow, quizCtx)?.label || session.quiz.flow;
    abandonQuiz(session, { reason: 'statement_not_answer' });
    earlyHandled = true;
    earlyReply = `Thanks — I've noted this: “${messageText.trim().slice(0, 180)}”\n\nI've parked your ${parkedFlow} draft so nothing is lost. Reply *Support* to pass this to our team (support@reports.sakafleet.com), or tell me what you'd like to do next.`;
  } else if (pauseQuizForChat) {
    earlyHandled = true;
    earlyReply = await buildPausedQuizReply(activeQuiz, replyCtx);
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
      prefill: editPrefillFor(switchQuizFlow),
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
    // v1.84.0 (Phase 23) — the vaulted document id rides the same engine-only
    // prefill so the compliance seeds can link the stored file.
    quizTurn = await handleQuizTurn({
      session,
      messageText: '',
      aiExtracted: {},
      startFlow: 'vehicle_registration',
      prefill: { ...(logbookPrefill || {}), ...(documentPrefill || {}) },
      ctx: quizCtx
    });
  } else if (receiptPrefill && !session.quiz && receiptQuizStart === 'log_expense' && !forcedNarrativeFlow) {
    // v1.81.0 (Phase 20, PROP-2026-11-08-01) — a freshly vaulted receipt starts
    // the expense quiz with its durable link already banked in the draft. The
    // link rides `prefill` (engine data only); the user never sees a new
    // question and AI output can never inject the field.
    quizTurn = await handleQuizTurn({
      session,
      messageText,
      aiExtracted: narrativeExt,
      startFlow: receiptQuizStart,
      prefill: receiptPrefill,
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
          prefill: editPrefillFor(forcedNarrativeFlow || receiptQuizStart),
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

  return { quizTurn, earlyHandled, earlyReply, activeQuiz };
}


/**
 * Quiz outcome wiring (moved verbatim from messages.js L2004-2096): the pause reply for
 * a mid-turn pause, the confirm-gate consumption (`quizTurn.handled`), the gate notice,
 * the driver-onboarding flag, the vehicle-registration state transition + owner driver
 * profile chain, the once-only contact-save nudge and the delete-account teardown.
 * Returns `{ handled, reply }` or null when the quiz did not own the turn.
 */
export async function finalizeQuizOutcome({
  quizTurn,
  session,
  activeQuiz,
  gateRedirect = false,
  driverGate = null,
  profileData,
  onboardingStore,
  senderPhone,
  supabaseClient,
  targetLang,
  countryInfo,
  quizCtx,
  existingVehicles = [],
  mergedExt = {},
  historyLength = 0
}) {
  let handled = false;
  let reply = null;

  if (quizTurn.pausedForChat) {
    handled = true;
    reply = await buildPausedQuizReply(session.quiz, {
      messageText: quizCtx?.messageText,
      intent: quizCtx?.intent,
      quizCtx,
      targetLang,
      countryInfo,
      profileData,
      existingVehicles,
      senderPhone
    });
  } else if (quizTurn.handled) {
    handled = true;
    const gateNotice = gateRedirect && !activeQuiz
      ? `🔒 *Finish your driver profile first*\n\nSaka needs to verify your email and your ${driverGate?.status?.catalog?.minimal?.label || 'driving licence'} so it can remind you before it expires. This protects you and the vehicle owner.\n\n`
      : '';
    reply = `${gateNotice}${quizTurn.reply}`;
    // v1.96.2 — an open draft never claims a save (the confirmation gate owns
    // that sentence). Completed flows keep their verified "Logged ✓" card.
    if (!quizTurn.completed) reply = stripPrematureSaveClaim(reply);

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
            reply = `${quizTurn.reply}\n\n👤 *One quick thing — your own driver profile*\n\n${driverIntro.reply}`;
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
            { historyLength }
          );
          reply = `${reply}\n\n${contactLine}`;
          session.contactSaveNudged = true;
          if (supabaseClient) markContactSaveSuggested(supabaseClient, profileData?.id).catch(() => {});
        } catch { /* the nudge is best-effort and never blocks registration */ }
      }
    }
  }

  if (quizTurn.completed && quizTurn.flow === 'delete_account') {
    session.state = 'IDLE';
    session.active_vehicle_id = null;
    session.history = [];
  }

  return handled ? { handled: true, reply } : null;
}
