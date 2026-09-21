// lib/analytics.js — Phase 7: growth ecosystem analytics (spec section 26).
//
// Every metric is computed live from the real tables (visitors, page_views,
// opportunity_leads, opportunity_lead_drafts, lead_sources,
// referral_attributions, drivers, opportunity_matches). Nothing is estimated;
// "Started"/"Completed"/"Conversion rate" and every other derived metric is
// defined in plain language and the views/analytics.js footnotes state those
// definitions in the UI. No guarantee language anywhere: counts describe what
// happened, never what will happen.
'use strict';

const db = require('./db');
const grow = require('./grow');

const FUNNEL_PATHS = ['/grow', '/grow/apply', '/business', '/rsp', '/dispatch'];
const WINDOW_OPTIONS = ['7', '30', '90', 'all'];
const DEFAULT_WINDOW = '30';

// GROW pipeline statuses that indicate the applicant made it past initial
// review (set manually by the team). Used for "Qualified applicants".
// "Qualified" here = progressed in the CRM pipeline; it is NOT an automated
// judgment of fitness and does NOT promise work, routes, loads, or income.
const QUALIFIED_LEAD_STATUSES = [
  'QUALIFYING',
  'DRIVER READY',
  'BUSINESS OPPORTUNITY',
  'DISPATCH OPPORTUNITY',
  'PARTNERSHIP',
  'ACTIVE',
];

function parseWindow(raw) {
  const v = String(raw || '').trim();
  const days = WINDOW_OPTIONS.includes(v) ? v : DEFAULT_WINDOW;
  if (days === 'all') return { key: 'all', since: null, label: 'All time' };
  const n = Number.parseInt(days, 10);
  return { key: days, since: Date.now() - n * 24 * 3600 * 1000, label: `Last ${n} days` };
}

/** Add a created_at-style window predicate to a query on column `col`. */
function windowSql(window, col) {
  return window.since == null ? '' : ` AND ${col} >= ${Number(window.since)}`;
}

function pct(n, total) {
  if (!total || total <= 0) return null;
  return Math.round((n / total) * 1000) / 10;
}

function expandJsonArray(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.filter((x) => x !== '' && x != null).map(String) : [];
  } catch {
    return [];
  }
}

/** Count + percentage rows for a single text column (NULL/'' → "(not provided)"). */
async function breakdown(table, col, { window = null, windowCol = 'created_at', extraWhere = '', params = [] } = {}) {
  const w = window && window.since != null ? ` AND ${windowCol} >= ?` : '';
  const p = window && window.since != null ? [...params, window.since] : [...params];
  const rows = await db.all(
    `SELECT COALESCE(NULLIF(TRIM(${col}), ''), '(not provided)') AS label, COUNT(*) AS c
     FROM ${table}
     WHERE 1 = 1 ${extraWhere} ${w}
     GROUP BY label
     ORDER BY c DESC, label ASC`,
    p
  );
  const total = rows.reduce((s, r) => s + Number(r.c), 0);
  return rows.map((r) => ({ label: r.label, count: Number(r.c), pct: pct(Number(r.c), total) }));
}

/** Funnel page views + unique visitors per path, in the window. */
async function funnelPageStats(window) {
  const w = window.since != null ? ' AND ts >= ?' : '';
  const p = window.since != null ? [window.since] : [];
  const out = {};
  for (const path of FUNNEL_PATHS) {
    const r = await db.get(
      `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
       FROM page_views WHERE path = ?${w}`,
      [path, ...p]
    );
    out[path] = { views: Number(r.views), visitors: Number(r.visitors) };
  }
  return out;
}

/**
 * "Applications started" = unique anonymous visitors who opened /grow/apply
 * in the window. A "visitor" is an anonymous browser cookie (vid), not a
 * person — one person may use several browsers/devices.
 */
async function applicationsStarted(window) {
  const w = window.since != null ? ' AND ts >= ?' : '';
  const p = window.since != null ? [window.since] : [];
  const r = await db.get(
    `SELECT COUNT(DISTINCT visitor_id) AS c FROM page_views WHERE path = '/grow/apply'${w}`,
    p
  );
  return Number(r.c);
}

