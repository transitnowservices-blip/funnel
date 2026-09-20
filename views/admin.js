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
  <a href="/admin/drivers">Drivers</a>
  <a href="/admin/routes">Routes</a>
  <a href="/admin/exceptions">Exceptions</a>
  <a href="/admin/tickets">Support</a>
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
