import {
  downloadWhatsAppMedia,
  extractTextFromImage,
  ocrWhatsAppMedia,
  extractReceiptHints
} from './src/services/ocrService.js';
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
    aiExtracted: { expense_type: 'Fuel', ...hints },
    startFlow: 'log_expense',
    ctx
  });

  assert(session.quiz?.phase === 'confirm', 'Receipt quiz reaches the confirmation gate (no write yet)');
  assert(session.quiz.answers.amount === 5500, 'OCR total prefilled the amount');
  assert(session.quiz.answers.fuel_liters === 40.5, 'OCR volume prefilled the fuel litres');
  assert(session.quiz.answers.odometer_reading === 366800, 'OCR odometer prefilled the reading');

  global.fetch = realFetch;
  delete process.env.GCP_VISION_API_KEY;
  console.log(`\n🎉 ALL OCR FLOW TESTS PASSED (${passed} assertions).`);
}

run().catch((err) => {
  global.fetch = realFetch;
  console.error(err.message);
  process.exit(1);
});
