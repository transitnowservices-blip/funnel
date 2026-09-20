'use strict';
/**
 * lib/config.js — reads config/*.json (written by a separate agent).
 *
 * Shapes expected:
 *   config/site.json:     {businessName, tagline, phone, email, paymentMode,
 *                          baseUrl, footerNote, privacyNoteHtml}
 *   config/products.json: {defaultProduct, products:[{id, name, priceCents,
 *                          priceDisplay, billing, stripeLink,
 *                          leadMagnet:{title,description,deliverableHtml},
 *                          salesCopy:{headline,subhead,bullets[],cta},
 *                          orderBump:{enabled,name,priceCents,priceDisplay,description},
 *                          upsell1:{enabled,...}, upsell2:{enabled,...}}]}
 *   config/emails.json:   {fromName, fromEmail,
 *                          sequences:{nurture:[{id,delayHours,subject,bodyHtml}],
 *                                     abandonedCart:[...], postPurchase:[...]},
 *                          weeklyFlyer:{headline,featuredOfferId,benefit,educational,
 *                                       spotlight,cta,secondaryOffer,testimonialSlot}}
 *
 * Configs are cached and re-read when the file mtime changes, so the admin
 * config editor (and hand edits) take effect without a restart.
 *
 * If a file is missing or contains invalid JSON, a minimal in-code fallback
 * is used (with a one-time warning) so the server still boots.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const ALLOWED_FILES = ['site', 'products', 'emails'];

// --- Minimal fallbacks (server boots even with zero config files) ------------
function blankAddon() {
  return { enabled: false, name: '', priceCents: 0, priceDisplay: '', description: '' };
}

const FALLBACKS = {
  site: {
    businessName: 'Demo Business',
    tagline: 'A demo funnel — configure config/site.json',
    phone: '',
    email: '',
    paymentMode: 'demo',
    baseUrl: 'http://localhost:3000',
    footerNote: 'Demo funnel footer.',
    privacyNoteHtml: '<p>Demo privacy note — configure config/site.json.</p>',
  },
  products: {
    defaultProduct: 'demo-product',
    products: [
      {
        id: 'demo-product',
        name: 'Demo Product',
        priceCents: 1000,
        priceDisplay: '$10',
        billing: 'one-time',
        stripeLink: '',
        leadMagnet: {
          title: 'Free Demo Guide',
          description: 'A free sample lead magnet.',
          deliverableHtml: '<p>Your free demo guide would be delivered here.</p>',
        },
        salesCopy: {
          headline: 'Demo Product Headline',
          subhead: 'Demo subhead.',
          bullets: ['Benefit one', 'Benefit two'],
          cta: 'Buy Now',
        },
        orderBump: { ...blankAddon(), name: 'Demo Order Bump', priceCents: 500, priceDisplay: '$5' },
        upsell1: { ...blankAddon(), name: 'Demo Upsell 1', priceCents: 2000, priceDisplay: '$20' },
        upsell2: { ...blankAddon(), name: 'Demo Upsell 2', priceCents: 3000, priceDisplay: '$30' },
      },
    ],
  },
  emails: {
    fromName: 'Demo Business',
    fromEmail: 'hello@example.com',
    sequences: { nurture: [], abandonedCart: [], postPurchase: [] },
    weeklyFlyer: {
      headline: 'This week at Demo Business',
      featuredOfferId: 'demo-product',
      benefit: 'Demo benefit.',
      educational: 'Demo educational tip.',
      spotlight: 'Demo spotlight.',
      cta: 'Check it out',
      secondaryOffer: '',
      testimonialSlot: '',
    },
  },
};

// --- Loader with mtime cache --------------------------------------------------
const cache = {}; // name -> { mtimeMs, data }
const warned = new Set();

function load(name) {
  const file = path.join(CONFIG_DIR, `${name}.json`);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[config] ${file} not found — using built-in fallback (${name}).`);
    }
    return FALLBACKS[name];
  }
  const hit = cache[name];
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache[name] = { mtimeMs: stat.mtimeMs, data };
    warned.delete(name);
    return data;
  } catch (err) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[config] Failed to parse ${file}: ${err.message} — using built-in fallback.`);
    }
    return FALLBACKS[name];
  }
}

/** Normalize a product so missing addon blocks never crash the funnel. */
function normalizeProduct(p) {
  const prod = { ...p };
  for (const key of ['orderBump', 'upsell1', 'upsell2']) {
    prod[key] = { ...blankAddon(), ...(p[key] || {}) };
  }
  prod.leadMagnet = { title: '', description: '', deliverableHtml: '', ...(p.leadMagnet || {}) };
  prod.salesCopy = { headline: '', subhead: '', bullets: [], cta: 'Buy Now', ...(p.salesCopy || {}) };
  return prod;
}

function getSite() {
  return { ...FALLBACKS.site, ...load('site') };
}

function getProducts() {
  const raw = load('products');
  const products = Array.isArray(raw.products) ? raw.products.map(normalizeProduct) : [];
  return {
    defaultProduct: raw.defaultProduct || (products[0] && products[0].id) || 'demo-product',
    products: products.length ? products : FALLBACKS.products.products,
  };
}

function getEmails() {
  const raw = load('emails');
  return {
    fromName: raw.fromName || '',
    fromEmail: raw.fromEmail || '',
    sequences: {
      nurture: (raw.sequences && raw.sequences.nurture) || [],
      abandonedCart: (raw.sequences && raw.sequences.abandonedCart) || [],
      postPurchase: (raw.sequences && raw.sequences.postPurchase) || [],
    },
    weeklyFlyer: { ...FALLBACKS.emails.weeklyFlyer, ...(raw.weeklyFlyer || {}) },
  };
}

/** Product by id, falling back to the configured default product. */
function getProduct(id) {
  const cfg = getProducts();
  const found = cfg.products.find((p) => p.id === id);
  if (found) return found;
  const def = cfg.products.find((p) => p.id === cfg.defaultProduct);
  return def || cfg.products[0];
}

/** Persist a config file (used by the admin config editor). */
function saveConfig(name, obj) {
  if (!ALLOWED_FILES.includes(name)) throw new Error(`Unknown config file: ${name}`);
  const file = path.join(CONFIG_DIR, `${name}.json`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  delete cache[name]; // force re-read on next request
}

module.exports = { getSite, getProducts, getEmails, getProduct, saveConfig, ALLOWED_FILES, CONFIG_DIR };
