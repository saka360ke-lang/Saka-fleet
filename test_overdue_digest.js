import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  evaluateExpiryReminders,
  evaluateOverdueDigest,
  runReminderSweep,
  OVERDUE_DIGEST_TABLE
} from './src/services/maintenanceReminders.js';

/**
 * Targeted suite: Phase 29 overdue compliance digest (v1.92.0).
 * D1 HYBRID: the FIRST overdue item of an episode sends its immediate one-shot
 * alert; every later item is stamped but suppressed; ONE digest fires at T+3
 * and ONE at T+7. Stateless (createMockSupabase only).
 */

let passed = 0;
function check(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  passed += 1;
  console.log(`✅ ${msg}`);
}

const OWNER = { id: 'p1', phone_number: '+254700000001' };
const DRIVER = { id: 'd1', phone_number: '+254700000002' };
const VEHICLE = { id: 'v1', owner_id: 'p1', owner_phone: '+254700000001', assigned_driver_id: null, plate_number: 'KDA 123A' };

function reminder(id, dueDate, overrides = {}) {
  return {
    id,
    vehicle_id: 'v1',
    profile_id: null,
    subject_type: 'vehicle',
    subject_id: 'v1',
    category: 'insurance',
    reminder_type: 'Insurance',
    label: 'Insurance',
    due_date: dueDate,
    status: 'active',
    threshold_unit: 'date',
    ...overrides
  };
}

function seed(reminders, extra = {}) {
  return {
    profiles: [{ ...OWNER }, { ...DRIVER }],
    vehicles: [{ ...VEHICLE }],
    reminders,
    expense_logs: [],
    private_earnings: [],
    driver_compliances: [],
    admin_audit_logs: [],
    [OVERDUE_DIGEST_TABLE]: [],
    ...extra
  };
}

function capture(sends) {
  return async (phone, text, _vehicle, kind, templateVars) => {
    sends.push({ phone, text, kind, templateVars });
  };
}

const NOW = new Date('2026-11-10T09:00:00.000Z'); // Nairobi 12:00, Nov 10