/** Drafts saved in the window (distinct draft tokens). */
async function draftsSaved(window) {
  const w = window.since != null ? ' AND created_at >= ?' : '';
  const p = window.since != null ? [window.since] : [];
  const r = await db.get(`SELECT COUNT(DISTINCT token) AS c FROM opportunity_lead_drafts WHERE 1 = 1${w}`, p);
  return Number(r.c);
}

/** Completed applications = NEW applicant records created in the window.
 * Resubmissions update the existing row (upsertLead dedups on email +
 * lead_type), so each row counts as one applicant, not one form hit. */
async function leadsByType(window) {
  const w = window.since != null ? ' AND created_at >= ?' : '';
  const p = window.since != null ? [window.since] : [];
  const rows = await db.all(
    `SELECT lead_type, COUNT(*) AS c FROM opportunity_leads WHERE 1 = 1${w} GROUP BY lead_type`,
    p
  );
  const out = { GROW: 0, BUSINESS: 0, RSP: 0 };
  for (const r of rows) {
    if (Object.prototype.hasOwnProperty.call(out, r.lead_type)) out[r.lead_type] = Number(r.c);
  }
  return out;
}

/** Source breakdown per lead type, from opportunity_leads.source. */
async function sourcesByType(window) {
  const out = {};
  for (const t of grow.LEAD_TYPES) {
    out[t] = await breakdown('opportunity_leads', 'source', {
      window, extraWhere: ' AND lead_type = ?', params: [t],
    });
  }
  return out;
}

/**
 * Referral-source breakdowns:
 *  - attributed: referral_attributions (Phase 6) — codes actually issued and
 *    matched to applicants.
 *  - typed: referral_code values applicants typed into lead_sources —
 *    includes codes that never matched an issued code.
 */
async function referralBreakdown(window) {
  const wA = window.since != null ? ' AND a.created_at >= ?' : '';
  const pA = window.since != null ? [window.since] : [];
  const attributed = await db.all(
    `SELECT a.code AS label,
            MAX(a.code) AS code,
            MAX(c.issued_to_name) AS issued_to,
            COUNT(*) AS c
     FROM referral_attributions a
     LEFT JOIN referral_codes c ON c.id = a.code_id
     WHERE 1 = 1${wA}
     GROUP BY a.code_id, a.code
     ORDER BY c DESC, label ASC`,
    pA
  );
  const attrTotal = attributed.reduce((s, r) => s + Number(r.c), 0);
  const wS = window.since != null ? ' AND s.created_at >= ?' : '';
  const pS = window.since != null ? [window.since] : [];
  const typed = await db.all(
    `SELECT UPPER(TRIM(s.referral_code)) AS label, COUNT(DISTINCT s.lead_id) AS c
     FROM lead_sources s
     WHERE s.referral_code IS NOT NULL AND TRIM(s.referral_code) <> ''${wS}
     GROUP BY label
     ORDER BY c DESC, label ASC`,
    pS
  );
  const typedTotal = typed.reduce((s, r) => s + Number(r.c), 0);
  return {
    attributed: attributed.map((r) => ({
      code: r.code, issuedTo: r.issued_to || '(unknown)', count: Number(r.c), pct: pct(Number(r.c), attrTotal),
    })),
    typed: typed.map((r) => ({ code: r.label, count: Number(r.c), pct: pct(Number(r.c), typedTotal) })),
  };
}

