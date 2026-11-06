import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
// v1.59.7 — receipts can carry the same optional label as any other entry.
import { sanitizeEntryLabel } from './entryLabels.js';
// v1.63.1 — receipt writes land through the shared after-write hook.
import { markUserDataChanged } from './afterWrite.js';

/**
 * Saka Fleet — Receipt Vault (v1.19.0)
 * -----------------------------------
 * Every OCR'd photo gets a durable receipt row: document kind, confidence,
 * extracted hints, vendor and (best effort) the image URL. The same media id is
 * never processed twice, users can ask "receipts", and failed reads are kept for
 * audit without ever blocking the chat.
 */

export const RECEIPTS_TABLE = 'receipts';
export const RECEIPTS_BUCKET = process.env.RECEIPTS_BUCKET || 'receipts';
export const RECEIPT_RETENTION_DAYS = Math.max(0, Number(process.env.RECEIPT_RETENTION_DAYS || 0));
export const OCR_CONFIRM_THRESHOLD = Math.min(
  1,
  Math.max(0, Number(process.env.OCR_CONFIRM_THRESHOLD || 0.85))
);

export const RECEIPTS_SQL = `
    CREATE TABLE IF NOT EXISTS public.receipts (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        media_id text UNIQUE,
        owner_id uuid,
        driver_id uuid,
        vehicle_id uuid,
        document_kind text,
        status text DEFAULT 'read',
        confidence numeric,
        currency text,
        amount numeric,
        fuel_liters numeric,
        odometer integer,
        vendor text,
        image_url text,
        text_sha text,
        error text,
        created_at timestamp with time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_owner ON public.receipts(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_receipts_driver ON public.receipts(driver_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_receipts_text_sha ON public.receipts(text_sha);
`;

function getClient(providedSupabase) {
  return providedSupabase || null;
}

