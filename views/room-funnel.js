// Page body templates for The Wealth Builder's Room purchase funnel.
// Each export returns inner <main> markup; the backend applies views/layout.js
// around it. The backend owns all Stripe redirects server-side (product.stripeLink
// is never rendered into markup here). No income or results promises anywhere.
'use strict';

const { esc } = require('./layout');

function included(items) {
  if (!items || !items.length) return '';
  return '<ul class="bullets">\n' + items.map(b => `  <li>${esc(b)}</li>`).join('\n') + '\n</ul>';
}

// --- Room checkout: order review + disclosure before Stripe ---
function roomCheckoutPage({ product, site }) {
  const p = product || {};
  const s = site || {};
  const name = esc(p.name || "The Wealth Builder's Room");
  const price = esc(p.priceDisplay || '$49/month');
  const bullets = p.salesCopy && p.salesCopy.bullets && p.salesCopy.bullets.length
    ? p.salesCopy.bullets
    : [
        "Room access: the private Wealth Builder's Room membership area",
        'Wealth-building education across the 7 wealth pillars',
        '90-day action plan with progress tracking',
        'Community & accountability with fellow members',
      ];
  return `
<section>
  <h1>Checkout — ${name}</h1>
  <p class="subhead">WEALTH BUILDER'S ROOM &middot; ${price} &middot; Recurring subscription.</p>
  <div class="price-box card">
    <p class="price">${price}</p>
    <p class="billing">$49/month recurring membership. Recurring subscription — you can cancel anytime by contacting us.</p>
  </div>
  <h2>What's included</h2>
  ${included(bullets)}
  <p class="honest-note">Wealth education is provided for informational and educational purposes and is not individualized financial, legal, tax, or investment advice. No specific income or results are guaranteed.</p>
  <form method="POST" action="/room/checkout" class="form">
    <label for="email">Email
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
      <span class="hint">We use your email to tie this order to you and send your welcome message.</span>
    </label>
    <button type="submit" class="btn btn-large">CONTINUE TO SECURE CHECKOUT &rarr;</button>
  </form>
  <p class="microcopy">You will be redirected to Stripe to complete payment securely.</p>
  <p class="contact-line">Questions? Call ${esc(s.phone || '')} or email ${esc(s.email || '')}.</p>
</section>`;
}

// --- Payment success: shown after Stripe payment completes ---
function paymentSuccessPage({ product }) {
  const p = product || {};
  const name = esc(p.name || "The Wealth Builder's Room");
  // TransitNow dispatch products route into driver onboarding (additive branch;
  // the Room flow below is unchanged).
  if (p.id && String(p.id).indexOf('transitnow') === 0) {
    return `
<section>
  <h1>Payment successful — welcome!</h1>
  <p class="subhead">Your <strong>${name}</strong> subscription is active.</p>
  <div class="card">
    <h2>Next step: driver onboarding</h2>
    <p>Complete your driver onboarding so we can review your profile and start matching you with routes.</p>
  </div>
  <a class="btn btn-large" href="/drivers/onboard?src=website">COMPLETE DRIVER ONBOARDING &rarr;</a>
  <p class="microcopy">Takes about 5 minutes. No login needed.</p>
</section>`;
  }
  return `
<section>
  <h1>Payment successful — welcome!</h1>
  <p class="subhead">You're now a member of ${name}.</p>
  <div class="card">
    <h2>What happens next</h2>
    <ol>
      <li><strong>Check your email</strong> for a welcome message with your next steps.</li>
      <li><strong>Claim your access</strong> using the button below.</li>
    </ol>
  </div>
  <a class="btn btn-large" href="/room/claim">CLAIM YOUR ACCESS &rarr;</a>
  <p class="microcopy">If you don't see the email, check spam.</p>
</section>`;
}

module.exports = {
  roomCheckoutPage,
  paymentSuccessPage,
};
