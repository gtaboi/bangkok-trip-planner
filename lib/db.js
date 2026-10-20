'use strict';
// Data access: schema, in-place migrations, seed, and statements prepared once.
const { DatabaseSync } = require('node:sqlite');
const { SEED } = require('./seed');
const { normalizeImage } = require('./rules');
const { hashToken } = require('./security');

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER, expires_at INTEGER);
  CREATE TABLE IF NOT EXISTS itineraries (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT, area TEXT,
    duration TEXT, cost TEXT, description TEXT,
    lead_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    day TEXT, notes TEXT, image TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    image_url TEXT);
  CREATE TABLE IF NOT EXISTS votes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    itinerary_id INTEGER NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, itinerary_id));
`;

const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

function migrate(db, now = Date.now()) {
  // Databases created before thumbnails existed
  if (!hasColumn(db, 'itineraries', 'image')) db.exec('ALTER TABLE itineraries ADD COLUMN image TEXT');
  // #7: server-resolved photo address
  if (!hasColumn(db, 'itineraries', 'image_url')) db.exec('ALTER TABLE itineraries ADD COLUMN image_url TEXT');
  // #6: session expiry. Old rows get 30 days from now, and their raw tokens are
  // replaced by sha256(token) so a leaked DB can't be used to log in.
  if (!hasColumn(db, 'sessions', 'expires_at')) {
    tx(db, () => {
      if (!hasColumn(db, 'sessions', 'created_at')) db.exec('ALTER TABLE sessions ADD COLUMN created_at INTEGER');
      db.exec('ALTER TABLE sessions ADD COLUMN expires_at INTEGER');
      const upd = db.prepare('UPDATE sessions SET token = ?, created_at = ?, expires_at = ? WHERE token = ?');
      for (const { token } of db.prepare('SELECT token FROM sessions').all()) {
        upd.run(hashToken(token), now, now + SESSION_MS, token);
      }
    });
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS votes_itinerary ON votes(itinerary_id);
  `);
  // #7: photo links stored before the allow-list. Wikipedia page links become
  // wiki:<Title>, upload.wikimedia.org links are kept, anything else is dropped.
  const fix = db.prepare('UPDATE itineraries SET image = ?, image_url = ? WHERE id = ?');
  for (const row of db.prepare("SELECT id, image FROM itineraries WHERE image LIKE 'http%' AND image_url IS NULL").all()) {
    const r = normalizeImage(row.image);
    if (r.error) fix.run(null, null, row.id);
    else fix.run(r.image, r.imageUrl, row.id);
  }
}

function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM itineraries').get().n === 0) {
    const ins = db.prepare('INSERT INTO itineraries (title, category, area, duration, cost, description, image) VALUES (?,?,?,?,?,?,?)');
    tx(db, () => { for (const row of SEED) ins.run(...row); });
  } else {
    const fill = db.prepare('UPDATE itineraries SET image = ? WHERE title = ? AND image IS NULL');
    for (const row of SEED) if (row[6]) fill.run(row[6], row[0]);
  }
}

