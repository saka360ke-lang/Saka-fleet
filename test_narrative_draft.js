// v1.34.0 - Narrative Interaction Engine: deterministic draft regression suite.
// DB-free determinism checks PLUS one live round-trip: a retro-dated sentence
// must produce an expense row whose created_at is the stated Nairobi day.
import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { runWithCleanup } from './scripts/testCleanup.js';
import { handleQuizTurn, startQuiz, getCurrentQuizField } from './src/services/quizEngine.js';
import {
  buildNarrativeDraft,
  narrativeDraftFields,
  narrativeDraftExtras,
  shouldPrefillNarrativeDraft,
  describeNarrativeDraft,
  detectNarrativeKind,
  extractVolume,
  extractOdometer,
  extractFillType,
  extractVendor,
  matchNarrativeVehicle,
  isNarrativeIntakeEnabled,
  isNarrativeEligibleText,
  buildNarrativeParagraphDrafts,
  renderNarrativeBatchCard,
  resolveNarrativeBatchTurn,
  NARRATIVE_DRAFT_VERSION
} from './src/services/narrativeDraft.js';
import { parseMoneyStory } from './src/services/moneyLexicon.js';
import { extractPastDatePhrase } from './src/services/dateParser.js';

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

// Fixed clock: Sunday 1 November 2026, 09:00 Africa/Nairobi.
const NOW = new Date('2026-11-01T09:00:00+03:00');
const KE = { countryInfo: { country_code: 'KE', currency: 'KES', locale: 'en-KE' } };
const US = { countryInfo: { country_code: 'US', currency: 'USD', locale: 'en-US' } };
const GLOBAL = { countryInfo: { country_code: 'GLOBAL', currency: 'USD', locale: 'en-US' } };
const VEHICLES = [
  { id: 'v1', plate: 'KDA 123A', make: 'Toyota', model: 'Fielder' },
  { id: 'v2', plate: 'KCB 456B', make: 'Toyota', model: 'Probox' }
];

const draftFor = (text, { ctx = KE, vehicles = VEHICLES, activeVehicle = VEHICLES[0] } = {}) => (
  buildNarrativeDraft({ text, ctx, vehicles, activeVehicle, now: NOW })
);

console.log('=== Narrative draft: money, type, volume, odometer ===');

const fullStory = draftFor('spent 5500 on diesel yesterday at Shell, 40L at 50350km, full tank');
check('full story amount', fullStory.money.amount === 5500, fullStory.money.amount);
check('full story type is Fuel', fullStory.fields.expense_type === 'Fuel', fullStory.fields.expense_type);
check('full story volume', fullStory.fields.fuel_liters === 40, fullStory.fields.fuel_liters);
check('full story odometer', fullStory.fields.odometer_reading === 50350, fullStory.fields.odometer_reading);
check('full story fill type', fullStory.fields.fill_type === 'Full tank', fullStory.fields.fill_type);
check('full story vendor', fullStory.vendor?.value === 'Shell', fullStory.vendor);
check('full story retro date', fullStory.occurredAt?.localDate === '2026-10-31', fullStory.occurredAt);
check('full story knows nothing is missing', fullStory.missing.length === 0, fullStory.missing);
check('full story is prefilled', shouldPrefillNarrativeDraft(fullStory) === true);

const unitPriceStory = draftFor('topped up fuel; 1000kes @227kes per liter, @367365km');
check('unit-price story amount', unitPriceStory.money.amount === 1000, unitPriceStory.money.amount);
check('unit-price story unit price', unitPriceStory.money.unitPrice === 227, unitPriceStory.money.unitPrice);
check('unit-price story odometer', unitPriceStory.fields.odometer_reading === 367365, unitPriceStory.fields.odometer_reading);
check('unit-price story is a top-up', unitPriceStory.fields.fill_type === 'Top-up', unitPriceStory.fields.fill_type);
check('unit-price story asks for litres only', JSON.stringify(unitPriceStory.missing) === '["fuel_liters"]', unitPriceStory.missing);

