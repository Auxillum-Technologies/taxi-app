import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createFleet, LIMITS } from './store.js';
import { createDesk, DESK_LIMITS, publicDriver, REPORT_TYPES } from './desk.js';
import { startSimulator } from './simulator.js';
import { createStats, STATS } from './stats.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const SIM_COUNT = Number(process.env.SIM_COUNT ?? 10); // 0 disables the simulator
// Downtown Davao City (Poblacion, around City Hall and San Pedro Street).
const CENTER = {
  lat: Number(process.env.CENTER_LAT ?? 7.07),
  lng: Number(process.env.CENTER_LNG ?? 125.61),
};
const BROADCAST_MS = 250; // 4 Hz live view, only when something changed
const STATS_PUSH_MS = 5_000; // dashboard numbers
const MAX_BODY = 8 * 1024;
const DATA_FILE = process.env.DATA_FILE || join(ROOT, 'data', 'desk.json');
const DEFAULT_OWNER_PASSWORD = 'owner123';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';

const DEFAULT_DRIVERS = [
  { name: 'alai', pin: '1215', taxiId: 'SIM-001' },
  { name: 'alai01', pin: '1215', taxiId: 'ALAI-01' },
];

const fleet = createFleet();
const desk = createDesk({ file: DATA_FILE });
const ownerPassword = OWNER_PASSWORD || DEFAULT_OWNER_PASSWORD;
await desk.setOwnerPassword(ownerPassword);
for (const d of DEFAULT_DRIVERS) {
  if (!desk.listDrivers().some((x) => x.name.toLowerCase() === d.name.toLowerCase())) {
    await desk.addDriver(d);
  }
}
const sim = SIM_COUNT > 0 ? startSimulator(fleet, { count: SIM_COUNT, center: CENTER }) : null;
const stats = createStats(fleet);
stats.sample();
const sampler = setInterval(() => stats.sample(), STATS.sampleMs);

// Keeps actively-sharing driver phones alive on the map while the phone screen sleeps.
const activePhones = new Map(); // taxiId -> { lat, lng, heading, onTrip, updatedAt }
const phoneKeepAlive = setInterval(() => {
  const now = Date.now();
  for (const [taxiId, state] of activePhones) {
    if (now - state.updatedAt > LIMITS.forgetMs) {
      activePhones.delete(taxiId);
      continue;
    }
    const last = fleet.get(taxiId);
    if (!last || now - last.ts >= 20_000) {
      fleet.ingest(
        { vehicleId: taxiId, lat: state.lat, lng: state.lng, speed: 0, heading: state.heading, onTrip: state.onTrip, ts: now },
        'driver-phone',
        now,
      );
    }
  }
}, 15_000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', // MapLibre's worker; module scripts need a JS type
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error('request failed', err);
    return send(res, 500, { error: 'internal error' });
  }
});

// Each route: method, path pattern, handler. The first match wins.
const ROUTES = [
  ['GET', /^\/api\/health$/, health],
  // Map and dashboard data: owner only. Drivers see their own taxi through /api/driver/me.
  ['GET', /^\/api\/config$/, ownerOnly(config)],
  ['GET', /^\/api\/fleet$/, ownerOnly((req, res) => send(res, 200, liveSnapshot()))],
  ['GET', /^\/api\/snapshot$/, ownerOnly(snapshotAt)],
  ['GET', /^\/api\/stats$/, ownerOnly((req, res) => send(res, 200, liveStats()))],
  ['POST', /^\/api\/ingest$/, ingest],

  ['POST', /^\/api\/owner\/login$/, ownerLogin],
  ['POST', /^\/api\/owner\/logout$/, ownerLogout],
  ['GET', /^\/api\/owner\/me$/, ownerOnly((req, res) => send(res, 200, { ok: true }))],
  ['GET', /^\/api\/owner\/drivers$/, ownerListDrivers],
  ['POST', /^\/api\/owner\/drivers$/, ownerAddDriver],
  ['PATCH', /^\/api\/owner\/drivers\/(?<id>[^/]+)$/, ownerUpdateDriver],
  ['DELETE', /^\/api\/owner\/drivers\/(?<id>[^/]+)$/, ownerRemoveDriver],
  ['GET', /^\/api\/owner\/reports$/, ownerListReports],
  ['PATCH', /^\/api\/owner\/reports\/(?<id>[^/]+)$/, ownerSetReportStatus],
  ['GET', /^\/api\/owner\/trips$/, ownerListTrips],
  ['GET', /^\/api\/owner\/messages$/, ownerListMessages],
  ['POST', /^\/api\/owner\/messages$/, ownerSendMessage],

  ['POST', /^\/api\/driver\/login$/, driverLogin],
  ['POST', /^\/api\/driver\/logout$/, driverLogout],
  ['GET', /^\/api\/driver\/me$/, driverMe],
  ['POST', /^\/api\/driver\/ping$/, driverPing],
  ['GET', /^\/api\/driver\/trips$/, driverListTrips],
  ['POST', /^\/api\/driver\/trips$/, driverAddTrip],
  ['GET', /^\/api\/driver\/inbox$/, driverInbox],
  ['POST', /^\/api\/driver\/inbox\/(?<id>[^/]+)\/read$/, driverMarkRead],
  ['POST', /^\/api\/driver\/reports$/, driverReport],
];

