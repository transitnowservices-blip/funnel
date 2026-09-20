# CHANGE_MANIFEST — Wealth Builder's Room $49/mo funnel upgrade

Base: git commit `18f504e` of https://github.com/transitnowservices-blip/funnel
Working tree: `~/workspace/funnel-upgrade`

## How to apply
Preferred: commit the whole working tree and push (all changes below are already
in the tree). Fallback: for any file, replace its full content on GitHub with the
content block under that file's heading. Do NOT commit `node_modules/` or `data/`.

## NEW FILES (create with exactly this content)
### `IMPLEMENTATION_CHECKLIST.md`
```md
# IMPLEMENTATION CHECKLIST — Wealth Builder's Room $49/mo Funnel Upgrade
Working tree: `~/workspace/funnel-upgrade` @ 18f504e (live clone of https://funnel-qdx9.onrender.com)
Rule: UPGRADE, don't rebuild. Preserve: dispatch funnel ($50/$100), all admin routes (?token= auth),
Room classroom/plan/community, carts, outbox, suppressions, Stripe links, SQLite via lib/db.js.

## Phase 1 — Inspection (DONE)
- [x] Backend routes/auth/payments/webhooks inventoried (server.js, 1303 lines)
- [x] Email subsystem inventoried (lib/email.js, lib/automation.js, config/emails.json, outbox, suppressions)
- [x] Room system inventoried (lib/room.js, views/room.js, content/room, claim flow, posts/comments)
- [x] Frontend/admin/db/tracking/config/tests inventoried (views/, public/style.css mobile-first, lib/db.js schema, 15 tracked event types, test suite scripts/test-funnel.js)

### What works (do not break)
- Dispatch funnel end-to-end; scheduler + nurture(5)/abandonedCart(4)/postPurchase(6)/weekly sequences; suppression-aware send guards; unsubscribe flow
- Room: Stripe webhook → member provisioning, /room/claim, /room/login, 30-day sessions, classroom, 90-day plan tracker, community, /admin/room moderation + announcements + add-member
- /checkout/room → 302 to $49/mo Stripe link (verified live); mobile-first CSS; E2E test suite (~95 assertions)

### What's incomplete (build below)
- No Room-specific public funnel pages (landing headline is dispatch copy; /thank-you is dispatch-specific)
- /checkout/room records NO cart/lead → invisible to abandonment metrics; no room checkout page/disclosure
- No /payment-success route; Stripe success URL is external config; buyers get zero emails after $49 purchase (no welcome, no claim instructions); lead not marked converted
- Classroom has 7 pillars; spec mandates 5 sections (00–04)
- No /claim-access alias; no "You're in. Welcome to the Wealth Builder's Room." message; no onboarding step
- No seeded community posts (0 posts); no roomWelcome/roomNurture/roomAbandonedCart sequences
- Dashboard missing SALES/CARTS/EMAILS/ROOM sections; no lead-detail view; lead statuses only 'lead'/'customer'
- Config page documents no env vars; secrets never masked; stale "read-only" text
- No /terms, /refund, /contact pages; footer links only Privacy + Unsubscribe
- Event gaps: landing_page_view, offer_viewed, checkout_abandoned, payment_success, payment_failed, membership_created, membership_claimed, room_entered, email_sent, email_failed (UNSUBSCRIBED→email_unsubscribed alias)

## Phase 2 — Build (DONE — 2026-09-20)
Public funnel (new, mobile-first; dispatch routes untouched):
- [x] `GET /room/join` — landing: exact H1/sub/CTAs + FOR-YOU-IF (7 bullets) + WHAT-YOU'LL-BUILD (00–04) + $49 INCLUDES (10 bullets) + NOT-GET-RICH-QUICK section + CTAs
- [x] `GET /room/start` — lead form: first name*, email*, phone, "What are you trying to build right now?" dropdown (8 options), consent checkbox (exact text)
- [x] `POST /room/start` — identifyLead reuse, store `goal`, tag NEW_LEAD, event lead_submitted, schedule `roomNurture`, → /room/offer
- [x] `GET /room/offer` — sales page: exact H1/copy/WHAT'S INSIDE/pricing $49/mo/CTA + cancel-terms line
- [x] `GET /room/checkout` — shows WEALTH BUILDER'S ROOM, $49/month, "Recurring subscription." + "$49/month recurring membership." + education disclaimer
- [x] `POST /room/checkout` — upsert lead, insert carts row, tags STARTED_CHECKOUT/HIGH_INTENT, event checkout_started → 302 Stripe room link
- [x] `GET /payment-success` — confirmation page → links /room/claim (owner sets this URL as Stripe success URL)
- [x] `GET|POST /claim-access` — alias of /room/claim
- [x] Claim success → `GET /room/welcome` — shows "You're in. Welcome to the Wealth Builder's Room." + onboarding; sets onboarded=1; → /room. Gate /room on !onboarded → /room/welcome (one-time)
- [x] `GET /terms`, `GET /refund`, `GET /contact` + footer links
Classroom (reuse, don't duplicate):
- [x] PILLARS → 5 sections: 00 start-here (new), 01 wealth-mindset (new), 02 money-cashflow (money-management.md+cash-flow.md), 03 assets-ownership (assets-investing.md+real-estate.md+funding-capital.md+business-income.md+marketing-sales.md), 04 90-day-plan (new explainer + plan.json); loader supports files[]; old slugs redirect; copy "7 pillars"→"5"
Email (extend automation engine; EMAIL_PROVIDER=local outbox; suppression-aware):
- [x] `roomWelcome` (0h): exact subject/body/CTA from spec; scheduled in handleRoomPurchase
- [x] `roomNurture` (0/24/72/120/168h): 5 spec subjects; stops on purchase (guard)
- [x] `roomAbandonedCart` (1/24/72h): 3 spec subjects; email 1 exact message+CTA; product-aware scheduler selection
- [x] handleRoomPurchase full bookkeeping: link lead by email, status customer, PURCHASED/CUSTOMER tags, cancel nurture+cart sequences, schedule roomWelcome, events payment_success/membership_created
- [x] Webhook: invoice.payment_failed → event payment_failed; customer.subscription.deleted → member inactive + lead CANCELED
Seeding:
- [x] Boot-time idempotent seed of 5 foundational posts (exact titles; announcements by Davena; pinned)
Admin:
- [x] Dashboard: LEADS (total/new/converted/rate), SALES (active/new members, MRR, failed, canceled), CARTS (started/completed/abandoned), EMAILS (sent/failed/pending/suppressed), ROOM (active/claimed/unclaimed/posts)
- [x] `GET /admin/leads/:id` — name/email/phone/source/created/last activity/lead+cart+purchase+membership status/email history; statuses NEW/ENGAGED/CHECKOUT_STARTED/PURCHASED/ACTIVE_MEMBER/CANCELED/SUPPRESSED
- [x] Config page: required env vars documented, set/unset + masked values, setup instructions; fix stale text
Tracking (additive events): landing_page_view, offer_viewed, checkout_abandoned, payment_success, payment_failed, membership_created, membership_claimed, room_entered, email_sent, email_failed, email_unsubscribed
DB migrations (idempotent): `leads.goal TEXT`, `room_members.onboarded INTEGER DEFAULT 0`

## Phase 3 — Test (DONE — 2026-09-20)
- [x] `bash scripts/test-funnel.sh` — all existing assertions pass
- [x] Extend test-funnel.js: room landing copy, /room/start → lead + roomNurture queued, /room/checkout → cart row, webhook → member + welcome email + lead customer, claim → /room/welcome → /room, seeded posts present, dashboard + lead detail 200
- [x] Spec's 15 functional tests worked through (1–15)
- [x] No secrets in frontend; mobile widths verified via CSS patterns

## Owner-action list (for final report)
- RESEND_API_KEY + verified sender (real email)
- STRIPE_WEBHOOK_SECRET (verify/set on Render)
- Stripe payment-link success URL → https://funnel-qdx9.onrender.com/payment-success?p=room
- (Turso migration remains a separate future task)

## Test results (2026-09-20)
- `bash scripts/test-funnel.sh`: **116/116 assertions passed, ALL TESTS PASSED** (existing dispatch-funnel tests + new Room tests).
- New E2E coverage: /room/join → /room/start (goal stored, roomNurture 5 queued, lead_submitted) → /room/offer → /room/checkout (cart row, 302 to unchanged Stripe link, checkout_started) → /payment-success → /claim-access alias → /terms, /refund, /contact; webhook purchase → member + lead customer + roomWelcome queued + nurture cancelled + cart closed + payment_success/membership_created events; claim → /room/welcome → /room; 5 seed posts pinned; admin dashboard sections + lead detail + masked config env status.
- Welcome email verified in local outbox: subject "Welcome to the Wealth Builder's Room", From "Wealth Builder's Room", exact CTA, no income promises, no real delivery (EMAIL_PROVIDER=local).
- Old classroom slugs 301-redirect to new sections (verified in tests).
- No secrets in any rendered page (admin token never printed; env status masked).
- Mobile: all new pages reuse the existing mobile-first CSS patterns (single column, 52px tap targets).

## Notes for deploy (parent agent)
- Do NOT run `npm install` artifacts into the repo: `node_modules/` and `data/` (local test DB + outbox) are untracked build/test artifacts in this tree.
- `CHANGE_MANIFEST.md` carries full file contents for every new/modified file if web-editor application is ever needed.
- Stripe payment-link success URL for the Room link must be set to https://funnel-qdx9.onrender.com/payment-success?p=room (owner action in Stripe dashboard).
- Render env vars needed: STRIPE_WEBHOOK_SECRET, EMAIL_PROVIDER=resend + RESEND_API_KEY + verified sender (for real email), APP_URL=https://funnel-qdx9.onrender.com, TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (permanent DB — separate task).
```

### `content/room/lessons/00-start-here.md`
```md
# 00 — Start Here

*Welcome to the Wealth Builder's Room. Read this first — it takes five minutes and makes everything else click.*

## What the Room Is

The Wealth Builder's Room is an education + community + accountability space for people building real wealth, step by step. Here's what you get here:

- **Education** — short, plain-language lessons organized into 5 sections, from how you think about money to the 90-day plan that ties it all together.
- **Community** — members learning the same lessons, asking questions, sharing wins, and keeping each other honest.
- **Accountability** — the interactive 90-Day Wealth Action Plan tracks your progress, one checked-off action at a time.

## What the Room Is NOT

This is not a get-rich-quick program. Nobody here will promise you an income, earnings, or any specific financial result — not in the lessons, not in the community, not anywhere. Building wealth takes time, effort, and decisions you have to make yourself. What the Room gives you is structure, knowledge, and people walking the same road.

> **Our only promise:** you will never be sold hype here. If something sounds too good to be true, bring it to the community and we'll talk through it honestly.

## How to Navigate the 5 Sections

Work them in order. Each section builds on the one before it:

- **00 — Start Here** (you're here): how everything works.
- **01 — Wealth Mindset, Habits & Decisions**: the thinking and habits that come before the tactics.
- **02 — Money Management & Cash Flow**: knowing your numbers and directing every dollar on purpose.
- **03 — Assets, Investing & Ownership**: building an income-producing business you own, and putting money into assets that can grow.
- **04 — The 90-Day Wealth Action Plan**: the interactive plan that turns all of it into weekly actions.

Don't skip ahead to the "exciting" sections. The mindset work in Section 01 and the money tracking in Section 02 are the foundation everything else stands on.

## How to Introduce Yourself in the Community

Your first move: head to the Community and post an introduction. Say your name (first name is fine), where you're starting from, and what you want this membership to help you do. A simple template:

> Hi, I'm [name]. I'm starting from [a line about where you are with money — honest, no judgment]. In the next 90 days I want to [your one goal]. Happy to be here.

Introductions do two things: they make you a real person to the community, and they make your goal public — which makes you more likely to follow through.

## How to Pick ONE 90-Day Goal

Not three goals. Not "fix everything." **One.** Pick the single outcome that would most change your next 90 days — examples:

- Track every dollar for 90 days without missing a week.
- Build a $1,000 emergency fund.
- Earn your first $500 from a side offer.
- Pay off one credit card in full.

Write it where you'll see it. Then open Section 04 and check off the plan actions that serve that goal. Your goal is your compass for every lesson — as you read, keep asking: *"How does this help my one goal?"*

## How to Participate Consistently

- **Small and regular beats big and rare.** Thirty minutes, three times a week, moves you further than a five-hour cram session once a month.
- **Check off plan actions honestly.** The progress tracker works when you use it — only check what you actually did.
- **Ask early, not stuck.** Post in the community when you're confused, not after you've been confused for three weeks.
- **Celebrate small wins publicly.** Every checked-off action counts. Your wins encourage someone else.

That's it. Start with Section 01, introduce yourself today, and pick your one goal this week. Welcome in.
```

### `content/room/lessons/01-wealth-mindset.md`
```md
# 01 — Wealth Mindset, Habits & Decisions

*Before tactics, before investments, before any business plan: the way you think about money decides what you do with it. This section is the operating system — everything later runs on it.*

## Decisions Compound

Wealth isn't built by one big decision. It's built by hundreds of small ones, repeated until they compound. Every dollar you track, every automatic transfer, every "no" to an impulse buy is a vote for your future self.

The math of compounding doesn't just apply to investments. It applies to habits:

- Track spending for one month → you spot one leak → you free up $60 → that becomes a $60/month automatic transfer → over a year that's $720 working for you instead of vanishing.
- None of those steps are dramatic. All of them matter.

> **Honest note:** Nobody can promise you what your results will be. Mindset doesn't guarantee income or outcomes — but without it, no tactic sticks.

## The Pay-Yourself-First Habit

Most people pay bills, spend, and save what's left. There's never anything left. Wealth builders flip the order: the moment income arrives, a set amount goes to savings — *before* spending decisions happen.

This isn't about the amount. $25 a paycheck is a perfectly good start. It's about the habit:

1. **Decide the amount** — small enough you won't raid it.
2. **Automate it** — a transfer on payday so willpower isn't required.
3. **Separate it** — a different account you don't check daily.

The amount grows as your income grows. The habit is the muscle.

## Consistency Beats Intensity

Motivation is weather — it changes. Systems are climate. The person who saves $50 every single month ends up further ahead than the person who saves $500 once and quits.

Three rules for staying consistent:

- **Make it smaller than you want to.** A 20-minute daily walk beats a "run a marathon" plan you abandon in week two.
- **Never miss twice.** One missed day is life. Two in a row is a new habit — don't start one.
- **Track the streak, not the outcome.** You control the action (transfer made, lesson read, dollar tracked). You don't control the outcome yet.

## Track What You Do

You can't improve what you don't measure. This applies to money, but also to behavior:

- Money in and out (Section 02 will go deep on this).
- Plan actions checked off (the 90-Day Plan tracker).
- Weekly wins — keep a short running list. On the weeks you feel stuck, read it.

Tracking turns vague feelings ("I'm bad with money") into specific facts ("I spent $214 on takeout last month"). Facts are fixable. Feelings aren't.

## Choose One Thing

Focus is the scarcest resource in wealth building. Every week, choose ONE primary action:

- This week's one action for your money: *write it down.*
- This week's one action for your income: *write it down.*
- Everything else is bonus.

When you finish it, pick the next one. A year of "one things" completed is unrecognizable from a year of "trying to do everything."

## Your Section 01 Checklist

Before moving to Section 02:

1. ☐ Set up a pay-yourself-first transfer (any amount, automated).
2. ☐ Write your ONE 90-day goal from Section 00 where you'll see it.
3. ☐ Start a simple money-tracking habit (notebook or app — day one).
4. ☐ Post your 90-day goal in the community introductions.

No income is promised here — just a foundation you can actually stand on. That's worth more.
```

### `content/room/lessons/04-90-day-plan.md`
```md
# 04 — The 90-Day Wealth Action Plan

*Everything in the Room points here. The 90-Day Plan is where lessons become actions — 12 weeks of small, checkable steps across every section.*

## How the Interactive Plan Works

Open the **90-Day Plan** page in the Room. You'll see 12 weeks, each with a theme and a short list of actions. When you complete an action, check the box — it saves automatically and feeds the progress bar on your dashboard.

Rules of engagement:

- **Check only what you actually did.** The tracker is for you, not for show. Honest checkmarks build honest momentum.
- **Unchecking removes progress.** Changed your mind or marked something by mistake? Uncheck it — no penalty.
- **Work one week at a time.** Finish this week's actions before worrying about next week's.
- **Missed something?** Move on. The plan rewards completion, not perfection — never miss twice, but never restart from week one either.

## How the Weeks Map to Sections 01–03

The plan isn't random — it follows the order you learned:

- **Weeks 1–2** draw on **Section 01 (Mindset) + Section 02 (Money Management & Cash Flow)**: know your numbers, build the foundation, start the pay-yourself-first habit.
- **Weeks 3–6** draw on **Section 03 (Assets, Investing & Ownership)** — the *business* half: find your offer, get your first yes, run it like a business, build momentum.
- **Weeks 7–8** cover **funding and reinvestment**: funding the growth of what works.
- **Weeks 9–11** cover **assets and investing**: the starter emergency fund, the asset column, investing on autopilot, and learning the property game.
- **Week 12** is review: your 12-month vision, your biggest win, and your next 90-day plan.

If a week's actions feel hard, go back to the matching section lesson and re-read it. The lesson explains the *why*; the plan gives you the *what*.

## The "One Primary Goal" Rule

The plan has many actions. You have limited hours. So the rule stands: **one primary goal at a time.**

Your 90-day goal (chosen in Section 00) is your filter:

- An action directly serves your goal → do it first.
- An action is interesting but unrelated → bookmark it for next quarter.
- Two actions compete for your time → the one that serves your goal wins.

Checking every box is not the objective. Completing the actions that move your one goal forward is.

## The Weekly Review Habit

Every Sunday (or whatever day ends your week), take 15 minutes:

1. **Count** — how many actions did you check off this week?
2. **Name the win** — what's the one best thing you did?
3. **Name the gap** — what's the one thing you skipped, and why?
4. **Pick next week's one action** — write it down where you'll see it.
5. **Share** — post your weekly win in the community. Small wins, out loud.

This review is the engine of the whole plan. Twelve weeks × one honest review = a completely different relationship with your money than you have today.

> **Reminder:** no part of this plan promises income, earnings, or any specific result. It promises structure. What you build on that structure is up to you — and that's exactly how it should be.

## Ready? Here's Your First Move

Open the plan page, read Week 1, and do the first action today — write down every dollar in and out. Then check the box. You've started.
```

### `views/room-funnel.js`
```js
// Page body templates for The Wealth Builder's Room purchase funnel.
// Each export returns inner <main> markup; the backend applies views/layout.js
// around it. The backend owns all Stripe redirects server-side (product.stripeLink
// is never rendered into markup here). No income or results promises anywhere.
'use strict';

const { esc } = require('./layout');

function included(items) {
  if (!items || !items.length) return '';
  return '<ul class="bullets">\n' + items.map(b => `  <li>${esc(b)}</li>`).join('\n') + '\n</ul>';
}

// --- Room checkout: order review + disclosure before Stripe ---
function roomCheckoutPage({ product, site }) {
  const p = product || {};
  const s = site || {};
  const name = esc(p.name || "The Wealth Builder's Room");
  const price = esc(p.priceDisplay || '$49/month');
  const bullets = p.salesCopy && p.salesCopy.bullets && p.salesCopy.bullets.length
    ? p.salesCopy.bullets
    : [
        "Room access: the private Wealth Builder's Room membership area",
        'Wealth-building education across the 7 wealth pillars',
        '90-day action plan with progress tracking',
        'Community & accountability with fellow members',
      ];
  return `
<section>
  <h1>Checkout — ${name}</h1>
  <p class="subhead">WEALTH BUILDER'S ROOM &middot; ${price} &middot; Recurring subscription.</p>
  <div class="price-box card">
    <p class="price">${price}</p>
    <p class="billing">$49/month recurring membership. Recurring subscription — you can cancel anytime by contacting us.</p>
  </div>
  <h2>What's included</h2>
  ${included(bullets)}
  <p class="honest-note">Wealth education is provided for informational and educational purposes and is not individualized financial, legal, tax, or investment advice. No specific income or results are guaranteed.</p>
  <form method="POST" action="/room/checkout" class="form">
    <label for="email">Email
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
      <span class="hint">We use your email to tie this order to you and send your welcome message.</span>
    </label>
    <button type="submit" class="btn btn-large">CONTINUE TO SECURE CHECKOUT &rarr;</button>
  </form>
  <p class="microcopy">You will be redirected to Stripe to complete payment securely.</p>
  <p class="contact-line">Questions? Call ${esc(s.phone || '')} or email ${esc(s.email || '')}.</p>
</section>`;
}

// --- Payment success: shown after Stripe payment completes ---
function paymentSuccessPage({ product }) {
  const p = product || {};
  const name = esc(p.name || "The Wealth Builder's Room");
  return `
<section>
  <h1>Payment successful — welcome!</h1>
  <p class="subhead">You're now a member of ${name}.</p>
  <div class="card">
    <h2>What happens next</h2>
    <ol>
      <li><strong>Check your email</strong> for a welcome message with your next steps.</li>
      <li><strong>Claim your access</strong> using the button below.</li>
    </ol>
  </div>
  <a class="btn btn-large" href="/room/claim">CLAIM YOUR ACCESS &rarr;</a>
  <p class="microcopy">If you don't see the email, check spam.</p>
</section>`;
}

module.exports = {
  roomCheckoutPage,
  paymentSuccessPage,
};
```

