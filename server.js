// Bangkok Trip Planner — zero-dependency Node server (Node 22.5+ for node:sqlite)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const { openDb, SESSION_MS } = require('./lib/db');
const { createImageResolver } = require('./lib/images');
const rules = require('./lib/rules');
const {
  SECURITY_HEADERS, HttpError, checkOrigin, checkContentType, readBody,
  createRateLimiter, readSid, hashToken, safeEqual,
} = require('./lib/security');

// ---------- settings (the client reads these from GET /api/me) ----------
const MAX_MEMBERS = 10;
const MAX_VOTES = 3;
const MIN_PASSWORD = 8;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const BODY_LIMIT = 100 * 1024;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
const ITEM_ROUTE = /^\/api\/itineraries\/(\d+)\/(vote|claim|release|details|delete)$/;

// ---------- passwords ----------
const scrypt = promisify(crypto.scrypt);
const hashPassword = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

/** Always runs one scrypt, even for unknown users, so timing doesn't reveal which names exist. */
async function verifyPassword(password, user) {
  const salt = user ? user.salt : DUMMY_SALT;
  const actual = Buffer.from(await hashPassword(password, salt), 'hex');
  if (!user) return false;
  const expected = Buffer.from(user.hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------- responses ----------
const reply = (status, body, headers = {}) => ({ status, body, headers });
const ok = (body = { ok: true }, headers) => reply(200, body, headers);
const fail = (status, error, headers) => reply(status, { error }, headers);
const refuse = (decision) => fail(decision.status, decision.error);
const tooMany = (ms) => {
  const min = Math.max(1, Math.ceil(ms / 60000));
  return fail(429, `Too many attempts, try again in ${min} minute${min === 1 ? '' : 's'}`,
    { 'Retry-After': String(Math.ceil(ms / 1000)) });
};

function send(res, { status, body, headers }) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return sendText(res, 400, 'Bad request'); }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  const type = TYPES[path.extname(file).toLowerCase()];
  const hidden = rel.split('/').some((seg) => seg.startsWith('.'));
  if (!type || hidden || rel.includes('\0') || !file.startsWith(PUBLIC + path.sep)) return sendText(res, 404, 'Not found');
  let stat;
  try { stat = await fs.promises.stat(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) return sendText(res, 404, 'Not found');
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ---------- app ----------
/**
 * Build the HTTP server (not listening yet).
 * @param {object} o
 * @param {object|string} [o.db]   store from openDb(), or a path (default ':memory:')
 * @param {object} [o.env]         env vars: TRIP_CODE, COOKIE_SECURE, TRIP_OFFLINE
 * @param {Function|false} [o.fetch] fetch used for Wikipedia lookups; false disables them
 */
function createApp({ db, env = process.env, fetch: fetchOpt, imageDelayMs = 500, log = console } = {}) {
  const store = db && typeof db === 'object' ? db : openDb(db || ':memory:');
  const inviteCode = String(env.TRIP_CODE || '').trim();
  const forceSecure = env.COOKIE_SECURE === '1';
  const fetchFn = fetchOpt === false || env.TRIP_OFFLINE === '1' ? null : (fetchOpt || globalThis.fetch);
  const limiter = createRateLimiter({ max: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS });
  const images = createImageResolver({ store, fetch: fetchFn, delayMs: imageDelayMs, log });

  const isSecure = (req) => forceSecure
    || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  const cookie = (req, value, maxAgeSec) =>
    `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`;
  const clearCookie = (req) => ({ 'Set-Cookie': cookie(req, '', 0) });

  function currentUser(req) {
    const sid = readSid(req);
    return sid ? store.sessionUser(hashToken(sid), Date.now()) : null;
  }

  function startSession(req, user) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    store.createSession(hashToken(token), user.id, now, now + SESSION_MS);
    return ok({ user: { id: user.id, username: user.username } },
      { 'Set-Cookie': cookie(req, token, SESSION_MS / 1000) });
  }

  // ----- account routes -----
  function me({ user }) {
    return ok({ user, maxVotes: MAX_VOTES, maxMembers: MAX_MEMBERS, minPassword: MIN_PASSWORD, inviteRequired: !!inviteCode });
  }

  async function register({ req, body, ip }) {
    const v = rules.validateRegistration({ username: body.username, password: body.password, minPassword: MIN_PASSWORD });
    if (v.error) return refuse(v);
    if (inviteCode) {
      const key = `invite:${ip}`;
      const wait = limiter.retryAfter(key);
      if (wait) return tooMany(wait);
      if (typeof body.code !== 'string' || !safeEqual(body.code.trim(), inviteCode)) {
        limiter.fail(key);
        return fail(403, 'Wrong invite code');
      }
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPassword(body.password, salt);
    const result = store.tx(() => {
      const d = rules.decideJoin({
        memberCount: store.countUsers(), maxMembers: MAX_MEMBERS, nameTaken: !!store.userByName(v.username),
      });
      return d.error ? d : { id: store.createUser(v.username, salt, hash) };
    });
    if (result.error) return refuse(result);
    return startSession(req, { id: result.id, username: v.username });
  }

  async function login({ req, body, ip }) {
    const name = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const keys = [`ip:${ip}`, `user:${name.toLowerCase()}`];
    const wait = Math.max(...keys.map((k) => limiter.retryAfter(k)));
    if (wait) return tooMany(wait);
    const user = name && name.length <= 30 ? store.userByName(name) : null;
    if (!(await verifyPassword(password, user))) {
      keys.forEach((k) => limiter.fail(k));
      return fail(401, 'Wrong name or password');
    }
    limiter.reset(keys[1]);
    return startSession(req, user);
  }

  function logout({ req }) {
    const sid = readSid(req);
    if (sid) store.deleteSession(hashToken(sid));
    return ok({ ok: true }, clearCookie(req));
  }

  function logoutAll({ req, user }) {
    store.deleteUserSessions(user.id);
    return ok({ ok: true }, clearCookie(req));
  }

  // ----- poll routes -----
  function state({ user }) {
    const itineraries = store.listItineraries(user.id).map((it) => ({
      ...it,
      can_delete: rules.canDelete(it, user.id, it.other_votes),
      image_link: rules.imageLink(it.image),
    }));
    return ok({ itineraries, members: store.members() });
  }

  function propose({ body, user }) {
    const title = rules.clean(body.title, 120);
    if (!title) return fail(400, 'Title is required');
    const img = rules.normalizeImage(body.image);
    if (img.error) return refuse(img);
    const id = store.createItinerary({
      title,
      category: rules.clean(body.category, 40),
      area: rules.clean(body.area, 80),
      duration: rules.clean(body.duration, 60),
      cost: rules.clean(body.cost, 60),
      description: rules.clean(body.description, 1000),
      image: img.image,
      imageUrl: img.imageUrl,
      createdBy: user.id,
    });
    if (rules.wikiTitle(img.image)) images.enqueue(id);
    return reply(201, { ok: true, id });
  }

  // Each action runs inside one transaction: read, decide, write.
  const ACTIONS = {
    vote(it, userId) {
      const d = rules.decideVote({ hasVote: store.hasVote(userId, it.id), used: store.votesUsed(userId), max: MAX_VOTES });
      if (d.ok) (d.action === 'add' ? store.addVote : store.removeVote)(userId, it.id);
      return d;
    },
    claim(it, userId) {
      const d = rules.decideClaim({ itinerary: it, userId, currentLead: store.leadOf(userId) });
      if (d.ok) store.setLead(it.id, userId);
      return d;
    },
    release(it, userId) {
      const d = rules.decideRelease({ itinerary: it, userId });
      if (d.ok) store.setLead(it.id, null);
      return d;
    },
    details(it, userId, body) {
      const d = rules.decideDetails({ itinerary: it, userId });
      if (d.ok) store.setDetails(it.id, rules.clean(body.day, 60), rules.clean(body.notes, 2000));
      return d;
    },
    delete(it, userId) {
      const d = rules.decideDelete({ itinerary: it, userId, otherVotes: store.otherVotes(it.id, it.created_by) });
      if (d.ok) store.deleteItinerary(it.id);
      return d;
    },
  };

  function itemAction({ user, body }, id, action) {
    const d = store.tx(() => {
      const it = store.getItinerary(id);
      return it ? ACTIONS[action](it, user.id, body) : { status: 404, error: 'Itinerary not found' };
    });
    return d.error ? refuse(d) : ok();
  }

  // ----- router -----
  const auth = (handler) => (ctx) => (ctx.user ? handler(ctx) : fail(401, 'Please log in'));
  const ROUTES = {
    'GET /api/me': me,
    'POST /api/register': register,
    'POST /api/login': login,
    'POST /api/logout': logout,
    'POST /api/logout-all': auth(logoutAll),
    'GET /api/state': auth(state),
    'POST /api/itineraries': auth(propose),
  };

  async function api(req, url) {
    const ctx = { req, ip: req.socket.remoteAddress || '', body: {}, user: null };
    if (req.method === 'POST') {
      const bad = checkOrigin(req) || checkContentType(req);
      if (bad) { req.resume(); return fail(bad.status, bad.error); }
      ctx.body = await readBody(req, BODY_LIMIT);
    }
    ctx.user = currentUser(req);
    const route = ROUTES[`${req.method} ${url.pathname}`];
    if (route) return route(ctx);
    const m = ITEM_ROUTE.exec(url.pathname);
    if (m && req.method === 'POST') return auth((c) => itemAction(c, Number(m[1]), m[2]))(ctx);
    return fail(404, 'Not found');
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return send(res, await api(req, url));
      return await serveStatic(req, res, url);
    } catch (err) {
      const known = err instanceof HttpError;
      if (!known) log.error(err);
      if (res.headersSent) return res.destroy();
      send(res, known ? fail(err.status, err.message, err.headers) : fail(500, 'Server error'));
    }
  }

  const server = http.createServer(handle);

  // #6: drop expired sessions (and stale rate-limit entries) at startup and hourly
  const prune = () => {
    try { store.pruneSessions(Date.now()); limiter.prune(); } catch (e) { log.error(e); }
  };
  prune();
  const timer = setInterval(prune, PRUNE_EVERY_MS);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  // #7: look up missing Wikipedia thumbnails in the background once we're up
  server.on('listening', () => { images.resolvePending(); });

  server.locals = { store, images, limiter };
  return server;
}

module.exports = { createApp, MAX_MEMBERS, MAX_VOTES, MIN_PASSWORD };

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '127.0.0.1';
  const store = openDb(process.env.TRIP_DB || path.join(__dirname, 'trip.db'));
  if (!process.env.TRIP_CODE) {
    console.warn('Warning: TRIP_CODE is not set, so anyone who can reach this server can register.');
  }
  createApp({ db: store }).listen(PORT, HOST, () => {
    console.log(`Bangkok trip planner running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}
