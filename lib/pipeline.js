/**
 * Room lead pipeline stages: NEW -> CONTACTED -> INTERESTED -> QUALIFIED
 * -> OFFER SENT -> PAID.
 *
 * Stages are stored as tags (STAGE_NEW, STAGE_CONTACTED, ...) so they show
 * up anywhere tags are shown and need no schema migration. Transitions only
 * move forward — a lead never slides back down the pipeline.
 */
const tags = require('./tags');

const STAGES = ['NEW', 'CONTACTED', 'INTERESTED', 'QUALIFIED', 'OFFER SENT', 'PAID'];

function tagFor(stage) {
  return 'STAGE_' + String(stage || '').toUpperCase().replace(/\s+/g, '_');
}

function rankOf(stage) {
  return STAGES.indexOf(String(stage || '').toUpperCase());
}

async function getStage(leadId) {
  if (!leadId) return null;
  const list = await tags.tagsFor(leadId);
  let best = null;
  for (const t of list) {
    const idx = STAGES.findIndex((s) => tagFor(s) === t);
    if (idx >= 0 && (best === null || idx > STAGES.indexOf(best))) best = STAGES[idx];
  }
  return best;
}

/** Move a lead to `stage`, but only forward — never backward. */
async function setStage(leadId, stage) {
  if (!leadId) return null;
  const want = String(stage || '').toUpperCase();
  if (rankOf(want) < 0) return getStage(leadId);
  const current = await getStage(leadId);
  if (current && rankOf(current) >= rankOf(want)) return current;
  // Clear any older stage tags, then apply the new one.
  const list = await tags.tagsFor(leadId);
  for (const t of list) {
    if (t.startsWith('STAGE_') && t !== tagFor(want)) {
      await tags.removeTag(leadId, t);
    }
  }
  await tags.addTag(leadId, tagFor(want));
  return want;
}

module.exports = { STAGES, tagFor, getStage, setStage };
