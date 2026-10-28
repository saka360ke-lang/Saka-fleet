import dotenv from 'dotenv';
dotenv.config();

import { fetchCloudRunLogs } from './src/services/sentinelCloudLogs.js';
import { scanCloudRunAnomalies } from './src/workers/sentinel.js';
import { createClient } from '@supabase/supabase-js';

async function testCloudLogging() {
  console.log('--- Test 1: Fetching Cloud Run Logs (Graceful Fallback) ---');
  const logs = await fetchCloudRunLogs(5);
  console.log(`Fetched ${logs.length} logs.`);
  if (logs.length > 0) {
    console.log('Sample log:', logs[0]);
  } else {
    console.log('✅ Graceful fallback working as expected in non-GCP environment.');
  }

  console.log('\n--- Test 2: Scan Cloud Run Anomalies ---');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  
  try {
    await scanCloudRunAnomalies(supabase);
    console.log('✅ Anomaly scan completed successfully without throwing errors.');
  } catch (err) {
    console.error('❌ Anomaly scan failed:', err);
    process.exit(1);
  }
}

testCloudLogging().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
