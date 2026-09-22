// Admin view helpers. Simple semantic HTML; the backend wires these into
// /admin routes and supplies real data. No backend logic here.
'use strict';

// Content-library metadata (offers, cadences, kinds, tracked-URL builder).
// lib/content.js only pulls in lib/db + lib/config — no cycle with views.
let contentOffers = {}, contentCadences = {}, contentKinds = {}, contentTrackedUrl = null;
try {
  const _content = require('../lib/content');
  contentOffers = _content.OFFERS;
  contentCadences = _content.CADENCES;
  contentKinds = _content.KINDS;
  contentTrackedUrl = _content.trackedUrl;
} catch (e) { /* library unavailable — pages render without it */ }

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
  <a href="/admin/content">Content</a>
  <a href="/admin/crm">CRM</a>
  <a href="/admin/carts">Carts</a>
  <a href="/admin/emails">Emails</a>
  <a href="/admin/outbox">Outbox</a>
  <a href="/admin/suppressions">Suppressions</a>
  <a href="/admin/room">Room</a>
  <a href="/admin/drivers">Drivers</a>
  <a href="/admin/opportunities">Opportunities</a>
  <a href="/admin/contracts">Contracts</a>
  <a href="/admin/territories">Territories</a>
  <a href="/admin/routes">Routes</a>
  <a href="/admin/exceptions">Exceptions</a>
  <a href="/admin/tickets">Support</a>
  <a href="/dispatch/field-comms">Field comms</a>
  <a href="/dispatch/today">Daily board</a>
  <a href="/admin/dispatchers">Dispatchers</a>
  <a href="/admin/community">Community</a>
  <a href="/admin/plans">Plans</a>
  <a href="/admin/operations">Operations</a>
  <a href="/admin/reports">Reports</a>
  <a href="/admin/audit">Audit</a>
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

function followUpTableHtml(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const stageName = (r) => ({ 1: 'NEW', 2: 'CONTACTED', 3: 'INTERESTED' }[r] || '');
  const rows = list.map(l => {
    const waitingDays = Math.max(0, Math.floor((Date.now() - Number(l.date_captured || Date.now())) / 86400000));
    return [l.first_name, l.email, l.phone, l.goal, stageName(Number(l.stage_rank)), `${waitingDays}d`, l.last_touch ? fmtTsLocal(l.last_touch) : '—'];
  });
  return `<h2>Needs personal follow-up</h2>` +
    `<p>Room leads who have not responded or moved forward yet — oldest first. Reach out personally.</p>` +
    table(['Name', 'Email', 'Phone', 'Building', 'Stage', 'Waiting', 'Last email'], rows);
}

