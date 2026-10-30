import assert from 'assert';
import {
  resolveDaypart,
  greetingFor,
  sakaIntroText,
  isFirstContact,
  isIntroCopy,
  wantsIntroduction
} from './src/services/greetings.js';

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
check(/number plate/i.test(intro), 'intro ends with ONE clear next step');
check(emojiCount(intro) <= 4, `intro respects the welcome emoji ceiling (${emojiCount(intro)})`);
const noStep = sakaIntroText({ countryInfo: india, nextStep: '' });
check(!/number plate/i.test(noStep), 'next step can be omitted when the plate is already known');
const named = sakaIntroText({ countryInfo: kenya, profile: { full_name: 'Amina Yusuf' } });
check(named.includes('Amina'), 'returning profile name is used warmly');

console.log('--- Test 4: first-contact detection ---');
check(isFirstContact({ session: {}, dbHistory: [], hasVehicleRegistered: false }) === true, 'fresh number is first contact');
check(isFirstContact({ session: {}, dbHistory: [{ role: 'user' }], hasVehicleRegistered: false }) === false, 'existing chat history is not first contact');
check(isFirstContact({ session: { history: [{ role: 'user' }] }, dbHistory: [], hasVehicleRegistered: false }) === false, 'in-memory history is not first contact');
check(isFirstContact({ session: { sakaIntroduced: true }, dbHistory: [], hasVehicleRegistered: false }) === false, 'intro never repeats');
check(isFirstContact({ session: {}, dbHistory: [], hasVehicleRegistered: true }) === false, 'registered users skip the intro');

console.log('--- Test 4b: intro-copy guard (v1.19.2) ---');
check(isIntroCopy('Karibu to Saka Fleet! I help you keep track of your vehicles') === true, 'a fresh Karibu welcome is detected');
check(isIntroCopy("Hi! I'm Saka, your vehicle's co-pilot on WhatsApp.") === true, 'the English Saka intro is detected');
check(isIntroCopy('Your insurance expires on 2027-05-15') === false, 'normal replies are not mistaken for intros');
check(wantsIntroduction('who are you?') === true, 'an explicit introduction request is recognised');
check(wantsIntroduction('still waiting') === false, 'a generic nudge is not an introduction request');

console.log('--- Test 5: emoji discipline ---');
check(emojiCount(sakaIntroText({ countryInfo: usa, nextStep: '' })) <= 4, 'US intro stays within the ceiling');
check(!/₹|\$|KES|INR/.test(intro), 'no currency figures inside the intro (figures stay plain)');

console.log(`\n🎉 ${passed} greeting & emoji assertions passed.`);
