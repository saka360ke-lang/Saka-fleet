/**
 * Saka Fleet â€” One-Piece-at-a-Time Quiz Engine
 * --------------------------------------------
 * Every multi-field conversational flow is a step-by-step wizard that asks
 * exactly ONE question per turn, accepts multi-field answers (fast-forward),
 * and ALWAYS presents a confirmation summary before writing to the database.
 *
 * The engine owns the state machine and the data validation. Saka AI renders
 * all prose through conversationEngine.js â€” there are no canned quiz texts.
 */

import crypto from 'crypto';
import {
  renderQuizQuestion,
  renderConfirmationSummary,
  renderOutcome,
  seedQuizQuestions,
  isQuizQuestionCacheWarm
} from './conversationEngine.js';
import { chatCompletion, parseJsonSafely } from './aiClient.js';
import {
  buildGlobalContext,
  userDistanceToKm,
  kmToUserDistance,
  formatDate,
  formatMoney,
  formatNumber,
  resolveUserTimezone
} from './globalization.js';
import { sendEmailOtp, sendMfaEmail, sendSupportEscalationEmail, sendPassbookWelcomeEmail } from './mailer.js';
import {
  assignDriverToVehicle,
  unassignDriverFromVehicle,
  updateVehicleDetails,
  sanitizeVehicleUpdates,
  deleteVehicle,
  ensureVinRegistryEntry,
  checkOwnerVehicleTierLimit
} from './vehicles.js';
import { applyTrialExtensionCoupon } from './coupons.js';
import {
  startAccountTrial,
  startWelcomeTrial,
  recordActivationEvent,
  ACTIVATION_EVENTS,
  applyAccountTrialExtensionCoupon
} from './trialEngine.js';
import {
  checkoutForTier,
  cancelSubscription,
  selectVehiclesToKeep,
  getEntitlements
} from './subscriptions.js';
import { normalizeTierKey, getTierLabel } from './subscriptionTiers.js';
import { parseFlexibleDate } from './dateParser.js';
import {
  parseThresholdSpec,
  describeThresholdSpec,
  createThresholdReminder,
  evaluateVehicleReminders,
  parseOperatingHours,
  parseExpirySpec,
  buildExpirySpecFromDate,
  describeExpirySpec,
  createExpiryReminder,
  categoryForReminderType
} from './maintenanceReminders.js';
import { extractWithAI, mergeExtraNotes, formatExtraNotes, isSubstantiveText } from './naturalParser.js';
import { resolveVehicleComplianceCatalog, submitVehicleCompliance } from './vehicleCompliance.js';
import {
  createDriverAssignment,
  verifyOwnerAssignmentOtp,
  cancelPendingAssignment,
  getDriverComplianceStatus,
  getActiveAssignment,
  submitDriverCompliance,
  notifyOwnerComplianceCleared
} from './driverAssignments.js';
import {
  resolveBundledCatalog,
  getComplianceCatalog,
  parseComplianceItem
} from './complianceCatalog.js';
import {
  initiatePassbookTransfer,
  setBuyerDetailsAndSendReleaseOtp,
  verifyOwnerReleaseOtpAndNotifyBuyer
} from './transfers.js';

const CURRENT_YEAR = new Date().getFullYear();
const MAX_QUIZ_AGE_MS = 45 * 60 * 1000;

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PLATE_RE = /^[A-Z0-9][A-Z0-9 -]{2,12}$/i;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{11,17}$/i;

function parseEmail(text) {
  const match = String(text).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase() : null;
}

