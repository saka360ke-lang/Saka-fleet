/**
 * Saka Fleet — Editable Ledger answers (v1.33.0)
 * ----------------------------------------------
 * Everything that turns a WhatsApp sentence into a ledger action lives here so
 * the route stays thin and the behaviour is testable without a database:
 *
 *   - `detectLedgerCommand()`   "edit my last entry" / "delete entry" / "my entries"
 *   - `parseEntrySelection()`   "2", "#2", "entry 2", "the second one"
 *   - `parseEntryEditRequest()` "amount 10500 kes, type parts"
 *   - `resolveLedgerTurn()`     the one decision point for every ledger turn,
 *                               including the pending (mid-edit) conversation
 *   - `format*()`               the WhatsApp copy (numbered list, previews,
 *                               diff confirmation, delete + restore windows)
 *
 * Rules baked in (mirrors .clinerules 8/9 for assets):
 *   1. VIN/passbook identifiers and `entry_date` are never editable here.
 *   2. Money and volume are re-printed with their units on every reply.
 *   3. Deterministic copy — zero AI tokens, zero improvising.
 */

import { formatMoney, formatDate } from './globalization.js';
import { resolveExpenseType } from './expenseCatalog.js';
import { matchNarrativeVehicle } from './narrativeDraft.js';
// Local binding for the editor's label parsing (the re-export below only
// re-exports; it does not bind the name inside this module).
import { sanitizeEntryLabel } from './entryLabels.js';

export const ENTRY_PENDING_TTL_MINUTES = 15;
export const ENTRY_RESTORE_WINDOW_MINUTES = 30;
export const ENTRY_LIST_LIMIT = 6;

// v1.73.0 (Phase 10, P3-1) — pagination. Page 1 stays at 6 rows; `more` serves
// 6-row pages, capped at 5 pages total (30 rows) so a 100-entry ledger never
// turns into a 17-page scroll: past the cap the user is redirected to
// `search <keyword>` or a report. The cursor is session MEMORY, not a pending
// interaction — 15 minutes, exactly like `lastRecordQuery` (decision D1).
export const ENTRY_PAGE_SIZE = ENTRY_LIST_LIMIT;
export const ENTRY_MAX_OFFSET = 24;
export const PAGINATION_CURSOR_TTL_MINUTES = 15;

/**
 * True when a pagination cursor is still fresh. Pure; used by the read
 * registry's `pagination_more` lane so a cursorless/expired `more` can NEVER
 * claim a turn (it falls through to the AI exactly as before).
 */
export function paginationCursorActive(cursor, now = Date.now()) {
  if (!cursor || !cursor.listType) return null;
  const at = Number(cursor.at || 0);
  if (!Number.isFinite(at) || at <= 0) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return null;
  if (nowMs - at > PAGINATION_CURSOR_TTL_MINUTES * 60 * 1000) return null;
  const offset = Number(cursor.offset);
  if (!Number.isFinite(offset) || offset <= 0) return null;
  return cursor;
}

// v1.59.0 — the optional record label is a pure module (no import cycles):
// sanitisation + deterministic capture live in entryLabels.js.
export { ENTRY_LABEL_MAX_CHARS, sanitizeEntryLabel, extractEntryLabel } from './entryLabels.js';

const WORD_ORDINALS = Object.freeze({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  last: 1, latest: 1, recent: 1, newest: 1, previous: 2
});

// A few conversational words the catalog aliases do not carry yet. The
// canonical value still comes from `resolveExpenseType` (single source of
// truth, rule 23), never from a second list declared here.
const EXTRA_TYPE_ALIASES = Object.freeze({
  fix: 'Repairs',
  garage: 'Repairs',
  mechanic: 'Repairs',
  spares: 'Parts',
  spare: 'Parts',
  gasoil: 'Fuel',
  misc: 'Other',
  miscellaneous: 'Other'
});

