'use strict';
/**
 * views/driver-admin.js — admin pages for the TransitNow driver pipeline
 * (Phase B). Rendered inside views/admin.js adminLayout by the backend.
 * No income or results promises anywhere in this copy.
 */
const { esc } = require('./layout');
const drivers = require('../lib/drivers');

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString();
}

function statusBadge(status) {
  const label = drivers.STATUS_LABELS[status] || status;
  return `<span class="status-badge status-${esc(status)}">${esc(label)}</span>`;
}

// Paid-client enforcement: subscription badge for driver/lead rows.
// Green = active subscriber (dispatch work allowed); amber = payment failed;
// gray = canceled; muted dash = no subscription on file.
function subscriptionBadge(sub) {
  if (!sub) return '<span class="muted">—</span>';
  if (sub.status === 'active') {
    const plan = sub.plan === 'basic' ? 'Basic $50/mo' : sub.plan === 'complete' ? 'Complete $100/mo' : sub.plan;
    return `<span class="status-badge" style="background:#1c7a3d;color:#fff">PAID · ${esc(plan)}</span>`;
  }
  if (sub.status === 'past_due') {
    return `<span class="status-badge" style="background:#b97b0e;color:#fff">PAYMENT FAILED</span>`;
  }
  if (sub.status === 'canceled') {
    return `<span class="status-badge" style="background:#777;color:#fff">Canceled</span>`;
  }
  return `<span class="status-badge" style="background:#999;color:#fff">${esc(sub.status)}</span>`;
}

function subForEmail(subsByEmail, email) {
  if (!subsByEmail) return null;
  return subsByEmail[String(email || '').toLowerCase()] || null;
}

function kv(label, value) {
  if (value == null || value === '') return '';
  return `<div><strong>${esc(label)}:</strong> ${esc(value)}</div>`;
}

// --- Pipeline list ------------------------------------------------------------
function driverPipelineHtml({ list, counts, status, source, q, subsByEmail, paid, paidCounts }) {
  const tabs = drivers.DRIVER_STATUSES.map((s) => {
    const active = status === s ? ' class="active"' : '';
    const href = `/admin/drivers?status=${s}${source ? `&source=${encodeURIComponent(source)}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    return `<a${active} href="${href}">${esc(drivers.STATUS_LABELS[s])} (${counts[s] || 0})</a>`;
  }).join('');
  const allActive = !status ? ' class="active"' : '';
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const srcOpts = drivers.SOURCES.map(
    (s) => `<option value="${s}"${source === s ? ' selected' : ''}>${esc(drivers.SOURCE_LABELS[s])}</option>`
  ).join('');
  const pc = paidCounts || {};
  const paidTab = `<a${paid === 'paid' ? ' class="active"' : ''} href="/admin/drivers?paid=paid">Paid clients (${pc.active || 0})</a>`;
  const attentionTab = `<a${paid === 'attention' ? ' class="active"' : ''} href="/admin/drivers?paid=attention">Needs attention (${pc.past_due || 0})</a>`;

  const rows = list.map((d) => {
    const work = (d.work_prefs || []).map((w) => drivers.WORK_PREF_LABELS[w] || w).join(', ');
    return `<tr>
      <td><a href="/admin/drivers/${d.id}"><strong>${esc(d.full_name)}</strong></a><br><span class="muted">${esc(d.email)}<br>${esc(d.phone || '')}</span></td>
      <td>${esc(d.business_name || '—')}<br><span class="muted">${esc(d.mc_number ? 'MC ' + d.mc_number : '')} ${esc(d.dot_number ? 'DOT ' + d.dot_number : '')}</span></td>
      <td>${esc([d.vehicle_year, d.vehicle_make_model, d.vehicle_type].filter(Boolean).join(' ') || '—')}</td>
      <td>${esc([d.home_city, d.home_state].filter(Boolean).join(', ') || '—')}<br><span class="muted">${esc(d.service_radius ? 'Radius: ' + d.service_radius : '')}</span></td>
      <td>${esc((d.days_available || []).join(', ') || '—')}<br><span class="muted">${esc(d.hours_available || '')}</span></td>
      <td>${esc(work || '—')}</td>
      <td>${esc(drivers.SOURCE_LABELS[d.source] || d.source || '—')}</td>
      <td>${statusBadge(d.status)}</td>
      <td>${subscriptionBadge(subForEmail(subsByEmail, d.email))}</td>
      <td>${fmtTs(d.submitted_at)}</td>
      <td>${fmtTs(d.last_contact)}</td>
    </tr>`;
  }).join('');

  return `
<h2>Driver Pipeline</h2>
<div class="pipeline-nav"><a${allActive} href="/admin/drivers">All (${total})</a>${tabs} | ${paidTab} ${attentionTab}</div>
<form method="GET" action="/admin/drivers" class="filter-form">
  ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}
  ${paid ? `<input type="hidden" name="paid" value="${esc(paid)}">` : ''}
  <select name="source"><option value="">All sources</option>${srcOpts}</select>
  <input type="text" name="q" placeholder="Search name, email, phone" value="${esc(q || '')}">
  <button type="submit" class="btn">Filter</button>
</form>
<p>${list.length} driver(s) shown</p>
<table class="admin-table">
<thead><tr><th>Driver</th><th>Business</th><th>Vehicle</th><th>Location</th><th>Availability</th><th>Work requested</th><th>Source</th><th>Status</th><th>Subscription</th><th>Submitted</th><th>Last contact</th></tr></thead>
<tbody>${rows || '<tr><td colspan="11">No drivers match.</td></tr>'}</tbody>
</table>`;
}

// --- Driver detail --------------------------------------------------------------
// --- Tier-based route matches (dispatch plans) ---------------------------------
function routeMatchCardHtml({ driver: d, subscription, routeMatches = [], goal = null }) {
  const active = (routeMatches || []).filter((m) => m.status === 'assigned');
  const plan = subscription && subscription.status === 'active' ? subscription.plan : null;
  const quota = plan === 'complete' ? 5 : plan === 'basic' ? 2 : 0;
  const goalLine = goal && goal.goalCents > 0
    ? `<div><strong>Weekly goal (${esc(goal.weekKey)}):</strong> $${(goal.goalCents / 100).toFixed(2)} — driver-set target, tracked toward, never promised.</div>`
    : `<div class="muted">No weekly goal set for ${esc((goal && goal.weekKey) || 'this week')}.</div>
       <form method="POST" action="/admin/drivers/${d.id}/goal" class="form" style="margin-top:8px">
         <label>Set weekly goal ($)<input type="number" name="goal_dollars" min="0" step="1" placeholder="750" required></label>
         <button type="submit" class="btn">Set goal</button>
       </form>`;
  const rows = (routeMatches || []).map((m) => `<tr>
      <td>${esc(m.opportunity_name || ('#' + m.opportunity_id))}<br><span class="muted">${esc(m.opportunity_location || '')}</span></td>
      <td>${esc(m.tier || '')}</td>
      <td>${esc(m.status)}</td>
      <td class="ts">${fmtTs(m.matched_at)}</td>
      <td>${m.status === 'assigned'
        ? `<form method="POST" action="/admin/route-matches/${m.id}/release" style="display:inline"><button type="submit" class="btn btn-secondary">Release</button></form>`
        : `<span class="muted">${esc(m.release_reason || '')}</span>`}</td>
    </tr>`).join('');
  return `
  <div><strong>Active matches:</strong> ${active.length} of ${quota || '—'}${plan ? ` (${esc(plan)} tier)` : ''}</div>
  ${goalLine}
  <table class="admin-table" style="margin-top:10px">
    <thead><tr><th>Opportunity</th><th>Tier</th><th>Status</th><th>Matched</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No route matches yet.</td></tr>'}</tbody>
  </table>
  <p><a class="btn" href="/admin/route-matches?driver=${d.id}">Open route-match admin &rarr;</a></p>
  <p class="muted">Matches are potential opportunities only — never promised routes, loads, contracts, or income.</p>`;
}

