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
  // Phase K: configurable weekly service plans (append-only plan-change history).
  `CREATE TABLE IF NOT EXISTS service_plans (
     id             TEXT PRIMARY KEY,
     name           TEXT,
     weekly_price_cents INT,
     description    TEXT,
     features       TEXT,
     active         INT DEFAULT 1,
     sort_order     INT DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS service_plan_settings (
     id               INT PRIMARY KEY CHECK (id = 1),
     billing_frequency TEXT DEFAULT 'weekly',
     plans_enabled    INT DEFAULT 0,
     updated_at       INT
   )`,
  `CREATE TABLE IF NOT EXISTS driver_plan_changes (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     driver_id   INT,
     from_plan_id TEXT,
     to_plan_id  TEXT,
     event       TEXT,
     note        TEXT,
     created_by  TEXT,
     created_at  INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_changes_driver ON driver_plan_changes (driver_id)`,
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
  // --- Phase 1: TransitNow Growth Ecosystem — opportunity lead database ---------
  // One shared talent + opportunity database for the GROW, BUSINESS and RSP
  // funnels, distinguished by lead_type. Additive; nothing existing is changed.
  `CREATE TABLE IF NOT EXISTS opportunity_leads (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_type          TEXT DEFAULT 'GROW',
     status             TEXT DEFAULT 'NEW',
     first_name         TEXT,
     last_name          TEXT,
     email              TEXT,
     phone              TEXT,
     preferred_contact  TEXT,
     city               TEXT,
     state              TEXT,
     zip                TEXT,
     about_you          TEXT,
     why_interested     TEXT,
     current_roles      TEXT,
     experience_level   TEXT,
     vehicle_type       TEXT,
     vehicle_ownership  TEXT,
     vehicle_year       TEXT,
     vehicle_make       TEXT,
     vehicle_model      TEXT,
     cargo_capacity     TEXT,
     payload            TEXT,
     special_equipment  TEXT,
     avail_days         TEXT,
     avail_start        TEXT,
     avail_end          TEXT,
     avail_days_per_week TEXT,
     avail_type         TEXT,
     schedule_notes     TEXT,
     service_area_type  TEXT,
     primary_city       TEXT,
     primary_state      TEXT,
     preferred_areas    TEXT,
     travel_states      TEXT,
     has_business       TEXT,
     business_help      TEXT,
     growth_interests   TEXT,
     managed_before     TEXT,
     managed_count      TEXT,
     opportunity_interests TEXT,
     readiness         TEXT,
     goals_12mo        TEXT,
     growth_vision     TEXT,
     future_role       TEXT,
     something_else    TEXT,
     source            TEXT,
     referral_name     TEXT,
     referral_code     TEXT,
     marketing_consent INT DEFAULT 0,
     marketing_consent_ts INT,
     follow_up_date    TEXT,
     assigned_to       TEXT,
     created_at        INT,
     updated_at        INT
   )`,
  `CREATE TABLE IF NOT EXISTS lead_vehicles (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id           INT,
     vehicle_type      TEXT,
     ownership         TEXT,
     year              TEXT,
     make              TEXT,
     model             TEXT,
     cargo_capacity    TEXT,
     payload           TEXT,
     special_equipment TEXT,
     created_at        INT
   )`,
  `CREATE TABLE IF NOT EXISTS lead_business_info (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id         INT,
     business_name   TEXT,
     business_type   TEXT,
     years_operating TEXT,
     website         TEXT,
     business_email  TEXT,
     num_drivers     TEXT,
     num_vehicles    TEXT,
     service_area    TEXT,
     services_provided TEXT,
     current_clients TEXT,
     created_at      INT
   )`,
  `CREATE TABLE IF NOT EXISTS lead_goals (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id      INT,
     goals_12mo   TEXT,
     growth_vision TEXT,
     future_role  TEXT,
     created_at   INT
   )`,
  `CREATE TABLE IF NOT EXISTS lead_sources (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id       INT,
     source        TEXT,
     referral_name TEXT,
     referral_code TEXT,
     created_at    INT
   )`,
  `CREATE TABLE IF NOT EXISTS lead_status_history (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id     INT,
     from_status TEXT,
     to_status   TEXT,
     changed_by  TEXT,
     note        TEXT,
     ts          INT
   )`,
  `CREATE TABLE IF NOT EXISTS lead_notes (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id INT,
     author TEXT,
     note   TEXT,
     ts     INT
   )`,
  `CREATE TABLE IF NOT EXISTS lead_communications (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id   INT,
     kind      TEXT,
     subject   TEXT,
     body      TEXT,
     direction TEXT,
     ts        INT
   )`,
  `CREATE TABLE IF NOT EXISTS opportunity_lead_tags (
     lead_id INT,
     tag     TEXT,
     ts      INT,
     PRIMARY KEY (lead_id, tag)
   )`,
  `CREATE TABLE IF NOT EXISTS opportunity_lead_drafts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     token      TEXT UNIQUE,
     lead_type  TEXT DEFAULT 'GROW',
     email      TEXT,
     step       INT DEFAULT 1,
     data       TEXT,
     created_at INT,
     updated_at INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_opleads_type_status ON opportunity_leads (lead_type, status)`,
  `CREATE INDEX IF NOT EXISTS idx_opleads_email ON opportunity_leads (email)`,
  `CREATE INDEX IF NOT EXISTS idx_opleads_created ON opportunity_leads (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_oplead_status_history ON lead_status_history (lead_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_oplead_notes ON lead_notes (lead_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_oplead_comms ON lead_communications (lead_id, ts)`,
  // --- Phase 2: extended driver onboarding, opportunity database, matching ----
  // Additive. The existing drivers / driver_status_history / routes /
  // packages / custody_events / package_exceptions / support_tickets /
  // community / service_plans tables are REUSED, never duplicated.
  // The 14 granular application statuses from spec section 10 live in
  // drivers.extended_status (added via MIGRATIONS below) so the Phase B
  // pipeline status column is untouched; transitions are recorded
  // append-only in driver_onboard_history.
  `CREATE TABLE IF NOT EXISTS opportunities (
     id                     INTEGER PRIMARY KEY AUTOINCREMENT,
     name                   TEXT NOT NULL,
     client_contract        TEXT,
     location               TEXT,
     territory              TEXT,
     opportunity_type       TEXT,
     vehicle_requirements   TEXT,
     driver_requirements    TEXT,
     insurance_requirements TEXT,
     availability_requirements TEXT,
     service_area           TEXT,
     start_date             TEXT,
     end_date               TEXT,
     drivers_needed         INT DEFAULT 0,
     vehicles_needed        INT DEFAULT 0,
     status                 TEXT DEFAULT 'DRAFT',
     notes                  TEXT,
     documents              TEXT,
     contact_info           TEXT,
     created_by             TEXT,
     created_at             INT,
     updated_at             INT
   )`,
  // A recorded "Potential Match" — deliberately NEVER "hired" / promised.
  // person_type is 'lead' (opportunity_leads) or 'driver' (drivers).
  `CREATE TABLE IF NOT EXISTS opportunity_matches (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     opportunity_id INT NOT NULL,
     person_type    TEXT NOT NULL,
     person_id      INT NOT NULL,
     matched_by     TEXT,
     note           TEXT,
     ts             INT,
     UNIQUE (opportunity_id, person_type, person_id)
   )`,
  // Qualification checklist (spec section 10): one timestamped row per
  // completed check. Unchecking removes the row (the audit trail lives in
  // driver_onboard_history). Full document UPLOAD/STORAGE is deferred to
  // Phase 6 — documents are tracked here as verification records.
  `CREATE TABLE IF NOT EXISTS driver_qual_checks (
     driver_id  INT NOT NULL,
     check_key  TEXT NOT NULL,
     checked_by TEXT,
     note       TEXT,
     ts         INT,
     PRIMARY KEY (driver_id, check_key)
   )`,
  // Append-only extended-application status history (mirrors
  // driver_status_history, which keeps the Phase B pipeline statuses).
  `CREATE TABLE IF NOT EXISTS driver_onboard_history (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     driver_id   INT,
     from_status TEXT,
     to_status   TEXT,
     changed_by  TEXT,
     note        TEXT,
     ts          INT
   )`,
  // CRM lead <-> driver linkage (Phase 2 deliverable 6). Stores the link;
  // the person is NEVER copied into a duplicate record.
  `CREATE TABLE IF NOT EXISTS lead_driver_links (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id    INT NOT NULL,
     driver_id  INT NOT NULL,
     created_by TEXT,
     created_at INT,
     UNIQUE (lead_id, driver_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities (status)`,
  `CREATE INDEX IF NOT EXISTS idx_opp_matches_opp ON opportunity_matches (opportunity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_opp_matches_person ON opportunity_matches (person_type, person_id)`,
  `CREATE INDEX IF NOT EXISTS idx_onboard_history_driver ON driver_onboard_history (driver_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_lead_driver_links_lead ON lead_driver_links (lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lead_driver_links_driver ON lead_driver_links (driver_id)`,
  // --- Phase 3: contract hub, territory management, operations command center -
  // Additive. The existing routes / packages / custody_events /
  // package_exceptions / support_tickets / opportunities / opportunity_leads
  // / drivers tables are REUSED, never duplicated.
  `CREATE TABLE IF NOT EXISTS contracts (
     id                     INTEGER PRIMARY KEY AUTOINCREMENT,
     contract_number        TEXT UNIQUE,
     client                 TEXT NOT NULL,
     contract_name          TEXT NOT NULL,
     contract_type          TEXT,
     territory              TEXT,
     service_area           TEXT,
     start_date             TEXT,
     end_date               TEXT,
     route_requirements     TEXT,
     package_requirements   TEXT,
     vehicle_requirements   TEXT,
     driver_requirements    TEXT,
     insurance_requirements TEXT,
     performance_requirements TEXT,
     payment_terms          TEXT,
     documents              TEXT,
     notes                  TEXT,
     status                 TEXT DEFAULT 'LEAD',
     opportunity_id         INT,
     created_by             TEXT,
     created_at             INT,
     updated_at             INT
   )`,
  // Append-only contract status history (mirrors lead_status_history).
  `CREATE TABLE IF NOT EXISTS contract_status_history (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     contract_id INT,
     from_status TEXT,
     to_status   TEXT,
     changed_by  TEXT,
     note        TEXT,
     ts          INT
   )`,
  // Document REFERENCES only — full document upload/storage is deferred to
  // Phase 6 (spec section 23). This table records what the contract says it
  // has; it stores no file bytes.
  `CREATE TABLE IF NOT EXISTS contract_documents (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     contract_id INT,
     doc_type    TEXT,
     file_name   TEXT,
     notes       TEXT,
     uploaded_by TEXT,
     uploaded_at INT
   )`,
  // Active contracts / available drivers / available vehicles / open
  // opportunities are COMPUTED from the real tables (lib/territories.js),
  // never stored — see contract hub + opportunity + driver tables.
  `CREATE TABLE IF NOT EXISTS territories (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     name           TEXT NOT NULL UNIQUE,
     city           TEXT,
     state          TEXT,
     zip_codes      TEXT,
     service_radius TEXT,
     capacity       TEXT,
     notes          TEXT,
     created_by     TEXT,
     created_at     INT,
     updated_at     INT
   )`,
  // --- Phase 5: live video support (spec section 15, docs/VIDEO_SPEC.md) --------
  // The Phase-3 placeholder is extended here to the full schema; a provider
  // reference is stored only when a real provider creates a room (never
  // faked). Recording is OFF by default: consent_given starts at 0 and media
  // capture is not implemented — only the consent record, retention expiry
  // and access log exist.
  `CREATE TABLE IF NOT EXISTS live_sessions (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id      TEXT UNIQUE,
     driver_id       INT,
     dispatcher_name TEXT,
     route_id        INT,
     contract_id     INT,
     priority        TEXT DEFAULT 'NORMAL',
     reason          TEXT,
     status          TEXT DEFAULT 'REQUESTED',
     consent_camera  INT DEFAULT 0,
     consent_mic     INT DEFAULT 0,
     share_location  INT DEFAULT 0,
     notes           TEXT,
     provider_ref    TEXT,
     started_at      INT,
     ended_at        INT,
     created_at      INT,
     updated_at      INT
   )`,
  // Append-only participant join/leave records (never edited).
  `CREATE TABLE IF NOT EXISTS live_participants (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id  TEXT,
     driver_id   INT,
     staff_name  TEXT,
     role        TEXT,
     joined_at   INT,
     left_at     INT
   )`,
  // Append-only session event log (requested/accepted/started/ended/
  // message/consent/toggle/note/...). History is never edited.
  `CREATE TABLE IF NOT EXISTS live_session_events (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id  TEXT,
     event_type  TEXT,
     actor       TEXT,
     details     TEXT,
     ts          INT
   )`,
  // In-session chat (append-only; never edited or deleted).
  `CREATE TABLE IF NOT EXISTS live_session_messages (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id  TEXT,
     sender_type TEXT,
     sender_id   INT,
     message     TEXT,
     ts          INT
   )`,
  // Recording consent + retention record. consent_given = 0 by default;
  // explicit opt-in BEFORE any recording may start. No media capture is
  // implemented — storage_ref stays NULL until a real capture pipeline
  // exists. Every access is logged in live_recording_access_log.
  `CREATE TABLE IF NOT EXISTS live_session_recordings (
     id                   INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id           TEXT UNIQUE,
     consent_given        INT DEFAULT 0,
     consent_by           TEXT,
     consent_at           INT,
     consent_note         TEXT,
     storage_ref          TEXT,
     retention_expires_at INT,
     created_at           INT
   )`,
  `CREATE TABLE IF NOT EXISTS live_recording_access_log (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     recording_id INT,
     accessed_by  TEXT,
     purpose      TEXT,
     accessed_at  INT
   )`,
  // Driver-initiated request to go live (one per session request).
  `CREATE TABLE IF NOT EXISTS live_support_requests (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     request_id  TEXT UNIQUE,
     driver_id   INT,
     session_id  TEXT,
     reason      TEXT,
     priority    TEXT DEFAULT 'NORMAL',
     status      TEXT DEFAULT 'open',
     created_at  INT,
     resolved_at INT
   )`,
  // Live training events + attendance + training content library.
  // provider_ref is set only when a configured provider backs the event;
  // otherwise events are clearly labeled as not provider-backed.
  `CREATE TABLE IF NOT EXISTS live_training_events (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id     TEXT UNIQUE,
     title        TEXT,
     description  TEXT,
     scheduled_at INT,
     provider_ref TEXT,
     status       TEXT DEFAULT 'scheduled',
     created_by   TEXT,
     created_at   INT
   )`,
  `CREATE TABLE IF NOT EXISTS live_training_attendance (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id    TEXT,
     driver_id   INT,
     attended    INT DEFAULT 0,
     attended_at INT,
     UNIQUE (event_id, driver_id)
   )`,
  `CREATE TABLE IF NOT EXISTS video_training_content (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     title         TEXT,
     description   TEXT,
     url           TEXT,
     duration_secs INT,
     created_at    INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_live_participants_session ON live_participants (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_live_events_session ON live_session_events (session_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_live_messages_session ON live_session_messages (session_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_live_requests_driver ON live_support_requests (driver_id)`,
  `CREATE INDEX IF NOT EXISTS idx_live_training_att_event ON live_training_attendance (event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts (status)`,
  `CREATE INDEX IF NOT EXISTS idx_contracts_territory ON contracts (territory)`,
  `CREATE INDEX IF NOT EXISTS idx_contract_history ON contract_status_history (contract_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_contract_docs ON contract_documents (contract_id)`,
  `CREATE INDEX IF NOT EXISTS idx_territories_name ON territories (name)`,
  // --- Phase 6: referral system (spec section 31) ------------------------------
  `CREATE TABLE IF NOT EXISTS referral_codes (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     code           TEXT UNIQUE NOT NULL,
     issued_to_type TEXT NOT NULL DEFAULT 'driver',
     issued_to_id   INT,
     issued_to_name TEXT,
     issued_by      TEXT DEFAULT 'admin',
     issued_at      INT,
     status         TEXT DEFAULT 'active',
     revoked_at     INT,
     notes          TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS referral_attributions (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     code_id         INT,
     code            TEXT,
     referred_lead_id INT,
     referred_name   TEXT,
     referred_email  TEXT,
     status          TEXT DEFAULT 'applied',
     opportunity_id  INT,
     outcome         TEXT,
     created_at      INT,
     updated_at      INT
   )`,
  // --- Phase 6: follow-up system (spec section 32) -----------------------------
  // Exact statuses enforced by the follow-ups module:
  // CONTACT TODAY, FOLLOW UP, WAITING ON DOCUMENTS, WAITING ON RESPONSE,
  // OPPORTUNITY PENDING, NURTURE, CLOSED.
  `CREATE TABLE IF NOT EXISTS lead_followups (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id           INT,
     followup_status   TEXT,
     last_contact_at   INT,
     next_follow_up_at INT,
     assigned_to       TEXT,
     note              TEXT,
     outcome           TEXT,
     contact_attempt   INT DEFAULT 0,
     reminder          INT DEFAULT 0,
     created_by        TEXT DEFAULT 'admin',
     created_at        INT
   )`,
  // --- Phase 6: alerts (spec section 22) ---------------------------------------
  `CREATE TABLE IF NOT EXISTS alerts (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     alert_type      TEXT,
     title           TEXT,
     detail          TEXT,
     source_type     TEXT,
     source_id       TEXT,
     severity        TEXT DEFAULT 'info',
     status          TEXT DEFAULT 'open',
     ts              INT,
     acknowledged_at INT,
     acknowledged_by TEXT,
     resolved_at     INT,
     notified_at     INT,
     meta            TEXT,
     UNIQUE (alert_type, source_type, source_id)
   )`,
  `CREATE TABLE IF NOT EXISTS notification_prefs (
     alert_type     TEXT PRIMARY KEY,
     notify_enabled INT DEFAULT 1,
     note           TEXT,
     updated_at     INT
   )`,
  // --- Phase 6: document management (spec section 23) ---------------------------
  // Files are stored as BLOBs in the database — the same server-side pattern
  // the A–L exception-photo flow uses (photo_blob in package_exceptions).
  `CREATE TABLE IF NOT EXISTS driver_documents (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_type        TEXT NOT NULL DEFAULT 'driver',
     owner_id          INT,
     doc_type          TEXT,
     file_blob         BLOB,
     file_mime         TEXT,
     file_name         TEXT,
     size_bytes        INT,
     uploaded_by       TEXT,
     uploaded_by_role  TEXT,
     uploaded_at       INT,
     expires_at        INT,
     status            TEXT DEFAULT 'pending',
     verification_status TEXT DEFAULT 'unverified',
     verified_by       TEXT,
     verified_at       INT,
     notes             TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS doc_requirements (
     owner_type TEXT,
     doc_type   TEXT,
     label      TEXT,
     PRIMARY KEY (owner_type, doc_type)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes (code)`,
  `CREATE INDEX IF NOT EXISTS idx_referral_codes_status ON referral_codes (status)`,
  `CREATE INDEX IF NOT EXISTS idx_referral_attr_lead ON referral_attributions (referred_lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lead_followups_lead ON lead_followups (lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lead_followups_next ON lead_followups (next_follow_up_at)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_type_status ON alerts (alert_type, status)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_driver_docs_owner ON driver_documents (owner_type, owner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_driver_docs_type ON driver_documents (doc_type)`,
  // --- Paid-client enforcement: TransitNow dispatch subscriptions ---------------
  // Additive. Stripe is the source of truth; the webhook keeps this table
  // current (active / past_due / canceled). Dispatch work is gated on an
  // 'active' row here. The $49 Room product is NOT tracked here.
  `CREATE TABLE IF NOT EXISTS dispatch_subscriptions (
     id                     INTEGER PRIMARY KEY AUTOINCREMENT,
     stripe_customer_id     TEXT UNIQUE,
     stripe_subscription_id TEXT,
     email                  TEXT NOT NULL,
     plan                   TEXT NOT NULL,
     status                 TEXT NOT NULL DEFAULT 'active',
     current_period_end     INT,
     created_at             INT NOT NULL,
     updated_at             INT NOT NULL,
     is_test                INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dispatch_subs_email ON dispatch_subscriptions (email)`,
  `CREATE INDEX IF NOT EXISTS idx_dispatch_subs_status ON dispatch_subscriptions (status)`,
  // Stripe webhook idempotency: one row per processed event id.
  `CREATE TABLE IF NOT EXISTS stripe_processed_events (
     event_id TEXT PRIMARY KEY,
     type     TEXT,
     ts       INT NOT NULL
   )`,
  // --- Automated tier-based route matching ------------------------------------
  // Additive. Matches are created ONLY from real rows in `opportunities`
  // (status OPEN). Never fabricated. A match is a "Potential Match", never a
  // promise of routes, loads, contracts, or income.
  `CREATE TABLE IF NOT EXISTS driver_route_matches (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     driver_id      INT NOT NULL,
     opportunity_id INT NOT NULL,
     tier           TEXT NOT NULL,
     cycle_key      TEXT NOT NULL,
     status         TEXT NOT NULL DEFAULT 'assigned',
     matched_at     INT NOT NULL,
     released_at    INT,
     release_reason TEXT,
     UNIQUE (driver_id, opportunity_id, cycle_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_drm_driver ON driver_route_matches (driver_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_drm_cycle ON driver_route_matches (cycle_key)`,
  // Driver-set weekly goal (dollars). A goal to track toward — never a promise.
  `CREATE TABLE IF NOT EXISTS driver_weekly_goals (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     driver_id  INT NOT NULL,
     week_key   TEXT NOT NULL,
     goal_cents INT NOT NULL DEFAULT 0,
     set_at     INT NOT NULL,
     UNIQUE (driver_id, week_key)
   )`,
  // --- Private operations assistant (Complete tier) ---------------------------
  // Additive. Questions are stored here; answers come from the AI through the
  // operator workflow — the app NEVER generates or fakes an answer. Public
  // copy never names the AI or any vendor/model ("your private operations
  // assistant" only); internal comments may say how it's fulfilled.
  `CREATE TABLE IF NOT EXISTS ai_questions (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     driver_id   INT NOT NULL,
     question    TEXT NOT NULL,
     answer      TEXT,
     status      TEXT NOT NULL DEFAULT 'pending',
     created_at  INT NOT NULL,
     answered_at INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_aiq_driver ON ai_questions (driver_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_aiq_pending ON ai_questions (status, created_at)`,
  // --- Dispatch field communications (broadcasts + direct messages) ------------
  // Additive. driver_messages is the driver-facing inbox backing store
  // (broadcasts from admin + direct admin->driver messages). broadcast_log is
  // the admin-visible send log. Delivery itself rides the existing
  // email_queue pipeline (email) and the SMS stub (provider-pending texts).
  // Urgent field contact reuses the existing support_tickets table
  // (priority='urgent', status='open' = unacknowledged siren) — no duplicate
  // urgent-alert tables are created here by design.
  `CREATE TABLE IF NOT EXISTS driver_messages (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     driver_id   INT NOT NULL,
     kind        TEXT NOT NULL,
     subject     TEXT NOT NULL,
     body        TEXT NOT NULL,
     audience    TEXT,
     created_at  INT NOT NULL,
     read_at     INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dm_driver ON driver_messages (driver_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS broadcast_log (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     audience     TEXT NOT NULL,
     subject      TEXT NOT NULL,
     message      TEXT NOT NULL,
     driver_count INT NOT NULL DEFAULT 0,
     created_at   INT NOT NULL
   )`,
  // --- Dispatcher logins (real accounts behind /dispatch/*) -------------------
  // dispatchers: dispatcher accounts created ONLY by Davena via the admin
  // management page — no public self-signup. password_hash uses the same
  // scrypt scheme as Room member passwords (lib/room.js); plaintext is never
  // stored. must_change_password=1 forces the change-password screen after
  // an admin-issued temporary password.
  // dispatcher_sessions: httpOnly cookie session tokens (server-side rows).
  // dispatcher_login_attempts: failed-login rows for the 5-per-15min
  //   email+IP lockout. dispatcher_forgot_attempts: 5-per-hour IP limit on
  //   the forgot-password endpoint.
  // dispatcher_reset_tokens: single-use self-service reset tokens — only the
  //   SHA-256 hash of the token is stored; expires 1h after issue.
  `CREATE TABLE IF NOT EXISTS dispatchers (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     name                TEXT NOT NULL,
     email               TEXT NOT NULL UNIQUE,
     password_hash       TEXT NOT NULL,
     active              INT NOT NULL DEFAULT 1,
     must_change_password INT NOT NULL DEFAULT 0,
     created_at          INT NOT NULL,
     last_login_at       INT
   )`,
  `CREATE TABLE IF NOT EXISTS dispatcher_sessions (
     token         TEXT PRIMARY KEY,
     dispatcher_id INT NOT NULL,
     created_at    INT NOT NULL,
     expires_at    INT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dsess_dispatcher ON dispatcher_sessions (dispatcher_id)`,
  `CREATE TABLE IF NOT EXISTS dispatcher_login_attempts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     email      TEXT NOT NULL,
     ip         TEXT NOT NULL,
     created_at INT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dla_email_ip ON dispatcher_login_attempts (email, ip, created_at)`,
  `CREATE TABLE IF NOT EXISTS dispatcher_forgot_attempts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     ip         TEXT NOT NULL,
     created_at INT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dfa_ip ON dispatcher_forgot_attempts (ip, created_at)`,
  `CREATE TABLE IF NOT EXISTS dispatcher_reset_tokens (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     dispatcher_id INT NOT NULL,
     token_hash    TEXT NOT NULL,
     created_at    INT NOT NULL,
     expires_at    INT NOT NULL,
     used_at       INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_drt_hash ON dispatcher_reset_tokens (token_hash)`,
  // --- Wealth Room member password reset -------------------------------------
  // room_reset_tokens: single-use self-service reset tokens — only the
  //   SHA-256 hash of the token is stored; expires 1h after issue.
  // room_forgot_attempts: 5-per-hour IP limit on /room/forgot.
  `CREATE TABLE IF NOT EXISTS room_reset_tokens (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     email      TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     created_at INT NOT NULL,
     expires_at INT NOT NULL,
     used_at    INT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rrt_hash ON room_reset_tokens (token_hash)`,
  `CREATE TABLE IF NOT EXISTS room_forgot_attempts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     ip         TEXT NOT NULL,
     created_at INT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rfa_ip ON room_forgot_attempts (ip, created_at)`,
  // Monday-cycle / onboarding / manual run log (admin-visible).
  `CREATE TABLE IF NOT EXISTS route_match_cycles (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     cycle_key          TEXT UNIQUE NOT NULL,
     kind               TEXT NOT NULL,
     ran_at             INT NOT NULL,
     drivers_considered INT NOT NULL DEFAULT 0,
     drivers_matched    INT NOT NULL DEFAULT 0,
     matches_created    INT NOT NULL DEFAULT 0,
     notifications_queued INT NOT NULL DEFAULT 0,
     notes              TEXT
   )`,
];

