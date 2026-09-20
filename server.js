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
const crypto = require('crypto');

const db = require('./lib/db');
const config = require('./lib/config');
const tags = require('./lib/tags');
const tracking = require('./lib/tracking');
const automation = require('./lib/automation');
const room = require('./lib/room');
const roomViews = require('./views/room');
const roomFunnelViews = require('./views/room-funnel');
// TransitNow Driver Operations Platform (additive; existing routes untouched).
const drivers = require('./lib/drivers');
const driverViews = require('./views/drivers');
const driverAdminViews = require('./views/driver-admin');

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

/**
 * Site config override for Wealth Builder's Room pages. The Room is Davena's
 * own membership product, so its pages carry Room branding while keeping the
 * same real contact details (phone/email) for support and cancellation.
 */
function roomSite() {
  const site = config.getSite();
  return {
    ...site,
    businessName: "Wealth Builder's Room",
    tagline: 'Turn your ideas, skills, and opportunities into income, businesses, and wealth.',
    footerNote:
      "Wealth-building education for informational and educational purposes — not individualized financial, legal, tax, or investment advice. We do not guarantee income or results.",
  };
}

// --- Foundational community seed posts -------------------------------------------------------
// Posted once at boot by seedRoomPosts(); each title is checked first so
// reboots and redeploys never duplicate them. Copy: welcoming, practical,
// no income promises, no hype.
const SEED_POSTS = [
  {
    title: "START HERE — Welcome to the Wealth Builder's Room",
    body: `Welcome in. I'm Davena, and I built this Room for one reason: to help you turn the ideas, skills, opportunities, and resources you already have into organized action.

WHAT THIS ROOM IS: practical wealth-building education, a 90-day action plan, and a community of people doing the work alongside you — with accountability built in.

WHAT IT IS NOT: it is not get-rich-quick, and nothing here is a promise of income or results. This is education and action planning. What you build is up to you.

HOW TO USE IT:
1. Work the classroom in order: 00 Start Here → 01 → 02 → 03 → 04.
2. Introduce yourself in the community (see below).
3. Choose ONE 90-day goal — just one.
4. Check the 90-day plan each week and mark your actions done.
5. Ask questions anytime. There are no dumb questions here — only unasked ones.
6. Show up consistently. Thirty focused minutes beats five scattered hours.

👇 Introduce yourself below and tell us ONE thing you're building right now.`,
  },
  {
    title: 'Your First Wealth-Building Assignment',
    body: `Before you build anything new, take inventory of what you already have. Most people skip this step — don't. Grab a notebook and write down honest answers:

1. What do you already know how to do?
2. What problem can you solve for someone?
3. What resources do you already have? (skills, tools, time, relationships, savings — all of it counts)
4. What opportunity is currently sitting in front of you?
5. What would you like to accomplish in the next 90 days?

Your answers to 1–4 are your raw materials. Your answer to #5 becomes your target.

👇 Post your answer to #5 in the comments.`,
  },
  {
    title: 'Choose ONE 90-Day Goal',
    body: `Here is the rule that changes everything: ONE primary goal for the next 90 days. Not ten projects. One outcome you're organizing your weeks around.

Why? Because scattered effort produces scattered results. Focused effort compounds.

Examples of strong 90-day goals:
- Launch a service and get your first paying customer
- Create a clear business offer and a simple sales system
- Organize your personal cash flow (know every dollar in and out)
- Start an ownership and investing education plan

Pick the one that moves your life the most, write it down, and put it in the 90-day plan. You can always choose a new goal next quarter — that's the point of the system.

👇 Comment with your ONE 90-day goal.`,
  },
  {
    title: 'Money Is a System — Start With Cash Flow',
    body: `Everything in wealth-building starts with the same foundation: knowing where your money goes.

Cash flow is simply money in minus money out. When you track it, you find leaks to plug and gaps to fill. When you don't, money disappears and you can't say where it went.

That's why Section 02 of the classroom — Money Management & Cash Flow — comes before investing, assets, and ownership. Defense before offense. Know your numbers, give every dollar a job, pay yourself first (even a small amount), and build from there.

👇 This week's mini-assignment: write down every dollar you spent in the last 7 days. Just observe. Awareness first, judgment later.`,
  },
  {
    title: 'From Idea → Income → Ownership',
    body: `Here is the framework this entire Room is built on. Three stages, in order:

IDEA → You start with what you have: skills, knowledge, resources, opportunities. You organize them into a clear offer and a 90-day plan.

INCOME → You turn the offer into cash flow: first customer, then repeatable sales, then systems that don't depend on your constant hustle.

OWNERSHIP → You convert income into assets: savings that work, investments you understand, a business you own — things that grow beyond one paycheck.

Most people try to skip to ownership. This Room walks you through the stages in order, with education, action steps, and accountability at each one.

👇 Where are you right now: IDEA, INCOME, or OWNERSHIP? Comment below.`,
  },
];

/** Idempotent: insert any seed post whose title isn't already present. */
async function seedRoomPosts() {
  for (const p of SEED_POSTS) {
    await seedOnePost(p, true);
  }
  for (const p of ACCOUNTABILITY_POSTS) {
    await seedOnePost(p, false);
  }
}

async function seedOnePost(p, pin) {
  let row = await db.get('SELECT id, pinned FROM room_posts WHERE title = ?', [p.title]);
  if (!row) {
    const newId = await room.createPost({
      authorEmail: 'admin',
      authorName: 'Davena',
      kind: 'post',
      title: p.title,
      body: p.body,
    });
    row = { id: newId != null ? Number(newId) : null, pinned: 0 };
    console.log('[boot] seeded room post:', p.title);
  }
  // Foundational posts stay pinned so new members see them first;
  // weekly accountability posts stay unpinned so the feed stays readable.
  if (row && row.id && pin && !row.pinned) {
    await room.setPinned(row.id, true);
  }
}

