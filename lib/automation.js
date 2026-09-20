'use strict';
/**
 * lib/automation.js — email automation engine.
 *
 * Responsibilities:
 *   - renderTemplate(str, vars): replaces all {{var}} placeholders.
 *   - buildVars(lead, product, site): {{first_name}}, {{product_name}},
 *     {{price}}, {{checkout_url}}, {{unsubscribe_url}}, {{room_url}},
 *     {{business_name}}, {{business_phone}}, {{business_email}}.
 *   - sequenceFrom(seqName): resolves the effective fromName/fromEmail for a
 *     sequence — per-sequence overrides in config/emails.json sequenceBranding
 *     win over the global fromEmail/fromName.
 *   - scheduleSequence(leadId, productId, seqName): queues one email_queue
 *     row per step of config/emails.json sequences[seqName], scheduled at
 *     now + delayHours. Templates are rendered at schedule time (except the
 *     weekly flyer, which is built at send time so config edits apply to
 *     future sends without a rebuild).
 *   - scheduleWeekly(leadId): queues the next weekly flyer email (+7d).
 *   - runSchedulerPass(): one full automation pass —
 *       1. abandoned-cart detection (stale open carts -> ABANDONED_CART tag,
 *          roomAbandonedCart sequence for room carts else abandonedCart,
 *          CART_ABANDONED + checkout_abandoned events), then
 *       2. processDueEmails() — send every due queued row that passes guards.
 *     Returns { sent, cancelled }.
 *
 * Send-time guards (a failing guard cancels the row with cancel_reason):
 *   - lead missing            -> 'lead-missing'
 *   - lead unsubscribed       -> 'unsubscribed'
 *   - email suppressed        -> 'suppressed'
 *   - abandonedCart + cart purchased            -> 'purchased'
 *   - roomAbandonedCart + cart purchased or room purchased -> 'purchased'
 *   - nurture 'offer' step + product purchased  -> 'purchased'
 *   - roomNurture + lead purchased (PURCHASED tag or room purchase) -> 'purchased'
 *   - weekly + featured offer purchased         -> 'purchased-featured'
 *   - postPurchase without PURCHASED tag        -> 'not-purchased'
 *   - roomWelcome without an active room member -> 'not-purchased'
 *
 * After the nurture 'offer' step is sent to a still-non-buyer, the lead gets
 * the WEEKLY_NURTURE tag and the next weekly email is scheduled (+7d). After
 * each weekly email is sent, the following one is scheduled (+7d) while the
 * lead stays eligible.
 *
 * NOTE: every function here is async — the db layer returns Promises.
 * Callers must `await` these functions.
 */
const db = require('./db');
const config = require('./config');
const tags = require('./tags');
const email = require('./email');
const room = require('./room');

const fs = require('fs');
const path = require('path');

const EMAILS_JSON_PATH = path.join(__dirname, '..', 'config', 'emails.json');

/**
 * Read config/emails.json directly, bypassing config.getEmails()'s whitelist
 * (which only exposes the legacy nurture/abandonedCart/postPurchase
 * sequences). This is how the Room sequences (roomWelcome, roomNurture,
 * roomAbandonedCart) and the top-level sequenceBranding map are resolved.
 * Falls back to {} so a missing/unparseable file just schedules nothing.
 */
function getRawEmails() {
  try {
    return JSON.parse(fs.readFileSync(EMAILS_JSON_PATH, 'utf8'));
  } catch (err) {
    console.error('[automation] failed to read config/emails.json:', err && err.message ? err.message : err);
    return {};
  }
}

const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const ABANDON_AFTER_MS = HOUR_MS; // cart considered abandoned after 1h

/**
 * Normalize a DB time value to epoch milliseconds.
 * The contract stores epoch-ms integers, but this is tolerant of ISO/SQLite
 * datetime text ('YYYY-MM-DD HH:MM:SS', always UTC from datetime('now')) and
 * numeric strings, since tests, admin SQL, and operators naturally write
 * those via datetime(). Unparseable values -> NaN (caller decides: skip).
 */
function toMs(val) {
  if (val === null || val === undefined) return NaN;
  if (typeof val === 'number') return val;
  const s = String(val).trim();
  if (s === '') return NaN;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // Naive 'YYYY-MM-DD HH:MM:SS' from SQLite datetime('now') is UTC.
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

// --- Templates ----------------------------------------------------------------
function renderTemplate(str, vars) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''
  );
}

