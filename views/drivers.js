'use strict';
/**
 * views/drivers.js — driver-facing pages for the TransitNow Driver
 * Operations Platform. Mobile-first markup; inner <main> content only —
 * the backend wraps it with views/layout.js. Reuses the site's existing
 * CSS classes (.form, .btn, .card, .hint, .microcopy, .form-error).
 *
 * No income or results promises anywhere in this copy.
 */
const { esc } = require('./layout');
const drivers = require('../lib/drivers');

function selectField(name, label, options, value, hint) {
  const opts = options
    .map(([v, l]) => `<option value="${esc(v)}"${String(value) === v ? ' selected' : ''}>${esc(l)}</option>`)
    .join('\n');
  return `<label>${esc(label)}
    <select name="${esc(name)}">${opts}</select>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </label>`;
}

function textField(name, label, value, { type = 'text', required = false, hint = '', placeholder = '' } = {}) {
  return `<label>${esc(label)}${required ? ' *' : ''}
    <input type="${type}" name="${esc(name)}" value="${esc(value || '')}"${required ? ' required' : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </label>`;
}

function checkboxGroup(name, label, options, checked) {
  const set = new Set(checked || []);
  const boxes = options
    .map(
      ([v, l]) =>
        `<label class="checkbox"><input type="checkbox" name="${esc(name)}" value="${esc(v)}"${set.has(v) ? ' checked' : ''}> ${esc(l)}</label>`
    )
    .join('\n');
  return `<fieldset class="check-group"><legend>${esc(label)}</legend>${boxes}</fieldset>`;
}

