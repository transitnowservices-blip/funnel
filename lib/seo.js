// lib/seo.js — Central SEO metadata for public pages.
// Per-page titles (<=60 chars), meta descriptions (<=160 chars), canonical
// URLs, robots directives, Open Graph defaults, JSON-LD schema, and the
// sitemap.xml builder. Additive only: nothing here changes copy, pricing,
// Stripe links, or disclosures.
'use strict';

const SITE_URL = 'https://funnel-qdx9.onrender.com';
const OG_IMAGE = `${SITE_URL}/apple-touch-icon.png`;

// JSON-LD LocalBusiness schema for TransitNow Logistics Services, Milwaukee WI.
function localBusinessJsonLd() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    name: 'TransitNow Logistics Services',
    description:
      'Dispatch support services for independent couriers, owner-operators, and box-truck operators in Milwaukee, WI. Weekly route matches, load-search prep, broker verification guidance, paperwork, and route planning.',
    url: SITE_URL,
    telephone: '+1-414-897-3282',
    email: 'transitnowservices@gmail.com',
    image: OG_IMAGE,
    priceRange: '$50 - $100',
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Milwaukee',
      addressRegion: 'WI',
      addressCountry: 'US',
    },
    areaServed: [
      { '@type': 'City', name: 'Milwaukee' },
      { '@type': 'State', name: 'Wisconsin' },
    ],
    openingHoursSpecification: [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        opens: '09:00',
        closes: '17:00',
      },
    ],
  });
}

