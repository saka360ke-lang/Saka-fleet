import assert from 'assert';
import {
  analyzeFuelEconomy,
  buildFuelEconomyReply,
  formatEconomy,
  inferFillTypeFromNotes,
  kmPerLiterToMpg,
  normalizeFillType,
  rateEconomy
} from './src/services/fuelEconomy.js';

/**
 * Saka Fleet — Fuel Economy Engine tests (v1.17.1). Stateless: pure math only.
 * Run: node scripts/run_tests.js test_fuel_economy.js
 */

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log(`  ✅ ${message}`);
}

function log(date, odometer, litres, fillType, amount = litres * 180, extra = {}) {
  return {
    id: `${date}-${odometer}`,
    created_at: `${date}T08:00:00.000Z`,
    odometer_reading: odometer,
    fuel_liters: litres,
    fill_type: fillType,
    amount,
    ...extra
  };
}

console.log('=== SAKA FLEET — FUEL ECONOMY ENGINE TESTS (v1.17.1) ===\n');

console.log('--- Test 1: full-to-full baseline ---');
const classic = analyzeFuelEconomy({
  logs: [
    log('2026-10-01', 366750, 45, 'full', 8100),
    log('2026-10-15', 367200, 40, 'full', 7200)
  ],
  currency: 'USD'
});
check(classic.status === 'CALCULATED', 'two full fills calculate exactly');
check(classic.latest.kmPerLiter === 11.25, `latest segment = 450 km / 40 L (${classic.latest.kmPerLiter})`);
check(classic.totalLitres === 40, 'the opening full fill is not counted as consumed fuel');
check(classic.averageKmPerLiter === 11.25 && classic.segmentCount === 1, 'average + segment count');
check(classic.costPerKm === 16, `cost per km is engine-owned (${classic.costPerKm})`);
check(classic.confidence === 'exact', 'exact confidence');

console.log('\n--- Test 2: full → top-up → full (the critical fix) ---');
const chained = analyzeFuelEconomy({
  logs: [
    log('2026-10-01', 1000, 40, 'full'),
    log('2026-10-08', 1200, 15, 'partial'),
    log('2026-10-20', 1500, 30, 'full')
  ]
});
check(chained.status === 'CALCULATED', 'top-ups between full fills still produce exact economy');
check(chained.latest.distanceKm === 500, 'segment distance spans both fills');
check(chained.latest.litres === 45, 'top-up litres are added to the closing full fill');
check(chained.latest.kmPerLiter === 11.11, `500 km / 45 L (${chained.latest.kmPerLiter})`);
check(chained.latest.kmPerLiter !== 16.67, 'old engine bug (500/30) is impossible now');

console.log('\n--- Test 3: top-ups only → honest estimate ---');
const estimate = analyzeFuelEconomy({
  logs: [
    log('2026-10-01', 1000, 20, 'partial'),
    log('2026-10-10', 1300, 25, 'partial')
  ]
});
check(estimate.status === 'ESTIMATED' && estimate.confidence === 'estimate', 'no full pair → labelled estimate');
check(estimate.estimate.kmPerLiter === 12, `span estimate = 300 km / 25 L (${estimate.estimate.kmPerLiter})`);
check(estimate.segments.length === 0, 'no full-to-full segments invented');
check(estimate.warnings.some((w) => /span estimate/i.test(w)), 'estimate warning is explicit');

console.log('\n--- Test 4: unclassified fills count as consumed fuel ---');
const unclassified = analyzeFuelEconomy({
  logs: [
    log('2026-10-01', 1000, 40, 'full'),
    log('2026-10-08', 1200, 10, null),
    log('2026-10-20', 1500, 40, 'full')
  ]
});
check(unclassified.latest.kmPerLiter === 10, 'unlabelled intermediate litres are counted (500/50)');
check(unclassified.unclassifiedFills === 1, 'unclassified fill counter');
check(unclassified.warnings.some((w) => /not labelled/i.test(w)), 'user is warned about unlabelled fills');

console.log('\n--- Test 5: full fill without odometer is folded forward ---');
const missingOdo = analyzeFuelEconomy({
  logs: [
    log('2026-10-01', 1000, 40, 'full'),
    log('2026-10-08', null, 20, 'full', 3600, { odometer_reading: null }),
    log('2026-10-20', 2000, 50, 'full')
  ]
});
check(missingOdo.latest.kmPerLiter === 14.29, `1000 km / (50+20) L (${missingOdo.latest.kmPerLiter})`);
check(missingOdo.skipped.some((row) => row.reason === 'full_fill_missing_odometer'), 'skip reason recorded');