// --- Phase A: onboarding form -------------------------------------------------
function onboardPage({ site, source = 'direct', prefill = {}, errors = [] }) {
  const p = prefill;
  const errHtml = errors.length
    ? `<div class="form-error" role="alert"><strong>Please fix the following:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  const sourceOptions = drivers.SOURCES.map((s) => [s, drivers.SOURCE_LABELS[s]]);
  return `
<section>
  <h1>Driver Onboarding</h1>
  <p class="subhead">Tell us about you, your business, and your vehicle. It takes about 5 minutes — then we start matching you with routes.</p>
  ${errHtml}
  <form method="POST" action="/drivers/onboard" class="form">
    <input type="hidden" name="source" value="${esc(source)}">

    <div class="card">
      <h2>Driver information</h2>
      ${textField('full_name', 'Full name', p.full_name, { required: true, placeholder: 'Jane Driver' })}
      ${textField('email', 'Email', p.email, { type: 'email', required: true, placeholder: 'you@example.com' })}
      ${textField('phone', 'Phone', p.phone, { type: 'tel', required: true, placeholder: '(414) 555-0100' })}
      ${selectField('contact_method', 'Preferred contact method', [['call', 'Phone call'], ['text', 'Text message'], ['email', 'Email']], p.contact_method || 'text')}
    </div>

    <div class="card">
      <h2>Business</h2>
      ${textField('business_name', 'Business name', p.business_name, { hint: 'Leave blank if you operate under your own name.' })}
      ${selectField('entity_type', 'Entity type', [['', '—'], ['sole_proprietor', 'Sole proprietor'], ['llc', 'LLC'], ['corporation', 'Corporation'], ['partnership', 'Partnership'], ['other', 'Other']], p.entity_type)}
      ${textField('mc_number', 'MC number', p.mc_number, { hint: 'If applicable.' })}
      ${textField('dot_number', 'DOT number', p.dot_number, { hint: 'If applicable.' })}
      ${textField('years_in_business', 'Years in business', p.years_in_business, { placeholder: 'e.g. 3' })}
    </div>

    <div class="card">
      <h2>Vehicle</h2>
      ${selectField('vehicle_type', 'Vehicle type', [['', '—'], ['car', 'Car'], ['suv', 'SUV'], ['pickup', 'Pickup truck'], ['cargo_van', 'Cargo van'], ['box_truck', 'Box truck'], ['step_van', 'Step van'], ['other', 'Other']], p.vehicle_type)}
      ${textField('vehicle_year', 'Year', p.vehicle_year, { placeholder: 'e.g. 2021' })}
      ${textField('vehicle_make_model', 'Make / model', p.vehicle_make_model, { placeholder: 'e.g. Ford Transit' })}
      ${textField('cargo_dimensions', 'Cargo dimensions', p.cargo_dimensions, { hint: 'Length × width × height of your cargo area.', placeholder: 'e.g. 10ft × 5ft × 5ft' })}
      ${textField('payload_capacity', 'Payload / cargo capacity', p.payload_capacity, { placeholder: 'e.g. 3,500 lbs' })}
      ${textField('equipment', 'Equipment / features', p.equipment, { hint: 'Liftgate, straps, dolly, E-track, etc.', placeholder: 'e.g. Liftgate, straps, dolly' })}
      ${selectField('insurance_status', 'Commercial insurance status', [['', '—'], ['yes', 'Yes, I have commercial coverage'], ['in_progress', 'In progress'], ['no', 'Not yet']], p.insurance_status)}
    </div>

    <div class="card">
      <h2>Location</h2>
      ${textField('home_city', 'Home city', p.home_city, { placeholder: 'Milwaukee' })}
      ${textField('home_state', 'Home state', p.home_state, { placeholder: 'WI' })}
      ${selectField('service_radius', 'Service radius', [['', '—'], ['25', 'Up to 25 miles'], ['50', 'Up to 50 miles'], ['100', 'Up to 100 miles'], ['200', 'Up to 200 miles'], ['unlimited', 'No limit — willing to travel']], p.service_radius)}
      ${textField('travel_regions', 'States / regions willing to travel', p.travel_regions, { placeholder: 'e.g. WI, IL, MN' })}
    </div>

    <div class="card">
      <h2>Availability</h2>
      ${checkboxGroup('days_available', 'Days available', [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']], p.days_available)}
      ${textField('hours_available', 'Hours available', p.hours_available, { placeholder: 'e.g. 6am–6pm' })}
      ${textField('start_date', 'Available start date', p.start_date, { type: 'date' })}
      ${selectField('availability_status', 'Availability status', [['available', 'Available now'], ['soon', 'Available soon'], ['not_available', 'Not currently available']], p.availability_status || 'available')}
    </div>

    <div class="card">
      <h2>Work preferences</h2>
      ${checkboxGroup('work_prefs', 'What kind of work interests you? (check all that apply)', Object.entries(drivers.WORK_PREF_LABELS), p.work_prefs)}
      <label>Preferred lanes / areas
        <textarea name="lane_prefs" rows="3" placeholder="e.g. Milwaukee metro, Chicago corridor, I-94 west">${esc(p.lane_prefs || '')}</textarea>
      </label>
    </div>

    <div class="card">
      <h2>What are you looking for?</h2>
      ${checkboxGroup('looking_for', 'Check all that apply', Object.entries(drivers.LOOKING_FOR_LABELS), p.looking_for)}
      ${selectField('source', 'How did you hear about TransitNow?', sourceOptions, source)}
    </div>

    <button type="submit" class="btn btn-large">SUBMIT ONBOARDING &rarr;</button>
    <p class="microcopy">We only ask for what's needed to match you with routes. We never ask for Social Security numbers, bank account numbers, or passwords on this form.</p>
  </form>
</section>`;
}

// --- Phase A: onboarding confirmation -----------------------------------------
function onboardDonePage({ site, driver, dashUrl }) {
  return `
<section>
  <h1>You're in, ${esc(driver.full_name)}.</h1>
  <p class="subhead">We've received your onboarding information and our team is reviewing it now.</p>
  <div class="card highlight-card">
    <h2>Your private driver dashboard</h2>
    <p>Save this link — it's your personal access to your routes, packages, support, and community. No password needed.</p>
    <p class="dash-link"><a href="${esc(dashUrl)}">${esc(dashUrl)}</a></p>
    <p class="microcopy">We also emailed this link to ${esc(driver.email)}.</p>
  </div>
  <div class="card">
    <h2>What happens next</h2>
    <ol>
      <li><strong>Review.</strong> We review your profile and documents.</li>
      <li><strong>Ready.</strong> When you're marked Ready, we start matching you with routes.</li>
      <li><strong>Roll.</strong> Your route, packages, and progress appear on your dashboard.</li>
    </ol>
  </div>
  <a class="btn btn-large" href="${esc(dashUrl)}">OPEN MY DASHBOARD &rarr;</a>
  <p class="contact-line">Questions? Call ${esc(site.phone || '')} or email ${esc(site.email || '')}.</p>
</section>`;
}

// --- Phase C: private driver dashboard (token link, no login) -------------------
// --- Tier route matches + weekly goal (driver-facing) ----------------------------
// matchInfo: { matches: activeMatches[], prog: goalProgress() } or null.
// A match is a potential opportunity, never promised work — copy says so.
function routeMatchDashCard(matchInfo) {
  if (!matchInfo || !matchInfo.prog) return '';
  const { matches, prog } = matchInfo;
  if (!prog.plan) {
    return `<div class="card"><h3>Route matches</h3>
      <p>Route matching is included with a TransitNow dispatch plan (Basic $50/month or Complete $100/month).</p>
      <p><a class="btn" href="/dispatch">See dispatch plans</a></p>
      <p class="microcopy">Matches are potential opportunities only — never promised routes, loads, contracts, or income.</p>
    </div>`;
  }
  const tierName = prog.plan === 'complete' ? 'Complete' : 'Basic';
  const items = (matches || []).map((m) =>
    `<li><strong>${esc(m.opportunity_name || 'Route opportunity')}</strong>` +
    (m.opportunity_location ? ` — ${esc(m.opportunity_location)}` : '') + ` <span class="microcopy">(potential match)</span></li>`
  ).join('');
  const goalLine = prog.goalCents > 0
    ? `<p><strong>Your weekly goal:</strong> $${(prog.goalCents / 100).toFixed(2)} — set by you, tracked toward, never promised.</p>`
    : '';
  return `<div class="card"><h3>Route matches — ${esc(tierName)} plan</h3>
    <p><strong>${prog.assignedCount} of ${prog.quota} matches</strong> this week (${esc(prog.weekKey)}).</p>
    ${goalLine}
    <ul>${items || '<li>No active matches right now. New opportunities are added as they come in.</li>'}</ul>
    <p class="microcopy">Route matches are potential opportunities only. TransitNow does not promise or guarantee routes, loads, contracts, work, earnings, or income.</p>
  </div>`;
}

function dashboardPage({ site, driver, dashUrl, matchInfo = null }) {
  const stage = drivers.STATUS_LABELS[driver.status] || driver.status;
  const nextSteps = {
    new: 'We are reviewing your onboarding information. No action needed right now.',
    reviewing: 'Our team is reviewing your profile and documents. We will contact you soon.',
    contacted: 'We reached out — please check your email/texts and respond so we can keep moving.',
    documents_needed: 'We need additional documents from you. Please check your email for details.',
    ready: 'You are marked Ready. We will start matching you with routes shortly.',
    placement: 'We are actively searching for loads and route opportunities for you.',
    active: 'You are active. Your current route and packages appear below.',
    inactive: 'Your driver profile is currently inactive. Contact us if this is a mistake.',
  };
  const step = nextSteps[driver.status] || nextSteps.new;
  const cards = [
    ['My route', '/d/' + driver.access_token + '/route', 'Your assigned route and stops.', driver.status === 'active'],
    ['Packages', '/d/' + driver.access_token + '/packages', 'Packages assigned to you.', true],
    ['Scan a package', '/d/' + driver.access_token + '/scan', 'Scan barcodes at pickup and delivery.', true],
    ['Support', '/d/' + driver.access_token + '/support', 'Get help or report an urgent issue.', true],
    ['Go live with operations', '/d/' + driver.access_token + '/go-live', 'Request a live video/audio session with operations.', true],
    ['Community', '/d/' + driver.access_token + '/community', 'Connect with other TransitNow drivers.', true],
    ['My plan', '/d/' + driver.access_token + '/plan', 'Your service plan and requests.', true],
    // Phase 6: referral code + document upload, driver-scoped.
    ['Referrals', '/d/' + driver.access_token + '/referral', 'Your referral code and share link.', true],
    ['My documents', '/d/' + driver.access_token + '/documents', 'Upload and view your documents.', true],
  ];
  const cardsHtml = cards
    .map(
      ([title, href, desc, enabled]) =>
        `<a class="card dash-card${enabled ? '' : ' disabled'}"${enabled ? ` href="${esc(href)}"` : ''}>
          <h3>${esc(title)}</h3><p>${esc(desc)}${enabled ? '' : ' — available when active.'}</p>
        </a>`
    )
    .join('\n');
  return `
<section class="dash">
  <h1>Hi, ${esc(driver.full_name)}.</h1>
  <p class="subhead">Status: ${esc(stage)}</p>
  <div class="card highlight-card"><p><strong>What happens next:</strong> ${esc(step)}</p></div>
  ${routeMatchDashCard(matchInfo)}
  <h2>Your hub</h2>
  <div class="dash-grid">
    ${cardsHtml}
  </div>
  <div class="card">
    <h3>Your private link</h3>
    <p class="dash-link"><a href="${esc(dashUrl)}">${esc(dashUrl)}</a></p>
    <p class="microcopy">Save or bookmark this link — it is your personal sign-in. Do not share it.</p>
  </div>
  <p class="contact-line">Questions? Call ${esc(site.phone || '')} or email ${esc(site.email || '')}.</p>
</section>`;
}

// --- Phase D: driver route + packages -------------------------------------------
function driverRoutePage({ site, driver, route, packages }) {
  if (!route) {
    return `
<section>
  <h1>My route</h1>
  <p class="subhead">No route assigned yet.</p>
  <div class="card"><p>When TransitNow assigns you a route, it will appear here with your stops and packages.</p></div>
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
  }
  const pkgRows = packages
    .map(
      (p) => `<div class="card">
        <h3><a href="/d/${esc(driver.access_token)}/packages/${esc(p.package_id)}">${esc(p.package_id)}</a></h3>
        <p><strong>${esc(p.recipient_name)}</strong><br>${esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', '))}</p>
        <p>Status: <strong>${esc(drivers.PACKAGE_STATUS_LABELS[p.status] || p.status)}</strong></p>
        ${p.special_instructions ? `<p class="muted">Note: ${esc(p.special_instructions)}</p>` : ''}
      </div>`
    )
    .join('');
  return `
<section>
  <h1>My route</h1>
  <p class="subhead">${esc(route.route_code)} · ${esc(route.title || '')}</p>
  <div class="card highlight-card" id="route-progress" data-progress-url="/d/${esc(driver.access_token)}/route/progress">
    <p><strong>Status:</strong> ${esc(drivers.ROUTE_STATUS_LABELS[route.status] || route.status)}<br>
    <strong>Scheduled:</strong> ${esc(route.scheduled_date || '—')}</p>
    <p class="progress-line"><strong><span id="pg-done">0</span> of <span id="pg-total">${packages.length}</span> packages complete</strong></p>
    <div class="bar-track"><div class="bar-fill" id="pg-bar" style="width:0%"></div></div>
    <p class="microcopy">Counts refresh about every 30 seconds.</p>
  </div>
  <h2>Packages (${packages.length})</h2>
  ${pkgRows || '<div class="card"><p>No packages on this route yet.</p></div>'}
  <p><a class="btn btn-large" href="/d/${esc(driver.access_token)}/scan">SCAN A PACKAGE &rarr;</a></p>
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>
<script>
(function () {
  var box = document.getElementById('route-progress');
  if (!box) return;
  var url = box.getAttribute('data-progress-url');
  function tick() {
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        if (!p) return;
        document.getElementById('pg-done').textContent = p.done;
        document.getElementById('pg-total').textContent = p.total;
        var pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        document.getElementById('pg-bar').style.width = pct + '%';
      })
      .catch(function () { /* polling is best-effort; next tick retries */ });
  }
  tick();
  setInterval(tick, 30000);
})();
</script>`;
}

function driverPackagesPage({ site, driver, packages }) {
  const groups = {};
  for (const p of packages) {
    (groups[p.status] = groups[p.status] || []).push(p);
  }
  const sections = Object.entries(groups)
    .map(
      ([status, list]) => `
<h2>${esc(drivers.PACKAGE_STATUS_LABELS[status] || status)} (${list.length})</h2>
${list.map((p) => `<div class="card">
  <h3><a href="/d/${esc(driver.access_token)}/packages/${esc(p.package_id)}">${esc(p.package_id)}</a></h3>
  <p><strong>${esc(p.recipient_name)}</strong><br>${esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', '))}</p>
  ${p.special_instructions ? `<p class="muted">Note: ${esc(p.special_instructions)}</p>` : ''}
</div>`).join('')}`
    )
    .join('\n');
  return `
<section>
  <h1>My packages</h1>
  <p class="subhead">${packages.length} package(s) assigned to you.</p>
  ${sections || '<div class="card"><p>No packages assigned yet.</p></div>'}
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
}

// --- Phase E: phone-camera scanning with manual fallback -------------------------
function scanPage({ driver }) {
  return `
<section>
  <h1>Scan a package</h1>
  <p class="subhead">Point your camera at the package barcode or QR code.</p>
  <div id="reader" class="card"></div>
  <p id="scan-error" class="form-error" style="display:none"></p>
  <div class="card">
    <h3>Or enter the package ID manually</h3>
    <form method="POST" action="/d/${esc(driver.access_token)}/scan" class="form">
      <label>Package ID
        <input type="text" name="code" placeholder="TN-2026-000001" autocomplete="off" autocapitalize="characters">
      </label>
      <button type="submit" class="btn btn-large big-btn">LOOK UP PACKAGE</button>
    </form>
  </div>
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>
<script src="/vendor/html5-qrcode.min.js"></script>
<script>
(function () {
  var errBox = document.getElementById('scan-error');
  function manualOnly(msg) {
    document.getElementById('reader').innerHTML =
      '<p><strong>Camera scanning is not available on this device or browser.</strong></p><p>Use the manual package-ID entry below — it works the same.</p>';
    if (msg && errBox) { errBox.style.display = 'block'; errBox.textContent = msg; }
  }
  function submitCode(code) {
    var f = document.createElement('form');
    f.method = 'POST';
    f.action = ${JSON.stringify('/d/' + driver.access_token + '/scan')};
    var i = document.createElement('input');
    i.type = 'hidden'; i.name = 'code'; i.value = code;
    f.appendChild(i);
    document.body.appendChild(f);
    f.submit();
  }
  try {
    if (typeof Html5QrcodeScanner === 'undefined') { manualOnly(); return; }
    var scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: { width: 250, height: 250 } }, false);
    var done = false;
    scanner.render(function (decodedText) {
      if (done) return;
      done = true;
      scanner.clear().catch(function () {});
      submitCode(decodedText);
    }, function () { /* per-frame scan errors are normal; ignore */ });
  } catch (e) {
    manualOnly('Camera error: ' + (e && e.message ? e.message : e));
  }
  // If the camera permission is denied after render starts, html5-qrcode shows
  // its own permission UI; the manual form below always remains available.
})();
</script>`;
}

function scanResultPage({ driver, pkg, error }) {
  if (error || !pkg) {
    return `
