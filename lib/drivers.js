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

// --- Route progress (Phase 7: polling-based counts, no real-time claims) ----------
/**
 * Progress counts for a route: totals derived from package statuses.
 * Served over a polling JSON endpoint; the UI labels it as periodic refresh.
 */
async function getRouteProgress(routeId) {
  const route = await getRouteById(routeId);
  if (!route) throw new Error('Route not found');
  const counts = await countPackagesByStatus(routeId);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const done = (counts.delivered || 0) + (counts.returned || 0);
  const active = total - done;
  return {
    route_id: route.id,
    route_code: route.route_code,
    route_status: route.status,
    total,
    done,
    remaining: active,
    counts,
    updated_at: Date.now(),
  };
}

// --- Delivery exceptions (Phase 8) ---------------------------------------------------
const EXCEPTION_STATUSES = ['open', 'resolved'];
const EXCEPTION_STATUS_LABELS = { open: 'Open', resolved: 'Resolved' };

function validateExceptionInput(input) {
  const errors = [];
  const clean = {
    exception_type: String(input.exception_type || '').trim(),
    description: String(input.description || '').trim(),
  };
  if (!EXCEPTION_TYPES.includes(clean.exception_type)) errors.push('Choose an exception type.');
  if (!clean.description) errors.push('Describe what happened.');
  return { ok: errors.length === 0, errors, clean };
}

/**
 * Report a delivery exception. Sets the package status to 'exception' and
 * notifies operations. The exception record itself is append-only; resolution
 * is a separate update that never deletes the original report.
 */
async function reportException({ packageId, driverId, exception_type, description, photo = null, createdBy = 'driver' }) {
  const { ok, errors, clean } = validateExceptionInput({ exception_type, description });
  if (!ok) throw new Error(errors.join(' '));
  const pkg = await getPackage(packageId);
  if (!pkg) throw new Error('Package not found');
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO package_exceptions
       (package_id, route_id, driver_id, exception_type, description,
        photo_blob, photo_mime, photo_name, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [packageId, pkg.route_id, driverId, clean.exception_type, clean.description,
     photo ? photo.buffer : null, photo ? photo.mime : null, photo ? photo.originalName : null,
     createdBy, now]
  );
  await db.run('UPDATE packages SET status = ?, updated_at = ? WHERE package_id = ?', ['exception', now, packageId]);
  await notifyOps(
    `Package exception: ${packageId} — ${EXCEPTION_TYPE_LABELS[clean.exception_type]}`,
    `<p>Driver reported an exception for package <strong>${esc(packageId)}</strong>.</p>` +
    `<p>Type: ${esc(EXCEPTION_TYPE_LABELS[clean.exception_type])}</p>` +
    `<p>Description: ${esc(clean.description)}</p>`,
    'exception-new'
  );
  return info.lastInsertRowid;
}

async function getException(id) {
  return db.get('SELECT id, package_id, route_id, driver_id, exception_type, description, photo_mime, photo_name, status, resolution_note, created_by, created_at, resolved_at FROM package_exceptions WHERE id = ?', [id]);
}

async function getExceptionPhoto(id) {
  return db.get('SELECT photo_blob, photo_mime, photo_name FROM package_exceptions WHERE id = ?', [id]);
}

