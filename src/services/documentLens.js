import { parseFlexibleDate } from './dateParser.js';
import { classifyOcrDocument } from './ocrService.js';

/**
 * Saka Fleet — Document Lens (v1.20.0)
 * ------------------------------------
 * Turns raw OCR text (from Vision images or the PDF text extractor) into a
 * structured, confirmable set of fields per document family. Deterministic —
 * no AI tokens, no invented values. Every field carries a confidence so the
 * quiz can show "📸 I read this — double-check" before any write.
 */

export const DOCUMENT_FAMILIES = Object.freeze({
  logbook: { label: 'vehicle registration certificate', lane: 'vehicle' },
  insurance: { label: 'insurance certificate', lane: 'vehicle' },
  inspection: { label: 'inspection / roadworthiness certificate', lane: 'vehicle' },
  road_licence: { label: 'road service licence / permit', lane: 'vehicle' },
  purchase_invoice: { label: 'purchase invoice', lane: 'vehicle' },
  drivers_licence: { label: 'driver licence / badge', lane: 'driver' },
  receipt_fuel: { label: 'fuel receipt', lane: 'expense' },
  service_receipt: { label: 'service invoice', lane: 'expense' },
  odometer_photo: { label: 'odometer photo', lane: 'vehicle' },
  unknown: { label: 'document', lane: 'unknown' }
});

const SERVICE_WORDS = /\b(oil|filter|brake|tyre|tire|alignment|battery|wiper|coolant|spark|suspension|clutch|service|labou?r|garage)\b/i;
const FUEL_WORDS = /\b(fuel|diesel|petrol|gasoline|pump|nozzle|litre|liter|super|kerosene)\b/i;

function cleanLine(line) {
  return String(line || '').replace(/\s+/g, ' ').trim();
}

function lines(text) {
  return String(text || '').split(/\r?\n/).map(cleanLine).filter(Boolean);
}

function toNumber(raw) {
  const value = Number(String(raw || '').replace(/[,\s]/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function firstDateNear(text, keyword, countryCode = 'GLOBAL') {
  const rows = lines(text);
  for (let i = 0; i < rows.length; i += 1) {
    if (!keyword.test(rows[i])) continue;
    for (let j = i; j < Math.min(i + 3, rows.length); j += 1) {
      const row = rows[j];
      const token = row.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/);
      const parsed = parseFlexibleDate(token ? token[1] : row, { countryCode });
      if (parsed?.ok && parsed.iso) return parsed.iso.slice(0, 10);
    }
  }
  return null;
}

function anyDate(text, countryCode = 'GLOBAL') {
  const match = String(text || '').match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/);
  if (!match) return null;
  const parsed = parseFlexibleDate(match[1], { countryCode });
  return parsed?.ok && parsed.iso ? parsed.iso.slice(0, 10) : null;
}

function labeled(text, labels) {
  // Require a word boundary after the label AND a separator ("No"/"Number"/":"),
  // so the label word itself can never be captured as the value.
  const pattern = new RegExp(`\\b(?:${labels})\\b\\s*(?:(?:no\\.?|number)\\s*[:#]?|[:#])\\s*([A-Z0-9][A-Z0-9\\-\\/]{2,})`, 'i');
  const match = String(text || '').match(pattern);
  return match ? match[1].toUpperCase() : null;
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== '') ?? null;
}

function pushField(target, key, value, confidence = 0.9) {
  if (value === null || value === undefined || String(value).trim() === '') return;
  target[key] = { value, confidence };
}

function detectCurrency(text) {
  const raw = String(text || '').toUpperCase();
  if (/KES|KSH|K\.SH/.test(raw)) return 'KES';
  if (/TZS|T\.SH/.test(raw)) return 'TZS';
  if (/UGX|USHS?/.test(raw)) return 'UGX';
  if (/NGN|₦/.test(raw)) return 'NGN';
  if (/ZAR|R\s?\d/.test(raw)) return 'ZAR';
  if (/INR|₹/.test(raw)) return 'INR';
  if (/USD|US\$|\$\s?\d/.test(raw)) return 'USD';
  if (/EUR|€/.test(raw)) return 'EUR';
  if (/GBP|£/.test(raw)) return 'GBP';
  return null;
}

