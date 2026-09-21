'use strict';
/**
 * lib/command.js — Phase 3: operations command center (spec section 21).
 *
 * TODAY metrics computed from LIVE tables:
 *   routes, drivers, packages (A–L), package_exceptions (H), support_tickets
 *   (I), opportunity_leads (Phase 1), opportunities (Phase 2), live_sessions
 *   (Phase 5 — counts sessions genuinely in LIVE status, honestly labeled).
 *
 * Filters: territory, date, contract, driver, route, status. Each filter is
 * applied only where the underlying table has the column to support it; the
 * UI says which metrics are point-in-time (current state) vs date-windowed.
 *
 * Honest labeling: nothing is estimated or faked. If a filter can't apply to
 * a metric, the metric is computed unfiltered and the view says so.
 *
 * All timestamps are epoch milliseconds.
 */
const db = require('./db');

const IN_TRANSIT_STATUSES = ['picked_up', 'in_transit', 'at_stop', 'out_for_delivery'];
const DONE_PACKAGE_STATUSES = ['delivered', 'returned', 'lost_investigation'];
const OPEN_TICKET_STATUSES = ['open', 'in_progress'];

const VIDEO_SESSIONS_NOTE =
  'Phase 5 delivered the session request/accept/record workflow. This count reads ' +
  'the live_sessions table directly — never estimated or faked. Video media requires ' +
  'a connected video provider; until provider credentials are configured, sessions ' +
  'are labeled SIMULATED TEST and no real-time media runs.';

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function windowLabel(from, to) {
  const f = new Date(from).toLocaleDateString();
  const t = new Date(to).toLocaleDateString();
  return f === t ? f : `${f} → ${t}`;
}

// Normalize the six spec filters + the date window.
async function parseFilters(raw = {}) {
  const q = raw || {};
  let from = startOfDay(Date.now());
  let to = Date.now();
  let windowGiven = false;
  const dateParam = String(q.date || '').trim();
  const fromParam = String(q.from || '').trim();
  const toParam = String(q.to || '').trim();
  if (fromParam && DATE_RE.test(fromParam) && toParam && DATE_RE.test(toParam)) {
    from = startOfDay(new Date(fromParam + 'T12:00:00'));
    to = endOfDay(new Date(toParam + 'T12:00:00'));
    windowGiven = true;
  } else if (dateParam && DATE_RE.test(dateParam)) {
    from = startOfDay(new Date(dateParam + 'T12:00:00'));
    to = endOfDay(new Date(dateParam + 'T12:00:00'));
    windowGiven = true;
  }

  const territoryName = String(q.territory || '').trim();
  const territory = territoryName ? await db.get('SELECT * FROM territories WHERE name = ?', [territoryName]) : null;
  const contractNumber = String(q.contract || '').trim().toUpperCase();
  const contract = contractNumber ? await db.get('SELECT * FROM contracts WHERE contract_number = ?', [contractNumber]) : null;
  const driverId = Number.parseInt(String(q.driver || ''), 10);
  const driver = Number.isFinite(driverId) && driverId > 0
    ? await db.get('SELECT id, full_name, home_city, home_state FROM drivers WHERE id = ?', [driverId]) : null;
  const routeId = Number.parseInt(String(q.route || ''), 10);
  const route = Number.isFinite(routeId) && routeId > 0
    ? await db.get('SELECT id, route_code, title FROM routes WHERE id = ?', [routeId]) : null;
  const status = String(q.status || '').trim().toLowerCase();

  return {
    from, to, windowGiven, windowLabel: windowLabel(from, to),
    territoryName: territoryName || '', territory,
    contractNumber: contractNumber || '', contract,
    driverId: driver ? driver.id : 0, driver,
    routeId: route ? route.id : 0, route,
    status,
  };
}

