// lib/grow.js — Phase 1: TransitNow Growth Ecosystem logic.
//
// Shared opportunity-lead database for the GROW, BUSINESS and RSP funnels
// (distinguished by lead_type). Pure DB + validation + email-queue helpers;
// no Express code here. Additive — nothing in the existing app is touched.
'use strict';

const crypto = require('crypto');
const db = require('./db');
const emailLib = require('./email');
const config = require('./config');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Status pipelines -----------------------------------------------------------
// Exact statuses from spec section 7 (Grow) and section 29 (Business).
const GROW_STATUSES = [
  'NEW', 'REVIEWING', 'CONTACTED', 'QUALIFYING', 'DOCUMENTS NEEDED',
  'DRIVER READY', 'BUSINESS OPPORTUNITY', 'DISPATCH OPPORTUNITY', 'RSP INTEREST',
  'PARTNERSHIP', 'WAITLIST', 'ACTIVE', 'NOT A FIT CURRENTLY', 'CLOSED',
];
const BUSINESS_STATUSES = [
  'NEW', 'QUALIFYING', 'CONTACTED', 'DISCOVERY', 'PROPOSAL',
  'CONTRACT REVIEW', 'CONTRACTED', 'ONBOARDING', 'ACTIVE', 'PAUSED', 'CLOSED',
];
const LEAD_TYPES = ['GROW', 'BUSINESS', 'RSP'];

function pipelineFor(leadType) {
  return leadType === 'BUSINESS' ? BUSINESS_STATUSES : GROW_STATUSES;
}
function defaultStatusFor(leadType) {
  if (leadType === 'BUSINESS') return 'NEW';
  if (leadType === 'RSP') return 'RSP INTEREST';
  return 'NEW';
}

// Internal admin-only tags (spec section 8).
const INTERNAL_TAGS = [
  'DRIVER', 'DISPATCH', 'ROUTE', 'FLEET', 'PARTNERSHIP', 'RSP', 'OPERATIONS',
  'RECRUITING', 'TRAINING', 'BUSINESS OWNER', 'FUTURE OPPORTUNITY',
];

// --- Small sanitizers ------------------------------------------------------------
function str(v, max = 2000) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function arr(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter((x) => x !== '');
}
function jsonArr(v) {
  return JSON.stringify(arr(v).map((x) => str(x, 120)));
}
function pick(v, allowed) {
  const s = str(v, 60);
  return allowed.includes(s) ? s : '';
}

// Field names we must NEVER accept — defense in depth; the forms never ask
// for these, but any submission carrying them is rejected outright.
const FORBIDDEN_FIELDS = [
  'ssn', 'social_security', 'socialsecurity', 'bank_account', 'bankaccount',
  'account_number', 'routing_number', 'password', 'credit_card', 'card_number',
  'cc_number', 'cvv', 'cvc',
];

