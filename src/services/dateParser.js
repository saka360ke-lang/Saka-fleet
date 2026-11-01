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

/**
 * UTC offset (in milliseconds) of an IANA timezone at a given instant.
 * Uses Intl so it stays correct across DST transitions without dependencies.
 */
export function getTimeZoneOffsetMs(date, timeZone = SYSTEM_TIMEZONE) {
  const target = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(target.getTime())) return 0;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(target).reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
    const wallClockUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
    const flooredMs = Math.floor(target.getTime() / 1000) * 1000;
    return wallClockUtc - flooredMs;
  } catch {
    return 0;
  }
}

/**
 * Convert a calendar day (YYYY-MM-DD) in a user's timezone into a canonical
 * UTC ISO timestamp (default 12:00 local time — safely inside the same day for
 * every IANA zone). Falls back to the Nairobi noon convention.
 */
export function zonedDateTimeToUtcIso(localDate, timeZone = SYSTEM_TIMEZONE, hour = 12) {
  const match = String(localDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const wallClockUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, 0, 0);
  // Two passes: the first resolves the offset at the guessed instant, the
  // second corrects zones where that guess crossed a DST boundary.
  let utcMs = wallClockUtc - getTimeZoneOffsetMs(new Date(wallClockUtc), timeZone);
  utcMs = wallClockUtc - getTimeZoneOffsetMs(new Date(utcMs), timeZone);
  return new Date(utcMs).toISOString();
}

function dayNumberFromParts(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
}

/** Calendar-day difference (to - from) as seen in Africa/Nairobi. */
export function diffCalendarDays(fromDateLike, toDateLike) {
  const toParts = toDateLike instanceof Date ? getNairobiParts(toDateLike) : parseDateParts(toDateLike);
  const fromParts = fromDateLike instanceof Date ? getNairobiParts(fromDateLike) : parseDateParts(fromDateLike);
  if (!toParts || !fromParts) return null;
  return dayNumberFromParts(toParts) - dayNumberFromParts(fromParts);
}

function parseDateParts(dateLike) {
  if (dateLike === null || dateLike === undefined || dateLike === '') return null;
  const text = String(dateLike).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return getNairobiParts(parsed);
}

const MONTH_WORD = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_ORDINAL = '(?:\\d{1,2}(?:st|nd|rd|th)?)';
const WEEKDAY_WORD = '(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)';

/**
 * Pull date phrases out of a full sentence ("Insurance expires on 15th Dec
 * 2026", "Inspection due next month", "License renewal in 14 days") and
 * resolve them through parseFlexibleDate. Never throws.
 */
export function extractDatePhrase(input, { countryCode = 'GLOBAL', locale = 'en-US', now = new Date() } = {}) {
  const text = String(input || '').trim();
  if (!text) return fail('Empty date');
  const candidates = [];

  const patterns = [
    /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
    new RegExp(`\\b${DAY_ORDINAL}\\s+(?:of\\s+)?${MONTH_WORD}(?:\\s*,?\\s*\\d{4})?\\b`, 'gi'),
    new RegExp(`\\b${MONTH_WORD}\\s+${DAY_ORDINAL}(?:\\s*,?\\s*\\d{4})?\\b`, 'gi'),
    /\b\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?\b/g,
    /\b(?:today|tomorrow|next\s+week|next\s+month)\b/gi,
    /\bin\s+\d{1,3}\s+(?:days?|weeks?|months?)\b/gi,
    /\b\d{1,3}\s+(?:days?|weeks?)\s+from\s+now\b/gi,
    new RegExp(`\\b(?:next|this|coming)\\s+${WEEKDAY_WORD}\\b`, 'gi')
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const phrase = String(match[0]).replace(/^[,\s]+|[,\s.]+$/g, '').trim();
      if (!phrase) continue;
      if (candidates.some((c) => c.phrase.toLowerCase() === phrase.toLowerCase())) continue;
      const parsed = parseFlexibleDate(phrase, { countryCode, locale, now });
      if (parsed.ok) candidates.push({ ...parsed, phrase });
    }
  }

  if (candidates.length === 0) {
    return fail('No date phrase found in the message');
  }

  const confidenceRank = { high: 3, medium: 2, low: 1 };
  candidates.sort((a, b) => (confidenceRank[b.confidence] || 0) - (confidenceRank[a.confidence] || 0));
  const best = candidates[0];
  return { ...best, phrase: best.phrase, candidates: candidates.map((c) => ({ phrase: c.phrase, localDate: c.localDate, confidence: c.confidence })) };
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

function pastFail(error, phrase = null, extra = {}) {
  return {
    ...fail(error),
    phrase,
    daysAgo: null,
    future: false,
    futureDays: null,
    ...extra
  };
}

function pastResult(parsed, phrase, daysAgo) {
  if (!parsed || !parsed.ok) return pastFail(parsed?.error || 'Unrecognised date format', phrase);
  return { ...parsed, phrase, daysAgo, future: false, futureDays: 0 };
}