// --- Weekly accountability community posts -------------------------------------------------
// One per week of the 90-day journey. Seeded once at boot by seedRoomPosts()
// (idempotent by title, never pinned). Each gives the week's theme, a concrete
// action, and a pointer to the weekly check-in. Encouraging, never shaming;
// no income promises.
const ACCOUNTABILITY_POSTS = [
  {
    title: 'WEEK 1 — SHOW US YOUR STARTING POINT',
    body: `Week 1 is about honesty, not impressiveness. Before you can measure progress, you need a starting point you told the truth about.\n\nTHIS WEEK'S ACTION: set your ONE 90-day goal (Dashboard → "Set My 90-Day Goal") and complete your first Proof of Progress check-in. Write down where you are right now — money in, money out, skills, time — without judging it.\n\nComplete your check-in from the My Progress page: /room/progress\n\nEveryone starts somewhere. Starting honestly is the bravest move there is. 👇 Reply with the ONE thing you're focusing on for the next 90 days.`,
  },
  {
    title: 'WEEK 2 — SHOW US YOUR FIRST MOVE',
    body: `Ideas are cheap; the first move is everything. Week 2 is about turning your goal into one real-world action — small counts.\n\nTHIS WEEK'S ACTION: take ONE concrete step toward your goal (send the email, open the account, write the page, make the list), then document it in your weekly check-in.\n\nComplete your check-in from the My Progress page: /room/progress\n\nIt doesn't have to be big. It has to be real. 👇 What was your first move?`,
  },
  {
    title: 'WEEK 3 — SHOW US WHAT YOU EXECUTED',
    body: `Week 3 separates planners from executors. Look back at what you said you'd do — then look at what actually got done.\n\nTHIS WEEK'S ACTION: in your check-in, compare last week's commitment to this week's reality. No spin. If you did it, say so. If you didn't, say why — that's data, not failure.\n\nComplete your check-in from the My Progress page: /room/progress\n\nExecution is a skill, and skills grow with reps. 👇 What did you execute this week?`,
  },
  {
    title: 'WEEK 4 — WHAT WORKED? WHAT DIDN\'T?',
    body: `One month in. Week 4 is a review week: keep what's working, name what isn't, and adjust without drama.\n\nTHIS WEEK'S ACTION: in your check-in's "lesson" section, write one thing that worked and one thing that didn't. Then make next week's commitment a fix for the thing that didn't.\n\nComplete your check-in from the My Progress page: /room/progress\n\nA system you adjust beats a perfect plan you abandon. 👇 What worked — and what didn't?`,
  },
  {
    title: 'WEEK 5 — WHAT ARE YOU CHANGING?',
    body: `If week 4 showed you something that isn't working, week 5 is when you change it. Same actions, same results — so change an action.\n\nTHIS WEEK'S ACTION: pick ONE thing to do differently this week (a new time block, a different approach, a smaller step) and put it in your check-in as your commitment.\n\nComplete your check-in from the My Progress page: /room/progress\n\nChange is uncomfortable and necessary. You're doing it anyway. 👇 What are you changing this week?`,
  },
  {
    title: 'WEEK 6 — WHAT ARE YOU BUILDING NOW?',
    body: `Halfway to the midpoint. Week 6 is about building — turning repeated actions into something with structure: an offer, a system, a habit, a body of work.\n\nTHIS WEEK'S ACTION: name the ONE thing you're actively building right now and take one building-block step toward it. Document it with proof if you can (a screenshot of the page, the draft, the list).\n\nComplete your check-in from the My Progress page: /room/progress\n\nBrick by brick is still building. 👇 What are you building now?`,
  },
  {
    title: 'WEEK 7 — WHAT DID YOU FOLLOW THROUGH ON?',
    body: `Follow-through is the rarest skill in the room. Week 7 is about finishing what you started — especially the unglamorous middle parts.\n\nTHIS WEEK'S ACTION: revisit an old commitment from a previous check-in that slipped. Do it this week, or consciously replace it. Either way, write the truth in your check-in.\n\nComplete your check-in from the My Progress page: /room/progress\n\nNobody's keeping score but you — and you're worth following through for. 👇 What did you follow through on?`,
  },
  {
    title: 'WEEK 8 — WHAT CAN YOU IMPROVE?',
    body: `Good enough got you here; better takes you further. Week 8 is about one upgrade — to a system, a skill, or a standard.\n\nTHIS WEEK'S ACTION: pick one thing you're already doing and make it 10% better (clearer offer, tighter budget tracking, faster follow-up). Small improvements compound.\n\nComplete your check-in from the My Progress page: /room/progress\n\nYou don't need a new plan. You need a sharper one. 👇 What are you improving?`,
  },
  {
    title: 'WEEK 9 — WHAT ARE YOU READY TO EXPAND?',
    body: `What's working deserves more fuel. Week 9 is about expansion: do more of what's producing results, and give it structure so it scales.\n\nTHIS WEEK'S ACTION: identify your highest-leverage action so far and commit to expanding it next week — more reps, a simple system around it, or teaching it to someone else.\n\nComplete your check-in from the My Progress page: /room/progress\n\nDouble down on what works. 👇 What are you ready to expand?`,
  },
  {
    title: 'WEEK 10 — WHAT SYSTEM ARE YOU STRENGTHENING?',
    body: `Motivation fades; systems stay. Week 10 is about making your progress less dependent on willpower — checklists, calendars, automatic transfers, templates.\n\nTHIS WEEK'S ACTION: strengthen ONE system (money tracking, weekly review, content routine, savings habit) and describe it in your check-in.\n\nComplete your check-in from the My Progress page: /room/progress\n\nBuild the machine that builds the results. 👇 What system are you strengthening?`,
  },
  {
    title: 'WEEK 11 — WHAT NEEDS TO BE COMPLETED?',
    body: `Almost there. Week 11 is for finishing: close the open loops, complete the half-done items, and clear the deck before your final week.\n\nTHIS WEEK'S ACTION: list every open item tied to your 90-day goal. Complete as many as you can this week — and be honest in your check-in about what stays open.\n\nComplete your check-in from the My Progress page: /room/progress\n\nFinishers are made in weeks like this one. 👇 What needs to be completed?`,
  },
  {
    title: 'WEEK 12 — WHAT CHANGED IN YOUR 90 DAYS?',
    body: `You made it to week 12. Whatever happened — wins, stalls, restarts — you showed up, and that counts.\n\nTHIS WEEK'S ACTION: complete your final weekly check-in, then do your 90-Day Wealth Review (My Progress page → "Start My 90-Day Review"). Read your week 1 check-in next to your week 12 check-in and notice the distance.\n\nComplete your check-in from the My Progress page: /room/progress\n\nThen set your NEXT 90-day goal. This is a practice, not a one-time event.\n\n👇 Tell us: what changed in your 90 days?`,
  },
];

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
  const goal = (fields.goal || '').trim() || null;
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
         offer_of_interest = COALESCE(offer_of_interest, ?),
         goal = COALESCE(?, goal)
       WHERE id = ?`,
      [firstName, firstName, phone, req.vid, src, cmp, product.id, goal, lead.id]
    );
    if (consent !== null && consent !== undefined) {
      await db.run('UPDATE leads SET consent_marketing = ?, consent_ts = ? WHERE id = ?', [consent, now, lead.id]);
    }
    lead = await db.get('SELECT * FROM leads WHERE id = ?', [lead.id]);
  } else {
    const info = await db.run(
      `INSERT INTO leads
         (visitor_id, first_name, email, phone, source, campaign, offer_of_interest, goal,
          consent_marketing, consent_ts, date_captured, status, unsubscribed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'lead', 0)`,
      [req.vid, firstName || null, emailAddr, phone, src, cmp, product.id, goal,
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
// Capture the raw JSON body: Stripe webhook signature verification MUST run
// against the exact raw bytes, not the re-serialized parsed object.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
})); // webhooks use JSON; forms use urlencoded
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
  await db.recordEvent({
    visitor_id: req.vid, lead_id: lead.id, type: 'lead_submitted',
    product_id: product.id, meta: { source: lead.source || null },
  });
  await automation.scheduleSequence(lead.id, product.id, product.id === 'room' ? 'roomNurture' : 'nurture');
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

// --- Wealth Builder's Room checkout ---------------------------------------------------------
// The Room is sold through Davena's own $49/month Stripe payment link
// (no Skool, no demo flow). This route sends buyers straight to checkout.
function roomCheckoutRedirect(req, res) {
  const product = config.getProduct('room');
  if (product && product.stripeLink) return res.redirect(302, product.stripeLink);
  const site = config.getSite();
  return page(res, 'Checkout', pages.checkoutPage(site, product, null, site.paymentMode), site);
}
app.get('/checkout/room', (req, res) => roomCheckoutRedirect(req, res));
app.post('/checkout/room', (req, res) => roomCheckoutRedirect(req, res));

// --- Wealth Builder's Room lead funnel -----------------------------------------------------------
// Dedicated lead → offer → checkout journey for the $49/month Room membership.
// The /checkout/room direct-Stripe route above stays for compatibility; the
// funnel below captures the lead and cart first, then redirects to the SAME
// unchanged Stripe payment link.
app.get('/room/join', ah(async (req, res) => {
  const site = roomSite();
  await db.recordEvent({ visitor_id: req.vid, type: 'landing_page_view', product_id: 'room', meta: { path: '/room/join' } });
  page(res, "Join the Wealth Builder's Room", pages.roomJoinPage(site), site);
}));

app.get('/room/start', (req, res) => {
  const site = roomSite();
  page(res, 'Start building', pages.roomStartPage(site, req.query, null), site);
});

app.post('/room/start', ah(async (req, res) => {
  const site = roomSite();
  const product = config.getProduct('room');
  const firstName = (req.body.first_name || '').trim();
  const emailAddr = (req.body.email || '').trim().toLowerCase();
  if (!firstName || !EMAIL_RE.test(emailAddr)) {
    res.status(400);
    return page(
      res, 'Start building',
      pages.roomStartPage(site, req.query, 'Please enter your first name and a valid email address.'),
      site
    );
  }
  const consent =
    req.body.consent !== undefined
      ? req.body.consent === 'yes' || req.body.consent === 'on' || req.body.consent === '1' ? 1 : 0
      : 0;
  const lead = await identifyLead(
    req, res,
    {
      first_name: firstName, email: emailAddr, phone: req.body.phone,
      source: req.body.source, campaign: req.body.campaign, goal: req.body.goal,
    },
    product, consent
  );
  await tags.addTag(lead.id, 'NEW_LEAD');
  await tags.addTag(lead.id, 'OFFER_room_LEAD');
  await db.recordEvent({
    visitor_id: req.vid, lead_id: lead.id, type: 'LEAD_SUBMITTED',
    product_id: 'room', meta: { source: lead.source || null, goal: lead.goal || null },
  });
  await db.recordEvent({
    visitor_id: req.vid, lead_id: lead.id, type: 'lead_submitted',
    product_id: 'room', meta: { source: lead.source || null, goal: lead.goal || null },
  });
  await automation.scheduleSequence(lead.id, 'room', 'roomNurture');
  res.redirect('/room/offer');
}));

app.get('/room/offer', ah(async (req, res) => {
  const site = roomSite();
  const lead = await leadFromReq(req);
  await db.recordEvent({
    visitor_id: req.vid, lead_id: lead ? lead.id : null,
    type: 'offer_viewed', product_id: 'room', meta: { path: '/room/offer' },
  });
  page(res, "Wealth Builder's Room", pages.roomOfferPage(site), site);
}));

app.get('/room/checkout', (req, res) => {
  const site = roomSite();
  const product = config.getProduct('room');
  page(res, 'Checkout', roomFunnelViews.roomCheckoutPage({ product, site }), site);
});

app.post('/room/checkout', ah(async (req, res) => {
  const product = config.getProduct('room');
  const emailAddr = (req.body.email || '').trim().toLowerCase();
  const firstName = (req.body.first_name || '').trim();
  if (!EMAIL_RE.test(emailAddr)) {
    const site = roomSite();
    res.status(400);
    return page(
      res, 'Checkout',
      '<section><h1>Checkout</h1><p class="form-error">Please enter a valid email address to continue.</p>' +
        '<p><a class="btn" href="/room/checkout">Back to checkout</a></p></section>',
      site
    );
  }
  const lead = await identifyLead(
    req, res,
    { first_name: firstName, email: emailAddr, phone: req.body.phone, source: req.body.source, campaign: req.body.campaign },
    product,
    null // checkout doesn't change marketing consent
  );
  await db.run(
    'INSERT INTO carts (lead_id, visitor_id, product_id, started_at, purchased, recovered) VALUES (?, ?, ?, ?, 0, 0)',
    [lead.id, req.vid, 'room', Date.now()]
  );
  await tags.addTag(lead.id, 'STARTED_CHECKOUT');
  await tags.addTag(lead.id, 'HIGH_INTENT');
  await db.recordEvent({ visitor_id: req.vid, lead_id: lead.id, type: 'CHECKOUT_STARTED', product_id: 'room' });
  await db.recordEvent({ visitor_id: req.vid, lead_id: lead.id, type: 'checkout_started', product_id: 'room' });
  if (product.stripeLink) {
    return res.redirect(302, product.stripeLink); // cart stays open for abandonment tracking
  }
  const site = roomSite();
  return page(res, 'Checkout', '<section><h1>Checkout</h1><p>Checkout is not configured yet — please contact us for help.</p></section>', site);
}));

// Post-Stripe landing: the Room Stripe payment link's success URL should point
// here so buyers get claim instructions (supports ?p=room and other products).
// Note: payment_success is recorded by the Stripe webhook (real money), not by
// this page view — loading this page does not prove a payment happened.
app.get('/payment-success', ah(async (req, res) => {
  const site = roomSite();
  const product = config.getProduct(req.query.p || 'room');
  page(res, 'Payment successful', roomFunnelViews.paymentSuccessPage({ product }), site);
}));

// Legal + contact pages (linked from the site footer).
app.get('/terms', (req, res) => page(res, 'Terms of Service', pages.termsPage(config.getSite()), config.getSite()));
app.get('/refund', (req, res) => page(res, 'Refund & Cancellation Policy', pages.refundPage(config.getSite()), config.getSite()));
app.get('/contact', (req, res) => page(res, 'Contact', pages.contactPage(config.getSite()), config.getSite()));

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

// --- The Wealth Builder's Room (membership community) ----------------------------------------
// Member auth: email + password with an httpOnly session cookie (`room_sess`).
async function roomMemberFromReq(req) {
  const cookies = (req.cookies || tracking.getCookies(req));
  return room.getSessionMember(cookies[room.SESSION_COOKIE]);
}

/** Guard: redirect unauthenticated visitors to the member login. */
function requireRoomMember(handler) {
  return ah(async (req, res, next) => {
    const member = await roomMemberFromReq(req);
    if (!member) return res.redirect('/room/login');
    req.roomMember = member;
    return handler(req, res, next);
  });
}

/** Middleware form of the guard, for routes that need extra middleware first. */
const requireRoomMemberMw = ah(async (req, res, next) => {
  const member = await roomMemberFromReq(req);
  if (!member) return res.redirect('/room/login');
  req.roomMember = member;
  next();
});

function setRoomSession(res, token) {
  tracking.setCookie(res, room.SESSION_COOKIE, token, { maxAge: room.SESSION_TTL_MS / 1000 });
}

function clearRoomSession(res) {
  tracking.setCookie(res, room.SESSION_COOKIE, '', { maxAge: 0 });
}

// Login
app.get('/room/login', (req, res) => {
  res.send(roomViews.loginPage({ error: req.query.error ? 'Please log in to continue.' : null, email: '' }));
});

app.post('/room/login', ah(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const member = await room.getMember(email);
  if (!member || member.status !== 'active' || !member.password_hash) {
    return res.send(roomViews.loginPage({
      error: 'We could not find an active membership for that email. If you just paid, claim your access first.',
      email,
    }));
  }
  if (!room.verifyPassword(password, member.password_hash)) {
    return res.send(roomViews.loginPage({ error: 'Incorrect password. Please try again.', email }));
  }
  setRoomSession(res, await room.createSession(email));
  res.redirect('/room');
}));

// Claim access (first-time: member paid via Stripe, now sets a password).
// Served at both /room/claim and the /claim-access alias.
function claimGetHandler(req, res) {
  res.send(roomViews.claimPage({}));
}

const claimPostHandler = ah(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const password2 = req.body.password2 || '';
  const fail = (error) => res.send(roomViews.claimPage({ error, email }));
  if (!EMAIL_RE.test(email)) return fail('Please enter a valid email address.');
  const member = await room.getMember(email);
  if (!member || member.status !== 'active') {
    return fail('We could not find a paid membership for that email yet. Make sure you use the email you paid with — and that your Stripe payment finished.');
  }
  if (member.password_hash) {
    return fail('This email already claimed access. Please log in instead.');
  }
  if (password.length < 8) return fail('Please choose a password of at least 8 characters.');
  if (password !== password2) return fail('The two passwords do not match.');
  await room.setMemberPassword(email, password);
  // Optional SMS opt-in: a bad phone number is ignored, never fails the claim.
  await room.setMemberPhone(email, req.body.phone);
  const leadRow = await db.get('SELECT id FROM leads WHERE email = ?', [email]);
  await db.recordEvent({
    lead_id: leadRow ? leadRow.id : null,
    type: 'membership_claimed', product_id: 'room', meta: { email },
  });
  setRoomSession(res, await room.createSession(email));
  res.redirect('/room/welcome');
});

app.get('/room/claim', claimGetHandler);
app.post('/room/claim', claimPostHandler);
app.get('/claim-access', claimGetHandler);
app.post('/claim-access', claimPostHandler);

// One-time onboarding, shown right after a successful claim (and once for
// members who claimed before this page existed). Skipped once `onboarded`.
app.get('/room/welcome', requireRoomMember(async (req, res) => {
  const fresh = await room.getMember(req.roomMember.email);
  if (fresh && fresh.onboarded) return res.redirect('/room');
  res.send(roomViews.welcomePage({ member: req.roomMember }));
}));

app.post('/room/welcome', requireRoomMember(async (req, res) => {
  await db.run('UPDATE room_members SET onboarded = 1 WHERE email = ?', [req.roomMember.email]);
  res.redirect('/room');
}));

app.get('/room/logout', ah(async (req, res) => {
  const cookies = req.cookies || tracking.getCookies(req);
  await room.destroySession(cookies[room.SESSION_COOKIE]);
  clearRoomSession(res);
  res.redirect('/');
}));

// Dashboard
app.get('/room', requireRoomMember(async (req, res) => {
  const fresh = await room.getMember(req.roomMember.email);
  if (fresh && !fresh.onboarded) return res.redirect('/room/welcome');
  const leadRow = await db.get('SELECT id FROM leads WHERE email = ?', [req.roomMember.email]);
  await db.recordEvent({
    lead_id: leadRow ? leadRow.id : null,
    type: 'room_entered', product_id: 'room', meta: { path: '/room' },
  });
  const plan = room.getPlan();
  const progress = await room.getProgress(req.roomMember.email);
  const total = plan.weeks.reduce((n, w) => n + w.actions.length, 0);
  const done = Object.values(progress).filter(Boolean).length;
  const announcements = await db.all(
    "SELECT * FROM room_posts WHERE kind = 'announcement' ORDER BY created_at DESC LIMIT 3"
  );
  const goal = await room.getGoal(req.roomMember.email);
  const info = goal ? await room.weekInfo(req.roomMember.email) : null;
  const thisWeekCheckin = info ? await room.getCheckin(req.roomMember.email, info.currentWeek) : null;
  res.send(roomViews.dashboardPage({
    member: req.roomMember,
    progress: { total, done, pct: total ? Math.round((done / total) * 100) : 0 },
    announcements,
    goal,
    weekInfo: info,
    checkinDone: !!thisWeekCheckin,
  }));
}));

// Classroom
app.get('/room/classroom', requireRoomMember(async (req, res) => {
  res.send(roomViews.classroomIndexPage({ member: req.roomMember, pillars: room.getPillars() }));
}));

app.get('/room/classroom/:pillar', requireRoomMember(async (req, res) => {
  // Old 7-pillar URLs redirect to their new section (301, permanent).
  const redirectTo = room.PILLAR_REDIRECTS && room.PILLAR_REDIRECTS[req.params.pillar];
  if (redirectTo) return res.redirect(301, '/room/classroom/' + redirectTo);
  const pillars = room.getPillars();
  const idx = pillars.findIndex((p) => p.id === req.params.pillar);
  if (idx < 0) return res.status(404).send(roomViews.roomLayout({ title: 'Not found', member: req.roomMember, body: '<h1>Lesson not found</h1><p><a href="/room/classroom">Back to the classroom</a></p>' }));
  const pillar = room.getPillar(pillars[idx].id);
  if (!pillar) return res.status(404).send(roomViews.roomLayout({ title: 'Not found', member: req.roomMember, body: '<h1>Lesson not found</h1><p><a href="/room/classroom">Back to the classroom</a></p>' }));
  res.send(roomViews.pillarPage({
    member: req.roomMember,
    pillar,
    index: idx,
    prev: idx > 0 ? pillars[idx - 1] : null,
    next: idx < pillars.length - 1 ? pillars[idx + 1] : null,
  }));
}));

// 90-day plan
app.get('/room/plan', requireRoomMember(async (req, res) => {
  res.send(roomViews.planPage({
    member: req.roomMember,
    plan: room.getPlan(),
    progress: await room.getProgress(req.roomMember.email),
  }));
}));

app.post('/room/plan/toggle', requireRoomMember(async (req, res) => {
  const checked = req.body.checked === '1' || req.body.checked === 'on';
  await room.setProgress(req.roomMember.email, req.body.week, req.body.item, checked);
  res.redirect('/room/plan');
}));

// --- Accountability: 90-day goal ------------------------------------------------------------
app.get('/room/goal', requireRoomMember(async (req, res) => {
  const email = req.roomMember.email;
  const goal = await room.getGoal(email);
  const info = await room.weekInfo(email);
  res.send(roomViews.goalPage({ member: req.roomMember, goal, info, error: req.query.error || null }));
}));

app.post('/room/goal', requireRoomMember(async (req, res) => {
  const email = req.roomMember.email;
  const fail = (error) => res.send(roomViews.goalPage({
    member: req.roomMember,
    goal: { goal_text: req.body.goal_text || '' },
    info: null,
    error,
  }));
  try {
    await room.saveGoal(email, req.body.goal_text || '');
  } catch (err) {
    return fail(err.message);
  }
  await db.recordEvent({ lead_id: null, type: 'room_goal_set', product_id: 'room', meta: { email } });
  res.redirect('/room/progress');
}));

// --- Accountability: weekly Proof of Progress -----------------------------------------------
const multipart = require('./lib/multipart');
const PROOF_ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];

app.get('/room/checkin', requireRoomMember(async (req, res) => {
  const email = req.roomMember.email;
  const goal = await room.getGoal(email);
  if (!goal) return res.redirect('/room/goal');
  const info = await room.weekInfo(email);
  const existing = await room.getCheckin(email, info.currentWeek);
  const readonly = !!existing && req.query.edit !== '1';
  res.send(roomViews.checkinPage({
    member: req.roomMember,
    goal,
    info,
    existing,
    readonly,
    error: req.query.error || null,
  }));
}));

// Note: express.raw() on this route only — the global urlencoded/json parsers
// skip multipart bodies, leaving the stream for the raw parser. 10 MB cap;
// the multipart parser enforces 8 MB per file.
app.post('/room/checkin',
  requireRoomMemberMw,
  express.raw({ type: 'multipart/form-data', limit: '10mb' }),
  ah(async (req, res) => {
  const email = req.roomMember.email;
  const goal = await room.getGoal(email);
  if (!goal) return res.redirect('/room/goal');
  const info = await room.weekInfo(email);
  const fail = (error) => res.send(roomViews.checkinPage({
    member: req.roomMember, goal, info, existing: null, readonly: false, error,
  }));
  let fields, file;
  try {
    ({ fields, file } = multipart.parseMultipart(req, { maxFileBytes: 8 * 1024 * 1024, allowedMimes: PROOF_ALLOWED_MIMES }));
  } catch (err) {
    return fail(err.message);
  }
  if (file && fields.proof_confirm !== '1' && fields.proof_confirm !== 'on') {
    return fail('Please check the box confirming your proof contains no sensitive personal information.');
  }
  let proofMeta = null;
  let savedCheckin = null;
  try {
    if (file) {
      proofMeta = { name: file.originalName, mime: file.mime, size: file.size, buffer: file.buffer };
    }
    savedCheckin = await room.saveCheckin(email, info.currentWeek, fields, proofMeta);
    await db.recordEvent({
      lead_id: null, type: 'room_checkin_submitted', product_id: 'room',
      meta: { email, week: info.currentWeek, proof: !!file },
    });
    await automation.queueCheckinConfirmation(email, savedCheckin.id);
  } catch (err) {
    return fail(err.message);
  }
  res.redirect('/room/progress?notice=' + encodeURIComponent("Check-in saved. Progress documented — keep going."));
}));

// --- Accountability: 12-week progress tracker -------------------------------------------------
app.get('/room/progress', requireRoomMember(async (req, res) => {
  const email = req.roomMember.email;
  const goal = await room.getGoal(email);
  if (!goal) return res.redirect('/room/goal');
  const [info, stats, checkins, review] = await Promise.all([
    room.weekInfo(email),
    room.progressStats(email),
    room.listCheckins(email),
    room.getReview(email),
  ]);
  res.send(roomViews.progressPage({
    member: req.roomMember, goal, info, stats, checkins, review,
    notice: req.query.notice || null,
  }));
}));

// --- Accountability: member mobile number for daily text nudges -------------------------------
// An empty or invalid number is ignored (existing number is kept); it never fails.
app.post('/room/phone', requireRoomMember(async (req, res) => {
  await room.setMemberPhone(req.roomMember.email, req.body.phone);
  res.redirect('/room/progress?notice=' + encodeURIComponent('Mobile number saved. You will get the daily nudge by text too.'));
}));

// --- Accountability: private proof files ---------------------------------------------------------
// Proof bytes live in the database (room_checkins.proof_blob) so they persist
// with member data across restarts/redeploys. Served only to the owning member.
app.get('/room/proof/:id', requireRoomMember(async (req, res) => {
  const checkin = await room.getCheckinById(req.params.id);
  if (!checkin || checkin.email !== req.roomMember.email || !checkin.proof_blob) {
    return res.status(404).send(roomViews.roomLayout({
      title: 'Not found', member: req.roomMember,
      body: '<h1>Proof not found</h1><p><a href="/room/progress">Back to My Progress</a></p>',
    }));
  }
  const data = Buffer.isBuffer(checkin.proof_blob) ? checkin.proof_blob : Buffer.from(checkin.proof_blob);
  res.setHeader('Content-Type', checkin.proof_mime || 'application/octet-stream');
  res.setHeader('Content-Length', data.length);
  res.setHeader('Content-Disposition', `inline; filename="${String(checkin.proof_name || 'proof').replace(/"/g, '')}"`);
  res.send(data);
}));

