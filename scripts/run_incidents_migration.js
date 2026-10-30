import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/** Saka Fleet - Incident registry migration (v1.23.3). */
export const INCIDENTS_SQL = `
  CREATE TABLE IF NOT EXISTS public.backend_incidents (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    signature text UNIQUE NOT NULL,
    category text NOT NULL DEFAULT 'other',
    severity text NOT NULL DEFAULT 'medium',
    status text NOT NULL DEFAULT 'open',
    message text,
    source text,
    occurrence_count integer DEFAULT 1,
    recurrences_since_resolution integer DEFAULT 0,
    first_seen_at timestamp with time zone DEFAULT now(),
    last_seen_at timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone,
    reopened_at timestamp with time zone,
    resolved_by text,
    resolution_note text,
    fixed_in_version text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_backend_incidents_status ON public.backend_incidents (status, last_seen_at DESC);
`;

export async function applyIncidentsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Applying incident-registry migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(INCIDENTS_SQL, { label: 'incidentsMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body || result.status);
    return { success: false, ...result };
  }
  console.log('✅ backend_incidents is ready.');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyIncidentsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => { console.error('Migration error:', err); process.exit(1); });
}