/** Applicant-profile breakdowns (GROW applicants in the window). */
async function applicantProfile(window) {
  const w = window.since != null ? ' AND created_at >= ?' : '';
  const p = window.since != null ? [window.since] : [];
  const [byFutureRole, byVehicleType, byState, byExperience] = await Promise.all([
    breakdown('opportunity_leads', 'future_role', { window, extraWhere: " AND lead_type = 'GROW'", params: [] }),
    breakdown('opportunity_leads', 'vehicle_type', { window, extraWhere: " AND lead_type = 'GROW'", params: [] }),
    breakdown('opportunity_leads', 'state', { window, extraWhere: " AND lead_type = 'GROW'", params: [] }),
    breakdown('opportunity_leads', 'experience_level', { window, extraWhere: " AND lead_type = 'GROW'", params: [] }),
  ]);
  // Opportunity interests: JSON arrays on the lead rows.
  const interestRows = await db.all(
    `SELECT opportunity_interests FROM opportunity_leads WHERE lead_type = 'GROW'${w}`,
    p
  );
  const interestCounts = new Map();
  for (const r of interestRows) {
    for (const i of expandJsonArray(r.opportunity_interests)) {
      interestCounts.set(i, (interestCounts.get(i) || 0) + 1);
    }
  }
  const totalApplicants = interestRows.length;
  const opportunityInterests = [...interestCounts.entries()]
    .map(([label, count]) => ({ label, count, pct: pct(count, totalApplicants) }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
  const stateCount = await db.get(
    `SELECT COUNT(DISTINCT UPPER(TRIM(state))) AS c FROM opportunity_leads
     WHERE lead_type = 'GROW' AND state IS NOT NULL AND TRIM(state) <> ''${w}`,
    p
  );
  return {
    byFutureRole, byVehicleType, byState, byExperience, opportunityInterests,
    distinctStates: Number(stateCount.c),
  };
}

/** Current-state pipeline metrics (not windowed — they describe "now"). */
async function pipelineNow() {
  const placeholders = QUALIFIED_LEAD_STATUSES.map(() => '?').join(', ');
  const qualified = await db.get(
    `SELECT COUNT(*) AS c FROM opportunity_leads
     WHERE lead_type = 'GROW' AND status IN (${placeholders})`,
    QUALIFIED_LEAD_STATUSES
  );
  const approvals = await db.get(
    `SELECT COUNT(*) AS c FROM drivers WHERE extended_status = 'APPROVED'`
  );
  const activeDrivers = await db.get(
    `SELECT COUNT(*) AS c FROM drivers WHERE status = 'active'`
  );
  const activeBusinesses = await db.get(
    `SELECT COUNT(*) AS c FROM opportunity_leads WHERE lead_type = 'BUSINESS' AND status = 'ACTIVE'`
  );
  const matches = await db.get('SELECT COUNT(*) AS c FROM opportunity_matches');
  const businessByStatus = await breakdown('opportunity_leads', 'status', {
    extraWhere: " AND lead_type = 'BUSINESS'", params: [],
  });
  const rspCount = await db.get(
    `SELECT COUNT(*) AS c FROM opportunity_leads WHERE lead_type = 'RSP'`
  );
  return {
    qualifiedApplicants: Number(qualified.c),
    qualifiedStatuses: QUALIFIED_LEAD_STATUSES,
    driverApprovals: Number(approvals.c),
    activeDrivers: Number(activeDrivers.c),
    activeBusinesses: Number(activeBusinesses.c),
    opportunityMatches: Number(matches.c),
    businessByStatus,
    rspInterestTotal: Number(rspCount.c),
  };
}

/** Opportunity matches recorded in the window. */
async function matchesInWindow(window) {
  const w = window.since != null ? ' AND ts >= ?' : '';
  const p = window.since != null ? [window.since] : [];
  const r = await db.get(`SELECT COUNT(*) AS c FROM opportunity_matches WHERE 1 = 1${w}`, p);
  return Number(r.c);
}

async function getAnalytics({ days = DEFAULT_WINDOW } = {}) {
  const window = parseWindow(days);
  const [
    funnelPages, started, drafts, byType, sources, referrals, profile, pipeline, matchesWindow,
  ] = await Promise.all([
    funnelPageStats(window),
    applicationsStarted(window),
    draftsSaved(window),
    leadsByType(window),
    sourcesByType(window),
    referralBreakdown(window),
    applicantProfile(window),
    pipelineNow(),
    matchesInWindow(window),
  ]);
  const completed = byType.GROW;
  return {
    window,
    windowOptions: WINDOW_OPTIONS,
    funnel: {
      pages: funnelPages,
      started,
      draftsSaved: drafts,
      completed,
      businessLeads: byType.BUSINESS,
      rspInterest: byType.RSP,
      byType,
      conversionPct: pct(completed, started),
    },
    sources,
    referrals,
    applicant: profile,
    pipeline: { ...pipeline, matchesInWindow: matchesWindow },
  };
}

module.exports = {
  WINDOW_OPTIONS,
  DEFAULT_WINDOW,
  QUALIFIED_LEAD_STATUSES,
  parseWindow,
  getAnalytics,
};
