import assert from 'assert';
import { buildConversationMemory } from './src/services/conversationMemory.js';

/**
 * Saka Fleet — conversation working memory (v1.55.0). Stateless.
 *
 * The submitted-but-UNSAVED draft must be visible to the model on
 * conversational turns, secret-free and bounded.
 */

let passed = 0;
function check(cond, msg) { assert(cond, msg); passed += 1; console.log(`  ✅ ${msg}`); }

console.log('=== SAKA FLEET — CONVERSATION WORKING MEMORY TESTS (v1.55.0) ===\n');

check(buildConversationMemory({}) === '', 'no draft → empty memory (zero prompt cost in idle chat)');
check(buildConversationMemory({ quiz: null }) === '', 'a null quiz → empty memory');

const memory = buildConversationMemory({
  quiz: {
    flow: 'log_expense',
    answers: { expense_type: 'Fuel', amount: 3000, fuel_liters: 13.51, odometer_reading: 367360, otp_code: '123456', token: 'secret-passbook' },
    extraNotes: ['bought from a guy on facebook']
  },
  pendingLabel: 'Notes',
  activeVehicle: { plate_number: 'KAS628T' }
});

check(/In-progress Log Expense draft/.test(memory), 'the flow is labeled in the memory block');
check(/expense type: Fuel/.test(memory), 'collected fields are labeled (expense_type → expense type)');
check(/amount: 3000/.test(memory) && /fuel litres: 13\.51/.test(memory), 'collected amounts and litres are visible');
check(/odometer: 367360/.test(memory), 'the odometer value is visible');
check(/still needs: Notes/.test(memory), 'the pending field is shown');
check(/extra notes: bought from a guy on facebook/.test(memory), 'extra notes (submitted but unsaved) are shown');
check(/active vehicle: KAS628T/.test(memory), 'the active vehicle is shown');
check(!/123456/.test(memory) && !/secret-passbook/.test(memory), 'OTP codes and passbook tokens are never surfaced');

const objectValue = buildConversationMemory({ quiz: { flow: 'set_reminder', answers: { due: { kind: 'distance', canonicalValue: 370000 } } } });
check(/370000/.test(objectValue), 'structured values render from their canonical form');

console.log(`\n🎉 ${passed} conversation-memory assertions passed.`);