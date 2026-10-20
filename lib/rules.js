'use strict';
// Pure trip rules (no I/O). Each decide* function returns either
// { ok: true, ... } or { status, error } for the HTTP layer to send.

const USERNAME_RE = /^[\w .-]{2,30}$/;
const MAX_PASSWORD = 200;
const PHOTO_ERROR = 'Photo must be a Wikipedia page link or an upload.wikimedia.org image';
const UPLOAD_HOST = 'upload.wikimedia.org';
// Wikipedia's API now hands out thumb.wikimedia.org addresses; upload.wikimedia.org
// serves the same paths, so they are rewritten to the one host the CSP allows.
const MEDIA_HOSTS = new Set([UPLOAD_HOST, 'thumb.wikimedia.org']);
const MAX_IMAGE_INPUT = 2000;
const WIKI_HOST_RE = /^[a-z][a-z0-9-]{0,30}\.(?:m\.)?wikipedia\.org$/;
// Control characters are rejected on purpose: they're never valid in a Wikipedia title.
// eslint-disable-next-line no-control-regex
const BAD_TITLE_RE = /[#<>[\]|{}\u0000-\u001f\u007f]/;

const fail = (status, error) => ({ status, error });

/** Trimmed string, or '' for anything that isn't a string/number; cut to `max` characters. */
function clean(v, max = 500) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).trim().slice(0, max);
}

/** Format checks for a new account (cheap, done before hashing). */
function validateRegistration({ username, password, minPassword }) {
  const name = typeof username === 'string' ? username.trim() : '';
  if (!USERNAME_RE.test(name)) return fail(400, 'Name must be 2–30 letters, numbers, spaces, . _ -');
  if (typeof password !== 'string' || password.length < minPassword) {
    return fail(400, `Password must be at least ${minPassword} characters`);
  }
  if (password.length > MAX_PASSWORD) return fail(400, `Password must be at most ${MAX_PASSWORD} characters`);
  return { ok: true, username: name };
}

/** Whether a validated user may take a member slot. */
function decideJoin({ memberCount, maxMembers, nameTaken }) {
  if (memberCount >= maxMembers) return fail(403, `The trip is full (${maxMembers} members)`);
  if (nameTaken) return fail(409, 'That name is taken');
  return { ok: true };
}

/** Vote toggles: remove an existing vote, or add one if the user has votes left. */
function decideVote({ hasVote, used, max }) {
  if (hasVote) return { ok: true, action: 'remove' };
  if (used >= max) return fail(400, `You've used all ${max} votes. Remove one first.`);
  return { ok: true, action: 'add' };
}

/** `currentLead` is the itinerary the user already leads (or null). */
function decideClaim({ itinerary, userId, currentLead }) {
  if (itinerary.lead_id === userId) return fail(409, 'You already lead this one');
  if (itinerary.lead_id != null) return fail(409, 'Someone already leads this one');
  if (currentLead) return fail(409, `You already lead "${currentLead.title}". Release it first.`);
  return { ok: true };
}

function decideRelease({ itinerary, userId }) {
  if (itinerary.lead_id !== userId) return fail(403, 'You are not the lead');
  return { ok: true };
}

function decideDetails({ itinerary, userId }) {
  if (itinerary.lead_id !== userId) return fail(403, 'Only the lead can edit plan details');
  return { ok: true };
}

/**
 * Only the proposer may delete, and only while nobody else depends on it:
 * no votes from other people and no lead other than the proposer.
 */
function decideDelete({ itinerary, userId, otherVotes }) {
  if (itinerary.created_by == null || itinerary.created_by !== userId) {
    return fail(403, 'Only whoever proposed it can delete it');
  }
  const parts = [];
  if (otherVotes > 0) parts.push(`${otherVotes} other vote${otherVotes === 1 ? '' : 's'}`);
  if (itinerary.lead_id != null && itinerary.lead_id !== userId) parts.push('a lead');
  if (parts.length) {
    const verb = parts.length > 1 || otherVotes > 1 ? 'are' : 'is';
    return fail(409, `Can't delete: ${parts.join(' and ')} ${verb} attached`);
  }
  return { ok: true };
}

const canDelete = (itinerary, userId, otherVotes) =>
  !decideDelete({ itinerary, userId, otherVotes }).error;

/**
 * Photo input -> stored form.
 *  ''                                         -> { image: null, imageUrl: null }
 *  https://<lang>[.m].wikipedia.org/wiki/T    -> { image: 'wiki:T', imageUrl: null } (resolved later)
 *  https://upload.wikimedia.org/...           -> { image: url, imageUrl: url } (query/fragment dropped;
 *                                                thumb.wikimedia.org is rewritten to upload.wikimedia.org)
 *  anything else                              -> 400
 */
function normalizeImage(input) {
  if (input == null) return { ok: true, image: null, imageUrl: null };
  if (typeof input !== 'string') return fail(400, PHOTO_ERROR);
  const raw = input.trim();
  if (!raw) return { ok: true, image: null, imageUrl: null };
  if (raw.length > MAX_IMAGE_INPUT) return fail(400, PHOTO_ERROR);
  let u;
  try { u = new URL(raw); } catch { return fail(400, PHOTO_ERROR); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return fail(400, PHOTO_ERROR);
  const host = u.hostname.toLowerCase();

  if (MEDIA_HOSTS.has(host)) {
    if (u.pathname.length < 2) return fail(400, PHOTO_ERROR);
    const url = `https://${UPLOAD_HOST}${u.pathname}`;
    return { ok: true, image: url, imageUrl: url };
  }
  if (WIKI_HOST_RE.test(host) && u.pathname.startsWith('/wiki/')) {
    let title;
    try { title = decodeURIComponent(u.pathname.slice(6)); } catch { return fail(400, PHOTO_ERROR); }
    title = title.trim().replace(/ /g, '_');
    if (!title || title.length > 255 || BAD_TITLE_RE.test(title)) return fail(400, PHOTO_ERROR);
    return { ok: true, image: `wiki:${title}`, imageUrl: null };
  }
  return fail(400, PHOTO_ERROR);
}

/** Vet an image address from the Wikipedia API: an upload.wikimedia.org URL, or null. */
function toUploadUrl(src) {
  if (typeof src !== 'string') return null;
  const r = normalizeImage(src);
  return r.error ? null : r.imageUrl;
}

const wikiTitle = (image) =>
  typeof image === 'string' && image.startsWith('wiki:') && image.length > 5 ? image.slice(5) : null;

const encodeTitle = (t) => encodeURIComponent(t).replace(/%2F/g, '/').replace(/%3A/g, ':');

/** Page to open when the photo is clicked. */
function imageLink(image) {
  const t = wikiTitle(image);
  return t ? `https://en.wikipedia.org/wiki/${encodeTitle(t)}` : null;
}

const wikiSummaryUrl = (title) =>
  `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

module.exports = {
  PHOTO_ERROR,
  clean,
  validateRegistration,
  decideJoin,
  decideVote,
  decideClaim,
  decideRelease,
  decideDetails,
  decideDelete,
  canDelete,
  normalizeImage,
  toUploadUrl,
  wikiTitle,
  imageLink,
  wikiSummaryUrl,
};
