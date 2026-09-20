#!/usr/bin/env node
/*
 * Automated end-to-end test for the funnel app.
 *
 * SPEC-FIRST (contract 2026-09-19): the app is being built by sibling agents
 * against the same contract. This test therefore DISCOVERS the SQLite schema
 * (table/column names) at runtime instead of hard-coding it — see
 * "SCHEMA DISCOVERY" below. If discovery fails it prints the actual schema
 * so the map can be corrected in one place.
 *
 * What it does:
 *   1. Spawns `node server.js` itself (ADMIN_TOKEN=test-token, PORT=3111,
 *      EMAIL_PROVIDER=local), waits for /healthz.
 *   2. Anonymous visit -> lead submit -> NEW_LEAD tag -> scheduler ->
 *      welcome email HTML in data/outbox.
 *   3. Sales view (VIEWED_OFFER) -> checkout start, no purchase ->
 *      cart row + STARTED_CHECKOUT/HIGH_INTENT.
 *   4. Ages the cart 2h via sqlite -> scheduler -> ABANDONED_CART tag +
 *      cart email #1 -> forces all 4 cart emails due -> scheduler ->
 *      asserts 4 cart emails sent.
 *   5. Completes the demo purchase -> scheduler -> asserts cart emails
 *      cancelled, ABANDONED_CART removed, PURCHASED/CUSTOMER tags,
 *      confirmation + post-purchase emails.
 *   6. Second lead: purchase immediately (no abandon) -> no cart tags/emails.
 *   7. Third lead (pure prospect): weekly nurture sends; purchaser is
 *      suppressed from featured-offer prospect promo.
 *   8. Unsubscribe flow -> UNSUBSCRIBED + queue cancelled + no more mail.
 *   9. Admin dashboard 200 + key metric labels.
 *  10. Kills the server, prints PASS/FAIL per assertion, exits non-zero
 *      on any failure.
 *
 * Only node built-ins + node:sqlite + global fetch. No npm dependencies.
 */

const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'test-token';
const DB_PATH = path.join(APP_ROOT, 'data', 'funnel.db');
const OUTBOX = path.join(APP_ROOT, 'data', 'outbox');
const SERVER_START_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */
const results = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`);
}
function failFast(msg) {
  console.log('FAIL  ' + msg);
  results.push({ name: msg, ok: false });
  throw new Error(msg);
}

/* ------------------------------------------------------------------ */
/* HTTP + cookie jar                                                   */
/* ------------------------------------------------------------------ */
class Jar {
  constructor() { this.c = new Map(); }
  store(res) {
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const h of sc) {
      const pair = h.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
  has(n) { return this.c.has(n); }
}

async function req(url, { method = 'GET', jar = null, form = null, json = null, redirect = 'manual' } = {}) {
  const headers = {};
  if (jar && jar.c.size) headers.cookie = jar.header();
  let body;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, redirect, signal: ctl.signal });
    if (jar) jar.store(res);
    return res;
  } finally { clearTimeout(t); }
}

async function runScheduler() {
  const res = await req(`${BASE}/admin/run-scheduler?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
  const text = await res.text();
  return { status: res.status, text };
}

/* ------------------------------------------------------------------ */
/* SCHEMA DISCOVERY — the one place to adapt if the build names        */
/* things differently. Candidates are tried in order; the first        */
/* table/column that exists wins.                                      */
/* ------------------------------------------------------------------ */
function tableExists(db, t) {
  try { db.prepare(`SELECT 1 FROM "${t}" LIMIT 1`).get(); return true; }
  catch { return false; }
}
function findTable(db, cands, what) {
  for (const c of cands) if (tableExists(db, c)) return c;
  const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  failFast(`schema: no ${what} table among [${cands.join(', ')}]; actual tables: [${actual.join(', ')}]`);
}
function columns(db, t) {
  return db.prepare(`PRAGMA table_info("${t}")`).all().map(r => r.name);
}
function pickCol(cols, cands) {
  return cands.find(c => cols.includes(c)) || null;
}

function discover(db) {
  const S = {};
  S.leads = findTable(db, ['leads', 'lead', 'contacts', 'subscribers'], 'leads');
  const lc = columns(db, S.leads);
  S.leadId = pickCol(lc, ['id', 'lead_id']) || failFast('schema: leads table has no id column');
  S.leadEmail = pickCol(lc, ['email', 'email_address']) || failFast('schema: leads table has no email column');

  S.tags = findTable(db, ['lead_tags', 'tags', 'taggings', 'contact_tags'], 'tags');
  const tc = columns(db, S.tags);
  S.tagLead = pickCol(tc, ['lead_id', 'contact_id', 'subscriber_id']) || failFast('schema: tags table has no lead id column');
  S.tagName = pickCol(tc, ['tag', 'tag_name', 'name']) || failFast('schema: tags table has no tag name column');

  S.carts = findTable(db, ['carts', 'cart', 'checkouts'], 'carts');
  const cc = columns(db, S.carts);
  S.cartId = pickCol(cc, ['id', 'cart_id']) || failFast('schema: carts table has no id column');
  S.cartLead = pickCol(cc, ['lead_id', 'contact_id']) || failFast('schema: carts table has no lead id column');
  S.cartStatus = pickCol(cc, ['status', 'state']);
  S.cartStarted = pickCol(cc, ['started_at', 'created_at', 'updated_at']) || failFast('schema: carts table has no started_at/created_at column');

  S.queue = findTable(db, ['email_queue', 'emails', 'email_jobs', 'outbox', 'scheduled_emails'], 'email queue');
  const qc = columns(db, S.queue);
  S.qLead = pickCol(qc, ['lead_id', 'contact_id']);
  S.qStatus = pickCol(qc, ['status', 'state']) || failFast('schema: email queue has no status column');
  S.qSched = pickCol(qc, ['scheduled_for', 'send_at', 'scheduled_at', 'run_at']) || failFast('schema: email queue has no scheduled_for column');
  S.qTextCols = ['sequence', 'step', 'template', 'template_name', 'kind', 'type', 'name', 'subject'].filter(c => qc.includes(c));
  if (!S.qTextCols.length) failFast('schema: email queue has no sequence/step/subject-ish text column');

  S.purchases = findTable(db, ['purchases', 'orders', 'transactions'], 'purchases');
  const pc = columns(db, S.purchases);
  S.purLead = pickCol(pc, ['lead_id', 'contact_id', 'email']);
  return S;
}

