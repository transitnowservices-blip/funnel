'use strict';
/**
 * lib/opportunities.js — Phase 2: TransitNow Growth Ecosystem.
 *
 * Internal opportunity database (spec section 9) + opportunity matching
 * ("Potential Match" only — never a promise of employment, routes, loads,
 * contracts, or income) + the CRM-lead -> driver-application linkage
 * (deliverable 6). Additive; reuses the existing drivers and
 * opportunity_leads tables, never duplicates them.
 *
 * All timestamps are epoch milliseconds.
 */
const db = require('./db');
const drivers = require('./drivers');

// --- Opportunity statuses: EXACT strings from spec section 9 -------------------
const OPPORTUNITY_STATUSES = ['DRAFT', 'OPEN', 'QUALIFYING', 'FILLED', 'PAUSED', 'CLOSED'];
const OPPORTUNITY_STATUS_LABELS = Object.fromEntries(OPPORTUNITY_STATUSES.map((s) => [s, s]));

// Honest labeling for every match surface.
const POTENTIAL_MATCH_DISCLAIMER =
  'A "Potential Match" means this person may fit the opportunity requirements. ' +
  'It is not an offer or promise of employment, routes, loads, contracts, partnership, or income.';

function str(v, max = 2000) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function int0(v) {
  const n = Number.parseInt(String(v == null ? '' : v).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const OPPORTUNITY_COLS = [
  'name', 'client_contract', 'location', 'territory', 'opportunity_type',
  'vehicle_requirements', 'driver_requirements', 'insurance_requirements',
  'availability_requirements', 'service_area', 'start_date', 'end_date',
  'notes', 'documents', 'contact_info',
];

function validateOpportunity(input) {
  const errors = [];
  const clean = {};
  clean.name = str(input.name, 200);
  if (!clean.name) errors.push('Opportunity name is required.');
  for (const c of OPPORTUNITY_COLS) {
    if (c === 'name') continue;
    clean[c] = str(input[c], c === 'notes' || c === 'documents' ? 5000 : 2000);
  }
  if (clean.start_date && !/^\d{4}-\d{2}-\d{2}$/.test(clean.start_date)) {
    errors.push('Start date must be YYYY-MM-DD.');
  }
  if (clean.end_date && !/^\d{4}-\d{2}-\d{2}$/.test(clean.end_date)) {
    errors.push('End date must be YYYY-MM-DD.');
  }
  clean.drivers_needed = int0(input.drivers_needed);
  clean.vehicles_needed = int0(input.vehicles_needed);
  const status = str(input.status, 20).toUpperCase();
  clean.status = status || 'DRAFT';
  if (!OPPORTUNITY_STATUSES.includes(clean.status)) {
    errors.push(`Unknown opportunity status: ${input.status}`);
  }
  return { ok: errors.length === 0, errors, clean };
}

async function createOpportunity(clean, { by = 'admin' } = {}) {
  const now = Date.now();
  const cols = [...OPPORTUNITY_COLS, 'drivers_needed', 'vehicles_needed', 'status', 'created_by', 'created_at', 'updated_at'];
  const vals = [...OPPORTUNITY_COLS.map((c) => clean[c] || null),
    clean.drivers_needed, clean.vehicles_needed, clean.status, by, now, now];
  const info = await db.run(
    `INSERT INTO opportunities (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals
  );
  return getOpportunity(info.lastInsertRowid);
}

async function getOpportunity(id) {
  return db.get('SELECT * FROM opportunities WHERE id = ?', [id]);
}

async function updateOpportunity(id, clean) {
  const opp = await getOpportunity(id);
  if (!opp) throw new Error('Opportunity not found');
  const sets = [...OPPORTUNITY_COLS, 'drivers_needed', 'vehicles_needed'].map((c) => `${c} = ?`).join(', ');
  const vals = [...OPPORTUNITY_COLS.map((c) => clean[c] || null), clean.drivers_needed, clean.vehicles_needed];
  await db.run(`UPDATE opportunities SET ${sets}, updated_at = ? WHERE id = ?`, [...vals, Date.now(), id]);
  return getOpportunity(id);
}

async function setOpportunityStatus(id, toStatus, { by = 'admin' } = {}) {
  const s = String(toStatus || '').toUpperCase();
  if (!OPPORTUNITY_STATUSES.includes(s)) throw new Error(`Unknown opportunity status: ${toStatus}`);
  const opp = await getOpportunity(id);
  if (!opp) throw new Error('Opportunity not found');
  await db.run('UPDATE opportunities SET status = ?, updated_at = ? WHERE id = ?', [s, Date.now(), id]);
  return getOpportunity(id);
}

async function listOpportunities({ status = null } = {}) {
  const sql = status
    ? 'SELECT * FROM opportunities WHERE status = ? ORDER BY updated_at DESC, id DESC'
    : 'SELECT * FROM opportunities ORDER BY updated_at DESC, id DESC';
  return db.all(sql, status ? [status] : []);
}

async function countOpportunitiesByStatus() {
  const rows = await db.all('SELECT status, COUNT(*) c FROM opportunities GROUP BY status');
  const out = {};
  for (const s of OPPORTUNITY_STATUSES) out[s] = 0;
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

// --- Potential matches ----------------------------------------------------------
// person_type: 'lead' (opportunity_leads) or 'driver' (drivers).
const PERSON_TYPES = ['lead', 'driver'];

async function personSummary(personType, personId) {
  if (personType === 'lead') {
    const l = await db.get('SELECT id, lead_type, status, first_name, last_name, email, phone, city, state FROM opportunity_leads WHERE id = ?', [personId]);
    return l ? { id: l.id, name: `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email, detail: `${l.lead_type} · ${l.status}` } : null;
  }
  const d = await drivers.getDriverById(personId);
  return d ? { id: d.id, name: d.full_name, detail: `Driver · ${d.extended_status || drivers.STATUS_LABELS[d.status] || d.status}` } : null;
}

/**
 * Record a "Potential Match" between an opportunity and a CRM lead or a
 * driver. Idempotent: recording the same pair twice returns the existing
 * record. NEVER promises employment, routes, loads, contracts, or income —
 * the UI copy carries that disclaimer everywhere a match appears.
 */
async function recordMatch({ opportunityId, personType, personId, note = '', by = 'admin' }) {
  if (!PERSON_TYPES.includes(personType)) throw new Error(`Unknown person type: ${personType}`);
  const opp = await getOpportunity(opportunityId);
  if (!opp) throw new Error('Opportunity not found');
  const person = await personSummary(personType, personId);
  if (!person) throw new Error(`${personType === 'lead' ? 'Lead' : 'Driver'} not found`);
  const now = Date.now();
  await db.run(
    `INSERT INTO opportunity_matches (opportunity_id, person_type, person_id, matched_by, note, ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (opportunity_id, person_type, person_id) DO UPDATE SET note = excluded.note, matched_by = excluded.matched_by`,
    [opportunityId, personType, personId, by, str(note, 2000) || null, now]
  );
  return db.get(
    'SELECT * FROM opportunity_matches WHERE opportunity_id = ? AND person_type = ? AND person_id = ?',
    [opportunityId, personType, personId]
  );
}

async function listMatchesForOpportunity(opportunityId) {
  return db.all('SELECT * FROM opportunity_matches WHERE opportunity_id = ? ORDER BY ts DESC, id DESC', [opportunityId]);
}

async function listMatchesForPerson(personType, personId) {
  const rows = await db.all(
    'SELECT * FROM opportunity_matches WHERE person_type = ? AND person_id = ? ORDER BY ts DESC, id DESC',
    [personType, personId]
  );
  const out = [];
  for (const m of rows) {
    out.push({ ...m, opportunity: await getOpportunity(m.opportunity_id) });
  }
  return out;
}

async function countMatches() {
  const r = await db.get('SELECT COUNT(*) c FROM opportunity_matches');
  return Number(r.c);
}

/**
 * Side-by-side comparison to help an admin judge fit: opportunity
 * requirements vs. the candidate's own profile data. The admin decides —
 * nothing here scores, ranks, or auto-promises anything.
 */
async function compareCandidate(opportunity, { lead = null, driver = null } = {}) {
  const rows = [];
  const push = (requirement, required, candidate) => rows.push({ requirement, required: required || '—', candidate: candidate || '—' });
  if (lead) {
    const vehicle = [lead.vehicle_year, lead.vehicle_make, lead.vehicle_model].filter(Boolean).join(' ');
    let avail = [];
    try { avail = JSON.parse(lead.avail_days || '[]'); } catch { avail = []; }
    push('Vehicle requirements', opportunity.vehicle_requirements, `${vehicle} (${lead.vehicle_type || '—'})`.trim());
    push('Driver requirements', opportunity.driver_requirements, `Experience: ${lead.experience_level || '—'}`);
    push('Insurance requirements', opportunity.insurance_requirements, 'See readiness checklist below');
    push('Availability requirements', opportunity.availability_requirements,
      `${avail.join(', ') || '—'} ${lead.avail_start || ''}–${lead.avail_end || ''}`.trim());
    push('Service area', opportunity.service_area, `${lead.primary_city || lead.city || ''}, ${lead.primary_state || lead.state || ''}`.replace(/^, $/, ''));
    let readiness = [];
    try { readiness = JSON.parse(lead.readiness || '[]'); } catch { readiness = []; }
    push('Readiness (self-reported)', '—', readiness.join(', '));
  } else if (driver) {
    const vehicle = [driver.vehicle_year, driver.vehicle_make_model, driver.vehicle_type].filter(Boolean).join(' ');
    push('Vehicle requirements', opportunity.vehicle_requirements, vehicle);
    push('Driver requirements', opportunity.driver_requirements,
      `License: ${driver.license_class || '—'} ${driver.license_state || ''} · ${driver.years_in_business || '—'} yrs in business`);
    push('Insurance requirements', opportunity.insurance_requirements,
      `${driver.insurance_carrier || driver.insurance_status || '—'}${driver.insurance_expiry ? ` exp ${driver.insurance_expiry}` : ''}`);
    push('Availability requirements', opportunity.availability_requirements,
      `${(driver.days_available || []).join(', ') || '—'} ${driver.hours_available || ''}`.trim());
    push('Service area', opportunity.service_area,
      `${driver.home_city || ''}, ${driver.home_state || ''}${driver.service_radius ? ` (radius ${driver.service_radius})` : ''}`.replace(/^, /, ''));
    const checks = await drivers.getQualCheckKeys(driver.id);
    push('Qualification checks complete', '—', checks.length ? checks.map((k) => drivers.QUAL_CHECK_LABELS[k]).join('; ') : 'none yet');
  }
  return rows;
}

// --- CRM lead -> driver application linkage (deliverable 6) ----------------------
/**
 * "Start driver application" (admin action on a CRM lead). Links the
 * existing opportunity_leads row to a driver record:
 *   - If a driver with the lead's email already exists, it is REUSED —
 *     the person is never copied into a duplicate record.
 *   - Otherwise a minimal driver row is created from the lead's contact
 *     fields (pipeline status 'new'; extended application NOT yet started —
 *     that happens when the candidate submits /drivers/apply/:token).
 * The linkage is stored in lead_driver_links and noted on the lead's
 * communications log. Returns { driver, linked, created, applyUrl }.
 */
async function startDriverApplication(leadId, { by = 'admin', baseUrl = '' } = {}) {
  const lead = await db.get('SELECT * FROM opportunity_leads WHERE id = ?', [leadId]);
  if (!lead) throw new Error('Lead not found');
  if (!lead.email) throw new Error('Lead has no email address — cannot start a driver application.');

  let driver = await drivers.getDriverByEmail(lead.email);
  let created = false;
  if (!driver) {
    const now = Date.now();
    const fullName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || lead.email;
    const cm = ['call', 'text', 'email'].includes(String(lead.preferred_contact || '').toLowerCase())
      ? String(lead.preferred_contact).toLowerCase() : 'text';
    let availDays = [];
    try { availDays = JSON.parse(lead.avail_days || '[]'); } catch { availDays = []; }
    // Vehicle details live on lead_vehicles (not on the lead row itself).
    const lv = await db.get('SELECT * FROM lead_vehicles WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [lead.id]);
    const info = await db.run(
      `INSERT INTO drivers
         (full_name, email, phone, contact_method, vehicle_type, vehicle_year,
          vehicle_make_model, home_city, home_state, days_available,
          hours_available, lane_prefs, source, status, submitted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'direct', 'new', ?, ?)`,
      [
        fullName, String(lead.email).toLowerCase(), lead.phone || null, cm,
        (lv && lv.vehicle_type) || null, (lv && lv.year) || null,
        (lv && [lv.make, lv.model].filter(Boolean).join(' ')) || null,
        lead.city || lead.primary_city || null, lead.state || lead.primary_state || null,
        JSON.stringify(availDays),
        [lead.avail_start, lead.avail_end].filter(Boolean).join('–') || null,
        lead.preferred_areas || null, now, now,
      ]
    );
    const newId = info.lastInsertRowid;
    // Reuse the standard onboarding bookkeeping (access token + history)
    // so the new row behaves exactly like an onboarded driver.
    const token = require('crypto').randomBytes(32).toString('hex');
    await db.run('UPDATE drivers SET access_token = ? WHERE id = ?', [token, newId]);
    await db.run(
      'INSERT INTO driver_status_history (driver_id, from_status, to_status, changed_by, note, ts) VALUES (?, ?, ?, ?, ?, ?)',
      [newId, null, 'new', 'system', `Driver application started from CRM lead #${lead.id} (${lead.lead_type})`, now]
    );
    driver = await drivers.getDriverById(newId);
    created = true;
  }

  const now = Date.now();
  let linked = false;
  try {
    await db.run(
      'INSERT INTO lead_driver_links (lead_id, driver_id, created_by, created_at) VALUES (?, ?, ?, ?)',
      [lead.id, driver.id, by, now]
    );
    linked = true;
  } catch (err) {
    // UNIQUE(lead_id, driver_id) — already linked; keep the existing link.
    if (!String(err && err.message || '').includes('UNIQUE')) throw err;
  }
  if (linked) {
    await db.run(
      `INSERT INTO lead_communications (lead_id, kind, subject, body, direction, ts)
       VALUES (?, 'note', 'Driver application started', ?, 'internal', ?)`,
      [lead.id, `Linked to driver #${driver.id} (${driver.full_name}). Extended application link: ${baseUrl}/drivers/apply/${driver.access_token}`, now]
    );
    await drivers.addDriverNote(
      driver.id,
      `Driver application started from CRM lead #${lead.id} (${lead.lead_type}, ${lead.status}) by ${by}.`,
      by
    );
  }
  return {
    driver,
    linked,
    created,
    applyUrl: `${baseUrl}/drivers/apply/${driver.access_token}`,
  };
}

async function getDriverLinkForLead(leadId) {
  const link = await db.get(
    'SELECT * FROM lead_driver_links WHERE lead_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [leadId]
  );
  if (!link) return null;
  return { ...link, driver: await drivers.getDriverById(link.driver_id) };
}

async function getLeadLinkForDriver(driverId) {
  const link = await db.get(
    'SELECT * FROM lead_driver_links WHERE driver_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [driverId]
  );
  if (!link) return null;
  const lead = await db.get('SELECT * FROM opportunity_leads WHERE id = ?', [link.lead_id]);
  return { ...link, lead };
}

module.exports = {
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_STATUS_LABELS,
  POTENTIAL_MATCH_DISCLAIMER,
  validateOpportunity,
  createOpportunity,
  getOpportunity,
  updateOpportunity,
  setOpportunityStatus,
  listOpportunities,
  countOpportunitiesByStatus,
  PERSON_TYPES,
  personSummary,
  recordMatch,
  listMatchesForOpportunity,
  listMatchesForPerson,
  countMatches,
  compareCandidate,
  startDriverApplication,
  getDriverLinkForLead,
  getLeadLinkForDriver,
};
