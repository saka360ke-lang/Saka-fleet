/**
 * Saka Fleet - Natural Conversational Parser (v1.8)
 * ---------------------------------------------------
 * Replaces rigid step-by-step interrogation with natural entity extraction:
 *
 *  1. DETERMINISTIC pass  - runs every flow field's own parser/validator over
 *     the user's sentence, instantly filling any unambiguous values.
 *  2. AI PASS (DeepSeek)  - reads the same sentence as free text and fills any
 *     remaining missing fields, returning a confidence score plus "extra
 *     notes" for relevant details that do not map to a database column.
 *
 * The parser NEVER writes to the database. It only returns candidate values
 * that the quiz engine validates and merges, then shows in the mandatory
 * confirmation summary before any write happens.
 *
 * Global rule: the parser receives the globalization context (units, locale,
 * language) and every AI result is re-parsed through the flow's own field
 * parser, so imperial/mixed-unit input is canonicalized (km, litres) and
 * localized dates are normalized before they ever reach the state machine.
 */

import { chatCompletion, parseJsonSafely } from './aiClient.js';

export const MAX_EXTRA_NOTE_LENGTH = 280;
export const MAX_EXTRA_NOTES = 6;

const SMALL_TALK_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|sure|yes|no|yep|nope|got it|alright|perfect|please)[.! ]*$/i;
const CONTROL_RE = /^(cancel|exit|stop|quit|abort|restart|start over|reset|skip|later|not now|no thanks|none|na|n\/a|done|finish|help|hint)$/i;

function normalizeNote(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_EXTRA_NOTE_LENGTH);
}

/**
 * Merge new extra-note fragments into the accumulated list. Deduplicates
 * case-insensitively, trims noise (controls/small talk) and caps the list.
 */
export function mergeExtraNotes(existing = [], incoming = []) {
  const merged = [];
  const seen = new Set();
  for (const raw of [...(existing || []), ...(incoming || [])]) {
    const note = normalizeNote(raw);
    if (!note) continue;
    if (SMALL_TALK_RE.test(note) || CONTROL_RE.test(note)) continue;
    if (note.length < 3) continue;
    const key = note.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(note);
    if (merged.length >= MAX_EXTRA_NOTES) break;
  }
  return merged;
}

/** Neatly formatted "extra notes" string for generic text/notes columns. */
export function formatExtraNotes(notes = []) {
  const clean = mergeExtraNotes([], notes);
  if (clean.length === 0) return null;
  return clean.join(' | ');
}

/** A message is substantive when it carries real detail worth keeping. */
export function isSubstantiveText(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  if (SMALL_TALK_RE.test(clean) || CONTROL_RE.test(clean)) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  return words.length >= 3 || /\d/.test(clean);
}

/**
 * Deterministic multi-field extraction: run each unanswered field's parser +
 * validator over the raw sentence. Two passes so conditional fields (e.g. fuel
 * volume once expense_type = Fuel) can fill from the same message.
 */
export function extractDeterministicFields({ text, flowDef, answers = {}, ctx = {} }) {
  const clean = String(text || '').trim();
  const fields = {};
  if (!clean || !flowDef?.fields) return { fields, reached: false };

  const working = { ...answers };
  let reached = false;

  for (let pass = 0; pass < 2; pass += 1) {
    for (const f of flowDef.fields) {
      if (f.when && !f.when(working)) continue;
      if (f.key in working && working[f.key] !== undefined) continue;
      if (f.kind === 'otp') continue;

      let parsed;
      try {
        parsed = f.parse(clean, { ...ctx, answers: working }, working);
      } catch {
        parsed = null;
      }
      if (parsed === null || parsed === undefined) continue;
      if (typeof parsed === 'string' && !parsed.trim()) continue;

      let valid = true;
      try {
        valid = f.validate(parsed, { ...ctx, answers: working }, working)?.ok !== false;
      } catch {
        valid = false;
      }
      if (!valid) continue;

      working[f.key] = parsed;
      fields[f.key] = parsed;
      reached = true;
    }
  }

  return { fields, reached };
}

function fieldSpecForAI(flowDef, answers = {}) {
  const specs = [];
  for (const f of flowDef?.fields || []) {
    if (f.when && !f.when(answers)) continue;
    if (f.key in answers && answers[f.key] !== undefined) continue;
    if (f.kind === 'otp') continue;
    specs.push({
      key: f.key,
      label: f.label,
      hint: f.hint,
      optional: f.optional === true,
      type: typeof answers[f.key] === 'number' ? 'number' : 'text'
    });
  }
  return specs;
}


/**
 * AI-assisted extraction over conversational free text. Returns candidate
 * field values (already normalized through the field parsers) plus extra
 * notes. Never throws; degrades to an empty result on provider failure.
 */
