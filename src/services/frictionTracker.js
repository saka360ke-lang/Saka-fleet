/**
 * Saka Fleet - Friction-point tracker (v1.56.4)
 * ---------------------------------------------
 * Every friction point Cline or Sentinel flags is tracked here with a
 * PENDING -> DEPLOYED lifecycle. A deployed point auto-clears from the active
 * list after FRICTION_CLEARED_AFTER_HOURS but is NEVER deleted - the
 * chat_friction_logs rows are the permanent log.
 */

export const FRICTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  DEPLOYED: 'DEPLOYED'
});

export const FRICTION_CLEARED_AFTER_HOURS = 4;

export const FRICTION_TRACKER_SQL = `
  ALTER TABLE public.chat_friction_logs
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS resolved_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS resolution text;
  CREATE INDEX IF NOT EXISTS idx_friction_logs_status
    ON public.chat_friction_logs(status, detected_at DESC);
`;

export function normalizeFrictionPhone(phone) {
  const clean = String(phone || '').replace(/[^\d]/g, '');
  if (!clean) return String(phone || '');
  return `+${clean}`;
}

export function isFrictionDeployedCleared(row, now = new Date()) {
  if (!row || row.status !== FRICTION_STATUS.DEPLOYED) return false;
  const at = row && row.resolved_at ? Date.parse(row.resolved_at) : NaN;
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at > FRICTION_CLEARED_AFTER_HOURS * 60 * 60 * 1000;
}

export function activeFrictionOf(rows, now = new Date()) {
  return (rows || []).filter((r) => r.status !== FRICTION_STATUS.DEPLOYED || !isFrictionDeployedCleared(r, now));
}

/** Resolve a short id prefix (or full uuid) to a real chat_friction_logs id. */
export async function resolveFrictionId(supabase, id) {
  const raw = String(id || "").trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw)) return raw;
  const { data } = await supabase.from("chat_friction_logs").select("id").order("detected_at", { ascending: false }).limit(200);
  const hit = (data || []).find((r) => String(r.id).toLowerCase().startsWith(raw.toLowerCase()));
  return hit ? hit.id : null;
}

export async function markFrictionDeployed(supabase, id, resolution = '') {
  if (!supabase || !id) return { ok: false, reason: 'missing id/supabase' };
  try {
    const { error } = await supabase.from('chat_friction_logs').update({
      status: FRICTION_STATUS.DEPLOYED,
      resolved_at: new Date().toISOString(),
      resolution: String(resolution || '').slice(0, 200)
    }).eq('id', (await resolveFrictionId(supabase, id)) || id);
    return error ? { ok: false, reason: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function markFrictionPending(supabase, id) {
  if (!supabase || !id) return { ok: false, reason: 'missing id/supabase' };
  try {
    const { error } = await supabase.from('chat_friction_logs').update({
      status: FRICTION_STATUS.PENDING,
      resolved_at: null
    }).eq('id', (await resolveFrictionId(supabase, id)) || id);
    return error ? { ok: false, reason: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function listFrictionLog(supabase, limit = 60) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from('chat_friction_logs')
      .select('id,user_phone,friction_type,transcript_snippet,detected_at,status,resolved_at,resolution')
      .order('detected_at', { ascending: false })
      .limit(limit);
    return error || !data ? [] : data;
  } catch {
    return [];
  }
}
function renderFrictionLine(r) {
  const icon = r.status === FRICTION_STATUS.DEPLOYED ? '\u2705' : '\u23f3';
  const id = String(r.id || '').slice(0, 8);
  const phone = String(r.user_phone || 'unknown');
  return icon + ' `' + id + '` ' + (r.friction_type || 'UNKNOWN') + ' - ' + phone;
}

export function formatFrictionReply(rows, filter = 'active', now = new Date()) {
  const all = rows || [];
  const pending = all.filter((r) => r.status !== FRICTION_STATUS.DEPLOYED);
  const deployedActive = all.filter((r) => r.status === FRICTION_STATUS.DEPLOYED && !isFrictionDeployedCleared(r, now));

  let list;
  let header;
  if (filter === 'pending') { list = pending; header = '\u23f3 *Pending friction*'; }
  else if (filter === 'deployed') { list = deployedActive; header = '\u2705 *Recently deployed friction*'; }
  else if (filter === 'log') { list = all; header = '\ud83d\uddc2\ufe0f *Friction log (persistent)*'; }
  else { list = pending.concat(deployedActive); header = '\ud83d\udee0\ufe0f *Friction points*'; }

  if (!list.length) return header + '\n\n- none';

  const lines = list.slice(0, 20).map(renderFrictionLine);
  const note = filter === 'log'
    ? '\n\n_Log rows are never deleted._'
    : '\n\n_Mark fixed:_ `admin friction done <id>`\n_Deployed auto-clears after ' + FRICTION_CLEARED_AFTER_HOURS + ' h; the log keeps it._';
  return header + '\n\n' + lines.join('\n') + note;
}

export default {
  FRICTION_STATUS,
  FRICTION_CLEARED_AFTER_HOURS,
  FRICTION_TRACKER_SQL,
  normalizeFrictionPhone,
  isFrictionDeployedCleared,
  activeFrictionOf,
  markFrictionDeployed,
  markFrictionPending,
  listFrictionLog,
  resolveFrictionId,
  formatFrictionReply
};