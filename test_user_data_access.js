import assert from 'assert';
import { buildUserContextSnapshot, buildUserFactsLines } from './src/services/userContextSnapshot.js';

/**
 * Saka Fleet — user data access (v1.52.0 → v1.54.0 ANSWER LAW v2). Stateless.
 *
 * The snapshot must carry the user's OWN data — expiry dates, driver
 * compliance, trial end, recent ledger rows and the one populate step for
 * every missing field — so Saka can answer "when does my insurance expire?"
 * or "what did I log yesterday?" from the facts and can never be forced into
 * an access refusal.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — USER DATA ACCESS TESTS (v1.54.0) ===\n');

const AMINA_PROFILE = {
  full_name: 'Amina Yusuf',
  subscription_tier: 'free',
  subscription_status: 'TRIALING',
  trial_ends_at: '2027-02-01T05:52:40Z',
  compliance_type: 'Driver Licence',
  compliance_expiry: '2027-01-31',
  email: 'amina@gmail.com',
  email_verified: true
};

const AMINA_VEHICLE = {
  id: 'vehicle-1',
  plate_number: 'KDA 123A',
  make_model: 'Toyota Fielder',
  current_mileage: 367480,
  fuel_type: 'diesel',
  insurance_expiry: '2026-11-20',
  inspection_expiry: null
};

const snapshot = await buildUserContextSnapshot({
  profile: AMINA_PROFILE,
  vehicles: [AMINA_VEHICLE],
  currency: 'KES',
  now: new Date('2026-11-03T12:00:00Z')
});

const facts = snapshot.lines.join('\n');
check(/KDA 123A insurance expires 2026-11-20/.test(facts), 'vehicle insurance expiry is in the snapshot facts');
check(/in 17 days/.test(facts), 'insurance days-left is computed (17 days)');
check(/Your compliance: Driver Licence expires 2027-01-31/.test(facts), 'driver compliance expiry is in the snapshot facts');
check(/Trial ends: 2027-02-01/.test(facts), 'trial end date is in the snapshot facts');
check(/verified ✅/.test(facts) && facts.includes('am…@gmail.com'), 'the verified email state is in the snapshot facts (v1.53.2)');
check(snapshot.data.vehicles[0].insuranceExpiry === '2026-11-20', 'the structured data carries the expiry value');
check(snapshot.data.vehicles[0].plate === 'KDA 123A', 'the structured data keeps the plate');

// v1.58.13 — a free/ACTIVE profile carrying a legacy phantom trial_ends_at must
// NOT report a trial end (the old now()+90d DB default leaked as a fake trial).
const phantom = await buildUserContextSnapshot({
  profile: { full_name: 'Fresh Owner', subscription_tier: 'free', subscription_status: 'ACTIVE', trial_ends_at: '2027-02-02T00:00:00Z' },
  now: new Date('2026-11-04T12:00:00Z')
});
check(!/Trial ends:/.test(phantom.lines.join('\n')), 'a free/ACTIVE phantom trial_ends_at never reports a trial end (v1.58.13)');

const empty = await buildUserContextSnapshot({});
check(empty.lines.join(' ').includes('Vehicles on file: none yet'), 'an empty account honestly states what is missing');
check(!/insurance expires/.test(empty.lines.join(' ')), 'no invented expiry for an empty account');

console.log('\n--- v1.54.0: ANSWER LAW v2 — one populate step per missing field ---');

check(/Missing \(each has one fill step\):/.test(facts), 'the snapshot names missing fields with one fill step each');
check(/inspection expiry —/.test(facts), 'the missing inspection expiry carries its populate step');
check(snapshot.data.populateSteps?.length === 1, 'exactly one missing step for Amina (inspection)');
check(!/driver licence —/.test(facts), 'a present driver licence is not listed as missing');
const emptyFacts = empty.lines.join(' ');
check(/Missing \(each has one fill step\):/.test(emptyFacts), 'an empty account lists the missing fields with steps');
check(!/insurance expires/.test(emptyFacts), 'the populate step never invents an expiry date');
check(!/driver licence —/.test(emptyFacts), 'a zero-vehicle account is not asked for a driver licence before a vehicle (v1.58.12)');

console.log('\n--- v1.54.0: recent ledger rides the snapshot ---');

function fakeBuilder(rows) {
  const self = {
    select: () => self,
    in: () => self,
    gte: () => self,
    eq: () => self,
    is: () => self,
    limit: () => self,
    order: () => self,
    then(resolve) { resolve({ data: rows, error: null }); }
  };
  return self;
}
const fakeSupabase = {
  from(table) {
    const rows = {
      expense_logs: [{ amount: 5500, expense_type: 'Fuel', created_at: '2026-11-02T10:00:00Z', vehicle_id: 'vehicle-1' }],
      private_earnings: [{ revenue_amount: 18000, earning_type: 'Cargo & freight', created_at: '2026-11-01T09:00:00Z', vehicle_id: 'vehicle-1' }],
      reminders: []
    }[table] || [];
    return fakeBuilder(rows);
  }
};
const ledgerSnapshot = await buildUserContextSnapshot({
  supabase: fakeSupabase,
  profile: AMINA_PROFILE,
  vehicles: [AMINA_VEHICLE],
  currency: 'KES',
  now: new Date('2026-11-03T12:00:00Z')
});
const ledgerFacts = ledgerSnapshot.lines.join('\n');
check(/Recent logs:/.test(ledgerFacts) && ledgerFacts.includes('Fuel KES 5,500 (KDA 123A)'), 'recent expense rows ride the snapshot with plate');
check(ledgerFacts.includes('earned KES 18,000'), 'recent earning rows ride the snapshot');
check(Array.isArray(ledgerSnapshot.data.ledger) && ledgerSnapshot.data.ledger.length === 2, 'the structured ledger data is exposed');

const capped = await buildUserFactsLines({
  supabase: fakeSupabase,
  profile: AMINA_PROFILE,
  vehicles: [AMINA_VEHICLE],
  currency: 'KES',
  maxLines: 3
});
check(capped.split('\n').length === 3, 'buildUserFactsLines caps the fact lines (prompt budget)');

console.log(`\n🎉 ${passed} user-data-access assertions passed.`);
