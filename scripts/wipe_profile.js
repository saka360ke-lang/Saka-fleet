import 'dotenv/config';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { wipeProfileForSignup } from '../src/services/profileWipe.js';

/**
 * Saka Fleet — ops CLI for the OTP-gated profile wipe (v1.58.8).
 * Always writes a JSON backup to tmp/ first. Never wipes without --confirm.
 *   node --env-file=.env scripts/wipe_profile.js 0734852529            # dry run + backup
 *   node --env-file=.env scripts/wipe_profile.js 0734852529 --confirm  # backup + wipe
 */
const phone = process.argv[2];
const confirm = process.argv.includes('--confirm');
if (!phone) { console.error('Usage: node --env-file=.env scripts/wipe_profile.js <phone> [--confirm]'); process.exit(1); }

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const digits = phone.replace(/[^0-9]/g, '');
const tail = digits.slice(-9);

const backup = { phone, created_at: new Date().toISOString(), profiles: [], vehicles: [], expense_logs: [], private_earnings: [], chat_transcripts: [] };
try {
  const p = await supabase.from('profiles').select('*').ilike('phone_number', `%${tail}%`);
  backup.profiles = p.data || [];
  const ids = backup.profiles.map((r) => r.id);
  const orParts = [`owner_phone.ilike.%${tail}%`];
  if (ids.length) orParts.unshift(`owner_id.in.(${ids.join(',')})`);
  const v = await supabase.from('vehicles').select('*').or(orParts.join(','));
  backup.vehicles = v.data || [];
  const vids = backup.vehicles.map((x) => x.id);
  if (vids.length) {
    const e = await supabase.from('expense_logs').select('*').in('vehicle_id', vids);
    backup.expense_logs = e.data || [];
    const pe = await supabase.from('private_earnings').select('*').in('vehicle_id', vids);
    backup.private_earnings = pe.data || [];
  }
  const ct = await supabase.from('chat_transcripts').select('*').ilike('phone_number', `%${tail}%`);
  backup.chat_transcripts = ct.data || [];
} catch (err) {
  console.error('Backup read failed:', err.message);
}

if (!fs.existsSync('tmp')) fs.mkdirSync('tmp');
const file = `tmp/wipe-backup-${tail}-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify(backup, null, 2));
console.log(`Backup: ${file}`);
console.log(`Found — profiles: ${backup.profiles.length}, vehicles: ${backup.vehicles.length}, expense_logs: ${backup.expense_logs.length}, earnings: ${backup.private_earnings.length}, transcripts: ${backup.chat_transcripts.length}`);

if (!confirm) {
  console.log('Dry run only. Re-run with --confirm to wipe.');
  process.exit(0);
}

const result = await wipeProfileForSignup(supabase, phone);
console.log('Wipe result:', JSON.stringify(result, null, 2));
