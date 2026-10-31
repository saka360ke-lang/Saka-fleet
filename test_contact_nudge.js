import assert from 'assert';
import {
  CONTACT_NUDGE_SQL,
  CONTACT_NUDGE_COOLDOWN_DAYS,
  ensureContactNudgeSchema,
  shouldSuggestContactSave,
  isLostChatMessage,
  buildContactSaveFacts,
  markContactSaveSuggested
} from './src/services/contactNudge.js';

/**
 * Saka Fleet — save-my-number nudge (v1.28.0). Stateless.
 *
 * The nudge is milestone-anchored, once per profile, never mid-flow and never
 * pushy. These tests lock the timing gates and the user-safe facts.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const profile = { id: 'p-1', full_name: 'Amina Yusuf' };
const recentStamp = new Date(Date.now() - 2 * 86400000).toISOString();
const staleStamp = new Date(Date.now() - 90 * 86400000).toISOString();

console.log('=== SAKA FLEET — CONTACT-SAVE NUDGE TESTS (v1.28.0) ===\n');

console.log('--- Test 1: timing gates ---');
check(shouldSuggestContactSave({ profile, hasVehicle: true }) === true, 'a registered owner with no stamp qualifies');
check(shouldSuggestContactSave({ profile: null, hasVehicle: true }) === false, 'no profile means no nudge');
check(shouldSuggestContactSave({ profile, hasVehicle: false }) === false, 'no vehicle milestone means no nudge');
check(shouldSuggestContactSave({ profile, hasVehicle: true, hasQuiz: true }) === false, 'never during a quiz');
check(shouldSuggestContactSave({ profile, hasVehicle: true, isFrustrated: true }) === false, 'never to a frustrated user');
check(shouldSuggestContactSave({ profile, hasVehicle: true, paused: true }) === false, 'never while paused');
check(shouldSuggestContactSave({ profile, session: { contactSaveNudged: true }, hasVehicle: true }) === false, 'once per session');
check(shouldSuggestContactSave({ profile: { ...profile, contact_save_nudged_at: recentStamp }, hasVehicle: true }) === false, 'respects the 30-day cooldown');
check(shouldSuggestContactSave({ profile: { ...profile, contact_save_nudged_at: staleStamp }, hasVehicle: true }) === true, 'a stale stamp allows a later reminder');
check(CONTACT_NUDGE_COOLDOWN_DAYS >= 7, 'the cooldown is at least a week');

console.log('\n--- Test 2: lost-chat second chance ---');
check(isLostChatMessage('I lost our chat, where are you?') === true, 'lost-chat is recognised');
check(isLostChatMessage("I can't find you in my messages") === true, '"can\'t find you" is recognised');
check(isLostChatMessage('I changed phones') === true, 'a new phone is recognised');
check(isLostChatMessage('How much is the insurance?') === false, 'ordinary questions are not lost-chat moments');

console.log('\n--- Test 3: user-safe facts ---');
const facts = buildContactSaveFacts({ plateNumber: 'kda 123a', name: 'Amina Yusuf' });
check(facts.suggestedName === 'Saka – KDA 123A', 'the suggested contact name carries the vehicle registration');
check(facts.fallbackLine.includes('Saka – KDA 123A'), 'the fallback line is personalised');
check(/any name/i.test(facts.fallbackLine), 'the user is free to choose any name');
check(!/\bplates?\b/i.test(facts.fallbackLine) && !/\bplates?\b/i.test(facts.instruction), 'the word "plate" never appears');
check(facts.instruction.includes('exactly ONE short line'), 'the composer is limited to one line');
check(/no guilt/i.test(facts.instruction), 'the tone floor is explicit');
const noPlate = buildContactSaveFacts({});
check(noPlate.suggestedName === 'Saka Fleet', 'without a vehicle it falls back to Saka Fleet');

console.log('\n--- Test 4: schema helper is fail-soft ---');
check(/contact_save_nudged_at/.test(CONTACT_NUDGE_SQL), 'the migration SQL declares the stamp column');
const noClient = await ensureContactNudgeSchema(null);
check(noClient.ok === false && noClient.status === 'no-client', 'a missing client never throws');
const noStamp = await markContactSaveSuggested(null, 'p-1');
check(noStamp.ok === false, 'marking without a client never throws');

console.log(`\n🎉 ${passed} contact-nudge assertions passed.`);
