/**
 * Saka Fleet - Incident Registry (v1.23.3)
 * ---------------------------------------
 * One row per backend issue signature. Sentinel opens incidents, superadmins
 * resolve or suppress them, and silenced signatures are never alerted again
 * (a resolved issue re-opens only after INCIDENT_REOPEN_THRESHOLD recurrences).
 *
 * Deterministic, never throws on read paths.
 */

export const INCIDENT_STATUS = Object.freeze({
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
  SUPPRESSED: 'suppressed'
});

export const INCIDENT_REOPEN_THRESHOLD = (() => {
  const raw = Number(process.env.INCIDENT_REOPEN_THRESHOLD || 3);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

/** Same normalization as remediation.buildSignature (kept in sync deliberately). */
export function buildIncidentSignature(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/[^a-z<>_ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'unspecified';
}

export function severityForCategory(category = 'other') {
  const clean = String(category || '').toLowerCase();
  if (clean.includes('error')) return 'high';
  if (clean.includes('stall') || clean.includes('looping') || clean.includes('frustration')) return 'medium';
  return 'low';
}

const nowIso = () => new Date().toISOString();

/** Open a new incident or update an existing one. Returns lifecycle flags. */
export async function upsertIncident(providedSupabase, { signature, category = 'other', message = null, source = null } = {}) {
  if (!providedSupabase || !signature) return { ok: false, created: false, silenced: false, reopened: false };
  try {
    const existing = await providedSupabase
      .from('backend_incidents')
      .select('id,status,occurrence_count,recurrences_since_resolution')
      .eq('signature', signature)
      .maybeSingle();
    if (existing.error) return { ok: false, created: false, error: existing.error.message };

    if (!existing.data) {
      const insert = await providedSupabase.from('backend_incidents').insert([{
        signature,
        category,
        severity: severityForCategory(category),
        status: INCIDENT_STATUS.OPEN,
        message: message ? String(message).slice(0, 600) : null,
        source,
        occurrence_count: 1,
        recurrences_since_resolution: 0,
        first_seen_at: nowIso(),
        last_seen_at: nowIso()
      }]);
      if (insert.error) return { ok: false, created: false, error: insert.error.message };
      return { ok: true, created: true, silenced: false, reopened: false };
    }

    const row = existing.data;
    const silenced = row.status === INCIDENT_STATUS.RESOLVED || row.status === INCIDENT_STATUS.SUPPRESSED;
    const recurrences = Number(row.recurrences_since_resolution || 0) + (silenced ? 1 : 0);
    const shouldReopen = silenced && recurrences >= INCIDENT_REOPEN_THRESHOLD;
    const patch = {
      last_seen_at: nowIso(),
      occurrence_count: Number(row.occurrence_count || 0) + 1,
      recurrences_since_resolution: shouldReopen ? 0 : recurrences,
      message: message ? String(message).slice(0, 600) : undefined
    };
    if (shouldReopen) {
      patch.status = INCIDENT_STATUS.OPEN;
      patch.reopened_at = nowIso();
      patch.resolved_at = null;
    }
    await providedSupabase.from('backend_incidents').update(patch).eq('id', row.id);
    return { ok: true, created: false, silenced: silenced && !shouldReopen, reopened: shouldReopen };
  } catch (err) {
    return { ok: false, created: false, error: err.message };
  }
}

/** True when alerts for this signature must stay quiet. */
export async function isIncidentSilenced(providedSupabase, signature) {
  if (!providedSupabase || !signature) return false;
  try {
    const { data } = await providedSupabase
      .from('backend_incidents')
      .select('status')
      .eq('signature', signature)
      .maybeSingle();
    return data?.status === INCIDENT_STATUS.RESOLVED || data?.status === INCIDENT_STATUS.SUPPRESSED;
  } catch { return false; }
}

export async function countOpenIncidents(providedSupabase) {
  if (!providedSupabase) return 0;
  try {
    const { count } = await providedSupabase
      .from('backend_incidents')
      .select('id', { count: 'exact', head: true })
      .eq('status', INCIDENT_STATUS.OPEN);
    return count || 0;
  } catch { return 0; }
}

export async function listIncidents(providedSupabase, { status = INCIDENT_STATUS.OPEN, limit = 10 } = {}) {
  if (!providedSupabase) return { ok: false, rows: [], error: 'No database client' };
  try {
    const { data, error } = await providedSupabase
      .from('backend_incidents')
      .select('id,signature,category,severity,status,occurrence_count,first_seen_at,last_seen_at,message')
      .eq('status', status)
      .order('last_seen_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 10, 1), 30));
    if (error) return { ok: false, rows: [], error: error.message };
    return { ok: true, rows: data || [], error: null };
  } catch (err) {
    return { ok: false, rows: [], error: err.message };
  }
}

export async function resolveIncident(providedSupabase, id, { note = null, version = null, adminPhone = 'SUPERADMIN', audit = null } = {}) {
  return setIncidentStatus(providedSupabase, id, INCIDENT_STATUS.RESOLVED, { note, version, adminPhone, audit });
}

export async function suppressIncident(providedSupabase, id, { note = null, adminPhone = 'SUPERADMIN', audit = null } = {}) {
  return setIncidentStatus(providedSupabase, id, INCIDENT_STATUS.SUPPRESSED, { note, adminPhone, audit, version: null });
}

async function setIncidentStatus(providedSupabase, id, status, { note, version, adminPhone, audit }) {
  if (!providedSupabase || !id) return { ok: false, error: 'Missing incident id' };
  try {
    const existing = await providedSupabase.from('backend_incidents').select('id,signature,status').eq('id', id).maybeSingle();
    if (existing.error) return { ok: false, error: existing.error.message };
    if (!existing.data) return { ok: false, error: 'Incident not found' };
    const patch = {
      status,
      resolved_at: status === INCIDENT_STATUS.RESOLVED ? nowIso() : null,
      resolution_note: note || null,
      fixed_in_version: version || null,
      resolved_by: adminPhone || null,
      recurrences_since_resolution: 0,
      updated_at: nowIso()
    };
    const update = await providedSupabase.from('backend_incidents').update(patch).eq('id', id);
    if (update.error) return { ok: false, error: update.error.message };
    if (typeof audit === 'function') {
      await audit(adminPhone, status === INCIDENT_STATUS.RESOLVED ? 'ADMIN_INCIDENT_RESOLVE' : 'ADMIN_INCIDENT_SUPPRESS', { incident_id: id, signature: existing.data.signature, note: note || null, version: version || null });
    }
    return { ok: true, incident: { ...existing.data, ...patch } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const SEVERITY_CHIP = { high: '🔴', medium: '🟡', low: '🟢' };

export function formatIncidentsReply(rows = []) {
  if (!rows.length) return '✅ No open backend issues. Everything we are tracking has been resolved or suppressed.';
  const lines = rows.slice(0, 8).map((row, index) => {
    const chip = SEVERITY_CHIP[row.severity] || '🟡';
    const sample = String(row.message || row.signature || '').slice(0, 90);
    return (index + 1) + '. ' + chip + ' *' + row.category + '* - seen ' + row.occurrence_count + 'x\n   (' + row.id + ')\n   ' + sample;
  });
  return '🛠️ *Open backend issues (' + rows.length + ')*\n\n' + lines.join('\n') + '\n\nReply *admin incident resolve <id>* once fixed, or *admin incident suppress <id>* for expected noise.';
}

export function formatIncidentResolvedReply({ status = 'resolved', signature = '' } = {}) {
  return status === 'suppressed'
    ? `🔇 Suppressed: ${String(signature).slice(0, 80)}\n\nThis signature will stay quiet until it recurs repeatedly.`
    : `✅ Marked resolved: ${String(signature).slice(0, 80)}\n\nIt will not be raised again unless it recurs ${INCIDENT_REOPEN_THRESHOLD}x after the fix.`;
}

export default {
  INCIDENT_STATUS,
  INCIDENT_REOPEN_THRESHOLD,
  buildIncidentSignature,
  severityForCategory,
  upsertIncident,
  isIncidentSilenced,
  countOpenIncidents,
  listIncidents,
  resolveIncident,
  suppressIncident,
  formatIncidentsReply,
  formatIncidentResolvedReply
};