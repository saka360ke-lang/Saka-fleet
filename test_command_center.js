/**
 * Saka Fleet — Superadmin Command Center suite (v1.86.0, Phase 25).
 * Stateless: in-memory mock only, no database writes.
 *
 * Proves the business metrics are ENGINE COUNTS from the ONE tier matrix, that
 * the digest never prints a phone number or a hardcoded currency, and that every
 * section degrades honestly when its table is unavailable.
 */

import assert from 'assert';
import {
  COMMAND_WINDOW_DAYS,
  TRIAL_WARNING_DAYS,
  monthlyListPriceUsd,
  buildCommandCenterMetrics,
  formatCommandCenterDigest
} from './src/services/commandCenter.js';
import { getTierDefinition } from './src/services/subscriptionTiers.js';
import { createMockSupabase } from './scripts/mockSupabase.js';

let passed = 0;
function check(cond, label) {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${label}`);
}

const NOW = new Date('2026-11-08T09:00:00+03:00');
const day = (offset) => new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000).toISOString();

const PROFILES = [
  { id: 'p-growth', full_name: 'Grace Mwangi', phone_number: '+254712000111', email: 'grace@example.com', email_verified: true, subscription_tier: 'growth', subscription_status: 'ACTIVE', subscription_period_end: day(20), billing_interval: 'monthly', addon_quantity: 0 },
  { id: 'p-solo', full_name: 'Ali Hassan', phone_number: '+254712000222', email: 'ali@example.com', email_verified: false, subscription_tier: 'solo', subscription_status: 'ACTIVE', subscription_period_end: day(200), billing_interval: 'annual', addon_quantity: 0 },
  { id: 'p-cancel', full_name: 'Mary Otieno', phone_number: '+254712000333', email: 'mary@example.com', email_verified: true, subscription_tier: 'team_fleet', subscription_status: 'CANCELING', subscription_period_end: day(10), billing_interval: 'monthly', addon_quantity: 0 },
  { id: 'p-pastdue', full_name: 'John Kamau', phone_number: '+254712000444', email: 'john@example.com', email_verified: true, subscription_tier: 'solo_pro', subscription_status: 'PAST_DUE', subscription_period_end: day(-1), billing_interval: 'monthly', addon_quantity: 0 },
  { id: 'p-expired', full_name: 'Lapsed Owner', phone_number: '+254712000555', email: 'lapsed@example.com', email_verified: true, subscription_tier: 'growth', subscription_status: 'ACTIVE', subscription_period_end: day(-30), billing_interval: 'monthly', addon_quantity: 0 },
  { id: 'p-shell', full_name: null, phone_number: '+254712000666', email: null, email_verified: false, subscription_tier: 'free', subscription_status: 'ACTIVE', subscription_period_end: null, billing_interval: 'monthly', addon_quantity: 0, downgraded_at: day(-5) },
  { id: 'p-free', full_name: 'Peter Njoroge', phone_number: '+254712000777', email: 'peter@example.com', email_verified: true, subscription_tier: 'free', subscription_status: 'ACTIVE', subscription_period_end: null, billing_interval: 'monthly', addon_quantity: 0 }
];

const TRIALS = [
  { owner_id: 'p-free', status: 'ACTIVE', ends_at: day(2), tier: 'growth' },
  { owner_id: 'p-shell', status: 'ACTIVE', ends_at: day(4), tier: 'growth' },
  { owner_id: 'p-free', status: 'GRACE', ends_at: day(-1), grace_ends_at: day(6), tier: 'growth' },
  { owner_id: 'p-shell', status: 'EXPIRED', ends_at: day(-12), tier: 'growth' }
];

function seed(overrides = {}) {
  return {
    profiles: PROFILES,
    trial_sessions: TRIALS,
    vehicles: [{ id: 'v1', owner_id: 'p-free', deleted_at: null }, { id: 'v2', owner_id: 'p-growth', deleted_at: null }],
    support_tickets: [
      { id: 't1', status: 'OPEN', subject: 'Fuel log wrong', created_at: day(-2) },
      { id: 't2', status: 'ESCALATED', subject: 'Refund request', created_at: day(-1) },
      { id: 't3', status: 'CLOSED', subject: 'Old', created_at: day(-9) }
    ],
    ...overrides
  };
}

const ai24 = { ok: true, totalRequests: 40, approxCostUsd: 0.4, approxCostSavedUsd: 0.2, byPurpose: { chat: { requests: 30, approxCostUsd: 0.3 }, ocr: { requests: 10, approxCostUsd: 0.1 } } };
const ai7d = { ok: true, totalRequests: 300, approxCostUsd: 3, approxCostSavedUsd: 1.5, byPurpose: { chat: { requests: 250, approxCostUsd: 2.5 } } };
const ownerUsageFake = async () => ({ ok: true, attributedUsd: 2.4, unattributedUsd: 0.6, attributedOwners: 3, top: [] });

async function run() {
  console.log('=== SUPERADMIN COMMAND CENTER (v1.86.0) ===\n');

  console.log('--- Test 1: the tier matrix is the ONLY price source ---');
  check(monthlyListPriceUsd({ subscription_tier: 'solo_pro' }) === getTierDefinition('solo_pro').monthlyUSD, 'monthly price comes from the tier matrix');
  check(Math.abs(monthlyListPriceUsd({ subscription_tier: 'solo_pro', billing_interval: 'annual' }) - getTierDefinition('solo_pro').annualUSD / 12) < 0.01, 'an annual plan is divided by 12');
  check(monthlyListPriceUsd({ subscription_tier: 'solo' }) === getTierDefinition('solo_pro').monthlyUSD, 'a legacy alias resolves to its canonical tier');
  check(monthlyListPriceUsd({ subscription_tier: 'free' }) === 0 && monthlyListPriceUsd({ subscription_tier: 'nonsense' }) === 0, 'free/unknown tiers are worth zero (never invented)');
  check(monthlyListPriceUsd({ subscription_tier: 'fleet_command', addon_quantity: 2 }) > monthlyListPriceUsd({ subscription_tier: 'fleet_command' }), 'fleet_command add-ons add their list price');
  check(monthlyListPriceUsd({ subscription_tier: 'solo_pro', addon_quantity: 5 }) === getTierDefinition('solo_pro').monthlyUSD, 'a non-addon tier ignores addon_quantity');

  console.log('\n--- Test 2: revenue buckets ---');
  const metrics = await buildCommandCenterMetrics({
    supabase: createMockSupabase(seed()).client,
    now: NOW,
    aiSummary: ((_supabase, hours) => (hours === 24 ? ai24 : ai7d)),
    ownerUsage: ownerUsageFake
  });
  check(metrics.ok === true, 'the builder returns ok');
  const rev = metrics.revenue;
  check(rev.activePaid === 3, 'active paid counts ACTIVE + CANCELING inside the period (3)');
  const expectedMrr = Number((getTierDefinition('growth').monthlyUSD + getTierDefinition('solo_pro').annualUSD / 12 + getTierDefinition('team_fleet').monthlyUSD).toFixed(2));
  check(Math.abs(rev.mrrUsd - expectedMrr) < 0.02, `est. MRR = growth + solo(annual/12) + team_fleet (${rev.mrrUsd})`);
  check(rev.pastDue === 1 && rev.pastDueList[0].id === 'p-pastdue', 'a past-due account is counted separately');
  check(!String(rev.pastDueList[0].phoneMasked).includes('12000444'), 'the at-risk list masks the phone');
  check(rev.canceling === 1, 'canceling is its own bucket');
  check(rev.churned30d === 1, 'a downgrade inside 30 days counts as churn');
  check(rev.trialsExpiring3d === 1, 'only the trial ending within 3 days is flagged');
  check(rev.trialsExpiringList[0].daysLeft === 2, 'the at-risk trial carries its remaining days');
  check(rev.inGrace === 1, 'the decision window is counted');
  check(!rev.byTier.free, 'free is never a paid tier row');

  console.log('\n--- Test 3: user health ---');
  const health = metrics.userHealth;
  check(health.registered === 6 && health.shells === 1, 'registered = email on file; shells = no name and no email');
  check(health.emailUnverified === 1, 'an unverified email is counted');
  check(health.withVehicles === 2, 'registered profiles with a live vehicle are counted (p-free, p-growth)');
  check(health.activeWithZeroAssets === 4, 'registered profiles with no live asset are counted');
  check(health.withVehicles + health.activeWithZeroAssets === health.registered, 'with vehicles + 0 assets always adds up to registered (v1.96.4)');
  check(health.expiredTrialsNotConverted30d === 1, 'an expired trial on a non-paying account is flagged');

  console.log('\n--- Test 4: support + AI + alerts ---');
  check(metrics.support.open === 1 && metrics.support.escalated === 1, 'open and escalated tickets are separated');
  check(metrics.support.oldestOpenHours >= 24, 'the oldest waiting time is measured in hours');
  check(metrics.ai.cost24hUsd === 0.4 && metrics.ai.cost7dUsd === 3, 'AI cost rides the telemetry summary');
  check(metrics.ai.saved7dUsd === 1.5, 'off-peak savings are reported');
  check(metrics.ai.costPerActiveUserUsd === 0.8, 'cost per AI-active account = attributed / accounts (2.4 / 3)');
  check(metrics.ai.unattributedUsd === 0.6, 'background spend is reported separately, never divided per user');
  check(metrics.ai.topPurposes[0].purpose === 'chat', 'top purposes are ordered by cost');
  const alertCodes = metrics.alerts.map((a) => a.code);
  check(alertCodes.includes('PAST_DUE') && alertCodes.includes('TRIAL_ENDING') && alertCodes.includes('ESCALATED_TICKETS'), 'the alert list names what needs a human');
  check(alertCodes.includes('SHELL_PROFILES') && alertCodes.includes('EMPTY_GARAGE'), 'shell + empty-garage alerts fire');

  console.log('\n--- Test 5: the digest is readable, private and currency-honest ---');
  const digest = formatCommandCenterDigest(metrics);
  const digestLines = digest.split('\n');
  check(digestLines.length <= 20, `the full digest stays within 20 lines (${digestLines.length})`);
  check(digest.includes('est. MRR') && digest.includes('list prices'), 'money is labelled an estimate');
  check(!/\bKES\b/.test(digest), 'the digest never prints a hardcoded currency');
  check(!digest.includes('12000444') && !digest.includes('712000111'), 'no phone number appears in the digest');
  check(digest.includes('Command Center') || digest.includes('Command center'), 'the digest names the surface');
  check(digest.includes('⚠️') && digest.includes('Needs you'), 'the alert block renders');
  check(digest.includes('Registered 6 · 2 with vehicles · 4 with 0 assets'), 'the user-health block names the registered/vehicle gap on ONE line (v1.96.4)');
  const vehiclesDown = formatCommandCenterDigest({
    ok: true,
    windowDays: 30,
    revenue: null,
    userHealth: { totalProfiles: 6, registered: 6, shells: 0, emailUnverified: 0, withVehicles: null, activeWithZeroAssets: null, expiredTrialsNotConverted30d: null },
    support: null,
    ai: null,
    email: null,
    alerts: []
  });
  check(vehiclesDown.includes('Registered 6 · — with vehicles · — with 0 assets'), 'a failed vehicles read prints a dash, never zero-as-fact (rule 50)');
  check(!/\bnull\b|\bundefined\b/.test(vehiclesDown), 'the fail-soft digest never leaks null/undefined');
  const pulse = formatCommandCenterDigest(metrics, { full: false });
  check(pulse.split('\n').length <= 8 && pulse.includes('Pulse'), 'the non-Monday pulse is short');
  check(!/@example\.com/.test(digest), 'no email address leaks');

  console.log('\n--- Test 6: fail-soft sections (rule 50) ---');
  const noTrials = await buildCommandCenterMetrics({
    supabase: createMockSupabase(seed({ trial_sessions: [] })).client,
    now: NOW,
    aiSummary: async () => ({ ok: false, error: 'down' }),
    ownerUsage: async () => ({ ok: false, error: 'down' })
  });
  check(noTrials.ok === true && noTrials.revenue.trialsExpiring3d === 0, 'a missing trial table leaves revenue usable');
  check(noTrials.ai.cost24hUsd === null && noTrials.ai.costPerActiveUserUsd === null, 'a failing telemetry read reports null, never zero-as-fact');
  const noSupport = await buildCommandCenterMetrics({
    supabase: createMockSupabase(seed({ support_tickets: [] })).client,
    now: NOW,
    aiSummary: async () => ai24,
    ownerUsage: ownerUsageFake
  });
  check(noSupport.support.total === 0 && noSupport.support.oldestOpenHours === null, 'an empty support desk is honest, not padded');
  const emptyDb = await buildCommandCenterMetrics({
    supabase: createMockSupabase({ profiles: [], trial_sessions: [], vehicles: [], support_tickets: [] }).client,
    now: NOW,
    aiSummary: async () => ({ ok: true, totalRequests: 0, approxCostUsd: 0, approxCostSavedUsd: 0, byPurpose: {} }),
    ownerUsage: async () => ({ ok: true, attributedUsd: 0, unattributedUsd: 0, attributedOwners: 0, top: [] })
  });
  check(emptyDb.ok === true && emptyDb.revenue.activePaid === 0 && emptyDb.revenue.mrrUsd === 0, 'an empty deployment reports zeros, not invented figures');
  check(emptyDb.alerts.length === 0 && formatCommandCenterDigest(emptyDb).includes('Active paid: 0'), 'the empty digest is still coherent');
  check(emptyDb.userHealth.withVehicles === 0 && emptyDb.userHealth.activeWithZeroAssets === 0, 'an empty deployment counts 0 with vehicles and 0 with assets — never null-as-zero confusion');
  const noDb = await buildCommandCenterMetrics({ supabase: null, now: NOW });
  check(noDb.ok === false && formatCommandCenterDigest(noDb).includes('could not be loaded'), 'no database answers one honest line');
  check(COMMAND_WINDOW_DAYS === 30 && TRIAL_WARNING_DAYS === 3, 'the documented windows are 30 days / 3 days');

  console.log(`\n\u2705 ${passed} command-center assertions passed.`);
  console.log('Stateless suite: in-memory mock only; nothing was written to the database.');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  console.error(`\n\u274C COMMAND CENTER TEST FAILED: ${err.message}`);
  process.exit(1);
}