const parking = draftFor('I paid 50 bob for parking');
check('currency word resolves to KES', parking.money.currency === 'KES', parking.money.currency);
check('parking amount', parking.money.amount === 50, parking.money.amount);
check('parking type', parking.fields.expense_type === 'Parking', parking.fields.expense_type);

const scaleStory = draftFor('Full tank 6k');
check('scale suffix k → 6000', scaleStory.money.amount === 6000, scaleStory.money.amount);
check('bare scale keeps fuel type', scaleStory.fields.expense_type === 'Fuel', scaleStory.fields.expense_type);

const millions = draftFor('spent 1.5m on the truck');
check('scale suffix m → 1,500,000', millions.money.amount === 1500000, millions.money.amount);

const slashStory = draftFor('spent 1,500/- at Shell');
check('slashed amount', slashStory.money.amount === 1500, slashStory.money.amount);

const partsStory = draftFor('brakes 4,500 plus labour 2,500');
check('additive line items sum', partsStory.money.amount === 7000, partsStory.money.amount);
check('additive sum is flagged', partsStory.money.derivedTotal === true && partsStory.money.lineItems.length === 2);
check('parts type', partsStory.fields.expense_type === 'Parts', partsStory.fields.expense_type);

const carYear = draftFor('Toyota Fielder 2016, 88,500km');
check('model year is never money', carYear.money.amount === null, carYear.money);
check('model year still yields the odometer', carYear.odometer.km === 88500, carYear.odometer);

const dated = draftFor('on 28/10/2026 spent 3000 for fuel');
check('explicit past date honoured', dated.occurredAt?.localDate === '2026-10-28', dated.occurredAt);
check('explicit date amount', dated.money.amount === 3000, dated.money.amount);

const combined = draftFor('5,000 for fuel and 300 for water');
check('two spends with "and" combine', combined.money.amount === 5300, combined.money.amount);

check('a lone year is not a spend', parseMoneyStory('2026').amount === null);
check('distance is not money', parseMoneyStory('Drove 120 km in 2 hours').amount === null);
check('counts are not money', parseMoneyStory('4 new tyres for 24000').amount === 24000, parseMoneyStory('4 new tyres for 24000').amount);


console.log('=== Narrative draft: never guesses ===');

const ambiguous = draftFor('spent 800 on water yesterday and 200 today');
check('additive total still resolves', ambiguous.money.amount === 1000, ambiguous.money);
check('two days in one message never pick a date', ambiguous.occurredAt === null, ambiguous.occurredAt);
check('multi-date warning surfaces', ambiguous.warnings.includes('multi-date'), ambiguous.warnings);
check('multi-date drafts are never auto-prefilled', shouldPrefillNarrativeDraft(ambiguous) === false);

const futureStory = draftFor('insurance 12000 next monday');
check('future dates are not written', futureStory.occurredAt === null, futureStory.occurredAt);
check('future date warning surfaces', futureStory.warnings.includes('future-date'), futureStory.warnings);
check('future date keeps the amount', futureStory.money.amount === 12000, futureStory.money.amount);

const noVendor = draftFor('spent 3000 at the shop');
check('vague places are not invented as vendors', noVendor.vendor === null, noVendor.vendor);

console.log('=== Narrative draft: units, vendor and vehicle resolution ===');
const gallons = extractVolume('filled 10 gallons', { unitSystem: 'imperial', countryCode: 'US' });
check('gallons convert to litres (US)', gallons.liters === 37.85, gallons);
check('metric volume untouched', extractVolume('40 litres', { unitSystem: 'metric', countryCode: 'KE' }).liters === 40);
check('miles convert to km', extractOdometer('at 62,000 miles', { unitSystem: 'imperial' }).km === 99779, extractOdometer('at 62,000 miles', { unitSystem: 'imperial' }));
check('fill type from brimmed', extractFillType('brimmed it').fillType === 'Full tank');
check('no fill type when unstated', extractFillType('diesel 2000').fillType === null);
check('vendor hint without capitals', extractVendor('fuel 3000 at shell').value === 'shell', extractVendor('fuel 3000 at shell'));

