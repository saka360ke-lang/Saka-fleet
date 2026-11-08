/**
 * Saka Fleet — CSV bulk import (v1.81.0, Phase 20)
 * -----------------------------------------------
 * The owner's dashboard can upload a CSV of historical expenses
 * (`Date, Vehicle Plate, Type, Amount, Odometer, Notes`) and the engine does the
 * rest: a dependency-free RFC-4180-lite parser, per-row validation against the
 * SAME sources the chat uses (expenseCatalog for types, dateParser for dates,
 * the owner's live vehicles for plates), a preview, then one bulk insert.
 *
 * Laws honoured here:
 *  - Rule 7: dates resolve through `dateParser.parseFlexibleDate` (country-aware)
 *    and store as Nairobi-normalised ISO; units stay canonical.
 *  - Rule 26 (v1.77.0): an expense NEVER activates a trial. This module imports
 *    no activation API at all (pinned by a source assertion in the suite).
 *  - Rule 50: every read/write degrades — a failed dedupe read fails open (the
 *    import proceeds), a refused insert reports exactly how many rows landed.
 *  - The after-write hook (Phase 2) fires ONCE per import.
 *
 * No new dependency: the parser is hand-rolled and pure.
 */

import { parseFlexibleDate, getNairobiParts } from './dateParser.js';
import { resolveExpenseType, isHoursLedKind } from './expenseCatalog.js';
import { isSameExpenseCandidate, legacyExpensesWriteEnabled } from './expenseGuard.js';
import { markUserDataChanged } from './afterWrite.js';
import { logWriteFailure } from './systemErrors.js';

export const CSV_IMPORT_MAX_ROWS = Math.max(1, Math.min(2000, Number(process.env.CSV_IMPORT_MAX_ROWS || 500)));
export const CSV_IMPORT_MAX_BYTES = Math.max(1000, Number(process.env.CSV_IMPORT_MAX_BYTES || 1024 * 1024));
export const CSV_IMPORT_MAX_AMOUNT = 100000000;
export const CSV_IMPORT_MAX_ODOMETER = 9999999;
export const CSV_IMPORT_MAX_NOTES = 500;
export const CSV_IMPORT_DEDUPE_HOURS = Math.max(1, Number(process.env.OCR_EXPENSE_DEDUPE_HOURS || 3));
export const CSV_IMPORT_CHUNK = 200;

export const CSV_IMPORT_COLUMNS = Object.freeze({
  date: ['date', 'logged date', 'logged_date', 'entry date', 'entry_date'],
  plate: ['vehicle plate', 'plate', 'plate number', 'plate_number', 'vehicle_plate', 'vehicle'],
  type: ['type', 'expense type', 'expense_type', 'category'],
  amount: ['amount', 'cost', 'total'],
  odometer: ['odometer', 'odometer reading', 'odometer_reading', 'mileage', 'km', 'reading'],
  notes: ['notes', 'note', 'description', 'details']
});

export const CSV_IMPORT_REQUIRED = Object.freeze(['date', 'plate', 'type', 'amount']);

/** Warm, plain-language copy for every validation code (rule 31). */
export const CSV_IMPORT_ERROR_COPY = Object.freeze({
  missing_plate: 'Add the vehicle plate.',
  unknown_plate: 'That plate is not in your fleet.',
  unknown_type: 'Unknown expense type.',
  bad_amount: 'Amount must be a positive number.',
  bad_odometer: 'Odometer must be a whole number.',
  bad_date: 'Date could not be read.',
  future_date: 'Date is in the future.',
  notes_too_long: `Notes are longer than ${CSV_IMPORT_MAX_NOTES} characters.`,
  duplicate_row: 'Repeats an earlier row in this file.',
  duplicate_existing: 'Already saved in the last few hours.'
});

/* ============================================================
 * 1. Parser — RFC-4180-lite, dependency-free, pure
 * ============================================================ */

/** Split CSV text into records, honouring quotes (embedded commas/newlines). */
function splitCsvRecords(text) {
  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { fields.push(field); field = ''; };
  const pushRecord = () => { pushField(); records.push(fields); fields = []; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { pushField(); continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i += 1; pushRecord(); continue; }
    if (ch === '\n') { pushRecord(); continue; }
    field += ch;
  }
  if (inQuotes) return { ok: false, reason: 'unterminated_quote' };
  if (field.length > 0 || fields.length > 0) pushRecord();
  return { ok: true, records };
}

/**
 * Parse a CSV file into raw import rows.
 * @returns {{ok:boolean, reason?:string, error?:string, rows?:Array, header?:string[]}}
 */
