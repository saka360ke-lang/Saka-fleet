/**
 * Saka Fleet — OCR Service
 * ------------------------
 * WhatsApp photos/documents are downloaded from Meta's Graph API and read with
 * Google Cloud Vision (DOCUMENT_TEXT_DETECTION). DeepSeek-V3 is text-only, so
 * OCR is the bridge that lets Saka understand receipts, logbooks and odometer
 * photos.
 *
 * Design rules:
 *  - No new npm dependency: Meta + Vision are called through the global fetch.
 *  - Never throws: every failure returns { text: null, error } so the chat turn
 *    can degrade gracefully.
 *  - Hard timeouts and size limits protect the message queue.
 */

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v17.0';
const MAX_MEDIA_BYTES = Number(process.env.OCR_MAX_MEDIA_BYTES || 5 * 1024 * 1024);
const FETCH_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 15000);

export const SUPPORTED_IMAGE_TYPES = Object.freeze([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp'
]);

function timeoutSignal(ms = FETCH_TIMEOUT_MS) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

function metaHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    // Meta requires a curl-like User-Agent for media downloads.
    'User-Agent': 'curl/8.0.0'
  };
}

/**
 * Step 1: resolve the media metadata and download the binary from Meta.
 * Meta exposes GET /{media-id} → { url, mime_type, file_size }, then the binary
 * must be fetched from that URL with the same bearer token.
 */
export async function downloadWhatsAppMedia(mediaId, token = process.env.META_WHATSAPP_TOKEN) {
  if (!mediaId) return { buffer: null, mimeType: null, error: 'Missing media id' };
  if (!token) return { buffer: null, mimeType: null, error: 'META_WHATSAPP_TOKEN not configured' };

  try {
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      method: 'GET',
      headers: metaHeaders(token),
      signal: timeoutSignal()
    });

    if (!metaRes.ok) {
      return { buffer: null, mimeType: null, error: `Meta media lookup failed (HTTP ${metaRes.status})` };
    }

    const contentType = metaRes.headers.get('content-type') || '';

    // Some Graph responses stream the binary directly.
    if (!contentType.includes('application/json')) {
      const buffer = Buffer.from(await metaRes.arrayBuffer());
      if (buffer.length > MAX_MEDIA_BYTES) return { buffer: null, mimeType: contentType, error: 'Media exceeds size limit' };
      return { buffer, mimeType: contentType.split(';')[0], error: null };
    }

    const meta = await metaRes.json();
    if (Number(meta.file_size) > MAX_MEDIA_BYTES) {
      return { buffer: null, mimeType: meta.mime_type || null, error: 'Media exceeds size limit' };
    }
    if (!meta.url) return { buffer: null, mimeType: meta.mime_type || null, error: 'Meta did not return a media URL' };

    const binRes = await fetch(meta.url, {
      method: 'GET',
      headers: metaHeaders(token),
      signal: timeoutSignal()
    });
    if (!binRes.ok) {
      return { buffer: null, mimeType: meta.mime_type || null, error: `Media download failed (HTTP ${binRes.status})` };
    }

    const buffer = Buffer.from(await binRes.arrayBuffer());
    if (buffer.length > MAX_MEDIA_BYTES) return { buffer: null, mimeType: meta.mime_type || null, error: 'Media exceeds size limit' };

    return { buffer, mimeType: meta.mime_type || contentType.split(';')[0], error: null };
  } catch (err) {
    return { buffer: null, mimeType: null, error: `Media download error: ${err.message}` };
  }
}

/**
 * Step 2: OCR an image buffer with Google Cloud Vision.
 * Auth: GCP_VISION_API_KEY (preferred on Cloud Run) — never logged.
 */
export async function extractTextFromImage(buffer) {
  if (!buffer) return { text: null, confidence: null, error: 'No image buffer' };

  const apiKey = process.env.GCP_VISION_API_KEY;
  if (!apiKey) return { text: null, confidence: null, error: 'GCP_VISION_API_KEY not configured' };

  const endpoint = process.env.GCP_VISION_ENDPOINT || 'https://vision.googleapis.com/v1/images:annotate';

  const requestBody = {
    requests: [{
      image: { content: Buffer.from(buffer).toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
    }]
  };

  try {
    const res = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: timeoutSignal()
    });

    let data = null;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      const message = data?.error?.message || `Vision API failed (HTTP ${res.status})`;
      return { text: null, confidence: null, error: message };
    }

    const response = data?.responses?.[0];
    if (response?.error?.message) {
      return { text: null, confidence: null, error: response.error.message };
    }

    const text = response?.fullTextAnnotation?.text
      || response?.textAnnotations?.[0]?.description
      || null;

    const confidence = response?.fullTextAnnotation?.pages?.[0]?.confidence ?? null;
    return { text: text ? text.trim() : null, confidence, error: null };
  } catch (err) {
    return { text: null, confidence: null, error: `Vision request error: ${err.message}` };
  }
}

