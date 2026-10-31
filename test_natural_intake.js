// v1.24.0 - Conversation-first intake regression suite (DB-free).
// Proves paragraph parsing captures full vehicle stories and that the
// prompts no longer encourage questionnaire-style interrogations.
import { extractVehicleAttributes, DEFAULT_SAKA_CORE_PROMPT } from './sakaAi.js';
import { SAKA_BOUNDARY_RULES } from './src/services/flowKnowledge.js';
import {
  QUIZ_INSTRUCTION_NATURAL,
  QUIZ_INSTRUCTION_STRICT,
  buildQuizQuestionInstruction
} from './src/services/conversationEngine.js';

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

console.log('=== Natural intake: paragraph parsing ===');

const story = extractVehicleAttributes(
  'I bought a Toyota Fielder 2016 diesel at 120,000 km for KES 1,250,000, registration KDA 123A'
);
check('paragraph make/model', /Toyota/i.test(String(story.make_model)), story.make_model);
check('paragraph year', story.yom === 2016, story.yom);
check('paragraph fuel', /diesel/i.test(String(story.fuel_type)), story.fuel_type);
check('paragraph mileage', story.current_mileage === 120000, story.current_mileage);
check('paragraph purchase cost', story.purchase_cost === 1250000, story.purchase_cost);
check('paragraph plate', /KDA\s*123A/i.test(String(story.plate_number)), story.plate_number);

const secondStory = extractVehicleAttributes(
  'My car is a 2018 Nissan Note, petrol, 88,500km, plate KCX 456Z'
);
check('second story make/model', /Nissan/i.test(String(secondStory.make_model)), secondStory.make_model);
check('second story year', secondStory.yom === 2018, secondStory.yom);
check('second story mileage', secondStory.current_mileage === 88500, secondStory.current_mileage);

const fuelStory = extractVehicleAttributes('I bought fuel for KES 5,500 yesterday');
check('fuel spend never becomes purchase cost', !fuelStory.purchase_cost, fuelStory.purchase_cost);

const derivedFuel = extractVehicleAttributes('Topped up fuel; 1000kes @227kes per liter, @367365km');
check('live fuel spend parsed', derivedFuel.amount === 1000, derivedFuel.amount);
check('litres derived from spend / price per litre', derivedFuel.fuel_liters === 4.41, derivedFuel.fuel_liters);
check('derived volume is flagged', derivedFuel.derived_fuel_liters === true, derivedFuel.derived_fuel_liters);
const explicitFuel = extractVehicleAttributes('Logged 40L at 50350 km for KES 5500');
check('an explicit volume is never overwritten', explicitFuel.fuel_liters === 40, explicitFuel.fuel_liters);

console.log('=== Natural intake: prompt & boundary rules ===');

check(
  'core prompt carries natural-conversation directive',
  String(DEFAULT_SAKA_CORE_PROMPT).includes('NATURAL CONVERSATION FIRST')
);
check(
  'core prompt bans form-like questions',
  /never sound like a form/i.test(String(DEFAULT_SAKA_CORE_PROMPT))
);
check(
  'boundary rules default to natural intake',
  SAKA_BOUNDARY_RULES.some((rule) => /Natural conversation is the default intake style/.test(rule))
);
check(
  'quiz instruction is natural by default',
  buildQuizQuestionInstruction(true) === QUIZ_INSTRUCTION_NATURAL
);
check(
  'NATURAL_INTAKE=off restores the strict instruction',
  buildQuizQuestionInstruction(false) === QUIZ_INSTRUCTION_STRICT
    && /State the current question exactly once/.test(QUIZ_INSTRUCTION_STRICT)
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
