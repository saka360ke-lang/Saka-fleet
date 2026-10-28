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
  renderOutcome
} from './conversationEngine.js';
import {
  buildGlobalContext,
  userDistanceToKm,
  kmToUserDistance,
  formatDate,
  formatMoney,
  formatNumber
} from './globalization.js';
import { sendEmailOtp, sendMfaEmail, sendSupportEscalationEmail, sendPassbookWelcomeEmail } from './mailer.js';
import {
  assignDriverToVehicle,
  unassignDriverFromVehicle,
  updateVehicleDetails,
  sanitizeVehicleUpdates,
  deleteVehicle,
  getOrCreateVinTrial,
  checkOwnerVehicleTierLimit
} from './vehicles.js';
import { scheduleTrialExtensionCoupon, applyTrialExtensionCoupon } from './coupons.js';
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

function parseDateValue(text) {
  const raw = String(text).trim();
  if (!raw) return null;
  const normalized = raw.replace(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/, (m, a, b, c) => {
    const year = c.length === 2 ? `20${c}` : c;
    return `${year}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  });
  const isoMatch = normalized.match(/\d{4}-\d{2}-\d{2}/);
  const ts = Date.parse(isoMatch ? isoMatch[0] : normalized);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toISOString().split('T')[0];
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
      parse: (text) => parseDateValue(text),
      validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send a valid date, or reply Skip.' })
    }),
    field('insurance_policy', 'Insurance policy number/provider', 'optional', {
      optional: true, group: 'optional', aliases: ['insurance_policy']
    }),
    field('inspection_expiry', 'Inspection / NTAC expiry date', 'e.g. 2027-03-01 (optional)', {
      optional: true, group: 'optional', aliases: ['inspection_expiry'],
      parse: (text) => parseDateValue(text),
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
  'Purchase cost': 'purchase_cost'
};

function editVehicleNewValueParser(editField) {
  if (['yom', 'current_mileage', 'purchase_cost'].includes(editField)) return parseNumber;
  if (['insurance_expiry', 'inspection_expiry'].includes(editField)) return parseDateValue;
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
  edit_vehicle: 'Vehicle edit',
  edit_profile: 'Profile update',
  delete_vehicle: 'Vehicle deletion',
  delete_account: 'Account deletion',
  apply_coupon: 'Trial coupon',
  set_reminder: 'Service reminder',
  contact_support: 'Support escalation',
  reactivate_account: 'Account reactivation'
};

export const QUIZ_FLOW_KEYS = Object.keys(FLOW_LABELS);

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
            { value: 'Full name', aliases: ['name', 'full name'] },
            { value: 'Language', aliases: ['language', 'preferred language'] },
            { value: 'Unit system', aliases: ['units', 'unit system', 'metric', 'imperial'] }
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
          choiceField('reminder_type', 'Reminder type', 'Service, Oil change, Insurance, Inspection or Other', [
            { value: 'Oil change', aliases: ['oil'] },
            { value: 'Service', aliases: ['service', 'maintenance'] },
            { value: 'Insurance Renewal', aliases: ['insurance'] },
            { value: 'Inspection', aliases: ['inspection', 'ntac'] },
            { value: 'Other', aliases: ['other'] }
          ]),
          field('due', 'Due date or odometer threshold', 'e.g. 2027-05-15 or 45000 km', {
            aliases: ['due', 'due_date', 'due_mileage'],
            parse: (text) => {
              const date = parseDateValue(text);
              if (date) return { kind: 'date', value: date };
              const num = parseNumber(text);
              if (num !== null && num > 0) return { kind: 'odometer', value: num };
              return null;
            },
            validate: (value) => (value ? { ok: true } : { ok: false, message: 'Please send a due date (YYYY-MM-DD) or an odometer reading.' }),
            summary: (value) => (value?.kind === 'date' ? value.value : value ? `${formatNumber(value.value)} km` : 'â€”')
          })
        ]
      };

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

function isSkipInput(text) {
  return /^(skip|later|not now|no thanks|none|na|n\/a|done|finish|that'?s all|no more|nothing else)$/i.test(String(text).trim());
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
    transfer: null,
    lastNote: null
  };

  applyExtraction(session.quiz, def, ctx.aiExtracted || {}, ctx);

  // Friction reduction: with a single registered vehicle, auto-select it
  // instead of asking the user to confirm an obvious choice.
  const vField = def.fields.find((f) => f.key === 'vehicle_id');
  if (vField && (ctx.vehicles || []).length === 1 && session.quiz.answers.vehicle_id === undefined) {
    const onlyId = ctx.vehicles[0].id;
    const check = vField.validate(onlyId, { ...ctx, answers: session.quiz.answers }, session.quiz.answers);
    if (check.ok) session.quiz.answers.vehicle_id = onlyId;
  }

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

  if (field.kind === 'otp' && (!state.otp || state.otp.expiresAt < Date.now())) {
    await sendQuizOtp(state, def, ctx);
  }

  state.lastNote = note;
  const rows = buildSummaryRows(def, state.answers, ctx);
  const upcoming = activeFields(def, state.answers).filter((f) => !(f.key in state.answers) || answersValueMissing(state.answers, f));
  return renderQuizQuestion({
    flowLabel: def.label,
    fieldLabel: field.label,
    hint: note ? `${field.hint} (${note})` : field.hint,
    answers: state.answers,
    collectedLabels: rows.map((r) => `${r.label}: ${r.value}`),
    language: ctx.language,
    countryInfo: ctx.countryInfo,
    profile: ctx.profile,
    isFirst: rows.length === 0,
    isLast: upcoming.length === 1 && upcoming[0].key === field.key
  });
}

function answersValueMissing(answers, f) {
  return !(f.key in answers) || answers[f.key] === undefined;
}

function confirmationNotes(state, ctx) {
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
async function sendQuizOtp(state, def, ctx) {
  const purpose = state.flow === 'email_update'
    ? 'email_update'
    : state.flow === 'delete_account'
      ? 'account_deletion'
      : 'registration';

  const target = purpose === 'email_update'
    ? state.answers.new_email
    : purpose === 'account_deletion'
      ? ctx.profile?.email
      : state.answers.owner_email;

  if (!target) return;

  const code = String(crypto.randomInt(100000, 1000000));
  try {
    if (purpose === 'account_deletion') await sendMfaEmail(target, code);
    else await sendEmailOtp(target, code);
    state.otp = { code, target, purpose, expiresAt: Date.now() + 10 * 60 * 1000 };
  } catch (err) {
    state.otp = null;
    state.otpError = err.message;
  }
}

function otpQuestionField() {
  return field('otp', '6-digit verification code', 'check your email inbox', {
    kind: 'otp',
    parse: (text) => (String(text).match(/\b\d{6}\b/) || [])[0] || null,
    validate: (value) => (/^\d{6}$/.test(String(value)) ? { ok: true } : { ok: false, message: 'Please send the 6-digit code.' })
  });
}

async function askOtp(state, ctx, note = null) {
  const target = state.otp?.target || ctx.profile?.email || state.answers.owner_email || state.answers.new_email;
  return renderQuizQuestion({
    flowLabel: getFlowDefinition(state.flow, ctx)?.label || state.flow,
    fieldLabel: '6-digit verification code',
    hint: note || `We emailed a code to ${target}. Reply with the 6 digits (or "resend" for a new code).`,
    answers: state.answers,
    collectedLabels: buildSummaryRows(getFlowDefinition(state.flow, ctx), state.answers, ctx).map((r) => `${r.label}: ${r.value}`),
    language: ctx.language,
    countryInfo: ctx.countryInfo,
    profile: ctx.profile,
    isFirst: false,
    isLast: true
  });
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

/**
 * Main entry point used by the WhatsApp route for every inbound message.
 * Returns { handled, reply } â€” handled=false means the message is not a quiz turn.
 */
export async function handleQuizTurn({
  session,
  messageText = '',
  aiExtracted = {},
  ctx = {},
  startFlow = null
}) {
  const clean = String(messageText || '').trim();
  let state = getActiveQuiz(session);

  if (!state) {
    if (!startFlow) return { handled: false };
    const started = startQuiz({ session, flowKey: startFlow, ctx: { ...ctx, aiExtracted } });
    if (!started) return { handled: false };
    state = session.quiz;
    const reply = await askCurrent(state, { ...ctx, aiExtracted });
    return { handled: true, reply, flow: state.flow, active: true };
  }

  if (/^(cancel|exit|stop|quit|abort)$/i.test(clean)) {
    const flowLabel = getFlowDefinition(state.flow, ctx)?.label || state.flow;
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
    session.quiz = null;
    startQuiz({ session, flowKey, ctx });
    state = session.quiz;
    const reply = await askCurrent(state, ctx);
    return { handled: true, reply, flow: flowKey, active: true };
  }

  const def = getFlowDefinition(state.flow, ctx);
  if (!def) {
    session.quiz = null;
    return { handled: false };
  }
  const vctx = { ...ctx, answers: state.answers };

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

  // Help/hint mid-quiz: re-ask only the current question
  if (/^(help|hint|what can i do|what do i do next|guide me)$/i.test(clean)) {
    const reply = await askCurrent(state, vctx, 'Here is the current question again.');
    return { handled: true, reply, flow: state.flow, active: true };
  }

  // OTP resend request
  if (current.kind === 'otp' && /^(resend|resend code|new code|send again)$/i.test(clean)) {
    await sendQuizOtp(state, def, vctx);
    const reply = await askOtp(state, vctx, state.otp ? 'A fresh code has been sent.' : `Could not send a code: ${state.otpError || 'unknown error'}`);
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
    const reply = await askCurrent(state, vctx);
    return { handled: true, reply, flow: state.flow, active: true };
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
    const reply = await askCurrent(state, vctx, current.optional
      ? 'That answer was not understood — try again or reply Skip.'
      : 'That answer was not understood — please try again.');
    return { handled: true, reply, flow: state.flow, active: true };
  }

  const check = current.validate(parsed, vctx, state.answers);
  if (!check.ok) {
    const reply = await askCurrent(state, vctx, check.message);
    return { handled: true, reply, flow: state.flow, active: true };
  }

  // OTP fields must match the code we dispatched
  if (current.kind === 'otp') {
    if (!state.otp || state.otp.expiresAt < Date.now()) {
      await sendQuizOtp(state, def, vctx);
      const reply = await askOtp(state, vctx, 'That code expired — a new one has been sent.');
      return { handled: true, reply, flow: state.flow, active: true };
    }
    if (String(parsed) !== String(state.otp.code)) {
      const reply = await askOtp(state, vctx, 'That code did not match. Please re-check your inbox or reply "resend".');
      return { handled: true, reply, flow: state.flow, active: true };
    }
    state.answers[current.key] = true;
    state.otpVerified = true;
  } else {
    state.answers[current.key] = parsed;
  }

  // Fast-forward any other values carried in the same message
  applyExtraction(state, def, aiExtracted || {}, vctx);

  const reply = await askCurrent(state, vctx);
  return { handled: true, reply, flow: state.flow, active: true };
}


async function handleConfirmation(state, def, clean, ctx, aiExtracted) {
  if (isYes(clean)) {
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
  const reply = await renderConfirmationSummary({
    flowLabel: def.label,
    summaryRows: buildSummaryRows(def, state.answers, ctx),
    notes: changed.length
      ? [`Updated from your correction: ${changed.join(', ')}.`]
      : [`The user replied "${clean}". Ask which field they want to change, or whether to confirm.`],
    language: ctx.language,
    countryInfo: ctx.countryInfo,
    profile: ctx.profile
  });

  return { handled: true, reply, flow: state.flow, active: true };
}

async function handleAccountOtp(state, clean, ctx) {
  const def = getFlowDefinition(state.flow, ctx);

  if (/^(resend|resend code|new code|send again)$/i.test(clean)) {
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
        const reply = await ok({
          vehicle: saved.plate,
          vin: saved.vin,
          makeModel: saved.makeModel,
          year: saved.yom,
          odometer: saved.mileage,
          email: saved.email,
          passbookToken: saved.token,
          trialEnds: formatDate(saved.trialEndAt, buildGlobalContext(ctx.countryInfo, ctx.profile).locale)
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
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const cleanPhone = a.driver_phone.startsWith('+') ? a.driver_phone : `+${a.driver_phone.replace(/[^\d]/g, '')}`;
        let { data: drvProfile } = await ctx.supabase.from('profiles').select('*').eq('phone_number', cleanPhone).maybeSingle();
        if (!drvProfile) {
          const { data: newDrv } = await ctx.supabase.from('profiles').insert([{
            id: crypto.randomUUID(),
            phone_number: cleanPhone,
            full_name: 'Fleet Driver',
            is_active: true,
            country: ctx.countryInfo?.country,
            country_code: ctx.countryInfo?.country_code,
            unit_system: ctx.countryInfo?.default_units || 'metric'
          }]).select().single();
          drvProfile = newDrv;
        }
        if (!drvProfile?.id) {
          return { handled: true, reply: await fail('Could not create the driver profile.'), flow: state.flow, active: true };
        }

        const assigned = await assignDriverToVehicle({ vehicleId: vehicle.id, driverId: drvProfile.id, supabase: ctx.supabase });
        if (!assigned.success) return { handled: true, reply: await fail(assigned.error), flow: state.flow, active: true };

        const metadata = {
          ...(vehicle.metadata || {}),
          odometer_at_assignment: a.odometer_at_assignment,
          assigned_at: new Date().toISOString(),
          assigned_driver_phone: cleanPhone
        };
        await ctx.supabase.from('vehicles').update({
          current_mileage: a.odometer_at_assignment,
          odometer_reading: a.odometer_at_assignment,
          metadata,
          updated_at: new Date().toISOString()
        }).eq('id', vehicle.id);

        const reply = await ok({
          vehicle: vehicle.plate_number,
          driver: cleanPhone,
          handoverOdometer: a.odometer_at_assignment,
          rule: 'Strict 1-to-1: this driver cannot hold another active vehicle until unassigned.'
        });
        return { handled: true, reply, flow: state.flow, completed: true };
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


      case 'log_expense': {
        if (!vehicle) return { handled: true, reply: await fail('Vehicle not found.'), flow: state.flow, active: true };
        const { error: logErr } = await ctx.supabase.from('expense_logs').insert([{
          vehicle_id: vehicle.id,
          driver_id: ctx.profile?.id,
          expense_type: a.expense_type,
          amount: a.amount,
          fuel_liters: a.fuel_liters || 0,
          odometer_reading: a.odometer_reading,
          notes: a.notes || null
        }]);
        if (logErr) return { handled: true, reply: await fail(logErr.message), flow: state.flow, active: true };

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

        const reply = await ok({ vehicle: vehicle.plate_number, odometer: a.odometer_reading });
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
        const isDate = due?.kind === 'date';
        const reminderType = isDate ? a.reminder_type : `${a.reminder_type} (at ${formatNumber(due?.value)} km)`;
        const { error } = await ctx.supabase.from('reminders').insert([{
          vehicle_id: vehicle.id,
          profile_id: ctx.profile?.id,
          reminder_type: reminderType,
          due_date: isDate ? due.value : null,
          status: 'active'
        }]);
        if (error) return { handled: true, reply: await fail(error.message), flow: state.flow, active: true };

        const reply = await ok({
          vehicle: vehicle.plate_number,
          reminder: a.reminder_type,
          due: isDate ? due.value : `at ${formatNumber(due?.value)} km`
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
  const trial = await getOrCreateVinTrial({ vin: a.vin, ownerId: ctx.profile.id, supabase: ctx.supabase });
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
    trial_start_at: trial.trialStartAt,
    trial_end_at: trial.trialEndAt,
    trial_status: trial.trialStatus,
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

  try {
    await scheduleTrialExtensionCoupon({
      vin: a.vin,
      ownerId: ctx.profile.id,
      ownerPhone: ctx.formattedPhone,
      ownerEmail: a.owner_email,
      trialEndAt: trial.trialEndAt,
      supabase: ctx.supabase
    });
  } catch (couponErr) {
    console.warn('[quizEngine] Coupon scheduling skipped:', couponErr.message);
  }

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
    if (a.insurance_expiry) {
      await ctx.supabase.from('reminders').insert([{
        vehicle_id: savedVehicle.id,
        profile_id: ctx.profile.id,
        reminder_type: 'Insurance Renewal',
        due_date: a.insurance_expiry,
        status: 'active'
      }]);
    }
    if (a.inspection_expiry) {
      await ctx.supabase.from('reminders').insert([{
        vehicle_id: savedVehicle.id,
        profile_id: ctx.profile.id,
        reminder_type: 'Inspection',
        due_date: a.inspection_expiry,
        status: 'active'
      }]);
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
    token,
    trialEndAt: trial.trialEndAt
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
  hasVehicleAttributes = false
}) {
  const text = String(messageText).trim();

  if (!hasVehicleRegistered) {
    if (isRegisterCommand || intent === 'REGISTER_VEHICLE' || intent === 'ONBOARDING_INPUT' || intent === 'VERIFY_OTP' || hasVehicleAttributes) {
      return 'vehicle_registration';
    }
    return null;
  }

  const intentMap = {
    ASSIGN_DRIVER: 'assign_driver',
    UNASSIGN_DRIVER: 'unassign_driver',
    TRANSFER_PASSBOOK: 'transfer_seller',
    LOG_EXPENSE: 'log_expense',
    LOG_EARNINGS: 'log_earnings',
    UPDATE_MILEAGE: 'log_mileage',
    EDIT_VEHICLE: 'edit_vehicle',
    EDIT_PROFILE: 'edit_profile',
    DELETE_VEHICLE: 'delete_vehicle',
    DELETE_ACCOUNT: 'delete_account',
    SET_REMINDER: 'set_reminder',
    UPDATE_EMAIL: 'email_update',
    CONTACT_SUPPORT: 'contact_support',
    REACTIVATE_ACCOUNT: 'reactivate_account'
  };

  if (intentMap[intent]) return intentMap[intent];

  // Natural-language fallbacks for explicit commands
  if (/^(?:assign\s+driver|assign)\b/i.test(text)) return 'assign_driver';
  if (/^(?:unassign\s+driver|remove\s+driver)\b/i.test(text)) return 'unassign_driver';
  if (/^(?:transfer\s+passbook|transfer\s+vehicle)\b/i.test(text)) return 'transfer_seller';
  if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(text)) return 'edit_vehicle';
  if (/^(?:edit|update|change|modify)\s+(?:my\s+)?(?:profile|details|name|language|units?|settings)\b/i.test(text)) return 'edit_profile';
  if (/^(?:delete|remove)\s+(?:my\s+)?(?:vehicle|car)\b/i.test(text)) return 'delete_vehicle';
  if (/^(?:delete|deactivate|close)\s+(?:my\s+)?account\b/i.test(text)) return 'delete_account';
  if (/^(?:remind|set\s+reminder|reminder)\b/i.test(text)) return 'set_reminder';
  if (/^(?:update\s+email|change\s+email|new\s+email)\b/i.test(text)) return 'email_update';

  return null;
}

export default {
  handleQuizTurn,
  startQuiz,
  detectQuizStart,
  getActiveQuiz,
  clearQuiz,
  getFlowDefinition,
  QUIZ_FLOW_KEYS
};


