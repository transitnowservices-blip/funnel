'use strict';
/**
 * views/driver-extended.js — Phase 2 admin "extended driver profile".
 *
 * One operational view of a driver: contact, vehicle, insurance,
 * availability, service area, experience, qualification checklist,
 * documents (verification records — full upload/storage deferred to
 * Phase 6), routes, packages, exceptions, support tickets, training,
 * plan history, notes, CRM-lead linkage, and opportunity matches.
 *
 * It WIRES IN the existing A-L tables/views (routes, packages,
 * custody, exceptions, tickets, plans) — nothing is duplicated.
 * Rendered inside views/admin.js adminLayout by the backend.
 */
const { esc } = require('./layout');
const drivers = require('../lib/drivers');
const opps = require('../lib/opportunities');

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString();
}

function kv(label, value) {
  if (value == null || value === '') return '';
  return `<div><strong>${esc(label)}:</strong> ${esc(value)}</div>`;
}

function statusBadge(status) {
  const label = drivers.STATUS_LABELS[status] || status;
  return `<span class="status-badge status-${esc(status)}">${esc(label)}</span>`;
}

function extBadge(s) {
  return s ? `<span class="status-badge">Application: ${esc(s)}</span>` : '<span class="muted">No application started</span>';
}

function driverExtendedProfileHtml(p) {
  const {
    driver: d, qualChecks = {}, onboardHistory = [], routes = [], packages = [],
    exceptions = [], tickets = [], planHistory = [], matches = [],
    leadLink = null, opportunities = [], error = '',
  } = p;

  const checkedKeys = Object.keys(qualChecks);
  const statusOpts = drivers.EXTENDED_STATUSES.map(
    (s) => `<option value="${esc(s)}"${d.extended_status === s ? ' selected' : ''}>${esc(s)}</option>`
  ).join('');
  const prereqs = drivers.QUAL_CHECKS.slice(0, 9);
  const prereqsDone = prereqs.every((k) => checkedKeys.includes(k));

  const checkRows = drivers.QUAL_CHECKS.map((k) => {
    const rec = qualChecks[k];
    return `<label class="checkbox"><input type="checkbox" name="checks" value="${esc(k)}"${rec ? ' checked' : ''}>
      <strong>${esc(drivers.QUAL_CHECK_LABELS[k])}</strong>
      ${rec ? `<span class="muted"> — ${esc(rec.checked_by || '')} · ${fmtTs(rec.ts)}</span>` : ''}
    </label>`;
  }).join('\n');

  const histRows = (onboardHistory || []).map((h) => `
    <li><strong>${esc(h.from_status || '—')} → ${esc(h.to_status)}</strong>
      <span class="ts">${fmtTs(h.ts)} · by ${esc(h.changed_by || '')}</span>${h.note ? `<br>${esc(h.note)}` : ''}</li>`).join('');

  const routeRows = (routes || []).map((r) => `
    <tr><td><a href="/admin/routes/${r.id}"><strong>${esc(r.route_code)}</strong></a></td>
    <td>${esc(r.title || '')}</td><td>${esc(drivers.ROUTE_STATUS_LABELS[r.status] || r.status)}</td>
    <td>${esc(r.scheduled_date || '—')}</td></tr>`).join('');

  const pkgRows = (packages || []).slice(0, 50).map((x) => `
    <tr><td><a href="/admin/packages/${esc(x.package_id)}"><strong>${esc(x.package_id)}</strong></a></td>
    <td>${esc(x.recipient_name)}</td><td>${esc(drivers.PACKAGE_STATUS_LABELS[x.status] || x.status)}</td></tr>`).join('');

  const exRows = (exceptions || []).map((x) => `
    <tr><td><a href="/admin/packages/${esc(x.package_id)}">${esc(x.package_id)}</a></td>
    <td>${esc(drivers.EXCEPTION_TYPE_LABELS[x.exception_type] || x.exception_type)}</td>
    <td>${esc(drivers.EXCEPTION_STATUS_LABELS[x.status] || x.status)}</td>
    <td>${fmtTs(x.created_at)}</td></tr>`).join('');

  const ticketRows = (tickets || []).map((t) => `
    <tr><td><a href="/admin/tickets/${esc(t.ticket_id)}"><strong>${esc(t.ticket_id)}</strong></a></td>
    <td>${esc(t.subject)}</td><td>${t.priority === 'urgent' ? '<strong>URGENT</strong>' : esc(t.priority)}</td>
    <td>${esc(drivers.TICKET_STATUS_LABELS[t.status] || t.status)}</td></tr>`).join('');

  const planRows = (planHistory || []).map((h) => `
    <li><strong>${esc(h.event)}</strong> ${h.from_plan_id ? esc(h.from_plan_id) + ' → ' : ''}${esc(h.to_plan_id || '')}
    <span class="ts">${fmtTs(h.created_at)} · by ${esc(h.created_by)}</span></li>`).join('');

  const matchRows = (matches || []).map((m) => `
    <tr><td><span class="status-badge">Potential Match</span></td>
    <td>${m.opportunity ? `<a href="/admin/opportunities/${m.opportunity.id}"><strong>${esc(m.opportunity.name)}</strong></a>` : 'opportunity #' + m.opportunity_id}</td>
    <td>${esc(m.matched_by || '—')}<br><span class="muted">${fmtTs(m.ts)}</span></td>
    <td>${esc(m.note || '')}</td></tr>`).join('');

  const oppOpts = (opportunities || []).map((o) =>
    `<option value="${o.id}">${esc(o.name)} — ${esc(o.status)}</option>`).join('');

  const trainingDone = ['orientation', 'training'].filter((k) => checkedKeys.includes(k));

  return `
<p><a href="/admin/drivers/${d.id}">&larr; Back to driver pipeline record</a></p>
${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
<h2>${esc(d.full_name)} ${statusBadge(d.status)} ${extBadge(d.extended_status)}</h2>
<p class="muted">Pipeline status vs. application status are tracked separately. Applied: ${fmtTs(d.submitted_at)} ·
<a href="${esc(drivers.driverDashUrl(d.access_token))}">Driver dashboard link</a></p>

<div class="card">
  <h3>Application status</h3>
  <form method="POST" action="/admin/drivers/${d.id}/extended-status" class="form">
    <label>Extended application status
      <select name="extended_status">${statusOpts}</select>
    </label>
    <label>Note (optional) <input type="text" name="note" placeholder="Reason for the change"></label>
    <label class="checkbox"><input type="checkbox" name="notify" value="1"> Email the driver about this change</label>
    <button type="submit" class="btn">Update application status</button>
  </form>
  ${prereqsDone && !['APPROVED', 'READY FOR ROUTE', 'ACTIVE'].includes(d.extended_status || '')
    ? '<p><strong>All prerequisite checks are complete — this driver can be marked APPROVED.</strong></p>' : ''}
  <h4>Status history (append-only)</h4>
  <ul class="timeline">${histRows || '<li>No application history yet.</li>'}</ul>
</div>

<div class="card">
  <h3>Qualification checklist</h3>
  <form method="POST" action="/admin/drivers/${d.id}/qual-checks" class="form">
    ${checkRows}
    <button type="submit" class="btn">Save checklist</button>
    <p class="microcopy">Each completed check is stored with who completed it and when. Unchecking removes the record; the application status history above is never rewritten.</p>
  </form>
  <h4>Documents</h4>
  <p class="microcopy">Documents are tracked as verification records for now — full document upload and storage arrives in a later phase. Use the "Required documents received" check above plus a note on the pipeline record.</p>
</div>

<div class="card">
  <h3>Contact</h3>
  ${kv('Email', d.email)}
  ${kv('Phone', d.phone)}
  ${kv('Preferred contact', d.contact_method)}
  <h3>Vehicle</h3>
  ${kv('Type', d.vehicle_type)}
  ${kv('Year', d.vehicle_year)}
  ${kv('Make / model', d.vehicle_make_model)}
  ${kv('Cargo dimensions', d.cargo_dimensions)}
  ${kv('Payload capacity', d.payload_capacity)}
  ${kv('Equipment', d.equipment)}
  <h3>Insurance</h3>
  ${kv('Status (self-reported)', d.insurance_status)}
  ${kv('Carrier', d.insurance_carrier)}
  ${kv('Policy number', d.insurance_policy)}
  ${kv('Policy expiration', d.insurance_expiry)}
  ${kv('Insurance verification consent', d.consent_insurance_check ? 'Yes' : 'No')}
  <h3>License</h3>
  ${kv('License number', d.license_number)}
  ${kv('State / class', [d.license_state, d.license_class].filter(Boolean).join(' / '))}
  ${kv('Expiration', d.license_expiry)}
  ${kv('Background / MVR consent', d.consent_background ? 'Yes' : 'No')}
  ${kv('Driver agreement accepted', d.agreement_accepted ? `Yes — ${fmtTs(d.agreement_accepted_at)}` : 'No')}
  <h3>Availability &amp; service area</h3>
  ${kv('Days', (d.days_available || []).join(', '))}
  ${kv('Hours', d.hours_available)}
  ${kv('Start date', d.start_date)}
  ${kv('Status', d.availability_status)}
  ${kv('Home', [d.home_city, d.home_state].filter(Boolean).join(', '))}
  ${kv('Service radius', d.service_radius)}
  ${kv('Travel regions', d.travel_regions)}
  ${kv('Lane preferences', d.lane_prefs)}
  <h3>Experience &amp; business</h3>
  ${kv('Business name', d.business_name)}
  ${kv('Entity type', d.entity_type)}
  ${kv('MC number', d.mc_number)}
  ${kv('DOT number', d.dot_number)}
  ${kv('Years in business', d.years_in_business)}
  ${kv('Work preferences', (d.work_prefs || []).map((w) => drivers.WORK_PREF_LABELS[w] || w).join(', '))}
  ${kv('Looking for', (d.looking_for || []).map((w) => drivers.LOOKING_FOR_LABELS[w] || w).join(', '))}
</div>

<div class="card">
  <h3>CRM lead linkage</h3>
  ${leadLink && leadLink.lead
    ? `<p>Linked from CRM lead <a href="/admin/crm/leads/${leadLink.lead.id}"><strong>${esc(leadLink.lead.first_name)} ${esc(leadLink.lead.last_name)}</strong></a>
       (${esc(leadLink.lead.lead_type)} · ${esc(leadLink.lead.status)}) — linked ${fmtTs(leadLink.created_at)} by ${esc(leadLink.created_by || '')}.</p>
       <p>Extended application link (share with the candidate):<br>
       <span class="dash-link"><a href="/drivers/apply/${esc(d.access_token)}">/drivers/apply/${esc(d.access_token)}</a></span></p>`
    : '<p class="muted">Not linked to a CRM lead. Use "Start driver application" on the lead profile to link one.</p>'}
</div>

<div class="card">
  <h3>Potential matches (${matches.length})</h3>
  <p class="microcopy"><strong>${esc(opps.POTENTIAL_MATCH_DISCLAIMER)}</strong></p>
  <table class="admin-table">
  <thead><tr><th>Result</th><th>Opportunity</th><th>Matched by / when</th><th>Note</th></tr></thead>
  <tbody>${matchRows || '<tr><td colspan="4">No potential matches recorded for this driver.</td></tr>'}</tbody>
  </table>
  ${oppOpts ? `
  <form method="POST" action="/admin/drivers/${d.id}/match" class="form">
    <label>Record a Potential Match against
      <select name="opportunity_id">${oppOpts}</select>
    </label>
    <label>Note (optional) <input type="text" name="note" placeholder="Why this looks like a fit"></label>
    <button type="submit" class="btn btn-small">Record Potential Match</button>
  </form>` : '<p class="muted">Create an opportunity first to record matches.</p>'}
</div>

<div class="card">
  <h3>Routes (${routes.length})</h3>
  <table class="admin-table">
  <thead><tr><th>Route</th><th>Title</th><th>Status</th><th>Scheduled</th></tr></thead>
  <tbody>${routeRows || '<tr><td colspan="4">No routes assigned.</td></tr>'}</tbody>
  </table>
  <h3>Packages (${packages.length})</h3>
  <table class="admin-table">
  <thead><tr><th>Package</th><th>Recipient</th><th>Status</th></tr></thead>
  <tbody>${pkgRows || '<tr><td colspan="3">No packages assigned.</td></tr>'}</tbody>
  </table>
  ${packages.length > 50 ? '<p class="muted">Showing the first 50 packages.</p>' : ''}
</div>

<div class="card">
  <h3>Exceptions (${exceptions.length})</h3>
  <table class="admin-table">
  <thead><tr><th>Package</th><th>Type</th><th>Status</th><th>Reported</th></tr></thead>
  <tbody>${exRows || '<tr><td colspan="4">No exceptions.</td></tr>'}</tbody>
  </table>
  <h3>Support tickets (${tickets.length})</h3>
  <table class="admin-table">
  <thead><tr><th>Ticket</th><th>Subject</th><th>Priority</th><th>Status</th></tr></thead>
  <tbody>${ticketRows || '<tr><td colspan="4">No support tickets.</td></tr>'}</tbody>
  </table>
</div>

<div class="card">
  <h3>Training</h3>
  ${trainingDone.length
    ? `<ul>${trainingDone.map((k) => `<li><strong>${esc(drivers.QUAL_CHECK_LABELS[k])}</strong> — ${esc(qualChecks[k].checked_by || '')} · ${fmtTs(qualChecks[k].ts)}</li>`).join('')}</ul>`
    : '<p class="muted">No orientation/training checks completed yet. (Live training sessions arrive in a later phase.)</p>'}
  <h3>Service plan history</h3>
  <ul class="timeline">${planRows || '<li>No plan changes.</li>'}</ul>
  <h3>Notes</h3>
  <pre class="config-view">${esc(d.notes || 'No notes yet.')}</pre>
  <p><a class="btn btn-small" href="/admin/drivers/${d.id}">Add notes on the pipeline record</a></p>
</div>`;
}

module.exports = { driverExtendedProfileHtml };
