import {
  parseFlexibleDate,
  formatNairobiDate,
  getNairobiParts,
  SYSTEM_TIMEZONE
} from './src/services/dateParser.js';
import { getFlowDefinition } from './src/services/quizEngine.js';

/**
 * Targeted suite: global date parsing + Nairobi normalization.
 * Stateless — no database rows are created.
 */

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  passed += 1;
  console.log(`✅ ${msg}`);
}

const FIXED_NOW = new Date('2026-10-28T09:00:00+03:00'); // Wednesday in Nairobi
const opts = { countryCode: 'KE', locale: 'en-KE', now: FIXED_NOW };

function run() {
  console.log('--- Test 1: ISO & named formats ---');
  assert(parseFlexibleDate('2027-05-15', opts).localDate === '2027-05-15', 'ISO date parsed');
  assert(parseFlexibleDate('2027-05-15T10:30:00Z', opts).localDate === '2027-05-15', 'ISO with time parsed');
  assert(parseFlexibleDate('15th October 2026', opts).localDate === '2026-10-15', 'Ordinal + month name parsed');
  assert(parseFlexibleDate('October 15, 2026', opts).localDate === '2026-10-15', 'Month-first named date parsed');
  assert(parseFlexibleDate('15 Oct 2026', opts).localDate === '2026-10-15', 'Abbreviated month parsed');

  console.log('\n--- Test 2: DD/MM vs MM/DD country conventions ---');
  assert(parseFlexibleDate('15/10/2026', opts).localDate === '2026-10-15', 'Day-first unambiguous (KE)');
  assert(parseFlexibleDate('10/15/2026', opts).localDate === '2026-10-15', 'Month-first unambiguous (KE)');
  assert(parseFlexibleDate('05/06/2026', opts).localDate === '2026-06-05', 'Ambiguous 05/06 resolves day-first for KE');
  assert(parseFlexibleDate('05/06/2026', { countryCode: 'US', locale: 'en-US', now: FIXED_NOW }).localDate === '2026-05-06', 'Ambiguous 05/06 resolves month-first for US');
  assert(parseFlexibleDate('31/12/26', opts).localDate === '2026-12-31', 'Two-digit year expanded');
  assert(parseFlexibleDate('31/02/2026', opts).ok === false, 'Impossible calendar date rejected');

  console.log('\n--- Test 3: Natural language & relative dates ---');
  assert(parseFlexibleDate('today', opts).localDate === formatNairobiDate(FIXED_NOW), 'Today resolves in Nairobi');
  assert(parseFlexibleDate('tomorrow', opts).localDate === '2026-10-29', 'Tomorrow resolved');
  assert(parseFlexibleDate('yesterday', opts).localDate === '2026-10-27', 'Yesterday resolved');
  assert(parseFlexibleDate('in 2 weeks', opts).localDate === '2026-11-11', 'Relative weeks resolved');
  assert(parseFlexibleDate('next Monday', opts).localDate === '2026-11-02', 'Next Monday resolved');
  assert(parseFlexibleDate('this Friday', opts).localDate === '2026-10-30', 'This Friday resolved');
  assert(parseFlexibleDate('10 days from now', opts).localDate === '2026-11-07', 'N days from now resolved');

  console.log('\n--- Test 4: Africa/Nairobi normalization ---');
  const lateUtc = new Date('2026-10-28T22:30:00Z'); // 01:30 on 29 Oct in Nairobi
  const parts = getNairobiParts(lateUtc);
  assert(parts.day === 29, 'Late UTC instant rolls to the next Nairobi day');
  assert(formatNairobiDate(lateUtc) === '2026-10-29', 'formatNairobiDate uses Africa/Nairobi');
  assert(SYSTEM_TIMEZONE === 'Africa/Nairobi', 'System timezone constant is Nairobi');
  const parsed = parseFlexibleDate('tomorrow', { now: lateUtc, countryCode: 'KE' });
  assert(parsed.localDate === '2026-10-30', 'Relative dates are computed from the Nairobi calendar day');

  console.log('\n--- Test 5: quiz fields use the global parser ---');
  const ctx = {
    countryInfo: { country: 'Kenya', country_code: 'KE', locale: 'en-KE' },
    profile: { unit_system: 'metric' }
  };
  const regFlow = getFlowDefinition('vehicle_registration', ctx);
  const insurance = regFlow.fields.find((f) => f.key === 'insurance_expiry');
  assert(insurance.parse('15/10/2027', ctx) === '2027-10-15', 'Registration insurance expiry uses DD/MM (KE)');
  const usCtx = { ...ctx, countryInfo: { ...ctx.countryInfo, country_code: 'US', locale: 'en-US' } };
  assert(insurance.parse('10/15/2027', usCtx) === '2027-10-15', 'Registration insurance expiry uses MM/DD (US)');

  console.log(`\n🎉 ALL DATE PARSER TESTS PASSED (${passed} assertions).`);
}

run();
