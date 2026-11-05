/**
 * Saka Fleet — Compliance capture (v1.58.25)
 * ------------------------------------------
 * One deterministic lane for "add my <document>" requests, for BOTH roles:
 *   • a driver assigned to a vehicle  (existing lane, unchanged)
 *   • an owner keeping their own driver documents (new — live 2026-11-04:
 *     "Add psv license" from an owner fell through to the generic menu 4x
 *     because the old lane required `vehicles.assigned_driver_id`)
 *
 * The lane never dumps the user into a menu. It either:
 *   1. saves when the message already carries the number AND the expiry,
 *   2. asks ONE short question for the missing piece (and remembers the rest
 *      for COMPLIANCE_CAPTURE_TTL_MINUTES), or
 *   3. offers the exact one-line example when nothing usable is present.
 *
 * Pure + stateless on purpose: every function is unit-tested in
 * `test_compliance_capture.js` with zero DB and zero network. Rule 51 — the
 * sibling vehicle-permit request ("add insurance") rides the same lane.
 */

import {
  extractDatePhrase,
  zonedDateTimeToUtcIso,
  diffCalendarDays,
  SYSTEM_TIMEZONE
} from './dateParser.js';

export const COMPLIANCE_CAPTURE_TTL_MINUTES = 15;

/** Words that mean "this is a document I hold", per role. */
export const DRIVER_DOC_RE = /\b(licen[cs]e|psv|cpc|cdl|pdp|permit|operator\s*card|badge|compliance|documents?)\b/i;
export const VEHICLE_DOC_RE = /\b(insurance|insured|inspection|mot|roadworthy|road\s*service|psl|road\s*tax|licence\s*disc|license\s*disc|speed\s*limiter|registration|emissions|policy)\b/i;

