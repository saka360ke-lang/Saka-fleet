/**
 * Saka Fleet — Editable Ledger (v1.33.0)
 * --------------------------------------
 * One place that reads, edits, deletes and restores what Saka logged, for both
 * halves of the ledger: `expense_logs` (kind `expense`) and `private_earnings`
 * (kind `earning`, stored as `revenue_amount` + `logged_at`).
 *
 * Design decisions (mirrored in SAKA_FLEET_ARCHITECTURE.md §79):
 *   1. **No DDL.** Delete is a hard delete plus a full-row snapshot written to
 *      `admin_audit_logs` (`LEDGER_ENTRY_DELETED`), which is what makes the
 *      30-minute `restore` possible without a `deleted_at` column.
 *   2. **Whitelist only.** `sanitizeEntryUpdate()` decides what may change;
 *      `id`, `vehicle_id`, `driver_id`, `created_at`/`logged_at` and every
 *      vehicle identifier (VIN, plate, passbook) can never be rewritten here.
 *   3. **Owner or logging driver only.** The route resolves the lane; this
 *      service re-checks that the row belongs to a vehicle the caller can see.
 *   4. **Never throws.** Every function returns `{ ok, ... }` so a ledger
 *      command can degrade into one friendly sentence.
 */

import { normalizeExpenseType } from './expenseCatalog.js';
import { ENTRY_RESTORE_WINDOW_MINUTES, sanitizeEntryLabel } from './entryAnswers.js';
// v1.63.1 — every facts-changing write lands through the shared after-write hook.
import { markUserDataChanged } from './afterWrite.js';

export const LEDGER_TABLES = Object.freeze({
  expense: 'expense_logs',
  earning: 'private_earnings'
});

/**
 * v1.59.0 — optional per-record label migration (idempotent, rule 50).
 * `npm run migrate:entry-labels`
 */
export const ENTRY_LABEL_SQL = `
ALTER TABLE public.expense_logs ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE public.private_earnings ADD COLUMN IF NOT EXISTS label text;
`;

export const LEDGER_EDITABLE_FIELDS = Object.freeze({
  expense: Object.freeze(['expense_type', 'amount', 'fuel_liters', 'fill_type', 'odometer_reading', 'notes', 'label']),
  earning: Object.freeze(['earning_type', 'amount', 'notes', 'label'])
});

/** Columns that may never be rewritten through the ledger (audit + identifiers). */
export const LEDGER_PROTECTED_FIELDS = Object.freeze([
  'id', 'vehicle_id', 'driver_id', 'owner_id', 'created_at', 'logged_at',
  'vin', 'plate_number', 'qr_passbook_token'
]);

export const LEDGER_AUDIT_ACTIONS = Object.freeze({
  UPDATED: 'LEDGER_ENTRY_UPDATED',
  DELETED: 'LEDGER_ENTRY_DELETED',
  RESTORED: 'LEDGER_ENTRY_RESTORED'
});

const MAX_AMOUNT = 1000000000;
const MAX_ODOMETER = 10000000;
const MAX_LITRES = 5000;
const FILL_TYPES = Object.freeze(['full_tank', 'top_up']);

