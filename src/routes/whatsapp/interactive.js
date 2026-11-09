/**
 * Saka Fleet — inbound interactive replies (Phase 12B, v1.73.4)
 * ------------------------------------------------------------
 * WhatsApp template quick-reply buttons and interactive list rows arrive as
 * `messages[0].interactive` (Meta Cloud API webhook reference):
 *
 *   interactive.type = 'button_reply' -> { button_reply: { id, title } }
 *   interactive.type = 'list_reply'   -> { list_reply:   { id, title, description } }
 *
 * Older button-template replies arrive as `messages[0].button` -> { text, payload }.
 *
 * This module is PURE and STATELESS: it turns those shapes into the ONE thing the
 * processor consumes — the typed text the user would otherwise have sent — so a
 * button tap reuses the LIVE grammar (no new intents, no prompt changes, rule 13).
 *
 * BOUNDARY CONTRACT (section 189): a leaf route module. It imports from
 * src/services/* only (never messages.js), takes state as arguments and returns
 * data. It never sends, never composes and never throws.
 *
 * Registry (D1, locked): BUTTON_PAYLOAD_PHRASES mirrors docs/TEMPLATES.md
 * section 5 — the approval contract for the payload ids registered on the WABA.
 * Buttons are not registered on the templates yet; this registry is the contract
 * for when they are. An unregistered payload falls back to the button's own
 * title, so Saka can always answer what the user just tapped.
 */
import { resolveQuickEditButtonId } from '../../services/interactiveReply.js';

/**
 * Registered payload id -> the exact typed operator Saka already understands.
 * D1: `remind_me` maps to `reminders` (the due LIST the template body promises:
 * "Reply reminders to see what is coming up") — never `remind me`, which starts
 * the set_reminder quiz instead.
 */
export const BUTTON_PAYLOAD_PHRASES = Object.freeze({
  remind_me: 'reminders',
  reminders: 'reminders',
  subscription: 'subscription',
  keep_all: 'keep all',
  help: 'help'
});

/**
 * v1.92.1 — TITLE aliases for an UNREGISTERED payload id. Meta's template quick
 * replies can carry a generated id, so the button's own text is the reliable
 * signal. "Reminders" / "Remind me" must reach the deterministic reminders LIST
 * (never the remind-me quiz — the D1 law), exactly like the registered ids.
 */
export const BUTTON_TITLE_PHRASES = Object.freeze({
  reminders: 'reminders',
  reminder: 'reminders',
  'remind me': 'reminders'
});

// Defensive caps: a Cloud API payload id is <= 256 chars and a title is short.
// Nothing downstream expects more, and a malformed blob can never flood a turn.
const MAX_TEXT = 200;
const MAX_PAYLOAD = 256;

function clean(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Parse one inbound WhatsApp message object into the turn's typed text.
 *
 * @returns {{text:string, payload:string|null, intent:string|null}|null}
 *   null when the message carries no interactive/button reply, when the shape is
 *   not one Meta documents (product, nfm_reply, missing reply object, ...) or
 *   when there is nothing a user could have typed. The processor logs the
 *   unrecognised shapes to error_logs for diagnosis — never guesses.
 */
export function parseInteractiveReply(messageObj) {
  try {
    const message = objectOf(messageObj);
    if (!message) return null;

    const interactive = objectOf(message.interactive);
    let title = '';
    let payload = '';

    if (interactive) {
      const interactiveType = String(interactive.type || '').trim().toLowerCase();
      if (interactiveType === 'button_reply') {
        const reply = objectOf(interactive.button_reply);
        if (!reply) return null;
        title = reply.title;
        payload = reply.id;
      } else if (interactiveType === 'list_reply') {
        const reply = objectOf(interactive.list_reply);
        if (!reply) return null;
        title = reply.title;
        payload = reply.id;
      } else {
        // product / nfm_reply / any future type: unrecognised by design.
        return null;
      }
    } else {
      const legacy = objectOf(message.button);
      if (!legacy) return null;
      title = legacy.text;
      payload = legacy.payload;
    }

    const cleanPayload = clean(payload, MAX_PAYLOAD);
    const cleanTitle = clean(title, MAX_TEXT);
    if (!cleanPayload && !cleanTitle) return null;

    let text = cleanTitle;
    let intent = null;

    if (cleanPayload) {
      const phrase = BUTTON_PAYLOAD_PHRASES[cleanPayload.toLowerCase()];
      if (phrase) {
        // The registered phrase wins over the title (D1).
        text = phrase;
      } else {
        // Existing quick-edit buttons (v1.51.10) resolve to their live operator;
        // locked ids (`*:vin`) already return null there, so the VIN can never be
        // produced or resolved (rule 8). Fall through to the title when locked.
        const quickEdit = resolveQuickEditButtonId(cleanPayload);
        if (quickEdit?.operator) {
          text = quickEdit.operator;
          intent = 'quick_edit';
        }
      }
    }

    // v1.92.1 — an UNREGISTERED payload still resolves through the button's own
    // title ("Reminders" / "Remind me" -> the reminders LIST, never the quiz).
    if (text && text === cleanTitle) {
      const titlePhrase = BUTTON_TITLE_PHRASES[text.toLowerCase()];
      if (titlePhrase) text = titlePhrase;
    }

    if (!text) return null;
    return { text, payload: cleanPayload || null, intent };
  } catch {
    return null;
  }
}

export default {
  BUTTON_PAYLOAD_PHRASES,
  BUTTON_TITLE_PHRASES,
  parseInteractiveReply
};
