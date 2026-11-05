/**
 * Saka Fleet — Launch Award Test Suite (v1.58.26)
 * ----------------------------------------------
 * Stateless: in-memory Supabase mock (plus one racing fake). Zero network.
 * Covers: config defaults/kill switch, public status (fail-closed), exactly-once
 * per owner, slot cap = automatic fallback, 23505 race retry, coupon + trial
 * extension (183 days via maxTotalDays), audit trail and deterministic copy.
 *
 * Run: node test_launch_award.js
 */

import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  getLaunchAwardConfig,
  getLaunchAwardStatus,
  tryGrantLaunchAward,
  grantLaunchAwardForTrial,
  formatLaunchAwardLine,
  getLaunchAwardStats,
  formatLaunchStatsReply,
  clearLaunchAwardCache
} from './src/services/launchAwards.js';
import { invalidateEntitlements } from './src/services/subscriptions.js';
import { parseSuperadminCommand, handleLaunchStatsCommand, ADMIN_COMMAND_REGISTRY } from './src/services/superadmin.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`✅ ${message}`);
}

const DAY = 86400000;
const future = (days) => new Date(Date.now() + days * DAY).toISOString();
const ENV = { LAUNCH_AWARD_ENABLED: 'on', LAUNCH_MAX_FIRST_SIGNUPS: '50', LAUNCH_AWARD_DAYS: '183', LAUNCH_STATUS_CACHE_MS: '60000' };

function trialWorld() {
  return createMockSupabase({
    profiles: [{
      id: 'p-1',
      phone_number: '+254700000123',
      email: 'owner@example.com',
      full_name: 'Owner One',
      subscription_tier: 'growth',
      subscription_status: 'TRIALING',
      trial_used_at: new Date().toISOString(),
      currency: 'KES',
      locale: 'en-KE'
    }],
    trial_sessions: [{
      id: 't-1',
      owner_id: 'p-1',
      tier: 'growth',
      interval: 'monthly',
      status: 'ACTIVE',
      started_at: new Date().toISOString(),
      ends_at: future(30),
      activated: false,
      activation_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }],
    launch_awards: [],
    coupons: [],
    usage_counters: [],
    vehicles: [],
    admin_audit_logs: []
  });
}

function seededAwards(count, { startAt = 1 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ slot_idx: startAt + i, owner_id: `seed-owner-${startAt + i}`, days: 183, awarded_at: new Date().toISOString() });
  }
  return rows;
}

console.log('=== v1.61.0: launch award (first 50 -> 6 months / 183 days, then default) ===');


// 2. Public status: empty campaign is OPEN; a broken DB is CLOSED.
clearLaunchAwardCache();
const world = trialWorld();
const openStatus = await getLaunchAwardStatus({ supabase: world.client, env: ENV, force: true });
check(openStatus.active === true && openStatus.slotsLeft === 50 && openStatus.awardDays === 183, 'Empty campaign: active with all slots free (6-month offer)');
const brokenStatus = await getLaunchAwardStatus({
  supabase: { from() { throw new Error('db down'); } },
  env: ENV,
  force: true
});
check(brokenStatus.active === false, 'Fail-closed: a DB error hides the campaign');
const disabledStatus = await getLaunchAwardStatus({ supabase: world.client, env: { ...ENV, LAUNCH_AWARD_ENABLED: 'off' }, force: true });
check(disabledStatus.active === false, 'Kill switch: status is inactive');