async function api(req, res, url) {
  for (const [method, pattern, handler] of ROUTES) {
    if (method !== req.method) continue;
    const m = pattern.exec(url.pathname);
    if (m) return handler(req, res, m.groups ?? {});
  }
  return send(res, 404, { error: 'not found' });
}

// ---------- public ----------

function health(req, res) {
  send(res, 200, { ok: true, vehicles: fleet.size, simulated: Boolean(sim) });
}

function config(req, res) {
  send(res, 200, {
    center: CENTER,
    simulated: Boolean(sim),
    ingestAuth: Boolean(INGEST_TOKEN),
    reportTypes: REPORT_TYPES,
    limits: { speedLimitKmh: LIMITS.speedLimitKmh, idleAlertMinutes: LIMITS.idleAlertMs / 60_000, historyMinutes: LIMITS.historyMs / 60_000 },
  });
}

function snapshotAt(req, res) {
  const at = Number(new URL(req.url, 'http://localhost').searchParams.get('at'));
  if (!Number.isFinite(at)) return send(res, 400, { error: 'at must be a ms epoch timestamp' });
  send(res, 200, fleet.snapshotAt(at));
}

// Tracker and simulator ingest. Protected by INGEST_TOKEN when set.
async function ingest(req, res) {
  if (INGEST_TOKEN && bearer(req) !== INGEST_TOKEN) {
    return send(res, 401, { error: 'missing or wrong bearer token' });
  }
  const b = await readBody(req, res);
  if (!b) return;
  const result = fleet.ingest(b, sourceOf(b));
  if (!result.ok) return send(res, 400, { error: result.error });
  send(res, 202, { accepted: true, stale: Boolean(result.stale) });
}

// Driver phones and trackers identify themselves; default is 'tracker'.
function sourceOf(body) {
  return body && body.source === 'driver-phone' ? 'driver-phone' : 'tracker';
}

// ---------- owner (requires owner sign-in) ----------

async function ownerLogin(req, res) {
  const b = await readBody(req, res);
  if (!b) return;
  return sendResult(res, await desk.ownerLogin({ password: b.password, key: clientKey(req) }));
}

function ownerLogout(req, res) {
  desk.closeSession(bearer(req));
  send(res, 200, { ok: true });
}

function ownerListDrivers(req, res) {
  if (!requireOwner(req, res)) return;
  send(res, 200, { drivers: desk.listDrivers() });
}

async function ownerAddDriver(req, res) {
  if (!requireOwner(req, res)) return;
  const b = await readBody(req, res);
  if (!b) return;
  sendResult(res, await desk.addDriver(b), 201, (d) => ({ driver: d }));
}

async function ownerUpdateDriver(req, res, p) {
  if (!requireOwner(req, res)) return;
  const b = await readBody(req, res);
  if (!b) return;
  sendResult(res, await desk.updateDriver(p.id, b), 200, (d) => ({ driver: d }));
}

function ownerRemoveDriver(req, res, p) {
  if (!requireOwner(req, res)) return;
  if (!desk.removeDriver(p.id)) return send(res, 404, { error: 'driver not found' });
  send(res, 200, { ok: true });
}

function ownerListReports(req, res) {
  if (!requireOwner(req, res)) return;
  send(res, 200, { reports: desk.ownerReports() });
}

function ownerListTrips(req, res) {
  if (!requireOwner(req, res)) return;
  send(res, 200, { trips: desk.listTrips() });
}

async function ownerSetReportStatus(req, res, p) {
  if (!requireOwner(req, res)) return;
  const b = await readBody(req, res);
  if (!b) return;
  sendResult(res, desk.setReportStatus(p.id, b.status), 200, (r) => ({ report: r }));
}

function ownerListMessages(req, res) {
  if (!requireOwner(req, res)) return;
  send(res, 200, { messages: desk.sentMessages() });
}

async function ownerSendMessage(req, res) {
  if (!requireOwner(req, res)) return;
  const b = await readBody(req, res);
  if (!b) return;
  sendResult(res, desk.sendMessage({ to: b.to, text: b.text }), 201, (m) => ({ message: m }));
}

// ---------- driver (requires driver sign-in) ----------