<section>
  <h1>No package found</h1>
  <div class="card scan-result scan-err"><p>${esc(error || 'We could not find that package ID among your assigned packages.')}</p></div>
  <p><a class="btn btn-large big-btn" href="/d/${esc(driver.access_token)}/scan">SCAN AGAIN</a></p>
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
  }
  return `
<section>
  <h1>Package found</h1>
  <div class="card scan-result scan-ok">
    <p>${esc(pkg.package_id)}</p>
  </div>
  <div class="card">
    <p><strong>${esc(pkg.recipient_name)}</strong><br>
    ${esc([pkg.address, pkg.city, pkg.state, pkg.zip].filter(Boolean).join(', '))}</p>
    <p>Status: <strong>${esc(drivers.PACKAGE_STATUS_LABELS[pkg.status] || pkg.status)}</strong></p>
    ${pkg.special_instructions ? `<p class="muted">Note: ${esc(pkg.special_instructions)}</p>` : ''}
  </div>
  <p><a class="btn btn-large big-btn" href="/d/${esc(driver.access_token)}/scan">SCAN ANOTHER</a></p>
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
}

// --- Phase F: package detail with append-only custody history --------------------
function driverPackagePage({ driver, pkg, events, exceptions }) {
  const buttons = drivers.CUSTODY_EVENTS.map((e) => `
    <button type="submit" name="event_type" value="${e}" class="btn big-btn">${esc(drivers.CUSTODY_EVENT_LABELS[e]).toUpperCase()}</button>`).join('\n');
  const timeline = (events || [])
    .map(
      (ev) => `<li><strong>${esc(drivers.CUSTODY_EVENT_LABELS[ev.event_type] || ev.event_type)}</strong>
        <span class="ts">${new Date(Number(ev.ts)).toLocaleString()}${ev.driver_name ? ' · ' + esc(ev.driver_name) : ''}</span>
        ${ev.note ? `<br>${esc(ev.note)}` : ''}</li>`
    )
    .join('');
  const exHtml = (exceptions || [])
    .map(
      (x) => `<div class="card"><p><strong>${esc(drivers.EXCEPTION_TYPE_LABELS[x.exception_type] || x.exception_type)}</strong>
        — ${esc(drivers.EXCEPTION_STATUS_LABELS[x.status] || x.status)}</p>
        <p>${esc(x.description)}</p>
        ${x.photo_mime ? `<p><a href="/d/${esc(driver.access_token)}/exceptions/${x.id}/photo">View attached photo</a></p>` : ''}
        ${x.status === 'resolved' && x.resolution_note ? `<p class="muted">Resolution: ${esc(x.resolution_note)}</p>` : ''}</div>`
    )
    .join('');
  return `
