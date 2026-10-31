import assert from 'assert';
import fs from 'node:fs';
import { buildDocs } from './scripts/gen_kb_docs.js';
import { PRODUCT_QA } from './src/services/productQa.js';
import { SAKA_PROMPT_SCHEMA_VERSION } from './sakaAi.js';

/**
 * Saka Fleet — generated knowledge docs (v1.28.0). Stateless.
 *
 * Product QA and training are generated from the live registries. This suite
 * fails when the committed docs drift from the code, which is what keeps the
 * "QA file" and "Saka training" always current with every deploy.
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const docs = buildDocs();
const productDocPath = Object.keys(docs).find((file) => file.endsWith('PRODUCT_QA.md'));
const trainingDocPath = Object.keys(docs).find((file) => file.endsWith('SAKA_TRAINING.md'));

console.log('=== SAKA FLEET — GENERATED KNOWLEDGE DOC TESTS (v1.28.0) ===\n');

console.log('--- Test 1: both docs are generated ---');
check(Boolean(productDocPath) && Boolean(trainingDocPath), 'the generator produces the product and training docs');
for (const [file, content] of Object.entries(docs)) {
  const name = file.split(/[\\/]/).pop();
  check(content.length > 500, `${name} has real content (${content.length} chars)`);
  check(content.includes(`**${pkg.version}**`), `${name} carries the package version ${pkg.version}`);
}

console.log('\n--- Test 2: the committed docs match the live code ---');
for (const [file, expected] of Object.entries(docs)) {
  const name = file.split(/[\\/]/).pop();
  check(fs.existsSync(file), `${name} exists on disk`);
  const onDisk = fs.readFileSync(file, 'utf8');
  check(onDisk === expected, `${name} matches the live registries (run npm run docs:gen on drift)`);
}

console.log('\n--- Test 3: product knowledge is complete ---');
const productDoc = docs[productDocPath];
for (const entry of PRODUCT_QA) {
  check(productDoc.includes(`## ${entry.id}`), `product doc covers "${entry.id}"`);
}
check(/Solo Pro/.test(productDoc) && /Fleet Command/.test(productDoc), 'product doc carries the tier facts');
check(/30-day free trial/.test(productDoc), 'product doc carries the trial length from the engine');

console.log('\n--- Test 4: training snapshot is complete ---');
const trainingDoc = docs[trainingDocPath];
check(trainingDoc.includes(SAKA_PROMPT_SCHEMA_VERSION), 'training doc carries the prompt schema version');
check(/VOICE LAW/.test(trainingDoc), 'training doc carries the VOICE LAW');
check(/GREETING LAW/.test(trainingDoc), 'training doc carries the GREETING LAW');
check(/ANSWER LAW/.test(trainingDoc), 'training doc carries the ANSWER LAW');
check(/Banned phrases/.test(trainingDoc), 'training doc lists the banned phrases');
check(/Core system prompt \(verbatim\)/.test(trainingDoc), 'training doc embeds the full core prompt');

console.log(`\n🎉 ${passed} knowledge-doc assertions passed.`);
