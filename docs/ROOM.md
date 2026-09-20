# The Wealth Builder's Room — membership community

Davena's own Skool replacement, built into the funnel site. Members pay
**$49/month** (recurring — never describe it as one-time) through her own
Stripe payment link, then learn inside the Room.

## Public URLs (production)

| What | URL |
|---|---|
| Join / checkout | `https://funnel-qdx9.onrender.com/checkout/room` → 302 to the $49/mo Stripe payment link |
| Claim access (after paying) | `https://funnel-qdx9.onrender.com/room/claim` |
| Member login | `https://funnel-qdx9.onrender.com/room/login` |
| Member dashboard | `https://funnel-qdx9.onrender.com/room` |
| Classroom (7 pillars) | `https://funnel-qdx9.onrender.com/room/classroom` |
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