async function run() {
  console.log('=== PHASE 29 — OVERDUE COMPLIANCE DIGEST (v1.92.0) ===');

  console.log('\n--- 1. first sweep: immediate alert for item 1, siblings suppressed ---');
  const mock = createMockSupabase(seed([
    reminder('r1', '2026-11-09'),
    reminder('r2', '2026-11-09', { reminder_type: 'Inspection', label: 'Inspection', category: 'inspection' }),
    reminder('r3', '2026-11-09', { reminder_type: 'Permit', label: 'Permit', category: 'permit' })
  ]));
  const sends = [];
  const expiry = await evaluateExpiryReminders({ supabase: mock.client, sendFn: capture(sends), now: NOW });
  check(expiry.dispatched === 1 && sends.length === 1, 'exactly ONE immediate alert fires for the episode (not 3)');
  check(expiry.alerts.filter((alert) => alert.suppressed === true).length === 2, 'the other two overdue items are stamped as suppressed');
  check(mock.db.reminders.every((row) => row.notified_overdue === true), 'every overdue tier is consumed (no re-alert on the next sweep)');
  const firstDigest = await evaluateOverdueDigest({ supabase: mock.client, sendFn: capture(sends), now: NOW });
  check(firstDigest.owners === 1 && firstDigest.overdueItems === 3, 'the digest sees one owner with three overdue items');
  check(firstDigest.sentT3 === 0 && firstDigest.sentT7 === 0 && sends.length === 1, 'no digest yet at T+1 (the immediate alert was the only message)');
  check(mock.db[OVERDUE_DIGEST_TABLE].length === 1 && String(mock.db[OVERDUE_DIGEST_TABLE][0].first_overdue_at).slice(0, 10) === '2026-11-09', 'the episode anchors on the FIRST overdue due date');

  console.log('\n--- 2. T+2: still silent ---');
  const t2 = await evaluateOverdueDigest({ supabase: mock.client, sendFn: capture(sends), now: new Date('2026-11-11T09:00:00.000Z') });
  check(t2.sentT3 === 0 && t2.dispatched === 0 && sends.length === 1, 'no digest two days in');

  console.log('\n--- 3. T+3: ONE consolidated digest ---');
  const t3 = await evaluateOverdueDigest({ supabase: mock.client, sendFn: capture(sends), now: new Date('2026-11-12T09:00:00.000Z') });
  check(t3.sentT3 === 1 && t3.dispatched === 1 && sends.length === 2, 'one digest fires at T+3');
  const t3Send = sends[1];
  check(t3Send.kind === 'overdue_digest' && t3Send.templateVars.count === '3' && t3Send.templateVars.worst_days === '3', 'the digest carries count + worst days (template variables)');
  check(/overdue compliance i/.test(t3Send.text) && /3/.test(t3Send.text), 'the free-form fallback names the count');
  check(String(mock.db[OVERDUE_DIGEST_TABLE][0].sent_t3_at).slice(0, 10) === '2026-11-12', 'sent_t3_at is stamped');
  const repeat = await evaluateOverdueDigest({ supabase: mock.client, sendFn: capture(sends), now: new Date('2026-11-12T09:30:00.000Z') });
  check(repeat.dispatched === 0 && sends.length === 2, 'the same milestone never repeats (30-minute sweep safe)');

  console.log('\n--- 4. T+7: the second digest ---');
  const t7 = await evaluateOverdueDigest({ supabase: mock.client, sendFn: capture(sends), now: new Date('2026-11-16T09:00:00.000Z') });
  check(t7.sentT7 === 1 && sends.length === 3, 'exactly one more digest at T+7');
  check(String(mock.db[OVERDUE_DIGEST_TABLE][0].sent_t7_at).slice(0, 10) === '2026-11-16', 'sent_t7_at is stamped');
  const late = await evaluateOverdueDigest({ supabase: mock.client, sendFn: capture(sends), now: new Date('2026-11-20T09:00:00.000Z') });
  check(late.dispatched === 0 && sends.length === 3, 'an episode caps at three messages total (1 immediate + 2 digests)');

  console.log('\n--- 5. renewal before T+3: nothing fires and the episode resets ---');
  const renew = createMockSupabase(seed([reminder('r1', '2026-11-09')]));
  const renewSends = [];
  await evaluateOverdueDigest({ supabase: renew.client, sendFn: capture(renewSends), now: NOW });
  check(renew.db[OVERDUE_DIGEST_TABLE].length === 1, 'the episode row exists while overdue');
  renew.db.reminders[0].status = 'completed';
  const afterRenew = await evaluateOverdueDigest({ supabase: renew.client, sendFn: capture(renewSends), now: new Date('2026-11-12T09:00:00.000Z') });
  check(afterRenew.reset === 1 && renew.db[OVERDUE_DIGEST_TABLE].length === 0, 'renewing everything resets the episode (no stale row)');
  check(renewSends.length === 0, 'no digest ever fires for a renewed item');

  console.log('\n--- 6. renewal between T+3 and T+7: the T+7 digest never fires ---');
  const midRenew = createMockSupabase(seed([reminder('r1', '2026-11-09')]));
  const midSends = [];
  await evaluateOverdueDigest({ supabase: midRenew.client, sendFn: capture(midSends), now: NOW });
  await evaluateOverdueDigest({ supabase: midRenew.client, sendFn: capture(midSends), now: new Date('2026-11-12T09:00:00.000Z') });
  check(midSends.length === 1, 'the T+3 digest went out');
  midRenew.db.reminders[0].status = 'completed';
  const afterMid = await evaluateOverdueDigest({ supabase: midRenew.client, sendFn: capture(midSends), now: new Date('2026-11-16T09:00:00.000Z') });
  check(afterMid.sentT7 === 0 && midSends.length === 1, 'no T+7 digest after the renewal');
  check(midRenew.db[OVERDUE_DIGEST_TABLE].length === 0, 'the episode row is cleared');

  console.log('\n--- 7. a genuinely new episode starts a fresh clock ---');
  midRenew.db.reminders.push(reminder('r-new', '2026-11-10'));
  const newEpisode = await evaluateOverdueDigest({ supabase: midRenew.client, sendFn: capture(midSends), now: new Date('2026-11-12T09:00:00.000Z') });
  check(newEpisode.sentT3 === 0 && midSends.length === 1, 'two days after the NEW item went due, still silent');
  check(String(midRenew.db[OVERDUE_DIGEST_TABLE][0].first_overdue_at).slice(0, 10) === '2026-11-10', 'the new episode anchors on the new item date (never the old one)');
  await evaluateOverdueDigest({ supabase: midRenew.client, sendFn: capture(midSends), now: new Date('2026-11-13T09:00:00.000Z') });
  check(midSends.length === 2, 'its own T+3 digest fires three days after the new anchor');

  console.log('\n--- 8. the anchor never moves while anything stays overdue ---');
  const mixed = createMockSupabase(seed([
    reminder('r-old', '2026-11-05'),
    reminder('r-late', '2026-11-07', { reminder_type: 'Inspection', label: 'Inspection', category: 'inspection' })
  ]));
  const mixedSends = [];
  await evaluateOverdueDigest({ supabase: mixed.client, sendFn: capture(mixedSends), now: new Date('2026-11-08T09:00:00.000Z') });
  check(mixedSends.length === 1 && mixedSends[0].templateVars.count === '2', 'T+3 fires with both items');
  mixed.db.reminders.find((row) => row.id === 'r-old').status = 'completed';
  const still = await evaluateOverdueDigest({ supabase: mixed.client, sendFn: capture(mixedSends), now: new Date('2026-11-10T09:00:00.000Z') });
  check(still.dispatched === 0 && String(mixed.db[OVERDUE_DIGEST_TABLE][0].first_overdue_at).slice(0, 10) === '2026-11-05', 'renewing the oldest item does NOT restart the clock');
  const t7Mixed = await evaluateOverdueDigest({ supabase: mixed.client, sendFn: capture(mixedSends), now: new Date('2026-11-12T09:00:00.000Z') });
  check(t7Mixed.sentT7 === 1 && mixedSends.length === 2, 'T+7 still fires from the original anchor');
  check(mixedSends[1].templateVars.count === '1' && mixedSends[1].templateVars.worst_days === '5', 'the digest reports the items still overdue (1 item, 5 days)');

  console.log('\n--- 9. driver-linked overdue items reach the OWNER digest ---');
  const driverSeed = seed(
    [reminder('r-d', '2026-11-09', { vehicle_id: null, subject_type: 'driver', subject_id: 'd1', category: 'driver_license', reminder_type: 'Driver License', label: 'Driver licence' })],
    { vehicles: [{ ...VEHICLE, assigned_driver_id: 'd1' }] }
  );
  const driverMock = createMockSupabase(driverSeed);
  const driverSends = [];
  const driverDigest = await evaluateOverdueDigest({ supabase: driverMock.client, sendFn: capture(driverSends), now: new Date('2026-11-12T09:00:00.000Z') });
  check(driverDigest.owners === 1 && driverDigest.overdueItems === 1 && driverSends.length === 1, "a driver's overdue licence reaches the owner's digest");
  check(/Driver licence/.test(driverSends[0].templateVars.worst_item) && driverSends[0].templateVars.count === '1', 'the digest names the driver document');

  console.log('\n--- 10. canDeliver + runReminderSweep wiring ---');
  const guarded = createMockSupabase(seed([reminder('r1', '2026-11-09')]));
  const guardedSends = [];
  const guardedDigest = await evaluateOverdueDigest({
    supabase: guarded.client,
    sendFn: capture(guardedSends),
    canDeliver: () => false,
    now: new Date('2026-11-12T09:00:00.000Z')
  });
  check(guardedDigest.dispatched === 0 && guardedSends.length === 0, 'the superadmin boundary is respected (no send)');
  check(String(guarded.db[OVERDUE_DIGEST_TABLE][0].sent_t3_at).slice(0, 10) === '2026-11-12', 'the milestone is still stamped (never a broken retry loop)');

  const sweepMock = createMockSupabase(seed([
    reminder('r1', '2026-11-09'),
    reminder('r2', '2026-11-09', { reminder_type: 'Inspection', label: 'Inspection', category: 'inspection' }),
    reminder('r3', '2026-11-09', { reminder_type: 'Permit', label: 'Permit', category: 'permit' })
  ]));
  const sweepSends = [];
  const sweep1 = await runReminderSweep({ supabase: sweepMock.client, sendFn: capture(sweepSends), now: NOW });
  const sweep2 = await runReminderSweep({ supabase: sweepMock.client, sendFn: capture(sweepSends), now: new Date('2026-11-12T09:00:00.000Z') });
  const sweep3 = await runReminderSweep({ supabase: sweepMock.client, sendFn: capture(sweepSends), now: new Date('2026-11-16T09:00:00.000Z') });
  check(sweep1.digest && sweep1.digest.owners === 1, 'runReminderSweep exposes the digest pass');
  check(sweep2.digest.sentT3 === 1 && sweep2.digest.dispatched === 1, 'the sweep reports the T+3 digest');
  check(sweep3.digest.sentT7 === 1, 'the sweep reports the T+7 digest');
  check(sweepSends.length === 3, 'three overdue items produced exactly three messages across the whole episode');

  console.log(`\n🎉 ${passed} overdue-digest assertions passed.`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
