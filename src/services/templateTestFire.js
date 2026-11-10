/**
 * Saka Fleet — superadmin template test-fire + reply-button audit (v1.96.0).
 * ---------------------------------------------------------------------------
 * Two deterministic, zero-token operator surfaces:
 *   • `admin tpl test [kind|all]` — sends a REAL Meta template to the superadmin
 *     phone via the ONE shared transport so the operator can see it arrive.
 *   • `admin tpl buttons` — compares declared ↔ mapped ↔ captured button taps.
 *
 * CONTRACT (pinned by test):
 *  - This module imports ONLY `proactiveTemplates.js` + `metaMessenger.js` — no
 *    database client, no sender, no request context. It therefore cannot stamp
 *    a nudge, a deploy marker, a queue row or a re-engage marker.
 *  - Sending is operator-triggered and capped at 5 sends / 10 minutes per phone
 *    (module-level sliding window, per Cloud Run instance — one operator fires
 *    one command at a time, and the per-phone serial queue serializes turns).
 *  - Audit rows are the CALLER's job (injected `audit` callback) so this module
 *    stays transport + pure formatting.
 */

import {
  PROACTIVE_TEMPLATE_KINDS,
  TEMPLATE_TEST_FIXTURES,
  TEMPLATE_SUGGESTED_NAMES,
  TEMPLATE_BUTTON_TITLES,
  templateVariablesForKind,
  templateButtonState
} from './proactiveTemplates.js';
import { sendWhatsAppTemplateProbe, cleanWhatsAppRecipient, normalizeWhatsAppTargetPhone, maskWhatsAppTargetPhone } from './metaMessenger.js';

export const TEMPLATE_TEST_WINDOW_MS = 10 * 60 * 1000;
export const TEMPLATE_TEST_MAX_SENDS = 5;
export const TEMPLATE_BUTTON_CAPTURE_LIMIT = 20;

export const TEMPLATE_TEST_KINDS = Object.freeze(Object.keys(PROACTIVE_TEMPLATE_KINDS));

// clean phone -> [send timestamps] inside the 10-minute window.
const testFireWindow = new Map();

function liveStamps(phone, now) {
  const key = cleanWhatsAppRecipient(phone);
  if (!key) return [];
  const stamps = (testFireWindow.get(key) || []).filter((stamp) => now - stamp < TEMPLATE_TEST_WINDOW_MS);
  if (stamps.length) testFireWindow.set(key, stamps);
  else testFireWindow.delete(key);
  return stamps;
}

/** Read-only allowance snapshot for one phone (never mutates the window). */
export function templateTestAllowance(phone, { now = Date.now() } = {}) {
  const stamps = liveStamps(phone, now);
  const remaining = Math.max(0, TEMPLATE_TEST_MAX_SENDS - stamps.length);
  let retryMinutes = 0;
  if (remaining === 0 && stamps.length) {
    const oldest = Math.min(...stamps);
    retryMinutes = Math.max(1, Math.ceil((oldest + TEMPLATE_TEST_WINDOW_MS - now) / 60000));
  }
  return { allowed: remaining > 0, used: stamps.length, remaining, retryMinutes };
}

/** Record one send attempt in the sliding window. */
export function recordTemplateTestFire(phone, { now = Date.now() } = {}) {
  const key = cleanWhatsAppRecipient(phone);
  if (!key) return 0;
  const stamps = liveStamps(phone, now);
  stamps.push(now);
  testFireWindow.set(key, stamps);
  return stamps.length;
}

/**
 * Fire the probe for one kind or for every kind. The destination is the
 * operator-typed `targetPhone` (E.164-normalised) or, when omitted,
 * `SUPERADMIN_PHONE`; neither means a graceful refusal (nothing is sent). The
 * rate-limit window is keyed to the ADMIN phone (the operator), never the
 * target, and every audit row carries the target masked.
 *
 * @returns {Promise<{ok:boolean,status:string,requested:string|null,results:Array,remaining:string[],retryMinutes:number,kinds?:string[],targetPhone?:string|null}>}
 */
