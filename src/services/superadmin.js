import { GoogleGenAI } from '@google/genai';
import { runHealthCheck } from '../workers/sentinel.js';
import { sendAdminNotificationEmail } from './mailer.js';
import crypto from 'crypto';

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing in environment');
  return new GoogleGenAI({ apiKey });
}

export function isSuperadminPhone(senderPhone) {
  const superadminPhone = process.env.SUPERADMIN_PHONE;
  if (!superadminPhone || !senderPhone) return false;
  const clean = (p) => p.toString().replace(/[^\d]/g, '');
  return clean(senderPhone) === clean(superadminPhone);
}
export function isSuperadminEmail(email) {
  const superadminEmail = process.env.SUPERADMIN_EMAIL;
  if (!superadminEmail || !email) return false;
  return email.trim().toLowerCase() === superadminEmail.trim().toLowerCase();
}


export async function logAdminAudit(supabase, adminPhone, action, details = {}) {
  try {
    const { error } = await supabase.from('admin_audit_logs').insert([{
      admin_phone: adminPhone,
      action: action,
      details: details,
      created_at: new Date().toISOString()
    }]);
    if (error) console.error('[Superadmin Audit Log Error]:', error.message);
  } catch (err) {
    console.error('[Superadmin Audit Log Exception]:', err.message);
  }
}

export async function ensureSuperadminTables(supabase) {
  const tables = ['superadmin_sessions', 'coupons', 'admin_audit_logs'];
  const statusMap = {};

  for (const t of tables) {
    const { error } = await supabase.from(t).select('*').limit(1);
    if (error && error.message && error.message.includes('Could not find the table')) {
      statusMap[t] = 'missing';
    } else {
      statusMap[t] = 'exists';
    }
  }

  const missing = Object.keys(statusMap).filter(t => statusMap[t] === 'missing');
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    try {
      const projectRef = (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0];
      const sql = `
        CREATE TABLE IF NOT EXISTS public.superadmin_sessions (
            phone_number text PRIMARY KEY,
            is_active boolean DEFAULT false,
            last_active_at timestamp with time zone DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS public.coupons (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            code text UNIQUE,
            discount_value text,
            assigned_to_phone text,
            is_redeemed boolean DEFAULT false,
            created_by text DEFAULT 'SUPERADMIN_WHATSAPP',
            created_at timestamp with time zone DEFAULT now()
        );
        ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS discount_value text;
        ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS assigned_to_phone text;
        ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS is_redeemed boolean DEFAULT false;

        CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            admin_phone text,
            action text,
            details jsonb,
            created_at timestamp with time zone DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_coupons_code ON public.coupons(code);
        CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON public.admin_audit_logs(admin_phone, created_at);
      `;

      await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: sql })
      });

      missing.forEach(t => { statusMap[t] = 'created'; });
    } catch (createErr) {
      console.warn('[Superadmin Table Creation Warning]:', createErr.message);
    }
  }

  return statusMap;
}

export async function parseSuperadminCommand(messageText) {
  const text = messageText ? messageText.trim() : '';

  const prompt = `Classify user's admin request into JSON:
Intent: "HEALTH_CHECK" | "GENERATE_COUPON" | "PROFILES_REPORT" | "UNKNOWN"
Extract: discount_value (e.g. "20%"), target_phone (e.g. "+254712345678")
Command: "${text}"`;

  const candidateModels = [
    'gemini-flash-latest',
    'gemini-1.5-flash',
    process.env.GEMINI_MODEL
  ].filter(Boolean);

  for (const modelName of candidateModels) {
    try {
      const response = await getGeminiClient().models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseMimeType: 'application/json' }
      });

      if (response && response.text) {
        const cleaned = response.text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(cleaned);
        if (parsed && parsed.intent) return parsed;
      }
    } catch (err) {
      console.warn(`[Superadmin Command Parser] Model ${modelName} failed:`, err.message);
    }
  }
  const lower = text.toLowerCase();
  if (/(health|sentinel|status|system|diagnostic|error logs)/i.test(lower)) return { intent: 'HEALTH_CHECK' };
  if (/(coupon|discount|generate|create)/i.test(lower)) {
    const discountMatch = text.match(/([0-9]+\s*%|[0-9]+\s*percent|KES\s*[0-9]+|\$[0-9]+)/i);
    const phoneMatch = text.match(/(\+?[0-9]{9,15})/);
    return {
      intent: 'GENERATE_COUPON',
      discount_value: discountMatch ? discountMatch[0].trim() : '20%',
      target_phone: phoneMatch ? phoneMatch[0].trim() : null
    };
  }
  if (/(profile|profiles|user|users|driver|drivers|owner|owners|report|stats|summary)/i.test(lower)) {
    return { intent: 'PROFILES_REPORT' };
  }

  return { intent: 'UNKNOWN' };
}


