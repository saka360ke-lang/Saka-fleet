import { extractDatePhrase, diffCalendarDays, SYSTEM_TIMEZONE } from './dateParser.js';
import { resolveVehicleComplianceCatalog, submitVehicleCompliance } from './vehicleCompliance.js';

/**
 * Saka Fleet — Deterministic compliance & reminder answers (v1.32.2)
 * -----------------------------------------------------------------
 * Live evidence 2026-11-01: the owner asked three times "when does insurance
 * expire?" and was answered with canned lines, and a typed correction
 * ("2026-10-21 is the commencement date, expiry is 2026-11-20") was ignored.
 *
 * These helpers answer and correct compliance facts with zero AI tokens:
 *  - reminders list ("alerts", "list my reminders")
 *  - compliance card ("my compliance")
 *  - expiry question ("when does insurance expire?")
 *  - expiry correction ("you read it wrong … expiry is 20/11/2026")
 *
 * Rules: never throws; dates via dateParser (country-resolved, Africa/Nairobi);
 * global-audience safe (no country assumed).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO date (YYYY-MM-DD) → "20 Nov 2026". Deterministic, no timezone drift. */
export function formatComplianceDate(iso, fallback = '—') {
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return iso ? String(iso).slice(0, 10) : fallback;
  const [, year, month, day] = match;
  return `${String(Number(day)).padStart(2, '0')} ${MONTHS[Number(month) - 1] || month} ${year}`;
}

/** 🟢 valid · 🟡 inside 30 days · 🔴 expired · ⚪ missing/unknown. */
export function complianceChip(daysLeft) {
  const days = Number(daysLeft);
  if (!Number.isFinite(days)) return '⚪';
  if (days < 0) return '🔴';
  if (days <= 30) return '🟡';
  return '🟢';
}

