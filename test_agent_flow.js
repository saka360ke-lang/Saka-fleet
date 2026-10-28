import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();
import { classifyIntentWithRegex, extractVehicleAttributes } from './sakaAi.js';
import { calculateFuelConsumption } from './src/services/analytics.js';
import { findVehicleByCandidate, getActiveVehicle, setActiveVehicle } from './src/services/vehicles.js';
import { handleWhatsAppWebhook, chatSessions, onboardingStore } from './src/routes/whatsapp.js';
import { createClient } from '@supabase/supabase-js';

async function runAgentFlowTests() {
  console.log('=== STARTING SAKA AGENT & VEHICLE CONTEXT TESTS ===\n');

  // Test 1: Query & Switch Intent Classification
  console.log('--- Test 1: Query & Vehicle Switching Intent Classification ---');
  
  const fuelQuery = classifyIntentWithRegex('give me an analysis of fuel consumption in km/l for vehicle number plate KDA 123A');
  console.log('Fuel Query Intent:', fuelQuery.intent, 'Plate:', fuelQuery.extracted_data?.plate_number);
  if (fuelQuery.intent !== 'QUERY_FUEL_EFFICIENCY') throw new Error('Expected QUERY_FUEL_EFFICIENCY');
  if (fuelQuery.extracted_data?.plate_number !== 'KDA 123A') throw new Error('Expected plate KDA 123A extracted');

  const switchQuery = classifyIntentWithRegex('switch to Demio');
  console.log('Switch Query Intent:', switchQuery.intent, 'Target:', switchQuery.extracted_data?.target_vehicle);
  if (switchQuery.intent !== 'SWITCH_VEHICLE') throw new Error('Expected SWITCH_VEHICLE');
  if (switchQuery.extracted_data?.target_vehicle !== 'Demio') throw new Error('Expected target Demio');

  const fuelLitersExtract = extractVehicleAttributes('Logged 45L fuel at 368000 km for KES 8500');
  console.log('Extracted Attributes:', fuelLitersExtract);
  if (fuelLitersExtract.fuel_liters !== 45) throw new Error('Expected 45 liters extracted');
  if (fuelLitersExtract.current_mileage !== 368000) throw new Error('Expected 368000 odometer extracted');
  if (fuelLitersExtract.amount !== 8500) throw new Error('Expected 8500 amount extracted');

  // Test 2: Active Vehicle Selection & Switching Logic
  console.log('\n--- Test 2: Active Vehicle Selection & Switching Logic ---');
  const mockVehicles = [
    { id: 'v-1', plate_number: 'KDA 123A', make_model: 'Toyota Land Cruiser 80 Series', fuel_type: 'Diesel', current_mileage: 366700 },
    { id: 'v-2', plate_number: 'KBC 456X', make_model: 'Mazda Demio', fuel_type: 'Petrol', current_mileage: 45000 }
  ];
  const testPhone = '254712345000';
  chatSessions.set(testPhone, { history: [], lastActive: Date.now() });

  const defaultVeh = getActiveVehicle({ senderPhone: testPhone, vehicles: mockVehicles, chatSessions });
  console.log('Default Active Vehicle:', defaultVeh.plate_number);
  if (defaultVeh.id !== 'v-1') throw new Error('Expected default to be v-1');

  const demioMatch = findVehicleByCandidate(mockVehicles, 'Demio');
  console.log('Found candidate "Demio":', demioMatch?.plate_number);
  if (!demioMatch || demioMatch.id !== 'v-2') throw new Error('Expected candidate match for Demio');

  setActiveVehicle({ senderPhone: testPhone, vehicleId: demioMatch.id, chatSessions });
  const newActiveVeh = getActiveVehicle({ senderPhone: testPhone, vehicles: mockVehicles, chatSessions });
  console.log('New Active Vehicle after switch:', newActiveVeh.plate_number);
  if (newActiveVeh.id !== 'v-2') throw new Error('Expected active vehicle to be v-2 (KBC 456X)');

  // Test 3: Fuel Consumption Background Calculation Engine
  console.log('\n--- Test 3: Fuel Consumption Analytics Engine ---');
  const mockSupabase = {
    from: (table) => {
      if (table === 'vehicles') {
        return {
          select: () => ({
            eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { id: 'v-1', plate_number: 'KDA 123A', make_model: 'Toyota Land Cruiser', unit_system: 'metric' } }) }) }),
            is: async () => ({ data: [{ id: 'v-1', plate_number: 'KDA 123A', make_model: 'Toyota Land Cruiser', unit_system: 'metric' }] })
          })
        };
      }
      if (table === 'expense_logs') {
        return {
          select: () => ({
            eq: () => ({
              ilike: () => ({
                order: () => ({
                  limit: async () => ({
                    data: [
                      { id: 'e-2', fuel_liters: 40, amount: 7200, odometer_reading: 367200, created_at: '2026-10-15T10:00:00Z' },
                      { id: 'e-1', fuel_liters: 45, amount: 8100, odometer_reading: 366750, created_at: '2026-10-01T10:00:00Z' }
                    ]
                  })
                })
              })
            })
          })
        };
      }
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [] }) }) }) };
    }
  };

  const calculated = await calculateFuelConsumption({
    supabase: mockSupabase,
    vehicleId: 'v-1',
    plateNumber: 'KDA 123A'
  });

  console.log('Calculation Status:', calculated.status);
  console.log('km/L Result:', calculated.metrics?.kmPerLiter);
  if (calculated.status !== 'CALCULATED') throw new Error('Expected status CALCULATED');
  // (367200 - 366750) = 450 km / 40 L = 11.25 km/L
  if (calculated.metrics?.kmPerLiter !== 11.25) {
    throw new Error(`Expected 11.25 km/L, got ${calculated.metrics?.kmPerLiter}`);
  }

  // Test 4: Single Fill-up (Needs More Data) Scenario
  console.log('\n--- Test 4: Single Fill-up Handling ---');
  const mockSupabaseSingle = {
    from: (table) => {
      if (table === 'vehicles') {
        return {
          select: () => ({
            eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { id: 'v-1', plate_number: 'KDA 123A', make_model: 'Toyota Land Cruiser' } }) }) })
          })
        };
      }
      if (table === 'expense_logs') {
        return {
          select: () => ({
            eq: () => ({
              ilike: () => ({
                order: () => ({
                  limit: async () => ({
                    data: [
                      { id: 'e-1', fuel_liters: 45, amount: 8100, odometer_reading: 366750, created_at: '2026-10-01T10:00:00Z' }
                    ]
                  })
                })
              })
            })
          })
        };
      }
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [] }) }) }) };
    }
  };

  const singleCalc = await calculateFuelConsumption({ supabase: mockSupabaseSingle, vehicleId: 'v-1' });
  console.log('Single Log Status:', singleCalc.status);
  console.log('Explanation Snippet:\n' + singleCalc.explanation.slice(0, 160) + '...\n');
  if (singleCalc.status !== 'NEEDS_MORE_DATA') throw new Error('Expected NEEDS_MORE_DATA for single fill-up');

  // Test 5: End-to-End WhatsApp Webhook Simulation with Multiple Vehicles
  console.log('--- Test 5: End-to-End Webhook Switching & Explicit Attribution ---');
  const userPhone = '254799000111';
  onboardingStore.delete(userPhone);

  const realSupabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

  if (realSupabase) {
    await realSupabase.from('vehicles').delete().in('owner_phone', ['+254799000111', '254799000111']);
    await realSupabase.from('profiles').delete().in('phone_number', ['+254799000111', '254799000111']);

    const { data: profile, error: profErr } = await realSupabase.from('profiles').insert([{
      id: crypto.randomUUID(),
      phone_number: '+254799000111',
      full_name: 'Fleet Manager',
      is_active: true
    }]).select().maybeSingle();

    if (profErr) {
      console.error('Profile Insert Error:', profErr);
    }

    const { data: veh1 } = await realSupabase.from('vehicles').insert([{
      id: crypto.randomUUID(),
      owner_id: profile.id,
      owner_phone: '+254799000111',
      plate_number: 'KDA 777A',
      make_model: 'Toyota Land Cruiser',
      fuel_type: 'Diesel',
      current_mileage: 300000,
      vin: 'JTE777A1234567890'
    }]).select().single();

    const { data: veh2 } = await realSupabase.from('vehicles').insert([{
      id: crypto.randomUUID(),
      owner_id: profile.id,
      owner_phone: '+254799000111',
      plate_number: 'KBC 888B',
      make_model: 'Mazda Demio',
      fuel_type: 'Petrol',
      current_mileage: 50000,
      vin: 'JTE888B1234567890'
    }]).select().single();

    await realSupabase.from('expense_logs').insert([
      {
        vehicle_id: veh1.id,
        expense_type: 'Fuel',
        amount: 8000,
        fuel_liters: 45,
        odometer_reading: 300000,
        created_at: new Date(Date.now() - 7 * 86400000).toISOString()
      },
      {
        vehicle_id: veh1.id,
        expense_type: 'Fuel',
        amount: 8500,
        fuel_liters: 40,
        odometer_reading: 300480,
        created_at: new Date().toISOString()
      }
    ]);

    const mockFastify = { log: { info: () => {}, warn: () => {}, error: console.error } };
    function makeReqReply(bodyText) {
      const rawBody = {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { messages: [{ from: userPhone, text: { body: bodyText } }] } }] }]
      };
      const rawBodyStr = JSON.stringify(rawBody);
      const signature = process.env.META_APP_SECRET 
        ? 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBodyStr).digest('hex')
        : undefined;

      const req = {
        headers: signature ? { 'x-hub-signature-256': signature } : {},
        body: rawBody,
        rawBody: rawBodyStr
      };
      const reply = { status: () => reply, send: (d) => { reply.data = d; return reply; } };
      return { req, reply };
    }

    // Step A: Ask for fuel consumption analysis for KDA 777A
    console.log('Sending: "give me an analysis of fuel consumption in km/l for vehicle number plate KDA 777A"');
    const stepA = makeReqReply('give me an analysis of fuel consumption in km/l for vehicle number plate KDA 777A');
    await handleWhatsAppWebhook(stepA.req, stepA.reply, mockFastify);
    const sessionA = chatSessions.get(userPhone);
    const lastReplyA = sessionA?.history[sessionA.history.length - 1]?.parts[0]?.text || '';
    console.log('Saka Reply Snippet:\n' + lastReplyA.slice(0, 200) + '...\n');
    if (!lastReplyA.includes('Fuel Efficiency') && !lastReplyA.includes('km/L') && !lastReplyA.includes('KDA 777A')) {
      throw new Error('Expected fuel consumption analysis reply with km/L for KDA 777A');
    }

    // Step B: Switch vehicle to KBC 888B
    console.log('Sending: "switch to KBC 888B"');
    const stepB = makeReqReply('switch to KBC 888B');
    await handleWhatsAppWebhook(stepB.req, stepB.reply, mockFastify);
    const sessionB = chatSessions.get(userPhone);
    const lastReplyB = sessionB?.history[sessionB.history.length - 1]?.parts[0]?.text || '';
    console.log('Saka Switch Reply:\n' + lastReplyB + '\n');
    if (!lastReplyB.includes('KBC 888B') || !lastReplyB.includes('Switched Active Vehicle')) {
      throw new Error('Expected active vehicle switch confirmation for KBC 888B');
    }

    // Step C: Log fuel for the currently active vehicle
    console.log('Sending: "Logged 30L fuel at 50350 km for KES 5500"');
    const stepC = makeReqReply('Logged 30L fuel at 50350 km for KES 5500');
    await handleWhatsAppWebhook(stepC.req, stepC.reply, mockFastify);
    const sessionC = chatSessions.get(userPhone);
    const lastReplyC = sessionC?.history[sessionC.history.length - 1]?.parts[0]?.text || '';
    console.log('Saka Log Reply:\n' + lastReplyC + '\n');
    if (!lastReplyC.includes('KBC 888B') || !lastReplyC.includes('Expense Logged Successfully')) {
      throw new Error('Expected data to be saved explicitly under KBC 888B');
    }

    // Cleanup
    await realSupabase.from('expense_logs').delete().in('vehicle_id', [veh1.id, veh2.id]);
    await realSupabase.from('vehicles').delete().in('id', [veh1.id, veh2.id]);
    await realSupabase.from('profiles').delete().eq('id', profile.id);
  }

  console.log('\n✅ Core unit tests passed!');
}

runAgentFlowTests().catch(err => {
  console.error('\n❌ Test Failure:', err);
  process.exit(1);
});