check('single vehicle resolves automatically', matchNarrativeVehicle('fuel 2000', [VEHICLES[0]], null).reason === 'single');
const platePick = matchNarrativeVehicle('car wash 500 kcb 456b', VEHICLES, VEHICLES[0]);
check('explicit plate beats the active vehicle', platePick.vehicle?.id === 'v2' && platePick.reason === 'plate', platePick.reason);
const ordinalPick = matchNarrativeVehicle('fuel 2000 on the second one', VEHICLES, VEHICLES[0]);
check('ordinal chooses the vehicle', ordinalPick.vehicle?.id === 'v2' && ordinalPick.reason === 'ordinal', ordinalPick.reason);
const ambiguousPick = matchNarrativeVehicle('fuel 2000', VEHICLES, VEHICLES[1]);
check('unmentioned vehicle is ambiguous, never silently defaulted', ambiguousPick.vehicle === null && ambiguousPick.reason === 'ambiguous', ambiguousPick);
const dbVehicles = [
  { id: 'v1', plate_number: 'KDA 123A', make_model: 'Toyota Fielder' },
  { id: 'v2', plate_number: 'KCB 456B', make_model: 'Toyota Probox' }
];
check('plate_number routes (live DB field)', matchNarrativeVehicle('car wash 500 kcb 456b', dbVehicles, dbVehicles[0]).vehicle?.id === 'v2');
check('make_model label routes', matchNarrativeVehicle('wash the probox', dbVehicles, dbVehicles[0]).vehicle?.id === 'v2');

// v1.89.0 (Phase 27C) — NICKNAME-FIRST resolution (D3).
const nickVehicles = [
  { id: 'v1', plate_number: 'KDA 123A', make_model: 'Toyota Fielder', nickname: 'The Workhorse' },
  { id: 'v2', plate_number: 'KCB 456B', make_model: 'Toyota Probox', nickname: 'The Sprinter' }
];
const nickPick = matchNarrativeVehicle('log fuel 3000 for the workhorse', nickVehicles, nickVehicles[1]);
check('a nickname resolves its vehicle before the active default', nickPick.vehicle?.id === 'v1' && nickPick.reason === 'nickname', nickPick);
const nickCasePick = matchNarrativeVehicle('THE WORKHORSE needed diesel', nickVehicles, null);
check('nickname matching is case-insensitive', nickCasePick.vehicle?.id === 'v1' && nickCasePick.reason === 'nickname', nickCasePick);
const nickPlatePick = matchNarrativeVehicle('fuel 2000 for kcb 456b', nickVehicles, nickVehicles[0]);
check('a plate still resolves when the nickname is not mentioned', nickPlatePick.vehicle?.id === 'v2' && nickPlatePick.reason === 'plate', nickPlatePick);
const nickWordBoundary = matchNarrativeVehicle('the workhorses harness', nickVehicles, null);
check('a nickname never matches inside another word (whole-token boundaries)', nickWordBoundary.vehicle === null && nickWordBoundary.reason === 'ambiguous', nickWordBoundary.reason);
const sharedNick = matchNarrativeVehicle('fuel 2000 for the workhorse', [
  { id: 'v1', plate_number: 'KDA 123A', nickname: 'The Workhorse' },
  { id: 'v2', plate_number: 'KCB 456B', nickname: 'The Workhorse' }
], null);
check('two assets sharing a nickname ask instead of guessing', sharedNick.vehicle === null && sharedNick.reason === 'ambiguous-nickname' && sharedNick.candidates.length === 2, sharedNick.reason);
const shortNick = matchNarrativeVehicle('fuel 2000', [
  { id: 'v1', plate_number: 'KDA 123A', nickname: 'AB' },
  { id: 'v2', plate_number: 'KCB 456B' }
], null);
check('a nickname under 3 characters never matches', shortNick.vehicle === null && shortNick.reason === 'ambiguous', shortNick.reason);

const plateStory = draftFor('car wash 500 kcb 456b last friday');
check('a mentioned plate is never read as money', plateStory.money.amount === 500, plateStory.money);
check('plate story picks the right vehicle', plateStory.fields.vehicle_id === 'v2', plateStory.fields.vehicle_id);
check('plate story date', plateStory.occurredAt?.localDate === '2026-10-30', plateStory.occurredAt);


