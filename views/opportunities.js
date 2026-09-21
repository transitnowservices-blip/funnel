'use strict';
/**
 * views/opportunities.js — Phase 2 admin pages for the internal opportunity
 * database (spec section 9) and opportunity matching ("Potential Match"
 * only — never a promise of employment, routes, loads, contracts, or
 * income). Rendered inside views/admin.js adminLayout by the backend.
 */
const { esc } = require('./layout');
const opps = require('../lib/opportunities');

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString();
}

function statusBadge(status) {
  return `<span class="status-badge">${esc(status)}</span>`;
}

function kv(label, value) {
  if (value == null || value === '') return '';
  return `<div><strong>${esc(label)}:</strong> ${esc(value)}</div>`;
}

// --- Opportunity list -----------------------------------------------------------
function opportunityListHtml({ list, counts, statusFilter }) {
  const tabs = opps.OPPORTUNITY_STATUSES.map((s) => {
    const active = statusFilter === s ? ' class="active"' : '';
    return `<a${active} href="/admin/opportunities?status=${s}">${esc(s)} (${counts[s] || 0})</a>`;
  }).join('');
  const allActive = !statusFilter ? ' class="active"' : '';
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rows = list.map((o) => `
    <tr>
      <td><a href="/admin/opportunities/${o.id}"><strong>${esc(o.name)}</strong></a><br><span class="muted">${esc(o.opportunity_type || '')}</span></td>
      <td>${esc(o.client_contract || '—')}</td>
      <td>${esc([o.location, o.territory].filter(Boolean).join(' · ') || '—')}</td>
      <td>${o.drivers_needed || 0} driver(s)<br><span class="muted">${o.vehicles_needed || 0} vehicle(s)</span></td>
      <td>${statusBadge(o.status)}</td>
      <td>${fmtTs(o.updated_at)}</td>
    </tr>`).join('');
  return `
<h2>Opportunities</h2>
<div class="pipeline-nav"><a${allActive} href="/admin/opportunities">All (${total})</a>${tabs}</div>
<p><a class="btn" href="/admin/opportunities/new">+ New opportunity</a></p>
<table class="admin-table">
<thead><tr><th>Opportunity</th><th>Client / contract</th><th>Location / territory</th><th>Needed</th><th>Status</th><th>Updated</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No opportunities yet.</td></tr>'}</tbody>
</table>`;
}

// --- New / edit form --------------------------------------------------------------
function reqField(name, label, value, { type = 'text', hint = '' } = {}) {
  return `<label>${esc(label)} *
    <input type="${type}" name="${esc(name)}" value="${esc(value || '')}" required>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </label>`;
}
function optField(name, label, value, { type = 'text', hint = '', rows = 3 } = {}) {
  if (type === 'textarea') {
    return `<label>${esc(label)}
      <textarea name="${esc(name)}" rows="${rows}">${esc(value || '')}</textarea>
      ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
    </label>`;
  }
  return `<label>${esc(label)}
    <input type="${type}" name="${esc(name)}" value="${esc(value || '')}">
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </label>`;
}

