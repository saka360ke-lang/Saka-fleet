import dotenv from 'dotenv';
dotenv.config();

import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { handleSuperadminFlow, ensureSuperadminTables } from './src/services/superadmin.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const superadminPhone = process.env.SUPERADMIN_PHONE || '+254720641985';
const metaAppSecret = process.env.META_APP_SECRET || 'meta_app_secret_sakafleet_2026';
const sentinelSecret = process.env.SENTINEL_SECRET || 'saka_sentinel_7333';

async function runSecurityTests() {
  console.log('=== STARTING SAKA FLEET SECURITY HARDENING TESTS ===\n');

  const app = Fastify({ logger: false });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    try {
      req.rawBody = body.toString('utf8');
      done(null, JSON.parse(req.rawBody || '{}'));
    } catch (err) {
      done(err, undefined);
    }
  });

  await app.register(rateLimit, {
    max: 5,
    timeWindow: '1 minute',
    allowList: [],
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Max ${context.max} per ${context.after}`
    })
  });

  app.post('/api/whatsapp/webhook', async (request, reply) => {
    if (metaAppSecret) {
      const signatureHeader = request.headers['x-hub-signature-256'];
      if (!signatureHeader) return reply.status(403).send({ error: 'Missing signature' });

      const rawBody = request.rawBody || JSON.stringify(request.body || {});
      const expectedHash = crypto.createHmac('sha256', metaAppSecret).update(rawBody).digest('hex');
      const providedHash = signatureHeader.replace(/^sha256=/, '');

      let isValid = false;
      if (expectedHash.length === providedHash.length) {
        isValid = crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(providedHash, 'hex'));
      }
      if (!isValid) return reply.status(403).send({ error: 'Invalid signature' });
    }
    return reply.status(200).send({ status: 'EVENT_RECEIVED' });
  });

  app.post('/api/sentinel/run', async (request, reply) => {
    const xSecret = request.headers['x-sentinel-secret'];
    const authHeader = request.headers.authorization;
    const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const providedSecret = xSecret || bearerToken;

    if (!providedSecret || providedSecret !== sentinelSecret) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    return reply.status(200).send({ status: 'success' });
  });

  // Test 1: Meta WhatsApp Signature
  console.log('--- Test 1: Meta WhatsApp Webhook Signature Verification ---');
  const res1a = await app.inject({ method: 'POST', url: '/api/whatsapp/webhook', payload: { test: 1 } });
  if (res1a.statusCode !== 403) throw new Error('Expected 403 for missing signature');

  const res1b = await app.inject({
    method: 'POST',
    url: '/api/whatsapp/webhook',
    headers: { 'x-hub-signature-256': 'sha256=invalid' },
    payload: { test: 1 }
  });
  if (res1b.statusCode !== 403) throw new Error('Expected 403 for invalid signature');

  const validPayload = JSON.stringify({ test: 1 });
  const validSig = crypto.createHmac('sha256', metaAppSecret).update(validPayload).digest('hex');
  const res1c = await app.inject({
    method: 'POST',
    url: '/api/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${validSig}` },
    payload: { test: 1 }
  });
  if (res1c.statusCode !== 200) throw new Error(`Expected 200 for valid signature, got ${res1c.statusCode}`);
  console.log('✅ Meta WhatsApp Webhook signature verification confirmed.\n');

  // Test 2: Sentinel Protection
  console.log('--- Test 2: Sentinel Endpoint Protection ---');
  const res2a = await app.inject({ method: 'POST', url: '/api/sentinel/run' });
  if (res2a.statusCode !== 401) throw new Error('Expected 401 for unauthenticated call');

  const res2b = await app.inject({
    method: 'POST',
    url: '/api/sentinel/run',
    headers: { 'x-sentinel-secret': sentinelSecret }
  });
  if (res2b.statusCode !== 200) throw new Error('Expected 200 for valid x-sentinel-secret header');
  console.log('✅ Sentinel Endpoint Protection confirmed.\n');

  // Test 3 & 4: Superadmin Session TTL (30 min) & Audit Logging
  console.log('--- Test 3 & 4: Superadmin Session TTL (30 min) & Audit Logging ---');
  await ensureSuperadminTables(supabase);
  const formattedAdminPhone = superadminPhone.startsWith('+') ? superadminPhone : `+${superadminPhone}`;
  await handleSuperadminFlow(supabase, formattedAdminPhone, 'adminstart');

  const oldActiveTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  await supabase.from('superadmin_sessions').update({ last_active_at: oldActiveTime }).eq('phone_number', formattedAdminPhone);

  const timeoutRes = await handleSuperadminFlow(supabase, formattedAdminPhone, 'check health');
  if (!timeoutRes.reply.includes('expired due to 30 minutes of inactivity')) {
    throw new Error('30-minute inactivity timeout failed');
  }

  const { data: auditLogs } = await supabase.from('admin_audit_logs').select('*').eq('admin_phone', superadminPhone).order('created_at', { ascending: false }).limit(5);
  if (!auditLogs?.some(l => l.action === 'SESSION_TIMEOUT')) {
    throw new Error('Missing SESSION_TIMEOUT audit log');
  }
  console.log('✅ Superadmin 30-min session TTL & Audit Logging confirmed.\n');

  // Test 5: Fastify Rate Limiting
  console.log('--- Test 5: Fastify Rate Limiting ---');
  let rateLimited = false;
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/sentinel/run', headers: { 'x-sentinel-secret': sentinelSecret } });
    if (res.statusCode === 429) {
      rateLimited = true;
      console.log(`Rate limit 429 triggered on request #${i + 1}.`);
      break;
    }
  }
  if (!rateLimited) throw new Error('Rate limiter failed to trigger 429 status code!');
  console.log('✅ Fastify Rate Limiting confirmed.\n');

  console.log('🎉 ALL SECURITY HARDENING TESTS PASSED SUCCESSFULLY!');
}
runSecurityTests().catch(err => {
  console.error('❌ Security Hardening Test Failed:', err);
  process.exit(1);
});
