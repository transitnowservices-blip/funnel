// Page body templates. Each export returns inner <main> markup; the backend
// applies views/layout.js around it. No backend logic here.
'use strict';

const { esc } = require('./layout');

function hiddenSource(query) {
  const q = query || {};
  const src = esc(q.src || q.source || '');
  const cmp = esc(q.cmp || q.campaign || '');
  return `<input type="hidden" name="source" value="${src}">\n<input type="hidden" name="campaign" value="${cmp}">`;
}

function bullets(items) {
  if (!items || !items.length) return '';
  return '<ul class="bullets">\n' + items.map(b => `  <li>${esc(b)}</li>`).join('\n') + '\n</ul>';
}

function cta(href, text, extraClass) {
  return `<a class="btn ${extraClass || ''}" href="${esc(href)}">${esc(text)}</a>`;
}

// --- Landing ---
function landingPage(site, product) {
  const copy = product.salesCopy || {};
  return `
<section class="hero">
  <h1>${esc(copy.headline || '')}</h1>
  <p class="subhead">${esc(copy.subhead || '')}</p>
  ${bullets(copy.bullets)}
  ${cta('/lead', 'Get the Free Checklist', 'btn-large')}
  <p class="microcopy">Free. No card required. Unsubscribe anytime.</p>
</section>
<footer class="page-footer"><p>${esc(site.footerNote || '')}</p></footer>`;
}

// --- Lead capture ---
function leadPage(site, product, query) {
  const lm = product.leadMagnet || {};
  return `
<section>
  <h1>Get Your Free: ${esc(lm.title || '')}</h1>
  <p class="subhead">${esc(lm.description || '')}</p>
  <form method="POST" action="/lead" class="form">
    ${hiddenSource(query)}
    <label for="first_name">First name
      <input type="text" id="first_name" name="first_name" required autocomplete="given-name" placeholder="Your first name">
    </label>
    <label for="email">Email
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
    </label>
    <label for="phone">Phone <span class="optional">(optional)</span>
      <input type="tel" id="phone" name="phone" autocomplete="tel" placeholder="(optional)">
      <span class="hint">Optional — only used to contact you about this offer.</span>
    </label>
    <label class="checkbox">
      <input type="checkbox" name="consent" value="yes">
      <span>Yes, send me helpful emails about courier/dispatch opportunities. You can unsubscribe anytime.</span>
    </label>
    <button type="submit" class="btn btn-large">Send My Free Checklist</button>
  </form>
  <p class="microcopy"><a href="/privacy">How we use your information</a></p>
</section>`;
}

// --- Free value / lead magnet delivery ---
function freeValuePage(site, product, lead) {
  const lm = product.leadMagnet || {};
  const name = lead && lead.first_name ? esc(lead.first_name) : 'there';
  return `
<section>
  <h1>Thanks, ${name} — here's your checklist.</h1>
  <div class="deliverable card">
    ${lm.deliverableHtml || ''}
  </div>
  <div class="next-step">
    <h2>Want help putting this into action?</h2>
    <p>TransitNow dispatch support helps independent couriers stay organized: lane research, load-search prep, broker verification guidance, scheduling coordination, paperwork, and route planning.</p>
    ${cta('/sales', 'See How Dispatch Support Works', 'btn-large')}
  </div>
</section>`;
}

// --- Sales page ---
function salesPage(site, product) {
  const copy = product.salesCopy || {};
  return `
<section>
  <h1>${esc(copy.headline || '')}</h1>
  <p class="subhead">${esc(copy.subhead || '')}</p>
  <h2>What you get with ${esc(product.name)}</h2>
  ${bullets(copy.bullets)}
  <div class="price-box card">
    <p class="price">${esc(product.priceDisplay || '')}</p>
    <p class="billing">Monthly subscription. Cancel anytime by contacting us.</p>
    <p class="honest-note">No guaranteed loads, jobs, revenue, or broker approval — dispatch support for your independent business.</p>
    ${cta('/checkout', copy.cta || 'Continue', 'btn-large')}
  </div>
  <p class="testimonial-slot">TESTIMONIAL_SLOT (add real customer quotes here)</p>
  <p class="contact-line">Questions? Call ${esc(site.phone || '')} or email ${esc(site.email || '')}.</p>
</section>`;
}

// --- Checkout ---
function checkoutPage(site, product, lead, mode) {
  const isStripe = mode === 'stripe';
  const buttonText = isStripe
    ? 'Continue to Secure Checkout'
    : `Complete Demo Purchase (${esc(product.priceDisplay || '')} demo — no charge)`;
  const prefillName = lead && lead.first_name ? ` value="${esc(lead.first_name)}"` : '';
  const prefillEmail = lead && lead.email ? ` value="${esc(lead.email)}"` : '';
  const prefillPhone = lead && lead.phone ? ` value="${esc(lead.phone)}"` : '';
  return `
<section>
  <h1>Checkout — ${esc(product.name)}</h1>
  <p class="price-line">${esc(product.priceDisplay || '')} <span class="billing">/ month, recurring subscription</span></p>
  <form method="POST" action="/checkout" class="form">
    <label for="first_name">First name
      <input type="text" id="first_name" name="first_name" required${prefillName} autocomplete="given-name">
    </label>
    <label for="email">Email
      <input type="email" id="email" name="email" required${prefillEmail} autocomplete="email">
    </label>
    <label for="phone">Phone <span class="optional">(optional)</span>
      <input type="tel" id="phone" name="phone"${prefillPhone} autocomplete="tel">
      <span class="hint">Optional — only used to contact you about this offer.</span>
    </label>
    <button type="submit" class="btn btn-large">${buttonText}</button>
  </form>
  ${isStripe
    ? '<p class="microcopy">You will be redirected to Stripe to complete payment securely.</p>'
    : '<p class="microcopy">Demo mode: no real charge is made and no payment is collected.</p>'}
  <p class="microcopy"><a href="/privacy">How we use your information</a></p>
</section>`;
}