function canonicalExpenseType(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return null;
  return resolveExpenseType(clean) || EXTRA_TYPE_ALIASES[clean.toLowerCase()] || null;
}

function num(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function money(amount, currency, locale, fallbackCurrency) {
  return formatMoney(num(amount, 0), currency || fallbackCurrency || 'USD', locale || 'en-US');
}

/**
 * "my entries" / "edit my last entry" / "delete entry 2" / "restore my entry".
 * Returns `{ action, index }` where `index` is an explicit selection (or null),
 * or `null` when the message is not a ledger command at all.
 */
export function detectLedgerCommand(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/\s+/g, ' ');

  // v1.56.1 — "You deleted/wrote/logged the wrong entry" is a COMPLAINT about
  // what Saka did, not a request to edit/delete a saved row (live 2026-11-03:
  // it was misread as an edit of the user's last entry). Past-tense attribution
  // to Saka routes to the complaint lane instead of the ledger.
  if (/^(?:you|saka|u)\b/.test(t)
      && /\b(?:deleted|removed|erased|wrote|logged|recorded|charged|changed|edited|saved|sent|got)\b/.test(t)) {
    return null;
  }

  if (/^(?:show |list |view |see )?(?:my |the )?(?:saved )?(?:entries|entry list|ledger|expense log|records?)$/.test(t)) {
    return { action: 'list', index: null };
  }

  const restoreMatch = /^(?:restore|undelete|bring back|undo the delete)\b(.*)$/.exec(t);
  if (restoreMatch) return { action: 'restore', index: parseEntrySelection(restoreMatch[1]) };

  const editMatch = /^(?:edit|change|update|correct|fix|amend)\b(.*)$/.exec(t);
  if (editMatch) {
    const tail = editMatch[1] || '';
    const namesEntry = /\b(?:entr(?:y|ies)|record|expense|log|fuel|service|repair|purchase|transaction)\b/.test(tail);
    const namesField = /\b(?:amount|type|odometer|mileage|litres|liters|notes?|labels?|tags?)\b/.test(tail);
    if (!namesEntry && !namesField) return null;
    return { action: 'edit', index: parseEntrySelection(tail) };
  }

  const deleteMatch = /^(?:delete|remove|discard|erase|void)\b(.*)$/.exec(t);
  if (deleteMatch) {
    const tail = deleteMatch[1] || '';
    if (!/\b(?:entr(?:y|ies)|record|expense|log|fuel|service|repair|purchase|transaction)\b/.test(tail)) return null;
    return { action: 'delete', index: parseEntrySelection(tail) };
  }

  // Natural mistakes: "I made a mistake on the fuel entry", "wrong amount".
  // v1.54.5 — must name a SAVED entry, never a bare field/fuel word. "The fuel
  // volume is definitely wrong… amount" is a correction to the OPEN draft, not
  // an edit of a saved row (live 2026-11-03: this text was stolen from the
  // confirmation summary and answered "I could not find an entry to change").
  if (/\b(?:mistake|wrong|incorrect|typo|error)\b/.test(t)
      && /\b(?:entr(?:y|ies)|record|expense|log|transaction|receipt)\b/.test(t)) {
    const wantsDelete = /\b(?:delete|remove|erase|void)\b/.test(t);
    return { action: wantsDelete ? 'delete' : 'edit', index: parseEntrySelection(t) };
  }

  if (/^(?:undo|reverse|rollback)\b.*\b(?:last|latest)\b.*\b(?:entr(?:y|ies)|record|expense|log)\b/.test(t)) {
    return { action: 'delete', index: 1 };
  }

  return null;
}

