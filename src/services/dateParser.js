/**
 * Saka Fleet — Global Date Parser (permanent global-audience rule)
 * -----------------------------------------------------------------
 * Deciphers ISO dates, country-specific DD/MM vs MM/DD, ordinals,
 * month names, relative dates ("tomorrow", "in 2 weeks") and weekdays
 * ("next Monday"). Everything is normalized to Africa/Nairobi before it is
 * written to the database.
 *
 * Never throws: returns { ok, ... } so callers can re-ask conversationally.
 */

export const SYSTEM_TIMEZONE = 'Africa/Nairobi';
const NAIROBI_OFFSET = '+03:00';

const MONTHS = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12
};

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
};

// Countries that conventionally write MM/DD/YYYY.
const MONTH_FIRST_COUNTRIES = new Set(['US', 'PH', 'FM', 'MH', 'PW']);

/** Y-M-D parts of a Date as seen in Africa/Nairobi. */
export function getNairobiParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYSTEM_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const [year, month, day] = formatter.format(date).split('-').map(Number);
  return { year, month, day };
}

/** Canonical YYYY-MM-DD in Africa/Nairobi. */
export function formatNairobiDate(date = new Date()) {
  const { year, month, day } = getNairobiParts(date);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildResult(localDate, source, confidence, extra = {}) {
  const [year, month, day] = localDate.split('-').map(Number);
  return {
    ok: true,
    localDate,
    iso: `${localDate}T12:00:00${NAIROBI_OFFSET}`,
    timeZone: SYSTEM_TIMEZONE,
    year, month, day,
    source,
    confidence,
    error: null,
    ...extra
  };
}

function fail(error) {
  return { ok: false, localDate: null, iso: null, timeZone: SYSTEM_TIMEZONE, source: null, confidence: null, error };
}

function fromParts(year, month, day, source, confidence) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (year < 1900 || year > 2200) return null;
  return buildResult(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    source,
    confidence
  );
}

function addDaysToParts(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function normalizeYear(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  if (num >= 100) return num;
  if (num >= 0 && num <= 69) return 2000 + num;
  if (num >= 70 && num <= 99) return 1900 + num;
  return null;
}

function addMonthsToParts(parts, months) {
  let month = parts.month - 1 + months;
  let year = parts.year + Math.floor(month / 12);
  month = ((month % 12) + 12) % 12;
  const day = Math.min(parts.day, daysInMonth(year, month + 1));
  return { year, month: month + 1, day };
}

/**
 * Parse a human date into a Nairobi-normalized canonical date.
 * @param {string} input
 * @param {{ countryCode?: string, locale?: string, now?: Date }} options
 * @returns {{ ok: boolean, localDate: string|null, iso: string|null, timeZone: string, source: string|null, confidence: string|null, error: string|null }}
 */
export function parseFlexibleDate(input, { countryCode = 'GLOBAL', locale = 'en-US', now = new Date() } = {}) {
  const raw = String(input || '').trim();
  if (!raw) return fail('Empty date');

  const text = raw.toLowerCase();
  const todayParts = getNairobiParts(now);
  const monthFirst = MONTH_FIRST_COUNTRIES.has(String(countryCode || '').toUpperCase());
  const ordinalStripped = text.replace(/(\d+)(st|nd|rd|th)\b/g, '$1').replace(/\s+/g, ' ').trim();

  // 1) ISO: YYYY-MM-DD (optionally with time)
  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[t\s].*)?$/);
  if (m) {
    return fromParts(Number(m[1]), Number(m[2]), Number(m[3]), 'iso', 'high') || fail('Invalid ISO date');
  }

  // 2) "15 October 2026" / "15 Oct" / "October 15, 2026" / "Oct 15"
  m = ordinalStripped.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);
  if (m && MONTHS[m[2]]) {
    const year = m[3] ? Number(m[3]) : todayParts.year;
    const result = fromParts(year, MONTHS[m[2]], Number(m[1]), 'named', 'high');
    if (result) return result;
  }

  m = ordinalStripped.match(/^([a-z]+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?$/);
  if (m && MONTHS[m[1]]) {
    const year = m[3] ? Number(m[3]) : todayParts.year;
    const result = fromParts(year, MONTHS[m[1]], Number(m[2]), 'named', 'high');
    if (result) return result;
  }

  // 3) Numeric d/m/y — ambiguity resolved by country convention.
  m = ordinalStripped.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/);
  if (m) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    let day;
    let month;
    let confidence = 'medium';

    if (first > 12 && second <= 12) {
      day = first; month = second; confidence = 'high';
    } else if (second > 12 && first <= 12) {
      month = first; day = second; confidence = 'high';
    } else if (monthFirst) {
      month = first; day = second;
    } else {
      day = first; month = second;
    }

    const year = m[3] ? normalizeYear(m[3]) : todayParts.year;
    const result = fromParts(year, month, day, 'numeric', confidence);
    if (result) return result;
    return fail('Invalid calendar date');
  }

  // 4) Relative words
  if (/^(today|now)$/.test(text)) {
    return fromParts(todayParts.year, todayParts.month, todayParts.day, 'relative', 'high');
  }
  if (/^tomorrow$/.test(text)) {
    const p = addDaysToParts(todayParts, 1);
    return fromParts(p.year, p.month, p.day, 'relative', 'high');
  }
  if (/^yesterday$/.test(text)) {
    const p = addDaysToParts(todayParts, -1);
    return fromParts(p.year, p.month, p.day, 'relative', 'high');
  }
  if (/^next week$/.test(text)) {
    const p = addDaysToParts(todayParts, 7);
    return fromParts(p.year, p.month, p.day, 'relative', 'high');
  }
  if (/^next month$/.test(text)) {
    const p = addMonthsToParts(todayParts, 1);
    return fromParts(p.year, p.month, p.day, 'relative', 'high');
  }

  m = text.match(/^in\s+(\d{1,3})\s+(days?|weeks?|months?)$/);
  if (m) {
    const amount = Number(m[1]);
    const unit = m[2];
    let p;
    if (unit.startsWith('month')) p = addMonthsToParts(todayParts, amount);
    else if (unit.startsWith('week')) p = addDaysToParts(todayParts, amount * 7);
    else p = addDaysToParts(todayParts, amount);
    return fromParts(p.year, p.month, p.day, 'relative', 'high');
  }

  m = text.match(/^(\d{1,3})\s+(days?|weeks?)\s+from\s+now$/);
  if (m) {
    const amount = Number(m[1]);
    const p = addDaysToParts(todayParts, m[2].startsWith('week') ? amount * 7 : amount);
    return fromParts(p.year, p.month, p.day, 'relative', 'high');
  }

  // 5) Weekdays: "next Monday", "this Friday", "coming Sunday"
  m = text.match(/^(next|this|coming)\s+([a-z]+)$/);
  if (m && WEEKDAYS[m[2]] !== undefined) {
    const todayUtc = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day));
    const currentWeekday = todayUtc.getUTCDay();
    let delta = (WEEKDAYS[m[2]] - currentWeekday + 7) % 7;
    if (m[1] === 'next' && delta === 0) delta = 7;
    const p = addDaysToParts(todayParts, delta);
    return fromParts(p.year, p.month, p.day, 'relative', 'high');
  }

  return fail('Unrecognised date format — try YYYY-MM-DD, DD/MM/YYYY or a phrase like "next Monday"');
}

export default {
  SYSTEM_TIMEZONE,
  parseFlexibleDate,
  getNairobiParts,
  formatNairobiDate
};