function toNumber(value) {
  const n = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** Trim/normalise one patch. Returns `{ ok, patch, rejected }`; never throws. */
export function sanitizeEntryUpdate(kind = 'expense', patch = {}) {
  const allowed = LEDGER_EDITABLE_FIELDS[kind] || LEDGER_EDITABLE_FIELDS.expense;
  const clean = {};
  const rejected = [];
  for (const [key, rawValue] of Object.entries(patch || {})) {
    if (LEDGER_PROTECTED_FIELDS.includes(key) || !allowed.includes(key)) { rejected.push(key); continue; }
    if (key === 'amount') {
      const value = toNumber(rawValue);
      if (!Number.isFinite(value) || value <= 0 || value > MAX_AMOUNT) { rejected.push(key); continue; }
      clean.amount = Math.round(value * 100) / 100;
      continue;
    }
    if (key === 'fuel_liters') {
      const value = toNumber(rawValue);
      if (!Number.isFinite(value) || value < 0 || value > MAX_LITRES) { rejected.push(key); continue; }
      clean.fuel_liters = Math.round(value * 100) / 100;
      continue;
    }
    if (key === 'odometer_reading') {
      const value = toNumber(rawValue);
      if (!Number.isFinite(value) || value < 0 || value > MAX_ODOMETER) { rejected.push(key); continue; }
      clean.odometer_reading = Math.round(value);
      continue;
    }
    if (key === 'fill_type') {
      const value = String(rawValue || '').toLowerCase().replace(/\s+/g, '_');
      if (!FILL_TYPES.includes(value)) { rejected.push(key); continue; }
      clean.fill_type = value;
      continue;
    }
    if (key === 'expense_type') {
      const value = normalizeExpenseType(String(rawValue || ''));
      if (!value) { rejected.push(key); continue; }
      clean.expense_type = value;
      continue;
    }
    if (key === 'earning_type') {
      const value = String(rawValue || '').trim().slice(0, 60);
      if (!value) { rejected.push(key); continue; }
      clean.earning_type = value;
      continue;
    }
    if (key === 'notes') {
      const value = String(rawValue || '').trim().slice(0, 500);
      clean.notes = value || null;
      continue;
    }
    if (key === 'label') {
      // v1.59.0 — optional searchable label; empty clears it.
      clean.label = sanitizeEntryLabel(rawValue);
    }
  }
  return { ok: Object.keys(clean).length > 0, patch: clean, rejected };
}

function shapeRow(row, kind) {
  if (!row) return null;
  if (kind === 'earning') {
    return {
      ...row,
      kind: 'earning',
      table: LEDGER_TABLES.earning,
      amount: row.revenue_amount,
      created_at: row.logged_at || row.created_at || null
    };
  }
  return { ...row, kind: 'expense', table: LEDGER_TABLES.expense };
}


/**
 * Latest ledger rows across both tables, newest first.
 * Driver lane sees only rows it logged; owner lane sees the whole fleet slice.
 */
export async function listLedgerEntries(supabase, {
  ownerId = null,
  driverId = null,
  vehicleIds = [],
  limit = 6,
  includeEarnings = true
} = {}) {
  const cap = Math.max(1, Math.min(20, Number(limit) || 6));
  const scoped = (vehicleIds || []).filter(Boolean);
  if (!supabase || !scoped.length) return [];

  const collect = async (kind, builder) => {
    try {
      const { data, error } = await builder();
      if (error) return [];
      return (data || []).map((row) => shapeRow(row, kind));
    } catch { return []; }
  };

  const expenseQuery = () => {
    let q = supabase.from(LEDGER_TABLES.expense)
      .select('id,vehicle_id,driver_id,expense_type,amount,fuel_liters,fill_type,odometer_reading,notes,label,created_at')
      .in('vehicle_id', scoped)
      .order('created_at', { ascending: false })
      .limit(cap * 3);
    if (driverId && !ownerId) q = q.eq('driver_id', driverId);
    return q;
  };

  const earningQuery = () => {
    let q = supabase.from(LEDGER_TABLES.earning)
      .select('id,vehicle_id,driver_id,revenue_amount,currency,earning_type,notes,label,logged_at')
      .in('vehicle_id', scoped)
      .order('logged_at', { ascending: false })
      .limit(cap * 3);
    if (driverId && !ownerId) q = q.eq('driver_id', driverId);
    return q;
  };

  const [expenses, earnings] = await Promise.all([
    collect('expense', expenseQuery),
    includeEarnings ? collect('earning', earningQuery) : Promise.resolve([])
  ]);

  return [...expenses, ...earnings]
    .filter((row) => row && row.created_at)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, cap);
}

/** Fetch one row by `kind:id` and prove the caller can see its vehicle. */
export async function getLedgerEntry(supabase, { key = null, vehicleIds = [], driverId = null, ownerId = null } = {}) {
  if (!supabase || !key) return null;
  const [kind, rawId] = String(key).split(':');
  if (!LEDGER_TABLES[kind] || !rawId) return null;
  const scoped = (vehicleIds || []).filter(Boolean);
  if (!scoped.length) return null;
  try {
    const { data, error } = await supabase.from(LEDGER_TABLES[kind]).select('*').eq('id', rawId).limit(1);
    if (error || !data?.length) return null;
    const row = shapeRow(data[0], kind);
    if (!scoped.includes(row.vehicle_id)) return null;
    if (driverId && !ownerId && row.driver_id && row.driver_id !== driverId) return null;
    return row;
  } catch { return null; }
}

async function writeAudit(supabase, { action, actorPhone, details }) {
  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: actorPhone || 'LEDGER',
      action,
      details,
      created_at: new Date().toISOString()
    }]);
  } catch { /* the ledger write already succeeded; audit is best-effort */ }
}

/**
 * v1.37.0 (D1) — mark a DELETE audit row consumed once its snapshot has been
 * superseded by a correction re-log, so `restore` can never resurrect a
 * duplicate of the corrected row.
 */