// --- Order bump (only rendered when product.orderBump.enabled) ---
function orderBumpPage(site, product) {
  const bump = product.orderBump || {};
  if (!bump.enabled) return '';
  return `
<section>
  <h1>Add this to your order?</h1>
  <div class="card">
    <h2>${esc(bump.name)}</h2>
    <p class="price-line">${esc(bump.priceDisplay || '')}</p>
    <p>${esc(bump.description || '')}</p>
  </div>
  <form method="POST" action="/order-bump" class="form inline-forms">
    <button type="submit" name="accept" value="yes" class="btn btn-large">Yes, add it — ${esc(bump.priceDisplay || '')}</button>
    <button type="submit" name="accept" value="no" class="btn btn-secondary">No thanks, continue</button>
  </form>
</section>`;
}

// --- Upsell (only rendered when enabled) ---
function upsellPage(site, product, upsell, which) {
  const up = upsell || {};
  if (!up.enabled) return '';
  const action = `/upsell/${esc(which || '')}`;
  return `
<section>
  <h1>One more thing before you're done</h1>
  <div class="card">
    <h2>${esc(up.name)}</h2>
    <p class="price-line">${esc(up.priceDisplay || '')}</p>
    <p><strong>What it is:</strong> ${esc(up.description || '')}</p>
    <p><strong>Why it complements your purchase:</strong> it pairs with ${esc(product.name)} to round out the support you get for your independent courier business.</p>
  </div>
  <form method="POST" action="${action}" class="form">
    <button type="submit" name="accept" value="yes" class="btn btn-large">Yes, add it — ${esc(up.priceDisplay || '')}</button>
  </form>
  <form method="POST" action="${action}" class="form">
    <button type="submit" name="accept" value="no" class="btn btn-secondary">No thanks, continue</button>
  </form>
</section>`;
}

// --- Thank you / customer access ---
function thankYouPage(site, product, lead) {
  const name = lead && lead.first_name ? esc(lead.first_name) : 'there';
  return `
<section>
  <h1>You're in, ${name}.</h1>
  <p class="subhead">Your <strong>${esc(product.name)}</strong> subscription (${esc(product.priceDisplay || '')}/month) is active.</p>
  <div class="card">
    <h2>What happens next</h2>
    <ol>
      <li><strong>Operator onboarding.</strong> We'll reach out to collect and review your business and vehicle information.</li>
      <li><strong>Dispatch setup.</strong> Lane preferences, communication setup, scheduling, and paperwork organization.</li>
      <li><strong>Ongoing support.</strong> Month-to-month dispatch support from there.</li>
    </ol>
  </div>
  <p>Questions anytime: call <strong>${esc(site.phone || '')}</strong> or email <strong>${esc(site.email || '')}</strong>.</p>
  <p class="microcopy">Manage your email preferences anytime from the link in any email we send.</p>
</section>`;
}

// --- Unsubscribe ---
function unsubscribePage(site, email) {
  const prefill = email ? ` value="${esc(email)}"` : '';
  return `
<section>
  <h1>Unsubscribe</h1>
  <p>Sorry to see you go. Enter your email to stop receiving marketing emails from ${esc(site.businessName || '')}.</p>
  <form method="POST" action="/unsubscribe" class="form">
    <label for="email">Email
      <input type="email" id="email" name="email" required${prefill} autocomplete="email">
    </label>
    <button type="submit" class="btn btn-large">Unsubscribe Me</button>
  </form>
</section>`;
}

// --- Preferences ---
function preferencesPage(site, lead) {
  const email = lead && lead.email ? esc(lead.email) : '';
  return `
<section>
  <h1>Email Preferences</h1>
  <p>Manage what we send to <strong>${email}</strong>.</p>
  <form method="POST" action="/preferences" class="form">
    <label class="checkbox">
      <input type="checkbox" name="nurture" value="yes">
      <span>Helpful tips and dispatch opportunity updates</span>
    </label>
    <label class="checkbox">
      <input type="checkbox" name="weekly_flyer" value="yes">
      <span>Weekly flyer</span>
    </label>
    <button type="submit" class="btn btn-large">Save Preferences</button>
  </form>
  <p><a href="/unsubscribe">Unsubscribe from everything</a></p>
</section>`;
}

// --- Privacy ---
function privacyPage(site) {
  return `
<section>
  <h1>Privacy Notice</h1>
  ${site.privacyNoteHtml || ''}
</section>`;
}

module.exports = {
  landingPage,
  leadPage,
  freeValuePage,
  salesPage,
  checkoutPage,
  orderBumpPage,
  upsellPage,
  thankYouPage,
  unsubscribePage,
  preferencesPage,
  privacyPage,
};
