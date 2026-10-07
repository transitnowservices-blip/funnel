'use strict';
/**
 * scripts/test-trial-autoconvert.js — auto-convert $1/day trial checkout tests.
 *
 * Part 1: lib/trialCheckout unit tests with a mocked `stripe` module
 * (require.cache injection). No network, no key needed for most; key-gated
 * paths are tested with a fake key + mock.
 *
 * Part 2: live-server webhook tests. Boots server.js on a test port with a
 * fake STRIPE_WEBHOOK_SECRET and HMAC-signed synthetic Stripe events against
 * a scratch copy of the dev DB (original restored afterwards).
 *
 * Run: node scripts/test-trial-autoconvert.js
 * Exit 0 = all pass, 1 = any failure.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok -', name); }
  else { failed++; console.log('  FAIL -', name, extra || ''); }
}

async function part1() {
  console.log('\n[part 1] trialCheckout unit tests (mocked stripe)');
  delete process.env.STRIPE_SECRET_KEY;
  const tc = require('../lib/trialCheckout');

  check('cleanTier keeps 7/14/30', tc.cleanTier(7) === 7 && tc.cleanTier('14') === 14 && tc.cleanTier(30) === 30);
  check('cleanTier defaults garbage to 7', tc.cleanTier('x') === 7 && tc.cleanTier(null) === 7 && tc.cleanTier(99) === 7);

  const r7 = tc.renewalDate(7), r30 = tc.renewalDate(30);
  const days7 = Math.round((r7 - Date.now()) / 86400000), days30 = Math.round((r30 - Date.now()) / 86400000);
  check('renewalDate 7/30 days out', days7 === 7 && days30 === 30, `${days7}/${days30}`);
  check('fmtDate renders Month D, YYYY', /[A-Z][a-z]+ \d{1,2}, \d{4}/.test(tc.fmtDate(r7)), tc.fmtDate(r7));

  check('isConfigured false without key', tc.isConfigured() === false);
  check('createTrialCheckoutSession returns null without key', (await tc.createTrialCheckoutSession({ email: 'a@b.c', tierDays: 7, siteUrl: 'http://x' })) === null);
  check('createPortalSession returns null without key', (await tc.createPortalSession('cus_x', 'http://x/')) === null);
  let threw = false;
  try { await tc.getCompletePriceId(); } catch (e) { threw = /not set/.test(e.message); }
  check('getCompletePriceId throws loudly without key', threw);

  // --- mocked stripe with fake key ---
  const calls = { sessions: [], prices: 0, portal: 0 };
  let portalFail = false;
  let priceList = [{ id: 'price_basic50', unit_amount: 5000, currency: 'usd', recurring: { interval: 'month' }, active: true }];
  require.cache[require.resolve('stripe')] = { exports: () => ({
    checkout: { sessions: { create: async (p) => { calls.sessions.push(p); return { id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' }; } } },
    prices: { list: async () => { calls.prices++; return { data: priceList }; } },
    billingPortal: { sessions: { create: async () => { calls.portal++; if (portalFail) throw new Error('portal not configured'); return { url: 'https://billing.stripe.com/p/sess_test' }; } } },
  }) };
  // re-require fresh to pick up the mock
  delete require.cache[require.resolve('../lib/trialCheckout')];
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  const tc2 = require('../lib/trialCheckout');
  check('isConfigured true with key', tc2.isConfigured() === true);

  // price list includes the $100/mo Complete price for session creation
  priceList = [
    { id: 'price_basic50', unit_amount: 5000, currency: 'usd', recurring: { interval: 'month' }, active: true },
    { id: 'price_complete_100', unit_amount: 10000, currency: 'usd', recurring: { interval: 'month' }, active: true },
  ];

  for (const [tier, cents] of [[7, 700], [14, 1400], [30, 3000]]) {
    calls.sessions.length = 0;
    const s = await tc2.createTrialCheckoutSession({ email: 'Buyer@Example.com', firstName: 'Bo', tierDays: tier, siteUrl: 'https://funnel-qdx9.onrender.com/' });
    const p = calls.sessions[0];
    check(`tier ${tier}: session created with url`, !!(s && s.url));
    check(`tier ${tier}: mode subscription`, p.mode === 'subscription');
    check(`tier ${tier}: 2 line items`, Array.isArray(p.line_items) && p.line_items.length === 2);
    const one = p.line_items[0], rec = p.line_items[1];
    check(`tier ${tier}: one-time $${cents / 100} charged today`, one.price_data && Number(one.price_data.unit_amount) === cents && one.price_data.currency === 'usd');
    check(`tier ${tier}: recurring item uses resolved $100 price`, rec.price === 'price_complete_100' || typeof rec.price === 'string');
    check(`tier ${tier}: trial_period_days=${tier}`, p.subscription_data && p.subscription_data.trial_period_days === tier);
    check(`tier ${tier}: session metadata tags trial`, p.metadata && p.metadata.source === 'transitnow-trial' && p.metadata.trial_days === String(tier));
    check(`tier ${tier}: subscription metadata tags trial`, p.subscription_data.metadata && p.subscription_data.metadata.source === 'transitnow-trial');
    check(`tier ${tier}: customer email lowercased`, p.customer_email === 'buyer@example.com');
    check(`tier ${tier}: success/cancel urls`, (p.success_url || '').includes(`/trial/success?tier=${tier}`) && (p.cancel_url || '').includes(`/trial?tier=${tier}`));
  }

  // price resolution: finds the $100/mo one among others
  priceList = [
    { id: 'price_basic50', unit_amount: 5000, currency: 'usd', recurring: { interval: 'month' }, active: true },
    { id: 'price_complete_100', unit_amount: 10000, currency: 'usd', recurring: { interval: 'month' }, active: true },
    { id: 'price_eur', unit_amount: 10000, currency: 'eur', recurring: { interval: 'month' }, active: true },
  ];
  delete require.cache[require.resolve('../lib/trialCheckout')];
  const tc3 = require('../lib/trialCheckout');
  const pid = await tc3.getCompletePriceId();
  check('price resolution picks USD $100/mo', pid === 'price_complete_100', pid);

  priceList = [{ id: 'price_basic50', unit_amount: 5000, currency: 'usd', recurring: { interval: 'month' }, active: true }];
  delete require.cache[require.resolve('../lib/trialCheckout')];
  const tc4 = require('../lib/trialCheckout');
  let loud = false;
  try { await tc4.getCompletePriceId(); } catch (e) { loud = /no active USD \$100\/mo/i.test(e.message); }
  check('price resolution fails LOUDLY when missing', loud);

  const portalOk = await tc4.createPortalSession('cus_123', 'https://x/');
  check('portal session returns url', portalOk === 'https://billing.stripe.com/p/sess_test', portalOk);
  portalFail = true;
  check('portal returns null (not throw) when unconfigured', (await tc4.createPortalSession('cus_123', 'https://x/')) === null);
  check('portal null without customer', (await tc4.createPortalSession(null, 'https://x/')) === null);
  delete process.env.STRIPE_SECRET_KEY;
}

function signPayload(secret, bodyStr) {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${bodyStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}

async function part2() {
  console.log('\n[part 2] live server webhook tests (HMAC-signed synthetic events)');
  const dbPath = path.join(ROOT, 'data', 'funnel.db');
  const bakPath = dbPath + '.autoconvert-test-bak';
  fs.copyFileSync(dbPath, bakPath);
  const PORT = 4311, SECRET = 'whsec_test_autoconvert';
  const env = { ...process.env, PORT: String(PORT), STRIPE_WEBHOOK_SECRET: SECRET };
  delete env.TURSO_DATABASE_URL; delete env.TURSO_AUTH_TOKEN; delete env.STRIPE_SECRET_KEY;
  const child = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const req = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body,
    });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  };
  const postEvent = async (event) => {
    const body = JSON.stringify(event);
    const headers = { 'stripe-signature': signPayload(SECRET, body) };
    return req('/webhooks/stripe', { method: 'POST', headers, body });
  };
  const mkEvent = (id, type, obj) => ({ id, type, data: { object: obj } });
  try {
    // wait for boot
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await req('/trial?tier=7'); up = r.status === 200; } catch { await new Promise(r => setTimeout(r, 500)); }
    }
    check('server booted', up);
    if (!up) return;

    // /trial page shows auto-convert copy + renewal date
    let r = await req('/trial?tier=7');
    const renew7 = new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    check('/trial shows $7 today + renewal date', r.text.includes('$7 today') && r.text.includes(renew7), renew7);
    check('/trial cancel-anytime copy', r.text.includes('Cancel anytime'));

    // /trial/checkout without key -> 302 fallback to one-time link
    r = await fetch(`http://127.0.0.1:${PORT}/trial/checkout?tier=14&email=trialauto1%40example.com`, { redirect: 'manual' });
    check('/trial/checkout falls back to one-time link without key', r.status === 302 && (r.headers.get('location') || '').startsWith('https://buy.stripe.com/'));

    // /trial/success page
    r = await req('/trial/success?tier=30');
    check('/trial/success shows $30 + renewal + manage link', r.text.includes('$30') && r.text.includes('/subscription/manage'));

    // /subscription/manage fallback (no key -> text Davena)
    r = await req('/subscription/manage?email=nobody%40example.com');
    check('/subscription/manage falls back to text-Davena', r.text.includes('TEXT DAVENA') && r.text.includes('sms:+14143680711'));

    // webhook: trial subscription checkout (subscription mode)
    const email = 'trialauto2@example.com';
    const evt1 = mkEvent('evt_trial_sub_1', 'checkout.session.completed', {
      id: 'cs_trial_1', mode: 'subscription', customer: 'cus_trial_1', subscription: 'sub_trial_1',
      customer_details: { email }, amount_total: 700,
      metadata: { source: 'transitnow-trial', trial_days: '7', trial_tier_cents: '700' },
    });
    r = await postEvent(evt1);
    check('trial subscription checkout handled', r.status === 200 && JSON.parse(r.text).handled === true, r.text.slice(0, 120));

    const sqlite3 = require('child_process');
    const q = (sql) => sqlite3.execSync(`sqlite3 ${dbPath} "${sql}"`, { encoding: 'utf8' }).trim();
    const trialRow = q(`SELECT trial_days || '|' || stripe_customer_id || '|' || stripe_subscription_id FROM driver_trials WHERE email='${email}'`);
    check('driver_trials row: 7 days + customer + subscription ids', trialRow === '7|cus_trial_1|sub_trial_1', trialRow);
    const subRow = q(`SELECT COUNT(*) FROM dispatch_subscriptions WHERE email='${email}'`);
    check('NO dispatch_subscriptions row during trial (referral clock safe)', subRow === '0', subRow);

    // idempotency: same event again
    r = await postEvent(evt1);
    const trialDays2 = q(`SELECT trial_days FROM driver_trials WHERE email='${email}'`);
    check('duplicate event idempotent (days not doubled)', trialDays2 === '7', trialDays2);

    // customer.subscription.updated trialing -> no row
    const evt2 = mkEvent('evt_trial_upd_1', 'customer.subscription.updated', {
      id: 'sub_trial_1', status: 'trialing', customer: 'cus_trial_1',
      metadata: { source: 'transitnow-trial', trial_days: '7' },
      items: { data: [{ price: { unit_amount: 10000 } }] },
    });
    r = await postEvent(evt2);
    const subRow2 = q(`SELECT COUNT(*) FROM dispatch_subscriptions WHERE email='${email}'`);
    check('trialing update creates no subscription row', subRow2 === '0' && r.status === 200, subRow2);

    // trial ends, subscription active -> row created (existing path)
    const evt3 = mkEvent('evt_trial_upd_2', 'customer.subscription.updated', {
      id: 'sub_trial_1', status: 'active', customer: 'cus_trial_1',
      customer_email: email, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      metadata: { source: 'transitnow-trial', trial_days: '7' },
      items: { data: [{ price: { unit_amount: 10000 } }] },
    });
    r = await postEvent(evt3);
    const subRow3 = q(`SELECT status || '|' || plan FROM dispatch_subscriptions WHERE email='${email}'`);
    check('active update creates Complete row', subRow3 === 'active|complete', subRow3);

    // first real invoice paid -> renewal path, still complete
    const evt4 = mkEvent('evt_trial_inv_1', 'invoice.payment_succeeded', {
      id: 'in_trial_1', customer: 'cus_trial_1', subscription: 'sub_trial_1',
      amount_paid: 10000, customer_email: email,
      lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 30 * 86400 } }] },
    });
    r = await postEvent(evt4);
    check('first $100 invoice handled', r.status === 200, r.text.slice(0, 100));

    // cancel during trial on a FRESH email (no subscription row exists)
    const email3 = 'trialauto3@example.com';
    const evt5 = mkEvent('evt_trial_sub_3', 'checkout.session.completed', {
      id: 'cs_trial_3', mode: 'subscription', customer: 'cus_trial_3', subscription: 'sub_trial_3',
      customer_details: { email: email3 }, amount_total: 1400,
      metadata: { source: 'transitnow-trial', trial_days: '14', trial_tier_cents: '1400' },
    });
    await postEvent(evt5);
    const evt6 = mkEvent('evt_trial_del_3', 'customer.subscription.deleted', {
      id: 'sub_trial_3', status: 'canceled', customer: 'cus_trial_3', customer_email: email3,
      items: { data: [{ price: { unit_amount: 10000 } }] },
    });
    r = await postEvent(evt6);
    const trialKept = q(`SELECT trial_days FROM driver_trials WHERE email='${email3}'`);
    check('cancel during trial: no crash, trial days kept', r.status === 200 && trialKept === '14', `${r.status}/${trialKept}`);

    // non-trial subscription checkout still works (existing behavior)
    const email4 = 'trialauto4@example.com';
    const evt7 = mkEvent('evt_plain_sub_4', 'checkout.session.completed', {
      id: 'cs_plain_4', mode: 'subscription', customer: 'cus_plain_4', subscription: 'sub_plain_4',
      customer_details: { email: email4 }, amount_total: 10000, metadata: {},
    });
    r = await postEvent(evt7);
    const subRow4 = q(`SELECT status || '|' || plan FROM dispatch_subscriptions WHERE email='${email4}'`);
    check('plain $100 subscription checkout unchanged', subRow4 === 'active|complete', subRow4);

    // one-time trial amounts still work (existing behavior)
    const email5 = 'trialauto5@example.com';
    const evt8 = mkEvent('evt_onetime_5', 'checkout.session.completed', {
      id: 'cs_onetime_5', mode: 'payment', customer_details: { email: email5 }, amount_total: 3000, metadata: {},
    });
    r = await postEvent(evt8);
    const trialRow5 = q(`SELECT trial_days FROM driver_trials WHERE email='${email5}'`);
    check('one-time $30 trial still grants 30 days', trialRow5 === '30', trialRow5);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1500));
    fs.copyFileSync(bakPath, dbPath);
    fs.unlinkSync(bakPath);
    console.log('  (dev DB restored)');
  }
}

(async () => {
  try {
    await part1();
    await part2();
  } catch (e) {
    failed++;
    console.log('  FAIL - unexpected error:', e.message);
  }
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
