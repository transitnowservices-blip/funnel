'use strict';
/**
 * lib/dispatch_auth.js — dispatcher accounts + sessions + password reset.
 *
 * Dispatchers get REAL logins (email + password) behind /dispatch/* — the
 * shared ADMIN_TOKEN stays Davena-only. No public self-signup: accounts are
 * created only by Davena on the admin dispatcher-management page.
 *
 * Passwords use the SAME scrypt scheme as Room member passwords
 * (lib/room.js hashPassword/verifyPassword) — no new hashing scheme.
 * Plaintext passwords are never stored.
 *
 * Sessions: server-side rows (dispatcher_sessions), bearer token in an
 * httpOnly cookie (set/cleared by server.js via tracking.setCookie).
 *
 * Rate limits:
 *   - Login: 5 failed attempts per 15 min per (email, IP) -> temporary
 *     lockout. Wrong credentials always return the generic
 *     "Invalid email or password" (no user enumeration).
 *   - Forgot password: 5 requests per hour per IP.
 *
 * Password reset — two paths (email delivery is NOT yet configured, so both
 * exist):
 *   1. Self-service: /dispatch/forgot queues a reset email (existing
 *      email_queue pipeline) with a single-use token link. Only the SHA-256
 *      hash of the token is stored; token expires after 1 hour.
 *   2. Admin fallback: Davena issues a temporary password on the management
 *      page (shown ONCE), stored hashed, with must_change_password=1 so the
 *      dispatcher is forced through the change screen on next login.
 */
const crypto = require('crypto');
const db = require('./db');
const room = require('./room');

const SESSION_COOKIE = 'dispatch_sess';
const SESSION_TTL_MS = 12 * 3600 * 1000; // 12 hours
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const FORGOT_MAX_PER_HOUR = 5;
const FORGOT_WINDOW_MS = 3600 * 1000; // 1 hour
const RESET_TTL_MS = 3600 * 1000; // 1 hour
const MIN_PASSWORD_LEN = 10;

const INVALID_MSG = 'Invalid email or password.';
const LOCKED_MSG = 'Too many failed login attempts. Please wait 15 minutes and try again.';
const FORGOT_GENERIC_MSG = 'If an account exists for that email, a reset link is on its way.';
const FORGOT_LOCKED_MSG = 'Too many reset requests. Please wait an hour and try again.';

function cleanEmail(v) {
  return String(v || '').trim().toLowerCase();
}
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}
function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}
/** Temporary password: 14 chars from an unambiguous alphabet. */
function makeTempPassword() {
  const alpha = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (const b of bytes) out += alpha[b % alpha.length];
  return out;
}

