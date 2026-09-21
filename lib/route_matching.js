'use strict';
/**
 * lib/route_matching.js — Automated tier-based route matching for paid
 * TransitNow dispatch subscribers.
 *
 * Davena-approved tier spec (exact, no soft edges):
 *   Basic $50/mo:    full onboarding (carrier/business/vehicle info review),
 *                    basic dispatch setup, 2 route matches every Monday from
 *                    opportunities in the driver's city/state, weekly goal
 *                    tracker, matches delivered by email AND text, ongoing
 *                    dispatch support.
 *   Complete $100/mo: everything in Basic, PLUS 5 route matches on day one of
 *                    onboarding, refilled back to 5 active matches every
 *                    Monday, matched FIRST (priority over Basic in every
 *                    cycle), freight/lane preferences applied, load-search
 *                    prep, broker verification guidance, paperwork + route
 *                    planning support.
 *
 * HARD RULES (enforced here, not just documented):
 *   1. Matches come ONLY from real rows in the `opportunities` table with
 *      status OPEN. Loads, rates, and shippers are NEVER fabricated. If no
 *      opportunity matches a driver's city/state, the driver gets an honest
 *      "no current matches" notice — never fake matches.
 *   2. Only drivers with an ACTIVE dispatch subscription are matched.
 *      past_due / canceled / missing -> matching pauses automatically.
 *   3. The weekly dollar figure is a DRIVER-SET GOAL tracked toward, never a
 *      promise. All copy carries no-guarantee language: no promised routes,
 *      loads, contracts, earnings, or income.
 *   4. A "match" is a Potential Match (may fit the requirements), never an
 *      offer of work.
 *
 * Notifications ride the existing outbox (email_queue):
 *   - email: sequence 'route-match'
 *   - sms:   sequence 'route-match-sms' (provider stub until Davena
 *            configures a real SMS provider — queued and marked
 *            provider-pending, never claimed as delivered)
 */
const db = require('./db');
const subscriptions = require('./subscriptions');

// --- Tier rules -----------------------------------------------------------------
const TIER_QUOTAS = { basic: 2, complete: 5 };
const TIER_PRIORITY = { complete: 0, basic: 1 }; // Complete matched FIRST.
const VALID_TIERS = ['basic', 'complete'];

const NO_GUARANTEE_LINE =
  'Route matches are potential opportunities only. TransitNow does not promise or guarantee routes, loads, contracts, work, earnings, or income. ' +
  'Actual opportunities depend on territory, client demand, your qualifications, and availability.';

