import assert from 'assert';
import {
  parseOcrAmount,
  usesCommaDecimal,
  detectCurrencyFromText,
  validatePlateCandidate,
  validateVinCandidate,
  normalizeOcrDate,
  OCR_CURRENCY_CODES,
  OCR_CURRENCY_SYMBOLS
} from './src/services/ocrNormalizer.js';
import { sanitizeOcrExtraction, isOcrAiExtractionEnabled } from './src/services/ocrSemantic.js';

/**
 * Saka Fleet — universal OCR normalization (v1.54.1). Stateless.
 *
 * Every OCR value from ANY country resolves through one normalizer:
 * locale-aware amounts, CLDR currency symbols, per-country plate patterns,
 * the universal VIN guard and country-resolved dates. Rule 36: the GLOBAL
 * path stays neutral and nothing from a country profile leaks into it.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

console.log('=== SAKA FLEET — UNIVERSAL OCR NORMALIZATION TESTS (v1.54.1) ===\n');

console.log('--- Test 1: locale-resolved amounts ---');
check(parseOcrAmount('3000') === 3000, 'a plain integer parses everywhere');
check(parseOcrAmount('3,000.00', { countryCode: 'KE' }) === 3000, 'KE comma-thousands + dot decimals parse');
check(parseOcrAmount('1.234,56', { countryCode: 'DE' }) === 1234.56, 'EU dot-thousands + comma decimals parse');
check(parseOcrAmount('1.234,56', { countryCode: 'GLOBAL' }) === 1234.56, 'structurally-unambiguous EU grouping parses even in GLOBAL');
check(parseOcrAmount('1,234.56', { countryCode: 'GLOBAL' }) === 1234.56, 'structurally-unambiguous US grouping parses even in GLOBAL');
check(parseOcrAmount('45,50', { countryCode: 'DE' }) === 45.5, 'single-comma decimals resolve in a comma-decimal market');
check(parseOcrAmount('45,50', { countryCode: 'KE' }) === null, 'a single-comma token is never guessed in a comma-thousands market');
check(parseOcrAmount('45.50', { countryCode: 'KE' }) === 45.5, 'single-dot decimals resolve in a dot-decimal market');
check(parseOcrAmount('1.234', { countryCode: 'DE' }) === 1234, 'a dot-grouped token in a comma-decimal market is thousands');
check(parseOcrAmount('1.234', { countryCode: 'KE' }) === 1.234, 'the same token in a dot-decimal market is a decimal');
check(parseOcrAmount('3.000.00', { countryCode: 'GLOBAL' }) === null, 'OCR noise with mixed separators is never guessed');
check(parseOcrAmount('') === null && parseOcrAmount(null) === null, 'empty tokens return null');
check(usesCommaDecimal({ locale: 'de-DE' }) === true && usesCommaDecimal({ countryCode: 'FR' }) === true, 'comma-decimal locales are detected');
check(usesCommaDecimal({ countryCode: 'KE' }) === false && usesCommaDecimal({ locale: 'en-KE' }) === false, 'dot-decimal markets stay dot-decimal');

console.log('--- Test 2: extended currency detection ---');
check(detectCurrencyFromText('TOTAL ฿ 1,250.00') === 'THB', 'the Thai baht symbol resolves');
check(detectCurrencyFromText('R$ 1.234,56') === 'BRL', 'multi-char R$ wins over the bare dollar sign');
check(detectCurrencyFromText('KSh 5,500') === 'KES', 'the Kenyan shilling shorthand resolves');
check(detectCurrencyFromText('TOTAL 3000') === null, 'no currency marker means no currency (never assumed)');
check(OCR_CURRENCY_CODES.includes('NGN') && OCR_CURRENCY_CODES.length >= 30, 'the code table is the extended CLDR set');
check(OCR_CURRENCY_SYMBOLS['₹'] === 'INR' && OCR_CURRENCY_SYMBOLS['₦'] === 'NGN', 'Unicode symbols map to ISO codes');

console.log('--- Test 3: per-country plates (no leakage, rule 36) ---');
check(validatePlateCandidate('KDA 123A', 'KE') === 'KDA 123A', 'a KE plate passes its country pattern');
check(validatePlateCandidate('AB12 CDE', 'GB') === 'AB12 CDE', 'a GB plate passes its country pattern');
check(validatePlateCandidate('KA 01 AB 1234', 'IN') === 'KA 01 AB 1234', 'an Indian plate passes its country pattern');
check(validatePlateCandidate('ABC 123 GP', 'ZA') === 'ABC 123 GP', 'a South African plate passes its country pattern');
check(validatePlateCandidate('KDA 123A', 'GB') === null, 'a KE plate fails the GB pattern (country isolation)');
check(validatePlateCandidate('KDA 123A', 'GLOBAL') === 'KDA 123A', 'the GLOBAL neutral shape still accepts universal formats');
check(validatePlateCandidate('no digits here', 'GLOBAL') === null, 'a token without digits is never a plate');
check(validateVinCandidate('JTE777A1234567890') === 'JTE777A1234567890', 'a real VIN passes the universal guard');
check(validateVinCandidate('12345678') === null && validateVinCandidate('I0Q12345678') === null, 'short tokens and forbidden VIN letters are rejected');

console.log('--- Test 4: country-resolved dates ---');
check(normalizeOcrDate('20/11/2026', { countryCode: 'KE' }) === '2026-11-20', 'KE DD/MM/YYYY resolves through dateParser');
check(normalizeOcrDate('not a date') === null, 'invalid dates return null');

console.log('--- Test 5: semantic top-up sanitizer + kill switch ---');
check(isOcrAiExtractionEnabled() === false, 'OCR_AI_EXTRACTION defaults OFF during the testing phase');
const cleanTopUp = sanitizeOcrExtraction('receipt_fuel', {
  amount: '1.234,56', currency: 'EUR', date: '12/10/2026', vendor: 'Shell', junk: 'x'
}, { countryCode: 'DE' });
check(cleanTopUp.amount === 1234.56, 'an AI amount is re-validated through the locale normalizer');
check(cleanTopUp.currency === 'EUR', 'an AI currency code is re-validated');
check(cleanTopUp.date === '2026-10-12', 'an AI date is re-resolved country-first (12/10 = 12 Oct in DE)');
check(cleanTopUp.vendor === 'Shell' && cleanTopUp.junk === undefined, 'unknown keys are dropped from AI output');
const badTopUp = sanitizeOcrExtraction('receipt_fuel', {
  amount: '3.000.00', date: '99/99/2026', plate_number: '###'
}, { countryCode: 'GLOBAL' });
check(badTopUp.amount === undefined && badTopUp.date === undefined && badTopUp.plate_number === undefined, 'invalid AI values are dropped silently (never stored)');
const keTopUp = sanitizeOcrExtraction('logbook', { plate_number: 'KDA 123A' }, { countryCode: 'KE' });
check(keTopUp.plate_number === 'KDA 123A', 'an AI plate passes the country validator');

console.log(`\n🎉 ${passed} ocr-normalizer assertions passed.`);