// --- Dispatcher accounts -------------------------------------------------------
async function createDispatcher({ name, email, password }) {
  const n = String(name || '').trim();
  const e = cleanEmail(email);
  if (!n) throw new Error('Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('A valid email is required.');
  if (!password || String(password).length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  const exists = await db.get('SELECT id FROM dispatchers WHERE email = ?', [e]);
  if (exists) throw new Error('That email is already registered as a dispatcher.');
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO dispatchers (name, email, password_hash, active, must_change_password, created_at, last_login_at)
     VALUES (?, ?, ?, 1, 0, ?, NULL)`,
    [n, e, room.hashPassword(password), now]
  );
  return getDispatcherById(info.lastInsertRowid);
}

async function getDispatcherById(id) {
  return db.get('SELECT * FROM dispatchers WHERE id = ?', [Number(id)]);
}
async function getDispatcherByEmail(email) {
  const e = cleanEmail(email);
  if (!e) return null;
  return db.get('SELECT * FROM dispatchers WHERE email = ?', [e]);
}
async function listDispatchers() {
  return db.all('SELECT * FROM dispatchers ORDER BY created_at DESC, id DESC');
}
/** Deactivate/reactivate. Deactivating also kills all live sessions. */
async function setDispatcherActive(id, active) {
  const on = active ? 1 : 0;
  await db.run('UPDATE dispatchers SET active = ? WHERE id = ?', [on, Number(id)]);
  if (!on) await db.run('DELETE FROM dispatcher_sessions WHERE dispatcher_id = ?', [Number(id)]);
  return getDispatcherById(id);
}

// --- Login (with 5-fails/15min email+IP lockout) ---------------------------------
async function recentFailures(email, ip) {
  const row = await db.get(
    `SELECT COUNT(*) c FROM dispatcher_login_attempts
      WHERE email = ? AND ip = ? AND created_at >= ?`,
    [cleanEmail(email), String(ip || ''), Date.now() - LOGIN_LOCKOUT_MS]
  );
  return Number(row.c);
}
async function isLockedOut(email, ip) {
  return (await recentFailures(email, ip)) >= LOGIN_MAX_FAILS;
}

/**
 * Returns { dispatcher, token } on success, null on bad credentials.
 * Throws Error('locked') when the email+IP is in temporary lockout.
 */
async function attemptLogin(email, password, ip) {
  const e = cleanEmail(email);
  const ipStr = String(ip || '');
  // Opportunistic cleanup of stale attempt rows.
  await db.run('DELETE FROM dispatcher_login_attempts WHERE created_at < ?', [Date.now() - LOGIN_LOCKOUT_MS]);
  if (await isLockedOut(e, ipStr)) {
    const err = new Error(LOCKED_MSG);
    err.code = 'locked';
    throw err;
  }
  const d = await getDispatcherByEmail(e);
  const ok = d && d.active === 1 && room.verifyPassword(String(password || ''), d.password_hash);
  if (!ok) {
    await db.run('INSERT INTO dispatcher_login_attempts (email, ip, created_at) VALUES (?, ?, ?)', [e, ipStr, Date.now()]);
    return null;
  }
  await db.run('DELETE FROM dispatcher_login_attempts WHERE email = ? AND ip = ?', [e, ipStr]);
  const now = Date.now();
  await db.run('UPDATE dispatchers SET last_login_at = ? WHERE id = ?', [now, d.id]);
  const token = randomToken();
  await db.run(
    'INSERT INTO dispatcher_sessions (token, dispatcher_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, d.id, now, now + SESSION_TTL_MS]
  );
  return { dispatcher: await getDispatcherById(d.id), token };
}

// --- Sessions --------------------------------------------------------------------
async function getSessionDispatcher(token) {
  if (!token || typeof token !== 'string') return null;
  const row = await db.get('SELECT * FROM dispatcher_sessions WHERE token = ?', [token]);
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await db.run('DELETE FROM dispatcher_sessions WHERE token = ?', [token]);
    return null;
  }
  const d = await getDispatcherById(row.dispatcher_id);
  if (!d || d.active !== 1) {
    await db.run('DELETE FROM dispatcher_sessions WHERE token = ?', [token]);
    return null;
  }
  return d;
}
async function destroySession(token) {
  if (token) await db.run('DELETE FROM dispatcher_sessions WHERE token = ?', [token]);
}

/** Queue the dispatcher reset email through the existing email_queue pipeline. */
async function queueDispatchResetEmail(email, token, baseUrl) {
  const clean = cleanEmail(email);
  if (!clean) return null;
  const base = String(baseUrl || process.env.APP_URL || '').replace(/\/$/, '');
  const link = `${base}/dispatch/reset/${token}`;
  const body = `<p>Someone requested a password reset for your TransitNow dispatcher login.</p>` +
    `<p><a href="${link}">Choose a new password</a></p>` +
    `<p>This link expires in 1 hour and can only be used once. If you did not request this, you can ignore this email — your password is unchanged.</p>`;
  const info = await db.run(
    `INSERT INTO email_queue
       (lead_id, email, sequence, step, subject, body_html, product_id, scheduled_for, status)
     VALUES (NULL, ?, 'dispatch-reset', ?, ?, ?, NULL, ?, 'queued')`,
    [clean, `reset-${Date.now()}`, 'Reset your TransitNow dispatcher password', body, Date.now()]
  );
  return info.lastInsertRowid;
}

// --- Self-service reset: forgot (5/hr per IP) + single-use tokens ----------------
async function forgotPassword(email, ip, baseUrl) {
  const ipStr = String(ip || '');
  await db.run('DELETE FROM dispatcher_forgot_attempts WHERE created_at < ?', [Date.now() - FORGOT_WINDOW_MS]);
  const row = await db.get(
    'SELECT COUNT(*) c FROM dispatcher_forgot_attempts WHERE ip = ? AND created_at >= ?',
    [ipStr, Date.now() - FORGOT_WINDOW_MS]
  );
  if (Number(row.c) >= FORGOT_MAX_PER_HOUR) {
    const err = new Error(FORGOT_LOCKED_MSG);
    err.code = 'forgot_locked';
    throw err;
  }
  await db.run('INSERT INTO dispatcher_forgot_attempts (ip, created_at) VALUES (?, ?)', [ipStr, Date.now()]);

  // Always generic: only EXISTING + ACTIVE accounts get a queued email.
  const d = await getDispatcherByEmail(email);
  if (!d || d.active !== 1) return null;

  // Invalidate any prior unused tokens for this dispatcher, then issue one.
  await db.run('UPDATE dispatcher_reset_tokens SET used_at = ? WHERE dispatcher_id = ? AND used_at IS NULL', [Date.now(), d.id]);
  const token = randomToken();
  const now = Date.now();
  await db.run(
    `INSERT INTO dispatcher_reset_tokens (dispatcher_id, token_hash, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, NULL)`,
    [d.id, hashResetToken(token), now, now + RESET_TTL_MS]
  );
  await queueDispatchResetEmail(d.email, token, baseUrl);
  return { dispatcher: d, token };
}

/** Validate a presented reset token; returns the dispatcher or null. */
async function validateResetToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = await db.get('SELECT * FROM dispatcher_reset_tokens WHERE token_hash = ?', [hashResetToken(token)]);
  if (!row || row.used_at) return null;
  if (Number(row.expires_at) < Date.now()) return null;
  const d = await getDispatcherById(row.dispatcher_id);
  if (!d || d.active !== 1) return null;
  return { row, dispatcher: d };
}

/** Consume a reset token and set the new password. Single-use: marked used. */
async function resetPasswordWithToken(token, pw1, pw2) {
  const v = await validateResetToken(token);
  if (!v) {
    const err = new Error('This reset link is invalid or has expired.');
    err.code = 'bad_token';
    throw err;
  }
  if (String(pw1 || '') !== String(pw2 || '')) throw new Error('The two passwords do not match.');
  if (String(pw1 || '').length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  const now = Date.now();
  await db.run(
    'UPDATE dispatchers SET password_hash = ?, must_change_password = 0 WHERE id = ?',
    [room.hashPassword(pw1), v.dispatcher.id]
  );
  await db.run('UPDATE dispatcher_reset_tokens SET used_at = ? WHERE id = ?', [now, v.row.id]);
  // Log them in immediately (fresh session, prior sessions stay as they were).
  const sessToken = randomToken();
  await db.run(
    'INSERT INTO dispatcher_sessions (token, dispatcher_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [sessToken, v.dispatcher.id, now, now + SESSION_TTL_MS]
  );
  await db.run('UPDATE dispatchers SET last_login_at = ? WHERE id = ?', [now, v.dispatcher.id]);
  return { dispatcher: await getDispatcherById(v.dispatcher.id), token: sessToken };
}

// --- Admin fallback: temporary password (works tonight, no email needed) ---------
/**
 * Davena issues a temp password shown ONCE on the management page.
 * Stores only the hash; sets must_change_password=1; kills live sessions.
 * Returns the PLAINTEXT temp password (display once, never store).
 */
async function issueTempPassword(dispatcherId) {
  const d = await getDispatcherById(dispatcherId);
  if (!d) throw new Error('Dispatcher not found.');
  const temp = makeTempPassword();
  await db.run(
    'UPDATE dispatchers SET password_hash = ?, must_change_password = 1 WHERE id = ?',
    [room.hashPassword(temp), d.id]
  );
  await db.run('DELETE FROM dispatcher_sessions WHERE dispatcher_id = ?', [d.id]);
  return { dispatcher: await getDispatcherById(d.id), tempPassword: temp };
}

// --- Change password (logged-in dispatchers) --------------------------------------
async function changePassword(dispatcherId, currentPw, pw1, pw2) {
  const d = await getDispatcherById(dispatcherId);
  if (!d) throw new Error('Dispatcher not found.');
  if (!room.verifyPassword(String(currentPw || ''), d.password_hash)) {
    throw new Error('Your current password is not correct.');
  }
  if (String(pw1 || '') !== String(pw2 || '')) throw new Error('The two new passwords do not match.');
  if (String(pw1 || '').length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  await db.run(
    'UPDATE dispatchers SET password_hash = ?, must_change_password = 0 WHERE id = ?',
    [room.hashPassword(pw1), d.id]
  );
  return getDispatcherById(d.id);
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  MIN_PASSWORD_LEN,
  INVALID_MSG,
  LOCKED_MSG,
  FORGOT_GENERIC_MSG,
  FORGOT_LOCKED_MSG,
  createDispatcher,
  getDispatcherById,
  getDispatcherByEmail,
  listDispatchers,
  setDispatcherActive,
  attemptLogin,
  isLockedOut,
  getSessionDispatcher,
  destroySession,
  forgotPassword,
  queueDispatchResetEmail,
  validateResetToken,
  resetPasswordWithToken,
  issueTempPassword,
  changePassword,
};
