// lib/alerts.js — Phase 6: alerts (spec section 22).
//
// Alerts are generated from REAL data only:
//   urgent_support        — support_tickets with priority='urgent', open-ish
//   package_exception     — package_exceptions with status='open'
//   lost_package          — packages with status='lost_investigation'
//   route_delay           — open exceptions of type route_issue / weather_delay
//   driver_issue          — open tickets with category safety_concern / urgent_issue (non-urgent priority)
//   vehicle_issue         — open exceptions of type vehicle_issue + open vehicle tickets
//   new_applicant         — opportunity_leads of type GROW (one alert per lead, ever)
//   new_rsp_lead          — opportunity_leads of type RSP
//   new_business_opportunity — opportunity_leads of type BUSINESS
//   required_document     — active drivers missing a required document (doc_requirements)
//   expiring_document     — documents expiring within 30 days (not rejected)
//
// Dedup: UNIQUE(alert_type, source_type, source_id) + INSERT OR IGNORE, so
// generation is idempotent. Alerts whose source condition no longer holds are
// auto-resolved. Admin configures notification preferences
// (notification_prefs); when a NEW alert fires and its type is enabled, an
// ops email is queued via the existing email_queue pattern (verified in the
// local outbox; never claimed as delivered — Email/SMS providers are not
// configured).
'use strict';

const db = require('./db');
const emailLib = require('./email');
const config = require('./config');

const ALERT_TYPES = {
  urgent_support:         { label: 'Urgent support',         severity: 'critical' },
  package_exception:      { label: 'Package exception',      severity: 'warning'  },
  lost_package:           { label: 'Lost package',           severity: 'critical' },
  route_delay:            { label: 'Route delay',            severity: 'warning'  },
  driver_issue:           { label: 'Driver issue',           severity: 'warning'  },
  vehicle_issue:          { label: 'Vehicle issue',          severity: 'warning'  },
  new_applicant:          { label: 'New applicant',          severity: 'info'     },
  new_rsp_lead:           { label: 'New RSP lead',           severity: 'info'     },
  new_business_opportunity: { label: 'New business opportunity', severity: 'info' },
  required_document:      { label: 'Required document missing', severity: 'warning' },
  expiring_document:      { label: 'Document expiring',      severity: 'warning'  },
};

const EXPIRING_WINDOW_MS = 30 * 24 * 3600 * 1000; // 30 days
const OPEN_TICKET_STATUSES = ['open', 'in_progress'];

function str(v, max = 4000) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function opsEmail() {
  return process.env.TRANSITNOW_OPS_EMAIL || config.getSite().email;
}

async function getPrefs() {
  const rows = await db.all('SELECT * FROM notification_prefs');
  const out = {};
  for (const t of Object.keys(ALERT_TYPES)) out[t] = { alert_type: t, notify_enabled: 1 };
  for (const r of rows) {
    out[r.alert_type] = { alert_type: r.alert_type, notify_enabled: Number(r.notify_enabled) ? 1 : 0 };
  }
  return out;
}

async function setPref(alertType, enabled) {
  if (!ALERT_TYPES[alertType]) throw new Error('Unknown alert type');
  const now = Date.now();
  await db.run(
    `INSERT INTO notification_prefs (alert_type, notify_enabled, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (alert_type) DO UPDATE SET notify_enabled = excluded.notify_enabled, updated_at = excluded.updated_at`,
    [alertType, enabled ? 1 : 0, now]
  );
}

