import { randomUUID } from 'node:crypto';
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { markUserDataChanged } from './afterWrite.js';

/**
 * Saka Fleet — Vehicle Document Vault (Phase 23, v1.84.0)
 * -------------------------------------------------------
 * Logbooks, insurance policies, inspection certificates and road licences were
 * only ever PARSED: the raw photo/PDF was discarded after OCR. This vault keeps
 * the original file in the private `documents` bucket (paid tiers + welcome
 * trial, exactly like the receipt vault) and a `vehicle_documents` row for every
 * upload — so the owner can retrieve the real certificate from the dashboard.
 *
 * Contracts (permanent):
 *  - Never throws. Every failure is returned as `{ ok:false, error }` and can
 *    never block a chat turn (mirrors receipts.js).
 *  - One row per WhatsApp media id (`media_id UNIQUE`) — a Meta retry or a
 *    re-sent document is never stored twice.
 *  - Free tier keeps the PARSED DATA only (`storage_path = null`), matching the
 *    receipt vault rule (D2, v1.58.16 copy).
 *  - The link to `vehicle_compliances` is a nullable FK ON this table
 *    (`compliance_id … ON DELETE SET NULL`); deleting a file never touches the
 *    compliance ledger and vice versa.
 *  - Driver documents are OUT OF SCOPE: this ledger is vehicle-only (§40.2).
 *  - Deletion removes the row + the stored object and audits
 *    `VEHICLE_DOCUMENT_DELETED`; the parsed compliance data stays.
 */

export const VEHICLE_DOCUMENTS_TABLE = 'vehicle_documents';
export const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET || 'documents';
export const DOCUMENT_LINK_WINDOW_HOURS = Math.max(
  1,
  Math.min(168, Number(process.env.DOCUMENT_LINK_WINDOW_HOURS || 24))
);

export const VEHICLE_DOCUMENT_TYPES = Object.freeze([
  'logbook',
  'insurance',
  'inspection',
  'ntsa_cert',
  'pinkslip',
  'road_license',
  'other'
]);

/** Document Lens family → stored document_type (vehicle-scoped families only). */
export const DOCUMENT_TYPE_BY_FAMILY = Object.freeze({
  logbook: 'logbook',
  insurance: 'insurance',
  inspection: 'inspection',
  road_licence: 'road_license'
});

/** Stored document_type → `vehicle_compliances.type` it can prove. */
export const COMPLIANCE_TYPE_BY_DOCUMENT_TYPE = Object.freeze({
  logbook: 'registration',
  insurance: 'insurance',
  inspection: 'inspection',
  ntsa_cert: 'inspection',
  pinkslip: 'inspection',
  road_license: 'road_service_licence'
});

export const DOCUMENT_TYPE_LABELS = Object.freeze({
  logbook: 'Registration certificate (logbook)',
  insurance: 'Insurance certificate',
  inspection: 'Inspection certificate',
  ntsa_cert: 'NTSA certificate',
  pinkslip: 'Pinkslip',
  road_license: 'Road licence / PSL',
  other: 'Document'
});

export const VEHICLE_DOCUMENTS_SQL = `
    CREATE TABLE IF NOT EXISTS public.vehicle_documents (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
        document_type text NOT NULL DEFAULT 'other',
        storage_path text,
        original_filename text,
        parsed_data jsonb DEFAULT '{}'::jsonb,
        compliance_id uuid,
        media_id text UNIQUE,
        uploaded_by uuid,
        uploaded_at timestamp with time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle ON public.vehicle_documents(vehicle_id, uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vehicle_documents_uploader ON public.vehicle_documents(uploaded_by, uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vehicle_documents_compliance ON public.vehicle_documents(compliance_id);
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'vehicle_documents_compliance_fk'
      ) THEN
        ALTER TABLE public.vehicle_documents
          ADD CONSTRAINT vehicle_documents_compliance_fk
          FOREIGN KEY (compliance_id) REFERENCES public.vehicle_compliances(id) ON DELETE SET NULL;
      END IF;
    END $$;
`;

/**
 * v1.86.0 (Phase 25) — document renewal supersedes the previous file of the SAME
 * document_type instead of piling a new row on top. The superseded row + its
 * stored object are KEPT (rule 48: documents are evidence), only hidden from the
 * current list. Idempotent; a table created later still gets the columns.
 */
