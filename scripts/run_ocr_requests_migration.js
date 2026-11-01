import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { OCR_REQUESTS_SQL } from '../src/services/ocrTelemetry.js';
import { RECEIPTS_SQL } from '../src/services/receipts.js';

/**
 * Saka Fleet — OCR requests migration (v1.32.1).
 *
 * 1. Creates `public.ocr_requests` (one row per OCR turn: status, provider,
 *    confidence, attempts, latency, country — never document text).
 * 2. Adds the receipts text-hash index used by duplicate-upload detection.
 * 3. Backfills the three rows misclassified during the 2026-11-01 audit
 *    (Kenya e-TIMS fuel receipts + the Bima Yangu insurance certificate).
 *
 * Idempotent: CREATE ... IF NOT EXISTS + exact-media-id UPDATEs.
 * Run: npm run migrate:ocr-requests
 */

export const OCR_BACKFILL_SQL = `
    UPDATE public.receipts
       SET document_kind = 'receipt_fuel'
     WHERE document_kind = 'purchase_invoice'
       AND media_id IN ('1796235211499272', '2892848571100840');
    UPDATE public.receipts
       SET document_kind = 'insurance'
     WHERE document_kind = 'logbook'
       AND media_id IN ('949674331278052', '1189365943417791');
`;

export async function applyOcrRequestsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing OCR requests migration on Supabase project: ${getProjectRef()}...`);
  const table = await runSql(OCR_REQUESTS_SQL, { label: 'ocrRequestsMigration' });
  if (!table.ok) {
    console.error('Migration failed (ocr_requests):', table.error || table.body);
    return { success: false, ...table };
  }
  const receipts = await runSql(RECEIPTS_SQL, { label: 'receiptsTextShaIndex' });
  if (!receipts.ok) {
    console.error('Migration failed (receipts index):', receipts.error || receipts.body);
    return { success: false, ...receipts };
  }
  const backfill = await runSql(OCR_BACKFILL_SQL, { label: 'ocrReceiptBackfill' });
  if (!backfill.ok) {
    console.error('Backfill failed:', backfill.error || backfill.body);
    return { success: false, ...backfill };
  }
  console.log('✅ OCR requests migration applied (table + receipts text_sha index + 2026-11-01 backfill).');
  return { success: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyOcrRequestsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}