const ADD_VERB_RE = /\b(add(?:ed)?|save(?:d)?|record(?:ed)?|register(?:ed)?|update(?:d)?|upload(?:ed)?|store(?:d)?|attach(?:ed)?|renew(?:ed)?|capture(?:d)?|keep|submit(?:ted)?|sent)\b/i;
/** Read/ask openers are answered by the read lanes, never turned into a capture. */
const READ_OR_QUESTION_RE = /^\s*(?:can|could|how|what|whats|what's|where|when|why|which|who|do|does|did|is|are|was|should|would|will|show|list|view|see|open|display|read|check|send|print)\b/i;

const LIFETIME_RE = /\b(lifetime|for life|no expiry|never expires|non[- ]expiring|permanent)\b/i;
const NUMBER_TOKEN_RE = /\b((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{2,23})\b/i;
const DATE_LABEL_RE = /\b(?:expir\w*|valid\s*(?:until|to|till)|due)\b/i;

function normalizeText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Whole-word/phrase match (aliases never match inside longer words). */
export function matchesPhrase(text, phrase) {
  const hay = normalizeText(text).toLowerCase();
  const needle = normalizeText(phrase).toLowerCase();
  if (!hay || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(hay);
}

export function catalogCandidates(catalog) {
  if (Array.isArray(catalog?.items)) return catalog.items.filter(Boolean);
  if (!catalog?.minimal) return [];
  return [catalog.minimal, ...(catalog.additional || [])].filter(Boolean);
}

/** The first catalog item the user named (alias, label or type). */
export function findMentionedComplianceItem(text, catalog) {
  return catalogCandidates(catalog).find((item) => {
    const names = [String(item.type || '').replace(/_/g, ' '), item.label, ...(item.aliases || [])];
    return names.some((name) => name && matchesPhrase(text, name));
  }) || null;
}

/**
 * Which vehicle gives this turn its compliance context?
 * An assigned driver keeps priority (gate semantics unchanged); an OWNER falls
 * back to their own profile so self-documents are capturable (rule 51 sibling).
 */
export function pickComplianceContextVehicle({ vehicles = [], profileId = null } = {}) {
  const list = Array.isArray(vehicles) ? vehicles : [];
  const assigned = list.find((v) => v && v.assigned_driver_id && v.assigned_driver_id === profileId) || null;
  if (assigned) return { vehicle: assigned, isSelfProfile: false };
  const owned = list.find((v) => v && v.owner_id && v.owner_id === profileId) || null;
  if (owned) return { vehicle: owned, isSelfProfile: true };
  return { vehicle: null, isSelfProfile: false };
}

function extractNumberToken(text, datePhrase = null) {
  let withoutDates = String(text || '');
  if (datePhrase) {
    const escaped = datePhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    withoutDates = withoutDates.replace(new RegExp(escaped, 'i'), ' ');
  }
  withoutDates = withoutDates.replace(/\b(19|20)\d{2}\b/g, ' ');
  const match = withoutDates.match(NUMBER_TOKEN_RE);
  if (!match) return null;
  const token = String(match[1]).toUpperCase();
  if (/^(19|20)\d{2}$/.test(token)) return null;
  return token;
}

/**
 * Read whatever the message offers — a full parse first, then a partial
 * (number only / expiry only) so the lane can ask ONE question instead of
 * dumping the menu (the live PSV paragraph had the expiry but no badge number).
 */
export function extractComplianceDetails(text, {
  item = null,
  countryCode = 'GLOBAL',
  locale = 'en-US',
  timeZone = SYSTEM_TIMEZONE,
  now = new Date()
} = {}) {
  const clean = normalizeText(text);
  if (!clean) return { ok: false, number: null, expiry: null, lifetime: false, item };

  const lifetime = LIFETIME_RE.test(clean);
  let expiry = null;
  let datePhrase = null;
  let confidence = null;
  if (!lifetime) {
    const anchor = clean.search(DATE_LABEL_RE);
    const dateSource = anchor >= 0 ? clean.slice(anchor) : clean;
    const extracted = extractDatePhrase(dateSource, { countryCode, locale, now });
    if (extracted?.ok) {
      expiry = extracted.localDate;
      datePhrase = extracted.phrase;
      confidence = extracted.confidence ?? null;
    }
  }

  const number = extractNumberToken(clean, datePhrase);
  if (!number) {
    return { ok: false, number: null, expiry: lifetime ? null : expiry, lifetime, item };
  }
  if (!lifetime && !expiry) return { ok: false, number, expiry: null, lifetime: false, item };

  const daysLeft = expiry ? diffCalendarDays(now, expiry) : null;
  return {
    ok: true,
    item,
    parsed: {
      ok: true,
      number,
      expiry: lifetime ? null : expiry,
      dueAt: lifetime ? null : zonedDateTimeToUtcIso(expiry, timeZone),
      lifetime,
      daysLeft,
      expired: daysLeft !== null && daysLeft < 0,
      timeZone,
      catalogItem: item,
      phrase: datePhrase,
      confidence
    }
  };
}

/** Merge a pending partial capture with the follow-up turn. */
export function mergeComplianceCapture(pending = {}, text = '', {
  item = null,
  countryCode = 'GLOBAL',
  locale = 'en-US',
  timeZone = SYSTEM_TIMEZONE,
  now = new Date()
} = {}) {
  const clean = normalizeText(text);
  if (!clean) return { ok: false, item };
  const lifetime = LIFETIME_RE.test(clean);
  const details = extractComplianceDetails(clean, { item, countryCode, locale, timeZone, now });
  if (details.ok) return details;

  const number = details.number || pending.number || null;
  const isLifetime = lifetime || (!details.expiry && Boolean(pending.lifetime));
  let expiry = isLifetime ? null : (details.expiry || pending.expiry || null);
  if (!number) return { ok: false, number: null, expiry, lifetime: isLifetime, item };

  if (!isLifetime && !expiry) {
    // A bare follow-up date ("8 Aug 2027") is read on its own.
    const extracted = extractDatePhrase(clean, { countryCode, locale, now });
    if (extracted?.ok) expiry = extracted.localDate;
  }
  if (!isLifetime && !expiry) return { ok: false, number, expiry: null, lifetime: false, item };

  const daysLeft = expiry ? diffCalendarDays(now, expiry) : null;
  return {
    ok: true,
    item,
    parsed: {
      ok: true,
      number,
      expiry: isLifetime ? null : expiry,
      dueAt: isLifetime ? null : zonedDateTimeToUtcIso(expiry, timeZone),
      lifetime: isLifetime,
      daysLeft,
      expired: daysLeft !== null && daysLeft < 0,
      timeZone,
      catalogItem: item
    }
  };
}


/** "add psv license", "i want to add a psv licence", "record my insurance"… */
export function detectComplianceAddRequest(text, { catalog, scope = 'driver' } = {}) {
  const clean = normalizeText(text);
  if (!clean) return null;
  if (READ_OR_QUESTION_RE.test(clean)) return null;
  if (scope === 'driver' ? !DRIVER_DOC_RE.test(clean) : !VEHICLE_DOC_RE.test(clean)) return null;
  if (!ADD_VERB_RE.test(clean)) return null;
  const item = findMentionedComplianceItem(clean, catalog);
  return item ? { scope, item } : null;
}

function docExample(item, scope) {
  return scope === 'vehicle'
    ? `${item.label} ABC123 expires 15 May 2027`
    : `${item.label} 445566 expires 8 Aug 2027`;
}

/** Warm, plain-language prompt: exactly one next step (rule 31). */
export function complianceCapturePrompt({
  item,
  scope = 'driver',
  have = {},
  contextLabel = null
} = {}) {
  if (!item?.label) return null;
  const where = contextLabel ? ` for ${contextLabel}` : '';
  const known = [];
  if (have.number) known.push(`number *${have.number}*`);
  if (have.lifetime) known.push('no expiry');
  else if (have.expiry) known.push(`expiry *${have.expiry}*`);

  if (have.number && !have.lifetime && !have.expiry) {
    return `📄 Got it — ${item.label}${where}, ${known[0]}.\n\nWhat's the expiry date? Reply with a date (e.g. *8 Aug 2027*), or say *lifetime* if it never expires.`;
  }
  if (!have.number && (have.lifetime || have.expiry)) {
    return `📄 Got it — ${item.label}${where}, ${known[0]}.\n\nWhat's the document number?`;
  }

  const lines = [`📄 Happy to add your ${item.label}${where}.`, ''];
  if (have.number || have.expiry) {
    lines.push(`I have ${known.join(' and ')}. Send the rest in one line:`);
  } else {
    lines.push('Send it in one line — number + expiry:');
  }
  lines.push(`Example: _${docExample(item, scope)}_`);
  lines.push('');
  lines.push('_Reply *cancel* to stop._');
  return lines.join('\n');
}

/** Deterministic confirmation (engine facts only — never invented values). */
export function formatComplianceSaved({ item, parsed, scope = 'driver', contextLabel = null } = {}) {
  const where = contextLabel ? ` — ${contextLabel}` : '';
  const expiryLine = parsed?.lifetime
    ? '• Valid for life'
    : `• Expires: ${parsed?.expiry}${Number.isFinite(Number(parsed?.daysLeft)) ? ` (in ${parsed.daysLeft} day${Number(parsed.daysLeft) === 1 ? '' : 's'})` : ''}`;
  return [
    `✅ *${item?.label || 'Document'} saved${where}*`,
    '',
    `• Number: ${parsed?.number}`,
    expiryLine,
    '',
    `I'll remind you ${scope === 'vehicle' ? 'and your team ' : ''}before it expires.`
  ].join('\n');
}

export function isComplianceCaptureCancel(text = '') {
  return /^\s*(?:cancel|stop|exit|quit|never\s*mind|forget\s*it|not\s*now)\s*[.!]?\s*$/i.test(String(text));
}

/** Deterministic cancel acknowledgement (lives here, never inline in the route). */
export function complianceCaptureCancelText() {
  return '👍 No problem — nothing was saved.';
}

/**
 * Rule 37 sibling: a fresh ledger log always outranks a stale capture prompt.
 * "Logged 40L at 50350 km" must never be eaten by a pending document question.
 */
export function looksLikeFreshLogLine(text = '') {
  const clean = String(text || '');
  if (!/\d/.test(clean)) return false;
  return /\b(log|logged|spent|paid|bought|filled|refuell?ed|earned|collected|received|odometer|mileage|litres?|liters?|fuel|diesel|petrol|service|repair)\b/i.test(clean);
}

export function isComplianceCaptureExpired(pending, now = new Date()) {
  if (!pending?.at) return true;
  const at = new Date(pending.at).getTime();
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at > COMPLIANCE_CAPTURE_TTL_MINUTES * 60 * 1000;
}

export default {
  COMPLIANCE_CAPTURE_TTL_MINUTES,
  DRIVER_DOC_RE,
  VEHICLE_DOC_RE,
  matchesPhrase,
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
  isComplianceCaptureExpired
};