async function driverLogin(req, res) {
  const b = await readBody(req, res);
  if (!b) return;
  sendResult(res, await desk.driverLogin({ name: b.name, pin: b.pin, key: clientKey(req) }));
}

function driverLogout(req, res) {
  const d = desk.driverFor(bearer(req));
  if (d) activePhones.delete(d.taxiId);
  desk.closeSession(bearer(req));
  send(res, 200, { ok: true });
}

// The driver's profile and taxi, plus that taxi's live row (null until it has sent a position).
function driverMe(req, res) {
  const d = requireDriver(req, res);
  if (!d) return;
  const row = fleet.vehicleStat(d.taxiId);
  const live = row
    ? { status: row.status, speed: row.speed, distanceKm: row.distanceKm, trips: row.trips, idleMin: row.idleMin, ts: row.ts, historyMinutes: LIMITS.historyMs / 60_000 }
    : null;
  send(res, 200, { driver: publicDriver(d), live, trips: desk.driverTrips(d.id) });
}

// A driver's phone can only report its own taxi, whatever ID the body names.
async function driverPing(req, res) {
  const d = requireDriver(req, res);
  if (!d) return;
  const b = await readBody(req, res);
  if (!b) return;
  if (typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'body must be a JSON object' });
  if (b.sharing === false) {
    activePhones.delete(d.taxiId);
    return send(res, 202, { accepted: true, sharing: false });
  }
  const now = Date.now();
  const prev = fleet.get(d.taxiId);
  const lat = typeof b.lat === 'number' ? b.lat : (prev?.lat ?? CENTER.lat);
  const lng = typeof b.lng === 'number' ? b.lng : (prev?.lng ?? CENTER.lng);
  const ts = typeof b.ts === 'number' && (!prev || b.ts >= prev.ts) ? b.ts : now;
  const result = fleet.ingest({ ...b, lat, lng, ts, vehicleId: d.taxiId }, 'driver-phone', now);
  if (!result.ok) return send(res, 400, { error: result.error });
  activePhones.set(d.taxiId, {
    lat: result.value.lat,
    lng: result.value.lng,
    heading: result.value.heading,
    onTrip: result.value.onTrip,
    updatedAt: now,
  });
  // No stats work here: the series samples on its own timer and stats go out every STATS_PUSH_MS.
  send(res, 202, { accepted: true, stale: Boolean(result.stale) });
}

function driverListTrips(req, res) {
  const d = requireDriver(req, res);
  if (d) send(res, 200, { trips: desk.driverTrips(d.id) });
}

async function driverAddTrip(req, res) {
  const d = requireDriver(req, res);
  if (!d) return;
  const b = await readBody(req, res);
  if (!b) return;
  if (typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'body must be a JSON object' });
  const r = desk.addTrip(d, b);
  if (r.ok) broadcast('live', () => ({ type: 'stats', data: liveStats() }));
  sendResult(res, r, 201, (trip) => ({ trip }));
}

function driverInbox(req, res) {
  const d = requireDriver(req, res);
  if (d) send(res, 200, { messages: desk.inboxFor(d.id) });
}

function driverMarkRead(req, res, p) {
  const d = requireDriver(req, res);
  if (!d) return;
  if (!desk.markRead(d.id, p.id)) return send(res, 404, { error: 'message not found' });
  send(res, 200, { ok: true });
}

async function driverReport(req, res) {
  const d = requireDriver(req, res);
  if (!d) return;
  const b = await readBody(req, res);
  if (!b) return;
  if (typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'body must be a JSON object' });
  const last = fleet.get(d.taxiId);
  const fallback = last && Date.now() - last.ts <= DESK_LIMITS.fallbackFixMs ? last : null;
  sendResult(res, desk.addReport(d, b, fallback), 201, (r) => ({ report: r }));
}

// ---------- helpers ----------

function ownerOnly(handler) {
  return (req, res, p) => (requireOwner(req, res) ? handler(req, res, p) : undefined);
}

function requireOwner(req, res) {
  if (desk.sessionFor(bearer(req), 'owner')) return true;
  send(res, 401, { error: 'owner sign-in required' });
  return false;
}

function requireDriver(req, res) {
  const d = desk.driverFor(bearer(req));
  if (d) return d;
  send(res, 401, { error: 'driver sign-in required' });
  return null;
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Sends a desk result: error with its status, or success with `pick(value)`.
function sendResult(res, result, status = 200, pick = (v) => v) {
  if (!result.ok) {
    if (result.retryAfter) res.setHeader('retry-after', String(result.retryAfter));
    return send(res, result.status || 400, { error: result.error, ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) });
  }
  send(res, status, pick(result.value));
}

