// views/grow.js — Phase 1: Grow With TransitNow funnel, application form,
// business/RSP/dispatch/support pages, and CRM admin views.
// Each export returns inner <main> markup; server.js wraps with layout.
'use strict';

const { esc } = require('./layout');
// Phase 6: follow-up section rendered by the shared Phase-6 views module
// (extends the CRM lead profile — the profile itself is not duplicated).
const phase6Views = require('./phase6');
// Paid-client enforcement: dispatch-subscription badges on CRM lead rows.
const { subscriptionBadge } = require('./driver-admin');

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) { return escHtml(s); }

const LABELS = {
  roles: {
    'independent-driver': 'Independent driver', 'courier': 'Courier', 'delivery-driver': 'Delivery driver',
    'dispatcher': 'Dispatcher', 'transportation-business-owner': 'Transportation/logistics business owner',
    'fleet-owner': 'Fleet owner', 'rideshare-driver': 'Rideshare driver', 'medical-courier': 'Medical courier',
    'last-mile': 'Last-mile delivery', 'warehouse-logistics': 'Warehouse/logistics',
    'transportation-management': 'Transportation management', 'driver-recruiter': 'Driver recruiter',
    'driver-manager': 'Driver manager', 'business-owner': 'Business owner', 'operations': 'Operations',
    'other': 'Other',
  },
  exp: { '<6mo': 'Less than 6 months', '6-12mo': '6–12 months', '1-2y': '1–2 years', '3-5y': '3–5 years', '5+y': '5+ years', 'new': 'New to the industry' },
  vehicle: {
    'car': 'Car', 'suv': 'SUV', 'minivan': 'Minivan', 'cargo-van': 'Cargo van', 'sprinter-van': 'Sprinter van',
    'pickup-truck': 'Pickup truck', 'box-truck': 'Box truck', 'step-van': 'Step van', 'other': 'Other',
    'none': 'No vehicle currently', 'looking': 'Looking for a vehicle',
  },
  ownership: { 'own': 'Own', 'lease': 'Lease', 'company': 'Company vehicle', 'other': 'Other' },
  days: { 'mon': 'Monday', 'tue': 'Tuesday', 'wed': 'Wednesday', 'thu': 'Thursday', 'fri': 'Friday', 'sat': 'Saturday', 'sun': 'Sunday' },
  availType: { 'full-time': 'Full-time', 'part-time': 'Part-time', 'seasonal': 'Seasonal', 'on-demand': 'On-demand', 'dedicated': 'Dedicated', 'flexible': 'Flexible' },
  areaType: { 'local': 'Local', 'within-city': 'Within city', 'within-25': 'Within 25 miles', 'within-50': 'Within 50 miles', 'regional': 'Regional', 'multi-state': 'Multi-state', 'flexible': 'Flexible' },
  businessHelp: {
    'finding-routes': 'Finding routes', 'delivery-opportunities': 'Finding delivery opportunities', 'dispatch': 'Dispatch',
    'operations': 'Operations', 'driver-recruiting': 'Driver recruiting', 'driver-management': 'Driver management',
    'fleet-management': 'Fleet management', 'technology': 'Technology', 'business-development': 'Business development',
    'contract-opportunities': 'Contract opportunities', 'rsp-opportunities': 'RSP opportunities',
    'scaling': 'Scaling my business', 'other': 'Other',
  },
  growthInterests: {
    'dispatch': 'Dispatch', 'route-management': 'Route management', 'driver-recruiting': 'Driver recruiting',
    'driver-training': 'Driver training', 'operations': 'Operations', 'fleet-management': 'Fleet management',
    'customer-support': 'Customer support', 'supervisor-team-lead': 'Supervisor/team lead',
    'contract-management': 'Contract management', 'business-development': 'Business development',
    'business-ownership': 'Transportation business ownership', 'rsp-opportunities': 'RSP/business opportunities',
  },
  oppInterests: {
    'local-routes': 'Local delivery routes', 'regional-routes': 'Regional routes', 'same-day': 'Same-day delivery',
    'last-mile': 'Last-mile delivery', 'medical-courier': 'Medical/courier opportunities',
    'dedicated-routes': 'Dedicated routes', 'overflow': 'Overflow work', 'contract-opportunities': 'Contract opportunities',
    'dispatch-services': 'Dispatch services', 'building-business': 'Building a delivery business',
    'joining-team': 'Joining a delivery team', 'managing-team': 'Managing a delivery team',
    'rsp-opportunities': 'RSP opportunities', 'learning-logistics': 'Learning logistics', 'not-sure': 'Not sure yet',
  },
  readiness: {
    'license': "Valid driver's license", 'vehicle-registration': 'Vehicle registration',
    'personal-auto-insurance': 'Personal auto insurance', 'commercial-auto-insurance': 'Commercial auto insurance',
    'business-insurance': 'Business insurance', 'registered-business': 'Registered business entity',
    'ein': 'EIN', 'w9-ready': 'W-9 readiness', 'experience': 'Transportation/delivery experience',
    'background-mvr-ready': 'Background/MVR readiness', 'none-yet': 'None yet', 'not-sure': 'Not sure what I need',
  },
  futureRole: {
    'driver': 'Driver', 'dispatcher': 'Dispatcher', 'route-manager': 'Route manager', 'fleet-owner': 'Fleet owner',
    'business-owner': 'Transportation business owner', 'operations': 'Operations', 'rsp-operator': 'RSP/business operator',
    'contractor-partner': 'Contractor/partner', 'other': 'Other', 'not-sure': 'Not sure yet',
  },
  source: {
    'tiktok': 'TikTok', 'facebook': 'Facebook', 'instagram': 'Instagram', 'youtube': 'YouTube', 'google': 'Google',
    'referral': 'Referral', 'website': 'Website', 'friend-family': 'Friend/family', 'business-partner': 'Business partner',
    'other': 'Other',
  },
  contact: { 'call': 'Call', 'text': 'Text', 'email': 'Email' },
  yn: { 'yes': 'Yes', 'no': 'No' },
};

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// --- Form field builders (server-rendered, JS shows one step at a time) ---
function textField(name, label, val, opts = {}) {
  const { type = 'text', required = false, optional = false, hint = '', autocomplete = '', placeholder = '' } = opts;
  return `<label class="grow-field" for="f-${name}">${escHtml(label)}${required ? ' <span class="req">*</span>' : ''}${optional ? ' <span class="optional">(optional)</span>' : ''}
    <input type="${type}" id="f-${name}" name="${name}" value="${escAttr(val || '')}"${required ? ' required' : ''}${autocomplete ? ` autocomplete="${autocomplete}"` : ''}${placeholder ? ` placeholder="${escAttr(placeholder)}"` : ''}>
    ${hint ? `<span class="hint">${escHtml(hint)}</span>` : ''}</label>`;
}
function textArea(name, label, val, opts = {}) {
  const { required = false, rows = 4, hint = '', placeholder = '' } = opts;
  return `<label class="grow-field" for="f-${name}">${escHtml(label)}${required ? ' <span class="req">*</span>' : ''}
    <textarea id="f-${name}" name="${name}" rows="${rows}"${required ? ' required' : ''}${placeholder ? ` placeholder="${escAttr(placeholder)}"` : ''}>${escHtml(val || '')}</textarea>
    ${hint ? `<span class="hint">${escHtml(hint)}</span>` : ''}</label>`;
}
function checkGroup(name, legend, options, selected, cols = 1) {
  const sel = new Set(asArray(selected));
  const items = Object.entries(options).map(([v, label]) =>
    `<label class="check${cols > 1 ? ' check-grid' : ''}"><input type="checkbox" name="${name}" value="${escAttr(v)}"${sel.has(v) ? ' checked' : ''}><span>${escHtml(label)}</span></label>`
  ).join('\n');
  return `<fieldset class="grow-field"><legend>${escHtml(legend)}</legend><div class="check-list${cols > 1 ? ' check-cols' : ''}">${items}</div></fieldset>`;
}
function radioGroup(name, legend, options, selected, required = false) {
  const items = Object.entries(options).map(([v, label]) =>
    `<label class="check"><input type="radio" name="${name}" value="${escAttr(v)}"${selected === v ? ' checked' : ''}${required ? ' required' : ''}><span>${escHtml(label)}</span></label>`
  ).join('\n');
  return `<fieldset class="grow-field"><legend>${escHtml(legend)}</legend><div class="check-list">${items}</div></fieldset>`;
}
function selectField(name, label, options, selected, opts = {}) {
  const { required = false, includeBlank = true } = opts;
  const items = Object.entries(options).map(([v, label]) =>
    `<option value="${escAttr(v)}"${selected === v ? ' selected' : ''}>${escHtml(label)}</option>`
  ).join('\n');
  return `<label class="grow-field" for="f-${name}">${escHtml(label)}${required ? ' <span class="req">*</span>' : ''}
    <select id="f-${name}" name="${name}"${required ? ' required' : ''}>${includeBlank ? '<option value="">— Select —</option>' : ''}${items}</select></label>`;
}

