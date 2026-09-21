'use strict';
/**
 * lib/dispatch_board.js — the dispatcher's daily board ("Today's routes").
 *
 * One screen per calendar date (default: today in America/Chicago). Every
 * number is computed live from the real tables — routes, drivers, packages,
 * package_exceptions — reusing lib/command.js's query conventions
 * (DONE_PACKAGE_STATUSES for "remaining"). No new tables.
 *
 * scheduled_date on routes is stored as 'YYYY-MM-DD'.
 */
const db = require('./db');
const command = require('./command');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHICAGO_TZ = 'America/Chicago';

/** Today as YYYY-MM-DD in the Chicago timezone (dispatcher local time). */
function chicagoToday(whenMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CHICAGO_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(whenMs));
}

/** Shift a YYYY-MM-DD date by n days (pure calendar math, no TZ surprises). */
function shiftDate(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function stopsCount(route) {
  try {
    const arr = JSON.parse(route.stops || '[]');
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

const donePlaceholders = () => command.DONE_PACKAGE_STATUSES.map(() => '?').join(', ');

/**
 * Full board for one date: per-route rows + summary strip numbers.
 * Row: route_code, title, driver name, driver phone, status, stops count,
 * packages delivered vs remaining, open exceptions, route detail URL.
 */
async function boardForDate(dateStr) {
  const date = DATE_RE.test(String(dateStr || '')) ? String(dateStr) : chicagoToday();
  const routes = await db.all(
    `SELECT r.*, d.full_name AS driver_name, d.phone AS driver_phone
       FROM routes r
       LEFT JOIN drivers d ON d.id = r.driver_id
      WHERE r.scheduled_date = ?
      ORDER BY r.id ASC`,
    [date]
  );

  const rows = [];
  let active = 0, completed = 0, pkgDelivered = 0, openExceptions = 0;
  for (const r of routes) {
    const status = String(r.status || 'planned');
    if (status === 'active') active += 1;
    if (status === 'completed') completed += 1;

    const pkgCounts = await db.all(
      'SELECT status, COUNT(*) c FROM packages WHERE route_id = ? GROUP BY status', [r.id]);
    let delivered = 0, done = 0, total = 0;
    for (const pc of pkgCounts) {
      const c = Number(pc.c);
      total += c;
      if (pc.status === 'delivered') delivered += c;
      if (command.DONE_PACKAGE_STATUSES.includes(pc.status)) done += c;
    }
    const remaining = total - done;
    pkgDelivered += delivered;

    const exRow = await db.get(
      `SELECT COUNT(*) c FROM package_exceptions WHERE route_id = ? AND status = 'open'`, [r.id]);
    const exOpen = Number(exRow.c);
    openExceptions += exOpen;

    rows.push({
      id: r.id,
      route_code: r.route_code,
      title: r.title,
      status,
      scheduled_date: r.scheduled_date,
      driver_id: r.driver_id,
      driver_name: r.driver_name || null,
      driver_phone: r.driver_phone || null,
      stops_count: stopsCount(r),
      pkg_total: total,
      pkg_delivered: delivered,
      pkg_remaining: remaining,
      open_exceptions: exOpen,
      route_url: `/dispatch/routes/${r.id}`,
    });
  }

  return {
    date,
    prev: shiftDate(date, -1),
    next: shiftDate(date, 1),
    isToday: date === chicagoToday(),
    summary: {
      routes: routes.length,
      active,
      completed,
      packages_delivered: pkgDelivered,
      open_exceptions: openExceptions,
    },
    routes: rows,
  };
}

/** tel:/sms: hrefs from a stored driver phone. Digits-only, +1 for 10-digit US. */
function phoneHref(phone, scheme) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return `${scheme}:${e164}`;
}

module.exports = {
  DATE_RE,
  CHICAGO_TZ,
  chicagoToday,
  shiftDate,
  boardForDate,
  phoneHref,
};
