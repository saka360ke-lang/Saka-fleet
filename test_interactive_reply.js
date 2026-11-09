import assert from 'node:assert';
import fs from 'node:fs';
import { parseInteractiveReply, BUTTON_PAYLOAD_PHRASES, BUTTON_TITLE_PHRASES } from './src/routes/whatsapp/interactive.js';

/**
 * Saka Fleet — inbound interactive replies (v1.73.4, Phase 12B, section 198B).
 * Stateless: the helper is pure, so no database rows are ever created.
 *
 * Proves the Meta Cloud API shapes (button_reply / list_reply / legacy button),
 * the D1 payload registry, the quick-edit fall-through (rule 8 VIN lock), the
 * unrecognised-shape nulls and the A1 diagnostic shape in messages.js.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const msg = (interactive) => ({ from: '254700000001', id: 'wamid.test', type: 'interactive', interactive });

console.log('=== SAKA FLEET — INBOUND INTERACTIVE REPLIES (v1.73.4) ===\n');

console.log('--- Test 1: D1 payload registry ---');
check(JSON.stringify(BUTTON_PAYLOAD_PHRASES) === JSON.stringify({
  remind_me: 'reminders', reminders: 'reminders', subscription: 'subscription', keep_all: 'keep all', help: 'help'
}), 'the registry is exactly the D1 contract (5 ids)');
check(BUTTON_PAYLOAD_PHRASES.remind_me === 'reminders' && BUTTON_PAYLOAD_PHRASES.reminders === 'reminders', 'D1: remind_me maps to the reminders LIST (never the remind-me quiz)');
check(Object.isFrozen(BUTTON_PAYLOAD_PHRASES), 'the registry is frozen (no runtime drift)');

console.log('\n--- Test 2: button_reply (quick reply) ---');
const quick = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'remind_me', title: 'Remind me' } }));
check(quick?.text === 'reminders' && quick?.payload === 'remind_me' && quick?.intent === null, 'registered payload wins over the title (remind_me -> reminders)');
check(parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'REMIND_ME', title: 'Remind Me' } }))?.text === 'reminders', 'the registry lookup is case-insensitive');
const unknown = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'track_order', title: 'Track order' } }));
check(unknown?.text === 'Track order' && unknown?.payload === 'track_order', 'an unregistered payload falls back to the button title');
check(parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'subscription', title: 'See plans' } }))?.text === 'subscription', 'subscription payload -> subscription summary');
check(parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'keep_all', title: 'Keep everything' } }))?.text === 'keep all', 'keep_all payload -> keep all flow');
check(parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'help', title: 'I need help' } }))?.text === 'help', 'help payload -> help menu');
const titleOnly = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { title: 'Just a title' } }));
check(titleOnly?.text === 'Just a title' && titleOnly?.payload === null, 'a title without an id still becomes text');
const payloadOnly = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'remind_me' } }));
check(payloadOnly?.text === 'reminders' && payloadOnly?.payload === 'remind_me', 'a registered id without a title still resolves');
check(parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'mystery' } })) === null, 'an unknown id with no title has nothing to type -> null');
const spaced = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: '  remind_me  ', title: 'Remind me' } }));
check(spaced?.text === 'reminders' && spaced?.payload === 'remind_me', 'the payload id is trimmed before lookup');
check(parseInteractiveReply(msg({ type: 'button_reply' })) === null, 'button_reply without its reply object -> null');

// v1.92.1 — the saka_overdue_digest Quick Reply ("Reminders", Custom type): Meta
// may hand back a generated id, so the button's own TITLE must reach the
// deterministic reminders LIST (never the remind-me quiz).
check(JSON.stringify(BUTTON_TITLE_PHRASES) === JSON.stringify({ reminders: 'reminders', reminder: 'reminders', 'remind me': 'reminders' }) && Object.isFrozen(BUTTON_TITLE_PHRASES), 'the title alias registry pins the Reminders mapping (v1.92.1)');
const digestButton = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'generated_9f3a', title: 'Reminders' } }));
check(digestButton?.text === 'reminders' && digestButton?.payload === 'generated_9f3a', 'an unregistered id with the title "Reminders" routes to the reminders list (v1.92.1)');
check(parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'btn_1', title: 'REMINDERS' } }))?.text === 'reminders', 'the title alias is case-insensitive (v1.92.1)');
check(parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'btn_2', title: 'Remind me' } }))?.text === 'reminders', 'the title "Remind me" reaches the LIST, never the remind-me quiz (v1.92.1)');

console.log('\n--- Test 3: list_reply (list selection) ---');
const list = parseInteractiveReply(msg({ type: 'list_reply', list_reply: { id: 'row_history', title: 'History', description: 'Past logs' } }));
check(list?.text === 'History' && list?.payload === 'row_history' && list?.intent === null, 'list_reply uses the row title as text and the row id as payload');
check(parseInteractiveReply(msg({ type: 'list_reply', list_reply: { id: 'keep_all', title: 'Keep all cars' } }))?.text === 'keep all', 'a registered list row resolves the same phrase');
check(parseInteractiveReply(msg({ type: 'list_reply' })) === null, 'list_reply without its reply object -> null');

console.log('\n--- Test 4: legacy button template replies ---');
const legacy = parseInteractiveReply({ from: '254700000001', type: 'button', button: { text: 'Confirm', payload: 'SUBSCRIPTION' } });
check(legacy?.text === 'subscription' && legacy?.payload === 'SUBSCRIPTION', 'legacy button.text/payload resolves through the registry (case-insensitive)');
const legacyUnknown = parseInteractiveReply({ type: 'button', button: { text: 'Yes', payload: 'btn-yes' } });
check(legacyUnknown?.text === 'Yes' && legacyUnknown?.payload === 'btn-yes', 'an unregistered legacy payload falls back to button.text');
const legacyTextOnly = parseInteractiveReply({ type: 'button', button: { text: 'Okay' } });
check(legacyTextOnly?.text === 'Okay' && legacyTextOnly?.payload === null, 'legacy text without a payload still becomes text');
check(parseInteractiveReply({ type: 'button', button: 'nope' }) === null, 'a non-object button is never parsed');

console.log('\n--- Test 5: quick-edit ids reuse the live grammar (rule 8 lock) ---');
const editEntry = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'edit_entry', title: 'Edit entries' } }));
check(editEntry?.text === 'my entries' && editEntry?.intent === 'quick_edit', 'edit_entry resolves to the live operator (my entries) with intent quick_edit');
const editField = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'edit_vehicle:fuel_type', title: 'Fuel type' } }));
check(editField?.text === 'edit vehicle' && editField?.intent === 'quick_edit', 'a fielded quick-edit id resolves to its operator');
// v1.89.2 — the nickname is an editable field, and VIN stays locked.
const editNickname = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'edit_vehicle:nickname', title: 'Nickname' } }));
check(editNickname?.text === 'edit vehicle' && editNickname?.intent === 'quick_edit', 'v1.89.2: a nickname quick-edit id resolves to the edit operator');
const correctDoc = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'correct_doc', title: 'Correct upload' } }));
check(correctDoc?.text === 'you read it wrong' && correctDoc?.intent === 'quick_edit', 'correct_doc resolves the correction detector phrase');
const lockedVin = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'edit_vehicle:vin', title: 'VIN' } }));
check(lockedVin?.text === 'VIN' && lockedVin?.intent === null, 'rule 8: a locked :vin id never resolves — it falls through to the title');
const lockedDate = parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: 'edit_entry:entry_date', title: 'Date' } }));
check(lockedDate?.text === 'Date' && lockedDate?.intent === null, 'rule 8: the entry date stays locked too');

console.log('\n--- Test 6: unrecognised interactive shapes are never guessed ---');
check(parseInteractiveReply(msg({ type: 'product', product: { retailer_id: 'sku-1', title: 'T-Shirt' } })) === null, 'a catalog product payload -> null (no catalog lane)');
check(parseInteractiveReply(msg({ type: 'nfm_reply', nfm_reply: { response_json: '{"flow":"x"}' } })) === null, 'a flow (nfm_reply) payload -> null');
check(parseInteractiveReply(msg({ style: 'button' })) === null, 'an interactive object without a type -> null');
check(parseInteractiveReply(msg({ type: 'button_reply', button_reply: { id: '', title: '   ' } })) === null, 'an empty id and blank title -> null');

console.log('\n--- Test 7: non-hijack proof — only interactive/button turns are parsed ---');
check(parseInteractiveReply({ from: '254700000001', type: 'text', text: { body: 'reminders' } }) === null, 'a plain text turn is never touched');
check(parseInteractiveReply({ type: 'image', image: { id: 'media-1', caption: 'fuel receipt' } }) === null, 'an image (with caption) is never touched');
check(parseInteractiveReply({ type: 'audio', audio: { id: 'media-2', voice: true } }) === null, 'a voice note is never touched');
check(parseInteractiveReply({ type: 'sticker', sticker: { id: 'media-3' } }) === null, 'a sticker is never touched');
check(parseInteractiveReply({ type: 'location', location: { latitude: -1.29, longitude: 36.82 } }) === null, 'a location pin is never touched');
check(parseInteractiveReply({ type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } }) === null, 'a reaction is never touched');

console.log('\n--- Test 8: never throws ---');
for (const [label, value] of [['null', null], ['undefined', undefined], ['a string', 'interactive'], ['a number', 42], ['an array', []]]) {
  check(parseInteractiveReply(value) === null, `${label} input -> null (never throws)`);
}
check(parseInteractiveReply({ interactive: 'not-an-object' }) === null, 'a non-object interactive -> null');
check(parseInteractiveReply({ interactive: { type: 'button_reply', button_reply: [] } }) === null, 'an array reply object -> null');
check(parseInteractiveReply({}) === null, 'an empty message object -> null');

console.log('\n--- Test 9: A1 diagnostic shape (what gets logged, what never does) ---');
const messagesSource = fs.readFileSync('src/routes/whatsapp/messages.js', 'utf8');
const diagBlock = (messagesSource.match(/diag\.stack = JSON\.stringify\(\{[\s\S]{0,400}?\}\)\.slice\(0, 4000\)/) || [''])[0];
check(Boolean(diagBlock), 'messages.js builds the diagnostic stack from a bounded JSON.stringify (A1)');
check(diagBlock.includes('interactive: messageObj?.interactive') && diagBlock.includes('button: messageObj?.button'), 'A1: the stack captures ONLY the interactive and button sub-objects');
check(!/\b(?:from|text|image|audio|document|sticker|id|timestamp)\s*:\s*messageObj/.test(diagBlock), 'A1: no message body, media id, phone number or timestamp enters the stack');
check(messagesSource.includes("'/webhook/whatsapp/interactive'"), 'A1: the incident is written to error_logs under its own route');

console.log(`\n🎉 ${passed} interactive-reply assertions passed.`);
