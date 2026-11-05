import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatCompletion, parseJsonSafely, AI_PURPOSES, AI_TIERS } from '../src/services/aiClient.js';
import { validateCase, SYNTHETIC_DIR } from '../src/services/convEvalCases.js';

/**
 * Saka Fleet — global synthetic conversation scenario generator (v1.61.0)
 * -----------------------------------------------------------------------
 * Generates messy, multi-turn WhatsApp scenarios across distinct country buckets
 * so the GEval judge can stress-test Saka against regional shorthand, currencies
 * and transport vocabulary — not just Kenyan English.
 *
 * Governance:
 *  - EVERY generation call rides the single AI hub (`conversation_synth`,
 *    reasoning tier, JSON mode) — rule 20 is never bypassed.
 *  - Output is written as `evals/cases/syn_<CC>_<stamp>.json` and validated with
 *    the SAME `validateCase()` the judge uses, so a bad batch can never enter a
 *    run. Real phone numbers, emails and real plates are rejected.
 *  - Country buckets are metadata on the case (rule 41 isolation): regional
 *    lessons stay inside the batch for human/Sentinel review — this script never
 *    writes `country_learnings` (that table is derived from live chats).
 *  - On-demand only: no scheduler, no env knob, bounded batches, `--preview`
 *    spends tokens but writes nothing.
 *
 * Run: npm run synth:cases -- --countries=KE,NG,ZA --batch=4 [--preview]
 */

export const SYNTH_VERSION = '1.61.0';
export const SYNTH_PROMPT = 'conversation_synth';
export const DEFAULT_COUNTRIES = Object.freeze(['KE', 'NG', 'ZA', 'GLOBAL']);
export const MAX_CASES_PER_COUNTRY = 24;

/**
 * v1.61.3 — the "known AND unknown" scenario taxonomy. `--edge` rotates these
 * seeds into each bucket so every generation pass rehearses the classes real
 * chats produce: unreadable media, mixed languages, date chaos, ambiguity,
 * verification friction, capacity limits, restarts and document handling.
 */
export const EDGE_CASES = Object.freeze([
  'an unreadable voice note or blurry photo of a document (offer a clear next step, never claim a save)',
  'mixed-language shorthand (local slang + English + a typo) for a fuel quick-log',
  'a date written in the wrong convention for the user country (DD/MM vs MM/DD ambiguity)',
  'two vehicles with the same model and an ambiguous "my car" reference',
  'an expired verification code with a "change email" escape',
  'a fleet at its plan limit trying to add one more vehicle',
  'three frustrated restarts ("restart", "starts again", "ugh") mid-flow',
  'a search by document number (badge/licence) that must hit the compliance ledger, not expenses',
  'a pasted licence paragraph containing a number, an expiry and unfamiliar legal words',
  'a local-currency amount that must stay in the local currency with exact units'
]);

