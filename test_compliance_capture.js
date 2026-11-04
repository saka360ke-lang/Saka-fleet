// v1.58.25 - compliance capture: owner self-documents, partial asks, merges.
// Stateless: zero DB, zero network (rule 51 siblings asserted too).
import { resolveBundledCatalog } from './src/services/complianceCatalog.js';
import { resolveVehicleComplianceCatalog } from './src/services/vehicleCompliance.js';
import {
  COMPLIANCE_CAPTURE_TTL_MINUTES,
  DRIVER_DOC_RE,
  VEHICLE_DOC_RE,
  matchesPhrase,
  catalogCandidates,
  pickComplianceContextVehicle,
  detectComplianceAddRequest,
  extractComplianceDetails,
  mergeComplianceCapture,
  complianceCapturePrompt,
  formatComplianceSaved,
  isComplianceCaptureCancel,
  complianceCaptureCancelText,
  looksLikeFreshLogLine,
  isComplianceCaptureExpired
} from './src/services/complianceCapture.js';

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; console.log('FAIL ' + name + (detail ? ' | ' + JSON.stringify(detail) : '')); }
}

const NOW = new Date('2026-11-04T12:00:00.000Z');
const KE_DRIVER = resolveBundledCatalog({ countryCode: 'KE', assetType: 'VAN', includeAll: true });
const KE_DRIVER_FILTERED = resolveBundledCatalog({ countryCode: 'KE', assetType: 'VAN' });
const KE_VEHICLE = resolveVehicleComplianceCatalog({ countryCode: 'KE', assetType: 'VAN', includeAll: true });
const OWNER_ID = 'owner-1';

console.log('=== v1.58.25: compliance capture (PSV loop + siblings) ===');

// 1. The live loop: "Add psv license" must resolve to the PSV badge.
const addPsv = detectComplianceAddRequest('Add psv license', { catalog: KE_DRIVER, scope: 'driver' });
check('"Add psv license" resolves to the PSV badge', addPsv?.item?.type === 'psv_badge', addPsv);
check('"i want to add a psv license" resolves', detectComplianceAddRequest('i want to add a psv license', { catalog: KE_DRIVER })?.item?.type === 'psv_badge');
check('"Add psv licence to driver profile?" resolves', detectComplianceAddRequest('Add psv licence to driver profile?', { catalog: KE_DRIVER })?.item?.type === 'psv_badge');

// 2. Questions and reads are never captured (no hijack).
check('a question about adding is not a capture', detectComplianceAddRequest('how do I add a psv licence?', { catalog: KE_DRIVER }) === null);
check('a read request is not a capture', detectComplianceAddRequest('show my psv badge', { catalog: KE_DRIVER }) === null);
check('an unrelated statement is not a capture', detectComplianceAddRequest('card payment 5000', { catalog: KE_DRIVER }) === null);

// 3. Explicit mention beats the asset-type menu filter (VAN vs PSV).
check('the asset filter hides the PSV badge on a VAN (before)', !KE_DRIVER_FILTERED.additional.some((i) => i.type === 'psv_badge'));
check('includeAll keeps the PSV badge on a VAN (after)', KE_DRIVER.additional.some((i) => i.type === 'psv_badge'));
check('word-boundary aliases never match inside words', matchesPhrase('psversion', 'psv') === false && matchesPhrase('my psv', 'psv') === true);

// 4. Owner self-profile fallback (the actual bug: no assigned driver).
const ownedVehicle = { id: 'v1', plate_number: 'KBJ 819C', owner_id: OWNER_ID, assigned_driver_id: null };
const assignedVehicle = { id: 'v2', plate_number: 'KDA 123A', owner_id: 'other', assigned_driver_id: OWNER_ID };
check('an owner falls back to their own profile', (() => {
  const ctx = pickComplianceContextVehicle({ vehicles: [ownedVehicle], profileId: OWNER_ID });
  return ctx.vehicle?.id === 'v1' && ctx.isSelfProfile === true;
})());
check('an assigned driver keeps the gated path', (() => {
  const ctx = pickComplianceContextVehicle({ vehicles: [ownedVehicle, assignedVehicle], profileId: OWNER_ID });
  return ctx.vehicle?.id === 'v2' && ctx.isSelfProfile === false;
})());
check('no vehicle means no context', pickComplianceContextVehicle({ vehicles: [], profileId: OWNER_ID }).vehicle === null);