## MODIFIED FILES (replace full file content with the block below)
### `config/emails.json`
```json
{"fromEmail":"transitnowservices@gmail.com","fromName":"TransitNow Logistics Services","sequences":{"abandonedCart":[{"bodyHtml":"<p>Hi {{first_name}},</p><p>You started the checkout for <strong>{{product_name}}</strong> ({{price}}/month) but didn't finish — that happens.</p><p>If you still want dispatch support, you can pick up right where you left off:</p><p><a href='{{checkout_url}}'>Return to checkout</a></p><p>If you have questions before you decide, just reply to this email or call us at {{business_phone}}.</p><p>— The TransitNow team</p>","delayHours":1,"id":"cart-1","subject":"You left something in your checkout"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>Before you decide about <strong>{{product_name}}</strong>, here are answers to the questions we hear most:</p><ul><li><strong>What exactly do I get?</strong> Dispatch support for your independent courier work — lane research, load-search prep, broker/carrier verification guidance, scheduling coordination, paperwork guidance, and route planning. We don't take a cut of your rates.</li><li><strong>Is this a one-time fee?</strong> No. It's a monthly subscription ({{price}}/month). Cancel by contacting us anytime.</li><li><strong>Do you guarantee loads or income?</strong> No, and be wary of anyone who does. We give you organized support and a workflow; the work itself is yours to run.</li><li><strong>How do we start?</strong> You complete checkout, and we begin with operator onboarding — a review of your business and vehicle info, then dispatch setup.</li></ul><p>Ready? <a href='{{checkout_url}}'>Return to checkout</a></p><p>— The TransitNow team, {{business_phone}}</p>","delayHours":24,"id":"cart-2","subject":"Questions about dispatch support? Answers inside"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>Most independent couriers we talk to are strong drivers — and stretched thin on the back office. Loads to research, brokers to vet, paperwork to chase, schedules to juggle.</p><p><strong>{{product_name}}</strong> is built for exactly that: dispatch support that keeps your business organized so you can focus on the road.</p><p>What's included:</p><ul><li>Freight/lane preferences and load-search preparation</li><li>Broker and carrier verification guidance</li><li>Dispatch workflow, pickup/delivery scheduling setup</li><li>Paperwork guidance and route planning</li><li>Communication setup with brokers and shippers</li><li>Plus everything in TransitNow Basic: onboarding, business and vehicle info review, basic dispatch setup, ongoing support</li></ul><p>No guaranteed loads. No guaranteed income. Just real support for a real independent operation.</p><p><a href='{{checkout_url}}'>Return to checkout — {{price}}/month</a></p><p>— The TransitNow team</p>","delayHours":60,"id":"cart-3","subject":"What TransitNow Complete actually does"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>This is our last note about your unfinished checkout for <strong>{{product_name}}</strong> — no pressure, no countdown.</p><p>If dispatch support would help you run your operation, the door is open: <a href='{{checkout_url}}'>{{checkout_url}}</a></p><p>If the timing isn't right, that's fine too. We won't keep nudging you.</p><p>Either way, thanks for considering us.</p><p>— The TransitNow team, {{business_phone}}</p>","delayHours":144,"id":"cart-4","subject":"Last note about your checkout (no pressure)"}],"nurture":[{"bodyHtml":"<p>Hi {{first_name}},</p><p>Here's your free <strong>{{product_name}} lead magnet: 'Courier Startup Checklist' — 7 things to have ready before you take your first route as an independent courier.</p><p><em>You can revisit the checklist anytime from the free-resources page on our website.</em></p><p>Quick note on who we are: {{business_name}} is a Milwaukee-based dispatch support service for independent couriers and box-truck operators. We don't offer loads or jobs ourselves — we support independent operators with the back office of their business.</p><p>Over the next few days I'll send a few short emails with practical tips on getting started. You can unsubscribe anytime.</p><p>— TransitNow, {{business_phone}}</p>","delayHours":0,"id":"nurture-0","subject":"Your Courier Startup Checklist is here"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>One thing that separates couriers who stick with it from those who burn out early: <strong>knowing your lanes.</strong></p><p>A lane is simply the corridor you run — for example, Milwaukee to Chicago, or local metro pickups. Knowing your preferred lanes before you start helps you:</p><ul><li>Talk clearly with brokers about what you can and can't cover</li><li>Plan your days so you're not crisscrossing the city unpaid</li><li>Decide which loads fit your schedule and equipment</li></ul><p>Practical step: write down your 2–3 preferred lanes and the hours you can run them. Keep it somewhere you'll see it before you accept work.</p><p>Tomorrow I'll share the other half of the equation — what the back office of a courier business actually looks like, and why it's the part that sinks most new operators.</p><p>— TransitNow, {{business_phone}}</p>","delayHours":24,"id":"nurture-1","subject":"The one thing to figure out before your first route"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>Most new couriers are good at the driving part. The part that gets them is everything else:</p><ul><li>Researching loads and figuring out which are real</li><li>Vetting brokers and carriers before committing</li><li>Chasing rate confirmations and keeping paperwork straight</li><li>Coordinating pickup and delivery times</li><li>Planning routes so the day actually works</li></ul><p>That's the back office of a one-truck business — and it's a second job.</p><p>Some operators handle it all themselves. Others use dispatch support to stay organized while they focus on the road. Neither is wrong; it depends on how you work and what your time is worth.</p><p>If you want to see how we handle it for our clients, <strong>{{product_name}}</strong> covers lane research, load-search prep, broker verification guidance, scheduling coordination, paperwork guidance, and route planning — a monthly subscription, cancel anytime. <a href='{{checkout_url}}'>See the details</a></p><p>No guaranteed work, no guaranteed income — just organized support for an independent operation.</p><p>— TransitNow, {{business_phone}}</p>","delayHours":72,"id":"nurture-2","subject":"The second job every courier works (for free)"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>An honest note about who {{product_name}} is — and isn't — for.</p><p><strong>It's for you if:</strong></p><ul><li>You're an independent courier or box-truck operator (or getting your authority/business set up)</li><li>You want help with the business side: finding loads to evaluate, vetting brokers, paperwork, scheduling, route planning</li><li>You'd rather spend your working hours driving than doing admin</li><li>You understand no service can guarantee loads, rates, or income — and you're building a real business anyway</li></ul><p><strong>It's not for you if:</strong></p><ul><li>You're looking for someone to hand you guaranteed work or a paycheck — we don't do that, and you should be skeptical of anyone who promises it</li><li>You already have your back office running smoothly on your own</li><li>You're not actually running (or starting) an independent courier operation</li></ul><p>That's it. No hype. If it fits, <a href='{{checkout_url}}'>here's how {{product_name}} works</a> — {{price}}/month, cancel anytime.</p><p>— TransitNow, {{business_phone}}</p>","delayHours":120,"id":"nurture-3","subject":"Honestly: is this for you?"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>Quick recap of this week:</p><ul><li>You picked up the <strong>Courier Startup Checklist</strong></li><li>We talked about knowing your lanes</li><li>We talked about the back office most couriers struggle with</li><li>We were honest about who dispatch support fits — and who it doesn't</li></ul><p>If you're ready for support with the business side of your operation, here's the offer:</p><p><strong>{{product_name}} — {{price}}/month</strong></p><ul><li>Freight/lane preferences and load-search preparation</li><li>Broker and carrier verification guidance</li><li>Dispatch workflow, pickup/delivery scheduling setup</li><li>Paperwork guidance, route planning, communication setup</li><li>Everything in TransitNow Basic, plus ongoing dispatch support</li></ul><p><a href='{{checkout_url}}'>Start with {{product_name}}</a></p><p>Monthly subscription. Cancel anytime by contacting us. No guaranteed loads or income — real support for a real independent business.</p><p>Questions? Reply to this email or call {{business_phone}}.</p><p>— TransitNow</p>","delayHours":168,"id":"nurture-4","subject":"Wrapping up the week: your next step"}],"postPurchase":[{"bodyHtml":"<p>Hi {{first_name}},</p><p>Welcome aboard — your <strong>{{product_name}}</strong> subscription ({{price}}/month) is active.</p><p>What happens next:</p><ol><li><strong>Operator onboarding.</strong> We'll reach out to collect your business and vehicle information and review it together.</li><li><strong>Dispatch setup.</strong> We set up your dispatch workflow: lane preferences, communication setup, scheduling, and paperwork organization.</li><li><strong>Ongoing support.</strong> From there, we're in your corner month to month.</li></ol><p>Need to reach us? Email {{business_email}} or call {{business_phone}}.</p><p>Thanks for trusting us with the back office of your business.</p><p>— The TransitNow team</p>","delayHours":0,"id":"pp-1","subject":"Welcome to {{product_name}} — here's what happens next"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>Now that your onboarding is underway, here's how to get started smoothly:</p><ol><li><strong>Gather your documents.</strong> Business info, vehicle registration, insurance, license — keep them in one folder (digital or physical) so setup moves fast.</li><li><strong>Know your availability.</strong> Tell us the days and hours you can run, plus your preferred lanes. This shapes everything we do for you.</li><li><strong>Set up communication.</strong> Make sure we have your best phone number and email, and that you check them daily — brokers and shippers won't wait.</li><li><strong>Ask questions.</strong> No question is too basic. Email {{business_email}} or call {{business_phone}}.</li></ol><p>Talk soon,</p><p>— The TransitNow team</p>","delayHours":24,"id":"pp-2","subject":"Getting started: 4 things to do this week"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>You're set up — now here's how to get the most out of your <strong>{{product_name}}</strong> subscription:</p><ul><li><strong>Use us before you commit.</strong> Send a broker or load our way for verification guidance before you say yes — that's what we're here for.</li><li><strong>Keep your lanes updated.</strong> Preferences change with seasons and schedules. Tell us when yours do.</li><li><strong>Share your schedule early.</strong> The more lead time we have on your availability, the better your dispatch workflow works.</li><li><strong>Keep paperwork flowing.</strong> Send us rate confirmations and documents as they come in so nothing piles up.</li></ul><p>The operators who get the most value treat this like a partnership: you drive, we keep the business side organized.</p><p>— The TransitNow team, {{business_phone}}</p>","delayHours":72,"id":"pp-3","subject":"How to get maximum value from your subscription"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>Quick tip this week: <strong>build a paperwork habit.</strong></p><p>Every load generates documents — rate confirmations, bills of lading, delivery receipts, invoices. The operators who stay organized photograph or file each document the same day it arrives.</p><p>A simple system that works:</p><ul><li>One folder per week (or per load)</li><li>Photo of every signed document before you leave the dock</li><li>Rate confirmation saved before you start the run</li></ul><p>It takes five minutes a day and saves hours at tax time — or when a payment dispute comes up.</p><p>Need help organizing yours? That's part of what your subscription covers. Just ask.</p><p>— The TransitNow team</p>","delayHours":120,"id":"pp-4","subject":"A 5-minute habit that saves you hours"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>You may have seen that we also offer <strong>TransitNow Basic Dispatch</strong> — a lighter monthly plan ({{price}} covers Complete; Basic is $50/month).</p><p>To be clear: as a Complete subscriber you already have everything Basic includes, plus the full Complete feature set. You're not missing anything.</p><p>We mention it only because some operators ask about a lower-cost option for a partner, a second driver, or a slow season. If someone you know could use basic dispatch support — onboarding, business and vehicle info review, basic dispatch setup, ongoing support — Basic is there.</p><p>Details are on our site anytime. And your Complete subscription continues as normal.</p><p>— The TransitNow team, {{business_phone}}</p>","delayHours":168,"id":"pp-5","subject":"For the record: our Basic plan (and what you already have)"},{"bodyHtml":"<p>Hi {{first_name}},</p><p>It's been about ten days since you started <strong>{{product_name}}</strong>. Quick check-in:</p><ul><li>Is onboarding complete, or is anything still pending?</li><li>Are your lane preferences and availability set the way you want?</li><li>Is there anything about the dispatch workflow that's unclear?</li></ul><p>Just reply to this email — a real person reads every response.</p><p>If something isn't working for you, tell us and we'll fix it. If it is working, we'd love to hear that too.</p><p>— The TransitNow team, {{business_phone}}</p>","delayHours":240,"id":"pp-6","subject":"How's it going, {{first_name}}?"}],"roomWelcome":[{"id":"room-welcome-1","delayHours":0,"subject":"Welcome to the Wealth Builder's Room","bodyHtml":"<p>Welcome to the Wealth Builder's Room.</p><p>You just made a decision to stop collecting ideas and start organizing your next moves.</p><p>Inside the Room, you'll work through wealth-building education, practical action steps, and a 90-day plan designed to help you turn ideas, skills, opportunities, and resources into organized action.</p><p>Start here:<br>00 — Start Here<br>Then move through:<br>01 — Wealth Mindset, Habits &amp; Decisions<br>02 — Money Management &amp; Cash Flow<br>03 — Assets, Investing &amp; Ownership<br>04 — The 90-Day Wealth Action Plan</p><p>Your first assignment is simple:<br>Choose ONE thing you want to build over the next 90 days.<br>Don't try to build everything at once.</p><p><a href=\"{{room_url}}\">ENTER THE WEALTH BUILDER'S ROOM</a></p><p>Welcome in.<br>Davena Juanette Blue<br>Wealth Builder's Room</p>"}],"roomNurture":[{"id":"room-nurture-1","delayHours":0,"subject":"Your ideas need a plan","bodyHtml":"<p>Hi {{first_name}},</p><p>Here's a simple practice that changes how wealth gets built: <strong>capture every idea in one place.</strong> One notebook, one note on your phone, one list — not ideas scattered across sticky notes, screenshots, and half-remembered thoughts.</p><p>Once a week, look at that list and ask: <em>which ONE of these is worth 90 days of my attention?</em> Ideas you don't review are just entertainment. Ideas you review become options.</p><p>Inside the Wealth Builder's Room, members take that one idea further — working through wealth-building education, practical action steps, and a 90-day plan that turns ideas, skills, opportunities, and resources into organized action. <a href=\"{{checkout_url}}\">Join the Wealth Builder's Room — $49/month</a></p><hr><p style=\"font-size:12px;color:#666\">You're receiving these emails because you joined the Wealth Builder's Room list. <a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"},{"id":"room-nurture-2","delayHours":24,"subject":"Stop starting over","bodyHtml":"<p>Hi {{first_name}},</p><p>Most people don't fail at building wealth because their ideas are bad. They fail because they <strong>start over</strong> — a new idea every month, a new plan every quarter, nothing finished.</p><p>Try the one-project rule: pick one thing and give it 90 days of real effort before you allow yourself to chase the next shiny idea. Write the start date down. Finishing one thing teaches you more about building than starting ten things.</p><p>That's the spirit of the Wealth Builder's Room — one 90-day plan at a time, with education, action steps, and a community learning alongside you. <a href=\"{{checkout_url}}\">Join the Wealth Builder's Room — $49/month</a></p><hr><p style=\"font-size:12px;color:#666\">You're receiving these emails because you joined the Wealth Builder's Room list. <a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"},{"id":"room-nurture-3","delayHours":72,"subject":"What are you actually building?","bodyHtml":"<p>Hi {{first_name}},</p><p>A question worth sitting with: <em>what are you actually building?</em> Not \"more money\" in the abstract — what, specifically? A side business that covers one bill a month? A savings habit? A first asset?</p><p>Write down one sentence that finishes this: \"90 days from now, I want ___ in motion.\" Then write what \"done\" looks like, in concrete terms. Vague goals get vague effort; a defined target tells you what to do on Monday morning.</p><p>Inside the Wealth Builder's Room, that sentence becomes your 90-day plan — broken into weekly steps, with wealth-building education and practical guidance along the way. <a href=\"{{checkout_url}}\">Join the Wealth Builder's Room — $49/month</a></p><hr><p style=\"font-size:12px;color:#666\">You're receiving these emails because you joined the Wealth Builder's Room list. <a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"},{"id":"room-nurture-4","delayHours":120,"subject":"The 90-day shift","bodyHtml":"<p>Hi {{first_name}},</p><p>Ninety days feels long and short at the same time — long enough to build something real, short enough to stay focused. The trick: <strong>don't plan the 90 days. Plan the next seven.</strong></p><p>Take your one goal and ask: what are the 3 smallest actions I can do this week? Do them. Next week, pick 3 more. Twelve weeks of small, finished actions beats one giant plan you never start. Momentum is a side effect of small completions.</p><p>The Wealth Builder's Room is built around exactly this rhythm — the 90-Day Wealth Action Plan, broken into steps, with a community keeping each other honest. <a href=\"{{checkout_url}}\">Join the Wealth Builder's Room — $49/month</a></p><hr><p style=\"font-size:12px;color:#666\">You're receiving these emails because you joined the Wealth Builder's Room list. <a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"},{"id":"room-nurture-5","delayHours":168,"subject":"Your next move","bodyHtml":"<p>Hi {{first_name}},</p><p>One practical money habit before anything else: <strong>know your numbers.</strong> For one month, write down what's coming in and what's going out — every dollar, no judgment. Most people who do this find at least one leak they can fix and one pattern they can redirect.</p><p>Wealth starts with cash flow you can see clearly. Only after that does the building — skills, opportunities, assets — get efficient. If you'd like a structured place to learn this and everything after it, that's what the Wealth Builder's Room is for. <a href=\"{{checkout_url}}\">Join the Wealth Builder's Room — $49/month</a></p><hr><p style=\"font-size:12px;color:#666\">You're receiving these emails because you joined the Wealth Builder's Room list. <a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"}],"roomAbandonedCart":[{"id":"room-cart-1","delayHours":1,"subject":"You were closer than you think","bodyHtml":"<p>Hi {{first_name}},</p><p>You started the process of joining the Wealth Builder's Room but didn't finish. If you're ready to turn your ideas into an organized 90-day action plan, your spot is still waiting.</p><p><a href=\"{{checkout_url}}\">RETURN TO THE WEALTH BUILDER'S ROOM</a></p><p>Questions? Just reply to this email.</p><p>— The Wealth Builder's Room</p>"},{"id":"room-cart-2","delayHours":24,"subject":"Your next move doesn't have to be complicated","bodyHtml":"<p>Hi {{first_name}},</p><p>Your next move doesn't have to be complicated — or a big one. Inside the Wealth Builder's Room, members work through one 90-day plan at a time: wealth-building education, practical action steps, and a community learning together.</p><p>If that structure sounds useful, the door is open: <a href=\"{{checkout_url}}\">RETURN TO THE WEALTH BUILDER'S ROOM</a></p><p>If the timing isn't right, that's completely fine. We'll be here when it is.</p><p>— The Wealth Builder's Room</p>"},{"id":"room-cart-3","delayHours":72,"subject":"Still thinking about building?","bodyHtml":"<p>Hi {{first_name}},</p><p>Still thinking about building? Here's a question that helps most people decide: <em>what's the ONE thing you'd like to have in motion 90 days from now?</em></p><p>If you can answer that, the Room gives you a place to organize the steps. If you can't yet, that's fine too — clarity comes before action, not after.</p><p><a href=\"{{checkout_url}}\">RETURN TO THE WEALTH BUILDER'S ROOM</a></p><p>No pressure either way.<br>— The Wealth Builder's Room</p>"}]},"templates":{"weeklyFlyer":"<p>{{headline}}</p><p>{{benefit}}</p><p><strong>Learn something:</strong> {{educational}}</p><p><strong>Driver spotlight:</strong> {{spotlight}}</p><p><a href='{{checkout_url}}'>{{cta}}</a></p><p>Also available: {{secondaryOffer}}</p><p>{{testimonialSlot}}</p><hr><p><small>{{business_name}} · {{business_phone}} · {{business_email}}<br><a href='{{unsubscribe_url}}'>Unsubscribe</a></small></p>"},"weeklyFlyer":{"benefit":"Monthly dispatch support for independent couriers: lane research, load-search prep, broker verification guidance, scheduling coordination, paperwork guidance, and route planning — the back office, handled.","cta":"See how Complete Dispatch works","educational":"Know your preferred lanes before you accept work — it makes every conversation with a broker clearer and every day on the road more efficient.","featuredOfferId":"transitnow-complete","headline":"Stay Ready So You Don't Have To Get Ready.","secondaryOffer":"TransitNow Basic Dispatch — a lighter monthly plan ($50/month) with onboarding, business and vehicle info review, basic dispatch setup, and ongoing support.","spotlight":"TESTIMONIAL_SLOT (add real customer quotes here)","testimonialSlot":"TESTIMONIAL_SLOT (add real customer quotes here)"},"sequenceBranding":{"roomWelcome":{"fromName":"Wealth Builder's Room"},"roomNurture":{"fromName":"Wealth Builder's Room"},"roomAbandonedCart":{"fromName":"Wealth Builder's Room"}}}
```

### `config/products.json`
```json
{
  "defaultProduct": "transitnow-complete",
  "products": [
    {
      "billing": "recurring-monthly",
      "id": "transitnow-complete",
      "leadMagnet": {
        "deliverableHtml": "<h2>Courier Startup Checklist</h2><p>Seven things to have ready before you take your first route as an independent courier:</p><ol><li><strong>Vehicle basics.</strong> Reliable transportation you can use for deliveries, with routine maintenance up to date.</li><li><strong>Insurance basics.</strong> Confirm your auto policy covers the driving you plan to do; talk to your agent about commercial or delivery-use coverage.</li><li><strong>Business info.</strong> Your legal name or business name, address, phone number, and tax information, kept together so carrier applications go smoothly.</li><li><strong>Scheduling availability.</strong> Know the days and hours you can commit to routes before you start applying.</li><li><strong>Communication setup.</strong> A working phone number and email you check daily, plus voicemail set up so dispatchers and brokers can reach you.</li><li><strong>Paperwork folder.</strong> Keep a physical or digital folder with your license, registration, insurance documents, and business info so you can send them on request.</li><li><strong>Dispatch support options.</strong> Decide whether you want to manage load searching, broker communication, and paperwork yourself, or use a dispatch support service so you can focus on driving.</li></ol><p><em>This checklist is general guidance, not legal, tax, or insurance advice. No earnings are promised or implied.</em></p>",
        "description": "7 things to have ready before you take your first route as an independent courier.",
        "title": "Courier Startup Checklist"
      },
      "name": "TransitNow Complete Dispatch",
      "orderBump": {
        "_howToEnable": "Set enabled:true and fill in name, priceCents, priceDisplay, and description. The flow will automatically show an order-bump offer on the checkout page before payment.",
        "description": "",
        "enabled": false,
        "name": "",
        "priceCents": 0,
        "priceDisplay": ""
      },
      "priceCents": 10000,
      "priceDisplay": "$100/month",
      "salesCopy": {
        "bullets": [
          "Freight and lane preferences tailored to how and where you want to run",
          "Load-search preparation so you know where to look and what to ask for",
          "Broker and carrier verification guidance before you commit to a load",
          "A repeatable dispatch workflow, from pickup setup to delivery coordination",
          "Pickup and delivery scheduling setup handled with you, not for you behind your back",
          "Paperwork guidance: rate confirmations, invoices, and documents kept organized",
          "Route planning support to help you plan your days efficiently",
          "Communication setup with brokers and shippers so nothing falls through the cracks",
          "Plus everything in TransitNow Basic: operator onboarding, carrier/business and vehicle info review, basic dispatch setup, and ongoing dispatch support"
        ],
        "cta": "Start With Complete Dispatch — $100/month",
        "headline": "Stay Ready So You Don't Have To Get Ready.",
        "subhead": "Complete dispatch support for independent courier and box-truck operators: we handle the back office — lane research, load-search prep, broker verification, paperwork, and scheduling coordination — so you can focus on the road."
      },
      "stripeLink": "https://buy.stripe.com/4gM4gA3qR6Ws5wt4gR0480o",
      "upsell1": {
        "_howToEnable": "Set enabled:true and fill in name, priceCents, priceDisplay, and description. The flow will automatically show this as the first post-purchase upsell page.",
        "description": "",
        "enabled": false,
        "name": "",
        "priceCents": 0,
        "priceDisplay": ""
      },
      "upsell2": {
        "_howToEnable": "Set enabled:true and fill in name, priceCents, priceDisplay, and description. The flow will automatically show this as the second post-purchase upsell page (after upsell1 is accepted or declined).",
        "description": "",
        "enabled": false,
        "name": "",
        "priceCents": 0,
        "priceDisplay": ""
      }
    },
    {
      "_exampleNote": "WORKED EXAMPLE — this entry shows how to add a second offer. It is real TransitNow data (TransitNow Basic Dispatch, $50/month recurring), flagged \"example\": true so the app can treat it as a reference copy of the pattern. To add a real second offer: copy this object, change the id and fields, and set or remove the \"example\" flag according to the app's convention.",
      "billing": "recurring-monthly",
      "example": true,
      "id": "transitnow-basic",
      "leadMagnet": {
        "deliverableHtml": "<h2>Courier Startup Checklist</h2><p>Seven things to have ready before you take your first route as an independent courier:</p><ol><li><strong>Vehicle basics.</strong> Reliable transportation you can use for deliveries, with routine maintenance up to date.</li><li><strong>Insurance basics.</strong> Confirm your auto policy covers the driving you plan to do; talk to your agent about commercial or delivery-use coverage.</li><li><strong>Business info.</strong> Your legal name or business name, address, phone number, and tax information, kept together so carrier applications go smoothly.</li><li><strong>Scheduling availability.</strong> Know the days and hours you can commit to routes before you start applying.</li><li><strong>Communication setup.</strong> A working phone number and email you check daily, plus voicemail set up so dispatchers and brokers can reach you.</li><li><strong>Paperwork folder.</strong> Keep a physical or digital folder with your license, registration, insurance documents, and business info so you can send them on request.</li><li><strong>Dispatch support options.</strong> Decide whether you want to manage load searching, broker communication, and paperwork yourself, or use a dispatch support service so you can focus on driving.</li></ol><p><em>This checklist is general guidance, not legal, tax, or insurance advice. No earnings are promised or implied.</em></p>",
        "description": "7 things to have ready before you take your first route as an independent courier.",
        "title": "Courier Startup Checklist"
      },
      "name": "TransitNow Basic Dispatch",
      "orderBump": {
        "_howToEnable": "Set enabled:true and fill in name, priceCents, priceDisplay, and description. The flow will automatically show an order-bump offer on the checkout page before payment.",
        "description": "",
        "enabled": false,
        "name": "",
        "priceCents": 0,
        "priceDisplay": ""
      },
      "priceCents": 5000,
      "priceDisplay": "$50/month",
      "salesCopy": {
        "bullets": [
          "Operator onboarding to get you and your paperwork organized",
          "Carrier/business and vehicle information review",
          "Basic dispatch setup for your first routes",
          "Ongoing dispatch support while you run"
        ],
        "cta": "Start With Basic Dispatch — $50/month",
        "headline": "Dispatch Support That Starts With the Basics.",
        "subhead": "A lighter-touch monthly plan for independent couriers who want help getting set up and supported without the full Complete package."
      },
      "stripeLink": "https://buy.stripe.com/aFa00k4uVeoUaQN00B0480n",
      "upsell1": {
        "_howToEnable": "Set enabled:true and fill in name, priceCents, priceDisplay, and description. The flow will automatically show this as the first post-purchase upsell page.",
        "description": "",
        "enabled": false,
        "name": "",
        "priceCents": 0,
        "priceDisplay": ""
      },
      "upsell2": {
        "_howToEnable": "Set enabled:true and fill in name, priceCents, priceDisplay, and description. The flow will automatically show this as the second post-purchase upsell page (after upsell1 is accepted or declined).",
        "description": "",
        "enabled": false,
        "name": "",
        "priceCents": 0,
        "priceDisplay": ""
      }
    },
    {
      "id": "room",
      "name": "The Wealth Builder's Room",
      "priceCents": 4900,
      "priceDisplay": "$49/month",
      "billing": "recurring-monthly",
      "stripeLink": "https://buy.stripe.com/5kQdRbfEp5Hrc8Yf38dIA00",
      "leadMagnet": {
        "title": "",
        "description": "",
        "deliverableHtml": ""
      },
      "salesCopy": {
        "headline": "Turn Your Ideas, Skills & Opportunities Into Income, Businesses & Wealth.",
        "subhead": "A private membership community: 5 wealth-building sections, a 90-day action plan, and a community learning together.",
        "bullets": [
          "The Classroom: lessons across 5 wealth-building sections",
          "90-Day Wealth Action Plan with progress tracking",
          "Private community: questions, wins, and support",
          "Direct announcements and teaching from Davena"
        ],
        "cta": "Join the Room — $49/month"
      },
      "orderBump": {
        "enabled": false,
        "name": "",
        "priceCents": 0,
        "priceDisplay": "",
        "description": ""
      },
      "upsell1": {
        "enabled": false,
        "name": "",
        "priceCents": 0,
        "priceDisplay": "",
        "description": ""
      },
      "upsell2": {
        "enabled": false,
        "name": "",
        "priceCents": 0,
        "priceDisplay": "",
        "description": ""
      }
    }
  ]
}
```

