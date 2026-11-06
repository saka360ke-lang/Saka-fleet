/**
 * Saka Fleet - WhatsApp media intake lane (Phase 5B-2 of the whatsapp.js split, v1.67.0).
 * --------------------------------------------------------------------------------------
 * Everything a media turn needs BEFORE the processor orchestrates a quiz or composes a
 * reply: the media envelope, the deterministic acks, the Vision/PDF OCR run, the
 * Document Lens parse, the semantic top-up, OCR telemetry, the receipt dedupe/vault and
 * the logbook prefill.
 *
 * BOUNDARY CONTRACT (section 189): media.js and hooks.js are leaf route modules that may
 * import from src/services/* (and the sibling pure helpers in ./helpers.js), but NEVER
 * from messages.js. They take state as arguments and return data. Any future addition to
 * either module must obey this rule - if a new function needs to call back into the
 * processor, it does not belong in these modules. Every send, compose and quiz decision
 * stays in the processor.
 */

import { detectCountryFromPhone } from './helpers.js';
import {
  ocrWhatsAppMedia,
  extractDocumentHints,
  isOcrEnabled,
  isOcrAckFirstEnabled,
  buildMediaAckText,
  classifyOcrDocument
} from '../../services/ocrService.js';
import { parseDocumentFields } from '../../services/documentLens.js';
import { semanticOcrTopUp } from '../../services/ocrSemantic.js';
import {
  findReceiptByMediaId,
  findRecentReceiptByTextSha,
  recordReceipt,
  uploadReceiptImage,
  OCR_CONFIRM_THRESHOLD
} from '../../services/receipts.js';
import { recordOcrRequest, buildOcrTextSha } from '../../services/ocrTelemetry.js';
import { extractEntryLabel } from '../../services/entryLabels.js';

// M2 (verbatim from messages.js v1.66.0) - the deterministic voice-note line and the
// durable transcript marker. The processor sends the reply and owns the status literal.
export const VOICE_NOTE_REPLY = '🎙️ I can\'t listen to voice notes yet — type it in and I\'ll take it from there.';
export const VOICE_NOTE_USER_TEXT = '[voice note]';

// M3 (verbatim from messages.js v1.66.0) - the unverified-media gate line. The processor
// performs the send and owns the `unverified_gated_media` status literal.
export const UNVERIFIED_MEDIA_REPLY = '🔒 Please sign up first at https://sakafleet.com — tap *Get Started Free* and verify your email, then I\'ll meet you right back here on WhatsApp.';

/**
 * M1 - the media envelope. Pure and synchronous: no I/O, no side effects.
 * WhatsApp photos and documents carry no `.text`; they are downloaded from Meta,
 * OCR'd with Google Cloud Vision, and the extracted text becomes the turn.
 */
export function resolveMediaEnvelope(messageObj) {
  const imageObj = messageObj.image || null;
  const documentObj = messageObj.document || null;
  const audioObj = messageObj.audio || null;
  const mediaObj = imageObj || documentObj;
  const mediaCaption = (imageObj?.caption || documentObj?.caption || '').trim();
  const mediaMimeType = imageObj?.mime_type || documentObj?.mime_type || null;
  // v1.61.15 - voice notes carry no text and no OCR path.
  const isVoiceNote = Boolean(audioObj && !messageObj.text?.body);
  return { imageObj, documentObj, audioObj, mediaObj, mediaCaption, mediaMimeType, isVoiceNote };
}

/**
 * M3 - the unverified-number gate decision for a media turn. Reads ONLY
 * profiles.email_verified and is fail-closed (a missing row gates). Returns
 * `{ replyText }` when gated, `null` when the turn may proceed.
 */
export async function resolveMediaGate({ supabaseClient, formattedPhoneForSession, isSuperadmin }) {
  if (!supabaseClient || isSuperadmin) return null;
  const { data: earlyProfile } = await supabaseClient
    .from('profiles')
    .select('email_verified')
    .eq('phone_number', formattedPhoneForSession)
    .maybeSingle();
  if (!earlyProfile || earlyProfile.email_verified !== true) {
    return { replyText: UNVERIFIED_MEDIA_REPLY };
  }
  return null;
}

