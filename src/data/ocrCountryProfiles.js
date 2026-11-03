import { parseOcrAmount } from '../services/ocrNormalizer.js';

/**
 * Saka Fleet — OCR country parsing profiles (v1.54.2)
 * ----------------------------------------------------
 * Country-specific document structures live ONLY inside their own profile
 * (rule 36): KE fiscal e-TIMS receipts and NTSA "VEHICLE PARTICULARS"
 * logbooks. The GLOBAL/universal path in ocrService.js stays neutral and
 * never sees a country's rules. New profiles are added here as plug-in
 * modules — driven by the `ocr_requests` watchlist, never pushed globally.
 */

export const LEGAL_RECEIPT_MARKER_RE = /\b(?:START|END)\s+OF\s+LEGAL\s+RECEIPT\b|\bFISCAL\s+RECEIPT\b|\*{3}/i;

/** True when the text carries Kenya e-TIMS (KRA fiscal receipt) markers. */
export function isKenyaEtimesText(text = '') {
  return /\b(?:LEGAL\s+RECEIPT|FISCAL\s+RECEIPT|KRA\s*\/?\s*ETI|BUYER\s+PIN|ETIMS)\b/i.test(String(text || ''));
}

/** KE numeric tokens keep comma-thousands semantics (universal delegate). */
function normalizeKeNumber(raw) {
  return parseOcrAmount(raw, { countryCode: 'KE' });
}

/**
 * Kenya e-TIMS profile: merchant line after the legal marker, TOTAL/CASH
 * amount (the figure often sits on the FOLLOWING line), and litres from a
 * product + "qty x unit-price" pair. VAT breakdown lines are never amounts.
 */
function extractKenyaEtimesHints(raw, rows) {
  const hints = {};
  const clean = (line) => String(line || '').replace(/\s+/g, ' ').trim();
  const lines = rows.map(clean).filter(Boolean);

  const merchant = lines.find((line) => {
    if (line.length < 3 || line.length > 60) return false;
    if (LEGAL_RECEIPT_MARKER_RE.test(line)) return false;
    if (/^(?:KE\b|PIN\b|BUYER|P\.?\s*O\.?\s*BOX|DATE|TIME|KRA\b|CU\s|RECEIPT\s+NUMBER|CONTROL\s+UNIT|ITEMS\s+NUMBER|SIGNED|SCAN\b)/i.test(line)) return false;
    return /[A-Z]{3,}/i.test(line) && !/^[\d.,\s\-/]+$/.test(line);
  });
  if (merchant) hints.vendor = merchant.slice(0, 60);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/\b(?:total|cash|amount)\b/i.test(line)) continue;
    if (/%|\bTAX\b|\bNET\b|\bBALANCE\b/i.test(line)) continue;
    const sameLine = parseOcrAmount((line.match(/(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+[.,]\d{1,2})/) || [])[1], { countryCode: 'KE' });
    if (sameLine !== null && sameLine > 0) { hints.amount = sameLine; break; }
    for (let k = 1; k <= 2 && i + k < lines.length; k += 1) {
      const next = lines[i + k];
      if (!next || /%|\bTAX\b|\bNET\b/i.test(next)) continue;
      const value = normalizeKeNumber((next.match(/^(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2})$/) || [])[1]);
      if (value !== null && value > 0) { hints.amount = value; break; }
    }
    if (hints.amount) break;
  }

  const fuelProductRe = /^(?:DIESEL|PETROL|PREMIUM|SUPER|KEROSENE|FUEL)\b/i;
  for (let i = 0; i < lines.length && hints.fuel_liters == null; i += 1) {
    if (!fuelProductRe.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      const pair = lines[j].match(/([\d][\d,.]*)\s*[x×]\s*([\d][\d,.]*)/i);
      if (!pair) continue;
      const qty = normalizeKeNumber(pair[1]);
      if (qty !== null && qty > 0 && qty <= 500) { hints.fuel_liters = qty; break; }
    }
  }

  return hints;
}

