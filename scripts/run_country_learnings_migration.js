import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runSql, hasSqlAccess, getProjectRef } from '../src/db/sqlRunner.js';
import { COUNTRY_LEARNINGS_SQL } from '../src/services/countryLearnings.js';

export async function applyCountryLearningsMigration() {
  if (!hasSqlAccess()) { console.error("Missing SQL transport: set SUPABASE_ACCESS_TOKEN or DATABASE_URL"); return { success: false }; }
  console.log("Executing country-learnings migration on Supabase project: " + getProjectRef() + "...");
  const result = await runSql(COUNTRY_LEARNINGS_SQL, { label: "countryLearningsMigration" });
  if (!result.ok) { console.error("Migration failed:", result.error || result.body); return { success: false, ...result }; }
  console.log("OK country_learnings table applied.");
  return { success: true, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyCountryLearningsMigration().then((r) => process.exit(r.success ? 0 : 1)).catch((err) => { console.error("Migration error:", err); process.exit(1); });
}