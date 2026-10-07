'use strict';
/**
 * lib/trials.js — $1/day trial bookkeeping (Davena-designed 2026-10-06).
 *
 * Drivers buy a one-time trial block via Stripe payment links:
 *   $7  ->  7 days    (700 cents)
 *   $14 -> 14 days    (1400 cents)
 *   $30 -> 30 days    (3000 cents)
 * During the trial the driver gets FULL Complete-level access. When the
 * trial expires with no active dispatch subscription, paid actions hit the
 * paywall (continue with Complete at $100/month).
 *
 * Storage: the driver_trials table, keyed by lowercased email — a trial
 * buyer may not have a driver application on file yet. This table is
 * deliberately separate from dispatch_subscriptions so trial payments NEVER
 * count as subscription conversions: referral milestone rewards require a
 * real dispatch_subscriptions row with 30 continuous active days, and
 * revenue accounting reads dispatch_subscriptions only.
 *
 * No-guarantee rule: nothing here promises work, loads, routes, contracts,
 * hiring, approvals, income, or earnings. Trial copy describes access only.
 */
const db = require('./db');

const DAY_MS = 86400000;

// Stripe amount_total (cents) -> trial days. Only these three amounts are
// trial purchases; anything else is ignored by the webhook handler.
const TRIAL_TIERS = { 700: 7, 1400: 14, 3000: 30 };

// Davena's live one-time payment links (never change). Tier keyed by days.
const TRIAL_LINKS = {
  7: 'https://buy.stripe.com/3cIfZi9PffsYcYV6oZ0480s',
  14: 'https://buy.stripe.com/cNi14o8LbbcIgb73cN0480q',
  30: 'https://buy.stripe.com/3cI28se5va8E1gdbJj0480t',
};

// product_id used for trial carts in the carts table (abandoned-cart
// detection for trial checkouts).
const TRIAL_PRODUCT_ID = 'transitnow-trial';

function trialDaysForCents(cents) {
  return TRIAL_TIERS[Number(cents)] || null;
}

function cleanEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function rowToTrial(row) {
  if (!row) return null;
  const endsAt = Number(row.trial_ends_at) || 0;
  const now = Date.now();
  const msLeft = endsAt - now;
  return {
    ...row,
    active: msLeft > 0,
    expired: endsAt > 0 && msLeft <= 0,
    hadTrial: true, // a row exists => a trial was purchased at some point
    daysLeft: msLeft > 0 ? Math.ceil(msLeft / DAY_MS) : 0,
    endsAt,
  };
}

async function getByEmail(email) {
  const e = cleanEmail(email);
  if (!e) return null;
  return rowToTrial(await db.get('SELECT * FROM driver_trials WHERE email = ?', [e]));
}

/** True when the email has trial days remaining right now. */
async function isTrialActive(email) {
  const t = await getByEmail(email);
  return !!(t && t.active);
}

/**
 * Trial status for display/gating. Always returns an object:
 * { active, expired, hadTrial, daysLeft, endsAt }
 * hadTrial is true when any trial was ever purchased (even if expired) —
 * used to show the paywall instead of the generic no-subscription page.
 */
async function trialInfo(email) {
  const t = await getByEmail(email);
  if (!t) return { active: false, expired: false, hadTrial: false, daysLeft: 0, endsAt: 0, amountCents: null };
  return { active: t.active, expired: t.expired, hadTrial: true, daysLeft: t.daysLeft, endsAt: t.endsAt, amountCents: t.amount_cents != null ? Number(t.amount_cents) : null };
}

/** Batch lookup for admin lists: { emailLower: trialRow }. */
async function mapForEmails(emails) {
  const uniq = [...new Set((emails || []).map(cleanEmail).filter(Boolean))];
  if (!uniq.length) return {};
  const placeholders = uniq.map(() => '?').join(',');
  const rows = await db.all(`SELECT * FROM driver_trials WHERE email IN (${placeholders})`, uniq);
  const map = {};
  for (const r of rows) map[cleanEmail(r.email)] = rowToTrial(r);
  return map;
}

/**
 * Record a trial purchase from the Stripe webhook. Idempotent on the Stripe
 * session id: a repeat delivery of the same checkout session never adds
 * days twice. Buying another block while a trial is active EXTENDS the
 * current trial (paid days stack); buying after expiry starts fresh.
 */
