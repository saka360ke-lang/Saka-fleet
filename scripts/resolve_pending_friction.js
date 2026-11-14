#!/usr/bin/env node
/**
 * Saka Fleet — operator friction sweep (Path A, 2026-11-14)
 * --------------------------------------------------------
 * Closes every PENDING chat_friction_logs row with an honest resolution and
 * resolves the error_logs linked to each row (the same contract as
 * `admin friction done <id>`), then writes ONE OPERATOR_FRICTION_SWEEP audit
 * row. Idempotent: a second run finds nothing and writes nothing.
 *
 * Usage:
 *   node scripts/resolve_pending_friction.js --dry-run
 *   node scripts/resolve_pending_friction.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { markFrictionDeployed } from '../src/services/frictionTracker.js';

const DRY_RUN = process.argv.includes('--dry-run');
const SUPERADMIN_PHONE = String(process.env.SUPERADMIN_PHONE || '+254720641985').replace(/\D/g, '');

const TEST_RESOLUTION = 'test-self-flag: admin tpl test-fire loop (template probe), no product defect';
const PRODUCT_RESOLUTION = 'Resolved by v1.97.8 vehicle-gone FK guard + v1.96.7 plate escape; stalled user nudged via saka_reengage';

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(-12);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing');
  const supabase = createClient(url, key);

  const { data: rows, error } = await supabase
    .from('chat_friction_logs')
    .select('id,friction_type,user_phone,detected_at,error_log_ids,status')
    .eq('status', 'PENDING')
    .order('detected_at', { ascending: true });
  if (error) throw new Error(`PENDING read failed: ${error.message}`);

  const pending = rows || [];
  console.log(`PENDING friction rows: ${pending.length}`);
  if (pending.length === 0) {
    console.log('✅ Queue already empty — nothing to do.');
    return;
  }

  const plan = pending.map((row) => ({
    id: row.id,
    type: row.friction_type,
    phone: row.user_phone,
    detected_at: row.detected_at,
    errorLogIds: Array.isArray(row.error_log_ids) ? row.error_log_ids.length : 0,
    kind: normalizePhone(row.user_phone) === SUPERADMIN_PHONE ? 'test_self_flag' : 'product_fix',
    resolution: normalizePhone(row.user_phone) === SUPERADMIN_PHONE ? TEST_RESOLUTION : PRODUCT_RESOLUTION
  }));

  for (const item of plan) {
    console.log(`- ${item.id.slice(0, 8)} · ${item.type} · ${item.phone} · ${item.kind} · linked errors ${item.errorLogIds}`);
  }
  if (DRY_RUN) {
    console.log('\n--- dry run: no rows were changed ---');
    return;
  }

  const results = [];
  for (const item of plan) {
    const res = await markFrictionDeployed(supabase, item.id, item.resolution);
    results.push({ id: item.id, kind: item.kind, ok: res.ok, clearedErrors: res.clearedErrors || 0, reason: res.reason || null });
    console.log(res.ok
      ? `✅ ${item.id.slice(0, 8)} deployed (cleared ${res.clearedErrors || 0} linked error log(s))`
      : `❌ ${item.id.slice(0, 8)} failed: ${res.reason}`);
  }

  const counts = {
    pending_found: plan.length,
    test_self_flags: plan.filter((p) => p.kind === 'test_self_flag').length,
    product_fixes: plan.filter((p) => p.kind === 'product_fix').length,
    deployed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    cleared_error_logs: results.reduce((sum, r) => sum + (r.clearedErrors || 0), 0)
  };

  const { error: auditError } = await supabase.from('admin_audit_logs').insert([{
    admin_phone: 'operator',
    action: 'OPERATOR_FRICTION_SWEEP',
    details: { ...counts, rows: results }
  }]);
  if (auditError) console.warn('[friction-sweep] audit write failed:', auditError.message);

  console.log(`\nSummary: ${counts.deployed}/${counts.pending_found} deployed · ${counts.test_self_flags} test self-flag(s) · ${counts.product_fixes} product fix(es) · ${counts.cleared_error_logs} linked error log(s) resolved`);
  if (counts.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('❌ Friction sweep failed:', err?.message || err);
  process.exit(1);
});
