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

export const ENTRY_PENDING_TTL_MINUTES = 15;
export const ENTRY_RESTORE_WINDOW_MINUTES = 30;
export const ENTRY_LIST_LIMIT = 6;

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

  if (/^(?:show |list |view |see )?(?:my |the )?(?:saved )?(?:entries|entry list|ledger|expense log|records?)$/.test(t)) {
    return { action: 'list', index: null };
  }

  const restoreMatch = /^(?:restore|undelete|bring back|undo the delete)\b(.*)$/.exec(t);
  if (restoreMatch) return { action: 'restore', index: parseEntrySelection(restoreMatch[1]) };

  const editMatch = /^(?:edit|change|update|correct|fix|amend)\b(.*)$/.exec(t);
  if (editMatch) {
    const tail = editMatch[1] || '';
    const namesEntry = /\b(?:entr(?:y|ies)|record|expense|log|fuel|service|repair|purchase|transaction)\b/.test(tail);
    const namesField = /\b(?:amount|type|odometer|mileage|litres|liters|notes?)\b/.test(tail);
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
  if (/\b(?:mistake|wrong|incorrect|typo|error)\b/.test(t)
      && /\b(?:entr(?:y|ies)|record|expense|fuel|log|amount|odometer|mileage)\b/.test(t)) {
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

  const notesMatch = /(?:notes?|remarks?|comments?|description)\s*[:=]\s*([^\n]{2,240})/i.exec(raw);
  if (notesMatch) changes.notes = notesMatch[1].trim();

  return changes;
}

function pendingActive(pending, now = new Date()) {
  if (!pending || !pending.mode) return null;
  const stamped = pending.at ? new Date(pending.at).getTime() : NaN;
  if (!Number.isFinite(stamped)) return null;
  if (now.getTime() - stamped > ENTRY_PENDING_TTL_MINUTES * 60 * 1000) return null;
  return pending;
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
  parts.push(money(entry.amount, entry.currency || currency, locale, currency));
  if (num(entry.fuel_liters, 0) > 0) parts.push(`${num(entry.fuel_liters)} L`);
  if (num(entry.odometer_reading, 0) > 0) parts.push(`${num(entry.odometer_reading).toLocaleString('en-US')} km`);
  parts.push(vehicleLabel(entry, vehicles));
  return parts.join(' - ');
}

/** The numbered "which one?" list that every edit/delete starts from. */
export function formatLedgerList({ entries = [], vehicles = [], currency = null, locale = 'en-US', title = null } = {}) {
  const head = title || 'Your last entries';
  if (!entries.length) {
    return `${head}\n\nNothing logged yet. Send a one-liner like:\n_Logged 40L at 50,350 km for 4,500_\nor a receipt photo, and I will log it.`;
  }
  const lines = entries.map((entry, i) => `*${i + 1}.* ${describeEntry(entry, { vehicles, currency, locale })}`);
  return `${head}\n\n${lines.join('\n')}\n\nReply *edit 2* or *delete 2* (use the number).`;
}

export function formatEditPreview(entry, { vehicles = [], currency = null, locale = 'en-US' } = {}) {
  return `*Editing entry*\n${describeEntry(entry, { vehicles, currency, locale })}\n\n`
    + 'Tell me what to change, for example:\n'
    + '_amount 4,800_\n_type parts_\n_odometer 50,350_\n_42 litres, full tank_\n'
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
    notes: 'Notes'
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
    + '- *edit 2* - change amount, type, litres, odometer or notes\n'
    + '- *delete 2* - remove it (30-minute undo)\n'
    + '- *restore* - bring back the last deleted entry\n\n'
    + 'VIN, plate and entry date stay locked.';
}

