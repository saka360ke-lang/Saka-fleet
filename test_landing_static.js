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
  'assets/css/styles.css', 'assets/js/main.js', 'assets/js/cookieConsent.js', 'assets/js/status.js', 'assets/js/locale.js', 'assets/js/nav.js',
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
check(/Saka 360/i.test(org.parentOrganization?.name || '') && org.email === 'support@reports.sakafleet.com', 'Organization names Saka 360 (Kenya) and the support email');

console.log('\n--- Test 3: AI-legibility files ---');
const llms = fs.readFileSync(path.join(LANDING, 'llms.txt'), 'utf8');
for (const needle of ['https://sakafleet.com/', '/privacy', '/terms', '/data-deletion', '/status', '/api/onboard', 'support@reports.sakafleet.com']) {
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
check(changelog.latest === JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version, 'The changelog "latest" matches package.json version');
// v1.59.0 — the feed is a PREVIEW: short titles plus one minimal line per entry
// (explicit `preview`, or the first sentence of the summary as a fallback).
const firstSentenceOf = (text) => {
  const value = String(text || '').trim();
  const match = value.match(/^[^.!?]+[.!?]/);
  return match ? match[0].trim() : value;
};
const previewOf = (entry) => String(entry.preview || firstSentenceOf(entry.summary)).trim();
const statusJsSource = fs.readFileSync(path.join(LANDING, 'assets/js/status.js'), 'utf8');
check(changelog.entries.every((e) => e.title.length <= 60), 'Every changelog title is short (<= 60 chars)');
check(changelog.entries.every((e) => previewOf(e).length > 0), 'Every changelog entry carries a preview line');
check(changelog.entries.filter((e) => e.preview).every((e) => String(e.preview).length <= 120), 'Every explicit preview is minimal (<= 120 chars)');
check(statusJsSource.includes('text.length <= 96'), 'The renderer caps derived previews at 96 chars (the feed stays a preview)');
check(Boolean(changelog.entries[0].preview), 'The newest entry ships an explicit preview line');
check(statusJsSource.includes('renderChangelogEntry') && statusJsSource.includes('<details class="cl-entry">'), 'The status page renders previews in an expandable card');
check(statusJsSource.includes('previewOf') && statusJsSource.includes('firstSentence'), 'The renderer derives a preview when an entry has none');
const stylesCss = fs.readFileSync(path.join(LANDING, 'assets/css/styles.css'), 'utf8');
check(stylesCss.includes('.cl-preview') && stylesCss.includes('.cl-detail'), 'The changelog preview and expander are styled');
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
check(cookieJs.includes('GTM-TGR68X2X'), 'the consent script carries the GTM container id');
check(/analytics === true/.test(cookieJs) && /googletagmanager\.com/.test(cookieJs), 'analytics (Google Tag Manager) load only after an explicit opt-in');
check(cookieJs.includes('window.__sakaCookies') && /chosen\s*:\s*function/.test(cookieJs), 'the consent script exposes a cookie-choice gate for signup (v1.49.3)');
check(mainJs.includes("event: 'successful_signup'") && mainJs.includes("signup_method: 'website'"), 'a successful signup pushes the successful_signup dataLayer event');
check(mainJs.includes('window.__sakaCookies') && mainJs.includes('.chosen()'), 'the signup flow gates on a recorded cookie choice');
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
console.log('\n--- Test 16: receipt/document storage copy (v1.58.16) ---');
const termsDoc = fs.readFileSync(path.join(LANDING, 'terms.html'), 'utf8');
const privacyDoc = fs.readFileSync(path.join(LANDING, 'privacy.html'), 'utf8');
const deletionDoc = fs.readFileSync(path.join(LANDING, 'data-deletion.html'), 'utf8');
check(termsDoc.includes('Documents and receipt photos') && termsDoc.includes('On the Free plan we keep only the parsed figures'), 'terms explains the document storage scope by plan');
check(privacyDoc.includes('On the Free plan we keep only what Saka reads from a photo') && privacyDoc.includes('paid plans and the welcome trial store the original file'), 'privacy states the Free-tier document storage nuance');
check(privacyDoc.includes('delete receipt N'), 'privacy documents the self-service receipt delete');
check(deletionDoc.includes('delete a single receipt or document photo') && deletionDoc.includes('delete receipt N'), 'data-deletion documents the single receipt delete path');
check(llms.includes('On the Free plan only the parsed figures are kept'), 'llms.txt tells answer engines the document storage scope');
check(indexHtml.includes('Where are my receipt photos stored?') && jsonLdBlocks.some((b2) => b2['@type'] === 'FAQPage' && JSON.stringify(b2).includes('Where are my receipt photos stored?')), 'the homepage FAQ (visible + JSON-LD) answers the storage question');
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

console.log('\n--- Test 16: launch campaign banner + UTM attribution (v1.58.26) ---');
check(indexHtml.includes('hero-note') && /30-day full-featured welcome trial/.test(indexHtml), 'the default hero note states the standard 30-day trial (truthful fallback)');
check(mainJs.includes('/api/onboard/launch-status') && mainJs.includes('launch_active'), 'main.js reads the public launch status');
check(mainJs.includes('if (!body || body.launch_active !== true || !(body.slots_left > 0)) return;'), 'the banner fails closed: an inactive or exhausted campaign leaves the default copy');
check(mainJs.includes('hero-note') && mainJs.includes('Launch offer'), 'an active campaign upgrades the hero note');
check(mainJs.includes("event: 'launch_offer_view'") && mainJs.includes('launch_award_days'), 'launch exposure rides the existing dataLayer (no new vendor)');
check(mainJs.includes('utm_source') && mainJs.includes('utm_medium') && mainJs.includes('utm_campaign'), 'main.js forwards UTM attribution on signup');
check(mainJs.includes("'utm_' + key") && mainJs.includes('slice(0, 64)'), 'UTM values come from utm_* params and are capped at 64 chars');

console.log('\n--- Test 17: launch banner + opt-in (v1.59.1) ---');
check(indexHtml.includes('id="launchBanner"') && indexHtml.includes('id="launchSlots"') && indexHtml.includes('id="launchDismiss"'), 'the site carries a dismissible launch banner with a live slot counter');
check(/id="launchBanner"[^>]*hidden/.test(indexHtml), 'the banner starts hidden (fail-closed until the status says it can award)');
check(/id="launchOptInWrap"[^>]*hidden/.test(indexHtml) && /id="launchOptIn"[^>]*checked/.test(indexHtml), 'the opt-in tick box is hidden by default and CHECKED by default');
check(indexHtml.includes('help us polish Saka for production') || indexHtml.includes('help Saka reach production'), 'the banner tells users their use helps reach production');
check(mainJs.includes('renderLaunchBanner') && mainJs.includes('launchSlots') && mainJs.includes('launchAwardDays'), 'main.js renders the counter from the campaign status');
check(mainJs.includes('launch_opt_in: readLaunchOptIn()'), 'the signup payload carries the launch opt-in');
check(mainJs.includes('readLaunchOptIn') && mainJs.includes('wrap.hidden = false'), 'the opt-in box only appears while the campaign is open');
check(mainJs.includes('launch_offer_dismiss') && mainJs.includes('saka_launch_banner_dismissed'), 'banner dismissal is remembered and tracked');
check(mainJs.includes("event: 'successful_signup'") && mainJs.includes('launch_opt_in: typeof optedIn'), 'signup analytics record the opt-in choice');
check(css.includes('.launch-banner') && css.includes('.launch-optin'), 'the banner and opt-in box are styled');

console.log('\n--- Test 18: sticky glowing banner + live signup guard (v1.59.2) ---');
const headerSlice = indexHtml.slice(indexHtml.indexOf('<header class="nav">'), indexHtml.indexOf('</header>'));
check(headerSlice.includes('id="launchBanner"'), 'the banner lives INSIDE the sticky header (visible while scrolling)');
check(indexHtml.includes('signups get a full') && !indexHtml.includes('fleets get a full'), 'the banner copy says "signups", not "fleets"');
check(css.includes('@keyframes launch-glow') && css.includes('prefers-reduced-motion') && css.includes('animation: launch-glow'), 'the banner carries a slow glow pulse with a reduced-motion fallback');
check(css.includes('the launch banner stacks and centres on small screens') && /\.launch-banner\s*\{[^}]*flex-direction: column/.test(css), 'the banner stacks and centres on mobile');
check(indexHtml.includes('id="detailsContinue"') && /id="detailsContinue"[^>]*disabled/.test(indexHtml), 'the Continue button starts disabled (gated by the live check)');
check(indexHtml.includes('id="emailStatus"') && indexHtml.includes('id="phoneStatus"'), 'both fields carry an availability note');
check(mainJs.includes('/api/onboard/check') && mainJs.includes('refreshContinueGate') && mainJs.includes('scheduleAvailabilityCheck'), 'main.js checks availability as the user types and gates Continue');
check(mainJs.includes('availability.failed === true') && mainJs.includes("availability.email === 'registered'"), 'a failed check fails open; a known account never advances');
check(mainJs.includes('signedUpMessage') && mainJs.includes('continue on WhatsApp'), 'the user is told when the number/email already has an account');
check(css.includes('.avail-note'), 'the availability note is styled');

console.log('\n--- Test 19: Afterglow Ember theme + ember drawer menu (v1.59.3) ---');
check(css.includes('--orange: #FF6A00') && css.includes('--grad-orange') && css.includes('--text-on-orange: #04121B'), 'the ember palette is declared as tokens');
check(/\.btn-primary\s*\{[^}]*var\(--grad-orange\)[^}]*var\(--text-on-orange\)/.test(css), 'the primary CTA uses the orange gradient with dark text (contrast-safe)');
check(css.includes('.grad-ember-text') && indexHtml.includes('grad-ember-text'), 'one headline word burns ember (cool to hot gradient)');
check(/rgba\(255,\s*106,\s*0,\s*\.17\)/.test(css), 'the hero carries an ember glow layer');
check(/\.price-card\.popular\s*\{[^}]*255,\s*106,\s*0/.test(css), 'the most-popular plan is rim-lit in ember');
check(css.includes(':focus-visible') && /:focus-visible\s*\{[^}]*var\(--orange\)/.test(css), 'keyboard focus rings use the ember accent');
check(css.includes('prefers-reduced-motion') && css.includes('@keyframes menu-rise'), 'the drawer animation honours reduced motion');
check(css.includes('.nav-burger') && css.includes('.nav-menu') && css.includes('max-width: 960px'), 'burger + full-screen drawer appear at tablet/mobile widths');
const navJsSource = fs.readFileSync(path.join(LANDING, 'assets/js/nav.js'), 'utf8');
check(navJsSource.includes('aria-expanded') && navJsSource.includes('aria-controls') && navJsSource.includes("event.key === 'Escape'"), 'the drawer is keyboard and ARIA accessible');
check(navJsSource.includes(".nav-links") && navJsSource.includes('nav-open'), 'the drawer builds from the existing nav links (no duplicated markup)');
for (const page of ['index.html', 'status.html', 'privacy.html', 'terms.html', 'data-deletion.html']) {
  check(fs.readFileSync(path.join(LANDING, page), 'utf8').includes('/assets/js/nav.js'), `${page} loads the shared menu script`);
}

console.log('Stateless suite: file reads only — no database, no cleanup needed.');