<section>
  <h1>${esc(pkg.package_id)}</h1>
  <div class="card">
    <p><strong>${esc(pkg.recipient_name)}</strong><br>
    ${esc([pkg.address, pkg.city, pkg.state, pkg.zip].filter(Boolean).join(', '))}</p>
    <p>Status: <strong>${esc(drivers.PACKAGE_STATUS_LABELS[pkg.status] || pkg.status)}</strong></p>
    ${pkg.special_instructions ? `<p class="muted">Note: ${esc(pkg.special_instructions)}</p>` : ''}
  </div>
  <p><a class="btn big-btn" href="/d/${esc(driver.access_token)}/packages/${esc(pkg.package_id)}/exception">REPORT AN EXCEPTION</a></p>
  ${exHtml ? `<h2>Exceptions</h2>${exHtml}` : ''}
  <h2>Record custody event</h2>
  <form method="POST" action="/d/${esc(driver.access_token)}/packages/${esc(pkg.package_id)}/event" class="form">
    <label>Note / handed to <span class="hint">Required for handoff — who received the package?</span>
      <input type="text" name="note" placeholder="e.g. Handed to Maria at front desk">
    </label>
    ${buttons}
  </form>
  <h2>Custody history</h2>
  <ul class="timeline">${timeline || '<li>No custody events recorded yet.</li>'}</ul>
  <p><a class="btn big-btn" href="/d/${esc(driver.access_token)}/scan">SCAN ANOTHER</a></p>
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
}

// --- Phase H: report a delivery exception -----------------------------------------
function exceptionFormPage({ driver, pkg, error }) {
  const typeOpts = drivers.EXCEPTION_TYPES.map(
    (t) => `<option value="${t}">${esc(drivers.EXCEPTION_TYPE_LABELS[t])}</option>`
  ).join('');
  return `
<section>
  <h1>Report an exception</h1>
  <p class="subhead">${esc(pkg.package_id)} · ${esc(pkg.recipient_name)}</p>
  ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
  <form method="POST" action="/d/${esc(driver.access_token)}/packages/${esc(pkg.package_id)}/exception" enctype="multipart/form-data" class="form">
    <label>What happened? *
      <select name="exception_type" required>${typeOpts}</select>
    </label>
    <label>Describe what happened *
      <textarea name="description" rows="4" required placeholder="e.g. Recipient not home; no safe drop location"></textarea>
    </label>
    <label>Photo / proof (optional)
      <input type="file" name="photo" accept="image/*,.pdf">
      <span class="hint">A photo helps operations resolve this faster.</span>
    </label>
    <label class="checkbox"><input type="checkbox" name="photo_confirm" value="1"> My photo contains no sensitive personal information (no IDs, no faces of non-consenting people).</label>
    <button type="submit" class="btn btn-large big-btn">SUBMIT EXCEPTION</button>
  </form>
  <p><a href="/d/${esc(driver.access_token)}/packages/${esc(pkg.package_id)}">&larr; Back to package</a></p>
</section>`;
}

// --- Phase I: support tickets -----------------------------------------------------
function supportPage({ driver, tickets, error }) {
  const catOpts = drivers.TICKET_CATEGORIES.map(
    (c) => `<option value="${c}">${esc(drivers.TICKET_CATEGORY_LABELS[c])}</option>`
  ).join('');
  const rows = (tickets || [])
    .map(
      (t) => `<a class="card" href="/d/${esc(driver.access_token)}/support/${esc(t.ticket_id)}">
        <h3>${esc(t.ticket_id)} — ${esc(t.subject)}</h3>
        <p>${esc(drivers.TICKET_CATEGORY_LABELS[t.category] || t.category)} ·
        ${t.priority === 'urgent' ? '<strong>URGENT</strong> · ' : ''}${esc(drivers.TICKET_STATUS_LABELS[t.status] || t.status)}</p>
      </a>`
    )
    .join('');
  return `
<section>
  <h1>Support</h1>
  <p class="subhead">Questions about your route, packages, or account — send them here.</p>
  ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
  <div class="card">
    <h2>New request</h2>
    <form method="POST" action="/d/${esc(driver.access_token)}/support" class="form">
      <label>Category *
        <select name="category" required>${catOpts}</select>
      </label>
      <label>Subject *
        <input type="text" name="subject" required placeholder="e.g. Wrong address on package">
      </label>
      <label>Describe what you need *
        <textarea name="description" rows="4" required placeholder="Give us the details…"></textarea>
      </label>
      <label class="checkbox"><input type="checkbox" name="priority" value="urgent">
        <strong>This is urgent</strong> — I need operations attention as soon as possible.</label>
      <p class="microcopy">Urgent requests go straight to TransitNow operations and can be submitted any time.
      We do not promise an immediate human response at all hours. If this is an emergency, call 911 first.</p>
      <button type="submit" class="btn btn-large big-btn">SUBMIT REQUEST</button>
    </form>
  </div>
  <h2>Your requests (${(tickets || []).length})</h2>
  ${rows || '<div class="card"><p>No requests yet.</p></div>'}
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
}

function ticketDetailPage({ driver, ticket, replies, error }) {
  const thread = (replies || [])
    .map(
      (r) => `<div class="card"><p><strong>${r.author_type === 'admin' ? 'TransitNow Operations' : 'You'}</strong>
        <span class="ts">${new Date(Number(r.created_at)).toLocaleString()}</span></p>
        <p>${esc(r.message)}</p></div>`
    )
    .join('');
  return `
<section>
  <h1>${esc(ticket.ticket_id)}</h1>
  <p class="subhead">${esc(ticket.subject)}</p>
  <div class="card">
    <p><strong>${esc(drivers.TICKET_CATEGORY_LABELS[ticket.category] || ticket.category)}</strong> ·
    ${ticket.priority === 'urgent' ? '<strong>URGENT</strong> · ' : ''}${esc(drivers.TICKET_STATUS_LABELS[ticket.status] || ticket.status)}</p>
    <p>${esc(ticket.message)}</p>
  </div>
  <h2>Conversation</h2>
  ${thread || '<div class="card"><p>No replies yet.</p></div>'}
  ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
  ${['resolved', 'closed'].includes(ticket.status) ? '<p class="microcopy">This request is ' + esc(ticket.status) + '.</p>' : `
  <div class="card">
    <h3>Add a reply</h3>
    <form method="POST" action="/d/${esc(driver.access_token)}/support/${esc(ticket.ticket_id)}/reply" class="form">
      <label>Your reply
        <textarea name="message" rows="3" required></textarea>
      </label>
      <button type="submit" class="btn">Send reply</button>
    </form>
  </div>`}
  <p><a href="/d/${esc(driver.access_token)}/support">&larr; Back to support</a></p>
</section>`;
}

// --- Phase J: driver community ---------------------------------------------------
function communityPage({ driver, posts, categoryFilter, authors, error }) {
  const tabs = drivers.COMMUNITY_CATEGORIES.map((c) => {
    const active = categoryFilter === c ? ' class="active"' : '';
    return `<a${active} href="/d/${esc(driver.access_token)}/community?category=${c}">${esc(drivers.COMMUNITY_CATEGORY_LABELS[c])}</a>`;
  }).join('');
  const allActive = !categoryFilter ? ' class="active"' : '';
  const catOpts = drivers.COMMUNITY_CATEGORIES.filter((c) => c !== 'announcements').map(
    (c) => `<option value="${c}">${esc(drivers.COMMUNITY_CATEGORY_LABELS[c])}</option>`
  ).join('');
  const rows = (posts || [])
    .map((p) => {
      const a = authors[p.driver_id];
      return `<a class="card" href="/d/${esc(driver.access_token)}/community/${p.id}">
        <h3>${p.pinned ? '📌 ' : ''}${esc(p.title)}</h3>
        <p>${esc(drivers.COMMUNITY_CATEGORY_LABELS[p.category] || p.category)} ·
        by ${esc(a ? drivers.communityDisplayName(a) : 'TransitNow')} ·
        <span class="ts">${new Date(Number(p.created_at)).toLocaleDateString()}</span></p>
      </a>`;
    })
    .join('');
  return `
<section>
  <h1>Driver community</h1>
  <p class="subhead">A private space for TransitNow drivers — tips, questions, and wins. Be kind and keep customer info private.</p>
  <div class="pipeline-nav"><a${allActive} href="/d/${esc(driver.access_token)}/community">All</a>${tabs}</div>
  ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
  <div class="card">
    <h2>Start a post</h2>
    <form method="POST" action="/d/${esc(driver.access_token)}/community" class="form">
      <label>Category *
        <select name="category" required>${catOpts}</select>
      </label>
      <label>Title *
        <input type="text" name="title" required placeholder="e.g. Shortcut that saves me 20 minutes">
      </label>
      <label>Your post *
        <textarea name="body" rows="4" required placeholder="Share your tip, question, or win…"></textarea>
      </label>
      <button type="submit" class="btn btn-large big-btn">POST</button>
    </form>
  </div>
  <h2>Posts</h2>
  ${rows || '<div class="card"><p>No posts yet — be the first.</p></div>'}
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
}

