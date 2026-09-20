'use strict';
/**
 * lib/sms.js — SMS provider interface.
 *
 *   SMS_PROVIDER unset (default) — STUB. Marks the queue row
 *                        status='provider-stub'. It NEVER attempts real
 *                        delivery, needs no credentials, and adds no new
 *                        npm dependencies. Real texting stays off until the
 *                        owner configures a provider at the seam below.
 *
 * SEAM for production: add a real provider branch (e.g. Twilio) below, e.g.:
 *   const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
 *   await twilio.messages.create({ to: `+${to}`, from: process.env.SMS_FROM_NUMBER, body });
 * The function contract stays the same:
 *   sendSms({ to, body, queueId }) -> { ok, provider, ... }
 * and on success the queue row for queueId must be marked sent
 * (status='sent', sent_at=<epoch ms>). On failure leave the row queued so a
 * later pass can retry.
 *
 * The provider-agnostic wrapper (sendSms) also records one row in the
 * events table per send attempt via db.recordEvent: `sms_sent` on success
 * (meta: queue_id, provider) and `sms_failed` on failure (meta: queue_id,
 * error). Event logging is best-effort — it never breaks or retries the
 * send itself, and it leaves the queue status updates untouched.
 */
const db = require('./db');

const PROVIDER = (process.env.SMS_PROVIDER || 'stub').toLowerCase();

async function markSmsStatus(queueId, status) {
  await db.run('UPDATE email_queue SET status = ?, sent_at = ? WHERE id = ?', [status, Date.now(), queueId]);
}

async function sendStub({ to, body, queueId }) {
  // ---- PRODUCTION SEAM -----------------------------------------------------
  // Plug the real SMS provider send call here (see module docstring).
  // On success call markSmsStatus(queueId, 'sent'); on failure leave the row
  // queued (or record the error) so a later pass can retry.
  // --------------------------------------------------------------------------
  console.warn(
    `[sms] STUB — SMS NOT actually delivered. ` +
      `Configure a provider at the seam in lib/sms.js to enable real texting. ` +
      `To: ${to} | queueId: ${queueId}`
  );
  await markSmsStatus(queueId, 'provider-stub');
  return { ok: true, provider: 'provider-stub', note: 'stub — not delivered' };
}

/**
 * Best-effort events-table logging for SMS send attempts. Never throws, so
 * logging can never break or retry a send.
 */
async function recordSmsEvent(queueId, type, extraMeta = {}) {
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
    console.error(`[sms] failed to record ${type} event:`, err && err.message ? err.message : err);
  }
}

/**
 * Send one queued SMS. Returns { ok, provider, ... }.
 * Never throws for provider failures — the queue row keeps its status so the
 * scheduler can retry on a later pass. On success an `sms_sent` event is
 * recorded; if the provider throws, an `sms_failed` event is recorded and
 * the error rethrown.
 */
async function sendSms({ to, body, queueId }) {
  try {
    const result = await sendStub({ to, body, queueId });
    await recordSmsEvent(queueId, 'sms_sent', { provider: result && result.provider });
    return result;
  } catch (err) {
    await recordSmsEvent(queueId, 'sms_failed', {
      error: err && err.message ? err.message : String(err),
    });
    throw err;
  }
}

module.exports = { sendSms, PROVIDER };
