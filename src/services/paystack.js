import crypto from 'crypto';
import {
  TIER_MATRIX,
  normalizeTierKey,
  getTierPriceUSD
} from './subscriptionTiers.js';

/**
 * Backward-compatible tier view derived from the frozen registry
 * (`subscriptionTiers.js`). Existing callers read `vehicleLimit`,
 * `hasPremiumFeatures` and `pricing`; the registry is the single source.
 */
export const SUBSCRIPTION_TIERS = Object.freeze(
  Object.fromEntries(
    Object.values(TIER_MATRIX).map((tier) => [
      tier.key,
      Object.freeze({
        id: tier.key,
        name: tier.label,
        vehicleLimit: tier.baseLimit,
        hasPremiumFeatures: tier.hasPremiumFeatures,
        addonEligible: tier.addonEligible,
        pricing: { monthlyUSD: tier.monthlyUSD, annualUSD: tier.annualUSD }
      })
    ])
  )
);

const FALLBACK_EXCHANGE_RATES = {
  USD: 1.0,
  KES: 130.0,
  NGN: 1500.0,
  ZAR: 18.5,
  GBP: 0.77,
  EUR: 0.92,
  TZS: 2600.0,
  UGX: 3700.0,
  RWF: 1350.0,
  AUD: 1.50,
  INR: 84.0,
  AED: 3.67
};

/**
 * Fetch and cache exchange rates monthly with ±10% mid-month drift threshold
 */
export async function getEffectiveExchangeRate(supabase, currency = 'USD') {
  const cur = currency.toUpperCase();
  if (cur === 'USD') return 1.0;
  // No client (unit tests, offline reply paths): use the documented fallback
  // instead of attempting a database read and logging an error.
  if (!supabase) return FALLBACK_EXCHANGE_RATES[cur] || 1.0;

  try {
    const { data: cached } = await supabase
      .from('exchange_rates_cache')
      .select('*')
      .eq('currency', cur)
      .maybeSingle();

    const now = new Date();
    let liveRate = FALLBACK_EXCHANGE_RATES[cur] || 1.0;

    try {
      const res = await fetch('https://open.er-api.com/v6/latest/USD');
      if (res.ok) {
        const json = await res.json();
        if (json && json.rates && json.rates[cur]) {
          liveRate = Number(json.rates[cur]);
        }
      }
    } catch (apiErr) {
      console.warn(`Failed to fetch live exchange rate for ${cur}, using fallback/cached:`, apiErr.message);
    }

    if (!cached) {
      await supabase.from('exchange_rates_cache').insert([{
        currency: cur,
        baseline_rate: liveRate,
        current_rate: liveRate,
        last_monthly_reset: now.toISOString(),
        updated_at: now.toISOString()
      }]);
      return liveRate;
    }

    const lastReset = new Date(cached.last_monthly_reset);
    const daysSinceReset = (now - lastReset) / (1000 * 60 * 60 * 24);
    const baseline = Number(cached.baseline_rate);

    if (daysSinceReset >= 30) {
      await supabase.from('exchange_rates_cache').update({
        baseline_rate: liveRate,
        current_rate: liveRate,
        last_monthly_reset: now.toISOString(),
        updated_at: now.toISOString()
      }).eq('currency', cur);

      return liveRate;
    }

    const driftRatio = Math.abs(liveRate - baseline) / baseline;

    if (driftRatio <= 0.10) {
      await supabase.from('exchange_rates_cache').update({
        current_rate: liveRate,
        updated_at: now.toISOString()
      }).eq('currency', cur);

      return baseline;
    } else {
      await supabase.from('exchange_rates_cache').update({
        baseline_rate: liveRate,
        current_rate: liveRate,
        last_monthly_reset: now.toISOString(),
        updated_at: now.toISOString()
      }).eq('currency', cur);

      return liveRate;
    }
  } catch (err) {
    console.error(`Error in getEffectiveExchangeRate for ${cur}:`, err.message);
    return FALLBACK_EXCHANGE_RATES[cur] || 1.0;
  }
}

/**
 * v1.28.0 — display a USD list price in the user's currency.
 * Used by WhatsApp cards (add-on slots, upgrade prompts) so a Kenyan user never
 * sees a bare "$4.99" when checkout will charge KES.
 *
 * v1.28.1 — local currency ONLY: the dollar reference is never shown alongside
 * a local figure. USD users still see the dollar amount (cur === 'USD').
 */
export async function formatUsdInLocalCurrency(providedSupabase, usdAmount, currency = 'USD', locale = 'en-US') {
  const cur = String(currency || 'USD').toUpperCase();
  const amount = Number(usdAmount) || 0;
  if (cur === 'USD') return `$${amount.toFixed(2)}`;
  let rate = FALLBACK_EXCHANGE_RATES[cur] || 1;
  try {
    const live = await getEffectiveExchangeRate(providedSupabase, cur);
    if (Number.isFinite(Number(live)) && Number(live) > 0) rate = Number(live);
  } catch { /* fallback rate */ }
  const local = Math.round(amount * rate);
  return `${cur} ${local.toLocaleString(locale || 'en-US', { maximumFractionDigits: 0 })}`;
}


/**
 * Calculates local price and currency display formatting for a given tier and billing interval
 */
