import { extractPdfText } from './pdfTextExtractor.js';

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

// v1.19.2: Vision gets its own, more generous budget. Dense certificate scans
// (registration cards, insurance policies) routinely need more than 15 seconds,
// and the shared timeout aborted 3 of 4 real document reads on 2026-10-30.
const rawVisionTimeout = Number(process.env.OCR_VISION_TIMEOUT_MS || 25000);
export const OCR_VISION_TIMEOUT_MS = Number.isFinite(rawVisionTimeout) && rawVisionTimeout > 0
  ? rawVisionTimeout
  : 25000;
const rawVisionAttempts = Number(process.env.OCR_VISION_MAX_ATTEMPTS || 2);
export const OCR_VISION_MAX_ATTEMPTS = Number.isFinite(rawVisionAttempts)
  ? Math.max(1, Math.min(3, rawVisionAttempts))
  : 2;

// v1.32.1 — HEIC/HEIF added: iPhone default capture format, read natively by
// Google Vision. Global audience must not be turned away by a phone's codec.
export const SUPPORTED_IMAGE_TYPES = Object.freeze([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
]);

/** v1.28.8 — Vision OCR is ON by default (testing phase); OCR_ENABLED=off pauses it. */
export function isOcrEnabled() {
  // v1.23.1 hard-paused photo OCR in code; v1.28.8 restores the env-driven
  // switch so receipts, logbooks and odometer photos are read again. PDFs keep
  // using the local text extractor (no provider call).
  return !/^(?:off|false|0)$/i.test(String(process.env.OCR_ENABLED || 'on'));
}

/** Re-enabled OCR answers instantly with an ack, then delivers the result. */
export function isOcrAckFirstEnabled() {
  return !/^(?:off|false|0)$/i.test(String(process.env.OCR_ACK_FIRST || 'on'));
}

export function buildMediaAckText({ mimeType = null } = {}) {
  const isPdf = String(mimeType || '').toLowerCase().includes('pdf');
  return isPdf
    ? '📄 Reading your PDF now — I\'ll reply with what I find in a moment.'
    : '📸 Reading your photo now — I\'ll reply with what I find in a moment.';
}

function timeoutSignal(ms = FETCH_TIMEOUT_MS) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

/** Abort/timeout detection — only these failures are worth a retry. */
function isTimeoutError(err) {
  const name = String(err?.name || '');
  const message = String(err?.message || '');
  return name === 'AbortError'
    || name === 'TimeoutError'
    || /aborted due to timeout|timed? ?out/i.test(message);
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
  if (!buffer) return { text: null, confidence: null, error: 'No image buffer', attempts: 0 };

  const apiKey = process.env.GCP_VISION_API_KEY;
  if (!apiKey) return { text: null, confidence: null, error: 'GCP_VISION_API_KEY not configured', attempts: 0 };

  const endpoint = process.env.GCP_VISION_ENDPOINT || 'https://vision.googleapis.com/v1/images:annotate';

  const requestBody = {
    requests: [{
      image: { content: Buffer.from(buffer).toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
    }]
  };

  let attempts = 0;
  let lastError = null;

  // v1.19.2: document photos are retried ONCE on an abort/timeout. Vision
  // annotate is idempotent, so a second attempt is safe, and plain HTTP or
  // credential errors are returned immediately (never retried).
  while (attempts < OCR_VISION_MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const res = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: timeoutSignal(OCR_VISION_TIMEOUT_MS)
      });

      let data = null;
      try { data = await res.json(); } catch { data = null; }

      if (!res.ok) {
        const message = data?.error?.message || `Vision API failed (HTTP ${res.status})`;
        return { text: null, confidence: null, error: message, attempts };
      }

      const response = data?.responses?.[0];
      if (response?.error?.message) {
        return { text: null, confidence: null, error: response.error.message, attempts };
      }

      const text = response?.fullTextAnnotation?.text
        || response?.textAnnotations?.[0]?.description
        || null;

      if (!text || !String(text).trim()) {
        // Vision answered 200 with nothing readable — keep the reason explicit
        // so receipts.error is never blank and support can diagnose it.
        return { text: null, confidence: null, error: 'No text detected in the document', attempts };
      }

      const confidence = response?.fullTextAnnotation?.pages?.[0]?.confidence ?? null;
      return { text: String(text).trim(), confidence, error: null, attempts };
    } catch (err) {
      lastError = `Vision request error: ${err.message}`;
      if (!isTimeoutError(err)) break;
      // Timeout/abort → one more attempt while budget allows.
    }
  }

  return { text: null, confidence: null, error: lastError || 'Vision request failed', attempts };
}

