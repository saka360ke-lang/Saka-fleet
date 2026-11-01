/**
 * Saka Fleet — Landing site static test suite (v1.39.0, stateless)
 * ----------------------------------------------------------------
 * Guards the marketing site's delivery contract: every required file exists,
 * structured data (JSON-LD) parses, the AI-legibility files (llms.txt,
 * sitemap.xml, robots.txt) stay complete, internal references resolve, no
 * secret ever leaks into static files, and the changelog feed is valid.
 *
 * Run: node test_landing_static.js
 * Stateless: reads files only — no database, no cleanup needed.
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LANDING = path.join(path.dirname(fileURLToPath(import.meta.url)), 'landing');

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const REQUIRED_FILES = [
  'index.html', 'privacy.html', 'terms.html', '404.html',
  'assets/css/styles.css', 'assets/js/main.js',
  'assets/img/logo.svg', 'assets/img/favicon.svg', 'assets/img/og-cover.svg',
  'data/changelog.json', 'robots.txt', 'sitemap.xml', 'llms.txt', 'manifest.webmanifest', '.htaccess'
];

console.log('--- Test 1: required files ---');
for (const rel of REQUIRED_FILES) {
  check(fs.existsSync(path.join(LANDING, rel)), `landing/${rel} exists`);
}

console.log('\n--- Test 2: structured data parses (AI + answer-engine legible) ---');
const indexHtml = fs.readFileSync(path.join(LANDING, 'index.html'), 'utf8');
const jsonLdBlocks = [...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].trim()));
const jsonLdTypes = jsonLdBlocks.map((block) => block['@type']);
for (const type of ['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']) {
  check(jsonLdTypes.includes(type), `JSON-LD includes ${type}`);
}
const faqBlock = jsonLdBlocks.find((block) => block['@type'] === 'FAQPage');
check(Array.isArray(faqBlock.mainEntity) && faqBlock.mainEntity.length >= 6, 'FAQPage carries the visible questions');
const org = jsonLdBlocks.find((block) => block['@type'] === 'Organization');
check(/Saka 360/i.test(org.parentOrganization?.name || '') && org.email === 'support@sakafleet.com', 'Organization names Saka 360 (Kenya) and the support email');

console.log('\n--- Test 3: AI-legibility files ---');
const llms = fs.readFileSync(path.join(LANDING, 'llms.txt'), 'utf8');
for (const needle of ['https://sakafleet.com/', '/privacy.html', '/terms.html', '/api/onboard', '/healthz', 'support@sakafleet.com']) {
  check(llms.includes(needle), `llms.txt references ${needle}`);
}
const sitemap = fs.readFileSync(path.join(LANDING, 'sitemap.xml'), 'utf8');
for (const page of ['https://sakafleet.com/', 'https://sakafleet.com/privacy.html', 'https://sakafleet.com/terms.html']) {
  check(sitemap.includes(`<loc>${page}</loc>`), `sitemap lists ${page}`);
}
const robots = fs.readFileSync(path.join(LANDING, 'robots.txt'), 'utf8');
for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
  check(robots.includes(`User-agent: ${bot}`), `robots.txt welcomes ${bot}`);
}

console.log('\n--- Test 4: changelog feed ---');
const changelog = JSON.parse(fs.readFileSync(path.join(LANDING, 'data/changelog.json'), 'utf8'));
check(changelog.entries.length >= 5, 'The changelog feed has recent releases');
check(changelog.entries.every((e) => e.version && e.date && e.title && e.summary), 'Every changelog entry is complete');
check(changelog.entries[0].version === changelog.latest, 'The newest entry matches the latest version');
console.log('\n--- Test 5: no secrets in static files (rule 6 isolation) ---');
const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/, /sk_test_[A-Za-z0-9]+/,
  /SUPABASE_SERVICE(_ROLE)?_KEY\s*=\s*[^#\s]+/, /RESEND_API_KEY\s*=\s*re_[A-Za-z0-9]+/,
  /META_WHATSAPP_TOKEN\s*=\s*EAAG/, /EAAG[A-Za-z0-9]{10,}/,
  /DEEPSEEK_API_KEY\s*=\s*sk-/, /PAYSTACK_SECRET_KEY\s*=\s*sk_/,
  /service_role/i
];
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
let leaked = [];
for (const file of walk(LANDING)) {
  if (!/\.(html|js|css|json|txt|xml|webmanifest|htaccess)$/.test(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) leaked.push(`${path.relative(LANDING, file)}: ${pattern}`);
  }
}
check(leaked.length === 0, `No secrets leak in static files${leaked.length ? ` (found: ${leaked.join(', ')})` : ''}`);
const mainJs = fs.readFileSync(path.join(LANDING, 'assets/js/main.js'), 'utf8');
check(mainJs.includes("API_BASE = 'https://app.sakafleet.com'") && mainJs.includes('/api/onboard'), 'main.js points only at the public API surface');

console.log('\n--- Test 6: internal references resolve ---');
const localRefs = [...indexHtml.matchAll(/(?:src|href)="(\/[^"#][^"]*)"/g)].map((m) => m[1]);
const missing = localRefs.filter((ref) => {
  if (ref.startsWith('/assets/img/og-cover')) return false; // OG image is checked in Test 1
  return !fs.existsSync(path.join(LANDING, ref.replace(/^\//, '').split('?')[0]));
});
check(missing.length === 0, `Every local reference resolves${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

console.log('\n--- Test 7: conversion architecture ---');
for (const needle of ['data-open-onboard', 'stepLegal', 'stepOtp', 'id="consent"', 'otpVerify', 'legalSubmit']) {
  check(indexHtml.includes(needle), `The onboarding modal carries ${needle}`);
}
check(/I have read, understood, and agree to the exhaustive Saka Fleet/.test(indexHtml), 'The mandatory legal checkbox copy is present');
check(indexHtml.includes('id="statusCard"') && indexHtml.includes('/healthz'), 'The live uptime widget probes /healthz');
check(/Get Started Free/.test(indexHtml) && /Deploy Your Fleet/.test(indexHtml), 'Primary CTAs are present');

console.log(`\n🎉 ${passed} landing-site assertions passed.`);
console.log('Stateless suite: file reads only — no database, no cleanup needed.');

