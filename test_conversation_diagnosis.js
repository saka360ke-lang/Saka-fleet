import assert from 'assert';
import { isConversationDiagnosisEnabled, sanitizeConversationDiagnosis } from './src/services/conversationDiagnosis.js';

/**
 * Saka Fleet — conversation diagnosis (v1.55.1). Stateless.
 *
 * The sanitizer is the wall between the model's diagnosis and the proposal
 * registry: valid JSON passes, forbidden paths and empty fields are dropped.
 */

let passed = 0;
function check(cond, msg) { assert(cond, msg); passed += 1; console.log(`  ✅ ${msg}`); }

console.log('=== SAKA FLEET — CONVERSATION DIAGNOSIS TESTS (v1.55.1) ===\n');

check(isConversationDiagnosisEnabled() === false, 'CONVERSATION_DIAGNOSIS_ENABLED defaults OFF during the testing phase');

const valid = sanitizeConversationDiagnosis({
  root_cause: 'A draft correction matched the saved-ledger natural-mistake rule.',
  likely_file: 'src/services/entryAnswers.js',
  minimal_change: 'Require an entry noun in detectLedgerCommand.'
});
check(Boolean(valid), 'a valid diagnosis passes the sanitizer');
check(valid && valid.rootCause.includes('draft correction'), 'the root cause is preserved');
check(valid?.likelyFile === 'src/services/entryAnswers.js', 'the likely file is preserved');

check(sanitizeConversationDiagnosis(null) === null, 'a null candidate is dropped');
check(sanitizeConversationDiagnosis({ root_cause: '', minimal_change: '' }) === null, 'empty fields are dropped');
check(sanitizeConversationDiagnosis({ root_cause: 'x', minimal_change: 'y', likely_file: 'src/services/paystack.js' }) === null, 'a payment path is forbidden');
check(sanitizeConversationDiagnosis({ root_cause: 'x', minimal_change: 'y', likely_file: '.env' }) === null, 'a .env path is forbidden');
check(sanitizeConversationDiagnosis({ root_cause: 'x', minimal_change: 'y', likely_file: 'scripts/reset-db.js' }) === null, 'a reset path is forbidden');
check(sanitizeConversationDiagnosis({ root_cause: 'x', minimal_change: 'y', likely_file: 'src/workers/sentinel.js' }) !== null, 'a normal source file passes');

const truncated = sanitizeConversationDiagnosis({ root_cause: 'r'.repeat(400), minimal_change: 'm' });
check(truncated?.rootCause.length === 300, 'the root cause is capped at 300 chars');

console.log(`\n🎉 ${passed} conversation-diagnosis assertions passed.`);