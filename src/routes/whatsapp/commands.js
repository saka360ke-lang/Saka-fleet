/**
 * Saka Fleet - WhatsApp deterministic command lanes (Phase 5B-4 of the whatsapp.js split, v1.69.0).
 * ----------------------------------------------------------------------------------------------
 * Every deterministic (zero-intent) command lane moved verbatim out of the processor: the country
 * bucket command (a profile write), receipt delete (a write lane, rule 37), the passbook snapshot,
 * the report request, and the active-user command lanes (quick logs, profile, vehicle edit/switch,
 * fuel, fleet summary, greeting, reminder prompt, vehicle list, active default).
 *
 * BOUNDARY CONTRACT (section 191): commands.js is a leaf route module. It may import from
 * src/services/* and from ./helpers.js (the zero-cycle leaf exception documented since 5B-2), but
 * NEVER from ./messages.js. State in, data out: the processor performs every send, every
 * chatSessions.set and every `return { status }` (the pending.js pattern), so this module imports
 * no other route module than the helpers leaf.
 */

import { resolveCountryInput } from '../../services/countryBucket.js';
import { resolveTimezoneFromCountry, resolveUserTimezone } from '../../services/globalization.js';
import { listReceipts, deleteReceipt } from '../../services/receipts.js';
import { getReportQuota, recordReportUsage, checkoutForTier, getEntitlements } from '../../services/subscriptions.js';
import { resolveAnyReportType, buildInlineReportLink, resolveInlineReportBudgetMs } from '../../services/reportDelivery.js';
import { isDashboardEnabled, dashboardBaseUrl } from '../../services/dashboard.js';
import { resolveMetricIds, customMetricMenu } from '../../services/reportMetrics.js';
import { resolveReportAccess } from '../../services/reportAccess.js';
import { buildFleetReport } from '../../services/fleetReports.js';
import { calculateFuelConsumption } from '../../services/analytics.js';
import { findVehicleByCandidate, setActiveVehicle, updateVehicleDetails, unassignDriverFromVehicle } from '../../services/vehicles.js';
import { normalizeExpenseType, resolveExpenseType, hasExpenseTypeMarker } from '../../services/expenseCatalog.js';
import { normalizeEarningType, resolveEarningType, hasEarningTypeMarker } from '../../services/earningCatalog.js';
import { sanitizeEntryLabel, extractEntryLabel } from '../../services/entryLabels.js';
import { isDuplicateExpense, legacyExpensesWriteEnabled } from '../../services/expenseGuard.js';
import { normalizeFillType } from '../../services/fuelEconomy.js';
import { applyOdometerReading, applyOperatingHours } from '../../services/maintenanceReminders.js';
import { markUserDataChanged } from '../../services/afterWrite.js';
import { getTierLabel, getAnnualDiscountPercent } from '../../services/subscriptionTiers.js';
import { shortenUrl } from '../../services/linkShortener.js';
import { composeMessage } from '../../services/conversationEngine.js';
import { isVehicleSummaryCommand } from '../../services/readCommands.js';
import { getDriverComplianceStatus } from '../../services/driverAssignments.js';
import { isLegacyWelcomeCopy } from '../../services/greetings.js';
import { buildRoleContext, extractNumberFromText, extractOdometerFromText } from './helpers.js';

/* ------------------------------------------------------------------ */
/* 1. country bucket command (a profile write - zero tokens)           */
/* ------------------------------------------------------------------ */

export async function resolveCountryCommand({ messageText, profileData, supabaseClient, bucketAssetKind }) {
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
  return countryCommandResult;
}

/* ------------------------------------------------------------------ */
/* 1b. weekly report toggle (a profile write - zero tokens)            */
/* v1.73.0 (Phase 10, P3-4): "weekly report on|off" flips               */
/* profiles.weekly_report_opt_in; a bare "weekly report" is a           */
/* deterministic state read so the phrase can NEVER be misclassified    */
/* as a report request (which would consume the monthly quota).         */
/* Kept beside the country command (a pre-read write lane) because the  */
/* read registry's contract keeps writes out (section 190).             */
/* ------------------------------------------------------------------ */

export const WEEKLY_REPORT_TOGGLE_RE = /^weekly\s+reports?\s+(on|off|enable|disable|yes|no)$/i;
export const WEEKLY_REPORT_STATUS_RE = /^weekly\s+reports?$/i;