/** "2", "#2", "entry 2", "number two", "the second one", "last" -> 1-based index. */
export function parseEntrySelection(text = '') {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const direct = /(?:^|[^\d])(?:#|no\.?|number|entry|record|item)?\s*(\d{1,2})(?:\D|$)/.exec(t);
  if (direct) {
    const n = Number(direct[1]);
    if (n >= 1 && n <= 20) return n;
  }
  for (const [word, index] of Object.entries(WORD_ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return index;
  }
  return null;
}


/** Everything the user asked to change, in one pass. Empty object when none. */
export function parseEntryEditRequest(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return {};
  const changes = {};
  const t = raw.toLowerCase();

  const amountMatch = /(?:amount|cost|price|total|charge|bill|figure|spent|paid)\b[^0-9]{0,24}(?:to|of|was|is|should be|now|:|=)?\s*(?:ksh|kes|usd|ugx|tzs|ngn|zar|eur|gbp|\$)?\s*([\d][\d,.]*)/.exec(t)
    || /(?:change|correct|fix|update|make)\b[^0-9]{0,24}([\d][\d,.]*)\s*(?:ksh|kes|usd|ugx|tzs|ngn|zar|eur|gbp|dollars?)?\s*(?:for|on)?\s*(?:the\s+)?(?:amount|cost|price|total)/.exec(t);
  if (amountMatch) {
    const value = num(amountMatch[1], NaN);
    if (Number.isFinite(value) && value > 0) changes.amount = value;
  }

  const typeMatch = /(?:type|category)\b[^a-z]{0,10}(?:was|is|from|to|:|=)?\s*(?:to\s+|from\s+)?([a-z][a-z ]{2,20}?)(?:\s+to\s+([a-z][a-z ]{2,20}))?(?:$|[.,;]|\s+(?:and|pls|please|instead))/.exec(t)
    || /(?:change|correct|fix|update)\b[^.]{0,30}?\bfrom\s+([a-z][a-z ]{2,20}?)\s+to\s+([a-z][a-z ]{2,20})/.exec(t);
  if (typeMatch) {
    const candidates = [typeMatch[2], typeMatch[1]].filter(Boolean).map((v) => v.trim());
    for (const candidate of candidates) {
      const direct = canonicalExpenseType(candidate);
      if (direct) { changes.expense_type = direct; break; }
      for (const word of candidate.split(/\s+/)) {
        const single = canonicalExpenseType(word);
        if (single) { changes.expense_type = single; break; }
      }
      if (changes.expense_type) break;
    }
  }

  const odometerMatch = /(?:odometer|mileage|reading|clock)\b[^0-9]{0,20}([\d][\d,.]*)\s*(?:km|kms|kilometres?|kilometers?|mi|miles?)?/.exec(t)
    || /(?:odometer|mileage)\s*(?:was|is|should be|to)?\s*([\d][\d,.]*)/.exec(t);
  if (odometerMatch) {
    const value = num(odometerMatch[1], NaN);
    if (Number.isFinite(value) && value >= 0) changes.odometer_reading = value;
  }

  const litresMatch = /([\d][\d,.]*)\s*(?:l|lt|ltr|litre|litres|liter|liters)\b/.exec(t);
  if (litresMatch) {
    const value = num(litresMatch[1], NaN);
    if (Number.isFinite(value) && value > 0) changes.fuel_liters = value;
  }

  if (/\bfull\s*tank\b/.test(t)) changes.fill_type = 'full_tank';
  else if (/\btop[\s-]?up\b/.test(t)) changes.fill_type = 'top_up';

  // v1.59.0 — the optional label is editable like any other safe field. The
  // label segment is removed before the notes parse so the two never bleed.
  const labelMatch = /(?:label|tag)\s*[:=]\s*([^,\n]{2,48})/i.exec(raw);
  if (labelMatch) {
    const label = sanitizeEntryLabel(labelMatch[1]);
    if (label) changes.label = label;
  }

  const notesSource = labelMatch ? raw.replace(labelMatch[0], ' ') : raw;
  const notesMatch = /(?:notes?|remarks?|comments?|description)\s*[:=]\s*([^\n]{2,240})/i.exec(notesSource);
  if (notesMatch) changes.notes = notesMatch[1].trim().replace(/[,;\s]+$/, '');

  return changes;
}

function pendingActive(pending, now = new Date()) {
  if (!pending || !pending.mode) return null;
  const stamped = pending.at ? new Date(pending.at).getTime() : NaN;
  if (!Number.isFinite(stamped)) return null;
  if (now.getTime() - stamped > ENTRY_PENDING_TTL_MINUTES * 60 * 1000) return null;
  return pending;
}

// v1.96.2 — a delete/remove request aimed at a NON-ledger record must never
// ride a stale ledger delete prompt. Live 2026-11-09 (+254734852529): the user
// opened "Delete last entry" (a fuel preview), then typed "No. Delete last
// compliance". The old prompt survived, the assistant invented a
// "Delete the last compliance entry?" card, and the next "Delete" removed the
// FUEL row instead (rule 37 violation). Compliance and reminders have no
// delete lane — they are answered deterministically; receipts/documents/
// vehicles own their lanes, so the stale pending is simply unblocked.
const NON_LEDGER_ACTION_RE = /\b(?:delete|remove|erase|void|discard|drop)\b/i;
const COMPLIANCE_TARGET_RE = /\b(?:compliance|permit|insurance|licen[cs]e|psv|inspection|road\s*licen[cs]e)\b/i;
const REMINDER_TARGET_RE = /\breminder\b/i;
const OTHER_LEDGERLESS_TARGET_RE = /\b(?:receipt|document|file|logbook|vehicle|car|truck|asset)\b/i;

/** Which non-ledger record a delete/remove request names (null when none). */
export function detectNonLedgerTarget(text = '') {
  const t = String(text || '');
  if (!NON_LEDGER_ACTION_RE.test(t)) return null;
  if (COMPLIANCE_TARGET_RE.test(t)) return 'compliance';
  if (REMINDER_TARGET_RE.test(t)) return 'reminder';
  if (OTHER_LEDGERLESS_TARGET_RE.test(t)) return 'other';
  return null;
}

/**
 * The single decision point for a ledger turn.
 *
 *   { type: 'none' }                     -> normal Saka pipeline
 *   { type: 'command', action, index }   -> list / edit / delete / restore
 *   { type: 'select', index, mode }      -> the pending action now has a target
 *   { type: 'edit-apply', changes }      -> apply the parsed diff
 *   { type: 'delete-confirm' }           -> user typed DELETE
 *   { type: 'cancel' }
 */
export function resolveLedgerTurn({ pending = null, text = '', now = new Date() } = {}) {
  const t = String(text || '').trim();
  if (!t) return { type: 'none' };
  const active = pendingActive(pending, now);

  if (active) {
    // v1.96.2 — a delete/remove request naming a NON-ledger record drops the
    // stale ledger prompt before it can act on the wrong row (rule 37).
    const nonLedger = detectNonLedgerTarget(t);
    if (nonLedger) {
      return nonLedger === 'other'
        ? { type: 'none', dropPending: true }
        : { type: 'none', dropPending: true, blockedTarget: nonLedger };
    }
    if (/^(?:cancel|stop|stop it|never ?mind|forget it|leave it|exit)\.?$/i.test(t)) {
      return { type: 'cancel' };
    }
    const shortTurn = t.split(/\s+/).length <= 4;
    if (active.mode === 'delete') {
      if (/^(?:delete|yes|confirm|yep|yeah|do it|delete it|yes delete(?: it)?|confirm delete)\.?$/i.test(t)) {
        return { type: 'delete-confirm' };
      }
      if (/^(?:no|nope|keep|keep it|do not|don'?t)\.?$/i.test(t)) return { type: 'cancel' };
      const sel = parseEntrySelection(t);
      if (sel && shortTurn) return { type: 'select', index: sel, mode: 'delete' };
    }
    if (active.mode === 'edit') {
      // Safety: an abandoned edit prompt must never swallow a fresh log line
      // ("Logged 40L at 50,350 km" is a NEW entry, not an edit of the old one).
      if (/^(?:log|logged|record|recorded|add|added|spent|paid|refuel|refuelled|refueled|filled|fill|today\s+i)\b/i.test(t)
          && !/^(?:change|edit|update|correct|fix|amend)\b/i.test(t)) {
        return { type: 'none', dropPending: true };
      }
      const changes = parseEntryEditRequest(t);
      if (Object.keys(changes).length) return { type: 'edit-apply', changes };
      const sel = parseEntrySelection(t);
      if (sel && shortTurn) return { type: 'select', index: sel, mode: 'edit' };
    }
  }

  const command = detectLedgerCommand(t);
  if (command) return { type: 'command', ...command };
  return { type: 'none' };
}

/** Stable key for a ledger row: `expense:12` / `earning:7`. */
/**
 * v1.58.3 - which vehicle does a ledger command target? Never the whole fleet:
 * an explicit plate/label/ordinal wins, then the single vehicle, then the
 * user's active vehicle. A multi-vehicle account with no such signal returns
 * ambiguous so the route can ask which vehicle before any write.
 */
export function resolveLedgerVehicleScope({
  text = '',
  vehicles = [],
  activeVehicle = null,
  pendingVehicleId = null
} = {}) {
  const list = Array.isArray(vehicles) ? vehicles.filter(Boolean) : [];
  if (pendingVehicleId) {
    const pinned = list.find(function (v) { return v.id === pendingVehicleId; });
    if (pinned) return { vehicleIds: [pinned.id], vehicle: pinned, reason: 'pending', ambiguous: false };
  }
  if (list.length === 0) return { vehicleIds: [], vehicle: null, reason: 'no-vehicles', ambiguous: true };
  const match = matchNarrativeVehicle(text, list, activeVehicle);
  // v1.89.0 — an ambiguous NICKNAME is a named reference: never fall through to
  // the active vehicle or a plate-prefix guess (ask which vehicle instead).
  if (match.reason === 'ambiguous-nickname') {
    return { vehicleIds: [], vehicle: null, reason: 'ambiguous', ambiguous: true, candidates: match.candidates || list };
  }
  if (match.vehicle && match.reason !== 'ambiguous') {
    return { vehicleIds: [match.vehicle.id], vehicle: match.vehicle, reason: match.reason, ambiguous: false };
  }
  // v1.58.23 - a unique plate prefix resolves ("KBJ" -> KBJ 819C). Only when
  // exactly one vehicle matches; never a guess between several (live 2026-11-04:
  // "Show me expenses for KBJ" was refused on a 2-vehicle account).
  const tokens = String(text || '').toUpperCase().match(/\b[A-Z]{2,4}\b/g) || [];
  for (const token of new Set(tokens)) {
    const hits = list.filter(function (v) {
      const plate = String(v.plate_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return plate.startsWith(token);
    });
    if (hits.length === 1) {
      return { vehicleIds: [hits[0].id], vehicle: hits[0], reason: 'plate', ambiguous: false };
    }
  }
  if (activeVehicle && list.some(function (v) { return v.id === activeVehicle.id; })) {
    return { vehicleIds: [activeVehicle.id], vehicle: activeVehicle, reason: 'active', ambiguous: false };
  }
  if (list.length === 1) return { vehicleIds: [list[0].id], vehicle: list[0], reason: 'single', ambiguous: false };
  return { vehicleIds: [], vehicle: null, reason: 'ambiguous', ambiguous: true, candidates: list };
}

export function ledgerEntryKey(entry = {}) {
  if (!entry) return null;
  const kind = entry.kind || (entry.table === 'private_earnings' ? 'earning' : 'expense');
  return entry.id === null || entry.id === undefined ? null : `${kind}:${entry.id}`;
}

export function entryKindLabel(entry = {}) {
  return (entry.kind || 'expense') === 'earning' ? 'Earning' : 'Expense';
}


function vehicleLabel(entry, vehicles = []) {
  const match = (vehicles || []).find((v) => v.id === entry.vehicle_id);
  return match?.plate_number || match?.serial_number || 'your vehicle';
}

/** "12 Oct 2026 - Fuel - KES 4,500 - 40 L - 50,350 km - KDA 123A" */
export function describeEntry(entry = {}, { vehicles = [], currency = null, locale = 'en-US' } = {}) {
  const parts = [];
  if (entry.created_at) {
    try {
      parts.push(formatDate(entry.created_at, locale, { day: '2-digit', month: 'short', year: 'numeric' }));
    } catch { parts.push(String(entry.created_at).slice(0, 10)); }
  }
  const type = entry.expense_type || entry.earning_type || entryKindLabel(entry);
  parts.push(String(type).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
  // v1.59.0 — the optional label rides every entry description.
  if (entry.label) parts.push(`#${entry.label}`);
  parts.push(money(entry.amount, entry.currency || currency, locale, currency));
  if (num(entry.fuel_liters, 0) > 0) parts.push(`${num(entry.fuel_liters)} L`);
  if (num(entry.odometer_reading, 0) > 0) parts.push(`${num(entry.odometer_reading).toLocaleString('en-US')} km`);
  parts.push(vehicleLabel(entry, vehicles));
  return parts.join(' - ');
}

/** The numbered "which one?" list that every edit/delete starts from. */
export function formatLedgerList({ entries = [], vehicles = [], currency = null, locale = 'en-US', title = null, hasMore = false, paged = false, atCap = false } = {}) {
  const head = title || (paged ? 'Older entries' : 'Your last entries');
  if (!entries.length) {
    return `${head}\n\nNothing logged yet. Send a one-liner like:\n_Logged 40L at 50,350 km for 4,500_\nor a receipt photo, and I will log it.`;
  }
  const lines = entries.map((entry, i) => `*${i + 1}.* ${describeEntry(entry, { vehicles, currency, locale })}`);
  if (paged) {
    // D2 — page 2+ is VIEW-ONLY: never invites edit/delete, because the
    // numbered edit/delete window always points at the newest list.
    const footer = atCap
      ? "That's as far back as I can list here. For anything older, reply *search <keyword>* or ask for a report. Reply *my entries* to go back to the newest."
      : (hasMore
        ? `Reply *more* for the next ${ENTRY_PAGE_SIZE} older entries, or *my entries* to go back to the newest.`
        : "That's the end of your ledger on this vehicle. Reply *my entries* to go back to the newest.");
    return `${head}\n\n${lines.join('\n')}\n\n${footer}`;
  }
  const moreLine = hasMore ? `\n\nReply *more* for the next ${ENTRY_PAGE_SIZE} older entries.` : '';
  return `${head}\n\n${lines.join('\n')}\n\nReply *edit 2* or *delete 2* (use the number).${moreLine}`;
}

export function formatEditPreview(entry, { vehicles = [], currency = null, locale = 'en-US' } = {}) {
  return `*Editing entry*\n${describeEntry(entry, { vehicles, currency, locale })}\n\n`
    + 'Tell me what to change, for example:\n'
    + '_amount 4,800_\n_type parts_\n_odometer 50,350_\n_42 litres, full tank_\n_label karen run_\n'
    + 'You can put several in one message.\n\nReply *cancel* to leave it as it is.';
}

export function formatDeleteConfirm(entry, { vehicles = [], currency = null, locale = 'en-US', restoreMinutes = ENTRY_RESTORE_WINDOW_MINUTES } = {}) {
  return `*Delete this entry?*\n\n${describeEntry(entry, { vehicles, currency, locale })}\n\n`
    + `Reply *DELETE* to remove it (I keep a ${restoreMinutes}-minute undo), or *cancel*.`;
}

/** Before -> after lines for the applied patch. */
export function formatEntryDiff(entry = {}, patch = {}, { currency = null, locale = 'en-US' } = {}) {
  const labels = {
    amount: 'Amount',
    expense_type: 'Type',
    fuel_liters: 'Fuel',
    fill_type: 'Fill type',
    odometer_reading: 'Odometer',
    notes: 'Notes',
    label: 'Label'
  };
  const render = (key, value) => {
    if (key === 'amount') return money(value, entry.currency || currency, locale, currency);
    if (key === 'fuel_liters') return `${num(value)} L`;
    if (key === 'odometer_reading') return `${num(value).toLocaleString('en-US')} km`;
    if (key === 'fill_type' || key === 'expense_type') return String(value).replace(/_/g, ' ');
    return String(value ?? '').slice(0, 120);
  };
  const lines = [];
  for (const [key, value] of Object.entries(patch)) {
    const before = entry[key];
    if (before !== null && before !== undefined && String(before) === String(value)) continue;
    const shown = before === null || before === undefined || before === ''
      ? 'empty'
      : render(key, before);
    lines.push(`- ${labels[key] || key}: ${shown} -> ${render(key, value)}`);
  }
  return lines;
}

export function formatEntryUpdated({ entry, patch = {}, vehicles = [], currency = null, locale = 'en-US' } = {}) {
  const diff = formatEntryDiff(entry, patch, { currency, locale });
  const body = diff.length ? diff.join('\n') : '- saved (no visible change)';
  return `*Entry updated*\n\n${body}\n\nNow: ${describeEntry({ ...entry, ...patch }, { vehicles, currency, locale })}\n\n`
    + 'Reports and totals use the corrected figure right away.';
}

/** v1.37.0 — a correction is a delete & re-log; the copy says exactly that. */
export function formatEntryRelogged({ entry, patch = {}, vehicles = [], currency = null, locale = 'en-US' } = {}) {
  const diff = formatEntryDiff(entry, patch, { currency, locale });
  const body = diff.length ? diff.join('\n') : '- corrected (no visible change)';
  return `*Entry corrected*\n\n${body}\n\nNow: ${describeEntry({ ...entry, ...patch }, { vehicles, currency, locale })}\n\n`
    + 'The old row was removed and the corrected one re-logged. Reports and totals use the corrected figure right away.';
}

export function formatEntryDeleted({ entry, vehicles = [], currency = null, locale = 'en-US', restoreMinutes = ENTRY_RESTORE_WINDOW_MINUTES } = {}) {
  return `*Entry deleted*\n\n${describeEntry(entry, { vehicles, currency, locale })}\n\n`
    + `Changed your mind? Reply *restore* within ${restoreMinutes} minutes and I will put it back exactly as it was.`;
}

export function formatEntryRestored({ entry, vehicles = [], currency = null, locale = 'en-US' } = {}) {
  return `*Entry restored*\n\n${describeEntry(entry, { vehicles, currency, locale })}\n\nNothing was lost.`;
}

export function formatRestoreEmpty(restoreMinutes = ENTRY_RESTORE_WINDOW_MINUTES) {
  return `There is nothing to restore. Deleted entries can be brought back for ${restoreMinutes} minutes after deletion.`;
}

export function formatNoEntryForSelection(index) {
  return `I do not have an entry *${index}* in that list. Reply *my entries* to see the numbers again.`;
}

export function formatLedgerHelp() {
  return '*Editing your ledger*\n\n'
    + '- *my entries* - the last 6, numbered\n'
    + '- *edit 2* - change amount, type, litres, odometer, notes or label\n'
    + '- *delete 2* - remove it (30-minute undo)\n'
    + '- *restore* - bring back the last deleted entry\n\n'
    + 'VIN, plate and entry date stay locked.';
}

