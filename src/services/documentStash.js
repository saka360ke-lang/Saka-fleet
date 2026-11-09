/**
 * Saka Fleet — Pre-vehicle document stash (v1.93.0, Phase 30 Task 3)
 * -----------------------------------------------------------------
 * A compliance document can arrive BEFORE the asset it belongs to exists (the
 * logbook photo sent during registration). Instead of discarding it, the media
 * turn stashes its metadata on the session and the registration completion files
 * it under the new vehicle.
 *
 * Durability contract (D3): the metadata is JSON-safe and rides `chat_sessions`;
 * the raw media buffer is TRANSIENT and is stripped before every snapshot write
 * (sessionStore.stripTransientSessionFields). On a cold instance the replay
 * re-downloads the media from Meta once; if that fails the user is asked to
 * re-send — nothing is ever invented.
 */

import { vaultVehicleDocument, documentTypeForFamily } from './vehicleDocuments.js';
import { downloadWhatsAppMedia } from './ocrService.js';
import { LOGBOOK_UPLOAD_COPY } from './flowKnowledge.js';

/** The stash lives as long as the durable session snapshot (24 h). */
export const DOCUMENT_STASH_TTL_MS = 24 * 60 * 60 * 1000;

/** Build the JSON-safe stash (the buffer is transient; never persisted). */
export function buildDocumentStash({
  mediaId = null,
  mimeType = 'image/jpeg',
  family = 'other',
  filename = null,
  buffer = null,
  now = Date.now()
} = {}) {
  if (!mediaId) return null;
  return {
    mediaId: String(mediaId),
    mimeType: mimeType || 'image/jpeg',
    family: family || 'other',
    filename: filename || null,
    buffer: buffer || null,
    at: new Date(now).toISOString(),
    expiresAt: new Date(now + DOCUMENT_STASH_TTL_MS).toISOString()
  };
}

/** A stash without a readable, future expiry is expired (fail-safe). */
export function isDocumentStashExpired(stash, now = Date.now()) {
  if (!stash) return true;
  const expiry = Date.parse(stash.expiresAt || '');
  return !Number.isFinite(expiry) || expiry <= now;
}

/**
 * File a stashed document under the asset that now exists. Best-effort and
 * never throws. Returns `{ ok, reason, line }` where `line` is the engine copy
 * the completion card appends (warm, honest, one next step).
 */
export async function replayDocumentStash({
  supabase = null,
  vehicleId = null,
  profileId = null,
  stash = null,
  entitlements = null,
  label = null,
  downloadMedia = downloadWhatsAppMedia,
  now = Date.now()
} = {}) {
  if (!stash?.mediaId || !vehicleId) return { ok: false, reason: 'no-stash', line: null };
  if (isDocumentStashExpired(stash, now)) {
    return { ok: false, reason: 'expired', line: LOGBOOK_UPLOAD_COPY.expired };
  }
  let buffer = stash.buffer || null;
  if (!buffer) {
    try {
      const downloaded = await downloadMedia(stash.mediaId);
      buffer = downloaded?.buffer || null;
    } catch {
      buffer = null;
    }
  }
  if (!buffer) return { ok: false, reason: 'download-failed', line: LOGBOOK_UPLOAD_COPY.expired };
  const vaulted = await vaultVehicleDocument({
    supabase,
    vehicleId,
    profileId,
    buffer,
    mediaId: stash.mediaId,
    mimeType: stash.mimeType || 'image/jpeg',
    originalFilename: stash.filename || null,
    parsedData: { family: stash.family || null },
    documentType: documentTypeForFamily(stash.family),
    entitlements
  });
  if (vaulted?.ok) {
    return {
      ok: true,
      reason: vaulted.duplicate ? 'already-filed' : 'filed',
      line: LOGBOOK_UPLOAD_COPY.filed(label || 'new asset')
    };
  }
  return { ok: false, reason: 'vault-failed', line: LOGBOOK_UPLOAD_COPY.replayFailed };
}

export default {
  DOCUMENT_STASH_TTL_MS,
  buildDocumentStash,
  isDocumentStashExpired,
  replayDocumentStash
};