console.log('=== Narrative draft: records, dates and country conventions ===');
check('earnings are recognised', detectNarrativeKind('earned 4500 today on 3 trips') === 'earning');
check('odometer updates are recognised', detectNarrativeKind('odometer now at 51200 km') === 'mileage');
check('a spend is an expense', detectNarrativeKind('fuel 2000') === 'expense', detectNarrativeKind('fuel 2000'));
check('earning amount', draftFor('earned 4500 today').money.amount === 4500);
check('mileage kind keeps the odometer', draftFor('odometer now at 51200 km').fields.odometer_reading === 51200);

check('yesterday resolves', extractPastDatePhrase('spent 3000 yesterday', { countryCode: 'KE', now: NOW }).localDate === '2026-10-31');
check('days ago resolves', extractPastDatePhrase('3 days ago tyre 4000', { countryCode: 'KE', now: NOW }).localDate === '2026-10-29');
check('last weekday resolves', extractPastDatePhrase('last friday wash 500', { countryCode: 'KE', now: NOW }).localDate === '2026-10-30');
check('future weekdays are rejected', extractPastDatePhrase('next monday', { countryCode: 'KE', now: NOW }).future === true);
check('a sentence with no date returns nothing', extractPastDatePhrase('fuel 2000', { countryCode: 'KE', now: NOW }).ok === false);

// Country conventions: 10/09 is 10 September (DD/MM) in Kenya,
// 9 October (MM/DD) in the USA.
const keDate = extractPastDatePhrase('fuel 3000 on 10/09', { countryCode: 'KE', now: NOW });
const usDate = extractPastDatePhrase('fuel 3000 on 10/09', { countryCode: 'US', now: NOW });
check('DD/MM resolved for Kenya', keDate.localDate === '2026-09-10', keDate.localDate);
check('MM/DD resolved for the USA', usDate.localDate === '2026-10-09', usDate.localDate);

const usDraft = draftFor('filled 10 gallons for 45 dollars at Chevron', { ctx: US });
check('US draft keeps USD', usDraft.money.currency === 'USD', usDraft.money.currency);
check('US draft converts gallons', usDraft.volume.liters === 37.85, usDraft.volume);
const globalDraft = draftFor('paid 40 for parking', { ctx: GLOBAL });
check('GLOBAL fallback currency is USD', globalDraft.money.currency === 'USD', globalDraft.money.currency);

console.log('=== Narrative draft: AI can never overwrite determinism ===');
const authority = draftFor('spent 5500 on diesel yesterday at Shell, 40L at 50350km, full tank');
const aiGuess = { amount: 9000, expense_type: 'Maintenance', fuel_liters: 12, fill_type: 'Top-up' };
const merged = { ...aiGuess, ...narrativeDraftFields(authority) };
check('deterministic amount wins over AI', merged.amount === 5500, merged.amount);
check('deterministic type wins over AI', merged.expense_type === 'Fuel', merged.expense_type);
check('deterministic volume wins over AI', merged.fuel_liters === 40, merged.fuel_liters);
check('deterministic fill type wins over AI', merged.fill_type === 'Full tank', merged.fill_type);

const extras = narrativeDraftExtras(authority);
check('retro date travels to the write path', extras.occurred_at === '2026-10-31', extras);
check('vendor travels to the write path', extras.vendor === 'Shell', extras);

check('kill switch defaults to on', isNarrativeIntakeEnabled({}) === true);
check('kill switch honours NARRATIVE_INTAKE=off', isNarrativeIntakeEnabled({ NARRATIVE_INTAKE: 'off' }) === false);
check('kill switch honours NARRATIVE_INTAKE=0', isNarrativeIntakeEnabled({ NARRATIVE_INTAKE: '0' }) === false);
check('drafts carry a version', authority.version === NARRATIVE_DRAFT_VERSION);
check('empty text yields no draft', buildNarrativeDraft({ text: '   ', ctx: KE, vehicles: VEHICLES, now: NOW }).ok === false);
const description = describeNarrativeDraft(authority, { locale: 'en-KE', currency: 'KES' });
check('description names the currency and the date', /Ksh|KES/.test(description || '') && /31 Oct 2026/.test(description || ''), description);