/**
 * KE NTSA "VEHICLE PARTICULARS" logbook profile (v1.53.2). The Kenyan
 * certificate prints VALUE-BEFORE-LABEL pairs:
 *   "KAS628T DATE OF REGISTRATION" · "TOYOTA DUTY" ·
 *   "LAND CRUISER NO. OF PREVIOUS OWNERS" · "S.WAGON TARE WEIGHT (KGS)" ·
 *   "DIESEL TAX CLASS" · "1991 NO. OF AXLES" · "1HD-0015769 PREVIOUS REG. COUNTRY"
 * The current plate is the one beside DATE OF REGISTRATION (the title-line
 * plate can be the PREVIOUS registration). GLOBAL documents never see this.
 */
function extractNtsaParticularsHints(raw, rows) {
  const hints = {};
  const ntsaCert = /\bREGISTRATION\s+CERTIFICATE\b/i.test(raw)
    || /\bVEHICLE\s+PARTICULARS\b/i.test(raw)
    || /\bCHASSIS\s*\/?\s*FRAME\b/i.test(raw);
  if (!ntsaCert) return hints;

  const valueBefore = (labelRe) => {
    for (const line of rows) {
      if (!labelRe.test(line)) continue;
      const value = String(line)
        .replace(labelRe, '')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[\s.:#,\-/]+$/g, '')
        .trim();
      if (value && value.length <= 40) return value;
    }
    return null;
  };
  const currentPlate = valueBefore(/\bDATE\s+OF\s+REGISTRATION\b/i);
  if (currentPlate && /^[A-Z]{3}\s?\d{3}[A-Z]$/i.test(currentPlate.replace(/\s+/g, ' '))) {
    hints.plate_number = currentPlate.toUpperCase().replace(/\s+/g, ' ').trim();
  }
  const chassis = valueBefore(/\bGROSS\s+WEIGHT\b/i);
  if (chassis && /^[A-HJ-NPR-Z0-9]{11,17}$/i.test(chassis)) hints.vin = chassis.toUpperCase();
  const keMake = valueBefore(/\bDUTY\b/i);
  const keModel = valueBefore(/\bNO\.\s*OF\s*PREVIOUS\s+OWNERS\b/i);
  const keBody = valueBefore(/\bTARE\s+WEIGHT\b/i);
  const keFuel = valueBefore(/\bTAX\s+CLASS\b/i);
  const keYear = valueBefore(/\bNO\.\s*OF\s*AXLES\b/i);
  const keEngine = valueBefore(/\bPREVIOUS\s+REG\.?\s*COUNTRY\b/i);
  const keColour = valueBefore(/\bPREVIOUS\s+REGISTRATION\b/i);
  const makeModel = [keMake, keModel, keBody].filter(Boolean).join(' ').trim();
  if (makeModel) hints.make_model = makeModel;
  if (keYear && /^(?:19|20)\d{2}$/.test(keYear)) hints.yom = Number(keYear);
  if (keFuel) {
    const fuelWord = keFuel.match(/\b(petrol|diesel|gasoline|electric|hybrid|lpg|cng|hydrogen)\b/i);
    if (fuelWord) hints.fuel_type = fuelWord[1].toLowerCase();
  }
  if (keEngine && /^[A-Z0-9][A-Z0-9\-/]{3,}$/i.test(keEngine)) hints.engine_number = keEngine;
  if (keColour && /^[A-Z]{3,15}$/i.test(keColour)) hints.color = keColour.toLowerCase();
  return hints;
}

/** One country profile: etimes (receipts) + logbook (registration) parsers. */
export const KE_OCR_PROFILE = Object.freeze({
  id: 'KE',
  label: 'Kenya',
  etimes: { isText: isKenyaEtimesText, extractHints: extractKenyaEtimesHints },
  logbook: { extractHints: extractNtsaParticularsHints }
});

/**
 * Resolve a parsing profile from the caller's country (WhatsApp number,
 * rule 36). GLOBAL returns null — the universal path stays neutral.
 */
export function getOcrCountryProfile(countryCode = 'GLOBAL') {
  const code = String(countryCode || 'GLOBAL').toUpperCase();
  if (code === 'KE') return KE_OCR_PROFILE;
  return null;
}

export default { LEGAL_RECEIPT_MARKER_RE, isKenyaEtimesText, KE_OCR_PROFILE, getOcrCountryProfile };