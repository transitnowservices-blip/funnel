'use strict';
/**
 * lib/drivers.js — TransitNow Driver Operations Platform domain logic.
 *
 * Additive module: the existing funnel / Room behavior is untouched.
 * All timestamps are epoch milliseconds. Timestamps, custody events, status
 * history, ticket history, and plan changes are APPEND-ONLY — corrections are
 * recorded as new events, never silent overwrites.
 *
 * Driver access is token-based (magic links). No driver passwords are
 * collected or stored: Phase 1 forbids it, and onboarding stays login-free.
 */
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

// --- Vocabularies ------------------------------------------------------------
const DRIVER_STATUSES = [
  'new',
  'reviewing',
  'contacted',
  'documents_needed',
  'ready',
  'placement',
  'active',
  'inactive',
];
const STATUS_LABELS = {
  new: 'New',
  reviewing: 'Reviewing',
  contacted: 'Contacted',
  documents_needed: 'Documents Needed',
  ready: 'Ready',
  placement: 'Placement / Load Search',
  active: 'Active',
  inactive: 'Inactive',
};
const SOURCES = ['tiktok', 'facebook', 'instagram', 'referral', 'website', 'direct', 'other'];
const SOURCE_LABELS = {
  tiktok: 'TikTok',
  facebook: 'Facebook',
  instagram: 'Instagram',
  referral: 'Referral',
  website: 'Website',
  direct: 'Direct',
  other: 'Other',
};
const CONTACT_METHODS = ['call', 'text', 'email'];
const WORK_PREFS = [
  'local',
  'regional',
  'otr',
  'dedicated',
  'on_demand',
  'same_day',
  'medical',
  'general_freight',
  'other',
];
const WORK_PREF_LABELS = {
  local: 'Local',
  regional: 'Regional',
  otr: 'OTR',
  dedicated: 'Dedicated routes',
  on_demand: 'On-demand',
  same_day: 'Same-day',
  medical: 'Medical courier',
  general_freight: 'General freight',
  other: 'Other',
};
const LOOKING_FOR = ['loads', 'routes', 'dispatch', 'rsp_help', 'business_setup', 'not_sure'];
const LOOKING_FOR_LABELS = {
  loads: 'Loads',
  routes: 'Routes',
  dispatch: 'Dispatch services',
  rsp_help: 'Help getting positioned as an RSP/carrier',
  business_setup: 'Business setup guidance',
  not_sure: 'Not sure yet',
};

// Route lifecycle (Phase 4).
const ROUTE_STATUSES = ['planned', 'active', 'completed', 'cancelled'];
const ROUTE_STATUS_LABELS = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

// Package lifecycle (Phase 4).
const PACKAGE_STATUSES = [
  'created',
  'ready_for_pickup',
  'picked_up',
  'in_transit',
  'at_stop',
  'out_for_delivery',
  'delivered',
  'exception',
  'returned',
  'lost_investigation',
];
const PACKAGE_STATUS_LABELS = {
  created: 'Created',
  ready_for_pickup: 'Ready for Pickup',
  picked_up: 'Picked Up',
  in_transit: 'In Transit',
  at_stop: 'At Stop',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  exception: 'Exception',
  returned: 'Returned',
  lost_investigation: 'Lost / Investigation',
};

// Support ticket vocab (Phase 10).
const TICKET_CATEGORIES = [
  'route_issue',
  'package_issue',
  'vehicle_issue',
  'customer_issue',
  'payment_question',
  'dispatch_question',
  'technical_issue',
  'safety_concern',
  'urgent_issue',
  'other',
];
const TICKET_CATEGORY_LABELS = {
  route_issue: 'Route issue',
  package_issue: 'Package issue',
  vehicle_issue: 'Vehicle issue',
  customer_issue: 'Customer issue',
  payment_question: 'Payment question',
  dispatch_question: 'Dispatch question',
  technical_issue: 'Technical issue',
  safety_concern: 'Safety concern',
  urgent_issue: 'Urgent issue',
  other: 'Other',
};
const TICKET_PRIORITIES = ['normal', 'high', 'urgent'];
const TICKET_STATUSES = ['open', 'in_progress', 'waiting_driver', 'resolved', 'closed'];

