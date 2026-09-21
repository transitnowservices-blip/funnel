'use strict';
/**
 * lib/subscriptions.js — TransitNow dispatch subscription bookkeeping.
 *
 * Davena's rule: the driver application stays FREE, but dispatch work is
 * performed for paid subscribers only (Basic $50/month, Complete $100/month).
 *
 * Stripe is the source of truth. The webhook (server.js) feeds Stripe
 * subscription events into this module, which keeps the
 * `dispatch_subscriptions` table current:
 *   - checkout.session.completed (subscription mode) -> status 'active'
 *   - invoice.payment_succeeded (renewal)            -> status 'active'
 *   - invoice.payment_failed                        -> status 'past_due' + dunning email
 *   - customer.subscription.deleted                 -> status 'canceled'
 *   - customer.subscription.updated                 -> sync status/plan/period end
 *
 * Amount mapping (matches config/products.json):
 *   5000 cents -> 'basic'    (TransitNow Basic Dispatch, $50/month)
 *   10000 cents -> 'complete' (TransitNow Complete Dispatch, $100/month)
 * The $49 Room product (4900) is NOT a dispatch product and is owned by the
 * existing Room webhook handlers — this module never touches it.
 *
 * No-guarantee rule: nothing here promises work, loads, routes, contracts,
 * income, or earnings. Statuses describe the subscription only.
 */
const db = require('./db');
const tags = require('./tags');

const PLAN_BY_CENTS = { 5000: 'basic', 10000: 'complete' };
const PLAN_LABEL = { basic: 'Basic $50/mo', complete: 'Complete $100/mo' };
const VALID_STATUSES = ['active', 'past_due', 'canceled', 'incomplete'];

// Stripe subscription.status -> our status.
const STRIPE_STATUS_MAP = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  canceled: 'canceled',
};

function planFromCents(cents) {
  return PLAN_BY_CENTS[Number(cents)] || null;
}

function isDispatchCents(cents) {
  return planFromCents(cents) != null;
}

function planLabel(plan) {
  return PLAN_LABEL[plan] || plan;
}

/**
 * Extract the dispatch plan from a Stripe subscription object's line items.
 * Returns 'basic' | 'complete' | null (null = not a dispatch subscription).
 */
function planFromSubscriptionObject(sub) {
  const items = (sub && sub.items && sub.items.data) || [];
  for (const it of items) {
    const cents = it && it.price && it.price.unit_amount;
    const plan = planFromCents(cents);
    if (plan) return plan;
  }
  // Fallback for older payloads that carry plan directly.
  const legacy = sub && sub.plan && sub.plan.amount;
  return planFromCents(legacy);
}

function cleanEmail(v) {
  return String(v || '').trim().toLowerCase();
}

async function leadIdForEmail(email) {
  if (!email) return null;
  const row = await db.get('SELECT id FROM leads WHERE email = ?', [email]);
  return row ? row.id : null;
}

async function tagLead(email, tag) {
  const leadId = await leadIdForEmail(email);
  if (leadId) await tags.addTag(leadId, tag);
  return leadId;
}

async function untagLead(email, tag) {
  const leadId = await leadIdForEmail(email);
  if (leadId) await tags.removeTag(leadId, tag);
  return leadId;
}

async function recordEvent(email, type, productId, meta) {
  const leadId = await leadIdForEmail(email);
  await db.run(
    `INSERT INTO events (visitor_id, lead_id, type, product_id, meta, ts)
     VALUES (NULL, ?, ?, ?, ?, ?)`,
    [leadId, type, productId, JSON.stringify(meta || {}), Date.now()]
  );
}

/** Idempotency: true when this Stripe event id was already processed. */
async function alreadyProcessed(eventId) {
  if (!eventId) return false;
  return !!(await db.get('SELECT 1 FROM stripe_processed_events WHERE event_id = ?', [eventId]));
}

async function markProcessed(eventId, type) {
  if (!eventId) return;
  await db.run('INSERT OR IGNORE INTO stripe_processed_events (event_id, type, ts) VALUES (?, ?, ?)', [
    eventId,
    type || null,
    Date.now(),
  ]);
}

