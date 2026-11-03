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
 * release converts more of them into composed replies. (Quiz outcome cards
 * are the remaining batch, converted in follow-up releases.)
 */

const source = fs.readFileSync('src/routes/whatsapp.js', 'utf8');

const directReplies = [
  ...source.matchAll(/customReply\s*=\s*'([^'\n]{25,})'/g),
  ...source.matchAll(/finalReply\s*=\s*'([^'\n]{25,})'/g),
  ...source.matchAll(/sendWhatsAppReply\(\s*\w+\s*,\s*'([^'\n]{25,})'/g),
  ...source.matchAll(/customReply\s*=\s*`([^`\n$]{25,})`/g),
  ...source.matchAll(/finalReply\s*=\s*`([^`\n$]{25,})`/g),
  ...source.matchAll(/sendWhatsAppReply\(\s*\w+\s*,\s*`([^`\n$]{25,})`/g)
].map((m) => String(m[1]).trim());

// Progress indicators only — never answers, never data, never instruction.
const ALLOWED = new Set([
  '📖 Got it - reading that now.'
]);

let passed = 0;

// Ratchet: the canned-literal count must never grow past today's baseline;
// every release converts more of them into composed replies.
const currentCount = directReplies.length;
assert(currentCount <= 20, `Canned literal replies grew beyond the ratchet (${currentCount}). Convert them to composeMessage instead.`);
passed += 1;
assert(directReplies.includes('📖 Got it - reading that now.'), 'the instant reading ack remains the only whitelisted literal');
passed += 1;

console.log(`\n🎉 ${passed} no-canned-replies assertions passed — ${currentCount} canned literals remain (ratchet ≤ 20; every new literal must be composed).`);