console.log('=== Narrative intake: eligibility threshold (v1.35.0, D5) ===');
check('a bare one-liner stays on the fast path', isNarrativeEligibleText('fuel 2000') === false);
check('empty text is never narrative', isNarrativeEligibleText('   ') === false);
check('a short dated line is narrative', isNarrativeEligibleText('fuel 2000 yesterday') === true);
check('a sentence break is narrative', isNarrativeEligibleText('fuel 2000. also 300 parking') === true);
check('a long paragraph is narrative', isNarrativeEligibleText('I went to the station on the way to town and paid for a full refill with some change left over') === true);
check('a per-litre price is narrative', isNarrativeEligibleText('1000kes @227 per litre') === true);
check('a full-tank word is narrative', isNarrativeEligibleText('full tank') === true);
check('a vendor mention is narrative', isNarrativeEligibleText('diesel at Shell') === true);
check('narrative extras carry the record kind', narrativeDraftExtras(draftFor('earned 4500 today')).kind === 'earning', narrativeDraftExtras(draftFor('earned 4500 today')));

console.log('=== v1.59.0 - optional record labels ===');
const labelHash = draftFor('filled 40L at 50,350 km for 5,500 at Shell #karen');
check('a hashtag label captures deterministically', labelHash.fields?.label === 'karen', labelHash.fields);
check('the label rides the write extras', narrativeDraftExtras(labelHash).label === 'karen', narrativeDraftExtras(labelHash));
const labelMarker = draftFor('spent 3,000 on parking label: school run');
check('a "label:" marker captures deterministically', labelMarker.fields?.label === 'school run', labelMarker.fields);
const noLabel = draftFor('filled 40L at 50,350 km for 5,500');
check('a draft without a tag carries no label', !narrativeDraftExtras(noLabel).label, narrativeDraftExtras(noLabel));

console.log('=== Multi-record paragraphs (v1.38.0, D4) ===');
const paragraph = buildNarrativeParagraphDrafts({
  text: 'yesterday I filled 40L for 5500 at Shell and paid 300 for parking',
  ctx: KE, vehicles: VEHICLES, activeVehicle: VEHICLES[0], now: NOW
});
check('a two-record paragraph splits', paragraph.ok && paragraph.drafts.length === 2, paragraph.drafts.length);
check('first record keeps its own amount', paragraph.drafts[0]?.money.amount === 5500, paragraph.drafts[0]?.money);
check('second record keeps its own amount', paragraph.drafts[1]?.money.amount === 300, paragraph.drafts[1]?.money);
check('the first record carries the past date', paragraph.drafts[0]?.occurredAt?.localDate === '2026-10-31', paragraph.drafts[0]?.occurredAt);
check('the second record has no invented date', paragraph.drafts[1]?.occurredAt === null, paragraph.drafts[1]?.occurredAt);

const threeWay = buildNarrativeParagraphDrafts({
  text: 'fuel 4500 at total. parking 300. tyres 12000',
  ctx: KE, vehicles: VEHICLES, activeVehicle: VEHICLES[0], now: NOW
});
check('sentence breaks make three records', threeWay.ok && threeWay.drafts.length === 3, threeWay.drafts.length);

const oneLine = buildNarrativeParagraphDrafts({
  text: 'brakes 4500 plus labour 2500',
  ctx: KE, vehicles: VEHICLES, activeVehicle: VEHICLES[0], now: NOW
});
check('an additive line stays ONE record', oneLine.drafts.length === 1 && oneLine.drafts[0].money.amount === 7000, oneLine.drafts.length);

const mixed = buildNarrativeParagraphDrafts({
  text: 'earned 4500 today and spent 300 on parking',
  ctx: KE, vehicles: VEHICLES, activeVehicle: VEHICLES[0], now: NOW
});
check('earning + expense split into two kinds', mixed.drafts.length === 2 && mixed.drafts[0].kind === 'earning' && mixed.drafts[1].kind === 'expense', mixed.drafts.map((d) => d.kind));

