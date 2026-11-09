import fs from 'node:fs';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  archiveVehicleEarnings,
  restoreArchivedEarnings,
  queueEarningsReport,
  completePassbookTransfer,
  EARNINGS_REPORT_DELAY_MS,
  EARNINGS_REPORT_QUEUE_TABLE
} from './src/services/transfers.js';
import {
  queryOwnerRecords,
  queryArchivedEarnings,
  renderRecordsPage,
  recordsQueryString,
  parseRecordsFilters
} from './src/services/dashboard.js';
import { buildOwnerPortfolio } from './src/services/ownerPortfolio.js';
import {
  runEarningsReportQueue,
  buildFinalEarningsReportPdf,
  pruneEarningsReportQueue
} from './src/workers/earningsReports.js';

/**
 * Targeted suite: Phase 29 passbook earnings archive (v1.92.0).
 * Stateless — every case runs against createMockSupabase (no live rows created,
 * so no cleanup is required per rule 10).
 */

let passed = 0;
function check(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  passed += 1;
  console.log(`✅ ${msg}`);
}

const SELLER = { id: 'p-seller', full_name: 'Amina Seller', phone_number: '+254700000101', email: 'seller@example.com' };
const BUYER = { id: 'p-buyer', full_name: 'Brian Buyer', phone_number: '+254700000102', email: 'buyer@example.com', subscription_tier: 'free', subscription_status: 'active' };
const VEHICLE = { id: 'v1', plate_number: 'KDA 123A', owner_id: 'p-seller', owner_phone: '+254700000101', transfer_count_current_year: 0, asset_type: 'vehicle' };

function transferSeed(overrides = {}) {
  return {
    id: 't-1',
    vehicle_id: 'v1',
    from_owner_id: 'p-seller',
    to_owner_phone: '+254700000102',
    to_owner_email: null,
    buyer_otp: '123456',
    buyer_otp_expires_at: '2030-01-01T00:00:00.000Z',
    status: 'PENDING_BUYER_OTP',
    vin: 'VIN123456789',
    seller: { ...SELLER },
    vehicles: { ...VEHICLE },
    ...overrides
  };
}

function archiveSeed() {
  return {
    profiles: [{ ...SELLER }, { ...BUYER }],
    vehicles: [{ ...VEHICLE }],
    passbook_transfers: [transferSeed()],
    vin_registry: [{ vin: 'VIN123456789', current_vehicle_id: 'v1' }],
    private_earnings: [
      { id: 'e1', vehicle_id: 'v1', revenue_amount: 1000, earning_type: 'Trips', logged_at: '2026-05-01T09:00:00.000Z', archived_at: null, archived_by_transfer_id: null },
      { id: 'e2', vehicle_id: 'v1', revenue_amount: 2000, earning_type: 'Daily takings', logged_at: '2026-05-02T09:00:00.000Z', archived_at: null, archived_by_transfer_id: null },
      { id: 'e-old', vehicle_id: 'v1', revenue_amount: 9999, earning_type: 'Trips', logged_at: '2025-01-01T09:00:00.000Z', archived_at: '2025-02-01T09:00:00.000Z', archived_by_transfer_id: 't-old' }
    ],
    admin_audit_logs: []
  };
}

