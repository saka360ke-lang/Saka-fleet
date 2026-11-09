/**
 * Saka Fleet — Resend quota alert suite (v1.87.2, Phase 26C).
 * ----------------------------------------------------------
 * Stateless: an in-memory config client + fake Resend clients. Zero network,
 * zero database rows (rule 10).
 *
 * Run: node test_resend_quota.js
 */

import assert from 'assert';
import {
  isResendQuotaError,
  isResendQuotaWarnedAt,
  recordResendQuotaWarning,
  sendResendEmail,
  RESEND_QUOTA_WARNING_TEXT
} from './src/services/mailer.js';
import { CONFIG_KEY_RESEND_QUOTA_WARNED } from './src/services/systemConfigKeys.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`ok ${message}`);
}

/** Minimal system_config + admin_audit_logs client (readConfig/writeConfig shape). */
function makeConfigClient() {
  const state = { config: {}, audits: [], upserts: 0 };
  const client = {
    from(table) {
      if (table === 'system_config') {
        const query = {
          _keys: [],
          select() { return query; },
          in(_col, keys) { query._keys = keys || []; return query; },
          limit() {
            const rows = Object.entries(state.config)
              .filter(([key]) => query._keys.includes(key))
              .map(([key, value]) => ({ key, value }));
            return Promise.resolve({ data: rows, error: null });
          },
          upsert(rows) {
            state.upserts += 1;
            for (const row of rows || []) state.config[row.key] = row.value;
            return Promise.resolve({ error: null });
          }
        };
        return query;
      }
      if (table === 'admin_audit_logs') {
        return {
          insert(rows) {
            state.audits.push(...(rows || []));
            return Promise.resolve({ error: null });
          }
        };
      }
      return {};
    }
  };
  return { client, state };
}

const NOW = new Date('2026-11-09T10:00:00Z');
const TODAY_KEY = '2026-11-09';

console.log('=== v1.87.2: Resend quota detection + alert ===');

// 1. Detection.
check(isResendQuotaError({ statusCode: 429, message: 'Too many requests' }) === true, 'a 429 statusCode is a quota error');
check(isResendQuotaError({ name: 'rate_limit_exceeded', message: 'slow down' }) === true, 'a rate_limit_exceeded name is a quota error');
check(isResendQuotaError({ message: 'daily quota exceeded' }) === true, 'a quota message is a quota error');
check(isResendQuotaError({ statusCode: 500, message: 'internal error' }) === false, 'a 500 is not a quota error');
check(isResendQuotaError(null) === false && isResendQuotaError('') === false, 'empty errors are never quota errors');

// 2. Marker day maths (UTC).
check(isResendQuotaWarnedAt(TODAY_KEY, NOW) === true, 'today (UTC) is an active warning');
check(isResendQuotaWarnedAt('2026-11-08', NOW) === false, 'yesterday is NOT active (the quota resets at midnight UTC)');
check(isResendQuotaWarnedAt(null, NOW) === false && isResendQuotaWarnedAt('nonsense', NOW) === false, 'a missing/garbled marker is inactive');
check(/midnight UTC/.test(RESEND_QUOTA_WARNING_TEXT) && /Resend daily quota exhausted/.test(RESEND_QUOTA_WARNING_TEXT), 'the ping copy names the cause and the reset');