### `content/room/lessons/assets-investing.md`
```md
# Assets & Investing

*Income pays today's bills. Assets pay tomorrow's. This pillar is about putting money to work instead of only working for money.*

## Lesson 1: Assets vs. Liabilities — The Only Definition That Matters

An **asset** puts money in your pocket. A **liability** takes money out of your pocket. That's the whole test.

Your car that you drive to work? Liability — it costs you gas, insurance, and repairs every month. That same car rented out or used in a delivery business that earns more than it costs? Asset.

Before you buy anything significant, ask: "Will this put money in my pocket or take money out?" Buy assets. Limit liabilities. This one question, applied for ten years, changes everything.

## Lesson 2: Start Boring, Stay Consistent

You don't need to pick winning stocks. For most beginners, the playbook is:

1. **Emergency fund first** — 3–6 months of needs (Pillar 1) in a savings account. This isn't investing; it's the armor that lets you invest without panic.
2. **Retirement accounts** — if your job offers a 401(k) match, contribute enough to get the full match. That's an instant return nobody else will give you.
3. **Simple index investing** — broad-market index funds through a Roth IRA or brokerage, contributed automatically every month.

The magic isn't the pick. It's time plus consistency. Money invested monthly for 20 years beats money timed perfectly for 2 years, almost every time.

> **Honest note:** All investing involves risk, including losing money. Past performance doesn't predict future results. Nobody — not me, not anyone in this Room — can promise you returns. This is education, not financial advice. For decisions about your specific money, talk to a licensed financial professional.

## Lesson 3: Build Assets You Control

Market investments are one lane. The other lane is assets you build yourself:

- A business that runs without your daily labor (systems, a small team, repeat customers)
- Digital products you create once and sell repeatedly (guides, templates, courses)
- Equipment or tools that earn rental or service income

These take more work up front than buying an index fund — and that's exactly why fewer people do it, and why the payoff can be bigger. Start with one. Finish it. Then consider the next.
```

### `content/room/lessons/business-income.md`
```md
# Business & Income

*Turning a skill into income is a process, not a personality trait. Here's the process.*

## Lesson 1: Start With What You Already Do

You don't need a brand-new talent to start a business. You need a problem you can solve for someone willing to pay. Make a list:

1. What do people already ask you for help with?
2. What have you done at a job that someone would pay for directly?
3. What do you know how to do that most people avoid doing themselves?

The overlap of those three lists is your starting offer. It doesn't have to be glamorous. Cleaning, organizing, cooking, driving, fixing, styling, writing, watching kids, walking dogs — unglamorous work pays real money because people will always pay to get their time back.

> **Honest note:** Starting a business costs time and sometimes money, and most new businesses take months to earn anything meaningful. Nobody here will tell you otherwise. What this Room gives you is a clear path — not a promise of a paycheck.

## Lesson 2: Your First Offer on One Page

Don't build a website. Don't design a logo. Write one page — even on paper — that answers four questions:

1. **Who is it for?** (be specific: "busy parents in Milwaukee," not "everyone")
2. **What problem does it solve?**
3. **What exactly do they get?** (list it plainly)
4. **What does it cost, and how do they pay you?**

Then tell ten people about it. Not post — tell. Text, call, in person. Your first customers almost always come from people who already know you. If ten people hear it and nobody bites, adjust the offer — the price, the audience, or the problem — and tell ten more.

## Lesson 3: Business Basics That Keep You Out of Trouble

Once money starts coming in, handle the boring stuff early:

- **Separate the money.** Open a separate bank account for the business, even if it's just a second checking account. Never mix business and personal spending.
- **Track everything.** Every dollar in, every dollar out, from day one. (See Pillar 1 — same habit, new account.)
- **Set aside for taxes.** A common rule of thumb is 25–30% of profit in a separate savings bucket. Talk to a tax professional about your specific situation — this isn't tax advice.
- **Get legit when it counts.** A business license, and eventually an LLC, protect you as you grow. You don't need all of it on day one, but don't operate in the shadows forever.

Boring paperwork is what separates a hobby from a business that lasts.
```

### `content/room/lessons/cash-flow.md`
```md
# Cash Flow

*Money management is defense. Cash flow is offense — it's about how money moves toward you, and how often.*

## Lesson 1: What Cash Flow Actually Means

Cash flow is simple: money in, minus money out, measured over time. Positive cash flow means more came in than went out this month. That's it. That's the whole definition.

Why it matters more than a salary number: a person making $3,000/month with $2,500 in expenses has $500 of positive cash flow. A person making $8,000/month with $8,200 in expenses is drowning. The first person can build wealth. The second person can't — yet.

Your goal in this pillar: widen the gap between in and out, and make the "in" happen more than once a month.

## Lesson 2: More Doors, Not Just a Bigger Door

Most people have one door money walks through: a job. If that door closes, everything stops. Building additional doors — even small ones — is how you protect yourself.

A second door doesn't have to replace your job. It has to do one thing: bring in money on a different schedule or from a different source. Examples:

- A skill you sell on weekends (cleaning, organizing, repairs, styling, tutoring)
- Reselling items you find cheap and list online
- A small service for local businesses (flyers, social posts, deliveries)

Start with what you already know how to do. The fastest second door is a skill you don't have to learn from zero.

> **Honest note:** A second income stream takes real work and real time, and there's no promise it will earn any specific amount — or anything at all in the beginning. What it does give you is options, and options are worth building.

## Lesson 3: The Cash Flow Calendar

Get a calendar — paper or digital — and mark every day money is expected to come in and every day a bill is due. Most cash crunches aren't caused by not having enough money in the month. They're caused by timing: three bills hitting in the same week the paycheck doesn't.

Once you can see the timing, you can fix it:

- Call billers and move due dates to spread them across the month. Most will do this if you ask.
- Time your second-door income to land in your thinnest weeks.
- Keep a small buffer — even $200 — in checking so timing mismatches stop becoming overdraft fees.

Cash flow problems feel like income problems, but they're usually calendar problems. Fix the calendar first.
```

### `content/room/lessons/funding-capital.md`
```md
# Funding & Capital

*You don't need a pile of cash to start. But you do need to understand how money-for-growth works before you touch it.*

## Lesson 1: Fund the Business, Don't Fund a Lifestyle

There are really only a few ways to get money into a new venture:

1. **Your own savings** — slowest, safest. You risk your own money and owe nobody.
2. **Revenue** — the best funding source there is. Sell first, reinvest the profit.
3. **Friends and family** — fast, but it can cost relationships if it goes wrong. Put everything in writing.
4. **Business credit** — useful once you have revenue, dangerous before it.
5. **Grants and programs** — real, but competitive and slow. Worth applying; don't build your timeline around them.

Rule: borrow or raise money to fund things that produce more money (equipment, inventory, marketing that you've tested). Never fund lifestyle spending with business money.

## Lesson 2: Credit Is a Tool, Not a Plan

If you use credit to grow, understand what you're signing:

- Know the interest rate and the real monthly payment — not the minimum, the payoff plan.
- Never borrow for an untested idea. Test small with cash first; borrow to scale what already works.
- Keep business and personal credit separate as soon as you can.

A credit card at 24% interest means every dollar you borrow costs you a quarter more to pay back. That's fine for a short bridge you can repay in 60 days. It's a trap for a 2-year "hopefully it works out."

> **Honest note:** Funding doesn't create a good business — it amplifies whatever the business already is. A funded bad idea just becomes an expensive bad idea. And nothing here is financial advice: before taking on debt or investors, talk to a qualified professional about your situation.

## Lesson 3: The Reinvestment Rule

When your business starts earning, resist the urge to spend the profit. A simple split that works for many small businesses:

- **50%** back into the business (marketing, equipment, inventory)
- **30%** to you (pay yourself — this is the point)
- **20%** to reserves and taxes

Adjust the numbers to your life, but keep the principle: the business eats first so it can keep feeding you. Businesses that reinvest grow. Businesses that get drained stay small.
```

### `content/room/lessons/marketing-sales.md`
```md
# Marketing & Sales

*The best offer in the world earns nothing if nobody hears about it. Marketing is just telling the right people, consistently.*

## Lesson 1: Attention Is the Currency

Before anyone can buy from you, they have to know you exist and remember you when the need hits. That means showing up where your people already are:

- **In person:** community boards, local groups, churches, neighborhood apps
- **Online:** one social platform where your ideal customers actually spend time — not all of them, one
- **Word of mouth:** tell every customer to tell a friend, and make it easy (a simple card, a link, a "mention my name" discount)

Post or show up at least three times a week. Consistency beats cleverness. Most small businesses don't fail at marketing because their content is bad — they fail because they post for two weeks, get quiet, and disappear.

## Lesson 2: Sell the Outcome, Not the Process

Nobody buys "three hours of housecleaning." They buy coming home to a clean house without lifting a finger. Nobody buys "a 60-minute consultation." They buy a clear plan for their next step.

Rewrite your offer in outcome language:

- Instead of what you *do*, say what they *get*
- Instead of features, say what changes for them
- Use their words, not industry words

Then make it easy to say yes: clear price, clear next step ("text me at this number," "book here"), and a way to pay without friction.

> **Honest note:** Marketing improves your odds — it doesn't guarantee sales. Some offers need reworking, some audiences need time, and every business has slow stretches. Track what you try so you're making decisions on evidence, not feelings.

## Lesson 3: Follow Up Like a Professional

Most sales are lost in the follow-up — or the lack of it. When someone shows interest and doesn't buy:

1. Thank them and ask if you can check back in a few days.
2. Check back when you said you would. (This alone puts you ahead of most people.)
3. If they say no, ask if you can keep them on a list for future offers — and respect the answer.

Keep a simple list: name, what they asked about, when to follow up. A notebook is fine. The system matters less than the habit.

And always ask happy customers for a review or a referral. The best marketing you'll ever have is a customer telling someone else. Make it normal to ask — "If you were happy with the work, would you mind leaving a quick review or sending a friend my way?"
```

### `content/room/lessons/money-management.md`
```md
# Money Management

*Everything in this Room builds on this pillar. You cannot grow money you cannot track.*

## Lesson 1: Know Your Numbers Before Anything Else

Most people don't have an income problem first — they have a clarity problem. They can't tell you, to the dollar, what came in last month or where it went.

Here's your first assignment: for the next 30 days, write down every dollar that comes in and every dollar that goes out. A notebook works. A notes app works. Fancy doesn't matter — consistent does.

At the end of the month, sort your spending into three buckets:

- **Needs** — housing, food, transportation, minimum debt payments, insurance
- **Wants** — eating out, subscriptions, shopping, entertainment
- **Wealth** — savings, debt payoff beyond minimums, investing

If the Wealth bucket is empty, that's your starting line. Not a judgment — a measurement. You fix what you measure.

> **Honest note:** Nobody in this Room will promise you a dollar amount. Managing money well doesn't guarantee any particular income or result — it guarantees you stop leaking what you already earn.

## Lesson 2: The Pay-Yourself-First Habit

After your bills, the first "bill" you pay should be to your future self. Decide on an amount — even $25 per paycheck — and move it to a separate savings account the day money hits your account. Not at the end of the month when "there's something left." There never is.

Start small enough that you won't raid it. The amount matters less than the habit. The habit is the muscle; the amount grows as your income grows.

Rules for this account:

1. It lives at a different bank (or at least a separate account you don't check daily).
2. You don't touch it for wants. Emergencies only.
3. You automate the transfer so willpower isn't required.

## Lesson 3: Kill the Leaks

Pull up your last two bank statements and highlight every recurring charge. Subscriptions you forgot about, fees you didn't notice, memberships you don't use. Cancel what doesn't earn its place.

Then look at the three biggest variable expenses — usually food, transportation, and "miscellaneous." Pick ONE and cut it by 20% next month. Not all three. One. Small wins compound; big overhauls collapse.

Money management isn't about deprivation. It's about deciding on purpose where your money goes instead of wondering where it went.
```

### `content/room/lessons/real-estate.md`
```md
# Real Estate & Property Wealth

*Land and buildings have built more everyday wealth than almost anything else. Here's how regular people get in.*

## Lesson 1: House Hacking — Live Cheaper While You Learn

The most accessible first step in real estate: buy (or rent) a place with more space than you need, and let the extra space pay you.

- Rent out a room to a vetted housemate
- Rent out the lower level or a separate entrance unit
- Rent out storage, parking, or garage space

Done right, your housing cost drops dramatically — sometimes to near zero — and you learn landlording with training wheels on: one tenant, one property, while you live there.

Rules: screen carefully, put everything in writing (a real lease, even with someone you like), know your local landlord-tenant law, and keep a repair reserve. Being a landlord is a business — treat it like one from day one.

## Lesson 2: The Numbers Have to Work

Every property is a math problem. Learn the basic version before you look at a single listing:

- **Monthly rent** minus **all monthly costs** (mortgage, taxes, insurance, maintenance reserve, vacancy reserve, property management if you won't self-manage) equals **monthly cash flow**.
- If cash flow isn't positive after honest numbers — including a maintenance reserve of at least 10% of rent — it's not a deal. It's a hope.
- Never skip the inspection. Never trust the seller's numbers without verifying.

A simple starter filter: the property should pay for itself and put a little in your pocket every month from day one. Appreciation (the property going up in value) is a bonus, not the plan.

> **Honest note:** Real estate can build real wealth — and it can also lose real money. Markets change, tenants leave, roofs leak. Nothing here guarantees any outcome, and this isn't legal or financial advice. Before buying property, work with qualified local professionals: a real estate agent, a lender, an inspector, and an attorney.

## Lesson 3: Paths Beyond Your First Property

Once you understand one property, the paths branch:

- **Buy and hold rentals** — long-term cash flow and equity buildup, one property at a time
- **BRRRR** (Buy, Rehab, Rent, Refinance, Repeat) — a strategy for recycling your capital into the next property; advanced, learn it thoroughly first
- **Partnerships** — teaming with someone who has capital or experience you lack; always in writing, always with an exit plan
- **REITs** — real estate investment trusts you buy like stocks; a hands-off way to hold real estate exposure without being a landlord

You don't need to pick your forever strategy now. Learn the numbers, start small, and let experience — not excitement — choose your next step.
```

### `docs/ROOM.md`
```md
# The Wealth Builder's Room — membership community

Davena's own Skool replacement, built into the funnel site. Members pay
**$49/month** (recurring — never describe it as one-time) through her own
Stripe payment link, then learn inside the Room.

## Public URLs (production)

| What | URL |
|---|---|
| Room funnel: landing | `https://funnel-qdx9.onrender.com/room/join` |
| Room funnel: lead form | `https://funnel-qdx9.onrender.com/room/start` |
| Room funnel: offer | `https://funnel-qdx9.onrender.com/room/offer` |
| Room funnel: checkout | `https://funnel-qdx9.onrender.com/room/checkout` → 302 to the $49/mo Stripe payment link |
| Legacy direct checkout | `https://funnel-qdx9.onrender.com/checkout/room` → 302 to the $49/mo Stripe payment link (kept for compatibility) |
| Payment success | `https://funnel-qdx9.onrender.com/payment-success?p=room` (set as the Stripe payment link's success URL) |
| Claim access (alias) | `https://funnel-qdx9.onrender.com/claim-access` |
| One-time onboarding | `https://funnel-qdx9.onrender.com/room/welcome` |
| Claim access (after paying) | `https://funnel-qdx9.onrender.com/room/claim` |
| Member login | `https://funnel-qdx9.onrender.com/room/login` |
| Member dashboard | `https://funnel-qdx9.onrender.com/room` |
| Classroom (5 sections) | `https://funnel-qdx9.onrender.com/room/classroom` |
| 90-Day Wealth Action Plan | `https://funnel-qdx9.onrender.com/room/plan` |
| Community | `https://funnel-qdx9.onrender.com/room/community` |
| Admin (members + posts) | `https://funnel-qdx9.onrender.com/admin/room?token=<ADMIN_TOKEN>` |

## How a member joins (no code, no help needed)

1. Buyer clicks any **Join the Room** button → `/checkout/room` → Stripe
   $49/month checkout.
2. Stripe sends `checkout.session.completed` to `/webhooks/stripe`
   (signature-verified, same as the TransitNow products). A $49.00 charge
   is mapped to the `room` product and a member record is created for the
   buyer's email — no funnel lead row required.
3. Buyer visits `/room/claim`, enters the email they paid with, chooses a
   password (8+ characters). Done — they're inside.
4. Returning visits: `/room/login` with email + password.

## How Davena teaches inside

- **Classroom lessons:** edit the Markdown files in `content/room/lessons/`
  (one file per pillar: `money-management.md`, `cash-flow.md`,
  `business-income.md`, `marketing-sales.md`, `funding-capital.md`,
  `assets-investing.md`, `real-estate.md`). Changes go live on the next
  page load — no restart, no deploy. Use `#`/`##` headings, `**bold**`,
  `-` lists, `>` quotes.
- **90-Day Plan:** edit `content/room/plan.json` (12 weeks, each with a
  title, focus, and action list). Member check-off progress is stored per
  member and is never wiped by content edits.
- **Announcements:** Admin → Room → "Post an announcement". Shows on every
  member's dashboard and at the top of the community.
- **Moderation:** Admin → Room can pin/unpin any post, delete any post
  (replies go with it), and deactivate/reactivate members. Deactivated
  members are logged out immediately and cannot log back in.

## Where member data lives

Same storage approach as the rest of the funnel: SQLite via `lib/db.js`
(local file `data/funnel.db`; Turso when `TURSO_DATABASE_URL` +
`TURSO_AUTH_TOKEN` are set — same as leads/purchases today).

New tables (created automatically at boot):

| Table | Purpose |
|---|---|
| `room_members` | One row per paying email: name, scrypt password hash, join date, status (`active`/`inactive`), last login |
| `room_sessions` | Login tokens (`room_sess` httpOnly cookie, 30-day expiry) |
| `room_progress` | 90-day plan check-offs per member per week/item |
| `room_posts` | Community posts + admin announcements (`kind`), pinned flag |
| `room_comments` | Replies on posts |

Room purchases also land in the existing `purchases` table
(`product_id='room'`, 4900 cents) so revenue metrics include them.

## Ground rules baked into the product

- $49/month is always presented as a recurring monthly membership.
- No income, earnings, or outcome promises anywhere — the classroom
  carries the honest disclaimer, and every Room page repeats it in the
  footer: educational content, not financial advice, no guaranteed results.
- Passwords are scrypt-hashed (node built-ins, no new dependencies);
  sessions are random 256-bit tokens in httpOnly cookies.
- The existing funnel is untouched: TransitNow checkouts, webhook
  signature verification, and admin behavior are all covered by the
  automated suite (`node scripts/test-funnel.js`).
```

### `lib/automation.js`
```js
'use strict';
/**
 * lib/automation.js — email automation engine.
 *
 * Responsibilities:
 *   - renderTemplate(str, vars): replaces all {{var}} placeholders.
 *   - buildVars(lead, product, site): {{first_name}}, {{product_name}},
 *     {{price}}, {{checkout_url}}, {{unsubscribe_url}}, {{room_url}},
 *     {{business_name}}, {{business_phone}}, {{business_email}}.
 *   - sequenceFrom(seqName): resolves the effective fromName/fromEmail for a
 *     sequence — per-sequence overrides in config/emails.json sequenceBranding
 *     win over the global fromEmail/fromName.
 *   - scheduleSequence(leadId, productId, seqName): queues one email_queue
 *     row per step of config/emails.json sequences[seqName], scheduled at
 *     now + delayHours. Templates are rendered at schedule time (except the
 *     weekly flyer, which is built at send time so config edits apply to
 *     future sends without a rebuild).
 *   - scheduleWeekly(leadId): queues the next weekly flyer email (+7d).
 *   - runSchedulerPass(): one full automation pass —
 *       1. abandoned-cart detection (stale open carts -> ABANDONED_CART tag,
 *          roomAbandonedCart sequence for room carts else abandonedCart,
 *          CART_ABANDONED + checkout_abandoned events), then
 *       2. processDueEmails() — send every due queued row that passes guards.
 *     Returns { sent, cancelled }.
 *
 * Send-time guards (a failing guard cancels the row with cancel_reason):
 *   - lead missing            -> 'lead-missing'
 *   - lead unsubscribed       -> 'unsubscribed'
 *   - email suppressed        -> 'suppressed'
 *   - abandonedCart + cart purchased            -> 'purchased'
 *   - roomAbandonedCart + cart purchased or room purchased -> 'purchased'
 *   - nurture 'offer' step + product purchased  -> 'purchased'
 *   - roomNurture + lead purchased (PURCHASED tag or room purchase) -> 'purchased'
 *   - weekly + featured offer purchased         -> 'purchased-featured'
 *   - postPurchase without PURCHASED tag        -> 'not-purchased'
 *   - roomWelcome without an active room member -> 'not-purchased'
 *
 * After the nurture 'offer' step is sent to a still-non-buyer, the lead gets
 * the WEEKLY_NURTURE tag and the next weekly email is scheduled (+7d). After
 * each weekly email is sent, the following one is scheduled (+7d) while the
 * lead stays eligible.
 *
 * NOTE: every function here is async — the db layer returns Promises.
 * Callers must `await` these functions.
 */
const db = require('./db');
const config = require('./config');
const tags = require('./tags');
const email = require('./email');

const fs = require('fs');
const path = require('path');

const EMAILS_JSON_PATH = path.join(__dirname, '..', 'config', 'emails.json');

/**
 * Read config/emails.json directly, bypassing config.getEmails()'s whitelist
 * (which only exposes the legacy nurture/abandonedCart/postPurchase
 * sequences). This is how the Room sequences (roomWelcome, roomNurture,
 * roomAbandonedCart) and the top-level sequenceBranding map are resolved.
 * Falls back to {} so a missing/unparseable file just schedules nothing.
 */
function getRawEmails() {
  try {
    return JSON.parse(fs.readFileSync(EMAILS_JSON_PATH, 'utf8'));
  } catch (err) {
    console.error('[automation] failed to read config/emails.json:', err && err.message ? err.message : err);
    return {};
  }
}

const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const ABANDON_AFTER_MS = HOUR_MS; // cart considered abandoned after 1h

/**
 * Normalize a DB time value to epoch milliseconds.
 * The contract stores epoch-ms integers, but this is tolerant of ISO/SQLite
 * datetime text ('YYYY-MM-DD HH:MM:SS', always UTC from datetime('now')) and
 * numeric strings, since tests, admin SQL, and operators naturally write
 * those via datetime(). Unparseable values -> NaN (caller decides: skip).
 */
function toMs(val) {
  if (val === null || val === undefined) return NaN;
  if (typeof val === 'number') return val;
  const s = String(val).trim();
  if (s === '') return NaN;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // Naive 'YYYY-MM-DD HH:MM:SS' from SQLite datetime('now') is UTC.
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

// --- Templates ----------------------------------------------------------------
function renderTemplate(str, vars) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''
  );
}