export async function markDeletedEntryRelogged(supabase, { deletedEntryId = null, reloggedEntryId = null, actorPhone = null } = {}) {
  if (!supabase || !deletedEntryId || !reloggedEntryId) return { ok: false, reason: 'missing_ids' };
  try {
    const { data: rows, error: readError } = await supabase.from('admin_audit_logs')
      .select('id,details')
      .eq('action', LEDGER_AUDIT_ACTIONS.DELETED)
      .order('created_at', { ascending: false })
      .limit(25);
    if (readError) return { ok: false, reason: 'read_failed', message: readError.message };
    const target = (rows || []).find((row) => (
      String(row.details?.entry_id || '') === String(deletedEntryId) && !row.details?.relogged_entry_id
    ));
    if (!target) return { ok: false, reason: 'audit_row_not_found' };
    const details = { ...(target.details || {}), relogged_entry_id: reloggedEntryId };
    const { error: updateError } = await supabase.from('admin_audit_logs').update({ details }).eq('id', target.id);
    if (updateError) return { ok: false, reason: 'write_failed', message: updateError.message };
    await writeAudit(supabase, {
      action: LEDGER_AUDIT_ACTIONS.UPDATED,
      actorPhone,
      details: {
        kind: 'ledger_audit',
        relogged_entry_id: reloggedEntryId,
        consumed_audit_id: target.id,
        note: 'DELETE snapshot consumed by correction re-log'
      }
    });
    return { ok: true, auditId: target.id };
  } catch (err) {
    return { ok: false, reason: 'write_failed', message: err.message };
  }
}

/**
 * v1.37.0 (D1) — corrections are "delete & re-log": the old row is hard-
 * deleted (with its full snapshot audit), a FRESH row carries the corrected
 * values while keeping the original entry date (created_at rides the fresh
 * insert, exactly like the narrative retro-date rule), and the DELETE audit
 * row is marked consumed so `restore` can never duplicate it.
 */
export async function relogLedgerEntry(supabase, { entry = null, patch = {}, actorPhone = null, vehicleIds = null } = {}) {
  if (!supabase || !entry) return { ok: false, reason: 'no_entry' };
  const entryScope = (vehicleIds || []).filter(Boolean);
  if (entryScope.length && !entryScope.includes(entry.vehicle_id)) return { ok: false, reason: 'not_yours' };
  const kind = entry.kind === 'earning' ? 'earning' : 'expense';
  const { ok, patch: clean, rejected } = sanitizeEntryUpdate(kind, patch);
  if (!ok) return { ok: false, reason: 'no_valid_change', rejected };

  // Earnings keep their money in `revenue_amount` and have no fuel columns.
  const write = { ...clean };
  if (kind === 'earning') {
    if (write.amount !== undefined) { write.revenue_amount = write.amount; delete write.amount; }
    delete write.fuel_liters;
    delete write.fill_type;
    delete write.odometer_reading;
  }

  try {
    const { data, error: readError } = await supabase.from(LEDGER_TABLES[kind]).select('*').eq('id', entry.id).limit(1);
    if (readError) return { ok: false, reason: 'read_failed', message: readError.message };
    if (!data?.length) return { ok: false, reason: 'not_found' };
    const snapshot = data[0];

    const { error: deleteError } = await supabase.from(LEDGER_TABLES[kind]).delete().eq('id', entry.id);
    if (deleteError) return { ok: false, reason: 'delete_failed', message: deleteError.message };

    await writeAudit(supabase, {
      action: LEDGER_AUDIT_ACTIONS.DELETED,
      actorPhone,
      details: {
        kind,
        table: LEDGER_TABLES[kind],
        entry_id: entry.id,
        vehicle_id: entry.vehicle_id,
        snapshot,
        restore_until: new Date(Date.now() + ENTRY_RESTORE_WINDOW_MINUTES * 60 * 1000).toISOString()
      }
    });

    // Fresh insert: strip the old id, keep the original entry date, apply the patch.
    const fresh = { ...snapshot, ...write };
    delete fresh.id;
    fresh.created_at = snapshot.created_at || new Date().toISOString();
    const { data: inserted, error: insertError } = await supabase.from(LEDGER_TABLES[kind]).insert([fresh]).select().maybeSingle();
    if (insertError) return { ok: false, reason: 'relog_failed', message: insertError.message };
    if (!inserted) return { ok: false, reason: 'relog_failed', message: 'no row returned' };

    const consumed = await markDeletedEntryRelogged(supabase, {
      deletedEntryId: entry.id,
      reloggedEntryId: inserted.id,
      actorPhone
    });

    await writeAudit(supabase, {
      action: LEDGER_AUDIT_ACTIONS.UPDATED,
      actorPhone,
      details: {
        kind,
        table: LEDGER_TABLES[kind],
        entry_id: inserted.id,
        vehicle_id: inserted.vehicle_id,
        via: 'relog',
        old_entry_id: entry.id,
        before: { ...snapshot },
        after: clean,
        consumed_audit_id: consumed.ok ? consumed.auditId : null
      }
    });

    // v1.63.1 — a corrections re-log changes the ledger facts (actor's view).
    markUserDataChanged({ supabase, phone: actorPhone || null, reason: 'ledger.relog' });
    return { ok: true, entry: shapeRow(inserted, kind), patch: clean, rejected, relogged: true, oldId: entry.id };
  } catch (err) {
    return { ok: false, reason: 'relog_failed', message: err.message };
  }
}