export const VEHICLE_DOCUMENTS_SUPERSEDE_SQL = `
    ALTER TABLE public.vehicle_documents ADD COLUMN IF NOT EXISTS superseded_at timestamp with time zone;
    ALTER TABLE public.vehicle_documents ADD COLUMN IF NOT EXISTS superseded_by uuid;
    CREATE INDEX IF NOT EXISTS idx_vehicle_documents_current
        ON public.vehicle_documents(vehicle_id, document_type, uploaded_at DESC)
        WHERE superseded_at IS NULL;
`;

function getClient(providedSupabase) {
  return providedSupabase || null;
}

/** The stored document_type for a Document Lens family, or null when unsupported. */
export function documentTypeForFamily(family = '') {
  return DOCUMENT_TYPE_BY_FAMILY[String(family || '').trim()] || null;
}

/** True when this lens family is a vehicle compliance document we keep on file. */
export function isVaultableDocumentFamily(family = '') {
  return Boolean(documentTypeForFamily(family));
}

/** The `vehicle_compliances.type` a stored document can prove, or null. */
export function complianceTypeForDocumentType(documentType = '') {
  return COMPLIANCE_TYPE_BY_DOCUMENT_TYPE[String(documentType || '').trim()] || null;
}

/** Plain-language label for a stored document type. */
export function documentTypeLabel(documentType = '') {
  const key = String(documentType || '').trim();
  return DOCUMENT_TYPE_LABELS[key] || DOCUMENT_TYPE_LABELS.other;
}

/** Bucket-relative object path: `documents/<vehicle_id>/<uuid>.<ext>`. */
export function documentStorageExtension(mimeType = '') {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('pdf')) return 'pdf';
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('heic') || type.includes('heif')) return 'heic';
  return 'jpg';
}

export function documentStoragePath(vehicleId, mimeType = 'image/jpeg') {
  return `${String(vehicleId)}/${randomUUID()}.${documentStorageExtension(mimeType)}`;
}

