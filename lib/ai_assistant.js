'use strict';
/**
 * lib/ai_assistant.js — Private operations assistant (Complete tier).
 *
 * The $100/month Complete tier bundles a private AI operations assistant
 * (Davena's "secret AI we will not name"). Public copy NEVER names the AI
 * or any vendor/model — user-facing strings say only "your private
 * operations assistant" / "private AI operations assistant".
 *
 * The app NEVER generates an answer itself. New questions are stored as
 * 'pending'; answers are written through the operator workflow (admin queue)
 * and the driver is notified by email (and queued text) when one arrives.
 * No canned AI text, no fabricated answers — a pending question simply waits.
 *
 * Access rule: only drivers whose Stripe-synced dispatch subscription is
 * ACTIVE and on the 'complete' plan may ask or see the panel.
 */
const db = require('./db');
const subscriptions = require('./subscriptions');

function cleanText(v) {
  return String(v || '').trim();
}

/** True when the driver's dispatch subscription is ACTIVE on the Complete plan. */
async function isCompleteActive(driver) {
  if (!driver || !driver.email) return false;
  const sub = await subscriptions.getByEmail(driver.email);
  return !!(sub && sub.status === 'active' && sub.plan === 'complete');
}

/** Store a question as pending. Never answers — returns the new row. */
async function askQuestion(driverId, question) {
  const q = cleanText(question);
  if (!q) throw new Error('Enter your question first.');
  if (q.length > 2000) throw new Error('Keep your question under 2000 characters.');
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO ai_questions (driver_id, question, status, created_at)
     VALUES (?, ?, 'pending', ?)`,
    [Number(driverId), q, now]
  );
  return getQuestion(info.lastInsertRowid);
}

async function getQuestion(id) {
  return db.get('SELECT * FROM ai_questions WHERE id = ?', [Number(id)]);
}

async function listForDriver(driverId, limit = 20) {
  return db.all(
    `SELECT * FROM ai_questions WHERE driver_id = ? ORDER BY created_at DESC LIMIT ?`,
    [Number(driverId), Number(limit)]
  );
}

/** Pending questions for the operator/admin queue, with driver name + tier. */
async function listPending(limit = 100) {
  return db.all(
    `SELECT q.*, d.full_name AS driver_name, d.email AS driver_email
       FROM ai_questions q
       LEFT JOIN drivers d ON d.id = q.driver_id
      WHERE q.status = 'pending'
      ORDER BY q.created_at ASC LIMIT ?`,
    [Number(limit)]
  );
}

async function countPending() {
  const row = await db.get(`SELECT COUNT(*) n FROM ai_questions WHERE status = 'pending'`);
  return row ? row.n : 0;
}

/**
 * Record an answer from the operator workflow and notify the driver.
 * Queues an email via the existing outbox; queues a text via the same
 * queue table (provider-pending until a real SMS provider is configured).
 */
async function answerQuestion(questionId, answer, { by = 'operator' } = {}) {
  const a = cleanText(answer);
  if (!a) throw new Error('Enter the answer first.');
  const q = await getQuestion(questionId);
  if (!q) throw new Error('Question not found.');
  const now = Date.now();
  await db.run(
    `UPDATE ai_questions SET answer = ?, status = 'answered', answered_at = ? WHERE id = ?`,
    [a, now, q.id]
  );
  const driver = await db.get('SELECT id, full_name, email, phone FROM drivers WHERE id = ?', [q.driver_id]);
  if (!driver || !driver.email) {
    console.log('[ai_assistant] answered but driver has no email — notification skipped', { questionId: q.id });
    return getQuestion(q.id);
  }
  const email = cleanText(driver.email).toLowerCase();
  const subject = 'Your private operations assistant replied';
  const body = [
    `<p>Hi ${esc(driver.full_name)},</p>`,
    `<p>Your private operations assistant replied to your question:</p>`,
    `<blockquote><em>“${esc(q.question)}”</em></blockquote>`,
    `<p><strong>Answer:</strong></p>`,
    `<blockquote>${esc(a)}</blockquote>`,
    `<p>Ask more any time from your driver dashboard — your private operations assistant is part of your Complete dispatch plan.</p>`,
    `<p style="color:#888;font-size:12px">TransitNow Logistics Services. No guaranteed loads, routes, revenue, or earnings.</p>`,
  ].join('\n');
  await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, 'assistant-answer', ?, ?, ?, NULL, ?, 'queued')`,
    [email, `question:${q.id}`, subject, body, now]
  );
  const phone = String(driver.phone || '').replace(/\D/g, '');
  if (phone) {
    await db.run(
      `INSERT INTO email_queue
         (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
       VALUES (NULL, ?, 'assistant-answer-sms', ?, 'TransitNow assistant reply', ?, NULL, ?, 'queued')`,
      [email, `question:${q.id}`, 'Your private operations assistant replied — check your driver dashboard for the answer.', now]
    );
  }
  console.log('[ai_assistant] answered', { questionId: q.id, driver: email, by });
  return getQuestion(q.id);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  isCompleteActive,
  askQuestion,
  getQuestion,
  listForDriver,
  listPending,
  countPending,
  answerQuestion,
};
