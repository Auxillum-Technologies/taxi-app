# Orchestrator checkpoint: v0.4 sign-in for owners and drivers

Design Read (from the user's answers, 2026-10-26): one sign-in screen for a Davao taxi fleet. The owner signs in with the owner password and gets the map, dashboard and desk. A driver signs in with the name the owner registered plus a 4-6 digit PIN, and sees only their profile, their taxi's details and the location-sharing switch. Existing green-and-white language, subtle motion, Vite + React, plain-HTML driver page. No in-product AI agent (Agent 14: not required).

Execution: roles run one after another in this session (no subagents); the code is already loaded and the units share contracts.

## Work units

| # | Unit | Owner files | Contract |
|---|---|---|---|
| 1 | Accounts | `server/desk.js`, `server/desk.test.js` | Driver = name (unique, case/space-insensitive) + PIN (4-6 digits, scrypt) + taxi ID + taxi details (plate, make/model, body no., franchise no. + expiry). Login by name + PIN. Lockout per name after 5 wrong PINs for 15 min, plus the existing per-address throttle. `updateDriver` for details and PIN resets. |
| 2 | API gate | `server/index.js` | Map data needs the owner: `/api/config`, `/api/fleet`, `/api/snapshot`, `/api/stats` and the live socket (auth as the first socket message, never in the URL). `GET /api/owner/me`, `PATCH /api/owner/drivers/:id`. `GET /api/driver/me` adds the taxi's live status and today's numbers. |
| 3 | Sign-in screen | `src/main.jsx`, `src/SignIn.jsx`, `src/styles.css` | Owner / Driver choice. Owner sign-in lazy-loads the console (the map bundle loads only after sign-in). Driver sign-in goes to `/driver.html`. |
| 4 | Owner desk | `src/OwnerDesk.jsx`, `src/App.jsx`, `src/useLiveFleet.js` | Uses the gate's token; sign out from the top bar. Driver form: name, PIN, taxi ID, taxi details; edit and PIN reset. Messaging UI removed (drivers no longer see messages). |
| 5 | Driver page | `public/driver.html` | Profile, taxi details (franchise expiry warning), live taxi status, location sharing. Reports and inbox removed. Signed out -> `/?as=driver`. |
| 6 | Gates | `UX_LAWS_AUDIT.md`, `README.md` | Tests, build, browser checks at 1440 and 390, console clean, slop/bug/a11y passes. llms.txt stays exempt-by-brief. |

## Decisions

- Name + PIN was the user's choice over name + password. A 4-digit PIN has 10,000 values, so tries are limited per name (5 per 15 min) as well as per address; the UI tells the owner to prefer 6 digits.
- Driver names must be unique, because the name is the sign-in.
- Reports and messages stay in the server and the owner's reports list for history; drivers can no longer send or read them.

## Status

- [x] 1 [x] 2 [x] 3 [x] 4 [x] 5 [x] 6 (Lighthouse and real-phone checks not run; see UX_LAWS_AUDIT.md v0.4)

---

# Orchestrator checkpoint: v0.3 refinement + traffic dashboard

Design Read (confirmed 2026-10-26): a refined, real-time fleet operations console for a Davao taxi owner. It has a Map / Dashboard tab switch. The dashboard shows fleet activity, road congestion worked out from the fleet's own GPS speeds, and the driver reports feed. It uses the green-and-white language, subtle motion, and Vite + React + MapLibre/three.js. No in-product AI agent (Agent 14: not required).

Execution: roles run one after another in one session (no subagents), because the codebase context is already loaded. Each work unit has one owner file set.

## Work units

| # | Unit | Owner files | Contract |
|---|---|---|---|
| 1 | Production map fix | `src/App.jsx` (map init) | Pass the worker URL explicitly via `setWorkerUrl` + Vite `?url`. Map renders in `npm start`. |
| 2 | Fleet stats | `server/store.js`, `server/stats.js`, `server/simulator.js` | Trip starts, per-taxi distance/idle/trips, congestion grid from the last 5 min of samples, 30-min time series sampled every 15 s. Unit tested. |
| 3 | Live push | `server/index.js`, `src/useLiveFleet.js`, `public/driver.html`, `src/OwnerDesk.jsx` | Snapshot carries `deskVersion`; `stats` message every 5 s; `/ws?feed=desk` sends only desk-change notices (for phones). Polling kept as a 60 s fallback. |
| 4 | Dashboard | `src/Dashboard.jsx`, `src/charts.jsx` | KPI row, fleet status area chart, average speed line, slow-zone list, reports feed, per-taxi table (sortable, click to locate). Hand-made SVG, no chart library. |
| 5 | Map polish | `src/App.jsx`, `src/fleetLayer.js` | Tabs + hash route, traffic layer toggle, larger taxis at city zoom, no forced repaint loop. |
| 6 | Visual + phone | `src/styles.css` | Type scale, icons, tabs, dashboard grid, phone layout at 390 px. |
| 7 | Gates | `UX_LAWS_AUDIT.md`, `README.md` | Tests, build, browser checks at 1440 and 390, prod map check, console clean. |

## Decisions

- Traffic means the fleet's own data. No third-party traffic service (would need a paid key).
- Congestion cell: about 550 m (0.005°). A cell counts only with 2+ taxis that are not parked; level from median speed: under 10 km/h = jam, under 20 = slow, else flowing.
- Trip counts and history only cover time since the server started (in memory). The UI says so.
- llms.txt (Phase 6): exempt-by-brief. This is a private operations console; publishing an AI-discovery file would advertise an internal tool.

## Status

- [x] 1 [x] 2 [x] 3 [x] 4 [x] 5 [x] 6 [x] 7 (bundle budget not met; see UX_LAWS_AUDIT.md)
