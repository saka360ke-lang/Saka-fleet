/** Saka Fleet — vehicle document vault tests (Phase 23, v1.84.0, stateless) */
import assert from 'assert';
import fs from 'fs';
import {
  DOCUMENTS_BUCKET,
  VEHICLE_DOCUMENTS_SQL,
  VEHICLE_DOCUMENTS_SUPERSEDE_SQL,
  documentTypeForFamily,
  isVaultableDocumentFamily,
  complianceTypeForDocumentType,
  documentStorageExtension,
  documentStoragePath,
  documentTypeLabel,
  vaultVehicleDocument,
  listVehicleDocuments,
  supersedePreviousDocuments,
  countSupersededDocuments,
  deleteVehicleDocument,
  linkSavedComplianceDocument,
  findPendingDocument,
  formatVehicleDocumentsReply
} from './src/services/vehicleDocuments.js';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { wipeProfileForSignup } from './src/services/profileWipe.js';

let passed = 0;
function check(cond, label) { assert.ok(cond, label); passed += 1; console.log('  ok ' + label); }

const NOW = new Date().toISOString();

console.log('--- Test 1: family → document_type mapping (vehicle-only) ---');
check(documentTypeForFamily('logbook') === 'logbook', 'a logbook stays a logbook');
check(documentTypeForFamily('insurance') === 'insurance', 'an insurance certificate maps 1:1');
check(documentTypeForFamily('inspection') === 'inspection', 'an inspection certificate maps 1:1');
check(documentTypeForFamily('road_licence') === 'road_license', 'a road licence maps to road_license');
check(isVaultableDocumentFamily('drivers_licence') === false, 'driver licences stay OUT of the vehicle vault (§40.2)');
check(isVaultableDocumentFamily('receipt_fuel') === false, 'receipts never enter the document vault');
check(complianceTypeForDocumentType('road_license') === 'road_service_licence', 'road licence proves the road service licence row');
check(complianceTypeForDocumentType('pinkslip') === 'inspection' && complianceTypeForDocumentType('ntsa_cert') === 'inspection', 'pinkslip/NTSA certs prove the inspection row');
check(complianceTypeForDocumentType('logbook') === 'registration', 'the logbook proves the registration row');
check(documentTypeLabel('insurance') === 'Insurance certificate', 'a plain-language label exists per type');
check(documentStorageExtension('application/pdf') === 'pdf' && documentStorageExtension('image/webp') === 'webp', 'the object extension follows the mime type');
check(/^v1\/[0-9a-f-]{36}\.pdf$/.test(documentStoragePath('v1', 'application/pdf')), 'the object path is documents/<vehicle_id>/<uuid>.<ext>');

console.log('--- Test 2: DDL contract ---');
check(/media_id text UNIQUE/.test(VEHICLE_DOCUMENTS_SQL), 'media_id UNIQUE makes re-uploads physical (D1)');
check(/parsed_data jsonb/.test(VEHICLE_DOCUMENTS_SQL), 'parsed_data jsonb carries the OCR fields');
check(/REFERENCES public\.vehicles\(id\) ON DELETE CASCADE/.test(VEHICLE_DOCUMENTS_SQL), 'a vehicle delete cascades its stored documents');
check(/REFERENCES public\.vehicle_compliances\(id\) ON DELETE SET NULL/.test(VEHICLE_DOCUMENTS_SQL), 'compliance_id is a nullable FK with ON DELETE SET NULL');
check(/vehicle_documents_compliance_fk/.test(VEHICLE_DOCUMENTS_SQL), 'the FK add is guarded (idempotent migration)');
check(DOCUMENTS_BUCKET === (process.env.DOCUMENTS_BUCKET || 'documents'), 'the bucket name is knobs-driven (default: documents)');

