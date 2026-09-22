// lib/referrals.js — Phase 6: driver referral system (spec section 31),
// plus the two-sided milestone payout program (Veho-style).
//
// Approved users (drivers / leads) can be issued a referral code by admin —
// and every new driver gets one automatically at signup. Applications
// carrying that code (lead_sources.referral_code, collected by the Phase-1
// grow funnel) are attributed to the code: referral source, referred person,
// application (linked opportunity_leads row), status, opportunity, outcome.
//
// Milestone payouts: when a referred driver becomes a paid dispatch
// subscriber and stays active MILESTONE_DAYS, the referrer earns
// REFERRER_BONUS_CENTS and the referred driver earns REFERRED_BONUS_CENTS.
// Test subscriptions (is_test=1) never earn. Pending rows void automatically
// if the subscription lapses before the milestone. Admin marks earned rows
// paid after paying out by hand — the app tracks, it never moves money.
'use strict';

const crypto = require('crypto');
const db = require('./db');

// Program terms. Davena-approved 2026-09-22. Overridable via env without a
// code change: REFERRAL_REFERRER_CENTS, REFERRAL_REFERRED_CENTS,
// REFERRAL_MILESTONE_DAYS.
const PROGRAM = {
  referrerBonusCents: Number(process.env.REFERRAL_REFERRER_CENTS) || 5000, // $50
  referredBonusCents: Number(process.env.REFERRAL_REFERRED_CENTS) || 2500, // $25
  milestoneDays: Number(process.env.REFERRAL_MILESTONE_DAYS) || 30,
  milestone: 'paid_30d',
};

function fmtDollars(cents) {
  return '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0);
}

const PROGRAM_COPY =
  `Refer someone who becomes a paid TransitNow dispatch client and stays active ` +
  `${PROGRAM.milestoneDays} days: you earn ${fmtDollars(PROGRAM.referrerBonusCents)} and they earn ` +
  `${fmtDollars(PROGRAM.referredBonusCents)}. Bonuses are paid out by TransitNow operations ` +
  `after the milestone is met — track progress on this page. No guaranteed routes, ` +
  `loads, work, or income; the dispatch subscription itself is separate.`;

// Kept for backward compatibility with older views; the program is now paid.
const NO_PAYMENT_COPY = PROGRAM_COPY;

const ATTRIBUTION_STATUSES = ['applied', 'contacted', 'qualified', 'active', 'closed'];
const ISSUED_TO_TYPES = ['driver', 'lead'];

function str(v, max = 2000) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function makeCode() {
  // Human-friendly, collision-checked: TN-XXXXXX (no ambiguous chars).
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return `TN-${code}`;
}

