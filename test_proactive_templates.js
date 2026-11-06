/**
 * Saka Fleet - Proactive template registry tests (v1.63.1, sec 182).
 * Stateless: env-driven, zero network, zero DB.
 */
import assert from 'assert';
import fs from 'node:fs';
import {
  PROACTIVE_TEMPLATE_KINDS,
  PROACTIVE_TEMPLATE_ENV_KEYS,
  PROACTIVE_TEMPLATE_LANGUAGE,
  templateNameForKind,
  templateVariablesForKind,
  resolveProactiveMode
} from './src/services/proactiveTemplates.js';

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed += 1;
  console.log('  ok ' + message);
}

console.log('=== PROACTIVE TEMPLATE REGISTRY TESTS (v1.63.0) ===');
for (const key of PROACTIVE_TEMPLATE_ENV_KEYS) delete process.env[key];
const KINDS = Object.keys(PROACTIVE_TEMPLATE_KINDS);
const EXPECTED = [
  'service_reminder', 'expiry_reminder', 'trial_ending', 'trial_grace',
  'dunning', 're_engagement', 'driver_unassigned', 'winback',
  'deploy_live', 'eval_digest_ping', 'care_escalation',
  'driver_activity', 'fleet_auto_audit'
];

console.log('--- 1. registry completeness ---');
check(KINDS.length === 13, '13 proactive kinds are registered');
check(KINDS.join(',') === EXPECTED.join(','), 'the canonical kind list is stable');
check(PROACTIVE_TEMPLATE_ENV_KEYS.length === 13 && new Set(PROACTIVE_TEMPLATE_ENV_KEYS).size === 13, 'every kind has a unique META_TPL_ env knob');
check(PROACTIVE_TEMPLATE_ENV_KEYS.every((key) => key.startsWith('META_TPL_') && key.length > 9), 'every env knob follows META_TPL_<KIND>');
check(Object.isFrozen(PROACTIVE_TEMPLATE_KINDS), 'the registry is frozen (no runtime drift)');
check(KINDS.every((kind) => Array.isArray(PROACTIVE_TEMPLATE_KINDS[kind].variables)), 'every kind declares a variables array');
check(KINDS.every((kind) => typeof PROACTIVE_TEMPLATE_KINDS[kind].audience === 'string' && PROACTIVE_TEMPLATE_KINDS[kind].audience.length > 0), 'every kind declares an audience');
check(PROACTIVE_TEMPLATE_LANGUAGE === 'en', 'the registry language is en');

console.log('--- 2. variable contracts ---');
check(PROACTIVE_TEMPLATE_KINDS.service_reminder.variables.join(',') === 'plate', 'service_reminder takes the plate');
check(PROACTIVE_TEMPLATE_KINDS.expiry_reminder.variables.join(',') === 'item,due', 'expiry_reminder takes item + due');
check(PROACTIVE_TEMPLATE_KINDS.dunning.variables.join(',') === 'tier,days', 'dunning takes tier + days');
check(PROACTIVE_TEMPLATE_KINDS.deploy_live.variables.length === 0 && PROACTIVE_TEMPLATE_KINDS.eval_digest_ping.variables.length === 0 && PROACTIVE_TEMPLATE_KINDS.care_escalation.variables.length === 0, 'superadmin and care pings use static bodies');

console.log('--- 3. template name resolution ---');
check(templateNameForKind('service_reminder') === null, 'unset knob resolves to no template');
process.env.META_TPL_SERVICE_REMINDER = 'saka_service_reminder';
check(templateNameForKind('service_reminder') === 'saka_service_reminder', 'configured knob resolves to the template name');
process.env.META_TPL_SERVICE_REMINDER = '   ';
check(templateNameForKind('service_reminder') === null, 'a blank knob is treated as unset');
delete process.env.META_TPL_SERVICE_REMINDER;
check(templateNameForKind('not_a_kind') === null, 'unknown kinds never resolve a template');

console.log('--- 4. ordered variables ---');
check(JSON.stringify(templateVariablesForKind('dunning', { tier: 'Solo Pro', days: '2' })) === JSON.stringify([{ type: 'text', text: 'Solo Pro' }, { type: 'text', text: '2' }]), 'variables are ordered per the registry');
check(templateVariablesForKind('dunning', { tier: 'Solo Pro' }) === null, 'a missing variable degrades to null');
check(templateVariablesForKind('dunning', { tier: 'Solo Pro', days: '   ' }) === null, 'a blank variable degrades to null');
check(JSON.stringify(templateVariablesForKind('service_reminder', { plate: 'KDA 123A', extra: 'ignored' })) === JSON.stringify([{ type: 'text', text: 'KDA 123A' }]), 'extra keys never leak into the body');
check(JSON.stringify(templateVariablesForKind('deploy_live')) === '[]', 'static kinds need no variables');
check(templateVariablesForKind('not_a_kind', {}) === null, 'unknown kinds have no variable contract');

console.log('--- 5. routing decisions ---');
check(resolveProactiveMode({}).mode === 'text', 'no kind routes to text');
check(resolveProactiveMode({ kind: 'service_reminder', templateVars: { plate: 'X' } }).mode === 'text', 'unset env routes to text (byte-identical fallback)');
process.env.META_TPL_SERVICE_REMINDER = 'saka_service_reminder';
const routed = resolveProactiveMode({ kind: 'service_reminder', templateVars: { plate: 'KDA 123A' } });
check(routed.mode === 'template' && routed.templateName === 'saka_service_reminder' && routed.variables[0].text === 'KDA 123A', 'configured env routes to the template sender with variables');
check(resolveProactiveMode({ kind: 'service_reminder', templateVars: {} }).mode === 'text', 'missing variables fall back to text');
check(resolveProactiveMode({ kind: 'unknown_kind' }).mode === 'text', 'unknown kinds fall back to text');
process.env.META_TPL_DEPLOY_LIVE = 'saka_deploy_live';
const staticMode = resolveProactiveMode({ kind: 'deploy_live' });
check(staticMode.mode === 'template' && Array.isArray(staticMode.variables) && staticMode.variables.length === 0, 'a static kind routes with an empty parameter list');
delete process.env.META_TPL_DEPLOY_LIVE;
delete process.env.META_TPL_SERVICE_REMINDER;
check(resolveProactiveMode({ kind: 'service_reminder', templateVars: { plate: 'X' } }).mode === 'text', 'removing the knob restores text mode');

