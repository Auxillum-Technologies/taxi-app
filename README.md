# Taxi fleet monitor

A realtime 3D map of a taxi fleet. Positions come from GPS trackers and driver phones over HTTP. A simulated fleet runs alongside for testing.

- 3D taxis on a pitched, tilted map. Status colors: free (mint), on trip (amber), offline (grey). Alerts add a red ring.
- Live list with search and status filters. Click a taxi to fly to it.
- Alerts: speeding (above 90 km/h), stopped on a trip for more than 5 minutes, no signal for more than 60 seconds.
- Trails behind each taxi, and a replay slider to see positions up to 30 minutes ago.
- **Sign-in** (`/`): one screen with an Owner / Driver choice. The map, dashboard and desk open only for the owner; drivers go to their own page.
- **Owner desk** (Desk button): add and edit drivers (name, PIN, taxi ID, plate, make and model, body number, franchise number and expiry), reset a PIN, and handle older driver reports.
- **Driver page** (`/driver.html`): the driver's profile, their taxi's details (with a franchise-expiry warning), its live status, and GPS sharing. Nothing about other taxis.
- Driver reports show as pins on the map until resolved (plus 30 minutes).
- **Dashboard** tab (`#dashboard`): live fleet numbers (online, share on trip, average moving speed, trips in the last hour, slow zones, alerts), 30-minute charts of fleet status and speed, slow zones, the driver reports feed, and a sortable table of every taxi. Every row, zone and report has a button that opens it on the map.
- **Traffic layer** on the map: slow zones worked out from your own taxis' speeds (no outside traffic service). A 550 m area is marked when 2 or more taxis there have a median speed under 20 km/h (slow) or 10 km/h (jam) over the last 5 minutes. Free taxis standing still, and stops longer than 2 minutes, are left out so taxi ranks and parking do not look like traffic.

## Run it

Requires Node 22 or newer (tested on Node 24).

```bash
npm install
npm run dev:server    # API + WebSocket on :8787, with a 10-taxi simulated fleet in Davao City
npm run dev:client    # UI on http://localhost:5173
```

Open http://localhost:5173 and sign in as the owner (default password `owner123`). Drivers sign in at http://localhost:5173/?as=driver.

Production, one process:

```bash
npm run build && npm start   # serves the built UI and the API on :8787
```

Deploy on Railway: `railway.json` sets the build, start command, and health check.
Add a volume mounted at `/data` and set `DATA_FILE=/data/desk.json`, or desk data is lost on each deploy.
Set `OWNER_PASSWORD`, `INGEST_TOKEN`, and `SIM_COUNT` in the Railway dashboard.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | API and WebSocket port |
| `SIM_COUNT` | `10` | Simulated taxis: most downtown, some in Toril and Lanang. `0` turns the simulator off for real data |
| `CENTER_LAT` / `CENTER_LNG` | `7.07` / `125.61` (downtown Davao City) | Center of the simulated area and the map's start view |
| `INGEST_TOKEN` | empty | If set, ingest requires `Authorization: Bearer <token>`. **Set this before exposing the server** |
| `OWNER_PASSWORD` | `owner123` | Password for the owner desk (8+ characters). **Change it before exposing the server**; the default is logged as a warning at startup |
| `DATA_FILE` | `data/desk.json` | Where driver accounts, messages and reports are saved. Git-ignored |
| `API_ORIGIN` | `http://localhost:8787` | Where the Vite dev server proxies `/api` and `/ws` |

Without `INGEST_TOKEN`, the server logs a warning and accepts pings from anyone who can reach the port.

## Sending positions

### HTTP ingest: `POST /api/ingest`

```json
{
  "vehicleId": "TX-042",
  "lat": 7.07,
  "lng": 125.61,
  "speed": 32.5,
  "heading": 270,
  "onTrip": true,
  "ts": 1793000000000,
  "source": "tracker"
}
```

| Field | Required | Rules |
|---|---|---|
| `vehicleId` | yes | 1–64 characters: letters, digits, `.`, `_`, `-` |
| `lat`, `lng` | yes | numbers in [-90, 90] and [-180, 180] |
| `speed` | no | km/h, 0–300 (default 0) |
| `heading` | no | degrees, 0–360 (default 0) |
| `onTrip` | no | boolean (default false) |
| `ts` | no | ms epoch, not more than 60 s in the future or 24 h in the past (default now) |
| `source` | no | `tracker` (default) or `driver-phone` |

Responses: `202` accepted (`stale: true` if an older ping arrived after a newer one), `400` with a message naming the bad field, `401` for a missing or wrong token, `413` for a body over 8 KB.

Pings older than the latest stored one for the same vehicle are ignored, so out-of-order packets cannot move a taxi backwards.

### Real GPS trackers

Trackers speak their own protocol (for example Queclink or TK103 over TCP or UDP). This app does not parse those yet. The two ways in:

1. **Gateway**: a small process decodes the device protocol and forwards each fix as a JSON ping to `/api/ingest`. This keeps the web app simple.
2. **Direct**: add a TCP/UDP listener in `server/` that decodes frames and calls `fleet.ingest(...)`.

Either way, send the tracker model and protocol document before building the decoder. Nothing in the UI depends on the protocol.

### Driver phones and accounts

The owner creates each driver in the **Desk**: full name, a 4-6 digit PIN, the taxi ID, and the taxi's details. The driver signs in at `/?as=driver` with that name (capital letters and extra spaces do not matter) and the PIN, lands on `/driver.html`, and taps **Start sharing**. Names must be unique, because the name is the sign-in. Changing a PIN signs the driver out. The page posts each GPS fix at most once every 3 seconds, and the server files it under that driver's taxi ID, so a phone cannot report for another taxi. Browsers only give location on **https** pages (or localhost), so deploy behind TLS before drivers use it on real phones.