// --- Accountability: 90-day review ------------------------------------------------------------------
app.get('/room/review', requireRoomMember(async (req, res) => {
  const email = req.roomMember.email;
  const goal = await room.getGoal(email);
  if (!goal) return res.redirect('/room/goal');
  const [info, review] = await Promise.all([room.weekInfo(email), room.getReview(email)]);
  if (review && req.query.edit !== '1') {
    const checkins = await room.listCheckins(email);
    return res.send(roomViews.reviewSummaryPage({ member: req.roomMember, goal, info, review, checkins }));
  }
  res.send(roomViews.reviewPage({ member: req.roomMember, goal, info, review, error: req.query.error || null }));
}));

app.post('/room/review', requireRoomMember(async (req, res) => {
  const email = req.roomMember.email;
  const goal = await room.getGoal(email);
  if (!goal) return res.redirect('/room/goal');
  try {
    await room.saveReview(email, req.body || {});
  } catch (err) {
    const info = await room.weekInfo(email);
    return res.send(roomViews.reviewPage({ member: req.roomMember, goal, info, review: req.body, error: err.message }));
  }
  await db.recordEvent({ lead_id: null, type: 'room_review_completed', product_id: 'room', meta: { email } });
  const [info, review, checkins] = await Promise.all([
    room.weekInfo(email), room.getReview(email), room.listCheckins(email),
  ]);
  res.send(roomViews.reviewSummaryPage({ member: req.roomMember, goal, info, review, checkins }));
}));

