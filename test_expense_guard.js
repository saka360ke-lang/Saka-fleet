/**
 * Saka Fleet — expense guard suite (v1.72.0, Phase 8B / P2-3)
 * ----------------------------------------------------------
 * Offline: mocked Supabase only (no DB, no cleanup needed). Proves the
 * write-time duplicate guard reads the canonical `expense_logs` ledger by
 * vehicle_id (never the legacy `expenses` mirror).
 *
 * v1.88.2 — the LEGACY_EXPENSES_WRITE_ENABLED kill switch and the mirror it
 * guarded were REMOVED (the mirror named a non-existent column and failed
 * silently). This suite now pins the absence so the dead code can never return.
 *
 * Run: node test_expense_guard.js
 */
import assert from 'assert';
import fs from 'node:fs';
import {
  isDuplicateExpense,
  isSameExpenseCandidate,
  nairobiDateKey
} from './src/services/expenseGuard.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

/** Minimal chainable Supabase mock that applies the vehicle_id/plate filters. */
function makeGuardMock({ vehicles = [], logs = [], failWith = null } = {}) {
  const calls = [];
  const client = {
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const api = {
        select() { return api; },
        eq(column, value) { call.filters.push([column, value]); return api; },
        ilike(column, value) { call.filters.push([column, value]); return api; },
        gte(column, value) { call.filters.push([`gte:${column}`, value]); return api; },
        order() { return api; },
        limit() {
          let rows = table === 'vehicles' ? vehicles : table === 'expense_logs' ? logs : table === 'expenses' ? [{ amount: 1 }] : [];
          const vehicleFilter = call.filters.find(([column]) => column === 'vehicle_id');
          if (vehicleFilter && table === 'expense_logs') {
            rows = rows.filter((row) => String(row.vehicle_id) === String(vehicleFilter[1]));
          }
          const plateFilter = call.filters.find(([column]) => column === 'plate_number');
          if (plateFilter && table === 'vehicles') {
            rows = rows.filter((row) => String(row.plate_number).toLowerCase() === String(plateFilter[1]).toLowerCase());
          }
          return Promise.resolve(failWith ? { data: null, error: failWith } : { data: rows, error: null });
        }
      };
      return api;
    }
  };
  return { client, calls };
}

const recentLog = { vehicle_id: 'v-1', amount: 3000, expense_type: 'Fuel', odometer_reading: 367480, created_at: new Date().toISOString() };

console.log('=== SAKA FLEET - EXPENSE GUARD (P2-3) ===');

console.log('--- Test 1: the retired mirror can never return (v1.88.2) ---');
{
  // The kill switch + the mirror inserts were deleted; pin the absence so a
  // future edit cannot silently resurrect a write to the archival table.
  const guardSource = fs.readFileSync('src/services/expenseGuard.js', 'utf8');
  check(!guardSource.includes('legacyExpensesWriteEnabled'), 'the kill switch is gone from expenseGuard.js');
  check(!guardSource.includes('LEGACY_EXPENSES_WRITE_ENABLED'), 'no code reads the retired flag');
  for (const file of ['src/services/quizEngine.js', 'src/routes/whatsapp/commands.js', 'src/services/csvImport.js']) {
    const source = fs.readFileSync(file, 'utf8');
    check(!source.includes("from('expenses').insert"), `${file} carries no INSERT into the archival expenses table`);
    check(!source.includes('legacyExpensesWriteEnabled'), `${file} imports no retired kill switch`);
  }
}

console.log('--- Test 2: the guard reads expense_logs by vehicle_id (never expenses) ---');
{
  const { client, calls } = makeGuardMock({ logs: [recentLog] });
  const result = await isDuplicateExpense(client, { plate: 'KAS 628T', vehicleId: 'v-1', amount: 3000, expenseType: 'fuel', odometer: 367480 });
  check(result.duplicate === true, 'same vehicle + amount + type + Nairobi day is a duplicate');
  const logCall = calls.find((call) => call.table === 'expense_logs');
  check(Boolean(logCall) && logCall.filters.some(([column, value]) => column === 'vehicle_id' && value === 'v-1'), 'the ledger read filters on vehicle_id');
  check(!calls.some((call) => call.table === 'expenses'), 'the guard never queries the legacy expenses mirror');
  check(!calls.some((call) => call.table === 'vehicles'), 'a supplied vehicleId needs no plate lookup');
}
{
  const { client } = makeGuardMock({ logs: [recentLog] });
  const result = await isDuplicateExpense(client, { vehicleId: 'v-1', amount: 3000, expenseType: 'Fuel', odometer: 367500 });
  check(result.duplicate === false, 'a different odometer reading proves a separate fill');
}
{
  const { client } = makeGuardMock({ logs: [recentLog] });
  const result = await isDuplicateExpense(client, { vehicleId: 'v-2', amount: 3000, expenseType: 'Fuel', odometer: 367480 });
  check(result.duplicate === false, 'another vehicle can never be a duplicate');
}

console.log('--- Test 3: plate-only callers resolve the vehicle first ---');
{
  const { client, calls } = makeGuardMock({ vehicles: [{ id: 'v-9', plate_number: 'KAS 628T' }], logs: [{ ...recentLog, vehicle_id: 'v-9' }] });
  const result = await isDuplicateExpense(client, { plate: 'KAS 628T', amount: 3000, expenseType: 'Fuel', odometer: 367480 });
  check(result.duplicate === true, 'a plate-only lookup still finds the same-day duplicate');
  check(calls[0]?.table === 'vehicles', 'the vehicle is resolved from the plate first');
  check(calls.some((call) => call.table === 'expense_logs'), 'the ledger read follows the resolution');
}
{
  const { client, calls } = makeGuardMock({ vehicles: [], logs: [recentLog] });
  const result = await isDuplicateExpense(client, { plate: 'UNKNOWN 1', amount: 3000, expenseType: 'Fuel' });
  check(result.duplicate === false, 'an unknown plate never blocks a write');
  check(!calls.some((call) => call.table === 'expense_logs'), 'no ledger query runs without a resolved vehicle');
}

console.log('--- Test 4: fail-open contract ---');
{
  const { client } = makeGuardMock({ failWith: { message: 'db down' } });
  const result = await isDuplicateExpense(client, { vehicleId: 'v-1', amount: 3000, expenseType: 'Fuel' });
  check(result.duplicate === false, 'a guard failure never blocks a legitimate log');
}
{
  const { client, calls } = makeGuardMock();
  const result = await isDuplicateExpense(client, { amount: 3000, expenseType: 'Fuel' });
  check(result.duplicate === false && calls.length === 0, 'missing vehicle context short-circuits without queries');
  check((await isDuplicateExpense(null, { vehicleId: 'v-1', amount: 3000 })).duplicate === false, 'no client is a safe no-op');
}

console.log('--- Test 5: pure comparator remains intact ---');
check(nairobiDateKey('2026-11-07T00:30:00+03:00') === '2026-11-07', 'Nairobi calendar day key is stable');
check(isSameExpenseCandidate({ ...recentLog, created_at: new Date().toISOString() }, { amount: 3000, expenseType: 'fuel', odometer: 367480 }) === true, 'the comparator still matches on amount + type + day');

console.log(`\nALL EXPENSE GUARD TESTS PASSED (${passed} assertions).`);
