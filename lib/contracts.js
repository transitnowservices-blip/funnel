'use strict';
/**
 * lib/contracts.js — Phase 3: contract / client hub (spec section 19).
 *
 * Pure DB + validation; no Express code here. Additive — nothing existing
 * is touched. Status changes are recorded append-only in
 * contract_status_history. Documents are REFERENCES only (spec section 23:
 * full document upload/storage is deferred to Phase 6).
 *
 * All timestamps are epoch milliseconds.
 */
const db = require('./db');

// EXACT statuses from spec section 19.
const CONTRACT_STATUSES = [
  'LEAD', 'QUALIFYING', 'DISCOVERY', 'PROPOSAL', 'CONTRACT REVIEW',
  'CONTRACTED', 'ONBOARDING', 'ACTIVE', 'PAUSED', 'CLOSED',
];
const CONTRACT_STATUS_LABELS = Object.fromEntries(CONTRACT_STATUSES.map((s) => [s, s]));

function str(v, max = 2000) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function dateOk(v) {
  return v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// Every spec-section-19 field, in spec order.
const CONTRACT_COLS = [
  'client', 'contract_name', 'contract_type', 'territory', 'service_area',
  'start_date', 'end_date',
  'route_requirements', 'package_requirements', 'vehicle_requirements',
  'driver_requirements', 'insurance_requirements', 'performance_requirements',
  'payment_terms', 'documents', 'notes',
];

function validateContract(input) {
  const b = input || {};
  const errors = [];
  const clean = {};
  clean.client = str(b.client, 200);
  clean.contract_name = str(b.contract_name, 200);
  if (!clean.client) errors.push('Client is required.');
  if (!clean.contract_name) errors.push('Contract name is required.');
  for (const c of CONTRACT_COLS) {
    if (c === 'client' || c === 'contract_name') continue;
    clean[c] = str(b[c], c === 'notes' || c === 'documents' ? 5000 : 2000);
  }
  if (!dateOk(clean.start_date)) errors.push('Start date must be YYYY-MM-DD.');
  if (!dateOk(clean.end_date)) errors.push('End date must be YYYY-MM-DD.');
  const status = str(b.status, 30).toUpperCase();
  clean.status = status || 'LEAD';
  if (!CONTRACT_STATUSES.includes(clean.status)) {
    errors.push(`Unknown contract status: ${b.status}`);
  }
  return { ok: errors.length === 0, errors, clean };
}

/** TNC-2026-0001 style contract numbers (counter resets per calendar year). */
async function nextContractNumber() {
  const year = new Date().getFullYear();
  const name = `contract-${year}`;
  const row = await db.get('SELECT next FROM counters WHERE name = ?', [name]);
  let n = 1;
  if (row) {
    n = Number(row.next);
    await db.run('UPDATE counters SET next = ? WHERE name = ?', [n + 1, name]);
  } else {
    await db.run('INSERT INTO counters (name, next) VALUES (?, ?)', [name, 2]);
  }
  return `TNC-${year}-${String(n).padStart(4, '0')}`;
}

async function createContract(clean, { by = 'admin' } = {}) {
  const now = Date.now();
  const contract_number = await nextContractNumber();
  const cols = [...CONTRACT_COLS, 'contract_number', 'status', 'created_by', 'created_at', 'updated_at'];
  const vals = [...CONTRACT_COLS.map((c) => clean[c] || null),
    contract_number, clean.status, by, now, now];
  const info = await db.run(
    `INSERT INTO contracts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals
  );
  const id = Number(info.lastInsertRowid);
  await db.run(
    `INSERT INTO contract_status_history (contract_id, from_status, to_status, changed_by, note, ts)
     VALUES (?, NULL, ?, ?, 'Contract created', ?)`,
    [id, clean.status, by, now]
  );
  return getContract(id);
}

async function getContract(id) {
  return db.get('SELECT * FROM contracts WHERE id = ?', [id]);
}

async function getContractByNumber(contractNumber) {
  return db.get('SELECT * FROM contracts WHERE contract_number = ?', [contractNumber]);
}

async function updateContract(id, clean) {
  const c = await getContract(id);
  if (!c) throw new Error('Contract not found');
  const sets = CONTRACT_COLS.map((col) => `${col} = ?`).join(', ');
  const vals = CONTRACT_COLS.map((col) => clean[col] || null);
  await db.run(`UPDATE contracts SET ${sets}, updated_at = ? WHERE id = ?`, [...vals, Date.now(), id]);
  return getContract(id);
}

async function setContractStatus(id, toStatus, { by = 'admin', note = '' } = {}) {
  const s = str(toStatus, 30).toUpperCase();
  if (!CONTRACT_STATUSES.includes(s)) throw new Error(`Unknown contract status: ${toStatus}`);
  const c = await getContract(id);
  if (!c) throw new Error('Contract not found');
  if (c.status === s) return { changed: false, contract: c };
  const now = Date.now();
  await db.run('UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?', [s, now, id]);
  await db.run(
    `INSERT INTO contract_status_history (contract_id, from_status, to_status, changed_by, note, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, c.status, s, by, str(note, 1000), now]
  );
  return { changed: true, contract: await getContract(id) };
}

async function listContracts({ status = null, territory = null } = {}) {
  const where = [];
  const params = [];
  if (status && CONTRACT_STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
  if (territory) { where.push('territory = ?'); params.push(territory); }
  const sql = `SELECT * FROM contracts${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC, id DESC`;
  return db.all(sql, params);
}

async function countContractsByStatus() {
  const rows = await db.all('SELECT status, COUNT(*) c FROM contracts GROUP BY status');
  const out = {};
  for (const s of CONTRACT_STATUSES) out[s] = 0;
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

async function listContractHistory(contractId) {
  return db.all(
    'SELECT * FROM contract_status_history WHERE contract_id = ? ORDER BY ts ASC, id ASC',
    [contractId]
  );
}

// --- Phase 2 opportunity linkage ----------------------------------------------
// A contract may reference one opportunity explicitly (contracts.opportunity_id)
// and any opportunity whose client/contract reference text names this
// contract is surfaced as a related opportunity (never modified).
async function linkOpportunity(contractId, opportunityId) {
  const c = await getContract(contractId);
  if (!c) throw new Error('Contract not found');
  if (opportunityId === null || opportunityId === '' || opportunityId === undefined) {
    await db.run('UPDATE contracts SET opportunity_id = NULL, updated_at = ? WHERE id = ?', [Date.now(), contractId]);
    return getContract(contractId);
  }
  const opp = await db.get('SELECT id FROM opportunities WHERE id = ?', [Number(opportunityId)]);
  if (!opp) throw new Error('Opportunity not found');
  await db.run('UPDATE contracts SET opportunity_id = ?, updated_at = ? WHERE id = ?', [opp.id, Date.now(), contractId]);
  return getContract(contractId);
}

async function getLinkedOpportunity(contractId) {
  const c = await getContract(contractId);
  if (!c || !c.opportunity_id) return null;
  return db.get('SELECT * FROM opportunities WHERE id = ?', [c.opportunity_id]);
}

// Opportunities whose client/contract reference mentions this contract's
// number or name — read-only cross-reference, never modified here.
async function relatedOpportunities(contract) {
  const terms = [contract.contract_number, contract.contract_name, contract.client].filter(Boolean);
  if (!terms.length) return [];
  const clauses = terms.map(() => 'client_contract LIKE ?').join(' OR ');
  const params = terms.map((t) => `%${t}%`);
  const rows = await db.all(`SELECT * FROM opportunities WHERE ${clauses} ORDER BY updated_at DESC`, params);
  // Exclude the explicitly linked one from the "related" list to avoid duplication.
  return rows.filter((r) => r.id !== contract.opportunity_id);
}

// --- A–L route linkage (spec: "link contracts to existing routes") ------------
// Routes keep everything they have; the contract claims routes by matching
// contract_number. Set only from the contract page (or this helper).
async function listRoutesForContract(contractNumber) {
  if (!contractNumber) return [];
  return db.all('SELECT * FROM routes WHERE contract_number = ? ORDER BY id', [contractNumber]);
}

async function attachRoute(contractId, routeCode) {
  const c = await getContract(contractId);
  if (!c) throw new Error('Contract not found');
  const code = str(routeCode, 40).toUpperCase();
  if (!code) throw new Error('Route code is required');
  const route = await db.get('SELECT * FROM routes WHERE route_code = ?', [code]);
  if (!route) throw new Error(`No route found with code ${code}`);
  await db.run('UPDATE routes SET contract_number = ?, updated_at = ? WHERE id = ?',
    [c.contract_number, Date.now(), route.id]);
  return db.get('SELECT * FROM routes WHERE id = ?', [route.id]);
}

async function detachRoute(routeId) {
  await db.run('UPDATE routes SET contract_number = NULL, updated_at = ? WHERE id = ?', [Date.now(), routeId]);
}

// --- Document references (placeholder — Phase 6 does upload/storage) ---------
async function addDocumentRef(contractId, { doc_type = '', file_name = '', notes = '', by = 'admin' } = {}) {
  const c = await getContract(contractId);
  if (!c) throw new Error('Contract not found');
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO contract_documents (contract_id, doc_type, file_name, notes, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [contractId, str(doc_type, 120), str(file_name, 300), str(notes, 2000), str(by, 120), now]
  );
  return db.get('SELECT * FROM contract_documents WHERE id = ?', [info.lastInsertRowid]);
}

async function listDocuments(contractId) {
  return db.all('SELECT * FROM contract_documents WHERE contract_id = ? ORDER BY uploaded_at DESC, id DESC', [contractId]);
}

module.exports = {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  validateContract,
  nextContractNumber,
  createContract,
  getContract,
  getContractByNumber,
  updateContract,
  setContractStatus,
  listContracts,
  countContractsByStatus,
  listContractHistory,
  linkOpportunity,
  getLinkedOpportunity,
  relatedOpportunities,
  listRoutesForContract,
  attachRoute,
  detachRoute,
  addDocumentRef,
  listDocuments,
};