/** Open (or create) the database and return the data-access object. */
function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);

  const p = (sql) => db.prepare(sql);
  const s = {
    countUsers: p('SELECT COUNT(*) AS n FROM users'),
    userByName: p('SELECT * FROM users WHERE username = ?'),
    createUser: p('INSERT INTO users (username, salt, hash) VALUES (?,?,?)'),
    createSession: p('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)'),
    sessionUser: p(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.token = ? AND s.expires_at > ?`),
    deleteSession: p('DELETE FROM sessions WHERE token = ?'),
    deleteUserSessions: p('DELETE FROM sessions WHERE user_id = ?'),
    pruneSessions: p('DELETE FROM sessions WHERE expires_at IS NULL OR expires_at <= ?'),
    listItineraries: p(`
      SELECT i.*, u.username AS lead_name,
        (SELECT COUNT(*) FROM votes v WHERE v.itinerary_id = i.id) AS votes,
        (SELECT COUNT(*) FROM votes v WHERE v.itinerary_id = i.id AND v.user_id IS NOT i.created_by) AS other_votes,
        EXISTS(SELECT 1 FROM votes v WHERE v.itinerary_id = i.id AND v.user_id = ?) AS my_vote,
        (SELECT GROUP_CONCAT(uu.username, ', ') FROM votes v JOIN users uu ON uu.id = v.user_id WHERE v.itinerary_id = i.id) AS voters
      FROM itineraries i LEFT JOIN users u ON u.id = i.lead_id
      ORDER BY votes DESC, i.id ASC`),
    members: p(`
      SELECT u.id, u.username, i.title AS leads,
        (SELECT COUNT(*) FROM votes v WHERE v.user_id = u.id) AS votes_used
      FROM users u LEFT JOIN itineraries i ON i.lead_id = u.id ORDER BY u.id`),
    getItinerary: p('SELECT * FROM itineraries WHERE id = ?'),
    createItinerary: p(`INSERT INTO itineraries (title, category, area, duration, cost, description, image, image_url, created_by)
                        VALUES (?,?,?,?,?,?,?,?,?)`),
    leadOf: p('SELECT id, title FROM itineraries WHERE lead_id = ?'),
    setLead: p('UPDATE itineraries SET lead_id = ? WHERE id = ?'),
    setDetails: p('UPDATE itineraries SET day = ?, notes = ? WHERE id = ?'),
    deleteItinerary: p('DELETE FROM itineraries WHERE id = ?'),
    hasVote: p('SELECT 1 FROM votes WHERE user_id = ? AND itinerary_id = ?'),
    votesUsed: p('SELECT COUNT(*) AS n FROM votes WHERE user_id = ?'),
    addVote: p('INSERT INTO votes (user_id, itinerary_id) VALUES (?, ?)'),
    removeVote: p('DELETE FROM votes WHERE user_id = ? AND itinerary_id = ?'),
    otherVotes: p('SELECT COUNT(*) AS n FROM votes WHERE itinerary_id = ? AND user_id IS NOT ?'),
    pendingWiki: p("SELECT id, image FROM itineraries WHERE image LIKE 'wiki:%' AND image_url IS NULL ORDER BY id"),
    setImageUrl: p('UPDATE itineraries SET image_url = ? WHERE id = ? AND image = ?'),
  };

  return {
    db,
    tx: (fn) => tx(db, fn),
    close: () => db.close(),

    countUsers: () => s.countUsers.get().n,
    userByName: (name) => s.userByName.get(name) || null,
    createUser: (name, salt, hash) => Number(s.createUser.run(name, salt, hash).lastInsertRowid),

    createSession: (tokenHash, userId, now, expiresAt) => s.createSession.run(tokenHash, userId, now, expiresAt),
    sessionUser: (tokenHash, now) => s.sessionUser.get(tokenHash, now) || null,
    deleteSession: (tokenHash) => s.deleteSession.run(tokenHash),
    deleteUserSessions: (userId) => s.deleteUserSessions.run(userId),
    pruneSessions: (now) => Number(s.pruneSessions.run(now).changes),

    listItineraries: (userId) => s.listItineraries.all(userId),
    members: () => s.members.all(),
    getItinerary: (id) => s.getItinerary.get(id) || null,
    createItinerary: (f) => Number(s.createItinerary.run(
      f.title, f.category, f.area, f.duration, f.cost, f.description, f.image, f.imageUrl, f.createdBy,
    ).lastInsertRowid),
    leadOf: (userId) => s.leadOf.get(userId) || null,
    setLead: (id, userId) => s.setLead.run(userId, id),
    setDetails: (id, day, notes) => s.setDetails.run(day, notes, id),
    deleteItinerary: (id) => s.deleteItinerary.run(id),

    hasVote: (userId, id) => !!s.hasVote.get(userId, id),
    votesUsed: (userId) => s.votesUsed.get(userId).n,
    addVote: (userId, id) => s.addVote.run(userId, id),
    removeVote: (userId, id) => s.removeVote.run(userId, id),
    otherVotes: (id, createdBy) => s.otherVotes.get(id, createdBy ?? null).n,

    pendingWikiImages: () => s.pendingWiki.all(),
    setImageUrl: (id, url, image) => s.setImageUrl.run(url, id, image),
  };
}

module.exports = { openDb, SESSION_MS };
