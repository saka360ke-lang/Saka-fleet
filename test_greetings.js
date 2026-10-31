import assert from 'assert';
import {
  resolveDaypart,
  greetingFor,
  sakaIntroText,
  isFirstContact,
  isIntroCopy,
  wantsIntroduction,
  asksForPlateDirectly,
  shouldReplaceIntroCopy,
  isRepeatedReply,
  isStopRequest,
  PAUSE_REPLY,
  REPEAT_NUDGES,
  pickRepeatNudge,
  NEWCOMER_NUDGES,
  pickNewcomerNudge,
  isFirstTimeMessage,
  shouldReplacePlateAsk
} from './src/services/greetings.js';
import { sanitizeSakaReply } from './src/services/productQa.js';

/**
 * Saka Fleet — First-contact greetings & emoji artistry tests (v1.18.1).
 * Stateless: pure functions only.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

function emojiCount(text) {
  return (String(text).match(/\p{Extended_Pictographic}/gu) || []).length;
}

const india = { country_code: 'IN', country: 'India', currency: 'INR', plate_example: 'MH 01 AB 1234' };
const kenya = { country_code: 'KE', country: 'Kenya', currency: 'KES', plate_example: 'KDA 123A' };
const usa = { country_code: 'US', country: 'United States', currency: 'USD', plate_example: 'ABC 1234' };

console.log('=== SAKA FLEET — GREETINGS & EMOJI TESTS ===\n');

console.log('--- Test 1: dayparts in the user timezone ---');
check(resolveDaypart(new Date('2026-10-30T05:30:00Z'), 'Africa/Nairobi') === 'morning', '08:30 Nairobi is morning');
check(resolveDaypart(new Date('2026-10-30T09:30:00Z'), 'Africa/Nairobi') === 'afternoon', '12:30 Nairobi is afternoon');
check(resolveDaypart(new Date('2026-10-30T15:30:00Z'), 'Africa/Nairobi') === 'evening', '18:30 Nairobi is evening');
check(resolveDaypart(new Date('2026-10-30T20:30:00Z'), 'Africa/Nairobi') === 'night', '23:30 Nairobi is night');
check(resolveDaypart(new Date('2026-10-30T04:00:00Z'), 'Asia/Kolkata') === 'morning', '09:30 IST is morning');

console.log('--- Test 2: country-aware greetings ---');
const indiaGreeting = greetingFor({ countryInfo: india, now: new Date('2026-10-30T04:00:00Z') });
check(indiaGreeting.text.startsWith('Namaste!') && indiaGreeting.text.includes('🙏'), 'India opens with Namaste 🙏');
const kenyaGreeting = greetingFor({ countryInfo: kenya, now: new Date('2026-10-30T04:00:00Z') });
check(kenyaGreeting.text.startsWith('Habari!'), 'East Africa opens with Habari');
const usaGreeting = greetingFor({ countryInfo: usa, now: new Date('2026-10-30T22:30:00Z') });
check(/^Good (morning|afternoon|evening|night)!/.test(usaGreeting.text), 'default locales get a time-of-day greeting');
check(greetingFor({ countryInfo: null }).text.length > 0, 'missing country falls back safely');

console.log('--- Test 3: Saka introduction ---');
const intro = sakaIntroText({ countryInfo: india, now: new Date('2026-10-30T04:00:00Z') });
check(intro.includes('Namaste!') && intro.includes('*Saka*'), 'intro includes the localized greeting and the name Saka');
check(intro.includes('MH 01 AB 1234'), 'intro uses the country plate example');
check(intro.includes('⛽') && intro.includes('💰') && intro.includes('🔔'), 'intro uses semantic anchors for fuel, costs and reminders');
check(/REGISTER/i.test(intro), 'intro ends with ONE clear next step');
check(!/send your vehicle'?s? (?:number |registration )?plate/i.test(intro), 'the intro never asks for a plate');
check(emojiCount(intro) <= 4, `intro respects the welcome emoji ceiling (${emojiCount(intro)})`);
const noStep = sakaIntroText({ countryInfo: india, nextStep: '' });
check(!/REGISTER|number plate/i.test(noStep), 'next step can be omitted when the plate is already known');
const named = sakaIntroText({ countryInfo: kenya, profile: { full_name: 'Amina Yusuf' } });
check(named.includes('Amina'), 'returning profile name is used warmly');

console.log('--- Test 4: first-contact detection ---');
check(isFirstContact({ session: {}, dbHistory: [], hasVehicleRegistered: false }) === true, 'fresh number is first contact');
check(isFirstContact({ session: {}, dbHistory: [{ role: 'user' }], hasVehicleRegistered: false }) === false, 'existing chat history is not first contact');
check(isFirstContact({ session: { history: [{ role: 'user' }] }, dbHistory: [], hasVehicleRegistered: false }) === true, 'in-memory-only history is treated as stale (wipe-aware)');
check(isFirstContact({ session: { sakaIntroduced: true }, dbHistory: [], hasVehicleRegistered: false }) === true, 'a stale introduced flag never suppresses a fresh welcome');
check(isFirstContact({ session: { sakaIntroduced: true }, dbHistory: [{ role: 'assistant' }], hasVehicleRegistered: false }) === false, 'persisted history still suppresses the intro');
check(isFirstContact({ session: {}, dbHistory: [], hasVehicleRegistered: true }) === false, 'registered users skip the intro');
// v1.24.3 — the slow-DB race: this turn's own user row can already be persisted.
const raceNow = Date.parse('2026-10-31T05:00:00Z');
check(isFirstContact({
  dbHistory: [{ role: 'user', message: 'Hi', created_at: '2026-10-31T04:59:59Z' }],
  profile: { created_at: '2026-10-31T04:59:55Z' },
  now: raceNow
}) === true, 'a brand-new profile stays first contact even when its own user row is already persisted');
check(isFirstContact({
  dbHistory: [{ role: 'user' }],
  profile: { created_at: '2026-10-31T03:00:00Z' },
  now: raceNow
}) === false, 'an older profile with history is still a returning user');
check(isFirstContact({
  dbHistory: [{ role: 'user' }],
  profile: { created_at: '2026-10-31T04:58:30Z' },
  now: raceNow
}) === true, 'the new-profile window covers a 90-second-old account');

console.log('--- Test 4b: zero-vehicle plate guard (v1.21.3) ---');
check(asksForPlateDirectly("What's the plate number of the vehicle you'd like to work with?") === true, 'a direct plate ask is detected');
check(asksForPlateDirectly('Please send me the registration plate') === true, 'an instruction to send the plate is detected');
check(asksForPlateDirectly('What kind of asset is it? Car, truck, generator…') === false, 'the asset-kind question is not a plate ask');
check(asksForPlateDirectly('What vehicles do I own?') === false, 'a fleet question is not a plate ask');

console.log('--- Test 4b: intro-copy guard (v1.19.2) ---');
check(isIntroCopy('Karibu to Saka Fleet! I help you keep track of your vehicles') === true, 'a fresh Karibu welcome is detected');
check(isIntroCopy("Hi! I'm Saka, your vehicle's co-pilot on WhatsApp.") === true, 'the English Saka intro is detected');
check(isIntroCopy('Your insurance expires on 2027-05-15') === false, 'normal replies are not mistaken for intros');
check(wantsIntroduction('who are you?') === true, 'an explicit introduction request is recognised');
check(wantsIntroduction('still waiting') === false, 'a generic nudge is not an introduction request');

console.log('--- Test 4b: intro-copy replacement only after onboarding ---');
check(shouldReplaceIntroCopy({ firstContact: false, historyLength: 3, hasQuiz: false, hasVehicle: true, isIntro: true }) === true, 'a returning owner cannot be re-introduced');
check(shouldReplaceIntroCopy({ firstContact: false, historyLength: 3, hasQuiz: false, hasVehicle: false, isIntro: true }) === false, 'a zero-vehicle user keeps the welcome (REGISTER CTA)');
check(shouldReplaceIntroCopy({ firstContact: true, historyLength: 0, hasQuiz: false, hasVehicle: false, isIntro: true }) === false, 'first contact always keeps the welcome');
check(shouldReplaceIntroCopy({ firstContact: false, historyLength: 2, hasQuiz: true, hasVehicle: false, isIntro: true }) === false, 'an active quiz is never replaced');
check(shouldReplaceIntroCopy({ firstContact: false, historyLength: 2, hasQuiz: false, hasVehicle: true, isIntro: true, wantsIntro: true }) === false, 'an explicit intro request is honoured');
check(isRepeatedReply({ quizActive: false, reply: 'Same', lastPrompt: 'Same' }) === true, 'identical replies are flagged');
check(isRepeatedReply({ quizActive: true, reply: 'Same', lastPrompt: 'Same' }) === false, 'quiz questions may repeat');
check(isRepeatedReply({ quizActive: false, reply: 'A', lastPrompt: 'B' }) === false, 'different replies pass');

console.log('--- Test 4c: stop/pause recognition (v1.25.2) ---');
check(isStopRequest('Stop') === true, 'a bare stop pauses');
check(isStopRequest('please pause') === true, 'please pause pauses');
check(isStopRequest('unsubscribe') === true, 'unsubscribe pauses');
check(isStopRequest('stop with the many replies') === true, 'frustration phrasing pauses');
check(isStopRequest('Stop at the petrol station') === false, 'a business sentence is not an opt-out');
check(isStopRequest('I want to cancel my subscription') === false, 'subscription cancellation stays with its flow');
check(/\bPaused\b/.test(PAUSE_REPLY) && /[\p{Extended_Pictographic}]/u.test(PAUSE_REPLY), 'the pause reply is warm and emoji-anchored');

console.log('--- Test 4d: repeat nudges rotate (v1.25.4) ---');
check(REPEAT_NUDGES.length >= 2, 'at least two nudges exist');
check(pickRepeatNudge(0) === REPEAT_NUDGES[0], 'the first repeat uses the first nudge');
check(pickRepeatNudge(1) === REPEAT_NUDGES[1], 'the second repeat uses a different nudge');
check(pickRepeatNudge(2) === REPEAT_NUDGES[0], 'the rotation wraps around');
for (const nudge of REPEAT_NUDGES) {
  check(/REGISTER/.test(nudge) && /[\p{Extended_Pictographic}]/u.test(nudge), 'every nudge carries the CTA and an emoji anchor');
}

console.log('--- Test 4e: the welcome survives the plate guard (v1.25.6) ---');
check(shouldReplacePlateAsk({ asksPlate: true, hasVehicle: false, hasQuiz: false, firstContact: true, isWelcome: false }) === false, 'a first-contact reply is never replaced');
check(shouldReplacePlateAsk({ asksPlate: true, hasVehicle: false, hasQuiz: false, firstContact: false, isWelcome: true }) === false, 'welcome copy is never replaced');
check(shouldReplacePlateAsk({ asksPlate: true, hasVehicle: false, hasQuiz: false, firstContact: false, isWelcome: false }) === true, 'a plain plate ask to a zero-vehicle user is replaced');
check(shouldReplacePlateAsk({ asksPlate: true, hasVehicle: true, hasQuiz: false, firstContact: false, isWelcome: false }) === false, 'registered users are never re-routed');
check(shouldReplacePlateAsk({ asksPlate: true, hasVehicle: false, hasQuiz: true, firstContact: false, isWelcome: false }) === false, 'an active quiz owns the plate question');
check(shouldReplacePlateAsk({ asksPlate: true, hasVehicle: false, hasQuiz: false, firstContact: false, isWelcome: false, explicitRegister: true }) === false, 'an explicit REGISTER is honoured');
check(shouldReplacePlateAsk({ asksPlate: false, hasVehicle: false, hasQuiz: false, firstContact: false }) === false, 'replies without a plate ask are untouched');

console.log('--- Test 5: emoji discipline ---');
check(emojiCount(sakaIntroText({ countryInfo: usa, nextStep: '' })) <= 4, 'US intro stays within the ceiling');
check(!/₹|\$|KES|INR/.test(intro), 'no currency figures inside the intro (figures stay plain)');

console.log('--- Test 6: the greeting linter never re-greets (v1.28.0) ---');
check(sanitizeSakaReply('Habari! Your insurance expires in 7 days.', 'FACTS', { historyLength: 4 }) === 'FACTS', 'a repeated greeting opener is replaced once the conversation has history');
check(sanitizeSakaReply('Habari! I am Saka.', 'FACTS', { historyLength: 0 }) === 'Habari! I am Saka.', 'first contact keeps its greeting');
check(sanitizeSakaReply('Your insurance expires in 7 days.', 'FACTS', { historyLength: 4 }) === 'Your insurance expires in 7 days.', 'a substance-first reply passes untouched');
check(sanitizeSakaReply('Good — saved.', 'FACTS', { historyLength: 4 }) === 'Good — saved.', 'a non-greeting "Good" is not mistaken for a greeting');
check(sanitizeSakaReply('Good morning! Your report is ready.', 'FACTS', { historyLength: 2 }) === 'FACTS', 'a time-of-day greeting opener is replaced');

console.log(`\n🎉 ${passed} greeting & emoji assertions passed.`);

check(NEWCOMER_NUDGES.every((n) => !/keep moving/i.test(n)), 'newcomer nudges never say keep moving');
check(pickNewcomerNudge(0) !== pickNewcomerNudge(1), 'newcomer nudges rotate');
check(isFirstTimeMessage('This is my first time!!!!') === true, 'first-time message detected');
check(isFirstTimeMessage("Let's keep moving to what?") === true, 'confused reply to the nudge gets the welcome');
check(isFirstTimeMessage('Logged 40L at 50350 km') === false, 'normal log is not a first-time message');
