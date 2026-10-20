'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const s = require('../lib/security');

const fakeReq = (headers = {}) => Object.assign(new PassThrough(), { headers });

test('checkOrigin', () => {
  const host = { host: 'localhost:3000' };
  assert.equal(s.checkOrigin({ headers: host }), null);
  assert.equal(s.checkOrigin({ headers: { ...host, origin: 'http://localhost:3000' } }), null);
  assert.equal(s.checkOrigin({ headers: { ...host, origin: 'http://LOCALHOST:3000' } }), null);
  assert.equal(s.checkOrigin({ headers: { host: 'x', 'x-forwarded-host': 'trip.example', origin: 'https://trip.example' } }), null);
  for (const origin of ['https://evil.example', 'http://localhost:8080', 'null', 'garbage']) {
    assert.equal(s.checkOrigin({ headers: { ...host, origin } }).status, 403, origin);
  }
});

test('checkContentType', () => {
  assert.equal(s.checkContentType({ headers: { 'content-type': 'application/json' } }), null);
  assert.equal(s.checkContentType({ headers: { 'content-type': 'Application/JSON; charset=utf-8' } }), null);
  for (const ct of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp']) {
    assert.equal(s.checkContentType({ headers: { 'content-type': ct } }).status, 415, String(ct));
  }
});

test('readBody', async (t) => {
  const body = (text, headers, limit) => {
    const req = fakeReq(headers);
    const p = s.readBody(req, limit);
    if (text !== null) req.end(text);
    return { p, req };
  };
  await t.test('parses an object', async () => assert.deepEqual(await body('{"a":1}').p, { a: 1 }));
  await t.test('empty body is {}', async () => assert.deepEqual(await body('').p, {}));
  await t.test('bad JSON is 400', async () => {
    await assert.rejects(body('{"a":').p, { status: 400, message: 'Invalid JSON' });
  });
  await t.test('non-object JSON is 400', async () => {
    for (const t2 of ['[1]', '"x"', 'null', '3']) await assert.rejects(body(t2).p, { status: 400 });
  });
  await t.test('too large is 413 (streamed)', async () => {
    await assert.rejects(body('x'.repeat(50), {}, 10).p, { status: 413 });
  });
  await t.test('too large is 413 (content-length)', async () => {
    await assert.rejects(body(null, { 'content-length': '999' }, 10).p, { status: 413 });
  });
  await t.test('aborted request settles with 400', async () => {
    const { p, req } = body(null);
    req.write('{"a"');
    req.destroy();
    await assert.rejects(p, { status: 400 });
  });
});

test('rate limiter', () => {
  let now = 1000;
  const lim = s.createRateLimiter({ max: 3, windowMs: 60000, now: () => now });
  assert.equal(lim.retryAfter('k'), 0);
  lim.fail('k'); lim.fail('k');
  assert.equal(lim.retryAfter('k'), 0);
  lim.fail('k');
  assert.equal(lim.retryAfter('k'), 60000);
  assert.equal(lim.retryAfter('other'), 0);
  now += 30000;
  assert.equal(lim.retryAfter('k'), 30000);
  now += 30000;
  assert.equal(lim.retryAfter('k'), 0, 'window expired');
  lim.fail('k'); lim.fail('k'); lim.fail('k');
  lim.reset('k');
  assert.equal(lim.retryAfter('k'), 0);
  lim.fail('a');
  now += 60000;
  lim.prune();
  assert.equal(lim.size, 0);
});

test('readSid', () => {
  const tok = 'a'.repeat(64);
  assert.equal(s.readSid({ headers: { cookie: `sid=${tok}` } }), tok);
  assert.equal(s.readSid({ headers: { cookie: `x=1; sid=${tok}; y=2` } }), tok);
  assert.equal(s.readSid({ headers: { cookie: 'sid=abc' } }), null);
  assert.equal(s.readSid({ headers: { cookie: `notsid=${tok}` } }), null);
  assert.equal(s.readSid({ headers: {} }), null);
});

test('safeEqual and hashToken', () => {
  assert.equal(s.safeEqual('secret', 'secret'), true);
  assert.equal(s.safeEqual('secret', 'secreT'), false);
  assert.equal(s.safeEqual('short', 'a much longer value'), false);
  assert.match(s.hashToken('x'), /^[0-9a-f]{64}$/);
});

test('security headers', () => {
  assert.equal(s.SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(s.SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  assert.match(s.CSP, /script-src 'self'/);
  assert.match(s.CSP, /img-src 'self' https:\/\/upload\.wikimedia\.org data:/);
  assert.match(s.CSP, /frame-ancestors 'none'/);
});
