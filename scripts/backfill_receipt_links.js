import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { matchReceiptForExpense, nairobiDateOf } from '../src/services/dashboard.js';

/**
 * Saka Fleet — receipt→expense link backfill (v1.81.0, Phase 20).
 * --------------------------------------------------------------
 * PROP-2026-11-08-01 adds the durable `expense_logs.receipt_id` link. Rows
 * written before the link existed are healed here with the SAME unique-match
 * heuristic the records table has always used:
 *
 *   same vehicle + same Africa/Nairobi calendar day + equal amount, and it must
 *   be UNIQUE. Two or more candidates are never guessed; zero is skipped.
 *
 * Guarantees:
 *  - DRY-RUN BY DEFAULT. Pass --apply to write (D4 of the Phase 20 plan).
 *  - 1:1 enforcement — a receipt already linked to another expense (or linked
 *    earlier in this run) is never reused, so no receipt ever fans out.
 *  - Idempotent — only rows with receipt_id IS NULL are read, and a second run
 *    finds nothing new.
 *  - Audited — one admin_audit_logs row `RECEIPT_LINK_BACKFILLED` per run.
 *
 * Run: npm run backfill:receipt-links                 (dry-run — inspect)
 *      npm run backfill:receipt-links -- --apply      (write)
 */

const CHUNK = 200;
const MAX_ROWS = 20000;
const USED_SCAN_LIMIT = 50000;

function argFlag(name) {
  return process.argv.slice(2).includes(name);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing');
    process.exit(1);
  }
  const apply = argFlag('--apply');
  const supabase = createClient(url, key);
  const summary = {
    mode: apply ? 'apply' : 'dry_run',
    scanned: 0, linked: 0, ambiguous: 0, none: 0, reused: 0, errors: 0, linkedIds: []
  };

  // The link column must exist before anything else — a pre-migration run is
  // told to migrate, never silently "0 rows" (rule 50 honesty).
  const probe = await supabase.from('expense_logs').select('receipt_id').limit(1);
  if (probe.error && /receipt_id|column|schema|does not exist/i.test(probe.error.message || '')) {
    console.error('expense_logs.receipt_id is missing — run `npm run migrate:receipt-links` first.');
    process.exit(2);
  }

  // Every receipt already linked to an expense is off-limits (1:1 enforcement).
  const usedReceiptIds = new Set();
  const linkedRows = await supabase
    .from('expense_logs')
    .select('receipt_id')
    .not('receipt_id', 'is', null)
    .limit(USED_SCAN_LIMIT);
  if (linkedRows.error) {
    console.error('Could not read existing receipt links:', linkedRows.error.message);
    process.exit(2);
  }
  for (const row of linkedRows.data || []) {
    if (row.receipt_id) usedReceiptIds.add(row.receipt_id);
  }
  summary.alreadyLinked = usedReceiptIds.size;

  const cache = new Map();
  // Snapshot the unlinked rows FIRST (paged reads), then write. Reading and
  // writing interleaved would make the `IS NULL` window shrink under the cursor
  // and could loop forever on unlinkable rows; a snapshot is bounded and honest.
  const unlinked = [];
  let offset = 0;
  for (;;) {
    const page = await supabase
      .from('expense_logs')
      .select('id, vehicle_id, amount, created_at')
      .is('receipt_id', null)
      .order('created_at', { ascending: true })
      .range(offset, offset + CHUNK - 1);
    if (page.error) {
      console.error('Could not read unlinked expenses:', page.error.message);
      summary.errors += 1;
      break;
    }
    const rows = page.data || [];
    for (const row of rows) {
      if (unlinked.length >= MAX_ROWS) break;
      unlinked.push(row);
    }
    if (rows.length < CHUNK || unlinked.length >= MAX_ROWS) break;
    offset += CHUNK;
  }
  summary.scanned = unlinked.length;

  for (const row of unlinked) {
    if (!row.vehicle_id || !row.amount || !row.created_at) { summary.none += 1; continue; }
    try {
      const match = await matchReceiptForExpense({
        supabase,
        vehicleId: row.vehicle_id,
        amount: row.amount,
        day: nairobiDateOf(row.created_at),
        cache
      });
      if (match.status === 'ambiguous') { summary.ambiguous += 1; continue; }
      if (match.status !== 'unique' || !match.receipt?.id) { summary.none += 1; continue; }
      if (usedReceiptIds.has(match.receipt.id)) { summary.reused += 1; continue; }
      usedReceiptIds.add(match.receipt.id);
      if (apply) {
        const upd = await supabase.from('expense_logs').update({ receipt_id: match.receipt.id }).eq('id', row.id);
        if (upd.error) {
          // A row that vanished mid-run is not an incident; a real error is counted.
          if (!/0 rows|no rows/i.test(upd.error.message || '')) summary.errors += 1;
          continue;
        }
        if (summary.linkedIds.length < 50) summary.linkedIds.push({ expense_id: row.id, receipt_id: match.receipt.id });
      }
      summary.linked += 1;
    } catch (err) {
      summary.errors += 1;
      if (summary.errors <= 5) console.warn('row ' + row.id + ' failed:', err.message);
    }
  }

  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'SENTINEL',
      action: 'RECEIPT_LINK_BACKFILLED',
      details: JSON.stringify(summary).slice(0, 2000),
      created_at: new Date().toISOString()
    }]);
  } catch { /* audit is best-effort */ }

  console.log('RECEIPT_LINK_BACKFILL ' + JSON.stringify(summary));
  if (!apply) console.log('Dry run — nothing written. Re-run with `-- --apply` to link these rows.');
}

main().then(() => process.exit(0)).catch((err) => { console.error('backfill failed: ' + err.message); process.exit(1); });