function parsePhone(text) {
  const match = String(text).match(/\+?\d[\d\s()-]{8,16}\d/);
  if (!match) return null;
  const digits = match[0].replace(/[^\d]/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return `+${digits}`;
}

function parsePlate(text, ctx = {}) {
  const raw = String(text).trim().toUpperCase().replace(/\s+/g, ' ');
  if (ctx.vehicles?.length) {
    const direct = ctx.vehicles.find((v) => v.plate_number?.toUpperCase() === raw);
    if (direct) return direct.plate_number;
  }
  if (!PLATE_RE.test(raw) || !/\d/.test(raw)) return null;
  if (/^(VIN|OTP|FUEL|DIESEL|PETROL|HYBRID|OWNER|DRIVER|REGISTER)$/.test(raw)) return null;
  return raw;
}

function parseVin(text) {
  const raw = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = raw.match(/[A-HJ-NPR-Z0-9]{11,17}/);
  return match ? match[0] : null;
}

function parseNumber(text) {
  const match = String(text).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseOdometer(text, ctx) {
  const num = parseNumber(text);
  if (num === null || num < 0) return null;
  const unitSystem = buildGlobalContext(ctx.countryInfo, ctx.profile).unitSystem;
  return userDistanceToKm(num, unitSystem);
}

function parseDateValue(text, ctx = {}) {
  const result = parseFlexibleDate(text, {
    countryCode: ctx.countryInfo?.country_code || 'GLOBAL',
    locale: ctx.countryInfo?.locale || 'en-US'
  });
  return result.ok ? result.localDate : null;
}

/** Canonical vehicle column linked to a compliance category (if any). */
function expiryLinkedColumn(category) {
  if (category === 'insurance') return 'vehicles.insurance_expiry';
  if (category === 'inspection') return 'vehicles.inspection_expiry';
  if (category === 'licensing') return 'vehicles.road_license_expiry';
  if (category === 'permit') return 'vehicles.permit_expiry';
  return null;
}

function isYes(text) {
  return /^(yes|y|yeah|yep|confirm|save|correct|ok|okay|sure|proceed|do it|âœ…)$/i.test(String(text).trim());
}

function isNo(text) {
  return /^(no|n|nope|cancel|abort|stop|exit|discard|don'?t|nah)$/i.test(String(text).trim());
}

function field(key, label, hint, options = {}) {
  return {
    key,
    label,
    hint,
    required: options.required !== false,
    optional: options.optional === true,
    group: options.group || null,
    kind: options.kind || 'text',
    aliases: options.aliases || [key],
    choices: options.choices || null,
    when: options.when || null,
    parse: options.parse || ((text) => String(text).trim()),
    validate: options.validate || (() => ({ ok: true })),
    summary: options.summary || ((value) => (value === null || value === undefined ? 'â€”' : String(value)))
  };
}

function choiceField(key, label, hint, choices, options = {}) {
  const normalized = choices.map((c) => ({ value: c.value || c, aliases: c.aliases || [] }));
  return field(key, label, hint, {
    ...options,
    kind: 'choice',
    choices: normalized.map((c) => c.value),
    parse: (text) => {
      const clean = String(text).trim().toLowerCase();
      for (const c of normalized) {
        if (clean === c.value.toLowerCase()) return c.value;
        if (c.aliases.some((a) => clean.includes(a))) return c.value;
      }
      return null;
    },
    validate: (value) => (normalized.some((c) => c.value === value)
      ? { ok: true }
      : { ok: false, message: `Please choose one of: ${normalized.map((c) => c.value).join(', ')}` })
  });
}

function vehicleField(ctx) {
  const vehicles = ctx.vehicles || [];
  const summarize = (value) => {
    const v = vehicles.find((x) => x.id === value);
    return v ? `${v.plate_number}${v.make_model ? ` (${v.make_model})` : ''}` : 'â€”';
  };

  if (vehicles.length <= 1) {
    return field('vehicle_id', 'Vehicle', 'Confirm the vehicle', {
      kind: 'vehicle',
      optional: vehicles.length === 0,
      parse: () => (vehicles.length === 1 ? vehicles[0].id : null),
      validate: (value) => (vehicles.some((v) => v.id === value)
        ? { ok: true }
        : { ok: false, message: 'No registered vehicle was found for this action.' }),
      summary: summarize
    });
  }

  return field('vehicle_id', 'Vehicle', `Which vehicle? (${vehicles.map((v) => v.plate_number).join(', ')})`, {
    kind: 'vehicle',
    parse: (text) => {
      const clean = String(text).trim().toLowerCase();
      const byIndex = clean.match(/^\d+$/) ? vehicles[Number(clean) - 1] : null;
      if (byIndex) return byIndex.id;
      const found = vehicles.find((v) =>
        v.plate_number?.toLowerCase() === clean ||
        v.plate_number?.toLowerCase().replace(/\s+/g, '') === clean.replace(/\s+/g, '') ||
        (v.make_model && clean.includes(v.make_model.toLowerCase()))
      );
      return found ? found.id : null;
    },
    validate: (value) => (vehicles.some((v) => v.id === value)
      ? { ok: true }
      : { ok: false, message: 'Please reply with one of your vehicle plates (or its number).' }),
    summary: summarize
  });
}

const REGISTRATION_OPTIONAL_KEYS = [
  'insurance_expiry', 'insurance_policy', 'inspection_expiry', 'color',
  'transmission', 'engine_number', 'tire_size', 'purchase_cost', 'custom_attributes'
];

function registrationFields() {
  return [
    field('plate_number', 'Registration plate number', 'e.g. KDA 123A', {
      parse: (text, c) => parsePlate(text, c),
      validate: (value, c) => {
        if (!value) return { ok: false, message: 'That does not look like a registration plate. Please resend it.' };
        const duplicate = (c.vehicles || []).find((v) =>
          v.plate_number?.toUpperCase().replace(/\s+/g, '') === value.replace(/\s+/g, '') &&
          v.owner_id === c.profile?.id
        );
        if (duplicate) return { ok: false, message: `Plate ${value} is already registered in your fleet.` };
        return { ok: true };
      }
    }),
    field('make_model', 'Make and model', 'e.g. Toyota Land Cruiser 80 series', {
      validate: (value) => (value && value.length >= 2 && value.length <= 80
        ? { ok: true }
        : { ok: false, message: 'Please share the make and model (at least 2 characters).' })
    }),
    field('yom', 'Year of manufacture', `e.g. 1991 or ${CURRENT_YEAR - 5}`, {
      aliases: ['yom', 'year', 'year_of_manufacture'],
      parse: (text) => parseNumber(text),
      validate: (value) => (value >= 1900 && value <= CURRENT_YEAR + 1
        ? { ok: true }
        : { ok: false, message: `Please give a year between 1900 and ${CURRENT_YEAR + 1}.` })
    }),
    choiceField('fuel_type', 'Fuel type', 'Diesel, Petrol, Hybrid or Electric', [
      { value: 'Diesel', aliases: ['diesel'] },
      { value: 'Petrol', aliases: ['petrol', 'gasoline', 'gas'] },
      { value: 'Hybrid', aliases: ['hybrid'] },
      { value: 'Electric', aliases: ['electric', 'ev'] }
    ]),
    field('current_mileage', 'Current odometer reading', 'e.g. 366700 (in your preferred units)', {
      aliases: ['current_mileage', 'odometer', 'odometer_reading', 'mileage'],
      parse: (text, c) => parseOdometer(text, c),
      validate: (value) => (Number.isFinite(value) && value >= 0
        ? { ok: true }
        : { ok: false, message: 'Please send the odometer as a number (e.g. 366700).' })
    }),
    field('vin', 'VIN / chassis number', '11â€“17 characters â€” permanently locked to your passbook', {
      aliases: ['vin', 'chassis'],
      parse: (text) => parseVin(text),
      validate: (value) => (value && VIN_RE.test(value)
        ? { ok: true }
        : { ok: false, message: 'A VIN is 11â€“17 letters/numbers (I, O and Q are not used). Please resend it.' })
    }),
    field('owner_email', 'Email address', 'for OTP verification and passbook delivery', {
      aliases: ['owner_email', 'email'],
      parse: (text) => parseEmail(text),
      validate: (value) => (value && EMAIL_RE.test(value)
        ? { ok: true }
        : { ok: false, message: 'That email does not look valid. Please resend it.' })
    }),
    field('otp', '6-digit verification code', 'we just emailed it to you (reply "resend" for a new code)', {
      kind: 'otp',
      when: (answers) => !!answers.owner_email,
      parse: (text) => {
        const match = String(text).match(/\b\d{6}\b/);
        return match ? match[0] : null;
      },
      validate: (value) => (/^\d{6}$/.test(String(value)) ? { ok: true } : { ok: false, message: 'Please send the 6-digit code.' })
    })
  ];
}

function registrationOptionalFields() {
  return [
    field('insurance_expiry', 'Insurance expiry date', 'e.g. 2027-05-15 (optional)', {
      optional: true, group: 'optional', aliases: ['insurance_expiry'],
      parse: (text, c) => parseDateValue(text, c),
      validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send a valid date, or reply Skip.' })
    }),
    field('insurance_policy', 'Insurance policy number/provider', 'optional', {
      optional: true, group: 'optional', aliases: ['insurance_policy']
    }),
    field('inspection_expiry', 'Inspection / NTAC expiry date', 'e.g. 2027-03-01 (optional)', {
      optional: true, group: 'optional', aliases: ['inspection_expiry'],
      parse: (text, c) => parseDateValue(text, c),
      validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send a valid date, or reply Skip.' })
    }),
    field('color', 'Vehicle colour', 'optional', { optional: true, group: 'optional', aliases: ['color'] }),
    choiceField('transmission', 'Transmission', 'Automatic or Manual (optional)', [
      { value: 'Automatic', aliases: ['automatic', 'auto'] },
      { value: 'Manual', aliases: ['manual'] }
    ], { optional: true, group: 'optional' }),
    field('engine_number', 'Engine number', 'optional', { optional: true, group: 'optional', aliases: ['engine_number'] }),
    field('tire_size', 'Tire size', 'e.g. 265/70R16 (optional)', { optional: true, group: 'optional', aliases: ['tire_size'] }),
    field('purchase_cost', 'Purchase cost', 'optional', {
      optional: true, group: 'optional', aliases: ['purchase_cost'],
      parse: (text) => parseNumber(text),
      validate: (value) => (value === null || value >= 0 ? { ok: true } : { ok: false, message: 'Please send a positive amount, or reply Skip.' })
    }),
    field('custom_attributes', 'Custom modifications or equipment', 'e.g. bullbar, winch (optional)', {
      optional: true, group: 'optional', aliases: ['custom_attributes'],
      parse: (text) => {
        const clean = String(text).trim();
        if (!clean) return null;
        const attrs = {};
        clean.split(/\s*(?:,|;|\band\b|\n)\s*/i).filter(Boolean).forEach((part) => {
          const [k, ...rest] = part.split(':');
          if (rest.length > 0) attrs[k.trim()] = rest.join(':').trim();
          else attrs[part.trim()] = true;
        });
        return Object.keys(attrs).length ? attrs : null;
      }
    })
  ];
}

const EDITABLE_VEHICLE_FIELDS = {
  'Plate number': 'plate_number',
  'Make / model': 'make_model',
  'Year of manufacture': 'yom',
  'Fuel type': 'fuel_type',
  'Odometer': 'current_mileage',
  'Colour': 'color',
  'Transmission': 'transmission',
  'Engine number': 'engine_number',
  'Tire size': 'tire_size',
  'Insurance policy': 'insurance_policy',
  'Insurance expiry': 'insurance_expiry',
  'Inspection expiry': 'inspection_expiry',
  'Road license expiry': 'road_license_expiry',
  'Permit expiry': 'permit_expiry',
  'Purchase cost': 'purchase_cost'
};

function editVehicleNewValueParser(editField) {
  if (['yom', 'current_mileage', 'purchase_cost'].includes(editField)) return parseNumber;
  if (['insurance_expiry', 'inspection_expiry', 'road_license_expiry', 'permit_expiry'].includes(editField)) {
    return (text, ctx) => parseDateValue(text, ctx);
  }
  return (text) => String(text).trim();
}

function expenseFields(ctx) {
  return [
    vehicleField(ctx),
    choiceField('expense_type', 'Expense type', 'Fuel, Maintenance, Insurance or Other', [
      { value: 'Fuel', aliases: ['fuel', 'petrol', 'diesel', 'refuel', 'gas'] },
      { value: 'Maintenance', aliases: ['maintenance', 'service', 'repair', 'oil', 'tyre', 'tire'] },
      { value: 'Insurance', aliases: ['insurance'] },
      { value: 'Other', aliases: ['other', 'misc', 'parking', 'fine'] }
    ]),
    field('amount', 'Amount spent', 'e.g. 5500', {
      aliases: ['amount', 'cost', 'price'],
      parse: (text) => parseNumber(text),
      validate: (value) => (Number.isFinite(value) && value > 0
        ? { ok: true }
        : { ok: false, message: 'Please send the amount as a number greater than zero.' })
    }),
    field('fuel_liters', 'Fuel volume', 'litres (or gallons in imperial regions)', {
      optional: true,
      aliases: ['fuel_liters', 'liters', 'litres', 'volume'],
      when: (answers) => answers.expense_type === 'Fuel',
      parse: (text) => parseNumber(text),
      validate: (value) => (value === null || value > 0
        ? { ok: true }
        : { ok: false, message: 'Please send the volume as a positive number, or reply Skip.' })
    }),
    field('odometer_reading', 'Odometer at fill-up', 'must be at least the last recorded reading', {
      aliases: ['odometer', 'odometer_reading', 'current_mileage', 'mileage'],
      parse: (text, c) => parseOdometer(text, c),
      validate: (value, c) => {
        const selected = (c.vehicles || []).find((v) => v.id === c.answers?.vehicle_id);
        const last = Number(selected?.current_mileage || selected?.odometer_reading || 0);
        if (!Number.isFinite(value) || value < 0) return { ok: false, message: 'Please send the odometer as a number.' };
        if (last > 0 && value < last) return { ok: false, message: `That is below the last recorded reading (${last}). Please resend.` };
        return { ok: true };
      }
    }),
    field('notes', 'Notes', 'optional â€” e.g. full tank, Shell station', {
      optional: true, aliases: ['notes'], parse: (text) => String(text).trim() || null
    })
  ];
}

const FLOW_LABELS = {
  vehicle_registration: 'Vehicle registration',
  email_update: 'Email update',
  assign_driver: 'Driver assignment',
  unassign_driver: 'Driver unassignment',
  transfer_seller: 'Passbook transfer',
  log_expense: 'Expense logging',
  log_earnings: 'Earnings logging',
  log_mileage: 'Odometer update',
  log_operating_hours: 'Operating hours log',
  edit_vehicle: 'Vehicle edit',
  edit_profile: 'Profile update',
  delete_vehicle: 'Vehicle deletion',
  delete_account: 'Account deletion',
  apply_coupon: 'Trial coupon',
  set_reminder: 'Maintenance or expiry reminder',
  driver_onboarding: 'Driver compliance onboarding',
  contact_support: 'Support escalation',
  reactivate_account: 'Account reactivation',
  subscription_upgrade: 'Subscription upgrade / trial',
  cancel_subscription: 'Subscription cancellation',
  keep_vehicles: 'Choose vehicles to keep'
};

export const QUIZ_FLOW_KEYS = Object.keys(FLOW_LABELS);

/** Compliance catalog item -> quiz field (minimal mandatory, extras optional). */
function complianceItemField(key, item, ctx, optional) {
  const timeZone = resolveUserTimezone({ countryInfo: ctx.countryInfo, profile: ctx.profile });
  return field(key, `${item.label} number and expiry`, `e.g. "DL-1234567 expires 15 Dec 2028"${item.lifetimeAllowed ? ' or "valid for life"' : ''}`, {
    optional,
    aliases: [key, item.type, item.label.toLowerCase()],
    parse: (text) => parseComplianceItem(text, {
      countryCode: ctx.countryInfo?.country_code || 'GLOBAL',
      locale: ctx.countryInfo?.locale || 'en-US',
      timeZone,
      catalogItem: item
    }),
    validate: (value) => {
      if (!value?.ok) return { ok: false, message: `Please send the ${item.label} number and its expiry date.` };
      if (value.lifetime && !item.lifetimeAllowed) {
        return { ok: false, message: `${item.label} has an expiry date in your economy — please send it.` };
      }
      if (!value.lifetime && !value.expiry) return { ok: false, message: 'Please include the expiry date, e.g. 15 Dec 2028.' };
      if (!value.lifetime && value.expired) {
        return { ok: false, message: `That ${item.label} expired on ${value.expiry}. Please send a currently valid one.` };
      }
      return { ok: true };
    },
    summary: (value) => (value?.ok
      ? `${value.number} — ${value.lifetime ? 'valid for life' : `expires ${value.expiry}`} (${value.timeZone})`
      : '-')
  });
}

/** Build the driver onboarding wizard from the regional compliance catalog. */
function driverOnboardingFields(ctx) {
  const profile = ctx.profile || {};
  const assigned = (ctx.vehicles || []).find((v) => v.assigned_driver_id === profile.id)
    || (ctx.activeVehicle?.assigned_driver_id === profile.id ? ctx.activeVehicle : null);
  const assetType = assigned?.asset_type || assigned?.metadata?.asset_type || null;
  const catalog = resolveBundledCatalog({ countryCode: ctx.countryInfo?.country_code, assetType });
  const fields = [];

  if (!profile.full_name || /^(Fleet Driver|WhatsApp User)$/i.test(String(profile.full_name))) {
    fields.push(field('full_name', 'Your full name', 'the name printed on your licence', {
      optional: true,
      aliases: ['full_name', 'name'],
      parse: (text) => (String(text).trim().length >= 2 ? String(text).trim() : null),
      validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send your full name, or reply Skip.' })
    }));
  }

  if (!profile.email || !profile.email_verified) {
    // Single-turn note: state what comes next so the wizard never reads as a
    // blind re-ask (code first, then the regional minimal compliance item).
    const nextComplianceLabel = catalog.minimal?.label || 'licence';
    fields.push(field('driver_email', 'Your email address', `used to verify you and send renewal reminders — a 6-digit code follows, then your ${nextComplianceLabel} number and expiry`, {
      aliases: ['driver_email', 'email'],
      parse: (text) => parseEmail(text),
      validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send a valid email address.' })
    }));
    fields.push(otpQuestionField(profile.email || null));
  }

  // v1.16.0 — never re-ask for compliance already on file (this was the
  // "Already told you earlier" friction): prefill from the live gate state.
  const gateStatus = ctx.driverGate?.status || null;
  const minimalAlreadyValid = gateStatus?.minimal?.valid === true;
  if (!minimalAlreadyValid) {
    // Owner self-profile: the minimum is collected immediately after vehicle
    // onboarding but stays skippable — an owner is never blocked from their
    // own fleet.
    fields.push(complianceItemField('minimal_compliance', catalog.minimal, ctx, Boolean(ctx.driverSelfProfile)));
  }
  for (const item of (catalog.additional || []).slice(0, 3)) {
    const existing = (gateStatus?.additional || []).find((row) => row.type === item.type);
    if (existing?.valid) continue;
    fields.push(complianceItemField(`compliance_${item.type}`, item, ctx, true));
  }
  return fields;
}

export function getFlowDefinition(flowKey, ctx) {
  const label = FLOW_LABELS[flowKey] || flowKey;

  switch (flowKey) {
    case 'vehicle_registration':
      return { key: flowKey, label, fields: [...registrationFields(), ...registrationOptionalFields()] };

    case 'email_update':
      return {
        key: flowKey,
        label,
        fields: [
          field('new_email', 'New email address', 'we will send a verification code there', {
            aliases: ['new_email', 'email', 'owner_email'],
            parse: (text) => parseEmail(text),
            validate: (value, c) => (!value
              ? { ok: false, message: 'Please resend a valid email address.' }
              : value === (c.profile?.email || '').toLowerCase()
                ? { ok: false, message: 'That is already your current email. Please send a different one.' }
                : { ok: true })
          }),
          field('otp', '6-digit verification code', 'sent to the new email', {
            kind: 'otp',
            parse: (text) => (String(text).match(/\b\d{6}\b/) || [])[0] || null
          })
        ]
      };

    case 'assign_driver':
      return {
        key: flowKey,
        label,
        fields: [
          vehicleField(ctx),
          field('driver_phone', "Driver's WhatsApp number", 'international format, e.g. +254712345678', {
            aliases: ['driver_phone', 'phone'],
            parse: (text) => parsePhone(text),
            validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send the driver phone in international format.' })
          }),
          field('odometer_at_assignment', 'Odometer at handover', 'current reading when the driver takes over', {
            aliases: ['odometer', 'odometer_at_assignment', 'current_mileage', 'mileage'],
            parse: (text, c) => parseOdometer(text, c),
            validate: (value, c) => {
              const selected = (c.vehicles || []).find((v) => v.id === c.answers?.vehicle_id);
              const last = Number(selected?.current_mileage || selected?.odometer_reading || 0);
              if (!Number.isFinite(value) || value < 0) return { ok: false, message: 'Please send the handover odometer as a number.' };
              if (last > 0 && value < last) return { ok: false, message: `Handover reading cannot be below the last recorded ${last}.` };
              return { ok: true };
            }
          })
        ]
      };

    case 'unassign_driver':
      return {
        key: flowKey,
        label,
        fields: [
          vehicleField(ctx),
          field('odometer_at_release', 'Odometer at handback', 'current reading when the driver returns the vehicle', {
            aliases: ['odometer', 'odometer_at_release', 'current_mileage', 'mileage'],
            parse: (text, c) => parseOdometer(text, c),
            validate: (value, c) => {
              const selected = (c.vehicles || []).find((v) => v.id === c.answers?.vehicle_id);
              const last = Number(selected?.current_mileage || selected?.odometer_reading || 0);
              if (!Number.isFinite(value) || value < 0) return { ok: false, message: 'Please send the handback odometer as a number.' };
              if (last > 0 && value < last) return { ok: false, message: `Handback reading cannot be below the last recorded ${last}.` };
              return { ok: true };
            }
          })
        ]
      };

    case 'transfer_seller':
      return {
        key: flowKey,
        label,
        fields: [
          vehicleField(ctx),
          field('buyer_phone', "Buyer's WhatsApp number", 'international format', {
            aliases: ['buyer_phone', 'phone'],
            parse: (text) => parsePhone(text),
            validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send the buyer phone in international format.' })
          }),
          field('buyer_email', "Buyer's email address", 'used for ownership verification', {
            aliases: ['buyer_email', 'email'],
            parse: (text) => parseEmail(text),
            validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send a valid buyer email.' })
          }),
          field('odometer_at_transfer', 'Current odometer reading', 'captured at the point of sale', {
            aliases: ['odometer', 'odometer_at_transfer', 'current_mileage', 'mileage'],
            parse: (text, c) => parseOdometer(text, c),
            validate: (value, c) => {
              const selected = (c.vehicles || []).find((v) => v.id === c.answers?.vehicle_id);
              const last = Number(selected?.current_mileage || selected?.odometer_reading || 0);
              if (!Number.isFinite(value) || value < 0) return { ok: false, message: 'Please send the odometer as a number.' };
              if (last > 0 && value < last) return { ok: false, message: `Odometer cannot be below the last recorded ${last}.` };
              return { ok: true };
            }
          })
        ]
      };

    case 'subscription_upgrade':
      return {
        key: flowKey,
        label,
        fields: [
          field('subscription_tier', 'Which plan?', 'Solo Pro (1 car) | Team Fleet (3) | Growth Fleet (5) | Fleet Command (5+)', {
            aliases: ['subscription_tier', 'plan'],
            parse: (text) => {
              const t = String(text).toLowerCase();
              if (/fleet\s*command|add[- ]?on|command/.test(t)) return 'fleet_command';
              if (/team/.test(t)) return 'team_fleet';
              if (/solo|pro\b/.test(t)) return 'solo_pro';
              if (/growth/.test(t)) return 'growth';
              return null;
            },
            validate: (value) => (value
              ? { ok: true }
              : { ok: false, message: 'Please choose Solo Pro, Team Fleet, Growth or Fleet Command.' }),
            summary: (value) => getTierLabel(value)
          }),
          field('billing_interval', 'Monthly or annual?', 'annual saves roughly 30%', {
            aliases: ['billing_interval', 'interval'],
            parse: (text) => (/month/i.test(String(text)) ? 'monthly' : 'annual'),
            validate: () => ({ ok: true })
          }),
          field('coupon_code', 'Coupon code', 'optional — reply Skip', {
            optional: true,
            aliases: ['coupon_code', 'coupon', 'promo'],
            parse: (text) => {
              const raw = String(text).trim();
              return /^[A-Z0-9-]{4,}$/i.test(raw) ? raw.toUpperCase() : null;
            }
          })
        ]
      };

    case 'cancel_subscription':
      return {
        key: flowKey,
        label,
        fields: [
          field('confirm', 'Confirm cancellation', 'YES to cancel, NO to keep your plan', {
            aliases: ['confirm'],
            parse: (text) => {
              const raw = String(text).trim();
              if (/^(yes|y|confirm|yep|do it)$/i.test(raw)) return 'yes';
              if (/^(no|n|abort|keep|stop)$/i.test(raw)) return 'no';
              return null;
            },
            validate: (value) => (value
              ? { ok: true }
              : { ok: false, message: 'Reply YES to cancel or NO to keep your plan.' })
          })
        ]
      };

    case 'keep_vehicles':
      return {
        key: flowKey,
        label,
        fields: [
          field('keep_vehicle_id', 'Which vehicle should stay active?', 'send its plate (or number)', {
            aliases: ['plate_number', 'target_vehicle', 'keep_vehicle_id'],
            parse: (text, c) => {
              const raw = String(text).trim().toUpperCase();
              const list = c.vehicles || [];
              const byPlate = list.find((v) => String(v.plate_number || '').toUpperCase() === raw);
              if (byPlate) return byPlate.id;
              const index = Number(raw);
              if (Number.isInteger(index) && index >= 1 && index <= list.length) return list[index - 1].id;
              return null;
            },
            validate: (value) => (value
              ? { ok: true }
              : { ok: false, message: 'Please send the plate of the vehicle to keep active.' }),
            summary: (value) => {
              const match = (ctx.vehicles || []).find((v) => v.id === value);
              return match?.plate_number || String(value);
            }
          })
        ]
      };

    case 'log_expense':
      return { key: flowKey, label, fields: expenseFields(ctx) };

    case 'log_earnings':
      return {
        key: flowKey,
        label,
        fields: [
          vehicleField(ctx),
          field('amount', 'Amount earned', 'e.g. 5000', {
            aliases: ['amount', 'revenue', 'earnings'],
            parse: (text) => parseNumber(text),
            validate: (value) => (Number.isFinite(value) && value > 0
              ? { ok: true }
              : { ok: false, message: 'Please send the amount as a number greater than zero.' })
          }),
          field('odometer_reading', 'Odometer at end of trip', 'must be at least the last recorded reading', {
            aliases: ['odometer', 'odometer_reading', 'current_mileage', 'mileage'],
            parse: (text, c) => parseOdometer(text, c),
            validate: (value, c) => {
              const selected = (c.vehicles || []).find((v) => v.id === c.answers?.vehicle_id);
              const last = Number(selected?.current_mileage || selected?.odometer_reading || 0);
              if (!Number.isFinite(value) || value < 0) return { ok: false, message: 'Please send the odometer as a number.' };
              if (last > 0 && value < last) return { ok: false, message: `That is below the last recorded reading (${last}). Please resend.` };
              return { ok: true };
            }
          }),
          field('period', 'Trip or period', 'optional â€” e.g. morning shift, 12â€“14 Oct', {
            optional: true, aliases: ['period', 'notes'], parse: (text) => String(text).trim() || null
          })
        ]
      };

    case 'log_mileage':
      return {
        key: flowKey,
        label,
        fields: [
          vehicleField(ctx),
          field('odometer_reading', 'New odometer reading', 'at least the last recorded reading', {
            aliases: ['odometer', 'odometer_reading', 'current_mileage', 'mileage'],
            parse: (text, c) => parseOdometer(text, c),
            validate: (value, c) => {
              const selected = (c.vehicles || []).find((v) => v.id === c.answers?.vehicle_id);
              const last = Number(selected?.current_mileage || selected?.odometer_reading || 0);
              if (!Number.isFinite(value) || value < 0) return { ok: false, message: 'Please send the odometer as a number.' };
              if (last > 0 && value < last) return { ok: false, message: `Odometer cannot be below the last recorded ${last}.` };
              return { ok: true };
            }
          })
        ]
      };

    case 'log_operating_hours':
      return {
        key: flowKey,
        label,
        fields: [
          vehicleField(ctx),
          field('hours', 'Operating hours', 'current hour-meter reading, e.g. 1250 or 36.5 hours', {
            aliases: ['hours', 'operating_hours', 'engine_hours', 'machine_hours'],
            parse: (text) => parseOperatingHours(text),
            validate: (value, c) => {
              const selected = (c.vehicles || []).find((v) => v.id === c.answers?.vehicle_id);
              const last = Number(selected?.operating_hours || 0);
              if (!Number.isFinite(value) || value < 0) return { ok: false, message: 'Please send the operating hours as a number.' };
              if (last > 0 && value < last) return { ok: false, message: `Operating hours cannot be below the last recorded ${last}.` };
              return { ok: true };
            },
            summary: (value) => `${formatNumber(value)} operating hours`
          })
        ]
      };

    case 'edit_vehicle':
      return {
        key: flowKey,
        label,
        fields: [
          vehicleField(ctx),
          choiceField('edit_field', 'Field to edit', 'VIN and passbook token can never be edited',
            Object.keys(EDITABLE_VEHICLE_FIELDS).map((labelName) => ({
              value: labelName,
              aliases: [EDITABLE_VEHICLE_FIELDS[labelName], labelName.toLowerCase()]
            }))),
          field('new_value', 'New value', 'the replacement value for the selected field', {
            aliases: ['new_value', 'edit_value', 'value'],
            parse: (text, c, answers) => editVehicleNewValueParser(EDITABLE_VEHICLE_FIELDS[answers.edit_field])(text, c),
            validate: (value) => (value !== null && value !== undefined && String(value).trim() !== ''
              ? { ok: true }
              : { ok: false, message: 'Please send the new value.' })
          })
        ]
      };

    case 'edit_profile':
      return {
        key: flowKey,
        label,
        fields: [
          choiceField('profile_field', 'Profile field', 'Full name, Language or Unit system', [
            { value: 'Full name', aliases: ['name', 'full name', 'jina', 'jina kamili', 'nom', 'nombre'] },
            { value: 'Language', aliases: ['language', 'preferred language', 'lugha', 'lugha unayotumia', 'langue', 'idioma'] },
            { value: 'Unit system', aliases: ['units', 'unit system', 'metric', 'imperial', 'vipimo', 'mfumo wa vipimo', 'unites', 'unidades', 'sistema de unidades'] }
          ]),
          field('new_value', 'New value', 'e.g. Jane Doe, Swahili, or imperial', {
            validate: (value) => (value && String(value).trim().length > 0
              ? { ok: true }
              : { ok: false, message: 'Please send the new value.' })
          })
        ]
      };

    case 'delete_vehicle':
      return { key: flowKey, label, fields: [vehicleField(ctx)] };

    case 'delete_account':
      return { key: flowKey, label, fields: [] };

    case 'reactivate_account':
      return { key: flowKey, label, fields: [] };

    case 'apply_coupon':
      return {
        key: flowKey,
        label,
        fields: [
          field('coupon_code', 'Coupon code', 'e.g. EXT30-AB12CD', {
            aliases: ['coupon_code', 'code'],
            parse: (text) => (String(text).toUpperCase().match(/[A-Z0-9-]{4,}/) || [])[0] || null,
            validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send the coupon code.' })
          })
        ]
      };

    case 'set_reminder':
      return {
        key: flowKey,
        label,
        fields: [
          vehicleField(ctx),
          choiceField('reminder_type', 'Reminder type', 'Service, Insurance, Inspection/MOT, Driver License, Road License, Permit, Deadline or Other', [
            { value: 'Oil change', aliases: ['oil'] },
            { value: 'Service', aliases: ['service', 'maintenance'] },
            { value: 'Insurance Renewal', aliases: ['insurance', 'insure', 'policy'] },
            { value: 'Inspection', aliases: ['inspection', 'mot', 'ntac', 'roadworthiness'] },
            { value: 'Driver License', aliases: ['driver license', 'driver licence', 'drivers license', 'driving licence'] },
            { value: 'Road License', aliases: ['license', 'licence', 'licensing', 'road tax', 'road license'] },
            { value: 'Permit', aliases: ['permit', 'transport permit', 'operator permit'] },
            { value: 'Deadline', aliases: ['deadline', 'renewal', 'expiry', 'expires'] },
            { value: 'Other', aliases: ['other'] }
          ]),
          field('due', 'Due date, distance or operating hours', 'e.g. 2027-05-15, 15th Dec 2026, next month, in 14 days, 5000 km, 3000 miles or 36 operating hours', {
            aliases: ['due', 'due_date', 'due_mileage', 'threshold'],
            parse: (text, c) => {
              const countryCode = c?.countryInfo?.country_code || 'GLOBAL';
              const locale = c?.countryInfo?.locale || 'en-US';
              const timeZone = resolveUserTimezone({ countryInfo: c?.countryInfo, profile: c?.profile });
              const expiry = parseExpirySpec(text, { countryCode, locale, timeZone });
              if (expiry.ok) {
                return {
                  kind: 'date',
                  category: expiry.category,
                  value: expiry.localDate,
                  localDate: expiry.localDate,
                  dueAt: expiry.dueAt,
                  timeZone,
                  source: expiry.source
                };
              }
              const parsed = parseFlexibleDate(text, { countryCode, locale });
              if (parsed.ok) {
                return {
                  kind: 'date',
                  category: categoryForReminderType(text),
                  value: parsed.localDate,
                  localDate: parsed.localDate,
                  dueAt: null,
                  timeZone,
                  source: parsed.source
                };
              }
              const unitSystem = buildGlobalContext(c?.countryInfo, c?.profile).unitSystem;
              const spec = parseThresholdSpec(text, { unitSystem });
              if (spec.ok) return spec;
              return null;
            },
            validate: (value) => (value
              ? { ok: true }
              : { ok: false, message: 'Please send an expiry date (e.g. 2027-05-15, 15th Dec 2026, next month, in 14 days), a distance (in 5000 km / 3000 miles) or operating hours (36 hours).' }),
            summary: (value, c) => {
              if (!value) return '-';
              if (value.kind === 'date') {
                const timeZone = value.timeZone || resolveUserTimezone({ countryInfo: c?.countryInfo, profile: c?.profile });
                return describeExpirySpec(
                  { localDate: value.value, dueAt: value.dueAt, timeZone },
                  { locale: c?.countryInfo?.locale || 'en-US' }
                );
              }
              return describeThresholdSpec(value);
            }
          })
        ]
      };

    case 'driver_onboarding':
      return { key: flowKey, label, fields: driverOnboardingFields(ctx) };

    case 'contact_support':
      return {
        key: flowKey,
        label,
        fields: [
          field('description', 'Issue description', 'one message describing what went wrong', {
            aliases: ['description', 'notes', 'issue'],
            validate: (value) => (value && String(value).trim().length >= 10
              ? { ok: true }
              : { ok: false, message: 'Please describe the issue in at least one sentence.' })
          })
        ]
      };

    default:
      return null;
  }
}



/* ------------------------------------------------------------------ */
/* Quiz state helpers                                                  */
/* ------------------------------------------------------------------ */

export function getActiveQuiz(session) {
  const quiz = session?.quiz;
  if (!quiz) return null;
  if (Date.now() - (quiz.startedAt || 0) > MAX_QUIZ_AGE_MS) {
    session.quiz = null;
    return null;
  }
  return quiz;
}

export function clearQuiz(session) {
  if (session) session.quiz = null;
}

function activeFields(def, answers) {
  return def.fields.filter((f) => !f.when || f.when(answers));
}

function nextField(def, answers) {
  return activeFields(def, answers).find((f) => !(f.key in answers) || answers[f.key] === undefined) || null;
}

function collectedLabels(def, answers) {
  return activeFields(def, answers)
    .filter((f) => f.key in answers && answers[f.key] !== null && answers[f.key] !== undefined)
    .map((f) => f.label);
}

function buildSummaryRows(def, answers, ctx) {
  return activeFields(def, answers)
    .filter((f) => f.key in answers && answers[f.key] !== null && answers[f.key] !== undefined)
    .map((f) => ({
      label: f.label,
      value: f.summary(answers[f.key], ctx, answers)
    }));
}

function applyExtraction(state, def, ext, ctx) {
  if (!ext) return;
  // Two passes: conditional fields (e.g. fuel volume when expense_type = Fuel)
  // only become active after earlier fields in the same payload are captured.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const f of activeFields(def, state.answers)) {
      if (f.key in state.answers && state.answers[f.key] !== undefined) continue;
      if (f.kind === 'otp') continue;
      for (const alias of f.aliases) {
        const raw = ext[alias];
        if (raw === null || raw === undefined || raw === '') continue;
        const parsed = f.parse(String(raw), { ...ctx, answers: state.answers }, state.answers);
        if (parsed === null || parsed === undefined) continue;
        const check = f.validate(parsed, { ...ctx, answers: state.answers }, state.answers);
        if (check.ok) {
          state.answers[f.key] = parsed;
          break;
        }
      }
    }
  }
}

function isSkipInput(text) {
  return /^(skip|later|not now|no thanks|none|na|n\/a|done|finish|that'?s all|no more|nothing else)$/i.test(String(text).trim());
}

/** "resend" family — accepted on every OTP turn. */
function isResendRequest(text) {
  return /^(?:resend|resend code|new code|send again|send it again|resend it)$/i.test(String(text || '').trim());
}

/** Explicit "wrong inbox" escape hatch on an OTP step. */
function isChangeEmailRequest(text) {
  return /\b(?:change|different|another|wrong|other)\s+(?:my\s+)?e-?mail\b/i.test(String(text || ''));
}

/**
 * Deterministic multi-field fast-forward. When the AI intent call is skipped on
 * quiz turns, this still captures extra values volunteered in the same message
 * (e.g. "Diesel, 366700 km") without an AI round trip. Only safe, unambiguous
 * fields are considered; phone/VIN/plate/amount are never guessed.
 */
function applyTextExtraction(state, def, text, ctx) {
  const clean = String(text || '').trim();
  if (!clean) return;

  const hasVolumeMarker = /\d\s*(?:l\b|lt\b|ltr\b|litre|liter|gal\b)/i.test(clean);
  const hasDistanceMarker = /(?:km|mi\b|mile|mileage|odo|odometer)/i.test(clean);

  for (const f of activeFields(def, state.answers)) {
    if (f.key in state.answers && state.answers[f.key] !== undefined) continue;

    let allowed = false;
    if (f.key === 'fuel_liters') allowed = hasVolumeMarker;
    else if (f.key === 'current_mileage' || f.key === 'odometer_reading') allowed = hasDistanceMarker;
    else if (f.key === 'yom' || f.key === 'fuel_type' || f.key === 'transmission') allowed = true;
    else if (f.key === 'plate_number' && def.key === 'vehicle_registration') allowed = true;
    if (!allowed) continue;

    let parsed = null;
    try {
      parsed = f.parse(clean, { ...ctx, answers: state.answers }, state.answers);
    } catch {
      parsed = null;
    }

    // Paragraph-safe plate capture: scan whitespace-delimited tokens so
    // "KDA 123A Toyota Hilux 1991 diesel …" still fills the plate field.
    if ((parsed === null || parsed === undefined) && f.key === 'plate_number') {
      const tokens = clean.toUpperCase().match(/[A-Z0-9][A-Z0-9-]{2,14}(?:\s[A-Z0-9]{1,4})?/g) || [];
      for (const token of tokens) {
        try {
          const candidate = f.parse(token.trim(), { ...ctx, answers: state.answers }, state.answers);
          if (!candidate) continue;
          if (f.validate(candidate, { ...ctx, answers: state.answers }, state.answers).ok) {
            parsed = candidate;
            break;
          }
        } catch { /* keep scanning */ }
      }
    }
    if (parsed === null || parsed === undefined) continue;

    const check = f.validate(parsed, { ...ctx, answers: state.answers }, state.answers);
    if (check.ok) state.answers[f.key] = parsed;
  }
}

/**
 * Background prefetch: renders every remaining question of a flow in ONE AI
 * call and seeds the question cache, so subsequent turns are instant.
 * Fire-and-forget — failures are ignored.
 */
async function prefetchFlowQuestions(def, ctx, currentKey = null) {
  if (!process.env.DEEPSEEK_API_KEY) return;
  if (isQuizQuestionCacheWarm(def.label, ctx.language || 'English')) return;

  const fields = activeFields(def, {}).filter((f) => f.kind !== 'otp');
  if (fields.length === 0) return;

  const fieldList = fields.map((f) => ({ field: f.label, hint: f.hint }));
  const prompt = `Return JSON only: {"questions":[{"field":"<exact field label>","text":"<one short WhatsApp question asking for that field, no acknowledgment, no extra questions>"}]}.
Flow: ${def.label}
Language: ${ctx.language || 'English'}
Fields: ${JSON.stringify(fieldList)}`;

  const result = await chatCompletion({
    system: 'You are Saka, a WhatsApp fleet assistant. You generate concise, single-question prompts. Respond with valid JSON only — no markdown, no commentary, no extra keys.',
    messages: [{ role: 'user', content: prompt }],
    jsonMode: true,
    maxTokens: 1200,
    temperature: 0.3
  });
  if (!result.ok) return;

  const parsed = parseJsonSafely(result.text);
  const map = {};
  for (const item of parsed?.questions || []) {
    if (item?.field && item?.text) map[item.field] = item.text;
  }
  if (Object.keys(map).length === 0) {
    console.warn('[quizEngine] Question prefetch returned no usable questions');
    return;
  }
  seedQuizQuestions(def.label, ctx.language || 'English', map);
  console.log(`[quizEngine] Prefetched ${Object.keys(map).length} questions for ${def.label}`);
}

/**
 * Starts a quiz on the session. Returns true when the flow exists.
 */
export function startQuiz({ session, flowKey, ctx, prefill = {} }) {
  const def = getFlowDefinition(flowKey, ctx);
  if (!def) return false;

  session.quiz = {
    flow: flowKey,
    answers: { ...prefill },
    phase: 'question',
    startedAt: Date.now(),
    otp: null,
    otpDispatch: null,
    otpDispatchAttempts: 0,
    transfer: null,
    lastNote: null,
    lastAcceptedAnswer: null,
    turnNote: null,
    extraNotes: [],
    extractionFailures: 0
  };

  applyExtraction(session.quiz, def, ctx.aiExtracted || {}, ctx);
  applyTextExtraction(session.quiz, def, ctx.messageText || '', ctx);

  // Friction reduction: with a single registered vehicle, auto-select it
  // instead of asking the user to confirm an obvious choice.
  const vField = def.fields.find((f) => f.key === 'vehicle_id');
  if (vField && (ctx.vehicles || []).length === 1 && session.quiz.answers.vehicle_id === undefined) {
    const onlyId = ctx.vehicles[0].id;
    const check = vField.validate(onlyId, { ...ctx, answers: session.quiz.answers }, session.quiz.answers);
    if (check.ok) session.quiz.answers.vehicle_id = onlyId;
  }

  // Active-vehicle context: honour the switch promise ("subsequent logs apply
  // to this vehicle") when the session already points at a fleet vehicle.
  // Ambiguity (no active vehicle, or one outside the fleet) still prompts.
  if (vField && session.quiz.answers.vehicle_id === undefined && ctx.activeVehicle?.id) {
    const activeVehicleId = ctx.activeVehicle.id;
    const belongsToFleet = (ctx.vehicles || []).some((v) => v.id === activeVehicleId);
    if (belongsToFleet) {
      const check = vField.validate(activeVehicleId, { ...ctx, answers: session.quiz.answers }, session.quiz.answers);
      if (check.ok) session.quiz.answers.vehicle_id = activeVehicleId;
    }
  }

  // Warm the question cache for the remaining fields in the background — one
  // AI call for the whole flow instead of one per turn.
  prefetchFlowQuestions(def, ctx).catch(() => {});

  return true;
}

async function askCurrent(state, ctx, note = null) {
  const def = getFlowDefinition(state.flow, ctx);
  if (!def) return null;

  const field = nextField(def, state.answers);

  if (!field) {
    state.phase = 'confirm';
    return renderConfirmationSummary({
      flowLabel: def.label,
      summaryRows: buildSummaryRows(def, state.answers, ctx),
      notes: confirmationNotes(state, ctx),
      language: ctx.language,
      countryInfo: ctx.countryInfo,
      profile: ctx.profile
    });
  }

  // OTP step: never mint a second code when this flow already dispatched one
  // (a silent re-send both burns Resend quota and invalidates the code the user
  // is typing). Reuse the live code; dispatch only when it is missing, expired
  // or the destination email actually changed.
  let hint = note ? `${field.hint} (${note})` : field.hint;
  if (field.kind === 'otp') {
    const dispatched = state.otpDispatch || null;
    const dispatchTarget = dispatched?.target || null;
    const answersTarget = currentOtpTarget(state) || ctx.profile?.email || null;
    const targetChanged = Boolean(dispatchTarget && answersTarget && dispatchTarget !== answersTarget);
    const unexpired = Boolean(state.otp && state.otp.expiresAt > Date.now());
    if (!dispatched || targetChanged || !unexpired) {
      await sendQuizOtp(state, def, ctx);
    }
    const knownTarget = state.otpDispatch?.target || state.otp?.target || null;
    hint = `${otpQuestionField(knownTarget).hint}${note ? ` (${note})` : ''}`;
  }

  state.lastNote = note;
  const rows = buildSummaryRows(def, state.answers, ctx);
  const upcoming = activeFields(def, state.answers).filter((f) => !(f.key in state.answers) || answersValueMissing(state.answers, f));
  const reply = await renderQuizQuestion({
    flowLabel: def.label,
    fieldLabel: field.label,
    hint,
    answers: state.answers,
    collectedLabels: rows.map((r) => `${r.label}: ${r.value}`),
    language: ctx.language,
    countryInfo: ctx.countryInfo,
    profile: ctx.profile,
    isFirst: rows.length === 0,
    isLast: upcoming.length === 1 && upcoming[0].key === field.key,
    lastAcceptedAnswer: state.lastAcceptedAnswer || null,
    turnNote: state.turnNote || null
  });
  state.turnNote = null;
  return reply;
}

function answersValueMissing(answers, f) {
  return !(f.key in answers) || answers[f.key] === undefined;
}

function confirmationNotes(state, ctx) {
  const extras = (state.extraNotes || []).map((n) => `Extra note: ${n}`);
  return [...confirmationNotesBase(state, ctx), ...extras];
}

function confirmationNotesBase(state, ctx) {
  if (state.flow === 'assign_driver') {
    return [
      'A 6-digit verification code will be emailed to your verified email address before the driver is notified.',
      'The driver must reply ACCEPT, then verify their email and a valid compliance item before they can manage this vehicle.'
    ];
  }
  if (state.flow === 'driver_onboarding') {
    return [
      'The minimal compliance item must be currently valid; it is used for renewal reminders.',
      'Optional extras can be added anytime and are only used so Saka can remind the driver before they expire.'
    ];
  }
  if (state.flow === 'delete_vehicle') {
    return [
      'The driver will be unassigned, pending passbook transfers cancelled, and active reminders retired.',
      'Historical expense, earnings and reminder logs are preserved for audit.',
      'The VIN trial ledger entry is permanent and cannot be removed.'
    ];
  }
  if (state.flow === 'delete_account') {
    return [
      'Your owned vehicles will be released and your profile soft-deleted.',
      'Historical audit logs are retained for compliance.',
      'A 6-digit verification code will be emailed before deletion.'

    ];
  }
  if (state.flow === 'vehicle_registration') {
    return [
      'The VIN will be permanently locked to your digital passbook.',
      'A 30-day trial ledger entry is created once per VIN for life.'
    ];
  }
  return [];
}
/** Destination mailbox for the flowing OTP step (never the code itself). */
function currentOtpTarget(state) {
  if (state.flow === 'email_update') return state.answers.new_email || null;
  if (state.flow === 'delete_account') return null; // resolved from the profile inside sendQuizOtp
  if (state.flow === 'driver_onboarding') return state.answers.driver_email || null;
  return state.answers.owner_email || null;
}

async function sendQuizOtp(state, def, ctx) {
  const purpose = state.flow === 'email_update'
    ? 'email_update'
    : state.flow === 'delete_account'
      ? 'account_deletion'
      : state.flow === 'driver_onboarding'
        ? 'driver_onboarding'
        : 'registration';

  const target = purpose === 'email_update'
    ? state.answers.new_email
    : purpose === 'account_deletion'
      ? ctx.profile?.email
      : purpose === 'driver_onboarding'
        ? state.answers.driver_email
        : state.answers.owner_email;

  if (!target) return;

  const code = String(crypto.randomInt(100000, 1000000));
  try {
    if (purpose === 'account_deletion') await sendMfaEmail(target, code);
    else await sendEmailOtp(target, code);
    state.otp = { code, target, purpose, expiresAt: Date.now() + 10 * 60 * 1000 };
    // A new code was minted — the quiet "code check n of 3" counter restarts.
    state.otpDispatchAttempts = 0;
    state.otpError = null;
    state.otpDispatch = { status: 'sent', target, purpose, attemptedAt: Date.now() };
  } catch (err) {
    state.otp = null;
    state.otpError = err.message;
    state.otpDispatch = { status: 'failed', target, purpose, attemptedAt: Date.now() };
  }
}

/**
 * OTP question field. The label is the question-cache key and is asserted by the
 * training/flow suites — never change it. The hint names the destination mailbox
 * and the escape hatches so the same step never sounds like a blind re-ask.
 */
function otpQuestionField(target = null) {
  const hint = target
    ? `We emailed the 6-digit code to ${target} — reply with the 6 digits, or "resend" if it has not arrived, or "change email" if that inbox is wrong. One message can carry both the code and your licence details.`
    : 'We emailed a 6-digit code to the address you just gave me — reply with the 6 digits, or "resend" if it has not arrived, or "change email" if that inbox is wrong. One message can carry both the code and your licence details.';
  return field('otp', '6-digit verification code', hint, {
    kind: 'otp',
    parse: (text) => (String(text).match(/\b\d{6}\b/) || [])[0] || null,
    validate: (value) => (/^\d{6}$/.test(String(value)) ? { ok: true } : { ok: false, message: 'Please send the 6-digit code.' })
  });
}

/**
 * Render the OTP step. The turn note is composed deterministically so every
 * re-ask is distinct (and therefore never served from the shared question
 * cache), while carrying no secret: never the code value, only the mailbox the
 * dispatch actually reached and a quiet attempt counter.
 */
async function askOtp(state, ctx, note = null) {
  const target = state.otpDispatch?.target || state.otp?.target || ctx.profile?.email || state.answers.owner_email || state.answers.new_email || state.answers.driver_email;
  const attempts = (Number(state.otpDispatchAttempts) || 0) + 1;
  state.otpDispatchAttempts = attempts;
  const dispatchFailed = state.otpDispatch?.status === 'failed';
  const def = getFlowDefinition(state.flow, ctx);
  const nextField = def ? activeFields(def, state.answers).find((f) => f.kind !== 'otp' && !(f.key in state.answers)) : null;

  const lines = [`Verifying your email — code check ${attempts} of 3.`];
  if (dispatchFailed) {
    lines.push('The last email could not be sent — reply "resend" or tell me a different address.');
  } else if (target) {
    lines.push(`The 6-digit code is in the mailbox ${target}.`);
  } else {
    lines.push('The 6-digit code is in the mailbox you just gave me.');
  }
  if (note) lines.push(note);
  if (nextField?.label) lines.push(`Once the code is confirmed, the next step is your ${nextField.label.toLowerCase()}.`);
  lines.push('One message can carry both the code and those details; reply "resend" or "change email" if needed.');

  return renderQuizQuestion({
    flowLabel: def?.label || state.flow,
    fieldLabel: '6-digit verification code',
    hint: lines.join(' '),
    answers: state.answers,
    collectedLabels: buildSummaryRows(def, state.answers, ctx).map((r) => `${r.label}: ${r.value}`),
    language: ctx.language,
    countryInfo: ctx.countryInfo,
    profile: ctx.profile,
    isFirst: false,
    isLast: true,
    turnNote: lines.join(' '),
    dispatchFailed
  });
}

/**
 * Owner confirmed the assignment summary → create the pending assignment,
 * email the 6-digit OTP and switch to the assignment_otp security phase.
 */
async function startAssignmentOtp(state, def, ctx) {
  const a = state.answers;
  const vehicle = (ctx.vehicles || []).find((v) => v.id === a.vehicle_id) || null;
  const base = { language: ctx.language, countryInfo: ctx.countryInfo, profile: ctx.profile };

  if (!ctx.supabase || !vehicle) {
    state.phase = 'confirm';
    const reply = await renderOutcome({
      flowLabel: def.label,
      success: false,
      facts: { error: 'Vehicle or database unavailable.' },
      ...base
    });
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const created = await createDriverAssignment({
    supabase: ctx.supabase,
    ownerProfile: ctx.profile,
    vehicle,
    driverPhone: a.driver_phone,
    handoverOdometer: a.odometer_at_assignment,
    countryInfo: ctx.countryInfo,
    sendWhatsApp: ctx.sendWhatsApp
  });

  if (!created.ok) {
    state.phase = 'confirm';
    const reply = await renderOutcome({
      flowLabel: def.label,
      success: false,
      facts: { error: created.error },
      ...base
    });
    return { handled: true, reply, flow: state.flow, active: true };
  }

  state.assignmentId = created.assignment.id;
  state.assignmentExpiresAt = created.expiresAt;
  state.phase = 'assignment_otp';

  const reply = await renderQuizQuestion({
    flowLabel: def.label,
    fieldLabel: '6-digit assignment code',
    hint: `We emailed a code to ${created.ownerEmail}. Reply with the 6 digits, or Resend for a new code.`,
    answers: a,
    collectedLabels: buildSummaryRows(def, a, ctx).map((row) => `${row.label}: ${row.value}`),
    language: ctx.language,
    countryInfo: ctx.countryInfo,
    profile: ctx.profile,
    isFirst: false,
    isLast: true
  });
  return { handled: true, reply, flow: state.flow, active: true };
}

/** Verify the owner's assignment OTP and notify the driver. */
async function handleAssignmentOtp(state, clean, ctx) {
  const def = getFlowDefinition(state.flow, ctx);
  const label = def?.label || state.flow;
  const a = state.answers;
  const vehicle = (ctx.vehicles || []).find((v) => v.id === a.vehicle_id) || null;
  const base = { language: ctx.language, countryInfo: ctx.countryInfo, profile: ctx.profile };

  const askAgain = async (note) => renderQuizQuestion({
    flowLabel: label,
    fieldLabel: '6-digit assignment code',
    hint: note,
    answers: a,
    collectedLabels: buildSummaryRows(def, a, ctx).map((row) => `${row.label}: ${row.value}`),
    language: ctx.language,
    countryInfo: ctx.countryInfo,
    profile: ctx.profile,
    isFirst: false,
    isLast: true
  });

  if (isResendRequest(clean)) {
    const created = await createDriverAssignment({
      supabase: ctx.supabase,
      ownerProfile: ctx.profile,
      vehicle,
      driverPhone: a.driver_phone,
      handoverOdometer: a.odometer_at_assignment,
      countryInfo: ctx.countryInfo,
      sendWhatsApp: ctx.sendWhatsApp
    });
    if (created.ok) {
      state.assignmentId = created.assignment.id;
      state.assignmentExpiresAt = created.expiresAt;
    }
    const reply = await askAgain(created.ok
      ? 'A fresh code has been emailed to you.'
      : `Could not send a code: ${created.error}`);
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const code = (String(clean).match(/\b\d{6}\b/) || [])[0];
  if (!code) {
    const reply = await askAgain('Please reply with the 6-digit code from your WhatsApp, or Resend.');
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const verified = await verifyOwnerAssignmentOtp({
    supabase: ctx.supabase,
    assignmentId: state.assignmentId,
    ownerId: ctx.profile?.id,
    code,
    sendWhatsApp: ctx.sendWhatsApp
  });

  if (!verified.ok) {
    if (verified.cancelled || verified.expired) {
      state.assignmentId = null;
      const reply = await renderOutcome({
        flowLabel: label,
        success: false,
        facts: { error: verified.error },
        ...base
      });
      return { handled: true, reply, flow: state.flow, cancelled: true };
    }
    const reply = await askAgain(verified.error);
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const reply = await renderOutcome({
    flowLabel: label,
    success: true,
    facts: {
      vehicle: verified.plate,
      driver: verified.driverPhone,
      status: 'Assignment request sent — awaiting the driver\'s ACCEPT.',
      nextStep: 'You will receive a compliance report as soon as their verification and compliance item are valid.'
    },
    ...base
  });
  return { handled: true, reply, flow: state.flow, completed: true };
}

function applyCorrections(state, def, ext, ctx) {
  const changed = [];
  if (ext) {
    for (const f of activeFields(def, state.answers)) {
      for (const alias of f.aliases) {
        const raw = ext[alias];
        if (raw === null || raw === undefined || raw === '') continue;
        const parsed = f.parse(String(raw), { ...ctx, answers: state.answers }, state.answers);
        if (parsed === null || parsed === undefined) continue;
        const check = f.validate(parsed, { ...ctx, answers: state.answers }, state.answers);
        if (check.ok && parsed !== state.answers[f.key]) {
          state.answers[f.key] = parsed;
          changed.push(f.label);
        }
        break;
      }
    }
  }
  return [...new Set(changed)];
}

const NON_QUIZ_INTENTS = new Set([
  'GREETING', 'APP_HELP', 'ACTION_DISCOVERY', 'CONTACT_SUPPORT',
  'QUERY_FUEL_EFFICIENCY', 'QUERY_FLEET_SUMMARY', 'LIST_VEHICLES', 'SWITCH_VEHICLE', 'REQUEST_REPORT', 'VIEW_PROFILE'
]);

/**
 * Quiz ↔ Conversation arbitration.
 * A greeting, a question or an unrelated conversation must NEVER be consumed as
 * a quiz answer. Returns true when the turn should be answered conversationally
 * while the quiz stays paused exactly where it is.
 */
export function shouldPauseQuizForChat({ messageText = '', intent = '', quiz = null } = {}) {
  if (!quiz) return false;
  const clean = String(messageText || '').trim();
  if (!clean) return false;

  // Security steps always consume the raw input
  if (quiz.phase === 'pin' || quiz.phase === 'account_otp') return false;

  // Bare conversational acknowledgements mid-question are chat, not answers.
  if (quiz.phase === 'question' &&
      /^(no|nope|nah|yes|yeah|yep|ok|okay|thanks|thank you|good|great|nice|cool|sure)$/i.test(clean)) {
    return true;
  }

  // Control words are owned by the engine
  if (/^(cancel|exit|stop|quit|abort|restart|start over|reset|yes|no|confirm|save|correct|skip|later|done|resend|resend code|new code|send again)$/i.test(clean)) {
    return false;
  }

  // Help is a conversational request
  if (/^(help|hint|what can i do|what do i do next|guide me)$/i.test(clean)) return true;

  // Greetings
  if (/^(hi|hello|hey|hiya|habari|mambo|jambo|hujambo|salama|good (morning|afternoon|evening))\b/i.test(clean)) {
    return true;
  }

  // Questions / requests for information
  const isQuestion = /\?/.test(clean) ||
    /^\s*(what|how|why|who|whom|whose|where|when|which|can you|could you|would you|will you|do you|did you|does saka|is saka|are you|tell me|explain|brief me|describe|show me|i want to know|i'd like to know|i need to know)\b/i.test(clean) ||
    /\b(tell me|explain|brief me|describe|what is|what's|how does|how do)\b/i.test(clean);
  if (isQuestion) return true;

  // An intent that is clearly not about answering the current quiz field
  if (NON_QUIZ_INTENTS.has(intent)) return true;

  return false;
}

/** Current question of an active quiz (for pause/resume nudges). */
export function getCurrentQuizField(quiz, ctx = {}) {
  if (!quiz) return null;
  const def = getFlowDefinition(quiz.flow, ctx);
  if (!def) return null;
  const f = nextField(def, quiz.answers);
  return f ? { key: f.key, label: f.label, hint: f.hint, optional: !!f.optional } : null;
}

// Explicit commands that may switch the active quiz to another flow. Only
// deterministic text patterns are allowed — AI intent alone must never hijack
// a flow (the Oct-2026 "Set reminder" → expense-trap incident).
const EXPLICIT_FLOW_PATTERNS = [
  { flow: 'set_reminder', re: /^(?:remind|reminder|set\s+reminder|remind\s+me)\b/i },
  { flow: 'log_expense', re: /^(?:log|record)\s+(?:an?\s+)?(?:expense|fuel|refuel)\b/i },
  { flow: 'log_earnings', re: /^(?:log|record)\s+(?:an?\s+)?(?:earning|earnings|income|revenue)\b/i },
  { flow: 'log_mileage', re: /^(?:update|set)\s+(?:the\s+)?(?:odometer|mileage)\b/i },
  { flow: 'log_operating_hours', re: /^(?:log|record|update|set)\s+(?:the\s+)?(?:operating|engine|machine|running)?\s*hours?\b/i },
  { flow: 'transfer_seller', re: /^transfer\s+passbook\b/i },
  { flow: 'assign_driver', re: /^(?:assign\s+driver|assign)\b/i },
  { flow: 'unassign_driver', re: /^(?:unassign\s+driver|remove\s+driver)\b/i },
  { flow: 'delete_vehicle', re: /^(?:delete|remove)\s+(?:my\s+)?(?:vehicle|car)\b/i },
  { flow: 'edit_vehicle', re: /^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)\b/i }
];

/**
 * Detect an explicit command that should switch an in-progress quiz to a
 * different flow. Returns the target flow key or null.
 */
export function detectFlowSwitch({ quiz, messageText = '', intent = '' } = {}) {
  if (!quiz) return null;
  // Never abandon registration (the user has no vehicle to act on yet).
  if (quiz.flow === 'vehicle_registration') return null;

  const text = String(messageText || '').trim();
  if (!text) return null;

  // "change email" on an OTP step is an in-flow escape hatch owned by
  // handleQuizTurn (it re-asks only the email field) — never a flow switch.
  if (quiz.phase === 'question' && isChangeEmailRequest(text)) return null;

  const match = EXPLICIT_FLOW_PATTERNS.find((p) => p.re.test(text));
  if (match && match.flow !== quiz.flow) return match.flow;
  return null;
}

/**
 * Main entry point used by the WhatsApp route for every inbound message.
 * Returns { handled, reply } â€” handled=false means the message is not a quiz turn.
 */
export async function handleQuizTurn({
  session,
  messageText = '',
  aiExtracted = {},
  ctx = {},
  startFlow = null,
  prefill = {}
}) {
  const clean = String(messageText || '').trim();
  let state = getActiveQuiz(session);

  if (!state) {
    if (!startFlow) return { handled: false };
    const started = startQuiz({ session, flowKey: startFlow, ctx: { ...ctx, aiExtracted }, prefill });
    if (!started) return { handled: false };
    state = session.quiz;
    const reply = await askCurrent(state, { ...ctx, aiExtracted });
    return { handled: true, reply, flow: state.flow, active: true };
  }

  if (/^(cancel|exit|stop|quit|abort)$/i.test(clean)) {
    const flowLabel = getFlowDefinition(state.flow, ctx)?.label || state.flow;
    if (state.assignmentId && ctx.supabase) {
      try {
        await cancelPendingAssignment({ supabase: ctx.supabase, assignmentId: state.assignmentId, ownerId: ctx.profile?.id });
      } catch { /* pending request already closed */ }
    }
    session.quiz = null;
    const reply = await renderOutcome({
      flowLabel,
      success: false,
      facts: { cancelled: true, note: 'The user cancelled the flow. Confirm it is cancelled and invite them to continue whenever ready.' },
      language: ctx.language,
      countryInfo: ctx.countryInfo,
      profile: ctx.profile
    });
    return { handled: true, reply, flow: state.flow, cancelled: true };
  }

  if (/^(restart|start over|reset)$/i.test(clean)) {
    const flowKey = state.flow;
    if (state.assignmentId && ctx.supabase) {
      try {
        await cancelPendingAssignment({ supabase: ctx.supabase, assignmentId: state.assignmentId, ownerId: ctx.profile?.id });
      } catch { /* pending request already closed */ }
    }
    session.quiz = null;
    // Do NOT re-ingest the control word ("Reset") as quiz data.
    startQuiz({ session, flowKey, ctx: { ...ctx, aiExtracted: {} } });
    state = session.quiz;
    const reply = await askCurrent(state, ctx);
    return { handled: true, reply, flow: flowKey, active: true };
  }

  // "Already told you" can never pause the quiz on a compliance step: the quiz
  // engine answers it from the STORED record instead (v1.16.2), so the user is
  // never bounced into a generic conversational reply and back to the same ask.
  const pendingForFrustration = state.phase === 'question'
    ? nextField(getFlowDefinition(state.flow, ctx) || { fields: [] }, state.answers)
    : null;
  const complianceFrustration = Boolean(
    pendingForFrustration
    && (pendingForFrustration.key === 'minimal_compliance' || pendingForFrustration.key.startsWith('compliance_'))
    && /\b(already|as i said|i (?:did|sent|gave|shared)|same (?:as|one)|told you)\b/i.test(clean)
  );

  // Quiz ↔ Conversation arbitration: greetings, questions and help are NOT
  // quiz answers. Pause here; the route answers conversationally and nudges
  // the user back to the pending question.
  if (!complianceFrustration
      && (state.phase === 'question' || state.phase === 'confirm')
      && shouldPauseQuizForChat({ messageText: clean, intent: ctx.intent, quiz: state })) {
    return { handled: false, pausedForChat: true, flow: state.flow };
  }

  // Mid-OTP escape hatch: "change email" re-asks ONLY the email field so a user
  // who used the wrong inbox leaves the code loop deterministically.
  const pendingField = state.phase === 'question' ? nextField(getFlowDefinition(state.flow, ctx), state.answers) : null;
  if (isChangeEmailRequest(clean) && pendingField?.kind === 'otp' && state.flow !== 'vehicle_registration') {
    delete state.answers[pendingField.key];
    delete state.answers.driver_email;
    delete state.answers.owner_email;
    state.otp = null;
    state.otpDispatch = null;
    state.otpDispatchAttempts = 0;
    state.phase = 'question';
    state.lastAcceptedAnswer = null;
    state.turnNote = 'The user wants a different email address. Do not ask for a code now; ask only for the new email address.';
    const reply = await askCurrent(state, { ...ctx, aiExtracted, answers: state.answers });
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const def = getFlowDefinition(state.flow, ctx);
  if (!def) {
    session.quiz = null;
    return { handled: false };
  }
  const vctx = { ...ctx, answers: state.answers };

  // Extra-notes catch-all: details that do not map to a database column can
  // be attached explicitly ("Note: always serviced at Shell") and are
  // compiled into the record's notes on save.
  const explicitNote = clean.match(/^(?:note|extra note|remember)[:\s]+(.+)$/i);
  if (explicitNote && state.phase === 'question') {
    state.extraNotes = mergeExtraNotes(state.extraNotes || [], [explicitNote[1]]);
    state.turnNote = 'The extra note was stored with this draft. Do not claim the whole record was saved.';
    const reply = await askCurrent(state, vctx);
    return { handled: true, reply, flow: state.flow, active: true };
  }

  if (state.phase === 'pin') {
    const result = await handleTransferPin(state, clean, ctx);
    if (result.completed || result.cancelled) session.quiz = null;
    return result;
  }

  if (state.phase === 'account_otp') {
    const result = await handleAccountOtp(state, clean, ctx);
    if (result.completed || result.cancelled) session.quiz = null;
    return result;
  }

  if (state.phase === 'assignment_otp') {
    const result = await handleAssignmentOtp(state, clean, ctx);
    if (result.completed || result.cancelled) session.quiz = null;
    return result;
  }

  if (state.phase === 'confirm') {
    const result = await handleConfirmation(state, def, clean, vctx, aiExtracted);
    if (result.completed || result.cancelled) session.quiz = null;
    return result;
  }

  const current = nextField(def, state.answers);
  if (!current) {
    state.phase = 'confirm';
    const reply = await askCurrent(state, vctx);
    return { handled: true, reply, flow: state.flow, active: true };
  }

  // "Already told you" recovery (v1.16.2): never loop on a compliance item.
  // Runs BEFORE parsing so it also covers messages whose text parses into an
  // invalid value. If the user says they already provided it, answer from what
  // is STORED instead of re-asking the same question.
  if (current.key === 'minimal_compliance' || current.key.startsWith('compliance_')) {
    const alreadyGiven = /\b(already|as i said|i (?:did|sent|gave|shared)|same (?:as|one)|told you)\b/i.test(clean);
    if (alreadyGiven) {
      const stored = current.key === 'minimal_compliance'
        ? ctx.driverGate?.status?.minimal
        : (ctx.driverGate?.status?.additional || []).find((row) => `compliance_${row.type}` === current.key);
      let line;
      if (stored?.status === 'valid') {
        state.answers[current.key] = {
          ok: true,
          lifetime: Boolean(stored.lifetime),
          expiry: stored.expiry || null,
          number: stored.number || null,
          alreadyOnFile: true
        };
        line = `You already gave me this - it is on file and valid${stored.expiry ? ` until ${stored.expiry}` : ''}. Let's move on.`;
      } else if (stored) {
        line = `I have it on file but it shows as ${stored.status}${stored.expiry ? ` (${stored.expiry})` : ''}. Please send a current ${current.label} so renewal reminders stay accurate.`;
      } else {
        line = `I could not match that to a stored ${current.label}. Please send it once as "number + expiry" (e.g. "DL-1234567 expires 15 Dec 2028").`;
      }
      state.lastAcceptedAnswer = line;
      state.turnNote = 'Acknowledge the stored compliance honestly, never claim a write, and ask only for what is genuinely missing.';
      const reply = await askCurrent(state, vctx);
      return { handled: true, reply, flow: state.flow, active: true };
    }
  }

  // OTP resend request — offered on ANY OTP turn, whichever path re-rendered it
  // (first ask, expired code or mismatch), so the user is never stuck.
  if (current.kind === 'otp' && isResendRequest(clean)) {
    await sendQuizOtp(state, def, vctx);
    const reply = await askOtp(state, vctx, state.otp ? 'A fresh code has been sent.' : `Could not send a code: ${state.otpError || 'unknown error'}`);
    return { handled: true, reply, flow: state.flow, active: true };
  }

  // An OTP already accepted for this code stays accepted: a repeated (or extra)
  // code in a longer message never triggers the code question again.
  if (current.kind === 'otp' && state.otpVerified && state.otp) {
    const repeated = (String(clean).match(/\b\d{6}\b/) || [])[0] || null;
    if (repeated && repeated === String(state.otp.code)) {
      state.answers[current.key] = true;
      state.lastAcceptedAnswer = 'Email verification code confirmed';
      state.turnNote = 'The email is already verified — say so briefly and ask only the next question.';
      // Licence/expiry volunteered in the same message still fills the next field.
      applyExtraction(state, def, aiExtracted || {}, vctx);
      applyTextExtraction(state, def, clean, vctx);
      const reply = await askCurrent(state, vctx);
      return { handled: true, reply, flow: state.flow, active: true };
    }
  }

  // Owner self-profile may skip the email OTP step (a gated driver may not).
  if (current.kind === 'otp' && ctx.driverSelfProfile && isSkipInput(clean)) {
    state.answers[current.key] = null;
    state.emailSkipped = true;
    state.lastAcceptedAnswer = 'Email verification skipped for now';
    state.turnNote = 'Confirm the email step is skipped for now and ask only the next question.';
    const reply = await askCurrent(state, vctx);
    return { handled: true, reply, flow: state.flow, active: true };
  }

  // Skip an optional field (or the whole optional group)
  if (isSkipInput(clean) && current.optional) {
    if (current.group) {
      for (const f of activeFields(def, state.answers)) {
        if (f.group === current.group && !(f.key in state.answers)) state.answers[f.key] = null;
      }
    } else {
      state.answers[current.key] = null;
    }
    state.lastAcceptedAnswer = `${current.label}: skipped`;
    const reply = await askCurrent(state, vctx);
    return { handled: true, reply, flow: state.flow, active: true };
  }

  // PARAGRAPH MODE (v1.16.0): a pasted paragraph is read for ALL remaining
  // fields at once (deterministic + AI) instead of only the current question.
  // Nothing is written here — the confirmation gate stays untouched.
  const remainingActive = activeFields(def, state.answers).filter((f) => !(f.key in state.answers));
  const sentenceBreaks = (clean.match(/[.;\n]/g) || []).length;
  const looksLikeParagraph = clean.length >= 80 || sentenceBreaks >= 2;
  if (looksLikeParagraph && remainingActive.length >= 2 && isSubstantiveText(clean)) {
    const natural = await extractWithAI({ text: clean, flowDef: def, answers: state.answers, ctx: vctx });
    let paragraphFilled = 0;
    for (const [key, value] of Object.entries(natural.fields || {})) {
      if (key in state.answers && state.answers[key] !== undefined) continue;
      state.answers[key] = value;
      paragraphFilled += 1;
    }
    if (natural.extraNotes?.length) {
      state.extraNotes = mergeExtraNotes(state.extraNotes || [], natural.extraNotes);
    }
    if (paragraphFilled > 0) {
      const nextAfter = nextField(def, state.answers);
      // If the paragraph also answered the CURRENT question, advance directly;
      // otherwise fall through to the normal strict parse for this field.
      if (!nextAfter || nextAfter.key !== current.key) {
        state.extractionFailures = 0;
        state.lastAcceptedAnswer = `Captured ${paragraphFilled} detail(s) from your paragraph`;
        state.turnNote = 'Acknowledge the details captured from the paragraph briefly. Do not claim anything was saved.';
        const reply = await askCurrent(state, vctx);
        return { handled: true, reply, flow: state.flow, active: true };
      }
    }
  }

  // Extract the answer: AI structured value first, then the field parser
  let rawValue = null;
  for (const alias of current.aliases) {
    const candidate = aiExtracted?.[alias];
    if (candidate !== null && candidate !== undefined && candidate !== '') {
      rawValue = candidate;
      break;
    }
  }

  let parsed = rawValue !== null ? current.parse(String(rawValue), vctx, state.answers) : null;
  if (parsed === null || parsed === undefined) parsed = current.parse(clean, vctx, state.answers);

  if (parsed === null || parsed === undefined) {
    // Capture any other safe values volunteered in this message, then re-ask.
    applyTextExtraction(state, def, clean, vctx);

    // Natural conversational parsing: when the strict parser cannot read the
    // sentence, let Saka AI extract ANY remaining fields plus extra notes from
    // the same message before we ever re-ask. Nothing is written to the
    // database here - the mandatory summary/confirmation gate is unchanged.
    if (isSubstantiveText(clean)) {
      const natural = await extractWithAI({
        text: clean,
        flowDef: def,
        answers: state.answers,
        ctx: vctx
      });
      let naturalFilled = 0;
      for (const [key, value] of Object.entries(natural.fields || {})) {
        if (key in state.answers && state.answers[key] !== undefined) continue;
        state.answers[key] = value;
        naturalFilled += 1;
      }
      if (natural.extraNotes?.length) {
        state.extraNotes = mergeExtraNotes(state.extraNotes || [], natural.extraNotes);
      }
      if (naturalFilled > 0) {
        state.extractionFailures = 0;
        state.lastAcceptedAnswer = `Captured ${naturalFilled} detail(s) from your message`;
        state.turnNote = 'Acknowledge the details captured from the message briefly. Do not claim anything was saved.';
        const reply = await askCurrent(state, vctx);
        return { handled: true, reply, flow: state.flow, active: true };
      }
    }
    // If the message reads like conversation rather than an answer, hand the
    // turn back to the conversational engine instead of nagging.
    if (shouldPauseQuizForChat({ messageText: clean, intent: ctx.intent, quiz: state })) {
      return { handled: false, pausedForChat: true, flow: state.flow };
    }
    state.lastAcceptedAnswer = null;
    state.turnNote = 'The last message was not a valid answer for this question. Do not pretend it was answered; ask again clearly.';
    const reply = await askCurrent(state, vctx, current.optional
      ? 'That answer was not understood — try again or reply Skip.'
      : 'That answer was not understood — please try again.');
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const check = current.validate(parsed, vctx, state.answers);
  if (!check.ok) {
    applyTextExtraction(state, def, clean, vctx);
    if (shouldPauseQuizForChat({ messageText: clean, intent: ctx.intent, quiz: state })) {
      return { handled: false, pausedForChat: true, flow: state.flow };
    }
    state.lastAcceptedAnswer = null;
    state.turnNote = 'The last message was not a valid answer for this question. Do not pretend it was answered; ask again clearly.';
    const reply = await askCurrent(state, vctx, check.message);
    return { handled: true, reply, flow: state.flow, active: true };
  }

  // OTP fields must match the code we dispatched
  if (current.kind === 'otp') {
    if (!state.otp || state.otp.expiresAt < Date.now()) {
      await sendQuizOtp(state, def, vctx);
      state.lastAcceptedAnswer = null;
      state.turnNote = 'The previous code expired. Do not acknowledge it; ask for the new code.';
      const reply = await askOtp(state, vctx, 'That code expired — a new one has been sent.');
      return { handled: true, reply, flow: state.flow, active: true };
    }
    if (String(parsed) !== String(state.otp.code)) {
      state.lastAcceptedAnswer = null;
      state.turnNote = 'The code did not match. Do not acknowledge it as accepted; ask the user to retry or resend.';
      const reply = await askOtp(state, vctx, 'That code did not match. Please re-check your inbox or reply "resend".');
      return { handled: true, reply, flow: state.flow, active: true };
    }
    state.answers[current.key] = true;
    state.otpVerified = true;
    state.lastAcceptedAnswer = 'Email verification code confirmed';

    // v1.16.2 — bank anything else in the same message (e.g. the licence number
    // and expiry pasted next to the code) so Saka never asks for it again.
    const bankingText = String(clean).replace(/\b\d{6}\b/, ' ').replace(/\s+/g, ' ').trim();
    if (bankingText.length >= 6 && isSubstantiveText(bankingText)) {
      let banked = 0;
      // Deterministic first (no AI cost): each remaining field's own parser.
      for (const f of activeFields(def, state.answers)) {
        if (f.kind === 'otp') continue;
        if (f.key in state.answers && state.answers[f.key] !== undefined) continue;
        try {
          const candidate = f.parse(bankingText, { ...vctx, answers: state.answers }, state.answers);
          if (candidate === null || candidate === undefined) continue;
          if (!f.validate(candidate, { ...vctx, answers: state.answers }, state.answers).ok) continue;
          state.answers[f.key] = candidate;
          banked += 1;
        } catch { /* keep trying the next field */ }
      }
      // AI top-up only when the strict parsers could not read the remainder.
      if (banked === 0) {
        const banking = await extractWithAI({ text: bankingText, flowDef: def, answers: state.answers, ctx: vctx });
        for (const [key, value] of Object.entries(banking.fields || {})) {
          if (key in state.answers && state.answers[key] !== undefined) continue;
          state.answers[key] = value;
          banked += 1;
        }
        if (banking.extraNotes?.length) {
          state.extraNotes = mergeExtraNotes(state.extraNotes || [], banking.extraNotes);
        }
      }
      if (banked > 0) {
        state.lastAcceptedAnswer = `Email verified + ${banked} detail(s) captured from the same message`;
        state.turnNote = 'Confirm the email is verified and that the details sent with the code were captured. Ask only what is still missing.';
      }
    }
  } else {
    state.answers[current.key] = parsed;
    state.extractionFailures = 0;
    state.lastAcceptedAnswer = `${current.label}: ${current.summary(parsed, vctx, state.answers)}`;
  }

  // Fast-forward any other values carried in the same message
  applyExtraction(state, def, aiExtracted || {}, vctx);
  applyTextExtraction(state, def, clean, vctx);

  const reply = await askCurrent(state, vctx);
  return { handled: true, reply, flow: state.flow, active: true };
}


async function handleConfirmation(state, def, clean, ctx, aiExtracted) {
  if (isYes(clean)) {
    if (state.flow === 'assign_driver') {
      return startAssignmentOtp(state, def, ctx);
    }
    if (state.flow === 'delete_account') {
      await sendQuizOtp(state, def, ctx);
      if (!state.otp) {
        state.phase = 'confirm';
        const reply = await renderOutcome({
          flowLabel: def.label,
          success: false,
          facts: { error: state.otpError || 'Could not dispatch the verification code.' },
          language: ctx.language,
          countryInfo: ctx.countryInfo,
          profile: ctx.profile
        });
        return { handled: true, reply, flow: state.flow, active: true };
      }
      state.phase = 'account_otp';
      const reply = await askOtp(state, ctx);
      return { handled: true, reply, flow: state.flow, active: true };
    }

    return executeFlow(state, ctx);
  }

  if (isNo(clean)) {
    const reply = await renderOutcome({
      flowLabel: def.label,
      success: false,
      facts: { cancelled: true, note: 'The user declined the confirmation. Confirm the flow was not saved and invite them back anytime.' },
      language: ctx.language,
      countryInfo: ctx.countryInfo,
      profile: ctx.profile
    });
    return { handled: true, reply, flow: state.flow, cancelled: true };
  }

  const changed = applyCorrections(state, def, aiExtracted || {}, ctx);
  if (changed.length === 0 && isSubstantiveText(clean)) {
    state.extraNotes = mergeExtraNotes(state.extraNotes || [], [clean]);
  }
  const extraNoteLines = (state.extraNotes || []).map((n) => `Extra note: ${n}`);
  const reply = await renderConfirmationSummary({
    flowLabel: def.label,
    summaryRows: buildSummaryRows(def, state.answers, ctx),
    notes: changed.length
      ? [`Updated from your correction: ${changed.join(', ')}.`, ...extraNoteLines]
      : [`The user replied "${clean}". Ask which field they want to change, or whether to confirm.`, ...extraNoteLines],
    language: ctx.language,
    countryInfo: ctx.countryInfo,
    profile: ctx.profile
  });

  return { handled: true, reply, flow: state.flow, active: true };
}

async function handleAccountOtp(state, clean, ctx) {
  const def = getFlowDefinition(state.flow, ctx);

  if (isResendRequest(clean)) {
    await sendQuizOtp(state, def, ctx);
    const reply = await askOtp(state, ctx, state.otp ? 'A fresh code has been sent.' : 'Could not send a code — please try again.');
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const provided = (String(clean).match(/\b\d{6}\b/) || [])[0] || null;
  if (!provided || !state.otp || state.otp.expiresAt < Date.now() || provided !== String(state.otp.code)) {
    const reply = await askOtp(state, ctx, 'That code did not match or expired. Reply with the 6 digits or type "resend".');
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const res = await executeFlow(state, ctx);
  return res;
}

async function handleTransferPin(state, clean, ctx) {
  if (/^(resend|resend pin|new pin|send again)$/i.test(clean)) {
    const reply = await renderOutcome({
      flowLabel: 'Passbook transfer',
      success: false,
      facts: {
        note: 'The release PIN is emailed by the transfer service. Ask the owner to check their inbox and reply with the 6-digit PIN, or type cancel.',
        error: undefined
      },
      language: ctx.language,
      countryInfo: ctx.countryInfo,
      profile: ctx.profile
    });
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const pin = (String(clean).match(/\b\d{6}\b/) || [])[0] || null;
  if (!pin) {
    const reply = await renderOutcome({
      flowLabel: 'Passbook transfer',
      success: false,
      facts: { note: 'Ask the owner to reply with the 6-digit release PIN from their email, or type cancel.' },
      language: ctx.language,
      countryInfo: ctx.countryInfo,
      profile: ctx.profile
    });
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const res = await verifyOwnerReleaseOtpAndNotifyBuyer({
    transferId: state.transfer?.transferId,
    providedOtp: pin,
    supabase: ctx.supabase,
    sendWhatsAppFn: ctx.sendWhatsApp
  });

  if (!res.success) {
    const reply = await renderOutcome({
      flowLabel: 'Passbook transfer',
      success: false,
      facts: { error: res.error || 'The release PIN could not be verified.', note: 'Ask the owner to try again or type cancel.' },
      language: ctx.language,
      countryInfo: ctx.countryInfo,
      profile: ctx.profile
    });
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const reply = await renderOutcome({
    flowLabel: 'Passbook transfer',
    success: true,
    facts: {
      asset: state.transfer?.plateNumber,
      buyerPhone: res.buyerPhone || state.answers.buyer_phone,
      nextStep: 'The buyer was notified on WhatsApp and must reply ACCEPT to claim ownership.'
    },
    language: ctx.language,
    countryInfo: ctx.countryInfo,
    profile: ctx.profile
  });
  return { handled: true, reply, flow: state.flow, completed: true };
}


/* ------------------------------------------------------------------ */
/* Flow execution (all writes happen only after user confirmation)     */
/* ------------------------------------------------------------------ */

async function executeFlow(state, ctx) {
  const a = state.answers;
  const def = getFlowDefinition(state.flow, ctx);
  const label = def?.label || state.flow;
  const vehicle = (ctx.vehicles || []).find((v) => v.id === a.vehicle_id) || null;
  const base = { language: ctx.language, countryInfo: ctx.countryInfo, profile: ctx.profile };
  const ok = (facts) => renderOutcome({ flowLabel: label, success: true, facts, ...base });
  const fail = (error, extra = {}) => renderOutcome({ flowLabel: label, success: false, facts: { error, ...extra }, ...base });

  try {
    switch (state.flow) {
      case 'vehicle_registration': {
        const saved = await persistVehicleRegistration(state, ctx);
        if (!saved.success) {
          const reply = await fail(saved.error);
          return { handled: true, reply, flow: state.flow, active: true };
        }
        // v1.16.4 — every NEW owner starts the full-featured welcome trial
        // (one per account lifetime; lapse returns the account to Free).
        let welcomeTrial = null;
        try {
          welcomeTrial = await startWelcomeTrial({ supabase: ctx.supabase, ownerId: ctx.profile?.id });
        } catch { welcomeTrial = null; }
        // Trial activation #1: vehicle registered + passbook issued.
        try {
          await recordActivationEvent({
            supabase: ctx.supabase,
            ownerId: ctx.profile?.id,
            event: ACTIVATION_EVENTS.VEHICLE_REGISTERED
          });
        } catch { /* activation is best-effort */ }
        const reply = await ok({
          vehicle: saved.plate,
          vin: saved.vin,
          makeModel: saved.makeModel,
          year: saved.yom,
          odometer: saved.mileage,
          email: saved.email,
          passbookToken: saved.token,
          ...(welcomeTrial?.started
            ? {
              trialDays: welcomeTrial.days,
              trialEndsAt: formatDate(welcomeTrial.endsAt, buildGlobalContext(ctx.countryInfo, ctx.profile).locale)
            }
            : {})
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'email_update': {
        if (!ctx.profile?.id) return { handled: true, reply: await fail('Profile not found.'), flow: state.flow, active: true };
        const { error } = await ctx.supabase.from('profiles').update({
          email: a.new_email,
          email_verified: true,
          updated_at: new Date().toISOString()
        }).eq('id', ctx.profile.id);
        if (error) return { handled: true, reply: await fail(error.message), flow: state.flow, active: true };

        await ctx.supabase.from('vehicles')
          .update({ owner_email: a.new_email, updated_at: new Date().toISOString() })
          .eq('owner_id', ctx.profile.id)
          .is('deleted_at', null);

        const reply = await ok({ email: a.new_email, verified: true });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'assign_driver': {
        // Assignments are only created after the owner verifies the WhatsApp
        // OTP in the assignment_otp phase. Direct execution must never bypass it.
        const reply = await fail('Please confirm the assignment so we can send the verification code.');
        return { handled: true, reply, flow: state.flow, active: true };
      }


      case 'unassign_driver': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const previous = vehicle.metadata?.odometer_at_assignment
          ?? vehicle.current_mileage
          ?? vehicle.odometer_reading
          ?? null;
        const released = await unassignDriverFromVehicle({ vehicleId: vehicle.id, supabase: ctx.supabase });
        if (released && released.success === false) {
          return { handled: true, reply: await fail(released.error), flow: state.flow, active: true };
        }
        const metadata = {
          ...(vehicle.metadata || {}),
          odometer_at_release: a.odometer_at_release,
          released_at: new Date().toISOString(),
          last_driver_phone: vehicle.metadata?.assigned_driver_phone || null
        };
        await ctx.supabase.from('vehicles').update({
          current_mileage: a.odometer_at_release,
          odometer_reading: a.odometer_at_release,
          metadata,
          updated_at: new Date().toISOString()
        }).eq('id', vehicle.id);

        const reply = await ok({
          vehicle: vehicle.plate_number,
          handbackOdometer: a.odometer_at_release,
          distanceDriven: previous !== null ? Math.max(0, a.odometer_at_release - previous) : undefined,
          status: 'Vehicle is now available for a new driver.'
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'transfer_seller': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };

        const init = await initiatePassbookTransfer({
          fromPhone: ctx.formattedPhone,
          vehicleCandidate: vehicle.plate_number,
          supabase: ctx.supabase
        });
        if (!init.success) return { handled: true, reply: await fail(init.error), flow: state.flow, active: true };

        const buyerStep = await setBuyerDetailsAndSendReleaseOtp({
          transferId: init.transferId,
          buyerPhone: a.buyer_phone,
          buyerEmail: a.buyer_email,
          supabase: ctx.supabase
        });
        if (!buyerStep.success) return { handled: true, reply: await fail(buyerStep.error), flow: state.flow, active: true };

        const metadata = {
          ...(vehicle.metadata || {}),
          odometer_at_transfer: a.odometer_at_transfer,
          transfer_initiated_at: new Date().toISOString()
        };
        await ctx.supabase.from('vehicles').update({
          current_mileage: a.odometer_at_transfer,
          odometer_reading: a.odometer_at_transfer,
          metadata,
          updated_at: new Date().toISOString()
        }).eq('id', vehicle.id);

        state.transfer = { transferId: init.transferId, plateNumber: vehicle.plate_number };
        state.phase = 'pin';

        const reply = await renderQuizQuestion({
          flowLabel: label,
          fieldLabel: '6-digit release PIN',
          hint: `We emailed the release PIN to ${buyerStep.ownerEmail}. Reply with the 6 digits to authorize releasing ${vehicle.plate_number} to ${a.buyer_phone}, or type cancel.`,
          answers: a,
          collectedLabels: [],
          language: ctx.language,
          countryInfo: ctx.countryInfo,
          profile: ctx.profile,
          isFirst: false,
          isLast: true
        });
        return { handled: true, reply, flow: state.flow, active: true };
      }


      case 'subscription_upgrade': {
        const ownerId = ctx.profile?.id;
        if (!ownerId) return { handled: true, reply: await fail('Profile not found.'), flow: state.flow, active: true };
        const tierKey = normalizeTierKey(a.subscription_tier);
        const interval = a.billing_interval === 'monthly' ? 'monthly' : 'annual';
        const trial = await startAccountTrial({ supabase: ctx.supabase, ownerId, tierKey, interval });

        if (trial.started) {
          const reply = await ok({
            plan: getTierLabel(tierKey),
            billing: interval,
            trialDays: trial.days,
            trialEnds: formatDate(trial.endsAt, buildGlobalContext(ctx.countryInfo, ctx.profile).locale),
            cardRequired: false,
            note: 'Your full trial is unlocked — no card is needed until you decide to convert.'
          });
          return { handled: true, reply, flow: state.flow, completed: true };
        }

        if (trial.reason === 'trial_active') {
          const reply = await ok({
            plan: getTierLabel(trial.tierKey || tierKey),
            billing: interval,
            trialDaysLeft: trial.daysLeft,
            trialEnds: trial.endsAt,
            note: 'Your trial is already running.'
          });
          return { handled: true, reply, flow: state.flow, completed: true };
        }

        const checkout = await checkoutForTier({
          supabase: ctx.supabase,
          owner: {
            id: ownerId,
            phone_number: ctx.formattedPhone || ctx.profile?.phone_number,
            email: ctx.profile?.email
          },
          targetTierKey: tierKey,
          interval,
          currency: ctx.countryInfo?.currency || 'USD',
          couponCode: a.coupon_code || null
        });
        if (!checkout.ok) {
          return { handled: true, reply: await fail(checkout.error), flow: state.flow, active: true };
        }
        const reply = await ok({
          plan: getTierLabel(tierKey),
          billing: interval,
          checkoutUrl: checkout.checkoutUrl,
          payable: checkout.priceInfo?.formattedPrice,
          coupon: checkout.coupon?.code,
          trialUsed: trial.reason === 'trial_already_used'
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'cancel_subscription': {
        const ownerId = ctx.profile?.id;
        if (!ownerId) return { handled: true, reply: await fail('Profile not found.'), flow: state.flow, active: true };
        if (a.confirm !== 'yes') {
          const reply = await ok({ status: 'kept', note: 'No changes — your plan stays active.' });
          return { handled: true, reply, flow: state.flow, completed: true };
        }
        const cancelled = await cancelSubscription({ supabase: ctx.supabase, ownerId, profile: ctx.profile });
        if (!cancelled.ok) return { handled: true, reply: await fail(cancelled.error), flow: state.flow, active: true };
        const reply = await ok({
          status: cancelled.trial ? 'cancelled now (trial)' : 'cancellation scheduled',
          accessUntil: cancelled.effectiveAt
            ? formatDate(cancelled.effectiveAt, buildGlobalContext(ctx.countryInfo, ctx.profile).locale)
            : null,
          note: cancelled.trial
            ? 'No payment was taken during the trial.'
            : 'You keep full access until the paid period ends, then move to Free.'
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'keep_vehicles': {
        const ownerId = ctx.profile?.id;
        if (!ownerId) return { handled: true, reply: await fail('Profile not found.'), flow: state.flow, active: true };
        const kept = await selectVehiclesToKeep({
          supabase: ctx.supabase,
          ownerId,
          keepVehicleIds: [a.keep_vehicle_id]
        });
        if (!kept.ok) return { handled: true, reply: await fail(kept.error), flow: state.flow, active: true };
        const reply = await ok({
          activeVehicles: (kept.resumed || []).join(', '),
          capacity: kept.capacity,
          note: 'Other vehicles are paused — history and passbook tokens are preserved.'
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'log_expense': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const { error: logErr } = await ctx.supabase.from('expense_logs').insert([{
          vehicle_id: vehicle.id,
          driver_id: ctx.profile?.id,
          expense_type: a.expense_type,
          amount: a.amount,
          fuel_liters: a.fuel_liters || 0,
          odometer_reading: a.odometer_reading,
          notes: [a.notes, formatExtraNotes(state.extraNotes || [])].filter(Boolean).join(' | ') || null,
        }]);
        if (logErr) return { handled: true, reply: await fail(logErr.message), flow: state.flow, active: true };

        // Trial activation #2: first expense logged (no-op outside trials).
        try {
          await recordActivationEvent({
            supabase: ctx.supabase,
            ownerId: ctx.profile?.id,
            event: ACTIVATION_EVENTS.EXPENSE_LOGGED
          });
        } catch { /* activation is best-effort */ }

        await ctx.supabase.from('expenses').insert([{
          plate: vehicle.plate_number,
          expense_type: a.expense_type,
          amount: a.amount,
          liters: a.fuel_liters || 0,
          odometer_reading: a.odometer_reading
        }]);

        if (a.odometer_reading > Number(vehicle.current_mileage || 0)) {
          await ctx.supabase.from('vehicles').update({
            current_mileage: a.odometer_reading,
            odometer_reading: a.odometer_reading,
            updated_at: new Date().toISOString()
          }).eq('id', vehicle.id);
        }

        const reply = await ok({
          vehicle: vehicle.plate_number,
          category: a.expense_type,
          amount: formatMoney(a.amount, buildGlobalContext(ctx.countryInfo, ctx.profile).currency),
          volume: a.fuel_liters ? `${a.fuel_liters} L` : undefined,
          odometer: a.odometer_reading,
          notes: a.notes || undefined
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'log_earnings': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const noteParts = [`Odometer: ${a.odometer_reading} km`];
        if (a.period) noteParts.push(`Period: ${a.period}`);
        const compiledEarningNotes = formatExtraNotes(state.extraNotes || []);
        if (compiledEarningNotes) noteParts.push(compiledEarningNotes);
        const { error } = await ctx.supabase.from('private_earnings').insert([{
          vehicle_id: vehicle.id,
          driver_id: ctx.profile?.id,
          revenue_amount: a.amount,
          currency: ctx.countryInfo?.currency || 'USD',
          notes: noteParts.join(' | '),
          logged_at: new Date().toISOString()
        }]);
        if (error) return { handled: true, reply: await fail(error.message), flow: state.flow, active: true };

        if (a.odometer_reading > Number(vehicle.current_mileage || 0)) {
          await ctx.supabase.from('vehicles').update({
            current_mileage: a.odometer_reading,
            odometer_reading: a.odometer_reading,
            updated_at: new Date().toISOString()
          }).eq('id', vehicle.id);
        }

        const reply = await ok({
          vehicle: vehicle.plate_number,
          revenue: formatMoney(a.amount, buildGlobalContext(ctx.countryInfo, ctx.profile).currency),
          odometer: a.odometer_reading,
          period: a.period || undefined
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'log_mileage': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const { error } = await ctx.supabase.from('vehicles').update({
          current_mileage: a.odometer_reading,
          odometer_reading: a.odometer_reading,
          updated_at: new Date().toISOString()
        }).eq('id', vehicle.id);
        if (error) return { handled: true, reply: await fail(error.message), flow: state.flow, active: true };

        // Odometer monitoring: evaluate active distance reminders immediately
        // so approaching/overdue alerts reach the owner without waiting for
        // the background sweep.
        try {
          await evaluateVehicleReminders({
            supabase: ctx.supabase,
            vehicle: { ...vehicle, current_mileage: a.odometer_reading, odometer_reading: a.odometer_reading },
            sendFn: typeof ctx.sendWhatsApp === 'function' ? ctx.sendWhatsApp : null
          });
        } catch (remErr) {
          console.warn('[quizEngine] Reminder evaluation skipped:', remErr.message);
        }

        const reply = await ok({ vehicle: vehicle.plate_number, odometer: a.odometer_reading });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'log_operating_hours': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const nowIso = new Date().toISOString();
        const { error } = await ctx.supabase.from('vehicles').update({
          operating_hours: a.hours,
          hours_updated_at: nowIso,
          updated_at: nowIso
        }).eq('id', vehicle.id);
        if (error) return { handled: true, reply: await fail(error.message), flow: state.flow, active: true };

        try {
          await evaluateVehicleReminders({
            supabase: ctx.supabase,
            vehicle: { ...vehicle, operating_hours: a.hours },
            sendFn: typeof ctx.sendWhatsApp === 'function' ? ctx.sendWhatsApp : null
          });
        } catch (remErr) {
          console.warn('[quizEngine] Hours reminder evaluation skipped:', remErr.message);
        }

        const reply = await ok({ vehicle: vehicle.plate_number, operatingHours: `${formatNumber(a.hours)} operating hours` });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'edit_vehicle': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const column = EDITABLE_VEHICLE_FIELDS[a.edit_field];
        if (!column) return { handled: true, reply: await fail('That field cannot be edited.'), flow: state.flow, active: true };

        const updates = { [column]: a.new_value };
        if (column === 'current_mileage') updates.odometer_reading = a.new_value;
        if (column === 'yom') updates.year_of_manufacture = a.new_value;

        const sanitized = sanitizeVehicleUpdates(updates);
        if (sanitized.rejected.length > 0) {
          return { handled: true, reply: await fail('VIN and passbook token are permanently locked and cannot be edited.'), flow: state.flow, active: true };
        }

        const res = await updateVehicleDetails({
          vehicleId: vehicle.id,
          requesterId: ctx.profile?.id,
          updates: sanitized.updates,
          supabase: ctx.supabase
        });
        if (!res.success) return { handled: true, reply: await fail(res.error), flow: state.flow, active: true };

        // Keep the universal expiry engine in step with edited compliance dates.
        const linkedCategory = {
          insurance_expiry: 'insurance',
          inspection_expiry: 'inspection',
          road_license_expiry: 'licensing',
          permit_expiry: 'permit'
        }[column];
        if (linkedCategory) {
          const timeZone = resolveUserTimezone({ countryInfo: ctx.countryInfo, profile: ctx.profile });
          const spec = buildExpirySpecFromDate(a.new_value, { timeZone });
          if (spec.ok) {
            const reminderType = {
              insurance: 'Insurance Renewal',
              inspection: 'Inspection',
              licensing: 'Road License',
              permit: 'Permit'
            }[linkedCategory];
            await createExpiryReminder({
              supabase: ctx.supabase,
              vehicle,
              profileId: ctx.profile?.id,
              reminderType,
              category: linkedCategory,
              spec,
              timeZone,
              linkedColumn: `vehicles.${column}`
            });
          }
        }

        const reply = await ok({ vehicle: vehicle.plate_number, field: a.edit_field, newValue: a.new_value });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'edit_profile': {
        if (!ctx.profile?.id) return { handled: true, reply: await fail('Profile not found.'), flow: state.flow, active: true };
        const updates = {};
        if (a.profile_field === 'Full name') updates.full_name = String(a.new_value).trim();
        if (a.profile_field === 'Language') {
          updates.preferred_language = String(a.new_value).trim().replace(/\b\w/g, (c) => c.toUpperCase());
        }
        if (a.profile_field === 'Unit system') {
          updates.unit_system = /imperial|miles|gallons/i.test(a.new_value) ? 'imperial' : 'metric';
        }
        updates.updated_at = new Date().toISOString();

        const { error } = await ctx.supabase.from('profiles').update(updates).eq('id', ctx.profile.id);
        if (error) return { handled: true, reply: await fail(error.message), flow: state.flow, active: true };

        const reply = await ok({ field: a.profile_field, newValue: a.new_value });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'delete_vehicle': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const res = await deleteVehicle({ vehicleId: vehicle.id, requesterId: ctx.profile?.id, supabase: ctx.supabase });
        if (!res.success) return { handled: true, reply: await fail(res.error), flow: state.flow, active: true };

        const reply = await ok({
          vehicle: vehicle.plate_number,
          driverUnassigned: res.cleanup?.driverUnassigned ? 'yes' : 'none',
          transfersCancelled: res.cleanup?.transfersCancelled || 0,
          auditNote: 'Historical logs preserved; VIN trial ledger retained.'
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }


      case 'delete_account': {
        const nowIso = new Date().toISOString();
        if (ctx.profile?.id) {
          await ctx.supabase.from('vehicles')
            .update({ deleted_at: nowIso, status: 'DELETED', assigned_driver_id: null, updated_at: nowIso })
            .eq('owner_id', ctx.profile.id)
            .is('deleted_at', null);
          await ctx.supabase.from('profiles')
            .update({ is_active: false, deleted_at: nowIso, updated_at: nowIso })
            .eq('id', ctx.profile.id);
        }
        await ctx.supabase.from('chat_history').delete().eq('user_phone', ctx.senderPhone);
        await ctx.supabase.from('chat_transcripts').delete().eq('phone_number', ctx.senderPhone);
        await ctx.supabase.from('processed_webhooks').delete().eq('phone_number', ctx.senderPhone);

        const reply = await ok({
          status: 'Account soft-deleted, vehicles released and sessions cleared.',
          auditNote: 'Historical audit logs retained for compliance. Reply REGISTER to start again.'
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'apply_coupon': {
        const couponCode = String(a.coupon_code || '').toUpperCase().trim();
        // v1.16.0 — trial extensions are ACCOUNT-bound. Trial coupons redeem
        // through the account trial engine (45-day lifetime cap); subscription
        // discount coupons keep the legacy checkout flow.
        let couponType = null;
        try {
          const { data: couponRow } = await ctx.supabase
            .from('coupons')
            .select('applicable_to')
            .eq('code', couponCode)
            .maybeSingle();
          couponType = couponRow?.applicable_to || null;
        } catch { couponType = null; }

        if (couponType === 'account_trial_extension' || couponType === 'trial_extension') {
          const extended = await applyAccountTrialExtensionCoupon({
            supabase: ctx.supabase,
            ownerId: ctx.profile.id,
            code: couponCode
          });
          if (!extended.ok) return { handled: true, reply: await fail(extended.error), flow: state.flow, active: true };
          const reply = await ok({
            couponCode: extended.couponCode,
            daysAdded: extended.daysAdded,
            accountTrialEnds: formatDate(extended.endsAt, buildGlobalContext(ctx.countryInfo, ctx.profile).locale),
            scope: 'Account trial — applies to the whole fleet, not one vehicle'
          });
          return { handled: true, reply, flow: state.flow, completed: true };
        }

        const res = await applyTrialExtensionCoupon({
          phone: ctx.formattedPhone,
          couponCode: a.coupon_code,
          supabase: ctx.supabase
        });
        if (!res.success) return { handled: true, reply: await fail(res.error), flow: state.flow, active: true };

        const reply = await ok({
          vehicle: res.plateNumber,
          couponCode: res.couponCode || a.coupon_code,
          daysAdded: res.daysAdded,
          newTrialEnd: res.newTrialEndAt ? formatDate(res.newTrialEndAt, buildGlobalContext(ctx.countryInfo, ctx.profile).locale) : undefined
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'set_reminder': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const due = a.due;
        const extraNotes = formatExtraNotes(state.extraNotes || []);
        if (due?.kind === 'date') {
          // Universal expiry reminder: insurance, inspection/MOT, licensing,
          // permits, driver licences and general deadlines share one ladder.
          const timeZone = due.timeZone || resolveUserTimezone({ countryInfo: ctx.countryInfo, profile: ctx.profile });
          const textCategory = due.category && due.category !== 'other' ? due.category : null;
          const category = textCategory || categoryForReminderType(a.reminder_type);
          const spec = due.dueAt
            ? { ok: true, kind: 'date', localDate: due.value, dueAt: due.dueAt, timeZone }
            : buildExpirySpecFromDate(due.value, { timeZone });
          const created = await createExpiryReminder({
            supabase: ctx.supabase,
            vehicle,
            profileId: ctx.profile?.id,
            reminderType: a.reminder_type,
            category,
            spec,
            notes: extraNotes,
            timeZone,
            linkedColumn: expiryLinkedColumn(category)
          });
          if (!created.ok) return { handled: true, reply: await fail(created.error), flow: state.flow, active: true };

          // The confirmation summary showed this timezone; persist it once the
          // user confirms so later dates resolve consistently.
          if (ctx.profile?.id && ctx.profile.timezone !== timeZone) {
            try {
              await ctx.supabase.from('profiles').update({
                timezone: timeZone,
                timezone_confirmed_at: new Date().toISOString()
              }).eq('id', ctx.profile.id);
            } catch (tzErr) {
              console.warn('[quizEngine] Timezone persistence skipped:', tzErr.message);
            }
          }

          const reply = await ok({
            vehicle: vehicle.plate_number,
            reminder: a.reminder_type,
            due: describeExpirySpec(spec, { locale: ctx.countryInfo?.locale || 'en-US' })
          });
          return { handled: true, reply, flow: state.flow, completed: true };
        }

        // Threshold-based (distance km/mi or operating hours): structured
        // columns let the monitoring engine track remaining values and
        // dispatch proactive alerts as the threshold approaches.
        const created = await createThresholdReminder({
          supabase: ctx.supabase,
          vehicle,
          profileId: ctx.profile?.id,
          reminderType: a.reminder_type,
          spec: due,
          notes: extraNotes
        });
        if (!created.ok) return { handled: true, reply: await fail(created.error), flow: state.flow, active: true };
        const reply = await ok({ vehicle: vehicle.plate_number, reminder: a.reminder_type, due: describeThresholdSpec(due) });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'driver_onboarding': {
        if (!ctx.profile?.id) return { handled: true, reply: await fail('Profile not found.'), flow: state.flow, active: true };
        if (!ctx.supabase) return { handled: true, reply: await fail('Database unavailable.'), flow: state.flow, active: true };

        const assigned = (ctx.vehicles || []).find((v) => v.assigned_driver_id === ctx.profile.id)
          || (ctx.activeVehicle?.assigned_driver_id === ctx.profile.id ? ctx.activeVehicle : null);
        const assetType = assigned?.asset_type || assigned?.metadata?.asset_type || null;
        const countryCode = ctx.countryInfo?.country_code || ctx.profile.country_code || 'GLOBAL';
        const timeZone = resolveUserTimezone({ countryInfo: ctx.countryInfo, profile: ctx.profile });

        const profileUpdates = {};
        if (a.full_name) profileUpdates.full_name = a.full_name;
        if (a.driver_email && state.otpVerified) {
          profileUpdates.email = a.driver_email;
          profileUpdates.email_verified = true;
        }
        if (Object.keys(profileUpdates).length > 0) {
          const { error } = await ctx.supabase.from('profiles')
            .update({ ...profileUpdates, updated_at: new Date().toISOString() })
            .eq('id', ctx.profile.id);
          if (error) return { handled: true, reply: await fail(error.message), flow: state.flow, active: true };
        }

        const catalog = await getComplianceCatalog({ supabase: ctx.supabase, countryCode, assetType });
        const minimal = catalog.minimal;
        const parsedMinimal = a.minimal_compliance;
        // v1.16.0 — an OWNER building their own profile may skip the licence
        // step (Saka keeps nudging). A gated DRIVER may never skip it.
        const minimalSkipped = Boolean(ctx.driverSelfProfile) && (parsedMinimal === null || parsedMinimal === undefined);
        if (!parsedMinimal?.ok && !minimalSkipped) {
          delete state.answers.minimal_compliance;
          state.phase = 'question';
          return { handled: true, reply: await fail(`Please send your ${minimal.label} number and expiry.`), flow: state.flow, active: true };
        }

        let minimalRes = { ok: true, skipped: true };
        if (!minimalSkipped) {
          minimalRes = await submitDriverCompliance({
            supabase: ctx.supabase,
            driverId: ctx.profile.id,
            item: minimal,
            parsed: parsedMinimal,
            isMinimal: true,
            countryCode,
            assetType,
            timeZone
          });
          if (!minimalRes.ok) {
            delete state.answers.minimal_compliance;
            state.phase = 'question';
            return { handled: true, reply: await fail(minimalRes.error), flow: state.flow, active: true };
          }
        }

        const collected = [];
        for (const item of catalog.additional || []) {
          const parsed = a[`compliance_${item.type}`];
          if (!parsed?.ok) continue;
          const submitted = await submitDriverCompliance({
            supabase: ctx.supabase,
            driverId: ctx.profile.id,
            item,
            parsed,
            isMinimal: false,
            countryCode,
            assetType,
            timeZone
          });
          if (submitted.ok) collected.push(item.label);
        }

        const status = await getDriverComplianceStatus({ supabase: ctx.supabase, driverId: ctx.profile.id, countryCode, assetType });
        // v1.16.0 — owner driver-profile bookkeeping (best-effort flag update).
        try {
          const completed = Boolean(status.canManage);
          await ctx.supabase.from('profiles').update({
            driver_profile_pending: !completed,
            ...(completed ? { driver_profile_completed_at: new Date().toISOString() } : {}),
            updated_at: new Date().toISOString()
          }).eq('id', ctx.profile.id);
        } catch { /* flags are best-effort */ }
        let ownerReported = false;
        if (status.canManage) {
          const assignment = await getActiveAssignment({ supabase: ctx.supabase, driverId: ctx.profile.id, vehicleId: assigned?.id });
          if (assignment) {
            const report = await notifyOwnerComplianceCleared({ supabase: ctx.supabase, assignment, status });
            ownerReported = Boolean(report?.sent);
          }
        }

        const reply = await ok({
          driver: profileUpdates.full_name || ctx.profile.full_name || 'Driver',
          email: status.emailVerified ? 'verified' : 'pending',
          compliance: `${status.minimal.label} ${status.minimal.valid ? 'valid' : status.minimal.status}`,
          additional: collected.length ? collected.join(', ') : 'None yet (optional)',
          gate: status.canManage ? 'open — you can now manage the vehicle' : 'still closed until the missing items are provided',
          ownerReport: ownerReported ? 'owner notified' : 'owner report pending'
        });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'contact_support': {
        await sendSupportEscalationEmail({
          userPhone: ctx.formattedPhone,
          userEmail: ctx.profile?.email,
          userName: ctx.profile?.full_name,
          subscriptionTier: ctx.profile?.subscription_tier,
          issueParagraph: a.description,
          vehiclesList: ctx.vehicles || []
        });
        const reply = await ok({ status: 'Forwarded to support@sakafleet.com.', description: a.description });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      case 'reactivate_account': {
        if (!ctx.profile?.id) return { handled: true, reply: await fail('Profile not found.'), flow: state.flow, active: true };
        const { error } = await ctx.supabase.from('profiles').update({
          is_active: true,
          deleted_at: null,
          updated_at: new Date().toISOString()
        }).eq('id', ctx.profile.id);
        if (error) return { handled: true, reply: await fail(error.message), flow: state.flow, active: true };

        const reply = await ok({ status: 'Account reactivated. Existing VIN trials remain unchanged.' });
        return { handled: true, reply, flow: state.flow, completed: true };
      }

      default: {
        const reply = await fail('This flow is not available yet.');
        return { handled: true, reply, flow: state.flow, active: true };
      }
    }
  } catch (err) {
    const reply = await fail(err.message || 'Unexpected error');
    return { handled: true, reply, flow: state.flow, active: true };
  }
}


/* ------------------------------------------------------------------ */
/* Vehicle registration persistence                                    */
/* ------------------------------------------------------------------ */

async function persistVehicleRegistration(state, ctx) {
  const a = state.answers;
  if (!ctx.supabase || !ctx.profile?.id) {
    return { success: false, error: 'Profile or database unavailable.' };
  }

  const tier = await checkOwnerVehicleTierLimit({
    ownerId: ctx.profile.id,
    subscriptionTier: ctx.profile.subscription_tier || 'free',
    supabase: ctx.supabase
  });
  if (!tier.canAdd) {
    return { success: false, error: `Your current plan allows ${tier.limit} vehicle(s). Please upgrade to add more.` };
  }

  const token = `SK-PASSBOOK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  // v1.16.0: the VIN registry records asset provenance only — trials bind to
  // the owner account (profiles.trial_used_at + trial_sessions), never to a VIN.
  await ensureVinRegistryEntry({ vin: a.vin, ownerId: ctx.profile.id, supabase: ctx.supabase });
  const unitSystem = buildGlobalContext(ctx.countryInfo, ctx.profile).unitSystem;

  const record = {
    owner_id: ctx.profile.id,
    plate_number: a.plate_number,
    make_model: a.make_model,
    yom: a.yom,
    year_of_manufacture: a.yom,
    owner_email: a.owner_email,
    fuel_type: a.fuel_type,
    current_mileage: a.current_mileage,
    odometer_reading: a.current_mileage,
    owner_phone: ctx.formattedPhone,
    status: 'ACTIVE',
    vin: a.vin,
    asset_type: /electric|ev/i.test(a.fuel_type) ? 'EV' : (/hybrid/i.test(a.fuel_type) ? 'HYBRID' : 'ICE'),
    unit_system: unitSystem,
    qr_passbook_token: token,
    custom_attributes: a.custom_attributes || {},
    metadata: {
      role: 'Owner',
      vin_locked: true,
      vin_locked_at: new Date().toISOString(),
      onboarding_completed_at: new Date().toISOString(),
      onboarding_flow: 'quiz_v2'
    }
  };

  const optionalMap = {
    insurance_expiry: 'insurance_expiry',
    insurance_policy: 'insurance_policy',
    inspection_expiry: 'inspection_expiry',
    color: 'color',
    transmission: 'transmission',
    engine_number: 'engine_number',
    tire_size: 'tire_size',
    purchase_cost: 'purchase_cost'
  };
  for (const [answerKey, column] of Object.entries(optionalMap)) {
    if (a[answerKey] !== null && a[answerKey] !== undefined && a[answerKey] !== '') {
      record[column] = a[answerKey];
    }
  }

  const compiledExtraNotes = formatExtraNotes(state.extraNotes || []);
  if (compiledExtraNotes) {
    record.other_details = [record.other_details, compiledExtraNotes].filter(Boolean).join(' | ');
    record.metadata = { ...(record.metadata || {}), extra_notes: state.extraNotes };
  }

  const { error: insertErr } = await ctx.supabase.from('vehicles').insert([record]);
  if (insertErr) {
    if (insertErr.code === '23505') {
      return { success: false, error: `Plate ${a.plate_number} or VIN ${a.vin} is already registered.` };
    }
    return { success: false, error: insertErr.message };
  }

  await ctx.supabase.from('profiles').update({
    email: a.owner_email,
    email_verified: true,
    updated_at: new Date().toISOString()
  }).eq('id', ctx.profile.id);

  // v1.16.0: registration never schedules a VIN-bound extension coupon.
  // trialEngine schedules account-bound extension offers when a trial starts.

  try {
    await sendPassbookWelcomeEmail({
      targetEmail: a.owner_email,
      plateNumber: a.plate_number,
      makeModel: a.make_model,
      yom: a.yom,
      vin: a.vin,
      token,
      fuelType: a.fuel_type,
      mileage: a.current_mileage
    });
  } catch (emailErr) {
    console.warn('[quizEngine] Passbook email skipped:', emailErr.message);
  }

  const { data: savedVehicle } = await ctx.supabase
    .from('vehicles')
    .select('id')
    .eq('plate_number', a.plate_number)
    .maybeSingle();

  if (savedVehicle?.id) {
    // VEHICLE compliance (separate from driver compliance): seed the asset
    // ledger + linked expiry reminder through one engine.
    const registrationTimeZone = resolveUserTimezone({ countryInfo: ctx.countryInfo, profile: ctx.profile });
    const assetType = /electric|ev/i.test(a.fuel_type) ? 'EV' : (/hybrid/i.test(a.fuel_type) ? 'HYBRID' : 'ICE');
    const countryCode = ctx.countryInfo?.country_code || ctx.profile.country_code || 'GLOBAL';
    const vehicleCatalog = resolveVehicleComplianceCatalog({ countryCode, assetType });
    const seeds = [
      { type: 'insurance', expiry: a.insurance_expiry, number: a.insurance_policy || null },
      { type: 'inspection', expiry: a.inspection_expiry, number: null }
    ];
    for (const seed of seeds) {
      if (!seed.expiry) continue;
      const item = vehicleCatalog.items.find((entry) => entry.type === seed.type);
      if (!item) continue;
      await submitVehicleCompliance({
        supabase: ctx.supabase,
        vehicle: { id: savedVehicle.id, plate_number: a.plate_number },
        item,
        parsed: { ok: true, lifetime: false, expiry: seed.expiry, number: seed.number },
        countryCode,
        assetType,
        ownerId: ctx.profile.id,
        timeZone: registrationTimeZone
      });
    }
  }

  return {
    success: true,
    plate: a.plate_number,
    vin: a.vin,
    makeModel: a.make_model,
    yom: a.yom,
    mileage: a.current_mileage,
    email: a.owner_email,
    token
  };
}


/* ------------------------------------------------------------------ */
/* Flow detection                                                      */
/* ------------------------------------------------------------------ */

export function detectQuizStart({
  intent,
  messageText = '',
  hasVehicleRegistered = false,
  isRegisterCommand = false,
  hasVehicleAttributes = false,
  driverOnboardingPending = false
}) {
  const text = String(messageText).trim();

  if (!hasVehicleRegistered) {
    if (isRegisterCommand || intent === 'REGISTER_VEHICLE' || intent === 'ONBOARDING_INPUT' || intent === 'VERIFY_OTP' || hasVehicleAttributes) {
      return 'vehicle_registration';
    }
    return null;
  }

  // A newly accepted driver must finish email verification + minimal compliance
  // before any vehicle management flow can start.
  if (driverOnboardingPending) return 'driver_onboarding';

  const intentMap = {
    ASSIGN_DRIVER: 'assign_driver',
    UNASSIGN_DRIVER: 'unassign_driver',
    TRANSFER_PASSBOOK: 'transfer_seller',
    LOG_EXPENSE: 'log_expense',
    LOG_EARNINGS: 'log_earnings',
    UPDATE_MILEAGE: 'log_mileage',
    LOG_OPERATING_HOURS: 'log_operating_hours',
    EDIT_VEHICLE: 'edit_vehicle',
    EDIT_PROFILE: 'edit_profile',
    DELETE_VEHICLE: 'delete_vehicle',
    DELETE_ACCOUNT: 'delete_account',
    SET_REMINDER: 'set_reminder',
    UPDATE_EMAIL: 'email_update',
    CONTACT_SUPPORT: 'contact_support',
    REACTIVATE_ACCOUNT: 'reactivate_account',
    UPGRADE_SUBSCRIPTION: 'subscription_upgrade',
    CANCEL_SUBSCRIPTION: 'cancel_subscription',
    KEEP_VEHICLE: 'keep_vehicles'
  };

  // Explicit deterministic commands win over AI intent — this prevents
  // "Set reminder. Oil change in 2500km" from being misread as LOG_EXPENSE.
  if (/^(?:driver\s+profile|my\s+driver\s+profile|complete\s+(?:my\s+)?driver\s+profile|driver\s+licen[cs]e|my\s+licen[cs]e)$/i.test(text)) return 'driver_onboarding';
  if (/^(?:remind|reminder|set\s+reminder|remind\s+me)\b/i.test(text)) return 'set_reminder';
  if (/^(?:log|record)\s+(?:an?\s+)?(?:expense|fuel|refuel)\b/i.test(text)) return 'log_expense';
  if (/^(?:log|record)\s+(?:an?\s+)?(?:earning|earnings|income|revenue)\b/i.test(text)) return 'log_earnings';
  if (/^(?:update|set)\s+(?:the\s+)?(?:odometer|mileage)\b/i.test(text)) return 'log_mileage';
  if (/^(?:log|record|update|set)\s+(?:the\s+)?(?:operating|engine|machine|running)?\s*hours?\b/i.test(text)) return 'log_operating_hours';
  if (/^transfer\s+passbook\b/i.test(text)) return 'transfer_seller';
  if (/^(?:assign\s+driver|assign)\b/i.test(text)) return 'assign_driver';
  if (/^(?:unassign\s+driver|remove\s+driver)\b/i.test(text)) return 'unassign_driver';
  if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(text)) return 'edit_vehicle';
  if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:profile|details|name|language|units?|settings)\b/i.test(text)) return 'edit_profile';
  if (/^(?:delete|remove)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(text)) return 'delete_vehicle';
  if (/^(?:delete|deactivate|close)\s+(?:my\s+)?account\b/i.test(text)) return 'delete_account';
  if (/^(?:update\s+email|change\s+email|new\s+email)\b/i.test(text)) return 'email_update';

  // AI intent is only consulted when no explicit command pattern matched.
  if (intentMap[intent]) return intentMap[intent];

  return null;
}

export default {
  handleQuizTurn,
  startQuiz,
  detectQuizStart,
  detectFlowSwitch,
  getActiveQuiz,
  clearQuiz,
  getFlowDefinition,
  getCurrentQuizField,
  shouldPauseQuizForChat,
  QUIZ_FLOW_KEYS
};