/** Issue a referral code to an approved driver or lead. Admin only. */
async function issueCode({ issuedToType = 'driver', issuedToId = null, issuedToName = '', issuedBy = 'admin', notes = '' }) {
  if (!ISSUED_TO_TYPES.includes(issuedToType)) throw new Error('issued_to_type must be driver or lead');
  const now = Date.now();
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = makeCode();
    try {
      const info = await db.run(
        `INSERT INTO referral_codes
           (code, issued_to_type, issued_to_id, issued_to_name, issued_by, issued_at, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
        [code, issuedToType, issuedToId, str(issuedToName, 200), str(issuedBy, 120), now, str(notes, 2000)]
      );
      return db.get('SELECT * FROM referral_codes WHERE id = ?', [info.lastInsertRowid]);
    } catch (err) {
      // Code collision (unique index) — retry with a fresh code.
      if (err && /UNIQUE/i.test(err.message)) continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique referral code — please try again.');
}

async function getCode(code) {
  return db.get('SELECT * FROM referral_codes WHERE code = ?', [String(code || '').trim().toUpperCase()]);
}

async function getActiveCodeForUser(issuedToType, issuedToId) {
  return db.get(
    `SELECT * FROM referral_codes
     WHERE issued_to_type = ? AND issued_to_id = ? AND status = 'active'
     ORDER BY issued_at DESC, id DESC LIMIT 1`,
    [issuedToType, issuedToId]
  );
}

async function listCodes() {
  return db.all('SELECT * FROM referral_codes ORDER BY issued_at DESC, id DESC');
}

async function revokeCode(id) {
  await db.run('UPDATE referral_codes SET status = ?, revoked_at = ? WHERE id = ?', ['revoked', Date.now(), id]);
  return db.get('SELECT * FROM referral_codes WHERE id = ?', [id]);
}

/**
 * Attribute grow applications carrying a referral code to the issued code.
 * Scans lead_sources.referral_code (Phase-1 capture) against active codes;
 * idempotent — existing attributions are updated, not duplicated.
 * Returns { created, updated }.
 */
async function runAttribution() {
  const codes = await db.all(`SELECT * FROM referral_codes WHERE status = 'active'`);
  const byCode = new Map(codes.map((c) => [c.code, c]));
  if (!byCode.size) return { created: 0, updated: 0 };
  // lead_sources holds the applicant's referral_code from /grow/apply.
  const rows = await db.all(
    `SELECT l.id AS lead_id, l.first_name, l.last_name, l.email, s.referral_code
     FROM opportunity_leads l
     JOIN lead_sources s ON s.lead_id = l.id
     WHERE s.referral_code IS NOT NULL AND TRIM(s.referral_code) <> ''`
  );
  let created = 0, updated = 0;
  const now = Date.now();
  for (const r of rows) {
    const codeStr = String(r.referral_code).trim().toUpperCase();
    const code = byCode.get(codeStr);
    if (!code) continue;
    const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email || `Lead #${r.lead_id}`;
    const existing = await db.get(
      'SELECT * FROM referral_attributions WHERE code_id = ? AND referred_lead_id = ?',
      [code.id, r.lead_id]
    );
    if (existing) {
      await db.run(
        'UPDATE referral_attributions SET code = ?, referred_name = ?, referred_email = ?, updated_at = ? WHERE id = ?',
        [code.code, name, r.email || '', now, existing.id]
      );
      updated++;
    } else {
      await db.run(
        `INSERT INTO referral_attributions
           (code_id, code, referred_lead_id, referred_name, referred_email, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'applied', ?, ?)`,
        [code.id, code.code, r.lead_id, name, r.email || '', now, now]
      );
      created++;
    }
  }
  return { created, updated };
}

async function listAttributions() {
  return db.all('SELECT * FROM referral_attributions ORDER BY created_at DESC, id DESC');
}

async function getAttribution(id) {
  return db.get('SELECT * FROM referral_attributions WHERE id = ?', [id]);
}

async function updateAttribution(id, { status = '', opportunityId = '', outcome = '' }) {
  const cur = await getAttribution(id);
  if (!cur) throw new Error('Attribution not found');
  const st = ATTRIBUTION_STATUSES.includes(String(status).trim().toLowerCase())
    ? String(status).trim().toLowerCase()
    : cur.status;
  const oppId = opportunityId === '' || opportunityId == null ? cur.opportunity_id : Number.parseInt(opportunityId, 10);
  await db.run(
    'UPDATE referral_attributions SET status = ?, opportunity_id = ?, outcome = ?, updated_at = ? WHERE id = ?',
    [st, Number.isFinite(oppId) ? oppId : null, str(outcome, 2000), Date.now(), id]
  );
  return getAttribution(id);
}

/** Ensure the driver has an active referral code (auto-issue at signup). */
async function ensureCodeForDriver(driver) {
  if (!driver || !driver.id) return null;
  const existing = await getActiveCodeForUser('driver', driver.id);
  if (existing) return existing;
  const name = driver.full_name || driver.email || `Driver #${driver.id}`;
  return issueCode({ issuedToType: 'driver', issuedToId: driver.id, issuedToName: name, issuedBy: 'system-signup' });
}

/** Latest non-test dispatch subscription for an email, or null. */
async function subscriptionForEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const rows = await db.all(
    `SELECT * FROM dispatch_subscriptions WHERE LOWER(email) = ? AND is_test = 0 ORDER BY updated_at DESC LIMIT 1`,
    [e]
  );
  return rows[0] || null;
}

