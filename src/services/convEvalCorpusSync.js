/**
 * Saka Fleet — conversation-eval corpus sync (v1.61.10, pure)
 * ---------------------------------------------------------
 * A successful heal on an `expected: "pass"` case proves the live prompt now
 * answers correctly, but the corpus case still stores the OLD reply — so the
 * next tick re-fails it and re-heals it. This module turns recent
 * `CONV_EVAL_HEALED` audit rows into corpus updates:
 *   - calibration cases (`expected: "fail"`) are NEVER touched (their bad reply
 *     is the false-negative guard);
 *   - a case missing from the corpus is reported, never invented;
 *   - an unchanged reply is skipped;
 *   - the newest heal per case wins.
 * No I/O: the CLI wrapper (`scripts/apply_eval_heals.js`) reads/writes files.
 */

export const CORPUS_SYNC_MAX_REPLY = 900;

/** Pull `{case_id, corrected_reply, created_at}` out of audit rows. */
export function healsFromAuditRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((row) => {
      const details = row?.details || {};
      const caseId = details.case_id || null;
      const corrected = details.corrected_reply || null;
      if (!caseId || !corrected) return null;
      return {
        case_id: caseId,
        corrected_reply: String(corrected).trim().slice(0, CORPUS_SYNC_MAX_REPLY),
        rule_key: details.rule_key || null,
        created_at: row?.created_at || null
      };
    })
    .filter(Boolean);
}

/**
 * Decide which corpus cases should adopt a healed reply. Pure; never throws.
 * Returns `{ updates: [{ id, reply, ruleKey }], skipped: [{ id, reason }] }`.
 */
export function selectCorpusUpdates(cases = [], heals = []) {
  const list = Array.isArray(cases) ? cases : [];
  const latest = new Map();
  for (const heal of Array.isArray(heals) ? heals : []) {
    const id = heal?.case_id || heal?.caseId;
    const reply = heal?.corrected_reply || heal?.correctedReply;
    if (!id || !reply) continue;
    const at = String(heal?.created_at || heal?.at || '');
    const prev = latest.get(id);
    if (!prev || at >= prev.at) {
      latest.set(id, { reply: String(reply).trim().slice(0, CORPUS_SYNC_MAX_REPLY), at, ruleKey: heal?.rule_key || null });
    }
  }
  const updates = [];
  const skipped = [];
  for (const [id, entry] of latest) {
    const target = list.find((item) => item && item.id === id);
    if (!target) { skipped.push({ id, reason: 'not_in_corpus' }); continue; }
    if (String(target.expected || '').toLowerCase() === 'fail') { skipped.push({ id, reason: 'calibration_case' }); continue; }
    if (String(target.reply || '') === entry.reply) { skipped.push({ id, reason: 'unchanged' }); continue; }
    updates.push({ id, reply: entry.reply, ruleKey: entry.ruleKey });
  }
  return { updates, skipped };
}

/** Apply the updates to a COPY of the corpus cases (the caller writes the file). */
export function applyCorpusUpdates(cases = [], updates = []) {
  const list = (Array.isArray(cases) ? cases : []).map((item) => ({ ...item }));
  let applied = 0;
  for (const update of Array.isArray(updates) ? updates : []) {
    const target = list.find((item) => item && item.id === update.id);
    if (!target) continue;
    target.reply = update.reply;
    applied += 1;
  }
  return { cases: list, applied };
}

export default {
  CORPUS_SYNC_MAX_REPLY,
  healsFromAuditRows,
  selectCorpusUpdates,
  applyCorpusUpdates
};