const DRIVER_STATUSES = ['new', 'reviewing', 'contacted', 'documents_needed', 'ready', 'placement', 'active', 'inactive'];
const ROUTE_STATUSES = ['planned', 'active', 'completed', 'cancelled'];
const PACKAGE_STATUSES = ['created', 'ready_for_pickup', 'picked_up', 'in_transit', 'at_stop', 'out_for_delivery', 'delivered', 'exception', 'returned', 'lost_investigation'];
const EXCEPTION_STATUSES = ['open', 'resolved'];
const TICKET_STATUSES = ['open', 'in_progress', 'waiting_driver', 'resolved', 'closed'];
const OPPORTUNITY_STATUSES = ['DRAFT', 'OPEN', 'QUALIFYING', 'FILLED', 'PAUSED', 'CLOSED'];

// Shared sub-filters ------------------------------------------------------------
// Territory applies via city/state on driver + package rows, via territory
// name on contract/opportunity rows, and via either path on routes.
function territoryDriversSub(f) {
  // { clause, params } usable as: driver_id IN (SELECT id FROM drivers WHERE <clause>)
  if (!f.territory) return null;
  const city = (f.territory.city || '').trim();
  const state = (f.territory.state || '').trim();
  if (!city && !state) return null;
  return { clause: '(home_city = ? OR home_state = ?)', params: [city, state] };
}

function addClauses(conds, params, f, alias, table) {
  const terr = territoryDriversSub(f);
  const likeTerritoryName = f.territoryName; // for contract/opportunity .territory columns
  switch (table) {
    case 'drivers': {
      if (f.driverId) { conds.push(`${alias}.id = ?`); params.push(f.driverId); }
      if (terr) { conds.push(`${alias}.id IN (SELECT id FROM drivers WHERE ${terr.clause})`); params.push(...terr.params); }
      if (f.contractNumber) { conds.push(`${alias}.id IN (SELECT driver_id FROM routes WHERE contract_number = ?)`); params.push(f.contractNumber); }
      break;
    }
    case 'routes': {
      if (f.routeId) { conds.push(`${alias}.id = ?`); params.push(f.routeId); }
      if (f.driverId) { conds.push(`${alias}.driver_id = ?`); params.push(f.driverId); }
      if (f.contractNumber) { conds.push(`${alias}.contract_number = ?`); params.push(f.contractNumber); }
      if (terr) {
        conds.push(`(${alias}.driver_id IN (SELECT id FROM drivers WHERE ${terr.clause}) OR ${alias}.contract_number IN (SELECT contract_number FROM contracts WHERE territory = ?))`);
        params.push(...terr.params, likeTerritoryName);
      }
      break;
    }
    case 'packages': {
      if (f.routeId) { conds.push(`${alias}.route_id = ?`); params.push(f.routeId); }
      if (f.driverId) { conds.push(`${alias}.driver_id = ?`); params.push(f.driverId); }
      if (f.contractNumber) { conds.push(`${alias}.route_id IN (SELECT id FROM routes WHERE contract_number = ?)`); params.push(f.contractNumber); }
      if (f.territory) {
        const city = (f.territory.city || '').trim();
        const state = (f.territory.state || '').trim();
        if (city || state) { conds.push(`(${alias}.city = ? OR ${alias}.state = ?)`); params.push(city, state); }
      }
      break;
    }
    case 'exceptions': {
      if (f.routeId) { conds.push(`${alias}.route_id = ?`); params.push(f.routeId); }
      if (f.driverId) { conds.push(`${alias}.driver_id = ?`); params.push(f.driverId); }
      if (f.contractNumber) { conds.push(`${alias}.route_id IN (SELECT id FROM routes WHERE contract_number = ?)`); params.push(f.contractNumber); }
      if (terr) { conds.push(`${alias}.driver_id IN (SELECT id FROM drivers WHERE ${terr.clause})`); params.push(...terr.params); }
      break;
    }
    case 'tickets': {
      if (f.driverId) { conds.push(`${alias}.driver_id = ?`); params.push(f.driverId); }
      if (terr) { conds.push(`${alias}.driver_id IN (SELECT id FROM drivers WHERE ${terr.clause})`); params.push(...terr.params); }
      // Tickets have no contract column — the contract filter is noted as
      // not applicable in the view rather than silently applied.
      break;
    }
    case 'opportunities': {
      if (f.contractNumber) {
        conds.push(`(${alias}.client_contract LIKE ? OR ${alias}.id = ?)`);
        params.push(`%${f.contractNumber}%`, f.contract && f.contract.opportunity_id ? f.contract.opportunity_id : -1);
      }
      if (f.territory) {
        const city = (f.territory.city || '').trim();
        const state = (f.territory.state || '').trim();
        if (city || state) {
          conds.push(`(${alias}.territory = ? OR ${alias}.location LIKE ? OR ${alias}.location LIKE ?)`);
          params.push(likeTerritoryName, `%${city}%`, `%${state}%`);
        } else {
          conds.push(`${alias}.territory = ?`); params.push(likeTerritoryName);
        }
      }
      break;
    }
    case 'leads': {
      if (f.territory) {
        const city = (f.territory.city || '').trim();
        const state = (f.territory.state || '').trim();
        if (city || state) { conds.push(`(${alias}.city = ? OR ${alias}.state = ?)`); params.push(city, state); }
      }
      break;
    }
  }
}

