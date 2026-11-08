import { extractDatePhrase, diffCalendarDays, SYSTEM_TIMEZONE } from './dateParser.js';
import { resolveVehicleComplianceCatalog, submitVehicleCompliance } from './vehicleCompliance.js';
// v1.84.0 (Phase 23) — a corrected compliance row re-links its stored document.
import { linkSavedComplianceDocument } from './vehicleDocuments.js';

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

const MAINTENANCE_PARTS = [
  ['tyres', /tyre|tire/i],
  ['brakes', /brake|\bpads?\b|disc|rotor/i],
  ['oil', /\boil\b/i],
  ['battery', /battery/i],
  ['filters', /filter/i],
  ['spark plugs', /spark\s*plug|\bplugs?\b/i],
  ['coolant', /coolant|antifreeze/i],
  ['belts', /\bbelts?\b|timing/i],
  ['wipers', /wiper/i]
];

/**
 * v1.56.3 — "When am I supposed to buy my front tyres?" / "how often should I
 * change the oil?" is a maintenance-schedule question, not a generic menu.
 */
export function detectMaintenanceScheduleQuestion(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 140) return false;
  if (/\breport\b/i.test(clean)) return false;
  if (carriesExplicitDate(clean)) return false;
  const asksWhen = /\b(?:when|how\s+often|how\s+many\s+(?:km|kilomet(?:er|re)s?|miles?))\b/i.test(clean);
  const verb = /\b(?:buy|replace|change|service|rotate|check|inspect|do|need)\b/i.test(clean);
  const part = MAINTENANCE_PARTS.some(([, re]) => re.test(clean));
  return asksWhen && verb && part;
}

/** Which maintenance part does the message name? */
export function detectMaintenancePart(text = '') {
  const clean = String(text || '');
  for (const [name, re] of MAINTENANCE_PARTS) {
    if (re.test(clean)) return name;
  }
  return null;
}

