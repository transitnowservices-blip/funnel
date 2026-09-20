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
  // --- The Wealth Builder's Room (membership community) ---------------------
  `CREATE TABLE IF NOT EXISTS room_members (
     email         TEXT PRIMARY KEY,
     name          TEXT,
     password_hash TEXT,
     joined_at     INT,
     status        TEXT DEFAULT 'active',
     last_login    INT
   )`,
  `CREATE TABLE IF NOT EXISTS room_sessions (
     token      TEXT PRIMARY KEY,
     email      TEXT,
     created_at INT,
     expires_at INT
   )`,
  `CREATE TABLE IF NOT EXISTS room_progress (
     email   TEXT,
     week    INT,
     item    INT,
     checked INT,
     ts      INT,
     PRIMARY KEY (email, week, item)
   )`,
  `CREATE TABLE IF NOT EXISTS room_posts (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     author_email TEXT,
     author_name  TEXT,
     kind         TEXT DEFAULT 'post',
     title        TEXT,
     body         TEXT,
     pinned       INT DEFAULT 0,
     created_at   INT
   )`,
  `CREATE TABLE IF NOT EXISTS room_comments (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id      INT,
     author_email TEXT,
     author_name  TEXT,
     body         TEXT,
     created_at   INT
   )`,
  // --- Room accountability: 90-day goals, weekly proof check-ins, reviews --
  `CREATE TABLE IF NOT EXISTS room_goals (
     email      TEXT PRIMARY KEY,
     goal_text  TEXT,
     start_date INT,
     target_date INT,
     created_at INT,
     updated_at INT
   )`,
  `CREATE TABLE IF NOT EXISTS room_checkins (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     email           TEXT,
     week            INT,
     created_at      INT,
     goal            TEXT,
     action_taken    TEXT,
     accomplishment  TEXT,
     lesson          TEXT,
     next_commitment TEXT,
     proof_blob      BLOB,
     proof_name      TEXT,
     proof_mime      TEXT,
     proof_size      INT,
     UNIQUE (email, week)
   )`,
  `CREATE TABLE IF NOT EXISTS room_reviews (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     email         TEXT UNIQUE,
     created_at    INT,
     original_goal TEXT,
     accomplished  TEXT,
     actions_taken TEXT,
     learned       TEXT,
     changed       TEXT,
     didnt_work    TEXT,
     do_differently TEXT,
     next_goal     TEXT
   )`,
  // --- TransitNow Driver Operations Platform (additive; existing tables untouched)
  `CREATE TABLE IF NOT EXISTS counters (
     name TEXT PRIMARY KEY,
     next INT DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS drivers (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     full_name          TEXT NOT NULL,
     email              TEXT NOT NULL UNIQUE,
     phone              TEXT,
     contact_method     TEXT,
     business_name      TEXT,
     entity_type        TEXT,
     mc_number          TEXT,
     dot_number         TEXT,
     years_in_business  TEXT,
     vehicle_type       TEXT,
     vehicle_year       TEXT,
     vehicle_make_model TEXT,
     cargo_dimensions   TEXT,
     payload_capacity   TEXT,
     equipment          TEXT,
     insurance_status   TEXT,
     home_city          TEXT,
     home_state         TEXT,
     service_radius     TEXT,
     travel_regions     TEXT,
     days_available     TEXT,
     hours_available    TEXT,
     start_date         TEXT,
     availability_status TEXT,
     work_prefs         TEXT,
     lane_prefs         TEXT,
     looking_for        TEXT,
     source             TEXT DEFAULT 'direct',
     status             TEXT DEFAULT 'new',
     plan_id            TEXT,
     access_token       TEXT UNIQUE,
     notes              TEXT,
     submitted_at       INT,
     updated_at         INT,
     last_contact       INT
   )`,
  `CREATE TABLE IF NOT EXISTS driver_status_history (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     driver_id  INT,
     from_status TEXT,
     to_status  TEXT,
     changed_by TEXT,
     note       TEXT,
     ts         INT
   )`,
  // Phase D: routes + uniquely identified package records.
  `CREATE TABLE IF NOT EXISTS routes (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     route_code     TEXT UNIQUE,
     driver_id      INT,
     title          TEXT,
     status         TEXT DEFAULT 'planned',
     scheduled_date TEXT,
     stops          TEXT,
     notes          TEXT,
     created_at     INT,
     updated_at     INT
   )`,
  `CREATE TABLE IF NOT EXISTS packages (
     package_id           TEXT PRIMARY KEY,
     route_id             INT,
     driver_id            INT,
     recipient_name       TEXT,
     address              TEXT,
     city                 TEXT,
     state                TEXT,
     zip                  TEXT,
     status               TEXT DEFAULT 'created',
     special_instructions TEXT,
     created_at           INT,
     updated_at           INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_routes_driver ON routes (driver_id)`,
  `CREATE INDEX IF NOT EXISTS idx_routes_status ON routes (status)`,
  `CREATE INDEX IF NOT EXISTS idx_packages_route ON packages (route_id)`,
  `CREATE INDEX IF NOT EXISTS idx_packages_driver ON packages (driver_id)`,
  `CREATE INDEX IF NOT EXISTS idx_packages_status ON packages (status)`,
  // Phase F: append-only custody + handoff history.
  `CREATE TABLE IF NOT EXISTS custody_events (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     package_id  TEXT,
     route_id    INT,
     driver_id   INT,
     event_type  TEXT,
     note        TEXT,
     meta        TEXT,
     created_by  TEXT DEFAULT 'driver',
     ts          INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_custody_package ON custody_events (package_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_custody_driver ON custody_events (driver_id)`,
  // Phase H: delivery exceptions with optional photo/proof, admin flagging.
  `CREATE TABLE IF NOT EXISTS package_exceptions (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     package_id      TEXT,
     route_id        INT,
     driver_id       INT,
     exception_type  TEXT,
     description     TEXT,
     photo_blob      BLOB,
     photo_mime      TEXT,
     photo_name      TEXT,
     status          TEXT DEFAULT 'open',
     resolution_note TEXT,
     created_by      TEXT DEFAULT 'driver',
     created_at      INT,
     resolved_at     INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_exceptions_package ON package_exceptions (package_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exceptions_status ON package_exceptions (status)`,
  `CREATE INDEX IF NOT EXISTS idx_exceptions_driver ON package_exceptions (driver_id)`,
  // Phase I: support tickets (append-only thread) + urgent operations alerts.
  `CREATE TABLE IF NOT EXISTS support_tickets (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_id   TEXT UNIQUE,
     driver_id   INT,
     category    TEXT,
     priority    TEXT DEFAULT 'normal',
     subject     TEXT,
     message     TEXT,
     status      TEXT DEFAULT 'open',
     created_by  TEXT DEFAULT 'driver',
     created_at  INT,
     updated_at  INT,
     resolved_at INT
   )`,
  `CREATE TABLE IF NOT EXISTS ticket_replies (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_id   TEXT,
     author_type TEXT,
     author_id   INT,
     message     TEXT,
     created_at  INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_driver ON support_tickets (driver_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets (status)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_priority ON support_tickets (priority)`,
  `CREATE INDEX IF NOT EXISTS idx_replies_ticket ON ticket_replies (ticket_id)`,
  // Phase J: private driver community (categories, comments, pinning, reports, moderation).
  `CREATE TABLE IF NOT EXISTS community_posts (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     driver_id   INT,
     author_type TEXT DEFAULT 'driver',
     category    TEXT,
     title       TEXT,
     body        TEXT,
     pinned      INT DEFAULT 0,
     status      TEXT DEFAULT 'visible',
     created_at  INT,
     updated_at  INT
   )`,
  `CREATE TABLE IF NOT EXISTS community_comments (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id     INT,
     driver_id   INT,
     author_type TEXT DEFAULT 'driver',
     body        TEXT,
     status      TEXT DEFAULT 'visible',
     created_at  INT
   )`,
  `CREATE TABLE IF NOT EXISTS community_reports (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id     INT,
     comment_id  INT,
     reporter_driver_id INT,
     reason      TEXT,
     status      TEXT DEFAULT 'open',
     created_at  INT,
     reviewed_at INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cposts_category ON community_posts (category)`,
  `CREATE INDEX IF NOT EXISTS idx_cposts_status ON community_posts (status)`,
  `CREATE INDEX IF NOT EXISTS idx_ccomments_post ON community_comments (post_id)`,
  `CREATE INDEX IF NOT EXISTS idx_creports_status ON community_reports (status)`,
  `CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views (visitor_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_events_lead ON events (lead_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_queue_status_due ON email_queue (status, scheduled_for)`,
  `CREATE INDEX IF NOT EXISTS idx_purchases_lead ON purchases (lead_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_carts_lead ON carts (lead_id, purchased)`,
  `CREATE INDEX IF NOT EXISTS idx_room_sessions_email ON room_sessions (email)`,
  `CREATE INDEX IF NOT EXISTS idx_room_progress_email ON room_progress (email)`,
  `CREATE INDEX IF NOT EXISTS idx_room_comments_post ON room_comments (post_id)`,
  `CREATE INDEX IF NOT EXISTS idx_room_checkins_email ON room_checkins (email, week)`,
  `CREATE INDEX IF NOT EXISTS idx_room_reviews_email ON room_reviews (email)`,
  `CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers (status)`,
  `CREATE INDEX IF NOT EXISTS idx_drivers_token ON drivers (access_token)`,
  `CREATE INDEX IF NOT EXISTS idx_drivers_source ON drivers (source)`,
  `CREATE INDEX IF NOT EXISTS idx_driver_history_driver ON driver_status_history (driver_id, ts)`,
];