export function parseCsv(text, { maxRows = CSV_IMPORT_MAX_ROWS, maxBytes = CSV_IMPORT_MAX_BYTES } = {}) {
  const raw = String(text ?? '');
  if (!raw.replace(/^\uFEFF/, '').trim()) {
    return { ok: false, reason: 'empty', error: 'The file is empty — nothing to import.' };
  }
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return { ok: false, reason: 'too_large', error: `The file is larger than ${Math.round(maxBytes / 1024)} KB. Split it into smaller files.` };
  }
  const split = splitCsvRecords(raw.replace(/^\uFEFF/, ''));
  if (!split.ok) {
    return { ok: false, reason: split.reason, error: 'A quoted value is not closed — check the file and try again.' };
  }
  const records = split.records.filter((fields) => fields.some((value) => String(value ?? '').trim() !== ''));
  if (!records.length) {
    return { ok: false, reason: 'empty', error: 'The file has no rows — nothing to import.' };
  }
  const header = records[0].map((value) => String(value || '').trim().toLowerCase());
  const columnIndex = {};
  for (const [key, aliases] of Object.entries(CSV_IMPORT_COLUMNS)) {
    columnIndex[key] = header.findIndex((name) => aliases.includes(name));
  }
  const missing = CSV_IMPORT_REQUIRED.filter((key) => columnIndex[key] < 0);
  if (missing.length) {
    return {
      ok: false,
      reason: 'missing_columns',
      error: `The header needs these columns: ${CSV_IMPORT_REQUIRED.map((key) => (key === 'plate' ? 'Vehicle Plate' : key[0].toUpperCase() + key.slice(1))).join(', ')}.`
    };
  }
  if (records.length - 1 > maxRows) {
    return { ok: false, reason: 'too_many_rows', error: `That is ${records.length - 1} rows — the limit is ${maxRows} per import.` };
  }
  const rows = records.slice(1).map((fields, index) => {
    const pick = (key) => (columnIndex[key] >= 0 ? String(fields[columnIndex[key]] ?? '').trim() : '');
    return {
      line: index + 2, // header is line 1
      date: pick('date'),
      plate: pick('plate'),
      type: pick('type'),
      amount: pick('amount'),
      odometer: pick('odometer'),
      notes: pick('notes')
    };
  });
  return { ok: true, rows, header };
}

/* ============================================================
 * 2. Field parsers
 * ============================================================ */