/** Country buckets aligned with Saka's global operating reality. */
export const SYNTH_REGIONS = Object.freeze({
  KE: {
    label: 'Kenya (East Africa)',
    currency: 'KES',
    phraseology: 'Sheng + Swahili mix ("niaje", "poa", "nimeweka 40l", "mzee", "buda"), matatu/boda vocabulary, KRA e-TIMS receipts, "bob" for shillings.',
    examples: ['nimeweka 40l diesel 5k kda 777a full tank', 'niaje, fuel report ya last week', 'hii gari inatumia mafuta aje?']
  },
  NG: {
    label: 'Nigeria (West Africa)',
    currency: 'NGN',
    phraseology: 'Nigerian pidgin ("abeg", "wetin", "na", "don log am", "no wahala"), danfo/keke/trailer vocabulary, "k" for thousands (20k), fuel queues.',
    examples: ['abeg log 20k petrol for the bus', 'wetin be my fuel average this month?', 'the trailer don use 80 litres']
  },
  ZA: {
    label: 'South Africa (Southern Africa)',
    currency: 'ZAR',
    phraseology: 'South African transport English ("bakkie", "petrol", "garage", "just now", "eish", "lekker"), e-tolls, litres and Rand.',
    examples: ['eish, log 60 litres petrol for the bakkie', 'howzit, service was R4500', 'the truck fuel bill is too high']
  },
  GH: {
    label: 'Ghana (West Africa)',
    currency: 'GHS',
    phraseology: 'Twi/pidgin mix ("chale", "abeg", "troski", "wahala"), gallons-vs-litres confusion, cedis.',
    examples: ['chale I bought 30 litres for the troski', 'abeg how much fuel left?', 'the driver used 2 gallons']
  },
  BR: {
    label: 'Brazil (Latin America)',
    currency: 'BRL',
    phraseology: 'Brazilian Portuguese ("abasteci 50 litros", "caminhão", "posto", "troca de óleo"), comma decimals (R$ 1.234,56).',
    examples: ['abasteci 50 litros de diesel no caminhão', 'qual o consumo do caminhão?', 'paguei 350 reais na troca de óleo']
  },
  MX: {
    label: 'Mexico (Latin America)',
    currency: 'MXN',
    phraseology: 'Mexican Spanish ("eché 40 litros", "troca de aceite", "casetas", "pesos"), "diesel" and "gasolina" distinction.',
    examples: ['eché 40 litros de diesel a la camioneta', 'cuánto gasté en gasolina esta semana?', 'la caseta costó 250 pesos']
  },
  PH: {
    label: 'Philippines (Southeast Asia)',
    currency: 'PHP',
    phraseology: 'Taglish ("paki-log", "gasolina", "jeepney", "tricycle"), "piso", heavy traffic/idling context.',
    examples: ['paki-log 20 liters diesel sa jeepney', 'magkano gasolina ko this week?', 'traffic sobra, mataas consumo']
  },
  IN: {
    label: 'India (South Asia)',
    currency: 'INR',
    phraseology: 'Hinglish ("kitna diesel", "gaadi", "bhai", "bhara"), lakh/crore number grouping (1,00,000), truck/auto vocabulary.',
    examples: ['bhai 40 litre diesel bhara, 5000 rupees', 'gaadi ka average kitna hai?', 'service ke liye 12000 diye']
  },
  AE: {
    label: 'United Arab Emirates (Gulf)',
    currency: 'AED',
    phraseology: 'Gulf English/Arabic mix ("petrol", "ltrs", "dirhams", "van", "yalla"), Salik/toll context.',
    examples: ['filled 80 ltrs petrol for the van, 150 dirhams', 'what is my fuel cost this month?', 'Salik recharge 100 dirhams']
  },
  GLOBAL: {
    label: 'Global / neutral international English',
    currency: 'USD',
    phraseology: 'Neutral international English with mixed units (km/miles, litres/gallons) and ISO or locale dates — no single national slang.',
    examples: ['filled 40 liters diesel, 55 dollars, 88210 km, full tank', 'show me last week fuel report', 'my truck uses too much fuel']
  }
});

/**
 * System prompt: a global transit QA engineer that produces the SAME case shape
 * the judge consumes (turns + final ideal reply), so ingestion needs no mapping.
 */
