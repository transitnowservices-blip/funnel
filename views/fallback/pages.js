'use strict';
/**
 * FALLBACK views — views/fallback/pages.js
 *
 * Used only when views/pages.js (written by the views agent) is missing or
 * fails to load. Implements every contracted export, returning INNER <main>
 * markup (the server wraps it with layout(), exactly like the real views):
 *   landingPage(site,product), leadPage(site,product,query),
 *   freeValuePage(site,product,lead), salesPage(site,product),
 *   checkoutPage(site,product,lead,mode), orderBumpPage(site,product),
 *   upsellPage(site,product,upsell,which), thankYouPage(site,product,lead),
 *   unsubscribePage(site,email), preferencesPage(site,lead), privacyPage(site)
 *
 * `product` is always a normalized product object (see lib/config.js).
 * `lead` may be null for anonymous visitors.
 */
const { esc } = require('./layout');

function withProduct(path, product) {
  return `${path}?p=${encodeURIComponent(product.id)}`;
}

function bullets(list) {
  if (!list || !list.length) return '';
  return `<ul class="bullets">${list.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
}

function landingPage(site, product) {
  const sc = product.salesCopy || {};
  return `
<section class="hero">
  <h1>${esc(sc.headline || product.name)}</h1>
  <p class="subhead">${esc(sc.subhead || '')}</p>
  ${bullets(sc.bullets)}
  <p class="price-line"><strong>${esc(product.priceDisplay || '')}</strong>${product.billing ? ` <span class="billing">${esc(product.billing)}</span>` : ''}</p>
  <p><a class="btn" href="${withProduct('/lead', product)}">Get the free ${esc((product.leadMagnet || {}).title || 'guide')}</a></p>
  <p class="alt-link"><a href="${withProduct('/sales', product)}">Or skip to the full offer &rarr;</a></p>
</section>`;
}

function leadPage(site, product, query) {
  const q = query || {};
  const lm = product.leadMagnet || {};
  return `
<section class="narrow">
  <h1>${esc(lm.title || 'Free download')}</h1>
  <p>${esc(lm.description || '')}</p>
  ${q.error ? `<p class="error">${esc(q.error)}</p>` : ''}
  <form method="POST" action="${withProduct('/lead', product)}" class="form">
    <label>First name
      <input type="text" name="first_name" required autocomplete="given-name">
    </label>
    <label>Email
      <input type="email" name="email" required autocomplete="email">
    </label>
    <label>Phone <span class="opt">(optional)</span>
      <input type="tel" name="phone" autocomplete="tel">
    </label>
    <input type="hidden" name="product_id" value="${esc(product.id)}">
    <button class="btn" type="submit">Send me the free ${esc(lm.title || 'download')}</button>
  </form>
  <p class="fineprint">We&rsquo;ll email you the download plus occasional useful updates. Unsubscribe anytime.</p>
</section>`;
}

function freeValuePage(site, product, lead) {
  const lm = product.leadMagnet || {};
  return `
<section class="narrow">
  <h1>Here&rsquo;s your free ${esc(lm.title || 'download')}${lead && lead.first_name ? `, ${esc(lead.first_name)}` : ''}!</h1>
  <div class="deliverable">${lm.deliverableHtml || ''}</div>
  <hr>
  <h2>Want the full result, faster?</h2>
  <p><a class="btn" href="${withProduct('/sales', product)}">See ${esc(product.name)} — ${esc(product.priceDisplay || '')}</a></p>
</section>`;
}

function salesPage(site, product) {
  const sc = product.salesCopy || {};
  return `
<section class="narrow">
  <h1>${esc(sc.headline || product.name)}</h1>
  <p class="subhead">${esc(sc.subhead || '')}</p>
  ${bullets(sc.bullets)}
  <p class="price-line"><strong>${esc(product.priceDisplay || '')}</strong>${product.billing ? ` <span class="billing">${esc(product.billing)}</span>` : ''}</p>
  <p><a class="btn" href="${withProduct('/checkout', product)}">${esc(sc.cta || 'Buy Now')}</a></p>
</section>`;
}

function checkoutPage(site, product, lead, mode) {
  const l = lead || {};
  return `
<section class="narrow">
  <h1>Checkout</h1>
  <div class="order-summary">
    <p><strong>${esc(product.name)}</strong> — ${esc(product.priceDisplay || '')}${product.billing ? ` <span class="billing">${esc(product.billing)}</span>` : ''}</p>
  </div>
  <form method="POST" action="${withProduct('/checkout', product)}" class="form">
    <label>First name
      <input type="text" name="first_name" required value="${esc(l.first_name || '')}" autocomplete="given-name">
    </label>
    <label>Email
      <input type="email" name="email" required value="${esc(l.email || '')}" autocomplete="email">
    </label>
    <label>Phone <span class="opt">(optional)</span>
      <input type="tel" name="phone" value="${esc(l.phone || '')}" autocomplete="tel">
    </label>
    <input type="hidden" name="product_id" value="${esc(product.id)}">
    <button class="btn" type="submit">${mode === 'stripe' ? 'Continue to secure checkout' : 'Continue'}</button>
  </form>
  ${mode === 'stripe'
    ? '<p class="fineprint">You&rsquo;ll be redirected to our secure payment page to complete your purchase.</p>'
    : '<p class="fineprint">Demo mode — no real charge is made.</p>'}
</section>`;
}

function orderBumpPage(site, product) {
  const bump = product.orderBump || {};
  if (!bump.enabled) return '';
  return `
<section class="narrow">
  <h1>Wait — add this to your order?</h1>
  <div class="offer-box">
    <h2>${esc(bump.name || 'Special add-on')}</h2>
    ${bump.description ? `<p>${esc(bump.description)}</p>` : ''}
    <p class="price-line"><strong>${esc(bump.priceDisplay || '')}</strong></p>
  </div>
  <div class="btn-row">
    <form method="POST" action="${withProduct('/order-bump', product)}">
      <input type="hidden" name="product_id" value="${esc(product.id)}">
      <input type="hidden" name="accept" value="yes">
      <button class="btn" type="submit">Yes, add it!</button>
    </form>
    <form method="POST" action="${withProduct('/order-bump', product)}">
      <input type="hidden" name="product_id" value="${esc(product.id)}">
      <input type="hidden" name="accept" value="no">
      <button class="btn btn-ghost" type="submit">No thanks</button>
    </form>
  </div>
</section>`;
}

function upsellPage(site, product, upsell, which) {
  const u = upsell || {};
  if (!u.enabled) return '';
  const action = withProduct(`/upsell/${which}`, product);
  return `
<section class="narrow">
  <h1>One-time offer</h1>
  <div class="offer-box">
    <h2>${esc(u.name || 'Special offer')}</h2>
    ${u.description ? `<p>${esc(u.description)}</p>` : ''}
    <p class="price-line"><strong>${esc(u.priceDisplay || '')}</strong></p>
  </div>
  <div class="btn-row">
    <form method="POST" action="${action}">
      <input type="hidden" name="product_id" value="${esc(product.id)}">
      <input type="hidden" name="accept" value="yes">
      <button class="btn" type="submit">Yes, add it!</button>
    </form>
    <form method="POST" action="${action}">
      <input type="hidden" name="product_id" value="${esc(product.id)}">
      <input type="hidden" name="accept" value="no">
      <button class="btn btn-ghost" type="submit">No thanks</button>
    </form>
  </div>
</section>`;
}

function thankYouPage(site, product, lead) {
  return `
<section class="narrow">
  <h1>Thank you${lead && lead.first_name ? `, ${esc(lead.first_name)}` : ''}!</h1>
  <p>Your order for <strong>${esc(product.name)}</strong> is confirmed.</p>
  <p>We&rsquo;ve emailed your receipt and next steps${lead && lead.email ? ` to ${esc(lead.email)}` : ''}.</p>
  <p><a class="btn" href="/">Back to the homepage</a></p>
</section>`;
}

function unsubscribePage(site, email) {
  return `
<section class="narrow">
  <h1>Unsubscribe</h1>
  <p>Enter your email below and we&rsquo;ll stop sending you marketing emails.</p>
  <form method="POST" action="/unsubscribe" class="form">
    <label>Email
      <input type="email" name="email" required value="${esc(email || '')}" autocomplete="email">
    </label>
    <button class="btn" type="submit">Unsubscribe me</button>
  </form>
</section>`;
}

function preferencesPage(site, lead) {
  const l = lead || {};
  return `
<section class="narrow">
  <h1>Email preferences</h1>
  ${lead ? `
  <form method="POST" action="/preferences" class="form">
    <label>Phone
      <input type="tel" name="phone" value="${esc(l.phone || '')}" autocomplete="tel">
    </label>
    <label class="check">
      <input type="checkbox" name="consent_marketing" value="1" ${l.consent_marketing ? 'checked' : ''}>
      Keep me on the list (useful updates &amp; offers)
    </label>
    <button class="btn" type="submit">Save preferences</button>
  </form>
  <p class="fineprint"><a href="/unsubscribe?email=${encodeURIComponent(l.email || '')}">Unsubscribe from everything</a></p>
  ` : `<p>We couldn&rsquo;t identify your subscription. Please use the preferences link from one of our emails.</p>`}
</section>`;
}

function privacyPage(site) {
  return `
<section class="narrow">
  <h1>Privacy note</h1>
  <div>${site.privacyNoteHtml || '<p>No privacy note configured.</p>'}</div>
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