const WEEKLY_REPORT_ON_COPY = '🗓️ *Weekly report on*\n\nEvery Monday at 8:00 AM I\'ll send you a one-message fleet summary — it never uses your report quota.\n\nReply *weekly report off* to stop it.';
const WEEKLY_REPORT_OFF_COPY = '🗓️ *Weekly report off*\n\nNo more Monday summaries. Reply *weekly report on* whenever you want them back.';

export function parseWeeklyReportToggle({ messageText }) {
  const text = String(messageText || '').trim();
  const toggle = WEEKLY_REPORT_TOGGLE_RE.exec(text);
  if (toggle) {
    const word = toggle[1].toLowerCase();
    return { action: ['on', 'enable', 'yes'].includes(word) ? 'on' : 'off' };
  }
  if (WEEKLY_REPORT_STATUS_RE.test(text)) return { action: 'status' };
  return null;
}

export async function resolveWeeklyReportToggle({ messageText, profileData, supabaseClient }) {
  const command = parseWeeklyReportToggle({ messageText });
  if (!command || !profileData?.id) return null;
  const base = { intent: 'GENERAL_CHAT', extracted_data: {} };
  if (command.action === 'status') {
    let enabled = null;
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('weekly_report_opt_in')
        .eq('id', profileData.id)
        .limit(1);
      if (!error) enabled = Boolean((data || [])[0]?.weekly_report_opt_in);
    } catch { enabled = null; }
    if (enabled === null) {
      return {
        ...base,
        reply_message: '🗓️ *Weekly report*\n\nI could not read that setting just now. Reply *weekly report on* or *weekly report off* and I\'ll set it.'
      };
    }
    return {
      ...base,
      reply_message: enabled
        ? '🗓️ *Weekly report is ON*\n\nEvery Monday at 8:00 AM you get a one-message fleet summary — it never uses your report quota.\n\nReply *weekly report off* to stop it.'
        : '🗓️ *Weekly report is OFF*\n\nReply *weekly report on* and every Monday at 8:00 AM I\'ll send you a one-message fleet summary.'
    };
  }
  const enabled = command.action === 'on';
  let saved = false;
  try {
    const { error } = await supabaseClient
      .from('profiles')
      .update({ weekly_report_opt_in: enabled })
      .eq('id', profileData.id);
    saved = !error;
  } catch { saved = false; }
  if (!saved) {
    // Rule 50 — an un-migrated column (or a DB hiccup) never fakes success.
    return { ...base, reply_message: '⚠️ I could not save that setting just now — nothing changed. Please try again in a moment.' };
  }
  return { ...base, reply_message: enabled ? WEEKLY_REPORT_ON_COPY : WEEKLY_REPORT_OFF_COPY };
}

/* ------------------------------------------------------------------ */
/* 1c. monthly PDF summary toggle (v1.77.0, Phase 16)                  */
/* "monthly report on|off" flips profiles.monthly_report_opt_in; a bare */
/* "monthly report" is a deterministic state read so the phrase can     */
/* NEVER be misclassified as a report request.                          */
/* ------------------------------------------------------------------ */

export const MONTHLY_REPORT_TOGGLE_RE = /^monthly\s+reports?\s+(on|off|enable|disable|yes|no)$/i;
export const MONTHLY_REPORT_STATUS_RE = /^monthly\s+reports?$/i;

const MONTHLY_REPORT_ON_COPY = '🗓️ *Monthly PDF summary on*\n\nOn the 1st of every month at 8:00 AM I\'ll email your fleet\'s month as a PDF — it never uses your report quota.\n\nReply *monthly report off* to stop it.';
const MONTHLY_REPORT_OFF_COPY = '🗓️ *Monthly PDF summary off*\n\nNo more monthly emails. Reply *monthly report on* whenever you want them back.';

export function parseMonthlyReportToggle({ messageText }) {
  const text = String(messageText || '').trim();
  const toggle = MONTHLY_REPORT_TOGGLE_RE.exec(text);
  if (toggle) {
    const word = toggle[1].toLowerCase();
    return { action: ['on', 'enable', 'yes'].includes(word) ? 'on' : 'off' };
  }
  if (MONTHLY_REPORT_STATUS_RE.test(text)) return { action: 'status' };
  return null;
}