function buildVars(lead, product, site) {
  const safeLead = lead || {};
  const safeProduct = product || {};
  const safeSite = site || {};
  const baseUrl = (safeSite.baseUrl || '').replace(/\/$/, '');
  return {
    first_name: safeLead.first_name || '',
    product_name: safeProduct.name || '',
    price: safeProduct.priceDisplay || '',
    checkout_url: `${baseUrl}/checkout?p=${safeProduct.id || ''}`,
    unsubscribe_url: `${baseUrl}/unsubscribe?email=${encodeURIComponent(safeLead.email || '')}`,
    room_url: `${baseUrl}/room/login`,
    business_name: safeSite.businessName || '',
    business_phone: safeSite.phone || '',
    business_email: safeSite.email || '',
  };
}

/**
 * Resolve the effective sender for a sequence. A per-sequence override in
 * config/emails.json's top-level `sequenceBranding` map
 * ({ "<seqName>": { fromName, fromEmail } }) wins over the global
 * fromName/fromEmail. Missing keys fall back to the global values.
 */
function sequenceFrom(seqName) {
  const raw = getRawEmails();
  const overrides = (raw.sequenceBranding || {})[seqName] || {};
  return {
    fromName: overrides.fromName || raw.fromName || '',
    fromEmail: overrides.fromEmail || raw.fromEmail || '',
  };
}

// --- Small query helpers -------------------------------------------------------
async function getLead(id) {
  return db.get('SELECT * FROM leads WHERE id = ?', [id]);
}

async function isSuppressed(emailAddr) {
  if (!emailAddr) return false;
  return !!(await db.get('SELECT 1 FROM suppressions WHERE email = ?', [emailAddr]));
}

async function hasAnyPurchase(leadId) {
  return !!(await db.get("SELECT 1 FROM purchases WHERE lead_id = ? AND kind = 'initial'", [leadId]));
}

async function hasPurchasedProduct(leadId, productId) {
  if (!productId) return false;
  return !!(await db.get("SELECT 1 FROM purchases WHERE lead_id = ? AND product_id = ? AND kind = 'initial'", [
    leadId,
    productId,
  ]));
}

async function hasPurchasedCart(leadId, productId) {
  if (productId) {
    return !!(await db.get('SELECT 1 FROM carts WHERE lead_id = ? AND product_id = ? AND purchased = 1', [
      leadId,
      productId,
    ]));
  }
  return !!(await db.get('SELECT 1 FROM carts WHERE lead_id = ? AND purchased = 1', [leadId]));
}

/** True when the email belongs to an active Wealth Builder's Room member. */
async function hasActiveRoomMember(email) {
  const clean = String(email || '')
    .trim()
    .toLowerCase();
  if (!clean) return false;
  return !!(await db.get("SELECT 1 FROM room_members WHERE email = ? AND status = 'active'", [clean]));
}

/** True when the lead has bought the Wealth Builder's Room through any channel. */
async function hasRoomPurchase(leadId, email) {
  if (await hasPurchasedProduct(leadId, 'room')) return true;
  if (await tags.hasTag(leadId, 'ROOM_PURCHASED')) return true;
  return hasActiveRoomMember(email);
}

// --- Scheduling -----------------------------------------------------------------
/**
 * Step ids that count as the nurture "offer" step: a literal 'offer' id, or —
 * since the offer is the last nurture step — the final step of the configured
 * nurture sequence. This keeps the purchase/cancel and weekly-rollover logic
 * working whether the config names the step 'offer' or e.g. 'nurture-4'.
 */
function nurtureOfferStepIds() {
  const steps = ((config.getEmails().sequences || {}).nurture) || [];
  const ids = new Set(['offer']);
  const last = steps[steps.length - 1];
  if (last && last.id) ids.add(last.id);
  return ids;
}

function isNurtureOfferStep(stepId) {
  return nurtureOfferStepIds().has(stepId);
}

/** Cancel queued nurture offer-step rows for a lead+product (e.g. after purchase). */
async function cancelNurtureOfferSteps(leadId, productId) {
  const ids = [...nurtureOfferStepIds()];
  const placeholders = ids.map(() => '?').join(',');
  const info = await db.run(
    `UPDATE email_queue SET status = 'cancelled', cancel_reason = 'purchased'
     WHERE lead_id = ? AND status = 'queued' AND sequence = 'nurture'
       AND step IN (${placeholders}) AND product_id = ?`,
    [leadId, ...ids, productId]
  );
  return info.changes;
}
/**
 * Cancel ALL remaining queued nurture rows for a lead+product.
 * Used on purchase: the buyer leaves the prospect promotion for that offer
 * and moves into the post-purchase/customer sequence instead. (Kept separate
 * from cancelNurtureOfferSteps for callers that only want the offer step.)
 */
async function cancelNurtureForProduct(leadId, productId) {
  const info = await db.run(
    `UPDATE email_queue SET status = 'cancelled', cancel_reason = 'purchased'
     WHERE lead_id = ? AND status = 'queued' AND sequence = 'nurture' AND product_id = ?`,
    [leadId, productId]
  );
  return info.changes;
}
/**
 * Queue every step of a named sequence. Idempotent per (lead, sequence, step):
 * already-queued steps are skipped so double submits don't duplicate emails.
 * Returns the number of rows inserted.
 * Delays are measured from baseTime (default now); pass the cart's started_at
 * for the abandonedCart sequence so "1h later" means 1h after checkout start.
 */
async function scheduleSequence(leadId, productId, seqName, baseTime = Date.now()) {
  const lead = await getLead(leadId);
  if (!lead) return 0;
  // Raw read (not config.getEmails()): exposes the Room sequences too.
  const steps = ((getRawEmails().sequences || {})[seqName]) || [];
  if (!steps.length) return 0;
  const site = config.getSite();
  const product = config.getProduct(productId);
  const vars = buildVars(lead, product, site);
  let inserted = 0;
  for (const step of steps) {
    if (!step || !step.id) continue;
    const dupe = await db.get(
      "SELECT 1 FROM email_queue WHERE lead_id = ? AND sequence = ? AND step = ? AND status = 'queued'",
      [leadId, seqName, step.id]
    );
    if (dupe) continue;
    await db.run(
      `INSERT INTO email_queue
         (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      [
        leadId,
        lead.email,
        seqName,
        step.id,
        renderTemplate(step.subject, vars),
        renderTemplate(step.bodyHtml, vars),
        product.id,
        baseTime + (Number(step.delayHours) || 0) * HOUR_MS,
      ]
    );
    inserted++;
  }
  return inserted;
}

/** Queue the next weekly flyer email (+7d). Subject/body are built at send time. */
async function scheduleWeekly(leadId) {
  const lead = await getLead(leadId);
  if (!lead || lead.unsubscribed || (await isSuppressed(lead.email))) return 0;
  const featuredOfferId = (config.getEmails().weeklyFlyer || {}).featuredOfferId || null;
  if (featuredOfferId && (await hasPurchasedProduct(leadId, featuredOfferId))) return 0;
  const dupe = await db.get("SELECT 1 FROM email_queue WHERE lead_id = ? AND sequence = 'weekly' AND status = 'queued'", [
    leadId,
  ]);
  if (dupe) return 0;
  await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (?, ?, 'weekly', 'weekly', '', '', ?, ?, 'queued')`,
    [leadId, lead.email, featuredOfferId, Date.now() + 7 * DAY_MS]
  );
  return 1;
}

/** Build the weekly flyer email at send time so config edits apply going forward. */
function buildWeeklyEmail(lead) {
  const emailsCfg = config.getEmails();
  const site = config.getSite();
  const flyer = emailsCfg.weeklyFlyer || {};
  const product = config.getProduct(flyer.featuredOfferId);
  const vars = buildVars(lead, product, site);
  const subject = renderTemplate(flyer.subject || flyer.headline || 'Weekly update', vars);
  const section = (title, text) =>
    text ? `<h3 style="margin:1.2em 0 .4em">${renderTemplate(title, vars)}</h3><p>${renderTemplate(text, vars)}</p>` : '';
  const body = `
    <h2>${renderTemplate(flyer.headline || '', vars)}</h2>
    <p>Hi ${renderTemplate('{{first_name}}', vars)},</p>
    ${section(`Featured this week: ${product.name || ''} — ${product.priceDisplay || ''}`, flyer.benefit)}
    <p><a href="${vars.checkout_url}">${renderTemplate(flyer.cta || 'Learn more', vars)}</a></p>
    ${section('Learn something useful', flyer.educational)}
    ${section('Spotlight', flyer.spotlight)}
    ${flyer.secondaryOffer ? `<p><em>Also:</em> ${renderTemplate(flyer.secondaryOffer, vars)}</p>` : ''}
    ${flyer.testimonialSlot ? `<blockquote>${renderTemplate(flyer.testimonialSlot, vars)}</blockquote>` : ''}
    <hr>
    <p style="font-size:12px;color:#666">
      You're receiving this because you joined ${renderTemplate('{{business_name}}', vars)}'s list.
      <a href="${vars.unsubscribe_url}">Unsubscribe</a>
    </p>`;
  return { subject, body };
}

// --- Sending ----------------------------------------------------------------------
async function cancelRow(id, reason) {
  await db.run("UPDATE email_queue SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [reason, id]);
  return 'cancelled';
}

/** Apply send-time guards and send one due queue row. Returns 'sent' | 'cancelled'. */
async function processOneEmail(row) {
  const lead = await getLead(row.lead_id);
  if (!lead) return cancelRow(row.id, 'lead-missing');
  if (lead.unsubscribed) return cancelRow(row.id, 'unsubscribed');
  if (await isSuppressed(lead.email)) return cancelRow(row.id, 'suppressed');

  const flyer = (config.getEmails().weeklyFlyer || {});
  if (row.sequence === 'abandonedCart' && (await hasPurchasedCart(lead.id, row.product_id))) {
    return cancelRow(row.id, 'purchased');
  }
  if (
    row.sequence === 'roomAbandonedCart' &&
    ((await hasPurchasedCart(lead.id, row.product_id)) || (await hasRoomPurchase(lead.id, lead.email)))
  ) {
    return cancelRow(row.id, 'purchased');
  }
  if (
    row.sequence === 'roomNurture' &&
    ((await tags.hasTag(lead.id, 'PURCHASED')) || (await hasRoomPurchase(lead.id, lead.email)))
  ) {
    return cancelRow(row.id, 'purchased');
  }
  if (row.sequence === 'roomWelcome' && !(await hasActiveRoomMember(lead.email))) {
    // Safety: welcome emails only go to confirmed members.
    return cancelRow(row.id, 'not-purchased');
  }
  if (row.sequence === 'nurture' && isNurtureOfferStep(row.step) && (await hasPurchasedProduct(lead.id, row.product_id))) {
    return cancelRow(row.id, 'purchased');
  }
  if (row.sequence === 'weekly' && (await hasPurchasedProduct(lead.id, flyer.featuredOfferId))) {
    return cancelRow(row.id, 'purchased-featured');
  }
  if (row.sequence === 'postPurchase' && !(await tags.hasTag(lead.id, 'PURCHASED'))) {
    return cancelRow(row.id, 'not-purchased');
  }

  let subject = row.subject;
  let body = row.body_html;
  if (row.sequence === 'weekly') {
    // Weekly content is built fresh at send time.
    const built = buildWeeklyEmail(lead);
    subject = built.subject;
    body = built.body;
    await db.run('UPDATE email_queue SET subject = ?, body_html = ? WHERE id = ?', [subject, body, row.id]);
  }

  await email.sendEmail({
    to: row.email,
    subject,
    html: body,
    queueId: row.id,
    ...sequenceFrom(row.sequence),
  });

  // Post-send follow-ups -------------------------------------------------------
  if (row.sequence === 'nurture' && isNurtureOfferStep(row.step) && !(await hasAnyPurchase(lead.id))) {
    // Nurture finished without a purchase -> roll into the weekly flyer.
    await tags.addTag(lead.id, 'WEEKLY_NURTURE');
    await scheduleWeekly(lead.id);
  }
  if (row.sequence === 'weekly') {
    // Keep the weekly cadence going while the lead stays eligible.
    await scheduleWeekly(lead.id);
  }
  return 'sent';
}

async function processDueEmails(now = Date.now()) {
  // Pull all queued rows and filter in JS: toMs() tolerates both epoch-ms
  // integers (contract) and SQLite datetime text (admin/test writes).
  const queued = await db.all("SELECT * FROM email_queue WHERE status = 'queued' ORDER BY id ASC");
  const due = queued.filter(row => {
    const t = toMs(row.scheduled_for);
    return Number.isFinite(t) && t <= now;
  });
  let sent = 0;
  let cancelled = 0;
  for (const row of due) {
    try {
      const result = await processOneEmail(row);
      if (result === 'sent') sent++;
      else cancelled++;
    } catch (err) {
      console.error(`[automation] failed to process email_queue row ${row.id}:`, err.message);
    }
  }
  return { sent, cancelled };
}

// --- Scheduler pass ------------------------------------------------------------------
/** Detect stale open carts and queue abandoned-cart sequences. */
async function detectAbandonedCarts(now = Date.now()) {
  // Read open carts and compare in JS so both epoch-ms integers (contract)
  // and SQLite datetime text (admin/test writes) are handled via toMs().
  const open = await db.all('SELECT * FROM carts WHERE purchased = 0');
  let flagged = 0;
  for (const cart of open) {
    const started = toMs(cart.started_at);
    if (!Number.isFinite(started) || started >= now - ABANDON_AFTER_MS) continue; // not stale yet
    if (!cart.lead_id) continue; // never identified — nothing to email
    if (await tags.hasTag(cart.lead_id, 'ABANDONED_CART')) continue; // already flagged
    const lead = await getLead(cart.lead_id);
    if (!lead) continue;
    await tags.addTag(cart.lead_id, 'ABANDONED_CART');
    // Room carts get the Room-branded abandoned-cart sequence; everything else
    // keeps the original abandonedCart sequence.
    const seqName = cart.product_id === 'room' ? 'roomAbandonedCart' : 'abandonedCart';
    // Measure cart-email delays from checkout start, so "email 1 ~1h later"
    // means ~1h after they started checkout (already elapsed at detection,
    // so it goes out on this same scheduler pass).
    await scheduleSequence(cart.lead_id, cart.product_id, seqName, started);
    await db.recordEvent({
      lead_id: cart.lead_id,
      type: 'CART_ABANDONED',
      product_id: cart.product_id,
      meta: { cart_id: cart.id },
    });
    await db.recordEvent({
      lead_id: cart.lead_id,
      type: 'checkout_abandoned',
      product_id: cart.product_id,
      meta: { cart_id: cart.id },
    });
    flagged++;
  }
  return flagged;
}

/**
 * Run one full automation pass: abandoned-cart detection, then due emails.
 * Called every 60s from server.js and on demand via POST /admin/run-scheduler.
 */
async function runSchedulerPass() {
  const now = Date.now();
  const abandoned = await detectAbandonedCarts(now);
  const { sent, cancelled } = await processDueEmails(now);
  return { sent, cancelled, abandonedCarts: abandoned };
}

module.exports = {
  renderTemplate,
  buildVars,
  sequenceFrom,
  toMs,
  nurtureOfferStepIds,
  isNurtureOfferStep,
  cancelNurtureOfferSteps,
  cancelNurtureForProduct,
  scheduleSequence,
  scheduleWeekly,
  buildWeeklyEmail,
  processDueEmails,
  detectAbandonedCarts,
  runSchedulerPass,
};
```

### `lib/config.js`
```js
'use strict';
/**
 * lib/config.js — reads config/*.json (written by a separate agent).
 *
 * Shapes expected:
 *   config/site.json:     {businessName, tagline, phone, email, paymentMode,
 *                          baseUrl, footerNote, privacyNoteHtml}
 *   config/products.json: {defaultProduct, products:[{id, name, priceCents,
 *                          priceDisplay, billing, stripeLink,
 *                          leadMagnet:{title,description,deliverableHtml},
 *                          salesCopy:{headline,subhead,bullets[],cta},
 *                          orderBump:{enabled,name,priceCents,priceDisplay,description},
 *                          upsell1:{enabled,...}, upsell2:{enabled,...}}]}
 *   config/emails.json:   {fromName, fromEmail,
 *                          sequences:{nurture:[{id,delayHours,subject,bodyHtml}],
 *                                     abandonedCart:[...], postPurchase:[...]},
 *                          weeklyFlyer:{headline,featuredOfferId,benefit,educational,
 *                                       spotlight,cta,secondaryOffer,testimonialSlot}}
 *
 * Configs are cached and re-read when the file mtime changes, so the admin
 * config editor (and hand edits) take effect without a restart.
 *
 * If a file is missing or contains invalid JSON, a minimal in-code fallback
 * is used (with a one-time warning) so the server still boots.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const ALLOWED_FILES = ['site', 'products', 'emails'];

// --- Minimal fallbacks (server boots even with zero config files) ------------
function blankAddon() {
  return { enabled: false, name: '', priceCents: 0, priceDisplay: '', description: '' };
}

const FALLBACKS = {
  site: {
    businessName: 'Demo Business',
    tagline: 'A demo funnel — configure config/site.json',
    phone: '',
    email: '',
    paymentMode: 'demo',
    baseUrl: 'http://localhost:3000',
    footerNote: 'Demo funnel footer.',
    privacyNoteHtml: '<p>Demo privacy note — configure config/site.json.</p>',
  },
  products: {
    defaultProduct: 'demo-product',
    products: [
      {
        id: 'demo-product',
        name: 'Demo Product',
        priceCents: 1000,
        priceDisplay: '$10',
        billing: 'one-time',
        stripeLink: '',
        leadMagnet: {
          title: 'Free Demo Guide',
          description: 'A free sample lead magnet.',
          deliverableHtml: '<p>Your free demo guide would be delivered here.</p>',
        },
        salesCopy: {
          headline: 'Demo Product Headline',
          subhead: 'Demo subhead.',
          bullets: ['Benefit one', 'Benefit two'],
          cta: 'Buy Now',
        },
        orderBump: { ...blankAddon(), name: 'Demo Order Bump', priceCents: 500, priceDisplay: '$5' },
        upsell1: { ...blankAddon(), name: 'Demo Upsell 1', priceCents: 2000, priceDisplay: '$20' },
        upsell2: { ...blankAddon(), name: 'Demo Upsell 2', priceCents: 3000, priceDisplay: '$30' },
      },
    ],
  },
  emails: {
    fromName: 'Demo Business',
    fromEmail: 'hello@example.com',
    sequences: { nurture: [], abandonedCart: [], postPurchase: [] },
    weeklyFlyer: {
      headline: 'This week at Demo Business',
      featuredOfferId: 'demo-product',
      benefit: 'Demo benefit.',
      educational: 'Demo educational tip.',
      spotlight: 'Demo spotlight.',
      cta: 'Check it out',
      secondaryOffer: '',
      testimonialSlot: '',
    },
  },
};

// --- Loader with mtime cache --------------------------------------------------
const cache = {}; // name -> { mtimeMs, data }
const warned = new Set();

function load(name) {
  const file = path.join(CONFIG_DIR, `${name}.json`);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[config] ${file} not found — using built-in fallback (${name}).`);
    }
    return FALLBACKS[name];
  }
  const hit = cache[name];
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache[name] = { mtimeMs: stat.mtimeMs, data };
    warned.delete(name);
    return data;
  } catch (err) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[config] Failed to parse ${file}: ${err.message} — using built-in fallback.`);
    }
    return FALLBACKS[name];
  }
}

/** Normalize a product so missing addon blocks never crash the funnel. */
function normalizeProduct(p) {
  const prod = { ...p };
  for (const key of ['orderBump', 'upsell1', 'upsell2']) {
    prod[key] = { ...blankAddon(), ...(p[key] || {}) };
  }
  prod.leadMagnet = { title: '', description: '', deliverableHtml: '', ...(p.leadMagnet || {}) };
  prod.salesCopy = { headline: '', subhead: '', bullets: [], cta: 'Buy Now', ...(p.salesCopy || {}) };
  return prod;
}

function getSite() {
  const site = { ...FALLBACKS.site, ...load('site') };
  // APP_URL (e.g. https://funnel-qdx9.onrender.com in production) overrides the
  // configured baseUrl so absolute links in emails and admin pages always
  // point at the public site, never localhost.
  if (process.env.APP_URL) site.baseUrl = String(process.env.APP_URL).replace(/\/$/, '');
  return site;
}

function getProducts() {
  const raw = load('products');
  const products = Array.isArray(raw.products) ? raw.products.map(normalizeProduct) : [];
  return {
    defaultProduct: raw.defaultProduct || (products[0] && products[0].id) || 'demo-product',
    products: products.length ? products : FALLBACKS.products.products,
  };
}

function getEmails() {
  const raw = load('emails');
  return {
    fromName: raw.fromName || '',
    fromEmail: raw.fromEmail || '',
    sequences: {
      nurture: (raw.sequences && raw.sequences.nurture) || [],
      abandonedCart: (raw.sequences && raw.sequences.abandonedCart) || [],
      postPurchase: (raw.sequences && raw.sequences.postPurchase) || [],
    },
    weeklyFlyer: { ...FALLBACKS.emails.weeklyFlyer, ...(raw.weeklyFlyer || {}) },
  };
}

/** Product by id, falling back to the configured default product. */
function getProduct(id) {
  const cfg = getProducts();
  const found = cfg.products.find((p) => p.id === id);
  if (found) return found;
  const def = cfg.products.find((p) => p.id === cfg.defaultProduct);
  return def || cfg.products[0];
}

/** Persist a config file (used by the admin config editor). */
function saveConfig(name, obj) {
  if (!ALLOWED_FILES.includes(name)) throw new Error(`Unknown config file: ${name}`);
  const file = path.join(CONFIG_DIR, `${name}.json`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  delete cache[name]; // force re-read on next request
}

module.exports = { getSite, getProducts, getEmails, getProduct, saveConfig, ALLOWED_FILES, CONFIG_DIR };
```

### `lib/db.js`
```js
'use strict';
/**
 * lib/db.js — SQLite persistence layer.
 *
 * Two backends, chosen by environment:
 *   - Local (default): the built-in node:sqlite module, file at
 *     data/funnel.db (plus data/outbox/ for the local email outbox).
 *   - Turso: used when BOTH TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are
 *     set. Uses @libsql/client — the same client library works against a
 *     local file: URL and against a remote Turso database.
 *
 * The backend is lazy-loaded: only the active one is required, and the
 * @libsql/client dependency is only loaded in Turso mode.
 *
 * Exports (ALL return Promises — `await` them everywhere):
 *   run(sql, params) -> { changes, lastInsertRowid }
 *   get(sql, params) -> row | null
 *   all(sql, params) -> row[]
 *   recordEvent({ visitor_id, lead_id, type, product_id, meta })
 *   DATA_DIR, OUTBOX_DIR
 *
 * The schema is applied on both backends at boot. All timestamps are epoch
 * milliseconds.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
fs.mkdirSync(OUTBOX_DIR, { recursive: true });

const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const USE_TURSO = Boolean(TURSO_URL && TURSO_TOKEN);

// --- Schema ----------------------------------------------------------------
// One statement per string: @libsql/client's execute() takes exactly one
// statement at a time, so we run these sequentially on the Turso backend.
// (node:sqlite can run them all at once via db.exec, but a single sequential
// loop keeps both backends identical.)
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS visitors (
     id         TEXT PRIMARY KEY,
     first_seen INT,
     last_seen  INT,
     visits     INT,
     source     TEXT,
     campaign   TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS leads (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     visitor_id       TEXT,
     first_name       TEXT,
     email            TEXT UNIQUE,
     phone            TEXT,
     source           TEXT,
     campaign         TEXT,
     offer_of_interest TEXT,
     consent_marketing INT,
     consent_ts       INT,
     date_captured    INT,
     status           TEXT DEFAULT 'lead',
     unsubscribed     INT DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS page_views (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     visitor_id TEXT,
     lead_id    INT,
     path       TEXT,
     product_id TEXT,
     ts         INT
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     visitor_id TEXT,
     lead_id    INT,
     type       TEXT,
     product_id TEXT,
     meta       TEXT,
     ts         INT
   )`,
  `CREATE TABLE IF NOT EXISTS tags (
     lead_id INT,
     tag     TEXT,
     ts      INT,
     PRIMARY KEY (lead_id, tag)
   )`,
  `CREATE TABLE IF NOT EXISTS email_queue (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id      INT,
     email        TEXT,
     sequence     TEXT,
     step         TEXT,
     subject      TEXT,
     body_html    TEXT,
     product_id   TEXT,
     scheduled_for INT,
     sent_at      INT,
     status       TEXT DEFAULT 'queued',
     cancel_reason TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS purchases (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id      INT,
     product_id   TEXT,
     amount_cents INT,
     mode         TEXT,
     kind         TEXT DEFAULT 'initial',
     parent_id    INT,
     ts           INT
   )`,
  `CREATE TABLE IF NOT EXISTS carts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id    INT,
     visitor_id TEXT,
     product_id TEXT,
     started_at INT,
     purchased  INT DEFAULT 0,
     recovered  INT DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS suppressions (
     email  TEXT PRIMARY KEY,
     reason TEXT,
     ts     INT
   )`,
  // --- The Wealth Builder's Room (membership community) ---------------------
  `CREATE TABLE IF NOT EXISTS room_members (
     email         TEXT PRIMARY KEY,
     name          TEXT,
     password_hash TEXT,
     joined_at     INT,
     status        TEXT DEFAULT 'active',
     last_login    INT
   )`,
  `CREATE TABLE IF NOT EXISTS room_sessions (
     token      TEXT PRIMARY KEY,
     email      TEXT,
     created_at INT,
     expires_at INT
   )`,
  `CREATE TABLE IF NOT EXISTS room_progress (
     email   TEXT,
     week    INT,
     item    INT,
     checked INT,
     ts      INT,
     PRIMARY KEY (email, week, item)
   )`,
  `CREATE TABLE IF NOT EXISTS room_posts (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     author_email TEXT,
     author_name  TEXT,
     kind         TEXT DEFAULT 'post',
     title        TEXT,
     body         TEXT,
     pinned       INT DEFAULT 0,
     created_at   INT
   )`,
  `CREATE TABLE IF NOT EXISTS room_comments (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id      INT,
     author_email TEXT,
     author_name  TEXT,
     body         TEXT,
     created_at   INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views (visitor_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_events_lead ON events (lead_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_queue_status_due ON email_queue (status, scheduled_for)`,
  `CREATE INDEX IF NOT EXISTS idx_purchases_lead ON purchases (lead_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_carts_lead ON carts (lead_id, purchased)`,
  `CREATE INDEX IF NOT EXISTS idx_room_sessions_email ON room_sessions (email)`,
  `CREATE INDEX IF NOT EXISTS idx_room_progress_email ON room_progress (email)`,
  `CREATE INDEX IF NOT EXISTS idx_room_comments_post ON room_comments (post_id)`,
];

// --- Idempotent column migrations ------------------------------------------------
// Columns added after the initial schema. Each migration runs at boot (both
// backends) but the ALTER TABLE is skipped when the column already exists
// (checked via PRAGMA table_info), so reboots never error.
const MIGRATIONS = [
  { table: 'leads', column: 'goal', ddl: 'ALTER TABLE leads ADD COLUMN goal TEXT' },
  {
    table: 'room_members',
    column: 'onboarded',
    ddl: 'ALTER TABLE room_members ADD COLUMN onboarded INTEGER DEFAULT 0',
  },
];

/**
 * Apply MIGRATIONS against a backend's all()/run() pair. Table/column names
 * come from the trusted MIGRATIONS constant (never from user input), so the
 * PRAGMA string is safe.
 */
async function applyMigrations(all, run) {
  for (const m of MIGRATIONS) {
    const cols = await all(`PRAGMA table_info(${m.table})`);
    const exists = cols.some((c) => c && (c.name === m.column || Object.values(c)[1] === m.column));
    if (exists) continue;
    await run(m.ddl);
    console.log(`[db] migrated ${m.table}.${m.column}`);
  }
}

// --- Backend: local node:sqlite ----------------------------------------------
let localRun, localGet, localAll, localInit;
if (!USE_TURSO) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'funnel.db'));

  // Prepared-statement cache (hot paths like page-view logging).
  const stmtCache = new Map();
  function stmt(sql) {
    let s = stmtCache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmtCache.set(sql, s);
    }
    return s;
  }

  const normRun = (info) => ({
    changes: Number(info.changes || 0),
    lastInsertRowid: info.lastInsertRowid == null ? null : Number(info.lastInsertRowid),
  });

  localRun = (sql, params = []) => Promise.resolve(normRun(stmt(sql).run(...params)));
  localGet = (sql, params = []) => Promise.resolve(stmt(sql).get(...params) ?? null);
  localAll = (sql, params = []) => Promise.resolve(stmt(sql).all(...params));
  localInit = async () => {
    for (const s of SCHEMA_STATEMENTS) db.exec(s);
    await applyMigrations(localAll, localRun);
  };
}