function errorBox(errors) {
  if (!errors || !errors.length) return '';
  return `<div class="grow-errors" role="alert"><strong>Please fix the following:</strong><ul>${errors.map((e) => `<li>${escHtml(e)}</li>`).join('')}</ul></div>`;
}

function disclosureBox() {
  return `<p class="disclosure">Submitting this form does not guarantee employment, routes, loads, contracts, income, partnership, or acceptance into any TransitNow program. Information is collected so our team can understand your background and contact you regarding opportunities that may be relevant.</p>`;
}

module.exports = { escHtml, escAttr, LABELS, asArray, textField, textArea, checkGroup, radioGroup, selectField, errorBox, disclosureBox };

// --- /grow landing page (spec section 2 — exact copy) ---
function growLandingPage() {
  return `
<section class="hero">
  <p class="eyebrow">GROW WITH TRANSITNOW</p>
  <h1>WE'RE GROWING — COME GROW WITH US.</h1>
  <p class="subhead">TransitNow is building an actively growing courier and logistics company, and we're looking for drivers, business owners, fleet operators, dispatchers, and motivated people who want to grow with us.</p>
</section>
<section>
  <h2>If you deliver…</h2>
  <p>Tell us about your experience, your vehicle, your availability, and where you like to run. When a route or delivery opportunity fits your profile, we want to know who to call.</p>
  <h2>If you have a vehicle…</h2>
  <p>Tell us what you're driving — car, SUV, cargo van, box truck, or something bigger. Different opportunities need different equipment, and knowing what you bring helps us see where you may fit.</p>
  <h2>If you own a business…</h2>
  <p>Tell us what you've built, how many drivers and vehicles you run, and what you're trying to grow into. We're interested in real operators, not just resumes.</p>
  <h2>If dispatch interests you…</h2>
  <p>Tell us about your interest in the business side — dispatch, route management, driver recruiting, operations. Growing beyond the driver seat starts with a conversation.</p>
  <p class="lede">Tell us where you are now. Tell us what experience you have. Tell us what you have available. Tell us what you're trying to build. We'll take it from there.</p>
  <p>
    <a class="btn btn-large" href="/grow/apply">TELL US ABOUT YOU</a>
    <a class="btn btn-secondary btn-large" href="/dispatch">SEE HOW TRANSITNOW WORKS</a>
  </p>
  <p class="disclosure">Submitting this form does not guarantee employment, routes, loads, contracts, income, partnership, or acceptance into any TransitNow program. Information is collected so our team can understand your background and contact you regarding opportunities that may be relevant.</p>
</section>
${dispatchPricingSection()}`;
}

module.exports.growLandingPage = growLandingPage;

// --- Dispatch plan pricing (paid-client tiers) ----------------------------------
// Two tier cards with subscribe buttons. Stripe URLs are Davena's live links —
// never change them. Copy keeps no-guarantee language throughout.
const STRIPE_BASIC_URL = 'https://buy.stripe.com/aFa00k4uVeoUaQN00B0480n';
const STRIPE_COMPLETE_URL = 'https://buy.stripe.com/4gM4gA3qR6Ws5wt4gR0480o';

function dispatchPricingSection() {
  return `
<section id="dispatch-plans">
  <h2>Start your dispatch plan</h2>
  <p class="lede">Two ways to grow with TransitNow Dispatch. Both plans are monthly subscriptions — cancel anytime. Dispatch work is performed for paid subscribers only.</p>
  <div class="card price-box">
    <h3>Basic — Start steady</h3>
    <p class="price">$50<span class="billing">/month</span></p>
    <ul class="bullets" style="text-align:left">
      <li>Full onboarding: carrier/business and vehicle information review</li>
      <li><strong>2 fresh route matches every Monday</strong> from opportunities in your city/state</li>
      <li>Your pipeline builds week by week</li>
      <li>Weekly goal tracker</li>
      <li>Matches delivered by email and text</li>
      <li>Ongoing dispatch support</li>
    </ul>
    <p><a class="btn btn-large" href="${STRIPE_BASIC_URL}">SUBSCRIBE — BASIC $50/MO</a></p>
    <p class="honest-note">Secure checkout via Stripe.</p>
  </div>
  <div class="card price-box">
    <h3>Complete — Grow faster</h3>
    <p class="price">$100<span class="billing">/month</span></p>
    <ul class="bullets" style="text-align:left">
      <li><strong>Everything in Basic</strong>, plus:</li>
      <li><strong>5 matches on day one</strong> — a full board from the start</li>
      <li><strong>Refilled back to 5 every Monday</strong></li>
      <li><strong>Matched first</strong> — ahead of Basic in every cycle</li>
      <li>Freight and lane preferences applied to your matches</li>
      <li><strong>Private AI operations assistant</strong> — your unseen advantage, working behind the scenes</li>
      <li>Load-search prep</li>
      <li>Broker verification guidance</li>
      <li>Paperwork and route planning support</li>
    </ul>
    <p><a class="btn btn-large" href="${STRIPE_COMPLETE_URL}">SUBSCRIBE — COMPLETE $100/MO</a></p>
    <p class="honest-note">Secure checkout via Stripe.</p>
  </div>
  <p class="lede">Drivers set their own weekly goal — most aim for $750 to $1,000 — and we track assigned routes against it.</p>
  <p class="disclosure">Dispatch plans are a support service. Route matches are potential opportunities only — TransitNow does not promise or guarantee routes, loads, contracts, work, earnings, or income. Actual opportunities depend on territory, client demand, your qualifications, and availability.</p>
</section>`;
}

