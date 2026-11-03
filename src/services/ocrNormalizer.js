import { parseFlexibleDate } from './dateParser.js';

/**
 * Saka Fleet — Universal OCR Normalization (v1.54.1)
 * ---------------------------------------------------
 * Post-processing layer for OCR-extracted values from ANY country:
 *  - Money/amounts: locale-resolved decimal conventions (1,234.56 vs 1.234,56)
 *    and an extended currency symbol table (CLDR-derived).
 *  - Dates: every date routes through dateParser (country-resolved) — never
 *    a hand-rolled date regex (rule 7).
 *  - Vehicle identifiers: per-country plate patterns + the universal VIN rule.
 *
 * Rule 36: a country pattern only strengthens its own bucket. The GLOBAL path
 * stays neutral, and structurally-unambiguous grouped numbers (1.234,56 /
 * 1,234.56) parse in EVERY market because their grouping is unambiguous;
 * only single-separator tokens (45,50 / 45.50 / 1.234) resolve by locale.
 */

export const OCR_CURRENCY_SYMBOLS = Object.freeze({
  '₹': 'INR', $: 'USD', '€': 'EUR', '£': 'GBP', '₦': 'NGN', '฿': 'THB', '₱': 'PHP',
  '₩': 'KRW', '₺': 'TRY', '₴': 'UAH', '₪': 'ILS', '₫': 'VND', '₡': 'CRC', '₲': 'PYG',
  'R$': 'BRL', 'S$': 'SGD', 'A$': 'AUD', 'C$': 'CAD', 'NZ$': 'NZD', 'HK$': 'HKD',
  'Rs': 'INR', 'KSh': 'KES', 'TSh': 'TZS', 'USh': 'UGX', 'RM': 'MYR', 'Rp': 'IDR',
  'د.إ': 'AED', 'ر.س': 'SAR'
});

export const OCR_CURRENCY_CODES = Object.freeze([
  'KES', 'USD', 'EUR', 'GBP', 'NGN', 'ZAR', 'TZS', 'UGX', 'RWF', 'INR', 'AED', 'BRL', 'MXN',
  'THB', 'PHP', 'KRW', 'TRY', 'SAR', 'PKR', 'IDR', 'MYR', 'SGD', 'AUD', 'CAD', 'NZD', 'HKD',
  'EGP', 'GHS', 'ETB', 'COP', 'ARS', 'CLP', 'PEN', 'BDT', 'VND'
]);

// CLDR comma-decimal markets (country buckets and language tags).
const COMMA_DECIMAL_COUNTRIES = new Set([
  'DE', 'FR', 'ES', 'IT', 'NL', 'PT', 'BR', 'ID', 'TR', 'DK', 'SE', 'NO', 'FI', 'PL',
  'RO', 'HU', 'CZ', 'GR', 'RU', 'UA', 'BG', 'HR', 'SK', 'SI', 'EE', 'LT', 'LV', 'VN',
  'AR', 'UY', 'CL', 'CO', 'PE', 'BO', 'PY', 'IS'
]);
const COMMA_DECIMAL_LANGS = new Set([
  'de', 'fr', 'es', 'it', 'nl', 'pt', 'id', 'tr', 'da', 'sv', 'no', 'fi', 'pl', 'ro',
  'hu', 'cs', 'el', 'ru', 'uk', 'bg', 'hr', 'sk', 'sl', 'et', 'lt', 'lv', 'vi', 'is'
]);

/** True when the locale/country writes decimals with a comma (CLDR). */
export function usesCommaDecimal({ locale = null, countryCode = 'GLOBAL' } = {}) {
  const lang = String(locale || '').toLowerCase().split(/[-_]/)[0];
  if (lang && COMMA_DECIMAL_LANGS.has(lang)) return true;
  return COMMA_DECIMAL_COUNTRIES.has(String(countryCode || 'GLOBAL').toUpperCase());
}

/**
 * Parse an OCR numeric token into a number — universal and never guessing.
 * Grouped forms (1,234.56 | 1.234,56) parse anywhere; single-separator tokens
 * resolve by locale; OCR noise with mixed separators returns null.
 */
