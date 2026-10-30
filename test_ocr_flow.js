import {
  downloadWhatsAppMedia,
  extractTextFromImage,
  ocrWhatsAppMedia,
  extractReceiptHints,
  extractDocumentHints,
  classifyOcrDocument,
  OCR_VISION_TIMEOUT_MS,
  OCR_VISION_MAX_ATTEMPTS
} from './src/services/ocrService.js';
import {
  OCR_LOW_CONFIDENCE_NOTE,
  OCR_UNREADABLE_NOTE,
  OCR_CONFIRM_THRESHOLD,
  formatReceiptsReply,
  formatDuplicateReceiptReply
} from './src/services/receipts.js';
import { handleQuizTurn } from './src/services/quizEngine.js';

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

  console.log('\n--- Test 4: unsupported media types ---');
  const pdf = await ocrWhatsAppMedia({ mediaId: 'doc-1', mimeType: 'application/pdf', token: 't' });
  assert(pdf.text === null && /Unsupported media type/i.test(pdf.error), 'PDF documents are politely rejected in v1');

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
  const duplicateReply = formatDuplicateReceiptReply({ vendor: 'SHELL KAREN', amount: 5500, currency: 'KES', created_at: '2026-10-12T08:00:00Z' });
  check(duplicateReply.includes('already read') && duplicateReply.includes('receipts'), 'Duplicate receipt reply is warm and offers history');

  global.fetch = realFetch;
  delete process.env.GCP_VISION_API_KEY;
  console.log(`\n🎉 ALL OCR FLOW TESTS PASSED (${passed} assertions).`);
}

run().catch((err) => {
  global.fetch = realFetch;
  console.error(err.message);
  process.exit(1);
});
