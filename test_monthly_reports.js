/**
 * Saka Fleet — Monthly PDF summary sweep (v1.77.0, Phase 16)
 * ----------------------------------------------------------
 * Offline (injected mocks; the email and PDF renderer are injected, so no token
 * and no network). Pins:
 *   - the gate is the 1st, 08:00–08:05 Africa/Nairobi;
 *   - the window reports the PREVIOUS Nairobi calendar month (bounds + label);
 *   - claim-first day marker (no double send, hard failure releases it, an
 *     un-migrated column releases it too — rule 50);
 *   - opted-in + active + ≥1 ACTIVE vehicle + an email are required;
 *   - a real PDF Buffer is rendered per owner and handed to the email sender;
 *   - NO quota and NO trial activation are ever recorded (weekly precedent).
 *
 * Run: node test_monthly_reports.js
 */

import assert from 'assert';
import fs from 'node:fs';
import {
  isMonthlyReportWindow,
  previousMonthBounds,
  runMonthlyReportsSweep,
  MONTHLY_REPORT_MARKER_KEY,
  MONTHLY_REPORT_METRICS
} from './src/workers/monthlyReports.js';
import { SYSTEM_CONFIG_KEYS, CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT } from './src/services/systemConfigKeys.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

/** Worker mock: system_config + profiles + vehicles; everything else recorded. */
function workerMock({ config = {}, profiles = [], vehiclesByOwner = {}, failProfiles = false, profilesError = null } = {}) {
  const state = { config: { ...config }, upserts: [], touched: [], events: [] };
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
        if (profilesError) {
          return {
            select() { return this; }, eq() { return this; }, is() { return this; },
            limit() { return Promise.resolve({ data: null, error: profilesError }); }
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

const OWNER_A = {
  id: 'ownerA', phone_number: '+254700000001', email: 'a@example.com', email_verified: true,
  full_name: 'Amina Wanjiku', country: 'Kenya', country_code: 'KE'
};
const OWNER_B = { ...OWNER_A, id: 'ownerB', phone_number: '+254700000002', email: 'b@example.com', full_name: 'Brian Otieno' };

/** The 1st at 08:02 EAT. */
const FIRST_0802 = new Date('2026-12-01T08:02:00+03:00');

function buildReportStub(seen) {
  return async (args) => {
    seen.push(args);
    return {
      ok: true,
      type: 'custom',
      data: { title: 'Bespoke Report', kpis: [{ label: 'Total spend', value: 'KES 1,000' }], charts: [], sections: [], tables: [] }
    };
  };
}

async function run() {
  console.log('=== MONTHLY PDF SUMMARY SWEEP (v1.77.0) ===\n');

  console.log('--- Test 1: the window gate (1st, 08:00-08:05 EAT) ---');
  check(isMonthlyReportWindow(FIRST_0802).inWindow === true, 'the 1st at 08:02 EAT is inside the window');
  check(isMonthlyReportWindow(new Date('2026-12-01T08:05:00+03:00')).inWindow === true, '08:05 EAT is still inside');
  check(isMonthlyReportWindow(new Date('2026-12-01T08:06:00+03:00')).inWindow === false, '08:06 EAT is outside');
  check(isMonthlyReportWindow(new Date('2026-12-01T07:59:00+03:00')).inWindow === false, 'before 08:00 EAT is outside');
  check(isMonthlyReportWindow(new Date('2026-12-02T08:02:00+03:00')).inWindow === false, 'the 2nd is never in the window');
  check(isMonthlyReportWindow(new Date('2026-12-31T23:59:00+03:00')).inWindow === false, 'the last day of the month is outside');
  check(isMonthlyReportWindow(FIRST_0802).todayKey === '2026-12-01', 'the Nairobi day key is the marker value');

  console.log('\n--- Test 2: the window covers the PREVIOUS Nairobi month ---');
  const dec = previousMonthBounds(FIRST_0802);
  check(dec.monthLabel === 'November 2026', 'a December 1st window summarises November 2026');
  check(dec.from === '2026-11-01T00:00:00.000+03:00' && dec.to === '2026-11-30T23:59:59.999+03:00', 'the window spans the whole previous month');
  const jan = previousMonthBounds(new Date('2027-01-01T08:02:00+03:00'));
  check(jan.monthLabel === 'December 2026' && jan.from.startsWith('2026-12-01') && jan.to.startsWith('2026-12-31'), 'a January window rolls back across the year');
  const leap = previousMonthBounds(new Date('2028-03-01T08:02:00+03:00'));
  check(leap.monthLabel === 'February 2028' && leap.to.startsWith('2028-02-29'), 'a leap-year February keeps its 29th day');
  check(MONTHLY_REPORT_METRICS.includes('total_spend') && MONTHLY_REPORT_METRICS.includes('net_profit'), 'the financial metric set is pinned');

  console.log('\n--- Test 3: outside the window nothing runs ---');
  const idleMock = workerMock({ profiles: [OWNER_A] });
  const idle = await runMonthlyReportsSweep({ supabase: idleMock.client, sendEmailFn: async () => true, now: new Date('2026-12-01T08:30:00+03:00') });
  check(idle.ok === true && idle.skipped === 'outside-window', 'a 08:30 tick is skipped');
  check(idleMock.state.upserts.length === 0, 'no marker is claimed outside the window');


  console.log('\n--- Test 4: a full sweep emails ONE PDF per opted-in owner ---');
  const seen = [];
  const sentEmails = [];
  const sweepMock = workerMock({
    profiles: [OWNER_A, OWNER_B],
    vehiclesByOwner: { ownerA: [{ id: 'v1' }], ownerB: [] }
  });
  const sweep = await runMonthlyReportsSweep({
    supabase: sweepMock.client,
    now: FIRST_0802,
    buildReport: buildReportStub(seen),
    renderPdf: async (report) => {
      assert.equal(report.data.title, 'Monthly Financial Summary');
      assert.equal(report.data.periodLabel, 'November 2026');
      return Buffer.from('%PDF-1.4 monthly');
    },
    sendEmailFn: async (payload) => {
      sentEmails.push(payload);
      return true;
    }
  });
  check(sweep.ok === true && sweep.sent === 1, 'exactly one owner receives the summary');
  check(sweep.skippedEmpty === 1, 'the owner with an empty garage is skipped');
  check(sweep.monthLabel === 'November 2026' && sweep.date === '2026-12-01', 'the result names the covered month');
  check(sentEmails.length === 1 && sentEmails[0].to === 'a@example.com', 'the email goes to the owner address');
  check(sentEmails[0].firstName === 'Amina' && sentEmails[0].monthLabel === 'November 2026', 'the email carries the warm name and the month');
  check(Buffer.isBuffer(sentEmails[0].pdfBuffer) && sentEmails[0].pdfBuffer.slice(0, 5).toString() === '%PDF-', 'the attachment is a real PDF Buffer');
  check(sweepMock.state.config[MONTHLY_REPORT_MARKER_KEY] === '2026-12-01', 'the day marker is written');
  check(seen[0].bounds?.from?.startsWith('2026-11-01') && seen[0].metricIds.length === MONTHLY_REPORT_METRICS.length,
    'the engine is called with the previous-month bounds and the financial metric set');
  check(sweepMock.state.touched.includes('usage_counters') === false, 'the sweep never touches usage_counters (no quota)');
  check(sweepMock.state.touched.includes('trial_sessions') === false, 'the sweep never touches trial_sessions (no activation)');
  check(sweepMock.state.upserts[0]?.[0]?.key === MONTHLY_REPORT_MARKER_KEY, 'the claim is the FIRST config write');

  console.log('\n--- Test 5: replay is a no-op (claim-first) ---');
  const replayEmails = [];
  const replay = await runMonthlyReportsSweep({
    supabase: sweepMock.client,
    now: new Date('2026-12-01T08:04:00+03:00'),
    buildReport: buildReportStub(seen),
    renderPdf: async () => Buffer.from('%PDF-1.4'),
    sendEmailFn: async (payload) => { replayEmails.push(payload); return true; }
  });
  check(replay.ok === true && replay.skipped === 'already-sent', 'a second tick on the same day is skipped');
  check(replayEmails.length === 0, 'nobody receives a duplicate email');
  check(sweepMock.state.events.indexOf('config-upsert') < sweepMock.state.events.indexOf('profiles'), 'claim-first ordering is preserved (config before profiles)');

  console.log('\n--- Test 6: per-owner failures are honest, the sweep continues ---');
  const failMock = workerMock({ profiles: [OWNER_A, OWNER_B], vehiclesByOwner: { ownerA: [{ id: 'v1' }], ownerB: [{ id: 'v2' }] } });
  const failSweep = await runMonthlyReportsSweep({
    supabase: failMock.client,
    now: FIRST_0802,
    buildReport: buildReportStub([]),
    renderPdf: async () => Buffer.from('%PDF-1.4'),
    sendEmailFn: async ({ to }) => to !== 'a@example.com'
  });
  check(failSweep.sent === 1 && failSweep.failed === 1, 'one delivery failure never blocks the other owner');
  check(failMock.state.config[MONTHLY_REPORT_MARKER_KEY] === '2026-12-01', 'per-owner failures keep the day claim');


  console.log('\n--- Test 7: a hard failure releases the claim (retry next tick) ---');
  const brokenMock = workerMock({ profiles: [OWNER_A], failProfiles: true });
  const broken = await runMonthlyReportsSweep({ supabase: brokenMock.client, now: FIRST_0802, sendEmailFn: async () => true });
  check(broken.ok === false && broken.reason === 'sweep-failed', 'the sweep reports the failure');
  check(String(brokenMock.state.config[MONTHLY_REPORT_MARKER_KEY] || '') === '', 'the marker is cleared so a later tick retries');

  console.log('\n--- Test 8: an un-migrated column never burns the month (rule 50) ---');
  const missingColMock = workerMock({
    profiles: [OWNER_A],
    profilesError: { message: 'column "monthly_report_opt_in" of relation "profiles" does not exist' }
  });
  const missingCol = await runMonthlyReportsSweep({ supabase: missingColMock.client, now: FIRST_0802, sendEmailFn: async () => true });
  check(missingCol.ok === false && missingCol.reason === 'column-missing', 'a missing column is named, not swallowed');
  check(String(missingColMock.state.config[MONTHLY_REPORT_MARKER_KEY] || '') === '', 'the claim is released so the post-migration tick still runs');

  console.log('\n--- Test 9: an owner without an email is skipped honestly ---');
  const noEmailMock = workerMock({
    profiles: [{ ...OWNER_A, email: null }],
    vehiclesByOwner: { ownerA: [{ id: 'v1' }] }
  });
  const noEmail = await runMonthlyReportsSweep({
    supabase: noEmailMock.client,
    now: FIRST_0802,
    buildReport: buildReportStub([]),
    renderPdf: async () => Buffer.from('%PDF-1.4'),
    sendEmailFn: async () => true
  });
  check(noEmail.sent === 0 && noEmail.skippedNoEmail === 1, 'no email address means no send and an honest count');

  console.log('\n--- Test 10: registry + wiring pins ---');
  check(SYSTEM_CONFIG_KEYS[CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT]?.owner === 'monthlyReports'
    && SYSTEM_CONFIG_KEYS[CONFIG_KEY_MONTHLY_REPORTS_LAST_SENT]?.legacyKey === null,
    'SYSTEM_CONFIG_KEYS registers monthlyreports.last_sent_date');
  check(MONTHLY_REPORT_MARKER_KEY === 'monthlyreports.last_sent_date', 'the worker uses the registered key');
  const indexSrc = fs.readFileSync('./index.js', 'utf8');
  check(indexSrc.includes('runMonthlyReportsSweep') && /setInterval\(runMonthlyReportSweep, 30 \* 60 \* 1000\)/.test(indexSrc),
    'index.js runs the sweep on a 30-minute gated tick');
  const workerSrc = fs.readFileSync('./src/workers/monthlyReports.js', 'utf8');
  check(workerSrc.indexOf('CLAIM FIRST') < workerSrc.indexOf("from('profiles')"), 'claim-first ordering is source-pinned');
  const mailerSrc = fs.readFileSync('./src/services/mailer.js', 'utf8');
  check(/export async function sendMonthlyReportEmail/.test(mailerSrc) && /attachments:/.test(mailerSrc), 'the monthly email ships as a Resend attachment');
  const migrationSrc = fs.readFileSync('./scripts/run_monthly_reports_migration.js', 'utf8');
  check(/monthly_report_opt_in boolean NOT NULL DEFAULT false/.test(migrationSrc) && /ADD COLUMN IF NOT EXISTS/.test(migrationSrc),
    'the migration is additive and idempotent');
  const provisionSrc = fs.readFileSync('./scripts/provision_staging_schema.js', 'utf8');
  check(/monthly_report_opt_in boolean NOT NULL DEFAULT false/.test(provisionSrc), 'the staging schema carries the column');
  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  check(pkg.scripts['migrate:monthly-reports'] === 'node scripts/run_monthly_reports_migration.js', 'the migration has an npm entry point');

  console.log(`\n🎉 ${passed} monthly-report assertions passed.`);
  console.log('Stateless suite: in-memory mocks only; nothing was written to the database.');
}

run().catch((err) => {
  console.error('\n❌ Monthly-report suite failed:', err.message);
  process.exit(1);
});
