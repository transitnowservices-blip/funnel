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
const sms = require('./sms');

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

// --- Daily accountability nudges ---------------------------------------------------
/**
 * 30 short daily nudges, one shared by all members each day (selected by
 * Chicago day-of-year % 30). Two variants per nudge: one for members who
 * already checked in this week (warm acknowledgment + momentum), one for
 * members who haven't (gentle action prompt). Tone is a supportive coach:
 * direct, warm, plain language. NEVER shame, guilt, or punish — missing a
 * day or a week is simply a fresh start, never a failure.
 */
const DAILY_NUDGES = [
  { theme: 'small steps',
    checkedIn: "You already showed up this week — that counts. Keep it warm with one small money move today.",
    notCheckedIn: "One small money move today is enough to start. Open your check-in and write down a single action for this week." },
  { theme: 'honesty',
    checkedIn: "You told the truth about your week in your check-in. That honesty is the whole game — keep going.",
    notCheckedIn: "Your check-in doesn't need good news, just honest news. Take two minutes and tell the truth about this week." },
  { theme: 'momentum',
    checkedIn: "Momentum loves company. You're rolling — pick the next tiny action and do it today.",
    notCheckedIn: "Momentum starts with a single action, not a perfect plan. Do one small thing for your money today." },
  { theme: 'rest',
    checkedIn: "Checked in and still going — remember rest is part of the work. Protect your energy today.",
    notCheckedIn: "Tired? Do the smallest version. Even opening your check-in page counts as showing up." },
  { theme: 'review',
    checkedIn: "You reviewed your week — most people never do. Glance at your progress page and notice how far you've come.",
    notCheckedIn: "Two minutes of review beats two hours of worry. Open your check-in and look at your week honestly." },
  { theme: 'simplicity',
    checkedIn: "Simple keeps working. Your check-in is done — now do the one next action you named.",
    notCheckedIn: "Keep it simple: one goal, one action, one check-in. Start with the action." },
  { theme: 'consistency',
    checkedIn: "Consistency is a quiet superpower, and you're building it. Same small effort today.",
    notCheckedIn: "You don't need motivation, just repetition. One small money habit today, same as yesterday." },
  { theme: 'courage',
    checkedIn: "It takes courage to track your money honestly. You're doing it — keep being brave today.",
    notCheckedIn: "Avoiding the numbers never made them better. Be brave for five minutes and face one money task." },
  { theme: 'patience',
    checkedIn: "Wealth is built slowly, and you're building. Let today be steady, not rushed.",
    notCheckedIn: "You don't have to fix everything today. One patient step is a complete step." },
  { theme: 'systems',
    checkedIn: "Your system is working — you checked in. Tighten one small system today, like an automatic transfer.",
    notCheckedIn: "Willpower fades; systems stay. Set up one automatic money move today." },
  { theme: 'environment',
    checkedIn: "You're in a room full of people doing the work. Borrow their momentum today.",
    notCheckedIn: "Put your check-in where you'll see it. Make the next step the easy step." },
  { theme: 'tracking',
    checkedIn: "What gets tracked gets better, and you're tracking. Log one number today.",
    notCheckedIn: "You can't improve what you won't look at. Write down one money number today." },
  { theme: 'ask for help',
    checkedIn: "Strong builders ask questions. If you're stuck, bring it to the Room today.",
    notCheckedIn: "Stuck is normal; staying stuck is optional. Ask one question in the Room today." },
  { theme: 'celebrate',
    checkedIn: "You earned a small celebration — you checked in. Name one win out loud today.",
    notCheckedIn: "Wins count even before the check-in. Do one thing today worth writing down." },
  { theme: 'refocus',
    checkedIn: "Checked in means you're looking at the right things. Refocus on your one goal today.",
    notCheckedIn: "If the week got blurry, sharpen it: reread your 90-day goal, then take one action." },
  { theme: 'morning',
    checkedIn: "Start the day like someone who keeps promises. One money move before noon.",
    notCheckedIn: "Before the day runs you, run one money task. Two minutes is enough." },
  { theme: 'evening',
    checkedIn: "End the day knowing you showed up this week. Plan tomorrow's one action tonight.",
    notCheckedIn: "Tonight, take five minutes with your check-in. Tomorrow-you will be glad." },
  { theme: 'money date',
    checkedIn: "You keep your money dates — that's rare. Keep today's date short and sweet.",
    notCheckedIn: "Schedule a 10-minute money date with yourself today. Keep it, like it matters — it does." },
  { theme: 'automation',
    checkedIn: "Automated money is money that behaves. Check one auto-transfer today.",
    notCheckedIn: "The best money move is the one you don't have to remember. Automate one thing today." },
  { theme: 'learning',
    checkedIn: "Every check-in teaches you something. Apply one lesson from this week today.",
    notCheckedIn: "You don't need another course — you need one applied lesson. Pick one and use it." },
  { theme: 'gratitude',
    checkedIn: "Grateful builders keep building. Name one money thing that's working, then keep going.",
    notCheckedIn: "Start where you are, with what you have. One thankful step still moves you forward." },
  { theme: 'future self',
    checkedIn: "Your future self is already thanking you for the check-in. Do one more favor today.",
    notCheckedIn: "Ninety days from now, you'll wish you'd started today. So start today." },
  { theme: 'habits',
    checkedIn: "Habits beat intensity. You're proving it weekly — keep the rhythm today.",
    notCheckedIn: "Make it tiny enough to do daily. Shrink today's money task until it's easy." },
  { theme: 'friction',
    checkedIn: "You removed the friction of 'someday' by checking in. Remove one more friction today.",
    notCheckedIn: "If a money task feels hard, make it easier, not later. Shrink it and do it." },
  { theme: 'clarity',
    checkedIn: "Clarity compounds. Your check-in gave you clarity — act on one clear thing today.",
    notCheckedIn: "Confusion clears with action, not thought. Take one concrete step today." },
  { theme: 'resilience',
    checkedIn: "Setbacks don't stop builders who track. If this week was rough, your check-in still counts.",
    notCheckedIn: "A rough week is data, not defeat. Record it honestly in your check-in today." },
  { theme: 'community',
    checkedIn: "Your check-in might be the nudge someone else needs. Share one win in the Room today.",
    notCheckedIn: "You don't have to do this alone — that's what the Room is for. Show up there today." },
  { theme: 'trust',
    checkedIn: "You're becoming someone who keeps promises. Keep today's promise small and keep it.",
    notCheckedIn: "Trust is built in small kept promises. Make one tiny money promise today and keep it." },
  { theme: 'reset',
    checkedIn: "Every week is a fresh start, and you started this one right. Begin today clean.",
    notCheckedIn: "Today is a reset button. Press it with one honest check-in." },
  { theme: 'keep going',
    checkedIn: "Progress, not perfection — you're living it. One more day of steady.",
    notCheckedIn: "The only week worth worrying about is the one you ignore. Open your check-in and start." },
];

