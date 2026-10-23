import dotenv from 'dotenv';
dotenv.config();
import Fastify from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { runHealthCheck, runConversationRefinement, logSystemError, ensureSentinelTables } from './src/workers/sentinel.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function testEndpoint() {
  console.log('=== TESTING /api/sentinel/run FASTIFY ROUTE ===\n');

  const fastify = Fastify({ logger: false });

  // Attach Sentinel Protected Route
  fastify.post('/api/sentinel/run', async (request, reply) => {
    const sentinelSecret = process.env.SENTINEL_SECRET || 'saka_sentinel_secret_2026';
    const authHeader = request.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (request.headers['x-sentinel-secret'] || request.body?.secret);

    if (!token || token !== sentinelSecret) {
      return reply.status(401).send({
        status: 'error',
        error: 'Unauthorized: Invalid or missing SENTINEL_SECRET'
      });
    }

    try {
      const healthCheckResult = await runHealthCheck(supabase);
      const refinementResult = await runConversationRefinement(supabase);

      return reply.status(200).send({
        status: 'success',
        timestamp: new Date().toISOString(),
        actions: {
          health_check: healthCheckResult,
          conversation_refinement: refinementResult
        }
      });
    } catch (err) {
      return reply.status(500).send({
        status: 'error',
        message: 'Sentinel execution failed',
        error: err.message
      });
    }
  });

  // Test 1: Unauthorized call (No token)
  console.log('--- Test 1: POST /api/sentinel/run without Auth ---');
  const res1 = await fastify.inject({
    method: 'POST',
    url: '/api/sentinel/run'
  });
  console.log('Status code:', res1.statusCode);
  console.log('Response payload:', res1.payload);
  if (res1.statusCode !== 401) throw new Error('Expected 401 for unauthorized call');

  // Test 2: Unauthorized call (Wrong token)
  console.log('\n--- Test 2: POST /api/sentinel/run with Invalid Token ---');
  const res2 = await fastify.inject({
    method: 'POST',
    url: '/api/sentinel/run',
    headers: {
      'authorization': 'Bearer WRONG_KEY'
    }
  });
  console.log('Status code:', res2.statusCode);
  console.log('Response payload:', res2.payload);
  if (res2.statusCode !== 401) throw new Error('Expected 401 for invalid token');

  // Test 3: Authorized call (Valid Bearer Token)
  console.log('\n--- Test 3: POST /api/sentinel/run with Valid SENTINEL_SECRET ---');
  const res3 = await fastify.inject({
    method: 'POST',
    url: '/api/sentinel/run',
    headers: {
      'authorization': `Bearer ${process.env.SENTINEL_SECRET || 'saka_sentinel_secret_2026'}`
    }
  });
  console.log('Status code:', res3.statusCode);
  const json3 = JSON.parse(res3.payload);
  console.log('Response JSON actions summary:', {
    status: json3.status,
    health_check_status: json3.actions?.health_check?.status,
    conversation_refinement_status: json3.actions?.conversation_refinement?.status
  });

  if (res3.statusCode !== 200 || json3.status !== 'success') {
    throw new Error('Expected 200 OK and success status for valid token call');
  }

  console.log('\n=== ALL ENDPOINT TESTS PASSED SUCCESSFULLY ===');
}

testEndpoint().catch(err => {
  console.error('Endpoint Test Failed:', err);
  process.exit(1);
});