console.log('--- Test 3: paid vault upload ---');
const paid = createMockSupabase({ vehicle_documents: [] });
const vaulted = await vaultVehicleDocument({
  supabase: paid.client,
  vehicleId: 'v1',
  profileId: 'p1',
  buffer: Buffer.from('%PDF-1.7 logbook'),
  mediaId: 'm-100',
  mimeType: 'application/pdf',
  originalFilename: 'logbook.pdf',
  parsedData: { vin: 'VIN1', plate_number: 'KDA 123A' },
  documentType: 'logbook',
  entitlements: { receiptVaultStorage: true }
});
check(vaulted.ok === true && vaulted.stored === true, 'a paid-tier logbook is stored with its file');
check(paid.db.vehicle_documents.length === 1, 'ONE vehicle_documents row is written');
const storedRow = paid.db.vehicle_documents[0];
check(/^v1\/[0-9a-f-]{36}\.pdf$/.test(storedRow.storage_path || ''), 'the row carries the bucket-relative storage_path');
check(storedRow.media_id === 'm-100' && storedRow.document_type === 'logbook', 'media id + document type are stored');
check(storedRow.uploaded_by === 'p1' && storedRow.original_filename === 'logbook.pdf', 'uploader and original filename are stored');
check(storedRow.parsed_data?.vin === 'VIN1', 'parsed_data keeps the extracted VIN');
check(paid.state.uploads.some((u) => u.bucket === DOCUMENTS_BUCKET && u.path === storedRow.storage_path), 'the file lands in the documents bucket');

console.log('--- Test 4: re-upload dedupe by media id ---');
const again = await vaultVehicleDocument({
  supabase: paid.client,
  vehicleId: 'v1',
  profileId: 'p1',
  buffer: Buffer.from('%PDF-1.7 logbook'),
  mediaId: 'm-100',
  mimeType: 'application/pdf',
  documentType: 'logbook',
  entitlements: { receiptVaultStorage: true }
});
check(again.ok === true && again.duplicate === true, 'the same media id returns the existing row');
check(paid.db.vehicle_documents.length === 1 && paid.state.uploads.length === 1, 'no second row and no second upload');

console.log('--- Test 5: Free tier keeps parsed data only (D2) ---');
const free = createMockSupabase({ vehicle_documents: [] });
const freeVault = await vaultVehicleDocument({
  supabase: free.client,
  vehicleId: 'v1',
  profileId: 'p1',
  buffer: Buffer.from('insurance'),
  mediaId: 'm-101',
  mimeType: 'image/jpeg',
  parsedData: { insurance_policy: 'C35343842' },
  documentType: 'insurance',
  entitlements: { receiptVaultStorage: false }
});
check(freeVault.ok === true && freeVault.document.storage_path === null && freeVault.stored === false, 'a Free row has no storage_path');
check(free.state.uploads.length === 0, 'Free never uploads a bucket object');
check(freeVault.document.parsed_data?.insurance_policy === 'C35343842', 'Free still keeps the parsed data');

console.log('--- Test 6: list is vehicle-scoped and newest-first ---');
const listMock = createMockSupabase({
  vehicle_documents: [
    { id: 'd-old', vehicle_id: 'v1', document_type: 'insurance', uploaded_at: '2026-01-01T00:00:00.000Z' },
    { id: 'd-new', vehicle_id: 'v1', document_type: 'logbook', uploaded_at: '2026-02-01T00:00:00.000Z' },
    { id: 'd-other', vehicle_id: 'v2', document_type: 'insurance', uploaded_at: '2026-03-01T00:00:00.000Z' }
  ]
});
const listed = await listVehicleDocuments(listMock.client, { vehicleId: 'v1', limit: 10 });
check(listed.length === 2 && listed[0].id === 'd-new', 'only this vehicle, newest first');
const fleetWide = await listVehicleDocuments(listMock.client, { vehicleIds: ['v1', 'v2'], limit: 10 });
check(fleetWide.length === 3, 'the owner list spans the whole fleet');
check((await listVehicleDocuments(listMock.client, {})).length === 0, 'no scope never leaks rows');
// v1.87.4 — the ONE-OBJECT call shape is tolerated: a caller once passed the
// whole options bag as the client, so the list answered [] and the vehicle page
// silently showed no stored files (live 2026-11-09 walkthrough).
const bagListed = await listVehicleDocuments({ supabase: listMock.client, vehicleId: 'v1', limit: 10 });
check(bagListed.length === 2 && bagListed[0].id === 'd-new', 'an options bag { supabase, vehicleId } is unwrapped, never silently empty (v1.87.4)');

