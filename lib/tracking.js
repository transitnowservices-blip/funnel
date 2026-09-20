'use strict';
/**
 * lib/tracking.js — visitor tracking middleware.
 *
 * - Assigns an anonymous `vid` cookie (uuid) on first touch.
 * - Upserts the visitors row (visits++, last_seen; source/campaign captured
 *   from ?src= / ?cmp= only on first touch).
 * - Logs a page_views row for every rendered page (GET, non-admin,
 *   non-webhook, non-asset) with product context from ?p= (or the default
 *   product) and lead_id from the `lid` cookie when present.
 *
 * IMPORTANT: anonymous visitors are NEVER identified by email. The `lid`
 * cookie is only set after a form submit (POST /lead, POST /checkout), at
 * which point that visitor's views/events are merged onto the lead.
 */
const crypto = require('crypto');
const cookie = require('cookie');
const db = require('./db');
const config = require('./config');

const VID_MAX_AGE = 365 * 24 * 3600; // 1 year
const COOKIE_OPTS = { httpOnly: true, path: '/', sameSite: 'Lax', maxAge: VID_MAX_AGE };

// Paths that must never create page_views or inflate visitor counts.
const SKIP_PREFIXES = ['/admin', '/webhooks', '/healthz'];

function getCookies(req) {
  try {
    return cookie.parse(req.headers.cookie || '');
  } catch {
    return {};
  }
}

/** Append a Set-Cookie header without clobbering cookies set earlier. */
function setCookie(res, name, value, opts = {}) {
  const serialized = cookie.serialize(name, value, { ...COOKIE_OPTS, ...opts });
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', serialized);
  } else if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', [...prev, serialized]);
  } else {
    res.setHeader('Set-Cookie', [prev, serialized]);
  }
}

function shouldLogPageView(req) {
  if (req.method !== 'GET') return false;
  const p = req.path;
  if (p === '/favicon.ico') return false;
  return !SKIP_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}

async function upsertVisitor(vid, isNew, req) {
  const now = Date.now();
  if (!isNew) {
    const info = await db.run('UPDATE visitors SET visits = visits + 1, last_seen = ? WHERE id = ?', [now, vid]);
    if (info.changes > 0) return;
    // Cookie survived but the row is gone (e.g. DB reset) — treat as new.
    isNew = true;
  }
  if (isNew) {
    await db.run(
      'INSERT OR IGNORE INTO visitors (id, first_seen, last_seen, visits, source, campaign) VALUES (?, ?, ?, 1, ?, ?)',
      [vid, now, now, req.query.src || null, req.query.cmp || null]
    );
  }
}

async function middleware(req, res, next) {
  const cookies = getCookies(req);
  req.cookies = cookies;

  let vid = cookies.vid;
  let isNew = false;
  if (!vid || typeof vid !== 'string' || vid.length > 64) {
    vid = crypto.randomUUID();
    isNew = true;
    setCookie(res, 'vid', vid);
  }
  req.vid = vid;

  const lid = parseInt(cookies.lid, 10);
  req.leadId = Number.isInteger(lid) && lid > 0 ? lid : null;

  await upsertVisitor(vid, isNew, req);

  if (shouldLogPageView(req)) {
    const product = config.getProduct(req.query.p);
    await db.run('INSERT INTO page_views (visitor_id, lead_id, path, product_id, ts) VALUES (?, ?, ?, ?, ?)', [
      vid,
      req.leadId,
      req.path,
      product.id,
      Date.now(),
    ]);
  }

  next();
}

module.exports = { middleware, getCookies, setCookie };
