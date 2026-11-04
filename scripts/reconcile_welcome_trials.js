import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

/**
 * Saka Fleet - welcome-trial reconciliation (v1.58.20)
 * ----------------------------------------------------
 * Heals OWNER accounts that own at least one ACTIVE vehicle but never received
 * their one-per-lifetime welcome trial (the live profiles table was missing
 * `currency`/`locale`, so every startWelcomeTrial call returned
 * "profile not found" and was silently swallowed).
 *
 * Safety:
 *  - only profiles with trial_used_at = null and NO trial_sessions row;
 *  - only owners of at least one ACTIVE vehicle (drivers are never touched);
 *  - idempotent (a second run starts nothing new);
 *  - every run is audited as TRIAL_RECONCILED.
 *
 * Run: npm run reconcile:welcome-trials
 */
import { startWelcomeTrial } from '../src/services/trialEngine.js';

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing'); process.exit(1); }
  const supabase = createClient(url, key);
  const summary = { scanned: 0, started: 0, skipped: 0, errors: 0, details: [] };

  const vehicles = await supabase.from('vehicles').select('owner_id').eq('status', 'ACTIVE').limit(1000);
  const ownerIds = [...new Set((vehicles.data || []).map((v) => v.owner_id).filter(Boolean))];
  summary.scanned = ownerIds.length;

  for (const ownerId of ownerIds) {
    try {
      const profile = await supabase.from('profiles').select('id, phone_number, trial_used_at').eq('id', ownerId).maybeSingle();
      if (!profile.data || profile.data.trial_used_at) { summary.skipped += 1; continue; }
      const existing = await supabase.from('trial_sessions').select('id').eq('owner_id', ownerId).limit(1);
      if ((existing.data || []).length) { summary.skipped += 1; continue; }
      const res = await startWelcomeTrial({ supabase, ownerId });
      if (res.started) {
        summary.started += 1;
        summary.details.push((profile.data.phone_number || ownerId) + ' -> ' + res.tierKey);
      } else {
        summary.errors += 1;
        summary.details.push((profile.data.phone_number || ownerId) + ' !! ' + (res.reason || 'unknown'));
      }
    } catch (err) {
      summary.errors += 1;
      summary.details.push(ownerId + ' !! ' + err.message);
    }
  }

  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'SENTINEL',
      action: 'TRIAL_RECONCILED',
      details: JSON.stringify(summary).slice(0, 2000),
      created_at: new Date().toISOString()
    }]);
  } catch { /* audit is best-effort */ }

  console.log('RECONCILE ' + JSON.stringify(summary));
}

main().then(() => process.exit(0)).catch((e) => { console.error('reconcile failed: ' + e.message); process.exit(1); });
