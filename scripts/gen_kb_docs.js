import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SAKA_CORE_PROMPT,
  SAKA_FLOW_PLAYBOOK,
  PROMPT_REFINEMENT_MARKER,
  SAKA_PROMPT_SCHEMA_VERSION
} from '../sakaAi.js';
import { PRODUCT_QA, buildProductQaReply, tierFactLines } from '../src/services/productQa.js';
import {
  SAKA_TONE_COMPASS,
  SAKA_SALES_PLAYBOOK,
  SAKA_INTENTS,
  SAKA_QUIZ_FLOWS,
  SAKA_BOUNDARY_RULES
} from '../src/services/flowKnowledge.js';

/**
 * Saka Fleet — Product QA + training docs generator (v1.28.0).
 * ----------------------------------------------------------
 * The human-readable knowledge files are GENERATED from the live code, never
 * hand-written, so they cannot drift from what Saka actually knows.
 *
 *   npm run docs:gen     # write docs/PRODUCT_QA.md + docs/SAKA_TRAINING.md
 *   npm run docs:check   # verify the committed docs match the code (CI gate)
 *
 * The generator never touches the database and never calls an AI provider.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const PRODUCT_DOC = path.join(DOCS_DIR, 'PRODUCT_QA.md');
const TRAINING_DOC = path.join(DOCS_DIR, 'SAKA_TRAINING.md');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const generatedAt = `Generated from code at version **${pkg.version}** — do not edit by hand. Run \`npm run docs:gen\`.`;

function renderProductQaDoc() {
  const lines = [
    '# Saka Fleet — Product QA (generated)',
    '',
    generatedAt,
    '',
    `Registry: \`src/services/productQa.js\` · ${PRODUCT_QA.length} topics · prices from \`src/services/subscriptionTiers.js\``,
    '',
    '## Plan facts',
    '',
    ...tierFactLines().map((line) => `- ${line}`),
    ''
  ];
  for (const entry of PRODUCT_QA) {
    lines.push(`## ${entry.id}`, '', buildProductQaReply(entry), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderTrainingDoc() {
  const lines = [
    '# Saka Fleet — Training Snapshot (generated)',
    '',
    generatedAt,
    '',
    `- Prompt schema: \`${PROMPT_REFINEMENT_MARKER}\` (version ${SAKA_PROMPT_SCHEMA_VERSION})`,
    `- Intents trained: **${SAKA_INTENTS.length}**`,
    `- Quiz flows trained: **${SAKA_QUIZ_FLOWS.length}**`,
    `- Boundary rules: **${SAKA_BOUNDARY_RULES.length}**`,
    '',
    '## Voice & tone compass',
    '',
    `**Voice:** ${SAKA_TONE_COMPASS.voice}`,
    '',
    '**Banned phrases (never send):**',
    '',
    ...SAKA_TONE_COMPASS.bannedPhrases.map((phrase) => `- "${phrase}"`),
    '',
    '**Poles:**',
    '',
    ...SAKA_TONE_COMPASS.poles.map((pole) => `- **${pole.name}** — ${pole.law}`),
    '',
    '**Floors:**',
    '',
    ...SAKA_TONE_COMPASS.floors.map((floor) => `- ${floor}`),
    '',
    '## Sales playbook',
    '',
    ...SAKA_SALES_PLAYBOOK.alwaysClose.map((rule) => `- ${rule}`),
    ...SAKA_SALES_PLAYBOOK.neverDo.map((rule) => `- NEVER: ${rule}`),
    '',
    '## Flow playbook (authoritative)',
    '',
    '```text',
    SAKA_FLOW_PLAYBOOK,
    '```',
    '',
    '## Core system prompt (verbatim)',
    '',
    '```text',
    DEFAULT_SAKA_CORE_PROMPT.trim(),
    '```',
    ''
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildDocs() {
  return {
    [PRODUCT_DOC]: renderProductQaDoc(),
    [TRAINING_DOC]: renderTrainingDoc()
  };
}

function writeDocs(docs) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  for (const [file, content] of Object.entries(docs)) {
    fs.writeFileSync(file, content, 'utf8');
  }
}

function checkDocs(docs) {
  const drift = [];
  for (const [file, content] of Object.entries(docs)) {
    if (!fs.existsSync(file)) {
      drift.push(`${path.relative(ROOT, file)} is missing`);
      continue;
    }
    const onDisk = fs.readFileSync(file, 'utf8');
    if (onDisk !== content) drift.push(`${path.relative(ROOT, file)} is out of date`);
  }
  return drift;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const docs = buildDocs();
  if (process.argv.includes('--check')) {
    const drift = checkDocs(docs);
    if (drift.length) {
      console.error('❌ Knowledge docs are out of date:');
      for (const item of drift) console.error(`  - ${item}`);
      console.error('Run: npm run docs:gen');
      process.exit(1);
    }
    console.log('✅ Product QA and training docs match the code.');
  } else {
    writeDocs(docs);
    console.log(`✅ Wrote ${Object.keys(docs).length} knowledge docs from the live registries.`);
  }
}
