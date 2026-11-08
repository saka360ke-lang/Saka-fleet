/**
 * Saka Fleet — one-off ghost profile purge (v1.82.0, Phase 21).
 * -------------------------------------------------------------
 * A WhatsApp first-contact auto-provisioned a shell profile for
 * +254734852529 (no email, no name, never verified). The operator's wipe was
 * never completed, so the row kept counting in `admin profiles`. This script
 * removes the shell and every row that still references it, then verifies the
 * purge and writes ONE audit row (`GHOST_PROFILE_PURGED`).
 *
 * Usage:
 *   node scripts/purge_ghost_profile.js            # dry run (counts only)
 *   node scripts/purge_ghost_profile.js --apply    # purge + verify + audit
 *
 * Rules: 10 (cleanup verified), 43 (wipe machinery untouched — this is the CLI
 * equivalent for a shell row with no email), 50 (never throws), 63 (audit).
 */

import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import { phoneVariants } from '../src/services/webOnboarding.js';

const GHOST_PHONE = '+254734852529';
const GHOST_PROFILE_ID = 'a9f9f690-9cd2-48c6-a274-ca645c63d78b';
const APPLY = process.argv.includes('--apply');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY missing in .env');
  process.exit(1);
}

const supabase = createClient(url, key);
const variants = phoneVariants(GHOST_PHONE);
if (!variants.length) {
  console.error('❌ Could not derive phone variants for', GHOST_PHONE);
  process.exit(1);
}

async function countWhere(table, build) {
  try {
    const { count, error } = await build(
      supabase.from(table).select('*', { count: 'exact', head: true })
    );
    if (error) return { n: -1, error: error.message };
    return { n: count || 0, error: null };
  } catch (err) {
    return { n: -1, error: err.message };
  }
}

async function analyticsRowsMentioning(fragment) {
  const { data, error } = await supabase
    .from('conversation_analytics')
    .select('id, insights')
    .limit(1000);
  if (error) return { rows: [], ids: [], error: error.message };
  const rows = (data || []).filter((row) => JSON.stringify(row.insights || {}).includes(fragment));
  return { rows, ids: rows.map((row) => row.id), error: null };
}

async function beforeCounts() {
  const analytics = await analyticsRowsMentioning('852529');
  return {
    profiles_by_id: (await countWhere('profiles', (q) => q.eq('id', GHOST_PROFILE_ID))).n,
    profiles_by_phone: (await countWhere('profiles', (q) => q.in('phone_number', variants))).n,
    chat_history: (await countWhere('chat_history', (q) => q.in('user_phone', variants))).n,
    chat_transcripts: (await countWhere('chat_transcripts', (q) => q.in('phone_number', variants))).n,
    processed_webhooks: (await countWhere('processed_webhooks', (q) => q.in('phone_number', variants))).n,
    chat_sessions: (await countWhere('chat_sessions', (q) => q.in('phone_number', variants))).n,
    user_context_cache: (await countWhere('user_context_cache', (q) => q.in('phone_number', variants))).n,
    web_onboard_otps: (await countWhere('web_onboard_otps', (q) => q.in('phone', variants))).n,
    dashboard_sessions: (await countWhere('dashboard_sessions', (q) => q.eq('owner_id', GHOST_PROFILE_ID))).n,
    usage_counters: (await countWhere('usage_counters', (q) => q.eq('owner_id', GHOST_PROFILE_ID))).n,
    conversation_analytics: analytics.ids.length
  };
}

async function main() {
  console.log(`\n🐾 Ghost profile purge — ${GHOST_PHONE} (${GHOST_PROFILE_ID})`);
  console.log('   variants:', JSON.stringify(variants));
  console.log('   mode:', APPLY ? 'APPLY' : 'DRY RUN (pass --apply to delete)');

  const before = await beforeCounts();
  console.log('\n── BEFORE ─────────────────────────────────');
  console.table(before);

  if (!APPLY) {
    console.log('\nDry run complete — no rows were deleted.');
    return;
  }

  const errors = [];
  const removed = {};

  async function remove(table, build) {
    try {
      const { error, count } = await build(
        supabase.from(table).delete({ count: 'exact' })
      );
      if (error) { errors.push(`${table}: ${error.message}`); return; }
      removed[table] = (removed[table] || 0) + Number(count || 0);
    } catch (err) {
      errors.push(`${table}: ${err.message}`);
    }
  }

  // conversation_analytics is a Sentinel synthesis history — deleting a row
  // would destroy unrelated analytics, so the NUMBER is redacted in place
  // (purge the reference, keep the record).
  const analytics = await analyticsRowsMentioning('852529');
  let redacted = 0;
  for (const row of analytics.rows) {
    try {
      const sanitized = JSON.parse(
        JSON.stringify(row.insights || {})
          .split('+254734852529').join('[purged]')
          .split('254734852529').join('[purged]')
          .split('734852529').join('[purged]')
      );
      const { error } = await supabase
        .from('conversation_analytics')
        .update({ insights: sanitized })
        .eq('id', row.id);
      if (error) errors.push(`conversation_analytics ${row.id}: ${error.message}`);
      else redacted += 1;
    } catch (err) {
      errors.push(`conversation_analytics ${row.id}: ${err.message}`);
    }
  }
  removed.conversation_analytics_redacted = redacted;
  await remove('chat_history', (q) => q.in('user_phone', variants));
  await remove('chat_transcripts', (q) => q.in('phone_number', variants));
  await remove('processed_webhooks', (q) => q.in('phone_number', variants));
  await remove('chat_sessions', (q) => q.in('phone_number', variants));
  await remove('user_context_cache', (q) => q.in('phone_number', variants));
  await remove('web_onboard_otps', (q) => q.in('phone', variants));
  await remove('dashboard_sessions', (q) => q.eq('owner_id', GHOST_PROFILE_ID));
  await remove('usage_counters', (q) => q.eq('owner_id', GHOST_PROFILE_ID));
  // The profile LAST — every row above keys off it.
  await remove('profiles', (q) => q.eq('id', GHOST_PROFILE_ID).in('phone_number', variants));

  console.log('\n── DELETED ────────────────────────────────');
  console.table(removed);
  if (errors.length) {
    console.log('\n⚠️  Delete errors:');
    errors.forEach((e) => console.log('  •', e));
  }

  const after = await beforeCounts();
  console.log('\n── AFTER ──────────────────────────────────');
  console.table(after);

  const residue = Object.entries(after).filter(([, n]) => n > 0);
  const verified = residue.length === 0 && errors.length === 0;

  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'CLINE',
      action: 'GHOST_PROFILE_PURGED',
      details: {
        phone: GHOST_PHONE,
        profileId: GHOST_PROFILE_ID,
        before,
        removed,
        after,
        verified,
        errors
      }
    }]);
  } catch (err) {
    console.log('⚠️  Audit write failed:', err.message);
  }

  console.log(verified
    ? '\n✅ PURGE VERIFIED — every checked table is at 0 rows.'
    : `\n❌ PURGE INCOMPLETE — residue: ${JSON.stringify(residue)}`);
  if (!verified) process.exitCode = 1;
}

main();

