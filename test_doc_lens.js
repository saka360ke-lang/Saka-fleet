import assert from 'assert';
import PDFDocument from 'pdfkit';
import { extractPdfText, extractTextFromContentStream, OCR_PDF_MAX_PAGES } from './src/services/pdfTextExtractor.js';
import {
  parseDocumentFields,
  classifyDocumentFamily,
  uploadHintFor,
  DOCUMENT_SUPPORT_MENU,
  DOCUMENT_UPLOAD_HINTS
} from './src/services/documentLens.js';
import { ocrWhatsAppMedia } from './src/services/ocrService.js';

/**
 * Saka Fleet — Document Lens suite (v1.20.0)
 * Stateless: PDFs are generated in memory with pdfkit, all network mocked.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

function buildPdf(lines, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, compress });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    lines.forEach((line, index) => {
      doc.fontSize(index === 0 ? 14 : 10).text(line, { lineGap: 2 });
    });
    doc.end();
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const realFetch = global.fetch;

async function run() {
  console.log('=== SAKA FLEET — DOCUMENT LENS TESTS (v1.20.0) ===\n');

  console.log('--- Test 1: PDF content-stream parsing ---');
  const stream = 'BT /F1 12 Tf 40 700 Td (Registration No: KDA 123A) Tj 0 -14 Td [(VIN: ) -50 (JTE777A1234567890)] TJ ET';
  const parsedStream = extractTextFromContentStream(stream);
  check(parsedStream.includes('KDA 123A'), 'literal strings (Tj) are decoded');
  check(parsedStream.includes('JTE777A1234567890'), 'TJ arrays join kerning fragments');
  check(extractTextFromContentStream('BT <4B44412031323341> Tj ET').includes('KDA 123A'), 'hex strings decode to text');
  check(extractTextFromContentStream('(Hello \\(world\\) \\101) Tj').includes('Hello (world) A'), 'escaped literals decode correctly');

  console.log('\n--- Test 2: real PDF text extraction (pdfkit) ---');
  const logbookPdf = await buildPdf([
    'REPUBLIC OF KENYA - NATIONAL TRANSPORT AND SAFETY AUTHORITY',
    'Registration No: KDA 123A',
    'VIN: JTE777A1234567890',
    'Make: Toyota Model: Fielder',
    'Year of Manufacture: 2016',
    'Engine No: 2ZR1234567',
    'Colour: Silver'
  ]);
  const pdfRead = extractPdfText(logbookPdf);
  check(pdfRead.error === null, 'text-layer PDF is read without error');
  check(pdfRead.text.includes('KDA 123A') && pdfRead.text.includes('JTE777A1234567890'), 'plate and VIN survive extraction');
  check(pdfRead.pages >= 1, 'page count is reported');
  check(OCR_PDF_MAX_PAGES >= 1, 'PDF page cap knob is exported');

  const uncompressed = await buildPdf(['INSURANCE CERTIFICATE', 'Policy No: ABC12345', 'Expires 2027-05-15'], { compress: false });
  const plainRead = extractPdfText(uncompressed);
  check(plainRead.text && plainRead.text.includes('ABC12345'), 'uncompressed PDFs are supported');

  console.log('\n--- Test 3: PDF guards ---');
  check(extractPdfText(Buffer.from('not a pdf')).error === 'Not a PDF document', 'non-PDF buffers are rejected');
  check(extractPdfText(Buffer.alloc(0)).error === 'No PDF buffer', 'empty buffers are safe');
  const scanned = Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Page>>\nendobj\n%%EOF');
  const scannedRead = extractPdfText(scanned);
  check(scannedRead.text === null && /scan|readable text/i.test(scannedRead.error), 'scanned PDFs explain the photo fallback');

  console.log('\n--- Test 4: registration certificate parsing ---');
  const logbook = parseDocumentFields(pdfRead.text, { countryCode: 'KE' });
  check(logbook.family === 'logbook', 'registration certificate is classified');
  check(logbook.fields.plate_number?.value === 'KDA 123A', 'plate parsed');
  check(logbook.fields.vin?.value === 'JTE777A1234567890', 'VIN parsed as a field');
  check(/toyota/i.test(logbook.fields.make_model?.value || ''), 'make/model parsed');
  check(logbook.fields.yom?.value === 2016, 'year of manufacture parsed');
  check(logbook.fields.color?.value === 'Silver', 'colour parsed');
  check(logbook.hints.plate_number === 'KDA 123A' && logbook.hints.vin === 'JTE777A1234567890', 'hints map to quiz field names');
  check(logbook.confidence > 0.5, 'per-field confidence is reported');

  console.log('\n--- Test 5: insurance, licence, inspection, road licence ---');
  const insurance = parseDocumentFields('MOTOR INSURANCE POLICY\nPolicy No: ABC12345\nInsurer: Jubilee Insurance\nSum Insured: 1,500,000\nExpires 2027-05-15');
  check(insurance.family === 'insurance' && insurance.fields.insurance_policy?.value === 'ABC12345', 'insurance policy parsed');
  check(insurance.hints.insurance_expiry === '2027-05-15', 'insurance expiry normalized to ISO');
  check(/jubilee/i.test(insurance.fields.insurer?.value || ''), 'insurer parsed');

  const licence = parseDocumentFields('DRIVING LICENCE\nDL No: 123456\nPSV BADGE\nExpires 2027-01-31');
  check(licence.family === 'drivers_licence', 'licence classified');
  check(licence.fields.compliance_type?.value === 'PSV Badge', 'PSV badge detected');
  check(licence.hints.compliance_expiry === '2027-01-31', 'licence expiry normalized');

  const inspection = parseDocumentFields('VEHICLE INSPECTION CERTIFICATE\nCertificate No: INS9988\nNext inspection due 2027-03-15');
  check(inspection.family === 'inspection' && inspection.hints.inspection_expiry === '2027-03-15', 'inspection certificate parsed');

  const roadLicence = parseDocumentFields('ROAD SERVICE LICENCE\nLicence No: RSL5544\nValid until 2027-06-30');
  check(roadLicence.family === 'road_licence' && roadLicence.hints.compliance_expiry === '2027-06-30', 'road service licence parsed');

  console.log('\n--- Test 6: fuel, service and purchase documents ---');
  const fuel = parseDocumentFields('SHELL KAREN\nPUMP 4\nDIESEL 40.5 L\nFULL TANK\nOdometer: 366800\nTOTAL KES 5,500\n2026-10-12');
  check(fuel.family === 'receipt_fuel', 'fuel receipt classified');
  check(fuel.hints.amount === 5500 && fuel.hints.fuel_liters === 40.5, 'amount and litres parsed');
  check(fuel.hints.odometer === 366800 && fuel.hints.currency === 'KES', 'odometer and currency parsed');
  check(fuel.fields.fill_type?.value === 'full', 'full-tank flag parsed');

  const service = parseDocumentFields('KAREN AUTO GARAGE\nSERVICE INVOICE\nOil filter 1,200\nBrake pads 4,500\nTOTAL KES 6,800\n2026-10-10');
  check(service.family === 'service_receipt', 'service invoice classified');
  check(service.fields.service_items?.value?.includes('oil filter'), 'service items parsed');
  check(service.hints.amount === 6800, 'service total parsed');

  const purchase = parseDocumentFields('PURCHASE INVOICE\nSeller: Auto Mall Ltd\nSold to: David Njonjo\nPurchase price 1,250,000\n2026-09-01');
  check(purchase.family === 'purchase_invoice' && purchase.hints.purchase_cost === 1250000, 'purchase invoice parsed');


  console.log('\n--- Test 7: upload affordances ---');
  check(DOCUMENT_UPLOAD_HINTS.plate_number.includes('logbook'), 'plate question advertises the logbook upload');
  check(DOCUMENT_UPLOAD_HINTS.insurance_expiry.includes('insurance certificate'), 'expiry question advertises the certificate upload');
  check(/📄|🧾|🛡️|🪪/.test(DOCUMENT_UPLOAD_HINTS.amount), 'receipt hint carries a visual anchor');
  check(Boolean(uploadHintFor('vin')) && uploadHintFor('unknown_field') === null, 'hints are field-scoped');
  check(DOCUMENT_SUPPORT_MENU.includes('Logbook') && DOCUMENT_SUPPORT_MENU.includes('PDF'), 'support menu lists documents and PDFs');

  console.log('\n--- Test 8: WhatsApp PDF intake (end to end) ---');
  global.fetch = async (url) => {
    if (String(url).includes('graph.facebook.com')) {
      return jsonResponse({ url: 'https://cdn.example/logbook.pdf', mime_type: 'application/pdf', file_size: logbookPdf.length });
    }
    return new Response(logbookPdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
  };
  const intake = await ocrWhatsAppMedia({ mediaId: 'pdf-1', mimeType: 'application/pdf', token: 'test-token' });
  check(intake.kind === 'pdf' && intake.error === null, 'PDF documents flow through the OCR intake');
  check(intake.text.includes('KDA 123A'), 'PDF text reaches the conversation turn');
  const pdfLens = parseDocumentFields(intake.text, { countryCode: 'KE' });
  check(pdfLens.family === 'logbook' && pdfLens.hints.vin === 'JTE777A1234567890', 'PDF logbook pre-fills the registration quiz');

  let scannedCall = 0;
  global.fetch = async () => {
    scannedCall += 1;
    if (scannedCall === 1) {
      return jsonResponse({ url: 'https://cdn.example/notes.pdf', mime_type: 'application/pdf', file_size: scanned.length });
    }
    return new Response(scanned, { status: 200, headers: { 'content-type': 'application/pdf' } });
  };
  const scannedIntake = await ocrWhatsAppMedia({ mediaId: 'pdf-2', mimeType: 'application/pdf', token: 'test-token' });
  check(scannedIntake.text === null && /scan|readable text/i.test(scannedIntake.error), 'scanned PDFs ask for photos, never silently fail');

  console.log('\n--- Test 9: classification safety ---');
  check(classifyDocumentFamily('random text without signals') === 'unknown', 'unknown documents stay unknown');
  check(classifyDocumentFamily('MOTOR INSURANCE POLICY\nPolicy No ABC12345') === 'insurance', 'insurance classifier stable');
  check(classifyDocumentFamily('GARAGE SERVICE INVOICE\nTOTAL KES 4,000') === 'service_receipt', 'garage invoice is a service receipt');

  global.fetch = realFetch;
  console.log(`\n🎉 ALL DOCUMENT LENS TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: PDFs are generated in memory, so no cleanup is required.');
}

run().catch((err) => {
  global.fetch = realFetch;
  console.error(err.message);
  process.exit(1);
});

