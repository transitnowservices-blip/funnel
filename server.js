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
const pipeline = require('./lib/pipeline');
const content = require('./lib/content');
const subscriptions = require('./lib/subscriptions');
const tracking = require('./lib/tracking');
const automation = require('./lib/automation');
const room = require('./lib/room');
const roomViews = require('./views/room');
const roomFunnelViews = require('./views/room-funnel');
// TransitNow Driver Operations Platform (additive; existing routes untouched).
const drivers = require('./lib/drivers');
const driverViews = require('./views/drivers');
const driverAdminViews = require('./views/driver-admin');
// Phase 1: TransitNow Growth Ecosystem — Grow/Business/RSP funnels + lead CRM
// (additive; existing routes untouched).
const grow = require('./lib/grow');
const growViews = require('./views/grow');
// Phase 2: extended driver onboarding, opportunity database, matching
// (additive; existing routes untouched).
const opps = require('./lib/opportunities');
const oppViews = require('./views/opportunities');
const driverExtViews = require('./views/driver-extended');
// Phase 3: contract hub, territories, operations command center
// (additive; existing routes untouched).
const contracts = require('./lib/contracts');
const contractViews = require('./views/contracts');
const territories = require('./lib/territories');
const territoryViews = require('./views/territories');
const commandLib = require('./lib/command');
const commandViews = require('./views/command');
// Phase 5: live video support — provider abstraction (spec section 15).
const video = require('./lib/video');
// Phase 6: referrals, follow-up, alerts, documents (additive; existing routes
// untouched). Community (Phase J) and service plans (Phase K) are wired into
// the command center and lead profile — not rebuilt.
const referralsLib = require('./lib/referrals');
const followupsLib = require('./lib/followups');
const alertsLib = require('./lib/alerts');
const documentsLib = require('./lib/documents');
const phase6Views = require('./views/phase6');
// Phase 7: growth ecosystem analytics (spec section 26).
const analyticsLib = require('./lib/analytics');
// Dispatcher area: real dispatcher logins + daily board + password reset.
// Additive; the shared ADMIN_TOKEN flow for Davena's own admin is untouched.
const dispatchAuth = require('./lib/dispatch_auth');
const dispatchBoard = require('./lib/dispatch_board');
const dispatchViews = require('./views/dispatch');
const analyticsViews = require('./views/analytics');

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

/** Best-effort client IP for auth rate limiting. */
function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.ip || (req.socket && req.socket.remoteAddress) || '').toString();
}

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
// Public navigation (spec section 27). Room-branded pages (the Wealth
// Builder's Room product) keep their own look and are excluded so the Room
// branding is never disturbed.
const PUBLIC_NAV = [
  { href: '/', label: 'HOME' },
  { href: '/drivers/onboard', label: 'DRIVERS' },
  { href: '/grow', label: 'GROW WITH TRANSITNOW', cta: true },
  { href: '/dispatch', label: 'DISPATCH' },
  { href: '/business', label: 'BUSINESSES' },
  { href: '/rsp', label: 'RSP' },
  { href: '/support', label: 'SUPPORT' },
  { href: '/contact', label: 'CONTACT' },
];
function page(res, title, bodyHtml, site) {
  const s = site && site.businessName !== "Wealth Builder's Room"
    ? { ...site, publicNav: PUBLIC_NAV }
    : site;
  res.send(layoutFn({ title, body: bodyHtml, site: s }));
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
  // Attribute the lead to the content-library item (flyer/message) whose
  // tracked ?campaign= link they came in on, so Davena sees what produces.
  if (lead.campaign) {
    try { await content.recordAttribution(lead.id, lead.campaign); } catch (e) { /* attribution never blocks capture */ }
  }
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
  const phoneDigits = String(req.body.phone || '').replace(/\D/g, '');
  if (!firstName || !EMAIL_RE.test(emailAddr) || phoneDigits.length < 7) {
    res.status(400);
    return page(
      res, 'Start building',
      pages.roomStartPage(site, req.query, 'Please enter your first name, a valid email address, and a phone number.'),
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
  await pipeline.setStage(lead.id, 'NEW');
  // Intent routing: courier/dispatch interest goes to the TransitNow
  // Dispatch Services offer instead of the Room nurture path.
  const goalValue = String(req.body.goal || '').trim().toLowerCase();
  if (goalValue === 'courier-work') {
    await tags.addTag(lead.id, 'INTENT_DISPATCH');
    await db.recordEvent({
      visitor_id: req.vid, lead_id: lead.id, type: 'intent_routed_dispatch',
      product_id: 'room', meta: { goal: lead.goal || null },
    });
    return res.redirect('/dispatch');
  }
  await tags.addTag(lead.id, 'INTENT_ROOM');
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
  if (lead) await pipeline.setStage(lead.id, 'INTERESTED');
  await db.recordEvent({
    visitor_id: req.vid, lead_id: lead ? lead.id : null,
    type: 'offer_viewed', product_id: 'room', meta: { path: '/room/offer' },
  });
  page(res, "Wealth Builder's Room", pages.roomOfferPage(site), site);
}));

app.get('/room/checkout', ah(async (req, res) => {
  const site = roomSite();
  const lead = await leadFromReq(req);
  if (lead) await pipeline.setStage(lead.id, 'QUALIFIED');
  const product = config.getProduct('room');
  page(res, 'Checkout', roomFunnelViews.roomCheckoutPage({ product, site }), site);
}));

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
  await pipeline.setStage(lead.id, 'OFFER SENT');
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
    // Admin-issued temporary password: force the change screen first.
    if (member.must_change_password === 1 &&
        !req.path.startsWith('/room/change-password') &&
        req.path !== '/room/logout') {
      return res.redirect('/room/change-password?forced=1');
    }
    req.roomMember = member;
    return handler(req, res, next);
  });
}

/** Middleware form of the guard, for routes that need extra middleware first. */
const requireRoomMemberMw = ah(async (req, res, next) => {
  const member = await roomMemberFromReq(req);
  if (!member) return res.redirect('/room/login');
  if (member.must_change_password === 1 &&
      !req.path.startsWith('/room/change-password') &&
      req.path !== '/room/logout') {
    return res.redirect('/room/change-password?forced=1');
  }
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
  if (member.must_change_password === 1) return res.redirect('/room/change-password?forced=1');
  res.redirect('/room');
}));

// Member password reset: "Forgot password?" on /room/login.
// Self-service path queues a reset email through the existing email_queue
// pipeline (generic response always — no enumeration); the admin fallback
// (/admin/room member "Reset password") issues a one-time temporary
// password that forces a change on next login.
app.get('/room/forgot', (req, res) => {
  res.send(roomViews.forgotPage({}));
});
app.post('/room/forgot', ah(async (req, res) => {
  try {
    await room.roomForgotPassword(req.body.email || '', clientIp(req));
    res.send(roomViews.forgotPage({ message: room.ROOM_FORGOT_GENERIC_MSG }));
  } catch (err) {
    if (err.code === 'forgot_locked') {
      return res.status(429).send(roomViews.forgotPage({ error: err.message }));
    }
    throw err;
  }
}));
app.get('/room/reset/:token', ah(async (req, res) => {
  const v = await room.validateRoomResetToken(req.params.token);
  if (!v) return res.status(400).send(roomViews.forgotPage({ error: 'This reset link is invalid or has expired.' }));
  res.send(roomViews.resetPage({ token: req.params.token }));
}));
app.post('/room/reset/:token', ah(async (req, res) => {
  try {
    const sessToken = await room.resetRoomPasswordWithToken(req.params.token, req.body.password, req.body.password2);
    setRoomSession(res, sessToken);
    res.redirect('/room');
  } catch (err) {
    if (err.code === 'bad_token') {
      return res.status(400).send(roomViews.forgotPage({ error: err.message }));
    }
    res.send(roomViews.resetPage({ token: req.params.token, error: err.message }));
  }
}));
app.get('/room/change-password', requireRoomMember((req, res) => {
  res.send(roomViews.changePasswordPage({
    member: req.roomMember, forced: req.query.forced === '1' || req.roomMember.must_change_password === 1,
  }));
}));
app.post('/room/change-password', requireRoomMember(ah(async (req, res) => {
  try {
    await room.changeRoomPassword(req.roomMember.email, req.body.current, req.body.password, req.body.password2);
    req.roomMember = await room.getMember(req.roomMember.email);
    res.send(roomViews.changePasswordPage({ member: req.roomMember, ok: 'Password changed.' }));
  } catch (err) {
    res.send(roomViews.changePasswordPage({
      member: req.roomMember, error: err.message, forced: req.roomMember.must_change_password === 1,
    }));
  }
})));

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
    // Accountability line (tap-to-call/text): active, claimed members only.
    // requireRoomMember already guarantees an active session; claimed =
    // member set a password.
    accountabilityLine: req.roomMember.status === 'active' && !!req.roomMember.password_hash,
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

  // Referral awareness: their code was auto-issued at signup — make sure
  // they know the paid program is live the moment they sign up.
  let referralInfo = null;
  try {
    const code = await referralsLib.getActiveCodeForUser('driver', driver.id);
    if (code) {
      const base = drivers.baseUrl().replace(/\/$/, '');
      referralInfo = {
        code: code.code,
        link: `${base}/grow/apply?ref=${encodeURIComponent(code.code)}`,
        referrerBonus: '$' + (referralsLib.PROGRAM.referrerBonusCents / 100).toFixed(0),
        referredBonus: '$' + (referralsLib.PROGRAM.referredBonusCents / 100).toFixed(0),
        milestoneDays: referralsLib.PROGRAM.milestoneDays,
      };
    }
  } catch (e) { /* non-blocking */ }

  // Notifications via the existing outbox queue (Phase 19).
  await drivers.queueDriverEmail({
    to: driver.email,
    subject: 'TransitNow — we received your driver onboarding',
    html: drivers.onboardDriverEmail(driver, dashUrl, referralInfo),
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

  // Tier-based route matching: paid subscribers (ACTIVE dispatch
  // subscription) get their day-one matches immediately — 5 for Complete,
  // 2 for Basic. Free applicants get none; past-due/canceled get none.
  // Best-effort: onboarding never fails because matching did.
  try {
    const rm = require('./lib/route_matching');
    const sub = await subscriptions.getByEmail(String(driver.email || '').trim().toLowerCase());
    if (sub && sub.status === 'active') {
      const r = await rm.runMatchForDriver(driver, { kind: 'onboarding' });
      console.log(`[onboard] day-one route match: driver=${driver.id} plan=${r.plan} created=${r.created}`);
    }
  } catch (err) {
    console.error('[onboard] day-one route match failed:', err.message);
  }

  page(res, 'Onboarding complete', driverViews.onboardDonePage({ site, driver, dashUrl }), site);
}));

// --- Phase 1: TransitNow Growth Ecosystem --------------------------------------
// Grow funnel, 13-step application, business/RSP/dispatch funnels, public
// support page, and the opportunity-lead CRM. Additive — existing routes
// untouched. Admin CRM routes use the existing adminAuth pattern explicitly.