function opportunityFormHtml({ opportunity: o = {}, errors = [], isNew = true }) {
  const errHtml = errors.length
    ? `<div class="form-error" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  const action = isNew ? '/admin/opportunities' : `/admin/opportunities/${o.id}`;
  return `
<p><a href="/admin/opportunities">&larr; Back to opportunities</a></p>
<h2>${isNew ? 'New opportunity' : `Edit: ${esc(o.name)}`}</h2>
${errHtml}
<form method="POST" action="${action}" class="form">
  <div class="card">
    <h3>Basics</h3>
    ${reqField('name', 'Opportunity name', o.name)}
    ${optField('client_contract', 'Client / contract', o.client_contract)}
    ${optField('location', 'Location', o.location, { placeholder: '' })}
    ${optField('territory', 'Territory', o.territory)}
    ${optField('opportunity_type', 'Opportunity type', o.opportunity_type, { hint: 'e.g. Dedicated route, Dispatch support, RSP contract' })}
    <label>Start date <input type="date" name="start_date" value="${esc(o.start_date || '')}"></label>
    <label>End date <input type="date" name="end_date" value="${esc(o.end_date || '')}"></label>
    <label>Drivers needed <input type="number" name="drivers_needed" min="0" step="1" value="${o.drivers_needed || 0}"></label>
    <label>Vehicles needed <input type="number" name="vehicles_needed" min="0" step="1" value="${o.vehicles_needed || 0}"></label>
  </div>
  <div class="card">
    <h3>Requirements (used when comparing candidates)</h3>
    ${optField('vehicle_requirements', 'Vehicle requirements', o.vehicle_requirements, { type: 'textarea' })}
    ${optField('driver_requirements', 'Driver requirements', o.driver_requirements, { type: 'textarea' })}
    ${optField('insurance_requirements', 'Insurance requirements', o.insurance_requirements, { type: 'textarea' })}
    ${optField('availability_requirements', 'Availability requirements', o.availability_requirements, { type: 'textarea' })}
    ${optField('service_area', 'Service area', o.service_area, { type: 'textarea' })}
  </div>
  <div class="card">
    <h3>Notes, documents, contact</h3>
    ${optField('notes', 'Notes (internal)', o.notes, { type: 'textarea' })}
    ${optField('documents', 'Documents', o.documents, { type: 'textarea', hint: 'Document references only for now — full document upload/storage arrives in a later phase.' })}
    ${optField('contact_info', 'Contact info', o.contact_info, { type: 'textarea' })}
  </div>
  <button type="submit" class="btn">${isNew ? 'Create opportunity' : 'Save changes'}</button>
</form>`;
}

// --- Opportunity detail + matching --------------------------------------------------
function matchRecordRow(m, people) {
  const p = people[`${m.person_type}:${m.person_id}`];
  const href = m.person_type === 'lead' ? `/admin/crm/leads/${m.person_id}` : `/admin/drivers/${m.person_id}/profile`;
  return `<tr>
    <td><span class="status-badge">Potential Match</span></td>
    <td><a href="${href}"><strong>${esc(p ? p.name : `${m.person_type} #${m.person_id}`)}</strong></a><br>
      <span class="muted">${esc(p ? p.detail : m.person_type)}</span></td>
    <td>${esc(m.matched_by || '—')}<br><span class="muted">${fmtTs(m.ts)}</span></td>
    <td>${esc(m.note || '')}</td>
  </tr>`;
}

function compareTableHtml(rows) {
  if (!rows || !rows.length) return '';
  const trs = rows.map((r) => `<tr><td><strong>${esc(r.requirement)}</strong></td><td>${esc(r.required)}</td><td>${esc(r.candidate)}</td></tr>`).join('');
  return `
<div class="card">
  <h3>Candidate comparison</h3>
  <p class="microcopy">Side-by-side to help you judge fit. You decide — nothing here auto-promises anything.</p>
  <table class="admin-table">
  <thead><tr><th>Requirement</th><th>Opportunity needs</th><th>Candidate has</th></tr></thead>
  <tbody>${trs}</tbody>
  </table>
</div>`;
}

function opportunityDetailHtml({ opportunity: o, matches, people, leads, driversList, compare, compareLabel, error = '' }) {
  const statusOpts = opps.OPPORTUNITY_STATUSES.map(
    (s) => `<option value="${s}"${o.status === s ? ' selected' : ''}>${esc(s)}</option>`
  ).join('');
  const leadOpts = (leads || []).map((l) =>
    `<option value="${l.id}">${esc(`${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email)} — ${esc(l.lead_type)} · ${esc(l.status)}</option>`
  ).join('');
  const driverOpts = (driversList || []).map((d) =>
    `<option value="${d.id}">${esc(d.full_name)} — ${esc(d.email)}</option>`
  ).join('');
  const matchRows = (matches || []).map((m) => matchRecordRow(m, people)).join('');

  return `
<p><a href="/admin/opportunities">&larr; Back to opportunities</a></p>
${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
<h2>${esc(o.name)} ${statusBadge(o.status)}</h2>
<p class="muted">Created ${fmtTs(o.created_at)}${o.created_by ? ` by ${esc(o.created_by)}` : ''}</p>

<div class="card">
  <h3>Change status</h3>
  <form method="POST" action="/admin/opportunities/${o.id}/status" class="form">
    <label>Status <select name="status">${statusOpts}</select></label>
    <button type="submit" class="btn">Update status</button>
  </form>
</div>

<div class="card">
  <h3>Details</h3>
  ${kv('Client / contract', o.client_contract)}
  ${kv('Location', o.location)}
  ${kv('Territory', o.territory)}
  ${kv('Opportunity type', o.opportunity_type)}
  ${kv('Start / end', [o.start_date, o.end_date].filter(Boolean).join(' → '))}
  ${kv('Drivers needed', o.drivers_needed)}
  ${kv('Vehicles needed', o.vehicles_needed)}
  ${kv('Contact info', o.contact_info)}
  <h3>Requirements</h3>
  ${kv('Vehicle', o.vehicle_requirements)}
  ${kv('Driver', o.driver_requirements)}
  ${kv('Insurance', o.insurance_requirements)}
  ${kv('Availability', o.availability_requirements)}
  ${kv('Service area', o.service_area)}
  <h3>Notes &amp; documents</h3>
  ${kv('Notes', o.notes)}
  ${kv('Documents', o.documents)}
  <p><a class="btn btn-small" href="/admin/opportunities/${o.id}/edit">Edit opportunity</a></p>
</div>

<h2>Potential matches (${(matches || []).length})</h2>
<div class="card">
  <p class="microcopy"><strong>${esc(opps.POTENTIAL_MATCH_DISCLAIMER)}</strong></p>
  <p class="microcopy">Recording a match never promises employment, routes, loads, contracts, or income.</p>
</div>
${compare ? `<h3>Comparing: ${esc(compareLabel || '')}</h3>${compareTableHtml(compare.rows)}` : ''}
<div class="card">
  <h3>Compare a candidate, then record a Potential Match</h3>
  <form method="GET" action="/admin/opportunities/${o.id}" class="form">
    <label>CRM lead (Grow / Business / RSP)
      <select name="compare_lead"><option value="">— choose a lead —</option>${leadOpts}</select>
    </label>
    <button type="submit" class="btn btn-small">Compare lead</button>
  </form>
  <form method="GET" action="/admin/opportunities/${o.id}" class="form">
    <label>Driver
      <select name="compare_driver"><option value="">— choose a driver —</option>${driverOpts}</select>
    </label>
    <button type="submit" class="btn btn-small">Compare driver</button>
  </form>
</div>
${compare ? `
<div class="card">
  <h3>Record this Potential Match</h3>
  <form method="POST" action="/admin/opportunities/${o.id}/match" class="form">
    <input type="hidden" name="person_type" value="${esc(compare.personType)}">
    <input type="hidden" name="person_id" value="${esc(String(compare.personId))}">
    <label>Note (optional)
      <input type="text" name="note" placeholder="Why this looks like a fit">
    </label>
    <button type="submit" class="btn">Record Potential Match</button>
    <p class="microcopy">Recording a match never promises employment, routes, loads, contracts, or income.</p>
  </form>
</div>` : ''}
<table class="admin-table">
<thead><tr><th>Result</th><th>Person</th><th>Matched by / when</th><th>Note</th></tr></thead>
<tbody>${matchRows || '<tr><td colspan="4">No potential matches recorded yet.</td></tr>'}</tbody>
</table>`;
}

module.exports = {
  opportunityListHtml,
  opportunityFormHtml,
  opportunityDetailHtml,
  compareTableHtml,
};
