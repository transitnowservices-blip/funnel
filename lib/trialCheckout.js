'use strict';
/**
 * lib/trialCheckout.js — auto-convert $1/day trial checkout (Davena-approved 2026-10-06).
 *
 * The trial is "$X today, then $100/month starting day N+1 unless you cancel":
 * a single Stripe Checkout Session in subscription mode containing TWO line
 * items:
 *   1. a one-time trial fee ($7 / $14 / $30 by tier) — charged TODAY.
 *   2. the $100/mo Complete subscription with trial_period_days = tier days —
 *      first $100 bills at trial end UNLESS the driver cancels first.
 * The card is collected once at trial signup, which is what makes the
 * auto-convert legal and automatic.
 *
 * The $100/mo Price ID is resolved at runtime via the Stripe API (list
 * active recurring prices, match 10000 cents / USD / monthly) and cached —
 * never hardcoded. If it cannot be found the checkout refuses loudly.
 *
 * Requires STRIPE_SECRET_KEY. Davena adds it to Render herself; until it is
 * set, trial checkout falls back to the one-time payment links (loud log).
 *
 * No-guarantee rule: copy describes access and billing only — never promises
 * work, loads, routes, contracts, hiring, approvals, income, or earnings.
 */

const TRIAL_TIER_CENTS = { 7: 700, 14: 1400, 30: 3000 };
const COMPLETE_MONTHLY_CENTS = 10000;
const TRIAL_SOURCE = 'transitnow-trial';

let _stripe = null;
let _keyWarned = false;
let _priceCache = null;

function stripeClient() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) {
    if (!_keyWarned) {
      console.warn('[trialCheckout] STRIPE_SECRET_KEY is not set — trial checkout falls back to one-time payment links; auto-convert is OFF until the key is configured.');
      _keyWarned = true;
    }
    return null;
  }
  _stripe = require('stripe')(key);
  return _stripe;
}

/** True when the API key is configured (auto-convert available). */
function isConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY || '');
}

/**
 * Resolve the live $100/mo Complete recurring Price ID. Cached after first
 * lookup. Throws loudly when missing — never silently substitutes.
 */
async function getCompletePriceId() {
  if (_priceCache) return _priceCache;
  const stripe = stripeClient();
  if (!stripe) {
    throw new Error('[trialCheckout] STRIPE_SECRET_KEY is not set — cannot resolve the Complete $100/mo price.');
  }
  const res = await stripe.prices.list({ active: true, type: 'recurring', limit: 100 });
  const hit = (res.data || []).find(
    (p) => Number(p.unit_amount) === COMPLETE_MONTHLY_CENTS &&
      p.currency === 'usd' &&
      p.recurring && p.recurring.interval === 'month'
  );
  if (!hit) {
    throw new Error('[trialCheckout] FAIL: no active USD $100/mo recurring price found in Stripe — refusing to create trial checkout. Create the price in Stripe first.');
  }
  console.log('[trialCheckout] resolved Complete $100/mo price', hit.id);
  _priceCache = hit.id;
  return hit.id;
}

function cleanTier(tierDays) {
  const d = Number(tierDays);
  return [7, 14, 30].includes(d) ? d : 7;
}

/** Renewal date for a tier: today + days, as a Date. */
function renewalDate(tierDays) {
  const d = cleanTier(tierDays);
  return new Date(Date.now() + d * 86400000);
}

function fmtDate(dt) {
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Create the auto-convert Checkout Session. Returns the session object
 * (with .url) or null when the key is missing (caller falls back).
 * Throws on API errors (caller logs + falls back).
 */
async function createTrialCheckoutSession({ email, firstName, tierDays, siteUrl }) {
  const stripe = stripeClient();
  if (!stripe) return null;
  const days = cleanTier(tierDays);
  const cents = TRIAL_TIER_CENTS[days];
  const priceId = await getCompletePriceId();
  const base = String(siteUrl || '').replace(/\/$/, '');
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: String(email || '').trim().toLowerCase(),
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: {
            name: `$1/Day Trial — ${days} days`,
            description: `Full Complete access for ${days} days. No guaranteed work, routes, or hiring — application guidance and hiring intel only.`,
          },
        },
        quantity: 1,
      },
      { price: priceId, quantity: 1 },
    ],
    subscription_data: {
      trial_period_days: days,
      metadata: { source: TRIAL_SOURCE, trial_days: String(days) },
    },
    metadata: {
      source: TRIAL_SOURCE,
      trial_days: String(days),
      trial_tier_cents: String(cents),
      first_name: String(firstName || '').slice(0, 80),
    },
    success_url: `${base}/trial/success?tier=${days}`,
    cancel_url: `${base}/trial?tier=${days}`,
  });
  console.log('[trialCheckout] session created', { email: String(email || '').trim().toLowerCase(), days, sessionId: session.id });
  return session;
}

/**
 * Create a Stripe customer-portal session for self-serve cancel/manage.
 * Returns the portal URL, or null when unavailable (caller falls back to
 * the "text Davena" instruction).
 */
async function createPortalSession(customerId, returnUrl) {
  const stripe = stripeClient();
  if (!stripe || !customerId) return null;
  try {
    const ps = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return ps.url || null;
  } catch (err) {
    console.warn('[trialCheckout] portal session failed (portal may not be configured in Stripe dashboard)', err.message);
    return null;
  }
}

module.exports = {
  TRIAL_TIER_CENTS,
  TRIAL_SOURCE,
  stripeClient,
  isConfigured,
  getCompletePriceId,
  cleanTier,
  renewalDate,
  fmtDate,
  createTrialCheckoutSession,
  createPortalSession,
};
