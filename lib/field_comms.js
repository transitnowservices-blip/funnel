'use strict';
/**
 * lib/field_comms.js — dispatch <-> driver field communications.
 *
 * Two directions:
 *
 *  1. Driver -> dispatch (URGENT): REUSES the existing support ticket system
 *     (lib/drivers.js createTicket, support_tickets table). An urgent-priority
 *     ticket already emails operations immediately. What was missing was a
 *     can't-miss siren in the admin dashboard — provided here as
 *     unackedUrgentTickets() + ackUrgentTicket(). Acknowledging moves the
 *     ticket from 'open' to 'in_progress' via the existing setTicketStatus;
 *     the siren shows only while an urgent ticket is still 'open'. No new
 *     tables are created for this by design (no duplicate SOS system).
 *
 *  2. Dispatch -> driver (the missing direction): "Broadcast to field" and
 *     per-driver "Message driver". Backed by two new tables:
 *       driver_messages (driver inbox rows: broadcasts + direct messages)
 *       broadcast_log   (admin-visible send log)
 *     Delivery rides the existing email_queue pipeline for email and the SMS
 *     stub for texts (provider-pending until Davena configures a real SMS
 *     provider — queued texts are NEVER claimed as delivered).
 *
 * Audience rule: broadcasts and direct messages go ONLY to drivers whose
 * Stripe-synced dispatch subscription is ACTIVE (Basic or Complete, per the
 * selected audience). Canceled / past-due / unpaid drivers never receive
 * anything.
 *
 * No-guarantee rule: nothing here promises work, loads, routes, contracts,
 * income, or earnings.
 */
const db = require('./db');
const subscriptions = require('./subscriptions');
const drivers = require('./drivers');

const AUDIENCES = ['all', 'complete', 'basic'];
const AUDIENCE_LABEL = { all: 'All active subscribers', complete: 'Complete only', basic: 'Basic only' };

// --- Live-contact dispatch number ------------------------------------------------
// Davena's chosen live-contact number (a public business number she chose to
// publish). SINGLE SOURCE OF TRUTH — driver dashboard buttons, Room
// accountability-line buttons, and tests all read from here; never hardcode
// the digits anywhere else. Env override (DISPATCH_PHONE) for flexibility.
// This is 100% real phone behavior (tel:/sms: links) — never described as
// in-app chat or given fake "live" status language.
const DISPATCH_PHONE_DIGITS = String(process.env.DISPATCH_PHONE || '4143680711').replace(/\D/g, '');
function dispatchTelHref() {
  return `tel:+1${DISPATCH_PHONE_DIGITS}`;
}
function dispatchSmsHref() {
  return `sms:+1${DISPATCH_PHONE_DIGITS}`;
}
function dispatchPhoneDisplay() {
  const d = DISPATCH_PHONE_DIGITS;
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d;
}

function cleanText(v) {
  return String(v || '').trim();
}

function audienceLabel(a) {
  return AUDIENCE_LABEL[a] || a;
}

/**
 * Drivers eligible for field communications: Stripe-synced ACTIVE dispatch
 * subscription, optionally filtered by plan. Returns driver rows.
 */
async function activeFieldDrivers(audience = 'all') {
  if (!AUDIENCES.includes(audience)) throw new Error('Choose a valid audience.');
  const planFilter = audience === 'all' ? '' : 'AND s.plan = ?';
  const params = audience === 'all' ? [] : [audience];
  // dispatch_subscriptions.email is stored lowercased (subscriptions.cleanEmail).
  return db.all(
    `SELECT d.* FROM drivers d
      JOIN dispatch_subscriptions s ON LOWER(d.email) = s.email
     WHERE s.status = 'active' ${planFilter}
     GROUP BY d.id
     ORDER BY d.full_name ASC`,
    params
  );
}

