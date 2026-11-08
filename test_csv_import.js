/**
 * Saka Fleet — CSV bulk import suite (v1.81.0, Phase 20)
 * -----------------------------------------------------
 * Stateless: parser quirks, every validation class, the ONE-read dedupe, the
 * chunked insert shape, the honest failures and the two source pins that keep
 * rule 26 (no trial activation) and the after-write contract true.
 */

import fs from 'node:fs';
import { createMockSupabase } from './scripts/mockSupabase.js';
import {
  CSV_IMPORT_ERROR_COPY,
  parseCsv,
  normalizeImportPlate,
  parseImportAmount,
  parseImportOdometer,
  sanitizeImportNotes,
  validateImportRows,
  summarizeImport,
  loadRecentExpensesForImport,
  bulkInsertImportRows
} from './src/services/csvImport.js';

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const NOW = new Date('2026-11-08T09:00:00+03:00');
const HEADER = 'Date,Vehicle Plate,Type,Amount,Odometer,Notes';
const vehicles = [
  { id: 'v-a', plate_number: 'KDA 123A', current_mileage: 100000 },
  { id: 'v-b', plate_number: 'KDB 456B', current_mileage: 200000 }
];
const asIso = (dateKey) => new Date(`${dateKey}T12:00:00+03:00`).toISOString();

console.log('=== SAKA FLEET — CSV IMPORT TESTS (v1.81.0) ===\n');

console.log('--- Test 1: parser (BOM, CRLF, quotes, escapes) ---');
const csvText = `\uFEFF${HEADER}\r\n2026-11-01,KDA 123A,diesel,"5,000",100500,"Shell, Karen"\r\n2026-11-02,KDB 456B,"Repairs","3,000",,"Brake pads ""front"""\r\n`;
const parsed = parseCsv(csvText);
check(parsed.ok === true, 'a well-formed CSV parses');
check(parsed.rows.length === 2, 'two data rows are returned (the BOM header is not a row)');
check(parsed.rows[0].amount === '5,000', 'quoted thousands separators survive intact');
check(parsed.rows[0].notes === 'Shell, Karen', 'commas inside quotes never split a field');
check(parsed.rows[1].notes === 'Brake pads "front"', 'escaped double quotes decode');
check(parsed.rows[0].line === 2 && parsed.rows[1].line === 3, 'line numbers are file lines (header = line 1)');

const multiline = parseCsv(`${HEADER}\n2026-11-03,KDA 123A,Fuel,1000,,"line one\nline two"\n`);
check(multiline.ok && multiline.rows[0].notes === 'line one\nline two', 'a newline inside quotes stays inside the field');
check(parseCsv(`${HEADER}\n\n2026-11-01,KDA 123A,Fuel,1000,,ok\n`).rows.length === 1, 'blank lines are skipped');

console.log('\n--- Test 2: header aliases + missing columns ---');
const alias = parseCsv('logged_date,vehicle_plate,expense_type,cost,mileage,description\n2026-11-01,KDA 123A,Fuel,1000,100500,ok');
check(alias.ok && alias.rows[0].type === 'Fuel' && alias.rows[0].odometer === '100500', 'common header aliases resolve');
const headerCase = parseCsv('DATE,VehIcle Plate,TYPE,AMOUNT\n2026-11-01,KDA 123A,Fuel,1000');
check(headerCase.ok === true, 'header matching is case-insensitive');
const missing = parseCsv('Date,Vehicle Plate,Amount\n2026-11-01,KDA 123A,100');
check(!missing.ok && missing.reason === 'missing_columns' && /Type/.test(missing.error), 'a missing Type column names the column it needs');

console.log('\n--- Test 3: caps and malformed files ---');
check(parseCsv('').reason === 'empty', 'an empty file is refused honestly');
check(parseCsv(`${HEADER}\n2026-11-01,KDA 123A,Fuel,1000,,a\n2026-11-02,KDA 123A,Fuel,2000,,b`, { maxRows: 1 }).reason === 'too_many_rows', 'the row cap refuses, never truncates silently');
check(parseCsv(`${HEADER}\n2026-11-01,KDA 123A,Fuel,1000,,a`, { maxBytes: 10 }).reason === 'too_large', 'the byte cap refuses oversized files');
const unterminated = parseCsv('Date,Vehicle Plate,Type,Amount\n2026-11-01,KDA 123A,Fuel,"5000');
check(!unterminated.ok && unterminated.reason === 'unterminated_quote', 'an unclosed quote is named, not guessed');