/** Simple in-memory sliding-window rate limiter for public POST endpoints. */
const rateBuckets = new Map();
function publicRateLimit({ windowMs = 10 * 60 * 1000, max = 60 } = {}) {
  return (req, res, next) => {
    if (rateBuckets.size > 5000) rateBuckets.clear();
    const key = `${req.ip || '?'}|${req.path}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) bucket = { start: now, count: 0 };
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > max) {
      res.status(429).type('text').send('Too many requests — please try again in a few minutes.');
      return;
    }
    next();
  };
}
const growLimiter = publicRateLimit();
// Phase 5: live-session requests (driver-token scoped, still rate-limited).
const liveLimiter = publicRateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

// --- /grow landing + 13-step application ---
app.get('/grow', (req, res) => {
  page(res, 'Grow With TransitNow', growViews.growLandingPage(), config.getSite());
});

app.get('/grow/apply', (req, res) => {
  page(
    res, 'Grow With TransitNow — Application',
    growViews.growApplyPage({ query: req.query }), config.getSite()
  );
});

// Save & Continue Later: server-side draft, private resume link.
app.post('/grow/apply/draft', growLimiter, ah(async (req, res) => {
  const b = req.body || {};
  const clean = {};
  for (const [k, v] of Object.entries(b)) {
    if (grow.FORBIDDEN_FIELDS.includes(String(k).toLowerCase())) continue;
    clean[String(k).slice(0, 60)] = v;
  }
  const { token, resumeUrl } = await grow.saveDraft({
    token: b.draft_token, leadType: 'GROW', step: b.step, data: clean,
  });
  res.json({ ok: true, token, resumeUrl });
}));

app.get('/grow/apply/resume/:token', ah(async (req, res) => {
  const d = await grow.getDraft(req.params.token);
  if (!d) return res.status(404).type('text').send('This resume link was not found. It may have been used already or mistyped.');
  page(
    res, 'Grow With TransitNow — Application',
    growViews.growApplyPage({
      query: req.query, prefill: { ...d.data, draft_token: d.token },
      resumeStep: d.step, draftToken: d.token,
    }),
    config.getSite()
  );
}));

app.post('/grow/apply', growLimiter, ah(async (req, res) => {
  const b = req.body || {};
  const site = config.getSite();
  const forbidden = Object.keys(b).filter((k) => grow.FORBIDDEN_FIELDS.includes(String(k).toLowerCase()));
  const n = grow.normalizeGrow(b);
  const errors = grow.validateGrow(n);
  if (forbidden.length) errors.push('This form does not accept that kind of information.');
  if (errors.length) {
    res.status(400);
    return page(
      res, 'Grow With TransitNow — Application',
      growViews.growApplyPage({ query: req.query, prefill: { ...b, draft_token: b.draft_token || '' }, errors }),
      site
    );
  }
  const { lead, created } = await grow.upsertLead('GROW', n.fields);
  await grow.saveGrowRelated(lead.id, n);
  await grow.addLeadTags(lead.id, grow.autoTagsFor(n.fields));
  if (b.draft_token) await grow.deleteDraft(String(b.draft_token));
  await db.recordEvent({
    visitor_id: req.vid || null, lead_id: null, type: 'grow_application', product_id: null,
    meta: { opportunity_lead_id: lead.id, resubmission: !created },
  });
  const profile = await grow.getLeadProfile(lead.id);
  await grow.queueEmail({
    to: lead.email, subject: 'We Received Your TransitNow Information',
    html: grow.applicantConfirmationEmail(lead, 'GROW'), sequence: 'grow', step: 'applicant-confirmation',
  });
  await grow.queueEmail({
    to: grow.opsEmail(), subject: `New Grow application: ${lead.first_name} ${lead.last_name}`,
    html: grow.adminNotificationEmail(lead, profile, { funnelLabel: 'Grow', resubmission: !created }),
    sequence: 'grow', step: 'admin-new-application',
  });
  await db.run(
    `INSERT INTO lead_communications (lead_id, kind, subject, body, direction, ts)
     VALUES (?, 'email', 'We Received Your TransitNow Information', 'Confirmation email queued to applicant.', 'outbound', ?)`,
    [lead.id, Date.now()]
  );
  res.redirect('/grow/thank-you' + (created ? '' : '?updated=1'));
}));

app.get('/grow/thank-you', (req, res) => {
  page(res, 'Thank You',
    growViews.growThankYouPage({ resubmission: req.query.updated === '1' }), config.getSite());
});

// --- /business funnel (spec section 29) ---
app.get('/business', (req, res) => {
  page(res, 'Businesses — TransitNow', growViews.businessPage({ query: req.query }), config.getSite());
});

app.post('/business', growLimiter, ah(async (req, res) => {
  const b = req.body || {};
  const site = config.getSite();
  const fields = grow.normalizeSimple(b, 'BUSINESS');
  const errors = [];
  if (!grow.str(b.company_name, 160)) errors.push('Company name is required.');
  if (!fields.first_name) errors.push('Contact first name is required.');
  if (!grow.EMAIL_RE.test(fields.email)) errors.push('A valid email address is required.');
  if (!fields.phone) errors.push('Phone is required.');
  if (errors.length) {
    res.status(400);
    return page(res, 'Businesses — TransitNow',
      growViews.businessPage({ query: req.query, values: b, errors }), site);
  }
  const { lead, created } = await grow.upsertLead('BUSINESS', fields);
  await grow.addLeadTags(lead.id, ['BUSINESS OWNER']);
  await db.recordEvent({
    visitor_id: req.vid || null, lead_id: null, type: 'business_inquiry', product_id: null,
    meta: { opportunity_lead_id: lead.id, resubmission: !created },
  });
  const profile = await grow.getLeadProfile(lead.id);
  await grow.queueEmail({
    to: lead.email, subject: 'We Received Your TransitNow Business Inquiry',
    html: grow.applicantConfirmationEmail(lead, 'BUSINESS'), sequence: 'grow', step: 'business-confirmation',
  });
  await grow.queueEmail({
    to: grow.opsEmail(), subject: `New business inquiry: ${grow.str(b.company_name, 160)}`,
    html: grow.adminNotificationEmail(lead, profile, { funnelLabel: 'Business', resubmission: !created }),
    sequence: 'grow', step: 'admin-new-business',
  });
  res.redirect('/business/thank-you');
}));

app.get('/business/thank-you', (req, res) => {
  page(res, 'Thank You', growViews.businessThankYouPage(), config.getSite());
});

// --- /rsp funnel (spec section 18) ---
app.get('/rsp', (req, res) => {
  page(res, 'RSP Interest — TransitNow', growViews.rspPage({ query: req.query }), config.getSite());
});

app.post('/rsp', growLimiter, ah(async (req, res) => {
  const b = req.body || {};
  const site = config.getSite();
  const fields = grow.normalizeSimple(b, 'RSP');
  const errors = [];
  if (!fields.first_name) errors.push('First name is required.');
  if (!grow.EMAIL_RE.test(fields.email)) errors.push('A valid email address is required.');
  if (!fields.phone) errors.push('Phone is required.');
  if (!fields.city) errors.push('City is required.');
  if (!fields.state) errors.push('State is required.');
  if (errors.length) {
    res.status(400);
    return page(res, 'RSP Interest — TransitNow',
      growViews.rspPage({ query: req.query, values: b, errors }), site);
  }
  const { lead, created } = await grow.upsertLead('RSP', fields);
  await grow.addLeadTags(lead.id, ['RSP']);
  await db.recordEvent({
    visitor_id: req.vid || null, lead_id: null, type: 'rsp_interest', product_id: null,
    meta: { opportunity_lead_id: lead.id, resubmission: !created },
  });
  const profile = await grow.getLeadProfile(lead.id);
  await grow.queueEmail({
    to: lead.email, subject: 'We Received Your TransitNow RSP Interest',
    html: grow.applicantConfirmationEmail(lead, 'RSP'), sequence: 'grow', step: 'rsp-confirmation',
  });
  await grow.queueEmail({
    to: grow.opsEmail(), subject: `New RSP interest: ${lead.first_name} ${lead.last_name}`,
    html: grow.adminNotificationEmail(lead, profile, { funnelLabel: 'RSP', resubmission: !created }),
    sequence: 'grow', step: 'admin-new-rsp',
  });
  res.redirect('/rsp/thank-you');
}));

app.get('/rsp/thank-you', (req, res) => {
  page(res, 'Thank You', growViews.rspThankYouPage(), config.getSite());
});

// --- /dispatch funnel (spec section 30) ---
app.get('/dispatch', (req, res) => {
  page(res, 'Dispatch Services — TransitNow', growViews.dispatchPage({ query: req.query }), config.getSite());
});

app.post('/dispatch', growLimiter, ah(async (req, res) => {
  const b = req.body || {};
  const site = config.getSite();
  const fields = grow.normalizeSimple(b, 'GROW');
  const errors = [];
  if (!fields.first_name) errors.push('First name is required.');
  if (!grow.EMAIL_RE.test(fields.email)) errors.push('A valid email address is required.');
  if (!fields.phone) errors.push('Phone is required.');
  if (errors.length) {
    res.status(400);
    return page(res, 'Dispatch Services — TransitNow',
      growViews.dispatchPage({ query: req.query, values: b, errors }), site);
  }
  const { lead, created } = await grow.upsertLead('GROW', fields);
  await grow.addLeadTags(lead.id, ['DISPATCH']);
  await db.recordEvent({
    visitor_id: req.vid || null, lead_id: null, type: 'dispatch_info_request', product_id: null,
    meta: { opportunity_lead_id: lead.id, resubmission: !created },
  });
  const profile = await grow.getLeadProfile(lead.id);
  await grow.queueEmail({
    to: lead.email, subject: 'We Received Your Dispatch Information Request',
    html: grow.applicantConfirmationEmail(lead, 'GROW'), sequence: 'grow', step: 'dispatch-confirmation',
  });
  await grow.queueEmail({
    to: grow.opsEmail(), subject: `New dispatch info request: ${lead.first_name} ${lead.last_name}`,
    html: grow.adminNotificationEmail(lead, profile, { funnelLabel: 'Dispatch', resubmission: !created }),
    sequence: 'grow', step: 'admin-new-dispatch',
  });
  res.redirect('/dispatch/thank-you');
}));

app.get('/dispatch/thank-you', (req, res) => {
  page(res, 'Thank You', growViews.dispatchThankYouPage(), config.getSite());
});

// --- Public /support page (no 24/7 human-staff claim) ---
app.get('/support', (req, res) => {
  page(res, 'Support — TransitNow', growViews.supportPage(), config.getSite());
});

// --- Admin CRM (spec sections 7-8) ----------------------------------------------
app.get('/admin/crm', adminAuth, ah(async (req, res) => {
  const type = String(req.query.type || '').toUpperCase();
  const status = String(req.query.status || '').toUpperCase();
  const paid = String(req.query.paid || 'all');
  const types = grow.LEAD_TYPES;
  const order = type === 'BUSINESS' ? grow.BUSINESS_STATUSES : grow.GROW_STATUSES;
  const allStatuses = [...new Set([...grow.GROW_STATUSES, ...grow.BUSINESS_STATUSES])];
  const conds = [];
  const params = [];
  if (types.includes(type)) { conds.push('lead_type = ?'); params.push(type); }
  if (allStatuses.includes(status)) { conds.push('status = ?'); params.push(status); }
  let leads = await db.all(
    `SELECT * FROM opportunity_leads ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  // Paid-client visibility (additive): badge + filter leads by dispatch subscription.
  const subMap = await subscriptions.mapForEmails(leads.map((l) => l.email));
  if (paid === 'paid') leads = leads.filter((l) => subMap[String(l.email || '').toLowerCase()]?.status === 'active');
  else if (paid === 'attention') {
    leads = leads.filter((l) => {
      const st = subMap[String(l.email || '').toLowerCase()]?.status;
      return st === 'past_due' || st === 'canceled';
    });
  }
  const grouped = {};
  for (const l of leads) { (grouped[l.status] = grouped[l.status] || []).push(l); }
  res.send(adminViews.adminLayout('Opportunity CRM',
    growViews.crmPipelineHtml({ grouped, type, status, paid, types, allStatuses: order, subsByEmail: subMap })));
}));

app.get('/admin/crm/leads/:id', adminAuth, ah(async (req, res) => {
  const profile = await grow.getLeadProfile(req.params.id);
  if (!profile) return res.status(404).type('text').send('Lead not found');
  // Phase 2 (additive): driver-application linkage + potential matches.
  // Phase 6 (additive): follow-up history and referral attribution.
  const [driverLink, matches, opportunities, followupHistory, attempts, referralAttr] = await Promise.all([
    opps.getDriverLinkForLead(profile.lead.id),
    opps.listMatchesForPerson('lead', profile.lead.id),
    opps.listOpportunities({}),
    followupsLib.listFollowups(profile.lead.id),
    followupsLib.countAttempts(profile.lead.id),
    db.get('SELECT * FROM referral_attributions WHERE referred_lead_id = ?', [profile.lead.id]),
  ]);
  res.send(adminViews.adminLayout(`Lead #${profile.lead.id}`,
    growViews.crmLeadProfileHtml(profile, {
      pipelines: { GROW: grow.GROW_STATUSES, BUSINESS: grow.BUSINESS_STATUSES, RSP: grow.GROW_STATUSES },
      internalTags: grow.INTERNAL_TAGS,
      error: req.query.error || '',
      driverLink, matches, opportunities,
      linkedJustNow: req.query.linked === '1',
      // Phase 6: follow-up system (extends the profile, nothing duplicated).
      followupHistory, attempts,
      followupLatest: followupHistory[0] || null,
      referralAttr,
    })));
}));

app.post('/admin/crm/leads/:id/status', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await grow.changeLeadStatus(id, String(req.body.status || '').toUpperCase(), 'admin', req.body.note || '');
  } catch (err) {
    return res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}`);
}));

app.post('/admin/crm/leads/:id/note', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await grow.addLeadNote(id, 'admin', req.body.note || '');
  } catch (err) {
    return res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}`);
}));

app.post('/admin/crm/leads/:id/followup', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  const b = req.body || {};
  // Phase 6 (additive): every follow-up is logged with the exact spec status,
  // last contact, next follow-up, assigned staff, contact attempts, outcome.
  // The legacy follow_up_date/assigned_to columns are still updated so the
  // pipeline view keeps working.
  const nextAt = followupsLib.dateToMs(b.next_follow_up_at);
  const contactAttempt = b.contact_attempt === '1' || b.contact_attempt === 'on';
  try {
    await followupsLib.createFollowup(id, {
      status: b.followup_status || 'FOLLOW UP',
      lastContactAt: contactAttempt ? Date.now() : null,
      nextFollowUpAt: nextAt,
      assignedTo: b.assigned_to || '',
      note: b.note || '',
      outcome: b.outcome || '',
      contactAttempt,
      reminder: b.reminder === '1' || b.reminder === 'on',
      createdBy: 'admin',
    });
    await grow.setFollowUp(
      id,
      nextAt ? new Date(nextAt).toISOString().slice(0, 10) : (b.follow_up_date || ''),
      b.assigned_to || ''
    );
  } catch (err) {
    return res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}`);
}));

app.post('/admin/crm/leads/:id/tags', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  const selected = grow.arr(req.body.tags).filter((t) => grow.INTERNAL_TAGS.includes(t));
  const now = Date.now();
  await db.run('DELETE FROM opportunity_lead_tags WHERE lead_id = ?', [id]);
  for (const t of selected) {
    await db.run('INSERT INTO opportunity_lead_tags (lead_id, tag, ts) VALUES (?, ?, ?)', [id, t, now]);
  }
  res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}`);
}));

// --- Phase B: admin driver pipeline -----------------------------------------
// NOTE: these routes are registered before app.use('/admin', adminAuth), so
// adminAuth is applied explicitly on each route (function is hoisted).
app.get('/admin/drivers', adminAuth, ah(async (req, res) => {
  const status = drivers.DRIVER_STATUSES.includes(req.query.status) ? req.query.status : null;
  const source = req.query.source ? drivers.normalizeSource(req.query.source) : null;
  // Paid-client filter: 'paid' = active dispatch subscribers, 'attention' = past_due.
  const paid = ['paid', 'attention'].includes(req.query.paid) ? req.query.paid : '';
  const filters = { status, source: req.query.source ? source : null, search: req.query.q || '', limit: paid ? 500 : 100 };
  const [list, counts] = await Promise.all([
    drivers.listDrivers(filters),
    drivers.countDriversByStatus(),
  ]);
  const subsByEmail = await subscriptions.mapForEmails(list.map((d) => d.email));
  const subOf = (d) => subsByEmail[String(d.email || '').toLowerCase()] || null;
  let shown = list;
  if (paid === 'paid') shown = list.filter((d) => { const s = subOf(d); return s && s.status === 'active'; });
  if (paid === 'attention') shown = list.filter((d) => { const s = subOf(d); return s && s.status === 'past_due'; });
  const [activeSubs, pastDueSubs] = await Promise.all([
    subscriptions.listByStatus('active'),
    subscriptions.listByStatus('past_due'),
  ]);
  res.send(adminViews.adminLayout('Driver Pipeline', driverAdminViews.driverPipelineHtml({
    list: shown, counts, status, source: req.query.source || '', q: req.query.q || '',
    subsByEmail, paid, paidCounts: {
      active: activeSubs.filter((s) => !s.is_test).length,
      past_due: pastDueSubs.length,
      testActive: activeSubs.filter((s) => s.is_test).length,
    },
  })));
}));

app.get('/admin/drivers/:id', adminAuth, ah(async (req, res) => {
  const driver = await drivers.getDriverById(req.params.id);
  if (!driver) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Driver not found.</p>'));
  const history = await drivers.statusHistory(driver.id);
  const subscription = await subscriptions.getByEmail(driver.email);
  const rm = require('./lib/route_matching');
  const [routeMatches, goalCents] = await Promise.all([
    rm.matchesForDriver(driver.id, 25),
    rm.getWeeklyGoal(driver.id),
  ]);
  res.send(adminViews.adminLayout('Driver: ' + driver.full_name, driverAdminViews.driverDetailHtml({
    driver, history, subscription, routeMatches,
    goal: { goalCents, weekKey: rm.chicagoWeekKey() },
    notice: req.query.msg || '',
  })));
}));

app.post('/admin/drivers/:id/goal', adminAuth, ah(async (req, res) => {
  const driver = await drivers.getDriverById(req.params.id);
  if (!driver) return res.status(404).type('text').send('Driver not found');
  const dollars = Number(req.body.goal_dollars);
  if (!Number.isFinite(dollars) || dollars < 0) {
    return res.status(400).type('text').send('Enter a valid weekly goal amount in dollars.');
  }
  const rm = require('./lib/route_matching');
  await rm.setWeeklyGoal(driver.id, Math.round(dollars * 100));
  res.redirect(`/admin/drivers/${driver.id}`);
}));

// --- Admin: test-access grants (Davena only) ---------------------------------
// Grants a driver the paid-client experience for testing WITHOUT a Stripe
// payment. The subscription row is flagged is_test=1 and labeled TEST in
// admin; test grants never touch Stripe and are excluded from revenue.
// Only real Stripe webhook events can create or change real subscriptions.
app.post('/admin/drivers/:id/test-access', adminAuth, ah(async (req, res) => {
  const driver = await drivers.getDriverById(req.params.id);
  if (!driver) return res.status(404).type('text').send('Driver not found');
  try {
    await subscriptions.grantTestAccess({ email: driver.email, plan: req.body.plan });
  } catch (err) {
    return res.redirect(`/admin/drivers/${driver.id}?msg=${encodeURIComponent('error: ' + err.message)}`);
  }
  res.redirect(`/admin/drivers/${driver.id}?msg=test-granted`);
}));

app.post('/admin/drivers/:id/test-access/revoke', adminAuth, ah(async (req, res) => {
  const driver = await drivers.getDriverById(req.params.id);
  if (!driver) return res.status(404).type('text').send('Driver not found');
  try {
    await subscriptions.revokeTestAccess({ email: driver.email });
  } catch (err) {
    return res.redirect(`/admin/drivers/${driver.id}?msg=${encodeURIComponent('error: ' + err.message)}`);
  }
  res.redirect(`/admin/drivers/${driver.id}?msg=test-revoked`);
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
  // Tier route matches + weekly goal for the driver's own dashboard.
  let matchInfo = null;
  try {
    const rm = require('./lib/route_matching');
    const [matches, prog] = await Promise.all([
      rm.activeMatches(driver.id),
      rm.goalProgress(driver.id),
    ]);
    matchInfo = { matches, prog };
  } catch (err) {
    console.error('[dashboard] route match info failed:', err.message);
  }
  // Private operations assistant (Complete tier only — hidden from everyone
  // else, including Basic and unpaid drivers).
  let assistantInfo = null;
  try {
    const ai = require('./lib/ai_assistant');
    const isComplete = await ai.isCompleteActive(driver);
    if (isComplete) {
      const caps = require('./lib/ai_capabilities');
      const wk = require('./lib/route_matching').chicagoWeekKey();
      assistantInfo = {
        isComplete: true,
        questions: await ai.listForDriver(driver.id, 20),
        capCount: caps.DRIVER_CAPABILITIES.length,
        spotlight: caps.weeklySpotlight(caps.DRIVER_CAPABILITIES, wk),
      };
    }
  } catch (err) {
    console.error('[dashboard] assistant info failed:', err.message);
  }
  // Dispatch messages inbox (broadcasts + direct admin messages), newest
  // first. Unread rows render highlighted; marked read after the page sends.
  let dispatchInbox = null;
  try {
    const fc = require('./lib/field_comms');
    dispatchInbox = await fc.driverInbox(driver.id, 20);
  } catch (err) {
    console.error('[dashboard] dispatch inbox failed:', err.message);
  }
  // Talk-to-dispatch-live buttons: ACTIVE subscribers (Basic and Complete)
  // only. 100% real tel:/sms: links — no in-app chat claims.
  let dispatchLive = false;
  try {
    dispatchLive = await subscriptions.isPaidActive(driver.email);
  } catch (err) {
    console.error('[dashboard] dispatch live check failed:', err.message);
  }
  page(res, 'My dashboard', driverViews.dashboardPage({ site, driver, dashUrl, matchInfo, assistantInfo, dispatchInbox, dispatchLive }), site);
  if (dispatchInbox && dispatchInbox.length) {
    try {
      await require('./lib/field_comms').markInboxRead(driver.id);
    } catch (err) {
      console.error('[dashboard] mark inbox read failed:', err.message);
    }
  }
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
    // Paid-client enforcement: dispatch work is for active subscribers only.
    // The driver application itself stays free — this gate is only where
    // dispatch work begins.
    const gate = await paidDispatchGate(Number(req.body.driver_id));
    if (!gate.ok) {
      return res.status(402).send(adminViews.adminLayout('Payment required', paidGateHtml(gate)));
    }
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
  const [driver, packages, counts, progress] = await Promise.all([
    route.driver_id ? drivers.getDriverById(route.driver_id) : null,
    drivers.listPackages({ routeId: route.id }),
    drivers.countPackagesByStatus(route.id),
    drivers.getRouteProgress(route.id),
  ]);
  res.send(adminViews.adminLayout('Route ' + route.route_code, driverAdminViews.routeDetailHtml({ route, driver, packages, counts, progress })));
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
  const [driver, route, events, exceptions] = await Promise.all([
    pkg.driver_id ? drivers.getDriverById(pkg.driver_id) : null,
    pkg.route_id ? drivers.getRouteById(pkg.route_id) : null,
    drivers.getCustodyHistory(pkg.package_id),
    drivers.listExceptions({ packageId: pkg.package_id }),
  ]);
  res.send(adminViews.adminLayout('Package ' + pkg.package_id, driverAdminViews.adminPackageHtml({ pkg, driver, route, events, exceptions })));
}));