/**
 * End-to-end: download a WhatsApp media object and OCR it.
 * PDFs are intentionally rejected in v1 (Vision needs async batch for PDFs).
 */
export async function ocrWhatsAppMedia({ mediaId, mimeType, token } = {}) {
  const normalizedType = (mimeType || '').toLowerCase().split(';')[0];

  if (normalizedType && !SUPPORTED_IMAGE_TYPES.includes(normalizedType)) {
    return {
      text: null,
      confidence: null,
      mimeType: normalizedType,
      error: 'Unsupported media type — please resend as a JPEG or PNG photo 📸.'
    };
  }

  const download = await downloadWhatsAppMedia(mediaId, token);
  if (!download.buffer) return { text: null, confidence: null, mimeType: normalizedType || null, error: download.error };

  const effectiveType = (download.mimeType || normalizedType || 'image/jpeg').toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.includes(effectiveType)) {
    return { text: null, confidence: null, mimeType: effectiveType, error: 'Unsupported media type — please resend as a JPEG or PNG photo 📸.' };
  }

  const ocr = await extractTextFromImage(download.buffer);
  return { ...ocr, mimeType: effectiveType, buffer: download.buffer };
}

function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const num = Number(String(raw).replace(/[,\s]/g, ''));
  return Number.isFinite(num) ? num : null;
}

/**
 * Deterministic receipt/logbook hints extracted from OCR text. These prefill
 * the conversational quiz (which still requires the user to confirm).
 */
export function extractReceiptHints(text = '') {
  return extractDocumentHints(text, classifyOcrDocument(text), { receiptOnly: true });
}

/** Detect the document family from OCR text (deterministic). */
export function classifyOcrDocument(text = '') {
  const raw = String(text || '');
  const t = raw.toUpperCase();
  if (!t.trim()) return 'unknown';
  if (/\b(VIN|CHASSIS|LOG\s?BOOK|REGISTRATION\s+CERT|MOTOR\s+VEHICLE\s+REG)/.test(t) || looksLikeVin(raw)) return 'logbook';
  if (/\b(POLICY|INSURANCE|COVER\s+NOTE|SUM\s+INSURED|UNDERWRITER)\b/.test(t)) return 'insurance';
  if (/\b(DRIVING\s+LICEN[CS]E|DRIVER'?S\s+LICEN[CS]E|PSV|PDP|DL\s*(?:NO|NUMBER)|BADGE)\b/.test(t)) return 'drivers_licence';
  if (/\b(FUEL|DIESEL|PETROL|GASOLINE|PUMP|NOZZLE|LITRE|LITER)\b/.test(t)) return 'receipt_fuel';
  if (/\b(ODOMETER|MILEAGE|KM\s*READING)\b/.test(t) && !/\b(TOTAL|CASH|AMOUNT|INVOICE)\b/.test(t)) return 'odometer_photo';
  if (/\b(RECEIPT|INVOICE|TOTAL|AMOUNT|CASH|BALANCE)\b/.test(t)) return 'receipt_general';
  return 'unknown';
}

function looksLikeVin(text) {
  return /\b(?=[A-HJ-NPR-Z0-9]{11,17}\b)(?=[A-Z0-9]*\d)[A-HJ-NPR-Z0-9]{11,17}\b/.test(String(text || '').toUpperCase());
}

export const OCR_CURRENCY_CODES = Object.freeze(['KES', 'USD', 'EUR', 'GBP', 'NGN', 'ZAR', 'TZS', 'UGX', 'RWF', 'INR', 'AED', 'BRL', 'MXN']);
const CURRENCY_SYMBOLS = Object.freeze({ '₹': 'INR', $: 'USD', '€': 'EUR', '£': 'GBP', '₦': 'NGN' });

function detectCurrency(raw) {
  const text = String(raw || '');
  for (const code of OCR_CURRENCY_CODES) {
    if (new RegExp(`\\b${code}\\b`, 'i').test(text)) return code;
  }
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) return code;
  }
  return null;
}

function firstDateNear(raw, keywordRe) {
  const lines = String(raw || '').split(/\n+/);
  const hit = lines.find((line) => keywordRe.test(line));
  const dateMatch = (hit || raw).match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/);
  return dateMatch ? dateMatch[1] : null;
}


/**
 * Rich document hints for every supported photo type. Numbers are deterministic
 * and always land in the confirmation gate before any database write.
 */
