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
    // v1.95.1 (Phase 32 patch) — the operator's approved saka_reengage carries
    // FOUR Quick Reply buttons: "Log Fuel", "Set Reminder", "Log Expense",
    // "Dashboard". Quick Replies take NO parameters, so each component is
    // declared with its EXPLICIT index (0-3 — templateButtonState defaults a
    // missing index to 0, hence they must be stated) and the sender emits the
    // parameter-free shape that avoids Meta's 131008 rejection.
    buttons: [
      { subType: 'quick_reply', index: 0 },
      { subType: 'quick_reply', index: 1 },
      { subType: 'quick_reply', index: 2 },
      { subType: 'quick_reply', index: 3 }
    ],
    note: '14-day silence nudge (one per owner, capped per sweep; 4 approved quick replies).'
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
    // v1.78.1 (Phase 17.5) - the approved body carries {{1}} version and
    // {{2}} commit/revision; a blank variable degrades to free-form text.
    variables: ['version', 'commit'],
    audience: 'superadmin',
    note: 'One-per-revision Saka is LIVE announcement (version + commit/revision).'
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
    variables: ['driver', 'plate'],
    audience: 'owner',
    note: 'Driver Activity Summary delivered by the pending-owner-notifications worker (index.js).'
  },
  fleet_auto_audit: {
    env: 'META_TPL_FLEET_AUTO_AUDIT',
    variables: ['net'],
    audience: 'owner',
    note: 'Daily fleet auto-audit report announcement (index.js cron).'
  },
  // v1.87.1 (Phase 26B) — codes and invites that MUST deliver outside the
  // 24-hour window: a returning user's sign-in code, a new driver's invite and
  // a buyer's passbook invitation. All three were free-form and silently
  // dropped by Meta after a day of silence (bug: dashboard login failed).
  auth_otp: {
    env: 'META_TPL_AUTH_OTP',
    variables: ['code'],
    audience: 'any',
    // v1.87.3 — the approved Meta Authentication template carries a URL button
    // whose parameter is the code (live proof 2026-11-09: a body-only payload is
    // rejected with 131008 "Button at index 0 of type Url requires a parameter").
    buttons: [{ subType: 'url', index: 0, variable: 'code' }],
    note: 'Six-digit verification codes delivered over WhatsApp (dashboard sign-in). Meta Authentication category; variable {{1}} is the code and the URL button takes the same code.'
  },
  driver_invite: {
    env: 'META_TPL_DRIVER_INVITE',
    variables: ['plate'],
    audience: 'driver',
    note: 'A newly assigned driver is invited to accept the vehicle (reply ACCEPT).'
  },
  transfer_invite: {
    env: 'META_TPL_TRANSFER_INVITE',
    variables: ['plate'],
    audience: 'buyer',
    note: 'A passbook buyer is invited to ACCEPT/DECLINE a transfer (the buyer OTP itself is emailed).'
  },
  // v1.92.0 (Phase 29) — the consolidated overdue compliance digest (D1 hybrid:
  // the episode's first overdue item keeps its immediate alert; later items ride
  // ONE digest at T+3 and ONE at T+7).
  // v1.92.1 — the operator's approved Meta template carries a Quick Reply button
  // (text "Reminders", Custom type), confirmed in Business Manager on 2026-11-09.
  // A Quick Reply needs NO parameters — emitting the parameter-free button
  // component is exactly what avoids the v1.87.3 131008 rejection.
  overdue_digest: {
    env: 'META_TPL_OVERDUE_DIGEST',
    variables: ['count', 'worst_item', 'worst_days'],
    audience: 'owner',
    buttons: [{ subType: 'quick_reply', index: 0 }],
    note: 'T+3 / T+7 consolidated overdue compliance digest (count, worst item, days past due). The approved Meta template carries the Quick Reply button "Reminders" (no parameters); the inbound button_reply routes to the deterministic reminders list.'
  },
  // v1.95.0 (Phase 32, Task 3) — the drip-feed feature tip (T+12h / T+48h).
  // {{1}} = the feature label, {{2}} = its engine-owned link. Appended LAST so
  // the historical kind order stays stable (the registry pin proves it).
  feature_tip: {
    env: 'META_TPL_FEATURE_TIP',
    variables: ['feature', 'link'],
    audience: 'owner',
    note: 'One feature tip after trial activation (one feature per owner, one follow-up while unexplored).'
  }
});

