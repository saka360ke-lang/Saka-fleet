/**
 * Saka Fleet - Proactive message template registry (v1.63.0, SS182).
 *
 * Meta's 24-hour customer-service window silently swallows free-form
 * proactive messages (SS87.3). Every business-initiated message kind that can
 * fire outside that window gets an approved Meta template slot here.
 *
 * CONTRACT (pure, no I/O):
 *  - One kind per proactive message family. The template BODY lives in Meta
 *    Business Manager (docs/TEMPLATES.md) - never in code. The no-canned-
 *    replies ratchet therefore applies to the fallback text only (SS182).
 *  - Each kind reads its template name from META_TPL_<KIND>. Unset (default)
 *    = today's free-form text, byte-identical behaviour.
 *  - Variables are USER DATA ONLY (name, plate, days, tier, coupon). A
 *    missing/empty variable degrades to the free-form text - a template can
 *    never fire with a broken body parameter.
 *  - resolveProactiveMode is the single routing decision; senders inject the
 *    actual Meta transport (tests never hit the network).
 */

export const PROACTIVE_TEMPLATE_KINDS = Object.freeze({
  service_reminder: {
    env: 'META_TPL_SERVICE_REMINDER',
    variables: ['plate'],
    audience: 'owner_driver',
    note: 'Distance/operating-hours threshold reminders (maintenanceReminders threshold ladder).'
  },
  expiry_reminder: {
    env: 'META_TPL_EXPIRY_REMINDER',
    variables: ['item', 'due'],
    audience: 'owner_driver',
    note: 'Date-based expiry ladder (insurance, inspection, permits, driver licences).'
  },
  trial_ending: {
    env: 'META_TPL_TRIAL_ENDING',
    variables: ['days'],
    audience: 'owner',
    note: 'Pre-expiry ladder: T-14 midpoint, T-3 digest, T-24 urgent, account extension offers, abandoned-checkout nudges.'
  },
  trial_grace: {
    env: 'META_TPL_TRIAL_GRACE',
    variables: ['tier'],
    audience: 'owner',
    note: 'Trial-end decision window: the fitted-plan card, grace countdowns and the hard-expiry fallback.'
  },
  dunning: {
    env: 'META_TPL_DUNNING',
    variables: ['tier', 'days'],
    audience: 'owner',
    note: 'PAST_DUE renewal reminders (T+1 / T+3, two per failed renewal).'
  },
  re_engagement: {
    env: 'META_TPL_RE_ENGAGEMENT',
    variables: ['name'],
    audience: 'owner',
    note: '14-day silence nudge (one per owner, capped per sweep).'
  },
  driver_unassigned: {
    env: 'META_TPL_DRIVER_UNASSIGNED',
    variables: ['plate'],
    audience: 'driver',
    note: 'Driver release notices (owner unassign, vehicle deleted, compliance cancellation).'
  },
  winback: {
    env: 'META_TPL_WINBACK',
    variables: ['coupon'],
    audience: 'owner',
    note: 'D+15 WINBACK40 offer and the D+7 / D+30 post-expiry benefit nudges.'
  },
  deploy_live: {
    env: 'META_TPL_DEPLOY_LIVE',
    variables: [],
    audience: 'superadmin',
    note: 'One-per-revision Saka is LIVE announcement (static body).'
  },
  eval_digest_ping: {
    env: 'META_TPL_EVAL_DIGEST_PING',
    variables: [],
    audience: 'superadmin',
    note: 'One WhatsApp ping per 6-hour eval digest (the detail rides the email; static body).'
  },
  care_escalation: {
    env: 'META_TPL_CARE_ESCALATION',
    variables: [],
    audience: 'care_worker',
    note: 'New-support-ticket ping to the care channel (ticket detail rides the console/email; static body).'
  },
  // v1.63.1 (2B) — Phase 1 completion: two owner-facing proactive senders that
  // the original 11-kind sweep missed (rule-51 correction, section 182).
  driver_activity: {
    env: 'META_TPL_DRIVER_ACTIVITY',
    variables: ['plate', 'driver'],
    audience: 'owner',
    note: 'Driver Activity Summary delivered by the pending-owner-notifications worker (index.js).'
  },
  fleet_auto_audit: {
    env: 'META_TPL_FLEET_AUTO_AUDIT',
    variables: ['net'],
    audience: 'owner',
    note: 'Daily fleet auto-audit report announcement (index.js cron).'
  }
});

export const PROACTIVE_TEMPLATE_ENV_KEYS = Object.freeze(
  Object.values(PROACTIVE_TEMPLATE_KINDS).map((def) => def.env)
);

export const PROACTIVE_TEMPLATE_LANGUAGE = 'en';

/** Template name for a kind, or null when the knob is unset/unknown. */
export function templateNameForKind(kind) {
  const def = PROACTIVE_TEMPLATE_KINDS[kind];
  if (!def || !def.env) return null;
  const name = String(process.env[def.env] || '').trim();
  return name || null;
}

/**
 * Ordered body parameters for a kind, or null when any required variable is
 * missing/empty (the caller must fall back to free-form text). Kinds with an
 * empty variables list return [] (static body, valid).
 */
export function templateVariablesForKind(kind, values = null) {
  const def = PROACTIVE_TEMPLATE_KINDS[kind];
  if (!def) return null;
  const source = values && typeof values === 'object' ? values : {};
  const list = Array.isArray(def.variables) ? def.variables : [];
  if (list.length === 0) return [];
  const out = [];
  for (const key of list) {
    const clean = String(source[key] ?? '').trim();
    if (!clean) return null;
    out.push({ type: 'text', text: clean });
  }
  return out;
}

/**
 * The single routing decision: template (name + ordered variables) or text.
 * Pure - never sends anything. templateVars keys must cover the kind's
 * declared variables, else the call degrades to { mode: 'text' }.
 */
export function resolveProactiveMode({ kind = null, templateVars = null } = {}) {
  if (!kind) return { mode: 'text' };
  const def = PROACTIVE_TEMPLATE_KINDS[kind];
  if (!def) return { mode: 'text' };
  const name = templateNameForKind(kind);
  if (!name) return { mode: 'text' };
  const variables = templateVariablesForKind(kind, templateVars);
  if (variables === null) return { mode: 'text' };
  return { mode: 'template', templateName: name, variables };
}

export default {
  PROACTIVE_TEMPLATE_KINDS,
  PROACTIVE_TEMPLATE_ENV_KEYS,
  PROACTIVE_TEMPLATE_LANGUAGE,
  templateNameForKind,
  templateVariablesForKind,
  resolveProactiveMode
};