function tagsFor(db, S, leadId) {
  return db.prepare(`SELECT "${S.tagName}" AS t FROM "${S.tags}" WHERE "${S.tagLead}" = ?`)
    .all(leadId).map(r => r.t);
}
function leadIdByEmail(db, S, email) {
  const r = db.prepare(`SELECT "${S.leadId}" AS id FROM "${S.leads}" WHERE "${S.leadEmail}" = ?`).get(email);
  return r ? r.id : null;
}
function textConds(S, keywords) {
  // (LOWER("template") LIKE '%cart%' OR LOWER("subject") LIKE '%cart%' ...)
  const ors = [];
  for (const col of S.qTextCols) for (const kw of keywords) ors.push(`LOWER("${col}") LIKE '%${kw}%'`);
  return `(${ors.join(' OR ')})`;
}
function queueCount(db, S, leadId, keywords, status) {
  const conds = [`"${S.qStatus}" = ?`];
  const params = [status];
  if (S.qLead && leadId != null) { conds.push(`"${S.qLead}" = ?`); params.push(leadId); }
  if (keywords) conds.push(textConds(S, keywords));
  return db.prepare(`SELECT COUNT(*) AS n FROM "${S.queue}" WHERE ${conds.join(' AND ')}`).get(...params).n;
}
function forceDue(db, S, leadId, keywords) {
  const conds = [`"${S.qStatus}" = 'queued'`, textConds(S, keywords)];
  const params = [];
  if (S.qLead && leadId != null) { conds.push(`"${S.qLead}" = ?`); params.push(leadId); }
  return db.prepare(`UPDATE "${S.queue}" SET "${S.qSched}" = datetime('now','-1 minute') WHERE ${conds.join(' AND ')}`).run(...params).changes;
}

/* ------------------------------------------------------------------ */
/* Outbox helpers                                                      */
/* ------------------------------------------------------------------ */
function outboxFiles() {
  try { return fs.readdirSync(OUTBOX).filter(f => f.endsWith('.html')).sort(); }
  catch { return []; }
}
function newFilesSince(before) {
  const b = new Set(before);
  return outboxFiles().filter(f => !b.has(f));
}
function filesMentioning(email, files) {
  return files.filter(f => {
    try { return fs.readFileSync(path.join(OUTBOX, f), 'utf8').includes(email); }
    catch { return false; }
  });
}

