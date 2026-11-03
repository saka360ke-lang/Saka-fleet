import { chatCompletion, parseJsonSafely } from './aiClient.js';
import {
  parseOcrAmount,
  detectCurrencyFromText,
  validatePlateCandidate,
  validateVinCandidate,
  normalizeOcrDate
} from './ocrNormalizer.js';

/**
 * Saka Fleet — Zero-Shot Semantic OCR Top-Up (v1.54.1)
 * ------------------------------------------------------
 * The deterministic Document Lens is ALWAYS the authority. This layer only
 * runs when the lens genuinely missed fields, and only fills EMPTY fields:
 *  - Flag-gated: OCR_AI_EXTRACTION (default OFF during the testing phase).
 *  - Background router tier (DeepSeek), JSON mode, bounded OCR text.
 *  - Every returned value is re-validated: dates through dateParser
 *    (country-resolved), amounts through the locale-aware normalizer, plates
 *    through the per-country pattern, VINs through the universal guard.
 *  - Any failure returns {} — today's deterministic behavior stands.
 */

const MAX_OCR_TEXT_CHARS = 4000;

/** Kill switch (default off; on|true|1 enables the AI top-up). */
export function isOcrAiExtractionEnabled() {
  return /^(?:on|true|1)$/i.test(String(process.env.OCR_AI_EXTRACTION || 'off'));
}

/** Field schemas per document family (mirrors documentLens expectedFieldsFor). */
export const OCR_EXTRACTION_FIELDS = Object.freeze({
  logbook: ['plate_number', 'vin', 'make_model', 'yom', 'engine_number', 'color', 'fuel_type'],
  insurance: ['insurance_policy', 'insurance_expiry', 'insurer'],
  drivers_licence: ['compliance_number', 'compliance_expiry'],
  inspection: ['inspection_number', 'inspection_expiry', 'odometer'],
  road_licence: ['compliance_number', 'compliance_expiry'],
  purchase_invoice: ['purchase_cost', 'purchase_date', 'vendor'],
  receipt_fuel: ['amount', 'currency', 'fuel_liters', 'odometer', 'vendor', 'date'],
  service_receipt: ['amount', 'currency', 'vendor', 'date'],
  odometer_photo: ['odometer']
});

/**
 * Validate + normalise an AI-extracted field before it can touch the quiz.
 * Deterministic, never throws; invalid values are dropped silently.
 */
export function sanitizeOcrExtraction(family, candidate, { countryCode = 'GLOBAL', locale = null } = {}) {
  const out = {};
  const allowed = OCR_EXTRACTION_FIELDS[family] || [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return out;
  for (const key of allowed) {
    const rawValue = candidate[key];
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue).trim();
    if (!value) continue;

    if (key === 'currency') {
      const code = value.toUpperCase();
      if (/^[A-Z]{3}$/.test(code)) out[key] = code;
      continue;
    }
    if (key === 'plate_number') {
      const plate = validatePlateCandidate(value, countryCode);
      if (plate) out[key] = plate;
      continue;
    }
    if (key === 'vin') {
      const vin = validateVinCandidate(value);
      if (vin) out[key] = vin;
      continue;
    }
    if (key === 'amount' || key === 'purchase_cost' || key === 'fuel_liters' || key === 'odometer' || key === 'yom') {
      const num = parseOcrAmount(value, { locale, countryCode });
      if (num !== null && Number.isFinite(num) && num > 0) out[key] = num;
      continue;
    }
    if (/date|expiry/.test(key)) {
      const iso = normalizeOcrDate(value, { countryCode });
      if (iso) out[key] = iso;
      continue;
    }
    out[key] = value.slice(0, 80);
  }
  return out;
}

/**
 * Ask the router to fill fields the deterministic lens missed. Returns only
 * sanitized, empty-slot fields (deterministic hints always win).
 */
export async function semanticOcrTopUp({
  text = '',
  family = 'unknown',
  countryCode = 'GLOBAL',
  locale = null,
  existing = {}
} = {}) {
  if (!isOcrAiExtractionEnabled()) return {};
  const allowed = OCR_EXTRACTION_FIELDS[family];
  if (!allowed || !allowed.length) return {};
  const missing = allowed.filter((key) => {
    const held = existing[key];
    return held === null || held === undefined || held === '';
  });
  if (!missing.length) return {};

  const bounded = String(text || '').slice(0, MAX_OCR_TEXT_CHARS);
  if (!bounded.trim()) return {};

  const system = [
    'You extract fields from OCR text of a vehicle document. Reply with ONLY a JSON object, no prose.',
    `Document family: ${family}.`,
    `Return ONLY these keys when a value is clearly printed (use null otherwise): ${missing.join(', ')}.`,
    `Country: ${String(countryCode || 'GLOBAL').toUpperCase()}. Locale: ${locale || 'unknown'}.`,
    'Rules: dates as YYYY-MM-DD (resolve DD/MM vs MM/DD from the country); amounts as plain numbers without currency symbols; never guess, never invent, never round; never re-order or merge unrelated values.'
  ].join('\n');

  try {
    const result = await chatCompletion({
      system,
      messages: [{ role: 'user', content: `OCR text:\n${bounded}` }],
      jsonMode: true,
      purpose: 'ocr_extraction'
    });
    if (!result.ok || !result.text) return {};
    const parsed = parseJsonSafely(result.text);
    const sanitized = sanitizeOcrExtraction(family, parsed, { countryCode, locale });
    const merged = {};
    for (const [key, value] of Object.entries(sanitized)) {
      if (missing.includes(key)) merged[key] = value;
    }
    return merged;
  } catch {
    return {};
  }
}

export default {
  isOcrAiExtractionEnabled,
  OCR_EXTRACTION_FIELDS,
  sanitizeOcrExtraction,
  semanticOcrTopUp
};