export async function getTierLocalPrice(supabase, tierKey, currency = 'USD', interval = 'monthly') {
  const canonical = normalizeTierKey(tierKey);
  const tier = SUBSCRIPTION_TIERS[canonical] || SUBSCRIPTION_TIERS.free;
  if (canonical === 'free') {
    return {
      tierKey: 'free',
      tierName: 'Free',
      usdPrice: 0,
      localPrice: 0,
      currency: currency,
      formattedPrice: 'Free ($0)',
      interval
    };
  }

  const usdPrice = getTierPriceUSD(canonical, interval);
  const rate = await getEffectiveExchangeRate(supabase, currency);
  let rawLocalPrice = usdPrice * rate;

  let localPrice = Math.round(rawLocalPrice);
  if (currency === 'USD') {
    localPrice = usdPrice;
  }

  const formattedPrice = `${currency} ${localPrice.toLocaleString()}`;

  return {
    tierKey,
    tierName: tier.name,
    usdPrice,
    localPrice,
    currency,
    formattedPrice,
    interval
  };
}

/**
 * Initialize a Paystack Checkout session.
 *
 * v1.15.0 additions:
 *  - `planCode`      → recurring subscription (Paystack plan; interval handled by Paystack)
 *  - `amountUSDOverride` → coupon-discounted first cycle (converted to the local currency)
 *  - `couponCode` / `addonQuantity` → metadata for the webhook state machine
 *  - `metadata`      → merged into Paystack metadata (owner id, phone, trial flag…)
 *
 * When no plan code is configured the checkout degrades to the legacy one-time
 * transaction (the webhook still activates the tier via `charge.success`).
 */
export async function initializePaystackCheckout({
  supabase,
  userPhone,
  targetTierKey,
  billingInterval = 'monthly',
  userEmail,
  userId,
  currency = 'KES',
  planCode = null,
  amountUSDOverride = null,
  couponCode = null,
  addonQuantity = null,
  metadata = {}
}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is missing in environment variables');
  }

  const canonicalTier = normalizeTierKey(targetTierKey);
  const priceInfo = await getTierLocalPrice(supabase, canonicalTier, currency, billingInterval);

  let localAmount = priceInfo.localPrice;
  if (amountUSDOverride !== null && amountUSDOverride !== undefined) {
    const usd = Math.max(0, Number(amountUSDOverride) || 0);
    if (String(priceInfo.currency).toUpperCase() === 'USD') {
      localAmount = usd;
    } else {
      const rate = await getEffectiveExchangeRate(supabase, priceInfo.currency);
      localAmount = Math.round(usd * rate);
    }
  }
  // Paystack rejects zero-amount charges: 100% coupons still need a token amount.
  const amountSubunits = Math.max(100, Math.round(Number(localAmount) * 100));

  const cleanPhone = userPhone ? userPhone.replace(/[^\d+]/g, '') : '';
  const emailToUse = userEmail || `${cleanPhone.replace(/\+/g, '') || 'user'}@sakafleet.com`;

  const payload = {
    email: emailToUse,
    amount: amountSubunits,
    currency: priceInfo.currency,
    metadata: {
      ...metadata,
      phone_number: cleanPhone,
      target_tier: canonicalTier,
      billing_interval: billingInterval === 'annual' ? 'annual' : 'monthly',
      user_id: userId || null,
      coupon_code: couponCode || null,
      addon_quantity: addonQuantity || null,
      recurring: Boolean(planCode)
    },
    callback_url: process.env.PAYSTACK_CALLBACK_URL || 'https://sakafleet.com/payment-success'
  };

  if (planCode) payload.plan = planCode;

  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const json = await response.json();
  if (!response.ok || !json.status) {
    throw new Error(json.message || 'Failed to initialize Paystack transaction');
  }

  return {
    checkoutUrl: json.data.authorization_url,
    accessCode: json.data.access_code,
    reference: json.data.reference,
    priceInfo: { ...priceInfo, localPrice: localAmount },
    recurring: Boolean(planCode)
  };
}

/**
 * Verify Paystack HMAC SHA512 Webhook Signature
 */
export function verifyPaystackSignature(rawBody, signatureHeader) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey || !signatureHeader) return false;

  const hash = crypto
    .createHmac('sha512', secretKey)
    .update(rawBody)
    .digest('hex');

  return hash === signatureHeader;
}

/**
 * Paystack recurring-subscription management (fail-soft: never throws).
 * All helpers return `{ ok, data, error }` so the request path can degrade.
 */
async function paystackRequest(path, { method = 'POST', body = null } = {}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return { ok: false, error: 'PAYSTACK_SECRET_KEY missing' };
  try {
    const res = await fetch(`https://api.paystack.co${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.status === false) {
      return { ok: false, error: json.message || `Paystack ${res.status}`, data: json.data || null };
    }
    return { ok: true, data: json.data || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Disable (cancel at period end) a subscription. Needs the email token. */
export async function disablePaystackSubscription({ code, token }) {
  if (!code || !token) return { ok: false, error: 'subscription code + email token required' };
  return paystackRequest('/subscription/disable', { body: { code, token } });
}

/** Re-enable a disabled subscription (undo cancel). */
export async function enablePaystackSubscription({ code, token }) {
  if (!code || !token) return { ok: false, error: 'subscription code + email token required' };
  return paystackRequest('/subscription/enable', { body: { code, token } });
}

/** Update plan and/or quantity (Fleet Command add-ons). */
export async function updatePaystackSubscription({ code, planCode = null, quantity = null }) {
  if (!code) return { ok: false, error: 'subscription code required' };
  const body = {};
  if (planCode) body.plan = planCode;
  if (quantity !== null && quantity !== undefined) body.quantity = Math.max(1, Math.floor(Number(quantity) || 1));
  return paystackRequest(`/subscription/${encodeURIComponent(code)}`, { method: 'PUT', body });
}

/** Fetch the authoritative Paystack view of a subscription. */
export async function fetchPaystackSubscription(code) {
  if (!code) return { ok: false, error: 'subscription code required' };
  return paystackRequest(`/subscription/${encodeURIComponent(code)}`, { method: 'GET' });
}

