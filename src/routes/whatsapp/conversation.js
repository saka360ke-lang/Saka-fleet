/**
 * Saka Fleet - WhatsApp AI conversation turn (Phase 5B-4 of the whatsapp.js split, v1.69.0).
 * ---------------------------------------------------------------------------------------
 * The AI turn (fast-quiz regex or the provider call), the post-AI intent fixes and the idle /
 * unregistered conversation lanes (user_data_answer, complaint recovery, feedback, friction,
 * greeting, first-time lanes) moved verbatim out of the processor.
 *
 * BOUNDARY CONTRACT (section 191): leaf route module - src/services/*, sakaAi.js and
 * ./helpers.js only. Never ./messages.js. `loadReengagementContext` is passed in from the
 * processor (it lives in ./hooks.js, a route module). The GLOBAL circuit breaker stays in the
 * processor: it consumes this module's output, never the other way round.
 */

import { processSakaMessage, classifyIntentWithRegex } from '../../../sakaAi.js';
import { composeMessage } from '../../services/conversationEngine.js';
import { looksLikeReportRequest } from '../../services/quizEngine.js';
import { buildConversationMemory } from '../../services/conversationMemory.js';
import { matchProductQa, buildProductFactsContext, buildLocalPricingFacts, stripUsdFigures, sanitizeSakaReply } from '../../services/productQa.js';
import { buildUserContextSnapshot, buildUserFactsLines } from '../../services/userContextSnapshot.js';
import { sakaIntroText, isLegacyWelcomeCopy, isIncompleteReplyComplaint, replyContinuationRequestFor, asksToUploadLogbook, websiteSignupNextStep } from '../../services/greetings.js';
import { recordFriction } from '../../services/frictionTracker.js';
import { checkIsConversationalFeedback } from './helpers.js';

/* ------------------------------------------------------------------ */
/* 1. the AI turn (fast-quiz regex or the provider call)               */
/* ------------------------------------------------------------------ */

export async function runSakaAiTurn({ targetLang, messageText, conversationHistory, supabaseClient, activeVehicleContext, entitlements, profileData, planSummary, jurisdictionContext, session, senderPhone, dbHistory, userFactsContext, fastQuizTurn, loadReengagementContext }) {
  let aiResult;
  if (fastQuizTurn) {
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
      reengagementContext: await loadReengagementContext({
        supabaseClient,
        senderPhone,
        hasFreshHistory: dbHistory.length > 0
      })
    });
  }
  return aiResult;
}

/* ------------------------------------------------------------------ */
/* 2. post-AI intent fixes + the reply seed                            */
/* ------------------------------------------------------------------ */

export async function applyPostAiIntentFixes({ aiResult, duplicateReceipt, messageText, readCtx, targetLang, countryInfo, profileData }) {
  let intent = aiResult.intent;
  // v1.58.6 — a clear past-tense expense statement ("Repaired a puncture,
  // cost me 300kes") is LOGGED, never answered as a query, even if the
  // classifier hedged (live 2026-11-04: it kept replying "Nothing logged").
  if (readCtx.recordSpec.question.reason === 'looks-like-log' && !['LOG_EXPENSE', 'LOG_EARNINGS'].includes(intent)) {
    intent = 'LOG_EXPENSE';
  }
  // v1.96.2 — "Add fuel record" / "record fuel" are log COMMANDS: route the
  // write lane explicitly (an earnings word keeps its own lane).
  if (readCtx.recordSpec.question.reason === 'log-command' && !['LOG_EXPENSE', 'LOG_EARNINGS'].includes(intent)) {
    intent = /\b(?:earn(?:ing|ings)?|income|revenue|takings?|fares?)\b/i.test(messageText)
      ? 'LOG_EARNINGS'
      : 'LOG_EXPENSE';
  }
  let reply = aiResult.reply_message;

  // v1.36.0 — a QUERY_RECORDS message the engine could not parse gets a
  // deterministic nudge instead of an AI answer (figures are never invented).
  if (intent === 'QUERY_RECORDS' && !aiResult.__deterministicRecords) {
    reply = await composeMessage({
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

  // v1.96.2 — a complaint about what just happened is never a fresh expense
  // draft. Live 2026-11-10: "Kindly ensure this never happens again. Never miss
  // to link a receipt" started an expense quiz instead of acknowledging it.
  if (/(?:ensure|make\s+sure)\s+(?:this|that|it)\s+never\s+happens\s+again|\bnever\s+miss\s+(?:to\s+)?(?:link|attach|send)|\byou\s+(?:saved|logged|did)\s+(?:it|that|this)\s+wrong\b|\byou\s+keep\s+(?:making|doing)\b/i.test(String(messageText || ''))) {
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
  return { aiResult, intent, reply };
}

/* ------------------------------------------------------------------ */
/* 3. idle / unregistered conversation lanes (Branch C)                */
/* ------------------------------------------------------------------ */

export async function renderIdleConversationTurn({ session, messageText, intent, aiResult, firstContact, hasVehicleRegistered, profileData, existingVehicles, countryInfo, targetLang, supabaseClient, senderPhone, conversationHistory }) {
  let reply;
  const productQaMatch = matchProductQa(String(messageText || '').trim());
  const clean = messageText.trim().toLowerCase();

  // 1. User asks to pause / stop
  if (/^(stop|pause|halt|quiet|exit|cancel)$/i.test(clean)) {
    reply = await composeMessage({
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
    reply = await composeMessage({
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
    reply = await composeMessage({
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
    reply = (recoveryDetail.stoppedAtCap && recoveryTotal)
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
    reply = await composeMessage({
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
    reply = sanitizeSakaReply(
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
    reply = await composeMessage({
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
      reply = sakaIntroText({ countryInfo, profile: profileData, nextStep: unverified ? websiteSignupNextStep() : null });
      session.sakaIntroduced = true;
    } else if (!unverified && !hasVehicleRegistered) {
      // v1.58.11 — a verified user with no vehicle already met Saka on the
      // web: ADVANCE to the first vehicle, never re-introduce (live 2026-11-04).
      reply = `Hi${firstName ? ` ${firstName}` : ''}! 👋 You're all set ✅ — what do you drive? One line is enough, e.g. *"Toyota Probox"*.`;
    } else {
      reply = aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant') && !isLegacyWelcomeCopy(aiResult.reply_message)
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
    reply = aiResult.reply_message;
  }
  // 5. Default: AI-rendered single next step
  else {
    const unverified = !profileData || profileData.email_verified !== true;
    reply = await composeMessage({
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
  return { reply };
}