function amountFrom(text) {
  const rows = lines(text);
  const totalLine = rows.find((row) => /\b(grand\s*total|total|amount\s*due|balance\s*due|amount)\b/i.test(row));
  if (totalLine) {
    const match = totalLine.match(/([A-Z]{3})?\s*([\d][\d,]{2,}(?:\.\d{1,2})?)/);
    if (match) return toNumber(match[2]);
  }
  const all = [...String(text || '').matchAll(/([A-Z]{3})?\s*([\d][\d,]{3,}(?:\.\d{1,2})?)/g)]
    .map((match) => toNumber(match[2])).filter(Boolean);
  return all.length ? Math.max(...all) : null;
}


function parseLogbook(text, countryCode) {
  const fields = {};
  const rows = lines(text);

  const plateMatch = String(text).match(/(?:registration\s*(?:no|number)?|reg\.?\s*(?:no|number)|plate(?:\s*(?:no|number))?)\s*[:\-#]?\s*([A-Z]{1,4}[\s-]?\d{1,4}[A-Z]{0,3})\b/i)
    || String(text).match(/\b([A-Z]{2,3}[\s-]?\d{3}[A-Z]?)\b/);
  pushField(fields, 'plate_number', plateMatch ? plateMatch[1].toUpperCase().replace(/\s+/g, ' ').trim() : null, 0.92);

  const vinMatch = String(text).match(/(?:VIN|chassis(?:\s*(?:no|number))?)\s*[:\-#]?\s*([A-HJ-NPR-Z0-9]{11,17})\b/i)
    || String(text).match(/\b(?=[A-HJ-NPR-Z0-9]{11,17}\b)(?=[A-Z0-9]*\d)[A-HJ-NPR-Z0-9]{11,17}\b/);
  pushField(fields, 'vin', vinMatch ? vinMatch[1].toUpperCase() : null, 0.9);
  pushField(fields, 'engine_number', labeled(text, 'engine\\s*(?:no|number)?'), 0.88);

  const make = String(text).match(/(?:make|manufacturer)\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 .\-/]{1,30})/i);
  const model = String(text).match(/model\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 .\-/]{1,30})/i);
  const makeModel = [make?.[1], model?.[1]].filter(Boolean).join(' ').trim();
  pushField(fields, 'make_model', makeModel || null, 0.85);

  const yom = String(text).match(/(?:year\s*(?:of\s*(?:manufacture|make))?|yom)\s*[:\-]?\s*(19\d{2}|20\d{2})/i)
    || String(text).match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  const year = yom ? Number(yom[1]) : null;
  pushField(fields, 'yom', Number.isFinite(year) ? year : null, 0.82);

  const colorLine = rows.find((row) => /colou?r\s*[:\-]/i.test(row));
  const color = colorLine ? cleanLine(colorLine.replace(/.*colou?r\s*[:\-]\s*/i, '')) : null;
  pushField(fields, 'color', color && color.length <= 20 ? color : null, 0.8);

  return fields;
}

function parseInsurance(text, countryCode) {
  const fields = {};
  pushField(fields, 'insurance_policy', labeled(text, 'policy|cover\\s*note'), 0.9);
  const insurer = String(text).match(/(?:insurer|insurance\s*(?:company|co\.?)|underwriter)\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 &.\-]{2,50})/i)
    || String(text).match(/\b([A-Z][A-Za-z&.\- ]{2,40}(?:INSURANCE|ASSURANCE|UNDERWRITERS?))\b/);
  pushField(fields, 'insurer', insurer ? cleanLine(insurer[1]) : null, 0.85);
  pushField(fields, 'insurance_expiry', firstDateNear(text, /(expir|valid\s*(?:until|to|till)|renew|due)/i, countryCode), 0.9);
  const premium = String(text).match(/(?:premium|sum\s*insured|insured\s*value)\s*[:\-]?\s*([A-Z]{3})?\s*([\d][\d,]{2,})/i);
  pushField(fields, 'insurance_premium', premium ? toNumber(premium[2]) : null, 0.78);
  return fields;
}

