'use strict';
/**
 * lib/tags.js — lead tagging.
 *
 * Tags used across the funnel:
 *   NEW_LEAD, VIEWED_OFFER, HIGH_INTENT, STARTED_CHECKOUT, ABANDONED_CART,
 *   PURCHASED, UPSELL_ACCEPTED, UPSELL_DECLINED, REPEAT_CUSTOMER,
 *   WEEKLY_NURTURE, CUSTOMER, UNSUBSCRIBED, SUPPRESSED,
 *   OFFER_<id>_VIEWED, OFFER_<id>_LEAD, OFFER_<id>_PURCHASED
 *
 * Admin segments are computed from tags + lead status at query time.
 *
 * All functions are async (the db layer returns Promises) — `await` them.
 */
const db = require('./db');

async function addTag(leadId, tag) {
  if (!leadId || !tag) return;
  await db.run('INSERT OR IGNORE INTO tags (lead_id, tag, ts) VALUES (?, ?, ?)', [
    leadId,
    tag,
    Date.now(),
  ]);
}

async function removeTag(leadId, tag) {
  if (!leadId || !tag) return;
  await db.run('DELETE FROM tags WHERE lead_id = ? AND tag = ?', [leadId, tag]);
}

async function hasTag(leadId, tag) {
  if (!leadId || !tag) return false;
  return !!(await db.get('SELECT 1 FROM tags WHERE lead_id = ? AND tag = ?', [leadId, tag]));
}

/** Tag names for a lead, oldest first. */
async function tagsFor(leadId) {
  if (!leadId) return [];
  return (await db.all('SELECT tag FROM tags WHERE lead_id = ? ORDER BY ts ASC', [leadId])).map((r) => r.tag);
}

module.exports = { addTag, removeTag, hasTag, tagsFor };
