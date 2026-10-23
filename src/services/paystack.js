import crypto from 'crypto';

export const SUBSCRIPTION_TIERS = {
  free: {
    id: 'free',
    name: 'Free',
    vehicleLimit: 1,
    hasPremiumFeatures: false,
    pricing: {
      monthlyUSD: 0,
      annualUSD: 0
    }
  },
  solo_pro: {
    id: 'solo_pro',
    name: 'Solo Pro',
    vehicleLimit: 2,
    hasPremiumFeatures: true,
    pricing: {
      monthlyUSD: 7.99,
      annualUSD: 67.12
    }
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    vehicleLimit: 5,
    hasPremiumFeatures: true,
    pricing: {
      monthlyUSD: 16.99,
      annualUSD: 142.72
    }
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    vehicleLimit: 10,
    hasPremiumFeatures: true,
    pricing: {
      monthlyUSD: 32.99,
      annualUSD: 277.12
    }
  },
  unlimited: {
    id: 'unlimited',
    name: 'Unlimited',
    vehicleLimit: Infinity,
    hasPremiumFeatures: true,
    pricing: {
      monthlyUSD: 69.99,
      annualUSD: 587.92
    }
  }
};

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
 * Calculates local price and currency display formatting for a given tier and billing interval
 */
export async function getTierLocalPrice(supabase, tierKey, currency = 'USD', interval = 'monthly') {
  const tier = SUBSCRIPTION_TIERS[tierKey] || SUBSCRIPTION_TIERS.free;
  if (tierKey === 'free') {
    return {
      tierKey: 'free',
      tierName: 'Free',
      usdPrice: 0,
      localPrice: 0,
      currency: currency,
      formattedPrice: 'Free ($0)'
    };
  }

  const usdPrice = interval === 'annual' ? tier.pricing.annualUSD : tier.pricing.monthlyUSD;
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
 * Initialize a Paystack Checkout session and return authorization URL
 */
export async function initializePaystackCheckout({
  supabase,
  userPhone,
  targetTierKey,
  billingInterval = 'monthly',
  userEmail,
  userId,
  currency = 'KES'
}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is missing in environment variables');
  }

  const priceInfo = await getTierLocalPrice(supabase, targetTierKey, currency, billingInterval);

  const amountSubunits = Math.round(priceInfo.localPrice * 100);

  const cleanPhone = userPhone ? userPhone.replace(/[^\d+]/g, '') : '';
  const emailToUse = userEmail || `${cleanPhone.replace(/\+/g, '') || 'user'}@sakafleet.com`;

  const payload = {
    email: emailToUse,
    amount: amountSubunits,
    currency: priceInfo.currency,
    metadata: {
      phone_number: cleanPhone,
      target_tier: targetTierKey,
      billing_interval: billingInterval,
      user_id: userId || null
    },
    callback_url: 'https://sakafleet.com/payment-success'
  };

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
    priceInfo
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
