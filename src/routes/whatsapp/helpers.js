/**
 * Saka Fleet - WhatsApp pure helpers (Phase 5B-1 of the whatsapp.js split, v1.66.0).
 * ---------------------------------------------------------------------------------
 * Deterministic, side-effect free utilities moved verbatim out of messages.js:
 * country/language detection, text parsing, role-context building, the offline
 * role-discovery copy and the subscription-text parsers.
 *
 * Nothing in this module touches the database, an AI provider, a chat session or
 * the network. messages.js imports these for the live processor; the route barrel
 * re-exports every symbol so existing importers (tests, onboarding.js via the
 * whatsapp.js shim) keep working unchanged.
 */

import { detectCountryFromPhone as detectCountryGlobal } from '../../services/globalization.js';
import { isSuperadminPhone } from '../../services/superadmin.js';

export function detectCountryFromPhone(phone) {
  // Single source of truth: src/services/globalization.js
  return detectCountryGlobal(phone);
}

export function detectMessageLanguage(text = '') {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return 'English';
  const score = (kwList) => kwList.reduce((n, kw) => n + (t.includes(kw) ? 1 : 0), 0);

  const swahili = score(['habari', 'mambo', 'jambo', 'hujambo', 'salama', 'nataka', 'tafadhali', 'asante', 'magari', 'gari', 'mafuta', 'karibu', 'sawa', 'niko', 'wewe', 'nini', 'vipi']);
  const french = score(['bonjour', 'salut', 'merci', 'voiture', 'véhicule', 'carburant', 'kilométrage', 'kilometrage', 'oui', 'besoin', 'comment', 'pouvez', 'svp', 'combien']);
  const spanish = score(['hola', 'gracias', 'por favor', 'coche', 'vehículo', 'vehiculo', 'combustible', 'kilometraje', 'necesito', 'cómo', 'como', 'quiero', 'cuánto', 'cuanto']);
  const german = score(['hallo', 'danke', 'bitte', 'auto', 'fahrzeug', 'kraftstoff', 'kilometerstand', 'brauche', 'wie', 'was', 'möchte', 'mochte']);
  const arabic = score(['مرحبا', 'شكرا', 'سيارة', 'وقود', 'أريد', 'كم', 'مسافة']);

  const best = Object.entries({ Swahili: swahili, French: french, Spanish: spanish, German: german, Arabic: arabic })
    .sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : 'English';
}

/** v1.49.4 — confirmation line shown when Saka switches to the user's language. */
export function languageSwitchConfirmation(lang) {
  const map = {
    Swahili: '🔤 *Language: Kiswahili* — nitajibu kwa Kiswahili sasa. Jibu "English" ukitaka kurudi Kiingereza.',
    French: '🔤 *Langue : français* — je répondrai en français. Répondez « English » pour revenir.',
    Spanish: '🔤 *Idioma: español* — te responderé en español. Responde "English" para volver.',
    German: '🔤 *Sprache: Deutsch* — ich antworte jetzt auf Deutsch. Antworte „English", um zurückzuwechseln.',
    Arabic: '🔤 *اللغة: العربية* — سأرد بالعربية الآن. اكتب "English" للعودة.'
  };
  return map[lang] || `🔤 *Language changed to ${lang}* — I'll reply in ${lang} now. Reply "English" to switch back.`;
}

export function checkIsConversationalFeedback(text = '', step = 1) {
  const clean = text.trim().toLowerCase();

  if (/^(cancel|exit|stop|reset|start over)$/i.test(clean)) return false;

  const feedbackKeywords = [
    // v1.26.0 — only genuine frustration signals. Questions like "why do you
    // need my VIN?" are answered, never apologised at or paused.
    'looping', 'loop', 'stuck', 'broken', 'bug', 'error', 'not working',
    'repeating', 'stop asking', 'already gave', 'already told',
    'lot of responses', 'many responses', 'many replies', 'frustrating',
    'frustrated', 'too many messages', 'stop replying', 'stop sending',
    'stop with the many replies', 'too many replies'
  ];

  for (const kw of feedbackKeywords) {
    if (clean.includes(kw)) return true;
  }

  if (step === 2) {
    if (/\b(you are|i am|why is|what is|this is|can you|where is|how do|it is)\b/i.test(clean)) {
      const carBrands = ['toyota', 'nissan', 'honda', 'mazda', 'isuzu', 'subaru', 'mitsubishi', 'mercedes', 'bmw', 'vw', 'volkswagen', 'audi', 'ford', 'hyundai', 'kia', 'peugeot', 'suzuki', 'volvo', 'byd', 'land rover', 'rover', 'lexus', 'porsche'];
      const hasBrand = carBrands.some(brand => clean.includes(brand));
      if (!hasBrand) return true;
    }
  }

  return false;
}

