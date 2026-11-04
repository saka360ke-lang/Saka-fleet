import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

/**
 * Saka Fleet — phantom-trial remediation (v1.58.13).
 *
 * Clears `profiles.trial_ends_at` on accounts that are NOT genuinely on a trial:
 * a phantom date left by the legacy `now() + 90 days` column default. A real
 * trial requires a live `trial_sessions` row (status ACTIVE/EXTENDED) AND
 * `subscription_status = 'TRIALING'`; only those keep their trial end date.
 *
 * Safe by design: a paid/ACTIVE account only has its phantom `trial_ends_at`
 * NULLed (its tier/status are never touched); a phantom-TRIALING account drops
 * back to Free/ACTIVE with no trial date. Idempotent.
 *
 * Run (dry-run):  node scripts/remediate_phantom_trials.js
 * Run (apply):    node scripts/remediate_phantom_trials.js --confirm
 */
const DRY_RUN = !process.argv.includes('--confirm');

function isPhantomStatus(status) {
  return String(status || '').toUpperCase() !== 'TRIALING';
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id,phone_number,subscription_tier,subscription_status,trial_ends_at,trial_used_at,created_at')
    .not('trial_ends_at', 'is', null)
    .limit(2000);
  if (error) {
    console.error('Could not read profiles:', error.message);
    process.exit(1);
  }

  const summary = { scanned: profiles.length, realTrialsKept: 0, phantomFound: 0, cleared: 0, failed: 0 };
  const changes = [];

  for (const profile of profiles) {
    const status = String(profile.subscription_status || '').toUpperCase();
    const { data: rows } = await supabase
      .from('trial_sessions')
      .select('id')
      .eq('owner_id', profile.id)
      .in('status', ['ACTIVE', 'EXTENDED'])
      .limit(1);
    const hasRealTrial = (rows || []).length > 0;

    if (status === 'TRIALING' && hasRealTrial) {
      summary.realTrialsKept += 1;
      continue;
    }

    // Phantom: a trial date with no real trial row (or a non-TRIALING profile).
    summary.phantomFound += 1;
    const patch = { trial_ends_at: null };
    if (status === 'TRIALING') {
      patch.subscription_status = 'ACTIVE';
      if (String(profile.subscription_tier || '').toLowerCase() !== 'free') patch.subscription_tier = 'free';
    }
    changes.push({ phone: profile.phone_number, status, patch });

    if (!DRY_RUN) {
      const { error: updateError } = await supabase.from('profiles').update(patch).eq('id', profile.id);
      if (updateError) summary.failed += 1;
      else summary.cleared += 1;
    }
  }

  console.log(JSON.stringify({ dryRun: DRY_RUN, ...summary, changes: DRY_RUN ? changes : undefined }, null, 2));
}

main().catch((err) => {
  console.error('Remediation error:', err);
  process.exit(1);
});