module.exports.dispatchPricingSection = dispatchPricingSection;

// --- /grow/apply — 13-step application (spec section 3) ---
function growApplyPage(opts = {}) {
  const { query = {}, prefill = null, resumeStep = 1, draftToken = '', errors = [] } = opts;
  const src = escAttr(query.src || query.source || (prefill && prefill.src) || '');
  const cmp = escAttr(query.cmp || query.campaign || (prefill && prefill.cmp) || '');
  // Phase 6: referral links (/grow/apply?ref=TN-XXXXXX) prefill the referral code.
  const refCode = escAttr(query.ref || (prefill && prefill.referral_code) || '');
  const prefillJson = prefill ? JSON.stringify(prefill) : 'null';

  const step = (n, title, inner) => `
  <section class="grow-step" data-step="${n}"${n === 1 ? '' : ' hidden'}>
    <h2 class="step-title">${escHtml(title)}</h2>
    ${inner}
    <div class="step-nav">
      ${n > 1 ? `<button type="button" class="btn btn-secondary step-back" data-back="${n}">← Back</button>` : ''}
      ${n < 13 ? `<button type="button" class="btn step-next" data-next="${n}">Continue →</button>`
               : `<button type="submit" class="btn btn-large">SUBMIT APPLICATION</button>`}
    </div>
  </section>`;

  return `
${errorBox(errors)}
<div class="step-header">
  <div class="step-count" id="step-count">STEP 1 OF 13</div>
  <div class="progress"><div class="progress-fill" id="progress-fill" style="width:8%"></div></div>
</div>
<form id="grow-apply" method="POST" action="/grow/apply" class="form grow-form" novalidate>
  <input type="hidden" name="src" value="${src}">
  <input type="hidden" name="cmp" value="${cmp}">
  <input type="hidden" name="draft_token" id="draft_token" value="${escAttr(draftToken)}">

${step(1, 'About You', `
  ${textField('first_name', 'First name', '', { required: true, autocomplete: 'given-name' })}
  ${textField('last_name', 'Last name', '', { autocomplete: 'family-name' })}
  ${textField('email', 'Email', '', { type: 'email', required: true, autocomplete: 'email' })}
  ${textField('phone', 'Phone', '', { type: 'tel', required: true, autocomplete: 'tel' })}
  ${radioGroup('preferred_contact', 'Preferred contact method', LABELS.contact, '')}
  ${textField('city', 'City', '', { required: true, autocomplete: 'address-level2' })}
  ${textField('state', 'State', '', { required: true, autocomplete: 'address-level1' })}
  ${textField('zip', 'ZIP', '', { autocomplete: 'postal-code' })}
  ${textArea('about_you', 'Tell us a little about yourself.', '', { rows: 4 })}
  ${textArea('why_interested', 'Why are you interested in growing with TransitNow?', '', { rows: 4 })}
`)}

${step(2, 'What Do You Currently Do?', `
  ${checkGroup('current_roles', 'Check all that apply:', LABELS.roles, [])}
  ${radioGroup('experience_level', 'How long have you been involved in transportation, delivery, logistics or business?', LABELS.exp, '')}
`)}

${step(3, 'Vehicle', `
  ${radioGroup('vehicle_type', 'What vehicle do you have available?', LABELS.vehicle, '')}
  <div id="vehicle-details">
    ${radioGroup('vehicle_ownership', 'Ownership', LABELS.ownership, '')}
    ${textField('vehicle_year', 'Year', '')}
    ${textField('vehicle_make', 'Make', '')}
    ${textField('vehicle_model', 'Model', '')}
    ${textField('cargo_capacity', 'Approx. cargo capacity', '')}
    ${textField('payload', 'Payload (if known)', '')}
    ${textArea('special_equipment', 'Special equipment', '', { rows: 3 })}
  </div>
  <p class="hint">No vehicle right now? No problem — select "No vehicle currently" or "Looking for a vehicle" and skip the details. We will never require vehicle information from people without a vehicle.</p>
`)}

${step(4, 'Availability', `
  ${checkGroup('avail_days', 'Days available:', LABELS.days, [])}
  ${textField('avail_start', 'Available start time', '', { type: 'time' })}
  ${textField('avail_end', 'Available end time', '', { type: 'time' })}
  ${selectField('avail_days_per_week', 'Days per week', { '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7' }, '')}
  ${checkGroup('avail_type', 'What type of schedule are you looking for?', LABELS.availType, [])}
  ${textArea('schedule_notes', 'Anything else about your schedule?', '', { rows: 3 })}
`)}

${step(5, 'Service Area', `
  ${checkGroup('service_area_type', 'How far are you willing to go?', LABELS.areaType, [])}
  ${textField('primary_city', 'Primary city', '')}
  ${textField('primary_state', 'Primary state', '')}
  ${textField('preferred_areas', 'Preferred service areas', '')}
  ${textField('travel_states', 'States willing to travel to', '')}
`)}

${step(6, 'Business Information', `
  ${radioGroup('has_business', 'Do you currently own or operate a business?', LABELS.yn, '')}
  <div id="biz-fields">
    ${textField('business_name', 'Business name', '')}
    ${textField('business_type', 'Business type', '')}
    ${textField('years_operating', 'Years operating', '')}
    ${textField('website', 'Website', '', { type: 'url' })}
    ${textField('business_email', 'Business email', '', { type: 'email' })}
    ${textField('num_drivers', 'Number of drivers', '')}
    ${textField('num_vehicles', 'Number of vehicles', '')}
    ${textField('service_area', 'Service area', '')}
    ${textArea('services_provided', 'Services currently provided', '', { rows: 3 })}
    ${textArea('current_clients', 'Current clients/contracts', '', { rows: 3, hint: 'Optional' })}
  </div>
  ${checkGroup('business_help', 'What would you like TransitNow to potentially help you with?', LABELS.businessHelp, [])}
`)}

${step(7, 'Beyond Driving', `
  <p>Are you interested in growing beyond simply driving? Check all that interest you:</p>
  ${checkGroup('growth_interests', 'Growth interests', LABELS.growthInterests, [])}
  ${radioGroup('managed_before', 'Have you managed drivers before?', LABELS.yn, '')}
  <div id="managed-fields">
    ${textField('managed_count', 'How many drivers have you managed?', '')}
  </div>
`)}

${step(8, 'Opportunity Interest', `
  <p>What kinds of opportunities interest you? Check all that apply:</p>
  ${checkGroup('opportunity_interests', 'Opportunity interests', LABELS.oppInterests, [])}
`)}

${step(9, 'Readiness', `
  <p>What do you already have in place? Check all that apply:</p>
  ${checkGroup('readiness', 'Documentation readiness', LABELS.readiness, [])}
  <p class="hint">We will never ask for your Social Security number, bank account numbers, passwords, or credit card numbers on this form.</p>
`)}

${step(10, 'Goals', `
  ${textArea('goals_12mo', 'What are you trying to accomplish over the next 12 months?', '', { rows: 4 })}
  ${textArea('growth_vision', 'What would growth look like for you?', '', { rows: 4 })}
  ${radioGroup('future_role', 'What role would you eventually like to have?', LABELS.futureRole, '')}
`)}

${step(11, 'Something Else', `
  ${textArea('something_else', "What is something about you, your experience, your business, or your goals that we didn't ask?", '', { rows: 6 })}
`)}

${step(12, 'How Did You Find Us?', `
  ${radioGroup('source', 'How did you hear about TransitNow?', LABELS.source, '')}
  ${textField('referral_name', 'Who referred you?', '', { hint: 'Optional' })}
  ${textField('referral_code', 'Referral code', refCode, { hint: 'Optional — if someone gave you a code, enter it here.' })}
`)}

${step(13, 'Communication', `
  ${radioGroup('contact_pref', 'How would you prefer TransitNow to contact you?', LABELS.contact, '', true)}
  <label class="check marketing-consent">
    <input type="checkbox" name="marketing_consent" value="yes">
    <span>I would like to receive TransitNow business/opportunity updates and educational information.</span>
  </label>
  <p class="hint">Operational communications (about your application and relevant opportunities) are separate from marketing updates — the checkbox above only controls marketing updates.</p>
  ${disclosureBox()}
`)}

  <div class="draft-row">
    <button type="button" id="save-draft" class="btn btn-secondary">Save &amp; Continue Later</button>
    <div id="draft-result" class="draft-result" aria-live="polite"></div>
  </div>
</form>

<script>
(function(){
  var TOTAL = 13;
  var current = ${Math.min(Math.max(Number(resumeStep) || 1, 1), 13)};
  var form = document.getElementById('grow-apply');
  var steps = Array.prototype.slice.call(form.querySelectorAll('.grow-step'));
  var countEl = document.getElementById('step-count');
  var fillEl = document.getElementById('progress-fill');

  function showStep(n){
    current = Math.min(Math.max(n, 1), TOTAL);
    steps.forEach(function(s){ s.hidden = Number(s.getAttribute('data-step')) !== current; });
    countEl.textContent = 'STEP ' + current + ' OF ' + TOTAL;
    fillEl.style.width = Math.round((current / TOTAL) * 100) + '%';
    window.scrollTo(0, 0);
    updateConditionals();
  }

  function updateConditionals(){
    var biz = form.querySelector('input[name="has_business"]:checked');
    document.getElementById('biz-fields').style.display = (biz && biz.value === 'yes') ? '' : 'none';
    var veh = form.querySelector('input[name="vehicle_type"]:checked');
    document.getElementById('vehicle-details').style.display =
      (veh && (veh.value === 'none' || veh.value === 'looking')) ? 'none' : '';
    var man = form.querySelector('input[name="managed_before"]:checked');
    document.getElementById('managed-fields').style.display = (man && man.value === 'yes') ? '' : 'none';
  }
  form.addEventListener('change', updateConditionals);

  // Prefill from a saved draft or a validation-error re-render.
  var pre = ${prefillJson};
  if (pre) {
    Object.keys(pre).forEach(function(name){
      var vals = Array.isArray(pre[name]) ? pre[name] : [pre[name]];
      form.querySelectorAll('[name="' + name.replace(/"/g, '') + '"]').forEach(function(el){
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (vals.map(String).indexOf(el.value) >= 0) el.checked = true;
        } else if (el.tagName === 'SELECT') {
          Array.prototype.forEach.call(el.options, function(o){ o.selected = vals.map(String).indexOf(o.value) >= 0; });
        } else if (el.type !== 'hidden') {
          el.value = vals[0] == null ? '' : String(vals[0]);
        }
      });
    });
    var tok = document.getElementById('draft_token');
    if (pre.draft_token && tok) tok.value = pre.draft_token;
  }

  function stepValid(n){
    var s = steps[n - 1];
    var bad = [];
    s.querySelectorAll('[required]').forEach(function(el){
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (!s.querySelector('input[name="' + el.name + '"]:checked')) bad.push(el);
      } else if (!String(el.value || '').trim()) {
        bad.push(el);
      }
    });
    return bad;
  }

  form.addEventListener('click', function(e){
    var next = e.target.closest('.step-next');
    var back = e.target.closest('.step-back');
    if (next) {
      var bad = stepValid(Number(next.getAttribute('data-next')));
      if (bad.length) {
        e.preventDefault();
        var box = document.getElementById('draft-result');
        box.textContent = 'Please complete the required fields on this step before continuing.';
        bad[0].focus();
        return;
      }
      showStep(Number(next.getAttribute('data-next')) + 1);
    } else if (back) {
      showStep(Number(back.getAttribute('data-back')) - 1);
    }
  });

  // Save & Continue Later — stores a draft server-side and returns a resume link.
  document.getElementById('save-draft').addEventListener('click', async function(){
    var box = document.getElementById('draft-result');
    box.textContent = 'Saving…';
    try {
      var fd = new FormData(form);
      fd.set('step', String(current));
      var r = await fetch('/grow/apply/draft', { method: 'POST', body: new URLSearchParams(fd) });
      var j = await r.json();
      if (j.ok) {
        document.getElementById('draft_token').value = j.token;
        var url = location.origin + j.resumeUrl;
        box.innerHTML = 'Saved! Bookmark or email yourself this private link to continue later:<br><a href="' +
          j.resumeUrl.replace(/"/g, '') + '">' + url.replace(/</g, '&lt;') + '</a>';
      } else {
        box.textContent = 'Could not save right now. Please try again.';
      }
    } catch (err) {
      box.textContent = 'Could not save right now. Please try again.';
    }
  });

  showStep(current);
})();
</script>`;
}

