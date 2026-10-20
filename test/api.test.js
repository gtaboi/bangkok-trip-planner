'use strict';
// Integration tests: createApp on an ephemeral port with an in-memory DB. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { openDb } = require('../lib/db');

const quiet = { log() {}, warn() {}, error() {} };
const PASSWORD = 'correct horse';

async function startApp({ env = {}, fetch = false } = {}) {
  const store = openDb(':memory:');
  const server = createApp({ db: store, env, fetch, imageDelayMs: 0, log: quiet });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server, store, port,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/** Minimal HTTP client with its own cookie jar (http.request so we control every header). */
function client(port) {
  let sid = null;
  const call = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const h = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
    if (sid) h.cookie = `sid=${sid}`;
    let payload = null;
    if (method === 'POST') {
      if (!('content-type' in headers)) h['content-type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
      h['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const setCookie = (res.headers['set-cookie'] || []).join(';');
        const m = /sid=([a-f0-9]*)/.exec(setCookie);
        if (m) sid = m[1] || null;
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, json, text, setCookie });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
  return {
    get: (p, h) => call('GET', p, null, h),
    post: (p, b, h) => call('POST', p, b, h),
    get sid() { return sid; },
    set sid(v) { sid = v; },
  };
}

async function member(port, username, extra = {}) {
  const c = client(port);
  const res = await c.post('/api/register', { username, password: PASSWORD, ...extra });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  c.id = res.json.user.id;
  return c;
}

test('GET /api/me reports settings', async () => {
  const app = await startApp({ env: { TRIP_CODE: 'bkk2026' } });
  try {
    const res = await client(app.port).get('/api/me');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { user: null, maxVotes: 3, maxMembers: 10, minPassword: 8, inviteRequired: true });
  } finally { await app.close(); }
});

test('register: invite code and password rules', async () => {
  const app = await startApp({ env: { TRIP_CODE: 'bkk2026' } });
  try {
    const c = client(app.port);
    let res = await c.post('/api/register', { username: 'alice', password: PASSWORD });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'Wrong invite code');
    res = await c.post('/api/register', { username: 'alice', password: PASSWORD, code: 'nope' });
    assert.equal(res.status, 403);
    res = await c.post('/api/register', { username: 'alice', password: 'short', code: 'bkk2026' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /at least 8/);
    res = await c.post('/api/register', { username: 'alice', password: PASSWORD, code: ' bkk2026 ' });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.username, 'alice');
    assert.match(res.setCookie, /HttpOnly/);
    assert.match(res.setCookie, /SameSite=Lax/);
    assert.doesNotMatch(res.setCookie, /Secure/);
    assert.equal((await c.get('/api/me')).json.user.username, 'alice');
    // Stored token is hashed, not the cookie value
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token = ?').get(c.sid).n, 0);
    res = await client(app.port).post('/api/register', { username: 'ALICE', password: PASSWORD, code: 'bkk2026' });
    assert.equal(res.status, 409);
  } finally { await app.close(); }
});

test('register without TRIP_CODE stays open; trip fills at 10', async () => {
  const app = await startApp();
  try {
    assert.equal((await client(app.port).get('/api/me')).json.inviteRequired, false);
    for (let i = 0; i < 10; i++) await member(app.port, `user${i}`);
    const res = await client(app.port).post('/api/register', { username: 'eleven', password: PASSWORD });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /full/);
  } finally { await app.close(); }
});

test('login: success, failure, and 429 after 10 failures', async () => {
  const app = await startApp();
  try {
    await member(app.port, 'bob');
    const c = client(app.port);
    assert.equal((await c.post('/api/login', { username: 'bob', password: PASSWORD })).status, 200);
    assert.equal((await c.post('/api/login', { username: 'nobody', password: PASSWORD })).status, 401);
    for (let i = 0; i < 9; i++) {
      assert.equal((await c.post('/api/login', { username: 'bob', password: 'wrong-password' })).status, 401);
    }
    const res = await c.post('/api/login', { username: 'bob', password: PASSWORD });
    assert.equal(res.status, 429, 'IP has 10 failures now');
    assert.match(res.json.error, /^Too many attempts, try again in 15 minutes$/);
    assert.ok(Number(res.headers['retry-after']) > 0);
  } finally { await app.close(); }
});

