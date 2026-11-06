/**
 * Saka Fleet — labels on every entry (v1.59.7, stateless)
 * -------------------------------------------------------
 * Pins the labels-everywhere surface: the idempotent schema (receipts.label,
 * reminders.label, odometer_readings), the degrade-on-schema-drift contract
 * (rule 50), the cross-kind keyword lookup, the rendered match block, and the
 * wiring of every write path (quiz, receipts, reminders, quick lanes).
 *
 * Run: node test_labels_everywhere.js
 */

import assert from 'assert';
import fs from 'node:fs';
import {
  LABELS_EVERYWHERE_SQL,
  ODOMETER_READINGS_TABLE,
  isSchemaDriftError,
  recordLabeledReading,
  searchOtherLabels,
  formatOtherLabelMatches
} from './src/services/labelsEverywhere.js';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — LABELS EVERYWHERE (v1.59.7) ===\n');

console.log('--- Test 1: idempotent schema ---');
check(LABELS_EVERYWHERE_SQL.includes('ALTER TABLE public.receipts ADD COLUMN IF NOT EXISTS label text'), 'receipts.label is added idempotently');
check(LABELS_EVERYWHERE_SQL.includes('ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS label text'), 'reminders.label is added idempotently');
check(LABELS_EVERYWHERE_SQL.includes(`CREATE TABLE IF NOT EXISTS public.${ODOMETER_READINGS_TABLE}`) && LABELS_EVERYWHERE_SQL.includes('reading numeric NOT NULL'), 'odometer_readings ledger is created idempotently');
check(LABELS_EVERYWHERE_SQL.includes('idx_odometer_readings_vehicle'), 'readings are indexed per vehicle');
check(isSchemaDriftError('column "label" of relation "receipts" does not exist') && !isSchemaDriftError('permission denied'), 'schema-drift detection is narrow');

console.log('\n--- Test 2: reading ledger (rule 50 degrade) ---');
let insertCalls = 0;
const degradeClient = {
  from: () => ({
    insert: () => {
      insertCalls += 1;
      return Promise.resolve(insertCalls === 1
        ? { error: { message: 'column "label" does not exist' } }
        : { error: null });
    }
  })
};
const degraded = await recordLabeledReading(degradeClient, { vehicleId: 'v1', reading: 50350, label: 'karen run' });
check(degraded.ok === true && degraded.degraded === true && insertCalls === 2, 'an un-migrated schema retries without the label and still records the reading');

let happyRow = null;
const happyClient = { from: () => ({ insert: (rows) => { happyRow = rows[0]; return Promise.resolve({ error: null }); } }) };
const happy = await recordLabeledReading(happyClient, { vehicleId: 'v1', profileId: 'p1', reading: 50350, label: 'karen run!' });
check(happy.ok === true && happy.label === 'karen run', 'the label is sanitised before the write');
check(happyRow && happyRow.vehicle_id === 'v1' && happyRow.reading === 50350, 'the reading row carries vehicle + reading');
check((await recordLabeledReading(null, { vehicleId: 'v1', reading: 1 })).skipped === true, 'no client is a skip, never a throw');

console.log('\n--- Test 3: cross-kind keyword lookup ---');
const rows = [{ id: 'r1', vendor: 'Shell', amount: 8800, currency: 'KES', label: 'karen', reading: 50350, reminder_type: 'Service', status: 'active' }];
const searchClient = {
  from: () => {
    const chain = {
      select: () => chain,
      in: () => chain,
      ilike: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: rows, error: null })
    };
    return chain;
  }
};
const empty = await searchOtherLabels(searchClient, { vehicleIds: [], keyword: 'karen' });
check(empty.receipts.length === 0 && empty.reminders.length === 0 && empty.readings.length === 0, 'no vehicles means no lookup');
const groups = await searchOtherLabels(searchClient, { vehicleIds: ['v1'], keyword: 'karen' });
check(groups.receipts.length === 1 && groups.reminders.length === 1 && groups.readings.length === 1, 'labels are searched on receipts, reminders AND readings');
const brokenClient = { from: () => ({ select: () => { throw new Error('boom'); } }) };
const brokenResult = await searchOtherLabels(brokenClient, { vehicleIds: ['v1'], keyword: 'karen' });
check(brokenResult.receipts.length === 0, 'a failing search degrades to empty groups (never throws)');

console.log('\n--- Test 4: rendered matches ---');
const block = formatOtherLabelMatches({
  receipts: [{ vendor: 'Shell', amount: 8800, currency: 'KES', label: 'karen' }],
  reminders: [{ reminder_type: 'Service', status: 'active', label: 'karen' }],
  readings: [{ reading: 50350, label: 'karen' }]
});
check(/Also labelled:/.test(block) && /#karen/.test(block) && /50,350/.test(block), 'the search answer names each labelled entry with #label');
check(formatOtherLabelMatches({}) === '', 'no matches renders nothing');

console.log('\n--- Test 5: every write path is wired ---');
const quiz = fs.readFileSync('src/services/quizEngine.js', 'utf8');
check(quiz.includes('recordLabeledReading(') && quiz.includes('label: readingLabel'), 'quiz writes the reading ledger row + label chip');
check(quiz.includes('label: reminderLabel') && quiz.includes('const reminderLabel = sanitizeEntryLabel('), 'quiz reminders carry the label to both creators');
check(quiz.includes("field('notes', 'Note or part name', 'optional — e.g. brake pads, or tag it: label: karen run'"), 'the note step teaches the label syntax');
const receipts = fs.readFileSync('src/services/receipts.js', 'utf8');
check(receipts.includes('label: sanitizeEntryLabel(label)') && receipts.includes('labelChip'), 'receipts store and display the label');
const whatsapp = fs.readFileSync('src/routes/whatsapp/messages.js', 'utf8');
check(whatsapp.includes('label: extractEntryLabel(messageText)'), 'the OCR lane captures the label from the caption');
const readRegistry = fs.readFileSync('src/services/readCommands.js', 'utf8');
check(readRegistry.includes('searchOtherLabels(') && readRegistry.includes('formatOtherLabelMatches('), 'keyword search spans receipts/reminders/readings (read registry)');
const reminders = fs.readFileSync('src/services/maintenanceReminders.js', 'utf8');
check(reminders.includes('label: sanitizeEntryLabel(label)') && reminders.includes('column|schema|does not exist'), 'reminder inserts carry the label and degrade on schema drift');
const inbound = fs.readFileSync('src/services/inboundEmail.js', 'utf8');
check(inbound.includes('htmlToPlainText(') && inbound.includes('Body fetch returned no text'), 'support email bodies fall back to HTML and record fetch failures');

console.log(`\n🎉 ${passed} label assertions passed.`);