/** Queue one row through the existing email pipeline (scheduler delivers). */
async function queueFieldEmail({ to, subject, html, sequence, step }) {
  const email = cleanText(to).toLowerCase();
  if (!email) return null;
  const info = await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, ?, ?, ?, ?, NULL, ?, 'queued')`,
    [email, sequence, step, subject, html, Date.now()]
  );
  return info.lastInsertRowid;
}

/** Queue the SMS twin: same queue table, '-sms' sequence. The automation
 *  processor routes it to lib/sms.js, which marks it provider-pending
 *  (provider-stub) until a real SMS provider is configured — never claimed
 *  as delivered. */
async function queueFieldSms({ toEmail, body, sequence, step }) {
  const email = cleanText(toEmail).toLowerCase();
  if (!email) return null;
  const info = await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, ?, ?, 'TransitNow dispatch message', ?, NULL, ?, 'queued')`,
    [email, sequence, step, body, Date.now()]
  );
  return info.lastInsertRowid;
}

function dispatchMessageHtml(driver, subject, body) {
  const esc = drivers.esc || ((s) => String(s == null ? '' : s));
  return [
    `<p>Hi ${esc(driver.full_name)},</p>`,
    `<p><strong>${esc(subject)}</strong></p>`,
    `<p>${esc(body).replace(/\n/g, '<br>')}</p>`,
    `<p>— TransitNow Dispatch</p>`,
    `<p style="color:#888;font-size:12px">TransitNow Logistics Services. No guaranteed loads, routes, revenue, or earnings.</p>`,
  ].join('\n');
}

function smsBody(subject, body) {
  const text = `TransitNow Dispatch: ${cleanText(subject)} — ${cleanText(body)}`;
  return text.length > 300 ? text.slice(0, 297) + '…' : text;
}

/**
 * Broadcast one message to the selected audience. Queues one email per
 * driver (+ one provider-pending SMS twin each), stores one inbox row per
 * driver, and writes the admin-visible broadcast log. Never touches
 * canceled / past-due / unpaid drivers.
 */
async function sendBroadcast({ audience = 'all', subject, message }) {
  const aud = String(audience || 'all').toLowerCase();
  if (!AUDIENCES.includes(aud)) throw new Error('Choose a valid audience: all, complete, or basic.');
  const subj = cleanText(subject);
  const msg = cleanText(message);
  if (!subj) throw new Error('Give the broadcast a subject.');
  if (!msg) throw new Error('Write the broadcast message first.');
  if (msg.length > 2000) throw new Error('Keep the broadcast under 2000 characters.');
  const list = await activeFieldDrivers(aud);
  const now = Date.now();
  let emailed = 0;
  for (const driver of list) {
    const email = cleanText(driver.email).toLowerCase();
    if (!email) continue;
    await db.run(
      `INSERT INTO driver_messages (driver_id, kind, subject, body, audience, created_at)
       VALUES (?, 'broadcast', ?, ?, ?, ?)`,
      [Number(driver.id), subj, msg, aud, now]
    );
    await queueFieldEmail({
      to: email,
      subject: `TransitNow dispatch: ${subj}`,
      html: dispatchMessageHtml(driver, subj, msg),
      sequence: 'field-broadcast',
      step: `audience:${aud}`,
    });
    emailed += 1;
    const phone = String(driver.phone || '').replace(/\D/g, '');
    if (phone) {
      await queueFieldSms({
        toEmail: email,
        body: smsBody(subj, msg),
        sequence: 'field-broadcast-sms',
        step: `audience:${aud}`,
      });
    }
  }
  await db.run(
    `INSERT INTO broadcast_log (audience, subject, message, driver_count, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [aud, subj, msg, emailed, now]
  );
  console.log('[field_comms] broadcast', { audience: aud, drivers: emailed });
  return { audience: aud, driverCount: emailed };
}

/**
 * Admin -> one driver: queues email + provider-pending SMS, stores the inbox
 * row. Only for drivers with an ACTIVE dispatch subscription.
 */
async function messageDriver(driverId, subject, message) {
  const driver = await drivers.getDriverById(Number(driverId));
  if (!driver) throw new Error('Driver not found.');
  const active = await subscriptions.isPaidActive(driver.email);
  if (!active) throw new Error('That driver does not have an active dispatch subscription — messages go to active subscribers only.');
  const subj = cleanText(subject);
  const msg = cleanText(message);
  if (!subj) throw new Error('Give the message a subject.');
  if (!msg) throw new Error('Write the message first.');
  if (msg.length > 2000) throw new Error('Keep the message under 2000 characters.');
  const now = Date.now();
  const email = cleanText(driver.email).toLowerCase();
  await db.run(
    `INSERT INTO driver_messages (driver_id, kind, subject, body, audience, created_at)
     VALUES (?, 'direct', ?, ?, NULL, ?)`,
    [Number(driver.id), subj, msg, now]
  );
  await queueFieldEmail({
    to: email,
    subject: `TransitNow dispatch: ${subj}`,
    html: dispatchMessageHtml(driver, subj, msg),
    sequence: 'field-message',
    step: `driver:${driver.id}`,
  });
  const phone = String(driver.phone || '').replace(/\D/g, '');
  if (phone) {
    await queueFieldSms({
      toEmail: email,
      body: smsBody(subj, msg),
      sequence: 'field-message-sms',
      step: `driver:${driver.id}`,
    });
  }
  console.log('[field_comms] direct message', { driverId: driver.id });
  return { driverId: driver.id };
}

/** Driver inbox: broadcasts + direct messages, newest first. */
async function driverInbox(driverId, limit = 20) {
  return db.all(
    `SELECT * FROM driver_messages WHERE driver_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [Number(driverId), Number(limit)]
  );
}