function rowToSub(row) {
  return row || null;
}

async function getByEmail(email) {
  const e = cleanEmail(email);
  if (!e) return null;
  return rowToSub(
    await db.get('SELECT * FROM dispatch_subscriptions WHERE email = ? ORDER BY updated_at DESC LIMIT 1', [e])
  );
}

async function getByCustomerId(customerId) {
  if (!customerId) return null;
  return rowToSub(await db.get('SELECT * FROM dispatch_subscriptions WHERE stripe_customer_id = ?', [customerId]));
}

async function getBySubscriptionId(subscriptionId) {
  if (!subscriptionId) return null;
  return rowToSub(
    await db.get('SELECT * FROM dispatch_subscriptions WHERE stripe_subscription_id = ?', [subscriptionId])
  );
}

/** Resolve a subscription row by subscription id, then customer id, then email. */
async function resolve({ stripeSubscriptionId, stripeCustomerId, email }) {
  return (
    (await getBySubscriptionId(stripeSubscriptionId)) ||
    (await getByCustomerId(stripeCustomerId)) ||
    (await getByEmail(email))
  );
}

/** True when the email has an ACTIVE dispatch subscription. */
async function isPaidActive(email) {
  const sub = await getByEmail(email);
  return !!(sub && sub.status === 'active');
}

async function listByStatus(status) {
  if (!VALID_STATUSES.includes(status)) return [];
  return db.all('SELECT * FROM dispatch_subscriptions WHERE status = ? ORDER BY updated_at DESC', [status]);
}

/** Batch lookup for admin lists: { emailLower: subRow }. */
async function mapForEmails(emails) {
  const uniq = [...new Set((emails || []).map(cleanEmail).filter(Boolean))];
  if (!uniq.length) return {};
  const placeholders = uniq.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT * FROM dispatch_subscriptions WHERE email IN (${placeholders})`,
    uniq
  );
  const map = {};
  for (const r of rows) {
    const e = cleanEmail(r.email);
    if (!map[e] || Number(r.updated_at) > Number(map[e].updated_at)) map[e] = r;
  }
  return map;
}

async function upsertActive({ email, plan, stripeCustomerId, stripeSubscriptionId, currentPeriodEnd }) {
  const e = cleanEmail(email);
  if (!e || !plan) return null;
  const now = Date.now();
  const existing = await resolve({ stripeSubscriptionId, stripeCustomerId, email: e });
  if (existing) {
    await db.run(
      `UPDATE dispatch_subscriptions
       SET stripe_customer_id = COALESCE(?, stripe_customer_id),
           stripe_subscription_id = COALESCE(?, stripe_subscription_id),
           email = ?, plan = ?, status = 'active',
           current_period_end = COALESCE(?, current_period_end),
           updated_at = ?
       WHERE id = ?`,
      [stripeCustomerId || null, stripeSubscriptionId || null, e, plan, currentPeriodEnd || null, now, existing.id]
    );
  } else {
    await db.run(
      `INSERT INTO dispatch_subscriptions
         (stripe_customer_id, stripe_subscription_id, email, plan, status, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      [stripeCustomerId || null, stripeSubscriptionId || null, e, plan, currentPeriodEnd || null, now, now]
    );
  }
  await tagLead(e, 'DISPATCH_SUBSCRIBER');
  await tagLead(e, plan === 'basic' ? 'DISPATCH_BASIC' : 'DISPATCH_COMPLETE');
  await recordEvent(e, 'dispatch_subscription_active', plan === 'basic' ? 'transitnow-basic' : 'transitnow-complete', {
    plan,
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
  });
  console.log('[subscriptions] active', { email: e, plan });
  return getByEmail(e);
}