// Community
app.get('/room/community', requireRoomMember(async (req, res) => {
  res.send(roomViews.communityPage({
    member: req.roomMember,
    posts: await room.listPosts(50),
    error: req.query.error || null,
    notice: req.query.notice || null,
  }));
}));

app.post('/room/community/post', requireRoomMember(async (req, res) => {
  const member = req.roomMember;
  try {
    await room.createPost({
      authorEmail: member.email,
      authorName: member.name || member.email.split('@')[0],
      kind: 'post',
      title: req.body.title || '',
      body: req.body.body || '',
    });
    res.redirect('/room/community?notice=' + encodeURIComponent('Posted!'));
  } catch (err) {
    res.redirect('/room/community?error=' + encodeURIComponent(err.message));
  }
}));

app.get('/room/community/post/:id', requireRoomMember(async (req, res) => {
  const post = await room.getPost(req.params.id);
  if (!post) return res.redirect('/room/community');
  res.send(roomViews.postPage({
    member: req.roomMember,
    post,
    comments: await room.listComments(post.id),
    error: req.query.error || null,
  }));
}));

app.post('/room/community/post/:id/comment', requireRoomMember(async (req, res) => {
  const member = req.roomMember;
  try {
    await room.createComment({
      postId: req.params.id,
      authorEmail: member.email,
      authorName: member.name || member.email.split('@')[0],
      body: req.body.body || '',
    });
  } catch (err) {
    return res.redirect(`/room/community/post/${encodeURIComponent(req.params.id)}?error=` + encodeURIComponent(err.message));
  }
  res.redirect(`/room/community/post/${encodeURIComponent(req.params.id)}`);
}));