export async function handleHealthCheckCommand(supabase) {
  let sentinelResult = null;
  let dbStatus = 'Disconnected';
  let unresolvedCount = 0;
  let memoryMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  let uptimeSec = Math.floor(process.uptime());

  try {
    sentinelResult = await runHealthCheck(supabase);
  } catch (err) {
    console.error('[Superadmin HealthCheck] Sentinel error:', err.message);
  }

  try {
    const { count, error } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
    dbStatus = !error ? 'Connected & Operational' : `Error: ${error.message}`;
  } catch (err) {
    dbStatus = `Exception: ${err.message}`;
  }

  try {
    const { count, error } = await supabase
      .from('error_logs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'unresolved');
    if (!error && count !== null) unresolvedCount = count;
  } catch (err) {
    console.error('[Superadmin HealthCheck] Error count query failed:', err.message);
  }

  const rawInfo = `
Container Status: Running (Uptime: ${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s, Memory: ${memoryMB}MB)
Database Connection: ${dbStatus}
Sentinel Health Check Status: ${sentinelResult?.status || 'Executed'}
Recent Unresolved Error Logs: ${unresolvedCount}
AI Diagnosed Errors in Last Run: ${sentinelResult?.diagnosed_count || 0}
`;

  const synthesisPrompt = `You are the Saka Fleet Superadmin Sentinel Assistant.
Synthesize the following system health diagnostic telemetry into a short, well-formatted, professional WhatsApp summary for the superadmin. Include emojis and key status items (Container Status, Database Connection, Error Stats).

Diagnostic Telemetry:
${rawInfo}`;

  let summaryText = null;
  const candidateModels = [
    'gemini-flash-latest',
    'gemini-1.5-flash',
    process.env.GEMINI_MODEL
  ].filter(Boolean);

  for (const modelName of candidateModels) {
    try {
      const response = await getGeminiClient().models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: synthesisPrompt }] }]
      });

      if (response && response.text) {
        summaryText = response.text.trim();
        break;
      }
    } catch (err) {
      console.warn(`[Superadmin Synthesis] Model ${modelName} failed:`, err.message);
    }
  }

  if (!summaryText) {
    summaryText = `🖥️ *Saka Fleet System Sentinel Health Report*\n\n` +
      `• *Container Status*: Operational (Uptime: ${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s | Heap: ${memoryMB}MB)\n` +
      `• *Database Connection*: ${dbStatus}\n` +
      `• *Unresolved Error Logs*: ${unresolvedCount}\n` +
      `• *Sentinel AI Diagnoses*: ${sentinelResult?.diagnosed_count || 0} errors reviewed`;
  }

  return {
    summary: summaryText,
    telemetry: {
      dbStatus,
      unresolvedCount,
      memoryMB,
      uptimeSec,
      diagnosedCount: sentinelResult?.diagnosed_count || 0
    }
  };
}

