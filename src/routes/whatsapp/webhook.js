/**
 * Saka Fleet - WhatsApp webhook route (Phase 5A of the whatsapp.js split, v1.65.0).
 * ------------------------------------------------------------------------------
 * Owns the Meta GET verification handshake, the POST HMAC verification, the wamid
 * dedupe cache and the instant 200 + per-phone enqueue. The message processor lives
 * in ./messages.js and is imported statically: this module depends on it, never the
 * other way round.
 */

import crypto from 'crypto';
import { logSystemError } from '../../workers/sentinel.js';
import { markDeliveryBlocked } from '../../services/deliveryGuard.js';
import { enqueueUserMessage } from '../../services/messageQueue.js';
import { createResilientClient } from '../../services/supabaseClient.js';
import { processIncomingWhatsAppMessage } from './messages.js';

let supabaseClient = createResilientClient();

// Idempotency cache: Meta message ID (wamid) -> timestamp (10-minute TTL)
export const processedWebhooksCache = new Map();
export const DEDUPLICATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function isMessageProcessed(wamid) {
  if (!wamid) return false;
  const now = Date.now();
  for (const [id, timestamp] of processedWebhooksCache.entries()) {
    if (now - timestamp > DEDUPLICATION_TTL_MS) {
      processedWebhooksCache.delete(id);
    }
  }
  return processedWebhooksCache.has(wamid);
}

export function markMessageProcessed(wamid) {
  if (!wamid) return;
  processedWebhooksCache.set(wamid, Date.now());
}

export async function checkAndRecordWamid(supabase, wamid, senderPhone) {
  if (!wamid) return false;

  // 1. Fast in-memory check (<0.1ms)
  if (isMessageProcessed(wamid)) {
    return true; // Already processed!
  }
  markMessageProcessed(wamid);

  // 2. Distributed Supabase cache check & sync
  if (supabase) {
    try {
      const tenMinutesAgo = new Date(Date.now() - DEDUPLICATION_TTL_MS).toISOString();
      const { data, error } = await supabase
        .from('processed_webhooks')
        .select('wamid')
        .eq('wamid', wamid)
        .gte('processed_at', tenMinutesAgo)
        .maybeSingle();

      if (!error && data) {
        return true;
      }

      // Record in Supabase asynchronously
      await supabase
        .from('processed_webhooks')
        .upsert([{ wamid, phone_number: senderPhone, processed_at: new Date().toISOString() }], { onConflict: 'wamid' });
    } catch {
      // In-memory cache continues seamlessly if database has transient issue
    }
  }

  return false;
}

/**
 * Known test/placeholder App Secret (used by test_security.js). A production
 * deployment carrying this value can never verify Meta signatures.
 */
export const META_APP_SECRET_PLACEHOLDER = 'meta_app_secret_sakafleet_2026';

/**
 * Verify a Meta WhatsApp webhook signature (HMAC SHA-256).
 *
 * Accepts the exact raw bytes Meta signed and — only when they differ from the
 * re-serialized JSON body — the re-serialized body as a fallback. Returns
 * masked diagnostics so a 403 is diagnosable from logs without leaking secrets.
 */
export function verifyMetaWebhookSignature({ secret, rawBody, reserializedBody = null, signatureHeader } = {}) {
  const diagnostics = {
    secretSet: Boolean(secret),
    secretLen: secret ? String(secret).length : 0,
    secretIsPlaceholder: secret === META_APP_SECRET_PLACEHOLDER,
    headerPresent: Boolean(signatureHeader),
    providedLen: 0,
    providedPrefix: null,
    expectedPrefix: null,
    rawBodyLen: typeof rawBody === 'string' ? rawBody.length : 0,
    reserializedLen: typeof reserializedBody === 'string' ? reserializedBody.length : 0,
    bodiesMatch: reserializedBody === null ? true : rawBody === reserializedBody
  };

  if (!secret) return { valid: false, reason: 'missing_secret', diagnostics };
  if (!signatureHeader) return { valid: false, reason: 'missing_header', diagnostics };

  const providedHash = String(signatureHeader).replace(/^sha256=/i, '').trim().toLowerCase();
  diagnostics.providedLen = providedHash.length;
  diagnostics.providedPrefix = providedHash.slice(0, 4);

  const candidates = [];
  if (typeof rawBody === 'string') candidates.push(rawBody);
  if (typeof reserializedBody === 'string' && reserializedBody !== rawBody) candidates.push(reserializedBody);
  if (candidates.length === 0) return { valid: false, reason: 'missing_body', diagnostics };

  const hashes = candidates.map((payload) =>
    crypto.createHmac('sha256', secret).update(payload).digest('hex')
  );
  diagnostics.expectedPrefix = hashes[0].slice(0, 4);

  let valid = false;
  for (const expectedHash of hashes) {
    try {
      if (expectedHash.length === providedHash.length
        && crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(providedHash, 'hex'))) {
        valid = true;
        break;
      }
    } catch {
      // Non-hex signatures throw inside Buffer.from — treat as invalid.
    }
  }

  return { valid, reason: valid ? 'ok' : 'mismatch', diagnostics };
}

