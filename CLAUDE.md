# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web app for a group trip to Bangkok. Up to 10 travellers register, vote on itineraries, and each person can take charge of one itinerary. It has no runtime dependencies: the server uses only Node built-ins (`http`, `crypto`, `node:sqlite`), so it needs **Node 22.5+**. ESLint is the only dev dependency.

## Commands

- **Run:** `npm start`. It serves http://localhost:3000 on `127.0.0.1`. The environment variables `PORT`, `HOST`, `TRIP_DB`, `TRIP_CODE`, `COOKIE_SECURE` and `TRIP_OFFLINE` are documented in the README. `.claude/launch.json` defines the preview server `trip`, which uses port 3000 and the **live** `trip.db`.
- **Test:** `npm test`, which runs `node --test`. On Node 24, `node --test test/` fails ("Cannot find module"). To run one file, use `node --test test/rules.test.js`. To run one test, use `node --test --test-name-pattern="delete" test/api.test.js`.
- **Lint:** `npm run lint` runs ESLint 10 with a flat config (`eslint.config.js`). `npm run check` runs lint, then the tests.
- **Reset data:** delete `trip.db` while the server is stopped. On Windows the file is locked while the server runs. The next start recreates the database and seeds it.

## Live data: be careful

`trip.db` holds the group's real registrations and votes, and it is gitignored. Registering a test account takes one of the 10 member slots, and its votes show up in the real poll.
- Before testing, check the `users` table read-only.
- For manual testing, run on another port with a throwaway DB, e.g. `PORT=3930 TRIP_DB=<scratch>/test.db TRIP_OFFLINE=1 node server.js`.
- The automated tests already use in-memory databases.
- Never reset `trip.db` unless the user asks.

## Architecture

**Server**
- **`server.js`:**
  - `createApp({ db, env, fetch })` returns an `http.Server` that isn't listening yet. The tests build apps this way.
  - Only under `require.main === module` does it open `TRIP_DB`, start the photo lookups and call `listen(PORT, HOST)`.
  - Routes are in a `ROUTES` map plus an `ACTIONS` map for `POST /api/itineraries/:id/(vote|claim|release|details|delete)`. Each item action runs inside `store.tx()` (`BEGIN IMMEDIATE`), so a check and the write that follows it are atomic.
  - `MAX_MEMBERS`, `MAX_VOTES` and `MIN_PASSWORD` are at the top. The client reads them from `GET /api/me`, so change them only here.
- **`lib/rules.js`:** pure decision functions (`decideVote`, `decideDelete`, `validateRegistration`, `normalizeImage`, …). They return either a result or `{ status, error }`, and have no I/O. New trip rules go here, with unit tests.
- **`lib/db.js`:** `openDb(path)` handles the schema, **in-place migrations** (`hasColumn` + `ALTER TABLE`, which must keep working on a DB created by older versions), seeding from `lib/seed.js`, and statements prepared once. A new column goes in **both** `SCHEMA` (fresh DBs) and `migrate()` (existing DBs). `test/db.test.js` rebuilds the original `main` schema to check the upgrade path. `PRAGMA foreign_keys = ON` must be set on every connection, including ad-hoc `node -e` scripts. Votes cascade when an itinerary is deleted, which is why `decideDelete` refuses once other people's votes or a lead are attached.
- **`lib/security.js`:**
  - the security headers and CSP, on every response. A new external image or API host must be added to the CSP here, or the browser blocks it. Static files are served only for extensions in the `TYPES` map in `server.js`; anything else returns 404.
  - the check that POSTs use `Content-Type: application/json` (415 otherwise), and that any `Origin` matches `Host` (403 otherwise)
  - `readBody` (413 over 100 KB, 400 for invalid JSON)
  - the in-memory login/invite rate limiter
  - token hashing: sessions store `sha256(token)`, never the raw cookie value
- **`lib/images.js`:** looks up Wikipedia photos on the server. `itineraries.image` holds `wiki:<Title>`, an `upload.wikimedia.org` URL, or null. A background queue fills `image_url`, rewriting `thumb.wikimedia.org` to `upload.wikimedia.org` so the CSP `img-src` stays a single host.
  - When you add a seed itinerary, check that its Wikipedia page has a thumbnail, using `https://en.wikipedia.org/api/rest_v1/page/summary/<Title>`.

**Client (`public/`)**
- `index.html` is markup only. `app.js` is the whole client, in an IIFE. `styles.css` holds the styles.
- The CSP is `script-src 'self'`, so **no inline scripts and no `on*=` attributes**. Buttons carry `data-action` / `data-id`, and one delegated click listener dispatches them through the `ACTIONS` map in `app.js`.
- **The browser never calls Wikipedia.** It renders `image_url` or a category placeholder.
- `refresh()` polls `/api/state` every `POLL_MS`. `render()` keeps the user's on-screen order and filter choices between polls, re-sorting only on user action. It also defers re-rendering while focus is in the list, a select, or the plan `<dialog>`.
- `rankTop(itineraries, n)` gives tied itineraries the same rank, and is shared by the Top 5 banner (`TOP_N`) and the Final plan list (`maxMembers`).
- Pass all user text through `esc()`.

## Repo

GitHub repo `gtaboi/bangkok-trip-planner`, branch `main`. Commits use the repo-local identity `gtaboi <200363234+gtaboi@users.noreply.github.com>`; there's no global git identity on this machine.