function buildVars(lead, product, site) {
  const safeLead = lead || {};
  const safeProduct = product || {};
  const safeSite = site || {};
  const baseUrl = (safeSite.baseUrl || '').replace(/\/$/, '');
  return {
    first_name: safeLead.first_name || '',
    product_name: safeProduct.name || '',
    price: safeProduct.priceDisplay || '',
    checkout_url: `${baseUrl}/checkout?p=${safeProduct.id || ''}`,
    unsubscribe_url: `${baseUrl}/unsubscribe?email=${encodeURIComponent(safeLead.email || '')}`,
    room_url: `${baseUrl}/room/login`,
    business_name: safeSite.businessName || '',
    business_phone: safeSite.phone || '',
    business_email: safeSite.email || '',
  };
}

/**
 * Resolve the effective sender for a sequence. A per-sequence override in
 * config/emails.json's top-level `sequenceBranding` map
 * ({ "<seqName>": { fromName, fromEmail } }) wins over the global
 * fromName/fromEmail. Missing keys fall back to the global values.
 */
function sequenceFrom(seqName) {
  const raw = getRawEmails();
  const overrides = (raw.sequenceBranding || {})[seqName] || {};
  return {
    fromName: overrides.fromName || raw.fromName || '',
    fromEmail: overrides.fromEmail || raw.fromEmail || '',
  };
}

// --- Small query helpers -------------------------------------------------------
async function getLead(id) {
  return db.get('SELECT * FROM leads WHERE id = ?', [id]);
}

async function isSuppressed(emailAddr) {
  if (!emailAddr) return false;
  return !!(await db.get('SELECT 1 FROM suppressions WHERE email = ?', [emailAddr]));
}

async function hasAnyPurchase(leadId) {
  return !!(await db.get("SELECT 1 FROM purchases WHERE lead_id = ? AND kind = 'initial'", [leadId]));
}

async function hasPurchasedProduct(leadId, productId) {
  if (!productId) return false;
  return !!(await db.get("SELECT 1 FROM purchases WHERE lead_id = ? AND product_id = ? AND kind = 'initial'", [
    leadId,
    productId,
  ]));
}

async function hasPurchasedCart(leadId, productId) {
  if (productId) {
    return !!(await db.get('SELECT 1 FROM carts WHERE lead_id = ? AND product_id = ? AND purchased = 1', [
      leadId,
      productId,
    ]));
  }
  return !!(await db.get('SELECT 1 FROM carts WHERE lead_id = ? AND purchased = 1', [leadId]));
}

/** True when the email belongs to an active Wealth Builder's Room member. */
async function hasActiveRoomMember(email) {
  const clean = String(email || '')
    .trim()
    .toLowerCase();
  if (!clean) return false;
  return !!(await db.get("SELECT 1 FROM room_members WHERE email = ? AND status = 'active'", [clean]));
}

/** True when the lead has bought the Wealth Builder's Room through any channel. */
async function hasRoomPurchase(leadId, email) {
  if (await hasPurchasedProduct(leadId, 'room')) return true;
  if (await tags.hasTag(leadId, 'ROOM_PURCHASED')) return true;
  return hasActiveRoomMember(email);
}

// --- Scheduling -----------------------------------------------------------------
/**
 * Step ids that count as the nurture "offer" step: a literal 'offer' id, or —
 * since the offer is the last nurture step — the final step of the configured
 * nurture sequence. This keeps the purchase/cancel and weekly-rollover logic
 * working whether the config names the step 'offer' or e.g. 'nurture-4'.
 */
function nurtureOfferStepIds() {
  const steps = ((config.getEmails().sequences || {}).nurture) || [];
  const ids = new Set(['offer']);
  const last = steps[steps.length - 1];
  if (last && last.id) ids.add(last.id);
  return ids;
}

function isNurtureOfferStep(stepId) {
  return nurtureOfferStepIds().has(stepId);
}

