import crypto from 'crypto';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { sendEmailOtp, sendTransferReleasePinEmail, sendPassbookWelcomeEmail } from './mailer.js';
import { getEffectiveExchangeRate } from './paystack.js';
import { findVehicleByCandidate } from './vehicles.js';
import { evaluateVehicleCapacity, invalidateEntitlements } from './subscriptions.js';
import { detectCountryFromPhone } from './globalization.js';
import { assetDisplayName } from './countryBucket.js';
import { isHoursLedKind } from './expenseCatalog.js';

/* ------------------------------------------------------------------ */
/* v1.92.0 (Phase 29) — earnings archive + final-report queue          */
/* ------------------------------------------------------------------ */
/*
 * A completed passbook transfer hands the VEHICLE (and its expense history)
 * to the buyer — but the seller's `private_earnings` are their private money
 * and must never surface in the buyer's records. The archive runs BEFORE the
 * COMPLETED flip (D3): a failure aborts the transfer, so the invariant
 * "COMPLETED ⇒ earnings archived" can never break. The seller keeps the rows
 * under `/d/records?history=1` and receives a Final Earnings Report by email
 * ten minutes later (the queue below, drained by a 30-second worker).
 */

export const EARNINGS_ARCHIVE_TABLE = 'private_earnings';
export const EARNINGS_REPORT_QUEUE_TABLE = 'earnings_report_queue';
export const EARNINGS_REPORT_DELAY_MS = 10 * 60 * 1000; // 10 minutes (D2/D5)

export const EARNINGS_ARCHIVE_SQL = `
ALTER TABLE public.private_earnings
    ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;
ALTER TABLE public.private_earnings
    ADD COLUMN IF NOT EXISTS archived_by_transfer_id uuid REFERENCES public.passbook_transfers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_private_earnings_archived
    ON public.private_earnings (archived_by_transfer_id)
    WHERE archived_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.earnings_report_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id uuid NOT NULL UNIQUE REFERENCES public.passbook_transfers(id) ON DELETE CASCADE,
    owner_id uuid,
    email text,
    due_at timestamp with time zone NOT NULL,
    sent_at timestamp with time zone,
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_earnings_report_queue_due
    ON public.earnings_report_queue (due_at)
    WHERE sent_at IS NULL;
ALTER TABLE public.earnings_report_queue ENABLE ROW LEVEL SECURITY;
`;

/**
 * v1.85.0 (Phase 24) — the asset's identity line for every transfer message.
 * Road assets carry a VIN; equipment/generators/vessels carry a serial instead
 * (rule 7 / §53.1) — a transfer never prints "VIN: N/A".
 */
let earningsArchiveReady = false;

/** Idempotent DDL probe (rule 50): missing columns/table fall through to DDL. */
export async function ensureEarningsArchiveSchema(providedSupabase) {
  if (!providedSupabase) return { status: 'no_client' };
  try {
    const { error } = await providedSupabase
      .from(EARNINGS_ARCHIVE_TABLE)
      .select('id, archived_at')
      .limit(1);
    if (!error) {
      earningsArchiveReady = true;
      return { status: 'exists' };
    }
  } catch (err) {
    console.warn('[Transfers] earnings archive probe failed (falling through to DDL):', err.message);
  }
  if (hasSqlAccess()) {
    const result = await runSql(EARNINGS_ARCHIVE_SQL, { label: 'ensureEarningsArchiveSchema' });
    if (result.ok) {
      earningsArchiveReady = true;
      return { status: 'created' };
    }
  }
  return { status: 'missing' };
}

export function isEarningsArchiveReady() {
  return earningsArchiveReady;
}

/**
 * Archive every LIVE earning of one vehicle under the transfer id.
 * ONE update, idempotent (`archived_at IS NULL` guard: a second transfer of the
 * same vehicle archives only the rows created since the first one). THROWS on
 * a database error — the caller (completePassbookTransfer) rolls the transfer
 * back, so no COMPLETED row can exist without archived earnings (D3).
 */