export async function handleCouponGenerationCommand(supabase, adminPhone, messageText, parsed) {
  let discountValue = parsed?.discount_value || '20%';
  let rawPhone = parsed?.target_phone;

  if (!discountValue || discountValue === 'null') {
    const match = messageText.match(/([0-9]+\s*%|[0-9]+\s*percent|KES\s*[0-9]+|\$[0-9]+)/i);
    discountValue = match ? match[0].trim() : '20%';
  }

  let formattedTargetPhone = 'ALL';
  let profileName = null;

  if (rawPhone) {
    const cleanDigits = rawPhone.replace(/[^\d]/g, '');
    if (cleanDigits.length >= 9) {
      formattedTargetPhone = rawPhone.startsWith('+') ? rawPhone : `+${cleanDigits}`;

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, phone_number')
        .eq('phone_number', formattedTargetPhone)
        .maybeSingle();

      if (profile) profileName = profile.full_name;
    }
  }

  const numPart = discountValue.replace(/[^\d]/g, '') || '20';
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  const couponCode = `SAKA-${numPart}-${randomSuffix}`;

  const couponId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const { error } = await supabase.from('coupons').insert([{
    id: couponId,
    code: couponCode,
    discount_value: discountValue,
    assigned_to_phone: formattedTargetPhone,
    is_redeemed: false,
    created_by: adminPhone || 'SUPERADMIN_WHATSAPP',
    created_at: nowIso
  }]);

  if (error) {
    throw new Error(`Failed to insert coupon into database: ${error.message}`);
  }

  const assignedDisplay = profileName
    ? `${profileName} (${formattedTargetPhone})`
    : (formattedTargetPhone !== 'ALL' ? formattedTargetPhone : 'Any User (Universal)');

  const reply = `🎟️ *Coupon Generated Successfully!*\n\n` +
    `• *Coupon Code*: \`${couponCode}\`\n` +
    `• *Discount Value*: ${discountValue}\n` +
    `• *Assigned Profile*: ${assignedDisplay}\n` +
    `• *Status*: Active & Unredeemed`;

  return {
    reply,
    details: {
      coupon_id: couponId,
      code: couponCode,
      discount_value: discountValue,
      assigned_to_phone: formattedTargetPhone,
      profile_name: profileName
    }
  };
}

export async function handleProfilesReportCommand(supabase) {
  const { count: totalProfiles } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null);

  const { data: ownersData } = await supabase
    .from('vehicles')
    .select('owner_id')
    .is('deleted_at', null);
  const uniqueOwners = new Set((ownersData || []).map(v => v.owner_id).filter(Boolean));

  const { data: driversData } = await supabase
    .from('vehicles')
    .select('assigned_driver_id')
    .is('deleted_at', null);
  const uniqueDrivers = new Set((driversData || []).map(v => v.assigned_driver_id).filter(Boolean));

  const now = new Date();
  const iso24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const iso7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { count: signups24h } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', iso24h)
    .is('deleted_at', null);

  const { count: signups7d } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', iso7d)
    .is('deleted_at', null);

  const { data: recentList } = await supabase
    .from('profiles')
    .select('full_name, phone_number, country, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(5);

  let recentFormatted = 'No recent signups found.';
  if (recentList && recentList.length > 0) {
    recentFormatted = recentList.map((p, i) => {
      const dateStr = p.created_at ? p.created_at.split('T')[0] : 'N/A';
      return `${i + 1}. *${p.full_name || 'WhatsApp User'}* (${p.phone_number}) - ${p.country || 'Global'} [${dateStr}]`;
    }).join('\n');
  }

  const reply = `📊 *Saka Fleet Profiles Report*\n\n` +
    `• *Total Registered Profiles*: ${totalProfiles || 0}\n` +
    `• *Active Vehicle Owners*: ${uniqueOwners.size}\n` +
    `• *Assigned Active Drivers*: ${uniqueDrivers.size}\n` +
    `• *New Sign-ups (Last 24h)*: ${signups24h || 0}\n` +
    `• *New Sign-ups (Last 7d)*: ${signups7d || 0}\n\n` +
    `*Recent Sign-ups*:\n${recentFormatted}`;

  return {
    reply,
    details: {
      total_profiles: totalProfiles || 0,
      active_vehicle_owners: uniqueOwners.size,
      active_assigned_drivers: uniqueDrivers.size,
      signups_24h: signups24h || 0,
      signups_7d: signups7d || 0
    }
  };
}

/**
 * Main Intercept Flow for Superadmin WhatsApp Messages
 */
