/**
 * Saka Fleet — Globalization Service (Permanent Rule)
 * ------------------------------------------------
 * Saka Fleet serves a GLOBAL audience. Every feature, prompt and quiz question
 * must respect:
 *  - Country detection from the WhatsApp number (E.164 prefixes)
 *  - Metric / imperial unit systems (distance + volume)
 *  - Regional currency, number and date formatting
 *  - The AI auto-translator (per-message language detection lives in the route)
 *
 * This file is the single source of truth for country + unit + locale data.
 */

export const REGION_FALLBACK = Object.freeze({
  country: 'International',
  country_code: 'GLOBAL',
  plate_example: 'ABC 123',
  default_units: 'metric',
  currency: 'USD',
  default_language: 'English',
  locale: 'en-US',
  timezone: 'Africa/Nairobi'
});

/**
 * Default IANA timezone per detected country. Users can override this in their
 * profile (profiles.timezone); the resolved value is always confirmed with the
 * user before a date-based reminder is written.
 */
export const COUNTRY_TIMEZONES = Object.freeze({
  KE: 'Africa/Nairobi',
  TZ: 'Africa/Dar_es_Salaam',
  UG: 'Africa/Kampala',
  RW: 'Africa/Kigali',
  ZA: 'Africa/Johannesburg',
  NG: 'Africa/Lagos',
  GH: 'Africa/Accra',
  EG: 'Africa/Cairo',
  US: 'America/New_York',
  CA: 'America/Toronto',
  MX: 'America/Mexico_City',
  BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  ES: 'Europe/Madrid',
  IT: 'Europe/Rome',
  NL: 'Europe/Amsterdam',
  PT: 'Europe/Lisbon',
  CH: 'Europe/Zurich',
  SE: 'Europe/Stockholm',
  PL: 'Europe/Warsaw',
  TR: 'Europe/Istanbul',
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  QA: 'Asia/Qatar',
  IN: 'Asia/Kolkata',
  PK: 'Asia/Karachi',
  BD: 'Asia/Dhaka',
  CN: 'Asia/Shanghai',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  SG: 'Asia/Singapore',
  MY: 'Asia/Kuala_Lumpur',
  ID: 'Asia/Jakarta',
  TH: 'Asia/Bangkok',
  PH: 'Asia/Manila',
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland'
});

const IANA_TIMEZONE_RE = /^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/;

/** Country code -> IANA timezone (Africa/Nairobi fallback). */
export function resolveTimezoneFromCountry(countryCode = 'GLOBAL') {
  const code = String(countryCode || '').toUpperCase();
  return COUNTRY_TIMEZONES[code] || REGION_FALLBACK.timezone;
}

/**
 * Resolve the timezone used to normalize a user's dates:
 *   1. explicit, user-confirmed profile timezone,
 *   2. country detected from the WhatsApp number,
 *   3. Africa/Nairobi (canonical system timezone).
 */
export function resolveUserTimezone({ countryInfo = null, profile = null } = {}) {
  const stored = profile?.timezone;
  if (stored && IANA_TIMEZONE_RE.test(String(stored))) return String(stored);
  return resolveTimezoneFromCountry(countryInfo?.country_code || REGION_FALLBACK.country_code);
}