test('voting: cap of 3, toggling off, 404 for unknown itinerary', async () => {
  const app = await startApp();
  try {
    const c = await member(app.port, 'carol');
    for (const id of [1, 2, 3]) assert.equal((await c.post(`/api/itineraries/${id}/vote`)).status, 200);
    const res = await c.post('/api/itineraries/4/vote');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /all 3 votes/);
    assert.equal((await c.post('/api/itineraries/3/vote', {})).status, 200, 'toggle off');
    assert.equal((await c.post('/api/itineraries/4/vote', {})).status, 200);
    assert.equal((await c.post('/api/itineraries/999/vote', {})).status, 404);
    const state = (await c.get('/api/state')).json;
    assert.deepEqual(state.itineraries.slice(0, 3).map((i) => i.id), [1, 2, 4], 'sorted by votes, then id');
    assert.equal(state.members[0].votes_used, 3);
  } finally { await app.close(); }
});

test('delete guard and can_delete / other_votes', async () => {
  const app = await startApp();
  try {
    const alice = await member(app.port, 'alice');
    const bob = await member(app.port, 'bob');
    let res = await alice.post('/api/itineraries', { title: 'Wellness spa day', category: 'Wellness' });
    assert.equal(res.status, 201);
    const id = res.json.id;
    const find = async (c) => (await c.get('/api/state')).json.itineraries.find((i) => i.id === id);

    await alice.post(`/api/itineraries/${id}/vote`);
    let it = await find(alice);
    assert.equal(it.votes, 1);
    assert.equal(it.other_votes, 0);
    assert.equal(it.can_delete, true);
    assert.equal((await find(bob)).can_delete, false, 'only the proposer');

    await bob.post(`/api/itineraries/${id}/vote`);
    it = await find(alice);
    assert.equal(it.other_votes, 1);
    assert.equal(it.can_delete, false);
    res = await alice.post(`/api/itineraries/${id}/delete`);
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "Can't delete: 1 other vote is attached");

    await bob.post(`/api/itineraries/${id}/vote`); // bob removes his vote
    assert.equal((await bob.post(`/api/itineraries/${id}/claim`)).status, 200);
    res = await alice.post(`/api/itineraries/${id}/delete`);
    assert.equal(res.status, 409);
    assert.match(res.json.error, /a lead/);
    assert.equal((await bob.post(`/api/itineraries/${id}/delete`)).status, 403);

    await bob.post(`/api/itineraries/${id}/release`);
    assert.equal((await find(alice)).can_delete, true);
    assert.equal((await alice.post(`/api/itineraries/${id}/delete`)).status, 200);
    assert.equal(await find(alice), undefined);
    // Seeded itineraries have no proposer
    assert.equal((await alice.get('/api/state')).json.itineraries.every((i) => i.can_delete === false), true);
  } finally { await app.close(); }
});

test('claim, release and details rules', async () => {
  const app = await startApp();
  try {
    const a = await member(app.port, 'alice');
    const b = await member(app.port, 'bob');
    assert.equal((await a.post('/api/itineraries/1/claim')).status, 200);
    assert.equal((await b.post('/api/itineraries/1/claim')).status, 409);
    assert.equal((await a.post('/api/itineraries/2/claim')).status, 409);
    assert.equal((await b.post('/api/itineraries/1/details', { day: 'Sat', notes: 'x' })).status, 403);
    assert.equal((await a.post('/api/itineraries/1/details', { day: 'Day 2', notes: 'Booked\nmassages' })).status, 200);
    const it = (await a.get('/api/state')).json.itineraries.find((i) => i.id === 1);
    assert.equal(it.day, 'Day 2');
    assert.equal(it.notes, 'Booked\nmassages');
    assert.equal(it.lead_name, 'alice');
    assert.equal((await b.post('/api/itineraries/1/release')).status, 403);
    assert.equal((await a.post('/api/itineraries/1/release')).status, 200);
  } finally { await app.close(); }
});

