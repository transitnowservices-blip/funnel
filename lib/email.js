'use strict';
/**
 * lib/email.js — email provider interface with two implementations.
 *
 *   EMAIL_PROVIDER=local   (default) — writes each sent email to
 *                        data/outbox/<queueId>-<Date.now()>.html with an HTML
 *                        comment header (To / Subject / Date / Queue-ID), then
 *                        marks the queue row sent. No real email is delivered.
 *   EMAIL_PROVIDER=resend — real delivery through the Resend API. Active
 *                        only when RESEND_API_KEY is also set. On success the
 *                        queue row is marked status='sent'. On API failure the
 *                        error is thrown (sendEmail records an email_failed
 *                        event and rethrows); the row keeps its queued status
 *                        so a later scheduler pass retries it.
 *   EMAIL_PROVIDER=gmail  — real delivery through Gmail's SMTP servers
 *                        (smtp.gmail.com:587) using a Google App Password.
 *                        Active only when GMAIL_APP_PASSWORD is also set
 *                        (GMAIL_USER defaults to the Room sender address).
 *                        The From address is the Gmail account's own address,
 *                        so no domain verification is needed. On success the
 *                        queue row is marked sent; on SMTP failure the error
 *                        is thrown and the row stays queued for retry.
 *
 * The function contract stays the same:
 *   sendEmail({ to, subject, html, queueId }) -> { ok, provider, ... }
 * and on success the email_queue row for queueId must be marked sent
 * (status='sent', sent_at=<epoch ms>).
 *
 * The provider-agnostic wrapper (sendEmail) also records one row in the
 * events table per send attempt via db.recordEvent: `email_sent` on success
 * (meta: queue_id, provider, fromName, fromEmail) and `email_failed` on
 * failure (meta: queue_id, error). Event logging is best-effort — it never
 * breaks or retries the send itself, and it leaves the email_queue
 * status updates untouched.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const OUTBOX_DIR = db.OUTBOX_DIR;
const PROVIDER = (process.env.EMAIL_PROVIDER || 'local').toLowerCase();

async function markSent(queueId, status) {
  await db.run('UPDATE email_queue SET status = ?, sent_at = ? WHERE id = ?', [status, Date.now(), queueId]);
}

async function sendLocal({ to, subject, html, queueId, fromName, fromEmail }) {
  const filename = `${queueId}-${Date.now()}.html`;
  const fromLine = fromName || fromEmail ? `From: ${fromName || ''}${fromName && fromEmail ? ' ' : ''}${fromEmail ? `<${fromEmail}>` : ''}\n` : '';
  const header =
    `<!-- To: ${to}\n` +
    fromLine +
    `     Subject: ${subject}\n` +
    `     Date: ${new Date().toISOString()}\n` +
    `     Queue-ID: ${queueId}\n` +
    `     Provider: local (no real delivery) -->\n`;
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTBOX_DIR, filename), header + (html || ''), 'utf8');
  await markSent(queueId, 'sent');
  return { ok: true, provider: 'local', file: filename };
}

/**
 * Real Resend delivery: POST https://api.resend.com/emails.
 * The From address must be verified in the Resend dashboard (single sender
 * or domain). fromEmail falls back to ROOM_FROM_EMAIL, then to the
 * let's-go-home-foundation address verified for the Wealth Builder's Room.
 * Throws on API failure so the queue row stays queued for a later retry.
 */
async function sendResend({ to, subject, html, queueId, fromName, fromEmail }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[email] EMAIL_PROVIDER=resend but RESEND_API_KEY is not set — falling back to local outbox.');
    return sendLocal({ to, subject, html, queueId, fromName, fromEmail });
  }
  const fromAddr = fromEmail || process.env.ROOM_FROM_EMAIL || 'letsgohomefoundation@gmail.com';
  const from = `${fromName || "Wealth Builder's Room"} <${fromAddr}>`;
  let resp;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: subject || '',
        html: html || '',
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Resend request failed: ${err && err.message ? err.message : err}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Resend API error ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json().catch(() => ({}));
  await markSent(queueId, 'sent');
  return { ok: true, provider: 'resend', id: data && data.id ? data.id : null };
}

