import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import {
  matchProductQa,
  recommendTierForFleet,
  sanitizeSakaReply,
  buildProductFactsContext
} from './src/services/productQa.js';
import { buildUserContextSnapshot } from './src/services/userContextSnapshot.js';
import { runWithCleanup } from './scripts/testCleanup.js';

/**
 * Saka Fleet — Answer Oracle tests (v1.27.0).
 *
 * Proves three things:
 *  1. Every question from the live 16:00 test routes to the right fact set.
 *  2. The capacity math is computed in code (8 cars -> Fleet Command + 3).
 *  3. The user-data snapshot answers questions about the user's OWN account
 *     (plan, vehicles, this month's spend, reminders) from realtime reads.
 *
 * Stateful data is removed by runWithCleanup (permanent rule 10).
 */

const TEST_PHONE = '+254700000099';
const TEST_VIN = 'SAKATESTORACLE0001';
const TEST_PLATE = 'KDA 999X';

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

console.log('=== SAKA FLEET — ANSWER ORACLE TESTS (v1.27.0) ===\n');

console.log('--- Test 1: the exact live questions route correctly ---');
const routes = [
  ['What are features of saka fleet?', 'features'],
  ['Give me details of each package', 'packages'],
  ['What annual subscriptions are available!!???', 'pricing'],
  ['Annual subscriptions available please?', 'pricing'],
  ['Tell me more about the Team fleet tier', 'tier_details'],
  ['I have 8 cars. Which subscription is best and how do I go about subscribing?', 'pricing'],
  ['What are the costs of using Saka?', 'pricing'],
  ['Why do you need my VIN?', 'why_details']
];
for (const [question, expected] of routes) {
  const entry = matchProductQa(question);
  check(entry?.id === expected, `"${question}" -> ${expected}`);
}

console.log('\n--- Test 2: capacity math ---');
const eight = recommendTierForFleet(8);
check(eight.tierKey === 'fleet_command' && eight.addons === 3, '8 cars -> Fleet Command + 3 add-ons');
check(/5 vehicles included/.test(eight.lines[0]), 'the recommendation states the 5 included vehicles');
check(recommendTierForFleet(3).tierKey === 'team_fleet', '3 cars -> Team Fleet');

console.log('\n--- Test 3: no hedging can be shipped ---');
check(sanitizeSakaReply('I don\'t have any annual-plan discount to confirm.', 'FACTS') === 'FACTS', 'annual hedge is replaced by facts');
check(/annual/i.test(buildProductFactsContext()), 'the fact context carries annual pricing');
check(/features:/i.test(buildProductFactsContext()), 'the fact context carries the feature list');

if (!supabase) {
  console.log('\n⚠️  Supabase credentials missing — snapshot test skipped.');
} else {
  await runWithCleanup({
    phones: [TEST_PHONE],
    vins: [TEST_VIN],
    supabase,
    verbose: false,
    testFn: async () => {
      console.log('\n--- Test 4: the user-data snapshot answers account questions ---');
      const now = new Date();
      const dueDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .insert([{ phone_number: TEST_PHONE, full_name: 'Oracle Tester', subscription_tier: 'free', subscription_status: 'active' }])
        .select('*')
        .single();
      check(!profileErr && profile?.id, `test profile seeded (${profileErr?.message || 'ok'})`);

      const { data: vehicle, error: vehicleErr } = await supabase
        .from('vehicles')
        .insert([{
          owner_id: profile.id,
          owner_phone: TEST_PHONE,
          plate_number: TEST_PLATE,
          make_model: 'Toyota Fielder 2016',
          current_mileage: 120000,
          fuel_type: 'Diesel',
          vin: TEST_VIN,
          status: 'ACTIVE'
        }])
        .select('*')
        .single();
      check(!vehicleErr && vehicle?.id, `test vehicle seeded (${vehicleErr?.message || 'ok'})`);

      await supabase.from('expense_logs').insert([
        { vehicle_id: vehicle.id, expense_type: 'Fuel', amount: 3000, fuel_liters: 40, odometer_reading: 120100 },
        { vehicle_id: vehicle.id, expense_type: 'Service', amount: 1500, fuel_liters: 0, odometer_reading: 120100 }
      ]);
      await supabase.from('reminders').insert([{
        vehicle_id: vehicle.id,
        reminder_type: 'Insurance Renewal',
        due_date: dueDate,
        status: 'active'
      }]);

      const snapshot = await buildUserContextSnapshot({
        supabase,
        profile,
        vehicles: [vehicle],
        currency: 'KES'
      });
      const text = snapshot.lines.join('\n');
      check(/Oracle Tester/.test(text), 'the snapshot names the user');
      check(/Plan: Free/i.test(text), 'the snapshot states the plan');
      check(/Vehicles on file \(1\)/.test(text) && text.includes(TEST_PLATE), 'the snapshot lists the vehicle and plate');
      check(snapshot.data.month?.total === 4500, 'this month total is computed (4500)');
      check(snapshot.data.month?.litres === 40, 'this month fuel litres are computed (40)');
      check(/KES 4,500/.test(text), 'the money line is formatted with the user currency');
      check(/Insurance Renewal due/.test(text), 'upcoming reminders are listed');
      check(snapshot.data.reminders[0]?.daysLeft >= 29, 'days-left is computed for the reminder');
    }
  });
}

const empty = await buildUserContextSnapshot({});
check(empty.lines.join(' ').includes('Plan: Free'), 'the snapshot never throws without a database');
check(empty.lines.join(' ').includes('none yet'), 'an empty account is described honestly');

console.log(`\n🎉 ${passed} answer-oracle assertions passed.`);
