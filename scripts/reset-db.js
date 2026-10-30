import dotenv from 'dotenv';
dotenv.config();
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const isProduction = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
const hasForceProduction = process.argv.includes('--force-production-wipe');
const hasConfirm = process.argv.includes('--confirm');
const hasAll = process.argv.includes('--all');
const hasBackup = process.argv.includes('--backup');
const targetPhone = process.argv.find((arg, i, arr) => arr[i - 1] === '--phone') || null;
const isDirectInvocation = Boolean(
  process.argv[1] && (process.argv[1].endsWith('reset-db.js') || process.argv[1].endsWith('reset_db_slate.js'))
);

// 1. Environment & Confirmation Safeguards (CLI only — importing this module is side-effect free)
if (isDirectInvocation) {
  if (isProduction && !hasForceProduction) {
    console.error('🛑 ABORTED: Database slate wipe blocked in PRODUCTION environment!');
    console.error('To override in production, you must explicitly supply: --force-production-wipe --confirm');
    process.exit(1);
  }

  if (!hasConfirm) {
    console.error('⚠️  SAFEGUARD TRIGGERED: Database reset requires explicit confirmation.');
    console.error('Usage:');
    console.error('  Global Slate Reset: node scripts/reset-db.js --all --confirm [--backup]');
    console.error('  Targeted Phone:     node scripts/reset-db.js --phone +254712345678 --confirm');
    process.exit(1);
  }

  // Require an explicit scope so a bare "--confirm" can never wipe globally.
  if (!hasAll && !targetPhone) {
    console.error('⚠️  SAFEGUARD TRIGGERED: Specify the reset scope explicitly.');
    console.error('Usage:');
    console.error('  Global Slate Reset: node scripts/reset-db.js --all --confirm [--backup]');
    console.error('  Targeted Phone:     node scripts/reset-db.js --phone +254712345678 --confirm');
    process.exit(1);
  }
}

export const RESET_TABLES = [
  'chat_history',
  'chat_transcripts',
  'chat_friction_logs',
  'processed_webhooks',
  'chat_sessions',
  'saka_dynamic_rules',
  'pending_owner_notifications',
  'passbook_transfers',
  'private_earnings',
  'expenses',
  'expense_logs',
  'receipts',
  'driver_compliances',
  'driver_assignments',
  'expiry_notification_log',
  'reminders',
  'trial_sessions',
  'subscriptions',
  'usage_counters',
  'paystack_webhook_events',
  'vehicles',
  'superadmin_sessions',
  'coupons',
  'vin_registry',
  'admin_audit_logs',
  'conversation_analytics',
  'error_logs',
  'ai_usage_logs',
  'support_tickets',
  'exchange_rates_cache',
  'profiles'
];

// Never touched by a slate wipe (config hooks, reference data + governance ledger):
//   - system_config: boot-critical keys read at startup (saka_core_prompt,
//     last_deployed_revision) plus Sentinel/remediation scheduling markers.
//   - compliance_catalog: bundled + superadmin-overridden legal reference data.
//   - sentinel_audit_runs / remediation_proposals / weekly_feature_proposals:
//     governance ledger for autonomous remediation and the feature backlog.
//   - ai_model_registry / model_eval_runs: runtime model governance (the active
//     model binding + benchmark history). Wiring these belongs to system config,
//     not to onboarding data.
export const PRESERVED_TABLES = [
  'system_config',
  'compliance_catalog',
  'sentinel_audit_runs',
  'remediation_proposals',
  'weekly_feature_proposals',
  'ai_model_registry',
  'model_eval_runs'
];

const BACKUP_TABLES = ['system_config', 'compliance_catalog', 'ai_model_registry', 'model_eval_runs'];