// --- Post-migration indexes ------------------------------------------------------
// These indexes reference columns that Phase-5 MIGRATIONS add to the existing
// live_sessions placeholder table, so they must be created AFTER migrations
// run (creating them earlier fails on databases that still have the old
// placeholder schema).
const POST_MIGRATION_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_live_sessions_driver ON live_sessions (driver_id)`,
  `CREATE INDEX IF NOT EXISTS idx_live_sessions_status ON live_sessions (status)`,
];

// --- Idempotent column migrations ------------------------------------------------
// Columns added after the initial schema. Each migration runs at boot (both
// backends) but the ALTER TABLE is skipped when the column already exists
// (checked via PRAGMA table_info), so reboots never error.
const MIGRATIONS = [
  { table: 'leads', column: 'goal', ddl: 'ALTER TABLE leads ADD COLUMN goal TEXT' },
  {
    // Password reset: admin-issued temporary passwords force the member to
    // choose their own password on next login.
    table: 'room_members',
    column: 'must_change_password',
    ddl: 'ALTER TABLE room_members ADD COLUMN must_change_password INTEGER DEFAULT 0',
  },
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
  // --- Phase 2: extended driver onboarding (spec section 10) -----------------
  // Granular application status + license/insurance/consent fields on the
  // EXISTING drivers table (never a second drivers table). The extended
  // application is submitted via a token-scoped /drivers/apply/:token link
  // shared by operations — not a public free-for-all.
  { table: 'drivers', column: 'extended_status', ddl: 'ALTER TABLE drivers ADD COLUMN extended_status TEXT' },
  { table: 'drivers', column: 'license_number', ddl: 'ALTER TABLE drivers ADD COLUMN license_number TEXT' },
  { table: 'drivers', column: 'license_state', ddl: 'ALTER TABLE drivers ADD COLUMN license_state TEXT' },
  { table: 'drivers', column: 'license_class', ddl: 'ALTER TABLE drivers ADD COLUMN license_class TEXT' },
  { table: 'drivers', column: 'license_expiry', ddl: 'ALTER TABLE drivers ADD COLUMN license_expiry TEXT' },
  { table: 'drivers', column: 'insurance_carrier', ddl: 'ALTER TABLE drivers ADD COLUMN insurance_carrier TEXT' },
  { table: 'drivers', column: 'insurance_policy', ddl: 'ALTER TABLE drivers ADD COLUMN insurance_policy TEXT' },
  { table: 'drivers', column: 'insurance_expiry', ddl: 'ALTER TABLE drivers ADD COLUMN insurance_expiry TEXT' },
  { table: 'drivers', column: 'consent_background', ddl: 'ALTER TABLE drivers ADD COLUMN consent_background INT DEFAULT 0' },
  { table: 'drivers', column: 'consent_insurance_check', ddl: 'ALTER TABLE drivers ADD COLUMN consent_insurance_check INT DEFAULT 0' },
  { table: 'drivers', column: 'agreement_accepted', ddl: 'ALTER TABLE drivers ADD COLUMN agreement_accepted INT DEFAULT 0' },
  { table: 'drivers', column: 'agreement_accepted_at', ddl: 'ALTER TABLE drivers ADD COLUMN agreement_accepted_at INT' },
  // --- Phase 3: link A–L routes to contracts (contract hub) ----------------
  // Routes keep everything they have; this optional column lets a contract
  // claim the routes that run under it. Set from the contract detail page.
  { table: 'routes', column: 'contract_number', ddl: 'ALTER TABLE routes ADD COLUMN contract_number TEXT' },
  {
    // Admin test-access grants: marks dispatch_subscriptions rows created by
    // the admin "grant test access" action (no Stripe payment). Test grants
    // flow through paid-client features (broadcasts, matching, PAID badge)
    // but are labeled TEST in admin and excluded from revenue accounting.
    table: 'dispatch_subscriptions',
    column: 'is_test',
    ddl: 'ALTER TABLE dispatch_subscriptions ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0',
  },
  // --- Phase 5: extend the live_sessions placeholder to the full schema ----
  // (Existing DBs already have id/session_id/title/created_by/status/
  // created_at from the Phase-3 placeholder.) The title/created_by columns
  // are left in place on old DBs; fresh DBs get the full schema directly.
  { table: 'live_sessions', column: 'driver_id', ddl: 'ALTER TABLE live_sessions ADD COLUMN driver_id INT' },
  { table: 'live_sessions', column: 'dispatcher_name', ddl: 'ALTER TABLE live_sessions ADD COLUMN dispatcher_name TEXT' },
  { table: 'live_sessions', column: 'route_id', ddl: 'ALTER TABLE live_sessions ADD COLUMN route_id INT' },
  { table: 'live_sessions', column: 'contract_id', ddl: 'ALTER TABLE live_sessions ADD COLUMN contract_id INT' },
  { table: 'live_sessions', column: 'priority', ddl: "ALTER TABLE live_sessions ADD COLUMN priority TEXT DEFAULT 'NORMAL'" },
  { table: 'live_sessions', column: 'reason', ddl: 'ALTER TABLE live_sessions ADD COLUMN reason TEXT' },
  { table: 'live_sessions', column: 'consent_camera', ddl: 'ALTER TABLE live_sessions ADD COLUMN consent_camera INT DEFAULT 0' },
  { table: 'live_sessions', column: 'consent_mic', ddl: 'ALTER TABLE live_sessions ADD COLUMN consent_mic INT DEFAULT 0' },
  { table: 'live_sessions', column: 'share_location', ddl: 'ALTER TABLE live_sessions ADD COLUMN share_location INT DEFAULT 0' },
  { table: 'live_sessions', column: 'notes', ddl: 'ALTER TABLE live_sessions ADD COLUMN notes TEXT' },
  { table: 'live_sessions', column: 'provider_ref', ddl: 'ALTER TABLE live_sessions ADD COLUMN provider_ref TEXT' },
  { table: 'live_sessions', column: 'started_at', ddl: 'ALTER TABLE live_sessions ADD COLUMN started_at INT' },
  { table: 'live_sessions', column: 'ended_at', ddl: 'ALTER TABLE live_sessions ADD COLUMN ended_at INT' },
  { table: 'live_sessions', column: 'updated_at', ddl: 'ALTER TABLE live_sessions ADD COLUMN updated_at INT' },
  // --- Phase 6: wire contract_documents into document management (spec 23) ----
  // The Phase 3 table held references only; Phase 6 gives contract docs real
  // upload/verification treatment via the shared driver_documents store.
  { table: 'contract_documents', column: 'document_id', ddl: 'ALTER TABLE contract_documents ADD COLUMN document_id INT' },
  { table: 'contract_documents', column: 'expires_at', ddl: 'ALTER TABLE contract_documents ADD COLUMN expires_at INT' },
  { table: 'contract_documents', column: 'verification_status', ddl: 'ALTER TABLE contract_documents ADD COLUMN verification_status TEXT DEFAULT \'unverified\'' },
  { table: 'contract_documents', column: 'verified_by', ddl: 'ALTER TABLE contract_documents ADD COLUMN verified_by TEXT' },
  { table: 'contract_documents', column: 'verified_at', ddl: 'ALTER TABLE contract_documents ADD COLUMN verified_at INT' },
];

/**
 * Seed the four default weekly service plans + settings row (Phase K).
 * Idempotent: runs only when service_plans is empty.
 */
const DEFAULT_SERVICE_PLANS = [
  { id: 'essential', name: 'Essential', weekly_price_cents: 30000, description: 'Core dispatch support for steady weekly routes.', features: JSON.stringify(['Weekly route coordination', 'Basic dispatch support']), sort_order: 1 },
  { id: 'plus', name: 'Plus', weekly_price_cents: 50000, description: 'Extra support for busier weeks.', features: JSON.stringify(['Everything in Essential', 'Priority dispatch queue']), sort_order: 2 },
  { id: 'pro', name: 'Pro', weekly_price_cents: 75000, description: 'For drivers running full schedules.', features: JSON.stringify(['Everything in Plus', 'Dedicated dispatcher check-ins']), sort_order: 3 },
  { id: 'max', name: 'Max', weekly_price_cents: 100000, description: 'Full-service operations support.', features: JSON.stringify(['Everything in Pro', 'Full-service operations support']), sort_order: 4 },
];
async function seedServicePlans(all, run) {
  const rows = await all('SELECT COUNT(*) c FROM service_plans');
  if (Number(rows[0] && (rows[0].c ?? Object.values(rows[0])[0])) > 0) return;
  for (const p of DEFAULT_SERVICE_PLANS) {
    await run(
      `INSERT INTO service_plans (id, name, weekly_price_cents, description, features, active, sort_order)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [p.id, p.name, p.weekly_price_cents, p.description, p.features, p.sort_order]
    );
  }
  await run(`INSERT OR IGNORE INTO service_plan_settings (id, billing_frequency, plans_enabled, updated_at)
             VALUES (1, 'weekly', 0, ?)`, [Date.now()]);
  console.log('[db] seeded default service plans');
}

