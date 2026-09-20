'use strict';
/**
 * lib/db.js — SQLite persistence layer.
 *
 * Two backends, chosen by environment:
 *   - Local (default): the built-in node:sqlite module, file at
 *     data/funnel.db (plus data/outbox/ for the local email outbox).
 *   - Turso: used when BOTH TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are
 *     set. Uses @libsql/client — the same client library works against a
 *     local file: URL and against a remote Turso database.
 *
 * The backend is lazy-loaded: only the active one is required, and the
 * @libsql/client dependency is only loaded in Turso mode.
 *
 * Exports (ALL return Promises — `await` them everywhere):
 *   run(sql, params) -> { changes, lastInsertRowid }
 *   get(sql, params) -> row | null
 *   all(sql, params) -> row[]
 *   recordEvent({ visitor_id, lead_id, type, product_id, meta })
 *   DATA_DIR, OUTBOX_DIR
 *
 * The schema is applied on both backends at boot. All timestamps are epoch
 * milliseconds.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
fs.mkdirSync(OUTBOX_DIR, { recursive: true });

const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const USE_TURSO = Boolean(TURSO_URL && TURSO_TOKEN);

// --- Schema ----------------------------------------------------------------
// One statement per string: @libsql/client's execute() takes exactly one
// statement at a time, so we run these sequentially on the Turso backend.
// (node:sqlite can run them all at once via db.exec, but a single sequential
// loop keeps both backends identical.)
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS visitors (
     id         TEXT PRIMARY KEY,
     first_seen INT,
     last_seen  INT,
     visits     INT,
     source     TEXT,
     campaign   TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS leads (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     visitor_id       TEXT,
     first_name       TEXT,
     email            TEXT UNIQUE,
     phone            TEXT,
     source           TEXT,
     campaign         TEXT,
     offer_of_interest TEXT,
     consent_marketing INT,
     consent_ts       INT,
     date_captured    INT,
     status           TEXT DEFAULT 'lead',
     unsubscribed     INT DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS page_views (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     visitor_id TEXT,
     lead_id    INT,
     path       TEXT,
     product_id TEXT,
     ts         INT
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     visitor_id TEXT,
     lead_id    INT,
     type       TEXT,
     product_id TEXT,
     meta       TEXT,
     ts         INT
   )`,
  `CREATE TABLE IF NOT EXISTS tags (
     lead_id INT,
     tag     TEXT,
     ts      INT,
     PRIMARY KEY (lead_id, tag)
   )`,
  `CREATE TABLE IF NOT EXISTS email_queue (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id      INT,
     email        TEXT,
     sequence     TEXT,
     step         TEXT,
     subject      TEXT,
     body_html    TEXT,
     product_id   TEXT,
     scheduled_for INT,
     sent_at      INT,
     status       TEXT DEFAULT 'queued',
     cancel_reason TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS purchases (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id      INT,
     product_id   TEXT,
     amount_cents INT,
     mode         TEXT,
     kind         TEXT DEFAULT 'initial',
     parent_id    INT,
     ts           INT
   )`,
  `CREATE TABLE IF NOT EXISTS carts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id    INT,
     visitor_id TEXT,
     product_id TEXT,
     started_at INT,
     purchased  INT DEFAULT 0,
     recovered  INT DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS suppressions (
     email  TEXT PRIMARY KEY,
     reason TEXT,
     ts     INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views (visitor_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_events_lead ON events (lead_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_queue_status_due ON email_queue (status, scheduled_for)`,
  `CREATE INDEX IF NOT EXISTS idx_purchases_lead ON purchases (lead_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_carts_lead ON carts (lead_id, purchased)`,
];

// --- Backend: local node:sqlite ----------------------------------------------
let localRun, localGet, localAll, localInit;
if (!USE_TURSO) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'funnel.db'));

  // Prepared-statement cache (hot paths like page-view logging).
  const stmtCache = new Map();
  function stmt(sql) {
    let s = stmtCache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmtCache.set(sql, s);
    }
    return s;
  }

  const normRun = (info) => ({
    changes: Number(info.changes || 0),
    lastInsertRowid: info.lastInsertRowid == null ? null : Number(info.lastInsertRowid),
  });

  localRun = (sql, params = []) => Promise.resolve(normRun(stmt(sql).run(...params)));
  localGet = (sql, params = []) => Promise.resolve(stmt(sql).get(...params) ?? null);
  localAll = (sql, params = []) => Promise.resolve(stmt(sql).all(...params));
  localInit = async () => {
    for (const s of SCHEMA_STATEMENTS) db.exec(s);
  };
}

// --- Backend: Turso via @libsql/client ---------------------------------------
let tursoRun, tursoGet, tursoAll, tursoInit;
if (USE_TURSO) {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  tursoRun = async (sql, params = []) => {
    const rs = await client.execute({ sql, args: params });
    return {
      changes: Number(rs.rowsAffected ?? 0),
      lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid),
    };
  };
  tursoGet = async (sql, params = []) => {
    const rs = await client.execute({ sql, args: params });
    return rs.rows.length ? rs.rows[0] : null;
  };
  tursoAll = async (sql, params = []) => {
    const rs = await client.execute({ sql, args: params });
    return rs.rows;
  };
  tursoInit = async () => {
    for (const s of SCHEMA_STATEMENTS) {
      // One statement per execute() — this is a @libsql/client requirement.
      await client.execute(s);
    }
  };
}

const active = USE_TURSO
  ? { run: tursoRun, get: tursoGet, all: tursoAll, init: tursoInit, name: 'turso' }
  : { run: localRun, get: localGet, all: localAll, init: localInit, name: 'node:sqlite' };

console.log(`[db] backend: ${active.name}${USE_TURSO ? ` (${TURSO_URL.replace(/:[^:@]*@/, ':***@')})` : ''}`);

// Schema is applied once at boot. Every exported call awaits this so no
// query can run before the tables exist (matters for the remote backend).
const ready = active.init().catch((err) => {
  console.error('[db] schema initialization failed:', err && err.message ? err.message : err);
  throw err;
});

async function run(sql, params = []) {
  await ready;
  return active.run(sql, params);
}

async function get(sql, params = []) {
  await ready;
  return active.get(sql, params);
}

async function all(sql, params = []) {
  await ready;
  return active.all(sql, params);
}

/** Append-only funnel event log. meta is stored as JSON. */
async function recordEvent({ visitor_id = null, lead_id = null, type, product_id = null, meta = null }) {
  return run(
    'INSERT INTO events (visitor_id, lead_id, type, product_id, meta, ts) VALUES (?, ?, ?, ?, ?, ?)',
    [visitor_id, lead_id, type, product_id, meta ? JSON.stringify(meta) : null, Date.now()]
  );
}

module.exports = { run, get, all, recordEvent, ready, DATA_DIR, OUTBOX_DIR };