export async function extractWithAI({ text, flowDef, answers = {}, ctx = {}, timeoutMs = 8000 }) {
  if (!process.env.DEEPSEEK_API_KEY) return { fields: {}, extraNotes: [], confidence: 0, skipped: 'no-api-key' };

  const clean = String(text || '').trim();
  if (!clean) return { fields: {}, extraNotes: [], confidence: 0 };

  const specs = fieldSpecForAI(flowDef, answers);
  if (specs.length === 0) return { fields: {}, extraNotes: [], confidence: 1 };

  const collected = Object.fromEntries(
    Object.entries(answers).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );

  const prompt = [
    'Return JSON only: {"fields": {"<key>": <value>}, "extra_notes": ["<detail>"]}.',
    `Flow: ${flowDef?.label || 'conversation'}`,
    `User message: ${JSON.stringify(clean)}`,
    `Already collected: ${JSON.stringify(collected)}`,
    `Missing fields: ${JSON.stringify(specs)}`,
    'Rules:',
    '- Fill ONLY fields the message clearly provides. Never invent values.',
    '- Use the exact field keys from Missing fields.',
    '- Dates must be ISO YYYY-MM-DD; distances in km (convert miles to km); volumes in litres.',
    '- extra_notes = relevant factual details that do NOT map to any field (e.g. station brand, city, part brand, symptoms, work conditions). Keep each note under 200 characters; return [] when nothing applies.'
  ].join('\n');

  let result;
  try {
    result = await Promise.race([
      chatCompletion({
        system: 'You are the Saka Fleet extraction engine. You convert natural language into structured JSON. Respond with valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
        jsonMode: true,
        maxTokens: 600,
        temperature: 0.1
      }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs))
    ]);
  } catch (err) {
    return { fields: {}, extraNotes: [], confidence: 0, error: err.message };
  }

  if (!result?.ok || !result.text) return { fields: {}, extraNotes: [], confidence: 0, error: result?.error || 'empty' };

  const parsed = parseJsonSafely(result.text);
  if (!parsed) return { fields: {}, extraNotes: [], confidence: 0, error: 'unparseable' };

  const fields = {};
  const rawFields = parsed.fields && typeof parsed.fields === 'object' ? parsed.fields : {};
  for (const spec of specs) {
    const raw = rawFields[spec.key];
    if (raw === null || raw === undefined || raw === '') continue;
    const def = (flowDef?.fields || []).find((f) => f.key === spec.key);
    if (!def) continue;
    let value;
    try {
      value = def.parse(String(raw), { ...ctx, answers }, answers);
    } catch {
      value = null;
    }
    if (value === null || value === undefined) continue;
    let valid = true;
    try {
      valid = def.validate(value, { ...ctx, answers }, answers)?.ok !== false;
    } catch {
      valid = false;
    }
    if (!valid) continue;
    fields[spec.key] = value;
  }

  const extraNotes = Array.isArray(parsed.extra_notes)
    ? parsed.extra_notes.map(normalizeNote).filter(Boolean)
    : [];

  const requiredSpecs = specs.filter((s) => !s.optional);
  const filled = requiredSpecs.filter((s) => s.key in fields || s.key in answers).length;
  const confidence = requiredSpecs.length === 0 ? 1 : filled / requiredSpecs.length;

  return { fields, extraNotes, confidence };
}


/**
 * Full natural extraction pipeline: deterministic first, AI top-up for the
 * remaining missing fields, extra-notes consolidation.
 */
export async function extractEntitiesFromText({ text, flowDef, answers = {}, ctx = {}, useAI = true, timeoutMs = 8000 }) {
  const deterministic = extractDeterministicFields({ text, flowDef, answers, ctx });
  const merged = { ...answers, ...deterministic.fields };
  let aiFields = {};
  let extraNotes = [];
  let confidence = null;
  let aiUsed = false;

  const remaining = fieldSpecForAI(flowDef, merged);
  if (useAI && remaining.length > 0) {
    aiUsed = true;
    const ai = await extractWithAI({ text, flowDef, answers: merged, ctx, timeoutMs });
    aiFields = ai.fields || {};
    extraNotes = ai.extraNotes || [];
    confidence = ai.confidence ?? null;
  }

  const allFields = { ...deterministic.fields, ...aiFields };
  const missing = fieldSpecForAI(flowDef, { ...merged, ...aiFields }).filter((s) => !s.optional);

  return {
    fields: allFields,
    extraNotes,
    missing,
    confidence: confidence === null
      ? (missing.length === 0 ? 1 : 0)
      : confidence,
    source: aiUsed ? 'deterministic+ai' : 'deterministic',
    reached: deterministic.reached || Object.keys(aiFields).length > 0
  };
}

export default {
  extractDeterministicFields,
  extractWithAI,
  extractEntitiesFromText,
  mergeExtraNotes,
  formatExtraNotes,
  isSubstantiveText,
  MAX_EXTRA_NOTES,
  MAX_EXTRA_NOTE_LENGTH
};