export async function resolveMonthlyReportToggle({ messageText, profileData, supabaseClient }) {
  const command = parseMonthlyReportToggle({ messageText });
  if (!command || !profileData?.id) return null;
  const base = { intent: 'GENERAL_CHAT', extracted_data: {} };
  if (command.action === 'status') {
    let enabled = null;
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('monthly_report_opt_in')
        .eq('id', profileData.id)
        .limit(1);
      if (!error) enabled = Boolean((data || [])[0]?.monthly_report_opt_in);
    } catch { enabled = null; }
    if (enabled === null) {
      return {
        ...base,
        reply_message: '🗓️ *Monthly PDF summary*\n\nI could not read that setting just now. Reply *monthly report on* or *monthly report off* and I\'ll set it.'
      };
    }
    return {
      ...base,
      reply_message: enabled
        ? '🗓️ *Monthly PDF summary is ON*\n\nOn the 1st of every month you get your fleet\'s month as a PDF by email — it never uses your report quota.\n\nReply *monthly report off* to stop it.'
        : '🗓️ *Monthly PDF summary is OFF*\n\nReply *monthly report on* and on the 1st of every month I\'ll email your fleet\'s month as a PDF.'
    };
  }
  const enabled = command.action === 'on';
  let saved = false;
  try {
    const { error } = await supabaseClient
      .from('profiles')
      .update({ monthly_report_opt_in: enabled })
      .eq('id', profileData.id);
    saved = !error;
  } catch { saved = false; }
  if (!saved) {
    // Rule 50 — an un-migrated column (or a DB hiccup) never fakes success.
    return { ...base, reply_message: '⚠️ I could not save that setting just now — nothing changed. Please try again in a moment.' };
  }
  return { ...base, reply_message: enabled ? MONTHLY_REPORT_ON_COPY : MONTHLY_REPORT_OFF_COPY };
}

/* ------------------------------------------------------------------ */
/* 2. receipt delete (write lane, rule 37)                             */
/* ------------------------------------------------------------------ */

export function parseReceiptDeleteCommand({ commandText }) {
  const receiptDeleteMatch = commandText.match(/^(?:delete|remove)\s+receipts?\s+([1-5])(?:\s+(DELETE))?$/i);
  const receiptDeleteCommand = receiptDeleteMatch ? { index: Number(receiptDeleteMatch[1]), confirmed: Boolean(receiptDeleteMatch[2]) } : null;
  return receiptDeleteCommand;
}

export async function handleReceiptDeleteTurn({ supabaseClient, profileData, existingVehicles, receiptDeleteCommand, senderPhone }) {
  let aiResult;
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
  return aiResult;
}

/* ------------------------------------------------------------------ */
/* 3. passbook snapshot (deterministic, zero AI tokens)                */
/* ------------------------------------------------------------------ */

export async function renderPassbookSnapshot({ supabaseClient, existingVehicles, currentActiveVehicle, entitlements, countryInfo }) {
  let handled = false;
  let reply;
  handled = true;
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
  reply = `📘 *Your Saka passbook*\n\n${vehicleLines}\n\n${planLine}\n\n${expenseLines.length
    ? `🧾 *Recent expenses — ${snapshotVehicle.plate_number}*\n${expenseLines.join('\n')}`
    : '🧾 No expenses logged yet — reply *"log expense"* to add your first one.'}`;
  return { handled, reply };
}
/* ------------------------------------------------------------------ */
/* 4. report request lane (v1.77.0, Phase 16 — dashboard-first)        */
/* ------------------------------------------------------------------ */

/**
 * The WhatsApp report lane answers INSTANTLY. The dashboard Reports page is the
 * primary surface (every PDF downloads there, quota-free by design); while
 * `REPORT_INLINE_BUILD_MS` lasts, one PDF is also built, uploaded and linked in
 * the same reply. Quota usage and the trial's REPORT_GENERATED activation are
 * recorded ONLY when that inline PDF really exists. The retired path (instant
 * ACK → background job → follow-up link → on-demand email) is gone.
 */