// 3. One write + one audit per UTC day.
const first = makeConfigClient();
const firstResult = await recordResendQuotaWarning({ supabase: first.client, now: NOW, notify: false });
check(firstResult.warned === true && firstResult.alreadyWarned === false && firstResult.persisted === true, 'the first hit records the warning');
check(first.state.config[CONFIG_KEY_RESEND_QUOTA_WARNED] === TODAY_KEY, 'the namespaced marker holds the UTC day');
// v1.88.2 (the flip) — `new` is the default mode, so the marker is namespaced
// ONLY; the legacy row is written only in an explicit `dual` rolling window.
check(first.state.config.resend_quota_warned_at === undefined, 'the legacy marker is NOT written in the default new mode (v1.88.2)');
{
  const previousMode = process.env.SYSTEM_CONFIG_KEY_MODE;
  process.env.SYSTEM_CONFIG_KEY_MODE = 'dual';
  try {
    const dualClient = makeConfigClient();
    await recordResendQuotaWarning({ supabase: dualClient.client, now: NOW, notify: false });
    check(dualClient.state.config.resend_quota_warned_at === TODAY_KEY, 'an explicit dual window still dual-writes the documented legacy name');
  } finally {
    if (previousMode === undefined) delete process.env.SYSTEM_CONFIG_KEY_MODE;
    else process.env.SYSTEM_CONFIG_KEY_MODE = previousMode;
  }
}
check(first.state.audits.length === 1 && first.state.audits[0].action === 'RESEND_QUOTA_ALERT' && first.state.audits[0].details?.date === TODAY_KEY, 'the hit is audited once (RESEND_QUOTA_ALERT)');

const secondResult = await recordResendQuotaWarning({ supabase: first.client, now: new Date('2026-11-09T23:59:00Z'), notify: false });
check(secondResult.alreadyWarned === true, 'a second hit on the same UTC day is deduped');
check(first.state.upserts === 1 && first.state.audits.length === 1, 'the dedupe writes nothing (one upsert, one audit)');

const nextDay = await recordResendQuotaWarning({ supabase: first.client, now: new Date('2026-11-10T00:05:00Z'), notify: false });
check(nextDay.alreadyWarned === false && first.state.config[CONFIG_KEY_RESEND_QUOTA_WARNED] === '2026-11-10', 'the next UTC day warns again');

// 4. sendResendEmail detects a quota failure on the returned error.
const quotaClient = { emails: { send: async () => ({ data: null, error: { statusCode: 429, message: 'daily quota exceeded' } }) } };
const wrapped = makeConfigClient();
const quotaResult = await sendResendEmail({ to: ['owner@example.com'], subject: 'x' }, { client: quotaClient, supabase: wrapped.client, notify: false, now: NOW });
check(quotaResult.error?.statusCode === 429, 'the wrapper returns the original result');
check(wrapped.state.config[CONFIG_KEY_RESEND_QUOTA_WARNED] === TODAY_KEY && wrapped.state.audits.length === 1, 'a returned 429 records the warning');

// 5. A thrown 429 is recorded AND rethrown (callers keep their catch).
const throwingClient = { emails: { send: async () => { const err = new Error('quota exceeded'); err.statusCode = 429; throw err; } } };
const thrownState = makeConfigClient();
let thrown = null;
try {
  await sendResendEmail({ to: ['owner@example.com'] }, { client: throwingClient, supabase: thrownState.client, notify: false, now: NOW });
} catch (err) { thrown = err; }
check(Boolean(thrown) && /quota exceeded/.test(thrown.message), 'a thrown 429 is rethrown to the caller');
check(thrownState.state.config[CONFIG_KEY_RESEND_QUOTA_WARNED] === TODAY_KEY, 'a thrown 429 also records the warning');

// 6. Non-quota failures change nothing.
const errorClient = { emails: { send: async () => ({ data: null, error: { statusCode: 500, message: 'internal' } }) } };
const plainState = makeConfigClient();
await sendResendEmail({ to: ['owner@example.com'] }, { client: errorClient, supabase: plainState.client, notify: false, now: NOW });
check(plainState.state.upserts === 0 && plainState.state.audits.length === 0, 'a non-quota error never marks the quota');

const okClient = { emails: { send: async () => ({ data: { id: 'email-1' }, error: null }) } };
const okState = makeConfigClient();
const okResult = await sendResendEmail({ to: ['owner@example.com'] }, { client: okClient, supabase: okState.client, notify: false, now: NOW });
check(okResult.data?.id === 'email-1' && okState.state.upserts === 0, 'a successful send returns data and writes nothing');

console.log(`\nALL RESEND QUOTA TESTS PASSED (${passed} assertions).`);
