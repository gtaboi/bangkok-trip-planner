# Bangkok Trip Planner

A small web app for a group of up to 10 people to vote on Bangkok itineraries and choose who is in charge of each one.

## Run

Requires Node.js 22.5+. The app has no runtime dependencies, because it uses the built-in `node:sqlite`.

```bash
npm start
```

Open http://localhost:3000. Each person registers with a name and password, and the app stops accepting new members at 10.

### Settings (environment variables)
| Variable | Default | What it does |
|---|---|---|
| `TRIP_CODE` | unset | Invite code that new members must enter to register. **Set this before sharing the link.** Without it, anyone who can reach the app can join, and the server prints a warning. |
| `HOST` | `127.0.0.1` | Only this computer can open the app. Set `0.0.0.0` to let other devices on your network in. |
| `PORT` | `3000` | |
| `TRIP_DB` | `./trip.db` | Where the database file is kept. |
| `COOKIE_SECURE` | unset | Set to `1` when the app is served over HTTPS. The flag is also added automatically behind a proxy that sends `X-Forwarded-Proto: https`. |
| `TRIP_OFFLINE` | unset | Set to `1` to skip looking up Wikipedia photos. |

For example, to share the app on your Wi-Fi with an invite code (PowerShell):

```powershell
$env:TRIP_CODE = "pick-a-code"; $env:HOST = "0.0.0.0"; npm start
```

Other devices then open `http://<your-PC-IP>:3000`. Plain HTTP isn't encrypted, so only do this on a network you trust, such as your home Wi-Fi rather than a hotel or café. To use the app over the internet, deploy it to a host such as Render or Railway with a persistent disk for `trip.db`, serve it over HTTPS, and set `COOKIE_SECURE=1`.

## Features
- **Login:** name and password (at least 8 characters), plus the invite code when `TRIP_CODE` is set.
  - Passwords are hashed with scrypt.
  - Sessions expire after 30 days. "Log out of all devices" ends every session.
  - Repeated failed logins are blocked for 15 minutes.
- **Poll:** each person gets 3 votes. Click again to take a vote back. The list keeps its order while people vote; "Re-sort by votes" updates it.
- **Top 5:** the five itineraries with the most votes so far, with tied itineraries sharing a rank.
- **Leads:** each person can be in charge of one itinerary, and sets its day/time and plan notes in the plan editor.
- **Final plan:** shows the top 10 itineraries and who leads each one.
- **Propose:** anyone can add an idea, with an optional Wikipedia page link for its photo. The proposer can delete it until someone else votes for it or takes charge of it.
- **Photos:** the server looks them up once from Wikipedia and stores the image address, and browsers load the images from Wikimedia.

Settings for the trip itself (`MAX_MEMBERS`, `MAX_VOTES`, `MIN_PASSWORD`) live at the top of `server.js`. To start over, stop the server and delete `trip.db`.

## Development
```bash
npm install
```
This installs ESLint, the only dev dependency.

```bash
npm test
```
Runs the `node:test` suite. It uses in-memory databases and never touches the network.

```bash
npm run lint
```
Runs ESLint on the server and the browser code.

```bash
npm run check
```
Runs lint, then the tests.