/**
 * v1.96.0 — operator test-fire fixtures. ONE sample `templateVars` object per
 * kind, satisfying the kind's declared body variables AND button variables
 * (auth_otp's URL button takes the same `code`). Used ONLY by the superadmin
 * `admin tpl test` probe; production senders never read these. A test pins
 * 18/18 coverage so a future kind can never ship without a probe fixture.
 */
export const TEMPLATE_TEST_FIXTURES = Object.freeze({
  service_reminder: Object.freeze({ plate: 'KDA 123A' }),
  expiry_reminder: Object.freeze({ item: 'Insurance', due: 'in 7 days' }),
  trial_ending: Object.freeze({ days: '3' }),
  trial_grace: Object.freeze({ tier: 'Growth' }),
  dunning: Object.freeze({ tier: 'Solo Pro', days: '2' }),
  re_engagement: Object.freeze({ name: 'Operator' }),
  driver_unassigned: Object.freeze({ plate: 'KDA 123A' }),
  winback: Object.freeze({ coupon: 'WINBACK40-TEST1' }),
  deploy_live: Object.freeze({ version: 'v1.96.0', commit: 'template-test-fire' }),
  eval_digest_ping: Object.freeze({}),
  care_escalation: Object.freeze({}),
  driver_activity: Object.freeze({ driver: 'Jane', plate: 'KDA 123A' }),
  fleet_auto_audit: Object.freeze({ net: 'KES 4,250' }),
  auth_otp: Object.freeze({ code: '123456' }),
  driver_invite: Object.freeze({ plate: 'KDA 123A' }),
  transfer_invite: Object.freeze({ plate: 'KDA 123A' }),
  overdue_digest: Object.freeze({ count: '3', worst_item: 'Insurance (KDA 123A)', worst_days: '5' }),
  feature_tip: Object.freeze({ feature: 'voice notes', link: 'https://app.sakafleet.com/d/login' })
});

/**
 * v1.96.0 — the SUGGESTED Meta template name per kind (docs/TEMPLATES.md §2),
 * used ONLY to name the expected template when a knob is unset. The code never
 * invents a name: the operator's approved name may differ, and `META_TPL_<KIND>`
 * remains the single source of truth at send time.
 */
export const TEMPLATE_SUGGESTED_NAMES = Object.freeze({
  service_reminder: 'saka_service_reminder',
  expiry_reminder: 'saka_expiry_reminder',
  trial_ending: 'saka_trial_ending',
  trial_grace: 'saka_trial_grace',
  dunning: 'saka_dunning',
  re_engagement: 'saka_reengage',
  driver_unassigned: 'saka_driver_unassigned',
  winback: 'saka_winback',
  deploy_live: 'saka_deploy_live',
  eval_digest_ping: 'saka_eval_digest_ping',
  care_escalation: 'saka_care_escalation',
  driver_activity: 'saka_driver_activity',
  fleet_auto_audit: 'saka_fleet_auto_audit',
  auth_otp: 'saka_otp',
  driver_invite: 'saka_driver_invite',
  transfer_invite: 'saka_transfer_invite',
  overdue_digest: 'saka_overdue_digest',
  feature_tip: 'saka_feature_tip'
});

/**
 * v1.96.0 — the operator-approved TITLE of each declared button (the registry
 * stores only `subType`/`index`; Meta carries the visible title). Drives the
 * `admin tpl buttons` digest's "declared" column. A URL button (auth_otp) opens
 * a link and is never an inbound tap, so it declares no title.
 */