// --- Phase H: admin exception flagging + resolution ------------------------------
app.get('/admin/exceptions', adminAuth, ah(async (req, res) => {
  const statusFilter = ['open', 'resolved'].includes(req.query.status) ? req.query.status : null;
  const [list, openCount] = await Promise.all([
    drivers.listExceptions({ status: statusFilter }),
    drivers.countOpenExceptions(),
  ]);
  const ids = [...new Set(list.map((x) => x.driver_id).filter(Boolean))];
  const driversById = {};
  for (const id of ids) driversById[id] = await drivers.getDriverById(id);
  res.send(adminViews.adminLayout('Package exceptions', driverAdminViews.exceptionsListHtml({ list, statusFilter, openCount, driversById })));
}));

app.post('/admin/exceptions/:id/resolve', adminAuth, ah(async (req, res) => {
  try {
    const ex = await drivers.resolveException(req.params.id, req.body.resolution_note || '', 'admin');
    res.redirect(`/admin/packages/${encodeURIComponent(ex.package_id)}`);
  } catch (err) {
    res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p>`));
  }
}));

app.get('/admin/exceptions/:id/photo', adminAuth, ah(async (req, res) => {
  const ex = await drivers.getException(req.params.id);
  if (!ex) return res.status(404).send('Not found');
  const photo = await drivers.getExceptionPhoto(req.params.id);
  if (!photo || !photo.photo_blob) return res.status(404).send('No photo attached.');
  res.type(photo.photo_mime || 'application/octet-stream');
  // node:sqlite returns BLOBs as Uint8Array; Express would JSON-serialize it
  // into garbage bytes. Buffer.from() keeps the original bytes intact.
  res.send(Buffer.from(photo.photo_blob));
}));

// --- Phase I: admin support ticket triage ---------------------------------------
app.get('/admin/tickets', adminAuth, ah(async (req, res) => {
  const statusFilter = drivers.TICKET_STATUSES.includes(req.query.status) ? req.query.status : null;
  const list = await drivers.listTickets({ status: statusFilter });
  const ids = [...new Set(list.map((t) => t.driver_id).filter(Boolean))];
  const driversById = {};
  for (const id of ids) driversById[id] = await drivers.getDriverById(id);
  const fc = require('./lib/field_comms');
  const siren = require('./views/field_comms').sirenBannerHtml(await fc.unackedUrgentTickets(50), '/dispatch');
  res.send(adminViews.adminLayout('Support tickets', siren + driverAdminViews.ticketsListHtml({ list, statusFilter, driversById })));
}));

app.get('/admin/tickets/:ticketId', adminAuth, ah(async (req, res) => {
  const ticket = await drivers.getTicket(req.params.ticketId);
  if (!ticket) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Ticket not found.</p>'));
  const [driver, replies] = await Promise.all([
    ticket.driver_id ? drivers.getDriverById(ticket.driver_id) : null,
    drivers.getTicketReplies(ticket.ticket_id),
  ]);
  res.send(adminViews.adminLayout('Ticket ' + ticket.ticket_id, driverAdminViews.adminTicketHtml({ ticket, driver, replies })));
}));

app.post('/admin/tickets/:ticketId/reply', adminAuth, ah(async (req, res) => {
  try {
    await drivers.addTicketReply({ ticketId: req.params.ticketId, authorType: 'admin', authorId: null, message: req.body.message });
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p>`));
  }
  res.redirect(`/admin/tickets/${encodeURIComponent(req.params.ticketId)}`);
}));

app.post('/admin/tickets/:ticketId/status', adminAuth, ah(async (req, res) => {
  try {
    await drivers.setTicketStatus(req.params.ticketId, req.body.status);
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p>`));
  }
  res.redirect(`/admin/tickets/${encodeURIComponent(req.params.ticketId)}`);
}));


// --- Phase 5: admin live video session queue --------------------------------------
// All routes carry adminAuth explicitly (registered before app.use('/admin')).
// Honesty: the queue/detail never present a session as a live/real-time/
// connected media call; unconfigured-provider state is labeled SIMULATED TEST.
async function adminSessionProps(sessionId) {
  const s = await drivers.getSession(sessionId);
  if (!s) return null;
  const [driver, events, messages, participants, recording] = await Promise.all([
    s.driver_id ? drivers.getDriverById(s.driver_id) : null,
    drivers.getSessionEvents(sessionId),
    drivers.getSessionMessages(sessionId),
    drivers.getSessionParticipants(sessionId),
    drivers.getSessionRecording(sessionId),
  ]);
  const accessLog = recording ? await drivers.getRecordingAccessLog(recording.id) : [];
  return { session: s, driver, events, messages, participants, recording, accessLog, provider: video.providerStatus() };
}

function renderAdminSession(res, props, error) {
  if (error) res.status(400);
  res.send(adminViews.adminLayout('Session ' + props.session.session_id,
    (error ? `<div class="card" style="border:1px solid #b91c1c"><p><strong>Error:</strong> ${esc(error)}</p></div>` : '') +
    driverAdminViews.adminLiveSessionHtml(props)));
}

app.get('/admin/live-sessions', adminAuth, ah(async (req, res) => {
  const statusFilter = drivers.SESSION_STATUSES.includes(req.query.status) ? req.query.status : null;
  const list = await drivers.listSessions({ status: statusFilter });
  const ids = [...new Set(list.map((x) => x.driver_id).filter(Boolean))];
  const driversById = {};
  for (const id of ids) driversById[id] = await drivers.getDriverById(id);
  res.send(adminViews.adminLayout('Live video sessions',
    driverAdminViews.liveSessionsListHtml({ list, statusFilter, driversById, provider: video.providerStatus() })));
}));

app.get('/admin/live-sessions/:sessionId', adminAuth, ah(async (req, res) => {
  const props = await adminSessionProps(req.params.sessionId);
  if (!props) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Session not found.</p>'));
  renderAdminSession(res, props, null);
}));

async function adminSessionAction(req, res, fn) {
  const props = await adminSessionProps(req.params.sessionId);
  if (!props) return res.status(404).send(adminViews.adminLayout('Not found', '<p>Session not found.</p>'));
  try {
    await fn(props.session);
  } catch (err) {
    return renderAdminSession(res, await adminSessionProps(req.params.sessionId), err.message);
  }
  res.redirect(`/admin/live-sessions/${encodeURIComponent(req.params.sessionId)}`);
}

app.post('/admin/live-sessions/:sessionId/accept', adminAuth, ah(async (req, res) => {
  await adminSessionAction(req, res, (sess) =>
    drivers.acceptSession(sess.session_id, req.body.dispatcher_name, req.body.note));
}));

app.post('/admin/live-sessions/:sessionId/decline', adminAuth, ah(async (req, res) => {
  await adminSessionAction(req, res, (sess) =>
    drivers.declineSession(sess.session_id, req.body.dispatcher_name, req.body.note));
}));

app.post('/admin/live-sessions/:sessionId/missed', adminAuth, ah(async (req, res) => {
  await adminSessionAction(req, res, (sess) =>
    drivers.markSessionMissed(sess.session_id, 'dispatcher', req.body.note));
}));

app.post('/admin/live-sessions/:sessionId/start', adminAuth, ah(async (req, res) => {
  await adminSessionAction(req, res, (sess) => drivers.startSession(sess.session_id, 'dispatcher'));
}));

app.post('/admin/live-sessions/:sessionId/end', adminAuth, ah(async (req, res) => {
  await adminSessionAction(req, res, (sess) =>
    drivers.endSession(sess.session_id, 'dispatcher', req.body.note || 'Ended by operations.'));
}));

app.post('/admin/live-sessions/:sessionId/message', adminAuth, ah(async (req, res) => {
  await adminSessionAction(req, res, (sess) =>
    drivers.addSessionMessage({ sessionId: sess.session_id, senderType: 'dispatcher', senderId: null, message: req.body.message }));
}));

app.post('/admin/live-sessions/:sessionId/recording-consent', adminAuth, ah(async (req, res) => {
  await adminSessionAction(req, res, (sess) =>
    drivers.setRecordingConsent(sess.session_id, {
      // Explicit opt-in only: anything but an explicit "yes" leaves it OFF.
      consented: req.body.consent === 'yes',
      by: 'dispatcher:' + (String(req.body.by || '').trim() || 'operations'),
    }));
}));

// --- Phase 5: admin live training events + content library -------------------------
app.get('/admin/live-training', adminAuth, ah(async (req, res) => {
  const [events, content] = await Promise.all([
    drivers.listTrainingEvents({}),
    drivers.listTrainingContent(),
  ]);
  res.send(adminViews.adminLayout('Live training', driverAdminViews.liveTrainingAdminHtml({ events, content })));
}));

app.post('/admin/live-training/events', adminAuth, ah(async (req, res) => {
  try {
    let scheduledAt = null;
    const raw = String(req.body.scheduled_at || '').trim();
    if (raw) {
      const t = new Date(raw).getTime();
      if (!Number.isFinite(t)) throw new Error('Invalid date/time.');
      scheduledAt = t;
    }
    await drivers.createTrainingEvent({
      title: req.body.title, description: req.body.description,
      scheduledAt, createdBy: 'admin',
    });
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${esc(err.message)}</p><p><a href="/admin/live-training">&larr; Back</a></p>`));
  }
  res.redirect('/admin/live-training');
}));

app.post('/admin/live-training/events/:eventId/attendance', adminAuth, ah(async (req, res) => {
  try {
    const driverId = Number(req.body.driver_id);
    if (!Number.isFinite(driverId)) throw new Error('Choose a driver.');
    await drivers.recordTrainingAttendance(req.params.eventId, driverId, req.body.attended !== '0');
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${esc(err.message)}</p><p><a href="/admin/live-training">&larr; Back</a></p>`));
  }
  res.redirect('/admin/live-training');
}));

app.post('/admin/live-training/content', adminAuth, ah(async (req, res) => {
  try {
    const mins = req.body.duration_mins ? Number(req.body.duration_mins) : null;
    await drivers.createTrainingContent({
      title: req.body.title, description: req.body.description, url: req.body.url,
      durationSecs: mins && mins > 0 ? Math.round(mins * 60) : null,
    });
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${esc(err.message)}</p><p><a href="/admin/live-training">&larr; Back</a></p>`));
  }
  res.redirect('/admin/live-training');
}));

// --- Phase J: admin community moderation ------------------------------------------

app.get('/admin/community', adminAuth, ah(async (req, res) => {
  const [posts, reports] = await Promise.all([
    drivers.listCommunityPosts({ includeHidden: true }),
    drivers.listCommunityReports({}),
  ]);
  const commentsByPost = {};
  for (const p of posts) commentsByPost[p.id] = await drivers.listCommunityComments(p.id, { includeHidden: true });
  const ids = new Set();
  posts.forEach((p) => p.driver_id && ids.add(p.driver_id));
  Object.values(commentsByPost).flat().forEach((c) => c.driver_id && ids.add(c.driver_id));
  reports.forEach((r) => r.reporter_driver_id && ids.add(r.reporter_driver_id));
  const driversById = {};
  for (const id of ids) driversById[id] = await drivers.getDriverById(id);
  res.send(adminViews.adminLayout('Driver community', driverAdminViews.communityModHtml({ posts, commentsByPost, reports, driversById })));
}));

app.post('/admin/community/announce', adminAuth, ah(async (req, res) => {
  try {
    await drivers.createCommunityPost({ driverId: null, authorType: 'admin', category: 'announcements', title: req.body.title, body: req.body.body });
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p>`));
  }
  res.redirect('/admin/community');
}));

app.post('/admin/community/posts/:id/pin', adminAuth, ah(async (req, res) => {
  const p = await drivers.getCommunityPost(req.params.id);
  if (!p) return res.status(404).send('Not found');
  await drivers.setCommunityPostPinned(p.id, !p.pinned);
  res.redirect('/admin/community');
}));

app.post('/admin/community/posts/:id/hide', adminAuth, ah(async (req, res) => {
  await drivers.setCommunityPostStatus(req.params.id, 'hidden');
  res.redirect('/admin/community');
}));

app.post('/admin/community/posts/:id/restore', adminAuth, ah(async (req, res) => {
  await drivers.setCommunityPostStatus(req.params.id, 'visible');
  res.redirect('/admin/community');
}));

app.post('/admin/community/comments/:id/hide', adminAuth, ah(async (req, res) => {
  await drivers.setCommunityCommentStatus(req.params.id, 'hidden');
  res.redirect('/admin/community');
}));

app.post('/admin/community/comments/:id/restore', adminAuth, ah(async (req, res) => {
  await drivers.setCommunityCommentStatus(req.params.id, 'visible');
  res.redirect('/admin/community');
}));

app.post('/admin/community/reports/:id/review', adminAuth, ah(async (req, res) => {
  try {
    await drivers.reviewCommunityReport(req.params.id, req.body.outcome);
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p>`));
  }
  res.redirect('/admin/community');
}));

// --- Phase K: admin service plan configuration -----------------------------------
app.get('/admin/plans', adminAuth, ah(async (req, res) => {
  const [plans, settings, pendingRequests] = await Promise.all([
    drivers.getServicePlans({}),
    drivers.getPlanSettings(),
    drivers.listPendingPlanRequests(),
  ]);
  const ids = [...new Set(pendingRequests.map((r) => r.driver_id))];
  const driversById = {};
  for (const id of ids) driversById[id] = await drivers.getDriverById(id);
  res.send(adminViews.adminLayout('Service plans', driverAdminViews.plansAdminHtml({ plans, settings, pendingRequests, driversById })));
}));

app.post('/admin/plans/settings', adminAuth, ah(async (req, res) => {
  await drivers.updatePlanSettings({
    billing_frequency: req.body.billing_frequency,
    plans_enabled: req.body.plans_enabled === '1' || req.body.plans_enabled === 'on',
  });
  res.redirect('/admin/plans');
}));

app.post('/admin/plans/:id', adminAuth, ah(async (req, res) => {
  try {
    await drivers.updateServicePlan(req.params.id, {
      name: req.body.name,
      weekly_price_cents: Math.round(Number(req.body.weekly_price || 0) * 100),
      description: req.body.description,
      features: String(req.body.features || '').split('\n').map((s) => s.trim()).filter(Boolean),
      active: req.body.active === '1' || req.body.active === 'on',
    });
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p>`));
  }
  res.redirect('/admin/plans');
}));

app.post('/admin/plans/requests/:driverId/approve', adminAuth, ah(async (req, res) => {
  try {
    // Paid-client enforcement: a service plan (dispatch service) is approved
    // only for drivers with an active dispatch subscription.
    const gate = await paidDispatchGate(req.params.driverId);
    if (!gate.ok) {
      return res.status(402).send(adminViews.adminLayout('Payment required', paidGateHtml(gate)));
    }
    await drivers.decidePlanRequest(req.params.driverId, 'approved', req.body.note || '', 'admin');
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p>`));
  }
  res.redirect('/admin/plans');
}));

app.post('/admin/plans/requests/:driverId/reject', adminAuth, ah(async (req, res) => {
  try {
    await drivers.decidePlanRequest(req.params.driverId, 'rejected', req.body.note || '', 'admin');
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error', `<p>${err.message}</p>`));
  }
  res.redirect('/admin/plans');
}));

// --- Phase L: operations dashboard, package investigation, reports, audit --------
// Phase 3 (additive): the operations COMMAND CENTER (spec section 21) renders
// at the top of this same page — TODAY metrics computed live from the real
// tables, with territory/date/contract/driver/route/status filters. The
// Phase-L dashboard below is untouched.
app.get('/admin/operations', adminAuth, ah(async (req, res) => {
  const [overview, recentEvents, recentStatusChanges, commandMetrics, filterOptions] = await Promise.all([
    drivers.getOpsOverview(),
    drivers.getRecentCustodyEvents(25),
    drivers.getRecentDriverStatusChanges(25),
    commandLib.getCommandMetrics(req.query || {}),
    commandLib.listFilterOptions(),
  ]);
  res.send(adminViews.adminLayout('Operations — Command Center',
    commandViews.commandCenterHtml({ metrics: commandMetrics, options: filterOptions }) +
    driverAdminViews.opsDashboardHtml({ overview, recentEvents, recentStatusChanges })));
}));