/**
 * M4+M5 - the ack-first decision for a media turn: is OCR paused, and should Saka
 * acknowledge the upload immediately (v1.22.0 Snappy Saka: deterministic, no AI)?
 * Returns data only; the processor performs the send and the transcript writes.
 */
export function prepareMediaAck({ mediaObj, mediaMimeType }) {
  const ocrPaused = Boolean(mediaObj?.id)
    && !/pdf/i.test(String(mediaMimeType || ''))
    && !isOcrEnabled();
  let ackText = null;
  if (mediaObj?.id && !ocrPaused && isOcrAckFirstEnabled()) {
    ackText = buildMediaAckText({ mimeType: mediaMimeType });
  }
  return { ocrPaused, ackText };
}

/**
 * M6 - kick off the OCR run. Returns the promise so the processor can overlap it with
 * durable session hydration (identical concurrency to v1.66.0), plus the start
 * timestamp the telemetry row measures latency against.
 */
export function startMediaOcr({ mediaObj, mediaMimeType }) {
  const startedAt = Date.now();
  const ocrPromise = mediaObj?.id
    ? ocrWhatsAppMedia({
        mediaId: mediaObj.id,
        mimeType: mediaMimeType,
        token: process.env.META_WHATSAPP_TOKEN
      }).catch((err) => ({ text: '', error: err?.message || 'ocr_failed' }))
    : Promise.resolve({ text: '', error: null });
  return { ocrPromise, startedAt };
}

/**
 * M7-M12 - everything that happens once the OCR bytes are back: the turn text assembly
 * (including the unreadable-media system note), the deterministic family classification,
 * the confidence flag, the durable OCR telemetry row (written BEFORE the crash-prone
 * Document Lens), the lens parse, and the zero-shot semantic top-up.
 * Never throws; degrades to the raw OCR text.
 */