/** Ensure the receipts table exists (fail-soft; DDL needs a SQL transport). */
export async function ensureReceiptsTable(providedSupabase) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, status: 'no-client' };
  const { error } = await supabase.from(RECEIPTS_TABLE).select('id').limit(1);
  if (!error) return { ok: true, status: 'exists' };
  if (!/could not find the table|does not exist|schema cache/i.test(error.message || '')) {
    return { ok: false, status: 'error', error: error.message };
  }
  if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
  try {
    const result = await runSql(RECEIPTS_SQL, { label: 'ensureReceiptsTable' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

export async function findReceiptByMediaId(providedSupabase, mediaId) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !mediaId) return null;
  try {
    const { data } = await supabase.from(RECEIPTS_TABLE).select('*').eq('media_id', String(mediaId)).maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

/**
 * v1.32.1 — content dedupe: the SAME document re-uploaded gets a fresh WhatsApp
 * media id, so media-id matching alone never catches it. The OCR text hash does.
 * Never throws; returns the most recent match inside the window or null.
 */
export async function findRecentReceiptByTextSha(providedSupabase, { textSha = null, windowHours = 48 } = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !textSha) return null;
  const hours = Number.isFinite(Number(windowHours)) ? Math.max(1, Math.min(720, Number(windowHours))) : 48;
  try {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from(RECEIPTS_TABLE)
      .select('*')
      .eq('text_sha', String(textSha))
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1);
    return (data && data[0]) || null;
  } catch {
    return null;
  }
}

/** Persist an OCR receipt (unique per media id; never throws). */
export async function recordReceipt(providedSupabase, {
  mediaId,
  ownerId = null,
  driverId = null,
  vehicleId = null,
  documentKind = 'unknown',
  status = 'read',
  confidence = null,
  currency = null,
  amount = null,
  fuelLiters = null,
  odometer = null,
  vendor = null,
  imageUrl = null,
  textSha = null,
  label = null,
  error = null
} = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !mediaId) return { ok: false, error: 'Missing media id' };
  const row = {
    media_id: String(mediaId),
    owner_id: ownerId,
    driver_id: driverId,
    vehicle_id: vehicleId,
    document_kind: documentKind,
    status,
    confidence,
    currency,
    amount,
    fuel_liters: fuelLiters,
    odometer,
    vendor,
    image_url: imageUrl,
    text_sha: textSha,
    label: sanitizeEntryLabel(label),
    error
  };
  try {
    let { data, error: insertError } = await supabase.from(RECEIPTS_TABLE).insert([row]).select('*').maybeSingle();
    // Rule 50 — an un-migrated label column must never lose the receipt.
    if (insertError && /column|schema|does not exist/i.test(insertError.message || '')) {
      const { label: _dropped, ...legacy } = row;
      ({ data, error: insertError } = await supabase.from(RECEIPTS_TABLE).insert([legacy]).select('*').maybeSingle());
    }
    if (insertError) return { ok: false, error: insertError.message };
    // v1.63.1 — a new receipt is user data (uniform invalidation contract).
    markUserDataChanged({ supabase, ownerId: ownerId || driverId || null, reason: 'receipts.record' });
    return { ok: true, receipt: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Best-effort upload of the original image to the receipts bucket. */
export async function uploadReceiptImage(providedSupabase, buffer, mediaId, mimeType = 'image/jpeg') {
  const supabase = getClient(providedSupabase);
  if (!supabase || !buffer || !mediaId) return null;
  try {
    const ext = String(mimeType || '').includes('png') ? 'png' : (String(mimeType || '').includes('webp') ? 'webp' : 'jpg');
    const path = `${String(mediaId)}.${ext}`;
    const { error } = await supabase.storage.from(RECEIPTS_BUCKET).upload(path, buffer, { contentType: mimeType, upsert: true });
    if (error) return null;
    const { data } = supabase.storage.from(RECEIPTS_BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch {
    return null;
  }
}

/** Most recent receipts, role-scoped. */
export async function listReceipts(providedSupabase, { ownerId = null, driverId = null, vehicleIds = [], limit = 5 } = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return [];
  try {
    let query = supabase.from(RECEIPTS_TABLE).select('*').order('created_at', { ascending: false }).limit(Math.min(Math.max(Number(limit) || 5, 1), 20));
    if (ownerId) query = query.eq('owner_id', ownerId);
    else if (driverId) query = query.eq('driver_id', driverId);
    const { data } = await query;
    const rows = data || [];
    if (!vehicleIds.length) return rows;
    return rows.filter((row) => !row.vehicle_id || vehicleIds.includes(row.vehicle_id));
  } catch {
    return [];
  }
}

export const OCR_LOW_CONFIDENCE_NOTE = '📸 I read these from the photo — double-check the numbers before saving 🙏';

/**
 * v1.19.2 — OCR recovery ladder (deterministic, zero tokens).
 * Two unreadable photos on the same quiz step unlock one plain-language escape
 * hatch so the user is never trapped in an identical question loop.
 */
export const OCR_UNREADABLE_NOTE = '📸 That one came through but the text was too faint to read.\n\nNo stress — type the answer instead (or reply *Skip* if it is optional), and we keep going. 🙏';

function formatWhen(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatAmount(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency || 'USD'} ${Math.round(value).toLocaleString()}`;
  }
}

function statusDot(status) {
  const clean = String(status || '').toLowerCase();
  if (clean === 'failed') return '🔴';
  if (clean === 'low_confidence') return '🟡';
  return '🟢';
}

/** Deterministic "my receipts" reply (zero tokens). */
export function formatReceiptsReply({ receipts = [], vehicles = [], fallbackCurrency = null } = {}) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return '📸 No receipts yet.\n\nSend a clear photo of any fuel or service receipt and I will read the amount, litres and odometer for you.';
  }
  const lines = receipts.slice(0, 5).map((receipt) => {
    const vehicle = vehicles.find((row) => row.id === receipt.vehicle_id);
    const amount = formatAmount(receipt.amount, receipt.currency || fallbackCurrency);
    const vendor = receipt.vendor ? String(receipt.vendor).split('|')[0].trim() : (receipt.document_kind || 'Receipt');
    const bits = [amount, vehicle?.plate_number, formatWhen(receipt.created_at)].filter(Boolean);
    const labelChip = receipt.label ? ` · #${receipt.label}` : '';
    return `• ${statusDot(receipt.status)} *${vendor}* — ${bits.join(' · ')}${labelChip}`;
  });
  return `📸 *Your recent receipts*\n\n${lines.join('\n')}\n\nDelete one: *delete receipt N* (1 = newest; add DELETE to confirm). Send another photo anytime, or type *"receipts"* to see this list again.`;
}

/** Warm duplicate-receipt reply (never re-logs silently). */
export function formatDuplicateReceiptReply(receipt = {}, { fallbackCurrency = null } = {}) {
  const vendor = receipt.vendor ? String(receipt.vendor).split('|')[0].trim() : (receipt.document_kind || 'this receipt');
  const amount = formatAmount(receipt.amount, receipt.currency || fallbackCurrency);
  const when = formatWhen(receipt.created_at);
  const summary = [amount, when].filter(Boolean).join(' · ');
  return `📸 I've already read this receipt ✅ — *${vendor}*${summary ? ` (${summary})` : ''}.\n\n` +
    'Reply *"receipts"* to see your history, or type the details if you want to log it again.';
}


/** Derive the stored object paths for a receipt (URL tail + media-id extensions). */
export function receiptStoragePaths(row = {}) {
  const paths = new Set();
  if (row.image_url) {
    const marker = '/' + RECEIPTS_BUCKET + '/';
    const idx = String(row.image_url).indexOf(marker);
    if (idx !== -1) paths.add(String(row.image_url).slice(idx + marker.length));
  }
  if (row.media_id) {
    for (const ext of ['jpg', 'png', 'webp']) paths.add(String(row.media_id) + '.' + ext);
  }
  return [...paths];
}

/**
 * v1.58.15 - delete ONE receipt (row + stored image) for its owner/driver.
 * The parsed EXPENSE stays in the ledger (edit/delete it via my entries).
 */
export async function deleteReceipt(providedSupabase, { receiptId, ownerId = null, driverId = null } = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !receiptId) return { ok: false, error: 'missing' };
  try {
    const { data: row } = await supabase.from(RECEIPTS_TABLE).select('*').eq('id', receiptId).maybeSingle();
    if (!row) return { ok: false, error: 'not-found' };
    const mine = (ownerId && row.owner_id === ownerId) || (driverId && row.driver_id === driverId);
    if (!mine) return { ok: false, error: 'forbidden' };
    const paths = receiptStoragePaths(row);
    if (paths.length) { try { await supabase.storage.from(RECEIPTS_BUCKET).remove(paths); } catch { /* best effort */ } }
    const { error } = await supabase.from(RECEIPTS_TABLE).delete().eq('id', receiptId);
    if (error) return { ok: false, error: error.message };
    // v1.63.1 — a deleted receipt is user data (uniform invalidation contract).
    markUserDataChanged({ supabase, ownerId: row?.owner_id || row?.driver_id || ownerId || driverId || null, reason: 'receipts.delete' });
    return { ok: true, receipt: row, objects: paths.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * v1.58.15 - retention sweep. 0 (default) keeps receipts forever (tax evidence);
 * when RECEIPT_RETENTION_DAYS is set, old rows AND stored images are deleted.
 */
export async function pruneOldReceipts(providedSupabase, days = RECEIPT_RETENTION_DAYS) {
  const supabase = getClient(providedSupabase);
  const window = Math.max(0, Number(days) || 0);
  if (!supabase || !window) return { ok: true, skipped: true, deleted: 0 };
  try {
    const cutoff = new Date(Date.now() - window * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.from(RECEIPTS_TABLE).select('id, media_id, image_url').lt('created_at', cutoff).limit(500);
    const rows = data || [];
    if (!rows.length) return { ok: true, deleted: 0 };
    const paths = [];
    for (const row of rows) paths.push(...receiptStoragePaths(row));
    if (paths.length) { try { await supabase.storage.from(RECEIPTS_BUCKET).remove(paths); } catch { /* best effort */ } }
    const ids = rows.map((r) => r.id);
    const { error } = await supabase.from(RECEIPTS_TABLE).delete().in('id', ids);
    return error ? { ok: false, error: error.message } : { ok: true, deleted: ids.length, objects: paths.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default {
  RECEIPTS_TABLE,
  RECEIPTS_BUCKET,
  RECEIPTS_SQL,
  OCR_CONFIRM_THRESHOLD,
  RECEIPT_RETENTION_DAYS,
  OCR_LOW_CONFIDENCE_NOTE,
  ensureReceiptsTable,
  findReceiptByMediaId,
  receiptStoragePaths,
  deleteReceipt,
  pruneOldReceipts,
  recordReceipt,
  uploadReceiptImage,
  listReceipts,
  formatReceiptsReply,
  formatDuplicateReceiptReply
};

