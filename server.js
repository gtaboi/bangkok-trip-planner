// Bangkok Trip Planner — zero-dependency Node server (Node 22.5+ for node:sqlite)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS = 10;
const MAX_VOTES = 3;

const db = new DatabaseSync(path.join(__dirname, 'trip.db'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS itineraries (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT, area TEXT,
    duration TEXT, cost TEXT, description TEXT,
    lead_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    day TEXT, notes TEXT, image TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
  CREATE TABLE IF NOT EXISTS votes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    itinerary_id INTEGER NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, itinerary_id));
`);

// Seed the poll with Bangkok itinerary ideas on first run
const SEED = [
  ['Grand Palace, Wat Phra Kaew & Wat Pho', 'Culture', 'Rattanakosin', 'Half day', '฿500–700 pp', 'The Emerald Buddha, the royal palace complex, and the giant Reclining Buddha. Dress code: covered shoulders and knees. Go early to beat heat and crowds.', 'wiki:Grand_Palace'],
  ['Wat Arun at sunset + Chao Phraya boat', 'Culture', 'Thonburi / Riverside', '3–4 hours', '฿200 pp', 'Cross by ferry to the Temple of Dawn, climb the prang, then ride the orange-flag river boat as the sun goes down.', 'wiki:Wat_Arun'],
  ['Chatuchak Weekend Market', 'Shopping', 'Chatuchak', 'Half day (Sat/Sun)', 'Bring cash', '15,000+ stalls: clothes, antiques, plants, coconut ice cream. Arrive by 10am and set a meeting point.', 'wiki:Chatuchak_Weekend_Market'],
  ['Yaowarat (Chinatown) street-food crawl', 'Food', 'Chinatown', 'Evening', '฿500–800 pp', 'Neon signs, Michelin-listed stalls, guay jub, toasted buns, seafood. Best after 6pm.', 'wiki:Yaowarat_Road'],
  ['Damnoen Saduak Floating Market + Maeklong Railway Market', 'Day trip', 'Ratchaburi / Samut Songkhram', 'Full day', '฿1,200–1,800 pp (tour)', 'Boat ride through the floating market, then watch the train roll through the market stalls at Maeklong.', 'wiki:Damnoen_Saduak_floating_market'],
  ['Ayutthaya ancient capital day trip', 'Day trip', 'Ayutthaya', 'Full day', '฿1,000–2,000 pp', 'UNESCO temple ruins, the Buddha head in tree roots at Wat Mahathat. Train, van, or private driver; rent bikes on site.', 'wiki:Wat_Mahathat_(Ayutthaya)'],
  ['Muay Thai night at Rajadamnern Stadium', 'Nightlife', 'Pom Prap', 'Evening', '฿2,000+ pp', 'Live Thai boxing at the historic stadium. Ringside or club seats for a group.', 'wiki:Rajadamnern_Stadium'],
  ['Rooftop bar evening (Sky Bar / Octave / Tichuca)', 'Nightlife', 'Silom / Sukhumvit', 'Evening', '฿600–1,000 pp', 'Skyline views and cocktails. Smart-casual dress code; book a table for 10.', 'wiki:Lebua_at_State_Tower'],
  ['Thai cooking class + local market tour', 'Food', 'Silom / Sukhumvit', 'Half day', '฿1,200–1,800 pp', 'Shop a wet market with a chef, then cook 4–5 dishes (pad thai, green curry, mango sticky rice).', 'wiki:Pad_thai'],
  ['Jim Thompson House + Siam shopping', 'Culture', 'Siam', 'Half day', '฿200 + shopping', 'Teak-house museum of the silk king, then MBK, Siam Paragon and Siam Square One.', 'wiki:Jim_Thompson_House'],
  ['ICONSIAM + Asiatique riverfront night', 'Shopping', 'Riverside', 'Afternoon–evening', 'Free entry', 'Indoor floating market (SookSiam) at ICONSIAM, then the Asiatique Ferris wheel and night bazaar.', 'wiki:Asiatique'],
  ['Bang Krachao "Green Lung" bike tour', 'Outdoors', 'Bang Krachao', 'Half day', '฿100 bike rental', 'Cross the river by longtail and cycle elevated paths through jungle, orchards, and a weekend market.', 'wiki:Bang_Kachao'],
  ['Traditional Thai massage at Wat Pho school', 'Wellness', 'Rattanakosin', '1–2 hours', '฿420–600 pp', 'The birthplace of Thai massage. Pair with the Grand Palace morning, or book a spa afternoon for the group.', 'wiki:Thai_massage'],
  ['Khao San Road night out', 'Nightlife', 'Banglamphu', 'Evening', '฿500+ pp', 'Backpacker street with bars, street food, and live music. Rambuttri Alley is a calmer alternative.', 'wiki:Khaosan_Road'],
  ['Erawan Museum + Ancient City (Muang Boran)', 'Culture', 'Samut Prakan', 'Full day', '฿700–1,000 pp', 'A three-headed elephant museum, then an open-air park of Thai landmarks you explore by golf cart or bike.', 'wiki:Erawan_Museum'],
  ['Safari World & Marine Park', 'Family / fun', 'Khlong Sam Wa', 'Full day', '฿1,500 pp', 'Drive-through safari plus animal shows. A good pick if the group wants something lighthearted.', 'wiki:Safari_World'],
  ['Jodd Fairs night market', 'Food', 'Rama IX', 'Evening', '฿300–600 pp', 'Volcano ribs, grilled seafood, and bars; easy to reach by MRT.', null],
  ['Lumpini Park morning + Sukhumvit brunch', 'Outdoors', 'Lumpini / Sukhumvit', 'Morning', '฿400 pp', 'Jog or walk with the monitor lizards, then a long brunch in Thonglor or Ekkamai.', 'wiki:Lumphini_Park'],
];
// Migrate databases created before thumbnails existed
if (!db.prepare('PRAGMA table_info(itineraries)').all().some((c) => c.name === 'image')) {
  db.exec('ALTER TABLE itineraries ADD COLUMN image TEXT');
}
if (db.prepare('SELECT COUNT(*) AS n FROM itineraries').get().n === 0) {
  const ins = db.prepare('INSERT INTO itineraries (title, category, area, duration, cost, description, image) VALUES (?,?,?,?,?,?,?)');
  for (const row of SEED) ins.run(...row);
} else {
  const fill = db.prepare('UPDATE itineraries SET image = ? WHERE title = ? AND image IS NULL');
  for (const row of SEED) if (row[6]) fill.run(row[6], row[0]);
}

// ---------- helpers ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function currentUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  return db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(m[1]) || null;
}

function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  send(res, 200, { user: { id: user.id, username: user.username } }, {
    'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
  });
}

const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function listItineraries(userId) {
  return db.prepare(`
    SELECT i.*, u.username AS lead_name,
      (SELECT COUNT(*) FROM votes v WHERE v.itinerary_id = i.id) AS votes,
      EXISTS(SELECT 1 FROM votes v WHERE v.itinerary_id = i.id AND v.user_id = ?) AS my_vote,
      (SELECT GROUP_CONCAT(uu.username, ', ') FROM votes v JOIN users uu ON uu.id = v.user_id WHERE v.itinerary_id = i.id) AS voters
    FROM itineraries i LEFT JOIN users u ON u.id = i.lead_id
    ORDER BY votes DESC, i.id ASC`).all(userId);
}

// ---------- API ----------
async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'POST /api/register') {
    const { username, password } = await readBody(req);
    const name = clean(username, 30);
    if (!/^[\w .-]{2,30}$/.test(name)) return send(res, 400, { error: 'Name must be 2–30 letters, numbers, spaces, . _ -' });
    if (!password || String(password).length < 4) return send(res, 400, { error: 'Password must be at least 4 characters' });
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= MAX_MEMBERS) return send(res, 403, { error: `The trip is full (${MAX_MEMBERS} members)` });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return send(res, 409, { error: 'That name is taken' });
    const salt = crypto.randomBytes(16).toString('hex');
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username, salt, hash) VALUES (?,?,?)').run(name, salt, hashPw(String(password), salt));
    return startSession(res, { id: Number(lastInsertRowid), username: name });
  }

  if (route === 'POST /api/login') {
    const { username, password } = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(clean(username, 30));
    if (!u || !crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(hashPw(String(password || ''), u.salt), 'hex')))
      return send(res, 401, { error: 'Wrong name or password' });
    return startSession(res, u);
  }

  if (route === 'POST /api/logout') {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    if (m) db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }

  const user = currentUser(req);
  if (route === 'GET /api/me') return send(res, 200, { user, maxVotes: MAX_VOTES, maxMembers: MAX_MEMBERS });
  if (!user) return send(res, 401, { error: 'Please log in' });

  if (route === 'GET /api/state') {
    const members = db.prepare(`
      SELECT u.id, u.username, i.title AS leads,
        (SELECT COUNT(*) FROM votes v WHERE v.user_id = u.id) AS votes_used
      FROM users u LEFT JOIN itineraries i ON i.lead_id = u.id ORDER BY u.id`).all();
    return send(res, 200, { itineraries: listItineraries(user.id), members });
  }

  if (route === 'POST /api/itineraries') {
    const b = await readBody(req);
    const title = clean(b.title, 120);
    if (!title) return send(res, 400, { error: 'Title is required' });
    const image = clean(b.image, 500);
    if (image && !/^https:\/\/\S+$/.test(image)) return send(res, 400, { error: 'Photo link must start with https://' });
    db.prepare('INSERT INTO itineraries (title, category, area, duration, cost, description, image, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(title, clean(b.category, 40), clean(b.area, 80), clean(b.duration, 60), clean(b.cost, 60), clean(b.description, 1000), image || null, user.id);
    return send(res, 201, { ok: true });
  }

  const m = /^\/api\/itineraries\/(\d+)\/(vote|claim|release|details|delete)$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    const id = Number(m[1]);
    const it = db.prepare('SELECT * FROM itineraries WHERE id = ?').get(id);
    if (!it) return send(res, 404, { error: 'Itinerary not found' });

    switch (m[2]) {
      case 'vote': {
        const has = db.prepare('SELECT 1 FROM votes WHERE user_id = ? AND itinerary_id = ?').get(user.id, id);
        if (has) {
          db.prepare('DELETE FROM votes WHERE user_id = ? AND itinerary_id = ?').run(user.id, id);
        } else {
          const used = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE user_id = ?').get(user.id).n;
          if (used >= MAX_VOTES) return send(res, 400, { error: `You've used all ${MAX_VOTES} votes. Remove one first.` });
          db.prepare('INSERT INTO votes (user_id, itinerary_id) VALUES (?, ?)').run(user.id, id);
        }
        return send(res, 200, { ok: true });
      }
      case 'claim': {
        if (it.lead_id) return send(res, 409, { error: 'Someone already leads this one' });
        const mine = db.prepare('SELECT title FROM itineraries WHERE lead_id = ?').get(user.id);
        if (mine) return send(res, 409, { error: `You already lead "${mine.title}". Release it first.` });
        db.prepare('UPDATE itineraries SET lead_id = ? WHERE id = ?').run(user.id, id);
        return send(res, 200, { ok: true });
      }
      case 'release': {
        if (it.lead_id !== user.id) return send(res, 403, { error: 'You are not the lead' });
        db.prepare('UPDATE itineraries SET lead_id = NULL WHERE id = ?').run(id);
        return send(res, 200, { ok: true });
      }
      case 'details': {
        if (it.lead_id !== user.id) return send(res, 403, { error: 'Only the lead can edit plan details' });
        const b = await readBody(req);
        db.prepare('UPDATE itineraries SET day = ?, notes = ? WHERE id = ?').run(clean(b.day, 60), clean(b.notes, 2000), id);
        return send(res, 200, { ok: true });
      }
      case 'delete': {
        if (it.created_by !== user.id) return send(res, 403, { error: 'Only whoever proposed it can delete it' });
        db.prepare('DELETE FROM itineraries WHERE id = ?').run(id);
        return send(res, 200, { ok: true });
      }
    }
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------- server ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => console.log(`Bangkok trip planner running at http://localhost:${PORT}`));