// --- Idempotent column migrations ------------------------------------------------
// Columns added after the initial schema. Each migration runs at boot (both
// backends) but the ALTER TABLE is skipped when the column already exists
// (checked via PRAGMA table_info), so reboots never error.
const MIGRATIONS = [
  { table: 'leads', column: 'goal', ddl: 'ALTER TABLE leads ADD COLUMN goal TEXT' },
  {
    table: 'room_members',
    column: 'onboarded',
    ddl: 'ALTER TABLE room_members ADD COLUMN onboarded INTEGER DEFAULT 0',
  },
  {
    // Proof uploads are stored as BLOBs in the database so they survive
    // app restarts/redeploys alongside the rest of the member data.
    table: 'room_checkins',
    column: 'proof_blob',
    ddl: 'ALTER TABLE room_checkins ADD COLUMN proof_blob BLOB',
  },
  {
    // Daily text nudges: the member's mobile number for SMS accountability
    // nudges. Optional; members opt in on the claim form.
    table: 'room_members',
    column: 'phone',
    ddl: 'ALTER TABLE room_members ADD COLUMN phone TEXT',
  },
];

/**
 * Apply MIGRATIONS against a backend's all()/run() pair. Table/column names
 * come from the trusted MIGRATIONS constant (never from user input), so the
 * PRAGMA string is safe.
 */
async function applyMigrations(all, run) {
  for (const m of MIGRATIONS) {
    const cols = await all(`PRAGMA table_info(${m.table})`);
    const exists = cols.some((c) => c && (c.name === m.column || Object.values(c)[1] === m.column));
    if (exists) continue;
    await run(m.ddl);
    console.log(`[db] migrated ${m.table}.${m.column}`);
  }
}

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
    // WAL mode lets readers and writers coexist; busy_timeout turns transient
    // lock contention into a short wait instead of an SQLITE_BUSY error.
    // (Matters for the test suite, which holds its own connection open while
    // the server writes, and for any concurrent local traffic.)
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    for (const s of SCHEMA_STATEMENTS) db.exec(s);
    await applyMigrations(localAll, localRun);
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
    await applyMigrations(tursoAll, tursoRun);
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