function communityPostPage({ driver, post, comments, authors, error }) {
  const a = authors[post.driver_id];
  const commentHtml = (comments || [])
    .map((c) => {
      const ca = authors[c.driver_id];
      return `<div class="card"><p><strong>${esc(ca ? drivers.communityDisplayName(ca) : 'TransitNow')}</strong>
        <span class="ts">${new Date(Number(c.created_at)).toLocaleString()}</span></p>
        <p>${esc(c.body)}</p>
        <form method="POST" action="/d/${esc(driver.access_token)}/community/report" class="form" style="display:inline">
          <input type="hidden" name="comment_id" value="${c.id}">
          <input type="text" name="reason" placeholder="Report: reason" required style="width:140px">
          <button type="submit" class="btn btn-small">Report</button>
        </form></div>`;
    })
    .join('');
  return `
<section>
  <p><a href="/d/${esc(driver.access_token)}/community">&larr; Back to community</a></p>
  <h1>${post.pinned ? '📌 ' : ''}${esc(post.title)}</h1>
  <p class="subhead">${esc(drivers.COMMUNITY_CATEGORY_LABELS[post.category] || post.category)} ·
  by ${esc(a ? drivers.communityDisplayName(a) : 'TransitNow')} ·
  <span class="ts">${new Date(Number(post.created_at)).toLocaleString()}</span></p>
  <div class="card"><p>${esc(post.body)}</p></div>
  <form method="POST" action="/d/${esc(driver.access_token)}/community/report" class="form">
    <input type="hidden" name="post_id" value="${post.id}">
    <label>Report this post <input type="text" name="reason" placeholder="Why are you reporting this?" required></label>
    <button type="submit" class="btn btn-small">Report post</button>
  </form>
  <h2>Comments (${(comments || []).length})</h2>
  ${commentHtml || '<div class="card"><p>No comments yet.</p></div>'}
  ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
  <div class="card">
    <h3>Add a comment</h3>
    <form method="POST" action="/d/${esc(driver.access_token)}/community/${post.id}/comments" class="form">
      <label>Your comment
        <textarea name="body" rows="3" required></textarea>
      </label>
      <button type="submit" class="btn">Post comment</button>
    </form>
  </div>
</section>`;
}