export async function finalizeMediaOcr({
  ocrResult,
  ocrPaused,
  ocrStartedAt,
  mediaObj,
  mediaCaption,
  mediaMimeType,
  senderPhone,
  formattedPhoneForSession,
  supabaseClient,
  messageObj
}) {
  const ocrText = (ocrResult?.text || '').trim();
  const ocrError = ocrResult?.error || null;
  if (ocrError) console.warn('[OCR] Media could not be read:', ocrError);

  const baseText = messageObj.text?.body || mediaCaption || '';
  let messageText = baseText;
  if (ocrText) {
    messageText = `${baseText ? `${baseText}\n\n` : ''}${ocrText}`.slice(0, 4000);
  } else if (mediaObj && !baseText) {
    messageText = '[Saka system note: the user sent an image/document that could not be read by OCR. Apologize ONCE with 📸 and 🙏, never claim anything was saved, and offer a clearer photo or typed details (e.g. "Logged 40L at 50350 km for KES 5500 — full tank"). If it was a PDF scan without a text layer, ask them to send the pages as photos.]';
  }

  const ocrCountry = detectCountryFromPhone(formattedPhoneForSession);

  // Safe, deterministic family classification (guarded; never throws) — used
  // for the telemetry row so a crash in the richer Document Lens below can
  // never make a media turn invisible.
  let safeKind = 'unknown';
  try { safeKind = ocrText ? classifyOcrDocument(ocrText) : 'unknown'; } catch { /* guarded */ }

  const ocrLowConfidence = Boolean(
    ocrText
    && Number.isFinite(Number(ocrResult?.confidence))
    && Number(ocrResult.confidence) > 0
    && Number(ocrResult.confidence) < OCR_CONFIRM_THRESHOLD
  );

  // v1.32.1 — OCR request telemetry (Rule 36): one durable row per media turn,
  // written BEFORE the crash-prone Document Lens parsing. A dead turn is now
  // diagnosable and countable; country_code always comes from the WhatsApp
  // number (E.164).
  const ocrTextSha = buildOcrTextSha(ocrText);
  if (mediaObj?.id) {
    const ocrStatus = ocrPaused
      ? 'paused'
      : (ocrResult?.kind === 'pdf'
        ? (ocrText ? 'pdf_text' : 'pdf_scanned')
        : (ocrText ? (ocrLowConfidence ? 'low_confidence' : 'read') : 'failed'));
    void recordOcrRequest(supabaseClient, {
      mediaId: mediaObj.id,
      phone: senderPhone,
      countryCode: ocrCountry?.country_code || null,
      mimeType: mediaMimeType,
      provider: ocrResult?.kind === 'pdf' ? 'local_pdf' : 'google_vision',
      documentKind: safeKind || null,
      status: ocrStatus,
      confidence: ocrResult?.confidence ?? null,
      attempts: ocrResult?.attempts ?? null,
      latencyMs: Math.max(0, Date.now() - ocrStartedAt),
      error: ocrError || null
    }).catch(() => {});
  }

  // v1.51.7 — Document Lens parsing is best-effort: a crash here must never
  // kill the turn (live 2026-11-02 logbook crash: "toUpperCase of undefined").
  // Degrade to the raw OCR text and let the normal turn continue.
  let lens = null;
  let ocrKind = safeKind;
  let receiptHints = {};
  try {
    lens = ocrText
      ? parseDocumentFields(ocrText, { countryCode: ocrCountry?.country_code || 'GLOBAL' })
      : null;
    ocrKind = lens?.family || safeKind;
    // Deterministic Vision hints + the richer Document Lens field map (v1.20.0).
    // v1.32.1 — the country-aware extractor wins on the keys it knows (amount,
    // vendor, policy, expiry), so a lens misread can never override a labelled
    // value (e.g. EXPIRING vs COMMENCING on an insurance certificate).
    receiptHints = ocrText
      ? {
        ...(lens?.hints || {}),
        ...extractDocumentHints(ocrText, ocrKind, { countryCode: ocrCountry?.country_code || 'GLOBAL' })
      }
      : {};
  } catch (lensErr) {
    console.warn('[OCR] Document Lens failed (degrading to raw OCR text):', lensErr?.message || lensErr);
  }

  // v1.54.1 — zero-shot extraction top-up (OCR_AI_EXTRACTION, default off).
  // The deterministic lens is ALWAYS the authority: the AI may only fill
  // fields the lens genuinely missed, every value is re-validated through
  // the country-resolved normalizers, and everything still lands in the
  // confirm-before-save gate. Any failure keeps today's behavior.
  if (lens && ocrText) {
    try {
      const semanticHints = await semanticOcrTopUp({
        text: ocrText,
        family: lens.family,
        countryCode: ocrCountry?.country_code || 'GLOBAL',
        locale: ocrCountry?.locale || null,
        existing: receiptHints
      });
      if (semanticHints && Object.keys(semanticHints).length) {
        receiptHints = { ...semanticHints, ...receiptHints };
        for (const [key, value] of Object.entries(semanticHints)) {
          lens.fields[key] = { value, confidence: 0.7, source: 'ai_topup' };
        }
        lens.found = Object.keys(lens.fields);
        lens.missing = (lens.missing || []).filter((key) => !(key in lens.fields));
      }
    } catch (semanticErr) {
      console.warn('[OCR] semantic top-up failed (deterministic hints stand):', semanticErr?.message || semanticErr);
    }
  }

  return {
    ocrText,
    ocrError,
    messageText,
    ocrCountry,
    ocrKind,
    ocrLowConfidence,
    ocrTextSha,
    receiptHints,
    lens
  };
}

/**
 * M13+M14 - the receipt intelligence block: dedupe (media id OR content hash inside the
 * OCR_DUPLICATE_WINDOW_HOURS window), the paid-tier vault upload, the receipt row, and
 * the logbook prefill for the registration quiz. Best-effort by design: the vault can
 * never fail the turn. Returns data; the processor owns every reply built from it.
 */