async function recordTrialPurchase({ email, amountCents, stripeSessionId, purchasedAt }) {
  const e = cleanEmail(email);
  const days = trialDaysForCents(amountCents);
  if (!e || !days) return null;
  const now = Number(purchasedAt) || Date.now();
  if (stripeSessionId) {
    const dupe = await db.get('SELECT 1 FROM driver_trials WHERE stripe_session_id = ?', [String(stripeSessionId)]);
    if (dupe) {
      console.log('[trials] duplicate trial checkout ignored', { stripeSessionId });
      return getByEmail(e);
    }
  }
  const existing = await db.get('SELECT * FROM driver_trials WHERE email = ?', [e]);
  const base = existing && Number(existing.trial_ends_at) > now ? Number(existing.trial_ends_at) : now;
  const endsAt = base + days * DAY_MS;
  if (existing) {
    await db.run(
      `UPDATE driver_trials
       SET trial_ends_at = ?, trial_days = trial_days + ?, amount_cents = ?,
           stripe_session_id = ?, updated_at = ?
       WHERE email = ?`,
      [endsAt, days, Number(amountCents), stripeSessionId || null, now, e]
    );
  } else {
    await db.run(
      `INSERT INTO driver_trials
         (email, trial_ends_at, trial_days, amount_cents, stripe_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [e, endsAt, days, Number(amountCents), stripeSessionId || null, now, now]
    );
  }
  // Observability: one events row per trial purchase (lead may not exist).
  try {
    const lead = await db.get('SELECT id FROM leads WHERE email = ?', [e]);
    await db.run(
      `INSERT INTO events (visitor_id, lead_id, type, product_id, meta, ts)
       VALUES (NULL, ?, 'trial_purchase', 'transitnow-trial', ?, ?)`,
      [lead ? lead.id : null, JSON.stringify({ days, amount_cents: Number(amountCents), stripe_session_id: stripeSessionId || null }), now]
    );
  } catch (err) {
    console.warn('[trials] events insert failed (non-fatal):', err.message);
  }
  console.log('[trials] recorded', { email: e, days, endsAt: new Date(endsAt).toISOString() });
  return getByEmail(e);
}

/**
 * Record a trial started via the auto-convert Stripe Checkout (Davena-approved
 * 2026-10-06): $X today + $100/mo Complete subscription with a trial period.
 * Days are granted in driver_trials; the dispatch_subscriptions row is
 * deliberately NOT created here — it appears only when the first real $100
 * invoice is paid (trial end), so the referral 30-day clock starts at the
 * first real payment, never during the trial.
 */
async function recordTrialSubscription({ email, days, amountCents, stripeSessionId, stripeCustomerId, stripeSubscriptionId }) {
  const e = cleanEmail(email);
  const d = Number(days);
  if (!e || ![7, 14, 30].includes(d)) return null;
  const now = Date.now();
  if (stripeSessionId) {
    const dupe = await db.get('SELECT 1 FROM driver_trials WHERE stripe_session_id = ?', [String(stripeSessionId)]);
    if (dupe) {
      console.log('[trials] duplicate trial subscription checkout ignored', { stripeSessionId });
      return getByEmail(e);
    }
  }
  const existing = await db.get('SELECT * FROM driver_trials WHERE email = ?', [e]);
  const base = existing && Number(existing.trial_ends_at) > now ? Number(existing.trial_ends_at) : now;
  const endsAt = base + d * DAY_MS;
  if (existing) {
    await db.run(
      `UPDATE driver_trials
       SET trial_ends_at = ?, trial_days = trial_days + ?, amount_cents = ?,
           stripe_session_id = COALESCE(?, stripe_session_id),
           stripe_customer_id = COALESCE(?, stripe_customer_id),
           stripe_subscription_id = COALESCE(?, stripe_subscription_id),
           updated_at = ?
       WHERE email = ?`,
      [endsAt, d, Number(amountCents) || null, stripeSessionId || null, stripeCustomerId || null, stripeSubscriptionId || null, now, e]
    );
  } else {
    await db.run(
      `INSERT INTO driver_trials
         (email, trial_ends_at, trial_days, amount_cents, stripe_session_id,
          stripe_customer_id, stripe_subscription_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e, endsAt, d, Number(amountCents) || null, stripeSessionId || null, stripeCustomerId || null, stripeSubscriptionId || null, now, now]
    );
  }
  try {
    const lead = await db.get('SELECT id FROM leads WHERE email = ?', [e]);
    await db.run(
      `INSERT INTO events (visitor_id, lead_id, type, product_id, meta, ts)
       VALUES (NULL, ?, 'trial_subscription_started', 'transitnow-trial', ?, ?)`,
      [lead ? lead.id : null, JSON.stringify({ days: d, amount_cents: Number(amountCents) || null, stripe_session_id: stripeSessionId || null, stripe_subscription_id: stripeSubscriptionId || null, auto_convert: true }), now]
    );
  } catch (err) {
    console.warn('[trials] events insert failed (non-fatal):', err.message);
  }
  console.log('[trials] auto-convert subscription recorded', { email: e, days: d, endsAt: new Date(endsAt).toISOString() });
  return getByEmail(e);
}

module.exports = {
  TRIAL_TIERS,
  TRIAL_LINKS,
  TRIAL_PRODUCT_ID,
  DAY_MS,
  trialDaysForCents,
  getByEmail,
  isTrialActive,
  trialInfo,
  mapForEmails,
  recordTrialPurchase,
  recordTrialSubscription,
};
