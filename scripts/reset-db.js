import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

const isProduction = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
const hasForceProduction = process.argv.includes('--force-production-wipe');
const hasConfirm = process.argv.includes('--confirm');
const targetPhone = process.argv.find((arg, i, arr) => arr[i - 1] === '--phone') || null;

// 1. Environment & Confirmation Safeguards
if (isProduction && !hasForceProduction) {
  console.error('🛑 ABORTED: Database slate wipe blocked in PRODUCTION environment!');
  console.error('To override in production, you must explicitly supply: --force-production-wipe --confirm');
  process.exit(1);
}

if (!hasConfirm) {
  console.error('⚠️  SAFEGUARD TRIGGERED: Database reset requires explicit confirmation.');
  console.error('Usage:');
  console.error('  Global Slate Reset: node scripts/reset-db.js --all --confirm');
  console.error('  Targeted Phone:     node scripts/reset-db.js --phone +254712345678 --confirm');
  process.exit(1);
}

export const RESET_TABLES = [
  'chat_history',
  'chat_transcripts',
  'chat_friction_logs',
  'processed_webhooks',
  'pending_owner_notifications',
  'passbook_transfers',
  'private_earnings',
  'expenses',
  'expense_logs',
  'reminders',
  'vehicles',
  'superadmin_sessions',
  'coupons',
  'vin_registry',
  'admin_audit_logs',
  'conversation_analytics',
  'error_logs',
  'profiles'
];

export async function executeDatabaseReset({ targetPhone = null, verbose = true } = {}) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const projectRef = (supabaseUrl || '').replace('https://', '').split('.')[0];
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (verbose) {
    console.log(`🧹 Starting Saka Fleet Database Slate Wipe... ${targetPhone ? `[Target Phone: ${targetPhone}]` : '[Global Slate Wipe]'}`);
  }

  // Method A: Supabase Management API via SQL
  if (token && projectRef) {
    let sql = '';
    if (targetPhone) {
      const cleanPhone = targetPhone.replace(/[^\d+]/g, '');
      const altPhone = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : `+${cleanPhone}`;
      sql = `
        DELETE FROM public.chat_history WHERE user_phone IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.chat_transcripts WHERE phone_number IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.chat_friction_logs WHERE user_phone IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.processed_webhooks WHERE phone_number IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.superadmin_sessions WHERE phone_number IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.coupons WHERE assigned_to_phone IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.reminders WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.expense_logs WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.expenses WHERE plate IN (SELECT plate_number FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.private_earnings WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.passbook_transfers WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.pending_owner_notifications WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}'));
        DELETE FROM public.vehicles WHERE owner_phone IN ('${cleanPhone}', '${altPhone}');
        DELETE FROM public.profiles WHERE phone_number IN ('${cleanPhone}', '${altPhone}');
      `;
    } else {
      sql = `
        TRUNCATE TABLE 
          public.chat_history,
          public.chat_transcripts,
          public.chat_friction_logs,
          public.processed_webhooks,
          public.pending_owner_notifications,
          public.passbook_transfers,
          public.private_earnings,
          public.expenses,
          public.expense_logs,
          public.reminders,
          public.vehicles,
          public.superadmin_sessions,
          public.coupons,
          public.vin_registry,
          public.admin_audit_logs,
          public.conversation_analytics,
          public.error_logs,
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

    if (verbose) console.log('✅ Database slate successfully cleared via Supabase Management API.');
  } else if (supabaseUrl && supabaseKey) {
    // Method B: Fallback to Supabase JS Client with cascade order
    const supabase = createClient(supabaseUrl, supabaseKey);
    if (targetPhone) {
      await supabase.from('chat_history').delete().eq('user_phone', targetPhone);
      await supabase.from('chat_transcripts').delete().eq('phone_number', targetPhone);
      await supabase.from('chat_friction_logs').delete().eq('user_phone', targetPhone);
      await supabase.from('processed_webhooks').delete().eq('phone_number', targetPhone);
      await supabase.from('vehicles').delete().eq('owner_phone', targetPhone);
      await supabase.from('profiles').delete().eq('phone_number', targetPhone);
      if (verbose) console.log(`✅ Targeted data cleared for ${targetPhone} via Supabase Client.`);
    } else {
      for (const table of RESET_TABLES) {
        try {
          await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
        } catch {}
      }
      if (verbose) console.log('✅ Core tables cleared via Supabase Client.');
    }
  }

  // Row Count Verification
  if (verbose && supabaseUrl && supabaseKey) {
    const supabase = createClient(supabaseUrl, supabaseKey);
    console.log('\n--- Post-Reset Verification ---');
    const verificationTables = ['vehicles', 'profiles', 'vin_registry', 'chat_history', 'chat_transcripts', 'processed_webhooks'];
    const summary = [];
    for (const t of verificationTables) {
      const { count } = await supabase.from(t).select('*', { count: 'exact', head: true });
      summary.push({ table: t, remaining_rows: count || 0 });
    }
    console.table(summary);
  }

  return { success: true };
}

// Direct CLI Invocation
if (process.argv[1] && (process.argv[1].endsWith('reset-db.js') || process.argv[1].endsWith('reset_db_slate.js'))) {
  executeDatabaseReset({ targetPhone })
    .then(() => {
      console.log('🎉 Database Slate Reset Completed Successfully!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Reset Slate Error:', err.message);
      process.exit(1);
    });
}