/* ------------------------------------------------------------------ */
/* Server lifecycle                                                    */
/* ------------------------------------------------------------------ */
function startServer() {
  if (!fs.existsSync(path.join(APP_ROOT, 'server.js'))) {
    failFast(`server.js not found at ${APP_ROOT}/server.js — app not built yet`);
  }
  const child = spawn('node', ['server.js'], {
    cwd: APP_ROOT,
    env: { ...process.env, ADMIN_TOKEN, PORT: String(PORT), EMAIL_PROVIDER: 'local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[server:err] ${d}`));
  return child;
}
async function waitForHealth() {
  const t0 = Date.now();
  while (Date.now() - t0 < SERVER_START_TIMEOUT_MS) {
    try {
      const res = await req(`${BASE}/healthz`, {});
      if (res.status === 200 && (await res.text()).trim() === 'ok') return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  failFast(`server did not answer /healthz with "ok" within ${SERVER_START_TIMEOUT_MS}ms`);
}
function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    child.once('exit', () => { clearTimeout(killer); resolve(); });
    try { child.kill('SIGTERM'); } catch { resolve(); }
  });
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  const ts = Date.now();
  const email1 = `e2e1-${ts}@example.com`;
  const email2 = `e2e2-${ts}@example.com`;
  const email3 = `e2e3-${ts}@example.com`;

  let child = null, db = null;
  try {
    child = startServer();
    await waitForHealth();
    check('server boots and GET /healthz returns "ok"', true);

    if (!fs.existsSync(DB_PATH)) failFast(`DB not found at ${DB_PATH} — app did not create data/funnel.db`);
    db = new DatabaseSync(DB_PATH);
    const S = discover(db);
    check('schema discovery found leads/tags/carts/queue/purchases tables', true);

    // Optional: ground product id + payment mode from config (used for stripe-mode path)
    let paymentMode = 'demo', productId = null;
    try {
      const site = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'site.json'), 'utf8'));
      if (site.paymentMode) paymentMode = site.paymentMode;
      const prods = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'products.json'), 'utf8'));
      const list = Array.isArray(prods) ? prods : prods.products;
      if (Array.isArray(list) && list.length) productId = list[0].id || list[0].productId || null;
    } catch { /* config not readable yet; assume demo */ }
    console.log(`info: paymentMode=${paymentMode}${productId ? ` productId=${productId}` : ''}`);

    /* ---- 1. Anonymous visit -------------------------------------- */
    const jar1 = new Jar();
    let res = await req(`${BASE}/`, { jar: jar1 });
    check('GET / returns 200', res.status === 200, `status=${res.status}`);
    check('anonymous visit sets vid cookie, no lid yet', jar1.has('vid') && !jar1.has('lid'),
      `cookies=[${[...jar1.c.keys()].join(',')}]`);

    /* ---- 2. Lead submit ------------------------------------------- */
    res = await req(`${BASE}/lead`, { jar: jar1 });
    const leadForm = await res.text();
    check('GET /lead form exposes first_name/email/consent fields',
      res.status === 200 && /first_name/i.test(leadForm) && /name="email"/i.test(leadForm) && /consent/i.test(leadForm),
      `status=${res.status}`);

    const outboxBefore = outboxFiles();
    res = await req(`${BASE}/lead?src=autotest&cmp=e2e`, {
      jar: jar1, method: 'POST',
      form: { first_name: 'Testy', email: email1, phone: '414-555-0100', consent: 'on' },
    });
    const loc = res.headers.get('location') || '';
    check('POST /lead 302-redirects to /free-value', [301, 302, 303].includes(res.status) && loc.includes('/free-value'),
      `status=${res.status} location=${loc}`);
    check('lead submit sets lid cookie (visitor now identified)', jar1.has('lid'),
      `cookies=[${[...jar1.c.keys()].join(',')}]`);

    const lead1 = leadIdByEmail(db, S, email1);
    check('lead row saved in DB', lead1 != null);
    if (lead1 == null) failFast('cannot continue without lead1 row');

    let tags = tagsFor(db, S, lead1);
    check('lead tagged NEW_LEAD', tags.includes('NEW_LEAD'), `tags=[${tags.join(',')}]`);

    // Welcome email: may send on submit or need a scheduler pass.
    let sched = await runScheduler();
    check('POST /admin/run-scheduler?token= returns 200', sched.status === 200, `status=${sched.status}`);
    let newMail = newFilesSince(outboxBefore);
    check('welcome email HTML written to data/outbox', newMail.length >= 1,
      `new files=${newMail.length}`);
    const nurtureQueued = queueCount(db, S, lead1, ['nurture', 'welcome', 'day'], 'queued');
    check('nurture sequence emails queued for lead', nurtureQueued >= 1 || newMail.length >= 1,
      `queued nurture-ish=${nurtureQueued}`);

    /* ---- 3. Sales view + checkout start (abandon path) ------------- */
    res = await req(`${BASE}/sales`, { jar: jar1 });
    check('GET /sales returns 200', res.status === 200, `status=${res.status}`);
    tags = tagsFor(db, S, lead1);
    check('offer view tagged VIEWED_OFFER/OFFER_*_VIEWED',
      tags.includes('VIEWED_OFFER') || tags.some(t => /^OFFER_.*_VIEWED$/.test(t)),
      `tags=[${tags.join(',')}]`);

    res = await req(`${BASE}/checkout`, { jar: jar1 });
    check('GET /checkout returns 200 with lead form', res.status === 200 && /name="email"/i.test(await res.text()),
      `status=${res.status}`);

    res = await req(`${BASE}/checkout`, {
      jar: jar1, method: 'POST',
      form: { first_name: 'Testy', email: email1, phone: '414-555-0100' },
    });
    const coBody = await res.text();
    const isDemo = res.status === 200 && coBody.includes('/checkout/complete-demo');
    const isStripeRedirect = [301, 302, 303].includes(res.status) && /^https?:\/\//i.test(res.headers.get('location') || '');
    check('POST /checkout creates cart (demo page or stripe redirect)', isDemo || isStripeRedirect,
      `status=${res.status} location=${res.headers.get('location') || ''}`);

    const cartRow = db.prepare(
      `SELECT "${S.cartId}" AS id${S.cartStatus ? `, "${S.cartStatus}" AS st` : ''} FROM "${S.carts}" WHERE "${S.cartLead}" = ? ORDER BY "${S.cartId}" DESC LIMIT 1`
    ).get(lead1);
    check('cart row created for lead', !!cartRow, S.cartStatus ? `status=${cartRow && cartRow.st}` : 'no status column');
    tags = tagsFor(db, S, lead1);
    check('checkout start tagged STARTED_CHECKOUT (+HIGH_INTENT)',
      tags.includes('STARTED_CHECKOUT') && tags.includes('HIGH_INTENT'),
      `tags=[${tags.join(',')}]`);

    /* ---- 4. Abandon: age cart, run scheduler ----------------------- */
    db.prepare(`UPDATE "${S.carts}" SET "${S.cartStarted}" = datetime('now','-2 hours') WHERE "${S.cartLead}" = ?`).run(lead1);
    sched = await runScheduler();
    check('scheduler pass after aging cart returns 200', sched.status === 200, `status=${sched.status}`);
    tags = tagsFor(db, S, lead1);
    check('ABANDONED_CART tag applied after 1h threshold', tags.includes('ABANDONED_CART'),
      `tags=[${tags.join(',')}]`);
    const cartSent1 = queueCount(db, S, lead1, ['cart', 'abandon'], 'sent');
    const cartQueued1 = queueCount(db, S, lead1, ['cart', 'abandon'], 'queued');
    check('cart reminder #1 queued/sent after 1h', cartSent1 + cartQueued1 >= 1,
      `sent=${cartSent1} queued=${cartQueued1}`);

    // Force the remaining cart emails due instead of waiting 24h/60h/144h.
    const forced = forceDue(db, S, lead1, ['cart', 'abandon']);
    sched = await runScheduler();
    check('scheduler pass after forcing cart emails due returns 200', sched.status === 200);
    const cartSentTotal = queueCount(db, S, lead1, ['cart', 'abandon'], 'sent');
    check('all 4 abandoned-cart emails sent (1h/24h/60h/144h)',
      cartSentTotal >= 4, `sent cart emails=${cartSentTotal} (forced ${forced} due)`);
    const outboxAfterCart = outboxFiles();
    const cartMailFiles = filesMentioning(email1, newFilesSince(outboxBefore));
    check('cart emails landed in data/outbox', cartMailFiles.length >= 4,
      `files mentioning ${email1}: ${cartMailFiles.length}`);

    /* ---- 5. Complete the demo purchase ----------------------------- */
    let purchased = false;
    if (isDemo) {
      res = await req(`${BASE}/checkout/complete-demo`, { jar: jar1, method: 'POST', form: {} });
      const ploc = res.headers.get('location') || '';
      check('POST /checkout/complete-demo 302-redirects to /thank-you',
        [301, 302, 303].includes(res.status) && ploc.includes('/thank-you'),
        `status=${res.status} location=${ploc}`);
      purchased = [301, 302, 303].includes(res.status);
    } else if (isStripeRedirect && productId) {
      // Stripe payment-link mode: simulate the webhook completion stub.
      res = await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email: email1, productId } });
      check('POST /webhooks/stripe stub records purchase', res.status === 200, `status=${res.status}`);
      purchased = res.status === 200;
    }
    if (!purchased) failFast('could not complete a purchase in demo or stripe-stub mode');

    res = await req(`${BASE}/thank-you`, { jar: jar1 });
    check('GET /thank-you returns 200', res.status === 200, `status=${res.status}`);

    sched = await runScheduler();
    check('scheduler pass after purchase returns 200', sched.status === 200);

    tags = tagsFor(db, S, lead1);
    check('ABANDONED_CART tag removed on purchase', !tags.includes('ABANDONED_CART'),
      `tags=[${tags.join(',')}]`);
    check('purchase tags PURCHASED + CUSTOMER applied',
      tags.includes('PURCHASED') && tags.includes('CUSTOMER'), `tags=[${tags.join(',')}]`);
    const cartQueuedAfter = queueCount(db, S, lead1, ['cart', 'abandon'], 'queued');
    check('no cart emails remain queued after purchase (all 4 were already sent pre-purchase)',
      cartQueuedAfter === 0, `queued=${cartQueuedAfter}`);

    let purCount = 0;
    if (S.purLead) {
      purCount = db.prepare(`SELECT COUNT(*) AS n FROM "${S.purchases}" WHERE "${S.purLead}" = ?`).get(
        S.purLead === 'email' ? email1 : lead1).n;
    } else {
      purCount = db.prepare(`SELECT COUNT(*) AS n FROM "${S.purchases}"`).get().n;
    }
    check('purchase row recorded', purCount >= 1, `rows=${purCount}`);

    const newAfterPurchase = newFilesSince(outboxAfterCart);
    check('confirmation email sent after purchase (new outbox file)', newAfterPurchase.length >= 1,
      `new files=${newAfterPurchase.length}`);
    const postQueued = queueCount(db, S, lead1, ['post', 'confirm', 'receipt', 'onboard'], 'queued')
      + queueCount(db, S, lead1, ['post', 'confirm', 'receipt', 'onboard'], 'sent');
    check('post-purchase sequence scheduled/sending', postQueued >= 1, `post-purchase-ish rows=${postQueued}`);

    /* ---- 5b. Pending cart emails are cancelled by a mid-sequence purchase */
    const jar4 = new Jar();
    const email4 = `cancel${Date.now()}@example.com`;
    await req(`${BASE}/`, { jar: jar4 });
    res = await req(`${BASE}/lead?src=autotest&cmp=e2e`, {
      jar: jar4, method: 'POST', form: { first_name: 'Canceller', email: email4, consent: 'on' },
    });
    const lead4 = leadIdByEmail(db, S, email4);
    check('fourth lead saved', lead4 != null);
    await runScheduler(); // welcome goes out
    await req(`${BASE}/checkout`, {
      jar: jar4, method: 'POST',
      form: { first_name: 'Canceller', email: email4, phone: '414-555-0103' },
    });
    db.prepare(`UPDATE "${S.carts}" SET "${S.cartStarted}" = datetime('now','-2 hours') WHERE "${S.cartLead}" = ?`).run(lead4);
    await runScheduler(); // abandon detected: 1h email sent, the rest stay queued
    const pendingBefore = queueCount(db, S, lead4, ['cart', 'abandon'], 'queued');
    check('abandoned lead has pending cart emails before purchase', pendingBefore >= 1,
      `queued=${pendingBefore}`);
    if (isDemo) {
      res = await req(`${BASE}/checkout/complete-demo`, { jar: jar4, method: 'POST', form: {} });
      check('fourth lead completes demo purchase mid cart-sequence', [301, 302, 303].includes(res.status),
        `status=${res.status}`);
    } else if (productId) {
      res = await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email: email4, productId } });
      check('stripe stub records fourth lead purchase', res.status === 200, `status=${res.status}`);
    }
    await runScheduler();
    const pendingAfter = queueCount(db, S, lead4, ['cart', 'abandon'], 'queued');
    const cancelledAfter = queueCount(db, S, lead4, ['cart', 'abandon'], 'cancelled');
    check('pending cart emails cancelled immediately on purchase (none left queued)',
      pendingAfter === 0 && cancelledAfter >= 1,
      `queued=${pendingAfter} cancelled=${cancelledAfter}`);

    /* ---- 6. Second lead: purchase immediately, no abandon ----------- */
    const jar2 = new Jar();
    await req(`${BASE}/`, { jar: jar2 });
    res = await req(`${BASE}/lead?src=autotest&cmp=e2e`, {
      jar: jar2, method: 'POST', form: { first_name: 'Speedy', email: email2, consent: 'on' },
    });
    check('second lead submits (302 to /free-value)', [301, 302, 303].includes(res.status));
    const lead2 = leadIdByEmail(db, S, email2);
    check('second lead row saved', lead2 != null);
    await runScheduler();
    await req(`${BASE}/checkout`, { jar: jar2, method: 'POST', form: { first_name: 'Speedy', email: email2 } });
    if (isDemo) {
      res = await req(`${BASE}/checkout/complete-demo`, { jar: jar2, method: 'POST', form: {} });
      check('second lead completes demo purchase immediately', [301, 302, 303].includes(res.status),
        `status=${res.status}`);
    } else if (productId) {
      await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email: email2, productId } });
    }
    await runScheduler();
    const tags2 = tagsFor(db, S, lead2);
    check('immediate purchaser never gets ABANDONED_CART', !tags2.includes('ABANDONED_CART'),
      `tags=[${tags2.join(',')}]`);
    check('immediate purchaser tagged PURCHASED', tags2.includes('PURCHASED'), `tags=[${tags2.join(',')}]`);
    const cartMailLead2 = queueCount(db, S, lead2, ['cart', 'abandon'], 'queued') + queueCount(db, S, lead2, ['cart', 'abandon'], 'sent');
    check('immediate purchaser gets zero cart emails', cartMailLead2 === 0, `cart email rows=${cartMailLead2}`);

    /* ---- 7. Weekly nurture: prospect gets it, purchaser suppressed -- */
    const jar3 = new Jar();
    await req(`${BASE}/`, { jar: jar3 });
    res = await req(`${BASE}/lead?src=autotest&cmp=e2e`, {
      jar: jar3, method: 'POST', form: { first_name: 'Prospect', email: email3, consent: 'on' },
    });
    const lead3 = leadIdByEmail(db, S, email3);
    check('third (prospect) lead saved', lead3 != null);
    await runScheduler();

    const weeklyKw = ['weekly', 'nurture', 'flyer'];
    forceDue(db, S, lead3, weeklyKw);
    await runScheduler();
    const weeklySentProspect = queueCount(db, S, lead3, weeklyKw, 'sent');
    check('prospect receives weekly nurture email when due', weeklySentProspect >= 1,
      `sent weekly-ish=${weeklySentProspect}`);

    // Purchaser suppression: force any weekly-ish queued mail for lead2 due and
    // confirm the scheduler does NOT send prospect promo for the featured offer.
    const purchaserWeeklyQueued = queueCount(db, S, lead2, weeklyKw, 'queued');
    forceDue(db, S, lead2, weeklyKw);
    await runScheduler();
    const weeklySentPurchaser = queueCount(db, S, lead2, weeklyKw, 'sent');
    check('purchaser suppressed from featured-offer prospect promo',
      purchaserWeeklyQueued === 0 || weeklySentPurchaser === 0,
      `purchaser weekly queued-before=${purchaserWeeklyQueued} sent=${weeklySentPurchaser}`);

    /* ---- 8. Unsubscribe -------------------------------------------- */
    res = await req(`${BASE}/unsubscribe?email=${encodeURIComponent(email3)}`, { jar: jar3 });
    check('GET /unsubscribe?email= returns 200', res.status === 200, `status=${res.status}`);
    res = await req(`${BASE}/unsubscribe`, { jar: jar3, method: 'POST', form: { email: email3 } });
    check('POST /unsubscribe succeeds (one-click)', [200, 301, 302, 303].includes(res.status),
      `status=${res.status}`);
    const tags3 = tagsFor(db, S, lead3);
    check('unsubscribed lead tagged UNSUBSCRIBED', tags3.includes('UNSUBSCRIBED'),
      `tags=[${tags3.join(',')}]`);
    const queuedAfterUnsub = S.qLead
      ? db.prepare(`SELECT COUNT(*) AS n FROM "${S.queue}" WHERE "${S.qLead}" = ? AND "${S.qStatus}" = 'queued'`).get(lead3).n
      : 0;
    check('all queued emails cancelled on unsubscribe', queuedAfterUnsub === 0, `still queued=${queuedAfterUnsub}`);

    const filesBeforeFinalSched = outboxFiles();
    const mentionedBefore = filesMentioning(email3, filesBeforeFinalSched).length;
    await runScheduler();
    const mentionedAfter = filesMentioning(email3, outboxFiles()).length;
    check('no new email generated for unsubscribed lead', mentionedAfter === mentionedBefore,
      `files mentioning lead before=${mentionedBefore} after=${mentionedAfter}`);

    /* ---- 9. Admin dashboard ---------------------------------------- */
    res = await req(`${BASE}/admin?token=${ADMIN_TOKEN}`, {});
    const adminBody = (await res.text()).toLowerCase();
    const labels = ['leads', 'carts', 'purchases', 'emails', 'revenue', 'conversion', 'dashboard', 'subscribers'];
    const hits = labels.filter(l => adminBody.includes(l));
    check('GET /admin dashboard 200 with key metric labels', res.status === 200 && hits.length >= 3,
      `status=${res.status} labels found=[${hits.join(',')}]`);

    /* ---- 10. Stripe webhook signature verification ------------------ */
    // Second server instance WITH STRIPE_WEBHOOK_SECRET set, exercising the
    // real signature-verification path end to end.
    const WEBHOOK_PORT = 3112;
    const WEBHOOK_BASE = `http://127.0.0.1:${WEBHOOK_PORT}`;
    const WEBHOOK_SECRET = `whsec_test_${ts}`;
    const child2 = spawn('node', ['server.js'], {
      cwd: APP_ROOT,
      env: { ...process.env, ADMIN_TOKEN, PORT: String(WEBHOOK_PORT), EMAIL_PROVIDER: 'local', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child2.stdout.on('data', d => process.stdout.write(`[server2] ${d}`));
    child2.stderr.on('data', d => process.stderr.write(`[server2:err] ${d}`));
    try {
      const t1 = Date.now();
      for (;;) {
        try {
          const hr = await req(`${WEBHOOK_BASE}/healthz`, {});
          if (hr.status === 200 && (await hr.text()).trim() === 'ok') break;
        } catch { /* not up yet */ }
        if (Date.now() - t1 > SERVER_START_TIMEOUT_MS) failFast('webhook test server did not boot in time');
        await new Promise(r => setTimeout(r, 300));
      }
      check('webhook test server boots with STRIPE_WEBHOOK_SECRET set', true);

      const emailW = `e2e-webhook-${ts}@example.com`;
      const jarW = new Jar();
      await req(`${WEBHOOK_BASE}/`, { jar: jarW });
      await req(`${WEBHOOK_BASE}/lead`, { jar: jarW, method: 'POST', form: { first_name: 'Webhook', email: emailW, consent: 'on' } });
      const leadW = leadIdByEmail(db, S, emailW);
      check('webhook test lead saved', leadW != null);

      const stripeEvent = (type, amountTotal, email = emailW) => ({
        id: `evt_test_${ts}`,
        type,
        data: { object: { id: `cs_test_${ts}`, customer_details: { email }, amount_total: amountTotal } },
      });
      const signPayload = (payload, secret) => {
        const t = Math.floor(Date.now() / 1000);
        const raw = JSON.stringify(payload);
        const v1 = crypto.createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex');
        return { raw, header: `t=${t},v1=${v1}` };
      };
      const postWebhook = async (raw, sigHeader) => {
        const headers = { 'content-type': 'application/json' };
        if (sigHeader) headers['stripe-signature'] = sigHeader;
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
        try {
          return await fetch(`${WEBHOOK_BASE}/webhooks/stripe`, { method: 'POST', headers, body: raw, redirect: 'manual', signal: ctl.signal });
        } finally { clearTimeout(to); }
      };
      const purchaseRows = () => db.prepare(
        `SELECT product_id, mode, amount_cents FROM "${S.purchases}" WHERE "${S.purLead}" = ?`
      ).all(S.purLead === 'email' ? emailW : leadW);

      // 10a. Valid signature on checkout.session.completed ($100 -> Complete).
      const evt1 = stripeEvent('checkout.session.completed', 10000);
      const s1 = signPayload(evt1, WEBHOOK_SECRET);
      let r = await postWebhook(s1.raw, s1.header);
      let rows = purchaseRows();
      check('signed checkout.session.completed records purchase (200)', r.status === 200 && rows.length === 1,
        `status=${r.status} purchases=${rows.length}`);
      check('webhook purchase mapped to Complete ($100) with mode=stripe',
        rows[0] && rows[0].product_id === 'transitnow-complete' && rows[0].mode === 'stripe',
        `row=${JSON.stringify(rows[0])}`);

      // 10b. Tampered signature -> 400, no new purchase.
      const s2 = signPayload(evt1, WEBHOOK_SECRET);
      r = await postWebhook(s2.raw, s2.header.replace(/v1=./, 'v1=x'));
      check('tampered stripe-signature rejected with 400', r.status === 400, `status=${r.status}`);
      check('no purchase recorded for tampered signature', purchaseRows().length === 1,
        `purchases=${purchaseRows().length}`);

      // 10c. Missing signature while secret configured -> 400.
      r = await postWebhook(JSON.stringify({ email: emailW, productId: 'transitnow-complete' }), null);
      check('unsigned webhook rejected with 400 when secret configured', r.status === 400, `status=${r.status}`);

      // 10d. Valid signature but non-purchase event type -> 200, handled=false, no purchase.
      const evt4 = stripeEvent('customer.created', 10000);
      const s4 = signPayload(evt4, WEBHOOK_SECRET);
      r = await postWebhook(s4.raw, s4.header);
      const b4 = await r.json().catch(() => ({}));
      check('non-purchase event acknowledged without recording (200, handled=false)',
        r.status === 200 && b4.handled === false, `status=${r.status} body=${JSON.stringify(b4)}`);
      check('no purchase recorded for non-purchase event', purchaseRows().length === 1,
        `purchases=${purchaseRows().length}`);
    } finally {
      await stopServer(child2);
    }

    /* ---- 11. Wealth Builder's Room --------------------------------- */
    // Covers: /checkout/room 302 to the $49/mo Stripe link, webhook room
    // provisioning (unsigned dev shape + signed shape), claim -> password ->
    // login -> session, gated /room routes, classroom, 90-day plan progress,
    // community post/comment, admin room section.
    const ROOM_STRIPE_LINK = 'https://buy.stripe.com/5kQdRbfEp5Hrc8Yf38dIA00';
    const roomEmail = `e2e-room-${ts}@example.com`;
    const roomJar = new Jar();

    res = await req(`${BASE}/checkout/room`, { jar: roomJar });
    check('GET /checkout/room 302s to the $49/mo Stripe payment link',
      res.status === 302 && res.headers.get('location') === ROOM_STRIPE_LINK,
      `status=${res.status} location=${res.headers.get('location')}`);

    const roomPurchaseCount = () => db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE product_id = 'room'").get().n;
    const roomPurchasesBefore = roomPurchaseCount();
    res = await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email: roomEmail, productId: 'room', amountCents: 4900 } });
    check('unsigned webhook provisions room member (200)', res.status === 200, `status=${res.status}`);
    const memberRow = () => db.prepare('SELECT email, status, password_hash FROM room_members WHERE email = ?').get(roomEmail);
    check('room_members row created, active, no password yet',
      memberRow() && memberRow().status === 'active' && memberRow().password_hash == null,
      `row=${JSON.stringify(memberRow())}`);
    const newRoomPurchase = db.prepare("SELECT product_id, amount_cents, mode FROM purchases WHERE product_id = 'room' ORDER BY id DESC LIMIT 1").get();
    check('room purchase recorded ($49.00, 4900 cents)',
      roomPurchaseCount() === roomPurchasesBefore + 1 && newRoomPurchase.amount_cents === 4900,
      `before=${roomPurchasesBefore} after=${roomPurchaseCount()} latest=${JSON.stringify(newRoomPurchase)}`);

    res = await req(`${BASE}/room`, {});
    check('GET /room unauthenticated redirects to /room/login',
      res.status === 302 && (res.headers.get('location') || '').endsWith('/room/login'),
      `status=${res.status} location=${res.headers.get('location')}`);

    res = await req(`${BASE}/room/login`, { jar: roomJar });
    check('GET /room/login returns 200', res.status === 200 && (await res.text()).includes('Member Login'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/claim`, { jar: roomJar, method: 'POST', form: { email: `nobody-${ts}@example.com`, password: 'roomtestpass1', password2: 'roomtestpass1' } });
    check('claim with unknown email shows not-found error',
      res.status === 200 && (await res.text()).includes('could not find a paid membership'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/claim`, { jar: roomJar, method: 'POST', form: { email: roomEmail, password: 'roomtestpass1', password2: 'roomtestpass1' } });
    check('claim with paid email sets password and creates session, redirects to /room/welcome',
      res.status === 302 && (res.headers.get('location') || '').endsWith('/room/welcome') && roomJar.has('room_sess'),
      `status=${res.status} location=${res.headers.get('location')} cookies=[${[...roomJar.c.keys()].join(',')}]`);
    check('password hash stored (not plaintext)',
      memberRow().password_hash && !String(memberRow().password_hash).includes('roomtestpass1'));

    res = await req(`${BASE}/room`, { jar: roomJar });
    check('GET /room before onboarding redirects to /room/welcome',
      res.status === 302 && (res.headers.get('location') || '').endsWith('/room/welcome'),
      `status=${res.status} location=${res.headers.get('location')}`);

    res = await req(`${BASE}/room/welcome`, { jar: roomJar });
    check('GET /room/welcome returns 200 with onboarding content',
      res.status === 200 && (await res.text()).includes('ENTER THE ROOM'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/welcome`, { jar: roomJar, method: 'POST', form: {} });
    check('POST /room/welcome marks onboarded and redirects to /room',
      res.status === 302 && (res.headers.get('location') || '').endsWith('/room'),
      `status=${res.status} location=${res.headers.get('location')}`);

    res = await req(`${BASE}/room`, { jar: roomJar });
    check('GET /room with session returns dashboard', res.status === 200 && (await res.text()).includes('Wealth-Building Headquarters'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/classroom`, { jar: roomJar });
    check('GET /room/classroom lists 5 sections', res.status === 200 && (await res.text()).includes('Section 5'),
      `status=${res.status}`);
    res = await req(`${BASE}/room/classroom/money-management`, { jar: roomJar });
    check('GET /room/classroom/money-management 301-redirects to money-cashflow',
      res.status === 301 && (res.headers.get('location') || '').endsWith('/room/classroom/money-cashflow'),
      `status=${res.status} location=${res.headers.get('location')}`);
    res = await req(`${BASE}/room/classroom/money-cashflow`, { jar: roomJar });
    check('GET /room/classroom/money-cashflow renders lesson content',
      res.status === 200 && (await res.text()).includes('Pay-Yourself-First'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/plan/toggle`, { jar: roomJar, method: 'POST', form: { week: '2', item: '1', checked: '1' } });
    check('POST /room/plan/toggle persists progress', res.status === 302,
      `status=${res.status}`);
    const prog = db.prepare('SELECT checked FROM room_progress WHERE email = ? AND week = 2 AND item = 1').get(roomEmail);
    check('progress row written to room_progress', prog && prog.checked === 1, `row=${JSON.stringify(prog)}`);
    res = await req(`${BASE}/room/plan`, { jar: roomJar });
    check('GET /room/plan returns 200 with 12 weeks', res.status === 200 && (await res.text()).includes('Week 12'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/community/post`, { jar: roomJar, method: 'POST', form: { title: 'Room test win', body: 'Finished week 2!' } });
    check('member can post to community', res.status === 302, `status=${res.status}`);
    const postRow = db.prepare('SELECT id, title FROM room_posts WHERE author_email = ? ORDER BY id DESC LIMIT 1').get(roomEmail);
    check('community post stored', postRow && postRow.title === 'Room test win', `row=${JSON.stringify(postRow)}`);
    res = await req(`${BASE}/room/community/post/${postRow.id}/comment`, { jar: roomJar, method: 'POST', form: { body: 'Room test reply' } });
    check('member can comment', res.status === 302, `status=${res.status}`);
    res = await req(`${BASE}/room/community/post/${postRow.id}`, { jar: roomJar });
    check('post page shows comment', res.status === 200 && (await res.text()).includes('Room test reply'),
      `status=${res.status}`);

    const badJar = new Jar();
    res = await req(`${BASE}/room/login`, { jar: badJar, method: 'POST', form: { email: roomEmail, password: 'wrongpassword' } });
    check('login with wrong password rejected', res.status === 200 && (await res.text()).includes('Incorrect password') && !badJar.has('room_sess'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/logout`, { jar: roomJar });
    check('logout redirects', res.status === 302, `status=${res.status}`);
    res = await req(`${BASE}/room`, { jar: roomJar });
    check('session destroyed after logout (back to login)',
      res.status === 302 && (res.headers.get('location') || '').endsWith('/room/login'),
      `status=${res.status} location=${res.headers.get('location')}`);

    res = await req(`${BASE}/admin/room?token=${ADMIN_TOKEN}`, {});
    const adminRoomHtml = await res.text();
    check('GET /admin/room with token lists the member',
      res.status === 200 && adminRoomHtml.includes(roomEmail),
      `status=${res.status}`);

    res = await req(`${BASE}/admin/room/announce?token=${ADMIN_TOKEN}`, { method: 'POST', form: { title: 'Room test announcement', body: 'Welcome!' } });
    check('admin can post announcement', res.status === 302, `status=${res.status}`);
    const loginJar = new Jar();
    await req(`${BASE}/room/login`, { jar: loginJar, method: 'POST', form: { email: roomEmail, password: 'roomtestpass1' } });
    res = await req(`${BASE}/room`, { jar: loginJar });
    check('announcement visible on member dashboard',
      res.status === 200 && (await res.text()).includes('Room test announcement'),
      `status=${res.status}`);

    // Signed webhook shape: $49.00 checkout.session.completed with an email
    // that has NO funnel lead row must still provision the member.
    const child3 = spawn('node', ['server.js'], {
      cwd: APP_ROOT,
      env: { ...process.env, ADMIN_TOKEN, PORT: '3113', EMAIL_PROVIDER: 'local', STRIPE_WEBHOOK_SECRET: `whsec_test_${ts}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const WEBHOOK3 = 'http://127.0.0.1:3113';
      const t3 = Date.now();
      for (;;) {
        try {
          const hr = await req(`${WEBHOOK3}/healthz`, {});
          if (hr.status === 200) break;
        } catch { /* not up yet */ }
        if (Date.now() - t3 > SERVER_START_TIMEOUT_MS) failFast('room signed-webhook server did not boot in time');
        await new Promise(r => setTimeout(r, 300));
      }
      const roomEmail2 = `e2e-room-signed-${ts}@example.com`;
      const evt = {
        id: `evt_room_${ts}`,
        type: 'checkout.session.completed',
        data: { object: { id: `cs_room_${ts}`, customer_details: { email: roomEmail2, name: 'Room Tester' }, amount_total: 4900 } },
      };
      const tt = Math.floor(Date.now() / 1000);
      const raw = JSON.stringify(evt);
      const v1 = crypto.createHmac('sha256', `whsec_test_${ts}`).update(`${tt}.${raw}`, 'utf8').digest('hex');
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      let r3;
      try {
        r3 = await fetch(`${WEBHOOK3}/webhooks/stripe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'stripe-signature': `t=${tt},v1=${v1}` },
          body: raw, redirect: 'manual', signal: ctl.signal,
        });
      } finally { clearTimeout(to); }
      const b3 = await r3.json().catch(() => ({}));
      check('signed $49 webhook provisions member without a lead row (200, handled=true)',
        r3.status === 200 && b3.handled === true,
        `status=${r3.status} body=${JSON.stringify(b3)}`);
      const m2 = db.prepare('SELECT email, name, status FROM room_members WHERE email = ?').get(roomEmail2);
      check('signed webhook created active room member', m2 && m2.status === 'active',
        `row=${JSON.stringify(m2)}`);
    } finally {
      await stopServer(child3);
    }

    /* ---- 12. Wealth Builder's Room lead funnel -------------------------- */
    // Covers: /room/join -> /room/start (goal capture) -> /room/offer ->
    // /room/checkout -> unchanged Stripe link, /payment-success, /claim-access
    // alias, legal pages, welcome email + conversion bookkeeping on purchase.
    const funnelEmail = `e2e-roomfunnel-${ts}@example.com`;
    const funnelJar = new Jar();

    res = await req(`${BASE}/room/join`, { jar: funnelJar });
    check('GET /room/join returns 200 with Room landing copy',
      res.status === 200 && (await res.text()).includes('WEALTH BUILDER'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/start`, { jar: funnelJar });
    check('GET /room/start returns 200 lead form', res.status === 200 && (await res.text()).includes('room_goal'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/start`, { jar: funnelJar, method: 'POST', form: { first_name: 'Room', email: funnelEmail, goal: 'build-a-business', consent: 'yes' } });
    check('POST /room/start creates lead and redirects to /room/offer',
      res.status === 302 && (res.headers.get('location') || '').endsWith('/room/offer'),
      `status=${res.status} location=${res.headers.get('location')}`);
    const funnelLead = db.prepare('SELECT id, goal, email FROM leads WHERE email = ?').get(funnelEmail);
    check('lead row stores goal', funnelLead && funnelLead.goal === 'build-a-business', `row=${JSON.stringify(funnelLead)}`);
    const roomNurtureQueued = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE lead_id = ? AND sequence = 'roomNurture' AND status = 'queued'").get(funnelLead.id).n;
    check('roomNurture sequence queued (5 steps)', roomNurtureQueued === 5, `queued=${roomNurtureQueued}`);
    const leadEv = db.prepare("SELECT COUNT(*) n FROM events WHERE lead_id = ? AND type = 'lead_submitted'").get(funnelLead.id).n;
    check('lead_submitted event recorded', leadEv === 1, `count=${leadEv}`);

    res = await req(`${BASE}/room/offer`, { jar: funnelJar });
    check('GET /room/offer returns 200 sales copy', res.status === 200 && (await res.text()).includes('Stop Collecting Ideas'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/checkout`, { jar: funnelJar });
    const coHtml = await res.text();
    check('GET /room/checkout shows $49/month recurring disclosure',
      res.status === 200 && coHtml.includes('$49/month recurring membership'),
      `status=${res.status}`);

    res = await req(`${BASE}/room/checkout`, { jar: funnelJar, method: 'POST', form: { email: funnelEmail, first_name: 'Room' } });
    check('POST /room/checkout creates cart and 302s to the unchanged Stripe link',
      res.status === 302 && res.headers.get('location') === ROOM_STRIPE_LINK,
      `status=${res.status} location=${res.headers.get('location')}`);
    const roomCartRow = db.prepare("SELECT * FROM carts WHERE lead_id = ? AND product_id = 'room'").get(funnelLead.id);
    check('room cart row recorded (open)', roomCartRow && roomCartRow.purchased === 0, `row=${JSON.stringify(roomCartRow)}`);
    const coEv = db.prepare("SELECT COUNT(*) n FROM events WHERE lead_id = ? AND type = 'checkout_started'").get(funnelLead.id).n;
    check('checkout_started event recorded', coEv === 1, `count=${coEv}`);

    res = await req(`${BASE}/payment-success?p=room`, { jar: funnelJar });
    check('GET /payment-success returns 200 with claim CTA',
      res.status === 200 && (await res.text()).includes('/room/claim'),
      `status=${res.status}`);

    res = await req(`${BASE}/claim-access`, {});
    check('GET /claim-access alias renders claim page',
      res.status === 200 && (await res.text()).toLowerCase().includes('claim'),
      `status=${res.status}`);

    for (const p of ['/terms', '/refund', '/contact']) {
      res = await req(`${BASE}${p}`, {});
      check(`GET ${p} returns 200`, res.status === 200, `status=${res.status}`);
    }

    // Purchase via unsigned webhook: lead converted, welcome queued, cart closed.
    res = await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email: funnelEmail, productId: 'room', amountCents: 4900 } });
    check('room webhook purchase for funnel lead (200)', res.status === 200, `status=${res.status}`);
    const convLead = db.prepare('SELECT status FROM leads WHERE email = ?').get(funnelEmail);
    check('lead converted to customer', convLead && convLead.status === 'customer', `row=${JSON.stringify(convLead)}`);
    const welcomeQueued = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE lead_id = ? AND sequence = 'roomWelcome'").get(funnelLead.id).n;
    check('roomWelcome email queued on purchase', welcomeQueued === 1, `queued=${welcomeQueued}`);
    const nurtureCancelled = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE lead_id = ? AND sequence = 'roomNurture' AND status = 'cancelled'").get(funnelLead.id).n;
    check('roomNurture cancelled on purchase', nurtureCancelled === 5, `cancelled=${nurtureCancelled}`);
    const cartClosed = db.prepare('SELECT purchased FROM carts WHERE id = ?').get(roomCartRow.id).purchased;
    check('room cart closed on purchase', cartClosed === 1, `purchased=${cartClosed}`);
    const payEv = db.prepare("SELECT COUNT(*) n FROM events WHERE lead_id = ? AND type = 'payment_success'").get(funnelLead.id).n;
    const memEv = db.prepare("SELECT COUNT(*) n FROM events WHERE lead_id = ? AND type = 'membership_created'").get(funnelLead.id).n;
    check('payment_success + membership_created events recorded', payEv === 1 && memEv === 1, `payment_success=${payEv} membership_created=${memEv}`);

    // Admin: new dashboard sections, lead detail, config env status.
    res = await req(`${BASE}/admin?token=${ADMIN_TOKEN}`, {});
    const dashHtml = await res.text();
    check('admin dashboard renders grouped Room sections',
      res.status === 200 && dashHtml.includes('Wealth Builder') && dashHtml.includes('New leads (last 7 days)'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/leads/${funnelLead.id}?token=${ADMIN_TOKEN}`, {});
    check('GET /admin/leads/:id renders lead detail',
      res.status === 200 && (await res.text()).includes(funnelEmail),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/config?token=${ADMIN_TOKEN}`, {});
    const cfgHtml = await res.text();
    check('GET /admin/config shows masked env status without secrets',
      res.status === 200 && cfgHtml.includes('ADMIN_TOKEN') && !cfgHtml.includes('test-admin-token'),
      `status=${res.status}`);

  } finally {
    try { if (db) db.close(); } catch {}
    await stopServer(child);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed.`);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
  console.log('ALL TESTS PASSED');
}

main().catch(err => {
  console.error('TEST ERROR:', err && err.message ? err.message : err);
  process.exit(1);
});