const batchCard = renderNarrativeBatchCard(paragraph.drafts, { locale: 'en-KE', currency: 'KES' });
check('batch card lists numbered rows', /1\./.test(batchCard) && /2\./.test(batchCard) && /Save all/.test(batchCard), batchCard);
const batchNow = Date.now();
const freshAt = new Date().toISOString();
check('batch turn resolves SAVE ALL', resolveNarrativeBatchTurn({ batch: { drafts: [{}], at: freshAt }, text: 'save all', now: batchNow }).type === 'save-all');
check('batch turn resolves edit N', resolveNarrativeBatchTurn({ batch: { drafts: [{}, {}], at: freshAt }, text: 'edit 2', now: batchNow }).index === 1);
check('batch turn resolves cancel', resolveNarrativeBatchTurn({ batch: { drafts: [{}], at: freshAt }, text: 'cancel', now: batchNow }).type === 'cancel');
check('an expired batch drops', resolveNarrativeBatchTurn({ batch: { drafts: [{}], at: new Date(batchNow - 16 * 60 * 1000).toISOString() }, text: 'save all', now: batchNow }).dropBatch === true);

console.log(`\n${pass} passed, ${fail} failed (deterministic section)`);

// ---------------------------------------------------------------------------
// Live round-trip: the whole quiz path (prefill → confirm → write) must save a
// retro-dated expense whose created_at is the Nairobi day the user stated.
// ---------------------------------------------------------------------------
const OWNER_PHONE = '+254711998877';
const TEST_VIN = 'NARRATV3401234567';

