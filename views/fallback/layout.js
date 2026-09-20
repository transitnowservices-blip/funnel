'use strict';
/**
 * FALLBACK view — views/fallback/layout.js
 *
 * Used only when views/layout.js (written by the views agent) is missing or
 * fails to load. Contract: layout({ title, body, site }) -> full HTML string.
 * This fallback is intentionally plain; the real implementation replaces it.
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout({ title, body, site }) {
  const s = site || {};
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || s.businessName || 'Funnel')}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">${esc(s.businessName || 'Funnel')}</a>
    ${s.tagline ? `<span class="tagline">${esc(s.tagline)}</span>` : ''}
  </div>
</header>
<main class="wrap">${body || ''}</main>
<footer class="site-footer">
  <div class="wrap">
    <p>${esc(s.footerNote || '')}</p>
    <p><a href="/privacy-note">Privacy note</a>${s.email ? ` &middot; <a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : ''}${s.phone ? ` &middot; ${esc(s.phone)}` : ''}</p>
  </div>
</footer>
</body>
</html>`;
}

module.exports = { layout, esc };
