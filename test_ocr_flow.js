import {
  downloadWhatsAppMedia,
  extractTextFromImage,
  ocrWhatsAppMedia,
  extractReceiptHints,
  extractDocumentHints,
  classifyOcrDocument,
  OCR_VISION_TIMEOUT_MS,
  OCR_VISION_MAX_ATTEMPTS,
  isOcrEnabled,
  buildMediaAckText,
  SUPPORTED_IMAGE_TYPES
} from './src/services/ocrService.js';
import { classifyDocumentFamily, parseDocumentFields } from './src/services/documentLens.js';
import { semanticOcrTopUp } from './src/services/ocrSemantic.js';
import { buildOcrTextSha, getOcrUsageSummary } from './src/services/ocrTelemetry.js';
import { isSameExpenseCandidate, nairobiDateKey } from './src/services/expenseGuard.js';
import { readFileSync } from 'fs';
import {
  OCR_LOW_CONFIDENCE_NOTE,
  OCR_UNREADABLE_NOTE,
  OCR_CONFIRM_THRESHOLD,
  formatReceiptsReply,
  formatDuplicateReceiptReply,
  recordReceipt,
  deleteReceipt
} from './src/services/receipts.js';
import { handleQuizTurn } from './src/services/quizEngine.js';
// v1.81.0 (Phase 20) — the vault returns the durable receipt link for the quiz.
import { resolveReceiptVault } from './src/routes/whatsapp/media.js';

/**
 * Targeted suite: OCR pipeline (Meta media → Vision → receipt hints → quiz).
 * Stateless — all network calls are mocked, no database rows are created.
 */

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  passed += 1;
  console.log(`✅ ${msg}`);
}
const check = assert;

const realFetch = global.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function binaryResponse(buffer, contentType = 'image/jpeg') {
  return new Response(buffer, { status: 200, headers: { 'content-type': contentType } });
}