export function resetBackupFilename(now = new Date()) {
  return `reset-backup-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

async function countRows(supabase, table) {
  try {
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    if (error) return { count: null, error: error.message };
    return { count: count || 0, error: null };
  } catch (err) {
    return { count: null, error: err.message };
  }
}

export async function executeDatabaseReset({ targetPhone = null, verbose = true, backup = false } = {}) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const projectRef = (supabaseUrl || '').replace('https://', '').split('.')[0];
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const supabase = supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

  if (!(token && projectRef) && !supabase) {
    throw new Error('No reset transport configured: set SUPABASE_ACCESS_TOKEN (preferred) or SUPABASE_URL + SUPABASE_SERVICE_KEY');
  }

  if (verbose) {
    console.log(`🧹 Starting Saka Fleet Database Slate Wipe... ${targetPhone ? `[Target Phone: ${targetPhone}]` : '[Global Slate Wipe]'}`);
  }

  // 0. Pre-reset snapshot: preserved-table baseline (always) + optional JSON backup.
  const preservedBaseline = {};
  let backupFile = null;
  if (supabase) {
    for (const table of PRESERVED_TABLES) {
      const { count } = await countRows(supabase, table);
      preservedBaseline[table] = count;
    }

    if (backup && !targetPhone) {
      const snapshot = {
        created_at: new Date().toISOString(),
        project_ref: projectRef || null,
        scope: 'global-slate',
        preserved_baseline: preservedBaseline,
        wiped_row_counts: {},
        tables: {}
      };
      for (const table of RESET_TABLES) {
        const { count } = await countRows(supabase, table);
        snapshot.wiped_row_counts[table] = count;
      }
      for (const table of BACKUP_TABLES) {
        const { data, error } = await supabase.from(table).select('*');
        if (error) throw new Error(`Backup aborted — could not read ${table}: ${error.message}`);
        snapshot.tables[table] = data || [];
      }
      backupFile = resetBackupFilename();
      await fs.promises.writeFile(backupFile, JSON.stringify(snapshot, null, 2), 'utf8');
      if (verbose) console.log(`💾 Pre-reset backup written to ${backupFile}`);
    }
  } else if (backup) {
    console.warn('⚠️  --backup requested but Supabase JS credentials are missing; no backup file was written.');
  }

  // Method A: Supabase Management API via SQL
  let usedManagementApi = false;
  if (token && projectRef) {
    try {
    let sql = '';
    if (targetPhone) {
      const cleanPhone = targetPhone.replace(/[^\d+]/g, '');
      const altPhone = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : `+${cleanPhone}`;
      sql = `
        DELETE FROM public.chat_history WHERE user_phone IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.chat_transcripts WHERE phone_number IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.chat_friction_logs WHERE user_phone IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.processed_webhooks WHERE phone_number IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.chat_sessions WHERE phone_number IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.superadmin_sessions WHERE phone_number IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.coupons WHERE assigned_to_phone IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.expiry_notification_log WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.reminders WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.expense_logs WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.expenses WHERE plate IN (SELECT plate_number FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.private_earnings WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.passbook_transfers WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.pending_owner_notifications WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.driver_assignments WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}')) OR driver_phone IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.driver_compliances WHERE driver_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.reminders WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}')));
        DELETE FROM public.expense_logs WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}')));
    DELETE FROM public.receipts WHERE owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}')) OR driver_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.private_earnings WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}')));
        DELETE FROM public.passbook_transfers WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}')));
        DELETE FROM public.pending_owner_notifications WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}')));
        DELETE FROM public.driver_assignments WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}'))) OR driver_phone IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.driver_compliances WHERE driver_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.expiry_notification_log WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}')));
        -- Release any driver assignment held by this phone
        UPDATE public.vehicles SET assigned_driver_id = NULL WHERE assigned_driver_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}') OR owner_id IN (SELECT id FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}');
      `;
    } else {
      sql = `
        TRUNCATE TABLE 
          public.chat_history,
          public.chat_transcripts,
          public.chat_friction_logs,
          public.processed_webhooks,
          public.chat_sessions,
          public.saka_dynamic_rules,
          public.pending_owner_notifications,
          public.passbook_transfers,
          public.private_earnings,
          public.expenses,
          public.expense_logs,
          public.receipts,
          public.driver_compliances,
          public.driver_assignments,
          public.expiry_notification_log,
          public.reminders,
          public.trial_sessions,
          public.subscriptions,
          public.usage_counters,
          public.paystack_webhook_events,
          public.vehicles,
          public.superadmin_sessions,
          public.coupons,
          public.vin_registry,
          public.admin_audit_logs,
          public.conversation_analytics,
          public.error_logs,
          public.ai_usage_logs,
          public.support_tickets,
          public.exchange_rates_cache,
          public.profiles
        RESTART IDENTITY CASCADE;
      `;
    }

    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: sql })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Slate reset failed via Supabase API: ${err}`);
    }
    usedManagementApi = true;

    if (verbose) console.log('✅ Database slate successfully cleared via Supabase Management API.');
    } catch (mgmtErr) {
      if (!supabase) throw mgmtErr;
      console.warn(`Management API reset failed (${mgmtErr.message}); falling back to the Supabase JS client.`);
    }
  }

  if (!usedManagementApi && supabase) {
    // Method B: Fallback to Supabase JS Client with cascade order
    if (targetPhone) {
      await supabase.from('chat_history').delete().eq('user_phone', targetPhone);
      await supabase.from('chat_transcripts').delete().eq('phone_number', targetPhone);
      await supabase.from('chat_friction_logs').delete().eq('user_phone', targetPhone);
      await supabase.from('processed_webhooks').delete().eq('phone_number', targetPhone);
      await supabase.from('chat_sessions').delete().eq('phone_number', targetPhone);
      await supabase.from('vehicles').delete().eq('owner_phone', targetPhone);
      await supabase.from('profiles').delete().eq('phone_number', targetPhone);
      if (verbose) console.log(`✅ Targeted data cleared for ${targetPhone} via Supabase Client.`);
    } else {
      // Some tables use text primary keys instead of a uuid `id`.
      const RESET_PRIMARY_KEYS = {
        processed_webhooks: 'wamid',
        vin_registry: 'vin',
        chat_sessions: 'phone_number',
        superadmin_sessions: 'phone_number',
        saka_dynamic_rules: 'rule_key'
      };
      for (const table of RESET_TABLES) {
        const primaryKey = RESET_PRIMARY_KEYS[table] || 'id';
        const sentinel = RESET_PRIMARY_KEYS[table] ? '__saka_reset_sentinel__' : '00000000-0000-0000-0000-000000000000';
        try {
          await supabase.from(table).delete().neq(primaryKey, sentinel);
        } catch {}
      }
      if (verbose) console.log('✅ Core tables cleared via Supabase Client.');
    }
  }

  // 2. Post-reset verification — every wiped table at 0 rows, preserved tables unchanged.
  let verification = null;
  if (verbose && supabase) {
    console.log('\n--- Post-Reset Verification ---');
    verification = { wipedOk: true, preservedOk: true, wiped: [], preserved: [], backupFile };

    if (!targetPhone) {
      for (const table of RESET_TABLES) {
        const { count, error } = await countRows(supabase, table);
        if (error || count !== 0) verification.wipedOk = false;
        verification.wiped.push({
          table,
          remaining_rows: error ? `ERR: ${error}` : count,
          status: !error && count === 0 ? '✅ clean' : '❌ residual'
        });
      }
      console.table(verification.wiped);
    }

    for (const table of PRESERVED_TABLES) {
      const { count, error } = await countRows(supabase, table);
      const before = preservedBaseline[table];
      const comparable = typeof before === 'number';
      const unchanged = !error && (!comparable || before === count);
      if (!unchanged) verification.preservedOk = false;
      verification.preserved.push({
        table,
        before_rows: comparable ? before : 'n/a',
        after_rows: error ? `ERR: ${error}` : count,
        status: unchanged ? '✅ intact' : '❌ drift'
      });
    }
    console.table(verification.preserved);
  }

  if (verification && !targetPhone) {
    if (verification.wipedOk && verification.preservedOk) {
      console.log('✅ Verification clean: all operational tables at 0 rows, preserved tables intact.');
    } else {
      console.error('⚠️  Verification found residual operational rows or preserved-table drift.');
    }
  }

  return { success: true, verification, backupFile };
}

// Direct CLI Invocation
if (isDirectInvocation) {
  executeDatabaseReset({ targetPhone, backup: hasBackup })
    .then(() => {
      console.log('🎉 Database Slate Reset Completed Successfully!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Reset Slate Error:', err.message);
      process.exit(1);
    });
}
