/**
 * Saka Fleet — Narrative Draft builder (v1.34.0)
 * -----------------------------------------------------------------
 * Turns one free-text WhatsApp sentence ("spent 5500 on diesel yesterday at
 * Shell, 40L at 50350km, full tank") into a deterministic draft that the quiz
 * engine can pre-fill.
 *
 * Design contract (permanent):
 *  - Deterministic first: money, volume, odometer, date, vendor and expense type
 *    are all resolved by pure local code. No AI is required and no AI result may
 *    ever overwrite a deterministic value.
 *  - Never guess: when an amount is ambiguous the draft says so (`ambiguous`)
 *    instead of inventing a number.
 *  - Never throws: every public function returns a plain object.
 *  - Global by default: currency, locale, units and date conventions come from
 *    the country resolved off the WhatsApp number.
 *  - Dates are resolved by `src/services/dateParser.js` only and are already
 *    normalized to Africa/Nairobi (canonical YYYY-MM-DD).
 */

import { resolveExpenseType, hasExpenseTypeMarker } from './expenseCatalog.js';
import { parseMoneyStory } from './moneyLexicon.js';
import { extractPastDatePhrase, SYSTEM_TIMEZONE } from './dateParser.js';
import { formatMoney, formatDate, resolveUnitSystem, userVolumeToLiters } from './globalization.js';
// v1.59.0 — optional record label (pure module; no import cycle).
import { extractEntryLabel } from './entryLabels.js';

export const NARRATIVE_DRAFT_VERSION = '1.34.0';

/** Kill switch — `NARRATIVE_INTAKE=off` disables narrative pre-fill entirely. */
export function isNarrativeIntakeEnabled(env = process.env) {
  const raw = String(env?.NARRATIVE_INTAKE ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !['off', 'false', '0', 'no', 'disabled'].includes(raw);
}

/**
 * v1.35.0 (D5) — a message only enters narrative intake when it is shaped like
 * a story: a paragraph (≥40 chars), at least one sentence break, or a clear
 * narrative marker (a past-date word, a per-litre price, a fill word, a
 * measurement or "at <Proper noun>"). Short one-liners keep the instant paths.
 */
const NARRATIVE_MARKER_RE = /(\b(?:yesterday|today|tonight|last\s+(?:night|week|evening)|ago|brimmed|top[\s-]?up|topped\s+up)\b|@\s?\d|\d[\d,.]*\s*(?:kes|ksh|usd|eur|gbp|bob|shillings?|l\b|lt\b|ltr\b|litres?|liters?|gal(?:lon)?s?\b|km\b|kms\b|mi\b|miles?\b)|\b(?:full\s+tank|partial)\b|\bat\s+[A-Z][a-z]+)/i;

export function isNarrativeEligibleText(text = '') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  if (clean.length >= 40) return true;
  if (/[.!?;]\s/.test(clean)) return true;
  return NARRATIVE_MARKER_RE.test(clean);
}

const EARNING_RE = /\b(earned|earnings?|made|collected|took in|takings?|income|revenue|hire fee|hire|contract|delivery job|customer paid|paid me|received|deposited)\b/i;
const MILEAGE_RE = /\b(odometer|odo|mileage|reading|clocked|now at|currently at|clock)\b/i;
const FULL_FILL_RE = /\b(full(?:\s+tank)?|brim(?:med)?|filled (?:it )?(?:to the top|up)|to the top)\b/i;
const TOP_UP_RE = /\b(top[\s-]?up|topped up|partial|half tank|half|refill(?:ed)? a bit)\b/i;
const VENDOR_HINTS = /\b(shell|total(?:energies)?|engen|rubis|vivo|oilibya|petro|hass|kenol|kobil|np\b|gapco|bp\b|caltex|chevron|sinopec|petronas|exxon|mobil|aramco|adnoc|pump|station|garage|workshop|kfc|mall|plaza|junction)\b/i;

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function toPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function contextOf(ctx = {}) {
  const countryInfo = ctx?.countryInfo || ctx?.global?.countryInfo || null;
  const countryCode = String(countryInfo?.country_code || countryInfo?.countryCode || 'GLOBAL').toUpperCase();
  const locale = countryInfo?.locale || ctx?.locale || 'en-US';
  const currency = String(countryInfo?.currency || 'USD').toUpperCase();
  const unitSystem = resolveUnitSystem(countryInfo, ctx?.profile || null);
  return { countryInfo, countryCode, locale, currency, unitSystem };
}