export function extractNumberFromText(text = '') {
  if (!text) return null;
  const match = text.match(/(?:kes|usd|gbp|eur|zar|ngn|ugx|tzs|rwf|amount|\b)?\s*([\d,]+(?:\.\d+)?)/i);
  if (match && match[1]) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (!isNaN(num) && num > 0) return num;
  }
  return null;
}

export function extractOdometerFromText(text = '') {
  if (!text) return null;
  const match = text.match(/(?:odometer|mileage|km|miles|reading|clocked|\b)\s*([\d,]+)/i);
  if (match && match[1]) {
    const num = parseInt(match[1].replace(/,/g, ''), 10);
    if (!isNaN(num) && num > 0) return num;
  }
  return null;
}

export function matchVehicle(vehicles = [], plateCandidate = null) {
  if (!vehicles || vehicles.length === 0) return null;
  if (plateCandidate) {
    const cleanPlate = plateCandidate.replace(/\s+/g, '').toUpperCase();
    const found = vehicles.find(v => v.plate_number.replace(/\s+/g, '').toUpperCase() === cleanPlate);
    if (found) return found;
  }
  return vehicles[0];
}

/**
 * First-time / unregistered user progressive onboarding guide.
 * Shared by role discovery and the idle greeting so every brand-new user
 * receives one consistent, numbered, step-by-step path.
 */
/**
 * Role-aware command index consumed by the AI action-discovery renderer.
 * The AI writes the prose; this function owns the permissions.
 */
export function buildRoleContext(profileData, vehicles = [], senderPhone = '') {
  // v1.50.0 — superadmin is superadmin-only: it never holds owner/driver roles.
  if (isSuperadminPhone(senderPhone)) {
    return {
      roles: ['Superadmin'],
      commands: [
        'adminstart', 'adminstop',
        'admin report', 'admin audit <plate or VIN>', 'admin alerts',
        'admin ai-stats', 'admin usage [Nh]', 'admin trial-stats [Nd]',
        'admin remediations [pending|deployed]', 'admin accept fix <CODE>',
        'admin decline fix <CODE>', 'admin modify fix <CODE> <feedback>',
        'adminrules', 'admin sentinel diagnose'
      ]
    };
  }
  const roles = [];
  if (profileData?.id && vehicles.some((v) => v.owner_id === profileData.id)) roles.push('Owner');
  if (profileData?.id && vehicles.some((v) => v.assigned_driver_id === profileData.id)) roles.push('Driver');
  if (roles.length === 0) roles.push('Unregistered');

  const commands = [];
  if (roles.includes('Superadmin')) {
    // v1.16.0 — the FULL admin command surface (the AI once summarised a
    // partial list; admins need the complete index).
    commands.push(
      'adminstart', 'adminstop',
      'admin report', 'admin audit <plate or VIN>', 'admin alerts',
      'admin ai-stats', 'admin usage [Nh]', 'admin trial-stats [Nd]',
      'admin accept fix <CODE>', 'admin decline fix <CODE>',
      'admin modify fix <CODE> <feedback>',
      'adminrules', 'admin sentinel diagnose'
    );
  }
  if (roles.includes('Owner')) {
    commands.push('register vehicle', 'my vehicles', 'switch vehicle', 'log expense', 'log earnings', 'update odometer',
      'assign driver', 'unassign driver', 'transfer passbook', 'set reminder', 'request report', 'edit vehicle', 'delete vehicle', 'view my profile');
  }
  if (roles.includes('Driver')) {
    commands.push('update odometer', 'log expense', 'log earnings', 'set reminder', 'passbook details', 'view my profile');
  }
  if (roles.includes('Unregistered')) {
    commands.push('register vehicle', 'accept passbook transfer', 'help');
  }

  return { roles, commands };
}