export function parseOcrAmount(token, { locale = null, countryCode = 'GLOBAL' } = {}) {
  const raw = String(token ?? '').replace(/\s+/g, '');
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);

  let match = /^(\d{1,3})\.(\d{3})$/.exec(raw); // single dot-group: 1.234 (locale-resolved)
  if (match) {
    // In comma-decimal markets "1.234" is a thousands group, not 1.234.
    if (usesCommaDecimal({ locale, countryCode })) return Number(`${match[1]}${match[2]}`);
    return Number(`${match[1]}.${match[2]}`);
  }

  match = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(raw); // US/KE grouped: 1,234.56 | 1,234
  if (match) {
    const integer = match[1].replace(/,/g, '');
    const value = Number(match[2] ? `${integer}.${match[2]}` : integer);
    return Number.isFinite(value) ? value : null;
  }

  // EU grouped — unambiguous only with 2+ dot groups or a comma fraction.
  match = /^(\d{1,3}(?:\.\d{3}){2,})(?:,(\d{1,2}))?$/.exec(raw); // 1.234.567 | 1.234.567,89
  if (match) {
    const integer = match[1].replace(/\./g, '');
    const value = Number(match[2] ? `${integer}.${match[2]}` : integer);
    return Number.isFinite(value) ? value : null;
  }

  match = /^(\d{1,3}(?:\.\d{3})+),(\d{1,2})$/.exec(raw); // 1.234,56
  if (match) {
    const integer = match[1].replace(/\./g, '');
    const value = Number(`${integer}.${match[2]}`);
    return Number.isFinite(value) ? value : null;
  }

  match = /^(\d+),(\d{1,2})$/.exec(raw); // single comma: 45,50
  if (match) {
    if (usesCommaDecimal({ locale, countryCode })) return Number(`${match[1]}.${match[2]}`);
    return null; // ambiguous in a comma-thousands market — never guess
  }

  match = /^(\d+)\.(\d{1,2})$/.exec(raw); // single dot decimal: 45.50
  if (match) {
    return Number(`${match[1]}.${match[2]}`);
  }

  if (/^\d+(?:[.,]\d+){2,}$/.test(raw)) return null; // OCR noise: "3.000.00"
  return null;
}

/** Detect a currency code from text (word codes first, then symbols). */
export function detectCurrencyFromText(text = '') {
  const raw = String(text || '');
  for (const code of OCR_CURRENCY_CODES) {
    if (new RegExp(`\\b${code}\\b`, 'i').test(raw)) return code;
  }
  // Longest symbol first: "R$" must beat the bare "$" it contains.
  const symbols = Object.entries(OCR_CURRENCY_SYMBOLS).sort((a, b) => b[0].length - a[0].length);
  for (const [symbol, code] of symbols) {
    if (raw.includes(symbol)) return code;
  }
  return null;
}

/** Per-country plate patterns. GLOBAL keeps the neutral universal shape. */
export const PLATE_PATTERNS = Object.freeze({
  KE: /^[A-Z]{3} ?\d{3}[A-Z]$/,
  TZ: /^[A-Z] ?\d{3} ?[A-Z]{3}$/,
  UG: /^U[A-Z]{2} ?\d{3}[A-Z]$/,
  NG: /^[A-Z]{2,3}[- ]?\d{2,3}[- ]?[A-Z]{2,3}$/,
  ZA: /^[A-Z]{2,3} ?\d{3,4}[- ]?[A-Z]{2}$|^[A-Z]{2} ?\d{3}[- ]?[A-Z]{3}$/,
  GB: /^[A-Z]{2}\d{2} ?[A-Z]{3}$/,
  IN: /^[A-Z]{2} ?\d{2} ?[A-Z]{1,2} ?\d{4}$/,
  AU: /^[A-Z]{2,3}[- ]?\d{2,4}[A-Z]{0,2}$/,
  AE: /^[A-Z]{1,2} ?\d{4,5}$/,
  CA: /^[A-Z]{3} ?\d{3}$/,
  US: /^[A-Z]{1,3}[- ]?\d{1,4}$|^\d{3}[- ]?[A-Z]{3}$/
});

export const GLOBAL_PLATE_RE = /^[A-Z]{1,4} ?\d{1,4}[A-Z]{0,3}$/;

/** Validate/normalise a plate candidate for its country. Never hard-blocks. */
export function validatePlateCandidate(token, countryCode = 'GLOBAL') {
  const clean = String(token || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!/\d/.test(clean)) return null;
  const pattern = PLATE_PATTERNS[String(countryCode || 'GLOBAL').toUpperCase()];
  if (pattern) return pattern.test(clean) ? clean : null;
  return GLOBAL_PLATE_RE.test(clean) ? clean : null;
}

/** Universal VIN guard: letters+digits, 11–17 chars, no I/O/Q. */
export function validateVinCandidate(token) {
  const clean = String(token || '').toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
  return /^[A-HJ-NPR-Z0-9]{11,17}$/.test(clean) ? clean : null;
}

/** Country-resolved OCR date → ISO-8601 (Africa/Nairobi canonical) or null. */
export function normalizeOcrDate(token, { countryCode = 'GLOBAL' } = {}) {
  const parsed = parseFlexibleDate(String(token || ''), { countryCode });
  return parsed?.ok && parsed.iso ? parsed.iso.slice(0, 10) : null;
}

export default {
  OCR_CURRENCY_SYMBOLS,
  OCR_CURRENCY_CODES,
  PLATE_PATTERNS,
  GLOBAL_PLATE_RE,
  usesCommaDecimal,
  parseOcrAmount,
  detectCurrencyFromText,
  validatePlateCandidate,
  validateVinCandidate,
  normalizeOcrDate
};