export async function handleReportRequestTurn({ mergedExt, messageText, supabaseClient, profileData, senderPhone, existingVehicles, targetVeh, entitlements, countryInfo, targetLang }) {
  const reportType = resolveAnyReportType(mergedExt.report_type || messageText, 'fleet');
  const metricIds = resolveMetricIds(messageText);
  const dateRange = /last\s*(?:3|three)\s*months?/i.test(messageText)
    ? 'last_3_months'
    : /(this\s*year|yearly|annual|year\s*review)/i.test(messageText) ? 'this_year' : 'this_month';

  // Bespoke with no metrics named → the menu (no build, no quota, unchanged).
  if (reportType === 'custom' && metricIds.length === 0) {
    const access = resolveReportAccess({
      reportType: 'custom',
      profile: profileData,
      vehicles: existingVehicles,
      roles: profileData?.roles || []
    });
    return {
      handled: true,
      entitlements,
      reply: `📊 *Bespoke report — pick your metrics*\n\nAvailable: ${customMetricMenu(access)}\n\n` +
        'Reply, for example:\n_"custom report: fuel economy, total spend and distance for last 3 months"_\n\n' +
        'You can also ask for "fuel economy report", "driver daybook", "vehicle health" or "compliance card".'
    };
  }

  const ownerId = existingVehicles.some((v) => v.owner_id === profileData?.id) ? profileData?.id : null;
  const driverId = existingVehicles.some((v) => v.assigned_driver_id === profileData?.id) ? profileData?.id : null;
  const dashboardReady = isDashboardEnabled();
  const lines = dashboardReady
    ? [
        '📊 *Your report is ready on your dashboard*',
        '',
        'Open Reports and download the PDF instantly:',
        `👉 ${dashboardBaseUrl()}/reports`,
        '',
        '_Ask me anything about the numbers and I will answer right here._'
      ]
    : ['📊 *Let me put your report together*'];

  // D2 — inline fast PDF while the budget lasts. Never emails.
  let inline = { ok: false, reason: 'budget-off' };
  const budgetMs = resolveInlineReportBudgetMs();
  if (budgetMs > 0 && profileData?.id) {
    const quota = await getReportQuota({ supabase: supabaseClient, ownerId: profileData.id, profile: profileData });
    if (quota?.canGenerate) {
      inline = await buildInlineReportLink({
        supabase: supabaseClient,
        reportType,
        ownerId,
        driverId,
        plate: targetVeh?.plate_number || null,
        profile: profileData,
        countryInfo,
        metricIds,
        range: dateRange,
        plateLabel: targetVeh?.plate_number || 'Fleet',
        budgetMs
      });
    }
  }
  if (inline?.ok && inline.url) {
    lines.push('', `📄 *PDF report:* ${inline.url}`);
    if (profileData?.id) {
      try {
        await recordReportUsage({ supabase: supabaseClient, ownerId: profileData.id });
        // v1.77.0 (audit override) — a generated report no longer activates a
        // trial; vehicle registration is the ONLY activation event.
        entitlements = await getEntitlements({
          supabase: supabaseClient,
          ownerId: profileData.id,
          profile: profileData,
          useCache: false
        });
      } catch { /* quota/activation are best-effort */ }
    }
  } else if (!dashboardReady) {
    // No dashboard and no PDF: one honest next step, never silence.
    lines.push('', 'I could not build the PDF just now — reply *report* and I will try again.');
  }
  return { handled: true, reply: lines.join('\n'), entitlements };
}

/* ------------------------------------------------------------------ */
/* 5. active-user command lanes                                        */
/* ------------------------------------------------------------------ */

export async function handleUnassignDriverTurn({ mergedExt, messageText, existingVehicles, targetVeh, supabaseClient, targetLang, countryInfo, profileData }) {
  let reply;
  let unassignTarget = targetVeh;
  if (mergedExt.plate_number) {
    const found = findVehicleByCandidate(existingVehicles, mergedExt.plate_number);
    if (found) unassignTarget = found;
  }

  if (!unassignTarget) {
    reply = await composeMessage({
      purpose: 'unassign_driver_notice',
      facts: { issue: 'The vehicle for the driver unassignment could not be identified' },
      language: targetLang,
      countryInfo,
      profile: profileData,
      fallbackText: '⚠️ Could not identify the vehicle to unassign the driver from.'
    });
  } else {
    await unassignDriverFromVehicle({ vehicleId: unassignTarget.id, supabase: supabaseClient });
    reply = `✅ Driver unassigned from vehicle *${unassignTarget.plate_number}*. Vehicle is now available for a new driver.`;
  }
  return { handled: true, reply };
}

