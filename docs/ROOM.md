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
| 90-day goal | `https://funnel-qdx9.onrender.com/room/goal` |
| Weekly check-in (Proof of Progress) | `https://funnel-qdx9.onrender.com/room/checkin` |
| 12-week progress tracker | `https://funnel-qdx9.onrender.com/room/progress` |
| 90-day review | `https://funnel-qdx9.onrender.com/room/review` |
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
| `room_goals` | One 90-day goal per member: text, start date, target date (start + 90 days) |
| `room_checkins` | Weekly Proof of Progress entries (one per member per week): goal, action, accomplishment, lesson, next commitment, optional proof-file metadata, server-generated timestamp |
| `room_reviews` | One 90-day review per member: 8 reflection answers |

Room purchases also land in the existing `purchases` table
(`product_id='room'`, 4900 cents) so revenue metrics include them.

## Action + Accountability system

The Room runs a **LEARN → ACT → PROVE → REFLECT → REPEAT** loop on top of
the classroom:

- **90-day goal** (`/room/goal`): on first dashboard visit members are
  prompted to set ONE goal ("MY 90-DAY WEALTH GOAL"). The start date and
  target date are fixed at creation; editing the wording never moves the
  12-week clock. The goal banner shows across the member's Room experience.
- **Weekly Proof of Progress** (`/room/checkin`): a private weekly check-in —
  goal → action → proof → lesson → next action. Optional proof upload
  (PNG/JPG/GIF/WebP/PDF, ≤ 8 MB, stored under `data/proofs/` and served
  only to the owning member). Uploads require the member to confirm the
  file contains no sensitive personal information. Timestamps are always
  server-generated; members can only ever see their own check-ins.
- **12-week tracker** (`/room/progress`): weeks 1–12 with completed weeks
  marked, current week, streak, last check-in, latest accomplishment /
  lesson / next commitment. Motto: "PROGRESS, NOT PERFECTION." Missed weeks
  are never punished or shamed.
- **90-day review** (`/room/review`): 8 reflection questions plus a journey
  summary built from the member's check-ins.
- **Lesson CTAs:** every classroom section ends with "NOW PUT IT INTO
  ACTION." linking to the weekly check-in (LEARN ↓ APPLY ↓ DOCUMENT ↓
  REFLECT ↓ MOVE FORWARD).
- **Accountability posts:** 12 weekly community posts (WEEK 1 … WEEK 12),
  seeded automatically, each with a theme, a concrete action, and a
  check-in pointer. Never pinned, never ranked.
- **Emails** (via the existing scheduler + `email_queue`):
  - Weekly reminder — subject `Your Wealth Builder weekly check-in` — to
    active, claimed members with a goal who missed the current week's
    check-in. Never to canceled/inactive/suppressed members.
  - Confirmation — subject `Progress documented ✓` — immediately after
    each check-in submission.
- **Admin → Room → Accountability:** per-member current week, goal,
  check-ins completed, checked-in-this-week, streak, last check-in, proof
  status, latest accomplishment/lesson/next commitment, review status —
  plus "checked in" / "not checked in" lists. No rankings, no leaderboard.

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