// 3. The grant: slot 1, coupon, 183-day (6-month) extension, audit.
clearLaunchAwardCache();
const award = await grantLaunchAwardForTrial({ supabase: world.client, ownerId: 'p-1', trial: { id: 't-1' }, phone: '+254700000123', env: ENV });
check(award.granted === true && award.slot === 1 && award.days === 183, 'First grant takes slot 1 with 183 days (6 months)');
check(award.extended === true && award.couponCode === 'LAUNCH183-1', 'The award writes its coupon and extends the trial');
check(world.db.launch_awards.length === 1 && world.db.launch_awards[0].owner_id === 'p-1', 'Exactly one launch_awards row for the owner');
check(world.db.coupons.some((c) => c.code === 'LAUNCH183-1' && c.created_by === 'LAUNCH_AWARD' && c.applicable_to === 'account_trial_extension'), 'A LAUNCH_AWARD coupon row exists (server-side confirmation)');
check(world.db.coupons.some((c) => c.code === 'LAUNCH183-1' && c.owner_id === 'p-1' && c.is_redeemed === true), 'The award coupon is account-bound and marked redeemed (rule 29)');
const extendedTrial = world.db.trial_sessions.find((t) => t.id === 't-1');
const totalDays = Math.round((new Date(extendedTrial.ends_at).getTime() - new Date(extendedTrial.started_at).getTime()) / DAY);
check(totalDays >= 182 && totalDays <= 184, `The trial now runs ~183 days / 6 months (got ${totalDays})`);
check(world.db.admin_audit_logs.some((row) => row.action === 'LAUNCH_AWARD_GRANTED'), 'The grant is audited (LAUNCH_AWARD_GRANTED)');
invalidateEntitlements('p-1');

// 3b. v1.59.1 — launch-offer opt-in: the tick box is checked by default, so ONLY
// an explicit opt-out is ineligible; a missing column is fail-open.
clearLaunchAwardCache();
const optOutWorld = trialWorld();
optOutWorld.db.profiles[0].launch_opt_in = false;
const optedOut = await tryGrantLaunchAward({ supabase: optOutWorld.client, ownerId: 'p-1', env: ENV });
check(optedOut.granted === false && optedOut.reason === 'opted-out', 'An explicit opt-out routes to the normal 30-day flow');
check(optOutWorld.db.launch_awards.length === 0, 'An opted-out owner consumes no slot');
check(optOutWorld.db.admin_audit_logs.some((row) => row.action === 'LAUNCH_AWARD_SKIPPED_OPT_OUT'), 'The opt-out skip is audited');
const optedInWorld = trialWorld();
optedInWorld.db.profiles[0].launch_opt_in = true;
const optedIn = await tryGrantLaunchAward({ supabase: optedInWorld.client, ownerId: 'p-1', env: ENV });
check(optedIn.granted === true && optedIn.slot === 1, 'An opted-in owner takes slot 1');
const legacyWorld = trialWorld();
delete legacyWorld.db.profiles[0].launch_opt_in;
const legacy = await tryGrantLaunchAward({ supabase: legacyWorld.client, ownerId: 'p-1', env: ENV });
check(legacy.granted === true, 'A profile without the column (pre-migration) is fail-open and still awarded');
const readErrorWorld = {
  from(table) {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'column launch_opt_in does not exist' } }) }) }) };
    return world.client.from(table);
  }
};
const degraded = await tryGrantLaunchAward({ supabase: readErrorWorld, ownerId: 'p-1', env: ENV });
check(degraded.reason !== 'opted-out', 'A profile-read error never turns into an opt-out (rule 50)');

// 4. Idempotence: the same owner never consumes a second slot.

// 5. Automatic fallback: slot N+1 gets the normal welcome flow.
clearLaunchAwardCache();
const fullWorld = createMockSupabase({ launch_awards: seededAwards(50), coupons: [], profiles: [], trial_sessions: [], admin_audit_logs: [] });
const fullStatus = await getLaunchAwardStatus({ supabase: fullWorld.client, env: ENV, force: true });
check(fullStatus.active === false && fullStatus.slotsLeft === 0, 'A full campaign reports inactive with zero slots left');
const refused = await tryGrantLaunchAward({ supabase: fullWorld.client, ownerId: 'late-owner', env: ENV });
check(refused.granted === false && refused.reason === 'quota-reached', 'Slot 51 is refused (default flow continues)');
check(fullWorld.db.launch_awards.length === 50, 'A refused grant writes nothing');