export async function runTemplateTestFire({
  adminPhone = null,
  kind = 'all',
  targetPhone = null,
  env = process.env,
  now = Date.now(),
  audit = null,
  send = sendWhatsAppTemplateProbe
} = {}) {
  const notify = typeof audit === 'function' ? audit : null;
  const rawTarget = targetPhone === null || targetPhone === undefined ? '' : String(targetPhone).trim();
  const target = rawTarget ? normalizeWhatsAppTargetPhone(rawTarget) : null;
  const adminRecipient = normalizeWhatsAppTargetPhone(env?.SUPERADMIN_PHONE)
    || String(env?.SUPERADMIN_PHONE || '').trim()
    || null;
  const recipient = rawTarget ? target : adminRecipient;
  const maskedTarget = maskWhatsAppTargetPhone(recipient);
  // v1.96.1 — the 5/10-min window follows the OPERATOR, not the target.
  const windowKey = adminPhone || recipient;

  if (kind === null || kind === undefined || String(kind).trim() === '') {
    if (notify) await notify({ status: 'usage', kind: null, adminPhone });
    return { ok: true, status: 'usage', requested: null, results: [], remaining: [], retryMinutes: 0, kinds: [...TEMPLATE_TEST_KINDS] };
  }

  const requested = String(kind).trim().toLowerCase();
  if (!TEMPLATE_TEST_KINDS.includes(requested) && requested !== 'all') {
    if (notify) await notify({ status: 'unknown_kind', kind: requested, adminPhone });
    return { ok: false, status: 'unknown_kind', requested, results: [], remaining: [], retryMinutes: 0, kinds: [...TEMPLATE_TEST_KINDS] };
  }

  if (rawTarget && !target) {
    // v1.96.1 — an invalid target is a deterministic refusal, never a send.
    if (notify) await notify({ status: 'invalid_target', kind: requested, adminPhone, targetPhone: null, rawTarget });
    return { ok: false, status: 'invalid_target', requested, rawTarget, targetPhone: null, results: [], remaining: [], retryMinutes: 0 };
  }

  if (!recipient) {
    if (notify) await notify({ status: 'no_recipient', kind: requested, adminPhone, targetPhone: null });
    return { ok: false, status: 'no_recipient', requested, targetPhone: null, results: [], remaining: [], retryMinutes: 0 };
  }

  const targets = requested === 'all' ? [...TEMPLATE_TEST_KINDS] : [requested];
  const results = [];
  const remaining = [];
  let retryMinutes = 0;

  for (let index = 0; index < targets.length; index += 1) {
    const targetKind = targets[index];
    const def = PROACTIVE_TEMPLATE_KINDS[targetKind];
    const fixtureVars = TEMPLATE_TEST_FIXTURES[targetKind] || {};
    const templateName = String(env?.[def.env] || '').trim() || null;

    if (!templateName) {
      // Never invent a name: the expected template is the documented suggestion.
      const result = {
        kind: targetKind,
        templateName: null,
        status: 'unset_knob',
        wamid: null,
        env: def.env,
        expectedName: TEMPLATE_SUGGESTED_NAMES[targetKind] || null
      };
      results.push(result);
      if (notify) await notify({ ...result, fixtureVars, adminPhone, targetPhone: maskedTarget });
      continue;
    }

    const variables = templateVariablesForKind(targetKind, fixtureVars);
    const buttonState = templateButtonState(targetKind, fixtureVars);
    if (variables === null || buttonState.buttons === null || buttonState.buttons === undefined) {
      const result = { kind: targetKind, templateName, status: 'fixture_invalid', wamid: null };
      results.push(result);
      if (notify) await notify({ ...result, fixtureVars, adminPhone, targetPhone: maskedTarget });
      continue;
    }

    const allowance = templateTestAllowance(windowKey, { now });
    if (!allowance.allowed) {
      retryMinutes = allowance.retryMinutes;
      remaining.push(...targets.slice(index));
      break;
    }
    recordTemplateTestFire(windowKey, { now });

    const capture = {};
    const sent = await send(recipient, templateName, {
      variables,
      buttons: buttonState.buttons,
      env,
      capture
    });
    const result = {
      kind: targetKind,
      templateName,
      status: sent.status,
      wamid: sent.wamid || null,
      ok: Boolean(sent.ok)
    };
    results.push(result);
    if (notify) await notify({ ...result, fixtureVars, adminPhone, targetPhone: maskedTarget });
  }

  const status = remaining.length ? 'cooling_down' : 'done';
  return {
    ok: status === 'done' && results.every((result) => result.status === 'sent'),
    status,
    requested,
    results,
    remaining,
    retryMinutes,
    targetPhone: maskedTarget
  };
}