function driverDetailHtml({ driver: d, history, subscription, routeMatches = [], goal = null }) {
  const statusOpts = drivers.DRIVER_STATUSES.map(
    (s) => `<option value="${s}"${d.status === s ? ' selected' : ''}>${esc(drivers.STATUS_LABELS[s])}</option>`
  ).join('');
  const subCard = (() => {
    if (!subscription) {
      return `<div class="card">
  <h3>Dispatch subscription</h3>
  <p>No dispatch subscription on file for ${esc(d.email)}. Dispatch work (routes, service-plan activation) requires an active Basic $50/month or Complete $100/month subscription.</p>
</div>`;
    }
    const plan = subscription.plan === 'basic' ? 'Basic $50/month' : subscription.plan === 'complete' ? 'Complete $100/month' : subscription.plan;
    const period = subscription.current_period_end ? fmtTs(subscription.current_period_end) : '—';
    const note = subscription.status === 'active'
      ? 'Dispatch work is allowed for this driver.'
      : 'Dispatch work is blocked until the subscription is active again.';
    return `<div class="card">
  <h3>Dispatch subscription ${subscriptionBadge(subscription)}</h3>
  <div><strong>Plan:</strong> ${esc(plan)}</div>
  <div><strong>Status:</strong> ${esc(subscription.status)}</div>
  <div><strong>Current period ends:</strong> ${esc(period)}</div>
  <p class="muted">${esc(note)}</p>
</div>`;
  })();
  const work = (d.work_prefs || []).map((w) => drivers.WORK_PREF_LABELS[w] || w).join(', ');
  const looking = (d.looking_for || []).map((w) => drivers.LOOKING_FOR_LABELS[w] || w).join(', ');
  const histRows = (history || [])
    .map(
      (h) =>
        `<li><strong>${esc(drivers.STATUS_LABELS[h.from_status] || '—')} → ${esc(drivers.STATUS_LABELS[h.to_status] || h.to_status)}</strong> <span class="ts">${fmtTs(h.ts)} · by ${esc(h.changed_by || 'system')}</span>${h.note ? `<br>${esc(h.note)}` : ''}</li>`
    )
    .join('');

  return `
<p><a href="/admin/drivers">&larr; Back to pipeline</a></p>
<h2>${esc(d.full_name)} ${statusBadge(d.status)}</h2>
<p class="muted">Onboarded ${fmtTs(d.submitted_at)} · Source: ${esc(drivers.SOURCE_LABELS[d.source] || d.source)} · <a href="${esc(drivers.driverDashUrl(d.access_token))}">Driver dashboard link</a></p>

${subCard}

<div class="card">
  <h3>Route matches (tier-based)</h3>
  ${routeMatchCardHtml({ driver: d, subscription, routeMatches, goal })}
</div>

<div class="card">
  <h3>Extended driver profile</h3>
  <p>Qualification checklist, application status (${esc(d.extended_status || 'not started')}), documents, routes, packages, exceptions, support tickets, training, and opportunity matches.</p>
  <p><a class="btn" href="/admin/drivers/${d.id}/profile">Open extended profile &rarr;</a></p>
</div>

<div class="card">
  <h3>Change status</h3>
  <form method="POST" action="/admin/drivers/${d.id}/status" class="form">
    <label>Status
      <select name="status">${statusOpts}</select>
    </label>
    <label>Note (optional)
      <input type="text" name="note" placeholder="Reason for the change">
    </label>
    <label class="checkbox"><input type="checkbox" name="notify" value="1" checked> Email the driver about this status change</label>
    <button type="submit" class="btn">Update status</button>
  </form>
</div>

<div class="card">
  <h3>Driver information</h3>
  ${kv('Email', d.email)}
  ${kv('Phone', d.phone)}
  ${kv('Preferred contact', d.contact_method)}
  <h3>Business</h3>
  ${kv('Business name', d.business_name)}
  ${kv('Entity type', d.entity_type)}
  ${kv('MC number', d.mc_number)}
  ${kv('DOT number', d.dot_number)}
  ${kv('Years in business', d.years_in_business)}
  <h3>Vehicle</h3>
  ${kv('Type', d.vehicle_type)}
  ${kv('Year', d.vehicle_year)}
  ${kv('Make / model', d.vehicle_make_model)}
  ${kv('Cargo dimensions', d.cargo_dimensions)}
  ${kv('Payload capacity', d.payload_capacity)}
  ${kv('Equipment', d.equipment)}
  ${kv('Insurance status', d.insurance_status)}
  <h3>Location</h3>
  ${kv('Home city', d.home_city)}
  ${kv('Home state', d.home_state)}
  ${kv('Service radius', d.service_radius)}
  ${kv('Travel regions', d.travel_regions)}
  <h3>Availability</h3>
  ${kv('Days', (d.days_available || []).join(', '))}
  ${kv('Hours', d.hours_available)}
  ${kv('Start date', d.start_date)}
  ${kv('Status', d.availability_status)}
  <h3>Work preferences</h3>
  ${kv('Preferences', work)}
  ${kv('Lane preferences', d.lane_prefs)}
  ${kv('Looking for', looking)}
</div>

<div class="card">
  <h3>Admin notes</h3>
  <form method="POST" action="/admin/drivers/${d.id}/note" class="form">
    <label>Add a note
      <textarea name="note" rows="3" required placeholder="Note for the team…"></textarea>
    </label>
    <button type="submit" class="btn">Add note</button>
  </form>
  <pre class="config-view">${esc(d.notes || 'No notes yet.')}</pre>
</div>

<div class="card">
  <h3>Status history</h3>
  <ul class="timeline">${histRows || '<li>No history.</li>'}</ul>
</div>`;
}

// --- Routes (Phase D) -----------------------------------------------------------
function routeStatusBadge(status) {
  const label = drivers.ROUTE_STATUS_LABELS[status] || status;
  return `<span class="status-badge status-${esc(status)}">${esc(label)}</span>`;
}

function packageStatusBadge(status) {
  const label = drivers.PACKAGE_STATUS_LABELS[status] || status;
  return `<span class="status-badge">${esc(label)}</span>`;
}

