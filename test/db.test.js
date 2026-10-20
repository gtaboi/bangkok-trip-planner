'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../lib/db');
const { SEED } = require('../lib/seed');
const { hashToken } = require('../lib/security');

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test('fresh database is created and seeded', () => {
  const store = openDb(':memory:');
  assert.equal(store.listItineraries(0).length, SEED.length);
  assert.ok(cols(store.db, 'sessions').includes('expires_at'));
  assert.ok(cols(store.db, 'itineraries').includes('image_url'));
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  store.close();
});

test('migrates a trip.db created by the original main schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-mig-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  // Exact schema from main@59a70a1
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE itineraries (id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT, area TEXT,
      duration TEXT, cost TEXT, description TEXT, lead_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
      day TEXT, notes TEXT, image TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
    CREATE TABLE votes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      itinerary_id INTEGER NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE, PRIMARY KEY (user_id, itinerary_id));
    INSERT INTO users (id, username, salt, hash) VALUES (1, 'alice', 's', 'h');
    INSERT INTO sessions VALUES ('${'a'.repeat(64)}', 1);
    INSERT INTO itineraries (id, title, image, created_by) VALUES
      (1, 'Grand Palace, Wat Phra Kaew & Wat Pho', NULL, NULL),
      (2, 'Tracker', 'https://tracker.example/p.gif?trip=bkk', 1),
      (3, 'Upload', 'https://upload.wikimedia.org/a/b.jpg', 1),
      (4, 'Page', 'https://en.wikipedia.org/wiki/Wat_Arun', 1);
    INSERT INTO votes VALUES (1, 1);
  `);
  old.close();

  const store = openDb(file);
  try {
    assert.ok(cols(store.db, 'sessions').includes('created_at'));
    // Old raw token was replaced by its hash and given a 30-day expiry
    const row = store.db.prepare('SELECT * FROM sessions').get();
    assert.equal(row.token, hashToken('a'.repeat(64)));
    assert.ok(row.expires_at > Date.now() + 29 * 86400e3);
    assert.deepEqual({ ...store.sessionUser(hashToken('a'.repeat(64)), Date.now()) }, { id: 1, username: 'alice' });
    // Images: seed backfilled by title, tracker dropped, upload kept, page link converted
    const img = (id) => ({ ...store.db.prepare('SELECT image, image_url FROM itineraries WHERE id = ?').get(id) });
    assert.deepEqual(img(1), { image: 'wiki:Grand_Palace', image_url: null });
    assert.deepEqual(img(2), { image: null, image_url: null });
    assert.deepEqual(img(3), { image: 'https://upload.wikimedia.org/a/b.jpg', image_url: 'https://upload.wikimedia.org/a/b.jpg' });
    assert.deepEqual(img(4), { image: 'wiki:Wat_Arun', image_url: null });
    // Data kept, no reseed
    assert.equal(store.listItineraries(1).length, 4);
    assert.equal(store.votesUsed(1), 1);
    store.close();
    // Re-opening is a no-op
    const again = openDb(file);
    assert.equal(again.db.prepare('SELECT token FROM sessions').get().token, hashToken('a'.repeat(64)));
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneSessions removes expired rows only', () => {
  const store = openDb(':memory:');
  const id = store.createUser('bob', 's', 'h');
  store.createSession('old', id, 0, 1000);
  store.createSession('new', id, 0, Date.now() + 1e6);
  assert.equal(store.pruneSessions(Date.now()), 1);
  assert.equal(store.sessionUser('old', Date.now()), null);
  assert.ok(store.sessionUser('new', Date.now()));
  store.close();
});

test('tx rolls back on error', () => {
  const store = openDb(':memory:');
  assert.throws(() => store.tx(() => { store.createUser('carol', 's', 'h'); throw new Error('boom'); }), /boom/);
  assert.equal(store.userByName('carol'), null);
  store.close();
});
