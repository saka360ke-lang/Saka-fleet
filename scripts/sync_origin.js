#!/usr/bin/env node
/**
 * Saka Fleet — pre-flight origin sync (v1.51.11, rule 32).
 *
 * Keeps a local session in fast-forward lockstep with origin/main before
 * `npm run health` / `npm test` run (wired via the prehealth/pretest hooks),
 * so work can never start on a stale tree after an autonomous push (the
 * remediation CI commits directly to main).
 *
 * Skips itself inside CI (the executor checks out the exact approved SHA and
 * must never pull another branch over it). Exits non-zero on any real sync
 * failure so the gates fail fast instead of running on a diverged tree.
 */
import { execSync } from 'node:child_process';

if (process.env.CI || process.env.GITHUB_ACTIONS) {
  console.log('[sync_origin] CI environment — skipping local origin sync.');
  process.exit(0);
}

try {
  execSync('git fetch origin', { stdio: 'inherit' });
  execSync('git pull --ff-only origin main', { stdio: 'inherit' });
  console.log('[sync_origin] local main is in fast-forward lockstep with origin/main.');
} catch (err) {
  console.error(`[sync_origin] origin sync failed: ${err?.message || err}`);
  process.exit(1);
}
