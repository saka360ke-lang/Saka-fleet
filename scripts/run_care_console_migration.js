import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { CARE_SQL } from '../src/services/careConsole.js';

/**
 * Saka Fleet - Care Console migration (v1.58.18).
 * Adds the support_tickets lifecycle columns (status, priority, source,
 * sender_email, subject, assigned_to, internal_note, thread_key, updated_at)
 * and the support_ticket_messages thread table. Idempotent.
 * Run: npm run migrate:care-console
 */

export async function applyCareConsoleMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Executing care-console migration on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(CARE_SQL, { label: 'careConsoleMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  console.log('OK care-console migration applied (support_tickets lifecycle + support_ticket_messages).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyCareConsoleMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
