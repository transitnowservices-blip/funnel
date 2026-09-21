'use strict';
/**
 * views/contracts.js — Phase 3 admin pages for the contract / client hub
 * (spec section 19). Rendered inside views/admin.js adminLayout by the
 * backend. No guarantee language anywhere; documents are references only
 * (full upload/storage arrives in Phase 6).
 */
const { esc } = require('./layout');
const contracts = require('../lib/contracts');

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString();
}
function fmtDate(d) {
  return d ? esc(d) : '—';
}
function statusBadge(status) {
  return `<span class="status-badge">${esc(status)}</span>`;
}
function kv(label, value) {
  if (value == null || value === '') return '';
  return `<div><strong>${esc(label)}:</strong> ${esc(String(value))}</div>`;
}

// --- List ----------------------------------------------------------------------
function contractListHtml({ list, counts, statusFilter }) {
  const tabs = contracts.CONTRACT_STATUSES.map((s) => {
    const active = statusFilter === s ? ' class="active"' : '';
    return `<a${active} href="/admin/contracts?status=${encodeURIComponent(s)}">${esc(s)} (${counts[s] || 0})</a>`;
  }).join('');
  const allActive = !statusFilter ? ' class="active"' : '';
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rows = list.map((c) => `
    <tr>
      <td><a href="/admin/contracts/${c.id}"><strong>${esc(c.contract_name)}</strong></a><br>
        <span class="muted">${esc(c.contract_number || '')}</span></td>
      <td>${esc(c.client || '—')}</td>
      <td>${esc(c.contract_type || '—')}</td>
      <td>${esc(c.territory || '—')}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${fmtDate(c.start_date)}${c.end_date ? ' → ' + fmtDate(c.end_date) : ''}</td>
      <td>${fmtTs(c.updated_at)}</td>
    </tr>`).join('');
  return `
<h2>Contract hub</h2>
<p class="microcopy">Client contracts, from first lead to active — every status change is kept in a timestamped history. Recording a contract here never promises work, routes, loads, or income to anyone.</p>
<div class="pipeline-nav"><a${allActive} href="/admin/contracts">All (${total})</a>${tabs}</div>
<p><a class="btn" href="/admin/contracts/new">+ New contract</a></p>
<table class="admin-table">
<thead><tr><th>Contract</th><th>Client</th><th>Type</th><th>Territory</th><th>Status</th><th>Term</th><th>Updated</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No contracts yet.</td></tr>'}</tbody>
</table>`;
}

// --- New / edit form --------------------------------------------------------------
function reqField(name, label, value) {
  return `<label>${esc(label)} *
    <input type="text" name="${esc(name)}" value="${esc(value || '')}" required>
  </label>`;
}
function optField(name, label, value, { type = 'text', rows = 3, hint = '' } = {}) {
  if (type === 'textarea') {
    return `<label>${esc(label)}
      <textarea name="${esc(name)}" rows="${rows}">${esc(value || '')}</textarea>
      ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
    </label>`;
  }
  if (type === 'date') {
    return `<label>${esc(label)} <input type="date" name="${esc(name)}" value="${esc(value || '')}"></label>`;
  }
  return `<label>${esc(label)}
    <input type="${type}" name="${esc(name)}" value="${esc(value || '')}">
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </label>`;
}