// --- Grow application field normalization -------------------------------------------
const ROLE_OPTIONS = [
  'independent-driver', 'courier', 'delivery-driver', 'dispatcher',
  'transportation-business-owner', 'fleet-owner', 'rideshare-driver',
  'medical-courier', 'last-mile', 'warehouse-logistics', 'transportation-management',
  'driver-recruiter', 'driver-manager', 'business-owner', 'operations', 'other',
];
const EXP_OPTIONS = ['<6mo', '6-12mo', '1-2y', '3-5y', '5+y', 'new'];
const VEHICLE_OPTIONS = [
  'car', 'suv', 'minivan', 'cargo-van', 'sprinter-van', 'pickup-truck',
  'box-truck', 'step-van', 'other', 'none', 'looking',
];
const OWNERSHIP_OPTIONS = ['own', 'lease', 'company', 'other'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const AVAIL_TYPE_OPTIONS = ['full-time', 'part-time', 'seasonal', 'on-demand', 'dedicated', 'flexible'];
const AREA_TYPE_OPTIONS = ['local', 'within-city', 'within-25', 'within-50', 'regional', 'multi-state', 'flexible'];
const BUSINESS_HELP_OPTIONS = [
  'finding-routes', 'delivery-opportunities', 'dispatch', 'operations',
  'driver-recruiting', 'driver-management', 'fleet-management', 'technology',
  'business-development', 'contract-opportunities', 'rsp-opportunities', 'scaling', 'other',
];
const GROWTH_INTEREST_OPTIONS = [
  'dispatch', 'route-management', 'driver-recruiting', 'driver-training',
  'operations', 'fleet-management', 'customer-support', 'supervisor-team-lead',
  'contract-management', 'business-development', 'business-ownership', 'rsp-opportunities',
];
const OPP_INTEREST_OPTIONS = [
  'local-routes', 'regional-routes', 'same-day', 'last-mile', 'medical-courier',
  'dedicated-routes', 'overflow', 'contract-opportunities', 'dispatch-services',
  'building-business', 'joining-team', 'managing-team', 'rsp-opportunities',
  'learning-logistics', 'not-sure',
];
const READINESS_OPTIONS = [
  'license', 'vehicle-registration', 'personal-auto-insurance', 'commercial-auto-insurance',
  'business-insurance', 'registered-business', 'ein', 'w9-ready', 'experience',
  'background-mvr-ready', 'none-yet', 'not-sure',
];
const FUTURE_ROLE_OPTIONS = [
  'driver', 'dispatcher', 'route-manager', 'fleet-owner', 'business-owner',
  'operations', 'rsp-operator', 'contractor-partner', 'other', 'not-sure',
];
const SOURCE_OPTIONS = [
  'tiktok', 'facebook', 'instagram', 'youtube', 'google', 'referral',
  'website', 'friend-family', 'business-partner', 'other',
];

function normalizeGrow(b) {
  const out = {};
  out.first_name = str(b.first_name, 120);
  out.last_name = str(b.last_name, 120);
  out.email = str(b.email, 254).toLowerCase();
  out.phone = str(b.phone, 40);
  out.preferred_contact = pick(b.contact_pref || b.preferred_contact, ['call', 'text', 'email']);
  out.city = str(b.city, 120);
  out.state = str(b.state, 60);
  out.zip = str(b.zip, 20);
  out.about_you = str(b.about_you, 5000);
  out.why_interested = str(b.why_interested, 5000);
  out.current_roles = jsonArr(arr(b.current_roles).filter((r) => ROLE_OPTIONS.includes(r)));
  out.experience_level = pick(b.experience_level, EXP_OPTIONS);
  // Step 3: no-vehicle exemption — people without a vehicle are never
  // required to provide vehicle details.
  out.vehicle_type = pick(b.vehicle_type, VEHICLE_OPTIONS);
  const noVehicle = out.vehicle_type === 'none' || out.vehicle_type === 'looking';
  out.vehicle_ownership = noVehicle ? '' : pick(b.vehicle_ownership, OWNERSHIP_OPTIONS);
  out.vehicle_year = noVehicle ? '' : str(b.vehicle_year, 10);
  out.vehicle_make = noVehicle ? '' : str(b.vehicle_make, 60);
  out.vehicle_model = noVehicle ? '' : str(b.vehicle_model, 60);
  out.cargo_capacity = noVehicle ? '' : str(b.cargo_capacity, 120);
  out.payload = noVehicle ? '' : str(b.payload, 120);
  out.special_equipment = noVehicle ? '' : str(b.special_equipment, 500);
  // Step 4
  out.avail_days = jsonArr(arr(b.avail_days).filter((d) => DAYS.includes(d)));
  out.avail_start = str(b.avail_start, 10);
  out.avail_end = str(b.avail_end, 10);
  out.avail_days_per_week = str(b.avail_days_per_week, 10);
  out.avail_type = jsonArr(arr(b.avail_type).filter((a) => AVAIL_TYPE_OPTIONS.includes(a)));
  out.schedule_notes = str(b.schedule_notes, 2000);
  // Step 5
  out.service_area_type = jsonArr(arr(b.service_area_type).filter((a) => AREA_TYPE_OPTIONS.includes(a)));
  out.primary_city = str(b.primary_city, 120);
  out.primary_state = str(b.primary_state, 60);
  out.preferred_areas = str(b.preferred_areas, 500);
  out.travel_states = str(b.travel_states, 200);
  // Step 6: business conditional — details only kept when has_business=yes.
  out.has_business = pick(b.has_business, ['yes', 'no']);
  const biz = {
    business_name: out.has_business === 'yes' ? str(b.business_name, 160) : '',
    business_type: out.has_business === 'yes' ? str(b.business_type, 120) : '',
    years_operating: out.has_business === 'yes' ? str(b.years_operating, 40) : '',
    website: out.has_business === 'yes' ? str(b.website, 200) : '',
    business_email: out.has_business === 'yes' ? str(b.business_email, 254).toLowerCase() : '',
    num_drivers: out.has_business === 'yes' ? str(b.num_drivers, 20) : '',
    num_vehicles: out.has_business === 'yes' ? str(b.num_vehicles, 20) : '',
    service_area: out.has_business === 'yes' ? str(b.service_area, 200) : '',
    services_provided: out.has_business === 'yes' ? str(b.services_provided, 1000) : '',
    current_clients: out.has_business === 'yes' ? str(b.current_clients, 1000) : '',
  };
  out.business_help = jsonArr(arr(b.business_help).filter((x) => BUSINESS_HELP_OPTIONS.includes(x)));
  // Step 7
  out.growth_interests = jsonArr(arr(b.growth_interests).filter((x) => GROWTH_INTEREST_OPTIONS.includes(x)));
  out.managed_before = pick(b.managed_before, ['yes', 'no']);
  out.managed_count = out.managed_before === 'yes' ? str(b.managed_count, 20) : '';
  // Steps 8-9
  out.opportunity_interests = jsonArr(arr(b.opportunity_interests).filter((x) => OPP_INTEREST_OPTIONS.includes(x)));
  out.readiness = jsonArr(arr(b.readiness).filter((x) => READINESS_OPTIONS.includes(x)));
  // Step 10
  out.goals_12mo = str(b.goals_12mo, 5000);
  out.growth_vision = str(b.growth_vision, 5000);
  out.future_role = pick(b.future_role, FUTURE_ROLE_OPTIONS);
  // Steps 11-12
  out.something_else = str(b.something_else, 5000);
  out.source = pick(b.source, SOURCE_OPTIONS);
  out.referral_name = str(b.referral_name, 160);
  out.referral_code = str(b.referral_code, 60);
  // Step 13
  out.marketing_consent = ['yes', 'on', '1', 'true'].includes(String(b.marketing_consent).toLowerCase()) ? 1 : 0;
  return { fields: out, biz };
}

function validateGrow(n) {
  const f = n.fields;
  const errors = [];
  if (!f.first_name) errors.push('First name is required.');
  if (!EMAIL_RE.test(f.email)) errors.push('A valid email address is required.');
  if (!f.phone) errors.push('Phone is required.');
  if (!f.city) errors.push('City is required.');
  if (!f.state) errors.push('State is required.');
  if (f.has_business === 'yes' && n.biz.business_email && !EMAIL_RE.test(n.biz.business_email)) {
    errors.push('Business email looks invalid.');
  }
  return errors;
}

// Auto-tags derived from the applicant's own answers (spec section 8 tags).
function autoTagsFor(f) {
  const tags = new Set();
  const roles = JSON.parse(f.current_roles || '[]');
  const opp = JSON.parse(f.opportunity_interests || '[]');
  const growth = JSON.parse(f.growth_interests || '[]');
  const help = JSON.parse(f.business_help || '[]');
  if (roles.some((r) => ['independent-driver', 'courier', 'delivery-driver', 'rideshare-driver', 'medical-courier', 'last-mile'].includes(r))) tags.add('DRIVER');
  if (roles.includes('dispatcher') || growth.includes('dispatch') || opp.includes('dispatch-services') || help.includes('dispatch')) tags.add('DISPATCH');
  if (growth.includes('route-management') || opp.includes('local-routes') || opp.includes('regional-routes') || opp.includes('dedicated-routes') || help.includes('finding-routes')) tags.add('ROUTE');
  if (roles.includes('fleet-owner') || growth.includes('fleet-management') || help.includes('fleet-management')) tags.add('FLEET');
  if (roles.includes('transportation-business-owner') || roles.includes('business-owner') || f.has_business === 'yes' || growth.includes('business-ownership') || opp.includes('building-business') || opp.includes('contract-opportunities')) tags.add('BUSINESS OWNER');
  if (opp.includes('rsp-opportunities') || growth.includes('rsp-opportunities') || help.includes('rsp-opportunities')) tags.add('RSP');
  if (roles.includes('operations') || roles.includes('transportation-management') || growth.includes('operations') || help.includes('operations')) tags.add('OPERATIONS');
  if (roles.includes('driver-recruiter') || growth.includes('driver-recruiting') || help.includes('driver-recruiting')) tags.add('RECRUITING');
  if (growth.includes('driver-training')) tags.add('TRAINING');
  if (roles.includes('driver-manager') || growth.includes('supervisor-team-lead') || opp.includes('managing-team') || f.managed_before === 'yes') tags.add('OPERATIONS');
  if (!tags.size) tags.add('FUTURE OPPORTUNITY');
  return [...tags];
}

// --- Lead persistence --------------------------------------------------------------
const LEAD_COLS = [
  'lead_type', 'status', 'first_name', 'last_name', 'email', 'phone', 'preferred_contact',
  'city', 'state', 'zip', 'about_you', 'why_interested', 'current_roles', 'experience_level',
  'vehicle_type', 'vehicle_ownership', 'vehicle_year', 'vehicle_make', 'vehicle_model',
  'cargo_capacity', 'payload', 'special_equipment', 'avail_days', 'avail_start', 'avail_end',
  'avail_days_per_week', 'avail_type', 'schedule_notes', 'service_area_type', 'primary_city',
  'primary_state', 'preferred_areas', 'travel_states', 'has_business', 'business_help',
  'growth_interests', 'managed_before', 'managed_count', 'opportunity_interests', 'readiness',
  'goals_12mo', 'growth_vision', 'future_role', 'something_else', 'source', 'referral_name',
  'referral_code', 'marketing_consent',
];

async function findLeadByEmail(email, leadType) {
  return db.get('SELECT * FROM opportunity_leads WHERE email = ? AND lead_type = ?', [email, leadType]);
}

/**
 * Create or update an opportunity lead. Duplicate submissions (same email +
 * lead_type) UPDATE the existing row instead of creating a second one; the
 * update is recorded in lead_communications and the confirmation email is
 * still sent. Returns { lead, created }.
 */
async function upsertLead(leadType, fields, opts = {}) {
  const now = Date.now();
  const existing = await findLeadByEmail(fields.email, leadType);
  let lead;
  let created;
  if (existing) {
    const sets = LEAD_COLS.filter((c) => c !== 'lead_type' && c !== 'status')
      .map((c) => `${c} = ?`).join(', ');
    const vals = LEAD_COLS.filter((c) => c !== 'lead_type' && c !== 'status')
      .map((c) => fields[c] == null ? '' : fields[c]);
    await db.run(
      `UPDATE opportunity_leads SET ${sets}, updated_at = ? WHERE id = ?`,
      [...vals, now, existing.id]
    );
    await db.run(
      `INSERT INTO lead_communications (lead_id, kind, subject, body, direction, ts)
       VALUES (?, 'note', 'Application resubmitted', 'Applicant resubmitted their application; record updated.', 'inbound', ?)`,
      [existing.id, now]
    );
    lead = await db.get('SELECT * FROM opportunity_leads WHERE id = ?', [existing.id]);
    created = false;
  } else {
    const cols = [...LEAD_COLS];
    const vals = cols.map((c) => {
      if (c === 'lead_type') return leadType;
      if (c === 'status') return defaultStatusFor(leadType);
      if (c === 'marketing_consent') return fields.marketing_consent ? 1 : 0;
      return fields[c] == null ? '' : fields[c];
    });
    const info = await db.run(
      `INSERT INTO opportunity_leads (${cols.join(', ')}, marketing_consent_ts, created_at, updated_at)
       VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?)`,
      [...vals, fields.marketing_consent ? now : null, now, now]
    );
    const id = Number(info.lastInsertRowid);
    await db.run(
      `INSERT INTO lead_status_history (lead_id, from_status, to_status, changed_by, note, ts)
       VALUES (?, NULL, ?, 'system', 'Application received', ?)`,
      [id, defaultStatusFor(leadType), now]
    );
    lead = await db.get('SELECT * FROM opportunity_leads WHERE id = ?', [id]);
    created = true;
  }
  if (fields.marketing_consent && !lead.marketing_consent_ts) {
    await db.run('UPDATE opportunity_leads SET marketing_consent_ts = ? WHERE id = ?', [now, lead.id]);
  }
  return { lead, created };
}

async function replaceRelated(leadId, table, row) {
  await db.run(`DELETE FROM ${table} WHERE lead_id = ?`, [leadId]);
  const cols = Object.keys(row);
  await db.run(
    `INSERT INTO ${table} (lead_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
    [leadId, ...cols.map((c) => row[c])]
  );
}

async function saveGrowRelated(leadId, n) {
  const f = n.fields;
  const now = Date.now();
  await replaceRelated(leadId, 'lead_vehicles', {
    vehicle_type: f.vehicle_type, ownership: f.vehicle_ownership, year: f.vehicle_year,
    make: f.vehicle_make, model: f.vehicle_model, cargo_capacity: f.cargo_capacity,
    payload: f.payload, special_equipment: f.special_equipment, created_at: now,
  });
  await replaceRelated(leadId, 'lead_business_info', { ...n.biz, created_at: now });
  await replaceRelated(leadId, 'lead_goals', {
    goals_12mo: f.goals_12mo, growth_vision: f.growth_vision, future_role: f.future_role, created_at: now,
  });
  await replaceRelated(leadId, 'lead_sources', {
    source: f.source, referral_name: f.referral_name, referral_code: f.referral_code, created_at: now,
  });
}

async function addLeadTags(leadId, tagsList) {
  const now = Date.now();
  for (const t of tagsList) {
    await db.run('INSERT OR IGNORE INTO opportunity_lead_tags (lead_id, tag, ts) VALUES (?, ?, ?)', [leadId, t, now]);
  }
}
async function leadTags(leadId) {
  return db.all('SELECT tag FROM opportunity_lead_tags WHERE lead_id = ? ORDER BY tag', [leadId]);
}

async function getLeadProfile(leadId) {
  const lead = await db.get('SELECT * FROM opportunity_leads WHERE id = ?', [leadId]);
  if (!lead) return null;
  const [vehicle, business, goals, sources, history, notes, comms, tagsList] = await Promise.all([
    db.get('SELECT * FROM lead_vehicles WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [leadId]),
    db.get('SELECT * FROM lead_business_info WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [leadId]),
    db.get('SELECT * FROM lead_goals WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [leadId]),
    db.get('SELECT * FROM lead_sources WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [leadId]),
    db.all('SELECT * FROM lead_status_history WHERE lead_id = ? ORDER BY ts DESC, id DESC', [leadId]),
    db.all('SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY ts DESC, id DESC', [leadId]),
    db.all('SELECT * FROM lead_communications WHERE lead_id = ? ORDER BY ts DESC, id DESC LIMIT 100', [leadId]),
    leadTags(leadId),
  ]);
  return { lead, vehicle, business, goals, sources, history, notes, comms, tags: tagsList };
}

// --- Status changes (append-only history) --------------------------------------------
async function changeLeadStatus(leadId, toStatus, changedBy = 'admin', note = '') {
  const lead = await db.get('SELECT * FROM opportunity_leads WHERE id = ?', [leadId]);
  if (!lead) throw new Error('Lead not found');
  const allowed = pipelineFor(lead.lead_type);
  if (!allowed.includes(toStatus)) throw new Error(`Invalid status "${toStatus}" for ${lead.lead_type} pipeline`);
  if (lead.status === toStatus) return { changed: false, lead };
  const now = Date.now();
  await db.run('UPDATE opportunity_leads SET status = ?, updated_at = ? WHERE id = ?', [toStatus, now, leadId]);
  await db.run(
    `INSERT INTO lead_status_history (lead_id, from_status, to_status, changed_by, note, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [leadId, lead.status, toStatus, changedBy, str(note, 1000), now]
  );
  return { changed: true, lead: await db.get('SELECT * FROM opportunity_leads WHERE id = ?', [leadId]) };
}

async function addLeadNote(leadId, author, note) {
  const n = str(note, 5000);
  if (!n) throw new Error('Note is empty');
  await db.run('INSERT INTO lead_notes (lead_id, author, note, ts) VALUES (?, ?, ?, ?)',
    [leadId, str(author, 120) || 'admin', n, Date.now()]);
  await db.run('UPDATE opportunity_leads SET updated_at = ? WHERE id = ?', [Date.now(), leadId]);
}

async function setFollowUp(leadId, followUpDate, assignedTo) {
  await db.run(
    'UPDATE opportunity_leads SET follow_up_date = ?, assigned_to = ?, updated_at = ? WHERE id = ?',
    [str(followUpDate, 20), str(assignedTo, 120), Date.now(), leadId]
  );
}

// --- Drafts (Save & Continue Later) -----------------------------------------------------
function newDraftToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function saveDraft({ token, leadType = 'GROW', step = 1, data = {} }) {
  const now = Date.now();
  const safe = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (FORBIDDEN_FIELDS.includes(String(k).toLowerCase())) continue;
    safe[String(k).slice(0, 60)] = typeof v === 'string' ? v.slice(0, 5000) : v;
  }
  const email = str(safe.email || '', 254).toLowerCase();
  let t = token && /^[a-f0-9]{48}$/.test(token) ? token : newDraftToken();
  const existing = await db.get('SELECT id FROM opportunity_lead_drafts WHERE token = ?', [t]);
  if (existing) {
    await db.run(
      'UPDATE opportunity_lead_drafts SET lead_type = ?, email = ?, step = ?, data = ?, updated_at = ? WHERE token = ?',
      [leadType, email, Math.min(Math.max(Number(step) || 1, 1), 13), JSON.stringify(safe), now, t]
    );
  } else {
    await db.run(
      `INSERT INTO opportunity_lead_drafts (token, lead_type, email, step, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [t, leadType, email, Math.min(Math.max(Number(step) || 1, 1), 13), JSON.stringify(safe), now, now]
    );
  }
  return { token: t, resumeUrl: `/grow/apply/resume/${t}` };
}

async function getDraft(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const row = await db.get('SELECT * FROM opportunity_lead_drafts WHERE token = ?', [token]);
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  return { token: row.token, leadType: row.lead_type, email: row.email, step: row.step, data };
}

async function deleteDraft(token) {
  await db.run('DELETE FROM opportunity_lead_drafts WHERE token = ?', [token]);
}

// --- Email queueing ------------------------------------------------------------------
function baseUrl() {
  return (config.getSite().baseUrl || 'http://localhost:3000').replace(/\/$/, '');
}
function opsEmail() {
  return process.env.TRANSITNOW_OPS_EMAIL || config.getSite().email;
}

async function queueEmail({ to, subject, html, sequence, step }) {
  if (!to) return null;
  const info = await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, ?, ?, ?, ?, NULL, ?, 'queued')`,
    [to, sequence, step, subject, html, Date.now()]
  );
  const queueId = Number(info.lastInsertRowid);
  // Send immediately through the configured provider. With the default
  // local provider this writes the message to data/outbox/ and marks the
  // row sent. On provider failure the row stays queued for a later
  // scheduler pass; delivery beyond the outbox is NOT claimed.
  try {
    await emailLib.sendEmail({ to, subject, html, queueId, fromName: 'TransitNow Logistics Services' });
  } catch (err) {
    console.error(`[grow] immediate email send failed (queueId ${queueId}), left queued:`,
      err && err.message ? err.message : err);
  }
  return queueId;
}

const NO_GUARANTEE_LINE =
  'Submitting this form does not guarantee employment, routes, loads, contracts, income, partnership, or acceptance into any TransitNow program.';

function applicantConfirmationEmail(lead, leadType) {
  const name = lead.first_name || 'there';
  return `<p>Hi ${escHtml(name)},</p>
<p><strong>We received your TransitNow information.</strong></p>
<p>Thank you for telling us about you. Our team will review the information you provided and determine whether there is a current or future opportunity that may fit your experience, vehicle, location, availability, business, or goals.</p>
<p><strong>What this means — plainly:</strong></p>
<ul>
<li>This is not an offer of employment, a route, loads, a contract, or income.</li>
<li>Submitting this form does not guarantee work, partnership, or acceptance into any TransitNow program.</li>
<li>If there is a relevant opportunity, TransitNow may contact you using the contact information you provided.</li>
</ul>
<p>Keep building. Keep learning. Keep moving.</p>
<p>— TransitNow Logistics Services</p>`;
}

function adminNotificationEmail(lead, profile, opts = {}) {
  const f = lead;
  const yes = (v) => (v ? 'Yes' : '—');
  const list = (j) => { try { const a = JSON.parse(j || '[]'); return a.length ? a.join(', ') : '—'; } catch { return '—'; } };
  const rsp = list(f.opportunity_interests).includes('rsp-opportunities') || (profile.tags || []).some((t) => t.tag === 'RSP') ? 'Yes' : 'No';
  const vehicle = f.vehicle_type && f.vehicle_type !== 'none'
    ? `${f.vehicle_year} ${f.vehicle_make} ${f.vehicle_model} (${f.vehicle_type})`
    : (f.vehicle_type === 'looking' ? 'Looking for a vehicle' : 'No vehicle currently');
  const link = `${baseUrl()}/admin/crm/leads/${f.id}`;
  return `<p><strong>New ${opts.funnelLabel || 'Grow'} application${opts.resubmission ? ' (resubmission — record updated)' : ''}</strong></p>
<ul>
<li><strong>Name:</strong> ${escHtml(f.first_name)} ${escHtml(f.last_name)}</li>
<li><strong>Location:</strong> ${escHtml(f.city)}, ${escHtml(f.state)} ${escHtml(f.zip)}</li>
<li><strong>Phone:</strong> ${escHtml(f.phone)} (prefers ${escHtml(f.preferred_contact) || '—'})</li>
<li><strong>Email:</strong> ${escHtml(f.email)}</li>
<li><strong>Current roles:</strong> ${escHtml(list(f.current_roles))}</li>
<li><strong>Experience:</strong> ${escHtml(f.experience_level) || '—'}</li>
<li><strong>Vehicle:</strong> ${escHtml(vehicle)}</li>
<li><strong>Availability:</strong> ${escHtml(list(f.avail_days))} ${escHtml(f.avail_start)}–${escHtml(f.avail_end)} ${escHtml(list(f.avail_type))}</li>
<li><strong>Service area:</strong> ${escHtml(list(f.service_area_type))} — ${escHtml(f.primary_city)}, ${escHtml(f.primary_state)}</li>
<li><strong>Interests:</strong> ${escHtml(list(f.opportunity_interests))}</li>
<li><strong>Owns/operates a business:</strong> ${escHtml(f.has_business)}${f.has_business === 'yes' && profile.business && profile.business.business_name ? ` — ${escHtml(profile.business.business_name)}` : ''}</li>
<li><strong>RSP interest:</strong> ${rsp}</li>
<li><strong>Source:</strong> ${escHtml(f.source) || '—'}${f.referral_name ? ` (referred by ${escHtml(f.referral_name)})` : ''}${f.referral_code ? ` [code: ${escHtml(f.referral_code)}]` : ''}</li>
<li><strong>Marketing consent:</strong> ${yes(f.marketing_consent)}</li>
</ul>
<p><a href="${escHtml(link)}">Open lead profile in the CRM</a></p>
<p style="color:#666;font-size:13px">Sign in to the admin panel with your admin token, then use the link above.</p>`;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Business / RSP / Dispatch info-request submissions reuse upsertLead with
// a small field subset. Fields maps to opportunity_leads columns.
function normalizeSimple(fields, leadType) {
  const b = fields || {};
  const base = {
    first_name: str(b.first_name || b.contact_name || '', 120),
    last_name: str(b.last_name || '', 120),
    email: str(b.email, 254).toLowerCase(),
    phone: str(b.phone, 40),
    preferred_contact: pick(b.preferred_contact, ['call', 'text', 'email']),
    city: str(b.city, 120),
    state: str(b.state, 60),
    zip: str(b.zip, 20),
    marketing_consent: ['yes', 'on', '1', 'true'].includes(String(b.marketing_consent).toLowerCase()) ? 1 : 0,
  };
  // Fields shared by the dispatch info request and any future simple funnel.
  if (!base.about_you && b.about_you) base.about_you = str(b.about_you, 5000);
  if (b.vehicle_type) base.vehicle_type = pick(b.vehicle_type, ['car', 'suv', 'minivan', 'cargo-van', 'sprinter-van', 'pickup-truck', 'box-truck', 'step-van', 'other', 'none', 'looking']);
  if (!base.source && b.source) base.source = pick(b.source, SOURCE_OPTIONS);
  if (leadType === 'BUSINESS') {
    base.about_you = [
      `Company: ${str(b.company_name, 160)}`,
      `Business type: ${str(b.business_type, 120)}`,
      `Service needed: ${str(b.service_needed, 500)}`,
      `Delivery volume: ${str(b.delivery_volume, 200)}`,
      `Frequency: ${str(b.frequency, 120)}`,
      `Territory: ${str(b.territory, 300)}`,
      `Vehicle requirements: ${str(b.vehicle_requirements, 500)}`,
      `Driver requirements: ${str(b.driver_requirements, 500)}`,
      `Desired start date: ${str(b.desired_start_date, 60)}`,
      `Current provider: ${str(b.current_provider, 200)}`,
    ].join('\n');
    base.why_interested = `Problem to solve: ${str(b.problem_to_solve, 5000)}`;
    base.something_else = str(b.additional_info, 5000);
    base.source = pick(b.source, SOURCE_OPTIONS);
    base.service_area_type = JSON.stringify([str(b.territory, 300)]);
    base.business_help = JSON.stringify(['contract-opportunities']);
  } else if (leadType === 'RSP') {
    base.about_you = [
      `Business name: ${str(b.business_name, 160)}`,
      `Years in business: ${str(b.years_in_business, 40)}`,
      `Drivers: ${str(b.num_drivers, 20)}`,
      `Vehicles: ${str(b.num_vehicles, 20)} — types: ${str(b.vehicle_types, 300)}`,
      `Insurance: ${str(b.insurance, 300)}`,
      `Delivery experience: ${str(b.delivery_experience, 2000)}`,
      `Service area: ${str(b.service_area, 300)}`,
      `Can hire/manage drivers: ${str(b.can_manage_drivers, 300)}`,
      `Technology experience: ${str(b.technology_experience, 2000)}`,
      `Capital/resources readiness: ${str(b.capital_readiness, 2000)}`,
      `Contracting experience: ${str(b.contracting_experience, 2000)}`,
      `Current business model: ${str(b.current_business_model, 2000)}`,
    ].join('\n');
    base.goals_12mo = str(b.future_goals, 5000);
    base.why_interested = str(b.why_interested, 5000);
    base.opportunity_interests = JSON.stringify(['rsp-opportunities']);
    base.source = pick(b.source, SOURCE_OPTIONS);
  }
  return base;
}

module.exports = {
  GROW_STATUSES,
  BUSINESS_STATUSES,
  LEAD_TYPES,
  INTERNAL_TAGS,
  pipelineFor,
  defaultStatusFor,
  EMAIL_RE,
  FORBIDDEN_FIELDS,
  ROLE_OPTIONS, EXP_OPTIONS, VEHICLE_OPTIONS, OWNERSHIP_OPTIONS, DAYS,
  AVAIL_TYPE_OPTIONS, AREA_TYPE_OPTIONS, BUSINESS_HELP_OPTIONS,
  GROWTH_INTEREST_OPTIONS, OPP_INTEREST_OPTIONS, READINESS_OPTIONS,
  FUTURE_ROLE_OPTIONS, SOURCE_OPTIONS,
  str, arr, pick, jsonArr,
  normalizeGrow, validateGrow, autoTagsFor,
  upsertLead, saveGrowRelated, addLeadTags, leadTags, getLeadProfile,
  changeLeadStatus, addLeadNote, setFollowUp,
  saveDraft, getDraft, deleteDraft,
  queueEmail, opsEmail, baseUrl,
  applicantConfirmationEmail, adminNotificationEmail, NO_GUARANTEE_LINE,
  normalizeSimple, escHtml,
};
