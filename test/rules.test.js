'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../lib/rules');

test('clean trims, truncates and ignores non-strings', () => {
  assert.equal(r.clean('  hi  '), 'hi');
  assert.equal(r.clean('abcdef', 3), 'abc');
  assert.equal(r.clean(42), '42');
  assert.equal(r.clean(null), '');
  assert.equal(r.clean({ a: 1 }), '');
  assert.equal(r.clean(['x']), '');
});

test('validateRegistration', async (t) => {
  const v = (username, password) => r.validateRegistration({ username, password, minPassword: 8 });
  await t.test('accepts a good name and trims it', () => {
    assert.deepEqual(v('  Alice B.  ', 'longenough'), { ok: true, username: 'Alice B.' });
  });
  await t.test('rejects bad names', () => {
    for (const name of ['a', '', 'x'.repeat(31), 'bob,carol', 'semi;colon', 'émile', null, 7]) {
      assert.equal(v(name, 'longenough').status, 400, String(name));
    }
  });
  await t.test('rejects short, long and non-string passwords', () => {
    assert.match(v('alice', '1234567').error, /at least 8/);
    assert.equal(v('alice', '12345678').ok, true);
    assert.equal(v('alice', 'x'.repeat(201)).status, 400);
    assert.equal(v('alice', 12345678).status, 400);
    assert.equal(v('alice', undefined).status, 400);
  });
});

test('decideJoin', () => {
  assert.equal(r.decideJoin({ memberCount: 9, maxMembers: 10, nameTaken: false }).ok, true);
  assert.equal(r.decideJoin({ memberCount: 10, maxMembers: 10, nameTaken: false }).status, 403);
  assert.equal(r.decideJoin({ memberCount: 3, maxMembers: 10, nameTaken: true }).status, 409);
});

test('decideVote', () => {
  assert.deepEqual(r.decideVote({ hasVote: true, used: 3, max: 3 }), { ok: true, action: 'remove' });
  assert.deepEqual(r.decideVote({ hasVote: false, used: 2, max: 3 }), { ok: true, action: 'add' });
  const full = r.decideVote({ hasVote: false, used: 3, max: 3 });
  assert.equal(full.status, 400);
  assert.match(full.error, /all 3 votes/);
});

test('decideClaim', () => {
  const free = { id: 1, lead_id: null };
  assert.equal(r.decideClaim({ itinerary: free, userId: 5, currentLead: null }).ok, true);
  assert.equal(r.decideClaim({ itinerary: { id: 1, lead_id: 5 }, userId: 5, currentLead: null }).status, 409);
  assert.match(r.decideClaim({ itinerary: { id: 1, lead_id: 6 }, userId: 5, currentLead: null }).error, /already leads/);
  const other = r.decideClaim({ itinerary: free, userId: 5, currentLead: { id: 2, title: 'Spa' } });
  assert.equal(other.status, 409);
  assert.match(other.error, /"Spa"/);
});

test('decideRelease and decideDetails need the lead', () => {
  for (const fn of [r.decideRelease, r.decideDetails]) {
    assert.equal(fn({ itinerary: { lead_id: 5 }, userId: 5 }).ok, true);
    assert.equal(fn({ itinerary: { lead_id: 6 }, userId: 5 }).status, 403);
    assert.equal(fn({ itinerary: { lead_id: null }, userId: 5 }).status, 403);
  }
});

test('decideDelete', async (t) => {
  const it = (o) => ({ id: 1, created_by: 5, lead_id: null, ...o });
  const d = (o, otherVotes = 0, userId = 5) => r.decideDelete({ itinerary: it(o), userId, otherVotes });
  await t.test('proposer, no other votes, no lead: allowed', () => assert.equal(d({}).ok, true));
  await t.test('proposer leading it themselves: allowed', () => assert.equal(d({ lead_id: 5 }).ok, true));
  await t.test('not the proposer: 403', () => {
    assert.equal(d({}, 0, 6).status, 403);
    assert.equal(d({ created_by: null }, 0, 5).status, 403);
  });
  await t.test('other votes: 409 with count', () => {
    assert.deepEqual(d({}, 1), { status: 409, error: "Can't delete: 1 other vote is attached" });
    assert.deepEqual(d({}, 2), { status: 409, error: "Can't delete: 2 other votes are attached" });
  });
  await t.test('someone else leads: 409', () => {
    assert.deepEqual(d({ lead_id: 6 }), { status: 409, error: "Can't delete: a lead is attached" });
    assert.deepEqual(d({ lead_id: 6 }, 1), { status: 409, error: "Can't delete: 1 other vote and a lead are attached" });
  });
  await t.test('canDelete mirrors decideDelete', () => {
    assert.equal(r.canDelete(it({}), 5, 0), true);
    assert.equal(r.canDelete(it({}), 5, 1), false);
    assert.equal(r.canDelete(it({}), 6, 0), false);
    assert.equal(r.canDelete(it({ lead_id: 7 }), 5, 0), false);
  });
});