function routeListHtml({ routes, driversById }) {
  const rows = routes
    .map((r) => {
      const d = driversById[r.driver_id];
      return `<tr>
        <td><a href="/admin/routes/${r.id}"><strong>${esc(r.route_code)}</strong></a><br><span class="muted">${esc(r.title || '')}</span></td>
        <td>${d ? `<a href="/admin/drivers/${d.id}">${esc(d.full_name)}</a>` : '—'}</td>
        <td>${routeStatusBadge(r.status)}</td>
        <td>${esc(r.scheduled_date || '—')}</td>
        <td>${fmtTs(r.created_at)}</td>
      </tr>`;
    })
    .join('');
  return `
<h2>Routes</h2>
<p><a class="btn" href="/admin/routes/new">+ New route</a></p>
<table class="admin-table">
<thead><tr><th>Route</th><th>Driver</th><th>Status</th><th>Scheduled</th><th>Created</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">No routes yet.</td></tr>'}</tbody>
</table>`;
}

function routeNewHtml({ list, preselectDriverId }) {
  const opts = list
    .map((d) => `<option value="${d.id}"${String(d.id) === String(preselectDriverId) ? ' selected' : ''}>${esc(d.full_name)} — ${esc(d.email)}</option>`)
    .join('');
  return `
<h2>New route</h2>
<form method="POST" action="/admin/routes" class="form">
  <label>Driver *
    <select name="driver_id" required>${opts}</select>
  </label>
  <label>Route title *
    <input type="text" name="title" required placeholder="e.g. Milwaukee AM loop">
  </label>
  <label>Scheduled date
    <input type="date" name="scheduled_date">
  </label>
  <label>Notes
    <textarea name="notes" rows="3"></textarea>
  </label>
  <button type="submit" class="btn">Create route</button>
</form>`;
}

function routeDetailHtml({ route, driver, packages, counts, progress }) {
  const statusOpts = drivers.ROUTE_STATUSES.map(
    (s) => `<option value="${s}"${route.status === s ? ' selected' : ''}>${esc(drivers.ROUTE_STATUS_LABELS[s])}</option>`
  ).join('');
  const pkgRows = packages
    .map(
      (p) => `<tr>
        <td><a href="/admin/packages/${esc(p.package_id)}"><strong>${esc(p.package_id)}</strong></a></td>
        <td>${esc(p.recipient_name)}<br><span class="muted">${esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', '))}</span></td>
        <td>${packageStatusBadge(p.status)}</td>
      </tr>`
    )
    .join('');
  const countLine = Object.entries(counts)
    .map(([s, c]) => `${drivers.PACKAGE_STATUS_LABELS[s] || s}: ${c}`)
    .join(' · ');
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const progressHtml = progress ? `
<div class="card">
  <h3>Route progress</h3>
  <p><strong>${progress.done} of ${progress.total} packages complete</strong> (${progress.remaining} remaining)</p>
  <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
  <p class="muted">${esc(countLine)}</p>
</div>` : '';
  return `
<p><a href="/admin/routes">&larr; Back to routes</a></p>
<h2>${esc(route.route_code)} ${routeStatusBadge(route.status)}</h2>
<p class="muted">${esc(route.title || '')} · Driver: ${driver ? `<a href="/admin/drivers/${driver.id}">${esc(driver.full_name)}</a>` : '—'} · Scheduled: ${esc(route.scheduled_date || '—')}</p>
${progressHtml}

<div class="card">
  <h3>Change route status</h3>
  <form method="POST" action="/admin/routes/${route.id}/status" class="form">
    <label>Status <select name="status">${statusOpts}</select></label>
    <button type="submit" class="btn">Update</button>
  </form>
</div>

<div class="card">
  <h3>Packages (${packages.length})${countLine ? ` — <span class="muted">${esc(countLine)}</span>` : ''}</h3>
  <table class="admin-table">
  <thead><tr><th>Package ID</th><th>Recipient / address</th><th>Status</th></tr></thead>
  <tbody>${pkgRows || '<tr><td colspan="3">No packages on this route yet.</td></tr>'}</tbody>
  </table>
</div>

<div class="card">
  <h3>Add package</h3>
  <form method="POST" action="/admin/routes/${route.id}/packages" class="form">
    <label>Recipient name * <input type="text" name="recipient_name" required></label>
    <label>Address * <input type="text" name="address" required></label>
    <label>City <input type="text" name="city"></label>
    <label>State <input type="text" name="state"></label>
    <label>ZIP <input type="text" name="zip"></label>
    <label>Special instructions <textarea name="special_instructions" rows="2"></textarea></label>
    <button type="submit" class="btn">Add package</button>
  </form>
</div>`;
}

module.exports = {
  driverPipelineHtml,
  driverDetailHtml,
  statusBadge,
  subscriptionBadge,
  routeListHtml,
  routeNewHtml,
  routeDetailHtml,
  routeStatusBadge,
  packageStatusBadge,
  adminPackageHtml,
  exceptionsListHtml,
  ticketsListHtml,
  adminTicketHtml,
  communityModHtml,
  plansAdminHtml,
  opsDashboardHtml,
  reportsHtml,
  auditHtml,
};

// --- Operations dashboard / reports / audit (Phase L) ------------------------------
function statCard(label, value, href) {
  const inner = `<div class="stat-num">${esc(String(value))}</div><div class="stat-label">${esc(label)}</div>`;
  return href ? `<a class="stat-card" href="${href}">${inner}</a>` : `<div class="stat-card">${inner}</div>`;
}

function opsDashboardHtml({ overview, recentEvents, recentStatusChanges }) {
  const eventRows = recentEvents
    .map((e) => `<tr><td><a href="/admin/packages/${esc(e.package_id)}">${esc(e.package_id)}</a></td>
      <td>${esc(drivers.CUSTODY_EVENT_LABELS[e.event_type] || e.event_type)}</td>
      <td>${esc(e.driver_name || '—')}</td><td>${fmtTs(e.ts)}</td></tr>`)
    .join('');
  const statusRows = recentStatusChanges
    .map((h) => `<tr><td><a href="/admin/drivers/${h.driver_id}">${esc(h.driver_name || '#' + h.driver_id)}</a></td>
      <td>${esc(h.from_status || '—')} → ${esc(h.to_status)}</td>
      <td>${esc(h.changed_by || '')}</td><td>${fmtTs(h.ts)}</td></tr>`)
    .join('');
  return `
<h2>Operations dashboard</h2>
<div class="stat-grid">
  ${statCard('Open exceptions', overview.openExceptions, '/admin/exceptions?status=open')}
  ${statCard('Open tickets', overview.openTickets, '/admin/tickets')}
  ${statCard('Urgent tickets', overview.urgentTickets, '/admin/tickets')}
  ${statCard('Pending plan requests', overview.pendingPlanRequests, '/admin/plans')}
  ${statCard('Open community reports', overview.openReports, '/admin/community')}
</div>
<div class="card">
  <h3>Package investigation</h3>
  <form method="GET" action="/admin/operations/investigate" class="form">
    <label>Package ID <input type="text" name="package_id" placeholder="TN-2026-000001" required></label>
    <button type="submit" class="btn">Investigate</button>
  </form>
</div>
<h3>Drivers by status</h3>
<table class="admin-table"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>
${Object.entries(overview.driversByStatus).map(([s, c]) => `<tr><td>${esc(drivers.STATUS_LABELS[s] || s)}</td><td>${c}</td></tr>`).join('') || '<tr><td colspan="2">No drivers.</td></tr>'}
</tbody></table>
<h3>Packages by status</h3>
<table class="admin-table"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>
${Object.entries(overview.packagesByStatus).map(([s, c]) => `<tr><td>${esc(drivers.PACKAGE_STATUS_LABELS[s] || s)}</td><td>${c}</td></tr>`).join('') || '<tr><td colspan="2">No packages.</td></tr>'}
</tbody></table>
<h3>Recent custody events</h3>
<table class="admin-table"><thead><tr><th>Package</th><th>Event</th><th>Driver</th><th>When</th></tr></thead><tbody>
${eventRows || '<tr><td colspan="4">No events yet.</td></tr>'}
</tbody></table>
<h3>Recent driver status changes</h3>
<table class="admin-table"><thead><tr><th>Driver</th><th>Change</th><th>By</th><th>When</th></tr></thead><tbody>
${statusRows || '<tr><td colspan="4">No changes yet.</td></tr>'}
</tbody></table>`;
}

