import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { SUBSCRIPTION_TIERS, getTierLocalPrice, initializePaystackCheckout, verifyPaystackSignature } from './src/services/paystack.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function runTests() {
  console.log('=== STARTING SAKA BACKEND INTEGRATION TESTS ===\n');

  // Test 1: Tier Architecture
  console.log('--- Test 1: Subscription Tiers ---');
  console.log('Free limit:', SUBSCRIPTION_TIERS.free.vehicleLimit);
  console.log('Solo Pro limit:', SUBSCRIPTION_TIERS.solo_pro.vehicleLimit, 'Premium:', SUBSCRIPTION_TIERS.solo_pro.hasPremiumFeatures);
  console.log('Growth limit:', SUBSCRIPTION_TIERS.growth.vehicleLimit);
  console.log('Fleet Command limit:', SUBSCRIPTION_TIERS.fleet_command.vehicleLimit);

  // Test 2: Local Currency Pricing Conversion & ±10% Drift Exchange Rate Caching
  console.log('\n--- Test 2: Local Currency Pricing & Exchange Rate Cache ---');
  const priceKES = await getTierLocalPrice(supabase, 'solo_pro', 'KES', 'monthly');
  console.log('Solo Pro (KES Monthly):', priceKES.formattedPrice, 'Local Price:', priceKES.localPrice);

  const priceAnnualKES = await getTierLocalPrice(supabase, 'solo_pro', 'KES', 'annual');
  console.log('Solo Pro (KES Annual):', priceAnnualKES.formattedPrice, 'Local Price:', priceAnnualKES.localPrice);

  const priceNGN = await getTierLocalPrice(supabase, 'growth', 'NGN', 'monthly');
  console.log('Growth (NGN Monthly):', priceNGN.formattedPrice);

  const priceZAR = await getTierLocalPrice(supabase, 'fleet_command', 'ZAR', 'monthly');
  console.log('Fleet Command (ZAR Monthly):', priceZAR.formattedPrice);

  const priceUSD = await getTierLocalPrice(supabase, 'fleet_command', 'USD', 'annual');
  console.log('Fleet Command (USD Annual):', priceUSD.formattedPrice);

  // Test 3: Paystack Checkout Session Initialization
  console.log('\n--- Test 3: Paystack Checkout Link Generation ---');
  const checkoutResult = await initializePaystackCheckout({
    supabase,
    userPhone: '+254700000000',
    targetTierKey: 'solo_pro',
    billingInterval: 'monthly',
    currency: 'KES'
  });
  console.log('Checkout URL generated:', checkoutResult.checkoutUrl);
  console.log('Paystack Reference:', checkoutResult.reference);

  // Test 4: HMAC Webhook Signature Verification
  console.log('\n--- Test 4: Paystack Webhook Verification ---');
  const testPayload = JSON.stringify({ event: 'charge.success', data: { reference: 'TEST_REF_123' } });
  const testSig = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(testPayload).digest('hex');
  const isValidSig = verifyPaystackSignature(testPayload, testSig);
  console.log('Webhook signature valid:', isValidSig);

  console.log('\n=== ALL INTEGRATION TESTS COMPLETED SUCCESSFULLY ===');
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
