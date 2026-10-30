/**
 * Saka Fleet — Pure AI Conversational Engine
 * -----------------------------------------
 * Every user-facing WhatsApp message is rendered dynamically by Saka AI
 * (DeepSeek-V3) from STRUCTURED FACTS. No pre-formatted conversational
 * templates live in this file or in the flows that use it.
 *
 * Design contract:
 *  - The state machine owns the FACTS (what was collected, what is missing,
 *    what succeeded/failed). The AI owns the PROSE.
 *  - Security-critical payloads (OTP codes, VIN lock notices, amounts, dates)
 *    are passed as facts so the AI can never invent or omit them.
 *  - On provider failure we degrade to a terse, data-only fallback instead of
 *    a canned paragraph. This keeps flows deterministic without re-introducing
 *    rigid templates.
 */

import { chatCompletion } from './aiClient.js';
import { buildGlobalContext, formatDate, formatMoney, formatNumber } from './globalization.js';

const LANGUAGE_HINT = (language) => (language && language !== 'English'
  ? `Write in ${language}. If the user writes in another language, mirror it.`
  : 'Reply in the user\'s language (auto-detect; default English).');

/**
 * Map a compose purpose to the AI router purpose (tier + telemetry). Quiz
 * question renders and background nudges never need the conversational tier;
 * every other render is prose (Tier 2 when premium routing is enabled).
 */
const ROUTER_PURPOSE_BY_COMPOSE = Object.freeze({
  quiz_intro_question: 'question_render',
  quiz_next_question: 'question_render',
  conversation_stall_nudge: 'stall_nudge'
});

function routerPurposeForCompose(purpose) {
  return ROUTER_PURPOSE_BY_COMPOSE[purpose] || 'prose_render';
}

function globalizationLines(globalCtx) {
  return [
    `Country: ${globalCtx.country} (${globalCtx.countryCode})`,
    `Currency: ${globalCtx.currency}`,
    `Units: ${globalCtx.unitSystem} (distance ${globalCtx.labels.distance}, volume ${globalCtx.labels.volume}, economy ${globalCtx.labels.fuelEconomy})`,
    `Locale: ${globalCtx.locale}`,
    `Plate format example: ${globalCtx.plateExample}`
  ].join('\n');
}

/**
 * Core AI composer. Returns plain WhatsApp-ready text (never JSON).
 */
export async function composeMessage({
  purpose,
  facts = {},
  language = 'English',
  countryInfo = null,
  profile = null,
  history = [],
  extraInstructions = '',
  maxTokens = 420,
  fallbackText = ''
} = {}) {
  const globalCtx = buildGlobalContext(countryInfo, profile);

  const system = [
    'You are Saka, the conversational fleet-operating assistant for Saka Fleet on WhatsApp.',
    'VOICE & EMPATHY: always warm, empathetic and professional. Mirror the user\'s language and emotional register — a frustrated user gets calm reassurance before any instructions, a happy user gets matching energy.',
    'Never sound robotic, bureaucratic or template-like: vary phrasing naturally, keep Saka\'s friendly one-question-at-a-time style, and lead with empathy whenever something went wrong.',
    'You write ONE concise WhatsApp message at a time. You never dump long menus.',
    'You serve a GLOBAL audience: always localize units, currency, dates and plate examples to the user\'s region.',
    'Use only the FACTS provided. Never invent values, codes, amounts or dates. Never omit security-critical facts.',
    'The FACTS block is the only source of truth for flow state: reflect every collected item, and never add, drop or reorder required items.',
    'Maintenance facts may carry distance (km or mi), operating hours, or remaining-vs-target thresholds: always show the unit supplied and never convert silently.',
    'Expiry facts may carry insurance, inspection/MOT, licensing, permit, driver-licence or general-deadline dates: always show the due date, the resolved timezone and the days remaining exactly as supplied.',
    'Driver assignment facts follow an owner email OTP and a driver ACCEPT handshake: never claim an assignment is complete before the driver accepts, and never expose the OTP.',
    'Driver compliance facts come from the regional catalog: distinguish the mandatory minimal item from optional extras, always state the expiry (or valid-for-life status) and never invent a legal requirement.',
    'Report facts come from the fleet report engine: present the supplied totals, currency and units faithfully and never recompute or invent figures.',
    'The autonomous code-remediation pipeline (Sentinel audit → Cline plan → Superadmin approval → CI execution) runs outside WhatsApp and is superadmin-only: never mention, simulate or claim its actions, and never claim to edit code or deploy releases.',
    "Dates and times are resolved in the user's confirmed timezone; when a timezone appears in the facts, include it once so the user can confirm it.",
    'Keep it warm, human and short (max ~110 words unless the facts require a summary list).',
    'Use WhatsApp formatting (*bold*, _italic_, `code`). Plain text only, no JSON, no markdown tables.',
    LANGUAGE_HINT(language),
    globalizationLines(globalCtx),
    extraInstructions
  ].filter(Boolean).join('\n');

  const factsBlock = { purpose, facts, globalization: globalCtx };

  const messages = [
    ...history,
    { role: 'user', content: `Compose the next Saka message from these facts:\n${JSON.stringify(factsBlock)}` }
  ];

  const result = await chatCompletion({
    system,
    messages,
    jsonMode: false,
    maxTokens,
    temperature: 0.5,
    purpose: routerPurposeForCompose(purpose)
  });
  if (result.ok && result.text && result.text.trim()) {
    return result.text.trim();
  }
  return fallbackText;
}

