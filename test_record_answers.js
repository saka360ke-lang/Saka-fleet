// v1.36.0 - Record Answers: deterministic ledger Q&A regression suite.
// DB-free parsing/formatter checks PLUS a live round-trip: seeded ledger rows
// must answer "how much did I spend yesterday?" with the exact Nairobi-day total.
import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { runWithCleanup } from './scripts/testCleanup.js';
import { parseRecordQuestion, formatRecordAnswer, RECORD_ANSWER_VERSION, looksLikeLogStatement } from './src/services/recordAnswers.js';
import { queryRecordLedger } from './src/services/recordQuery.js';
import { resolveDateRange, formatNairobiDate } from './src/services/dateParser.js';

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

const NOW = new Date('2026-11-01T09:00:00+03:00');
const KE = { countryCode: 'KE', locale: 'en-KE', now: NOW };

console.log('=== Record answers: question parsing ===');

const fuelWeek = parseRecordQuestion('how much did I spend on fuel last week?', KE);
check('total question parses', fuelWeek.ok === true && fuelWeek.kind === 'total', fuelWeek);
check('fuel type is resolved from the catalog', fuelWeek.expenseTypes.includes('Fuel'), fuelWeek.expenseTypes);
check('last week resolves to a 7-day window', fuelWeek.range && fuelWeek.range.from === '2026-10-26' && fuelWeek.range.to === '2026-11-01', fuelWeek.range);

const yesterdayList = parseRecordQuestion('what did I log yesterday?', KE);
check('list question parses', yesterdayList.kind === 'list');
check('yesterday is a single day', yesterdayList.range && yesterdayList.range.from === '2026-10-31' && yesterdayList.range.to === '2026-10-31', yesterdayList.range);

const avgFill = parseRecordQuestion('average spend per fill in October', KE);
check('average question parses', avgFill.kind === 'average');
check('in October bounds the month', avgFill.range && avgFill.range.from === '2026-10-01' && avgFill.range.to === '2026-10-31', avgFill.range);

const countMonth = parseRecordQuestion('how many fills this month?', KE);
check('count question parses', countMonth.kind === 'count' && countMonth.range.from === '2026-11-01', countMonth.range);

const earningsMonth = parseRecordQuestion('my earnings last month', KE);
check('earnings side is recognised', earningsMonth.earning === true, earningsMonth.earning);
check('earnings keep the month window', earningsMonth.range && earningsMonth.range.from === '2026-10-01' && earningsMonth.range.to === '2026-10-31', earningsMonth.range);

const parkingDay = parseRecordQuestion('how much did I spend on parking yesterday?', KE);
check('parking type resolves', parkingDay.expenseTypes.includes('Parking'), parkingDay.expenseTypes);

check('a log command is never a records question', parseRecordQuestion('log fuel 2000', KE).ok === false);
check('empty text never parses', parseRecordQuestion('', KE).ok === false);
check('small talk never parses', parseRecordQuestion('hi saka', KE).ok === false);
check('an explicit plate is captured', parseRecordQuestion('how much did KDA 123A spend last week?', KE).vehiclePlate === 'KDA123A');

console.log('=== v1.58.6 - log-vs-query disambiguation (live 2026-11-04) ===');
check('a past-tense repair statement is a LOG, not a query', parseRecordQuestion('Repaired a puncture for kas 628t @367600km. Puncture repair cost me 300kes. Repair done at lower kabete', KE).reason === 'looks-like-log');
check('"Log this; ..." is a LOG', parseRecordQuestion('Log this; today i Repaired a puncture for kas 628t @367600km. 300kes', KE).ok === false);
check('"I fuelled X 3000kes" is a LOG, not a query', parseRecordQuestion('I fuelled KAS today with 3000kes worth of fuel @222kes/liter', KE).reason === 'looks-like-log');
check('"Pull fuel records for X" is a records query', (() => { const q = parseRecordQuestion('Pull fuel records for KBJ 819C', KE); return q.ok === true && q.kind === 'list' && q.expenseTypes.includes('Fuel') && q.vehiclePlate === 'KBJ819C'; })());
check('"Fuel entries for X" is a records query', parseRecordQuestion('Fuel entries for kas', KE).ok === true);
check('"List KAS entries" is a records query', parseRecordQuestion('List KAS entries', KE).ok === true);
check('"how much did I spend on fuel" stays a query', parseRecordQuestion('how much did I spend on fuel last week', KE).ok === true);
check('looksLikeLogStatement true for a repair+amount', looksLikeLogStatement('Repaired a puncture, cost me 300kes') === true);
check('looksLikeLogStatement false for a question', looksLikeLogStatement('how much did I spend on repairs') === false);