console.log('--- Test 7: delete is owner-scoped, removes the object and audits ---');
const delMock = createMockSupabase({
  vehicle_documents: [{ id: 'd1', vehicle_id: 'v1', uploaded_by: 'p1', document_type: 'insurance', media_id: 'm-200', storage_path: 'v1/file.pdf', uploaded_at: NOW }],
  admin_audit_logs: []
});
const forbidden = await deleteVehicleDocument({ supabase: delMock.client, documentId: 'd1', ownerId: 'other', vehicleIds: [] });
check(forbidden.ok === false && forbidden.error === 'forbidden', 'another account cannot delete the file');
check(delMock.db.vehicle_documents.length === 1 && delMock.state.removals.length === 0, 'a forbidden delete never touches the row or bucket');
const removed = await deleteVehicleDocument({ supabase: delMock.client, documentId: 'd1', ownerId: 'p1', vehicleIds: ['v1'], senderPhone: '+254700000000' });
check(removed.ok === true && removed.objects === 1, 'the owner deletes the row and its stored object');
check(delMock.state.removals.some((r) => r.bucket === DOCUMENTS_BUCKET && r.path === 'v1/file.pdf'), 'the bucket remove targets the stored path');
check(delMock.db.vehicle_documents.length === 0, 'the vehicle_documents row is gone');
check(delMock.db.admin_audit_logs.some((row) => row.action === 'VEHICLE_DOCUMENT_DELETED' && row.details?.document_id === 'd1'), 'the deletion is audited VEHICLE_DOCUMENT_DELETED');
check((await deleteVehicleDocument({ supabase: delMock.client, documentId: 'd1', ownerId: 'p1', vehicleIds: ['v1'] })).error === 'not-found', 'an already-deleted document reports not-found');

console.log('--- Test 8: compliance link at save time ---');
const linkMock = createMockSupabase({
  vehicle_documents: [{ id: 'd-link', vehicle_id: 'v1', document_type: 'insurance', compliance_id: null, uploaded_at: NOW }],
  vehicle_compliances: [{ id: 'c1', vehicle_id: 'v1', type: 'insurance' }]
});
const explicit = await linkSavedComplianceDocument({ supabase: linkMock.client, vehicleId: 'v1', complianceType: 'insurance', documentId: 'd-link' });
check(explicit.ok === true && explicit.linked === true && explicit.complianceId === 'c1', 'the explicit prefill id links to the saved row');
check(linkMock.db.vehicle_documents[0].compliance_id === 'c1', 'the row carries compliance_id');
check((await findPendingDocument({ supabase: linkMock.client, vehicleId: 'v1', complianceType: 'insurance' })) === null, 'a linked document is never matched twice');
const fallbackMock = createMockSupabase({
  vehicle_documents: [{ id: 'd-fb', vehicle_id: 'v1', document_type: 'inspection', compliance_id: null, uploaded_at: NOW }],
  vehicle_compliances: [{ id: 'c2', vehicle_id: 'v1', type: 'inspection' }]
});
const fallback = await linkSavedComplianceDocument({ supabase: fallbackMock.client, vehicleId: 'v1', complianceType: 'inspection' });
check(fallback.ok === true && fallback.linked === true, 'the deterministic vehicle+type match links without an id');
const noRow = createMockSupabase({
  vehicle_documents: [{ id: 'd-x', vehicle_id: 'v1', document_type: 'insurance', compliance_id: null, uploaded_at: NOW }],
  vehicle_compliances: []
});
const noCompliance = await linkSavedComplianceDocument({ supabase: noRow.client, vehicleId: 'v1', complianceType: 'insurance', documentId: 'd-x' });
check(noCompliance.ok === true && noCompliance.linked === false && noCompliance.reason === 'no-compliance', 'a missing compliance row links nothing (never throws)');