export function buildFirstTimeWelcome({ swahili = false, countryInfo = null, senderPhone = null } = {}) {
  const region = countryInfo || (senderPhone ? detectCountryFromPhone(senderPhone) : null) || detectCountryFromPhone(null);
  const plateExample = region.plate_example || 'ABC 1234';
  const isImperial = (region.default_units || 'metric') === 'imperial';
  const mileageHint = isImperial ? 'current mileage in miles' : 'current mileage in km';
  const unitLabel = isImperial ? 'miles/gallons' : 'km/liters';

  const opener = swahili
    ? '👋 *Habari! Karibu Saka Fleet!* Mimi ni Saka, nahodha wa gari lako. 🚗'
    : '👋 *Welcome to Saka Fleet!* I\'m Saka — your vehicle\'s co-pilot. 🚗';
  return `${opener}\n\n` +
    `Saka tracks your vehicles, fuel, expenses, compliance & maintenance right here on WhatsApp.\n\n` +
    `🚀 *Your First-Time Setup (about 2 minutes):*\n` +
    `1️⃣ Reply with your plate number (e.g. *${plateExample}*) — or type *Register*.\n` +
    `2️⃣ Send Make & Model, Year, Fuel Type and ${mileageHint}.\n` +
    `3️⃣ Verify your email with the 6-digit code we send you.\n` +
    `4️⃣ Receive your VIN-locked digital passbook instantly. 🎉\n\n` +
    `🌍 *Region:* ${region.country} (${region.country_code}) · ${unitLabel} · ${region.currency}\n\n` +
    `💡 *Anytime:* type *Help* or *What can I do?* to see your menu.\n` +
    `🔄 *Mistake?* type *Restart* or *Cancel*.\n` +
    `🤝 *Buying a vehicle with a passbook?* Reply *ACCEPT* once the seller starts the transfer.`;
}

/**
 * Conversational Action Discovery (Driver, Owner, Superadmin)
 */
