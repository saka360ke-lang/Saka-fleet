/**
 * Saka Fleet — earnings archive scope (v1.92.0, Phase 29).
 * ------------------------------------------------------
 * A completed passbook transfer archives the seller's `private_earnings` rows
 * (`archived_at` + `archived_by_transfer_id`) so the BUYER never inherits the
 * seller's private financial history (the seller keeps it under
 * `/d/records?history=1`). Every owner/driver-facing earnings read therefore
 * asks for LIVE rows only — one shared guard, so a reader can never forget.
 *
 * Rule 50: on a database where the archive migration has not run yet, the
 * `archived_at` filter is dropped instead of pretending the owner has no
 * earnings. A missing column is a schema state, never an empty ledger.
 */

export const EARNINGS_ARCHIVE_COLUMN = 'archived_at';

/** True when a query error names the (un-migrated) archive column. */
export function isArchiveColumnError(error) {
  const text = String(error?.message || error?.details || error || '');
  return /archived_at|archived_by_transfer_id/i.test(text)
    || /column .* does not exist/i.test(text)
    || /could not find the 'archived_at' column/i.test(text);
}

/**
 * Run ONE `private_earnings` read scoped to LIVE earnings.
 *
 * `apply(builder)` adds the caller's own filters/order/range and MUST be pure
 * (it is re-run once on the degrade path). Returns the Supabase `{ data, error }`
 * result unchanged, so every existing caller keeps its own error handling.
 */
export async function selectLiveEarnings(supabase, {
  columns = '*',
  selectOptions = null,
  apply = null
} = {}) {
  if (!supabase) return { data: null, error: new Error('Database unavailable.') };
  const run = (withArchiveFilter) => {
    let query = selectOptions
      ? supabase.from('private_earnings').select(columns, selectOptions)
      : supabase.from('private_earnings').select(columns);
    if (withArchiveFilter) query = query.is(EARNINGS_ARCHIVE_COLUMN, null);
    if (apply) query = apply(query);
    return query;
  };
  const first = await run(true);
  if (first?.error && isArchiveColumnError(first.error)) {
    console.warn('[earningsScope] archived_at column missing — reading unfiltered (rule 50).');
    return run(false);
  }
  return first;
}

export default {
  EARNINGS_ARCHIVE_COLUMN,
  isArchiveColumnError,
  selectLiveEarnings
};