export function formatDaysLeft(daysLeft) {
  const days = Number(daysLeft);
  if (!Number.isFinite(days)) return '';
  if (days < 0) return `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (days === 0) return 'expires today';
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/** Reminder-creation wording must never be captured as a list request. */
function isReminderCreation(text) {
  return /\b(?:set|add|create|new|remind\s+me)\b/i.test(text);
}

/**
 * v1.32.3 — does the message CARRY a date (i.e. the user is supplying one)?
 * A message with a date is an answer or a correction, never a question, so the
 * deterministic expiry answer must not steal it from an active quiz.
 */
export function carriesExplicitDate(text = '') {
  const clean = String(text || '');
  if (/\b\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}\b/.test(clean)) return true;
  const month = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  if (new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${month}\\b`, 'i').test(clean)) return true;
  return new RegExp(`\\b${month}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'i').test(clean);
}

export function detectRemindersListCommand(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 90 || isReminderCreation(clean)) return false;
  if (/^(?:my\s+|show\s+|list\s+)?(?:alerts?|reminders?)$/i.test(clean)) return true;
  if (/^(?:list|show|see|view)\b[^?]{0,40}\b(?:alerts?|reminders?)\b/i.test(clean)) return true;
  if (/\b(?:alerts?|reminders?)\b[^?]{0,20}\b(?:list|report|due|upcoming|active)\b/i.test(clean)) return true;
  // v1.32.3 — real users put the qualifier BEFORE the noun ("Report of recent
  // tired alerts", "Does my car have active reminders?", "See reminders for
  // KAS 628T"). For a short message, the noun plus any request word is enough.
  const mentionsReminders = /\b(?:alerts?|reminders?)\b/i.test(clean);
  const asksToSee = /\b(?:show|list|see|view|get|give|send|check|any|active|upcoming|due|recent|report|what|which|tell)\b/i.test(clean);
  if (mentionsReminders) {
    if (asksToSee) return true;
    // A short fragment that just names them ("tiered alerts") is still a read
    // request; a negated one ("no alerts yet") is an answer, not a command.
    const negated = /\b(?:no|none|not|nothing|zero|never)\b/i.test(clean);
    if (!negated && clean.split(/\s+/).filter(Boolean).length <= 3) return true;
  }
  return /\bwhat(?:'s| is)?\s+(?:due|coming up)\b/i.test(clean);
}

export function detectComplianceStatusCommand(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 90) return false;
  // "compliance report" belongs to the PDF report engine — never steal it.
  if (/\breport\b/i.test(clean)) return false;
  if (/^(?:my\s+)?compliance(?:\s+(?:status|card|summary|details))?$/i.test(clean)) return true;
  if (/\b(?:compliance|documents?|permits?)\s+(?:status|card)\b/i.test(clean)) return true;
  // v1.32.3 — "Show me insurance details for my cars", "my inspection records",
  // "what documents do you have on file".
  return /\b(?:insurance|insurances|compliance|documents?|permits?|licen[cs]es?|inspection)\b[^?]{0,24}\b(?:details?|status|summary|card|records?|info|information|on\s+file)\b/i.test(clean);
}

/** "When does insurance expire?" / "insurance expiry date" / "inspection due?" */
export function detectComplianceExpiryQuestion(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 120) return false;
  if (/\breport\b/i.test(clean)) return false;
  // v1.32.3 — a supplied date (or a corrected date) is never a question.
  if (carriesExplicitDate(clean)) return false;
  const item = /\b(insur\w*|inspection|licen[cs]e|permit|road\s*service|compliance)\b/i.test(clean);
  const asks = /\b(expir\w*|due|renew\w*|valid\s*(?:until|till|to)|when)\b/i.test(clean);
  return item && asks;
}

/** Which compliance item does the message refer to? */
export function detectComplianceItemAsked(text = '') {
  const clean = String(text || '');
  if (/\binspection\b/i.test(clean)) return 'inspection';
  if (/\b(?:road\s*service|psl|permit)\b/i.test(clean)) return 'road_service_licence';
  if (/\b(?:licen[cs]e)\b/i.test(clean)) return 'road_service_licence';
  if (/\binsur\w*\b|\bcommencing\b|\bcommencement\b/i.test(clean)) return 'insurance';
  return null;
}

/**
 * Correction detector: a correction marker + a date phrase + a compliance
 * reference ("insurance", or the insurance-only word "commencement").
 */
export function detectComplianceCorrection(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 400) return { isCorrection: false };
  const corrected = /\b(?:wrong|incorrect|mistake|mistaken|misread|not\s+right|correction|correct\s+that)\b/i.test(clean);
  if (!corrected) return { isCorrection: false };
  const kind = detectComplianceItemAsked(clean);
  if (!kind) return { isCorrection: false };
  return { isCorrection: true, kind };
}

const CATALOG_LABELS = {
  insurance: 'Insurance',
  inspection: 'Inspection',
  road_service_licence: 'Road service licence'
};

function daysFromIso(iso, now = new Date()) {
  if (!iso) return null;
  try {
    return diffCalendarDays(now, iso);
  } catch {
    return null;
  }
}

/** Answer a single "when does <item> expire?" question for the active vehicle. */
export function buildComplianceExpiryAnswer({ vehicle = null, rows = [], asked = null, now = new Date() } = {}) {
  const plate = vehicle?.plate_number || 'your vehicle';
  const wanted = asked ? rows.filter((row) => row.type === asked) : rows;
  if (!wanted.length) {
    const itemLabel = asked ? (CATALOG_LABELS[asked] || asked) : 'compliance details';
    return `📄 I do not have ${itemLabel.toLowerCase()} on file for *${plate}* yet.\n\nSend a photo of the document (or reply e.g. _"insurance expires 20/11/2026"_) and I will save the date and set reminders.`;
  }
  const lines = wanted.map((row) => {
    const label = row.label || CATALOG_LABELS[row.type] || row.type;
    if (row.lifetime) return `• ${label}: valid for life 🟢`;
    const days = daysFromIso(row.expiry, now);
    return `• ${label}: *${formatComplianceDate(row.expiry)}* ${complianceChip(days)} (${formatDaysLeft(days)})${row.number ? ` · ${row.number}` : ''}`;
  });
  return `🗓️ *${plate} — expiry*\n\n${lines.join('\n')}\n\n_Reply "my compliance" for the full card, or "my reminders" for what is coming up._`;
}

/** Full compliance card for the active vehicle. */
export function buildComplianceStatusReply({ vehicle = null, rows = [], now = new Date() } = {}) {
  const plate = vehicle?.plate_number || 'your vehicle';
  const order = ['insurance', 'inspection', 'road_service_licence'];
  const sorted = [...rows].sort((a, b) => {
    const ai = order.indexOf(a.type);
    const bi = order.indexOf(b.type);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const lines = sorted.map((row) => {
    const label = row.label || CATALOG_LABELS[row.type] || row.type;
    if (row.lifetime) return `• ${label} — valid for life 🟢`;
    const days = daysFromIso(row.expiry, now);
    return `• ${label} — ${formatComplianceDate(row.expiry)} ${complianceChip(days)} · ${formatDaysLeft(days) || 'no date'}${row.number ? ` · ${row.number}` : ''}`;
  });
  return `🛡️ *Compliance — ${plate}*\n\n${lines.length ? lines.join('\n') : 'No compliance documents on file yet.'}\n\n_Reply "my reminders" for upcoming dates, or send a document photo to add one._`;
}

/** Upcoming/overdue reminders list (all active reminders). */
export function buildRemindersListReply({ reminders = [], vehicles = [], now = new Date() } = {}) {
  const plateById = new Map((vehicles || []).map((v) => [v.id, v.plate_number]));
  const valid = (reminders || [])
    .filter((row) => row && row.due_date)
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  if (!valid.length) {
    return '🔔 *Reminders*\n\nNothing is scheduled yet.\n\nReply *"set reminder"* (e.g. _"insurance expires 20/11/2026"_) and I will set it up.';
  }
  const lines = valid.slice(0, 10).map((row) => {
    const date = new Date(row.due_date);
    const iso = Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    const days = daysFromIso(iso, now);
    const plate = row.vehicle_id ? plateById.get(row.vehicle_id) : null;
    return `• ${complianceChip(days)} ${row.reminder_type || 'Reminder'}${plate ? ` — ${plate}` : ''} · ${formatComplianceDate(iso)} (${formatDaysLeft(days) || 'no date'})`;
  });
  return `🔔 *Reminders*\n\n${lines.join('\n')}\n\n_Reply "my compliance" for insurance, inspection and permit dates._`;
}

/**
 * Apply a typed expiry correction: update the compliance ledger, the legacy
 * vehicle column and the linked reminder, all through the same engine the
 * document flow uses (so reminders and reports stay consistent).
 */
export async function applyComplianceCorrection({
  supabase,
  vehicle = null,
  kind = 'insurance',
  text = '',
  countryCode = 'GLOBAL',
  locale = 'en-US',
  timeZone = SYSTEM_TIMEZONE,
  ownerId = null,
  now = new Date()
} = {}) {
  if (!supabase || !vehicle?.id) return { ok: false, error: 'vehicle required' };
  const extracted = extractDatePhrase(String(text || ''), { countryCode, locale, now });
  if (!extracted?.ok || !extracted.localDate) return { ok: false, error: 'no date found' };
  const assetType = vehicle.asset_type || vehicle.metadata?.asset_type || null;
  const catalog = resolveVehicleComplianceCatalog({ countryCode, assetType });
  const item = (catalog.items || []).find((entry) => entry.type === kind);
  if (!item) return { ok: false, error: 'unknown compliance item' };
  let number = null;
  try {
    const { data } = await supabase
      .from('vehicle_compliances')
      .select('number')
      .eq('vehicle_id', vehicle.id)
      .eq('type', kind)
      .maybeSingle();
    number = data?.number || null;
  } catch { /* number stays null */ }
  const daysLeft = diffCalendarDays(now, extracted.localDate);
  const saved = await submitVehicleCompliance({
    supabase,
    vehicle,
    item,
    parsed: {
      ok: true,
      number,
      expiry: extracted.localDate,
      dueAt: null,
      lifetime: false,
      daysLeft,
      expired: Number.isFinite(daysLeft) && daysLeft < 0,
      timeZone
    },
    countryCode,
    assetType,
    ownerId,
    timeZone,
    now
  });
  if (!saved?.ok) return { ok: false, error: saved?.error || 'save failed' };
  return {
    ok: true,
    kind,
    label: item.label || CATALOG_LABELS[kind] || kind,
    expiry: extracted.localDate,
    number
  };
}

export default {
  detectRemindersListCommand,
  detectComplianceStatusCommand,
  detectComplianceExpiryQuestion,
  detectComplianceCorrection,
  detectComplianceItemAsked,
  buildComplianceExpiryAnswer,
  buildComplianceStatusReply,
  buildRemindersListReply,
  applyComplianceCorrection,
  formatComplianceDate,
  formatDaysLeft,
  complianceChip
};