async function run() {
  console.log('--- Test 1: Meta two-step media download ---');
  const imageBytes = Buffer.from('fake-jpeg-bytes');
  let call = 0;
  global.fetch = async (url) => {
    call += 1;
    if (call === 1) {
      assert(String(url).includes('graph.facebook.com'), 'First call hits the Graph API media endpoint');
      return jsonResponse({ url: 'https://cdn.example/media/123', mime_type: 'image/jpeg', file_size: imageBytes.length });
    }
    assert(String(url) === 'https://cdn.example/media/123', 'Second call downloads from the returned CDN URL');
    return binaryResponse(imageBytes);
  };

  const download = await downloadWhatsAppMedia('media-123', 'test-token');
  assert(download.error === null, 'Media download reports no error');
  assert(download.buffer?.length === imageBytes.length, 'Downloaded buffer length matches');
  assert(download.mimeType === 'image/jpeg', 'MIME type is preserved');

  console.log('\n--- Test 2: direct binary response + size guard ---');
  global.fetch = async () => binaryResponse(Buffer.from('direct-binary'));
  const direct = await downloadWhatsAppMedia('media-direct', 'test-token');
  assert(direct.buffer?.toString() === 'direct-binary', 'Direct binary Graph response is accepted');

  global.fetch = async () => jsonResponse({ url: 'https://cdn.example/big', mime_type: 'image/jpeg', file_size: 6 * 1024 * 1024 });
  const big = await downloadWhatsAppMedia('media-big', 'test-token');
  assert(big.buffer === null && /size limit/i.test(big.error), 'Oversized media is rejected');

  console.log('\n--- Test 3: Vision text extraction ---');
  process.env.GCP_VISION_API_KEY = 'test-vision-key';
  global.fetch = async () => jsonResponse({
    responses: [{
      fullTextAnnotation: {
        text: 'SHELL KAREN\nTOTAL KES 5,500\n40.5 L\nOdometer: 366800\n2026-10-12',
        pages: [{ confidence: 0.94 }]
      }
    }]
  });
  const ocr = await extractTextFromImage(Buffer.from('image'));
  assert(ocr.error === null, 'Vision call succeeds');
  assert(ocr.text.includes('SHELL KAREN') && ocr.text.includes('5,500'), 'OCR text is returned');
  assert(ocr.confidence === 0.94, 'Confidence is captured');

  delete process.env.GCP_VISION_API_KEY;
  const noKey = await extractTextFromImage(Buffer.from('image'));
  assert(noKey.text === null && /GCP_VISION_API_KEY/.test(noKey.error), 'Missing Vision key degrades gracefully');
  process.env.GCP_VISION_API_KEY = 'test-vision-key';

  console.log('\n--- Test 3b: Vision timeout retry & unreadable-document clarity ---');
  let visionAttempt = 0;
  global.fetch = async () => {
    visionAttempt += 1;
    if (visionAttempt === 1) {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'AbortError';
      throw timeoutErr;
    }
    return jsonResponse({
      responses: [{
        fullTextAnnotation: {
          text: 'MOTOR INSURANCE POLICY\nPOLICY NO ABC12345\nEXPIRES 2027-05-15',
          pages: [{ confidence: 0.91 }]
        }
      }]
    });
  };
  const retried = await extractTextFromImage(Buffer.from('scan'));
  assert(retried.error === null && retried.attempts === 2, 'A Vision timeout is retried once and recovers');
  assert(retried.text.includes('INSURANCE'), 'Retried Vision call returns the document text');

  global.fetch = async () => {
    const transportErr = new Error('socket hang up');
    transportErr.name = 'TypeError';
    throw transportErr;
  };
  const noRetry = await extractTextFromImage(Buffer.from('scan'));
  assert(noRetry.text === null && noRetry.attempts === 1, 'Non-timeout transport errors are never retried');
  assert(/socket hang up/.test(noRetry.error), 'Transport error is preserved for diagnostics');

  global.fetch = async () => jsonResponse({ responses: [{}] });
  const blank = await extractTextFromImage(Buffer.from('blank'));
  assert(blank.text === null && /No text detected/i.test(blank.error), 'Blank Vision reads return an explicit reason');
  assert(OCR_VISION_TIMEOUT_MS >= 25000 && OCR_VISION_MAX_ATTEMPTS === 2, 'Vision budget and retry knobs are exported');
  assert(/type the answer/i.test(OCR_UNREADABLE_NOTE) && /Skip/i.test(OCR_UNREADABLE_NOTE), 'Unreadable-photo note offers a typed or skip fallback');

  console.log('\n--- Test 4: media type routing (v1.20.0) ---');
  // PDFs are first-class since v1.20.0 (full coverage in test_doc_lens.js).
  // Unsupported types are still rejected before any Vision call.
  const unsupported = await ocrWhatsAppMedia({ mediaId: 'doc-1', mimeType: 'application/msword', token: 't' });
  assert(unsupported.text === null && /Unsupported media type/i.test(unsupported.error), 'Unsupported document types are politely rejected');

  console.log('\n--- Test 5: receipt hint extraction ---');
  const hints = extractReceiptHints('SHELL KAREN\nTOTAL KES 5,500\n40.5 L\nOdometer: 366800\n2026-10-12');
  assert(hints.amount === 5500, 'Total amount parsed from the TOTAL line');
  assert(hints.fuel_liters === 40.5, 'Fuel volume parsed');
  assert(hints.odometer === 366800, 'Odometer parsed');
  assert(hints.notes?.includes('SHELL KAREN') && hints.notes?.includes('2026-10-12'), 'Vendor and date captured as notes');

  console.log('\n--- Test 6: OCR hints prefill the expense quiz (confirmation still required) ---');
  const vehicle = {
    id: '11111111-1111-1111-1111-111111111111',
    owner_id: '00000000-0000-0000-0000-000000000001',
    plate_number: 'KDA 123A',
    make_model: 'Toyota Land Cruiser',
    current_mileage: 360000,
    odometer_reading: 360000,
    metadata: {}
  };
  const session = {};
  const ctx = {
    supabase: null,
    profile: { id: vehicle.owner_id, email: '', unit_system: 'metric', subscription_tier: 'free' },
    vehicles: [vehicle],
    countryInfo: { country: 'Kenya', country_code: 'KE', plate_example: 'KDA 123A', default_units: 'metric', currency: 'KES', default_language: 'English', locale: 'en-KE' },
    senderPhone: '+254700000001',
    formattedPhone: '+254700000001',
    language: 'English',
    intent: 'LOG_EXPENSE',
    aiExtracted: {},
    sendWhatsApp: async () => {}
  };

  await handleQuizTurn({
    session,
    messageText: 'Receipt photo',
    aiExtracted: { expense_type: 'Fuel', fill_type: 'full', ...hints },
    startFlow: 'log_expense',
    ctx
  });

  assert(session.quiz?.phase === 'confirm', 'Receipt quiz reaches the confirmation gate (no write yet)');
  assert(session.quiz.answers.amount === 5500, 'OCR total prefilled the amount');
  assert(session.quiz.answers.fuel_liters === 40.5, 'OCR volume prefilled the fuel litres');
  assert(session.quiz.answers.odometer_reading === 366800, 'OCR odometer prefilled the reading');

  console.log('\n--- Test 6b: the vaulted receipt id rides the quiz prefill (v1.81.0) ---');
  const VAULT_RECEIPT_ID = '33333333-3333-3333-3333-333333333333';
  const vaultInserts = [];
  const vaultClient = {
    from(table) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        order: () => builder,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (rows) => {
          vaultInserts.push({ table, rows });
          return {
            error: null,
            select: () => ({ maybeSingle: async () => ({ data: { id: VAULT_RECEIPT_ID, ...rows[0] }, error: null }) })
          };
        },
        delete: () => builder
      };
      return builder;
    },
    storage: { from: () => ({ upload: async () => ({ error: { message: 'no bucket' } }) }) }
  };
  const vaultArgs = {
    supabaseClient: vaultClient,
    ocrPaused: false,
    ocrText: 'SHELL KAREN TOTAL KES 5,500',
    ocrLowConfidence: false,
    ocrResult: null,
    ocrError: null,
    receiptHints: { amount: 5500, currency: 'KES' },
    countryInfo: { currency: 'KES' },
    entitlements: { receiptVaultStorage: false },
    profileData: { id: vehicle.owner_id },
    existingVehicles: [vehicle],
    currentActiveVehicle: vehicle
  };
  const receiptVault = await resolveReceiptVault({
    ...vaultArgs,
    mediaObj: { id: 'media-1' },
    ocrKind: 'receipt_fuel',
    ocrTextSha: 'sha-1',
    messageText: 'Receipt photo',
    ocrCountry: { country_code: 'KE' }
  });
  check(vaultInserts.some((entry) => entry.table === 'receipts'), 'the receipt row is still vaulted as evidence');
  check(receiptVault.receiptPrefill?.receipt_id === VAULT_RECEIPT_ID, 'a freshly vaulted receipt returns { receipt_id } for the quiz');
  const logbookVault = await resolveReceiptVault({
    ...vaultArgs,
    mediaObj: { id: 'media-2' },
    ocrKind: 'logbook',
    ocrText: 'VIN JTE777A1234567890',
    ocrTextSha: 'sha-2',
    messageText: 'Logbook photo',
    ocrCountry: { country_code: 'KE' }
  });
  check(logbookVault.receiptPrefill === null, 'a logbook never carries a receipt prefill (receipts only)');

  console.log('\n--- Test 7: document classification ---');
  check(classifyOcrDocument('SHELL KAREN\nPUMP 4\nDIESEL 40.5 L\nTOTAL KES 5,500') === 'receipt_fuel', 'Fuel receipts are classified');
  check(classifyOcrDocument('TOTAL KES 1,200\nCASH\n12/10/2026') === 'receipt_general', 'General receipts are classified');
  check(classifyOcrDocument('VIN JTE777A1234567890\nREG NO KDA 123A') === 'logbook', 'Logbooks are classified');
  check(classifyOcrDocument('MOTOR INSURANCE POLICY\nPOLICY NO ABC12345\nEXPIRES 2027-05-15') === 'insurance', 'Insurance documents are classified');
  check(classifyOcrDocument('DRIVING LICENCE\nDL NO 123456\nPSV BADGE\nEXPIRES 2027-01-31') === 'drivers_licence', 'Driver licences are classified');
  check(classifyOcrDocument('ODOMETER 366800') === 'odometer_photo', 'Odometer photos are classified');
  check(classifyOcrDocument('random text without signals') === 'unknown', 'Unknown documents stay unknown');

  console.log('\n--- Test 8: rich document hints ---');
  const receiptInr = extractDocumentHints('HP PETROL PUMP\nPETROL 12.5 L\nTOTAL ₹1,850\n2026-10-12');
  check(receiptInr.amount === 1850 && receiptInr.currency === 'INR', '₹ receipts parse amount and currency');
  check(receiptInr.expense_type === 'Fuel', 'Fuel receipts prefill the expense type');
  const logbook = extractDocumentHints('VIN JTE777A1234567890\nREG NO KDA 123A', 'logbook');
  check(logbook.vin === 'JTE777A1234567890' && logbook.plate_number === 'KDA 123A', 'Logbook VIN + plate extracted');
  const insurance = extractDocumentHints('MOTOR INSURANCE POLICY\nPOLICY NO ABC12345\nEXPIRES 2027-05-15', 'insurance');
  check(insurance.insurance_policy === 'ABC12345' && insurance.insurance_expiry === '2027-05-15', 'Insurance policy + expiry extracted');
  const licence = extractDocumentHints('DRIVING LICENCE\nDL NO 123456\nPSV BADGE\nEXPIRES 2027-01-31', 'drivers_licence');
  check(licence.compliance_number === '123456' && licence.compliance_expiry === '2027-01-31' && /PSV/.test(licence.compliance_type), 'Licence number, expiry and type extracted');
  check(OCR_CONFIRM_THRESHOLD === 0.85, 'OCR confirmation threshold is 0.85 by default');
  check(OCR_LOW_CONFIDENCE_NOTE.includes('🙏') && /double-check/i.test(OCR_LOW_CONFIDENCE_NOTE), 'Low-confidence note is gentle and asks for a double-check');

  console.log('\n--- Test 9: receipt vault replies ---');
  const emptyReply = formatReceiptsReply({ receipts: [] });
  check(emptyReply.includes('No receipts yet') && emptyReply.includes('📸'), 'Empty receipt history is friendly');
  const receiptsReply = formatReceiptsReply({
    receipts: [
      { amount: 5500, currency: 'KES', vendor: 'SHELL KAREN | 2026-10-12', status: 'read', created_at: '2026-10-12T08:00:00Z', vehicle_id: 'v1' },
      { amount: 1200, currency: 'KES', vendor: 'NAIVAS', status: 'low_confidence', created_at: '2026-10-10T08:00:00Z' }
    ],
    vehicles: [{ id: 'v1', plate_number: 'KDA 123A' }],
    fallbackCurrency: 'KES'
  });
  check(receiptsReply.includes('🟢') && receiptsReply.includes('🟡'), 'Receipt list uses status chips');
  check(receiptsReply.includes('KDA 123A') && receiptsReply.includes('5,500'), 'Receipt list shows vehicle and amount');
  // v1.73.0 (Phase 10, P3-1) — pagination offers *more* only when more exists,
  // and page 2+ is view-only (never invites `delete receipt N`).
  const fiveReceipts = Array.from({ length: 5 }, (_, i) => ({
    amount: 1000 + i,
    currency: 'KES',
    vendor: `SHOP ${i + 1}`,
    status: 'read',
    created_at: new Date(Date.UTC(2026, 9, 20 - i)).toISOString(),
    vehicle_id: 'v1'
  }));
  const defaultReply = formatReceiptsReply({ receipts: fiveReceipts, vehicles: [{ id: 'v1', plate_number: 'KDA 123A' }], fallbackCurrency: 'KES' });
  check(!defaultReply.includes('*more*'), 'the default receipt list never offers *more* without hasMore');
  const moreReply = formatReceiptsReply({ receipts: fiveReceipts, vehicles: [{ id: 'v1', plate_number: 'KDA 123A' }], fallbackCurrency: 'KES', hasMore: true });
  check(moreReply.includes('Reply *more* for the next 5 older receipts'), 'a full receipt page offers *more*');
  const pagedReply = formatReceiptsReply({ receipts: fiveReceipts, vehicles: [], fallbackCurrency: 'KES', hasMore: true, paged: true });
  check(pagedReply.includes('Older receipts') && !/delete receipt N/.test(pagedReply), 'page 2+ is view-only (no delete hint)');
  check(pagedReply.includes('go back to the newest'), 'page 2+ points back to the newest list');
  const capReply = formatReceiptsReply({ receipts: fiveReceipts, vehicles: [], fallbackCurrency: 'KES', hasMore: true, paged: true, atCap: true });
  check(capReply.includes('report covers anything older') && !/Reply \*more\*/.test(capReply), 'the 5-page cap redirects to a report');
  const duplicateReply = formatDuplicateReceiptReply({ vendor: 'SHELL KAREN', amount: 5500, currency: 'KES', created_at: '2026-10-12T08:00:00Z' });
  check(duplicateReply.includes('already read') && duplicateReply.includes('receipts'), 'Duplicate receipt reply is warm and offers history');

  console.log('\n--- Test 10: OCR switch & ack-first (v1.28.8) ---');
  process.env.OCR_ENABLED = 'off';
  assert(isOcrEnabled() === false, 'OCR_ENABLED=off pauses Vision photo OCR');
  let pausedFetch = false;
  global.fetch = async () => { pausedFetch = true; return jsonResponse({}); };
  const paused = await ocrWhatsAppMedia({ mediaId: 'paused-1', mimeType: 'image/jpeg', token: 't' });
  assert(paused.skipped === true && /paused/i.test(paused.error), 'paused photo OCR never downloads or calls Vision');
  assert(pausedFetch === false, 'no network call happens while OCR is paused');
  process.env.OCR_ENABLED = 'on';
  assert(isOcrEnabled() === true, 'OCR_ENABLED=on re-enables Vision (v1.28.8 unpause)');
  process.env.OCR_ENABLED = 'true';
  assert(isOcrEnabled() === true, 'OCR_ENABLED=true is accepted');
  process.env.OCR_ENABLED = '0';
  assert(isOcrEnabled() === false, 'OCR_ENABLED=0 pauses');
  delete process.env.OCR_ENABLED;
  assert(isOcrEnabled() === true, 'Vision OCR defaults ON while testing');
  assert(buildMediaAckText({ mimeType: 'application/pdf' }).includes('PDF'), 'PDF ack copy names the PDF');
  assert(buildMediaAckText({ mimeType: 'image/jpeg' }).includes('photo'), 'photo ack copy names the photo');
  delete process.env.OCR_ENABLED;

  console.log('\n--- Test 11: Kenya e-TIMS receipt profile (Rule 36) ---');
  const etimsText = [
    'KE ***START OF LEGAL RECEIPT →',
    'ASTROL PETROLEUM LIMITED',
    'P.O. BOX 11823-00400',
    'NAIROBI',
    'RUNDA VIEW',
    'PIN:P051141264M',
    'Buyer PIN:P052358408G',
    'KRA/ETI/181021/MINI/017',
    'FISCAL RECEIPT',
    'DIESEL',
    '3.000.00x 1.00',
    '3.000.00B',
    'TOTAL',
    '3,000.00',
    'TOTAL B- 8.00%',
    'NET B',
    '2.777.78',
    'TOTAL TAX 222.22',
    'CASH',
    '3.000.00',
    'Date:26/10/2026',
    'Time:22:20:28',
    'END OF LEGAL RECEIPT***'
  ].join('\n');
  check(classifyOcrDocument(etimsText) === 'receipt_fuel', 'e-TIMS fuel receipt classifies as receipt_fuel (PIN token is not a VIN)');
  check(classifyDocumentFamily(etimsText) === 'receipt_fuel', 'Buyer PIN does not turn a fuel receipt into a purchase invoice');
  const etimsKe = extractDocumentHints(etimsText, 'receipt_fuel', { countryCode: 'KE' });
  check(etimsKe.amount === 3000, 'KE profile reads the TOTAL figure on the following line (KES 3,000)');
  check(etimsKe.currency === 'KES', 'KE profile supplies KES when the receipt omits the code');
  check(/ASTROL PETROLEUM/.test(String(etimsKe.notes)), 'KE profile names the merchant after the legal marker');
  check(etimsKe.expense_type === 'Fuel', 'Fuel receipts prefill the expense type');
  check(etimsKe.fuel_liters === undefined, 'Ambiguous OCR quantities are never guessed into litres');
  const etimsGlobal = extractDocumentHints(etimsText, 'receipt_fuel', { countryCode: 'GLOBAL' });
  check(!etimsGlobal.currency, 'GLOBAL profile never assumes KES (no country leakage)');
  check(!/ASTROL/.test(String(etimsGlobal.notes || '')), 'GLOBAL profile does not apply the e-TIMS merchant rule');
  check(etimsGlobal.amount === 3000, 'GLOBAL still reads a bare TOTAL + next-line figure (universal rule)');
  check(SUPPORTED_IMAGE_TYPES.includes('image/heic') && SUPPORTED_IMAGE_TYPES.includes('image/heif'), 'HEIC/HEIF photos are accepted');

  console.log('\n--- Test 12: insurance certificate is not a logbook (v1.32.1) ---');
  const insuranceCert = 'Bima Yangu INSTANT: Claims Reporting Emergency Assistance | Certificate Verification FILE COPY AKI 607675 CERTIFICATE OF INSURANCE No: C35343842 POLICY HOLDER: DAVID MWAURA NJONJO Bima Yangu POLICY No HDO/0703/143296/2026 (TPO) COMMENCING DATE 21/10/2026; 00:00 EAT EXPIRING: 20/11/2026 REGISTRATION No: KAS628T CHASSIS NUMBER: HDJ810007675 ISSUED BY The Monarch Insurance Company Ltd. PHONE NO: +254705426931';
  check(classifyOcrDocument(insuranceCert) === 'insurance', 'Insurance certificate classifies as insurance even with CHASSIS + REGISTRATION No');
  check(classifyDocumentFamily(insuranceCert) === 'insurance', 'Document Lens agrees: insurance, not logbook');
  const insuranceHints = extractDocumentHints(insuranceCert, 'insurance', { countryCode: 'KE' });
  check(insuranceHints.insurance_policy === 'C35343842', 'Certificate number is captured as the policy reference');
  check(insuranceHints.insurance_expiry === '20/11/2026', 'EXPIRING date wins over the COMMENCING date');
  check(/Expires 20\/11\/2026/.test(String(insuranceHints.notes)), 'Insurance vault note carries the labelled expiry (not the commencement date)');
  const insuredLens = parseDocumentFields(insuranceCert, { countryCode: 'KE' });
  check(insuredLens.family === 'insurance', 'Lens family is insurance');
  check(String(insuredLens.fields?.insurance_expiry?.value || '') === '2026-11-20', 'Lens normalizes the expiry to ISO (Africa/Nairobi)');
  check(/Monarch/.test(String(insuredLens.fields?.insurer?.value || '')), 'ISSUED BY names the insurer cleanly');

  console.log('\n--- Test 12b: NTSA registration certificate is a logbook, not a receipt (v1.51.11) ---');
  const ntsaCert = [
    'FRES',
    'NTSA',
    'N7200766 H',
    'REPUBLIC OF KENYA',
    'NATIONAL TRANSPORT AND SAFETY AUTHORITY',
    'THE TRAFFIC ACT (CAP. 403) (SECTION 6 (5))',
    'REGISTRATION CERTIFICATE',
    'N7200766H',
    'TRANSFER: 202412066492776',
    'ENTRY NO:',
    'REGISTRATION:',
    'CHASSIS/FRAME',
    'MAKE OF VEHICLE',
    'MODEL',
    'TYPE OF VEHICLE',
    'BODY TYPE',
    'FUEL TYPE',
    'DIESEL'
  ].join('\n');
  check(classifyOcrDocument(ntsaCert) === 'logbook', 'an NTSA registration certificate classifies as a logbook');
  const ntsaHints = extractDocumentHints(ntsaCert, 'logbook', { countryCode: 'KE' });
  check(ntsaHints.plate_number === 'N7200766H', 'the plate is read from the line under REGISTRATION CERTIFICATE');
  check(ntsaHints.vin === undefined, 'a pure-digit TRANSFER number is never stored as a VIN');
  const oldLogbook = extractDocumentHints('VIN JTE777A1234567890\nREG NO KDA 123A', 'logbook');
  check(oldLogbook.vin === 'JTE777A1234567890' && oldLogbook.plate_number === 'KDA 123A', 'classic VIN/REG NO logbooks still extract');

  // v1.53.2 — the real NTSA "VEHICLE PARTICULARS" table (KE profile): value-before-label.
  const ntsaParticulars = [
    'REGISTRATION CERTIFICATE',
    'N7200766H',
    'VEHICLE PARTICULARS',
    'KAS628T DATE OF REGISTRATION',
    'HDJ810007675 GROSS WEIGHT (KGS)',
    'TOYOTA DUTY',
    'LAND CRUISER NO. OF PREVIOUS OWNERS',
    'S.WAGON TARE WEIGHT (KGS).',
    'DIESEL TAX CLASS',
    '1991 NO. OF AXLES',
    '1HD-0015769 PREVIOUS REG. COUNTRY',
    'SILVER PREVIOUS REGISTRATION'
  ].join('\n');
  const particulars = extractDocumentHints(ntsaParticulars, 'logbook', { countryCode: 'KE' });
  check(particulars.plate_number === 'KAS628T', 'the CURRENT plate (beside DATE OF REGISTRATION) beats the title-line previous plate');
  check(particulars.vin === 'HDJ810007675', 'chassis is read beside GROSS WEIGHT');
  check(particulars.make_model === 'TOYOTA LAND CRUISER S.WAGON', 'make + model + body are read from the PARTICULARS table');
  check(particulars.yom === 1991 && particulars.fuel_type === 'diesel', 'year (beside NO. OF AXLES) and fuel (beside TAX CLASS) are read');
  check(particulars.engine_number === '1HD-0015769' && particulars.color === 'silver', 'engine number and colour are read');
  // GLOBAL regression: the same document must never leak NTSA rules (rule 36).
  const particularsGlobal = extractDocumentHints(ntsaParticulars, 'logbook', { countryCode: 'GLOBAL' });
  check(particularsGlobal.plate_number === 'N7200766H', 'GLOBAL path uses the title-line plate, never the KE PARTICULARS plate');
  check(particularsGlobal.make_model === undefined && particularsGlobal.yom === undefined, 'GLOBAL path never applies the NTSA PARTICULARS rules');

  console.log('--- Test 14: universal normalization (v1.54.1) ---');
  const euReceipt = [
    'ARAL TANKSTELLE',
    'DIESEL 40,5 L',
    'TOTAL €',
    '1.234,56',
    'Datum: 12.10.2026'
  ].join('\n');
  const euHints = extractDocumentHints(euReceipt, 'receipt_fuel', { countryCode: 'DE' });
  check(euHints.amount === 1234.56, 'a German receipt TOTAL 1.234,56 reads 1234.56 (EU decimal convention)');
  check(euHints.currency === 'EUR', 'the EU receipt resolves EUR from its market');
  const euLens = parseDocumentFields(euReceipt, { countryCode: 'DE' });
  check(euLens.family === 'receipt_fuel', 'the German receipt classifies as a fuel receipt');
  check(euLens.hints.amount === 1234.56, 'the Document Lens parses the EU TOTAL through the universal normalizer');
  const euLensGlobal = parseDocumentFields(euReceipt, { countryCode: 'GLOBAL' });
  check(euLensGlobal.hints.amount === 1234.56, 'GLOBAL still parses the structurally-unambiguous EU grouping (rule 36)');
  const brazilian = extractDocumentHints('POSTO IPIRANGA\nTOTAL R$ 250,00', 'receipt_fuel', { countryCode: 'BR' });
  check(brazilian.currency === 'BRL' && brazilian.amount === 250, 'R$ resolves to BRL and the comma decimal parses for Brazil');
  const noTopUp = await semanticOcrTopUp({ text: euReceipt, family: 'receipt_fuel', countryCode: 'DE', existing: {} });
  check(Object.keys(noTopUp).length === 0, 'the AI top-up stays OFF while OCR_AI_EXTRACTION is unset');
  check(classifyDocumentFamily('PURCHASE INVOICE\nSeller: Auto Mall Ltd\nSold to: David Njonjo\nPurchase price 1,250,000\n2026-09-01') === 'purchase_invoice', 'a strong PURCHASE INVOICE marker wins over the generic INVOICE base (v1.54.1)');
  const purchaseLens = parseDocumentFields('PURCHASE INVOICE\nSeller: Auto Mall Ltd\nSold to: David Njonjo\nPurchase price 1,250,000\n2026-09-01');
  check(purchaseLens.hints.purchase_cost === 1250000, 'the purchase prefill now fires with the parsed cost');

  console.log('--- Test 15: country parsing profiles as data + watchlist (v1.54.2) ---');
  const profilesModule = await import('./src/data/ocrCountryProfiles.js');
  const { getOcrCountryProfile, KE_OCR_PROFILE, isKenyaEtimesText: isKeEtimes } = profilesModule;
  check(getOcrCountryProfile('KE') === KE_OCR_PROFILE, 'the KE parsing profile resolves from the country code');
  check(getOcrCountryProfile('GLOBAL') === null && getOcrCountryProfile('NG') === null, 'GLOBAL and unprofiled countries use the neutral path (rule 36)');
  check(typeof KE_OCR_PROFILE.etimes.extractHints === 'function' && typeof KE_OCR_PROFILE.logbook.extractHints === 'function', 'a profile carries its receipt and logbook parsers');
  check(isKeEtimes(etimsText) === true && isKeEtimes('TOTAL 3000') === false, 'the e-TIMS marker detector still resolves from the registry');

  const ocrTelemetryModule = await import('./src/services/ocrTelemetry.js');
  const { summarizeOcrCountryRows } = ocrTelemetryModule;
  const superadminOcrModule = await import('./src/services/superadmin.js');
  const { formatOcrProfileReply } = superadminOcrModule;
  const profileCommand = await superadminOcrModule.parseSuperadminCommand('admin ocr-profile KE');
  check(profileCommand.intent === 'ADMIN_OCR_PROFILE' && profileCommand.countryCode === 'KE', 'admin ocr-profile KE parses deterministically');
  const profileCommandBare = await superadminOcrModule.parseSuperadminCommand('admin ocr-profile');
  check(profileCommandBare.intent === 'ADMIN_OCR_PROFILE' && profileCommandBare.countryCode === null, 'a bare admin ocr-profile parses (shows the GLOBAL bucket)');
  const healthy = summarizeOcrCountryRows([
    { country_code: 'KE', status: 'read', document_kind: 'receipt_fuel', confidence: 0.92 },
    { country_code: 'KE', status: 'read', document_kind: 'logbook', confidence: 0.95 },
    { country_code: 'KE', status: 'read', document_kind: 'receipt_fuel', confidence: 0.9 },
    { country_code: 'KE', status: 'read', document_kind: 'insurance', confidence: 0.88 },
    { country_code: 'KE', status: 'read', document_kind: 'receipt_fuel', confidence: 0.91 }
  ]);
  check(healthy.total === 5 && healthy.watch === false, 'a healthy country never triggers the watch flag');
  check(formatOcrProfileReply({ ok: true, hours: 168, countryCode: 'KE', total: 5, byStatus: { read: 5 }, byKind: { receipt_fuel: 3 }, failed: 0, lowConfidence: 0, avgConfidence: 0.91, watch: false }).includes('Healthy'), 'the profile digest renders the healthy verdict');
  const watch = summarizeOcrCountryRows([
    { country_code: 'NG', status: 'failed', document_kind: 'logbook', confidence: null },
    { country_code: 'NG', status: 'read', document_kind: 'receipt_fuel', confidence: 0.9 },
    { country_code: 'NG', status: 'failed', document_kind: 'receipt_fuel', confidence: null },
    { country_code: 'NG', status: 'read', document_kind: 'logbook', confidence: 0.93 },
    { country_code: 'NG', status: 'read', document_kind: 'receipt_fuel', confidence: 0.91 }
  ]);
  check(watch.watch === true && watch.reason === 'unusable-read rate', 'a country crossing the unusable-read threshold is flagged for a profile');
  check(watch.total === 5 && watch.failed === 2, 'the roll-up counts unusable reads');
  check(formatOcrProfileReply({ ok: true, hours: 168, countryCode: 'NG', total: 5, byStatus: { failed: 2, read: 3 }, byKind: { logbook: 2, receipt_fuel: 3 }, failed: 2, lowConfidence: 0, avgConfidence: 0.91, watch: true, reason: 'unusable-read rate' }).includes('Watch'), 'the profile digest renders the watch verdict with the reason');
  const underSample = summarizeOcrCountryRows([{ country_code: 'TZ', status: 'failed', document_kind: 'logbook', confidence: null }]);
  check(underSample.watch === false, 'countries below the sample floor are never flagged');

  console.log('\n--- Test 13: duplicate protection (v1.32.1) ---');
  const shaA = buildOcrTextSha('TOTAL  3,000.00\nDIESEL');
  const shaB = buildOcrTextSha('TOTAL 3,000.00 DIESEL');
  check(shaA && shaA === shaB, 'Content hash ignores whitespace differences');
  check(buildOcrTextSha('TOTAL 2,000.00') !== shaA, 'Different receipts hash differently');
  check(buildOcrTextSha('   ') === null, 'Empty OCR text has no content hash');
  const sameDay = { plate: 'KAS 628T', amount: 3000, expense_type: 'Fuel', odometer_reading: 367480, created_at: new Date().toISOString() };
  check(isSameExpenseCandidate(sameDay, { plate: 'KAS 628T', amount: 3000, expenseType: 'fuel', odometer: 367480 }), 'Same plate + amount + type + Nairobi day is a duplicate');
  check(!isSameExpenseCandidate(sameDay, { plate: 'KAS 628T', amount: 3000, expenseType: 'Fuel', odometer: 367500 }), 'A different odometer reading proves a separate fill');
  check(!isSameExpenseCandidate(sameDay, { plate: 'KAS 628T', amount: 3100, expenseType: 'Fuel' }), 'A different amount is never a duplicate');
  check(nairobiDateKey('2026-11-01T21:30:00Z') === '2026-11-02', 'Day comparison uses Africa/Nairobi (UTC+3)');
  const ocrSummary = await getOcrUsageSummary(null, 24);
  check(ocrSummary.ok === false && ocrSummary.error === 'no-client', 'OCR summary is fail-soft without a client');
  const { parseSuperadminCommand, formatOcrStatsReply } = await import('./src/services/superadmin.js');
  const ocrCommand = await parseSuperadminCommand('admin ocr-stats 12h');
  check(ocrCommand.intent === 'ADMIN_OCR_STATS' && ocrCommand.hours === 12, 'admin ocr-stats parses with a custom window');
  const ocrDigest = formatOcrStatsReply({
    ok: true,
    hours: 24,
    total: 4,
    byStatus: { read: 2, failed: 1, pdf_text: 1 },
    byKind: { receipt_fuel: 2, logbook: 1 },
    byCountry: { KE: 3, US: 1 },
    byProvider: { google_vision: 3, local_pdf: 1 },
    avgConfidence: 0.91,
    avgLatencyMs: 2400
  });
  check(ocrDigest.includes('Saka OCR Stats') && ocrDigest.includes('Countries') && ocrDigest.includes('KE'), 'OCR digest reports outcomes, documents and countries');
  check(ocrDigest.includes('unusable: 1'), 'OCR digest counts unusable reads');

  console.log('\n--- Test 14: silent-crash regression guard (v1.32.1) ---');
  const whatsappSource = readFileSync(new URL('./src/routes/whatsapp/messages.js', import.meta.url), 'utf8');
  check(/let session = null;/.test(whatsappSource), 'session is hoisted before the try block');
  check(/session\?\.slowAckSent === true/.test(whatsappSource), 'catch block uses optional chaining (no masking ReferenceError)');
  check(!/ackSent: session\.slowAckSent/.test(whatsappSource), 'no bare session reference remains in the latency call');
  check(/logSystemError\(supabaseClient, err, '\/webhook\/whatsapp'\)/.test(whatsappSource), 'the original error is persisted to error_logs');

  // v1.73.4 — Phase 12B: a template button/list tap resolves BEFORE the media
  // envelope, and an unrecognised interactive shape is diagnosed in error_logs.
  const interactiveCallAt = whatsappSource.indexOf('parseInteractiveReply(messageObj)');
  const mediaEnvelopeAt = whatsappSource.indexOf('resolveMediaEnvelope(messageObj)');
  check(interactiveCallAt > 0 && mediaEnvelopeAt > interactiveCallAt, 'a template button tap resolves before the media envelope (v1.73.4)');
  check(whatsappSource.includes("'/webhook/whatsapp/interactive'"), 'an unrecognised interactive shape is logged to error_logs (v1.73.4)');

  global.fetch = realFetch;
  delete process.env.GCP_VISION_API_KEY;
  console.log(`\n🎉 ALL OCR FLOW TESTS PASSED (${passed} assertions).`);
}