export async function handleViewProfileTurn({ profileData, existingVehicles, senderPhone, formattedPhone, supabaseClient, countryInfo, targetLang }) {
  let handled = false;
  let reply;
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
  handled = true;
  reply = await composeMessage({
    purpose: 'profile_overview',
    facts,
    language: targetLang,
    countryInfo,
    profile: profileData,
    fallbackText: fallback
  });
  return { handled, reply };
}

export async function handleEditVehicleTurn({ mergedExt, messageText, existingVehicles, targetVeh, profileData, supabaseClient, targetLang, countryInfo }) {
  let reply;
  const editTarget = mergedExt.plate_number
    ? (findVehicleByCandidate(existingVehicles, mergedExt.plate_number) || targetVeh)
    : targetVeh;

  if (!editTarget) {
    reply = await composeMessage({
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
      reply = await composeMessage({
        purpose: 'vin_lock_notice',
        facts: { invariant: 'The VIN / chassis number is permanently tied to the passbook and can never be edited; all other vehicle details can still be updated.' },
        language: targetLang,
        countryInfo,
        profile: profileData,
        fallbackText: `🔒 *VIN Is Permanently Locked*\n\nYour VIN / chassis number is permanently tied to your passbook and can never be edited. All other vehicle details can still be updated.`
      });
    } else if (Object.keys(candidateUpdates).length === 0) {
      const currentList = `• Plate: ${editTarget.plate_number}\n• Make/Model: ${editTarget.make_model || '-'}\n• Year: ${editTarget.yom || editTarget.year_of_manufacture || '-'}\n• Fuel: ${editTarget.fuel_type || '-'}\n• Odometer: ${(editTarget.current_mileage || editTarget.odometer_reading || 0).toLocaleString()} km\n• VIN: ${editTarget.vin || '-'} 🔒`;
      reply = `🛠️ *Edit Vehicle — ${editTarget.plate_number}*\n\n${currentList}\n\nReply with the change, e.g. *"update vehicle ${editTarget.plate_number} color to White"* or *"change fuel for ${editTarget.plate_number} to Diesel"*.\n\n🔒 *Note:* The VIN is permanently immutable.`;
    } else {
      const editRes = await updateVehicleDetails({
        vehicleId: editTarget.id,
        requesterId: profileData?.id,
        updates: candidateUpdates,
        supabase: supabaseClient
      });

      if (!editRes.success) {
        reply = `❌ *Vehicle Update Failed*\n\n${editRes.error}`;
      } else {
        const appliedLines = Object.entries(editRes.applied || {})
          .filter(([k]) => k !== 'updated_at')
          .map(([k, v]) => `• *${k}:* ${v}`)
          .join('\n');
        reply = `✅ *Vehicle Details Updated!* 🚗\n\n• *Vehicle:* *${editRes.vehicle?.plate_number || editTarget.plate_number}*\n${appliedLines ? appliedLines + '\n' : ''}${editRes.rejected?.length ? '\n🔒 VIN / passbook token remain permanently locked and unchanged.' : ''}`;
      }
    }
  }
  return { handled: true, reply };
}

export async function handleSwitchVehicleTurn({ mergedExt, messageText, existingVehicles, senderPhone, sessions, targetLang, countryInfo, profileData }) {
  let reply;
  let switchedVehicle = null;
  const candidate = mergedExt.target_vehicle || mergedExt.plate_number || messageText.replace(/^(?:switch(?:\s+to)?|manage|select)\s+(?:car|vehicle)?\s*/i, '').trim();
  const found = findVehicleByCandidate(existingVehicles, candidate);
  if (found) {
    setActiveVehicle({ senderPhone, vehicleId: found.id, sessions });
    switchedVehicle = found;
    const switchCardText = `🔄 *Switched Active Vehicle!*\n\n` +
      `Now managing: *${found.plate_number}* (${found.make_model || 'Vehicle'})\n` +
      `• Fuel Type: ${found.fuel_type || 'Fuel'}\n` +
      `• Current Odometer: ${(found.current_mileage || found.odometer_reading || 0).toLocaleString()} ${found.unit_system === 'imperial' ? 'mi' : 'km'}\n\n` +
      `All subsequent fuel logs, mileage updates, and queries will automatically apply to this vehicle.`;
    reply = await composeMessage({
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
    reply = generic
      ? `🔄 *Which vehicle should be active?*\n\n${vList}\n\nReply with a number or plate (e.g. *"switch to 1"*).`
      : `⚠️ Could not find "${candidate}" in your fleet.\n\nYour registered vehicles:\n${vList}\n\nReply with a number or plate (e.g. *"switch to 1"* or *"switch to ${existingVehicles[0]?.plate_number}"*) to select.`;
  }
  return { handled: true, reply, vehicle: switchedVehicle };
}

export async function handleFuelEfficiencyTurn({ mergedExt, targetVeh, existingVehicles, supabaseClient, countryInfo }) {
  let reply;
  const fuelAnalysis = await calculateFuelConsumption({
    supabase: supabaseClient,
    vehicleId: targetVeh?.id,
    plateNumber: mergedExt.plate_number || targetVeh?.plate_number,
    targetUnit: targetVeh?.unit_system || countryInfo.default_units,
    currency: countryInfo?.currency || null
  });

  if (fuelAnalysis && fuelAnalysis.explanation) {
    reply = fuelAnalysis.explanation;
    if (existingVehicles.length > 1) {
      reply += `\n\n📌 *(Vehicle: ${targetVeh.plate_number}. Type "switch to [plate]" to analyze another)*`;
    }
  } else {
    reply = `Could not calculate fuel consumption for ${targetVeh?.plate_number || 'vehicle'}.`;
  }
  return { handled: true, reply };
}

export async function handleFleetSummaryTurn({ supabaseClient, profileData, existingVehicles, countryInfo }) {
  let reply;
  const fleetReport = await buildFleetReport({
    supabase: supabaseClient,
    type: 'fleet',
    ownerId: existingVehicles.some((v) => v.owner_id === profileData?.id) ? profileData?.id : null,
    driverId: existingVehicles.some((v) => v.assigned_driver_id === profileData?.id) ? profileData?.id : null,
    countryInfo,
    profile: profileData
  });
  reply = fleetReport?.ok && fleetReport.text
    ? fleetReport.text
    : `Could not retrieve the fleet summary right now.`;
  return { handled: true, reply };
}

export async function handleGreetingTurn({ aiResult, targetVeh, existingVehicles, targetLang, countryInfo, profileData }) {
  let reply;
  reply = aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant') && !isLegacyWelcomeCopy(aiResult.reply_message)
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
  return { handled: true, reply };
}

export async function handleLogExpenseTurn({ mergedExt, messageText, targetVeh, supabaseClient, profileData, senderPhone, countryInfo, targetLang, existingVehicles, sendWhatsApp }) {
  let reply;
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
        // v1.72.0 (P2-3) — the guard reads expense_logs by vehicle_id.
        vehicleId: targetVeh.id,
        amount: extAmount,
        expenseType: expType,
        odometer: extOdo || null,
        windowHours: Number(process.env.OCR_EXPENSE_DEDUPE_HOURS || 3)
      })
      : { duplicate: false };
    if (duplicateExpense.duplicate) {
      reply = `⚠️ *Already logged* — I found *${countryInfo.currency} ${Number(extAmount).toLocaleString()}* (${expType}) for *${targetVeh.plate_number}* in the last few hours, so I did *not* save a duplicate. ✅\n\nIf this is a genuinely separate fill, send the new odometer reading (e.g. *"Logged ${extLiters || ''}L at 367,500 km"*) and I will log it.`;
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
        reply = `⚠️ I could not save that expense just now — *nothing was written*. Please try again in a moment, or send it as *"amount type"* (e.g. *"1000 fuel"*).`;
      } else {
        // v1.72.0 (P2-3) — the legacy `expenses` mirror retires behind
        // LEGACY_EXPENSES_WRITE_ENABLED (default on = today's behaviour).
        if (legacyExpensesWriteEnabled()) {
          await supabaseClient.from('expenses').insert([{
            plate: targetVeh.plate_number,
            expense_type: expType,
            amount: extAmount || 0,
            liters: extLiters || 0,
            odometer_reading: extOdo || null
          }]).select().maybeSingle();
        }

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
        reply = await composeMessage({
          purpose: 'flow_outcome_card',
          facts: { cardText: expenseCardText, instruction: 'Re-render this engine card conversationally: keep EVERY figure, label, emoji anchor and next step exactly as written. Never drop or invent a figure.' },
          language: targetLang,
          countryInfo,
          profile: profileData,
          fallbackText: expenseCardText
        });
        if (existingVehicles.length > 1) {
          reply += `\n*(Active vehicle: ${targetVeh.plate_number}. Type "switch to [car]" to change)*`;
        }
      }
    } else {
      reply = `⛽ I can't save that right now — please try again in a moment.`;
    }
  } else {
    reply = `⛽ *Log Expense / Fuel for ${targetVeh.plate_number}*\n\nPlease reply with expense details. For example:\n• *"Logged 45L fuel at 368000 km for KES 8500"*\n• *"Oil change KES 5000"*`;
  }
  return { handled: true, reply };
}

