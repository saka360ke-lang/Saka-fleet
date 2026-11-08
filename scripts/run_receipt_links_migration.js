import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — durable receipt -> expense link migration (v1.81.0, Phase 20).
 * ---------------------------------------------------------------------------
 * PROP-2026-11-08-01: `expense_logs.receipt_id` is the durable link between an
 * OCR receipt and the expense the confirmation quiz wrote from it. Before this
 * column the dashboard could only GUESS (same vehicle + same Nairobi day + same
 * amount, unique-only) — a heuristic that survives as a legacy fallback for rows
 * written before the backfill, never as the primary link.
 *
 * ON DELETE SET NULL is mandatory: users may remove a receipt at any time
 * (`delete receipt N`, rule 48), and that must never orphan or block the ledger
 * row. Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
 *
 * Run: npm run migrate:receipt-links
 */

export const RECEIPT_LINK_SQL = `
    ALTER TABLE public.expense_logs
        ADD COLUMN IF NOT EXISTS receipt_id uuid REFERENCES public.receipts(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_expense_logs_receipt ON public.expense_logs(receipt_id);
`;

export async function applyReceiptLinkMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing receipt-link migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(RECEIPT_LINK_SQL, { label: 'receiptLinkMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK receipt-link migration applied (expense_logs.receipt_id + index).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyReceiptLinkMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