/** Deterministic answer from the user's own reminders; never invents intervals. */
export function buildMaintenanceScheduleAnswer({ vehicle = null, reminders = [], asked = null } = {}) {
  const plate = vehicle?.plate_number || 'your vehicle';
  const part = asked || 'maintenance';
  const partRe = (MAINTENANCE_PARTS.find(([name]) => name === part) || [null, new RegExp(part, 'i')])[1];
  const wanted = (reminders || []).filter((r) => partRe.test(String(r.reminder_type || '')));
  if (wanted.length) {
    const lines = wanted.slice(0, 3).map((r) => {
      const label = r.reminder_type || 'Reminder';
      const value = Number(r.threshold_value || 0);
      if (r.threshold_unit === 'distance' && value > 0) return `🔔 ${label}: at *${value.toLocaleString()} km*`;
      if (r.threshold_unit === 'hours' && value > 0) return `🔔 ${label}: at *${value.toLocaleString()} h*`;
      if (r.due_date) return `🔔 ${label}: due *${r.due_date}*`;
      return `🔔 ${label}`;
    });
    return `📌 *${part[0].toUpperCase()}${part.slice(1)} for ${plate}*\n\n${lines.join('\n')}\n\n_Read from your own reminders._`;
  }
  return `📌 I don't have a ${part} reminder for *${plate}* yet — and I won't guess an interval, since ${part} life depends on how the vehicle is used.\n\nWant me to track it? Reply e.g. _remind me to replace ${part} at 400,000 km_ or _in 6 months_.`;
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

/** Full compliance card for the active vehicle (+ the caller's driver documents). */
export function buildComplianceStatusReply({ vehicle = null, rows = [], driverRows = [], profile = null, now = new Date() } = {}) {
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
  // v1.61.2 — owners and drivers see their DRIVER documents on the same card
  // (the two ledgers stay separate; this is presentation only).
  const driverDocs = driverDocLines(driverRows, now);
  const driverBlock = driverDocs.length
    ? `\n\n🪪 *Driver documents${profile?.full_name ? ` — ${String(profile.full_name).split(' ')[0]}` : ''}*\n${driverDocs.map((row) => {
      if (row.lifetime) return `• ${row.label} — valid for life 🟢${row.number ? ` · ${row.number}` : ''}`;
      const days = daysFromIso(row.expiry, now);
      return `• ${row.label} — ${formatComplianceDate(row.expiry)} ${complianceChip(days)} · ${formatDaysLeft(days) || 'no date'}${row.number ? ` · ${row.number}` : ''}`;
    }).join('\n')}`
    : '';
  return `🛡️ *Compliance — ${plate}*\n\n${lines.length ? lines.join('\n') : 'No compliance documents on file yet.'}${driverBlock}\n\n_Reply "my reminders" for upcoming dates, or send a document photo to add one._`;
}

/* ------------------------------------------------------------------ */
/* v1.61.2 — DRIVER documents (owner self-profile + assigned drivers)  */
/* ------------------------------------------------------------------ */

/**
 * Live 2026-11-05: "Driver licenses" / "List my licenses" / "List psv badge"
 * were answered from the EXPENSE ledger ("Nothing under licences & permits")
 * and "I just submitted a psv badge for my driver profile. Confirm" fell to a
 * generic menu — while driver_compliances held the saved badge. These helpers
 * give driver documents their own deterministic read/confirm lane.
 */

export function normalizeDriverDocType(value = '') {
  const clean = String(value || '').toLowerCase().replace(/\s+/g, '_');
  if (['driver_license', 'driver_licence', 'driving_license', 'licence', 'license', 'dl'].includes(clean)) return 'driving_licence';
  if (['psv', 'psv_badge', 'badge', 'public_service_vehicle_badge'].includes(clean)) return 'psv_badge';
  if (['professional_driving_permit'].includes(clean)) return 'pdp';
  if (['operator_license', 'operator_licence'].includes(clean)) return 'operator_card';
  if (['medical'].includes(clean)) return 'medical_certificate';
  return clean || 'other';
}

const DRIVER_DOC_LABELS = {
  driving_licence: 'Driving Licence',
  psv_badge: 'PSV Badge',
  pdp: 'PDP',
  cpc: 'CPC',
  operator_card: 'Operator Card',
  medical_certificate: 'Medical Certificate',
  defensive_driving: 'Defensive Driving',
  other: 'Other Document'
};

/**
 * Is this a DRIVER-document read/confirm? Returns `{ asked, confirm }` or null.
 * Never matches vehicle permits (insurance/inspection/PSL), the PDF report
 * engine, reminder creation, date-bearing answers or spend/log lines.
 */
export function detectDriverComplianceRead(text = '') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 140) return null;
  if (/\breport\b/i.test(clean)) return null;
  if (isReminderCreation(clean)) return null;
  if (carriesExplicitDate(clean)) return null;
  const mentionsDoc = /\b(?:psv(?:\s*badge)?|pdp|cpc|operator\s*card|medical\s*(?:certificate)?|defensive\s*driving|driver\s*(?:compliances?|documents?)|driver'?s?\s+licen[cs]es?|driving\s+licen[cs]es?|my\s+(?:licen[cs]es?|compliances)\b|all\s+licen[cs]es?)\b/i.test(clean);
  if (!mentionsDoc) return null;
  // A spend/log line belongs to the ledger, not to a document read.
  if (/\b(?:paid|spent|cost|bought|renewed|log(?:ged)?)\b/i.test(clean) && /\d{2,}/.test(clean)) return null;
  const startsWithRead = /^(?:list|show|see|view|check|confirm|display|verify)\b/i.test(clean);
  const readCue = startsWithRead
    || /\b(?:my|confirm|verify|status|details?|saved|on\s+file)\b/i.test(clean);
  const hasAddVerb = /\b(?:add|save|record|register|upload|attach|renew|capture|submit(?:ted)?|sent)\b/i.test(clean);
  // "add psv badge" is a capture, not a read; a confirm/read cue always wins.
  if (!readCue && hasAddVerb) return null;
  if (!readCue && clean.split(/\s+/).filter(Boolean).length > 3) return null;
  let asked = null;
  if (/\bpsv\b/i.test(clean)) asked = 'psv_badge';
  else if (/\bpdp\b/i.test(clean)) asked = 'pdp';
  else if (/\bcpc\b/i.test(clean)) asked = 'cpc';
  else if (/operator\s*card/i.test(clean)) asked = 'operator_card';
  else if (/medical/i.test(clean)) asked = 'medical_certificate';
  else if (/defensive/i.test(clean)) asked = 'defensive_driving';
  else if (/licen[cs]e/i.test(clean)) asked = 'driving_licence';
  const confirm = /\b(?:confirm|verify|saved|submitted)\b/i.test(clean);
  return { asked, confirm };
}

/**
 * v1.61.3 — "list all documents with expiry date" / "show all expiry documents"
 * is a merged read: vehicle permits AND driver documents, one list.
 */
export function detectAllDocumentsExpiryRead(text = '') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!clean || clean.length > 120) return null;
  if (/\breport\b/i.test(clean)) return null;
  const docWord = /\b(?:documents?|docs?|compliances?|permits?|licen[cs]es?)\b/.test(clean);
  const expiryWord = /\b(?:expir\w*|renew\w*|due|valid)\b/.test(clean);
  const allWord = /\b(?:all|every|both|any)\b/.test(clean) || /\bmy\b/.test(clean);
  if (!docWord || !expiryWord) return null;
  if (!allWord && !/^(?:list|show|see|view)\b/.test(clean)) return null;
  return { scope: 'all' };
}

