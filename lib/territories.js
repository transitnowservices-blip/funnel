'use strict';
/**
 * lib/territories.js — Phase 3: territory management (spec section 20).
 *
 * Pure DB + validation; no Express code here. Additive.
 *
 * The "active contracts / available drivers / available vehicles / open
 * opportunities" fields are COMPUTED from the live contracts, drivers,
 * opportunities and routes tables every time they are read — they are never
 * stored, so they can never go stale. Matching is by territory name on the
 * contract/opportunity rows and by city/state on driver/package rows.
 *
 * All timestamps are epoch milliseconds.
 */
const db = require('./db');

function str(v, max = 2000) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Driver pipeline statuses that count as "available" for territory capacity.
// 'new' (just applied) and 'inactive' are deliberately excluded; the admin
// decides readiness through the normal pipeline.
const AVAILABLE_DRIVER_STATUSES = ['ready', 'placement', 'active'];

function validateTerritory(input, { existing = null } = {}) {
  const b = input || {};
  const errors = [];
  const clean = {};
  clean.name = str(b.name, 160);
  clean.city = str(b.city, 120);
  clean.state = str(b.state, 60);
  clean.zip_codes = str(b.zip_codes, 300);
  clean.service_radius = str(b.service_radius, 120);
  clean.capacity = str(b.capacity, 500);
  clean.notes = str(b.notes, 5000);
  if (!clean.name) errors.push('Territory name is required.');
  if (existing && existing.name !== clean.name) {
    // Renames are allowed; duplicates are not.
  }
  return { ok: errors.length === 0, errors, clean };
}

async function createTerritory(clean, { by = 'admin' } = {}) {
  const now = Date.now();
  try {
    const info = await db.run(
      `INSERT INTO territories (name, city, state, zip_codes, service_radius, capacity, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [clean.name, clean.city || null, clean.state || null, clean.zip_codes || null,
       clean.service_radius || null, clean.capacity || null, clean.notes || null, by, now, now]
    );
    return getTerritory(info.lastInsertRowid);
  } catch (err) {
    if (String(err && err.message || '').includes('UNIQUE')) {
      throw new Error(`A territory named "${clean.name}" already exists.`);
    }
    throw err;
  }
}

async function getTerritory(id) {
  return db.get('SELECT * FROM territories WHERE id = ?', [id]);
}

async function getTerritoryByName(name) {
  return db.get('SELECT * FROM territories WHERE name = ?', [name]);
}

async function updateTerritory(id, clean) {
  const t = await getTerritory(id);
  if (!t) throw new Error('Territory not found');
  try {
    await db.run(
      `UPDATE territories
          SET name = ?, city = ?, state = ?, zip_codes = ?, service_radius = ?,
              capacity = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      [clean.name, clean.city || null, clean.state || null, clean.zip_codes || null,
       clean.service_radius || null, clean.capacity || null, clean.notes || null, Date.now(), id]
    );
  } catch (err) {
    if (String(err && err.message || '').includes('UNIQUE')) {
      throw new Error(`A territory named "${clean.name}" already exists.`);
    }
    throw err;
  }
  return getTerritory(id);
}

async function listTerritories() {
  return db.all('SELECT * FROM territories ORDER BY name ASC');
}

/**
 * Computed territory stats — always live queries, never stored.
 * Returns { activeContracts, openOpportunities, availableDrivers, availableVehicles }.
 */
async function territoryStats(territory) {
  const name = territory.name || '';
  const city = (territory.city || '').trim();
  const state = (territory.state || '').trim();

  const [contractsRow, oppsRow, driversRow, vehiclesRow] = await Promise.all([
    db.get('SELECT COUNT(*) c FROM contracts WHERE status = ? AND territory = ?', ['ACTIVE', name]),
    city || state
      ? db.get(
          `SELECT COUNT(*) c FROM opportunities
            WHERE status = 'OPEN' AND (territory = ? OR location LIKE ? OR location LIKE ?)`,
          [name, `%${city}%`, `%${state}%`]
        )
      : db.get(`SELECT COUNT(*) c FROM opportunities WHERE status = 'OPEN' AND territory = ?`, [name]),
    city || state
      ? db.get(
          `SELECT COUNT(*) c FROM drivers
            WHERE status IN (${AVAILABLE_DRIVER_STATUSES.map(() => '?').join(', ')})
              AND (home_city = ? OR home_state = ?)`,
          [...AVAILABLE_DRIVER_STATUSES, city, state]
        )
      : db.get(
          `SELECT COUNT(*) c FROM drivers WHERE status IN (${AVAILABLE_DRIVER_STATUSES.map(() => '?').join(', ')})`,
          AVAILABLE_DRIVER_STATUSES
        ),
    city || state
      ? db.get(
          `SELECT COUNT(*) c FROM drivers
            WHERE status IN (${AVAILABLE_DRIVER_STATUSES.map(() => '?').join(', ')})
              AND vehicle_type IS NOT NULL AND vehicle_type != ''
              AND (home_city = ? OR home_state = ?)`,
          [...AVAILABLE_DRIVER_STATUSES, city, state]
        )
      : db.get(
          `SELECT COUNT(*) c FROM drivers
            WHERE status IN (${AVAILABLE_DRIVER_STATUSES.map(() => '?').join(', ')})
              AND vehicle_type IS NOT NULL AND vehicle_type != ''`,
          AVAILABLE_DRIVER_STATUSES
        ),
  ]);

  return {
    activeContracts: Number(contractsRow.c),
    openOpportunities: Number(oppsRow.c),
    availableDrivers: Number(driversRow.c),
    // Vehicles are reported on the available drivers' own records (there is
    // no separate vehicle fleet table). Counted, not guessed.
    availableVehicles: Number(vehiclesRow.c),
  };
}

// Detail rows backing the territory page's computed sections.
async function territoryContracts(territoryName) {
  return db.all('SELECT * FROM contracts WHERE territory = ? ORDER BY updated_at DESC', [territoryName]);
}
async function territoryOpportunities(territory) {
  const city = (territory.city || '').trim();
  const state = (territory.state || '').trim();
  if (city || state) {
    return db.all(
      `SELECT * FROM opportunities
        WHERE territory = ? OR location LIKE ? OR location LIKE ?
        ORDER BY updated_at DESC`,
      [territory.name, `%${city}%`, `%${state}%`]
    );
  }
  return db.all('SELECT * FROM opportunities WHERE territory = ? ORDER BY updated_at DESC', [territory.name]);
}
async function territoryDrivers(territory) {
  const city = (territory.city || '').trim();
  const state = (territory.state || '').trim();
  if (city || state) {
    return db.all(
      `SELECT id, full_name, status, vehicle_type, home_city, home_state FROM drivers
        WHERE status IN (${AVAILABLE_DRIVER_STATUSES.map(() => '?').join(', ')})
          AND (home_city = ? OR home_state = ?)
        ORDER BY full_name`,
      [...AVAILABLE_DRIVER_STATUSES, city, state]
    );
  }
  return db.all(
    `SELECT id, full_name, status, vehicle_type, home_city, home_state FROM drivers
      WHERE status IN (${AVAILABLE_DRIVER_STATUSES.map(() => '?').join(', ')}) ORDER BY full_name`,
    AVAILABLE_DRIVER_STATUSES
  );
}

module.exports = {
  AVAILABLE_DRIVER_STATUSES,
  validateTerritory,
  createTerritory,
  getTerritory,
  getTerritoryByName,
  updateTerritory,
  listTerritories,
  territoryStats,
  territoryContracts,
  territoryOpportunities,
  territoryDrivers,
};