/** Mark all unread inbox rows as read (called after the inbox renders). */
async function markInboxRead(driverId) {
  const now = Date.now();
  const info = await db.run(
    `UPDATE driver_messages SET read_at = ? WHERE driver_id = ? AND read_at IS NULL`,
    [now, Number(driverId)]
  );
  return info.changes || 0;
}

async function unreadCount(driverId) {
  const row = await db.get(
    `SELECT COUNT(*) n FROM driver_messages WHERE driver_id = ? AND read_at IS NULL`,
    [Number(driverId)]
  );
  return row ? Number(row.n) : 0;
}

/** Admin-visible broadcast log, newest first. */
async function recentBroadcasts(limit = 20) {
  return db.all(`SELECT * FROM broadcast_log ORDER BY created_at DESC, id DESC LIMIT ?`, [Number(limit)]);
}

/**
 * Unacknowledged urgent field tickets: priority='urgent' AND status='open'.
 * Acknowledging = admin moves the ticket off 'open' (ackUrgentTicket sets
 * 'in_progress') via the existing ticket status path.
 */
async function unackedUrgentTickets(limit = 50) {
  return db.all(
    `SELECT t.*, d.full_name AS driver_name, d.email AS driver_email
       FROM support_tickets t
       LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE t.priority = 'urgent' AND t.status = 'open'
      ORDER BY t.created_at ASC LIMIT ?`,
    [Number(limit)]
  );
}

async function ackUrgentTicket(ticketId) {
  const t = await drivers.getTicket(ticketId);
  if (!t) throw new Error('Ticket not found.');
  if (t.priority !== 'urgent') throw new Error('Only urgent tickets need siren acknowledgment.');
  return drivers.setTicketStatus(ticketId, 'in_progress');
}

module.exports = {
  AUDIENCES,
  audienceLabel,
  DISPATCH_PHONE_DIGITS,
  dispatchTelHref,
  dispatchSmsHref,
  dispatchPhoneDisplay,
  activeFieldDrivers,
  sendBroadcast,
  messageDriver,
  driverInbox,
  markInboxRead,
  unreadCount,
  recentBroadcasts,
  unackedUrgentTickets,
  ackUrgentTicket,
};
