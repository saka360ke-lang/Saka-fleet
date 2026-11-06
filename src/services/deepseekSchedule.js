/**
 * Saka Fleet — DeepSeek off-peak schedule (v1.62.0, rule 61)
 * ---------------------------------------------------------
 * DeepSeek prices every API call by the UTC clock (official docs, verified
 * 2026-11-06):
 *
 *   Peak     : 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday,
 *              EXCLUDING Chinese public holidays.
 *   Off-peak : everything else — weekends, Chinese public holidays in full,
 *              weekday nights/afternoons and the 04:00-06:00 / 10:00-24:00 gaps.
 *   Price    : off-peak rates are HALF of the peak rates (~79% of the week).
 *
 * In EAT (Africa/Nairobi, UTC+3) the peak windows read 04:00-07:00 and
 * 09:00-13:00, Monday-Friday.
 *
 * This module is PURE and dependency-free on purpose: the CLI gates
 * (`npm run synth:cases`, `npm run eval:conv`), the telemetry cost estimator
 * (`aiUsageLog.js`) and the tests all share ONE source of truth, and no
 * provider is ever called just to decide whether it is peak.
 *
 * Chinese holidays: the Gregorian-anchored statutory windows are built in
 * (New Year, Qingming, Labour Day, National Day). Lunar festivals (Spring
 * Festival, Dragon Boat, Mid-Autumn) shift every year, so they are NOT
 * invented here — add the official dates from the State Council notice via
 * `DEEPSEEK_CN_HOLIDAYS` (CSV of YYYY-MM-DD, Beijing dates). A year we do not
 * know simply follows the weekday-window rule (fail-open, never blocks work).
 */

const FALSY = new Set(['off', 'false', '0']);

/** Official DeepSeek peak windows as UTC minutes-of-day (start inclusive, end exclusive). */
export const DEEPSEEK_PEAK_WINDOWS_UTC = Object.freeze([
  Object.freeze({ startMinute: 60, endMinute: 240, label: '01:00-04:00 UTC' }),
  Object.freeze({ startMinute: 360, endMinute: 600, label: '06:00-10:00 UTC' })
]);

/** Off-peak DeepSeek rates are half of the peak rates. */
export const DEEPSEEK_OFF_PEAK_DISCOUNT_FACTOR = 0.5;

/** Human label used by CLI guidance and docs (deterministic copy, zero tokens). */
export const DEEPSEEK_PEAK_HOURS_LABEL = 'Mon-Fri 01:00-04:00 & 06:00-10:00 UTC (04:00-07:00 & 09:00-13:00 EAT)';

const WEEKDAY_LABELS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

/**
 * Gregorian-anchored Chinese statutory holiday windows (MM-DD, Beijing dates).
 * Lunar festivals are deliberately NOT hardcoded — see DEEPSEEK_CN_HOLIDAYS.
 */
