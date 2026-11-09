/**
 * Saka Fleet — Superadmin profile wipe for a clean sign-up (v1.58.8)
 * -----------------------------------------------------------------
 * Permanently erases ONE account and everything keyed to it (profile, vehicles,
 * ledger, chats, sessions, trials, subscriptions, vouchers, the VIN ledger) so
 * the person can sign up fresh. It is OTP-gated in superadmin.js (a code goes to
 * SUPERADMIN_EMAIL) and always audited (ADMIN_PROFILE_WIPED).
 *
 * Never throws: every delete is best-effort and returns a per-table count.
 */

import { RECEIPTS_BUCKET, receiptStoragePaths } from './receipts.js';
// v1.84.0 (Phase 23) — the stored compliance documents must leave no PII behind.
import { DOCUMENTS_BUCKET } from './vehicleDocuments.js';

export async function wipeProfileForSignup(supabase, rawPhone) {
  if (!supabase || !rawPhone) return { ok: false, reason: 'missing phone or client' };
  const digits = String(rawPhone).replace(/[^0-9]/g, '');
  if (digits.length < 9) return { ok: false, reason: 'phone too short' };
  const tail = digits.slice(-9);
  const counts = {};

  const del = async (table, column, values) => {
    const vals = (values || []).filter((v) => v !== null && v !== undefined && v !== '');
    if (!vals.length) return;
    try {
      const { count } = await supabase.from(table).delete({ count: 'exact' }).in(column, vals);
      if (count) counts[table] = (counts[table] || 0) + count;
    } catch { /* table/column may not exist on this deployment — best effort */ }
  };

  // Resolve the profile country-agnostically by its trailing digits.
  let profiles = [];
  try {
    const { data } = await supabase.from('profiles').select('id, phone_number').ilike('phone_number', `%${tail}%`);
    profiles = data || [];
  } catch { profiles = []; }
  const profileIds = profiles.map((r) => r.id).filter(Boolean);
  // Build every stored phone form: +254…, 254…, 0…, bare 9-digit tail — so a
  // chat row stored without a "+" or "0" is never left behind (v1.58.8).
  const variants = new Set();
  const addVariants = (value) => {
    const d = String(value || '').replace(/[^0-9]/g, '');
    if (d.length < 9) return;
    const tail = d.slice(-9);
    for (const v of [d, `+${d}`, tail, `+${tail}`, `0${tail}`, `+0${tail}`]) variants.add(v);
    if (d.startsWith('0')) { const intl = `254${d.slice(1)}`; variants.add(intl); variants.add(`+${intl}`); }
    if (d.startsWith('254')) variants.add(`0${d.slice(3)}`);
  };
  addVariants(rawPhone);
  for (const r of profiles) addVariants(r.phone_number);
  const phones = [...variants];

  // Resolve vehicles by owner id or owner phone.
  let vehicles = [];
  try {
    const orParts = [];
    if (profileIds.length) orParts.push(`owner_id.in.(${profileIds.join(',')})`);
    orParts.push(`owner_phone.in.(${phones.join(',')})`);
    const { data } = await supabase.from('vehicles').select('id, plate_number, vin').or(orParts.join(','));
    vehicles = data || [];
  } catch { vehicles = []; }
  const vehicleIds = vehicles.map((r) => r.id).filter(Boolean);
  const plates = vehicles.map((r) => r.plate_number).filter(Boolean);
  const vins = vehicles.map((r) => r.vin).filter(Boolean);

  // Dependent rows keyed by vehicle.
  for (const t of ['expense_logs', 'private_earnings', 'expiry_notification_log', 'reminders', 'passbook_transfers', 'pending_owner_notifications', 'driver_compliances']) {
    await del(t, 'vehicle_id', vehicleIds);
  }
  // v1.58.15 - delete the stored receipt IMAGES too (rows alone leave PII orphans).
  try {
    const receiptOr = [];
    if (profileIds.length) receiptOr.push('owner_id.in.(' + profileIds.join(',') + ')', 'driver_id.in.(' + profileIds.join(',') + ')');
    if (vehicleIds.length) receiptOr.push('vehicle_id.in.(' + vehicleIds.join(',') + ')');
    if (receiptOr.length) {
      const { data: receiptRows } = await supabase.from('receipts').select('media_id, image_url').or(receiptOr.join(','));
      const paths = [];
      for (const row of receiptRows || []) paths.push(...receiptStoragePaths(row));
      const uniquePaths = [...new Set(paths)];
      if (uniquePaths.length) {
        const { error: storageError } = await supabase.storage.from(RECEIPTS_BUCKET).remove(uniquePaths);
        if (!storageError) counts.storage_objects = uniquePaths.length;
      }
    }
  } catch { /* best effort */ }

  // v1.84.0 (Phase 23) — stored compliance documents (rows + bucket objects).
  try {
    const documentOr = [];
    if (profileIds.length) documentOr.push('uploaded_by.in.(' + profileIds.join(',') + ')');
    if (vehicleIds.length) documentOr.push('vehicle_id.in.(' + vehicleIds.join(',') + ')');
    if (documentOr.length) {
      const { data: documentRows } = await supabase.from('vehicle_documents').select('storage_path').or(documentOr.join(','));
      const documentPaths = [...new Set((documentRows || []).map((row) => row.storage_path).filter(Boolean))];
      if (documentPaths.length) {
        const { error: documentStorageError } = await supabase.storage.from(DOCUMENTS_BUCKET).remove(documentPaths);
        if (!documentStorageError) counts.document_storage_objects = documentPaths.length;
      }
    }
  } catch (docWipeErr) {
    console.warn('[profileWipe] document vault skipped:', docWipeErr?.message || docWipeErr);
  }
  await del('vehicle_documents', 'vehicle_id', vehicleIds);
  await del('vehicle_documents', 'uploaded_by', profileIds);

  await del('receipts', 'vehicle_id', vehicleIds);
  await del('driver_assignments', 'vehicle_id', vehicleIds);
  await del('expenses', 'plate', plates);
  await del('coupons', 'vin', vins);
  await del('coupons', 'assigned_to_phone', phones);

  // Rows keyed by phone number.
  for (const [t, c] of [
    ['chat_history', 'user_phone'],
    ['chat_transcripts', 'phone_number'],
    ['chat_friction_logs', 'user_phone'],
    ['processed_webhooks', 'phone_number'],
    ['chat_sessions', 'phone_number'],
    ['superadmin_sessions', 'phone_number'],
    ['ai_usage_logs', 'phone_number'],
    ['turn_latency_logs', 'phone_number'],
    ['trial_sessions', 'owner_phone']
  ]) {
    await del(t, c, phones);
  }

  // Rows keyed by profile id.
  await del('receipts', 'owner_id', profileIds);
  await del('receipts', 'driver_id', profileIds);
  await del('driver_compliances', 'driver_id', profileIds);
  await del('driver_assignments', 'driver_id', profileIds);
  await del('subscriptions', 'owner_id', profileIds);
  await del('trial_sessions', 'owner_id', profileIds);

  // v1.91.0 (Phase 28A) — a reset also ends live dashboard sessions for the
  // account and any admin impersonation pointing at (or driven by) it, so no
  // cookie outlives the profile it belonged to.
  await del('dashboard_sessions', 'owner_id', profileIds);
  await del('admin_impersonations', 'target_profile_id', profileIds);
  await del('admin_impersonations', 'admin_profile_id', profileIds);

  // v1.92.0 (Phase 29) — the seller's Final Earnings Report queue and any
  // overdue-digest episode are account data and must not outlive the profile.
  await del('earnings_report_queue', 'owner_id', profileIds);
  await del('overdue_digest_log', 'owner_id', profileIds);

  // The VIN provenance ledger is erased ONLY here (an explicit admin full wipe),
  // so a fresh sign-up can re-register the same vehicle cleanly.
  await del('vin_registry', 'vin', vins);

  await del('vehicles', 'id', vehicleIds);
  await del('profiles', 'phone_number', phones);
  await del('profiles', 'id', profileIds);

  return { ok: true, phone: phones[0] || `+${digits}`, digits, counts, profiles: profileIds.length, vehicles: vehicleIds.length };
}

export default { wipeProfileForSignup };