function aggTable(title, obj, labelFn) {
  const rows = Object.entries(obj || {})
    .map(([k, v]) => `<tr><td>${esc(labelFn ? labelFn(k) : k)}</td><td>${v}</td></tr>`)
    .join('');
  return `<h3>${esc(title)}</h3>
<table class="admin-table"><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>
${rows || '<tr><td colspan="2">No data.</td></tr>'}</tbody></table>`;
}

function reportsHtml({ reports }) {
  return `
<h2>Reports</h2>
${aggTable('Packages by status', reports.packagesByStatus, (k) => drivers.PACKAGE_STATUS_LABELS[k] || k)}
${aggTable('Exceptions by type', reports.exceptionsByType, (k) => drivers.EXCEPTION_TYPE_LABELS[k] || k)}
${aggTable('Exceptions by status', reports.exceptionsByStatus, (k) => drivers.EXCEPTION_STATUS_LABELS[k] || k)}
${aggTable('Tickets by category', reports.ticketsByCategory, (k) => drivers.TICKET_CATEGORY_LABELS[k] || k)}
${aggTable('Tickets by priority', reports.ticketsByPriority, (k) => drivers.TICKET_PRIORITY_LABELS[k] || k)}
${aggTable('Tickets by status', reports.ticketsByStatus, (k) => drivers.TICKET_STATUS_LABELS[k] || k)}
${aggTable('Plan changes by event', reports.planChangesByEvent)}
${aggTable('Community posts by category', reports.communityPostsByCategory, (k) => drivers.COMMUNITY_CATEGORY_LABELS[k] || k)}
<h3>Custody events per day (last 14 days)</h3>
<table class="admin-table"><thead><tr><th>Day</th><th>Events</th></tr></thead><tbody>
${reports.custodyByDay.map((r) => `<tr><td>${esc(r.day)}</td><td>${r.count}</td></tr>`).join('') || '<tr><td colspan="2">No events.</td></tr>'}
</tbody></table>`;
}

function auditHtml({ statusChanges, custodyEvents, planChanges }) {
  const scRows = statusChanges
    .map((h) => `<tr><td>${fmtTs(h.ts)}</td><td>driver status</td>
      <td><a href="/admin/drivers/${h.driver_id}">${esc(h.driver_name || '#' + h.driver_id)}</a></td>
      <td>${esc(h.from_status || '—')} → ${esc(h.to_status)}${h.note ? ' — ' + esc(h.note) : ''}</td>
      <td>${esc(h.changed_by || '')}</td></tr>`)
    .join('');
  const ceRows = custodyEvents
    .map((e) => `<tr><td>${fmtTs(e.ts)}</td><td>custody</td>
      <td><a href="/admin/packages/${esc(e.package_id)}">${esc(e.package_id)}</a></td>
      <td>${esc(drivers.CUSTODY_EVENT_LABELS[e.event_type] || e.event_type)}${e.note ? ' — ' + esc(e.note) : ''}</td>
      <td>${esc(e.driver_name || e.created_by || '')}</td></tr>`)
    .join('');
  const pcRows = planChanges
    .map((c) => `<tr><td>${fmtTs(c.created_at)}</td><td>plan ${esc(c.event)}</td>
      <td><a href="/admin/drivers/${c.driver_id}">${esc(c.driver_name || '#' + c.driver_id)}</a></td>
      <td>${c.from_plan_id ? esc(c.from_plan_id) + ' → ' : ''}${esc(c.to_plan_id || '')}${c.note ? ' — ' + esc(c.note) : ''}</td>
      <td>${esc(c.created_by || '')}</td></tr>`)
    .join('');
  return `
<h2>Audit trail</h2>
<p class="microcopy">Append-only history across driver status, custody, and plan changes. Records are never edited or deleted — corrections are new entries.</p>
<table class="admin-table">
<thead><tr><th>When</th><th>Type</th><th>Subject</th><th>Detail</th><th>By</th></tr></thead>
<tbody>${scRows}${ceRows}${pcRows || '<tr><td colspan="5">No audit records yet.</td></tr>'}</tbody>
</table>`;
}