export function generateRoleBasedActionDiscovery({ profileData, vehicles = [], senderPhone, targetVeh }) {
  const isAdmin = isSuperadminPhone(senderPhone);
  const ownedVehicles = vehicles.filter(v => v.owner_id === profileData?.id);
  const assignedVehicles = vehicles.filter(v => v.assigned_driver_id === profileData?.id);
  const isOwner = ownedVehicles.length > 0;
  const isDriver = assignedVehicles.length > 0;
  const activePlate = targetVeh?.plate_number || (ownedVehicles[0] || assignedVehicles[0])?.plate_number || 'Fleet';

  if (isAdmin) {
    return `🛡️ *Saka Fleet — Superadmin Command Hub*\n` +
      `Verified Superadmin: ${senderPhone}\n\n` +
      `👑 *Superadmin Operations:*\n` +
      `• \`admin report\` — Executive fleet digest\n` +
      `• \`admin audit [Plate or VIN]\` — Deep vehicle passbook audit\n` +
      `• \`admin alerts\` — System warnings & friction logs\n` +
      `• \`admin remediations [pending|deployed]\` — Review fixes\n` +
      `• \`admin ai-stats\` · \`admin trial-stats\` — Telemetry digests\n` +
      `• \`adminrules reset\` — Dynamic micro-rules management\n` +
      `• \`adminstop\` — Terminate admin session`;
  }

  if (isOwner && isDriver) {
    return `👑 *Saka Fleet — Owner & Driver Command Center*\n` +
      `Active Vehicle: *${activePlate}*\n\n` +
      `🚗 *Fleet & Passbook (Owner):*\n` +
      `• \`my vehicles\` — View all registered vehicles\n` +
      `• \`switch to [plate]\` — Change active vehicle\n` +
      `• \`register\` — Add a new vehicle slot\n` +
      `• \`transfer passbook [plate]\` — Securely hand over passbook to buyer\n` +
      `• \`assign driver [phone] to [plate]\` — Assign driver (Strict 1-to-1)\n` +
      `• \`edit vehicle [plate]\` — Update details (VIN stays locked)\n` +
      `• \`delete vehicle [plate]\` — Remove vehicle (logs preserved)\n` +
      `• \`edit profile\` — Update your name, language & units\n\n` +
      `🚙 *Driver Duties (Assigned Driver):*\n` +
      `• \`Odometer [km]\` — Update vehicle mileage\n` +
      `• \`Logged [L] fuel for [amount]\` — Record fuel expenses\n` +
      `• \`Earned [amount] today\` — Log revenue\n\n` +
      `📊 *Audits & Analytics:*\n` +
      `• \`What is my fuel consumption in km/l?\` — Instant efficiency report\n` +
      `• \`Send monthly report\` — PDF audit report via email`;
  }

  if (isOwner) {
    return `👑 *Saka Fleet — Owner Command Center*\n` +
      `Active Vehicle: *${activePlate}*\n\n` +
      `🚗 *Fleet & Passbook:*\n` +
      `• \`my vehicles\` — View all registered vehicles\n` +
      `• \`switch to [plate]\` — Change active vehicle\n` +
      `• \`register\` — Add a new vehicle to your fleet\n` +
      `• \`transfer passbook [plate]\` — Transfer vehicle passbook to a buyer\n\n` +
      `👥 *Driver Management:*\n` +
      `• \`assign driver [phone] to [plate]\` — Assign driver (Strict 1-to-1)\n` +
      `• \`unassign driver from [plate]\` — Release assigned driver\n\n` +
      `⛽ *Daily Operations:*\n` +
      `• \`Logged 40L fuel for KES 8500 at 368000 km\` — Log fuel & odometer\n` +
      `• \`Earned KES 6000 today\` — Record daily trip revenue\n` +
      `• \`Remind oil change at 375000 km\` — Set service reminder\n\n` +
      `🛠️ *Edits & Deletion:*\n` +
      `• \`edit vehicle [plate]\` — Update vehicle details (VIN stays permanently locked)\n` +
      `• \`delete vehicle [plate]\` — Remove vehicle (logs preserved, driver unassigned)\n` +
      `• \`edit profile\` — Update your name, language & units\n` +
      `• \`delete my account\` — Deactivate your account\n\n` +
      `📊 *Audits & Analytics:*\n` +
      `• \`What is my fuel consumption in km/l?\` — Instant efficiency report\n` +
      `• \`Send monthly report\` — PDF audit statement via email\n` +
      `• \`upgrade plan\` — View subscription tiers & slot expansion`;
  }

  if (isDriver) {
    return `🚙 *Saka Fleet — Driver Hub*\n` +
      `Assigned Vehicle: *${activePlate}*\n\n` +
      `📝 *Your Daily Tools:*\n` +
      `• \`Odometer 368000 km\` — Update mileage reading\n` +
      `• \`Logged 30L petrol KES 6000\` — Submit fuel expense\n` +
      `• \`Earned KES 4500 today\` — Submit daily trip income\n` +
      `• \`Oil change needed\` — Notify fleet owner of service issue\n` +
      `• \`passbook details\` — View compliance & insurance dates\n` +
      `• \`edit profile\` — Update your name, language & units\n\n` +
      `💡 *Note:* Driver submissions automatically update fleet records and notify your owner.`;
  }

  return buildFirstTimeWelcome({ senderPhone });
}

/** Resolve a plan key from free text ("growth monthly", "fleet command"). */
function parseTierFromMessage(text = '') {
  const raw = String(text).toLowerCase();
  if (/fleet\s*command|\bcommand\b/.test(raw)) return 'fleet_command';
  if (/\bteam\b/.test(raw)) return 'team_fleet';
  if (/\bgrowth\b/.test(raw)) return 'growth';
  if (/\bsolo\b|\bpro\b/.test(raw)) return 'solo_pro';
  return null;
}

function parseIntervalFromMessage(text = '') {
  return /month/i.test(String(text)) ? 'monthly' : 'annual';
}

export { parseTierFromMessage, parseIntervalFromMessage };
