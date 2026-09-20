# Funnel — TransitNow Logistics Services

A self-contained marketing funnel web app: landing page → lead capture → lead magnet →
sales page → checkout → abandoned-cart recovery → purchase → post-purchase follow-up,
plus weekly nurture and one-click unsubscribe. No external services required to run or test.

> Docs written spec-first from the contract (2026-09-19). Key reads:
> - `docs/AUTOMATION_MAP.md` — exactly what happens to one person, stage by stage
> - `docs/INTEGRATIONS.md` — what works today vs. what needs an external account
> - `docs/TESTING.md` — manual end-to-end walkthrough

## What is functional now

- **Landing, lead form, free-value lead magnet, sales page, checkout, thank-you page** — all routes live.
- **Lead capture**: `POST /lead` saves the lead, tags `NEW_LEAD`, sets the `lid` cookie, sends a
  welcome email and schedules nurture (Day 0/1/3/5/7 → weekly).
- **Checkout in demo mode** (`paymentMode: "demo"`): creates a cart, tags `STARTED_CHECKOUT` /
  `HIGH_INTENT`, and a no-charge "Complete Demo Purchase" button records the purchase.
- **Stripe payment-link mode** (`paymentMode: "stripe"`): checkout 302-redirects to the product's
  Stripe payment link; completion recorded via the `POST /webhooks/stripe` stub.
- **Abandoned-cart recovery**: scheduler fires cart reminders at 1h / 24h / 60h / 144h, tags
  `ABANDONED_CART`. **Purchase cancels all pending cart emails immediately** and removes the tag.
- **Post-purchase**: confirmation email + 6-email post-purchase sequence; tags `PURCHASED`,
  `CUSTOMER`, `OFFER_<id>_PURCHASED`; repeat buyers get `REPEAT_CUSTOMER`.
- **Weekly nurture** for prospects; purchasers are suppressed from prospect promotion of the
  featured offer.
- **Unsubscribe**: one-click `GET /unsubscribe?email=` + `POST /unsubscribe` → `UNSUBSCRIBED` tag,
  all queued emails cancelled.
- **Email (local provider)**: every outbound email is written as an HTML file to `data/outbox/`
  and visible in admin — this is the testing path, no email service needed.
- **Admin** (token via `?token=`): dashboard, leads search, carts, emails, outbox, suppressions,
  config editor (`POST /admin/config/:file`), one-pass scheduler trigger
  (`POST /admin/run-scheduler?token=`), mark-paid.
- **SQLite is the CRM**: `data/funnel.db` holds leads, carts, purchases, tags, email queue, and
  first-party page-view/event analytics; the admin pages are the interface.

## What requires external integration

- **Real email delivery** → Resend account + `RESEND_API_KEY`, set `EMAIL_PROVIDER=resend`.
  (Default `local` only writes files.)
- **Real payments** → Stripe account + per-product payment links in `config/products.json`, set
  `paymentMode: "stripe"`, register `POST /webhooks/stripe` in Stripe. Embedded card checkout is
  **not** built (would need Stripe API keys + new code).
- **SMS** → not built at all (would need Twilio or similar + new code).
- **Google Analytics** → not wired; analytics is first-party SQLite tables.
- See `docs/INTEGRATIONS.md` for the full table and exact env vars.

## Where to enter products / prices

- `config/products.json` — products, prices, Stripe payment links, upsell/order-bump config.
  Also editable in the browser at `/admin/config?token=...` (`POST /admin/config/:file` saves).
- Seed product: **"TransitNow Complete Dispatch"**, $100/month recurring,
  Stripe link `https://buy.stripe.com/aFa00k4uVeoUaQN00B0480n`.
- `config/site.json` — `paymentMode` (`"demo"` or `"stripe"`), business info:
  TransitNow Logistics Services · 414-897-3282 · transitnowservices@gmail.com ·
  "Stay Ready So You Don't Have To Get Ready."

## Where to edit the weekly flyer

- `config/emails.json` — the `weeklyFlyer` template/content block. Edit directly or via
  `/admin/config?token=...`.

## Where to see leads / carts / customers

- `/admin?token=...` — dashboard metrics
- `/admin/leads?q=...` — search leads (tags visible per lead)
- `/admin/carts` — open/abandoned/paid carts
- `/admin/emails` and `/admin/outbox` — sent + queued mail and rendered HTML
- `/admin/suppressions` — bounced/complained addresses

## How to run

```bash
npm install
npm start            # → node server.js, http://localhost:3000
```

Env vars:

| Var | Default | Notes |
|---|---|---|
| `ADMIN_TOKEN` | `changeme` | **Change this.** Authorizes `/admin*` and the scheduler trigger. |
| `EMAIL_PROVIDER` | `local` | `local` (files to `data/outbox/`) or `resend` (real sending) |
| `RESEND_API_KEY` | — | Required when `EMAIL_PROVIDER=resend` |
| `PORT` | `3000` | Listen port |

Health check: `GET /healthz` → `ok`.

To keep the scheduler firing on its own in production, hit
`POST /admin/run-scheduler?token=<ADMIN_TOKEN>` on a cron (every 5–15 min) or rely on the
app's internal cadence.

## How to test

Manual walkthrough: `docs/TESTING.md`.

Automated (starts its own server on port 3111, asserts the whole funnel, exits non-zero on failure):

```bash
bash scripts/test-funnel.sh
# or directly:
node scripts/test-funnel.js
```

## Deploy notes

Runs on any server she controls. Recommended path: **Render free tier + Turso database**
(`render.yaml` at the project root is a Render Blueprint — in the Render dashboard choose
New → Blueprint and point it at this folder).

- **Render (recommended)**: the Blueprint creates the web service with
  `buildCommand: npm install` and `startCommand: npm start`. Set these env vars in the
  service's Environment tab:
  - `ADMIN_TOKEN` — strong random value (the admin panel's `?token=` password)
  - `TURSO_DATABASE_URL` — e.g. `libsql://your-db-yourorg.turso.io`
  - `TURSO_AUTH_TOKEN` — from `turso db tokens create <db-name>`
  - `EMAIL_PROVIDER=local` (default; test mode, no real email)
  - `RESEND_API_KEY` — only when you switch to real email delivery
  - `PORT` is injected automatically by Render.
- **Turso** (https://turso.tech): create a free database in the Turso dashboard, then copy
  the database URL and create an auth token. When both vars are set the app uses Turso
  instead of the local SQLite file — the exact same schema and behavior, over
  `@libsql/client`.
- **Ephemeral-disk note (honest):** on Render's free tier the local disk is wiped on every
  restart/redeploy. All database content (leads, carts, purchases, tags, email queue) is
  safe because it lives in **Turso**, but two things do NOT survive a restart: files in
  `data/outbox/` (local test emails) and edits made to `config/*.json` through the admin
  panel — keep those config edits in your repo/files and redeploy instead.
- **VPS** (e.g. plain Linux box): `git pull`, `npm install`, run under `systemd` or `pm2`.
  If you skip Turso, keep `data/` on durable disk and back it up (it's the whole CRM).
  Put a reverse proxy (nginx/Caddy) in front for HTTPS, which Stripe webhooks require.
- Truthfulness rules for all copy (enforced by review, not code): no fake scarcity, no
  deceptive subjects, no invented testimonials, no earnings promises.