module.exports.growApplyPage = growApplyPage;

// --- Thank-you page (spec section 4 — exact copy) ---
function growThankYouPage(opts = {}) {
  const resub = opts.resubmission
    ? '<p class="subhead">We already had your information on file, so we updated your record with what you just sent.</p>'
    : '';
  return `
<section class="hero">
  <h1>THANK YOU FOR TELLING US ABOUT YOU.</h1>
  ${resub}
  <p class="subhead">You're officially on our radar. Our team will review the information you provided and determine whether there is a current or future opportunity that may fit your experience, vehicle, location, availability, business or goals.</p>
  <p>Keep building. Keep learning. Keep moving.</p>
  <p class="lede"><strong>TRANSITNOW LOGISTICS SERVICES</strong></p>
  <p><a class="btn btn-large" href="/">RETURN TO TRANSITNOW</a></p>
  <p class="disclosure">Submitting this form does not guarantee employment, routes, loads, contracts, income, partnership, or acceptance into any TransitNow program.</p>
</section>`;
}

// --- /business funnel (spec section 29) ---
function businessPage(opts = {}) {
  const { errors = [], values = {}, query = {} } = opts;
  const v = (n) => values[n] || '';
  const src = escAttr(query.src || query.source || '');
  const cmp = escAttr(query.cmp || query.campaign || '');
  return `
${errorBox(errors)}
<section class="hero">
  <p class="eyebrow">BUSINESSES</p>
  <h1>DELIVERY SUPPORT FOR YOUR BUSINESS.</h1>
  <p class="subhead">TransitNow works with businesses that need reliable delivery and logistics support. Tell us what you need — volume, territory, timing — and we'll see whether there may be a fit.</p>
</section>
<section>
<form method="POST" action="/business" class="form grow-form">
  <input type="hidden" name="src" value="${src}">
  <input type="hidden" name="cmp" value="${cmp}">
  ${textField('company_name', 'Company name', v('company_name'), { required: true })}
  ${textField('first_name', 'Contact first name', v('first_name'), { required: true })}
  ${textField('last_name', 'Contact last name', v('last_name'), {})}
  ${textField('email', 'Contact email', v('email'), { type: 'email', required: true })}
  ${textField('phone', 'Contact phone', v('phone'), { type: 'tel', required: true })}
  ${textField('city', 'City', v('city'), {})}
  ${textField('state', 'State', v('state'), {})}
  ${textField('business_type', 'Business type', v('business_type'), { placeholder: 'e.g. pharmacy, retailer, wholesaler' })}
  ${textArea('service_needed', 'What delivery or logistics service do you need?', v('service_needed'), { rows: 4 })}
  ${textField('delivery_volume', 'Delivery volume', v('delivery_volume'), { placeholder: 'e.g. 20 stops/day, 500 packages/week' })}
  ${textField('frequency', 'Frequency', v('frequency'), { placeholder: 'e.g. daily, weekly, on-demand' })}
  ${textField('territory', 'Territory / service area', v('territory'), {})}
  ${textArea('vehicle_requirements', 'Vehicle requirements', v('vehicle_requirements'), { rows: 3 })}
  ${textArea('driver_requirements', 'Driver requirements', v('driver_requirements'), { rows: 3 })}
  ${textField('desired_start_date', 'Desired start date', v('desired_start_date'), {})}
  ${textField('current_provider', 'Current provider (if any)', v('current_provider'), {})}
  ${textArea('problem_to_solve', 'What problem do you need solved?', v('problem_to_solve'), { rows: 4 })}
  ${textArea('additional_info', 'Anything else we should know?', v('additional_info'), { rows: 3 })}
  ${radioGroup('source', 'How did you hear about TransitNow?', LABELS.source, v('source'))}
  <label class="check marketing-consent">
    <input type="checkbox" name="marketing_consent" value="yes"${v('marketing_consent') ? ' checked' : ''}>
    <span>I would like to receive TransitNow business/opportunity updates and educational information.</span>
  </label>
  ${disclosureBox()}
  <button type="submit" class="btn btn-large">SEND BUSINESS INQUIRY</button>
</form>
</section>`;
}

