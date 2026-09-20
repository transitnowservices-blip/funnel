'use strict';
/**
 * lib/room.js — The Wealth Builder's Room membership logic.
 *
 * Member lifecycle:
 *   1. Stripe checkout.session.completed ($49) -> upsertMemberFromPurchase()
 *      creates an ACTIVE member row keyed by email (no password yet).
 *   2. Member visits /room/claim, enters the email they paid with, and sets
 *      a password -> password_hash stored (scrypt), session created.
 *   3. Email + password login at /room/login -> httpOnly session cookie.
 *
 * Content: lessons live in content/room/lessons/*.md and the 90-day plan in
 * content/room/plan.json — plain files Davena can edit; re-read on mtime
 * change, no restart or code deploy needed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');

const ROOM_DIR = path.join(__dirname, '..', 'content', 'room');
const LESSONS_DIR = path.join(ROOM_DIR, 'lessons');
const PLAN_FILE = path.join(ROOM_DIR, 'plan.json');

const SESSION_COOKIE = 'room_sess';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// Sections in display order. Each section loads one or more markdown files
// (no extension) from content/room/lessons/, concatenated in the order
// listed. Older pillars used `file: 'name'` (a single file); sections use
// `files: [...]`. Both forms are supported — edit titles/files here or add
// new section files. The slug is the URL key at /room/classroom/:slug.
const PILLARS = [
  { id: 'start-here', slug: 'start-here', files: ['00-start-here'], title: '00 — Start Here', tagline: 'Welcome in — here is how the Room works.' },
  { id: 'wealth-mindset', slug: 'wealth-mindset', files: ['01-wealth-mindset'], title: '01 — Wealth Mindset, Habits & Decisions', tagline: 'How you think about money decides what you do with it.' },
  { id: 'money-cashflow', slug: 'money-cashflow', files: ['money-management', 'cash-flow'], title: '02 — Money Management & Cash Flow', tagline: 'Track it, direct it, keep more of it.' },
  { id: 'assets-ownership', slug: 'assets-ownership', files: ['assets-investing', 'real-estate', 'funding-capital', 'business-income', 'marketing-sales'], title: '03 — Assets, Investing & Ownership', tagline: 'Build an income-producing business you own — and assets that pay you.' },
  { id: '90-day-plan', slug: '90-day-plan', files: ['04-90-day-plan'], title: '04 — The 90-Day Wealth Action Plan', tagline: 'Your interactive plan: 12 weeks of small, trackable actions.' },
];

// Old pillar slugs (pre-5-section remap) -> their new section slug.
// Wire as 301 redirects so old classroom links land on the right section.
const PILLAR_REDIRECTS = {
  'money-management': 'money-cashflow',
  'cash-flow': 'money-cashflow',
  'business-income': 'assets-ownership',
  'marketing-sales': 'assets-ownership',
  'funding-capital': 'assets-ownership',
  'assets-investing': 'assets-ownership',
  'real-estate': 'assets-ownership',
};

// --- Password hashing (scrypt, node built-ins only) ---------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64);
    const a = Buffer.from(hash.toString('hex'), 'utf8');
    const b = Buffer.from(hashHex, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// --- Members ------------------------------------------------------------------
async function getMember(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  return db.get('SELECT * FROM room_members WHERE email = ?', [clean]);
}

/**
 * Create or refresh a member from a completed Stripe purchase. Idempotent:
 * re-running for the same email keeps the existing password and never
 * deactivates a member.
 */
async function upsertMemberFromPurchase({ email, name }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  const now = Date.now();
  await db.run(
    `INSERT INTO room_members (email, name, joined_at, status)
     VALUES (?, ?, ?, 'active')
     ON CONFLICT(email) DO UPDATE SET
       name = COALESCE(room_members.name, excluded.name),
       status = 'active'`,
    [clean, (name || '').trim() || null, now]
  );
  return getMember(clean);
}

async function setMemberPassword(email, password) {
  const clean = String(email || '').trim().toLowerCase();
  await db.run('UPDATE room_members SET password_hash = ? WHERE email = ?', [hashPassword(password), clean]);
}

async function setMemberStatus(email, status) {
  const clean = String(email || '').trim().toLowerCase();
  const s = status === 'inactive' ? 'inactive' : 'active';
  await db.run('UPDATE room_members SET status = ? WHERE email = ?', [s, clean]);
  if (s === 'inactive') {
    await db.run('DELETE FROM room_sessions WHERE email = ?', [clean]);
  }
}