function fmtTsLocal(ts) {
  try { return new Date(Number(ts)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  catch (e) { return ''; }
}

function contentSuggestionHtml(suggestion, baseUrl, token) {
  if (!suggestion || !suggestion.primary) {
    return `<h2>What should I post today?</h2><p>No content is due right now. Add items to the library below and mark their cadence.</p>`;
  }
  const p = suggestion.primary;
  const offerName = (typeof contentOffers !== 'undefined' && contentOffers[p.offer]) || p.offer;
  const flyer = p.flyer_path
    ? (/\.(png|jpe?g|gif|webp)$/i.test(p.flyer_path)
        ? `<img src="${esc(p.flyer_path)}" alt="flyer" style="max-width:320px;border:1px solid #ccc;border-radius:8px">`
        : `<p><a href="${esc(p.flyer_path)}" target="_blank">View flyer</a></p>`)
    : '';
  const link = (typeof contentTrackedUrl === 'function')
    ? contentTrackedUrl(p, baseUrl)
    : `${esc(baseUrl)}${esc(p.link)}?campaign=${esc(p.campaign_code)}`;
  const also = (suggestion.alsoDue || []).map(a =>
    `<li><strong>${esc(a.title)}</strong> — ${esc((typeof contentCadences !== 'undefined' && contentCadences[a.cadence]) || a.cadence)}</li>`
  ).join('');
  return `<h2>What should I post today?</h2>
  <div style="border:2px solid #1F3A5F;border-radius:10px;padding:16px;margin:12px 0;background:#f8fafc">
    <p style="margin:0 0 4px"><strong>${esc(offerName)}</strong> · ${esc((typeof contentCadences !== 'undefined' && contentCadences[p.cadence]) || p.cadence)}</p>
    <h3 style="margin:4px 0">${esc(p.title)}</h3>
    ${flyer}
    <p><strong>Caption / message:</strong></p>
    <p style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:10px">${esc(p.body || '')}</p>
    <p><strong>CTA:</strong> ${esc(p.cta || '')}</p>
    <p><strong>Where to post:</strong> ${esc(p.where_to_post || '—')}</p>
    <p><strong>Tracked link (post this exact link):</strong><br>
    <input type="text" readonly value="${esc(link)}" onclick="this.select()" style="width:100%;min-height:40px"></p>
  </div>
  ${also ? `<p><strong>Also due:</strong></p><ul>${also}</ul>` : ''}`;
}

function contentLibraryTableHtml(items, statsById, baseUrl, token) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '<p>No content yet. Add your first flyer or message below.</p>';
  const groups = {};
  for (const it of list) { (groups[it.offer] = groups[it.offer] || []).push(it); }
  let html = '';
  for (const offer of Object.keys(groups)) {
    const offerName = (typeof contentOffers !== 'undefined' && contentOffers[offer]) || offer;
    const rows = groups[offer].map(it => {
      const st = (statsById && statsById[it.id]) || { leads: 0, customers: 0 };
      const toggleLabel = it.active ? 'Deactivate' : 'Activate';
      return `<tr>
        <td>${esc(it.title)}<br><small>${esc(it.kind)} · code: <code>${esc(it.campaign_code)}</code></small></td>
        <td>${esc((typeof contentCadences !== 'undefined' && contentCadences[it.cadence]) || it.cadence)}</td>
        <td>${st.leads}</td>
        <td>${st.customers}</td>
        <td>${it.times_suggested || 0}×</td>
        <td>${it.active ? 'yes' : 'no'}</td>
        <td>
          <a href="/admin/content/${it.id}/edit?token=${esc(token)}">Edit</a> ·
          <form method="POST" action="/admin/content/${it.id}/toggle?token=${esc(token)}" style="display:inline">
            <button type="submit">${toggleLabel}</button>
          </form>
        </td>
      </tr>`;
    }).join('');
    html += `<h3>${esc(offerName)}</h3>` +
      `<table class="admin-table"><thead><tr><th>Item</th><th>Cadence</th><th>Leads</th><th>Customers</th><th>Suggested</th><th>Active</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  return html;
}

function contentFormHtml(item, offers, cadences, kinds, token) {
  const it = item || {};
  const isEdit = !!(item && item.id);
  const action = isEdit ? `/admin/content/${it.id}?token=${esc(token)}` : `/admin/content/add?token=${esc(token)}`;
  const opt = (map, cur) => Object.keys(map).map(k =>
    `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(map[k])}</option>`).join('');
  return `<h2>${isEdit ? 'Edit content item' : 'Add flyer / message'}</h2>
  <form method="POST" action="${action}" style="max-width:640px">
    <p><label>Offer<br><select name="offer">${opt(offers, it.offer || 'room')}</select></label></p>
    <p><label>Title<br><input type="text" name="title" value="${esc(it.title || '')}" style="width:100%"></label></p>
    <p><label>Type<br><select name="kind">${opt(kinds, it.kind || 'message')}</select></label></p>
    <p><label>Caption / message<br><textarea name="body" rows="5" style="width:100%">${esc(it.body || '')}</textarea></label></p>
    <p><label>Flyer file path (e.g. /content/dispatch-flyer.png — optional)<br><input type="text" name="flyer_path" value="${esc(it.flyer_path || '')}" style="width:100%"></label></p>
    <p><label>How often<br><select name="cadence">${opt(cadences, it.cadence || 'weekly')}</select></label></p>
    <p><label>CTA<br><input type="text" name="cta" value="${esc(it.cta || '')}" style="width:100%"></label></p>
    <p><label>Where to post<br><input type="text" name="where_to_post" value="${esc(it.where_to_post || '')}" style="width:100%"></label></p>
    <p><label>Destination link<br><input type="text" name="link" value="${esc(it.link || '')}" style="width:100%"></label></p>
    <p><label>Campaign code (goes in the tracked link)<br><input type="text" name="campaign_code" value="${esc(it.campaign_code || '')}" style="width:100%"></label></p>
    <p><button type="submit">${isEdit ? 'Save changes' : 'Add to library'}</button>
    ${isEdit ? ` <a href="/admin/content?token=${esc(token)}">Cancel</a>` : ''}</p>
  </form>`;
}

function contentPageHtml(opts) {
  const { suggestion, items, statsById, baseUrl, token } = opts || {};
  return contentSuggestionHtml(suggestion, baseUrl, token) +
    `<h2>Content library</h2>
     <p>Leads and customers are counted from the tracked <code>?campaign=</code> links. Post the exact tracked link shown above so results attribute correctly.</p>` +
    contentLibraryTableHtml(items, statsById, baseUrl, token) +
    contentFormHtml(null,
      (typeof contentOffers !== 'undefined' ? contentOffers : {}),
      (typeof contentCadences !== 'undefined' ? contentCadences : {}),
      (typeof contentKinds !== 'undefined' ? contentKinds : {}), token);
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
    e.id, e.lead_id, e.to || '', e.sequence, e.step_id, e.subject,
    e.body_preview || '',
    e.scheduled_at, e.sent_at || 'pending', e.status,
  ]);
  return `<p>${list.length} queued/sent email(s)</p>` +
    table(['ID', 'Lead', 'To', 'Sequence', 'Step', 'Subject', 'Body preview', 'Scheduled', 'Sent', 'Status'], rows);
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
  ['Follow-ups due', mm.followUpsDue],
  ['Offers sent', mm.offersSent],
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
  ['Room revenue', money(mm.roomRevenue)],
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
  followUpTableHtml,
  contentPageHtml,
  contentFormHtml,
  cartsTableHtml,
  emailsTableHtml,
  outboxHtml,
  suppressionsHtml,
  configEditorHtml,
  dashboardSectionsHtml,
  leadDetailHtml,
  configEnvHtml,
};