app.get('/admin/operations/investigate', adminAuth, ah(async (req, res) => {
  const packageId = String(req.query.package_id || '').trim().toUpperCase();
  const pkg = packageId ? await drivers.getPackage(packageId) : null;
  if (!pkg) {
    return res.send(adminViews.adminLayout('Investigate',
      `<h2>Package investigation</h2><div class="card"><p>No package found for ID <strong>${packageId || '(blank)'}</strong>.</p><p><a href="/admin/operations">&larr; Back to dashboard</a></p></div>`));
  }
  res.redirect(`/admin/packages/${encodeURIComponent(pkg.package_id)}`);
}));

app.get('/admin/reports', adminAuth, ah(async (req, res) => {
  const reports = await drivers.getReports();
  res.send(adminViews.adminLayout('Reports', driverAdminViews.reportsHtml({ reports })));
}));

app.get('/admin/audit', adminAuth, ah(async (req, res) => {
  const [statusChanges, custodyEvents, planChanges] = await Promise.all([
    drivers.getRecentDriverStatusChanges(50),
    drivers.getRecentCustodyEvents(50),
    drivers.getRecentPlanChanges(50),
  ]);
  res.send(adminViews.adminLayout('Audit trail', driverAdminViews.auditHtml({ statusChanges, custodyEvents, planChanges })));
}));

// --- Phase 6: referrals, follow-up, alerts, documents (spec sections 31/32/22/23)
// Additive — existing routes untouched. Admin routes use the explicit
// adminAuth pattern; driver-scoped routes use the existing token pattern.

// --- Referrals ---
app.get('/admin/referrals', adminAuth, ah(async (req, res) => {
  const [codes, attributions, opportunities, payouts, totals] = await Promise.all([
    referralsLib.listCodes(),
    referralsLib.listAttributions(),
    opps.listOpportunities({}),
    referralsLib.listPayouts(),
    referralsLib.payoutTotals(),
  ]);
  res.send(adminViews.adminLayout('Referrals',
    phase6Views.referralsAdminHtml({
      codes, attributions, opportunities,
      payouts, payoutTotals: totals,
      error: req.query.error || '',
      payoutMsg: req.query.payoutMsg || '',
      attributed: req.query.attributed ? JSON.parse(req.query.attributed) : null,
    })));
}));

app.post('/admin/referrals/milestones', adminAuth, ah(async (req, res) => {
  const r = await referralsLib.checkMilestones();
  const msg = `Milestone scan: ${r.created} new payout rows, ${r.earned} earned, ${r.voided} voided.`;
  res.redirect('/admin/referrals?payoutMsg=' + encodeURIComponent(msg));
}));

app.post('/admin/referrals/payouts/:id/paid', adminAuth, ah(async (req, res) => {
  try {
    await referralsLib.markPaid(Number(req.params.id), req.body.note || '');
    res.redirect('/admin/referrals?payoutMsg=' + encodeURIComponent('Marked paid.'));
  } catch (err) {
    res.redirect('/admin/referrals?error=' + encodeURIComponent(err.message));
  }
}));

app.post('/admin/referrals/issue', adminAuth, ah(async (req, res) => {
  const issuedToType = req.body.issued_to_type === 'lead' ? 'lead' : 'driver';
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.redirect('/admin/referrals?error=' + encodeURIComponent('Email is required.'));
  let id = null, name = '';
  if (issuedToType === 'driver') {
    const d = await drivers.getDriverByEmail(email);
    if (!d) return res.redirect('/admin/referrals?error=' + encodeURIComponent(`No driver found for ${email}.`));
    id = d.id; name = d.full_name;
  } else {
    const l = await db.get('SELECT id, first_name, last_name FROM opportunity_leads WHERE email = ?', [email]);
    if (!l) return res.redirect('/admin/referrals?error=' + encodeURIComponent(`No lead found for ${email}.`));
    id = l.id; name = `${l.first_name || ''} ${l.last_name || ''}`.trim();
  }
  try {
    await referralsLib.issueCode({ issuedToType, issuedToId: id, issuedToName: name, issuedBy: 'admin', notes: req.body.notes || '' });
  } catch (err) {
    return res.redirect('/admin/referrals?error=' + encodeURIComponent(err.message));
  }
  res.redirect('/admin/referrals');
}));

app.post('/admin/referrals/attribute', adminAuth, ah(async (req, res) => {
  const attributed = await referralsLib.runAttribution();
  res.redirect('/admin/referrals?attributed=' + encodeURIComponent(JSON.stringify(attributed)));
}));

app.post('/admin/referrals/:id/revoke', adminAuth, ah(async (req, res) => {
  await referralsLib.revokeCode(req.params.id);
  res.redirect('/admin/referrals');
}));

app.post('/admin/referrals/attributions/:id', adminAuth, ah(async (req, res) => {
  try {
    await referralsLib.updateAttribution(req.params.id, {
      status: req.body.status || '',
      opportunityId: req.body.opportunity_id || '',
      outcome: req.body.outcome || '',
    });
  } catch (err) {
    return res.redirect('/admin/referrals?error=' + encodeURIComponent(err.message));
  }
  res.redirect('/admin/referrals');
}));

// --- Alerts ---
app.get('/admin/alerts', adminAuth, ah(async (req, res) => {
  const [alertsList, prefs, reminders] = await Promise.all([
    alertsLib.listAlerts({}),
    alertsLib.getPrefs(),
    followupsLib.dueReminders(),
  ]);
  res.send(adminViews.adminLayout('Alerts',
    phase6Views.alertsAdminHtml({ alertsList, prefs, reminders, error: req.query.error || '' })));
}));

app.post('/admin/alerts/generate', adminAuth, ah(async (req, res) => {
  const result = await alertsLib.generateAlerts();
  res.redirect(`/admin/alerts?error=${encodeURIComponent(
    `Generated ${result.created.length} new alert(s); ${result.resolved} stale alert(s) auto-resolved.`)}`);
}));

app.post('/admin/alerts/prefs', adminAuth, ah(async (req, res) => {
  const types = Object.keys(alertsLib.ALERT_TYPES);
  for (const t of types) {
    await alertsLib.setPref(t, !!(req.body[`type_${t}`] === '1' || req.body[`type_${t}`] === 'on'));
  }
  res.redirect('/admin/alerts');
}));

app.post('/admin/alerts/:id/acknowledge', adminAuth, ah(async (req, res) => {
  try { await alertsLib.acknowledgeAlert(req.params.id, 'admin'); }
  catch (err) { return res.redirect('/admin/alerts?error=' + encodeURIComponent(err.message)); }
  res.redirect('/admin/alerts');
}));

app.post('/admin/alerts/:id/resolve', adminAuth, ah(async (req, res) => {
  try { await alertsLib.resolveAlert(req.params.id, 'admin'); }
  catch (err) { return res.redirect('/admin/alerts?error=' + encodeURIComponent(err.message)); }
  res.redirect('/admin/alerts');
}));

// --- Documents (admin) ---
app.get('/admin/documents', adminAuth, ah(async (req, res) => {
  const docs = await documentsLib.listDocuments({
    ownerType: String(req.query.owner_type || ''),
    docType: String(req.query.doc_type || ''),
    status: String(req.query.status || ''),
  });
  res.send(adminViews.adminLayout('Documents',
    phase6Views.documentsAdminHtml({
      docs,
      error: req.query.error || '',
      ownerType: String(req.query.owner_type || ''),
      ownerId: String(req.query.owner_id || ''),
    })));
}));

app.post('/admin/documents/upload',
  adminAuth,
  express.raw({ type: 'multipart/form-data', limit: '10mb' }),
  ah(async (req, res) => {
    let fields, file;
    try {
      ({ fields, file } = multipart.parseMultipart(req, {
        maxFileBytes: documentsLib.MAX_FILE_BYTES,
        allowedMimes: documentsLib.ALLOWED_MIMES,
      }));
    } catch (err) {
      return res.status(400).send(adminViews.adminLayout('Documents',
        phase6Views.documentsAdminHtml({ docs: [], error: err.message })));
    }
    const expiresAt = followupsLib.dateToMs(fields.expires_at);
    try {
      await documentsLib.uploadDocument({
        ownerType: fields.owner_type,
        ownerId: Number(fields.owner_id),
        docType: fields.doc_type,
        file: file ? { buffer: file.buffer, mime: file.mime, originalName: file.originalName } : null,
        uploadedBy: 'admin',
        uploadedByRole: 'admin',
        expiresAt,
        notes: fields.notes || '',
      });
    } catch (err) {
      return res.status(400).send(adminViews.adminLayout('Documents',
        phase6Views.documentsAdminHtml({ docs: [], error: err.message })));
    }
    res.redirect('/admin/documents');
  })
);

app.get('/admin/documents/:id/download', adminAuth, ah(async (req, res) => {
  const doc = await documentsLib.getDocument(req.params.id);
  if (!doc || !doc.file_blob) return res.status(404).type('text').send('Document not found.');
  res.type(doc.file_mime || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${String(doc.file_name || 'document').replace(/"/g, '')}"`);
  res.send(Buffer.from(doc.file_blob));
}));

app.post('/admin/documents/:id/verify', adminAuth, ah(async (req, res) => {
  try {
    await documentsLib.setVerification(req.params.id, {
      status: req.body.status || '',
      verificationStatus: req.body.verification_status || '',
      by: 'admin',
    });
  } catch (err) {
    return res.redirect('/admin/documents?error=' + encodeURIComponent(err.message));
  }
  res.redirect('/admin/documents');
}));

// --- Contract documents: real upload wired into document management ------------
app.post('/admin/contracts/:id/documents/upload',
  adminAuth,
  express.raw({ type: 'multipart/form-data', limit: '10mb' }),
  ah(async (req, res) => {
    const id = req.params.id;
    let fields, file;
    try {
      ({ fields, file } = multipart.parseMultipart(req, {
        maxFileBytes: documentsLib.MAX_FILE_BYTES,
        allowedMimes: documentsLib.ALLOWED_MIMES,
      }));
    } catch (err) {
      return res.redirect(`/admin/contracts/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
    }
    try {
      await documentsLib.attachContractDocument(id, {
        docType: fields.doc_type || 'contract_document',
        file: file ? { buffer: file.buffer, mime: file.mime, originalName: file.originalName } : null,
        expiresAt: followupsLib.dateToMs(fields.expires_at),
        notes: fields.notes || '',
        by: 'admin',
      });
    } catch (err) {
      return res.redirect(`/admin/contracts/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
    }
    res.redirect(`/admin/contracts/${encodeURIComponent(id)}`);
  })
);

// --- Driver: referral code page ---
app.get('/d/:token/referral', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const code = await referralsLib.getActiveCodeForUser('driver', driver.id);
  const baseUrl = (site.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
  const progress = await referralsLib.referrerProgress(driver.id);
  page(res, 'My referral code', phase6Views.driverReferralHtml({ driver, code, baseUrl, progress, program: referralsLib.PROGRAM }), site);
}));

// --- Driver: documents (own, non-sensitive only) ---
const docLimiter = publicRateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

app.get('/d/:token/documents', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const docs = (await documentsLib.listDocuments({ ownerType: 'driver', ownerId: driver.id }))
    .filter((d) => !documentsLib.isSensitive(d.doc_type));
  page(res, 'My documents', phase6Views.driverDocumentsHtml({ driver, docs, error: req.query.error || '' }), site);
}));

app.post('/d/:token/documents/upload',
  requireDriver,
  docLimiter,
  express.raw({ type: 'multipart/form-data', limit: '10mb' }),
  ah(async (req, res) => {
    const site = config.getSite();
    const driver = req.driver;
    const fail = async (error) => {
      const docs = (await documentsLib.listDocuments({ ownerType: 'driver', ownerId: driver.id }))
        .filter((d) => !documentsLib.isSensitive(d.doc_type));
      res.status(400);
      page(res, 'My documents', phase6Views.driverDocumentsHtml({ driver, docs, error }), site);
    };
    let fields, file;
    try {
      ({ fields, file } = multipart.parseMultipart(req, {
        maxFileBytes: documentsLib.MAX_FILE_BYTES,
        allowedMimes: documentsLib.ALLOWED_MIMES,
      }));
    } catch (err) {
      return fail(err.message);
    }
    try {
      await documentsLib.uploadDocument({
        ownerType: 'driver',
        ownerId: driver.id,
        docType: fields.doc_type,
        file: file ? { buffer: file.buffer, mime: file.mime, originalName: file.originalName } : null,
        uploadedBy: driver.full_name,
        uploadedByRole: 'driver',
        expiresAt: followupsLib.dateToMs(fields.expires_at),
        notes: '',
      });
    } catch (err) {
      return fail(err.message);
    }
    res.redirect(`/d/${driver.access_token}/documents`);
  })
);

app.get('/d/:token/documents/:id/download', requireDriver, ah(async (req, res) => {
  const doc = await documentsLib.getDocument(req.params.id);
  // Drivers may only ever see/download their OWN non-sensitive documents.
  if (!documentsLib.canView(doc, { role: 'driver', ownerId: req.driver.id })) {
    return res.status(403).type('text').send('Not found.');
  }
  if (!doc.file_blob) return res.status(404).type('text').send('No file attached.');
  res.type(doc.file_mime || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${String(doc.file_name || 'document').replace(/"/g, '')}"`);
  res.send(Buffer.from(doc.file_blob));
}));

// --- Phase 2: extended driver onboarding, opportunity database, matching -----
// Additive — existing routes untouched. Admin routes use the explicit
// adminAuth pattern (registered before app.use('/admin', adminAuth)).

// Extended driver application: token-scoped, shared by operations with a
// specific candidate once an opportunity/dispatch relationship is relevant.
// NOT in the public nav — not a second public free-for-all.
app.get('/drivers/apply/:token', ah(async (req, res) => {
  const driver = await drivers.getDriverByToken(req.params.token);
  if (!driver) {
    return res.status(404).type('text')
      .send('This application link was not found. Ask TransitNow operations for a new link.');
  }
  const site = config.getSite();
  page(res, 'Driver Application', driverViews.driverApplyPage({ site, driver }), site);
}));

app.post('/drivers/apply/:token', growLimiter, ah(async (req, res) => {
  const driver = await drivers.getDriverByToken(req.params.token);
  if (!driver) {
    return res.status(404).type('text').send('This application link was not found.');
  }
  const site = config.getSite();
  const { ok, errors, clean } = drivers.validateExtendedApplication(req.body || {});
  if (!ok) {
    res.status(400);
    return page(
      res, 'Driver Application',
      driverViews.driverApplyPage({ site, driver, errors, prefill: req.body || {} }), site
    );
  }
  const updated = await drivers.submitExtendedApplication(driver.id, clean, { by: 'driver' });
  const dashUrl = drivers.driverDashUrl(updated.access_token);
  // Notifications via the existing outbox queue (verified in outbox only —
  // delivery beyond the queue is never claimed).
  await drivers.queueDriverEmail({
    to: updated.email,
    subject: 'TransitNow — we received your driver application',
    html: drivers.extendedApplicationDriverEmail(updated, dashUrl),
    sequence: 'driver-ops',
    step: 'extended-application-confirmation',
  });
  await drivers.notifyOps(
    `New extended driver application: ${updated.full_name}`,
    drivers.extendedApplicationOpsEmail(updated, `${drivers.baseUrl()}/admin/drivers/${updated.id}/profile`),
    'extended-application-new'
  );
  await db.recordEvent({
    visitor_id: req.vid || null,
    lead_id: req.leadId || null,
    type: 'driver_application_submitted',
    product_id: null,
    meta: { driver_id: updated.id },
  });
  page(res, 'Application received', driverViews.driverApplyDonePage({ site, driver: updated, dashUrl }), site);
}));

// --- Phase 2: opportunity database (admin) --------------------------------------
app.get('/admin/opportunities', adminAuth, ah(async (req, res) => {
  const status = opps.OPPORTUNITY_STATUSES.includes(req.query.status) ? req.query.status : null;
  const [list, counts] = await Promise.all([
    opps.listOpportunities({ status }),
    opps.countOpportunitiesByStatus(),
  ]);
  res.send(adminViews.adminLayout('Opportunities',
    oppViews.opportunityListHtml({ list, counts, statusFilter: status })));
}));

app.get('/admin/opportunities/new', adminAuth, ah(async (req, res) => {
  res.send(adminViews.adminLayout('New opportunity', oppViews.opportunityFormHtml({})));
}));

app.post('/admin/opportunities', adminAuth, ah(async (req, res) => {
  const { ok, errors, clean } = opps.validateOpportunity(req.body || {});
  if (!ok) {
    return res.send(adminViews.adminLayout('New opportunity',
      oppViews.opportunityFormHtml({ opportunity: req.body || {}, errors })));
  }
  const created = await opps.createOpportunity(clean, { by: 'admin' });
  res.redirect(`/admin/opportunities/${created.id}`);
}));

async function renderOpportunityDetail(req, res) {
  const o = await opps.getOpportunity(req.params.id);
  if (!o) return res.status(404).type('text').send('Opportunity not found');
  const matches = await opps.listMatchesForOpportunity(o.id);
  const people = {};
  for (const m of matches) {
    const s = await opps.personSummary(m.person_type, m.person_id);
    if (s) people[`${m.person_type}:${m.person_id}`] = s;
  }
  const [leads, driversList] = await Promise.all([
    db.all('SELECT id, first_name, last_name, email, lead_type, status FROM opportunity_leads ORDER BY created_at DESC LIMIT 200'),
    drivers.listDrivers({ limit: 500 }),
  ]);
  let compare = null;
  let compareLabel = '';
  if (req.query.compare_lead) {
    const lead = await db.get('SELECT * FROM opportunity_leads WHERE id = ?', [req.query.compare_lead]);
    if (lead) {
      compare = {
        rows: await opps.compareCandidate(o, { lead }),
        personType: 'lead',
        personId: lead.id,
      };
      compareLabel = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || lead.email;
    }
  } else if (req.query.compare_driver) {
    const driver = await drivers.getDriverById(req.query.compare_driver);
    if (driver) {
      compare = {
        rows: await opps.compareCandidate(o, { driver }),
        personType: 'driver',
        personId: driver.id,
      };
      compareLabel = driver.full_name;
    }
  }
  res.send(adminViews.adminLayout(`Opportunity — ${o.name}`,
    oppViews.opportunityDetailHtml({
      opportunity: o, matches, people, leads, driversList, compare, compareLabel,
      error: req.query.error || '',
    })));
}

app.get('/admin/opportunities/:id', adminAuth, ah(renderOpportunityDetail));

app.get('/admin/opportunities/:id/edit', adminAuth, ah(async (req, res) => {
  const o = await opps.getOpportunity(req.params.id);
  if (!o) return res.status(404).type('text').send('Opportunity not found');
  res.send(adminViews.adminLayout(`Edit — ${o.name}`, oppViews.opportunityFormHtml({ opportunity: o })));
}));

app.post('/admin/opportunities/:id', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  const { ok, errors, clean } = opps.validateOpportunity(req.body || {});
  if (!ok) {
    return res.send(adminViews.adminLayout('Edit opportunity',
      oppViews.opportunityFormHtml({ opportunity: { ...(req.body || {}), id }, errors })));
  }
  try {
    await opps.updateOpportunity(id, clean);
  } catch (err) {
    return res.redirect(`/admin/opportunities/${encodeURIComponent(id)}/edit?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/opportunities/${id}`);
}));

app.post('/admin/opportunities/:id/status', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await opps.setOpportunityStatus(id, req.body.status, { by: 'admin' });
  } catch (err) {
    return res.redirect(`/admin/opportunities/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/opportunities/${id}`);
}));