export async function handleUpdateMileageTurn({ mergedExt, messageText, targetVeh, supabaseClient, senderPhone, profileData, existingVehicles, sendWhatsApp }) {
  let reply;
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
                      sendFn: (phone, text) => sendWhatsApp(phone, text),
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
                    reply = `⚠️ Could not update the odometer for *${targetVeh.plate_number}*: ${odometerSaveError}`;
                  } else {
                    reply = `📈 *Odometer Updated!* 🚗

  ` +
                      `• *Vehicle:* *${targetVeh.plate_number}* (${targetVeh.make_model || 'Vehicle'})
  ` +
                      `• *New Odometer:* ${Number(extOdometer).toLocaleString()} ${inputUnit}

  ` +
                      `✅ Saved to database under *${targetVeh.plate_number}*!`;
                    if (existingVehicles.length > 1) {
                      reply += `
  *(Active vehicle: ${targetVeh.plate_number})*`;
                    }
                  }
                } else {
                  reply = `📈 *Update Mileage / Odometer*

  Please reply with your updated odometer reading (e.g. *"Odometer 45000 km"*).`;
                }
  return { handled: true, reply };
}

export async function handleOperatingHoursTurn({ mergedExt, messageText, targetVeh, supabaseClient, senderPhone, profileData, existingVehicles, sendWhatsApp }) {
  let reply;
                const extHours = mergedExt.operating_hours !== undefined && mergedExt.operating_hours !== null
                  ? Number(mergedExt.operating_hours)
                  : extractNumberFromText(messageText);
                if (supabaseClient && targetVeh && extHours !== null && Number.isFinite(extHours) && extHours >= 0) {
                  const recorded = await applyOperatingHours({
                    supabase: supabaseClient,
                    vehicle: targetVeh,
                    hours: extHours,
                    sendFn: (phone, text) => sendWhatsApp(phone, text),
                    canDeliver: (phone) => String(phone || '').replace(/[^\d]/g, '') !== String(senderPhone || '').replace(/[^\d]/g, '')
                  });
                  if (recorded.ok) {
                    // v1.63.1 — the hour-meter update changed the asset facts.
                    markUserDataChanged({ supabase: supabaseClient, phone: senderPhone, ownerId: profileData?.id, reason: 'whatsapp.quickLogHours' });
                  }
                  if (!recorded.ok) {
                    reply = `⚠️ Could not update operating hours for *${targetVeh.plate_number}*: ${recorded.error}`;
                  } else {
                    targetVeh.operating_hours = extHours;
                    reply = `⏱️ *Operating Hours Updated!*

  ` +
                      `• *Vehicle:* *${targetVeh.plate_number}* (${targetVeh.make_model || 'Vehicle'})
  ` +
                      `• *New Hour Meter:* ${Number(extHours).toLocaleString()} operating hours

  ` +
                      `✅ Saved to database under *${targetVeh.plate_number}*!`;
                    if (existingVehicles.length > 1) {
                      reply += `
  *(Active vehicle: ${targetVeh.plate_number})*`;
                    }
                  }
                } else {
                  reply = `⏱️ *Log Operating Hours*

  Please reply with the current hour-meter reading (e.g. *"1250 engine hours"*).`;
                }
  return { handled: true, reply };
}

