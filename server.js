'use strict';
/**
 * server.js — marketing funnel backend (Express + db layer).
 *
 * Routes:
 *   Funnel:  GET /  /lead  /free-value  /sales  /checkout  /order-bump
 *            /upsell1  /upsell2  /thank-you  /unsubscribe  /preferences
 *            /privacy-note (+ /privacy alias)  /healthz
 *            POST /lead  /checkout  /checkout/complete-demo
 *            POST /order-bump[/accept|/decline]  /upsell/:which  /upsell1|2/accept|decline
 *            POST /webhooks/stripe  /webhooks/email-event  (stubs)
 *   Admin:   /admin*  (guarded by ?token=, then an httpOnly cookie)
 *
 * Views live in views/ (written by the views agent) and return inner <main>
 * markup; this server wraps them with views/layout.js. If a views module is
 * missing or broken, the matching views/fallback/* module is used instead so
 * the server still boots. Config (config/*.json) is read via lib/config.js
 * with an mtime cache, so edits apply without a restart.
 *
 * NOTE: all db calls are async Promises. Express 4 does not forward async
 * route-handler rejections to error middleware, so every async handler is
 * wrapped with `ah()` (async handler) which routes rejections to next(err).
 */
const path = require('path');
const fs = require('fs');
const express = require('express');

const db = require('./lib/db');
const config = require('./lib/config');
const tags = require('./lib/tags');
const tracking = require('./lib/tracking');
const automation = require('./lib/automation');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';
if (ADMIN_TOKEN === 'changeme') {
  console.warn(
    '⚠️  WARNING: ADMIN_TOKEN is not set — the admin panel uses the default token "changeme". ' +
      'Set the ADMIN_TOKEN environment variable in production!'
  );
}

/** Wrap an async route handler so rejections reach next(err) (Express 4). */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Views (real modules with fallback) ----------------------------------------
function loadViewModule(realPath, fallbackPath, requiredExports, label) {
  try {
    const mod = require(realPath);
    for (const name of requiredExports) {
      if (typeof mod[name] !== 'function') throw new Error(`missing export ${name}()`);
    }
    return mod;
  } catch (err) {
    console.warn(`[views] ${label}: ${err.message} — using fallback views (${fallbackPath})`);
    return require(fallbackPath);
  }
}

const layoutFn = loadViewModule('./views/layout', './views/fallback/layout', ['layout'], 'layout').layout;
const pages = loadViewModule(
  './views/pages',
  './views/fallback/pages',
  [
    'landingPage', 'leadPage', 'freeValuePage', 'salesPage', 'checkoutPage', 'orderBumpPage',
    'upsellPage', 'thankYouPage', 'unsubscribePage', 'preferencesPage', 'privacyPage',
  ],
  'pages'
);
const adminViews = loadViewModule(
  './views/admin',
  './views/fallback/admin',
  [
    'adminLayout', 'dashboardHtml', 'leadsTableHtml', 'cartsTableHtml',
    'emailsTableHtml', 'outboxHtml', 'suppressionsHtml', 'configEditorHtml',
  ],
  'admin'
);

// --- Small helpers ----------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTs(ts) {
  if (!ts) return '';
  return new Date(Number(ts)).toLocaleString();
}

/** Render a funnel page: views return inner markup, layout wraps it. */
function page(res, title, bodyHtml, site) {
  res.send(layoutFn({ title, body: bodyHtml, site }));
}

function productFromReq(req) {
  return config.getProduct((req.body && req.body.product_id) || req.query.p);
}