async function countWhere(table, alias, statusClause, statusParams, f) {
  const conds = [...statusClause];
  const params = [...statusParams];
  addClauses(conds, params, f, alias, table);
  const row = await db.get(
    `SELECT COUNT(*) c FROM ${table} ${alias}${conds.length ? ' WHERE ' + conds.join(' AND ') : ''}`,
    params
  );
  return Number(row.c);
}

// --- Main metric computation ----------------------------------------------------
async function getCommandMetrics(raw = {}) {
  const f = await parseFilters(raw);

  const driverStatus = DRIVER_STATUSES.includes(f.status) ? f.status : 'active';
  const routeStatus = ROUTE_STATUSES.includes(f.status) ? f.status : 'active';
  const exceptionStatus = EXCEPTION_STATUSES.includes(f.status) ? f.status : 'open';
  const ticketStatus = TICKET_STATUSES.includes(f.status) ? f.status : null; // null = open-ish set
  const oppStatus = OPPORTUNITY_STATUSES.includes(f.status.toUpperCase()) ? f.status.toUpperCase() : 'OPEN';

  const pkgInTransit = PACKAGE_STATUSES.includes(f.status)
    ? { clause: ['p.status = ?'], params: [f.status] }
    : { clause: [`p.status IN (${IN_TRANSIT_STATUSES.map(() => '?').join(', ')})`], params: IN_TRANSIT_STATUSES };
  const pkgRemaining = { clause: [`p.status NOT IN (${DONE_PACKAGE_STATUSES.map(() => '?').join(', ')})`], params: DONE_PACKAGE_STATUSES };

  const [
    activeRoutes, driversActive,
    packagesInTransit, packagesDelivered, packagesRemaining,
    openExceptions, urgentSupport, liveVideo,
    newApplicants, newBusiness, rspLeads, openOpportunities,
  ] = await Promise.all([
    countWhere('routes', 'r', ['r.status = ?'], [routeStatus], f),
    countWhere('drivers', 'd', ['d.status = ?'], [driverStatus], f),
    countWhere('packages', 'p', pkgInTransit.clause, pkgInTransit.params, f),
    // "Delivered" is date-windowed (uses updated_at); honest label in the view.
    countWhere('packages', 'p', ['p.status = ?', 'p.updated_at >= ?', 'p.updated_at <= ?'], ['delivered', f.from, f.to], f),
    countWhere('packages', 'p', pkgRemaining.clause, pkgRemaining.params, f),
    countWhere('package_exceptions', 'e', ['e.status = ?'], [exceptionStatus], f),
    ticketStatus
      ? countWhere('support_tickets', 't', ['t.status = ?'], [ticketStatus], f)
      : countWhere('support_tickets', 't',
          [`t.priority = 'urgent'`, `t.status IN (${OPEN_TICKET_STATUSES.map(() => '?').join(', ')})`], OPEN_TICKET_STATUSES, f),
    // Phase 5: counts sessions genuinely in LIVE status from the real table.
    db.get(`SELECT COUNT(*) c FROM live_sessions WHERE status = 'LIVE'`).then((r) => Number(r.c)),
    // New leads are date-windowed (created in the window).
    countWhere('opportunity_leads', 'l', ['l.lead_type = ?', 'l.created_at >= ?', 'l.created_at <= ?'], ['GROW', f.from, f.to], f),
    countWhere('opportunity_leads', 'l', ['l.lead_type = ?', 'l.created_at >= ?', 'l.created_at <= ?'], ['BUSINESS', f.from, f.to], f),
    countWhere('opportunity_leads', 'l', ['l.lead_type = ?', 'l.created_at >= ?', 'l.created_at <= ?'], ['RSP', f.from, f.to], f),
    countWhere('opportunities', 'o', ['o.status = ?'], [oppStatus], f),
  ]);

  const cards = [
    { key: 'active_routes', label: 'Active routes', value: activeRoutes, href: '/admin/routes', kind: 'state' },
    { key: 'drivers_active', label: 'Drivers active', value: driversActive, href: '/admin/drivers?status=active', kind: 'state' },
    { key: 'packages_in_transit', label: 'Packages in transit', value: packagesInTransit, href: '/admin/routes', kind: 'state' },
    { key: 'packages_delivered', label: 'Packages delivered', value: packagesDelivered, href: '/admin/reports', kind: 'window' },
    { key: 'packages_remaining', label: 'Packages remaining', value: packagesRemaining, href: '/admin/routes', kind: 'state' },
    { key: 'open_exceptions', label: 'Open exceptions', value: openExceptions, href: '/admin/exceptions?status=open', kind: 'state' },
    { key: 'urgent_support', label: 'Urgent support', value: urgentSupport, href: '/admin/tickets', kind: 'state' },
    { key: 'live_video', label: 'Live video sessions', value: liveVideo, href: null, kind: 'state', note: VIDEO_SESSIONS_NOTE },
    { key: 'new_applicants', label: 'New applicants', value: newApplicants, href: '/admin/crm?type=GROW', kind: 'window' },
    { key: 'new_business', label: 'New business leads', value: newBusiness, href: '/admin/crm?type=BUSINESS', kind: 'window' },
    { key: 'rsp_leads', label: 'RSP leads', value: rspLeads, href: '/admin/crm?type=RSP', kind: 'window' },
    { key: 'open_opportunities', label: 'Open opportunities', value: openOpportunities, href: '/admin/opportunities?status=OPEN', kind: 'state' },
  ];

  return { filters: f, cards };
}

// Filter-form options: real rows, never hard-coded lists.
async function listFilterOptions() {
  const [territories, drivers, routes, contracts] = await Promise.all([
    db.all('SELECT id, name, city, state FROM territories ORDER BY name'),
    db.all('SELECT id, full_name FROM drivers ORDER BY full_name LIMIT 500'),
    db.all('SELECT id, route_code, title FROM routes ORDER BY id DESC LIMIT 200'),
    db.all('SELECT id, contract_number, contract_name FROM contracts ORDER BY updated_at DESC LIMIT 200'),
  ]);
  return { territories, drivers, routes, contracts };
}

module.exports = {
  IN_TRANSIT_STATUSES,
  DONE_PACKAGE_STATUSES,
  VIDEO_SESSIONS_NOTE,
  parseFilters,
  getCommandMetrics,
  listFilterOptions,
};
