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
<p class="microcopy">Read-only view. Edit <code>config/products.json</code>, <code>config/emails.json</code>, and <code>config/site.json</code> directly, then restart the server.</p>
${section('config/site.json', site || {})}
${section('config/products.json', products || {})}
${section('config/emails.json', emails || {})}`;
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
};
