import dotenv from 'dotenv';
dotenv.config();

import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { handleSuperadminFlow, ensureSuperadminTables } from './src/services/superadmin.js';
// v1.90.0 (Phase 28B) — the hardened seams (all stateless; no DB rows created).
import { csvCell, serializeRecordsCsv, serializeAllDataCsv } from './src/services/dashboard.js';
import { createMockSupabase } from './scripts/mockSupabase.js';
import { buildErrorHandler, GENERIC_ERROR_MESSAGE } from './src/services/errorHandler.js';
import { securityHeadersHook, HSTS_HEADER_VALUE } from './src/services/securityHeaders.js';
import { rightmostClientIp, rateLimitKeyGenerator } from './src/services/rateLimitIdentity.js';

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

  console.log('--- Test 6: CSV formula-injection guard (v1.90.0) ---');
  if (csvCell('=1+2') !== "'=1+2") throw new Error('= cells must be prefixed');
  if (!csvCell('=HYPERLINK("http://x","y")').startsWith(`'"=HYPERLINK`)) throw new Error('quoted formulas must be prefixed after quoting');
  if (csvCell('+254712345678') !== "'+254712345678") throw new Error('+ labels must be prefixed');
  if (csvCell('@SUM(A1:A2)') !== "'@SUM(A1:A2)") throw new Error('@ cells must be prefixed');
  if (csvCell('\tcmd') !== "'\tcmd") throw new Error('TAB cells must be prefixed');
  if (csvCell('3000') !== '3000' || csvCell(-500) !== '-500' || csvCell('-500.50') !== '-500.50') throw new Error('numbers (plain or negative) must stay numeric');
  if (csvCell('Fuel top-up') !== 'Fuel top-up' || csvCell(null) !== '') throw new Error('ordinary text and empty cells must be untouched');
  const recordsCsv = serializeRecordsCsv([{
    at: '2026-11-09T10:00:00Z', kind: 'expense', vehicle: 'KAS 628T', typeLabel: 'Fuel',
    description: '=HYPERLINK("http://evil.example","open")', meter: 50350, unitCost: 1.5, amount: 3000, label: '+254712345678'
  }], { currency: 'KES' });
  if (!recordsCsv.includes(`'"=HYPERLINK`)) throw new Error('serializeRecordsCsv must prefix a formula description');
  if (!recordsCsv.includes(`'+254712345678`)) throw new Error('serializeRecordsCsv must prefix a phone-shaped label');
  if (!recordsCsv.includes(',3000,') || !recordsCsv.includes(',50350,')) throw new Error('amount/odometer must stay numeric');
  const csvMock = createMockSupabase({
    profiles: [{ id: 'csv-owner', phone_number: '+254700111222' }],
    vehicles: [{ id: 'csv-veh', owner_id: 'csv-owner', plate_number: '@SUM(A1:A2)', deleted_at: null }],
    expense_logs: [{ id: 'csv-exp-1', vehicle_id: 'csv-veh', owner_id: 'csv-owner', expense_type: 'fuel', amount: 3000, currency: 'KES', notes: '=HYPERLINK("http://evil.example","open")', created_at: '2026-11-09T10:00:00Z' }],
    private_earnings: [], reminders: [], vehicle_compliances: [], driver_compliances: [], receipts: []
  });
  const allCsv = await serializeAllDataCsv({ supabase: csvMock.client, ownerId: 'csv-owner', currency: 'KES' });
  if (!allCsv.includes(`'@SUM(A1:A2)`) || !allCsv.includes(`'"=HYPERLINK`) || !allCsv.includes(',3000,')) throw new Error('serializeAllDataCsv must neutralise formulas and keep numbers');
  console.log('✅ CSV formula injection neutralised; numbers untouched.');

  console.log('--- Test 7: the global error handler hides internals (v1.90.0) ---');
  const handlerEvents = [];
  let handlerReply = null;
  const fakeReply = { code: 200, status(code) { this.code = code; return this; }, send(payload) { handlerReply = { code: this.code, payload }; return this; } };
  const handler = buildErrorHandler({
    supabase: {},
    log: { error: (err) => handlerEvents.push({ kind: 'log', err }) },
    logSystemError: async (_sb, err, route) => { handlerEvents.push({ kind: 'system', err, route }); }
  });
  const internalError = new Error('relation "profiles" does not exist at character 42');
  internalError.name = 'ValidationError';
  internalError.statusCode = 400;
  await handler(internalError, { raw: { url: '/api/demo?x=1' } }, fakeReply);
  if (handlerReply?.code !== 400 || handlerReply?.payload?.error !== 'ValidationError') throw new Error('status + name must be preserved');
  if (handlerReply?.payload?.message !== GENERIC_ERROR_MESSAGE) throw new Error('the client must receive the generic message');
  if (JSON.stringify(handlerReply.payload).includes('does not exist')) throw new Error('internal detail leaked');
  if (!handlerEvents.some((e) => e.kind === 'log') || !handlerEvents.some((e) => e.kind === 'system' && e.route === '/api/demo?x=1')) throw new Error('logging must stay intact');
  handlerReply = null;
  await handler(new Error('plain failure'), { raw: { url: '/api/plain' } }, fakeReply);
  if (handlerReply?.code !== 500) throw new Error('unknown failures must answer 500');
  const errApp = Fastify({ logger: false });
  let systemCalls = 0;
  errApp.setErrorHandler(buildErrorHandler({ supabase: {}, log: { error: () => {} }, logSystemError: async () => { systemCalls += 1; } }));
  errApp.get('/boom', async () => { const boom = new Error('column expenses.odometer_reading does not exist'); boom.statusCode = 418; throw boom; });
  const boomRes = await errApp.inject({ method: 'GET', url: '/boom' });
  if (boomRes.statusCode !== 418 || JSON.parse(boomRes.body).message !== GENERIC_ERROR_MESSAGE || boomRes.body.includes('odometer_reading')) throw new Error('the injected route leaked detail or lost status');
  if (systemCalls !== 1) throw new Error('logSystemError must record the thrown route error');
  await errApp.close();
  console.log('✅ Generic body; status, name and telemetry preserved.');

  console.log('--- Test 8: HSTS + HTTP→HTTPS at the edge (v1.90.0) ---');
  const secApp = Fastify({ logger: false });
  secApp.addHook('onRequest', securityHeadersHook);
  secApp.get('/page', async () => ({ ok: true }));
  secApp.get('/api/health', async () => ({ status: 'ok' }));
  secApp.get('/internal/status', async () => ({ status: 'ok' }));
  secApp.get('/healthz', async () => ({ status: 'ok' }));
  await secApp.ready();
  const httpPage = await secApp.inject({ method: 'GET', url: '/page?tab=2', headers: { host: 'app.sakafleet.com', 'x-forwarded-proto': 'http' } });
  if (httpPage.statusCode !== 308 || String(httpPage.headers.location) !== 'https://app.sakafleet.com/page?tab=2') throw new Error('plain HTTP must 308 with path + query preserved');
  const httpsPage = await secApp.inject({ method: 'GET', url: '/page', headers: { host: 'app.sakafleet.com', 'x-forwarded-proto': 'https' } });
  if (httpsPage.statusCode !== 200 || String(httpsPage.headers['strict-transport-security']) !== HSTS_HEADER_VALUE) throw new Error('HTTPS must carry HSTS');
  if (!String(HSTS_HEADER_VALUE).includes('includeSubDomains')) throw new Error('CHECK 2 passed live — includeSubDomains must be present');
  for (const probe of ['/api/health', '/internal/status', '/healthz']) {
    const res = await secApp.inject({ method: 'GET', url: probe, headers: { host: 'app.sakafleet.com', 'x-forwarded-proto': 'http' } });
    if (res.statusCode !== 200 || res.headers.location) throw new Error(`${probe} must never be redirected`);
  }
  const noProto = await secApp.inject({ method: 'GET', url: '/page' });
  if (noProto.statusCode !== 200 || noProto.headers['strict-transport-security']) throw new Error('an unproven proto must be neither redirected nor stamped');
  await secApp.close();
  console.log('✅ HSTS + 308 proven; all three probes exempt.');

  console.log('--- Test 9: rate-limit identity behind the GFE (v1.90.0) ---');
  const reqWith = (xff, ip = '10.0.0.1') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, ip, socket: { remoteAddress: ip } });
  if (rateLimitKeyGenerator(reqWith('1.1.1.1, 5.5.5.5')) !== rateLimitKeyGenerator(reqWith('9.9.9.9, 5.5.5.5'))) throw new Error('different forged leftmost hops must share one bucket');
  if (rateLimitKeyGenerator(reqWith('5.5.5.5, 6.6.6.6')) === rateLimitKeyGenerator(reqWith('5.5.5.5, 7.7.7.7'))) throw new Error('different rightmost hops must split buckets');
  if (rateLimitKeyGenerator(reqWith('8.8.8.8')) !== '8.8.8.8') throw new Error('a single-entry XFF must be used as-is');
  if (rateLimitKeyGenerator(reqWith('', '10.0.0.9')) !== '10.0.0.9') throw new Error('no XFF must fall back to request.ip');
  if (rightmostClientIp({ headers: {}, ip: undefined, socket: {} }) !== 'unknown') throw new Error('addressless requests must degrade to "unknown"');
  const rlApp = Fastify({ logger: false, trustProxy: true });
  await rlApp.register(rateLimit, { max: 2, timeWindow: '1 minute', keyGenerator: rateLimitKeyGenerator });
  rlApp.get('/limited', async () => ({ ok: true }));
  await rlApp.ready();
  const limitedHit = (xff) => rlApp.inject({ method: 'GET', url: '/limited', headers: { 'x-forwarded-for': xff } });
  const same1 = await limitedHit('9.9.9.9, 100.0.0.1');
  const same2 = await limitedHit('8.8.8.8, 100.0.0.1');
  const same3 = await limitedHit('7.7.7.7, 100.0.0.1');
  if (same1.statusCode !== 200 || same2.statusCode !== 200 || same3.statusCode !== 429) throw new Error('one real client must exhaust ONE shared bucket');
  const otherClient = await limitedHit('1.1.1.1, 200.0.0.2');
  if (otherClient.statusCode !== 200) throw new Error('a distinct real client must keep a fresh bucket');
  await rlApp.close();
  console.log('✅ Per-client buckets proven end to end.');

  console.log('🎉 ALL SECURITY HARDENING TESTS PASSED SUCCESSFULLY!');
}
runSecurityTests().catch(err => {
  console.error('❌ Security Hardening Test Failed:', err);
  process.exit(1);
});