export function buildSynthSystem() {
  return [
    'You are a global transit QA engineer for Saka Fleet, a WhatsApp-native fleet assistant used by owners and drivers of vehicles, equipment, generators and boats.',
    'Generate messy, realistic, multi-turn WhatsApp conversations that stress-test the assistant in a specific country bucket.',
    'HARD RULES:',
    '- Never use a real phone number, email address, VIN or a real person\'s name. Plates must be obviously fictional (e.g. "KDA 777A", "LAG-123-XY").',
    '- Use the regional shorthand, slang, transport vocabulary and local currency of the requested bucket.',
    '- Each case has 2-6 turns BEFORE the final reply; the LAST turn must be from the user. The reply is the FIRST assistant response to that last user message — the transcript must NOT already contain a confirmation of the same action.',
    '- `reply` is the IDEAL assistant reply under Saka Persona v4: warm, WhatsApp-native, contractions, active verbs ("Logged ✓"), at most ONE question, exact units/currency, and NEVER an invented amount, date, plate, VIN, OTP or legal rule.',
    '- REPLY SHAPE (hard): maximum 2 short lines. Do NOT recap earlier entries or repeat a confirmation from the transcript. Do NOT append "Need anything else?", "Want a summary?", a menu or a second question. A completed write gets the confirmation card ONLY.',
    '- NEVER claim an action already happened unless the transcript ends with the user explicitly confirming that exact summary (CONFIRM/yes). If the action still needs confirmation, ask for it in the SAME line — never claim it is saved.',
    '- ACK VARIETY: if any earlier assistant turn opened with "Poa!", "Sawa", "Logged:" or "Got it", the reply must use a DIFFERENT confirmation opener.',
    '- Across the batch cover ALL of: quick-log shorthand, local currency/unit handling (gallons vs litres, "k" for thousands, comma decimals), multi-turn interruptions or quiz context switches, and loop traps (a repeated question the assistant must not repeat).',
    '- Some user turns should be frustrated, rushed or typo-heavy; some should be polite and analytical.',
    'Return ONLY JSON (no markdown fences) shaped exactly as:',
    '{"cases":[{"id":"syn_<cc>_<nn>","country_bucket":"KE|NG|ZA|GH|BR|MX|PH|IN|AE|GLOBAL","scenario_title":"short title","regional_context":"<=200 chars on local phrasing/currency","tags":["shorthand","interruption","looping","complaint","currency"],"friction_type":"LOOPING_PROMPTS|USER_FRUSTRATION|INCOMPLETE_REPLY|MULTI_QUESTION_PROMPT|null","turns":[{"role":"user","text":"..."},{"role":"assistant","text":"..."}],"reply":"ideal Saka reply","expected":"pass","lessons":["<=200 chars regional lesson"],"expected_metrics":{"min_loop_avoidance_score":0.9,"requires_shorthand_parsing":true}}]}'
  ].join('\n');
}

/** User prompt: one country bucket per call, explicit count and coverage mix. */
export function buildSynthPrompt({ countryBucket = 'GLOBAL', count = 4, seed = null } = {}) {
  const region = SYNTH_REGIONS[countryBucket] || SYNTH_REGIONS.GLOBAL;
  return [
    `COUNTRY BUCKET: ${countryBucket} — ${region.label}`,
    `LOCAL CURRENCY: ${region.currency}`,
    `REGIONAL PHRASEOLOGY: ${region.phraseology}`,
    `EXAMPLE USER LINES (do not copy verbatim): ${region.examples.join(' | ')}`,
    `GENERATE: ${count} distinct cases.`,
    'Coverage: at least one shorthand quick-log, one currency/unit conversion, one interruption/context switch, and one loop trap.',
    seed ? `EXTRA SEED TOPIC: ${seed}` : '',
    'Every case must be self-contained (a reader needs no other case to understand it).',
    'Return the JSON object now.'
  ].filter(Boolean).join('\n');
}

const PII_PHONE = /(?:\+\d{9,}|\b0\d{9,}\b|\b\d{10,}\b)/;
const PII_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
function hasPii(text = '') {
  return PII_PHONE.test(String(text)) || PII_EMAIL.test(String(text));
}

/**
 * Map one generated object into the strict corpus schema. Tolerates the common
 * model drift (`content` instead of `text`, a trailing assistant turn as the
 * reply) and rejects anything that would weaken the corpus (bad bucket, PII,
 * missing user turn, no reply).
 */