export async function handleLogEarningsTurn({ mergedExt, messageText, targetVeh, supabaseClient, profileData, senderPhone, countryInfo, targetLang, existingVehicles }) {
  let reply;
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
      reply = `⚠️ I could not save that earning just now — *nothing was written*. Please try again in a moment.`;
    } else {
      reply = `💰 *Earnings Logged!* 🎉\n\n• *Vehicle:* *${targetVeh.plate_number}*\n• *Revenue:* ${countryInfo.currency} ${Number(extAmount).toLocaleString()}${earnType ? `\n• *Type:* ${earnType}` : ''}${quickEarningLabel ? `\n• *Label:* #${quickEarningLabel}` : ''}\n\n✅ Recorded under *${targetVeh.plate_number}*!`;
      if (existingVehicles.length > 1) {
        reply += `\n*(Active vehicle: ${targetVeh.plate_number})*`;
      }
    }
  } else {
    reply = await composeMessage({
      purpose: 'quiz_intro_prompt',
      facts: { flow: 'Log earnings', example: 'Earned KES 5000 today' },
      language: targetLang,
      countryInfo,
      profile: profileData,
      fallbackText: `💰 *Log Earnings*\n\nPlease reply with your revenue details (e.g. *"Earned KES 5000 today"*).`
    });
  }
  return { handled: true, reply };
}