// --- Sessions -------------------------------------------------------------------
async function createSession(email) {
  const clean = String(email || '').trim().toLowerCase();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await db.run('INSERT INTO room_sessions (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)', [
    token, clean, now, now + SESSION_TTL_MS,
  ]);
  await db.run('UPDATE room_members SET last_login = ? WHERE email = ?', [now, clean]);
  return token;
}

async function getSessionMember(token) {
  if (!token || typeof token !== 'string') return null;
  const row = await db.get('SELECT * FROM room_sessions WHERE token = ?', [token]);
  if (!row || Number(row.expires_at) < Date.now()) {
    if (row) await db.run('DELETE FROM room_sessions WHERE token = ?', [token]);
    return null;
  }
  const member = await getMember(row.email);
  if (!member || member.status !== 'active') return null;
  return member;
}

async function destroySession(token) {
  if (token) await db.run('DELETE FROM room_sessions WHERE token = ?', [token]);
}

// --- 90-day plan progress --------------------------------------------------------
async function getProgress(email) {
  const clean = String(email || '').trim().toLowerCase();
  const rows = await db.all('SELECT week, item, checked FROM room_progress WHERE email = ?', [clean]);
  const map = {};
  for (const r of rows) map[`${r.week}:${r.item}`] = r.checked ? 1 : 0;
  return map;
}

async function setProgress(email, week, item, checked) {
  const clean = String(email || '').trim().toLowerCase();
  const w = Math.max(1, Math.min(12, parseInt(week, 10) || 1));
  const i = Math.max(0, parseInt(item, 10) || 0);
  await db.run(
    `INSERT INTO room_progress (email, week, item, checked, ts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email, week, item) DO UPDATE SET checked = excluded.checked, ts = excluded.ts`,
    [clean, w, i, checked ? 1 : 0, Date.now()]
  );
}

// --- Community ---------------------------------------------------------------------
async function listPosts(limit = 50) {
  return db.all(
    `SELECT p.*, (SELECT COUNT(*) FROM room_comments c WHERE c.post_id = p.id) AS comment_count
     FROM room_posts p ORDER BY p.pinned DESC, p.created_at DESC LIMIT ?`,
    [limit]
  );
}

async function getPost(id) {
  return db.get('SELECT * FROM room_posts WHERE id = ?', [Number(id) || 0]);
}

async function listComments(postId) {
  return db.all('SELECT * FROM room_comments WHERE post_id = ? ORDER BY created_at ASC', [Number(postId) || 0]);
}

async function createPost({ authorEmail, authorName, kind, title, body }) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody) throw new Error('Post body is required.');
  const k = kind === 'announcement' ? 'announcement' : 'post';
  const r = await db.run(
    'INSERT INTO room_posts (author_email, author_name, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      String(authorEmail || '').trim().toLowerCase() || null,
      String(authorName || '').trim() || null,
      k,
      String(title || '').trim().slice(0, 140) || null,
      cleanBody.slice(0, 5000),
      Date.now(),
    ]
  );
  return r.lastInsertRowid;
}

async function createComment({ postId, authorEmail, authorName, body }) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody) throw new Error('Comment body is required.');
  const post = await getPost(postId);
  if (!post) throw new Error('Post not found.');
  const r = await db.run(
    'INSERT INTO room_comments (post_id, author_email, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)',
    [
      post.id,
      String(authorEmail || '').trim().toLowerCase() || null,
      String(authorName || '').trim() || null,
      cleanBody.slice(0, 2000),
      Date.now(),
    ]
  );
  return r.lastInsertRowid;
}