// --- Notification --------------------------------------------------------------
async function notifyAlert(alert) {
  const prefs = await getPrefs();
  const pref = prefs[alert.alert_type];
  if (!pref || !pref.notify_enabled) return { notified: false, reason: 'disabled' };
  const to = opsEmail();
  if (!to) return { notified: false, reason: 'no-ops-email' };
  const subject = `TransitNow Ops Alert: ${alert.title}`;
  const html =
    `<p><strong>${escapeHtml(alert.title)}</strong></p>` +
    `<p>${escapeHtml(alert.detail || '')}</p>` +
    `<p>Alert #${alert.id} · ${escapeHtml(ALERT_TYPES[alert.alert_type]?.label || alert.alert_type)} · ` +
    `severity ${escapeHtml(alert.severity || 'info')}</p>`;
  const info = await db.run(
    `INSERT INTO email_queue (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, 'ops-alerts', ?, ?, ?, NULL, ?, 'queued')`,
    [to, alert.alert_type, subject, html, Date.now()]
  );
  const queueId = Number(info.lastInsertRowid);
  try {
    await emailLib.sendEmail({ to, subject, html, queueId, fromName: 'TransitNow Logistics Services' });
  } catch (err) {
    console.error(`[alerts] ops notify failed (queueId ${queueId}), left queued:`, err && err.message ? err.message : err);
  }
  await db.run('UPDATE alerts SET notified_at = ? WHERE id = ?', [Date.now(), alert.id]);
  return { notified: true, queueId };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Generation ----------------------------------------------------------------
async function insertAlert(alertType, { title, detail, sourceType, sourceId }) {
  const now = Date.now();
  const info = await db.run(
    `INSERT OR IGNORE INTO alerts
       (alert_type, title, detail, source_type, source_id, severity, status, ts)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    [alertType, str(title, 300), str(detail), sourceType, String(sourceId),
      ALERT_TYPES[alertType].severity, now]
  );
  if (Number(info.changes) > 0) {
    const alert = await db.get(
      'SELECT * FROM alerts WHERE alert_type = ? AND source_type = ? AND source_id = ?',
      [alertType, sourceType, String(sourceId)]
    );
    await notifyAlert(alert);
    return alert;
  }
  return null;
}

async function driverName(driverId) {
  const d = await db.get('SELECT full_name FROM drivers WHERE id = ?', [driverId]);
  return d ? d.full_name : `#${driverId}`;
}

async function generateAlerts() {
  const now = Date.now();
  const created = [];

  // urgent_support: open-ish tickets with priority 'urgent'.
  const urgent = await db.all(
    `SELECT id, driver_id, subject, category FROM support_tickets
     WHERE priority = 'urgent' AND status IN (${OPEN_TICKET_STATUSES.map(() => '?').join(', ')})`,
    OPEN_TICKET_STATUSES
  );
  for (const t of urgent) {
    const a = await insertAlert('urgent_support', {
      title: `Urgent support ticket #${t.id}${t.subject ? ' — ' + t.subject : ''}`,
      detail: `Driver: ${await driverName(t.driver_id)} · category ${t.category || '—'}.`,
      sourceType: 'ticket', sourceId: t.id,
    });
    if (a) created.push(a);
  }

  // package_exception: every open exception; specific types also fire
  // route_delay / vehicle_issue alerts.
  const exceptions = await db.all(
    `SELECT id, package_id, driver_id, exception_type, description
     FROM package_exceptions WHERE status = 'open'`
  );
  for (const e of exceptions) {
    const a = await insertAlert('package_exception', {
      title: `Package exception #${e.id} (${e.exception_type || '—'})`,
      detail: `Package ${e.package_id || '—'} · driver ${await driverName(e.driver_id)} · ${e.description || ''}`,
      sourceType: 'exception', sourceId: e.id,
    });
    if (a) created.push(a);
    if (e.exception_type === 'route_issue' || e.exception_type === 'weather_delay') {
      const b = await insertAlert('route_delay', {
        title: `Route delay — exception #${e.id}`,
        detail: `Type ${e.exception_type} · package ${e.package_id || '—'} · driver ${await driverName(e.driver_id)}.`,
        sourceType: 'exception', sourceId: e.id,
      });
      if (b) created.push(b);
    }
    if (e.exception_type === 'vehicle_issue') {
      const b = await insertAlert('vehicle_issue', {
        title: `Vehicle issue — exception #${e.id}`,
        detail: `Package ${e.package_id || '—'} · driver ${await driverName(e.driver_id)} · ${e.description || ''}`,
        sourceType: 'exception', sourceId: e.id,
      });
      if (b) created.push(b);
    }
  }

  // vehicle_issue: also open tickets with category vehicle_issue.
  const vehTickets = await db.all(
    `SELECT id, driver_id, subject FROM support_tickets
     WHERE category = 'vehicle_issue' AND status IN (${OPEN_TICKET_STATUSES.map(() => '?').join(', ')})`,
    OPEN_TICKET_STATUSES
  );
  for (const t of vehTickets) {
    const a = await insertAlert('vehicle_issue', {
      title: `Vehicle issue — ticket #${t.id}`,
      detail: `Driver: ${await driverName(t.driver_id)}${t.subject ? ' — ' + t.subject : ''}.`,
      sourceType: 'ticket', sourceId: t.id,
    });
    if (a) created.push(a);
  }

  // driver_issue: open safety/urgent tickets that are not already
  // urgent_support (priority urgent is covered there).
  const driverIssueTickets = await db.all(
    `SELECT id, driver_id, subject, category, priority FROM support_tickets
     WHERE category IN ('safety_concern', 'urgent_issue') AND priority <> 'urgent'
       AND status IN (${OPEN_TICKET_STATUSES.map(() => '?').join(', ')})`,
    OPEN_TICKET_STATUSES
  );
  for (const t of driverIssueTickets) {
    const a = await insertAlert('driver_issue', {
      title: `Driver issue — ticket #${t.id} (${t.category})`,
      detail: `Driver: ${await driverName(t.driver_id)}${t.subject ? ' — ' + t.subject : ''}.`,
      sourceType: 'ticket', sourceId: t.id,
    });
    if (a) created.push(a);
  }

  // lost_package: packages in lost_investigation.
  const lost = await db.all(
    `SELECT package_id, driver_id, route_id FROM packages WHERE status = 'lost_investigation'`
  );
  for (const p of lost) {
    const a = await insertAlert('lost_package', {
      title: `Lost package ${p.package_id} (under investigation)`,
      detail: `Driver: ${await driverName(p.driver_id)} · route ${p.route_id || '—'}.`,
      sourceType: 'package', sourceId: p.package_id,
    });
    if (a) created.push(a);
  }

  // new applicant / RSP / business leads (one alert per lead, ever).
  const leads = await db.all(
    `SELECT id, first_name, last_name, email, lead_type, created_at FROM opportunity_leads
     WHERE lead_type IN ('GROW', 'RSP', 'BUSINESS')`
  );
  const leadTypeToAlert = { GROW: 'new_applicant', RSP: 'new_rsp_lead', BUSINESS: 'new_business_opportunity' };
  for (const l of leads) {
    const t = leadTypeToAlert[l.lead_type];
    const a = await insertAlert(t, {
      title: `${ALERT_TYPES[t].label}: ${(l.first_name || '') + ' ' + (l.last_name || '')}`.trim() + ` <${l.email || 'no email'}>`,
      detail: `Lead #${l.id} · type ${l.lead_type} · received ${l.created_at ? new Date(Number(l.created_at)).toLocaleString() : '—'}.`,
      sourceType: 'lead', sourceId: l.id,
    });
    if (a) created.push(a);
  }

  // required_document: active drivers missing a required document.
  const reqs = await db.all(`SELECT owner_type, doc_type, label FROM doc_requirements WHERE owner_type = 'driver'`);
  if (reqs.length) {
    const activeDrivers = await db.all(`SELECT id, full_name FROM drivers WHERE status = 'active'`);
    for (const d of activeDrivers) {
      for (const r of reqs) {
        const have = await db.get(
          `SELECT id FROM driver_documents
           WHERE owner_type = 'driver' AND owner_id = ? AND doc_type = ? AND status <> 'rejected'
             AND verification_status <> 'rejected'`,
          [d.id, r.doc_type]
        );
        if (!have) {
          const a = await insertAlert('required_document', {
            title: `Required document missing: ${r.label} — ${d.full_name}`,
            detail: `Active driver #${d.id} has no accepted ${r.label} on file.`,
            sourceType: 'driver', sourceId: `${d.id}:${r.doc_type}`,
          });
          if (a) created.push(a);
        }
      }
    }
  }

  // expiring_document: documents expiring within 30 days, not rejected.
  const expiring = await db.all(
    `SELECT id, owner_type, owner_id, doc_type, file_name, expires_at FROM driver_documents
     WHERE expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ?
       AND status <> 'rejected' AND verification_status <> 'rejected'`,
    [now, now + EXPIRING_WINDOW_MS]
  );
  for (const d of expiring) {
    const a = await insertAlert('expiring_document', {
      title: `Document expiring: ${d.doc_type} (${d.file_name || 'file'})`,
      detail: `${d.owner_type} #${d.owner_id} · expires ${new Date(Number(d.expires_at)).toLocaleDateString()}.`,
      sourceType: 'document', sourceId: d.id,
    });
    if (a) created.push(a);
  }

  // Auto-resolve alerts whose source condition no longer holds.
  const resolved = await autoResolve(now);

  return { created, resolved };
}

// Mark open alerts resolved when the underlying condition cleared.
async function autoResolve(now) {
  let resolved = 0;
  const open = await db.all(`SELECT id, alert_type, source_type, source_id FROM alerts WHERE status = 'open'`);
  for (const a of open) {
    let stillOpen = true;
    try {
      switch (a.alert_type) {
        case 'urgent_support': {
          const t = await db.get(
            `SELECT id FROM support_tickets WHERE id = ? AND priority = 'urgent'
             AND status IN (${OPEN_TICKET_STATUSES.map(() => '?').join(', ')})`,
            [Number(a.source_id), ...OPEN_TICKET_STATUSES]
          );
          stillOpen = !!t;
          break;
        }
        case 'package_exception':
        case 'route_delay':
        case 'vehicle_issue': {
          if (a.source_type === 'exception') {
            const e = await db.get('SELECT id, exception_type FROM package_exceptions WHERE id = ? AND status = ?', [Number(a.source_id), 'open']);
            stillOpen = !!e;
          } else if (a.source_type === 'ticket') {
            const t = await db.get(
              `SELECT id FROM support_tickets WHERE id = ?
               AND status IN (${OPEN_TICKET_STATUSES.map(() => '?').join(', ')})`,
              [Number(a.source_id), ...OPEN_TICKET_STATUSES]
            );
            stillOpen = !!t;
          }
          break;
        }
        case 'lost_package': {
          const p = await db.get(
            `SELECT package_id FROM packages WHERE package_id = ? AND status = 'lost_investigation'`,
            [a.source_id]
          );
          stillOpen = !!p;
          break;
        }
        case 'driver_issue': {
          const t = await db.get(
            `SELECT id FROM support_tickets WHERE id = ?
             AND status IN (${OPEN_TICKET_STATUSES.map(() => '?').join(', ')})`,
            [Number(a.source_id), ...OPEN_TICKET_STATUSES]
          );
          stillOpen = !!t;
          break;
        }
        case 'required_document': {
          const [driverId, docType] = String(a.source_id).split(':');
          const d = await db.get(`SELECT id FROM drivers WHERE id = ? AND status = 'active'`, [Number(driverId)]);
          const have = await db.get(
            `SELECT id FROM driver_documents
             WHERE owner_type = 'driver' AND owner_id = ? AND doc_type = ? AND status <> 'rejected'
               AND verification_status <> 'rejected'`,
            [Number(driverId), docType]
          );
          stillOpen = !!(d && !have);
          break;
        }
        case 'expiring_document': {
          const d = await db.get(
            `SELECT id FROM driver_documents
             WHERE id = ? AND expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ?
               AND status <> 'rejected' AND verification_status <> 'rejected'`,
            [Number(a.source_id), now, now + EXPIRING_WINDOW_MS]
          );
          stillOpen = !!d;
          break;
        }
        default:
          // Informational (new lead) alerts never auto-resolve.
          stillOpen = true;
      }
    } catch { stillOpen = true; }
    if (!stillOpen) {
      await db.run('UPDATE alerts SET status = ?, resolved_at = ? WHERE id = ?', ['resolved', now, a.id]);
      resolved++;
    }
  }
  return resolved;
}

async function listAlerts({ status = '', alertType = '' } = {}) {
  const conds = [], params = [];
  if (status) { conds.push('status = ?'); params.push(status); }
  if (alertType && ALERT_TYPES[alertType]) { conds.push('alert_type = ?'); params.push(alertType); }
  return db.all(
    `SELECT * FROM alerts ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT 500`,
    params
  );
}

async function countOpen() {
  const row = await db.get(`SELECT COUNT(*) c FROM alerts WHERE status = 'open'`);
  return Number(row && row.c) || 0;
}

async function getAlert(id) {
  return db.get('SELECT * FROM alerts WHERE id = ?', [id]);
}

async function acknowledgeAlert(id, by = 'admin') {
  const a = await getAlert(id);
  if (!a) throw new Error('Alert not found');
  await db.run('UPDATE alerts SET status = ?, acknowledged_at = ?, acknowledged_by = ? WHERE id = ?',
    ['acknowledged', Date.now(), String(by).slice(0, 120), id]);
  return getAlert(id);
}

async function resolveAlert(id, by = 'admin') {
  const a = await getAlert(id);
  if (!a) throw new Error('Alert not found');
  await db.run('UPDATE alerts SET status = ?, resolved_at = ? WHERE id = ?',
    ['resolved', Date.now(), id]);
  return getAlert(id);
}

module.exports = {
  ALERT_TYPES,
  EXPIRING_WINDOW_MS,
  getPrefs,
  setPref,
  generateAlerts,
  listAlerts,
  countOpen,
  getAlert,
  acknowledgeAlert,
  resolveAlert,
};
