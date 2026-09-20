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