export async function handleSuperadminFlow(supabase, senderPhone, messageText) {
  if (!isSuperadminPhone(senderPhone)) {
    return { isSuperadmin: false };
  }

  const formattedPhone = senderPhone.startsWith('+') ? senderPhone : `+${senderPhone.replace(/[^\d]/g, '')}`;
  const cleanText = messageText ? messageText.trim().toLowerCase() : '';

  // 1. Session Control: "adminstart"
  if (cleanText === 'adminstart') {
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from('superadmin_sessions')
      .upsert({
        phone_number: formattedPhone,
        is_active: true,
        last_active_at: nowIso
      });

    if (error) console.error('[Superadmin Session Start Error]:', error.message);

    await logAdminAudit(supabase, formattedPhone, 'SESSION_START', { command: 'adminstart' });
    if (process.env.SUPERADMIN_EMAIL) {
      sendAdminNotificationEmail('🔒 Superadmin Session Started', `<p>Superadmin session was started via WhatsApp from <strong>${formattedPhone}</strong> at ${nowIso}.</p>`).catch(() => {});
    }

    return {
      isSuperadmin: true,
      reply: '🔒 Superadmin session started. You have full control.'
    };
  }

  // 2. Session Control: "adminstop"
  if (cleanText === 'adminstop') {
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from('superadmin_sessions')
      .upsert({
        phone_number: formattedPhone,
        is_active: false,
        last_active_at: nowIso
      });

    if (error) console.error('[Superadmin Session Stop Error]:', error.message);

    await logAdminAudit(supabase, formattedPhone, 'SESSION_STOP', { command: 'adminstop' });
    if (process.env.SUPERADMIN_EMAIL) {
      sendAdminNotificationEmail('🔓 Superadmin Session Closed', `<p>Superadmin session was closed via WhatsApp from <strong>${formattedPhone}</strong> at ${nowIso}.</p>`).catch(() => {});
    }

    return {
      isSuperadmin: true,
      reply: '🔓 Superadmin session closed.'
    };
  }

  // 3. Verify Active Session
  const { data: sessionData } = await supabase
    .from('superadmin_sessions')
    .select('*')
    .eq('phone_number', formattedPhone)
    .maybeSingle();

  if (!sessionData || sessionData.is_active !== true) {
    return {
      isSuperadmin: true,
      reply: "Please type 'adminstart' to begin your admin session."
    };
  }

  // Active session confirmed! Update last_active_at timestamp
  await supabase
    .from('superadmin_sessions')
    .update({ last_active_at: new Date().toISOString() })
    .eq('phone_number', formattedPhone);

  // 4. Command Routing
  const parsedCommand = await parseSuperadminCommand(messageText);

  if (parsedCommand.intent === 'HEALTH_CHECK') {
    const healthRes = await handleHealthCheckCommand(supabase);
    await logAdminAudit(supabase, formattedPhone, 'HEALTH_CHECK', healthRes.telemetry);
    return {
      isSuperadmin: true,
      reply: healthRes.summary
    };
  }

  if (parsedCommand.intent === 'GENERATE_COUPON') {
    const couponRes = await handleCouponGenerationCommand(supabase, formattedPhone, messageText, parsedCommand);
    await logAdminAudit(supabase, formattedPhone, 'GENERATE_COUPON', couponRes.details);
    return {
      isSuperadmin: true,
      reply: couponRes.reply
    };
  }

  if (parsedCommand.intent === 'PROFILES_REPORT') {
    const reportRes = await handleProfilesReportCommand(supabase);
    await logAdminAudit(supabase, formattedPhone, 'PROFILES_REPORT', reportRes.details);
    return {
      isSuperadmin: true,
      reply: reportRes.reply
    };
  }

  const defaultReply = `🔒 *Saka Superadmin Command Center*\n\n` +
    `Your admin session is active. You can issue the following commands:\n\n` +
    `• *Health / Sentinel Check*: "check health", "system status", "run sentinel"\n` +
    `• *Coupon Generation*: "generate 20% coupon for +254712345678"\n` +
    `• *Profiles Report*: "profiles report", "user stats"\n` +
    `• *Close Session*: "adminstop"`;

  return {
    isSuperadmin: true,
    reply: defaultReply
  };
}

