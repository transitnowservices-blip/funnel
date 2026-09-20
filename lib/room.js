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
