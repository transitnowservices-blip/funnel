// views/analytics.js — Phase 7: growth ecosystem analytics (spec section 26).
// Renders GET /admin/analytics inside views/admin.js adminLayout.
// Every number is computed live by lib/analytics.js from the real tables.
// Definitions of Started / Completed / Conversion rate and all other derived
// metrics are stated in the page footnotes — never presented without their
// meaning. No guarantee language.
'use strict';
const { esc } = require('./layout');

const FUNNEL_PAGE_LABELS = {
  '/grow': 'Grow landing',
  '/grow/apply': 'Application form',
  '/business': 'Businesses',
  '/rsp': 'RSP interest',
  '/dispatch': 'Dispatch',
};

function windowNav(a) {
  const window = a.window;
  const links = (a.windowOptions || []).map((opt) => {
    const label = opt === 'all' ? 'All time' : `${opt}d`;
    const active = window.key === opt;
    return `<a class="btn btn-small"${active ? ' aria-current="page" style="font-weight:bold"' : ''} href="/admin/analytics?days=${opt}">${label}</a>`;
  }).join(' ');
  return `<p class="microcopy">Period: ${links} <span style="margin-left:8px">Showing: <strong>${esc(window.label)}</strong></span></p>`;
}

function pctCell(p) {
  return p == null ? '—' : `${esc(String(p))}%`;
}

