// lib/followups.js — Phase 6: follow-up system (spec section 32).
//
// Every lead shows: last contact, next follow-up, assigned staff member,
// notes, contact attempts, outcome. Admin can create reminders.
//
// Follow-up statuses — EXACTLY these (validated on write):
//   CONTACT TODAY, FOLLOW UP, WAITING ON DOCUMENTS, WAITING ON RESPONSE,
//   OPPORTUNITY PENDING, NURTURE, CLOSED
//
// Entries are append-only history; the lead profile reads the LATEST entry
// for "last contact / next follow-up / assigned".
'use strict';

const db = require('./db');

const FOLLOWUP_STATUSES = [
  'CONTACT TODAY',
  'FOLLOW UP',
  'WAITING ON DOCUMENTS',
  'WAITING ON RESPONSE',
  'OPPORTUNITY PENDING',
  'NURTURE',
  'CLOSED',
];

function str(v, max = 2000) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

// YYYY-MM-DD -> epoch ms at start of day (local). Returns null when invalid.
function dateToMs(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

async function createFollowup(leadId, {
  status = 'FOLLOW UP',
  lastContactAt = null,
  nextFollowUpAt = null,
  assignedTo = '',
  note = '',
  outcome = '',
  contactAttempt = false,
  reminder = false,
  createdBy = 'admin',
} = {}) {
  const st = FOLLOWUP_STATUSES.includes(String(status).trim())
    ? String(status).trim()
    : 'FOLLOW UP';
  const lid = Number(leadId);
  if (!Number.isFinite(lid) || lid <= 0) throw new Error('Invalid lead');
  const lead = await db.get('SELECT id FROM opportunity_leads WHERE id = ?', [lid]);
  if (!lead) throw new Error('Lead not found');
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO lead_followups
       (lead_id, followup_status, last_contact_at, next_follow_up_at, assigned_to,
        note, outcome, contact_attempt, reminder, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      lid, st,
      lastContactAt == null ? null : Number(lastContactAt),
      nextFollowUpAt == null ? null : Number(nextFollowUpAt),
      str(assignedTo, 120), str(note, 4000), str(outcome, 2000),
      contactAttempt ? 1 : 0, reminder ? 1 : 0,
      str(createdBy, 120), now,
    ]
  );
  return db.get('SELECT * FROM lead_followups WHERE id = ?', [info.lastInsertRowid]);
}

async function listFollowups(leadId) {
  return db.all(
    'SELECT * FROM lead_followups WHERE lead_id = ? ORDER BY created_at DESC, id DESC',
    [leadId]
  );
}

async function latestFollowup(leadId) {
  return db.get(
    'SELECT * FROM lead_followups WHERE lead_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [leadId]
  );
}

/** Count of logged contact attempts for a lead. */
async function countAttempts(leadId) {
  const row = await db.get(
    'SELECT COUNT(*) c FROM lead_followups WHERE lead_id = ? AND contact_attempt = 1',
    [leadId]
  );
  return Number(row && row.c) || 0;
}

/**
 * Overdue reminders: latest follow-up per lead whose next_follow_up_at is in
 * the past (or due today) and whose latest status is not CLOSED. Join returns
 * lead name/type for the admin view.
 */
async function dueReminders(now = Date.now()) {
  return db.all(
    `SELECT f.*, l.first_name, l.last_name, l.email, l.lead_type, l.status AS lead_status
     FROM lead_followups f
     JOIN opportunity_leads l ON l.id = f.lead_id
     WHERE f.id IN (SELECT MAX(id) FROM lead_followups GROUP BY lead_id)
       AND f.followup_status <> 'CLOSED'
       AND f.next_follow_up_at IS NOT NULL
       AND f.next_follow_up_at <= ?
     ORDER BY f.next_follow_up_at ASC`,
    [now]
  );
}

module.exports = {
  FOLLOWUP_STATUSES,
  dateToMs,
  createFollowup,
  listFollowups,
  latestFollowup,
  countAttempts,
  dueReminders,
};