console.log('=== Record answers: date ranges (country-resolved) ===');
check('last week trailing window', resolveDateRange('last week', KE).from === '2026-10-26');
check('last month calendar window', resolveDateRange('last month', KE).to === '2026-10-31');
check('last 3 months from the 1st', resolveDateRange('last 3 months', KE).from === '2026-09-01');
check('explicit endpoints', resolveDateRange('from 1 Oct to 15 Oct', KE).to === '2026-10-15');
check('a future end clamps to today', resolveDateRange('from 20 Oct to 20 Nov', KE).to === '2026-11-01');
const usRange = resolveDateRange('03/04 to 05/04', { countryCode: 'US', locale: 'en-US', now: NOW });
const keRange = resolveDateRange('03/04 to 05/04', KE);
check('MM/DD for the USA', usRange.from === '2026-03-04' && usRange.to === '2026-05-04', usRange);
check('DD/MM for Kenya', keRange.from === '2026-04-03' && keRange.to === '2026-04-05', keRange);


console.log('=== Record answers: deterministic rendering ===');
const COPY = { currency: 'KES', locale: 'en-KE' };
const totalReply = formatRecordAnswer(
  { ok: true, rows: [], count: 3, total: 10300, liters: 40, average: 0, amountCol: 'amount' },
  { kind: 'total', earning: false, expenseTypes: ['Fuel'], range: { label: '26 Oct – 01 Nov' } },
  { vehicles: [], ...COPY }
);
check('total answer carries the localized figure', /Ksh/.test(totalReply) && /10,300/.test(totalReply), totalReply);
check('total answer carries the period', /26 Oct/.test(totalReply));

const avgReply = formatRecordAnswer(
  { ok: true, rows: [], count: 2, total: 9000, liters: 0, average: 4500, amountCol: 'amount' },
  { kind: 'average', earning: false, expenseTypes: [], range: { label: '31 Oct' } },
  { vehicles: [], ...COPY }
);
check('average answer shows average, records and total', /4,500/.test(avgReply) && /Records: 2/.test(avgReply) && /9,000/.test(avgReply), avgReply);

const listReply = formatRecordAnswer(
  {
    ok: true,
    rows: [{ amount: 5500, expense_type: 'Fuel', created_at: '2026-10-31T12:00:00+03:00', fuel_liters: 40 }],
    count: 1, total: 5500, liters: 40, average: 5500, amountCol: 'amount'
  },
  { kind: 'list', earning: false, expenseTypes: [], range: { label: '31 Oct' } },
  { vehicles: [], ...COPY }
);
check('list answer shows type and day', /Fuel/.test(listReply) && /31 Oct/.test(listReply), listReply);

const emptyReply = formatRecordAnswer(
  { ok: true, rows: [], count: 0, total: 0, liters: 0, average: 0, amountCol: 'amount' },
  { kind: 'total', earning: false, expenseTypes: [], range: { label: '31 Oct' } },
  { vehicles: [], ...COPY }
);
check('no records is stated plainly', /Nothing logged/.test(emptyReply), emptyReply);

// v1.56.1 — the empty typed answer must name a noun ("no other expenses"), not
// the broken "no other all time" seen live on 2026-11-03.
const otherEmpty = formatRecordAnswer(
  { ok: true, rows: [], count: 0, total: 0, liters: 0, average: 0, amountCol: 'amount' },
  { kind: 'total', earning: false, expenseTypes: ['Other'], range: null },
  { vehicles: [], ...COPY }
);
check('an empty typed answer names a noun (no "no other all time")', /no other expenses all time/.test(otherEmpty) && !/no other all time/.test(otherEmpty), otherEmpty);

