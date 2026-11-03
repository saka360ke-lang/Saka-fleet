import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

/**
 * Saka Fleet - trial reconciliation (v1.57.1).
 * Accounts born subscription_status TRIALING + a future trial_ends_at but with
 * no real trial_sessions row were silently on Free capacity ("Capacity Limit
 * Reached"). Create a real welcome trial on solo_pro ending at the existing
 * trial_ends_at (or +30 days). Idempotent. Run: node scripts/reconcile_trials.js
 */

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY missing"); process.exit(1); }
  const supabase = createClient(url, key);
  const now = new Date();
  const nowIso = now.toISOString();
  const DAY = 24 * 60 * 60 * 1000;

  const { data: profiles, error } = await supabase.from("profiles")
    .select("id,phone_number,subscription_status,trial_used_at,trial_ends_at,created_at")
    .eq("subscription_status", "TRIALING")
    .is("trial_used_at", null)
    .limit(500);
  if (error) { console.error("profiles query failed: " + error.message); process.exit(1); }

  const summary = { scanned: (profiles || []).length, started: 0, skipped: 0, errors: 0 };
  for (const p of profiles || []) {
    try {
      const existing = await supabase.from("trial_sessions").select("id").eq("owner_id", p.id).in("status", ["ACTIVE", "EXTENDED"]).limit(1);
      if ((existing.data || []).length) { summary.skipped += 1; continue; }
      const endsMs = p.trial_ends_at ? new Date(p.trial_ends_at).getTime() : 0;
      const endsAt = endsMs > now.getTime() ? new Date(endsMs) : new Date(now.getTime() + 30 * DAY);
      const startedAt = p.created_at ? new Date(p.created_at) : now;
      const record = {
        owner_id: p.id, tier: (process.env.WELCOME_TRIAL_TIER || "growth"), interval: "monthly", status: "ACTIVE",
        started_at: startedAt.toISOString(), ends_at: endsAt.toISOString(),
        activated: false, activation_events: [], source: "welcome"
      };
      const ins = await supabase.from("trial_sessions").insert([record]).select().single();
      if (ins.error) { summary.errors += 1; console.warn("insert failed for " + p.phone_number + ": " + ins.error.message); continue; }
      const upd = await supabase.from("profiles").update({ subscription_tier: (process.env.WELCOME_TRIAL_TIER || "growth"), trial_used_at: startedAt.toISOString(), updated_at: nowIso }).eq("id", p.id);
      if (upd.error) { summary.errors += 1; console.warn("profile update failed for " + p.phone_number + ": " + upd.error.message); continue; }
      summary.started += 1;
    } catch (e) { summary.errors += 1; console.warn("reconcile error: " + e.message); }
  }

  try { await supabase.from("admin_audit_logs").insert([{ admin_phone: "SENTINEL", action: "TRIAL_RECONCILED", details: summary }]); } catch { }

  console.log("RECONCILE " + JSON.stringify(summary));
}

main().then(() => process.exit(0)).catch((e) => { console.error("reconcile failed: " + e.message); process.exit(1); });