// --- Phase K: service plans ------------------------------------------------------
function planPage({ driver, plans, settings, currentPlanId, pendingRequest, history, error }) {
  const requestsOpen = !!settings.plans_enabled;
  const planCards = (plans || [])
    .map((p) => {
      const feats = (() => { try { return JSON.parse(p.features || '[]'); } catch { return []; } })();
      const isCurrent = currentPlanId === p.id;
      const isPending = pendingRequest && pendingRequest.to_plan_id === p.id;
      return `<div class="card">
        <h3>${esc(p.name)} — ${esc(drivers.planPriceDisplay(p))}</h3>
        <p>${esc(p.description || '')}</p>
        ${feats.length ? `<ul>${feats.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        ${isCurrent ? '<p><strong>Your current plan</strong></p>'
          : isPending ? '<p><strong>Request pending</strong> — operations will review.</p>'
          : requestsOpen ? `<form method="POST" action="/d/${esc(driver.access_token)}/plan/request" class="form">
               <input type="hidden" name="plan_id" value="${esc(p.id)}">
               <button type="submit" class="btn big-btn">REQUEST THIS PLAN</button>
             </form>`
          : '<p class="microcopy">Requests are currently closed.</p>'}
      </div>`;
    })
    .join('');
  const histRows = (history || [])
    .map((h) => `<li><strong>${esc(h.event)}</strong> ${h.from_plan_id ? esc(h.from_plan_id) + ' → ' : ''}${esc(h.to_plan_id || '')}
      <span class="ts">${new Date(Number(h.created_at)).toLocaleDateString()} · by ${esc(h.created_by)}</span>
      ${h.note ? `<br>${esc(h.note)}` : ''}</li>`)
    .join('');
  return `
<section>
  <h1>Service plans</h1>
  <p class="subhead">TransitNow service plans are billed ${esc(settings.billing_frequency || 'weekly')}.</p>
  ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
  ${requestsOpen ? '' : '<div class="card"><p>Service plans are not currently open for new requests. Check back later.</p></div>'}
  ${planCards || '<div class="card"><p>No plans are currently available.</p></div>'}
  <div class="card">
    <p class="microcopy">${esc(drivers.PLAN_DISCLAIMER)}</p>
    <p class="microcopy">Plan requests are reviewed by operations. A plan becomes active only after approval and acceptance of the service terms — requesting a plan does not activate billing.</p>
  </div>
  ${histRows ? `<h2>Your plan history</h2><ul class="timeline">${histRows}</ul>` : ''}
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
}

module.exports = { onboardPage, onboardDonePage, dashboardPage, driverRoutePage, driverPackagesPage, scanPage, scanResultPage, driverPackagePage, exceptionFormPage, supportPage, ticketDetailPage, communityPage, communityPostPage, planPage, selectField, textField, checkboxGroup, driverApplyPage, driverApplyDonePage, goLivePage, liveSessionPage, providerBannerHtml };

// --- Phase 2: extended driver application (/drivers/apply/:token) -----------------
// Token-scoped: operations shares this link with a specific candidate once an
// actual opportunity/dispatch relationship is relevant. It is NOT in the
// public nav — not a second public free-for-all. Mobile-first.
function driverApplyPage({ site, driver, errors = [], prefill = {} }) {
  const p = prefill;
  const errHtml = errors.length
    ? `<div class="form-error" role="alert"><strong>Please fix the following:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  return `
<section>
  <h1>Driver Application</h1>
  <p class="subhead">Hi ${esc(driver.full_name)} — TransitNow operations shared this application with you. It covers the license, insurance, and agreement details we need before any route or dispatch relationship.</p>
  <div class="card highlight-card">
    <p><strong>Plainly:</strong> ${esc(drivers.NO_GUARANTEE_APPLICATION)}</p>
  </div>
  ${errHtml}
  <form method="POST" action="/drivers/apply/${esc(driver.access_token)}" class="form">
    <div class="card">
      <h2>Driver's license</h2>
      ${textField('license_number', "License number", p.license_number, { required: true, hint: 'Used only for the required background / MVR check.' })}
      ${textField('license_state', 'License state', p.license_state, { required: true, placeholder: 'WI' })}
      ${textField('license_class', 'License class', p.license_class, { required: true, placeholder: 'D' })}
      ${textField('license_expiry', 'License expiration', p.license_expiry, { type: 'date', required: true })}
    </div>

    <div class="card">
      <h2>Insurance</h2>
      ${textField('insurance_carrier', 'Insurance carrier', p.insurance_carrier, { required: true, placeholder: 'e.g. Progressive Commercial' })}
      ${textField('insurance_policy', 'Policy number', p.insurance_policy, { required: true, hint: 'Used only to verify your coverage.' })}
      ${textField('insurance_expiry', 'Policy expiration', p.insurance_expiry, { type: 'date', required: true })}
    </div>

    <div class="card">
      <h2>Consents &amp; agreement</h2>
      <label class="checkbox"><input type="checkbox" name="consent_background" value="1"${p.consent_background ? ' checked' : ''} required>
        I consent to a background check and motor vehicle record (MVR) check as part of this application. *</label>
      <label class="checkbox"><input type="checkbox" name="consent_insurance_check" value="1"${p.consent_insurance_check ? ' checked' : ''} required>
        I consent to verification of my insurance coverage. *</label>
      <label class="checkbox"><input type="checkbox" name="agreement_accepted" value="1"${p.agreement_accepted ? ' checked' : ''} required>
        I have read and accept the TransitNow driver agreement and understand this application guarantees nothing. *</label>
    </div>

    <button type="submit" class="btn btn-large big-btn">SUBMIT APPLICATION &rarr;</button>
    <p class="microcopy">We only ask for what's needed to qualify you for opportunities. We never ask for Social Security numbers, bank account numbers, or passwords on this form.</p>
  </form>
  <p class="contact-line">Questions? Call ${esc(site.phone || '')} or email ${esc(site.email || '')}.</p>
</section>`;
}

function driverApplyDonePage({ site, driver, dashUrl }) {
  return `
<section>
  <h1>Application received, ${esc(driver.full_name)}.</h1>
  <p class="subhead">We've received your driver application and our team will review it against current and future opportunity requirements.</p>
  <div class="card highlight-card">
    <p><strong>What this means — plainly:</strong> ${esc(drivers.NO_GUARANTEE_APPLICATION)}</p>
  </div>
  <div class="card">
    <h2>What happens next</h2>
    <ol>
      <li><strong>Review.</strong> We verify your license, insurance, and documents.</li>
      <li><strong>Qualification.</strong> You move through screening, orientation, and training as applicable.</li>
      <li><strong>Ready.</strong> When you're marked Ready for Route, we start matching you with opportunities. Any match is recorded as a <strong>Potential Match</strong> — never a promise of work, routes, loads, or income.</li>
    </ol>
  </div>
  <a class="btn btn-large" href="${esc(dashUrl)}">OPEN MY DASHBOARD &rarr;</a>
  <p class="contact-line">Questions? Call ${esc(site.phone || '')} or email ${esc(site.email || '')}.</p>
</section>`;
}

// --- Phase 5: live video support (spec section 15, docs/VIDEO_SPEC.md) ------------
// HONESTY IS ABSOLUTE: nothing here may claim a live/real-time/connected media
// call unless a genuine provider-backed media connection exists. With no
// provider configured (always true until VIDEO_PROVIDER credentials are set),
// every surface shows VIDEO PROVIDER REQUIRED and labels workflows
// SIMULATED TEST.
function fmtLiveTs(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString();
}

function providerBannerHtml(provider) {
  if (provider.configured) {
    // Credentials alone do not prove a media connection: say exactly that.
    return `<div class="card highlight-card">
      <p><strong>Video provider credentials configured:</strong> ${esc(provider.providerName)}.
      Media is <strong>not verified</strong> — no end-to-end media call has succeeded, so this session
      still runs in <strong>SIMULATED TEST</strong> mode. No real-time video, audio, or media connection is claimed.</p>
    </div>`;
  }
  return `<div class="card" style="border:2px solid #b45309;background:#fffbeb" role="alert">
    <h2 style="margin-top:0;color:#92400e">VIDEO PROVIDER REQUIRED</h2>
    <p><strong>Live video calls need a real video provider connected on the TransitNow side.</strong>
    No provider is connected right now, so this page runs in <strong>SIMULATED TEST</strong> mode:
    you can submit a session request and walk through the accept/record steps, but
    <strong>no real-time video, audio, or media connection will happen.</strong></p>
    <p class="microcopy">A provider is connected only when the VIDEO_PROVIDER credentials are configured
    on the server and a genuine end-to-end media call succeeds. Until then, nothing here is
    live, real-time, instant, or connected.</p>
  </div>`;
}

function sessionStatusLine(s) {
  return `${esc(drivers.SESSION_STATUS_LABELS[s.status] || s.status)} · ${esc(drivers.SESSION_REASON_LABELS[s.reason] || s.reason || '')} · Priority ${esc(s.priority || 'NORMAL')}`;
}

/**
 * Provider-aware status label. The DB enum stays LIVE (spec), but the display
 * must never let "Live" read as a connected media call: until a provider-backed
 * end-to-end call has succeeded (mediaVerified), LIVE is labeled as a workflow
 * state in SIMULATED TEST.
 */
function liveStatusLabel(s, provider) {
  const base = drivers.SESSION_STATUS_LABELS[s.status] || s.status;
  if (s.status === 'LIVE' && !(provider && provider.mediaVerified)) {
    return `${base} — SIMULATED TEST (workflow state only, no media connection)`;
  }
  return base;
}

function goLivePage({ driver, activeSession, sessions, provider, trainingEvents, error, form }) {
  const f = form || {};
  const reasonOpts = drivers.SESSION_REASONS.map(
    (r) => `<option value="${r}"${f.reason === r ? ' selected' : ''}>${esc(drivers.SESSION_REASON_LABELS[r])}</option>`
  ).join('');
  const priOpts = drivers.SESSION_PRIORITIES.map(
    (p) => `<option value="${p}"${(f.priority || 'NORMAL') === p ? ' selected' : ''}>${esc(drivers.SESSION_PRIORITY_LABELS[p])}</option>`
  ).join('');
  const active = activeSession
    ? `<div class="card highlight-card">
        <h2>Your open session</h2>
        <p><strong>${esc(activeSession.session_id)}</strong> — ${sessionStatusLine(activeSession)}</p>
        <p><a class="btn btn-large" href="/d/${esc(driver.access_token)}/go-live/${esc(activeSession.session_id)}">OPEN SESSION &rarr;</a></p>
      </div>`
    : '';
  const past = (sessions || []).filter((s) => !activeSession || s.session_id !== activeSession.session_id);
  const pastRows = past.slice(0, 10).map(
    (s) => `<a class="card" href="/d/${esc(driver.access_token)}/go-live/${esc(s.session_id)}">
      <h3>${esc(s.session_id)} — ${esc(liveStatusLabel(s, provider))}</h3>
      <p>${esc(drivers.SESSION_REASON_LABELS[s.reason] || '')} · ${fmtLiveTs(s.created_at)}</p>
    </a>`
  ).join('');
  const training = (trainingEvents || []).map(
    (e) => `<div class="card"><h3>${esc(e.title)}</h3>
      <p>${esc(e.description || '')}</p>
      <p class="microcopy">${e.scheduled_at ? 'Scheduled: ' + fmtLiveTs(e.scheduled_at) : 'Time to be announced'}
      ${provider.configured ? '' : ' · <strong>SIMULATED TEST</strong> — no video provider connected, so this is not a provider-backed live event.'}</p>
    </div>`
  ).join('');
  return `
<section>
  <h1>Go live with operations</h1>
  <p class="subhead">Request a live video/audio support session with TransitNow operations.</p>
  ${providerBannerHtml(provider)}
  ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
  ${active}
  <div class="card">
    <h2>Request a session</h2>
    <form method="POST" action="/d/${esc(driver.access_token)}/go-live" class="form">
      <label>Reason *<select name="reason" required>${reasonOpts}</select></label>
      <label>Priority
        <select name="priority">${priOpts}</select>
        <span class="hint">Urgent requests are flagged for operations immediately.</span>
      </label>
      <label>Notes for operations
        <textarea name="notes" rows="3" placeholder="What should operations know before joining?">${esc(f.notes || '')}</textarea>
      </label>
      <fieldset>
        <legend>Your device preferences for this session</legend>
        <label class="checkbox"><input type="checkbox" name="want_camera" value="on"${f.want_camera ? ' checked' : ''}> I want to use my <strong>camera</strong></label>
        <label class="checkbox"><input type="checkbox" name="want_mic" value="on"${f.want_mic ? ' checked' : ''}> I want to use my <strong>microphone</strong></label>
        <label class="checkbox"><input type="checkbox" name="share_location" value="on"${f.share_location ? ' checked' : ''}> <strong>Share my location</strong> with operations (voluntary — stays off unless you check this)</label>
        <p class="microcopy">These are preferences only. Nothing activates automatically — your camera, microphone,
        and location stay <strong>off</strong> until you explicitly confirm on the session screen,
        and media can only run when a real video provider is connected.</p>
      </fieldset>
      <p class="microcopy">${esc(drivers.SESSION_COVERAGE_NOTE)} ${esc(drivers.SESSION_EMERGENCY_NOTE)}</p>
      <button type="submit" class="btn btn-large big-btn">GO LIVE WITH OPERATIONS &rarr;</button>
      ${provider.configured ? '' : '<p class="microcopy"><strong>SIMULATED TEST:</strong> submitting records a real request and walks the accept/record workflow — no media will run.</p>'}
    </form>
  </div>
  <div class="card">
    <h2>Test your device <span class="microcopy">(SIMULATED TEST)</span></h2>
    <p class="microcopy">Checks that your browser can access your camera and microphone <strong>locally only</strong>.
    This does not connect you to anyone. Your browser will ask permission explicitly.</p>
    <p>
      <button type="button" class="btn" id="devtest-cam">Test camera</button>
      <button type="button" class="btn" id="devtest-mic">Test microphone</button>
    </p>
    <video id="devtest-preview" playsinline muted style="display:none;max-width:100%;border-radius:8px"></video>
    <p class="microcopy" id="devtest-status" role="status"></p>
  </div>
  ${training ? `<h2>Upcoming live training</h2>${training}` : ''}
  ${pastRows ? `<h2>Past sessions</h2>${pastRows}` : ''}
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>
<script>
(function () {
  var status = document.getElementById('devtest-status');
  var preview = document.getElementById('devtest-preview');
  function setStatus(t) { if (status) status.textContent = t; }
  function needApi() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('SIMULATED TEST: this browser does not expose camera/microphone access.');
      return false;
    }
    return true;
  }
  var camBtn = document.getElementById('devtest-cam');
  var micBtn = document.getElementById('devtest-mic');
  var stream = null;
  if (camBtn) camBtn.addEventListener('click', function () {
    if (!needApi()) return;
    setStatus('Requesting camera permission…');
    navigator.mediaDevices.getUserMedia({ video: true }).then(function (s) {
      stream = s; preview.style.display = 'block'; preview.srcObject = s; preview.play();
      setStatus('SIMULATED TEST: camera preview working locally — not connected to anyone.');
    }).catch(function () { setStatus('SIMULATED TEST: camera access was denied or unavailable.'); });
  });
  if (micBtn) micBtn.addEventListener('click', function () {
    if (!needApi()) return;
    setStatus('Requesting microphone permission…');
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      stream = s;
      setStatus('SIMULATED TEST: microphone access granted locally — not connected to anyone. (No audio is recorded.)');
      s.getTracks().forEach(function (t) { t.stop(); });
    }).catch(function () { setStatus('SIMULATED TEST: microphone access was denied or unavailable.'); });
  });
  window.addEventListener('beforeunload', function () {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
  });
})();
</script>`;
}

function mediaStateHtml(session, provider) {
  const cam = session.consent_camera ? 'ON (you confirmed)' : 'OFF';
  const mic = session.consent_mic ? 'ON (you confirmed)' : 'OFF';
  const loc = session.share_location ? 'ON (voluntary)' : 'OFF';
  const mediaNote = provider.configured
    ? '<p class="microcopy">Video provider credentials are configured, but media is <strong>not verified</strong> — no end-to-end media call has succeeded. These switches record your consent only; no real-time video, audio, or media connection is claimed.</p>'
    : '<p class="microcopy"><strong>SIMULATED TEST:</strong> no provider is connected, so no real-time media is running. These switches record your consent only.</p>';
  return `<div class="card">
    <h2>Your media</h2>
    <p>Camera: <strong>${cam}</strong><br>Microphone: <strong>${mic}</strong><br>Location sharing: <strong>${loc}</strong></p>
    ${mediaNote}
  </div>`;
}

function liveSessionPage({ driver, session, events, messages, participants, recording, provider, error }) {
  const s = session;
  const open = ['REQUESTED', 'ACCEPTED', 'LIVE'].includes(s.status);
  const thread = (messages || []).map(
    (m) => `<div class="card"><p><strong>${m.sender_type === 'driver' ? 'You' : 'Operations'}</strong>
      <span class="ts">${fmtLiveTs(m.ts)}</span></p><p>${esc(m.message)}</p></div>`
  ).join('');
  const timeline = (events || []).map(
    (e) => `<li><strong>${esc(e.event_type)}</strong> — ${esc(e.details || '')} <span class="muted">(${esc(e.actor || '')} · ${fmtLiveTs(e.ts)})</span></li>`
  ).join('');
  const parts = (participants || []).map(
    (p) => `<li>${p.role === 'driver' ? 'Driver' : 'Operations' + (p.staff_name ? ' (' + esc(p.staff_name) + ')' : '')}
      — joined ${fmtLiveTs(p.joined_at)}${p.left_at ? ', left ' + fmtLiveTs(p.left_at) : ''}</li>`
  ).join('');
  const canConsentMedia = ['ACCEPTED', 'LIVE'].includes(s.status) && !(s.consent_camera && s.consent_mic);
  const rec = recording || {};
  return `