// --- Chicago week key ------------------------------------------------------------
function chicagoWeekKey(nowMs = Date.now()) {
  // America/Chicago calendar week (Monday-start), e.g. "2026-W39".
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  const y = Number(get('year')), m = Number(get('month')) - 1, d = Number(get('day'));
  const dt = new Date(Date.UTC(y, m, d));
  // Shift to Thursday of the same ISO week, then compute ISO week number.
  const day = (dt.getUTCDay() + 6) % 7; // Monday=0
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const isoYear = dt.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4day = (jan4.getUTCDay() + 6) % 7;
  const week1monday = new Date(jan4);
  week1monday.setUTCDate(jan4.getUTCDate() - jan4day);
  const week = 1 + Math.round((dt - week1monday) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function isMondayChicago(nowMs = Date.now()) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' })
    .format(new Date(nowMs));
  return wd === 'Mon';
}

// --- Opportunity scoring ----------------------------------------------------------
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function words(s) {
  return norm(s).split(' ').filter(Boolean);
}

/**
 * Score an opportunity for a driver: city match +3, state match +2.
 * Matching is whole-word (a 2-letter state like "IL" must appear as its own
 * word — it must NOT match inside "Milwaukee"). Only opportunities with a
 * positive score are candidates. Newer opportunities win ties (recency).
 */
function scoreOpportunity(driver, opp) {
  const hayWords = new Set(words([opp.location, opp.service_area, opp.territory].filter(Boolean).join(' ')));
  if (hayWords.size === 0) return 0;
  const cityWords = words(driver.home_city);
  const stateWords = words(driver.home_state);
  let score = 0;
  if (cityWords.length > 0 && cityWords.every((w) => hayWords.has(w))) score += 3;
  if (stateWords.length > 0 && stateWords.every((w) => hayWords.has(w))) score += 2;
  return score;
}

async function openOpportunities() {
  return db.all(
    `SELECT * FROM opportunities WHERE status = 'OPEN' ORDER BY created_at DESC, id DESC`
  );
}

/**
 * Ranked candidate opportunities for a driver: OPEN status, positive
 * city/state score, newest first on ties. Excludes opportunities the driver
 * already holds as an active match.
 */
async function candidatesForDriver(driver, excludeOppIds = []) {
  const opps = await openOpportunities();
  const excluded = new Set(excludeOppIds);
  return opps
    .map((o) => ({ opp: o, score: scoreOpportunity(driver, o) }))
    .filter((c) => c.score > 0 && !excluded.has(c.opp.id))
    .sort((a, b) => (b.score - a.score) || ((b.opp.created_at || 0) - (a.opp.created_at || 0)))
    .map((c) => c.opp);
}

async function activeMatches(driverId) {
  return db.all(
    `SELECT m.*, o.name AS opportunity_name, o.location AS opportunity_location
       FROM driver_route_matches m
       LEFT JOIN opportunities o ON o.id = m.opportunity_id
      WHERE m.driver_id = ? AND m.status = 'assigned'
      ORDER BY m.matched_at ASC, m.id ASC`,
    [driverId]
  );
}

async function getDriver(id) {
  return db.get('SELECT * FROM drivers WHERE id = ?', [id]);
}

async function driverPlan(driver) {
  const sub = await subscriptions.getByEmail(String(driver.email || '').trim().toLowerCase());
  if (!sub || sub.status !== 'active') return null;
  const plan = String(sub.plan || '').toLowerCase();
  return VALID_TIERS.includes(plan) ? plan : null;
}

// --- Notification content ----------------------------------------------------------
function matchEmailHtml(driver, plan, matches, weekKey) {
  const tierName = plan === 'complete' ? 'Complete' : 'Basic';
  const items = matches.map((m) =>
    `<li><strong>${esc(m.opportunity_name || 'Route opportunity')}</strong>` +
    (m.opportunity_location ? ` — ${esc(m.opportunity_location)}` : '') +
    ` <span style="color:#555">(potential match)</span></li>`
  ).join('');
  return `<p>Hi ${esc(driver.full_name || 'there')},</p>` +
    `<p>Your TransitNow <strong>${tierName}</strong> dispatch plan matched you with ` +
    `<strong>${matches.length} route ${matches.length === 1 ? 'opportunity' : 'opportunities'}</strong> ` +
    `for the week of ${esc(weekKey)}:</p>` +
    `<ul>${items}</ul>` +
    `<p>Review each opportunity and follow up through your normal dispatch process. ` +
    `A match means the opportunity may fit your profile — it is not an offer of work.</p>` +
    `<p style="font-size:13px;color:#555">${esc(NO_GUARANTEE_LINE)}</p>`;
}

function noMatchEmailHtml(driver, plan, weekKey) {
  const tierName = plan === 'complete' ? 'Complete' : 'Basic';
  return `<p>Hi ${esc(driver.full_name || 'there')},</p>` +
    `<p>Your TransitNow <strong>${tierName}</strong> dispatch plan ran its weekly route match ` +
    `for the week of ${esc(weekKey)}, and there are <strong>no current opportunities in our database ` +
    `for your city/state right now</strong>.</p>` +
    `<p>We'd rather tell you that honestly than send you matches that aren't real. ` +
    `New opportunities are added as they come in, and your next cycle will run automatically.</p>` +
    `<p style="font-size:13px;color:#555">${esc(NO_GUARANTEE_LINE)}</p>`;
}

function matchSmsBody(driver, plan, count) {
  const tierName = plan === 'complete' ? 'Complete' : 'Basic';
  if (count === 0) {
    return `TransitNow: Hi ${driver.full_name || 'there'} — this week's ${tierName} route match found no current opportunities in your area. No fake matches, ever. New ones are added as they come in.`;
  }
  return `TransitNow: Hi ${driver.full_name || 'there'} — your ${tierName} plan matched you with ${count} route opportunit${count === 1 ? 'y' : 'ies'} this week. Check your email for details. Matches are potential opportunities, not guaranteed work.`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function queueMatchEmail(driver, plan, matches, weekKey, kind) {
  const html = matches.length ? matchEmailHtml(driver, plan, matches, weekKey)
                              : noMatchEmailHtml(driver, plan, weekKey);
  const subject = matches.length
    ? `Your ${matches.length} TransitNow route ${matches.length === 1 ? 'match' : 'matches'} — week of ${weekKey}`
    : `TransitNow weekly route match — no current matches in your area`;
  const info = await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, 'route-match', ?, ?, ?, NULL, ?, 'queued')`,
    [String(driver.email).trim().toLowerCase(), `${kind}:${weekKey}:${plan}`, subject, html, Date.now()]
  );
  return info.lastInsertRowid;
}

async function queueMatchSms(driver, plan, count, weekKey, kind) {
  const phone = String(driver.phone || '').replace(/\D/g, '');
  if (!phone) return null;
  const info = await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, 'route-match-sms', ?, 'TransitNow route matches', ?, NULL, ?, 'queued')`,
    [String(driver.email).trim().toLowerCase(), `${kind}:${weekKey}:${plan}`, matchSmsBody(driver, plan, count), Date.now()]
  );
  return info.lastInsertRowid;
}

