/**
 * Saka Fleet — Record Query (v1.36.0, database)
 * -----------------------------------------------------------------
 * Reads the user's own ledger rows for a parsed records question. Nairobi
 * calendar-day boundaries are converted to UTC range ends; totals/counts/
 * averages are computed here (never in the model). Never throws.
 */

const NAIROBI_OFFSET = '+03:00';

function nairobiDayStart(localDate) {
  return `${localDate}T00:00:00${NAIROBI_OFFSET}`;
}

function nairobiNextDayStart(localDate) {
  const day = new Date(`${localDate}T00:00:00${NAIROBI_OFFSET}`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString();
}

function roundMoney(value) {
  const num = Number(value || 0);
  return Math.round(num * 100) / 100;
}

/**
 * Query the ledger for a parsed record question.
 * @returns {{ ok: boolean, rows: object[], count: number, total: number,
 *   liters: number, average: number, amountCol: string, error?: string }}
 */
export async function queryRecordLedger(supabase, { ownerId = null, driverId = null, vehicleIds = [], question = {} } = {}) {
  if (!supabase) return { ok: false, rows: [], count: 0, total: 0, liters: 0, average: 0, error: 'no_client' };
  const ids = (vehicleIds || []).filter(Boolean);
  if (ids.length === 0) return { ok: true, rows: [], count: 0, total: 0, liters: 0, average: 0 };

  const earning = Boolean(question?.earning);
  const table = earning ? 'private_earnings' : 'expense_logs';
  const amountCol = earning ? 'revenue_amount' : 'amount';
  const selectCols = earning
    ? 'id,revenue_amount,earning_type,notes,created_at,vehicle_id'
    : 'id,expense_type,amount,fuel_liters,fill_type,odometer_reading,notes,created_at,vehicle_id';

  try {
    let query = supabase.from(table).select(selectCols);
    if (ownerId) query = query.eq('driver_id', ownerId);
    if (driverId) query = query.eq('driver_id', driverId);
    if (ids.length === 1) query = query.eq('vehicle_id', ids[0]);
    else query = query.in('vehicle_id', ids);
    if (question.range?.from) query = query.gte('created_at', nairobiDayStart(question.range.from));
    if (question.range?.to) query = query.lt('created_at', nairobiNextDayStart(question.range.to));
    query = query.order('created_at', { ascending: false }).limit(100);

    const { data, error } = await query;
    if (error) return { ok: false, rows: [], count: 0, total: 0, liters: 0, average: 0, error: error.message };

    const types = question.expenseTypes || [];
    const rows = (data || []).filter((row) => (
      earning || types.length === 0 || (row.expense_type && types.includes(row.expense_type))
    ));
    const total = roundMoney(rows.reduce((sum, row) => sum + Number(row[amountCol] || 0), 0));
    const liters = roundMoney(rows.reduce((sum, row) => sum + Number(row.fuel_liters || 0), 0));
    const count = rows.length;
    return {
      ok: true,
      rows,
      count,
      total,
      liters,
      average: count ? roundMoney(total / count) : 0,
      amountCol,
      error: null
    };
  } catch (err) {
    return { ok: false, rows: [], count: 0, total: 0, liters: 0, average: 0, error: err.message };
  }
}

export default { queryRecordLedger };