// 6. Race: a slot collision (23505) retries once and lands the next free slot.
clearLaunchAwardCache();
const raceWorld = trialWorld();
let collisions = 0;
const racingClient = {
  from(table) {
    const builder = raceWorld.client.from(table);
    if (table !== 'launch_awards') return builder;
    return {
      select: (...args) => builder.select(...args),
      update: (...args) => builder.update(...args),
      limit: (...args) => builder.limit(...args),
      order: (...args) => builder.order(...args),
      eq: (...args) => builder.eq(...args),
      insert(rows) {
        if (collisions === 0) {
          collisions += 1;
          const failure = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "launch_awards_pkey"' } };
          const failing = {
            select() { return failing; },
            single() { return Promise.resolve(failure); },
            then(onFulfilled, onRejected) { return Promise.resolve(failure).then(onFulfilled, onRejected); }
          };
          return failing;
        }
        return builder.insert(rows);
      }
    };
  }
};
const raced = await tryGrantLaunchAward({ supabase: racingClient, ownerId: 'p-1', trialSessionId: 't-1', env: ENV });
check(raced.granted === true && raced.slot === 2 && collisions === 1, 'A 23505 slot collision retries once and lands the next free slot');
check(raceWorld.db.launch_awards.length === 1 && raceWorld.db.launch_awards[0].slot_idx === 2, 'The retry writes exactly one award row (never a duplicate slot)');

// 7. Stats + copy.
clearLaunchAwardCache();
const stats = await getLaunchAwardStats({ supabase: world.client, env: ENV });
check(stats.slotsTaken === 1 && stats.slotsLeft === 49 && stats.winners[0].ownerId === 'p-1', 'Stats show slots taken/left and the winners');
const statsReply = formatLaunchStatsReply(stats);
check(/Slots taken: 1 \/ 50/.test(statsReply) && /183 days/.test(statsReply), 'The digest is deterministic and readable');
check(/unavailable/.test(formatLaunchStatsReply({ ok: false })), 'A failed stats read says so (never invents numbers)');
const line = formatLaunchAwardLine({ days: 183, slot: 7, slotsTotal: 50 });
check(/183 days/.test(line) && /#7/.test(line) && /first 50/.test(line), 'The award copy names the days, the slot and the cohort');

// 8. Superadmin wiring: `admin launch-stats` is parsed, registered and rendered.
check((await parseSuperadminCommand('admin launch-stats'))?.intent === 'ADMIN_LAUNCH_STATS', 'admin launch-stats is a deterministic command');
check(ADMIN_COMMAND_REGISTRY.some((group) => group.items.some((item) => item.cmd === 'admin launch-stats')), 'the command registry documents it (admin help is generated from the registry)');
const statsCmd = await handleLaunchStatsCommand(world.client);
check(/Slots taken: 1 \/ 50/.test(statsCmd.reply) && statsCmd.details.slots_taken === 1 && statsCmd.details.slots_left === 49, 'the admin handler renders the digest and returns auditable details');
check((await parseSuperadminCommand('admin trial-stats'))?.intent === 'ADMIN_TRIAL_STATS', 'the sibling trial digest still wins its own command (no hijack)');

console.log(`\n🎉 ${passed} launch-award assertions passed.`);

const again = await grantLaunchAwardForTrial({ supabase: world.client, ownerId: 'p-1', trial: { id: 't-1' }, env: ENV });
check(again.granted === true && again.already === true && again.extended === false, 'A repeat call reports the existing award, never a second slot');
check(world.db.launch_awards.length === 1, 'No duplicate award rows');

// 1. Config defaults + kill switch.
const defaults = getLaunchAwardConfig({});
check(defaults.enabled === true && defaults.slots === 50 && defaults.days === 183, 'Defaults: enabled, 50 slots, 183 days (6 months)');
const tuned = getLaunchAwardConfig({ LAUNCH_AWARD_ENABLED: 'off', LAUNCH_MAX_FIRST_SIGNUPS: '3', LAUNCH_AWARD_DAYS: '90' });
check(tuned.enabled === false && tuned.slots === 3 && tuned.days === 90, 'Env knobs override the defaults (kill switch off, 3 slots, 90 days)');
const clamped = getLaunchAwardConfig({ LAUNCH_AWARD_DAYS: '9999', LAUNCH_MAX_FIRST_SIGNUPS: '0' });
check(clamped.days === 183 && clamped.slots === 1, 'Knobs are clamped (days <= 183, slots >= 1)');
