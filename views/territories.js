'use strict';
/**
 * views/territories.js — Phase 3 admin pages for territory management
 * (spec section 20). Rendered inside views/admin.js adminLayout by the
 * backend.
 *
 * Active contracts / available drivers / available vehicles / open
 * opportunities are COMPUTED from live data (lib/territories.js) — the
 * numbers on these pages always reflect the real tables.
 */
const { esc } = require('./layout');

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString();
}
function kv(label, value) {
  if (value == null || value === '') return '';
  return `<div><strong>${esc(label)}:</strong> ${esc(String(value))}</div>`;
}

// --- List ----------------------------------------------------------------------
function territoryListHtml({ list, statsById }) {
  const rows = list.map((t) => {
    const s = (statsById && statsById[t.id]) || { activeContracts: 0, openOpportunities: 0, availableDrivers: 0, availableVehicles: 0 };
    return `
    <tr>
      <td><a href="/admin/territories/${t.id}"><strong>${esc(t.name)}</strong></a><br>
        <span class="muted">${esc([t.city, t.state].filter(Boolean).join(', ') || '')}</span></td>
      <td>${s.activeContracts}</td>
      <td>${s.openOpportunities}</td>
      <td>${s.availableDrivers}</td>
      <td>${s.availableVehicles}</td>
      <td>${esc(t.capacity || '—')}</td>
      <td>${fmtTs(t.updated_at)}</td>
    </tr>`;
  }).join('');
  return `
<h2>Territories</h2>
<p class="microcopy">Contract, driver, vehicle and opportunity counts are computed live from the real data — never typed in, never stale.</p>
<p><a class="btn" href="/admin/territories/new">+ New territory</a></p>
<table class="admin-table">
<thead><tr><th>Territory</th><th>Active contracts</th><th>Open opportunities</th><th>Available drivers</th><th>Available vehicles</th><th>Capacity</th><th>Updated</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No territories yet.</td></tr>'}</tbody>
</table>`;
}

// --- New / edit form --------------------------------------------------------------
function optField(name, label, value, { hint = '' } = {}) {
  return `<label>${esc(label)}
    <input type="text" name="${esc(name)}" value="${esc(value || '')}">
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </label>`;
}

function territoryFormHtml({ territory: t = {}, errors = [], isNew = true }) {
  const errHtml = errors.length
    ? `<div class="form-error" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  const action = isNew ? '/admin/territories' : `/admin/territories/${t.id}`;
  return `
<p><a href="/admin/territories">&larr; Back to territories</a></p>
<h2>${isNew ? 'New territory' : `Edit: ${esc(t.name || '')}`}</h2>
${errHtml}
<form method="POST" action="${action}" class="form">
  <div class="card">
    <h3>Basics</h3>
    <label>Territory name *
      <input type="text" name="name" value="${esc(t.name || '')}" required>
      <span class="hint">Use this exact name on contracts and opportunities so territory reporting picks them up.</span>
    </label>
    ${optField('city', 'City', t.city)}
    ${optField('state', 'State', t.state)}
    ${optField('zip_codes', 'ZIP codes', t.zip_codes, { hint: 'Comma-separated, e.g. 53202, 53203' })}
    ${optField('service_radius', 'Service radius', t.service_radius, { hint: 'e.g. 25 miles' })}
    ${optField('capacity', 'Capacity', t.capacity, { hint: 'Admin-set, e.g. "10 routes/day" — informational only' })}
    <label>Notes (internal)
      <textarea name="notes" rows="4">${esc(t.notes || '')}</textarea>
    </label>
  </div>
  <button type="submit" class="btn">${isNew ? 'Create territory' : 'Save changes'}</button>
</form>`;
}

// --- Detail -----------------------------------------------------------------------
function territoryDetailHtml({ territory: t, stats, contracts, opportunities, drivers, error = '' }) {
  const contractRows = (contracts || []).map((c) => `
    <tr><td><a href="/admin/contracts/${c.id}"><strong>${esc(c.contract_name)}</strong></a><br>
      <span class="muted">${esc(c.contract_number || '')}</span></td>
      <td>${esc(c.client || '')}</td><td>${esc(c.status)}</td></tr>`).join('');
  const oppRows = (opportunities || []).map((o) => `
    <tr><td><a href="/admin/opportunities/${o.id}">${esc(o.name)}</a></td>
      <td>${esc([o.location, o.territory].filter(Boolean).join(' · '))}</td><td>${esc(o.status)}</td></tr>`).join('');
  const driverRows = (drivers || []).map((d) => `
    <tr><td><a href="/admin/drivers/${d.id}">${esc(d.full_name)}</a></td>
      <td>${esc(d.status)}</td>
      <td>${esc(d.vehicle_type || '—')}</td>
      <td>${esc([d.home_city, d.home_state].filter(Boolean).join(', '))}</td></tr>`).join('');

  return `
<p><a href="/admin/territories">&larr; Back to territories</a></p>
${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
<h2>${esc(t.name)}</h2>
<p class="muted">${esc([t.city, t.state].filter(Boolean).join(', '))} ${t.zip_codes ? '· ZIPs ' + esc(t.zip_codes) : ''} ${t.service_radius ? '· ' + esc(t.service_radius) : ''}</p>

<div class="metric-cards">
  <div class="metric-card" data-metric="active_contracts"><div class="num">${stats.activeContracts}</div><div class="label">Active contracts</div></div>
  <div class="metric-card" data-metric="open_opportunities"><div class="num">${stats.openOpportunities}</div><div class="label">Open opportunities</div></div>
  <div class="metric-card" data-metric="available_drivers"><div class="num">${stats.availableDrivers}</div><div class="label">Available drivers</div></div>
  <div class="metric-card" data-metric="available_vehicles"><div class="num">${stats.availableVehicles}</div><div class="label">Available vehicles</div></div>
</div>
<p class="microcopy">Computed live: active contracts carry this territory name; available drivers are in ready/placement/active status and based in ${esc(t.city || t.state || 'this territory')}; vehicles are counted from those drivers' own vehicle records.</p>

<div class="card">
  <h3>Details</h3>
  ${kv('Capacity (admin-set)', t.capacity)}
  ${kv('Notes', t.notes)}
  <p><a class="btn btn-small" href="/admin/territories/${t.id}/edit">Edit territory</a>
     <a class="btn btn-small" href="/admin/operations?territory=${encodeURIComponent(t.name)}">Open in command center</a></p>
</div>

<h2>Contracts in this territory (${(contracts || []).length})</h2>
<table class="admin-table"><thead><tr><th>Contract</th><th>Client</th><th>Status</th></tr></thead>
<tbody>${contractRows || '<tr><td colspan="3">No contracts carry this territory name yet.</td></tr>'}</tbody></table>

<h2>Opportunities in this territory (${(opportunities || []).length})</h2>
<table class="admin-table"><thead><tr><th>Opportunity</th><th>Location</th><th>Status</th></tr></thead>
<tbody>${oppRows || '<tr><td colspan="3">No opportunities here yet.</td></tr>'}</tbody></table>

<h2>Available drivers (${(drivers || []).length})</h2>
<table class="admin-table"><thead><tr><th>Driver</th><th>Status</th><th>Vehicle</th><th>Based in</th></tr></thead>
<tbody>${driverRows || '<tr><td colspan="4">No available drivers in this territory yet.</td></tr>'}</tbody></table>`;
}

module.exports = {
  territoryListHtml,
  territoryFormHtml,
  territoryDetailHtml,
};