export async function resolveReceiptVault({
  supabaseClient,
  mediaObj,
  ocrPaused,
  ocrKind,
  ocrText,
  ocrTextSha,
  ocrLowConfidence,
  ocrResult,
  ocrError,
  receiptHints,
  countryInfo,
  entitlements,
  profileData,
  existingVehicles,
  currentActiveVehicle,
  messageText,
  ocrCountry
}) {
  let duplicateReceipt = null;
  if (mediaObj?.id && supabaseClient && !ocrPaused && (ocrKind === 'receipt_fuel' || ocrKind === 'receipt_general')) {
    try {
      // v1.32.1 — a re-uploaded document gets a NEW WhatsApp media id, so
      // content matching (text hash, 48 h) is what actually stops the
      // second quiz/expense. Media-id matching stays for Meta retries.
      duplicateReceipt = await findReceiptByMediaId(supabaseClient, mediaObj.id)
        || await findRecentReceiptByTextSha(supabaseClient, {
          textSha: ocrTextSha,
          windowHours: Number(process.env.OCR_DUPLICATE_WINDOW_HOURS || 48)
        });
      if (!duplicateReceipt) {
        // v1.23.1 - Free tier keeps the parsed data but NOT the document (no bucket upload without receiptVaultStorage).
        const vaultAllowed = entitlements?.receiptVaultStorage !== false;
        const imageUrl = vaultAllowed && ocrResult?.buffer
          ? await uploadReceiptImage(supabaseClient, ocrResult.buffer, mediaObj.id, ocrResult.mimeType)
          : null;
        await recordReceipt(supabaseClient, {
          mediaId: mediaObj.id,
          ownerId: existingVehicles.some((v) => v.owner_id === profileData?.id) ? profileData?.id : null,
          driverId: existingVehicles.some((v) => v.assigned_driver_id === profileData?.id) ? profileData?.id : null,
          vehicleId: currentActiveVehicle?.id || existingVehicles[0]?.id || null,
          documentKind: ocrKind || 'unknown',
          status: ocrText ? (ocrLowConfidence ? 'low_confidence' : 'read') : 'failed',
          confidence: ocrResult?.confidence ?? null,
          currency: receiptHints.currency || countryInfo?.currency || null,
          amount: receiptHints.amount ?? null,
          fuelLiters: receiptHints.fuel_liters ?? null,
          odometer: receiptHints.odometer ?? null,
          // v1.32.4 — the vendor column carried the raw OCR notes line
          // ("Shell Thika|Diesel"), so receipts printed junk. `vendor` is
          // the real merchant (ocrService.extractDocumentHints).
          vendor: receiptHints.vendor || null,
          imageUrl,
          textSha: ocrTextSha,
          // v1.59.7 — a receipt can carry its own searchable label.
          label: extractEntryLabel(messageText),
          error: ocrError
        });
      }
    } catch { /* the receipt vault is best-effort */ }
  }

  // v1.51.11 — a registration certificate (logbook) is a registration
  // document, never a receipt. Extract the vehicle fields so the
  // registration quiz can be prefilled and confirmed.
  let logbookPrefill = null;
  if (mediaObj?.id && ocrKind === 'logbook' && ocrText) {
    try {
      const lbHints = extractDocumentHints(ocrText, 'logbook', { countryCode: ocrCountry?.country_code || 'GLOBAL' });
      const picked = {};
      for (const key of ['plate_number', 'vin', 'make_model', 'yom', 'fuel_type', 'engine_number', 'color']) {
        if (lbHints?.[key] !== undefined && lbHints[key] !== null && String(lbHints[key]).trim() !== '') picked[key] = lbHints[key];
      }
      if (Object.keys(picked).length > 0) logbookPrefill = picked;
    } catch { /* best-effort */ }
  }

  return { duplicateReceipt, logbookPrefill };
}