console.log('--- Test 9: deterministic "documents" reply ---');
const emptyReply = formatVehicleDocumentsReply({ documents: [] });
check(emptyReply.includes('No stored documents yet'), 'the empty state is honest');
const listReply = formatVehicleDocumentsReply({
  documents: [
    { id: 'd1', vehicle_id: 'v1', document_type: 'insurance', storage_path: 'v1/a.pdf', uploaded_at: NOW },
    { id: 'd2', vehicle_id: 'v1', document_type: 'logbook', storage_path: null, uploaded_at: NOW }
  ],
  vehicles: [{ id: 'v1', plate_number: 'KDA 123A' }]
});
check(listReply.includes('Insurance certificate') && listReply.includes('KDA 123A'), 'the list names the document and the plate');
check(listReply.includes('delete document N'), 'the footer teaches the delete command');
check(listReply.includes('parsed only (Free plan)'), 'a file-less Free row is labelled honestly');

console.log('--- Test 9b: renewal SUPERSEDES the previous file (v1.86.0) ---');
check(/ADD COLUMN IF NOT EXISTS superseded_at/.test(VEHICLE_DOCUMENTS_SUPERSEDE_SQL), 'the migration adds superseded_at idempotently');
check(/ADD COLUMN IF NOT EXISTS superseded_by/.test(VEHICLE_DOCUMENTS_SUPERSEDE_SQL), 'the migration adds superseded_by idempotently');
check(/idx_vehicle_documents_current/.test(VEHICLE_DOCUMENTS_SUPERSEDE_SQL), 'a partial index keeps the current-file lookup fast');
const renewalMock = createMockSupabase({ vehicle_documents: [] });
await vaultVehicleDocument({
  supabase: renewalMock.client,
  vehicleId: 'v1',
  profileId: 'p1',
  buffer: Buffer.from('%PDF-1 old insurance'),
  mediaId: 'm-201',
  mimeType: 'application/pdf',
  documentType: 'insurance',
  entitlements: { receiptVaultStorage: true }
});
const firstInsurance = renewalMock.db.vehicle_documents[0];
const second = await vaultVehicleDocument({
  supabase: renewalMock.client,
  vehicleId: 'v1',
  profileId: 'p1',
  buffer: Buffer.from('%PDF-1 new insurance'),
  mediaId: 'm-202',
  mimeType: 'application/pdf',
  documentType: 'insurance',
  entitlements: { receiptVaultStorage: true }
});
check(second.ok === true && second.replaced === 1, 'a same-type re-upload reports ONE replaced file');
const currentInsurance = renewalMock.db.vehicle_documents.find((row) => row.id === second.document.id);
const oldInsurance = renewalMock.db.vehicle_documents.find((row) => row.id === firstInsurance.id);
check(Boolean(oldInsurance.superseded_at) && oldInsurance.superseded_by === second.document.id, 'the old row is marked superseded by the new one');
check(oldInsurance.storage_path === firstInsurance.storage_path, 'the old FILE is kept (rule 48 — evidence)');
check(currentInsurance.superseded_at === undefined || currentInsurance.superseded_at === null, 'the new row stays current');
const currentList = await listVehicleDocuments(renewalMock.client, { vehicleId: 'v1' });
check(currentList.length === 1 && currentList[0].id === second.document.id, 'the default list shows CURRENT files only');
const historyList = await listVehicleDocuments(renewalMock.client, { vehicleId: 'v1', currentOnly: false });
check(historyList.length === 2, 'currentOnly:false returns the whole history');
await vaultVehicleDocument({
  supabase: renewalMock.client,
  vehicleId: 'v1',
  profileId: 'p1',
  buffer: Buffer.from('%PDF-1 inspection'),
  mediaId: 'm-203',
  mimeType: 'application/pdf',
  documentType: 'inspection',
  entitlements: { receiptVaultStorage: true }
});
check(renewalMock.db.vehicle_documents.filter((row) => row.superseded_at).length === 1, 'a DIFFERENT document type never supersedes anything');
const counts = await countSupersededDocuments(renewalMock.client, { vehicleIds: ['v1'] });
check(counts['v1|insurance'] === 1 && !counts['v1|inspection'], 'the replaced-count map is per vehicle + type');
const noticeReply = formatVehicleDocumentsReply({
  documents: currentList,
  vehicles: [{ id: 'v1', plate_number: 'KDA 123A' }],
  replacedCounts: counts
});
check(noticeReply.includes('replaces 1 earlier file'), 'the WhatsApp list says what the renewal replaced');
const emptyMock = createMockSupabase({ vehicle_documents: [] });
const noPrevious = await supersedePreviousDocuments({ supabase: emptyMock.client, vehicleId: 'v1', documentType: 'insurance', newId: 'd2' });
check(noPrevious.ok === true && noPrevious.replaced === 0, 'a first-ever document supersedes nothing');
const legacyMock = createMockSupabase({ vehicle_documents: [{ id: 'd1', vehicle_id: 'v1', document_type: 'insurance', uploaded_at: NOW, storage_path: 'v1/x.pdf' }] });
const degradedProbe = await supersedePreviousDocuments({ supabase: legacyMock.client, vehicleId: 'v1', documentType: 'inspection', newId: 'd2' });
check(degradedProbe.ok === true && degradedProbe.replaced === 0, 'another document TYPE is never superseded');

