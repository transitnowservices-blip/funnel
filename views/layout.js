// Layout helper. Backend usage: layout({ title, body, site }) -> full HTML5 document.
// `body` is inner page markup produced by views/pages.js. `site` is config/site.json.
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout({ title, body, site }) {
  const siteTitle = esc(site.businessName || 'TransitNow');
  const pageTitle = title ? `${esc(title)} | ${siteTitle}` : siteTitle;
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
<meta name="description" content="${esc(site.tagline || '')}">
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
    <p class="footer-links"><a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/refund">Refund &amp; Cancellation</a> &middot; <a href="/contact">Contact</a> &middot; <a href="/unsubscribe">Unsubscribe</a></p>
    <p class="footer-copy">&copy; ${year} ${siteTitle}. All rights reserved.</p>
  </div>
</footer>
</body>
</html>`;
}

module.exports = { layout, esc };
