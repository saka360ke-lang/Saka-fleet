import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { VEHICLE_DOCUMENTS_SQL } from '../src/services/vehicleDocuments.js';

/**
 * Saka Fleet — Vehicle Document Vault migration (Phase 23, v1.84.0).
 * Creates public.vehicle_documents (logbook / insurance / inspection / road
 * licence originals kept in the private `documents` bucket) with the nullable
 * compliance FK and the media-id dedupe key.
 *
 * Idempotent: CREATE TABLE/INDEX IF NOT EXISTS + a guarded constraint add.
 * Run: npm run migrate:vehicle-documents
 */

export async function applyVehicleDocumentsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing vehicle_documents migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(VEHICLE_DOCUMENTS_SQL, { label: 'vehicleDocumentsMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Vehicle documents migration applied (public.vehicle_documents).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyVehicleDocumentsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