// --- TransitNow Driver Operations Platform (additive; existing routes untouched)
// Phase A: driver onboarding — simple form, no login. Reachable post-payment
// (payment-success CTA) and via a direct link (/drivers/onboard?src=...).

/** Resolve the driver's source: ?src= wins, then the visitor's first-touch source. */
async function resolveDriverSource(req) {
  if (req.query.src) return drivers.normalizeSource(req.query.src);
  try {
    const v = await db.get('SELECT source FROM visitors WHERE id = ?', [req.vid]);
    if (v && v.source) return drivers.normalizeSource(v.source);
  } catch {
    // fall through to default
  }
  return 'direct';
}

app.get('/drivers/onboard', ah(async (req, res) => {
  const site = config.getSite();
  const source = await resolveDriverSource(req);
  page(res, 'Driver Onboarding', driverViews.onboardPage({ site, source }), site);
}));

app.post('/drivers/onboard', ah(async (req, res) => {
  const site = config.getSite();
  const { ok, errors, clean } = drivers.validateDriverInput(req.body || {});
  if (!ok) {
    res.status(400);
    const source = drivers.normalizeSource((req.body || {}).source || (await resolveDriverSource(req)));
    return page(
      res,
      'Driver Onboarding',
      driverViews.onboardPage({ site, source, prefill: req.body || {}, errors }),
      site
    );
  }
  // Preserve an explicit ?src= even when the form's hidden field is stale.
  if (req.query.src) clean.source = drivers.normalizeSource(req.query.src);
  const driver = await drivers.createOrUpdateDriver(clean);
  const dashUrl = drivers.driverDashUrl(driver.access_token);

  // Notifications via the existing outbox queue (Phase 19).
  await drivers.queueDriverEmail({
    to: driver.email,
    subject: 'TransitNow — we received your driver onboarding',
    html: drivers.onboardDriverEmail(driver, dashUrl),
    sequence: 'driver-ops',
    step: 'onboarding-confirmation',
  });
  await drivers.notifyOps(
    `New driver onboarding: ${driver.full_name}`,
    drivers.onboardOpsEmail(driver),
    'onboarding-new'
  );
  await db.recordEvent({
    visitor_id: req.vid || null,
    lead_id: req.leadId || null,
    type: 'driver_onboarded',
    product_id: null,
    meta: { driver_id: driver.id, source: driver.source },
  });

  page(res, 'Onboarding complete', driverViews.onboardDonePage({ site, driver, dashUrl }), site);
}));

// --- Phase B: admin driver pipeline -----------------------------------------
// NOTE: these routes are registered before app.use('/admin', adminAuth), so
// adminAuth is applied explicitly on each route (function is hoisted).
app.get('/admin/drivers', adminAuth, ah(async (req, res) => {
  const status = drivers.DRIVER_STATUSES.includes(req.query.status) ? req.query.status : null;
  const source = req.query.source ? drivers.normalizeSource(req.query.source) : null;
  const filters = { status, source: req.query.source ? source : null, search: req.query.q || '' };
  const [list, counts] = await Promise.all([
    drivers.listDrivers(filters),
    drivers.countDriversByStatus(),
  ]);
  res.send(adminViews.adminLayout('Driver Pipeline', driverAdminViews.driverPipelineHtml({ list, counts, status, source: req.query.source || '', q: req.query.q || '' })));
}));

app.get('/admin/drivers/:id', adminAuth, ah(async (req, res) => {
  const driver = await drivers.getDriverById(req.params.id);
  if (!driver) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Driver not found.</p>'));
  const history = await drivers.statusHistory(driver.id);
  res.send(adminViews.adminLayout('Driver: ' + driver.full_name, driverAdminViews.driverDetailHtml({ driver, history })));
}));

app.post('/admin/drivers/:id/status', adminAuth, ah(async (req, res) => {
  const driver = await drivers.getDriverById(req.params.id);
  if (!driver) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Driver not found.</p>'));
  const to = req.body.status;
  if (!drivers.DRIVER_STATUSES.includes(to)) {
    return res.status(400).send(adminViews.adminLayout('Error', '<p>Invalid status.</p>'));
  }
  await drivers.setDriverStatus(driver.id, to, {
    by: 'admin',
    note: req.body.note || '',
    notify: !!req.body.notify,
  });
  res.redirect(`/admin/drivers/${driver.id}`);
}));

app.post('/admin/drivers/:id/note', adminAuth, ah(async (req, res) => {
  const driver = await drivers.getDriverById(req.params.id);
  if (!driver) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Driver not found.</p>'));
  await drivers.addDriverNote(driver.id, req.body.note || '', 'admin');
  res.redirect(`/admin/drivers/${driver.id}`);
}));

// --- Phase C: private driver dashboard (token link, no login) ------------------
/** Look up the driver from :token. Drivers can only ever see their own data. */
async function requireDriver(req, res, next) {
  const driver = await drivers.getDriverByToken(req.params.token);
  if (!driver) {
    res.status(404);
    return page(res, 'Not found', '<section><h1>Link not found</h1><p class="subhead">This driver link is invalid or expired. Check the link from your onboarding email.</p></section>', config.getSite());
  }
  req.driver = driver;
  next();
}

app.get('/d/:token', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const dashUrl = drivers.driverDashUrl(driver.access_token);
  page(res, 'My dashboard', driverViews.dashboardPage({ site, driver, dashUrl }), site);
}));

// --- Phase D: driver route + packages (scoped to the token's driver) -------------
app.get('/d/:token/route', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const route = await drivers.getCurrentRoute(driver.id);
  const packages = route ? await drivers.listPackages({ routeId: route.id }) : [];
  page(res, 'My route', driverViews.driverRoutePage({ site, driver, route, packages }), site);
}));

app.get('/d/:token/packages', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const packages = await drivers.listPackages({ driverId: driver.id });
  page(res, 'My packages', driverViews.driverPackagesPage({ site, driver, packages }), site);
}));

// --- Phase D: admin routes + packages ------------------------------------------
app.get('/admin/routes', adminAuth, ah(async (req, res) => {
  const routes = await drivers.listRoutes();
  const ids = [...new Set(routes.map((r) => r.driver_id).filter(Boolean))];
  const driversById = {};
  for (const id of ids) driversById[id] = await drivers.getDriverById(id);
  res.send(adminViews.adminLayout('Routes', driverAdminViews.routeListHtml({ routes, driversById })));
}));

app.get('/admin/routes/new', adminAuth, ah(async (req, res) => {
  const list = await drivers.listDrivers({ limit: 500 });
  res.send(adminViews.adminLayout('New route', driverAdminViews.routeNewHtml({ list, preselectDriverId: req.query.driver_id })));
}));

app.post('/admin/routes', adminAuth, ah(async (req, res) => {
  try {
    const route = await drivers.createRoute({
      driverId: Number(req.body.driver_id),
      title: req.body.title,
      scheduledDate: req.body.scheduled_date,
      notes: req.body.notes,
    });
    res.redirect(`/admin/routes/${route.id}`);
  } catch (err) {
    res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p><p><a href="/admin/routes/new">&larr; Back</a></p>`));
  }
}));

app.get('/admin/routes/:id', adminAuth, ah(async (req, res) => {
  const route = await drivers.getRouteById(req.params.id);
  if (!route) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Route not found.</p>'));
  const [driver, packages, counts] = await Promise.all([
    route.driver_id ? drivers.getDriverById(route.driver_id) : null,
    drivers.listPackages({ routeId: route.id }),
    drivers.countPackagesByStatus(route.id),
  ]);
  res.send(adminViews.adminLayout('Route ' + route.route_code, driverAdminViews.routeDetailHtml({ route, driver, packages, counts })));
}));

app.post('/admin/routes/:id/status', adminAuth, ah(async (req, res) => {
  try {
    await drivers.setRouteStatus(req.params.id, req.body.status);
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p>`));
  }
  res.redirect(`/admin/routes/${req.params.id}`);
}));