/**
 * Hard delete + full-row snapshot in `admin_audit_logs`. The snapshot is what
 * `restoreLastDeleted()` replays inside the 30-minute window.
 */
export async function deleteLedgerEntry(supabase, { entry = null, actorPhone = null, vehicleIds = null } = {}) {
  if (!supabase || !entry) return { ok: false, reason: 'no_entry' };
  const entryScope = (vehicleIds || []).filter(Boolean);
  if (entryScope.length && !entryScope.includes(entry.vehicle_id)) return { ok: false, reason: 'not_yours' };
  const kind = entry.kind === 'earning' ? 'earning' : 'expense';
  const table = LEDGER_TABLES[kind];
  try {
    const { data, error } = await supabase.from(table).select('*').eq('id', entry.id).limit(1);
    if (error) return { ok: false, reason: 'read_failed', message: error.message };
    if (!data?.length) return { ok: false, reason: 'not_found' };
    const snapshot = data[0];
    const { error: deleteError } = await supabase.from(table).delete().eq('id', entry.id);
    if (deleteError) return { ok: false, reason: 'delete_failed', message: deleteError.message };

    const restoreUntil = new Date(Date.now() + ENTRY_RESTORE_WINDOW_MINUTES * 60 * 1000).toISOString();
    await writeAudit(supabase, {
      action: LEDGER_AUDIT_ACTIONS.DELETED,
      actorPhone,
      details: {
        kind,
        table,
        entry_id: entry.id,
        vehicle_id: entry.vehicle_id,
        snapshot,
        restore_until: restoreUntil
      }
    });
    // v1.63.1 — deleting an entry changes the month-spend/recent-log facts.
    markUserDataChanged({ supabase, phone: actorPhone || null, reason: 'ledger.delete' });
    return { ok: true, entry: shapeRow(snapshot, kind), restoreUntil };
  } catch (err) {
    return { ok: false, reason: 'delete_failed', message: err.message };
  }
}

/** Bring back the most recent deletion inside the window (or one specific id). */
export async function restoreLastDeleted(supabase, { key = null, actorPhone = null, vehicleIds = [] } = {}) {
  if (!supabase) return { ok: false, reason: 'no_client' };
  const cutoff = new Date(Date.now() - ENTRY_RESTORE_WINDOW_MINUTES * 60 * 1000).toISOString();
  let rows = [];
  try {
    const { data, error } = await supabase.from('admin_audit_logs')
      .select('id,action,details,created_at')
      .eq('action', LEDGER_AUDIT_ACTIONS.DELETED)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(25);
    if (error) return { ok: false, reason: 'read_failed', message: error.message };
    rows = data || [];
  } catch (err) {
    return { ok: false, reason: 'read_failed', message: err.message };
  }

  const scoped = (vehicleIds || []).filter(Boolean);
  const wantedId = key ? String(key).split(':')[1] : null;
  const match = rows.find((row) => {
    const details = row.details || {};
    const idOk = wantedId ? String(details.entry_id) === String(wantedId) : true;
    const scopeOk = scoped.length ? scoped.includes(details.vehicle_id) : true;
    // v1.37.0 (D1) — a DELETE whose row was superseded by a correction re-log
    // is consumed and can never be resurrected as a duplicate.
    return idOk && scopeOk && details.snapshot && !details.relogged_entry_id;
  });
  if (!match) return { ok: false, reason: 'nothing_to_restore' };

  const details = match.details;
  const kind = details.kind === 'earning' ? 'earning' : 'expense';
  const table = LEDGER_TABLES[kind];
  try {
    const { error } = await supabase.from(table).insert([details.snapshot]);
    if (error) {
      if (/duplicate|unique/i.test(error.message || '')) return { ok: false, reason: 'already_restored' };
      return { ok: false, reason: 'restore_failed', message: error.message };
    }
  } catch (err) {
    return { ok: false, reason: 'restore_failed', message: err.message };
  }

  await writeAudit(supabase, {
    action: LEDGER_AUDIT_ACTIONS.RESTORED,
    actorPhone,
    details: { kind, table, entry_id: details.entry_id, vehicle_id: details.vehicle_id, from_audit_id: match.id }
  });
  // v1.63.1 — a restored entry re-enters the ledger facts.
  markUserDataChanged({ supabase, phone: actorPhone || null, reason: 'ledger.restore' });
  return { ok: true, entry: shapeRow(details.snapshot, kind) };
}