<section>
  <h1>Session ${esc(s.session_id)}</h1>
  <p class="subhead">${sessionStatusLine(s)}</p>
  ${providerBannerHtml(provider)}
  ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
  <div class="card">
    <h2>Status</h2>
    <p><strong>${esc(liveStatusLabel(s, provider))}</strong>
    ${s.dispatcher_name ? ` · Dispatcher: ${esc(s.dispatcher_name)}` : ''}</p>
    <p class="microcopy">Requested ${fmtLiveTs(s.created_at)}${s.started_at ? ' · Started ' + fmtLiveTs(s.started_at) : ''}${s.ended_at ? ' · Ended ' + fmtLiveTs(s.ended_at) : ''}</p>
    ${s.notes ? `<p><strong>Your notes:</strong> ${esc(s.notes)}</p>` : ''}
    ${s.status === 'REQUESTED' ? `<p class="microcopy">Waiting for operations to accept. ${esc(drivers.SESSION_COVERAGE_NOTE)}</p>` : ''}
  </div>
  ${mediaStateHtml(s, provider)}
  <div class="card">
    <h2>Can't use video?</h2>
    <p>Video and audio calls both need the same video provider. With no provider
    connected, <strong>provider-backed audio is also unavailable</strong> — there is no phone
    or voice-call fallback running behind this page.</p>
    <p>Use the <strong>chat below</strong> to talk with operations instead. It is part of the
    session record and works in every session state.</p>
  </div>
  ${canConsentMedia ? `<div class="card">
    <h2>Activate your camera and microphone</h2>
    <p>Your camera and microphone are currently <strong>OFF</strong>. They will not activate until you confirm here.</p>
    <form method="POST" action="/d/${esc(driver.access_token)}/go-live/${esc(s.session_id)}/consent" class="form">
      <label class="checkbox"><input type="checkbox" name="camera" value="on"> Turn on my <strong>camera</strong></label>
      <label class="checkbox"><input type="checkbox" name="mic" value="on"> Turn on my <strong>microphone</strong></label>
      <button type="submit" class="btn btn-large">I CONFIRM — ACTIVATE MY CAMERA &amp; MIC</button>
      ${provider.configured ? '' : '<p class="microcopy"><strong>SIMULATED TEST:</strong> confirming records your consent. With no provider connected, no device access is requested and no media runs.</p>'}
    </form>
  </div>` : ''}
  <div class="card">
    <h2>Location sharing</h2>
    <p>Currently: <strong>${s.share_location ? 'ON (voluntary)' : 'OFF'}</strong></p>
    <form method="POST" action="/d/${esc(driver.access_token)}/go-live/${esc(s.session_id)}/location" class="form">
      <input type="hidden" name="on" value="${s.share_location ? '0' : '1'}">
      <button type="submit" class="btn">${s.share_location ? 'Turn location sharing OFF' : 'Turn location sharing ON'}</button>
    </form>
    <p class="microcopy">Location sharing is voluntary and visibly on/off. It is never turned on without you choosing it here.</p>
  </div>
  <div class="card">
    <h2>Recording</h2>
    <p>Recording: <strong>${rec.consent_given ? 'CONSENTED — recording may be enabled by operations' : 'OFF'}</strong></p>
    ${rec.consent_given
      ? `<p class="microcopy">You consented${rec.consent_by ? ' (' + esc(rec.consent_by) + ')' : ''}${rec.consent_at ? ' at ' + fmtLiveTs(rec.consent_at) : ''}.
        ${rec.retention_expires_at ? 'Recordings are kept until ' + fmtLiveTs(rec.retention_expires_at) + ' (90-day retention).' : ''}
        <strong>No media capture is implemented in this build — nothing is being recorded.</strong></p>`
      : `<p class="microcopy">Recording is <strong>off by default</strong>. It requires your explicit opt-in consent
        <strong>before</strong> any recording may start, a visible indicator during recording, and access is restricted and logged.</p>
      <form method="POST" action="/d/${esc(driver.access_token)}/go-live/${esc(s.session_id)}/recording-consent" class="form">
        <label class="checkbox"><input type="checkbox" name="consent" value="yes" required>
          <strong>I consent</strong> to this session being recorded.</label>
        <button type="submit" class="btn">Record my consent</button>
      </form>`}
  </div>
  ${open ? `<div class="card">
    <h2>Session chat</h2>
    ${thread || '<p class="microcopy">No messages yet.</p>'}
    <form method="POST" action="/d/${esc(driver.access_token)}/go-live/${esc(s.session_id)}/message" class="form">
      <label>Message <textarea name="message" rows="2" required maxlength="2000" placeholder="Type a message to operations…"></textarea></label>
      <button type="submit" class="btn">Send</button>
    </form>
  </div>` : `<h2>Session chat</h2>${thread || '<p class="microcopy">No messages.</p>'}`}
  <h2>Session record</h2>
  <ul class="timeline">${timeline || '<li>No events.</li>'}</ul>
  ${parts ? `<h2>Participants</h2><ul>${parts}</ul>` : ''}
  ${open ? `<div class="card">
    <form method="POST" action="/d/${esc(driver.access_token)}/go-live/${esc(s.session_id)}/end" class="form"
      onsubmit="return confirm('End this session?');">
      <button type="submit" class="btn">End session</button>
    </form>
  </div>` : ''}
  <p><a href="/d/${esc(driver.access_token)}/go-live">&larr; Back to Go Live</a></p>
</section>`;
}
