'use strict';
/**
 * views/dispatch.js — dispatcher-facing pages (behind /dispatch/*, real
 * logins via lib/dispatch_auth.js). Dispatchers are NOT admins: they get
 * their own clean shell (dispatcherLayout), not the admin layout.
 *
 * Pages: login, forgot password, reset password, change password,
 * today's board (auto-refreshing), and the admin dispatcher-management page
 * (rendered by server.js inside adminLayout).
 */
const boardLib = require('../lib/dispatch_board');
const fieldCommsViews = require('./field_comms');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTs(ts) {
  if (!ts) return '—';
  try { return new Date(Number(ts)).toLocaleString(); } catch (e) { return String(ts); }
}

/** Clean dispatcher shell: own nav, no admin chrome, no tokens anywhere. */
function dispatcherLayout(title, body, dispatcher) {
  const name = dispatcher ? esc(dispatcher.name) : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | TransitNow Dispatch</title>
<link rel="stylesheet" href="/style.css">
<style>
.dispatch-shell{max-width:1100px;margin:0 auto;padding:16px}
.dispatch-nav{display:flex;gap:16px;align-items:center;background:#1F3A5F;color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;flex-wrap:wrap}
.dispatch-nav a{color:#fff;text-decoration:none;font-weight:600}
.dispatch-nav a:hover{text-decoration:underline}
.dispatch-nav .who{margin-left:auto;font-size:13px;opacity:.85}
.summary-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:12px 0}
.summary-strip .stat{background:#f4f7fb;border:1px solid #d7e0ec;border-radius:8px;padding:10px 12px}
.summary-strip .stat .num{font-size:24px;font-weight:700}
.summary-strip .stat .label{font-size:12px;color:#555}
.route-card{border:1px solid #d7e0ec;border-radius:8px;padding:12px 14px;margin:10px 0;background:#fff}
.route-card .rc-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.route-card .rc-code{font-weight:700;font-size:16px}
.status-pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;color:#fff}
.status-planned{background:#6b7a90}.status-active{background:#1b7f3b}.status-completed{background:#1F3A5F}.status-cancelled{background:#999}
.exc-flag{color:#d32f2f;font-weight:700}
.driver-call{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.error-box{background:#fdecea;border:1px solid #d32f2f;color:#a31212;border-radius:8px;padding:10px 14px;margin:12px 0}
.ok-box{background:#e9f7ef;border:1px solid #1b7f3b;color:#14622c;border-radius:8px;padding:10px 14px;margin:12px 0}
.board-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}
.board-toolbar input[type=date]{min-height:44px}
.muted{color:#666}.microcopy{font-size:12px;color:#666}
</style>
</head>
<body>
<div class="dispatch-shell">
<nav class="dispatch-nav" aria-label="Dispatcher">
  <strong>🚚 TransitNow Dispatch</strong>
  <a href="/dispatch/today">Today's board</a>
  <a href="/dispatch/field-comms">Field comms</a>
  <a href="/dispatch/change-password">Change password</a>
  ${dispatcher ? `<span class="who">${name} · <a href="/dispatch/logout">Log out</a></span>` : ''}
</nav>
${body}
</div>
</body>
</html>`;
}

// --- Login -----------------------------------------------------------------------
function loginPageHtml({ error = '', next = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispatcher Login | TransitNow Dispatch</title>
<link rel="stylesheet" href="/style.css">
<style>
.login-wrap{max-width:420px;margin:60px auto;padding:24px;border:1px solid #d7e0ec;border-radius:10px;background:#fff}
.login-wrap h1{margin-top:0}
.login-wrap label{display:block;margin-top:10px;font-weight:600}
.login-wrap input{width:100%;min-height:44px;margin-top:4px}
.login-wrap button{margin-top:16px;width:100%}
</style>
</head>
<body>
<div class="login-wrap">
<h1>🚚 Dispatcher Login</h1>
<p class="muted">TransitNow dispatch team only.</p>
${error ? `<div class="error-box"><strong>${esc(error)}</strong></div>` : ''}
<form method="POST" action="/dispatch/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="dl-email">Email</label>
  <input id="dl-email" type="email" name="email" autocomplete="username" required>
  <label for="dl-password">Password</label>
  <input id="dl-password" type="password" name="password" autocomplete="current-password" required>
  <button type="submit" class="btn">Log in</button>
</form>
<p style="margin-top:12px"><a href="/dispatch/forgot">Forgot password?</a></p>
</div>
</body>
</html>`;
}

// --- Forgot / reset / change password ----------------------------------------------
function forgotPageHtml({ message = '', error = '' } = {}) {
  const body = `
<h1>Reset your password</h1>
${message ? `<div class="ok-box">${esc(message)}</div>` : ''}
${error ? `<div class="error-box"><strong>${esc(error)}</strong></div>` : ''}
<form method="POST" action="/dispatch/forgot" style="max-width:420px">
  <label for="fp-email" style="display:block;font-weight:600">Account email</label>
  <input id="fp-email" type="email" name="email" required style="width:100%;min-height:44px;margin-top:4px">
  <div style="margin-top:14px"><button type="submit" class="btn">Send reset link</button></div>
  <p class="microcopy">The link expires in 1 hour and can only be used once.</p>
</form>
<p><a href="/dispatch/login">&larr; Back to login</a></p>`;
  return dispatcherLayout('Forgot password', body, null);
}

function resetPageHtml({ token, error = '' } = {}) {
  const body = `
<h1>Choose a new password</h1>
${error ? `<div class="error-box"><strong>${esc(error)}</strong></div>` : ''}
<form method="POST" action="/dispatch/reset/${encodeURIComponent(token)}" style="max-width:420px">
  <label for="rp-1" style="display:block;font-weight:600">New password (min 10 characters)</label>
  <input id="rp-1" type="password" name="password" autocomplete="new-password" required minlength="10" style="width:100%;min-height:44px;margin-top:4px">
  <label for="rp-2" style="display:block;font-weight:600;margin-top:10px">Repeat new password</label>
  <input id="rp-2" type="password" name="password2" autocomplete="new-password" required minlength="10" style="width:100%;min-height:44px;margin-top:4px">
  <div style="margin-top:14px"><button type="submit" class="btn">Set new password</button></div>
</form>`;
  return dispatcherLayout('Reset password', body, null);
}

function changePasswordPageHtml({ dispatcher, error = '', ok = '', forced = false } = {}) {
  const body = `
<h1>Change password</h1>
${forced ? `<div class="ok-box"><strong>Your administrator issued a temporary password.</strong> Please choose your own password now to continue.</div>` : ''}
${ok ? `<div class="ok-box"><strong>${esc(ok)}</strong></div>` : ''}
${error ? `<div class="error-box"><strong>${esc(error)}</strong></div>` : ''}
<form method="POST" action="/dispatch/change-password" style="max-width:420px">
  <label for="cp-cur" style="display:block;font-weight:600">Current password</label>
  <input id="cp-cur" type="password" name="current" autocomplete="current-password" required style="width:100%;min-height:44px;margin-top:4px">
  <label for="cp-1" style="display:block;font-weight:600;margin-top:10px">New password (min 10 characters)</label>
  <input id="cp-1" type="password" name="password" autocomplete="new-password" required minlength="10" style="width:100%;min-height:44px;margin-top:4px">
  <label for="cp-2" style="display:block;font-weight:600;margin-top:10px">Repeat new password</label>
  <input id="cp-2" type="password" name="password2" autocomplete="new-password" required minlength="10" style="width:100%;min-height:44px;margin-top:4px">
  <div style="margin-top:14px"><button type="submit" class="btn">Change password</button></div>
</form>
<p><a href="/dispatch/today">&larr; Back to today's board</a></p>`;
  return dispatcherLayout('Change password', body, dispatcher);
}

// --- Today's board ------------------------------------------------------------------
function summaryStripHtml(s) {
  const stat = (n, label, red) =>
    `<div class="stat"><div class="num"${red && Number(n) > 0 ? ' style="color:#d32f2f"' : ''}>${esc(String(n))}</div><div class="label">${esc(label)}</div></div>`;
  return `<div class="summary-strip" id="board-summary">
${stat(s.routes, 'routes today')}
${stat(s.active, 'active')}
${stat(s.completed, 'completed')}
${stat(s.packages_delivered, 'packages delivered')}
${stat(s.open_exceptions, 'open exceptions', true)}
</div>`;
}

function routeCardHtml(r) {
  const tel = r.driver_phone ? boardLib.phoneHref(r.driver_phone, 'tel') : null;
  const sms = r.driver_phone ? boardLib.phoneHref(r.driver_phone, 'sms') : null;
  const driverLine = r.driver_name
    ? `<span><strong>${esc(r.driver_name)}</strong>${r.driver_phone ? ` · ${esc(r.driver_phone)}` : ''}</span>`
    : `<span class="muted">Unassigned</span>`;
  const callBtns = (tel && sms)
    ? `<div class="driver-call">
<a class="btn btn-small" href="${esc(tel)}">📞 Call driver</a>
<a class="btn btn-small" href="${esc(sms)}">💬 Text driver</a>
</div>` : '';
  const exc = r.open_exceptions > 0
    ? `<span class="exc-flag">🚩 ${r.open_exceptions} open exception${r.open_exceptions === 1 ? '' : 's'}</span>`
    : `<span class="muted">0 open exceptions</span>`;
  return `<div class="route-card" data-route="${r.id}">
<div class="rc-head">
  <span class="rc-code">${esc(r.route_code || ('Route #' + r.id))}</span>
  <span class="status-pill status-${esc(r.status)}">${esc(r.status)}</span>
  ${r.title ? `<span class="muted">${esc(r.title)}</span>` : ''}
</div>
<div style="margin-top:6px">${driverLine}</div>
<div class="muted" style="margin-top:4px;font-size:13px">
  ${r.stops_count} stop${r.stops_count === 1 ? '' : 's'} · 📦 ${r.pkg_delivered}/${r.pkg_total} delivered (${r.pkg_remaining} remaining) · ${exc}
</div>
${callBtns}
<div style="margin-top:8px"><a href="${esc(r.route_url)}">Open route detail &rarr;</a></div>
</div>`;
}

function boardPageHtml({ board, dispatcher }) {
  const dateLabel = board.isToday ? `Today (${board.date})` : board.date;
  const rowsHtml = board.routes.length
    ? board.routes.map(routeCardHtml).join('\n')
    : `<div class="route-card"><p class="muted">No routes scheduled for ${esc(board.date)}.</p></div>`;
  const body = `
<h1>📋 Today's routes</h1>
<p class="muted">Live dispatcher board — refreshes automatically every 60 seconds. All times Chicago.</p>
<div class="board-toolbar">
  <a class="btn btn-small" href="/dispatch/today?date=${esc(board.prev)}">&larr; ${esc(board.prev)}</a>
  <form method="GET" action="/dispatch/today" style="display:inline">
    <input type="date" name="date" value="${esc(board.date)}" aria-label="Choose date">
    <button type="submit" class="btn btn-small">Go</button>
  </form>
  <a class="btn btn-small" href="/dispatch/today?date=${esc(board.next)}">${esc(board.next)} &rarr;</a>
  <button type="button" class="btn btn-small" id="board-refresh">↻ Refresh now</button>
</div>
<h2 style="margin-bottom:0">${esc(dateLabel)}</h2>
${summaryStripHtml(board.summary)}
<div id="board-routes">
${rowsHtml}
</div>
<script>
(function () {
  var url = '/dispatch/today.json?date=${esc(board.date)}';
  var routesBox = document.getElementById('board-routes');
  var summaryBox = document.getElementById('board-summary');
  function tick() {
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) {
        if (!b || !b.html) return;
        routesBox.innerHTML = b.html;
        if (b.summaryHtml) summaryBox.outerHTML = b.summaryHtml;
      })
      .catch(function () { /* polling is best-effort; next tick retries */ });
  }
  document.getElementById('board-refresh').addEventListener('click', tick);
  setInterval(tick, 60000);
})();
</script>`;
  return dispatcherLayout("Today's routes", body, dispatcher);
}

/** Field comms (broadcast composer + siren) inside the dispatcher shell. */
// --- Read-only route detail (dispatchers can view; nothing mutates) -------------
function routeDetailHtml({ route, driver, packages = [], counts = {}, progress = null }) {
  const tel = driver && driver.phone ? boardLib.phoneHref(driver.phone, 'tel') : null;
  const sms = driver && driver.phone ? boardLib.phoneHref(driver.phone, 'sms') : null;
  const statusList = Object.entries(counts)
    .map(([st, n]) => `<li>${esc(st)}: <strong>${Number(n)}</strong></li>`).join('\n');
  const pkgRows = packages.length
    ? packages.map((p) => `<tr><td>${esc(p.package_id || '')}</td><td>${esc(p.status || '')}</td></tr>`).join('\n')
    : `<tr><td colspan="2" class="muted">No packages on this route.</td></tr>`;
  const stops = Array.isArray(route.stops) ? route.stops : [];
  const stopRows = stops.length
    ? `<ol>${stops.map((s) => `<li>${esc(typeof s === 'string' ? s : (s.label || s.stop || JSON.stringify(s)))}</li>`).join('\n')}</ol>`
    : `<p class="muted">No stops recorded.</p>`;
  const prog = progress
    ? `<p><strong>Progress:</strong> ${Number(progress.done)}/${Number(progress.total)} done (${Number(progress.active)} active)</p>`
    : '';
  return `<p><a href="/dispatch/today">&larr; Back to the board</a></p>
<h1>Route ${esc(route.route_code || ('#' + route.id))}</h1>
<p>
  <span class="status-pill status-${esc(route.status)}">${esc(route.status)}</span>
  ${route.title ? ` <strong>${esc(route.title)}</strong>` : ''}
  <span class="muted"> · scheduled ${esc(route.scheduled_date || '')}</span>
</p>
${driver
    ? `<h2>Driver</h2>
<p><strong>${esc(driver.full_name || '')}</strong>${driver.phone ? ` · ${esc(driver.phone)}` : ''}</p>
${(tel && sms) ? `<div class="driver-call">
<a class="btn btn-small" href="${esc(tel)}">📞 Call driver</a>
<a class="btn btn-small" href="${esc(sms)}">💬 Text driver</a>
</div>` : ''}`
    : `<p class="muted">No driver assigned.</p>`}
<h2>Packages</h2>
${prog}
<ul>${statusList}</ul>
<table>
<thead><tr><th>Package</th><th>Status</th></tr></thead>
<tbody>${pkgRows}</tbody>
</table>
<h2>Stops</h2>
${stopRows}
${route.notes ? `<h2>Notes</h2><p>${esc(route.notes)}</p>` : ''}
<p class="microcopy">Read-only view — to change a route, ask an admin.</p>`;
}

function fieldCommsPageHtml({ unacked = [], broadcasts = [], error = '', sent = '', dispatcher } = {}) {
  const body = fieldCommsViews.fieldCommsPageHtml({ unacked, broadcasts, error, sent, actionPrefix: '/dispatch' });
  return dispatcherLayout('Field comms', body, dispatcher);
}

// --- Admin: dispatcher management (rendered inside adminLayout by server.js) --------
function dispatchersAdminHtml({ dispatchers = [], created = null, tempShown = null, error = '' } = {}) {
  const rows = dispatchers.map((d) => `<tr>
<td><strong>${esc(d.name)}</strong><br><span class="muted">${esc(d.email)}</span></td>
<td>${d.active === 1 ? '<span style="color:#1b7f3b"><strong>Active</strong></span>' : '<span style="color:#999">Deactivated</span>'}
  ${d.must_change_password === 1 ? '<br><span class="muted">must change password</span>' : ''}</td>
<td class="muted">created ${fmtTs(d.created_at)}<br>last login ${fmtTs(d.last_login_at)}</td>
<td style="white-space:nowrap">
  <form method="POST" action="/admin/dispatchers/${d.id}/active" style="display:inline">
    <input type="hidden" name="active" value="${d.active === 1 ? '0' : '1'}">
    <button type="submit" class="btn btn-small">${d.active === 1 ? 'Deactivate' : 'Reactivate'}</button>
  </form>
  <form method="POST" action="/admin/dispatchers/${d.id}/reset-password" style="display:inline;margin-left:6px">
    <button type="submit" class="btn btn-small">Reset password</button>
  </form>
</td>
</tr>`).join('');
  return `
<h2>Dispatcher accounts</h2>
<p class="microcopy">Dispatcher logins for the <a href="/dispatch/today">dispatcher area</a> (daily board, field comms).
Accounts are created here only — there is no public signup. Dispatchers never see the admin panel or the shared admin token.</p>
${error ? `<p class="error" style="color:#d32f2f"><strong>${esc(error)}</strong></p>` : ''}
${created ? `<div class="ok-box" style="background:#e9f7ef;border:1px solid #1b7f3b;border-radius:8px;padding:10px 14px;margin:12px 0">
<strong>Dispatcher created:</strong> ${esc(created.name)} (${esc(created.email)}).<br>
<strong>Password (shown once — give it to them by phone/text):</strong> <code style="font-size:16px">${esc(created.password)}</code></div>` : ''}
${tempShown ? `<div class="ok-box" style="background:#fff8e1;border:1px solid #e6a100;border-radius:8px;padding:10px 14px;margin:12px 0">
<strong>Temporary password for ${esc(tempShown.name)} (${esc(tempShown.email)}) — shown once:</strong>
<code style="font-size:18px">${esc(tempShown.password)}</code><br>
<span class="muted">Give it to them by phone or text. They will be forced to choose their own password on next login.</span></div>` : ''}
<div class="card" style="max-width:560px">
<h3>Add dispatcher</h3>
<form method="POST" action="/admin/dispatchers">
  <label for="nd-name" style="display:block;font-weight:600">Name</label>
  <input id="nd-name" type="text" name="name" required style="width:100%;min-height:44px;margin:4px 0 10px">
  <label for="nd-email" style="display:block;font-weight:600">Email</label>
  <input id="nd-email" type="email" name="email" required style="width:100%;min-height:44px;margin:4px 0 10px">
  <label for="nd-pw" style="display:block;font-weight:600">Password (min 10 characters — you set it)</label>
  <input id="nd-pw" type="text" name="password" required minlength="10" autocomplete="new-password" style="width:100%;min-height:44px;margin:4px 0 10px">
  <button type="submit" class="btn">Create dispatcher</button>
</form>
</div>
<h3>All dispatchers (${dispatchers.length})</h3>
<table class="admin-table">
<thead><tr><th>Dispatcher</th><th>Status</th><th>Activity</th><th>Actions</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" class="muted">No dispatcher accounts yet.</td></tr>'}</tbody>
</table>`;
}

module.exports = {
  esc,
  dispatcherLayout,
  loginPageHtml,
  forgotPageHtml,
  resetPageHtml,
  changePasswordPageHtml,
  summaryStripHtml,
  routeCardHtml,
  boardPageHtml,
  routeDetailHtml,
  fieldCommsPageHtml,
  dispatchersAdminHtml,
};