console.log('\n--- Test 6: odometer regression is quarantined ---');
const regression = analyzeFuelEconomy({
  logs: [
    log('2026-10-01', 1000, 40, 'full'),
    log('2026-10-10', 900, 35, 'full')
  ]
});
check(regression.status === 'NEEDS_MORE_DATA', 'no economy invented from a backwards odometer');
check(regression.skipped.some((row) => row.reason === 'odometer_regression'), 'regression recorded');
check(regression.warnings.some((w) => /backwards/i.test(w)), 'user warning explains the skip');

console.log('\n--- Test 7: very short intervals are skipped ---');
const shortSegment = analyzeFuelEconomy({
  logs: [
    log('2026-10-01', 1000, 40, 'full'),
    log('2026-10-02', 1010, 10, 'full')
  ]
});
check(shortSegment.status === 'NEEDS_MORE_DATA', '10 km interval produces no economy');
check(shortSegment.skipped.some((row) => row.reason === 'short_segment'), 'short segment recorded');
check(shortSegment.warnings.some((w) => /closer than/i.test(w)), 'minimum-distance warning');

console.log('\n--- Test 8: current tank progress ---');
const currentTank = analyzeFuelEconomy({
  logs: [
    log('2026-10-01', 1000, 40, 'full'),
    log('2026-10-09', 1400, 20, 'partial')
  ]
});
check(currentTank.currentTank?.distanceKm === 400, 'distance since last full is reported');
check(currentTank.currentTank?.litresAdded === 20, 'top-up litres since last full are reported');
check(currentTank.status === 'ESTIMATED', 'single full + top-up stays an estimate');

console.log('\n--- Test 9: units, ratings and conversion ---');
check(formatEconomy(11.25, 'metric') === '11.25 km/L', 'metric display');
check(formatEconomy(11.25, 'imperial') === '26.46 MPG', 'imperial display converts correctly');
check(Math.abs(kmPerLiterToMpg(1) - 2.352145833) < 0.0001, 'MPG constant is exact');
check(rateEconomy(15).key === 'excellent' && rateEconomy(11).key === 'good' && rateEconomy(8).key === 'heavy', 'rating thresholds');

console.log('\n--- Test 10: fill-type normalisation ---');
check(normalizeFillType('Full tank') === 'full', 'full tank → full');
check(normalizeFillType('filled to the top') === 'full', 'brim phrasing → full');
check(normalizeFillType('topped up') === 'partial', 'topped up → partial');
check(normalizeFillType('half tank') === 'partial', 'half tank → partial');
check(normalizeFillType('') === null && normalizeFillType('some mystery text') === null, 'unknown stays null');
check(inferFillTypeFromNotes('Shell, full tank — Nairobi') === 'full', 'legacy notes recover full fills');

console.log('\n--- Test 11: deterministic replies ---');
const exactReply = buildFuelEconomyReply({ plate: 'KDA 123A', model: 'Toyota Hilux', analysis: classic, currency: 'USD' });
check(exactReply.includes('Latest full-to-full') && exactReply.includes('11.25 km/L'), 'exact reply leads with the latest full-to-full rate');
check(exactReply.includes('Average (1 full tank)'), 'segment count is stated');
check(exactReply.includes('$') && !exactReply.includes('KES'), 'currency is respected (no hard-coded KES)');
const estimateReply = buildFuelEconomyReply({ plate: 'KDA 123A', analysis: estimate, currency: 'KES' });
check(estimateReply.includes('estimate') && estimateReply.includes('full tank'), 'estimate reply labels itself and coaches a full fill');
const emptyReply = buildFuelEconomyReply({ plate: 'KDA 123A', analysis: { status: 'NEEDS_MORE_DATA', unitSystem: 'metric' } });
check(emptyReply.includes('full tank') && emptyReply.includes('km/L'), 'no-data reply explains the full-tank rule');

console.log('\n--- Test 12: missing volume is ignored, spend still counted ---');
const missingLitres = analyzeFuelEconomy({
  logs: [
    log('2026-10-01', 1000, 40, 'full'),
    { id: 'bad', created_at: '2026-10-05T08:00:00.000Z', odometer_reading: 1200, fuel_liters: 0, fill_type: 'partial', amount: 500 },
    log('2026-10-20', 1500, 40, 'full')
  ]
});
check(missingLitres.latest.kmPerLiter === 12.5, `zero-litre row does not distort litres (500/40 = ${missingLitres.latest.kmPerLiter})`);
check(missingLitres.skipped.some((row) => row.reason === 'missing_litres'), 'zero-litre reason recorded');
check(missingLitres.totalSpend === 40 * 180 + 500 + 40 * 180, 'spend includes the ignored row');

console.log(`\n🎉 ${passed} fuel-economy assertions passed.`);

