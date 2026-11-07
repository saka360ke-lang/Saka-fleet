import { matchProductQa, buildProductQaReply, buildLocalPricingFacts, stripUsdFigures, hasLocalFigure, recommendTierForFleet, sanitizeSakaReply } from './productQa.js';
import { buildUserContextSnapshot } from './userContextSnapshot.js';
import { isOdometerQuestion, buildOdometerAnswer } from './odometerAnswer.js';
import { buildDriverComplianceCard } from './driverReports.js';
import { buildVehicleSummary, emailVehicleSummary } from './vehicleSummary.js';
import {
  loadCountryBucket,
  formatCountryRulesReply,
  formatRequiredDocumentsReply,
  formatExampleComplianceReply
} from './countryBucket.js';
import { DOCUMENT_SUPPORT_MENU } from './documentLens.js';
import { listReceipts, formatReceiptsReply, pageReceipts, RECEIPT_PAGE_SIZE, RECEIPT_MAX_OFFSET } from './receipts.js';
import {
  resolveLedgerTurn,
  resolveLedgerVehicleScope,
  ledgerEntryKey,
  formatLedgerList,
  formatEditPreview,
  formatDeleteConfirm,
  formatEntryRelogged,
  formatEntryDeleted,
  formatEntryRestored,
  formatRestoreEmpty,
  formatNoEntryForSelection,
  paginationCursorActive,
  ENTRY_LIST_LIMIT,
  ENTRY_PAGE_SIZE,
  ENTRY_MAX_OFFSET,
  ENTRY_RESTORE_WINDOW_MINUTES
} from './entryAnswers.js';
import {
  listLedgerEntries,
  getLedgerEntry,
  relogLedgerEntry,
  deleteLedgerEntry,
  restoreLastDeleted
} from './entryLedger.js';
import {
  detectRemindersListCommand,
  detectComplianceStatusCommand,
  detectComplianceExpiryQuestion,
  detectDriverComplianceRead,
  detectAllDocumentsExpiryRead,
  detectComplianceNumberSearch,
  buildDriverComplianceReply,
  buildAllDocumentsExpiryReply,
  buildComplianceNumberSearchReply,
  detectComplianceCorrection,
  detectComplianceItemAsked,
  detectMaintenanceScheduleQuestion,
  detectMaintenancePart,
  buildMaintenanceScheduleAnswer,
  buildComplianceExpiryAnswer,
  buildComplianceStatusReply,
  buildRemindersListReply,
  applyComplianceCorrection,
  formatComplianceDate
} from './complianceAnswers.js';
import { parseRecordQuestion, formatRecordAnswer, isRecordChallenge, buildRecordChallengeScopeLine } from './recordAnswers.js';
import { queryRecordLedger } from './recordQuery.js';
import { searchOtherLabels, formatOtherLabelMatches } from './labelsEverywhere.js';
import { composeMessage } from './conversationEngine.js';
import { resolveUserTimezone } from './globalization.js';
import { isSuperadminPhone } from './superadmin.js';

/**
 * Saka Fleet — Read Command Registry (Phase 3, v1.63.3)
 * ----------------------------------------------------
 * ONE ordered registry for every deterministic command lane that used to be an
 * implicit if/else chain in `src/routes/whatsapp.js` (lines 1677-2234).
 *
 * The order below is the OLD DISPATCH PRECEDENCE, verbatim (plus the v1.72.2
 * `subscription_status` lane placed ahead of product QA and the v1.73.0
 * `my_ticket` lane beside it, and the v1.73.0 `pagination_more` lane LAST):
 *   help → subscription status → my ticket → product QA → country knowledge →
 *   vehicle summary → upload menu → empty garage → compliance family (all docs /
 *   number search → driver docs → correction → expiry → status → maintenance →
 *   reminders) → ledger → odometer → driver profile → records → receipts → more.
 * Detection order in the old preamble differed from dispatch order; the
 * registry deliberately follows DISPATCH order (see test_read_registry.js,
 * which pins every lane against a frozen copy of the old chain).
 *
 * Kept OUT of the registry on purpose (they stay inline in the route):
 *   ocrPaused guard, country command (a profile write), receipt delete (a
 *   write), fast quiz turns and the AI fallback.
 *
 * A matched lane OWNS its turn. `resolveReadCommand()` returns an augmented
 * lane whose `render(ctx)` returns the complete `aiResult`; the route awaits
 * it and never lets another read lane see the message.
 */

