/**
 * Saka Fleet - Customer Care Console (v1.58.18)
 * ---------------------------------------------
 * The care worker's inbox inside WhatsApp. Resend inbound mail at
 * support@reports.sakafleet.com becomes a tracked ticket (status, priority,
 * category, thread) and the worker can read, reply, escalate, de-escalate,
 * close, reopen and search it with deterministic `care ...` commands.
 *
 * Boundaries (permanent): this module only touches support_tickets,
 * support_ticket_messages and admin_audit_logs. It never edits the ledger,
 * VIN, billing or vehicle data, never promises refunds and never invents
 * prices. Every state change is audited as CARE_TICKET_*.
 *
 * Env: CUSTOMER_CARE_PHONE (worker role, off by default),
 *      CUSTOMER_CARE_NAME (reply signature), CARE_THREAD_WINDOW_HOURS (168),
 *      CARE_TICKET_MAX_OPEN (200).
 */
import { runSql, hasSqlAccess } from '../db/sqlRunner.js';
import { classifyCareRequest } from './customerCare.js';

export const CARE_TICKETS_TABLE = 'support_tickets';
export const CARE_MESSAGES_TABLE = 'support_ticket_messages';
export const CARE_AUDIT_TABLE = 'admin_audit_logs';

export const CARE_STATUS = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED'
});
export const CARE_PRIORITY = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' });

export const CARE_THREAD_WINDOW_HOURS = Math.max(1, Number(process.env.CARE_THREAD_WINDOW_HOURS || 168));
export const CARE_TICKET_MAX_OPEN = Math.max(10, Number(process.env.CARE_TICKET_MAX_OPEN || 200));

export const CARE_SQL = `
    ALTER TABLE public.support_tickets
        ADD COLUMN IF NOT EXISTS status text DEFAULT 'OPEN',
        ADD COLUMN IF NOT EXISTS priority text DEFAULT 'medium',
        ADD COLUMN IF NOT EXISTS source text DEFAULT 'whatsapp',
        ADD COLUMN IF NOT EXISTS sender_email text,
        ADD COLUMN IF NOT EXISTS subject text,
        ADD COLUMN IF NOT EXISTS assigned_to text,
        ADD COLUMN IF NOT EXISTS internal_note text,
        ADD COLUMN IF NOT EXISTS thread_key text,
        ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status
        ON public.support_tickets(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_thread
        ON public.support_tickets(thread_key);
    CREATE TABLE IF NOT EXISTS public.support_ticket_messages (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        ticket_id uuid,
        direction text,
        channel text,
        message_body text,
        created_at timestamp with time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket
        ON public.support_ticket_messages(ticket_id, created_at ASC);
`;

/** Ensure the console columns/table exist (fail-soft; DDL needs a SQL transport). */
export async function ensureCareConsoleTables(supabase) {
  if (!supabase) return { ok: false, status: 'no-client' };
  try {
    const { error } = await supabase.from(CARE_TICKETS_TABLE).select('status').limit(1);
    if (!error) return { ok: true, status: 'exists' };
    if (!/column|does not exist|schema cache/i.test(error.message || '')) {
      return { ok: false, status: 'error', error: error.message };
    }
    if (!hasSqlAccess()) return { ok: false, status: 'missing-transport' };
    const result = await runSql(CARE_SQL, { label: 'ensureCareConsoleTables' });
    return { ok: result.ok, status: result.ok ? 'created' : 'error', error: result.error || null };
  } catch (err) {
    return { ok: false, status: 'error', error: err.message };
  }
}

/** Deterministic email thread key: sender + normalized subject stem. */
export function normalizeThreadKey({ senderEmail = null, subject = null } = {}) {
  const sender = String(senderEmail || '').trim().toLowerCase();
  const stem = String(subject || '')
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/gi, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9@._\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 120);
  return (sender ? sender + '|' : '') + (stem || 'no-subject');
}

/** The care role is OFF until CUSTOMER_CARE_PHONE is configured. */
export function isCareWorker(phone) {
  const configured = String(process.env.CUSTOMER_CARE_PHONE || '').replace(/\D/g, '');
  const clean = String(phone || '').replace(/\D/g, '');
  return Boolean(configured) && configured === clean;
}

