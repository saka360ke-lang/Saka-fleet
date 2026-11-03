import assert from 'assert';
import { buildUserContextSnapshot } from './src/services/userContextSnapshot.js';

/**
 * Saka Fleet — user data access (v1.52.0). Stateless.
 *
 * The snapshot must carry the user's OWN data — expiry dates, driver
 * compliance, trial end — so Saka can answer "when does my insurance expire?"
 * from the facts and can never be forced into an access refusal.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — USER DATA ACCESS TESTS (v1.52.0) ===\n');

const snapshot = await buildUserContextSnapshot({
  profile: {
    full_name: 'Amina Yusuf',
    subscription_tier: 'free',
    subscription_status: 'TRIALING',
    trial_ends_at: '2027-02-01T05:52:40Z',
    compliance_type: 'Driver Licence',
    compliance_expiry: '2027-01-31'
  },
  vehicles: [
    {
      id: 'vehicle-1',
      plate_number: 'KDA 123A',
      make_model: 'Toyota Fielder',
      current_mileage: 367480,
      fuel_type: 'diesel',
      insurance_expiry: '2026-11-20',
      inspection_expiry: null
    }
  ],
  currency: 'KES',
  now: new Date('2026-11-03T12:00:00Z')
});

const facts = snapshot.lines.join('\n');
check(/KDA 123A insurance expires 2026-11-20/.test(facts), 'vehicle insurance expiry is in the snapshot facts');
check(/in 17 days/.test(facts), 'insurance days-left is computed (17 days)');
check(/Your compliance: Driver Licence expires 2027-01-31/.test(facts), 'driver compliance expiry is in the snapshot facts');
check(/Trial ends: 2027-02-01/.test(facts), 'trial end date is in the snapshot facts');
check(snapshot.data.vehicles[0].insuranceExpiry === '2026-11-20', 'the structured data carries the expiry value');
check(snapshot.data.vehicles[0].plate === 'KDA 123A', 'the structured data keeps the plate');

const empty = await buildUserContextSnapshot({});
check(empty.lines.join(' ').includes('Vehicles on file: none yet'), 'an empty account honestly states what is missing');
check(!/insurance expires/.test(empty.lines.join(' ')), 'no invented expiry for an empty account');

console.log(`\n🎉 ${passed} user-data-access assertions passed.`);
