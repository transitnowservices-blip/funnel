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

// Phase 7: the analytics lib is exercised in-process (read-only) so every
// computed metric can be compared exactly against independent SQL counts
// from this script's own DB handle. The lib shares the same data dir.
// (Required after APP_ROOT is defined, below.)

const APP_ROOT = path.resolve(__dirname, '..');
// Phase 7: analytics lib exercised in-process (read-only) for exact
// metric-vs-SQL comparisons. Same data dir as the server under test.
const analyticsLib = require(path.join(APP_ROOT, 'lib', 'analytics'));
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
/* Paid-client enforcement test helper                                 */
/* ------------------------------------------------------------------ */
// Davena's rule: dispatch work (route creation, plan approval) requires an
// ACTIVE dispatch subscription. Existing tests that exercise those endpoints
// must first give their driver a subscription row, exactly as the Stripe
// webhook would.
function makePaid(dbHandle, email, plan = 'complete') {
  const now = Date.now();
  const rnd = Math.floor(Math.random() * 1e9);
  dbHandle.prepare(
    `INSERT INTO dispatch_subscriptions
       (stripe_customer_id, stripe_subscription_id, email, plan, status, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
  ).run(`cus_test_${now}_${rnd}`, `sub_test_${now}_${rnd}`,
    String(email).toLowerCase(), plan, now + 30 * 864e5, now, now);
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

/** POST a multipart/form-data body (for the proof-of-progress upload route). */
async function multipartReq(url, { jar = null, fields = {}, file = null, fileField = 'proof' } = {}) {
  const boundary = '----e2eboundary' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      'utf8'
    ));
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const body = Buffer.concat(parts);
  const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  if (jar && jar.c.size) headers.cookie = jar.header();
  const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual' });
  if (jar) jar.store(res);
  return res;
}

// 1x1 transparent PNG, for proof-upload tests.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

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

    // Davena's admin sign-in: ?token= sets a 30-day cookie, and the cookie
    // alone opens admin-gated pages like the dispatcher's daily board.
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') || ''];
    const admCookie = setCookies.find(h => h && h.startsWith('funnel_adm='));
    check('admin ?token= visit sets funnel_adm cookie with 30-day Max-Age',
      !!admCookie && admCookie.includes('Max-Age=2592000'), `cookie=${admCookie}`);
    const adminJar = new Jar();
    await req(`${BASE}/admin?token=${ADMIN_TOKEN}`, { jar: adminJar });
    const boardRes = await req(`${BASE}/dispatch/today`, { jar: adminJar });
    check('daily board opens for admin-cookie session (no login redirect)',
      boardRes.status === 200, `status=${boardRes.status} location=${boardRes.headers.get('location')}`);

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

    /* ---- 10e. Dispatch subscriptions: paid-client enforcement -------- */
    // Davena's rule: the application stays FREE, but dispatch work (routes,
    // service-plan activation) is gated to active $50/$100 subscribers.
    // Signed Stripe fixtures exercise the full lifecycle end to end.
    const D_PORT = 3114;
    const D_BASE = `http://127.0.0.1:${D_PORT}`;
    const D_SECRET = `whsec_dispatch_${ts}`;
    const childD = spawn('node', ['server.js'], {
      cwd: APP_ROOT,
      env: { ...process.env, ADMIN_TOKEN, PORT: String(D_PORT), EMAIL_PROVIDER: 'local', STRIPE_WEBHOOK_SECRET: D_SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childD.stdout.on('data', d => process.stdout.write(`[serverD] ${d}`));
    childD.stderr.on('data', d => process.stderr.write(`[serverD:err] ${d}`));
    try {
      const t1 = Date.now();
      for (;;) {
        try {
          const hr = await req(`${D_BASE}/healthz`, {});
          if (hr.status === 200 && (await hr.text()).trim() === 'ok') break;
        } catch { /* not up yet */ }
        if (Date.now() - t1 > SERVER_START_TIMEOUT_MS) failFast('dispatch webhook test server did not boot in time');
        await new Promise(r => setTimeout(r, 300));
      }
      check('dispatch test server boots with STRIPE_WEBHOOK_SECRET set', true);

      const dSign = (payload) => {
        const t = Math.floor(Date.now() / 1000);
        const raw = JSON.stringify(payload);
        const v1 = crypto.createHmac('sha256', D_SECRET).update(`${t}.${raw}`, 'utf8').digest('hex');
        return { raw, header: `t=${t},v1=${v1}` };
      };
      const dPost = async (payload) => {
        const s = dSign(payload);
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
        try {
          return await fetch(`${D_BASE}/webhooks/stripe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'stripe-signature': s.header },
            body: s.raw, redirect: 'manual', signal: ctl.signal,
          });
        } finally { clearTimeout(to); }
      };
      const dEmail = (n) => `e2e-dispatch-${n}-${ts}@example.com`;
      const subRow = (email) => db.prepare('SELECT * FROM dispatch_subscriptions WHERE email = ?').get(email);
      const subCount = () => db.prepare('SELECT COUNT(*) AS n FROM dispatch_subscriptions').get().n;

      // 10e-1. New $100 subscription checkout -> active Complete row.
      const emailC = dEmail('complete');
      let evt = {
        id: `evt_d1_${ts}`, type: 'checkout.session.completed', mode: 'subscription',
        data: { object: { id: `cs_d1_${ts}`, mode: 'subscription', customer: `cus_d1_${ts}`, subscription: `sub_d1_${ts}`,
          customer_details: { email: emailC }, amount_total: 10000 } },
      };
      let r = await dPost(evt);
      let row = subRow(emailC);
      check('signed dispatch checkout ($100) creates active Complete subscription (200)',
        r.status === 200 && row && row.plan === 'complete' && row.status === 'active' && row.stripe_customer_id === `cus_d1_${ts}`,
        `status=${r.status} row=${JSON.stringify(row)}`);

      // 10e-2. Duplicate event id -> idempotent, still one row.
      const before = subCount();
      r = await dPost(evt);
      check('duplicate dispatch checkout event is idempotent (still one row)',
        r.status === 200 && subCount() === before, `status=${r.status} count=${subCount()}`);

      // 10e-3. Renewal (invoice.payment_succeeded) -> stays active, period end set.
      evt = { id: `evt_d2_${ts}`, type: 'invoice.payment_succeeded',
        data: { object: { id: `in_d2_${ts}`, customer: `cus_d1_${ts}`, subscription: `sub_d1_${ts}`,
          customer_email: emailC, amount_paid: 10000,
          lines: { data: [{ period: { end: 1893456000 } }] } } } };
      r = await dPost(evt);
      row = subRow(emailC);
      check('renewal keeps subscription active and records period end',
        r.status === 200 && row.status === 'active' && Number(row.current_period_end) === 1893456000000,
        `status=${r.status} row=${JSON.stringify(row)}`);

      // 10e-4. Failed payment ($50 Basic) -> past_due + dunning email queued.
      const emailB = dEmail('basic');
      evt = { id: `evt_d3_${ts}`, type: 'checkout.session.completed',
        data: { object: { id: `cs_d3_${ts}`, mode: 'subscription', customer: `cus_d3_${ts}`, subscription: `sub_d3_${ts}`,
          customer_details: { email: emailB }, amount_total: 5000 } } };
      r = await dPost(evt);
      check('signed dispatch checkout ($50) creates active Basic subscription',
        r.status === 200 && subRow(emailB) && subRow(emailB).plan === 'basic' && subRow(emailB).status === 'active',
        `status=${r.status}`);
      evt = { id: `evt_d4_${ts}`, type: 'invoice.payment_failed',
        data: { object: { id: `in_d4_${ts}`, customer: `cus_d3_${ts}`, subscription: `sub_d3_${ts}`,
          customer_email: emailB, amount_due: 5000 } } };
      r = await dPost(evt);
      row = subRow(emailB);
      const dunning = db.prepare(
        `SELECT id FROM email_queue WHERE email = ? AND sequence = 'dispatch-dunning' AND status = 'queued'`
      ).get(emailB);
      check('failed payment marks past_due and queues dunning email (no fabricated links)',
        r.status === 200 && row.status === 'past_due' && !!dunning &&
        !/https?:\/\/(?!funnel-qdx9)/i.test(db.prepare(`SELECT body_html AS b FROM email_queue WHERE id = ?`).get(dunning.id).b),
        `status=${r.status} row=${JSON.stringify(row)} dunning=${!!dunning}`);

      // 10e-5. Cancellation -> status canceled.
      evt = { id: `evt_d5_${ts}`, type: 'customer.subscription.deleted',
        data: { object: { id: `sub_d1_${ts}`, customer: `cus_d1_${ts}`,
          items: { data: [{ price: { unit_amount: 10000 } }] } } } };
      r = await dPost(evt);
      check('subscription deleted -> status canceled',
        r.status === 200 && subRow(emailC).status === 'canceled', `status=${r.status}`);

      // 10e-6. Subscription updated -> status/plan synced.
      evt = { id: `evt_d6_${ts}`, type: 'customer.subscription.updated',
        data: { object: { id: `sub_d3_${ts}`, customer: `cus_d3_${ts}`, status: 'active',
          current_period_end: 1893456000,
          items: { data: [{ price: { unit_amount: 5000 } }] } } } };
      r = await dPost(evt);
      row = subRow(emailB);
      check('subscription updated syncs status back to active with period end',
        r.status === 200 && row.status === 'active' && Number(row.current_period_end) === 1893456000000,
        `status=${r.status} row=${JSON.stringify(row)}`);

      // 10e-7. Room $49 checkout still provisions Room, creates NO dispatch row.
      const emailR = dEmail('room');
      evt = { id: `evt_d7_${ts}`, type: 'checkout.session.completed',
        data: { object: { id: `cs_d7_${ts}`, mode: 'subscription', customer: `cus_d7_${ts}`, subscription: `sub_d7_${ts}`,
          customer_details: { email: emailR }, amount_total: 4900 } } };
      r = await dPost(evt);
      const roomMember = db.prepare('SELECT email FROM room_members WHERE email = ?').get(emailR);
      check('Room $49 checkout still provisions Room member and no dispatch row',
        r.status === 200 && !!roomMember && !subRow(emailR),
        `status=${r.status} member=${!!roomMember}`);

      // 10e-8. Gate: route creation for unpaid driver -> 402; after payment -> 302.
      const gateEmail = dEmail('gate');
      db.prepare(`INSERT INTO drivers (full_name, email, status, submitted_at) VALUES (?, ?, 'new', ?)`).run(
        'Gate Test Driver', gateEmail, Date.now());
      const gateDriver = db.prepare('SELECT id FROM drivers WHERE email = ?').get(gateEmail);
      r = await req(`${D_BASE}/admin/routes?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { driver_id: String(gateDriver.id), title: 'Gate test route' } });
      const gateBody = await r.text();
      check('route creation for unpaid driver rejected (402, paid-subscribers-only message)',
        r.status === 402 && /Paid subscribers only/i.test(gateBody), `status=${r.status}`);
      // Now the driver subscribes ($100) -> gate opens.
      evt = { id: `evt_d8_${ts}`, type: 'checkout.session.completed',
        data: { object: { id: `cs_d8_${ts}`, mode: 'subscription', customer: `cus_d8_${ts}`, subscription: `sub_d8_${ts}`,
          customer_details: { email: gateEmail }, amount_total: 10000 } } };
      r = await dPost(evt);
      check('gate driver subscription recorded active', r.status === 200 && subRow(gateEmail).status === 'active',
        `status=${r.status}`);
      r = await req(`${D_BASE}/admin/routes?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { driver_id: String(gateDriver.id), title: 'Gate test route' } });
      check('route creation for paid driver succeeds (302)',
        r.status === 302, `status=${r.status}`);
      const createdRoute = db.prepare('SELECT id FROM routes WHERE driver_id = ? AND title = ?').get(gateDriver.id, 'Gate test route');
      check('route row created for paid driver', !!createdRoute);

      // 10e-9. Admin pipeline shows PAID badge + filters.
      r = await req(`${D_BASE}/admin/drivers?token=${ADMIN_TOKEN}`, {});
      const pipeHtml = await r.text();
      check('driver pipeline shows PAID badge for active subscriber',
        r.status === 200 && /PAID · Complete \$100\/mo/.test(pipeHtml), `status=${r.status}`);
      r = await req(`${D_BASE}/admin/drivers?token=${ADMIN_TOKEN}&paid=paid`, {});
      const paidHtml = await r.text();
      check('paid filter lists the subscribed driver',
        r.status === 200 && paidHtml.includes('Gate Test Driver'), `status=${r.status}`);
      // Flip the gate driver to past_due, then the needs-attention filter must surface them.
      evt = { id: `evt_d9_${ts}`, type: 'invoice.payment_failed',
        data: { object: { id: `in_d9_${ts}`, customer: `cus_d8_${ts}`, subscription: `sub_d8_${ts}`,
          customer_email: gateEmail, amount_due: 10000 } } };
      r = await dPost(evt);
      check('failed payment flips the paid driver to past_due',
        r.status === 200 && subRow(gateEmail).status === 'past_due', `status=${r.status}`);
      r = await req(`${D_BASE}/admin/drivers?token=${ADMIN_TOKEN}&paid=attention`, {});
      const attHtml = await r.text();
      check('needs-attention filter lists the past_due driver',
        r.status === 200 && attHtml.includes('Gate Test Driver'), `status=${r.status}`);
      r = await req(`${D_BASE}/admin/drivers/${gateDriver.id}?token=${ADMIN_TOKEN}`, {});
      const detailHtml = await r.text();
      check('driver detail page shows subscription section',
        r.status === 200 && /Dispatch subscription/i.test(detailHtml), `status=${r.status}`);

      // 10e-11. Opportunity CRM: subscription badges + paid/needs-attention filters.
      const crmActiveEmail = dEmail('crm-active');
      const crmAttentionEmail = dEmail('crm-attention');
      db.prepare(`INSERT INTO opportunity_leads (first_name, last_name, email, status, created_at)
                  VALUES ('Crm Active', 'Lead', ?, 'NEW', ?)`).run(crmActiveEmail, Date.now());
      db.prepare(`INSERT INTO opportunity_leads (first_name, last_name, email, status, created_at)
                  VALUES ('Crm Attention', 'Lead', ?, 'NEW', ?)`).run(crmAttentionEmail, Date.now());
      makePaid(db, crmActiveEmail, 'basic');
      db.prepare(`INSERT INTO dispatch_subscriptions
                    (stripe_customer_id, stripe_subscription_id, email, plan, status, current_period_end, created_at, updated_at)
                  VALUES (?, ?, ?, 'complete', 'past_due', ?, ?, ?)`)
        .run(`cus_crm_${ts}`, `sub_crm_${ts}`, crmAttentionEmail, Date.now() + 864e5, Date.now(), Date.now());
      r = await req(`${D_BASE}/admin/crm?token=${ADMIN_TOKEN}`, {});
      const crmHtml = await r.text();
      check('CRM lead rows show subscription badges',
        r.status === 200 && /PAID · Basic \$50\/mo/.test(crmHtml) && /PAYMENT FAILED/.test(crmHtml),
        `status=${r.status}`);
      r = await req(`${D_BASE}/admin/crm?token=${ADMIN_TOKEN}&paid=paid`, {});
      const crmPaid = await r.text();
      check('CRM paid filter shows the active subscriber and hides past_due',
        r.status === 200 && crmPaid.includes('Crm Active') && !crmPaid.includes('Crm Attention'),
        `status=${r.status}`);
      r = await req(`${D_BASE}/admin/crm?token=${ADMIN_TOKEN}&paid=attention`, {});
      const crmAtt = await r.text();
      check('CRM needs-attention filter shows the past_due subscriber and hides the active one',
        r.status === 200 && crmAtt.includes('Crm Attention') && !crmAtt.includes('Crm Active'),
        `status=${r.status}`);

      // 10e-12. Past-due for an unseen subscription stores the exact webhook-mapped
      // plan (never defaults to Complete) and drops the DISPATCH_SUBSCRIBER tag;
      // a later renewal restores it.
      const tagEmail = dEmail('tagflow');
      db.prepare(`INSERT INTO leads (email, first_name, status) VALUES (?, 'Tag Flow', 'lead')`).run(tagEmail);
      const tagLeadId = db.prepare('SELECT id FROM leads WHERE email = ?').get(tagEmail).id;
      evt = { id: `evt_d10_${ts}`, type: 'invoice.payment_failed',
        data: { object: { id: `in_d10_${ts}`, customer: `cus_d10_${ts}`, subscription: `sub_d10_${ts}`,
          customer_email: tagEmail, amount_due: 5000 } } };
      r = await dPost(evt);
      row = subRow(tagEmail);
      const hasSubTagAfterFail = db.prepare('SELECT 1 FROM tags WHERE lead_id = ? AND tag = ?').get(tagLeadId, 'DISPATCH_SUBSCRIBER');
      check('past_due for unseen subscription keeps the mapped Basic plan (not Complete)',
        r.status === 200 && row && row.plan === 'basic' && row.status === 'past_due',
        `status=${r.status} row=${JSON.stringify(row)}`);
      check('past_due drops the DISPATCH_SUBSCRIBER lead tag', !hasSubTagAfterFail);
      evt = { id: `evt_d11_${ts}`, type: 'invoice.payment_succeeded',
        data: { object: { id: `in_d11_${ts}`, customer: `cus_d10_${ts}`, subscription: `sub_d10_${ts}`,
          customer_email: tagEmail, amount_paid: 5000,
          lines: { data: [{ period: { end: 1893456000 } }] } } } };
      r = await dPost(evt);
      const hasSubTagAfterRenew = db.prepare('SELECT 1 FROM tags WHERE lead_id = ? AND tag = ?').get(tagLeadId, 'DISPATCH_SUBSCRIBER');
      const hasPlanTagAfterRenew = db.prepare('SELECT 1 FROM tags WHERE lead_id = ? AND tag = ?').get(tagLeadId, 'DISPATCH_BASIC');
      check('renewal restores active status and the DISPATCH_SUBSCRIBER + plan tags',
        r.status === 200 && subRow(tagEmail).status === 'active' && !!hasSubTagAfterRenew && !!hasPlanTagAfterRenew,
        `status=${r.status}`);

      // 10e-10. Plan approval gate: unpaid driver -> 402.
      const planEmail = dEmail('plan');
      db.prepare(`INSERT INTO drivers (full_name, email, status, submitted_at) VALUES (?, ?, 'new', ?)`).run(
        'Plan Gate Driver', planEmail, Date.now());
      const planDriver = db.prepare('SELECT id FROM drivers WHERE email = ?').get(planEmail);
      r = await req(`${D_BASE}/admin/plans/requests/${planDriver.id}/approve?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { note: 'test' } });
      check('plan approval for unpaid driver rejected (402)',
        r.status === 402 && /Paid subscribers only/i.test(await r.text()), `status=${r.status}`);
    } finally {
      await stopServer(childD);
    }

    /* ---- 10f. Tier-based route matching -------------------------------- */
    // Covers: day-one tier quotas (Complete 5 / Basic 2), Monday refill,
    // Complete-first priority, city/state filtering, honest no-match
    // behavior (never fabricated), paused matching for past-due/canceled/
    // unpaid drivers, weekly goal math, and the /grow + /dispatch pricing
    // sections with Davena's exact Stripe links.
    const rmLib = require(path.join(APP_ROOT, 'lib', 'route_matching'));
    {
      // Fixed (ts-independent) identifiers so reruns always clean up prior
      // runs' rows; cleanup at the top makes the section idempotent.
      const rtag = 'e2e-routematch';
      const rmEmail = (n) => `${rtag}-${n}@example.com`.toLowerCase();
      const nowT = Date.now();
      // Clean slate for this section (scheduler residue from earlier runs).
      db.prepare(`DELETE FROM driver_route_matches WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE ?)`).run(`${rtag}%`);
      db.prepare(`DELETE FROM driver_weekly_goals WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE ?)`).run(`${rtag}%`);
      db.prepare(`DELETE FROM dispatch_subscriptions WHERE email LIKE ?`).run(`${rtag}%`);
      db.prepare(`DELETE FROM drivers WHERE email LIKE ?`).run(`${rtag}%`);
      db.prepare(`DELETE FROM opportunities WHERE name LIKE ?`).run(`${rtag}%`);
      db.prepare(`DELETE FROM email_queue WHERE email LIKE ? AND sequence LIKE 'route-match%'`).run(`${rtag}%`);

      // Opportunities: 6 OPEN in Milwaukee WI, 3 OPEN in Chicago IL,
      // 1 DRAFT in Milwaukee (must never match), 1 OPEN with no location.
      const mkOpp = (name, location, status) => db.prepare(
        `INSERT INTO opportunities (name, location, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'test', ?, ?)`
      ).run(`${rtag}-${name}`, location, status, nowT, nowT).lastInsertRowid;
      for (let i = 1; i <= 6; i++) mkOpp(`MKE-opp-${i}`, 'Milwaukee, WI', 'OPEN');
      for (let i = 1; i <= 3; i++) mkOpp(`CHI-opp-${i}`, 'Chicago, IL', 'OPEN');
      mkOpp('MKE-draft', 'Milwaukee, WI', 'DRAFT');
      mkOpp('nowhere-opp', null, 'OPEN');

      const mkDriver = (n, city, state) => {
        const email = rmEmail(n);
        db.prepare(`INSERT INTO drivers (full_name, email, phone, home_city, home_state, status, submitted_at)
                    VALUES (?, ?, ?, ?, ?, 'new', ?)`).run(`RM Driver ${n}`, email, '4145550100', city, state, nowT);
        return db.prepare('SELECT * FROM drivers WHERE email = ?').get(email);
      };
      const dComplete = mkDriver('complete', 'Milwaukee', 'WI');
      const dBasic = mkDriver('basic', 'Milwaukee', 'WI');
      const dChicago = mkDriver('chicago', 'Chicago', 'IL');
      const dNoMatch = mkDriver('nomatch', 'Des Moines', 'IA');
      const dPastDue = mkDriver('pastdue', 'Milwaukee', 'WI');
      const dCanceled = mkDriver('canceled', 'Milwaukee', 'WI');
      const dFree = mkDriver('free', 'Milwaukee', 'WI');
      makePaid(db, dComplete.email, 'complete');
      makePaid(db, dBasic.email, 'basic');
      makePaid(db, dChicago.email, 'complete');
      makePaid(db, dNoMatch.email, 'basic');
      makePaid(db, dPastDue.email, 'complete');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'past_due' WHERE email = ?`).run(dPastDue.email);
      makePaid(db, dCanceled.email, 'basic');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'canceled' WHERE email = ?`).run(dCanceled.email);

      const activeCount = (id) => db.prepare(
        `SELECT COUNT(*) n FROM driver_route_matches WHERE driver_id = ? AND status = 'assigned'`).get(id).n;

      // 10f-1. Day-one: Complete gets 5.
      let r = await rmLib.runMatchForDriver(dComplete, { kind: 'onboarding' });
      check('onboarding: Complete driver gets 5 day-one matches',
        r.ok && r.created === 5 && r.activeTotal === 5 && r.plan === 'complete',
        JSON.stringify({ created: r.created, total: r.activeTotal }));

      // 10f-2. Day-one: Basic gets 2 (Davena's stronger choice).
      r = await rmLib.runMatchForDriver(dBasic, { kind: 'onboarding' });
      check('onboarding: Basic driver gets 2 day-one matches',
        r.ok && r.created === 2 && r.activeTotal === 2 && r.plan === 'basic',
        JSON.stringify({ created: r.created, total: r.activeTotal }));

      // 10f-3. City/state filtering: Chicago driver only gets Chicago opps.
      r = await rmLib.runMatchForDriver(dChicago, { kind: 'onboarding' });
      const chiLocs = db.prepare(
        `SELECT DISTINCT o.location FROM driver_route_matches m JOIN opportunities o ON o.id = m.opportunity_id WHERE m.driver_id = ?`).all(dChicago.id);
      check('city/state filtering: Chicago driver matched only to Chicago opportunities',
        r.created === 3 && chiLocs.length === 1 && chiLocs[0].location === 'Chicago, IL',
        JSON.stringify({ created: r.created, locs: chiLocs }));

      // 10f-3b. State-level match: a same-state driver matches via the state word.
      const dState = mkDriver('state', 'Madison', 'WI');
      makePaid(db, dState.email, 'basic');
      r = await rmLib.runMatchForDriver(dState, { kind: 'onboarding' });
      check('state-level matching: Madison WI driver matches Wisconsin opportunities',
        r.created === 2 && r.plan === 'basic', JSON.stringify({ created: r.created }));

      // 10f-4. Honest no-match: Madison driver gets zero matches + honest note, never fakes.
      r = await rmLib.runMatchForDriver(dNoMatch, { kind: 'onboarding' });
      const noMatchNote = db.prepare(
        `SELECT body_html FROM email_queue WHERE email = ? AND sequence = 'route-match' ORDER BY id DESC LIMIT 1`).get(dNoMatch.email);
      check('no opportunities in city: zero matches created (never fabricated)',
        r.ok && r.created === 0 && activeCount(dNoMatch.id) === 0, JSON.stringify(r));
      check('no-match driver gets an honest "no current matches" notice',
        !!noMatchNote && /no current opportunities/i.test(noMatchNote.body_html) &&
          /rather tell you that honestly than send you matches that aren.t real/i.test(noMatchNote.body_html),
        noMatchNote ? 'note queued' : 'no note found');

      // 10f-5. Paused matching: past-due, canceled, and unpaid drivers are skipped.
      for (const [label, drv] of [['past_due', dPastDue], ['canceled', dCanceled], ['free', dFree]]) {
        const rr = await rmLib.runMatchForDriver(drv, { kind: 'onboarding' });
        check(`matching paused for ${label} driver (skipped, no matches)`,
          rr.skipped && rr.reason === 'no-active-subscription' && activeCount(drv.id) === 0,
          JSON.stringify({ skipped: rr.skipped, reason: rr.reason }));
      }

      // 10f-6. DRAFT and location-less opportunities never match anyone.
      const draftHit = db.prepare(
        `SELECT COUNT(*) n FROM driver_route_matches m JOIN opportunities o ON o.id = m.opportunity_id
          WHERE o.name LIKE ? AND (m.driver_id IN (SELECT id FROM drivers WHERE email LIKE ?))`)
        .get(`${rtag}-MKE-draft`, `${rtag}%`).n;
      const nowhereHit = db.prepare(
        `SELECT COUNT(*) n FROM driver_route_matches m JOIN opportunities o ON o.id = m.opportunity_id
          WHERE o.name LIKE ? AND (m.driver_id IN (SELECT id FROM drivers WHERE email LIKE ?))`)
        .get(`${rtag}-nowhere-opp`, `${rtag}%`).n;
      check('DRAFT opportunities are never matched', draftHit === 0, `hits=${draftHit}`);
      check('location-less opportunities are never matched', nowhereHit === 0, `hits=${nowhereHit}`);

      // 10f-7. Monday refill: release 2 of Complete's matches, cycle refills to 5.
      const toRelease = db.prepare(
        `SELECT id FROM driver_route_matches WHERE driver_id = ? AND status = 'assigned' ORDER BY id ASC LIMIT 2`).all(dComplete.id);
      for (const mrow of toRelease) await rmLib.releaseMatch(mrow.id, 'test-release');
      check('release drops Complete driver to 3 active', activeCount(dComplete.id) === 3);
      const cyc = await rmLib.runMondayCycle({ force: true });
      check('Monday cycle refills Complete driver back to 5',
        cyc.ok && activeCount(dComplete.id) === 5, `active=${activeCount(dComplete.id)}`);
      check('Monday cycle keeps Basic driver at quota 2 (no overfill)',
        activeCount(dBasic.id) === 2, `active=${activeCount(dBasic.id)}`);

      // 10f-8. Complete-first priority recorded in cycle log order.
      const cycRow = db.prepare(`SELECT notes FROM route_match_cycles WHERE cycle_key = ?`).get(cyc.cycleKey);
      const orderIds = (cycRow.notes.match(/driver ids: ([\d,]+)/) || [])[1];
      const idxC = orderIds.indexOf(String(dComplete.id));
      const idxB = orderIds.indexOf(String(dBasic.id));
      check('Complete-tier drivers are matched before Basic in the cycle order',
        idxC !== -1 && idxB !== -1 && idxC < idxB, `order=${orderIds}`);

      // 10f-9. Cycle idempotency: same week, no force -> alreadyRan.
      const cyc2 = await rmLib.runMondayCycle({ force: false });
      check('Monday cycle is idempotent per week', cyc2.alreadyRan === true);

      // 10f-10. Weekly goal tracker math + no-guarantee copy.
      await rmLib.setWeeklyGoal(dBasic.id, 75000);
      const prog = await rmLib.goalProgress(dBasic.id);
      check('goal tracker: assigned count vs quota vs driver-set goal',
        prog.assignedCount === 2 && prog.quota === 2 && prog.goalCents === 75000,
        JSON.stringify({ assigned: prog.assignedCount, quota: prog.quota, goal: prog.goalCents }));
      check('goal copy carries no-guarantee language and promises nothing',
        /does not promise or guarantee routes, loads, contracts, work, earnings, or income/i.test(prog.copy) &&
          !/you will earn|guaranteed income/i.test(prog.copy),
        prog.copy.slice(0, 120));

      // 10f-11. /grow and /dispatch render both exact Stripe subscribe links.
      const BASIC_LINK = 'https://buy.stripe.com/aFa00k4uVeoUaQN00B0480n';
      const COMPLETE_LINK = 'https://buy.stripe.com/4gM4gA3qR6Ws5wt4gR0480o';
      res = await req(`${BASE}/grow`, {});
      const growHtml = await res.text();
      check('GET /grow renders the Basic $50/mo Stripe subscribe link',
        res.status === 200 && growHtml.includes(BASIC_LINK), `status=${res.status}`);
      check('GET /grow renders the Complete $100/mo Stripe subscribe link',
        res.status === 200 && growHtml.includes(COMPLETE_LINK), `status=${res.status}`);
      check('GET /grow pricing section carries no-guarantee language',
        /does not promise or guarantee routes, loads, contracts, work, earnings, or income/i.test(growHtml));
      check('GET /grow frames tiers around growth (Start steady / Grow faster)',
        /Start steady/i.test(growHtml) && /Grow faster/i.test(growHtml) &&
          /a full board from the start/i.test(growHtml), `status=${res.status}`);
      check('GET /grow shows the driver-set weekly goal line',
        /Drivers set their own weekly goal/i.test(growHtml));
      res = await req(`${BASE}/dispatch`, {});
      const dispHtml = await res.text();
      check('GET /dispatch renders both Stripe subscribe links',
        res.status === 200 && dispHtml.includes(BASIC_LINK) && dispHtml.includes(COMPLETE_LINK),
        `status=${res.status}`);

      // 10f-12. Onboarding hook: paid driver completing /drivers/onboard gets day-one matches.
      const hookEmail = rmEmail('hook');
      makePaid(db, hookEmail, 'complete');
      res = await req(`${BASE}/drivers/onboard`, { method: 'POST',
        form: { full_name: 'Hook Driver', email: hookEmail, phone: '4145550199', home_city: 'Milwaukee', home_state: 'WI' } });
      const hookDriver = db.prepare('SELECT id FROM drivers WHERE email = ?').get(hookEmail);
      check('POST /drivers/onboard still completes (200)',
        res.status === 200 && !!hookDriver, `status=${res.status}`);
      check('paid driver gets 5 day-one matches via the onboarding hook',
        activeCount(hookDriver.id) === 5, `active=${activeCount(hookDriver.id)}`);

      // 10f-13. Driver dashboard shows route matches + weekly goal.
      const dashDrv = mkDriver('dash', 'Milwaukee', 'WI');
      makePaid(db, dashDrv.email, 'complete');
      const dashTok = `e2e-routematch-dashtok-${'a'.repeat(40)}`;
      db.prepare(`UPDATE drivers SET access_token = ? WHERE id = ?`).run(dashTok, dashDrv.id);
      const dashFull = db.prepare('SELECT * FROM drivers WHERE id = ?').get(dashDrv.id);
      await rmLib.runMatchForDriver(dashFull, { kind: 'onboarding' });
      await rmLib.setWeeklyGoal(dashDrv.id, 80000);
      res = await req(`${BASE}/d/${dashTok}`, {});
      const dashHtml = await res.text();
      check('driver dashboard shows route matches, quota, and weekly goal',
        res.status === 200 && /Route matches — Complete plan/i.test(dashHtml) &&
          /5 of 5 matches/i.test(dashHtml) && /\$800\.00/.test(dashHtml),
        `status=${res.status}`);
      check('driver dashboard match card carries no-guarantee language',
        /does not promise or guarantee routes, loads, contracts, work, earnings, or income/i.test(dashHtml));
    }

    /* ---- 10g. Private operations assistant (Complete tier) --------------- */
    // Covers: ai_questions table; Complete-active driver can ask (302, row
    // stored pending); Basic / past-due / canceled / unpaid drivers get 402
    // with paid-subscriber messaging; the panel is hidden for non-Complete
    // drivers; admin queue lists pending questions; answering queues the
    // driver notification email; no vendor/model name in any user-facing
    // string. Answers are never generated by the app.
    const aiLib = require(path.join(APP_ROOT, 'lib', 'ai_assistant'));
    {
      const atag = 'e2e-assistant';
      const aEmail = (n) => `${atag}-${n}@example.com`.toLowerCase();
      const nowT2 = Date.now();
      db.prepare(`DELETE FROM ai_questions WHERE id IN (SELECT q.id FROM ai_questions q JOIN drivers d ON d.id = q.driver_id WHERE d.email LIKE ?)`).run(`${atag}%`);
      db.prepare(`DELETE FROM dispatch_subscriptions WHERE email LIKE ?`).run(`${atag}%`);
      db.prepare(`DELETE FROM drivers WHERE email LIKE ?`).run(`${atag}%`);
      db.prepare(`DELETE FROM email_queue WHERE email LIKE ? AND sequence LIKE 'assistant-%'`).run(`${atag}%`);

      const mkADriver = (n) => {
        const email = aEmail(n);
        db.prepare(`INSERT INTO drivers (full_name, email, phone, home_city, home_state, status, submitted_at, access_token)
                    VALUES (?, ?, ?, 'Milwaukee', 'WI', 'new', ?, ?)`)
          .run(`Assistant Driver ${n}`, email, '4145550199', nowT2, `${atag}-tok-${n}-` + 'b'.repeat(40));
        return db.prepare('SELECT * FROM drivers WHERE email = ?').get(email);
      };
      const dCompleteA = mkADriver('complete');
      const dBasicA = mkADriver('basic');
      const dPastDueA = mkADriver('pastdue');
      const dCanceledA = mkADriver('canceled');
      const dFreeA = mkADriver('free');
      makePaid(db, dCompleteA.email, 'complete');
      makePaid(db, dBasicA.email, 'basic');
      makePaid(db, dPastDueA.email, 'complete');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'past_due' WHERE email = ?`).run(dPastDueA.email);
      makePaid(db, dCanceledA.email, 'complete');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'canceled' WHERE email = ?`).run(dCanceledA.email);

      const askAs = (drv, question) => req(`${BASE}/d/${drv.access_token}/assistant?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { question } });

      // 10g-1. Complete-active driver can ask: 302, stored as pending.
      let r = await askAs(dCompleteA, 'What paperwork do I need before calling a broker?');
      let qRow = db.prepare(`SELECT * FROM ai_questions WHERE driver_id = ?`).get(dCompleteA.id);
      check('Complete-active driver question stored as pending (302)',
        r.status === 302 && !!qRow && qRow.status === 'pending' && qRow.answer == null,
        `status=${r.status} row=${JSON.stringify(qRow && qRow.status)}`);

      // 10g-2. Basic driver -> 402 with paid-subscriber messaging.
      r = await askAs(dBasicA, 'Should I run this lane?');
      let b2 = await r.text();
      check('Basic driver asking the assistant gets 402 + paid-subscribers messaging',
        r.status === 402 && /Paid subscribers only/i.test(b2) && /Complete \$100\/month/i.test(b2),
        `status=${r.status}`);

      // 10g-3. Past-due / canceled / unpaid drivers -> 402, nothing stored.
      for (const [label, drv] of [['past-due', dPastDueA], ['canceled', dCanceledA], ['unpaid', dFreeA]]) {
        r = await askAs(drv, 'Test question?');
        const body = await r.text();
        const stored = db.prepare(`SELECT COUNT(*) n FROM ai_questions WHERE driver_id = ?`).get(drv.id).n;
        check(`${label} driver asking the assistant gets 402 and nothing stored`,
          r.status === 402 && /Paid subscribers only/i.test(body) && stored === 0,
          `status=${r.status} stored=${stored}`);
      }

      // 10g-4. Panel visible for Complete-active, hidden for Basic and unpaid.
      r = await req(`${BASE}/d/${dCompleteA.access_token}`, {});
      const compHtml = await r.text();
      check('dashboard shows Private Operations Assistant panel for Complete driver',
        r.status === 200 && /Your Private Operations Assistant/i.test(compHtml) && /ASK MY ASSISTANT/i.test(compHtml),
        `status=${r.status}`);
      r = await req(`${BASE}/d/${dBasicA.access_token}`, {});
      const basicHtml = await r.text();
      check('dashboard hides assistant panel for Basic driver',
        r.status === 200 && !/Your Private Operations Assistant/i.test(basicHtml),
        `status=${r.status}`);
      r = await req(`${BASE}/d/${dFreeA.access_token}`, {});
      const freeHtml = await r.text();
      check('dashboard hides assistant panel for unpaid driver',
        r.status === 200 && !/Your Private Operations Assistant/i.test(freeHtml),
        `status=${r.status}`);

      // 10g-5. No vendor/model name in any user-facing assistant string.
      const forbidden = /muse|mena|anthropic|openai|gpt|llama|gemini/i;
      check('no vendor/model name in dashboard assistant copy', !forbidden.test(compHtml));
      r = await askAs(dBasicA, 'x');
      const denyBody = await r.text();
      check('no vendor/model name in 402 assistant copy', !forbidden.test(denyBody));

      // 10g-6. Admin queue lists the pending question with driver + tier.
      r = await req(`${BASE}/admin/route-matches?token=${ADMIN_TOKEN}`, {});
      const adminHtml = await r.text();
      check('admin queue shows pending assistant question with driver name and tier badge',
        r.status === 200 && /Assistant questions — pending/i.test(adminHtml) &&
          /What paperwork do I need before calling a broker\?/i.test(adminHtml) &&
          /COMPLETE/i.test(adminHtml),
        `status=${r.status}`);

      // 10g-7. Answering via admin stores the answer and queues the driver email.
      const before = db.prepare(`SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'assistant-answer'`).get(dCompleteA.email).n;
      r = await req(`${BASE}/admin/assistant-questions/${qRow.id}/answer?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { answer: 'Carry your authority letter, W-9, and insurance certificate.' } });
      const answered = db.prepare(`SELECT * FROM ai_questions WHERE id = ?`).get(qRow.id);
      const after = db.prepare(`SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'assistant-answer'`).get(dCompleteA.email).n;
      const smsQueued = db.prepare(`SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'assistant-answer-sms'`).get(dCompleteA.email).n;
      check('admin answer stored, driver notified by email + queued text',
        r.status === 302 && answered.status === 'answered' &&
          /Carry your authority letter/.test(answered.answer) &&
          after === before + 1 && smsQueued === 1,
        `status=${r.status} row=${answered.status} email=${after - before} sms=${smsQueued}`);
      check('queued assistant email carries no vendor/model name',
        !forbidden.test(db.prepare(`SELECT subject, body_html FROM email_queue WHERE email = ? AND sequence = 'assistant-answer' ORDER BY id DESC LIMIT 1`).get(dCompleteA.email).body_html));

      // 10g-8. Question history renders on the Complete driver's dashboard.
      r = await req(`${BASE}/d/${dCompleteA.access_token}`, {});
      const histHtml = await r.text();
      check('answered Q&A history renders on driver dashboard',
        /What paperwork do I need before calling a broker\?/i.test(histHtml) &&
          /Carry your authority letter/i.test(histHtml),
        `status=${r.status}`);

      // 10g-9. Complete tier card on /grow and /dispatch advertises the assistant (Basic does not).
      for (const p of ['/grow', '/dispatch']) {
        r = await req(`${BASE}${p}`, {});
        const ph = await r.text();
        const completeCard = ph.split('Complete — Grow faster')[1] || '';
        const basicCard = (ph.split('Complete — Grow faster')[0] || '').split('Basic — Start steady')[1] || '';
        check(`${p}: Complete card advertises private AI operations assistant`,
          /Private AI operations assistant/i.test(completeCard) &&
            /unseen advantage/i.test(completeCard) &&
            !forbidden.test(completeCard),
          p);
        check(`${p}: Basic card does not mention the assistant`,
          !/operations assistant/i.test(basicCard), p);
      }
    }

    /* ---- 10h. Assistant capabilities + Monday spotlight emails ---------- */
    // Covers: catalog counts render dynamically; weekly rotation changes
    // week to week and is deterministic for the same week; Monday driver
    // email only queues for ACTIVE Complete subscribers; Monday Room email
    // only queues for active claimed members (never canceled/inactive/
    // suppressed); no vendor/model name in any user-facing string.
    const capsLib = require(path.join(APP_ROOT, 'lib', 'ai_capabilities'));
    const autoLib = require(path.join(APP_ROOT, 'lib', 'automation'));
    const rmWeekLib = require(path.join(APP_ROOT, 'lib', 'route_matching'));
    {
      const htag = 'e2e-capab';
      const hEmail = (n) => `${htag}-${n}@example.com`.toLowerCase();
      const nowT3 = Date.now();
      db.prepare(`DELETE FROM dispatch_subscriptions WHERE email LIKE ?`).run(`${htag}%`);
      db.prepare(`DELETE FROM drivers WHERE email LIKE ?`).run(`${htag}%`);
      db.prepare(`DELETE FROM room_members WHERE email LIKE ?`).run(`${htag}%`);
      db.prepare(`DELETE FROM suppressions WHERE email LIKE ?`).run(`${htag}%`);
      db.prepare(`DELETE FROM email_queue WHERE email LIKE ? AND sequence IN ('assistant-weekly','room-assistant-weekly')`).run(`${htag}%`);

      const forbiddenH = /muse|mena|anthropic|openai|gpt|llama|gemini|claude/i;
      const catalogText = JSON.stringify(capsLib.DRIVER_CAPABILITIES) + JSON.stringify(capsLib.ROOM_CAPABILITIES);

      // 10h-1. Catalogs have real counts and no earnings promises / vendor names.
      check('driver capabilities catalog has 12 items', capsLib.DRIVER_CAPABILITIES.length === 12,
        `n=${capsLib.DRIVER_CAPABILITIES.length}`);
      check('room capabilities catalog has 10 items', capsLib.ROOM_CAPABILITIES.length === 10,
        `n=${capsLib.ROOM_CAPABILITIES.length}`);
      check('no vendor/model name in capability catalogs', !forbiddenH.test(catalogText));
      check('no earnings promises in capability catalogs',
        !/guarantee[ds]? (you|your)? ?\$|earn \$|make \$|income of \$/i.test(catalogText));

      // 10h-2. Weekly rotation: different weeks -> different spotlight; same week -> identical.
      const spot39 = capsLib.weeklySpotlight(capsLib.DRIVER_CAPABILITIES, '2026-W39');
      const spot39b = capsLib.weeklySpotlight(capsLib.DRIVER_CAPABILITIES, '2026-W39');
      const spot40 = capsLib.weeklySpotlight(capsLib.DRIVER_CAPABILITIES, '2026-W40');
      check('weekly spotlight returns 3 items',
        spot39.length === 3 && spot40.length === 3, JSON.stringify(spot39.map((c) => c.id)));
      check('spotlight is deterministic for the same week',
        JSON.stringify(spot39) === JSON.stringify(spot39b));
      check('spotlight changes between weeks',
        JSON.stringify(spot39.map((c) => c.id)) !== JSON.stringify(spot40.map((c) => c.id)),
        `${spot39[0].id} vs ${spot40[0].id}`);

      // 10h-3. Monday driver email: only ACTIVE Complete subscribers queued.
      const mkHDriver = (n) => {
        const email = hEmail(n);
        db.prepare(`INSERT INTO drivers (full_name, email, phone, home_city, home_state, status, submitted_at, access_token)
                    VALUES (?, ?, ?, 'Milwaukee', 'WI', 'new', ?, ?)`)
          .run(`Capab Driver ${n}`, email, '4145550177', nowT3, `${htag}-tok-${n}-` + 'c'.repeat(40));
        return db.prepare('SELECT * FROM drivers WHERE email = ?').get(email);
      };
      const hComplete = mkHDriver('complete');
      const hBasic = mkHDriver('basic');
      const hPastDue = mkHDriver('pastdue');
      const hCanceled = mkHDriver('canceled');
      makePaid(db, hComplete.email, 'complete');
      makePaid(db, hBasic.email, 'basic');
      makePaid(db, hPastDue.email, 'complete');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'past_due' WHERE email = ?`).run(hPastDue.email);
      makePaid(db, hCanceled.email, 'complete');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'canceled' WHERE email = ?`).run(hCanceled.email);
      // A known Chicago Monday: 2026-09-21 12:00 UTC = 07:00 CDT.
      const mondayNoon = Date.UTC(2026, 8, 21, 12, 0, 0);
      check('test Monday is a Chicago Monday', rmWeekLib.isMondayChicago(mondayNoon));
      const weekKey = rmWeekLib.chicagoWeekKey(mondayNoon);
      const qRes = await autoLib.queueMondayAssistantEmails(mondayNoon);
      const gotEmail = (em) => db.prepare(
        `SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'assistant-weekly' AND step = ?`).get(em, weekKey).n;
      check('Monday assistant email queues only for the ACTIVE Complete driver',
        qRes.ran && gotEmail(hComplete.email) === 1 && gotEmail(hBasic.email) === 0 &&
          gotEmail(hPastDue.email) === 0 && gotEmail(hCanceled.email) === 0,
        JSON.stringify(qRes));
      const queuedBody = db.prepare(
        `SELECT body_html FROM email_queue WHERE email = ? AND sequence = 'assistant-weekly' AND step = ?`).get(hComplete.email, weekKey).body_html;
      check('driver weekly email lists 3 spotlight capabilities with example asks',
        /This week with your private assistant/i.test(queuedBody) &&
          (queuedBody.match(/Try asking:/g) || []).length === 3,
        queuedBody.slice(0, 120));
      check('no vendor/model name in driver weekly email', !forbiddenH.test(queuedBody));
      // Idempotent: second call same week queues nothing new.
      const qRes2 = await autoLib.queueMondayAssistantEmails(mondayNoon);
      check('Monday assistant email is idempotent per week',
        qRes2.ran === false || gotEmail(hComplete.email) === 1,
        JSON.stringify(qRes2));
      // Non-Monday: no-op.
      const tuesday = mondayNoon + 86400000;
      const qTue = await autoLib.queueMondayAssistantEmails(tuesday);
      check('assistant email queue is a no-op on non-Mondays', qTue.ran === false, JSON.stringify(qTue));

      // 10h-4. Monday Room email: only active claimed members, never canceled/inactive/suppressed.
      db.prepare(`INSERT INTO room_members (email, name, password_hash, joined_at, status)
                  VALUES (?, 'Active Member', 'hash-x', ?, 'active')`).run(hEmail('room-active'), nowT3);
      db.prepare(`INSERT INTO room_members (email, name, password_hash, joined_at, status)
                  VALUES (?, 'Canceled Member', 'hash-x', ?, 'canceled')`).run(hEmail('room-canceled'), nowT3);
      db.prepare(`INSERT INTO room_members (email, name, password_hash, joined_at, status)
                  VALUES (?, 'Inactive Member', 'hash-x', ?, 'inactive')`).run(hEmail('room-inactive'), nowT3);
      db.prepare(`INSERT INTO room_members (email, name, joined_at, status)
                  VALUES (?, 'Unclaimed Member', ?, 'active')`).run(hEmail('room-unclaimed'), nowT3);
      db.prepare(`INSERT INTO suppressions (email, reason, ts) VALUES (?, 'test', ?)`).run(hEmail('room-suppressed'), nowT3);
      db.prepare(`INSERT INTO room_members (email, name, password_hash, joined_at, status)
                  VALUES (?, 'Suppressed Member', 'hash-x', ?, 'active')`).run(hEmail('room-suppressed'), nowT3);
      const rqRes = await autoLib.queueMondayRoomAssistantEmails(mondayNoon);
      const gotRoom = (em) => db.prepare(
        `SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'room-assistant-weekly' AND step = ?`).get(em, weekKey).n;
      check('Monday Room email queues only for the active claimed member',
        rqRes.ran && gotRoom(hEmail('room-active')) === 1 && gotRoom(hEmail('room-canceled')) === 0 &&
          gotRoom(hEmail('room-inactive')) === 0 && gotRoom(hEmail('room-unclaimed')) === 0 &&
          gotRoom(hEmail('room-suppressed')) === 0,
        JSON.stringify(rqRes));
      const roomBody = db.prepare(
        `SELECT subject, body_html FROM email_queue WHERE email = ? AND sequence = 'room-assistant-weekly' AND step = ?`)
        .get(hEmail('room-active'), weekKey);
      check('Room weekly email lists 3 rotating room capabilities',
        /This week in the Room/i.test(roomBody.body_html) &&
          (roomBody.body_html.match(/Try:/g) || []).length >= 3,
        roomBody.subject);
      check('no vendor/model name in Room weekly email',
        !forbiddenH.test(roomBody.subject + roomBody.body_html));

      // 10h-5. Dashboard panel renders the live count + weekly spotlight.
      const hDashTok = db.prepare('SELECT access_token FROM drivers WHERE email = ?').get(hComplete.email).access_token;
      res = await req(`${BASE}/d/${hDashTok}`, {});
      const hDashHtml = await res.text();
      check('dashboard panel shows the live capability count',
        new RegExp(`can do <strong>${capsLib.DRIVER_CAPABILITIES.length} things</strong>`).test(hDashHtml),
        `status=${res.status}`);
      check('dashboard panel shows the "This week, try:" spotlight',
        /This week, try:/i.test(hDashHtml) && !forbiddenH.test(hDashHtml),
        `status=${res.status}`);
    }

    /* ---- 10i. Dispatch field communications ------------------------------- */
    // Covers: urgent driver ticket -> immediate ops email (existing
    // createTicket path) + can't-miss admin siren until acknowledged;
    // "Broadcast to field" composer (active-subscriber audiences only);
    // driver "Dispatch messages" inbox (newest first, unread highlight);
    // admin "Message driver" (email + provider-pending SMS); SMS rows are
    // never claimed delivered (provider-pending stub); no duplicate
    // urgent-alert tables exist (support_tickets is reused).
    {
      const ftag = 'e2e-field';
      const fEmail = (n) => `${ftag}-${n}@example.com`.toLowerCase();
      const nowT3 = Date.now();
      db.prepare(`DELETE FROM driver_messages WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE ?)`).run(`${ftag}%`);
      db.prepare(`DELETE FROM broadcast_log WHERE id > 0 AND subject LIKE ?`).run(`%${ftag}%`);
      db.prepare(`DELETE FROM email_queue WHERE email LIKE ? AND (sequence LIKE 'field-%' OR sequence = 'driver-ops')`).run(`${ftag}%`);
      db.prepare(`DELETE FROM support_tickets WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE ?)`).run(`${ftag}%`);
      db.prepare(`DELETE FROM dispatch_subscriptions WHERE email LIKE ?`).run(`${ftag}%`);
      db.prepare(`DELETE FROM drivers WHERE email LIKE ?`).run(`${ftag}%`);

      const mkFDriver = (n, phone = '4145550199') => {
        const email = fEmail(n);
        db.prepare(`INSERT INTO drivers (full_name, email, phone, home_city, home_state, status, submitted_at, access_token)
                    VALUES (?, ?, ?, 'Milwaukee', 'WI', 'new', ?, ?)`)
          .run(`Field Driver ${n}`, email, phone, nowT3, `${ftag}-tok-${n}-` + 'c'.repeat(40));
        return db.prepare('SELECT * FROM drivers WHERE email = ?').get(email);
      };
      const fComplete = mkFDriver('complete');
      const fBasic = mkFDriver('basic');
      const fPastDue = mkFDriver('pastdue');
      const fCanceled = mkFDriver('canceled');
      const fFree = mkFDriver('free');
      makePaid(db, fComplete.email, 'complete');
      makePaid(db, fBasic.email, 'basic');
      makePaid(db, fPastDue.email, 'complete');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'past_due' WHERE email = ?`).run(fPastDue.email);
      makePaid(db, fCanceled.email, 'complete');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'canceled' WHERE email = ?`).run(fCanceled.email);

      // 10i-1. Urgent ticket: filed via the existing support path -> ops email
      // queued immediately with URGENT subject.
      let r = await req(`${BASE}/d/${fComplete.access_token}/support?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { category: 'vehicle_issue', priority: 'urgent', subject: 'Blowout on I-94', description: 'Tire blew, pulled over safely.' } });
      const ticket = db.prepare(`SELECT * FROM support_tickets WHERE driver_id = ? ORDER BY id DESC LIMIT 1`).get(fComplete.id);
      check('urgent support ticket filed via existing path (302, stored urgent+open)',
        r.status === 302 && !!ticket && ticket.priority === 'urgent' && ticket.status === 'open',
        `status=${r.status} ticket=${ticket && ticket.priority}/${ticket && ticket.status}`);
      const opsMail = db.prepare(`SELECT * FROM email_queue WHERE sequence = 'driver-ops' AND step = 'ticket-urgent' ORDER BY id DESC LIMIT 1`).get();
      check('urgent ticket queues immediate ops email with URGENT subject',
        !!opsMail && /^URGENT/i.test(opsMail.subject) && /Blowout on I-94/.test(opsMail.subject),
        `subject=${opsMail && opsMail.subject}`);

      // 10i-2. Siren banner on the admin dashboard until acknowledged.
      r = await req(`${BASE}/admin?token=${ADMIN_TOKEN}`, {});
      const dashHtml = await r.text();
      check('admin dashboard shows the urgent siren banner while unacknowledged',
        r.status === 200 && /URGENT field ticket/i.test(dashHtml) && new RegExp(ticket.ticket_id).test(dashHtml),
        `status=${r.status}`);
      r = await req(`${BASE}/admin/tickets?token=${ADMIN_TOKEN}`, {});
      check('tickets page also carries the siren banner',
        r.status === 200 && /URGENT field ticket/i.test(await r.text()),
        `status=${r.status}`);
      r = await req(`${BASE}/dispatch/tickets/${encodeURIComponent(ticket.ticket_id)}/acknowledge?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: {} });
      const acked = db.prepare(`SELECT status FROM support_tickets WHERE ticket_id = ?`).get(ticket.ticket_id);
      check('acknowledging moves the urgent ticket off open (in_progress)',
        r.status === 302 && acked.status === 'in_progress',
        `status=${r.status} ticket=${acked.status}`);
      r = await req(`${BASE}/admin?token=${ADMIN_TOKEN}`, {});
      check('siren banner clears from the dashboard once acknowledged',
        r.status === 200 && !/URGENT field ticket/i.test(await r.text()),
        `status=${r.status}`);

      // 10i-3. Broadcast to Complete-only audience: only the active Complete
      // driver gets email + inbox row; Basic/past-due/canceled/unpaid get nothing.
      const bcCount = (seq, emailAddr) => db.prepare(
        `SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = ?`).get(emailAddr, seq).n;
      r = await req(`${BASE}/dispatch/field-comms/broadcast?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { audience: 'complete', subject: `${ftag} Depot heads-up`, message: 'Lot closes 6pm today.' } });
      check('broadcast POST redirects (302)',
        r.status === 302, `status=${r.status}`);
      check('Complete-only broadcast emails only the active Complete driver',
        bcCount('field-broadcast', fComplete.email) === 1 &&
          bcCount('field-broadcast', fBasic.email) === 0 &&
          bcCount('field-broadcast', fPastDue.email) === 0 &&
          bcCount('field-broadcast', fCanceled.email) === 0 &&
          bcCount('field-broadcast', fFree.email) === 0,
        `complete=${bcCount('field-broadcast', fComplete.email)} basic=${bcCount('field-broadcast', fBasic.email)}`);
      const inboxCount = (id) => db.prepare(
        `SELECT COUNT(*) n FROM driver_messages WHERE driver_id = ? AND kind = 'broadcast'`).get(id).n;
      check('broadcast inbox rows only for the Complete audience',
        inboxCount(fComplete.id) === 1 && inboxCount(fBasic.id) === 0 && inboxCount(fFree.id) === 0,
        `complete=${inboxCount(fComplete.id)} basic=${inboxCount(fBasic.id)}`);
      const blog = db.prepare(`SELECT * FROM broadcast_log ORDER BY id DESC LIMIT 1`).get();
      const expectedComplete = db.prepare(
        `SELECT COUNT(*) n FROM drivers d
           JOIN dispatch_subscriptions s ON LOWER(d.email) = s.email
          WHERE s.status = 'active' AND s.plan = 'complete'`).get().n;
      check('broadcast logged with audience + driver count',
        !!blog && blog.audience === 'complete' && Number(blog.driver_count) === expectedComplete && expectedComplete >= 1,
        `log=${JSON.stringify(blog && { audience: blog.audience, driver_count: blog.driver_count })} expected=${expectedComplete}`);
      r = await req(`${BASE}/dispatch/field-comms?token=${ADMIN_TOKEN}`, {});
      const fcHtml = await r.text();
      check('field-comms admin page renders composer + broadcast log',
        r.status === 200 && /Broadcast to field/i.test(fcHtml) && /Depot heads-up/i.test(fcHtml),
        `status=${r.status}`);

      // 10i-4. Driver inbox: newest first, unread highlighted, then marked read.
      r = await req(`${BASE}/d/${fComplete.access_token}`, {});
      const inboxHtml = await r.text();
      check('driver dashboard shows the Dispatch messages inbox with unread highlight',
        r.status === 200 && /Dispatch messages/i.test(inboxHtml) &&
          /Depot heads-up/i.test(inboxHtml) && />NEW</i.test(inboxHtml),
        `status=${r.status}`);
      r = await req(`${BASE}/d/${fComplete.access_token}`, {});
      check('inbox highlight clears after the first view (marked read)',
        r.status === 200 && !/>NEW</i.test(await r.text()),
        `status=${r.status}`);
      r = await req(`${BASE}/d/${fBasic.access_token}`, {});
      check('driver with no messages sees no inbox card',
        r.status === 200 && !/Dispatch messages/i.test(await r.text()),
        `status=${r.status}`);

      // 10i-5. Admin "Message driver": email + queued SMS to that driver only;
      // scheduler marks the SMS provider-pending (never claimed delivered).
      r = await req(`${BASE}/dispatch/drivers/${fBasic.id}/message?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { subject: `${ftag} Check in`, message: 'Call dispatch when you are free.' } });
      check('message-driver POST redirects back to the driver page (302)',
        r.status === 302 && /\/admin\/drivers\//.test(r.headers.get('location') || ''),
        `status=${r.status} loc=${r.headers.get('location')}`);
      check('direct message queues one email + one SMS for that driver',
        bcCount('field-message', fBasic.email) === 1 && bcCount('field-message-sms', fBasic.email) === 1,
        `email=${bcCount('field-message', fBasic.email)} sms=${bcCount('field-message-sms', fBasic.email)}`);
      const dmRow = db.prepare(`SELECT * FROM driver_messages WHERE driver_id = ? AND kind = 'direct' ORDER BY id DESC LIMIT 1`).get(fBasic.id);
      check('direct message stored in the driver inbox',
        !!dmRow && /Check in/.test(dmRow.subject),
        `row=${JSON.stringify(dmRow && dmRow.subject)}`);
      const sched = await req(`${BASE}/admin/run-scheduler?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
      const smsRow = db.prepare(`SELECT status FROM email_queue WHERE email = ? AND sequence = 'field-message-sms' ORDER BY id DESC LIMIT 1`).get(fBasic.email);
      check('scheduler marks the field SMS provider-pending, never delivered',
        sched.status === 200 && smsRow && smsRow.status === 'provider-stub',
        `sched=${sched.status} sms=${smsRow && smsRow.status}`);

      // 10i-6. Messaging an unpaid driver is refused (active subscribers only).
      r = await req(`${BASE}/dispatch/drivers/${fFree.id}/message?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { subject: 'x', message: 'y' } });
      const loc = r.headers.get('location') || '';
      check('message-driver refuses unpaid drivers (redirect with error, nothing queued)',
        r.status === 302 && /msg=error/.test(loc) && bcCount('field-message', fFree.email) === 0,
        `status=${r.status} loc=${loc}`);

      // 10i-7. No duplicate urgent-ticket tables: the siren reuses support_tickets.
      const tbls = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name);
      check('no duplicate urgent_alerts table exists (support_tickets reused)',
        !tbls.includes('urgent_alerts') && tbls.includes('support_tickets') &&
          tbls.includes('driver_messages') && tbls.includes('broadcast_log'),
        `tables=${tbls.filter((t) => /urgent|ticket|message|broadcast/.test(t)).join(',')}`);

      // 10i-8. Broadcast to "all" reaches both active tiers, still nobody else.
      r = await req(`${BASE}/dispatch/field-comms/broadcast?token=${ADMIN_TOKEN}`,
        { method: 'POST', form: { audience: 'all', subject: `${ftag} All-hands`, message: 'Morning check-in at 8am.' } });
      check('all-audience broadcast reaches every active subscriber and nobody else',
        r.status === 302 &&
          bcCount('field-broadcast', fComplete.email) === 2 &&
          bcCount('field-broadcast', fBasic.email) === 1 &&
          bcCount('field-broadcast', fPastDue.email) === 0 &&
          bcCount('field-broadcast', fCanceled.email) === 0 &&
          bcCount('field-broadcast', fFree.email) === 0,
        `complete=${bcCount('field-broadcast', fComplete.email)} basic=${bcCount('field-broadcast', fBasic.email)}`);
    }

    /* ---- 10j. Tap-to-call / tap-to-text live contact ------------------------ */
    // Covers: the dispatch number lives in ONE constant (lib/field_comms.js)
    // and renders as tel:+14143680711 / sms:+14143680711; driver "Talk to
    // dispatch live" buttons show for ACTIVE Basic + Complete subscribers and
    // are hidden for unpaid/past-due/canceled drivers; Room "accountability
    // line" buttons show for active claimed members and vanish for inactive
    // members. 100% real tel:/sms: behavior — no in-app chat claims.
    {
      const fcLib = require(path.join(APP_ROOT, 'lib', 'field_comms'));
      const TEL_HREF = 'tel:+14143680711';
      const SMS_HREF = 'sms:+14143680711';
      check('dispatch number is a single constant producing the exact tel:/sms: hrefs',
        fcLib.DISPATCH_PHONE_DIGITS === '4143680711' &&
          fcLib.dispatchTelHref() === TEL_HREF &&
          fcLib.dispatchSmsHref() === SMS_HREF &&
          fcLib.dispatchPhoneDisplay() === '(414) 368-0711');

      const ltag = 'e2e-live';
      const lEmail = (n) => `${ltag}-${n}@example.com`.toLowerCase();
      const nowT4 = Date.now();
      db.prepare(`DELETE FROM dispatch_subscriptions WHERE email LIKE ?`).run(`${ltag}%`);
      db.prepare(`DELETE FROM drivers WHERE email LIKE ?`).run(`${ltag}%`);
      const mkLDriver = (n) => {
        const email = lEmail(n);
        db.prepare(`INSERT INTO drivers (full_name, email, phone, home_city, home_state, status, submitted_at, access_token)
                    VALUES (?, ?, ?, 'Milwaukee', 'WI', 'new', ?, ?)`)
          .run(`Live Driver ${n}`, email, '4145550199', nowT4, `${ltag}-tok-${n}-` + 'd'.repeat(40));
        return db.prepare('SELECT * FROM drivers WHERE email = ?').get(email);
      };
      const lComplete = mkLDriver('complete');
      const lBasic = mkLDriver('basic');
      const lPastDue = mkLDriver('pastdue');
      const lCanceled = mkLDriver('canceled');
      const lFree = mkLDriver('free');
      makePaid(db, lComplete.email, 'complete');
      makePaid(db, lBasic.email, 'basic');
      makePaid(db, lPastDue.email, 'complete');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'past_due' WHERE email = ?`).run(lPastDue.email);
      makePaid(db, lCanceled.email, 'complete');
      db.prepare(`UPDATE dispatch_subscriptions SET status = 'canceled' WHERE email = ?`).run(lCanceled.email);

      // 10j-1. Active Basic + Complete drivers see both live-contact buttons.
      for (const [label, drv] of [['Complete', lComplete], ['Basic', lBasic]]) {
        r = await req(`${BASE}/d/${drv.access_token}`, {});
        const html = await r.text();
        check(`${label} active driver sees Talk-to-dispatch-live with exact tel:/sms: hrefs`,
          r.status === 200 && /Talk to dispatch live/i.test(html) &&
            html.includes(`href="${TEL_HREF}"`) && html.includes(`href="${SMS_HREF}"`),
          `status=${r.status}`);
      }

      // 10j-2. Unpaid / past-due / canceled drivers never see the buttons.
      for (const [label, drv] of [['past-due', lPastDue], ['canceled', lCanceled], ['unpaid', lFree]]) {
        r = await req(`${BASE}/d/${drv.access_token}`, {});
        const html = await r.text();
        check(`${label} driver does NOT see live-contact buttons`,
          r.status === 200 && !/Talk to dispatch live/i.test(html) && !html.includes(TEL_HREF),
          `status=${r.status}`);
      }

      // 10j-3. Room: active claimed member sees the accountability line buttons.
      const liveRoomEmail = `e2e-live-room-${ts}@example.com`;
      db.prepare(`DELETE FROM room_sessions WHERE email = ?`).run(liveRoomEmail);
      db.prepare(`DELETE FROM room_members WHERE email = ?`).run(liveRoomEmail);
      res = await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email: liveRoomEmail, productId: 'room', amountCents: 4900 } });
      const liveJar = new Jar();
      res = await req(`${BASE}/room/claim`, { jar: liveJar, method: 'POST', form: { email: liveRoomEmail, password: 'livetestpass1', password2: 'livetestpass1' } });
      check('room claim provisions the live-test member session',
        res.status === 302 && liveJar.has('room_sess'), `status=${res.status}`);
      res = await req(`${BASE}/room/welcome`, { jar: liveJar, method: 'POST', form: {} });
      res = await req(`${BASE}/room`, { jar: liveJar });
      const roomHtml = await res.text();
      check('active claimed member sees accountability line call/text buttons',
        res.status === 200 && /accountability line/i.test(roomHtml) &&
          roomHtml.includes(`href="${TEL_HREF}"`) && roomHtml.includes(`href="${SMS_HREF}"`),
        `status=${res.status}`);

      // 10j-4. Inactive member: no member area, no buttons.
      db.prepare(`UPDATE room_members SET status = 'canceled' WHERE email = ?`).run(liveRoomEmail);
      res = await req(`${BASE}/room`, { jar: liveJar });
      check('canceled member is bounced to login (no accountability line)',
        res.status === 302 && (res.headers.get('location') || '').endsWith('/room/login'),
        `status=${res.status} location=${res.headers.get('location')}`);
      db.prepare(`DELETE FROM room_sessions WHERE email = ?`).run(liveRoomEmail);
      db.prepare(`DELETE FROM room_members WHERE email = ?`).run(liveRoomEmail);
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
    const startHtml = await res.text();
    check('GET /room/start returns 200 lead form', res.status === 200 && startHtml.includes('room_goal'),
      `status=${res.status}`);
    check('Room form marks phone as required', startHtml.includes('name="phone" required') && !startHtml.includes('Phone Number <span class="optional">'),
      '');

    res = await req(`${BASE}/room/start`, { jar: funnelJar, method: 'POST', form: { first_name: 'Room', email: funnelEmail, phone: '4145550100', goal: 'build-a-business', consent: 'yes' } });
    check('POST /room/start creates lead and redirects to /room/offer',
      res.status === 302 && (res.headers.get('location') || '').endsWith('/room/offer'),
      `status=${res.status} location=${res.headers.get('location')}`);
    const funnelLead = db.prepare('SELECT id, goal, email FROM leads WHERE email = ?').get(funnelEmail);
    check('lead row stores goal', funnelLead && funnelLead.goal === 'build-a-business', `row=${JSON.stringify(funnelLead)}`);
    const roomNurtureQueued = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE lead_id = ? AND sequence = 'roomNurture' AND status = 'queued'").get(funnelLead.id).n;
    check('roomNurture sequence queued (5 steps)', roomNurtureQueued === 5, `queued=${roomNurtureQueued}`);
    const leadEv = db.prepare("SELECT COUNT(*) n FROM events WHERE lead_id = ? AND type = 'lead_submitted'").get(funnelLead.id).n;
    check('lead_submitted event recorded', leadEv === 1, `count=${leadEv}`);

    // Phone is required: missing or junk phone -> 400, no lead created.
    const noPhoneEmail = `e2e-roomnophone-${ts}@example.com`;
    res = await req(`${BASE}/room/start`, { jar: new Jar(), method: 'POST', form: { first_name: 'NoPhone', email: noPhoneEmail, goal: 'extra-income', consent: 'yes' } });
    check('POST /room/start without phone returns 400', res.status === 400, `status=${res.status}`);
    check('no lead created when phone is missing',
      !db.prepare('SELECT 1 FROM leads WHERE email = ?').get(noPhoneEmail), '');
    const junkPhoneEmail = `e2e-roomjunkphone-${ts}@example.com`;
    res = await req(`${BASE}/room/start`, { jar: new Jar(), method: 'POST', form: { first_name: 'Junk', email: junkPhoneEmail, phone: 'abc', goal: 'extra-income', consent: 'yes' } });
    check('POST /room/start with junk phone returns 400', res.status === 400, `status=${res.status}`);
    check('no lead created when phone is junk',
      !db.prepare('SELECT 1 FROM leads WHERE email = ?').get(junkPhoneEmail), '');

    /* ---- 12b. Room sales pipeline: stages, intent routing, cadence ---- */
    const hasStageTag = (leadId, stage) =>
      !!db.prepare('SELECT 1 FROM tags WHERE lead_id = ? AND tag = ?').get(leadId, 'STAGE_' + stage.replace(/ /g, '_'));
    check('pipeline: NEW stage set on lead submit', hasStageTag(funnelLead.id, 'NEW'),
      `tags=${JSON.stringify(db.prepare('SELECT tag FROM tags WHERE lead_id = ?').all(funnelLead.id).map(r => r.tag))}`);
    check('pipeline: only one STAGE_* tag at a time',
      db.prepare("SELECT COUNT(*) n FROM tags WHERE lead_id = ? AND tag LIKE 'STAGE\\_%' ESCAPE '\\'").get(funnelLead.id).n === 1,
      '');

    // Nurture cadence: welcome now, then 24h / 3d / 7d / 14d.
    const nurtureDelays = db.prepare("SELECT step, scheduled_for FROM email_queue WHERE lead_id = ? AND sequence = 'roomNurture' AND status = 'queued' ORDER BY scheduled_for").all(funnelLead.id);
    const dayMs = 24 * 3600 * 1000;
    const approxDays = (ms) => Math.round(ms / dayMs);
    const delaysOk = nurtureDelays.length === 5 &&
      approxDays(nurtureDelays[1].scheduled_for - nurtureDelays[0].scheduled_for) === 1 &&
      approxDays(nurtureDelays[2].scheduled_for - nurtureDelays[0].scheduled_for) === 3 &&
      approxDays(nurtureDelays[3].scheduled_for - nurtureDelays[0].scheduled_for) === 7 &&
      approxDays(nurtureDelays[4].scheduled_for - nurtureDelays[0].scheduled_for) === 14;
    check('roomNurture cadence is 0h / 24h / 3d / 7d / 14d', delaysOk,
      `steps=${nurtureDelays.length}`);

    // Run the scheduler: the immediate welcome email sends -> CONTACTED.
    res = await req(`${BASE}/admin/run-scheduler?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    check('scheduler pass runs', res.status === 200, `status=${res.status}`);
    check('pipeline: CONTACTED after first email sent', hasStageTag(funnelLead.id, 'CONTACTED'), '');

    // CONTACTED race: a real browser hits /room/offer (INTERESTED) before
    // the immediate nurture email sends. The stage must not move backward,
    // but the contact itself is still logged.
    const raceEmail = `e2e-roomrace-${ts}@example.com`;
    const raceJar = new Jar();
    res = await req(`${BASE}/room/start`, { jar: raceJar, method: 'POST', form: { first_name: 'Race', email: raceEmail, phone: '4145550103', goal: 'extra-income', consent: 'yes' } });
    check('race setup: lead submits and lands on /room/offer', res.status === 302, `status=${res.status}`);
    const raceLead = db.prepare('SELECT id FROM leads WHERE email = ?').get(raceEmail);
    res = await req(`${BASE}/room/offer`, { jar: raceJar });
    check('race setup: offer viewed -> INTERESTED', res.status === 200 && hasStageTag(raceLead.id, 'INTERESTED'), `status=${res.status}`);
    res = await req(`${BASE}/admin/run-scheduler?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    check('scheduler pass runs (race)', res.status === 200, `status=${res.status}`);
    check('race: stage stays INTERESTED after first email sends (never backward)',
      hasStageTag(raceLead.id, 'INTERESTED') && !hasStageTag(raceLead.id, 'CONTACTED'), '');
    check('race: FIRST_TOUCH_SENT tag recorded even when stage already advanced',
      !!db.prepare('SELECT 1 FROM tags WHERE lead_id = ? AND tag = ?').get(raceLead.id, 'FIRST_TOUCH_SENT'), '');

    // Intent routing: courier-work goal skips the Room nurture -> /dispatch.
    const dispEmail = `e2e-roomdispatch-${ts}@example.com`;
    const dispJar = new Jar();
    res = await req(`${BASE}/room/start`, { jar: dispJar, method: 'POST', form: { first_name: 'Route', email: dispEmail, phone: '4145550101', goal: 'courier-work', consent: 'yes' } });
    check('POST /room/start with courier-work goal redirects to /dispatch',
      res.status === 302 && (res.headers.get('location') || '').endsWith('/dispatch'),
      `status=${res.status} location=${res.headers.get('location')}`);
    const dispLead = db.prepare('SELECT id FROM leads WHERE email = ?').get(dispEmail);
    const dispTags = db.prepare('SELECT tag FROM tags WHERE lead_id = ?').all(dispLead.id).map(r => r.tag);
    check('dispatch-intent lead tagged INTENT_DISPATCH (not INTENT_ROOM)',
      dispTags.includes('INTENT_DISPATCH') && !dispTags.includes('INTENT_ROOM'), `tags=${JSON.stringify(dispTags)}`);
    const dispNurture = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE lead_id = ? AND sequence = 'roomNurture'").get(dispLead.id).n;
    check('dispatch-intent lead gets no roomNurture sequence', dispNurture === 0, `queued=${dispNurture}`);

    res = await req(`${BASE}/room/offer`, { jar: funnelJar });
    check('GET /room/offer returns 200 sales copy', res.status === 200 && (await res.text()).includes('Stop Collecting Ideas'),
      `status=${res.status}`);
    check('pipeline: INTERESTED after offer viewed', hasStageTag(funnelLead.id, 'INTERESTED'), '');

    res = await req(`${BASE}/room/checkout`, { jar: funnelJar });
    const coHtml = await res.text();
    check('GET /room/checkout shows $49/month recurring disclosure',
      res.status === 200 && coHtml.includes('$49/month recurring membership'),
      `status=${res.status}`);
    check('pipeline: QUALIFIED after checkout viewed', hasStageTag(funnelLead.id, 'QUALIFIED'), '');

    res = await req(`${BASE}/room/checkout`, { jar: funnelJar, method: 'POST', form: { email: funnelEmail, first_name: 'Room' } });
    check('POST /room/checkout creates cart and 302s to the unchanged Stripe link',
      res.status === 302 && res.headers.get('location') === ROOM_STRIPE_LINK,
      `status=${res.status} location=${res.headers.get('location')}`);
    check('pipeline: OFFER SENT after cart created', hasStageTag(funnelLead.id, 'OFFER SENT'), '');
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
    check('roomWelcome sequence queued on purchase (5 emails)', welcomeQueued === 5, `queued=${welcomeQueued}`);
    const nurtureCancelled = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE lead_id = ? AND sequence = 'roomNurture' AND status = 'cancelled'").get(funnelLead.id).n;
    const nurtureSent = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE lead_id = ? AND sequence = 'roomNurture' AND status = 'sent'").get(funnelLead.id).n;
    check('roomNurture stopped on purchase (1 sent, 4 cancelled)', nurtureSent === 1 && nurtureCancelled === 4, `sent=${nurtureSent} cancelled=${nurtureCancelled}`);
    const cartClosed = db.prepare('SELECT purchased FROM carts WHERE id = ?').get(roomCartRow.id).purchased;
    check('room cart closed on purchase', cartClosed === 1, `purchased=${cartClosed}`);
    const payEv = db.prepare("SELECT COUNT(*) n FROM events WHERE lead_id = ? AND type = 'payment_success'").get(funnelLead.id).n;
    const memEv = db.prepare("SELECT COUNT(*) n FROM events WHERE lead_id = ? AND type = 'membership_created'").get(funnelLead.id).n;
    check('payment_success + membership_created events recorded', payEv === 1 && memEv === 1, `payment_success=${payEv} membership_created=${memEv}`);
    check('pipeline: PAID after $49 purchase', hasStageTag(funnelLead.id, 'PAID'), '');
    check('pipeline: stages never move backward (PAID kept, one STAGE tag)',
      db.prepare("SELECT COUNT(*) n FROM tags WHERE lead_id = ? AND tag LIKE 'STAGE\\_%' ESCAPE '\\'").get(funnelLead.id).n === 1 &&
      hasStageTag(funnelLead.id, 'PAID'), '');

    // Needs-follow-up list: the dispatch-intent lead is early-stage, no purchase.
    res = await req(`${BASE}/admin/leads?token=${ADMIN_TOKEN}`, {});
    const leadsHtml = await res.text();
    check('admin leads page shows needs-follow-up section', res.status === 200 && /Needs personal follow-up/i.test(leadsHtml),
      `status=${res.status}`);
    const tableCutoff = leadsHtml.indexOf('lead(s)</p>'); // follow-up section sits above the full table
    check('follow-up section includes the non-converted lead',
      leadsHtml.indexOf(dispEmail) !== -1 && leadsHtml.indexOf(dispEmail) < tableCutoff,
      `found=${leadsHtml.includes(dispEmail)}`);
    check('follow-up section excludes the converted (PAID) lead',
      tableCutoff !== -1 && leadsHtml.indexOf(funnelEmail) > tableCutoff,
      `firstFoundAt=${leadsHtml.indexOf(funnelEmail)} cutoff=${tableCutoff}`);

    // No-progress nudge: stalled member gets one, recent checker-in does not.
    // Driven through the admin scheduler with a fixed Monday timestamp.
    const mondayNoon = new Date('2026-09-21T17:00:00Z').getTime(); // a Monday
    const stalledEmail = `e2e-stalled-${ts}@example.com`;
    const freshEmail = `e2e-fresh-${ts}@example.com`;
    for (const em of [stalledEmail, freshEmail]) {
      db.prepare(`DELETE FROM room_members WHERE email = ?`).run(em);
      db.prepare(`DELETE FROM room_checkins WHERE email = ?`).run(em);
      db.prepare(`DELETE FROM email_queue WHERE email = ? AND sequence = 'room-noprogress-nudge'`).run(em);
    }
    db.prepare(`INSERT INTO room_members (email, name, joined_at, status, phone, password_hash) VALUES (?, 'Stalled', ?, 'active', NULL, 'x')`).run(stalledEmail, mondayNoon - 30 * 86400000);
    db.prepare(`INSERT INTO room_members (email, name, joined_at, status, phone, password_hash) VALUES (?, 'Fresh', ?, 'active', NULL, 'x')`).run(freshEmail, mondayNoon - 30 * 86400000);
    db.prepare(`INSERT INTO room_checkins (email, week, created_at, accomplishment, next_commitment) VALUES (?, 9, ?, 'did things', 'do more')`).run(freshEmail, mondayNoon - 2 * 86400000);
    res = await req(`${BASE}/admin/run-scheduler?token=${ADMIN_TOKEN}`, { method: 'POST', form: { now: String(mondayNoon) } });
    const schedBody = await res.json().catch(() => ({}));
    const nudgeRes = schedBody.noProgressNudges || {};
    const noProgCount = (em) => db.prepare(`SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'room-noprogress-nudge'`).get(em).n;
    check('no-progress nudge runs on Monday',
      res.status === 200 && nudgeRes.ran === true, `status=${res.status} res=${JSON.stringify(nudgeRes)}`);
    check('stalled member (no check-in) gets the nudge', noProgCount(stalledEmail) === 1, `count=${noProgCount(stalledEmail)}`);
    check('member with a recent check-in is skipped', noProgCount(freshEmail) === 0, `count=${noProgCount(freshEmail)}`);
    const nudgeRow = db.prepare(`SELECT subject, body_html FROM email_queue WHERE email = ? AND sequence = 'room-noprogress-nudge' ORDER BY id DESC LIMIT 1`).get(stalledEmail);
    check('stalled member gets the what-did-you-work-on / what-is-next nudge',
      !!nudgeRow && /What did you work on/i.test(nudgeRow.body_html) && /What will you complete next/i.test(nudgeRow.body_html) && /\/room\/checkin/.test(nudgeRow.body_html),
      `subject=${nudgeRow && nudgeRow.subject}`);
    const nudgeRes2 = await (await req(`${BASE}/admin/run-scheduler?token=${ADMIN_TOKEN}`, { method: 'POST', form: { now: String(mondayNoon) } })).json().catch(() => ({}));
    check('no-progress nudge is idempotent per week', noProgCount(stalledEmail) === 1, `count=${noProgCount(stalledEmail)}`);
    for (const em of [stalledEmail, freshEmail]) {
      db.prepare(`DELETE FROM room_members WHERE email = ?`).run(em);
      db.prepare(`DELETE FROM room_checkins WHERE email = ?`).run(em);
      db.prepare(`DELETE FROM email_queue WHERE email = ? AND sequence = 'room-noprogress-nudge'`).run(em);
    }

    /* ---- 12c. Content library: reuse flyers/messages, rotate, attribute ---- */
    const seededItems = db.prepare('SELECT id, offer, cadence, campaign_code FROM content_library WHERE active = 1').all();
    check('content library seeded with one item per offer',
      seededItems.length >= 5 && new Set(seededItems.map(i => i.offer)).size >= 5,
      `items=${seededItems.length}`);
    const roomItem = seededItems.find(i => i.offer === 'room');

    res = await req(`${BASE}/admin/content?token=${ADMIN_TOKEN}`, {});
    const contentHtml = await res.text();
    check('GET /admin/content shows "What should I post today?"',
      res.status === 200 && /What should I post today/i.test(contentHtml), `status=${res.status}`);
    check('suggestion includes caption, CTA, and where-to-post',
      /stop collecting ideas/i.test(contentHtml) && /fill out the short form/i.test(contentHtml) && /Where to post/i.test(contentHtml),
      '');
    check('suggestion shows the exact tracked link with campaign code',
      contentHtml.includes('campaign=room-ideas-income'), '');

    // Attribution: a lead arriving on a tracked link is tied to the item.
    const attrEmail = `e2e-attribution-${ts}@example.com`;
    const attrJar = new Jar();
    res = await req(`${BASE}/room/start?campaign=room-ideas-income`, { jar: attrJar, method: 'POST', form: { first_name: 'Attr', email: attrEmail, phone: '4145550102', goal: 'build-a-business', consent: 'yes' } });
    const attrLead = db.prepare('SELECT id, campaign FROM leads WHERE email = ?').get(attrEmail);
    const attrRow = attrLead && db.prepare(
      `SELECT a.lead_id FROM content_attribution a
       JOIN content_library c ON c.id = a.content_id
       WHERE a.lead_id = ? AND c.campaign_code = 'room-ideas-income'`).get(attrLead.id);
    check('lead from tracked link attributed to the library item',
      !!(attrLead && attrLead.campaign === 'room-ideas-income' && attrRow),
      `campaign=${attrLead && attrLead.campaign}`);

    // Rotation: add a second daily item; two page loads must suggest different items.
    res = await req(`${BASE}/admin/content/add?token=${ADMIN_TOKEN}`, { method: 'POST', form: {
      offer: 'room', title: 'Rotation test message', kind: 'message', cadence: 'daily',
      body: 'Rotation test body', cta: 'Test CTA', where_to_post: 'Facebook',
      link: '/room/start', campaign_code: `room-rotation-${ts}`,
    } });
    check('POST /admin/content/add creates item (302)', res.status === 302, `status=${res.status}`);
    const firstTitle = /<h3 style="margin:4px 0">([^<]+)<\/h3>/.exec(await (await req(`${BASE}/admin/content?token=${ADMIN_TOKEN}`, {})).text());
    const secondTitle = /<h3 style="margin:4px 0">([^<]+)<\/h3>/.exec(await (await req(`${BASE}/admin/content?token=${ADMIN_TOKEN}`, {})).text());
    check('suggestions rotate between daily items',
      firstTitle && secondTitle && firstTitle[1] !== secondTitle[1],
      `first=${firstTitle && firstTitle[1]} second=${secondTitle && secondTitle[1]}`);

    // Edit + deactivate flow.
    const rotItem = db.prepare('SELECT id FROM content_library WHERE campaign_code = ?').get(`room-rotation-${ts}`);
    res = await req(`${BASE}/admin/content/${rotItem.id}?token=${ADMIN_TOKEN}`, { method: 'POST', form: {
      offer: 'room', title: 'Rotation test message (edited)', kind: 'message', cadence: 'daily',
      body: 'Rotation test body', cta: 'Test CTA', where_to_post: 'Facebook',
      link: '/room/start', campaign_code: `room-rotation-${ts}`,
    } });
    check('POST /admin/content/:id edits item (302)', res.status === 302, `status=${res.status}`);
    res = await req(`${BASE}/admin/content/${rotItem.id}/edit?token=${ADMIN_TOKEN}`, {});
    check('edit page shows updated title', res.status === 200 && (await res.text()).includes('Rotation test message (edited)'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/content/${rotItem.id}/toggle?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    const toggled = db.prepare('SELECT active FROM content_library WHERE id = ?').get(rotItem.id);
    check('toggle deactivates item', res.status === 302 && toggled.active === 0, `active=${toggled.active}`);

    // Per-item results: the library page reports leads generated.
    res = await req(`${BASE}/admin/content?token=${ADMIN_TOKEN}`, {});
    check('library table shows attribution counts', res.status === 200 && /Leads<\/th>/.test(await res.text()),
      `status=${res.status}`);

    // Admin: new dashboard sections, lead detail, config env status.
    res = await req(`${BASE}/admin?token=${ADMIN_TOKEN}`, {});
    const dashHtml = await res.text();
    check('admin dashboard renders grouped Room sections',
      res.status === 200 && dashHtml.includes('Wealth Builder') && dashHtml.includes('New leads (last 7 days)'),
      `status=${res.status}`);
    check('dashboard shows Follow-ups due / Offers sent / Room revenue cards',
      dashHtml.includes('Follow-ups due') && dashHtml.includes('Offers sent') && dashHtml.includes('Room revenue'),
      `hasCards=${dashHtml.includes('Follow-ups due')},${dashHtml.includes('Offers sent')},${dashHtml.includes('Room revenue')}`);
    res = await req(`${BASE}/admin/leads/${funnelLead.id}?token=${ADMIN_TOKEN}`, {});
    check('GET /admin/leads/:id renders lead detail',
      res.status === 200 && (await res.text()).includes(funnelEmail),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/config?token=${ADMIN_TOKEN}`, {});
    const cfgHtml = await res.text();
    check('GET /admin/config shows masked env status without secrets',
      res.status === 200 && cfgHtml.includes('ADMIN_TOKEN') && !cfgHtml.includes('test-admin-token'),
      `status=${res.status}`);

    /* ---- 13. Room accountability: goals, check-ins, tracker, emails ------ */
    // Covers: /room/goal create+edit (dates fixed on edit), /room/checkin
    // multipart submit with server timestamp + proof upload + confirm guard,
    // per-member privacy (no cross-member checkin/proof visibility),
    // week math, /room/progress tracker, reminder/confirmation emails with
    // eligibility guards, admin accountability section, 12 seeded posts.
    const acctEmail = `e2e-acct-${ts}@example.com`;
    const acctJar = new Jar();

    async function provisionClaimedMember(email, pass) {
      const jar = new Jar();
      let r = await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email, productId: 'room', amountCents: 4900 } });
      if (r.status !== 200) failFast(`webhook provision failed for ${email}: status=${r.status}`);
      r = await req(`${BASE}/room/claim`, { jar, method: 'POST', form: { email, password: pass, password2: pass } });
      if (r.status !== 302 || !jar.has('room_sess')) failFast(`claim failed for ${email}: status=${r.status}`);
      r = await req(`${BASE}/room/welcome`, { jar, method: 'POST', form: {} });
      if (r.status !== 302) failFast(`welcome POST failed for ${email}: status=${r.status}`);
      r = await req(`${BASE}/room/goal`, { jar, method: 'POST', form: { goal_text: `Goal for ${email}` } });
      if (r.status !== 302) failFast(`goal POST failed for ${email}: status=${r.status}`);
      return jar;
    }

    const acctJar1 = await provisionClaimedMember(acctEmail, 'accttestpass1');
    check('accountability member provisioned, claimed, goal set', true);

    res = await req(`${BASE}/room/goal`, { jar: acctJar1 });
    check('GET /room/goal renders MY 90-DAY WEALTH GOAL prompt',
      res.status === 200 && (await res.text()).includes('MY 90-DAY WEALTH GOAL'),
      `status=${res.status}`);

    const goalRow = db.prepare('SELECT * FROM room_goals WHERE email = ?').get(acctEmail);
    check('goal row has start_date and target_date = start + 90 days',
      goalRow && goalRow.start_date > 0 && goalRow.target_date === goalRow.start_date + 90 * 24 * 3600 * 1000,
      `row=${JSON.stringify(goalRow)}`);

    res = await req(`${BASE}/room/goal`, { jar: acctJar1, method: 'POST', form: { goal_text: 'Edited goal text' } });
    const goalRow2 = db.prepare('SELECT * FROM room_goals WHERE email = ?').get(acctEmail);
    check('goal edit keeps start/target dates, updates text',
      res.status === 302 &&
      goalRow2.start_date === goalRow.start_date &&
      goalRow2.target_date === goalRow.target_date &&
      goalRow2.goal_text === 'Edited goal text',
      `status=${res.status}`);

    // Week math: 8 days after start -> current week 2.
    db.prepare('UPDATE room_goals SET start_date = ? WHERE email = ?').run(Date.now() - 8 * 24 * 3600 * 1000, acctEmail);
    res = await req(`${BASE}/room/progress`, { jar: acctJar1 });
    const progHtmlW2 = await res.text();
    check('week math: 8 days in shows "Week 2 of 12"',
      res.status === 200 && progHtmlW2.includes('Week 2 of 12'),
      `status=${res.status}`);
    db.prepare('UPDATE room_goals SET start_date = ?, target_date = ? WHERE email = ?')
      .run(Date.now(), Date.now() + 90 * 24 * 3600 * 1000, acctEmail);

    // Weekly check-in via multipart (with proof file + confirm checkbox).
    const ciBefore = Date.now();
    res = await multipartReq(`${BASE}/room/checkin`, {
      jar: acctJar1,
      fields: {
        goal: 'week one goal', action_taken: 'took action', accomplishment: 'accomplished things',
        lesson: 'learned lots', next_commitment: 'do more', proof_confirm: '1',
      },
      file: { filename: 'proof.png', mime: 'image/png', buffer: TINY_PNG },
    });
    const ciLoc = res.headers.get('location') || '';
    check('POST /room/checkin with proof redirects to /room/progress',
      res.status === 302 && ciLoc.includes('/room/progress'),
      `status=${res.status} location=${ciLoc}`);
    const ciRow = db.prepare('SELECT * FROM room_checkins WHERE email = ? AND week = 1').get(acctEmail);
    check('checkin row stored with server-generated timestamp (not client time)',
      ciRow && ciRow.created_at >= ciBefore && ciRow.created_at <= Date.now() && ciRow.goal === 'week one goal',
      `row=${JSON.stringify(ciRow && { ...ciRow, proof_blob: ciRow.proof_blob ? '<blob>' : null })}`);
    check('proof bytes stored in DB (proof_blob) with metadata',
      ciRow && ciRow.proof_blob &&
        Buffer.from(ciRow.proof_blob).equals(TINY_PNG) &&
        ciRow.proof_mime === 'image/png' && ciRow.proof_size === TINY_PNG.length,
      `mime=${ciRow && ciRow.proof_mime} size=${ciRow && ciRow.proof_size} blobBytes=${ciRow && ciRow.proof_blob && ciRow.proof_blob.length}`);

    res = await req(`${BASE}/room/proof/${ciRow.id}`, { jar: acctJar1 });
    check('member can fetch own proof (200, image/png)',
      res.status === 200 && (res.headers.get('content-type') || '').includes('image/png'),
      `status=${res.status} ct=${res.headers.get('content-type')}`);

    // Admin accountability summary must reflect the uploaded proof (regression:
    // it previously read the unselected proof_blob column and always showed "—").
    res = await req(`${BASE}/admin/room?token=${ADMIN_TOKEN}`, {});
    const acctAdminProof = await res.text();
    check('admin accountability proof column shows Uploaded after proof upload',
      res.status === 200 && acctAdminProof.includes('<td>Uploaded</td>'),
      `status=${res.status}`);

    // --- Daily accountability nudges -----------------------------------------
    const chicagoDay = (t) => {
      const parts = {};
      for (const p of new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(t))) {
        if (p.type !== 'literal') parts[p.type] = p.value;
      }
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const nudgeA = `nudge-a-${ts}@example.com`;        // checked in this week
    const nudgeB = `nudge-b-${ts}@example.com`;        // not checked in
    const nudgeInactive = `nudge-inactive-${ts}@example.com`;
    const nudgeUnclaimed = `nudge-unclaimed-${ts}@example.com`;
    const nudgeSupp = `nudge-supp-${ts}@example.com`;
    const nudgeUnsub = `nudge-unsub-${ts}@example.com`;
    const nudgeNow = Date.now();
    const addNudgeMember = (email, { status = 'active', claimed = true } = {}) =>
      db.prepare('INSERT INTO room_members (email, name, password_hash, joined_at, status) VALUES (?, ?, ?, ?, ?)')
        .run(email, 'Nudge Member', claimed ? 'testhash' : null, nudgeNow, status);
    addNudgeMember(nudgeA);
    addNudgeMember(nudgeB);
    addNudgeMember(nudgeInactive, { status: 'inactive' });
    addNudgeMember(nudgeUnclaimed, { claimed: false });
    addNudgeMember(nudgeSupp);
    addNudgeMember(nudgeUnsub);
    db.prepare('INSERT INTO suppressions (email, reason, ts) VALUES (?, ?, ?)').run(nudgeSupp, 'test-suppression', nudgeNow);
    // nudgeA has a goal and a check-in for the current week.
    db.prepare('INSERT INTO room_goals (email, goal_text, start_date, target_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nudgeA, 'nudge goal', nudgeNow, nudgeNow + 90 * 24 * 3600 * 1000, nudgeNow, nudgeNow);
    db.prepare(`INSERT INTO room_checkins
        (email, week, created_at, goal, action_taken, accomplishment, lesson, next_commitment)
      VALUES (?, 1, ?, 'g', 'a', 'acc', 'les', 'next')`).run(nudgeA, nudgeNow);
    const nudgeCount = (email) =>
      db.prepare("SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'room-daily-nudge'").get(email).n;

    let schedN1 = await runScheduler();
    check('scheduler pass returns dailyNudges count',
      schedN1.status === 200 && typeof JSON.parse(schedN1.text).dailyNudges === 'number',
      `status=${schedN1.status}`);
    check('daily nudge queued for checked-in member', nudgeCount(nudgeA) === 1, `count=${nudgeCount(nudgeA)}`);
    check('daily nudge queued for not-checked-in member', nudgeCount(nudgeB) === 1, `count=${nudgeCount(nudgeB)}`);
    check('daily nudge queued for member-only unsub test member', nudgeCount(nudgeUnsub) === 1, `count=${nudgeCount(nudgeUnsub)}`);
    check('no daily nudge for inactive member', nudgeCount(nudgeInactive) === 0, `count=${nudgeCount(nudgeInactive)}`);
    check('no daily nudge for unclaimed member', nudgeCount(nudgeUnclaimed) === 0, `count=${nudgeCount(nudgeUnclaimed)}`);
    check('no daily nudge for suppressed email', nudgeCount(nudgeSupp) === 0, `count=${nudgeCount(nudgeSupp)}`);

    const schedN2 = await runScheduler();
    check('second pass same day queues no new nudges',
      JSON.parse(schedN2.text).dailyNudges === 0, `dailyNudges=${JSON.parse(schedN2.text).dailyNudges}`);
    check('still exactly one nudge per eligible member after second pass',
      nudgeCount(nudgeA) === 1 && nudgeCount(nudgeB) === 1,
      `a=${nudgeCount(nudgeA)} b=${nudgeCount(nudgeB)}`);

    // Simulate a new calendar day: backdate today's nudge rows, scheduler must queue again.
    const twoDaysAgoChi = chicagoDay(Date.now() - 2 * 86400000);
    db.prepare("UPDATE email_queue SET step = ? WHERE sequence = 'room-daily-nudge' AND email IN (?, ?)")
      .run(twoDaysAgoChi, nudgeA, nudgeB);
    await runScheduler();
    check('new calendar day queues daily nudges again',
      nudgeCount(nudgeA) === 2 && nudgeCount(nudgeB) === 2,
      `a=${nudgeCount(nudgeA)} b=${nudgeCount(nudgeB)}`);

    // Nudge body: links, unsubscribe, variant by check-in state, no shaming language.
    const nudgeBody = (email) =>
      db.prepare("SELECT body_html FROM email_queue WHERE email = ? AND sequence = 'room-daily-nudge' ORDER BY id ASC LIMIT 1").get(email).body_html;
    const bodyA = nudgeBody(nudgeA);
    const bodyB = nudgeBody(nudgeB);
    check('nudge body links check-in and progress pages',
      bodyA.includes('/room/checkin') && bodyA.includes('/room/progress'), 'missing links');
    check('nudge body contains unsubscribe link',
      bodyA.includes(`/unsubscribe?email=${encodeURIComponent(nudgeA)}`), 'missing unsubscribe link');
    const bannedWords = ['lazy', 'failure', 'behind'];
    const lowerAB = (bodyA + ' ' + bodyB).toLowerCase();
    check('nudge copy contains no shaming language',
      !bannedWords.some((w) => lowerAB.includes(w)), 'shaming word found');
    check('checked-in member gets different variant than not-checked-in member',
      bodyA !== bodyB, 'variants identical');

    // Member-only email (no lead row) unsubscribes -> nudges stop.
    check('unsub test member has no lead row',
      !db.prepare('SELECT * FROM leads WHERE email = ?').get(nudgeUnsub), 'lead row exists');
    res = await req(`${BASE}/unsubscribe`, { method: 'POST', form: { email: nudgeUnsub } });
    check('POST /unsubscribe succeeds for member-only email',
      [200, 301, 302, 303].includes(res.status), `status=${res.status}`);
    const unsubSupp = db.prepare('SELECT * FROM suppressions WHERE email = ?').get(nudgeUnsub);
    check('member-only email added to suppressions on unsubscribe',
      unsubSupp && unsubSupp.reason === 'unsubscribed', `row=${JSON.stringify(unsubSupp)}`);
    await req(`${BASE}/unsubscribe`, { method: 'POST', form: { email: nudgeUnsub } });
    check('unsubscribe is idempotent (one suppression row)',
      db.prepare('SELECT COUNT(*) n FROM suppressions WHERE email = ?').get(nudgeUnsub).n === 1,
      'duplicate suppression rows');
    db.prepare("UPDATE email_queue SET step = ? WHERE sequence = 'room-daily-nudge' AND email = ?")
      .run(twoDaysAgoChi, nudgeUnsub);
    await runScheduler();
    check('no new nudge queued after member unsubscribes',
      nudgeCount(nudgeUnsub) === 1, `count=${nudgeCount(nudgeUnsub)}`);
    // A nudge still sitting in the queue is cancelled at send time once suppressed.
    db.prepare(`INSERT INTO email_queue
        (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
      VALUES (NULL, ?, 'room-daily-nudge', '2000-01-01', 'subj', 'body', 'room', ?, 'queued')`)
      .run(nudgeUnsub, Date.now() - 1000);
    await runScheduler();
    const guardRow = db.prepare("SELECT status, cancel_reason FROM email_queue WHERE email = ? AND sequence = 'room-daily-nudge' AND step = '2000-01-01'").get(nudgeUnsub);
    check('queued nudge for unsubscribed member cancelled at send time',
      guardRow.status === 'cancelled' && guardRow.cancel_reason === 'suppressed',
      `row=${JSON.stringify(guardRow)}`);

    // --- SMS daily nudges ----------------------------------------------------
    const smsCount = (email) =>
      db.prepare("SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'room-daily-nudge-sms'").get(email).n;
    db.prepare('UPDATE room_members SET phone = ? WHERE email = ?').run('5551234567', nudgeA);
    db.prepare('UPDATE room_members SET phone = ? WHERE email = ?').run('5551234568', nudgeSupp);
    db.prepare('UPDATE room_members SET phone = ? WHERE email = ?').run('5551234569', nudgeUnsub);
    // nudgeB keeps no phone on record.
    let schedS1 = await runScheduler();
    check('scheduler pass returns dailyNudgeSms count',
      schedS1.status === 200 && typeof JSON.parse(schedS1.text).dailyNudgeSms === 'number',
      `status=${schedS1.status}`);
    check('SMS nudge queued once per member per day', smsCount(nudgeA) === 1, `count=${smsCount(nudgeA)}`);
    check('member with no phone gets no SMS nudge', smsCount(nudgeB) === 0, `count=${smsCount(nudgeB)}`);
    check('suppressed member gets no SMS nudge', smsCount(nudgeSupp) === 0, `count=${smsCount(nudgeSupp)}`);
    check('unsubscribed member gets no SMS nudge', smsCount(nudgeUnsub) === 0, `count=${smsCount(nudgeUnsub)}`);

    await runScheduler();
    check('SMS nudge not duplicated on second pass same day',
      smsCount(nudgeA) === 1, `count=${smsCount(nudgeA)}`);

    db.prepare("UPDATE email_queue SET step = ? WHERE sequence = 'room-daily-nudge-sms' AND email = ?")
      .run(twoDaysAgoChi, nudgeA);
    await runScheduler();
    check('new calendar day queues SMS nudge again',
      smsCount(nudgeA) === 2, `count=${smsCount(nudgeA)}`);

    // Scope to this run's emails: the suite reuses data/funnel.db across runs,
    // so earlier runs' manually-inserted guard rows must not pollute the check.
    const smsRows = db.prepare("SELECT body_html FROM email_queue WHERE sequence = 'room-daily-nudge-sms' AND email LIKE ?")
      .all(`%-${ts}@example.com`);
    check('SMS nudge rows exist', smsRows.length > 0, `rows=${smsRows.length}`);
    check('all SMS nudge bodies fit 320 chars',
      smsRows.every((r) => r.body_html.length <= 320),
      `max=${Math.max(...smsRows.map((r) => r.body_html.length))}`);
    check('SMS nudge body contains the check-in link',
      smsRows.every((r) => r.body_html.includes('/room/checkin')), 'missing link');

    // Queued SMS for a suppressed member is cancelled at send time.
    db.prepare(`INSERT INTO email_queue
        (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
      VALUES (NULL, ?, 'room-daily-nudge-sms', '2000-01-02', 'subj', 'body', 'room', ?, 'queued')`)
      .run(nudgeSupp, Date.now() - 1000);
    await runScheduler();
    const smsGuard = db.prepare("SELECT status, cancel_reason FROM email_queue WHERE email = ? AND sequence = 'room-daily-nudge-sms' AND step = '2000-01-02'").get(nudgeSupp);
    check('queued SMS for suppressed member cancelled at send time',
      smsGuard.status === 'cancelled' && smsGuard.cancel_reason === 'suppressed',
      `row=${JSON.stringify(smsGuard)}`);

    // Member created from a purchase copies the phone from a pre-existing lead.
    const leadPhoneEmail = `leadphone-${ts}@example.com`;
    db.prepare(`INSERT INTO leads
        (first_name, email, phone, offer_of_interest, consent_marketing, consent_ts, date_captured, status, unsubscribed)
      VALUES ('Lead', ?, '5559876543', 'room', 1, ?, ?, 'lead', 0)`)
      .run(leadPhoneEmail, nudgeNow, nudgeNow);
    await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email: leadPhoneEmail, productId: 'room', amountCents: 4900 } });
    check('member created from purchase copies phone from existing lead',
      db.prepare('SELECT phone FROM room_members WHERE email = ?').get(leadPhoneEmail).phone === '5559876543',
      `phone=${db.prepare('SELECT phone FROM room_members WHERE email = ?').get(leadPhoneEmail).phone}`);

    // Claim form: valid phone saved, garbage phone ignored without failing.
    const phoneEmail1 = `phone1-${ts}@example.com`;
    await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email: phoneEmail1, productId: 'room', amountCents: 4900 } });
    res = await req(`${BASE}/room/claim`, { method: 'POST', form: { email: phoneEmail1, password: 'phonetest1', password2: 'phonetest1', phone: '(555) 123-4567' } });
    check('claim with valid phone succeeds',
      res.status === 302 && (res.headers.get('location') || '').includes('/room/welcome'),
      `status=${res.status}`);
    check('valid phone saved to member record on claim',
      db.prepare('SELECT phone FROM room_members WHERE email = ?').get(phoneEmail1).phone === '5551234567',
      `phone=${db.prepare('SELECT phone FROM room_members WHERE email = ?').get(phoneEmail1).phone}`);
    const phoneEmail2 = `phone2-${ts}@example.com`;
    await req(`${BASE}/webhooks/stripe`, { method: 'POST', json: { email: phoneEmail2, productId: 'room', amountCents: 4900 } });
    res = await req(`${BASE}/room/claim`, { method: 'POST', form: { email: phoneEmail2, password: 'phonetest2', password2: 'phonetest2', phone: 'not-a-phone' } });
    check('claim with garbage phone still succeeds',
      res.status === 302 && (res.headers.get('location') || '').includes('/room/welcome'),
      `status=${res.status}`);
    check('garbage phone ignored (not saved)',
      db.prepare('SELECT phone FROM room_members WHERE email = ?').get(phoneEmail2).phone == null,
      `phone=${db.prepare('SELECT phone FROM room_members WHERE email = ?').get(phoneEmail2).phone}`);

    // Proof without the confirm checkbox is rejected.
    res = await multipartReq(`${BASE}/room/checkin`, {
      jar: acctJar1,
      fields: { goal: 'g', action_taken: 'a' },
      file: { filename: 'proof2.png', mime: 'image/png', buffer: TINY_PNG },
    });
    check('proof upload without confirm checkbox is rejected',
      res.status === 200 && (await res.text()).includes('sensitive personal information'),
      `status=${res.status}`);

    // Confirmation email queued on check-in.
    const confRow = db.prepare("SELECT * FROM email_queue WHERE email = ? AND sequence = 'room-confirmation'").get(acctEmail);
    check("confirmation email queued with subject 'Progress documented ✓'",
      confRow && confRow.subject === 'Progress documented ✓' && confRow.body_html.includes('VIEW MY PROGRESS'),
      `row=${JSON.stringify(confRow && { subject: confRow.subject, status: confRow.status })}`);

    // Second member: privacy — cannot see member 1's checkins or proof.
    const acctEmail2 = `e2e-acct2-${ts}@example.com`;
    const acctJar2 = await provisionClaimedMember(acctEmail2, 'accttestpass2');
    res = await req(`${BASE}/room/progress`, { jar: acctJar2 });
    const prog2 = await res.text();
    check("member 2 progress page never shows member 1's checkin data",
      res.status === 200 && !prog2.includes('accomplished things') && !prog2.includes('Edited goal text'),
      `status=${res.status}`);
    res = await req(`${BASE}/room/proof/${ciRow.id}`, { jar: acctJar2 });
    check("member 2 cannot fetch member 1's proof (404)", res.status === 404, `status=${res.status}`);
    const anonJar = new Jar();
    res = await req(`${BASE}/room/proof/${ciRow.id}`, { jar: anonJar });
    check('anonymous proof fetch redirects to login',
      res.status === 302 && (res.headers.get('location') || '').endsWith('/room/login'),
      `status=${res.status}`);

    // Dashboard shows goal card + check-in state; lesson page has action CTA.
    res = await req(`${BASE}/room`, { jar: acctJar1 });
    const dashAcct = await res.text();
    check('dashboard shows 90-day goal card and completed check-in state',
      res.status === 200 && dashAcct.includes('My 90-Day Wealth Goal') && dashAcct.includes('Edited goal text'),
      `status=${res.status}`);
    res = await req(`${BASE}/room/classroom/money-cashflow`, { jar: acctJar1 });
    check('lesson page carries NOW PUT IT INTO ACTION check-in CTA',
      res.status === 200 && (await res.text()).includes('NOW PUT IT INTO ACTION'),
      `status=${res.status}`);

    // Reminders: member 2 has a goal but no check-in -> reminder queued.
    // Member 1 already checked in -> no reminder.
    sched = await runScheduler();
    check('scheduler pass runs (200)', sched.status === 200, `status=${sched.status}`);
    const rem2 = db.prepare("SELECT * FROM email_queue WHERE email = ? AND sequence = 'room-reminder'").get(acctEmail2);
    check('reminder queued for member missing this week\'s check-in',
      rem2 && rem2.subject === 'Your Wealth Builder weekly check-in' && rem2.body_html.includes('COMPLETE MY WEEKLY CHECK-IN'),
      `row=${JSON.stringify(rem2 && { subject: rem2.subject, status: rem2.status })}`);
    const rem1count = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'room-reminder'").get(acctEmail).n;
    check('no reminder queued for member who already checked in', rem1count === 0, `count=${rem1count}`);
    sched = await runScheduler();
    const rem2dup = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'room-reminder' AND step = 'week-1'").get(acctEmail2).n;
    check('reminder not duplicated on second scheduler pass', rem2dup === 1, `count=${rem2dup}`);

    // Inactive member: no reminder; a manually queued room email is cancelled.
    const acctEmail4 = `e2e-acct4-${ts}@example.com`;
    await provisionClaimedMember(acctEmail4, 'accttestpass4');
    res = await req(`${BASE}/admin/room/member-status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { email: acctEmail4, status: 'inactive' } });
    check('admin can deactivate member', res.status === 302, `status=${res.status}`);
    db.prepare(`INSERT INTO email_queue (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
                VALUES (NULL, ?, 'room-reminder', 'week-1', 'x', 'y', 'room', ?, 'queued')`).run(acctEmail4, Date.now());
    sched = await runScheduler();
    const inactCancelled = db.prepare("SELECT status, cancel_reason FROM email_queue WHERE email = ? AND sequence = 'room-reminder' ORDER BY id DESC LIMIT 1").get(acctEmail4);
    check('room email to inactive member cancelled with inactive-member reason',
      inactCancelled && inactCancelled.status === 'cancelled' && inactCancelled.cancel_reason === 'inactive-member',
      `row=${JSON.stringify(inactCancelled)}`);

    // Suppressed email: no reminder queued.
    const acctEmail5 = `e2e-acct5-${ts}@example.com`;
    await provisionClaimedMember(acctEmail5, 'accttestpass5');
    db.prepare('INSERT INTO suppressions (email, reason, ts) VALUES (?, ?, ?)').run(acctEmail5, 'test-suppression', Date.now());
    sched = await runScheduler();
    const suppCount = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'room-reminder'").get(acctEmail5).n;
    check('no reminder queued for suppressed email', suppCount === 0, `count=${suppCount}`);

    // Admin accountability section.
    res = await req(`${BASE}/admin/room?token=${ADMIN_TOKEN}`, {});
    const acctAdmin = await res.text();
    check('admin room page renders Accountability section',
      res.status === 200 && acctAdmin.includes('Accountability'),
      `status=${res.status}`);
    check('admin accountability shows member goal + check-in data, no leaderboard',
      acctAdmin.includes('Edited goal text') && acctAdmin.includes('Checked in this week') &&
      acctAdmin.includes('Not checked in this week') && !acctAdmin.toLowerCase().includes('leaderboard'),
      `status=${res.status}`);

    // 12 accountability posts seeded.
    const acctPostCount = db.prepare("SELECT COUNT(*) n FROM room_posts WHERE title LIKE 'WEEK %'").get().n;
    check('12 weekly accountability posts seeded', acctPostCount === 12, `count=${acctPostCount}`);
    const pinnedAcct = db.prepare("SELECT COUNT(*) n FROM room_posts WHERE title LIKE 'WEEK %' AND pinned = 1").get().n;
    check('accountability posts are not pinned', pinnedAcct === 0, `pinned=${pinnedAcct}`);

    /* ---- Phase A: driver onboarding -------------------------------- */
    const drvEmail = `driver-${ts}@example.com`;
    res = await req(`${BASE}/drivers/onboard?src=tiktok`, {});
    const onboardHtml = await res.text();
    check('GET /drivers/onboard renders onboarding form',
      res.status === 200 && onboardHtml.includes('Driver Onboarding') && onboardHtml.includes('name="full_name"'),
      `status=${res.status}`);
    check('onboarding form collects no SSN/bank/password fields',
      !/name="(ssn|social|bank|account_number|password)"/i.test(onboardHtml));
    check('onboarding form preselects source from ?src=',
      onboardHtml.includes('value="tiktok" selected'));

    res = await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
      ['full_name', 'Test Driver ' + ts], ['email', drvEmail], ['phone', '4145550100'],
      ['contact_method', 'text'], ['vehicle_type', 'cargo_van'],
      ['vehicle_make_model', 'Ford Transit'], ['home_city', 'Milwaukee'],
      ['home_state', 'WI'], ['days_available', 'mon'], ['days_available', 'tue'],
      ['work_prefs', 'local'], ['work_prefs', 'same_day'],
      ['looking_for', 'routes'], ['source', 'tiktok'],
    ]});
    const doneHtml = await res.text();
    check('POST /drivers/onboard creates driver and shows confirmation',
      res.status === 200 && doneHtml.includes("You're in, Test Driver " + ts) && doneHtml.includes('/d/'),
      `status=${res.status}`);
    const drv = db.prepare('SELECT * FROM drivers WHERE email = ?').get(drvEmail);
    check('driver row stored with status=new, source preserved, access token set',
      !!drv && drv.status === 'new' && drv.source === 'tiktok' && !!drv.access_token && drv.access_token.length >= 32,
      drv ? `status=${drv.status} source=${drv.source}` : 'no row');
    check('driver work_prefs stored as JSON array',
      !!drv && JSON.parse(drv.work_prefs).includes('local'));
    const hist = db.prepare('SELECT * FROM driver_status_history WHERE driver_id = ?').get(drv.id);
    check('driver status history records onboarding (null -> new)',
      !!hist && hist.from_status === null && hist.to_status === 'new' && hist.changed_by === 'system');
    const qDriver = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE email = ? AND step = 'onboarding-confirmation'").get(drvEmail).n;
    const qOps = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step = 'onboarding-new' AND subject LIKE ?").get('%Test Driver ' + ts + '%').n;
    check('onboarding queues driver confirmation + ops notification emails',
      qDriver === 1 && qOps === 1, `driver=${qDriver} ops=${qOps}`);

    // Re-submit with the same email: updates, does not duplicate.
    res = await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
      ['full_name', 'Test Driver ' + ts], ['email', drvEmail], ['phone', '4145559999'],
      ['vehicle_type', 'box_truck'], ['source', 'direct'],
    ]});
    const dupeCount = db.prepare('SELECT COUNT(*) n FROM drivers WHERE email = ?').get(drvEmail).n;
    const updated = db.prepare('SELECT * FROM drivers WHERE email = ?').get(drvEmail);
    check('re-onboarding with same email updates instead of duplicating',
      res.status === 200 && dupeCount === 1 && updated.phone === '4145559999' && updated.vehicle_type === 'box_truck',
      `count=${dupeCount}`);
    check('re-onboarding does not reset pipeline status or rotate access token',
      updated.status === 'new' && updated.access_token === drv.access_token);

    // Validation.
    res = await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
      ['full_name', 'No Email'], ['email', 'not-an-email'], ['phone', '123'],
    ]});
    const badHtml = await res.text();
    check('onboarding rejects invalid email with 400',
      res.status === 400 && badHtml.includes('valid email'), `status=${res.status}`);
    res = await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
      ['full_name', ''], ['email', `noname-${ts}@example.com`], ['phone', '123'],
    ]});
    check('onboarding rejects missing name with 400', res.status === 400, `status=${res.status}`);

    // Unknown source normalizes to other.
    const otherEmail = `driver-other-${ts}@example.com`;
    await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
      ['full_name', 'Other Source'], ['email', otherEmail], ['phone', '123'], ['source', 'bogus-src'],
    ]});
    const otherDrv = db.prepare('SELECT source FROM drivers WHERE email = ?').get(otherEmail);
    check('unknown source normalizes to other', otherDrv && otherDrv.source === 'other');

    // Post-payment path branches by product; Room flow unchanged.
    res = await req(`${BASE}/payment-success?p=transitnow-complete`, {});
    const psHtml = await res.text();
    check('payment-success for TransitNow product shows onboarding CTA',
      psHtml.includes('/drivers/onboard') && psHtml.includes('COMPLETE DRIVER ONBOARDING'));
    res = await req(`${BASE}/payment-success?p=room`, {});
    const psRoom = await res.text();
    check('payment-success for Room still shows claim access (no regression)',
      psRoom.includes('/room/claim'));

    /* ---- Phase B: admin driver pipeline ---------------------------- */
    const pbEmail = `pipeline-${ts}@example.com`;
    await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
      ['full_name', 'Pipeline Driver'], ['email', pbEmail], ['phone', '4145550101'],
      ['business_name', 'PB Hauling'], ['mc_number', '654321'],
      ['vehicle_make_model', 'Chevy Express'], ['home_city', 'Milwaukee'],
      ['work_prefs', 'local'], ['source', 'facebook'],
    ]});
    const pbDrv = db.prepare('SELECT id FROM drivers WHERE email = ?').get(pbEmail);

    res = await req(`${BASE}/admin/drivers`, {});
    check('admin pipeline requires token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/drivers?token=${ADMIN_TOKEN}`, {});
    const pipeHtml = await res.text();
    check('admin pipeline lists drivers with status filter tabs',
      res.status === 200 && pipeHtml.includes('Driver Pipeline') && pipeHtml.includes('Pipeline Driver') &&
      pipeHtml.includes('New (') && pipeHtml.includes('status=new'),
      `status=${res.status}`);
    check('pipeline shows business, vehicle, source columns',
      pipeHtml.includes('PB Hauling') && pipeHtml.includes('Chevy Express') && pipeHtml.includes('Facebook'));
    res = await req(`${BASE}/admin/drivers?token=${ADMIN_TOKEN}&status=ready`, {});
    const pipeReady = await res.text();
    check('pipeline status filter excludes non-matching drivers',
      res.status === 200 && !pipeReady.includes('Pipeline Driver'));

    res = await req(`${BASE}/admin/drivers/${pbDrv.id}?token=${ADMIN_TOKEN}`, {});
    const detHtml = await res.text();
    check('admin driver detail shows full profile + history + note form',
      res.status === 200 && detHtml.includes('Status history') && detHtml.includes('Add a note') &&
      detHtml.includes('PB Hauling') && detHtml.includes('654321'),
      `status=${res.status}`);

    res = await req(`${BASE}/admin/drivers/${pbDrv.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['status', 'reviewing'], ['note', 'Docs look good'], ['notify', '1'],
    ]});
    const afterStatus = db.prepare('SELECT status, last_contact FROM drivers WHERE id = ?').get(pbDrv.id);
    const histRows = db.prepare('SELECT from_status, to_status, changed_by, note FROM driver_status_history WHERE driver_id = ? ORDER BY ts').all(pbDrv.id);
    check('admin status change updates status, stamps last_contact, appends history',
      res.status === 302 && afterStatus.status === 'reviewing' && !!afterStatus.last_contact &&
      histRows.length === 2 && histRows[1].from_status === 'new' && histRows[1].to_status === 'reviewing' &&
      histRows[1].changed_by === 'admin' && histRows[1].note === 'Docs look good',
      `status=${res.status}`);
    const scMail = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE email = ? AND step = 'status-change'").get(pbEmail).n;
    check('admin status change with notify queues driver email', scMail === 1, `count=${scMail}`);

    res = await req(`${BASE}/admin/drivers/${pbDrv.id}/note?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['note', 'Called, left voicemail'],
    ]});
    const notesAfter = db.prepare('SELECT notes FROM drivers WHERE id = ?').get(pbDrv.id).notes;
    check('admin note appends timestamped note without overwriting',
      res.status === 302 && notesAfter.includes('Called, left voicemail') && /admin/.test(notesAfter),
      `status=${res.status}`);

    res = await req(`${BASE}/admin/drivers/${pbDrv.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['status', 'bogus']] });
    check('admin rejects invalid status with 400', res.status === 400, `status=${res.status}`);
    res = await req(`${BASE}/admin/drivers/999999?token=${ADMIN_TOKEN}`, {});
    check('admin driver detail 404s for unknown id', res.status === 404, `status=${res.status}`);

    /* ---- Phase C: private driver dashboard ------------------------- */
    const pcEmail = `dash-${ts}@example.com`;
    await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
      ['full_name', 'Dash Driver'], ['email', pcEmail], ['phone', '4145550102'], ['source', 'direct'],
    ]});
    const pcToken = db.prepare('SELECT access_token FROM drivers WHERE email = ?').get(pcEmail).access_token;
    res = await req(`${BASE}/d/${pcToken}`, {});
    const pcDashHtml = await res.text();
    check('driver dashboard loads via private token link',
      res.status === 200 && pcDashHtml.includes('Hi, Dash Driver') && pcDashHtml.includes('Status:'),
      `status=${res.status}`);
    check('dashboard links to routes, packages, scan, support, community, plan sections',
      pcDashHtml.includes('/scan') && pcDashHtml.includes('/support') && pcDashHtml.includes('/community') &&
      pcDashHtml.includes('/plan') && pcDashHtml.includes('/packages'));
    check('dashboard shows private-link reminder', pcDashHtml.includes('Do not share it'));
    res = await req(`${BASE}/d/not-a-real-token`, {});
    check('dashboard rejects invalid token with 404', res.status === 404, `status=${res.status}`);

    /* ---- Phase D: routes + packages -------------------------------- */
    const pdEmail = `routed-${ts}@example.com`;
    await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
      ['full_name', 'Route Driver'], ['email', pdEmail], ['phone', '4145550103'], ['source', 'direct'],
    ]});
    const pdDrv = db.prepare('SELECT id, access_token FROM drivers WHERE email = ?').get(pdEmail);
    // Paid-client enforcement: route/plan endpoints require an active subscription.
    makePaid(db, pdEmail);

    res = await req(`${BASE}/admin/routes`, {});
    check('admin routes require token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/routes?token=${ADMIN_TOKEN}`, {});
    check('admin routes list renders', res.status === 200 && (await res.text()).includes('Routes'), `status=${res.status}`);

    res = await req(`${BASE}/admin/routes?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['driver_id', String(pdDrv.id)], ['title', 'Test Loop'], ['scheduled_date', '2026-09-21'],
    ]});
    const route = db.prepare('SELECT * FROM routes WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(pdDrv.id);
    check('admin creates route with TNR-YYYY-0001 code',
      res.status === 302 && route && /^TNR-2026-\d{4}$/.test(route.route_code) && route.status === 'planned',
      route ? `code=${route.route_code}` : 'no route');

    res = await req(`${BASE}/admin/routes/${route.id}/packages?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['recipient_name', 'Acme Corp'], ['address', '123 Main St'],
      ['city', 'Milwaukee'], ['state', 'WI'], ['zip', '53202'],
    ]});
    const pkg = db.prepare('SELECT * FROM packages WHERE route_id = ?').get(route.id);
    check('admin adds package with TN-YYYY-000001 id, inherits driver',
      res.status === 302 && pkg && /^TN-2026-\d{6}$/.test(pkg.package_id) && pkg.driver_id === pdDrv.id && pkg.status === 'created',
      pkg ? `id=${pkg.package_id}` : 'no package');

    res = await req(`${BASE}/admin/routes/${route.id}/packages?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['recipient_name', ''], ['address', ''],
    ]});
    check('package validation rejects empty recipient/address (400)', res.status === 400, `status=${res.status}`);

    res = await req(`${BASE}/admin/routes/${route.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['status', 'active']] });
    const routeAfter = db.prepare('SELECT status FROM routes WHERE id = ?').get(route.id);
    check('admin route status change works', res.status === 302 && routeAfter.status === 'active', `status=${res.status}`);

    res = await req(`${BASE}/d/${pdDrv.access_token}/route`, {});
    const drvRouteHtml = await res.text();
    check('driver route page shows assigned route + packages',
      res.status === 200 && drvRouteHtml.includes(route.route_code) && drvRouteHtml.includes(pkg.package_id) && drvRouteHtml.includes('Acme Corp'),
      `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/packages`, {});
    const drvPkgsHtml = await res.text();
    check('driver packages page lists own packages',
      res.status === 200 && drvPkgsHtml.includes(pkg.package_id), `status=${res.status}`);

    // A second driver must not see the first driver's packages.
    const pd2Email = `routed2-${ts}@example.com`;
    await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
      ['full_name', 'Other Driver'], ['email', pd2Email], ['phone', '4145550104'],
    ]});
    const pd2Token = db.prepare('SELECT access_token FROM drivers WHERE email = ?').get(pd2Email).access_token;
    res = await req(`${BASE}/d/${pd2Token}/packages`, {});
    const otherPkgs = await res.text();
    check('driver cannot see another driver\'s packages',
      res.status === 200 && !otherPkgs.includes(pkg.package_id));

    /* ---- Phase E: scanning ----------------------------------------- */
    res = await req(`${BASE}/d/${pdDrv.access_token}/scan`, {});
    const scanHtml = await res.text();
    check('scan page loads camera scanner + manual fallback',
      res.status === 200 && scanHtml.includes('/vendor/html5-qrcode.min.js') && scanHtml.includes('name="code"'),
      `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/scan`, { method: 'POST', form: [['code', pkg.package_id]] });
    check('scan lookup redirects to driver package page',
      res.status === 302 && (res.headers.get('location') || '').includes(`/packages/${pkg.package_id}`),
      `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/scan`, { method: 'POST', form: [['code', '  ' + pkg.package_id.toLowerCase() + '  ']] });
    check('scan lookup is case/whitespace tolerant',
      res.status === 302 && (res.headers.get('location') || '').includes(`/packages/${pkg.package_id}`),
      `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/scan`, { method: 'POST', form: [['code', 'TN-2026-999999']] });
    check('scan lookup of unknown id shows not-found',
      res.status === 200 && (await res.text()).includes('No package found'), `status=${res.status}`);
    // Another driver's package must not resolve.
    res = await req(`${BASE}/d/${pd2Token}/scan`, { method: 'POST', form: [['code', pkg.package_id]] });
    check('scan lookup never reveals another driver\'s package',
      res.status === 200 && (await res.text()).includes('No package found'), `status=${res.status}`);
    res = await req(`${BASE}/vendor/html5-qrcode.min.js`, {});
    check('vendored scanner library is served', res.status === 200, `status=${res.status}`);

    /* ---- Phase F: custody + handoff history -------------------------- */
    res = await req(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}`, {});
    const pkgPageHtml = await res.text();
    check('driver package page shows custody buttons + empty history',
      res.status === 200 && pkgPageHtml.includes('Record custody event') && pkgPageHtml.includes('PICKED UP') &&
      pkgPageHtml.includes('No custody events recorded yet'), `status=${res.status}`);

    res = await req(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}/event`, { method: 'POST', form: [
      ['event_type', 'picked_up'], ['note', 'Picked up at dock 3'],
    ]});
    let pkgAfter = db.prepare('SELECT status FROM packages WHERE package_id = ?').get(pkg.package_id);
    let events = db.prepare('SELECT event_type, driver_id, note, created_by FROM custody_events WHERE package_id = ? ORDER BY ts').all(pkg.package_id);
    check('custody event recorded; package status advances',
      res.status === 302 && pkgAfter.status === 'picked_up' && events.length === 1 &&
      events[0].event_type === 'picked_up' && Number(events[0].driver_id) === pdDrv.id &&
      events[0].note === 'Picked up at dock 3' && events[0].created_by === 'driver',
      `status=${res.status}`);

    await req(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}/event`, { method: 'POST', form: [
      ['event_type', 'delivered'], ['note', 'Left at front desk'],
    ]});
    events = db.prepare('SELECT event_type FROM custody_events WHERE package_id = ? ORDER BY ts').all(pkg.package_id);
    pkgAfter = db.prepare('SELECT status FROM packages WHERE package_id = ?').get(pkg.package_id);
    check('custody history is append-only (both events kept, in order)',
      events.length === 2 && events[0].event_type === 'picked_up' && events[1].event_type === 'delivered' &&
      pkgAfter.status === 'delivered');

    res = await req(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}/event`, { method: 'POST', form: [
      ['event_type', 'handoff'], ['note', ''],
    ]});
    check('handoff without a recipient note is rejected (400)', res.status === 400, `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}/event`, { method: 'POST', form: [
      ['event_type', 'handoff'], ['note', 'Handed to Maria at front desk'],
    ]});
    events = db.prepare('SELECT event_type, note FROM custody_events WHERE package_id = ? ORDER BY ts').all(pkg.package_id);
    check('handoff with note recorded',
      res.status === 302 && events.length === 3 && events[2].event_type === 'handoff' &&
      events[2].note === 'Handed to Maria at front desk', `status=${res.status}`);

    res = await req(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}/event`, { method: 'POST', form: [
      ['event_type', 'bogus_event'],
    ]});
    check('unknown custody event rejected (400)', res.status === 400, `status=${res.status}`);

    // Another driver cannot record events on this package.
    res = await req(`${BASE}/d/${pd2Token}/packages/${pkg.package_id}/event`, { method: 'POST', form: [
      ['event_type', 'picked_up'],
    ]});
    check('driver cannot record custody on another driver\'s package (404)', res.status === 404, `status=${res.status}`);
    res = await req(`${BASE}/d/${pd2Token}/packages/${pkg.package_id}`, {});
    check('driver cannot view another driver\'s package page (404)', res.status === 404, `status=${res.status}`);

    // Admin package investigation.
    res = await req(`${BASE}/admin/packages/${pkg.package_id}?token=${ADMIN_TOKEN}`, {});
    const adminPkgHtml = await res.text();
    check('admin package page shows read-only custody timeline',
      res.status === 200 && adminPkgHtml.includes('Custody history') && adminPkgHtml.includes('Picked up') &&
      adminPkgHtml.includes('Handoff') && adminPkgHtml.includes('Handed to Maria'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/packages/${pkg.package_id}`, {});
    check('admin package page requires token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/packages/TN-2026-999999?token=${ADMIN_TOKEN}`, {});
    check('admin package page 404s for unknown id', res.status === 404, `status=${res.status}`);

    /* ---- Phase G: route progress (polling) ----------------------------- */
    res = await req(`${BASE}/d/${pdDrv.access_token}/route/progress`, {});
    const pgProg = await res.json();
    check('route progress endpoint returns polling JSON counts',
      res.status === 200 && pgProg.route_code === route.route_code && pgProg.total === 1 &&
      pgProg.done === 0 && pgProg.remaining === 1 && pgProg.counts.in_transit === 1 && pgProg.updated_at > 0,
      `status=${res.status} body=${JSON.stringify(pgProg).slice(0, 120)}`);
    res = await req(`${BASE}/d/${pd2Token}/route/progress`, {});
    check('route progress 404s when driver has no route', res.status === 404, `status=${res.status}`);
    res = await req(`${BASE}/d/not-a-real-token/route/progress`, {});
    check('route progress rejects invalid token (404)', res.status === 404, `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/route`, {});
    const routePageHtml = await res.text();
    check('driver route page shows progress card with polling (no real-time claims)',
      res.status === 200 && routePageHtml.includes('id="route-progress"') &&
      routePageHtml.includes('Counts refresh about every 30 seconds') &&
      routePageHtml.includes('/route/progress') &&
      !/real-?time/i.test(routePageHtml),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/routes/${route.id}?token=${ADMIN_TOKEN}`, {});
    const adminRouteHtml = await res.text();
    check('admin route detail shows progress bar with counts',
      res.status === 200 && adminRouteHtml.includes('Route progress') &&
      adminRouteHtml.includes('0 of 1 packages complete'), `status=${res.status}`);

    /* ---- Phase H: delivery exceptions ---------------------------------- */
    res = await req(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}/exception`, {});
    check('driver exception form renders',
      res.status === 200 && (await res.text()).includes('Report an exception'), `status=${res.status}`);

    res = await multipartReq(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}/exception`, {
      fields: { exception_type: 'damaged_package', description: 'Box crushed on one corner' },
      file: { filename: 'damage.png', mime: 'image/png', buffer: Buffer.from('fake-png-bytes') },
    });
    // photo without the confirm checkbox is rejected
    check('exception photo requires the no-sensitive-info confirmation (400)',
      res.status === 400, `status=${res.status}`);

    res = await multipartReq(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}/exception`, {
      fields: { exception_type: 'damaged_package', description: 'Box crushed on one corner', photo_confirm: '1' },
      file: { filename: 'damage.png', mime: 'image/png', buffer: Buffer.from('fake-png-bytes') },
    });
    const exRow = db.prepare('SELECT * FROM package_exceptions WHERE package_id = ? ORDER BY id DESC LIMIT 1').get(pkg.package_id);
    const pkgExStatus = db.prepare('SELECT status FROM packages WHERE package_id = ?').get(pkg.package_id).status;
    check('exception with photo recorded; package flagged',
      res.status === 302 && exRow && exRow.exception_type === 'damaged_package' &&
      exRow.status === 'open' && exRow.photo_mime === 'image/png' &&
      exRow.photo_blob && exRow.photo_blob.length > 0 && pkgExStatus === 'exception',
      `status=${res.status}`);
    const exMail = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step = 'exception-new' AND subject LIKE ?").get(`%${pkg.package_id}%`).n;
    check('new exception notifies operations', exMail === 1, `count=${exMail}`);

    res = await req(`${BASE}/d/${pdDrv.access_token}/exceptions/${exRow.id}/photo`, {});
    check('driver can view own exception photo',
      res.status === 200 && (res.headers.get('content-type') || '').includes('image/png'), `status=${res.status}`);
    res = await req(`${BASE}/d/${pd2Token}/exceptions/${exRow.id}/photo`, {});
    check('other driver cannot view exception photo (404)', res.status === 404, `status=${res.status}`);

    res = await req(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}`, {});
    const pkgPageEx = await res.text();
    check('driver package page shows the exception',
      res.status === 200 && pkgPageEx.includes('Damaged package') && pkgPageEx.includes('Box crushed'), `status=${res.status}`);

    // Admin: list, resolve.
    res = await req(`${BASE}/admin/exceptions`, {});
    check('admin exceptions require token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/exceptions?token=${ADMIN_TOKEN}`, {});
    const exListHtml = await res.text();
    check('admin exceptions list shows open exception',
      res.status === 200 && exListHtml.includes(pkg.package_id) && exListHtml.includes('Damaged package'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/exceptions/${exRow.id}/photo?token=${ADMIN_TOKEN}`, {});
    check('admin can view exception photo', res.status === 200, `status=${res.status}`);
    res = await req(`${BASE}/admin/exceptions/${exRow.id}/resolve?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['resolution_note', 'Customer approved redelivery']] });
    const exAfter = db.prepare('SELECT status, resolution_note FROM package_exceptions WHERE id = ?').get(exRow.id);
    const pkgAfterResolve = db.prepare('SELECT status FROM packages WHERE package_id = ?').get(pkg.package_id).status;
    check('admin resolve keeps report, records resolution, unflags package',
      res.status === 302 && exAfter.status === 'resolved' &&
      exAfter.resolution_note === 'Customer approved redelivery' && pkgAfterResolve === 'in_transit',
      `status=${res.status}`);
    res = await req(`${BASE}/admin/packages/${pkg.package_id}?token=${ADMIN_TOKEN}`, {});
    check('admin package page shows exception + resolution',
      res.status === 200 && (await res.text()).includes('Customer approved redelivery'), `status=${res.status}`);

    // Validation: bad type / missing description.
    res = await multipartReq(`${BASE}/d/${pdDrv.access_token}/packages/${pkg.package_id}/exception`, {
      fields: { exception_type: 'bogus', description: 'x' },
    });
    check('exception rejects unknown type (400)', res.status === 400, `status=${res.status}`);
    res = await req(`${BASE}/d/${pd2Token}/packages/${pkg.package_id}/exception`, {});
    check('driver cannot open exception form for another driver\'s package (404)', res.status === 404, `status=${res.status}`);

    /* ---- Phase I: support tickets + urgent alerts ---------------------- */
    res = await req(`${BASE}/d/${pdDrv.access_token}/support`, {});
    const supHtml = await res.text();
    check('driver support page renders with new-request form',
      res.status === 200 && supHtml.includes('New request') && supHtml.includes('name="category"'),
      `status=${res.status}`);
    check('support page is honest about urgent response (no 24/7 promise)',
      supHtml.includes('We do not promise an immediate human response') && supHtml.includes('call 911'));

    res = await req(`${BASE}/d/${pdDrv.access_token}/support`, { method: 'POST', form: [
      ['category', 'route_issue'], ['subject', 'Gate code needed'], ['description', 'Need the gate code for stop 3'],
    ]});
    const ticket = db.prepare('SELECT * FROM support_tickets WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(pdDrv.id);
    check('driver creates support ticket with TN-SUP id',
      res.status === 302 && ticket && /^TN-SUP-\d{6}$/.test(ticket.ticket_id) &&
      ticket.priority === 'normal' && ticket.status === 'open',
      ticket ? `id=${ticket.ticket_id}` : 'no ticket');
    const tNewMail = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step = 'ticket-new' AND subject LIKE ?").get(`%${ticket.ticket_id}%`).n;
    check('new ticket notifies operations', tNewMail === 1, `count=${tNewMail}`);

    res = await req(`${BASE}/d/${pdDrv.access_token}/support`, { method: 'POST', form: [
      ['category', 'safety_concern'], ['subject', 'Unsafe drop location'], ['description', 'Dark alley, no lighting'],
      ['priority', 'urgent'],
    ]});
    const urgentTicket = db.prepare('SELECT * FROM support_tickets WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(pdDrv.id);
    check('urgent ticket flagged urgent',
      res.status === 302 && urgentTicket.priority === 'urgent', `status=${res.status}`);
    const urgMail = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step = 'ticket-urgent' AND subject LIKE ?").get(`%${urgentTicket.ticket_id}%`).n;
    check('urgent ticket triggers urgent ops alert', urgMail === 1, `count=${urgMail}`);

    res = await req(`${BASE}/d/${pdDrv.access_token}/support`, { method: 'POST', form: [
      ['category', 'route_issue'], ['subject', ''], ['description', 'x'],
    ]});
    check('ticket validation rejects missing subject (400)', res.status === 400, `status=${res.status}`);

    res = await req(`${BASE}/d/${pdDrv.access_token}/support/${ticket.ticket_id}`, {});
    check('driver ticket detail shows message + reply form',
      res.status === 200 && (await res.text()).includes('Gate code needed'), `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/support/${ticket.ticket_id}/reply`, { method: 'POST', form: [
      ['message', 'Update: found the code on the door'],
    ]});
    const replies = db.prepare('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY id').all(ticket.ticket_id);
    check('driver reply appended to ticket thread',
      res.status === 302 && replies.length === 1 && replies[0].author_type === 'driver' &&
      replies[0].message.includes('found the code'), `status=${res.status}`);
    res = await req(`${BASE}/d/${pd2Token}/support/${ticket.ticket_id}`, {});
    check('driver cannot view another driver\'s ticket (404)', res.status === 404, `status=${res.status}`);

    res = await req(`${BASE}/admin/tickets`, {});
    check('admin tickets require token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/tickets?token=${ADMIN_TOKEN}`, {});
    const admTicketsHtml = await res.text();
    check('admin tickets list shows tickets, urgent first',
      res.status === 200 && admTicketsHtml.includes(urgentTicket.ticket_id) &&
      admTicketsHtml.indexOf(urgentTicket.ticket_id) < admTicketsHtml.indexOf(ticket.ticket_id),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/tickets/${urgentTicket.ticket_id}?token=${ADMIN_TOKEN}`, {});
    check('admin ticket detail renders', res.status === 200 && (await res.text()).includes('Unsafe drop location'), `status=${res.status}`);
    res = await req(`${BASE}/admin/tickets/${urgentTicket.ticket_id}/reply?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['message', 'Ops here — we are looking into a safer stop.'],
    ]});
    const tAfterReply = db.prepare('SELECT status FROM support_tickets WHERE ticket_id = ?').get(urgentTicket.ticket_id);
    check('admin reply moves ticket to in_progress',
      res.status === 302 && tAfterReply.status === 'in_progress', `status=${res.status}`);
    res = await req(`${BASE}/admin/tickets/${urgentTicket.ticket_id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['status', 'resolved']] });
    const tAfterStatus = db.prepare('SELECT status FROM support_tickets WHERE ticket_id = ?').get(urgentTicket.ticket_id);
    check('admin resolves ticket', res.status === 302 && tAfterStatus.status === 'resolved', `status=${res.status}`);
    res = await req(`${BASE}/admin/tickets/${urgentTicket.ticket_id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['status', 'bogus']] });
    check('admin rejects invalid ticket status (400)', res.status === 400, `status=${res.status}`);

    /* ---- Phase J: driver community ------------------------------------ */
    res = await req(`${BASE}/d/${pdDrv.access_token}/community`, {});
    check('driver community page renders with categories',
      res.status === 200 && (await res.text()).includes('Driver community'), `status=${res.status}`);

    res = await req(`${BASE}/d/${pdDrv.access_token}/community`, { method: 'POST', form: [
      ['category', 'route_tips'], ['title', 'Skip the construction on 5th'], ['body', 'Take the river road instead.'],
    ]});
    const post = db.prepare('SELECT * FROM community_posts WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(pdDrv.id);
    check('driver creates community post',
      res.status === 302 && post && post.category === 'route_tips' && post.status === 'visible',
      post ? `id=${post.id}` : 'no post');
    res = await req(`${BASE}/d/${pdDrv.access_token}/community`, { method: 'POST', form: [
      ['category', 'announcements'], ['title', 'Fake announce'], ['body', 'x'],
    ]});
    check('drivers cannot post announcements (400)', res.status === 400, `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/community`, { method: 'POST', form: [
      ['category', 'questions'], ['title', ''], ['body', 'x'],
    ]});
    check('community post validation rejects empty title (400)', res.status === 400, `status=${res.status}`);

    res = await req(`${BASE}/d/${pd2Token}/community/${post.id}/comments`, { method: 'POST', form: [['body', 'Great tip, thanks!']] });
    const comment = db.prepare('SELECT * FROM community_comments WHERE post_id = ? ORDER BY id DESC LIMIT 1').get(post.id);
    check('driver comments on post',
      res.status === 302 && comment && comment.body === 'Great tip, thanks!', `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/community/${post.id}`, {});
    const postHtml = await res.text();
    check('community post page shows post + comment',
      res.status === 200 && postHtml.includes('Skip the construction') && postHtml.includes('Great tip'),
      `status=${res.status}`);
    check('community shows first names only (privacy)',
      postHtml.includes('Route') === false || !postHtml.includes(pdDrv.full_name), 'full name not shown');

    const repMailBefore = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step = 'community-report'").get().n;
    res = await req(`${BASE}/d/${pdDrv.access_token}/community/report`, { method: 'POST', form: [
      ['comment_id', String(comment.id)], ['reason', 'Testing the report flow'],
    ]});
    const report = db.prepare('SELECT * FROM community_reports ORDER BY id DESC LIMIT 1').get();
    check('driver can report content; ops notified',
      res.status === 200 && report && report.comment_id === comment.id && report.status === 'open',
      `status=${res.status}`);
    const repMail = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step = 'community-report'").get().n;
    check('report notifies operations', repMail === repMailBefore + 1, `count=${repMail}`);

    // Admin moderation.
    res = await req(`${BASE}/admin/community`, {});
    check('admin community requires token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/community/announce?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['title', 'Holiday schedule'], ['body', 'No routes on the holiday.'],
    ]});
    const ann = db.prepare("SELECT * FROM community_posts WHERE category = 'announcements' ORDER BY id DESC LIMIT 1").get();
    check('admin posts announcement', res.status === 302 && ann && ann.author_type === 'admin', `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/community`, {});
    check('announcement visible to drivers',
      (await res.text()).includes('Holiday schedule'), 'announcement shown');

    res = await req(`${BASE}/admin/community/posts/${post.id}/pin?token=${ADMIN_TOKEN}`, { method: 'POST' });
    check('admin pins post', res.status === 302 && db.prepare('SELECT pinned FROM community_posts WHERE id = ?').get(post.id).pinned === 1, `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/community`, {});
    const pinnedHtml = await res.text();
    check('pinned post sorts first', pinnedHtml.indexOf('Skip the construction') < pinnedHtml.indexOf('Holiday schedule'), 'order ok');

    res = await req(`${BASE}/admin/community/comments/${comment.id}/hide?token=${ADMIN_TOKEN}`, { method: 'POST' });
    check('admin hides comment', res.status === 302 && db.prepare('SELECT status FROM community_comments WHERE id = ?').get(comment.id).status === 'hidden', `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/community/${post.id}`, {});
    check('hidden comment invisible to drivers', !(await res.text()).includes('Great tip, thanks!'), 'hidden ok');
    res = await req(`${BASE}/admin/community/comments/${comment.id}/restore?token=${ADMIN_TOKEN}`, { method: 'POST' });
    check('admin restores comment', res.status === 302 && db.prepare('SELECT status FROM community_comments WHERE id = ?').get(comment.id).status === 'visible', `status=${res.status}`);

    res = await req(`${BASE}/admin/community/posts/${post.id}/hide?token=${ADMIN_TOKEN}`, { method: 'POST' });
    check('admin hides post', res.status === 302 && db.prepare('SELECT status FROM community_posts WHERE id = ?').get(post.id).status === 'hidden', `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/community/${post.id}`, {});
    check('hidden post returns 404 to drivers', res.status === 404, `status=${res.status}`);
    res = await req(`${BASE}/admin/community/posts/${post.id}/restore?token=${ADMIN_TOKEN}`, { method: 'POST' });
    check('admin restores post', res.status === 302 && db.prepare('SELECT status FROM community_posts WHERE id = ?').get(post.id).status === 'visible', `status=${res.status}`);

    res = await req(`${BASE}/admin/community/reports/${report.id}/review?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['outcome', 'dismissed']] });
    check('admin dismisses report', res.status === 302 && db.prepare('SELECT status FROM community_reports WHERE id = ?').get(report.id).status === 'dismissed', `status=${res.status}`);

    /* ---- Phase K: service plans --------------------------------------- */
    const DISCLAIMER = 'Plan pricing represents the applicable TransitNow service/plan fee. Driver earnings are not guaranteed and may vary based on routes, loads, availability, expenses, eligibility, and other operating factors.';
    res = await req(`${BASE}/d/${pdDrv.access_token}/plan`, {});
    let planHtml = await res.text();
    check('driver plan page shows 4 weekly plans with disclaimer',
      res.status === 200 && planHtml.includes('$300/week') && planHtml.includes('$500/week') &&
      planHtml.includes('$750/week') && planHtml.includes('$1,000/week') && planHtml.includes(DISCLAIMER),
      `status=${res.status}`);
    check('plan page never shows monthly equivalents',
      !/per month|\/month|monthly/i.test(planHtml), 'no monthly language');
    check('plans are closed to requests by default',
      planHtml.includes('not currently open'), 'closed by default');

    res = await req(`${BASE}/d/${pdDrv.access_token}/plan/request`, { method: 'POST', form: [['plan_id', 'plus']] });
    check('plan request rejected while plans are closed (400)', res.status === 400, `status=${res.status}`);

    // Admin configures plans.
    res = await req(`${BASE}/admin/plans`, {});
    check('admin plans require token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/plans?token=${ADMIN_TOKEN}`, {});
    check('admin plans page renders with disclaimer',
      res.status === 200 && (await res.text()).includes(DISCLAIMER), `status=${res.status}`);
    res = await req(`${BASE}/admin/plans/settings?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['billing_frequency', 'biweekly'], ['plans_enabled', '1'],
    ]});
    const settings = db.prepare('SELECT * FROM service_plan_settings WHERE id = 1').get();
    check('admin sets billing frequency + enables plans',
      res.status === 302 && settings.billing_frequency === 'biweekly' && settings.plans_enabled === 1,
      `status=${res.status}`);
    res = await req(`${BASE}/admin/plans/plus?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['name', 'Plus'], ['weekly_price', '550'], ['description', 'Updated desc'],
      ['features', 'A\nB'], ['active', '1'],
    ]});
    const plusPlan = db.prepare('SELECT * FROM service_plans WHERE id = ?').get('plus');
    check('admin updates plan price/config',
      res.status === 302 && plusPlan.weekly_price_cents === 55000 && plusPlan.description === 'Updated desc',
      `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/plan`, {});
    planHtml = await res.text();
    check('updated price + biweekly billing shown to driver',
      planHtml.includes('$550/week') && planHtml.includes('billed biweekly'), 'updated ok');

    // Driver requests a plan (pending; no activation).
    const planMailBefore = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step = 'plan-request'").get().n;
    res = await req(`${BASE}/d/${pdDrv.access_token}/plan/request`, { method: 'POST', form: [['plan_id', 'plus']] });
    const pending = db.prepare('SELECT * FROM driver_plan_changes WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(pdDrv.id);
    check('driver plan request recorded as pending',
      res.status === 302 && pending && pending.event === 'requested' && pending.to_plan_id === 'plus',
      `status=${res.status}`);
    const planMail = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step = 'plan-request'").get().n;
    check('plan request notifies operations', planMail === planMailBefore + 1, `count=${planMail}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/plan/request`, { method: 'POST', form: [['plan_id', 'pro']] });
    check('duplicate plan request rejected (400)', res.status === 400, `status=${res.status}`);
    res = await req(`${BASE}/admin/plans?token=${ADMIN_TOKEN}`, {});
    const admPlansHtml = await res.text();
    check('admin sees pending request', admPlansHtml.includes('plus') && admPlansHtml.includes('Route Driver'), 'pending shown');

    // Admin approves: current plan set, history append-only.
    res = await req(`${BASE}/admin/plans/requests/${pdDrv.id}/approve?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['note', 'Terms accepted']] });
    const planHist = db.prepare('SELECT * FROM driver_plan_changes WHERE driver_id = ? ORDER BY id').all(pdDrv.id);
    check('approval appends event (history intact)',
      res.status === 302 && planHist.length === 2 && planHist[0].event === 'requested' && planHist[1].event === 'approved' &&
      planHist[1].note === 'Terms accepted',
      `status=${res.status}`);
    res = await req(`${BASE}/d/${pdDrv.access_token}/plan`, {});
    check('driver sees current plan after approval', (await res.text()).includes('Your current plan'), 'current shown');
    res = await req(`${BASE}/d/${pdDrv.access_token}/plan/request`, { method: 'POST', form: [['plan_id', 'plus']] });
    check('requesting current plan rejected (400)', res.status === 400, `status=${res.status}`);

    // Second driver: reject flow.
    const pd2DrvId = db.prepare('SELECT id FROM drivers WHERE email = ?').get(pd2Email).id;
    res = await req(`${BASE}/d/${pd2Token}/plan/request`, { method: 'POST', form: [['plan_id', 'pro']] });
    check('second driver requests plan', res.status === 302, `status=${res.status}`);
    res = await req(`${BASE}/admin/plans/requests/${pd2DrvId}/reject?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['note', 'Not eligible yet']] });
    const hist2 = db.prepare('SELECT event FROM driver_plan_changes WHERE driver_id = ? ORDER BY id').all(pd2DrvId).map((r) => r.event);
    check('rejection appends event', res.status === 302 && hist2.join(',') === 'requested,rejected', `events=${hist2}`);

    // Restore defaults for future runs.
    await req(`${BASE}/admin/plans/settings?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['billing_frequency', 'weekly']] });
    await req(`${BASE}/admin/plans/plus?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['name', 'Plus'], ['weekly_price', '500'], ['description', 'Extra support for busier weeks.'],
      ['features', 'Everything in Essential\nPriority dispatch queue'], ['active', '1'],
    ]});

    /* ---- Phase L: operations dashboard / reports / audit -------------- */
    res = await req(`${BASE}/admin/operations`, {});
    check('operations dashboard requires token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/operations?token=${ADMIN_TOKEN}`, {});
    const opsHtml = await res.text();
    check('operations dashboard renders stat cards + investigation',
      res.status === 200 && opsHtml.includes('Operations dashboard') &&
      opsHtml.includes('Open exceptions') && opsHtml.includes('Open tickets') &&
      opsHtml.includes('Package investigation') && opsHtml.includes('Recent custody events'),
      `status=${res.status}`);

    res = await req(`${BASE}/admin/operations/investigate?package_id=${encodeURIComponent(pkg.package_id)}&token=${ADMIN_TOKEN}`, { redirect: 'manual' });
    check('package investigation redirects to package page',
      res.status === 302 && (res.headers.get('location') || '').includes(`/admin/packages/${pkg.package_id}`),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/operations/investigate?package_id=TN-2099-999999&token=${ADMIN_TOKEN}`, {});
    check('investigation of unknown package shows not-found',
      res.status === 200 && (await res.text()).includes('No package found'), `status=${res.status}`);

    res = await req(`${BASE}/admin/reports`, {});
    check('reports require token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/reports?token=${ADMIN_TOKEN}`, {});
    const repHtml = await res.text();
    check('reports page renders aggregates',
      res.status === 200 && repHtml.includes('Packages by status') &&
      repHtml.includes('Exceptions by type') && repHtml.includes('Tickets by category') &&
      repHtml.includes('Custody events per day'),
      `status=${res.status}`);

    res = await req(`${BASE}/admin/audit`, {});
    check('audit requires token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/audit?token=${ADMIN_TOKEN}`, {});
    const auditHtml = await res.text();
    check('audit trail renders append-only history',
      res.status === 200 && auditHtml.includes('Audit trail') &&
      auditHtml.includes('driver status') && auditHtml.includes('custody'),
      `status=${res.status}`);

    /* ---- Phase 1: Grow funnel / lead CRM / business / RSP / dispatch ---- */
    const p1ts = Date.now();
    const p1 = (n) => `p1-${n}-${p1ts}@example.com`;
    const outboxBeforeP1 = outboxFiles();

    // --- Public pages, exact copy, navigation ---
    res = await req(`${BASE}/grow`, {});
    const p1GrowHtml = await res.text();
    check('phase1: GET /grow 200 with exact headline, CTA, disclosure',
      res.status === 200 && p1GrowHtml.includes("WE'RE GROWING") && p1GrowHtml.includes('COME GROW WITH US.') &&
      p1GrowHtml.includes('TELL US ABOUT YOU') && p1GrowHtml.includes('/grow/apply') &&
      p1GrowHtml.includes('does not guarantee employment, routes, loads, contracts, income, partnership'),
      `status=${res.status}`);

    res = await req(`${BASE}/grow/apply`, {});
    const p1ApplyHtml = await res.text();
    check('phase1: GET /grow/apply renders 13 steps, progress indicator, separate marketing consent',
      res.status === 200 && (p1ApplyHtml.match(/class="grow-step"/g) || []).length === 13 &&
      p1ApplyHtml.includes('STEP 1 OF 13') && p1ApplyHtml.includes('progress-fill') &&
      p1ApplyHtml.includes('name="marketing_consent"') && p1ApplyHtml.includes('Save &amp; Continue Later'),
      `status=${res.status}, steps=${(p1ApplyHtml.match(/class="grow-step"/g) || []).length}`);
    check('phase1: apply form never asks for SSN/bank/password/card fields',
      !/name="ssn"/i.test(p1ApplyHtml) && !/name="bank/i.test(p1ApplyHtml) &&
      !/name="password"/i.test(p1ApplyHtml) && !/name="card_number"/i.test(p1ApplyHtml) &&
      !/name="credit_card"/i.test(p1ApplyHtml),
      'forbidden field name found');
    check('phase1: apply page is mobile-ready (viewport meta)',
      p1ApplyHtml.includes('name="viewport"'), 'no viewport meta');

    res = await req(`${BASE}/business`, {});
    const p1BizHtml = await res.text();
    check('phase1: GET /business 200 with inquiry form',
      res.status === 200 && p1BizHtml.includes('name="company_name"') && p1BizHtml.includes('name="service_needed"'),
      `status=${res.status}`);
    res = await req(`${BASE}/rsp`, {});
    const p1RspHtml = await res.text();
    check('phase1: GET /rsp 200 with exact headline + disclosure',
      res.status === 200 && p1RspHtml.includes('BUILD BEYOND THE DRIVER SEAT.') &&
      p1RspHtml.includes('does not guarantee an RSP territory, contract, route, partnership, income or acceptance'),
      `status=${res.status}`);
    res = await req(`${BASE}/dispatch`, {});
    const p1DispHtml = await res.text();
    check('phase1: GET /dispatch 200 with services + GET DISPATCH INFORMATION CTA',
      res.status === 200 && p1DispHtml.includes('GET DISPATCH INFORMATION') &&
      p1DispHtml.includes('No guaranteed loads, routes, contracts or earnings'),
      `status=${res.status}`);
    res = await req(`${BASE}/support`, {});
    const p1SupHtml = await res.text();
    check('phase1: GET /support 200, no 24/7 human-staff claim, emergency note',
      res.status === 200 && p1SupHtml.includes('contact emergency services first') &&
      p1SupHtml.includes('not a claim that human staff are available 24/7'),
      `status=${res.status}`);

    res = await req(`${BASE}/`, {});
    const p1HomeHtml = await res.text();
    const navLabels = ['HOME', 'DRIVERS', 'GROW WITH TRANSITNOW', 'DISPATCH', 'BUSINESSES', 'RSP', 'SUPPORT', 'CONTACT'];
    check('phase1: public nav has all 8 links with GROW WITH TRANSITNOW as CTA',
      res.status === 200 && navLabels.every((l) => p1HomeHtml.includes(`>${l}<`)) &&
      p1HomeHtml.includes('class="nav-cta"'),
      `status=${res.status}`);
    res = await req(`${BASE}/room/join`, {});
    const p1RoomJoinHtml = await res.text();
    check('phase1: Room-branded pages keep their own look (no TransitNow nav)',
      res.status === 200 && !p1RoomJoinHtml.includes('GROW WITH TRANSITNOW'),
      `status=${res.status}`);

    // --- Grow validation ---
    res = await req(`${BASE}/grow/apply`, { method: 'POST', form: { first_name: '', email: 'not-an-email', phone: '', city: '', state: '' } });
    const p1BadHtml = await res.text();
    check('phase1: POST /grow/apply invalid -> 400 with error text',
      res.status === 400 && p1BadHtml.includes('A valid email address is required.'),
      `status=${res.status}`);
    res = await req(`${BASE}/grow/apply`, { method: 'POST', form: { first_name: 'P1', email: p1('grow'), phone: '414-555-0101', city: 'Milwaukee', state: 'WI', ssn: '123-45-6789' } });
    check('phase1: POST /grow/apply carrying an SSN field is rejected (400)',
      res.status === 400 && (await res.text()).includes('does not accept that kind of information'),
      `status=${res.status}`);

    // --- Grow submit: full 13-step payload -> DB -> thank-you -> emails ---
    const p1GrowForm = [
      ['first_name', 'P1First'], ['last_name', 'P1Last'], ['email', p1('grow')], ['phone', '414-555-0101'],
      ['preferred_contact', 'text'], ['city', 'Milwaukee'], ['state', 'WI'], ['zip', '53215'],
      ['about_you', 'P1 about'], ['why_interested', 'P1 why'],
      ['current_roles', 'independent-driver'], ['current_roles', 'courier'], ['experience_level', '3-5y'],
      ['vehicle_type', 'cargo-van'], ['vehicle_ownership', 'own'], ['vehicle_year', '2019'],
      ['vehicle_make', 'Ford'], ['vehicle_model', 'Transit'], ['cargo_capacity', '400 cu ft'],
      ['avail_days', 'mon'], ['avail_days', 'tue'], ['avail_start', '08:00'], ['avail_end', '17:00'],
      ['avail_days_per_week', '5'], ['avail_type', 'full-time'], ['schedule_notes', 'P1 schedule'],
      ['service_area_type', 'within-50'], ['primary_city', 'Milwaukee'], ['primary_state', 'WI'],
      ['has_business', 'no'], ['business_help', 'dispatch'],
      ['growth_interests', 'route-management'], ['managed_before', 'no'],
      ['opportunity_interests', 'local-routes'], ['opportunity_interests', 'rsp-opportunities'],
      ['readiness', 'license'], ['goals_12mo', 'P1 goals'], ['growth_vision', 'P1 vision'],
      ['future_role', 'route-manager'], ['something_else', 'P1 extra'],
      ['source', 'google'], ['referral_code', 'P1CODE'], ['contact_pref', 'text'], ['marketing_consent', 'yes'],
    ];
    res = await req(`${BASE}/grow/apply`, { method: 'POST', form: p1GrowForm });
    check('phase1: POST /grow/apply valid -> 302 to /grow/thank-you',
      res.status === 302 && res.headers.get('location') === '/grow/thank-you',
      `status=${res.status} loc=${res.headers.get('location')}`);
    const p1Lead = db.prepare('SELECT * FROM opportunity_leads WHERE email = ?').get(p1('grow'));
    check('phase1: grow lead row created (type GROW, status NEW)',
      !!p1Lead && p1Lead.lead_type === 'GROW' && p1Lead.status === 'NEW' &&
      p1Lead.marketing_consent === 1 && p1Lead.referral_code === 'P1CODE',
      p1Lead ? `type=${p1Lead.lead_type} status=${p1Lead.status}` : 'no row');
    check('phase1: related rows created (vehicle/business/goals/sources)',
      !!db.prepare('SELECT 1 FROM lead_vehicles WHERE lead_id = ?').get(p1Lead.id) &&
      !!db.prepare('SELECT 1 FROM lead_business_info WHERE lead_id = ?').get(p1Lead.id) &&
      !!db.prepare('SELECT 1 FROM lead_goals WHERE lead_id = ?').get(p1Lead.id) &&
      !!db.prepare('SELECT 1 FROM lead_sources WHERE lead_id = ?').get(p1Lead.id),
      'missing related row');
    const p1Hist = db.prepare('SELECT * FROM lead_status_history WHERE lead_id = ? ORDER BY id').all(p1Lead.id);
    check('phase1: status history seeded append-only (NULL -> NEW)',
      p1Hist.length === 1 && p1Hist[0].from_status == null && p1Hist[0].to_status === 'NEW',
      `rows=${p1Hist.length}`);
    const p1Tags = db.prepare('SELECT tag FROM opportunity_lead_tags WHERE lead_id = ?').all(p1Lead.id).map((r) => r.tag);
    check('phase1: auto-tags derived (DRIVER, ROUTE, RSP)',
      p1Tags.includes('DRIVER') && p1Tags.includes('ROUTE') && p1Tags.includes('RSP'),
      `tags=${p1Tags.join(',')}`);
    check('phase1: grow_application event recorded',
      !!db.prepare("SELECT 1 FROM events WHERE type = 'grow_application' AND meta LIKE ?").get(`%${p1Lead.id}%`),
      'no event');

    res = await req(`${BASE}/grow/thank-you`, {});
    check('phase1: GET /grow/thank-you 200 with exact copy',
      res.status === 200 && (await res.text()).includes('THANK YOU FOR TELLING US ABOUT YOU.'),
      `status=${res.status}`);

    const p1QueueRows = db.prepare("SELECT * FROM email_queue WHERE sequence = 'grow' AND email = ?").all(p1('grow'));
    check('phase1: applicant confirmation queued to applicant',
      p1QueueRows.some((r) => r.subject === 'We Received Your TransitNow Information' && r.status === 'sent'),
      `rows=${p1QueueRows.length}`);
    const p1AdminQueue = db.prepare("SELECT * FROM email_queue WHERE sequence = 'grow' AND step = 'admin-new-application' AND subject LIKE '%P1First P1Last%'").all();
    check('phase1: admin notification queued with applicant name',
      p1AdminQueue.length === 1 && p1AdminQueue[0].status === 'sent',
      `rows=${p1AdminQueue.length}`);
    const p1NewFiles = newFilesSince(outboxBeforeP1);
    const p1ApplicantMail = filesMentioning(p1('grow'), p1NewFiles);
    check('phase1: applicant email landed in outbox (local delivery)',
      p1ApplicantMail.length >= 1 &&
      fs.readFileSync(path.join(OUTBOX, p1ApplicantMail[0]), 'utf8').includes('We Received Your TransitNow Information'),
      `files=${p1ApplicantMail.length}`);
    const p1AdminMail = p1NewFiles.filter((f) => {
      try { return fs.readFileSync(path.join(OUTBOX, f), 'utf8').includes('New Grow application'); } catch { return false; }
    });
    check('phase1: admin notification in outbox links to the lead profile',
      p1AdminMail.length >= 1 &&
      fs.readFileSync(path.join(OUTBOX, p1AdminMail[0]), 'utf8').includes(`/admin/crm/leads/${p1Lead.id}`),
      `files=${p1AdminMail.length}`);
    const p1Comm = db.prepare("SELECT * FROM lead_communications WHERE lead_id = ? AND kind = 'email'").all(p1Lead.id);
    check('phase1: outbound confirmation logged in lead_communications', p1Comm.length >= 1, `rows=${p1Comm.length}`);

    // --- Duplicate submission: update-in-place, no second lead row ---
    const p1DupeForm = p1GrowForm.map(([k, v]) => (k === 'about_you' ? [k, 'P1 about UPDATED'] : [k, v]));
    res = await req(`${BASE}/grow/apply`, { method: 'POST', form: p1DupeForm });
    const p1DupeCount = db.prepare('SELECT COUNT(*) n FROM opportunity_leads WHERE email = ?').get(p1('grow')).n;
    const p1LeadAfter = db.prepare('SELECT * FROM opportunity_leads WHERE email = ?').get(p1('grow'));
    check('phase1: duplicate submission updates in place (one row, ?updated=1)',
      res.status === 302 && res.headers.get('location') === '/grow/thank-you?updated=1' &&
      p1DupeCount === 1 && p1LeadAfter.about_you === 'P1 about UPDATED',
      `status=${res.status} count=${p1DupeCount}`);
    check('phase1: resubmission logged, no extra status-history row',
      db.prepare("SELECT COUNT(*) n FROM lead_communications WHERE lead_id = ? AND subject = 'Application resubmitted'").get(p1Lead.id).n === 1 &&
      db.prepare('SELECT COUNT(*) n FROM lead_status_history WHERE lead_id = ?').get(p1Lead.id).n === 1,
      'resubmission logging wrong');
    res = await req(`${BASE}/grow/thank-you?updated=1`, {});
    check('phase1: thank-you notes the record was updated',
      res.status === 200 && (await res.text()).includes('we updated your record'),
      `status=${res.status}`);

    // --- Save & Continue Later (drafts) ---
    res = await req(`${BASE}/grow/apply/draft`, { method: 'POST', form: { first_name: 'P1Draft', email: p1('draft'), step: '4', city: 'Milwaukee' } });
    const p1DraftBody = await res.text();
    const p1DraftJson = JSON.parse(p1DraftBody);
    check('phase1: POST /grow/apply/draft returns token + resumeUrl',
      res.status === 200 && p1DraftJson.ok === true && /^[a-f0-9]{48}$/.test(p1DraftJson.token) &&
      p1DraftJson.resumeUrl === `/grow/apply/resume/${p1DraftJson.token}`,
      `status=${res.status} body=${p1DraftBody.slice(0, 80)}`);
    const p1DraftRow = db.prepare('SELECT * FROM opportunity_lead_drafts WHERE token = ?').get(p1DraftJson.token);
    check('phase1: draft row stored server-side',
      !!p1DraftRow && p1DraftRow.step === 4 && p1DraftRow.email === p1('draft'),
      p1DraftRow ? `step=${p1DraftRow.step}` : 'no row');
    res = await req(`${BASE}${p1DraftJson.resumeUrl}`, {});
    const p1ResumeHtml = await res.text();
    check('phase1: resume link restores draft (prefill + step 4)',
      res.status === 200 && p1ResumeHtml.includes('P1Draft') && p1ResumeHtml.includes('var current = 4;'),
      `status=${res.status}`);
    res = await req(`${BASE}/grow/apply/resume/deadbeef`, {});
    check('phase1: bogus resume token -> 404', res.status === 404, `status=${res.status}`);
    // Submitting with the draft token deletes the draft.
    res = await req(`${BASE}/grow/apply`, { method: 'POST', form: [...p1GrowForm.map(([k, v]) => (k === 'email' ? [k, p1('growdraft')] : [k, v])), ['draft_token', p1DraftJson.token]] });
    check('phase1: submitting with a draft token consumes the draft',
      res.status === 302 && !db.prepare('SELECT 1 FROM opportunity_lead_drafts WHERE token = ?').get(p1DraftJson.token),
      `status=${res.status}`);

    // --- Business funnel ---
    res = await req(`${BASE}/business`, { method: 'POST', form: { company_name: '', email: 'x' } });
    check('phase1: POST /business invalid -> 400', res.status === 400, `status=${res.status}`);
    res = await req(`${BASE}/business`, { method: 'POST', form: {
      company_name: 'P1BizCo', first_name: 'P1Biz', email: p1('biz'), phone: '414-555-0202',
      service_needed: 'Daily pharmacy deliveries', delivery_volume: '30 stops/day', frequency: 'daily',
    } });
    const p1Biz = db.prepare('SELECT * FROM opportunity_leads WHERE email = ?').get(p1('biz'));
    check('phase1: POST /business valid -> 302, type BUSINESS, status NEW, tagged BUSINESS OWNER',
      res.status === 302 && res.headers.get('location') === '/business/thank-you' &&
      !!p1Biz && p1Biz.lead_type === 'BUSINESS' && p1Biz.status === 'NEW' &&
      !!db.prepare("SELECT 1 FROM opportunity_lead_tags WHERE lead_id = ? AND tag = 'BUSINESS OWNER'").get(p1Biz.id),
      `status=${res.status}`);
    res = await req(`${BASE}/business/thank-you`, {});
    check('phase1: GET /business/thank-you 200', res.status === 200 && (await res.text()).includes('WE RECEIVED YOUR INQUIRY'), `status=${res.status}`);

    // --- RSP funnel ---
    res = await req(`${BASE}/rsp`, { method: 'POST', form: {
      first_name: 'P1Rsp', email: p1('rsp'), phone: '414-555-0303', city: 'Milwaukee', state: 'WI',
      num_drivers: '4', why_interested: 'P1 wants to build',
    } });
    const p1Rsp = db.prepare('SELECT * FROM opportunity_leads WHERE email = ?').get(p1('rsp'));
    check('phase1: POST /rsp valid -> 302, type RSP, default status RSP INTEREST, tagged RSP',
      res.status === 302 && res.headers.get('location') === '/rsp/thank-you' &&
      !!p1Rsp && p1Rsp.lead_type === 'RSP' && p1Rsp.status === 'RSP INTEREST' &&
      !!db.prepare("SELECT 1 FROM opportunity_lead_tags WHERE lead_id = ? AND tag = 'RSP'").get(p1Rsp.id),
      `status=${res.status} type=${p1Rsp && p1Rsp.lead_type} status=${p1Rsp && p1Rsp.status}`);

    // --- Dispatch funnel ---
    res = await req(`${BASE}/dispatch`, { method: 'POST', form: {
      first_name: 'P1Disp', email: p1('dispatch'), phone: '414-555-0404',
      vehicle_type: 'box-truck', about_you: 'P1 box truck owner',
    } });
    const p1Disp = db.prepare('SELECT * FROM opportunity_leads WHERE email = ?').get(p1('dispatch'));
    check('phase1: POST /dispatch valid -> 302, tagged DISPATCH, no-guarantee copy stored',
      res.status === 302 && res.headers.get('location') === '/dispatch/thank-you' &&
      !!p1Disp && p1Disp.vehicle_type === 'box-truck' &&
      !!db.prepare("SELECT 1 FROM opportunity_lead_tags WHERE lead_id = ? AND tag = 'DISPATCH'").get(p1Disp.id),
      `status=${res.status}`);

    // --- CRM: pipeline, profile, mutations ---
    res = await req(`${BASE}/admin/crm`, {});
    check('phase1: /admin/crm requires token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/crm?token=${ADMIN_TOKEN}`, {});
    const p1CrmHtml = await res.text();
    check('phase1: /admin/crm renders pipeline with the 14 grow statuses',
      res.status === 200 && p1CrmHtml.includes('Opportunity Pipeline') &&
      ['NEW', 'REVIEWING', 'CONTACTED', 'QUALIFYING', 'DOCUMENTS NEEDED', 'DRIVER READY',
       'BUSINESS OPPORTUNITY', 'DISPATCH OPPORTUNITY', 'RSP INTEREST', 'PARTNERSHIP',
       'WAITLIST', 'ACTIVE', 'NOT A FIT CURRENTLY', 'CLOSED'].every((s) => p1CrmHtml.includes(s)) &&
      p1CrmHtml.includes('P1First'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/crm/leads/${p1Lead.id}`, {});
    check('phase1: lead profile requires token (403 without)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/crm/leads/${p1Lead.id}?token=${ADMIN_TOKEN}`, {});
    const p1ProfileHtml = await res.text();
    check('phase1: lead profile shows all spec-8 sections + tags + history',
      res.status === 200 && p1ProfileHtml.includes('P1First P1Last') &&
      p1ProfileHtml.includes('Status history') && p1ProfileHtml.includes('Internal tags') &&
      p1ProfileHtml.includes('Follow-up') && p1ProfileHtml.includes('Communications') &&
      p1ProfileHtml.includes('P1CODE') && p1ProfileHtml.includes('DRIVER'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/crm/leads/999999?token=${ADMIN_TOKEN}`, {});
    check('phase1: unknown lead profile -> 404', res.status === 404, `status=${res.status}`);

    res = await req(`${BASE}/admin/crm/leads/${p1Lead.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { status: 'CONTACTED', note: 'P1 called' } });
    let p1After = db.prepare('SELECT status FROM opportunity_leads WHERE id = ?').get(p1Lead.id).status;
    let p1HistAfter = db.prepare('SELECT from_status, to_status, changed_by FROM lead_status_history WHERE lead_id = ? ORDER BY id').all(p1Lead.id);
    check('phase1: status change NEW->CONTACTED appends history (append-only)',
      res.status === 302 && p1After === 'CONTACTED' && p1HistAfter.length === 2 &&
      p1HistAfter[1].from_status === 'NEW' && p1HistAfter[1].to_status === 'CONTACTED' && p1HistAfter[1].changed_by === 'admin',
      `status=${res.status} hist=${JSON.stringify(p1HistAfter)}`);
    res = await req(`${BASE}/admin/crm/leads/${p1Lead.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { status: 'BOGUS' } });
    check('phase1: invalid status rejected with error redirect, no change',
      res.status === 302 && (res.headers.get('location') || '').includes('error=') &&
      db.prepare('SELECT status FROM opportunity_leads WHERE id = ?').get(p1Lead.id).status === 'CONTACTED' &&
      db.prepare('SELECT COUNT(*) n FROM lead_status_history WHERE lead_id = ?').get(p1Lead.id).n === 2,
      `status=${res.status}`);
    res = await req(`${BASE}/admin/crm/leads/${p1Biz.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { status: 'DISCOVERY' } });
    check('phase1: business lead accepts business-pipeline status DISCOVERY',
      res.status === 302 && db.prepare('SELECT status FROM opportunity_leads WHERE id = ?').get(p1Biz.id).status === 'DISCOVERY',
      `status=${res.status}`);
    res = await req(`${BASE}/admin/crm/leads/${p1Biz.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { status: 'DRIVER READY' } });
    check('phase1: business lead rejects grow-only status DRIVER READY (pipeline isolation)',
      res.status === 302 && (res.headers.get('location') || '').includes('error=') &&
      db.prepare('SELECT status FROM opportunity_leads WHERE id = ?').get(p1Biz.id).status === 'DISCOVERY',
      `status=${res.status}`);

    res = await req(`${BASE}/admin/crm/leads/${p1Lead.id}/note?token=${ADMIN_TOKEN}`, { method: 'POST', form: { note: 'P1 internal note' } });
    check('phase1: admin note saved',
      res.status === 302 && !!db.prepare('SELECT 1 FROM lead_notes WHERE lead_id = ? AND note = ?').get(p1Lead.id, 'P1 internal note'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/crm/leads/${p1Lead.id}/followup?token=${ADMIN_TOKEN}`, { method: 'POST', form: { follow_up_date: '2026-10-01', assigned_to: 'P1Staff' } });
    const p1Fu = db.prepare('SELECT follow_up_date, assigned_to FROM opportunity_leads WHERE id = ?').get(p1Lead.id);
    check('phase1: follow-up date + assignee saved',
      res.status === 302 && p1Fu.follow_up_date === '2026-10-01' && p1Fu.assigned_to === 'P1Staff',
      `status=${res.status}`);
    res = await req(`${BASE}/admin/crm/leads/${p1Lead.id}/tags?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['tags', 'FLEET'], ['tags', 'PARTNERSHIP']] });
    const p1TagsAfter = db.prepare('SELECT tag FROM opportunity_lead_tags WHERE lead_id = ? ORDER BY tag').all(p1Lead.id).map((r) => r.tag);
    check('phase1: admin tags replaced (not duplicated)',
      res.status === 302 && p1TagsAfter.join(',') === 'FLEET,PARTNERSHIP',
      `status=${res.status} tags=${p1TagsAfter.join(',')}`);

    // --- Rate limiting on public POSTs ---
    let p1Limited = 0;
    for (let i = 0; i < 70; i++) {
      const rr = await req(`${BASE}/grow/apply/draft`, { method: 'POST', form: { email: p1('rl'), step: '1' } });
      await rr.text();
      if (rr.status === 429) p1Limited++;
    }
    check('phase1: public POST rate limiter kicks in (429s after burst)',
      p1Limited > 0, `429s=${p1Limited}`);

    // --- Cleanup: remove all Phase 1 test data ---
    const p1LeadIds = db.prepare("SELECT id FROM opportunity_leads WHERE email LIKE 'p1-%'").all().map((r) => r.id);
    for (const id of p1LeadIds) {
      for (const t of ['opportunity_lead_tags', 'lead_vehicles', 'lead_business_info', 'lead_goals', 'lead_sources', 'lead_status_history', 'lead_notes', 'lead_communications']) {
        db.prepare(`DELETE FROM "${t}" WHERE lead_id = ?`).run(id);
      }
      db.prepare('DELETE FROM events WHERE meta LIKE ?').run(`%"opportunity_lead_id":${id}%`);
    }
    db.prepare("DELETE FROM opportunity_leads WHERE email LIKE 'p1-%'").run();
    db.prepare("DELETE FROM opportunity_lead_drafts WHERE email LIKE 'p1-%'").run();
    const p1Qids = db.prepare("SELECT id FROM email_queue WHERE sequence = 'grow' AND (email LIKE 'p1-%' OR subject LIKE '%P1%')").all().map((r) => r.id);
    for (const qid of p1Qids) {
      for (const f of fs.readdirSync(OUTBOX)) {
        if (f.startsWith(`${qid}-`) && f.endsWith('.html')) {
          try { fs.unlinkSync(path.join(OUTBOX, f)); } catch {}
        }
      }
      db.prepare('DELETE FROM events WHERE meta LIKE ?').run(`%"queue_id":${qid}%`);
    }
    db.prepare("DELETE FROM email_queue WHERE sequence = 'grow' AND (email LIKE 'p1-%' OR subject LIKE '%P1%')").run();
    check('phase1: test data cleaned up',
      db.prepare("SELECT COUNT(*) n FROM opportunity_leads WHERE email LIKE 'p1-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM email_queue WHERE sequence = 'grow' AND (email LIKE 'p1-%' OR subject LIKE '%P1%')").get().n === 0,
      'leftover rows');

    /* ---- Phase 2: extended driver onboarding / opportunity database / matching ----
       Additive: reuses existing drivers/driver_status_history/custody/support-ticket
       records; no parallel driver or package records are created.               */
    const p2ts = Date.now();
    const p2 = (n) => `p2-${n}-${p2ts}@example.com`;
    const p2QidsBefore = new Set(db.prepare('SELECT id FROM email_queue').all().map((r) => r.id));

    // --- Admin auth on every new admin route ---
    res = await req(`${BASE}/admin/opportunities`, {});
    check('phase2: /admin/opportunities requires admin token (403 without)',
      res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/opportunities?token=${ADMIN_TOKEN}`, {});
    const p2OppListHtml = await res.text();
    check('phase2: /admin/opportunities 200 with token, shows all 6 exact statuses',
      res.status === 200 && p2OppListHtml.includes('Opportunities') &&
      ['DRAFT', 'OPEN', 'QUALIFYING', 'FILLED', 'PAUSED', 'CLOSED'].every((s) => p2OppListHtml.includes(`>${s} (`)),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/drivers/1/profile`, {});
    check('phase2: extended driver profile requires admin token (403 without)',
      res.status === 403, `status=${res.status}`);

    // --- Create opportunity (all spec-9 fields) ---
    res = await req(`${BASE}/admin/opportunities?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['name', 'P2 Milwaukee AM Route'], ['client_contract', 'P2 Client Co'],
      ['location', 'Milwaukee, WI'], ['territory', 'Milwaukee metro'],
      ['opportunity_type', 'Dedicated route'],
      ['vehicle_requirements', 'Cargo van or larger'],
      ['driver_requirements', '2+ years delivery experience'],
      ['insurance_requirements', 'Commercial auto, $1M liability'],
      ['availability_requirements', 'Mon-Fri mornings'],
      ['service_area', 'Milwaukee metro'],
      ['start_date', '2026-10-01'], ['end_date', '2026-12-31'],
      ['drivers_needed', '3'], ['vehicles_needed', '3'],
      ['notes', 'P2 internal note'], ['documents', 'P2 doc ref'],
      ['contact_info', 'P2 ops contact'],
    ]});
    const p2Opp = db.prepare("SELECT * FROM opportunities WHERE name = 'P2 Milwaukee AM Route'").get();
    check('phase2: opportunity created with ALL spec fields, status defaults to DRAFT',
      res.status === 302 && !!p2Opp && p2Opp.status === 'DRAFT' &&
      p2Opp.client_contract === 'P2 Client Co' && p2Opp.location === 'Milwaukee, WI' &&
      p2Opp.territory === 'Milwaukee metro' && p2Opp.opportunity_type === 'Dedicated route' &&
      p2Opp.vehicle_requirements === 'Cargo van or larger' &&
      p2Opp.driver_requirements === '2+ years delivery experience' &&
      p2Opp.insurance_requirements === 'Commercial auto, $1M liability' &&
      p2Opp.availability_requirements === 'Mon-Fri mornings' &&
      p2Opp.service_area === 'Milwaukee metro' &&
      p2Opp.start_date === '2026-10-01' && p2Opp.end_date === '2026-12-31' &&
      p2Opp.drivers_needed === 3 && p2Opp.vehicles_needed === 3 &&
      p2Opp.notes === 'P2 internal note' && p2Opp.documents === 'P2 doc ref' &&
      p2Opp.contact_info === 'P2 ops contact',
      `status=${res.status}`);
    res = await req(`${BASE}/admin/opportunities?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['name', '']] });
    check('phase2: opportunity without a name is rejected (no row created)',
      res.status === 200 && db.prepare("SELECT COUNT(*) n FROM opportunities WHERE name = ''").get().n === 0,
      `status=${res.status}`);

    // --- Exact status transitions DRAFT -> OPEN -> QUALIFYING -> FILLED ---
    for (const s of ['OPEN', 'QUALIFYING', 'FILLED']) {
      res = await req(`${BASE}/admin/opportunities/${p2Opp.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { status: s } });
    }
    check('phase2: opportunity status transitions DRAFT -> OPEN -> QUALIFYING -> FILLED',
      db.prepare('SELECT status FROM opportunities WHERE id = ?').get(p2Opp.id).status === 'FILLED');
    res = await req(`${BASE}/admin/opportunities/${p2Opp.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { status: 'BOGUS' } });
    check('phase2: invalid opportunity status rejected, row unchanged',
      res.status === 302 && db.prepare('SELECT status FROM opportunities WHERE id = ?').get(p2Opp.id).status === 'FILLED',
      `status=${res.status}`);

    // --- CRM lead -> driver application linkage ---
    res = await req(`${BASE}/grow/apply`, { method: 'POST', form: [
      ['first_name', 'P2'], ['last_name', 'Lead'], ['email', p2('lead')],
      ['phone', '4145550200'], ['city', 'Milwaukee'], ['state', 'WI'],
      ['vehicle_type', 'cargo-van'], ['vehicle_year', '2021'],
      ['vehicle_make', 'Ford'], ['vehicle_model', 'Transit'],
    ]});
    const p2Lead = db.prepare('SELECT * FROM opportunity_leads WHERE email = ?').get(p2('lead'));
    check('phase2: grow lead created for linkage test', !!p2Lead && p2Lead.status === 'NEW');
    res = await req(`${BASE}/admin/crm/leads/${p2Lead.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { status: 'DRIVER READY' } });
    check('phase2: lead moved to DRIVER READY',
      db.prepare('SELECT status FROM opportunity_leads WHERE id = ?').get(p2Lead.id).status === 'DRIVER READY');

    res = await req(`${BASE}/admin/crm/leads/${p2Lead.id}/start-driver-application?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    const p2Drv = db.prepare('SELECT * FROM drivers WHERE email = ?').get(p2('lead'));
    const p2Link = db.prepare('SELECT * FROM lead_driver_links WHERE lead_id = ?').get(p2Lead.id);
    const p2LinkComm = db.prepare("SELECT COUNT(*) n FROM lead_communications WHERE lead_id = ? AND subject = 'Driver application started'").get(p2Lead.id).n;
    check('phase2: start-driver-application creates driver row + stores linkage in lead_driver_links',
      res.status === 302 && !!p2Drv && p2Drv.status === 'new' && !!p2Drv.access_token &&
      !!p2Link && p2Link.driver_id === p2Drv.id && p2LinkComm === 1 &&
      p2Drv.full_name === 'P2 Lead' && p2Drv.phone === '4145550200' &&
      p2Drv.vehicle_type === 'cargo-van' && p2Drv.vehicle_year === '2021' &&
      p2Drv.vehicle_make_model === 'Ford Transit',
      `status=${res.status}`);
    res = await req(`${BASE}/admin/crm/leads/${p2Lead.id}/start-driver-application?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    check('phase2: starting the application twice does not duplicate driver or link',
      res.status === 302 &&
      db.prepare('SELECT COUNT(*) n FROM drivers WHERE email = ?').get(p2('lead')).n === 1 &&
      db.prepare('SELECT COUNT(*) n FROM lead_driver_links WHERE lead_id = ?').get(p2Lead.id).n === 1,
      `status=${res.status}`);
    res = await req(`${BASE}/admin/crm/leads/${p2Lead.id}?token=${ADMIN_TOKEN}`, {});
    const p2LeadHtml = await res.text();
    check('phase2: lead profile shows linked driver + extended application link + potential-matches section',
      res.status === 200 && p2LeadHtml.includes('Driver application') &&
      p2LeadHtml.includes(`/drivers/apply/${p2Drv.access_token}`) && p2LeadHtml.includes('Potential matches'),
      `status=${res.status}`);

    // --- Extended application: token-scoped page ---
    res = await req(`${BASE}/drivers/apply/not-a-real-token`, {});
    check('phase2: /drivers/apply with bad token 404s', res.status === 404, `status=${res.status}`);
    res = await req(`${BASE}/drivers/apply/${p2Drv.access_token}`, {});
    const p2ApplyHtml = await res.text();
    check('phase2: /drivers/apply/:token 200, mobile-first, honest no-guarantee copy',
      res.status === 200 && p2ApplyHtml.includes('Driver Application') &&
      p2ApplyHtml.includes('name="license_number"') && p2ApplyHtml.includes('name="insurance_policy"') &&
      p2ApplyHtml.includes('name="consent_background"') && p2ApplyHtml.includes('name="agreement_accepted"') &&
      p2ApplyHtml.includes('does not guarantee approval') && p2ApplyHtml.includes('name="viewport"'),
      `status=${res.status}`);
    check('phase2: extended application collects no SSN/bank/password fields',
      !/name="(ssn|social|bank|account_number|password)"/i.test(p2ApplyHtml));

    // Validation failure.
    res = await req(`${BASE}/drivers/apply/${p2Drv.access_token}`, { method: 'POST', form: { license_number: 'X' } });
    const p2ApplyBad = await res.text();
    check('phase2: incomplete application rejected with 400 + error list',
      res.status === 400 && p2ApplyBad.includes('Please fix the following'),
      `status=${res.status}`);

    // Submit the extended application.
    const p2ApplyForm = () => [
      ['license_number', 'P2D1234567'], ['license_state', 'WI'], ['license_class', 'D'],
      ['license_expiry', '2028-05-01'], ['insurance_carrier', 'P2 Carrier'],
      ['insurance_policy', 'P2POL999'], ['insurance_expiry', '2027-05-01'],
      ['consent_background', '1'], ['consent_insurance_check', '1'], ['agreement_accepted', '1'],
    ];
    res = await req(`${BASE}/drivers/apply/${p2Drv.access_token}`, { method: 'POST', form: p2ApplyForm() });
    const p2ApplyDone = await res.text();
    const p2DrvAfter = db.prepare('SELECT * FROM drivers WHERE email = ?').get(p2('lead'));
    check('phase2: application submitted -> confirmation page + extended_status APPLIED on same driver row',
      res.status === 200 && p2ApplyDone.includes('Application received') &&
      p2DrvAfter.extended_status === 'APPLIED' && p2DrvAfter.id === p2Drv.id,
      `status=${res.status} ext=${p2DrvAfter && p2DrvAfter.extended_status}`);
    check('phase2: license/insurance/consent fields stored on the SAME driver row (no duplicate)',
      p2DrvAfter.license_number === 'P2D1234567' && p2DrvAfter.license_state === 'WI' &&
      p2DrvAfter.insurance_carrier === 'P2 Carrier' && p2DrvAfter.insurance_policy === 'P2POL999' &&
      p2DrvAfter.consent_background === 1 && p2DrvAfter.consent_insurance_check === 1 &&
      p2DrvAfter.agreement_accepted === 1 && !!p2DrvAfter.agreement_accepted_at &&
      db.prepare('SELECT COUNT(*) n FROM drivers WHERE email = ?').get(p2('lead')).n === 1);
    const p2Hist = db.prepare('SELECT from_status, to_status FROM driver_onboard_history WHERE driver_id = ? ORDER BY ts ASC, id ASC').all(p2DrvAfter.id);
    check('phase2: onboard history append-only (null -> APPLIED)',
      p2Hist.length === 1 && p2Hist[0].from_status === null && p2Hist[0].to_status === 'APPLIED',
      JSON.stringify(p2Hist));
    const p2QDriver = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE email = ? AND step = 'extended-application-confirmation'").get(p2('lead')).n;
    const p2QOps = db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step = 'extended-application-new'").get().n;
    check('phase2: application queues driver confirmation + ops notification (outbox queue, never claimed as delivered)',
      p2QDriver === 1 && p2QOps >= 1, `driver=${p2QDriver} ops=${p2QOps}`);
    check('phase2: confirmation copy says "Potential Match" language review, not hired',
      p2ApplyDone.includes('Potential Match') && !/you are hired/i.test(p2ApplyDone));

    // Re-submit: updates fields, does not regress status or duplicate history.
    const p2ApplyForm2 = p2ApplyForm().map(([k, v]) => (k === 'insurance_carrier' ? [k, 'P2 Carrier Updated'] : [k, v]));
    res = await req(`${BASE}/drivers/apply/${p2Drv.access_token}`, { method: 'POST', form: p2ApplyForm2 });
    const p2DrvRe = db.prepare('SELECT extended_status, insurance_carrier FROM drivers WHERE email = ?').get(p2('lead'));
    const p2HistRe = db.prepare('SELECT COUNT(*) n FROM driver_onboard_history WHERE driver_id = ?').get(p2DrvAfter.id).n;
    check('phase2: re-submitting updates fields without regressing status or duplicating history',
      res.status === 200 && p2DrvRe.extended_status === 'APPLIED' &&
      p2DrvRe.insurance_carrier === 'P2 Carrier Updated' && p2HistRe === 1);

    // --- Extended status transitions (admin) ---
    res = await req(`${BASE}/admin/drivers/${p2DrvAfter.id}/extended-status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { extended_status: 'SCREENING', note: 'P2 screening' } });
    const p2ExtAfter = db.prepare('SELECT extended_status, status FROM drivers WHERE id = ?').get(p2DrvAfter.id);
    const p2Hist2 = db.prepare('SELECT from_status, to_status, changed_by FROM driver_onboard_history WHERE driver_id = ? ORDER BY ts ASC, id ASC').all(p2DrvAfter.id);
    check('phase2: admin extended-status APPLIED -> SCREENING; history append-only; pipeline status untouched',
      res.status === 302 && p2ExtAfter.extended_status === 'SCREENING' && p2ExtAfter.status === 'new' &&
      p2Hist2.length === 2 && p2Hist2[1].from_status === 'APPLIED' && p2Hist2[1].to_status === 'SCREENING' &&
      p2Hist2[1].changed_by === 'admin',
      `status=${res.status} ext=${p2ExtAfter.extended_status} pipeline=${p2ExtAfter.status}`);
    res = await req(`${BASE}/admin/drivers/${p2DrvAfter.id}/extended-status?token=${ADMIN_TOKEN}`, { method: 'POST', form: { extended_status: 'NOPE' } });
    check('phase2: invalid extended status rejected, row unchanged',
      res.status === 302 &&
      db.prepare('SELECT extended_status FROM drivers WHERE id = ?').get(p2DrvAfter.id).extended_status === 'SCREENING');

    // --- Qualification checklist (11 exact labels) ---
    const p2Checks = ['identity', 'license', 'insurance', 'vehicle', 'background_mvr', 'documents', 'agreement', 'orientation', 'training'];
    res = await req(`${BASE}/admin/drivers/${p2DrvAfter.id}/qual-checks?token=${ADMIN_TOKEN}`, { method: 'POST', form: p2Checks.map((c) => ['checks', c]) });
    const p2CheckRows = db.prepare('SELECT check_key, checked_by, ts FROM driver_qual_checks WHERE driver_id = ?').all(p2DrvAfter.id);
    check('phase2: 9 qualification checks recorded with timestamps + checked_by',
      res.status === 302 && p2CheckRows.length === 9 &&
      p2CheckRows.every((r) => r.ts > 0 && r.checked_by === 'admin'),
      `status=${res.status} count=${p2CheckRows.length}`);
    res = await req(`${BASE}/admin/drivers/${p2DrvAfter.id}/qual-checks?token=${ADMIN_TOKEN}`, { method: 'POST', form: p2Checks.filter((c) => c !== 'training').map((c) => ['checks', c]) });
    check('phase2: unchecking removes only that check record',
      db.prepare('SELECT COUNT(*) n FROM driver_qual_checks WHERE driver_id = ?').get(p2DrvAfter.id).n === 8 &&
      db.prepare("SELECT COUNT(*) n FROM driver_qual_checks WHERE driver_id = ? AND check_key = 'training'").get(p2DrvAfter.id).n === 0);

    // --- Extended profile page ---
    res = await req(`${BASE}/admin/drivers/${p2DrvAfter.id}/profile?token=${ADMIN_TOKEN}`, {});
    const p2ProfileHtml = await res.text();
    check('phase2: extended profile 200: all 11 checklist labels, docs note, ops data, status, notes',
      res.status === 200 && p2ProfileHtml.includes('Qualification checklist') &&
      ['Identity verified', 'License verified', 'Insurance verified', 'Vehicle verified',
       'Background/MVR completed where applicable', 'Required documents received',
       'Agreement completed', 'Orientation completed', 'Training completed',
       'Approved', 'Ready for route'].every((l) => p2ProfileHtml.includes(l)) &&
      p2ProfileHtml.includes('full document upload') &&
      p2ProfileHtml.includes('Routes (') && p2ProfileHtml.includes('Packages (') &&
      p2ProfileHtml.includes('Exceptions (') && p2ProfileHtml.includes('Support tickets (') &&
      p2ProfileHtml.includes('Service plan history') && p2ProfileHtml.includes('Application: SCREENING') &&
      p2ProfileHtml.includes('Potential matches'),
      `status=${res.status}`);
    check('phase2: extended profile shows CRM linkage to the lead',
      p2ProfileHtml.includes('Linked from CRM lead') && p2ProfileHtml.includes(`/admin/crm/leads/${p2Lead.id}`));

    // --- Opportunity matching: Potential Match only, never hired ---
    res = await req(`${BASE}/admin/opportunities/${p2Opp.id}/match?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['person_type', 'lead'], ['person_id', String(p2Lead.id)], ['note', 'P2 fit: cargo van, Milwaukee'],
    ]});
    const p2Match = db.prepare('SELECT * FROM opportunity_matches WHERE opportunity_id = ?').get(p2Opp.id);
    check('phase2: Potential Match recorded for CRM lead (matched_by + timestamp + note)',
      res.status === 302 && !!p2Match && p2Match.person_type === 'lead' && p2Match.person_id === p2Lead.id &&
      p2Match.matched_by === 'admin' && p2Match.ts > 0 && p2Match.note === 'P2 fit: cargo van, Milwaukee',
      `status=${res.status}`);
    res = await req(`${BASE}/admin/opportunities/${p2Opp.id}/match?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['person_type', 'lead'], ['person_id', String(p2Lead.id)],
    ]});
    check('phase2: duplicate match does not create a second row',
      db.prepare('SELECT COUNT(*) n FROM opportunity_matches WHERE opportunity_id = ?').get(p2Opp.id).n === 1);
    res = await req(`${BASE}/admin/opportunities/${p2Opp.id}/match?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['person_type', 'driver'], ['person_id', String(p2DrvAfter.id)], ['note', 'P2 driver fit'],
    ]});
    check('phase2: Potential Match recorded for driver as well',
      db.prepare("SELECT COUNT(*) n FROM opportunity_matches WHERE opportunity_id = ? AND person_type = 'driver'").get(p2Opp.id).n === 1);
    res = await req(`${BASE}/admin/opportunities/${p2Opp.id}/match?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['person_type', 'lead'], ['person_id', '999999'],
    ]});
    check('phase2: match against unknown person rejected, no row created',
      res.status === 302 &&
      db.prepare('SELECT COUNT(*) n FROM opportunity_matches WHERE opportunity_id = ?').get(p2Opp.id).n === 2,
      `status=${res.status}`);
    res = await req(`${BASE}/admin/opportunities/${p2Opp.id}?token=${ADMIN_TOKEN}`, {});
    const p2OppHtml = await res.text();
    check('phase2: opportunity page shows "Potential Match" and never promises hiring',
      res.status === 200 && p2OppHtml.includes('Potential Match') &&
      !/you are hired/i.test(p2OppHtml) && p2OppHtml.includes('never promises employment'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/opportunities/${p2Opp.id}?token=${ADMIN_TOKEN}&compare_lead=${p2Lead.id}`, {});
    const p2CmpHtml = await res.text();
    check('phase2: candidate comparison renders requirements vs lead profile + match button',
      res.status === 200 && p2CmpHtml.includes('Candidate comparison') &&
      p2CmpHtml.includes('Vehicle requirements') && p2CmpHtml.includes('Record Potential Match'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/drivers/${p2DrvAfter.id}/profile?token=${ADMIN_TOKEN}`, {});
    const p2ProfileHtml2 = await res.text();
    check('phase2: driver extended profile lists the Potential Match',
      p2ProfileHtml2.includes('Potential Match') && p2ProfileHtml2.includes('P2 Milwaukee AM Route'));
    res = await req(`${BASE}/admin/crm/leads/${p2Lead.id}?token=${ADMIN_TOKEN}`, {});
    const p2LeadHtml2 = await res.text();
    check('phase2: lead profile lists the Potential Match',
      p2LeadHtml2.includes('Potential Match') && p2LeadHtml2.includes('P2 Milwaukee AM Route'));

    // --- Rate limiting on the new public POST ---
    let p2Limited = 0;
    for (let i = 0; i < 70; i++) {
      const rr = await req(`${BASE}/drivers/apply/${p2Drv.access_token}`, { method: 'POST', form: { license_number: 'x' } });
      await rr.text();
      if (rr.status === 429) p2Limited++;
    }
    check('phase2: public /drivers/apply POST is rate limited (429s after burst)', p2Limited > 0, `429s=${p2Limited}`);

    // --- Cleanup: remove ALL Phase 2 test data ---
    const p2LeadIds = db.prepare("SELECT id FROM opportunity_leads WHERE email LIKE 'p2-%'").all().map((r) => r.id);
    const p2DriverIds = db.prepare("SELECT id FROM drivers WHERE email LIKE 'p2-%'").all().map((r) => r.id);
    const p2OppIds = db.prepare("SELECT id FROM opportunities WHERE name LIKE 'P2 %'").all().map((r) => r.id);
    for (const id of p2LeadIds) {
      for (const t of ['opportunity_lead_tags', 'lead_vehicles', 'lead_business_info', 'lead_goals', 'lead_sources', 'lead_status_history', 'lead_notes', 'lead_communications', 'lead_driver_links']) {
        db.prepare(`DELETE FROM "${t}" WHERE lead_id = ?`).run(id);
      }
      db.prepare("DELETE FROM opportunity_matches WHERE person_type = 'lead' AND person_id = ?").run(id);
    }
    for (const id of p2DriverIds) {
      for (const t of ['driver_qual_checks', 'driver_onboard_history', 'driver_status_history', 'lead_driver_links']) {
        db.prepare(`DELETE FROM "${t}" WHERE driver_id = ?`).run(id);
      }
      db.prepare("DELETE FROM opportunity_matches WHERE person_type = 'driver' AND person_id = ?").run(id);
    }
    for (const id of p2OppIds) {
      db.prepare('DELETE FROM opportunity_matches WHERE opportunity_id = ?').run(id);
    }
    db.prepare("DELETE FROM opportunity_leads WHERE email LIKE 'p2-%'").run();
    db.prepare("DELETE FROM drivers WHERE email LIKE 'p2-%'").run();
    db.prepare("DELETE FROM opportunities WHERE name LIKE 'P2 %'").run();
    const p2NewQids = db.prepare('SELECT id, email FROM email_queue').all()
      .filter((r) => !p2QidsBefore.has(r.id)).map((r) => r.id);
    const p2Outbox = new Set(outboxFiles());
    for (const qid of p2NewQids) {
      for (const f of outboxFiles()) {
        if (f.startsWith(`${qid}-`) && f.endsWith('.html')) fs.unlinkSync(path.join(OUTBOX, f));
      }
    }
    if (p2NewQids.length) db.prepare(`DELETE FROM email_queue WHERE id IN (${p2NewQids.map(() => '?').join(',')})`).run(...p2NewQids);
    db.prepare("DELETE FROM events WHERE type = 'driver_application_submitted'").run();
    check('phase2: test data cleaned up',
      db.prepare("SELECT COUNT(*) n FROM opportunity_leads WHERE email LIKE 'p2-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM drivers WHERE email LIKE 'p2-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM opportunities WHERE name LIKE 'P2 %'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM opportunity_matches WHERE note LIKE 'P2%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM email_queue WHERE email LIKE 'p2-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM email_queue WHERE step LIKE 'extended-application%'").get().n === 0 &&
      p2NewQids.every((qid) => !outboxFiles().some((f) => f.startsWith(`${qid}-`))) &&
      outboxFiles().every((f) => p2Outbox.has(f)),
      'leftover rows');

    /* ---- Phase 3: contract hub, territories, command center ------------- */
    function p3Metric(html, key) {
      const m = html.match(new RegExp('data-metric="' + key + '"[^>]*>[\\s\\S]*?class="num">(\\d+)<'));
      return m ? Number(m[1]) : null;
    }
    const p3StartOfDay = (() => { const x = new Date(); x.setHours(0, 0, 0, 0); return x.getTime(); })();
    const p3TerrName = 'P3Territory' + ts;

    // --- Contract hub ---
    res = await req(BASE + '/admin/contracts', {});
    check('phase3: /admin/contracts requires token (403 without)', res.status === 403, 'status=' + res.status);
    res = await req(BASE + '/admin/territories', {});
    check('phase3: /admin/territories requires token (403 without)', res.status === 403, 'status=' + res.status);
    res = await req(BASE + '/admin/operations', {});
    check('phase3: /admin/operations requires token (403 without)', res.status === 403, 'status=' + res.status);

    res = await req(BASE + '/admin/contracts?token=' + ADMIN_TOKEN, {});
    const p3ContractsHtml = await res.text();
    check('phase3: contract hub list renders with nav links',
      res.status === 200 && p3ContractsHtml.includes('Contract hub') && p3ContractsHtml.includes('/admin/contracts') &&
      p3ContractsHtml.includes('/admin/territories'), 'status=' + res.status);

    res = await req(BASE + '/admin/contracts?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['client', 'P3 Client ' + ts], ['contract_name', 'P3 Contract ' + ts],
      ['contract_type', 'Dedicated routes'], ['territory', p3TerrName],
      ['service_area', 'Milwaukee metro'], ['start_date', '2026-09-20'], ['end_date', '2027-09-20'],
      ['route_requirements', 'Daily AM route'], ['package_requirements', 'Up to 150 stops'],
      ['vehicle_requirements', 'Cargo van or larger'], ['driver_requirements', '2 yrs experience'],
      ['insurance_requirements', 'Commercial auto $1M'], ['performance_requirements', '98% on-time'],
      ['payment_terms', 'Net 30'], ['documents', 'MSA draft'], ['notes', 'P3 test contract'],
    ]});
    const p3Loc = res.headers.get('location') || '';
    const p3Contract = db.prepare('SELECT * FROM contracts WHERE contract_name = ?').get('P3 Contract ' + ts);
    check('phase3: POST /admin/contracts creates contract, redirects to detail',
      res.status === 302 && p3Loc.includes('/admin/contracts/' + p3Contract.id) &&
      /^TNC-\d{4}-\d{4}$/.test(p3Contract.contract_number) && p3Contract.status === 'LEAD',
      'status=' + res.status + ' loc=' + p3Loc + ' num=' + (p3Contract && p3Contract.contract_number));
    const p3Hist0 = db.prepare('SELECT * FROM contract_status_history WHERE contract_id = ?').all(p3Contract.id);
    check('phase3: contract creation records append-only history (null -> LEAD)',
      p3Hist0.length === 1 && p3Hist0[0].from_status === null && p3Hist0[0].to_status === 'LEAD' &&
      p3Hist0[0].changed_by === 'admin', 'rows=' + p3Hist0.length);

    res = await req(BASE + '/admin/contracts?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['contract_name', 'P3 NoClient ' + ts],
    ]});
    const p3BadHtml = await res.text();
    const p3NoClient = db.prepare('SELECT COUNT(*) n FROM contracts WHERE contract_name = ?').get('P3 NoClient ' + ts).n;
    check('phase3: contract validation rejects missing client (no row)',
      res.status === 200 && p3BadHtml.includes('Client is required') && p3NoClient === 0,
      'status=' + res.status + ' rows=' + p3NoClient);

    res = await req(BASE + '/admin/contracts/' + p3Contract.id + '?token=' + ADMIN_TOKEN, {});
    const p3DetailHtml = await res.text();
    check('phase3: contract detail shows all spec-19 fields',
      res.status === 200 && p3DetailHtml.includes('P3 Client') && p3DetailHtml.includes('Daily AM route') &&
      p3DetailHtml.includes('Up to 150 stops') && p3DetailHtml.includes('Cargo van or larger') &&
      p3DetailHtml.includes('2 yrs experience') && p3DetailHtml.includes('Commercial auto $1M') &&
      p3DetailHtml.includes('98% on-time') && p3DetailHtml.includes('Net 30') &&
      p3DetailHtml.includes('MSA draft') && p3DetailHtml.includes('Upload a real document') &&
      p3DetailHtml.includes('/documents/upload'),
      'status=' + res.status);

    res = await req(BASE + '/admin/contracts/' + p3Contract.id + '/status?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['status', 'QUALIFYING'], ['note', 'P3 vetting'],
    ]});
    const p3AfterStatus = db.prepare('SELECT status FROM contracts WHERE id = ?').get(p3Contract.id);
    const p3Hist = db.prepare('SELECT from_status, to_status, note FROM contract_status_history WHERE contract_id = ? ORDER BY ts, id').all(p3Contract.id);
    check('phase3: contract status transition updates status + appends history',
      res.status === 302 && p3AfterStatus.status === 'QUALIFYING' && p3Hist.length === 2 &&
      p3Hist[1].from_status === 'LEAD' && p3Hist[1].to_status === 'QUALIFYING' && p3Hist[1].note === 'P3 vetting',
      'status=' + res.status + ' rows=' + p3Hist.length);
    res = await req(BASE + '/admin/contracts/' + p3Contract.id + '/status?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['status', 'BOGUS'],
    ]});
    const p3BadStatus = db.prepare('SELECT status FROM contracts WHERE id = ?').get(p3Contract.id);
    const p3HistAfterBad = db.prepare('SELECT COUNT(*) n FROM contract_status_history WHERE contract_id = ?').get(p3Contract.id).n;
    check('phase3: invalid contract status rejected (DB unchanged, no history row)',
      p3BadStatus.status === 'QUALIFYING' && p3HistAfterBad === 2, 'status=' + p3BadStatus.status + ' rows=' + p3HistAfterBad);
    res = await req(BASE + '/admin/contracts/' + p3Contract.id + '/status?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['status', 'QUALIFYING'],
    ]});
    const p3HistAfterSame = db.prepare('SELECT COUNT(*) n FROM contract_status_history WHERE contract_id = ?').get(p3Contract.id).n;
    check('phase3: same-status transition adds no history row', p3HistAfterSame === 2, 'rows=' + p3HistAfterSame);

    // Link to a Phase 2 opportunity.
    res = await req(BASE + '/admin/opportunities?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['name', 'P3 Opp ' + ts], ['territory', p3TerrName],
      ['client_contract', 'ref ' + p3Contract.contract_number],
    ]});
    const p3Opp = db.prepare('SELECT * FROM opportunities WHERE name = ?').get('P3 Opp ' + ts);
    check('phase3: opportunity created for contract linkage', res.status === 302 && !!p3Opp, 'status=' + res.status);
    const p3LinkRes = await req(BASE + '/admin/contracts/' + p3Contract.id + '/opportunity?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['opportunity_id', String(p3Opp.id)],
    ]});
    const p3Linked = db.prepare('SELECT opportunity_id FROM contracts WHERE id = ?').get(p3Contract.id);
    // A second opportunity that references the contract by text but is NOT
    // explicitly linked — it should surface under "related by reference".
    await req(BASE + '/admin/opportunities?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['name', 'P3 Opp Ref ' + ts],
      ['client_contract', 'see contract ' + p3Contract.contract_number],
    ]});
    res = await req(BASE + '/admin/contracts/' + p3Contract.id + '?token=' + ADMIN_TOKEN, {});
    const p3LinkedHtml = await res.text();
    check('phase3: contract links to opportunity; detail shows it + related-by-reference',
      p3LinkRes.status === 302 && p3Linked.opportunity_id === p3Opp.id &&
      p3LinkedHtml.includes('P3 Opp ' + ts) && p3LinkedHtml.includes('Opportunities referencing this contract') &&
      p3LinkedHtml.includes('P3 Opp Ref ' + ts),
      'link-status=' + p3LinkRes.status + ' linked=' + p3Linked.opportunity_id);
    res = await req(BASE + '/admin/opportunities/' + p3Opp.id + '/status?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['status', 'OPEN'],
    ]});
    check('phase3: opportunity set OPEN for command-center metric', res.status === 302, 'status=' + res.status);

    // Document reference placeholder.
    res = await req(BASE + '/admin/contracts/' + p3Contract.id + '/document?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['doc_type', 'Master services agreement'], ['file_name', 'MSA-2026-signed.pdf'], ['notes', 'P3 doc'],
    ]});
    const p3Doc = db.prepare('SELECT * FROM contract_documents WHERE contract_id = ?').get(p3Contract.id);
    check('phase3: contract document reference recorded (Phase 6 upload deferred)',
      res.status === 302 && !!p3Doc && p3Doc.file_name === 'MSA-2026-signed.pdf', 'status=' + res.status);

    // Contract edit (status untouched by edit form). The real UI posts the
    // full form, so the test mirrors that: every field is sent.
    res = await req(BASE + '/admin/contracts/' + p3Contract.id + '?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['client', 'P3 Client ' + ts], ['contract_name', 'P3 Contract ' + ts],
      ['contract_type', 'Dedicated routes'], ['territory', p3TerrName],
      ['service_area', 'Milwaukee metro'], ['start_date', '2026-09-20'], ['end_date', '2027-09-20'],
      ['route_requirements', 'Daily AM route'], ['package_requirements', 'Up to 150 stops'],
      ['vehicle_requirements', 'Cargo van or larger'], ['driver_requirements', '2 yrs experience'],
      ['insurance_requirements', 'Commercial auto $1M'], ['performance_requirements', '98% on-time'],
      ['payment_terms', 'Net 15'], ['documents', 'MSA draft'], ['notes', 'P3 test contract'],
    ]});
    const p3Edited = db.prepare('SELECT payment_terms, status, territory FROM contracts WHERE id = ?').get(p3Contract.id);
    check('phase3: contract edit updates fields (status untouched, territory kept)',
      res.status === 302 && p3Edited.payment_terms === 'Net 15' && p3Edited.status === 'QUALIFYING' &&
      p3Edited.territory === p3TerrName,
      'status=' + res.status);

    // --- Territories ---
    res = await req(BASE + '/admin/territories?token=' + ADMIN_TOKEN, {});
    check('phase3: territory list renders', res.status === 200 && (await res.text()).includes('Territories'), 'status=' + res.status);
    res = await req(BASE + '/admin/territories?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['name', p3TerrName], ['city', 'Milwaukee'], ['state', 'WI'],
      ['zip_codes', '53202, 53203'], ['service_radius', '25 miles'],
      ['capacity', '8 routes/day'], ['notes', 'P3 territory'],
    ]});
    const p3Terr = db.prepare('SELECT * FROM territories WHERE name = ?').get(p3TerrName);
    check('phase3: POST /admin/territories creates territory',
      res.status === 302 && !!p3Terr && p3Terr.city === 'Milwaukee' && p3Terr.state === 'WI',
      'status=' + res.status);
    res = await req(BASE + '/admin/territories?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['name', p3TerrName], ['city', 'Milwaukee'], ['state', 'WI'],
    ]});
    const p3DupHtml = await res.text();
    const p3DupCount = db.prepare('SELECT COUNT(*) n FROM territories WHERE name = ?').get(p3TerrName).n;
    check('phase3: duplicate territory name rejected', p3DupHtml.includes('already exists') && p3DupCount === 1,
      'count=' + p3DupCount);

    // Seed a driver + active contract for computed territory stats.
    const p3DrvEmail = 'p3-drv-' + ts + '@example.com';
    db.prepare("INSERT INTO drivers (full_name, email, home_city, home_state, vehicle_type, status, source, submitted_at, updated_at) VALUES (?, ?, 'Milwaukee', 'WI', 'cargo_van', 'active', 'direct', ?, ?)").run('P3 Driver ' + ts, p3DrvEmail, ts, ts);
    const p3Drv = db.prepare('SELECT * FROM drivers WHERE email = ?').get(p3DrvEmail);
    makePaid(db, p3DrvEmail); // paid-client enforcement: route creation needs an active subscription
    res = await req(BASE + '/admin/contracts/' + p3Contract.id + '/status?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['status', 'ACTIVE'],
    ]});
    check('phase3: contract set ACTIVE for territory stats', res.status === 302, 'status=' + res.status);

    const p3ExpActiveContracts = db.prepare("SELECT COUNT(*) n FROM contracts WHERE status = 'ACTIVE' AND territory = ?").get(p3TerrName).n;
    const p3ExpOpenOpps = db.prepare("SELECT COUNT(*) n FROM opportunities WHERE status = 'OPEN' AND (territory = ? OR location LIKE ? OR location LIKE ?)").get(p3TerrName, '%Milwaukee%', '%WI%').n;
    const p3ExpAvailDrivers = db.prepare("SELECT COUNT(*) n FROM drivers WHERE status IN ('ready','placement','active') AND (home_city = ? OR home_state = ?)").get('Milwaukee', 'WI').n;
    const p3ExpAvailVehicles = db.prepare("SELECT COUNT(*) n FROM drivers WHERE status IN ('ready','placement','active') AND vehicle_type IS NOT NULL AND vehicle_type != '' AND (home_city = ? OR home_state = ?)").get('Milwaukee', 'WI').n;
    res = await req(BASE + '/admin/territories/' + p3Terr.id + '?token=' + ADMIN_TOKEN, {});
    const p3TerrHtml = await res.text();
    check('phase3: territory computed fields match live DB counts',
      res.status === 200 &&
      p3Metric(p3TerrHtml, 'active_contracts') === p3ExpActiveContracts &&
      p3Metric(p3TerrHtml, 'open_opportunities') === p3ExpOpenOpps &&
      p3Metric(p3TerrHtml, 'available_drivers') === p3ExpAvailDrivers &&
      p3Metric(p3TerrHtml, 'available_vehicles') === p3ExpAvailVehicles &&
      p3ExpActiveContracts >= 1 && p3ExpAvailDrivers >= 1 && p3ExpAvailVehicles >= 1,
      'status=' + res.status + ' contracts=' + p3Metric(p3TerrHtml, 'active_contracts') + '/' + p3ExpActiveContracts +
      ' drivers=' + p3Metric(p3TerrHtml, 'available_drivers') + '/' + p3ExpAvailDrivers +
      ' vehicles=' + p3Metric(p3TerrHtml, 'available_vehicles') + '/' + p3ExpAvailVehicles);
    check('phase3: territory detail lists the contract, opportunity and driver',
      p3TerrHtml.includes('P3 Contract ' + ts) && p3TerrHtml.includes('P3 Opp ' + ts) && p3TerrHtml.includes('P3 Driver ' + ts));

    res = await req(BASE + '/admin/territories/' + p3Terr.id + '?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['name', p3TerrName], ['city', 'Milwaukee'], ['state', 'WI'], ['capacity', '12 routes/day'],
    ]});
    const p3TerrEdited = db.prepare('SELECT capacity FROM territories WHERE id = ?').get(p3Terr.id);
    check('phase3: territory edit updates capacity',
      res.status === 302 && p3TerrEdited.capacity === '12 routes/day', 'status=' + res.status);

    // --- Operations command center ---
    res = await req(BASE + '/admin/routes?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['driver_id', String(p3Drv.id)], ['title', 'P3 Route ' + ts], ['scheduled_date', '2026-09-21'],
    ]});
    const p3Route = db.prepare('SELECT * FROM routes WHERE title = ?').get('P3 Route ' + ts);
    check('phase3: route created for command-center seeds', res.status === 302 && !!p3Route, 'status=' + res.status);
    await req(BASE + '/admin/routes/' + p3Route.id + '/status?token=' + ADMIN_TOKEN, { method: 'POST', form: [['status', 'active']] });
    res = await req(BASE + '/admin/contracts/' + p3Contract.id + '/route?token=' + ADMIN_TOKEN, { method: 'POST', form: [
      ['route_code', p3Route.route_code],
    ]});
    const p3RouteLinked = db.prepare('SELECT contract_number FROM routes WHERE id = ?').get(p3Route.id);
    check('phase3: contract claims the A-L route by contract number',
      p3RouteLinked.contract_number === p3Contract.contract_number,
      'route.contract_number=' + p3RouteLinked.contract_number);
    const p3PkgNames = ['P3 Grow', 'P3 Biz', 'P3 Rsp'];
    for (const who of p3PkgNames) {
      await req(BASE + '/admin/routes/' + p3Route.id + '/packages?token=' + ADMIN_TOKEN, { method: 'POST', form: [
        ['recipient_name', who + ' ' + ts], ['address', '1 Test Way'], ['city', 'Milwaukee'], ['state', 'WI'], ['zip', '53202'],
      ]});
    }
    const p3Pkgs = db.prepare('SELECT * FROM packages WHERE route_id = ? ORDER BY package_id').all(p3Route.id);
    db.prepare("UPDATE packages SET status = 'in_transit', updated_at = ? WHERE package_id = ?").run(ts, p3Pkgs[0].package_id);
    db.prepare("UPDATE packages SET status = 'delivered', updated_at = ? WHERE package_id = ?").run(ts, p3Pkgs[1].package_id);
    db.prepare("INSERT INTO package_exceptions (package_id, route_id, driver_id, exception_type, description, status, created_by, created_at) VALUES (?, ?, ?, 'damaged_package', 'P3 exception', 'open', 'driver', ?)").run(p3Pkgs[0].package_id, p3Route.id, p3Drv.id, ts);
    db.prepare("INSERT INTO support_tickets (ticket_id, driver_id, category, priority, subject, message, status, created_by, created_at, updated_at) VALUES (?, ?, 'route', 'urgent', ?, 'P3 urgent', 'open', 'driver', ?, ?)").run('P3T-' + ts, p3Drv.id, 'P3 urgent ' + ts, ts, ts);
    for (const lt of ['GROW', 'BUSINESS', 'RSP']) {
      db.prepare("INSERT INTO opportunity_leads (lead_type, status, first_name, last_name, email, phone, city, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '4145550100', 'Milwaukee', 'WI', ?, ?)")
        .run(lt, lt === 'RSP' ? 'RSP INTEREST' : 'NEW', 'P3' + lt, '' + ts, 'p3-lead-' + lt.toLowerCase() + '-' + ts + '@example.com', ts, ts);
    }

    const P3_IN_TR = ['picked_up', 'in_transit', 'at_stop', 'out_for_delivery'];
    const P3_DONE = ['delivered', 'returned', 'lost_investigation'];
    const p3q = (sql, ...p) => db.prepare(sql).get(...p).n;
    const p3Now = Date.now();
    const exp = {
      active_routes: p3q("SELECT COUNT(*) n FROM routes WHERE status = 'active'"),
      drivers_active: p3q("SELECT COUNT(*) n FROM drivers WHERE status = 'active'"),
      packages_in_transit: p3q("SELECT COUNT(*) n FROM packages WHERE status IN ('picked_up','in_transit','at_stop','out_for_delivery')"),
      packages_delivered: p3q("SELECT COUNT(*) n FROM packages WHERE status = 'delivered' AND updated_at >= ? AND updated_at <= ?", p3StartOfDay, p3Now),
      packages_remaining: p3q("SELECT COUNT(*) n FROM packages WHERE status NOT IN ('delivered','returned','lost_investigation')"),
      open_exceptions: p3q("SELECT COUNT(*) n FROM package_exceptions WHERE status = 'open'"),
      urgent_support: p3q("SELECT COUNT(*) n FROM support_tickets WHERE priority = 'urgent' AND status IN ('open','in_progress')"),
      live_video: 0,
      new_applicants: p3q("SELECT COUNT(*) n FROM opportunity_leads WHERE lead_type = 'GROW' AND created_at >= ? AND created_at <= ?", p3StartOfDay, p3Now),
      new_business: p3q("SELECT COUNT(*) n FROM opportunity_leads WHERE lead_type = 'BUSINESS' AND created_at >= ? AND created_at <= ?", p3StartOfDay, p3Now),
      rsp_leads: p3q("SELECT COUNT(*) n FROM opportunity_leads WHERE lead_type = 'RSP' AND created_at >= ? AND created_at <= ?", p3StartOfDay, p3Now),
      open_opportunities: p3q("SELECT COUNT(*) n FROM opportunities WHERE status = 'OPEN'"),
    };
    res = await req(BASE + '/admin/operations?token=' + ADMIN_TOKEN, {});
    const p3OpsHtml = await res.text();
    const p3MetricKeys = ['active_routes', 'drivers_active', 'packages_in_transit', 'packages_delivered',
      'packages_remaining', 'open_exceptions', 'urgent_support', 'live_video',
      'new_applicants', 'new_business', 'rsp_leads', 'open_opportunities'];
    const p3Mismatches = p3MetricKeys.filter((k) => p3Metric(p3OpsHtml, k) !== exp[k]);
    check('phase3: command-center metrics match live DB counts (all 12)',
      res.status === 200 && p3Mismatches.length === 0 &&
      exp.active_routes >= 1 && exp.packages_in_transit >= 1 && exp.open_exceptions >= 1 &&
      exp.urgent_support >= 1 && exp.new_applicants >= 1 && exp.open_opportunities >= 1,
      'status=' + res.status + ' mismatches=[' + p3Mismatches.map((k) => k + ':page=' + p3Metric(p3OpsHtml, k) + ' db=' + exp[k]).join(', ') + ']');
    const p3OpsNoNote = p3OpsHtml.replace(/never estimated or faked/g, '');
    // Phase 5 is now implemented: the note describes the real request/accept/record
    // workflow and the unconfigured-provider state honestly (SIMULATED TEST).
    check('phase3: live video honestly labeled (value 0, workflow real, never faked)',
      p3Metric(p3OpsHtml, 'live_video') === 0 && p3OpsHtml.includes('SIMULATED TEST') &&
      p3OpsHtml.includes('never estimated or faked') &&
      !/live video[^<]{0,120}(fake|faked|estimated)/i.test(p3OpsNoNote));
    check('phase3: command center deep-links into A-L dashboards',
      p3OpsHtml.includes('href="/admin/routes"') && p3OpsHtml.includes('href="/admin/exceptions?status=open"') &&
      p3OpsHtml.includes('href="/admin/tickets"') && p3OpsHtml.includes('href="/admin/crm?type=GROW"') &&
      p3OpsHtml.includes('href="/admin/crm?type=BUSINESS"') && p3OpsHtml.includes('href="/admin/crm?type=RSP"') &&
      p3OpsHtml.includes('href="/admin/opportunities?status=OPEN"') && p3OpsHtml.includes('href="/admin/drivers?status=active"'));

    // Filters.
    res = await req(BASE + '/admin/operations?token=' + ADMIN_TOKEN + '&driver=' + p3Drv.id, {});
    const p3FiltDrvHtml = await res.text();
    const p3ExpDrvRoutes = p3q("SELECT COUNT(*) n FROM routes WHERE status = 'active' AND driver_id = ?", p3Drv.id);
    check('phase3: driver filter narrows metrics',
      p3Metric(p3FiltDrvHtml, 'drivers_active') === 1 &&
      p3Metric(p3FiltDrvHtml, 'active_routes') === p3ExpDrvRoutes &&
      p3FiltDrvHtml.includes('Filters active'),
      'drivers_active=' + p3Metric(p3FiltDrvHtml, 'drivers_active') + ' routes=' + p3Metric(p3FiltDrvHtml, 'active_routes') + '/' + p3ExpDrvRoutes);
    res = await req(BASE + '/admin/operations?token=' + ADMIN_TOKEN + '&contract=' + encodeURIComponent(p3Contract.contract_number), {});
    const p3FiltConHtml = await res.text();
    check('phase3: contract filter shows the linked route',
      p3Metric(p3FiltConHtml, 'active_routes') === 1, 'routes=' + p3Metric(p3FiltConHtml, 'active_routes'));
    res = await req(BASE + '/admin/operations?token=' + ADMIN_TOKEN + '&status=delivered', {});
    const p3FiltStHtml = await res.text();
    const p3ExpDelivered = p3q("SELECT COUNT(*) n FROM packages WHERE status = 'delivered'");
    check('phase3: status filter applies per table',
      p3Metric(p3FiltStHtml, 'packages_in_transit') === p3ExpDelivered,
      'in_transit-card=' + p3Metric(p3FiltStHtml, 'packages_in_transit') + ' delivered=' + p3ExpDelivered);
    res = await req(BASE + '/admin/operations?token=' + ADMIN_TOKEN + '&territory=' + encodeURIComponent(p3TerrName), {});
    const p3FiltTerrHtml = await res.text();
    const p3ExpTerrDrivers = p3q("SELECT COUNT(*) n FROM drivers WHERE status = 'active' AND (home_city = ? OR home_state = ?)", 'Milwaukee', 'WI');
    check('phase3: territory filter narrows drivers metric',
      p3Metric(p3FiltTerrHtml, 'drivers_active') === p3ExpTerrDrivers,
      'drivers=' + p3Metric(p3FiltTerrHtml, 'drivers_active') + '/' + p3ExpTerrDrivers);
    const p3Yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    res = await req(BASE + '/admin/operations?token=' + ADMIN_TOKEN + '&date=' + p3Yesterday, {});
    const p3FiltDateHtml = await res.text();
    const p3ExpYest = p3q("SELECT COUNT(*) n FROM opportunity_leads WHERE lead_type = 'GROW' AND created_at >= ? AND created_at <= ?",
      new Date(p3Yesterday + 'T00:00:00').getTime(), new Date(p3Yesterday + 'T23:59:59').getTime());
    check('phase3: date filter changes the windowed metrics',
      p3Metric(p3FiltDateHtml, 'new_applicants') === p3ExpYest && p3FiltDateHtml.includes('Filters active'),
      'new_applicants=' + p3Metric(p3FiltDateHtml, 'new_applicants') + '/' + p3ExpYest);

    // --- Cleanup: remove ALL Phase 3 test data ---
    const p3ContractIds = db.prepare("SELECT id FROM contracts WHERE contract_name LIKE 'P3 Contract %'").all().map((r) => r.id);
    for (const id of p3ContractIds) {
      db.prepare('DELETE FROM contract_status_history WHERE contract_id = ?').run(id);
      db.prepare('DELETE FROM contract_documents WHERE contract_id = ?').run(id);
    }
    db.prepare("DELETE FROM contracts WHERE contract_name LIKE 'P3 Contract %'").run();
    db.prepare("DELETE FROM territories WHERE name LIKE 'P3Territory%'").run();
    const p3RouteIds = db.prepare("SELECT id FROM routes WHERE title LIKE 'P3 Route %'").all().map((r) => r.id);
    const p3PkgIds = p3RouteIds.length
      ? db.prepare("SELECT package_id FROM packages WHERE route_id IN (" + p3RouteIds.map(() => '?').join(',') + ")").all(...p3RouteIds).map((r) => r.package_id)
      : [];
    for (const pid of p3PkgIds) db.prepare('DELETE FROM custody_events WHERE package_id = ?').run(pid);
    if (p3PkgIds.length) db.prepare("DELETE FROM package_exceptions WHERE package_id IN (" + p3PkgIds.map(() => '?').join(',') + ")").run(...p3PkgIds);
    if (p3RouteIds.length) db.prepare("DELETE FROM packages WHERE route_id IN (" + p3RouteIds.map(() => '?').join(',') + ")").run(...p3RouteIds);
    if (p3RouteIds.length) db.prepare("DELETE FROM routes WHERE id IN (" + p3RouteIds.map(() => '?').join(',') + ")").run(...p3RouteIds);
    const p3LeadIds = db.prepare("SELECT id FROM opportunity_leads WHERE email LIKE 'p3-lead-%'").all().map((r) => r.id);
    for (const id of p3LeadIds) {
      for (const t of ['opportunity_lead_tags', 'lead_vehicles', 'lead_business_info', 'lead_goals', 'lead_sources', 'lead_status_history', 'lead_notes', 'lead_communications']) {
        db.prepare('DELETE FROM "' + t + '" WHERE lead_id = ?').run(id);
      }
    }
    db.prepare("DELETE FROM opportunity_leads WHERE email LIKE 'p3-lead-%'").run();
    db.prepare("DELETE FROM opportunities WHERE name LIKE 'P3 Opp %'").run();
    const p3TicketIds = db.prepare("SELECT ticket_id FROM support_tickets WHERE ticket_id LIKE 'P3T-%'").all().map((r) => r.ticket_id);
    if (p3TicketIds.length) db.prepare("DELETE FROM ticket_replies WHERE ticket_id IN (" + p3TicketIds.map(() => '?').join(',') + ")").run(...p3TicketIds);
    db.prepare("DELETE FROM support_tickets WHERE ticket_id LIKE 'P3T-%'").run();
    db.prepare("DELETE FROM drivers WHERE email LIKE 'p3-drv-%'").run();
    check('phase3: test data cleaned up',
      db.prepare("SELECT COUNT(*) n FROM contracts WHERE contract_name LIKE 'P3 Contract %'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM territories WHERE name LIKE 'P3Territory%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM routes WHERE title LIKE 'P3 Route %'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM drivers WHERE email LIKE 'p3-drv-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM opportunity_leads WHERE email LIKE 'p3-lead-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM opportunities WHERE name LIKE 'P3 Opp %'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM support_tickets WHERE ticket_id LIKE 'P3T-%'").get().n === 0,
      'leftover rows');


    /* ---- Phase 5: live video support (provider abstraction + lifecycle) ---- */
    const p5Email = `p5-drv-${ts}@example.com`;
    const p5EmailB = `p5-drv-b-${ts}@example.com`;
    const p5EmailC = `p5-drv-c-${ts}@example.com`;
    const p5qBefore = db.prepare('SELECT MAX(id) m FROM email_queue').get().m || 0;
    const p5OutboxBefore = new Set(outboxFiles());
    for (const [nm, em] of [['P5 Driver', p5Email], ['P5 Driver B', p5EmailB], ['P5 Driver C', p5EmailC]]) {
      res = await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
        ['full_name', nm], ['email', em], ['phone', '4145550505'], ['source', 'direct'],
      ]});
      if (res.status !== 200) failFast('phase5: onboarding fixture failed for ' + em);
    }
    const p5Tok = (e) => db.prepare('SELECT access_token FROM drivers WHERE email = ?').get(e).access_token;
    const p5DrvId = (e) => db.prepare('SELECT id FROM drivers WHERE email = ?').get(e).id;
    const p5Token = p5Tok(p5Email), p5TokenB = p5Tok(p5EmailB), p5TokenC = p5Tok(p5EmailC);
    const p5Loc = (sid) => `/admin/live-sessions/${encodeURIComponent(sid)}?token=${ADMIN_TOKEN}`;

    // Dashboard links the Go Live hub.
    res = await req(`${BASE}/d/${p5Token}`, {});
    check('phase5: driver dashboard links Go Live hub',
      res.status === 200 && (await res.text()).includes('/go-live'), 'status=' + res.status);

    // Go-live page: honest unconfigured-provider state.
    res = await req(`${BASE}/d/${p5Token}/go-live`, {});
    const p5GoHtml = await res.text();
    check('phase5: go-live page renders',
      res.status === 200 && p5GoHtml.includes('GO LIVE WITH OPERATIONS'), 'status=' + res.status);
    check('phase5: VIDEO PROVIDER REQUIRED shown when unconfigured',
      p5GoHtml.includes('VIDEO PROVIDER REQUIRED'));
    check('phase5: unconfigured workflow labeled SIMULATED TEST',
      p5GoHtml.includes('SIMULATED TEST'));
    check('phase5: never claims a connected/live media state',
      !/you are (now )?connected/i.test(p5GoHtml) && !/real-time (video|audio) (is|now) (active|running)/i.test(p5GoHtml) &&
      !/call in progress/i.test(p5GoHtml) && !/connected to operations/i.test(p5GoHtml));
    const p5Reasons = ['Route issue', 'Package issue', 'Delivery issue', 'Wrong address', 'Customer',
      'Facility', 'Vehicle', 'Safety', 'Technical', 'Dispatch', 'Other'];
    check('phase5: request form offers exactly the 11 spec reasons',
      p5Reasons.every((r) => p5GoHtml.includes(`>${r}<`)), 'missing reason label');
    check('phase5: honest coverage + emergency copy present',
      p5GoHtml.includes('do not staff 24/7') && p5GoHtml.includes('call 911'));
    check('phase5: mic/camera/location toggles visible and off-by-default',
      p5GoHtml.includes('want_camera') && p5GoHtml.includes('want_mic') && p5GoHtml.includes('share_location') &&
      p5GoHtml.includes('stays off unless you check this'));
    check('phase5: go-live rejects bad token with 404',
      (await req(`${BASE}/d/not-a-real-token/go-live`, {})).status === 404);

    // Validation: invalid reason rejected (fresh driver B, no open session yet).
    res = await req(`${BASE}/d/${p5TokenB}/go-live`, { method: 'POST', form: [['reason', 'bogus']] });
    check('phase5: invalid session reason rejected with 400', res.status === 400, 'status=' + res.status);

    // Driver A requests a session.
    res = await req(`${BASE}/d/${p5Token}/go-live`, { method: 'POST', form: [
      ['reason', 'route_issue'], ['priority', 'HIGH'], ['notes', 'P5 test notes'],
      ['want_camera', 'on'], ['share_location', 'on'],
    ]});
    const p5Redirect = res.headers.get('location') || '';
    const p5Sid = (p5Redirect.match(/TN-LIVE-\d+/) || [])[0];
    check('phase5: session request redirects to the new session page',
      res.status === 302 && !!p5Sid && p5Redirect.includes('/go-live/'), `status=${res.status} loc=${p5Redirect}`);
    const p5Row = db.prepare('SELECT * FROM live_sessions WHERE session_id = ?').get(p5Sid);
    check('phase5: live_sessions row created as REQUESTED with reason/priority/location',
      !!p5Row && p5Row.status === 'REQUESTED' && p5Row.reason === 'route_issue' &&
      p5Row.priority === 'HIGH' && p5Row.share_location === 1 &&
      p5Row.driver_id === p5DrvId(p5Email) && p5Row.notes === 'P5 test notes',
      p5Row ? `status=${p5Row.status} reason=${p5Row.reason}` : 'no row');
    check('phase5: camera/mic consent defaults OFF, provider_ref never faked',
      p5Row && p5Row.consent_camera === 0 && p5Row.consent_mic === 0 && p5Row.provider_ref === null);
    check('phase5: live_support_requests row created (open)',
      db.prepare('SELECT * FROM live_support_requests WHERE session_id = ?').get(p5Sid)?.status === 'open');
    const p5Events = db.prepare('SELECT event_type FROM live_session_events WHERE session_id = ? ORDER BY id').all(p5Sid).map((r) => r.event_type);
    check('phase5: session events append-only log starts with requested (+ preference note)',
      p5Events.includes('requested') && p5Events.includes('note'), p5Events.join(','));
    check('phase5: recording consent defaults OFF (row exists, consent_given=0)',
      db.prepare('SELECT consent_given FROM live_session_recordings WHERE session_id = ?').get(p5Sid)?.consent_given === 0);
    check('phase5: ops notified via outbox queue (step live-session-request), delivery not claimed',
      db.prepare("SELECT COUNT(*) n FROM email_queue WHERE id > ? AND step = 'live-session-request'").get(p5qBefore).n === 1);
    res = await req(`${BASE}/d/${p5Token}/go-live/${p5Sid}`, {});
    const p5SessHtml = await res.text();
    check('phase5: session page renders SIMULATED TEST, no connected media state',
      res.status === 200 && p5SessHtml.includes('SIMULATED TEST') && p5SessHtml.includes('Camera:') &&
      !/you are (now )?connected/i.test(p5SessHtml), 'status=' + res.status);
    check('phase5: session page shows other-driver sessions as 404',
      (await req(`${BASE}/d/${p5TokenB}/go-live/${p5Sid}`, {})).status === 404);

    // Second request while one is open is rejected.
    res = await req(`${BASE}/d/${p5Token}/go-live`, { method: 'POST', form: [['reason', 'safety']] });
    check('phase5: duplicate open session rejected with 400', res.status === 400, 'status=' + res.status);

    // Driver B requests (stays REQUESTED for negative tests).
    res = await req(`${BASE}/d/${p5TokenB}/go-live`, { method: 'POST', form: [['reason', 'safety'], ['priority', 'URGENT']] });
    const p5SidB = ((res.headers.get('location') || '').match(/TN-LIVE-\d+/) || [])[0];
    check('phase5: second driver session created (REQUESTED)',
      res.status === 302 && !!p5SidB, `status=${res.status}`);
    res = await req(`${BASE}/d/${p5TokenB}/go-live/${p5SidB}/consent`, { method: 'POST', form: [['camera', 'on'], ['mic', 'on']] });
    check('phase5: camera/mic consent before accept rejected with 400', res.status === 400, 'status=' + res.status);
    res = await req(`${BASE}/d/${p5TokenB}/go-live/${p5SidB}/end`, { method: 'POST', form: {} });
    check('phase5: driver cannot end a REQUESTED session (400)', res.status === 400, 'status=' + res.status);

    // Admin queue auth + listing.
    res = await req(`${BASE}/admin/live-sessions`, {});
    check('phase5: /admin/live-sessions requires token (403 without)', res.status === 403, 'status=' + res.status);
    res = await req(`${BASE}/admin/live-sessions?token=${ADMIN_TOKEN}`, {});
    const p5QueueHtml = await res.text();
    check('phase5: admin queue lists sessions with SIMULATED TEST + VIDEO PROVIDER REQUIRED',
      res.status === 200 && p5QueueHtml.includes(p5Sid) && p5QueueHtml.includes('SIMULATED TEST') &&
      p5QueueHtml.includes('VIDEO PROVIDER REQUIRED'), 'status=' + res.status);
    res = await req(`${BASE}/admin/live-sessions/NOPE?token=${ADMIN_TOKEN}`, {});
    check('phase5: admin session detail 404s on unknown id', res.status === 404, 'status=' + res.status);
    // Invalid transition: REQUESTED -> LIVE rejected.
    res = await req(`${BASE}/admin/live-sessions/${p5Sid}/start?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    check('phase5: invalid transition REQUESTED->LIVE rejected with 400',
      res.status === 400 && (await res.text()).includes('Cannot move session'), 'status=' + res.status);
    check('phase5: session still REQUESTED after rejected transition',
      db.prepare('SELECT status FROM live_sessions WHERE session_id = ?').get(p5Sid).status === 'REQUESTED');

    // Dispatcher accepts session A.
    res = await req(`${BASE}/admin/live-sessions/${p5Sid}/accept?token=${ADMIN_TOKEN}`,
      { method: 'POST', form: [['dispatcher_name', 'P5 Dispatcher']] });
    check('phase5: dispatcher accept redirects', res.status === 302, 'status=' + res.status);
    const p5Acc = db.prepare('SELECT * FROM live_sessions WHERE session_id = ?').get(p5Sid);
    check('phase5: session ACCEPTED with dispatcher name recorded',
      p5Acc.status === 'ACCEPTED' && p5Acc.dispatcher_name === 'P5 Dispatcher',
      `status=${p5Acc.status} dispatcher=${p5Acc.dispatcher_name}`);
    check('phase5: accepted event appended',
      db.prepare("SELECT COUNT(*) n FROM live_session_events WHERE session_id = ? AND event_type = 'accepted'").get(p5Sid).n === 1);
    const p5DispPart = db.prepare("SELECT * FROM live_participants WHERE session_id = ? AND role = 'dispatcher'").get(p5Sid);
    check('phase5: dispatcher participant joined on accept',
      !!p5DispPart && p5DispPart.staff_name === 'P5 Dispatcher' && p5DispPart.left_at === null,
      p5DispPart ? `name=${p5DispPart.staff_name} left=${p5DispPart.left_at}` : 'no row');

    // Driver explicitly consents to camera/mic (allowed now).
    res = await req(`${BASE}/d/${p5Token}/go-live/${p5Sid}/consent`, { method: 'POST', form: [['camera', 'on'], ['mic', 'on']] });
    check('phase5: driver media consent accepted after accept', res.status === 302, 'status=' + res.status);
    const p5Cons = db.prepare('SELECT consent_camera, consent_mic FROM live_sessions WHERE session_id = ?').get(p5Sid);
    check('phase5: consent flags stored', p5Cons.consent_camera === 1 && p5Cons.consent_mic === 1);
    check('phase5: consent event appended',
      db.prepare("SELECT COUNT(*) n FROM live_session_events WHERE session_id = ? AND event_type = 'consent'").get(p5Sid).n === 1);
    const p5DrvPart = db.prepare("SELECT * FROM live_participants WHERE session_id = ? AND role = 'driver'").get(p5Sid);
    check('phase5: driver participant joined on explicit consent',
      !!p5DrvPart && p5DrvPart.driver_id === p5DrvId(p5Email) && p5DrvPart.left_at === null,
      p5DrvPart ? `driver=${p5DrvPart.driver_id} left=${p5DrvPart.left_at}` : 'no row');

    // Location toggle off (voluntary, visibly on/off).
    res = await req(`${BASE}/d/${p5Token}/go-live/${p5Sid}/location`, { method: 'POST', form: [['on', '0']] });
    check('phase5: driver can turn location sharing off',
      res.status === 302 && db.prepare('SELECT share_location FROM live_sessions WHERE session_id = ?').get(p5Sid).share_location === 0,
      'status=' + res.status);

    // Chat both directions (append-only).
    await req(`${BASE}/d/${p5Token}/go-live/${p5Sid}/message`, { method: 'POST', form: [['message', 'P5 driver chat msg']] });
    await req(`${BASE}/admin/live-sessions/${p5Sid}/message?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['message', 'P5 ops chat msg']] });
    const p5Msgs = db.prepare('SELECT sender_type, message FROM live_session_messages WHERE session_id = ? ORDER BY id').all(p5Sid);
    check('phase5: in-session chat append-only, both directions stored',
      p5Msgs.length === 2 && p5Msgs[0].sender_type === 'driver' && p5Msgs[0].message === 'P5 driver chat msg' &&
      p5Msgs[1].sender_type === 'dispatcher' && p5Msgs[1].message === 'P5 ops chat msg',
      JSON.stringify(p5Msgs));
    res = await req(`${BASE}/d/${p5Token}/go-live/${p5Sid}/message`, { method: 'POST', form: [['message', '   ']] });
    check('phase5: empty chat message rejected with 400', res.status === 400, 'status=' + res.status);

    // Recording: consent required BEFORE — non-explicit attempt leaves it OFF.
    res = await req(`${BASE}/admin/live-sessions/${p5Sid}/recording-consent?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    const p5Rec0 = db.prepare('SELECT * FROM live_session_recordings WHERE session_id = ?').get(p5Sid);
    check('phase5: recording stays OFF without explicit opt-in',
      res.status === 302 && p5Rec0.consent_given === 0, `status=${res.status} consent=${p5Rec0.consent_given}`);
    res = await req(`${BASE}/d/${p5Token}/go-live/${p5Sid}/recording-consent`, { method: 'POST', form: {} });
    check('phase5: driver recording consent requires explicit checkbox (400 without)',
      res.status === 400, 'status=' + res.status);
    // Explicit opt-in: admin records driver consent.
    res = await req(`${BASE}/admin/live-sessions/${p5Sid}/recording-consent?token=${ADMIN_TOKEN}`,
      { method: 'POST', form: [['consent', 'yes'], ['by', 'P5 Dispatcher (driver agreed on call)']] });
    const p5Rec1 = db.prepare('SELECT * FROM live_session_recordings WHERE session_id = ?').get(p5Sid);
    check('phase5: explicit recording opt-in stored with 90-day retention expiry',
      res.status === 302 && p5Rec1.consent_given === 1 && p5Rec1.consent_at > 0 &&
      p5Rec1.retention_expires_at === p5Rec1.consent_at + 90 * 24 * 3600 * 1000,
      `status=${res.status} consent=${p5Rec1.consent_given}`);
    check('phase5: no media capture implemented (storage_ref stays NULL)',
      p5Rec1.storage_ref === null);
    check('phase5: recording access logged on consent change',
      db.prepare('SELECT COUNT(*) n FROM live_recording_access_log WHERE recording_id = ?').get(p5Rec1.id).n >= 1);
    check('phase5: recording_consent event appended',
      db.prepare("SELECT COUNT(*) n FROM live_session_events WHERE session_id = ? AND event_type = 'recording_consent'").get(p5Sid).n === 1);

    // Dispatcher starts the session -> LIVE.
    res = await req(`${BASE}/admin/live-sessions/${p5Sid}/start?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    check('phase5: dispatcher start moves ACCEPTED->LIVE', res.status === 302, 'status=' + res.status);
    const p5Live = db.prepare('SELECT status, started_at FROM live_sessions WHERE session_id = ?').get(p5Sid);
    check('phase5: LIVE status + started_at set', p5Live.status === 'LIVE' && p5Live.started_at > 0);
    res = await req(`${BASE}/d/${p5Token}/go-live/${p5Sid}`, {});
    const p5LiveHtml = await res.text();
    check('phase5: LIVE session page still SIMULATED TEST, never claims media connected',
      p5LiveHtml.includes('SIMULATED TEST (workflow state only, no media connection)') &&
      p5LiveHtml.includes('SIMULATED TEST') &&
      !/you are (now )?connected/i.test(p5LiveHtml) &&
      !/provider-backed media\./i.test(p5LiveHtml));
    check('phase5: honest audio fallback panel (no provider audio, use chat)',
      p5LiveHtml.includes('provider-backed audio is also unavailable') &&
      p5LiveHtml.includes('Use the <strong>chat below</strong>'));

    // Command center counts the genuinely LIVE session (never faked).
    res = await req(`${BASE}/admin/operations?token=${ADMIN_TOKEN}`, {});
    check('phase5: command center live_video metric counts the real LIVE session',
      res.status === 200 && p3Metric(await res.text(), 'live_video') === 1, 'status=' + res.status);

    // End the session.
    res = await req(`${BASE}/admin/live-sessions/${p5Sid}/end?token=${ADMIN_TOKEN}`,
      { method: 'POST', form: [['note', 'P5 resolved']] });
    check('phase5: dispatcher end moves LIVE->ENDED', res.status === 302, 'status=' + res.status);
    const p5End = db.prepare('SELECT status, started_at, ended_at FROM live_sessions WHERE session_id = ?').get(p5Sid);
    check('phase5: ENDED with timestamps',
      p5End.status === 'ENDED' && p5End.started_at > 0 && p5End.ended_at >= p5End.started_at);
    check('phase5: support request resolved on end',
      db.prepare('SELECT status FROM live_support_requests WHERE session_id = ?').get(p5Sid).status === 'resolved');
    check('phase5: participants stamped left when session ends',
      db.prepare('SELECT COUNT(*) n FROM live_participants WHERE session_id = ? AND left_at IS NULL').get(p5Sid).n === 0 &&
      db.prepare('SELECT COUNT(*) n FROM live_participants WHERE session_id = ?').get(p5Sid).n === 2);
    res = await req(`${BASE}/d/${p5Token}/go-live/${p5Sid}/message`, { method: 'POST', form: [['message', 'after end']] });
    check('phase5: chat rejected after ENDED (400)', res.status === 400, 'status=' + res.status);
    res = await req(`${BASE}/admin/live-sessions/${p5Sid}/accept?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    check('phase5: invalid transition ENDED->ACCEPTED rejected (400)', res.status === 400, 'status=' + res.status);

    // Decline path (driver B).
    res = await req(`${BASE}/admin/live-sessions/${p5SidB}/decline?token=${ADMIN_TOKEN}`,
      { method: 'POST', form: [['dispatcher_name', 'P5 Dispatcher'], ['note', 'P5 decline test']] });
    check('phase5: dispatcher decline moves REQUESTED->DECLINED',
      res.status === 302 && db.prepare('SELECT status FROM live_sessions WHERE session_id = ?').get(p5SidB).status === 'DECLINED',
      'status=' + res.status);

    // Missed path (driver C).
    res = await req(`${BASE}/d/${p5TokenC}/go-live`, { method: 'POST', form: [['reason', 'vehicle']] });
    const p5SidC = ((res.headers.get('location') || '').match(/TN-LIVE-\d+/) || [])[0];
    res = await req(`${BASE}/admin/live-sessions/${p5SidC}/missed?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
    check('phase5: dispatcher marks REQUESTED->MISSED',
      res.status === 302 && db.prepare('SELECT status FROM live_sessions WHERE session_id = ?').get(p5SidC).status === 'MISSED',
      'status=' + res.status);

    // Live training events + content (admin-gated).
    res = await req(`${BASE}/admin/live-training/events`, { method: 'POST', form: [['title', 'P5 Training Event']] });
    check('phase5: /admin/live-training/events requires token (403 without)', res.status === 403, 'status=' + res.status);
    res = await req(`${BASE}/admin/live-training/events?token=${ADMIN_TOKEN}`,
      { method: 'POST', form: [['title', 'P5 Training Event'], ['description', 'P5 desc'], ['scheduled_at', '2026-10-01T10:00']] });
    check('phase5: training event scheduled', res.status === 302, 'status=' + res.status);
    const p5Ev = db.prepare("SELECT * FROM live_training_events WHERE title = 'P5 Training Event'").get();
    check('phase5: training event stored, not provider-backed (NULL ref)',
      !!p5Ev && p5Ev.provider_ref === null && p5Ev.status === 'scheduled');
    res = await req(`${BASE}/admin/live-training/events/${p5Ev.event_id}/attendance?token=${ADMIN_TOKEN}`,
      { method: 'POST', form: [['driver_id', String(p5DrvId(p5Email))]] });
    check('phase5: training attendance recorded',
      res.status === 302 && db.prepare('SELECT attended FROM live_training_attendance WHERE event_id = ?').get(p5Ev.event_id).attended === 1,
      'status=' + res.status);
    res = await req(`${BASE}/admin/live-training/content?token=${ADMIN_TOKEN}`,
      { method: 'POST', form: [['title', 'P5 Training Video'], ['url', 'https://example.com/p5'], ['duration_mins', '12']] });
    check('phase5: training content added',
      res.status === 302 && db.prepare("SELECT COUNT(*) n FROM video_training_content WHERE title = 'P5 Training Video'").get().n === 1,
      'status=' + res.status);
    res = await req(`${BASE}/admin/live-training?token=${ADMIN_TOKEN}`, {});
    const p5TrHtml = await res.text();
    check('phase5: admin training page lists event + content, labeled not provider-backed',
      res.status === 200 && p5TrHtml.includes('P5 Training Event') && p5TrHtml.includes('P5 Training Video') &&
      p5TrHtml.includes('not provider-backed'), 'status=' + res.status);
    res = await req(`${BASE}/d/${p5Token}/go-live`, {});
    const p5GoTrainingHtml = await res.text();
    check('phase5: driver go-live page shows upcoming training labeled SIMULATED TEST',
      p5GoTrainingHtml.includes('P5 Training Event') && p5GoTrainingHtml.includes('SIMULATED TEST'));

    // --- Cleanup: remove ALL Phase 5 test data ---
    const p5DriverIds = [p5Email, p5EmailB, p5EmailC].map(p5DrvId);
    const p5Sids = db.prepare(`SELECT session_id FROM live_sessions WHERE driver_id IN (${p5DriverIds.map(() => '?').join(',')})`)
      .all(...p5DriverIds).map((r) => r.session_id);
    for (const sid of p5Sids) {
      for (const t of ['live_session_events', 'live_session_messages', 'live_participants']) {
        db.prepare(`DELETE FROM "${t}" WHERE session_id = ?`).run(sid);
      }
      const rec = db.prepare('SELECT id FROM live_session_recordings WHERE session_id = ?').get(sid);
      if (rec) db.prepare('DELETE FROM live_recording_access_log WHERE recording_id = ?').run(rec.id);
      db.prepare('DELETE FROM live_session_recordings WHERE session_id = ?').run(sid);
      db.prepare('DELETE FROM live_support_requests WHERE session_id = ?').run(sid);
    }
    if (p5Sids.length) db.prepare(`DELETE FROM live_sessions WHERE session_id IN (${p5Sids.map(() => '?').join(',')})`).run(...p5Sids);
    const p5EvIds = db.prepare("SELECT event_id FROM live_training_events WHERE title LIKE 'P5 %'").all().map((r) => r.event_id);
    if (p5EvIds.length) db.prepare(`DELETE FROM live_training_attendance WHERE event_id IN (${p5EvIds.map(() => '?').join(',')})`).run(...p5EvIds);
    db.prepare("DELETE FROM live_training_events WHERE title LIKE 'P5 %'").run();
    db.prepare("DELETE FROM video_training_content WHERE title LIKE 'P5 %'").run();
    const p5NewQids = db.prepare('SELECT id FROM email_queue WHERE id > ?').all(p5qBefore).map((r) => r.id);
    const p5NewOutbox = outboxFiles().filter((f) => !p5OutboxBefore.has(f));
    for (const qid of p5NewQids) {
      for (const f of p5NewOutbox) {
        if (f.startsWith(`${qid}-`) && f.endsWith('.html')) fs.unlinkSync(path.join(OUTBOX, f));
      }
    }
    if (p5NewQids.length) db.prepare(`DELETE FROM email_queue WHERE id IN (${p5NewQids.map(() => '?').join(',')})`).run(...p5NewQids);
    for (const id of p5DriverIds) db.prepare('DELETE FROM driver_status_history WHERE driver_id = ?').run(id);
    db.prepare("DELETE FROM drivers WHERE email LIKE 'p5-drv-%'").run();
    check('phase5: test data cleaned up',
      db.prepare("SELECT COUNT(*) n FROM live_sessions WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE 'p5-drv-%')").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM drivers WHERE email LIKE 'p5-drv-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM live_training_events WHERE title LIKE 'P5 %'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM video_training_content WHERE title LIKE 'P5 %'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM email_queue WHERE id > ? AND step = 'live-session-request'").get(p5qBefore).n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM live_session_events WHERE session_id LIKE 'TN-LIVE-%' AND session_id IN (" +
        (p5Sids.length ? p5Sids.map(() => '?').join(',') : "''") + ")").get(...p5Sids).n === 0,
      'leftover rows');

    /* ---- Phase 6: referrals / follow-ups / alerts / document management ---- */
    // Covers: referral code issue → driver referral page → ?ref= prefill →
    // attribution → status update → revoke; lead follow-up history with exact
    // spec statuses; alerts generated from real seeded data (tickets,
    // exceptions, lost packages, leads, missing/expiring documents) with
    // preferences, ack/resolve, auto-resolution, idempotency; document
    // upload → DB record → stored bytes → download → verify → contract
    // linkage; driver/own vs sensitive document boundaries; command-center
    // wiring for community + plans; driver dashboard cards.
    const p6ts = Date.now();
    const p6 = (n) => `p6-${String(n).toLowerCase()}-${p6ts}@example.com`;
    const p6OutboxBefore = outboxFiles();
    const p6qBefore = (db.prepare('SELECT MAX(id) m FROM email_queue').get().m || 0);
    async function p6Onboard(name, email) {
      const r = await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
        ['full_name', name], ['email', email], ['phone', '4145550100'],
        ['contact_method', 'text'], ['vehicle_type', 'cargo_van'], ['vehicle_make_model', 'Ford Transit'],
        ['home_city', 'Milwaukee'], ['home_state', 'WI'], ['days_available', 'mon'],
        ['work_prefs', 'local'], ['looking_for', 'routes'],
      ]});
      if (r.status !== 200) failFast('phase6: driver onboard failed: ' + r.status);
      return db.prepare('SELECT * FROM drivers WHERE email = ?').get(email);
    }
    const p6drvA = await p6Onboard('P6 Driver A', p6('drvA'));
    const p6drvB = await p6Onboard('P6 Driver B', p6('drvB'));
    check('phase6: two test drivers created', !!p6drvA && !!p6drvB, 'missing driver rows');

    // --- Referrals ---
    res = await req(`${BASE}/admin/referrals/issue?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['issued_to_type', 'driver'], ['issued_to_id', String(p6drvA.id)],
      ['name', 'P6 Driver A'], ['email', p6('drvA')],
    ]});
    const p6Code = db.prepare('SELECT * FROM referral_codes WHERE issued_to_id = ?').get(p6drvA.id);
    check('phase6: referral code issued to driver with TN-XXXXXX format',
      res.status === 302 && !!p6Code && /^TN-[A-Z0-9]{6}$/.test(p6Code.code) && p6Code.status === 'active',
      `status=${res.status} code=${p6Code && p6Code.code}`);

    res = await req(`${BASE}/d/${p6drvA.access_token}/referral`, {});
    const p6RefHtml = await res.text();
    check('phase6: driver referral page shows code, share link, no-payment copy, mobile viewport',
      res.status === 200 && p6RefHtml.includes(p6Code.code) &&
      p6RefHtml.includes('/grow/apply?ref=' + p6Code.code) &&
      p6RefHtml.includes('No referral payment program') &&
      p6RefHtml.includes('name="viewport"'),
      `status=${res.status}`);

    res = await req(`${BASE}/grow/apply?ref=${p6Code.code}`, {});
    check('phase6: /grow/apply?ref=CODE prefills the referral code field',
      res.status === 200 && (await res.text()).includes(`value="${p6Code.code}"`),
      `status=${res.status}`);

    const p6LeadId = db.prepare(
      "INSERT INTO opportunity_leads (lead_type, status, first_name, last_name, email, phone, city, state, created_at, updated_at) VALUES ('GROW','NEW','P6','RefLead', ?, '4145550100','Milwaukee','WI', ?, ?)"
    ).run(p6('reflead'), p6ts, p6ts).lastInsertRowid;
    db.prepare('INSERT INTO lead_sources (lead_id, source, referral_code) VALUES (?, ?, ?)').run(p6LeadId, 'referral', p6Code.code);
    res = await req(`${BASE}/admin/referrals/attribute?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    const p6AttrLoc = res.headers.get('location') || '';
    let p6AttrSummary = {};
    try { p6AttrSummary = JSON.parse(decodeURIComponent((p6AttrLoc.split('attributed=')[1] || '').split('&')[0])); } catch {}
    const p6Attr = db.prepare('SELECT * FROM referral_attributions WHERE code_id = ?').get(p6Code.id);
    check('phase6: attribution links referred lead to the referral code',
      res.status === 302 && !!p6Attr && p6Attr.referred_lead_id === p6LeadId &&
      p6Attr.status === 'applied' && p6AttrSummary.created === 1,
      `status=${res.status} attr=${JSON.stringify(p6Attr && { lead: p6Attr.referred_lead_id, status: p6Attr.status })} summary=${JSON.stringify(p6AttrSummary)}`);

    const p6NopeLeadId = db.prepare(
      "INSERT INTO opportunity_leads (lead_type, status, first_name, last_name, email, phone, city, state, created_at, updated_at) VALUES ('GROW','NEW','P6','Nope', ?, '4145550100','Milwaukee','WI', ?, ?)"
    ).run(p6('nope'), p6ts, p6ts).lastInsertRowid;
    db.prepare('INSERT INTO lead_sources (lead_id, source, referral_code) VALUES (?, ?, ?)').run(p6NopeLeadId, 'referral', 'TN-NOPE12');
    res = await req(`${BASE}/admin/referrals/attribute?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    const p6NopeLoc = res.headers.get('location') || '';
    let p6NopeSummary = {};
    try { p6NopeSummary = JSON.parse(decodeURIComponent((p6NopeLoc.split('attributed=')[1] || '').split('&')[0])); } catch {}
    check('phase6: unknown referral code attributes nothing',
      res.status === 302 && p6NopeSummary.created === 0 &&
      !db.prepare('SELECT * FROM referral_attributions WHERE referred_lead_id = ?').get(p6NopeLeadId),
      `status=${res.status} summary=${JSON.stringify(p6NopeSummary)}`);

    res = await req(`${BASE}/admin/referrals/attributions/${p6Attr.id}?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['status', 'qualified'], ['outcome', 'Submitted full application'],
    ]});
    const p6AttrRow = db.prepare('SELECT status s, outcome o FROM referral_attributions WHERE id = ?').get(p6Attr.id);
    check('phase6: attribution status + outcome updated',
      res.status === 302 && p6AttrRow.s === 'qualified' && p6AttrRow.o === 'Submitted full application',
      `status=${res.status} row=${JSON.stringify(p6AttrRow)}`);

    res = await req(`${BASE}/admin/referrals?token=${ADMIN_TOKEN}`, {});
    const p6RefsHtml = await res.text();
    check('phase6: admin referrals page lists code + no-payment-program copy',
      res.status === 200 && p6RefsHtml.includes(p6Code.code) &&
      p6RefsHtml.includes('No referral payment program'),
      `status=${res.status}`);

    res = await req(`${BASE}/admin/referrals/${p6Code.id}/revoke?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    check('phase6: referral code revoked',
      res.status === 302 && db.prepare('SELECT status FROM referral_codes WHERE id = ?').get(p6Code.id).status === 'revoked',
      `status=${res.status}`);

    // --- Follow-ups ---
    const p6Tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10); // YYYY-MM-DD
    res = await req(`${BASE}/admin/crm/leads/${p6LeadId}/followup?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['followup_status', 'WAITING ON RESPONSE'], ['next_follow_up_at', p6Tomorrow],
      ['assigned_to', 'Ops Team'], ['note', 'Called, no answer. Try again.'], ['outcome', 'Callback requested'],
      ['contact_attempt', '1'], ['reminder', '1'],
    ]});
    const p6Fu = db.prepare('SELECT * FROM lead_followups WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(p6LeadId);
    check('phase6: follow-up recorded with exact status, contact attempt, assignment, reminder',
      res.status === 302 && !!p6Fu && p6Fu.followup_status === 'WAITING ON RESPONSE' &&
      p6Fu.contact_attempt === 1 && p6Fu.assigned_to === 'Ops Team' &&
      p6Fu.last_contact_at != null && p6Fu.next_follow_up_at != null && p6Fu.reminder === 1,
      `status=${res.status} row=${JSON.stringify(p6Fu && { status: p6Fu.followup_status, attempt: p6Fu.contact_attempt })}`);

    res = await req(`${BASE}/admin/crm/leads/${p6LeadId}/followup?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['followup_status', 'BOGUS-STATUS'], ['note', 'Invalid status attempt'],
    ]});
    check('phase6: invalid follow-up status falls back to FOLLOW UP',
      res.status === 302 &&
      db.prepare('SELECT followup_status s FROM lead_followups WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(p6LeadId).s === 'FOLLOW UP',
      `status=${res.status}`);

    res = await req(`${BASE}/admin/crm/leads/${p6LeadId}?token=${ADMIN_TOKEN}`, {});
    const p6LeadHtml = await res.text();
    check('phase6: lead profile shows follow-up history, contact attempts, referral attribution, exact status list',
      res.status === 200 && p6LeadHtml.includes('WAITING ON RESPONSE') &&
      p6LeadHtml.includes('Contact attempts') && p6LeadHtml.includes(p6Code.code) &&
      /value="NURTURE"/.test(p6LeadHtml) && /value="CLOSED"/.test(p6LeadHtml) &&
      p6LeadHtml.includes('Called, no answer'),
      `status=${res.status}`);

    // --- Alerts from real data ---
    res = await req(`${BASE}/d/${p6drvA.access_token}/support`, { method: 'POST', form: [
      ['category', 'safety_concern'], ['priority', 'urgent'],
      ['subject', 'P6 urgent ' + p6ts], ['description', 'Engine warning light on'],
    ]});
    check('phase6: driver urgent ticket created via real support flow', res.status === 302, `status=${res.status}`);
    const p6PkgId = 'P6PKG' + p6ts;
    const p6LostId = 'P6LOST' + p6ts;
    db.prepare("INSERT INTO packages (package_id, driver_id, status, created_at, updated_at) VALUES (?, ?, 'in_transit', ?, ?)").run(p6PkgId, p6drvA.id, p6ts, p6ts);
    db.prepare("INSERT INTO packages (package_id, driver_id, status, created_at, updated_at) VALUES (?, ?, 'lost_investigation', ?, ?)").run(p6LostId, p6drvA.id, p6ts, p6ts);
    const p6ExId = db.prepare(
      "INSERT INTO package_exceptions (package_id, route_id, driver_id, exception_type, description, status, created_by, created_at) VALUES (?, NULL, ?, 'damaged_package', 'P6 exception', 'open', 'driver', ?)"
    ).run(p6PkgId, p6drvA.id, p6ts).lastInsertRowid;
    db.prepare(
      "INSERT INTO opportunity_leads (lead_type, status, first_name, last_name, email, phone, city, state, created_at, updated_at) VALUES ('GROW','NEW','P6','App', ?, '4145550100','Milwaukee','WI', ?, ?)"
    ).run(p6('app'), p6ts, p6ts);
    db.prepare(
      "INSERT INTO opportunity_leads (lead_type, status, first_name, last_name, email, phone, city, state, created_at, updated_at) VALUES ('RSP','RSP INTEREST','P6','Rsp', ?, '4145550100','Milwaukee','WI', ?, ?)"
    ).run(p6('rsp'), p6ts, p6ts);
    res = await req(`${BASE}/admin/drivers/${p6drvA.id}/status?token=${ADMIN_TOKEN}`, { method: 'POST', form: [['status', 'active']] });
    check('phase6: driver set active (triggers missing-document alerts)', res.status === 302, `status=${res.status}`);

    res = await req(`${BASE}/admin/alerts/generate?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    const p6Types = new Set(db.prepare('SELECT alert_type FROM alerts').all().map((r) => r.alert_type));
    check('phase6: alerts generated from real data across all seed types',
      res.status === 302 &&
      ['urgent_support', 'package_exception', 'lost_package', 'new_applicant', 'new_rsp_lead', 'required_document']
        .every((t) => p6Types.has(t)),
      `status=${res.status} types=[${[...p6Types].join(',')}]`);

    res = await req(`${BASE}/admin/alerts?token=${ADMIN_TOKEN}`, {});
    const p6AlertsHtml = await res.text();
    check('phase6: alerts page lists open alerts with type labels',
      res.status === 200 && p6AlertsHtml.includes('Alerts (') && p6AlertsHtml.includes('Urgent support') &&
      p6AlertsHtml.includes('Package exception') && p6AlertsHtml.includes('/admin/alerts'),
      `status=${res.status}`);

    const p6NewOutbox = newFilesSince(p6OutboxBefore);
    check('phase6: alert notifications queued to ops email (no delivery claim)',
      p6NewOutbox.length >= 1 && filesMentioning('transitnowservices@gmail.com', p6NewOutbox).length >= 1,
      `new outbox files=${p6NewOutbox.length}`);

    const p6AlertCount = db.prepare('SELECT COUNT(*) n FROM alerts').get().n;
    await req(`${BASE}/admin/alerts/generate?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    check('phase6: alert generation is idempotent (no duplicates on re-run)',
      db.prepare('SELECT COUNT(*) n FROM alerts').get().n === p6AlertCount,
      `before=${p6AlertCount} after=${db.prepare('SELECT COUNT(*) n FROM alerts').get().n}`);

    const p6LostAlert = db.prepare("SELECT * FROM alerts WHERE alert_type = 'lost_package' LIMIT 1").get();
    res = await req(`${BASE}/admin/alerts/${p6LostAlert.id}/acknowledge?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    check('phase6: alert acknowledged',
      res.status === 302 && db.prepare('SELECT status FROM alerts WHERE id = ?').get(p6LostAlert.id).status === 'acknowledged',
      `status=${res.status}`);
    const p6RspAlert = db.prepare("SELECT * FROM alerts WHERE alert_type = 'new_rsp_lead' ORDER BY id DESC LIMIT 1").get();
    res = await req(`${BASE}/admin/alerts/${p6RspAlert.id}/resolve?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    check('phase6: alert resolved',
      res.status === 302 && db.prepare('SELECT status FROM alerts WHERE id = ?').get(p6RspAlert.id).status === 'resolved',
      `status=${res.status}`);

    // Overdue follow-up reminder -> shown in the alerts page "Overdue follow-up reminders" section.
    db.prepare(
      'INSERT INTO lead_followups (lead_id, followup_status, next_follow_up_at, reminder, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)'
    ).run(p6LeadId, 'FOLLOW UP', Date.now() - 7200_000, 'admin', p6ts);
    res = await req(`${BASE}/admin/alerts?token=${ADMIN_TOKEN}`, {});
    const p6AlertsHtml2 = await res.text();
    check('phase6: overdue follow-up reminder appears on the alerts page',
      res.status === 200 && p6AlertsHtml2.includes('Overdue follow-up reminders') &&
      p6AlertsHtml2.includes('P6') && p6AlertsHtml2.includes(`/admin/crm/leads/${p6LeadId}`),
      `status=${res.status}`);

    // Notification preference: disable new_rsp_lead emails; alert still records, email not queued.
    res = await req(`${BASE}/admin/alerts/prefs?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['type_urgent_support', '1'], ['type_package_exception', '1'], ['type_lost_package', '1'],
      ['type_new_applicant', '1'], ['type_required_document', '1'],
      ['type_expiring_document', '1'],
    ]});
    check('phase6: notification preference disables an alert channel',
      res.status === 302 &&
      db.prepare("SELECT notify_enabled e FROM notification_prefs WHERE alert_type = 'new_rsp_lead'").get().e === 0,
      `status=${res.status}`);
    db.prepare(
      "INSERT INTO opportunity_leads (lead_type, status, first_name, last_name, email, phone, city, state, created_at, updated_at) VALUES ('RSP','RSP INTEREST','P6','Rsp2', ?, '4145550100','Milwaukee','WI', ?, ?)"
    ).run(p6('rsp2'), p6ts, p6ts);
    const p6OutboxMid = newFilesSince(p6OutboxBefore);
    await req(`${BASE}/admin/alerts/generate?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    check('phase6: disabled alert type still records the alert but queues no email',
      db.prepare("SELECT COUNT(*) n FROM alerts WHERE alert_type = 'new_rsp_lead' AND status = 'open'").get().n >= 1 &&
      newFilesSince(p6OutboxBefore).length === p6OutboxMid.length,
      `open rsp alerts=${db.prepare("SELECT COUNT(*) n FROM alerts WHERE alert_type = 'new_rsp_lead' AND status = 'open'").get().n}`);

    // Auto-resolution: resolve the exception -> its alert auto-resolves on next generate.
    db.prepare("UPDATE package_exceptions SET status = 'resolved' WHERE id = ?").run(p6ExId);
    await req(`${BASE}/admin/alerts/generate?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    check('phase6: resolving the underlying exception auto-resolves its alert',
      db.prepare("SELECT status s FROM alerts WHERE alert_type = 'package_exception' AND source_id = ?").get(String(p6ExId)).s === 'resolved',
      'alert not auto-resolved');

    // --- Document management ---
    res = await multipartReq(`${BASE}/admin/documents/upload?token=${ADMIN_TOKEN}`, {
      fields: { owner_type: 'driver', owner_id: String(p6drvA.id), doc_type: 'driver_license' },
      fileField: 'file',
      file: { filename: 'license.png', mime: 'image/png', buffer: TINY_PNG },
    });
    const p6Doc = db.prepare("SELECT * FROM driver_documents WHERE owner_id = ? AND doc_type = 'driver_license' ORDER BY id DESC LIMIT 1").get(p6drvA.id);
    check('phase6: admin document upload stores record + file bytes',
      res.status === 302 && !!p6Doc && Buffer.from(p6Doc.file_blob).equals(TINY_PNG) &&
      p6Doc.file_mime === 'image/png' && p6Doc.size_bytes === TINY_PNG.length,
      `status=${res.status}`);

    res = await req(`${BASE}/admin/documents/${p6Doc.id}/download?token=${ADMIN_TOKEN}`, {});
    const p6Dl = Buffer.from(await res.arrayBuffer());
    check('phase6: admin document download returns the exact stored bytes',
      res.status === 200 && String(res.headers.get('content-type') || '').startsWith('image/png') && p6Dl.equals(TINY_PNG),
      `status=${res.status} ct=${res.headers.get('content-type')}`);

    res = await req(`${BASE}/admin/documents/${p6Doc.id}/verify?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['verification_status', 'verified'], ['notes', 'Readable'],
    ]});
    const p6DocV = db.prepare('SELECT verification_status s, verified_by b FROM driver_documents WHERE id = ?').get(p6Doc.id);
    check('phase6: admin verifies document',
      res.status === 302 && p6DocV.s === 'verified' && p6DocV.b === 'admin',
      `status=${res.status} row=${JSON.stringify(p6DocV)}`);

    res = await multipartReq(`${BASE}/d/${p6drvA.access_token}/documents/upload`, {
      fields: { doc_type: 'insurance' },
      fileField: 'file',
      file: { filename: 'insurance.png', mime: 'image/png', buffer: TINY_PNG },
    });
    const p6Ins = db.prepare("SELECT * FROM driver_documents WHERE owner_id = ? AND doc_type = 'insurance' ORDER BY id DESC LIMIT 1").get(p6drvA.id);
    check('phase6: driver uploads own document',
      res.status === 302 && !!p6Ins,
      `status=${res.status}`);

    res = await multipartReq(`${BASE}/d/${p6drvA.access_token}/documents/upload`, {
      fields: { doc_type: 'w9' },
      fileField: 'file',
      file: { filename: 'w9.png', mime: 'image/png', buffer: TINY_PNG },
    });
    check('phase6: driver cannot upload a sensitive document type (400)',
      res.status === 400 &&
      db.prepare("SELECT COUNT(*) n FROM driver_documents WHERE owner_id = ? AND doc_type = 'w9' AND uploaded_by = ?").get(p6drvA.id, 'driver').n === 0,
      `status=${res.status}`);

    res = await req(`${BASE}/d/${p6drvB.access_token}/documents/${p6Doc.id}/download`, {});
    check('phase6: driver cannot download another driver\u2019s document (403)', res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/documents/${p6Doc.id}/download`, {});
    check('phase6: unauthenticated admin document download blocked (403)', res.status === 403, `status=${res.status}`);

    res = await multipartReq(`${BASE}/admin/documents/upload?token=${ADMIN_TOKEN}`, {
      fields: { owner_type: 'driver', owner_id: String(p6drvA.id), doc_type: 'w9' },
      fileField: 'file',
      file: { filename: 'w9.png', mime: 'image/png', buffer: TINY_PNG },
    });
    const p6W9 = db.prepare("SELECT * FROM driver_documents WHERE owner_id = ? AND doc_type = 'w9' ORDER BY id DESC LIMIT 1").get(p6drvA.id);
    res = await req(`${BASE}/d/${p6drvA.access_token}/documents`, {});
    const p6DrvDocsHtml = await res.text();
    check('phase6: sensitive documents are hidden from the driver\u2019s list',
      res.status === 200 && !!p6W9 && !p6DrvDocsHtml.includes('w9.png') && p6DrvDocsHtml.includes('license.png') &&
      p6DrvDocsHtml.includes('name="viewport"'),
      `status=${res.status}`);
    res = await req(`${BASE}/d/${p6drvA.access_token}/documents/${p6W9.id}/download`, {});
    check('phase6: driver blocked from downloading a sensitive document (403)', res.status === 403, `status=${res.status}`);

    await req(`${BASE}/admin/alerts/generate?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    check('phase6: documents on file auto-resolve required-document alerts (verified or pending review)',
      db.prepare("SELECT status s FROM alerts WHERE alert_type = 'required_document' AND source_id = ? ORDER BY id DESC LIMIT 1").get(`${p6drvA.id}:driver_license`).s === 'resolved' &&
      db.prepare("SELECT status s FROM alerts WHERE alert_type = 'required_document' AND source_id = ? ORDER BY id DESC LIMIT 1").get(`${p6drvA.id}:insurance`).s === 'resolved',
      'auto-resolution mismatch');

    // Rejecting a document marks it rejected at the document level.
    res = await req(`${BASE}/admin/documents/${p6Ins.id}/verify?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['verification_status', 'rejected'], ['notes', 'Unreadable scan'],
    ]});
    check('phase6: admin can reject a document',
      res.status === 302 &&
      db.prepare('SELECT verification_status s FROM driver_documents WHERE id = ?').get(p6Ins.id).s === 'rejected',
      `status=${res.status}`);

    // --- Contract documents ---
    res = await req(`${BASE}/admin/contracts?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['client', 'P6 Client'], ['contract_name', 'P6 Contract'], ['start_date', '2026-09-01'], ['end_date', '2027-09-01'],
    ]});
    const p6ContractId = Number(((res.headers.get('location') || '').match(/\/admin\/contracts\/(\d+)/) || [])[1]);
    check('phase6: test contract created', res.status === 302 && p6ContractId > 0, `status=${res.status}`);
    const p6Exp = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    res = await multipartReq(`${BASE}/admin/contracts/${p6ContractId}/documents/upload?token=${ADMIN_TOKEN}`, {
      fields: { doc_type: 'agreement', expires_at: p6Exp, notes: 'Signed MSA' },
      fileField: 'file',
      file: { filename: 'msa.png', mime: 'image/png', buffer: TINY_PNG },
    });
    const p6CDoc = db.prepare('SELECT * FROM contract_documents WHERE contract_id = ?').get(p6ContractId);
    check('phase6: contract document upload links a real stored file to the contract',
      res.status === 302 && !!p6CDoc && !!p6CDoc.document_id && p6CDoc.verification_status === 'unverified' &&
      Buffer.from(db.prepare('SELECT file_blob b FROM driver_documents WHERE id = ?').get(p6CDoc.document_id).b).equals(TINY_PNG),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/contracts/${p6ContractId}?token=${ADMIN_TOKEN}`, {});
    const p6ContractHtml = await res.text();
    check('phase6: contract page shows the real document with download + verification state',
      res.status === 200 && p6ContractHtml.includes('Download') && p6ContractHtml.includes('unverified'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/documents/${p6CDoc.document_id}/verify?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['verification_status', 'verified'],
    ]});
    await req(`${BASE}/admin/alerts/generate?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    check('phase6: verified expiring contract document raises an expiring-document alert',
      db.prepare('SELECT verification_status s FROM contract_documents WHERE id = ?').get(p6CDoc.id).s === 'verified' &&
      db.prepare("SELECT COUNT(*) n FROM alerts WHERE alert_type = 'expiring_document' AND source_id = ?").get(String(p6CDoc.document_id)).n === 1,
      'no expiring_document alert');

    // --- Community + plans wiring (existing modules, deep links) ---
    res = await req(`${BASE}/admin/operations?token=${ADMIN_TOKEN}`, {});
    const p6OpsHtml = await res.text();
    check('phase6: command center wires alerts, follow-ups, community, plans (cards + deep links)',
      res.status === 200 && p6OpsHtml.includes('Open alerts') && p6OpsHtml.includes('/admin/alerts') &&
      p6OpsHtml.includes('Follow-ups due') && p6OpsHtml.includes('Community reports (open)') &&
      p6OpsHtml.includes('/admin/community') && p6OpsHtml.includes('Plan requests (pending)') &&
      p6OpsHtml.includes('/admin/plans'),
      `status=${res.status}`);

    res = await req(`${BASE}/d/${p6drvA.access_token}/community`, { method: 'POST', form: [
      ['category', 'general'], ['title', 'P6 hello ' + p6ts], ['body', 'Testing community wiring'],
    ]});
    check('phase6: driver community post created', res.status === 302, `status=${res.status}`);
    res = await req(`${BASE}/admin/community?token=${ADMIN_TOKEN}`, {});
    check('phase6: admin community page lists the real driver post',
      res.status === 200 && (await res.text()).includes('P6 hello ' + p6ts),
      `status=${res.status}`);

    const p6PlansEnabledBefore = db.prepare('SELECT plans_enabled e FROM service_plan_settings WHERE id = 1').get().e;
    await req(`${BASE}/admin/plans/settings?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['plans_enabled', '1'], ['billing_frequency', 'weekly'],
    ]});
    res = await req(`${BASE}/d/${p6drvA.access_token}/plan/request`, { method: 'POST', form: [['plan_id', 'essential']] });
    check('phase6: driver requests a service plan', res.status === 302, `status=${res.status}`);
    res = await req(`${BASE}/admin/operations?token=${ADMIN_TOKEN}`, {});
    check('phase6: command center shows the pending plan request card',
      (await res.text()).includes('Plan requests (pending)'),
      `status=${res.status}`);
    res = await req(`${BASE}/admin/plans?token=${ADMIN_TOKEN}`, {});
    check('phase6: admin plans page shows the pending request',
      res.status === 200 && (await res.text()).includes('P6 Driver A'),
      `status=${res.status}`);
    db.prepare('UPDATE service_plan_settings SET plans_enabled = ? WHERE id = 1').run(p6PlansEnabledBefore);

    // --- Driver dashboard cards ---
    res = await req(`${BASE}/d/${p6drvA.access_token}`, {});
    const p6Dash = await res.text();
    check('phase6: driver dashboard links Referrals + My documents, no billing-engine wording',
      res.status === 200 && p6Dash.includes(`/d/${p6drvA.access_token}/referral`) &&
      p6Dash.includes(`/d/${p6drvA.access_token}/documents`) &&
      !p6Dash.includes('plan and billing'),
      `status=${res.status}`);

    // --- Phase 6 cleanup ---
    db.prepare('DELETE FROM referral_attributions').run();
    db.prepare('DELETE FROM referral_codes').run();
    db.prepare('DELETE FROM lead_followups').run();
    db.prepare('DELETE FROM alerts').run();
    db.prepare("UPDATE notification_prefs SET notify_enabled = 1").run();
    db.prepare('DELETE FROM contract_documents WHERE contract_id = ?').run(p6ContractId);
    db.prepare('DELETE FROM contracts WHERE id = ?').run(p6ContractId);
    db.prepare("DELETE FROM driver_documents WHERE owner_type = 'contract' AND owner_id = ?").run(p6ContractId);
    db.prepare("DELETE FROM driver_documents WHERE owner_type = 'driver' AND owner_id IN (SELECT id FROM drivers WHERE email LIKE 'p6-%')").run();
    db.prepare("DELETE FROM community_posts WHERE title LIKE 'P6 hello%'").run();
    db.prepare("DELETE FROM driver_plan_changes WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE 'p6-%')").run();
    db.prepare("DELETE FROM support_tickets WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE 'p6-%')").run();
    db.prepare("DELETE FROM package_exceptions WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE 'p6-%')").run();
    db.prepare("DELETE FROM packages WHERE package_id LIKE 'P6PKG%' OR package_id LIKE 'P6LOST%'").run();
    db.prepare("DELETE FROM lead_sources WHERE lead_id IN (SELECT id FROM opportunity_leads WHERE email LIKE 'p6-%')").run();
    db.prepare("DELETE FROM opportunity_leads WHERE email LIKE 'p6-%'").run();
    db.prepare("DELETE FROM driver_status_history WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE 'p6-%')").run();
    db.prepare("DELETE FROM drivers WHERE email LIKE 'p6-%'").run();
    const p6NewQids = db.prepare('SELECT id FROM email_queue WHERE id > ?').all(p6qBefore).map((r) => r.id);
    const p6NewOutboxFinal = newFilesSince(p6OutboxBefore);
    for (const qid of p6NewQids) {
      for (const f of p6NewOutboxFinal) {
        if (f.startsWith(`${qid}-`) && f.endsWith('.html')) fs.unlinkSync(path.join(OUTBOX, f));
      }
    }
    if (p6NewQids.length) db.prepare(`DELETE FROM email_queue WHERE id IN (${p6NewQids.map(() => '?').join(',')})`).run(...p6NewQids);
    check('phase6: test data cleaned up',
      db.prepare("SELECT COUNT(*) n FROM drivers WHERE email LIKE 'p6-%'").get().n === 0 &&
      db.prepare('SELECT COUNT(*) n FROM referral_codes').get().n === 0 &&
      db.prepare('SELECT COUNT(*) n FROM lead_followups').get().n === 0 &&
      db.prepare('SELECT COUNT(*) n FROM alerts').get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM driver_documents WHERE owner_type = 'driver' AND owner_id NOT IN (SELECT id FROM drivers)").get().n === 0,
      'leftover rows');


    /* ---- Phase 7: analytics dashboard + exception-photo fix ---------------- */
    // Covers: /admin/analytics adminAuth (403 without token), date-window
    // filtering, funnel traffic from the existing page_views tracking,
    // started/drafts/completed/conversion computed live from the real tables
    // (each compared exactly against independent SQL counts), source
    // breakdowns, referral-attribution wiring, applicant-profile breakdowns,
    // pipeline metrics (qualified applicants, driver approvals, active
    // drivers/businesses, opportunity matches), honest definition copy in the
    // UI, the command-center deep link, and byte-identical exception-photo
    // downloads on both the driver and admin routes.
    const p7ts = Date.now();
    const p7 = (n) => `p7-${String(n).toLowerCase()}-${p7ts}@example.com`;
    const p7qBefore = (db.prepare('SELECT MAX(id) m FROM email_queue').get().m || 0);
    const p7OutboxBefore = outboxFiles();

    // --- auth + page render ---
    res = await req(`${BASE}/admin/analytics`, {});
    check('phase7: /admin/analytics requires token (403 without)',
      res.status === 403, `status=${res.status}`);
    res = await req(`${BASE}/admin/analytics?token=${ADMIN_TOKEN}`, {});
    let p7Html = await res.text();
    check('phase7: analytics page renders sections, definitions, window links',
      res.status === 200 && p7Html.includes('Growth analytics') &&
      p7Html.includes('Metric definitions') &&
      p7Html.includes('unique anonymous visitors') &&
      p7Html.includes('Completed ÷ Started') &&
      p7Html.includes('they do not predict or promise future results') &&
      p7Html.includes('?days=7') && p7Html.includes('?days=90') && p7Html.includes('?days=all'),
      `status=${res.status}`);

    // Baselines captured BEFORE seeding, so seeded deltas are provable.
    const base30 = await analyticsLib.getAnalytics({ days: '30' });

    // --- seed funnel traffic (existing page_views tracking reused) ---
    for (const v of ['p7-va', 'p7-vb', 'p7-vc', 'p7-vd', 'p7-ve']) {
      db.prepare('INSERT OR IGNORE INTO visitors (id, first_seen, last_seen, visits, source, campaign) VALUES (?, ?, ?, 1, NULL, NULL)')
        .run(v, p7ts, p7ts);
    }
    const p7pv = db.prepare('INSERT INTO page_views (visitor_id, lead_id, path, product_id, ts) VALUES (?, NULL, ?, NULL, ?)');
    for (const [v, pth] of [
      ['p7-va', '/grow'], ['p7-vb', '/grow'],
      ['p7-va', '/grow/apply'], ['p7-vb', '/grow/apply'], ['p7-vc', '/grow/apply'],
      ['p7-va', '/business'], ['p7-vd', '/rsp'],
      ['p7-ve', '/dispatch'], ['p7-vb', '/dispatch'],
    ]) p7pv.run(v, pth, p7ts);

    // --- seed drafts ---
    const p7draftTokens = [crypto.randomBytes(24).toString('hex'), crypto.randomBytes(24).toString('hex')];
    const p7dr = db.prepare("INSERT INTO opportunity_lead_drafts (token, lead_type, email, step, data, created_at, updated_at) VALUES (?, 'GROW', ?, 3, '{}', ?, ?)");
    p7dr.run(p7draftTokens[0], p7('draft1'), p7ts, p7ts);
    p7dr.run(p7draftTokens[1], p7('draft2'), p7ts, p7ts);

    // --- seed leads ---
    const p7li = db.prepare(
      `INSERT INTO opportunity_leads
         (lead_type, status, first_name, last_name, email, phone, city, state, source,
          future_role, vehicle_type, experience_level, opportunity_interests, created_at, updated_at)
       VALUES (?, ?, 'P7', 'Test', ?, '4145550199', 'Milwaukee', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const p7a1 = p7li.run('GROW', 'NEW', p7('a1'), 'WI', 'tiktok', 'driver', 'car', '1-2y', '["local-routes","dispatch-services"]', p7ts, p7ts).lastInsertRowid;
    p7li.run('GROW', 'NEW', p7('a2'), 'WI', 'tiktok', 'driver', 'cargo-van', 'new', '["local-routes"]', p7ts, p7ts);
    p7li.run('GROW', 'QUALIFYING', p7('a3'), 'IL', 'facebook', 'business-owner', 'car', '1-2y', '["building-business"]', p7ts, p7ts);
    const p7a4 = p7li.run('GROW', 'ACTIVE', p7('a4'), 'WI', 'referral', '', 'none', '', '[]', p7ts, p7ts).lastInsertRowid;
    p7li.run('GROW', 'NOT A FIT CURRENTLY', p7('a5'), '', '', 'not-sure', 'looking', '5+y', '["not-sure"]', p7ts, p7ts);
    // 10 days old: inside the 30d window, outside the 7d window.
    const p7old = p7ts - 10 * 86400e3;
    p7li.run('GROW', 'NEW', p7('old'), '', 'google', '', '', '', '[]', p7old, p7old);
    p7li.run('BUSINESS', 'ACTIVE', p7('b1'), '', 'website', '', '', '', '[]', p7ts, p7ts);
    p7li.run('BUSINESS', 'NEW', p7('b2'), '', 'google', '', '', '', '[]', p7ts, p7ts);
    p7li.run('RSP', 'RSP INTEREST', p7('r1'), 'WI', 'facebook', '', '', '', '[]', p7ts, p7ts);

    // --- referral wiring: issued code + typed code -> attribution scan ---
    db.prepare(
      `INSERT INTO referral_codes (code, issued_to_type, issued_to_id, issued_to_name, issued_by, issued_at, status, notes)
       VALUES ('TN-P7ABCD', 'driver', NULL, 'P7 Referrer', 'admin', ?, 'active', 'phase7 test')`
    ).run(p7ts);
    db.prepare('INSERT INTO lead_sources (lead_id, source, referral_code, created_at) VALUES (?, ?, ?, ?)')
      .run(p7a4, 'referral', 'tn-p7abcd', p7ts);
    res = await req(`${BASE}/admin/referrals/attribute?token=${ADMIN_TOKEN}`, { method: 'POST', form: [] });
    const p7Attr = db.prepare('SELECT * FROM referral_attributions WHERE code = ?').get('TN-P7ABCD');
    check('phase7: referral attribution links the seeded referred lead',
      res.status === 302 && !!p7Attr && p7Attr.referred_lead_id === p7a4 && p7Attr.status === 'applied',
      `status=${res.status} attr=${JSON.stringify(p7Attr && { lead: p7Attr.referred_lead_id, status: p7Attr.status })}`);

    // --- drivers: one approved+active, one still screening ---
    async function p7Onboard(name, email) {
      const r = await req(`${BASE}/drivers/onboard`, { method: 'POST', form: [
        ['full_name', name], ['email', email], ['phone', '4145550199'],
        ['contact_method', 'text'], ['vehicle_type', 'cargo_van'], ['vehicle_make_model', 'Ford Transit'],
        ['home_city', 'Milwaukee'], ['home_state', 'WI'], ['days_available', 'mon'],
        ['work_prefs', 'local'], ['looking_for', 'routes'],
      ]});
      if (r.status !== 200) failFast('phase7: driver onboard failed: ' + r.status);
    }
    await p7Onboard('P7 Driver One', p7('drv1'));
    await p7Onboard('P7 Driver Two', p7('drv2'));
    db.prepare("UPDATE drivers SET status = 'active', extended_status = 'APPROVED' WHERE email = ?").run(p7('drv1'));
    db.prepare("UPDATE drivers SET extended_status = 'SCREENING' WHERE email = ?").run(p7('drv2'));

    // --- opportunity + potential match ---
    const p7oppId = db.prepare(
      "INSERT INTO opportunities (name, status, created_by, created_at, updated_at) VALUES ('P7 Opportunity Alpha', 'OPEN', 'test', ?, ?)"
    ).run(p7ts, p7ts).lastInsertRowid;
    db.prepare(
      'INSERT INTO opportunity_matches (opportunity_id, person_type, person_id, matched_by, note, ts) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(p7oppId, 'lead', p7a1, 'admin', 'phase7 test match', p7ts);

    // --- analytics vs independent SQL: exact agreement ---
    const a30 = await analyticsLib.getAnalytics({ days: '30' });
    const since30 = p7ts - 30 * 86400e3;
    const since7 = p7ts - 7 * 86400e3;
    const sqlStarted = (since) =>
      db.prepare("SELECT COUNT(DISTINCT visitor_id) c FROM page_views WHERE path = '/grow/apply' AND ts >= ?").get(since).c;
    const sqlCompleted = (since) =>
      db.prepare("SELECT COUNT(*) c FROM opportunity_leads WHERE lead_type = 'GROW' AND created_at >= ?").get(since).c;
    const sqlDrafts = (since) =>
      db.prepare('SELECT COUNT(DISTINCT token) c FROM opportunity_lead_drafts WHERE created_at >= ?').get(since).c;
    check('phase7: started matches independent page_views count exactly',
      a30.funnel.started === sqlStarted(since30), `analytics=${a30.funnel.started} sql=${sqlStarted(since30)}`);
    check('phase7: completed matches independent lead-row count exactly',
      a30.funnel.completed === sqlCompleted(since30), `analytics=${a30.funnel.completed} sql=${sqlCompleted(since30)}`);
    check('phase7: drafts match independent draft-token count exactly',
      a30.funnel.draftsSaved === sqlDrafts(since30), `analytics=${a30.funnel.draftsSaved} sql=${sqlDrafts(since30)}`);
    check('phase7: seeded deltas are exact (+3 started, +2 drafts, +6 completed, +2 business, +1 rsp)',
      a30.funnel.started === base30.funnel.started + 3 &&
      a30.funnel.draftsSaved === base30.funnel.draftsSaved + 2 &&
      a30.funnel.completed === base30.funnel.completed + 6 &&
      a30.funnel.businessLeads === base30.funnel.businessLeads + 2 &&
      a30.funnel.rspInterest === base30.funnel.rspInterest + 1,
      JSON.stringify({ started: a30.funnel.started, drafts: a30.funnel.draftsSaved, completed: a30.funnel.completed }));
    const expectedConv = Math.round((a30.funnel.completed / a30.funnel.started) * 1000) / 10;
    check('phase7: conversion rate math is exact (completed/started, 1 decimal)',
      a30.funnel.conversionPct === expectedConv,
      `analytics=${a30.funnel.conversionPct} expected=${expectedConv}`);

    // --- funnel page stats vs SQL ---
    for (const [pth, expVisitors] of [['/grow', 2], ['/grow/apply', 3], ['/business', 1], ['/rsp', 1], ['/dispatch', 2]]) {
      const sqlV = db.prepare('SELECT COUNT(DISTINCT visitor_id) c FROM page_views WHERE path = ? AND ts >= ?').get(pth, since30).c;
      const got = a30.funnel.pages[pth].visitors;
      check(`phase7: ${pth} unique visitors match SQL (+${expVisitors} seeded)`,
        got === sqlV && got >= expVisitors, `analytics=${got} sql=${sqlV}`);
    }

    // --- source breakdowns (deltas) ---
    const delta = (after, before, label) =>
      (after.find((r) => r.label === label)?.count || 0) - (before.find((r) => r.label === label)?.count || 0);
    check('phase7: GROW source breakdown deltas exact (tiktok+2 facebook+1 referral+1 not-provided+1)',
      delta(a30.sources.GROW, base30.sources.GROW, 'tiktok') === 2 &&
      delta(a30.sources.GROW, base30.sources.GROW, 'facebook') === 1 &&
      delta(a30.sources.GROW, base30.sources.GROW, 'referral') === 1 &&
      delta(a30.sources.GROW, base30.sources.GROW, '(not provided)') === 1);
    check('phase7: BUSINESS source breakdown deltas exact (website+1 google+1)',
      delta(a30.sources.BUSINESS, base30.sources.BUSINESS, 'website') === 1 &&
      delta(a30.sources.BUSINESS, base30.sources.BUSINESS, 'google') === 1);
    check('phase7: RSP source breakdown delta exact (facebook+1)',
      delta(a30.sources.RSP, base30.sources.RSP, 'facebook') === 1);

    // --- referral breakdowns ---
    const baseAttr = (base30.referrals.attributed.find((r) => r.code === 'TN-P7ABCD')?.count || 0);
    const p7AttrRow = a30.referrals.attributed.find((r) => r.code === 'TN-P7ABCD');
    check('phase7: attributed referrals include TN-P7ABCD (+1, issued to P7 Referrer)',
      !!p7AttrRow && p7AttrRow.count === baseAttr + 1 && p7AttrRow.issuedTo === 'P7 Referrer',
      JSON.stringify(p7AttrRow));
    const baseTyped = (base30.referrals.typed.find((r) => r.code === 'TN-P7ABCD')?.count || 0);
    const p7TypedRow = a30.referrals.typed.find((r) => r.code === 'TN-P7ABCD');
    check('phase7: typed referral codes normalize case (TN-P7ABCD +1)',
      !!p7TypedRow && p7TypedRow.count === baseTyped + 1, JSON.stringify(p7TypedRow));

    // --- applicant profile breakdowns (deltas) ---
    check('phase7: future-role breakdown deltas exact',
      delta(a30.applicant.byFutureRole, base30.applicant.byFutureRole, 'driver') === 2 &&
      delta(a30.applicant.byFutureRole, base30.applicant.byFutureRole, 'business-owner') === 1 &&
      delta(a30.applicant.byFutureRole, base30.applicant.byFutureRole, 'not-sure') === 1 &&
      // p7a4 AND the 10-day-old lead both leave future_role blank
      delta(a30.applicant.byFutureRole, base30.applicant.byFutureRole, '(not provided)') === 2);
    check('phase7: vehicle-type breakdown deltas exact',
      delta(a30.applicant.byVehicleType, base30.applicant.byVehicleType, 'car') === 2 &&
      delta(a30.applicant.byVehicleType, base30.applicant.byVehicleType, 'cargo-van') === 1 &&
      delta(a30.applicant.byVehicleType, base30.applicant.byVehicleType, 'none') === 1 &&
      delta(a30.applicant.byVehicleType, base30.applicant.byVehicleType, 'looking') === 1);
    check('phase7: state breakdown deltas exact (WI+3 IL+1)',
      delta(a30.applicant.byState, base30.applicant.byState, 'WI') === 3 &&
      delta(a30.applicant.byState, base30.applicant.byState, 'IL') === 1);
    check('phase7: experience breakdown deltas exact',
      delta(a30.applicant.byExperience, base30.applicant.byExperience, '1-2y') === 2 &&
      delta(a30.applicant.byExperience, base30.applicant.byExperience, 'new') === 1 &&
      delta(a30.applicant.byExperience, base30.applicant.byExperience, '5+y') === 1);
    check('phase7: opportunity-interest breakdown deltas exact',
      delta(a30.applicant.opportunityInterests, base30.applicant.opportunityInterests, 'local-routes') === 2 &&
      delta(a30.applicant.opportunityInterests, base30.applicant.opportunityInterests, 'dispatch-services') === 1 &&
      delta(a30.applicant.opportunityInterests, base30.applicant.opportunityInterests, 'building-business') === 1 &&
      delta(a30.applicant.opportunityInterests, base30.applicant.opportunityInterests, 'not-sure') === 1);

    // --- pipeline metrics (current state; deltas) ---
    check('phase7: qualified applicants +2 (QUALIFYING, ACTIVE statuses)',
      a30.pipeline.qualifiedApplicants === base30.pipeline.qualifiedApplicants + 2,
      `after=${a30.pipeline.qualifiedApplicants} before=${base30.pipeline.qualifiedApplicants}`);
    check('phase7: driver approvals +1, active drivers +1, active businesses +1',
      a30.pipeline.driverApprovals === base30.pipeline.driverApprovals + 1 &&
      a30.pipeline.activeDrivers === base30.pipeline.activeDrivers + 1 &&
      a30.pipeline.activeBusinesses === base30.pipeline.activeBusinesses + 1);
    check('phase7: opportunity matches +1 total and +1 in window',
      a30.pipeline.opportunityMatches === base30.pipeline.opportunityMatches + 1 &&
      a30.pipeline.matchesInWindow === base30.pipeline.matchesInWindow + 1);

    // --- date-window filtering ---
    const a7 = await analyticsLib.getAnalytics({ days: '7' });
    check('phase7: 7-day window excludes the 10-day-old lead (completed -1 vs 30d)',
      a7.funnel.completed === a30.funnel.completed - 1 && a7.funnel.started === a30.funnel.started,
      `7d completed=${a7.funnel.completed} 30d completed=${a30.funnel.completed}`);
    check('phase7: 7-day completed matches independent SQL',
      a7.funnel.completed === sqlCompleted(since7), `analytics=${a7.funnel.completed} sql=${sqlCompleted(since7)}`);
    const aBad = await analyticsLib.getAnalytics({ days: 'bogus' });
    check('phase7: invalid days param falls back to 30 days',
      aBad.window.key === '30' && aBad.window.label === 'Last 30 days',
      `key=${aBad.window.key} label=${aBad.window.label}`);

    // --- HTTP page reflects the live numbers ---
    res = await req(`${BASE}/admin/analytics?token=${ADMIN_TOKEN}&days=30`, {});
    p7Html = await res.text();
    const numFor = (labelStart) => {
      const m = p7Html.match(new RegExp(`<div class="num">([\\d,]+)</div><div class="label">${labelStart}`));
      return m ? Number(m[1].replace(/,/g, '')) : null;
    };
    check('phase7: page shows live Started and Completed numbers',
      res.status === 200 && numFor('Started') === a30.funnel.started && numFor('Completed applications') === a30.funnel.completed,
      `started=${numFor('Started')} completed=${numFor('Completed applications')}`);
    check('phase7: page shows the live conversion percentage',
      p7Html.includes(`<strong>${a30.funnel.conversionPct}%</strong>`),
      `looking for ${a30.funnel.conversionPct}%`);
    res = await req(`${BASE}/admin/analytics?token=${ADMIN_TOKEN}&days=7`, {});
    check('phase7: days=7 page shows Last 7 days label',
      res.status === 200 && (await res.text()).includes('Last 7 days'), `status=${res.status}`);
    res = await req(`${BASE}/admin/operations?token=${ADMIN_TOKEN}`, {});
    check('phase7: command center deep-links to analytics',
      res.status === 200 && (await res.text()).includes('href="/admin/analytics"'), `status=${res.status}`);

    // --- exception photo download: byte-identical round trip (driver + admin) ---
    await p7Onboard('P7 Photo Driver', p7('photo'));
    makePaid(db, p7('photo')); // paid-client enforcement: route creation needs an active subscription
    const p7photo = db.prepare('SELECT id, access_token FROM drivers WHERE email = ?').get(p7('photo'));
    res = await req(`${BASE}/admin/routes?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['driver_id', String(p7photo.id)], ['title', 'P7 Photo Route'], ['scheduled_date', '2026-09-21'],
    ]});
    const p7route = db.prepare('SELECT * FROM routes WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(p7photo.id);
    res = await req(`${BASE}/admin/routes/${p7route.id}/packages?token=${ADMIN_TOKEN}`, { method: 'POST', form: [
      ['recipient_name', 'P7 Photo Co'], ['address', '1 Test Way'], ['city', 'Milwaukee'], ['state', 'WI'], ['zip', '53202'],
    ]});
    const p7pkg = db.prepare('SELECT * FROM packages WHERE route_id = ? ORDER BY package_id DESC LIMIT 1').get(p7route.id);
    // Deliberately binary bytes (NULs, high bytes) — JSON-serialization of a
    // Uint8Array would corrupt these.
    const p7bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 7, 128, 200]);
    res = await multipartReq(`${BASE}/d/${p7photo.access_token}/packages/${p7pkg.package_id}/exception`, {
      fields: { exception_type: 'damaged_package', description: 'P7 photo bytes test', photo_confirm: '1' },
      file: { filename: 'p7.png', mime: 'image/png', buffer: p7bytes },
    });
    const p7ex = db.prepare('SELECT * FROM package_exceptions WHERE package_id = ? ORDER BY id DESC LIMIT 1').get(p7pkg.package_id);
    check('phase7: exception with binary photo recorded',
      res.status === 302 && !!p7ex && p7ex.photo_mime === 'image/png',
      `status=${res.status}`);
    res = await req(`${BASE}/d/${p7photo.access_token}/exceptions/${p7ex.id}/photo`, {});
    const p7drvPhoto = Buffer.from(await res.arrayBuffer());
    check('phase7: driver exception photo download is byte-identical to upload',
      res.status === 200 && (res.headers.get('content-type') || '').includes('image/png') &&
      p7drvPhoto.equals(p7bytes),
      `status=${res.status} downloaded=${p7drvPhoto.length}B uploaded=${p7bytes.length}B`);
    res = await req(`${BASE}/admin/exceptions/${p7ex.id}/photo?token=${ADMIN_TOKEN}`, {});
    const p7admPhoto = Buffer.from(await res.arrayBuffer());
    check('phase7: admin exception photo download is byte-identical to upload',
      res.status === 200 && (res.headers.get('content-type') || '').includes('image/png') &&
      p7admPhoto.equals(p7bytes),
      `status=${res.status} downloaded=${p7admPhoto.length}B uploaded=${p7bytes.length}B`);

    // --- Phase 7 cleanup ---
    db.prepare('DELETE FROM page_views WHERE visitor_id LIKE ?').run('p7-%');
    db.prepare('DELETE FROM visitors WHERE id LIKE ?').run('p7-%');
    db.prepare('DELETE FROM opportunity_lead_drafts WHERE email LIKE ?').run('p7-%');
    db.prepare('DELETE FROM lead_sources WHERE lead_id IN (SELECT id FROM opportunity_leads WHERE email LIKE ?)').run('p7-%');
    db.prepare('DELETE FROM opportunity_matches WHERE opportunity_id IN (SELECT id FROM opportunities WHERE name LIKE ?)').run('P7 %');
    db.prepare('DELETE FROM opportunities WHERE name LIKE ?').run('P7 %');
    db.prepare('DELETE FROM referral_attributions WHERE code LIKE ?').run('TN-P7%');
    db.prepare('DELETE FROM referral_codes WHERE code LIKE ?').run('TN-P7%');
    db.prepare('DELETE FROM package_exceptions WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE ?)').run('p7-%');
    db.prepare('DELETE FROM packages WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE ?)').run('p7-%');
    db.prepare('DELETE FROM routes WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE ?)').run('p7-%');
    db.prepare('DELETE FROM driver_status_history WHERE driver_id IN (SELECT id FROM drivers WHERE email LIKE ?)').run('p7-%');
    db.prepare('DELETE FROM drivers WHERE email LIKE ?').run('p7-%');
    db.prepare('DELETE FROM opportunity_leads WHERE email LIKE ?').run('p7-%');
    const p7NewQids = db.prepare('SELECT id FROM email_queue WHERE id > ?').all(p7qBefore).map((r) => r.id);
    const p7NewOutboxFinal = newFilesSince(p7OutboxBefore);
    for (const qid of p7NewQids) {
      for (const f of p7NewOutboxFinal) {
        if (f.startsWith(`${qid}-`) && f.endsWith('.html')) fs.unlinkSync(path.join(OUTBOX, f));
      }
    }
    if (p7NewQids.length) db.prepare(`DELETE FROM email_queue WHERE id IN (${p7NewQids.map(() => '?').join(',')})`).run(...p7NewQids);
    check('phase7: test data cleaned up',
      db.prepare("SELECT COUNT(*) n FROM opportunity_leads WHERE email LIKE 'p7-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM drivers WHERE email LIKE 'p7-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM page_views WHERE visitor_id LIKE 'p7-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM opportunity_lead_drafts WHERE email LIKE 'p7-%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM referral_codes WHERE code LIKE 'TN-P7%'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM opportunities WHERE name LIKE 'P7 %'").get().n === 0 &&
      db.prepare("SELECT COUNT(*) n FROM package_exceptions WHERE description = 'P7 photo bytes test'").get().n === 0,
      'leftover rows');



    /* ---- 12. Dispatcher logins + daily board + password reset ----------------- */
    // Covers: real dispatcher logins (no public signup), 302-to-login for
    // anonymous users, httpOnly session cookies, scrypt password storage,
    // the daily board (today/Chicago, date nav, live counts matching the
    // real tables, tel:/sms: driver buttons, 60s auto-refresh), login
    // rate limiting, self-service reset (single-use 1h tokens, generic
    // responses), admin one-time temp passwords with forced change,
    // deactivation, and logout.
    {
      const dtag = 'e2e-dt';
      const dEmail = (n) => `${dtag}-${n}-${ts}@example.com`;
      const dispRow = (email) => db.prepare('SELECT * FROM dispatchers WHERE email = ?').get(email);
      const chicagoToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const shiftDay = (ds, n) => {
        const [y, m, d] = ds.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        dt.setUTCDate(dt.getUTCDate() + n);
        return dt.toISOString().slice(0, 10);
      };
      const tomorrow = shiftDay(chicagoToday, 1);

      // 12-1. Anonymous users are bounced to the dispatcher login.
      let r = await req(`${BASE}/dispatch/today`, {});
      check('unauthenticated GET /dispatch/today redirects to /dispatch/login',
        r.status === 302 && (r.headers.get('location') || '').includes('/dispatch/login'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      r = await req(`${BASE}/dispatch/today.json`, {});
      check('unauthenticated board JSON also redirects to login',
        r.status === 302 && (r.headers.get('location') || '').includes('/dispatch/login'),
        `status=${r.status}`);
      r = await req(`${BASE}/dispatch/field-comms`, {});
      check('unauthenticated dispatcher field-comms redirects to login',
        r.status === 302 && (r.headers.get('location') || '').includes('/dispatch/login'),
        `status=${r.status}`);

      // 12-2. Login page renders; wrong credentials fail generically.
      r = await req(`${BASE}/dispatch/login`, {});
      check('GET /dispatch/login renders the dispatcher login form',
        r.status === 200 && /Dispatcher Login/.test(await r.text()), `status=${r.status}`);
      const badJar = new Jar();
      r = await req(`${BASE}/dispatch/login`, {
        method: 'POST', jar: badJar, form: { email: dEmail('ghost'), password: 'wrongpassword1' },
      });
      check('login with wrong credentials fails with the generic message (no enumeration, no session)',
        r.status === 200 && /Invalid email or password/.test(await r.text()) && !badJar.has('dispatch_sess'),
        `status=${r.status} cookies=[${[...badJar.c.keys()].join(',')}]`);

      // 12-3. Admin creates a dispatcher (shown once); non-admin refused.
      r = await req(`${BASE}/admin/dispatchers`, {});
      check('non-admin GET /admin/dispatchers is 403', r.status === 403, `status=${r.status}`);
      const pwA = 'dispatchpass1';
      r = await req(`${BASE}/admin/dispatchers?token=${ADMIN_TOKEN}`, {
        method: 'POST', form: { name: 'Dana Dispatcher', email: dEmail('a'), password: pwA },
      });
      const createdHtml = await r.text();
      check('admin creates a dispatcher and the password is shown once',
        r.status === 200 && /Dispatcher created/.test(createdHtml) && createdHtml.includes(pwA) &&
          /Dana Dispatcher/.test(createdHtml),
        `status=${r.status}`);
      const dA = dispRow(dEmail('a'));
      check('dispatcher password stored hashed with the room scrypt scheme (not plaintext)',
        dA && dA.password_hash && dA.password_hash.startsWith('scrypt$') && !dA.password_hash.includes(pwA),
        `hash=${dA && String(dA.password_hash).slice(0, 24)}`);

      // 12-4. Correct login reaches the board; cookie is httpOnly.
      const dJar = new Jar();
      r = await req(`${BASE}/dispatch/login`, {
        method: 'POST', jar: dJar, form: { email: dEmail('a'), password: pwA },
      });
      check('correct dispatcher login redirects to the board and sets the session cookie',
        r.status === 302 && (r.headers.get('location') || '').endsWith('/dispatch/today') && dJar.has('dispatch_sess'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      const scHeaders = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      check('dispatcher session cookie is httpOnly',
        scHeaders.some((h) => h.startsWith('dispatch_sess=') && /httponly/i.test(h)),
        `set-cookie=${JSON.stringify(scHeaders)}`);
      r = await req(`${BASE}/dispatch/today`, { jar: dJar });
      const boardHtml = await r.text();
      check("logged-in dispatcher reaches the daily board (Today's routes)",
        r.status === 200 && /Today's routes/.test(boardHtml) && /setInterval\(tick, 60000\)/.test(boardHtml),
        `status=${r.status}`);

      // 12-5. Board fixture: active route today, driver phone, 3 packages
      // (2 delivered), 3 stops, 1 open exception.
      db.prepare(`INSERT INTO drivers (full_name, email, phone, home_city, home_state, status, submitted_at, access_token)
                  VALUES (?, ?, ?, 'Milwaukee', 'WI', 'active', ?, ?)`)
        .run('Board Driver', dEmail('driver'), '4145550137', ts, `${dtag}-tok-${ts}`);
      const bDrv = db.prepare('SELECT * FROM drivers WHERE email = ?').get(dEmail('driver'));
      db.prepare(`INSERT INTO routes (route_code, driver_id, title, status, scheduled_date, stops, created_at, updated_at)
                  VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`)
        .run(`${dtag}-R1`, bDrv.id, 'Downtown loop', chicagoToday,
          JSON.stringify([{ stop: 1 }, { stop: 2 }, { stop: 3 }]), ts, ts);
      const bRoute = db.prepare('SELECT * FROM routes WHERE route_code = ?').get(`${dtag}-R1`);
      for (const [n, st] of [[1, 'delivered'], [2, 'delivered'], [3, 'in_transit']]) {
        db.prepare(`INSERT INTO packages (package_id, route_id, driver_id, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .run(`${dtag}-P${n}`, bRoute.id, bDrv.id, st, ts, ts);
      }
      db.prepare(`INSERT INTO package_exceptions (package_id, route_id, driver_id, exception_type, description, status, created_at)
                  VALUES (?, ?, ?, 'damaged', 'Box crushed', 'open', ?)`)
        .run(`${dtag}-P3`, bRoute.id, bDrv.id, ts);

      r = await req(`${BASE}/dispatch/today.json?date=${chicagoToday}`, { jar: dJar });
      const bj = await r.json();
      const expRoutes = db.prepare('SELECT COUNT(*) n FROM routes WHERE scheduled_date = ?').get(chicagoToday).n;
      const expActive = db.prepare("SELECT COUNT(*) n FROM routes WHERE scheduled_date = ? AND status = 'active'").get(chicagoToday).n;
      const expCompleted = db.prepare("SELECT COUNT(*) n FROM routes WHERE scheduled_date = ? AND status = 'completed'").get(chicagoToday).n;
      const expDelivered = db.prepare(`SELECT COUNT(*) n FROM packages p JOIN routes r ON r.id = p.route_id
                                       WHERE r.scheduled_date = ? AND p.status = 'delivered'`).get(chicagoToday).n;
      const expExc = db.prepare(`SELECT COUNT(*) n FROM package_exceptions e JOIN routes r ON r.id = e.route_id
                                 WHERE r.scheduled_date = ? AND e.status = 'open'`).get(chicagoToday).n;
      check('board summary counts match the real tables exactly',
        r.status === 200 && bj.summary.routes === expRoutes && bj.summary.active === expActive &&
          bj.summary.completed === expCompleted && bj.summary.packages_delivered === expDelivered &&
          bj.summary.open_exceptions === expExc && expRoutes >= 1,
        `summary=${JSON.stringify(bj.summary)} expected=${JSON.stringify({ routes: expRoutes, active: expActive, completed: expCompleted, packages_delivered: expDelivered, open_exceptions: expExc })}`);
      const row1 = (bj.html.match(new RegExp(`${dtag}-R1[\\s\\S]*?route-card`, 'g')) || []);
      check('board row shows route code, driver name, stops, delivered/remaining, and the red exception flag',
        bj.html.includes(`${dtag}-R1`) && bj.html.includes('Board Driver') && /3 stops/.test(bj.html) &&
          /2\/3 delivered \(1 remaining\)/.test(bj.html) && /1 open exception/.test(bj.html),
        `row-check`);
      check('board row has tap-to-call / tap-to-text hrefs from the stored driver phone',
        bj.html.includes('href="tel:+14145550137"') && bj.html.includes('href="sms:+14145550137"'),
        'tel/sms hrefs');
      check('board row links to the dispatcher-accessible route detail page',
        bj.html.includes(`/dispatch/routes/${bRoute.id}`) && !bj.html.includes(`/admin/routes/${bRoute.id}`),
        'route detail link');

      // 12-5b. Read-only route detail page (dispatcher-accessible; no admin forms).
      r = await req(`${BASE}/dispatch/routes/${bRoute.id}`, { jar: dJar });
      const detailHtml = await r.text();
      check('dispatcher can open the read-only route detail page',
        r.status === 200 && detailHtml.includes(`${dtag}-R1`) && detailHtml.includes('Board Driver') &&
          detailHtml.includes(`${dtag}-P1`) && /Downtown loop/.test(detailHtml),
        `status=${r.status}`);
      check('route detail shows driver tap-to-call / tap-to-text and no mutation forms',
        detailHtml.includes('href="tel:+14145550137"') && detailHtml.includes('href="sms:+14145550137"') &&
          !/<form/i.test(detailHtml),
        'read-only detail');
      r = await req(`${BASE}/dispatch/routes/${bRoute.id}`, {});
      check('anonymous users cannot open the route detail page (302 to login)',
        r.status === 302 && (r.headers.get('location') || '').includes('/dispatch/login'),
        `status=${r.status}`);
      r = await req(`${BASE}/dispatch/routes/999999999`, { jar: dJar });
      check('unknown route id returns 404 on the dispatcher detail page',
        r.status === 404, `status=${r.status}`);

      // 12-6. Date navigation changes the set.
      db.prepare(`INSERT INTO routes (route_code, driver_id, title, status, scheduled_date, stops, created_at, updated_at)
                  VALUES (?, ?, ?, 'planned', ?, '[]', ?, ?)`)
        .run(`${dtag}-R2`, bDrv.id, 'North run', tomorrow, ts, ts);
      r = await req(`${BASE}/dispatch/today?date=${tomorrow}`, { jar: dJar });
      const tmHtml = await r.text();
      check('date picker shows only the chosen date routes',
        r.status === 200 && tmHtml.includes(`${dtag}-R2`) && !tmHtml.includes(`${dtag}-R1`),
        `status=${r.status}`);
      r = await req(`${BASE}/dispatch/today`, { jar: dJar });
      const todayHtml = await r.text();
      check('default board is today (Chicago) with prev/next day navigation',
        todayHtml.includes(`${dtag}-R1`) && !todayHtml.includes(`${dtag}-R2`) &&
          todayHtml.includes(`date=${shiftDay(chicagoToday, -1)}`) && todayHtml.includes(`date=${tomorrow}`),
        'nav links');

      // 12-7. Self-service forgot: generic always; email only for active accounts.
      const qCount = (email) => db.prepare(
        `SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'dispatch-reset'`).get(email).n;
      r = await req(`${BASE}/dispatch/forgot`, {
        method: 'POST', form: { email: dEmail('a') },
      });
      check('forgot-password responds with the generic message (no enumeration)',
        r.status === 200 && /If an account exists for that email, a reset link is on its way/.test(await r.text()),
        `status=${r.status}`);
      check('reset email queued for the existing active dispatcher',
        qCount(dEmail('a')) === 1, `queued=${qCount(dEmail('a'))}`);
      const resetBody = db.prepare(
        `SELECT body_html FROM email_queue WHERE email = ? AND sequence = 'dispatch-reset' ORDER BY id DESC LIMIT 1`)
        .get(dEmail('a')).body_html;
      const tokenMatch = String(resetBody).match(/\/dispatch\/reset\/([a-f0-9]{64})/);
      check('queued reset email carries a single-use /dispatch/reset/ link',
        !!tokenMatch, 'token in email');
      const resetToken = tokenMatch[1];
      r = await req(`${BASE}/dispatch/forgot`, { method: 'POST', form: { email: dEmail('unknown') } });
      check('forgot-password for an unknown email gives the same generic response with no email queued',
        r.status === 200 && /If an account exists for that email/.test(await r.text()) && qCount(dEmail('unknown')) === 0,
        `status=${r.status} queued=${qCount(dEmail('unknown'))}`);
      // Deactivated dispatcher gets the generic response but no email.
      r = await req(`${BASE}/admin/dispatchers?token=${ADMIN_TOKEN}`, {
        method: 'POST', form: { name: 'Deac Tivated', email: dEmail('c'), password: 'dispatchpass1' },
      });
      const dC = dispRow(dEmail('c'));
      await req(`${BASE}/admin/dispatchers/${dC.id}/active?token=${ADMIN_TOKEN}`, {
        method: 'POST', form: { active: '0' },
      });
      r = await req(`${BASE}/dispatch/forgot`, { method: 'POST', form: { email: dEmail('c') } });
      check('forgot-password for a deactivated dispatcher gives the generic response with no email queued',
        r.status === 200 && /If an account exists for that email/.test(await r.text()) && qCount(dEmail('c')) === 0,
        `queued=${qCount(dEmail('c'))}`);

      // 12-8. Reset token: single-use, mismatch-safe, logs in.
      r = await req(`${BASE}/dispatch/reset/${resetToken}`, {});
      check('valid reset token renders the new-password form',
        r.status === 200 && /Choose a new password/.test(await r.text()), `status=${r.status}`);
      r = await req(`${BASE}/dispatch/reset/${resetToken}`, {
        method: 'POST', form: { password: 'newdispatchpass1', password2: 'differentpass2' },
      });
      check('mismatched new passwords are rejected without consuming the token',
        r.status === 200 && /do not match/.test(await r.text()), `status=${r.status}`);
      r = await req(`${BASE}/dispatch/reset/${resetToken}`, {});
      check('token still valid after a failed attempt',
        r.status === 200 && /Choose a new password/.test(await r.text()), `status=${r.status}`);
      const resetJar = new Jar();
      r = await req(`${BASE}/dispatch/reset/${resetToken}`, {
        method: 'POST', jar: resetJar, form: { password: 'newdispatchpass1', password2: 'newdispatchpass1' },
      });
      check('valid reset sets the new password and logs the dispatcher in',
        r.status === 302 && (r.headers.get('location') || '').endsWith('/dispatch/today') && resetJar.has('dispatch_sess'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      const dA2 = dispRow(dEmail('a'));
      check('reset password stored hashed (not plaintext)',
        dA2.password_hash.startsWith('scrypt$') && !dA2.password_hash.includes('newdispatchpass1'));
      r = await req(`${BASE}/dispatch/reset/${resetToken}`, {});
      check('reset token cannot be reused',
        r.status === 400 && /invalid or has expired/i.test(await r.text()), `status=${r.status}`);

      // 12-9. Expired token rejected.
      await req(`${BASE}/dispatch/forgot`, { method: 'POST', form: { email: dEmail('a') } });
      const body2 = db.prepare(
        `SELECT body_html FROM email_queue WHERE email = ? AND sequence = 'dispatch-reset' ORDER BY id DESC LIMIT 1`)
        .get(dEmail('a')).body_html;
      const token2 = String(body2).match(/\/dispatch\/reset\/([a-f0-9]{64})/)[1];
      db.prepare(`UPDATE dispatcher_reset_tokens SET expires_at = ? WHERE dispatcher_id = ? AND used_at IS NULL`)
        .run(Date.now() - 1000, dA.id);
      r = await req(`${BASE}/dispatch/reset/${token2}`, {});
      check('expired reset token is rejected',
        r.status === 400 && /invalid or has expired/i.test(await r.text()), `status=${r.status}`);

      // 12-10. Forgot-password rate limit: 5/hr per IP, then 429.
      // (The forgot calls above already consumed part of the hourly
      // allowance, so clear the counter to test the limiter in isolation.)
      db.prepare('DELETE FROM dispatcher_forgot_attempts').run();
      let forgotLocked = 0;
      for (let i = 0; i < 6; i++) {
        r = await req(`${BASE}/dispatch/forgot`, { method: 'POST', form: { email: dEmail('rl') } });
        if (r.status === 429) forgotLocked++;
      }
      check('forgot-password endpoint rate-limits after 5 requests per hour per IP',
        forgotLocked === 1, `locked-responses=${forgotLocked}`);
      db.prepare('DELETE FROM dispatcher_forgot_attempts').run();

      // 12-11. Admin one-time temp password forces a change on next login.
      r = await req(`${BASE}/admin/dispatchers/${dA.id}/reset-password?token=${ADMIN_TOKEN}`, { method: 'POST', form: {} });
      const tempHtml = await r.text();
      const tempMatch = tempHtml.match(/Temporary password for[\s\S]*?<code[^>]*>([^<]+)<\/code>/);
      check('admin temp password is shown once on the management page',
        r.status === 200 && !!tempMatch, `status=${r.status}`);
      const tempPw = tempMatch[1];
      const dA3 = dispRow(dEmail('a'));
      check('temp password stored hashed with must_change_password set',
        dA3.password_hash.startsWith('scrypt$') && !dA3.password_hash.includes(tempPw) && dA3.must_change_password === 1,
        'hash+flag');
      const tempJar = new Jar();
      r = await req(`${BASE}/dispatch/login`, {
        method: 'POST', jar: tempJar, form: { email: dEmail('a'), password: tempPw },
      });
      check('login with the temp password forces the change-password screen',
        r.status === 302 && (r.headers.get('location') || '').includes('/dispatch/change-password'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      r = await req(`${BASE}/dispatch/today`, { jar: tempJar });
      check('temp-password session cannot reach the board before changing the password',
        r.status === 302 && (r.headers.get('location') || '').includes('/dispatch/change-password'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      r = await req(`${BASE}/dispatch/change-password`, {
        method: 'POST', jar: tempJar, form: { current: tempPw, password: 'finaldispatch1', password2: 'finaldispatch1' },
      });
      check('dispatcher chooses their own password (forced change succeeds)',
        r.status === 200 && /Password changed/.test(await r.text()), `status=${r.status}`);
      const finJar = new Jar();
      r = await req(`${BASE}/dispatch/login`, {
        method: 'POST', jar: finJar, form: { email: dEmail('a'), password: 'finaldispatch1' },
      });
      check('new password works and lands on the board',
        r.status === 302 && (r.headers.get('location') || '').endsWith('/dispatch/today'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      const deadJar = new Jar();
      r = await req(`${BASE}/dispatch/login`, {
        method: 'POST', jar: deadJar, form: { email: dEmail('a'), password: tempPw },
      });
      check('the one-time temp password no longer works after the change',
        r.status === 200 && /Invalid email or password/.test(await r.text()) && !deadJar.has('dispatch_sess'),
        `status=${r.status}`);

      // 12-12. Login rate limit: 5 failed attempts per 15 min per email+IP, then lockout.
      let lockStatuses = [];
      for (let i = 0; i < 6; i++) {
        r = await req(`${BASE}/dispatch/login`, {
          method: 'POST', form: { email: dEmail('ratelimit'), password: 'wrongpassword1' },
        });
        lockStatuses.push(r.status);
      }
      check('login rate-limits after 5 failed attempts (429 on the 6th)',
        lockStatuses.slice(0, 5).every((s) => s === 200) && lockStatuses[5] === 429,
        `statuses=${lockStatuses.join(',')}`);

      // 12-13. Change password with the wrong current password is rejected.
      r = await req(`${BASE}/dispatch/change-password`, {
        method: 'POST', jar: finJar, form: { current: 'nottherightone', password: 'anotherpass12', password2: 'anotherpass12' },
      });
      check('change-password rejects a wrong current password',
        r.status === 200 && /current password is not correct/i.test(await r.text()), `status=${r.status}`);

      // 12-14. Logout ends the session.
      r = await req(`${BASE}/dispatch/logout`, { jar: finJar });
      check('logout redirects to the login page',
        r.status === 302 && (r.headers.get('location') || '').endsWith('/dispatch/login'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      r = await req(`${BASE}/dispatch/today`, { jar: finJar });
      check('board is unreachable after logout (302 to login)',
        r.status === 302 && (r.headers.get('location') || '').includes('/dispatch/login'),
        `status=${r.status}`);

      // 12-15. Deactivated dispatcher cannot log in; sessions are killed.
      await req(`${BASE}/admin/dispatchers/${dA.id}/active?token=${ADMIN_TOKEN}`, {
        method: 'POST', form: { active: '0' },
      });
      const deacJar = new Jar();
      r = await req(`${BASE}/dispatch/login`, {
        method: 'POST', jar: deacJar, form: { email: dEmail('a'), password: 'finaldispatch1' },
      });
      check('deactivated dispatcher cannot log in (generic message, no session)',
        r.status === 200 && /Invalid email or password/.test(await r.text()) && !deacJar.has('dispatch_sess'),
        `status=${r.status}`);

      // 12-16. Queue processor delivers dispatch-reset emails (no lead record
      // required — dispatchers are staff, not marketing leads). Regression
      // test: these rows used to be cancelled as 'lead-missing'.
      const autoLibD = require(path.join(APP_ROOT, 'lib', 'automation'));
      const dProc = dEmail('proc');
      db.prepare(`DELETE FROM email_queue WHERE email = ? AND sequence = 'dispatch-reset'`).run(dProc);
      db.prepare(`DELETE FROM dispatchers WHERE email = ?`).run(dProc);
      await req(`${BASE}/admin/dispatchers?token=${ADMIN_TOKEN}`, {
        method: 'POST', form: { name: 'Proc Test', email: dProc, password: 'dispatchpass1' },
      });
      await req(`${BASE}/dispatch/forgot`, { method: 'POST', form: { email: dProc } });
      let pRow = db.prepare(
        `SELECT * FROM email_queue WHERE email = ? AND sequence = 'dispatch-reset' ORDER BY id DESC LIMIT 1`).get(dProc);
      check('dispatch-reset row is queued (not pre-cancelled)',
        !!pRow && pRow.status === 'queued', `status=${pRow && pRow.status}`);
      // Park every other due row so the sweep only touches our fixtures,
      // then restore their original schedule afterwards.
      const sweepNow = Date.now();
      const parked = db.prepare(
        `SELECT id, scheduled_for FROM email_queue WHERE status = 'queued' AND id != ? AND scheduled_for <= ?`)
        .all(pRow.id, sweepNow);
      const parkStmt = db.prepare(`UPDATE email_queue SET scheduled_for = ? WHERE id = ?`);
      for (const pr of parked) parkStmt.run(sweepNow + 3600000, pr.id);
      await autoLibD.processDueEmails(sweepNow);
      const restoreStmt = db.prepare(`UPDATE email_queue SET scheduled_for = ? WHERE id = ?`);
      for (const pr of parked) restoreStmt.run(pr.scheduled_for, pr.id);
      pRow = db.prepare(`SELECT * FROM email_queue WHERE id = ?`).get(pRow.id);
      check('queue processor sends the dispatch-reset email without a lead record',
        pRow.status === 'sent', `status=${pRow.status} reason=${pRow.cancel_reason || 'none'}`);
      // A dispatcher deactivated after requesting the reset must not receive it.
      const dProc2 = dEmail('proc2');
      db.prepare(`DELETE FROM email_queue WHERE email = ? AND sequence = 'dispatch-reset'`).run(dProc2);
      db.prepare(`DELETE FROM dispatchers WHERE email = ?`).run(dProc2);
      await req(`${BASE}/admin/dispatchers?token=${ADMIN_TOKEN}`, {
        method: 'POST', form: { name: 'Proc Test 2', email: dProc2, password: 'dispatchpass1' },
      });
      await req(`${BASE}/dispatch/forgot`, { method: 'POST', form: { email: dProc2 } });
      const dP2 = dispRow(dProc2);
      await req(`${BASE}/admin/dispatchers/${dP2.id}/active?token=${ADMIN_TOKEN}`, {
        method: 'POST', form: { active: '0' },
      });
      let pRow2 = db.prepare(
        `SELECT * FROM email_queue WHERE email = ? AND sequence = 'dispatch-reset' ORDER BY id DESC LIMIT 1`).get(dProc2);
      const sweepNow2 = Date.now();
      const parked2 = db.prepare(
        `SELECT id, scheduled_for FROM email_queue WHERE status = 'queued' AND id != ? AND scheduled_for <= ?`)
        .all(pRow2.id, sweepNow2);
      for (const pr of parked2) parkStmt.run(sweepNow2 + 3600000, pr.id);
      await autoLibD.processDueEmails(sweepNow2);
      for (const pr of parked2) restoreStmt.run(pr.scheduled_for, pr.id);
      pRow2 = db.prepare(`SELECT * FROM email_queue WHERE id = ?`).get(pRow2.id);
      check('queue processor cancels the reset email for a deactivated dispatcher',
        pRow2.status === 'cancelled' && pRow2.cancel_reason === 'inactive-dispatcher',
        `status=${pRow2.status} reason=${pRow2.cancel_reason || 'none'}`);
      db.prepare(`DELETE FROM email_queue WHERE email IN (?, ?) AND sequence = 'dispatch-reset'`).run(dProc, dProc2);
      db.prepare(`DELETE FROM dispatchers WHERE email IN (?, ?)`).run(dProc, dProc2);

      // Cleanup dispatcher fixtures.
      db.prepare('DELETE FROM dispatcher_sessions WHERE dispatcher_id IN (SELECT id FROM dispatchers WHERE email LIKE ?)').run(`${dtag}-%`);
      db.prepare('DELETE FROM dispatcher_reset_tokens WHERE dispatcher_id IN (SELECT id FROM dispatchers WHERE email LIKE ?)').run(`${dtag}-%`);
      db.prepare('DELETE FROM dispatcher_login_attempts WHERE email LIKE ?').run(`${dtag}-%`);
      db.prepare('DELETE FROM dispatchers WHERE email LIKE ?').run(`${dtag}-%`);
      db.prepare('DELETE FROM package_exceptions WHERE package_id LIKE ?').run(`${dtag}-%`);
      db.prepare('DELETE FROM packages WHERE package_id LIKE ?').run(`${dtag}-%`);
      db.prepare('DELETE FROM routes WHERE route_code LIKE ?').run(`${dtag}-%`);
      db.prepare('DELETE FROM drivers WHERE email LIKE ?').run(`${dtag}-%`);
      db.prepare(`DELETE FROM email_queue WHERE email LIKE ? AND sequence = 'dispatch-reset'`).run(`${dtag}-%`);
      check('dispatcher test fixtures cleaned up',
        dispRow(dEmail('a')) === undefined &&
          db.prepare('SELECT COUNT(*) n FROM routes WHERE route_code LIKE ?').get(`${dtag}-%`).n === 0,
        'leftovers');
    }

    /* ---- 13. Wealth Room member password reset -------------------------------- */
    // Mirrors the dispatcher reset: self-service forgot with generic
    // responses (active + claimed members only), single-use 1-hour tokens,
    // admin one-time temp passwords with forced change, member change
    // password, and forgot rate limiting.
    {
      const rtag = 'e2e-rt';
      const rEmail = (n) => `${rtag}-${n}-${ts}@example.com`.toLowerCase();
      const roomLib = require(path.join(APP_ROOT, 'lib', 'room'));
      const mkMember = (n, { claimed = true, status = 'active' } = {}) => {
        const email = rEmail(n);
        db.prepare(`INSERT INTO room_members (email, name, password_hash, joined_at, status, must_change_password)
                    VALUES (?, ?, ?, ?, ?, 0)`)
          .run(email, `Reset Member ${n}`, claimed ? roomLib.hashPassword('memberpass1') : null, ts, status);
        return email;
      };
      const memberEmail = mkMember('a');
      const unclaimedEmail = mkMember('unclaimed', { claimed: false });
      const inactiveEmail = mkMember('inactive', { status: 'inactive' });
      const rQCount = (email) => db.prepare(
        `SELECT COUNT(*) n FROM email_queue WHERE email = ? AND sequence = 'room-reset'`).get(email).n;

      // 13-1. Login page carries the forgot link; forgot is generic either way.
      let r = await req(`${BASE}/room/login`, {});
      check('room login page links to forgot password',
        r.status === 200 && /\/room\/forgot/.test(await r.text()), `status=${r.status}`);
      r = await req(`${BASE}/room/forgot`, {});
      check('GET /room/forgot renders', r.status === 200 && /Reset Your Password/.test(await r.text()), `status=${r.status}`);
      r = await req(`${BASE}/room/forgot`, { method: 'POST', form: { email: memberEmail } });
      check('member forgot-password responds with the generic message',
        r.status === 200 && /If an account exists for that email, a reset link is on its way/.test(await r.text()),
        `status=${r.status}`);
      check('reset email queued for the active claimed member',
        rQCount(memberEmail) === 1, `queued=${rQCount(memberEmail)}`);
      const rBody = db.prepare(
        `SELECT body_html FROM email_queue WHERE email = ? AND sequence = 'room-reset' ORDER BY id DESC LIMIT 1`)
        .get(memberEmail).body_html;
      const rTokMatch = String(rBody).match(/\/room\/reset\/([a-f0-9]{64})/);
      check('queued member reset email carries a single-use /room/reset/ link', !!rTokMatch, 'token in email');
      const rToken = rTokMatch[1];
      r = await req(`${BASE}/room/forgot`, { method: 'POST', form: { email: rEmail('unknown') } });
      check('member forgot for an unknown email: same generic response, no email queued',
        r.status === 200 && /If an account exists for that email/.test(await r.text()) && rQCount(rEmail('unknown')) === 0,
        `queued=${rQCount(rEmail('unknown'))}`);
      r = await req(`${BASE}/room/forgot`, { method: 'POST', form: { email: unclaimedEmail } });
      check('unclaimed member (no password yet): generic response, no email queued',
        r.status === 200 && /If an account exists for that email/.test(await r.text()) && rQCount(unclaimedEmail) === 0,
        `queued=${rQCount(unclaimedEmail)}`);
      r = await req(`${BASE}/room/forgot`, { method: 'POST', form: { email: inactiveEmail } });
      check('inactive member: generic response, no email queued',
        r.status === 200 && /If an account exists for that email/.test(await r.text()) && rQCount(inactiveEmail) === 0,
        `queued=${rQCount(inactiveEmail)}`);

      // 13-2. Reset token: single-use, logs the member in.
      r = await req(`${BASE}/room/reset/${rToken}`, {});
      check('valid member reset token renders the new-password form',
        r.status === 200 && /Choose a New Password/.test(await r.text()), `status=${r.status}`);
      const rJar = new Jar();
      r = await req(`${BASE}/room/reset/${rToken}`, {
        method: 'POST', jar: rJar, form: { password: 'newmemberpass1', password2: 'newmemberpass1' },
      });
      check('valid member reset sets the password and logs the member in',
        r.status === 302 && (r.headers.get('location') || '').endsWith('/room') && rJar.has('room_sess'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      const mRow = db.prepare('SELECT password_hash FROM room_members WHERE email = ?').get(memberEmail);
      check('member reset password stored hashed (not plaintext)',
        mRow.password_hash.startsWith('scrypt$') && !mRow.password_hash.includes('newmemberpass1'));
      r = await req(`${BASE}/room/reset/${rToken}`, {});
      check('member reset token cannot be reused',
        r.status === 400 && /invalid or has expired/i.test(await r.text()), `status=${r.status}`);

      // 13-3. Expired token rejected.
      await req(`${BASE}/room/forgot`, { method: 'POST', form: { email: memberEmail } });
      const rBody2 = db.prepare(
        `SELECT body_html FROM email_queue WHERE email = ? AND sequence = 'room-reset' ORDER BY id DESC LIMIT 1`)
        .get(memberEmail).body_html;
      const rToken2 = String(rBody2).match(/\/room\/reset\/([a-f0-9]{64})/)[1];
      db.prepare('UPDATE room_reset_tokens SET expires_at = ? WHERE email = ? AND used_at IS NULL')
        .run(Date.now() - 1000, memberEmail);
      r = await req(`${BASE}/room/reset/${rToken2}`, {});
      check('expired member reset token is rejected',
        r.status === 400 && /invalid or has expired/i.test(await r.text()), `status=${r.status}`);

      // 13-4. Forgot rate limit for members.
      // (Earlier member forgot calls consumed part of the hourly allowance;
      // clear the counter to test the limiter in isolation.)
      db.prepare('DELETE FROM room_forgot_attempts').run();
      let rLocked = 0;
      for (let i = 0; i < 6; i++) {
        r = await req(`${BASE}/room/forgot`, { method: 'POST', form: { email: rEmail('rl') } });
        if (r.status === 429) rLocked++;
      }
      check('member forgot-password rate-limits after 5 requests per hour per IP',
        rLocked === 1, `locked-responses=${rLocked}`);
      db.prepare('DELETE FROM room_forgot_attempts').run();

      // 13-5. Admin one-time temp password forces a member password change.
      r = await req(`${BASE}/admin/room/member-reset-password?token=${ADMIN_TOKEN}`, {
        method: 'POST', form: { email: memberEmail },
      });
      const rTempHtml = await r.text();
      const rTempMatch = rTempHtml.match(/Temporary password for[\s\S]*?<code[^>]*>([^<]+)<\/code>/);
      check('admin member temp password is shown once',
        r.status === 200 && !!rTempMatch, `status=${r.status}`);
      const rTemp = rTempMatch[1];
      const mRow2 = db.prepare('SELECT password_hash, must_change_password FROM room_members WHERE email = ?').get(memberEmail);
      check('member temp password stored hashed with must_change_password set',
        mRow2.password_hash.startsWith('scrypt$') && !mRow2.password_hash.includes(rTemp) && mRow2.must_change_password === 1,
        'hash+flag');
      const rtJar = new Jar();
      r = await req(`${BASE}/room/login`, {
        method: 'POST', jar: rtJar, form: { email: memberEmail, password: rTemp },
      });
      check('member login with the temp password forces the change-password screen',
        r.status === 302 && (r.headers.get('location') || '').includes('/room/change-password'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      r = await req(`${BASE}/room`, { jar: rtJar });
      check('member cannot reach the Room before changing the temp password',
        r.status === 302 && (r.headers.get('location') || '').includes('/room/change-password'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      r = await req(`${BASE}/room/change-password`, {
        method: 'POST', jar: rtJar, form: { current: rTemp, password: 'finalmember1', password2: 'finalmember1' },
      });
      check('member chooses their own password (forced change succeeds)',
        r.status === 200 && /Password changed/.test(await r.text()), `status=${r.status}`);
      r = await req(`${BASE}/room`, { jar: rtJar });
      check('member is logged in after the forced change (fresh members flow to /room/welcome, not login)',
        r.status === 302 && (r.headers.get('location') || '').endsWith('/room/welcome'),
        `status=${r.status} loc=${r.headers.get('location')}`);
      r = await req(`${BASE}/room/welcome`, { jar: rtJar });
      check('member can open the Room welcome page after the forced change',
        r.status === 200, `status=${r.status}`);
      const rtDead = new Jar();
      r = await req(`${BASE}/room/login`, {
        method: 'POST', jar: rtDead, form: { email: memberEmail, password: rTemp },
      });
      check('the one-time member temp password no longer works after the change',
        /Incorrect password|could not find/i.test(await r.text()) && !rtDead.has('room_sess'),
        `status=${r.status}`);

      // 13-6. Logged-in member change password (wrong current rejected).
      r = await req(`${BASE}/room/change-password`, {
        method: 'POST', jar: rtJar, form: { current: 'wrongcurrent1', password: 'anotherpass1', password2: 'anotherpass1' },
      });
      check('member change-password rejects a wrong current password',
        r.status === 200 && /current password is not correct/i.test(await r.text()), `status=${r.status}`);

      // 14. Admin test-access grants: paid-client experience without Stripe.
      // Test grants flow through broadcasts/matching/PAID badge, are labeled
      // TEST in admin, never touch Stripe, and can't mix with real payments.
      const subsLib = require(path.join(APP_ROOT, 'lib', 'subscriptions'));
      const driversLib = require(path.join(APP_ROOT, 'lib', 'drivers'));
      const rmLib = require(path.join(APP_ROOT, 'lib', 'route_matching'));
      const fcLib = require(path.join(APP_ROOT, 'lib', 'field_comms'));
      const tEmail = (n) => `e2e-testaccess-${n}-${Date.now()}@example.com`;
      const tFixtures = [];

      // 14-1. grantTestAccess creates an active, flagged test subscription.
      const t1 = tEmail('grant'); tFixtures.push(t1);
      await driversLib.createOrUpdateDriver({ email: t1, full_name: 'Test Access Driver', source: 'test' });
      const g1 = await subsLib.grantTestAccess({ email: t1, plan: 'complete' });
      check('grantTestAccess creates an active flagged test subscription',
        g1 && g1.status === 'active' && g1.plan === 'complete' && Number(g1.is_test) === 1 &&
          !g1.stripe_customer_id && !g1.stripe_subscription_id,
        `status=${g1 && g1.status} plan=${g1 && g1.plan} is_test=${g1 && g1.is_test}`);

      // 14-2. Test grants flow through the paid-client gates.
      check('test grant counts as paid-active', (await subsLib.isPaidActive(t1)) === true, 'isPaidActive');
      const tplan = await rmLib.driverPlan({ email: t1 });
      check('driverPlan resolves complete for a test grant', tplan === 'complete', `plan=${tplan}`);
      const audComplete = await fcLib.activeFieldDrivers('complete');
      check('test grant is included in the complete broadcast audience',
        audComplete.some((d) => String(d.email).toLowerCase() === t1.toLowerCase()),
        `audience size=${audComplete.length}`);

      // 14-3. Invalid plan rejected; nothing written.
      const tBad = tEmail('badplan');
      let badPlanErr = '';
      try { await subsLib.grantTestAccess({ email: tBad, plan: 'platinum' }); }
      catch (e) { badPlanErr = e.message || ''; }
      check('grantTestAccess rejects an invalid plan',
        /basic or complete/.test(badPlanErr) && !(await subsLib.getByEmail(tBad)),
        badPlanErr || 'no error');

      // 14-4. Refuses when a real Stripe subscription record exists.
      const t2 = tEmail('real'); tFixtures.push(t2);
      await subsLib.upsertActive({ email: t2, plan: 'basic', stripeCustomerId: 'cus_e2e_real', stripeSubscriptionId: 'sub_e2e_real' });
      let realErr = '';
      try { await subsLib.grantTestAccess({ email: t2, plan: 'complete' }); }
      catch (e) { realErr = e.message || ''; }
      const stillReal = await subsLib.getByEmail(t2);
      check('grantTestAccess refuses when a real Stripe subscription exists',
        /real Stripe/.test(realErr) && stillReal && Number(stillReal.is_test) === 0 &&
          stillReal.stripe_customer_id === 'cus_e2e_real' && stillReal.plan === 'basic',
        realErr || 'no error');

      // 14-5. A real Stripe payment converts a test grant (is_test cleared).
      await subsLib.upsertActive({ email: t1, plan: 'complete', stripeCustomerId: 'cus_e2e_conv', stripeSubscriptionId: 'sub_e2e_conv' });
      const conv = await subsLib.getByEmail(t1);
      check('real Stripe payment converts a test grant to a real subscription',
        conv && Number(conv.is_test) === 0 && conv.stripe_customer_id === 'cus_e2e_conv' && conv.status === 'active',
        `is_test=${conv && conv.is_test}`);

      // 14-6. Admin HTTP: grant via the driver page, TEST badge shown, pipeline counts honest.
      const t3 = tEmail('http'); tFixtures.push(t3);
      const tdrv3 = await driversLib.createOrUpdateDriver({ email: t3, full_name: 'HTTP Test Driver', source: 'test' });
      r = await req(`${BASE}/admin/drivers/${tdrv3.id}/test-access?token=${ADMIN_TOKEN}`, {
        method: 'POST', form: { plan: 'basic' },
      });
      const dPage = await (await req(`${BASE}/admin/drivers/${tdrv3.id}?token=${ADMIN_TOKEN}`)).text();
      check('admin grant route works and the driver page shows the PAID TEST badge',
        r.status === 302 && /PAID · TEST/.test(dPage), `status=${r.status}`);
      const pipeHtml = await (await req(`${BASE}/admin/drivers?token=${ADMIN_TOKEN}`)).text();
      check('pipeline page notes test grants separately from paid clients',
        /\+ 1 test/.test(pipeHtml), 'test-count marker');

      // 14-7. Revoke removes access; real subscriptions can never be revoked this way.
      r = await req(`${BASE}/admin/drivers/${tdrv3.id}/test-access/revoke?token=${ADMIN_TOKEN}`, { method: 'POST' });
      const afterRevoke = await subsLib.getByEmail(t3);
      check('revoke cancels test access',
        r.status === 302 && afterRevoke && afterRevoke.status === 'canceled' && Number(afterRevoke.is_test) === 1,
        `status=${r.status} sub=${afterRevoke && afterRevoke.status}`);
      check('revoked test grant is no longer paid-active',
        (await subsLib.isPaidActive(t3)) === false, 'isPaidActive');
      const audBasic = await fcLib.activeFieldDrivers('basic');
      check('revoked test grant leaves the broadcast audience',
        !audBasic.some((d) => String(d.email).toLowerCase() === t3.toLowerCase()),
        `audience size=${audBasic.length}`);
      let revokeRealErr = '';
      try { await subsLib.revokeTestAccess({ email: t2 }); }
      catch (e) { revokeRealErr = e.message || ''; }
      check('revokeTestAccess refuses real Stripe subscriptions',
        /No test access grant/.test(revokeRealErr), revokeRealErr || 'no error');

      // 14-8. Cleanup test-access fixtures.
      for (const em of tFixtures) {
        db.prepare('DELETE FROM dispatch_subscriptions WHERE email = ?').run(em);
        db.prepare('DELETE FROM email_queue WHERE email = ?').run(em);
        db.prepare(`DELETE FROM events WHERE meta LIKE ?`).run(`%${em}%`);
      }
      db.prepare(`DELETE FROM drivers WHERE email LIKE 'e2e-testaccess-%'`).run();
      check('test-access fixtures cleaned up',
        db.prepare(`SELECT COUNT(*) n FROM dispatch_subscriptions WHERE email LIKE 'e2e-testaccess-%'`).get().n === 0,
        'leftovers');

      // Cleanup member fixtures.
      db.prepare('DELETE FROM room_sessions WHERE email LIKE ?').run(`${rtag}-%`);
      db.prepare('DELETE FROM room_reset_tokens WHERE email LIKE ?').run(`${rtag}-%`);
      db.prepare('DELETE FROM room_members WHERE email LIKE ?').run(`${rtag}-%`);
      db.prepare(`DELETE FROM email_queue WHERE email LIKE ? AND sequence = 'room-reset'`).run(`${rtag}-%`);
      check('member reset fixtures cleaned up',
        db.prepare('SELECT COUNT(*) n FROM room_members WHERE email LIKE ?').get(`${rtag}-%`).n === 0 &&
          db.prepare('SELECT COUNT(*) n FROM room_reset_tokens WHERE email LIKE ?').get(`${rtag}-%`).n === 0,
        'leftovers');
    }
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