async function markRenewed({ stripeCustomerId, stripeSubscriptionId, email, plan, currentPeriodEnd }) {
  const e = cleanEmail(email);
  const existing = await resolve({ stripeSubscriptionId, stripeCustomerId, email: e });
  const now = Date.now();
  if (existing) {
    await db.run(
      `UPDATE dispatch_subscriptions
       SET status = 'active', current_period_end = COALESCE(?, current_period_end), updated_at = ?
       WHERE id = ?`,
      [currentPeriodEnd || null, now, existing.id]
    );
    // Clear any queued dunning for this subscriber — they're current again.
    await db.run(
      `UPDATE email_queue SET status = 'cancelled', cancel_reason = 'subscription-renewed'
       WHERE email = ? AND sequence = 'dispatch-dunning' AND status = 'queued'`,
      [existing.email]
    );
    console.log('[subscriptions] renewed', { email: existing.email });
    await syncLeadTags(existing.email, existing.plan, 'active');
    return getByEmail(existing.email);
  }
  // Renewal for a subscription we never saw via checkout (e.g. created in
  // the Stripe dashboard): create the row from the invoice data.
  if (e && plan) {
    return upsertActive({
      email: e,
      plan,
      stripeCustomerId,
      stripeSubscriptionId,
      currentPeriodEnd,
    });
  }
  console.log('[subscriptions] renewal for unknown subscription — ignored', { stripeSubscriptionId, stripeCustomerId });
  return null;
}

/** Queue the past-due dunning email (deduped; no fabricated links). */
async function queueDunningEmail(email, plan) {
  const e = cleanEmail(email);
  if (!e) return 0;
  const dupe = await db.get(
    `SELECT 1 FROM email_queue WHERE email = ? AND sequence = 'dispatch-dunning' AND step = 'payment-failed' AND status IN ('queued','sent')`,
    [e]
  );
  if (dupe) return 0;
  const leadId = await leadIdForEmail(e);
  const subject = 'Your TransitNow dispatch payment didn\u2019t go through';
  const body = [
    `<p>Hi there,</p>`,
    `<p>We tried to charge your TransitNow dispatch subscription (${planLabel(plan)}) and the payment didn\u2019t go through, so dispatch service is paused until a payment succeeds.</p>`,
    `<p>Reply to this email or contact us at transitnowservices@gmail.com and we\u2019ll help you update your payment method.</p>`,
    `<p style="color:#888;font-size:12px">TransitNow Logistics Services. Subscriptions are month-to-month. No guaranteed loads, routes, revenue, or earnings.</p>`,
  ].join('\n');
  await db.run(
    `INSERT INTO email_queue (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (?, ?, 'dispatch-dunning', 'payment-failed', ?, ?, ?, ?, 'queued')`,
    [leadId, e, subject, body, plan === 'basic' ? 'transitnow-basic' : 'transitnow-complete', Date.now(), ]
  );
  return 1;
}

async function markPastDue({ stripeCustomerId, stripeSubscriptionId, email, invoiceId, plan }) {
  const e = cleanEmail(email);
  const existing = await resolve({ stripeSubscriptionId, stripeCustomerId, email: e });
  const now = Date.now();
  // Never invent a plan: prefer the existing row, then the webhook-mapped plan.
  const validPlan = plan === 'basic' || plan === 'complete' ? plan : null;
  const rowPlan = existing ? existing.plan : validPlan;
  if (existing) {
    await db.run(`UPDATE dispatch_subscriptions SET status = 'past_due', updated_at = ? WHERE id = ?`, [now, existing.id]);
    await recordEvent(existing.email, 'dispatch_payment_failed', null, { invoice_id: invoiceId || null });
    await untagLead(existing.email, 'DISPATCH_SUBSCRIBER');
    console.log('[subscriptions] past_due', { email: existing.email });
  } else if (e && rowPlan) {
    await db.run(
      `INSERT INTO dispatch_subscriptions
         (stripe_customer_id, stripe_subscription_id, email, plan, status, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'past_due', NULL, ?, ?)`,
      [stripeCustomerId || null, stripeSubscriptionId || null, e, rowPlan, now, now]
    );
    console.log('[subscriptions] past_due (new row)', { email: e, plan: rowPlan });
  } else {
    console.log('[subscriptions] past_due ignored — no existing row and no mappable plan', { email: e });
    return existing ? getByEmail(existing.email) : null;
  }
  const targetEmail = existing ? existing.email : e;
  const queued = await queueDunningEmail(targetEmail, rowPlan);
  if (queued) console.log('[subscriptions] dunning email queued', { email: targetEmail });
  return getByEmail(targetEmail);
}