console.log('--- 6. purity + ratchet exemption ---');
const source = fs.readFileSync('./src/services/proactiveTemplates.js', 'utf8');
check(source.indexOf('fetch(') === -1, 'the registry never performs network I/O');
check(source.indexOf('graph.facebook') === -1, 'the registry carries no transport code (template bodies live in Meta)');
check(source.indexOf('no-canned-') !== -1 && source.indexOf('ratchet') !== -1, 'the no-canned-replies exemption is documented in the module');

console.log('--- 7. sender wiring reachability (rule 51 sweep) ---');
const trialSrc = fs.readFileSync('./src/services/trialEngine.js', 'utf8');
check(trialSrc.includes("'trial_ending'") && trialSrc.includes("'trial_grace'") && trialSrc.includes("'dunning'") && trialSrc.includes("'winback'") && trialSrc.includes("'re_engagement'"), 'trialEngine passes its five kinds');
const maintenanceSrc = fs.readFileSync('./src/services/maintenanceReminders.js', 'utf8');
check(maintenanceSrc.includes("'service_reminder'") && maintenanceSrc.includes("'expiry_reminder'"), 'the reminder sweep passes both reminder kinds');
const followupSrc = fs.readFileSync('./src/services/followups.js', 'utf8');
check(followupSrc.includes("'driver_unassigned'"), 'the follow-up worker passes driver_unassigned');
const evalSrc = fs.readFileSync('./src/services/evalDigest.js', 'utf8');
check(evalSrc.includes("'eval_digest_ping'"), 'the eval digest passes eval_digest_ping');
const careSrc = fs.readFileSync('./src/services/customerCare.js', 'utf8');
check(careSrc.includes("'care_escalation'"), 'customer care passes care_escalation');
const indexSrc = fs.readFileSync('./index.js', 'utf8');
check(indexSrc.includes("'deploy_live'") && indexSrc.includes('sendWhatsAppTemplateMessage'), 'the LIVE announcement passes deploy_live through the template sender');
check(KINDS.every((kind) => PROACTIVE_TEMPLATE_ENV_KEYS.includes(PROACTIVE_TEMPLATE_KINDS[kind].env)), 'every kind is reachable through the registry env contract');

console.log('--- 8. Phase-1 completion kinds (v1.63.1, 2B) ---');
check(PROACTIVE_TEMPLATE_KINDS.driver_activity.variables.join(',') === 'driver,plate', 'driver_activity takes driver name + plate (sequential placeholders)');
check(PROACTIVE_TEMPLATE_KINDS.fleet_auto_audit.variables.join(',') === 'net', 'fleet_auto_audit takes the net figure');
check(resolveProactiveMode({ kind: 'driver_activity', templateVars: { plate: 'KDA 123A', driver: 'Jane' } }).mode === 'text', 'driver_activity with the knob unset falls back to today\'s free-form text');
process.env.META_TPL_DRIVER_ACTIVITY = 'saka_driver_activity';
const driverRouted = resolveProactiveMode({ kind: 'driver_activity', templateVars: { plate: 'KDA 123A', driver: 'Jane' } });
check(driverRouted.mode === 'template' && driverRouted.templateName === 'saka_driver_activity' && driverRouted.variables.map((v) => v.text).join('|') === 'Jane|KDA 123A', 'a configured driver_activity knob routes to the template sender with ordered variables');
delete process.env.META_TPL_DRIVER_ACTIVITY;
check(resolveProactiveMode({ kind: 'fleet_auto_audit', templateVars: { net: 'KES 4,250' } }).mode === 'text', 'fleet_auto_audit with the knob unset falls back to today\'s free-form text');
process.env.META_TPL_FLEET_AUTO_AUDIT = 'saka_fleet_auto_audit';
const auditRouted = resolveProactiveMode({ kind: 'fleet_auto_audit', templateVars: { net: 'KES 4,250' } });
check(auditRouted.mode === 'template' && auditRouted.templateName === 'saka_fleet_auto_audit' && auditRouted.variables[0].text === 'KES 4,250', 'a configured fleet_auto_audit knob routes to the template sender with its variable');
delete process.env.META_TPL_FLEET_AUTO_AUDIT;
const indexFallbackSrc = fs.readFileSync('./index.js', 'utf8');
check(indexFallbackSrc.includes("'driver_activity', { plate, driver: driverName }") && indexFallbackSrc.includes('🔔 *Driver Activity Summary (${plate})*'), 'the driver_activity fallback text is byte-identical to the pre-v1.63.1 message');
check(indexFallbackSrc.includes("'fleet_auto_audit', { net: formatMoney(fleetTotalEarnings - fleetTotalExpenses, cur, loc) }") && indexFallbackSrc.includes('📊 Your Fleet Auto-Audit Report is ready.'), 'the fleet_auto_audit fallback text is byte-identical to the pre-v1.63.1 message');

console.log('');
console.log('ALL PROACTIVE TEMPLATE TESTS PASSED (' + passed + ' assertions).');