// --- Backend: Turso via @libsql/client ---------------------------------------
let tursoRun, tursoGet, tursoAll, tursoInit;
if (USE_TURSO) {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  tursoRun = async (sql, params = []) => {
    const rs = await client.execute({ sql, args: params });
    return {
      changes: Number(rs.rowsAffected ?? 0),
      lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid),
    };
  };
  tursoGet = async (sql, params = []) => {
    const rs = await client.execute({ sql, args: params });
    return rs.rows.length ? rs.rows[0] : null;
  };
  tursoAll = async (sql, params = []) => {
    const rs = await client.execute({ sql, args: params });
    return rs.rows;
  };
  tursoInit = async () => {
    for (const s of SCHEMA_STATEMENTS) {
      // One statement per execute() — this is a @libsql/client requirement.
      await client.execute(s);
    }
    await applyMigrations(tursoAll, tursoRun);
  };
}

const active = USE_TURSO
  ? { run: tursoRun, get: tursoGet, all: tursoAll, init: tursoInit, name: 'turso' }
  : { run: localRun, get: localGet, all: localAll, init: localInit, name: 'node:sqlite' };

console.log(`[db] backend: ${active.name}${USE_TURSO ? ` (${TURSO_URL.replace(/:[^:@]*@/, ':***@')})` : ''}`);

// Schema is applied once at boot. Every exported call awaits this so no
// query can run before the tables exist (matters for the remote backend).
const ready = active.init().catch((err) => {
  console.error('[db] schema initialization failed:', err && err.message ? err.message : err);
  throw err;
});

async function run(sql, params = []) {
  await ready;
  return active.run(sql, params);
}

async function get(sql, params = []) {
  await ready;
  return active.get(sql, params);
}

async function all(sql, params = []) {
  await ready;
  return active.all(sql, params);
}

/** Append-only funnel event log. meta is stored as JSON. */
async function recordEvent({ visitor_id = null, lead_id = null, type, product_id = null, meta = null }) {
  return run(
    'INSERT INTO events (visitor_id, lead_id, type, product_id, meta, ts) VALUES (?, ?, ?, ?, ?, ?)',
    [visitor_id, lead_id, type, product_id, meta ? JSON.stringify(meta) : null, Date.now()]
  );
}

module.exports = { run, get, all, recordEvent, ready, DATA_DIR, OUTBOX_DIR };
```

### `lib/email.js`
```js
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

async function sendResendStub({ to, subject, html, queueId, fromName, fromEmail }) {
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
      if (process.env.RESEND_API_KEY) {
        result = await sendResendStub({ to, subject, html, queueId, fromName, fromEmail });
      } else {
        console.warn('[email] EMAIL_PROVIDER=resend but RESEND_API_KEY is not set — falling back to local outbox.');
        result = await sendLocal({ to, subject, html, queueId, fromName, fromEmail });
      }
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
```

### `lib/room.js`
```js
'use strict';
/**
 * lib/room.js — The Wealth Builder's Room membership logic.
 *
 * Member lifecycle:
 *   1. Stripe checkout.session.completed ($49) -> upsertMemberFromPurchase()
 *      creates an ACTIVE member row keyed by email (no password yet).
 *   2. Member visits /room/claim, enters the email they paid with, and sets
 *      a password -> password_hash stored (scrypt), session created.
 *   3. Email + password login at /room/login -> httpOnly session cookie.
 *
 * Content: lessons live in content/room/lessons/*.md and the 90-day plan in
 * content/room/plan.json — plain files Davena can edit; re-read on mtime
 * change, no restart or code deploy needed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');

const ROOM_DIR = path.join(__dirname, '..', 'content', 'room');
const LESSONS_DIR = path.join(ROOM_DIR, 'lessons');
const PLAN_FILE = path.join(ROOM_DIR, 'plan.json');

const SESSION_COOKIE = 'room_sess';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// Sections in display order. Each section loads one or more markdown files
// (no extension) from content/room/lessons/, concatenated in the order
// listed. Older pillars used `file: 'name'` (a single file); sections use
// `files: [...]`. Both forms are supported — edit titles/files here or add
// new section files. The slug is the URL key at /room/classroom/:slug.
const PILLARS = [
  { id: 'start-here', slug: 'start-here', files: ['00-start-here'], title: '00 — Start Here', tagline: 'Welcome in — here is how the Room works.' },
  { id: 'wealth-mindset', slug: 'wealth-mindset', files: ['01-wealth-mindset'], title: '01 — Wealth Mindset, Habits & Decisions', tagline: 'How you think about money decides what you do with it.' },
  { id: 'money-cashflow', slug: 'money-cashflow', files: ['money-management', 'cash-flow'], title: '02 — Money Management & Cash Flow', tagline: 'Track it, direct it, keep more of it.' },
  { id: 'assets-ownership', slug: 'assets-ownership', files: ['assets-investing', 'real-estate', 'funding-capital', 'business-income', 'marketing-sales'], title: '03 — Assets, Investing & Ownership', tagline: 'Build an income-producing business you own — and assets that pay you.' },
  { id: '90-day-plan', slug: '90-day-plan', files: ['04-90-day-plan'], title: '04 — The 90-Day Wealth Action Plan', tagline: 'Your interactive plan: 12 weeks of small, trackable actions.' },
];

// Old pillar slugs (pre-5-section remap) -> their new section slug.
// Wire as 301 redirects so old classroom links land on the right section.
const PILLAR_REDIRECTS = {
  'money-management': 'money-cashflow',
  'cash-flow': 'money-cashflow',
  'business-income': 'assets-ownership',
  'marketing-sales': 'assets-ownership',
  'funding-capital': 'assets-ownership',
  'assets-investing': 'assets-ownership',
  'real-estate': 'assets-ownership',
};

// --- Password hashing (scrypt, node built-ins only) ---------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64);
    const a = Buffer.from(hash.toString('hex'), 'utf8');
    const b = Buffer.from(hashHex, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// --- Members ------------------------------------------------------------------
async function getMember(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  return db.get('SELECT * FROM room_members WHERE email = ?', [clean]);
}

/**
 * Create or refresh a member from a completed Stripe purchase. Idempotent:
 * re-running for the same email keeps the existing password and never
 * deactivates a member.
 */
async function upsertMemberFromPurchase({ email, name }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  const now = Date.now();
  await db.run(
    `INSERT INTO room_members (email, name, joined_at, status)
     VALUES (?, ?, ?, 'active')
     ON CONFLICT(email) DO UPDATE SET
       name = COALESCE(room_members.name, excluded.name),
       status = 'active'`,
    [clean, (name || '').trim() || null, now]
  );
  return getMember(clean);
}

async function setMemberPassword(email, password) {
  const clean = String(email || '').trim().toLowerCase();
  await db.run('UPDATE room_members SET password_hash = ? WHERE email = ?', [hashPassword(password), clean]);
}

async function setMemberStatus(email, status) {
  const clean = String(email || '').trim().toLowerCase();
  const s = status === 'inactive' ? 'inactive' : 'active';
  await db.run('UPDATE room_members SET status = ? WHERE email = ?', [s, clean]);
  if (s === 'inactive') {
    await db.run('DELETE FROM room_sessions WHERE email = ?', [clean]);
  }
}

// --- Sessions -------------------------------------------------------------------
async function createSession(email) {
  const clean = String(email || '').trim().toLowerCase();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await db.run('INSERT INTO room_sessions (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)', [
    token, clean, now, now + SESSION_TTL_MS,
  ]);
  await db.run('UPDATE room_members SET last_login = ? WHERE email = ?', [now, clean]);
  return token;
}

async function getSessionMember(token) {
  if (!token || typeof token !== 'string') return null;
  const row = await db.get('SELECT * FROM room_sessions WHERE token = ?', [token]);
  if (!row || Number(row.expires_at) < Date.now()) {
    if (row) await db.run('DELETE FROM room_sessions WHERE token = ?', [token]);
    return null;
  }
  const member = await getMember(row.email);
  if (!member || member.status !== 'active') return null;
  return member;
}

async function destroySession(token) {
  if (token) await db.run('DELETE FROM room_sessions WHERE token = ?', [token]);
}

// --- 90-day plan progress --------------------------------------------------------
async function getProgress(email) {
  const clean = String(email || '').trim().toLowerCase();
  const rows = await db.all('SELECT week, item, checked FROM room_progress WHERE email = ?', [clean]);
  const map = {};
  for (const r of rows) map[`${r.week}:${r.item}`] = r.checked ? 1 : 0;
  return map;
}

async function setProgress(email, week, item, checked) {
  const clean = String(email || '').trim().toLowerCase();
  const w = Math.max(1, Math.min(12, parseInt(week, 10) || 1));
  const i = Math.max(0, parseInt(item, 10) || 0);
  await db.run(
    `INSERT INTO room_progress (email, week, item, checked, ts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email, week, item) DO UPDATE SET checked = excluded.checked, ts = excluded.ts`,
    [clean, w, i, checked ? 1 : 0, Date.now()]
  );
}

// --- Community ---------------------------------------------------------------------
async function listPosts(limit = 50) {
  return db.all(
    `SELECT p.*, (SELECT COUNT(*) FROM room_comments c WHERE c.post_id = p.id) AS comment_count
     FROM room_posts p ORDER BY p.pinned DESC, p.created_at DESC LIMIT ?`,
    [limit]
  );
}

async function getPost(id) {
  return db.get('SELECT * FROM room_posts WHERE id = ?', [Number(id) || 0]);
}

async function listComments(postId) {
  return db.all('SELECT * FROM room_comments WHERE post_id = ? ORDER BY created_at ASC', [Number(postId) || 0]);
}

async function createPost({ authorEmail, authorName, kind, title, body }) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody) throw new Error('Post body is required.');
  const k = kind === 'announcement' ? 'announcement' : 'post';
  const r = await db.run(
    'INSERT INTO room_posts (author_email, author_name, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      String(authorEmail || '').trim().toLowerCase() || null,
      String(authorName || '').trim() || null,
      k,
      String(title || '').trim().slice(0, 140) || null,
      cleanBody.slice(0, 5000),
      Date.now(),
    ]
  );
  return r.lastInsertRowid;
}

async function createComment({ postId, authorEmail, authorName, body }) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody) throw new Error('Comment body is required.');
  const post = await getPost(postId);
  if (!post) throw new Error('Post not found.');
  const r = await db.run(
    'INSERT INTO room_comments (post_id, author_email, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)',
    [
      post.id,
      String(authorEmail || '').trim().toLowerCase() || null,
      String(authorName || '').trim() || null,
      cleanBody.slice(0, 2000),
      Date.now(),
    ]
  );
  return r.lastInsertRowid;
}

async function setPinned(postId, pinned) {
  await db.run('UPDATE room_posts SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, Number(postId) || 0]);
}

async function deletePost(postId) {
  const id = Number(postId) || 0;
  await db.run('DELETE FROM room_comments WHERE post_id = ?', [id]);
  await db.run('DELETE FROM room_posts WHERE id = ?', [id]);
}

async function deleteComment(commentId) {
  await db.run('DELETE FROM room_comments WHERE id = ?', [Number(commentId) || 0]);
}

// --- Content loading (mtime cache; Davena edits files, no restart needed) -------
const contentCache = {}; // key -> { mtimeMs, data }
function readCached(key, file, parse) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = contentCache[key];
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  const raw = fs.readFileSync(file, 'utf8');
  const data = parse(raw);
  contentCache[key] = { mtimeMs: stat.mtimeMs, data };
  return data;
}

/** Minimal markdown -> HTML for lesson files. Headings, bold, italic,
 *  blockquotes, ordered/unordered lists, paragraphs. Escapes everything else. */
function mdToHtml(md) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = String(md).split('\n');
  let html = '';
  let listTag = null;
  const closeList = () => {
    if (listTag) {
      html += `</${listTag}>`;
      listTag = null;
    }
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      closeList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)/.exec(t);
    if (h) {
      closeList();
      html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`;
      continue;
    }
    if (t.startsWith('>')) {
      closeList();
      html += `<blockquote>${inline(t.replace(/^>\s?/, ''))}</blockquote>`;
      continue;
    }
    const ul = /^[-*]\s+(.*)/.exec(t);
    const ol = /^\d+[.)]\s+(.*)/.exec(t);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      const text = ul ? ul[1] : ol[1];
      if (listTag !== tag) {
        closeList();
        html += `<${tag}>`;
        listTag = tag;
      }
      html += `<li>${inline(text)}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inline(t)}</p>`;
  }
  closeList();
  return html;
}

/** Return the markdown file list for a pillar/section, supporting both the
 *  older `file: 'name'` form and the newer `files: [...]` form. */
function pillarFiles(pillar) {
  if (Array.isArray(pillar.files) && pillar.files.length) return pillar.files;
  if (pillar.file) return [pillar.file];
  return [];
}

function getPillar(pillarId) {
  const pillar = PILLARS.find((p) => p.id === pillarId || p.slug === pillarId);
  if (!pillar) return null;
  const files = pillarFiles(pillar);
  const cacheKey = `lesson:${pillar.id}`;
  // mtime-aware: cache entry stores the newest mtime across all files.
  let html = null;
  const parts = [];
  let missing = false;
  for (const name of files) {
    const file = path.join(LESSONS_DIR, `${name}.md`);
    const part = readCached(`${cacheKey}:${name}`, file, (raw) => mdToHtml(raw));
    if (part == null) {
      missing = true;
      break;
    }
    parts.push(part);
  }
  if (missing || parts.length === 0) return null;
  html = parts.join('\n<hr>\n');
  return { ...pillar, html };
}

function getPillars() {
  return PILLARS.map((p) => ({ ...p, available: pillarFiles(p).some((name) => fs.existsSync(path.join(LESSONS_DIR, `${name}.md`))) }));
}

function getPlan() {
  try {
    const plan = readCached('plan', PLAN_FILE, (raw) => JSON.parse(raw));
    if (!plan || !Array.isArray(plan.weeks)) return { weeks: [] };
    return plan;
  } catch (err) {
    console.warn('[room] plan.json is not valid JSON — showing empty plan:', err.message);
    return { weeks: [] };
  }
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  PILLARS,
  PILLAR_REDIRECTS,
  hashPassword,
  verifyPassword,
  getMember,
  upsertMemberFromPurchase,
  setMemberPassword,
  setMemberStatus,
  createSession,
  getSessionMember,
  destroySession,
  getProgress,
  setProgress,
  listPosts,
  getPost,
  listComments,
  createPost,
  createComment,
  setPinned,
  deletePost,
  deleteComment,
  getPillar,
  getPillars,
  getPlan,
  mdToHtml,
};
```

