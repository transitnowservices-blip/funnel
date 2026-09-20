# Testing — Manual End-to-End Walkthrough

> Written spec-first from the contract (2026-09-19). Assumes the app is built per contract.
> DB path: `data/funnel.db`. Run `sqlite3` from the app root.

## 0. Start the server

```bash
cd ~/workspace/funnel
npm install
ADMIN_TOKEN=test-token npm start
# → listening on http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/healthz
# expect: ok
```

Admin pages use `?token=test-token` (e.g. `http://localhost:3000/admin?token=test-token`).

---

## 1. Anonymous visit

1. Open `http://localhost:3000/` in a fresh/private browser window.
2. Verify: a `vid` cookie is set (DevTools → Application → Cookies). No `lid` cookie yet.
3. Verify a page-view row exists:

```bash
sqlite3 data/funnel.db "SELECT COUNT(*) FROM page_views;"   # table name per build; expect ≥1
```

---

## 2. Submit a lead

1. Visit `http://localhost:3000/lead?src=facebook&cmp=fall2026`.
2. Fill `first_name`, `email` (required), `phone` (optional), check consent, submit.
3. Expect a 302 to `/free-value`; verify a `lid` cookie is now set.

Verify in the DB:

```bash
sqlite3 data/funnel.db "SELECT email, source, campaign FROM leads ORDER BY id DESC LIMIT 1;"
sqlite3 data/funnel.db "SELECT tag FROM lead_tags WHERE lead_id = (SELECT MAX(id) FROM leads);"
# expect: NEW_LEAD
```

Verify the welcome email:

```bash
ls -t data/outbox | head -3
# expect: a new HTML file; open it — it should be the Day-0 welcome
```

---

## 3. Run the scheduler (first pass)

```bash
curl -X POST "http://localhost:3000/admin/run-scheduler?token=test-token"
# expect: JSON summary of the pass
```

The welcome/nurture Day-0 email should now be sent (file in `data/outbox/`), and nurture
Day 1/3/5/7 + weekly emails should be queued with future `scheduled_for` times:

```bash
sqlite3 data/funnel.db "SELECT subject, scheduled_for, status FROM email_queue ORDER BY scheduled_for;"
```

---

## 4. View the sales page

1. Visit `http://localhost:3000/sales` (still cookied as the lead).
2. Verify tags:

```bash
sqlite3 data/funnel.db "SELECT tag FROM lead_tags WHERE lead_id = (SELECT MAX(id) FROM leads);"
# expect: NEW_LEAD, VIEWED_OFFER, OFFER_<id>_VIEWED
```

---

## 5. Start checkout, then abandon

1. Visit `http://localhost:3000/checkout`, submit the form (`first_name`, `email`, `phone`).
2. In **demo mode** you land on the "Complete Demo Purchase — no charge" page. **Do not click it yet** — this is the abandon path.

Verify the cart and tags:

```bash
sqlite3 data/funnel.db "SELECT id, status, started_at FROM carts ORDER BY id DESC LIMIT 1;"
# expect: status open
sqlite3 data/funnel.db "SELECT tag FROM lead_tags WHERE lead_id = (SELECT MAX(id) FROM leads);"
# expect: includes STARTED_CHECKOUT and HIGH_INTENT
```

---

## 6. Trigger the abandoned-cart sequence

Run the scheduler — nothing cart-related should fire yet (cart is fresh):

```bash
curl -X POST "http://localhost:3000/admin/run-scheduler?token=test-token"
```

Now **age the cart 2 hours** so the 1h threshold trips:

```bash
sqlite3 data/funnel.db "UPDATE carts SET started_at = datetime('now','-2 hours') WHERE id = (SELECT MAX(id) FROM carts);"
curl -X POST "http://localhost:3000/admin/run-scheduler?token=test-token"
```

Verify:

```bash
sqlite3 data/funnel.db "SELECT tag FROM lead_tags WHERE lead_id = (SELECT MAX(id) FROM leads);"
# expect: ABANDONED_CART present
sqlite3 data/funnel.db "SELECT subject, status FROM email_queue WHERE template LIKE '%cart%' ORDER BY id DESC LIMIT 4;"
# expect: cart reminder #1 queued/sent
```

Force the remaining 3 cart emails due (instead of waiting 24h/60h/144h):

```bash
sqlite3 data/funnel.db "UPDATE email_queue SET scheduled_for = datetime('now','-1 minute') WHERE status='queued' AND template LIKE '%cart%';"
curl -X POST "http://localhost:3000/admin/run-scheduler?token=test-token"
# Confirm via the queue (filenames in data/outbox are build-specific; newest files should be the cart reminders):
sqlite3 data/funnel.db "SELECT COUNT(*) FROM email_queue WHERE template LIKE '%cart%' AND status='sent';"
# expect: 4
ls -t data/outbox | head -6
```

---

## 7. Complete the demo purchase (cart emails must stop)

1. Go back to the demo page and submit the `POST /checkout/complete-demo` form ("Complete Demo Purchase — no charge").
2. Expect a 302 to `/thank-you`; the thank-you page renders.

Verify the purchase killed the cart sequence:

```bash
# Cart emails cancelled:
sqlite3 data/funnel.db "SELECT subject, status FROM email_queue WHERE template LIKE '%cart%' ORDER BY id DESC;"
# expect: any not-yet-sent cart emails now status='cancelled'

# ABANDONED_CART removed; purchase tags present:
sqlite3 data/funnel.db "SELECT tag FROM lead_tags WHERE lead_id = (SELECT MAX(id) FROM leads);"
# expect: PURCHASED, CUSTOMER, OFFER_<id>_PURCHASED present; ABANDONED_CART absent

# Purchase row:
sqlite3 data/funnel.db "SELECT product_id, amount_cents FROM purchases ORDER BY id DESC LIMIT 1;"
```

Run the scheduler and confirm a post-purchase email arrives and no more cart mail goes out:

```bash
curl -X POST "http://localhost:3000/admin/run-scheduler?token=test-token"
ls -t data/outbox | head -3
# expect: confirmation email HTML; then post-purchase sequence emails queue over time
```

---

## 8. Second lead: purchase immediately (no abandon)

Repeat steps 2 → 5 with a second email address, but this time **complete the demo purchase
immediately** at step 7. Verify:
- No `ABANDONED_CART` tag ever appears.
- No cart emails are ever queued/sent for this lead.
- `PURCHASED`/`CUSTOMER` tags and confirmation + post-purchase sequence behave the same.

---

## 9. Weekly nurture scheduling (purchasers suppressed from prospect promo)

Force a weekly nurture email due for both leads:

```bash
sqlite3 data/funnel.db "UPDATE email_queue SET scheduled_for = datetime('now','-1 minute') WHERE status='queued' AND template LIKE '%weekly%';"
curl -X POST "http://localhost:3000/admin/run-scheduler?token=test-token"
```

Verify per contract: **prospect (non-purchaser) weekly emails send**; a purchaser does not
receive prospect promotion for the featured offer they already bought:

```bash
sqlite3 data/funnel.db "SELECT l.email, q.subject, q.status FROM email_queue q JOIN leads l ON l.id=q.lead_id WHERE q.template LIKE '%weekly%' ORDER BY q.id DESC;"
```

---

## 10. Unsubscribe (one-click)

1. `GET http://localhost:3000/unsubscribe?email=<lead1-email>` → confirm page.
2. `POST /unsubscribe` with the email (one-click form).
3. Verify:

```bash
sqlite3 data/funnel.db "SELECT tag FROM lead_tags lt JOIN leads l ON l.id=lt.lead_id WHERE l.email='<lead1-email>';"
# expect: UNSUBSCRIBED present
sqlite3 data/funnel.db "SELECT COUNT(*) FROM email_queue q JOIN leads l ON l.id=q.lead_id WHERE l.email='<lead1-email>' AND q.status='queued';"
# expect: 0 — everything pending cancelled
```

4. Run the scheduler once more and confirm **no new outbox file** is generated for that email:

```bash
BEFORE=$(ls data/outbox | wc -l)
curl -s -X POST "http://localhost:3000/admin/run-scheduler?token=test-token" > /dev/null
AFTER=$(ls data/outbox | wc -l)
# expect: AFTER == BEFORE (for the unsubscribed lead; other leads may still generate files)
```

---

## 11. Admin dashboard metrics

```bash
curl -s "http://localhost:3000/admin?token=test-token" | grep -oiE "(leads|carts|purchases|emails|revenue|conversion)[^<]*" | head -20
```

Expect HTTP 200 and visible labels for the key metrics (lead count, carts, purchases,
emails sent/queued). Also spot-check `/admin/leads?q=<email>`, `/admin/carts`,
`/admin/emails`, `/admin/outbox`, `/admin/suppressions` all return 200.

---

## 12. Automated version

All of the above is encoded in `scripts/test-funnel.js` (thin wrapper: `scripts/test-funnel.sh`).
It starts its own server on port 3111 with `ADMIN_TOKEN=test-token`, runs the assertions with
PASS/FAIL output, and kills the server at the end:

```bash
bash scripts/test-funnel.sh
# or: node scripts/test-funnel.js
```

Exit code is non-zero on any failure.

## Truthfulness spot-check (do once per copy change)

- No fake countdowns/scarcity on landing, sales, checkout, or emails.
- Every email subject matches the email's actual content.
- No testimonials appear unless they are real and attributable.
- No copy promises earnings, loads, revenue, or guaranteed work.

## Backend notes for the automated suite (from the backend agent)

- **Time tolerance.** The contract stores times as epoch-ms integers, and the
  backend always writes epoch ms. The scheduler's read path (`detectAbandonedCarts`,
  `processDueEmails` in `lib/automation.js`) additionally tolerates SQLite
  `datetime('now', ...)` TEXT and numeric strings via `toMs()`, so tests and
  admin SQL that age rows with `datetime()` behave the same as epoch-ms writes.
- **Purchase stops the nurture promotion (adjudicated).** On purchase of a
  product, the backend now cancels *all* remaining queued nurture emails for
  that product (`cancelNurtureForProduct` in `lib/automation.js`, called from
  `recordPurchase` in `server.js`) — the buyer leaves the prospect promotion
  and moves into the post-purchase/customer sequence, per the requirement
  "automatically stops promotional emails when someone purchases an offer
  they were being nurtured toward." Nurture for *other* products is
  unaffected. The narrower `cancelNurtureOfferSteps` helper is retained for
  callers that only want the offer step.
- **Keyword discovery (fixed in the suite).** The suite's email discovery now
  also searches the `sequence`/`step` columns, so cart (`abandonedCart`),
  post-purchase (`postPurchase`), nurture (`nurture`), and weekly (`weekly`)
  rows are found regardless of subject wording.