async function listExceptions({ packageId = null, driverId = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (packageId) { where.push('package_id = ?'); params.push(packageId); }
  if (driverId) { where.push('driver_id = ?'); params.push(driverId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT id, package_id, route_id, driver_id, exception_type, description,
                      photo_mime, photo_name, status, resolution_note, created_by, created_at, resolved_at
                 FROM package_exceptions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY created_at DESC`;
  return db.all(sql, params);
}

async function countOpenExceptions() {
  const r = await db.get(`SELECT COUNT(*) c FROM package_exceptions WHERE status = 'open'`);
  return Number(r.c);
}

/** Resolve an exception. The original report is kept; resolution is appended. */
async function resolveException(id, resolutionNote, by = 'admin') {
  const ex = await getException(id);
  if (!ex) throw new Error('Exception not found');
  const now = Date.now();
  await db.run(
    `UPDATE package_exceptions SET status = 'resolved', resolution_note = ?, resolved_at = ? WHERE id = ?`,
    [String(resolutionNote || '').trim() || null, now, id]
  );
  // The package is still in the driver's custody; move it back to in_transit
  // so the driver can continue recording custody events.
  await db.run(`UPDATE packages SET status = 'in_transit', updated_at = ? WHERE package_id = ? AND status = 'exception'`, [now, ex.package_id]);
  return getException(id);
}

// --- Support tickets (Phase 9: urgent ops alerts, append-only thread) ---------------
const TICKET_STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_driver: 'Waiting on driver',
  resolved: 'Resolved',
  closed: 'Closed',
};
const TICKET_PRIORITY_LABELS = { normal: 'Normal', high: 'High', urgent: 'Urgent' };

function validateTicketInput(input) {
  const errors = [];
  const clean = {
    category: String(input.category || '').trim(),
    priority: String(input.priority || 'normal').trim(),
    subject: String(input.subject || '').trim(),
    message: String(input.message || '').trim(),
  };
  if (!TICKET_CATEGORIES.includes(clean.category)) errors.push('Choose a category.');
  if (!['normal', 'urgent'].includes(clean.priority)) clean.priority = 'normal';
  if (!clean.subject) errors.push('Give your request a short subject.');
  if (!clean.message) errors.push('Describe what you need help with.');
  return { ok: errors.length === 0, errors, clean };
}

/**
 * Create a support ticket. Urgent tickets are routed to operations immediately
 * via the existing email queue — submittable at any time, with no promise of
 * an immediate human response (the UI states this explicitly).
 */
async function createTicket({ driverId, category, priority = 'normal', subject, message, createdBy = 'driver' }) {
  const { ok, errors, clean } = validateTicketInput({ category, priority, subject, message });
  if (!ok) throw new Error(errors.join(' '));
  const ticketId = await nextTicketId();
  const now = Date.now();
  await db.run(
    `INSERT INTO support_tickets (ticket_id, driver_id, category, priority, subject, message, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    [ticketId, driverId, clean.category, clean.priority, clean.subject, clean.message, createdBy, now, now]
  );
  if (clean.priority === 'urgent') {
    await notifyOps(
      `URGENT driver support: ${ticketId} — ${clean.subject}`,
      `<p><strong>URGENT</strong> support ticket from driver.</p>` +
      `<p>Ticket: ${esc(ticketId)}<br>Category: ${esc(TICKET_CATEGORY_LABELS[clean.category])}<br>` +
      `Subject: ${esc(clean.subject)}</p><p>${esc(clean.message)}</p>`,
      'ticket-urgent'
    );
  } else {
    await notifyOps(
      `New driver support ticket: ${ticketId} — ${clean.subject}`,
      `<p>Ticket: ${esc(ticketId)}<br>Category: ${esc(TICKET_CATEGORY_LABELS[clean.category])}<br>` +
      `Subject: ${esc(clean.subject)}</p><p>${esc(clean.message)}</p>`,
      'ticket-new'
    );
  }
  return getTicket(ticketId);
}

async function getTicket(ticketId) {
  return db.get('SELECT * FROM support_tickets WHERE ticket_id = ?', [ticketId]);
}

async function listTickets({ driverId = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (driverId) { where.push('driver_id = ?'); params.push(driverId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT * FROM support_tickets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY
    CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at DESC`;
  return db.all(sql, params);
}

/** Append a reply to the ticket thread (never edits history). */
async function addTicketReply({ ticketId, authorType, authorId = null, message }) {
  const t = await getTicket(ticketId);
  if (!t) throw new Error('Ticket not found');
  const text = String(message || '').trim();
  if (!text) throw new Error('Reply cannot be empty.');
  const now = Date.now();
  await db.run(
    `INSERT INTO ticket_replies (ticket_id, author_type, author_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
    [ticketId, authorType, authorId, text, now]
  );
  await db.run('UPDATE support_tickets SET updated_at = ? WHERE ticket_id = ?', [now, ticketId]);
  if (authorType === 'admin' && t.status === 'open') {
    await db.run(`UPDATE support_tickets SET status = 'in_progress', updated_at = ? WHERE ticket_id = ?`, [now, ticketId]);
  }
  return getTicketReplies(ticketId);
}

async function getTicketReplies(ticketId) {
  return db.all('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC, id ASC', [ticketId]);
}

async function setTicketStatus(ticketId, toStatus) {
  if (!TICKET_STATUSES.includes(toStatus)) throw new Error(`Unknown ticket status: ${toStatus}`);
  const t = await getTicket(ticketId);
  if (!t) throw new Error('Ticket not found');
  const now = Date.now();
  await db.run('UPDATE support_tickets SET status = ?, updated_at = ?, resolved_at = ? WHERE ticket_id = ?', [
    toStatus, now, toStatus === 'resolved' || toStatus === 'closed' ? now : null, ticketId,
  ]);
  return getTicket(ticketId);
}

// --- Community (Phase J: categories, comments, pinning, reports, moderation) ---------
const COMMUNITY_CATEGORIES = ['announcements', 'route_tips', 'questions', 'wins', 'general'];
const COMMUNITY_CATEGORY_LABELS = {
  announcements: 'Announcements',
  route_tips: 'Route tips',
  questions: 'Questions',
  wins: 'Wins',
  general: 'General',
};
const COMMUNITY_POST_STATUSES = ['visible', 'hidden', 'removed'];
const COMMUNITY_COMMENT_STATUSES = ['visible', 'hidden', 'removed'];

/** Community display name: first name only (privacy). */
function communityDisplayName(driver) {
  if (!driver || !driver.full_name) return 'A driver';
  return String(driver.full_name).trim().split(/\s+/)[0];
}

function validateCommunityPost(input) {
  const errors = [];
  const clean = {
    category: String(input.category || '').trim(),
    title: String(input.title || '').trim(),
    body: String(input.body || '').trim(),
  };
  if (!COMMUNITY_CATEGORIES.includes(clean.category)) errors.push('Choose a category.');
  if (!clean.title) errors.push('Give your post a title.');
  if (!clean.body) errors.push('Write something for your post.');
  return { ok: errors.length === 0, errors, clean };
}

async function createCommunityPost({ driverId = null, authorType = 'driver', category, title, body }) {
  const { ok, errors, clean } = validateCommunityPost({ category, title, body });
  if (!ok) throw new Error(errors.join(' '));
  if (clean.category === 'announcements' && authorType !== 'admin') {
    throw new Error('Only TransitNow operations can post announcements.');
  }
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO community_posts (driver_id, author_type, category, title, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'visible', ?, ?)`,
    [driverId, authorType, clean.category, clean.title, clean.body, now, now]
  );
  return getCommunityPost(info.lastInsertRowid);
}

async function getCommunityPost(id) {
  return db.get('SELECT * FROM community_posts WHERE id = ?', [id]);
}

async function listCommunityPosts({ category = null, includeHidden = false } = {}) {
  const where = [];
  const params = [];
  if (!includeHidden) { where.push(`status = 'visible'`); }
  if (category) { where.push('category = ?'); params.push(category); }
  const sql = `SELECT * FROM community_posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY pinned DESC, created_at DESC, id DESC`;
  return db.all(sql, params);
}

async function setCommunityPostPinned(id, pinned) {
  await db.run('UPDATE community_posts SET pinned = ?, updated_at = ? WHERE id = ?', [pinned ? 1 : 0, Date.now(), id]);
}

async function setCommunityPostStatus(id, status) {
  if (!COMMUNITY_POST_STATUSES.includes(status)) throw new Error('Unknown post status');
  await db.run('UPDATE community_posts SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), id]);
}

async function createCommunityComment({ postId, driverId = null, authorType = 'driver', body }) {
  const post = await getCommunityPost(postId);
  if (!post || post.status !== 'visible') throw new Error('Post not found');
  const text = String(body || '').trim();
  if (!text) throw new Error('Comment cannot be empty.');
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO community_comments (post_id, driver_id, author_type, body, status, created_at)
     VALUES (?, ?, ?, ?, 'visible', ?)`,
    [postId, driverId, authorType, text, now]
  );
  return db.get('SELECT * FROM community_comments WHERE id = ?', [info.lastInsertRowid]);
}

async function listCommunityComments(postId, { includeHidden = false } = {}) {
  const sql = `SELECT * FROM community_comments WHERE post_id = ? ${includeHidden ? '' : `AND status = 'visible'`} ORDER BY created_at ASC, id ASC`;
  return db.all(sql, [postId]);
}

async function setCommunityCommentStatus(id, status) {
  if (!COMMUNITY_COMMENT_STATUSES.includes(status)) throw new Error('Unknown comment status');
  await db.run('UPDATE community_comments SET status = ? WHERE id = ?', [status, id]);
}

async function reportCommunityContent({ postId = null, commentId = null, reporterDriverId, reason }) {
  if (!postId && !commentId) throw new Error('Nothing to report.');
  const text = String(reason || '').trim();
  if (!text) throw new Error('Tell us why you are reporting this.');
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO community_reports (post_id, comment_id, reporter_driver_id, reason, status, created_at)
     VALUES (?, ?, ?, ?, 'open', ?)`,
    [postId, commentId, reporterDriverId, text, now]
  );
  await notifyOps(
    'Driver community content reported',
    `<p>A driver reported ${postId ? 'a post' : 'a comment'} in the driver community.</p><p>Reason: ${esc(text)}</p>`,
    'community-report'
  );
  return info.lastInsertRowid;
}

async function listCommunityReports({ status = null } = {}) {
  const sql = `SELECT * FROM community_reports ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC`;
  return db.all(sql, status ? [status] : []);
}

async function reviewCommunityReport(id, outcome) {
  if (!['reviewed', 'dismissed'].includes(outcome)) throw new Error('Unknown review outcome');
  await db.run('UPDATE community_reports SET status = ?, reviewed_at = ? WHERE id = ?', [outcome, Date.now(), id]);
}

// --- Service plans (Phase K: configurable weekly plans, append-only changes) ------
/** Verbatim disclaimer required wherever plans appear. */
const PLAN_DISCLAIMER = 'Plan pricing represents the applicable TransitNow service/plan fee. Driver earnings are not guaranteed and may vary based on routes, loads, availability, expenses, eligibility, and other operating factors.';
const PLAN_BILLING_FREQUENCIES = ['weekly', 'biweekly'];
const PLAN_CHANGE_EVENTS = ['requested', 'approved', 'rejected', 'changed'];

function planPriceDisplay(plan) {
  return `$${Number(plan.weekly_price_cents / 100).toLocaleString('en-US')}/week`;
}

async function getServicePlans({ activeOnly = false } = {}) {
  const sql = `SELECT * FROM service_plans ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order ASC, id ASC`;
  return db.all(sql, []);
}

async function getServicePlan(id) {
  return db.get('SELECT * FROM service_plans WHERE id = ?', [id]);
}

/** Admin: update a plan's name/price/description/features/active flag. */
async function updateServicePlan(id, { name, weekly_price_cents, description, features, active }) {
  const plan = await getServicePlan(id);
  if (!plan) throw new Error('Plan not found');
  const price = Number(weekly_price_cents);
  if (!Number.isFinite(price) || price < 0) throw new Error('Price must be a non-negative number of cents.');
  const feats = Array.isArray(features) ? JSON.stringify(features) : String(features || plan.features || '[]');
  await db.run(
    `UPDATE service_plans SET name = ?, weekly_price_cents = ?, description = ?, features = ?, active = ? WHERE id = ?`,
    [String(name || plan.name).slice(0, 80), Math.round(price), String(description || '').slice(0, 500), feats, active ? 1 : 0, id]
  );
  return getServicePlan(id);
}

async function getPlanSettings() {
  const row = await db.get('SELECT * FROM service_plan_settings WHERE id = 1');
  return row || { id: 1, billing_frequency: 'weekly', plans_enabled: 0, updated_at: null };
}

async function updatePlanSettings({ billing_frequency, plans_enabled }) {
  const cur = await getPlanSettings();
  const freq = PLAN_BILLING_FREQUENCIES.includes(billing_frequency) ? billing_frequency : cur.billing_frequency;
  await db.run('UPDATE service_plan_settings SET billing_frequency = ?, plans_enabled = ?, updated_at = ? WHERE id = 1', [
    freq, plans_enabled ? 1 : 0, Date.now(),
  ]);
  return getPlanSettings();
}

/** Append-only plan-change history for a driver (newest first). */
async function listPlanChanges(driverId) {
  return db.all('SELECT * FROM driver_plan_changes WHERE driver_id = ? ORDER BY created_at DESC, id DESC', [driverId]);
}

/** Current plan = to_plan_id of the latest approved/changed event, else null. */
async function getDriverPlan(driverId) {
  const row = await db.get(
    `SELECT to_plan_id FROM driver_plan_changes
      WHERE driver_id = ? AND event IN ('approved', 'changed')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [driverId]
  );
  return row ? row.to_plan_id : null;
}

async function getPendingPlanRequest(driverId) {
  const latest = await db.get(
    'SELECT * FROM driver_plan_changes WHERE driver_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [driverId]
  );
  return latest && latest.event === 'requested' ? latest : null;
}

async function appendPlanChange({ driverId, fromPlanId, toPlanId, event, note = '', createdBy = 'driver' }) {
  if (!PLAN_CHANGE_EVENTS.includes(event)) throw new Error('Unknown plan-change event');
  const info = await db.run(
    `INSERT INTO driver_plan_changes (driver_id, from_plan_id, to_plan_id, event, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [driverId, fromPlanId, toPlanId, event, String(note || '').slice(0, 500), createdBy, Date.now()]
  );
  return info.lastInsertRowid;
}

/**
 * Driver requests a plan. No public activation: the request stays pending
 * until operations approves it and service terms are in place.
 */
async function requestPlanChange(driverId, toPlanId, note = '') {
  const settings = await getPlanSettings();
  if (!settings.plans_enabled) throw new Error('Service plans are not currently open for requests.');
  const plan = await getServicePlan(toPlanId);
  if (!plan || !plan.active) throw new Error('That plan is not available.');
  const current = await getDriverPlan(driverId);
  if (current === toPlanId) throw new Error('You are already on this plan.');
  const pending = await getPendingPlanRequest(driverId);
  if (pending) throw new Error('You already have a pending plan request.');
  await appendPlanChange({ driverId, fromPlanId: current, toPlanId, event: 'requested', note, createdBy: 'driver' });
  await notifyOps(
    `Plan request: driver #${driverId} → ${plan.name} (${planPriceDisplay(plan)})`,
    `<p>Driver requested service plan <strong>${esc(plan.name)}</strong> (${esc(planPriceDisplay(plan))}).</p>`,
    'plan-request'
  );
  return getPendingPlanRequest(driverId);
}

/** Admin: approve or reject a pending plan request (appends, never rewrites). */
async function decidePlanRequest(driverId, outcome, note = '', by = 'admin') {
  if (!['approved', 'rejected'].includes(outcome)) throw new Error('Unknown decision');
  const pending = await getPendingPlanRequest(driverId);
  if (!pending) throw new Error('No pending plan request for this driver.');
  await appendPlanChange({
    driverId, fromPlanId: pending.from_plan_id, toPlanId: pending.to_plan_id,
    event: outcome, note, createdBy: by,
  });
  return listPlanChanges(driverId);
}

/** Admin: set a driver's plan directly (appends a 'changed' event). */
async function setDriverPlan(driverId, toPlanId, note = '', by = 'admin') {
  const plan = await getServicePlan(toPlanId);
  if (!plan) throw new Error('Plan not found');
  const current = await getDriverPlan(driverId);
  await appendPlanChange({ driverId, fromPlanId: current, toPlanId, event: 'changed', note, createdBy: by });
  return getDriverPlan(driverId);
}

async function listPendingPlanRequests() {
  // Drivers whose latest plan-change event is 'requested'.
  return db.all(
    `SELECT c.* FROM driver_plan_changes c
       WHERE c.event = 'requested'
         AND c.id = (SELECT MAX(id) FROM driver_plan_changes WHERE driver_id = c.driver_id)
       ORDER BY c.created_at DESC`,
    []
  );
}

// --- Operations dashboard / reporting / audit (Phase L) -----------------------------
async function countGrouped(table, column, where = '', params = []) {
  const rows = await db.all(
    `SELECT ${column} AS k, COUNT(*) AS c FROM ${table} ${where} GROUP BY ${column}`,
    params
  );
  const out = {};
  for (const r of rows) out[r.k ?? Object.values(r)[0]] = Number(r.c ?? Object.values(r)[1]);
  return out;
}

/** At-a-glance operations overview for the dashboard. */
async function getOpsOverview() {
  const [driversByStatus, routesByStatus, packagesByStatus, openExceptions, openTickets, urgentTickets, pendingPlanRequests, openReports] = await Promise.all([
    countGrouped('drivers', 'status'),
    countGrouped('routes', 'status'),
    countGrouped('packages', 'status'),
    countOpenExceptions(),
    db.get(`SELECT COUNT(*) c FROM support_tickets WHERE status IN ('open','in_progress','waiting_driver')`).then((r) => Number(r.c)),
    db.get(`SELECT COUNT(*) c FROM support_tickets WHERE priority = 'urgent' AND status IN ('open','in_progress')`).then((r) => Number(r.c)),
    listPendingPlanRequests().then((r) => r.length),
    db.get(`SELECT COUNT(*) c FROM community_reports WHERE status = 'open'`).then((r) => Number(r.c)),
  ]);
  return { driversByStatus, routesByStatus, packagesByStatus, openExceptions, openTickets, urgentTickets, pendingPlanRequests, openReports };
}

async function getRecentCustodyEvents(limit = 25) {
  return db.all(
    `SELECT e.*, d.full_name AS driver_name, p.recipient_name
       FROM custody_events e
       LEFT JOIN drivers d ON d.id = e.driver_id
       LEFT JOIN packages p ON p.package_id = e.package_id
      ORDER BY e.ts DESC, e.id DESC LIMIT ?`,
    [limit]
  );
}

async function getRecentDriverStatusChanges(limit = 25) {
  return db.all(
    `SELECT h.*, d.full_name AS driver_name
       FROM driver_status_history h
       LEFT JOIN drivers d ON d.id = h.driver_id
      ORDER BY h.ts DESC, h.id DESC LIMIT ?`,
    [limit]
  );
}

async function getRecentPlanChanges(limit = 25) {
  return db.all(
    `SELECT c.*, d.full_name AS driver_name
       FROM driver_plan_changes c
       LEFT JOIN drivers d ON d.id = c.driver_id
      ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
    [limit]
  );
}

/** Reporting aggregates for /admin/reports. */
async function getReports() {
  const [packagesByStatus, exceptionsByType, exceptionsByStatus, ticketsByCategory, ticketsByPriority, ticketsByStatus, planChangesByEvent, communityPostsByCategory] = await Promise.all([
    countGrouped('packages', 'status'),
    countGrouped('package_exceptions', 'exception_type'),
    countGrouped('package_exceptions', 'status'),
    countGrouped('support_tickets', 'category'),
    countGrouped('support_tickets', 'priority'),
    countGrouped('support_tickets', 'status'),
    countGrouped('driver_plan_changes', 'event'),
    countGrouped('community_posts', 'category'),
  ]);
  const custodyByDay = await db.all(
    `SELECT date(ts/1000, 'unixepoch') AS day, COUNT(*) AS c
       FROM custody_events
      WHERE ts >= ?
      GROUP BY day ORDER BY day DESC`,
    [Date.now() - 14 * 24 * 3600 * 1000]
  );
  return {
    packagesByStatus, exceptionsByType, exceptionsByStatus,
    ticketsByCategory, ticketsByPriority, ticketsByStatus,
    planChangesByEvent, communityPostsByCategory,
    custodyByDay: custodyByDay.map((r) => ({ day: r.day, count: Number(r.c) })),
  };
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
  getRouteProgress,
  EXCEPTION_STATUSES,
  EXCEPTION_STATUS_LABELS,
  validateExceptionInput,
  reportException,
  getException,
  getExceptionPhoto,
  listExceptions,
  countOpenExceptions,
  resolveException,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
  validateTicketInput,
  createTicket,
  getTicket,
  listTickets,
  addTicketReply,
  getTicketReplies,
  setTicketStatus,
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  COMMUNITY_POST_STATUSES,
  COMMUNITY_COMMENT_STATUSES,
  communityDisplayName,
  validateCommunityPost,
  createCommunityPost,
  getCommunityPost,
  listCommunityPosts,
  setCommunityPostPinned,
  setCommunityPostStatus,
  createCommunityComment,
  listCommunityComments,
  setCommunityCommentStatus,
  reportCommunityContent,
  listCommunityReports,
  reviewCommunityReport,
  PLAN_DISCLAIMER,
  PLAN_BILLING_FREQUENCIES,
  PLAN_CHANGE_EVENTS,
  planPriceDisplay,
  getServicePlans,
  getServicePlan,
  updateServicePlan,
  getPlanSettings,
  updatePlanSettings,
  listPlanChanges,
  getDriverPlan,
  getPendingPlanRequest,
  appendPlanChange,
  requestPlanChange,
  decidePlanRequest,
  setDriverPlan,
  listPendingPlanRequests,
  countGrouped,
  getOpsOverview,
  getRecentCustodyEvents,
  getRecentDriverStatusChanges,
  getRecentPlanChanges,
  getReports,
  onboardDriverEmail,
  onboardOpsEmail,
  statusChangeEmail,
};

// --- Phase 2: extended driver onboarding (spec section 10) ----------------------
// The A-L pipeline statuses (new/reviewing/.../active/inactive) keep running
// the general driver pipeline. The EXTENDED statuses track the formal
// application once an actual opportunity/dispatch relationship is relevant.
// They live in drivers.extended_status on the SAME drivers row — never a
// second drivers table — and every transition is recorded append-only in
// driver_onboard_history. The application itself is token-scoped
// (/drivers/apply/:token), shared by operations, not a public free-for-all.

/** Exact driver statuses from spec section 10 (stored verbatim). */
const EXTENDED_STATUSES = [
  'APPLIED',
  'SCREENING',
  'DOCUMENTS NEEDED',
  'BACKGROUND/MVR',
  'INSURANCE REVIEW',
  'VEHICLE REVIEW',
  'ORIENTATION',
  'TRAINING',
  'APPROVED',
  'READY FOR ROUTE',
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
  'REMOVED',
];
const EXTENDED_STATUS_LABELS = Object.fromEntries(EXTENDED_STATUSES.map((s) => [s, s]));

/** The 11 exact qualification checklist items from spec section 10. */
const QUAL_CHECKS = [
  'identity',
  'license',
  'insurance',
  'vehicle',
  'background_mvr',
  'documents',
  'agreement',
  'orientation',
  'training',
  'approved',
  'ready_for_route',
];
const QUAL_CHECK_LABELS = {
  identity: 'Identity verified',
  license: 'License verified',
  insurance: 'Insurance verified',
  vehicle: 'Vehicle verified',
  background_mvr: 'Background/MVR completed where applicable',
  documents: 'Required documents received',
  agreement: 'Agreement completed',
  orientation: 'Orientation completed',
  training: 'Training completed',
  approved: 'Approved',
  ready_for_route: 'Ready for route',
};

// Honest labeling: the application is never a promise of work or income.
const NO_GUARANTEE_APPLICATION =
  'Submitting this application does not guarantee approval, employment, routes, loads, contracts, income, or acceptance into any TransitNow program.';

/**
 * Move a driver's extended application status. Appends to
 * driver_onboard_history (never rewrites). Does NOT touch the Phase B
 * pipeline status column.
 */
async function setExtendedStatus(id, toStatus, { by = 'admin', note = '', notify = false } = {}) {
  if (!EXTENDED_STATUSES.includes(toStatus)) throw new Error(`Unknown extended status: ${toStatus}`);
  const driver = await getDriverById(id);
  if (!driver) throw new Error('Driver not found');
  const now = Date.now();
  if (driver.extended_status === toStatus) return driver;
  await db.run('UPDATE drivers SET extended_status = ?, updated_at = ? WHERE id = ?', [toStatus, now, id]);
  await db.run(
    'INSERT INTO driver_onboard_history (driver_id, from_status, to_status, changed_by, note, ts) VALUES (?, ?, ?, ?, ?, ?)',
    [id, driver.extended_status || null, toStatus, by, note || null, now]
  );
  if (notify && driver.email) {
    await queueDriverEmail({
      to: driver.email,
      subject: 'TransitNow — your driver application update',
      html: extendedStatusChangeEmail(driver, driver.extended_status, toStatus),
      sequence: 'driver-ops',
      step: 'extended-status-change',
    });
  }
  return getDriverById(id);
}

async function getOnboardHistory(driverId) {
  return db.all(
    'SELECT * FROM driver_onboard_history WHERE driver_id = ? ORDER BY ts ASC, id ASC',
    [driverId]
  );
}

/** Qualification checklist state: { check_key: { checked_by, note, ts } }. */
async function getQualChecks(driverId) {
  const rows = await db.all('SELECT * FROM driver_qual_checks WHERE driver_id = ?', [driverId]);
  const out = {};
  for (const r of rows) out[r.check_key] = { checked_by: r.checked_by, note: r.note, ts: r.ts };
  return out;
}

async function getQualCheckKeys(driverId) {
  return Object.keys(await getQualChecks(driverId));
}

/** Record one completed checklist item (timestamped). */
async function setQualCheck(driverId, key, { by = 'admin', note = '' } = {}) {
  if (!QUAL_CHECKS.includes(key)) throw new Error(`Unknown qualification check: ${key}`);
  const driver = await getDriverById(driverId);
  if (!driver) throw new Error('Driver not found');
  const now = Date.now();
  await db.run(
    `INSERT INTO driver_qual_checks (driver_id, check_key, checked_by, note, ts)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (driver_id, check_key) DO UPDATE SET checked_by = excluded.checked_by, note = excluded.note, ts = excluded.ts`,
    [driverId, key, by, note || null, now]
  );
  return getQualChecks(driverId);
}

/** Uncheck a checklist item (removes the record; history lives in driver_onboard_history). */
async function clearQualCheck(driverId, key) {
  if (!QUAL_CHECKS.includes(key)) throw new Error(`Unknown qualification check: ${key}`);
  await db.run('DELETE FROM driver_qual_checks WHERE driver_id = ? AND check_key = ?', [driverId, key]);
  return getQualChecks(driverId);
}

/** Bulk-save the checklist from an admin form: checked keys gain timestamped records, unchecked keys are removed. */
async function syncQualChecks(driverId, checkedKeys, { by = 'admin' } = {}) {
  const want = new Set((checkedKeys || []).filter((k) => QUAL_CHECKS.includes(k)));
  const have = new Set(await getQualCheckKeys(driverId));
  for (const k of want) if (!have.has(k)) await setQualCheck(driverId, k, { by });
  for (const k of have) if (!want.has(k)) await clearQualCheck(driverId, k);
  return getQualChecks(driverId);
}

// --- Extended application form validation --------------------------------------
// The extended application is the deeper, qualification-focused form used
// once an actual opportunity/dispatch relationship is relevant. It extends
// the onboarding data already on the driver row. Never collects SSN, bank
// account, or passwords — submissions carrying such keys are rejected.
const EXTENDED_FORBIDDEN = [
  'ssn', 'social_security', 'socialsecurity', 'bank_account', 'bankaccount',
  'account_number', 'routing_number', 'password', 'credit_card', 'card_number',
  'cc_number', 'cvv', 'cvc',
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateExtendedApplication(input) {
  const errors = [];
  const clean = {};
  const str = (k, max = 120) => String(input[k] == null ? '' : input[k]).trim().slice(0, max);

  const forbidden = Object.keys(input || {}).filter((k) =>
    EXTENDED_FORBIDDEN.includes(String(k).toLowerCase())
  );
  if (forbidden.length) errors.push('This form does not accept that kind of information.');

  clean.license_number = str('license_number', 40);
  clean.license_state = str('license_state', 20);
  clean.license_class = str('license_class', 10);
  clean.license_expiry = str('license_expiry', 10);
  clean.insurance_carrier = str('insurance_carrier', 120);
  clean.insurance_policy = str('insurance_policy', 60);
  clean.insurance_expiry = str('insurance_expiry', 10);
  if (!clean.license_number) errors.push("Driver's license number is required.");
  if (!clean.license_state) errors.push("Driver's license state is required.");
  if (!clean.license_class) errors.push("Driver's license class is required.");
  if (!DATE_RE.test(clean.license_expiry)) errors.push("Driver's license expiration date is required (YYYY-MM-DD).");
  if (!clean.insurance_carrier) errors.push('Insurance carrier is required.');
  if (!clean.insurance_policy) errors.push('Insurance policy number is required.');
  if (!DATE_RE.test(clean.insurance_expiry)) errors.push('Insurance expiration date is required (YYYY-MM-DD).');

  const yes = (k) => ['1', 'on', 'true', 'yes'].includes(String(input[k] || '').toLowerCase());
  clean.consent_background = yes('consent_background') ? 1 : 0;
  clean.consent_insurance_check = yes('consent_insurance_check') ? 1 : 0;
  clean.agreement_accepted = yes('agreement_accepted') ? 1 : 0;
  if (!clean.consent_background) errors.push('Consent for the background / MVR check is required to continue.');
  if (!clean.consent_insurance_check) errors.push('Consent for insurance verification is required to continue.');
  if (!clean.agreement_accepted) errors.push('You must accept the driver agreement to continue.');

  return { ok: errors.length === 0, errors, clean };
}

/**
 * Store the extended application on the EXISTING driver row and open the
 * application at APPLIED (never regresses an existing extended status).
 */
async function submitExtendedApplication(driverId, clean, { by = 'driver' } = {}) {
  const driver = await getDriverById(driverId);
  if (!driver) throw new Error('Driver not found');
  const now = Date.now();
  await db.run(
    `UPDATE drivers SET
       license_number = ?, license_state = ?, license_class = ?, license_expiry = ?,
       insurance_carrier = ?, insurance_policy = ?, insurance_expiry = ?,
       consent_background = ?, consent_insurance_check = ?,
       agreement_accepted = ?, agreement_accepted_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      clean.license_number, clean.license_state, clean.license_class, clean.license_expiry,
      clean.insurance_carrier, clean.insurance_policy, clean.insurance_expiry,
      clean.consent_background, clean.consent_insurance_check,
      clean.agreement_accepted, clean.agreement_accepted ? now : null, now, driverId,
    ]
  );
  let updated = await getDriverById(driverId);
  if (!updated.extended_status) {
    updated = await setExtendedStatus(driverId, 'APPLIED', {
      by,
      note: 'Extended driver application submitted',
    });
  }
  return updated;
}

function extendedApplicationDriverEmail(driver, dashUrl) {
  return `<p>Hi ${esc(driver.full_name)},</p>
<p><strong>We received your TransitNow driver application.</strong></p>
<p>Our team will review it against current and future opportunity requirements. ${esc(NO_GUARANTEE_APPLICATION)}</p>
<p><strong>Your driver dashboard:</strong> <a href="${esc(dashUrl)}">${esc(dashUrl)}</a></p>
<p>— TransitNow Operations</p>`;
}

function extendedApplicationOpsEmail(driver, applyUrl) {
  return `<p><strong>New extended driver application</strong></p>
<ul>
<li>Name: ${esc(driver.full_name)}</li>
<li>Email: ${esc(driver.email)}</li>
<li>Phone: ${esc(driver.phone || '—')}</li>
<li>License: ${esc(driver.license_class || '')} ${esc(driver.license_state || '')} exp ${esc(driver.license_expiry || '')}</li>
<li>Insurance: ${esc(driver.insurance_carrier || '')} exp ${esc(driver.insurance_expiry || '')}</li>
</ul>
<p><a href="${esc(applyUrl)}">Open extended driver profile (admin)</a></p>`;
}

function extendedStatusChangeEmail(driver, fromStatus, toStatus) {
  return `<p>Hi ${esc(driver.full_name)},</p>
<p>Your TransitNow driver application status changed: <strong>${esc(fromStatus || '—')}</strong> → <strong>${esc(toStatus)}</strong>.</p>
<p>If we need anything from you, we will contact you using the information on your application. ${esc(NO_GUARANTEE_APPLICATION)}</p>
<p>— TransitNow Operations</p>`;
}

// Phase 2 exports are attached after the definitions above (they must be
// declared before the export object is built).
Object.assign(module.exports, {
  EXTENDED_STATUSES,
  EXTENDED_STATUS_LABELS,
  QUAL_CHECKS,
  QUAL_CHECK_LABELS,
  setExtendedStatus,
  getOnboardHistory,
  getQualChecks,
  getQualCheckKeys,
  setQualCheck,
  clearQualCheck,
  syncQualChecks,
  validateExtendedApplication,
  submitExtendedApplication,
  extendedApplicationDriverEmail,
  extendedApplicationOpsEmail,
  extendedStatusChangeEmail,
  NO_GUARANTEE_APPLICATION,
});