export function extractDocumentHints(text = '', kind = null, { receiptOnly = false } = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return {};
  const documentKind = kind || classifyOcrDocument(raw);
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);

  const moneyRe = /(?:kes|usd|ngn|zar|tzs|ugx|rwf|gbp|eur|inr|aed|brl|mxn|\$|€|£|₦|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
  const toNumber = (value) => {
    const num = Number(String(value).replace(/[,\s]/g, ''));
    return Number.isFinite(num) ? num : null;
  };
  const amountFrom = (line) => {
    const matches = [...String(line).matchAll(moneyRe)];
    if (!matches.length) return null;
    const values = matches.map((match) => toNumber(match[1])).filter((num) => num !== null && num > 0);
    return values.length ? Math.max(...values) : null;
  };

  const totalLine = lines.find((line) => /\b(total|amount due|grand total|balance due)\b/i.test(line));
  let amount = totalLine ? amountFrom(totalLine) : null;
  if (amount === null && !receiptOnly) {
    const all = [...raw.matchAll(moneyRe)].map((match) => toNumber(match[1])).filter((num) => num !== null && num > 0);
    if (all.length) amount = Math.max(...all);
  }

  const litersMatch = raw.match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:l\b|lt\b|ltr\b|litre|liter|litres|liters)/i);
  const fuelLiters = litersMatch ? toNumber(litersMatch[1]) : null;
  const odoMatch = raw.match(/(?:odo|odometer|mileage|km)\s*[:\-]?\s*([0-9][0-9,]{2,})/i);
  const odometer = odoMatch ? toNumber(odoMatch[1]) : null;
  const date = firstDateNear(raw, /(date|time)/i)
    || (raw.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/) || [])[1]
    || null;
  const vendor = lines[0] && lines[0].length <= 60 ? lines[0] : null;
  const pumpMatch = raw.match(/\b(?:pump|nozzle)\s*(?:no\.?|#)?\s*(\d{1,3})\b/i);
  const currency = detectCurrency(raw);

  const hints = { document_kind: documentKind };
  if (amount !== null) hints.amount = amount;
  if (currency) hints.currency = currency;
  if (fuelLiters !== null) hints.fuel_liters = fuelLiters;
  if (odometer !== null) hints.odometer = odometer;

  const noteParts = [];
  if (documentKind === 'receipt_fuel') hints.expense_type = 'Fuel';
  if (vendor) noteParts.push(vendor);
  if (date) noteParts.push(date);
  if (pumpMatch) noteParts.push(`Pump ${pumpMatch[1]}`);
  if (noteParts.length) hints.notes = noteParts.join(' | ');

  if (documentKind === 'logbook') {
    const plateMatch = raw.match(/\b(?:reg(?:istration)?\s*(?:no|number)?|plate)\s*[:\-#]?\s*([A-Z]{1,4}\s?\d{1,4}[A-Z]{0,3})\b/i)
      || raw.match(/\b([A-Z]{2,3}\s?\d{2,4}\s?[A-Z]{1,3})\b/);
    const vinMatch = raw.match(/\b(?=[A-HJ-NPR-Z0-9]{11,17}\b)(?=[A-Z0-9]*\d)[A-HJ-NPR-Z0-9]{11,17}\b/i);
    if (plateMatch) hints.plate_number = plateMatch[1].toUpperCase().replace(/\s+/g, ' ').trim();
    if (vinMatch) hints.vin = vinMatch[0].toUpperCase();
  }

  if (documentKind === 'insurance') {
    const policy = raw.match(/\b(?:policy|cover(?:\s+note)?)\s*(?:no\.?|number|#)?\s*[:\-#]?\s*((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{3,})/i);
    if (policy) hints.insurance_policy = policy[1];
    const expiry = firstDateNear(raw, /(expir|valid\s+(?:until|to)|renew|due)/i);
    if (expiry) hints.insurance_expiry = expiry;
  }

  if (documentKind === 'drivers_licence') {
    const licence = raw.match(/\b(?:licen[cs]e|lic|dl|psv|pdp|badge)\s*(?:no\.?|number|#)?\s*[:\-#]?\s*((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{3,})/i);
    if (licence) hints.compliance_number = licence[1];
    const expiry = firstDateNear(raw, /(expir|valid\s+(?:until|to)|renew|due)/i);
    if (expiry) hints.compliance_expiry = expiry;
    hints.compliance_type = /PSV/i.test(raw) ? 'PSV Badge' : (/PDP/i.test(raw) ? 'PDP' : 'Driver Licence');
  }

  if (documentKind === 'odometer_photo' && odometer === null) {
    const lone = raw.match(/\b([0-9]{4,7})\b/);
    if (lone) hints.odometer = toNumber(lone[1]);
  }

  return hints;
}


export default {
  downloadWhatsAppMedia,
  extractTextFromImage,
  ocrWhatsAppMedia,
  extractReceiptHints,
  extractDocumentHints,
  classifyOcrDocument,
  OCR_CURRENCY_CODES,
  SUPPORTED_IMAGE_TYPES
};