/** Calendar-day key 'YYYY-MM-DD' in America/Chicago for a timestamp. */
function chicagoDayString(now = Date.now()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Day-of-year (1-based) for a timestamp in America/Chicago. */
function chicagoDayOfYear(now = Date.now()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
}

function roomDailyNudgeBody(nudgeText, unsubscribeUrl) {
  const base = roomAppUrl();
  return `<p>Your daily Wealth Builder nudge:</p>` +
    `<p><strong>${nudgeText}</strong></p>` +
    `<p><a href="${base}/room/checkin">DO TODAY'S CHECK-IN</a></p>` +
    `<p><a href="${base}/room/progress">VIEW MY PROGRESS</a></p>` +
    `<p style="font-size:12px;color:#666;"><a href="${unsubscribeUrl}">Unsubscribe</a> from daily nudges.</p>`;
}

/**
 * Plain-text SMS twin of the daily nudge: a short version of the day's nudge
 * plus the check-in link. Always fits in 300 characters.
 */
function roomDailyNudgeSmsBody(variantText) {
  const base = roomAppUrl();
  const link = `${base}/room/checkin`;
  const prefix = 'Daily Wealth Builder nudge: ';
  const maxText = 300 - prefix.length - 1 - link.length;
  let text = String(variantText || '');
  if (text.length > maxText) text = text.slice(0, Math.max(0, maxText - 1)).trimEnd() + '…';
  return `${prefix}${text} ${link}`;
}

/**
 * Queue one 'room-daily-nudge' email per active, claimed member per
 * America/Chicago calendar day, plus one 'room-daily-nudge-sms' text for
 * members with a phone on record. Idempotent per (email, sequence, day): a
 * second pass the same day never duplicates a queued or sent nudge.
 * Members who already checked in this week get the warm variant; everyone
 * else gets the gentle action prompt. Never mails or texts suppressed
 * addresses.
 * Returns { email, sms } counts of rows queued.
 */
async function queueDailyNudges(now = Date.now()) {
  const day = chicagoDayString(now);
  const nudge = DAILY_NUDGES[chicagoDayOfYear(now) % DAILY_NUDGES.length];
  const site = config.getSite() || {};
  const members = await db.all(
    "SELECT email, phone FROM room_members WHERE status = 'active' AND password_hash IS NOT NULL"
  );
  let emailQueued = 0;
  let smsQueued = 0;
  for (const m of members) {
    const emailAddr = String(m.email || '').trim().toLowerCase();
    if (!emailAddr) continue;
    if (await isSuppressed(emailAddr)) continue;
    let checkedIn = false;
    try {
      const info = await room.weekInfo(emailAddr);
      if (info) checkedIn = !!(await room.getCheckin(emailAddr, info.currentWeek));
    } catch (err) { /* no goal yet — treat as not checked in */ }
    const variant = checkedIn ? nudge.checkedIn : nudge.notCheckedIn;
    const emailDupe = await db.get(
      "SELECT 1 FROM email_queue WHERE email = ? AND sequence = 'room-daily-nudge' AND step = ? AND status IN ('queued','sent','provider-stub')",
      [emailAddr, day]
    );
    if (!emailDupe) {
      const unsubscribeUrl = buildVars({ email: emailAddr }, {}, site).unsubscribe_url;
      await db.run(
        `INSERT INTO email_queue
           (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
         VALUES (NULL, ?, 'room-daily-nudge', ?, 'Your Daily Wealth Builder Nudge', ?, 'room', ?, 'queued')`,
        [emailAddr, day, roomDailyNudgeBody(variant, unsubscribeUrl), now]
      );
      emailQueued++;
    }
    const phone = String(m.phone || '').replace(/\D/g, '');
    if (phone) {
      const smsDupe = await db.get(
        "SELECT 1 FROM email_queue WHERE email = ? AND sequence = 'room-daily-nudge-sms' AND step = ? AND status IN ('queued','sent','provider-stub')",
        [emailAddr, day]
      );
      if (!smsDupe) {
        await db.run(
          `INSERT INTO email_queue
             (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
           VALUES (NULL, ?, 'room-daily-nudge-sms', ?, 'Daily Wealth Builder Nudge', ?, 'room', ?, 'queued')`,
          [emailAddr, day, roomDailyNudgeSmsBody(variant), now]
        );
        smsQueued++;
      }
    }
  }
  return { email: emailQueued, sms: smsQueued };
}

// --- Sending ----------------------------------------------------------------------
async function cancelRow(id, reason) {
  await db.run("UPDATE email_queue SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [reason, id]);
  return 'cancelled';
}

/** Apply send-time guards and send one due queue row. Returns 'sent' | 'cancelled'. */
async function processOneEmail(row) {
  // Daily-nudge SMS twins ride the same queue table but go out by text.
  if (row.sequence === 'room-daily-nudge-sms') {
    return processRoomSms(row);
  }
  // TransitNow route-match notifications: email goes to the driver directly
  // (no lead record required); SMS goes out by text via the provider stub
  // until Davena configures a real SMS provider.
  if (row.sequence === 'route-match-sms') {
    return processRouteMatchSms(row);
  }
  if (row.sequence === 'route-match') {
    return processRouteMatchEmail(row);
  }
  // Private operations assistant (Complete tier): the answer-ready email goes
  // to the driver directly; the text twin rides the provider stub until a
  // real SMS provider is configured.
  if (row.sequence === 'assistant-answer') {
    return processAssistantAnswerEmail(row);
  }
  if (row.sequence === 'assistant-answer-sms') {
    return processAssistantAnswerSms(row);
  }
  // Dispatch <-> driver field communications: broadcast and direct admin
  // messages go to the driver directly (no lead record required). Email via
  // the configured provider; SMS twins ride the provider stub until Davena
  // configures a real SMS provider — queued and marked 'provider-stub'
  // (provider-pending), never claimed as delivered.
  if (row.sequence === 'field-broadcast' || row.sequence === 'field-message') {
    return processFieldMessageEmail(row);
  }
  if (row.sequence === 'field-broadcast-sms' || row.sequence === 'field-message-sms') {
    return processFieldMessageSms(row);
  }
  // Private assistant weekly spotlight (Complete tier): the email goes to
  // the driver directly, same as other driver notifications.
  if (row.sequence === 'assistant-weekly') {
    return processAssistantAnswerEmail(row);
  }
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

/**
 * Send one due Room daily-nudge SMS. Guards: the address must belong to an
 * active member with a phone on record, and must not be suppressed
 * (unsubscribing adds a suppression, so it stops texts too). The SMS
 * provider is a stub until the owner configures a real one — nothing is
 * actually delivered, and the row is marked 'provider-stub'.
 */
async function processRoomSms(row) {
  const emailAddr = String(row.email || '').trim().toLowerCase();
  if (!emailAddr) return cancelRow(row.id, 'lead-missing');
  if (await isSuppressed(emailAddr)) return cancelRow(row.id, 'suppressed');
  const member = await room.getMember(emailAddr);
  if (!member || member.status !== 'active') return cancelRow(row.id, 'inactive-member');
  const phone = String(member.phone || '').replace(/\D/g, '');
  if (!phone) return cancelRow(row.id, 'no-phone');
  await sms.sendSms({ to: phone, body: row.body_html, queueId: row.id });
  return 'sent';
}

/**
 * Send one "your assistant replied" email. Guards: valid address, not
 * suppressed. No lead record is required (drivers onboard outside the
 * marketing-lead flow). Never claims delivery beyond the mail provider.
 */
async function processAssistantAnswerEmail(row) {
  const emailAddr = String(row.email || '').trim().toLowerCase();
  if (!emailAddr) return cancelRow(row.id, 'lead-missing');
  if (await isSuppressed(emailAddr)) return cancelRow(row.id, 'suppressed');
  await email.sendEmail({
    to: emailAddr,
    subject: row.subject,
    html: row.body_html,
    queueId: row.id,
    fromName: 'TransitNow Dispatch',
  });
  return 'sent';
}

/**
 * Send one "your assistant replied" SMS. Guards: address maps to a driver
 * with a phone on record, not suppressed. The SMS provider is a stub until
 * the owner configures a real one — the row is queued and marked
 * 'provider-stub' (provider-pending), never claimed as delivered.
 */
async function processAssistantAnswerSms(row) {
  const emailAddr = String(row.email || '').trim().toLowerCase();
  if (!emailAddr) return cancelRow(row.id, 'lead-missing');
  if (await isSuppressed(emailAddr)) return cancelRow(row.id, 'suppressed');
  const driver = await db.get('SELECT id, phone FROM drivers WHERE LOWER(email) = ?', [emailAddr]);
  if (!driver) return cancelRow(row.id, 'driver-missing');
  const phone = String(driver.phone || '').replace(/\D/g, '');
  if (!phone) return cancelRow(row.id, 'no-phone');
  await sms.sendSms({ to: phone, body: row.body_html, queueId: row.id });
  return 'sent';
}

/**
 * Send one dispatch field email (broadcast or direct admin message).
 * Guards: valid address, not suppressed. No lead record is required
 * (drivers onboard outside the marketing-lead flow). Never claims delivery
 * beyond the mail provider.
 */
async function processFieldMessageEmail(row) {
  const emailAddr = String(row.email || '').trim().toLowerCase();
  if (!emailAddr) return cancelRow(row.id, 'lead-missing');
  if (await isSuppressed(emailAddr)) return cancelRow(row.id, 'suppressed');
  await email.sendEmail({
    to: emailAddr,
    subject: row.subject,
    html: row.body_html,
    queueId: row.id,
    fromName: 'TransitNow Dispatch',
  });
  return 'sent';
}

/**
 * Send one dispatch field SMS (broadcast or direct admin message twin).
 * Guards: address maps to a driver with a phone on record, not suppressed.
 * The SMS provider is a stub until the owner configures a real one — the
 * row is queued and marked 'provider-stub' (provider-pending), never
 * claimed as delivered.
 */
async function processFieldMessageSms(row) {
  const emailAddr = String(row.email || '').trim().toLowerCase();
  if (!emailAddr) return cancelRow(row.id, 'lead-missing');
  if (await isSuppressed(emailAddr)) return cancelRow(row.id, 'suppressed');
  const driver = await db.get('SELECT id, phone FROM drivers WHERE LOWER(email) = ?', [emailAddr]);
  if (!driver) return cancelRow(row.id, 'driver-missing');
  const phone = String(driver.phone || '').replace(/\D/g, '');
  if (!phone) return cancelRow(row.id, 'no-phone');
  await sms.sendSms({ to: phone, body: row.body_html, queueId: row.id });
  return 'sent';
}

/**
 * Send one TransitNow route-match email. Guards: valid address, not
 * suppressed. No lead record is required (drivers onboard outside the
 * marketing-lead flow). Never claims delivery beyond the mail provider.
 */
async function processRouteMatchEmail(row) {
  const emailAddr = String(row.email || '').trim().toLowerCase();
  if (!emailAddr) return cancelRow(row.id, 'lead-missing');
  if (await isSuppressed(emailAddr)) return cancelRow(row.id, 'suppressed');
  await email.sendEmail({
    to: emailAddr,
    subject: row.subject,
    html: row.body_html,
    queueId: row.id,
    fromName: 'TransitNow Dispatch',
  });
  return 'sent';
}

/**
 * Send one TransitNow route-match SMS. Guards: address maps to a driver with
 * a phone on record, not suppressed. The SMS provider is a stub until the
 * owner configures a real one — the row is queued and marked
 * 'provider-stub' (provider-pending), never claimed as delivered.
 */
async function processRouteMatchSms(row) {
  const emailAddr = String(row.email || '').trim().toLowerCase();
  if (!emailAddr) return cancelRow(row.id, 'lead-missing');
  if (await isSuppressed(emailAddr)) return cancelRow(row.id, 'suppressed');
  const driver = await db.get('SELECT id, phone FROM drivers WHERE LOWER(email) = ?', [emailAddr]);
  if (!driver) return cancelRow(row.id, 'driver-missing');
  const phone = String(driver.phone || '').replace(/\D/g, '');
  if (!phone) return cancelRow(row.id, 'no-phone');
  await sms.sendSms({ to: phone, body: row.body_html, queueId: row.id });
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
 * reminders, room daily nudges, then due emails. Called every 60s from server.js and on demand
 * via POST /admin/run-scheduler.
 */
async function runSchedulerPass() {
  const now = Date.now();
  const abandoned = await detectAbandonedCarts(now);
  const checkinReminders = await queueCheckinReminders(now);
  const nudges = await queueDailyNudges(now);
  const routeMatches = await queueMondayRouteMatches(now);
  const assistantWeekly = await queueMondayAssistantEmails(now);
  const roomAssistantWeekly = await queueMondayRoomAssistantEmails(now);
  const { sent, cancelled } = await processDueEmails(now);
  return { sent, cancelled, abandonedCarts: abandoned, checkinReminders, dailyNudges: nudges.email, dailyNudgeSms: nudges.sms, routeMatchCycle: routeMatches, assistantWeekly, roomAssistantWeekly };
}

function escHtmlLocal(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Monday private-assistant email for Complete drivers. Runs at most once per
 * Chicago calendar week: on Mondays every ACTIVE Complete subscriber gets
 * "This week with your private assistant" listing that week's 3 rotating
 * spotlight capabilities with example questions. Basic, past-due, canceled,
 * and unpaid drivers are never queued. Non-Monday days and repeat calls in
 * the same week are no-ops (idempotent per week).
 */
async function queueMondayAssistantEmails(now = Date.now()) {
  try {
    const rm = require('./route_matching');
    const caps = require('./ai_capabilities');
    if (!rm.isMondayChicago(now)) return { ran: false, reason: 'not-monday' };
    const weekKey = rm.chicagoWeekKey(now);
    const spotlight = caps.weeklySpotlight(caps.DRIVER_CAPABILITIES, weekKey);
    const subs = await db.all(
      `SELECT email FROM dispatch_subscriptions WHERE status = 'active' AND plan = 'complete'`
    );
    let queued = 0;
    for (const s of subs) {
      const emailAddr = String(s.email || '').trim().toLowerCase();
      if (!emailAddr) continue;
      if (await isSuppressed(emailAddr)) continue;
      const dupe = await db.get(
        `SELECT 1 FROM email_queue WHERE email = ? AND sequence = 'assistant-weekly' AND step = ? AND status IN ('queued','sent','provider-stub')`,
        [emailAddr, weekKey]
      );
      if (dupe) continue;
      const drv = await db.get('SELECT full_name FROM drivers WHERE LOWER(email) = ? ORDER BY id DESC LIMIT 1', [emailAddr]);
      const name = drv && drv.full_name ? String(drv.full_name).split(' ')[0] : 'there';
      const spotItems = spotlight.map((c) =>
        `<li><strong>${escHtmlLocal(c.title)}</strong> — ${escHtmlLocal(c.description)}<br><em>Try asking: “${escHtmlLocal(c.example_ask)}”</em></li>`
      ).join('\n');
      const body = [
        `<p>Hi ${escHtmlLocal(name)},</p>`,
        `<p>This week with your private assistant — <strong>${caps.DRIVER_CAPABILITIES.length} things</strong> it can do with you. Here are 3 to try:</p>`,
        `<ul>${spotItems}</ul>`,
        `<p>Ask from your driver dashboard any time — your private operations assistant is part of your Complete plan.</p>`,
        `<p style="color:#888;font-size:12px">TransitNow Logistics Services. Guidance only — no guaranteed loads, routes, revenue, or earnings.</p>`,
      ].join('\n');
      await db.run(
        `INSERT INTO email_queue
           (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
         VALUES (NULL, ?, 'assistant-weekly', ?, ?, ?, NULL, ?, 'queued')`,
        [emailAddr, weekKey, 'This week with your private assistant', body, now]
      );
      queued++;
    }
    console.log(`[scheduler] monday assistant emails: queued=${queued} week=${weekKey}`);
    return { ran: true, queued, weekKey };
  } catch (err) {
    console.error('[scheduler] monday assistant emails failed:', err.message);
    return { ran: false, reason: 'error', error: err.message };
  }
}

/**
 * Monday assistant email for Wealth Room members (business-growth flavor).
 * On Mondays every ACTIVE claimed member gets "This week in the Room" with
 * 3 rotating room capabilities. Never mails canceled, inactive, suppressed,
 * or unclaimed members. Idempotent per week.
 */
async function queueMondayRoomAssistantEmails(now = Date.now()) {
  try {
    const rm = require('./route_matching');
    const caps = require('./ai_capabilities');
    if (!rm.isMondayChicago(now)) return { ran: false, reason: 'not-monday' };
    const weekKey = rm.chicagoWeekKey(now);
    const spotlight = caps.weeklySpotlight(caps.ROOM_CAPABILITIES, weekKey);
    const members = await db.all(
      `SELECT email, name FROM room_members WHERE status = 'active' AND password_hash IS NOT NULL`
    );
    let queued = 0;
    for (const m of members) {
      const emailAddr = String(m.email || '').trim().toLowerCase();
      if (!emailAddr) continue;
      if (await isSuppressed(emailAddr)) continue;
      const dupe = await db.get(
        `SELECT 1 FROM email_queue WHERE email = ? AND sequence = 'room-assistant-weekly' AND step = ? AND status IN ('queued','sent','provider-stub')`,
        [emailAddr, weekKey]
      );
      if (dupe) continue;
      const name = m.name ? String(m.name).split(' ')[0] : 'Wealth Builder';
      const spotItems = spotlight.map((c) =>
        `<li><strong>${escHtmlLocal(c.title)}</strong> — ${escHtmlLocal(c.description)}<br><em>Try: “${escHtmlLocal(c.example_ask)}”</em></li>`
      ).join('\n');
      const body = [
        `<p>Hi ${escHtmlLocal(name)},</p>`,
        `<p>This week in the Room: <strong>${caps.ROOM_CAPABILITIES.length} things</strong> your AI can build with you. Here are 3 to try:</p>`,
        `<ul>${spotItems}</ul>`,
        `<p>Bring your questions to the classroom — your private operations assistant is part of your membership.</p>`,
        `<p style="color:#888;font-size:12px">Wealth Builder's Room. Guidance only — no guaranteed income, revenue, or results.</p>`,
      ].join('\n');
      await db.run(
        `INSERT INTO email_queue
           (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
         VALUES (NULL, ?, 'room-assistant-weekly', ?, ?, ?, 'room', ?, 'queued')`,
        [emailAddr, weekKey, `This week in the Room: ${caps.ROOM_CAPABILITIES.length} things your AI can build with you`, body, now]
      );
      queued++;
    }
    console.log(`[scheduler] monday room assistant emails: queued=${queued} week=${weekKey}`);
    return { ran: true, queued, weekKey };
  } catch (err) {
    console.error('[scheduler] monday room assistant emails failed:', err.message);
    return { ran: false, reason: 'error', error: err.message };
  }
}

/**
 * Monday route-match cycle (TransitNow dispatch tiers). Runs at most once per
 * Chicago calendar week: on Mondays it matches every ACTIVE-subscriber
 * driver (Complete tier first), refilling each driver back to their tier
 * quota from real OPEN opportunities. Non-Monday days and repeat calls in
 * the same week are no-ops (the cycle is idempotent per week).
 */
async function queueMondayRouteMatches(now = Date.now()) {
  try {
    const rm = require('./route_matching');
    if (!rm.isMondayChicago(now)) return { ran: false, reason: 'not-monday' };
    const r = await rm.runMondayCycle({ now });
    if (r.alreadyRan) return { ran: false, reason: 'already-ran', cycleKey: r.cycleKey };
    console.log(`[scheduler] monday route-match cycle: considered=${r.considered} matched=${r.matched} created=${r.createdTotal} notified=${r.notified}`);
    return { ran: true, ...r };
  } catch (err) {
    console.error('[scheduler] monday route-match cycle failed:', err.message);
    return { ran: false, reason: 'error', error: err.message };
  }
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
  queueDailyNudges,
  queueMondayRouteMatches,
  queueMondayAssistantEmails,
  queueMondayRoomAssistantEmails,
  processDueEmails,
  detectAbandonedCarts,
  runSchedulerPass,
};