async function setPinned(postId, pinned) {
  await db.run('UPDATE room_posts SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, Number(postId) || 0]);
}

async function deletePost(postId) {
  const id = Number(postId) || 0;
  await db.run('DELETE FROM room_comments WHERE post_id = ?', [id]);
  await db.run('DELETE FROM room_posts WHERE id = ?', [id]);
}

async function deleteComment(commentId) {
  await db.run('DELETE FROM room_comments WHERE id = ?', [Number(commentId) || 0]);
}

// --- Accountability: 90-day goals, weekly proof check-ins, reviews ------------
const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;
const NINETY_DAYS_MS = 90 * DAY_MS;
const ACCOUNTABILITY_WEEKS = 12;

function cleanEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** The member's 90-day goal row, or null when they haven't set one yet. */
async function getGoal(email) {
  const clean = cleanEmail(email);
  if (!clean) return null;
  return db.get('SELECT * FROM room_goals WHERE email = ?', [clean]);
}

/**
 * Create or edit the member's 90-day goal. The start/target dates are fixed
 * on first creation and never move on edit.
 */
async function saveGoal(email, text) {
  const clean = cleanEmail(email);
  const goalText = String(text || '').trim().slice(0, 500);
  if (!clean) throw new Error('Email is required.');
  if (!goalText) throw new Error('Please write your 90-day goal.');
  const now = Date.now();
  const existing = await getGoal(clean);
  if (existing) {
    await db.run('UPDATE room_goals SET goal_text = ?, updated_at = ? WHERE email = ?', [goalText, now, clean]);
  } else {
    await db.run(
      'INSERT INTO room_goals (email, goal_text, start_date, target_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [clean, goalText, now, now + NINETY_DAYS_MS, now, now]
    );
  }
  return getGoal(clean);
}

/**
 * Week math for a member's 90-day journey. Returns null when no goal exists.
 * currentWeek is clamped to 1..12: week 1 starts on the goal start date.
 */
async function weekInfo(email) {
  const goal = await getGoal(email);
  if (!goal || !goal.start_date) return null;
  const elapsed = Date.now() - Number(goal.start_date);
  const week = Math.floor(Math.max(0, elapsed) / WEEK_MS) + 1;
  return {
    startDate: Number(goal.start_date),
    targetDate: Number(goal.target_date),
    currentWeek: Math.max(1, Math.min(ACCOUNTABILITY_WEEKS, week)),
    goalText: goal.goal_text,
  };
}

async function getCheckin(email, week) {
  const clean = cleanEmail(email);
  const w = Math.max(1, Math.min(ACCOUNTABILITY_WEEKS, parseInt(week, 10) || 1));
  if (!clean) return null;
  return db.get('SELECT * FROM room_checkins WHERE email = ? AND week = ?', [clean, w]);
}

async function getCheckinById(id) {
  const n = Number(id) || 0;
  if (!n) return null;
  return db.get('SELECT * FROM room_checkins WHERE id = ?', [n]);
}

async function listCheckins(email) {
  const clean = cleanEmail(email);
  if (!clean) return [];
  // Exclude proof_blob (file bytes) from list queries; single-row fetches
  // (getCheckin/getCheckinById) keep it for serving the file.
  return db.all(
    'SELECT id, email, week, created_at, goal, action_taken, accomplishment, lesson, next_commitment, proof_name, proof_mime, proof_size, (proof_blob IS NOT NULL) AS has_proof FROM room_checkins WHERE email = ? ORDER BY week ASC',
    [clean]
  );
}

const CHECKIN_FIELDS = ['goal', 'action_taken', 'accomplishment', 'lesson', 'next_commitment'];

/**
 * Insert or update the member's check-in for a week. created_at is always
 * server-generated on insert and never changes on update; the client can
 * never supply a timestamp. Proof columns change only when a new file's
 * metadata is passed (proof === null keeps existing proof info). The file
 * bytes live in proof_blob so uploads survive restarts/redeploys with the DB.
 */
async function saveCheckin(email, week, fields = {}, proof = undefined) {
  const clean = cleanEmail(email);
  const w = Math.max(1, Math.min(ACCOUNTABILITY_WEEKS, parseInt(week, 10) || 1));
  if (!clean) throw new Error('Email is required.');
  const vals = {};
  for (const f of CHECKIN_FIELDS) vals[f] = String(fields[f] || '').trim().slice(0, 2000);
  if (!vals.goal) throw new Error('Please answer: what was your main goal this week?');
  if (!vals.action_taken) throw new Error('Please answer: what action did you actually take?');

  const now = Date.now();
  const existing = await getCheckin(clean, w);
  if (existing) {
    const sets = CHECKIN_FIELDS.map((f) => `${f} = ?`).join(', ');
    const params = CHECKIN_FIELDS.map((f) => vals[f]);
    if (proof) {
      await db.run(
        `UPDATE room_checkins SET ${sets}, proof_blob = ?, proof_name = ?, proof_mime = ?, proof_size = ? WHERE id = ?`,
        [...params, proof.buffer, proof.name, proof.mime, proof.size, existing.id]
      );
    } else {
      await db.run(`UPDATE room_checkins SET ${sets} WHERE id = ?`, [...params, existing.id]);
    }
    return getCheckinById(existing.id);
  }
  const cols = ['email', 'week', 'created_at', ...CHECKIN_FIELDS];
  const params = [clean, w, now, ...CHECKIN_FIELDS.map((f) => vals[f])];
  let proofCols = '';
  if (proof) {
    cols.push('proof_blob', 'proof_name', 'proof_mime', 'proof_size');
    params.push(proof.buffer, proof.name, proof.mime, proof.size);
    proofCols = '';
  }
  const placeholders = cols.map(() => '?').join(', ');
  const r = await db.run(`INSERT INTO room_checkins (${cols.join(', ')}) VALUES (${placeholders})${proofCols}`, params);
  return getCheckinById(r.lastInsertRowid);
}

async function getReview(email) {
  const clean = cleanEmail(email);
  if (!clean) return null;
  return db.get('SELECT * FROM room_reviews WHERE email = ?', [clean]);
}

const REVIEW_FIELDS = [
  'original_goal', 'accomplished', 'actions_taken', 'learned',
  'changed', 'didnt_work', 'do_differently', 'next_goal',
];

/** Insert or update the member's 90-day review (one per member). */
async function saveReview(email, fields = {}) {
  const clean = cleanEmail(email);
  if (!clean) throw new Error('Email is required.');
  const vals = {};
  for (const f of REVIEW_FIELDS) vals[f] = String(fields[f] || '').trim().slice(0, 4000);
  const now = Date.now();
  const existing = await getReview(clean);
  const sets = REVIEW_FIELDS.map((f) => `${f} = ?`).join(', ');
  const params = REVIEW_FIELDS.map((f) => vals[f]);
  if (existing) {
    await db.run(`UPDATE room_reviews SET ${sets} WHERE email = ?`, [...params, clean]);
  } else {
    await db.run(
      `INSERT INTO room_reviews (email, created_at, ${REVIEW_FIELDS.join(', ')}) VALUES (?, ?, ${REVIEW_FIELDS.map(() => '?').join(', ')})`,
      [clean, now, ...params]
    );
  }
  return getReview(clean);
}

/**
 * Accountability stats for the 12-week tracker: completed weeks, current
 * streak (consecutive checked-in weeks ending at the current or previous
 * week — never shaming a missed week), last check-in, and the latest
 * accomplishment / lesson / next commitment.
 */
async function progressStats(email) {
  const clean = cleanEmail(email);
  const checkins = await listCheckins(clean);
  const info = await weekInfo(clean);
  const weeksDone = checkins.map((c) => Number(c.week)).sort((a, b) => a - b);
  const doneSet = new Set(weeksDone);
  const currentWeek = info ? info.currentWeek : ACCOUNTABILITY_WEEKS;

  let streak = 0;
  // A streak counts back from the current week; if this week isn't done yet,
  // it can still continue from last week (missing a week simply ends it —
  // no punishment, just a fresh start next week).
  let w = doneSet.has(currentWeek) ? currentWeek : currentWeek - 1;
  while (w >= 1 && doneSet.has(w)) {
    streak++;
    w--;
  }

  const lastCheckin = checkins.length ? checkins[checkins.length - 1] : null;
  return {
    totalCheckins: checkins.length,
    weeksDone,
    currentStreak: streak,
    lastCheckin,
    latestAccomplishment: lastCheckin ? lastCheckin.accomplishment : null,
    latestLesson: lastCheckin ? lastCheckin.lesson : null,
    latestNextCommitment: lastCheckin ? lastCheckin.next_commitment : null,
  };
}

/** One-row accountability summary per member for the admin dashboard. */
async function accountabilitySummary(email) {
  const clean = cleanEmail(email);
  const [member, goal, stats, review] = await Promise.all([
    getMember(clean),
    getGoal(clean),
    progressStats(clean),
    getReview(clean),
  ]);
  const info = goal ? await weekInfo(clean) : null;
  const currentWeek = info ? info.currentWeek : null;
  const thisWeek = currentWeek ? await getCheckin(clean, currentWeek) : null;
  return {
    email: clean,
    name: member ? member.name : null,
    status: member ? member.status : null,
    claimed: !!(member && member.password_hash),
    goalText: goal ? goal.goal_text : null,
    startDate: goal ? Number(goal.start_date) : null,
    targetDate: goal ? Number(goal.target_date) : null,
    currentWeek,
    totalCheckins: stats.totalCheckins,
    checkedInThisWeek: !!thisWeek,
    currentStreak: stats.currentStreak,
    lastCheckinAt: stats.lastCheckin ? Number(stats.lastCheckin.created_at) : null,
    proofUploaded: stats.lastCheckin ? !!stats.lastCheckin.has_proof : false,
    latestAccomplishment: stats.latestAccomplishment,
    latestLesson: stats.latestLesson,
    latestNextCommitment: stats.latestNextCommitment,
    reviewDone: !!review,
  };
}

// --- Content loading (mtime cache; Davena edits files, no restart needed) -------
const contentCache = {}; // key -> { mtimeMs, data }
function readCached(key, file, parse) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = contentCache[key];
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  const raw = fs.readFileSync(file, 'utf8');
  const data = parse(raw);
  contentCache[key] = { mtimeMs: stat.mtimeMs, data };
  return data;
}

