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
import { COUNTRY_COMPLIANCE_CATALOG } from './src/services/complianceCatalog.js';
import { REGIONS } from './src/services/globalization.js';
import { getTierPriceUSD, getAddonPriceUSD } from './src/services/subscriptionTiers.js';

const LANDING = path.join(path.dirname(fileURLToPath(import.meta.url)), 'landing');

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const REQUIRED_FILES = [
  'index.html', 'privacy.html', 'terms.html', 'data-deletion.html', 'status.html', '404.html',
  'assets/css/styles.css', 'assets/js/main.js', 'assets/js/cookieConsent.js', 'assets/js/status.js', 'assets/js/locale.js',
  'assets/img/logo.svg', 'assets/img/favicon.svg', 'assets/img/og-cover.svg',
  'assets/img/og-cover.png', 'assets/img/favicon-32.png', 'assets/img/apple-touch-icon.png', 'assets/img/icon-192.png',
  'assets/fonts/Outfit-600.woff2', 'assets/fonts/Outfit-800.woff2',
  'assets/fonts/Inter-400.woff2', 'assets/fonts/Inter-600.woff2', 'assets/fonts/Inter-700.woff2',
  'data/changelog.json', 'data/countries.json', 'robots.txt', 'sitemap.xml', 'llms.txt', 'manifest.webmanifest', '.htaccess'
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
for (const needle of ['https://sakafleet.com/', '/privacy', '/terms', '/data-deletion', '/status', '/api/onboard', 'support@sakafleet.com']) {
  check(llms.includes(needle), `llms.txt references ${needle}`);
}
const sitemap = fs.readFileSync(path.join(LANDING, 'sitemap.xml'), 'utf8');
for (const page of ['https://sakafleet.com/', 'https://sakafleet.com/privacy', 'https://sakafleet.com/terms', 'https://sakafleet.com/data-deletion', 'https://sakafleet.com/status']) {
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
const localeJs = fs.readFileSync(path.join(LANDING, 'assets/js/locale.js'), 'utf8');
check(mainJs.includes("API_BASE = 'https://app.sakafleet.com'") && mainJs.includes('/api/onboard'), 'main.js points only at the public API surface');
check(mainJs.includes("'/api/health'") && mainJs.includes("'/healthz'"), 'the uptime widget probes /api/health first, /healthz as legacy fallback');

console.log('\n--- Test 6: internal references resolve ---');
const localRefs = [...indexHtml.matchAll(/(?:src|href)="(\/[^"#][^"]*)"/g)].map((m) => m[1]);
const missing = localRefs.filter((ref) => {
  if (ref.startsWith('/assets/img/og-cover')) return false; // OG image is checked in Test 1
  const target = ref.replace(/^\//, '').split('?')[0];
  return !(fs.existsSync(path.join(LANDING, target)) || fs.existsSync(path.join(LANDING, target + '.html')));
});
check(missing.length === 0, `Every local reference resolves${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

console.log('\n--- Test 7: conversion architecture ---');
for (const needle of ['data-open-onboard', 'stepLegal', 'stepOtp', 'id="consent"', 'otpVerify', 'legalSubmit']) {
  check(indexHtml.includes(needle), `The onboarding modal carries ${needle}`);
}
check(/I have read, understood, and agree to the exhaustive Saka Fleet/.test(indexHtml), 'The mandatory legal checkbox copy is present');
check(indexHtml.includes('id="statusCard"') && indexHtml.includes('/status'), 'The homepage status chip links to the live status page');
check(indexHtml.includes('/data-deletion'), 'The footer links the data-deletion page');
check(indexHtml.includes('wa.me/19404407252') && !indexHtml.includes('wa.me/254700000000'), 'wa.me links point at the real Saka business number, never the placeholder');
check(!mainJs.includes('WA_NUMBER') && !mainJs.includes('waLink'), 'main.js no longer carries the manual WhatsApp deep-link plumbing');
check(localeJs.includes('navigator.language') && localeJs.includes('flagOf'), 'locale.js auto-detects the country from the browser locale and renders its flag');
check(!indexHtml.includes('This is where Saka says hello'), 'the phone hint is gone (locale detection replaced it)');
check(mainJs.includes("'/api/health'") && mainJs.includes("'/healthz'"), 'the status probe checks /api/health first, /healthz as legacy fallback');
check(mainJs.includes('already_verified'), 'the form handles already-registered visitors without an OTP');

console.log('\n--- Test 8: v1.40.0 content sweep ---');
const BANNED_VISIBLE = [
  ['Apex', /Apex/],
  ['Supabase', /Supabase/],
  ['Paystack', /Paystack/],
  ['Google Fonts', /fonts\.googleapis|fonts\.gstatic/],
  ['app.sakafleet.com (visible)', /app\.sakafleet\.com/],
  ['"Registered in Kenya"', /Registered in Kenya/],
  ['ODPC', /ODPC/]
];
let visibleText = '';
for (const file of walk(LANDING)) {
  if (!/\.(html|txt|svg)$/.test(file)) continue;
  if (/robots\.txt$/.test(file)) continue;
  visibleText += fs.readFileSync(file, 'utf8') + '\n';
}
for (const [label, pattern] of BANNED_VISIBLE) {
  check(!pattern.test(visibleText), `No "${label}" appears in visible site content`);
}
const privacyText = fs.readFileSync(path.join(LANDING, 'privacy.html'), 'utf8');
check(!/Supabase|Google Cloud|Resend API|Meta's|Paystack/.test(privacyText), 'The privacy policy names no infrastructure vendors');
const llmsText = fs.readFileSync(path.join(LANDING, 'llms.txt'), 'utf8');
check(!/app\.sakafleet\.com/.test(llmsText) && !/Apex|Supabase/.test(llmsText), 'llms.txt is sanitized of vendor names and the app host');
check(/Saka Fleet by Saka360/.test(fs.readFileSync(path.join(LANDING, 'privacy.html'), 'utf8')), 'the Data Controller is named Saka Fleet by Saka360');
check(/Basic Data Laws/.test(fs.readFileSync(path.join(LANDING, 'data-deletion.html'), 'utf8')), 'the data-deletion page uses the Basic Data Laws wording');
check(!indexHtml.includes('llms.txt (AI summary)'), 'the llms.txt footer link is gone (the machine-facing alternate link stays)');

console.log('\n--- Test 9: cookie consent + status page ---');
const statusHtml = fs.readFileSync(path.join(LANDING, 'status.html'), 'utf8');
check(statusHtml.includes('id="incidentTicker"') && statusHtml.includes('id="statusWord"'), 'the status page carries the live word and the incident ticker');
check(/realtime|real-time/i.test(statusHtml), 'the status page says it is realtime');
for (const page of ['index.html', 'privacy.html', 'terms.html', 'data-deletion.html', '404.html', 'status.html']) {
  const html = fs.readFileSync(path.join(LANDING, page), 'utf8');
  check(html.includes('id="cookieBanner"') && html.includes('cookieConsent.js'), `${page} carries the cookie banner`);
}
check(indexHtml.includes('data-cookie-settings'), 'the footer re-opens cookie settings');
check(/Strictly necessary/.test(fs.readFileSync(path.join(LANDING, 'privacy.html'), 'utf8')), 'the privacy policy documents the cookie categories');
const cookieJs = fs.readFileSync(path.join(LANDING, 'assets/js/cookieConsent.js'), 'utf8');
check(cookieJs.includes('localStorage') && cookieJs.includes('saka_cookie_consent'), 'consent is stored locally with a versioned key');
check(/no tracking|tracking or advertising/i.test(cookieJs), 'the consent copy promises no tracking');
const css = fs.readFileSync(path.join(LANDING, 'assets/css/styles.css'), 'utf8');
check(css.includes('@font-face') && css.includes('/assets/fonts/Outfit-800.woff2'), 'fonts are self-hosted via @font-face');
check(css.includes('line-clamp') && /width: min\(430px/.test(css), 'the cookie banner is compact (slim, clamped copy, small buttons)');

console.log('\n--- Test 10: country dataset mirrors the live catalogs (v1.41.0) ---');
const countriesJson = JSON.parse(fs.readFileSync(path.join(LANDING, 'data/countries.json'), 'utf8'));
check(countriesJson.global && countriesJson.countries, 'the dataset carries a GLOBAL fallback and a country map');
const regionByCode = new Map(REGIONS.map((r) => [r.country_code, r]));
for (const [code, entry] of Object.entries(countriesJson.countries)) {
  const bucket = COUNTRY_COMPLIANCE_CATALOG[code];
  check(Boolean(bucket), `${code} exists in the backend compliance catalog`);
  check(entry.compliance.minimal === bucket.minimal.label, `${code} minimal compliance matches the catalog (${bucket.minimal.label})`);
  const extraLabels = (bucket.additional || []).map((it) => it.label);
  check(JSON.stringify(entry.compliance.additional) === JSON.stringify(extraLabels), `${code} additional compliances match the catalog`);
  const region = regionByCode.get(code);
  check(Boolean(region), `${code} exists in the REGIONS registry`);
  check(entry.name === region.country && entry.currency === region.currency && entry.plateExample === region.plate_example && entry.units === region.default_units && entry.calling === region.prefix, `${code} country facts match the REGIONS registry`);
  check(Array.isArray(entry.lingo), `${code} carries a lingo list`);
}
check(indexHtml.includes('id="localeFlag"'), 'the hero carries the country flag chip');
check(indexHtml.includes('id="localeComplianceCards"') && indexHtml.includes('id="localeComplianceTitle"'), 'the homepage carries the country-aware compliance section');
check(localeJs.includes('/data/countries.json'), 'locale.js loads the country dataset');
check(/Get Started Free/.test(indexHtml) && /Deploy Your Fleet/.test(indexHtml), 'Primary CTAs are present');

console.log('\n--- Test 11: extensionless URLs (v1.42.0) ---');
const htaccess = fs.readFileSync(path.join(LANDING, '.htaccess'), 'utf8');
check(/RewriteCond %{REQUEST_FILENAME}\.html -f/.test(htaccess), '.htaccess maps extensionless URLs to .html files');
check(htaccess.includes('RewriteRule ^(.+)\\.html$ /$1 [R=301,L]'), '.htaccess redirects .html URLs to extensionless (301)');
let allHtml = '';
for (const file of walk(LANDING)) { if (/\.html$/.test(file)) allHtml += fs.readFileSync(file, 'utf8') + '\n'; }
check(!/href="\/[a-z0-9-]+\.html"/.test(allHtml), 'No internal page link uses the .html extension');
check(!/content="https:\/\/sakafleet\.com\/[a-z0-9-]+\.html"/.test(allHtml), 'Canonical and OG URLs are extensionless');
check(allHtml.includes('href="/status"') && allHtml.includes('href="/privacy"'), 'Nav and footer use clean URLs');
console.log(`\n🎉 ${passed} landing-site assertions passed.`);

console.log('\n--- Test 12: first-load flag, cache strategy, images (v1.43.0) ---');
const pkg143 = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
check(indexHtml.includes('id="saka-boot"') && indexHtml.includes('window.__SAKA_BOOT__'), 'the head carries the inline locale bootstrap');
const bootMatch = indexHtml.match(/var m=(\{[^;]*\});/);
check(Boolean(bootMatch), 'the bootstrap map is embedded and parseable');
if (bootMatch) {
  const bootMap = JSON.parse(bootMatch[1]);
  for (const code of Object.keys(countriesJson.countries)) {
    const e = countriesJson.countries[code];
    check(bootMap[code] && bootMap[code].name === e.name && bootMap[code].calling === e.calling, 'bootstrap map matches the dataset for ' + code);
  }
}
check(indexHtml.includes('document.documentElement.lang'), 'the bootstrap sets the html lang from the locale');
check(/og-cover\.png/.test(indexHtml) && !/og-cover\.svg/.test(indexHtml), 'the share image is a PNG');
const stampedV = indexHtml.match(/styles\.css\?v=([0-9.]+)/);
check(Boolean(stampedV) && stampedV[1] === pkg143.version, 'asset version stamp matches package.json');
const ht = fs.readFileSync(path.join(LANDING, '.htaccess'), 'utf8');
check(/\.\(html\|json\)\$/.test(ht) && ht.includes('Cache-Control "no-cache"'), 'HTML and JSON are served no-cache');
check(!/ExpiresByType text\/html/.test(ht), 'HTML is no longer long-cached');
check(indexHtml.includes('aria-live="polite"'), 'the locale sections announce updates politely');
check(/woff2\?v=/.test(css), 'self-hosted fonts are version-stamped');
check(indexHtml.includes('window.__SAKA_CODES__') && indexHtml.includes('Africa/Nairobi'), 'the bootstrap carries the timezone map (Africa/Nairobi -> KE)');
check(indexHtml.includes('saka_country_override'), 'the visitor can override the detected country (remembered in localStorage)');
check(indexHtml.includes('localeChangeBtn') && indexHtml.includes('localePick'), 'the chip offers a "Not you? Change" picker');
check(/Based on your location/.test(indexHtml), 'the chip copy is guess-framed, not presumptuous');
check(localeJs.includes('window.__SAKA_BOOT__'), 'locale.js reuses the bootstrap-resolved country');

console.log('\n--- Test 13: nav flag, universal compliance, locale-neutral copy (v1.45.0) ---');
for (const page of ['index.html', 'privacy.html', 'terms.html', 'data-deletion.html', 'status.html']) {
  check(fs.readFileSync(path.join(LANDING, page), 'utf8').includes('id="navFlag"'), `${page} carries the national-flag badge`);
}
check(indexHtml.includes("localStorage.setItem('saka_country'"), 'the bootstrap persists the resolved country for other pages');
const privacyHtml = fs.readFileSync(path.join(LANDING, 'privacy.html'), 'utf8');
check(privacyHtml.includes("localStorage.getItem('saka_country'") && privacyHtml.includes('String.fromCodePoint'), 'non-home pages render the flag from the persisted country (no map, no fetch)');
check(Array.isArray(countriesJson.universal) && countriesJson.universal.length >= 2, 'the dataset carries universal compliance cards (insurance + inspection)');
check(countriesJson.universal.some((u) => /insurance/i.test(u.label)) && countriesJson.universal.some((u) => /inspection|roadworth/i.test(u.label)), 'universal cards cover insurance and inspection/roadworthiness');
for (const [code, entry] of Object.entries(countriesJson.countries)) {
  const total = 1 + (entry.compliance.additional || []).length + (countriesJson.universal || []).length;
  check(total >= 3, `${code} renders at least three compliance cards (${total})`);
}
check(!indexHtml.includes('PSV documents') && indexHtml.includes('any required permits'), 'the drivers card is locale-neutral (no static PSV)');

console.log('\n--- Test 14: local-currency pricing + rate freshness (v1.46.0) ---');
const dataJson = JSON.parse(fs.readFileSync(path.join(LANDING, 'data/countries.json'), 'utf8'));
check(dataJson.exchangeRates && typeof dataJson.exchangeRates === 'object', 'the dataset carries an exchangeRates map');
for (const cur of ['USD', 'KES', 'NGN', 'ZAR', 'GBP', 'EUR', 'TZS', 'UGX', 'RWF', 'AUD', 'INR', 'AED', 'BRL']) {
  const r = dataJson.exchangeRates[cur];
  check(Number.isFinite(Number(r)) && Number(r) > 0, `exchangeRates carries ${cur} (positive)`);
}
check(Boolean(dataJson.ratesUpdatedAt) && !Number.isNaN(Date.parse(dataJson.ratesUpdatedAt)), 'the dataset stamps when rates were last refreshed');
const monthlyPairs = [['solo_pro', '9.99'], ['team_fleet', '17.99'], ['growth', '27.99']];
const annualPairs = [['solo_pro', '83.92'], ['team_fleet', '151.12'], ['growth', '235.12']];
for (const [tier, usd] of monthlyPairs) {
  check(indexHtml.includes(`data-usd-monthly="${usd}"`) && Number(usd) === getTierPriceUSD(tier, 'monthly'), `${tier} monthly USD matches the tier registry`);
}
for (const [tier, usd] of annualPairs) {
  check(indexHtml.includes(`data-usd-annual="${usd}"`) && Number(usd) === getTierPriceUSD(tier, 'annual'), `${tier} annual USD matches the tier registry`);
}
check(indexHtml.includes('data-addon-usd="3.99"') && Number('3.99') === getAddonPriceUSD('fleet_command', 'monthly'), 'the add-on USD matches the tier registry');
check(mainJs.includes('data-usd-monthly') && mainJs.includes('Intl.NumberFormat') && mainJs.includes("getAttribute('data-country')"), 'main.js localizes prices from the resolved country');

console.log('\n--- Test 15: signup polish + language capture (v1.47.0) ---');
check(!indexHtml.includes('otpWaLink') && !indexHtml.includes('doneWaLink') && !indexHtml.includes('Continue on WhatsApp'), 'the signup modal no longer offers a chat-with-Saka button');
check(indexHtml.includes('Saka will message you on WhatsApp'), 'the success copy tells the user Saka initiates');
check(mainJs.includes('preferred_language: detectLanguageName()') && mainJs.includes('navigator.language'), 'main.js captures the browser language at signup');
check(css.includes('.usd-hint') && css.includes('font-size: 11px'), 'the USD hint is tiny but legible (11px)');

console.log('Stateless suite: file reads only — no database, no cleanup needed.');

