/**
 * Saka Fleet — Record Answers (v1.36.0, pure — no I/O)
 * -----------------------------------------------------------------
 * Turns a natural question about the user's own logged records into a
 * deterministic query spec and renders the answer. Zero AI tokens: every
 * figure comes from the ledger rows, never from a model.
 *
 * Questions: "how much did I spend on fuel last week?", "what did I log
 * yesterday?", "average spend per fill in October", "how many fills this
 * month?" — resolved by `parseRecordQuestion` and formatted by
 * `formatRecordAnswer`. Never throws.
 */

import { resolveDateRange } from './dateParser.js';
import { EXPENSE_TYPES } from './expenseCatalog.js';
import { formatMoney, formatDate, formatNumber } from './globalization.js';

export const RECORD_ANSWER_VERSION = '1.36.0';

const QUESTION_WORDS_RE = /\b(how much|how many|total|spent|spend|cost|costs|did i (?:spend|pay|log)|what did i (?:log|spend|pay)|my (?:expenses?|records?|entries|logs?|ledger|earnings?|revenue|income)|earnings?|revenue|income|takings|show (?:me )?(?:my )?(?:expenses?|records?|entries|ledger)|average|avg|on average|how far|km\/l|mpg|fuel economy|sum)\b/i;
const KIND_AVERAGE_RE = /\b(average|avg|on average|km\/l|mpg|per (?:fill|litre|liter|record)|fuel economy)\b/i;
const KIND_COUNT_RE = /\b(how many|count|number of|how many times)\b/i;
const KIND_LIST_RE = /\b(what did i log|list|show|display|entries|records|my expenses|my entries|ledger|last time|latest|most recent)\b/i;
const EARNING_RE = /\b(earn(?:ed|ings?)?|revenue|income|takings?|fares?|collected)\b/i;
const EXPENSE_SIDE_RE = /\b(spent|spend|expenses?|fuel|diesel|petrol|service|repair|parts?|tyres?|parking|fine|wash|cost)\b/i;

function rangeLabel(range, locale = 'en-US') {
  if (!range) return 'all time';
  try {
    const fromText = formatDate(range.from, locale, { day: '2-digit', month: 'short' });
    if (range.from === range.to) return fromText;
    const toText = formatDate(range.to, locale, { day: '2-digit', month: 'short', year: 'numeric' });
    return `${fromText} – ${toText}`;
  } catch {
    return `${range.from} – ${range.to}`;
  }
}

/**
 * Parse a records question into a deterministic query spec.
 */
export function parseRecordQuestion(text = '', { countryCode = 'GLOBAL', locale = 'en-US', now = new Date() } = {}) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return { ok: false, reason: 'empty' };

  const looksLikeQuestion = QUESTION_WORDS_RE.test(source)
    || /^(what|how|show|list|display|summarize|summarise|total|count)\b/i.test(source)
    || /\?$/.test(source);
  if (!looksLikeQuestion) return { ok: false, reason: 'not-a-question' };

  let kind = 'total';
  if (KIND_AVERAGE_RE.test(source)) kind = 'average';
  else if (KIND_COUNT_RE.test(source)) kind = 'count';
  else if (KIND_LIST_RE.test(source)) kind = 'list';

  const earning = EARNING_RE.test(source) && !EXPENSE_SIDE_RE.test(source);

  // Longest catalog alias wins per type; overlapping aliases are de-duplicated.
  const matchedTypes = [];
  const lower = source.toLowerCase();
  for (const type of EXPENSE_TYPES) {
    for (const alias of type.aliases || []) {
      if (alias.length >= 3 && lower.includes(alias)) {
        matchedTypes.push(type.value);
        break;
      }
    }
  }
  const expenseTypes = earning ? [] : [...new Set(matchedTypes)];

  const rangeResult = resolveDateRange(source, { countryCode, locale, now });
  const range = rangeResult.ok
    ? { from: rangeResult.from, to: rangeResult.to, label: rangeLabel(rangeResult, locale), source: rangeResult.source }
    : null;

  const plateMatch = source.toUpperCase().match(/\b([A-Z]{2,3}\s?\d{1,4}[A-Z]?)\b/);
  const vehiclePlate = plateMatch ? plateMatch[1].replace(/\s+/g, '') : null;

  return { ok: true, kind, earning, expenseTypes, range, vehiclePlate, text: source };
}


/**
 * Render the deterministic answer for a parsed question + query result.
 * `vehicles` adds the fleet scope line; currency/locale are the user's own.
 */
export function formatRecordAnswer(result = {}, question = {}, { vehicles = [], currency = 'USD', locale = 'en-US' } = {}) {
  if (!result.ok) {
    return '📊 I could not read the ledger just now — please try again in a moment.';
  }
  const money = (value) => formatMoney(Number(value || 0), currency, locale);
  const periodLabel = question.range?.label ? `for ${question.range.label}` : 'all time';
  const typeLabel = question.earning
    ? 'Earnings'
    : (question.expenseTypes.length ? question.expenseTypes.join(' + ') : 'Expenses');
  const fleetNote = vehicles.length > 1 ? `\n🚗 Across your ${vehicles.length} vehicles.` : '';

  if (result.count === 0) {
    return `📊 *Nothing logged* — no ${typeLabel.toLowerCase()} ${periodLabel}. ✅${fleetNote}`;
  }

  const volumeNote = result.liters > 0 ? ` · ${formatNumber(result.liters, locale)} L` : '';

  if (question.kind === 'count') {
    return `📊 *${typeLabel}:* ${result.count} record${result.count === 1 ? '' : 's'} ${periodLabel}.${volumeNote}${fleetNote}`;
  }

  if (question.kind === 'average') {
    return `📊 *${typeLabel} ${periodLabel}:*\n• Average: *${money(result.average)}* per record\n• Records: ${result.count}\n• Total: ${money(result.total)}${volumeNote}${fleetNote}`;
  }

  if (question.kind === 'list') {
    const lines = (result.rows || []).slice(0, 6).map((row) => {
      const type = row.expense_type || row.earning_type || '—';
      const day = formatDate(row.created_at, locale, { day: '2-digit', month: 'short' });
      return `• ${money(row[result.amountCol])} — ${type} — ${day}`;
    });
    const more = result.count > lines.length ? `\n…and ${result.count - lines.length} more (reply *my entries* for the full ledger).` : '';
    return `📊 *${typeLabel} ${periodLabel}:* ${result.count} record${result.count === 1 ? '' : 's'}\n${lines.join('\n')}${more}${fleetNote}`;
  }

  return `📊 *${typeLabel} ${periodLabel}:* ${money(result.total)} (${result.count} record${result.count === 1 ? '' : 's'})${volumeNote}${fleetNote}`;
}

export default {
  RECORD_ANSWER_VERSION,
  parseRecordQuestion,
  formatRecordAnswer
};
