import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { caseHash } from './convEval.js';

/**
 * Saka Fleet — conversation eval corpus (v1.60.0)
 * ----------------------------------------------
 * Two case sources feed the judge:
 *  1. `evals/cases/conversation_cases.json` — the offline regression corpus:
 *     messy shorthand, interruptions, complaints, loop traps, elderly phrasing
 *     and boundary probes, each with a recorded reply and an `expected` verdict
 *     used for calibration (a judge that disagrees with a large share of the
 *     expectations is itself suspect).
 *  2. `buildLiveCasesFromFriction()` — real transcripts from `chat_friction_logs`
 *     (the Sentinel snippet format is `[role]: text`), so existing users' pain
 *     reaches the harness without waiting for a new signup (rule 56).
 *
 * Pure + stateless: no database, no provider call.
 */

export const CORPUS_PATH = fileURLToPath(new URL('../../evals/cases/conversation_cases.json', import.meta.url));
export const REQUIRED_TAGS = Object.freeze(['looping', 'complaint', 'shorthand', 'interruption', 'elderly', 'boundary']);
const ALLOWED_ROLES = new Set(['user', 'assistant']);

/** Validate one raw case; returns `{ ok, errors, value }`. */
export function validateCase(raw, seenIds = new Set()) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['not an object'], value: null };
  const id = String(raw.id || '').trim();
  if (!id) errors.push('missing id');
  else if (!/^[a-z0-9][a-z0-9-]{2,60}$/i.test(id)) errors.push('id must be a simple slug');
  if (id && seenIds.has(id)) errors.push('duplicate id');
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  if (turns.length === 0) errors.push('missing turns');
  const cleanTurns = [];
  for (const turn of turns.slice(0, 12)) {
    const role = String(turn?.role || '').toLowerCase();
    const text = String(turn?.text || '').trim();
    if (!ALLOWED_ROLES.has(role)) {
      errors.push('turn role must be user|assistant');
      continue;
    }
    if (!text) {
      errors.push('turn text is empty');
      continue;
    }
    cleanTurns.push({ role, text: text.slice(0, 1200) });
  }
  const reply = String(raw.reply || '').trim();
  if (reply.length < 8) errors.push('reply too short');
  if (reply.length > 1600) errors.push('reply too long');
  const tags = Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag || '').toLowerCase()).filter(Boolean) : [];
  if (tags.length === 0) errors.push('missing tags');
  const expected = String(raw.expected || 'pass').toLowerCase();
  if (!['pass', 'fail'].includes(expected)) errors.push('expected must be pass|fail');
  if (errors.length) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: {
      id,
      tags,
      expected,
      source: 'corpus',
      frictionType: raw.friction_type || null,
      turns: cleanTurns,
      reply,
      note: String(raw.note || '').slice(0, 200)
    }
  };
}

/** Load + validate the offline corpus. Never throws; errors are collected. */
export function loadCorpus(filePath = CORPUS_PATH) {
  const errors = [];
  let rawCases = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    rawCases = Array.isArray(parsed?.cases) ? parsed.cases : [];
    if (!rawCases.length) errors.push('corpus carries no cases');
  } catch (err) {
    errors.push(`corpus unreadable: ${err?.message || 'unknown'}`);
  }
  const seen = new Set();
  const cases = [];
  for (const raw of rawCases) {
    const checked = validateCase(raw, seen);
    if (checked.ok) {
      seen.add(checked.value.id);
      cases.push(checked.value);
    } else {
      errors.push(`${raw?.id || 'unknown'}: ${checked.errors.join(', ')}`);
    }
  }
  return { cases, errors };
}

export const CORPUS = loadCorpus();
export const CONVERSATION_CASES = CORPUS.cases;
export const CASE_VALIDATION_ERRORS = CORPUS.errors;

/** Tags present in the corpus (used by the release test as a coverage gate). */
export function corpusTags(cases = CONVERSATION_CASES) {
  return [...new Set((cases || []).flatMap((caseDef) => caseDef.tags || []))].sort();
}

/**
 * Parse a Sentinel friction snippet (`[user]: ...` / `[assistant]: ...` lines)
 * into a case. Unparseable snippets are skipped with a reason (never guessed).
 */
export function parseFrictionSnippet(snippet = '') {
  const lines = String(snippet || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const turns = [];
  for (const line of lines) {
    const match = line.match(/^\[(user|assistant|model|bot)\]:\s*(.+)$/i);
    if (!match) continue;
    const role = /^(assistant|model|bot)$/i.test(match[1]) ? 'assistant' : 'user';
    const text = String(match[2] || '').trim();
    if (text) turns.push({ role, text: text.slice(0, 1200) });
  }
  if (turns.length < 2) return { ok: false, reason: 'unparseable_snippet' };
  const final = turns[turns.length - 1];
  const reply = final.role === 'assistant' ? final.text : '';
  if (!reply) return { ok: false, reason: 'no_assistant_reply' };
  return { ok: true, turns: turns.slice(0, 10), reply };
}

/**
 * Build judge cases from `chat_friction_logs` rows. Deduped by transcript hash,
 * bounded, and honest about rows it cannot parse.
 */
export function buildLiveCasesFromFriction(rows = [], { limit = 6 } = {}) {
  const cases = [];
  const skipped = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || cases.length >= limit) break;
    const parsed = parseFrictionSnippet(row.transcript_snippet || row.snippet || '');
    if (!parsed.ok) {
      skipped.push({ id: row.id || null, reason: parsed.reason });
      continue;
    }
    const frictionType = String(row.friction_type || 'UNKNOWN').toUpperCase().slice(0, 40);
    const caseDef = {
      id: `live-${String(row.id || frictionType).slice(0, 8)}-${cases.length + 1}`,
      tags: ['live', frictionType.toLowerCase()],
      expected: 'pass',
      source: 'live',
      frictionType,
      frictionLogId: row.id || null,
      turns: parsed.turns,
      reply: parsed.reply,
      note: String(row.transcript_snippet || '').slice(0, 200)
    };
    const hash = caseHash({ id: 'live', turns: parsed.turns, reply: parsed.reply });
    if (seen.has(hash)) {
      skipped.push({ id: row.id || null, reason: 'duplicate' });
      continue;
    }
    seen.add(hash);
    cases.push(caseDef);
  }
  return { cases, skipped };
}

/** Corpus cases for the scheduled tick: deterministic spread across tags. */
export function sampleCorpusCases(limit = 12, cases = CONVERSATION_CASES) {
  const list = Array.isArray(cases) ? [...cases] : [];
  const bounded = Math.max(1, Number(limit) || 12);
  if (list.length <= bounded) return list;
  const step = list.length / bounded;
  return Array.from({ length: bounded }, (_, index) => list[Math.floor(index * step)]).filter(Boolean);
}