async function setPayoutStatus(id, status, extra = {}) {
  const sets = ['status = ?', 'updated_at = ?'];
  const vals = [status, Date.now()];
  if (extra.earned_at) { sets.push('earned_at = ?'); vals.push(extra.earned_at); }
  if (extra.paid_at) { sets.push('paid_at = ?'); vals.push(extra.paid_at); }
  if (extra.paid_note !== undefined) { sets.push('paid_note = ?'); vals.push(extra.paid_note); }
  vals.push(id);
  await db.run(`UPDATE referral_payouts SET ${sets.join(', ')} WHERE id = ?`, vals);
}

/**
 * Milestone pass. For every open attribution:
 * - referred driver has an ACTIVE, non-test dispatch subscription ->
 *   ensure pending payout rows (both sides); when the subscription has been
 *   continuously active PROGRAM.milestoneDays, flip pending -> earned.
 * - otherwise -> void any pending rows (one shot per referral: a lapse
 *   before the milestone ends that referral's bonus).
 * Idempotent; safe to run on every scheduler pass.
 */
async function checkMilestones(now = Date.now()) {
  const attrs = await db.all(
    `SELECT a.*, c.issued_to_type, c.issued_to_id, c.issued_to_name
     FROM referral_attributions a
     LEFT JOIN referral_codes c ON c.id = a.code_id
     WHERE a.status != 'closed'`
  );
  let created = 0, earned = 0, voided = 0;
  for (const a of attrs) {
    const sub = await subscriptionForEmail(a.referred_email);
    const activeSub = sub && sub.status === 'active' ? sub : null;
    const rows = await db.all('SELECT * FROM referral_payouts WHERE attribution_id = ?', [a.id]);
    if (!activeSub) {
      for (const r of rows) {
        if (r.status === 'pending') { await setPayoutStatus(r.id, 'void'); voided++; }
      }
      continue;
    }
    for (const side of ['referrer', 'referred']) {
      let row = rows.find((r) => r.side === side);
      if (!row) {
        const amount = side === 'referrer' ? PROGRAM.referrerBonusCents : PROGRAM.referredBonusCents;
        const info = await db.run(
          `INSERT INTO referral_payouts
             (attribution_id, side, code, referrer_type, referrer_id, referrer_name,
              referred_lead_id, referred_name, referred_email, amount_cents, milestone,
              status, active_since, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [a.id, side, a.code || null, a.issued_to_type || null, a.issued_to_id || null,
           a.issued_to_name || null, a.referred_lead_id || null, a.referred_name || null,
           (a.referred_email || '').toLowerCase() || null, amount, PROGRAM.milestone,
           sub.created_at || now, now, now]
        );
        row = await db.get('SELECT * FROM referral_payouts WHERE id = ?', [info.lastInsertRowid]);
        created++;
        rows.push(row);
      }
      if (row.status === 'pending' && row.active_since &&
          now - Number(row.active_since) >= PROGRAM.milestoneDays * 86400000) {
        await setPayoutStatus(row.id, 'earned', { earned_at: now });
        earned++;
      }
    }
  }
  return { created, earned, voided, checked: attrs.length };
}

/** All payout rows, newest first, optional status filter. */
async function listPayouts(status = '') {
  if (status) return db.all('SELECT * FROM referral_payouts WHERE status = ? ORDER BY created_at DESC, id DESC', [status]);
  return db.all('SELECT * FROM referral_payouts ORDER BY created_at DESC, id DESC');
}

/** Totals for the admin ledger: { earnedCents, paidCents, pendingCents }. */
async function payoutTotals() {
  const rows = await db.all(`SELECT status, SUM(amount_cents) AS cents FROM referral_payouts WHERE status != 'void' GROUP BY status`);
  const t = { earnedCents: 0, paidCents: 0, pendingCents: 0 };
  for (const r of rows) {
    if (r.status === 'earned') t.earnedCents += Number(r.cents) || 0;
    else if (r.status === 'paid') t.paidCents += Number(r.cents) || 0;
    else if (r.status === 'pending') t.pendingCents += Number(r.cents) || 0;
  }
  return t;
}

/** Mark an earned payout as paid (admin, after paying out by hand). */
async function markPaid(id, note = '') {
  const row = await db.get('SELECT * FROM referral_payouts WHERE id = ?', [id]);
  if (!row) throw new Error('Payout not found');
  if (row.status !== 'earned') throw new Error(`Only earned payouts can be marked paid (status: ${row.status})`);
  await setPayoutStatus(id, 'paid', { paid_at: Date.now(), paid_note: str(note, 500) });
  return db.get('SELECT * FROM referral_payouts WHERE id = ?', [id]);
}

/**
 * Driver-tab data: the driver's code, each referral with live milestone
 * progress, and the driver's own earnings.
 */
async function referrerProgress(driverId) {
  const code = await getActiveCodeForUser('driver', driverId);
  const attrs = code
    ? await db.all('SELECT * FROM referral_attributions WHERE code_id = ? ORDER BY created_at DESC, id DESC', [code.id])
    : [];
  const referrals = [];
  for (const a of attrs) {
    const sub = await subscriptionForEmail(a.referred_email);
    const payouts = await db.all('SELECT * FROM referral_payouts WHERE attribution_id = ?', [a.id]);
    const activeSub = sub && sub.status === 'active' ? sub : null;
    const myPayout = payouts.find((p) => p.side === 'referrer');
    let daysActive = 0;
    if (activeSub && myPayout && myPayout.active_since) {
      daysActive = Math.min(PROGRAM.milestoneDays, Math.floor((Date.now() - Number(myPayout.active_since)) / 86400000));
    }
    referrals.push({
      attribution: a,
      referredName: a.referred_name || a.referred_email || '—',
      status: a.status,
      hasActiveSub: !!activeSub,
      plan: activeSub ? activeSub.plan : sub ? sub.plan : null,
      subStatus: sub ? sub.status : null,
      daysActive,
      milestoneDays: PROGRAM.milestoneDays,
      payoutStatus: myPayout ? myPayout.status : (activeSub ? 'pending' : 'none'),
      amountCents: PROGRAM.referrerBonusCents,
    });
  }
  const mine = await db.all(
    `SELECT * FROM referral_payouts WHERE side = 'referrer' AND referrer_type = 'driver' AND referrer_id = ? AND status != 'void'`,
    [driverId]
  );
  const earnings = { pendingCents: 0, earnedCents: 0, paidCents: 0 };
  for (const p of mine) {
    if (p.status === 'pending') earnings.pendingCents += p.amount_cents;
    else if (p.status === 'earned') earnings.earnedCents += p.amount_cents;
    else if (p.status === 'paid') earnings.paidCents += p.amount_cents;
  }
  return { code, referrals, earnings };
}

module.exports = {
  PROGRAM,
  PROGRAM_COPY,
  NO_PAYMENT_COPY,
  ATTRIBUTION_STATUSES,
  ISSUED_TO_TYPES,
  issueCode,
  getCode,
  getActiveCodeForUser,
  listCodes,
  revokeCode,
  runAttribution,
  listAttributions,
  getAttribution,
  updateAttribution,
  ensureCodeForDriver,
  checkMilestones,
  listPayouts,
  payoutTotals,
  markPaid,
  referrerProgress,
  subscriptionForEmail,
  fmtDollars,
};