export async function handleWhatsAppWebhook(request, reply, fastify) {
  // Meta WhatsApp Webhook HMAC SHA-256 Signature Verification
  const metaAppSecret = process.env.META_APP_SECRET;
  if (metaAppSecret) {
    const signatureHeader = request.headers ? request.headers['x-hub-signature-256'] : null;
    if (!signatureHeader) {
      if (fastify?.log) fastify.log.warn('Meta WhatsApp webhook signature missing.');
      return reply.status(403).send({ error: 'Forbidden: Missing signature header' });
    }

    // Prefer the exact raw bytes captured by the Fastify content-type parser.
    // Re-serialize only as a fallback so tests / alternate transports still work.
    const rawBody = typeof request.rawBody === 'string'
      ? request.rawBody
      : (typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {}));
    const reserializedBody = typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body || {});

    const verification = verifyMetaWebhookSignature({
      secret: metaAppSecret,
      rawBody,
      reserializedBody,
      signatureHeader
    });

    if (!verification.valid) {
      if (fastify?.log) {
        fastify.log.warn(
          { event: 'meta_webhook_signature_failed', reason: verification.reason, ...verification.diagnostics },
          'Meta WhatsApp webhook signature verification failed.'
        );
      }
      return reply.status(403).send({ error: 'Forbidden: Invalid x-hub-signature-256' });
    }
  }

  const body = request.body || {};

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messageObj = value?.messages?.[0];

    // v1.48.0 — delivery receipts (message_status). The app now sees when a
    // proactive message (deploy alerts, reminders, briefings) actually lands or
    // fails — previously send failures were invisible (Meta can accept a send and
    // still fail delivery, or fail asynchronously with no webhook handling here).
    const statusObj = value?.statuses?.[0];
    if (statusObj) {
      if (fastify?.log) {
        fastify.log.info({
          event: 'whatsapp_message_status',
          wamid: statusObj.id || null,
          status: statusObj.status || null,
          recipient_id: statusObj.recipient_id || null,
          timestamp: statusObj.timestamp || null,
          errors: statusObj.errors || []
        }, 'WhatsApp message status received.');
      }
      if (statusObj.status === 'failed') {
        // v1.58.22 - normalize the message so ERROR_ROLLUP_HOURS folds repeats:
        // one row per recipient+code per window instead of one row per wamid
        // (live 2026-11-04: 22 near-identical 131026 rows in 48h).
        const errCode = statusObj.errors?.[0]?.code || 'unknown';
        const errTitle = statusObj.errors?.[0]?.title || 'delivery failed';
        const recipient = String(statusObj.recipient_id || 'unknown');
        const failure = new Error(`WhatsApp delivery failed (${errCode}) to …${recipient.slice(-4)}: ${errTitle}`);
        failure.stack = `wamid: ${statusObj.id || 'unknown'}\nrecipient: ${recipient}\n${JSON.stringify(statusObj.errors || [])}`;
        // v1.58.23 - block permanent delivery failures so the sender stops
        // hammering a number that can never receive (fail-open, per instance).
        markDeliveryBlocked(recipient, errCode);
        if (supabaseClient) await logSystemError(supabaseClient, failure, '/webhook/whatsapp/status').catch(() => {});
      }
      return reply.status(200).send({ status: 'success', status_ack: 'message_status_recorded' });
    }

    if (!messageObj) {
      return reply.status(200).send({ status: 'ignored_non_message_event' });
    }

    const wamid = messageObj.id;
    const senderPhone = messageObj.from;

    // 1. Fast in-memory idempotency check (sub-millisecond). The distributed
    //    Supabase claim now runs in the background queue, so the 200 OK is
    //    never blocked on database I/O.
    if (wamid && isMessageProcessed(wamid)) {
      if (fastify?.log) fastify.log.warn(`[Deduplication] Message ${wamid} already processed (memory). Aborting Meta retry.`);
      return reply.status(200).send({ status: 'success', deduplicated: true });
    }

    // 2. Immediate Fastify 200 OK Response (Eliminates Meta Webhook Timeout & Retries)
    if (reply && typeof reply.status === 'function') {
      reply.status(200).send({ status: 'success' });
    }

    // 3. Per-phone serial queue + global concurrency cap + retry/backoff.
    //    The wamid is claimed once inside the queued task (cross-instance
    //    dedup); retries re-run processing without re-claiming.
    let claimed = false;
    return enqueueUserMessage(senderPhone, async () => {
      if (!claimed) {
        const alreadyProcessed = await checkAndRecordWamid(supabaseClient, wamid, senderPhone);
        if (alreadyProcessed) {
          if (fastify?.log) fastify.log.warn(`[Deduplication] Message ${wamid} already processed. Aborting Meta retry.`);
          return { status: 'success', deduplicated: true };
        }
        claimed = true;
      }
      return processIncomingWhatsAppMessage({ messageObj, fastify, supabaseClient });
    })
      .catch(async (err) => {
        if (fastify?.log) fastify.log.error({ err }, 'WhatsApp background processing failed');
        await logSystemError(supabaseClient, err, '/webhook/whatsapp').catch(() => {});
        return { status: 'error', error: err?.message };
      });
  }

  return reply.status(404).send({ error: 'Not Found' });
}

// v1.65.0 (5A/3) - Meta GET verification handshake, moved verbatim from index.js.
export async function handleWhatsAppWebhookVerification(request, reply, fastify) {
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expectedToken) {
    fastify.log.info('Meta WhatsApp webhook verified successfully.');
    return reply.status(200).send(challenge);
  } else {
    return reply.status(403).send('Forbidden');
  }
}