test('normalizeImage', async (t) => {
  const n = r.normalizeImage;
  await t.test('empty means no photo', () => {
    for (const v of [undefined, null, '', '   ']) assert.deepEqual(n(v), { ok: true, image: null, imageUrl: null });
  });
  await t.test('Wikipedia page links become wiki:<Title>', () => {
    assert.equal(n('https://en.wikipedia.org/wiki/Wat_Arun').image, 'wiki:Wat_Arun');
    assert.equal(n('https://en.m.wikipedia.org/wiki/Wat_Arun#History').image, 'wiki:Wat_Arun');
    assert.equal(n('https://th.m.wikipedia.org/wiki/Wat_Arun').image, 'wiki:Wat_Arun');
    assert.equal(n('https://EN.wikipedia.org/wiki/Wat%20Mahathat_(Ayutthaya)').image, 'wiki:Wat_Mahathat_(Ayutthaya)');
    assert.equal(n('https://en.wikipedia.org/wiki/Wat_Arun').imageUrl, null);
  });
  await t.test('upload.wikimedia.org images are kept (query dropped)', () => {
    const url = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Wat_Arun.jpg';
    assert.deepEqual(n(url), { ok: true, image: url, imageUrl: url });
    assert.equal(n(`${url}?track=1`).image, url);
  });
  await t.test('everything else is rejected', () => {
    for (const v of [
      'https://tracker.example/p.gif?trip=bkk',
      'http://upload.wikimedia.org/x.jpg',
      'https://upload.wikimedia.org.evil.example/x.jpg',
      'https://evil.example/upload.wikimedia.org/x.jpg',
      'https://user:pw@upload.wikimedia.org/x.jpg',
      'https://upload.wikimedia.org:8443/x.jpg',
      'https://upload.wikimedia.org/',
      'https://en.wikipedia.org/w/index.php?title=Wat_Arun',
      'https://en.wikipedia.org/wiki/',
      'https://en.wikipedia.org/wiki/%E0%A4%A',
      'https://en.wikipedia.org/wiki/A%3Cscript%3E',
      'https://wikipedia.org.evil.example/wiki/X',
      'javascript:alert(1)',
      'wiki:Wat_Arun',
      'not a url',
      `https://upload.wikimedia.org/${'x'.repeat(2000)}`,
      42,
      {},
    ]) {
      const res = n(v);
      assert.equal(res.status, 400, String(v));
      assert.equal(res.error, r.PHOTO_ERROR);
    }
  });
  await t.test('thumb.wikimedia.org is rewritten to upload.wikimedia.org', () => {
    const r2 = n('https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c7/X.jpg/330px-X.jpg?utm_source=en.wikipedia.org');
    assert.deepEqual(r2, { ok: true, image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c7/X.jpg/330px-X.jpg',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c7/X.jpg/330px-X.jpg' });
  });
  await t.test('toUploadUrl', () => {
    assert.equal(r.toUploadUrl('https://upload.wikimedia.org/a.jpg'), 'https://upload.wikimedia.org/a.jpg');
    assert.equal(r.toUploadUrl('https://thumb.wikimedia.org/a.jpg?utm_source=x'), 'https://upload.wikimedia.org/a.jpg');
    assert.equal(r.toUploadUrl('https://en.wikipedia.org/wiki/A'), null);
    assert.equal(r.toUploadUrl('https://tracker.example/a.jpg'), null);
    assert.equal(r.toUploadUrl(undefined), null);
  });
});

test('wiki helpers', () => {
  assert.equal(r.wikiTitle('wiki:Wat_Arun'), 'Wat_Arun');
  assert.equal(r.wikiTitle('wiki:'), null);
  assert.equal(r.wikiTitle('https://upload.wikimedia.org/a.jpg'), null);
  assert.equal(r.wikiTitle(null), null);
  assert.equal(r.imageLink('wiki:Wat_Mahathat_(Ayutthaya)'), 'https://en.wikipedia.org/wiki/Wat_Mahathat_(Ayutthaya)');
  assert.equal(r.imageLink('wiki:AC/DC'), 'https://en.wikipedia.org/wiki/AC/DC');
  assert.equal(r.imageLink('https://upload.wikimedia.org/a.jpg'), null);
  assert.equal(r.imageLink(null), null);
  assert.equal(r.wikiSummaryUrl('AC/DC'), 'https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC');
});