function distTable(rows, colLabel, totalLabel) {
  const body = rows.length
    ? rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.count}</td><td>${pctCell(r.pct)}</td></tr>`).join('')
    : `<tr><td colspan="3">No data in this period.</td></tr>`;
  const total = rows.reduce((s, r) => s + r.count, 0);
  return `<table class="admin-table"><thead><tr><th>${esc(colLabel)}</th><th>Count</th><th>Share</th></tr></thead>` +
    `<tbody>${body}</tbody><tfoot><tr><td><strong>${esc(totalLabel)}</strong></td><td><strong>${total}</strong></td><td></td></tr></tfoot></table>`;
}

function funnelTable(pages) {
  const rows = Object.entries(pages).map(([path, s]) =>
    `<tr><td>${esc(FUNNEL_PAGE_LABELS[path] || path)}</td><td><code>${esc(path)}</code></td><td>${s.views}</td><td>${s.visitors}</td></tr>`
  ).join('');
  return `<table class="admin-table"><thead><tr><th>Page</th><th>Path</th><th>Page views</th><th>Unique visitors</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function analyticsHtml(a) {
  const f = a.funnel;
  const conv = f.conversionPct == null
    ? '<strong>—</strong> (no visitors yet)'
    : `<strong>${esc(String(f.conversionPct))}%</strong>`;

  const sourceSections = Object.entries(a.sources).map(([type, rows]) => `
    <h4>${esc(type)} applications by source</h4>
    ${distTable(rows, 'Source', 'Total ' + type.toLowerCase() + ' applications')}`
  ).join('');

  const attrRows = a.referrals.attributed.length
    ? a.referrals.attributed.map((r) =>
      `<tr><td><code>${esc(r.code)}</code></td><td>${esc(r.issuedTo)}</td><td>${r.count}</td><td>${pctCell(r.pct)}</td></tr>`
    ).join('')
    : '<tr><td colspan="4">No attributed referrals in this period.</td></tr>';
  const typedRows = a.referrals.typed.length
    ? a.referrals.typed.map((r) =>
      `<tr><td><code>${esc(r.code)}</code></td><td>${r.count}</td><td>${pctCell(r.pct)}</td></tr>`
    ).join('')
    : '<tr><td colspan="3">No referral codes typed on applications in this period.</td></tr>';

  const q = a.pipeline;
  const qTotal = q.qualifiedStatuses.map((s) => `<code>${esc(s)}</code>`).join(', ');

  return `
<h2>Growth analytics</h2>
<p class="microcopy">All counts are computed live from the real database — visitors, page views, applications, drafts, sources, referral attributions, drivers, and opportunity matches. Definitions of every derived metric are listed at the bottom of this page. Counts describe what has happened; they do not predict or promise future results.</p>
${windowNav(a)}

<div class="card">
  <h3>Funnel traffic (${esc(a.window.label)})</h3>
  ${funnelTable(f.pages)}
  <p class="microcopy">Page views count every load; unique visitors counts anonymous browser cookies (vid), not people — one person may use several browsers or devices.</p>
</div>

<div class="card">
  <h3>Application funnel (${esc(a.window.label)})</h3>
  <div class="metric-cards">
    <div class="metric-card"><div class="num">${f.started}</div><div class="label">Started (unique visitors who opened /grow/apply)¹</div></div>
    <div class="metric-card"><div class="num">${f.draftsSaved}</div><div class="label">Drafts saved²</div></div>
    <div class="metric-card"><div class="num">${f.completed}</div><div class="label">Completed applications³</div></div>
    <div class="metric-card"><div class="num">${conv}</div><div class="label">Conversion rate⁴</div></div>
  </div>
  <div class="metric-cards" style="margin-top:12px">
    <div class="metric-card"><div class="num">${f.businessLeads}</div><div class="label">New business inquiries</div></div>
    <div class="metric-card"><div class="num">${f.rspInterest}</div><div class="label">New RSP interest submissions</div></div>
  </div>
</div>

<div class="card">
  <h3>Where applicants come from (${esc(a.window.label)})</h3>
  <p class="microcopy">Channel performance — the source each applicant selected when they applied. ⁵</p>
  ${sourceSections}
</div>

<div class="card">
  <h3>Referral sources (${esc(a.window.label)})</h3>
  <h4>Attributed referrals (matched to issued codes)</h4>
  <table class="admin-table"><thead><tr><th>Code</th><th>Issued to</th><th>Applicants</th><th>Share</th></tr></thead><tbody>${attrRows}</tbody></table>
  <h4 style="margin-top:16px">Referral codes typed on applications</h4>
  <table class="admin-table"><thead><tr><th>Code typed</th><th>Applicants</th><th>Share</th></tr></thead><tbody>${typedRows}</tbody></table>
  <p class="microcopy">The "typed" list includes codes that never matched an issued code. Referral codes track where applicants heard about TransitNow — sharing or using a code does not promise, guarantee, or imply any payment, bonus, or compensation. ⁶</p>
</div>

<div class="card">
  <h3>Applicant profile — GROW (${esc(a.window.label)})</h3>
  <h4>Desired future role (self-reported)</h4>
  ${distTable(a.applicant.byFutureRole, 'Future role', 'Total GROW applications')}
  <h4 style="margin-top:16px">Vehicle type</h4>
  ${distTable(a.applicant.byVehicleType, 'Vehicle type', 'Total GROW applications')}
  <h4 style="margin-top:16px">Geography — by state (${a.applicant.distinctStates} states/territories with applicants)</h4>
  ${distTable(a.applicant.byState, 'State', 'Total GROW applications')}
  <h4 style="margin-top:16px">Experience level (self-reported)</h4>
  ${distTable(a.applicant.byExperience, 'Experience', 'Total GROW applications')}
  <h4 style="margin-top:16px">Opportunity interests (applicants may pick several)</h4>
  ${distTable(a.applicant.opportunityInterests, 'Interest', 'Total GROW applications')}
  <p class="microcopy">Percentages are of GROW applications in the period; interest shares can sum above 100% because applicants may select multiple interests.</p>
</div>

<div class="card">
  <h3>Pipeline — current</h3>
  <p class="microcopy">These numbers describe the state right now, not a time period. The app keeps no "as of" history for them.</p>
  <div class="metric-cards">
    <div class="metric-card"><div class="num">${q.qualifiedApplicants}</div><div class="label">Qualified applicants (CRM)⁷</div></div>
    <div class="metric-card"><div class="num">${q.driverApprovals}</div><div class="label">Driver approvals (Phase 2)⁸</div></div>
    <div class="metric-card"><div class="num">${q.activeDrivers}</div><div class="label">Active drivers⁹</div></div>
    <div class="metric-card"><div class="num">${q.activeBusinesses}</div><div class="label">Active businesses¹⁰</div></div>
  </div>
  <div class="metric-cards" style="margin-top:12px">
    <div class="metric-card"><div class="num">${q.opportunityMatches}</div><div class="label">Opportunity matches (all time) — ${a.pipeline.matchesInWindow} in this period¹¹</div></div>
    <div class="metric-card"><div class="num">${q.rspInterestTotal}</div><div class="label">Total RSP interest submissions (all time)</div></div>
  </div>
  <h4 style="margin-top:16px">Business inquiries by CRM status (current)</h4>
  ${distTable(q.businessByStatus, 'Status', 'Total business inquiries')}
</div>

<div class="card">
  <h3>Metric definitions</h3>
  <ol class="microcopy" style="line-height:1.7">
    <li><strong>Started:</strong> unique anonymous visitors (browser cookies) who opened <code>/grow/apply</code> in the period. A visitor is not a verified person.</li>
    <li><strong>Drafts saved:</strong> distinct "save &amp; continue later" drafts created in the period. A draft may be saved more than once; only the distinct token is counted.</li>
    <li><strong>Completed:</strong> new applicant records created in the period. Resubmissions update the existing record (matched on email) and are not counted twice.</li>
    <li><strong>Conversion rate:</strong> Completed ÷ Started. It compares new applicant records to application-page visitors in the same period — not a prediction of future results.</li>
    <li><strong>Source:</strong> the channel each applicant selected on the application ("How did you hear about us?"). Blank answers appear as "(not provided)".</li>
    <li><strong>Referral sources:</strong> "Attributed" counts applicants matched to an issued referral code by the attribution scan; "typed" counts every code value applicants typed on the form, whether or not it matched an issued code.</li>
    <li><strong>Qualified applicants (CRM):</strong> GROW leads currently in a post-review status — ${qTotal}. Statuses are set manually by the team; this is not an automated judgment and does not promise work, routes, loads, contracts, or income.</li>
    <li><strong>Driver approvals (Phase 2):</strong> drivers whose extended application status is currently <code>APPROVED</code>. Approval is granted by the team after screening — it is not automatic and does not promise work or income.</li>
    <li><strong>Active drivers:</strong> drivers whose pipeline status is currently <code>active</code>.</li>
    <li><strong>Active businesses:</strong> business inquiries whose CRM status is currently <code>ACTIVE</code>.</li>
    <li><strong>Opportunity matches:</strong> "Potential Match" records (Phase 2). A potential match means the person may fit an opportunity's requirements — it is not an offer or promise of employment, routes, loads, contracts, partnership, or income.</li>
  </ol>
  <p><a href="/admin/operations">&larr; Back to Operations command center</a></p>
</div>`;
}

module.exports = { analyticsHtml, FUNNEL_PAGE_LABELS };