### `public/style.css`
```css
/* TransitNow funnel styles — mobile-first.
   Navy #1F3A5F + yellow #F5B301 branding, system fonts, large tap targets. */

:root {
  --navy: #1F3A5F;
  --navy-dark: #12263f;
  --yellow: #F5B301;
  --yellow-dark: #d99a00;
  --text: #1c1c1c;
  --muted: #5a5a5a;
  --bg: #ffffff;
  --card-bg: #f7f9fc;
  --border: #d7dde6;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--text);
  background: var(--bg);
  line-height: 1.6;
  font-size: 17px;
}

.container {
  max-width: 640px;
  margin: 0 auto;
  padding: 0 16px;
}

/* Header */
.site-header {
  background: var(--navy);
  color: #fff;
  padding: 20px 0;
}
.site-header .brand {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: .02em;
}
.site-header .tagline {
  color: var(--yellow);
  font-size: 15px;
  margin-top: 4px;
}

/* Footer */
.site-footer {
  background: var(--navy-dark);
  color: #cfd8e3;
  padding: 28px 0;
  margin-top: 40px;
  font-size: 14px;
}
.site-footer a { color: var(--yellow); }
.footer-note { margin: 0 0 12px; }
.footer-contact { margin: 0 0 8px; font-weight: 600; color: #fff; }
.footer-links { margin: 0 0 8px; }
.footer-copy { margin: 0; color: #9fb0c3; }

/* Typography */
h1 { font-size: 30px; line-height: 1.25; color: var(--navy); margin: 24px 0 12px; }
h2 { font-size: 22px; color: var(--navy); margin: 24px 0 8px; }
.subhead { font-size: 19px; color: var(--muted); }
p { margin: 0 0 12px; }

/* Bullets */
.bullets { padding-left: 20px; margin: 16px 0; }
.bullets li { margin-bottom: 8px; }

/* Buttons — 48px+ tap targets */
.btn {
  display: inline-block;
  min-height: 48px;
  line-height: 48px;
  padding: 0 24px;
  background: var(--yellow);
  color: var(--navy-dark);
  font-weight: 800;
  font-size: 18px;
  text-align: center;
  text-decoration: none;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  margin: 12px 0;
}
.btn:active { background: var(--yellow-dark); }
.btn-large {
  display: block;
  width: 100%;
  min-height: 56px;
  line-height: 56px;
  font-size: 20px;
}
.btn-secondary {
  background: #e8e8e8;
  color: var(--navy-dark);
  font-weight: 600;
}

/* Forms */
.form { margin: 20px 0; }
.form label {
  display: block;
  font-weight: 600;
  margin-bottom: 16px;
}
.form input[type=text],
.form input[type=email],
.form input[type=tel] {
  display: block;
  width: 100%;
  min-height: 52px;
  margin-top: 6px;
  padding: 0 14px;
  font-size: 17px;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  background: #fff;
}
.form input:focus {
  outline: 2px solid var(--yellow);
  border-color: var(--navy);
}
.optional { font-weight: 400; color: var(--muted); font-size: 15px; }
.hint { display: block; font-weight: 400; font-size: 14px; color: var(--muted); margin-top: 4px; }
.checkbox {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  font-weight: 400;
}
.checkbox input[type=checkbox] {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  margin-top: 2px;
  accent-color: var(--navy);
}

/* Cards & price */
.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin: 20px 0;
}
.price-box { text-align: center; }
.price { font-size: 36px; font-weight: 800; color: var(--navy); margin: 0; }
.price-line { font-size: 22px; font-weight: 700; color: var(--navy); }
.billing { color: var(--muted); font-size: 15px; }
.honest-note { font-size: 14px; color: var(--muted); font-style: italic; }

.deliverable ol li { margin-bottom: 12px; }

/* Microcopy & misc */
.microcopy { font-size: 14px; color: var(--muted); }
.testimonial-slot {
  border: 2px dashed var(--border);
  border-radius: 8px;
  padding: 16px;
  color: var(--muted);
  font-size: 14px;
  margin: 24px 0;
}
.contact-line { margin-top: 24px; }
.page-footer { margin-top: 32px; font-size: 14px; color: var(--muted); }
.next-step { margin-top: 28px; }
a { color: var(--navy); }

/* Larger screens */
@media (min-width: 700px) {
  h1 { font-size: 36px; }
  .btn-large { width: auto; }
}

/* Wealth Builder's Room additions — mobile-first */

/* Error banner on the room lead-capture form */
.form-error {
  background: #fdecec;
  border: 1.5px solid #d64545;
  color: #8f1d1d;
  border-radius: 8px;
  padding: 12px 14px;
  font-weight: 600;
  margin: 16px 0;
}

/* Dropdown on the room lead-capture form */
.form select {
  display: block;
  width: 100%;
  min-height: 52px;
  margin-top: 6px;
  padding: 0 14px;
  font-size: 17px;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  background: #fff;
  color: var(--text);
}
.form select:focus {
  outline: 2px solid var(--yellow);
  border-color: var(--navy);
}

/* Module tiles on the room pages */
.module-list { margin: 16px 0; }
.module { margin: 12px 0; padding: 16px; }
.module-title { font-weight: 800; color: var(--navy); margin: 0 0 6px; }
.module-desc { margin: 0; color: var(--muted); font-size: 16px; }
```

### `scripts/test-funnel.js`
```js
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
```

### `server.js`
```js
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
    // Foundational posts stay pinned so new members see them first.
    if (row && row.id && !row.pinned) {
      await room.setPinned(row.id, true);
    }
  }
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
  res.send(roomViews.dashboardPage({
    member: req.roomMember,
    progress: { total, done, pct: total ? Math.round((done / total) * 100) : 0 },
    announcements,
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
  res.send(adminViews.adminLayout("Wealth Builder's Room", roomViews.roomAdminPage({ members, posts })));
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
```

### `views/admin.js`
```js
// Admin view helpers. Simple semantic HTML; the backend wires these into
// /admin routes and supplies real data. No backend logic here.
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function adminLayout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Funnel Admin</title>
<link rel="stylesheet" href="/style.css">
<style>
.admin-nav{background:#12263f;color:#fff;padding:12px 16px;margin-bottom:16px}
.admin-nav a{color:#F5B301;margin-right:16px;text-decoration:none;font-weight:600}
.admin-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
.admin-table th,.admin-table td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top}
.admin-table th{background:#1F3A5F;color:#fff}
.metric-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}
.metric-card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;text-align:center}
.metric-card .num{font-size:28px;font-weight:700;color:#1F3A5F}
.metric-card .label{font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.05em}
.funnel-bar{margin:8px 0}
.funnel-bar .bar-label{font-size:13px;font-weight:600;margin-bottom:4px}
.funnel-bar .bar-track{background:#e8e8e8;border-radius:4px;height:28px;position:relative}
.funnel-bar .bar-fill{background:#1F3A5F;border-radius:4px;height:100%;min-width:4px}
.funnel-bar .bar-value{position:absolute;right:8px;top:4px;font-size:13px;font-weight:700;color:#12263f}
.filter-form{margin:12px 0;display:flex;gap:8px;flex-wrap:wrap}
.filter-form input[type=text]{min-height:44px;padding:0 12px;border:1px solid #aaa;border-radius:6px}
pre.config-view{background:#f4f4f4;padding:12px;border-radius:6px;overflow:auto;font-size:12px;max-height:60vh}
.admin-status-pill{display:inline-block;background:#1F3A5F;color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700;letter-spacing:.04em}
.muted{color:#777}
</style>
</head>
<body>
<nav class="admin-nav">
  <a href="/admin">Dashboard</a>
  <a href="/admin/leads">Leads</a>
  <a href="/admin/carts">Carts</a>
  <a href="/admin/emails">Emails</a>
  <a href="/admin/outbox">Outbox</a>
  <a href="/admin/suppressions">Suppressions</a>
  <a href="/admin/room">Room</a>
  <a href="/admin/config">Config</a>
</nav>
<main class="container admin">
<h1>${esc(title)}</h1>
${bodyHtml}
</main>
</body>
</html>`;
}

function filterForm(action, q) {
  return `<form class="filter-form" method="GET" action="${esc(action)}">
    <input type="text" name="q" value="${esc(q || '')}" placeholder="Search…">
    <button type="submit" class="btn">Filter</button>
  </form>`;
}

function metricCards(metrics) {
  const m = metrics || {};
  const cards = [
    ['Visitors', m.visitors],
    ['Leads', m.leads],
    ['Checkouts', m.checkouts],
    ['Customers', m.customers],
    ['Upsell customers', m.upsellCustomers],
    ['Repeat customers', m.repeatCustomers],
  ];
  return '<div class="metric-cards">' + cards.map(([label, v]) =>
    `<div class="metric-card"><div class="num">${esc(v == null ? '—' : v)}</div><div class="label">${esc(label)}</div></div>`
  ).join('') + '</div>';
}

function funnelBars(metrics) {
  const m = metrics || {};
  const stages = [
    ['VISITORS', m.visitors],
    ['LEADS', m.leads],
    ['CHECKOUTS', m.checkouts],
    ['CUSTOMERS', m.customers],
    ['UPSELL CUSTOMERS', m.upsellCustomers],
    ['REPEAT CUSTOMERS', m.repeatCustomers],
  ];
  const max = Math.max(1, ...stages.map(([, v]) => Number(v) || 0));
  return '<h2>Funnel</h2>' + stages.map(([label, v]) => {
    const n = Number(v) || 0;
    const pct = Math.max(2, Math.round((n / max) * 100));
    return `<div class="funnel-bar">
      <div class="bar-label">${esc(label)} — ${esc(n)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div><span class="bar-value">${esc(n)}</span></div>
    </div>`;
  }).join('');
}

function dashboardHtml(metrics, site) {
  return `
<p>Business: <strong>${esc((site || {}).businessName || '')}</strong> · Payment mode: <strong>${esc((site || {}).paymentMode || '')}</strong></p>
${metricCards(metrics)}
${funnelBars(metrics)}
<p class="microcopy">Conversion shown relative to the largest stage. Metrics are cumulative counts from the data store.</p>`;
}

function table(headers, rows) {
  const thead = '<thead><tr>' + headers.map(h => `<th>${esc(h)}</th>`).join('') + '</tr></thead>';
  const tbody = '<tbody>' + rows.map(r =>
    '<tr>' + r.map(c => `<td>${c == null ? '' : esc(c)}</td>`).join('') + '</tr>'
  ).join('') + '</tbody>';
  return `<table class="admin-table">${thead}${tbody}</table>`;
}

function leadsTableHtml(leads, query) {
  const q = (query || {}).q || '';
  const list = Array.isArray(leads) ? leads : [];
  const rows = list.map(l => [
    l.id, l.first_name, l.email, l.phone, l.source, l.campaign,
    l.consent ? 'yes' : 'no', l.created_at,
  ]);
  return filterForm('/admin/leads', q) +
    `<p>${list.length} lead(s)</p>` +
    table(['ID', 'First name', 'Email', 'Phone', 'Source', 'Campaign', 'Consent', 'Created'], rows);
}

function cartsTableHtml(carts) {
  const list = Array.isArray(carts) ? carts : [];
  const rows = list.map(c => [
    c.id, c.lead_id, c.product_id, c.status, c.checkout_url || c.checkoutUrl,
    c.abandoned_at || c.updated_at,
  ]);
  return `<p>${list.length} cart(s)</p>` +
    table(['ID', 'Lead', 'Product', 'Status', 'Checkout URL', 'Last update'], rows);
}

function emailsTableHtml(queue) {
  const list = Array.isArray(queue) ? queue : [];
  const rows = list.map(e => [
    e.id, e.lead_id, e.sequence, e.step_id, e.subject,
    e.scheduled_at, e.sent_at || 'pending', e.status,
  ]);
  return `<p>${list.length} queued/sent email(s)</p>` +
    table(['ID', 'Lead', 'Sequence', 'Step', 'Subject', 'Scheduled', 'Sent', 'Status'], rows);
}

function outboxHtml(items) {
  const list = Array.isArray(items) ? items : [];
  const rows = list.map(o => [
    o.id, o.to, o.subject, o.created_at, o.status, o.error || '',
  ]);
  return `<p>${list.length} outbox item(s)</p>` +
    table(['ID', 'To', 'Subject', 'Created', 'Status', 'Error'], rows);
}

function suppressionsHtml(list) {
  const arr = Array.isArray(list) ? list : [];
  const rows = arr.map(s => [
    s.email, s.reason || 'unsubscribed', s.created_at,
  ]);
  return `
<p>Emails on this list never receive marketing mail. Add via the unsubscribe page or here.</p>
<form class="filter-form" method="POST" action="/admin/suppressions">
  <input type="text" name="email" placeholder="email@example.com" required>
  <button type="submit" class="btn">Add suppression</button>
</form>
<p>${arr.length} suppression(s)</p>` +
    table(['Email', 'Reason', 'Added'], rows);
}

function configEditorHtml(products, emails, site) {
  const section = (name, obj) =>
    `<h2>${esc(name)}</h2><pre class="config-view">${esc(JSON.stringify(obj, null, 2))}</pre>`;
  return `
<p class="microcopy">Live config: files are re-read automatically when they change, so edits saved through the <code>POST /admin/config/:file</code> endpoint — or made directly in <code>config/*.json</code> — take effect immediately. No restart needed.</p>
${section('config/site.json', site || {})}
${section('config/products.json', products || {})}
${section('config/emails.json', emails || {})}`;
}

/* =====================================================================
 * METRICS / DERIVATION SPEC — contract for the coordinator wiring the
 * admin routes (/admin, /admin/leads/:id, /admin/config).
 *
 * The helpers below are render-only: they take precomputed plain objects
 * and return HTML. All SQL/derivation lives in the route layer (server.js).
 * Timestamps in the DB are epoch milliseconds. No secret values are ever
 * rendered by these views.
 *
 * dashboardSectionsHtml(m) — `m` is ONE metrics object. Every field is
 * optional; missing fields render as "—".
 *
 *   LEADS
 *     totalLeads      SELECT COUNT(*) FROM leads
 *     newLeads7d      SELECT COUNT(*) FROM leads WHERE date_captured > weekAgo
 *     convertedLeads  SELECT COUNT(DISTINCT lead_id) FROM purchases
 *                     WHERE kind = 'initial'
 *     conversionRate  convertedLeads / totalLeads as a fraction 0–1
 *                     (rendered as %, e.g. 0.25 → "25%")
 *
 *   SALES
 *     activeMembers   SELECT COUNT(*) FROM room_members WHERE status = 'active'
 *     newMembers7d    SELECT COUNT(*) FROM room_members
 *                     WHERE status = 'active' AND joined_at > weekAgo
 *     mrr             Monthly recurring revenue in DOLLARS, e.g.
 *                     activeMembers * 49 (the Room is $49/month). Coordinator
 *                     may instead sum plan prices if more plans exist.
 *     failedPayments  SELECT COUNT(*) FROM events WHERE type = 'payment_failed'
 *                     (0 if the funnel does not record this event type)
 *     canceledMemberships
 *                     SELECT COUNT(*) FROM room_members WHERE status = 'canceled'
 *
 *   CARTS
 *     startedCheckouts   SELECT COUNT(*) FROM carts
 *     completedCheckouts SELECT COUNT(*) FROM carts WHERE purchased = 1
 *     abandonedCarts     SELECT COUNT(*) FROM tags WHERE tag = 'ABANDONED_CART'
 *
 *   EMAILS
 *     emailsSent      SELECT COUNT(*) FROM email_queue WHERE status = 'sent'
 *     emailsFailed    SELECT COUNT(*) FROM email_queue WHERE status = 'failed'
 *     emailsPending   SELECT COUNT(*) FROM email_queue WHERE status = 'queued'
 *     emailsSuppressed
 *                     SELECT COUNT(*) FROM suppressions
 *
 *   ROOM
 *     roomActiveMembers
 *                     SELECT COUNT(*) FROM room_members WHERE status = 'active'
 *     roomClaimedMembers
 *                     SELECT COUNT(*) FROM room_members
 *                     WHERE status = 'active' AND onboarded = 1
 *     roomUnclaimedMembers
 *                     SELECT COUNT(*) FROM room_members
 *                     WHERE status = 'active'
 *                       AND (onboarded = 0 OR onboarded IS NULL)
 *     roomPosts       SELECT COUNT(*) FROM room_posts
 *
 *   weekAgo = Date.now() - 7 * 24 * 3600e3
 *
 * leadDetailHtml(lead, ctx) — full single-lead view.
 *
 *   lead: {
 *     id, first_name (or name), email, phone, goal ("what are you building"),
 *     source, campaign,
 *     created_at    pre-formatted display string (e.g. fmtTs(date_captured)),
 *     last_activity pre-formatted display string (e.g. latest timestamp across
 *                   page_views / events / email_queue for this lead),
 *     lead_status:       display string from the vocabulary below,
 *     cart_status:       display string, e.g. 'open' | 'abandoned' | 'purchased',
 *     purchase_status:   display string, e.g. 'none' | 'paid',
 *     membership_status: display string, e.g. 'none' | 'active' | 'canceled',
 *   }
 *   ctx: { emails: [{ subject, status, date }] }
 *        — one row per queued/sent email for the lead; date pre-formatted.
 *   Status vocabulary rendered verbatim: NEW, ENGAGED, CHECKOUT_STARTED,
 *   PURCHASED, ACTIVE_MEMBER, CANCELED, SUPPRESSED. The coordinator derives
 *   these; the view only renders the string it is given.
 *
 * configEnvHtml(envStatus) — environment-variable documentation.
 *
 *   envStatus: { [VAR_NAME]: boolean | { set: boolean, hint?: string } }
 *     A plain boolean is fine (true/false = is the var set). The { set, hint }
 *     form additionally shows a NON-SECRET hint (e.g. first 3 chars of the
 *     value). Never pass full secrets in — the view prints only "set (hidden)"
 *     or hint + "…".
 * ===================================================================== */

function sectionCards(title, cards) {
  const items = cards
    .map(
      ([label, value]) =>
        `<div class="metric-card"><div class="num">${esc(value == null ? '—' : value)}</div>` +
        `<div class="label">${esc(label)}</div></div>`
    )
    .join('');
  return `<h2>${esc(title)}</h2><div class="metric-cards">${items}</div>`;
}

function dashboardSectionsHtml(m) {
  const mm = m || {};
  const money = (v) =>
    v == null
      ? '—'
      : '$' +
        Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v) => (v == null ? '—' : Math.round(v * 10000) / 100 + '%');
  return `
${sectionCards('Leads', [
  ['Total leads', mm.totalLeads],
  ['New leads (last 7 days)', mm.newLeads7d],
  ['Converted leads', mm.convertedLeads],
  ['Conversion rate', pct(mm.conversionRate)],
])}
${sectionCards('Sales', [
  ['Active members', mm.activeMembers],
  ['New members (7 days)', mm.newMembers7d],
  ['Monthly recurring revenue (MRR)', money(mm.mrr)],
  ['Failed payments', mm.failedPayments],
  ['Canceled memberships', mm.canceledMemberships],
])}
${sectionCards('Checkouts', [
  ['Started checkouts', mm.startedCheckouts],
  ['Completed checkouts', mm.completedCheckouts],
  ['Abandoned carts', mm.abandonedCarts],
])}
${sectionCards('Emails', [
  ['Sent', mm.emailsSent],
  ['Failed', mm.emailsFailed],
  ['Pending', mm.emailsPending],
  ['Suppressed', mm.emailsSuppressed],
])}
${sectionCards('Wealth Builder\u2019s Room', [
  ['Active members', mm.roomActiveMembers],
  ['Claimed members', mm.roomClaimedMembers],
  ['Unclaimed members', mm.roomUnclaimedMembers],
  ['Posts', mm.roomPosts],
])}`;
}

function statusPill(s) {
  const v = String(s == null || s === '' ? '—' : s).toUpperCase();
  return `<span class="admin-status-pill">${esc(v)}</span>`;
}

function leadDetailHtml(lead, ctx) {
  const l = lead || {};
  const emails = ctx && Array.isArray(ctx.emails) ? ctx.emails : [];
  const row = (label, value) =>
    `<tr><td>${esc(label)}</td><td>${
      value == null || value === '' ? '<span class="muted">—</span>' : esc(value)
    }</td></tr>`;
  const detailTable =
    '<table class="admin-table"><tbody>' +
    row('Name', l.first_name || l.name) +
    row('Email', l.email) +
    row('Phone', l.phone) +
    row('Goal ("what are you building")', l.goal) +
    row('Source', l.source) +
    row('Campaign', l.campaign) +
    row('Date created', l.created_at) +
    row('Last activity', l.last_activity) +
    `<tr><td>Lead status</td><td>${statusPill(l.lead_status)}</td></tr>` +
    `<tr><td>Cart status</td><td>${statusPill(l.cart_status)}</td></tr>` +
    `<tr><td>Purchase status</td><td>${statusPill(l.purchase_status)}</td></tr>` +
    `<tr><td>Membership status</td><td>${statusPill(l.membership_status)}</td></tr>` +
    '</tbody></table>';
  const emailRows = emails.map((e) => [
    e.subject,
    e.status,
    e.date,
  ]);
  return `<p><a href="/admin/leads">&larr; Back to leads</a></p>
<h2>${esc(l.first_name || l.name || 'Lead')}</h2>
${detailTable}
<h2>Email history</h2>
<p>${emails.length} email(s)</p>` +
    table(['Subject', 'Status', 'Date'], emailRows);
}

