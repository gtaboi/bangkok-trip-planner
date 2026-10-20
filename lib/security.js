'use strict';
// HTTP hardening: headers, CSRF checks, body parsing, rate limiting, session tokens.
const crypto = require('node:crypto');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https://upload.wikimedia.org data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'DENY',
});

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const firstValue = (h) => String(h || '').split(',')[0].trim().toLowerCase();

/** 403 when an Origin header is present and its host isn't this server's Host. */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { host = null; }
  const allowed = [firstValue(req.headers.host), firstValue(req.headers['x-forwarded-host'])].filter(Boolean);
  if (host && allowed.includes(host)) return null;
  return { status: 403, error: 'Cross-origin request blocked' };
}

/** 415 unless the request says it carries JSON. */
function checkContentType(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') return null;
  return { status: 415, error: 'Content-Type must be application/json' };
}

/** Read a JSON object body. Always settles: rejects with HttpError 413/400. Empty body -> {}. */
function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, 'Request body too large', { Connection: 'close' });
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      return reject(tooLarge());
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      req.off('data', onData).off('end', onEnd).off('error', onError).off('close', onClose);
      fn(value);
    };
    function onData(chunk) {
      size += chunk.length;
      if (size > limit) {
        finish(reject, tooLarge());
        req.resume(); // discard the rest
      } else {
        chunks.push(chunk);
      }
    }
    function onEnd() {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return finish(resolve, {});
      let value;
      try { value = JSON.parse(text); } catch { return finish(reject, new HttpError(400, 'Invalid JSON')); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return finish(reject, new HttpError(400, 'Body must be a JSON object'));
      }
      finish(resolve, value);
    }
    function onError() { finish(reject, new HttpError(400, 'Could not read request body')); }
    function onClose() { finish(reject, new HttpError(400, 'Request aborted')); }
    req.on('data', onData).on('end', onEnd).on('error', onError).on('close', onClose);
  });
}

/** Fixed-window failure counter, in memory. */
function createRateLimiter({ max = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  const entry = (key) => {
    const e = hits.get(key);
    if (e && now() - e.start >= windowMs) { hits.delete(key); return null; }
    return e || null;
  };
  return {
    /** ms until `key` may try again, or 0 if it isn't blocked. */
    retryAfter(key) {
      const e = entry(key);
      return e && e.count >= max ? Math.max(1, e.start + windowMs - now()) : 0;
    },
    fail(key) {
      let e = entry(key);
      if (!e) { e = { start: now(), count: 0 }; hits.set(key, e); }
      e.count++;
    },
    reset(key) { hits.delete(key); },
    prune() { for (const key of [...hits.keys()]) entry(key); },
    get size() { return hits.size; },
  };
}

/** The raw session token from the `sid` cookie, or null. */
function readSid(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const hashToken = (token) => sha256(token).toString('hex');

/** Constant-time string comparison (hash first so lengths always match). */
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

module.exports = {
  CSP,
  SECURITY_HEADERS,
  HttpError,
  checkOrigin,
  checkContentType,
  readBody,
  createRateLimiter,
  readSid,
  hashToken,
  safeEqual,
};
