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

function kv(label, value) {
  if (value == null || value === '') return '';
  return `<div><strong>${esc(label)}:</strong> ${esc(value)}</div>`;
}

// --- Pipeline list ------------------------------------------------------------
function driverPipelineHtml({ list, counts, status, source, q }) {
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
      <td>${fmtTs(d.submitted_at)}</td>
      <td>${fmtTs(d.last_contact)}</td>
    </tr>`;
  }).join('');

  return `
<h2>Driver Pipeline</h2>
<div class="pipeline-nav"><a${allActive} href="/admin/drivers">All (${total})</a>${tabs}</div>
<form method="GET" action="/admin/drivers" class="filter-form">
  ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}
  <select name="source"><option value="">All sources</option>${srcOpts}</select>
  <input type="text" name="q" placeholder="Search name, email, phone" value="${esc(q || '')}">
  <button type="submit" class="btn">Filter</button>
</form>
<p>${list.length} driver(s) shown</p>
<table class="admin-table">
<thead><tr><th>Driver</th><th>Business</th><th>Vehicle</th><th>Location</th><th>Availability</th><th>Work requested</th><th>Source</th><th>Status</th><th>Submitted</th><th>Last contact</th></tr></thead>
<tbody>${rows || '<tr><td colspan="10">No drivers match.</td></tr>'}</tbody>
</table>`;
}

// --- Driver detail --------------------------------------------------------------
function driverDetailHtml({ driver: d, history }) {
  const statusOpts = drivers.DRIVER_STATUSES.map(
    (s) => `<option value="${s}"${d.status === s ? ' selected' : ''}>${esc(drivers.STATUS_LABELS[s])}</option>`
  ).join('');
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
  routeListHtml,
  routeNewHtml,
  routeDetailHtml,
  routeStatusBadge,
  packageStatusBadge,
  adminPackageHtml,
  exceptionsListHtml,
  ticketsListHtml,
  adminTicketHtml,
};

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