async function run() {
  console.log('=== PHASE 29 — PASSBOOK EARNINGS ARCHIVE (v1.92.0) ===');

  console.log('\n--- 1. archiveVehicleEarnings: one idempotent update ---');
  const mock = createMockSupabase(archiveSeed());
  const archived = await archiveVehicleEarnings({ supabase: mock.client, vehicleId: 'v1', transferId: 't-1', now: new Date('2026-06-01T10:00:00.000Z') });
  check(archived.ok === true && archived.archivedCount === 2, 'two LIVE earnings are archived (the pre-archived row is untouched)');
  const liveRows = mock.db.private_earnings.filter((row) => row.archived_at === '2026-06-01T10:00:00.000Z');
  check(liveRows.length === 2 && liveRows.every((row) => row.archived_by_transfer_id === 't-1'), 'archived_at + archived_by_transfer_id are stamped on the live rows');
  check(mock.db.private_earnings.find((row) => row.id === 'e-old').archived_by_transfer_id === 't-old', "an earlier transfer's archive is never rewritten");
  const again = await archiveVehicleEarnings({ supabase: mock.client, vehicleId: 'v1', transferId: 't-1' });
  check(again.archivedCount === 0, 'a replayed archive archives nothing (archived_at IS NULL guard)');

  let threw = false;
  try {
    await archiveVehicleEarnings({ supabase: mock.client, vehicleId: '', transferId: 't-1' });
  } catch { threw = true; }
  check(threw, 'archiveVehicleEarnings throws without a vehicle id (the caller owns the rollback)');

  const failing = createMockSupabase(archiveSeed(), {
    beforeUpdate: (table) => (table === 'private_earnings' ? { error: { message: 'simulated archive failure' } } : null)
  });
  let archiveThrew = false;
  try {
    await archiveVehicleEarnings({ supabase: failing.client, vehicleId: 'v1', transferId: 't-1' });
  } catch (err) {
    archiveThrew = /simulated archive failure/.test(err.message);
  }
  check(archiveThrew, 'a database error is THROWN (never swallowed) so the transfer can abort (D3)');

  console.log('\n--- 2. restoreArchivedEarnings (D3 rollback) ---');
  const restored = await restoreArchivedEarnings({ supabase: mock.client, transferId: 't-1' });
  check(restored.ok === true && mock.db.private_earnings.filter((row) => row.archived_by_transfer_id === 't-1').length === 0, 'the rollback clears only THIS transfer archive');

  console.log('\n--- 3. completePassbookTransfer: archive BEFORE the COMPLETED flip ---');
  const happyMock = createMockSupabase(archiveSeed());
  const sent = [];
  const completed = await completePassbookTransfer({
    buyerPhone: '+254700000102',
    providedOtp: '123456',
    supabase: happyMock.client,
    sendWhatsAppFn: async (phone, text) => sent.push({ phone, text })
  });
  check(completed.success === true, 'the transfer completes');
  check(happyMock.db.passbook_transfers[0].status === 'COMPLETED', 'the transfer row flips to COMPLETED');
  check(happyMock.db.private_earnings.filter((row) => row.archived_by_transfer_id === 't-1').length === 2, 'the archive landed before the flip (COMPLETED ⇒ archived)');
  const queueRows = happyMock.db[EARNINGS_REPORT_QUEUE_TABLE] || [];
  check(queueRows.length === 1 && queueRows[0].owner_id === 'p-seller' && queueRows[0].email === 'seller@example.com', 'one report-queue row is queued for the SELLER');
  const delay = new Date(queueRows[0].due_at).getTime() - new Date(queueRows[0].created_at).getTime();
  check(delay === EARNINGS_REPORT_DELAY_MS, 'the report is due exactly 10 minutes later (D2/D5)');
  check(sent.length === 1 && sent[0].phone === SELLER.phone_number && /has been archived and stays yours/.test(sent[0].text) && /final report/.test(sent[0].text), 'the seller is told the history is archived + a final report is coming');
  check(happyMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_TRANSFER_EARNINGS_ARCHIVED' && row.details.archivedCount === 2), 'the archive is audited with its count');

  console.log('\n--- 4. archive failure aborts the transfer (nothing changes) ---');
  const failMock = createMockSupabase(archiveSeed(), {
    beforeUpdate: (table) => (table === 'private_earnings' ? { error: { message: 'boom' } } : null)
  });
  const failed = await completePassbookTransfer({
    buyerPhone: '+254700000102',
    providedOtp: '123456',
    supabase: failMock.client,
    sendWhatsAppFn: async () => {}
  });
  check(failed.success === false && /Could not finalize the transfer\. Nothing was changed/.test(failed.error), 'the buyer gets the honest "please try again" copy');
  check(failMock.db.passbook_transfers[0].status === 'PENDING_BUYER_OTP', 'the transfer was NOT completed');
  check(failMock.db.private_earnings.every((row) => row.id === 'e-old' || row.archived_at === null), 'no earnings were archived');
  check(failMock.db.admin_audit_logs.some((row) => row.action === 'ADMIN_TRANSFER_ARCHIVE_FAILED'), 'the failure is audited ADMIN_TRANSFER_ARCHIVE_FAILED');

  console.log('\n--- 5. a later step failing rolls the archive back ---');
  const rollbackMock = createMockSupabase(archiveSeed(), {
    beforeUpdate: (table, payload) => (table === 'passbook_transfers' && payload?.status === 'COMPLETED'
      ? { error: { message: 'completion update failed' } }
      : null)
  });
  const rolledBack = await completePassbookTransfer({
    buyerPhone: '+254700000102',
    providedOtp: '123456',
    supabase: rollbackMock.client,
    sendWhatsAppFn: async () => {}
  });
  check(rolledBack.success === false, 'the transfer reports failure');
  check(rollbackMock.db.private_earnings.filter((row) => row.archived_by_transfer_id === 't-1').length === 0, 'the archive is rolled back (no COMPLETED row without archived earnings)');

  console.log('\n--- 6. queueEarningsReport is honest ---');
  const queueMock = createMockSupabase({});
  const queued = await queueEarningsReport({ supabase: queueMock.client, transferId: 't-9', ownerId: 'p-seller', email: 's@example.com', now: new Date('2026-06-01T10:00:00.000Z') });
  check(queued.ok === true && queueMock.db[EARNINGS_REPORT_QUEUE_TABLE][0].due_at === '2026-06-01T10:10:00.000Z', 'the due_at is the supplied now + 10 minutes');
  check((await queueEarningsReport({ supabase: null, transferId: 'x' })).ok === false, 'no client answers honestly');

  const recordsSeed = {
    profiles: [{ ...SELLER }, { ...BUYER }],
    vehicles: [{ ...VEHICLE, owner_id: 'p-buyer', owner_phone: '+254700000102', plate_number: 'KDA 123A' }],
    passbook_transfers: [transferSeed({ status: 'COMPLETED', completed_at: '2026-06-01T10:00:00.000Z' })],
    expense_logs: [
      { id: 'x1', vehicle_id: 'v1', expense_type: 'Fuel', amount: 500, created_at: '2026-05-10T09:00:00.000Z' }
    ],
    private_earnings: [
      { id: 'a1', vehicle_id: 'v1', revenue_amount: 1000, earning_type: 'Trips', logged_at: '2026-05-01T09:00:00.000Z', archived_at: '2026-06-01T10:00:00.000Z', archived_by_transfer_id: 't-1' },
      { id: 'a2', vehicle_id: 'v1', revenue_amount: 2000, earning_type: 'Daily takings', logged_at: '2026-05-02T09:00:00.000Z', archived_at: '2026-06-01T10:00:00.000Z', archived_by_transfer_id: 't-1' },
      { id: 'live1', vehicle_id: 'v1', revenue_amount: 4000, earning_type: 'Cargo & freight', logged_at: '2026-06-05T09:00:00.000Z', archived_at: null, archived_by_transfer_id: null }
    ]
  };

  console.log('\n--- 7. the BUYER never sees the seller earnings; the SELLER history does ---');
  const recordsMock = createMockSupabase(recordsSeed);
  const filters = { from: '2026-01-01', to: '2026-12-31', types: [], vehicleId: null, label: '', keyword: '', page: 0, pageSize: 20, history: false };
  const buyerRecords = await queryOwnerRecords({
    supabase: recordsMock.client,
    ownerId: 'p-buyer',
    vehicleIds: ['v1'],
    vehicles: recordsSeed.vehicles,
    filters
  });
  check(buyerRecords.ok === true && buyerRecords.total === 2, 'the buyer sees the expense + their OWN earning only (total 2)');
  check(!buyerRecords.rows.some((row) => row.kind === 'earning' && [1000, 2000].includes(row.amount)), "the seller's archived earnings are absent from the buyer's records");

  const sellerHistory = await queryArchivedEarnings({
    supabase: recordsMock.client,
    ownerId: 'p-seller',
    filters
  });
  check(sellerHistory.ok === true && sellerHistory.total === 2, 'the seller history returns both archived earnings');
  check(sellerHistory.rows.every((row) => row.archived === true && row.transferId === 't-1' && row.kind === 'earning'), 'every history row is marked archived with its transfer id');
  check(sellerHistory.rows.every((row) => row.vehicle === 'KDA 123A'), 'the history rows carry their plate label (even though the buyer owns the vehicle now)');

  console.log('\n--- 8. /d/records?history=1 (toggle + archived chip) ---');
  const parsedHistory = parseRecordsFilters({ history: '1', from: '2026-01-01', to: '2026-12-31' }, { vehicleIds: [] });
  check(parsedHistory.ok === true && parsedHistory.filters.history === true, 'parseRecordsFilters reads the history flag');
  check(parseRecordsFilters({ from: '2026-01-01', to: '2026-12-31' }, { vehicleIds: [] }).filters.history === false, 'the default view stays live records');
  check(recordsQueryString({ ...parsedHistory.filters, page: 0 }).includes('history=1'), 'history rides every shareable/export link');
  const html = renderRecordsPage({
    data: { ok: true, rows: sellerHistory.rows, total: 2, hasMore: false, page: 0, pageSize: 20, currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi' },
    filters: parsedHistory.filters,
    vehicles: []
  });
  check(/Transferred \(history\)/.test(html) && /All records/.test(html), 'the toggle renders both views');
  check(html.includes('Archived') && html.includes('Transferred assets (history)'), 'archived rows carry the chip and the page names the history view');
  check(!/\/d\/receipt\//.test(html), 'archived rows offer no receipt link (they are earnings)');

  console.log('\n--- 9. the sibling readers exclude archived earnings (rule 51) ---');
  const portfolio = await buildOwnerPortfolio({
    supabase: createMockSupabase({
      ...recordsSeed,
      vehicles: [{ ...VEHICLE, owner_id: 'p-buyer', owner_phone: '+254700000102' }]
    }).client,
    ownerId: 'p-buyer',
    countryInfo: { code: 'KE', currency: 'KES', locale: 'en-KE' },
    profile: { id: 'p-buyer', phone_number: '+254700000102' }
  });
  const portfolioRow = portfolio?.data?.tables?.[0]?.rows?.[0];
  check(portfolio?.ok === true && portfolioRow?.earnings === 4000, 'the portfolio counts only the live earning (4000), never the archived 3000');
  const readerSources = [
    ['fleetReports', 'src/services/fleetReports.js'],
    ['ownerPortfolio', 'src/services/ownerPortfolio.js'],
    ['vehicleDeepDive', 'src/services/vehicleDeepDive.js'],
    ['userContextSnapshot', 'src/services/userContextSnapshot.js'],
    ['reportMetrics', 'src/services/reportMetrics.js'],
    ['driverReports', 'src/services/driverReports.js']
  ].map(([name, file]) => [name, fs.readFileSync(file, 'utf8')]);
  for (const [name, source] of readerSources) {
    check(source.includes("from './earningsScope.js'") && /selectLiveEarnings\(/.test(source), `${name} reads LIVE earnings through the shared guard`);
    check(!/from\('private_earnings'\)/.test(source), `${name} has no unfiltered private_earnings query left`);
  }

  console.log('\n--- 10. the Final Earnings Report queue worker ---');
  const workerSeed = {
    profiles: [{ ...SELLER }],
    vehicles: [{ ...VEHICLE }],
    passbook_transfers: [transferSeed({ status: 'COMPLETED', completed_at: '2026-06-01T10:00:00.000Z' })],
    private_earnings: recordsSeed.private_earnings.filter((row) => row.archived_by_transfer_id === 't-1'),
    [EARNINGS_REPORT_QUEUE_TABLE]: [{
      id: 'q1', transfer_id: 't-1', owner_id: 'p-seller', email: 'seller@example.com',
      due_at: '2026-06-01T10:10:00.000Z', sent_at: null, attempts: 0, created_at: '2026-06-01T10:00:00.000Z'
    }]
  };
  const workerMock = createMockSupabase(workerSeed);
  const emails = [];
  const sweep = await runEarningsReportQueue({
    supabase: workerMock.client,
    sendEmailFn: async (payload) => { emails.push(payload); return true; },
    now: new Date('2026-06-01T10:11:00.000Z')
  });
  check(sweep.ok === true && sweep.sent === 1 && emails.length === 1, 'the due queue row sends exactly one email');
  check(Buffer.isBuffer(emails[0].pdfBuffer) && emails[0].pdfBuffer.subarray(0, 5).toString() === '%PDF-', 'the attachment is a real PDF buffer');
  check(emails[0].to === 'seller@example.com' && emails[0].plateLabel === 'KDA 123A' && emails[0].entryCount === 2, 'the email names the seller, plate and entry count');
  check(workerMock.db[EARNINGS_REPORT_QUEUE_TABLE][0].sent_at === '2026-06-01T10:11:00.000Z', 'sent_at is stamped');
  const secondSweep = await runEarningsReportQueue({ supabase: workerMock.client, sendEmailFn: async () => true, now: new Date('2026-06-01T10:12:00.000Z') });
  check(secondSweep.processed === 0, 'a sent row is never retried');
  const notDue = await runEarningsReportQueue({ supabase: createMockSupabase({ empty: [] }).client, sendEmailFn: async () => true, now: new Date('2026-06-01T10:12:00.000Z') });
  check(notDue.ok === true && notDue.processed === 0, 'an empty queue is a no-op');
  const failingSend = createMockSupabase(JSON.parse(JSON.stringify(workerSeed)));
  const failedSweep = await runEarningsReportQueue({
    supabase: failingSend.client,
    sendEmailFn: async () => false,
    now: new Date('2026-06-01T10:11:00.000Z')
  });
  check(failedSweep.failed === 1 && failingSend.db[EARNINGS_REPORT_QUEUE_TABLE][0].attempts === 1 && failingSend.db[EARNINGS_REPORT_QUEUE_TABLE][0].sent_at === null, 'a failed send retries (attempts increments, never a fake sent_at)');
  const noEarningsSeed = JSON.parse(JSON.stringify(workerSeed));
  noEarningsSeed.private_earnings = [];
  const noEarnings = await runEarningsReportQueue({ supabase: createMockSupabase(noEarningsSeed).client, sendEmailFn: async () => true, now: new Date('2026-06-01T10:11:00.000Z') });
  check(noEarnings.closed === 1, 'a transfer with no archived earnings closes honestly instead of retrying forever');
  const pruneMock = createMockSupabase({
    [EARNINGS_REPORT_QUEUE_TABLE]: [
      { id: 'old', transfer_id: 't-old', sent_at: '2026-01-01T00:00:00.000Z', due_at: '2026-01-01T00:00:00.000Z', attempts: 0 },
      { id: 'fresh', transfer_id: 't-new', sent_at: '2026-06-01T00:00:00.000Z', due_at: '2026-06-01T00:00:00.000Z', attempts: 0 }
    ]
  });
  const pruned = await pruneEarningsReportQueue({ supabase: pruneMock.client, now: new Date('2026-06-15T00:00:00.000Z') });
  check(pruned.ok === true && pruned.removed === 1 && pruneMock.db[EARNINGS_REPORT_QUEUE_TABLE].length === 1, 'sent rows older than 30 days are pruned');

  console.log(`\n🎉 ${passed} passbook-earnings assertions passed.`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
