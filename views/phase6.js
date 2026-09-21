// views/phase6.js — Phase 6 HTML: referrals, alerts, documents (admin) and
// driver referral/documents pages. Renders inside adminLayout (admin) or
// page() (driver). Additive — nothing existing is touched.
'use strict';

const { esc } = require('./layout');
const referrals = require('../lib/referrals');
const alerts = require('../lib/alerts');
const documents = require('../lib/documents');
const followups = require('../lib/followups');

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString();
}
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleDateString();
}

// --- Referrals (admin) ----------------------------------------------------------
function referralsAdminHtml({ codes = [], attributions = [], opportunities = [], error = '', attributed = null }) {
  const codeRows = (codes || []).map((c) => `
    <tr>
      <td><strong>${esc(c.code)}</strong></td>
      <td>${esc(c.issued_to_type)} #${c.issued_to_id != null ? esc(String(c.issued_to_id)) : '—'}${c.issued_to_name ? `<br><span class="muted">${esc(c.issued_to_name)}</span>` : ''}</td>
      <td>${fmtTs(c.issued_at)}</td>
      <td>${esc(c.status)}</td>
      <td>${c.status === 'active'
        ? `<form method="POST" action="/admin/referrals/${c.id}/revoke" style="display:inline"><button type="submit" class="btn btn-small">Revoke</button></form>`
        : `<span class="muted">revoked ${fmtTs(c.revoked_at)}</span>`}</td>
    </tr>`).join('');

  const oppOpts = (opportunities || []).map((o) =>
    `<option value="${o.id}">${escAttr(o.name)} (${escAttr(o.status)})</option>`).join('');

  const attrRows = (attributions || []).map((a) => `
    <tr>
      <td><strong>${esc(a.code || '—')}</strong></td>
      <td>${esc(a.referred_name || '—')}${a.referred_email ? `<br><span class="muted">${esc(a.referred_email)}</span>` : ''}</td>
      <td>${a.referred_lead_id ? `<a href="/admin/crm/leads/${a.referred_lead_id}">Lead #${a.referred_lead_id}</a>` : '—'}</td>
      <td>${esc(a.status)}</td>
      <td>${esc(a.outcome || '—')}</td>
      <td>
        <form method="POST" action="/admin/referrals/attributions/${a.id}" class="filter-form" style="flex-wrap:wrap">
          <select name="status" aria-label="Attribution status">
            ${referrals.ATTRIBUTION_STATUSES.map((s) => `<option value="${s}"${a.status === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          ${oppOpts ? `<select name="opportunity_id" aria-label="Opportunity"><option value="">— no opportunity —</option>${oppOpts}</select>` : ''}
          <input type="text" name="outcome" placeholder="Outcome (optional)" value="${escAttr(a.outcome || '')}" style="min-height:44px">
          <button type="submit" class="btn btn-small">Update</button>
        </form>
      </td>
    </tr>`).join('');

  return `
${error ? `<div class="grow-errors" role="alert">${esc(error)}</div>` : ''}
${attributed ? `<div class="card"><p>Attribution scan complete: ${attributed.created} new, ${attributed.updated} updated.</p></div>` : ''}
<div class="card" style="border-left:4px solid #b7791f">
  <h3>Referral program status</h3>
  <p><strong>${esc(referrals.NO_PAYMENT_COPY)}</strong></p>
  <p class="microcopy">Codes exist for tracking only. Do not promise payments, bonuses, or compensation when sharing codes.</p>
</div>

<h3>Issue a referral code</h3>
<div class="card">
  <form method="POST" action="/admin/referrals/issue" class="filter-form">
    <label>Issue to
      <select name="issued_to_type">
        <option value="driver">Driver</option>
        <option value="lead">Lead</option>
      </select>
    </label>
    <input type="email" name="email" placeholder="Driver/lead email" required style="min-height:44px;min-width:220px">
    <input type="text" name="notes" placeholder="Internal notes (optional)" style="min-height:44px;flex:1;min-width:200px">
    <button type="submit" class="btn">Issue code</button>
  </form>
  <p class="microcopy">The code is linked to the driver or opportunity lead found by email. New codes are unique (TN-XXXXXX).</p>
</div>

<h3>Referral codes (${(codes || []).length})</h3>
<table class="admin-table"><thead><tr><th>Code</th><th>Issued to</th><th>Issued</th><th>Status</th><th></th></tr></thead>
<tbody>${codeRows || '<tr><td colspan="5">No codes issued yet.</td></tr>'}</tbody></table>

<h3>Attributions (${(attributions || []).length})</h3>
<form method="POST" action="/admin/referrals/attribute" style="margin-bottom:12px">
  <button type="submit" class="btn">Run attribution scan</button>
</form>
<p class="microcopy">Matches applications carrying a referral code (from the grow application) to issued codes. Tracks: referral source, referred person, application, status, opportunity, outcome.</p>
<table class="admin-table"><thead><tr><th>Code</th><th>Referred person</th><th>Application</th><th>Status</th><th>Outcome</th><th>Update</th></tr></thead>
<tbody>${attrRows || '<tr><td colspan="6">No attributions yet. Run the scan after codes have been shared.</td></tr>'}</tbody></table>`;
}

// --- Alerts (admin) --------------------------------------------------------------
function alertsAdminHtml({ alertsList = [], prefs = {}, reminders = [], error = '' }) {
  const types = Object.keys(alerts.ALERT_TYPES);
  const rows = (alertsList || []).map((a) => {
    const label = alerts.ALERT_TYPES[a.alert_type] ? alerts.ALERT_TYPES[a.alert_type].label : a.alert_type;
    return `<tr>
      <td>${esc(label)}</td>
      <td><strong>${esc(a.title)}</strong>${a.detail ? `<br><span class="muted">${esc(a.detail)}</span>` : ''}</td>
      <td>${esc(a.severity || 'info')}</td>
      <td>${esc(a.status)}</td>
      <td>${fmtTs(a.ts)}${a.notified_at ? '<br><span class="muted">ops notified</span>' : ''}</td>
      <td>${a.status === 'open'
        ? `<form method="POST" action="/admin/alerts/${a.id}/acknowledge" style="display:inline"><button type="submit" class="btn btn-small">Acknowledge</button></form>
           <form method="POST" action="/admin/alerts/${a.id}/resolve" style="display:inline"><button type="submit" class="btn btn-small">Resolve</button></form>`
        : `<span class="muted">${a.acknowledged_by ? 'by ' + esc(a.acknowledged_by) : ''} ${a.acknowledged_at ? fmtTs(a.acknowledged_at) : ''}${a.resolved_at ? 'resolved ' + fmtTs(a.resolved_at) : ''}</span>`}</td>
    </tr>`;
  }).join('');

  const prefBoxes = types.map((t) => {
    const on = prefs[t] ? Number(prefs[t].notify_enabled) : 1;
    return `<label class="check"><input type="checkbox" name="type_${t}" value="1"${on ? ' checked' : ''}><span>${esc(alerts.ALERT_TYPES[t].label)}</span></label>`;
  }).join('');

  const remRows = (reminders || []).map((r) => `
    <tr>
      <td><a href="/admin/crm/leads/${r.lead_id}">#${r.lead_id} ${esc(r.first_name || '')} ${esc(r.last_name || '')}</a></td>
      <td>${esc(r.followup_status)}</td>
      <td>${fmtDate(r.next_follow_up_at)}</td>
      <td>${esc(r.assigned_to || '—')}</td>
      <td>${esc(r.note || '')}</td>
    </tr>`).join('');

  return `
${error ? `<div class="grow-errors" role="alert">${esc(error)}</div>` : ''}
<h3>Alert generation</h3>
<div class="card">
  <form method="POST" action="/admin/alerts/generate" style="display:inline">
    <button type="submit" class="btn">Generate alerts from live data</button>
  </form>
  <p class="microcopy">Scans real tables: urgent support tickets, package exceptions, lost packages, delays, driver/vehicle issues, new applicants, RSP and business leads, required documents, expiring documents. New alerts are deduplicated (one per source) and alerts whose cause cleared are auto-resolved. When a type is enabled below, a new alert also queues an ops email (check the email outbox — email/SMS providers are not configured, so nothing is delivered).</p>
</div>

<h3>Notification preferences</h3>
<div class="card">
  <form method="POST" action="/admin/alerts/prefs">
    <p class="microcopy">Checked types queue an ops email when a new alert fires. Unchecked types still appear here.</p>
    ${prefBoxes}
    <div><button type="submit" class="btn">Save preferences</button></div>
  </form>
</div>

<h3>Overdue follow-up reminders (${(reminders || []).length})</h3>
<table class="admin-table"><thead><tr><th>Lead</th><th>Status</th><th>Was due</th><th>Assigned</th><th>Note</th></tr></thead>
<tbody>${remRows || '<tr><td colspan="5">No overdue follow-ups.</td></tr>'}</tbody></table>

<h3>Alerts (${(alertsList || []).length})</h3>
<table class="admin-table"><thead><tr><th>Type</th><th>Alert</th><th>Severity</th><th>Status</th><th>Raised</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No alerts. Generate alerts from live data above.</td></tr>'}</tbody></table>`;
}

// --- Documents (admin) ------------------------------------------------------------
function documentsAdminHtml({ docs = [], error = '', ownerType = '', ownerId = '' }) {
  const typeOpts = Object.entries(documents.DOC_TYPES).map(([t, d]) =>
    `<option value="${t}">${escAttr(d.label)}${d.sensitive ? ' (admin-only)' : ''}</option>`).join('');
  const ownerOpts = documents.OWNER_TYPES.map((t) =>
    `<option value="${t}"${ownerType === t ? ' selected' : ''}>${t}</option>`).join('');
  const rows = (docs || []).map((d) => {
    const label = documents.DOC_TYPES[d.doc_type] ? documents.DOC_TYPES[d.doc_type].label : d.doc_type;
    return `<tr>
      <td>${esc(label)}${documents.isSensitive(d.doc_type) ? '<br><span class="muted">admin-only</span>' : ''}</td>
      <td>${esc(d.file_name || '—')}<br><span class="muted">${esc(d.file_mime || '')} · ${d.size_bytes != null ? (Number(d.size_bytes) / 1024).toFixed(1) + ' KB' : '—'}</span></td>
      <td>${esc(d.owner_type)} #${d.owner_id != null ? esc(String(d.owner_id)) : '—'}</td>
      <td>${fmtTs(d.uploaded_at)}<br><span class="muted">by ${esc(d.uploaded_by || '')} (${esc(d.uploaded_by_role || '')})</span></td>
      <td>${d.expires_at ? fmtDate(d.expires_at) : '—'}</td>
      <td>${esc(d.status)} / ${esc(d.verification_status)}</td>
      <td>
        <a class="btn btn-small" href="/admin/documents/${d.id}/download">Download</a>
        <form method="POST" action="/admin/documents/${d.id}/verify" style="display:inline;margin-top:4px">
          <input type="hidden" name="status" value="approved">
          <input type="hidden" name="verification_status" value="verified">
          <button type="submit" class="btn btn-small">Approve + verify</button>
        </form>
        <form method="POST" action="/admin/documents/${d.id}/verify" style="display:inline;margin-top:4px">
          <input type="hidden" name="status" value="rejected">
          <input type="hidden" name="verification_status" value="rejected">
          <button type="submit" class="btn btn-small">Reject</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `
${error ? `<div class="grow-errors" role="alert">${esc(error)}</div>` : ''}
<h3>Upload a document</h3>
<div class="card">
  <form method="POST" action="/admin/documents/upload" enctype="multipart/form-data" class="filter-form">
    <label>Owner type <select name="owner_type">${ownerOpts}</select></label>
    <input type="number" name="owner_id" placeholder="Owner ID (driver/lead/contract/business)" value="${escAttr(ownerId)}" style="min-height:44px;min-width:220px" required>
    <label>Document type <select name="doc_type">${typeOpts}</select></label>
    <label>Expires <input type="date" name="expires_at" style="min-height:44px"></label>
    <input type="text" name="notes" placeholder="Notes (optional)" style="min-height:44px;flex:1;min-width:160px">
    <input type="file" name="file" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf" required>
    <button type="submit" class="btn">Upload</button>
  </form>
  <p class="microcopy">Images (PNG/JPG/GIF/WebP) or PDF, up to 8 MB. Files are stored securely server-side (same database-blob pattern as exception photos) and are never publicly reachable — admin-only types (W-9) are never shown to drivers.</p>
</div>

<h3>Documents (${(docs || []).length})</h3>
<form method="GET" action="/admin/documents" class="filter-form" style="margin-bottom:12px">
  <label>Owner type <select name="owner_type"><option value="">— all —</option>${documents.OWNER_TYPES.map((t) => `<option value="${t}"${ownerType === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
  <label>Type <select name="doc_type"><option value="">— all —</option>${Object.entries(documents.DOC_TYPES).map(([t, d]) => `<option value="${t}">${escAttr(d.label)}</option>`).join('')}</select></label>
  <label>Status <select name="status"><option value="">— all —</option>${['pending', 'approved', 'rejected', 'unverified', 'verified'].map((s) => `<option value="${s}">${s}</option>`).join('')}</select></label>
  <button type="submit" class="btn btn-small">Filter</button>
</form>
<table class="admin-table"><thead><tr><th>Type</th><th>File</th><th>Owner</th><th>Uploaded</th><th>Expires</th><th>Status / verification</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No documents yet.</td></tr>'}</tbody></table>`;
}

// --- Follow-up section for the CRM lead profile (extends Phase-1 profile) ---------
function leadFollowupHtml({ lead, latest = null, history = [], attempts = 0, referralAttr = null }) {
  const statusOpts = followups.FOLLOWUP_STATUSES.map((s) =>
    `<option value="${escAttr(s)}"${latest && latest.followup_status === s ? ' selected' : ''}>${esc(s)}</option>`).join('');
  const histRows = (history || []).map((f) => `
    <tr>
      <td>${fmtTs(f.created_at)}</td>
      <td>${esc(f.followup_status)}</td>
      <td>${f.last_contact_at ? fmtDate(f.last_contact_at) : '—'}</td>
      <td>${f.next_follow_up_at ? fmtDate(f.next_follow_up_at) : '—'}${f.reminder ? ' <span class="muted">(reminder)</span>' : ''}</td>
      <td>${esc(f.assigned_to || '—')}</td>
      <td>${f.contact_attempt ? 'Yes' : 'No'}</td>
      <td>${esc(f.outcome || '—')}</td>
      <td>${esc(f.note || '')}</td>
    </tr>`).join('');

  const referralBox = referralAttr
    ? `<p>Referred via code <strong>${esc(referralAttr.code || '')}</strong> (issued to ${esc(referralAttr.code_id ? 'code #' + referralAttr.code_id : '—')}) · referral status: ${esc(referralAttr.status)}${referralAttr.outcome ? ` · outcome: ${esc(referralAttr.outcome)}` : ''}. <span class="muted">${esc(referrals.NO_PAYMENT_COPY)}</span></p>`
    : '';

  return `
<h3>Follow-up &amp; assignment</h3>
${referralBox}
<div class="card">
  <p><strong>Last contact:</strong> ${latest && latest.last_contact_at ? fmtDate(latest.last_contact_at) : (lead.last_contact ? fmtDate(lead.last_contact) : '—')} ·
  <strong>Next follow-up:</strong> ${latest && latest.next_follow_up_at ? fmtDate(latest.next_follow_up_at) : (lead.follow_up_date || '—')} ·
  <strong>Assigned:</strong> ${esc((latest && latest.assigned_to) || lead.assigned_to || '—')} ·
  <strong>Contact attempts logged:</strong> ${attempts}</p>
  <form method="POST" action="/admin/crm/leads/${lead.id}/followup" class="filter-form">
    <label>Status <select name="followup_status" aria-label="Follow-up status">${statusOpts}</select></label>
    <label>Next follow-up <input type="date" name="next_follow_up_at" style="min-height:44px"></label>
    <input type="text" name="assigned_to" placeholder="Assigned team member" value="${escAttr((latest && latest.assigned_to) || lead.assigned_to || '')}" style="min-height:44px">
    <input type="text" name="outcome" placeholder="Outcome (optional)" style="min-height:44px">
    <label class="check"><input type="checkbox" name="contact_attempt" value="1"><span>Log as contact attempt (sets last contact to today)</span></label>
    <label class="check"><input type="checkbox" name="reminder" value="1"><span>Create reminder</span></label>
    <input type="text" name="note" placeholder="Follow-up note" style="min-height:44px;flex:1;min-width:200px">
    <button type="submit" class="btn">Save follow-up</button>
  </form>
  <p class="microcopy">Reminders with a due date appear under Alerts → Overdue follow-up reminders. Status is one of: CONTACT TODAY, FOLLOW UP, WAITING ON DOCUMENTS, WAITING ON RESPONSE, OPPORTUNITY PENDING, NURTURE, CLOSED.</p>
</div>
${histRows ? `<table class="admin-table"><thead><tr><th>Logged</th><th>Status</th><th>Last contact</th><th>Next follow-up</th><th>Assigned</th><th>Attempt</th><th>Outcome</th><th>Note</th></tr></thead><tbody>${histRows}</tbody></table>` : '<p class="muted">No follow-up history yet.</p>'}`;
}

// --- Driver referral page ---------------------------------------------------------
function driverReferralHtml({ driver, code, baseUrl }) {
  const shareLink = code ? `${baseUrl}/grow/apply?ref=${encodeURIComponent(code.code)}` : '';
  return `
<section>
  <h1>Referrals</h1>
  <div class="card" style="border-left:4px solid #b7791f">
    <p><strong>${esc(referrals.NO_PAYMENT_COPY)}</strong></p>
  </div>
  ${code ? `
  <div class="card highlight-card">
    <h3>Your referral code</h3>
    <p class="dash-link"><strong style="font-size:28px;letter-spacing:2px">${esc(code.code)}</strong></p>
    <p>Share this link — it carries your code into the application:</p>
    <p class="dash-link"><a href="${esc(shareLink)}">${esc(shareLink)}</a></p>
    <p class="microcopy">When someone applies using your code, operations can see the attribution. This is tracking only — see the note above about payments.</p>
  </div>` : `
  <div class="card">
    <p>No referral code has been issued to you yet. If you'd like one, contact TransitNow operations.</p>
  </div>`}
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
}

// --- Driver documents page ---------------------------------------------------------
function driverDocumentsHtml({ driver, docs = [], error = '' }) {
  const typeOpts = Object.entries(documents.DOC_TYPES)
    .filter(([, d]) => !d.sensitive)
    .map(([t, d]) => `<option value="${t}">${escAttr(d.label)}</option>`).join('');
  const rows = (docs || []).map((d) => {
    const label = documents.DOC_TYPES[d.doc_type] ? documents.DOC_TYPES[d.doc_type].label : d.doc_type;
    return `<tr>
      <td>${esc(label)}</td>
      <td>${esc(d.file_name || '—')}<br><span class="muted">${esc(d.file_mime || '')}</span></td>
      <td>${fmtTs(d.uploaded_at)}</td>
      <td>${d.expires_at ? fmtDate(d.expires_at) : '—'}</td>
      <td>${esc(d.status)} / ${esc(d.verification_status)}</td>
      <td><a class="btn btn-small" href="/d/${esc(driver.access_token)}/documents/${d.id}/download">Download</a></td>
    </tr>`;
  }).join('');
  return `
<section>
  <h1>My documents</h1>
  ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
  <div class="card">
    <h3>Upload a document</h3>
    <form method="POST" action="/d/${esc(driver.access_token)}/documents/upload" enctype="multipart/form-data" class="form">
      <label class="grow-field">Document type
        <select name="doc_type" class="big-btn" style="min-height:48px">${typeOpts}</select>
      </label>
      <label class="grow-field">Expires (if applicable)
        <input type="date" name="expires_at" style="min-height:48px">
      </label>
      <label class="grow-field">Document file (PNG, JPG, GIF, WebP, or PDF — up to 8 MB)
        <input type="file" name="file" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf" required style="min-height:48px">
      </label>
      <button type="submit" class="btn big-btn">UPLOAD DOCUMENT</button>
    </form>
    <p class="microcopy">Documents are stored securely and only you and operations can see them. Some document types (for example tax forms) are handled directly by operations staff — contact them if asked for one.</p>
  </div>
  <h2>Your documents</h2>
  <table class="admin-table"><thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th>Expires</th><th>Status / verification</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6">No documents uploaded yet.</td></tr>'}</tbody></table>
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
}

module.exports = {
  referralsAdminHtml,
  alertsAdminHtml,
  documentsAdminHtml,
  leadFollowupHtml,
  driverReferralHtml,
  driverDocumentsHtml,
};
