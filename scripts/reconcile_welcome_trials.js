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

  const vehicles = await supabase.from('vehicles').select('owner_id, created_at').eq('status', 'ACTIVE').limit(1000);
  const firstAssetAt = new Map();
  for (const row of vehicles.data || []) {
    if (!row.owner_id) continue;
    const prev = firstAssetAt.get(row.owner_id);
    if (!prev || (row.created_at && row.created_at < prev)) firstAssetAt.set(row.owner_id, row.created_at || prev || null);
  }
  const ownerIds = [...firstAssetAt.keys()];
  summary.scanned = ownerIds.length;

  for (const ownerId of ownerIds) {
    try {
      const profile = await supabase.from('profiles').select('id, phone_number, trial_used_at').eq('id', ownerId).maybeSingle();
      if (!profile.data || profile.data.trial_used_at) { summary.skipped += 1; continue; }
      const existing = await supabase.from('trial_sessions').select('id').eq('owner_id', ownerId).limit(1);
      if ((existing.data || []).length) { summary.skipped += 1; continue; }
      const res = await startWelcomeTrial({ supabase, ownerId, startedAt: firstAssetAt.get(ownerId) || null });
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

  // v1.58.21 - RE-ANCHOR existing welcome trials to the first asset date: a
  // trial that started later (heal/reconcile day) moves back to the day its
  // passbook was issued. Only earlier anchors apply; never a dead window.
  const trialDays = Math.max(7, Math.min(90, Number(process.env.TRIAL_DAYS || 30)));
  const activeTrials = await supabase.from('trial_sessions').select('id, owner_id, started_at, ends_at, status').eq('status', 'ACTIVE').limit(1000);
  let reanchored = 0;
  for (const trial of activeTrials.data || []) {
    const anchorIso = firstAssetAt.get(trial.owner_id);
    if (!anchorIso) continue;
    const anchorMs = new Date(anchorIso).getTime();
    const startedMs = new Date(trial.started_at || 0).getTime();
    if (!Number.isFinite(anchorMs) || !Number.isFinite(startedMs) || anchorMs >= startedMs) continue;
    const endsMs = anchorMs + trialDays * 24 * 60 * 60 * 1000;
    if (endsMs <= Date.now()) continue; // never move into an already-dead window
    const upd = await supabase.from('trial_sessions').update({
      started_at: new Date(anchorMs).toISOString(),
      ends_at: new Date(endsMs).toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', trial.id);
    if (upd.error) { summary.errors += 1; continue; }
    try { await supabase.from('profiles').update({ trial_used_at: new Date(anchorMs).toISOString() }).eq('id', trial.owner_id); } catch { /* best effort */ }
    reanchored += 1;
  }
  summary.reanchored = reanchored;

  console.log('RECONCILE ' + JSON.stringify(summary));
}

main().then(() => process.exit(0)).catch((e) => { console.error('reconcile failed: ' + e.message); process.exit(1); });
