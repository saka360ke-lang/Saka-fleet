/**
 * Saka Fleet - WhatsApp route barrel (Phase 5A of the whatsapp.js split, v1.65.0).
 * ---------------------------------------------------------------------------
 * webhook.js owns the Meta handshake, HMAC check, dedupe and enqueue.
 * messages.js owns the message processor. This barrel re-exports every public
 * symbol so src/routes/whatsapp.js can stay a one-line compatibility shim
 * until Phase 5C removes it.
 */

export * from './webhook.js';
export * from './messages.js';
