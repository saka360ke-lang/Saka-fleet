import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet - support_tickets widening migration (v1.58.16).
 * The live table predates the staging DDL (which already uses `text`) and
 * declares whatsapp_number as varchar(20). Inbound support emails store the
 * FULL sender email address in that column, so any sender longer than 20
 * characters failed silently. Widen the column to text (idempotent).
 * Run: npm run migrate:support-tickets
 */

export const SUPPORT_TICKETS_WIDEN_SQL = `
  ALTER TABLE public.support_tickets
    ALTER COLUMN whatsapp_number TYPE text;
`;

export async function applySupportTicketsMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing support_tickets widening on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(SUPPORT_TICKETS_WIDEN_SQL, { label: 'supportTicketsMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK support_tickets.whatsapp_number widened to text.');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applySupportTicketsMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
