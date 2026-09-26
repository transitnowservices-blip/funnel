// Layout helper. Backend usage: layout({ title, body, site }) -> full HTML5 document.
// `body` is inner page markup produced by views/pages.js. `site` is config/site.json.
'use strict';

const { SITE_URL: SEO_URL, localBusinessJsonLd } = require('../lib/seo');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout({ title, body, site, installBanner, seo }) {
  const s = seo || {};
  const siteTitle = esc(site.businessName || 'TransitNow');
  // SEO: a per-page `seo.title` is used verbatim (already branded); otherwise
  // fall back to the historic "Title | Brand" pattern.
  const pageTitle = s.title ? esc(s.title) : (title ? `${esc(title)} | ${siteTitle}` : siteTitle);
  const description = s.description || site.tagline || '';
  const canonical = s.canonical || '';
  const ogImage = `${SEO_URL}/apple-touch-icon.png`;
  const jsonLd = s.jsonLd === 'localBusiness' ? localBusinessJsonLd() : (s.jsonLd || '');
  const year = new Date().getFullYear();
  // Public navigation (spec section 27). Only rendered when site.publicNav
  // is set — Room-branded pages never set it, so their look is unchanged.
  const navItems = (site.publicNav || []).map((n) =>
    `<a href="${esc(n.href)}"${n.cta ? ' class="nav-cta"' : ''}>${esc(n.label)}</a>`
  ).join('');
  const nav = navItems
    ? `<nav class="public-nav" aria-label="Primary"><div class="container nav-inner">${navItems}</div></nav>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta name="description" content="${esc(description)}">
${s.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${siteTitle}">
<meta property="og:title" content="${pageTitle}">
<meta property="og:description" content="${esc(description)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${pageTitle}">
<meta name="twitter:description" content="${esc(description)}">
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ''}
<link rel="stylesheet" href="/style.css">
<link rel="icon" type="image/png" href="/apple-touch-icon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="TransitNow">
</head>
<body>
<header class="site-header">
  <div class="container">
    <div class="brand">${siteTitle}</div>
    <div class="tagline">${esc(site.tagline || '')}</div>
  </div>
</header>
${nav}
<main class="container">
${body}
</main>
<footer class="site-footer">
  <div class="container">
    <p class="footer-note">${esc(site.footerNote || '')}</p>
    <p class="footer-contact">${esc(site.businessName || '')} &middot; ${esc(site.phone || '')} &middot; ${esc(site.email || '')}</p>
    <p class="footer-links"><a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/refund">Refund &amp; Cancellation</a> &middot; <a href="/contact">Contact</a> &middot; <a href="/install">Get the App</a> &middot; <a href="/unsubscribe">Unsubscribe</a></p>
    <p class="footer-copy">&copy; ${year} ${siteTitle}. All rights reserved.</p>
  </div>
</footer>
${installBanner ? `
<div id="tn-install-banner" class="tn-install-banner" hidden>
  <span class="tn-install-icon">📲</span>
  <span class="tn-install-text"><strong>Get the TransitNow app</strong><br><span id="tn-install-how">Tap Share, then Add to Home Screen.</span> <a href="/install" class="tn-install-link">Show me how &rarr;</a></span>
  <button id="tn-install-close" class="tn-install-close" aria-label="Dismiss">&times;</button>
</div>
<script>
(function () {
  try {
    if (localStorage.getItem('tn-install-dismissed')) return;
    var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone) return;
    var ua = navigator.userAgent || '';
    var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isAndroid = /Android/.test(ua);
    if (!isIOS && !isAndroid) return;
    var banner = document.getElementById('tn-install-banner');
    var how = document.getElementById('tn-install-how');
    if (isAndroid && how) how.textContent = 'Tap the menu (⋮), then Add to Home Screen.';
    banner.hidden = false;
    document.getElementById('tn-install-close').addEventListener('click', function () {
      banner.hidden = true;
      try { localStorage.setItem('tn-install-dismissed', '1'); } catch (e) {}
    });
  } catch (e) {}
})();
</script>` : ''}
</body>
</html>`;
}

module.exports = { layout, esc };