function parseLicence(text, countryCode) {
  const fields = {};
  pushField(fields, 'compliance_number', labeled(text, 'licen[cs]e|lic|dl|psv|pdp|badge'), 0.9);
  pushField(fields, 'compliance_expiry', firstDateNear(text, /(expir|valid\s*(?:until|to|till)|renew|due)/i, countryCode), 0.9);
  const type = /PSV/i.test(text) ? 'PSV Badge'
    : (/PDP/i.test(text) ? 'PDP'
      : (/CPC/i.test(text) ? 'Driver CPC'
        : (/CDL/i.test(text) ? 'CDL' : 'Driver Licence')));
  pushField(fields, 'compliance_type', type, 0.8);
  return fields;
}

function parseInspection(text, countryCode) {
  const fields = {};
  pushField(fields, 'inspection_number', labeled(text, 'certificate|cert|inspection\\s*(?:no|number)?'), 0.85);
  pushField(fields, 'inspection_expiry', firstDateNear(text, /(next\s*(?:test|inspection|due)|valid\s*(?:until|to)|expir|due)/i, countryCode), 0.9);
  const odo = String(text).match(/(?:odo(?:meter)?|mileage)\s*[:\-]?\s*([\d][\d,]{2,})/i);
  pushField(fields, 'odometer', odo ? toNumber(odo[1]) : null, 0.78);
  return fields;
}

function parseRoadLicence(text, countryCode) {
  const fields = {};
  pushField(fields, 'compliance_number', labeled(text, 'licen[cs]e|permit|road\\s*service'), 0.85);
  pushField(fields, 'compliance_expiry', firstDateNear(text, /(expir|valid\s*(?:until|to)|renew|due)/i, countryCode), 0.88);
  pushField(fields, 'compliance_type', 'Road Service Licence', 0.8);
  return fields;
}

function parseReceipt(text, family, countryCode) {
  const fields = {};
  const rows = lines(text);
  const vendorLine = rows.find((row) => row.length >= 3 && row.length <= 60 && !/^\d+$/.test(row));
  pushField(fields, 'vendor', vendorLine || null, 0.7);
  pushField(fields, 'amount', amountFrom(text), 0.88);
  pushField(fields, 'currency', detectCurrency(text), 0.85);
  pushField(fields, 'date', firstDateNear(text, /(date|time)/i, countryCode) || anyDate(text, countryCode), 0.8);

  if (family === 'receipt_fuel' || FUEL_WORDS.test(text)) {
    const litres = String(text).match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:l\b|lt\b|ltr\b|litre|liter|litres|liters)/i);
    pushField(fields, 'fuel_liters', litres ? toNumber(litres[1].replace(',', '.')) : null, 0.88);
    if (/\bfull\s*tank\b|\bfull\b/i.test(text)) pushField(fields, 'fill_type', 'full', 0.8);
    else if (/\btop[\s-]?up\b|\bpartial\b/i.test(text)) pushField(fields, 'fill_type', 'partial', 0.8);
  }

  const odo = String(text).match(/(?:odo(?:meter)?|mileage|km)\s*[:\-]?\s*([0-9][0-9,]{2,})/i);
  pushField(fields, 'odometer', odo ? toNumber(odo[1]) : null, 0.85);

  if (family === 'service_receipt') {
    const items = [...new Set((String(text).match(/\b(oil(?:\s*filter)?|air\s*filter|fuel\s*filter|brake(?:\s*pads?)?|tyres?|tires?|wheel\s*alignment|battery|coolant|spark\s*plugs?|suspension|clutch|wipers?|service|labou?r)\b/gi) || [])
      .map((item) => item.toLowerCase()))].slice(0, 6);
    pushField(fields, 'service_items', items, 0.75);
  }
  return fields;
}

function parsePurchaseInvoice(text, countryCode) {
  const fields = {};
  pushField(fields, 'purchase_cost', amountFrom(text), 0.85);
  pushField(fields, 'purchase_date', firstDateNear(text, /(date|invoice|sold|sale)/i, countryCode) || anyDate(text, countryCode), 0.8);
  const seller = String(text).match(/(?:seller|vendor|dealer|sold\s*by)\s*[:\-]?\s*([A-Za-z0-9 &.\-]{2,50})/i);
  pushField(fields, 'vendor', seller ? cleanLine(seller[1]) : lines(text)[0] || null, 0.75);
  return fields;
}