// --- Core matching -------------------------------------------------------------------
/**
 * Run one matching pass for a driver.
 * kind: 'onboarding' (assign full tier quota immediately) or 'monday'
 * (refill back up to the tier quota). Returns a result object describing
 * what happened — including skips for inactive subscriptions.
 */
async function runMatchForDriver(driver, { kind = 'monday', weekKey = null } = {}) {
  const wk = weekKey || chicagoWeekKey();
  const plan = await driverPlan(driver);
  if (!plan) {
    return { ok: false, skipped: true, reason: 'no-active-subscription', driverId: driver.id, plan: null };
  }
  const quota = TIER_QUOTAS[plan];
  const current = await activeMatches(driver.id);
  const need = kind === 'onboarding' ? quota : Math.max(0, quota - current.length);
  let created = [];
  if (need > 0) {
    const held = current.map((m) => m.opportunity_id);
    const cands = await candidatesForDriver(driver, held);
    const picks = cands.slice(0, need);
    const now = Date.now();
    for (const opp of picks) {
      try {
        const info = await db.run(
          `INSERT INTO driver_route_matches
             (driver_id, opportunity_id, tier, cycle_key, status, matched_at)
           VALUES (?, ?, ?, ?, 'assigned', ?)`,
          [driver.id, opp.id, plan, `${kind}:${wk}`, now]
        );
        created.push({ id: info.lastInsertRowid, opportunity_id: opp.id,
          opportunity_name: opp.name, opportunity_location: opp.location });
      } catch (err) {
        // UNIQUE(driver_id, opportunity_id, cycle_key) — same-cycle dupe, skip.
        if (!String(err.message || '').includes('UNIQUE')) throw err;
      }
    }
  }
  const after = await activeMatches(driver.id);
  // Notify: honest note when nothing matched, full list otherwise.
  const emailId = await queueMatchEmail(driver, plan, after, wk, kind);
  const smsId = await queueMatchSms(driver, plan, after.length, wk, kind);
  await db.recordEvent({
    lead_id: null, type: 'route_match_run', product_id: null,
    meta: { driver_id: driver.id, plan, kind, week_key: wk,
      created: created.length, active_total: after.length, quota },
  });
  return {
    ok: true, skipped: false, driverId: driver.id, plan, quota,
    created: created.length, activeTotal: after.length,
    notified: { email: emailId, sms: smsId },
  };
}

