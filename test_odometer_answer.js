import assert from 'assert';
import { isOdometerQuestion, buildOdometerAnswer } from './src/services/odometerAnswer.js';

/**
 * Saka Fleet — current odometer/mileage answers (v1.56.0). Stateless.
 * The reading comes from the VEHICLE record, never the expense ledger.
 */

let passed = 0;
function check(cond, msg) { assert(cond, msg); passed += 1; console.log(`  ✅ ${msg}`); }

console.log('=== SAKA FLEET — ODOMETER ANSWER TESTS (v1.56.0) ===\n');

check(isOdometerQuestion('What is the current mileage?') === true, 'current mileage question detected');
check(isOdometerQuestion('What is the current Odo reading') === true, 'current odometer reading detected');
check(isOdometerQuestion('Show me last odometer update for kas') === true, 'last odometer update detected');
check(isOdometerQuestion('how many km does it have now') === true, 'how many km detected');
check(isOdometerQuestion('Update my odometer to 367000') === false, 'a write command is not a read question');
check(isOdometerQuestion('Log 40L at 367360km') === false, 'a fuel log is not a read question');
check(isOdometerQuestion('my entries') === false, 'a ledger list is not an odometer question');

const vehicleAnswer = buildOdometerAnswer({ plate_number: 'KAS628T', current_mileage: 367410, asset_kind: 'vehicle' });
check(vehicleAnswer.includes('KAS628T') && vehicleAnswer.includes('367,410 km'), 'the vehicle odometer is answered exactly');
const hoursAnswer = buildOdometerAnswer({ plate_number: 'GEN-1', asset_kind: 'generator', operating_hours: 1240 });
check(hoursAnswer.includes('1,240 h'), 'hours-led assets answer with the meter reading');
check(buildOdometerAnswer(null).includes('No vehicle'), 'no vehicle gets an honest next step');
check(buildOdometerAnswer({ plate_number: 'X', current_mileage: 0 }).includes('no odometer reading on file'), 'a missing reading is stated honestly');

console.log(`\n🎉 ${passed} odometer-answer assertions passed.`);