async function markCanceled({ stripeCustomerId, stripeSubscriptionId, email }) {
  const e = cleanEmail(email);
  const existing = await resolve({ stripeSubscriptionId, stripeCustomerId, email: e });
  if (!existing) {
    console.log('[subscriptions] cancel for unknown subscription — ignored', { stripeSubscriptionId, stripeCustomerId });
    return null;
  }
  const now = Date.now();
  await db.run(`UPDATE dispatch_subscriptions SET status = 'canceled', updated_at = ? WHERE id = ?`, [now, existing.id]);
  const leadId = await leadIdForEmail(existing.email);
  if (leadId) {
    await tags.removeTag(leadId, 'DISPATCH_SUBSCRIBER');
    await tags.removeTag(leadId, 'DISPATCH_BASIC');
    await tags.removeTag(leadId, 'DISPATCH_COMPLETE');
  }
  await recordEvent(existing.email, 'dispatch_subscription_canceled', null, {
    stripe_subscription_id: stripeSubscriptionId || null,
  });
  console.log('[subscriptions] canceled', { email: existing.email });
  return getByEmail(existing.email);
}

/** Sync from a customer.subscription.updated object. */
async function syncFromSubscriptionObject(sub) {
  const s = sub || {};
  const plan = planFromSubscriptionObject(s);
  if (!plan) return null; // not a dispatch subscription
  const stripeStatus = STRIPE_STATUS_MAP[s.status] || 'incomplete';
  const email = cleanEmail((s.customer_details && s.customer_details.email) || s.customer_email || '');
  const existing = await resolve({ stripeSubscriptionId: s.id, stripeCustomerId: s.customer, email });
  const now = Date.now();
  const periodEnd = s.current_period_end ? Number(s.current_period_end) * 1000 : null;
  if (existing) {
    await db.run(
      `UPDATE dispatch_subscriptions SET plan = ?, status = ?, current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE id = ?`,
      [plan, stripeStatus, periodEnd, now, existing.id]
    );
    console.log('[subscriptions] synced', { email: existing.email, plan, status: stripeStatus });
    await syncLeadTags(existing.email, plan, stripeStatus);
    return getByEmail(existing.email);
  }
  if (!email) {
    console.log('[subscriptions] update for unknown subscription without email — ignored', { id: s.id });
    return null;
  }
  await db.run(
    `INSERT INTO dispatch_subscriptions
       (stripe_customer_id, stripe_subscription_id, email, plan, status, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.customer || null, s.id || null, email, plan, stripeStatus, periodEnd, now, now]
  );
  console.log('[subscriptions] synced (new row)', { email, plan, status: stripeStatus });
  await syncLeadTags(email, plan, stripeStatus);
  return getByEmail(email);
}

/**
 * Tag hygiene for synced subscription state: an ACTIVE subscription keeps the
 * DISPATCH_SUBSCRIBER tag (plus its plan tag); any other status drops
 * DISPATCH_SUBSCRIBER so lead segmentation never treats a lapsed/canceled
 * subscriber as a current paid client. Plan tags stay as history.
 */
async function syncLeadTags(email, plan, stripeStatus) {
  if (stripeStatus === 'active') {
    await tagLead(email, 'DISPATCH_SUBSCRIBER');
    await tagLead(email, plan === 'basic' ? 'DISPATCH_BASIC' : 'DISPATCH_COMPLETE');
  } else {
    await untagLead(email, 'DISPATCH_SUBSCRIBER');
  }
}

module.exports = {
  planFromCents,
  isDispatchCents,
  planLabel,
  planFromSubscriptionObject,
  alreadyProcessed,
  markProcessed,
  getByEmail,
  getByCustomerId,
  getBySubscriptionId,
  isPaidActive,
  listByStatus,
  mapForEmails,
  upsertActive,
  markRenewed,
  markPastDue,
  markCanceled,
  syncFromSubscriptionObject,
};