function businessThankYouPage() {
  return `
<section class="hero">
  <h1>THANK YOU — WE RECEIVED YOUR INQUIRY.</h1>
  <p class="subhead">Our team will review what you sent and reach out if there may be a fit for your delivery or logistics needs.</p>
  <p>Keep building. Keep learning. Keep moving.</p>
  <p class="lede"><strong>TRANSITNOW LOGISTICS SERVICES</strong></p>
  <p><a class="btn btn-large" href="/">RETURN TO TRANSITNOW</a></p>
  <p class="disclosure">Submitting this form does not guarantee a contract, partnership, service, pricing, or acceptance into any TransitNow program.</p>
</section>`;
}

// --- /rsp funnel (spec section 18) ---
function rspPage(opts = {}) {
  const { errors = [], values = {}, query = {} } = opts;
  const v = (n) => values[n] || '';
  const src = escAttr(query.src || query.source || '');
  const cmp = escAttr(query.cmp || query.campaign || '');
  return `
${errorBox(errors)}
<section class="hero">
  <p class="eyebrow">RSP INTEREST</p>
  <h1>BUILD BEYOND THE DRIVER SEAT.</h1>
  <p class="subhead">Some people want to drive. Others want to build — a fleet, a delivery operation, a transportation business. If you're interested in growing into transportation business ownership, fleet management, or delivery operations, tell us where you are and where you want to go.</p>
</section>
<section>
<form method="POST" action="/rsp" class="form grow-form">
  <input type="hidden" name="src" value="${src}">
  <input type="hidden" name="cmp" value="${cmp}">
  ${textField('first_name', 'First name', v('first_name'), { required: true })}
  ${textField('last_name', 'Last name', v('last_name'), {})}
  ${textField('business_name', 'Business name', v('business_name'), { hint: 'If you have one — optional' })}
  ${textField('email', 'Email', v('email'), { type: 'email', required: true })}
  ${textField('phone', 'Phone', v('phone'), { type: 'tel', required: true })}
  ${textField('city', 'City', v('city'), { required: true })}
  ${textField('state', 'State', v('state'), { required: true })}
  ${textField('years_in_business', 'Years in business', v('years_in_business'), {})}
  ${textField('num_drivers', 'Number of drivers', v('num_drivers'), {})}
  ${textField('num_vehicles', 'Number of vehicles', v('num_vehicles'), {})}
  ${textField('vehicle_types', 'Vehicle types', v('vehicle_types'), { placeholder: 'e.g. cargo vans, box trucks' })}
  ${textField('insurance', 'Insurance', v('insurance'), { placeholder: 'What coverage do you carry?' })}
  ${textArea('delivery_experience', 'Delivery experience', v('delivery_experience'), { rows: 3 })}
  ${textField('service_area', 'Service area', v('service_area'), {})}
  ${textArea('can_manage_drivers', 'Ability to hire and manage drivers', v('can_manage_drivers'), { rows: 3 })}
  ${textArea('technology_experience', 'Technology experience', v('technology_experience'), { rows: 3, hint: 'Apps, routing software, scanning tools, etc.' })}
  ${textArea('capital_readiness', 'Capital/resources readiness', v('capital_readiness'), { rows: 3 })}
  ${textArea('contracting_experience', 'Contracting experience', v('contracting_experience'), { rows: 3 })}
  ${textArea('current_business_model', 'Current business model', v('current_business_model'), { rows: 3 })}
  ${textArea('why_interested', 'Why are you interested in RSP/business opportunities?', v('why_interested'), { rows: 4 })}
  ${textArea('future_goals', 'Future goals', v('future_goals'), { rows: 4 })}
  ${radioGroup('source', 'How did you hear about TransitNow?', LABELS.source, v('source'))}
  <label class="check marketing-consent">
    <input type="checkbox" name="marketing_consent" value="yes"${v('marketing_consent') ? ' checked' : ''}>
    <span>I would like to receive TransitNow business/opportunity updates and educational information.</span>
  </label>
  <p class="disclosure">Submitting an RSP interest form does not guarantee an RSP territory, contract, route, partnership, income or acceptance.</p>
  <button type="submit" class="btn btn-large">SUBMIT RSP INTEREST</button>
</form>
</section>`;
}

