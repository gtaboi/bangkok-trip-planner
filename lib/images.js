'use strict';
// #7: resolve wiki:<Title> photos once on the server, so browsers never call Wikipedia.
const { setTimeout: sleep } = require('node:timers/promises');
const { wikiTitle, wikiSummaryUrl, toUploadUrl } = require('./rules');

const USER_AGENT = 'BangkokTripPlanner/1.1 (private group-trip app; https://github.com/gtaboi/bangkok-trip-planner)';

/** Thumbnail address for a page title, or null if the page has none. Throws on network/HTTP errors. */
async function fetchWikiThumbnail(title, { fetch, timeoutMs = 8000 }) {
  const res = await fetch(wikiSummaryUrl(title), {
    headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wikipedia summary for ${title}: HTTP ${res.status}`);
  const data = await res.json();
  const src = data && data.thumbnail && data.thumbnail.source;
  return toUploadUrl(src);
}

/**
 * Background queue: one lookup at a time with a short pause between them.
 * With `fetch` null (offline/tests) every call is a no-op. Rows that fail keep
 * image_url NULL and are retried by resolvePending() on the next startup.
 */
function createImageResolver({ store, fetch, delayMs = 500, log = console }) {
  let chain = Promise.resolve();
  const queued = new Set();

  async function resolveOne(id) {
    const row = store.getItinerary(id);
    const title = row && !row.image_url ? wikiTitle(row.image) : null;
    if (!title) return;
    const url = await fetchWikiThumbnail(title, { fetch });
    if (url) store.setImageUrl(id, url, row.image);
    else log.warn(`[images] No thumbnail for wiki:${title}`);
  }

  function enqueue(id) {
    if (!fetch || queued.has(id)) return chain;
    queued.add(id);
    chain = chain.then(async () => {
      try { await resolveOne(id); } catch (e) { log.warn(`[images] Lookup failed for itinerary ${id}: ${e.message}`); }
      finally { queued.delete(id); }
      if (delayMs) await sleep(delayMs, undefined, { ref: false });
    });
    return chain;
  }

  function resolvePending() {
    for (const row of store.pendingWikiImages()) enqueue(row.id);
    return chain;
  }

  return { enqueue, resolvePending, idle: () => chain, enabled: !!fetch };
}

module.exports = { createImageResolver, fetchWikiThumbnail, USER_AGENT };