export const TEMPLATE_BUTTON_TITLES = Object.freeze({
  re_engagement: Object.freeze(['Log Fuel', 'Set Reminder', 'Log Expense', 'Dashboard']),
  overdue_digest: Object.freeze(['Reminders']),
  auth_otp: Object.freeze([])
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
 * The full BUTTON state for a kind (v1.92.1):
 *   { status: 'none', buttons: [] }            — no buttons declared
 *   { status: 'ready', buttons: [...] }        — components to send
 *   { status: 'unconfirmed', buttons: null }   — runtime button type not confirmed yet
 *   { status: 'missing_parameter', buttons: null } — a URL button's parameter is absent
 * A `null` buttons list means the caller MUST fall back to free-form text.
 */
export function templateButtonState(kind, values = null) {
  const def = PROACTIVE_TEMPLATE_KINDS[kind];
  if (!def) return { status: 'none', buttons: [] };
  const source = values && typeof values === 'object' ? values : {};

  if (!Array.isArray(def.buttons) || def.buttons.length === 0) return { status: 'none', buttons: [] };
  const out = [];
  for (const button of def.buttons) {
    const subType = String(button?.subType || 'url').toLowerCase();
    const index = String(button.index ?? 0);
    if (subType === 'quick_reply') {
      // v1.92.1 — a Quick Reply returns the button text as a user message and
      // carries NO parameters (a parameter here is what Meta rejects).
      out.push({ type: 'button', sub_type: 'quick_reply', index });
      continue;
    }
    const key = String(button?.variable || '');
    const clean = String(source[key] ?? '').trim();
    if (!clean) return { status: 'missing_parameter', buttons: null };
    out.push({
      type: 'button',
      sub_type: subType,
      index,
      parameters: [{ type: 'text', text: clean }]
    });
  }
  return { status: 'ready', buttons: out };
}

/**
 * Ordered BUTTON components for a kind, or null when the send must degrade to
 * text (a required button variable is missing OR the template's button type is
 * still unconfirmed). Kinds without buttons return [] (a plain body-only
 * template, the pre-v1.87.3 shape).
 */
export function templateButtonsForKind(kind, values = null) {
  return templateButtonState(kind, values).buttons;
}

/**
 * The single routing decision: template (name + ordered variables + buttons) or
 * text. Pure - never sends anything. templateVars keys must cover the kind's
 * declared variables and buttons, else the call degrades to { mode: 'text' }.
 * `reason` names WHY a text fallback happened ('buttons_unconfirmed' /
 * 'button_parameter_missing') so the sender can log it honestly.
 */
export function resolveProactiveMode({ kind = null, templateVars = null } = {}) {
  if (!kind) return { mode: 'text' };
  const def = PROACTIVE_TEMPLATE_KINDS[kind];
  if (!def) return { mode: 'text' };
  const name = templateNameForKind(kind);
  if (!name) return { mode: 'text' };
  const variables = templateVariablesForKind(kind, templateVars);
  if (variables === null) return { mode: 'text' };
  const buttonState = templateButtonState(kind, templateVars);
  if (buttonState.buttons === null) {
    // A URL button's declared parameter is missing — degrade to text (never a
    // Meta 131008 rejection). Quick Reply buttons never reach this branch.
    return { mode: 'text', reason: 'button_parameter_missing' };
  }
  return { mode: 'template', templateName: name, variables, buttons: buttonState.buttons };
}

export default {
  PROACTIVE_TEMPLATE_KINDS,
  PROACTIVE_TEMPLATE_ENV_KEYS,
  PROACTIVE_TEMPLATE_LANGUAGE,
  TEMPLATE_TEST_FIXTURES,
  TEMPLATE_SUGGESTED_NAMES,
  TEMPLATE_BUTTON_TITLES,
  templateNameForKind,
  templateVariablesForKind,
  templateButtonsForKind,
  templateButtonState,
  resolveProactiveMode
};