function parseOdometerPhoto(text) {
  const fields = {};
  const odo = String(text).match(/(?:odo(?:meter)?|mileage|km)\s*[:\-]?\s*([0-9][0-9,]{2,})/i)
    || String(text).match(/\b([0-9]{4,7})\b/);
  pushField(fields, 'odometer', odo ? toNumber(odo[1]) : null, 0.8);
  return fields;
}

/** Refine the Vision classifier with document families only the Lens knows. */
export function classifyDocumentFamily(text = '') {
  const base = classifyOcrDocument(text);
  const raw = String(text || '');
  if (/\b(inspection|roadworthy|road\s*worthiness|mot\s*(?:test|cert)|nct)\b/i.test(raw)) return 'inspection';
  if (/\b(road\s*service\s*licen[cs]e|transport\s*licen[cs]e|operating\s*permit|road\s*tax)\b/i.test(raw)) return 'road_licence';
  if (base === 'receipt_general' && SERVICE_WORDS.test(raw) && !FUEL_WORDS.test(raw)) return 'service_receipt';
  if (base === 'receipt_fuel' && SERVICE_WORDS.test(raw) && !FUEL_WORDS.test(raw)) return 'service_receipt';
  if (/\b(purchase\s*invoice|sale\s*agreement|sold\s*to|buyer)\b/i.test(raw) && !SERVICE_WORDS.test(raw)) return 'purchase_invoice';
  if (/\b(service|maintenance|garage|workshop)\b/i.test(raw) && /\b(invoice|total|cash|amount)\b/i.test(raw)) return 'service_receipt';
  return base;
}


/**
 * Parse a document into confirmable fields.
 * @returns {{ family: string, label: string, lane: string, fields: object, hints: object,
 *             found: string[], missing: string[], confidence: number|null }}
 */
export function parseDocumentFields(text = '', { family = null, countryCode = 'GLOBAL' } = {}) {
  const resolved = family || classifyDocumentFamily(text);
  const meta = DOCUMENT_FAMILIES[resolved] || DOCUMENT_FAMILIES.unknown;
  let fields = {};
  if (resolved === 'logbook') fields = parseLogbook(text, countryCode);
  else if (resolved === 'insurance') fields = parseInsurance(text, countryCode);
  else if (resolved === 'drivers_licence') fields = parseLicence(text, countryCode);
  else if (resolved === 'inspection') fields = parseInspection(text, countryCode);
  else if (resolved === 'road_licence') fields = parseRoadLicence(text, countryCode);
  else if (resolved === 'purchase_invoice') fields = parsePurchaseInvoice(text, countryCode);
  else if (resolved === 'odometer_photo') fields = parseOdometerPhoto(text);
  else if (resolved === 'receipt_fuel' || resolved === 'service_receipt') fields = parseReceipt(text, resolved, countryCode);

  const found = Object.keys(fields);
  const expected = expectedFieldsFor(resolved);
  const missing = expected.filter((key) => !found.includes(key));
  const confidences = found.map((key) => Number(fields[key]?.confidence) || 0);
  const confidence = confidences.length ? Math.min(...confidences) : null;

  return {
    family: resolved,
    label: meta.label,
    lane: meta.lane,
    fields,
    hints: toQuizHints(resolved, fields),
    found,
    missing,
    confidence
  };
}

export function expectedFieldsFor(family) {
  switch (family) {
    case 'logbook': return ['plate_number', 'vin', 'make_model', 'yom'];
    case 'insurance': return ['insurance_policy', 'insurance_expiry'];
    case 'drivers_licence': return ['compliance_number', 'compliance_expiry', 'compliance_type'];
    case 'inspection': return ['inspection_number', 'inspection_expiry'];
    case 'road_licence': return ['compliance_number', 'compliance_expiry'];
    case 'purchase_invoice': return ['purchase_cost'];
    case 'receipt_fuel': return ['amount', 'fuel_liters', 'odometer', 'vendor', 'date'];
    case 'service_receipt': return ['amount', 'vendor', 'date'];
    case 'odometer_photo': return ['odometer'];
    default: return [];
  }
}

