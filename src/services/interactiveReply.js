/**
 * Saka Fleet — Interactive Reply Builder (v1.51.10)
 * ------------------------------------------------
 * SUG-2026-11-03-01 clause 7: "Integrate with WhatsApp interactive messages
 * for quick edits."
 *
 * This module is PURE and STATELESS — it turns an existing deterministic reply
 * into a WhatsApp Cloud API `interactive` payload (reply BUTTONS for 1-3
 * actions, a reply LIST for 4-10) plus a mandatory plain-text fallback.
 *
 * Boundaries (permanent):
 *  - It NEVER sends anything. The outbound sender in src/routes/whatsapp.js
 *    stays type:"text"; a payload only reaches the wire once the Superadmin
 *    registers/tests the buttons on the WABA (never ship dead buttons).
 *  - It NEVER widens an editable whitelist. Quick-edit buttons reuse the live
 *    operators (`my entries`, the compliance-correction detector, the vehicle
 *    edit quiz) and inherit their enforcement; the VIN is never offered
 *    (rule 8 — `qr_passbook_token` likewise).
 *  - It never throws: every function degrades to the text fallback.
 *  - Plain, gender-neutral, age-safe copy (rule 31).
 */

/** Cloud API hard limits. */
export const INTERACTIVE_LIMITS = Object.freeze({
  titleMax: 20,
  bodyMax: 1024,
  buttonTextMax: 20,
  buttonIdMax: 256,
  maxButtons: 3,
  maxListRows: 10,
  rowTitleMax: 24,
  rowDescriptionMax: 72
});

/**
 * Fields a quick-edit button may target. Aggregates the two existing whitelists
 * (`edit_vehicle_fields` for vehicles, `sanitizeEntryUpdate` for the ledger) and
 * deliberately excludes the immutable identifiers.
 */
export const QUICK_EDIT_ACTIONS = Object.freeze({
  EDIT_VEHICLE: { label: 'Edit vehicle', operator: 'edit vehicle', fields: ['plate_number', 'nickname', 'make_model', 'yom', 'fuel_type'] },
  EDIT_ENTRY: { label: 'Edit entries', operator: 'my entries', fields: ['expense_type', 'amount', 'fuel_liters', 'fill_type', 'odometer_reading', 'notes'] },
  CORRECT_DOC: { label: 'Correct upload', operator: 'you read it wrong', fields: ['compliance_expiry', 'insurance_expiry', 'inspection_expiry', 'insurance_policy', 'compliance_number'] },
  REGISTER: { label: 'Register vehicle', operator: 'REGISTER', fields: ['plate_number', 'make_model', 'yom', 'vin'] }
});

/** Identifiers that may NEVER be offered as a quick edit (rule 8). */
export const INTERACTIVE_LOCKED_FIELDS = Object.freeze(['vin', 'qr_passbook_token', 'vehicle_id', 'driver_id', 'user_id', 'entry_date']);

/**
 * Registered payload ID -> the exact typed operator Saka already understands
 * (docs/TEMPLATES.md §5; D1 locked).
 * `remind_me` maps to `reminders` (the due LIST the template body promises:
 * "Reply reminders to see what is coming up") — never `remind me`, which starts
 * the set_reminder quiz instead.
 *
 * v1.96.0 — these two registries MOVED here from the route leaf
 * (`src/routes/whatsapp/interactive.js`) so service-side consumers (the
 * superadmin `admin tpl buttons` audit) can read them without a service
 * importing a route module (the §190 boundary). The leaf re-exports them
 * byte-identically; every existing importer keeps working unchanged.
 */
export const BUTTON_PAYLOAD_PHRASES = Object.freeze({
  remind_me: 'reminders',
  reminders: 'reminders',
  subscription: 'subscription',
  keep_all: 'keep all',
  help: 'help'
});

/**
 * TITLE aliases for an UNREGISTERED payload id (v1.92.1; extended v1.95.1).
 * Meta's template quick replies can carry a generated id, so the button's own
 * text is the reliable signal. "Reminders" / "Reminder" / "Remind me" must
 * reach the deterministic reminders LIST (never the remind-me quiz — the D1
 * law). The four v1.95.1 entries map `saka_reengage`'s approved Quick Replies
 * ("Log Fuel", "Set Reminder", "Log Expense", "Dashboard") to the exact typed
 * phrases the live grammar already owns.
 */
export const BUTTON_TITLE_PHRASES = Object.freeze({
  reminders: 'reminders',
  reminder: 'reminders',
  'remind me': 'reminders',
  'log fuel': 'fuel',
  'set reminder': 'set reminder',
  'log expense': 'log expense',
  dashboard: 'dashboard'
});