// Keyed by route path. `title` is used verbatim in <title> (already branded).
// `description` feeds meta description + og:description. `noindex: true`
// emits <meta name="robots" content="noindex,nofollow"> for transaction pages.
const SEO = {
  '/': {
    title: 'Dispatch Service Milwaukee | TransitNow Logistics',
    description:
      "Milwaukee dispatch support for independent couriers and box-truck operators. Get the free Courier Startup Checklist — stay ready so you don't have to get ready.",
    canonical: `${SITE_URL}/`,
    jsonLd: 'localBusiness',
  },
  '/grow': {
    title: 'Owner-Operator Dispatch Milwaukee | TransitNow',
    description:
      'You drive, we find the work. Milwaukee dispatch service for owner-operators, sprinter van and box truck drivers — 2–5 route matches weekly from $50/mo.',
    canonical: `${SITE_URL}/grow`,
    jsonLd: 'localBusiness',
  },
  '/grow/apply': {
    title: 'Driver Application | TransitNow Milwaukee',
    description:
      'Apply with TransitNow: share your vehicle, availability, and goals. Free application for Milwaukee courier and box-truck driver opportunities.',
    canonical: `${SITE_URL}/grow/apply`,
  },
  '/dispatch': {
    title: 'Box Truck & Sprinter Van Dispatch | TransitNow',
    description:
      'Dispatch support for box truck, sprinter van, and courier operators in Milwaukee: load research, broker verification, route planning. $50–$100/mo.',
    canonical: `${SITE_URL}/dispatch`,
  },
  '/business': {
    title: 'Transportation Business Support | TransitNow',
    description:
      'Grow your transportation business with TransitNow: dispatch services, driver recruiting, and operations support in Milwaukee, WI.',
    canonical: `${SITE_URL}/business`,
  },
  '/rsp': {
    title: 'RSP & Delivery Business Opportunities | TransitNow',
    description:
      "Explore RSP and delivery business opportunities with TransitNow in Milwaukee. Tell us your goals — we'll reach out when something fits.",
    canonical: `${SITE_URL}/rsp`,
  },
  '/support': {
    title: 'Driver Support | TransitNow Milwaukee',
    description:
      'Support for TransitNow drivers and applicants in Milwaukee: onboarding help, dispatch questions, and account assistance.',
    canonical: `${SITE_URL}/support`,
  },
  '/drivers/onboard': {
    title: 'Driver Onboarding | TransitNow Dispatch',
    description:
      'Onboard with TransitNow dispatch in about 5 minutes: vehicle, business, and lane preferences for Milwaukee couriers and box-truck operators.',
    canonical: `${SITE_URL}/drivers/onboard`,
  },
  '/room/join': {
    title: "Wealth Builder's Room | Turn Ideas Into Income — $49/mo",
    description:
      "Join the Wealth Builder's Room: a 90-day wealth action plan, daily accountability, and training to turn ideas into income. $49/month.",
    canonical: `${SITE_URL}/room/join`,
  },
  '/room/offer': {
    title: "What's Inside the Wealth Builder's Room | $49/mo",
    description:
      "See what's inside the Wealth Builder's Room: wealth mindset, cash flow, assets, and a 90-day execution plan. $49/month, cancel anytime.",
    canonical: `${SITE_URL}/room/offer`,
  },
  '/room/start': {
    title: "Get Started | Wealth Builder's Room",
    description:
      "Start with the Wealth Builder's Room: tell us your goal and we'll follow up with your next step toward building income and wealth.",
    canonical: `${SITE_URL}/room/start`,
  },
  '/install': {
    title: 'Get the TransitNow App | iPhone & Android',
    description:
      'Put TransitNow on your home screen in under a minute — no app store needed. Step-by-step for iPhone Safari and Android Chrome.',
    canonical: `${SITE_URL}/install`,
  },
  '/contact': {
    title: 'Contact TransitNow Logistics Services | Milwaukee',
    description:
      'Contact TransitNow Logistics Services in Milwaukee, WI: 414-897-3282 or transitnowservices@gmail.com. Dispatch and membership questions welcome.',
    canonical: `${SITE_URL}/contact`,
  },
  '/terms': {
    title: "Terms of Service | Wealth Builder's Room",
    description:
      "Terms of Service for the Wealth Builder's Room membership: billing, cancellation, and acceptable use.",
    canonical: `${SITE_URL}/terms`,
  },
  '/refund': {
    title: "Refund & Cancellation Policy | Wealth Builder's Room",
    description:
      "Refund and cancellation policy for the Wealth Builder's Room $49/month membership and TransitNow dispatch subscriptions.",
    canonical: `${SITE_URL}/refund`,
  },
  '/privacy': {
    title: 'Privacy Notice | TransitNow',
    description:
      'How TransitNow Logistics Services collects, uses, and protects your information. First-party tracking only — we never sell your data.',
    canonical: `${SITE_URL}/privacy`,
  },
  '/lead': {
    title: 'Free Courier Startup Checklist | TransitNow',
    description:
      'Get the free Courier Startup Checklist: 7 things to have ready before your first route as an independent courier in Milwaukee.',
    canonical: `${SITE_URL}/lead`,
  },
  '/free-value': {
    title: 'Your Free Courier Checklist | TransitNow',
    description:
      'Your free Courier Startup Checklist is ready — plus how TransitNow dispatch support helps independent couriers stay organized.',
    canonical: `${SITE_URL}/free-value`,
  },
  '/sales': {
    title: 'TransitNow Complete Dispatch — $100/mo | Milwaukee',
    description:
      'Complete dispatch support for independent courier and box-truck operators in Milwaukee: lane research, load-search prep, broker verification. $100/mo.',
    canonical: `${SITE_URL}/sales`,
  },
  // Transaction / post-purchase pages: keep out of the index.
  '/checkout': { noindex: true },
  '/thank-you': { noindex: true },
  '/payment-success': { noindex: true },
  '/order-bump': { noindex: true },
  '/upsell1': { noindex: true },
  '/upsell2': { noindex: true },
  '/business/thank-you': { noindex: true },
  '/rsp/thank-you': { noindex: true },
  '/dispatch/thank-you': { noindex: true },
  '/room/checkout': { noindex: true },
};

function seoFor(path) {
  return SEO[path] || null;
}

// Sitemap: public indexable pages only (no transaction or admin pages).
const SITEMAP_PATHS = [
  '/',
  '/grow',
  '/grow/apply',
  '/dispatch',
  '/business',
  '/rsp',
  '/support',
  '/drivers/onboard',
  '/room/join',
  '/room/offer',
  '/room/start',
  '/install',
  '/contact',
  '/terms',
  '/refund',
  '/privacy',
  '/lead',
  '/sales',
];

function sitemapXml() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_PATHS.map(
    (p) =>
      `  <url><loc>${SITE_URL}${p === '/' ? '/' : p}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq></url>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

function robotsTxt() {
  return `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

module.exports = { SITE_URL, OG_IMAGE, SEO, seoFor, localBusinessJsonLd, sitemapXml, robotsTxt, SITEMAP_PATHS };