/**
 * Fuel/electric volume in canonical litres. Gallons are converted through the
 * user's own unit system, so "10 gallons" in Texas is 37.85 L and never 45 L.
 */
export function extractVolume(text = '', { unitSystem = 'metric', countryCode = 'GLOBAL' } = {}) {
  const source = String(text || '');
  const match = source.match(/\b(\d{1,3}(?:[.,]\d{1,3})?|\d+(?:\.\d+)?)\s*(l|lt|ltr|ltrs|litres?|liters?|gal|gals|gallons?|kwh)\b/i);
  if (!match) return { liters: null, unit: null, raw: null };
  const raw = match[0].trim();
  const value = Number(String(match[1]).replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return { liters: null, unit: null, raw };
  const unit = match[2].toLowerCase();
  if (unit === 'kwh') return { liters: null, unit: 'kWh', raw, kwh: roundTo(value, 2) };
  if (unit.startsWith('gal')) {
    const liters = userVolumeToLiters(value, unitSystem === 'metric' ? 'imperial' : unitSystem, countryCode);
    return { liters: roundTo(liters, 2), unit: 'gal', raw };
  }
  return { liters: roundTo(value, 2), unit: 'L', raw };
}

/** Odometer reading in canonical kilometres (miles are converted). */
export function extractOdometer(text = '', { unitSystem = 'metric' } = {}) {
  const source = String(text || '');
  const match = source.match(/\b(?:at|@|odo(?:meter)?|mileage|reading)?\s*(\d{1,3}(?:[,\s]\d{3})+|\d{3,7})\s*(km|kms|kilometres?|kilometers?|mi|miles?)\b/i);
  if (!match) return { km: null, unit: null, raw: null };
  const raw = match[0].trim();
  const value = Number(String(match[1]).replace(/[,\s]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return { km: null, unit: null, raw };
  const isMiles = /^mi/i.test(match[2]);
  return {
    km: roundTo(isMiles ? value * 1.609344 : value, 0),
    unit: isMiles ? 'mi' : 'km',
    raw,
    converted: isMiles && unitSystem !== 'metric'
  };
}

/** 'Full tank' vs 'Top-up' — only when the user actually said it. */
export function extractFillType(text = '') {
  const source = String(text || '');
  if (FULL_FILL_RE.test(source)) return { fillType: 'Full tank', raw: source.match(FULL_FILL_RE)[0] };
  if (TOP_UP_RE.test(source)) return { fillType: 'Top-up', raw: source.match(TOP_UP_RE)[0] };
  return { fillType: null, raw: null };
}


const PLATE_STOPWORDS = new Set(['the', 'my', 'our', 'a', 'an', 'vehicle', 'car', 'truck', 'bike', 'bus']);
const LABEL_STOPWORDS = new Set([
  'the', 'a', 'an', 'for', 'on', 'at', 'in', 'of', 'to', 'and', 'plus', 'with', 'from',
  'was', 'is', 'are', 'were', 'been', 'today', 'yesterday', 'tonight', 'morning', 'evening',
  'last', 'this', 'now', 'just', 'l', 'lt', 'ltr', 'km', 'kms', 'kes', 'ksh', 'usd', 'sh', 'shs',
  'odometer', 'odo', 'mileage', 'reading', 'litres', 'liters', 'full', 'tank', 'top', 'up', 'spent',
  'paid', 'cost', 'costs', 'bought', 'fuel', 'fueled', 'fuelled'
]);

const ORDINALS = {
  first: 0, second: 1, third: 2, fourth: 3, fifth: 4,
  '1st': 0, '2nd': 1, '3rd': 2, '4th': 3, '5th': 4
};

function plateOf(vehicle = {}) {
  return String(vehicle.plate || vehicle.plate_number || vehicle.serial_number || vehicle.number_plate || vehicle.registration_number || vehicle.registration || '').trim();
}

function labelOf(vehicle = {}) {
  const make = String(vehicle.make || vehicle.vehicle_make || vehicle.make_model || '').trim();
  const model = String(vehicle.model || vehicle.vehicle_model || '').trim();
  const nickname = String(vehicle.nickname || vehicle.nick_name || vehicle.name || '').trim();
  return [make, model, nickname].filter(Boolean).join(' ').trim();
}

/** v1.89.0 — the nickname alone (fallback aliases keep older rows working). */
function nicknameOf(vehicle = {}) {
  return String(vehicle.nickname || vehicle.nick_name || vehicle.name || '').trim();
}

function compactAlnum(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Find the vehicle the sentence is about. Explicit mention (plate, ordinal or
 * make/model) always wins; a single-vehicle account resolves automatically;
 * otherwise the account's active vehicle is ambiguous and the caller must ask which.
 */
export function matchNarrativeVehicle(text = '', vehicles = [], activeVehicle = null) {
  const list = Array.isArray(vehicles) ? vehicles.filter(Boolean) : [];
  if (list.length === 0) return { vehicle: null, reason: 'no-vehicles', defaulted: false, candidates: [] };
  if (list.length === 1) return { vehicle: list[0], reason: 'single', defaulted: false, candidates: [] };

  const source = String(text || '');
  const compact = compactAlnum(source);

  // 0) v1.89.0 (Phase 27C, D3) — an explicit NICKNAME phrase wins over every
  // other reference ("log fuel for The Workhorse"). Whole-token boundaries,
  // ≥3 chars; two ambiguous nicknames ask instead of guessing.
  if (list.some((vehicle) => nicknameOf(vehicle).length >= 3)) {
    const normalized = source.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const padded = ` ${normalized} `;
    const nicknameMatches = list.filter((vehicle) => {
      const nickname = nicknameOf(vehicle).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (nickname.length < 3) return false;
      return padded.includes(` ${nickname} `);
    });
    if (nicknameMatches.length === 1) {
      return { vehicle: nicknameMatches[0], reason: 'nickname', defaulted: false, candidates: nicknameMatches };
    }
    if (nicknameMatches.length > 1) {
      return { vehicle: null, reason: 'ambiguous-nickname', defaulted: false, candidates: nicknameMatches };
    }
  }

  // 1) Explicit plate mention (with or without spaces/dashes).
  const plateMatches = list.filter((vehicle) => {
    const plate = compactAlnum(plateOf(vehicle));
    return plate.length >= 4 && compact.includes(plate);
  });
  if (plateMatches.length === 1) return { vehicle: plateMatches[0], reason: 'plate', defaulted: false, candidates: plateMatches };

  // 2) "the second one", "vehicle 2", "car #2".
  const ordinal = source.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/i);
  const numbered = source.match(/\b(?:vehicle|car|truck|bike|bus)\s*#?\s*(\d)\b/i);
  const index = ordinal ? ORDINALS[ordinal[1].toLowerCase()] : (numbered ? Number(numbered[1]) - 1 : null);
  if (index !== null && Number.isInteger(index) && list[index]) {
    return { vehicle: list[index], reason: 'ordinal', defaulted: false, candidates: [list[index]] };
  }

  // 3) Make/model words ("the fielder", "the probox"). A token shared by every
  // vehicle ("Toyota" when both are Toyotas) can never identify one of them.
  const words = source.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  const tokenSets = list.map((vehicle) => new Set(
    labelOf(vehicle).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !PLATE_STOPWORDS.has(token))
  ));
  const sharedByAll = new Set([...tokenSets[0]].filter((token) => tokenSets.every((set) => set.has(token))));
  const scored = list
    .map((vehicle, i) => ({
      vehicle,
      score: [...tokenSets[i]].filter((token) => words.includes(token) && !sharedByAll.has(token)).length
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1) return { vehicle: scored[0].vehicle, reason: 'label', defaulted: false, candidates: [scored[0].vehicle] };
  if (scored.length > 1) {
    if (scored[0].score > scored[1].score) {
      return { vehicle: scored[0].vehicle, reason: 'label', defaulted: false, candidates: [scored[0].vehicle] };
    }
    return { vehicle: null, reason: 'ambiguous-label', defaulted: false, candidates: scored.map((entry) => entry.vehicle) };
  }

  // v1.58.3 - several vehicles and no plate/ordinal/label = ambiguous; never silently default
  return {
    vehicle: null,
    reason: 'ambiguous',
    defaulted: false,
    candidates: list
  };
}

const VENDOR_STOPWORDS = new Set([
  'on', 'in', 'at', 'for', 'with', 'and', 'to', 'of', 'the', 'a', 'an', 'my', 'our', 'from',
  'last', 'this', 'next', 'today', 'tonight', 'yesterday', 'when', 'while', 'after', 'before',
  'near', 'by', 'then', 'but', 'so', 'was', 'is', 'were', 'it', 'its'
]);

/** Cut a vendor capture at the first connector word ("Total on the fielder" → Total). */
function trimVendorCapture(value) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const kept = [];
  for (const word of words) {
    if (VENDOR_STOPWORDS.has(word.toLowerCase()) && kept.length > 0) break;
    if (VENDOR_STOPWORDS.has(word.toLowerCase()) && kept.length === 0) continue;
    kept.push(word);
  }
  return kept.join(' ').trim();
}

/**
 * Conservative vendor/place picker: only returns a value supported by a vendor
 * hint (Shell, Total, garage …) or a capitalised proper noun right after
 * at/from. Everything else stays null so Saka asks instead of inventing.
 */
export function extractVendor(text = '') {
  const source = String(text || '');
  const pattern = /\b(?:at|from)\s+([A-Za-z][A-Za-z'&.-]*(?:\s+[A-Za-z][A-Za-z'&.-]*){0,2})/g;
  for (const match of source.matchAll(pattern)) {
    const captured = String(match[1] || '').trim().replace(/[.,;:!?]+$/, '');
    const raw = trimVendorCapture(captured);
    if (!raw) continue;
    const first = raw.split(/\s+/)[0].toLowerCase();
    if (LABEL_STOPWORDS.has(first) || PLATE_STOPWORDS.has(first)) continue;
    if (/^\d/.test(raw) || first.length < 3) continue;
    if (VENDOR_HINTS.test(raw)) return { value: raw, confidence: 'high', raw: match[0].trim() };
    const capturedOriginal = source.substr(match.index + match[0].indexOf(match[1]), captured.length);
    if (/^[A-Z]/.test(capturedOriginal)) return { value: raw, confidence: 'medium', raw: match[0].trim() };
  }
  return { value: null, confidence: null, raw: null };
}


function emptyDraft(reason, extras = {}) {
  return {
    ok: false,
    version: NARRATIVE_DRAFT_VERSION,
    reason,
    kind: null,
    text: '',
    fields: {},
    money: { amount: null, currency: null, ambiguous: false, lineItems: [], unitPrice: null, derivedTotal: false },
    volume: { liters: null, unit: null, raw: null },
    odometer: { km: null, unit: null, raw: null },
    fillType: null,
    vehicle: null,
    vehicleMatch: { vehicle: null, reason: 'none', defaulted: false, candidates: [] },
    vendor: null,
    occurredAt: null,
    occurredAtLabel: null,
    notes: null,
    moneyWords: null,
    missing: [],
    warnings: [],
    confidence: 0,
    ...extras
  };
}

/** Which of the three record shapes the sentence describes. */
export function detectNarrativeKind(text = '', { expenseType = null, hasAmount = false } = {}) {
  const source = String(text || '');
  const explicitType = expenseType || hasExpenseTypeMarker(source);
  if (MILEAGE_RE.test(source) && !explicitType && !hasAmount) return 'mileage';
  if (EARNING_RE.test(source) && !explicitType) return 'earning';
  return 'expense';
}

function buildNotes({ vendor, volume, unitPrice, fillType }) {
  const parts = [];
  if (vendor) parts.push(vendor);
  if (unitPrice) parts.push(`@${unitPrice}/L`);
  if (volume?.liters) parts.push(`${volume.liters} L`);
  else if (volume?.raw) parts.push(volume.raw);
  if (fillType === 'Top-up') parts.push('partial fill');
  const note = parts.join(' · ').trim();
  return note ? note.slice(0, 200) : null;
}

function formatOccurredAtLabel(dateResult, locale = 'en-US') {
  if (!dateResult?.ok || !dateResult.iso) return null;
  try {
    const formatted = formatDate(dateResult.iso, locale, { day: '2-digit', month: 'short', year: 'numeric' });
    return dateResult.phrase && String(dateResult.phrase).toLowerCase() !== formatted.toLowerCase()
      ? `${formatted} (${dateResult.phrase})`
      : formatted;
  } catch {
    return dateResult.localDate || null;
  }
}


/**
 * Blank a mentioned plate out of the sentence so "KCB 456B" never reads as a
 * money amount, a volume or a date fragment.
 */
function maskPlate(text, vehicle) {
  if (!vehicle) return String(text || '');
  const plate = compactAlnum(plateOf(vehicle));
  if (plate.length < 4) return String(text || '');
  const body = plate
    .split('')
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s-]*');
  try {
    return String(text || '').replace(new RegExp(body, 'gi'), ' ');
  } catch {
    return String(text || '');
  }
}

/** Every distinct Nairobi calendar day mentioned in the sentence. */
const DATE_TOKEN_RE = /\b(?:yesterday|today|tonight|last\s+night|last\s+evening|day\s+before\s+yesterday|\d{1,3}\s+(?:days?|weeks?)\s+ago|last\s+(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?)\b/gi;

function distinctNarrativeDays(text, { countryCode, locale, now }) {
  const days = new Set();
  for (const match of String(text || '').matchAll(DATE_TOKEN_RE)) {
    const resolved = extractPastDatePhrase(match[0], { countryCode, locale, now });
    if (resolved.ok) days.add(resolved.localDate);
  }
  return days;
}


/**
 * Build the deterministic narrative draft for one free-text message.
 * Never throws; every value is either extracted with evidence or null.
 */
export function buildNarrativeDraft({ text = '', ctx = {}, vehicles = [], activeVehicle = null, now = new Date() } = {}) {
  try {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return emptyDraft('empty');

    const env = contextOf(ctx);
    const vehicleMatch = matchNarrativeVehicle(clean, vehicles, activeVehicle);
    const vehicle = vehicleMatch.vehicle || null;
    const scanned = maskPlate(clean, vehicle);

    const money = parseMoneyStory(scanned, { currency: env.currency });
    const volume = extractVolume(scanned, { unitSystem: env.unitSystem, countryCode: env.countryCode });
    const odometer = extractOdometer(scanned, { unitSystem: env.unitSystem });
    const fill = extractFillType(scanned);
    const vendor = extractVendor(scanned);
    // v1.59.0 — "label: karen run" / "#karen" rides the draft deterministically.
    const label = extractEntryLabel(clean);
    const dateResult = extractPastDatePhrase(scanned, { countryCode: env.countryCode, locale: env.locale, now });
    const mentionedDays = distinctNarrativeDays(scanned, { countryCode: env.countryCode, locale: env.locale, now });
    // Two different days in one sentence = two records; never pick one silently.
    const multiDate = mentionedDays.size > 1;

    const catalogType = resolveExpenseType(scanned);
    const kind = detectNarrativeKind(scanned, { expenseType: catalogType, hasAmount: money.amount != null });

    const expenseType = kind === 'expense' ? (catalogType || (volume.liters ? 'Fuel' : null)) : null;
    const fillType = expenseType === 'Fuel' ? fill.fillType : null;

    const fields = {};
    if (vehicle?.id) fields.vehicle_id = vehicle.id;
    if (expenseType) fields.expense_type = expenseType;
    if (money.amount != null) fields.amount = money.amount;
    if (volume.liters && expenseType === 'Fuel') fields.fuel_liters = volume.liters;
    if (fillType) fields.fill_type = fillType;
    if (odometer.km) fields.odometer_reading = odometer.km;
    if (label) fields.label = label;

    const warnings = [];
    if (money.ambiguous) warnings.push('ambiguous-amount');
    if (dateResult.future) warnings.push('future-date');
    if (multiDate) warnings.push('multi-date');
    if (vehicleMatch.defaulted) warnings.push('vehicle-defaulted');
    if (money.lineItems.length > 1) warnings.push('multi-line');

    const missing = [];
    if (kind === 'expense') {
      if (!expenseType) missing.push('expense_type');
      if (money.amount == null) missing.push('amount');
      if (expenseType === 'Fuel' && !volume.liters) missing.push('fuel_liters');
      if (expenseType === 'Fuel' && !fillType) missing.push('fill_type');
    } else if (kind === 'earning') {
      if (money.amount == null) missing.push('amount');
    } else if (kind === 'mileage') {
      if (!odometer.km) missing.push('odometer_reading');
    }

    let confidence = 0;
    if (money.amount != null && !money.ambiguous) confidence += 0.3;
    if (expenseType) confidence += 0.2;
    if (volume.liters || odometer.km) confidence += 0.15;
    if (dateResult.ok) confidence += 0.15;
    if (vehicle && !vehicleMatch.defaulted) confidence += 0.1;
    if (vendor.confidence === 'high') confidence += 0.1;

    const occurredAt = dateResult.ok && !multiDate
      ? {
          localDate: dateResult.localDate,
          iso: dateResult.iso,
          timeZone: dateResult.timeZone || SYSTEM_TIMEZONE,
          phrase: dateResult.phrase || null,
          daysAgo: dateResult.daysAgo ?? 0,
          source: dateResult.source || null,
          confidence: dateResult.confidence || null
        }
      : null;

    return {
      ok: true,
      version: NARRATIVE_DRAFT_VERSION,
      reason: null,
      kind,
      text: clean,
      fields,
      money: {
        amount: money.amount,
        currency: money.currency || env.currency,
        ambiguous: money.ambiguous,
        lineItems: money.lineItems,
        unitPrice: money.unitPrice,
        derivedTotal: money.derivedTotal
      },
      volume,
      odometer,
      fillType,
      label,
      vehicle,
      vehicleMatch,
      vendor: vendor.value ? { value: vendor.value, confidence: vendor.confidence } : null,
      occurredAt,
      occurredAtLabel: multiDate ? null : formatOccurredAtLabel(dateResult, env.locale),
      notes: buildNotes({ vendor: vendor.value, volume, unitPrice: money.unitPrice, fillType }),
      moneyWords: money.moneyWords || null,
      missing,
      warnings,
      confidence: Math.min(1, Math.round(confidence * 100) / 100),
      locale: env.locale,
      currency: env.currency
    };
  } catch {
    return emptyDraft('error');
  }
}


/**
 * Fields the quiz engine may pre-fill. AI output must NEVER overwrite these
 * values — this is the deterministic authority for a narrative turn.
 */
export function narrativeDraftFields(draft) {
  if (!draft?.fields) return {};
  return Object.fromEntries(
    Object.entries(draft.fields).filter(([, value]) => value !== null && value !== undefined && value !== '')
  );
}

/** Extra write-time values that are not quiz fields (retro date, vendor, notes). */
export function narrativeDraftExtras(draft) {
  if (!draft) return {};
  const extras = {};
  if (draft.occurredAt?.localDate) extras.occurred_at = draft.occurredAt.localDate;
  if (draft.occurredAt?.iso) extras.occurred_at_iso = draft.occurredAt.iso;
  if (draft.kind) extras.kind = draft.kind;
  if (draft.notes) extras.notes = draft.notes;
  if (draft.money?.unitPrice) extras.unit_price = draft.money.unitPrice;
  if (draft.vendor?.value) extras.vendor = draft.vendor.value;
  // v1.59.0 — the optional label is written with the row, never invented later.
  if (draft.label) extras.label = draft.label;
  return extras;
}

/** Is this draft strong enough to pre-fill instead of asking from scratch? */
export function shouldPrefillNarrativeDraft(draft) {
  if (!draft?.ok) return false;
  if (draft.money?.ambiguous) return false;
  if ((draft.warnings || []).includes('multi-date')) return false;
  if (draft.kind === 'expense') return draft.money?.amount != null || Boolean(draft.fields?.expense_type);
  if (draft.kind === 'earning') return draft.money?.amount != null;
  if (draft.kind === 'mileage') return Boolean(draft.odometer?.km);
  return false;
}

/**
 * v1.38.0 (D4) — split one paragraph into several single-record drafts.
 * Sentence breaks and additive conjunctions between two complete record
 * shapes ("yesterday I filled 40L for 5500 at Shell and paid 300 for
 * parking") each become their own draft, reusing the exact single-draft
 * machinery (money lexicon, plate masking, per-chunk past dates). Chunks that
 * are not prefillable are flagged rather than guessed.
 */
export function buildNarrativeParagraphDrafts({ text = '', ctx = {}, vehicles = [], activeVehicle = null, now = new Date() } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, reason: 'empty', drafts: [], rejected: [] };

  // Sentence breaks split first; an "and" between two amount-bearing parts
  // splits only when each side carries its own money figure.
  const parts = [];
  const sentenceParts = clean.split(/(?<=[.!?;])\s+/);
  for (const part of sentenceParts) {
    const sub = part.split(/\band\b|,?\s+then\s+/i)
      .map((piece) => piece.trim())
      .filter(Boolean)
      .filter((piece) => /.*/.test(piece));
    if (sub.length > 1 && sub.every((piece) => /\d/.test(piece))) parts.push(...sub);
    else parts.push(part.trim());
  }

  const drafts = [];
  const rejected = [];
  for (const part of parts.filter(Boolean)) {
    const draft = buildNarrativeDraft({ text: part, ctx, vehicles, activeVehicle, now });
    if (!draft.ok) { rejected.push({ text: part, reason: draft.reason }); continue; }
    if (shouldPrefillNarrativeDraft(draft)) drafts.push(draft);
    else rejected.push({ text: part, reason: draft.warnings.join(',') || 'not-prefillable' });
  }

  if (drafts.length === 0) return { ok: false, reason: 'no_prefillable_drafts', drafts, rejected };
  return { ok: true, drafts, rejected };
}

/** Numbered plan card for a multi-record paragraph (deterministic). */
export function renderNarrativeBatchCard(drafts, { locale = 'en-US', currency = 'USD' } = {}) {
  const lines = ['📋 *I found these records in your message*', ''];
  drafts.forEach((draft, index) => {
    const summary = describeNarrativeDraft(draft, { locale, currency }) || 'a record';
    lines.push(`${index + 1}. ${summary}`);
  });
  const skipped = drafts.some((draft) => draft.warnings?.length);
  lines.push('');
  lines.push('1 ✅ Save all');
  lines.push(`2 ✏️ Edit one (reply the number, e.g. *edit 1*)`);
  lines.push('3 ❌ Cancel');
  if (skipped) lines.push('', '⚠️ Anything I could not read safely was left out — edit the row to add it.');
  return lines.join('\n');
}

/** Resolve the next turn while a multi-record batch is pending. */
export function resolveNarrativeBatchTurn({ batch = null, text = '', now = Date.now() } = {}) {
  const BATCH_TTL_MINUTES = 15;
  const clean = String(text || '').trim();
  if (!batch || !Array.isArray(batch.drafts) || batch.drafts.length === 0) {
    return { type: 'none' };
  }
  const expired = batch.at && (Number(now) - Number(new Date(batch.at).getTime())) > BATCH_TTL_MINUTES * 60 * 1000;
  if (expired) return { type: 'none', dropBatch: true };

  if (/^(1|1️⃣|save all|save them all|yes|confirm all)$/i.test(clean)) return { type: 'save-all' };
  if (/^(3|3️⃣|cancel|no|stop)$/i.test(clean)) return { type: 'cancel', dropBatch: true };
  const editMatch = clean.match(/^(?:2|2️⃣|edit|change)\s+(\d{1,2})$/i) || clean.match(/^(\d{1,2})\s*(?:✏️)?$/i);
  if (editMatch) {
    const index = Number(editMatch[1]) - 1;
    if (index >= 0 && index < batch.drafts.length) return { type: 'edit', index, dropBatch: true };
    return { type: 'invalid-edit' };
  }
  return { type: 'none' };
}

/** One-line summary for the confirmation card / acknowledgement. */
export function describeNarrativeDraft(draft, { locale = 'en-US', currency = 'USD' } = {}) {
  if (!draft?.ok) return null;
  const chips = [];
  if (draft.kind === 'earning') chips.push('Earning');
  else if (draft.kind === 'mileage') chips.push('Mileage');
  if (draft.fields?.expense_type) chips.push(draft.fields.expense_type);
  if (draft.money?.amount != null) chips.push(formatMoney(draft.money.amount, draft.money.currency || currency, locale));
  if (draft.volume?.liters && draft.fields?.expense_type === 'Fuel') chips.push(`${draft.volume.liters} L`);
  if (draft.odometer?.km) chips.push(`${draft.odometer.km.toLocaleString('en-US')} km`);
  if (draft.fillType) chips.push(draft.fillType);
  if (draft.occurredAtLabel) chips.push(draft.occurredAtLabel);
  if (draft.vehicle && !draft.vehicleMatch?.defaulted) {
    const plate = plateOf(draft.vehicle) || labelOf(draft.vehicle);
    if (plate) chips.push(plate);
  }
  return chips.length > 0 ? chips.join(' · ') : null;
}

export default {
  NARRATIVE_DRAFT_VERSION,
  isNarrativeIntakeEnabled,
  extractVolume,
  extractOdometer,
  extractFillType,
  extractVendor,
  matchNarrativeVehicle,
  detectNarrativeKind,
  buildNarrativeDraft,
  narrativeDraftFields,
  narrativeDraftExtras,
  shouldPrefillNarrativeDraft,
  describeNarrativeDraft,
  buildNarrativeParagraphDrafts,
  renderNarrativeBatchCard,
  resolveNarrativeBatchTurn
};