/**
 * End-to-end: download a WhatsApp media object and OCR it.
 * PDFs are intentionally rejected in v1 (Vision needs async batch for PDFs).
 */
export async function ocrWhatsAppMedia({ mediaId, mimeType, token } = {}) {
  const normalizedType = (mimeType || '').toLowerCase().split(';')[0];
  const declaredPdf = normalizedType === 'application/pdf';

  if (normalizedType && !SUPPORTED_IMAGE_TYPES.includes(normalizedType) && !declaredPdf) {
    return {
      text: null,
      confidence: null,
      mimeType: normalizedType,
      error: 'Unsupported media type — please resend as a JPEG or PNG photo 📸.'
    };
  }

  // v1.22.0 — Vision kill switch. PDFs stay enabled: the local text extractor
  // is fast and never blocks on a provider. Photo turns answer instantly.
  if (!declaredPdf && !isOcrEnabled()) {
    return {
      text: null,
      confidence: null,
      mimeType: normalizedType || null,
      error: 'OCR paused by configuration',
      skipped: true,
      kind: 'skipped'
    };
  }

  const download = await downloadWhatsAppMedia(mediaId, token);
  if (!download.buffer) return { text: null, confidence: null, mimeType: normalizedType || null, error: download.error };

  const effectiveType = (download.mimeType || normalizedType || 'image/jpeg').toLowerCase();

  // v1.20.0 — PDFs are first-class: extract the text layer locally (zero
  // dependency). Scanned PDFs return a clear "send pages as photos" reason.
  if (declaredPdf || effectiveType === 'application/pdf') {
    const pdf = extractPdfText(download.buffer);
    return { ...pdf, confidence: null, mimeType: 'application/pdf', buffer: download.buffer, kind: 'pdf' };
  }
  if (!SUPPORTED_IMAGE_TYPES.includes(effectiveType)) {
    return { text: null, confidence: null, mimeType: effectiveType, error: 'Unsupported media type — please resend as a JPEG or PNG photo 📸.' };
  }

  const ocr = await extractTextFromImage(download.buffer);
  return { ...ocr, mimeType: effectiveType, buffer: download.buffer, kind: 'image' };
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

/**
 * Detect the document family from OCR text (deterministic).
 *
 * v1.32.1 — STRONG insurance markers win over bare CHASSIS/VIN. Every motor
 * insurance certificate prints the registration + chassis number, so the older
 * order filed insurance certificates as logbooks (live evidence 2026-11-01).
 * A logbook is only claimed when no insurance wording is present.
 */
export function classifyOcrDocument(text = '') {
  const raw = String(text || '');
  const t = raw.toUpperCase();
  if (!t.trim()) return 'unknown';
  if (/\b(CERTIFICATE\s+OF\s+INSURANCE|POLICY\s+HOLDER|POLICY\s+(?:NO|NUMBER)|COMMENCING\s+DATE|COVER\s+NOTE|SUM\s+INSURED|UNDERWRITER|ISSUED\s+BY)\b/.test(t)
    || /\bEXPIR(?:Y|ING|ES)\b/.test(t) && /\bPOLICY\b/.test(t)) return 'insurance';
  if (/\b(VIN|CHASSIS|LOG\s?BOOK|REGISTRATION\s+CERT|MOTOR\s+VEHICLE\s+REG)/.test(t) || looksLikeVin(raw)) return 'logbook';
  if (/\b(POLICY|INSURANCE|COVER\s+NOTE|SUM\s+INSURED|UNDERWRITER)\b/.test(t)) return 'insurance';
  if (/\b(DRIVING\s+LICEN[CS]E|DRIVER'?S\s+LICEN[CS]E|PSV|PDP|DL\s*(?:NO|NUMBER)|BADGE)\b/.test(t)) return 'drivers_licence';
  if (/\b(FUEL|DIESEL|PETROL|GASOLINE|PUMP|NOZZLE|LITRE|LITER)\b/.test(t)) return 'receipt_fuel';
  if (/\b(ODOMETER|MILEAGE|KM\s*READING)\b/.test(t) && !/\b(TOTAL|CASH|AMOUNT|INVOICE)\b/.test(t)) return 'odometer_photo';
  if (/\b(RECEIPT|INVOICE|TOTAL|AMOUNT|CASH|BALANCE)\b/.test(t)) return 'receipt_general';
  return 'unknown';
}

/**
 * VIN-shaped tokens only. KRA tax PINs (e.g. P051141264M) and fiscal serials
 * are stripped first — an insurance/fuel certificate must never look like a
 * logbook (v1.32.1, live 2026-11-01).
 */
function looksLikeVin(text) {
  const cleaned = String(text || '').toUpperCase()
    .replace(/\b(?:BUYER\s+)?PIN\s*[:#]?\s*[A-Z0-9]+/g, ' ')
    .replace(/\bP\d{9}[A-Z]\b/g, ' ');
  return /\b(?=[A-HJ-NPR-Z0-9]{11,17}\b)(?=[A-Z0-9]*\d)[A-HJ-NPR-Z0-9]{11,17}\b/.test(cleaned);
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

/* ------------------------------------------------------------------ */
/* Country receipt profiles (v1.32.1 — Rule 36)                        */
/*                                                                     */
/* Country-specific fiscal-receipt structures live ONLY inside their   */
/* own profile. The universal path below never assumes a country.      */
/* ------------------------------------------------------------------ */

const LEGAL_RECEIPT_MARKER_RE = /\b(?:START|END)\s+OF\s+LEGAL\s+RECEIPT\b|\bFISCAL\s+RECEIPT\b|\*{3}/i;

/** True when the text carries Kenya e-TIMS (KRA fiscal receipt) markers. */
export function isKenyaEtimesText(text = '') {
  return /\b(?:LEGAL\s+RECEIPT|FISCAL\s+RECEIPT|KRA\s*\/?\s*ETI|BUYER\s+PIN|ETIMS)\b/i.test(String(text || ''));
}

/**
 * Normalise an OCR numeric token. Grouped values ("3,000.00") parse; ambiguous
 * OCR noise ("3.000.00") returns null — Saka never guesses a wrong figure.
 */
function normalizeOcrNumber(raw) {
  const token = String(raw || '').replace(/\s/g, '');
  if (!token) return null;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(token) || /^\d+(?:\.\d{1,2})?$/.test(token) || /^\d{3,}$/.test(token)) {
    return toNumber(token.replace(/,/g, ''));
  }
  return null;
}

/**
 * Kenya e-TIMS profile: merchant line after the legal marker, TOTAL/CASH amount
 * (the figure often sits on the FOLLOWING line), and litres from a
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
    const sameLine = normalizeOcrNumber((line.match(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2})/) || [])[1]);
    if (sameLine !== null && sameLine > 0) { hints.amount = sameLine; break; }
    for (let k = 1; k <= 2 && i + k < lines.length; k += 1) {
      const next = lines[i + k];
      if (!next || /%|\bTAX\b|\bNET\b/i.test(next)) continue;
      const value = normalizeOcrNumber((next.match(/^(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2})$/) || [])[1]);
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
      const qty = normalizeOcrNumber(pair[1]);
      if (qty !== null && qty > 0 && qty <= 500) { hints.fuel_liters = qty; break; }
    }
  }

  return hints;
}



/**
 * Rich document hints for every supported photo type. Numbers are deterministic
 * and always land in the confirmation gate before any database write.
 */
export function extractDocumentHints(text = '', kind = null, { receiptOnly = false, countryCode = 'GLOBAL' } = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return {};
  const documentKind = kind || classifyOcrDocument(raw);
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  // v1.32.1 — Rule 36: country profiles are resolved from the caller's
  // country (WhatsApp number) and never leak into the universal path.
  const isKenya = String(countryCode || 'GLOBAL').toUpperCase() === 'KE';
  const etimesHints = isKenya && isKenyaEtimesText(raw) ? extractKenyaEtimesHints(raw, lines) : null;

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
  // v1.32.1 — a bare "TOTAL" label with the figure on the next line is common
  // in every market (e-TIMS included). VAT breakdown rows are never amounts.
  if (amount === null && totalLine) {
    const idx = lines.indexOf(totalLine);
    for (let k = 1; k <= 2 && idx >= 0 && idx + k < lines.length; k += 1) {
      const row = lines[idx + k];
      if (/%|\bTAX\b|\bNET\b/i.test(row)) continue;
      const bare = normalizeOcrNumber((row.match(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2})/) || [])[1]);
      if (bare !== null && bare > 0) { amount = bare; break; }
    }
  }
  if (amount === null && etimesHints?.amount) amount = etimesHints.amount;
  if (amount === null && !receiptOnly) {
    const all = [...raw.matchAll(moneyRe)].map((match) => toNumber(match[1])).filter((num) => num !== null && num > 0);
    if (all.length) amount = Math.max(...all);
  }

  const litersMatch = raw.match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:l\b|lt\b|ltr\b|litre|liter|litres|liters)/i);
  let fuelLiters = litersMatch ? toNumber(litersMatch[1]) : null;
  if (fuelLiters === null && etimesHints?.fuel_liters) fuelLiters = etimesHints.fuel_liters;
  const odoMatch = raw.match(/(?:odo|odometer|mileage|km)\s*[:\-]?\s*([0-9][0-9,]{2,})/i);
  const odometer = odoMatch ? toNumber(odoMatch[1]) : null;
  const date = firstDateNear(raw, /(date|time)/i)
    || (raw.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/) || [])[1]
    || null;
  // v1.32.1 — never treat a legal-receipt marker line as the merchant name.
  const firstLine = lines[0] || '';
  let vendor = firstLine && firstLine.length <= 60 && !LEGAL_RECEIPT_MARKER_RE.test(firstLine) ? firstLine : null;
  if (!vendor && etimesHints?.vendor) vendor = etimesHints.vendor;
  const pumpMatch = raw.match(/\b(?:pump|nozzle)\s*(?:no\.?|#)?\s*(\d{1,3})\b/i);
  const currency = detectCurrency(raw) || (etimesHints ? 'KES' : null);

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
    // v1.32.1 — accept "CERTIFICATE OF INSURANCE No:" labels too (Kenyan motor
    // certificates print the certificate number first, the policy number later).
    const policy = raw.match(/\b(?:policy|cover(?:\s+note)?|certificate(?:\s+of\s+insurance)?)\s*(?:no\.?|number|#)?\s*[:\-#]?\s*((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{3,})/i);
    if (policy) hints.insurance_policy = policy[1];
    // Expiry is read from the EXPIRING/VALID UNTIL label first — a certificate
    // also prints a COMMENCING date, which must never become the expiry.
    const expiry = (raw.match(/\b(?:expir\w*|valid\s+(?:until|to))\s*[:]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i) || [])[1]
      || firstDateNear(raw, /(expir|valid\s+(?:until|to)|renew|due)/i);
    if (expiry) hints.insurance_expiry = expiry;
    if (hints.insurance_policy) {
      hints.notes = [hints.notes, `Policy ${hints.insurance_policy}`].filter(Boolean).join(' | ');
    }
  }

  if (documentKind === 'drivers_licence') {
    const licence = raw.match(/\b(?:licen[cs]e|lic|dl|psv|pdp|badge)\s*(?:no\.?|number|#)?\s*[:\-#]?\s*((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{3,})/i);
    if (licence) hints.compliance_number = licence[1];
    const expiry = (raw.match(/\b(?:expir\w*|valid\s+(?:until|to))\s*[:]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i) || [])[1]
      || firstDateNear(raw, /(expir|valid\s+(?:until|to)|renew|due)/i);
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
  OCR_VISION_TIMEOUT_MS,
  OCR_VISION_MAX_ATTEMPTS,
  isOcrEnabled,
  isOcrAckFirstEnabled,
  buildMediaAckText,
  SUPPORTED_IMAGE_TYPES
};