async function runLiveRoundTrip() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log('⚠️ Supabase credentials missing — live round-trip skipped.');
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  console.log('\n--- Live narrative round-trip (retro created_at) ---');

  const { data: owner, error: ownerErr } = await supabase.from('profiles').insert([{
    id: crypto.randomUUID(),
    phone_number: OWNER_PHONE,
    full_name: 'Narrative Owner',
    is_active: true
  }]).select().single();
  check('live: profile seeded', !ownerErr && Boolean(owner), ownerErr?.message);

  const { data: vehicle, error: vehErr } = await supabase.from('vehicles').insert([{
    id: crypto.randomUUID(),
    owner_id: owner.id,
    owner_phone: OWNER_PHONE,
    plate_number: 'NRV 340X',
    make_model: 'Toyota Fielder',
    yom: 2019,
    fuel_type: 'Petrol',
    current_mileage: 50000,
    odometer_reading: 50000,
    vin: TEST_VIN,
    status: 'ACTIVE'
  }]).select().single();
  check('live: vehicle seeded', !vehErr && Boolean(vehicle), vehErr?.message);

  const sentence = 'spent 5500 on diesel yesterday at Shell, 40L at 50350km, full tank';
  const draft = buildNarrativeDraft({
    text: sentence,
    ctx: { countryInfo: { country_code: 'KE', currency: 'KES', locale: 'en-KE' } },
    vehicles: [{ id: vehicle.id, plate: vehicle.plate_number, make_model: vehicle.make_model }],
    activeVehicle: { id: vehicle.id }
  });
  check('live: draft is complete and prefilled', draft.ok && shouldPrefillNarrativeDraft(draft), draft.missing);

  const session = {};
  const ctx = {
    supabase,
    profile: owner,
    vehicles: [{ ...vehicle, id: vehicle.id }],
    activeVehicle: { ...vehicle, id: vehicle.id },
    countryInfo: { country_code: 'KE', currency: 'KES', locale: 'en-KE' },
    senderPhone: OWNER_PHONE,
    formattedPhone: OWNER_PHONE,
    language: 'English',
    intent: 'LOG_EXPENSE',
    aiExtracted: { ...narrativeDraftFields(draft), _narrative: narrativeDraftExtras(draft) },
    messageText: sentence,
    fastQuiz: false,
    driverGate: null,
    sendWhatsApp: async () => {}
  };

  const started = startQuiz({ session, flowKey: 'log_expense', ctx });
  check('live: quiz starts from the narrative sentence', started === true && session.quiz?.narrativeExtras?.occurred_at === draft.occurredAt.localDate, session.quiz?.narrativeExtras);
  check('live: quiz is pre-filled with no missing fields', session.quiz && Object.keys(session.quiz.answers).length >= 6, session.quiz?.answers);

  // Answer optional questions with Skip and confirm with Yes, exactly like a
  // real user finishing a pre-filled draft.
  let turn = await handleQuizTurn({ session, messageText: '', ctx });
  let guard = 0;
  while (turn.handled && !turn.completed && guard < 6) {
    guard += 1;
    const current = getCurrentQuizField(session.quiz, ctx);
    const answer = current?.optional ? 'skip' : 'yes';
    turn = await handleQuizTurn({ session, messageText: answer, ctx });
  }
  check('live: confirmation writes the record', turn.completed === true, turn.reply?.slice(0, 80));

  const { data: rows, error: readErr } = await supabase.from('expense_logs')
    .select('id,amount,created_at,fill_type')
    .eq('vehicle_id', vehicle.id)
    .order('created_at', { ascending: false });
  check('live: expense row exists', !readErr && rows?.length === 1, readErr?.message);
  if (rows?.length === 1) {
    check('live: amount stored', Number(rows[0].amount) === 5500, rows[0].amount);
    check('live: fill type stored', rows[0].fill_type === 'full', rows[0].fill_type);
    const storedParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(rows[0].created_at));
    const storedDay = storedParts.replace(/-/g, '');
    const expectedDay = String(draft.occurredAt.localDate).replace(/-/g, '');
    check('live: created_at is the stated Nairobi day', storedDay === expectedDay, `${storedDay} vs ${expectedDay}`);
  }

  // The fresh-row guard: an existing expense may be edited in place, but a
  // retro date must never rewrite its created_at (edit path has no date).
  check('live: retro date only exists on fresh writes', draft.occurredAt.localDate < new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()), 'retro date is in the past');

  // v1.38.0 — SAVE ALL: the same per-row write path, one row per draft.
  const batchParagraph = buildNarrativeParagraphDrafts({
    text: 'yesterday fuel 2000 at 50300km and parking 250 at 50300km',
    ctx: { countryInfo: { country_code: 'KE', currency: 'KES', locale: 'en-KE' } },
    vehicles: [{ id: vehicle.id, plate: vehicle.plate_number, make_model: vehicle.make_model }],
    activeVehicle: { id: vehicle.id }
  });
  check('live: batch paragraph splits into two drafts', batchParagraph.ok && batchParagraph.drafts.length === 2, batchParagraph.drafts.length);
  const savedBatch = [];
  for (const batchDraft of batchParagraph.drafts) {
    const batchSession = {};
    await handleQuizTurn({
      session: batchSession,
      messageText: '',
      startFlow: 'log_expense',
      aiExtracted: { ...narrativeDraftFields(batchDraft), _narrative: narrativeDraftExtras(batchDraft) },
      ctx
    });
    const confirmed = await handleQuizTurn({ session: batchSession, messageText: '1', ctx });
    if (confirmed.completed) savedBatch.push(batchDraft);
  }
  check('live: every batch row saves', savedBatch.length === 2, savedBatch.length);
  const { data: batchRows } = await supabase.from('expense_logs').select('id,amount,expense_type').eq('vehicle_id', vehicle.id);
  check('live: three rows total after the batch', batchRows?.length === 3, batchRows?.length);

  console.log('✅ Live narrative round-trip complete.');
}

runWithCleanup({
  testFn: async () => {
    await runLiveRoundTrip();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) {
      process.exitCode = 1;
    } else {
      console.log(`✅ ALL NARRATIVE DRAFT TESTS PASSED (${pass} assertions).`);
    }
  },
  phones: [OWNER_PHONE],
  vins: [TEST_VIN]
}).catch((err) => {
  console.error('\n❌ Test suite failed:', err.message);
  process.exit(1);
});