// Record a Potential Match from the opportunity page. The copy everywhere
// calls it a "Potential Match" — never hired, never promised.
app.post('/admin/opportunities/:id/match', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await opps.recordMatch({
      opportunityId: id,
      personType: req.body.person_type,
      personId: Number(req.body.person_id),
      note: req.body.note || '',
      by: 'admin',
    });
  } catch (err) {
    return res.redirect(`/admin/opportunities/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/opportunities/${id}`);
}));

// --- Tier-based route matching (dispatch plans, admin) ---------------------------
// Additive. Matches come only from real OPEN opportunities; only ACTIVE
// subscribers are matched (Complete first, then Basic).
const routeMatchViews = require('./views/route_matches');
const routeMatching = require('./lib/route_matching');

app.get('/admin/route-matches', adminAuth, ah(async (req, res) => {
  const driverFilter = req.query.driver ? Number(req.query.driver) : null;
  const ai = require('./lib/ai_assistant');
  const [cycles, driversList, opportunities] = await Promise.all([
    routeMatching.recentCycles(20),
    drivers.listDrivers({ limit: 500 }),
    opps.listOpportunities({ status: 'OPEN' }),
  ]);
  // Private operations assistant queue: pending questions + tier badges.
  const assistantQuestions = await ai.listPending(100);
  const subMap = await subscriptions.mapForEmails(assistantQuestions.map((q) => q.driver_email));
  let matches;
  if (driverFilter) {
    matches = await routeMatching.matchesForDriver(driverFilter, 100);
  } else {
    matches = await db.all(
      `SELECT m.*, o.name AS opportunity_name, o.location AS opportunity_location,
              d.full_name AS driver_name
         FROM driver_route_matches m
         LEFT JOIN opportunities o ON o.id = m.opportunity_id
         LEFT JOIN drivers d ON d.id = m.driver_id
        ORDER BY m.matched_at DESC, m.id DESC LIMIT 100`
    );
  }
  res.send(adminViews.adminLayout('Route matching', routeMatchViews.adminPageHtml({
    cycles, matches, driversList, opportunities,
    driverFilter, error: req.query.error || '',
    assistantQuestions, subMap,
  })));
}));

app.post('/admin/route-matches/run', adminAuth, ah(async (req, res) => {
  const r = await routeMatching.runMondayCycle({ force: true });
  res.redirect('/admin/route-matches');
}));

// --- Private operations assistant: operator answers a driver question -------
// The answer is stored and the driver is notified (email now, queued text).
// The app never generates an answer on its own.
app.post('/admin/assistant-questions/:id/answer', adminAuth, ah(async (req, res) => {
  const ai = require('./lib/ai_assistant');
  try {
    await ai.answerQuestion(Number(req.params.id), req.body.answer, { by: 'admin' });
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error',
      `<p>${esc(err.message)}</p><p><a href="/admin/route-matches">&larr; Back to route matching</a></p>`));
  }
  res.redirect('/admin/route-matches');
}));

// --- Dispatcher area: real logins behind /dispatch/* --------------------------------
// Dispatchers get their own email+password logins (lib/dispatch_auth.js) —
// the shared ADMIN_TOKEN stays Davena-only, and there is no public
// self-signup: accounts are created only on /admin/dispatchers.
// Guards: requireDispatcher (dispatcher session only) and dispatcherOrAdmin
// (dispatcher session OR Davena's admin session — anonymous users are
// bounced to /dispatch/login either way; nothing here is public).
const fieldCommsViews = require('./views/field_comms');

function setDispatchSession(res, token) {
  tracking.setCookie(res, dispatchAuth.SESSION_COOKIE, token, { maxAge: dispatchAuth.SESSION_TTL_MS / 1000 });
}
function clearDispatchSession(res) {
  tracking.setCookie(res, dispatchAuth.SESSION_COOKIE, '', { maxAge: 0 });
}

const requireDispatcher = ah(async (req, res, next) => {
  const cookies = req.cookies || tracking.getCookies(req);
  const dispatcher = await dispatchAuth.getSessionDispatcher(cookies[dispatchAuth.SESSION_COOKIE]);
  if (!dispatcher) {
    return res.redirect('/dispatch/login?next=' + encodeURIComponent(req.originalUrl || '/dispatch/today'));
  }
  // Admin-issued temporary password: force the change screen before anything else.
  if (dispatcher.must_change_password === 1 &&
      !req.path.startsWith('/dispatch/change-password') &&
      req.path !== '/dispatch/logout') {
    return res.redirect('/dispatch/change-password?forced=1');
  }
  req.dispatcher = dispatcher;
  next();
});

const dispatcherOrAdmin = ah(async (req, res, next) => {
  if (checkAdmin(req, res)) { req.isAdmin = true; return next(); }
  const cookies = req.cookies || tracking.getCookies(req);
  const dispatcher = await dispatchAuth.getSessionDispatcher(cookies[dispatchAuth.SESSION_COOKIE]);
  if (!dispatcher) {
    return res.redirect('/dispatch/login?next=' + encodeURIComponent(req.originalUrl || '/dispatch/today'));
  }
  // Admin-issued temporary password: force the change screen before anything
  // else (same guard as requireDispatcher — a temp-password session must not
  // reach the board, field-comms, or ticket actions until changed).
  if (dispatcher.must_change_password === 1 &&
      !req.path.startsWith('/dispatch/change-password') &&
      req.path !== '/dispatch/logout') {
    return res.redirect('/dispatch/change-password?forced=1');
  }
  req.dispatcher = dispatcher;
  next();
});

// Login / logout (public pages; the login form itself is the gate).
app.get('/dispatch/login', (req, res) => {
  res.send(dispatchViews.loginPageHtml({ next: req.query.next || '' }));
});

app.post('/dispatch/login', ah(async (req, res) => {
  const nextRaw = String(req.body.next || '/dispatch/today');
  const safeNext = nextRaw.startsWith('/dispatch/') ? nextRaw : '/dispatch/today';
  try {
    const result = await dispatchAuth.attemptLogin(req.body.email || '', req.body.password || '', clientIp(req));
    if (!result) {
      return res.send(dispatchViews.loginPageHtml({ error: dispatchAuth.INVALID_MSG, next: safeNext }));
    }
    setDispatchSession(res, result.token);
    if (result.dispatcher.must_change_password === 1) return res.redirect('/dispatch/change-password?forced=1');
    res.redirect(safeNext);
  } catch (err) {
    if (err.code === 'locked') {
      return res.status(429).send(dispatchViews.loginPageHtml({ error: err.message, next: safeNext }));
    }
    throw err;
  }
}));

app.get('/dispatch/logout', ah(async (req, res) => {
  const cookies = req.cookies || tracking.getCookies(req);
  await dispatchAuth.destroySession(cookies[dispatchAuth.SESSION_COOKIE]);
  clearDispatchSession(res);
  res.redirect('/dispatch/login');
}));

// Self-service password reset: generic responses always (no enumeration);
// the email queues through the existing email_queue pipeline.
app.get('/dispatch/forgot', (req, res) => {
  res.send(dispatchViews.forgotPageHtml({}));
});
app.post('/dispatch/forgot', ah(async (req, res) => {
  try {
    await dispatchAuth.forgotPassword(
      req.body.email || '', clientIp(req), `${req.protocol}://${req.get('host')}`);
    res.send(dispatchViews.forgotPageHtml({ message: dispatchAuth.FORGOT_GENERIC_MSG }));
  } catch (err) {
    if (err.code === 'forgot_locked') {
      return res.status(429).send(dispatchViews.forgotPageHtml({ error: err.message }));
    }
    throw err;
  }
}));
app.get('/dispatch/reset/:token', ah(async (req, res) => {
  const v = await dispatchAuth.validateResetToken(req.params.token);
  if (!v) {
    return res.status(400).send(dispatchViews.dispatcherLayout('Reset password',
      '<div class="error-box"><strong>This reset link is invalid or has expired.</strong></div>' +
      '<p><a href="/dispatch/forgot">Request a new link</a></p>', null));
  }
  res.send(dispatchViews.resetPageHtml({ token: req.params.token }));
}));
app.post('/dispatch/reset/:token', ah(async (req, res) => {
  try {
    const { token: sessToken } = await dispatchAuth.resetPasswordWithToken(
      req.params.token, req.body.password, req.body.password2);
    setDispatchSession(res, sessToken);
    res.redirect('/dispatch/today');
  } catch (err) {
    if (err.code === 'bad_token') {
      return res.status(400).send(dispatchViews.dispatcherLayout('Reset password',
        `<div class="error-box"><strong>${esc(err.message)}</strong></div>` +
        '<p><a href="/dispatch/forgot">Request a new link</a></p>', null));
    }
    res.send(dispatchViews.resetPageHtml({ token: req.params.token, error: err.message }));
  }
}));

// Change password (logged-in dispatchers; forced after a temp password).
app.get('/dispatch/change-password', requireDispatcher, (req, res) => {
  res.send(dispatchViews.changePasswordPageHtml({
    dispatcher: req.dispatcher, forced: req.query.forced === '1' || req.dispatcher.must_change_password === 1,
  }));
});
app.post('/dispatch/change-password', requireDispatcher, ah(async (req, res) => {
  try {
    await dispatchAuth.changePassword(req.dispatcher.id, req.body.current, req.body.password, req.body.password2);
    req.dispatcher = await dispatchAuth.getDispatcherById(req.dispatcher.id);
    res.send(dispatchViews.changePasswordPageHtml({ dispatcher: req.dispatcher, ok: 'Password changed.' }));
  } catch (err) {
    res.send(dispatchViews.changePasswordPageHtml({
      dispatcher: req.dispatcher, error: err.message, forced: req.dispatcher.must_change_password === 1,
    }));
  }
}));

// --- Dispatcher's daily board ----------------------------------------------------
// One screen per date (default: today, Chicago). Auto-refreshes every 60s.
// Live counts from the real tables via lib/dispatch_board.js.
app.get('/dispatch/today', dispatcherOrAdmin, ah(async (req, res) => {
  const board = await dispatchBoard.boardForDate(req.query.date);
  res.send(dispatchViews.boardPageHtml({ board, dispatcher: req.dispatcher || null }));
}));
app.get('/dispatch/today.json', dispatcherOrAdmin, ah(async (req, res) => {
  const board = await dispatchBoard.boardForDate(req.query.date);
  res.json({
    date: board.date,
    summary: board.summary,
    summaryHtml: dispatchViews.summaryStripHtml(board.summary),
    html: board.routes.length
      ? board.routes.map(dispatchViews.routeCardHtml).join('\n')
      : `<div class="route-card"><p class="muted">No routes scheduled for ${dispatchViews.esc(board.date)}.</p></div>`,
  });
}));

// Read-only route detail for dispatchers. Uses dispatcherOrAdmin (a dispatcher
// session cannot open /admin/routes/:id), and renders no mutation forms —
// status/package changes stay admin-only.
app.get('/dispatch/routes/:id', dispatcherOrAdmin, ah(async (req, res) => {
  const route = await drivers.getRouteById(req.params.id);
  if (!route) {
    return res.status(404).send(dispatchViews.dispatcherLayout('Not found',
      '<p>Route not found.</p><p><a href="/dispatch/today">&larr; Back to the board</a></p>',
      req.dispatcher || null));
  }
  const [driver, packages, counts, progress] = await Promise.all([
    route.driver_id ? drivers.getDriverById(route.driver_id) : null,
    drivers.listPackages({ routeId: route.id }),
    drivers.countPackagesByStatus(route.id),
    drivers.getRouteProgress(route.id),
  ]);
  res.send(dispatchViews.dispatcherLayout('Route ' + (route.route_code || route.id),
    dispatchViews.routeDetailHtml({ route, driver, packages, counts, progress }),
    req.dispatcher || null));
}));

// --- Dispatch <-> driver field communications (moved under /dispatch/*) ---------
// Urgent driver->dispatch contact reuses the existing support ticket system
// (priority='urgent' tickets already email ops immediately); the siren
// banner makes them can't-miss until acknowledged. Dispatch->driver
// (broadcasts + direct messages) rides the existing email_queue pipeline +
// SMS stub. Anonymous users are bounced to /dispatch/login.

app.get('/dispatch/field-comms', dispatcherOrAdmin, ah(async (req, res) => {
  const fc = require('./lib/field_comms');
  const [unacked, broadcasts] = await Promise.all([
    fc.unackedUrgentTickets(50),
    fc.recentBroadcasts(20),
  ]);
  res.send(dispatchViews.fieldCommsPageHtml({
    unacked, broadcasts,
    error: req.query.error || '',
    sent: req.query.sent || '',
    dispatcher: req.dispatcher || null,
  }));
}));

app.post('/dispatch/field-comms/broadcast', dispatcherOrAdmin, ah(async (req, res) => {
  const fc = require('./lib/field_comms');
  try {
    const { audience, driverCount } = await fc.sendBroadcast({
      audience: req.body.audience,
      subject: req.body.subject,
      message: req.body.message,
    });
    res.redirect(`/dispatch/field-comms?sent=${encodeURIComponent(
      `Broadcast sent to ${driverCount} driver${driverCount === 1 ? '' : 's'} (${fc.audienceLabel(audience)}).`
    )}`);
  } catch (err) {
    res.redirect(`/dispatch/field-comms?error=${encodeURIComponent(err.message)}`);
  }
}));

// Acknowledge an urgent ticket's siren: moves it off 'open' via the existing
// ticket status path (no new tables).
app.post('/dispatch/tickets/:ticketId/acknowledge', dispatcherOrAdmin, ah(async (req, res) => {
  const fc = require('./lib/field_comms');
  const back = req.get('referer') || '/dispatch/field-comms';
  try {
    await fc.ackUrgentTicket(req.params.ticketId);
  } catch (err) {
    const body = `<p>${esc(err.message)}</p><p><a href="${esc(back)}">&larr; Back</a></p>`;
    return res.status(400).send(req.isAdmin
      ? adminViews.adminLayout('Error', body)
      : dispatchViews.dispatcherLayout('Error', body, req.dispatcher || null));
  }
  res.redirect(back);
}));

