'use strict';
/**
 * views/room.js — HTML for The Wealth Builder's Room membership area.
 * The Room has its own branding (separate from the TransitNow funnel pages).
 * All user content is escaped. No income promises anywhere.
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function displayName(memberOrPost) {
  if (!memberOrPost) return 'Member';
  if (memberOrPost.kind === 'announcement') return 'Davena';
  return memberOrPost.name || memberOrPost.author_name || String(memberOrPost.email || memberOrPost.author_email || 'Member').split('@')[0];
}

function roomLayout({ title, member, body }) {
  const nav = member
    ? `<nav class="room-nav">
        <a href="/room">Dashboard</a>
        <a href="/room/classroom">Classroom</a>
        <a href="/room/plan">90-Day Plan</a>
        <a href="/room/progress">My Progress</a>
        <a href="/room/community">Community</a>
        <a href="/room/logout" class="logout">Log out</a>
      </nav>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | The Wealth Builder's Room</title>
<style>
:root{--ink:#1c2430;--gold:#b8860b;--gold-soft:#f7ecd2;--bg:#faf8f3;--card:#ffffff;--muted:#6b7280;--line:#e7e0d2}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.6}
.room-header{background:#1c2430;color:#fff;padding:18px 20px}
.room-header .brand{font-size:20px;font-weight:800;letter-spacing:.02em}
.room-header .brand span{color:var(--gold)}
.room-header .who{font-size:13px;color:#cbd5e1;margin-top:4px}
.room-nav{background:#2b3648;padding:10px 20px;display:flex;gap:18px;flex-wrap:wrap}
.room-nav a{color:#f3e9cf;text-decoration:none;font-weight:600;font-size:15px}
.room-nav a:hover{color:#fff}
.room-nav .logout{margin-left:auto;color:#f3b4b4}
.container{max-width:860px;margin:0 auto;padding:24px 20px 64px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.04)}
h1{font-size:28px;margin:.2em 0 .4em}
h2{font-size:22px;margin:1.2em 0 .4em}
h3{font-size:17px;margin:1em 0 .3em}
p{margin:.6em 0}
.muted{color:var(--muted);font-size:14px}
.btn{display:inline-block;background:#1c2430;color:#fff;border:none;border-radius:8px;padding:12px 22px;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer}
.btn-gold{background:var(--gold);color:#1c2430}
.btn-small{padding:8px 14px;font-size:14px}
.btn-danger{background:#b91c1c}
.form label{display:block;font-weight:600;margin:12px 0 4px}
.form input[type=text],.form input[type=email],.form input[type=password],.form textarea{width:100%;min-height:48px;padding:10px 12px;border:1px solid #b9b2a2;border-radius:8px;font-size:16px;font-family:inherit}
.form textarea{min-height:120px;resize:vertical}
.error{background:#fef2f2;border:1px solid #f5b4b4;color:#991b1b;border-radius:8px;padding:12px;margin:12px 0}
.notice{background:#f0fdf4;border:1px solid #a7d8b5;color:#166534;border-radius:8px;padding:12px;margin:12px 0}
.pillar-grid{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:640px){.pillar-grid{grid-template-columns:1fr 1fr}}
.pillar-card{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;text-decoration:none;color:inherit}
.pillar-card:hover{border-color:var(--gold)}
.pillar-card h3{margin:.1em 0;color:#1c2430}
.pillar-num{font-size:12px;font-weight:800;color:var(--gold);text-transform:uppercase;letter-spacing:.08em}
.lesson-body h2{color:#1c2430;border-bottom:2px solid var(--gold-soft);padding-bottom:6px}
.lesson-body blockquote{border-left:4px solid var(--gold);margin:16px 0;padding:8px 16px;background:var(--gold-soft);border-radius:0 8px 8px 0;font-style:italic}
.lesson-body ul,.lesson-body ol{padding-left:24px}
.progress-wrap{background:#e9e2d2;border-radius:8px;height:22px;overflow:hidden;margin:12px 0}
.progress-fill{background:var(--gold);height:100%;transition:width .3s}
.week{border:1px solid var(--line);border-radius:10px;margin:12px 0;overflow:hidden}
.week-head{background:#1c2430;color:#fff;padding:10px 16px;font-weight:700}
.week-head .focus{font-weight:400;font-size:13px;color:#d8c98f;margin-left:8px}
.week-body{padding:6px 16px 12px}
.check-item{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px dashed var(--line)}
.check-item:last-child{border-bottom:none}
.check-item input{width:22px;height:22px;margin-top:2px;flex:none}
.check-item.done label{text-decoration:line-through;color:var(--muted)}
.post{border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0;background:var(--card)}
.post.announcement{border:2px solid var(--gold);background:#fffdf5}
.post .meta{font-size:13px;color:var(--muted);margin-bottom:6px}
.post .title{font-size:18px;font-weight:700;margin:0 0 6px}
.post .title a{color:inherit;text-decoration:none}
.badge{display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;background:var(--gold);color:#1c2430;border-radius:4px;padding:2px 8px;margin-right:8px}
.badge.pin{background:#1c2430;color:#f3e9cf}
.comment{border-top:1px solid var(--line);padding:12px 0}
.comment .meta{font-size:12px;color:var(--muted)}
.admin-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
.admin-table th,.admin-table td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top}
.admin-table th{background:#1c2430;color:#fff}
.inline-form{display:inline}
.inline-form button{margin:2px}
.room-footer{text-align:center;color:var(--muted);font-size:13px;padding:32px 20px}
.goal-banner{background:#1c2430;color:#f3e9cf;border-radius:10px;padding:14px 18px;margin:14px 0}
.goal-banner .label{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--gold)}
.goal-banner .text{font-size:18px;font-weight:700;margin:4px 0}
.week-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}
@media(min-width:640px){.week-grid{grid-template-columns:repeat(6,1fr)}}
.week-cell{border:2px solid var(--line);border-radius:10px;padding:10px 6px;text-align:center;font-weight:700;font-size:14px;background:var(--card)}
.week-cell.done{border-color:#166534;background:#f0fdf4;color:#166534}
.week-cell.current{border-color:var(--gold);background:var(--gold-soft)}
.week-cell .sub{display:block;font-size:11px;font-weight:400;color:var(--muted)}
.stat-row{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;flex:1 1 140px}
.stat .num{font-size:22px;font-weight:800;color:#1c2430}
.stat .lbl{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.proof-warn{background:#fffbeb;border:1px solid #f5c86e;border-radius:8px;padding:12px;margin:12px 0;font-size:14px}
.mantra{text-align:center;font-size:20px;font-weight:800;letter-spacing:.06em;color:var(--gold);margin:24px 0 8px}
.form input[type=file]{width:100%;padding:10px 0;font-size:15px}
.form input[type=checkbox].chk{width:22px;height:22px;vertical-align:middle;margin-right:8px}
.checkline{display:flex;gap:10px;align-items:flex-start;margin:12px 0;font-size:15px}
.disclaimer{font-size:13px;color:var(--muted);border-top:1px solid var(--line);margin-top:32px;padding-top:16px;font-style:italic}
</style>
</head>
<body>
<header class="room-header">
  <div class="brand">The Wealth Builder's <span>Room</span></div>
  ${member ? `<div class="who">Welcome back, ${esc(displayName(member))}</div>` : `<div class="who">Turn ideas, skills &amp; opportunities into income, businesses &amp; wealth.</div>`}
</header>
${nav}
<main class="container">
${body}
<p class="disclaimer">The Wealth Builder's Room is an educational community. Nothing here is financial, legal, tax, or investment advice, and no income, earnings, or specific results are promised or guaranteed. Your results depend on your own effort, decisions, and circumstances.</p>
</main>
<footer class="room-footer">The Wealth Builder's Room &middot; $49/month membership</footer>
</body>
</html>`;
}

// --- Auth pages ------------------------------------------------------------------
function loginPage({ error, email }) {
  return roomLayout({
    title: 'Member Login',
    member: null,
    body: `<h1>Member Login</h1>
${error ? `<div class="error">${esc(error)}</div>` : ''}
<div class="card">
<form method="POST" action="/room/login" class="form">
  <label for="email">Email (the one you paid with)</label>
  <input type="email" id="email" name="email" required value="${esc(email || '')}" autocomplete="email">
  <label for="password">Password</label>
  <input type="password" id="password" name="password" required autocomplete="current-password">
  <p><button type="submit" class="btn">Log In</button></p>
</form>
</div>
<p class="muted">Paid but haven't set your password yet? <a href="/room/claim">Claim your access</a>.</p>`,
  });
}

function claimPage({ error, email, notice }) {
  return roomLayout({
    title: 'Claim Your Access',
    member: null,
    body: `<h1>Claim Your Access</h1>
<p>Paid your $49/month membership with Stripe? Enter the email you paid with and choose a password to unlock the Room.</p>
${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
${error ? `<div class="error">${esc(error)}</div>` : ''}
<div class="card">
<form method="POST" action="/room/claim" class="form">
  <label for="email">Email you paid with</label>
  <input type="email" id="email" name="email" required value="${esc(email || '')}" autocomplete="email">
  <label for="password">Choose a password (8+ characters)</label>
  <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
  <label for="password2">Confirm password</label>
  <input type="password" id="password2" name="password2" required minlength="8" autocomplete="new-password">
  <p><button type="submit" class="btn btn-gold">Claim My Access</button></p>
</form>
</div>
<p class="muted">Already claimed? <a href="/room/login">Log in</a>.</p>`,
  });
}

// --- Dashboard ----------------------------------------------------------------------
function dashboardPage({ member, progress, announcements, goal, weekInfo, checkinDone }) {
  const pct = progress.pct;
  const ann = (announcements || [])
    .map(
      (a) => `<div class="post announcement"><div class="meta"><span class="badge">Announcement</span>${esc(fmtDateTime(a.created_at))}</div>
      ${a.title ? `<div class="title">${esc(a.title)}</div>` : ''}<div>${esc(a.body).replace(/\n/g, '<br>')}</div></div>`
    )
    .join('');
  const goalCard = goal
    ? `<div class="card">
        <h2 style="margin-top:0">My 90-Day Wealth Goal</h2>
        <p style="font-size:17px"><strong>${esc(goal.goal_text)}</strong></p>
        <p class="muted">Week ${weekInfo ? weekInfo.currentWeek : '—'} of 12 &middot; Target: ${weekInfo ? esc(fmtDate(weekInfo.targetDate)) : '—'}</p>
        <p><a class="btn btn-small" href="/room/goal">View / Edit Goal</a>
        ${checkinDone
          ? `<span class="notice" style="display:inline-block;margin:0 0 0 8px;padding:8px 14px">This week's check-in is done ✓</span>`
          : ` <a class="btn btn-small btn-gold" href="/room/checkin">Complete This Week's Check-In</a>`}</p>
      </div>`
    : `<div class="card" style="border:2px solid var(--gold)">
        <h2 style="margin-top:0">Set Your 90-Day Wealth Goal</h2>
        <p>Everything in the Room runs on one clear goal. Take two minutes and set yours now — your 12-week accountability clock starts today.</p>
        <p><a class="btn btn-gold" href="/room/goal">Set My 90-Day Goal &rarr;</a></p>
      </div>`;
  return roomLayout({
    title: 'Dashboard',
    member,
    body: `<h1>Your Wealth-Building Headquarters</h1>
${goalCard}
<div class="card">
  <h2 style="margin-top:0">90-Day Wealth Action Plan</h2>
  <p class="muted">${progress.done} of ${progress.total} actions complete</p>
  <div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>
  <p><a class="btn btn-gold" href="/room/plan">Continue the Plan</a> <a class="btn btn-small" href="/room/progress">My Progress Tracker</a></p>
</div>
<div class="pillar-grid">
  <a class="pillar-card" href="/room/classroom"><span class="pillar-num">Learn</span><h3>The Classroom</h3><p class="muted">5 wealth-building sections, step-by-step lessons.</p></a>
  <a class="pillar-card" href="/room/community"><span class="pillar-num">Connect</span><h3>Community</h3><p class="muted">Ask questions, share wins, learn together.</p></a>
</div>
${ann ? `<h2>Announcements</h2>${ann}` : ''}`,
  });
}

// --- Classroom -------------------------------------------------------------------------
function classroomIndexPage({ member, pillars }) {
  const cards = pillars
    .map(
      (p, i) => `<a class="pillar-card" href="/room/classroom/${esc(p.id)}">
        <span class="pillar-num">Section ${i + 1}</span><h3>${esc(p.title)}</h3><p class="muted">${esc(p.tagline)}</p></a>`
    )
    .join('');
  return roomLayout({
    title: 'Classroom',
    member,
    body: `<h1>The Classroom</h1>
<p>Five sections, in order. Start with Section 1 and work your way through — each one builds on the last.</p>
<div class="pillar-grid">${cards}</div>`,
  });
}

function pillarPage({ member, pillar, index, prev, next }) {
  return roomLayout({
    title: pillar.title,
    member,
    body: `<p><a href="/room/classroom">&larr; All sections</a></p>
<p class="pillar-num">Section ${index + 1} of 5</p>
<div class="card lesson-body">${pillar.html}</div>
<div class="card" style="border:2px solid var(--gold);background:#fffdf5;text-align:center">
  <h2 style="margin-top:0">NOW PUT IT INTO ACTION.</h2>
  <p>Learning only counts when it turns into action. Document what you did this week in your check-in:</p>
  <p style="font-weight:700;letter-spacing:.04em">LEARN &darr; APPLY &darr; DOCUMENT &darr; REFLECT &darr; MOVE FORWARD</p>
  <p><a class="btn btn-gold" href="/room/checkin">Complete My Weekly Check-In &rarr;</a></p>
</div>
<p>${prev ? `<a class="btn btn-small" href="/room/classroom/${esc(prev.id)}">&larr; ${esc(prev.title)}</a>` : ''}
${next ? ` <a class="btn btn-small btn-gold" href="/room/classroom/${esc(next.id)}">${esc(next.title)} &rarr;</a>` : ''}</p>`,
  });
}

// --- Welcome (first-run onboarding; POSTs to /room/welcome) ---------------------
function welcomePage({ member }) {
  return roomLayout({
    title: 'Welcome',
    member,
    body: `<div class="notice" style="text-align:center;font-size:18px;font-weight:700;padding:20px">
  You're in. Welcome to the Wealth Builder's Room.</div>
<div class="card">
  <h1 style="margin-top:0">Here's what to do first</h1>
  <ol style="padding-left:24px">
    <li><strong>Start with 00 — Start Here.</strong> Five minutes on how the Room works — and what it's not.</li>
    <li><strong>Introduce yourself in the community.</strong> Who you are, where you're starting, and what you want the next 90 days to change.</li>
    <li><strong>Pick ONE 90-day goal.</strong> One outcome. Write it where you'll see it every day.</li>
    <li><strong>Check the 90-Day Plan.</strong> Twelve weeks of small actions — check off the first one today.</li>
  </ol>
  <p class="muted">Education, community, and accountability — no hype, and no promises of income or earnings. One checked-off action at a time.</p>
  <form method="POST" action="/room/welcome" class="form" style="text-align:center;margin-top:12px">
    <button type="submit" class="btn btn-gold" style="font-size:18px;padding:16px 34px">ENTER THE ROOM &rarr;</button>
  </form>
</div>`,
  });
}

// --- 90-day plan --------------------------------------------------------------------------
function planPage({ member, plan, progress }) {
  const total = plan.weeks.reduce((n, w) => n + w.actions.length, 0);
  const done = Object.values(progress).filter(Boolean).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const weeks = plan.weeks
    .map(
      (w, wi) => `<div class="week">
      <div class="week-head">Week ${wi + 1}: ${esc(w.title)}<span class="focus">${esc(w.focus)}</span></div>
      <div class="week-body">
        ${w.actions
          .map((a, ai) => {
            const checked = progress[`${wi + 1}:${ai}`];
            return `<form method="POST" action="/room/plan/toggle" class="check-item${checked ? ' done' : ''}">
              <input type="checkbox" name="checked" value="1"${checked ? ' checked' : ''} onchange="this.form.submit()" aria-label="${esc(a)}">
              <input type="hidden" name="week" value="${wi + 1}">
              <input type="hidden" name="item" value="${ai}">
              <label>${esc(a)}</label>
            </form>`;
          })
          .join('')}
      </div>
    </div>`
    )
    .join('');
  return roomLayout({
    title: '90-Day Wealth Action Plan',
    member,
    body: `<h1>Your 90-Day Wealth Action Plan</h1>
<p>Check off each action as you complete it. Your progress saves automatically.</p>
<div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>
<p class="muted">${done} of ${total} actions complete (${pct}%)</p>
${weeks}
<p class="muted">Tip: unchecking a box removes it from your progress.</p>`,
  });
}

// --- Accountability: 90-day goal ------------------------------------------------------
function goalBannerHtml(goal, info) {
  if (!goal) return '';
  return `<div class="goal-banner"><div class="label">My 90-Day Wealth Goal</div>
    <div class="text">${esc(goal.goal_text)}</div>
    <div class="muted" style="color:#cbd5e1">Week ${info ? info.currentWeek : '—'} of 12 &middot; Started ${esc(fmtDate(goal.start_date))} &middot; Target ${esc(fmtDate(goal.target_date))} &middot; <a href="/room/goal" style="color:#f3e9cf">Edit</a></div></div>`;
}

function goalPage({ member, goal, info, error }) {
  const isEdit = !!(goal && goal.goal_text);
  return roomLayout({
    title: 'My 90-Day Wealth Goal',
    member,
    body: `<h1>MY 90-DAY WEALTH GOAL</h1>
<p style="font-size:18px"><strong>What is the ONE thing you want to make meaningful progress on during your first 90 days?</strong></p>
<p class="muted">One goal. Not ten projects. This goal shows at the top of your Room experience and anchors every weekly check-in. You can edit the wording anytime — your start date and 12-week clock never move.</p>
${error ? `<div class="error">${esc(error)}</div>` : ''}
${goal && info ? `<div class="card"><p class="muted" style="margin:0">Started: <strong>${esc(fmtDate(goal.start_date))}</strong> &middot; Target date: <strong>${esc(fmtDate(goal.target_date))}</strong> &middot; You are in <strong>Week ${info.currentWeek} of 12</strong></p></div>` : ''}
<div class="card">
<form method="POST" action="/room/goal" class="form">
  <label for="goal_text">My 90-day goal</label>
  <textarea id="goal_text" name="goal_text" required maxlength="500" placeholder="Example: Launch my bookkeeping service and sign my first paying client.">${esc(goal ? goal.goal_text : '')}</textarea>
  <p><button type="submit" class="btn btn-gold">${isEdit ? 'Save Changes' : 'Set My Goal & Start My 90 Days'}</button></p>
</form>
</div>`,
  });
}

// --- Accountability: weekly Proof of Progress -----------------------------------------
const CHECKIN_QUESTIONS = [
  { name: 'goal', label: 'What was your main goal this week?' },
  { name: 'action_taken', label: 'What action did you actually take?' },
  { name: 'accomplishment', label: 'What did you accomplish?' },
  { name: 'lesson', label: 'What did you learn?' },
  { name: 'next_commitment', label: 'What is your ONE commitment for next week?' },
];

function checkinPage({ member, goal, info, existing, error, readonly }) {
  const week = info ? info.currentWeek : 1;
  const vals = existing || {};
  const fieldsHtml = CHECKIN_QUESTIONS.map((q) => `
    <label for="ci_${q.name}">${esc(q.label)}</label>
    <textarea id="ci_${q.name}" name="${q.name}" ${q.name === 'goal' || q.name === 'action_taken' ? 'required' : ''} maxlength="2000" placeholder="">${esc(vals[q.name] || '')}</textarea>`).join('');
  const proofBlock = existing && existing.proof_blob
    ? `<p class="notice">Proof uploaded: <a href="/room/proof/${existing.id}">${esc(existing.proof_name || 'View proof')}</a> (${esc(existing.proof_mime || '')})</p>`
    : '';
  const formHtml = readonly
    ? `<div class="notice">You've already completed this week's check-in. ${proofBlock} <a href="/room/checkin?edit=1">Update it</a> or <a href="/room/progress">view your progress</a>.</div>
       <div class="card">${CHECKIN_QUESTIONS.map((q) => `<h3>${esc(q.label)}</h3><p>${esc(vals[q.name] || '—').replace(/\n/g, '<br>')}</p>`).join('')}${proofBlock}</div>`
    : `<div class="card"><form method="POST" action="/room/checkin" enctype="multipart/form-data" class="form">
        ${fieldsHtml}
        <h3>Do you have proof of your progress?</h3>
        <p class="muted">Optional — a screenshot, photo, or document showing something you did. Proof doesn't have to mean money: a business page or offer you created, a customer you contacted, an application you submitted, an appointment you scheduled, a worksheet or course you completed, money you saved, a debt payment, research you did, a system you built — any measurable action counts.</p>
        <div class="proof-warn"><strong>Before you upload:</strong> Do not upload passwords, Social Security numbers, bank account numbers, credit card numbers, private client information, or other sensitive personal information. Crop or blur private information before uploading.</div>
        <label for="proof">Upload proof (optional — PNG, JPG, GIF, WebP, or PDF, up to 8 MB)</label>
        <input type="file" id="proof" name="proof" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf">
        <div class="checkline"><input type="checkbox" class="chk" id="proof_confirm" name="proof_confirm" value="1">
        <label for="proof_confirm" style="font-weight:400">I confirm that my uploaded proof does not contain sensitive personal information. (Required if you attach a file.)</label></div>
        <p><button type="submit" class="btn btn-gold">Submit My Weekly Check-In</button></p>
      </form></div>`;
  return roomLayout({
    title: 'Proof of Progress',
    member,
    body: `${goalBannerHtml(goal, info)}
<h1>PROOF OF PROGRESS</h1>
<p class="muted" style="font-weight:700;letter-spacing:.04em">Goal &rarr; Action &rarr; Proof &rarr; Lesson &rarr; Next Action</p>
<p>Week ${week} of 12. Be honest, not perfect — an honest week beats a perfect story every time.</p>
${error ? `<div class="error">${esc(error)}</div>` : ''}
${formHtml}`,
  });
}

// --- Accountability: 12-week progress tracker ------------------------------------------
function progressPage({ member, goal, info, stats, checkins, review, notice }) {
  const currentWeek = info ? info.currentWeek : 1;
  const doneSet = new Set((stats ? stats.weeksDone : []).map(Number));
  const cells = [];
  for (let w = 1; w <= 12; w++) {
    const cls = doneSet.has(w) ? 'done' : (w === currentWeek ? 'current' : '');
    const sub = doneSet.has(w) ? '✓ done' : (w === currentWeek ? 'this week' : 'week ' + w);
    cells.push(`<div class="week-cell ${cls}">Week ${w}<span class="sub">${sub}</span></div>`);
  }
  const remaining = 12 - (stats ? stats.totalCheckins : 0);
  const lastCi = stats ? stats.lastCheckin : null;
  const reviewCta = (currentWeek >= 12 || (stats && stats.totalCheckins >= 12)) && !review
    ? `<div class="card" style="border:2px solid var(--gold)"><h2 style="margin-top:0">Your 90 days are complete — reflect on them.</h2><p><a class="btn btn-gold" href="/room/review">Start My 90-Day Review &rarr;</a></p></div>`
    : (review ? `<p><a class="btn btn-small" href="/room/review">View My 90-Day Review</a></p>` : '');
  return roomLayout({
    title: 'My Progress',
    member,
    body: `${goalBannerHtml(goal, info)}
<h1>My 12-Week Progress</h1>
${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
<div class="week-grid">${cells.join('')}</div>
<div class="stat-row">
  <div class="stat"><div class="num">${currentWeek}</div><div class="lbl">Current week</div></div>
  <div class="stat"><div class="num">${stats ? stats.totalCheckins : 0}/12</div><div class="lbl">Check-ins completed</div></div>
  <div class="stat"><div class="num">${remaining}</div><div class="lbl">Remaining</div></div>
  <div class="stat"><div class="num">${stats ? stats.currentStreak : 0}</div><div class="lbl">Current streak (weeks)</div></div>
</div>
<div class="card">
  <h2 style="margin-top:0">Latest check-in ${lastCi ? `— Week ${lastCi.week} (${esc(fmtDateTime(lastCi.created_at))})` : ''}</h2>
  ${lastCi ? `
  <h3>Latest accomplishment</h3><p>${esc(lastCi.accomplishment || '—').replace(/\n/g, '<br>')}</p>
  <h3>Latest lesson</h3><p>${esc(lastCi.lesson || '—').replace(/\n/g, '<br>')}</p>
  <h3>Next commitment</h3><p>${esc(lastCi.next_commitment || '—').replace(/\n/g, '<br>')}</p>
  ${lastCi.has_proof ? `<p><a href="/room/proof/${lastCi.id}">View uploaded proof</a></p>` : '<p class="muted">No proof uploaded for this check-in.</p>'}
  ` : '<p class="muted">No check-ins yet. Your first one takes five minutes.</p>'}
  <p>${lastCi && lastCi.week === currentWeek
    ? '<a class="btn btn-small" href="/room/checkin">Update This Week\'s Check-In</a>'
    : '<a class="btn btn-gold" href="/room/checkin">Complete This Week\'s Check-In &rarr;</a>'}</p>
</div>
${reviewCta}
<p class="muted">Missed a week? That's fine — it happens to everyone. No punishment, no shame. Just pick up with the current week and keep moving. Consistency beats perfection.</p>
<p class="mantra">PROGRESS, NOT PERFECTION.</p>`,
  });
}

// --- Accountability: 90-day review -------------------------------------------------------
const REVIEW_QUESTIONS = [
  { name: 'original_goal', label: 'What was your original goal?' },
  { name: 'accomplished', label: 'What did you accomplish?' },
  { name: 'actions_taken', label: 'What actions did you take?' },
  { name: 'learned', label: 'What did you learn?' },
  { name: 'changed', label: 'What changed?' },
  { name: 'didnt_work', label: "What didn't work?" },
  { name: 'do_differently', label: 'What would you do differently?' },
  { name: 'next_goal', label: 'What is your next 90-day goal?' },
];

function reviewPage({ member, goal, info, review, error }) {
  const vals = review || {};
  if (!vals.original_goal && goal) vals.original_goal = goal.goal_text;
  const fieldsHtml = REVIEW_QUESTIONS.map((q) => `
    <label for="rv_${q.name}">${esc(q.label)}</label>
    <textarea id="rv_${q.name}" name="${q.name}" maxlength="4000">${esc(vals[q.name] || '')}</textarea>`).join('');
  return roomLayout({
    title: 'My 90-Day Wealth Review',
    member,
    body: `${goalBannerHtml(goal, info)}
<h1>MY 90-DAY WEALTH REVIEW</h1>
<p>Look back at your 90 days honestly — the wins, the misses, and the lessons. Then set your next target.</p>
${error ? `<div class="error">${esc(error)}</div>` : ''}
<div class="card"><form method="POST" action="/room/review" class="form">
${fieldsHtml}
<p><button type="submit" class="btn btn-gold">Save My 90-Day Review</button></p>
</form></div>`,
  });
}

function reviewSummaryPage({ member, goal, info, review, checkins }) {
  const journey = (checkins || []).map((c) => `
    <div class="post"><div class="meta">Week ${c.week} &middot; ${esc(fmtDateTime(c.created_at))}${c.has_proof ? ' &middot; proof uploaded' : ''}</div>
    <p><strong>Accomplished:</strong> ${esc(c.accomplishment || '—').replace(/\n/g, '<br>')}</p>
    <p><strong>Learned:</strong> ${esc(c.lesson || '—').replace(/\n/g, '<br>')}</p>
    <p><strong>Next commitment was:</strong> ${esc(c.next_commitment || '—').replace(/\n/g, '<br>')}</p></div>`).join('');
  return roomLayout({
    title: 'My 90-Day Review',
    member,
    body: `${goalBannerHtml(goal, info)}
<h1>MY 90-DAY WEALTH REVIEW</h1>
<div class="notice">Review saved. Here's your journey, all in one place.</div>
<div class="card">
${REVIEW_QUESTIONS.map((q) => `<h3>${esc(q.label)}</h3><p>${esc((review && review[q.name]) || '—').replace(/\n/g, '<br>')}</p>`).join('')}
</div>
<h2>Your weekly check-ins (${(checkins || []).length})</h2>
${journey || '<p class="muted">No check-ins recorded.</p>'}
<p><a class="btn btn-small" href="/room/review">Edit My Review</a> <a class="btn btn-small" href="/room/progress">Back to My Progress</a></p>`,
  });
}

// --- Community -----------------------------------------------------------------------------
function communityPage({ member, posts, error, notice }) {
  const items = posts
    .map(
      (p) => `<div class="post${p.kind === 'announcement' ? ' announcement' : ''}">
      <div class="meta">${p.pinned ? '<span class="badge pin">Pinned</span>' : ''}${
        p.kind === 'announcement' ? '<span class="badge">Announcement</span>' : ''
      }${esc(displayName(p))} &middot; ${esc(fmtDateTime(p.created_at))} &middot; ${Number(p.comment_count) || 0} ${
        Number(p.comment_count) === 1 ? 'reply' : 'replies'
      }</div>
      ${p.title ? `<div class="title"><a href="/room/community/post/${p.id}">${esc(p.title)}</a></div>` : ''}
      <div>${esc(p.body).slice(0, 400).replace(/\n/g, '<br>')}${p.body.length > 400 ? '…' : ''}</div>
      <p><a href="/room/community/post/${p.id}">Read &amp; reply &rarr;</a></p>
    </div>`
    )
    .join('');
  return roomLayout({
    title: 'Community',
    member,
    body: `<h1>Community</h1>
<p>Ask questions, share wins, and learn from each other. Be kind, be honest, no spam.</p>
${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
${error ? `<div class="error">${esc(error)}</div>` : ''}
<div class="card">
  <h2 style="margin-top:0">Start a discussion</h2>
  <form method="POST" action="/room/community/post" class="form">
    <label for="title">Title (optional)</label>
    <input type="text" id="title" name="title" maxlength="140" placeholder="What is this about?">
    <label for="body">Your post</label>
    <textarea id="body" name="body" required maxlength="5000" placeholder="Share a question, a win, or something you learned…"></textarea>
    <p><button type="submit" class="btn">Post</button></p>
  </form>
</div>
<h2>Discussions</h2>
${items || '<p class="muted">No discussions yet — start the first one above.</p>'}`,
  });
}

function postPage({ member, post, comments, error }) {
  const cmts = comments
    .map(
      (c) => `<div class="comment"><div class="meta">${esc(displayName(c))} &middot; ${esc(fmtDateTime(c.created_at))}</div>
      <div>${esc(c.body).replace(/\n/g, '<br>')}</div></div>`
    )
    .join('');
  return roomLayout({
    title: post.title || 'Discussion',
    member,
    body: `<p><a href="/room/community">&larr; Back to community</a></p>
<div class="post${post.kind === 'announcement' ? ' announcement' : ''}">
  <div class="meta">${post.pinned ? '<span class="badge pin">Pinned</span>' : ''}${
    post.kind === 'announcement' ? '<span class="badge">Announcement</span>' : ''
  }${esc(displayName(post))} &middot; ${esc(fmtDateTime(post.created_at))}</div>
  ${post.title ? `<div class="title">${esc(post.title)}</div>` : ''}
  <div>${esc(post.body).replace(/\n/g, '<br>')}</div>
</div>
<h2>Replies (${comments.length})</h2>
${cmts || '<p class="muted">No replies yet.</p>'}
${error ? `<div class="error">${esc(error)}</div>` : ''}
<div class="card">
  <h3 style="margin-top:0">Add a reply</h3>
  <form method="POST" action="/room/community/post/${post.id}/comment" class="form">
    <textarea name="body" required maxlength="2000" placeholder="Write your reply…"></textarea>
    <p><button type="submit" class="btn">Reply</button></p>
  </form>
</div>`,
  });
}

// --- Admin (rendered inside the existing admin layout) --------------------------------
function accountabilityHtml(summaries) {
  const rows = (summaries || [])
    .map((s) => `<tr>
      <td>${esc(s.email)}<br><span class="muted">${esc(s.name || '')}</span></td>
      <td>${s.currentWeek ? `Week ${s.currentWeek}/12` : '—'}</td>
      <td>${esc((s.goalText || '—').slice(0, 80))}${s.goalText && s.goalText.length > 80 ? '…' : ''}</td>
      <td>${s.totalCheckins}/12</td>
      <td>${s.checkedInThisWeek ? '<strong>Yes</strong>' : 'No'}</td>
      <td>${s.currentStreak}</td>
      <td>${esc(fmtDateTime(s.lastCheckinAt))}</td>
      <td>${s.proofUploaded ? 'Uploaded' : '—'}</td>
      <td>${esc((s.latestAccomplishment || '—').slice(0, 80))}</td>
      <td>${esc((s.latestLesson || '—').slice(0, 80))}</td>
      <td>${esc((s.latestNextCommitment || '—').slice(0, 80))}</td>
      <td>${s.reviewDone ? '<strong>Done</strong>' : '—'}</td>
    </tr>`)
    .join('');
  const eligible = (summaries || []).filter((s) => s.status === 'active' && s.claimed && s.goalText);
  const inThisWeek = eligible.filter((s) => s.checkedInThisWeek);
  const notThisWeek = eligible.filter((s) => !s.checkedInThisWeek);
  const li = (s) => `<li>${esc(s.email)} — Week ${s.currentWeek}/12, ${s.totalCheckins}/12 check-ins, streak ${s.currentStreak}</li>`;
  return `<h2>Accountability</h2>
<p class="muted">Personal accountability only — members are never ranked or compared against each other. Each member only ever sees their own data.</p>
<div style="overflow-x:auto"><table class="admin-table"><thead><tr>
<th>Member</th><th>Current week</th><th>90-day goal</th><th>Check-ins</th><th>Checked in this week</th><th>Streak</th><th>Last check-in</th><th>Proof</th><th>Latest accomplishment</th><th>Latest lesson</th><th>Next commitment</th><th>90-day review</th>
</tr></thead><tbody>${rows || '<tr><td colspan="12">No members yet.</td></tr>'}</tbody></table></div>
<h3>Checked in this week (${inThisWeek.length})</h3>
${inThisWeek.length ? `<ul>${inThisWeek.map(li).join('')}</ul>` : '<p class="muted">None yet this week.</p>'}
<h3>Not checked in this week (${notThisWeek.length})</h3>
${notThisWeek.length ? `<ul>${notThisWeek.map(li).join('')}</ul>` : '<p class="muted">Everyone with a goal has checked in. 🎉</p>'}`;
}

function roomAdminPage({ members, posts, accountability }) {
  const mrows = (members || [])
    .map(
      (m) => `<tr>
      <td>${esc(m.email)}</td><td>${esc(m.name || '—')}</td>
      <td>${esc(fmtDate(m.joined_at))}</td><td>${esc(fmtDateTime(m.last_login))}</td>
      <td>${m.password_hash ? 'claimed' : 'not claimed'}</td>
      <td>${esc(m.status)}</td>
      <td><form method="POST" action="/admin/room/member-status" class="inline-form">
        <input type="hidden" name="email" value="${esc(m.email)}">
        <input type="hidden" name="status" value="${m.status === 'active' ? 'inactive' : 'active'}">
        <button type="submit" class="btn-small btn">${m.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
      </form></td>
    </tr>`
    )
    .join('');
  const prows = (posts || [])
    .map(
      (p) => `<tr>
      <td>${p.id}</td>
      <td>${p.kind === 'announcement' ? '<strong>Announcement</strong>' : 'Post'}${p.pinned ? ' · <strong>pinned</strong>' : ''}</td>
      <td>${esc(p.title || '(no title)')}</td>
      <td>${esc(displayName(p))}</td>
      <td>${esc(fmtDateTime(p.created_at))}</td>
      <td>
        <form method="POST" action="/admin/room/pin" class="inline-form">
          <input type="hidden" name="id" value="${p.id}">
          <input type="hidden" name="pinned" value="${p.pinned ? '0' : '1'}">
          <button type="submit" class="btn-small btn">${p.pinned ? 'Unpin' : 'Pin'}</button>
        </form>
        <form method="POST" action="/admin/room/delete-post" class="inline-form" onsubmit="return confirm('Delete this post and all its replies?')">
          <input type="hidden" name="id" value="${p.id}">
          <button type="submit" class="btn-small btn btn-danger">Delete</button>
        </form>
      </td>
    </tr>`
    )
    .join('');
  return `<h2>Members (${(members || []).length})</h2>
<table class="admin-table"><thead><tr>
<th>Email</th><th>Name</th><th>Joined</th><th>Last login</th><th>Access</th><th>Status</th><th>Action</th>
</tr></thead><tbody>${mrows || '<tr><td colspan="7">No members yet.</td></tr>'}</tbody></table>

${accountabilityHtml(accountability)}

<h2>Add a member</h2>
<form method="POST" action="/admin/room/add-member" class="form" style="max-width:640px">
  <label for="memail">Email</label>
  <input type="email" id="memail" name="email" required>
  <label for="mname">Name (optional)</label>
  <input type="text" id="mname" name="name" maxlength="120">
  <p><button type="submit" class="btn">Add member</button></p>
</form>
<h2>Post an announcement</h2>
<form method="POST" action="/admin/room/announce" class="form" style="max-width:640px">
  <label for="atitle">Title (optional)</label>
  <input type="text" id="atitle" name="title" maxlength="140">
  <label for="abody">Announcement</label>
  <textarea id="abody" name="body" required maxlength="5000"></textarea>
  <p><button type="submit" class="btn">Post announcement</button></p>
</form>

<h2>Community posts (${(posts || []).length})</h2>
<table class="admin-table"><thead><tr>
<th>ID</th><th>Type</th><th>Title</th><th>Author</th><th>Posted</th><th>Actions</th>
</tr></thead><tbody>${prows || '<tr><td colspan="6">No posts yet.</td></tr>'}</tbody></table>
<p class="muted">Lesson content: edit the Markdown files in <code>content/room/lessons/</code> (one per pillar) and the 90-day plan in <code>content/room/plan.json</code>. Changes go live on the next page load — no restart needed.</p>`;
}

module.exports = {
  esc,
  roomLayout,
  loginPage,
  claimPage,
  dashboardPage,
  classroomIndexPage,
  pillarPage,
  welcomePage,
  planPage,
  goalPage,
  goalBannerHtml,
  checkinPage,
  progressPage,
  reviewPage,
  reviewSummaryPage,
  accountabilityHtml,
  communityPage,
  postPage,
  roomAdminPage,
};
