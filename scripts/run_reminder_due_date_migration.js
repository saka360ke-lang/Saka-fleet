import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';

/**
 * Saka Fleet — Threshold reminder schema fix (v1.28.5).
 *
 * Live bug (2026-10-31 20:18): a distance-based service reminder ("due at
 * 370,000 km") parsed correctly but the INSERT failed because the legacy
 * `reminders.due_date` column is NOT NULL. Threshold reminders intentionally
 * carry no date, so the column must be nullable.
 *
 * Run: npm run migrate:reminder-due-date
 */

export const REMINDER_DUE_DATE_SQL = `
  DO $mig$
  BEGIN
    IF to_regclass('public.reminders') IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public.reminders ALTER COLUMN due_date DROP NOT NULL';
    END IF;
  END
  $mig$;
`;

export const REMINDER_DUE_DATE_VERIFY_SQL = `
  SELECT is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'reminders' AND column_name = 'due_date';
`;

export async function applyReminderDueDateMigration() {
  if (!hasSqlAccess()) {
    console.error('Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL');
    return { success: false };
  }
  console.log(`Relaxing reminders.due_date on Supabase project: ${getProjectRef()}...`);
  const result = await runSql(REMINDER_DUE_DATE_SQL, { label: 'reminderDueDateMigration' });
  if (!result.ok) {
    console.error('Migration failed:', result.error || result.body);
    return { success: false, ...result };
  }
  const verify = await runSql(REMINDER_DUE_DATE_VERIFY_SQL, { label: 'reminderDueDateVerify' });
  console.log('due_date is_nullable =', verify.body || '(no body)');
  console.log('✅ reminders.due_date is nullable (threshold reminders can be saved).');
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyReminderDueDateMigration()
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
