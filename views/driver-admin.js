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

module.exports = { driverPipelineHtml, driverDetailHtml, statusBadge };