/** Minimal markdown -> HTML for lesson files. Headings, bold, italic,
 *  blockquotes, ordered/unordered lists, paragraphs. Escapes everything else. */
function mdToHtml(md) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = String(md).split('\n');
  let html = '';
  let listTag = null;
  const closeList = () => {
    if (listTag) {
      html += `</${listTag}>`;
      listTag = null;
    }
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      closeList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)/.exec(t);
    if (h) {
      closeList();
      html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`;
      continue;
    }
    if (t.startsWith('>')) {
      closeList();
      html += `<blockquote>${inline(t.replace(/^>\s?/, ''))}</blockquote>`;
      continue;
    }
    const ul = /^[-*]\s+(.*)/.exec(t);
    const ol = /^\d+[.)]\s+(.*)/.exec(t);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      const text = ul ? ul[1] : ol[1];
      if (listTag !== tag) {
        closeList();
        html += `<${tag}>`;
        listTag = tag;
      }
      html += `<li>${inline(text)}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inline(t)}</p>`;
  }
  closeList();
  return html;
}

/** Return the markdown file list for a pillar/section, supporting both the
 *  older `file: 'name'` form and the newer `files: [...]` form. */
function pillarFiles(pillar) {
  if (Array.isArray(pillar.files) && pillar.files.length) return pillar.files;
  if (pillar.file) return [pillar.file];
  return [];
}

function getPillar(pillarId) {
  const pillar = PILLARS.find((p) => p.id === pillarId || p.slug === pillarId);
  if (!pillar) return null;
  const files = pillarFiles(pillar);
  const cacheKey = `lesson:${pillar.id}`;
  // mtime-aware: cache entry stores the newest mtime across all files.
  let html = null;
  const parts = [];
  let missing = false;
  for (const name of files) {
    const file = path.join(LESSONS_DIR, `${name}.md`);
    const part = readCached(`${cacheKey}:${name}`, file, (raw) => mdToHtml(raw));
    if (part == null) {
      missing = true;
      break;
    }
    parts.push(part);
  }
  if (missing || parts.length === 0) return null;
  html = parts.join('\n<hr>\n');
  return { ...pillar, html };
}

function getPillars() {
  return PILLARS.map((p) => ({ ...p, available: pillarFiles(p).some((name) => fs.existsSync(path.join(LESSONS_DIR, `${name}.md`))) }));
}

function getPlan() {
  try {
    const plan = readCached('plan', PLAN_FILE, (raw) => JSON.parse(raw));
    if (!plan || !Array.isArray(plan.weeks)) return { weeks: [] };
    return plan;
  } catch (err) {
    console.warn('[room] plan.json is not valid JSON — showing empty plan:', err.message);
    return { weeks: [] };
  }
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  PILLARS,
  PILLAR_REDIRECTS,
  hashPassword,
  verifyPassword,
  getMember,
  upsertMemberFromPurchase,
  setMemberPassword,
  setMemberStatus,
  createSession,
  getSessionMember,
  destroySession,
  getProgress,
  setProgress,
  getGoal,
  saveGoal,
  weekInfo,
  getCheckin,
  getCheckinById,
  listCheckins,
  saveCheckin,
  getReview,
  saveReview,
  progressStats,
  accountabilitySummary,
  ACCOUNTABILITY_WEEKS,
  listPosts,
  getPost,
  listComments,
  createPost,
  createComment,
  setPinned,
  deletePost,
  deleteComment,
  getPillar,
  getPillars,
  getPlan,
  mdToHtml,
};