function rspThankYouPage() {
  return `
<section class="hero">
  <h1>THANK YOU FOR YOUR INTEREST.</h1>
  <p class="subhead">We received your RSP interest form. Our team will review it and reach out if there may be a relevant opportunity.</p>
  <p>Keep building. Keep learning. Keep moving.</p>
  <p class="lede"><strong>TRANSITNOW LOGISTICS SERVICES</strong></p>
  <p><a class="btn btn-large" href="/">RETURN TO TRANSITNOW</a></p>
  <p class="disclosure">Submitting an RSP interest form does not guarantee an RSP territory, contract, route, partnership, income or acceptance.</p>
</section>`;
}

// --- /dispatch funnel (spec section 30) ---
function dispatchPage(opts = {}) {
  const { errors = [], values = {}, query = {} } = opts;
  const v = (n) => values[n] || '';
  const src = escAttr(query.src || query.source || '');
  const cmp = escAttr(query.cmp || query.campaign || '');
  return `
${errorBox(errors)}
<section class="hero">
  <p class="eyebrow">DISPATCH SERVICES</p>
  <h1>ORGANIZE THE BUSINESS SIDE OF DELIVERY.</h1>
  <p class="subhead">TransitNow Dispatch Services helps transportation operators organize the business side of finding and managing legitimate delivery opportunities.</p>
</section>
<section>
  <h2>What dispatch support covers</h2>
  <ul class="bullets">
    <li>Freight and load sourcing research</li>
    <li>Route research and load matching</li>
    <li>Broker and carrier verification support</li>
    <li>Rate negotiation support</li>
    <li>Route planning</li>
    <li>Pickup and delivery coordination</li>
    <li>Dispatch communication</li>
    <li>Paperwork support</li>
    <li>Operational support</li>
  </ul>
  <p class="disclosure">No guaranteed loads, routes, contracts or earnings. Dispatch support is an organizational and administrative service — actual opportunities depend on territory, client demand, qualifications and availability.</p>
  <h2>Get dispatch information</h2>
  <p>Tell us how to reach you and what you're operating, and we'll send you information about TransitNow dispatch support.</p>
  <form method="POST" action="/dispatch" class="form grow-form">
    <input type="hidden" name="src" value="${src}">
    <input type="hidden" name="cmp" value="${cmp}">
    ${textField('first_name', 'First name', v('first_name'), { required: true })}
    ${textField('last_name', 'Last name', v('last_name'), {})}
    ${textField('email', 'Email', v('email'), { type: 'email', required: true })}
    ${textField('phone', 'Phone', v('phone'), { type: 'tel', required: true })}
    ${textField('city', 'City', v('city'), {})}
    ${textField('state', 'State', v('state'), {})}
    ${radioGroup('vehicle_type', 'What are you operating?', LABELS.vehicle, v('vehicle_type'))}
    ${textArea('about_you', 'What are you running and what do you need help with?', v('about_you'), { rows: 4 })}
    ${radioGroup('source', 'How did you hear about TransitNow?', LABELS.source, v('source'))}
    <label class="check marketing-consent">
      <input type="checkbox" name="marketing_consent" value="yes"${v('marketing_consent') ? ' checked' : ''}>
      <span>I would like to receive TransitNow business/opportunity updates and educational information.</span>
    </label>
    <p class="disclosure">No guaranteed loads, routes, contracts or earnings.</p>
    <button type="submit" class="btn btn-large">GET DISPATCH INFORMATION</button>
  </form>
</section>
${dispatchPricingSection()}`;
}

function dispatchThankYouPage() {
  return `
<section class="hero">
  <h1>THANK YOU — DISPATCH INFO ON THE WAY.</h1>
  <p class="subhead">We received your request. Our team will follow up with information about TransitNow dispatch support.</p>
  <p class="disclosure">No guaranteed loads, routes, contracts or earnings.</p>
  <p><a class="btn btn-large" href="/">RETURN TO TRANSITNOW</a></p>
</section>`;
}

// --- /support (public; does not claim 24/7 human staffing) ---
function supportPage() {
  return `
<section class="hero">
  <p class="eyebrow">SUPPORT</p>
  <h1>WE'RE HERE TO HELP.</h1>
  <p class="subhead">Choose the option that fits your situation.</p>
</section>
<section>
  <h2>Active TransitNow drivers</h2>
  <p>If you're an active driver, the fastest help is inside your driver dashboard: open a support ticket, report an exception, or use the support section any time. Our software accepts and routes requests around the clock.</p>
  <p><a class="btn" href="/drivers/onboard">Driver onboarding</a></p>
  <h2>Applicants and general questions</h2>
  <p>Questions about an application, a business inquiry, or dispatch services? Reach us through the <a href="/contact">contact page</a> and we'll get back to you.</p>
  <h2>Emergencies</h2>
  <p><strong>For immediate danger or emergency situations, contact emergency services first.</strong></p>
  <p class="disclosure">TransitNow's support software may accept and route requests 24/7. This is not a claim that human staff are available 24/7.</p>
</section>`;
}

module.exports.growThankYouPage = growThankYouPage;
module.exports.businessPage = businessPage;
module.exports.businessThankYouPage = businessThankYouPage;
module.exports.rspPage = rspPage;
module.exports.rspThankYouPage = rspThankYouPage;
module.exports.dispatchPage = dispatchPage;
module.exports.dispatchThankYouPage = dispatchThankYouPage;
module.exports.supportPage = supportPage;

// --- Admin CRM views (spec sections 7-8) ---
function crmPipelineHtml(opts = {}) {
  const { grouped = {}, counts = {}, type = '', status = '', paid = 'all', types = [], allStatuses = [], subsByEmail = {} } = opts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const statusOrder = allStatuses.length ? allStatuses : Object.keys(grouped);
  const groups = statusOrder.map((s) => `
    <div class="crm-group">
      <h3><span class="admin-status-pill">${escHtml(s)}</span> <span class="muted">(${(grouped[s] || []).length})</span></h3>
      ${(grouped[s] || []).length ? `<table class="admin-table"><thead><tr><th>Name</th><th>Type</th><th>Contact</th><th>Location</th><th>Received</th><th>Subscription</th><th>Assigned</th></tr></thead><tbody>` +
        grouped[s].map((l) => {
          const sub = subsByEmail[String(l.email || '').toLowerCase()] || null;
          return `<tr>
          <td><a href="/admin/crm/leads/${l.id}">${escHtml(l.first_name)} ${escHtml(l.last_name)}</a></td>
          <td>${escHtml(l.lead_type)}</td>
          <td>${escHtml(l.email)}<br>${escHtml(l.phone)}</td>
          <td>${escHtml(l.city)}, ${escHtml(l.state)}</td>
          <td>${l.created_at ? new Date(Number(l.created_at)).toLocaleDateString() : ''}</td>
          <td>${subscriptionBadge(sub)}</td>
          <td>${escHtml(l.assigned_to || '—')}</td>
        </tr>`;
        }).join('') + '</tbody></table>'
        : '<p class="muted">No leads in this stage.</p>'}
    </div>`).join('\n');
  return `
<h2>Opportunity Pipeline</h2>
<p class="muted">${total} total lead${total === 1 ? '' : 's'}${type ? ` · type ${escHtml(type)}` : ''}${status ? ` · status ${escHtml(status)}` : ''}${paid && paid !== 'all' ? ` · subscription ${escHtml(paid)}` : ''}</p>
<form class="filter-form" method="GET" action="/admin/crm">
  <select name="type" aria-label="Lead type">
    <option value="">All types</option>
    ${types.map((t) => `<option value="${escAttr(t)}"${type === t ? ' selected' : ''}>${escHtml(t)}</option>`).join('')}
  </select>
  <select name="status" aria-label="Status">
    <option value="">All statuses</option>
    ${allStatuses.map((s) => `<option value="${escAttr(s)}"${status === s ? ' selected' : ''}>${escHtml(s)}</option>`).join('')}
  </select>
  <select name="paid" aria-label="Dispatch subscription">
    <option value="all"${paid === 'all' ? ' selected' : ''}>All subscriptions</option>
    <option value="paid"${paid === 'paid' ? ' selected' : ''}>Paid clients</option>
    <option value="attention"${paid === 'attention' ? ' selected' : ''}>Needs attention</option>
  </select>
  <button type="submit" class="btn">Filter</button>
</form>
${groups}`;
}

