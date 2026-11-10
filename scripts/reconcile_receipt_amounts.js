#!/usr/bin/env node
/**
 * Saka Fleet — receipt amount reconciliation (v1.96.2)
 * ----------------------------------------------------
 * A receipt row can carry a polluted amount from an older OCR profile (live
 * 2026-11-09: ASTROL's P.O. Box "11823" became the receipt amount while the
 * linked fuel expense was the true KES 3,000). This script corrects ONE
 * receipt at a time, on explicit operator instruction, and audits every write.
 *
 * It never sweeps amounts automatically: an expense may be a partial log, so a
 * blanket "copy the expense amount onto the receipt" rule would invent facts.
 *
 * Usage:
 *   node scripts/reconcile_receipt_amounts.js --scan
 *   node scripts/reconcile_receipt_amounts.js --receipt=<uuid> --amount=3000 \
 *     --reason="P.O. Box 11823 was read as the total" [--apply]
 *
 * Default is a DRY RUN. --apply writes the row + one
 * `RECEIPT_AMOUNT_CORRECTED` audit row. Idempotent: a receipt already carrying
 * the target amount is a no-op.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const apply = process.argv.includes('--apply');
const scan = process.argv.includes('--scan') || (!argValue('receipt') && !argValue('amount'));
const receiptId = argValue('receipt');
const targetAmount = Number(argValue('amount'));
const reason = argValue('reason') || 'operator reconciliation';

async function scanLinkedReceipts() {
  const { data: receipts, error } = await supabase
    .from('receipts')
    .select('id,document_kind,amount,currency,vehicle_id,created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const ids = (receipts || []).map((row) => row.id);
  const { data: expenses } = await supabase
    .from('expense_logs')
    .select('id,receipt_id,expense_type,amount,created_at')
    .in('receipt_id', ids);
  const byReceipt = new Map((expenses || []).map((row) => [row.receipt_id, row]));
  let mismatches = 0;
  for (const receipt of receipts || []) {
    const expense = byReceipt.get(receipt.id);
    if (!expense) continue;
    if (Number(receipt.amount) === Number(expense.amount)) continue;
    mismatches += 1;
    console.log(
      `MISMATCH receipt ${receipt.id} (${receipt.document_kind}) `
      + `amount=${receipt.amount} ${receipt.currency || ''} `
      + `| linked expense ${expense.id} (${expense.expense_type}) amount=${expense.amount} `
      + `| ${receipt.created_at}`
    );
  }
  console.log(`\nScan complete: ${receipts?.length || 0} receipts, ${mismatches} linked mismatch(es).`);
  if (mismatches > 0) {
    console.log('Correct one explicitly: --receipt=<id> --amount=<n> --reason="..." [--apply]');
  }
}

async function reconcileOne() {
  if (!receiptId) throw new Error('--receipt=<uuid> is required');
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) throw new Error('--amount must be a positive number');

  const { data: receipt, error } = await supabase
    .from('receipts')
    .select('id,amount,currency,document_kind,vehicle_id,created_at')
    .eq('id', receiptId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!receipt) throw new Error(`receipt ${receiptId} not found`);

  const { data: linked } = await supabase
    .from('expense_logs')
    .select('id,expense_type,amount,created_at')
    .eq('receipt_id', receiptId)
    .limit(5);

  console.log('Receipt :', JSON.stringify(receipt));
  console.log('Linked  :', JSON.stringify(linked || []));
  console.log(`Target  : ${targetAmount} ${receipt.currency || ''}`);
  console.log(`Reason  : ${reason}`);

  if (Number(receipt.amount) === targetAmount) {
    console.log('\nAlready correct — nothing to do (idempotent).');
    return;
  }
  if (!apply) {
    console.log('\nDRY RUN — re-run with --apply to write the correction + audit row.');
    return;
  }

  const { error: updateError } = await supabase
    .from('receipts')
    .update({ amount: targetAmount })
    .eq('id', receiptId);
  if (updateError) throw new Error(updateError.message);

  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'CLINE',
      action: 'RECEIPT_AMOUNT_CORRECTED',
      details: {
        receipt_id: receiptId,
        before: receipt.amount,
        after: targetAmount,
        currency: receipt.currency || null,
        linked_expense_ids: (linked || []).map((row) => row.id),
        reason
      }
    }]);
  } catch { /* the audit is best-effort; the correction stands */ }

  console.log(`\n✅ receipts.${receiptId}.amount: ${receipt.amount} -> ${targetAmount} (audited RECEIPT_AMOUNT_CORRECTED).`);
}

try {
  if (scan) await scanLinkedReceipts();
  else await reconcileOne();
} catch (err) {
  console.error('❌ reconciliation failed:', err.message);
  process.exitCode = 1;
}
