import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import {
  detectLedgerCommand,
  parseEntrySelection,
  parseEntryEditRequest,
  resolveLedgerTurn,
  resolveLedgerVehicleScope,
  ledgerEntryKey,
  formatLedgerList,
  formatEditPreview,
  formatDeleteConfirm,
  formatEntryDiff,
  formatEntryUpdated,
  formatEntryRelogged,
  formatEntryDeleted,
  formatEntryRestored,
  ENTRY_RESTORE_WINDOW_MINUTES
} from './src/services/entryAnswers.js';
import {
  listLedgerEntries,
  relogLedgerEntry,
  deleteLedgerEntry,
  restoreLastDeleted,
  sanitizeEntryUpdate,
  LEDGER_AUDIT_ACTIONS
} from './src/services/entryLedger.js';
// v1.71.1 (P2-5) — the module namespace proves the dead export is gone.
import * as entryLedgerModule from './src/services/entryLedger.js';
import { runWithCleanup } from './scripts/testCleanup.js';

const OWNER_PHONE = '+254799123458';
const TEST_VIN = 'JT111UJ800012399';
const TEST_PLATE = 'KZL 331Z';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// v1.71.1 (P2-5) — the dead in-place editor is gone; the live correction path
// is relogLedgerEntry (delete & re-log, v1.37.0). Pinned so nobody re-adds it.
assert(!('applyEntryUpdate' in entryLedgerModule), 'P2-5: dead export applyEntryUpdate was removed');
assert(typeof entryLedgerModule.relogLedgerEntry === 'function', 'the live correction path relogLedgerEntry still exports');

const VEHICLES = [{ id: 'veh-1', plate_number: TEST_PLATE, owner_id: 'owner-1' }];
const COPY = { vehicles: VEHICLES, currency: 'KES', locale: 'en-KE' };
const SAMPLE = {
  id: 41,
  kind: 'expense',
  vehicle_id: 'veh-1',
  expense_type: 'Fuel',
  amount: 4500,
  fuel_liters: 40,
  fill_type: 'full_tank',
  odometer_reading: 50350,
  notes: null,
  created_at: '2026-11-01T07:15:00.000Z'
};

