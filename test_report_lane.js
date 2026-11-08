/**
 * Saka Fleet — Dashboard-first report lane & monthly toggle (v1.77.0, Phase 16)
 * --------------------------------------------------------------------------
 * Stateless (in-memory mock; Storage mocked, no network). Pins the Phase 16
 * contract:
 *   - the WhatsApp report lane answers INSTANTLY with the dashboard Reports link;
 *   - it NEVER queues a follow-up job and NEVER emails on demand;
 *   - an inline PDF is appended only while `REPORT_INLINE_BUILD_MS` lasts, and
 *     ONLY then do quota + trial activation get recorded;
 *   - the bespoke menu is unchanged;
 *   - `monthly report on|off` writes the right column and reads back honestly.
 *
 * Run: node test_report_lane.js
 */

import assert from 'assert';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  handleReportRequestTurn,
  parseMonthlyReportToggle,
  resolveMonthlyReportToggle
} from './src/routes/whatsapp/commands.js';
import { resolveInlineReportBudgetMs } from './src/services/reportDelivery.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

const NOW = new Date('2026-11-10T09:00:00+03:00');
const COUNTRY = Object.freeze({
  country: 'Kenya', country_code: 'KE', currency: 'KES', locale: 'en-KE',
  default_units: 'metric', default_language: 'English', plate_example: 'KDA 123A'
});
const OWNER = Object.freeze({
  id: 'p1', full_name: 'Daudi Mwangi', phone_number: '+254700000001',
  email: 'owner@sakafleet.com', email_verified: true, preferred_language: 'English', unit_system: 'metric'
});

function seedFleet() {
  return {
    vehicles: [
      {
        id: 'v1', plate_number: 'KDA 123A', make_model: 'Toyota Hilux', year: 2021, status: 'ACTIVE',
        owner_id: 'p1', assigned_driver_id: 'd1', current_mileage: 51200, odometer_reading: 51200,
        operating_hours: 0, fuel_type: 'Diesel', asset_type: 'vehicle', vin: 'JT1234567890ABCDE',
        created_at: '2026-01-05T08:00:00Z'
      }
    ],
    expense_logs: [
      { id: 'e1', vehicle_id: 'v1', driver_id: 'd1', expense_type: 'Fuel', amount: 6000, fuel_liters: 45, odometer_reading: 50800, fill_type: 'full', notes: 'Shell Westlands', created_at: '2026-11-02T09:00:00Z' },
      { id: 'e2', vehicle_id: 'v1', driver_id: 'd1', expense_type: 'Maintenance', amount: 12000, odometer_reading: 51000, notes: 'Brake pads', created_at: '2026-10-10T09:00:00Z' }
    ],
    private_earnings: [
      { id: 'ea1', vehicle_id: 'v1', driver_id: 'd1', revenue_amount: 25000, odometer_reading: 51250, logged_at: '2026-11-03T09:00:00Z', created_at: '2026-11-03T09:00:00Z' }
    ],
    reminders: [],
    profiles: [
      { id: 'p1', full_name: 'Daudi Mwangi', phone_number: '+254700000001', email: 'owner@sakafleet.com', email_verified: true, subscription_tier: 'free' },
      { id: 'd1', full_name: 'Amina Wanjiku', phone_number: '+254700000002' }
    ],
    driver_compliances: [],
    vehicle_compliances: [],
    driver_assignments: [],
    pending_followups: [],
    usage_counters: [],
    subscriptions: [],
    trial_sessions: [],
    short_links: [],
    admin_audit_logs: [],
    error_logs: []
  };
}

const previousFlag = process.env.DASHBOARD_ENABLED;
const previousBudget = process.env.REPORT_INLINE_BUILD_MS;

async function runLane(mock, over = {}) {
  return await handleReportRequestTurn({
    mergedExt: {},
    messageText: 'send me a fleet report',
    supabaseClient: mock.client,
    profileData: OWNER,
    senderPhone: OWNER.phone_number,
    existingVehicles: mock.db.vehicles,
    targetVeh: null,
    entitlements: { reportsPerMonth: 1, nextTierKey: 'solo_pro' },
    countryInfo: COUNTRY,
    targetLang: 'en',
    ...over
  });
}

