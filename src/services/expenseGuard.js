/**
 * Saka Fleet — Expense duplicate guard (v1.32.1)
 * ----------------------------------------------
 * A receipt can be photographed or forwarded more than once (WhatsApp issues a
 * new media id per send), and the confirmation quiz runs again each time. This
 * guard is the FINAL write-time check: the same expense — same plate, same
 * amount, same type, same Africa/Nairobi calendar day — is never written twice.
 *
 * Rules:
 *  - Canonical storage is Africa/Nairobi (rule 7); day comparison uses that zone.
 *  - Never throws: a guard failure must not block a legitimate log.
 *  - Same amount on a DIFFERENT day stays legal (daily fills are normal).
 */

export const EXPENSE_DEDUPE_TIMEZONE = 'Africa/Nairobi';

/** YYYY-MM-DD in the canonical Africa/Nairobi zone. */
export function nairobiDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: EXPENSE_DEDUPE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function normalizeType(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Pure comparator (unit-tested): is `candidate` the SAME expense as `existing`?
 * A different odometer reading is proof of a separate fill → never a duplicate.
 */
export function isSameExpenseCandidate(existing = {}, candidate = {}) {
  const existingAmount = Number(existing.amount);
  const candidateAmount = Number(candidate.amount);
  if (!Number.isFinite(existingAmount) || !Number.isFinite(candidateAmount)) return false;
  if (Math.abs(existingAmount - candidateAmount) > 0.01) return false;
  if (normalizeType(existing.expense_type) !== normalizeType(candidate.expenseType)) return false;
  if (candidate.plate && existing.plate && String(existing.plate) !== String(candidate.plate)) return false;
  const existingOdo = Number(existing.odometer_reading);
  const candidateOdo = Number(candidate.odometer);
  if (Number.isFinite(existingOdo) && existingOdo > 0 && Number.isFinite(candidateOdo) && candidateOdo > 0) {
    if (Math.abs(existingOdo - candidateOdo) > 0.5) return false;
  }
  const existingDay = nairobiDateKey(existing.created_at);
  const candidateDay = candidate.dateKey || nairobiDateKey(candidate.date || new Date());
  if (!existingDay || !candidateDay) return false;
  return existingDay === candidateDay;
}

/**
 * v1.72.0 — legacy `expenses` mirror kill switch (P2-3).
 * Default ON keeps today's dual-write behaviour; `false` stops the mirror so
 * `expenses` can become a read-only archival table (flip scheduled v1.73.0).
 */
export function legacyExpensesWriteEnabled() {
  const raw = String(process.env.LEGACY_EXPENSES_WRITE_ENABLED ?? 'true').trim().toLowerCase();
  return !['false', 'off', '0', 'no'].includes(raw);
}

/** Resolve the canonical vehicle id (callers hold it; plate is a fallback). */
async function resolveGuardVehicleId(providedSupabase, { vehicleId = null, plate = null } = {}) {
  if (vehicleId) return vehicleId;
  if (!plate) return null;
  try {
    const { data } = await providedSupabase
      .from('vehicles')
      .select('id, plate_number')
      .ilike('plate_number', String(plate))
      .limit(1);
    return data?.[0]?.id || null;
  } catch {
    return null;
  }
}

/**
 * Query recent expenses for the same vehicle and decide whether this write is a
 * duplicate. Returns `{ duplicate, existing }`; on any failure `duplicate:false`.
 * Window is short (3 h) on purpose: two genuine identical fills on the same day
 * are normally hours apart, while a re-uploaded receipt lands within minutes.
 *
 * v1.72.0 (P2-3) — reads the canonical `expense_logs` ledger by `vehicle_id`
 * (never the legacy `expenses` mirror). Both callers pass the vehicle they
 * already hold; a plate-only lookup resolves the vehicle as a fallback.
 */
export async function isDuplicateExpense(providedSupabase, {
  plate = null,
  vehicleId = null,
  amount = null,
  expenseType = null,
  odometer = null,
  windowHours = 3
} = {}) {
  if (!providedSupabase) return { duplicate: false, existing: null };
  if (!vehicleId && !plate) return { duplicate: false, existing: null };
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) return { duplicate: false, existing: null };
  const hours = Number.isFinite(Number(windowHours)) ? Math.max(1, Math.min(168, Number(windowHours))) : 3;
  try {
    const resolvedVehicleId = await resolveGuardVehicleId(providedSupabase, { vehicleId, plate });
    if (!resolvedVehicleId) return { duplicate: false, existing: null };
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await providedSupabase
      .from('expense_logs')
      .select('vehicle_id, amount, expense_type, odometer_reading, created_at')
      .eq('vehicle_id', resolvedVehicleId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(25);
    if (error) return { duplicate: false, existing: null };
    const existing = (data || []).find((row) => isSameExpenseCandidate(row, {
      amount: numericAmount,
      expenseType,
      odometer,
      plate
    }));
    return { duplicate: Boolean(existing), existing: existing || null };
  } catch {
    return { duplicate: false, existing: null };
  }
}

export default { isDuplicateExpense, isSameExpenseCandidate, nairobiDateKey, legacyExpensesWriteEnabled };
