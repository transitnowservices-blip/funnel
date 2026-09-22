/**
 * lib/content.js — Davena's reusable content library.
 *
 * Her existing flyers, posts, captions, and sales messages live here,
 * organized by offer. Each item has a posting cadence (daily / 2-3x per
 * week / weekly / follow-up), a short message, a simple CTA, and a unique
 * campaign code. Posting links carry ?campaign=<code> so every lead is
 * attributed back to the exact flyer/message that produced it.
 *
 * "What should I post today?" picks the most-due item per cadence with
 * automatic rotation (oldest-suggested first), so the same post never
 * feels like it's on repeat.
 */
const db = require('./db');
const config = require('./config');

const OFFERS = {
  room: "Wealth Builder's Room — $49/month",
  dispatch: 'TransitNow Dispatch Services',
  courier: 'Courier gigs/routes/RSP opportunities',
  business: 'Business/funding help',
  remote: 'Remote-work opportunities',
};

const CADENCES = {
  'daily': 'Daily',
  '2-3x-week': '2–3 times per week',
  'weekly': 'Weekly',
  'follow-up': 'Follow-up',
};

const KINDS = {
  flyer: 'Flyer',
  message: 'Message',
  caption: 'Caption',
  sales: 'Sales message',
};

const DEFAULT_CTA = "Click the link, fill out the short form, and let's see what you're building.";

// Where each offer's tracked link points (the correct offer for the interest).
const OFFER_LINKS = {
  room: '/room/start',
  dispatch: '/dispatch',
  courier: '/grow/apply',
  business: '/business',
  remote: '/lead',
};

function chicagoWeekday(now) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(new Date(now));
  } catch (e) {
    return new Date(now).toLocaleDateString('en-US', { weekday: 'short' });
  }
}

async function listItems(activeOnly = true) {
  const rows = await db.all(
    `SELECT * FROM content_library ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY offer, id`
  );
  return rows || [];
}

async function getItem(id) {
  return db.get('SELECT * FROM content_library WHERE id = ?', [Number(id)]);
}

async function getByCampaign(code) {
  if (!code) return null;
  return db.get('SELECT * FROM content_library WHERE campaign_code = ? AND active = 1', [String(code).trim()]);
}

function cleanStr(v) {
  return v == null ? null : String(v).trim() || null;
}