// 5. Full parse from one line.
const full = extractComplianceDetails('PSV badge 445566 expires 15 Dec 2028', {
  item: KE_DRIVER.additional[0], countryCode: 'KE', locale: 'en-KE', now: NOW
});
check('a one-line document saves with number + expiry', full.ok && full.parsed.number === '445566' && full.parsed.expiry === '2028-12-15', full);
check('days-left is computed for the confirmation', Number.isFinite(Number(full.parsed.daysLeft)) && full.parsed.daysLeft > 0, full.parsed?.daysLeft);

// 6. The live paragraph had an expiry but NO badge number -> ask for the number.
const paragraph = `Add to driver compliance records
REPUBLIC OF KENYA - JAMHURI YA KENYA
PSV DETAILS
psv License
Individual (Tours) PSV Driver
Date of Expiry
2027-08-08
Status
Active`;
const partial = extractComplianceDetails(paragraph, { item: KE_DRIVER.additional[0], countryCode: 'KE', locale: 'en-KE', now: NOW });
check('an expiry-only paragraph is recognised as partial', partial.ok === false && partial.expiry === '2027-08-08' && !partial.number, partial);
const askNumber = complianceCapturePrompt({ item: KE_DRIVER.additional[0], scope: 'driver', have: { expiry: partial.expiry } });
check('the prompt asks for the missing number only', /document number/i.test(askNumber) && askNumber.includes('2027-08-08'), askNumber);

// 7. The pending capture completes on the follow-up turn.
const merged = mergeComplianceCapture(
  { type: 'psv_badge', number: null, expiry: '2027-08-08' },
  '445566',
  { item: KE_DRIVER.additional[0], countryCode: 'KE', locale: 'en-KE', now: NOW }
);
check('a follow-up number completes the pending capture', merged.ok && merged.parsed.number === '445566' && merged.parsed.expiry === '2027-08-08', merged);
const mergedDate = mergeComplianceCapture(
  { type: 'psv_badge', number: '445566', expiry: null },
  '8 Aug 2027',
  { item: KE_DRIVER.additional[0], countryCode: 'KE', locale: 'en-KE', now: NOW }
);
check('a follow-up date completes the pending capture', mergedDate.ok && mergedDate.parsed.number === '445566' && mergedDate.parsed.expiry === '2027-08-08', mergedDate);
const mergedLifetime = mergeComplianceCapture(
  { type: 'psv_badge', number: '445566', expiry: null },
  'lifetime',
  { item: KE_DRIVER.additional[0], countryCode: 'KE', locale: 'en-KE', now: NOW }
);
check('"lifetime" closes a pending capture', mergedLifetime.ok && mergedLifetime.parsed.lifetime === true, mergedLifetime);

// 8. Rule 51 sibling: a vehicle permit request gets the same lane.
const addInsurance = detectComplianceAddRequest('add insurance', { catalog: KE_VEHICLE, scope: 'vehicle' });
check('"add insurance" resolves on the vehicle catalog', addInsurance?.item?.type === 'insurance', addInsurance);
check('the vehicle prompt shows a vehicle example', /ABC123/.test(complianceCapturePrompt({ item: addInsurance.item, scope: 'vehicle', contextLabel: 'KBJ 819C' })));
check('vehicle catalog items are candidates', catalogCandidates(KE_VEHICLE).some((i) => i.type === 'road_service_licence'));

// 9. Confirmation copy carries engine facts only.
const saved = formatComplianceSaved({ item: KE_DRIVER.additional[0], parsed: full.parsed, scope: 'driver', contextLabel: 'KBJ 819C' });
check('the saved confirmation carries the number and expiry', saved.includes('445566') && saved.includes('2028-12-15') && saved.includes('KBJ 819C'), saved);
check('a lifetime document never prints an expiry line', formatComplianceSaved({ item: KE_DRIVER.additional[0], parsed: mergedLifetime.parsed }).includes('Valid for life'));

// 10. Safety guards.
check('the role word lists classify their own documents', DRIVER_DOC_RE.test('add psv badge') && VEHICLE_DOC_RE.test('add insurance'));
check('cancel is recognised alone', isComplianceCaptureCancel('cancel') === true && isComplianceCaptureCancel('cancel my subscription') === false);
check('the cancel acknowledgement lives in the module (no route literal)', complianceCaptureCancelText().includes('nothing was saved'));
check('a fresh log line defers the pending capture', looksLikeFreshLogLine('Logged 40L at 50350 km') === true && looksLikeFreshLogLine('445566') === false);
check('a stale capture expires', isComplianceCaptureExpired({ at: new Date(NOW.getTime() - (COMPLIANCE_CAPTURE_TTL_MINUTES + 1) * 60000).toISOString() }, NOW) === true);
check('a fresh capture is still live', isComplianceCaptureExpired({ at: NOW.toISOString() }, NOW) === false);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
console.log(`🎉 ${pass} assertions passed.`);
