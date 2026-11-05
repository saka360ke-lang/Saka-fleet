import assert from 'assert';
import fs from 'node:fs';
import {
  buildAllDocumentsExpiryReply,
  buildComplianceNumberSearchReply,
  buildComplianceStatusReply,
  buildDriverComplianceReply,
  detectAllDocumentsExpiryRead,
  detectComplianceNumberSearch,
  detectDriverComplianceRead,
  normalizeDriverDocType
} from './src/services/complianceAnswers.js';
import {
  detectComplianceAddRequest,
  detectDocumentTypeCorrection,
  extractFromPastedDocument,
  isPhotoIntent,
  isUnreadableMediaNote
} from './src/services/complianceCapture.js';
import { driverComplianceChoices } from './src/services/driverComplianceCatalog.js';
import { SAKA_QUIZ_FLOWS } from './src/services/flowKnowledge.js';

/**
 * Saka Fleet — driver-document read/confirm lane (v1.61.2). Stateless.
 *
 * Live evidence 2026-11-05 (+254734852529): "Driver licenses", "List my
 * licenses" and "List psv badge" were answered from the EXPENSE ledger
 * ("Nothing under licences & permits"), and "I just submitted a psv badge for
 * my driver profile. Confirm" fell to a generic menu — while the saved PSV
 * badge sat in driver_compliances. These assertions pin the fix: driver
 * documents read/confirm from their own ledger, never from expenses, and the
 * lane runs before the record-query lane.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const NOW = new Date('2026-11-05T12:00:00Z');
const ROWS = [
  { type: 'driver_license', label: 'Driver licence (NTSA)', number: '6086960024692740', expiry: '2028-11-28' },
  { type: 'psv_badge', label: 'PSV badge', number: 'TSV2026', expiry: '2027-08-08' }
];

console.log('=== SAKA FLEET — DRIVER DOCUMENT READ LANE TESTS (v1.61.2) ===\n');

console.log('--- Test 1: the live messages are recognised as driver-document reads ---');
const liveDriver = detectDriverComplianceRead('Driver licenses');
check(liveDriver?.asked === 'driving_licence', '"Driver licenses" is a driving-licence read');
const liveList = detectDriverComplianceRead('List my licenses');
check(liveList?.asked === 'driving_licence', '"List my licenses" is a driving-licence read');
const livePsv = detectDriverComplianceRead('List psv badge');
check(livePsv?.asked === 'psv_badge' && livePsv.confirm === false, '"List psv badge" is a PSV read');
const liveConfirm = detectDriverComplianceRead('I just submitted a psv badge for my driver profile. Confirm');
check(liveConfirm?.asked === 'psv_badge' && liveConfirm.confirm === true, 'the live "submitted… Confirm" message is a PSV confirmation');

console.log('\n--- Test 2: vehicle permits, reports, logs and answers are never hijacked ---');
check(detectDriverComplianceRead('When does my insurance expire?') === null, 'vehicle insurance stays on the vehicle lane');
check(detectDriverComplianceRead('my compliance') === null, 'the vehicle compliance card is not a driver read');
check(detectDriverComplianceRead('compliance report') === null, 'the PDF report engine is never stolen');
check(detectDriverComplianceRead('insurance expires 20/11/2026') === null, 'a supplied date is an answer, not a read');
check(detectDriverComplianceRead('remind me to renew my psv badge on 8 Aug 2027') === null, 'reminder creation is not a read');
check(detectDriverComplianceRead('log 3000 licence renewal') === null, 'a spend/log line stays in the ledger');
check(detectDriverComplianceRead('paid 3000 for psv badge renewal') === null, 'a paid licence line stays in the ledger');
check(detectDriverComplianceRead('add psv badge') === null, 'an ADD request stays with the capture lane');

console.log('\n--- Test 3: capture verbs accept past tense (the live "submitted") ---');
const keCatalog = { items: driverComplianceChoices({ countryCode: 'KE' }) };
check(Boolean(detectComplianceAddRequest('I submitted my psv badge', { catalog: keCatalog, scope: 'driver' })), 'a past-tense "submitted" enters the capture lane');
check(Boolean(detectComplianceAddRequest('add psv badge', { catalog: keCatalog, scope: 'driver' })), 'the original "add" request still enters the capture lane');
check(detectComplianceAddRequest('list psv badge', { catalog: keCatalog, scope: 'driver' }) === null, 'a read is never turned into a capture');

console.log('\n--- Test 4: type normalisation matches the live rows ---');
check(normalizeDriverDocType('driver_license') === 'driving_licence', 'driver_license normalises to the catalog type');
check(normalizeDriverDocType('psv') === 'psv_badge', 'psv normalises to psv_badge');
check(normalizeDriverDocType('operator license') === 'operator_card', 'operator license normalises to operator_card');
check(normalizeDriverDocType('') === 'other', 'an empty type falls back to other');

console.log('\n--- Test 5: the card lists both live documents with chips and days-left ---');
const card = buildDriverComplianceReply({ rows: ROWS, profile: { full_name: 'David Njonjo' }, now: NOW });
check(card.includes('Driver documents') && card.includes('David'), 'the card is titled and personalised');
check(card.includes('PSV badge') && card.includes('TSV2026') && card.includes('08 Aug 2027'), 'the PSV badge shows its label, number and expiry');
check(/driving licence|driver licence/i.test(card) && card.includes('28 Nov 2028'), 'the driving licence is listed from driver_license');
check(card.includes('🟢'), 'valid documents carry the green chip');
check(/my compliance/.test(card), 'the card separates vehicle permits from driver documents');

console.log('\n--- Test 6: confirmations answer from the stored row (never invented) ---');
const confirmedPsv = buildDriverComplianceReply({ rows: ROWS, profile: { full_name: 'David Njonjo' }, asked: 'psv_badge', confirm: true, now: NOW });
check(confirmedPsv.includes('On file ✓') && confirmedPsv.includes('PSV badge'), 'the confirmation names the PSV badge');
check(confirmedPsv.includes('TSV2026') && confirmedPsv.includes('08 Aug 2027'), 'the confirmation states the saved number and expiry');
const confirmedLicence = buildDriverComplianceReply({ rows: ROWS, asked: 'driving_licence', confirm: true, now: NOW });
check(confirmedLicence.includes('6086960024692740'), 'the driving licence confirmation uses the stored number');
const confirmedMissing = buildDriverComplianceReply({ rows: ROWS, asked: 'cpc', confirm: true, now: NOW });
check(confirmedMissing.includes("don't have your cpc on file"), 'a missing document is answered honestly');
const filtered = buildDriverComplianceReply({ rows: ROWS, asked: 'psv_badge', now: NOW });
check(filtered.includes('PSV badge') && !filtered.includes('Driving Licence'), 'asking for one document scopes the card to it');
const askedMissing = buildDriverComplianceReply({ rows: ROWS, asked: 'cpc', now: NOW });
check(askedMissing.includes("don't have a cpc on file") && askedMissing.includes('PSV badge'), 'an asked-but-missing document still shows what is saved');

console.log('\n--- Test 7: empty and expired states are honest ---');
const empty = buildDriverComplianceReply({ rows: [], now: NOW });
check(empty.includes('No driver documents on file yet') && empty.includes('PSV badge TSV2026'), 'an empty ledger offers the one-line example');
const emptyConfirm = buildDriverComplianceReply({ rows: [], asked: 'psv_badge', confirm: true, now: NOW });
check(emptyConfirm.includes("don't have your psv badge on file yet"), 'a confirmation with no saved row never claims a save');
const expired = buildDriverComplianceReply({ rows: [{ type: 'psv_badge', label: 'PSV badge', number: 'OLD1', expiry: '2026-01-01' }], now: NOW });
check(expired.includes('🔴') && /expired/i.test(expired), 'an expired document is flagged red with days-left');

console.log('\n--- Test 8: the vehicle compliance card gains a driver section only when rows exist ---');
const withDriver = buildComplianceStatusReply({
  vehicle: { plate_number: 'KAS 628T' },
  rows: [{ type: 'insurance', label: 'Insurance', number: 'C35343842', expiry: '2026-11-20', lifetime: false }],
  driverRows: ROWS,
  profile: { full_name: 'David Njonjo' },
  now: NOW
});
check(withDriver.includes('Compliance — KAS 628T') && withDriver.includes('Insurance'), 'the vehicle section is unchanged');
check(withDriver.includes('Driver documents') && withDriver.includes('PSV badge'), 'the driver section rides the same card');
const withoutDriver = buildComplianceStatusReply({ vehicle: { plate_number: 'KAS 628T' }, rows: [], now: NOW });
check(!withoutDriver.includes('Driver documents'), 'no driver section is added when no driver rows exist');

console.log('\n--- Test 9: the lane is wired BEFORE the record/expense lane (rule 51 sibling) ---');
const route = fs.readFileSync('src/routes/whatsapp.js', 'utf8');
const driverIndex = route.indexOf('const driverDocRead');
const recordIndex = route.indexOf('recordQuestion.ok && supabaseClient');
check(driverIndex !== -1 && recordIndex !== -1 && driverIndex < recordIndex, 'driver-document detection runs before the record-query branch');
check(route.includes('buildDriverComplianceReply(') && route.includes(".eq('driver_id', profileData.id)"), 'the route reads driver_compliances for the caller profile');
check(route.includes('driverRows, profile: profileData'), 'the vehicle card receives the driver rows');
const flow = SAKA_QUIZ_FLOWS.find((row) => row.key === 'driver_onboarding');
check(/DRIVER DOCUMENT READS \(v1\.61\.2\)/.test(flow?.rules || ''), 'the driver-onboarding flow knowledge teaches the read lane');

console.log('\n--- Test 10: plural reads, merged expiry list and number search (v1.61.3) ---');
check(detectDriverComplianceRead('List all driver compliances')?.asked === null, 'the plural "driver compliances" is a driver read (live 11:06 loop)');
check(detectDriverComplianceRead('List all my compliances')?.asked === null, '"my compliances" is a driver read');
const allDocs = detectAllDocumentsExpiryRead('List all documents with expiry date');
check(Boolean(allDocs), '"list all documents with expiry date" is a merged read');
check(Boolean(detectAllDocumentsExpiryRead('Show all expiry documents')), '"show all expiry documents" is a merged read');
check(detectAllDocumentsExpiryRead('compliance report') === null, 'the PDF report engine keeps its own request');
const search = detectComplianceNumberSearch('Search TSV2026');
check(search?.number === 'TSV2026', '"search TSV2026" extracts the number');
check(detectComplianceNumberSearch('search tsv2026')?.number === 'TSV2026', 'lowercase searches normalise to uppercase');
check(detectComplianceNumberSearch('Search 6086960024692740')?.number === '6086960024692740', 'a numeric document number is searchable');
check(detectComplianceNumberSearch('log 3000 fuel') === null, 'an expense line is never a document search');
const merged = buildAllDocumentsExpiryReply({
  vehicles: [{ id: 'v1', plate_number: 'KAS 628T' }],
  vehicleRows: [{ vehicle_id: 'v1', type: 'insurance', label: 'Insurance', number: 'C35343842', expiry: '2026-11-20' }],
  driverRows: ROWS,
  profile: { full_name: 'David Njonjo' },
  now: NOW
});
check(merged.includes('Insurance') && merged.includes('PSV badge') && merged.includes('KAS 628T'), 'the merged list shows vehicle permits AND driver documents');
check(merged.includes('🪪') && merged.includes('🚗'), 'the merged list labels both ledgers');
const hit = buildComplianceNumberSearchReply({ number: 'TSV2026', vehicles: [{ id: 'v1', plate_number: 'KAS 628T' }], vehicleRows: [], driverRows: ROWS, now: NOW });
check(hit.includes('PSV badge') && hit.includes('08 Aug 2027') && /driver document/i.test(hit), 'a number search finds the saved driver document');
const miss = buildComplianceNumberSearchReply({ number: 'ZZZ999', driverRows: ROWS, now: NOW });
check(miss.includes('No document matches'), 'a miss is honest and points at the two ledgers');

console.log('\n--- Test 11: photo, unreadable media, type correction and pasted documents (v1.61.3) ---');
check(isPhotoIntent('Can I share a picture of the psv badge?') === true, 'live photo-intent phrasing is recognised');
check(isPhotoIntent('list my documents') === false, 'a read is never a photo request');
check(isUnreadableMediaNote('[Saka system note: the user sent an image/document that could not be read by OCR. ...]') === true, 'the OCR system note is recognised');
check(detectDocumentTypeCorrection('This is a psv licence not drivers license') === 'psv_badge', 'the type correction re-buckets to PSV');
check(detectDocumentTypeCorrection('PSV badge TSV2026 expires 8 Aug 2027') === null, 'a normal capture line is not a correction');
const pasted = extractFromPastedDocument('Add this drivers license | PSV DETAILS | Badge No TSV2026 | Valid until 8 Aug 2027 | REPUBLIC OF KENYA', { now: NOW });
check(pasted?.number === 'TSV2026' && pasted?.expiry === '2027-08-08', 'a pasted licence paragraph extracts the labelled number and date');
check(extractFromPastedDocument('TSV2026', { now: NOW }) === null, 'a bare token never becomes a pasted-document parse');
const routeNow = fs.readFileSync('src/routes/whatsapp.js', 'utf8');
check(routeNow.includes('detectAllDocumentsExpiryRead') && routeNow.includes('detectComplianceNumberSearch'), 'the merged read + number search are wired');
check(routeNow.includes('isUnreadableMediaNote(messageText)') && routeNow.includes('isPhotoIntent(messageText)'), 'the photo/unreadable lanes are wired into the capture branch');
check(routeNow.includes('extractFromPastedDocument') && routeNow.includes('detectDocumentTypeCorrection'), 'paste + type-correction handling is wired');

console.log(`\n🎉 ${passed} driver-document lane assertions passed.`);