async function createItem(f) {
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO content_library
       (offer, title, kind, body, flyer_path, cadence, cta, where_to_post,
        campaign_code, link, active, times_suggested, last_suggested_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?)`,
    [
      OFFERS[f.offer] ? f.offer : 'room',
      cleanStr(f.title) || 'Untitled',
      KINDS[f.kind] ? f.kind : 'message',
      cleanStr(f.body),
      cleanStr(f.flyer_path),
      CADENCES[f.cadence] ? f.cadence : 'weekly',
      cleanStr(f.cta) || DEFAULT_CTA,
      cleanStr(f.where_to_post),
      cleanStr(f.campaign_code) || ('item-' + now),
      cleanStr(f.link) || OFFER_LINKS[f.offer] || '/lead',
      now,
    ]
  );
  return getItem(Number(info.lastInsertRowid));
}

async function updateItem(id, f) {
  const cur = await getItem(id);
  if (!cur) return null;
  await db.run(
    `UPDATE content_library SET
       offer = ?, title = ?, kind = ?, body = ?, flyer_path = ?,
       cadence = ?, cta = ?, where_to_post = ?, campaign_code = ?, link = ?
     WHERE id = ?`,
    [
      OFFERS[f.offer] ? f.offer : cur.offer,
      cleanStr(f.title) || cur.title,
      KINDS[f.kind] ? f.kind : cur.kind,
      f.body !== undefined ? cleanStr(f.body) : cur.body,
      f.flyer_path !== undefined ? cleanStr(f.flyer_path) : cur.flyer_path,
      CADENCES[f.cadence] ? f.cadence : cur.cadence,
      f.cta !== undefined ? (cleanStr(f.cta) || DEFAULT_CTA) : cur.cta,
      f.where_to_post !== undefined ? cleanStr(f.where_to_post) : cur.where_to_post,
      cleanStr(f.campaign_code) || cur.campaign_code,
      f.link !== undefined ? (cleanStr(f.link) || cur.link) : cur.link,
      Number(id),
    ]
  );
  return getItem(id);
}

async function setActive(id, active) {
  await db.run('UPDATE content_library SET active = ? WHERE id = ?', [active ? 1 : 0, Number(id)]);
  return getItem(id);
}

/** Absolute tracked posting link for an item: <base><link>?campaign=<code>. */
function trackedUrl(item, baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const link = String(item.link || OFFER_LINKS[item.offer] || '/lead');
  const sep = link.includes('?') ? '&' : '?';
  return `${base}${link}${sep}campaign=${encodeURIComponent(item.campaign_code)}`;
}

/**
 * Attribute a lead to the library item whose campaign code they came in on.
 * Called from lead capture; safe to call for any campaign (no-ops unknown).
 */
async function recordAttribution(leadId, campaign) {
  try {
    if (!leadId || !campaign) return null;
    const item = await getByCampaign(campaign);
    if (!item) return null;
    await db.run(
      'INSERT OR IGNORE INTO content_attribution (content_id, lead_id, created_at) VALUES (?, ?, ?)',
      [item.id, Number(leadId), Date.now()]
    );
    return item;
  } catch (e) {
    return null;
  }
}

/** { leads, customers } produced by one library item. */
async function itemStats(contentId) {
  const leads = await db.get(
    'SELECT COUNT(*) c FROM content_attribution WHERE content_id = ?', [Number(contentId)]
  );
  const customers = await db.get(
    `SELECT COUNT(*) c FROM content_attribution a
     JOIN leads l ON l.id = a.lead_id
     WHERE a.content_id = ? AND l.status = 'customer'`,
    [Number(contentId)]
  );
  return { leads: (leads && leads.c) || 0, customers: (customers && customers.c) || 0 };
}

function oldestFirst(a, b) {
  const ta = a.last_suggested_at == null ? -1 : Number(a.last_suggested_at);
  const tb = b.last_suggested_at == null ? -1 : Number(b.last_suggested_at);
  if (ta !== tb) return ta - tb;
  return Number(a.id) - Number(b.id);
}

/**
 * "What should I post today?" — picks the most-due item per cadence and
 * returns { primary, alsoDue }. Marks the primary as suggested so content
 * rotates instead of repeating.
 */
async function suggestToday(now = Date.now(), followUpsDue = 0) {
  const items = await listItems(true);
  const byCadence = { 'daily': [], '2-3x-week': [], 'weekly': [], 'follow-up': [] };
  for (const it of items) {
    if (byCadence[it.cadence]) byCadence[it.cadence].push(it);
  }
  const picks = {};
  if (byCadence['daily'].length) {
    picks.daily = byCadence['daily'].slice().sort(oldestFirst)[0];
  }
  const wd = chicagoWeekday(now);
  if (byCadence['2-3x-week'].length && (wd === 'Mon' || wd === 'Wed' || wd === 'Fri')) {
    picks.midweek = byCadence['2-3x-week'].slice().sort(oldestFirst)[0];
  }
  const weekMs = 7 * 24 * 3600 * 1000;
  const weeklyDue = byCadence['weekly'].filter(
    (it) => it.last_suggested_at == null || now - Number(it.last_suggested_at) >= weekMs
  );
  if (weeklyDue.length) {
    picks.weekly = weeklyDue.sort(oldestFirst)[0];
  }
  if (followUpsDue > 0 && byCadence['follow-up'].length) {
    picks.followup = byCadence['follow-up'].slice().sort(oldestFirst)[0];
  }
  // Priority: follow-up first (people waiting beat new posts), then daily.
  const primary = picks.followup || picks.daily || picks.midweek || picks.weekly || null;
  const alsoDue = Object.values(picks).filter((p) => p && (!primary || p.id !== primary.id));
  if (primary) {
    await db.run(
      'UPDATE content_library SET times_suggested = times_suggested + 1, last_suggested_at = ? WHERE id = ?',
      [now, primary.id]
    );
    primary.times_suggested = Number(primary.times_suggested || 0) + 1;
    primary.last_suggested_at = now;
  }
  return { primary, alsoDue, weekday: wd };
}

// --- Seed: Davena's existing content, one starter item per offer -----------
async function ensureSeeded() {
  const count = await db.get('SELECT COUNT(*) c FROM content_library');
  if (count && count.c > 0) return;
  const now = Date.now();
  const seeds = [
    {
      offer: 'room', title: 'Ideas → Income', kind: 'message', cadence: 'daily',
      body: "Got ideas but haven't turned them into income yet? That's exactly why I created the Wealth Builder's Room. We're building from mindset → money → assets → ownership. Join for $49/month and let's stop collecting ideas and start building.",
      flyer_path: null, where_to_post: 'Facebook, Instagram',
      campaign_code: 'room-ideas-income', link: '/room/start',
    },
    {
      offer: 'dispatch', title: 'Dispatch Services — Basic $50 / Complete $100', kind: 'flyer', cadence: '2-3x-week',
      body: "Driving but tired of hunting your own loads? TransitNow Dispatch handles the back office for you. Basic $50/month: full onboarding, dispatch setup, 2 route matches every Monday, weekly goal tracker, ongoing support. Complete $100/month: everything in Basic plus 5 matches on day one, weekly refills, priority matching, load-search prep, broker verification guidance, paperwork, route planning, and communication setup. Real opportunities in your city — potential matches, never guaranteed.",
      flyer_path: '/content/dispatch-flyer.png', where_to_post: 'Facebook, Instagram',
      campaign_code: 'dispatch-flyer', link: '/dispatch',
    },
    {
      offer: 'courier', title: 'Courier routes & RSP opportunities', kind: 'flyer', cadence: 'weekly',
      body: "Milwaukee drivers — courier routes and RSP opportunities are moving right now. Got a reliable vehicle and want consistent route work? Apply and let's see what fits. These are potential matches; I never guarantee routes, but I do the legwork to find them.",
      flyer_path: '/content/transitnow-courier-routes-flyer.pdf', where_to_post: 'Facebook, Instagram',
      campaign_code: 'courier-routes', link: '/grow/apply',
    },
    {
      offer: 'business', title: 'Business & funding help', kind: 'message', cadence: 'weekly',
      body: "Trying to get your business funded or structured the right way? I help everyday people turn ideas into real businesses — entity setup, funding direction, and a plan you can actually follow. If you're serious about building, let's talk about what you're working on.",
      flyer_path: null, where_to_post: 'Facebook, Instagram',
      campaign_code: 'business-funding', link: '/business',
    },
    {
      offer: 'remote', title: 'Remote-work opportunities', kind: 'message', cadence: '2-3x-week',
      body: "Want to earn from home but don't know where the real opportunities are? I share legitimate remote-work options and help you get positioned for them — no scams, no fluff. Tell me what you're looking for and let's see what's real right now.",
      flyer_path: null, where_to_post: 'Facebook, Instagram',
      campaign_code: 'remote-work', link: '/lead',
    },
  ];
  for (const s of seeds) {
    await db.run(
      `INSERT INTO content_library
         (offer, title, kind, body, flyer_path, cadence, cta, where_to_post,
          campaign_code, link, active, times_suggested, last_suggested_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?)`,
      [s.offer, s.title, s.kind, s.body, s.flyer_path, s.cadence, DEFAULT_CTA,
       s.where_to_post, s.campaign_code, s.link, now]
    );
  }
  console.log('[content] seeded 5 library items (one per offer)');
}

module.exports = {
  OFFERS, CADENCES, KINDS, DEFAULT_CTA, OFFER_LINKS,
  listItems, getItem, getByCampaign, createItem, updateItem, setActive,
  trackedUrl, recordAttribution, itemStats, suggestToday, ensureSeeded,
};