/**
 * Resolve a date phrase pinned to the PRESENT or the PAST — exactly what a
 * retro-logged fleet record needs ("yesterday", "last Friday", "3 days ago",
 * "on 28/10"). Future phrases are rejected (`future: true`) so Saka can ask
 * again instead of writing a record into next month.
 *
 * Never throws.
 */
export function extractPastDatePhrase(input, { countryCode = 'GLOBAL', locale = 'en-US', now = new Date() } = {}) {
  try {
    const text = String(input || '').trim();
    if (!text) return pastFail('Empty date');

    const todayParts = getNairobiParts(now);
    const todayIso = formatNairobiDate(now);

    const relative = [
      { re: /\b(?:the\s+)?day\s+before\s+yesterday\b/i, days: -2 },
      { re: /\b(?:last\s+night|last\s+evening|yesternight)\b/i, days: -1 },
      { re: /\byesterday\b/i, days: -1 },
      { re: /\b(?:this\s+morning|today\s+morning|earlier\s+today|today|tonight|just\s+now)\b/i, days: 0 },
      { re: /\blast\s+week\b/i, days: -7 }
    ];
    for (const entry of relative) {
      const match = text.match(entry.re);
      if (!match) continue;
      const parts = addDaysToParts(todayParts, entry.days);
      const parsed = fromParts(parts.year, parts.month, parts.day, 'relative-past', 'high');
      return pastResult(parsed, match[0], Math.abs(entry.days));
    }

    const agoMatch = text.match(/\b(\d{1,3})\s+(days?|weeks?)\s+ago\b/i);
    if (agoMatch) {
      const count = Number(agoMatch[1]);
      if (!Number.isFinite(count) || count < 0 || count > 730) return pastFail('Relative date out of range', agoMatch[0]);
      const days = agoMatch[2].toLowerCase().startsWith('week') ? count * 7 : count;
      const parts = addDaysToParts(todayParts, -days);
      const parsed = fromParts(parts.year, parts.month, parts.day, 'relative-past', 'high');
      return pastResult(parsed, agoMatch[0], days);
    }

    // "next Monday" is a future plan, never a record date.
    const futureWeekday = text.match(new RegExp(`\\bnext\\s+${WEEKDAY_WORD}\\b`, 'i'));
    if (futureWeekday) return pastFail('Date is in the future', futureWeekday[0], { future: true });

    // "last Friday" / a bare weekday → the most recent past occurrence.
    const weekdayMatch = text.match(new RegExp(`\\b(?:(last|this|on)\\s+)?(${WEEKDAY_WORD})\\b`, 'i'));
    if (weekdayMatch) {
      const word = (weekdayMatch[2] || '').toLowerCase();
      const target = WEEKDAYS[word];
      if (target !== undefined) {
        const todayUtc = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day));
        const delta = (todayUtc.getUTCDay() - target + 7) % 7;
        const daysAgo = delta === 0 && (weekdayMatch[1] || '').toLowerCase() === 'last' ? 7 : delta;
        const parts = addDaysToParts(todayParts, -daysAgo);
        const parsed = fromParts(parts.year, parts.month, parts.day, 'weekday-past', 'medium');
        return pastResult(parsed, weekdayMatch[0].trim(), daysAgo);
      }
    }

    const explicit = extractDatePhrase(text, { countryCode, locale, now });
    if (explicit.ok) {
      const futureDays = diffCalendarDays(todayIso, explicit.localDate);
      if (futureDays > 0) {
        return pastFail('Date is in the future', explicit.phrase, { future: true, futureDays });
      }
      return pastResult(explicit, explicit.phrase, Math.abs(futureDays));
    }

    return pastFail(explicit.error || 'No date phrase found in the message');
  } catch {
    return pastFail('Date parsing failed');
  }
}

const RANGE_MAX_DAYS = 730;

