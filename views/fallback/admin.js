'use strict';
/**
 * FALLBACK views — views/fallback/admin.js
 *
 * Used only when views/admin.js (written by the views agent) is missing or
 * fails to load. Accepts the SAME data shapes the real views accept:
 *   adminLayout(title, bodyHtml),
 *   dashboardHtml(metrics, site)   — metrics: {visitors, leads, checkouts,
 *                                    customers, upsellCustomers, repeatCustomers}
 *   leadsTableHtml(leads, query)   — leads: [{id, first_name, email, phone,
 *                                    source, campaign, consent, created_at}],
 *                                    query: {q}
 *   cartsTableHtml(carts)          — carts: [{id, lead_id, product_id, status,
 *                                    checkout_url, abandoned_at}]
 *   emailsTableHtml(queue)         — queue: [{id, lead_id, sequence, step_id,
 *                                    subject, scheduled_at, sent_at, status}]
 *   outboxHtml(items)              — items: [{id, to, subject, created_at,
 *                                    status, error, file}]
 *   suppressionsHtml(list)         — list: [{email, reason, created_at}]
 *   configEditorHtml(products, emails, site)
 *
 * Admin auth is a ?token= query param (checked server-side). A small script
 * re-appends the current ?token= to every /admin link and form so navigation
 * keeps working when only the query token was used.
 */
const { esc } = require('./layout');

