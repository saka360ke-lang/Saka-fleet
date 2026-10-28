import dotenv from 'dotenv';
dotenv.config();
import { classifyIntentWithRegex } from './sakaAi.js';
import { buildFirstTimeWelcome, generateRoleBasedActionDiscovery } from './src/routes/whatsapp.js';

async function runFirstTimeFlowTests() {
  console.log('=== STARTING FIRST-TIME USER CONVERSATIONAL FLOW TESTS ===\n');

  // Test 1: First-time welcome is a numbered, step-by-step guide with recovery affordances.
  console.log('--- Test 1: First-Time Welcome Guide ---');
  const welcome = buildFirstTimeWelcome();
  console.log(welcome);
  const requiredTokens = [
    'Welcome to Saka Fleet!',
    '1️⃣', '2️⃣', '3️⃣', '4️⃣',
    'Help', 'What can I do?', 'Restart', 'Cancel', 'ACCEPT'
  ];
  for (const token of requiredTokens) {
    if (!welcome.includes(token)) throw new Error(`First-time welcome missing token: ${token}`);
  }
  if (welcome.includes('1️⃣ Log Expense')) {
    throw new Error('First-time welcome must NOT dump the active workspace menu');
  }
  console.log('\n✅ First-time welcome is a clear, numbered, progressive guide.\n');

  // Test 2: Swahili greeting variant keeps the same progressive structure.
  console.log('--- Test 2: Swahili First-Time Guide ---');
  const swahiliWelcome = buildFirstTimeWelcome({ swahili: true });
  if (!swahiliWelcome.includes('Habari') || !swahiliWelcome.includes('Karibu')) {
    throw new Error('Swahili welcome missing Habari/Karibu opener');
  }
  if (!swahiliWelcome.includes('Your First-Time Setup')) {
    throw new Error('Swahili welcome missing the progressive setup guide');
  }
  console.log('✅ Swahili first-time guide verified.\n');

  // Test 3: Unregistered role discovery reuses the exact same shared guide.
  console.log('--- Test 3: Unregistered Action Discovery ---');
  const unregistered = generateRoleBasedActionDiscovery({
    profileData: { id: 'p1' },
    vehicles: [],
    senderPhone: '+254700000000',
    targetVeh: null
  });
  if (unregistered !== buildFirstTimeWelcome({ senderPhone: '+254700000000' })) {
    throw new Error('Unregistered action discovery should equal the shared first-time welcome for the sender region');
  }
  console.log('✅ Unregistered "What can I do?" uses the shared first-time guide.\n');

  // Test 4: Both "Help" and "What can I do?" resolve to role discovery intents.
  console.log('--- Test 4: Help & Action Discovery Intents ---');
  const helpIntent = classifyIntentWithRegex('Help');
  const whatIntent = classifyIntentWithRegex('What can I do?');
  console.log('Help ->', helpIntent.intent, '| What can I do? ->', whatIntent.intent);
  if (helpIntent.intent !== 'APP_HELP') throw new Error('Expected "Help" -> APP_HELP');
  if (whatIntent.intent !== 'ACTION_DISCOVERY') throw new Error('Expected "What can I do?" -> ACTION_DISCOVERY');
  console.log('✅ Both Help and What can I do? are classified for role discovery.\n');

  // Test 5: Owner discovery still surfaces owner tools (no regression).
  console.log('--- Test 5: Owner Role Discovery ---');
  const owner = generateRoleBasedActionDiscovery({
    profileData: { id: 'o1' },
    vehicles: [{ id: 'v1', owner_id: 'o1', assigned_driver_id: null, plate_number: 'KDA 123A' }],
    senderPhone: '+254700000001',
    targetVeh: { plate_number: 'KDA 123A' }
  });
  if (!owner.includes('Owner Command Center') || !owner.includes('transfer passbook')) {
    throw new Error('Owner discovery missing fleet / passbook tools');
  }
  console.log('✅ Owner discovery includes fleet, passbook transfer & reports.\n');

  // Test 6: Driver discovery stays restricted (no passbook transfer).
  console.log('--- Test 6: Driver Role Discovery ---');
  const driver = generateRoleBasedActionDiscovery({
    profileData: { id: 'd1' },
    vehicles: [{ id: 'v2', owner_id: 'o1', assigned_driver_id: 'd1', plate_number: 'KBC 456X' }],
    senderPhone: '+254700000002',
    targetVeh: { plate_number: 'KBC 456X' }
  });
  if (!driver.includes('Driver Hub') || !driver.includes('Odometer') || driver.includes('transfer passbook')) {
    throw new Error('Driver discovery must include odometer/logs and exclude passbook transfer');
  }
  console.log('✅ Driver discovery enforces role boundaries.\n');

  console.log('=== ALL FIRST-TIME CONVERSATIONAL FLOW TESTS PASSED ===');
}

runFirstTimeFlowTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
