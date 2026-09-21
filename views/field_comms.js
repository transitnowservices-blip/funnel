// Admin views: dispatch <-> driver field communications.
// Siren banner for unacknowledged urgent tickets, broadcast composer, and
// the admin-visible broadcast log. Simple semantic HTML; the backend wires
// these into /admin routes and supplies real data. No backend logic here.
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTs(ts) {
  if (!ts) return '—';
  try {
    return new Date(Number(ts)).toLocaleString();
  } catch (e) {
    return String(ts);
  }
}

/**
 * Can't-miss siren for unacknowledged urgent field tickets
 * (priority='urgent' AND status='open'). Returns '' when there are none.
 * Acknowledging moves the ticket to in_progress via the existing ticket
 * status path — no new tables.
 * actionPrefix selects which auth surface the ack form posts to:
 * '/admin' (admin dashboard banner) or '/dispatch' (dispatcher pages).
 */
function sirenBannerHtml(tickets, actionPrefix = '/admin') {
  const list = tickets || [];
  if (!list.length) return '';
  const ackBase = actionPrefix === '/dispatch' ? '/dispatch' : '/admin';
  const rows = list
    .map(
      (t) => `<li style="margin:6px 0"><strong>${esc(t.ticket_id)}</strong> — ${esc(t.subject || '')}` +
        (t.driver_name ? ` <span class="muted">(driver: ${esc(t.driver_name)})</span>` : '') +
        ` <span class="muted">${fmtTs(t.created_at)}</span> ` +
        `<form method="POST" action="${ackBase}/tickets/${encodeURIComponent(t.ticket_id)}/acknowledge" style="display:inline">` +
        `<button type="submit" class="btn" style="padding:4px 12px">Acknowledge</button></form></li>`
    )
    .join('');
  return `<div class="siren" style="background:#d32f2f;color:#fff;padding:14px 16px;border-radius:8px;margin-bottom:16px">\n` +
    `<p style="margin:0 0 6px;font-size:18px"><strong>🚨 URGENT field ticket${list.length === 1 ? '' : 's'} — needs acknowledgment</strong></p>\n` +
    `<ul style="margin:0;padding-left:20px">${rows}</ul>\n` +
    `<p class="muted" style="color:#ffd7d7;margin:8px 0 0">The banner stays up until every urgent ticket is acknowledged.</p>\n` +
    `</div>`;
}

function audienceOptions(selected) {
  const opts = [
    ['all', 'All active subscribers'],
    ['complete', 'Complete only ($100/mo)'],
    ['basic', 'Basic only ($50/mo)'],
  ];
  return opts
    .map(([v, label]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');
}

function broadcastLogHtml(log) {
  const rows = (log || [])
    .map(
      (b) => `<tr><td>${fmtTs(b.created_at)}</td><td>${esc(b.audience)}</td>` +
        `<td><strong>${esc(b.subject)}</strong><br><span class="muted">${esc(b.message)}</span></td>` +
        `<td>${Number(b.driver_count)}</td></tr>`
    )
    .join('');
  return `<h2>Broadcast log</h2>\n<table class="admin-table">\n<thead><tr><th>Sent</th><th>Audience</th><th>Message</th><th>Drivers</th></tr></thead>\n<tbody>${rows || '<tr><td colspan="4">No broadcasts yet.</td></tr>'}</tbody>\n</table>`;
}

function fieldCommsPageHtml({ unacked = [], broadcasts = [], error = '', sent = '', actionPrefix = '/admin' }) {
  const base = actionPrefix === '/dispatch' ? '/dispatch' : '/admin';
  return `
${sirenBannerHtml(unacked, base)}
<h2>Broadcast to field</h2>
<p class="muted">One message to drivers in the field. Goes to <strong>active subscribers only</strong> — canceled, past-due, and unpaid drivers never receive it. Each driver gets one email plus one text (texts queue as provider-pending until a real SMS provider is configured).</p>
${error ? `<p class="error" style="color:#d32f2f"><strong>${esc(error)}</strong></p>` : ''}
${sent ? `<p style="color:#1b7f3b"><strong>${esc(sent)}</strong></p>` : ''}
<form method="POST" action="${base}/field-comms/broadcast" class="form" style="max-width:640px">
  <label for="bc-subject">Subject</label>
  <input id="bc-subject" type="text" name="subject" maxlength="120" required style="width:100%;min-height:44px">
  <label for="bc-message" style="margin-top:8px;display:block">Message</label>
  <textarea id="bc-message" name="message" rows="4" maxlength="2000" required style="width:100%"
    placeholder="e.g. Heads up: the depot lot closes at 6pm today — plan pickups before then."></textarea>
  <label for="bc-audience" style="margin-top:8px;display:block">Audience</label>
  <select id="bc-audience" name="audience" style="min-height:44px">${audienceOptions('all')}</select>
  <div style="margin-top:12px"><button type="submit" class="btn">SEND BROADCAST</button></div>
  <p class="microcopy">No guaranteed loads, routes, revenue, or earnings — operational messages only.</p>
</form>
${broadcastLogHtml(broadcasts)}`;
}

module.exports = { sirenBannerHtml, fieldCommsPageHtml, broadcastLogHtml, audienceOptions };
