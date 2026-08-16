'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'rack.db'));
// WAL survives container restarts better and lets reads proceed during writes.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS racks (
    rack_id     TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    secret_salt TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT 'Bench Rack',
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    rack_id TEXT PRIMARY KEY REFERENCES racks(rack_id) ON DELETE CASCADE,
    json    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id       TEXT NOT NULL,
    rack_id  TEXT NOT NULL REFERENCES racks(rack_id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    package  TEXT NOT NULL DEFAULT '',
    mpn      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (rack_id, id)
  );

  -- One row per part per compartment. A compartment may hold several parts,
  -- each with its own quantity, which is what makes shared bins work.
  CREATE TABLE IF NOT EXISTS locs (
    rack_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    row     INTEGER NOT NULL,
    col     INTEGER NOT NULL,
    qty     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (rack_id, item_id, row, col),
    FOREIGN KEY (rack_id, item_id) REFERENCES items(rack_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS locs_cell ON locs(rack_id, row, col);

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    rack_id    TEXT NOT NULL REFERENCES racks(rack_id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
`);

// Catalog lookups are never stored — items carry only what a rack needs to say
// which part is in which bin. Brand, SKU and distributor blurbs stay transient.

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashSecret(secret, salt) {
  return crypto.scryptSync(secret, salt, SCRYPT.keylen, SCRYPT).toString('hex');
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// Constant-time compare so a wrong key cannot be found by timing the response.
function secretMatches(secret, row) {
  const got = Buffer.from(hashSecret(secret, row.secret_salt), 'hex');
  const want = Buffer.from(row.secret_hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const q = {
  rackById: db.prepare('SELECT * FROM racks WHERE rack_id = ?'),
  insertRack: db.prepare(`INSERT INTO racks (rack_id, secret_hash, secret_salt, created_at, last_seen)
                          VALUES (?, ?, ?, ?, ?)`),
  touchRack: db.prepare('UPDATE racks SET last_seen = ? WHERE rack_id = ?'),
  renameRack: db.prepare('UPDATE racks SET name = ? WHERE rack_id = ?'),

  getConfig: db.prepare('SELECT json FROM config WHERE rack_id = ?'),
  putConfig: db.prepare(`INSERT INTO config (rack_id, json) VALUES (?, ?)
                         ON CONFLICT(rack_id) DO UPDATE SET json = excluded.json`),

  items: db.prepare('SELECT * FROM items WHERE rack_id = ?'),
  locs: db.prepare('SELECT * FROM locs WHERE rack_id = ?'),
  itemById: db.prepare('SELECT * FROM items WHERE rack_id = ? AND id = ?'),
  upsertItem: db.prepare(`INSERT INTO items (rack_id, id, name, category, package, mpn)
                          VALUES (@rack_id, @id, @name, @category, @package, @mpn)
                          ON CONFLICT(rack_id, id) DO UPDATE SET
                            name = excluded.name, category = excluded.category,
                            package = excluded.package, mpn = excluded.mpn`),
  deleteItem: db.prepare('DELETE FROM items WHERE rack_id = ? AND id = ?'),

  itemsInCell: db.prepare(`SELECT i.*, l.qty FROM locs l
                           JOIN items i ON i.rack_id = l.rack_id AND i.id = l.item_id
                           WHERE l.rack_id = ? AND l.row = ? AND l.col = ?`),
  setLoc: db.prepare(`INSERT INTO locs (rack_id, item_id, row, col, qty)
                      VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(rack_id, item_id, row, col) DO UPDATE SET qty = excluded.qty`),
  getLoc: db.prepare('SELECT qty FROM locs WHERE rack_id = ? AND item_id = ? AND row = ? AND col = ?'),
  deleteLoc: db.prepare('DELETE FROM locs WHERE rack_id = ? AND item_id = ? AND row = ? AND col = ?'),
  clearCell: db.prepare('DELETE FROM locs WHERE rack_id = ? AND row = ? AND col = ?'),
  locsOfItem: db.prepare('SELECT COUNT(*) AS n FROM locs WHERE rack_id = ? AND item_id = ?'),

  newSession: db.prepare('INSERT INTO sessions (token, rack_id, created_at) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  dropOldSessions: db.prepare('DELETE FROM sessions WHERE created_at < ?'),
};

// First device to present a rackId claims it; after that the secret must match.
// The secret only ever leaves the ESP32 over BLE, so possession implies the
// person was physically next to the rack.
function authenticate(rackId, secret) {
  const now = Date.now();
  const existing = q.rackById.get(rackId);
  if (!existing) {
    const salt = newSalt();
    q.insertRack.run(rackId, hashSecret(secret, salt), salt, now, now);
    return { ok: true, created: true, rack: q.rackById.get(rackId) };
  }
  if (!secretMatches(secret, existing)) return { ok: false };
  q.touchRack.run(now, rackId);
  return { ok: true, created: false, rack: existing };
}

function createSession(rackId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.newSession.run(token, rackId, Date.now());
  // Keep the table from growing without bound; 30 days is well past useful.
  q.dropOldSessions.run(Date.now() - 30 * 24 * 3600 * 1000);
  return token;
}

function inventory(rackId) {
  const items = q.items.all(rackId);
  const locs = q.locs.all(rackId);
  const byItem = new Map();
  for (const l of locs) {
    if (!byItem.has(l.item_id)) byItem.set(l.item_id, []);
    byItem.get(l.item_id).push({ row: l.row, col: l.col, qty: l.qty });
  }
  return items
    .map((it) => ({
      id: it.id,
      name: it.name,
      category: it.category,
      package: it.package,
      mpn: it.mpn,
      locs: byItem.get(it.id) || [],
    }))
    .filter((it) => it.locs.length)
    .map((it) => ({ ...it, qty: it.locs.reduce((a, l) => a + l.qty, 0) }));
}

// Drops an item once its last compartment is emptied, so the table does not fill
// with parts that are no longer anywhere in the rack.
function pruneItem(rackId, itemId) {
  if (q.locsOfItem.get(rackId, itemId).n === 0) q.deleteItem.run(rackId, itemId);
}

module.exports = { db, q, authenticate, createSession, inventory, pruneItem };