export function sanitizeSyntheticCase(raw, { countryBucket = 'GLOBAL', index = 1, timestamp = null, seen = new Set() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['not an object'] };
  const stamp = timestamp || new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const bucket = String(raw.country_bucket ?? raw.countryBucket ?? countryBucket ?? 'GLOBAL').trim().toUpperCase();
  if (!SYNTH_REGIONS[bucket]) return { ok: false, errors: [`unsupported country_bucket ${bucket}`] };

  const turns = [];
  for (const turn of (Array.isArray(raw.turns) ? raw.turns : []).slice(0, 8)) {
    const role = String(turn?.role || '').toLowerCase();
    const text = String(turn?.text ?? turn?.content ?? '').trim().slice(0, 1200);
    if (!text || !['user', 'assistant'].includes(role)) continue;
    turns.push({ role, text });
  }
  let reply = String(raw.reply ?? '').trim().slice(0, 1600);
  if (!reply && turns.length && turns[turns.length - 1].role === 'assistant') {
    reply = turns.pop().text;
  }
  if (!turns.some((turn) => turn.role === 'user')) return { ok: false, errors: ['no user turn'] };
  if (!reply) return { ok: false, errors: ['missing reply'] };

  const metrics = (raw.expected_metrics && typeof raw.expected_metrics === 'object') ? raw.expected_metrics : {};
  // v1.61.1 — only an explicit min_score is case-wide. The loop metric stays in
  // expected_metrics and becomes a per-criterion bar in validateCase.
  const minScoreRaw = raw.min_score ?? raw.minScore ?? metrics.min_score ?? null;
  const hasMinScore = minScoreRaw !== null && minScoreRaw !== undefined && minScoreRaw !== '' && Number.isFinite(Number(minScoreRaw));
  const minScore = hasMinScore ? Math.min(1, Math.max(0.5, Number(minScoreRaw))) : null;

  const rawTags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => String(tag || '').toLowerCase().replace(/[^a-z0-9-]/g, '-')).filter(Boolean)
    : [];
  const tags = [...new Set([
    'synth',
    bucket === 'GLOBAL' ? 'global' : bucket.toLowerCase(),
    ...rawTags
  ])].slice(0, 8);
  if ((metrics.requires_shorthand_parsing === true || rawTags.includes('shorthand')) && !tags.includes('shorthand')) {
    tags.push('shorthand');
  }

  const lessons = [];
  for (const lesson of (Array.isArray(raw.lessons) ? raw.lessons : []).slice(0, 5)) {
    const text = String(lesson || '').trim().slice(0, 200);
    if (text && !hasPii(text)) lessons.push(text);
  }

  const cleanText = (value, max = 200) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return hasPii(text) ? '' : text.slice(0, max);
  };
  const title = cleanText(raw.scenario_title || raw.title, 120);
  const regionalContext = cleanText(raw.regional_context || raw.context, 240);

  // v1.61.1 — ids are ALWAYS engine-namespaced (`syn_<cc>_<stamp>_<nn>`). A
  // model-invented id (e.g. `syn_ke_01`) is advisory only: two generation runs
  // both produced `syn_ke_01` and the loader (correctly) rejected the second
  // batch as duplicates. The stamp makes every run's ids unique across files.
  let id = `syn_${bucket.toLowerCase()}_${stamp}_${String(index).padStart(2, '0')}`;
  if (seen.has(id)) id = `${id.slice(0, 56)}-${String(index).padStart(2, '0')}`;

  const candidate = {
    id,
    country_bucket: bucket,
    scenario_title: title || `${bucket} synthetic scenario`,
    regional_context: regionalContext || SYNTH_REGIONS[bucket].phraseology,
    tags,
    friction_type: raw.friction_type || null,
    turns,
    reply,
    expected: 'pass',
    lessons,
    expected_metrics: metrics,
    min_score: minScore ?? undefined,
    note: `${title || 'synthetic scenario'}${regionalContext ? ` — ${regionalContext}` : ''}`.slice(0, 200),
    source: 'synthetic'
  };
  const checked = validateCase(candidate, seen);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return { ok: true, errors: [], value: checked.value };
}

/** Parse a model response into a raw case list. Never throws. */
export function parseSyntheticBatch(text = '') {
  const parsed = parseJsonSafely(text);
  if (!parsed) return { ok: false, cases: [], errors: ['unparseable JSON'] };
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cases) ? parsed.cases : null);
  if (!list) return { ok: false, cases: [], errors: ['missing cases array'] };
  return { ok: true, cases: list, errors: [] };
}

