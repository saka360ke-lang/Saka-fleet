import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — Autonomous Remediation Pipeline migration (v1.10.0).
 *
 * Creates the two tables owned by the Sentinel ↔ Cline remediation pipeline:
 *   - public.sentinel_audit_runs      : one nightly audit artifact per Nairobi date.
 *   - public.remediation_proposals    : approval-gated work orders consumed by CI.
 *
 * Both tables are PRESERVED by scripts/reset-db.js (like weekly_feature_proposals):
 * they are the governance ledger for every autonomous code change.
 *
 * Idempotent: CREATE ... IF NOT EXISTS + ADD COLUMN IF NOT EXISTS throughout.
 * Run: npm run migrate:remediation
 */

export const REMEDIATION_MIGRATION_SQL = `
    CREATE TABLE IF NOT EXISTS public.sentinel_audit_runs (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        run_date date NOT NULL UNIQUE,
        window_start timestamp with time zone,
        window_end timestamp with time zone,
        error_count integer DEFAULT 0,
        friction_count integer DEFAULT 0,
        stall_count integer DEFAULT 0,
        summary jsonb,
        plan_dispatched_at timestamp with time zone,
        created_at timestamp with time zone DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.remediation_proposals (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        proposal_code text UNIQUE,
        audit_run_id uuid REFERENCES public.sentinel_audit_runs(id) ON DELETE SET NULL,
        title text,
        category text,
        root_cause text,
        evidence jsonb,
        proposed_changes jsonb,
        risk_level text DEFAULT 'low',
        status text DEFAULT 'PENDING_APPROVAL',
        feedback text,
        approval_nonce text,
        nonce_expires_at timestamp with time zone,
        attempts integer DEFAULT 0,
        dispatched_at timestamp with time zone,
        execution_dispatched_at timestamp with time zone,
        execution jsonb,
        created_at timestamp with time zone DEFAULT now(),
        reviewed_at timestamp with time zone,
        executed_at timestamp with time zone
    );

    -- Forward-compatible columns (no-ops on a fresh table).
    ALTER TABLE public.sentinel_audit_runs ADD COLUMN IF NOT EXISTS plan_dispatched_at timestamp with time zone;
    ALTER TABLE public.remediation_proposals ADD COLUMN IF NOT EXISTS attempts integer DEFAULT 0;
    ALTER TABLE public.remediation_proposals ADD COLUMN IF NOT EXISTS dispatched_at timestamp with time zone;
    ALTER TABLE public.remediation_proposals ADD COLUMN IF NOT EXISTS execution_dispatched_at timestamp with time zone;
    ALTER TABLE public.remediation_proposals ADD COLUMN IF NOT EXISTS execution jsonb;
    ALTER TABLE public.remediation_proposals ADD COLUMN IF NOT EXISTS feedback text;

    CREATE INDEX IF NOT EXISTS idx_sentinel_audit_runs_date ON public.sentinel_audit_runs(run_date DESC);
    CREATE INDEX IF NOT EXISTS idx_remediation_proposals_status ON public.remediation_proposals(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_remediation_proposals_audit ON public.remediation_proposals(audit_run_id);
`;

export async function applyRemediationMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }

  console.log(`Executing remediation pipeline migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(REMEDIATION_MIGRATION_SQL, { label: 'remediationMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Remediation pipeline migration applied (sentinel_audit_runs + remediation_proposals).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyRemediationMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