/**
 * Deterministic reply for a test-fire outcome. Honest about delivery: a wamid
 * means Meta accepted the message; delivery status lives in Cloud Logging / the
 * Meta console (the status webhook does not persist to a table).
 */
export function formatTemplateTestReply(outcome = {}) {
  const status = outcome.status;

  if (status === 'no_recipient') {
    return [
      '🧪 *Template test-fire*',
      '',
      '⚙️ SUPERADMIN_PHONE is not set on this service, so there is no destination for the test — nothing was sent.'
    ].join('\n');
  }

  if (status === 'usage') {
    return [
      '🧪 *Template test-fire*',
      '',
      'Usage: *admin tpl test <kind> [target_phone]* or *admin tpl test all [target_phone]*',
      '',
      `Kinds: ${(outcome.kinds || []).join(', ')}`,
      '',
      '_No target = SUPERADMIN_PHONE. Up to 5 sends per 10 minutes; `all` paces through the registry and says when to run it again._'
    ].join('\n');
  }

  if (status === 'invalid_target') {
    return [
      '🧪 *Template test-fire*',
      '',
      `⚙️ ${outcome.rawTarget || 'That number'} is not a valid phone number — nothing was sent.`,
      'Send the full number with its country code, or a local 07 number, e.g. *admin tpl test re_engagement 0734852529*.'
    ].join('\n');
  }

  if (status === 'unknown_kind') {
    return [
      `⚙️ *${outcome.requested || 'That'}* is not a registered template kind — nothing was sent.`,
      '',
      `Kinds: ${(outcome.kinds || []).join(', ')}`
    ].join('\n');
  }

  const results = Array.isArray(outcome.results) ? outcome.results : [];
  const lines = ['🧪 *Template test-fire*', ''];
  if (outcome.targetPhone) lines.push(`To: ${outcome.targetPhone}`, '');
  for (const result of results) {
    if (result.status === 'sent') {
      lines.push(`✅ ${result.kind} → ${result.templateName} sent — wamid ${result.wamid || 'not returned'}`);
    } else if (result.status === 'delivery_blocked') {
      lines.push(`⛔ ${result.kind} → ${result.templateName} not sent — delivery blocked for this number (no wamid).`);
    } else if (result.status === 'no_credentials') {
      lines.push(`🔑 ${result.kind} → ${result.templateName} not sent — Meta credentials missing on this service (no wamid).`);
    } else if (result.status === 'unset_knob') {
      lines.push(`⚙️ ${result.kind} → ${result.env} is unset — expected template: *${result.expectedName || 'see docs/TEMPLATES.md'}*`);
    } else if (result.status === 'fixture_invalid') {
      lines.push(`⚠️ ${result.kind} → probe fixture is invalid — nothing was sent.`);
    } else {
      lines.push(`❌ ${result.kind} → ${result.templateName || 'template'} rejected by Meta — no wamid. Check Cloud Logging / the Meta console.`);
    }
  }
  const sentCount = results.filter((result) => result.status === 'sent').length;
  lines.push('', `${sentCount}/${results.length} sent.`);
  if ((outcome.remaining || []).length) {
    lines.push(`⏳ Cooling down — run again in ${outcome.retryMinutes || 1} minute(s). Remaining: ${outcome.remaining.join(', ')}`);
  }
  lines.push('_Delivery status lives in Cloud Logging / the Meta console under the wamid above — there is no database delivery trail by design._');
  return lines.join('\n');
}

const cleanPhrase = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Pure three-way comparison for the button audit:
 *   declared = the registry's button shapes (+ the approved titles)
 *   mapped   = BUTTON_TITLE_PHRASES (title -> typed phrase)
 *   captured = recognized taps (chat_history, EXACT phrase match) and
 *              unrecognized shapes (error_logs diagnostics, title read from the
 *              captured stack when present).
 * Captured taps whose title is neither mapped nor declared are flagged.
 */