export const REGIONS = Object.freeze([
  { prefix: '+254', country: 'Kenya', country_code: 'KE', plate_example: 'KDA 123A', default_units: 'metric', currency: 'KES', default_language: 'Swahili', locale: 'en-KE' },
  { prefix: '+1', country: 'United States', country_code: 'US', plate_example: '7ABC123', default_units: 'imperial', currency: 'USD', default_language: 'English', locale: 'en-US' },
  { prefix: '+44', country: 'United Kingdom', country_code: 'GB', plate_example: 'AB12 CDE', default_units: 'imperial', currency: 'GBP', default_language: 'English', locale: 'en-GB' },
  { prefix: '+27', country: 'South Africa', country_code: 'ZA', plate_example: 'CA 123-456', default_units: 'metric', currency: 'ZAR', default_language: 'English', locale: 'en-ZA' },
  { prefix: '+234', country: 'Nigeria', country_code: 'NG', plate_example: 'ABC-123XY', default_units: 'metric', currency: 'NGN', default_language: 'English', locale: 'en-NG' },
  { prefix: '+255', country: 'Tanzania', country_code: 'TZ', plate_example: 'T123 ABC', default_units: 'metric', currency: 'TZS', default_language: 'Swahili', locale: 'sw-TZ' },
  { prefix: '+256', country: 'Uganda', country_code: 'UG', plate_example: 'UBD 123A', default_units: 'metric', currency: 'UGX', default_language: 'English', locale: 'en-UG' },
  { prefix: '+250', country: 'Rwanda', country_code: 'RW', plate_example: 'RAA 123A', default_units: 'metric', currency: 'RWF', default_language: 'English', locale: 'en-RW' },
  { prefix: '+61', country: 'Australia', country_code: 'AU', plate_example: '1ABC23', default_units: 'metric', currency: 'AUD', default_language: 'English', locale: 'en-AU' },
  { prefix: '+49', country: 'Germany', country_code: 'DE', plate_example: 'B-MW 1234', default_units: 'metric', currency: 'EUR', default_language: 'German', locale: 'de-DE' },
  { prefix: '+33', country: 'France', country_code: 'FR', plate_example: 'AB-123-CD', default_units: 'metric', currency: 'EUR', default_language: 'French', locale: 'fr-FR' },
  { prefix: '+34', country: 'Spain', country_code: 'ES', plate_example: '1234 ABC', default_units: 'metric', currency: 'EUR', default_language: 'Spanish', locale: 'es-ES' },
  { prefix: '+39', country: 'Italy', country_code: 'IT', plate_example: 'AB 123 CD', default_units: 'metric', currency: 'EUR', default_language: 'Italian', locale: 'it-IT' },
  { prefix: '+31', country: 'Netherlands', country_code: 'NL', plate_example: 'AB-12-CD', default_units: 'metric', currency: 'EUR', default_language: 'Dutch', locale: 'nl-NL' },
  { prefix: '+91', country: 'India', country_code: 'IN', plate_example: 'MH 12 AB 1234', default_units: 'metric', currency: 'INR', default_language: 'English', locale: 'en-IN' },
  { prefix: '+971', country: 'United Arab Emirates', country_code: 'AE', plate_example: 'A 12345', default_units: 'metric', currency: 'AED', default_language: 'English', locale: 'en-AE' },
  { prefix: '+55', country: 'Brazil', country_code: 'BR', plate_example: 'ABC1D23', default_units: 'metric', currency: 'BRL', default_language: 'Portuguese', locale: 'pt-BR' },
  { prefix: '+52', country: 'Mexico', country_code: 'MX', plate_example: 'ABC-123-D', default_units: 'metric', currency: 'MXN', default_language: 'Spanish', locale: 'es-MX' }
]);

export function normalizePhone(phone) {
  if (!phone) return '';
  const clean = phone.toString().replace(/[^\d+]/g, '');
  return clean.startsWith('+') ? clean : `+${clean}`;
}

/**
 * Detect the user's region from the WhatsApp number.
 * Longest-prefix matching keeps NANP (+1) from stealing longer country codes.
 */