/** Deterministic filename: syn_<cc>_<YYYYMMDD-HHmmss>[-n].json */
export function syntheticFilename(countryBucket, now = new Date(), suffix = '') {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `syn_${String(countryBucket).toLowerCase()}_${stamp}${suffix}.json`;
}

/** Atomic, non-overwriting write of one validated batch. */
export function writeSyntheticBatch({ dir = SYNTHETIC_DIR, countryBucket, cases = [], now = new Date() } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) return { ok: false, reason: 'no cases' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    let suffix = '';
    let counter = 0;
    let target = path.join(dir, syntheticFilename(countryBucket, now, suffix));
    while (fs.existsSync(target)) {
      counter += 1;
      suffix = `-${counter}`;
      target = path.join(dir, syntheticFilename(countryBucket, now, suffix));
    }
    const payload = {
      generated_by: 'generate_synthetic_cases',
      version: SYNTH_VERSION,
      prompt: SYNTH_PROMPT,
      country_bucket: countryBucket,
      created_at: new Date(now).toISOString(),
      cases
    };
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, path: target, filename: path.basename(target), count: cases.length };
  } catch (err) {
    return { ok: false, reason: err?.message || 'write failed' };
  }
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                      */
/* ------------------------------------------------------------------ */

/** Parse CLI flags (exported for the release test). */
export function parseArgs(argv = []) {
  const args = { countries: [], batch: 4, preview: false, out: SYNTHETIC_DIR, seed: null, edge: false, help: false, now: new Date() };
  for (const raw of argv) {
    if (raw === '--preview') args.preview = true;
    else if (raw === '--edge') args.edge = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--countries=')) {
      args.countries = raw.slice('--countries='.length).split(',').map((code) => code.trim().toUpperCase()).filter(Boolean);
    } else if (raw.startsWith('--batch=')) {
      args.batch = Math.min(MAX_CASES_PER_COUNTRY, Math.max(1, Number(raw.slice('--batch='.length)) || 4));
    } else if (raw.startsWith('--out=')) {
      args.out = path.resolve(raw.slice('--out='.length));
    } else if (raw.startsWith('--seed=')) {
      args.seed = raw.slice('--seed='.length).trim() || null;
    }
  }
  return args;
}

/**
 * One country bucket per `conversation_synth` call, then strict validation.
 * `complete` is injectable so the release test can prove the plumbing offline.
 */
