'use strict';
/**
 * views/command.js — Phase 3: operations command center (spec section 21).
 * Renders inside views/admin.js adminLayout by the backend, on top of the
 * existing Phase-L operations dashboard at GET /admin/operations.
 *
 * All numbers come from live tables via lib/command.js. The live-video card
 * counts sessions genuinely in LIVE status and is never faked; the card note
 * states plainly that video media requires a connected provider.
 */
const { esc } = require('./layout');
const command = require('../lib/command');

function metricCard(card) {
  const num = `<div class="num">${esc(String(card.value))}</div>`;
  const label = `<div class="label">${esc(card.label)}</div>`;
  const note = card.note ? `<div class="hint" style="margin-top:6px;font-size:11px;color:#555">${esc(card.note)}</div>` : '';
  const inner = `${num}${label}${note}`;
  return card.href
    ? `<a class="metric-card" data-metric="${esc(card.key)}" href="${esc(card.href)}">${inner}</a>`
    : `<div class="metric-card" data-metric="${esc(card.key)}">${inner}</div>`;
}

function opt(value, label, selected) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

function filterFormHtml({ f, options }) {
  const tOpts = (options.territories || []).map((t) =>
    opt(t.name, `${t.name}${t.city ? ` — ${t.city}, ${t.state || ''}` : ''}`, f.territoryName === t.name)).join('');
  const dOpts = (options.drivers || []).map((d) =>
    opt(String(d.id), `#${d.id} ${d.full_name}`, String(f.driverId) === String(d.id))).join('');
  const rOpts = (options.routes || []).map((r) =>
    opt(String(r.id), `${r.route_code}${r.title ? ` — ${r.title}` : ''}`, String(f.routeId) === String(r.id))).join('');
  const cOpts = (options.contracts || []).map((c) =>
    opt(c.contract_number, `${c.contract_number} — ${c.contract_name}`, f.contractNumber === c.contract_number)).join('');
  const statusVal = esc(f.status || '');
  return `
<div class="card">
  <h3>Filters</h3>
  <form method="GET" action="/admin/operations" class="filter-form">
    <label>Territory
      <select name="territory"><option value="">— all —</option>${tOpts}</select>
    </label>
    <label>Date
      <input type="date" name="date" value="${f.windowGiven && f.from ? new Date(f.from).toISOString().slice(0, 10) : ''}">
    </label>
    <label>Contract
      <select name="contract"><option value="">— all —</option>${cOpts}</select>
    </label>
    <label>Driver
      <select name="driver"><option value="">— all —</option>${dOpts}</select>
    </label>
    <label>Route
      <select name="route"><option value="">— all —</option>${rOpts}</select>
    </label>
    <label>Status
      <input type="text" name="status" value="${statusVal}" placeholder="e.g. active, delivered">
    </label>
    <button type="submit" class="btn btn-small">Apply</button>
    <a class="btn btn-small" href="/admin/operations">Clear</a>
  </form>
  <p class="microcopy">
    State metrics (routes, drivers, packages in transit / remaining, exceptions, support, opportunities, alerts, follow-ups due, community reports, plan requests) are
    <strong>current as of now</strong> — the app keeps no "as of" history for them, so they are not back-dated.
    "New" and "delivered" metrics use the selected date window (${esc(f.windowLabel)}).
    The status filter applies per table (route / driver / package / exception / ticket / opportunity statuses).
    The contract filter does not apply to support tickets (tickets carry no contract column).
  </p>
</div>`;
}

function commandCenterHtml({ metrics, options }) {
  const { filters: f, cards } = metrics;
  const hasFilters = f.territoryName || f.contractNumber || f.driverId || f.routeId || f.status || f.windowGiven;
  const activeBits = [];
  if (f.territoryName) activeBits.push(`territory: ${f.territoryName}`);
  if (f.contractNumber) activeBits.push(`contract: ${f.contractNumber}`);
  if (f.driverId) activeBits.push(`driver: ${f.driver ? f.driver.full_name : '#' + f.driverId}`);
  if (f.routeId) activeBits.push(`route: ${f.route ? f.route.route_code : '#' + f.routeId}`);
  if (f.status) activeBits.push(`status: ${f.status}`);
  if (f.windowGiven) activeBits.push(`window: ${f.windowLabel}`);

  return `
<h2>Operations command center</h2>
<p class="microcopy">Today's operation at a glance — every number below is computed live from the real tables (routes, packages, drivers, exceptions, support tickets, leads, opportunities, alerts, follow-ups, community reports, plan requests).</p>
${filterFormHtml({ f, options })}
${hasFilters ? `<p class="microcopy"><strong>Filters active:</strong> ${esc(activeBits.join(' · '))}</p>` : ''}
<div class="metric-cards">
  ${cards.map(metricCard).join('')}
</div>
<p class="microcopy">${esc(command.VIDEO_SESSIONS_NOTE)}</p>`;
}

module.exports = {
  commandCenterHtml,
};