async function runTests() {
  console.log('=== EDITABLE LEDGER TESTS (v1.33.0) ===\n');

// v1.89.0 (Phase 27C) — nickname-first ledger scoping (D3). Pure: no DB.
console.log('--- Test 0: ledger scoping by asset nickname ---');
{
  const nickFleet = [
    { id: 'v1', plate_number: 'KDA 123A', nickname: 'The Workhorse' },
    { id: 'v2', plate_number: 'KCB 456B', nickname: 'The Sprinter' }
  ];
  const scopedNick = resolveLedgerVehicleScope({ text: 'edit entry for the workhorse', vehicles: nickFleet, activeVehicle: nickFleet[1] });
  assert(scopedNick.reason === 'nickname' && scopedNick.vehicleIds[0] === 'v1', 'a nickname scopes the ledger to that vehicle, before the active default');
  const scopedShared = resolveLedgerVehicleScope({
    text: 'my entries for the workhorse',
    vehicles: [{ id: 'v1', plate_number: 'KDA 123A', nickname: 'The Workhorse' }, { id: 'v2', plate_number: 'KCB 456B', nickname: 'The Workhorse' }],
    activeVehicle: null
  });
  assert(scopedShared.ambiguous === true && scopedShared.vehicleIds.length === 0, 'two assets sharing a nickname ask which vehicle (never a guess)');
  const scopedPlateStill = resolveLedgerVehicleScope({ text: 'my entries for kcb 456b', vehicles: nickFleet, activeVehicle: nickFleet[0] });
  assert(scopedPlateStill.reason === 'plate' && scopedPlateStill.vehicleIds[0] === 'v2', 'a plate still scopes when no nickname is named');
}

  // 1. Command detection
  console.log('--- Test 1: ledger command detection ---');
  assert(detectLedgerCommand('my entries')?.action === 'list', '"my entries" not detected as list');
  assert(detectLedgerCommand('show my ledger')?.action === 'list', '"show my ledger" not detected as list');
  assert(detectLedgerCommand('edit my last entry')?.action === 'edit', '"edit my last entry" not an edit');
  assert(detectLedgerCommand('edit my last entry')?.index === 1, 'last entry did not resolve to index 1');
  assert(detectLedgerCommand('delete entry 2')?.action === 'delete', '"delete entry 2" not a delete');
  assert(detectLedgerCommand('delete entry 2')?.index === 2, 'delete index not parsed');
  assert(detectLedgerCommand('remove my last expense')?.action === 'delete', '"remove my last expense" not a delete');
  assert(detectLedgerCommand('I made a mistake on the fuel entry')?.action === 'edit', 'mistake phrasing not an edit');
  assert(detectLedgerCommand('wrong amount on my last expense, delete it')?.action === 'delete', 'wrong+delete phrasing not a delete');
  // v1.54.5 — a correction to the OPEN draft must never be stolen as a
  // saved-entry edit (live 2026-11-03: "could not find an entry to change").
  assert(detectLedgerCommand('The fuel volume is definitely wrong. As I said earlier I do not remember the amount of liters but I do rem the price was 222 kes per liter') === null, 'a draft correction is not a ledger command');
  // v1.56.1 — "You deleted/wrote the wrong entry" is a complaint, not an edit.
  assert(detectLedgerCommand('You deleted the wrong entry') === null, 'complaint about Saka deleting the wrong entry is not an edit command');
  assert(detectLedgerCommand('you logged the wrong amount on the fuel entry') === null, 'complaint about what Saka logged is not an edit command');
  assert(detectLedgerCommand('edit entry 2 amount to 5000')?.action === 'edit', 'an explicit edit still works after the complaint guard');
  assert(detectLedgerCommand('restore')?.action === 'restore', '"restore" not detected');
  assert(detectLedgerCommand('undo my last entry')?.action === 'delete', '"undo my last entry" not a delete');
  assert(detectLedgerCommand('logged 40L at 50350 km') === null, 'a fresh log must not be a ledger command');
  assert(detectLedgerCommand('cancel my subscription') === null, 'a subscription cancel must not be a ledger command');
  assert(detectLedgerCommand('delete my account') === null, '"delete my account" must not be a ledger delete');
  assert(detectLedgerCommand('give me a fuel report') === null, 'a report request must not be a ledger command');
  console.log('✅ Ledger commands, misspellings and look-alike phrases are split correctly.');

  // 2. Selection parsing
  console.log('\n--- Test 2: entry selection ---');
  assert(parseEntrySelection('2') === 2, 'bare number not parsed');
  assert(parseEntrySelection('#3') === 3, '#n not parsed');
  assert(parseEntrySelection('entry 4') === 4, 'entry n not parsed');
  assert(parseEntrySelection('the second one') === 2, 'ordinal word not parsed');
  assert(parseEntrySelection('last') === 1, '"last" not parsed');
  assert(parseEntrySelection('hello there') === null, 'a plain sentence returned a selection');
  console.log('✅ Numbers, #ids and ordinals all resolve.');

  // 3. Edit parsing
  console.log('\n--- Test 3: edit request parsing ---');
  const full = parseEntryEditRequest('amount 10500 kes, type parts, odometer 50350, 42 litres, full tank, notes: changed receipt, label: karen run');
  assert(full.amount === 10500, `amount not parsed (${full.amount})`);
  assert(full.expense_type === 'Parts', `type not canonicalised (${full.expense_type})`);
  assert(full.odometer_reading === 50350, `odometer not parsed (${full.odometer_reading})`);
  assert(full.fuel_liters === 42, `litres not parsed (${full.fuel_liters})`);
  assert(full.fill_type === 'full_tank', 'fill type not parsed');
  assert(full.notes === 'changed receipt', `notes not parsed (${full.notes})`);
  assert(full.label === 'karen run', `label not parsed (${full.label})`);
  const money = parseEntryEditRequest('the amount should be 4,800');
  assert(money.amount === 4800, `comma amount not parsed (${money.amount})`);
  const fromTo = parseEntryEditRequest('change the type from repairs to parts');
  assert(fromTo.expense_type === 'Parts', `"from x to y" type not parsed (${fromTo.expense_type})`);
  const odometerOnly = parseEntryEditRequest('odometer was 50,900');
  assert(odometerOnly.odometer_reading === 50900, 'odometer sentence not parsed');
  assert(Object.keys(parseEntryEditRequest('thank you')).length === 0, 'a thank-you produced a change');
  assert(Object.keys(parseEntryEditRequest('change my name')).length === 0, 'a profile edit leaked into the ledger');
  console.log('✅ Amounts, canonical types, litres, fill type, odometer and notes parse in one turn.');


  // 4. Turn resolution incl. pending state
  console.log('\n--- Test 4: ledger turn resolution ---');
  const now = new Date('2026-11-01T09:00:00.000Z');
  const stamp = new Date('2026-11-01T08:59:00.000Z').toISOString();
  const pendingEdit = { mode: 'edit', key: ledgerEntryKey(SAMPLE), at: stamp };
  const pendingDelete = { mode: 'delete', key: ledgerEntryKey(SAMPLE), at: stamp };
  assert(resolveLedgerTurn({ pending: pendingEdit, text: 'amount 4800', now }).type === 'edit-apply', 'pending edit did not accept a change');
  assert(resolveLedgerTurn({ pending: pendingEdit, text: 'cancel', now }).type === 'cancel', 'cancel not honoured mid-edit');
  assert(resolveLedgerTurn({ pending: pendingEdit, text: '2', now }).type === 'select', 'a number did not re-target the pending edit');
  assert(resolveLedgerTurn({ pending: pendingDelete, text: 'DELETE', now }).type === 'delete-confirm', 'DELETE did not confirm');
  assert(resolveLedgerTurn({ pending: pendingDelete, text: 'yes', now }).type === 'delete-confirm', '"yes" did not confirm');
  assert(resolveLedgerTurn({ pending: pendingDelete, text: 'no', now }).type === 'cancel', '"no" did not cancel');
  const freshLog = resolveLedgerTurn({ pending: pendingEdit, text: 'Logged 40L at 50,350 km for 4,500', now });
  assert(freshLog.type === 'none' && freshLog.dropPending === true, 'a fresh log did not drop the stale edit prompt');
  const expired = resolveLedgerTurn({
    pending: { ...pendingEdit, at: new Date('2026-11-01T08:00:00.000Z').toISOString() },
    text: 'amount 4800',
    now
  });
  assert(expired.type === 'none', 'an expired edit prompt still captured the message');
  assert(resolveLedgerTurn({ text: 'my entries', now }).type === 'command', 'a plain list command was not resolved');
  console.log('✅ Pending edit/delete state, expiry and fresh-log protection all behave.');

  // v1.73.0 (Phase 10, P3-1) — pagination offset slices the merged list without
  // changing the default page (scoping + ordering intact).
  console.log('\n--- Test 4b: pagination offset (v1.73.0) ---');
  function ledgerListMock(expenseRows, earningRows = []) {
    return {
      from(table) {
        const rows = table === 'private_earnings' ? earningRows : expenseRows;
        const chain = {
          select() { return chain; },
          in() { return chain; },
          order() { return chain; },
          eq() { return chain; },
          limit() { return Promise.resolve({ data: rows, error: null }); }
        };
        return chain;
      }
    };
  }
  const tenExpenses = Array.from({ length: 10 }, (_, i) => ({
    id: `pg-${i + 1}`,
    vehicle_id: 'veh-pg',
    expense_type: 'Fuel',
    amount: 100 + i,
    created_at: new Date(Date.UTC(2026, 10, 1, 8, i + 1)).toISOString()
  }));
  const listMock = ledgerListMock(tenExpenses);
  const firstPage = await listLedgerEntries(listMock, { ownerId: 'owner-pg', vehicleIds: ['veh-pg'], limit: 6 });
  const secondPage = await listLedgerEntries(listMock, { ownerId: 'owner-pg', vehicleIds: ['veh-pg'], limit: 6, offset: 6 });
  assert(firstPage.length === 6 && secondPage.length === 4, 'offset pages slice the merged list without loss');
  assert(firstPage[0].id === 'pg-10' && firstPage[5].id === 'pg-5', 'page 1 is the newest 6, newest first');
  assert(secondPage[0].id === 'pg-4' && secondPage[3].id === 'pg-1', 'page 2 continues exactly where page 1 stopped');
  const beyond = await listLedgerEntries(listMock, { ownerId: 'owner-pg', vehicleIds: ['veh-pg'], limit: 6, offset: 40 });
  assert(beyond.length === 0, 'an offset past the end yields an empty page');
  console.log('✅ Offset pagination is deterministic and page 1 is unchanged.');

  // 5. Sanitizer: whitelist + immutability
  console.log('\n--- Test 5: sanitizeEntryUpdate whitelist ---');
  const locked = sanitizeEntryUpdate('expense', {
    amount: 5000, vin: 'HACKVIN', plate_number: 'XXX 111X', vehicle_id: 'other',
    driver_id: 'someone', created_at: '2000-01-01', id: 999
  });
  assert(locked.ok && locked.patch.amount === 5000, 'a valid amount was dropped');
  for (const field of ['vin', 'plate_number', 'vehicle_id', 'driver_id', 'created_at', 'id']) {
    assert(!(field in locked.patch), `${field} was writable through the ledger`);
    assert(locked.rejected.includes(field), `${field} was not reported as rejected`);
  }
  assert(sanitizeEntryUpdate('expense', { amount: -5 }).ok === false, 'a negative amount was accepted');
  assert(sanitizeEntryUpdate('expense', { amount: 999999999999 }).ok === false, 'an absurd amount was accepted');
  assert(sanitizeEntryUpdate('expense', { fuel_liters: 9000 }).ok === false, 'an absurd litre count was accepted');
  assert(sanitizeEntryUpdate('expense', { fill_type: 'half' }).ok === false, 'an invalid fill type was accepted');
  const typed = sanitizeEntryUpdate('expense', { expense_type: 'repairs' });
  assert(typed.patch.expense_type === 'Repairs', `expense type not canonicalised (${typed.patch.expense_type})`);
  const earningGuard = sanitizeEntryUpdate('earning', { fuel_liters: 40, odometer_reading: 100 });
  assert(!('fuel_liters' in earningGuard.patch) && !('odometer_reading' in earningGuard.patch), 'fuel fields leaked into an earning');
  // v1.59.0 — the optional label is editable on both kinds, sanitised, and an
  // empty value clears it.
  const labelled = sanitizeEntryUpdate('expense', { label: '  Karen   Run!  ' });
  assert(labelled.ok && labelled.patch.label === 'Karen Run', `label not sanitised (${labelled.patch.label})`);
  const labelCleared = sanitizeEntryUpdate('earning', { label: '' });
  assert(labelCleared.ok && labelCleared.patch.label === null, 'an empty label did not clear');
  const labelCapped = sanitizeEntryUpdate('expense', { label: 'x'.repeat(80) });
  assert(String(labelCapped.patch.label).length === 40, 'a label longer than 40 chars was not capped');
  console.log('✅ Only whitelisted, sane values reach the database (labels included).');

  // 6. Copy
  console.log('\n--- Test 6: deterministic copy ---');
  const list = formatLedgerList({
    entries: [SAMPLE, { ...SAMPLE, id: 42, expense_type: 'Parts', amount: 3200 }],
    ...COPY
  });
  assert(/\*1\./.test(list) && /\*2\./.test(list), 'numbered list missing numbers');
  assert(/edit 2/.test(list) && /delete 2/.test(list), 'list does not teach the next step');
  assert(/Ksh|KES/.test(list), `currency missing from the list (${list.split('\n')[2]})`);
  assert(/Nothing logged yet/.test(formatLedgerList({ entries: [], ...COPY })), 'empty state not handled');
  assert(/cancel/i.test(formatEditPreview(SAMPLE, COPY)), 'edit preview has no cancel path');
  assert(/\*DELETE\*/.test(formatDeleteConfirm(SAMPLE, COPY)), 'delete confirm does not ask for DELETE');
  const diff = formatEntryDiff(SAMPLE, { amount: 4800, expense_type: 'Parts' }, COPY);
  assert(diff.some((line) => /Amount:.*->/.test(line)), 'diff has no before->after line');
  assert(/Entry updated/.test(formatEntryUpdated({ entry: SAMPLE, patch: { amount: 4800 }, ...COPY })), 'update copy missing headline');
  assert(new RegExp(`${ENTRY_RESTORE_WINDOW_MINUTES} minutes`).test(formatEntryDeleted({ entry: SAMPLE, ...COPY })), 'delete copy omits the restore window');
  assert(/restored/i.test(formatEntryRestored({ entry: SAMPLE, ...COPY })), 'restore copy missing');
  assert(/Entry corrected/.test(formatEntryRelogged({ entry: SAMPLE, patch: { amount: 4800 }, ...COPY })), 'relog copy is missing the correction headline');
  assert(/re-logged/.test(formatEntryRelogged({ entry: SAMPLE, patch: { amount: 4800 }, ...COPY })), 'relog copy does not say the row was re-logged');
  console.log('✅ List, preview, diff, delete and restore copy are deterministic.');


  // 7. Live round-trip (skipped without credentials)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log('\n⚠️ Supabase credentials missing — live round-trip skipped.');
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  console.log('\n--- Test 7: live edit -> delete -> restore round-trip ---');

  const { data: owner, error: ownerErr } = await supabase.from('profiles').insert([{
    id: crypto.randomUUID(),
    phone_number: OWNER_PHONE,
    full_name: 'Editable Ledger Owner',
    is_active: true
  }]).select().single();
  assert(!ownerErr && owner, `Profile seed failed: ${ownerErr?.message}`);

  const { data: vehicle, error: vehErr } = await supabase.from('vehicles').insert([{
    id: crypto.randomUUID(),
    owner_id: owner.id,
    owner_phone: OWNER_PHONE,
    plate_number: TEST_PLATE,
    make_model: 'Isuzu NQR',
    yom: 2020,
    fuel_type: 'Diesel',
    current_mileage: 50000,
    odometer_reading: 50000,
    vin: TEST_VIN,
    status: 'ACTIVE'
  }]).select().single();
  assert(!vehErr && vehicle, `Vehicle seed failed: ${vehErr?.message}`);

  const { data: seededExpense, error: expErr } = await supabase.from('expense_logs').insert([{
    vehicle_id: vehicle.id,
    driver_id: owner.id,
    expense_type: 'Fuel',
    amount: 4500,
    fuel_liters: 40,
    fill_type: 'full_tank',
    odometer_reading: 50350,
    notes: 'seeded by test_entry_ledger',
    label: 'seed label'
  }]).select().single();
  assert(!expErr && seededExpense, `Expense seed failed: ${expErr?.message}`);
  assert(seededExpense.label === 'seed label', 'the optional label was not written on insert');

  const listed = await listLedgerEntries(supabase, { ownerId: owner.id, vehicleIds: [vehicle.id], limit: 6 });
  assert(listed.length === 1 && listed[0].id === seededExpense.id, 'seeded expense was not listed');
  assert(listed[0].kind === 'expense', 'listed row lost its kind');

  // v1.37.0 (D1) — corrections are delete & re-log: the old row is removed
  // with a snapshot audit, a FRESH row carries the corrected values and the
  // original entry date, and the DELETE audit row is consumed so `restore`
  // can never duplicate the corrected row.
  // v1.63.1 (2C) — each ledger write must drop the actor's cached facts.
  // The seeded row has owner_id NULL, so only the actorPhone delete can remove it
  // (behavioural proof of the documented C1 phone-only invalidation design).
  const seedUserContext = async () => {
    await supabase.from('user_context_cache').upsert([{
      phone_number: OWNER_PHONE,
      owner_id: null,
      payload: {},
      built_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString()
    }], { onConflict: 'phone_number' });
  };
  const userContextGone = async () => {
    for (let i = 0; i < 25; i += 1) {
      const { data } = await supabase.from('user_context_cache').select('phone_number').eq('phone_number', OWNER_PHONE);
      if (!data || data.length === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  const relogged = await relogLedgerEntry(supabase, {
    entry: listed[0],
    patch: { amount: 4800, expense_type: 'Parts', label: 'corrected label', vin: 'HACKVIN', created_at: '2000-01-01' },
    actorPhone: OWNER_PHONE
  });
  assert(await userContextGone(), 'relogLedgerEntry drops the actor cache (v1.63.1)');
  assert(relogged.ok, `Relog failed: ${relogged.reason}`);
  assert(relogged.patch.amount === 4800 && relogged.patch.expense_type === 'Parts', 'relog patch was not applied');
  assert(relogged.patch.label === 'corrected label', 'the label patch was not applied on relog');
  assert(relogged.rejected.includes('vin') && relogged.rejected.includes('created_at'), 'protected fields were not rejected');
  assert(relogged.relogged === true && relogged.entry.id !== seededExpense.id, 'the correction is a fresh row, not an in-place edit');

  const { data: oldGone } = await supabase.from('expense_logs').select('id').eq('id', seededExpense.id);
  assert(!oldGone || oldGone.length === 0, 'the old row was removed');
  const { data: freshRows } = await supabase.from('expense_logs').select('id,amount,expense_type,label,created_at').eq('id', relogged.entry.id);
  assert(freshRows?.length === 1 && Number(freshRows[0].amount) === 4800 && freshRows[0].expense_type === 'Parts', 'the fresh row carries the corrected values');
  assert(freshRows[0].label === 'corrected label', 'the fresh row carries the corrected label');
  assert(String(freshRows[0].created_at).startsWith(String(seededExpense.created_at).slice(0, 10)), 'the fresh row keeps the original entry date');
  console.log('✅ Correction = delete & re-log; locked fields rejected, date preserved.');

  const restoreAfterRelog = await restoreLastDeleted(supabase, { actorPhone: OWNER_PHONE, vehicleIds: [vehicle.id] });
  assert(!restoreAfterRelog.ok, 'a corrected (re-logged) row can never be restored into a duplicate');

  await seedUserContext();
  const removed = await deleteLedgerEntry(supabase, { entry: relogged.entry, actorPhone: OWNER_PHONE });
  assert(await userContextGone(), 'deleteLedgerEntry drops the actor cache (v1.63.1)');
  assert(removed.ok, `Delete failed: ${removed.reason}`);
  const { data: goneRows } = await supabase.from('expense_logs').select('id').eq('id', relogged.entry.id);
  assert(!goneRows || goneRows.length === 0, 'row was not hard-deleted');

  const { data: auditRows } = await supabase.from('admin_audit_logs')
    .select('action,details')
    .eq('admin_phone', OWNER_PHONE)
    .eq('action', LEDGER_AUDIT_ACTIONS.DELETED)
    .order('created_at', { ascending: false })
    .limit(1);
  assert(auditRows?.length === 1, 'delete was not audited');
  assert(auditRows[0].details?.snapshot?.id === relogged.entry.id, 'audit snapshot is missing the deleted row');
  console.log('✅ Hard delete + audit snapshot of the full row.');

  await seedUserContext();
  const restored = await restoreLastDeleted(supabase, { actorPhone: OWNER_PHONE, vehicleIds: [vehicle.id] });
  assert(await userContextGone(), 'restoreLastDeleted drops the actor cache (v1.63.1)');
  assert(restored.ok, `Restore failed: ${restored.reason}`);
  assert(restored.entry.id === relogged.entry.id, 'restore did not bring back the same row id');
  const { data: backRows } = await supabase.from('expense_logs').select('id,amount,label').eq('id', relogged.entry.id);
  assert(backRows?.length === 1, 'restored row is not in the ledger');
  assert(Number(backRows[0].amount) === 4800, 'restore lost the corrected amount');
  assert(backRows[0].label === 'corrected label', 'restore lost the corrected label');
  console.log('✅ Restore replays the snapshot exactly.');

  const restoredTwice = await restoreLastDeleted(supabase, { actorPhone: OWNER_PHONE, vehicleIds: [vehicle.id] });
  assert(!restoredTwice.ok, 'a deleted row was restored twice into a duplicate');

  console.log('\n🎉 All editable ledger tests passed.');
}

runWithCleanup({
  testFn: async () => {
    try {
      await runTests();
    } finally {
      // admin_audit_logs is not VIN/phone scoped by the shared cleaner.
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        try {
          const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
          await client.from('admin_audit_logs').delete().eq('admin_phone', OWNER_PHONE);
        } catch { /* best-effort */ }
      }
    }
  },
  phones: [OWNER_PHONE],
  vins: [TEST_VIN]
}).catch(err => {
  console.error('\n❌ Test suite failed:', err.message);
  process.exit(1);
});