// Reads a JSON body. Replies with the error itself and returns null on failure.
async function readBody(req, res) {
  const b = await readJson(req);
  if (b.error) {
    send(res, b.status || 400, { error: b.error });
    return null;
  }
  return b.value ?? {};
}

// deskVersion changes when messages, reports or drivers change; the owner desk refetches on it.
function liveSnapshot() {
  return { ...fleet.snapshot(), reports: desk.publicReports(), deskVersion: desk.version };
}

function liveStats() {
  return { ...stats.summary(), trips: desk.listTrips() };
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Reply 413 instead of destroying the socket; keep draining so the client sees the response.
        if (!tooLarge) resolve({ error: 'body too large', status: 413 });
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
      } catch {
        resolve({ error: 'body is not valid JSON' });
      }
    });
    req.on('error', () => resolve({ error: 'read failed' }));
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Production: serve the Vite build. In dev, Vite serves the client and proxies /api and /ws here.
const DIST = join(ROOT, 'dist');
function serveStatic(res, pathname) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Client not built. Run npm run build, or use npm run dev:client.');
  }
  const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  const file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
  });
  res.end(readFileSync(file));
}

// Two feeds on one socket path:
// - live (default): fleet snapshots at up to 4 Hz, plus dashboard stats every 5 s.
// - desk (`/ws?feed=desk`, for driver phones): only a small notice when desk data changes,
//   so a phone does not download the whole fleet. The notice carries no data; clients refetch.
// The live feed is owner-only. The client's first message is { type: 'auth', token }; the token
// never goes in the URL, where proxies and logs would keep it. Close code 4401 = sign in again.
const WS_AUTH_MS = 5_000;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });
wss.on('connection', (ws, req) => {
  ws.feed = new URL(req.url, 'http://localhost').searchParams.get('feed') === 'desk' ? 'desk' : 'live';
  if (ws.feed === 'desk') {
    ws.send(JSON.stringify({ type: 'desk', version: desk.version }));
    return;
  }
  ws.token = null;
  const deadline = setTimeout(() => ws.close(4401, 'owner sign-in required'), WS_AUTH_MS);
  ws.on('close', () => clearTimeout(deadline));
  ws.on('message', (raw) => {
    if (ws.token) return;
    let msg = null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      /* treated as a failed sign-in below */
    }
    if (msg?.type !== 'auth' || !desk.sessionFor(msg.token, 'owner')) return ws.close(4401, 'owner sign-in required');
    clearTimeout(deadline);
    ws.token = msg.token;
    ws.send(JSON.stringify({ type: 'snapshot', data: liveSnapshot() }));
    ws.send(JSON.stringify({ type: 'stats', data: liveStats() }));
  });
});

function broadcast(feed, message) {
  let payload = null;
  for (const ws of wss.clients) {
    if (ws.feed !== feed || ws.readyState !== ws.OPEN) continue;
    if (feed === 'live') {
      if (!ws.token) continue; // not signed in yet
      // Sign-out or expiry ends the feed too.
      if (!desk.sessionFor(ws.token, 'owner')) {
        ws.close(4401, 'owner sign-in ended');
        continue;
      }
    }
    payload ??= JSON.stringify(typeof message === 'function' ? message() : message);
    ws.send(payload);
  }
}

let lastFleetVersion = -1;
let lastDeskVersion = -1;
setInterval(() => {
  const fleetChanged = fleet.version !== lastFleetVersion;
  const deskChanged = desk.version !== lastDeskVersion;
  if (!fleetChanged && !deskChanged) return;
  lastFleetVersion = fleet.version;
  lastDeskVersion = desk.version;
  broadcast('live', () => ({ type: 'snapshot', data: liveSnapshot() }));
  if (deskChanged) broadcast('desk', { type: 'desk', version: desk.version });
}, BROADCAST_MS);

setInterval(() => broadcast('live', () => ({ type: 'stats', data: liveStats() })), STATS_PUSH_MS);

server.listen(PORT, () => {
  console.log(`taxi monitor API on http://localhost:${PORT}`);
  console.log(sim ? `simulated fleet: ${SIM_COUNT} taxis around ${CENTER.lat}, ${CENTER.lng}` : 'simulator off (SIM_COUNT=0)');
  console.log(INGEST_TOKEN ? 'ingest protected by INGEST_TOKEN' : 'WARNING: INGEST_TOKEN not set; ingest is open to anyone who can reach this port');
  console.log(
    OWNER_PASSWORD
      ? 'owner password: from OWNER_PASSWORD'
      : `WARNING: owner password is the default "${DEFAULT_OWNER_PASSWORD}"; set OWNER_PASSWORD before exposing this server`,
  );
  console.log(`desk data file: ${DATA_FILE}`);
});

function shutdown() {
  sim?.stop();
  clearInterval(sampler);
  clearInterval(phoneKeepAlive);
  desk.flush();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