function fmtList(json, map) {
  try {
    const a = JSON.parse(json || '[]');
    if (!a.length) return '—';
    return a.map((x) => escHtml((map && map[x]) || x)).join(', ');
  } catch { return '—'; }
}
function row(label, value) {
  if (value == null || value === '') return '';
  return `<tr><th>${escHtml(label)}</th><td>${value}</td></tr>`;
}
function plain(v) { return escHtml(v || '—'); }

function crmLeadProfileHtml(p, opts = {}) {
  const { lead, vehicle, business, goals, sources, history, notes, comms, tags } = p;
  const { pipelines = {}, internalTags = [], error = '' } = opts;
  // Phase 2 (additive): driver-application linkage + potential matches.
  const { driverLink = null, matches = [], opportunities = [], linkedJustNow = false } = opts;
  const allowed = pipelines[lead.lead_type] || [];
  const tagNames = tags.map((t) => t.tag);
  const profileLink = `/admin/crm/leads/${lead.id}`;

  const driverAppCard = (() => {
    const justLinked = linkedJustNow
      ? '<p><strong>Driver application started.</strong> The lead is now linked to a driver record below — no duplicate record was created.</p>'
      : '';
    if (driverLink && driverLink.driver) {
      const d = driverLink.driver;
      return `${justLinked}
      <p>Linked to driver <a href="/admin/drivers/${d.id}/profile"><strong>${escHtml(d.full_name)}</strong></a>
      (${escHtml(d.email)} · application: ${escHtml(d.extended_status || 'not started')}) —
      linked ${driverLink.created_at ? new Date(Number(driverLink.created_at)).toLocaleString() : '—'} by ${escHtml(driverLink.created_by || '')}.</p>
      <p>Extended application link (share with the candidate):<br>
      <span class="dash-link"><a href="/drivers/apply/${escAttr(d.access_token)}">/drivers/apply/${escAttr(d.access_token)}</a></span></p>
      <p class="microcopy">Starting another application reuses this same driver record — it never creates a duplicate.</p>`;
    }
    return `${justLinked}
    <form method="POST" action="${profileLink}/start-driver-application" class="filter-form">
      <button type="submit" class="btn">Start driver application</button>
    </form>
    <p class="microcopy">Links this lead to a driver record (reuses the existing driver if the email is already known — never duplicates) so the candidate can complete the extended driver application. Typically used when the lead reaches <strong>DRIVER READY</strong>.</p>`;
  })();

  const matchSection = (() => {
    const rows = (matches || []).map((m) => {
      const o = (opportunities || []).find((x) => x.id === m.opportunity_id);
      return `<tr><td><span class="admin-status-pill">Potential Match</span></td>
        <td>${o ? `<a href="/admin/opportunities/${o.id}"><strong>${escHtml(o.name)}</strong></a>` : 'opportunity #' + m.opportunity_id}</td>
        <td>${escHtml(m.matched_by || '—')}<br><span class="muted">${m.ts ? new Date(Number(m.ts)).toLocaleString() : '—'}</span></td>
        <td>${escHtml(m.note || '')}</td></tr>`;
    }).join('');
    const oppOpts = (opportunities || []).map((o) =>
      `<option value="${o.id}">${escAttr(o.name)} — ${escAttr(o.status)}</option>`).join('');
    return `
    <table class="admin-table"><thead><tr><th>Result</th><th>Opportunity</th><th>Matched by / when</th><th>Note</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No potential matches recorded for this lead.</td></tr>'}</tbody></table>
    ${oppOpts ? `
    <form method="POST" action="${profileLink}/match" class="filter-form">
      <select name="opportunity_id" aria-label="Opportunity">${oppOpts}</select>
      <input type="text" name="note" placeholder="Why this looks like a fit (optional)" style="min-height:44px;flex:1;min-width:200px">
      <button type="submit" class="btn">Record Potential Match</button>
    </form>
    <p class="microcopy"><strong>A "Potential Match" is not an offer or promise of employment, routes, loads, contracts, partnership, or income.</strong></p>`
      : '<p class="muted">Create an opportunity first to record matches.</p>'}`;
  })();

  const statusForm = `
  <form method="POST" action="${profileLink}/status" class="filter-form">
    <select name="status" aria-label="New status">
      ${allowed.map((s) => `<option value="${escAttr(s)}"${lead.status === s ? ' selected' : ''}>${escHtml(s)}</option>`).join('')}
    </select>
    <input type="text" name="note" placeholder="Status change note (optional)" style="min-height:44px;flex:1;min-width:200px">
    <button type="submit" class="btn">Change status</button>
  </form>`;

  const tagForm = `
  <form method="POST" action="${profileLink}/tags" class="filter-form">
    ${internalTags.map((t) => `<label class="check"><input type="checkbox" name="tags" value="${escAttr(t)}"${tagNames.includes(t) ? ' checked' : ''}><span>${escHtml(t)}</span></label>`).join('')}
    <button type="submit" class="btn">Save tags</button>
  </form>`;

  const noteForm = `
  <form method="POST" action="${profileLink}/note" class="filter-form">
    <input type="text" name="note" placeholder="Add an internal note…" required style="min-height:44px;flex:1;min-width:200px">
    <button type="submit" class="btn">Add note</button>
  </form>`;

  // Phase 6 (additive): full follow-up system replaces the basic follow-up
  // form. Shows last contact, next follow-up, assigned staff, notes, contact
  // attempts, outcome, reminders, and any referral attribution for the lead.
  const { followupHistory = [], attempts = 0, followupLatest = null, referralAttr = null } = opts;
  const followupSection = phase6Views.leadFollowupHtml({
    lead, latest: followupLatest, history: followupHistory, attempts, referralAttr,
  });

  return `
<p><a href="/admin/crm">← Back to pipeline</a></p>
${error ? `<div class="grow-errors" role="alert">${escHtml(error)}</div>` : ''}
<h2>${escHtml(lead.first_name)} ${escHtml(lead.last_name)} <span class="admin-status-pill">${escHtml(lead.status)}</span></h2>
<p class="muted">Type: ${escHtml(lead.lead_type)} · Received: ${lead.created_at ? new Date(Number(lead.created_at)).toLocaleString() : '—'}${lead.updated_at && lead.updated_at !== lead.created_at ? ` · Updated: ${new Date(Number(lead.updated_at)).toLocaleString()}` : ''}</p>

<h3>Status</h3>
${statusForm}

<h3>Driver application</h3>
<div class="card">
${driverAppCard}
</div>

<h3>Contact &amp; location</h3>
<table class="admin-table"><tbody>
${row('Email', plain(lead.email))}
${row('Phone', `${plain(lead.phone)} (prefers ${plain(lead.preferred_contact)})`)}
${row('City / State / ZIP', `${plain(lead.city)} / ${plain(lead.state)} / ${plain(lead.zip)}`)}
${row('About', escHtml(lead.about_you).replace(/\n/g, '<br>') || '—')}
${row('Why interested', escHtml(lead.why_interested).replace(/\n/g, '<br>') || '—')}
</tbody></table>

<h3>Experience &amp; availability</h3>
<table class="admin-table"><tbody>
${row('Current roles', fmtList(lead.current_roles, LABELS.roles))}
${row('Experience level', plain(LABELS.exp[lead.experience_level] || lead.experience_level))}
${row('Availability', `${fmtList(lead.avail_days, LABELS.days)} ${plain(lead.avail_start)}–${plain(lead.avail_end)} (${fmtList(lead.avail_type, LABELS.availType)})`)}
${row('Days per week', plain(lead.avail_days_per_week))}
${row('Schedule notes', escHtml(lead.schedule_notes) || '—')}
${row('Service area', `${fmtList(lead.service_area_type, LABELS.areaType)} — ${plain(lead.primary_city)}, ${plain(lead.primary_state)}`)}
${row('Preferred areas', plain(lead.preferred_areas))}
${row('Travel states', plain(lead.travel_states))}
</tbody></table>

<h3>Vehicle</h3>
<table class="admin-table"><tbody>
${row('Vehicle', `${plain(lead.vehicle_year)} ${plain(lead.vehicle_make)} ${plain(lead.vehicle_model)} — ${plain(LABELS.vehicle[lead.vehicle_type] || lead.vehicle_type)} (${plain(LABELS.ownership[lead.vehicle_ownership] || lead.vehicle_ownership)})`)}
${row('Cargo capacity', plain(lead.cargo_capacity))}
${row('Payload', plain(lead.payload))}
${row('Special equipment', plain(lead.special_equipment))}
</tbody></table>

<h3>Business</h3>
<table class="admin-table"><tbody>
${row('Owns/operates a business', plain(lead.has_business))}
${business && lead.has_business === 'yes' ? `
${row('Business name', plain(business.business_name))}
${row('Business type', plain(business.business_type))}
${row('Years operating', plain(business.years_operating))}
${row('Website', plain(business.website))}
${row('Business email', plain(business.business_email))}
${row('Drivers / vehicles', `${plain(business.num_drivers)} / ${plain(business.num_vehicles)}`)}
${row('Service area', plain(business.service_area))}
${row('Services provided', plain(business.services_provided))}
${row('Current clients/contracts', plain(business.current_clients))}
` : ''}
${row('Wants help with', fmtList(lead.business_help, LABELS.businessHelp))}
${row('Growth interests', fmtList(lead.growth_interests, LABELS.growthInterests))}
${row('Managed drivers before', lead.managed_before === 'yes' ? `Yes (${plain(lead.managed_count)})` : plain(lead.managed_before))}
</tbody></table>

<h3>Opportunities, readiness &amp; goals</h3>
<table class="admin-table"><tbody>
${row('Opportunity interests', fmtList(lead.opportunity_interests, LABELS.oppInterests))}
${row('Readiness', fmtList(lead.readiness, LABELS.readiness))}
${row('Goals (12 mo)', escHtml(goals && goals.goals_12mo ? goals.goals_12mo : lead.goals_12mo).replace(/\n/g, '<br>') || '—')}
${row('Growth vision', escHtml(goals && goals.growth_vision ? goals.growth_vision : lead.growth_vision).replace(/\n/g, '<br>') || '—')}
${row('Future role', plain(LABELS.futureRole[(goals && goals.future_role) || lead.future_role] || (goals && goals.future_role) || lead.future_role))}
${row('Something else', escHtml(lead.something_else).replace(/\n/g, '<br>') || '—')}
</tbody></table>

<h3>Source &amp; consent</h3>
<table class="admin-table"><tbody>
${row('Source', plain(LABELS.source[(sources && sources.source) || lead.source] || (sources && sources.source) || lead.source))}
${row('Referred by', plain((sources && sources.referral_name) || lead.referral_name))}
${row('Referral code', plain((sources && sources.referral_code) || lead.referral_code))}
${row('Marketing consent', lead.marketing_consent ? 'Yes' : 'No')}
</tbody></table>

<h3>Internal tags (admin only)</h3>
${tagForm}

${followupSection}

<h3>Potential matches</h3>
${matchSection}

<h3>Notes</h3>
${noteForm}
${notes.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Author</th><th>Note</th></tr></thead><tbody>` +
  notes.map((n) => `<tr><td>${new Date(Number(n.ts)).toLocaleString()}</td><td>${escHtml(n.author)}</td><td>${escHtml(n.note)}</td></tr>`).join('') +
  '</tbody></table>' : '<p class="muted">No notes yet.</p>'}

<h3>Status history (append-only)</h3>
${history.length ? `<table class="admin-table"><thead><tr><th>When</th><th>From</th><th>To</th><th>By</th><th>Note</th></tr></thead><tbody>` +
  history.map((h) => `<tr><td>${new Date(Number(h.ts)).toLocaleString()}</td><td>${escHtml(h.from_status || '—')}</td><td>${escHtml(h.to_status)}</td><td>${escHtml(h.changed_by)}</td><td>${escHtml(h.note || '')}</td></tr>`).join('') +
  '</tbody></table>' : '<p class="muted">No history yet.</p>'}

<h3>Communications</h3>
${comms.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Kind</th><th>Direction</th><th>Subject</th></tr></thead><tbody>` +
  comms.map((c) => `<tr><td>${new Date(Number(c.ts)).toLocaleString()}</td><td>${escHtml(c.kind)}</td><td>${escHtml(c.direction)}</td><td>${escHtml(c.subject || '')}</td></tr>`).join('') +
  '</tbody></table>' : '<p class="muted">No communications logged yet.</p>'}`;
}

module.exports.crmPipelineHtml = crmPipelineHtml;
module.exports.crmLeadProfileHtml = crmLeadProfileHtml;
