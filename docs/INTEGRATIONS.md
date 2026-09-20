# Integrations — What Works Today vs. What Needs an External Account

> Written spec-first from the contract (2026-09-19).

For each integration area: **(a)** what works out of the box today, **(b)** what account/API
key/integration is required to go beyond that, **(c)** the exact env vars and accounts needed.

---

## 1. Email sending

**(a) Works out of the box TODAY.**
- Email provider defaults to **"local"**: every outbound email (welcome, nurture, cart reminders,
  confirmations, post-purchase) is rendered as a full **HTML file written to `data/outbox/`** and
  is also visible in the admin panel (`/admin/emails`, `/admin/outbox`).
- The scheduler (`POST /admin/run-scheduler?token=`) processes the email queue and produces these
  files. No external service, API key, or account is needed — this is how testing works.

**(b) To send real email** (to actual inboxes), you need a transactional email provider account —
e.g. **Resend** (the app's supported provider per config).

**(c) Exact env vars / accounts:**
- `EMAIL_PROVIDER=local` (default) or `EMAIL_PROVIDER=resend`
- `RESEND_API_KEY=<your Resend API key>` — required when `EMAIL_PROVIDER=resend`
- Resend account: sign up at resend.com, verify your sending domain (DNS records), create an API key.
- From-address/email identity is configured in `config/emails.json` (or via `/admin/config`).

**Note:** even with a real provider, `data/outbox/` remains the reliable place to *verify* what
was rendered during testing.

---

## 2. CRM / database

**(a) Works out of the box TODAY.**
- The **SQLite database IS the CRM.** It holds leads, carts, purchases, tags,
  email queue/history, suppressions, and page-view/event analytics tables.
- Two backends, chosen automatically: **local file** (`data/funnel.db`, the default) or
  **Turso** when both `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set (uses
  `@libsql/client` — the same schema and behavior, just over the network). The local
  outbox directory (`data/outbox/`) is still created in both modes.
- The **admin pages are the CRM interface**: `/admin` (dashboard metrics), `/admin/leads?q=`
  (search leads), `/admin/carts`, `/admin/emails`, `/admin/outbox`, `/admin/suppressions`,
  `/admin/config` (view/edit config files, `POST /admin/config/:file` to save).

**(b) Nothing external is required.** There is no Salesforce/HubSpot sync, no external CRM —
the admin tables plus the database are the whole system. Turso is the recommended option for
cloud hosting (see README deploy notes) so data survives restarts.

**(c) Env vars / accounts:**
- Local mode: none — just keep the `data/` directory persistent on your host
  (on Render free tier the disk is ephemeral, which is why Turso is recommended there).
- Turso mode: a free Turso account (https://turso.tech), one database, and
  `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (get both from the Turso dashboard;
  token via `turso db tokens create <db-name>`).

---

## 3. Checkout / payment processing

**(a) Works out of the box TODAY (two modes).**
- **Demo mode** (`paymentMode: "demo"` in `config/site.json`, the seed default): the full funnel
  is testable end-to-end with zero payment setup. `POST /checkout` creates a cart; the demo page's
  form `POST`s to `/checkout/complete-demo`, which records a purchase ("no charge") and 302s to
  `/thank-you`.
- **Stripe payment-link mode** (`paymentMode: "stripe"`): `POST /checkout` creates the cart and
  **302-redirects the buyer to the product's Stripe payment link** (seed product:
  `https://buy.stripe.com/aFa00k4uVeoUaQN00B0480n`). The real charge happens on Stripe's hosted
  page; completion is recorded via the `POST /webhooks/stripe` stub webhook (`{email, productId}`).

**(b) What is NOT built — be explicit:**
- **Embedded card checkout is NOT built.** There is no on-page card form, no Stripe.js, no
  PaymentIntent flow. To get embedded checkout you would need Stripe **API keys** (publishable +
  secret) and new code to create PaymentIntents and confirm cards — that is a future build, not
  config.
- To use the current Stripe mode for real money you need a **Stripe account**, a **payment link**
  per product (put in `config/products.json`), and the webhook endpoint registered so Stripe can
  notify the app of completed payments.

**(c) Env vars / accounts:**
- `config/site.json` → `paymentMode`: `"demo"` or `"stripe"`
- Stripe account (stripe.com) with a payment link per product; paste links into `config/products.json`.
- Webhook: point Stripe at `POST /webhooks/stripe` on your deployed URL. (The stub accepts
  `{email, productId}`; a production hardening pass should verify Stripe signatures.)

---