/**
 * Question body cache: quiz questions repeat across turns and users, so the
 * AI-rendered question is reused instead of paying a model round trip per turn.
 */
const QUESTION_CACHE_TTL_MS = Number(process.env.QUIZ_QUESTION_CACHE_MS || 15 * 60 * 1000);
const QUESTION_CACHE_MAX = Number(process.env.QUIZ_QUESTION_CACHE_MAX || 300);
const questionCache = new Map();

// Action-discovery renders are role + command + locale stable. Cache them so the
// most common free-chat turn never pays an AI round trip (v1.16.2).
const DISCOVERY_CACHE_TTL_MS = Number(process.env.ACTION_DISCOVERY_CACHE_MS || 15 * 60 * 1000);
const DISCOVERY_CACHE_MAX = Number(process.env.ACTION_DISCOVERY_CACHE_MAX || 200);
const discoveryCache = new Map();

export function clearQuizQuestionCache() {
  questionCache.clear();
}

function normalizeFieldLabel(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function questionCacheKey(flowLabel, fieldLabel, language, isFirst) {
  return `${flowLabel}|${normalizeFieldLabel(fieldLabel)}|${language}|${isFirst ? 'first' : 'next'}`;
}

/** True when most of a flow's questions are already cached (skip re-prefetch). */
export function isQuizQuestionCacheWarm(flowLabel, language, minimum = 3) {
  const prefix = `${flowLabel}|`;
  const suffix = `|${language}|next`;
  let count = 0;
  for (const [key, entry] of questionCache.entries()) {
    if (key.startsWith(prefix) && key.endsWith(suffix) && entry.expiresAt > Date.now()) {
      count += 1;
      if (count >= minimum) return true;
    }
  }
  return false;
}

/** Seed the cache from a batched prefetch (one AI call for a whole flow). */
export function seedQuizQuestions(flowLabel, language, questionMap = {}) {
  for (const [fieldLabel, text] of Object.entries(questionMap || {})) {
    if (!fieldLabel || !text) continue;
    const cacheKey = questionCacheKey(flowLabel, fieldLabel, language, false);
    if (questionCache.size >= QUESTION_CACHE_MAX) {
      questionCache.delete(questionCache.keys().next().value);
    }
    questionCache.set(cacheKey, { text: String(text).trim(), expiresAt: Date.now() + QUESTION_CACHE_TTL_MS });
  }
}

/**
 * Quiz question renderer — exactly ONE question per turn.
 */
export async function renderQuizQuestion({
  flowLabel,
  fieldLabel,
  hint,
  answers = {},
  collectedLabels = [],
  language = 'English',
  countryInfo = null,
  profile = null,
  isFirst = false,
  isLast = false,
  lastAcceptedAnswer = null,
  turnNote = null,
  dispatchFailed = false
}) {
  const cacheKey = questionCacheKey(flowLabel, fieldLabel, language, isFirst);

  // Serve the cached AI-authored question (no acknowledgment text) when we are
  // not re-asking after an error. The cache key is flow+field only, so the
  // cached text must stay free of any address, code or per-session value.
  if (!turnNote) {
    const hit = questionCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.text;
  }

  const facts = {
    flow: flowLabel,
    currentQuestion: fieldLabel,
    questionHint: hint,
    turnNote,
    // Boolean derived from the caller — never a raw address, code or step
    // target, so nothing per-session can leak into the shared cache.
    dispatchFailed: Boolean(dispatchFailed),
    // Deliberately data-free: the cached question must never reference values
    // from a previous user/session (prevents stale acknowledgments).
    instruction: 'State the current question exactly once and ask ONLY for that. If the engine reports the question was already answered, acknowledge that briefly and never repeat it. Do not acknowledge or praise any answer — never invent one. Do not ask for anything else. Do not list future questions. If dispatchFailed is true, say the last message could not be sent and offer to resend or use a different address.'
  };

  const fallback = `${fieldLabel}: ${hint}`;
  const reply = await composeMessage({
    purpose: isFirst ? 'quiz_intro_question' : 'quiz_next_question',
    facts,
    language,
    countryInfo,
    profile,
    maxTokens: 220,
    fallbackText: fallback
  });

  if (!turnNote && reply) {
    if (questionCache.size >= QUESTION_CACHE_MAX) {
      const oldestKey = questionCache.keys().next().value;
      questionCache.delete(oldestKey);
    }
    questionCache.set(cacheKey, { text: reply, expiresAt: Date.now() + QUESTION_CACHE_TTL_MS });
  }

  return reply;
}

/**
 * Confirmation summary renderer — the user must explicitly confirm before any
 * database write happens.
 */
export async function renderConfirmationSummary({
  flowLabel,
  summaryRows = [],
  notes = [],
  language = 'English',
  countryInfo = null,
  profile = null,
  confirmWord = 'CONFIRM'
}) {
  const facts = {
    flow: flowLabel,
    summaryRows,
    notes,
    instruction: `Present a clean checklist summary of every collected item. End by asking the user to reply ${confirmWord} to save, or to name any field they want to change. Do not invent missing values. If a note starts with "Extra note:", show it under a short Extra notes section.`
  };

  const fallbackLines = summaryRows.map((r) => `• ${r.label}: ${r.value}`).join('\n');
  const noteLines = (notes || []).length
    ? `\n\nExtra notes:\n${notes.map((n) => `• ${n}`).join('\n')}`
    : '';
  const fallback = `${flowLabel}\n${fallbackLines}${noteLines}\n\nReply ${confirmWord} to save or name a field to change.`.trim();

  return composeMessage({
    purpose: 'confirmation_summary',
    facts,
    language,
    countryInfo,
    profile,
    maxTokens: 520,
    fallbackText: fallback
  });
}

/**
 * Outcome renderer — success/failure messages after a database action.
 */
export async function renderOutcome({
  flowLabel,
  success = true,
  facts = {},
  language = 'English',
  countryInfo = null,
  profile = null
}) {
  const fallback = success
    ? `✅ ${flowLabel}: done.\n${Object.entries(facts).map(([k, v]) => `• ${k}: ${v}`).join('\n')}`.trim()
    : `⚠️ ${flowLabel} could not be completed: ${facts.error || 'unknown error'}`;

  return composeMessage({
    purpose: success ? 'flow_success' : 'flow_failure',
    facts: { flow: flowLabel, success, ...facts },
    language,
    countryInfo,
    profile,
    maxTokens: 320,
    fallbackText: fallback
  });
}

/**
 * Role-aware action discovery, rendered by AI from the permitted command list.
 * Replaces the static command-center menus.
 */
export async function renderActionDiscovery({
  roles = [],
  commands = [],
  vehicles = [],
  language = 'English',
  countryInfo = null,
  profile = null,
  exhaustive = false
}) {
  const cacheKey = [
    exhaustive ? 'x' : 's',
    language,
    roles.join(','),
    commands.join('|'),
    vehicles.map((v) => v.plate_number || '').join(',')
  ].join('::');
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.text;

  const facts = {
    roles,
    availableCommands: commands,
    fleet: vehicles.map((v) => `${v.plate_number} (${v.make_model || 'vehicle'})`),
    instruction: exhaustive
      ? 'List EVERY available command, grouped naturally by role. Do not omit any command and do not invent one. Keep each line short.'
      : 'Give a short, role-aware capability overview grouped naturally. Mention the 3-5 most useful next steps only; do not dump the entire command list.'
  };

  const fallback = commands.slice(0, 6).map((c) => `• ${c}`).join('\n');
  const text = await composeMessage({
    purpose: 'action_discovery',
    facts,
    language,
    countryInfo,
    profile,
    maxTokens: 420,
    fallbackText: fallback
  });

  if (text) {
    if (discoveryCache.size >= DISCOVERY_CACHE_MAX) {
      discoveryCache.delete(discoveryCache.keys().next().value);
    }
    discoveryCache.set(cacheKey, { text, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS });
  }
  return text;
}

/**
 * Formatting helpers re-exported for quiz executors so summaries stay consistent.
 */
export function summarizeValue(value, { countryInfo, profile } = {}) {
  const ctx = buildGlobalContext(countryInfo, profile);
  if (value === null || value === undefined || value === '') return '—';
  if (value instanceof Date) return formatDate(value, ctx.locale);
  if (typeof value === 'number') return formatNumber(value, ctx.locale);
  return String(value);
}

export function summarizeMoney(amount, { countryInfo, profile } = {}) {
  const ctx = buildGlobalContext(countryInfo, profile);
  return formatMoney(amount, ctx.currency, ctx.locale);
}

export default {
  composeMessage,
  renderQuizQuestion,
  renderConfirmationSummary,
  renderOutcome,
  renderActionDiscovery,
  summarizeValue,
  summarizeMoney
};

