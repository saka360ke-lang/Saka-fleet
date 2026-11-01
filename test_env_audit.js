/**
 * Saka Fleet — env & secret parity audit tests (v1.32.4, stateless)
 * ---------------------------------------------------------------
 * Proves the registry is the single source of truth: every environment read in
 * the code is registered or deliberately ignored, the registry and `.env.example`
 * cannot drift apart, template placeholders are caught, required keys are
 * enforced — and NO audit output ever contains a secret value.
 *
 * Run: node test_env_audit.js
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  ENV_SECTIONS,
  ENV_REGISTRY,
  ENV_IGNORE,
  REQUIRED_ENV,
  RECOMMENDED_ENV,
  SECRET_ENV,
  REGISTERED_ENV_KEYS,
  parseEnvKeys,
  envTemplateKeys,
  looksLikePlaceholder,
  envFingerprint,
  auditEnv,
  formatEnvDigest,
  envStatusSummary,
  plaintextSecretWarnings
} from './src/services/envAudit.js';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

function scanCodeKeys(root = process.cwd()) {
  const keys = new Set();
  const skip = new Set(['node_modules', '.git', 'tmp', '.github', 'docs']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
        continue;
      }
      if (!/\.(js|mjs)$/.test(entry.name) || /^test_/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) {
        keys.add(match[1] || match[2]);
      }
    }
  };
  walk(root);
  return [...keys].sort();
}

function run() {
  console.log('=== SAKA FLEET — ENV & SECRET PARITY TESTS (v1.32.4) ===\n');

  console.log('--- Test 1: registry integrity ---');
  const codeKeys = scanCodeKeys();
  check(codeKeys.length > 140, `The code really reads a lot of knobs (${codeKeys.length})`);
  const unregistered = codeKeys.filter((key) => !REGISTERED_ENV_KEYS.includes(key) && !ENV_IGNORE.includes(key));
  check(unregistered.length === 0, `Every code-read key is registered or ignored${unregistered.length ? ` — unregistered: ${unregistered.join(', ')}` : ''}`);
  const duplicates = REGISTERED_ENV_KEYS.filter((key, index) => REGISTERED_ENV_KEYS.indexOf(key) !== index);
  check(duplicates.length === 0, 'No knob is registered twice');
  check(ENV_REGISTRY.every((entry) => typeof entry.section === 'string' && entry.section.length > 0), 'Every registered knob carries a section');
  check(REQUIRED_ENV.every((key) => REGISTERED_ENV_KEYS.includes(key)), 'Every required key is registered');
  check(RECOMMENDED_ENV.every((key) => REGISTERED_ENV_KEYS.includes(key)), 'Every recommended key is registered');
  check(SECRET_ENV.every((key) => REGISTERED_ENV_KEYS.includes(key)), 'Every secret key is registered');
  check(!ENV_IGNORE.some((key) => REGISTERED_ENV_KEYS.includes(key)), 'Ignored platform keys are never also registered');

  console.log('\n--- Test 2: registry ≡ .env.example ---');
  const templateKeys = envTemplateKeys();
  check(templateKeys.length > 140, `The template documents ${templateKeys.length} knobs`);
  const templateDrift = REGISTERED_ENV_KEYS.filter((key) => !templateKeys.includes(key));
  check(templateDrift.length === 0, `No registered knob is missing from .env.example${templateDrift.length ? ` — missing: ${templateDrift.join(', ')}` : ''}`);
  const registryDrift = templateKeys.filter((key) => !REGISTERED_ENV_KEYS.includes(key) && !ENV_IGNORE.includes(key));
  check(registryDrift.length === 0, `No template knob is unregistered${registryDrift.length ? ` — extra: ${registryDrift.join(', ')}` : ''}`);
  check(parseEnvKeys(fs.readFileSync('.env.example', 'utf8')).length === templateKeys.length, 'Template parsing is deterministic');

  console.log('\n--- Test 3: canonical section order ---');
  const sections = ENV_SECTIONS.map((entry) => entry.section);
  check(new Set(sections).size === sections.length, 'Section names are unique');
  check(sections[0] === 'SERVER' && sections[sections.length - 1] === 'FUEL ECONOMY', 'Sections start at SERVER and end at FUEL ECONOMY');
  check(sections.indexOf('SUPABASE') < sections.indexOf('PAYSTACK'), 'Supabase precedes Paystack');
  check(sections.indexOf('AI ROUTER') < sections.indexOf('SENTINEL') && sections.indexOf('SENTINEL') < sections.indexOf('REMEDIATION'), 'AI router → Sentinel → Remediation order holds');

  console.log('\n--- Test 4: placeholder detection ---');
  check(looksLikePlaceholder('sk_test_xxxxxxxxxxxxxxxxxxxxx'), 'An untouched Paystack test key is a placeholder');
  check(looksLikePlaceholder('your-service-role-key'), 'A "your-" template value is a placeholder');
  check(looksLikePlaceholder('choose-a-verify-token'), 'The verify-token sample is a placeholder');
  check(!looksLikePlaceholder('sk_live_9d8f7a6b5c4d3e2f1a0b'), 'A real key is never flagged');
  check(!looksLikePlaceholder(''), 'An empty value is not a placeholder (it is simply unset)');
  check(!looksLikePlaceholder('https://app.sakafleet.com'), 'A real URL is never flagged');

  console.log('\n--- Test 5: audit verdicts + secret hygiene ---');
  const fakeSecret = 'SUPER-SECRET-VALUE-9f8e7d6c5b4a';
  const healthyEnv = {
    SUPERADMIN_PHONE: '+254700111222',
    SUPABASE_URL: 'https://real-project.supabase.co',
    SUPABASE_SERVICE_KEY: fakeSecret,
    META_PHONE_NUMBER_ID: '987654321098765',
    META_WHATSAPP_TOKEN: fakeSecret,
    META_VERIFY_TOKEN: 'verify-token-abc',
    META_APP_SECRET: fakeSecret,
    DEEPSEEK_API_KEY: fakeSecret,
    PAYSTACK_SECRET_KEY: fakeSecret,
    PUBLIC_APP_URL: 'https://app.sakafleet.com'
  };
  const healthy = auditEnv(healthyEnv, { templateKeys, codeKeys });
  check(healthy.ok === true, 'A fully configured environment passes');
  check(healthy.missingRequired.length === 0, 'No required key is reported missing');
  check(healthy.placeholders.length === 0, 'Real values are never treated as placeholders');
  check(healthy.missingRecommended.includes('RESEND_API_KEY'), 'A missing recommended key is amber, not red');

  const broken = auditEnv({ ...healthyEnv, META_WHATSAPP_TOKEN: '', PAYSTACK_SECRET_KEY: 'sk_test_xxxxxxxxxxxxxxxxxxxxx' }, { templateKeys });
  check(broken.ok === false, 'An empty required key fails the audit');
  check(broken.missingRequired.includes('META_WHATSAPP_TOKEN'), 'The empty required key is named');
  check(broken.placeholders.includes('PAYSTACK_SECRET_KEY'), 'A leftover template value is caught');

  const serialized = JSON.stringify({ healthy, broken, digest: formatEnvDigest(broken, { label: 'TEST' }) });
  check(!serialized.includes(fakeSecret), 'NO audit output ever contains a secret value');
  check(!serialized.includes('verify-token-abc'), 'No non-secret value leaks into the audit either');
  check(broken.fingerprint.startsWith('sha256:') && broken.fingerprint.length === 23, 'Fingerprints are short sha256 digests');

  console.log('\n--- Test 6: fingerprint + digest shape ---');
  const fingerprintA = envFingerprint({ A_KEY: 'one', B_KEY: 'two' });
  const fingerprintB = envFingerprint({ B_KEY: 'two', A_KEY: 'one' });
  check(fingerprintA === fingerprintB, 'Fingerprints ignore key order');
  check(envFingerprint({ A_KEY: 'one-longer', B_KEY: 'two' }) !== fingerprintA, 'A changed value length changes the fingerprint');
  const digest = formatEnvDigest(healthy, { label: 'LOCAL' });
  check(digest.startsWith('*LOCAL parity*'), 'The digest leads with its label');
  check(/🟢 Required keys: all present/.test(digest), 'A healthy digest is green');
  check(digest.includes('sha256:'), 'The digest carries the fingerprint');
  check(/🔴 Missing required \(\d+\)/.test(formatEnvDigest(broken, { label: 'REMOTE' })), 'A broken digest leads with the red line');

  console.log('\n--- Test 7: status payload + plaintext secrets ---');
  const summary = envStatusSummary(healthy);
  check(summary.values === 'redacted', 'The status summary is explicitly redacted');
  check(!JSON.stringify(summary).includes(fakeSecret), 'The status summary never carries a value');
  check(summary.present > 0 && summary.total === REGISTERED_ENV_KEYS.length, 'The summary counts registered keys');
  const plaintext = plaintextSecretWarnings(healthyEnv);
  check(plaintext.includes('SUPABASE_SERVICE_KEY'), 'A secret present in plain env is flagged for --set-secrets');
  check(!plaintext.includes('PUBLIC_APP_URL'), 'Non-secret keys are never flagged');
  check(plaintextSecretWarnings(healthyEnv, { plaintextKeys: [] }).length === 0, 'When every secret is mounted, nothing is flagged');

  console.log(`\n🎉 ${passed} env parity assertions passed.`);
  console.log('Stateless suite: process.env was read only; nothing was written.');
}

try {
  run();
} catch (err) {
  console.error('\n❌ Env parity suite failed:', err.message);
  process.exit(1);
}