function adminLayout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Funnel Admin</title>
<link rel="stylesheet" href="/style.css">
<style>
.admin-nav{display:flex;gap:.4em;flex-wrap:wrap;margin:1em 0}
.admin-nav a{padding:.4em .8em;background:#eee;border-radius:4px;text-decoration:none;color:#222}
table.admin{border-collapse:collapse;width:100%;font-size:13px}
table.admin th,table.admin td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
table.admin th{background:#f4f4f4}
.funnel-bar{background:#e8e8e8;border-radius:4px;height:26px;margin:6px 0;position:relative}
.funnel-bar > div{background:#2a7ae2;height:26px;border-radius:4px}
.funnel-bar span{position:absolute;left:8px;top:4px;font-size:12px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.4)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:1em 0}
.stat{background:#f8f8f8;border:1px solid #e2e2e2;border-radius:6px;padding:10px}
.stat b{display:block;font-size:22px}
.stat small{color:#666}
textarea.config{width:100%;min-height:280px;font-family:monospace;font-size:12px}
</style>
</head>
<body>
<header class="site-header"><div class="wrap"><span class="brand">Funnel Admin</span></div></header>
<main class="wrap">
<nav class="admin-nav">
  <a href="/admin">Dashboard</a>
  <a href="/admin/leads">Leads</a>
  <a href="/admin/carts">Carts</a>
  <a href="/admin/emails">Emails</a>
  <a href="/admin/outbox">Outbox</a>
  <a href="/admin/suppressions">Suppressions</a>
  <a href="/admin/config">Config</a>
</nav>
<h1>${esc(title)}</h1>
${bodyHtml || ''}
</main>
<script>
// Fallback-only helper: keep ?token= on admin links & forms.
(function () {
  var m = /[?&]token=([^&]+)/.exec(location.search);
  if (!m) return;
  var tok = 'token=' + m[1];
  document.querySelectorAll('a[href^="/admin"]').forEach(function (a) {
    var h = a.getAttribute('href');
    a.setAttribute('href', h + (h.indexOf('?') >= 0 ? '&' : '?') + tok);
  });
  document.querySelectorAll('form[action^="/admin"]').forEach(function (f) {
    var act = f.getAttribute('action');
    f.setAttribute('action', act + (act.indexOf('?') >= 0 ? '&' : '?') + tok);
  });
})();
</script>
</body>
</html>`;
}

function dashboardHtml(m, site) {
  m = m || {};
  const stages = [
    ['Visitors', m.visitors || 0],
    ['Leads', m.leads || 0],
    ['Checkouts', m.checkouts || 0],
    ['Customers', m.customers || 0],
    ['Upsell customers', m.upsellCustomers || 0],
    ['Repeat customers', m.repeatCustomers || 0],
  ];
  const max = Math.max(1, ...stages.map(([, n]) => n));
  const bars = stages
    .map(
      ([label, n]) => `<div><strong>${esc(label)}:</strong> ${n}
      <div class="funnel-bar"><div style="width:${Math.max(2, Math.round((n / max) * 100))}%"></div><span>${n}</span></div></div>`
    )
    .join('');
  const body = `
    <p>Business: <strong>${esc((site || {}).businessName || '')}</strong> &middot; Payment mode: <strong>${esc((site || {}).paymentMode || '')}</strong></p>
    <h2>Funnel</h2>${bars}
    <h2>Tools</h2>
    <form method="POST" action="/admin/run-scheduler" style="display:inline">
      <button type="submit">Run scheduler pass now</button>
    </form>
    <h3>Mark paid (manual purchase)</h3>
    <form method="POST" action="/admin/mark-paid" class="form">
      <label>Lead email <input type="email" name="email"></label>
      <label>&hellip;or lead ID <input type="text" name="lead_id"></label>
      <label>Product ID <input type="text" name="product_id" required></label>
      <button type="submit">Record manual purchase</button>
    </form>`;
  return body; // server.js wraps page fns with adminLayout() (same as real views)
}

function leadsTableHtml(leads, query) {
  const q = (query || {}).q || '';
  const rows = (Array.isArray(leads) ? leads : [])
    .map(
      (l) => `<tr><td>${l.id}</td><td>${esc(l.first_name)}</td><td>${esc(l.email)}</td>
        <td>${esc(l.phone)}</td><td>${esc(l.source)}</td><td>${esc(l.campaign)}</td>
        <td>${l.consent ? 'yes' : 'no'}</td><td>${esc(l.created_at)}</td></tr>`
    )
    .join('');
  const body = `
    <form method="GET" action="/admin/leads" class="form" style="max-width:420px">
      <label>Search <input type="text" name="q" value="${esc(q)}" placeholder="name, email, phone"></label>
      <button type="submit">Search</button>
    </form>
    <table class="admin">
      <tr><th>ID</th><th>First name</th><th>Email</th><th>Phone</th><th>Source</th><th>Campaign</th><th>Consent</th><th>Created</th></tr>
      ${rows || '<tr><td colspan="8">No leads yet.</td></tr>'}
    </table>`;
  return body; // server.js wraps page fns with adminLayout() (same as real views)
}

function cartsTableHtml(carts) {
  const rows = (Array.isArray(carts) ? carts : [])
    .map(
      (c) => `<tr><td>${c.id}</td><td>${esc(c.lead_id)}</td><td>${esc(c.product_id)}</td>
        <td>${esc(c.status)}</td><td>${esc(c.checkout_url)}</td><td>${esc(c.abandoned_at)}</td></tr>`
    )
    .join('');
  const body = `<table class="admin">
      <tr><th>ID</th><th>Lead</th><th>Product</th><th>Status</th><th>Checkout URL</th><th>Last update</th></tr>
      ${rows || '<tr><td colspan="6">No carts yet.</td></tr>'}
    </table>`;
  return body; // server.js wraps page fns with adminLayout() (same as real views)
}

function emailsTableHtml(queue) {
  const rows = (Array.isArray(queue) ? queue : [])
    .map(
      (e) => `<tr><td>${e.id}</td><td>${esc(e.lead_id)}</td><td>${esc(e.sequence)}</td>
        <td>${esc(e.step_id)}</td><td>${esc((e.subject || '').slice(0, 80))}</td>
        <td>${esc(e.scheduled_at)}</td><td>${esc(e.sent_at)}</td><td>${esc(e.status)}</td></tr>`
    )
    .join('');
  const body = `<table class="admin">
      <tr><th>ID</th><th>Lead</th><th>Sequence</th><th>Step</th><th>Subject</th><th>Scheduled</th><th>Sent</th><th>Status</th></tr>
      ${rows || '<tr><td colspan="8">Queue is empty.</td></tr>'}
    </table>`;
  return body; // server.js wraps page fns with adminLayout() (same as real views)
}

function outboxHtml(items) {
  const rows = (Array.isArray(items) ? items : [])
    .map(
      (o) => `<tr><td>${o.file ? `<a href="/admin/outbox?file=${encodeURIComponent(o.file)}">${esc(o.file)}</a>` : esc(o.id)}</td>
        <td>${esc(o.to)}</td><td>${esc(o.subject)}</td><td>${esc(o.created_at)}</td>
        <td>${esc(o.status)}</td><td>${esc(o.error)}</td></tr>`
    )
    .join('');
  const body = `<table class="admin">
      <tr><th>File</th><th>To</th><th>Subject</th><th>Created</th><th>Status</th><th>Error</th></tr>
      ${rows || '<tr><td colspan="6">Outbox is empty.</td></tr>'}
    </table>`;
  return body; // server.js wraps page fns with adminLayout() (same as real views)
}

function suppressionsHtml(list) {
  const rows = (Array.isArray(list) ? list : [])
    .map(
      (s) => `<tr><td>${esc(s.email)}</td><td>${esc(s.reason || '')}</td><td>${esc(s.created_at)}</td>
        <td><form method="POST" action="/admin/suppressions/remove" style="display:inline">
          <input type="hidden" name="email" value="${esc(s.email)}"><button type="submit">Remove</button>
        </form></td></tr>`
    )
    .join('');
  const body = `
    <form method="POST" action="/admin/suppressions/add" class="form" style="max-width:420px">
      <label>Email <input type="email" name="email" required></label>
      <label>Reason <input type="text" name="reason" placeholder="manual"></label>
      <button type="submit">Add suppression</button>
    </form>
    <table class="admin">
      <tr><th>Email</th><th>Reason</th><th>Added</th><th></th></tr>
      ${rows || '<tr><td colspan="4">No suppressions.</td></tr>'}
    </table>`;
  return body; // server.js wraps page fns with adminLayout() (same as real views)
}

function configEditorHtml(products, emails, site) {
  const ta = (name, obj) => `
    <h2>config/${name}.json</h2>
    <form method="POST" action="/admin/config/${name}">
      <textarea class="config" name="json">${esc(JSON.stringify(obj, null, 2))}</textarea>
      <p><button type="submit">Save ${name}.json</button></p>
    </form>`;
  const body = `<p>Edits are validated as JSON before saving and take effect on the next request (no restart needed).</p>
    ${ta('products', products)}${ta('emails', emails)}${ta('site', site)}`;
  return body; // server.js wraps page fns with adminLayout() (same as real views)
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