export async function generateForCountry({ countryBucket, count = 4, seed = null, complete = chatCompletion, now = new Date() } = {}) {
  if (!SYNTH_REGIONS[countryBucket]) {
    return { ok: false, countryBucket, error: `unsupported bucket ${countryBucket}`, cases: [], rejected: [] };
  }
  const purpose = AI_PURPOSES[SYNTH_PROMPT];
  let result;
  try {
    result = await complete({
      system: buildSynthSystem(),
      messages: [{ role: 'user', content: buildSynthPrompt({ countryBucket, count, seed }) }],
      jsonMode: true,
      purpose: SYNTH_PROMPT,
      maxTokens: purpose?.maxTokens || 2000,
      temperature: purpose?.temperature ?? 0.75
    });
  } catch (err) {
    return { ok: false, countryBucket, error: err?.message || 'provider error', cases: [], rejected: [] };
  }
  if (!result?.ok || !result.text) {
    return { ok: false, countryBucket, error: result?.error?.message || 'provider returned no text', cases: [], rejected: [], model: result?.model || null };
  }
  const parsed = parseSyntheticBatch(result.text);
  if (!parsed.ok) {
    return { ok: false, countryBucket, error: parsed.errors.join('; '), cases: [], rejected: [], model: result.model || null };
  }
  const stamp = new Date(now).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const seen = new Set();
  const cases = [];
  const rejected = [];
  parsed.cases.slice(0, count * 2).forEach((raw, index) => {
    const checked = sanitizeSyntheticCase(raw, { countryBucket, index: index + 1, timestamp: stamp, seen });
    if (checked.ok) {
      seen.add(checked.value.id);
      cases.push(checked.value);
    } else {
      rejected.push({ index: index + 1, errors: checked.errors });
    }
  });
  if (cases.length > count) rejected.push({ index: 0, errors: [`over batch cap (${cases.length - count})`] });
  return { ok: cases.length > 0, countryBucket, model: result.model || null, cases: cases.slice(0, count), rejected };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log([
      'Saka Fleet — global synthetic conversation generator (v1.61.0)',
      '',
      'Usage: npm run synth:cases -- [options]',
      '  --countries=KE,NG,ZA   buckets to generate (default KE,NG,ZA,GLOBAL)',
      '  --batch=4              cases per bucket (1-24, default 4)',
      '  --seed="text"          extra topic seed for every bucket',
      '  --edge                 rotate the known/unknown scenario taxonomy into buckets',
      '  --preview              generate + validate, write nothing',
      '  --out=<dir>            output directory (default evals/cases)',
      '',
      `Buckets: ${Object.keys(SYNTH_REGIONS).join(', ')}`
    ].join('\n'));
    return 0;
  }
  const countries = args.countries.length ? args.countries : [...DEFAULT_COUNTRIES];
  const invalid = countries.filter((code) => !SYNTH_REGIONS[code]);
  if (invalid.length) {
    console.error(`Unsupported country bucket(s): ${invalid.join(', ')}. Known: ${Object.keys(SYNTH_REGIONS).join(', ')}`);
    return 1;
  }
  if (!AI_PURPOSES[SYNTH_PROMPT]) {
    console.error(`AI purpose '${SYNTH_PROMPT}' is not registered in aiClient — refusing to call a provider outside the hub (rule 20).`);
    return 1;
  }
  if (AI_PURPOSES[SYNTH_PROMPT].tier !== AI_TIERS.REASONING) {
    console.error(`AI purpose '${SYNTH_PROMPT}' must stay on the reasoning tier (found tier ${AI_PURPOSES[SYNTH_PROMPT].tier}).`);
    return 1;
  }

  console.log(`🧪 Synthetic scenarios: ${countries.length} bucket(s) × ${args.batch} case(s)${args.preview ? ' · PREVIEW (no writes)' : ''}`);
  let totalCases = 0;
  let totalWritten = 0;
  let failures = 0;
  for (const [index, countryBucket] of countries.entries()) {
    console.log(`\n🌍 ${countryBucket} — ${SYNTH_REGIONS[countryBucket].label}`);
    // v1.61.3 — `--edge` rotates the known/unknown taxonomy into every bucket.
    const seed = [args.seed, args.edge ? EDGE_CASES[index % EDGE_CASES.length] : null].filter(Boolean).join(' + ') || null;
    const generated = await generateForCountry({ countryBucket, count: args.batch, seed, now: args.now });
    if (!generated.ok) {
      failures += 1;
      console.warn(`  ⚠️ generation failed: ${generated.error}`);
      continue;
    }
    totalCases += generated.cases.length;
    console.log(`  ✓ ${generated.cases.length} validated · ${generated.rejected.length} rejected · model ${generated.model || 'default'}`);
    for (const rejected of generated.rejected.slice(0, 5)) {
      console.warn(`    rejected #${rejected.index}: ${rejected.errors.join(', ')}`);
    }
    if (args.preview) {
      console.log('  (preview — nothing written)');
      continue;
    }
    const written = writeSyntheticBatch({ dir: args.out, countryBucket, cases: generated.cases, now: args.now });
    if (written.ok) {
      totalWritten += written.count;
      console.log(`  💾 ${written.filename}`);
    } else {
      failures += 1;
      console.warn(`  ⚠️ write failed: ${written.reason}`);
    }
  }
  console.log(`\nDone: ${totalCases} case(s) validated, ${totalWritten} written${args.preview ? ' (preview)' : ''}.`);
  if (!totalCases) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Synthetic generator error:', err);
      process.exit(1);
    });
}