/**
 * Monday cycle: match every ACTIVE-subscriber driver, Complete tier first
 * (priority), then Basic. Idempotent per Chicago week — a second call in the
 * same week only refills drivers whose quota changed (e.g. new subscribers).
 */
async function runMondayCycle({ now = Date.now(), force = false } = {}) {
  const wk = chicagoWeekKey(now);
  const cycleKey = `monday:${wk}`;
  const existing = await db.get('SELECT * FROM route_match_cycles WHERE cycle_key = ?', [cycleKey]);
  if (existing && !force) {
    return { ok: true, alreadyRan: true, cycleKey, weekKey: wk };
  }
  const drivers = await db.all(
    `SELECT d.* FROM drivers d
      JOIN dispatch_subscriptions s ON LOWER(s.email) = LOWER(d.email)
     WHERE s.status = 'active'
     ORDER BY CASE LOWER(s.plan) WHEN 'complete' THEN 0 WHEN 'basic' THEN 1 ELSE 2 END,
              d.id ASC`
  );
  let considered = 0, matched = 0, createdTotal = 0, notified = 0;
  const order = [];
  for (const driver of drivers) {
    considered++;
    order.push(driver.id);
    const r = await runMatchForDriver(driver, { kind: 'monday', weekKey: wk });
    if (r.ok && !r.skipped) {
      matched++;
      createdTotal += r.created;
      if (r.notified.email) notified++;
    }
  }
  await db.run(
    `INSERT INTO route_match_cycles
       (cycle_key, kind, ran_at, drivers_considered, drivers_matched, matches_created, notifications_queued, notes)
     VALUES (?, 'monday', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cycle_key) DO UPDATE SET
       ran_at = excluded.ran_at,
       drivers_considered = excluded.drivers_considered,
       drivers_matched = excluded.drivers_matched,
       matches_created = excluded.matches_created,
       notifications_queued = excluded.notifications_queued,
       notes = excluded.notes`,
    [cycleKey, Date.now(), considered, matched, createdTotal, notified,
     `priority order: complete-tier drivers first (driver ids: ${order.join(',') || 'none'})`]
  );
  return { ok: true, alreadyRan: false, cycleKey, weekKey: wk, considered, matched, createdTotal, notified, order };
}

/** Release one active match (admin override). The slot refills next cycle. */
async function releaseMatch(matchId, reason = 'admin-release') {
  const m = await db.get('SELECT * FROM driver_route_matches WHERE id = ?', [matchId]);
  if (!m) throw new Error('Match not found');
  if (m.status !== 'assigned') return m;
  await db.run(
    `UPDATE driver_route_matches SET status = 'released', released_at = ?, release_reason = ? WHERE id = ?`,
    [Date.now(), String(reason).slice(0, 200), matchId]
  );
  return db.get('SELECT * FROM driver_route_matches WHERE id = ?', [matchId]);
}

/** Admin manual assign: driver + opportunity, tier recorded from subscription. */
async function assignMatch(driverId, opportunityId, { by = 'admin' } = {}) {
  const driver = await getDriver(driverId);
  if (!driver) throw new Error('Driver not found');
  const opp = await db.get('SELECT * FROM opportunities WHERE id = ?', [opportunityId]);
  if (!opp) throw new Error('Opportunity not found');
  const plan = (await driverPlan(driver)) || 'manual';
  const wk = chicagoWeekKey();
  const info = await db.run(
    `INSERT INTO driver_route_matches
       (driver_id, opportunity_id, tier, cycle_key, status, matched_at)
     VALUES (?, ?, ?, ?, 'assigned', ?)`,
    [driverId, opportunityId, plan, `manual:${wk}:${by}`, Date.now()]
  );
  await db.recordEvent({
    lead_id: null, type: 'route_match_manual', product_id: null,
    meta: { driver_id: driverId, opportunity_id: opportunityId, by },
  });
  return db.get('SELECT * FROM driver_route_matches WHERE id = ?', [info.lastInsertRowid]);
}