// Dispatcher -> one driver: queues email + provider-pending SMS, stores inbox row.
// Active subscribers only.
app.post('/dispatch/drivers/:id/message', dispatcherOrAdmin, ah(async (req, res) => {
  const fc = require('./lib/field_comms');
  try {
    await fc.messageDriver(Number(req.params.id), req.body.subject, req.body.message);
  } catch (err) {
    if (req.isAdmin) {
      return res.redirect(`/admin/drivers/${encodeURIComponent(req.params.id)}?msg=${encodeURIComponent('error: ' + err.message)}`);
    }
    return res.redirect(`/dispatch/field-comms?error=${encodeURIComponent(err.message)}`);
  }
  if (req.isAdmin) {
    return res.redirect(`/admin/drivers/${encodeURIComponent(req.params.id)}?msg=sent`);
  }
  res.redirect(`/dispatch/field-comms?sent=${encodeURIComponent('Message sent to the driver.')}`);
}));

// --- Admin: dispatcher account management (Davena only, existing adminAuth) ------
// No public self-signup anywhere — accounts are created here.
app.get('/admin/dispatchers', adminAuth, ah(async (req, res) => {
  const list = await dispatchAuth.listDispatchers();
  res.send(adminViews.adminLayout('Dispatcher accounts', dispatchViews.dispatchersAdminHtml({ dispatchers: list })));
}));

app.post('/admin/dispatchers', adminAuth, ah(async (req, res) => {
  const render = async (extra) => {
    const list = await dispatchAuth.listDispatchers();
    res.send(adminViews.adminLayout('Dispatcher accounts',
      dispatchViews.dispatchersAdminHtml({ dispatchers: list, ...extra })));
  };
  try {
    const d = await dispatchAuth.createDispatcher({
      name: req.body.name, email: req.body.email, password: req.body.password,
    });
    await render({ created: { name: d.name, email: d.email, password: req.body.password } });
  } catch (err) {
    await render({ error: err.message });
  }
}));

app.post('/admin/dispatchers/:id/active', adminAuth, ah(async (req, res) => {
  await dispatchAuth.setDispatcherActive(req.params.id, req.body.active === '1');
  res.redirect('/admin/dispatchers');
}));

// Admin fallback password reset: one-time temporary password shown ONCE
// (works tonight — no email needed). Stored hashed; forces a change on login.
app.post('/admin/dispatchers/:id/reset-password', adminAuth, ah(async (req, res) => {
  const render = async (extra) => {
    const list = await dispatchAuth.listDispatchers();
    res.send(adminViews.adminLayout('Dispatcher accounts',
      dispatchViews.dispatchersAdminHtml({ dispatchers: list, ...extra })));
  };
  try {
    const { dispatcher, tempPassword } = await dispatchAuth.issueTempPassword(req.params.id);
    await render({ tempShown: { name: dispatcher.name, email: dispatcher.email, password: tempPassword } });
  } catch (err) {
    await render({ error: err.message });
  }
}));

app.post('/admin/route-matches/assign', adminAuth, ah(async (req, res) => {
  try {
    await routeMatching.assignMatch(Number(req.body.driver_id), Number(req.body.opportunity_id), { by: 'admin' });
  } catch (err) {
    return res.redirect(`/admin/route-matches?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect('/admin/route-matches');
}));

app.post('/admin/route-matches/:id/release', adminAuth, ah(async (req, res) => {
  try {
    await routeMatching.releaseMatch(Number(req.params.id), 'admin-release');
  } catch (err) {
    return res.redirect(`/admin/route-matches?error=${encodeURIComponent(err.message)}`);
  }
  const back = req.get('referer') || '/admin/route-matches';
  res.redirect(back);
}));

// --- Phase 3: contract hub, territories, operations command center -------------
// Additive — existing routes untouched. Admin routes use the explicit
// adminAuth pattern (registered before app.use('/admin', adminAuth)).

app.get('/admin/contracts', adminAuth, ah(async (req, res) => {
  const status = contracts.CONTRACT_STATUSES.includes(String(req.query.status || '').toUpperCase())
    ? String(req.query.status).toUpperCase() : null;
  const [list, counts] = await Promise.all([
    contracts.listContracts({ status }),
    contracts.countContractsByStatus(),
  ]);
  res.send(adminViews.adminLayout('Contract hub',
    contractViews.contractListHtml({ list, counts, statusFilter: status })));
}));

app.get('/admin/contracts/new', adminAuth, ah(async (req, res) => {
  res.send(adminViews.adminLayout('New contract', contractViews.contractFormHtml({})));
}));

app.post('/admin/contracts', adminAuth, ah(async (req, res) => {
  const { ok, errors, clean } = contracts.validateContract(req.body || {});
  if (!ok) {
    return res.send(adminViews.adminLayout('New contract',
      contractViews.contractFormHtml({ contract: req.body || {}, errors })));
  }
  const created = await contracts.createContract(clean, { by: 'admin' });
  res.redirect(`/admin/contracts/${created.id}`);
}));

async function renderContractDetail(req, res) {
  const c = await contracts.getContract(req.params.id);
  if (!c) return res.status(404).type('text').send('Contract not found');
  const [history, documents, opportunity, relatedOpps, linkedRoutes, allOpportunities] = await Promise.all([
    contracts.listContractHistory(c.id),
    // Phase 6: contract documents wired into document management (real
    // upload/verification treatment; the rows carry document_id links).
    documentsLib.listContractDocuments(c.id),
    contracts.getLinkedOpportunity(c.id),
    contracts.relatedOpportunities(c),
    contracts.listRoutesForContract(c.contract_number),
    opps.listOpportunities({}),
  ]);
  res.send(adminViews.adminLayout(`Contract — ${c.contract_name}`,
    contractViews.contractDetailHtml({
      contract: c, history, documents, opportunity, relatedOpps, linkedRoutes,
      allOpportunities, error: req.query.error || '',
    })));
}

app.get('/admin/contracts/:id', adminAuth, ah(renderContractDetail));

app.get('/admin/contracts/:id/edit', adminAuth, ah(async (req, res) => {
  const c = await contracts.getContract(req.params.id);
  if (!c) return res.status(404).type('text').send('Contract not found');
  res.send(adminViews.adminLayout(`Edit — ${c.contract_name}`,
    contractViews.contractFormHtml({ contract: c, isNew: false })));
}));

app.post('/admin/contracts/:id', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  const { ok, errors, clean } = contracts.validateContract(req.body || {});
  if (!ok) {
    return res.send(adminViews.adminLayout('Edit contract',
      contractViews.contractFormHtml({ contract: { ...(req.body || {}), id }, errors, isNew: false })));
  }
  try {
    await contracts.updateContract(id, clean);
  } catch (err) {
    return res.redirect(`/admin/contracts/${encodeURIComponent(id)}/edit?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/contracts/${id}`);
}));

app.post('/admin/contracts/:id/status', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await contracts.setContractStatus(id, req.body.status, { by: 'admin', note: req.body.note || '' });
  } catch (err) {
    return res.redirect(`/admin/contracts/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/contracts/${id}`);
}));

app.post('/admin/contracts/:id/opportunity', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await contracts.linkOpportunity(id, req.body.opportunity_id);
  } catch (err) {
    return res.redirect(`/admin/contracts/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/contracts/${id}`);
}));

app.post('/admin/contracts/:id/route', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await contracts.attachRoute(id, req.body.route_code || '');
  } catch (err) {
    return res.redirect(`/admin/contracts/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/contracts/${id}`);
}));

// Document REFERENCES only — full upload/storage deferred to Phase 6.
app.post('/admin/contracts/:id/document', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await contracts.addDocumentRef(id, {
      doc_type: req.body.doc_type || '',
      file_name: req.body.file_name || '',
      notes: req.body.notes || '',
      by: 'admin',
    });
  } catch (err) {
    return res.redirect(`/admin/contracts/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/contracts/${id}`);
}));

// --- Phase 3: territories --------------------------------------------------------
app.get('/admin/territories', adminAuth, ah(async (req, res) => {
  // Support ?name= deep links (e.g. from the contract page): jump straight
  // to the matching territory instead of showing the list.
  if (req.query.name) {
    const t = await territories.getTerritoryByName(String(req.query.name));
    if (t) return res.redirect(`/admin/territories/${t.id}`);
  }
  const list = await territories.listTerritories();
  const statsById = {};
  for (const t of list) statsById[t.id] = await territories.territoryStats(t);
  res.send(adminViews.adminLayout('Territories',
    territoryViews.territoryListHtml({ list, statsById })));
}));

app.get('/admin/territories/new', adminAuth, ah(async (req, res) => {
  res.send(adminViews.adminLayout('New territory', territoryViews.territoryFormHtml({})));
}));

app.post('/admin/territories', adminAuth, ah(async (req, res) => {
  const { ok, errors, clean } = territories.validateTerritory(req.body || {});
  if (!ok) {
    return res.send(adminViews.adminLayout('New territory',
      territoryViews.territoryFormHtml({ territory: req.body || {}, errors })));
  }
  try {
    const created = await territories.createTerritory(clean, { by: 'admin' });
    return res.redirect(`/admin/territories/${created.id}`);
  } catch (err) {
    return res.send(adminViews.adminLayout('New territory',
      territoryViews.territoryFormHtml({ territory: req.body || {}, errors: [err.message] })));
  }
}));

app.get('/admin/territories/:id', adminAuth, ah(async (req, res) => {
  const t = await territories.getTerritory(req.params.id);
  if (!t) return res.status(404).type('text').send('Territory not found');
  const [stats, tContracts, tOpps, tDrivers] = await Promise.all([
    territories.territoryStats(t),
    territories.territoryContracts(t.name),
    territories.territoryOpportunities(t),
    territories.territoryDrivers(t),
  ]);
  res.send(adminViews.adminLayout(`Territory — ${t.name}`,
    territoryViews.territoryDetailHtml({
      territory: t, stats, contracts: tContracts, opportunities: tOpps,
      drivers: tDrivers, error: req.query.error || '',
    })));
}));

app.get('/admin/territories/:id/edit', adminAuth, ah(async (req, res) => {
  const t = await territories.getTerritory(req.params.id);
  if (!t) return res.status(404).type('text').send('Territory not found');
  res.send(adminViews.adminLayout(`Edit — ${t.name}`,
    territoryViews.territoryFormHtml({ territory: t, isNew: false })));
}));

app.post('/admin/territories/:id', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  const existing = await territories.getTerritory(id);
  if (!existing) return res.status(404).type('text').send('Territory not found');
  const { ok, errors, clean } = territories.validateTerritory(req.body || {}, { existing });
  if (!ok) {
    return res.send(adminViews.adminLayout('Edit territory',
      territoryViews.territoryFormHtml({ territory: { ...(req.body || {}), id }, errors, isNew: false })));
  }
  try {
    await territories.updateTerritory(id, clean);
  } catch (err) {
    return res.send(adminViews.adminLayout('Edit territory',
      territoryViews.territoryFormHtml({ territory: { ...(req.body || {}), id }, errors: [err.message], isNew: false })));
  }
  res.redirect(`/admin/territories/${id}`);
}));

// --- Phase 2: extended driver profile (admin) --------------------------------------
app.get('/admin/drivers/:id/profile', adminAuth, ah(async (req, res) => {
  const driver = await drivers.getDriverById(req.params.id);
  if (!driver) return res.status(404).type('text').send('Driver not found');
  const [qualChecks, onboardHistory, routes, packages, exceptions, tickets, planHistory, matches, leadLink, opportunities] =
    await Promise.all([
      drivers.getQualChecks(driver.id),
      drivers.getOnboardHistory(driver.id),
      drivers.listRoutes({ driverId: driver.id }),
      drivers.listPackages({ driverId: driver.id }),
      drivers.listExceptions({ driverId: driver.id }),
      drivers.listTickets({ driverId: driver.id }),
      drivers.listPlanChanges(driver.id),
      opps.listMatchesForPerson('driver', driver.id),
      opps.getLeadLinkForDriver(driver.id),
      opps.listOpportunities({}),
    ]);
  res.send(adminViews.adminLayout(`Driver profile — ${driver.full_name}`,
    driverExtViews.driverExtendedProfileHtml({
      driver, qualChecks, onboardHistory, routes, packages, exceptions,
      tickets, planHistory, matches, leadLink, opportunities,
      error: req.query.error || '',
    })));
}));

app.post('/admin/drivers/:id/extended-status', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await drivers.setExtendedStatus(id, String(req.body.extended_status || ''), {
      by: 'admin',
      note: req.body.note || '',
      notify: req.body.notify === '1',
    });
  } catch (err) {
    return res.redirect(`/admin/drivers/${encodeURIComponent(id)}/profile?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/drivers/${id}/profile`);
}));

app.post('/admin/drivers/:id/qual-checks', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  const checked = Array.isArray(req.body.checks) ? req.body.checks : (req.body.checks ? [req.body.checks] : []);
  await drivers.syncQualChecks(id, checked, { by: 'admin' });
  res.redirect(`/admin/drivers/${id}/profile`);
}));

// Record a Potential Match from the driver profile.
app.post('/admin/drivers/:id/match', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await opps.recordMatch({
      opportunityId: Number(req.body.opportunity_id),
      personType: 'driver',
      personId: Number(id),
      note: req.body.note || '',
      by: 'admin',
    });
  } catch (err) {
    return res.redirect(`/admin/drivers/${encodeURIComponent(id)}/profile?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/drivers/${id}/profile`);
}));

// --- Phase 2: CRM lead -> driver application ---------------------------------------
// "Start driver application": links the existing opportunity_leads row to a
// driver record (reusing the driver when the email is already known — never
// a duplicate record) and stores the linkage in lead_driver_links.
app.post('/admin/crm/leads/:id/start-driver-application', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await opps.startDriverApplication(id, { by: 'admin', baseUrl: drivers.baseUrl() });
  } catch (err) {
    return res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}?linked=1`);
}));

// Record a Potential Match from the CRM lead profile.
app.post('/admin/crm/leads/:id/match', adminAuth, ah(async (req, res) => {
  const id = req.params.id;
  try {
    await opps.recordMatch({
      opportunityId: Number(req.body.opportunity_id),
      personType: 'lead',
      personId: Number(id),
      note: req.body.note || '',
      by: 'admin',
    });
  } catch (err) {
    return res.redirect(`/admin/crm/leads/${encodeURIComponent(id)}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/crm/leads/${id}`);
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
  const exceptions = await drivers.listExceptions({ packageId: pkg.package_id });
  page(res, pkg.package_id, driverViews.driverPackagePage({ driver, pkg, events, exceptions }), site);
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
    const exceptions = await drivers.listExceptions({ packageId: pkg.package_id });
    return page(res, pkg.package_id, `<section><div class="form-error" role="alert">${err.message}</div></section>` + driverViews.driverPackagePage({ driver, pkg, events, exceptions }), site);
  }
  res.redirect(`/d/${driver.access_token}/packages/${encodeURIComponent(pkg.package_id)}`);
}));

// --- Phase H: driver delivery exceptions (optional photo/proof) ------------------
function requireDriverPackage(req, res, next) {
  // Shared lookup for exception routes: package must belong to the driver.
  drivers.getPackage(req.params.packageId).then((pkg) => {
    if (!pkg || Number(pkg.driver_id) !== Number(req.driver.id)) {
      res.status(404);
      return page(res, 'Not found', '<section><h1>Package not found</h1><p class="subhead">This package is not assigned to you.</p></section>', config.getSite());
    }
    req.pkg = pkg;
    next();
  }).catch(next);
}

app.get('/d/:token/packages/:packageId/exception', requireDriver, requireDriverPackage, ah(async (req, res) => {
  const site = config.getSite();
  page(res, 'Report an exception', driverViews.exceptionFormPage({ driver: req.driver, pkg: req.pkg, error: null }), site);
}));

app.post('/d/:token/packages/:packageId/exception',
  requireDriver,
  requireDriverPackage,
  express.raw({ type: 'multipart/form-data', limit: '10mb' }),
  ah(async (req, res) => {
    const site = config.getSite();
    const driver = req.driver;
    const pkg = req.pkg;
    const fail = (error) => page(res, 'Report an exception', driverViews.exceptionFormPage({ driver, pkg, error }), site);
    let fields, file;
    try {
      ({ fields, file } = multipart.parseMultipart(req, { maxFileBytes: 8 * 1024 * 1024, allowedMimes: PROOF_ALLOWED_MIMES }));
    } catch (err) {
      res.status(400);
      return fail(err.message);
    }
    if (file && fields.photo_confirm !== '1' && fields.photo_confirm !== 'on') {
      res.status(400);
      return fail('Please check the box confirming your photo contains no sensitive personal information.');
    }
    try {
      await drivers.reportException({
        packageId: pkg.package_id,
        driverId: driver.id,
        exception_type: fields.exception_type,
        description: fields.description,
        photo: file ? { buffer: file.buffer, mime: file.mime, originalName: file.originalName } : null,
        createdBy: 'driver',
      });
    } catch (err) {
      res.status(400);
      return fail(err.message);
    }
    res.redirect(`/d/${driver.access_token}/packages/${encodeURIComponent(pkg.package_id)}`);
  })
);

app.get('/d/:token/exceptions/:id/photo', requireDriver, ah(async (req, res) => {
  const ex = await drivers.getException(req.params.id);
  // Only the reporting driver may view their own exception photo.
  if (!ex || Number(ex.driver_id) !== Number(req.driver.id)) return res.status(404).send('Not found');
  const photo = await drivers.getExceptionPhoto(req.params.id);
  if (!photo || !photo.photo_blob) return res.status(404).send('No photo attached.');
  res.type(photo.photo_mime || 'application/octet-stream');
  // node:sqlite returns BLOBs as Uint8Array; Express would JSON-serialize it
  // into garbage bytes. Buffer.from() keeps the original bytes intact.
  res.send(Buffer.from(photo.photo_blob));
}));

// --- Phase I: driver support tickets (urgent alerts routed to operations) -------
function requireDriverTicket(req, res, next) {
  drivers.getTicket(req.params.ticketId).then((t) => {
    if (!t || Number(t.driver_id) !== Number(req.driver.id)) {
      res.status(404);
      return page(res, 'Not found', '<section><h1>Request not found</h1></section>', config.getSite());
    }
    req.ticket = t;
    next();
  }).catch(next);
}

app.get('/d/:token/support', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const tickets = await drivers.listTickets({ driverId: req.driver.id });
  page(res, 'Support', driverViews.supportPage({ driver: req.driver, tickets, error: null }), site);
}));