/** Cancel queued nurture offer-step rows for a lead+product (e.g. after purchase). */
async function cancelNurtureOfferSteps(leadId, productId) {
  const ids = [...nurtureOfferStepIds()];
  const placeholders = ids.map(() => '?').join(',');
  const info = await db.run(
    `UPDATE email_queue SET status = 'cancelled', cancel_reason = 'purchased'
     WHERE lead_id = ? AND status = 'queued' AND sequence = 'nurture'
       AND step IN (${placeholders}) AND product_id = ?`,
    [leadId, ...ids, productId]
  );
  return info.changes;
}
/**
 * Cancel ALL remaining queued nurture rows for a lead+product.
 * Used on purchase: the buyer leaves the prospect promotion for that offer
 * and moves into the post-purchase/customer sequence instead. (Kept separate
 * from cancelNurtureOfferSteps for callers that only want the offer step.)
 */
async function cancelNurtureForProduct(leadId, productId) {
  const info = await db.run(
    `UPDATE email_queue SET status = 'cancelled', cancel_reason = 'purchased'
     WHERE lead_id = ? AND status = 'queued' AND sequence = 'nurture' AND product_id = ?`,
    [leadId, productId]
  );
  return info.changes;
}
/**
 * Queue every step of a named sequence. Idempotent per (lead, sequence, step):
 * already-queued steps are skipped so double submits don't duplicate emails.
 * Returns the number of rows inserted.
 * Delays are measured from baseTime (default now); pass the cart's started_at
 * for the abandonedCart sequence so "1h later" means 1h after checkout start.
 */