console.log('\n--- Test 4: field parsers ---');
check(normalizeImportPlate(' kda-123a ') === 'KDA123A', 'plates compare on their alphanumeric core');
check(parseImportAmount('5,000') === 5000 && parseImportAmount('5500.50') === 5500.5, 'amounts accept thousands separators and cents');
for (const bad of ['-5', 'abc', '', '0', '0.00', '1e5', '100000001']) {
  check(parseImportAmount(bad) === null, `amount "${bad}" is refused`);
}
check(parseImportOdometer('50,350') === 50350, 'odometer accepts thousands separators');
check(parseImportOdometer('') === null && parseImportOdometer('50.5') === null && parseImportOdometer('0') === null, 'an empty/invalid odometer is null, not zero');
const longNotes = sanitizeImportNotes('x'.repeat(501));
check(!longNotes.ok && longNotes.value.length === 500, 'notes are capped at 500 characters');
check(sanitizeImportNotes('  a\n\tb  ').value === 'a b', 'control characters collapse into single spaces');

console.log('\n--- Test 5: every validation class ---');
const rows = [
  { line: 2, date: '2026-11-01', plate: 'KDA 123A', type: 'diesel', amount: '5,000', odometer: '100,500', notes: 'Shell' },
  { line: 3, date: '2026-11-02', plate: 'KDX 999X', type: 'Fuel', amount: '1000', odometer: '', notes: '' },
  { line: 4, date: '2026-11-02', plate: 'KDA 123A', type: 'banana', amount: '1000', odometer: '', notes: '' },
  { line: 5, date: '2026-11-02', plate: 'KDA 123A', type: 'Fuel', amount: '-20', odometer: '', notes: '' },
  { line: 6, date: 'not-a-date', plate: 'KDA 123A', type: 'Fuel', amount: '1000', odometer: '', notes: '' },
  { line: 7, date: '2030-01-01', plate: 'KDA 123A', type: 'Fuel', amount: '1000', odometer: '', notes: '' },
  { line: 8, date: '2026-11-02', plate: 'KDA 123A', type: 'Fuel', amount: '1000', odometer: '12x', notes: '' },
  { line: 9, date: '2026-11-02', plate: 'KDA 123A', type: 'Parking', amount: '200', odometer: '', notes: 'x'.repeat(501) },
  { line: 10, date: '2026-11-01', plate: 'KDA 123A', type: 'Fuel', amount: '5,000', odometer: '100,500', notes: 'dup' }
];
const validation = validateImportRows({ rows, vehicles, countryCode: 'KE', now: NOW });
check(validation.counts.total === 9 && validation.counts.valid === 1 && validation.counts.invalid === 8,
  `counts are exact (${validation.counts.valid} valid / ${validation.counts.invalid} invalid)`);
check(validation.valid[0].expenseType === 'Fuel', 'a free-text type canonicalises through the catalog (diesel -> Fuel)');
check(validation.valid[0].createdAt === asIso('2026-11-01'), 'the date lands at Nairobi noon, stored as UTC (rule 7)');
check(validation.valid[0].plate === 'KDA 123A' && validation.valid[0].vehicleId === 'v-a', 'the plate resolves to the owner vehicle');
check(validation.valid[0].odometer === 100500 && validation.valid[0].notes === 'Shell', 'odometer and notes survive validation');
const codes = validation.invalid.map((row) => row.errors[0]);
check(codes.join(',') === 'unknown_plate,unknown_type,bad_amount,bad_date,future_date,bad_odometer,notes_too_long,duplicate_row',
  `each error class fires once (${codes.join(', ')})`);
check(validation.invalid[0].line === 3 && validation.invalid[7].line === 10, 'invalid rows keep their file line for the preview');