## 4. Abandoned-cart tracking

**(a) Works out of the box TODAY.**
- `POST /checkout` creates a cart row tagged `STARTED_CHECKOUT`/`HIGH_INTENT`. The scheduler
  (same `POST /admin/run-scheduler?token=` pass) ages open carts and fires the 1h / 24h / 60h / 144h
  reminder sequence automatically, applying `ABANDONED_CART`.
- Purchase at any time cancels all pending cart emails immediately and removes the tag.

**(b) Nothing external is required.**

**(c) Env vars / accounts:** none — but **the server must be running** for the scheduler to fire.
In production, trigger `POST /admin/run-scheduler?token=<ADMIN_TOKEN>` on a cron (e.g. every
5–15 minutes) or keep the app's internal scheduler cadence running. Local testing uses the
manual admin endpoint plus `sqlite3` to age carts (see TESTING.md).

---

## 5. Analytics

**(a) Works out of the box TODAY — first-party only.**
- Page views and funnel events (lead submit, offer view, checkout start, purchase) are recorded in
  **SQLite tables** in `data/funnel.db`. The admin dashboard (`/admin`) surfaces key metrics
  from these tables. No third party involved.

**(b) NOT wired:** Google Analytics (or any third-party analytics) is **not** integrated. There is
no GA tag, no tracking ID config.

**(c) To add Google Analytics later:** a GA4 property + measurement ID, and code to inject the
`gtag.js` snippet into page templates. Not present in the seed; first-party tables are the
supported analytics today.

---

## 6. SMS

**(a) NOT built.** Be explicit: there is **no SMS sending, no SMS capture flow, and no SMS
provider integration** in the app today. Phone numbers are collected (optional field on lead and
checkout forms) and stored, but nothing sends to them.

**(b) To add SMS:** an account with a provider like **Twilio** (or similar), plus new code for a
provider module, opt-in consent handling, and message templates.

**(c) Env vars / accounts (if built later):** Twilio `ACCOUNT_SID`, `AUTH_TOKEN`, and a Twilio
phone number (`TWILIO_FROM`). None of these exist in the app today.

---

## Summary table

| Area | Works today | Needs external account/key |
|---|---|---|
| Email sending | Local provider → `data/outbox/` HTML files + admin views | Resend account + `RESEND_API_KEY`, set `EMAIL_PROVIDER=resend` to send real email |
| CRM / database | SQLite (`data/funnel.db`) + admin pages are the CRM; Turso backend available | Nothing required; Turso needs `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (free Turso account) |
| Checkout / payments | Demo mode (no charge) + Stripe **payment-link redirect** + webhook stub | Stripe account + per-product payment links in `config/products.json`; embedded card checkout NOT built (would need Stripe API keys + new code) |
| Abandoned cart | Scheduler-driven, 1h/24h/60h/144h, auto-cancel on purchase | Nothing (server must be running / scheduler triggered) |
| Analytics | First-party page-view/event tables in SQLite + admin dashboard | Nothing; Google Analytics NOT wired (would need GA4 ID + snippet code) |
| SMS | NOT built (phone stored only) | Twilio or similar + new code (`ACCOUNT_SID`, `AUTH_TOKEN`, from-number) |

## Env var reference (all of them)

| Var | Default | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | `changeme` | Authorizes admin pages and scheduler trigger (`?token=`). **Change in production.** |
| `EMAIL_PROVIDER` | `local` | `local` = write HTML to `data/outbox/`; `resend` = send real email |
| `RESEND_API_KEY` | (none) | Required when `EMAIL_PROVIDER=resend` |
| `PORT` | `3000` | Port the app listens on (Render injects its own) |
| `TURSO_DATABASE_URL` | (none) | Turso database URL (e.g. `libsql://your-db-yourorg.turso.io`). With `TURSO_AUTH_TOKEN` set, the app uses Turso instead of the local SQLite file |
| `TURSO_AUTH_TOKEN` | (none) | Auth token for the Turso database (`turso db tokens create <db-name>`) |

**Ephemeral-disk note (Render free tier):** local disk is wiped on restart/redeploy, so
`data/outbox/` files and admin-panel config-file edits do not survive — but all database
content (leads, carts, purchases, tags, email queue) persists via **Turso**.

Config files (editable via `/admin/config` or directly):
- `config/site.json` — `paymentMode` (`demo`/`stripe`), site/business settings
- `config/products.json` — products, prices, Stripe payment links, upsell config
- `config/emails.json` — email templates incl. the **weeklyFlyer** content