/** Ensure the vehicle_documents table exists (fail-soft; DDL needs a SQL transport). */
export async function ensureVehicleDocumentsTable(providedSupabase) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, status: 'no-client' };
  const { error } = await supabase.from(VEHICLE_DOCUMENTS_TABLE).select('id').limit(1);
  if (!error) {
    // v1.86.0 (Phase 25) — the supersede columns ride the same boot ensure.
    const columns = await ensureSupersedeColumns(supabase);
    return { ok: true, status: 'exists', supersede: columns.status };
  }
  if (!/could not find the table|does not exist|schema cache/i.test(error.message || '')) {
    return { ok: false, status: 'error', error: error.message };
  }
  if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
  try {
    const result = await runSql(`${VEHICLE_DOCUMENTS_SQL}\n${VEHICLE_DOCUMENTS_SUPERSEDE_SQL}`, { label: 'ensureVehicleDocumentsTable' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null, supersede: result.ok ? 'created' : 'error' };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

/**
 * v1.86.0 (Phase 25) — add superseded_at/superseded_by when the table exists but
 * predates the renewal fix. Never throws: without a SQL transport the read and
 * write paths degrade on their own (rule 50).
 */
export async function ensureSupersedeColumns(providedSupabase) {
  const supabase = getClient(providedSupabase);
  if (!supabase) return { ok: false, status: 'no-client' };
  const probe = await supabase.from(VEHICLE_DOCUMENTS_TABLE).select('superseded_at').limit(1);
  if (!probe.error) return { ok: true, status: 'exists' };
  if (!/superseded_at|column .* does not exist|schema cache/i.test(probe.error.message || '')) {
    return { ok: false, status: 'error', error: probe.error.message };
  }
  if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
  try {
    const result = await runSql(VEHICLE_DOCUMENTS_SUPERSEDE_SQL, { label: 'ensureSupersedeColumns' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

/** The stored row for a WhatsApp media id, or null (dedupe + Meta retries). */
export async function findVehicleDocumentByMediaId(providedSupabase, mediaId) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !mediaId) return null;
  try {
    const { data } = await supabase.from(VEHICLE_DOCUMENTS_TABLE).select('*').eq('media_id', String(mediaId)).maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

/**
 * Store ONE compliance document: upload the original file (paid tiers) and
 * insert the `vehicle_documents` row. Never throws; a duplicate media id returns
 * the existing row instead of a second copy.
 */
export async function vaultVehicleDocument({
  supabase: providedSupabase,
  vehicleId = null,
  profileId = null,
  buffer = null,
  mediaId = null,
  mimeType = 'image/jpeg',
  originalFilename = null,
  parsedData = null,
  documentType = 'other',
  entitlements = null
} = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !vehicleId) return { ok: false, error: 'missing vehicle' };
  try {
    if (mediaId) {
      const existing = await findVehicleDocumentByMediaId(supabase, mediaId);
      if (existing) return { ok: true, duplicate: true, document: existing, stored: Boolean(existing.storage_path) };
    }
    // Free tier keeps the parsed data but NOT the file (receipt vault contract).
    const vaultAllowed = !entitlements || entitlements.receiptVaultStorage !== false;
    let storagePath = null;
    if (vaultAllowed && buffer && buffer.length) {
      try {
        const candidate = documentStoragePath(vehicleId, mimeType);
        const { error: uploadError } = await supabase.storage.from(DOCUMENTS_BUCKET).upload(candidate, buffer, {
          contentType: mimeType || 'application/octet-stream',
          upsert: false
        });
        if (!uploadError) storagePath = candidate;
      } catch { storagePath = null; }
    }
    const row = {
      vehicle_id: String(vehicleId),
      document_type: VEHICLE_DOCUMENT_TYPES.includes(documentType) ? documentType : 'other',
      storage_path: storagePath,
      original_filename: originalFilename ? String(originalFilename).slice(0, 200) : null,
      parsed_data: parsedData && typeof parsedData === 'object' ? parsedData : {},
      media_id: mediaId ? String(mediaId) : null,
      uploaded_by: profileId || null
    };
    let { data, error } = await supabase.from(VEHICLE_DOCUMENTS_TABLE).insert([row]).select('*').maybeSingle();
    if (error && mediaId && /duplicate|unique|23505/i.test(error.message || '')) {
      // A concurrent Meta retry won the race — return that row, keep one copy.
      const existing = await findVehicleDocumentByMediaId(supabase, mediaId);
      if (existing) return { ok: true, duplicate: true, document: existing, stored: Boolean(existing.storage_path) };
    }
    if (error) {
      // The row is the source of truth: never leave an orphan file behind.
      if (storagePath) {
        try {
          await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath]);
        } catch (cleanupErr) {
          console.warn('[vehicleDocuments] orphan cleanup skipped:', cleanupErr?.message || cleanupErr);
        }
      }
      return { ok: false, error: error.message };
    }
    markUserDataChanged({ supabase, ownerId: profileId || null, reason: 'vehicleDocuments.vault' });
    // v1.86.0 (Phase 25) — a renewal REPLACES the previous file of the same type
    // (the old row + object stay on file as evidence; rule 48).
    const superseded = await supersedePreviousDocuments({
      supabase,
      vehicleId,
      documentType: row.document_type,
      newId: (data || row)?.id || null
    });
    return {
      ok: true,
      duplicate: false,
      document: data || row,
      stored: Boolean(storagePath),
      replaced: superseded.replaced || 0,
      supersedeDegraded: superseded.degraded === true
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Newest-first stored documents, scoped by vehicle (or a vehicle-id list).
 * Never throws.
 *
 * v1.86.0 (Phase 25) — defaults to the CURRENT files only (a renewed insurance
 * certificate replaces the previous one). `currentOnly:false` returns the whole
 * history (dashboard "Show replaced"). On an un-migrated table the column is
 * missing, so the query retries WITHOUT the filter (rule 50) instead of
 * returning nothing.
 */
export async function listVehicleDocuments(providedSupabase, options = {}) {
  // v1.87.4 — tolerate the ONE-OBJECT call shape `{ supabase, vehicleId, … }`.
  // A caller once passed the whole bag as the client, so no scope reached the
  // query and the list answered [] silently (the vehicle page then rendered an
  // empty "Stored files" section). A real client always exposes `.from`; an
  // options bag never does, so this unwrap can never misfire.
  const isOptionsBag = providedSupabase
    && typeof providedSupabase === 'object'
    && providedSupabase.supabase
    && typeof providedSupabase.from !== 'function';
  const client = isOptionsBag ? providedSupabase.supabase : providedSupabase;
  const opts = isOptionsBag ? providedSupabase : (options || {});
  const { vehicleId = null, vehicleIds = [], limit = 20, currentOnly = true } = opts;
  const supabase = getClient(client);
  if (!supabase) return [];
  const ids = (vehicleIds || []).filter(Boolean);
  if (!vehicleId && !ids.length) return [];
  const cap = Math.max(1, Math.min(100, Number(limit) || 20));
  const run = async (withCurrentFilter) => {
    let query = supabase.from(VEHICLE_DOCUMENTS_TABLE).select('*').order('uploaded_at', { ascending: false }).limit(cap);
    query = vehicleId ? query.eq('vehicle_id', String(vehicleId)) : query.in('vehicle_id', ids);
    if (withCurrentFilter && currentOnly !== false) query = query.is('superseded_at', null);
    return query;
  };
  try {
    const { data, error } = await run(true);
    if (!error) return data || [];
    if (!/superseded_at|column .* does not exist|schema cache/i.test(error.message || '')) return [];
    const retry = await run(false);
    return retry.error ? [] : (retry.data || []);
  } catch {
    return [];
  }
}

/**
 * v1.86.0 (Phase 25) — mark every OTHER current document of the same vehicle +
 * document_type as superseded by `newId` (and drop its compliance link, so the
 * current file is unambiguous). The row and its stored object stay (rule 48).
 * Never throws; on an un-migrated schema it reports `degraded` and the upload
 * keeps today's behaviour.
 */
export async function supersedePreviousDocuments({
  supabase: providedSupabase,
  vehicleId = null,
  documentType = null,
  newId = null,
  now = new Date()
} = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !vehicleId || !documentType || !newId) return { ok: false, replaced: 0, degraded: false };
  try {
    const { data, error } = await supabase
      .from(VEHICLE_DOCUMENTS_TABLE)
      .select('id')
      .eq('vehicle_id', String(vehicleId))
      .eq('document_type', String(documentType))
      .is('superseded_at', null)
      .neq('id', String(newId))
      .limit(20);
    if (error) {
      return { ok: false, replaced: 0, degraded: /superseded_at|column .* does not exist|schema cache/i.test(error.message || '') };
    }
    const ids = (data || []).map((row) => row.id);
    if (!ids.length) return { ok: true, replaced: 0, degraded: false };
    const { error: updateError } = await supabase
      .from(VEHICLE_DOCUMENTS_TABLE)
      .update({ superseded_at: new Date(now).toISOString(), superseded_by: String(newId), compliance_id: null })
      .in('id', ids);
    if (updateError) return { ok: false, replaced: 0, degraded: false, error: updateError.message };
    return { ok: true, replaced: ids.length, replacedIds: ids, degraded: false };
  } catch (err) {
    return { ok: false, replaced: 0, degraded: false, error: err.message };
  }
}

/**
 * Delete ONE stored document (row + object) for its uploader or the owner of the
 * vehicle. Audits `VEHICLE_DOCUMENT_DELETED`. The compliance ledger and its
 * reminder stay untouched (the parsed data is the ledger's own fact).
 */
export async function deleteVehicleDocument({
  supabase: providedSupabase,
  documentId = null,
  ownerId = null,
  vehicleIds = [],
  senderPhone = null
} = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !documentId) return { ok: false, error: 'missing' };
  try {
    const { data: row } = await supabase.from(VEHICLE_DOCUMENTS_TABLE).select('*').eq('id', documentId).maybeSingle();
    if (!row) return { ok: false, error: 'not-found' };
    const ownsVehicle = Array.isArray(vehicleIds) && vehicleIds.includes(row.vehicle_id);
    const uploadedByMe = Boolean(ownerId) && row.uploaded_by === ownerId;
    if (!ownsVehicle && !uploadedByMe) return { ok: false, error: 'forbidden' };
    let objects = 0;
    if (row.storage_path) {
      try {
        const { error: storageError } = await supabase.storage.from(DOCUMENTS_BUCKET).remove([row.storage_path]);
        if (!storageError) objects = 1;
      } catch (storageErr) {
        console.warn('[vehicleDocuments] storage remove skipped:', storageErr?.message || storageErr);
      }
    }
    const { error } = await supabase.from(VEHICLE_DOCUMENTS_TABLE).delete().eq('id', documentId);
    if (error) return { ok: false, error: error.message };
    markUserDataChanged({ supabase, ownerId: row.uploaded_by || ownerId || null, reason: 'vehicleDocuments.delete' });
    try {
      await supabase.from('admin_audit_logs').insert([{
        admin_phone: senderPhone || 'SYSTEM',
        action: 'VEHICLE_DOCUMENT_DELETED',
        details: {
          document_id: row.id,
          vehicle_id: row.vehicle_id || null,
          document_type: row.document_type || null,
          media_id: row.media_id || null,
          objects
        }
      }]);
    } catch (auditErr) {
      console.warn('[vehicleDocuments] delete audit skipped:', auditErr?.message || auditErr);
    }
    return { ok: true, document: row, objects };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Point one document row at the compliance row it proves. Never throws. */
export async function linkDocumentToCompliance({ supabase: providedSupabase, documentId = null, complianceId = null } = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !documentId || !complianceId) return { ok: false, error: 'missing' };
  try {
    const { error } = await supabase.from(VEHICLE_DOCUMENTS_TABLE).update({ compliance_id: complianceId }).eq('id', documentId);
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * The newest UNLINKED document for a vehicle that can prove this compliance
 * type (deterministic: newest first inside DOCUMENT_LINK_WINDOW_HOURS).
 * v1.86.0 — a superseded (replaced) file can never prove the current document.
 */
export async function findPendingDocument({
  supabase: providedSupabase,
  vehicleId = null,
  complianceType = null,
  windowHours = DOCUMENT_LINK_WINDOW_HOURS
} = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !vehicleId || !complianceType) return null;
  try {
    const hours = Math.max(1, Math.min(168, Number(windowHours) || DOCUMENT_LINK_WINDOW_HOURS));
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const read = async (withSupersede) => {
      const columns = withSupersede
        ? 'id,vehicle_id,document_type,compliance_id,uploaded_at,superseded_at'
        : 'id,vehicle_id,document_type,compliance_id,uploaded_at';
      return supabase
        .from(VEHICLE_DOCUMENTS_TABLE)
        .select(columns)
        .eq('vehicle_id', String(vehicleId))
        .gte('uploaded_at', cutoff)
        .order('uploaded_at', { ascending: false })
        .limit(20);
    };
    let { data, error } = await read(true);
    if (error && /superseded_at|column .* does not exist|schema cache/i.test(error.message || '')) {
      ({ data } = await read(false));
      error = null;
    }
    if (error) return null;
    return (data || []).find((row) => !row.compliance_id && !row.superseded_at && complianceTypeForDocumentType(row.document_type) === complianceType) || null;
  } catch {
    return null;
  }
}

/**
 * After a compliance row was saved (four engine call sites), link the document
 * that proved it. The explicit `documentId` (carried through the engine-only
 * prefill seam) always wins; the deterministic vehicle+type match is the
 * fallback. Never throws — a missing table simply links nothing.
 */
export async function linkSavedComplianceDocument({
  supabase: providedSupabase,
  vehicleId = null,
  complianceType = null,
  documentId = null
} = {}) {
  const supabase = getClient(providedSupabase);
  if (!supabase || !vehicleId || !complianceType) return { ok: false, error: 'missing' };
  try {
    let target = null;
    if (documentId) {
      const { data } = await supabase.from(VEHICLE_DOCUMENTS_TABLE).select('*').eq('id', documentId).maybeSingle();
      if (data && data.vehicle_id === vehicleId) target = data;
    }
    if (!target) target = await findPendingDocument({ supabase, vehicleId, complianceType });
    if (!target) return { ok: true, linked: false, reason: 'no-document' };
    const { data: compliance } = await supabase
      .from('vehicle_compliances')
      .select('id')
      .eq('vehicle_id', vehicleId)
      .eq('type', complianceType)
      .maybeSingle();
    if (!compliance?.id) return { ok: true, linked: false, reason: 'no-compliance' };
    const linked = await linkDocumentToCompliance({ supabase, documentId: target.id, complianceId: compliance.id });
    return linked.ok
      ? { ok: true, linked: true, documentId: target.id, complianceId: compliance.id }
      : { ok: false, error: linked.error };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatWhen(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Deterministic "documents" reply (zero tokens), mirroring the receipts list.
 * v1.86.0 (Phase 25) — when a renewal replaced an earlier file of the same
 * document type, the row says so (the old certificate is kept in the history).
 */
export function formatVehicleDocumentsReply({ documents = [], vehicles = [], hasMore = false, replacedCounts = null } = {}) {
  if (!Array.isArray(documents) || documents.length === 0) {
    return '📄 No stored documents yet.\n\n'
      + 'Send a photo or PDF of your logbook, insurance certificate, inspection certificate or road licence and I will read it AND keep the original file for you.';
  }
  const lines = documents.slice(0, 5).map((doc) => {
    const vehicle = (vehicles || []).find((row) => row.id === doc.vehicle_id);
    const label = documentTypeLabel(doc.document_type);
    const bits = [vehicle?.plate_number || null, formatWhen(doc.uploaded_at)].filter(Boolean);
    const fileNote = doc.storage_path ? '' : ' · parsed only (Free plan)';
    const key = `${doc.vehicle_id}|${doc.document_type}`;
    const replaced = replacedCounts && Number(replacedCounts[key]) > 0
      ? ` · replaces ${Number(replacedCounts[key])} earlier file${Number(replacedCounts[key]) === 1 ? '' : 's'}`
      : '';
    return `• 📄 *${label}* — ${bits.join(' · ')}${fileNote}${replaced}`;
  });
  const footer = 'Open or download them from your dashboard — reply *dashboard*. '
    + 'Delete one: *delete document N* (1 = newest; add DELETE to confirm) — the compliance dates stay saved.'
    + (hasMore ? '\n\nThat is the newest 5 — older files stay stored and appear on the dashboard.' : '');
  return `📄 *Your stored documents*\n\n${lines.join('\n')}\n\n${footer}`;
}

/**
 * v1.86.0 (Phase 25) — how many REPLACED files sit behind each current one
 * (`vehicleId|document_type` -> count). Best-effort: an un-migrated table or a
 * read error returns an empty map (the list simply omits the note).
 */
export async function countSupersededDocuments(providedSupabase, { vehicleIds = [] } = {}) {
  const supabase = getClient(providedSupabase);
  const ids = (vehicleIds || []).filter(Boolean);
  if (!supabase || !ids.length) return {};
  try {
    const { data, error } = await supabase
      .from(VEHICLE_DOCUMENTS_TABLE)
      .select('vehicle_id,document_type')
      .in('vehicle_id', ids)
      .not('superseded_at', 'is', null)
      .limit(200);
    if (error) return {};
    const counts = {};
    for (const row of data || []) {
      const key = `${row.vehicle_id}|${row.document_type}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

export default {
  VEHICLE_DOCUMENTS_TABLE,
  DOCUMENTS_BUCKET,
  VEHICLE_DOCUMENT_TYPES,
  DOCUMENT_TYPE_BY_FAMILY,
  COMPLIANCE_TYPE_BY_DOCUMENT_TYPE,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_LINK_WINDOW_HOURS,
  VEHICLE_DOCUMENTS_SQL,
  VEHICLE_DOCUMENTS_SUPERSEDE_SQL,
  documentTypeForFamily,
  isVaultableDocumentFamily,
  complianceTypeForDocumentType,
  documentTypeLabel,
  documentStorageExtension,
  documentStoragePath,
  ensureVehicleDocumentsTable,
  ensureSupersedeColumns,
  findVehicleDocumentByMediaId,
  vaultVehicleDocument,
  listVehicleDocuments,
  supersedePreviousDocuments,
  countSupersededDocuments,
  deleteVehicleDocument,
  linkDocumentToCompliance,
  findPendingDocument,
  linkSavedComplianceDocument,
  formatVehicleDocumentsReply
};