console.log('\n--- Test 6: 3-hour DB dedupe + in-file duplicates ---');
const recentExpenses = [{ vehicle_id: 'v-a', amount: 7000, expense_type: 'Fuel', odometer_reading: 101000, created_at: '2026-11-07T09:00:00.000Z' }];
const dupRow = { line: 2, date: '2026-11-07', plate: 'KDA 123A', type: 'Fuel', amount: '7,000', odometer: '', notes: '' };
const dupCheck = validateImportRows({ rows: [dupRow], vehicles, recentExpenses, now: NOW });
check(dupCheck.invalid[0].errors.includes('duplicate_existing'), 'an expense saved in the last few hours is refused');
const odoRow = { ...dupRow, odometer: '102,000' };
check(validateImportRows({ rows: [odoRow], vehicles, recentExpenses, now: NOW }).counts.valid === 1,
  'a different odometer reading is a separate fill (the guard precedent)');

console.log('\n--- Test 7: preview summary ---');
const summary = summarizeImport(validation);
check(summary.rows.length === 9 && summary.rows[0].line === 2 && summary.rows.at(-1).line === 10, 'the preview lists every row in file order');
check(summary.counts.invalid === 8 && summary.counts.valid === 1, 'the summary carries the exact counts');

console.log('\n--- Test 8: the dedupe read is ONE query and fails open ---');
const recentMock = createMockSupabase({
  expense_logs: [{ id: 'e1', vehicle_id: 'v-a', amount: 1000, expense_type: 'Fuel', odometer_reading: null, created_at: new Date().toISOString() }]
});
const recent = await loadRecentExpensesForImport(recentMock.client, { vehicleIds: ['v-a'], now: NOW });
check(recent.ok && recent.rows.length === 1, 'one bulk read returns the recent expenses');
check(recentMock.state.calls === 1, 'exactly ONE query for the whole dedupe slice (never N)');
const noIds = await loadRecentExpensesForImport(recentMock.client, { vehicleIds: [] });
check(noIds.ok && noIds.rows.length === 0 && recentMock.state.calls === 1, 'no vehicles means no query at all');
const noopBuilder = {
  select: () => noopBuilder,
  eq: () => noopBuilder,
  gte: () => noopBuilder,
  limit: async () => ({ data: [], error: null }),
  insert: () => noopBuilder,
  select: () => noopBuilder,
  maybeSingle: async () => ({ data: null, error: null })
};
const failingClient = {
  from(table) {
    if (table === 'expense_logs') {
      const chain = {
        select: () => chain,
        in: () => chain,
        gte: () => chain,
        limit: async () => { throw new Error('db down'); }
      };
      return chain;
    }
    return noopBuilder;
  }
};
const openFail = await loadRecentExpensesForImport(failingClient, { vehicleIds: ['v-a'] });
check(openFail.ok && openFail.rows.length === 0, 'a failed dedupe read fails OPEN — the import still proceeds (rule 50)');