// ── Inline detectors moved verbatim out of the route ───────────────────────
const HELP_MENU_RE = /^(?:help|menu|options|what can you do|what can i do|how (?:do i|can i) (?:use|start|begin))\s*\??$/i;
const SUMMARY_RE = /(?:(?:send|email|resend|share|mail)\b[\s\S]{0,40}(?:registration|vehicle|passbook)\b[\s\S]{0,20}(?:summary|details|copy|pdf|email))|(?:registration|vehicle)\s+(?:summary|details|passbook)/i;
const UPLOAD_MENU_RE = /^(?:upload|send|share|scan)\s+(?:a\s+)?(?:document|doc|documents|photo|file|files)s?$|^what\s+(?:documents?|files?)\s+(?:can|may|do)\s+(?:i|you)\s+(?:send|upload|accept)\b|^(?:documents?|docs?)\s+(?:list|supported)$/i;
const VEHICLES_RE = /^(?:(?:list|show|view)\s+)?(?:my\s+)?(?:cars|vehicles|fleet)$|^(?:vehicle|car)\s+list$|^manage\s+(?:my\s+)?(?:vehicles?|cars?)$/i;
const MY_RULES_RE = /^(?:my\s+rules?|country\s+rules?|what\s+(?:are\s+)?my\s+rules?|compliance\s+rules?)$/i;
const REQUIRED_DOCS_RE = /^(?:required\s+(?:documents?|docs?)|what\s+documents?\s+do\s+i\s+need|my\s+document\s+requirements?)$/i;
const EXAMPLE_COMPLIANCE_RE = /^(?:example\s+(?:compliance|document|submission)|give\s+me\s+an\s+example|example\s+text)$/i;
const DRIVER_PROFILE_RE = /^(?:(?:show|see|view|open|check|what(?:'s| is))\s+(?:me\s+)?(?:my\s+)?(?:own\s+)?(?:personal\s+)?driver(?:'s|’s|s)?\s+(?:profile|licen[cs]e|record|card|compliance)|(?:my|our|personal|own)\s+driver(?:'s|’s|s)?\s+(?:profile|licen[cs]e|record|card|compliance)|(?:my\s+)?personal\s+compliance)\b/i;

function result(reply, intent = 'GENERAL_CHAT') {
  return { intent, extracted_data: {}, reply_message: reply };
}

// v1.73.0 (Phase 10, P3-1) — the list-continuation grammar, shared by the
// `pagination_more` lane and the records guard below.
const PAGINATION_MORE_RE = /^(?:more|next(?: page)?|older|show (?:me )?(?:more|next page|older))$/i;

// ── Shared context helpers ─────────────────────────────────────────────────
/** The exact records spec the old preamble computed (1538-1551). */
export function inspectRecordQuestion(text, ctx = {}) {
  const t = String(text || '').trim();
  // v1.73.0 (Phase 10, P3-1 / A1) — a list-continuation phrase ("show me
  // more") is a PAGINATION turn, never a records question: the records lane
  // used to answer it with a degenerate ledger list. With a fresh cursor the
  // pagination lane owns it; without one it falls through to the AI.
  if (PAGINATION_MORE_RE.test(t)) {
    return { challenge: null, question: { ok: false }, lastRecordQuery: ctx.session?.lastRecordQuery || null };
  }
  const nowMs = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const lastRecordQuery = ctx.session?.lastRecordQuery
    && (nowMs - Number(ctx.session.lastRecordQuery.at || 0) <= 15 * 60 * 1000)
    ? ctx.session.lastRecordQuery
    : null;
  const challenge = !ctx.quizPhaseLocked && lastRecordQuery?.spec && isRecordChallenge(t)
    ? { ...lastRecordQuery.spec, ok: true, challenge: true }
    : null;
  const question = ctx.quizPhaseLocked
    ? { ok: false }
    : (challenge || parseRecordQuestion(t, {
      countryCode: ctx.countryInfo?.country_code || 'GLOBAL',
      locale: ctx.countryInfo?.locale || 'en-US'
    }));
  return { challenge, question, lastRecordQuery };
}

/**
 * The OLD parking preamble (1515-1568) as one pure decision:
 * the FIRST matching parking detector wins the recorded abandon reason.
 * Returns the reason or null. Only ever parks when a fast quiz turn exists
 * and no PIN/OTP phase is locked.
 */
export function computeParking(text, ctx = {}) {
  const t = String(text || '').trim();
  if (!t || ctx.quizPhaseLocked || !ctx.quizForFastPath) return null;
  const family = detectRemindersListCommand(t)
    || detectComplianceStatusCommand(t)
    || detectComplianceExpiryQuestion(t)
    || detectComplianceCorrection(t).isCorrection
    || detectMaintenanceScheduleQuestion(t)
    || ((ctx.session?.pendingComplianceCapture) ? null : detectDriverComplianceRead(t))
    || detectAllDocumentsExpiryRead(t)
    || detectComplianceNumberSearch(t);
  if (family) return 'deterministic_read_command';
  if (resolveLedgerTurn({ pending: ctx.session?.pendingEntryAction || null, text: t }).type !== 'none') return 'ledger_command';
  if (inspectRecordQuestion(t, ctx).question.ok) return 'record_query';
  if (isOdometerQuestion(t)) return 'odometer_query';
  if (DRIVER_PROFILE_RE.test(t)) return 'driver_profile_read';
  return null;
}

/** True for "send me registration summary as PDF" (also suppresses the feature notice). */
export function isVehicleSummaryCommand(text = '') {
  return SUMMARY_RE.test(String(text || ''));
}

/** The OLD target-vehicle derivation (1830-1832): owned vehicles only. */
function ownedTargetVehicle(ctx = {}) {
  const owned = (ctx.vehicles || []).filter((vehicle) => vehicle.owner_id === ctx.profile?.id);
  return owned.find((vehicle) => vehicle.id === ctx.activeVehicle?.id)
    || (owned.length === 1 ? owned[0] : owned[0] || null);
}

function noVehicleReply(ctx = {}) {
  const plate = ctx.countryInfo?.plate_example || 'KDA 123A';
  return `🚗 I do not have a vehicle on file yet.\n\nSend the plate (e.g. *${plate}*) to register it, then I can track compliance and reminders.`;
}

/** Both compliance ledgers, exactly as the old merged branch fetched them. */
async function loadBothComplianceLedgers(ctx = {}) {
  const vehicleIds = (ctx.vehicles || []).map((vehicle) => vehicle.id).filter(Boolean);
  let vehicleRows = [];
  if (vehicleIds.length && ctx.supabaseClient) {
    try {
      const { data } = await ctx.supabaseClient
        .from('vehicle_compliances')
        .select('vehicle_id,type,label,number,expiry,lifetime')
        .in('vehicle_id', vehicleIds)
        .limit(200);
      vehicleRows = data || [];
    } catch { vehicleRows = []; }
  }
  let driverRows = [];
  try {
    if (ctx.supabaseClient && ctx.profile?.id) {
      const { data } = await ctx.supabaseClient
        .from('driver_compliances')
        .select('type,label,number,expiry,lifetime')
        .eq('driver_id', ctx.profile.id)
        .limit(50);
      driverRows = data || [];
    }
  } catch { driverRows = []; }
  return { vehicleRows, driverRows };
}

async function loadDriverRows(ctx = {}) {
  try {
    if (!ctx.supabaseClient || !ctx.profile?.id) return [];
    const { data } = await ctx.supabaseClient
      .from('driver_compliances')
      .select('type,label,number,expiry,lifetime')
      .eq('driver_id', ctx.profile.id)
      .limit(50);
    return data || [];
  } catch { return []; }
}

// ── The ordered registry ───────────────────────────────────────────────────
export const READ_COMMANDS = Object.freeze([
  {
    id: 'help_menu',
    parksQuiz: false,
    skipWhenLocked: false,
    detect: (text) => HELP_MENU_RE.test(text),
    render: async () => result('🙂 Quick tour:\n\n' +
      '• *REGISTER* — add your machine\n' +
      '• "Logged 40L at 50350 km for KES 5500" — fuel in one line\n' +
      '• *reminders* — what\'s due soon\n' +
      '• *report* — this month\'s numbers\n' +
      '• *pricing* — plans and your free trial\n\n' +
      '_Where shall we start?_ 🚗', 'APP_HELP')
  },
  {
    // v1.72.2 (Phase 9, P3-6) — deterministic trial-status aliases. The
    // engine-owned billing handler renders the plan/trial summary (zero AI
    // tokens); this lane only routes the intent. The exact-phrase `$` anchor
    // keeps "my trial ended…", "extend my trial" and "trial extension" out, so
    // the trial-end decision window and EXTEND_TRIAL keep their own turns.
    id: 'subscription_status',
    parksQuiz: false,
    skipWhenLocked: true,
    detect: (text) => /^(?:my\s+)?trial(?:\s+status)?[.!?]*$/i.test(String(text || '').trim()),
    render: async (hit, ctx = {}) => {
      if (!ctx.profile?.id) {
        // Ownerless session: keep today's marketing trial card, never a null reply.
        return result(buildProductQaReply(matchProductQa('trial')), 'GENERAL_CHAT');
      }
      return { intent: 'VIEW_SUBSCRIPTION', extracted_data: {}, reply_message: null };
    }
  },
  {
    id: 'product_qa',
    parksQuiz: false,
    skipWhenLocked: false,
    detect: (text) => matchProductQa(text),
    render: async (hit, ctx = {}) => {
      const productQaMatch = hit;
      const productFacts = buildProductQaReply(productQaMatch);
      const messageText = String(ctx.messageText || '');
      const fleetCountMatch = messageText.match(/\b(\d{1,3})\s*(?:cars?|vehicles?|units?|machines?|trucks?|bikes?|motorbikes?|matatus?|lorries?|pickups?)\b/i);
      const fleetCount = fleetCountMatch ? Number(fleetCountMatch[1]) : null;
      const planTopic = ['pricing', 'packages', 'tier_details', 'addons', 'limits'].includes(productQaMatch.id);
      const recommendation = fleetCount && planTopic ? recommendTierForFleet(fleetCount) : null;
      const countryInfo = ctx.countryInfo;
      let localPricingFacts = null;
      if (planTopic && countryInfo?.currency && String(countryInfo.currency).toUpperCase() !== 'USD') {
        try {
          localPricingFacts = await buildLocalPricingFacts({
            supabase: ctx.supabaseClient,
            currency: countryInfo.currency,
            locale: countryInfo.locale,
            fleetCount
          });
        } catch { localPricingFacts = null; }
      }
      const usdFree = (line) => !/\$|\bUSD\b/i.test(String(line || ''));
      const verifiedFactLines = localPricingFacts ? productFacts.split('\n').filter(usdFree) : productFacts.split('\n');
      const recommendationLines = recommendation
        ? recommendation.lines.filter((line) => !localPricingFacts || usdFree(line))
        : [];
      let userFacts = '';
      try {
        const snapshot = await buildUserContextSnapshot({
          supabase: ctx.supabaseClient,
          profile: ctx.profile,
          vehicles: ctx.vehicles || [],
          currency: countryInfo?.currency || 'USD'
        });
        userFacts = snapshot.lines.join('\n');
      } catch { userFacts = ''; }
      const fallbackAnswer = [...verifiedFactLines, ...recommendationLines, ...(localPricingFacts || [])].join('\n');
      const composedAnswer = await composeMessage({
        purpose: 'product_answer',
        facts: {
          userQuestion: messageText,
          topic: productQaMatch.id,
          verifiedFacts: fallbackAnswer,
          localPricingFacts: localPricingFacts ? localPricingFacts.join('\n') : 'None supplied — use the verified facts above.',
          userDataFacts: userFacts || 'No account data on file yet.',
          accountVehicles: (ctx.vehicles || []).length,
          instruction: localPricingFacts
            ? 'Answer the user\'s question in 1-3 short conversational lines using ONLY the verified facts. Quote ONLY the local-currency figures supplied in localPricingFacts. NEVER mention $, USD or any dollar amount, not even in brackets. Never use the word "plate" — say "registration number". If accountVehicles is 0, end by inviting REGISTER — never ask the user to send a registration number directly. For features or package questions, give the concrete list from the facts (up to 4 short lines). If the user gave a fleet size, use the computed local total exactly. Warm and human, at most one emoji per line. End with ONE gentle next step. Do not paste a menu, do not repeat the question back, and never say you do not have information — the facts above are complete.'
            : 'Answer the user\'s question in 1-3 short conversational lines using ONLY the verified facts. Never use the word "plate" — say "registration number". If accountVehicles is 0, end by inviting REGISTER — never ask the user to send a registration number directly. For features or package questions, give the concrete list from the facts (up to 4 short lines). If the user gave a fleet size, use the computed recommendation exactly. Warm and human, at most one emoji per line. End with ONE gentle next step. Do not paste a menu, do not repeat the question back, and never say you do not have information — the facts above are complete.'
        },
        language: ctx.targetLang,
        countryInfo,
        profile: ctx.profile,
        fallbackText: fallbackAnswer
      });
      const sanitizedText = sanitizeSakaReply(composedAnswer, fallbackAnswer, { historyLength: (ctx.conversationHistory || []).length });
      const composedText = localPricingFacts
        ? stripUsdFigures(sanitizedText, { currency: countryInfo.currency })
        : sanitizedText;
      const needsFigures = ['pricing', 'packages', 'trial', 'tier_details', 'addons', 'limits'].includes(productQaMatch.id);
      const currencyCode = String(countryInfo?.currency || '').toUpperCase();
      const carriesLocalFigure = !localPricingFacts || hasLocalFigure(composedText, currencyCode);
      const usableAnswer = composedText.length >= 60 && (!needsFigures || /\d/.test(composedText)) && carriesLocalFigure
        ? composedText
        : stripUsdFigures(fallbackAnswer, { currency: countryInfo?.currency });
      return result(usableAnswer);
    }
  },
  {
    id: 'country_knowledge',
    parksQuiz: false,
    skipWhenLocked: false,
    detect: (text) => (MY_RULES_RE.test(text) ? 'rules' : (REQUIRED_DOCS_RE.test(text) ? 'documents' : (EXAMPLE_COMPLIANCE_RE.test(text) ? 'example' : null))),
    render: async (kind, ctx = {}) => {
      const bucket = await loadCountryBucket(ctx.supabaseClient, {
        countryCode: ctx.bucketCountryCode,
        assetKind: ctx.bucketAssetKind
      });
      const reply = kind === 'rules'
        ? formatCountryRulesReply(bucket)
        : (kind === 'documents'
          ? formatRequiredDocumentsReply(bucket)
          : formatExampleComplianceReply(bucket, { plate: ctx.activeVehicle?.plate_number || null }));
      return result(reply, 'APP_HELP');
    }
  },
  {
    id: 'vehicle_summary',
    parksQuiz: false,
    skipWhenLocked: false,
    detect: (text) => SUMMARY_RE.test(String(text || '')),
    render: async (hit, ctx = {}) => {
      const summaryVehicle = ctx.activeVehicle || (ctx.vehicles || [])[0] || null;
      if (!summaryVehicle) return result('🚗 Register a vehicle first and I will prepare its summary for you.');
      if (summaryVehicle.owner_id !== ctx.profile?.id && !isSuperadminPhone(ctx.senderPhone)) {
        return result('🔒 That registration summary belongs to the vehicle owner. As the assigned driver you can ask for *vehicle health* 🩺 or *driver daybook* 📓 instead.');
      }
      const summary = await buildVehicleSummary({ supabase: ctx.supabaseClient, vehicle: summaryVehicle, owner: ctx.profile, countryInfo: ctx.countryInfo });
      let reply = summary.ok ? summary.text : '🙏 I could not build that summary right now.';
      const wantsEmail = /pdf|email|mail|inbox/i.test(String(ctx.messageText || ''));
      if (summary.ok && wantsEmail) {
        const delivery = await emailVehicleSummary({
          supabase: ctx.supabaseClient,
          summary,
          ownerEmail: ctx.profile?.email || null,
          plateNumber: summaryVehicle.plate_number
        });
        if (delivery.ok && delivery.emailed) reply += `\n\n📄 Sent to *${ctx.profile.email}* ✅`;
        else if (delivery.ok && delivery.url) reply += `\n\n📄 *PDF:* ${delivery.url}`;
        else reply += '\n\n🙏 I could not email it just now — your summary is above.';
      } else if (summary.ok) {
        reply += '\n\n💡 Reply *"send summary as PDF to my email"* for a branded copy.';
      }
      return result(reply);
    }
  },
  {
    id: 'upload_menu',
    parksQuiz: false,
    skipWhenLocked: false,
    detect: (text) => UPLOAD_MENU_RE.test(text),
    render: async () => result(`${DOCUMENT_SUPPORT_MENU}\n\n💡 Send one document at a time — I will always show what I read before saving.`, 'APP_HELP')
  },
  {
    id: 'garage_empty',
    parksQuiz: false,
    skipWhenLocked: false,
    detect: (text, ctx = {}) => VEHICLES_RE.test(text) && !ctx.hasVehicleRegistered,
    render: async (hit, ctx = {}) => result(`🚗 Your garage is empty for now.\n\nSend your vehicle's number plate (e.g. *${ctx.countryInfo?.plate_example}*) or type *REGISTER* — setup takes about two minutes.`, 'MANAGE_VEHICLE')
  },
  {
    id: 'all_documents_expiry',
    parksQuiz: true,
    skipWhenLocked: true,
    detect: (text) => detectAllDocumentsExpiryRead(text),
    render: async (hit, ctx = {}) => {
      const { vehicleRows, driverRows } = await loadBothComplianceLedgers(ctx);
      return result(buildAllDocumentsExpiryReply({
        vehicles: ctx.vehicles || [],
        vehicleRows,
        driverRows,
        profile: ctx.profile
      }));
    }
  },
  {
    id: 'document_number_search',
    parksQuiz: true,
    skipWhenLocked: true,
    detect: (text) => detectComplianceNumberSearch(text),
    render: async (hit, ctx = {}) => {
      const { vehicleRows, driverRows } = await loadBothComplianceLedgers(ctx);
      return result(buildComplianceNumberSearchReply({
        number: hit.number,
        vehicles: ctx.vehicles || [],
        vehicleRows,
        driverRows
      }));
    }
  },
  {
    id: 'driver_documents',
    parksQuiz: true,
    skipWhenLocked: true,
    skipWhenPendingCapture: true,
    detect: (text) => detectDriverComplianceRead(text),
    render: async (hit, ctx = {}) => {
      const driverRows = await loadDriverRows(ctx);
      return result(buildDriverComplianceReply({
        rows: driverRows,
        profile: ctx.profile,
        asked: hit.asked,
        confirm: hit.confirm
      }));
    }
  },
  {
    id: 'compliance_correction',
    parksQuiz: true,
    skipWhenLocked: false,
    detect: (text) => {
      const correction = detectComplianceCorrection(text);
      return correction.isCorrection ? correction : null;
    },
    render: async (hit, ctx = {}) => {
      const targetVehicle = ownedTargetVehicle(ctx);
      if (!targetVehicle) return result(noVehicleReply(ctx));
      const corrected = await applyComplianceCorrection({
        supabase: ctx.supabaseClient,
        vehicle: targetVehicle,
        kind: hit.kind,
        text: String(ctx.commandText || ''),
        countryCode: ctx.countryInfo?.country_code || 'GLOBAL',
        locale: ctx.countryInfo?.locale || 'en-US',
        timeZone: resolveUserTimezone({ countryInfo: ctx.countryInfo, profile: ctx.profile }),
        ownerId: ctx.profile?.id
      });
      return result(corrected.ok
        ? `✅ *Corrected — ${targetVehicle.plate_number} ${corrected.label}*\n\nExpiry is now *${formatComplianceDate(corrected.expiry)}*${corrected.number ? ` (${corrected.number})` : ''}.\n\nThe linked renewal reminders were moved to the corrected date.`
        : '⚠️ I could not find an expiry date in that message. Try: _"insurance expires 20/11/2026"_.');
    }
  },
  {
    id: 'compliance_expiry',
    parksQuiz: true,
    skipWhenLocked: false,
    detect: (text) => detectComplianceExpiryQuestion(text),
    render: async (hit, ctx = {}) => {
      const targetVehicle = ownedTargetVehicle(ctx);
      if (!targetVehicle) return result(noVehicleReply(ctx));
      const { data: rows } = await ctx.supabaseClient
        .from('vehicle_compliances')
        .select('type,label,number,expiry,lifetime')
        .eq('vehicle_id', targetVehicle.id);
      return result(buildComplianceExpiryAnswer({
        vehicle: targetVehicle,
        rows: rows || [],
        asked: detectComplianceItemAsked(String(ctx.commandText || ''))
      }));
    }
  },
  {
    id: 'compliance_status',
    parksQuiz: true,
    skipWhenLocked: false,
    detect: (text) => detectComplianceStatusCommand(text),
    render: async (hit, ctx = {}) => {
      const targetVehicle = ownedTargetVehicle(ctx);
      if (!targetVehicle) return result(noVehicleReply(ctx));
      const { data: rows } = await ctx.supabaseClient
        .from('vehicle_compliances')
        .select('type,label,number,expiry,lifetime')
        .eq('vehicle_id', targetVehicle.id);
      const driverRows = await loadDriverRows(ctx);
      return result(buildComplianceStatusReply({ vehicle: targetVehicle, rows: rows || [], driverRows, profile: ctx.profile }));
    }
  },
  {
    id: 'maintenance_schedule',
    parksQuiz: true,
    skipWhenLocked: false,
    detect: (text) => detectMaintenanceScheduleQuestion(text),
    render: async (hit, ctx = {}) => {
      const targetVehicle = ownedTargetVehicle(ctx);
      if (!targetVehicle) return result(noVehicleReply(ctx));
      const { data: reminders } = await ctx.supabaseClient
        .from('reminders')
        .select('reminder_type,due_date,status,threshold_value,threshold_unit')
        .eq('status', 'active')
        .in('vehicle_id', [targetVehicle.id])
        .limit(50);
      return result(buildMaintenanceScheduleAnswer({
        vehicle: targetVehicle,
        reminders: reminders || [],
        asked: detectMaintenancePart(String(ctx.commandText || ''))
      }));
    }
  },
  {
    id: 'reminders_list',
    parksQuiz: true,
    skipWhenLocked: false,
    detect: (text) => detectRemindersListCommand(text),
    render: async (hit, ctx = {}) => {
      const targetVehicle = ownedTargetVehicle(ctx);
      if (!targetVehicle) return result(noVehicleReply(ctx));
      const { data: reminders } = await ctx.supabaseClient
        .from('reminders')
        .select('reminder_type,due_date,status,vehicle_id')
        .eq('status', 'active')
        .in('vehicle_id', (ctx.vehicles || []).map((vehicle) => vehicle.id))
        .limit(50);
      return result(buildRemindersListReply({ reminders: reminders || [], vehicles: ctx.vehicles || [] }));
    }
  },
  {
    id: 'ledger_turn',
    parksQuiz: true,
    skipWhenLocked: true,
    detect: (text, ctx = {}) => {
      const turn = resolveLedgerTurn({ pending: ctx.session?.pendingEntryAction || null, text });
      if (turn.dropPending && ctx.session) ctx.session.pendingEntryAction = null;
      return turn.type !== 'none' ? turn : null;
    },
    render: async (ledgerTurn, ctx = {}) => {
      const supabaseClient = ctx.supabaseClient;
      const profileData = ctx.profile;
      const existingVehicles = ctx.vehicles || [];
      const currentActiveVehicle = ctx.activeVehicle;
      const countryInfo = ctx.countryInfo;
      const session = ctx.session;
      const senderPhone = ctx.senderPhone;
      const pendingEntryAction = session?.pendingEntryAction || null;
      const laneOwner = existingVehicles.some((v) => v.owner_id === profileData?.id);
      const scope = resolveLedgerVehicleScope({
        text: String(ctx.commandText || ''),
        vehicles: existingVehicles,
        activeVehicle: currentActiveVehicle,
        pendingVehicleId: pendingEntryAction?.vehicleId || null
      });
      const ledgerScope = {
        ownerId: laneOwner ? profileData?.id : null,
        driverId: laneOwner ? null : profileData?.id,
        vehicleIds: scope.vehicleIds,
        limit: ENTRY_LIST_LIMIT + 1
      };
      const locale = countryInfo?.locale || 'en-US';
      const currency = countryInfo?.currency || null;
      const copy = { vehicles: existingVehicles, currency, locale };
      const remember = (mode, key, vehicleId) => {
        if (session) session.pendingEntryAction = { mode, key, at: new Date().toISOString(), vehicleId };
      };
      const clearPending = () => {
        if (session) session.pendingEntryAction = null;
      };
      // v1.73.0 (Phase 10, P3-1) — the pagination cursor lives on the SESSION as
      // memory (D1), never in the pending slot. It is rewritten on every fresh
      // list render and cleared when the newest window is the whole list.
      const rememberListCursor = (hasMore) => {
        if (!session) return;
        session.paginationCursor = hasMore
          ? {
            at: Date.now(),
            listType: 'entries',
            offset: ENTRY_PAGE_SIZE,
            maxOffset: ENTRY_MAX_OFFSET,
            scope: { ownerId: ledgerScope.ownerId, driverId: ledgerScope.driverId, vehicleIds: ledgerScope.vehicleIds }
          }
          : null;
      };
      const fetchLedgerWindow = async () => {
        const fetched = await listLedgerEntries(supabaseClient, ledgerScope);
        const hasMore = fetched.length > ENTRY_LIST_LIMIT;
        return { entries: hasMore ? fetched.slice(0, ENTRY_LIST_LIMIT) : fetched, hasMore };
      };
      const ledgerWindow = await fetchLedgerWindow();
      const entries = ledgerWindow.entries;
      const entriesHasMore = ledgerWindow.hasMore;
      // Every render of the numbered newest window refreshes the cursor, so a
      // later `more` always pages from the list the user actually saw.
      const renderEntriesList = () => {
        rememberListCursor(entriesHasMore);
        return formatLedgerList({ entries, ...copy, hasMore: entriesHasMore });
      };
      const atIndex = (index) => (index ? entries[Number(index) - 1] || null : null);
      const pendingKey = pendingEntryAction?.key || null;
      const pendingEntryInList = pendingKey
        ? entries.find((entry) => ledgerEntryKey(entry) === pendingKey) || null
        : null;
      const resolvePinnedEntry = async () => {
        if (pendingEntryInList) return pendingEntryInList;
        if (!pendingKey) return null;
        return await getLedgerEntry(supabaseClient, {
          key: pendingKey,
          vehicleIds: ledgerScope.vehicleIds,
          driverId: ledgerScope.driverId,
          ownerId: ledgerScope.ownerId
        });
      };
      let reply = null;
      let ledgerIntent = 'GENERAL_CHAT';
      // __LEDGER_TAIL__
      if (scope.ambiguous) {
        clearPending();
        const plateLines = [];
        existingVehicles.forEach(function (v, i) {
          plateLines.push((i + 1) + '. ' + v.plate_number + (v.make_model ? ' (' + v.make_model + ')' : ''));
        });
        reply = 'Which vehicle should I use?\n\n' + plateLines.join('\n') + '\n\nReply the number or the plate.';
      } else if (ledgerTurn.type === 'cancel') {
        clearPending();
        reply = 'No changes made. Everything is still as you logged it.';
      } else if (ledgerTurn.type === 'command' && ledgerTurn.action === 'list') {
        clearPending();
        reply = renderEntriesList();
      } else if (ledgerTurn.type === 'command' && ledgerTurn.action === 'restore') {
        clearPending();
        const restored = await restoreLastDeleted(supabaseClient, {
          actorPhone: senderPhone,
          vehicleIds: ledgerScope.vehicleIds
        });
        reply = restored.ok
          ? formatEntryRestored({ entry: restored.entry, ...copy })
          : formatRestoreEmpty(ENTRY_RESTORE_WINDOW_MINUTES);
      } else if (ledgerTurn.type === 'command') {
        const target = atIndex(ledgerTurn.index) || (ledgerTurn.index ? null : entries[0] || null);
        if (!target) {
          const head = ledgerTurn.index
            ? formatNoEntryForSelection(ledgerTurn.index)
            : 'I could not find an entry to change.';
          reply = `${head}\n\n${renderEntriesList()}`;
        } else if (ledgerTurn.action === 'edit') {
          ledgerIntent = 'EDIT_ENTRY';
          remember('edit', ledgerEntryKey(target), target.vehicle_id);
          reply = formatEditPreview(target, copy);
        } else {
          ledgerIntent = 'DELETE_ENTRY';
          remember('delete', ledgerEntryKey(target), target.vehicle_id);
          reply = formatDeleteConfirm(target, copy);
        }
      } else if (ledgerTurn.type === 'select') {
        const target = atIndex(ledgerTurn.index);
        if (!target) {
          reply = `${formatNoEntryForSelection(ledgerTurn.index)}\n\n${renderEntriesList()}`;
        } else if (ledgerTurn.mode === 'delete') {
          ledgerIntent = 'DELETE_ENTRY';
          remember('delete', ledgerEntryKey(target), target.vehicle_id);
          reply = formatDeleteConfirm(target, copy);
        } else {
          ledgerIntent = 'EDIT_ENTRY';
          remember('edit', ledgerEntryKey(target), target.vehicle_id);
          reply = formatEditPreview(target, copy);
        }
      } else if (ledgerTurn.type === 'edit-apply') {
        ledgerIntent = 'EDIT_ENTRY';
        const target = (await resolvePinnedEntry()) || (!pendingKey ? entries[0] || null : null);
        if (!target) {
          clearPending();
          reply = renderEntriesList();
        } else {
          const updated = await relogLedgerEntry(supabaseClient, {
            entry: target,
            patch: ledgerTurn.changes,
            actorPhone: senderPhone,
            vehicleIds: ledgerScope.vehicleIds
          });
          if (updated.ok) {
            clearPending();
            reply = formatEntryRelogged({ entry: target, patch: updated.patch, ...copy });
          } else {
            const blocked = (updated.rejected || []).join(', ');
            reply = `⚠️ I could not save that change${blocked ? ` (locked or invalid: ${blocked})` : ''}.\n\n`
              + formatEditPreview(target, copy);
          }
        }
      } else if (ledgerTurn.type === 'delete-confirm') {
        ledgerIntent = 'DELETE_ENTRY';
        const target = (await resolvePinnedEntry()) || (!pendingKey ? entries[0] || null : null);
        if (!target) {
          clearPending();
          reply = renderEntriesList();
        } else {
          const removed = await deleteLedgerEntry(supabaseClient, { entry: target, actorPhone: senderPhone, vehicleIds: ledgerScope.vehicleIds });
          clearPending();
          reply = removed.ok
            ? formatEntryDeleted({ entry: target, ...copy })
            : '⚠️ I could not delete that entry just now. Nothing was changed — please try again in a moment.';
        }
      }

      return result(reply, ledgerIntent);
    }
  },
  {
    id: 'odometer_read',
    parksQuiz: true,
    skipWhenLocked: true,
    detect: (text) => isOdometerQuestion(text),
    render: async (hit, ctx = {}) => {
      const vehicle = ctx.activeVehicle || (ctx.vehicles || [])[0] || null;
      return result(buildOdometerAnswer(vehicle));
    }
  },
  {
    id: 'driver_profile_read',
    parksQuiz: true,
    skipWhenLocked: true,
    detect: (text) => DRIVER_PROFILE_RE.test(text),
    render: async (hit, ctx = {}) => {
      try {
        const card = await buildDriverComplianceCard({ supabase: ctx.supabaseClient, driverId: ctx.profile.id, countryInfo: ctx.countryInfo });
        const rows = card?.data?.tables?.[0]?.rows || [];
        return result(rows.length
          ? card.text
          : '🪪 *Your driver profile*\n\nNo driver documents are on file yet. Reply *driver profile* and I will set it up with you — licence number and expiry, one step at a time.');
      } catch {
        return result('Your driver profile is unavailable right now. Please try again in a moment.');
      }
    }
  },
  {
    id: 'records_query',
    parksQuiz: true,
    skipWhenLocked: true,
    detect: (text, ctx = {}) => {
      const spec = ctx.recordSpec || inspectRecordQuestion(text, ctx);
      return spec.question.ok && ctx.supabaseClient && ctx.profile?.id ? spec : null;
    },
    render: async (spec, ctx = {}) => {
      const supabaseClient = ctx.supabaseClient;
      const profileData = ctx.profile;
      const existingVehicles = ctx.vehicles || [];
      const commandText = String(ctx.commandText || '');
      const recordQuestion = spec.question;
      const recordChallenge = spec.challenge;
      const lastRecordQuery = spec.lastRecordQuery;
      const laneOwner = existingVehicles.some((v) => v.owner_id === profileData?.id);
      const recordScope = resolveLedgerVehicleScope({
        text: commandText,
        vehicles: existingVehicles,
        activeVehicle: ctx.activeVehicle
      });
      const wantsAllVehicles = /\b(?:all|both|every)\s+(?:vehicles?|cars?|assets?)\b|\b(?:across|for)\s+(?:the\s+)?(?:whole\s+)?fleet\b|\bfleet[-\s]?wide\b/i.test(commandText);
      if (recordScope.ambiguous && !wantsAllVehicles && existingVehicles.length >= 2) {
        const plates = existingVehicles.map((v) => v.plate_number).filter(Boolean);
        return {
          intent: 'QUERY_RECORDS',
          extracted_data: {},
          __deterministicRecords: true,
          reply_message: `📊 Which vehicle should I pull that for — *${plates.join('* or *')}*?\n\nOr reply *all vehicles* for the fleet total.`
        };
      }
      const recordVehicleIds = recordScope.ambiguous ? existingVehicles.map((v) => v.id) : recordScope.vehicleIds;
      const recordResult = await queryRecordLedger(supabaseClient, {
        ownerId: laneOwner ? profileData?.id : null,
        driverId: laneOwner ? null : profileData?.id,
        vehicleIds: recordVehicleIds,
        question: recordQuestion
      });
      let otherLabelBlock = '';
      if (recordQuestion.keyword) {
        const otherLabelGroups = await searchOtherLabels(supabaseClient, {
          vehicleIds: recordVehicleIds,
          keyword: recordQuestion.keyword
        });
        otherLabelBlock = formatOtherLabelMatches(otherLabelGroups);
      }
      const recordAnswerText = formatRecordAnswer(recordResult, recordQuestion, {
        vehicles: existingVehicles,
        currency: ctx.countryInfo?.currency || 'USD',
        locale: ctx.countryInfo?.locale || 'en-US',
        scopePlate: recordScope.reason === 'plate' ? recordQuestion.vehiclePlate : false
      }) + otherLabelBlock;
      if (ctx.session && !recordChallenge) {
        ctx.session.lastRecordQuery = {
          at: Date.now(),
          spec: {
            kind: recordQuestion.kind,
            earning: recordQuestion.earning,
            expenseTypes: recordQuestion.expenseTypes,
            range: recordQuestion.range,
            vehiclePlate: recordQuestion.vehiclePlate,
            keyword: recordQuestion.keyword,
            text: recordQuestion.text
          }
        };
      }
      return {
        intent: 'QUERY_RECORDS',
        extracted_data: {},
        __deterministicRecords: true,
        reply_message: recordChallenge
          ? `↩️ Fair check — here's the same record, unchanged:\n\n${recordAnswerText}${buildRecordChallengeScopeLine({ challengeText: commandText, vehiclePlate: lastRecordQuery?.spec?.vehiclePlate || null, vehicleCount: existingVehicles.length, expenseTypes: lastRecordQuery?.spec?.expenseTypes || [], earning: Boolean(lastRecordQuery?.spec?.earning) }) || '\n\nIf a row looks wrong, reply *my entries* to edit or delete it.'}`
          : recordAnswerText
      };
    }
  },
  {
    id: 'receipts_list',
    parksQuiz: false,
    skipWhenLocked: false,
    detect: (text) => {
      const clean = String(text || '').trim();
      if (/^(?:my\s+)?receipts?$|^show\s+(?:my\s+)?receipts?$|^last\s+receipt$/i.test(clean)) return true;
      if (/\b(?:log|record|add|save|spent|paid)\b/i.test(clean) && !/\brecords?\b|\bhistory\b|\bany\b/i.test(clean)) return false;
      return /\b(?:receipts?|purchases?|parts?\s+(?:purchases?|bought|bought\s+parts?))\b/i.test(clean)
        && /\b(?:show|list|see|view|any|history|record|records|last|recent|what|which|do\s+you\s+have)\b/i.test(clean);
    },
    render: async (hit, ctx = {}) => {
      const isOwner = (ctx.vehicles || []).some((v) => v.owner_id === ctx.profile?.id);
      const scope = {
        ownerId: isOwner ? ctx.profile?.id : null,
        driverId: isOwner ? null : ctx.profile?.id,
        vehicleIds: (ctx.vehicles || []).map((v) => v.id)
      };
      // v1.73.0 (Phase 10, P3-1) — fetch one extra row for `hasMore`, render the
      // page-1 window unchanged (5 rows) and refresh the pagination cursor.
      const rows = await listReceipts(ctx.supabaseClient, { ...scope, limit: RECEIPT_PAGE_SIZE + 1 });
      const hasMore = rows.length > RECEIPT_PAGE_SIZE;
      const receipts = hasMore ? rows.slice(0, RECEIPT_PAGE_SIZE) : rows;
      if (ctx.session) {
        ctx.session.paginationCursor = hasMore
          ? {
            at: Date.now(),
            listType: 'receipts',
            offset: RECEIPT_PAGE_SIZE,
            maxOffset: RECEIPT_MAX_OFFSET,
            scope
          }
          : null;
      }
      return result(formatReceiptsReply({
        receipts,
        vehicles: ctx.vehicles || [],
        fallbackCurrency: ctx.countryInfo?.currency || null,
        hasMore
      }));
    }
  },
  {
    // v1.73.0 (Phase 10, P3-1) — the `more` turn. View-only: page 2+ never
    // invites edit/delete (D2), because the numbered edit/delete window always
    // points at the newest list. The cursor is session MEMORY with a
    // 15-minute TTL (D1). Without a FRESH cursor this lane never claims (A1):
    // a bare "more" falls through to the AI exactly as before.
    id: 'pagination_more',
    parksQuiz: false,
    skipWhenLocked: false,
    detect: (text, ctx = {}) => {
      const t = String(text || '').trim();
      if (!PAGINATION_MORE_RE.test(t)) return null;
      return paginationCursorActive(ctx.session?.paginationCursor, ctx.now);
    },
    render: async (cursor, ctx = {}) => {
      const session = ctx.session;
      if (cursor.listType === 'receipts') {
        const page = await pageReceipts(ctx.supabaseClient, {
          ownerId: cursor.scope?.ownerId || null,
          driverId: cursor.scope?.driverId || null,
          vehicleIds: cursor.scope?.vehicleIds || [],
          offset: cursor.offset
        });
        if (!page.rows.length) {
          if (session) session.paginationCursor = null;
          return result('📸 That is the end of your receipt history. Reply *receipts* to see the newest again, or send a new photo anytime.');
        }
        const nextOffset = cursor.offset + RECEIPT_PAGE_SIZE;
        const atCap = nextOffset > (Number(cursor.maxOffset) || RECEIPT_MAX_OFFSET);
        const canMore = page.hasMore && !atCap;
        if (session) {
          session.paginationCursor = canMore
            ? { ...cursor, at: Date.now(), offset: nextOffset }
            : null;
        }
        return result(formatReceiptsReply({
          receipts: page.rows.slice(0, RECEIPT_PAGE_SIZE),
          vehicles: ctx.vehicles || [],
          fallbackCurrency: ctx.countryInfo?.currency || null,
          hasMore: canMore,
          paged: true,
          atCap: atCap && page.hasMore
        }));
      }
      const page = await listLedgerEntries(ctx.supabaseClient, {
        ownerId: cursor.scope?.ownerId || null,
        driverId: cursor.scope?.driverId || null,
        vehicleIds: cursor.scope?.vehicleIds || [],
        limit: ENTRY_PAGE_SIZE + 1,
        offset: cursor.offset
      });
      if (!page.length) {
        if (session) session.paginationCursor = null;
        return result('📒 That is the end of your ledger for this vehicle. Reply *my entries* to see the newest again.');
      }
      const hasMore = page.length > ENTRY_PAGE_SIZE;
      const entries = page.slice(0, ENTRY_PAGE_SIZE);
      const nextOffset = cursor.offset + ENTRY_PAGE_SIZE;
      const atCap = nextOffset > (Number(cursor.maxOffset) || ENTRY_MAX_OFFSET);
      const canMore = hasMore && !atCap;
      if (session) {
        session.paginationCursor = canMore
          ? { ...cursor, at: Date.now(), offset: nextOffset }
          : null;
      }
      return result(formatLedgerList({
        entries,
        vehicles: ctx.vehicles || [],
        currency: ctx.countryInfo?.currency || null,
        locale: ctx.countryInfo?.locale || 'en-US',
        paged: true,
        hasMore: canMore,
        atCap: atCap && hasMore
      }));
    }
  }
]);

/**
 * Resolve the ONE lane that owns this turn, or null when the message is not a
 * deterministic read (the route then falls through to quiz/AI exactly as
 * before). The augmented lane carries the detector hit, the OLD-order parking
 * decision and `render(ctx)` which returns the complete aiResult.
 */
export function resolveReadCommand(text, ctx = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  const parkingReason = computeParking(t, ctx);
  for (const lane of READ_COMMANDS) {
    if (lane.skipWhenLocked && ctx.quizPhaseLocked) continue;
    if (lane.skipWhenPendingCapture && ctx.session?.pendingComplianceCapture) continue;
    let hit = null;
    try { hit = lane.detect(t, ctx); } catch { hit = null; }
    if (!hit) continue;
    return {
      id: lane.id,
      parksQuiz: lane.parksQuiz,
      parksNow: Boolean(parkingReason),
      abandonReason: parkingReason || null,
      hit,
      render: (renderCtx = ctx) => lane.render(hit, renderCtx)
    };
  }
  return null;
}

export default { READ_COMMANDS, resolveReadCommand, inspectRecordQuestion, computeParking };