async function leadFromReq(req) {
  return req.leadId ? db.get('SELECT * FROM leads WHERE id = ?', [req.leadId]) : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Upsert a lead by email and identify the visitor (sets the `lid` cookie and
 * merges this visitor's anonymous page_views/events onto the lead).
 * `consent`: 1/0 to write, or null to leave unchanged (new leads default to 1).
 */
async function identifyLead(req, res, fields, product, consent) {
  const firstName = (fields.first_name || '').trim();
  const emailAddr = (fields.email || '').trim().toLowerCase();
  const phone = (fields.phone || '').trim() || null;
  const now = Date.now();
  let src = fields.source || req.query.src || req.query.source || null;
  let cmp = fields.campaign || req.query.cmp || req.query.campaign || null;
  // Fall back to the visitor's first-touch attribution (captured on their
  // first page view) when the form/query carries none.
  if ((!src || !cmp) && req.vid) {
    const v = await db.get('SELECT source, campaign FROM visitors WHERE id = ?', [req.vid]);
    if (v) {
      if (!src) src = v.source || null;
      if (!cmp) cmp = v.campaign || null;
    }
  }

  let lead = await db.get('SELECT * FROM leads WHERE email = ?', [emailAddr]);
  if (lead) {
    await db.run(
      `UPDATE leads SET
         first_name = CASE WHEN ? <> '' THEN ? ELSE first_name END,
         phone = COALESCE(?, phone),
         visitor_id = COALESCE(visitor_id, ?),
         source = COALESCE(source, ?),
         campaign = COALESCE(campaign, ?),
         offer_of_interest = COALESCE(offer_of_interest, ?)
       WHERE id = ?`,
      [firstName, firstName, phone, req.vid, src, cmp, product.id, lead.id]
    );
    if (consent !== null && consent !== undefined) {
      await db.run('UPDATE leads SET consent_marketing = ?, consent_ts = ? WHERE id = ?', [consent, now, lead.id]);
    }
    lead = await db.get('SELECT * FROM leads WHERE id = ?', [lead.id]);
  } else {
    const info = await db.run(
      `INSERT INTO leads
         (visitor_id, first_name, email, phone, source, campaign, offer_of_interest,
          consent_marketing, consent_ts, date_captured, status, unsubscribed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'lead', 0)`,
      [req.vid, firstName || null, emailAddr, phone, src, cmp, product.id,
        consent !== null && consent !== undefined ? consent : 1, now, now]
    );
    lead = await db.get('SELECT * FROM leads WHERE id = ?', [Number(info.lastInsertRowid)]);
  }

  // Merge this visitor's anonymous history onto the lead.
  await db.run('UPDATE page_views SET lead_id = ? WHERE visitor_id = ? AND lead_id IS NULL', [lead.id, req.vid]);
  await db.run('UPDATE events SET lead_id = ? WHERE visitor_id = ? AND lead_id IS NULL', [lead.id, req.vid]);
  tracking.setCookie(res, 'lid', String(lead.id));
  return lead;
}

/** Has this lead already accepted/declined this one-time upsell? (events are per-upsell) */
async function upsellDecided(leadId, which) {
  const base = which.toUpperCase(); // UPSELL1 / UPSELL2
  return !!(await db.get('SELECT 1 FROM events WHERE lead_id = ? AND type IN (?, ?)', [
    leadId, `${base}_ACCEPTED`, `${base}_DECLINED`,
  ]));
}

/** Next step in the post-purchase flow. */
async function nextFunnelUrl(leadId, product) {
  const p = `?p=${encodeURIComponent(product.id)}`;
  const bumpSeen = await db.get(
    "SELECT 1 FROM events WHERE lead_id = ? AND type = 'ORDER_BUMP_SHOWN' AND product_id = ?",
    [leadId, product.id]
  );
  if (product.orderBump && product.orderBump.enabled && !bumpSeen) return '/order-bump' + p;
  if (product.upsell1 && product.upsell1.enabled && !(await upsellDecided(leadId, 'upsell1'))) return '/upsell1' + p;
  if (product.upsell2 && product.upsell2.enabled && !(await upsellDecided(leadId, 'upsell2'))) return '/upsell2' + p;
  return '/thank-you' + p;
}

async function purchaseModeFor(leadId, productId) {
  const row = await db.get("SELECT mode FROM purchases WHERE lead_id = ? AND product_id = ? AND kind = 'initial'", [
    leadId, productId,
  ]);
  return (row && row.mode) || 'demo';
}

/**
 * Record the initial purchase of a product. Idempotent per (lead, product).
 * Returns the URL of the next funnel step.
 */
async function recordPurchase(leadId, productId, mode, opts = {}) {
  const now = Date.now();
  const product = config.getProduct(productId);
  const lead = await db.get('SELECT * FROM leads WHERE id = ?', [leadId]);
  if (!lead) return `/thank-you?p=${encodeURIComponent(product.id)}`;

  const already = await db.get(
    "SELECT id FROM purchases WHERE lead_id = ? AND product_id = ? AND kind = 'initial'",
    [leadId, product.id]
  );
  if (already) return nextFunnelUrl(leadId, product); // idempotent — no double charge records

  const amountCents = opts.amountCents != null ? Number(opts.amountCents) : product.priceCents || 0;
  const otherProduct = await db.get(
    "SELECT 1 FROM purchases WHERE lead_id = ? AND product_id != ? AND kind = 'initial'",
    [leadId, product.id]
  );
  await db.run(
    `INSERT INTO purchases (lead_id, product_id, amount_cents, mode, kind, ts)
     VALUES (?, ?, ?, ?, 'initial', ?)`,
    [leadId, product.id, amountCents, mode, now]
  );
  if (otherProduct) await tags.addTag(leadId, 'REPEAT_CUSTOMER');

  const hadAbandonedTag = await tags.hasTag(leadId, 'ABANDONED_CART');
  await tags.removeTag(leadId, 'ABANDONED_CART');

  // Close this lead's open carts for the product; flag true recoveries.
  const openCarts = await db.all('SELECT * FROM carts WHERE lead_id = ? AND product_id = ? AND purchased = 0', [
    leadId, product.id,
  ]);
  for (const cart of openCarts) {
    const recovered = cart.started_at < now - 3600e3 && hadAbandonedTag ? 1 : 0;
    await db.run('UPDATE carts SET purchased = 1, recovered = ? WHERE id = ?', [recovered, cart.id]);
  }

  // Stop purchase-triggered follow-ups for this product.
  await db.run(
    `UPDATE email_queue SET status = 'cancelled', cancel_reason = 'purchased'
     WHERE lead_id = ? AND status = 'queued' AND sequence = 'abandonedCart'`,
    [leadId]
  );
  await automation.cancelNurtureForProduct(leadId, product.id);

  await tags.addTag(leadId, 'PURCHASED');
  await tags.addTag(leadId, 'CUSTOMER');
  await tags.addTag(leadId, `OFFER_${product.id}_PURCHASED`);
  await db.run("UPDATE leads SET status = 'customer' WHERE id = ?", [leadId]);
  await automation.scheduleSequence(leadId, product.id, 'postPurchase');
  await db.recordEvent({
    lead_id: leadId, type: 'PURCHASED', product_id: product.id, meta: { mode, amount_cents: amountCents },
  });
  return nextFunnelUrl(leadId, product);
}

/** Record an order-bump or upsell purchase (kind 'orderbump' | 'upsell'). Idempotent. */
async function recordAddonPurchase(leadId, product, which, mode) {
  const addon = which === 'orderbump' ? product.orderBump : product[which];
  if (!addon || !addon.enabled) return false;
  const addonPid = `${product.id}:${which}`;
  const kind = which === 'orderbump' ? 'orderbump' : 'upsell';
  const dupe = await db.get('SELECT 1 FROM purchases WHERE lead_id = ? AND product_id = ? AND kind = ?', [
    leadId, addonPid, kind,
  ]);
  if (dupe) return true;
  const parent = await db.get("SELECT id FROM purchases WHERE lead_id = ? AND product_id = ? AND kind = 'initial'", [
    leadId, product.id,
  ]);
  await db.run(
    `INSERT INTO purchases (lead_id, product_id, amount_cents, mode, kind, parent_id, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [leadId, addonPid, addon.priceCents || 0, mode, kind, parent ? parent.id : null, Date.now()]
  );
  if (which === 'orderbump') {
    await db.recordEvent({
      lead_id: leadId, type: 'ORDERBUMP_ACCEPTED', product_id: product.id,
      meta: { amount_cents: addon.priceCents || 0 },
    });
  } else {
    await tags.addTag(leadId, 'UPSELL_ACCEPTED');
    await db.recordEvent({
      lead_id: leadId, type: `${which.toUpperCase()}_ACCEPTED`, product_id: product.id,
      meta: { amount_cents: addon.priceCents || 0 },
    });
  }
  return true;
}

// --- Middleware -------------------------------------------------------------------
app.use(express.urlencoded({ extended: false }));
app.use(express.json()); // webhook stubs only; forms use urlencoded
app.use(express.static(path.join(__dirname, 'public')));
app.use(ah(tracking.middleware));

// --- Funnel pages -------------------------------------------------------------------
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/', ah(async (req, res) => {
  const site = config.getSite();
  const product = productFromReq(req);
  const lead = await leadFromReq(req);
  if (lead) {
    await tags.addTag(lead.id, 'VIEWED_OFFER');
    await tags.addTag(lead.id, `OFFER_${product.id}_VIEWED`);
  }
  page(res, product.name, pages.landingPage(site, product), site);
}));

app.get('/lead', (req, res) => {
  const site = config.getSite();
  page(res, 'Free download', pages.leadPage(site, productFromReq(req), req.query), site);
});

app.post('/lead', ah(async (req, res) => {
  const site = config.getSite();
  const product = productFromReq(req);
  const firstName = (req.body.first_name || '').trim();
  const emailAddr = (req.body.email || '').trim().toLowerCase();

  if (!firstName || !EMAIL_RE.test(emailAddr)) {
    res.status(400);
    return page(
      res, 'Free download',
      pages.leadPage(site, product, { ...req.query, error: 'Please enter your first name and a valid email address.' }),
      site
    );
  }

  // Explicit opt-in checkbox on the lead form (unchecked boxes submit nothing).
  const consent =
    req.body.consent !== undefined
      ? req.body.consent === 'yes' || req.body.consent === 'on' || req.body.consent === '1' ? 1 : 0
      : req.body.consent_marketing !== undefined
        ? (req.body.consent_marketing ? 1 : 0)
        : 0;

  const lead = await identifyLead(
    req, res,
    {
      first_name: firstName, email: emailAddr, phone: req.body.phone,
      source: req.body.source, campaign: req.body.campaign,
    },
    product, consent
  );
  await tags.addTag(lead.id, 'NEW_LEAD');
  await tags.addTag(lead.id, `OFFER_${product.id}_LEAD`);
  await db.recordEvent({
    visitor_id: req.vid, lead_id: lead.id, type: 'LEAD_SUBMITTED',
    product_id: product.id, meta: { source: lead.source || null },
  });
  await automation.scheduleSequence(lead.id, product.id, 'nurture');
  res.redirect(`/free-value?p=${encodeURIComponent(product.id)}`);
}));

app.get('/free-value', ah(async (req, res) => {
  const site = config.getSite();
  const product = productFromReq(req);
  page(res, 'Your free download', pages.freeValuePage(site, product, await leadFromReq(req)), site);
}));

app.get('/sales', ah(async (req, res) => {
  const site = config.getSite();
  const product = productFromReq(req);
  const lead = await leadFromReq(req);
  if (lead) {
    await tags.addTag(lead.id, 'VIEWED_OFFER');
    await tags.addTag(lead.id, `OFFER_${product.id}_VIEWED`);
  }
  page(res, product.name, pages.salesPage(site, product), site);
}));

app.get('/checkout', ah(async (req, res) => {
  const site = config.getSite();
  const product = productFromReq(req);
  page(res, 'Checkout', pages.checkoutPage(site, product, await leadFromReq(req), site.paymentMode), site);
}));

app.post('/checkout', ah(async (req, res) => {
  const site = config.getSite();
  const product = productFromReq(req);
  const emailAddr = (req.body.email || '').trim().toLowerCase();
  const firstName = (req.body.first_name || '').trim();

  if (!firstName || !EMAIL_RE.test(emailAddr)) {
    const body = `<section><h1>Checkout</h1><p class="error">Please provide your first name and a valid email address to continue.</p><p><a class="btn" href="/checkout?p=${esc(product.id)}">Back to checkout</a></p></section>`;
    res.status(400);
    return page(res, 'Checkout', body, site);
  }

  const lead = await identifyLead(
    req, res,
    { first_name: firstName, email: emailAddr, phone: req.body.phone },
    product,
    null // checkout doesn't change marketing consent
  );
  await db.run('INSERT INTO carts (lead_id, visitor_id, product_id, started_at, purchased, recovered) VALUES (?, ?, ?, ?, 0, 0)', [
    lead.id, req.vid, product.id, Date.now(),
  ]);
  await tags.addTag(lead.id, 'STARTED_CHECKOUT');
  await tags.addTag(lead.id, 'HIGH_INTENT');
  await db.recordEvent({ visitor_id: req.vid, lead_id: lead.id, type: 'CHECKOUT_STARTED', product_id: product.id });

  if (site.paymentMode === 'stripe' && product.stripeLink) {
    return res.redirect(302, product.stripeLink); // cart stays open for abandonment tracking
  }
  if (site.paymentMode === 'stripe' && !product.stripeLink) {
    console.warn(`[checkout] paymentMode=stripe but product ${product.id} has no stripeLink — using demo confirm page.`);
  }
  // Demo mode: confirm page with a "complete purchase" button (no real charge).
  const body = `<section>
    <h1>Confirm your order</h1>
    <div class="card">
      <h2>${esc(product.name)}</h2>
      <p class="price-line">${esc(product.priceDisplay || '')}</p>
    </div>
    <p>Demo mode — clicking below records a demo purchase. <strong>No charge is made.</strong></p>
    <form method="POST" action="/checkout/complete-demo" class="form">
      <input type="hidden" name="product_id" value="${esc(product.id)}">
      <button type="submit" class="btn btn-large">Complete Demo Purchase — no charge</button>
    </form>
    <p class="microcopy">Ordering as ${esc(lead.email || '')}. <a href="/checkout?p=${esc(product.id)}">Back</a></p>
  </section>`;
  page(res, 'Confirm your order', body, site);
}));

app.post('/checkout/complete-demo', ah(async (req, res) => {
  const lead = await leadFromReq(req);
  if (!lead) return res.redirect('/checkout');
  let productId = req.body.product_id;
  if (!productId) {
    const cart = await db.get('SELECT * FROM carts WHERE lead_id = ? AND purchased = 0 ORDER BY started_at DESC LIMIT 1', [lead.id]);
    productId = cart ? cart.product_id : null;
  }
  res.redirect(await recordPurchase(lead.id, productId, 'demo'));
}));

// --- Order bump -----------------------------------------------------------------------
async function orderBumpAccept(lead, product) {
  await recordAddonPurchase(lead.id, product, 'orderbump', await purchaseModeFor(lead.id, product.id));
}
async function orderBumpDecline(lead, product) {
  await db.recordEvent({ lead_id: lead.id, type: 'ORDERBUMP_DECLINED', product_id: product.id });
}

app.get('/order-bump', ah(async (req, res) => {
  const site = config.getSite();
  const product = productFromReq(req);
  const lead = await leadFromReq(req);
  if (!lead) return res.redirect(`/checkout?p=${encodeURIComponent(product.id)}`);
  if (!product.orderBump || !product.orderBump.enabled) return res.redirect(await nextFunnelUrl(lead.id, product));
  await db.recordEvent({ lead_id: lead.id, type: 'ORDER_BUMP_SHOWN', product_id: product.id });
  page(res, 'Add to your order', pages.orderBumpPage(site, product), site);
}));

// Form shape used by views/pages.js: POST /order-bump with accept=yes|no
app.post('/order-bump', ah(async (req, res) => {
  const product = productFromReq(req);
  const lead = await leadFromReq(req);
  if (!lead) return res.redirect(`/checkout?p=${encodeURIComponent(product.id)}`);
  if (req.body.accept === 'yes') await orderBumpAccept(lead, product);
  else await orderBumpDecline(lead, product);
  res.redirect(await nextFunnelUrl(lead.id, product));
}));
// Spec'd split routes (kept for contract compatibility)
app.post('/order-bump/accept', ah(async (req, res) => {
  const product = productFromReq(req);
  const lead = await leadFromReq(req);
  if (!lead) return res.redirect(`/checkout?p=${encodeURIComponent(product.id)}`);
  await orderBumpAccept(lead, product);
  res.redirect(await nextFunnelUrl(lead.id, product));
}));
app.post('/order-bump/decline', ah(async (req, res) => {
  const product = productFromReq(req);
  const lead = await leadFromReq(req);
  if (!lead) return res.redirect(`/checkout?p=${encodeURIComponent(product.id)}`);
  await orderBumpDecline(lead, product);
  res.redirect(await nextFunnelUrl(lead.id, product));
}));

// --- Upsells -----------------------------------------------------------------------------
function upsellGetHandler(which) {
  return ah(async (req, res) => {
    const site = config.getSite();
    const product = productFromReq(req);
    const lead = await leadFromReq(req);
    const upsell = product[which];
    if (!lead) return res.redirect(`/checkout?p=${encodeURIComponent(product.id)}`);
    // Never re-show a disabled or already-decided one-time upsell.
    if (!upsell || !upsell.enabled || (await upsellDecided(lead.id, which))) {
      return res.redirect(await nextFunnelUrl(lead.id, product));
    }
    await db.recordEvent({ lead_id: lead.id, type: `${which.toUpperCase()}_SHOWN`, product_id: product.id });
    page(res, 'Special offer', pages.upsellPage(site, product, upsell, which), site);
  });
}

function upsellDecide(which, accepted) {
  return ah(async (req, res) => {
    const product = productFromReq(req);
    const lead = await leadFromReq(req);
    if (!lead) return res.redirect(`/checkout?p=${encodeURIComponent(product.id)}`);
    if (!(await upsellDecided(lead.id, which))) {
      if (accepted) {
        await recordAddonPurchase(lead.id, product, which, await purchaseModeFor(lead.id, product.id));
      } else {
        await tags.addTag(lead.id, 'UPSELL_DECLINED');
        await db.recordEvent({ lead_id: lead.id, type: `${which.toUpperCase()}_DECLINED`, product_id: product.id });
      }
    }
    res.redirect(await nextFunnelUrl(lead.id, product));
  });
}

app.get('/upsell1', upsellGetHandler('upsell1'));
app.get('/upsell2', upsellGetHandler('upsell2'));
// Form shape used by views/pages.js: POST /upsell/:which with accept=yes|no
app.post('/upsell/:which', ah(async (req, res, next) => {
  const which = req.params.which;
  if (which !== 'upsell1' && which !== 'upsell2') return next();
  await upsellDecide(which, req.body.accept === 'yes')(req, res, next);
}));
// Spec'd split routes (kept for contract compatibility)
app.post('/upsell1/accept', upsellDecide('upsell1', true));
app.post('/upsell1/decline', upsellDecide('upsell1', false));
app.post('/upsell2/accept', upsellDecide('upsell2', true));
app.post('/upsell2/decline', upsellDecide('upsell2', false));

app.get('/thank-you', ah(async (req, res) => {
  const site = config.getSite();
  const product = productFromReq(req);
  page(res, 'Thank you', pages.thankYouPage(site, product, await leadFromReq(req)), site);
}));

// --- Unsubscribe / preferences / privacy ----------------------------------------------------
app.get('/unsubscribe', (req, res) => {
  const site = config.getSite();
  page(res, 'Unsubscribe', pages.unsubscribePage(site, req.query.email || ''), site);
});

app.post('/unsubscribe', ah(async (req, res) => {
  const site = config.getSite();
  const emailAddr = (req.body.email || '').trim().toLowerCase();
  const lead = emailAddr ? await db.get('SELECT * FROM leads WHERE email = ?', [emailAddr]) : null;
  if (lead && !lead.unsubscribed) {
    await db.run('UPDATE leads SET unsubscribed = 1 WHERE id = ?', [lead.id]);
    await tags.addTag(lead.id, 'UNSUBSCRIBED');
    await db.run("UPDATE email_queue SET status = 'cancelled', cancel_reason = 'unsubscribed' WHERE lead_id = ? AND status = 'queued'", [lead.id]);
    await db.recordEvent({ lead_id: lead.id, type: 'UNSUBSCRIBED' });
  }
  const body = `<section>
    <h1>You&rsquo;re unsubscribed</h1>
    <p>${emailAddr ? `We&rsquo;ve removed <strong>${esc(emailAddr)}</strong> from` : `If that address was on`} our marketing list. You won&rsquo;t receive further marketing emails from ${esc(site.businessName)}.</p>
    <p><a href="/">Back to the homepage</a></p>
  </section>`;
  page(res, 'Unsubscribed', body, site);
}));

app.get('/preferences', ah(async (req, res) => {
  const site = config.getSite();
  page(res, 'Email preferences', pages.preferencesPage(site, await leadFromReq(req)), site);
}));

app.post('/preferences', ah(async (req, res) => {
  const lead = await leadFromReq(req);
  if (lead) {
    let consent = null;
    // Real form shape: nurture / weekly_flyer checkboxes (value "yes")
    if (req.body.nurture !== undefined || req.body.weekly_flyer !== undefined) {
      consent = req.body.nurture === 'yes' || req.body.weekly_flyer === 'yes' ? 1 : 0;
    } else if (req.body.consent_marketing !== undefined) {
      consent = req.body.consent_marketing ? 1 : 0;
    } else if (req.body.consent !== undefined) {
      consent = req.body.consent === 'yes' ? 1 : 0;
    }
    if (consent !== null) {
      await db.run('UPDATE leads SET consent_marketing = ?, consent_ts = ? WHERE id = ?', [consent, Date.now(), lead.id]);
    }
    const phone = (req.body.phone || '').trim();
    if (phone) await db.run('UPDATE leads SET phone = ? WHERE id = ?', [phone, lead.id]);
  }
  res.redirect('/preferences');
}));

function privacyHandler(req, res) {
  const site = config.getSite();
  page(res, 'Privacy notice', pages.privacyPage(site), site);
}
app.get('/privacy-note', privacyHandler);
app.get('/privacy', privacyHandler); // alias — the views link to /privacy

// --- Webhook stubs ---------------------------------------------------------------------------
app.post('/webhooks/stripe', ah(async (req, res) => {
  // STUB. Production MUST verify the Stripe signature using the RAW request
  // body and STRIPE_WEBHOOK_SECRET before trusting this payload (this stub
  // uses express.json(), which cannot do that verification).
  const { email, productId, amountCents } = req.body || {};
  console.log('[webhook:stripe] stub received', { email, productId, amountCents });
  const cleanEmail = (email || '').trim().toLowerCase();
  const lead = cleanEmail ? await db.get('SELECT * FROM leads WHERE email = ?', [cleanEmail]) : null;
  if (lead && productId) {
    await recordPurchase(lead.id, productId, 'stripe-webhook', { amountCents });
  } else {
    console.warn('[webhook:stripe] stub ignored payload — unknown lead or missing productId');
  }
  res.json({ ok: true, note: 'stub' });
}));

app.post('/webhooks/email-event', ah(async (req, res) => {
  // STUB for bounce/complaint webhooks from the email provider.
  const { email, event } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  const evt = (event || '').toLowerCase();
  if (cleanEmail && (evt === 'bounce' || evt === 'complaint')) {
    await db.run('INSERT OR IGNORE INTO suppressions (email, reason, ts) VALUES (?, ?, ?)', [cleanEmail, evt, Date.now()]);
    const lead = await db.get('SELECT * FROM leads WHERE email = ?', [cleanEmail]);
    if (lead) {
      await tags.addTag(lead.id, 'SUPPRESSED');
      await db.run("UPDATE email_queue SET status = 'cancelled', cancel_reason = 'suppressed' WHERE lead_id = ? AND status = 'queued'", [lead.id]);
      await db.recordEvent({ lead_id: lead.id, type: 'EMAIL_SUPPRESSED', meta: { reason: evt } });
    }
    console.log(`[webhook:email-event] suppressed ${cleanEmail} (${evt})`);
  }
  res.json({ ok: true });
}));

// --- Admin -------------------------------------------------------------------------------------
/**
 * Guard: ?token= must equal ADMIN_TOKEN. On a successful query-token auth we
 * also set an httpOnly cookie so the admin views' plain /admin links and forms
 * (which don't carry the token) keep working.
 */
function adminAuth(req, res, next) {
  if (req.query.token && req.query.token === ADMIN_TOKEN) {
    tracking.setCookie(res, 'funnel_adm', ADMIN_TOKEN, { maxAge: 12 * 3600 });
    return next();
  }
  if (tracking.getCookies(req).funnel_adm === ADMIN_TOKEN) return next();
  res.status(403).type('text').send('Forbidden: a valid admin token is required (?token=...)');
}
app.use('/admin', adminAuth);

async function adminMetrics() {
  const q = (sql, p = []) => db.get(sql, p);
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600e3;
  const leads = (await q('SELECT COUNT(*) c FROM leads')).c;
  const customers = (await q("SELECT COUNT(DISTINCT lead_id) c FROM purchases WHERE kind = 'initial'")).c;
  const visitors = (await q('SELECT COUNT(*) c FROM visitors')).c;
  const checkouts = (await q('SELECT COUNT(DISTINCT lead_id) c FROM carts WHERE lead_id IS NOT NULL')).c;
  // Full metrics object: the six keys below feed the dashboard view; the rest
  // are the contract's extended metrics (additive — the view ignores extras).
  return {
    // --- dashboard cards (consumed by views/admin.js) ---
    visitors,
    leads,
    checkouts,
    customers,
    upsellCustomers: (await q("SELECT COUNT(DISTINCT lead_id) c FROM purchases WHERE kind IN ('upsell', 'orderbump')")).c,
    repeatCustomers: (await q("SELECT COUNT(*) c FROM tags WHERE tag = 'REPEAT_CUSTOMER'")).c,
    // --- extended contract metrics ---
    totalLeads: leads,
    newLeadsWeek: (await q('SELECT COUNT(*) c FROM leads WHERE date_captured > ?', [weekAgo])).c,
    newCustomers: (await q("SELECT COUNT(DISTINCT lead_id) c FROM purchases WHERE kind = 'initial' AND ts > ?", [weekAgo])).c,
    conversionRate: leads ? Math.round((customers / leads) * 10000) / 10000 : 0, // customers / leads
    checkoutStarts: (await q('SELECT COUNT(*) c FROM carts')).c,
    abandonedCarts: (await q("SELECT COUNT(*) c FROM tags WHERE tag = 'ABANDONED_CART'")).c,
    cartRecoveries: (await q('SELECT COUNT(*) c FROM carts WHERE recovered = 1')).c,
    revenue: Math.round(((await q('SELECT COALESCE(SUM(amount_cents), 0) s FROM purchases')).s / 100) * 100) / 100,
    upsellRevenue:
      Math.round(((await q("SELECT COALESCE(SUM(amount_cents), 0) s FROM purchases WHERE kind IN ('upsell', 'orderbump')")).s / 100) * 100) / 100,
    emailSubscribers: (await q('SELECT COUNT(*) c FROM leads WHERE unsubscribed = 0 AND consent_marketing = 1')).c,
    unsubscribes: (await q('SELECT COUNT(*) c FROM leads WHERE unsubscribed = 1')).c,
    topOffers: await db.all(
      `SELECT product_id, COUNT(*) AS purchases,
              ROUND(COALESCE(SUM(amount_cents), 0) / 100.0, 2) AS revenue
       FROM purchases GROUP BY product_id ORDER BY purchases DESC LIMIT 5`
    ),
    leadSources: await db.all(
      `SELECT COALESCE(NULLIF(source, ''), 'direct') AS source, COUNT(*) AS leads
       FROM leads GROUP BY source ORDER BY leads DESC`
    ),
    funnelCounts: { visitors, leads, checkouts, customers },
    dropOff: {
      // absolute + conversion rate lost between consecutive funnel stages
      visitorToLead: drop(visitors, leads),
      leadToCheckout: drop(leads, checkouts),
      checkoutToCustomer: drop(checkouts, customers),
    },
  };
}

/** { lost, rate } between two funnel stage counts (rate = converted / from). */
function drop(from, to) {
  const f = Number(from) || 0;
  const t = Number(to) || 0;
  return { lost: Math.max(0, f - t), rate: f ? Math.round((t / f) * 10000) / 10000 : 0 };
}

app.get('/admin', ah(async (req, res) => {
  const site = config.getSite();
  res.send(adminViews.adminLayout('Dashboard', adminViews.dashboardHtml(await adminMetrics(), site)));
}));

app.get('/admin/leads', ah(async (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  const leads = q
    ? await db.all(
        'SELECT * FROM leads WHERE email LIKE ? OR first_name LIKE ? OR phone LIKE ? ORDER BY date_captured DESC LIMIT 200',
        [like, like, like]
      )
    : await db.all('SELECT * FROM leads ORDER BY date_captured DESC LIMIT 200');
  // Shape matches views/admin.js leadsTableHtml: {id, first_name, email, phone,
  // source, campaign, consent, created_at}; query is passed through as an object.
  const mapped = leads.map((l) => ({
    id: l.id,
    first_name: l.first_name,
    email: l.email,
    phone: l.phone,
    source: l.source,
    campaign: l.campaign,
    consent: !!l.consent_marketing,
    created_at: fmtTs(l.date_captured),
  }));
  res.send(adminViews.adminLayout('Leads', adminViews.leadsTableHtml(mapped, req.query)));
}));

app.get('/admin/carts', ah(async (req, res) => {
  const site = config.getSite();
  const base = site.baseUrl.replace(/\/$/, '');
  const carts = await db.all('SELECT * FROM carts ORDER BY started_at DESC LIMIT 200');
  const mapped = [];
  for (const c of carts) {
    mapped.push({
      id: c.id,
      lead_id: c.lead_id,
      product_id: c.product_id,
      status: c.purchased
        ? 'purchased'
        : c.lead_id && (await tags.hasTag(c.lead_id, 'ABANDONED_CART'))
          ? 'abandoned'
          : 'open',
      checkout_url: `${base}/checkout?p=${encodeURIComponent(c.product_id || '')}`,
      abandoned_at: fmtTs(c.started_at),
    });
  }
  res.send(adminViews.adminLayout('Carts', adminViews.cartsTableHtml(mapped)));
}));

app.get('/admin/emails', ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM email_queue ORDER BY id DESC LIMIT 200');
  const mapped = rows.map((e) => ({
    id: e.id,
    lead_id: e.lead_id,
    sequence: e.sequence,
    step_id: e.step,
    subject: e.subject,
    scheduled_at: fmtTs(e.scheduled_for),
    sent_at: e.sent_at ? fmtTs(e.sent_at) : 'pending',
    status: e.status + (e.cancel_reason ? ` (${e.cancel_reason})` : ''),
  }));
  res.send(adminViews.adminLayout('Emails', adminViews.emailsTableHtml(mapped)));
}));

function parseOutboxFile(fname) {
  const full = path.join(db.OUTBOX_DIR, fname);
  const stat = fs.statSync(full);
  const head = fs.readFileSync(full, 'utf8').slice(0, 1500);
  const m = /<!--\s*To:\s*(.*?)\n\s*Subject:\s*(.*?)\n\s*Date:\s*(.*?)\n\s*Queue-ID:\s*(.*?)\s*-->/s.exec(head);
  return {
    id: (m && m[4] ? m[4].trim() : fname.split('-')[0]),
    to: (m && m[1] ? m[1].trim() : ''),
    subject: (m && m[2] ? m[2].trim() : ''),
    created_at: stat.mtime.toLocaleString(),
    status: 'sent',
    error: '',
    file: fname,
  };
}

app.get('/admin/outbox', (req, res) => {
  if (req.query.file) {
    const fname = path.basename(req.query.file);
    const full = path.join(db.OUTBOX_DIR, fname);
    if (!full.startsWith(db.OUTBOX_DIR + path.sep) || !fs.existsSync(full)) {
      return res.status(404).type('text').send('Not found');
    }
    const content = fs.readFileSync(full, 'utf8');
    return res.send(
      adminViews.adminLayout(
        'Outbox',
        `<p><a href="/admin/outbox">&larr; Back to outbox</a></p><h2>${esc(fname)}</h2>` +
          `<pre style="white-space:pre-wrap;border:1px solid #ddd;padding:1em;overflow:auto">${esc(content)}</pre>`
      )
    );
  }
  const files = fs
    .readdirSync(db.OUTBOX_DIR)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .reverse();
  const items = files.map(parseOutboxFile);
  const links =
    `<h2>Files</h2><ul>` +
    items
      .map((it) => `<li><a href="/admin/outbox?file=${encodeURIComponent(it.file)}">${esc(it.file)}</a></li>`)
      .join('') +
    (items.length ? '' : '<li>Outbox is empty.</li>') +
    `</ul>`;
  res.send(adminViews.adminLayout('Outbox', adminViews.outboxHtml(items) + links));
});

app.get('/admin/suppressions', ah(async (req, res) => {
  const list = await db.all('SELECT * FROM suppressions ORDER BY ts DESC');
  const mapped = list.map((s) => ({ email: s.email, reason: s.reason, created_at: fmtTs(s.ts) }));
  res.send(adminViews.adminLayout('Suppressions', adminViews.suppressionsHtml(mapped)));
}));

async function addSuppression(req, res) {
  const emailAddr = (req.body.email || '').trim().toLowerCase();
  const reason = (req.body.reason || 'manual').trim() || 'manual';
  if (emailAddr && EMAIL_RE.test(emailAddr)) {
    await db.run('INSERT OR IGNORE INTO suppressions (email, reason, ts) VALUES (?, ?, ?)', [emailAddr, reason, Date.now()]);
    const lead = await db.get('SELECT * FROM leads WHERE email = ?', [emailAddr]);
    if (lead) {
      await tags.addTag(lead.id, 'SUPPRESSED');
      await db.run("UPDATE email_queue SET status = 'cancelled', cancel_reason = 'suppressed' WHERE lead_id = ? AND status = 'queued'", [lead.id]);
    }
  }
  res.redirect('/admin/suppressions');
}
app.post('/admin/suppressions', ah(addSuppression)); // shape used by views/admin.js
app.post('/admin/suppressions/add', ah(addSuppression));
app.post('/admin/suppressions/remove', ah(async (req, res) => {
  const emailAddr = (req.body.email || '').trim().toLowerCase();
  if (emailAddr) await db.run('DELETE FROM suppressions WHERE email = ?', [emailAddr]);
  res.redirect('/admin/suppressions');
}));

app.get('/admin/config', (req, res) => {
  res.send(
    adminViews.adminLayout(
      'Config',
      adminViews.configEditorHtml(config.getProducts(), config.getEmails(), config.getSite())
    )
  );
});

app.post('/admin/config/:file', (req, res) => {
  const file = req.params.file;
  if (!config.ALLOWED_FILES.includes(file)) {
    return res.status(400).json({ ok: false, error: `unknown config file (allowed: ${config.ALLOWED_FILES.join(', ')})` });
  }
  const raw = req.body.json || req.body.content || req.body.data;
  if (typeof raw !== 'string') {
    return res.status(400).json({ ok: false, error: 'request body must include the JSON document (field "json")' });
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    return res.status(400).json({ ok: false, error: `invalid JSON: ${err.message}` });
  }
  try {
    config.saveConfig(file, obj);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
  res.json({ ok: true, file });
});

app.post('/admin/run-scheduler', ah(async (req, res) => {
  const result = await automation.runSchedulerPass();
  res.json({ ok: true, ...result });
}));

app.post('/admin/mark-paid', ah(async (req, res) => {
  const emailAddr = (req.body.email || '').trim().toLowerCase();
  const leadId = parseInt(req.body.lead_id, 10);
  const productId = (req.body.product_id || '').trim();
  let lead = Number.isInteger(leadId) && leadId > 0 ? await db.get('SELECT * FROM leads WHERE id = ?', [leadId]) : null;
  if (!lead && emailAddr) lead = await db.get('SELECT * FROM leads WHERE email = ?', [emailAddr]);
  if (!lead || !productId) {
    return res.status(400).json({ ok: false, error: 'lead (lead_id or email) and product_id are required' });
  }
  const next = await recordPurchase(lead.id, productId, 'manual');
  res.json({ ok: true, lead_id: lead.id, product_id: productId, next });
}));

// --- Scheduler --------------------------------------------------------------------------
setInterval(() => {
  automation.runSchedulerPass().then((r) => {
    if (r.sent || r.cancelled || r.abandonedCarts) {
      console.log(`[scheduler] sent=${r.sent} cancelled=${r.cancelled} abandoned=${r.abandonedCarts}`);
    }
  }).catch((err) => {
    console.error('[scheduler] pass failed:', err);
  });
}, 60000);

// --- Boot ---------------------------------------------------------------------------------
automation.runSchedulerPass().then((boot) => {
  if (boot.sent || boot.cancelled || boot.abandonedCarts) {
    console.log(`[boot] scheduler catch-up: sent=${boot.sent} cancelled=${boot.cancelled} abandoned=${boot.abandonedCarts}`);
  }
}).catch((err) => {
  console.error('[boot] scheduler catch-up failed:', err);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Funnel backend listening on http://localhost:${PORT} (paymentMode=${config.getSite().paymentMode})`);
  if (ADMIN_TOKEN !== 'changeme') console.log('Admin panel: /admin?token=<ADMIN_TOKEN>');
});

module.exports = app;