console.log('\n--- Test 9: chunked insert shape (parity with the quiz write) ---');
process.env.LEGACY_EXPENSES_WRITE_ENABLED = 'true';
const insertMock = createMockSupabase({ vehicles: [{ ...vehicles[0], status: 'ACTIVE' }, { ...vehicles[1], status: 'ACTIVE' }], admin_audit_logs: [] });
const insertRows = [
  { line: 2, plate: 'KDA 123A', vehicleId: 'v-a', expenseType: 'Fuel', amount: 5000, odometer: 100500, notes: 'Shell', dateKey: '2026-11-01', createdAt: asIso('2026-11-01') },
  { line: 3, plate: 'KDB 456B', vehicleId: 'v-b', expenseType: 'Repairs', amount: 3000, odometer: null, notes: null, dateKey: '2026-11-02', createdAt: asIso('2026-11-02') }
];
const insert = await bulkInsertImportRows({ supabase: insertMock.client, ownerId: 'owner-1', validRows: insertRows, vehicles, now: NOW });
check(insert.ok && insert.inserted === 2, 'both valid rows are inserted');
const expenseInserts = insertMock.state.inserts.filter((entry) => entry.table === 'expense_logs');
check(expenseInserts.length === 1 && expenseInserts[0].rows.length === 2, 'one chunked insert carries both rows');
const row0 = expenseInserts[0].rows[0];
check(row0.driver_id === 'owner-1' && row0.expense_type === 'Fuel' && row0.amount === 5000, 'the row shape matches the quiz write');
check(row0.fuel_liters === 0 && row0.fill_type === null, 'no invented litres or fill type');
check(row0.created_at === asIso('2026-11-01'), 'the stated date lands in created_at');
check(row0.receipt_id === undefined, 'an imported row never invents a receipt link');
const mirror = insertMock.state.inserts.filter((entry) => entry.table === 'expenses');
check(mirror.length === 1 && mirror[0].rows[0].plate === 'KDA 123A', 'the legacy mirror writes while its flag is on');
const vehicleUpdate = insertMock.state.updates.find((entry) => entry.table === 'vehicles');
check(Boolean(vehicleUpdate) && vehicleUpdate.patch.current_mileage === 100500, 'the odometer advances to the highest imported reading only');
const audit = insertMock.state.inserts.find((entry) => entry.table === 'admin_audit_logs');
check(Boolean(audit) && audit.rows[0].action === 'CSV_IMPORT', 'the import is audited as CSV_IMPORT');

console.log('\n--- Test 10: kill switch + honest failures ---');
process.env.LEGACY_EXPENSES_WRITE_ENABLED = 'false';
const offMock = createMockSupabase({ vehicles: [{ ...vehicles[0], status: 'ACTIVE' }], admin_audit_logs: [] });
await bulkInsertImportRows({ supabase: offMock.client, ownerId: 'owner-1', validRows: [insertRows[0]], vehicles, now: NOW });
check(!offMock.state.inserts.some((entry) => entry.table === 'expenses'), 'LEGACY_EXPENSES_WRITE_ENABLED=false stops the mirror and never blocks the ledger');
process.env.LEGACY_EXPENSES_WRITE_ENABLED = 'true';
const refuseMock = createMockSupabase({}, { beforeInsert: (table) => (table === 'expense_logs' ? { error: { message: 'permission denied for table expense_logs' } } : null) });
const refused = await bulkInsertImportRows({ supabase: refuseMock.client, ownerId: 'owner-1', validRows: insertRows, vehicles });
check(!refused.ok && refused.inserted === 0 && /refused/.test(refused.error), 'a refused insert claims nothing saved (honest failure)');
const emptyRun = await bulkInsertImportRows({ supabase: insertMock.client, ownerId: 'owner-1', validRows: [] });
check(emptyRun.ok && emptyRun.inserted === 0, 'no valid rows is a clean no-op');

console.log('\n--- Test 11: source pins (rule 26 + after-write + rule 7 + D3) ---');
const source = fs.readFileSync('src/services/csvImport.js', 'utf8');
check(!/recordActivationEvent/.test(source), 'rule 26 — the import never touches trial activation');
check((source.match(/markUserDataChanged\(\{/g) || []).length === 1, 'the after-write hook fires exactly once per import');
check(source.includes("from './dateParser.js'"), 'rule 7 — dates route through the shared dateParser');
const routeSource = fs.readFileSync('src/routes/dashboard.js', 'utf8');
check(!/from '@fastify\/multipart'|addContentTypeParser\('multipart/.test(routeSource), 'D3 — no multipart parser is registered');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
check(!Object.keys(pkg.dependencies).some((name) => /multipart|csv-parse|papaparse|fast-csv/i.test(name)), 'no CSV/multipart package was added');

console.log('\n--- Test 12: every error code has engine copy ---');
for (const code of ['missing_plate', 'unknown_plate', 'unknown_type', 'bad_amount', 'bad_odometer', 'bad_date', 'future_date', 'notes_too_long', 'duplicate_row', 'duplicate_existing']) {
  check(Boolean(CSV_IMPORT_ERROR_COPY[code]), `copy exists for ${code}`);
}

console.log(`\n🎉 ${passed} CSV import assertions passed.`);