async function scheduleSequence(leadId, productId, seqName, baseTime = Date.now()) {
  const lead = await getLead(leadId);
  if (!lead) return 0;
  // Raw read (not config.getEmails()): exposes the Room sequences too.
  const steps = ((getRawEmails().sequences || {})[seqName]) || [];
  if (!steps.length) return 0;
  const site = config.getSite();
  const product = config.getProduct(productId);
  const vars = buildVars(lead, product, site);
  let inserted = 0;
  for (const step of steps) {
    if (!step || !step.id) continue;
    const dupe = await db.get(
      "SELECT 1 FROM email_queue WHERE lead_id = ? AND sequence = ? AND step = ? AND status = 'queued'",
      [leadId, seqName, step.id]
    );
    if (dupe) continue;
    await db.run(
      `INSERT INTO email_queue
         (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      [
        leadId,
        lead.email,
        seqName,
        step.id,
        renderTemplate(step.subject, vars),
        renderTemplate(step.bodyHtml, vars),
        product.id,
        baseTime + (Number(step.delayHours) || 0) * HOUR_MS,
      ]
    );
    inserted++;
  }
  return inserted;
}

/** Queue the next weekly flyer email (+7d). Subject/body are built at send time. */
async function scheduleWeekly(leadId) {
  const lead = await getLead(leadId);
  if (!lead || lead.unsubscribed || (await isSuppressed(lead.email))) return 0;
  const featuredOfferId = (config.getEmails().weeklyFlyer || {}).featuredOfferId || null;
  if (featuredOfferId && (await hasPurchasedProduct(leadId, featuredOfferId))) return 0;
  const dupe = await db.get("SELECT 1 FROM email_queue WHERE lead_id = ? AND sequence = 'weekly' AND status = 'queued'", [
    leadId,
  ]);
  if (dupe) return 0;
  await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (?, ?, 'weekly', 'weekly', '', '', ?, ?, 'queued')`,
    [leadId, lead.email, featuredOfferId, Date.now() + 7 * DAY_MS]
  );
  return 1;
}

/** Build the weekly flyer email at send time so config edits apply going forward. */
function buildWeeklyEmail(lead) {  const emailsCfg = config.getEmails();
  const site = config.getSite();
  const flyer = emailsCfg.weeklyFlyer || {};
  const product = config.getProduct(flyer.featuredOfferId);
  const vars = buildVars(lead, product, site);
  const subject = renderTemplate(flyer.subject || flyer.headline || 'Weekly update', vars);
  const section = (title, text) =>
    text ? `<h3 style="margin:1.2em 0 .4em">${renderTemplate(title, vars)}</h3><p>${renderTemplate(text, vars)}</p>` : '';
  const body = `
    <h2>${renderTemplate(flyer.headline || '', vars)}</h2>
    <p>Hi ${renderTemplate('{{first_name}}', vars)},</p>
    ${section(`Featured this week: ${product.name || ''} — ${product.priceDisplay || ''}`, flyer.benefit)}
    <p><a href="${vars.checkout_url}">${renderTemplate(flyer.cta || 'Learn more', vars)}</a></p>
    ${section('Learn something useful', flyer.educational)}
    ${section('Spotlight', flyer.spotlight)}
    ${flyer.secondaryOffer ? `<p><em>Also:</em> ${renderTemplate(flyer.secondaryOffer, vars)}</p>` : ''}
    ${flyer.testimonialSlot ? `<blockquote>${renderTemplate(flyer.testimonialSlot, vars)}</blockquote>` : ''}
    <hr>
    <p style="font-size:12px;color:#666">
      You're receiving this because you joined ${renderTemplate('{{business_name}}', vars)}'s list.
      <a href="${vars.unsubscribe_url}">Unsubscribe</a>
    </p>`;
  return { subject, body };
}

// --- Room accountability emails -------------------------------------------------------
// Weekly check-in reminders + post-check-in confirmations for Wealth Builder's
// Room members. These reuse the email_queue table with `room-` sequences.
// Member emails are transactional to paying members; the send-time guards
// below still never mail canceled/inactive/suppressed members.

function roomAppUrl() {
  const site = config.getSite() || {};
  return (process.env.APP_URL || site.baseUrl || '').replace(/\/$/, '');
}

function roomReminderBody() {
  const base = roomAppUrl();
  return `<p>Your weekly Wealth Builder check-in is ready.</p>` +
    `<p>Take a few minutes to look at what you planned, what you actually did, what you learned, and what you're doing next.</p>` +
    `<p>You don't need a perfect week.</p>` +
    `<p>You just need an honest one.</p>` +
    `<p>Progress is built one action at a time.</p>` +
    `<p><a href="${base}/room/checkin">COMPLETE MY WEEKLY CHECK-IN</a></p>`;
}

function roomConfirmationBody() {
  const base = roomAppUrl();
  return `<p>You just documented another step in your 90-day Wealth Builder journey.</p>` +
    `<p>Goal &rarr; Action &rarr; Proof &rarr; Lesson &rarr; Next Action.</p>` +
    `<p>Keep going.</p>` +
    `<p>Your progress does not have to be perfect to be real.</p>` +
    `<p><a href="${base}/room/progress">VIEW MY PROGRESS</a></p>`;
}

/**
 * Queue one reminder per active, claimed member who has a goal but hasn't
 * completed the current week's check-in. Idempotent per (email, week): a
 * second pass never duplicates a queued or sent reminder.
 * Returns the number of reminders queued.
 */
async function queueCheckinReminders(now = Date.now()) {
  const members = await db.all(
    "SELECT email FROM room_members WHERE status = 'active' AND password_hash IS NOT NULL"
  );
  let queued = 0;
  for (const m of members) {
    const emailAddr = String(m.email || '').trim().toLowerCase();
    if (!emailAddr) continue;
    if (await isSuppressed(emailAddr)) continue;
    const info = await room.weekInfo(emailAddr);
    if (!info) continue; // no goal yet — the dashboard prompts them instead
    const done = await room.getCheckin(emailAddr, info.currentWeek);
    if (done) continue;
    const step = `week-${info.currentWeek}`;
    const dupe = await db.get(
      "SELECT 1 FROM email_queue WHERE email = ? AND sequence = 'room-reminder' AND step = ? AND status IN ('queued','sent')",
      [emailAddr, step]
    );
    if (dupe) continue;
    await db.run(
      `INSERT INTO email_queue
         (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
       VALUES (NULL, ?, 'room-reminder', ?, 'Your Wealth Builder weekly check-in', ?, 'room', ?, 'queued')`,
      [emailAddr, step, roomReminderBody(), now]
    );
    queued++;
  }
  return queued;
}

/**
 * Queue the "Progress documented" confirmation right after a check-in is
 * submitted. Idempotent per check-in id: re-submitting the same check-in
 * never queues a second confirmation.
 */
async function queueCheckinConfirmation(emailAddr, checkinId) {
  const clean = String(emailAddr || '').trim().toLowerCase();
  if (!clean) return 0;
  const step = `checkin-${Number(checkinId) || 0}`;
  const dupe = await db.get(
    "SELECT 1 FROM email_queue WHERE email = ? AND sequence = 'room-confirmation' AND step = ? AND status IN ('queued','sent')",
    [clean, step]
  );
  if (dupe) return 0;
  await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, 'room-confirmation', ?, 'Progress documented ✓', ?, 'room', ?, 'queued')`,
    [clean, step, roomConfirmationBody(), Date.now()]
  );
  return 1;
}

// --- Sending ----------------------------------------------------------------------
async function cancelRow(id, reason) {
  await db.run("UPDATE email_queue SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [reason, id]);
  return 'cancelled';
}

/** Apply send-time guards and send one due queue row. Returns 'sent' | 'cancelled'. */
async function processOneEmail(row) {
  // Room accountability sequences address members by email (lead_id is NULL).
  // They skip the funnel prospect guards but still never mail canceled,
  // inactive, or suppressed members.
  if (row.sequence && String(row.sequence).startsWith('room-')) {
    return processRoomEmail(row);
  }
  const lead = await getLead(row.lead_id);
  if (!lead) return cancelRow(row.id, 'lead-missing');
  if (lead.unsubscribed) return cancelRow(row.id, 'unsubscribed');
  if (await isSuppressed(lead.email)) return cancelRow(row.id, 'suppressed');

  const flyer = (config.getEmails().weeklyFlyer || {});
  if (row.sequence === 'abandonedCart' && (await hasPurchasedCart(lead.id, row.product_id))) {
    return cancelRow(row.id, 'purchased');
  }
  if (
    row.sequence === 'roomAbandonedCart' &&
    ((await hasPurchasedCart(lead.id, row.product_id)) || (await hasRoomPurchase(lead.id, lead.email)))
  ) {
    return cancelRow(row.id, 'purchased');
  }
  if (
    row.sequence === 'roomNurture' &&
    ((await tags.hasTag(lead.id, 'PURCHASED')) || (await hasRoomPurchase(lead.id, lead.email)))
  ) {
    return cancelRow(row.id, 'purchased');
  }
  if (row.sequence === 'roomWelcome' && !(await hasActiveRoomMember(lead.email))) {
    // Safety: welcome emails only go to confirmed members.
    return cancelRow(row.id, 'not-purchased');
  }
  if (row.sequence === 'nurture' && isNurtureOfferStep(row.step) && (await hasPurchasedProduct(lead.id, row.product_id))) {
    return cancelRow(row.id, 'purchased');
  }
  if (row.sequence === 'weekly' && (await hasPurchasedProduct(lead.id, flyer.featuredOfferId))) {
    return cancelRow(row.id, 'purchased-featured');
  }
  if (row.sequence === 'postPurchase' && !(await tags.hasTag(lead.id, 'PURCHASED'))) {
    return cancelRow(row.id, 'not-purchased');
  }

  let subject = row.subject;
  let body = row.body_html;
  if (row.sequence === 'weekly') {
    // Weekly content is built fresh at send time.
    const built = buildWeeklyEmail(lead);
    subject = built.subject;
    body = built.body;
    await db.run('UPDATE email_queue SET subject = ?, body_html = ? WHERE id = ?', [subject, body, row.id]);
  }

  await email.sendEmail({
    to: row.email,
    subject,
    html: body,
    queueId: row.id,
    ...sequenceFrom(row.sequence),
  });

  // Post-send follow-ups -------------------------------------------------------
  if (row.sequence === 'nurture' && isNurtureOfferStep(row.step) && !(await hasAnyPurchase(lead.id))) {
    // Nurture finished without a purchase -> roll into the weekly flyer.
    await tags.addTag(lead.id, 'WEEKLY_NURTURE');
    await scheduleWeekly(lead.id);
  }
  if (row.sequence === 'weekly') {
    // Keep the weekly cadence going while the lead stays eligible.
    await scheduleWeekly(lead.id);
  }
  return 'sent';
}

/**
 * Send one due Room accountability email. Guards: the address must belong to
 * an active member and must not be unsubscribed/suppressed. Members never see
 * each other's data — every row is addressed to exactly one member.
 */
async function processRoomEmail(row) {
  const emailAddr = String(row.email || '').trim().toLowerCase();
  if (!emailAddr) return cancelRow(row.id, 'lead-missing');
  const lead = row.lead_id
    ? await getLead(row.lead_id)
    : await db.get('SELECT * FROM leads WHERE email = ?', [emailAddr]);
  if (lead && lead.unsubscribed) return cancelRow(row.id, 'unsubscribed');
  if (await isSuppressed(emailAddr)) return cancelRow(row.id, 'suppressed');
  const member = await room.getMember(emailAddr);
  if (!member || member.status !== 'active') return cancelRow(row.id, 'inactive-member');
  await email.sendEmail({
    to: emailAddr,
    subject: row.subject,
    html: row.body_html,
    queueId: row.id,
    fromName: "Wealth Builder's Room",
  });
  return 'sent';
}

async function processDueEmails(now = Date.now()) {
  // Pull all queued rows and filter in JS: toMs() tolerates both epoch-ms
  // integers (contract) and SQLite datetime text (admin/test writes).
  const queued = await db.all("SELECT * FROM email_queue WHERE status = 'queued' ORDER BY id ASC");
  const due = queued.filter(row => {
    const t = toMs(row.scheduled_for);
    return Number.isFinite(t) && t <= now;
  });
  let sent = 0;
  let cancelled = 0;
  for (const row of due) {
    try {
      const result = await processOneEmail(row);
      if (result === 'sent') sent++;
      else cancelled++;
    } catch (err) {
      console.error(`[automation] failed to process email_queue row ${row.id}:`, err.message);
    }
  }
  return { sent, cancelled };
}

// --- Scheduler pass ------------------------------------------------------------------
/** Detect stale open carts and queue abandoned-cart sequences. */
async function detectAbandonedCarts(now = Date.now()) {
  // Read open carts and compare in JS so both epoch-ms integers (contract)
  // and SQLite datetime text (admin/test writes) are handled via toMs().
  const open = await db.all('SELECT * FROM carts WHERE purchased = 0');
  let flagged = 0;
  for (const cart of open) {
    const started = toMs(cart.started_at);
    if (!Number.isFinite(started) || started >= now - ABANDON_AFTER_MS) continue; // not stale yet
    if (!cart.lead_id) continue; // never identified — nothing to email
    if (await tags.hasTag(cart.lead_id, 'ABANDONED_CART')) continue; // already flagged
    const lead = await getLead(cart.lead_id);
    if (!lead) continue;
    await tags.addTag(cart.lead_id, 'ABANDONED_CART');
    // Room carts get the Room-branded abandoned-cart sequence; everything else
    // keeps the original abandonedCart sequence.
    const seqName = cart.product_id === 'room' ? 'roomAbandonedCart' : 'abandonedCart';
    // Measure cart-email delays from checkout start, so "email 1 ~1h later"
    // means ~1h after they started checkout (already elapsed at detection,
    // so it goes out on this same scheduler pass).
    await scheduleSequence(cart.lead_id, cart.product_id, seqName, started);
    await db.recordEvent({
      lead_id: cart.lead_id,
      type: 'CART_ABANDONED',
      product_id: cart.product_id,
      meta: { cart_id: cart.id },
    });
    await db.recordEvent({
      lead_id: cart.lead_id,
      type: 'checkout_abandoned',
      product_id: cart.product_id,
      meta: { cart_id: cart.id },
    });
    flagged++;
  }
  return flagged;
}

/**
 * Run one full automation pass: abandoned-cart detection, room check-in
 * reminders, then due emails. Called every 60s from server.js and on demand
 * via POST /admin/run-scheduler.
 */
async function runSchedulerPass() {
  const now = Date.now();
  const abandoned = await detectAbandonedCarts(now);
  const checkinReminders = await queueCheckinReminders(now);
  const { sent, cancelled } = await processDueEmails(now);
  return { sent, cancelled, abandonedCarts: abandoned, checkinReminders };
}

module.exports = {
  renderTemplate,
  buildVars,
  sequenceFrom,
  toMs,
  nurtureOfferStepIds,
  isNurtureOfferStep,
  cancelNurtureOfferSteps,
  cancelNurtureForProduct,
  scheduleSequence,
  scheduleWeekly,
  buildWeeklyEmail,
  queueCheckinReminders,
  queueCheckinConfirmation,
  processDueEmails,
  detectAbandonedCarts,
  runSchedulerPass,
};