const CN_FIXED_HOLIDAY_RANGES = Object.freeze([
  Object.freeze(['01-01', '01-01']), // New Year's Day
  Object.freeze(['04-04', '04-06']), // Qingming (solar-term anchored observed window)
  Object.freeze(['05-01', '05-05']), // Labour Day
  Object.freeze(['10-01', '10-07']) // National Day golden week
]);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minuteOfDayUtc(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** Beijing (UTC+8) calendar date of an instant, as { year, monthDay }. */
function beijingDateParts(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    monthDay: `${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
  };
}

function parseConfiguredHolidays(raw) {
  const set = new Set();
  for (const token of String(raw || '').split(',')) {
    const value = token.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) set.add(value);
  }
  return set;
}

/**
 * True when the instant falls on a Chinese public holiday (Beijing calendar
 * date). Built-in fixed-date windows + the operator's `DEEPSEEK_CN_HOLIDAYS`
 * CSV (lunar festivals from the official State Council notice).
 */
export function isChinesePublicHoliday(date = new Date()) {
  const at = toDate(date);
  if (!at) return false;
  const { year, monthDay } = beijingDateParts(at);
  const configured = parseConfiguredHolidays(process.env.DEEPSEEK_CN_HOLIDAYS);
  if (configured.has(`${year}-${monthDay}`)) return true;
  return CN_FIXED_HOLIDAY_RANGES.some(([start, end]) => monthDay >= start && monthDay <= end);
}

/** Off-peak multiplier (env-overridable, default 0.5). Readings are dynamic. */
export function resolveOffPeakDiscountFactor() {
  const value = Number(process.env.DEEPSEEK_OFF_PEAK_DISCOUNT_FACTOR);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : DEEPSEEK_OFF_PEAK_DISCOUNT_FACTOR;
}

function atUtcMinute(date, minute) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, minute, 0, 0));
}

/** First peak-window start strictly after `date` (weekday, non-holiday). */
function nextPeakStartAfter(date) {
  const startMinute = minuteOfDayUtc(date);
  for (let offset = 0; offset < 8; offset += 1) {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + offset));
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (isChinesePublicHoliday(day)) continue;
    for (const window of DEEPSEEK_PEAK_WINDOWS_UTC) {
      if (offset > 0 || window.startMinute > startMinute) {
        return atUtcMinute(day, window.startMinute);
      }
    }
  }
  return null;
}

/**
 * Pricing state for an instant: `{ peak, reason, discountFactor,
 * nextTransition, weekday, holiday }`.
 *
 * `reason` is one of `peak_window`, `outside_peak_window`, `weekend`,
 * `chinese_holiday` or `unknown_time` (fail-conservative: billed at peak).
 */
export function getDeepSeekPricingState(date = new Date()) {
  const at = toDate(date);
  const offPeakFactor = resolveOffPeakDiscountFactor();
  if (!at) {
    return {
      peak: true,
      reason: 'unknown_time',
      discountFactor: 1,
      nextTransition: null,
      weekday: null,
      holiday: false
    };
  }

  const weekday = at.getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const holiday = isChinesePublicHoliday(at);
  const minute = minuteOfDayUtc(at);
  const window = DEEPSEEK_PEAK_WINDOWS_UTC.find((entry) => minute >= entry.startMinute && minute < entry.endMinute) || null;

  let peak = false;
  let reason = 'outside_peak_window';
  if (holiday) {
    reason = 'chinese_holiday';
  } else if (weekend) {
    reason = 'weekend';
  } else if (window) {
    peak = true;
    reason = 'peak_window';
  }

  const nextTransition = peak
    ? atUtcMinute(at, window ? window.endMinute : DEEPSEEK_PEAK_WINDOWS_UTC[1].endMinute)
    : nextPeakStartAfter(at);

  return {
    peak,
    reason,
    discountFactor: peak ? 1 : offPeakFactor,
    nextTransition,
    weekday,
    holiday
  };
}

/** True when DeepSeek bills the instant at peak rates. */
export function isDeepSeekPeakTime(date = new Date()) {
  return getDeepSeekPricingState(date).peak === true;
}

/**
 * Cost multiplier for a DeepSeek call at `date`. A missing/unknown timestamp
 * returns 1 (gross peak price) so estimates can never understate a bill.
 */
export function getDeepSeekDiscountFactor(date = null) {
  if (date === null || date === undefined) return 1;
  const at = toDate(date);
  if (!at) return 1;
  return getDeepSeekPricingState(at).discountFactor;
}

/** Gate kill switch — DEEPSEEK_OFF_PEAK_GATE (on|off, default on). */
export function isDeepSeekOffPeakGateEnabled() {
  return !FALSY.has(String(process.env.DEEPSEEK_OFF_PEAK_GATE || 'on').toLowerCase());
}

/** Format an instant as HH:MM EAT (Africa/Nairobi, UTC+3). */
export function formatEatTime(date) {
  const at = toDate(date);
  if (!at) return 'n/a';
  const eat = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  return `${pad2(eat.getUTCHours())}:${pad2(eat.getUTCMinutes())} EAT`;
}

function formatTransitionLabel(date) {
  const at = toDate(date);
  if (!at) return 'later';
  return `${WEEKDAY_LABELS[at.getUTCDay()]} ${formatEatTime(at)} (${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())} UTC)`;
}

/** Deterministic operator copy for a deferred batch run (zero tokens). */
export function formatOffPeakGateMessage(date = new Date(), state = getDeepSeekPricingState(date)) {
  const next = state?.nextTransition;
  return [
    `⏸️ DeepSeek peak pricing is active (${DEEPSEEK_PEAK_HOURS_LABEL}).`,
    `Off-peak (half price) starts ${formatTransitionLabel(next)}.`,
    'Re-run then, or pass --force to run now at the peak rate.'
  ].join('\n');
}

/**
 * Decide whether a heavy DeepSeek batch may start now.
 *
 * Batch entry points (synthetic case generation, eval judge runs) call this
 * before spending tokens. Peak + no `--force` = deferred; the caller prints the
 * message, writes the DEEPSEEK_DEFERRED_TO_OFF_PEAK audit row and exits 2.
 * Front-user chat and supervision ticks never call this gate.
 */
export function evaluateDeepSeekOffPeakGate({ now = new Date(), force = false } = {}) {
  const state = getDeepSeekPricingState(now);
  if (!isDeepSeekOffPeakGateEnabled()) {
    return { allowed: true, reason: 'gate_disabled', state, message: '' };
  }
  if (state.peak !== true) {
    return { allowed: true, reason: state.reason, state, message: '' };
  }
  if (force === true) {
    return { allowed: true, reason: 'forced', state, message: '' };
  }
  return {
    allowed: false,
    reason: 'peak_window',
    state,
    message: formatOffPeakGateMessage(now, state)
  };
}

/**
 * Audit a deferred run into `admin_audit_logs` (no DDL). Fail-soft: an audit
 * outage must never change the gate verdict. Returns true when written.
 */
export async function logDeepSeekDeferralAudit(providedSupabase, details = {}) {
  if (!providedSupabase) return false;
  try {
    const { error } = await providedSupabase.from('admin_audit_logs').insert([{
      admin_phone: details.adminPhone || 'cli:deepseek-gate',
      action: 'DEEPSEEK_DEFERRED_TO_OFF_PEAK',
      details: {
        ...details,
        next_off_peak: details.next_off_peak || null,
        logged_at: new Date().toISOString()
      },
      created_at: new Date().toISOString()
    }]);
    return !error;
  } catch {
    return false;
  }
}

export default {
  DEEPSEEK_PEAK_WINDOWS_UTC,
  DEEPSEEK_OFF_PEAK_DISCOUNT_FACTOR,
  DEEPSEEK_PEAK_HOURS_LABEL,
  isChinesePublicHoliday,
  resolveOffPeakDiscountFactor,
  getDeepSeekPricingState,
  isDeepSeekPeakTime,
  getDeepSeekDiscountFactor,
  isDeepSeekOffPeakGateEnabled,
  formatEatTime,
  formatOffPeakGateMessage,
  evaluateDeepSeekOffPeakGate,
  logDeepSeekDeferralAudit
};
