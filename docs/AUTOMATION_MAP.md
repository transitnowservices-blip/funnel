# Automation Map — What Happens to One Person, Start to Finish

> Written spec-first from the route/API contract (2026-09-19). Verify against the built
> app if any step behaves differently.

This document walks one anonymous visitor through every stage of the funnel:
**FIRST VISIT → LEAD → BROWSER → CHECKOUT → ABANDONED CART → CUSTOMER → UPSELL → REPEAT CUSTOMER.**

For each stage it lists:
- **Sees** — what the visitor sees in the browser
- **Records** — what the system writes (DB rows, tags, cookies)
- **Emails** — what gets scheduled or sent, and when
- **Stops/Changes** — what halts or shifts when they purchase or unsubscribe

Tag vocabulary used below (all from config):
`NEW_LEAD · VIEWED_OFFER · HIGH_INTENT · STARTED_CHECKOUT · ABANDONED_CART · PURCHASED ·
UPSELL_ACCEPTED · UPSELL_DECLINED · REPEAT_CUSTOMER · WEEKLY_NURTURE · CUSTOMER ·
UNSUBSCRIBED · SUPPRESSED · OFFER_<id>_VIEWED · OFFER_<id>_PURCHASED`

---

## Stage 1 — FIRST VISIT (anonymous)

**Sees:** The landing page at `GET /`. Marketing copy, the TransitNow offer, the tagline
"Stay Ready So You Don't Have To Get Ready.", and a path to the lead form (`/lead`) and the sales page (`/sales`).

**Records:**
- A `vid` (visitor id) cookie is set on first visit. No identity yet — just an anonymous browser id.
- A page-view row is recorded in the first-party analytics tables (SQLite).

**Emails:** None.

**Stops/Changes:** Nothing stops; the visitor is simply trackable as anonymous.

---

## Stage 2 — LEAD (opts in)

**Sees:** `GET /lead` — a form with required `first_name` and `email`, optional `phone`,
a consent checkbox, and hidden `source`/`campaign` fields pre-filled from `?src=` and `?cmp=`
query params.

**Records** (on `POST /lead`, 302 redirect to `/free-value`):
- A **lead row** is saved (name, email, phone, consent, source, campaign, timestamps).
- A `lid` (lead id) cookie is set — the browser is now identified.
- Tags applied: **`NEW_LEAD`**.

**Emails — scheduled immediately:**
- **Welcome email** (nurture **Day 0**) — sent right away via the local provider (HTML file to `data/outbox/`).
- **Nurture sequence**: Day 1, Day 3, Day 5, Day 7, then **weekly nurture** ongoing.
  Each email is a row in the email queue with a `scheduled_for` time; the scheduler sends each when due.

**Stops/Changes:** This is the master IF/THEN set for the whole funnel:

| Event | THEN |
|---|---|
| Lead submits form | Save lead + tag `NEW_LEAD` + send welcome (Day 0) + schedule nurture Day 1/3/5/7 → weekly |
| Lead views an offer page | Tag `VIEWED_OFFER` (+ `OFFER_<id>_VIEWED` for that offer id) |
| Lead starts checkout | Tag `STARTED_CHECKOUT` (and `HIGH_INTENT`) |
| Lead abandons cart (no purchase) | Tag `ABANDONED_CART` + schedule the abandoned-cart sequence |
| Lead purchases | Remove `ABANDONED_CART` tag; **cancel all pending cart emails**; record purchase; send confirmation; present upsell (skipped in seed config — order bump/upsells disabled); add `PURCHASED` + `CUSTOMER` + `OFFER_<id>_PURCHASED`; start post-purchase sequence (6 emails) |
| Upsell accepted | Tag `UPSELL_ACCEPTED`; second purchase recorded |
| Upsell declined | Tag `UPSELL_DECLINED`; no second purchase |
| Never purchases | Continues on weekly nurture (prospect promotions) |
| Purchases later | Removed from prospect promotion (weekly nurture targets prospects, not customers, for the featured offer) |
| Unsubscribes | Tag `UNSUBSCRIBED`; **all pending queued emails cancelled**; one-click via `/unsubscribe` |

---

## Stage 3 — BROWSER (lead looks around)

**Sees:** `GET /free-value` (the lead magnet — free value delivered after opt-in), `GET /sales`
(the sales page for the offer).

**Records:**
- When the lead views the sales page: tag **`VIEWED_OFFER`** and **`OFFER_<id>_VIEWED`**
  (id = the product id in `config/products.json`, e.g. the TransitNow Complete Dispatch offer).

**Emails:** Nurture sequence continues on its schedule (Day 1/3/5/7 → weekly).

**Stops/Changes:** Browsing alone changes nothing about the email schedule; it only adds tags.

---

## Stage 4 — CHECKOUT (starts, but doesn't finish)

**Sees:** `GET /checkout` — a form (`first_name`, `email`, `phone`) for the seed product
"TransitNow Complete Dispatch", $100/month recurring.
- `paymentMode` = **"demo"** (seed): submitting the form creates a cart and lands on a page with a
  button that `POST`s to `/checkout/complete-demo` ("Complete Demo Purchase — no charge").
- `paymentMode` = **"stripe"**: `POST /checkout` creates the cart and 302-redirects to the
  product's Stripe payment link (`https://buy.stripe.com/aFa00k4uVeoUaQN00B0480n` for the seed product);
  the real purchase is completed on Stripe and recorded via `POST /webhooks/stripe`.

