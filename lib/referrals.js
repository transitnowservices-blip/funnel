// lib/referrals.js — Phase 6: driver referral system (spec section 31).
//
// Approved users (drivers / leads) can be issued a referral code by admin.
// Applications carrying that code (lead_sources.referral_code, collected by
// the Phase-1 grow funnel) are attributed to the code: referral source,
// referred person, application (linked opportunity_leads row), status,
// opportunity, outcome.
//
// Honest labeling: NO referral payment program exists. Nothing here promises,
// computes, or implies referral payments. The UI copy states this plainly;
// see NO_PAYMENT_COPY below.
'use strict';

const crypto = require('crypto');
const db = require('./db');

const NO_PAYMENT_COPY =
  'No referral payment program is currently configured. Referral codes track where ' +
  'applicants heard about TransitNow — sharing or using a code does not promise, ' +
  'guarantee, or imply any payment, bonus, or compensation.';

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

module.exports = {
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
};
