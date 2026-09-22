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

// --- Wealth Builder's Room: join landing page ---
function roomJoinPage(site) {
  const modules = [
    ['00 — START HERE', 'Get oriented, learn how the Room works, and set up your starting point.'],
    ['01 — WEALTH MINDSET, HABITS & DECISIONS', 'Build the thinking patterns and daily habits that support better money decisions.'],
    ['02 — MONEY MANAGEMENT & CASH FLOW', 'Learn to track, plan, and direct your cash flow so your money has a job.'],
    ['03 — ASSETS, INVESTING & OWNERSHIP', 'Understand assets, investing basics, and what it means to own something that can grow.'],
    ['04 — THE 90-DAY WEALTH ACTION PLAN', 'Turn everything you have learned into one organized, step-by-step 90-day execution plan.'],
  ];
  return `
<section class="hero">
  <h1>Your Ideas Can Become Income. Your Income Can Become Wealth.</h1>
  <p class="subhead">The Wealth Builder's Room helps you turn your ideas, skills, opportunities, and resources into an organized 90-day plan for building income, business, ownership, and long-term wealth.</p>
  ${cta('/room/start', 'JOIN THE WEALTH BUILDER\'S ROOM — $49/MONTH', 'btn-large')}
  ${cta('/room/offer', 'SEE WHAT\'S INSIDE', 'btn-secondary btn-large')}
</section>
<section>
  <h2>This Room Is For You If...</h2>
  ${bullets([
    'You have ideas but need a clear plan.',
    'You want to turn your skills into income.',
    'You are trying to build a business but feel scattered.',
    'You want to understand money, cash flow, assets, and ownership.',
    'You need accountability instead of another pile of information.',
    'You want to stop starting over and start executing.',
    'You want to build something that can grow beyond one paycheck.',
  ])}
</section>
<section>
  <h2>What You'll Build</h2>
  <div class="module-list">
${modules.map(([t, d]) => `    <div class="module card">\n      <p class="module-title">${esc(t)}</p>\n      <p class="module-desc">${esc(d)}</p>\n    </div>`).join('\n')}
  </div>
</section>
<section>
  <h2>What Your $49/Month Includes</h2>
  ${bullets([
    'Access to Wealth Builder\'s Room',
    'Wealth-building education',
    'Action plans',
    'Community/accountability',
    'Business and income-building discussions',
    'Money management and cash-flow education',
    'Asset and ownership education',
    '90-day execution planning',
    'New resources/posts as they are added',
    'A place to organize your next wealth-building moves',
  ])}
</section>
<section>
  <h2>This Is Not About Getting Rich Quick.</h2>
  <p>This is about learning how to make better decisions with the ideas, skills, money, opportunities, and resources you already have — then putting those decisions into action.</p>
</section>
<section>
  ${cta('/room/start', 'START BUILDING — $49/MONTH', 'btn-large')}
</section>
<footer class="page-footer"><p>${esc(site.footerNote || '')}</p></footer>`;
}

// --- Wealth Builder's Room: lead capture ---
function roomStartPage(site, query, error) {
  const options = [
    ['extra-income', 'Extra income'],
    ['a-business', 'A business'],
    ['money-management', 'Better money management'],
    ['credit-improvement', 'Credit improvement'],
    ['investing-ownership', 'Investing/ownership'],
    ['multiple-income-streams', 'Multiple income streams'],
    ['idea-needs-plan', 'I have an idea but need a plan'],
    ['courier-work', 'Courier/delivery work (routes, dispatch)'],
    ['not-sure', "I'm not sure yet"],
  ];
  return `
<section>
  <h1>Get Started With the Wealth Builder's Room</h1>
  <p class="subhead">Tell us where to reach you and what you're working toward. We'll follow up with your next step.</p>
  ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
  <form method="POST" action="/room/start" class="form">
    ${hiddenSource(query)}
    <label for="room_first_name">First Name
      <input type="text" id="room_first_name" name="first_name" required autocomplete="given-name" placeholder="Your first name">
    </label>
    <label for="room_email">Email Address
      <input type="email" id="room_email" name="email" required autocomplete="email" placeholder="you@example.com">
    </label>
    <label for="room_phone">Phone Number <span class="optional">(optional)</span>
      <input type="tel" id="room_phone" name="phone" autocomplete="tel" placeholder="(optional)">
    </label>
    <label for="room_goal">What are you trying to build right now?
      <select id="room_goal" name="goal">
        ${options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('\n        ')}
      </select>
    </label>
    <label class="checkbox">
      <input type="checkbox" name="consent" value="yes">
      <span>Yes, send me Wealth Builder's Room information and helpful wealth-building resources. You can unsubscribe anytime.</span>
    </label>
    <button type="submit" class="btn btn-large">CONTINUE &rarr;</button>
  </form>
  <p class="microcopy"><a href="/privacy">How we use your information</a></p>
</section>`;
}

