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
function dashboardPage({ site, driver, dashUrl }) {
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
    ['Community', '/d/' + driver.access_token + '/community', 'Connect with other TransitNow drivers.', true],
    ['My plan', '/d/' + driver.access_token + '/plan', 'Your service plan and billing.', true],
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
  <div class="card highlight-card">
    <p><strong>Status:</strong> ${esc(drivers.ROUTE_STATUS_LABELS[route.status] || route.status)}<br>
    <strong>Scheduled:</strong> ${esc(route.scheduled_date || '—')}<br>
    <strong>Packages:</strong> ${packages.length}</p>
  </div>
  <h2>Packages (${packages.length})</h2>
  ${pkgRows || '<div class="card"><p>No packages on this route yet.</p></div>'}
  <p><a class="btn btn-large" href="/d/${esc(driver.access_token)}/scan">SCAN A PACKAGE &rarr;</a></p>
  <p><a href="/d/${esc(driver.access_token)}">&larr; Back to dashboard</a></p>
</section>`;
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
function driverPackagePage({ driver, pkg, events }) {
  const buttons = drivers.CUSTODY_EVENTS.map((e) => `
    <button type="submit" name="event_type" value="${e}" class="btn big-btn">${esc(drivers.CUSTODY_EVENT_LABELS[e]).toUpperCase()}</button>`).join('\n');
  const timeline = (events || [])
    .map(
      (ev) => `<li><strong>${esc(drivers.CUSTODY_EVENT_LABELS[ev.event_type] || ev.event_type)}</strong>
        <span class="ts">${new Date(Number(ev.ts)).toLocaleString()}${ev.driver_name ? ' · ' + esc(ev.driver_name) : ''}</span>
        ${ev.note ? `<br>${esc(ev.note)}` : ''}</li>`
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

module.exports = { onboardPage, onboardDonePage, dashboardPage, driverRoutePage, driverPackagesPage, scanPage, scanResultPage, driverPackagePage, selectField, textField, checkboxGroup };