// Exception types (Phase 9).
const EXCEPTION_TYPES = [
  'recipient_unavailable',
  'wrong_address',
  'damaged_package',
  'package_missing',
  'vehicle_issue',
  'route_issue',
  'weather_delay',
  'other',
];
const EXCEPTION_TYPE_LABELS = {
  recipient_unavailable: 'Recipient unavailable',
  wrong_address: 'Wrong address',
  damaged_package: 'Damaged package',
  package_missing: 'Package missing',
  vehicle_issue: 'Vehicle issue',
  route_issue: 'Route issue',
  weather_delay: 'Weather delay',
  other: 'Other',
};

// --- Small helpers -----------------------------------------------------------
function parseJsonArray(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Operations contact: env override, else the site's own email. */
function opsEmail() {
  return process.env.TRANSITNOW_OPS_EMAIL || config.getSite().email;
}

function baseUrl() {
  const site = config.getSite();
  return (site.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
}

function driverDashUrl(token) {
  return `${baseUrl()}/d/${token}`;
}

// --- Sequential IDs ----------------------------------------------------------
async function nextSequence(name) {
  const row = await db.get('SELECT next FROM counters WHERE name = ?', [name]);
  const n = row ? Number(row.next) : 1;
  if (row) await db.run('UPDATE counters SET next = ? WHERE name = ?', [n + 1, name]);
  else await db.run('INSERT INTO counters (name, next) VALUES (?, ?)', [name, n + 1]);
  return n;
}

/** TN-2026-000001 style package IDs (counter resets per calendar year). */
async function nextPackageId() {
  const year = new Date().getFullYear();
  const n = await nextSequence(`package-${year}`);
  return `TN-${year}-${String(n).padStart(6, '0')}`;
}

/** TNR-2026-0001 style route IDs. */
async function nextRouteId() {
  const year = new Date().getFullYear();
  const n = await nextSequence(`route-${year}`);
  return `TNR-${year}-${String(n).padStart(4, '0')}`;
}

/** TN-SUP-000001 style support ticket IDs. */
async function nextTicketId() {
  const n = await nextSequence('ticket');
  return `TN-SUP-${String(n).padStart(6, '0')}`;
}

// --- Source tracking (Phase 3) -----------------------------------------------
function normalizeSource(s) {
  const v = String(s || '').trim().toLowerCase();
  return SOURCES.includes(v) ? v : 'other';
}

// --- Driver records (Phase 1) ------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Validate raw onboarding input. Returns { ok, errors, clean }.
 * Never collects SSN / bank / password — there are no such fields, and any
 * unexpected sensitive-looking keys are dropped, not stored.
 */
function validateDriverInput(input) {
  const errors = [];
  const clean = {};
  const str = (k) => String(input[k] == null ? '' : input[k]).trim();

  clean.full_name = str('full_name');
  clean.email = str('email').toLowerCase();
  clean.phone = str('phone');
  if (!clean.full_name) errors.push('Please enter your full name.');
  if (!EMAIL_RE.test(clean.email)) errors.push('Please enter a valid email address.');
  if (!clean.phone) errors.push('Please enter your phone number.');

  const cm = str('contact_method').toLowerCase();
  clean.contact_method = CONTACT_METHODS.includes(cm) ? cm : 'text';

  for (const k of [
    'business_name', 'entity_type', 'mc_number', 'dot_number', 'years_in_business',
    'vehicle_type', 'vehicle_year', 'vehicle_make_model', 'cargo_dimensions',
    'payload_capacity', 'equipment', 'insurance_status',
    'home_city', 'home_state', 'service_radius', 'travel_regions',
    'hours_available', 'start_date', 'availability_status', 'lane_prefs',
  ]) {
    clean[k] = str(k);
  }

  clean.days_available = asArray(input.days_available).map((d) => String(d).trim()).filter(Boolean);
  clean.work_prefs = asArray(input.work_prefs).map((d) => String(d).trim()).filter((d) => WORK_PREFS.includes(d));
  clean.looking_for = asArray(input.looking_for).map((d) => String(d).trim()).filter((d) => LOOKING_FOR.includes(d));
  clean.source = normalizeSource(input.source);

  return { ok: errors.length === 0, errors, clean };
}

function rowToDriver(row) {
  if (!row) return null;
  return {
    ...row,
    days_available: parseJsonArray(row.days_available),
    work_prefs: parseJsonArray(row.work_prefs),
    looking_for: parseJsonArray(row.looking_for),
  };
}

async function getDriverById(id) {
  return rowToDriver(await db.get('SELECT * FROM drivers WHERE id = ?', [id]));
}

async function getDriverByEmail(email) {
  return rowToDriver(
    await db.get('SELECT * FROM drivers WHERE email = ?', [String(email || '').toLowerCase()])
  );
}

async function getDriverByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  return rowToDriver(await db.get('SELECT * FROM drivers WHERE access_token = ?', [token]));
}

const DRIVER_COLUMNS = [
  'full_name', 'email', 'phone', 'contact_method', 'business_name', 'entity_type',
  'mc_number', 'dot_number', 'years_in_business', 'vehicle_type', 'vehicle_year',
  'vehicle_make_model', 'cargo_dimensions', 'payload_capacity', 'equipment',
  'insurance_status', 'home_city', 'home_state', 'service_radius', 'travel_regions',
  'days_available', 'hours_available', 'start_date', 'availability_status',
  'work_prefs', 'lane_prefs', 'looking_for', 'source',
];

/**
 * Create a driver, or update the existing record when the email is already
 * known (re-onboarding updates the profile but never resets pipeline status
 * or the access token).
 */
async function createOrUpdateDriver(clean) {
  const now = Date.now();
  const existing = await getDriverByEmail(clean.email);
  const jsonCols = { days_available: 1, work_prefs: 1, looking_for: 1 };
  if (existing) {
    const updatable = DRIVER_COLUMNS.filter((c) => c !== 'email' && c !== 'source');
    const sets = updatable.map((c) => `${c} = ?`).join(', ');
    const vals = updatable.map((c) =>
      jsonCols[c] ? JSON.stringify(clean[c] || []) : clean[c] || null
    );
    // Keep the original source unless the new one is more specific.
    const keepSource = existing.source && existing.source !== 'direct' ? existing.source : clean.source;
    await db.run(`UPDATE drivers SET ${sets}, source = ?, updated_at = ? WHERE id = ?`, [
      ...vals,
      keepSource,
      now,
      existing.id,
    ]);
    return getDriverById(existing.id);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const cols = [...DRIVER_COLUMNS, 'status', 'access_token', 'submitted_at', 'updated_at'];
  const vals = DRIVER_COLUMNS.map((c) =>
    jsonCols[c] ? JSON.stringify(clean[c] || []) : clean[c] || null
  );
  const info = await db.run(
    `INSERT INTO drivers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    [...vals, 'new', token, now, now]
  );
  await db.run(
    'INSERT INTO driver_status_history (driver_id, from_status, to_status, changed_by, note, ts) VALUES (?, ?, ?, ?, ?, ?)',
    [info.lastInsertRowid, null, 'new', 'system', 'Onboarding submitted', now]
  );
  return getDriverById(info.lastInsertRowid);
}

/** Change a driver's pipeline status (append-only history row). */
async function setDriverStatus(id, toStatus, { by = 'admin', note = '', notify = true } = {}) {
  if (!DRIVER_STATUSES.includes(toStatus)) throw new Error(`Unknown driver status: ${toStatus}`);
  const driver = await getDriverById(id);
  if (!driver) throw new Error('Driver not found');
  const now = Date.now();
  if (driver.status === toStatus) return driver;
  await db.run('UPDATE drivers SET status = ?, updated_at = ?, last_contact = ? WHERE id = ?', [
    toStatus,
    now,
    now,
    id,
  ]);
  await db.run(
    'INSERT INTO driver_status_history (driver_id, from_status, to_status, changed_by, note, ts) VALUES (?, ?, ?, ?, ?, ?)',
    [id, driver.status, toStatus, by, note || null, now]
  );
  if (notify && driver.email) {
    await queueDriverEmail({
      to: driver.email,
      subject: `TransitNow — your driver status update`,
      html: statusChangeEmail(driver, driver.status, toStatus),
      sequence: 'driver-ops',
      step: 'status-change',
    });
  }
  return getDriverById(id);
}

/** Append a timestamped admin note (never overwrites existing notes). */
async function addDriverNote(id, note, by = 'admin') {
  const driver = await getDriverById(id);
  if (!driver) throw new Error('Driver not found');
  const line = `[${new Date().toLocaleString()}] ${by}: ${String(note || '').trim()}`;
  const notes = driver.notes ? `${driver.notes}\n${line}` : line;
  await db.run('UPDATE drivers SET notes = ?, updated_at = ?, last_contact = ? WHERE id = ?', [
    notes,
    Date.now(),
    Date.now(),
    id,
  ]);
  return getDriverById(id);
}

async function statusHistory(driverId) {
  return db.all('SELECT * FROM driver_status_history WHERE driver_id = ? ORDER BY ts ASC, id ASC', [
    driverId,
  ]);
}

async function listDrivers({ status = null, source = null, search = '', limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (source) {
    where.push('source = ?');
    params.push(source);
  }
  if (search) {
    where.push('(full_name LIKE ? OR email LIKE ? OR phone LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await db.all(
    `SELECT * FROM drivers ${whereSql} ORDER BY submitted_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows.map(rowToDriver);
}

async function countDriversByStatus() {
  const rows = await db.all('SELECT status, COUNT(*) c FROM drivers GROUP BY status');
  const out = {};
  for (const s of DRIVER_STATUSES) out[s] = 0;
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

// --- Routes + packages (Phase 4) -----------------------------------------------
function rowToRoute(r) {
  if (!r) return null;
  return { ...r, stops: parseJsonArray(r.stops) };
}

async function createRoute({ driverId, title, scheduledDate = '', notes = '' }) {
  const driver = await getDriverById(driverId);
  if (!driver) throw new Error('Driver not found');
  const routeCode = await nextRouteId();
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO routes (route_code, driver_id, title, status, scheduled_date, stops, notes, created_at, updated_at)
     VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?)`,
    [routeCode, driverId, (title || '').trim(), scheduledDate || null, JSON.stringify([]), notes || null, now, now]
  );
  return getRouteById(info.lastInsertRowid);
}

async function getRouteById(id) {
  return rowToRoute(await db.get('SELECT * FROM routes WHERE id = ?', [id]));
}

async function getRouteByCode(code) {
  return rowToRoute(await db.get('SELECT * FROM routes WHERE route_code = ?', [code]));
}

async function listRoutes({ driverId = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (driverId) { where.push('driver_id = ?'); params.push(driverId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT * FROM routes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  return (await db.all(sql, params)).map(rowToRoute);
}

/** The driver's current route: most recent planned/active route. */
async function getCurrentRoute(driverId) {
  const rows = await db.all(
    `SELECT * FROM routes WHERE driver_id = ? AND status IN ('planned','active') ORDER BY created_at DESC LIMIT 1`,
    [driverId]
  );
  return rowToRoute(rows[0] || null);
}

async function setRouteStatus(id, toStatus) {
  if (!ROUTE_STATUSES.includes(toStatus)) throw new Error(`Unknown route status: ${toStatus}`);
  const route = await getRouteById(id);
  if (!route) throw new Error('Route not found');
  await db.run('UPDATE routes SET status = ?, updated_at = ? WHERE id = ?', [toStatus, Date.now(), id]);
  return getRouteById(id);
}

async function setRouteStops(id, stops) {
  const route = await getRouteById(id);
  if (!route) throw new Error('Route not found');
  const list = Array.isArray(stops) ? stops : [];
  await db.run('UPDATE routes SET stops = ?, updated_at = ? WHERE id = ?', [JSON.stringify(list), Date.now(), id]);
  return getRouteById(id);
}

function validatePackageInput(input) {
  const errors = [];
  const clean = {
    recipient_name: (input.recipient_name || '').trim(),
    address: (input.address || '').trim(),
    city: (input.city || '').trim(),
    state: (input.state || '').trim(),
    zip: (input.zip || '').trim(),
    special_instructions: (input.special_instructions || '').trim(),
  };
  if (!clean.recipient_name) errors.push('Recipient name is required.');
  if (!clean.address) errors.push('Delivery address is required.');
  return { ok: errors.length === 0, errors, clean };
}

async function createPackage({ routeId = null, driverId = null, recipient_name, address, city, state, zip, special_instructions }) {
  const { ok, errors, clean } = validatePackageInput({ recipient_name, address, city, state, zip, special_instructions });
  if (!ok) throw new Error(errors.join(' '));
  if (routeId) {
    const route = await getRouteById(routeId);
    if (!route) throw new Error('Route not found');
    if (!driverId) driverId = route.driver_id;
  }
  const packageId = await nextPackageId();
  const now = Date.now();
  await db.run(
    `INSERT INTO packages (package_id, route_id, driver_id, recipient_name, address, city, state, zip, status, special_instructions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
    [packageId, routeId, driverId, clean.recipient_name, clean.address, clean.city || null,
     clean.state || null, clean.zip || null, clean.special_instructions || null, now, now]
  );
  return getPackage(packageId);
}

async function getPackage(packageId) {
  return db.get('SELECT * FROM packages WHERE package_id = ?', [packageId]);
}

async function listPackages({ routeId = null, driverId = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (routeId) { where.push('route_id = ?'); params.push(routeId); }
  if (driverId) { where.push('driver_id = ?'); params.push(driverId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT * FROM packages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC`;
  return db.all(sql, params);
}

async function countPackagesByStatus(routeId) {
  const rows = await db.all('SELECT status, COUNT(*) c FROM packages WHERE route_id = ? GROUP BY status', [routeId]);
  const out = {};
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

async function setPackageStatus(packageId, toStatus) {
  if (!PACKAGE_STATUSES.includes(toStatus)) throw new Error(`Unknown package status: ${toStatus}`);
  const pkg = await getPackage(packageId);
  if (!pkg) throw new Error('Package not found');
  await db.run('UPDATE packages SET status = ?, updated_at = ? WHERE package_id = ?', [toStatus, Date.now(), packageId]);
  return getPackage(packageId);
}

// --- Custody + handoff history, append-only (Phase 6) ------------------------------
const CUSTODY_EVENTS = ['picked_up', 'in_transit', 'at_stop', 'out_for_delivery', 'delivered', 'handoff'];
const CUSTODY_EVENT_LABELS = {
  picked_up: 'Picked up',
  in_transit: 'In transit',
  at_stop: 'At stop',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  handoff: 'Handoff',
};
// Package status implied by each custody event.
const CUSTODY_EVENT_TO_STATUS = {
  picked_up: 'picked_up',
  in_transit: 'in_transit',
  at_stop: 'at_stop',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  handoff: 'in_transit',
};

/**
 * Record a custody event (append-only) and advance the package's status.
 * Never updates or deletes prior events.
 */
async function recordCustodyEvent({ packageId, eventType, driverId = null, note = '', createdBy = 'driver', meta = null }) {
  if (!CUSTODY_EVENTS.includes(eventType)) throw new Error(`Unknown custody event: ${eventType}`);
  const pkg = await getPackage(packageId);
  if (!pkg) throw new Error('Package not found');
  if (eventType === 'handoff' && !String(note || '').trim()) {
    throw new Error('A handoff must say who the package was handed to.');
  }
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO custody_events (package_id, route_id, driver_id, event_type, note, meta, created_by, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [packageId, pkg.route_id, driverId, eventType, String(note || '').trim() || null,
     meta ? JSON.stringify(meta) : null, createdBy, now]
  );
  await db.run('UPDATE packages SET status = ?, updated_at = ? WHERE package_id = ?', [
    CUSTODY_EVENT_TO_STATUS[eventType],
    now,
    packageId,
  ]);
  return { eventId: info.lastInsertRowid, package: await getPackage(packageId) };
}

/** Full custody timeline for a package, oldest first, with driver names. */
async function getCustodyHistory(packageId) {
  const rows = await db.all(
    `SELECT e.*, d.full_name AS driver_name
       FROM custody_events e
       LEFT JOIN drivers d ON d.id = e.driver_id
      WHERE e.package_id = ?
      ORDER BY e.ts ASC, e.id ASC`,
    [packageId]
  );
  return rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
}

// --- Notifications (Phase 19) -------------------------------------------------
/**
 * Queue an email through the existing outbox system (email_queue). Delivery
 * itself is handled by the configured EMAIL_PROVIDER; with the default
 * local provider the message lands in data/outbox/ for inspection.
 */
async function queueDriverEmail({ to, subject, html, sequence = 'driver-ops', step = 'notice' }) {
  if (!to) return null;
  const info = await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, ?, ?, ?, ?, NULL, ?, 'queued')`,
    [to, sequence, step, subject, html, Date.now()]
  );
  return info.lastInsertRowid;
}

async function notifyOps(subject, html, step = 'ops-notice') {
  return queueDriverEmail({ to: opsEmail(), subject, html, sequence: 'driver-ops', step });
}

// --- Email templates ----------------------------------------------------------
function onboardDriverEmail(driver, dashUrl) {
  return `<p>Hi ${esc(driver.full_name)},</p>
<p>Thanks for completing your TransitNow driver onboarding — we've received your information and our team is reviewing it now.</p>
<p><strong>Your driver dashboard:</strong> <a href="${esc(dashUrl)}">${esc(dashUrl)}</a><br>
<span style="color:#555">Save this link — it's your private access to your routes, packages, support, and community. No password needed.</span></p>
<p><strong>What happens next:</strong></p>
<ol>
<li>We review your profile and documents.</li>
<li>When you're marked Ready, we start matching you with routes.</li>
<li>You'll see your route, packages, and progress right on your dashboard.</li>
</ol>
<p>Questions anytime: reply to this email or use the Support section of your dashboard.</p>
<p>— TransitNow Operations</p>`;
}

function onboardOpsEmail(driver) {
  const pref = (driver.work_prefs || []).map((w) => WORK_PREF_LABELS[w] || w).join(', ');
  return `<p><strong>New driver onboarding</strong></p>
<ul>
<li>Name: ${esc(driver.full_name)}</li>
<li>Email: ${esc(driver.email)}</li>
<li>Phone: ${esc(driver.phone)} (prefers ${esc(driver.contact_method)})</li>
<li>Vehicle: ${esc(driver.vehicle_year)} ${esc(driver.vehicle_make_model)} — ${esc(driver.vehicle_type)}</li>
<li>Location: ${esc(driver.home_city)}, ${esc(driver.home_state)} (radius ${esc(driver.service_radius)})</li>
<li>Work prefs: ${esc(pref)}</li>
<li>Source: ${esc(SOURCE_LABELS[driver.source] || driver.source)}</li>
</ul>
<p>Review in the admin driver pipeline.</p>`;
}

function statusChangeEmail(driver, fromStatus, toStatus) {
  return `<p>Hi ${esc(driver.full_name)},</p>
<p>Your TransitNow driver status changed: <strong>${esc(STATUS_LABELS[fromStatus] || fromStatus)}</strong> → <strong>${esc(STATUS_LABELS[toStatus] || toStatus)}</strong>.</p>
<p>Check your dashboard for details: <a href="${esc(driverDashUrl(driver.access_token))}">open your dashboard</a>.</p>
<p>— TransitNow Operations</p>`;
}

module.exports = {
  DRIVER_STATUSES,
  STATUS_LABELS,
  SOURCES,
  SOURCE_LABELS,
  CONTACT_METHODS,
  WORK_PREFS,
  WORK_PREF_LABELS,
  LOOKING_FOR,
  LOOKING_FOR_LABELS,
  PACKAGE_STATUSES,
  PACKAGE_STATUS_LABELS,
  ROUTE_STATUSES,
  ROUTE_STATUS_LABELS,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  EXCEPTION_TYPES,
  EXCEPTION_TYPE_LABELS,
  esc,
  opsEmail,
  baseUrl,
  driverDashUrl,
  nextSequence,
  nextPackageId,
  nextRouteId,
  nextTicketId,
  normalizeSource,
  validateDriverInput,
  createOrUpdateDriver,
  getDriverById,
  getDriverByEmail,
  getDriverByToken,
  setDriverStatus,
  addDriverNote,
  statusHistory,
  listDrivers,
  countDriversByStatus,
  queueDriverEmail,
  notifyOps,
  createRoute,
  getRouteById,
  getRouteByCode,
  listRoutes,
  getCurrentRoute,
  setRouteStatus,
  setRouteStops,
  validatePackageInput,
  createPackage,
  getPackage,
  listPackages,
  countPackagesByStatus,
  setPackageStatus,
  CUSTODY_EVENTS,
  CUSTODY_EVENT_LABELS,
  recordCustodyEvent,
  getCustodyHistory,
  onboardDriverEmail,
  onboardOpsEmail,
  statusChangeEmail,
};
