# Bangkok Trip Planner

A small web app for a group of up to 10 people to vote on Bangkok itineraries and choose who is in charge of each one.

## Run

Requires Node.js 22.5+ (it uses the built-in `node:sqlite`, so there's nothing to `npm install`).

```bash
npm start
```

Open http://localhost:3000. Each person registers with a name and password, and the app stops accepting new members at 10.

## Features
- **Login**: name and password. Passwords are hashed with scrypt, and sessions are kept in an HttpOnly cookie.
- **Database**: SQLite in `trip.db`, created on the first run with 18 Bangkok itinerary ideas.
- **Poll**: each person gets 3 votes. Click again to take a vote back.
- **Leads**: each person can be in charge of one itinerary. The lead sets its day/time and plan notes.
- **Final plan**: shows the top 10 itineraries by votes and who leads each one.
- **Propose**: anyone can add their own idea to the poll.

Settings live at the top of `server.js` (`MAX_MEMBERS`, `MAX_VOTES`, `PORT`). To start over, delete `trip.db`.

To let others use the app from other devices on the same Wi-Fi, they can open `http://<your-PC-IP>:3000`. To use it over the internet, deploy it to a host such as Render or Railway with a persistent disk for `trip.db`, and put it behind HTTPS.