/** Plates compare on their alphanumeric core (KDA 123A == kda-123a). */
export function normalizeImportPlate(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Positive money with thousands separators; two decimal places max. */
export function parseImportAmount(value) {
  const clean = String(value ?? '').replace(/[,\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) return null;
  const amount = Number(clean);
  if (!Number.isFinite(amount) || amount <= 0 || amount > CSV_IMPORT_MAX_AMOUNT) return null;
  return Math.round(amount * 100) / 100;
}

/** Optional whole-number reading; empty means "not given". */
export function parseImportOdometer(value) {
  const clean = String(value ?? '').replace(/[,\s]/g, '');
  if (!clean) return null;
  if (!/^\d+$/.test(clean)) return null;
  const reading = Number(clean);
  if (!Number.isFinite(reading) || reading <= 0 || reading > CSV_IMPORT_MAX_ODOMETER) return null;
  return reading;
}

/** Control characters stripped, whitespace collapsed, 500-char ceiling. */
export function sanitizeImportNotes(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > CSV_IMPORT_MAX_NOTES) {
    return { ok: false, value: text.slice(0, CSV_IMPORT_MAX_NOTES) };
  }
  return { ok: true, value: text || null };
}

/* ============================================================
 * 3. Validation (pure, in-memory — never N queries)
 * ============================================================ */

/**
 * Validate parsed rows against the owner's fleet and the shared catalogs.
 * `recentExpenses` is ONE pre-fetched slice (loadRecentExpensesForImport) used
 * for the 3-hour duplicate guard — never one query per row.
 */
export function validateImportRows({
  rows = [],
  vehicles = [],
  countryCode = 'GLOBAL',
  recentExpenses = [],
  now = new Date()
} = {}) {
  const plateMap = new Map();
  for (const vehicle of vehicles || []) {
    const key = normalizeImportPlate(vehicle?.plate_number);
    if (key && !plateMap.has(key)) plateMap.set(key, vehicle);
  }
  const parts = getNairobiParts(now);
  const todayKey = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const seenKeys = new Set();
  const recent = (recentExpenses || []).filter((row) => row && row.vehicle_id);
  const valid = [];
  const invalid = [];

  for (const row of rows || []) {
    const errors = [];
    const plateNorm = normalizeImportPlate(row.plate);
    const vehicle = plateNorm ? plateMap.get(plateNorm) || null : null;
    if (!plateNorm) errors.push('missing_plate');
    else if (!vehicle) errors.push('unknown_plate');

    const expenseType = resolveExpenseType(row.type);
    if (!expenseType) errors.push('unknown_type');

    const amount = parseImportAmount(row.amount);
    if (!amount) errors.push('bad_amount');

    const hasOdometer = String(row.odometer ?? '').trim() !== '';
    const odometer = parseImportOdometer(row.odometer);
    if (hasOdometer && odometer === null) errors.push('bad_odometer');

    const parsedDate = parseFlexibleDate(row.date, { countryCode, now });
    if (!parsedDate.ok) errors.push('bad_date');
    else if (parsedDate.localDate > todayKey) errors.push('future_date');

    const notes = sanitizeImportNotes(row.notes);
    if (!notes.ok) errors.push('notes_too_long');

    const dateKey = parsedDate.ok ? parsedDate.localDate : null;
    if (vehicle && expenseType && amount && dateKey && !errors.includes('future_date')) {
      const key = `${vehicle.id}|${expenseType}|${amount}|${dateKey}`;
      if (seenKeys.has(key)) {
        errors.push('duplicate_row');
      } else {
        seenKeys.add(key);
        const existing = recent.find((entry) => entry.vehicle_id === vehicle.id && isSameExpenseCandidate(entry, {
          amount,
          expenseType,
          odometer,
          dateKey
        }));
        if (existing) errors.push('duplicate_existing');
      }
    }

    const entry = {
      line: row.line,
      plate: vehicle?.plate_number || String(row.plate || '').trim() || '—',
      vehicleId: vehicle?.id || null,
      expenseType,
      amount,
      odometer,
      notes: notes.value,
      dateKey,
      createdAt: parsedDate.ok ? new Date(parsedDate.iso).toISOString() : null,
      errors
    };
    if (errors.length) invalid.push(entry);
    else valid.push(entry);
  }

  return {
    ok: true,
    valid,
    invalid,
    counts: { total: (rows || []).length, valid: valid.length, invalid: invalid.length }
  };
}

/** One ordered list for the preview table (valid + invalid, file order). */
export function summarizeImport(validation = {}) {
  const rows = [...(validation.valid || []), ...(validation.invalid || [])]
    .sort((a, b) => (a.line || 0) - (b.line || 0));
  return {
    counts: validation.counts || { total: 0, valid: 0, invalid: 0 },
    rows
  };
}

/* ============================================================
 * 4. Database side — ONE dedupe read + chunked writes
 * ============================================================ */

/**
 * ONE bulk read of the last `windowHours` of expenses for the given vehicles.
 * Rule 50: a failed read fails OPEN (empty slice) — the import proceeds.
 */
export async function loadRecentExpensesForImport(supabase, { vehicleIds = [], windowHours = CSV_IMPORT_DEDUPE_HOURS, now = new Date() } = {}) {
  const ids = (vehicleIds || []).filter(Boolean);
  if (!supabase || !ids.length) return { ok: true, rows: [] };
  try {
    const hours = Math.max(1, Math.min(168, Number(windowHours) || CSV_IMPORT_DEDUPE_HOURS));
    const cutoff = new Date(new Date(now).getTime() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('expense_logs')
      .select('vehicle_id, amount, expense_type, odometer_reading, created_at')
      .in('vehicle_id', ids)
      .gte('created_at', cutoff)
      .limit(2000);
    if (error) {
      logWriteFailure(supabase, 'csvImport.loadRecentExpenses', error);
      return { ok: true, rows: [] };
    }
    return { ok: true, rows: data || [] };
  } catch (err) {
    logWriteFailure(supabase, 'csvImport.loadRecentExpenses', err);
    return { ok: true, rows: [] };
  }
}

/**
 * Insert validated rows in chunks of 200. Writes the canonical expense_logs row
 * shape (driver_id = the acting owner profile, no AI, no receipts), mirrors the
 * legacy `expenses` table behind its kill switch, advances each vehicle's
 * odometer to the highest imported reading, fires the after-write hook ONCE and
 * audits the import. Rule 26: no activation API is imported or called.
 */
export async function bulkInsertImportRows({
  supabase,
  ownerId = null,
  validRows = [],
  vehicles = [],
  now = new Date()
} = {}) {
  if (!supabase || !ownerId) return { ok: false, inserted: 0, error: 'Import context is missing — nothing was saved.' };
  const rows = (validRows || []).filter((row) => row.vehicleId && row.expenseType && Number(row.amount) > 0);
  if (!rows.length) return { ok: true, inserted: 0 };

  // v1.85.0 (Phase 24) — an hours-led asset imports ENGINE HOURS: the reading
  // rides the entry notes (canonical, no DDL) and the odometer stays null.
  const hoursLedIds = new Set((vehicles || [])
    .filter((vehicle) => isHoursLedKind(vehicle.asset_kind || vehicle.asset_type || 'vehicle'))
    .map((vehicle) => String(vehicle.id)));
  const isHoursLedRow = (row) => hoursLedIds.has(String(row.vehicleId));

  const payload = rows.map((row) => {
    const hoursLed = isHoursLedRow(row);
    const baseNotes = row.notes || null;
    return {
      vehicle_id: row.vehicleId,
      driver_id: ownerId,
      expense_type: row.expenseType,
      amount: row.amount,
      fuel_liters: 0,
      fill_type: null,
      odometer_reading: hoursLed ? null : (row.odometer ?? null),
      notes: hoursLed && row.odometer
        ? [`Engine hours: ${row.odometer} h`, baseNotes].filter(Boolean).join(' · ')
        : baseNotes,
      ...(row.createdAt ? { created_at: row.createdAt } : {})
    };
  });

  let inserted = 0;
  for (let index = 0; index < payload.length; index += CSV_IMPORT_CHUNK) {
    const chunk = payload.slice(index, index + CSV_IMPORT_CHUNK);
    const { error } = await supabase.from('expense_logs').insert(chunk);
    if (error) {
      logWriteFailure(supabase, 'csvImport.bulkInsert', error, { owner_id: ownerId, chunk_start: index, rows: chunk.length });
      return {
        ok: false,
        inserted,
        error: inserted > 0
          ? `Saved ${inserted} rows, then the database refused the next batch — nothing after it was written. Please retry the remaining rows.`
          : 'The database refused the import — nothing was saved.'
      };
    }
    inserted += chunk.length;
  }

  // Legacy mirror parity with quizEngine.logExpense (kill switch honoured).
  if (legacyExpensesWriteEnabled()) {
    const legacy = rows.map((row) => ({
      plate: row.plate,
      expense_type: row.expenseType,
      amount: row.amount,
      liters: 0,
      odometer_reading: isHoursLedRow(row) ? null : (row.odometer ?? null),
      ...(row.createdAt ? { created_at: row.createdAt } : {})
    }));
    try {
      for (let index = 0; index < legacy.length; index += CSV_IMPORT_CHUNK) {
        await supabase.from('expenses').insert(legacy.slice(index, index + CSV_IMPORT_CHUNK));
      }
    } catch (mirrorErr) {
      // The mirror is archival only (P2-3) — but a failure is still worth knowing.
      logWriteFailure(supabase, 'csvImport.legacyMirror', mirrorErr, { owner_id: ownerId });
    }
  }

  // Advance each vehicle to the highest imported reading (never backwards).
  const highest = new Map();
  for (const row of rows) {
    if (!row.odometer) continue;
    highest.set(row.vehicleId, Math.max(highest.get(row.vehicleId) || 0, row.odometer));
  }
  for (const [vehicleId, reading] of highest) {
    const vehicle = (vehicles || []).find((entry) => entry.id === vehicleId) || null;
    if (!vehicle) continue;
    // Hours-led assets advance their ENGINE HOURS meter, never the odometer.
    if (isHoursLedRow({ vehicleId })) {
      if (reading <= Number(vehicle.operating_hours || vehicle.current_engine_hours || 0)) continue;
      try {
        await supabase.from('vehicles').update({
          operating_hours: reading,
          hours_updated_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString()
        }).eq('id', vehicleId);
      } catch (hoursErr) {
        logWriteFailure(supabase, 'csvImport.hours', hoursErr, { vehicle_id: vehicleId });
      }
      continue;
    }
    if (reading <= Number(vehicle.current_mileage || 0)) continue;
    try {
      await supabase.from('vehicles').update({
        current_mileage: reading,
        odometer_reading: reading,
        updated_at: new Date(now).toISOString()
      }).eq('id', vehicleId);
    } catch (odoErr) {
      // Mileage is best-effort; the ledger row is the record — but log the miss.
      logWriteFailure(supabase, 'csvImport.mileage', odoErr, { vehicle_id: vehicleId });
    }
  }

  // Phase 2 after-write contract — ONE invalidation for the whole import.
  markUserDataChanged({ supabase, ownerId, reason: 'dashboard.csvImport' });

  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'DASHBOARD',
      action: 'CSV_IMPORT',
      details: JSON.stringify({ owner_id: ownerId, rows: rows.length, inserted }).slice(0, 2000),
      created_at: new Date(now).toISOString()
    }]);
  } catch (auditErr) {
    // Audit is best-effort, but the failure itself belongs in error_logs.
    logWriteFailure(supabase, 'csvImport.audit', auditErr, { owner_id: ownerId });
  }

  return { ok: true, inserted };
}

export default {
  CSV_IMPORT_MAX_ROWS,
  CSV_IMPORT_MAX_BYTES,
  CSV_IMPORT_MAX_AMOUNT,
  CSV_IMPORT_MAX_NOTES,
  CSV_IMPORT_DEDUPE_HOURS,
  CSV_IMPORT_COLUMNS,
  CSV_IMPORT_REQUIRED,
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
};