// v1.63.1 (2C) — receipt write/delete invalidation spies (stateless chain mock).
console.log('\n--- v1.63.1: receipt invalidation spies ---');
{
  const deletes = [];
  const receiptRow = { id: 'rc-1', owner_id: 'owner-r', driver_id: null, media_id: 'm-1' };
  const builder = (table) => {
    const api = {
      select: () => api,
      eq: () => api,
      in: () => api,
      is: () => api,
      limit: () => api,
      insert: (rows) => {
        const data = Array.isArray(rows) ? rows : [rows];
        const chain = {
          select: () => chain,
          maybeSingle: async () => ({ data: data[0], error: null }),
          then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject)
        };
        return chain;
      },
      delete: () => ({ eq: (col, value) => { deletes.push({ table, col, value }); return Promise.resolve({ error: null }); } }),
      maybeSingle: async () => ({ data: table === 'receipts' ? receiptRow : null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
    };
    return api;
  };
  const client = { from: builder, storage: { from: () => ({ remove: async () => ({ error: null }) }) } };
  const recorded = await recordReceipt(client, { mediaId: 'm-1', ownerId: 'owner-r', documentKind: 'fuel', amount: 100 });
  check(recorded.ok === true && deletes.some((d) => d.table === 'user_context_cache' && d.col === 'owner_id' && d.value === 'owner-r'), 'recordReceipt invalidates the owner cache (v1.63.1)');
  deletes.length = 0;
  const removed = await deleteReceipt(client, { receiptId: 'rc-1', ownerId: 'owner-r' });
  check(removed.ok === true && deletes.some((d) => d.table === 'user_context_cache' && d.col === 'owner_id' && d.value === 'owner-r'), 'deleteReceipt invalidates the owner cache (v1.63.1)');
}

run().catch((err) => {
  global.fetch = realFetch;
  console.error(err.message);
  process.exit(1);
});