export function renderReminderPrompt({ targetVeh }) {
  let reply;
  reply = `🔔 *Set Reminder for ${targetVeh.plate_number}*\n\nReply with the item and its date, distance or operating hours. Examples:\n• *"Insurance expires on 15th Dec 2026"*, *"Inspection due next month"*, *"License renewal in 14 days"*\n• *"Road license expires 2027-03-31"* or *"Permit due in 30 days"*\n• *"Oil change in 5000 km"*, *"Brake pads in 3000 miles"* or *"Spare part change in 36 operating hours"*`;
  return { handled: true, reply };
}

export function renderVehicleList({ existingVehicles, targetVeh }) {
  let reply;
  const vehicleList = existingVehicles.map((v, i) => {
    const isActive = v.id === targetVeh?.id;
    return `${i + 1}️⃣ *${v.plate_number}* - ${v.make_model || 'Vehicle'} (${v.fuel_type || 'Fuel'}, ${(v.current_mileage || v.odometer_reading || 0).toLocaleString()} km)${isActive ? ' 👉 *(ACTIVE)*' : ''}`;
  }).join('\n');
  reply = `🚗 *Your Registered Fleet:*\n\n${vehicleList}\n\n💡 *To switch active vehicle:* Reply *"switch to [plate]"* or *"switch to [number]"*!`;
  return { handled: true, reply };
}

export async function handleEditProfileTurn({ messageText, mergedExt, profileData, supabaseClient }) {
  let reply;
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
    reply = `⚙️ *Profile & Settings*\n\n• Name: ${profileData?.full_name || '-'}\n• Email: ${profileData?.email || '-'}\n• Language: ${profileData?.preferred_language || 'English'}\n• Units: ${profileData?.unit_system || 'metric'}\n\nReply with a change, e.g. *"update my name to Jane Doe"*, *"change my language to Swahili"*, or *"change my units to imperial"*.\n\n_(Use "update email to ..." to change your email with OTP verification.)_`;
  } else if (supabaseClient && profileData) {
    profileUpdates.updated_at = new Date().toISOString();
    const { error: profileErr } = await supabaseClient.from('profiles').update(profileUpdates).eq('id', profileData.id);
    if (profileErr) {
      reply = `❌ *Profile Update Failed*\n\n${profileErr.message}`;
    } else {
      Object.assign(profileData, profileUpdates);
      const changed = Object.entries(profileUpdates)
        .filter(([k]) => k !== 'updated_at')
        .map(([k, v]) => `• *${k}:* ${v}`)
        .join('\n');
      reply = `✅ *Profile Updated!* ⚙️\n\n${changed}\n\nThese settings now apply across your whole fleet.`;
    }
  }
  return { handled: true, reply };
}

export async function renderActiveDefault({ aiResult, targetVeh, existingVehicles, targetLang, countryInfo, profileData }) {
  let reply;
  if (aiResult.reply_message && !aiResult.reply_message.includes('I am your Saka Fleet WhatsApp assistant. How can I help with your vehicle') && !isLegacyWelcomeCopy(aiResult.reply_message)) {
    reply = aiResult.reply_message;
  } else {
    reply = await composeMessage({
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
  return { handled: true, reply };
}

/* ------------------------------------------------------------------ */
/* 6. vehicle-summary flag (also suppresses the feature notice)        */
/* ------------------------------------------------------------------ */

export function parseVehicleSummaryCommand({ messageText }) {
  // Vehicle registration summary ("send me registration summary as PDF").
  const summaryCommand = isVehicleSummaryCommand(String(messageText || ''));
  return summaryCommand;
}