function contractFormHtml({ contract: c = {}, errors = [], isNew = true }) {
  const errHtml = errors.length
    ? `<div class="form-error" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  const action = isNew ? '/admin/contracts' : `/admin/contracts/${c.id}`;
  return `
<p><a href="/admin/contracts">&larr; Back to contracts</a></p>
<h2>${isNew ? 'New contract' : `Edit: ${esc(c.contract_name || '')}`}</h2>
${errHtml}
<form method="POST" action="${action}" class="form">
  <div class="card">
    <h3>Basics</h3>
    ${reqField('client', 'Client', c.client)}
    ${reqField('contract_name', 'Contract name', c.contract_name)}
    ${optField('contract_type', 'Contract type', c.contract_type, { hint: 'e.g. Dedicated routes, Last-mile overflow, Dispatch support' })}
    ${optField('territory', 'Territory', c.territory, { hint: 'Match a territory name so territory reporting picks this up' })}
    ${optField('service_area', 'Service area', c.service_area, { type: 'textarea' })}
    ${optField('start_date', 'Start date', c.start_date, { type: 'date' })}
    ${optField('end_date', 'End date', c.end_date, { type: 'date' })}
  </div>
  <div class="card">
    <h3>Requirements</h3>
    ${optField('route_requirements', 'Route requirements', c.route_requirements, { type: 'textarea' })}
    ${optField('package_requirements', 'Package requirements', c.package_requirements, { type: 'textarea' })}
    ${optField('vehicle_requirements', 'Vehicle requirements', c.vehicle_requirements, { type: 'textarea' })}
    ${optField('driver_requirements', 'Driver requirements', c.driver_requirements, { type: 'textarea' })}
    ${optField('insurance_requirements', 'Insurance requirements', c.insurance_requirements, { type: 'textarea' })}
    ${optField('performance_requirements', 'Performance requirements', c.performance_requirements, { type: 'textarea' })}
  </div>
  <div class="card">
    <h3>Terms, documents, notes</h3>
    ${optField('payment_terms', 'Payment terms', c.payment_terms, { type: 'textarea' })}
    ${optField('documents', 'Documents (references)', c.documents, { type: 'textarea', hint: 'Reference names/IDs only for now — full document upload and storage arrives in Phase 6.' })}
    ${optField('notes', 'Notes (internal)', c.notes, { type: 'textarea' })}
  </div>
  <button type="submit" class="btn">${isNew ? 'Create contract' : 'Save changes'}</button>
</form>`;
}

// --- Detail -----------------------------------------------------------------------
function contractDetailHtml({ contract: c, history, documents, opportunity, relatedOpps, linkedRoutes, allOpportunities, error = '' }) {
  const statusOpts = contracts.CONTRACT_STATUSES.map(
    (s) => `<option value="${esc(s)}"${c.status === s ? ' selected' : ''}>${esc(s)}</option>`
  ).join('');
  const oppOpts = (allOpportunities || []).map((o) =>
    `<option value="${o.id}"${c.opportunity_id === o.id ? ' selected' : ''}>${esc(o.name)} — ${esc(o.status)}${o.client_contract ? ` (${esc(o.client_contract)})` : ''}</option>`
  ).join('');
  const histRows = (history || []).map((h) => `
    <tr><td>${fmtTs(h.ts)}</td><td>${esc(h.from_status || '—')} → ${esc(h.to_status)}</td>
    <td>${esc(h.changed_by || '')}</td><td>${esc(h.note || '')}</td></tr>`).join('');
  const docRows = (documents || []).map((d) => `
    <tr><td>${esc(d.doc_type || '—')}</td><td>${esc(d.file_name || '—')}</td>
    <td>${esc(d.notes || '')}</td><td>${esc(d.uploaded_by || '')}<br><span class="muted">${fmtTs(d.uploaded_at)}</span></td></tr>`).join('');
  const routeRows = (linkedRoutes || []).map((r) => `
    <tr><td><a href="/admin/routes/${r.id}">${esc(r.route_code)}</a></td>
    <td>${esc(r.title || '')}</td><td>${esc(r.status)}</td></tr>`).join('');
  const relatedRows = (relatedOpps || []).map((o) => `
    <tr><td><a href="/admin/opportunities/${o.id}">${esc(o.name)}</a></td>
    <td>${esc(o.client_contract || '—')}</td><td>${esc(o.status)}</td></tr>`).join('');

  return `
<p><a href="/admin/contracts">&larr; Back to contracts</a></p>
${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
<h2>${esc(c.contract_name)} ${statusBadge(c.status)}</h2>
<p class="muted">${esc(c.contract_number || '')} · Created ${fmtTs(c.created_at)}${c.created_by ? ` by ${esc(c.created_by)}` : ''}</p>

<div class="card">
  <h3>Change status</h3>
  <form method="POST" action="/admin/contracts/${c.id}/status" class="form">
    <label>Status <select name="status">${statusOpts}</select></label>
    <label>Note (optional) <input type="text" name="note" placeholder="Why the change"></label>
    <button type="submit" class="btn">Update status</button>
  </form>
</div>

<div class="card">
  <h3>Details</h3>
  ${kv('Client', c.client)}
  ${kv('Contract type', c.contract_type)}
  ${kv('Territory', c.territory ? `<a href="/admin/territories?name=${encodeURIComponent(c.territory)}">${esc(c.territory)}</a>` : '')}
  ${kv('Service area', c.service_area)}
  ${kv('Term', [c.start_date, c.end_date].filter(Boolean).join(' → '))}
  <h3>Requirements</h3>
  ${kv('Route', c.route_requirements)}
  ${kv('Package', c.package_requirements)}
  ${kv('Vehicle', c.vehicle_requirements)}
  ${kv('Driver', c.driver_requirements)}
  ${kv('Insurance', c.insurance_requirements)}
  ${kv('Performance', c.performance_requirements)}
  <h3>Terms &amp; notes</h3>
  ${kv('Payment terms', c.payment_terms)}
  ${kv('Documents (references)', c.documents)}
  ${kv('Notes', c.notes)}
  <p><a class="btn btn-small" href="/admin/contracts/${c.id}/edit">Edit contract</a></p>
</div>

<div class="card">
  <h3>Linked opportunity</h3>
  ${opportunity
    ? `<p><a href="/admin/opportunities/${opportunity.id}"><strong>${esc(opportunity.name)}</strong></a> — ${esc(opportunity.status)}</p>
       <form method="POST" action="/admin/contracts/${c.id}/opportunity" class="form">
         <input type="hidden" name="opportunity_id" value="">
         <button type="submit" class="btn btn-small">Unlink opportunity</button>
       </form>`
    : `<p class="muted">No opportunity explicitly linked.</p>`}
  <form method="POST" action="/admin/contracts/${c.id}/opportunity" class="form">
    <label>Link an opportunity
      <select name="opportunity_id"><option value="">— choose —</option>${oppOpts}</select>
    </label>
    <button type="submit" class="btn btn-small">Link opportunity</button>
  </form>
  ${relatedRows ? `<h3>Opportunities referencing this contract</h3>
  <table class="admin-table"><thead><tr><th>Opportunity</th><th>Client / contract ref</th><th>Status</th></tr></thead>
  <tbody>${relatedRows}</tbody></table>
  <p class="microcopy">Matched by the opportunity's client/contract reference text mentioning this contract's number, name, or client. Read-only here.</p>` : ''}
</div>

<div class="card">
  <h3>Linked routes (${(linkedRoutes || []).length})</h3>
  <p class="microcopy">Routes from the existing route system (A–L) running under this contract. Linking a route never promises it to any driver.</p>
  <form method="POST" action="/admin/contracts/${c.id}/route" class="form">
    <label>Attach route by code <input type="text" name="route_code" placeholder="TNR-2026-0001"></label>
    <button type="submit" class="btn btn-small">Attach route</button>
  </form>
  <table class="admin-table"><thead><tr><th>Route code</th><th>Title</th><th>Status</th></tr></thead>
  <tbody>${routeRows || '<tr><td colspan="3">No routes linked yet.</td></tr>'}</tbody></table>
</div>

<div class="card">
  <h3>Document references (${(documents || []).length})</h3>
  <p class="microcopy"><strong>Placeholder:</strong> references only — file upload and secure document storage arrive in Phase 6 (spec section 23).</p>
  <form method="POST" action="/admin/contracts/${c.id}/document" class="form">
    <label>Document type <input type="text" name="doc_type" placeholder="e.g. Master services agreement"></label>
    <label>File / reference name <input type="text" name="file_name" placeholder="e.g. MSA-2026-signed.pdf"></label>
    <label>Notes <input type="text" name="notes"></label>
    <button type="submit" class="btn btn-small">Add reference</button>
  </form>
  <table class="admin-table"><thead><tr><th>Type</th><th>Reference</th><th>Notes</th><th>Added</th></tr></thead>
  <tbody>${docRows || '<tr><td colspan="4">No document references yet.</td></tr>'}</tbody></table>
</div>

<h2>Status history</h2>
<table class="admin-table"><thead><tr><th>When</th><th>Change</th><th>By</th><th>Note</th></tr></thead>
<tbody>${histRows || '<tr><td colspan="4">No history.</td></tr>'}</tbody></table>`;
}

module.exports = {
  contractListHtml,
  contractFormHtml,
  contractDetailHtml,
};