export function buildTemplateButtonAudit({ titlePhrases = {}, errorRows = [], historyRows = [], limit = TEMPLATE_BUTTON_CAPTURE_LIMIT } = {}) {
  const mapped = Object.entries(titlePhrases || {}).map(([title, phrase]) => ({
    title: cleanPhrase(title).toLowerCase(),
    phrase: cleanPhrase(phrase)
  }));

  const declared = Object.keys(PROACTIVE_TEMPLATE_KINDS)
    .filter((kind) => Array.isArray(PROACTIVE_TEMPLATE_KINDS[kind].buttons) && PROACTIVE_TEMPLATE_KINDS[kind].buttons.length > 0)
    .map((kind) => ({
      kind,
      env: PROACTIVE_TEMPLATE_KINDS[kind].env,
      buttons: PROACTIVE_TEMPLATE_KINDS[kind].buttons.map((button, index) => ({
        subType: String(button?.subType || 'url').toLowerCase(),
        index: button?.index ?? index,
        title: (TEMPLATE_BUTTON_TITLES[kind] || [])[index] || null
      }))
    }));

  const declaredTitles = new Set();
  const kindByTitle = new Map();
  for (const entry of declared) {
    for (const button of entry.buttons) {
      if (!button.title) continue;
      const key = cleanPhrase(button.title).toLowerCase();
      declaredTitles.add(key);
      kindByTitle.set(key, entry.kind);
    }
  }

  const captured = [];
  // Recognized taps: EXACT phrase match only (no substrings, no fuzzy match).
  for (const row of (Array.isArray(historyRows) ? historyRows : []).slice(0, limit)) {
    const message = cleanPhrase(row?.message);
    const hit = mapped.find((entry) => entry.phrase === message);
    if (!hit) continue;
    captured.push({
      source: 'chat_history',
      title: hit.title,
      phrase: hit.phrase,
      kind: kindByTitle.get(hit.title) || null,
      mapped: true,
      declared: declaredTitles.has(hit.title),
      at: row?.created_at || null
    });
  }

  const unrecognized = [];
  for (const row of (Array.isArray(errorRows) ? errorRows : []).slice(0, limit)) {
    let tappedTitle = null;
    try {
      const parsed = JSON.parse(String(row?.stack_trace || ''));
      tappedTitle = parsed?.interactive?.button_reply?.title
        || parsed?.interactive?.list_reply?.title
        || parsed?.button?.text
        || null;
    } catch {
      tappedTitle = null;
    }
    const key = tappedTitle ? cleanPhrase(tappedTitle).toLowerCase() : '';
    const hit = key ? mapped.find((entry) => entry.title === key) : null;
    const record = {
      source: 'error_logs',
      title: tappedTitle || null,
      phrase: hit?.phrase || null,
      kind: key ? (kindByTitle.get(key) || null) : null,
      mapped: Boolean(hit),
      declared: key ? declaredTitles.has(key) : false,
      at: row?.created_at || null
    };
    unrecognized.push(record);
    if (record.title) captured.push(record);
  }

  const unclaimed = captured.filter((entry) => !entry.mapped && !entry.declared);
  const declaredUnmapped = [...declaredTitles].filter((key) => !mapped.some((entry) => entry.title === key));

  return { declared, mapped, captured, unrecognized, unclaimed, declaredUnmapped, limit };
}

/**
 * Query the two live capture sources for the superadmin phone and build the
 * audit. Read-only: `error_logs` (unrecognized interactive diagnostics) and
 * `chat_history` (recognized taps land there as the typed phrase).
 */