export async function archiveVehicleEarnings({ supabase, vehicleId, transferId, now = new Date() } = {}) {
  if (!supabase || !vehicleId || !transferId) {
    throw new Error('vehicleId and transferId are required to archive earnings');
  }
  const archivedAt = new Date(now).toISOString();
  const { data, error } = await supabase
    .from(EARNINGS_ARCHIVE_TABLE)
    .update({ archived_at: archivedAt, archived_by_transfer_id: transferId })
    .eq('vehicle_id', vehicleId)
    .is('archived_at', null)
    .select('id');
  if (error) throw new Error(error.message || 'Could not archive earnings.');
  return { ok: true, archivedCount: Array.isArray(data) ? data.length : 0, archivedAt };
}

/**
 * Undo an archive when a LATER step of the completion fails (D3 rollback).
 * Best-effort and never throws — the caller is already returning an honest
 * failure, and the next completion attempt re-archives cleanly.
 */
export async function restoreArchivedEarnings({ supabase, transferId } = {}) {
  if (!supabase || !transferId) return { ok: false };
  try {
    const { error } = await supabase
      .from(EARNINGS_ARCHIVE_TABLE)
      .update({ archived_at: null, archived_by_transfer_id: null })
      .eq('archived_by_transfer_id', transferId);
    if (error) {
      console.warn('[Transfers] earnings archive rollback skipped:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[Transfers] earnings archive rollback threw:', err.message);
    return { ok: false, error: err.message };
  }
}

/** Best-effort audit trail (never throws; the transfer outcome is unaffected). */
async function auditTransferEvent(supabase, action, details = {}) {
  if (!supabase) return;
  try {
    await supabase.from('admin_audit_logs').insert([{
      admin_phone: 'SYSTEM',
      action,
      details,
      created_at: new Date().toISOString()
    }]);
  } catch (err) {
    console.warn(`[Transfers] audit ${action} skipped:`, err.message);
  }
}

/** Queue the 10-minute Final Earnings Report email (never blocks the transfer). */
export async function queueEarningsReport({ supabase, transferId, ownerId, email, now = new Date() } = {}) {
  if (!supabase || !transferId) return { ok: false, error: 'transferId required' };
  try {
    const dueAt = new Date(new Date(now).getTime() + EARNINGS_REPORT_DELAY_MS).toISOString();
    const { error } = await supabase.from(EARNINGS_REPORT_QUEUE_TABLE).insert([{
      transfer_id: transferId,
      owner_id: ownerId || null,
      email: email || null,
      due_at: dueAt,
      attempts: 0,
      created_at: new Date(now).toISOString()
    }]);
    if (error) {
      // A duplicate queue row (a replayed completion) is not a failure.
      if (/duplicate|unique/i.test(error.message || '')) return { ok: true, duplicate: true, dueAt };
      console.warn('[Transfers] earnings report queue skipped:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, dueAt };
  } catch (err) {
    console.warn('[Transfers] earnings report queue threw:', err.message);
    return { ok: false, error: err.message };
  }
}

export function transferIdentity(vehicle = {}, vin = null) {
  const value = vin || vehicle?.vin || null;
  if (value) return { label: 'VIN', value };
  if (vehicle?.serial_number) return { label: 'Serial', value: vehicle.serial_number };
  return null;
}

/** "Plate: KDA 123A · VIN: ..." (or Serial) — or just the plate for equipment. */
function identityText(vehicle = {}, vin = null) {
  const plate = assetDisplayName(vehicle);
  const identity = transferIdentity(vehicle, vin);
  return identity ? `${plate} · ${identity.label}: ${identity.value}` : plate;
}

/**
 * Step 1: Initiate passbook transfer by current owner
 */
export async function initiatePassbookTransfer({ fromPhone, vehicleCandidate, supabase }) {
  if (!supabase || !fromPhone) {
    return { success: false, error: 'Database client and sender phone are required' };
  }

  const cleanFromPhone = fromPhone.startsWith('+') ? fromPhone : `+${fromPhone.replace(/[^\d]/g, '')}`;

  try {
    const { data: ownerProfile } = await supabase
      .from('profiles')
      .select('id, phone_number, full_name, email')
      .eq('phone_number', cleanFromPhone)
      .maybeSingle();

    if (!ownerProfile) {
      return { success: false, error: 'Owner profile not found.' };
    }

    const { data: vehicles, error: vErr } = await supabase
      .from('vehicles')
      .select('*')
      .eq('owner_id', ownerProfile.id)
      .is('deleted_at', null);

    if (vErr || !vehicles || vehicles.length === 0) {
      return { success: false, error: `Vehicle "${vehicleCandidate || ''}" was not found in your registered fleet.` };
    }

    let targetVeh = vehicles[0];
    if (vehicleCandidate) {
      const found = findVehicleByCandidate(vehicles, vehicleCandidate);
      if (found) {
        targetVeh = found;
      } else {
        return { success: false, error: `Vehicle "${vehicleCandidate}" was not found in your registered fleet.` };
      }
    }

    // Check if there's already a pending transfer in flight
    // v1.87.5 — EVERY pending status blocks a second handover; PENDING_BUYER_UPGRADE
    // (the buyer-capacity pause) was missing, so a paused transfer allowed a
    // duplicate to start for the same vehicle.
    const { data: activeTransfer } = await supabase
      .from('passbook_transfers')
      .select('*')
      .eq('vehicle_id', targetVeh.id)
      .in('status', ['PENDING_TARGET_DETAILS', 'PENDING_OWNER_RELEASE_OTP', 'PENDING_BUYER_ACCEPTANCE', 'PENDING_BUYER_OTP', 'PENDING_BUYER_UPGRADE'])
      .maybeSingle();

    if (activeTransfer) {
      return {
        success: false,
        isExistingPending: true,
        transferId: activeTransfer.id,
        error: `There is already an active transfer in progress for ${targetVeh.plate_number}. Reply "cancel transfer" to abort it first.`
      };
    }

    // Check Annual Transfer Quota: 1 free transfer per vehicle per calendar year
    const currentYear = new Date().getFullYear();
    const yearStartIso = new Date(currentYear, 0, 1).toISOString();

    const { count: completedTransfersCount } = await supabase
      .from('passbook_transfers')
      .select('id', { count: 'exact', head: true })
      .eq('vehicle_id', targetVeh.id)
      .eq('status', 'COMPLETED')
      .gte('completed_at', yearStartIso);

    const isFreeTransfer = (completedTransfersCount || 0) === 0;
    const feeAmount = isFreeTransfer ? 0 : 3.00;

    const { data: newTransfer, error: insErr } = await supabase
      .from('passbook_transfers')
      .insert([{
        vehicle_id: targetVeh.id,
        vin: targetVeh.vin,
        from_owner_id: ownerProfile.id,
        is_free_transfer: isFreeTransfer,
        fee_amount: feeAmount,
        fee_currency: 'USD',
        transfer_fee_paid: isFreeTransfer,
        status: 'PENDING_TARGET_DETAILS',
        initiated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (insErr) {
      return { success: false, error: `Failed to initiate transfer: ${insErr.message}` };
    }

    return {
      success: true,
      transferId: newTransfer.id,
      vehicle: targetVeh,
      ownerProfile,
      isFreeTransfer,
      feeAmount
    };
  } catch (err) {
    console.error('[Transfers] Error initiating transfer:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Step 2: Capture buyer's phone and email, and dispatch 6-digit release PIN to owner
 */
export async function setBuyerDetailsAndSendReleaseOtp({ transferId, buyerPhone, buyerEmail, supabase }) {
  if (!supabase || !transferId || !buyerPhone || !buyerEmail) {
    return { success: false, error: 'Transfer ID, buyer phone, and buyer email are required' };
  }

  const cleanBuyerPhone = buyerPhone.startsWith('+') ? buyerPhone : `+${buyerPhone.replace(/[^\d]/g, '')}`;
  const cleanBuyerEmail = buyerEmail.toLowerCase().trim();

  try {
    const { data: transfer, error: tErr } = await supabase
      .from('passbook_transfers')
      .select('*, vehicles!passbook_transfers_vehicle_id_fkey(*), profiles!passbook_transfers_from_owner_id_fkey(*)')
      .eq('id', transferId)
      .single();

    if (tErr || !transfer) {
      return { success: false, error: 'Transfer record not found' };
    }

    const releasePin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase.from('passbook_transfers').update({
      to_owner_phone: cleanBuyerPhone,
      to_owner_email: cleanBuyerEmail,
      release_otp: releasePin,
      release_otp_expires_at: expiresAt,
      status: 'PENDING_OWNER_RELEASE_OTP'
    }).eq('id', transferId);

    const ownerEmail = transfer.vehicles?.owner_email || transfer.profiles?.email;
    const ownerName = transfer.profiles?.full_name || 'Fleet Owner';
    const plate = transfer.vehicles?.plate_number || 'Vehicle';
    const vin = transfer.vin || transfer.vehicles?.vin || 'N/A';

    if (ownerEmail) {
      await sendTransferReleasePinEmail({
        targetEmail: ownerEmail,
        ownerName,
        plateNumber: plate,
        vin,
        releasePin
      });
    }

    return {
      success: true,
      releasePin,
      ownerEmail,
      buyerPhone: cleanBuyerPhone,
      buyerEmail: cleanBuyerEmail,
      vehicle: transfer.vehicles
    };
  } catch (err) {
    console.error('[Transfers] Error in Step 2:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Step 3: Owner enters release PIN -> Authorize asset release & message buyer on WhatsApp
 */
export async function verifyOwnerReleaseOtpAndNotifyBuyer({ transferId, providedOtp, supabase, sendWhatsAppFn }) {
  if (!supabase || !transferId || !providedOtp) {
    return { success: false, error: 'Transfer ID and OTP are required' };
  }

  const cleanOtp = providedOtp.toString().trim();

  try {
    const { data: transfer, error: tErr } = await supabase
      .from('passbook_transfers')
      .select('*, vehicles!passbook_transfers_vehicle_id_fkey(*), profiles!passbook_transfers_from_owner_id_fkey(*)')
      .eq('id', transferId)
      .single();

    if (tErr || !transfer) {
      return { success: false, error: 'Transfer record not found' };
    }

    if (transfer.status !== 'PENDING_OWNER_RELEASE_OTP') {
      return { success: false, error: `Transfer is not awaiting release PIN (current status: ${transfer.status})` };
    }

    if (transfer.release_otp !== cleanOtp) {
      return { success: false, error: 'Invalid 6-digit release PIN. Please check your email and try again.' };
    }

    if (new Date() > new Date(transfer.release_otp_expires_at)) {
      return { success: false, error: 'Release PIN has expired. Please initiate a new transfer request.' };
    }

    await supabase.from('passbook_transfers').update({
      status: 'PENDING_BUYER_ACCEPTANCE'
    }).eq('id', transferId);

    const buyerPhone = transfer.to_owner_phone;
    const sellerName = transfer.profiles?.full_name || 'Fleet Owner';
    const sellerPhone = transfer.profiles?.phone_number || '';
    const plate = assetDisplayName(transfer.vehicles || {}) || 'Vehicle';
    const makeModel = transfer.vehicles?.make_model || 'Vehicle';
    const identity = transferIdentity(transfer.vehicles || {}, transfer.vin || transfer.vehicles?.vin);
    const vin = identity?.value || null;
    const identityLine = identity ? ` (${identity.label}: ${identity.value})` : '';

    if (buyerPhone && sendWhatsAppFn) {
      const buyerMsg = `🚗 *Saka Fleet Passbook Transfer Request*\n\nHello! *${sellerName}* (${sellerPhone}) has initiated a passbook transfer for *${makeModel}* (${plate}${identityLine}).\n\nReply *"ACCEPT"* to claim ownership of this vehicle passbook.\n_(Or reply "DECLINE" to reject)_`;
      // v1.87.1 — a buyer may never have messaged Saka; the invite rides the
      // approved Utility template when META_TPL_TRANSFER_INVITE is set.
      await sendWhatsAppFn(buyerPhone, buyerMsg, { kind: 'transfer_invite', templateVars: { plate } });
    }

    return {
      success: true,
      buyerPhone,
      plateNumber: plate,
      vin,
      isFreeTransfer: transfer.is_free_transfer
    };
  } catch (err) {
    console.error('[Transfers] Error in Step 3:', err);
    return { success: false, error: err.message };
  }
}

/**
 * v1.85.0 (Phase 24) — the transfer fee in the BUYER's currency. Pure so the
 * suites can prove a Nigerian buyer is never quoted KES; the live path supplies
 * the cached FX rate.
 */
export function formatTransferFeeLine({ currency = 'USD', rate = 1, locale = 'en-US' } = {}) {
  const cur = String(currency || 'USD').toUpperCase();
  if (cur === 'USD') return { currency: 'USD', amount: 3, localPriceStr: 'USD 3.00', localFigure: '' };
  const localAmount = Math.round(3.0 * Number(rate || 1));
  const localPriceStr = `${cur} ${localAmount.toLocaleString(locale || 'en-US')}`;
  return { currency: cur, amount: localAmount, localPriceStr, localFigure: ` (~${localPriceStr})` };
}

/**
 * Step 4: Buyer replies "ACCEPT" -> Check fee or dispatch buyer email OTP
 */
export async function handleBuyerAcceptance({ buyerPhone, supabase, sendWhatsAppFn }) {
  if (!supabase || !buyerPhone) return null;

  const cleanPhone = buyerPhone.startsWith('+') ? buyerPhone : `+${buyerPhone.replace(/[^\d]/g, '')}`;

  try {
    const { data: transfer, error } = await supabase
      .from('passbook_transfers')
      .select('*, vehicles!passbook_transfers_vehicle_id_fkey(*), profiles!passbook_transfers_from_owner_id_fkey(*)')
      .eq('to_owner_phone', cleanPhone)
      .eq('status', 'PENDING_BUYER_ACCEPTANCE')
      .order('initiated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !transfer) {
      return null;
    }

    const plate = assetDisplayName(transfer.vehicles || {}) || 'Vehicle';
    const identity = transferIdentity(transfer.vehicles || {}, transfer.vin || transfer.vehicles?.vin);
    const vin = identity?.value || null;
    const identityLine = identity ? ` (${identity.label}: ${identity.value})` : '';

    if (!transfer.is_free_transfer && !transfer.transfer_fee_paid) {
      // v1.85.0 (Phase 24) — the fee quote follows the BUYER'S country (rule 7):
      // a Nigerian buyer sees NGN, a Kenyan buyer sees KES — never a hardcoded KES.
      const buyerRegion = detectCountryFromPhone(cleanPhone);
      const feeCurrency = buyerRegion?.currency || 'USD';
      const feeLine = formatTransferFeeLine({
        currency: feeCurrency,
        rate: feeCurrency === 'USD' ? 1 : await getEffectiveExchangeRate(supabase, feeCurrency),
        locale: buyerRegion?.locale || 'en-US'
      });
      const localPriceStr = feeLine.localPriceStr;
      const localFigure = feeLine.localFigure;

      return {
        status: 'PAYMENT_REQUIRED',
        transferId: transfer.id,
        isFreeTransfer: false,
        feeAmount: 3.0,
        localPriceStr,
        plateNumber: plate,
        vin,
        replyMessage: `💳 *Passbook Transfer Fee Required*\n\nThis asset (*${plate}*) has already utilized its 1 free transfer for this calendar year.\n\nA flat transfer fee of *USD 3.00*${localFigure} is required before completing the passbook handover.\n\n👉 *Pay Transfer Fee securely:* https://sakafleet.com/pay-transfer?id=${transfer.id}\n\nOnce payment is confirmed, reply *"PAID"* to finalize!`
      };
    }

    const buyerOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase.from('passbook_transfers').update({
      buyer_otp: buyerOtp,
      buyer_otp_expires_at: expiresAt,
      status: 'PENDING_BUYER_OTP'
    }).eq('id', transfer.id);

    if (transfer.to_owner_email) {
      await sendEmailOtp(transfer.to_owner_email, buyerOtp);
    }

    return {
      status: 'OTP_SENT',
      transferId: transfer.id,
      buyerEmail: transfer.to_owner_email,
      plateNumber: plate,
      vin,
      replyMessage: `📧 *Step 5 of 5: Buyer Email Verification*\n\nWe sent a 6-digit verification code to your email (*${transfer.to_owner_email}*).\n\nPlease reply with the 6-digit code to finalize claiming *${plate}*${identityLine} and receive your official digital passbook!`
    };
  } catch (err) {
    console.error('[Transfers] Error in Step 4:', err);
    return null;
  }
}

/**
 * Step 5: Buyer enters email OTP -> Execute Re-anchoring to new owner
 */
export async function completePassbookTransfer({ buyerPhone, providedOtp, supabase, sendWhatsAppFn }) {
  if (!supabase || !buyerPhone || !providedOtp) {
    return { success: false, error: 'Phone and OTP are required' };
  }

  const cleanPhone = buyerPhone.startsWith('+') ? buyerPhone : `+${buyerPhone.replace(/[^\d]/g, '')}`;
  const cleanOtp = providedOtp.toString().trim();

  try {
    const { data: transfer, error: tErr } = await supabase
      .from('passbook_transfers')
      .select('*, vehicles!passbook_transfers_vehicle_id_fkey(*), seller:profiles!passbook_transfers_from_owner_id_fkey(*)')
      .eq('to_owner_phone', cleanPhone)
      .in('status', ['PENDING_BUYER_OTP', 'PENDING_BUYER_UPGRADE'])
      .order('initiated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (tErr || !transfer) {
      return { success: false, error: 'No transfer found pending email verification.' };
    }

    if (transfer.buyer_otp !== cleanOtp) {
      return { success: false, error: 'Invalid verification code. Please check your email or reply "resend".' };
    }

    if (new Date() > new Date(transfer.buyer_otp_expires_at)) {
      return { success: false, error: 'Verification code expired. Please request a new code.' };
    }

    let { data: buyerProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('phone_number', cleanPhone)
      .maybeSingle();

    if (!buyerProfile) {
      const { data: newP } = await supabase
        .from('profiles')
        .insert([{
          id: crypto.randomUUID(),
          phone_number: cleanPhone,
          email: transfer.to_owner_email,
          email_verified: true,
          full_name: 'Fleet Owner',
          subscription_tier: 'free',
          subscription_status: 'active'
        }])
        .select()
        .single();
      buyerProfile = newP;
    } else {
      await supabase.from('profiles').update({
        email: transfer.to_owner_email,
        email_verified: true,
        updated_at: new Date().toISOString()
      }).eq('id', buyerProfile.id);
    }

    const newToken = `SK-PASSBOOK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const vehicleId = transfer.vehicle_id;
    const oldVeh = transfer.vehicles;

    // Simple Rule R2 — the buyer's garage must have a free slot before the
    // passbook re-anchors. Over capacity: pause the transfer (24h OTP window)
    // and return the upgrade path; the buyer retries the same code afterwards.
    const capacity = await evaluateVehicleCapacity({
      supabase,
      ownerId: buyerProfile.id,
      additionalVehicles: 1
    });
    if (!capacity.allowed) {
      await supabase.from('passbook_transfers').update({
        status: 'PENDING_BUYER_UPGRADE',
        blocked_reason: 'BUYER_UPGRADE_REQUIRED',
        buyer_otp_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      }).eq('id', transfer.id);
      return {
        success: false,
        needsUpgrade: true,
        capacity,
        error: `Your ${capacity.tierName} plan allows ${capacity.capacity} active vehicle(s) and you already have ${capacity.currentCount}. Upgrade to accept this passbook.`
      };
    }

    // D3 (v1.92.0, Phase 29) — archive the seller's earnings BEFORE anything
    // changes. A failure aborts here with NOTHING touched; a later failure rolls
    // the archive back (restoreArchivedEarnings), so a COMPLETED transfer can
    // never exist without archived earnings.
    let archiveResult = { archivedCount: 0 };
    try {
      archiveResult = await archiveVehicleEarnings({
        supabase,
        vehicleId,
        transferId: transfer.id
      });
    } catch (archiveErr) {
      console.error('[completePassbookTransfer] Earnings archive failed:', archiveErr.message);
      await auditTransferEvent(supabase, 'ADMIN_TRANSFER_ARCHIVE_FAILED', {
        transferId: transfer.id,
        vehicleId,
        error: String(archiveErr.message || 'archive_failed').slice(0, 300)
      });
      return {
        success: false,
        error: 'Could not finalize the transfer. Nothing was changed. Please try again.'
      };
    }

    const { error: vUpErr } = await supabase.from('vehicles').update({
      owner_id: buyerProfile.id,
      owner_phone: cleanPhone,
      owner_email: transfer.to_owner_email,
      assigned_driver_id: null,
      qr_passbook_token: newToken,
      transfer_count_current_year: (oldVeh?.transfer_count_current_year || 0) + 1,
      last_transfer_year: new Date().getFullYear(),
      updated_at: new Date().toISOString()
    }).eq('id', vehicleId);

    if (vUpErr) {
      console.error('[completePassbookTransfer] Error updating vehicle:', vUpErr);
      await restoreArchivedEarnings({ supabase, transferId: transfer.id });
      return { success: false, error: 'Could not finalize the transfer. Nothing was changed. Please try again.' };
    }

    if (transfer.vin) {
      await supabase.from('vin_registry').update({
        current_vehicle_id: vehicleId,
        updated_at: new Date().toISOString()
      }).eq('vin', transfer.vin);
    }

    const { error: completeErr } = await supabase.from('passbook_transfers').update({
      status: 'COMPLETED',
      to_owner_id: buyerProfile.id,
      blocked_reason: null,
      completed_at: new Date().toISOString()
    }).eq('id', transfer.id);
    if (completeErr) {
      console.error('[completePassbookTransfer] Error completing transfer:', completeErr);
      await restoreArchivedEarnings({ supabase, transferId: transfer.id });
      return { success: false, error: 'Could not finalize the transfer. Nothing was changed. Please try again.' };
    }
    await auditTransferEvent(supabase, 'ADMIN_TRANSFER_EARNINGS_ARCHIVED', {
      transferId: transfer.id,
      vehicleId,
      archivedCount: archiveResult.archivedCount || 0
    });
    // The Final Earnings Report rides a 10-minute queue; the email address is
    // the seller profile's (a phone-only owner simply has no email copy).
    const sellerEmail = transfer.seller?.email || null;
    if (sellerEmail) {
      await queueEarningsReport({
        supabase,
        transferId: transfer.id,
        ownerId: transfer.from_owner_id,
        email: sellerEmail
      });
    } else {
      await auditTransferEvent(supabase, 'ADMIN_TRANSFER_EARNINGS_REPORT_SKIPPED', {
        transferId: transfer.id,
        vehicleId,
        reason: 'seller_has_no_email'
      });
    }
    invalidateEntitlements(buyerProfile.id);
    invalidateEntitlements(transfer.from_owner_id);

    if (transfer.to_owner_email) {
      // v1.85.0 (Phase 24) — the welcome email speaks the asset's own meter and
      // identity: engine hours for hours-led assets, serial when no VIN exists.
      const welcomeIdentity = transferIdentity(oldVeh || {}, transfer.vin);
      const hoursLedAsset = isHoursLedKind(oldVeh?.asset_kind || oldVeh?.asset_type || 'vehicle');
      await sendPassbookWelcomeEmail({
        targetEmail: transfer.to_owner_email,
        plateNumber: assetDisplayName(oldVeh || {}) || 'Asset',
        makeModel: oldVeh?.make_model || 'Asset',
        yom: oldVeh?.yom || oldVeh?.year_of_manufacture || 2020,
        vin: welcomeIdentity?.value || null,
        identityLabel: welcomeIdentity ? `${welcomeIdentity.label} (${welcomeIdentity.label === 'VIN' ? 'Chassis' : 'Machine'})` : null,
        identityValue: welcomeIdentity?.value || null,
        token: newToken,
        fuelType: oldVeh?.fuel_type || 'Petrol',
        mileage: oldVeh?.current_mileage || 0,
        meterLabel: hoursLedAsset ? 'Initial Engine Hours' : 'Initial Mileage',
        meterValue: hoursLedAsset ? (oldVeh?.operating_hours || 0) : (oldVeh?.current_mileage || 0),
        meterUnit: hoursLedAsset ? 'h' : 'km'
      }).catch(err => console.warn('Could not send passbook email:', err.message));
    }

    const sellerPhone = transfer.seller?.phone_number;
    if (sellerPhone && sendWhatsAppFn) {
      const historyLine = sellerEmail
        ? 'Your earnings history for this asset has been archived and stays yours. Check your email for a final report.'
        : 'Your earnings history for this asset has been archived and stays yours — open your dashboard → Records → Transferred to see it.';
      const sellerMsg = `✅ *Passbook Transfer Complete!*\n\nOwnership of *${identityText(oldVeh || {}, transfer.vin)}* has been successfully transferred to *${buyerProfile.full_name || cleanPhone}*.\n\nThe asset has been unlinked from your fleet roster.\n\n${historyLine}`;
      await sendWhatsAppFn(sellerPhone, sellerMsg);
    }

    return {
      success: true,
      plateNumber: assetDisplayName(oldVeh || {}) || 'Asset',
      vin: transfer.vin,
      newToken,
      buyerEmail: transfer.to_owner_email,
      sellerPhone
    };
  } catch (err) {
    console.error('[Transfers] Error in Step 5:', err);
    return { success: false, error: err.message };
  }
}
