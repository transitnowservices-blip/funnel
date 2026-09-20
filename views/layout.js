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
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta name="description" content="${esc(site.tagline || '')}">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="site-header">
  <div class="container">
    <div class="brand">${siteTitle}</div>
    <div class="tagline">${esc(site.tagline || '')}</div>
  </div>
</header>
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