function trim(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** True when `field` is a permanent identifier (never editable). */
export function isLockedInteractiveField(field) {
  const key = String(field || '').trim().toLowerCase();
  return !key || INTERACTIVE_LOCKED_FIELDS.includes(key);
}

/**
 * Build one reply button, or null when the action/field is unknown or locked.
 * @returns {{type:string, reply:{id:string,title:string}}|null}
 */
export function buildReplyButton({ action, field = null } = {}) {
  const key = String(action || '').trim().toUpperCase();
  const meta = QUICK_EDIT_ACTIONS[key];
  if (!meta) return null;
  if (field !== null && isLockedInteractiveField(field)) return null;
  const id = field ? `${key.toLowerCase()}:${String(field).trim().toLowerCase()}` : key.toLowerCase();
  return {
    type: 'reply',
    reply: { id: trim(id, INTERACTIVE_LIMITS.buttonIdMax), title: trim(meta.label, INTERACTIVE_LIMITS.buttonTextMax) }
  };
}

/** Resolve a button id back to its action + field (null when unknown). */
export function resolveQuickEditButtonId(buttonId = '') {
  const raw = String(buttonId || '').trim().toLowerCase();
  if (!raw) return null;
  const [actionKey, field] = raw.split(':');
  const action = actionKey.toUpperCase();
  const meta = QUICK_EDIT_ACTIONS[action];
  if (!meta) return null;
  if (field && isLockedInteractiveField(field)) return null;
  return { action, field: field || null, operator: meta.operator };
}

/**
 * Build a full interactive payload from a deterministic text reply.
 * 1-3 actions  → `interactive.type = 'button'`
 * 4-10 actions → `interactive.type = 'list'`
 * 0 actions    → `null` (caller sends plain text)
 *
 * @returns {{type:string, interactive:object, fallbackText:string}|null}
 */
export function buildInteractiveReply({ body, header = null, footer = null, actions = [] } = {}) {
  try {
    const text = trim(body, INTERACTIVE_LIMITS.bodyMax);
    if (!text) return null;
    const list = (Array.isArray(actions) ? actions : [])
      .filter((entry) => entry && entry.action)
      .slice(0, INTERACTIVE_LIMITS.maxListRows);
    if (list.length === 0) return null;

    const label = (entry) => QUICK_EDIT_ACTIONS[String(entry.action).toUpperCase()]?.label || entry.label || entry.action;
    const fallbackText = [
      `${header ? `${header}\n\n` : ''}${text}`,
      list.map((entry, index) => `${index + 1}. ${label(entry)}`).join('\n')
    ].filter(Boolean).join('\n\n');

    if (list.length <= INTERACTIVE_LIMITS.maxButtons) {
      const buttons = list.map(buildReplyButton).filter(Boolean).slice(0, INTERACTIVE_LIMITS.maxButtons);
      if (buttons.length === 0) return null;
      const interactive = { type: 'button', body: { text }, action: { buttons } };
      if (header) interactive.header = { type: 'text', text: trim(header, INTERACTIVE_LIMITS.titleMax) };
      if (footer) interactive.footer = { text: trim(footer, 60) };
      return { type: 'interactive', interactive, fallbackText };
    }

    const rows = list.map((entry) => {
      const button = buildReplyButton(entry);
      if (!button) return null;
      return {
        id: button.reply.id,
        title: trim(button.reply.title, INTERACTIVE_LIMITS.rowTitleMax),
        description: trim(entry.description || '', INTERACTIVE_LIMITS.rowDescriptionMax)
      };
    }).filter(Boolean);
    if (rows.length === 0) return null;
    const interactive = {
      type: 'list',
      body: { text },
      action: {
        button: 'Choose one',
        sections: [{ title: trim(header || 'Quick edits', INTERACTIVE_LIMITS.titleMax), rows: rows.slice(0, INTERACTIVE_LIMITS.maxListRows) }]
      }
    };
    if (header) interactive.header = { type: 'text', text: trim(header, INTERACTIVE_LIMITS.titleMax) };
    if (footer) interactive.footer = { text: trim(footer, 60) };
    return { type: 'interactive', interactive, fallbackText };
  } catch {
    return null;
  }
}

/**
 * The Superadmin-ready quick-edit card (deterministic, zero AI tokens).
 * Renders the interactive payload AND the exact text a normal user would see,
 * so the Superadmin can validate the copy before the buttons go live on the WABA.
 */
export function formatQuickEditPreview({ plate = null } = {}) {
  const subject = plate ? `*${plate}*` : 'your records';
  const body = `✏️ *Quick edits for ${subject}*\n\nPick an option below and reply with the change — nothing updates until you confirm.`;
  const payload = buildInteractiveReply({
    header: 'Saka quick edits',
    body,
    footer: '🔒 VIN and dates stay locked',
    actions: [
      { action: 'EDIT_VEHICLE', description: 'Plate, make, year or fuel' },
      { action: 'EDIT_ENTRY', description: 'Fix the last logged figures' },
      { action: 'CORRECT_DOC', description: 'Fix a document expiry' }
    ]
  });
  const lines = [
    '🧩 *Interactive quick-edit preview*',
    '',
    `• Payload type: *${payload?.interactive?.type || 'text (fallback)'}*`,
    `• Reply buttons: ${payload?.interactive?.action?.buttons?.length ?? 0}`,
    '• Locked forever: VIN, passbook token, vehicle, driver, user, entry date 🔒',
    '• Buttons send the same operators users already type (`my entries`, `edit vehicle`, a typed correction).',
    '',
    '*What the user sees when buttons are unavailable:*',
    payload?.fallbackText || body
  ];
  return { reply: lines.join('\n'), payload };
}

export default {
  INTERACTIVE_LIMITS,
  QUICK_EDIT_ACTIONS,
  INTERACTIVE_LOCKED_FIELDS,
  BUTTON_PAYLOAD_PHRASES,
  BUTTON_TITLE_PHRASES,
  isLockedInteractiveField,
  buildReplyButton,
  resolveQuickEditButtonId,
  buildInteractiveReply,
  formatQuickEditPreview
};