Driver reports and messages are no longer on the driver page. Their endpoints still work, and the desk still lists past reports.

Owner endpoints (`Authorization: Bearer <owner token>` from `POST /api/owner/login`):
`GET /api/owner/me`, `GET|POST /api/owner/drivers` (`{name, pin, taxiId, taxi?: {plate, model, bodyNumber, franchiseNo, franchiseExpiry}}`), `PATCH /api/owner/drivers/:id` (any of those; `pin` resets it), `DELETE /api/owner/drivers/:id`, `GET /api/owner/reports`, `PATCH /api/owner/reports/:id` (`{status}`: open, acknowledged, resolved), `GET|POST /api/owner/messages` (`{to: "all" or driver id, text}`).

Map data needs the owner token too: `GET /api/config`, `/api/fleet`, `/api/snapshot`, `/api/stats`.

Driver endpoints (`Authorization: Bearer <driver token>` from `POST /api/driver/login` with `{name, pin}`):
`GET /api/driver/me` (profile, taxi details, and the taxi's live status), `POST /api/driver/ping`, `GET /api/driver/inbox`, `POST /api/driver/inbox/:id/read`, `POST /api/driver/reports` (`{type, text?, lat?, lng?}`).

Live updates: the map and dashboard use one WebSocket (`/ws`). Its first message must be `{"type": "auth", "token": "<owner token>"}` (the token never goes in the URL); without it the server closes the socket with code 4401. It carries fleet snapshots (up to 4 per second, only when something changed) and dashboard stats every 5 seconds. Each snapshot includes a `deskVersion` number, and the owner desk refetches when it changes. Driver phones connect to `/ws?feed=desk`, which sends only a small "something changed" notice and never fleet data, so it stays light on mobile data. Both pages also poll every 60 seconds in case the socket drops.

Security notes: the owner password and driver PINs are stored as scrypt hashes; sign-in is limited to 10 failed attempts per address per 15 minutes, and a driver name locks for 15 minutes after 5 wrong PINs (a 4-digit PIN has only 10,000 values, so prefer 6 digits); sessions last 12 hours and live in server memory (drivers sign in again after a restart). The owner token is kept in the tab's session storage and driver tokens in the phone's local storage. Public map data includes driver report text and the taxi ID, but never driver names. Run the server behind HTTPS before it is used by drivers or the owner from outside your network.

## Architecture

```
server/index.js      HTTP API, WebSocket (4 Hz when changed), static files
server/store.js      validation, live state, alerts, bounded history (in memory)
server/desk.js       driver accounts (name + PIN, taxi details), sign-in, messages, reports (saved to DATA_FILE)
server/stats.js      dashboard KPIs and the 30-minute series (sampled every 15 s)
src/Dashboard.jsx    dashboard tab; src/charts.jsx: hand-made SVG charts (no chart library)
server/simulator.js  fake taxis that feed the same ingest path
src/App.jsx          map, list, filters, card, replay, parallax HUD
src/fleetLayer.js    three.js taxis, pillars, trails drawn inside the MapLibre WebGL context
src/useLiveFleet.js  WebSocket with reconnect and backoff
public/driver.html   driver page: profile, taxi details, GPS sharing
src/SignIn.jsx       owner / driver sign-in screen
```

Key choices:

- **Positions live in Mercator space** inside MapLibre's custom layer, so taxis stay on their streets while the map tilts and rotates.
- **In-memory state**: no database. Restarting the server clears the fleet, and replay only covers the last 30 minutes since the last restart. Persistence is the next step if you need history beyond that.
- **Stale and malformed input is rejected** at the server. The map trusts nothing from the network.

## Tests

```bash
npm test     # store validation, out-of-order pings, alerts, playback; accounts, sign-in limits, messages, reports, persistence; trips, distance, slow zones, dashboard stats
```

## Known limits

- The app bundle is about 1.9 MB (507 KB gzipped) plus MapLibre's 520 KB worker. MapLibre and three.js dominate it, which misses a 250 KB gzip budget. Code-splitting the map is the next step if load time on mobile data matters.
- The map uses OpenFreeMap vector tiles (no API key). Check its terms before a commercial launch.
- Tested in headless Chrome at 1440×900 and 390×844. Not yet tested on a real phone, on Safari, or under load with hundreds of taxis.
- Accounts and messages are a single JSON file with no backup or migrations. Sessions are in memory only.
- Dashboard history (charts, trips, distance) covers only the time since the server started, because nothing is stored on disk except accounts, messages and reports.
- Taxi markers are small at city zoom. Zoom in to read a taxi's ID; the list is the way to read labels.

## Ideas for next features

From a GitHub search for existing fleet and taxi trackers (ideas only; no code copied, and licenses differ):

- **Geofences and ranks** (agilegps, GPL-3.0): draw zones such as an airport or a taxi rank, and count taxis entering or leaving.
- **Trip dispatch** (Bing Maps Fleet Tracker, MIT, archived; Taxi Dispatch Simulator, MIT): click a pickup point, assign the nearest free taxi.
- **Daily reports** (agilegps): idle time, mileage, and speed summaries per taxi per day.
- **Driver app with background location** (Complete-Taxi-Booking, no license stated): a native wrapper so drivers keep sharing when the screen is off.
- **Offline alerts by email or SMS** for vehicles silent for a set period.
- **Tracker health**: battery and signal fields, plus a "last ping" column in the list.
