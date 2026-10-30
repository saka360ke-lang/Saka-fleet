/**
 * Saka Fleet — Dunning & re-engagement suite (v1.16.3)
 * ----------------------------------------------------
 * Offline (mock Supabase). Asserts the T+1/T+3 dunning ladder, its two-notice
 * cap and counter healing, plus the 14-day silence nudge and its dedupe.
 *
 * Run: node --env-file=.env test_dunning_reengagement.js
 */

import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { processPastDueDunning, processSilentReengagement } from './src/services/trialEngine.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-15T09:00:00Z');
const daysAgo = (days, base = NOW) => new Date(base.getTime() - days * DAY_MS).toISOString();

const checkoutStub = async () => ({ ok: true, checkoutUrl: 'https://pay.test/renew' });

function ownerProfile(overrides = {}) {
  return {
    id: 'owner-1',
    phone_number: '+254700000001',
    full_name: 'Test Owner',
    email: 'owner@example.com',
    subscription_tier: 'growth',
    subscription_status: 'PAST_DUE',
    billing_interval: 'monthly',
    subscription_period_end: daysAgo(2),
    past_due_notice_count: 0,
    reengage_nudged_at: null,
    deleted_at: null,
    ...overrides
  };
}

function makeStats() {
  return { scanned: 0, sent: 0, dunning: 0, reengaged: 0 };
}

async function run() {
  console.log('=== DUNNING & RE-ENGAGEMENT (v1.16.3) ===\n');

  console.log('--- Test 1: T+1 notice, then quiet until T+3 ---');
  const mock = createMockSupabase({ profiles: [ownerProfile()], vehicles: [], chat_transcripts: [] });
  const sent = [];
  const sendFn = async (phone, text) => { sent.push({ phone, text }); };

  const stats1 = makeStats();
  await processPastDueDunning({ supabase: mock.client, sendWhatsAppFn: sendFn, now: NOW, stats: stats1, checkoutFn: checkoutStub });
  check(stats1.dunning === 1, 'One T+1 dunning notice is sent');
  check(/renewal did not go through/i.test(sent[0].text), 'Copy names the failed renewal');
  check(sent[0].text.includes('https://pay.test/renew'), 'Engine checkout link is included');
  check(mock.db.profiles[0].past_due_notice_count === 1, 'Notice counter is stamped');

  const stats2 = makeStats();
  await processPastDueDunning({ supabase: mock.client, sendWhatsAppFn: sendFn, now: NOW, stats: stats2, checkoutFn: checkoutStub });
  check(stats2.dunning === 0, 'Same-day sweep does not repeat the notice');

  console.log('\n--- Test 2: T+3 notice, then the two-notice cap ---');
  const later = new Date(NOW.getTime() + 2 * DAY_MS);
  const stats3 = makeStats();
  await processPastDueDunning({ supabase: mock.client, sendWhatsAppFn: sendFn, now: later, stats: stats3, checkoutFn: checkoutStub });
  check(stats3.dunning === 1, 'Second notice fires at T+3');
  check(mock.db.profiles[0].past_due_notice_count === 2, 'Counter reaches 2');

  const muchLater = new Date(NOW.getTime() + 6 * DAY_MS);
  const stats4 = makeStats();
  await processPastDueDunning({ supabase: mock.client, sendWhatsAppFn: sendFn, now: muchLater, stats: stats4, checkoutFn: checkoutStub });
  check(stats4.dunning === 0, 'Cap holds — never a third notice');

  console.log('\n--- Test 3: counters heal once the account is no longer PAST_DUE ---');
  const healedMock = createMockSupabase({
    profiles: [ownerProfile({ subscription_status: 'ACTIVE', past_due_notice_count: 2, past_due_notified_at: daysAgo(2) })],
    chat_transcripts: []
  });
  await processPastDueDunning({ supabase: healedMock.client, sendWhatsAppFn: sendFn, now: NOW, stats: makeStats(), checkoutFn: checkoutStub });
  check(healedMock.db.profiles[0].past_due_notice_count === 0, 'Renewed account counter resets to 0');

  console.log('\n--- Test 4: 14-day silence nudge fires exactly once ---');
  const quietMock = createMockSupabase({
    profiles: [ownerProfile({ id: 'owner-2', subscription_status: 'ACTIVE', phone_number: '+254700000002', reengage_nudged_at: null })],
    vehicles: [{ id: 'v1', owner_id: 'owner-2', plate_number: 'KDA 123A', deleted_at: null }],
    chat_transcripts: [{ phone_number: '+254700000002', created_at: daysAgo(14), sender: 'user', message_text: 'hi' }]
  });
  const quietSent = [];
  const quietStats = makeStats();
  await processSilentReengagement({ supabase: quietMock.client, sendWhatsAppFn: async (phone, text) => { quietSent.push({ phone, text }); }, now: NOW, stats: quietStats });
  check(quietStats.reengaged === 1, 'One re-engagement nudge is sent');
  check(/quick win/i.test(quietSent[0].text), 'Nudge copy is deterministic and warm');
  check(Boolean(quietMock.db.profiles[0].reengage_nudged_at), 'Dedupe stamp is written');

  const quietStats2 = makeStats();
  await processSilentReengagement({ supabase: quietMock.client, sendWhatsAppFn: async () => { throw new Error('should not send'); }, now: NOW, stats: quietStats2 });
  check(quietStats2.reengaged === 0, 'Second run never re-nudges the same owner');

  console.log('\n--- Test 5: recent activity and vehicle-less owners are ignored ---');
  const recentMock = createMockSupabase({
    profiles: [ownerProfile({ id: 'owner-3', subscription_status: 'ACTIVE', phone_number: '+254700000003' })],
    vehicles: [{ id: 'v2', owner_id: 'owner-3', deleted_at: null }],
    chat_transcripts: [{ phone_number: '+254700000003', created_at: daysAgo(2) }]
  });
  let recentSends = 0;
  await processSilentReengagement({ supabase: recentMock.client, sendWhatsAppFn: async () => { recentSends += 1; }, now: NOW, stats: makeStats() });
  check(recentSends === 0, 'Active user is never nudged');

  const noVehicleMock = createMockSupabase({
    profiles: [ownerProfile({ id: 'owner-4', subscription_status: 'ACTIVE', phone_number: '+254700000004' })],
    vehicles: [],
    chat_transcripts: [{ phone_number: '+254700000004', created_at: daysAgo(14) }]
  });
  let noVehicleSends = 0;
  await processSilentReengagement({ supabase: noVehicleMock.client, sendWhatsAppFn: async () => { noVehicleSends += 1; }, now: NOW, stats: makeStats() });
  check(noVehicleSends === 0, 'Owner without an active vehicle is ignored');

  console.log(`\n🎉 ${passed} dunning/re-engagement assertions passed.`);
}

run().catch((err) => {
  console.error('\n❌ Dunning/re-engagement suite failed:', err.message);
  process.exit(1);
});
