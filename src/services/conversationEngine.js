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
    'You write ONE concise WhatsApp message at a time. You never dump long menus.',
    'You serve a GLOBAL audience: always localize units, currency, dates and plate examples to the user\'s region.',
    'Use only the FACTS provided. Never invent values, codes, amounts or dates. Never omit security-critical facts.',
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

  const result = await chatCompletion({ system, messages, jsonMode: false, maxTokens, temperature: 0.5 });
  if (result.ok && result.text && result.text.trim()) {
    return result.text.trim();
  }
  return fallbackText;
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
  isLast = false
}) {
  const facts = {
    flow: flowLabel,
    currentQuestion: fieldLabel,
    questionHint: hint,
    alreadyCollected: collectedLabels,
    answers,
    progress: `${collectedLabels.length + 1}${isLast ? ' (final question)' : ''}`,
    instruction: 'Ask ONLY the current question. Briefly acknowledge the previous answer if one exists. Do not ask for anything else. Do not list future questions.'
  };

  const fallback = `${fieldLabel}: ${hint}`;
  return composeMessage({
    purpose: isFirst ? 'quiz_intro_question' : 'quiz_next_question',
    facts,
    language,
    countryInfo,
    profile,
    maxTokens: 220,
    fallbackText: fallback
  });
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
    instruction: `Present a clean checklist summary of every collected item. End by asking the user to reply ${confirmWord} to save, or to name any field they want to change. Do not invent missing values.`
  };

  const fallbackLines = summaryRows.map((r) => `• ${r.label}: ${r.value}`).join('\n');
  const fallback = `${flowLabel}\n${fallbackLines}\n\nReply ${confirmWord} to save or name a field to change.`.trim();

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
  profile = null
}) {
  const facts = {
    roles,
    availableCommands: commands,
    fleet: vehicles.map((v) => `${v.plate_number} (${v.make_model || 'vehicle'})`),
    instruction: 'Give a short, role-aware capability overview grouped naturally. Mention the 3-5 most useful next steps only; do not dump the entire command list.'
  };

  const fallback = commands.slice(0, 6).map((c) => `• ${c}`).join('\n');
  return composeMessage({
    purpose: 'action_discovery',
    facts,
    language,
    countryInfo,
    profile,
    maxTokens: 420,
    fallbackText: fallback
  });
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

