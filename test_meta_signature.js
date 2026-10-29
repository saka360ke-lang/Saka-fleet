/**
 * Saka Fleet — Meta webhook signature verification tests (v1.15.1)
 * ---------------------------------------------------------------
 * Stateless: pure HMAC logic, zero network, zero database rows.
 * Run: node test_meta_signature.js
 */

import assert from 'assert';
import crypto from 'crypto';
import {
  verifyMetaWebhookSignature,
  META_APP_SECRET_PLACEHOLDER
} from './src/routes/whatsapp.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`✅ ${message}`);
}

const SECRET = 'real-meta-app-secret-for-tests';
const body = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: '123', changes: [{ value: { messaging_product: 'whatsapp' } }] }]
});
const sign = (payload, secret = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

console.log('=== META WEBHOOK SIGNATURE TESTS ===\n');

console.log('--- Test 1: valid signatures ---');
const valid = verifyMetaWebhookSignature({ secret: SECRET, rawBody: body, reserializedBody: body, signatureHeader: sign(body) });
check(valid.valid === true && valid.reason === 'ok', 'Exact raw-body signature verifies');

const noPrefix = verifyMetaWebhookSignature({
  secret: SECRET,
  rawBody: body,
  signatureHeader: sign(body).replace('sha256=', '')
});
check(noPrefix.valid === true, 'Signature without the sha256= prefix is accepted');

const upper = verifyMetaWebhookSignature({
  secret: SECRET,
  rawBody: body,
  signatureHeader: sign(body).toUpperCase()
});
check(upper.valid === true, 'Uppercase hex signatures are accepted');

console.log('\n--- Test 2: tampering & secret drift ---');
const tampered = verifyMetaWebhookSignature({
  secret: SECRET,
  rawBody: body.replace('whatsapp_business_account', 'whatsapp_business_account '),
  signatureHeader: sign(body)
});
check(tampered.valid === false && tampered.reason === 'mismatch', 'Tampered body is rejected');

const wrongSecret = verifyMetaWebhookSignature({
  secret: 'stale-or-placeholder-secret',
  rawBody: body,
  signatureHeader: sign(body)
});
check(wrongSecret.valid === false && wrongSecret.reason === 'mismatch', 'Wrong secret is rejected (the production 403 cause)');

check(
  verifyMetaWebhookSignature({ secret: META_APP_SECRET_PLACEHOLDER, rawBody: body, signatureHeader: sign(body) }).diagnostics.secretIsPlaceholder === true,
  'Placeholder secret is flagged in diagnostics'
);

console.log('\n--- Test 3: missing inputs ---');
const missingHeader = verifyMetaWebhookSignature({ secret: SECRET, rawBody: body });
check(missingHeader.valid === false && missingHeader.reason === 'missing_header', 'Missing signature header is reported');
const missingSecret = verifyMetaWebhookSignature({ secret: '', rawBody: body, signatureHeader: sign(body) });
check(missingSecret.valid === false && missingSecret.reason === 'missing_secret', 'Missing secret is reported');
const nonHex = verifyMetaWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: 'sha256=zzzz' });
check(nonHex.valid === false && nonHex.reason === 'mismatch', 'Non-hex signatures fail safely (no throw)');

console.log('\n--- Test 4: raw vs re-serialized payload ---');
const unicodeRaw = '{"text":"caf\\u00e9"}';
const unicodeReserialized = JSON.stringify(JSON.parse(unicodeRaw));
const rawSigned = verifyMetaWebhookSignature({
  secret: SECRET,
  rawBody: unicodeRaw,
  reserializedBody: unicodeReserialized,
  signatureHeader: sign(unicodeRaw)
});
check(rawSigned.valid === true, 'Signature over raw escaped bytes verifies even when re-serialization differs');
check(rawSigned.diagnostics.bodiesMatch === false, 'Diagnostics report that raw and re-serialized bodies differ');

const fallback = verifyMetaWebhookSignature({
  secret: SECRET,
  rawBody: null,
  reserializedBody: body,
  signatureHeader: sign(body)
});
check(fallback.valid === true, 'Re-serialized fallback verifies when raw bytes are unavailable');

console.log('\n--- Test 5: diagnostics are masked but useful ---');
const diag = wrongSecret.diagnostics;
check(diag.secretSet === true && diag.secretLen > 0, 'Diagnostics include secret presence/length');
check(diag.providedLen === 64 && diag.expectedPrefix?.length === 4, 'Diagnostics include hash length + 4-char prefixes');
check(diag.rawBodyLen === body.length && diag.reserializedLen === 0, 'Diagnostics include body lengths (0 when not supplied)');
check(!JSON.stringify(diag).includes(SECRET), 'Diagnostics never contain the secret');

console.log(`\n✅ ALL META SIGNATURE TESTS PASSED (${passed} assertions).`);
console.log('Stateless suite: no database rows created, no cleanup required.');