async function run() {
  console.log('=== DASHBOARD-FIRST REPORT LANE & MONTHLY TOGGLE (v1.77.0) ===\n');

  console.log('--- Test 1: REPORT_INLINE_BUILD_MS budget resolver ---');
  check(resolveInlineReportBudgetMs({}) === 4000, 'the budget defaults to 4 seconds');
  check(resolveInlineReportBudgetMs({ REPORT_INLINE_BUILD_MS: '0' }) === 0, '0 turns the inline path off');
  check(resolveInlineReportBudgetMs({ REPORT_INLINE_BUILD_MS: '99999' }) === 8000, 'the budget is clamped to 8 seconds');
  check(resolveInlineReportBudgetMs({ REPORT_INLINE_BUILD_MS: 'nope' }) === 4000, 'a non-numeric value falls back to the default');

  console.log('\n--- Test 2: dashboard-first + inline PDF (dashboard ON, budget ON) ---');
  process.env.DASHBOARD_ENABLED = 'on';
  delete process.env.REPORT_INLINE_BUILD_MS;
  delete process.env.SHORT_LINK_DOMAIN_READY;
  const inlineMock = createMockSupabase(seedFleet());
  const inlineTurn = await runLane(inlineMock);
  check(inlineTurn.handled === true, 'the lane answers the turn');
  check(inlineTurn.reply.includes('https://app.sakafleet.com/d/reports'), 'the reply points at the dashboard Reports page FIRST');
  check(!inlineTurn.reply.includes('/d/d/'), 'the dashboard URL is built once (never doubled)');
  check(!/Building your/.test(inlineTurn.reply), 'the "building your report" ACK is gone');
  check(/📄 \*PDF report:\*/.test(inlineTurn.reply), 'the inline PDF link is appended inside the same reply');
  check(inlineMock.db.pending_followups.length === 0, 'nothing is queued (no background follow-up)');
  check((inlineMock.state.uploads || []).length === 1, 'exactly one PDF was uploaded (Storage mocked)');
  check((inlineMock.db.usage_counters || []).length === 1
    && Number(inlineMock.db.usage_counters[0].report_count) === 1,
    'the inline PDF recorded one report usage (quota stays enforced)');

  console.log('\n--- Test 3: budget 0 → dashboard link only (no build, no quota) ---');
  process.env.REPORT_INLINE_BUILD_MS = '0';
  const offBudgetMock = createMockSupabase(seedFleet());
  const offBudgetTurn = await runLane(offBudgetMock);
  check(offBudgetTurn.reply.includes('https://app.sakafleet.com/d/reports'), 'the dashboard link still goes out');
  check(!/📄 \*PDF report:\*/.test(offBudgetTurn.reply), 'no PDF link without a budget');
  check((offBudgetMock.state.uploads || []).length === 0, 'no upload happens');
  check((offBudgetMock.db.usage_counters || []).length === 0, 'no quota is recorded when no PDF was built');

  console.log('\n--- Test 4: dashboard OFF + budget 0 → one honest next step ---');
  process.env.DASHBOARD_ENABLED = 'off';
  const flagOffMock = createMockSupabase(seedFleet());
  const flagOffTurn = await runLane(flagOffMock);
  check(!flagOffTurn.reply.includes('/d/reports'), 'a dead dashboard link is never sent while the flag is off');
  check(/could not build the PDF just now/.test(flagOffTurn.reply) && /reply \*report\*/.test(flagOffTurn.reply),
    'the fallback offers exactly one next step');
  check(flagOffMock.db.pending_followups.length === 0, 'still nothing queued');


  console.log('\n--- Test 5: bespoke menu is unchanged ---');
  process.env.DASHBOARD_ENABLED = 'on';
  const menuMock = createMockSupabase(seedFleet());
  const menuTurn = await runLane(menuMock, { messageText: 'custom report please' });
  check(/Bespoke report — pick your metrics/.test(menuTurn.reply), 'the custom-metric menu still answers');
  check(!menuTurn.reply.includes('/d/reports'), 'the menu is not replaced by the dashboard card');
  check((menuMock.state.uploads || []).length === 0, 'the menu never builds a PDF');

  console.log('\n--- Test 6: monthly report toggle (parse) ---');
  check(parseMonthlyReportToggle({ messageText: 'monthly report on' })?.action === 'on', '"monthly report on" enables');
  check(parseMonthlyReportToggle({ messageText: 'monthly reports disable' })?.action === 'off', '"monthly reports disable" disables');
  check(parseMonthlyReportToggle({ messageText: 'monthly report' })?.action === 'status', 'a bare "monthly report" is a state read');
  check(parseMonthlyReportToggle({ messageText: 'monthly reporting' }) === null, 'the phrase is anchored (no partial match)');
  check(parseMonthlyReportToggle({ messageText: 'send me the monthly report pdf' }) === null, 'a report request is never swallowed by the toggle');

  console.log('\n--- Test 7: monthly report toggle (state + write + refusal) ---');
  const toggleMock = createMockSupabase({ profiles: [{ id: 'p1', monthly_report_opt_in: false }] });
  const statusOff = await resolveMonthlyReportToggle({ messageText: 'monthly report', profileData: { id: 'p1' }, supabaseClient: toggleMock.client });
  check(/Monthly PDF summary is OFF/.test(statusOff?.reply_message || ''), 'the state read reports OFF honestly');
  const turnedOn = await resolveMonthlyReportToggle({ messageText: 'monthly report on', profileData: { id: 'p1' }, supabaseClient: toggleMock.client });
  check(toggleMock.db.profiles[0].monthly_report_opt_in === true, 'the toggle writes monthly_report_opt_in');
  check(/Monthly PDF summary on/.test(turnedOn?.reply_message || ''), 'the confirmation names the monthly PDF summary');
  const statusOn = await resolveMonthlyReportToggle({ messageText: 'monthly report', profileData: { id: 'p1' }, supabaseClient: toggleMock.client });
  check(/Monthly PDF summary is ON/.test(statusOn?.reply_message || ''), 'the state read now reports ON');
  const failingClient = { from: () => ({ update: () => ({ eq: async () => ({ error: { message: 'column "monthly_report_opt_in" does not exist' } }) }) }) };
  const refused = await resolveMonthlyReportToggle({ messageText: 'monthly report on', profileData: { id: 'p1' }, supabaseClient: failingClient });
  check(/could not save that setting/.test(refused?.reply_message || '') && /nothing changed/.test(refused?.reply_message || ''),
    'an un-migrated column never fakes success (rule 50)');

  if (previousFlag === undefined) delete process.env.DASHBOARD_ENABLED;
  else process.env.DASHBOARD_ENABLED = previousFlag;
  if (previousBudget === undefined) delete process.env.REPORT_INLINE_BUILD_MS;
  else process.env.REPORT_INLINE_BUILD_MS = previousBudget;

  console.log(`\n🎉 ${passed} report-lane assertions passed.`);
  console.log('Stateless suite: in-memory mock only; nothing was written to the database.');
}

run().catch((err) => {
  console.error('\n❌ Report-lane suite failed:', err.message);
  process.exit(1);
});
