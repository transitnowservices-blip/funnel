'use strict';
/**
 * lib/email.js — email provider interface with two implementations.
 *
 *   EMAIL_PROVIDER=local   (default) — writes each sent email to
 *                        data/outbox/<queueId>-<Date.now()>.html with an HTML
 *                        comment header (To / Subject / Date / Queue-ID), then
 *                        marks the queue row sent. No real email is delivered.
 *   EMAIL_PROVIDER=resend — STUB. Active only when RESEND_API_KEY is also set.
 *                        It logs the send and marks the queue row
 *                        status='provider-stub'. It does NOT deliver email.
 *
 * SEAM for production: replace the resend branch below with a real call to
 * the Resend API (or any SMTP client). The function contract stays the same:
 *   sendEmail({ to, subject, html, queueId }) -> { ok, provider, ... }
 * and on success the email_queue row for queueId must be marked sent
 * (status='sent', sent_at=<epoch ms>).
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const OUTBOX_DIR = db.OUTBOX_DIR;
const PROVIDER = (process.env.EMAIL_PROVIDER || 'local').toLowerCase();

async function markSent(queueId, status) {
  await db.run('UPDATE email_queue SET status = ?, sent_at = ? WHERE id = ?', [status, Date.now(), queueId]);
}

async function sendLocal({ to, subject, html, queueId }) {
  const filename = `${queueId}-${Date.now()}.html`;
  const header =
    `<!-- To: ${to}\n` +
    `     Subject: ${subject}\n` +
    `     Date: ${new Date().toISOString()}\n` +
    `     Queue-ID: ${queueId}\n` +
    `     Provider: local (no real delivery) -->\n`;
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTBOX_DIR, filename), header + (html || ''), 'utf8');
  await markSent(queueId, 'sent');
  return { ok: true, provider: 'local', file: filename };
}

async function sendResendStub({ to, subject, html, queueId }) {
  // ---- PRODUCTION SEAM -----------------------------------------------------
  // Plug the real Resend (or SMTP) send call here, e.g.:
  //   const { Resend } = require('resend');
  //   const resend = new Resend(process.env.RESEND_API_KEY);
  //   await resend.emails.send({ from: `${fromName} <${fromEmail}>`, to, subject, html });
  // On success call markSent(queueId, 'sent'); on failure leave the row queued
  // (or record the error) so a later pass can retry.
  // --------------------------------------------------------------------------
  console.warn(
    `[email] RESEND STUB — email NOT actually delivered. ` +
      `Wire up the Resend API at the seam in lib/email.js. ` +
      `To: ${to} | Subject: ${subject} | queueId: ${queueId}`
  );
  await markSent(queueId, 'provider-stub');
  return { ok: true, provider: 'provider-stub', note: 'stub — not delivered' };
}

/**
 * Send one queued email. Returns { ok, provider, ... }.
 * Never throws for provider failures — the queue row keeps its status so the
 * scheduler can retry on a later pass (local provider only throws on disk
 * errors, which are genuinely fatal).
 */
async function sendEmail({ to, subject, html, queueId }) {
  if (PROVIDER === 'resend') {
    if (process.env.RESEND_API_KEY) return sendResendStub({ to, subject, html, queueId });
    console.warn('[email] EMAIL_PROVIDER=resend but RESEND_API_KEY is not set — falling back to local outbox.');
  }
  return sendLocal({ to, subject, html, queueId });
}

module.exports = { sendEmail, PROVIDER };
