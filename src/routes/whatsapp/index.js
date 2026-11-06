/**
 * Saka Fleet - WhatsApp route barrel (Phase 5B-1 of the whatsapp.js split, v1.66.0).
 * ---------------------------------------------------------------------------------
 * webhook.js owns the Meta handshake, HMAC check, dedupe and enqueue.
 * messages.js owns the message processor. helpers.js owns the pure helpers and
 * replies.js the outbound Meta sender. This barrel re-exports every public
 * symbol so src/routes/whatsapp.js can stay a one-line compatibility shim
 * until Phase 5C removes it.
 */

export * from './webhook.js';
export * from './messages.js';
export * from './helpers.js';
export * from './replies.js';