const fleetReply = formatRecordAnswer(
  { ok: true, rows: [], count: 1, total: 500, liters: 0, average: 500, amountCol: 'amount' },
  { kind: 'total', earning: false, expenseTypes: [], range: null },
  { vehicles: [{}, {}], ...COPY }
);
check('a multi-vehicle answer states the scope', /Across your 2 vehicles/.test(fleetReply), fleetReply);


console.log('=== Record answers: live ledger round-trip ===');
const OWNER_PHONE = '+254733444555';
const TEST_VIN = 'RECORDV3601234567';

async function runLive() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log('⚠️ Supabase credentials missing — live round-trip skipped.');
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: owner, error: ownerErr } = await supabase.from('profiles').insert([{
    id: crypto.randomUUID(), phone_number: OWNER_PHONE, full_name: 'Records Owner', is_active: true
  }]).select().single();
  check('live: profile seeded', !ownerErr && Boolean(owner), ownerErr?.message);
  const { data: vehicle, error: vehErr } = await supabase.from('vehicles').insert([{
    id: crypto.randomUUID(), owner_id: owner.id, owner_phone: OWNER_PHONE, plate_number: 'REC 360Y',
    make_model: 'Mazda Demio', yom: 2020, fuel_type: 'Petrol', current_mileage: 50000,
    odometer_reading: 50000, vin: TEST_VIN, status: 'ACTIVE'
  }]).select().single();
  check('live: vehicle seeded', !vehErr && Boolean(vehicle), vehErr?.message);

  const today = formatNairobiDate(new Date());
  const daysAgo = (n) => {
    const d = new Date(`${today}T12:00:00+03:00`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString();
  };
  const rows = [
    { vehicle_id: vehicle.id, driver_id: owner.id, expense_type: 'Fuel', amount: 5500, fuel_liters: 40, created_at: daysAgo(1) },
    { vehicle_id: vehicle.id, driver_id: owner.id, expense_type: 'Parking', amount: 300, created_at: daysAgo(1) },
    { vehicle_id: vehicle.id, driver_id: owner.id, expense_type: 'Fuel', amount: 4500, fuel_liters: 35, created_at: daysAgo(10) }
  ];
  const { error: seedErr } = await supabase.from('expense_logs').insert(rows);
  check('live: ledger rows seeded', !seedErr, seedErr?.message);

  const yesterday = daysAgo(1).slice(0, 10);
  const yesterdayTotal = await queryRecordLedger(supabase, {
    ownerId: owner.id, vehicleIds: [vehicle.id],
    question: { earning: false, expenseTypes: [], range: { from: yesterday, to: yesterday } }
  });
  check('live: yesterday total is exact', yesterdayTotal.ok && yesterdayTotal.count === 2 && yesterdayTotal.total === 5800, yesterdayTotal);

  const fuelYesterday = await queryRecordLedger(supabase, {
    ownerId: owner.id, vehicleIds: [vehicle.id],
    question: { earning: false, expenseTypes: ['Fuel'], range: { from: yesterday, to: yesterday } }
  });
  check('live: fuel-only filter', fuelYesterday.ok && fuelYesterday.count === 1 && fuelYesterday.total === 5500 && fuelYesterday.liters === 40, fuelYesterday);

  const lastWeek = await queryRecordLedger(supabase, {
    ownerId: owner.id, vehicleIds: [vehicle.id],
    question: { earning: false, expenseTypes: [], range: { from: daysAgo(6).slice(0, 10), to: today } }
  });
  check('live: trailing week excludes the old row', lastWeek.count === 2 && lastWeek.total === 5800, lastWeek);

  const answer = formatRecordAnswer(fuelYesterday, { kind: 'total', earning: false, expenseTypes: ['Fuel'], range: { label: 'yesterday' } }, { vehicles: [vehicle], currency: 'KES', locale: 'en-KE' });
  check('live: formatted answer names the amount', /5,500/.test(answer) && /Fuel/.test(answer), answer);
  console.log('✅ Live record-answers round-trip complete.');
}

runWithCleanup({
  testFn: async () => {
    await runLive();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
    else console.log(`✅ ALL RECORD ANSWERS TESTS PASSED (${pass} assertions).`);
  },
  phones: [OWNER_PHONE],
  vins: [TEST_VIN]
}).catch((err) => {
  console.error('\n❌ Test suite failed:', err.message);
  process.exit(1);
});