// --- Environment variable documentation --------------------------------------
// One plain-English entry per required env var. `setup` is shown only when the
// variable is NOT set. Never render raw secret values here.
const ENV_DOCS = [
  {
    name: 'PORT',
    purpose: 'The port the server listens on (defaults to 3000 if unset).',
    setup: 'Set PORT=3000 in the shell or hosting dashboard (only needed when your host requires a specific port).',
  },
  {
    name: 'ADMIN_TOKEN',
    purpose: 'Password protecting every /admin* page (passed as ?token=… in the URL).',
    setup: 'Set ADMIN_TOKEN to a long random string, e.g. run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))". Keep it private — anyone with it can open admin.',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    purpose: 'Verifies that payment notifications really come from Stripe.',
    setup: 'In the Stripe dashboard go to Developers → Webhooks, add an endpoint pointing at https://YOUR-SITE/webhook/stripe, then copy the "Signing secret" (starts with whsec_).',
  },
  {
    name: 'EMAIL_PROVIDER',
    purpose: 'Which service sends the funnel emails (resend for real delivery, console/local for testing).',
    setup: 'Set EMAIL_PROVIDER=resend for production.',
  },
  {
    name: 'RESEND_API_KEY',
    purpose: 'API key letting the server send email through Resend.',
    setup: 'Create an account at resend.com, go to API Keys, create a key, and set RESEND_API_KEY to it. Also verify your sending domain in Resend.',
  },
  {
    name: 'TURSO_DATABASE_URL',
    purpose: 'URL of the hosted Turso database used in production (unset = local SQLite file instead).',
    setup: 'Create a database at turso.tech, copy its URL (libsql://…) and set TURSO_DATABASE_URL — must be set together with TURSO_AUTH_TOKEN.',
  },
  {
    name: 'TURSO_AUTH_TOKEN',
    purpose: 'Auth token for the hosted Turso database (unset = local SQLite file instead).',
    setup: 'In the Turso dashboard create an auth token for your database and set TURSO_AUTH_TOKEN.',
  },
  {
    name: 'APP_URL',
    purpose: 'The public site URL (used to build links in emails and checkout pages).',
    setup: 'Set APP_URL to your public site URL, e.g. APP_URL=https://funnel-qdx9.onrender.com (no trailing slash).',
  },
];

function configEnvHtml(envStatus) {
  const st = envStatus || {};
  const rows = ENV_DOCS.map((doc) => {
    const raw = st[doc.name];
    const isSet = typeof raw === 'object' && raw !== null ? !!raw.set : !!raw;
    const hint = typeof raw === 'object' && raw !== null && raw.hint ? String(raw.hint) : '';
    const valueCell = isSet ? (hint ? esc(hint) + '…' : 'set (hidden)') : '<span class="muted">—</span>';
    const setupCell = isSet ? '' : esc(doc.setup);
    return [
      doc.name,
      doc.purpose,
      isSet ? 'yes' : 'no',
      valueCell,
      setupCell,
    ];
  });
  const body =
    `<table class="admin-table">` +
    `<thead><tr><th>Variable</th><th>What it’s for</th><th>Set?</th><th>Value</th><th>Setup</th></tr></thead>` +
    `<tbody>` +
    rows
      .map(
        (r) =>
          `<tr><td><code>${esc(r[0])}</code></td><td>${esc(r[1])}</td><td>${esc(r[2])}</td>` +
          `<td>${r[3]}</td><td>${r[4]}</td></tr>`
      )
      .join('') +
    `</tbody></table>`;
  return `<p class="microcopy">Secret values are never shown in full here — only "set (hidden)" or a short non-secret hint.</p>` + body;
}