/**
 * v1.61.3 — document-number search: "search TSV2026" / "find DL-123456".
 * Live 2026-11-05: the user searched the badge number and got the expense
 * ledger's empty answer ("Now it's nowhere to be found").
 */
export function detectComplianceNumberSearch(text = '') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 120) return null;
  const explicit = /^(?:search|find|look\s*up|where\s+is|locate)\b/i.test(clean);
  const token = clean.match(/\b([A-Z]{2,}[-\/]?\d{3,}[A-Z0-9\-\/]*|\d{6,}[A-Z0-9\-\/]*)\b/i);
  if (!token) return null;
  if (!explicit && !/\b(?:document|licen[cs]e|badge|psv|permit|policy|number)\b/i.test(clean)) return null;
  return { number: String(token[1]).toUpperCase() };
}

/** Merged expiry list across BOTH ledgers (vehicle permits + driver documents). */
export function buildAllDocumentsExpiryReply({ vehicles = [], vehicleRows = [], driverRows = [], profile = null, now = new Date() } = {}) {
  const plateById = new Map((vehicles || []).map((vehicle) => [vehicle.id, vehicle.plate_number]));
  const name = profile?.full_name ? String(profile.full_name).split(' ')[0] : null;
  const lines = [];
  for (const row of vehicleRows || []) {
    const plate = row.vehicle_id ? plateById.get(row.vehicle_id) : null;
    const label = row.label || CATALOG_LABELS[row.type] || row.type || 'Permit';
    if (row.lifetime) { lines.push(`• 🚗 ${label}${plate ? ` — ${plate}` : ''} — valid for life 🟢`); continue; }
    const days = daysFromIso(row.expiry, now);
    lines.push(`• 🚗 ${label}${plate ? ` — ${plate}` : ''} — ${formatComplianceDate(row.expiry)} ${complianceChip(days)} · ${formatDaysLeft(days) || 'no date'}${row.number ? ` · ${row.number}` : ''}`);
  }
  for (const row of driverDocLines(driverRows, now)) {
    if (row.lifetime) { lines.push(`• 🪪 ${row.label} — valid for life 🟢${row.number ? ` · ${row.number}` : ''}`); continue; }
    const days = daysFromIso(row.expiry, now);
    lines.push(`• 🪪 ${row.label} — ${formatComplianceDate(row.expiry)} ${complianceChip(days)} · ${formatDaysLeft(days) || 'no date'}${row.number ? ` · ${row.number}` : ''}`);
  }
  if (!lines.length) {
    return `🗂️ *Documents with expiry${name ? ` — ${name}` : ''}*\n\nNothing is on file yet.\n\n_Vehicle permits: "add insurance". Driver documents: "add psv badge TSV2026 expires 8 Aug 2027"._`;
  }
  const sorted = lines.sort((a, b) => {
    const da = a.match(/(\d{2}) (\w{3}) (\d{4})/);
    const db = b.match(/(\d{2}) (\w{3}) (\d{4})/);
    if (!da || !db) return 0;
    return new Date(`${da[2]} ${da[1]}, ${da[3]}`) - new Date(`${db[2]} ${db[1]}, ${db[3]}`);
  });
  return `🗂️ *Documents with expiry${name ? ` — ${name}` : ''}*\n\n${sorted.slice(0, 20).join('\n')}\n\n_🪪 = your driver documents · 🚗 = vehicle permits. Reply "my compliance" for the vehicle card or "my driver documents" for details._`;
}

/** Deterministic result for a document-number search across both ledgers. */
export function buildComplianceNumberSearchReply({ number = '', vehicles = [], vehicleRows = [], driverRows = [], now = new Date() } = {}) {
  const needle = String(number || '').toUpperCase();
  const plateById = new Map((vehicles || []).map((vehicle) => [vehicle.id, vehicle.plate_number]));
  const hits = [];
  for (const row of driverDocLines(driverRows, now)) {
    if (String(row.number || '').toUpperCase().includes(needle)) {
      const days = row.lifetime ? null : daysFromIso(row.expiry, now);
      hits.push(`🪪 *${row.label}* — ${row.number || needle}${row.lifetime ? ' · valid for life 🟢' : ` · expires ${formatComplianceDate(row.expiry)} ${complianceChip(days)} (${formatDaysLeft(days) || 'no date'})`}\n_Your driver document._`);
    }
  }
  for (const row of vehicleRows || []) {
    if (String(row.number || '').toUpperCase().includes(needle)) {
      const plate = row.vehicle_id ? plateById.get(row.vehicle_id) : null;
      const days = row.lifetime ? null : daysFromIso(row.expiry, now);
      hits.push(`🚗 *${row.label || row.type || 'Permit'}*${plate ? ` — ${plate}` : ''} — ${row.number}${row.lifetime ? ' · valid for life 🟢' : ` · expires ${formatComplianceDate(row.expiry)} ${complianceChip(days)} (${formatDaysLeft(days) || 'no date'})`}\n_Vehicle permit._`);
    }
  }
  if (!hits.length) {
    return `🔎 No document matches *${number}*.\n\n_Reply "my driver documents" for your driver records or "all documents with expiry date" for both ledgers._`;
  }
  return `🔎 *Found ${hits.length} match${hits.length === 1 ? '' : 'es'} for ${number}*\n\n${hits.slice(0, 5).join('\n\n')}`;
}