function isoDateFromParts(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function partsFromIso(localDate) {
  const m = String(localDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

/**
 * Resolve a DATE RANGE phrase for ledger queries ("last week", "this month",
 * "in October", "last 3 months", "from 1 Oct to 15 Oct", single days like
 * "yesterday"). Both ends are Nairobi calendar days, `to` is clamped to today
 * (a future end never queries future data), and the width is capped at
 * RANGE_MAX_DAYS. Never throws.
 */
export function resolveDateRange(input, { countryCode = 'GLOBAL', locale = 'en-US', now = new Date() } = {}) {
  try {
    const text = String(input || '').trim().toLowerCase();
    if (!text) return fail('Empty range');
    const todayParts = getNairobiParts(now);
    const todayKey = isoDateFromParts(todayParts);
    const dayKeyOf = (parts) => isoDateFromParts(parts);
    const withinCap = (fromParts, toParts) => {
      const fromMs = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);
      const toMs = Date.UTC(toParts.year, toParts.month - 1, toParts.day);
      return (toMs - fromMs) / 86400000 <= RANGE_MAX_DAYS;
    };
    const finish = (fromParts, toParts, source, label) => {
      const clampedTo = dayKeyOf(toParts) > todayKey ? todayParts : toParts;
      if (!withinCap(fromParts, clampedTo)) return fail('Range wider than two years');
      return { ok: true, from: dayKeyOf(fromParts), to: dayKeyOf(clampedTo), source, label, error: null };
    };
    const sameDay = (parts, source) => finish(parts, parts, source, 'single-day');

    // 1) Explicit endpoints: "from 1 Oct to 15 Oct", "28/10 to 31/10".
    const endpointMatch = text.match(/\b(?:from\s+)?(\d{1,2}(?:st|nd|rd|th)?[\s/-]+[a-z]{3,}(?:[\s,/]*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})\s+(?:to|till|until|through|-)\s+(\d{1,2}(?:st|nd|rd|th)?[\s/-]+[a-z]{3,}(?:[\s,/]*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})\b/i);
    if (endpointMatch) {
      const fromParsed = parseFlexibleDate(endpointMatch[1], { countryCode, locale, now });
      const toParsed = parseFlexibleDate(endpointMatch[2], { countryCode, locale, now });
      if (fromParsed.ok && toParsed.ok) {
        const fromParts = partsFromIso(fromParsed.localDate);
        const toParts = partsFromIso(toParsed.localDate);
        if (fromParts && toParts) {
          if (dayKeyOf(fromParts) > dayKeyOf(toParts)) return fail('Start date is after the end date');
          return finish(fromParts, toParts, 'explicit-endpoints', `from ${fromParsed.localDate} to ${toParsed.localDate}`);
        }
      }
    }

    // 2) Named month (with optional year): "in October", "october 2025".
    // The month word must be introduced by a preposition or carry a year —
    // a bare "may" in "how much may I have spent" is never a month.
    const monthWord = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    const monthMatch = text.match(new RegExp(`\\b(?:in|for|during|on)\\s+${monthWord}\\b(?:[\\s,]*(\\d{4}))?`, 'i'))
      || text.match(new RegExp(`\\b${monthWord}\\s+(\\d{4})\\b`, 'i'));
    if (monthMatch) {
      const month = MONTHS[monthMatch[1]];
      let year = monthMatch[2] ? normalizeYear(monthMatch[2]) : todayParts.year;
      if (!year) year = todayParts.year;
      if (month > todayParts.month && year === todayParts.year) year -= 1;
      const lastDay = daysInMonth(year, month);
      return finish(
        { year, month, day: 1 },
        { year, month, day: lastDay },
        'named-month',
        `${monthMatch[1]} ${year}`
      );
    }

    // 3) Trailing windows: "last N days/weeks/months".
    const trailing = text.match(/\b(?:last|past)\s+(\d{1,3})\s+(days?|weeks?|months?)\b/i);
    if (trailing) {
      const count = Math.min(Number(trailing[1]), 60);
      const unit = trailing[2];
      let fromParts;
      if (unit.startsWith('month')) {
        fromParts = addMonthsToParts(todayParts, -(count - 1));
        fromParts = { ...fromParts, day: 1 };
      } else if (unit.startsWith('week')) {
        fromParts = addDaysToParts(todayParts, -(count * 7 - 1));
      } else {
        fromParts = addDaysToParts(todayParts, -(count - 1));
      }
      return finish(fromParts, todayParts, 'trailing-window', `last ${count} ${unit}`);
    }

    // 4) Calendar windows: last week / this week / last month / this month / this year.
    if (/\b(?:last|this|past)\s+week\b/.test(text)) {
      return finish(addDaysToParts(todayParts, -6), todayParts, 'trailing-window', 'the last 7 days');
    }
    if (/\bthis\s+month\b/.test(text)) {
      return finish({ year: todayParts.year, month: todayParts.month, day: 1 }, todayParts, 'calendar-window', 'this month');
    }
    if (/\blast\s+month\b/.test(text)) {
      const prev = addMonthsToParts(todayParts, -1);
      return finish(
        { year: prev.year, month: prev.month, day: 1 },
        { year: prev.year, month: prev.month, day: daysInMonth(prev.year, prev.month) },
        'calendar-window',
        'last month'
      );
    }
    if (/\b(?:this|current)\s+year\b/.test(text)) {
      return finish({ year: todayParts.year, month: 1, day: 1 }, todayParts, 'calendar-window', 'this year');
    }

    // 5) Single days: yesterday, last Friday, "3 days ago", a plain date.
    const single = extractPastDatePhrase(input, { countryCode, locale, now });
    if (single.ok && !/\b(week|month|year)s?\b/i.test(text)) {
      const parts = partsFromIso(single.localDate);
      if (parts) return sameDay(parts, single.phrase);
    }

    return fail('No date range found in the message');
  } catch {
    return fail('Date range parsing failed');
  }
}

export default {
  SYSTEM_TIMEZONE,
  parseFlexibleDate,
  getNairobiParts,
  formatNairobiDate,
  getTimeZoneOffsetMs,
  zonedDateTimeToUtcIso,
  diffCalendarDays,
  extractDatePhrase,
  extractPastDatePhrase,
  resolveDateRange
};

