#!/usr/bin/env node
/*
 * Minimal additive test for the free bid-alert lead magnet (/free-bid).
 *
 * 1. Spawns `node server.js` on port 3222 (ADMIN_TOKEN=test-freebid,
 *    EMAIL_PROVIDER=local) and waits for /healthz.
 * 2. GET /free-bid -> 200, gate headline + email form present.
 * 3. POST /free-bid with a bad email -> 400 with the validation message.
 * 4. POST /free-bid with a fresh email -> 302 to /free-bid/show + cookie.
 * 5. GET /free-bid/show (with cookie) -> 200, bid card + Basic/Complete
 *    pitch + no-guarantee copy.
 * 6. GET /free-bid/show (no cookie) -> 302 to /free-bid.
 * 7. GET /free-bid (with cookie) -> 302 to /free-bid/show (gate skip).
 * 8. DB: lead row has source 'free-bid'.
 * 9. Existing-lead path: set a first_name on the lead, POST again ->
 *    first_name and source are NOT overwritten.
 * 10. Cleans up the test lead rows, kills the server.
 *
 * Only node built-ins + node:sqlite + global fetch. Exits non-zero on failure.
 */
'use strict';

const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = path.join(__dirname, '..');
const PORT = 3222;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(APP_ROOT, 'data', 'funnel.db');
const TEST_EMAIL = 'freebid-test@example.com';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`PASS: ${name}`); }
  else { failures++; console.log(`FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

async function waitForHealth(child) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode != null) return false;
  }
  return false;
}

async function main() {
  const child = spawn('node', ['server.js'], {
    cwd: APP_ROOT,
    env: { ...process.env, ADMIN_TOKEN: 'test-freebid', PORT: String(PORT), EMAIL_PROVIDER: 'local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  const kill = () => { try { child.kill('SIGTERM'); } catch (e) {} };

  try {
    if (!(await waitForHealth(child))) {
      console.log('FAIL: server did not become healthy');
      console.log(serverLog.slice(-2000));
      kill();
      process.exit(1);
    }

    const jar = {};
    const req = async (url, { method = 'GET', form = null, cookie = true } = {}) => {
      const headers = {};
      if (cookie && Object.keys(jar).length) {
        headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      }
      let body;
      if (form) {
        body = new URLSearchParams(form).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      const r = await fetch(url, { method, headers, body, redirect: 'manual' });
      const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const m = /^([^=]+)=([^;]*)/.exec(sc);
        if (m) jar[m[1]] = decodeURIComponent(m[2]);
      }
      const text = await r.text();
      return { status: r.status, text, location: r.headers.get('location') };
    };

    // 2. Gate renders
    let r = await req(`${BASE}/free-bid`, { cookie: false });
    check('GET /free-bid -> 200', r.status === 200, `got ${r.status}`);
    check('gate headline present', r.text.includes('Get a free Milwaukee bid alert'));
    check('gate email form present', r.text.includes('action="/free-bid"') && r.text.includes('name="email"'));
    check('consent unchecked by default', /name="marketing_consent"[^>]*>/.test(r.text) && !/name="marketing_consent"[^>]*checked/.test(r.text));

    // 3. Invalid email
    r = await req(`${BASE}/free-bid`, { method: 'POST', form: { email: 'not-an-email' }, cookie: false });
    check('POST /free-bid bad email -> 400', r.status === 400, `got ${r.status}`);
    check('validation message shown', r.text.includes('Please enter a valid email address.'));

    // 4. Valid email -> redirect + cookie
    r = await req(`${BASE}/free-bid`, { method: 'POST', form: { email: TEST_EMAIL }, cookie: false });
    check('POST /free-bid good email -> 302', r.status === 302, `got ${r.status}`);
    check('redirects to /free-bid/show', r.location === '/free-bid/show', `got ${r.location}`);
    check('email cookie set', !!jar.tn_freebid_email);

    // 5. Show page with cookie
    r = await req(`${BASE}/free-bid/show`);
    check('GET /free-bid/show -> 200', r.status === 200, `got ${r.status}`);
    check('bid card present', r.text.includes('Your free bid alert') && r.text.includes('status-badge'));
    check('Basic/Complete pitch present', r.text.includes('Basic — $50/mo') && r.text.includes('Complete — $100/mo'));
    check('pitch links to /grow', r.text.includes('href="/grow"'));
    check('no-guarantee copy present', r.text.includes('does not promise or guarantee'));

    // 6. Show page without cookie -> gate
    r = await req(`${BASE}/free-bid/show`, { cookie: false });
    check('GET /free-bid/show no cookie -> 302 to /free-bid', r.status === 302 && r.location === '/free-bid', `got ${r.status} ${r.location}`);

    // 7. Gate with cookie -> skips to show
    r = await req(`${BASE}/free-bid`);
    check('GET /free-bid with cookie -> 302 to /free-bid/show', r.status === 302 && r.location === '/free-bid/show', `got ${r.status} ${r.location}`);

    // 8. DB: lead source tag
    const db = new DatabaseSync(DB_PATH);
    let lead = db.prepare('SELECT * FROM opportunity_leads WHERE email = ? AND lead_type = ?').get(TEST_EMAIL, 'GROW');
    check('lead row created', !!lead);
    check("lead source is 'free-bid'", lead && lead.source === 'free-bid', `got ${lead && lead.source}`);

    // 9. Existing-lead path: must not overwrite name/source
    db.prepare('UPDATE opportunity_leads SET first_name = ?, source = ? WHERE id = ?').run('DoNotOverwrite', 'original-source', lead.id);
    r = await req(`${BASE}/free-bid`, { method: 'POST', form: { email: TEST_EMAIL, marketing_consent: '1' }, cookie: false });
    check('re-POST existing email -> 302', r.status === 302, `got ${r.status}`);
    lead = db.prepare('SELECT * FROM opportunity_leads WHERE id = ?').get(lead.id);
    check('existing lead first_name preserved', lead.first_name === 'DoNotOverwrite', `got ${lead.first_name}`);
    check('existing lead source preserved', lead.source === 'original-source', `got ${lead.source}`);
    check('marketing consent recorded', Number(lead.marketing_consent) === 1);

    // 10. Cleanup test rows
    const lid = lead.id;
    for (const t of ['lead_sources', 'lead_status_history', 'lead_communications', 'opportunity_lead_tags']) {
      try { db.prepare(`DELETE FROM ${t} WHERE lead_id = ?`).run(lid); } catch (e) { /* table may not exist */ }
    }
    db.prepare('DELETE FROM opportunity_leads WHERE id = ?').run(lid);
    const gone = db.prepare('SELECT id FROM opportunity_leads WHERE id = ?').get(lid);
    check('test lead cleaned up', !gone);
    db.close();
  } finally {
    kill();
  }

  if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
  console.log('\nAll free-bid tests passed.');
}

main().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
