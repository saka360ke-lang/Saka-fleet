import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { RECEIPTS_SQL } from '../src/services/receipts.js';

/**
 * Saka Fleet — Receipt vault migration (v1.19.0).
 * Creates public.receipts (OCR dedupe, hints, image URL, audit status).
 * Run: npm run migrate:receipts
 */

export async function applyReceiptsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing receipts migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(RECEIPTS_SQL, { label: 'receiptsMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Receipts migration applied (public.receipts).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyReceiptsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}