export function detectCountryFromPhone(phone) {
  if (!phone) return REGION_FALLBACK;
  const full = normalizePhone(phone);

  const matches = REGIONS
    .filter((r) => full.startsWith(r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  if (matches.length === 0) return REGION_FALLBACK;
  const { prefix, ...region } = matches[0];
  return region;
}

export function resolveUnitSystem(countryInfo, profile = null) {
  const preferred = profile?.unit_system;
  if (preferred === 'imperial' || preferred === 'metric') return preferred;
  return countryInfo?.default_units === 'imperial' ? 'imperial' : 'metric';
}

const KM_PER_MILE = 1.609344;
const LITERS_PER_US_GALLON = 3.785411784;
const LITERS_PER_IMPERIAL_GALLON = 4.54609;

/** Convert kilometres (canonical) into the user's preferred distance unit. */
export function kmToUserDistance(km, unitSystem = 'metric') {
  const value = Number(km);
  if (!Number.isFinite(value)) return null;
  return unitSystem === 'imperial' ? Math.round((value / KM_PER_MILE) * 10) / 10 : Math.round(value * 10) / 10;
}

/** Convert a user-entered distance into canonical kilometres. */
export function userDistanceToKm(value, unitSystem = 'metric') {
  const num = Number(String(value).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(num)) return null;
  return unitSystem === 'imperial' ? Math.round(num * KM_PER_MILE) : Math.round(num);
}

/** Convert litres (canonical) into the user's preferred volume unit. */
export function litersToUserVolume(liters, unitSystem = 'metric', countryCode = 'GLOBAL') {
  const value = Number(liters);
  if (!Number.isFinite(value)) return null;
  if (unitSystem !== 'imperial') return Math.round(value * 100) / 100;
  const perGallon = countryCode === 'GB' ? LITERS_PER_IMPERIAL_GALLON : LITERS_PER_US_GALLON;
  return Math.round((value / perGallon) * 100) / 100;
}

/** Convert a user-entered volume into canonical litres. */
export function userVolumeToLiters(value, unitSystem = 'metric', countryCode = 'GLOBAL') {
  const num = Number(String(value).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(num)) return null;
  if (unitSystem !== 'metric') {
    const perGallon = countryCode === 'GB' ? LITERS_PER_IMPERIAL_GALLON : LITERS_PER_US_GALLON;
    return Math.round(num * perGallon * 100) / 100;
  }
  return Math.round(num * 100) / 100;
}

export function getUnitLabels(unitSystem = 'metric', countryCode = 'GLOBAL') {
  const imperial = unitSystem === 'imperial';
  return {
    unitSystem: imperial ? 'imperial' : 'metric',
    distance: imperial ? 'mi' : 'km',
    distanceLong: imperial ? 'miles' : 'kilometres',
    volume: imperial ? (countryCode === 'GB' ? 'gal (UK)' : 'gal (US)') : 'L',
    volumeLong: imperial ? 'gallons' : 'litres',
    fuelEconomy: imperial ? 'MPG' : 'km/L',
    speed: imperial ? 'mph' : 'km/h'
  };
}

export function formatNumber(value, locale = 'en-US', options = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? '');
  try {
    return new Intl.NumberFormat(locale, options).format(num);
  } catch {
    return num.toLocaleString('en-US', options);
  }
}

export function formatMoney(amount, currency = 'USD', locale = 'en-US') {
  const num = Number(amount);
  if (!Number.isFinite(num)) return `${currency} ${amount ?? ''}`.trim();
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: num % 1 === 0 ? 0 : 2
    }).format(num);
  } catch {
    return `${currency} ${num.toLocaleString('en-US')}`;
  }
}

export function formatDate(dateLike, locale = 'en-US', options = {}) {
  if (!dateLike) return '';
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return String(dateLike);
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: 'short', day: 'numeric',
      timeZone: options.timeZone || 'Africa/Nairobi',
      ...options
    }).format(date);
  } catch {
    return date.toISOString().split('T')[0];
  }
}

/**
 * Structured globalization context injected into every DeepSeek prompt and
 * every quiz question so replies always use the user's region, units and locale.
 */
export function buildGlobalContext(countryInfo, profile = null) {
  const region = countryInfo || REGION_FALLBACK;
  const unitSystem = resolveUnitSystem(region, profile);
  const labels = getUnitLabels(unitSystem, region.country_code);
  return {
    country: region.country,
    countryCode: region.country_code,
    currency: region.currency,
    locale: region.locale || 'en-US',
    unitSystem,
    labels,
    timeZone: resolveUserTimezone({ countryInfo: region, profile }),
    preferredLanguage: profile?.preferred_language || region.default_language || 'English',
    plateExample: region.plate_example
  };
}

export function describeGlobalContext(countryInfo, profile = null) {
  const ctx = buildGlobalContext(countryInfo, profile);
  return [
    `Country: ${ctx.country} (${ctx.countryCode})`,
    `Currency: ${ctx.currency}`,
    `Units: ${ctx.unitSystem} (distance ${ctx.labels.distance}, volume ${ctx.labels.volume}, economy ${ctx.labels.fuelEconomy})`,
    `Locale: ${ctx.locale}`,
    `Timezone: ${ctx.timeZone}`,
    `Preferred language: ${ctx.preferredLanguage}`,
    `Plate example: ${ctx.plateExample}`
  ].join('\n');
}

export default {
  detectCountryFromPhone,
  buildGlobalContext,
  describeGlobalContext,
  getUnitLabels,
  kmToUserDistance,
  userDistanceToKm,
  litersToUserVolume,
  userVolumeToLiters,
  formatNumber,
  formatMoney,
  formatDate,
  normalizePhone,
  resolveUnitSystem,
  resolveTimezoneFromCountry,
  resolveUserTimezone
};