**Records** (on `POST /checkout`):
- A **cart row** is created (lead, product, started_at, status open).
- Tags applied: **`STARTED_CHECKOUT`**, **`HIGH_INTENT`**.

**Emails:** Nothing sent at this moment — the abandoned-cart sequence is *time-based*,
not instant. The scheduler watches for carts that stay open past thresholds.

**Stops/Changes:** If the visitor completes the purchase instead of abandoning, see Stage 6.

---

## Stage 5 — ABANDONED CART (1h / 24h / 60h / 144h)

The scheduler (run via `POST /admin/run-scheduler?token=`, and automatically on a cadence when
the server runs) detects open carts that have aged past the thresholds and:

**Sees:** Nothing in the browser — this is entirely behind the scenes.

**Records:**
- Tag **`ABANDONED_CART`** is applied once the first threshold (1h) is crossed.

**Emails — scheduled at 4 thresholds:**
| Threshold | Email |
|---|---|
| +1 hour after cart start | Cart reminder #1 |
| +24 hours | Cart reminder #2 |
| +60 hours | Cart reminder #3 |
| +144 hours (6 days) | Cart reminder #4 (final) |

Each is queued when it becomes due and sent as an HTML file to `data/outbox/` (local provider).
(The test suite forces these due via `UPDATE ... SET scheduled_for = ...` since waiting 144 hours
is impractical.)

**Stops/Changes — purchase or unsubscribe wins:**
- **Purchase at any point:** the `ABANDONED_CART` tag is **removed immediately**, all pending
  cart emails flip to status **`cancelled`**, and the remaining reminders are never sent.
- **Unsubscribe at any point:** `UNSUBSCRIBED` is applied and all pending emails are cancelled.

---

## Stage 6 — CUSTOMER (purchase completed)

**Sees:**
- Demo mode: after `POST /checkout/complete-demo` → 302 to `GET /thank-you`.
  (Order bump/upsells are disabled in the seed config, so no upsell interstitial is shown.)
- Stripe mode: Stripe confirms payment → `POST /webhooks/stripe` records it → lead's next visit
  to `/thank-you` shows the confirmation.

**Records:**
- A **purchase row** (lead, product, amount $100, recurring, timestamps).
- Tags applied: **`PURCHASED`**, **`CUSTOMER`**, **`OFFER_<id>_PURCHASED`**.
- Tag **removed**: `ABANDONED_CART`.
- The cart row is marked paid/closed.
- If a previous purchase already exists → tag **`REPEAT_CUSTOMER`** instead of/in addition to first-purchase tags.

**Emails:**
- **Confirmation email** sent immediately (receipt for the purchase).
- **Post-purchase sequence**: 6 emails scheduled after the purchase (onboarding, how to get
  value, support contact, etc.).
- **Cart emails cancelled**: every pending abandoned-cart email for that cart is set to
  status `cancelled` — purchase stops the cart sequence *immediately*, even mid-sequence.

**Stops/Changes:** Buying ends the prospect journey. The customer no longer receives
prospect-targeted weekly nurture for the featured offer (they are now a customer, not a prospect).

---

## Stage 7 — UPSELL (accept or decline)

> Note: order bump and upsells are **disabled in the seed config**, so this stage is skipped
> in the default build. It applies when upsells are enabled in `config/products.json`.

**Sees:** An upsell offer page after the first purchase (accept → second checkout; decline → thank-you).

**Records:**
- Accept → second purchase row + tags **`UPSELL_ACCEPTED`**, and if it creates another product
  ownership, `OFFER_<upsell_id>_PURCHASED`.
- Decline → tag **`UPSELL_DECLINED`**.

**Emails:** Post-purchase sequence continues; a second purchase can trigger its own confirmation
and relevant follow-ups.

---

## Stage 8 — REPEAT CUSTOMER / long-term

**Sees:** Normal site; future purchases go through the same checkout.

**Records:**
- On any purchase after the first: tag **`REPEAT_CUSTOMER`**.

**Emails:**
- **Weekly nurture** continues — but scoped to prospects. Purchasers are **suppressed from
  prospect promotions for the featured offer** they already bought (no "buy it again" emails for
  the offer they own). They may still receive customer-appropriate weekly content depending on config.
- If the customer unsubscribes (`/unsubscribe`): tag `UNSUBSCRIBED`, everything pending cancelled,
  and no further marketing email is sent to them.

---

## Global "what STOPS things" rules

1. **Purchase stops cart emails immediately.** `ABANDONED_CART` tag removed; pending cart
   emails → `cancelled`. Even emails queued but not yet sent are cancelled.
2. **Unsubscribe stops everything.** One-click `GET /unsubscribe?email=` + `POST /unsubscribe` →
   `UNSUBSCRIBED` tag; all queued emails for that lead → `cancelled`. (Transactional truthfulness
   rule: copy never pretends an unsubscribe didn't happen.)
3. **Suppression list.** Bounced/complained addresses land in suppressions
   (`/admin/suppressions`); `SUPPRESSED` contacts get no further outbound email.
4. **Purchase removes the prospect from prospect promotion.** Weekly nurture targets prospects;
   customers don't get "buy the thing you already bought" campaigns.

## Truthfulness guardrails (apply at every stage)

All copy in the app (pages and emails) must follow these: **no fake scarcity** (no invented
countdowns or "only 3 left" unless literally true), **no deceptive subject lines** (subject must
match the email's content), **no invented testimonials** (every quote must be real and attributable),
**no earnings promises** (never guarantee income, loads, or revenue — dispatch subscriptions are
services, not income guarantees).