// --- Wealth Builder's Room: offer / sales page ---
function roomOfferPage(site) {
  const modules = [
    '00 Start Here',
    '01 Wealth Mindset, Habits & Decisions',
    '02 Money Management & Cash Flow',
    '03 Assets, Investing & Ownership',
    '04 The 90-Day Wealth Action Plan',
  ];
  return `
<section>
  <h1>Stop Collecting Ideas. Start Building.</h1>
  <p class="subhead">You don't need another hundred ideas. You need a system for deciding what to do, taking action, measuring what happens, and building from there.</p>
  <h2>What's Inside</h2>
  ${bullets(modules)}
  <p>The goal is not to overwhelm you with information. The goal is to help you move.</p>
  <div class="price-box card">
    <p class="price">$49<span class="billing">/month</span></p>
    <p class="billing">Recurring membership. Cancel according to the subscription terms presented at checkout.</p>
    <p class="honest-note">Education and planning support — not financial advice, and no guaranteed income or results.</p>
    ${cta('/room/checkout', 'JOIN THE ROOM FOR $49/MONTH', 'btn-large')}
  </div>
  <p class="contact-line">Questions? Call ${esc(site.phone || '')} or email ${esc(site.email || '')}.</p>
</section>`;
}

// --- Terms ---
function termsPage(site) {
  return `
<section>
  <h1>Terms of Service</h1>
  <p><strong>${esc(site.businessName || '')}</strong> provides the Wealth Builder's Room as an educational membership program.</p>
  <h2>Membership</h2>
  <p>Membership is a recurring monthly subscription billed at the rate shown at checkout (currently $49/month). Membership renews each month until you cancel. See our <a href="/refund">Refund &amp; Cancellation Policy</a> for how to cancel.</p>
  <h2>What this is</h2>
  <p>The Wealth Builder's Room provides wealth-building education, action plans, community discussion, and planning resources. Content is for general educational purposes only. It is not financial, investment, legal, or tax advice, and we do not promise or guarantee income, earnings, or any specific result.</p>
  <h2>Your responsibility</h2>
  <p>How you use the information, and the decisions you make with it, are your responsibility. You agree to use the membership in a lawful manner and to treat other members respectfully.</p>
  <h2>Changes</h2>
  <p>We may update these terms from time to time. Continued use of the membership after changes are posted means you accept them.</p>
  <p>Questions: call <strong>${esc(site.phone || '')}</strong> or email <strong>${esc(site.email || '')}</strong>.</p>
</section>`;
}

// --- Refund & cancellation ---
function refundPage(site) {
  return `
<section>
  <h1>Refund &amp; Cancellation Policy</h1>
  <h2>Wealth Builder's Room — $49/month recurring membership</h2>
  <p>You can cancel your membership according to the subscription terms presented at checkout. After cancellation, you will not be billed for future months, and your access continues until the end of the current billing period.</p>
  <p>Monthly membership charges are generally non-refundable once billed, because access begins immediately. If you believe a charge was made in error, contact us and we will review it.</p>
  <h2>Need help canceling?</h2>
  <p>Call <strong>${esc(site.phone || '')}</strong> or email <strong>${esc(site.email || '')}</strong> and we will help you cancel your membership.</p>
</section>`;
}

// --- Contact ---
function contactPage(site) {
  return `
<section>
  <h1>Contact Us</h1>
  <p>Questions about the Wealth Builder's Room, your membership, or billing? Reach out — we're happy to help.</p>
  <div class="card">
    <p><strong>Email:</strong> <a href="mailto:${esc(site.email || '')}">${esc(site.email || '')}</a></p>
    <p><strong>Phone:</strong> <a href="tel:${esc((site.phone || '').replace(/[^0-9+]/g, ''))}">${esc(site.phone || '')}</a></p>
    <p><strong>Business:</strong> ${esc(site.businessName || '')}</p>
  </div>
  <p class="microcopy">We respond during business hours. For membership cancellation help, see our <a href="/refund">Refund &amp; Cancellation Policy</a>.</p>
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
  roomJoinPage,
  roomStartPage,
  roomOfferPage,
  termsPage,
  refundPage,
  contactPage,
};