// --- Private operations assistant (Complete tier) ------------------------------
// Questions go to the operator/AI workflow — the app never generates an
// answer. Only ACTIVE Complete subscribers may ask; everyone else gets the
// same 402 paid-subscribers-only treatment as other dispatch gates.
app.post('/d/:token/assistant', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const ai = require('./lib/ai_assistant');
  const isComplete = await ai.isCompleteActive(driver);
  if (!isComplete) {
    const sub = await subscriptions.getByEmail(driver.email);
    const statusLine = sub && sub.status
      ? `Your dispatch subscription is ${sub.status === 'past_due' ? 'past due' : sub.status} — not active.`
      : 'You do not have an active TransitNow dispatch subscription on file.';
    res.status(402);
    return page(res, 'Payment required', `
<section><h1>Paid subscribers only</h1>
<p>${statusLine}</p>
<p>Your private operations assistant is included with the <strong>Complete $100/month</strong> dispatch plan.</p>
<p>Once your Complete subscription is active (Stripe notifies us automatically, including renewals), you can ask your assistant anything.</p>
<p class="disclosure">Subscriptions are month-to-month. No guaranteed loads, routes, revenue, or earnings.</p>
<p><a href="/d/${driver.access_token}">&larr; Back to your dashboard</a></p></section>`, site);
  }
  try {
    await ai.askQuestion(driver.id, req.body.question);
    res.redirect(`/d/${driver.access_token}`);
  } catch (err) {
    res.status(400);
    const caps400 = require('./lib/ai_capabilities');
    const wk400 = require('./lib/route_matching').chicagoWeekKey();
    const assistantInfo = { isComplete: true, questions: await ai.listForDriver(driver.id, 20),
      capCount: caps400.DRIVER_CAPABILITIES.length,
      spotlight: caps400.weeklySpotlight(caps400.DRIVER_CAPABILITIES, wk400) };
    const rm = require('./lib/route_matching');
    let matchInfo = null;
    try {
      const [matches, prog] = await Promise.all([rm.activeMatches(driver.id), rm.goalProgress(driver.id)]);
      matchInfo = { matches, prog };
    } catch (e2) { /* dashboard still renders without match info */ }
    return page(res, 'My dashboard',
      `<section><p class="error">${esc(req.body.question ? err.message : 'Enter your question first.')}</p></section>` +
      driverViews.dashboardPage({ site, driver, dashUrl: drivers.driverDashUrl(driver.access_token), matchInfo, assistantInfo }), site);
  }
}));

app.post('/d/:token/support', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  try {
    const ticket = await drivers.createTicket({
      driverId: driver.id,
      category: req.body.category,
      priority: req.body.priority === 'urgent' ? 'urgent' : 'normal',
      subject: req.body.subject,
      message: req.body.description,
      createdBy: 'driver',
    });
    res.redirect(`/d/${driver.access_token}/support/${encodeURIComponent(ticket.ticket_id)}`);
  } catch (err) {
    res.status(400);
    const tickets = await drivers.listTickets({ driverId: driver.id });
    return page(res, 'Support', driverViews.supportPage({ driver, tickets, error: err.message }), site);
  }
}));

app.get('/d/:token/support/:ticketId', requireDriver, requireDriverTicket, ah(async (req, res) => {
  const site = config.getSite();
  const replies = await drivers.getTicketReplies(req.ticket.ticket_id);
  page(res, req.ticket.ticket_id, driverViews.ticketDetailPage({ driver: req.driver, ticket: req.ticket, replies, error: null }), site);
}));

app.post('/d/:token/support/:ticketId/reply', requireDriver, requireDriverTicket, ah(async (req, res) => {
  const site = config.getSite();
  try {
    await drivers.addTicketReply({ ticketId: req.ticket.ticket_id, authorType: 'driver', authorId: req.driver.id, message: req.body.message });
  } catch (err) {
    res.status(400);
    const replies = await drivers.getTicketReplies(req.ticket.ticket_id);
    return page(res, req.ticket.ticket_id, driverViews.ticketDetailPage({ driver: req.driver, ticket: req.ticket, replies, error: err.message }), site);
  }
  res.redirect(`/d/${req.driver.access_token}/support/${encodeURIComponent(req.ticket.ticket_id)}`);
}));


// --- Phase 5: live video support — driver routes --------------------------------
// Token-scoped (requireDriver), like the rest of the driver dashboard. Media
// honesty rules (docs/VIDEO_SPEC.md) are absolute on every surface here.
function requireDriverSession(req, res, next) {
  drivers.getSession(req.params.sessionId).then((sess) => {
    if (!sess || Number(sess.driver_id) !== Number(req.driver.id)) {
      res.status(404);
      return page(res, 'Not found', '<section><h1>Session not found</h1></section>', config.getSite());
    }
    req.liveSession = sess;
    next();
  }).catch(next);
}

async function liveSessionProps(driver, sessionId) {
  const s = await drivers.getSession(sessionId);
  const [events, messages, participants, recording] = await Promise.all([
    drivers.getSessionEvents(sessionId),
    drivers.getSessionMessages(sessionId),
    drivers.getSessionParticipants(sessionId),
    drivers.getSessionRecording(sessionId),
  ]);
  return { driver, session: s, events, messages, participants, recording, provider: video.providerStatus() };
}

function renderLiveSessionPage(res, props, error) {
  const site = config.getSite();
  page(res, 'Session ' + props.session.session_id,
    driverViews.liveSessionPage({ ...props, error: error || null }), site);
}

app.get('/d/:token/go-live', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const [activeSession, sessions, trainingEvents] = await Promise.all([
    drivers.getActiveSessionForDriver(req.driver.id),
    drivers.listSessions({ driverId: req.driver.id }),
    drivers.listTrainingEvents({ upcomingOnly: true }),
  ]);
  page(res, 'Go live with operations', driverViews.goLivePage({
    driver: req.driver, activeSession, sessions,
    provider: video.providerStatus(), trainingEvents, error: null, form: null,
  }), site);
}));

async function renderGoLivePage(res, driver, error, form) {
  const site = config.getSite();
  const [activeSession, sessions, trainingEvents] = await Promise.all([
    drivers.getActiveSessionForDriver(driver.id),
    drivers.listSessions({ driverId: driver.id }),
    drivers.listTrainingEvents({ upcomingOnly: true }),
  ]);
  page(res, 'Go live with operations', driverViews.goLivePage({
    driver, activeSession, sessions,
    provider: video.providerStatus(), trainingEvents, error, form,
  }), site);
}

app.post('/d/:token/go-live', requireDriver, liveLimiter, ah(async (req, res) => {
  const driver = req.driver;
  const b = req.body || {};
  try {
    const existing = await drivers.getActiveSessionForDriver(driver.id);
    if (existing) throw new Error('You already have an open session (' + existing.session_id + '). End it before requesting a new one.');
    const session = await drivers.requestLiveSession({
      driverId: driver.id,
      reason: b.reason,
      priority: b.priority,
      notes: b.notes,
      shareLocation: b.share_location === 'on' ? 1 : 0,
    });
    // Record the driver's stated device preferences as a timeline note.
    // Preferences only — nothing activates without explicit confirmation.
    const prefs = `Device preferences for this session: camera ${b.want_camera === 'on' ? 'wanted' : 'not wanted'}, ` +
      `microphone ${b.want_mic === 'on' ? 'wanted' : 'not wanted'}. Nothing activates automatically.`;
    await drivers.logSessionEvent(session.session_id, 'note', 'driver', prefs);
    res.redirect(`/d/${driver.access_token}/go-live/${encodeURIComponent(session.session_id)}`);
  } catch (err) {
    res.status(400);
    await renderGoLivePage(res, driver, err.message, {
      reason: b.reason, priority: b.priority, notes: b.notes,
      want_camera: b.want_camera === 'on', want_mic: b.want_mic === 'on',
      share_location: b.share_location === 'on',
    });
  }
}));

app.get('/d/:token/go-live/:sessionId', requireDriver, requireDriverSession, ah(async (req, res) => {
  renderLiveSessionPage(res, await liveSessionProps(req.driver, req.liveSession.session_id), null);
}));

app.post('/d/:token/go-live/:sessionId/message', requireDriver, requireDriverSession, liveLimiter, ah(async (req, res) => {
  const props = await liveSessionProps(req.driver, req.liveSession.session_id);
  try {
    await drivers.addSessionMessage({
      sessionId: req.liveSession.session_id, senderType: 'driver',
      senderId: req.driver.id, message: req.body.message,
    });
    res.redirect(`/d/${req.driver.access_token}/go-live/${encodeURIComponent(req.liveSession.session_id)}`);
  } catch (err) {
    res.status(400);
    renderLiveSessionPage(res, await liveSessionProps(req.driver, req.liveSession.session_id), err.message);
  }
}));

app.post('/d/:token/go-live/:sessionId/consent', requireDriver, requireDriverSession, liveLimiter, ah(async (req, res) => {
  // Explicit driver confirmation BEFORE their camera/mic may activate.
  try {
    await drivers.recordDriverMediaConsent(req.liveSession.session_id, req.driver.id, {
      camera: req.body.camera === 'on',
      mic: req.body.mic === 'on',
    });
    res.redirect(`/d/${req.driver.access_token}/go-live/${encodeURIComponent(req.liveSession.session_id)}`);
  } catch (err) {
    res.status(400);
    renderLiveSessionPage(res, await liveSessionProps(req.driver, req.liveSession.session_id), err.message);
  }
}));

app.post('/d/:token/go-live/:sessionId/location', requireDriver, requireDriverSession, liveLimiter, ah(async (req, res) => {
  try {
    await drivers.setLocationSharing(req.liveSession.session_id, req.driver.id, req.body.on === '1');
    res.redirect(`/d/${req.driver.access_token}/go-live/${encodeURIComponent(req.liveSession.session_id)}`);
  } catch (err) {
    res.status(400);
    renderLiveSessionPage(res, await liveSessionProps(req.driver, req.liveSession.session_id), err.message);
  }
}));

app.post('/d/:token/go-live/:sessionId/recording-consent', requireDriver, requireDriverSession, liveLimiter, ah(async (req, res) => {
  // Explicit opt-in BEFORE any recording may start. Anything but an explicit
  // "yes" leaves recording OFF.
  try {
    if (req.body.consent !== 'yes') throw new Error('Recording stays off unless you explicitly consent.');
    await drivers.setRecordingConsent(req.liveSession.session_id, {
      consented: true, by: 'driver:' + req.driver.full_name,
    });
    res.redirect(`/d/${req.driver.access_token}/go-live/${encodeURIComponent(req.liveSession.session_id)}`);
  } catch (err) {
    res.status(400);
    renderLiveSessionPage(res, await liveSessionProps(req.driver, req.liveSession.session_id), err.message);
  }
}));

app.post('/d/:token/go-live/:sessionId/end', requireDriver, requireDriverSession, liveLimiter, ah(async (req, res) => {
  try {
    const s = req.liveSession;
    if (!['ACCEPTED', 'LIVE'].includes(s.status)) throw new Error('Only an accepted or live session can be ended.');
    await drivers.endSession(s.session_id, 'driver', 'Ended by driver.');
    res.redirect(`/d/${req.driver.access_token}/go-live/${encodeURIComponent(s.session_id)}`);
  } catch (err) {
    res.status(400);
    renderLiveSessionPage(res, await liveSessionProps(req.driver, req.liveSession.session_id), err.message);
  }
}));

// --- Phase J: private driver community -------------------------------------------

async function communityAuthors(items) {
  const ids = [...new Set(items.map((i) => i.driver_id).filter(Boolean))];
  const map = {};
  for (const id of ids) map[id] = await drivers.getDriverById(id);
  return map;
}

app.get('/d/:token/community', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const category = drivers.COMMUNITY_CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const posts = await drivers.listCommunityPosts({ category });
  const authors = await communityAuthors(posts);
  page(res, 'Driver community', driverViews.communityPage({ driver: req.driver, posts, categoryFilter: category, authors, error: null }), site);
}));

app.post('/d/:token/community', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  try {
    const post = await drivers.createCommunityPost({
      driverId: driver.id, authorType: 'driver',
      category: req.body.category, title: req.body.title, body: req.body.body,
    });
    res.redirect(`/d/${driver.access_token}/community/${post.id}`);
  } catch (err) {
    res.status(400);
    const posts = await drivers.listCommunityPosts({});
    const authors = await communityAuthors(posts);
    return page(res, 'Driver community', driverViews.communityPage({ driver, posts, categoryFilter: null, authors, error: err.message }), site);
  }
}));

app.get('/d/:token/community/:postId', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const post = await drivers.getCommunityPost(req.params.postId);
  if (!post || post.status !== 'visible') {
    res.status(404);
    return page(res, 'Not found', '<section><h1>Post not found</h1></section>', site);
  }
  const comments = await drivers.listCommunityComments(post.id);
  const authors = await communityAuthors([post, ...comments]);
  page(res, post.title, driverViews.communityPostPage({ driver: req.driver, post, comments, authors, error: null }), site);
}));

app.post('/d/:token/community/:postId/comments', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const post = await drivers.getCommunityPost(req.params.postId);
  if (!post || post.status !== 'visible') {
    res.status(404);
    return page(res, 'Not found', '<section><h1>Post not found</h1></section>', site);
  }
  try {
    await drivers.createCommunityComment({ postId: post.id, driverId: driver.id, authorType: 'driver', body: req.body.body });
  } catch (err) {
    res.status(400);
    const comments = await drivers.listCommunityComments(post.id);
    const authors = await communityAuthors([post, ...comments]);
    return page(res, post.title, driverViews.communityPostPage({ driver, post, comments, authors, error: err.message }), site);
  }
  res.redirect(`/d/${driver.access_token}/community/${post.id}`);
}));

app.post('/d/:token/community/report', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  try {
    await drivers.reportCommunityContent({
      postId: req.body.post_id || null,
      commentId: req.body.comment_id || null,
      reporterDriverId: req.driver.id,
      reason: req.body.reason,
    });
  } catch (err) {
    res.status(400);
    return page(res, 'Report', `<section><div class="form-error" role="alert">${err.message}</div></section>`, site);
  }
  page(res, 'Reported', '<section><h1>Thanks</h1><p class="subhead">Operations will review this content.</p><p><a href="/d/' + req.driver.access_token + '/community">&larr; Back to community</a></p></section>', site);
}));

// --- Phase K: driver service plans (request-based; no public activation) ---------
app.get('/d/:token/plan', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  const [plans, settings, currentPlanId, pendingRequest, history] = await Promise.all([
    drivers.getServicePlans({ activeOnly: true }),
    drivers.getPlanSettings(),
    drivers.getDriverPlan(driver.id),
    drivers.getPendingPlanRequest(driver.id),
    drivers.listPlanChanges(driver.id),
  ]);
  page(res, 'Service plans', driverViews.planPage({ driver, plans, settings, currentPlanId, pendingRequest, history, error: null }), site);
}));

app.post('/d/:token/plan/request', requireDriver, ah(async (req, res) => {
  const site = config.getSite();
  const driver = req.driver;
  try {
    await drivers.requestPlanChange(driver.id, req.body.plan_id, req.body.note || '');
  } catch (err) {
    res.status(400);
    const [plans, settings, currentPlanId, pendingRequest, history] = await Promise.all([
      drivers.getServicePlans({ activeOnly: true }),
      drivers.getPlanSettings(),
      drivers.getDriverPlan(driver.id),
      drivers.getPendingPlanRequest(driver.id),
      drivers.listPlanChanges(driver.id),
    ]);
    return page(res, 'Service plans', driverViews.planPage({ driver, plans, settings, currentPlanId, pendingRequest, history, error: err.message }), site);
  }
  res.redirect(`/d/${driver.access_token}/plan`);
}));