test('CSRF checks: 415 for non-JSON, 403 for foreign Origin, bad bodies', async () => {
  const app = await startApp();
  try {
    const c = await member(app.port, 'dave');
    let res = await c.post('/api/itineraries/1/vote', '{}', { 'content-type': 'text/plain' });
    assert.equal(res.status, 415);
    res = await c.post('/api/login', '{"username":"dave","password":"correct horse","x":"="}', { 'content-type': 'text/plain' });
    assert.equal(res.status, 415);
    res = await c.post('/api/itineraries/1/vote', {}, { 'content-type': undefined });
    assert.equal(res.status, 415);
    res = await c.post('/api/itineraries/1/vote', {}, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    res = await c.post('/api/itineraries/1/vote', {}, { origin: 'http://127.0.0.1:1' });
    assert.equal(res.status, 403, 'same host, other port');
    res = await c.post('/api/itineraries/1/vote', {}, { origin: `http://127.0.0.1:${app.port}` });
    assert.equal(res.status, 200);
    assert.equal((await c.post('/api/itineraries', '{"title":')).status, 400);
    assert.equal((await c.post('/api/itineraries', '{"title":')).json.error, 'Invalid JSON');
    res = await c.post('/api/itineraries', JSON.stringify({ title: 'x'.repeat(200 * 1024) }));
    assert.equal(res.status, 413);
  } finally { await app.close(); }
});

test('logout-all revokes other sessions; logout ends one', async () => {
  const app = await startApp();
  try {
    const phone = await member(app.port, 'erin');
    const laptop = client(app.port);
    assert.equal((await laptop.post('/api/login', { username: 'erin', password: PASSWORD })).status, 200);
    const tablet = client(app.port);
    await tablet.post('/api/login', { username: 'erin', password: PASSWORD });

    assert.equal((await tablet.post('/api/logout')).status, 200);
    assert.equal((await tablet.get('/api/me')).json.user, null);
    assert.equal((await laptop.get('/api/me')).json.user.username, 'erin');

    const res = await phone.post('/api/logout-all');
    assert.deepEqual(res.json, { ok: true });
    assert.match(res.setCookie, /Max-Age=0/);
    assert.equal((await laptop.get('/api/state')).status, 401);
    assert.equal((await laptop.get('/api/me')).json.user, null);
    assert.equal((await client(app.port).post('/api/logout-all')).status, 401);
  } finally { await app.close(); }
});

test('expired session returns 401', async () => {
  const app = await startApp();
  try {
    const c = await member(app.port, 'frank');
    assert.equal((await c.get('/api/state')).status, 200);
    app.store.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await c.get('/api/state')).status, 401);
    assert.equal(app.store.pruneSessions(Date.now()), 1);
  } finally { await app.close(); }
});

test('Secure cookie flag', async () => {
  const forced = await startApp({ env: { COOKIE_SECURE: '1' } });
  try {
    const res = await client(forced.port).post('/api/register', { username: 'gina', password: PASSWORD });
    assert.match(res.setCookie, /; Secure/);
  } finally { await forced.close(); }
  const proxied = await startApp();
  try {
    const res = await client(proxied.port).post('/api/register', { username: 'gina', password: PASSWORD }, { 'x-forwarded-proto': 'https' });
    assert.match(res.setCookie, /; Secure/);
  } finally { await proxied.close(); }
});