console.log('--- Test 10: account wipe removes rows AND stored files ---');
const wipeMock = createMockSupabase({
  profiles: [{ id: 'p1', phone_number: '+254700000000' }],
  vehicles: [{ id: 'v1', owner_id: 'p1', plate_number: 'KDA 123A', vin: 'VIN1' }],
  vehicle_documents: [{ id: 'd1', vehicle_id: 'v1', uploaded_by: 'p1', storage_path: 'v1/abc.pdf', media_id: 'm1' }]
});
const wiped = await wipeProfileForSignup(wipeMock.client, '0700000000');
check(wiped.ok === true, 'the wipe completes');
check(wipeMock.state.removals.some((r) => r.bucket === DOCUMENTS_BUCKET && r.path === 'v1/abc.pdf'), 'the stored document object is removed from the bucket');
check((wipeMock.db.vehicle_documents || []).length === 0, 'the vehicle_documents row is gone');
check((wiped.counts.document_storage_objects || 0) >= 1, 'the wipe reports the removed document objects');

console.log('--- Test 11: lifecycle carriers (rule 51 sweep) ---');
const resetSource = fs.readFileSync('scripts/reset-db.js', 'utf8');
check(resetSource.includes("'vehicle_documents'"), 'RESET_TABLES carries vehicle_documents');
check(resetSource.includes('public.vehicle_documents'), 'the truncate + phone wipe SQL carry vehicle_documents');
const cleanupSource = fs.readFileSync('scripts/testCleanup.js', 'utf8');
check(cleanupSource.includes("'vehicle_documents', 'vehicle_id'") && cleanupSource.includes("'vehicle_documents', 'uploaded_by'"), 'testCleanup deletes by vehicle and uploader');
const indexSource = fs.readFileSync('index.js', 'utf8');
check(indexSource.includes('ensureVehicleDocumentsTable'), 'the boot ensure is wired in index.js');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
check(pkg.version === '1.92.1', 'package.json is 1.92.1');
check(Boolean(pkg.scripts['migrate:vehicle-documents']), 'npm run migrate:vehicle-documents exists');
const migrationSource = fs.readFileSync('scripts/run_vehicle_documents_migration.js', 'utf8');
check(migrationSource.includes('VEHICLE_DOCUMENTS_SQL'), 'the migration applies the shared DDL');

console.log('');
console.log(passed + ' vehicle-document assertions passed.');