// --- Phase G: polling-based route progress (JSON; no real-time claims) ---------
app.get('/d/:token/route/progress', requireDriver, ah(async (req, res) => {
  const route = await drivers.getCurrentRoute(req.driver.id);
  if (!route) return res.status(404).json({ error: 'no_route' });
  res.json(await drivers.getRouteProgress(route.id));
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
  await pipeline.setStage(leadId, 'PAID');
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
  const obj = (event.data && event.data.object) || {};
  // --- Dispatch subscription events ($50/$100) --------------------------------
  // Owned by the dispatch handlers below. Room ($49) events keep flowing to
  // the existing Room handlers, untouched.
  if (event.type === 'invoice.payment_failed') {
    if (subscriptions.isDispatchCents(Number(obj.amount_due))) {
      return handleDispatchPaymentFailed(event, obj);
    }
    return handleFailedRoomPayment(obj);
  }
  if (event.type === 'invoice.payment_succeeded') {
    if (subscriptions.isDispatchCents(Number(obj.amount_paid))) {
      return handleDispatchRenewal(event, obj);
    }
    console.log('[webhook:stripe] ignoring event type', event.type);
    return false;
  }
  if (event.type === 'customer.subscription.deleted') {
    if (subscriptions.planFromSubscriptionObject(obj)) {
      return handleDispatchCanceled(event, obj);
    }
    return handleRoomSubscriptionEnded(obj);
  }
  if (event.type === 'customer.subscription.updated') {
    if (subscriptions.planFromSubscriptionObject(obj)) {
      return handleDispatchUpdated(event, obj);
    }
    console.log('[webhook:stripe] ignoring event type', event.type);
    return false;
  }
  if (event.type !== 'checkout.session.completed') {
    console.log('[webhook:stripe] ignoring event type', event.type);
    return false;
  }
  const session = obj;
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
  // Dispatch subscription checkout (subscription mode): record the
  // subscription by email even when no lead row exists, then keep the
  // existing purchase bookkeeping for known leads (additive).
  if (session.mode === 'subscription' && subscriptions.isDispatchCents(amountCents)) {
    return handleDispatchCheckout(event, session, product);
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

/**
 * Dispatch subscription webhook handlers (paid-client enforcement).
 * These own ONLY TransitNow dispatch amounts ($50/$100). Each is idempotent
 * on the Stripe event id via stripe_processed_events.
 */
function dispatchEmailFromInvoice(inv) {
  const v = inv || {};
  return (
    (v.customer_email ||
      (v.customer_details && v.customer_details.email) ||
      '') + ''
  )
    .trim()
    .toLowerCase();
}

function invoicePeriodEndMs(inv) {
  try {
    const line = inv && inv.lines && inv.lines.data && inv.lines.data[0];
    const end = line && line.period && line.period.end;
    return end ? Number(end) * 1000 : null;
  } catch {
    return null;
  }
}

async function handleDispatchCheckout(event, session, product) {
  const s = session || {};
  const email = ((s.customer_details && s.customer_details.email) || '').trim().toLowerCase();
  const amountCents = Number(s.amount_total);
  const plan = subscriptions.planFromCents(amountCents);
  if (!email || !plan) return false;
  if (await subscriptions.alreadyProcessed(event.id)) {
    console.log('[webhook:stripe] duplicate dispatch checkout event ignored', { eventId: event.id });
    return true;
  }
  await subscriptions.upsertActive({
    email,
    plan,
    stripeCustomerId: s.customer || null,
    stripeSubscriptionId: s.subscription || null,
    currentPeriodEnd: null,
  });
  await subscriptions.markProcessed(event.id, event.type);
  // Keep existing purchase bookkeeping for known leads (additive).
  const lead = await db.get('SELECT * FROM leads WHERE email = ?', [email]);
  if (lead && product) {
    await recordPurchase(lead.id, product.id, 'stripe', { amountCents });
  }
  console.log('[webhook:stripe] dispatch subscription started', { email, plan });
  return true;
}

async function handleDispatchRenewal(event, inv) {
  const v = inv || {};
  const plan = subscriptions.planFromCents(Number(v.amount_paid));
  if (!plan) return false;
  if (await subscriptions.alreadyProcessed(event.id)) {
    console.log('[webhook:stripe] duplicate dispatch renewal event ignored', { eventId: event.id });
    return true;
  }
  await subscriptions.markRenewed({
    stripeCustomerId: v.customer || null,
    stripeSubscriptionId: v.subscription || null,
    email: dispatchEmailFromInvoice(v),
    plan,
    currentPeriodEnd: invoicePeriodEndMs(v),
  });
  await subscriptions.markProcessed(event.id, event.type);
  return true;
}

async function handleDispatchPaymentFailed(event, inv) {
  const v = inv || {};
  const plan = subscriptions.planFromCents(Number(v.amount_due));
  if (!plan) return false;
  if (await subscriptions.alreadyProcessed(event.id)) {
    console.log('[webhook:stripe] duplicate dispatch payment-failed event ignored', { eventId: event.id });
    return true;
  }
  await subscriptions.markPastDue({
    stripeCustomerId: v.customer || null,
    stripeSubscriptionId: v.subscription || null,
    email: dispatchEmailFromInvoice(v),
    invoiceId: v.id || null,
    plan,
  });
  await subscriptions.markProcessed(event.id, event.type);
  return true;
}

async function handleDispatchCanceled(event, sub) {
  const s = sub || {};
  if (!subscriptions.planFromSubscriptionObject(s)) return false;
  if (await subscriptions.alreadyProcessed(event.id)) {
    console.log('[webhook:stripe] duplicate dispatch cancel event ignored', { eventId: event.id });
    return true;
  }
  await subscriptions.markCanceled({
    stripeCustomerId: s.customer || null,
    stripeSubscriptionId: s.id || null,
    email: ((s.customer_details && s.customer_details.email) || s.customer_email || ''),
  });
  await subscriptions.markProcessed(event.id, event.type);
  return true;
}

async function handleDispatchUpdated(event, sub) {
  const s = sub || {};
  if (!subscriptions.planFromSubscriptionObject(s)) return false;
  if (await subscriptions.alreadyProcessed(event.id)) {
    console.log('[webhook:stripe] duplicate dispatch update event ignored', { eventId: event.id });
    return true;
  }
  await subscriptions.syncFromSubscriptionObject(s);
  await subscriptions.markProcessed(event.id, event.type);
  return true;
}

// --- Paid-client gate ---------------------------------------------------------
// The driver application stays FREE. Dispatch work (routes, service-plan
// activation) requires an ACTIVE TransitNow dispatch subscription
// (Basic $50/month or Complete $100/month), tracked in
// dispatch_subscriptions from Stripe webhook events.
async function paidDispatchGate(driverId) {
  const driver = await drivers.getDriverById(Number(driverId));
  if (!driver) return { ok: false, driver: null, sub: null, reason: 'not-found' };
  const sub = await subscriptions.getByEmail(driver.email);
  if (sub && sub.status === 'active') return { ok: true, driver, sub, reason: null };
  return { ok: false, driver, sub: sub || null, reason: sub ? sub.status : 'no-subscription' };
}

function paidGateHtml(gate) {
  const d = gate.driver;
  const name = d ? `${d.full_name} (${d.email})` : 'This driver';
  const statusLine = !d
    ? 'Driver not found.'
    : gate.reason === 'no-subscription'
      ? 'has no TransitNow dispatch subscription on file.'
      : `has a dispatch subscription with status "${gate.sub.status}" (not active).`;
  const planLine = gate.sub && gate.sub.plan
    ? `<p>Last known plan: <strong>${gate.sub.plan === 'basic' ? 'Basic $50/month' : 'Complete $100/month'}</strong> — status: <strong>${gate.sub.status}</strong>.</p>`
    : '';
  return `
<h2>Paid subscribers only</h2>
<p><strong>${name}</strong> ${statusLine}</p>
${planLine}
<p>Dispatch work — routes and service-plan activation — is available to drivers with an <strong>active</strong> TransitNow dispatch subscription (Basic $50/month or Complete $100/month).</p>
<p>No action was taken. Once the driver's subscription is active (Stripe notifies us automatically, including renewals), this action will go through.</p>
<p><a href="/admin/drivers">&larr; Back to driver pipeline</a></p>
<p style="color:#888;font-size:12px">Subscriptions are month-to-month. No guaranteed loads, routes, revenue, or earnings.</p>`;
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

// --- Phase 7: analytics dashboard (spec section 26) ---------------------------------
// Additive — existing routes untouched. Admin route uses the explicit
// adminAuth pattern (registered before app.use('/admin', adminAuth)).
// Every metric is computed live from the real tables by lib/analytics.js;
// the UI states each derived metric's definition (started/completed/
// conversion rate, qualified, approvals) and carries no guarantee language.
app.get('/admin/analytics', adminAuth, ah(async (req, res) => {
  const data = await analyticsLib.getAnalytics({ days: req.query.days });
  res.send(adminViews.adminLayout('Growth analytics', analyticsViews.analyticsHtml(data)));
}));

// --- Admin -------------------------------------------------------------------------------------
/**
 * Guard: ?token= must equal ADMIN_TOKEN. On a successful query-token auth we
 * also set an httpOnly cookie so the admin views' plain /admin links and forms
 * (which don't carry the token) keep working.
 */
/**
 * Non-terminal admin check: true when the request carries Davena's admin
 * auth (query token or cookie). Extracted so dispatcher-area guards can
 * accept the admin session too — anonymous users still get bounced.
 */
function checkAdmin(req, res) {
  if (req.query.token && req.query.token === ADMIN_TOKEN) {
    // Davena's admin sign-in lasts 30 days so her phone isn't bounced to
    // the dispatcher login every 12 hours.
    tracking.setCookie(res, 'funnel_adm', ADMIN_TOKEN, { maxAge: 30 * 24 * 3600 });
    return true;
  }
  return tracking.getCookies(req).funnel_adm === ADMIN_TOKEN;
}
function adminAuth(req, res, next) {
  if (checkAdmin(req, res)) return next();
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
    roomRevenue:
      Math.round(((await q("SELECT COALESCE(SUM(amount_cents), 0) s FROM purchases WHERE product_id = 'room'")).s / 100) * 100) / 100,
    // Room sales pipeline: leads still in early stages with no purchase yet.
    followUpsDue: (await q(`
      SELECT COUNT(DISTINCT l.id) c FROM leads l
      WHERE EXISTS (SELECT 1 FROM tags WHERE lead_id = l.id AND tag = 'OFFER_room_LEAD')
        AND EXISTS (SELECT 1 FROM tags WHERE lead_id = l.id AND tag IN ('STAGE_NEW', 'STAGE_CONTACTED', 'STAGE_INTERESTED'))
        AND NOT EXISTS (SELECT 1 FROM tags WHERE lead_id = l.id AND tag = 'ROOM_PURCHASED')
    `)).c,
    offersSent: (await q(`
      SELECT COUNT(DISTINCT t.lead_id) c FROM tags t
      WHERE t.tag = 'STAGE_OFFER_SENT'
        AND EXISTS (SELECT 1 FROM tags WHERE lead_id = t.lead_id AND tag = 'OFFER_room_LEAD')
    `)).c,
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
  // Urgent field siren: unacknowledged urgent driver tickets stay
  // can't-miss at the top of the dashboard until acknowledged.
  let siren = '';
  try {
    siren = require('./views/field_comms').sirenBannerHtml(
      await require('./lib/field_comms').unackedUrgentTickets(50),
      '/dispatch'
    );
  } catch (err) {
    console.error('[admin] siren banner failed:', err.message);
  }
  res.send(adminViews.adminLayout('Dashboard', siren + adminViews.dashboardHtml(metrics, site) + sections));
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
  // Room pipeline: leads stuck in early stages with no purchase — Davena's
  // personal follow-up list, oldest first.
  const followUps = await db.all(`
    SELECT l.first_name, l.email, l.phone, l.goal, l.date_captured,
      MAX(CASE WHEN t.tag = 'STAGE_NEW' THEN 1 WHEN t.tag = 'STAGE_CONTACTED' THEN 2
               WHEN t.tag = 'STAGE_INTERESTED' THEN 3 ELSE 0 END) AS stage_rank,
      (SELECT MAX(scheduled_for) FROM email_queue q
        WHERE q.lead_id = l.id AND q.status IN ('sent', 'queued')) AS last_touch
    FROM leads l
    JOIN tags r ON r.lead_id = l.id AND r.tag = 'OFFER_room_LEAD'
    JOIN tags t ON t.lead_id = l.id AND t.tag LIKE 'STAGE\\_%' ESCAPE '\\'
    WHERE NOT EXISTS (SELECT 1 FROM tags p WHERE p.lead_id = l.id AND p.tag = 'ROOM_PURCHASED')
    GROUP BY l.id
    HAVING stage_rank BETWEEN 1 AND 3
    ORDER BY l.date_captured ASC
    LIMIT 100
  `);
  res.send(adminViews.adminLayout('Leads',
    adminViews.followUpTableHtml(followUps) + adminViews.leadsTableHtml(mapped, req.query)));
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
    to: e.email || '',
    sequence: e.sequence,
    step_id: e.step,
    subject: e.subject,
    body_preview: String(e.body_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140),
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
async function renderAdminRoom(res, tempShown = null) {
  const members = await db.all(
    'SELECT email, name, joined_at, last_login, password_hash, status, must_change_password FROM room_members ORDER BY joined_at DESC'
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
  res.send(adminViews.adminLayout("Wealth Builder's Room",
    roomViews.roomAdminPage({ members, posts, accountability, tempShown })));
}
app.get('/admin/room', ah(async (req, res) => {
  await renderAdminRoom(res);
}));

// Admin fallback member password reset: one-time temporary password shown
// ONCE (works tonight — no email needed). Stored hashed; the member is
// forced to choose their own password on next login.
app.post('/admin/room/member-reset-password', adminAuth, ah(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  try {
    const { member, tempPassword } = await room.issueRoomTempPassword(email);
    await renderAdminRoom(res, { name: member.name, email: member.email, password: tempPassword });
  } catch (err) {
    return res.status(400).send(adminViews.adminLayout('Error',
      `<p>${esc(err.message)}</p><p><a href="/admin/room">&larr; Back to Room admin</a></p>`));
  }
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

// --- Content library: Davena's reusable flyers/messages -------------------------
// "What should I post today?" + library management + per-item attribution.
app.get('/admin/content', ah(async (req, res) => {
  await content.ensureSeeded();
  const site = config.getSite() || {};
  const base = String(site.baseUrl || '').replace(/\/$/, '');
  const m = await adminMetrics().catch(() => ({}));
  const suggestion = await content.suggestToday(Date.now(), (m && m.followUpsDue) || 0);
  const items = await content.listItems(false);
  const statsById = {};
  for (const it of items) statsById[it.id] = await content.itemStats(it.id);
  res.send(adminViews.adminLayout('Content library',
    adminViews.contentPageHtml({ suggestion, items, statsById, baseUrl: base, token: req.query.token || '' })));
}));

app.post('/admin/content/add', ah(async (req, res) => {
  await content.createItem(req.body || {});
  res.redirect('/admin/content?token=' + encodeURIComponent(req.query.token || ''));
}));

app.get('/admin/content/:id/edit', ah(async (req, res) => {
  const item = await content.getItem(req.params.id);
  if (!item) return res.status(404).type('text').send('Not found');
  res.send(adminViews.adminLayout('Edit content',
    adminViews.contentFormHtml(item, content.OFFERS, content.CADENCES, content.KINDS, req.query.token || '')));
}));

app.post('/admin/content/:id', ah(async (req, res) => {
  await content.updateItem(req.params.id, req.body || {});
  res.redirect('/admin/content?token=' + encodeURIComponent(req.query.token || ''));
}));

app.post('/admin/content/:id/toggle', ah(async (req, res) => {
  const item = await content.getItem(req.params.id);
  if (item) await content.setActive(item.id, !item.active);
  res.redirect('/admin/content?token=' + encodeURIComponent(req.query.token || ''));
}));

app.post('/admin/run-scheduler', ah(async (req, res) => {
  // Optional `now` override (epoch ms) lets tests drive a deterministic
  // weekday through the scheduler. Admin-token protected like the endpoint.
  const nowOverride = Number(req.body && req.body.now);
  const result = await automation.runSchedulerPass(
    Number.isFinite(nowOverride) && nowOverride > 0 ? nowOverride : undefined
  );
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

// Seed Davena's reusable content library (idempotent — skips when items exist).
content.ensureSeeded().catch((err) => {
  console.error('[boot] content library seed failed:', err);
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
