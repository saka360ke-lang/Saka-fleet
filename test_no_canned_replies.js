import fs from 'node:fs';
import assert from 'assert';

/**
 * Saka Fleet — no canned user-facing replies (v1.52.1). Stateless.
 *
 * The conversational-first mandate: every user-facing WhatsApp reply is
 * composed from facts by `composeMessage`. Direct literal prose assignments
 * are only allowed for progress indicators (instant/media acks). fallbackText
 * values inside composeMessage calls are the sanctioned deterministic
 * fallback and are not flagged by this lint. The superadmin operator console
 * (superadmin.js) is out of scope by design (hybrid deterministic payloads).
 *
 * Ratchet: the number of remaining canned literals must NEVER grow; each
 * release converts more of them into composed replies. (v1.54.3 — quiz
 * outcome cards, gates and cancellation acks are composed now; only the
 * instant "reading now" progress ack stays literal.)
 */

// v1.67.0 — the ratchet follows the user-facing strings: Phase 5B-2 moved the
// media intake lane into media.js, so the scan covers BOTH the processor and the
// leaf module. media.js must keep contributing ZERO direct replies (it returns
// data; the processor sends) — asserted below so a future literal there can
// never hide outside the ratchet.
// v1.68.0 — Phase 5B-3: the scan also covers the three new leaf modules
// (reads.js, pending.js, quiz.js); each must contribute ZERO direct replies.
const SOURCE_FILES = [
  'src/routes/whatsapp/messages.js',
  'src/routes/whatsapp/media.js',
  'src/routes/whatsapp/reads.js',
  'src/routes/whatsapp/pending.js',
  'src/routes/whatsapp/quiz.js'
];
const DIRECT_REPLY_PATTERNS = [
  /customReply\s*=\s*'([^'\n]{25,})'/g,
  /finalReply\s*=\s*'([^'\n]{25,})'/g,
  /sendWhatsAppReply\(\s*\w+\s*,\s*'([^'\n]{25,})'/g,
  /customReply\s*=\s*`([^`\n$]{25,})`/g,
  /finalReply\s*=\s*`([^`\n$]{25,})`/g,
  /sendWhatsAppReply\(\s*\w+\s*,\s*`([^`\n$]{25,})`/g
];
const directReplies = [];
for (const file of SOURCE_FILES) {
  const fileSource = fs.readFileSync(file, 'utf8');
  for (const pattern of DIRECT_REPLY_PATTERNS) {
    directReplies.push(...[...fileSource.matchAll(pattern)].map((m) => String(m[1]).trim()));
  }
}

// Progress indicators only — never answers, never data, never instruction.
const ALLOWED = new Set([
  '📖 Got it - reading that now.'
]);

let passed = 0;

// Ratchet: the canned-literal count must never grow past today's baseline;
// every release converts more of them into composed replies.
// v1.54.3 — the quiz outcome cards + gates + cancellation acks are now
// composed too; only the instant progress ack remains (counted twice: the
// assignment and the send call).
const currentCount = directReplies.length;
assert(currentCount <= 4, `Canned literal replies grew beyond the ratchet (${currentCount}). Convert them to composeMessage instead.`);
passed += 1;
assert(directReplies.includes('📖 Got it - reading that now.'), 'the instant reading ack remains the only whitelisted literal');
passed += 1;

// v1.67.0 — the leaf media module must never own a user-facing reply. It returns
// data (ack/page text included) and the processor performs every send/compose.
const mediaSource = fs.readFileSync('src/routes/whatsapp/media.js', 'utf8');
assert(!/(?:customReply|finalReply)\s*=/.test(mediaSource) && !mediaSource.includes('sendWhatsAppReply('), 'media.js never owns a reply - it returns data and the processor sends');
passed += 1;

// v1.68.0 — Phase 5B-3: the three new leaf modules return data and own ZERO direct
// replies (same patterns as the ratchet); the processor performs every send/compose.
for (const leaf of ['src/routes/whatsapp/reads.js', 'src/routes/whatsapp/pending.js', 'src/routes/whatsapp/quiz.js']) {
  const leafSource = fs.readFileSync(leaf, 'utf8');
  const leafHits = DIRECT_REPLY_PATTERNS.reduce((sum, pattern) => sum + [...leafSource.matchAll(pattern)].length, 0);
  assert(leafHits === 0, `${leaf} never owns a direct reply - it returns data and the processor sends`);
  passed += 1;
}

console.log(`\n🎉 ${passed} no-canned-replies assertions passed — ${currentCount} canned literals remain (ratchet ≤ 4; every new literal must be composed).`);