export async function runTemplateButtonAudit({ supabase = null, adminPhone = null, titlePhrases = {}, limit = TEMPLATE_BUTTON_CAPTURE_LIMIT } = {}) {
  const cleanPhone = cleanWhatsAppRecipient(adminPhone || '');
  const phraseValues = [...new Set(Object.values(titlePhrases || {}).map((phrase) => cleanPhrase(phrase)))];
  let errorRows = [];
  let historyRows = [];

  if (supabase && cleanPhone) {
    try {
      // Route-scoped read, then an in-code phone-variant filter: error_logs has
      // no phone column (the A1 diagnostic folds `phone=` into error_message),
      // and the stored form may carry a leading plus or not.
      const { data } = await supabase
        .from('error_logs')
        .select('error_message,stack_trace,created_at')
        .eq('route', '/webhook/whatsapp/interactive')
        .order('created_at', { ascending: false })
        .limit(limit);
      const phoneVariants = [`phone=${cleanPhone}`, `phone=+${cleanPhone}`];
      errorRows = (data || []).filter((row) => phoneVariants.some((needle) => String(row?.error_message || '').includes(needle)));
    } catch {
      errorRows = [];
    }

    try {
      // v1.96.0 (MF1) — EXACT match on the mapped target phrases only.
      const { data } = await supabase
        .from('chat_history')
        .select('message,created_at')
        .in('user_phone', [cleanPhone, `+${cleanPhone}`])
        .eq('role', 'user')
        .in('message', phraseValues)
        .order('created_at', { ascending: false })
        .limit(limit);
      historyRows = data || [];
    } catch {
      historyRows = [];
    }
  }

  return { ...buildTemplateButtonAudit({ titlePhrases, errorRows, historyRows, limit }), adminPhone: cleanPhone || null };
}

/** Deterministic digest: declared → mapped → captured, with honest flags. */
export function formatTemplateButtonDigest(audit = {}) {
  const limit = audit.limit || TEMPLATE_BUTTON_CAPTURE_LIMIT;
  const lines = ['🔘 *Template button audit*', ''];

  lines.push('*Declared (registry)*');
  const declared = Array.isArray(audit.declared) ? audit.declared : [];
  if (!declared.length) lines.push('• none');
  for (const entry of declared) {
    const parts = entry.buttons.map((button) => (button.title
      ? `${button.title} (${button.subType})`
      : `${button.subType} @${button.index}`));
    lines.push(`• ${entry.kind}: ${parts.join(' · ')}`);
  }

  lines.push('', '*Mapped (BUTTON_TITLE_PHRASES)*');
  const mapped = Array.isArray(audit.mapped) ? audit.mapped : [];
  lines.push(mapped.length ? `• ${mapped.map((entry) => `${entry.title} → ${entry.phrase}`).join(' · ')}` : '• none');

  lines.push('', `*Captured (last ${limit})*`);
  const captured = Array.isArray(audit.captured) ? audit.captured : [];
  if (!captured.length) {
    lines.push('• none yet — fire a template with `admin tpl test` and tap a button.');
  } else {
    for (const entry of captured) {
      const claimant = entry.mapped ? 'mapped' : (entry.declared ? 'declared, NOT mapped' : 'NO CLAIMANT');
      lines.push(`• ${entry.title || entry.phrase || 'unknown'} → ${entry.phrase || '—'} → ${entry.kind || '—'} (${entry.source}; ${claimant})`);
    }
  }

  const unrecognized = Array.isArray(audit.unrecognized) ? audit.unrecognized : [];
  if (unrecognized.length) lines.push('', `Unrecognized shapes in error_logs: ${unrecognized.length}`);

  const unclaimed = Array.isArray(audit.unclaimed) ? audit.unclaimed : [];
  const declaredUnmapped = Array.isArray(audit.declaredUnmapped) ? audit.declaredUnmapped : [];
  lines.push('');
  if (!unclaimed.length && !declaredUnmapped.length) lines.push('✅ Every captured tap has a named claimant.');
  if (unclaimed.length) lines.push(`⚠️ ${unclaimed.length} captured tap(s) with NO claimant: ${unclaimed.map((entry) => entry.title || 'unknown').join(', ')}`);
  if (declaredUnmapped.length) lines.push(`⚠️ Declared but not mapped: ${declaredUnmapped.join(', ')}`);
  lines.push('_Recognized taps route to a live lane and land in chat_history as the typed phrase; unrecognized shapes are diagnosed in error_logs (/webhook/whatsapp/interactive)._');
  return lines.join('\n');
}

export default {
  TEMPLATE_TEST_WINDOW_MS,
  TEMPLATE_TEST_MAX_SENDS,
  TEMPLATE_BUTTON_CAPTURE_LIMIT,
  TEMPLATE_TEST_KINDS,
  templateTestAllowance,
  recordTemplateTestFire,
  runTemplateTestFire,
  formatTemplateTestReply,
  buildTemplateButtonAudit,
  runTemplateButtonAudit,
  formatTemplateButtonDigest
};
