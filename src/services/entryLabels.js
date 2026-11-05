/**
 * Saka Fleet — Entry labels (v1.59.0)
 * -----------------------------------
 * One pure place for the optional per-record label: sanitisation and
 * deterministic capture. Used by the ledger editor, the quiz executor, the
 * narrative draft and the quick-log lanes — never re-implemented per lane.
 *
 * A label is presentational metadata only: never money, dates, plates, VINs or
 * identifiers. It is capped, whitespace-collapsed and searchable by keyword.
 */

export const ENTRY_LABEL_MAX_CHARS = 40;

/** Trim/cap a label; letters, digits, spaces and & _ # / - only. */
export function sanitizeEntryLabel(value) {
  const raw = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  const cleaned = raw
    .replace(/[^\p{L}\p{N} &_#/-]/gu, '')
    .trim()
    .slice(0, ENTRY_LABEL_MAX_CHARS)
    .trim();
  return cleaned || null;
}

/** Deterministic label capture from one sentence ("label: karen", "#karen"). */
export function extractEntryLabel(text = '') {
  const raw = String(text || '');
  if (!raw) return null;
  const marker = /(?:^|\s)(?:label|tag|tagged|labelled|labeled)\s*[:=]\s*([^,;\n]{2,48})/i.exec(raw);
  if (marker) {
    const label = sanitizeEntryLabel(marker[1]);
    if (label) return label;
  }
  const hashtag = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N} _-]{0,32})/u.exec(raw);
  if (hashtag) return sanitizeEntryLabel(hashtag[1]);
  return null;
}

export default { ENTRY_LABEL_MAX_CHARS, sanitizeEntryLabel, extractEntryLabel };