function driverDocLines(rows = [], now = new Date()) {
  const order = ['driving_licence', 'psv_badge', 'pdp', 'cpc', 'operator_card', 'medical_certificate', 'defensive_driving', 'other'];
  return [...(rows || [])]
    .map((row) => {
      const type = normalizeDriverDocType(row.type);
      return { ...row, type, label: row.label || DRIVER_DOC_LABELS[type] || 'Document' };
    })
    .sort((a, b) => {
      const ai = order.indexOf(a.type);
      const bi = order.indexOf(b.type);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
}

/** Deterministic driver-document card / confirmation (zero tokens). */
export function buildDriverComplianceReply({ rows = [], profile = null, asked = null, confirm = false, now = new Date() } = {}) {
  const name = profile?.full_name ? String(profile.full_name).split(' ')[0] : null;
  const all = driverDocLines(rows, now);
  const wanted = asked ? all.filter((row) => row.type === asked) : all;
  const askedLabel = asked ? (DRIVER_DOC_LABELS[asked] || 'document') : 'driver document';
  if (confirm) {
    // An asked document never falls back to a different one — confirming a CPC
    // must never confirm the driving licence instead.
    const row = wanted[0] || (asked ? null : all[0] || null);
    if (!row) {
      return `🪪 I don't have your ${askedLabel.toLowerCase()} on file yet.\n\nSend it in one line — number + expiry:\nExample: _${asked === 'psv_badge' ? 'PSV badge TSV2026 expires 8 Aug 2027' : 'Driving Licence DL123456 expires 28 Nov 2028'}_`;
    }
    const days = row.lifetime ? null : daysFromIso(row.expiry, now);
    return [
      `✅ *On file ✓ ${row.label}*${name ? ` — ${name}` : ''}`,
      '',
      `• Number: ${row.number || '—'}`,
      row.lifetime ? '• Valid for life' : `• Expires: ${formatComplianceDate(row.expiry)} ${complianceChip(days)}${Number.isFinite(days) ? ` (${formatDaysLeft(days)})` : ''}`,
      '',
      '_Stored in your driver documents — reply "my driver documents" to see them all._'
    ].join('\n');
  }
  if (!all.length) {
    return `🪪 *Driver documents${name ? ` — ${name}` : ''}*\n\nNo driver documents on file yet.\n\nSend one in a line — number + expiry:\nExample: _PSV badge TSV2026 expires 8 Aug 2027_\n\n_Vehicle permits (insurance, inspection, PSL) live under "my compliance"._`;
  }
  const list = wanted.length ? wanted : all;
  const intro = asked && wanted.length === 0
    ? `I don't have a ${askedLabel.toLowerCase()} on file yet — here's what is saved:\n`
    : '';
  const lines = list.map((row) => {
    if (row.lifetime) return `• ${row.label} — valid for life 🟢${row.number ? ` · ${row.number}` : ''}`;
    const days = daysFromIso(row.expiry, now);
    return `• ${row.label} — ${formatComplianceDate(row.expiry)} ${complianceChip(days)} · ${formatDaysLeft(days) || 'no date'}${row.number ? ` · ${row.number}` : ''}`;
  });
  return `🪪 *Driver documents${name ? ` — ${name}` : ''}*\n\n${intro}${lines.join('\n')}\n\n_Vehicle permits (insurance, inspection, PSL) live under "my compliance"._`;
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
  // v1.84.0 (Phase 23) — the vaulted document id (when the correction follows
  // a photo). The deterministic vehicle+type match is the fallback.
  documentId = null,
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
  // v1.84.0 (Phase 23) — the corrected row keeps its proof document linked.
  await linkSavedComplianceDocument({
    supabase,
    vehicleId: vehicle.id,
    complianceType: kind,
    documentId
  });
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
  detectDriverComplianceRead,
  detectAllDocumentsExpiryRead,
  detectComplianceNumberSearch,
  normalizeDriverDocType,
  buildDriverComplianceReply,
  buildAllDocumentsExpiryReply,
  buildComplianceNumberSearchReply,
  buildComplianceExpiryAnswer,
  buildComplianceStatusReply,
  buildRemindersListReply,
  applyComplianceCorrection,
  formatComplianceDate,
  formatDaysLeft,
  complianceChip
};