// --- Service plans (Phase K: admin configuration + request triage) ------------------
function plansAdminHtml({ plans, settings, pendingRequests, driversById }) {
  const freqOpts = drivers.PLAN_BILLING_FREQUENCIES.map(
    (f) => `<option value="${f}"${settings.billing_frequency === f ? ' selected' : ''}>${esc(f)}</option>`
  ).join('');
  const planRows = plans
    .map((p) => `
      <tr><td colspan="5">
        <form method="POST" action="/admin/plans/${esc(p.id)}" class="form">
          <strong>${esc(p.id)}</strong>
          <label>Name <input type="text" name="name" value="${esc(p.name)}" required></label>
          <label>Weekly price (USD) <input type="number" name="weekly_price" min="0" step="1" value="${(p.weekly_price_cents / 100).toFixed(0)}" required></label>
          <label>Description <input type="text" name="description" value="${esc(p.description || '')}"></label>
          <label>Features (one per line)<textarea name="features" rows="2">${esc((() => { try { return JSON.parse(p.features || '[]').join('\n'); } catch { return ''; } })())}</textarea></label>
          <label class="checkbox"><input type="checkbox" name="active" value="1"${p.active ? ' checked' : ''}> Active</label>
          <button type="submit" class="btn btn-small">Save plan</button>
        </form>
      </td></tr>`)
    .join('');
  const reqRows = pendingRequests
    .map((r) => {
      const d = driversById[r.driver_id];
      return `<tr>
        <td>${d ? `<a href="/admin/drivers/${d.id}">${esc(d.full_name)}</a>` : 'driver #' + r.driver_id}</td>
        <td>${r.from_plan_id ? esc(r.from_plan_id) + ' → ' : ''}<strong>${esc(r.to_plan_id)}</strong></td>
        <td>${esc(r.note || '')}<br><span class="muted">${fmtTs(r.created_at)}</span></td>
        <td>
          <form method="POST" action="/admin/plans/requests/${r.driver_id}/approve" style="display:inline">
            <input type="text" name="note" placeholder="Approval note" style="width:140px">
            <button class="btn btn-small">Approve</button>
          </form>
          <form method="POST" action="/admin/plans/requests/${r.driver_id}/reject" style="display:inline">
            <input type="text" name="note" placeholder="Rejection reason" style="width:140px">
            <button class="btn btn-small">Reject</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');
  return `
<h2>Service plans</h2>
<div class="card">
  <p class="microcopy">${esc(drivers.PLAN_DISCLAIMER)}</p>
</div>
<div class="card">
  <h3>Settings</h3>
  <form method="POST" action="/admin/plans/settings" class="form">
    <label>Billing frequency
      <select name="billing_frequency">${freqOpts}</select>
    </label>
    <label class="checkbox"><input type="checkbox" name="plans_enabled" value="1"${settings.plans_enabled ? ' checked' : ''}>
      Plans are open for driver requests</label>
    <button type="submit" class="btn">Save settings</button>
  </form>
</div>
<h3>Plans (weekly prices)</h3>
<table class="admin-table"><tbody>${planRows}</tbody></table>
<h3>Pending requests (${pendingRequests.length})</h3>
<table class="admin-table">
<thead><tr><th>Driver</th><th>Requested</th><th>Note</th><th>Decide</th></tr></thead>
<tbody>${reqRows || '<tr><td colspan="4">No pending requests.</td></tr>'}</tbody>
</table>`;
}

// --- Community moderation (Phase J) -----------------------------------------------
function communityModHtml({ posts, commentsByPost, reports, driversById }) {
  const postRows = posts
    .map((p) => {
      const d = driversById[p.driver_id];
      return `<tr>
        <td><strong>${p.pinned ? '📌 ' : ''}${esc(p.title)}</strong><br>
          <span class="muted">${esc(drivers.COMMUNITY_CATEGORY_LABELS[p.category] || p.category)} ·
          ${p.author_type === 'admin' ? 'TransitNow' : esc(d ? d.full_name : '?')} · ${fmtTs(p.created_at)}</span></td>
        <td>${esc(p.status)}</td>
        <td>
          <form method="POST" action="/admin/community/posts/${p.id}/pin" style="display:inline"><button class="btn btn-small">${p.pinned ? 'Unpin' : 'Pin'}</button></form>
          ${p.status === 'visible'
            ? `<form method="POST" action="/admin/community/posts/${p.id}/hide" style="display:inline"><button class="btn btn-small">Hide</button></form>`
            : `<form method="POST" action="/admin/community/posts/${p.id}/restore" style="display:inline"><button class="btn btn-small">Restore</button></form>`}
        </td>
      </tr>`;
    })
    .join('');
  const commentRows = Object.values(commentsByPost)
    .flat()
    .map((c) => {
      const d = driversById[c.driver_id];
      return `<tr>
        <td>${esc((c.body || '').slice(0, 90))}<br>
          <span class="muted">on post #${c.post_id} · ${c.author_type === 'admin' ? 'TransitNow' : esc(d ? d.full_name : '?')} · ${fmtTs(c.created_at)}</span></td>
        <td>${esc(c.status)}</td>
        <td>${c.status === 'visible'
          ? `<form method="POST" action="/admin/community/comments/${c.id}/hide" style="display:inline"><button class="btn btn-small">Hide</button></form>`
          : `<form method="POST" action="/admin/community/comments/${c.id}/restore" style="display:inline"><button class="btn btn-small">Restore</button></form>`}
        </td>
      </tr>`;
    })
    .join('');
  const reportRows = reports
    .map((r) => {
      const rep = driversById[r.reporter_driver_id];
      return `<tr>
        <td>${r.post_id ? `post #${r.post_id}` : ''}${r.comment_id ? `comment #${r.comment_id}` : ''}<br>
          <span class="muted">by ${esc(rep ? rep.full_name : '?')} · ${fmtTs(r.created_at)}</span></td>
        <td>${esc(r.reason)}</td>
        <td>${esc(r.status)}</td>
        <td>${r.status === 'open'
          ? `<form method="POST" action="/admin/community/reports/${r.id}/review" style="display:inline">
               <button class="btn btn-small" name="outcome" value="reviewed">Mark reviewed</button>
               <button class="btn btn-small" name="outcome" value="dismissed">Dismiss</button>
             </form>` : ''}</td>
      </tr>`;
    })
    .join('');
  return `
<h2>Driver community — moderation</h2>
<div class="card">
  <h3>Post an announcement</h3>
  <form method="POST" action="/admin/community/announce" class="form">
    <label>Title <input type="text" name="title" required></label>
    <label>Message <textarea name="body" rows="3" required></textarea></label>
    <button type="submit" class="btn">Publish announcement</button>
  </form>
</div>
<h3>Posts (${posts.length})</h3>
<table class="admin-table">
<thead><tr><th>Post</th><th>Status</th><th>Actions</th></tr></thead>
<tbody>${postRows || '<tr><td colspan="3">No posts.</td></tr>'}</tbody>
</table>
<h3>Comments</h3>
<table class="admin-table">
<thead><tr><th>Comment</th><th>Status</th><th>Actions</th></tr></thead>
<tbody>${commentRows || '<tr><td colspan="3">No comments.</td></tr>'}</tbody>
</table>
<h3>Reports (${reports.length})</h3>
<table class="admin-table">
<thead><tr><th>Target</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead>
<tbody>${reportRows || '<tr><td colspan="4">No reports.</td></tr>'}</tbody>
</table>`;
}

// --- Support tickets (Phase I: admin triage) --------------------------------------
function ticketsListHtml({ list, statusFilter, driversById }) {
  const statuses = ['open', 'in_progress', 'waiting_driver', 'resolved', 'closed'];
  const tabs = statuses.map((s) => {
    const active = statusFilter === s ? ' class="active"' : '';
    return `<a${active} href="/admin/tickets?status=${s}">${esc(drivers.TICKET_STATUS_LABELS[s])}</a>`;
  }).join('');
  const allActive = !statusFilter ? ' class="active"' : '';
  const rows = list
    .map((t) => {
      const d = driversById[t.driver_id];
      return `<tr${t.priority === 'urgent' && t.status === 'open' ? ' style="background:#fff3cd"' : ''}>
        <td><a href="/admin/tickets/${esc(t.ticket_id)}"><strong>${esc(t.ticket_id)}</strong></a><br><span class="muted">${esc(t.subject)}</span></td>
        <td>${d ? `<a href="/admin/drivers/${d.id}">${esc(d.full_name)}</a>` : '—'}</td>
        <td>${esc(drivers.TICKET_CATEGORY_LABELS[t.category] || t.category)}</td>
        <td>${t.priority === 'urgent' ? '<strong>URGENT</strong>' : esc(drivers.TICKET_PRIORITY_LABELS[t.priority] || t.priority)}</td>
        <td>${esc(drivers.TICKET_STATUS_LABELS[t.status] || t.status)}</td>
        <td>${fmtTs(t.created_at)}</td>
      </tr>`;
    })
    .join('');
  return `
<h2>Support tickets</h2>
<div class="pipeline-nav"><a${allActive} href="/admin/tickets">All</a>${tabs}</div>
<table class="admin-table">
<thead><tr><th>Ticket</th><th>Driver</th><th>Category</th><th>Priority</th><th>Status</th><th>Created</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No tickets.</td></tr>'}</tbody>
</table>`;
}

function adminTicketHtml({ ticket, driver, replies }) {
  const statusOpts = drivers.TICKET_STATUSES.map(
    (s) => `<option value="${s}"${ticket.status === s ? ' selected' : ''}>${esc(drivers.TICKET_STATUS_LABELS[s])}</option>`
  ).join('');
  const thread = (replies || [])
    .map(
      (r) => `<div class="card"><p><strong>${r.author_type === 'admin' ? 'Operations' : 'Driver'}</strong>
        <span class="ts">${fmtTs(r.created_at)}</span></p><p>${esc(r.message)}</p></div>`
    )
    .join('');
  return `
<p><a href="/admin/tickets">&larr; Back to tickets</a></p>
<h2>${esc(ticket.ticket_id)} ${ticket.priority === 'urgent' ? '<strong>URGENT</strong>' : ''}</h2>
<div class="card">
  <p><strong>${esc(ticket.subject)}</strong></p>
  <p>${esc(drivers.TICKET_CATEGORY_LABELS[ticket.category] || ticket.category)} ·
  ${esc(drivers.TICKET_STATUS_LABELS[ticket.status] || ticket.status)}</p>
  <p>${esc(ticket.message)}</p>
  <p class="muted">Driver: ${driver ? `<a href="/admin/drivers/${driver.id}">${esc(driver.full_name)}</a> (${esc(driver.email)})` : '—'} ·
  Opened ${fmtTs(ticket.created_at)}</p>
</div>
<h3>Conversation</h3>
${thread || '<div class="card"><p>No replies yet.</p></div>'}
<div class="card">
  <h3>Reply</h3>
  <form method="POST" action="/admin/tickets/${esc(ticket.ticket_id)}/reply" class="form">
    <label>Message <textarea name="message" rows="3" required></textarea></label>
    <button type="submit" class="btn">Send reply</button>
  </form>
</div>
<div class="card">
  <h3>Change status</h3>
  <form method="POST" action="/admin/tickets/${esc(ticket.ticket_id)}/status" class="form">
    <label>Status <select name="status">${statusOpts}</select></label>
    <button type="submit" class="btn">Update</button>
  </form>
</div>`;
}

// --- Exceptions (Phase H: admin flagging + resolution) ------------------------------
function exceptionStatusBadge(status) {
  return `<span class="status-badge">${esc(drivers.EXCEPTION_STATUS_LABELS[status] || status)}</span>`;
}

function exceptionsListHtml({ list, statusFilter, openCount, driversById }) {
  const tabs = ['open', 'resolved'].map((s) => {
    const active = statusFilter === s ? ' class="active"' : '';
    return `<a${active} href="/admin/exceptions?status=${s}">${esc(drivers.EXCEPTION_STATUS_LABELS[s])}</a>`;
  }).join('');
  const allActive = !statusFilter ? ' class="active"' : '';
  const rows = list
    .map((x) => {
      const d = driversById[x.driver_id];
      return `<tr>
        <td><a href="/admin/packages/${esc(x.package_id)}"><strong>${esc(x.package_id)}</strong></a></td>
        <td>${esc(drivers.EXCEPTION_TYPE_LABELS[x.exception_type] || x.exception_type)}</td>
        <td>${d ? `<a href="/admin/drivers/${d.id}">${esc(d.full_name)}</a>` : '—'}</td>
        <td>${esc((x.description || '').slice(0, 80))}${x.photo_mime ? ' 📷' : ''}</td>
        <td>${exceptionStatusBadge(x.status)}</td>
        <td>${fmtTs(x.created_at)}</td>
        <td>${x.status === 'open'
          ? `<form method="POST" action="/admin/exceptions/${x.id}/resolve" class="form" style="display:inline">
               <input type="text" name="resolution_note" placeholder="Resolution note" required style="width:160px">
               <button type="submit" class="btn">Resolve</button>
             </form>`
          : esc(x.resolution_note || '')}</td>
      </tr>`;
    })
    .join('');
  return `
<h2>Package exceptions ${openCount ? `(${openCount} open)` : ''}</h2>
<div class="pipeline-nav"><a${allActive} href="/admin/exceptions">All</a>${tabs}</div>
<table class="admin-table">
<thead><tr><th>Package</th><th>Type</th><th>Driver</th><th>Description</th><th>Status</th><th>Reported</th><th>Resolution</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No exceptions.</td></tr>'}</tbody>
</table>`;
}

// --- Package investigation (Phase F: read-only custody timeline) ------------------
function adminPackageHtml({ pkg, driver, route, events, exceptions }) {
  const timeline = (events || [])
    .map(
      (ev) => `<li><strong>${esc(drivers.CUSTODY_EVENT_LABELS[ev.event_type] || ev.event_type)}</strong>
        <span class="ts">${fmtTs(ev.ts)} · by ${esc(ev.created_by || 'driver')}${ev.driver_name ? ' (' + esc(ev.driver_name) + ')' : ''}</span>
        ${ev.note ? `<br>${esc(ev.note)}` : ''}</li>`
    )
    .join('');
  const exHtml = (exceptions || [])
    .map(
      (x) => `<div class="card"><p><strong>${esc(drivers.EXCEPTION_TYPE_LABELS[x.exception_type] || x.exception_type)}</strong>
        — ${exceptionStatusBadge(x.status)} <span class="ts">${fmtTs(x.created_at)}</span></p>
        <p>${esc(x.description)}</p>
        ${x.photo_mime ? `<p><a href="/admin/exceptions/${x.id}/photo">View attached photo (${esc(x.photo_name || x.photo_mime)})</a></p>` : ''}
        ${x.status === 'resolved' && x.resolution_note ? `<p class="muted">Resolution: ${esc(x.resolution_note)}</p>` : ''}
        ${x.status === 'open' ? `<form method="POST" action="/admin/exceptions/${x.id}/resolve" class="form">
          <label>Resolution note <input type="text" name="resolution_note" required></label>
          <button type="submit" class="btn">Resolve exception</button>
        </form>` : ''}</div>`
    )
    .join('');
  return `
<p><a href="/admin/routes${route ? '/' + route.id : ''}">&larr; ${route ? 'Back to ' + esc(route.route_code) : 'Back to routes'}</a></p>
<h2>${esc(pkg.package_id)} ${packageStatusBadge(pkg.status)}</h2>
<div class="card">
  <h3>Package</h3>
  <div><strong>Recipient:</strong> ${esc(pkg.recipient_name)}</div>
  <div><strong>Address:</strong> ${esc([pkg.address, pkg.city, pkg.state, pkg.zip].filter(Boolean).join(', '))}</div>
  ${pkg.special_instructions ? `<div><strong>Instructions:</strong> ${esc(pkg.special_instructions)}</div>` : ''}
  <div><strong>Driver:</strong> ${driver ? `<a href="/admin/drivers/${driver.id}">${esc(driver.full_name)}</a>` : '—'}</div>
  <div><strong>Route:</strong> ${route ? `<a href="/admin/routes/${route.id}">${esc(route.route_code)}</a>` : '—'}</div>
</div>
<div class="card">
  <h3>Custody history (append-only)</h3>
  <ul class="timeline">${timeline || '<li>No custody events recorded yet.</li>'}</ul>
</div>
${exHtml ? `<h3>Exceptions</h3>${exHtml}` : ''}`;
}

// --- Phase 5: live video support — admin queue + session detail ------------------
// HONESTY IS ABSOLUTE: the queue/detail must never present a session as a
// live/real-time/connected media call. With no provider configured, every
// surface shows VIDEO PROVIDER REQUIRED and labels workflows SIMULATED TEST.
function liveSessionStatusBadge(status, provider) {
  const label = drivers.SESSION_STATUS_LABELS[status] || status;
  // Provider-aware: the DB enum stays LIVE, but the display must not read as a
  // connected media call until a provider-backed end-to-end call succeeds.
  const display = (status === 'LIVE' && !(provider && provider.mediaVerified))
    ? `${label} — SIMULATED TEST (workflow state only, no media connection)`
    : label;
  return `<span class="status-badge status-${esc(String(status).toLowerCase())}">${esc(display)}</span>`;
}

function adminProviderNoteHtml(provider) {
  if (provider.configured) {
    // Credentials alone do not prove a media connection: say exactly that.
    return `<div class="card highlight-card"><p><strong>Video provider credentials configured:</strong> ${esc(provider.providerName)}.
    Media is <strong>not verified</strong> — no end-to-end media call has succeeded, so sessions remain in
    <strong>SIMULATED TEST</strong> mode. No real-time video, audio, or media connection is claimed.</p></div>`;
  }
  return `<div class="card" style="border:2px solid #b45309;background:#fffbeb" role="alert">
    <p><strong>VIDEO PROVIDER REQUIRED</strong> — no video provider is connected, so sessions run in
    <strong>SIMULATED TEST</strong> mode. The request/accept/record workflow below is real; no real-time
    video, audio, or media connection exists or is claimed.</p>
  </div>`;
}

function liveSessionsListHtml({ list, statusFilter, driversById, provider }) {
  const tabs = drivers.SESSION_STATUSES.map((s) => {
    const active = statusFilter === s ? ' class="active"' : '';
    return `<a${active} href="/admin/live-sessions?status=${s}">${esc(drivers.SESSION_STATUS_LABELS[s])}</a>`;
  }).join('');
  const allActive = !statusFilter ? ' class="active"' : '';
  const rows = (list || [])
    .map((s) => {
      const d = driversById[s.driver_id];
      const hot = s.status === 'REQUESTED' && s.priority === 'URGENT';
      return `<tr${hot ? ' style="background:#fff3cd"' : ''}>
        <td><a href="/admin/live-sessions/${esc(s.session_id)}"><strong>${esc(s.session_id)}</strong></a></td>
        <td>${d ? `<a href="/admin/drivers/${d.id}">${esc(d.full_name)}</a>` : '—'}</td>
        <td>${esc(drivers.SESSION_REASON_LABELS[s.reason] || s.reason || '—')}</td>
        <td>${s.priority === 'URGENT' ? '<strong>URGENT</strong>' : esc(s.priority || 'NORMAL')}</td>
        <td>${liveSessionStatusBadge(s.status, provider)}${provider.configured ? '' : ' <span class="muted">SIMULATED TEST</span>'}</td>
        <td>${fmtTs(s.created_at)}</td>
      </tr>`;
    })
    .join('');
  return `
<h2>Live video sessions</h2>
${adminProviderNoteHtml(provider)}
<div class="pipeline-nav"><a${allActive} href="/admin/live-sessions">All</a>${tabs}</div>
<table class="admin-table">
<thead><tr><th>Session</th><th>Driver</th><th>Reason</th><th>Priority</th><th>Status</th><th>Requested</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No sessions.</td></tr>'}</tbody>
</table>
<p><a class="btn btn-small" href="/admin/live-training">Live training events &amp; content &rarr;</a></p>`;
}

function adminLiveSessionHtml({ session: s, driver, events, messages, participants, recording, accessLog, provider }) {
  const rec = recording || {};
  const thread = (messages || [])
    .map((m) => `<div class="card"><p><strong>${m.sender_type === 'driver' ? 'Driver' : 'Operations'}</strong>
      <span class="ts">${fmtTs(m.ts)}</span></p><p>${esc(m.message)}</p></div>`)
    .join('');
  const timeline = (events || [])
    .map((e) => `<li><strong>${esc(e.event_type)}</strong> — ${esc(e.details || '')}
      <span class="muted">(${esc(e.actor || '')} · ${fmtTs(e.ts)})</span></li>`)
    .join('');
  const parts = (participants || [])
    .map((p) => `<li>${p.role === 'driver' ? 'Driver' : 'Operations' + (p.staff_name ? ' (' + esc(p.staff_name) + ')' : '')}
      — joined ${fmtTs(p.joined_at)}${p.left_at ? ', left ' + fmtTs(p.left_at) : ''}</li>`)
    .join('');
  const accessRows = (accessLog || [])
    .map((a) => `<tr><td>${fmtTs(a.accessed_at)}</td><td>${esc(a.accessed_by)}</td><td>${esc(a.purpose)}</td></tr>`)
    .join('');
  const open = ['REQUESTED', 'ACCEPTED', 'LIVE'].includes(s.status);
  const actionBtn = (action, label, extra = '') => `
    <form method="POST" action="/admin/live-sessions/${esc(s.session_id)}/${action}" class="form" style="display:inline-block;margin-right:8px">
      ${action === 'accept' || action === 'decline' ? '<label>Dispatcher name <input type="text" name="dispatcher_name" placeholder="Your name" style="max-width:180px"></label>' : ''}
      ${action === 'decline' || action === 'end' ? '<label>Note <input type="text" name="note" style="max-width:220px"></label>' : ''}
      ${extra}
      <button type="submit" class="btn btn-small">${esc(label)}</button>
    </form>`;
  return `
<p><a href="/admin/live-sessions">&larr; Back to live sessions</a></p>
<h2>${esc(s.session_id)} ${liveSessionStatusBadge(s.status, provider)}</h2>
${adminProviderNoteHtml(provider)}
<div class="card">
  <h3>Session</h3>
  <div><strong>Driver:</strong> ${driver ? `<a href="/admin/drivers/${driver.id}">${esc(driver.full_name)}</a> (${esc(driver.email)})` : '—'}</div>
  <div><strong>Reason:</strong> ${esc(drivers.SESSION_REASON_LABELS[s.reason] || s.reason || '—')}</div>
  <div><strong>Priority:</strong> ${s.priority === 'URGENT' ? '<strong>URGENT</strong>' : esc(s.priority || 'NORMAL')}</div>
  <div><strong>Dispatcher:</strong> ${esc(s.dispatcher_name || '—')}</div>
  <div><strong>Route:</strong> ${s.route_id ? esc(String(s.route_id)) : '—'} · <strong>Contract:</strong> ${s.contract_id ? esc(String(s.contract_id)) : '—'}</div>
  <div><strong>Requested:</strong> ${fmtTs(s.created_at)}${s.started_at ? ` · <strong>Started:</strong> ${fmtTs(s.started_at)}` : ''}${s.ended_at ? ` · <strong>Ended:</strong> ${fmtTs(s.ended_at)}` : ''}</div>
  <div><strong>Driver media consent:</strong> camera ${s.consent_camera ? 'ON' : 'OFF'} · mic ${s.consent_mic ? 'ON' : 'OFF'} · location ${s.share_location ? 'ON (voluntary)' : 'OFF'}</div>
  <div><strong>Provider reference:</strong> ${s.provider_ref ? esc(s.provider_ref) : '<span class="muted">none — no provider-backed media (never faked)</span>'}</div>
  ${s.notes ? `<div><strong>Driver notes:</strong> ${esc(s.notes)}</div>` : ''}
</div>
${open ? `<div class="card"><h3>Actions</h3>
  ${s.status === 'REQUESTED' ? actionBtn('accept', 'Accept session') + actionBtn('decline', 'Decline') + actionBtn('missed', 'Mark missed') : ''}
  ${s.status === 'ACCEPTED' ? actionBtn('start', 'Start session (go LIVE)') + actionBtn('end', 'End session') + actionBtn('decline', 'Decline') : ''}
  ${s.status === 'LIVE' ? actionBtn('end', 'End session') : ''}
  <p class="microcopy">Only valid lifecycle transitions are allowed; invalid ones are rejected.</p>
</div>` : ''}
<div class="card">
  <h3>Recording</h3>
  <p><strong>Status:</strong> ${rec.consent_given ? 'CONSENTED' : 'OFF (default)'}</p>
  ${rec.consent_given ? `<p class="microcopy">Consented by ${esc(rec.consent_by || '—')} at ${fmtTs(rec.consent_at)}.
    Retention expires ${fmtTs(rec.retention_expires_at)} (90 days).
    <strong>No media capture is implemented — nothing is being recorded.</strong></p>` : ''}
  ${open ? `<form method="POST" action="/admin/live-sessions/${esc(s.session_id)}/recording-consent" class="form">
    <label class="checkbox"><input type="checkbox" name="consent" value="yes">
      <strong>Driver consents</strong> to this session being recorded (explicit opt-in, recorded before any recording may start).</label>
    <label>Recorded by <input type="text" name="by" placeholder="Staff name" style="max-width:200px"></label>
    <button type="submit" class="btn btn-small">Save recording consent</button>
  </form>` : ''}
  <h4>Recording access log</h4>
  <table class="admin-table"><thead><tr><th>When</th><th>Accessed by</th><th>Purpose</th></tr></thead>
  <tbody>${accessRows || '<tr><td colspan="3">No recorded accesses.</td></tr>'}</tbody></table>
</div>
<h3>Chat</h3>
${thread || '<div class="card"><p>No messages yet.</p></div>'}
${open ? `<div class="card"><h3>Message the driver</h3>
  <form method="POST" action="/admin/live-sessions/${esc(s.session_id)}/message" class="form">
    <label>Message <textarea name="message" rows="2" required maxlength="2000"></textarea></label>
    <button type="submit" class="btn">Send as operations</button>
  </form></div>` : ''}
<h3>Session record (append-only)</h3>
<ul class="timeline">${timeline || '<li>No events.</li>'}</ul>
${parts ? `<h3>Participants</h3><ul>${parts}</ul>` : ''}`;
}

function liveTrainingAdminHtml({ events, content }) {
  const evRows = (events || [])
    .map((e) => `<tr><td><strong>${esc(e.event_id)}</strong><br><span class="muted">${esc(e.title)}</span></td>
      <td>${e.scheduled_at ? fmtTs(e.scheduled_at) : 'TBA'}</td>
      <td>${esc(e.status || 'scheduled')}</td>
      <td>${e.provider_ref ? esc(e.provider_ref) : '<span class="muted">not provider-backed</span>'}</td></tr>`)
    .join('');
  const contentRows = (content || [])
    .map((c) => `<tr><td><strong>${esc(c.title)}</strong><br><span class="muted">${esc(c.description || '')}</span></td>
      <td>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">link</a>` : '—'}</td>
      <td>${c.duration_secs ? Math.round(c.duration_secs / 60) + ' min' : '—'}</td></tr>`)
    .join('');
  return `
<p><a href="/admin/live-sessions">&larr; Back to live sessions</a></p>
<h2>Live training</h2>
<p class="microcopy">Training events are provider-backed only when a video provider is configured; otherwise they are clearly labeled as not provider-backed.</p>
<div class="card"><h3>Schedule a training event</h3>
  <form method="POST" action="/admin/live-training/events" class="form">
    <label>Title * <input type="text" name="title" required maxlength="200"></label>
    <label>Description <textarea name="description" rows="2" maxlength="2000"></textarea></label>
    <label>Scheduled at <input type="datetime-local" name="scheduled_at"></label>
    <button type="submit" class="btn">Schedule event</button>
  </form></div>
<h3>Scheduled events</h3>
<table class="admin-table"><thead><tr><th>Event</th><th>When</th><th>Status</th><th>Provider</th></tr></thead>
<tbody>${evRows || '<tr><td colspan="4">No training events.</td></tr>'}</tbody></table>
<div class="card"><h3>Add training content</h3>
  <form method="POST" action="/admin/live-training/content" class="form">
    <label>Title * <input type="text" name="title" required maxlength="200"></label>
    <label>Description <textarea name="description" rows="2" maxlength="2000"></textarea></label>
    <label>URL <input type="url" name="url" maxlength="1000" placeholder="https://…"></label>
    <label>Duration (minutes) <input type="number" name="duration_mins" min="0" max="10000"></label>
    <button type="submit" class="btn">Add content</button>
  </form></div>
<h3>Training content library</h3>
<table class="admin-table"><thead><tr><th>Title</th><th>Link</th><th>Length</th></tr></thead>
<tbody>${contentRows || '<tr><td colspan="3">No content yet.</td></tr>'}</tbody></table>`;
}

// Phase 5 exports (same additive pattern as the Phase L section above).
Object.assign(module.exports, {
  liveSessionsListHtml,
  adminLiveSessionHtml,
  liveTrainingAdminHtml,
});
