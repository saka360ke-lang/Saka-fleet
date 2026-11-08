/**
 * Saka Fleet — Weekly report opt-in suite (v1.73.0, Phase 10, P3-4)
 * ----------------------------------------------------------------
 * Offline: mocked Supabase only (no DB, no cleanup). Proves:
 *   - the Monday 08:00 Africa/Nairobi gate (Nairobi calendar day),
 *   - claim-first dedupe on system_config `weekly_reports.last_sent_date`,
 *   - a hard failure CLEARS the claim (at-least-once, never a silent miss),
 *   - every send is TEXT ONLY from buildFleetReport(type: 'fleet'),
 *   - ZERO usage_counters writes and ZERO trial activation events (R5),
 *   - the `weekly report on|off` grammar + the bare state read,
 *   - the system_config registry carries the new key.
 *
 * Run: node test_weekly_reports.js
 */
import assert from 'assert';
import fs from 'node:fs';
import {
  runWeeklyReportsSweep,
  isWeeklyReportWindow,
  WEEKLY_REPORT_MARKER_KEY
} from './src/workers/weeklyReports.js';
import { parseWeeklyReportToggle, resolveWeeklyReportToggle } from './src/routes/whatsapp/commands.js';
import { SYSTEM_CONFIG_KEYS, CONFIG_KEY_WEEKLY_REPORTS_LAST_SENT } from './src/services/systemConfigKeys.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

/** Worker mock: system_config + profiles + vehicles, everything else recorded. */
function workerMock({ config = {}, profiles = [], vehiclesByOwner = {}, failProfiles = false } = {}) {
  const state = { config: { ...config }, upserts: [], touched: [], fallbackTables: [], events: [] };
  const client = {
    from(table) {
      state.touched.push(table);
      if (table === 'system_config') {
        const api = {
          select() { return api; },
          in(column, keys) { api.__keys = keys; return api; },
          limit() {
            const rows = Object.entries(state.config)
              .filter(([key]) => !api.__keys || api.__keys.includes(key))
              .map(([key, value]) => ({ key, value }));
            return Promise.resolve({ data: rows, error: null });
          },
          upsert(entries) {
            state.upserts.push(entries);
            state.events.push('config-upsert');
            for (const entry of entries) state.config[entry.key] = entry.value;
            return Promise.resolve({ error: null });
          }
        };
        return api;
      }
      if (table === 'profiles') {
        state.events.push('profiles');
        if (failProfiles) {
          return {
            select() { return this; }, eq() { return this; }, is() { return this; },
            limit() { return Promise.resolve({ data: null, error: { message: 'profiles unavailable' } }); }
          };
        }
        return {
          select() { return this; }, eq() { return this; }, is() { return this; },
          limit() { return Promise.resolve({ data: profiles, error: null }); }
        };
      }
      if (table === 'vehicles') {
        state.events.push('vehicles');
        let owner = null;
        return {
          select() { return this; },
          eq(column, value) { if (column === 'owner_id') owner = value; return this; },
          is() { return this; },
          limit() { return Promise.resolve({ data: vehiclesByOwner[owner] || [], error: null }); }
        };
      }
      state.fallbackTables.push(table);
      const stub = {
        select() { return stub; }, eq() { return stub; }, in() { return stub; },
        is() { return stub; }, order() { return stub; }, range() { return stub; },
        update() { return stub; }, delete() { return stub; }, insert() { return stub; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); }
      };
      return stub;
    }
  };
  return { client, state };
}

/** Toggle mock: profiles read/update only. */
function toggleMock({ enabled = false, readError = null, writeError = null } = {}) {
  const state = { updates: [] };
  const client = {
    from(table) {
      assert.equal(table, 'profiles', 'the toggle only touches profiles');
      const api = {
        select() { return api; },
        update(patch) { state.updates.push(patch); return api; },
        eq() { return api; },
        limit() {
          if (readError) return Promise.resolve({ data: null, error: readError });
          return Promise.resolve({ data: [{ weekly_report_opt_in: enabled }], error: null });
        },
        then(resolve) {
          return Promise.resolve(writeError ? { error: writeError } : { error: null }).then(resolve);
        }
      };
      return api;
    }
  };
  return { client, state };
}