test('photos: disallowed host is 400; Wikipedia links resolve on the server', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, ua: opts.headers['User-Agent'] });
    if (url.endsWith('/Wat_Arun')) {
      return new Response(JSON.stringify({ thumbnail: { source: 'https://thumb.wikimedia.org/thumb/Wat_Arun.jpg?utm_source=en.wikipedia.org' } }), { status: 200 });
    }
    if (url.endsWith('/Evil')) {
      return new Response(JSON.stringify({ thumbnail: { source: 'https://tracker.example/x.jpg' } }), { status: 200 });
    }
    return new Response('{}', { status: 503 });
  };
  const app = await startApp({ fetch: fakeFetch });
  try {
    await app.server.locals.images.idle(); // startup pass over the seed (all 503 here)
    const seedCalls = calls.length;
    assert.ok(seedCalls >= 15, 'seed titles were looked up');
    assert.match(calls[0].ua, /BangkokTripPlanner/);

    const c = await member(app.port, 'hana');
    let res = await c.post('/api/itineraries', { title: 'Track me', image: 'https://tracker.example/p.gif?trip=bkk' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Photo must be a Wikipedia page link or an upload.wikimedia.org image');

    res = await c.post('/api/itineraries', { title: 'Temple', image: 'https://en.m.wikipedia.org/wiki/Wat_Arun' });
    assert.equal(res.status, 201);
    const temple = res.json.id;
    res = await c.post('/api/itineraries', { title: 'Bad thumb', image: 'https://en.wikipedia.org/wiki/Evil' });
    const evil = res.json.id;
    res = await c.post('/api/itineraries', { title: 'Direct', image: 'https://upload.wikimedia.org/a/b.jpg' });
    const direct = res.json.id;
    await app.server.locals.images.idle();

    const items = (await c.get('/api/state')).json.itineraries;
    const by = (id) => items.find((i) => i.id === id);
    assert.equal(by(temple).image, 'wiki:Wat_Arun');
    assert.equal(by(temple).image_url, 'https://upload.wikimedia.org/thumb/Wat_Arun.jpg');
    assert.equal(by(temple).image_link, 'https://en.wikipedia.org/wiki/Wat_Arun');
    assert.equal(by(evil).image_url, null, 'non-wikimedia thumbnail ignored');
    assert.equal(by(direct).image_url, 'https://upload.wikimedia.org/a/b.jpg');
    assert.equal(by(direct).image_link, null);
    assert.equal(by(1).image_url, null, 'failed lookups stay null for a retry');
    assert.equal(by(1).image_link, 'https://en.wikipedia.org/wiki/Grand_Palace');
    assert.equal(calls.length, seedCalls + 2);
  } finally { await app.close(); }
});

test('TRIP_OFFLINE=1 disables lookups', async () => {
  let called = 0;
  const app = await startApp({ env: { TRIP_OFFLINE: '1' }, fetch: async () => { called++; } });
  try {
    await app.server.locals.images.idle();
    assert.equal(called, 0);
    assert.equal(app.server.locals.images.enabled, false);
  } finally { await app.close(); }
});

test('security headers on API and static responses; static safety', async () => {
  const app = await startApp();
  try {
    const c = client(app.port);
    const check = (res, label) => {
      assert.equal(res.headers['x-content-type-options'], 'nosniff', label);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', label);
      assert.match(res.headers['content-security-policy'], /default-src 'self'; script-src 'self'/, label);
    };
    let res = await c.get('/api/me');
    check(res, 'api');
    assert.equal(res.headers['cache-control'], 'no-store');
    check(await c.get('/api/nope'), 'api 404');
    check(await c.post('/api/login', 'x', { 'content-type': 'text/plain' }), 'api 415');
    res = await c.get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    check(res, 'static');
    res = await c.get('/does-not-exist.js');
    assert.equal(res.status, 404);
    check(res, 'static 404');
    for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/..%5cserver.js', '/%2e%2e%5cpackage.json']) {
      assert.equal((await c.get(p)).status, 404, p);
    }
    assert.equal((await c.post('/', {})).status, 405);
  } finally { await app.close(); }
});

test('static MIME types for app.js and styles.css', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const app = await startApp();
  try {
    const c = client(app.port);
    for (const [file, type] of [['app.js', /^text\/javascript/], ['styles.css', /^text\/css/]]) {
      if (!fs.existsSync(path.join(__dirname, '..', 'public', file))) { t.diagnostic(`${file} not present yet`); continue; }
      const res = await c.get(`/${file}`);
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], type);
    }
  } finally { await app.close(); }
});
