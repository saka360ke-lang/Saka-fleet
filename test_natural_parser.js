/**
 * Saka Fleet - Natural Conversational Parser Test Suite (stateless)
 * ------------------------------------------------------------------
 * Verifies deterministic multi-field extraction, the extra-notes catch-all,
 * missing-field computation and graceful AI degradation. No database writes.
 *
 * Run: node test_natural_parser.js
 */

import assert from 'assert';
import {
  extractDeterministicFields,
  extractWithAI,
  extractEntitiesFromText,
  mergeExtraNotes,
  formatExtraNotes,
  isSubstantiveText,
  MAX_EXTRA_NOTES
} from './src/services/naturalParser.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`\u2705 ${message}`);
}

const ctx = {
  countryInfo: { country: 'Kenya', country_code: 'KE', default_units: 'metric', currency: 'KES', locale: 'en-KE' },
  profile: { id: 'p1', unit_system: 'metric', preferred_language: 'English' },
  language: 'English'
};

function fakeField(key, label, parse, validate, optional = false) {
  return {
    key,
    label,
    hint: `${label} hint`,
    optional,
    aliases: [key],
    kind: 'text',
    parse,
    validate: validate || (() => ({ ok: true }))
  };
}

const flowDef = {
  label: 'Vehicle profile',
  fields: [
    fakeField('make_model', 'Make and model', (t) => {
      const m = String(t).match(/(toyota|nissan|hino|isuzu)[a-z\s]*/i);
      return m ? m[0].trim() : null;
    }),
    fakeField('yom', 'Year of manufacture', (t) => {
      const m = String(t).match(/\b(19\d{2}|20\d{2})\b/);
      return m ? Number(m[0]) : null;
    }),
    fakeField('fuel_type', 'Fuel type', (t) => {
      if (/diesel/i.test(t)) return 'Diesel';
      if (/petrol/i.test(t)) return 'Petrol';
      return null;
    }),
    fakeField('odometer', 'Odometer reading', (t) => {
      const m = String(t).match(/(\d[\d,]*)\s*km/i);
      return m ? Number(m[1].replace(/,/g, '')) : null;
    }),
    fakeField('notes', 'Notes', (t) => String(t).trim() || null, null, true)
  ]
};

async function run() {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY; // keep this suite fully offline

  try {
    console.log('--- Test 1: deterministic multi-field extraction ---');
    const det = extractDeterministicFields({
      text: 'Toyota Hilux 2018 diesel, 88000 km on the clock',
      flowDef,
      answers: {},
      ctx
    });
    check(det.reached === true, 'Deterministic extraction reaches at least one field');
    check(det.fields.make_model === 'Toyota Hilux', 'Make/model is captured from conversational text');
    check(det.fields.yom === 2018, 'Year of manufacture is captured');
    check(det.fields.fuel_type === 'Diesel', 'Fuel type is captured');
    check(det.fields.odometer === 88000, 'Odometer with a km marker is captured');

    const detPartial = extractDeterministicFields({
      text: 'Toyota Hilux 2018',
      flowDef,
      answers: { make_model: 'Toyota Hilux' },
      ctx
    });
    check(detPartial.fields.yom === 2018, 'Already-collected fields are skipped');
    check(detPartial.fields.make_model === undefined, 'Existing values are never overwritten');

    console.log('\n--- Test 2: extra-notes catch-all ---');
    const merged = mergeExtraNotes(
      ['Always serviced at Shell, Mombasa Road'],
      ['Always serviced at shell, mombasa road', 'Driver reports a slight rattle when cold', 'hi']
    );
    check(merged.length === 2, 'Duplicate and small-talk notes are filtered');
    check(merged[1] === 'Driver reports a slight rattle when cold', 'Relevant unmapped details are retained');
    check(formatExtraNotes(merged) === 'Always serviced at Shell, Mombasa Road | Driver reports a slight rattle when cold',
      'Extra notes compile into one formatted string');

    const many = mergeExtraNotes([], Array.from({ length: 10 }, (_, i) => `note number ${i}`));
    check(many.length === MAX_EXTRA_NOTES, 'Extra notes are capped to avoid note bloat');
    check(mergeExtraNotes([], ['ok', 'yes', 'no', '']).length === 0, 'Control/small-talk text never becomes a note');

    console.log('\n--- Test 3: substantive text detection ---');
    check(isSubstantiveText('always serviced at Shell on Mombasa road') === true, 'Detailed sentences are substantive');
    check(isSubstantiveText('hi') === false, 'Greetings are not substantive');
    check(isSubstantiveText('cancel') === false, 'Control words are not substantive');
    check(isSubstantiveText('1250') === true, 'Numeric answers count as substantive');

    console.log('\n--- Test 4: AI extraction degrades gracefully offline ---');
    const ai = await extractWithAI({ text: 'Toyota Hilux 2018 diesel', flowDef, answers: {}, ctx });
    check(ai.fields && Object.keys(ai.fields).length === 0, 'Missing API key returns no AI fields');
    check(ai.skipped === 'no-api-key', 'AI degradation is explicit (no throw)');

    const combined = await extractEntitiesFromText({
      text: 'Toyota Hilux diesel, 88000 km',
      flowDef,
      answers: {},
      ctx,
      useAI: true
    });
    check(combined.fields.odometer === 88000, 'Combined pipeline keeps deterministic results without AI');
    check(combined.source === 'deterministic+ai', 'Source reflects the attempted AI top-up');
    check(combined.missing.some((m) => m.key === 'yom'), 'Offline AI top-up leaves required gaps visible for dynamic prompts');

    const complete = await extractEntitiesFromText({
      text: 'Toyota Hilux 2018 diesel, 88000 km',
      flowDef,
      answers: {},
      ctx,
      useAI: false
    });
    check(complete.missing.length === 0, 'All required fields satisfied yields zero missing fields');

    const incomplete = await extractEntitiesFromText({
      text: 'Toyota Hilux',
      flowDef,
      answers: {},
      ctx,
      useAI: false
    });
    check(incomplete.missing.some((m) => m.key === 'yom'), 'Missing required fields are computed for dynamic prompts');
    check(incomplete.missing.some((m) => m.key === 'notes') === false, 'Optional notes are excluded from dynamic prompts');

    console.log(`\n\u2705 ALL NATURAL PARSER TESTS PASSED (${passed} assertions).`);
    console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
  } finally {
    if (originalKey !== undefined) process.env.DEEPSEEK_API_KEY = originalKey;
  }
}

run().catch((err) => {
  console.error('\u274C TEST FAILED:', err.message);
  process.exit(1);
});