/** Map Lens fields into classifier/quiz field names (mergedExt). */
export function toQuizHints(family, fields = {}) {
  const value = (key) => fields[key]?.value ?? null;
  const hints = {};
  const put = (key, val) => { if (val !== null && val !== undefined && String(val).trim() !== '') hints[key] = val; };
  if (family === 'logbook') {
    put('plate_number', value('plate_number'));
    put('vin', value('vin'));
    put('make_model', value('make_model'));
    put('yom', value('yom'));
    put('engine_number', value('engine_number'));
    put('color', value('color'));
  } else if (family === 'insurance') {
    put('insurance_policy', value('insurance_policy'));
    put('insurance_expiry', value('insurance_expiry'));
    put('insurance_premium', value('insurance_premium'));
    put('insurer', value('insurer'));
  } else if (family === 'drivers_licence' || family === 'road_licence') {
    put('compliance_number', value('compliance_number'));
    put('compliance_expiry', value('compliance_expiry'));
    put('compliance_type', value('compliance_type'));
  } else if (family === 'inspection') {
    put('inspection_number', value('inspection_number'));
    put('inspection_expiry', value('inspection_expiry'));
    put('odometer', value('odometer'));
  } else if (family === 'purchase_invoice') {
    put('purchase_cost', value('purchase_cost'));
    put('purchase_date', value('purchase_date'));
  } else if (family === 'receipt_fuel' || family === 'service_receipt') {
    put('amount', value('amount'));
    put('fuel_liters', value('fuel_liters'));
    put('odometer', value('odometer'));
    put('currency', value('currency'));
    put('notes', value('vendor'));
  } else if (family === 'odometer_photo') {
    put('odometer', value('odometer'));
  }
  return hints;
}


/** Deterministic upload hints appended to quiz questions (zero tokens). */
export const DOCUMENT_UPLOAD_HINTS = Object.freeze({
  plate_number: '📄 Tip: send a photo or PDF of your logbook and I\'ll fill the plate, VIN and year for you.',
  vin: '📄 Tip: send a photo or PDF of your logbook — I\'ll read the VIN so you don\'t have to type it.',
  make_model: '📄 Tip: your logbook photo already has the make and model — send it and I\'ll fill them in.',
  yom: '📄 Tip: send the logbook photo or PDF and I\'ll read the year of manufacture.',
  engine_number: '📄 Tip: send the logbook photo and I\'ll read the engine number.',
  insurance_expiry: '🛡️ Tip: send your insurance certificate (photo or PDF) and I\'ll read the policy and expiry.',
  insurance_policy: '🛡️ Tip: send your insurance certificate and I\'ll read the policy number.',
  inspection_expiry: '🧾 Tip: send your inspection certificate and I\'ll read the next-due date.',
  compliance_number: '🪪 Tip: send your licence or badge photo and I\'ll read the number and expiry.',
  compliance_expiry: '🪪 Tip: send your licence or badge photo and I\'ll read the expiry date.',
  amount: '🧾 Tip: send the receipt photo or PDF and I\'ll read the total, litres and odometer.',
  fuel_liters: '⛽ Tip: the receipt photo already shows the litres — send it and I\'ll fill this in.',
  odometer: '🔢 Tip: send a clear odometer or receipt photo and I\'ll read the reading.',
  purchase_cost: '🧾 Tip: send the purchase invoice (photo or PDF) and I\'ll read the amount and date.'
});

export function uploadHintFor(fieldKey) {
  return DOCUMENT_UPLOAD_HINTS[fieldKey] || null;
}

export const DOCUMENT_SUPPORT_MENU = '📄 *Send me any document — photo or PDF:*\n\n'
  + '📘 Logbook / registration certificate\n'
  + '🧾 Fuel or service receipt\n'
  + '🛡️ Insurance certificate\n'
  + '🪪 Driving licence, PSV or PDP badge\n'
  + '🔧 Inspection / roadworthiness certificate\n'
  + '🚦 Road service licence or permit\n\n'
  + 'I\'ll read it, show you what I found, and only save after you confirm.';

export default {
  DOCUMENT_FAMILIES,
  DOCUMENT_UPLOAD_HINTS,
  DOCUMENT_SUPPORT_MENU,
  classifyDocumentFamily,
  expectedFieldsFor,
  parseDocumentFields,
  toQuizHints,
  uploadHintFor
};