/**
 * Real Gmail delivery via SMTP (smtp.gmail.com:587) using a Google App
 * Password. The From address is the Gmail account's own address, so no
 * domain verification is needed. fromEmail falls back to GMAIL_USER, then
 * to the let's-go-home-foundation address used for the Wealth Builder's Room.
 * Throws on SMTP failure so the queue row stays queued for a later retry.
 */
async function sendGmail({ to, subject, html, queueId, fromName, fromEmail }) {
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  if (!appPassword) {
    console.warn('[email] EMAIL_PROVIDER=gmail but GMAIL_APP_PASSWORD is not set — falling back to local outbox.');
    return sendLocal({ to, subject, html, queueId, fromName, fromEmail });
  }
  // Required lazily so the local/resend paths never load the SMTP library.
  const nodemailer = require('nodemailer');
  const user = process.env.GMAIL_USER || fromEmail || 'letsgohomefoundation@gmail.com';
  const fromAddr = fromEmail || user;
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user, pass: appPassword },
  });
  try {
    const info = await transporter.sendMail({
      from: `${fromName || "Wealth Builder's Room"} <${fromAddr}>`,
      to,
      subject: subject || '',
      html: html || '',
    });
    await markSent(queueId, 'sent');
    return { ok: true, provider: 'gmail', id: info && info.messageId ? info.messageId : null };
  } catch (err) {
    throw new Error(`Gmail SMTP error: ${err && err.message ? err.message : err}`);
  }
}

/**
 * Best-effort events-table logging for send attempts. Reads the queue row
 * for lead_id/product_id context; never throws, so logging can never break
 * or retry a send. The email_queue status updates are untouched.
 */
async function recordSendEvent(queueId, type, extraMeta = {}) {
  try {
    const row = queueId
      ? await db.get('SELECT id, lead_id, product_id FROM email_queue WHERE id = ?', [queueId])
      : null;
    await db.recordEvent({
      lead_id: row ? row.lead_id : null,
      type,
      product_id: row ? row.product_id : null,
      meta: { queue_id: queueId == null ? null : queueId, ...extraMeta },
    });
  } catch (err) {
    console.error(`[email] failed to record ${type} event:`, err && err.message ? err.message : err);
  }
}

/**
 * Send one queued email. Returns { ok, provider, ... }.
 * Never throws for provider failures — the queue row keeps its status so the
 * scheduler can retry on a later pass (local provider only throws on disk
 * errors, which are genuinely fatal).
 *
 * Optional fromName/fromEmail (resolved by the caller, e.g. lib/automation
 * sequence branding) are passed through to the provider. On success an
 * `email_sent` event is recorded; if the provider throws, an `email_failed`
 * event is recorded and the error rethrown.
 */
async function sendEmail({ to, subject, html, queueId, fromName, fromEmail }) {
  try {
    let result;
    if (PROVIDER === 'resend') {
      result = await sendResend({ to, subject, html, queueId, fromName, fromEmail });
    } else if (PROVIDER === 'gmail') {
      result = await sendGmail({ to, subject, html, queueId, fromName, fromEmail });
    } else {
      result = await sendLocal({ to, subject, html, queueId, fromName, fromEmail });
    }
    await recordSendEvent(queueId, 'email_sent', {
      provider: result && result.provider,
      fromName: fromName || null,
      fromEmail: fromEmail || null,
    });
    return result;
  } catch (err) {
    await recordSendEvent(queueId, 'email_failed', {
      error: err && err.message ? err.message : String(err),
    });
    throw err;
  }
}

module.exports = { sendEmail, PROVIDER };
