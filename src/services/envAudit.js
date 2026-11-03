import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Saka Fleet — Environment & secret parity audit (v1.32.4)
 * -------------------------------------------------------
 * The 2026-11-01 audit found 167 distinct `process.env.*` reads in the code but
 * only 121 documented knobs, and the live Cloud Run revision was missing keys
 * the code silently degrades on (`PUBLIC_APP_URL`, `SHORT_LINK_DOMAIN_READY`,
 * `PAYSTACK_CALLBACK_URL`, `OCR_ACK_FIRST`, `UPLOAD_HINTS_ENABLED` …). A missing
 * key never throws — it silently changes behaviour — so parity has to be
 * measurable, not remembered.
 *
 * Contract:
 *  - `ENV_SECTIONS` is the canonical, ordered registry (sections mirror .env.example).
 *  - Every environment read in the codebase must be registered here or ignored as
 *    a platform key (`ENV_IGNORE`).
 *  - Audits publish NAMES, SECTIONS and BOOLEANS only: a value is never serialised.
 *    `fingerprint` is a sha256 over `name:length` pairs, so two deployments can be
 *    compared ("same names, different values") without leaking a single secret.
 */

export const ENV_SECTIONS = Object.freeze([
  {
    section: 'SERVER',
    keys: ['PORT', 'PUBLIC_APP_URL', 'SHORT_LINK_DOMAIN_READY', 'SHORT_LINK_PROBE', 'SHORT_LINK_PROBE_CACHE_MS', 'SHORT_LINK_PROBE_TIMEOUT_MS', 'LANDING_ORIGINS']
  },
  { section: 'SUPERADMIN', keys: ['SUPERADMIN_PHONE', 'SUPERADMIN_EMAIL'] },
  { section: 'SUPABASE', keys: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ACCESS_TOKEN'] },
  {
    section: 'PAYSTACK',
    keys: [
      'PAYSTACK_SECRET_KEY',
      'PAYSTACK_PUBLIC_KEY',
      'PAYSTACK_CALLBACK_URL',
      'PUBLIC_PRICING_URL',
      'PAYSTACK_PLAN_SOLO_PRO_MONTHLY_USD',
      'PAYSTACK_PLAN_TEAM_FLEET_ANNUAL_KES',
      'PAYSTACK_PLAN_GROWTH_MONTHLY_USD',
      'PAYSTACK_PLAN_FLEET_COMMAND_ANNUAL_USD'
    ]
  },
  {
    section: 'SUBSCRIPTIONS & TRIALS',
    keys: [
      'TRIAL_DAYS',
      'TRIAL_MAX_TOTAL_DAYS',
      'TRIAL_ACTIVATION_COUPON_PCT',
      'TRIAL_ACTIVATION_COUPON_TTL_DAYS',
      'TRIAL_ACTIVATION_NUDGE_HOURS',
      'TRIAL_CONVERSION_LADDER',
      'TRIAL_MIDPOINT_COUPON_PCT',
      'SUBSCRIPTION_CACHE_MS',
      'SUBSCRIPTION_GRACE_DAYS'
    ]
  },
  { section: 'META WHATSAPP', keys: ['META_PHONE_NUMBER_ID', 'META_WHATSAPP_TOKEN', 'META_VERIFY_TOKEN', 'META_APP_SECRET', 'META_WELCOME_TEMPLATE_NAME'] },
  { section: 'EMAIL', keys: ['RESEND_API_KEY'] },
  {
    section: 'OCR & VISION',
    keys: [
      'GCP_VISION_API_KEY',
      'OCR_ENABLED',
      'OCR_ACK_FIRST',
      'OCR_MAX_MEDIA_BYTES',
      'OCR_TIMEOUT_MS',
      'OCR_VISION_TIMEOUT_MS',
      'OCR_VISION_MAX_ATTEMPTS',
      'OCR_PDF_MAX_PAGES',
      'OCR_CONFIRM_THRESHOLD',
      'OCR_DUPLICATE_WINDOW_HOURS',
      'OCR_EXPENSE_DEDUPE_HOURS',
      'RECEIPTS_BUCKET'
    ]
  },
  { section: 'KNOWLEDGEBASE', keys: ['KB_MAX_SOURCE_BYTES', 'KB_FETCH_TIMEOUT_MS', 'FEATURE_NOTICE_VERSION'] },
  {
    section: 'AI ROUTER',
    keys: [
      'PREMIUM_MODEL_ENABLED',
      'CONVERSATIONAL_PROVIDER',
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_MODEL',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'AI_MODEL_TIER_1',
      'AI_TIER1_PROVIDER',
      'AI_MODEL_TIER_1_ANTHROPIC',
      'AI_MODEL_TIER_2',
      'AI_MODEL_TIER_2_OPENAI',
      'AI_MODEL_TIER_3',
      'AI_REASONING_PROVIDER',
      'ANTHROPIC_TEMPERATURE_SUPPORTED',
      'AI_WEB_SEARCH_ENABLED',
      'AI_TIMEOUT_MS',
      'AI_TIMEOUT_MS_PREMIUM',
      'AI_TIMEOUT_MS_FALLBACK',
      'AI_TIMEOUT_MS_QUESTION',
      'AI_TIMEOUT_MS_REASONING',
      'AI_CHAIN_BUDGET_MS',
      'AI_PREMIUM_MAX_CONCURRENCY',
      'EMPTY_RETRY_MAX_FIRST_MS'
    ]
  },
  {
    section: 'AI FAILOVER',
    keys: ['AI_CB_FAILURE_THRESHOLD', 'AI_CB_WINDOW_MS', 'AI_CB_OPEN_MS', 'AI_CB_BILLING_OPEN_MS', 'AI_DAILY_BUDGET_USD', 'AI_BUDGET_ALERT_PCT']
  },
  { section: 'AI TELEMETRY', keys: ['AI_USAGE_LOGGING_ENABLED', 'AI_USAGE_LOG_MAX_ROWS', 'AI_USAGE_TRIM_EVERY', 'AI_USAGE_PAGE_SIZE'] },
  {
    section: 'AI MODEL WATCHDOG',
    keys: [
      'AI_MODEL_SCOUT_ENABLED',
      'AI_MODEL_AUTO_ADOPT',
      'AI_MODEL_SCOUT_INTERVAL_HOURS',
      'AI_MODEL_SCOUT_MAX_BENCHMARKS_PER_RUN',
      'AI_MODEL_MIN_BENCHMARK_SCORE',
      'AI_MODEL_MAX_CANARY_PCT',
      'AI_MODEL_HEALTH_WINDOW_HOURS',
      'AI_MODEL_ROLLBACK_MIN_SAMPLES',
      'AI_MODEL_ROLLBACK_ERROR_RATE',
      'AI_MODEL_ROLLBACK_ABSOLUTE_ERROR_RATE',
      'AI_MODEL_RUNTIME_CACHE_MS'
    ]
  },
  {
    section: 'SENTINEL',
    keys: ['SENTINEL_SECRET', 'SENTINEL_STALL_MINUTES', 'SENTINEL_STALL_INTERVAL_MS', 'SENTINEL_MAX_NUDGES', 'SENTINEL_LEARN_INTERVAL_MS', 'COMM_STYLE_CACHE_MS']
  },
  {
    section: 'REMEDIATION',
    keys: [
      'REMEDIATION_AUTONOMY',
      'GH_REMEDIATION_TOKEN',
      'GH_REMEDIATION_REPO',
      'REMEDIATION_SCAN_INTERVAL_MS',
      'REMEDIATION_SYNTHESIS_INTERVAL_MS',
      'REMEDIATION_AUDIT_WINDOW_HOURS',
      'REMEDIATION_PLAN_TRIGGER_COUNT',
      'REMEDIATION_PLAN_COOLDOWN_MS',
      'REMEDIATION_MAX_PLANS_PER_DAY',
      'REMEDIATION_MAX_ATTEMPTS',
      'REMEDIATION_NONCE_TTL_HOURS',
      'REMEDIATION_EXECUTION_RETRY_MS',
      'REMEDIATION_DISPATCH_TIMEOUT_MS',
      'REMEDIATION_URGENT_ERROR_THRESHOLD',
      'REMEDIATION_URGENT_COOLDOWN_MS',
      'REMEDIATION_DIGEST_HOURS_CSV',
      'REMEDIATION_DIGEST_DAILY_THRESHOLD',
      'REMEDIATION_DIGEST_WEEKLY_THRESHOLD',
      'REMEDIATION_DIGEST_SCALE_DOWN_WINDOW_DAYS',
      'REMEDIATION_WORK_ORDER_DIR'
    ]
  },
  {
    section: 'GROWTH & RE-ENGAGEMENT',
    keys: [
      'CHECKOUT_ABANDONED_AFTER_MIN',
      'CHECKOUT_REMINDER_MAX',
      'RENEWAL_NUDGE_MAX',
      'CONTACT_NUDGE_COOLDOWN_DAYS',
      'STARTUP_ANNOUNCE',
      'INCIDENT_REOPEN_THRESHOLD',
      'NATURAL_INTAKE',
      'NARRATIVE_INTAKE',
      'UPLOAD_HINTS_ENABLED',
      'INSTANT_ACK_ENABLED',
      'INSTANT_ACK_CHARS',
      'ANTHROPIC_THINKING_ENABLED',
      'ANTHROPIC_THINKING_MODE'
    ]
  },
  {
    section: 'RUNTIME & CACHES',
    keys: [
      'MESSAGE_MAX_CONCURRENCY',
      'MESSAGE_MAX_ATTEMPTS',
      'MESSAGE_RETRY_BASE_MS',
      'SUPABASE_TIMEOUT_MS',
      'SAKA_PROMPT_CACHE_MS',
      'SAKA_MAX_PROMPT_REFINEMENT_CHARS',
      'QUIZ_QUESTION_CACHE_MS',
      'QUIZ_QUESTION_CACHE_MAX',
      'ACTION_DISCOVERY_CACHE_MS',
      'ACTION_DISCOVERY_CACHE_MAX',
      'COMPLIANCE_CATALOG_CACHE_MS',
      'AUDIT_LIMIT',
      'LEGACY_VIN_TRIALS'
    ]
  },
  {
    section: 'LATENCY & CONVERSATION',
    keys: [
      'CHAT_HISTORY_MAX_AGE_MINUTES',
      'QUIZ_MAX_AGE_MINUTES',
      'SLOW_ACK_MS',
      'TURN_LATENCY_LOGGING_ENABLED',
      'TURN_LATENCY_MAX_ROWS',
      'TURN_LATENCY_TRIM_EVERY',
      'TURN_LATENCY_PAGE_SIZE'
    ]
  },
  {
    section: 'FUEL ECONOMY',
    keys: ['FUEL_ECON_MIN_SEGMENT_KM', 'FUEL_ECON_MAX_PLAUSIBLE_KML', 'FUEL_RATING_GOOD_KML', 'FUEL_RATING_EXCELLENT_KML']
  }
]);

/** Platform / CI / alias names: read from the environment but never knobs of ours. */
export const ENV_IGNORE = Object.freeze([
  'NODE_ENV', 'APP_ENV', 'PATH', 'HOME', 'TZ', 'PWD',
  'HOSTNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'USER', 'TEMP', 'TMP', 'SYSTEMROOT',
  'K_REVISION', 'K_SERVICE', 'GOOGLE_CLOUD_PROJECT',
  'GITHUB_ACTOR', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_TOKEN', 'GITHUB_ACTIONS', 'CI', 'RENDER_GIT_COMMIT', 'COMMIT_SHA',
  'DATABASE_URL', 'SUPABASE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_POOLER_REGION', 'SUPABASE_EXPECTED_PROJECT_REF',
  'WHATSAPP_VERIFY_TOKEN', 'DEEPSEEK_BASE_URL', 'GCP_VISION_ENDPOINT', 'META_GRAPH_VERSION',
  'CLOUD_RUN_REGION', 'CLOUD_RUN_SERVICE'
]);

/** Without these the app cannot serve WhatsApp or reach the database. */
export const REQUIRED_ENV = Object.freeze([
  'SUPERADMIN_PHONE',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'META_PHONE_NUMBER_ID',
  'META_WHATSAPP_TOKEN',
  'META_VERIFY_TOKEN',
  'META_APP_SECRET',
  'DEEPSEEK_API_KEY',
  'PAYSTACK_SECRET_KEY'
]);

/** Presence strongly recommended: their absence silently degrades a feature. */
export const RECOMMENDED_ENV = Object.freeze([
  'SUPERADMIN_EMAIL',
  'SUPABASE_ACCESS_TOKEN',
  'PUBLIC_APP_URL',
  'PUBLIC_PRICING_URL',
  'PAYSTACK_CALLBACK_URL',
  'RESEND_API_KEY',
  'GCP_VISION_API_KEY',
  'SENTINEL_SECRET',
  'SENTINEL_STALL_MINUTES',
  'TURN_LATENCY_LOGGING_ENABLED',
  'OCR_ACK_FIRST',
  'UPLOAD_HINTS_ENABLED'
]);

/** Values that belong in a secret manager, never in a plain env var. */
export const SECRET_ENV = Object.freeze([
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'PAYSTACK_SECRET_KEY',
  'META_WHATSAPP_TOKEN',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'RESEND_API_KEY',
  'GCP_VISION_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'SENTINEL_SECRET',
  'GH_REMEDIATION_TOKEN'
]);

/** Untouched template values, caught before they ship as "configured". */
export const PLACEHOLDER_VALUES = Object.freeze([
  'sk_test_xxxxxxxxxxxxxxxxxxxxx',
  'pk_test_xxxxxxxxxxxxxxxxxxxxx',
  'your-service-role-key',
  'your-project.supabase.co',
  'choose-a-verify-token',
  'EAAG-your-whatsapp-token',
  '123456789012345',
  'your-sentinel-secret',
  'ghp_your-github-token',
  'owner/repository',
  'admin@example.com',
  '+254700000000',
  'meta_app_secret_sakafleet_2026'
]);

/** Flat registry in canonical section order. */
/** Flat registry in canonical section order. */
export const ENV_REGISTRY = Object.freeze(ENV_SECTIONS.flatMap(({ section, keys }) => keys.map((key) => ({
  key,
  section,
  required: REQUIRED_ENV.includes(key),
  recommended: RECOMMENDED_ENV.includes(key),
  secret: SECRET_ENV.includes(key)
}))));

export const REGISTERED_ENV_KEYS = Object.freeze(ENV_REGISTRY.map((entry) => entry.key));

/** Parse a `.env` / `.env.example` body into ordered key names. */
export function parseEnvKeys(text = '') {
  const keys = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^#?\s*([A-Z][A-Z0-9_]{2,})\s*=/);
    if (match && !keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

/** Cached read of the template's key names (best effort, never throws). */
let templateKeyCache = null;
export function envTemplateKeys(filePath = '.env.example') {
  if (templateKeyCache) return templateKeyCache;
  try {
    if (fs.existsSync(filePath)) {
      templateKeyCache = parseEnvKeys(fs.readFileSync(filePath, 'utf8'));
      return templateKeyCache;
    }
  } catch { /* tolerate a missing/unreadable template */ }
  return [];
}

/** Compact, secret-free summary for `/internal/status` (operator branch). */
export function envStatusSummary(audit) {
  if (!audit) return null;
  return {
    ok: audit.ok,
    present: audit.presentCount,
    total: audit.totalKeys,
    missingRequired: audit.missingRequired,
    missingRecommended: audit.missingRecommended,
    templateDrift: audit.templateDrift,
    placeholders: audit.placeholders,
    fingerprint: audit.fingerprint,
    values: 'redacted'
  };
}

/** True when a value still looks like the untouched template placeholder. */
export function looksLikePlaceholder(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  if (PLACEHOLDER_VALUES.includes(raw)) return true;
  if (/^x{6,}$/i.test(raw)) return true;
  if (/^your[-_]/i.test(raw)) return true;
  if (/your-[a-z-]+-(key|token|secret)$/i.test(raw)) return true;
  return false;
}

/**
 * "Same names, different values" proof without leaking a value.
 * sha256 over sorted `NAME:length` pairs.
 */
export function envFingerprint(env = process.env) {
  const pairs = Object.keys(env || {})
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key))
    .sort()
    .map((key) => `${key}:${String(env[key] ?? '').length}`);
  return `sha256:${crypto.createHash('sha256').update(pairs.join('|')).digest('hex').slice(0, 16)}`;
}

function isSet(env, key) {
  return Boolean(String(env?.[key] ?? '').trim());
}

/**
 * Audit an environment against the registry.
 * @returns {{ok:boolean, missingRequired:string[], missingRecommended:string[],
 *   undocumented:string[], placeholders:string[], templateDrift:string[],
 *   codeDrift:string[], sections:Array, presentCount:number, totalKeys:number,
 *   fingerprint:string, warnings:string[]}}
 */
export function auditEnv(env = process.env, { templateKeys = [], codeKeys = [] } = {}) {
  const missingRequired = REQUIRED_ENV.filter((key) => !isSet(env, key));
  const missingRecommended = RECOMMENDED_ENV.filter((key) => !isSet(env, key));
  const registered = new Set(REGISTERED_ENV_KEYS);
  const ignored = new Set(ENV_IGNORE);

  // Keys the runtime carries that nobody documented (and that are not platform).
  // When the caller supplies the code scan, drift means "our code reads a knob
  // nobody registered"; otherwise it means "this runtime has an unknown key".
  const scope = (codeKeys || []).length ? codeKeys : Object.keys(env || {});
  const undocumented = [...new Set(scope)]
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key))
    .filter((key) => !registered.has(key) && !ignored.has(key))
    .sort();
  const codeDrift = (codeKeys || []).filter((key) => !registered.has(key) && !ignored.has(key)).sort();
  // Registry knobs missing from the template (documentation debt, both ways).
  const templateDrift = (templateKeys || []).length
    ? REGISTERED_ENV_KEYS.filter((key) => !templateKeys.includes(key))
    : [];
  const undocumentedTemplate = (templateKeys || []).filter((key) => !registered.has(key) && !ignored.has(key)).sort();
  const placeholders = REGISTERED_ENV_KEYS
    .filter((key) => isSet(env, key) && looksLikePlaceholder(env[key]))
    .sort();

  const sections = ENV_SECTIONS.map(({ section, keys }) => ({
    section,
    total: keys.length,
    present: keys.filter((key) => isSet(env, key)).length,
    missingRequired: keys.filter((key) => REQUIRED_ENV.includes(key) && !isSet(env, key))
  }));
  const presentCount = REGISTERED_ENV_KEYS.filter((key) => isSet(env, key)).length;
  const warnings = [];
  if (missingRequired.length) warnings.push(`Missing required: ${missingRequired.join(', ')}`);
  if (missingRecommended.length) warnings.push(`Missing recommended: ${missingRecommended.join(', ')}`);
  if (templateDrift.length) warnings.push(`Registered but undocumented in .env.example: ${templateDrift.join(', ')}`);
  if (undocumentedTemplate.length) warnings.push(`Documented but unregistered: ${undocumentedTemplate.join(', ')}`);
  if (codeDrift.length) warnings.push(`Code reads unregistered keys: ${codeDrift.join(', ')}`);
  if (placeholders.length) warnings.push(`Template placeholders still in use: ${placeholders.join(', ')}`);

  return {
    ok: missingRequired.length === 0 && templateDrift.length === 0 && undocumentedTemplate.length === 0 && codeDrift.length === 0,
    missingRequired,
    missingRecommended,
    undocumented,
    undocumentedTemplate,
    templateDrift,
    codeDrift,
    placeholders,
    sections,
    presentCount,
    totalKeys: REGISTERED_ENV_KEYS.length,
    fingerprint: envFingerprint(env),
    warnings
  };
}

