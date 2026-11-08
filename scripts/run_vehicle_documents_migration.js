import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { VEHICLE_DOCUMENTS_SQL, VEHICLE_DOCUMENTS_SUPERSEDE_SQL } from '../src/services/vehicleDocuments.js';

/**
 * Saka Fleet — Vehicle Document RENEWAL migration (Phase 25, v1.86.0).
 * ---------------------------------------------------------------------
 * A renewed insurance/inspection/logbook no longer piles a new row on top of the
 * old one: the previous file of the same `document_type` is marked superseded
 * (`superseded_at`, `superseded_by`) and kept on file as evidence (rule 48).
 *
 * Idempotent: re-applies the base table SQL (CREATE … IF NOT EXISTS) plus
 * ADD COLUMN IF NOT EXISTS and the partial current-file index.
 * Run: npm run migrate:document-replacement
 */

export const DOCUMENT_REPLACEMENT_SQL = `${VEHICLE_DOCUMENTS_SQL}\n${VEHICLE_DOCUMENTS_SUPERSEDE_SQL}`;

export async function applyDocumentReplacementMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing document-replacement migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(DOCUMENT_REPLACEMENT_SQL, { label: 'documentReplacementMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('✅ Document replacement migration applied (superseded_at + superseded_by + current index).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyDocumentReplacementMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