module.exports = {
  adminLayout,
  dashboardHtml,
  leadsTableHtml,
  cartsTableHtml,
  emailsTableHtml,
  outboxHtml,
  suppressionsHtml,
  configEditorHtml,
  dashboardSectionsHtml,
  leadDetailHtml,
  configEnvHtml,
};
```

### `views/layout.js`
```js
// Layout helper. Backend usage: layout({ title, body, site }) -> full HTML5 document.
// `body` is inner page markup produced by views/pages.js. `site` is config/site.json.
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout({ title, body, site }) {
  const siteTitle = esc(site.businessName || 'TransitNow');
  const pageTitle = title ? `${esc(title)} | ${siteTitle}` : siteTitle;
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta name="description" content="${esc(site.tagline || '')}">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="site-header">
  <div class="container">
    <div class="brand">${siteTitle}</div>
    <div class="tagline">${esc(site.tagline || '')}</div>
  </div>
</header>
<main class="container">
${body}
</main>
<footer class="site-footer">
  <div class="container">
    <p class="footer-note">${esc(site.footerNote || '')}</p>
    <p class="footer-contact">${esc(site.businessName || '')} &middot; ${esc(site.phone || '')} &middot; ${esc(site.email || '')}</p>
    <p class="footer-links"><a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/refund">Refund &amp; Cancellation</a> &middot; <a href="/contact">Contact</a> &middot; <a href="/unsubscribe">Unsubscribe</a></p>
    <p class="footer-copy">&copy; ${year} ${siteTitle}. All rights reserved.</p>
  </div>
</footer>
</body>
</html>`;
}

module.exports = { layout, esc };
```

### `views/pages.js`
```js
// Page body templates. Each export returns inner <main> markup; the backend
// applies views/layout.js around it. No backend logic here.
'use strict';

const { esc } = require('./layout');

function hiddenSource(query) {
  const q = query || {};
  const src = esc(q.src || q.source || '');
  const cmp = esc(q.cmp || q.campaign || '');
  return `<input type="hidden" name="source" value="${src}">\n<input type="hidden" name="campaign" value="${cmp}">`;
}

function bullets(items) {
  if (!items || !items.length) return '';
  return '<ul class="bullets">\n' + items.map(b => `  <li>${esc(b)}</li>`).join('\n') + '\n</ul>';
}

function cta(href, text, extraClass) {
  return `<a class="btn ${extraClass || ''}" href="${esc(href)}">${esc(text)}</a>`;
}

// --- Landing ---
function landingPage(site, product) {
  const copy = product.salesCopy || {};
  return `
<section class="hero">
  <h1>${esc(copy.headline || '')}</h1>
  <p class="subhead">${esc(copy.subhead || '')}</p>
  ${bullets(copy.bullets)}
  ${cta('/lead', 'Get the Free Checklist', 'btn-large')}
  <p class="microcopy">Free. No card required. Unsubscribe anytime.</p>
</section>
<footer class="page-footer"><p>${esc(site.footerNote || '')}</p></footer>`;
}

// --- Lead capture ---
function leadPage(site, product, query) {
  const lm = product.leadMagnet || {};
  return `
<section>
  <h1>Get Your Free: ${esc(lm.title || '')}</h1>
  <p class="subhead">${esc(lm.description || '')}</p>
  <form method="POST" action="/lead" class="form">
    ${hiddenSource(query)}
    <label for="first_name">First name
      <input type="text" id="first_name" name="first_name" required autocomplete="given-name" placeholder="Your first name">
    </label>
    <label for="email">Email
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
    </label>
    <label for="phone">Phone <span class="optional">(optional)</span>
      <input type="tel" id="phone" name="phone" autocomplete="tel" placeholder="(optional)">
      <span class="hint">Optional — only used to contact you about this offer.</span>
    </label>
    <label class="checkbox">
      <input type="checkbox" name="consent" value="yes">
      <span>Yes, send me helpful emails about courier/dispatch opportunities. You can unsubscribe anytime.</span>
    </label>
    <button type="submit" class="btn btn-large">Send My Free Checklist</button>
  </form>
  <p class="microcopy"><a href="/privacy">How we use your information</a></p>
</section>`;
}

// --- Free value / lead magnet delivery ---
function freeValuePage(site, product, lead) {
  const lm = product.leadMagnet || {};
  const name = lead && lead.first_name ? esc(lead.first_name) : 'there';
  return `
<section>
  <h1>Thanks, ${name} — here's your checklist.</h1>
  <div class="deliverable card">
    ${lm.deliverableHtml || ''}
  </div>
  <div class="next-step">
    <h2>Want help putting this into action?</h2>
    <p>TransitNow dispatch support helps independent couriers stay organized: lane research, load-search prep, broker verification guidance, scheduling coordination, paperwork, and route planning.</p>
    ${cta('/sales', 'See How Dispatch Support Works', 'btn-large')}
  </div>
</section>`;
}

// --- Sales page ---
function salesPage(site, product) {
  const copy = product.salesCopy || {};
  return `
<section>
  <h1>${esc(copy.headline || '')}</h1>
  <p class="subhead">${esc(copy.subhead || '')}</p>
  <h2>What you get with ${esc(product.name)}</h2>
  ${bullets(copy.bullets)}
  <div class="price-box card">
    <p class="price">${esc(product.priceDisplay || '')}</p>
    <p class="billing">Monthly subscription. Cancel anytime by contacting us.</p>
    <p class="honest-note">No guaranteed loads, jobs, revenue, or broker approval — dispatch support for your independent business.</p>
    ${cta('/checkout', copy.cta || 'Continue', 'btn-large')}
  </div>
  <p class="testimonial-slot">TESTIMONIAL_SLOT (add real customer quotes here)</p>
  <p class="contact-line">Questions? Call ${esc(site.phone || '')} or email ${esc(site.email || '')}.</p>
</section>`;
}

// --- Checkout ---
function checkoutPage(site, product, lead, mode) {
  const isStripe = mode === 'stripe';
  const buttonText = isStripe
    ? 'Continue to Secure Checkout'
    : `Complete Demo Purchase (${esc(product.priceDisplay || '')} demo — no charge)`;
  const prefillName = lead && lead.first_name ? ` value="${esc(lead.first_name)}"` : '';
  const prefillEmail = lead && lead.email ? ` value="${esc(lead.email)}"` : '';
  const prefillPhone = lead && lead.phone ? ` value="${esc(lead.phone)}"` : '';
  return `
<section>
  <h1>Checkout — ${esc(product.name)}</h1>
  <p class="price-line">${esc(product.priceDisplay || '')} <span class="billing">/ month, recurring subscription</span></p>
  <form method="POST" action="/checkout" class="form">
    <label for="first_name">First name
      <input type="text" id="first_name" name="first_name" required${prefillName} autocomplete="given-name">
    </label>
    <label for="email">Email
      <input type="email" id="email" name="email" required${prefillEmail} autocomplete="email">
    </label>
    <label for="phone">Phone <span class="optional">(optional)</span>
      <input type="tel" id="phone" name="phone"${prefillPhone} autocomplete="tel">
      <span class="hint">Optional — only used to contact you about this offer.</span>
    </label>
    <button type="submit" class="btn btn-large">${buttonText}</button>
  </form>
  ${isStripe
    ? '<p class="microcopy">You will be redirected to Stripe to complete payment securely.</p>'
    : '<p class="microcopy">Demo mode: no real charge is made and no payment is collected.</p>'}
  <p class="microcopy"><a href="/privacy">How we use your information</a></p>
</section>`;
}

// --- Order bump (only rendered when product.orderBump.enabled) ---
function orderBumpPage(site, product) {
  const bump = product.orderBump || {};
  if (!bump.enabled) return '';
  return `
<section>
  <h1>Add this to your order?</h1>
  <div class="card">
    <h2>${esc(bump.name)}</h2>
    <p class="price-line">${esc(bump.priceDisplay || '')}</p>
    <p>${esc(bump.description || '')}</p>
  </div>
  <form method="POST" action="/order-bump" class="form inline-forms">
    <button type="submit" name="accept" value="yes" class="btn btn-large">Yes, add it — ${esc(bump.priceDisplay || '')}</button>
    <button type="submit" name="accept" value="no" class="btn btn-secondary">No thanks, continue</button>
  </form>
</section>`;
}

// --- Upsell (only rendered when enabled) ---
function upsellPage(site, product, upsell, which) {
  const up = upsell || {};
  if (!up.enabled) return '';
  const action = `/upsell/${esc(which || '')}`;
  return `
<section>
  <h1>One more thing before you're done</h1>
  <div class="card">
    <h2>${esc(up.name)}</h2>
    <p class="price-line">${esc(up.priceDisplay || '')}</p>
    <p><strong>What it is:</strong> ${esc(up.description || '')}</p>
    <p><strong>Why it complements your purchase:</strong> it pairs with ${esc(product.name)} to round out the support you get for your independent courier business.</p>
  </div>
  <form method="POST" action="${action}" class="form">
    <button type="submit" name="accept" value="yes" class="btn btn-large">Yes, add it — ${esc(up.priceDisplay || '')}</button>
  </form>
  <form method="POST" action="${action}" class="form">
    <button type="submit" name="accept" value="no" class="btn btn-secondary">No thanks, continue</button>
  </form>
</section>`;
}

// --- Thank you / customer access ---
function thankYouPage(site, product, lead) {
  const name = lead && lead.first_name ? esc(lead.first_name) : 'there';
  return `
<section>
  <h1>You're in, ${name}.</h1>
  <p class="subhead">Your <strong>${esc(product.name)}</strong> subscription (${esc(product.priceDisplay || '')}/month) is active.</p>
  <div class="card">
    <h2>What happens next</h2>
    <ol>
      <li><strong>Operator onboarding.</strong> We'll reach out to collect and review your business and vehicle information.</li>
      <li><strong>Dispatch setup.</strong> Lane preferences, communication setup, scheduling, and paperwork organization.</li>
      <li><strong>Ongoing support.</strong> Month-to-month dispatch support from there.</li>
    </ol>
  </div>
  <p>Questions anytime: call <strong>${esc(site.phone || '')}</strong> or email <strong>${esc(site.email || '')}</strong>.</p>
  <p class="microcopy">Manage your email preferences anytime from the link in any email we send.</p>
</section>`;
}

// --- Unsubscribe ---
function unsubscribePage(site, email) {
  const prefill = email ? ` value="${esc(email)}"` : '';
  return `
<section>
  <h1>Unsubscribe</h1>
  <p>Sorry to see you go. Enter your email to stop receiving marketing emails from ${esc(site.businessName || '')}.</p>
  <form method="POST" action="/unsubscribe" class="form">
    <label for="email">Email
      <input type="email" id="email" name="email" required${prefill} autocomplete="email">
    </label>
    <button type="submit" class="btn btn-large">Unsubscribe Me</button>
  </form>
</section>`;
}

// --- Preferences ---
function preferencesPage(site, lead) {
  const email = lead && lead.email ? esc(lead.email) : '';
  return `
<section>
  <h1>Email Preferences</h1>
  <p>Manage what we send to <strong>${email}</strong>.</p>
  <form method="POST" action="/preferences" class="form">
    <label class="checkbox">
      <input type="checkbox" name="nurture" value="yes">
      <span>Helpful tips and dispatch opportunity updates</span>
    </label>
    <label class="checkbox">
      <input type="checkbox" name="weekly_flyer" value="yes">
      <span>Weekly flyer</span>
    </label>
    <button type="submit" class="btn btn-large">Save Preferences</button>
  </form>
  <p><a href="/unsubscribe">Unsubscribe from everything</a></p>
</section>`;
}

// --- Privacy ---
function privacyPage(site) {
  return `
<section>
  <h1>Privacy Notice</h1>
  ${site.privacyNoteHtml || ''}
</section>`;
}

// --- Wealth Builder's Room: join landing page ---
function roomJoinPage(site) {
  const modules = [
    ['00 — START HERE', 'Get oriented, learn how the Room works, and set up your starting point.'],
    ['01 — WEALTH MINDSET, HABITS & DECISIONS', 'Build the thinking patterns and daily habits that support better money decisions.'],
    ['02 — MONEY MANAGEMENT & CASH FLOW', 'Learn to track, plan, and direct your cash flow so your money has a job.'],
    ['03 — ASSETS, INVESTING & OWNERSHIP', 'Understand assets, investing basics, and what it means to own something that can grow.'],
    ['04 — THE 90-DAY WEALTH ACTION PLAN', 'Turn everything you have learned into one organized, step-by-step 90-day execution plan.'],
  ];
  return `
<section class="hero">
  <h1>Your Ideas Can Become Income. Your Income Can Become Wealth.</h1>
  <p class="subhead">The Wealth Builder's Room helps you turn your ideas, skills, opportunities, and resources into an organized 90-day plan for building income, business, ownership, and long-term wealth.</p>
  ${cta('/room/start', 'JOIN THE WEALTH BUILDER\'S ROOM — $49/MONTH', 'btn-large')}
  ${cta('/room/offer', 'SEE WHAT\'S INSIDE', 'btn-secondary btn-large')}
</section>
<section>
  <h2>This Room Is For You If...</h2>
  ${bullets([
    'You have ideas but need a clear plan.',
    'You want to turn your skills into income.',
    'You are trying to build a business but feel scattered.',
    'You want to understand money, cash flow, assets, and ownership.',
    'You need accountability instead of another pile of information.',
    'You want to stop starting over and start executing.',
    'You want to build something that can grow beyond one paycheck.',
  ])}
</section>
<section>
  <h2>What You'll Build</h2>
  <div class="module-list">
${modules.map(([t, d]) => `    <div class="module card">\n      <p class="module-title">${esc(t)}</p>\n      <p class="module-desc">${esc(d)}</p>\n    </div>`).join('\n')}
  </div>
</section>
<section>
  <h2>What Your $49/Month Includes</h2>
  ${bullets([
    'Access to Wealth Builder\'s Room',
    'Wealth-building education',
    'Action plans',
    'Community/accountability',
    'Business and income-building discussions',
    'Money management and cash-flow education',
    'Asset and ownership education',
    '90-day execution planning',
    'New resources/posts as they are added',
    'A place to organize your next wealth-building moves',
  ])}
</section>
<section>
  <h2>This Is Not About Getting Rich Quick.</h2>
  <p>This is about learning how to make better decisions with the ideas, skills, money, opportunities, and resources you already have — then putting those decisions into action.</p>
</section>
<section>
  ${cta('/room/start', 'START BUILDING — $49/MONTH', 'btn-large')}
</section>
<footer class="page-footer"><p>${esc(site.footerNote || '')}</p></footer>`;
}

// --- Wealth Builder's Room: lead capture ---
function roomStartPage(site, query, error) {
  const options = [
    ['extra-income', 'Extra income'],
    ['a-business', 'A business'],
    ['money-management', 'Better money management'],
    ['credit-improvement', 'Credit improvement'],
    ['investing-ownership', 'Investing/ownership'],
    ['multiple-income-streams', 'Multiple income streams'],
    ['idea-needs-plan', 'I have an idea but need a plan'],
    ['not-sure', "I'm not sure yet"],
  ];
  return `
<section>
  <h1>Get Started With the Wealth Builder's Room</h1>
  <p class="subhead">Tell us where to reach you and what you're working toward. We'll follow up with your next step.</p>
  ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
  <form method="POST" action="/room/start" class="form">
    ${hiddenSource(query)}
    <label for="room_first_name">First Name
      <input type="text" id="room_first_name" name="first_name" required autocomplete="given-name" placeholder="Your first name">
    </label>
    <label for="room_email">Email Address
      <input type="email" id="room_email" name="email" required autocomplete="email" placeholder="you@example.com">
    </label>
    <label for="room_phone">Phone Number <span class="optional">(optional)</span>
      <input type="tel" id="room_phone" name="phone" autocomplete="tel" placeholder="(optional)">
    </label>
    <label for="room_goal">What are you trying to build right now?
      <select id="room_goal" name="goal">
        ${options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('\n        ')}
      </select>
    </label>
    <label class="checkbox">
      <input type="checkbox" name="consent" value="yes">
      <span>Yes, send me Wealth Builder's Room information and helpful wealth-building resources. You can unsubscribe anytime.</span>
    </label>
    <button type="submit" class="btn btn-large">CONTINUE &rarr;</button>
  </form>
  <p class="microcopy"><a href="/privacy">How we use your information</a></p>
</section>`;
}

// --- Wealth Builder's Room: offer / sales page ---
function roomOfferPage(site) {
  const modules = [
    '00 Start Here',
    '01 Wealth Mindset, Habits & Decisions',
    '02 Money Management & Cash Flow',
    '03 Assets, Investing & Ownership',
    '04 The 90-Day Wealth Action Plan',
  ];
  return `
<section>
  <h1>Stop Collecting Ideas. Start Building.</h1>
  <p class="subhead">You don't need another hundred ideas. You need a system for deciding what to do, taking action, measuring what happens, and building from there.</p>
  <h2>What's Inside</h2>
  ${bullets(modules)}
  <p>The goal is not to overwhelm you with information. The goal is to help you move.</p>
  <div class="price-box card">
    <p class="price">$49<span class="billing">/month</span></p>
    <p class="billing">Recurring membership. Cancel according to the subscription terms presented at checkout.</p>
    <p class="honest-note">Education and planning support — not financial advice, and no guaranteed income or results.</p>
    ${cta('/room/checkout', 'JOIN THE ROOM FOR $49/MONTH', 'btn-large')}
  </div>
  <p class="contact-line">Questions? Call ${esc(site.phone || '')} or email ${esc(site.email || '')}.</p>
</section>`;
}

// --- Terms ---
function termsPage(site) {
  return `
<section>
  <h1>Terms of Service</h1>
  <p><strong>${esc(site.businessName || '')}</strong> provides the Wealth Builder's Room as an educational membership program.</p>
  <h2>Membership</h2>
  <p>Membership is a recurring monthly subscription billed at the rate shown at checkout (currently $49/month). Membership renews each month until you cancel. See our <a href="/refund">Refund &amp; Cancellation Policy</a> for how to cancel.</p>
  <h2>What this is</h2>
  <p>The Wealth Builder's Room provides wealth-building education, action plans, community discussion, and planning resources. Content is for general educational purposes only. It is not financial, investment, legal, or tax advice, and we do not promise or guarantee income, earnings, or any specific result.</p>
  <h2>Your responsibility</h2>
  <p>How you use the information, and the decisions you make with it, are your responsibility. You agree to use the membership in a lawful manner and to treat other members respectfully.</p>
  <h2>Changes</h2>
  <p>We may update these terms from time to time. Continued use of the membership after changes are posted means you accept them.</p>
  <p>Questions: call <strong>${esc(site.phone || '')}</strong> or email <strong>${esc(site.email || '')}</strong>.</p>
</section>`;
}

// --- Refund & cancellation ---
function refundPage(site) {
  return `
<section>
  <h1>Refund &amp; Cancellation Policy</h1>
  <h2>Wealth Builder's Room — $49/month recurring membership</h2>
  <p>You can cancel your membership according to the subscription terms presented at checkout. After cancellation, you will not be billed for future months, and your access continues until the end of the current billing period.</p>
  <p>Monthly membership charges are generally non-refundable once billed, because access begins immediately. If you believe a charge was made in error, contact us and we will review it.</p>
  <h2>Need help canceling?</h2>
  <p>Call <strong>${esc(site.phone || '')}</strong> or email <strong>${esc(site.email || '')}</strong> and we will help you cancel your membership.</p>
</section>`;
}

// --- Contact ---
function contactPage(site) {
  return `
<section>
  <h1>Contact Us</h1>
  <p>Questions about the Wealth Builder's Room, your membership, or billing? Reach out — we're happy to help.</p>
  <div class="card">
    <p><strong>Email:</strong> <a href="mailto:${esc(site.email || '')}">${esc(site.email || '')}</a></p>
    <p><strong>Phone:</strong> <a href="tel:${esc((site.phone || '').replace(/[^0-9+]/g, ''))}">${esc(site.phone || '')}</a></p>
    <p><strong>Business:</strong> ${esc(site.businessName || '')}</p>
  </div>
  <p class="microcopy">We respond during business hours. For membership cancellation help, see our <a href="/refund">Refund &amp; Cancellation Policy</a>.</p>
</section>`;
}

module.exports = {
  landingPage,
  leadPage,
  freeValuePage,
  salesPage,
  checkoutPage,
  orderBumpPage,
  upsellPage,
  thankYouPage,
  unsubscribePage,
  preferencesPage,
  privacyPage,
  roomJoinPage,
  roomStartPage,
  roomOfferPage,
  termsPage,
  refundPage,
  contactPage,
};
```

### `views/room.js`
```js
'use strict';
/**
 * views/room.js — HTML for The Wealth Builder's Room membership area.
 * The Room has its own branding (separate from the TransitNow funnel pages).
 * All user content is escaped. No income promises anywhere.
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function displayName(memberOrPost) {
  if (!memberOrPost) return 'Member';
  if (memberOrPost.kind === 'announcement') return 'Davena';
  return memberOrPost.name || memberOrPost.author_name || String(memberOrPost.email || memberOrPost.author_email || 'Member').split('@')[0];
}

function roomLayout({ title, member, body }) {
  const nav = member
    ? `<nav class="room-nav">
        <a href="/room">Dashboard</a>
        <a href="/room/classroom">Classroom</a>
        <a href="/room/plan">90-Day Plan</a>
        <a href="/room/community">Community</a>
        <a href="/room/logout" class="logout">Log out</a>
      </nav>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | The Wealth Builder's Room</title>
<style>
:root{--ink:#1c2430;--gold:#b8860b;--gold-soft:#f7ecd2;--bg:#faf8f3;--card:#ffffff;--muted:#6b7280;--line:#e7e0d2}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.6}
.room-header{background:#1c2430;color:#fff;padding:18px 20px}
.room-header .brand{font-size:20px;font-weight:800;letter-spacing:.02em}
.room-header .brand span{color:var(--gold)}
.room-header .who{font-size:13px;color:#cbd5e1;margin-top:4px}
.room-nav{background:#2b3648;padding:10px 20px;display:flex;gap:18px;flex-wrap:wrap}
.room-nav a{color:#f3e9cf;text-decoration:none;font-weight:600;font-size:15px}
.room-nav a:hover{color:#fff}
.room-nav .logout{margin-left:auto;color:#f3b4b4}
.container{max-width:860px;margin:0 auto;padding:24px 20px 64px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.04)}
h1{font-size:28px;margin:.2em 0 .4em}
h2{font-size:22px;margin:1.2em 0 .4em}
h3{font-size:17px;margin:1em 0 .3em}
p{margin:.6em 0}
.muted{color:var(--muted);font-size:14px}
.btn{display:inline-block;background:#1c2430;color:#fff;border:none;border-radius:8px;padding:12px 22px;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer}
.btn-gold{background:var(--gold);color:#1c2430}
.btn-small{padding:8px 14px;font-size:14px}
.btn-danger{background:#b91c1c}
.form label{display:block;font-weight:600;margin:12px 0 4px}
.form input[type=text],.form input[type=email],.form input[type=password],.form textarea{width:100%;min-height:48px;padding:10px 12px;border:1px solid #b9b2a2;border-radius:8px;font-size:16px;font-family:inherit}
.form textarea{min-height:120px;resize:vertical}
.error{background:#fef2f2;border:1px solid #f5b4b4;color:#991b1b;border-radius:8px;padding:12px;margin:12px 0}
.notice{background:#f0fdf4;border:1px solid #a7d8b5;color:#166534;border-radius:8px;padding:12px;margin:12px 0}
.pillar-grid{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:640px){.pillar-grid{grid-template-columns:1fr 1fr}}
.pillar-card{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;text-decoration:none;color:inherit}
.pillar-card:hover{border-color:var(--gold)}
.pillar-card h3{margin:.1em 0;color:#1c2430}
.pillar-num{font-size:12px;font-weight:800;color:var(--gold);text-transform:uppercase;letter-spacing:.08em}
.lesson-body h2{color:#1c2430;border-bottom:2px solid var(--gold-soft);padding-bottom:6px}
.lesson-body blockquote{border-left:4px solid var(--gold);margin:16px 0;padding:8px 16px;background:var(--gold-soft);border-radius:0 8px 8px 0;font-style:italic}
.lesson-body ul,.lesson-body ol{padding-left:24px}
.progress-wrap{background:#e9e2d2;border-radius:8px;height:22px;overflow:hidden;margin:12px 0}
.progress-fill{background:var(--gold);height:100%;transition:width .3s}
.week{border:1px solid var(--line);border-radius:10px;margin:12px 0;overflow:hidden}
.week-head{background:#1c2430;color:#fff;padding:10px 16px;font-weight:700}
.week-head .focus{font-weight:400;font-size:13px;color:#d8c98f;margin-left:8px}
.week-body{padding:6px 16px 12px}
.check-item{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px dashed var(--line)}
.check-item:last-child{border-bottom:none}
.check-item input{width:22px;height:22px;margin-top:2px;flex:none}
.check-item.done label{text-decoration:line-through;color:var(--muted)}
.post{border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0;background:var(--card)}
.post.announcement{border:2px solid var(--gold);background:#fffdf5}
.post .meta{font-size:13px;color:var(--muted);margin-bottom:6px}
.post .title{font-size:18px;font-weight:700;margin:0 0 6px}
.post .title a{color:inherit;text-decoration:none}
.badge{display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;background:var(--gold);color:#1c2430;border-radius:4px;padding:2px 8px;margin-right:8px}
.badge.pin{background:#1c2430;color:#f3e9cf}
.comment{border-top:1px solid var(--line);padding:12px 0}
.comment .meta{font-size:12px;color:var(--muted)}
.admin-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
.admin-table th,.admin-table td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top}
.admin-table th{background:#1c2430;color:#fff}
.inline-form{display:inline}
.inline-form button{margin:2px}
.room-footer{text-align:center;color:var(--muted);font-size:13px;padding:32px 20px}
.disclaimer{font-size:13px;color:var(--muted);border-top:1px solid var(--line);margin-top:32px;padding-top:16px;font-style:italic}
</style>
</head>
<body>
<header class="room-header">
  <div class="brand">The Wealth Builder's <span>Room</span></div>
  ${member ? `<div class="who">Welcome back, ${esc(displayName(member))}</div>` : `<div class="who">Turn ideas, skills &amp; opportunities into income, businesses &amp; wealth.</div>`}
</header>
${nav}
<main class="container">
${body}
<p class="disclaimer">The Wealth Builder's Room is an educational community. Nothing here is financial, legal, tax, or investment advice, and no income, earnings, or specific results are promised or guaranteed. Your results depend on your own effort, decisions, and circumstances.</p>
</main>
<footer class="room-footer">The Wealth Builder's Room &middot; $49/month membership</footer>
</body>
</html>`;
}

// --- Auth pages ------------------------------------------------------------------
function loginPage({ error, email }) {
  return roomLayout({
    title: 'Member Login',
    member: null,
    body: `<h1>Member Login</h1>
${error ? `<div class="error">${esc(error)}</div>` : ''}
<div class="card">
<form method="POST" action="/room/login" class="form">
  <label for="email">Email (the one you paid with)</label>
  <input type="email" id="email" name="email" required value="${esc(email || '')}" autocomplete="email">
  <label for="password">Password</label>
  <input type="password" id="password" name="password" required autocomplete="current-password">
  <p><button type="submit" class="btn">Log In</button></p>
</form>
</div>
<p class="muted">Paid but haven't set your password yet? <a href="/room/claim">Claim your access</a>.</p>`,
  });
}

function claimPage({ error, email, notice }) {
  return roomLayout({
    title: 'Claim Your Access',
    member: null,
    body: `<h1>Claim Your Access</h1>
<p>Paid your $49/month membership with Stripe? Enter the email you paid with and choose a password to unlock the Room.</p>
${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
${error ? `<div class="error">${esc(error)}</div>` : ''}
<div class="card">
<form method="POST" action="/room/claim" class="form">
  <label for="email">Email you paid with</label>
  <input type="email" id="email" name="email" required value="${esc(email || '')}" autocomplete="email">
  <label for="password">Choose a password (8+ characters)</label>
  <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
  <label for="password2">Confirm password</label>
  <input type="password" id="password2" name="password2" required minlength="8" autocomplete="new-password">
  <p><button type="submit" class="btn btn-gold">Claim My Access</button></p>
</form>
</div>
<p class="muted">Already claimed? <a href="/room/login">Log in</a>.</p>`,
  });
}

// --- Dashboard ----------------------------------------------------------------------
function dashboardPage({ member, progress, announcements }) {
  const pct = progress.pct;
  const ann = (announcements || [])
    .map(
      (a) => `<div class="post announcement"><div class="meta"><span class="badge">Announcement</span>${esc(fmtDateTime(a.created_at))}</div>
      ${a.title ? `<div class="title">${esc(a.title)}</div>` : ''}<div>${esc(a.body).replace(/\n/g, '<br>')}</div></div>`
    )
    .join('');
  return roomLayout({
    title: 'Dashboard',
    member,
    body: `<h1>Your Wealth-Building Headquarters</h1>
<div class="card">
  <h2 style="margin-top:0">90-Day Wealth Action Plan</h2>
  <p class="muted">${progress.done} of ${progress.total} actions complete</p>
  <div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>
  <p><a class="btn btn-gold" href="/room/plan">Continue the Plan</a></p>
</div>
<div class="pillar-grid">
  <a class="pillar-card" href="/room/classroom"><span class="pillar-num">Learn</span><h3>The Classroom</h3><p class="muted">5 wealth-building sections, step-by-step lessons.</p></a>
  <a class="pillar-card" href="/room/community"><span class="pillar-num">Connect</span><h3>Community</h3><p class="muted">Ask questions, share wins, learn together.</p></a>
</div>
${ann ? `<h2>Announcements</h2>${ann}` : ''}`,
  });
}

// --- Classroom -------------------------------------------------------------------------
function classroomIndexPage({ member, pillars }) {
  const cards = pillars
    .map(
      (p, i) => `<a class="pillar-card" href="/room/classroom/${esc(p.id)}">
        <span class="pillar-num">Section ${i + 1}</span><h3>${esc(p.title)}</h3><p class="muted">${esc(p.tagline)}</p></a>`
    )
    .join('');
  return roomLayout({
    title: 'Classroom',
    member,
    body: `<h1>The Classroom</h1>
<p>Five sections, in order. Start with Section 1 and work your way through — each one builds on the last.</p>
<div class="pillar-grid">${cards}</div>`,
  });
}

function pillarPage({ member, pillar, index, prev, next }) {
  return roomLayout({
    title: pillar.title,
    member,
    body: `<p><a href="/room/classroom">&larr; All sections</a></p>
<p class="pillar-num">Section ${index + 1} of 5</p>
<div class="card lesson-body">${pillar.html}</div>
<p>${prev ? `<a class="btn btn-small" href="/room/classroom/${esc(prev.id)}">&larr; ${esc(prev.title)}</a>` : ''}
${next ? ` <a class="btn btn-small btn-gold" href="/room/classroom/${esc(next.id)}">${esc(next.title)} &rarr;</a>` : ''}</p>`,
  });
}

// --- Welcome (first-run onboarding; POSTs to /room/welcome) ---------------------
function welcomePage({ member }) {
  return roomLayout({
    title: 'Welcome',
    member,
    body: `<div class="notice" style="text-align:center;font-size:18px;font-weight:700;padding:20px">
  You're in. Welcome to the Wealth Builder's Room.</div>
<div class="card">
  <h1 style="margin-top:0">Here's what to do first</h1>
  <ol style="padding-left:24px">
    <li><strong>Start with 00 — Start Here.</strong> Five minutes on how the Room works — and what it's not.</li>
    <li><strong>Introduce yourself in the community.</strong> Who you are, where you're starting, and what you want the next 90 days to change.</li>
    <li><strong>Pick ONE 90-day goal.</strong> One outcome. Write it where you'll see it every day.</li>
    <li><strong>Check the 90-Day Plan.</strong> Twelve weeks of small actions — check off the first one today.</li>
  </ol>
  <p class="muted">Education, community, and accountability — no hype, and no promises of income or earnings. One checked-off action at a time.</p>
  <form method="POST" action="/room/welcome" class="form" style="text-align:center;margin-top:12px">
    <button type="submit" class="btn btn-gold" style="font-size:18px;padding:16px 34px">ENTER THE ROOM &rarr;</button>
  </form>
</div>`,
  });
}

// --- 90-day plan --------------------------------------------------------------------------
function planPage({ member, plan, progress }) {
  const total = plan.weeks.reduce((n, w) => n + w.actions.length, 0);
  const done = Object.values(progress).filter(Boolean).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const weeks = plan.weeks
    .map(
      (w, wi) => `<div class="week">
      <div class="week-head">Week ${wi + 1}: ${esc(w.title)}<span class="focus">${esc(w.focus)}</span></div>
      <div class="week-body">
        ${w.actions
          .map((a, ai) => {
            const checked = progress[`${wi + 1}:${ai}`];
            return `<form method="POST" action="/room/plan/toggle" class="check-item${checked ? ' done' : ''}">
              <input type="checkbox" name="checked" value="1"${checked ? ' checked' : ''} onchange="this.form.submit()" aria-label="${esc(a)}">
              <input type="hidden" name="week" value="${wi + 1}">
              <input type="hidden" name="item" value="${ai}">
              <label>${esc(a)}</label>
            </form>`;
          })
          .join('')}
      </div>
    </div>`
    )
    .join('');
  return roomLayout({
    title: '90-Day Wealth Action Plan',
    member,
    body: `<h1>Your 90-Day Wealth Action Plan</h1>
<p>Check off each action as you complete it. Your progress saves automatically.</p>
<div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>
<p class="muted">${done} of ${total} actions complete (${pct}%)</p>
${weeks}
<p class="muted">Tip: unchecking a box removes it from your progress.</p>`,
  });
}

// --- Community -----------------------------------------------------------------------------
function communityPage({ member, posts, error, notice }) {
  const items = posts
    .map(
      (p) => `<div class="post${p.kind === 'announcement' ? ' announcement' : ''}">
      <div class="meta">${p.pinned ? '<span class="badge pin">Pinned</span>' : ''}${
        p.kind === 'announcement' ? '<span class="badge">Announcement</span>' : ''
      }${esc(displayName(p))} &middot; ${esc(fmtDateTime(p.created_at))} &middot; ${Number(p.comment_count) || 0} ${
        Number(p.comment_count) === 1 ? 'reply' : 'replies'
      }</div>
      ${p.title ? `<div class="title"><a href="/room/community/post/${p.id}">${esc(p.title)}</a></div>` : ''}
      <div>${esc(p.body).slice(0, 400).replace(/\n/g, '<br>')}${p.body.length > 400 ? '…' : ''}</div>
      <p><a href="/room/community/post/${p.id}">Read &amp; reply &rarr;</a></p>
    </div>`
    )
    .join('');
  return roomLayout({
    title: 'Community',
    member,
    body: `<h1>Community</h1>
<p>Ask questions, share wins, and learn from each other. Be kind, be honest, no spam.</p>
${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
${error ? `<div class="error">${esc(error)}</div>` : ''}
<div class="card">
  <h2 style="margin-top:0">Start a discussion</h2>
  <form method="POST" action="/room/community/post" class="form">
    <label for="title">Title (optional)</label>
    <input type="text" id="title" name="title" maxlength="140" placeholder="What is this about?">
    <label for="body">Your post</label>
    <textarea id="body" name="body" required maxlength="5000" placeholder="Share a question, a win, or something you learned…"></textarea>
    <p><button type="submit" class="btn">Post</button></p>
  </form>
</div>
<h2>Discussions</h2>
${items || '<p class="muted">No discussions yet — start the first one above.</p>'}`,
  });
}

function postPage({ member, post, comments, error }) {
  const cmts = comments
    .map(
      (c) => `<div class="comment"><div class="meta">${esc(displayName(c))} &middot; ${esc(fmtDateTime(c.created_at))}</div>
      <div>${esc(c.body).replace(/\n/g, '<br>')}</div></div>`
    )
    .join('');
  return roomLayout({
    title: post.title || 'Discussion',
    member,
    body: `<p><a href="/room/community">&larr; Back to community</a></p>
<div class="post${post.kind === 'announcement' ? ' announcement' : ''}">
  <div class="meta">${post.pinned ? '<span class="badge pin">Pinned</span>' : ''}${
    post.kind === 'announcement' ? '<span class="badge">Announcement</span>' : ''
  }${esc(displayName(post))} &middot; ${esc(fmtDateTime(post.created_at))}</div>
  ${post.title ? `<div class="title">${esc(post.title)}</div>` : ''}
  <div>${esc(post.body).replace(/\n/g, '<br>')}</div>
</div>
<h2>Replies (${comments.length})</h2>
${cmts || '<p class="muted">No replies yet.</p>'}
${error ? `<div class="error">${esc(error)}</div>` : ''}
<div class="card">
  <h3 style="margin-top:0">Add a reply</h3>
  <form method="POST" action="/room/community/post/${post.id}/comment" class="form">
    <textarea name="body" required maxlength="2000" placeholder="Write your reply…"></textarea>
    <p><button type="submit" class="btn">Reply</button></p>
  </form>
</div>`,
  });
}

// --- Admin (rendered inside the existing admin layout) --------------------------------
function roomAdminPage({ members, posts }) {
  const mrows = (members || [])
    .map(
      (m) => `<tr>
      <td>${esc(m.email)}</td><td>${esc(m.name || '—')}</td>
      <td>${esc(fmtDate(m.joined_at))}</td><td>${esc(fmtDateTime(m.last_login))}</td>
      <td>${m.password_hash ? 'claimed' : 'not claimed'}</td>
      <td>${esc(m.status)}</td>
      <td><form method="POST" action="/admin/room/member-status" class="inline-form">
        <input type="hidden" name="email" value="${esc(m.email)}">
        <input type="hidden" name="status" value="${m.status === 'active' ? 'inactive' : 'active'}">
        <button type="submit" class="btn-small btn">${m.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
      </form></td>
    </tr>`
    )
    .join('');
  const prows = (posts || [])
    .map(
      (p) => `<tr>
      <td>${p.id}</td>
      <td>${p.kind === 'announcement' ? '<strong>Announcement</strong>' : 'Post'}${p.pinned ? ' · <strong>pinned</strong>' : ''}</td>
      <td>${esc(p.title || '(no title)')}</td>
      <td>${esc(displayName(p))}</td>
      <td>${esc(fmtDateTime(p.created_at))}</td>
      <td>
        <form method="POST" action="/admin/room/pin" class="inline-form">
          <input type="hidden" name="id" value="${p.id}">
          <input type="hidden" name="pinned" value="${p.pinned ? '0' : '1'}">
          <button type="submit" class="btn-small btn">${p.pinned ? 'Unpin' : 'Pin'}</button>
        </form>
        <form method="POST" action="/admin/room/delete-post" class="inline-form" onsubmit="return confirm('Delete this post and all its replies?')">
          <input type="hidden" name="id" value="${p.id}">
          <button type="submit" class="btn-small btn btn-danger">Delete</button>
        </form>
      </td>
    </tr>`
    )
    .join('');
  return `<h2>Members (${(members || []).length})</h2>
<table class="admin-table"><thead><tr>
<th>Email</th><th>Name</th><th>Joined</th><th>Last login</th><th>Access</th><th>Status</th><th>Action</th>
</tr></thead><tbody>${mrows || '<tr><td colspan="7">No members yet.</td></tr>'}</tbody></table>

<h2>Add a member</h2>
<form method="POST" action="/admin/room/add-member" class="form" style="max-width:640px">
  <label for="memail">Email</label>
  <input type="email" id="memail" name="email" required>
  <label for="mname">Name (optional)</label>
  <input type="text" id="mname" name="name" maxlength="120">
  <p><button type="submit" class="btn">Add member</button></p>
</form>
<h2>Post an announcement</h2>
<form method="POST" action="/admin/room/announce" class="form" style="max-width:640px">
  <label for="atitle">Title (optional)</label>
  <input type="text" id="atitle" name="title" maxlength="140">
  <label for="abody">Announcement</label>
  <textarea id="abody" name="body" required maxlength="5000"></textarea>
  <p><button type="submit" class="btn">Post announcement</button></p>
</form>

<h2>Community posts (${(posts || []).length})</h2>
<table class="admin-table"><thead><tr>
<th>ID</th><th>Type</th><th>Title</th><th>Author</th><th>Posted</th><th>Actions</th>
</tr></thead><tbody>${prows || '<tr><td colspan="6">No posts yet.</td></tr>'}</tbody></table>
<p class="muted">Lesson content: edit the Markdown files in <code>content/room/lessons/</code> (one per pillar) and the 90-day plan in <code>content/room/plan.json</code>. Changes go live on the next page load — no restart needed.</p>`;
}

module.exports = {
  esc,
  roomLayout,
  loginPage,
  claimPage,
  dashboardPage,
  classroomIndexPage,
  pillarPage,
  welcomePage,
  planPage,
  communityPage,
  postPage,
  roomAdminPage,
};
```

---

## 2026-09-20 — ACTION + ACCOUNTABILITY upgrade (additive, no rebuild)

Implements Davena's LEARN → ACT → PROVE → REFLECT → REPEAT membership loop on
top of the existing Wealth Builder's Room. Nothing existing was removed or
changed in behavior; all additions are new routes, tables, views, and emails.

New database tables (lib/db.js, auto-created at boot): `room_goals`,
`room_checkins` (UNIQUE(email, week)), `room_reviews`. Proof files stored on
disk under `data/proofs/<sha256(email)>/`, served only to the owning member
via GET /room/proof/:id (ownership-checked, path-contained).

New lib/room.js functions: getGoal, saveGoal (dates fixed on create, never on
edit), weekInfo (currentWeek clamped 1..12), getCheckin, getCheckinById,
listCheckins, saveCheckin (server timestamp on insert only; proof columns only
on new upload), getReview, saveReview, progressStats (streak counts back from
current/previous week, no shaming), accountabilitySummary.

New lib/multipart.js: minimal multipart/form-data parser (node built-ins;
8 MB file cap; PNG/JPG/GIF/WebP/PDF only; filename sanitized).

New member routes (server.js, all requireRoomMember): GET/POST /room/goal,
GET/POST /room/checkin (express.raw multipart on POST only; proof requires
confirm checkbox), GET /room/progress (12-week tracker, "PROGRESS, NOT
PERFECTION."), GET /room/proof/:id, GET/POST /room/review (journey summary).
Dashboard shows goal card + check-in CTA; nav gains "My Progress"; lesson
pages end with "NOW PUT IT INTO ACTION." → /room/checkin.

Community: 12 weekly accountability posts (WEEK 1 … WEEK 12) seeded
idempotently at boot, never pinned.

Emails (lib/automation.js, existing email_queue): queueCheckinReminders()
runs inside runSchedulerPass() — one reminder per active claimed member with
a goal missing the current week's check-in, idempotent per (email, week);
processOneEmail() has a `room-` branch that still cancels for suppressed /
unsubscribed / inactive members. queueCheckinConfirmation() queues
"Progress documented ✓" per check-in id.

Admin /admin/room gains an Accountability section: per-member week, goal,
check-ins n/12, checked-in-this-week, streak, last check-in, proof status,
latest accomplishment/lesson/next commitment, review status, plus
checked-in / not-checked-in lists. No rankings or leaderboard.

Tests: scripts/test-funnel.js section 13 adds 27 assertions (goal lifecycle,
server timestamps, proof upload + confirm guard + privacy, week math,
reminder eligibility/dedupe/inactive/suppressed guards, confirmation email,
admin accountability, 12 seeded posts). Full suite: 143/143 passing.