/** WhatsApp/console digest — names and counts only, zero tokens, never values. */
export function formatEnvDigest(audit, { label = 'Environment', base = null } = {}) {
  const lines = [`*${label} parity*`];
  const missing = audit?.missingRequired || [];
  const recommended = audit?.missingRecommended || [];
  lines.push(missing.length ? `🔴 Missing required (${missing.length}): ${missing.join(', ')}` : '🟢 Required keys: all present');
  if (recommended.length) lines.push(`🟡 Missing recommended (${recommended.length}): ${recommended.join(', ')}`);
  if (audit?.templateDrift?.length) lines.push(`📝 Undocumented knobs (${audit.templateDrift.length}): ${audit.templateDrift.slice(0, 8).join(', ')}${audit.templateDrift.length > 8 ? '…' : ''}`);
  if (audit?.placeholders?.length) lines.push(`⚠️ Template values still set: ${audit.placeholders.join(', ')}`);
  lines.push(`📊 ${audit?.presentCount ?? 0}/${audit?.totalKeys ?? 0} registered keys set · ${audit?.fingerprint || 'n/a'}`);
  if (base) lines.push(`Base: ${base}`);
  return lines.join('\n');
}

/** Secret names a deployment should mount via --set-secrets, not --set-env-vars. */
export function plaintextSecretWarnings(env = process.env, { plaintextKeys = null } = {}) {
  const mounted = Array.isArray(plaintextKeys) ? new Set(plaintextKeys) : null;
  return SECRET_ENV.filter((key) => isSet(env, key) && (!mounted || mounted.has(key)));
}

export default {
  ENV_SECTIONS,
  ENV_REGISTRY,
  ENV_IGNORE,
  REQUIRED_ENV,
  RECOMMENDED_ENV,
  SECRET_ENV,
  PLACEHOLDER_VALUES,
  REGISTERED_ENV_KEYS,
  parseEnvKeys,
  envTemplateKeys,
  envStatusSummary,
  looksLikePlaceholder,
  envFingerprint,
  auditEnv,
  formatEnvDigest,
  plaintextSecretWarnings
};