// --- Phase 6 seed: alert notification preferences + required documents --------
// notification_prefs: one row per spec alert type; notify_enabled=1 by default.
// doc_requirements: required document types per owner type (drives the
// "required document" alert). Seeded once; admin can edit prefs via the UI.
const PHASE6_ALERT_TYPES = [
  'urgent_support', 'package_exception', 'lost_package', 'route_delay',
  'driver_issue', 'vehicle_issue', 'new_applicant', 'new_rsp_lead',
  'new_business_opportunity', 'required_document', 'expiring_document',
];
const PHASE6_DOC_REQUIREMENTS = [
  ['driver', 'driver_license', 'Driver license'],
  ['driver', 'insurance', 'Insurance (auto/commercial)'],
  ['contract', 'agreement', 'Signed agreement'],
];
async function seedPhase6(all, run) {
  const now = Date.now();
  for (const t of PHASE6_ALERT_TYPES) {
    await run(
      `INSERT OR IGNORE INTO notification_prefs (alert_type, notify_enabled, note, updated_at)
       VALUES (?, 1, ?, ?)`,
      [t, 'Default: notify operations when this alert fires.', now]
    );
  }
  for (const [ownerType, docType, label] of PHASE6_DOC_REQUIREMENTS) {
    await run(
      `INSERT OR IGNORE INTO doc_requirements (owner_type, doc_type, label) VALUES (?, ?, ?)`,
      [ownerType, docType, label]
    );
  }
}
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
    for (const s of POST_MIGRATION_STATEMENTS) db.exec(s);
    await seedServicePlans(localAll, localRun);
    await seedPhase6(localAll, localRun);
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
    for (const s of POST_MIGRATION_STATEMENTS) {
      await client.execute(s);
    }
    await seedServicePlans(tursoAll, tursoRun);
    await seedPhase6(tursoAll, tursoRun);
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