/** Returns the tail of a `care ...` command, or null when it is not one. */
export function careCommandOf(text = '') {
  const m = String(text || '').trim().match(/^care(?:\s+([\s\S]*))?$/i);
  return m ? String(m[1] || '').trim() : null;
}

/** Audit every care action (never throws, never blocks the reply). */
export async function auditCareAction(supabase, { phone, action, details = {} } = {}) {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from(CARE_AUDIT_TABLE).insert([{
      admin_phone: String(phone || 'CARE_WORKER'),
      action: String(action || 'CARE_TICKET_ACTION').slice(0, 80),
      details: JSON.stringify(details).slice(0, 2000),
      created_at: new Date().toISOString()
    }]);
    return !error;
  } catch {
    return false;
  }
}

const nowIso = () => new Date().toISOString();

/** Append one message to a ticket thread (never throws). */
export async function appendTicketMessage(supabase, { ticketId, direction = 'in', channel = 'email', body = '' } = {}) {
  if (!supabase || !ticketId) return { ok: false };
  try {
    const { error } = await supabase.from(CARE_MESSAGES_TABLE).insert([{
      ticket_id: ticketId,
      direction: String(direction || 'in').slice(0, 12),
      channel: String(channel || 'email').slice(0, 24),
      message_body: String(body || '').slice(0, 4000),
      created_at: nowIso()
    }]);
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

/** The open ticket for this email thread inside the window, or null. */
export async function findOpenTicketByThread(supabase, threadKey, windowHours = CARE_THREAD_WINDOW_HOURS) {
  if (!supabase || !threadKey) return null;
  try {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from(CARE_TICKETS_TABLE)
      .select('*')
      .eq('thread_key', threadKey)
      .in('status', [CARE_STATUS.OPEN, CARE_STATUS.IN_PROGRESS])
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) return null;
    return (data && data[0]) || null;
  } catch {
    return null;
  }
}

/**
 * Inbound email -> tracked ticket. Classifies, threads follow-ups into the open
 * ticket, and falls back to the legacy slim insert on pre-migration schemas.
 */
export async function openOrAppendEmailTicket(supabase, { fromEmail, subject, text } = {}) {
  const sender = String(fromEmail || '').trim().toLowerCase();
  const cleanSubject = String(subject || '(no subject)').slice(0, 500);
  const bodyText = String(text || cleanSubject).slice(0, 4000);
  const { category, priority } = classifyCareRequest(cleanSubject + ' ' + bodyText);
  const threadKey = normalizeThreadKey({ senderEmail: sender, subject: cleanSubject });

  const existing = await findOpenTicketByThread(supabase, threadKey);
  if (existing) {
    await appendTicketMessage(supabase, { ticketId: existing.id, direction: 'in', channel: 'email', body: bodyText });
    const bump = { updated_at: nowIso() };
    if (priority === CARE_PRIORITY.HIGH && existing.priority !== CARE_PRIORITY.HIGH) bump.priority = CARE_PRIORITY.HIGH;
    try { await supabase.from(CARE_TICKETS_TABLE).update(bump).eq('id', existing.id); } catch { /* best effort */ }
    return {
      ok: true,
      ticketId: existing.id,
      created: false,
      category: existing.issue_category || category,
      priority: bump.priority || existing.priority || priority,
      threadKey
    };
  }

  const now = nowIso();
  const ticket = {
    whatsapp_number: sender,
    issue_category: category,
    message_body: bodyText.slice(0, 2000),
    subject: cleanSubject,
    status: CARE_STATUS.OPEN,
    priority,
    source: 'email',
    sender_email: sender,
    thread_key: threadKey,
    updated_at: now,
    created_at: now
  };
  let ticketId = null;
  try {
    let { data, error } = await supabase.from(CARE_TICKETS_TABLE).insert([ticket]).select('id').maybeSingle();
    if (error && /too long|character varying/i.test(error.message || '')) {
      ({ data, error } = await supabase.from(CARE_TICKETS_TABLE).insert([{ ...ticket, whatsapp_number: sender.slice(0, 20) }]).select('id').maybeSingle());
    }
    if (error && /column|schema cache/i.test(error.message || '')) {
      ({ data } = await supabase.from(CARE_TICKETS_TABLE).insert([{
        whatsapp_number: sender.slice(0, 20),
        issue_category: category,
        message_body: bodyText.slice(0, 2000),
        created_at: now
      }]).select('id').maybeSingle());
    }
    ticketId = data ? data.id : null;
  } catch {
    ticketId = null;
  }
  if (ticketId) await appendTicketMessage(supabase, { ticketId, direction: 'in', channel: 'email', body: bodyText });
  return { ok: Boolean(ticketId), ticketId, created: true, category, priority, threadKey };
}

/** Resolve a short id prefix (or full uuid) to a real ticket id. */
export async function resolveCareTicketId(supabase, id) {
  const raw = String(id || '').trim().replace(/`/g, '');
  if (!raw) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw;
  try {
    const { data } = await supabase.from(CARE_TICKETS_TABLE).select('id').order('created_at', { ascending: false }).limit(100);
    const hit = (data || []).find((r) => String(r.id).toLowerCase().startsWith(raw.toLowerCase()));
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

/** One ticket plus its thread (never throws). */
export async function getCareTicket(supabase, id) {
  if (!supabase) return null;
  const realId = await resolveCareTicketId(supabase, id);
  if (!realId) return null;
  try {
    const { data } = await supabase.from(CARE_TICKETS_TABLE).select('*').eq('id', realId).maybeSingle();
    if (!data) return null;
    let messages = [];
    try {
      const res = await supabase.from(CARE_MESSAGES_TABLE).select('*').eq('ticket_id', realId).order('created_at', { ascending: true }).limit(50);
      messages = (res && res.data) || [];
    } catch { messages = []; }
    return { ...data, messages };
  } catch {
    return null;
  }
}

/** List tickets (open | high | all). Falls back to the legacy shape pre-migration. */
export async function listCareTickets(supabase, { filter = 'open', limit = 10 } = {}) {
  if (!supabase) return [];
  const max = Math.min(Math.max(Number(limit) || 10, 1), 20);
  try {
    let query = supabase.from(CARE_TICKETS_TABLE).select('*');
    if (filter === 'high') query = query.eq('priority', CARE_PRIORITY.HIGH).in('status', [CARE_STATUS.OPEN, CARE_STATUS.IN_PROGRESS]);
    else if (filter === 'open') query = query.in('status', [CARE_STATUS.OPEN, CARE_STATUS.IN_PROGRESS]);
    query = query.order('updated_at', { ascending: false }).limit(max);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data || [];
  } catch {
    try {
      const { data } = await supabase.from(CARE_TICKETS_TABLE).select('id, whatsapp_number, issue_category, message_body, created_at').eq('issue_category', 'email').order('created_at', { ascending: false }).limit(max);
      return data || [];
    } catch {
      return [];
    }
  }
}

/** Whitelisted ticket updates only (status, priority, assignment, note). */
export async function updateCareTicket(supabase, id, patch = {}) {
  const allowed = {};
  for (const key of ['status', 'priority', 'assigned_to', 'internal_note', 'updated_at']) {
    if (patch[key] !== undefined) allowed[key] = patch[key];
  }
  if (!Object.keys(allowed).length) return { ok: false, error: 'nothing-to-update' };
  try {
    const realId = await resolveCareTicketId(supabase, id);
    if (!realId) return { ok: false, error: 'not-found' };
    const { error } = await supabase.from(CARE_TICKETS_TABLE).update(allowed).eq('id', realId);
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: realId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Deterministic inbox counters (zero tokens). */
export async function careStats(supabase) {
  const rows = await listCareTickets(supabase, { filter: 'all', limit: Math.min(CARE_TICKET_MAX_OPEN, 200) });
  const out = { total: rows.length, open: 0, inProgress: 0, high: 0, resolved: 0, closed: 0 };
  for (const row of rows) {
    const status = String(row.status || CARE_STATUS.OPEN).toUpperCase();
    if (status === CARE_STATUS.OPEN) out.open += 1;
    else if (status === CARE_STATUS.IN_PROGRESS) out.inProgress += 1;
    else if (status === CARE_STATUS.RESOLVED) out.resolved += 1;
    else if (status === CARE_STATUS.CLOSED) out.closed += 1;
    if (String(row.priority || '').toLowerCase() === CARE_PRIORITY.HIGH) out.high += 1;
  }
  return out;
}

const STATUS_CHIP = { OPEN: '🔵', IN_PROGRESS: '🟡', RESOLVED: '🟢', CLOSED: '⚪' };
const PRIORITY_CHIP = { high: '❗', medium: '', low: '' };

function statusChip(status) {
  return STATUS_CHIP[String(status || CARE_STATUS.OPEN).toUpperCase()] || '🔵';
}
function priorityChip(priority) {
  return PRIORITY_CHIP[String(priority || CARE_PRIORITY.MEDIUM).toLowerCase()] || '';
}
function shortId(id) {
  return String(id || '').slice(0, 8);
}
function clip(value, max = 90) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function ageOf(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '—';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return mins + 'm';
  const hours = Math.round(mins / 60);
  if (hours < 48) return hours + 'h';
  return Math.round(hours / 24) + 'd';
}
function contactOf(ticket) {
  return ticket.sender_email || (String(ticket.whatsapp_number || '').includes('@') ? ticket.whatsapp_number : (ticket.whatsapp_number || 'unknown'));
}

/** Deterministic command help (zero tokens). */
export function formatCareHelp() {
  return '🩺 *Care console*\n\n' +
    '*Inbox*\n' +
    '• `care inbox` — open tickets\n' +
    '• `care inbox high` — high priority only\n' +
    '• `care inbox all` — everything\n\n' +
    '*One ticket*\n' +
    '• `care read <id>`\n' +
    '• `care reply <id> <text>` — sends on WhatsApp and email\n' +
    '• `care email <id> <text>` — email only\n' +
    '• `care note <id> <text>` — internal note\n' +
    '• `care take <id>` / `care release <id>`\n\n' +
    '*Lifecycle*\n' +
    '• `care escalate <id>` / `care deescalate <id>`\n' +
    '• `care close <id>` / `care reopen <id>`\n\n' +
    '*Other*\n' +
    '• `care search <word>`\n' +
    '• `care stats`\n' +
    '• `care audit`\n\n' +
    '_You can read and reply to tickets only. Ledger, VIN, billing and refunds stay with the superadmin — never promise money or invent prices._';
}

/** Deterministic inbox list. */
export function formatCareInbox(rows, filter = 'open') {
  if (!rows || !rows.length) return '🩺 *Care inbox* — 0 ' + filter + ' tickets.\n\n_Nothing waiting. `care inbox all` shows history._';
  const lines = rows.slice(0, 10).map((r, i) => {
    const chip = statusChip(r.status) + priorityChip(r.priority);
    const category = r.issue_category ? ' · ' + r.issue_category : '';
    return (i + 1) + '. `' + shortId(r.id) + '` ' + chip + category + ' · ' + contactOf(r) + '\n   ' + clip(r.message_body || r.subject || '(no body)', 70) + ' · ' + ageOf(r.updated_at || r.created_at);
  });
  return '🩺 *Care inbox* — ' + rows.length + ' ' + filter + ' ticket' + (rows.length === 1 ? '' : 's') + '\n\n' + lines.join('\n') + '\n\n_care read <id> · care help_';
}

/** One ticket with its full thread. */
export function formatCareTicket(ticket) {
  if (!ticket) return 'That ticket was not found. Try `care inbox`.';
  const header = '*' + statusChip(ticket.status) + ' ' + String(ticket.status || 'OPEN').toUpperCase() + '* · ' +
    (ticket.priority ? String(ticket.priority).toUpperCase() : 'MEDIUM') + (priorityChip(ticket.priority) ? ' ' + priorityChip(ticket.priority) : '') +
    ' · ' + (ticket.issue_category || 'other') + ' · ' + (ticket.source || 'whatsapp');
  const meta = '👤 ' + contactOf(ticket) + (ticket.assigned_to ? '\n🙋 assigned: ' + ticket.assigned_to : '') +
    '\n🕒 updated ' + ageOf(ticket.updated_at || ticket.created_at);
  const thread = (ticket.messages || []).slice(-8).map((m) => {
    const who = m.direction === 'out' ? '🤖 care' : (m.direction === 'internal' ? '📝 note' : '👤 user');
    return who + ' (' + (m.channel || 'email') + ', ' + ageOf(m.created_at) + '): ' + clip(m.message_body, 260);
  });
  const note = ticket.internal_note ? '\n\n📝 *Note:* ' + clip(ticket.internal_note, 300) : '';
  return '*Ticket `' + shortId(ticket.id) + '`*\n' + header + '\n' + meta + note +
    '\n\n*Thread*\n' + (thread.length ? thread.join('\n') : '_No messages yet._') +
    '\n\n_care reply ' + shortId(ticket.id) + ' <text> · care escalate ' + shortId(ticket.id) + ' · care close ' + shortId(ticket.id) + '_';
}

export function formatCareStats(stats = {}) {
  return '🩺 *Care stats*\n\n' +
    '🔵 open: ' + (stats.open || 0) + '\n' +
    '🟡 in progress: ' + (stats.inProgress || 0) + '\n' +
    '❗ high priority: ' + (stats.high || 0) + '\n' +
    '🟢 resolved: ' + (stats.resolved || 0) + '\n' +
    '⚪ closed: ' + (stats.closed || 0) + '\n\n_' + (stats.total || 0) + ' tickets in the recent window._';
}

function splitIdAndText(arg = '') {
  const m = String(arg || '').trim().match(/^(\S+)\s+([\s\S]+)$/);
  return m ? { id: m[1], body: m[2].trim() } : { id: String(arg || '').trim(), body: '' };
}

/**
 * Deterministic `care ...` router. Returns `{ reply }` when handled, or `null`
 * when the message is not a care command (normal chat flows on untouched).
 * Boundaries: only tickets + replies. No admin, ledger, VIN, billing or refunds.
 */
export async function handleCareCommand(supabase, { phone, text, sendWhatsApp = null, sendEmail = null, notifySuperadmin = null, isSuperadminActor = false } = {}) {
  const rest = careCommandOf(text);
  if (rest === null) return null;
  if (!isSuperadminActor && !isCareWorker(phone)) return null;
  if (!supabase) return { reply: 'Care console is unavailable right now (no database connection).' };
  const parts = rest.split(/\s+/).filter(Boolean);
  const cmd = (parts.shift() || 'help').toLowerCase();
  const arg = parts.join(' ').trim();
  const ctx = { supabase, phone, sendWhatsApp, sendEmail, notifySuperadmin };
  switch (cmd) {
    case 'help':
      return { reply: formatCareHelp() };
    case 'inbox': {
      const filter = /^high$/i.test(arg) ? 'high' : (/^all$/i.test(arg) ? 'all' : 'open');
      return { reply: formatCareInbox(await listCareTickets(supabase, { filter, limit: 10 }), filter) };
    }
    case 'stats':
      return { reply: formatCareStats(await careStats(supabase)) };
    case 'audit': {
      let rows = [];
      try {
        const res = await supabase.from(CARE_AUDIT_TABLE).select('action, details, created_at').ilike('action', 'CARE_TICKET_%').order('created_at', { ascending: false }).limit(10);
        rows = (res && res.data) || [];
      } catch { rows = []; }
      return { reply: formatCareAudit(rows) };
    }
    case 'search': {
      if (!arg) return { reply: 'Give me a word to search: `care search <word>`.' };
      let rows = [];
      try {
        const res = await supabase.from(CARE_TICKETS_TABLE).select('*').or('whatsapp_number.ilike.%' + arg + '%,sender_email.ilike.%' + arg + '%,message_body.ilike.%' + arg + '%').order('updated_at', { ascending: false }).limit(10);
        rows = (res && res.data) || [];
      } catch { rows = []; }
      return { reply: rows.length ? formatCareInbox(rows, 'match' + (rows.length === 1 ? '' : 'es')) : 'No tickets matched "' + arg + '".' };
    }
    case 'read': {
      if (!arg) return { reply: 'Open one with `care read <id>` (ids come from `care inbox`).' };
      return { reply: formatCareTicket(await getCareTicket(supabase, arg)) };
    }
    case 'note': {
      const { id, body } = splitIdAndText(arg);
      if (!id || !body) return { reply: 'Use `care note <id> <text>`.' };
      const ticket = await getCareTicket(supabase, id);
      if (!ticket) return { reply: 'That ticket was not found.' };
      const combined = (ticket.internal_note ? ticket.internal_note + '\n' : '') + body;
      const res = await updateCareTicket(supabase, ticket.id, { internal_note: combined.slice(0, 2000), updated_at: nowIso() });
      await appendTicketMessage(supabase, { ticketId: ticket.id, direction: 'internal', channel: 'note', body });
      await auditCareAction(supabase, { phone, action: 'CARE_TICKET_NOTE', details: { ticketId: ticket.id } });
      return { reply: res.ok ? '📝 Note saved on `' + shortId(ticket.id) + '`.' : 'Could not save the note.' };
    }
    default:
      return handleCareTicketAction(ctx, cmd, arg);
  }
}

export function formatCareAudit(rows = []) {
  if (!rows.length) return '🩺 *Care audit* — nothing logged yet.';
  const lines = rows.slice(0, 10).map((r) => '• ' + String(r.action || 'CARE').replace(/^CARE_TICKET_/, '') + ' · ' + ageOf(r.created_at) + ' · ' + clip(r.details, 80));
  return '🩺 *Care audit*\n\n' + lines.join('\n');
}

/** Assignment + escalation ladder (never touches money or ledger). */
async function handleCareTicketAction({ supabase, phone, sendWhatsApp, sendEmail, notifySuperadmin }, cmd, arg) {
  switch (cmd) {
    case 'take':
    case 'release': {
      const ticket = await getCareTicket(supabase, arg);
      if (!ticket) return { reply: 'That ticket was not found.' };
      await updateCareTicket(supabase, ticket.id, { assigned_to: cmd === 'take' ? String(phone) : null, updated_at: nowIso() });
      await auditCareAction(supabase, { phone, action: cmd === 'take' ? 'CARE_TICKET_TAKEN' : 'CARE_TICKET_RELEASED', details: { ticketId: ticket.id } });
      return { reply: cmd === 'take' ? '🙋 You are now handling `' + shortId(ticket.id) + '`.' : 'Ticket `' + shortId(ticket.id) + '` released.' };
    }
    case 'escalate': {
      const ticket = await getCareTicket(supabase, arg);
      if (!ticket) return { reply: 'That ticket was not found.' };
      await updateCareTicket(supabase, ticket.id, { priority: CARE_PRIORITY.HIGH, updated_at: nowIso() });
      let alerted = false;
      if (typeof notifySuperadmin === 'function') {
        try {
          const r = await notifySuperadmin({ phone: contactOf(ticket), text: 'Escalated care ticket ' + shortId(ticket.id) + ': ' + clip(ticket.message_body, 300), category: ticket.issue_category || 'other', priority: 'high' });
          alerted = Boolean(r && (r.alerted !== undefined ? r.alerted : r));
        } catch { alerted = false; }
      }
      await appendTicketMessage(supabase, { ticketId: ticket.id, direction: 'internal', channel: 'note', body: 'Escalated to superadmin.' });
      await auditCareAction(supabase, { phone, action: 'CARE_TICKET_ESCALATED', details: { ticketId: ticket.id, alerted } });
      return { reply: '❗ Escalated `' + shortId(ticket.id) + '` to high priority.' + (alerted ? ' Superadmin alerted.' : '') };
    }
    case 'deescalate': {
      const ticket = await getCareTicket(supabase, arg);
      if (!ticket) return { reply: 'That ticket was not found.' };
      await updateCareTicket(supabase, ticket.id, { priority: CARE_PRIORITY.MEDIUM, updated_at: nowIso() });
      await auditCareAction(supabase, { phone, action: 'CARE_TICKET_DEESCALATED', details: { ticketId: ticket.id } });
      return { reply: 'Priority returned to medium on `' + shortId(ticket.id) + '`.' };
    }
    default:
      return handleCareReplyAction({ supabase, phone, sendWhatsApp, sendEmail }, cmd, arg);
  }
}

/** Lifecycle close/reopen + user-facing replies (WhatsApp and/or email). */
async function handleCareReplyAction({ supabase, phone, sendWhatsApp, sendEmail }, cmd, arg) {
  switch (cmd) {
    case 'close':
    case 'reopen': {
      const ticket = await getCareTicket(supabase, arg);
      if (!ticket) return { reply: 'That ticket was not found.' };
      const status = cmd === 'close' ? CARE_STATUS.CLOSED : CARE_STATUS.OPEN;
      await updateCareTicket(supabase, ticket.id, { status, updated_at: nowIso() });
      await auditCareAction(supabase, { phone, action: cmd === 'close' ? 'CARE_TICKET_CLOSED' : 'CARE_TICKET_REOPENED', details: { ticketId: ticket.id } });
      return { reply: (cmd === 'close' ? '⚪ Closed ' : '🔵 Reopened ') + '`' + shortId(ticket.id) + '`.' };
    }
    case 'reply':
    case 'email': {
      const { id, body } = splitIdAndText(arg);
      if (!id || !body) return { reply: 'Use `care ' + cmd + ' <id> <text>`.' };
      const ticket = await getCareTicket(supabase, id);
      if (!ticket) return { reply: 'That ticket was not found.' };
      const phoneTarget = /^\+?[\d\s-]{7,}$/.test(String(ticket.whatsapp_number || '')) ? String(ticket.whatsapp_number) : null;
      const emailTarget = ticket.sender_email || (String(ticket.whatsapp_number || '').includes('@') ? ticket.whatsapp_number : null);
      let whatsappSent = false;
      let emailSent = false;
      if (cmd === 'reply' && phoneTarget && typeof sendWhatsApp === 'function') {
        try { whatsappSent = (await sendWhatsApp(phoneTarget, body)) !== false; } catch { whatsappSent = false; }
      }
      if (emailTarget && typeof sendEmail === 'function') {
        try { emailSent = (await sendEmail({ to: emailTarget, subject: 'Re: your Saka support request (' + shortId(ticket.id) + ')', text: body })) !== false; } catch { emailSent = false; }
      }
      if (!whatsappSent && !emailSent) return { reply: 'I could not send that reply (no reachable channel). Use `care read ' + shortId(ticket.id) + '`.' };
      const channel = whatsappSent && emailSent ? 'whatsapp+email' : (whatsappSent ? 'whatsapp' : 'email');
      await appendTicketMessage(supabase, { ticketId: ticket.id, direction: 'out', channel, body });
      await updateCareTicket(supabase, ticket.id, { status: CARE_STATUS.IN_PROGRESS, updated_at: nowIso() });
      await auditCareAction(supabase, { phone, action: 'CARE_TICKET_REPLIED', details: { ticketId: ticket.id, channel } });
      return { reply: '📤 Reply sent on ' + channel + ' for `' + shortId(ticket.id) + '`.' };
    }
    default:
      return { reply: 'I did not recognise that care command.\n\n' + formatCareHelp() };
  }
}

export default {
  CARE_STATUS,
  CARE_PRIORITY,
  CARE_SQL,
  CARE_THREAD_WINDOW_HOURS,
  CARE_TICKET_MAX_OPEN,
  ensureCareConsoleTables,
  normalizeThreadKey,
  isCareWorker,
  careCommandOf,
  auditCareAction,
  appendTicketMessage,
  findOpenTicketByThread,
  openOrAppendEmailTicket,
  resolveCareTicketId,
  getCareTicket,
  listCareTickets,
  updateCareTicket,
  careStats,
  formatCareHelp,
  formatCareInbox,
  formatCareTicket,
  formatCareStats,
  formatCareAudit,
  handleCareCommand
};