async function run() {
  console.log('=== WEEKLY REPORTS (v1.73.0, Phase 10, P3-4) ===');

  console.log('\n--- Test 1: Monday 08:00 EAT gate (Nairobi calendar day) ---');
  check(isWeeklyReportWindow(new Date('2026-11-09T08:02:00+03:00')).inWindow === true, 'Monday 08:02 EAT is the window');
  check(isWeeklyReportWindow(new Date('2026-11-09T07:59:00+03:00')).inWindow === false, 'Monday 07:59 EAT is outside the window');
  check(isWeeklyReportWindow(new Date('2026-11-09T09:02:00+03:00')).inWindow === false, 'Monday 09:02 EAT is outside the window');
  check(isWeeklyReportWindow(new Date('2026-11-10T08:02:00+03:00')).inWindow === false, 'Tuesday 08:02 EAT is outside the window');
  check(isWeeklyReportWindow(new Date('2026-11-09T08:02:00+03:00')).todayKey === '2026-11-09', 'the day marker is the Nairobi date');

  console.log('\n--- Test 2: the sweep sends TEXT summaries only (no PDF, no quota) ---');
  const monday = new Date('2026-11-09T08:02:00+03:00');
  const sweepMock = workerMock({
    profiles: [
      { id: 'ownerA', phone_number: '+254700000001', full_name: 'A', country_code: 'KE' },
      { id: 'ownerB', phone_number: '+254700000002', full_name: 'B', country_code: 'KE' },
      { id: 'ownerC', phone_number: null, full_name: 'C', country_code: 'KE' }
    ],
    vehiclesByOwner: { ownerA: [{ id: 'v1' }] }
  });
  const buildCalls = [];
  const sends = [];
  const sweep = await runWeeklyReportsSweep({
    supabase: sweepMock.client,
    now: monday,
    sendFn: async (phone, text, profile, kind) => { sends.push({ phone, text, profile, kind }); },
    buildReport: async (args) => { buildCalls.push(args); return { ok: true, text: 'FLEET SUMMARY TEXT' }; }
  });
  check(sweep.ok === true && sweep.owners === 3, 'the sweep ran and saw all opted-in profiles');
  check(sweep.sent === 1 && sweep.skippedEmpty === 1 && sweep.failed === 0, 'one send, one empty garage skipped, no failures');
  check(sends.length === 1 && sends[0].phone === '+254700000001' && sends[0].kind === 'weekly_report', 'the send goes to the owner phone with kind weekly_report');
  check(sends[0].text.includes('FLEET SUMMARY TEXT') && sends[0].text.includes('weekly fleet summary') && sends[0].text.includes('weekly report off'),
    'the message carries the fleet text + the opt-out line');
  check(buildCalls.length === 1 && buildCalls[0].type === 'fleet' && buildCalls[0].ownerId === 'ownerA',
    'buildFleetReport is called with type fleet for the owner (text-only path)');
  check(sweepMock.state.fallbackTables.length === 0, 'NO other table was touched — zero usage_counters, zero trial writes (R5)');
  check(!sweepMock.state.touched.includes('usage_counters') && !sweepMock.state.touched.includes('trial_sessions'),
    'the sweep never reads/writes usage_counters or trial_sessions');

  console.log('\n--- Test 3: claim-first marker + idempotent re-run ---');
  const markerRows = sweepMock.state.upserts[0] || [];
  check(markerRows.some((row) => row.key === WEEKLY_REPORT_MARKER_KEY && row.value === '2026-11-09'),
    'the Nairobi day marker is claimed BEFORE the sweep');
  check(sweepMock.state.events.indexOf('config-upsert') < sweepMock.state.events.indexOf('profiles'),
    'claim-first ordering: the marker write precedes the profiles scan (D5)');
  const replaySends = [];
  const replay = await runWeeklyReportsSweep({
    supabase: sweepMock.client,
    now: monday,
    sendFn: async (...args) => { replaySends.push(args); },
    buildReport: async () => ({ ok: true, text: 'SHOULD NOT SEND' })
  });
  check(replay.ok === true && replay.skipped === 'already-sent' && replaySends.length === 0,
    'a re-tick on the same Nairobi day sends nothing (already-sent)');

  console.log('\n--- Test 4: outside the window nothing runs ---');
  const idleMock = workerMock({ profiles: [{ id: 'ownerA', phone_number: '+254700000001' }] });
  const idle = await runWeeklyReportsSweep({
    supabase: idleMock.client,
    now: new Date('2026-11-10T08:02:00+03:00'),
    sendFn: async () => { throw new Error('must not send'); },
    buildReport: async () => ({ ok: true, text: 'x' })
  });
  check(idle.ok === true && idle.skipped === 'outside-window', 'Tuesday ticks are skipped');
  check(idleMock.state.upserts.length === 0 && idleMock.state.touched.length === 0, 'an outside-window tick touches nothing');

  console.log('\n--- Test 5: hard failure releases the claim (retry next tick) ---');
  const failMock = workerMock({ failProfiles: true });
  const failed = await runWeeklyReportsSweep({
    supabase: failMock.client,
    now: monday,
    sendFn: async () => {},
    buildReport: async () => ({ ok: true, text: 'x' })
  });
  check(failed.ok === false && failed.reason === 'sweep-failed', 'a hard failure is reported, never silent');
  check(failMock.state.config[WEEKLY_REPORT_MARKER_KEY] === '', 'the claim is CLEARED so the next tick retries (at-least-once)');

  console.log('\n--- Test 6: per-owner failures stay fail-soft ---');
  const mixMock = workerMock({
    profiles: [
      { id: 'ownerA', phone_number: '+254700000001' },
      { id: 'ownerB', phone_number: '+254700000002' },
      { id: 'ownerD', phone_number: '+254700000004' }
    ],
    vehiclesByOwner: { ownerA: [{ id: 'v1' }], ownerB: [{ id: 'v2' }], ownerD: [{ id: 'v3' }] }
  });
  const mixSends = [];
  const mix = await runWeeklyReportsSweep({
    supabase: mixMock.client,
    now: monday,
    sendFn: async (phone) => { mixSends.push(phone); },
    buildReport: async ({ ownerId }) => {
      if (ownerId === 'ownerA') throw new Error('report exploded');
      if (ownerId === 'ownerD') return { ok: false, error: 'no data' };
      return { ok: true, text: 'OK TEXT' };
    }
  });
  check(mix.sent === 1 && mix.failed === 2 && mixSends.length === 1 && mixSends[0] === '+254700000002',
    'one bad owner never blocks the rest (fail-soft per owner)');

  console.log('\n--- Test 7: the toggle grammar (quota-hijack guard) ---');
  const cases = [
    ['weekly report on', 'on'],
    ['weekly reports off', 'off'],
    ['weekly report enable', 'on'],
    ['weekly report disable', 'off'],
    ['weekly report yes', 'on'],
    ['Weekly Report ON', 'on'],
    ['weekly report', 'status'],
    ['weekly reports', 'status']
  ];
  for (const [text, action] of cases) {
    check(parseWeeklyReportToggle({ messageText: text })?.action === action, `"${text}" -> ${action}`);
  }
  for (const text of ['weekly report on please', 'my weekly report', 'weekly rapport on', 'report weekly on']) {
    check(parseWeeklyReportToggle({ messageText: text }) === null, `"${text}" is not a toggle command`);
  }
  check((await resolveWeeklyReportToggle({ messageText: 'weekly report on', profileData: null, supabaseClient: toggleMock().client })) === null,
    'an ownerless session never gets a toggle reply');

  console.log('\n--- Test 8: the toggle writes the profile honestly ---');
  const onMock = toggleMock({ enabled: false });
  const onResult = await resolveWeeklyReportToggle({ messageText: 'weekly report on', profileData: { id: 'p1' }, supabaseClient: onMock.client });
  check(onMock.state.updates.length === 1 && onMock.state.updates[0].weekly_report_opt_in === true,
    'weekly report on writes profiles.weekly_report_opt_in = true');
  check(onResult.reply_message.includes('Weekly report on') && onResult.reply_message.includes('never uses your report quota'),
    'the confirmation is deterministic and states the no-quota rule');
  const offMock = toggleMock({ enabled: true });
  const offResult = await resolveWeeklyReportToggle({ messageText: 'weekly report off', profileData: { id: 'p1' }, supabaseClient: offMock.client });
  check(offMock.state.updates[0].weekly_report_opt_in === false, 'weekly report off writes false');
  check(offResult.reply_message.includes('Weekly report off'), 'the off confirmation is deterministic');
  const statusOn = await resolveWeeklyReportToggle({ messageText: 'weekly report', profileData: { id: 'p1' }, supabaseClient: toggleMock({ enabled: true }).client });
  check(statusOn.reply_message.includes('Weekly report is ON'), 'a bare "weekly report" reads the state (ON)');
  const statusOff = await resolveWeeklyReportToggle({ messageText: 'weekly report', profileData: { id: 'p1' }, supabaseClient: toggleMock({ enabled: false }).client });
  check(statusOff.reply_message.includes('Weekly report is OFF'), 'a bare "weekly report" reads the state (OFF)');
  const statusBroken = await resolveWeeklyReportToggle({ messageText: 'weekly report', profileData: { id: 'p1' }, supabaseClient: toggleMock({ readError: { message: 'boom' } }).client });
  check(statusBroken.reply_message.includes('could not read'), 'an unreadable setting is reported honestly');
  const writeBroken = await resolveWeeklyReportToggle({ messageText: 'weekly report on', profileData: { id: 'p1' }, supabaseClient: toggleMock({ writeError: { message: 'column "weekly_report_opt_in" does not exist' } }).client });
  check(writeBroken.reply_message.includes('could not save') && writeBroken.reply_message.includes('nothing changed'),
    'a failed write never claims success (rule 50)');

  console.log('\n--- Test 9: registry + wiring pins ---');
  check(SYSTEM_CONFIG_KEYS[CONFIG_KEY_WEEKLY_REPORTS_LAST_SENT]?.owner === 'weeklyReports'
    && SYSTEM_CONFIG_KEYS[CONFIG_KEY_WEEKLY_REPORTS_LAST_SENT]?.legacyKey === null,
    'SYSTEM_CONFIG_KEYS registers weeklyreports.last_sent_date (new key, no legacy name)');
  const workerSrc = fs.readFileSync('./src/workers/weeklyReports.js', 'utf8');
  check(!/recordReportUsage\(|recordActivationEvent\(/.test(workerSrc)
    && !/from '\.\.\/services\/(subscriptions|trialEngine)\.js'/.test(workerSrc),
    'the worker source never calls quota/activation writers (no imports either)');
  check(workerSrc.indexOf('CLAIM FIRST') < workerSrc.indexOf("from('profiles')"), 'claim-first ordering is source-pinned');
  const indexSrc = fs.readFileSync('./index.js', 'utf8');
  check(indexSrc.includes('runWeeklyReportsSweep') && /setInterval\(runWeeklyReportSweep, 30 \* 60 \* 1000\)/.test(indexSrc),
    'index.js runs the sweep on a 30-minute gated tick');
  // v1.77.0 (Phase 16) — the monthly sweep rides its OWN 30-minute tick; the
  // weekly gate is untouched by its arrival.
  check(indexSrc.includes('runMonthlyReportsSweep') && /setInterval\(runMonthlyReportSweep, 30 \* 60 \* 1000\)/.test(indexSrc),
    'the monthly PDF sweep has its own 30-minute gated tick (Phase 16)');
  check(isWeeklyReportWindow(new Date('2026-12-01T08:02:00+03:00')).inWindow === false,
    'the 1st of a month is NEVER a weekly window (the two sweeps cannot collide)');
  const messagesSrc = fs.readFileSync('./src/routes/whatsapp/messages.js', 'utf8');
  check(messagesSrc.includes('resolveWeeklyReportToggle') && messagesSrc.indexOf('weeklyReportToggleResult') < messagesSrc.indexOf('await dispatchReadTurn('),
    'the toggle lane runs BEFORE the read dispatch and the AI turn (quota-hijack guard)');

  console.log(`\n🎉 ALL WEEKLY REPORT TESTS PASSED (${passed} assertions).`);
}

run().then(() => {
  console.log('Stateless suite: no real database rows were created, so no cleanup is required.');
}).catch((e) => { console.error('Weekly report test crashed:', e); process.exit(1); });