// --- Weekly goal tracker ----------------------------------------------------------------
/**
 * The weekly dollar goal is set BY the driver and tracked toward — never a
 * promise. goalProgress() reports assigned route matches vs the tier quota
 * alongside the driver's own dollar target, with no-guarantee copy.
 * We never invent dollar values for opportunities (no fake rates).
 */
async function setWeeklyGoal(driverId, goalCents, weekKey = null) {
  const wk = weekKey || chicagoWeekKey();
  const cents = Math.max(0, Math.round(Number(goalCents) || 0));
  await db.run(
    `INSERT INTO driver_weekly_goals (driver_id, week_key, goal_cents, set_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(driver_id, week_key) DO UPDATE SET goal_cents = excluded.goal_cents, set_at = excluded.set_at`,
    [driverId, wk, cents, Date.now()]
  );
  return getWeeklyGoal(driverId, wk);
}

async function getWeeklyGoal(driverId, weekKey = null) {
  const wk = weekKey || chicagoWeekKey();
  const row = await db.get(
    'SELECT * FROM driver_weekly_goals WHERE driver_id = ? AND week_key = ?', [driverId, wk]);
  return row ? row.goal_cents : 0;
}

async function goalProgress(driverId, weekKey = null) {
  const driver = await getDriver(driverId);
  if (!driver) throw new Error('Driver not found');
  const wk = weekKey || chicagoWeekKey();
  const plan = await driverPlan(driver);
  const quota = plan ? TIER_QUOTAS[plan] : 0;
  const assigned = await activeMatches(driverId);
  const goalCents = await getWeeklyGoal(driverId, wk);
  const fmt$ = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
  const copy = plan
    ? `${assigned.length} of ${quota} route ${quota === 1 ? 'match' : 'matches'} assigned` +
      (goalCents > 0 ? ` · your weekly goal: ${fmt$(goalCents)}` : ' · no weekly goal set yet') +
      `. ${NO_GUARANTEE_LINE}`
    : `Route matching is paused — no active dispatch subscription. ${NO_GUARANTEE_LINE}`;
  return { driverId, weekKey: wk, plan, quota, assignedCount: assigned.length, goalCents, copy };
}

async function recentCycles(limit = 20) {
  return db.all('SELECT * FROM route_match_cycles ORDER BY ran_at DESC, id DESC LIMIT ?', [limit]);
}

async function matchesForDriver(driverId, limit = 50) {
  return db.all(
    `SELECT m.*, o.name AS opportunity_name, o.location AS opportunity_location, o.status AS opportunity_status
       FROM driver_route_matches m
       LEFT JOIN opportunities o ON o.id = m.opportunity_id
      WHERE m.driver_id = ?
      ORDER BY m.matched_at DESC, m.id DESC LIMIT ?`,
    [driverId, limit]
  );
}

module.exports = {
  TIER_QUOTAS,
  NO_GUARANTEE_LINE,
  chicagoWeekKey,
  isMondayChicago,
  scoreOpportunity,
  candidatesForDriver,
  activeMatches,
  driverPlan,
  matchesForDriver,
  runMatchForDriver,
  runMondayCycle,
  releaseMatch,
  assignMatch,
  setWeeklyGoal,
  getWeeklyGoal,
  goalProgress,
  recentCycles,
  queueMatchEmail,
  queueMatchSms,
};
