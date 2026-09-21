'use strict';
/**
 * views/route_matches.js — Admin UI for tier-based route matching.
 * Additive. All copy keeps no-guarantee language: matches are potential
 * opportunities, never promised routes, loads, contracts, or income.
 */
const { esc } = require('./layout');

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString();
}

function cycleLogHtml(cycles) {
  const rows = (cycles || []).map((c) => `<tr>
    <td><strong>${esc(c.cycle_key)}</strong><br><span class="muted">${esc(c.kind)}</span></td>
    <td class="ts">${fmtTs(c.ran_at)}</td>
    <td>${c.drivers_considered}</td>
    <td>${c.drivers_matched}</td>
    <td>${c.matches_created}</td>
    <td>${c.notifications_queued}</td>
  </tr>`).join('');
  return `<div class="card">
  <h3>Match cycle log</h3>
  <form method="POST" action="/admin/route-matches/run" style="margin-bottom:10px">
    <button type="submit" class="btn">Run match cycle now</button>
    <span class="muted">Runs the Monday cycle immediately (Complete tier first). Idempotent per week.</span>
  </form>
  <table class="admin-table">
    <thead><tr><th>Cycle</th><th>Ran</th><th>Considered</th><th>Matched</th><th>Created</th><th>Notified</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6">No cycles yet.</td></tr>'}</tbody>
  </table>
</div>`;
}

function assistantQueueHtml({ questions, subMap }) {
  const rows = (questions || []).map((q) => {
    const sub = subMap[q.driver_email] || null;
    const tier = sub && sub.plan ? (sub.plan === 'complete' ? 'Complete $100/mo' : 'Basic $50/mo') : '—';
    const tierBadge = sub && sub.plan === 'complete'
      ? '<span class="status-badge" style="background:#1c3faa;color:#fff">COMPLETE</span>'
      : sub && sub.plan === 'basic'
        ? '<span class="status-badge" style="background:#1c7a3d;color:#fff">BASIC</span>'
        : '<span class="muted">no subscription row</span>';
    return `<tr>
    <td><a href="/admin/drivers/${q.driver_id}">${esc(q.driver_name || ('#' + q.driver_id))}</a><br><span class="muted">${esc(q.driver_email || '')}</span></td>
    <td>${tierBadge}<br><span class="muted">${esc(tier)}</span></td>
    <td>${esc(q.question)}</td>
    <td class="ts">${fmtTs(q.created_at)}</td>
    <td><form method="POST" action="/admin/assistant-questions/${q.id}/answer" class="form">
      <label>Answer<textarea name="answer" rows="3" required style="width:100%"></textarea></label>
      <button type="submit" class="btn">Send answer</button>
    </form></td>
  </tr>`;
  }).join('');
  return `<div class="card">
  <h3>Assistant questions — pending</h3>
  <p class="muted">Questions from Complete-tier drivers for the private operations assistant. Write the answer (or paste the AI's reply) and it is stored and emailed to the driver — the app never generates an answer on its own.</p>
  <table class="admin-table">
    <thead><tr><th>Driver</th><th>Tier</th><th>Question</th><th>Asked</th><th>Answer</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No pending questions.</td></tr>'}</tbody>
  </table>
</div>`;
}

function adminPageHtml({ cycles, matches, driversList, opportunities, driverFilter, error, assistantQuestions = [], subMap = {} }) {
  const matchRows = (matches || []).map((m) => `<tr>
    <td><a href="/admin/drivers/${m.driver_id}">${esc(m.driver_name || ('#' + m.driver_id))}</a></td>
    <td>${esc(m.opportunity_name || ('#' + m.opportunity_id))}<br><span class="muted">${esc(m.opportunity_location || '')}</span></td>
    <td>${esc(m.tier || '')}</td>
    <td>${esc(m.status)}</td>
    <td class="ts">${fmtTs(m.matched_at)}</td>
    <td>${m.status === 'assigned'
      ? `<form method="POST" action="/admin/route-matches/${m.id}/release" style="display:inline"><button type="submit" class="btn btn-secondary">Release</button></form>`
      : `<span class="muted">${esc(m.release_reason || '')}</span>`}</td>
  </tr>`).join('');
  const driverOpts = (driversList || [])
    .map((d) => `<option value="${d.id}"${String(driverFilter) === String(d.id) ? ' selected' : ''}>${esc(d.full_name)} (${esc(d.email)})</option>`)
    .join('');
  const oppOpts = (opportunities || [])
    .map((o) => `<option value="${o.id}">${esc(o.name)}${o.location ? ' — ' + esc(o.location) : ''} [${esc(o.status)}]</option>`)
    .join('');
  return `
<p><a href="/admin/opportunities">&larr; Opportunities</a> · <a href="/admin/drivers">&larr; Driver pipeline</a></p>
<h2>Route matching (dispatch tiers)</h2>
<p class="muted">Basic $50/mo: 2 route matches every Monday. Complete $100/mo: 5 matches on day one, refilled to 5 every Monday, matched first. Only ACTIVE subscribers are matched. Matches come only from real OPEN opportunities — never fabricated. Matches are potential opportunities, never promised routes, loads, contracts, or income.</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
${cycleLogHtml(cycles)}
<div class="card">
  <h3>Manual assign</h3>
  <form method="POST" action="/admin/route-matches/assign" class="form">
    <label>Driver <select name="driver_id" required>${driverOpts}</select></label>
    <label>Opportunity (OPEN) <select name="opportunity_id" required>${oppOpts}</select></label>
    <button type="submit" class="btn">Assign match</button>
  </form>
</div>
<div class="card">
  <h3>Recent matches${driverFilter ? ` — driver #${esc(driverFilter)} <a href="/admin/route-matches">(clear)</a>` : ''}</h3>
  <form method="GET" action="/admin/route-matches" class="form" style="margin-bottom:10px">
    <label>Filter by driver <select name="driver" onchange="this.form.submit()"><option value="">All drivers</option>${driverOpts}</select></label>
  </form>
  <table class="admin-table">
    <thead><tr><th>Driver</th><th>Opportunity</th><th>Tier</th><th>Status</th><th>Matched</th><th></th></tr></thead>
    <tbody>${matchRows || '<tr><td colspan="6">No matches yet.</td></tr>'}</tbody>
  </table>
</div>
${assistantQueueHtml({ questions: assistantQuestions, subMap })}`;
}

module.exports = { cycleLogHtml, adminPageHtml };
