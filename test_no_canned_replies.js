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
// v1.69.0 — Phase 5B-4: the final four leaf modules join the scan, and the
// patterns follow the sanctioned `customReply -> reply` rename so a literal can
// never escape the ratchet by moving into commands/conversation/support.
const SOURCE_FILES = [
  'src/routes/whatsapp/messages.js',
  'src/routes/whatsapp/media.js',
  'src/routes/whatsapp/reads.js',
  'src/routes/whatsapp/pending.js',
  'src/routes/whatsapp/quiz.js',
  'src/routes/whatsapp/commands.js',
  'src/routes/whatsapp/admin.js',
  'src/routes/whatsapp/conversation.js',
  'src/routes/whatsapp/support.js',
  // v1.73.1 — Phase 11: the legacy onboarding lane moved out of the processor
  // into its own leaf module; the ratchet follows the code so a literal can
  // never escape it (§191 F1 defect class).
  'src/routes/whatsapp/onboarding.js',
  // v1.73.4 — Phase 12B: the inbound interactive lane is a leaf too (section 198B).
  'src/routes/whatsapp/interactive.js'
];
const DIRECT_REPLY_PATTERNS = [
  /customReply\s*=\s*'([^'\n]{25,})'/g,
  /finalReply\s*=\s*'([^'\n]{25,})'/g,
  /sendWhatsAppReply\(\s*\w+\s*,\s*'([^'\n]{25,})'/g,
  /customReply\s*=\s*`([^`\n$]{25,})`/g,
  /finalReply\s*=\s*`([^`\n$]{25,})`/g,
  /sendWhatsAppReply\(\s*\w+\s*,\s*`([^`\n$]{25,})`/g,
  /\breply\s*=\s*'([^'\n]{25,})'/g,
  /\breply\s*=\s*`([^`\n$]{25,})`/g
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

// v1.69.0 — Phase 5B-4: the final four leaf modules carry the lane replies as DATA
// (counted by the extended ratchet above) but never send and never touch the
// processor's reply variables. The boundary is asserted, not assumed.
for (const leaf of ['src/routes/whatsapp/commands.js', 'src/routes/whatsapp/admin.js', 'src/routes/whatsapp/conversation.js', 'src/routes/whatsapp/support.js']) {
  const leafSource = fs.readFileSync(leaf, 'utf8');
  assert(!leafSource.includes('sendWhatsAppReply(') && !/\b(?:customReply|finalReply)\b/.test(leafSource), `${leaf} returns data and never sends or owns the processor reply vars`);
  passed += 1;
}

// v1.73.1 — Phase 11: the extracted legacy onboarding lane (§191 branch A +
// the registration starter). It carries its replies as DATA (counted by the
// ratchet above), never sends and never imports the processor. The extraction
// also repaired two pre-existing latent ReferenceErrors: the branch always
// called checkIsConversationalFeedback and formatUsdInLocalCurrency but
// messages.js never imported either — the leaf declares both (rule 52 pins).
const onboardingLeaf = fs.readFileSync('src/routes/whatsapp/onboarding.js', 'utf8');
assert(!onboardingLeaf.includes('sendWhatsAppReply(') && !/from\s+['"]\.\/messages\.js['"]/.test(onboardingLeaf), 'onboarding.js carries lane replies as data and never sends or imports messages.js');
passed += 1;
assert(onboardingLeaf.includes("import { checkIsConversationalFeedback } from './helpers.js';") && onboardingLeaf.includes("import { formatUsdInLocalCurrency } from '../../services/paystack.js';"), 'onboarding.js imports its helpers (pre-existing latent ReferenceErrors repaired)');
passed += 1;

// v1.73.4 — Phase 12B: the inbound interactive lane (section 198B) is a leaf that
// returns data only: it never sends, never owns the processor reply vars and never
// imports messages.js — the same boundary media.js carries (section 189).
const interactiveLeaf = fs.readFileSync('src/routes/whatsapp/interactive.js', 'utf8');
assert(!interactiveLeaf.includes('sendWhatsAppReply(') && !/(?:customReply|finalReply)\s*=/.test(interactiveLeaf), 'interactive.js returns data and never sends or owns the processor reply vars');
passed += 1;
assert(!/from\s+['"]\.\/messages\.js['"]/.test(interactiveLeaf) && /from\s+['"]\.\.\/\.\.\/services\//.test(interactiveLeaf), 'interactive.js imports services only and never the processor');
passed += 1;

// v1.79.0 — Phase 18: the voice-note transcription lane lives in the same leaf.
// The listening ack is DATA (an exported constant), the transcription returns
// data, and the processor keeps every send plus the deterministic fallback.
const voiceLeaf = fs.readFileSync('src/routes/whatsapp/media.js', 'utf8');
assert(voiceLeaf.includes('VOICE_LISTENING_ACK') && voiceLeaf.includes('startAudioTranscription'), 'media.js carries the voice-note listening ack + transcription lane as data');
passed += 1;

console.log(`\n🎉 ${passed} no-canned-replies assertions passed — ${currentCount} canned literals remain (ratchet ≤ 4; every new literal must be composed).`);

