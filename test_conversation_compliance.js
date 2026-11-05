import fs from 'node:fs';
import assert from 'assert';
import { DEFAULT_SAKA_CORE_PROMPT } from './sakaAi.js';
import { SAKA_TONE_COMPASS } from './src/services/flowKnowledge.js';

/**
 * Saka Fleet — conversation compliance harness (v1.54.3). Stateless.
 *
 * The persona proof promised in §111 (v1.53.0): elderly, low-literacy,
 * angry and Shenglish personas, plus the David Njonjo document replay, are
 * pinned by the LAWS in the core prompt AND by a plain-language lint over
 * every deterministic fallbackText in the WhatsApp route. No provider call,
 * no database row.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — CONVERSATION COMPLIANCE HARNESS (v1.54.3) ===\n');

console.log('--- Test 1: the persona laws are embedded in the core prompt ---');
check(DEFAULT_SAKA_CORE_PROMPT.includes('PERSONALITY LAW'), 'PERSONALITY LAW: casual-warm, respectful, matter-of-fact, milestone-only enthusiasm');
check(DEFAULT_SAKA_CORE_PROMPT.includes('EVERY-DEMOGRAPHIC LAW'), 'EVERY-DEMOGRAPHIC LAW: every age and skill level, second-struggle simplest path');
check(DEFAULT_SAKA_CORE_PROMPT.includes('OWN-DATA LAW'), 'OWN-DATA LAW: the user\'s own data is always answerable from facts');
check(DEFAULT_SAKA_CORE_PROMPT.includes('GREETING LAW'), 'GREETING LAW: no re-greeting mid-conversation');
check(DEFAULT_SAKA_CORE_PROMPT.includes('NO EMPTY REPLIES'), 'NO EMPTY REPLIES: bare acknowledgements are banned');

console.log('--- Test 2: tone compass floors cover every persona ---');
const poles = SAKA_TONE_COMPASS.poles.map((pole) => pole.law).join(' ');
const floors = SAKA_TONE_COMPASS.floors.join(' ');
const voice = SAKA_TONE_COMPASS.voice.join(' ');
const mirror = SAKA_TONE_COMPASS.mirrorMatrix.map((row) => row.rule).join(' ');
const inclusion = SAKA_TONE_COMPASS.inclusion.join(' ');
check(/frustrat/i.test(poles), 'the angry persona has a pole floor (empathy before instructions)');
check(/plain words|short sentences/i.test(inclusion), 'the elderly/low-literacy persona has a plain-language floor');
check(/second struggle|simplest/i.test(voice), 'the second-struggle simplest path is a floor, not a suggestion');
check(/mirror the register|Match formality/i.test(mirror), 'the Shenglish persona is covered by the mirror matrix (mirror the user\'s language)');
check(SAKA_TONE_COMPASS.bannedPhrases.includes("I can't see"), 'the widened access-refusal family stays banned (v1.54.0)');

console.log('--- Test 2b: Persona v4 brand compass, ack variety and pacing (v1.59.0) ---');
const brandVoice = SAKA_TONE_COMPASS.voice.join(' ');
check(/The medium is WhatsApp/i.test(brandVoice), 'brand compass: WhatsApp-native, punchy and scannable');
check(/active human verbs/i.test(brandVoice) && /Logged ✓/.test(brandVoice), 'brand compass: active verbs like "Logged ✓" beat robotic formulas');
check(/contractions/i.test(brandVoice), 'brand compass: natural contractions and varied rhythm');
check(/Quick-log shorthand/i.test(mirror), 'mirror matrix: quick-log shorthand gets a lightning confirmation');
check(/structured analytical asks/i.test(mirror), 'mirror matrix: formal analytical asks get structured bullets and precise labels');
check(Array.isArray(SAKA_TONE_COMPASS.pacing) && /no menu/i.test(SAKA_TONE_COMPASS.pacing.join(' ')), 'pacing: a completed write never appends a menu');
check(/patient-guide/i.test(SAKA_TONE_COMPASS.pacing.join(' ')), 'pacing: errors switch to patient-guide mode');
check(/same confirmation opener/i.test(SAKA_TONE_COMPASS.ackVariety.law), 'ack variety: no repeated confirmation opener');
check(SAKA_TONE_COMPASS.ackVariety.casual.length >= 4 && SAKA_TONE_COMPASS.ackVariety.formal.length >= 4, 'ack variety: deterministic pools for both registers');
check(SAKA_TONE_COMPASS.floors.some((floor) => /confirmation opener/i.test(floor)), 'the ack-variety law is a floor, not a suggestion');
check(DEFAULT_SAKA_CORE_PROMPT.includes('PERSONA V4') && DEFAULT_SAKA_CORE_PROMPT.includes('PACING LAW') && DEFAULT_SAKA_CORE_PROMPT.includes('ACK VARIETY LAW'), 'the core prompt carries the v4 laws');

console.log('--- Test 3: plain-language lint over every deterministic fallback ---');
const source = fs.readFileSync('src/routes/whatsapp.js', 'utf8');
const fallbacks = [
  ...source.matchAll(/fallbackText:\s*'([^'\n]{25,})'/g),
  ...source.matchAll(/fallbackText:\s*`([^`\n$]{25,})`/g)
].map((match) => String(match[1]).trim());
check(fallbacks.length >= 25, `the route carries ${fallbacks.length} deterministic fallbacks to lint`);
const banned = new Set(SAKA_TONE_COMPASS.bannedPhrases.map((phrase) => String(phrase).toLowerCase()));
let bannedHits = 0;
let longSentenceHits = 0;
let multiQuestionHits = 0;
for (const text of fallbacks) {
  const lowered = text.toLowerCase();
  for (const phrase of banned) {
    if (phrase && lowered.includes(phrase)) {
      bannedHits += 1;
      console.log(`    ⚠️ banned phrase in fallback: "${phrase}" → ${text.slice(0, 60)}`);
    }
  }
  // ONE-question rule: count only UNQUOTED question marks — quoted example
  // phrasings ("how much did I spend on fuel last week?") are teaching aids,
  // not questions asked of the user.
  const unquoted = text.replace(/"([^"\n]*\?)"/g, '"…"');
  const questions = (unquoted.match(/\?/g) || []).length;
  if (questions > 1) multiQuestionHits += 1;
  // Plain-language floor: no sentence longer than ~28 words (engine cards
  // carry figures, so the floor is a ceiling, not the ideal). Quoted example
  // phrasings are teaching aids and are stripped before counting.
  const unquotedText = text.replace(/"([^"\n]*)"/g, '…');
  for (const line of unquotedText.split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const words = sentence.trim().split(/\s+/).filter(Boolean).length;
      if (words > 28) longSentenceHits += 1;
    }
  }
}
check(bannedHits === 0, `no deterministic fallback carries a banned phrase (${bannedHits} hits)`);
check(multiQuestionHits === 0, 'no deterministic fallback asks more than ONE question');
check(longSentenceHits === 0, `no deterministic fallback sentence exceeds the plain-language ceiling (${longSentenceHits} hits)`);

console.log('--- Test 4: persona replay guardrails (prompt-level proof) ---');
// Angry / frustrated persona → validation before instruction, one next step.
check(DEFAULT_SAKA_CORE_PROMPT.includes('Validate emotion, never amplify it'), 'the angry persona rule: validate, never amplify');
// Elderly / low-literacy persona → never rushed, never shamed, one step.
check(DEFAULT_SAKA_CORE_PROMPT.includes('never make anyone feel slow'), 'the elderly persona rule: never make anyone feel slow');
// Shenglish / mixed-language persona → fragments and mixed languages accepted quietly.
check(DEFAULT_SAKA_CORE_PROMPT.includes('fragments, typos, voice notes, mixed languages'), 'the Shenglish persona rule: fragments and mixed languages accepted');
// David Njonjo replay → the engine (not the AI) owns the document figures.
check(DEFAULT_SAKA_CORE_PROMPT.includes('the deterministic lens is ALWAYS the authority'), 'the David Njonjo document replay stays engine-owned (v1.54.1)');

console.log(`\n🎉 ${passed} conversation-compliance assertions passed.`);