app.post('/admin/routes/:id/packages', adminAuth, ah(async (req, res) => {
  const route = await drivers.getRouteById(req.params.id);
  if (!route) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Route not found.</p>'));
  try {
    await drivers.createPackage({
      routeId: route.id,
      driverId: route.driver_id,
      recipient_name: req.body.recipient_name,
      address: req.body.address,
      city: req.body.city,
      state: req.body.state,
      zip: req.body.zip,
      special_instructions: req.body.special_instructions,
    });
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p><p><a href="/admin/routes/${route.id}">&larr; Back</a></p>`));
  }
  res.redirect(`/admin/routes/${route.id}`);
}));

// --- Phase F: admin package investigation (read-only custody timeline) ---------
app.get('/admin/packages/:packageId', adminAuth, ah(async (req, res) => {
  const pkg = await drivers.getPackage(req.params.packageId);
  if (!pkg) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Package not found.</p>'));
  const [driver, route, events] = await Promise.all([
    pkg.driver_id ? drivers.getDriverById(pkg.driver_id) : null,
    pkg.route_id ? drivers.getRouteById(pkg.route_id) : null,
    drivers.getCustodyHistory(pkg.package_id),
  ]);
  res.send(adminViews.adminLayout('Package ' + pkg.package_id, driverAdminViews.adminPackageHtml({ pkg, driver, route, events })));
}));

// --- Phase E: phone-camera scanning (manual fallback always available) --------
app.get('/d/:token/scan', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  page(res, 'Scan a package', driverViews.scanPage({ driver: req.driver }), site);
}));

app.post('/d/:token/scan', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) {
    return page(res, 'Scan a package', driverViews.scanResultPage({ driver, pkg: null, error: 'Enter a package ID or scan a barcode.' }), site);
  }
  const pkg = await drivers.getPackage(code);
  // Scope to the driver's own packages; never reveal another driver's data.
  if (!pkg || Number(pkg.driver_id) !== Number(driver.id)) {
    return page(res, 'Scan a package', driverViews.scanResultPage({ driver, pkg: null, error: `No package ${code} found among your assigned packages.` }), site);
  }
  res.redirect(`/d/${driver.access_token}/packages/${encodeURIComponent(pkg.package_id)}`);
}));

// --- Phase F: append-only custody + handoff history -----------------------------
app.get('/d/:token/packages/:packageId', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const pkg = await drivers.getPackage(req.params.packageId);
  if (!pkg || Number(pkg.driver_id) !== Number(driver.id)) {
    res.status(404);
    return page(res, 'Not found', '<section><h1>Package not found</h1><p class="subhead">This package is not assigned to you.</p></section>', site);
  }
  const events = await drivers.getCustodyHistory(pkg.package_id);
  page(res, pkg.package_id, driverViews.driverPackagePage({ driver, pkg, events }), site);
}));

app.post('/d/:token/packages/:packageId/event', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const pkg = await drivers.getPackage(req.params.packageId);
  if (!pkg || Number(pkg.driver_id) !== Number(driver.id)) {
    res.status(404);
    return page(res, 'Not found', '<section><h1>Package not found</h1><p class="subhead">This package is not assigned to you.</p></section>', site);
  }
  try {
    await drivers.recordCustodyEvent({
      packageId: pkg.package_id,
      eventType: req.body.event_type,
      driverId: driver.id,
      note: req.body.note || '',
      createdBy: 'driver',
    });
  } catch (err) {
    res.status(400);
    const events = await drivers.getCustodyHistory(pkg.package_id);
    return page(res, pkg.package_id, `<section><div class="form-error" role="alert">${err.message}</div></section>` + driverViews.driverPackagePage({ driver, pkg, events }), site);
  }
  res.redirect(`/d/${driver.access_token}/packages/${encodeURIComponent(pkg.package_id)}`);
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
    await db.recordEvent({ lead_id: lead.id, type: 'email_unsubscribed' });
  }
  const body = `<section>
    <h1>You&rsquo;re unsubscribed</h1>
    <p>${emailAddr ? `We&rsquo;ve removed <strong>${esc(emailAddr)}</strong> from` : `If that address was on`} our marketing list. You won&rsquo;t receive further marketing emails from ${esc(site.businessName)}.</p>
    <p><a href="/">Back to the homepage</a></p>
  </section>`;
  if (emailAddr && !(await db.get('SELECT 1 FROM suppressions WHERE email = ?', [emailAddr]))) {
    // Room members often have no lead row, so the lead-only unsubscribe above
    // would not stop their member emails. Suppress by email so room-reminder
    // and room-daily-nudge emails stop too. Idempotent: one row per email.
    await db.run('INSERT INTO suppressions (email, reason, ts) VALUES (?, ?, ?)', [emailAddr, 'unsubscribed', Date.now()]);
  }
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

// --- Stripe webhooks ---------------------------------------------------------------------------
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_SIG_TOLERANCE_SEC = 300; // Stripe recommends rejecting events older than ~5 minutes

/**
 * Verify a Stripe `stripe-signature` header against the raw request body.
 * Uses the exact algorithm from Stripe's docs (HMAC-SHA256 over "t.rawBody"),
 * with only node built-ins — no extra dependency. Returns the parsed event.
 * Throws on any failure (malformed header, stale timestamp, bad signature).
 */
function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = {};
  String(sigHeader).split(',').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) parts[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  const t = parseInt(parts.t, 10);
  if (!t || !parts.v1) throw new Error('malformed stripe-signature header');
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - t) > STRIPE_SIG_TOLERANCE_SEC) {
    throw new Error('stripe-signature timestamp outside tolerance');
  }
  const signedPayload = `${t}.${rawBody.toString('utf8')}`;
  const expectedHex = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(parts.v1, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('stripe-signature mismatch');
  }
  return JSON.parse(rawBody.toString('utf8'));
}

/**
 * Handle a verified Stripe event. Records the purchase so the funnel's
 * post-purchase automation (confirmation email, nurture-stop, upsells,
 * metrics) runs. Returns true when a purchase was recorded.
 *
 * Product mapping: Stripe payment links don't carry our product id, so we
 * match the charged amount (amount_total, in cents) against the configured
 * products' priceCents (Basic $50 = 5000, Complete $100 = 10000).
 */
/**
 * Provision a Wealth Builder's Room membership from a completed $49/month
 * Stripe purchase. The member record is keyed by the Stripe customer email.
 * Idempotent: re-running for the same Stripe session records the purchase
 * only once and never resets a password.
 *
 * Full purchase bookkeeping (mirrors recordPurchase for the Room product):
 * resolves or creates the lead row, tags the lead, closes open Room carts,
 * cancels queued Room nurture/abandoned-cart emails, schedules the Room
 * welcome email, and records payment_success / membership_created events.
 */
async function handleRoomPurchase({ email, name, amountCents, mode, sessionId }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return false;
  await room.upsertMemberFromPurchase({ email: clean, name });
  if (sessionId) {
    const seen = await db.get(
      "SELECT id FROM events WHERE type = 'ROOM_PURCHASED' AND meta LIKE ?",
      [`%${String(sessionId).replace(/[%_]/g, '')}%`]
    );
    if (seen) {
      console.log('[webhook:stripe] duplicate room purchase event ignored', { sessionId });
      return true;
    }
  }
  const now = Date.now();
  // Resolve or create the lead so email automation and admin views have a target.
  let lead = await db.get('SELECT * FROM leads WHERE email = ?', [clean]);
  if (!lead) {
    const info = await db.run(
      `INSERT INTO leads
         (first_name, email, offer_of_interest, consent_marketing, consent_ts, date_captured, status, unsubscribed)
       VALUES (?, ?, 'room', 1, ?, ?, 'lead', 0)`,
      [(name || '').trim() || null, clean, now, now]
    );
    lead = await db.get('SELECT * FROM leads WHERE id = ?', [Number(info.lastInsertRowid)]);
  }
  const leadId = lead.id;
  const cents = Number.isFinite(Number(amountCents)) ? Number(amountCents) : 4900;
  await db.run(
    `INSERT INTO purchases (lead_id, product_id, amount_cents, mode, kind, ts)
     VALUES (?, 'room', ?, ?, 'initial', ?)`,
    [leadId, cents, mode, now]
  );

  const hadAbandonedTag = await tags.hasTag(leadId, 'ABANDONED_CART');
  await tags.removeTag(leadId, 'ABANDONED_CART');
  // Close this lead's open Room carts; flag true recoveries.
  const openCarts = await db.all(
    "SELECT * FROM carts WHERE lead_id = ? AND product_id = 'room' AND purchased = 0",
    [leadId]
  );
  for (const cart of openCarts) {
    const recovered = cart.started_at < now - 3600e3 && hadAbandonedTag ? 1 : 0;
    await db.run('UPDATE carts SET purchased = 1, recovered = ? WHERE id = ?', [recovered, cart.id]);
  }
  // Stop queued Room prospect follow-ups — this buyer converted.
  await db.run(
    `UPDATE email_queue SET status = 'cancelled', cancel_reason = 'purchased'
     WHERE lead_id = ? AND status = 'queued' AND sequence IN ('roomNurture', 'roomAbandonedCart')`,
    [leadId]
  );

  await tags.addTag(leadId, 'PURCHASED');
  await tags.addTag(leadId, 'CUSTOMER');
  await tags.addTag(leadId, 'ROOM_PURCHASED');
  await tags.addTag(leadId, 'OFFER_room_PURCHASED');
  await db.run("UPDATE leads SET status = 'customer' WHERE id = ?", [leadId]);

  // Welcome email (queued immediately; suppression-aware at send time).
  await automation.scheduleSequence(leadId, 'room', 'roomWelcome');

  await db.recordEvent({
    lead_id: leadId,
    type: 'ROOM_PURCHASED',
    product_id: 'room',
    meta: { email: clean, amount_cents: cents, session_id: sessionId || null },
  });
  await db.recordEvent({
    lead_id: leadId,
    type: 'payment_success',
    product_id: 'room',
    meta: { email: clean, amount_cents: cents, session_id: sessionId || null, mode },
  });
  await db.recordEvent({
    lead_id: leadId,
    type: 'membership_created',
    product_id: 'room',
    meta: { email: clean },
  });
  console.log('[webhook:stripe] room member provisioned', { email: clean, amountCents: cents });
  return true;
}

/** Look up a lead id by email; null when there's no lead row. */
async function leadIdForEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  const row = await db.get('SELECT id FROM leads WHERE email = ?', [clean]);
  return row ? row.id : null;
}

/**
 * Record a failed Room subscription payment. We can't always map the invoice
 * to a lead, so the member email is matched when present.
 */
async function handleFailedRoomPayment(invoice) {
  const inv = invoice || {};
  const email = (
    inv.customer_email ||
    (inv.customer_details && inv.customer_details.email) ||
    ''
  ).trim().toLowerCase();
  const amountCents = Number(inv.amount_due);
  const leadId = await leadIdForEmail(email);
  await db.recordEvent({
    lead_id: leadId,
    type: 'payment_failed',
    product_id: 'room',
    meta: {
      email: email || null,
      amount_cents: Number.isFinite(amountCents) ? amountCents : null,
      invoice_id: inv.id || null,
    },
  });
  console.log('[webhook:stripe] room payment failed', { email: email || null });
  return true;
}

/**
 * Deactivate a Room membership when its Stripe subscription is cancelled or
 * deleted. The member is marked 'canceled' (distinct from a manual
 * 'inactive'), their sessions are revoked, and the lead is tagged CANCELED.
 * A later re-purchase re-activates the membership via upsertMemberFromPurchase.
 */
async function handleRoomSubscriptionEnded(subscription) {
  const sub = subscription || {};
  const email = (
    (sub.customer_details && sub.customer_details.email) ||
    sub.customer_email ||
    ''
  ).trim().toLowerCase();
  if (!email) {
    console.warn('[webhook:stripe] subscription ended without a customer email — ignored');
    return false;
  }
  await db.run("UPDATE room_members SET status = 'canceled' WHERE email = ?", [email]);
  await db.run('DELETE FROM room_sessions WHERE email = ?', [email]);
  const leadId = await leadIdForEmail(email);
  if (leadId) {
    await tags.addTag(leadId, 'CANCELED');
    await db.recordEvent({ lead_id: leadId, type: 'membership_canceled', product_id: 'room', meta: { email } });
  } else {
    await db.recordEvent({ lead_id: null, type: 'membership_canceled', product_id: 'room', meta: { email } });
  }
  console.log('[webhook:stripe] room membership canceled', { email });
  return true;
}

async function handleStripeEvent(event) {
  if (!event || !event.type) {
    console.log('[webhook:stripe] ignoring event type', event && event.type);
    return false;
  }
  if (event.type === 'invoice.payment_failed') {
    return handleFailedRoomPayment(event.data && event.data.object);
  }
  if (event.type === 'customer.subscription.deleted') {
    return handleRoomSubscriptionEnded(event.data && event.data.object);
  }
  if (event.type !== 'checkout.session.completed') {
    console.log('[webhook:stripe] ignoring event type', event.type);
    return false;
  }
  const session = (event.data && event.data.object) || {};
  const email = ((session.customer_details && session.customer_details.email) || '').trim().toLowerCase();
  const amountCents = Number(session.amount_total);
  if (!email || !Number.isFinite(amountCents)) {
    console.warn('[webhook:stripe] event missing customer email or amount_total — ignored');
    return false;
  }
  const product = config.getProducts().products.find((p) => Number(p.priceCents) === amountCents);
  if (!product) {
    console.warn('[webhook:stripe] no configured product matches amount_total', amountCents);
    return false;
  }
  if (product.id === 'room') {
    return handleRoomPurchase({
      email,
      name: (session.customer_details && session.customer_details.name) || '',
      amountCents,
      mode: 'stripe',
      sessionId: session.id || null,
    });
  }
  const lead = await db.get('SELECT * FROM leads WHERE email = ?', [email]);
  if (!lead) {
    console.warn('[webhook:stripe] purchase from unknown lead email — ignored', email);
    return false;
  }
  await recordPurchase(lead.id, product.id, 'stripe', { amountCents });
  console.log('[webhook:stripe] recorded purchase', { email, productId: product.id, amountCents });
  return true;
}

app.post('/webhooks/stripe', ah(async (req, res) => {
  const sigHeader = req.get('stripe-signature');
  if (STRIPE_WEBHOOK_SECRET && sigHeader && req.rawBody) {
    // Real Stripe traffic: verify the signature before trusting anything.
    let event;
    try {
      event = verifyStripeSignature(req.rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.warn('[webhook:stripe] signature verification failed:', err.message);
      return res.status(400).json({ ok: false, error: 'invalid signature' });
    }
    const handled = await handleStripeEvent(event);
    return res.json({ ok: true, handled });
  }
  if (STRIPE_WEBHOOK_SECRET) {
    // A secret is configured, so production Stripe traffic always carries a
    // signature. Reject unsigned payloads instead of trusting them.
    console.warn('[webhook:stripe] rejected unsigned payload while STRIPE_WEBHOOK_SECRET is set');
    return res.status(400).json({ ok: false, error: 'missing stripe-signature' });
  }
  // No webhook secret configured (local dev / tests): accept the simple
  // JSON integration shape { email, productId, amountCents }.
  const { email, productId, amountCents } = req.body || {};
  console.log('[webhook:stripe] unsigned payload received', { email, productId, amountCents });
  const cleanEmail = (email || '').trim().toLowerCase();
  const roomProduct = productId && config.getProduct(productId).id === 'room' ? config.getProduct(productId) : null;
  if (cleanEmail && roomProduct) {
    // Room membership purchase (dev/test shape): provision the member.
    await handleRoomPurchase({ email: cleanEmail, name: '', amountCents: amountCents || 4900, mode: 'stripe-webhook', sessionId: null });
    return res.json({ ok: true, note: 'unsigned (no STRIPE_WEBHOOK_SECRET configured)' });
  }
  const lead = cleanEmail ? await db.get('SELECT * FROM leads WHERE email = ?', [cleanEmail]) : null;
  if (lead && productId) {
    await recordPurchase(lead.id, productId, 'stripe-webhook', { amountCents });
  } else {
    console.warn('[webhook:stripe] ignored payload — unknown lead or missing productId');
  }
  res.json({ ok: true, note: 'unsigned (no STRIPE_WEBHOOK_SECRET configured)' });
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
  const metrics = {
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
    // --- Room + grouped dashboard sections (views/admin.js dashboardSectionsHtml) ---
    newLeads7d: (await q('SELECT COUNT(*) c FROM leads WHERE date_captured > ?', [weekAgo])).c,
    convertedLeads: customers,
    activeMembers: (await q("SELECT COUNT(*) c FROM room_members WHERE status = 'active'")).c,
    newMembers7d: (await q('SELECT COUNT(*) c FROM room_members WHERE joined_at > ?', [weekAgo])).c,
    failedPayments: (await q("SELECT COUNT(*) c FROM events WHERE type = 'payment_failed'")).c,
    canceledMemberships: (await q("SELECT COUNT(*) c FROM room_members WHERE status = 'canceled'")).c,
    startedCheckouts: (await q('SELECT COUNT(*) c FROM carts')).c,
    completedCheckouts: (await q('SELECT COUNT(*) c FROM carts WHERE purchased = 1')).c,
    emailsSent: (await q("SELECT COUNT(*) c FROM email_queue WHERE status = 'sent'")).c,
    emailsFailed: (await q("SELECT COUNT(*) c FROM email_queue WHERE status = 'failed'")).c,
    emailsPending: (await q("SELECT COUNT(*) c FROM email_queue WHERE status = 'queued'")).c,
    emailsSuppressed: (await q('SELECT COUNT(*) c FROM suppressions')).c,
    roomActiveMembers: (await q("SELECT COUNT(*) c FROM room_members WHERE status = 'active'")).c,
    roomClaimedMembers: (await q("SELECT COUNT(*) c FROM room_members WHERE status = 'active' AND password_hash IS NOT NULL")).c,
    roomUnclaimedMembers: (await q("SELECT COUNT(*) c FROM room_members WHERE status = 'active' AND password_hash IS NULL")).c,
    roomPosts: (await q('SELECT COUNT(*) c FROM room_posts')).c,
  };
  // MRR for the $49/month Room (derived from the active member count above).
  metrics.mrr = roomMrr(metrics.activeMembers);
  return metrics;
}

/** Monthly recurring revenue for the Room ($49/month per active member). */
function roomMrr(activeMembers) {
  return (Number(activeMembers) || 0) * 49;
}

/** { lost, rate } between two funnel stage counts (rate = converted / from). */
function drop(from, to) {
  const f = Number(from) || 0;
  const t = Number(to) || 0;
  return { lost: Math.max(0, f - t), rate: f ? Math.round((t / f) * 10000) / 10000 : 0 };
}

app.get('/admin', ah(async (req, res) => {
  const site = config.getSite();
  const metrics = await adminMetrics();
  const sections =
    typeof adminViews.dashboardSectionsHtml === 'function'
      ? adminViews.dashboardSectionsHtml(metrics)
      : '';
  res.send(adminViews.adminLayout('Dashboard', adminViews.dashboardHtml(metrics, site) + sections));
}));

/**
 * Derive a single display status for a lead.
 * Priority: SUPPRESSED > CANCELED > ACTIVE_MEMBER > PURCHASED > CHECKOUT_STARTED > ENGAGED > NEW.
 */
async function deriveLeadStatus(lead) {
  const suppressed =
    lead.unsubscribed ||
    (await tags.hasTag(lead.id, 'SUPPRESSED')) ||
    (await tags.hasTag(lead.id, 'UNSUBSCRIBED'));
  if (suppressed) return 'SUPPRESSED';
  if (await tags.hasTag(lead.id, 'CANCELED')) return 'CANCELED';
  const member = await db.get('SELECT 1 FROM room_members WHERE email = ? AND status = ?', [lead.email, 'active']);
  if (member) return 'ACTIVE_MEMBER';
  const purchase = await db.get("SELECT 1 FROM purchases WHERE lead_id = ? AND kind = 'initial'", [lead.id]);
  if (purchase) return 'PURCHASED';
  const cart = await db.get('SELECT 1 FROM carts WHERE lead_id = ?', [lead.id]);
  if (cart) return 'CHECKOUT_STARTED';
  const activity = await db.get(
    'SELECT (SELECT COUNT(*) FROM page_views WHERE lead_id = ?) + (SELECT COUNT(*) FROM email_queue WHERE lead_id = ?) AS c',
    [lead.id, lead.id]
  );
  if (activity && activity.c > 0) return 'ENGAGED';
  return 'NEW';
}

app.get('/admin/leads/:id', ah(async (req, res) => {
  const lead = await db.get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
  if (!lead) return res.status(404).type('text').send('Lead not found');
  const carts = await db.all('SELECT * FROM carts WHERE lead_id = ? ORDER BY started_at DESC', [lead.id]);
  const cartStatus = !carts.length
    ? 'none'
    : carts.every((c) => c.purchased)
      ? 'purchased'
      : (await tags.hasTag(lead.id, 'ABANDONED_CART'))
        ? 'abandoned'
        : 'open';
  const purchase = await db.get(
    "SELECT COUNT(*) c, COALESCE(SUM(amount_cents), 0) s FROM purchases WHERE lead_id = ? AND kind = 'initial'",
    [lead.id]
  );
  const member = await db.get('SELECT status FROM room_members WHERE email = ?', [lead.email]);
  const lastActivity = await db.get(
    `SELECT MAX(ts) m FROM (
       SELECT date_captured AS ts FROM leads WHERE id = ?
       UNION ALL SELECT ts FROM page_views WHERE lead_id = ?
       UNION ALL SELECT ts FROM events WHERE lead_id = ?
       UNION ALL SELECT COALESCE(sent_at, scheduled_for) FROM email_queue WHERE lead_id = ?
     )`,
    [lead.id, lead.id, lead.id, lead.id]
  );
  const emails = await db.all('SELECT subject, status, cancel_reason, sent_at, scheduled_for FROM email_queue WHERE lead_id = ? ORDER BY id DESC LIMIT 50', [lead.id]);
  const view = {
    id: lead.id,
    first_name: lead.first_name,
    email: lead.email,
    phone: lead.phone,
    goal: lead.goal,
    source: lead.source,
    campaign: lead.campaign,
    created_at: fmtTs(lead.date_captured),
    last_activity: fmtTs(lastActivity && lastActivity.m),
    lead_status: await deriveLeadStatus(lead),
    cart_status: cartStatus,
    purchase_status: purchase && purchase.c > 0 ? `paid (${purchase.c})` : 'none',
    membership_status: member ? member.status : 'none',
  };
  const ctx = {
    emails: emails.map((e) => ({
      subject: e.subject,
      status: e.status + (e.cancel_reason ? ` (${e.cancel_reason})` : ''),
      date: fmtTs(e.sent_at || e.scheduled_for),
    })),
  };
  res.send(adminViews.adminLayout(`Lead #${lead.id}`, adminViews.leadDetailHtml(view, ctx)));
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

// --- Wealth Builder's Room admin -------------------------------------------------------------
// Members list, announcements, pin/delete posts (all behind the admin token).
app.get('/admin/room', ah(async (req, res) => {
  const members = await db.all(
    'SELECT email, name, joined_at, last_login, password_hash, status FROM room_members ORDER BY joined_at DESC'
  );
  const posts = await room.listPosts(100);
  const accountability = [];
  for (const m of members) {
    try {
      accountability.push(await room.accountabilitySummary(m.email));
    } catch (err) {
      console.error('[admin/room] accountability summary failed for', m.email, err.message);
    }
  }
  // Active members first, then by most recent check-in.
  accountability.sort((a, b) =>
    (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
    (b.lastCheckinAt || 0) - (a.lastCheckinAt || 0)
  );
  res.send(adminViews.adminLayout("Wealth Builder's Room", roomViews.roomAdminPage({ members, posts, accountability })));
}));

app.post('/admin/room/announce', ah(async (req, res) => {
  await room.createPost({
    authorEmail: 'admin',
    authorName: 'Davena',
    kind: 'announcement',
    title: (req.body.title || '').trim(),
    body: (req.body.body || '').trim(),
  });
  res.redirect('/admin/room');
}));

app.post('/admin/room/pin', ah(async (req, res) => {
  await room.setPinned(req.body.id, req.body.pinned === '1');
  res.redirect('/admin/room');
}));

app.post('/admin/room/delete-post', ah(async (req, res) => {
  await room.deletePost(req.body.id);
  res.redirect('/admin/room');
}));

app.post('/admin/room/delete-comment', ah(async (req, res) => {
  await room.deleteComment(req.body.id);
  res.redirect('/admin/room');
}));

app.post('/admin/room/member-status', ah(async (req, res) => {
  await room.setMemberStatus((req.body.email || '').trim().toLowerCase(), req.body.status);
  res.redirect('/admin/room');
}));


app.post('/admin/room/add-member', ah(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const name = (req.body.name || '').trim();
  if (!EMAIL_RE.test(email)) return res.redirect('/admin/room');
  await room.upsertMemberFromPurchase({ email, name: name || null });
  res.redirect('/admin/room');
}));

/** Masked presence check for config-relevant env vars. Never includes secret values. */
function envStatus() {
  const has = (name) => !!process.env[name];
  return {
    PORT: { set: has('PORT'), hint: process.env.PORT || '3000 (default)' },
    ADMIN_TOKEN: has('ADMIN_TOKEN'),
    STRIPE_WEBHOOK_SECRET: has('STRIPE_WEBHOOK_SECRET'),
    EMAIL_PROVIDER: { set: true, hint: process.env.EMAIL_PROVIDER || 'local (default — no real email is sent)' },
    RESEND_API_KEY: has('RESEND_API_KEY'),
    TURSO_DATABASE_URL: has('TURSO_DATABASE_URL'),
    TURSO_AUTH_TOKEN: has('TURSO_AUTH_TOKEN'),
    APP_URL: { set: has('APP_URL'), hint: process.env.APP_URL || '' },
  };
}

app.get('/admin/config', (req, res) => {
  const envHtml =
    typeof adminViews.configEnvHtml === 'function' ? adminViews.configEnvHtml(envStatus()) : '';
  res.send(
    adminViews.adminLayout(
      'Config',
      adminViews.configEditorHtml(config.getProducts(), config.getEmails(), config.getSite()) + envHtml
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
// Seed the Room's foundational community posts (idempotent — skips existing titles).
seedRoomPosts().catch((err) => {
  console.error('[boot] seedRoomPosts failed:', err);
});

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
