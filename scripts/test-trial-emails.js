'use strict';
// Focused test for $1/day trial email sequences. Run: node scripts/test-trial-emails.js
// Uses the local dev data/funnel.db (backed up + restored by the runner).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
process.chdir(APP_ROOT);

const DB_PATH = path.join(APP_ROOT, 'data', 'funnel.db');
const BACKUP = DB_PATH + '.pre-trial-email-test.bak';
const EMAILS_JSON = path.join(APP_ROOT, 'config', 'emails.json');
const EMAILS_BAK = EMAILS_JSON + '.pre-trial-email-test.bak';

function setFlag(val) {
  const d = JSON.parse(fs.readFileSync(EMAILS_JSON, 'utf8'));
  d.trialSequencesEnabled = val;
  fs.writeFileSync(EMAILS_JSON, JSON.stringify(d, null, 2) + '\n');
}

async function main() {
  fs.copyFileSync(DB_PATH, BACKUP);
  fs.copyFileSync(EMAILS_JSON, EMAILS_BAK);
  let passed = 0;
  const ok = (name) => { passed++; console.log('  PASS', name); };
  try {
    const db = require('../lib/db');
    await db.ready;
    const automation = require('../lib/automation');
    const trials = require('../lib/trials');

    // Clean slate for test addresses.
    const addrs = ['trialcart@example.com', 'expiry3d@example.com', 'expiry1d@example.com',
      'expiredx@example.com', 'expiredold@example.com', 'subbed@example.com', 'notrial@example.com'];
    for (const a of addrs) {
      await db.run('DELETE FROM leads WHERE email = ?', [a]);
      await db.run('DELETE FROM driver_trials WHERE email = ?', [a]);
      await db.run('DELETE FROM email_queue WHERE email = ?', [a]);
      await db.run('DELETE FROM carts WHERE lead_id IN (SELECT id FROM leads WHERE email = ?)', [a]);
      await db.run('DELETE FROM tags WHERE lead_id IN (SELECT id FROM leads WHERE email = ?)', [a]);
      await db.run('DELETE FROM dispatch_subscriptions WHERE email = ?', [a]);
    }

    // 1. Flag defaults to false.
    assert.strictEqual(automation.trialSequencesEnabled(), false);
    ok('trialSequencesEnabled() false by default');

    // 2. Trial cart with flag OFF -> nothing queued, no tag.
    const r1 = await db.run(
      "INSERT INTO leads (visitor_id, first_name, email, source, consent_marketing, consent_ts, date_captured, status) VALUES (?,?,?,?,?,?,?, 'lead')",
      ['v-test', 'Trial', 'trialcart@example.com', 'test', 1, Date.now(), Date.now()]);
    const leadId = r1.lastInsertRowid;
    const twoHoursAgo = Date.now() - 2 * 3600e3;
    await db.run('INSERT INTO carts (lead_id, visitor_id, product_id, started_at, purchased, recovered) VALUES (?,?,?,?,0,0)',
      [leadId, 'v-test', 'transitnow-trial', twoHoursAgo]);
    const flagged0 = await automation.detectAbandonedCarts();
    const q0 = await db.all("SELECT * FROM email_queue WHERE email='trialcart@example.com'");
    assert.strictEqual(q0.length, 0, 'no rows queued while disabled');
    const tag0 = await db.get('SELECT 1 FROM tags WHERE lead_id=? AND tag=?', [leadId, 'ABANDONED_CART']);
    assert.ok(!tag0, 'no ABANDONED_CART tag while disabled');
    ok('disabled flag: no trial abandoned-cart queuing');

    // 3. Enable flag -> detectAbandonedCarts queues 3-step series from cart start.
    setFlag(true);
    assert.strictEqual(automation.trialSequencesEnabled(), true);
    const flagged1 = await automation.detectAbandonedCarts();
    assert.strictEqual(flagged1, 1);
    const q1 = await db.all("SELECT step, scheduled_for FROM email_queue WHERE email='trialcart@example.com' AND sequence='trialAbandonedCart' ORDER BY scheduled_for");
    assert.strictEqual(q1.length, 3, '3 trial cart emails queued');
    assert.deepStrictEqual(q1.map(r => r.step), ['trial-cart-1', 'trial-cart-2', 'trial-cart-3']);
    // Delays measured from cart start: +1h, +24h, +72h.
    const d1 = q1.map(r => Math.round((r.scheduled_for - twoHoursAgo) / 3600e3));
    assert.deepStrictEqual(d1, [1, 24, 72]);
    assert.ok(q1[0].scheduled_for <= Date.now(), 'first email due immediately (cart started 2h ago)');
    ok('trial abandoned-cart series queued with 1h/24h/72h delays from checkout start');

    // 4. Idempotent: second pass queues nothing new.
    const q1b = await automation.detectAbandonedCarts();
    assert.strictEqual(q1b, 0, 'already flagged -> skipped');
    const q1c = await db.all("SELECT COUNT(*) c FROM email_queue WHERE email='trialcart@example.com' AND sequence='trialAbandonedCart'");
    assert.strictEqual(q1c[0].c, 3);
    ok('abandoned-cart detection idempotent');

    // 5. cancelTrialSequences cancels queued rows.
    const cancelled = await automation.cancelTrialSequences('trialcart@example.com', 'purchased');
    assert.strictEqual(cancelled, 3);
    const q1d = await db.all("SELECT COUNT(*) c FROM email_queue WHERE email='trialcart@example.com' AND status='queued'");
    assert.strictEqual(q1d[0].c, 0);
    ok('cancelTrialSequences cancels queued trial rows');

    // 6. Send-time guard: active trial -> 'purchased'.
    await trials.recordTrialPurchase({ email: 'trialcart@example.com', amountCents: 700, stripeSessionId: 'cs_test_1', purchasedAt: Date.now() });
    await db.run(`INSERT INTO email_queue (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
      VALUES (?, 'trialcart@example.com', 'trialAbandonedCart', 'trial-cart-2', 's', 'b', 'transitnow-trial', ?, 'queued')`,
      [leadId, Date.now() - 1000]);
    const row = await db.get("SELECT * FROM email_queue WHERE email='trialcart@example.com' AND step='trial-cart-2' AND status='queued'");
    const res6 = await automation.processTrialEmail(row);
    assert.strictEqual(res6, 'cancelled');
    const row6 = await db.get('SELECT cancel_reason FROM email_queue WHERE id=?', [row.id]);
    assert.strictEqual(row6.cancel_reason, 'purchased');
    ok('send-time guard cancels trial cart email when trial active');

    // 7. Expiry scheduler: 4 trial rows at different life stages.
    const now = Date.now();
    const mk = async (email, endsAt) => db.run(
      'INSERT INTO driver_trials (email, trial_ends_at, trial_days, amount_cents, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [email, endsAt, 7, 700, now - 10 * 864e5, now]);
    await mk('expiry3d@example.com', now + 2.5 * 864e5);   // -> trial-expiry-3d
    await mk('expiry1d@example.com', now + 0.5 * 864e5);   // -> trial-expiry-1d
    await mk('expiredx@example.com', now - 1 * 864e5);     // -> trial-expired
    await mk('expiredold@example.com', now - 5 * 864e5);   // -> trial-expired-plus3d
    await mk('subbed@example.com', now + 2.5 * 864e5);     // subscribed -> skipped
    await db.run("INSERT INTO dispatch_subscriptions (email, plan, status, created_at, updated_at) VALUES ('subbed@example.com','complete','active',?,?)", [now, now]);
    // subbed also has a stale queued expiry row -> should be cancelled.
    await db.run(`INSERT INTO email_queue (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
      VALUES (NULL, 'subbed@example.com', 'trialExpiry', 'trial-expiry-3d', 's', 'b', 'transitnow-trial', ?, 'queued')`, [now - 1000]);

    const exp = await automation.queueTrialExpiryEmails(now);
    assert.strictEqual(exp.ran, true);
    assert.strictEqual(exp.queued, 4, 'one step per trial row, got ' + exp.queued);
    for (const [em, step] of [['expiry3d@example.com', 'trial-expiry-3d'], ['expiry1d@example.com', 'trial-expiry-1d'],
        ['expiredx@example.com', 'trial-expired'], ['expiredold@example.com', 'trial-expired-plus3d']]) {
      const got = await db.get("SELECT subject, body_html FROM email_queue WHERE email=? AND sequence='trialExpiry' AND step=? AND status='queued'", [em, step]);
      assert.ok(got, `queued ${step} for ${em}`);
      assert.ok(!got.subject.includes('{{'), `subject rendered for ${em}`);
      assert.ok(!got.body_html.includes('{{trial_days_left}}') && !got.body_html.includes('{{trial_end_date}}'), `vars rendered for ${em}`);
    }
    const sub = await db.get("SELECT status, cancel_reason FROM email_queue WHERE email='subbed@example.com' AND sequence='trialExpiry'");
    assert.strictEqual(sub.status, 'cancelled');
    assert.strictEqual(sub.cancel_reason, 'subscribed');
    ok('expiry scheduler queues correct step per life stage; subscribers skipped+cancelled');

    // 8. Expiry idempotent.
    const exp2 = await automation.queueTrialExpiryEmails(now);
    assert.strictEqual(exp2.queued, 0);
    ok('expiry scheduler idempotent');

    // 9. Send-time guard: active subscription cancels trialExpiry row.
    await db.run(`INSERT INTO email_queue (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
      VALUES (NULL, 'subbed@example.com', 'trialExpiry', 'trial-expired', 's', 'b', 'transitnow-trial', ?, 'queued')`, [now - 1000]);
    const srow = await db.get("SELECT * FROM email_queue WHERE email='subbed@example.com' AND step='trial-expired' AND status='queued'");
    const res9 = await automation.processTrialEmail(srow);
    assert.strictEqual(res9, 'cancelled');
    ok('send-time guard cancels expiry email for active subscriber');

    // 10. Suppressed address never queued/sent.
    await db.run('INSERT OR IGNORE INTO suppressions (email) VALUES (?)', ['notrial@example.com']);
    await mk('notrial@example.com', now + 2.5 * 864e5);
    const exp3 = await automation.queueTrialExpiryEmails(now);
    const nq = await db.get("SELECT COUNT(*) c FROM email_queue WHERE email='notrial@example.com' AND sequence='trialExpiry'");
    assert.strictEqual(nq.c, 0);
    ok('suppressed addresses skipped');

    // 11. Disabled flag blocks expiry scheduler entirely.
    setFlag(false);
    const exp4 = await automation.queueTrialExpiryEmails(now);
    assert.strictEqual(exp4.ran, false);
    assert.strictEqual(exp4.reason, 'disabled');
    ok('disabled flag blocks expiry scheduler');

    // 12. runSchedulerPass includes trialExpiry key and doesn't crash with flag off.
    const pass = await automation.runSchedulerPass(now);
    assert.ok('trialExpiry' in pass);
    ok('runSchedulerPass returns trialExpiry stat');

    console.log(`\nALL ${passed} TRIAL EMAIL TESTS PASSED`);
  } finally {
    fs.copyFileSync(BACKUP, DB_PATH);
    fs.copyFileSync(EMAILS_BAK, EMAILS_JSON);
    fs.unlinkSync(BACKUP);
    fs.unlinkSync(EMAILS_BAK);
  }
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
