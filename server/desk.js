// Driver accounts (name + PIN sign-in, taxi details), owner-to-driver messages and driver field reports.
// Kept in memory. With a file path it also saves one JSON file so it survives restarts,
// sign-ins included: the file keeps a SHA-256 hash of each session token, never the token.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export const REPORT_TYPES = ['rescue', 'road', 'flood', 'traffic', 'other'];
export const REPORT_STATUSES = ['open', 'acknowledged', 'resolved'];

export const DESK_LIMITS = {
  sessionMs: 12 * 60 * 60_000,
  passwordMin: 8,
  passwordMax: 128,
  maxNoteLen: 280,
  maxMessageLen: 1000,
  maxMessages: 1000,
  maxReports: 500,
  maxTrips: 1000,
  reportCooldownMs: 5_000, // one driver, one report per 5 s
  fallbackFixMs: 10 * 60_000, // last GPS ping counts as a location only this recent
  loginWindowMs: 15 * 60_000,
  loginMaxFailures: 10, // per client address, per window
  nameMaxFailures: 5, // wrong PINs per driver name, per window (a 4-digit PIN has only 10,000 values)
  publicResolvedMs: 30 * 60_000, // resolved reports stay on the map this long
};

const PIN = /^\d{4,6}$/;
const TAXI_ID = /^[A-Za-z0-9._-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Taxi details the owner records: field -> max length. All optional, filled in when known.
export const TAXI_FIELDS = { plate: 16, model: 40, bodyNumber: 16, franchiseNo: 40, franchiseExpiry: 10 };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fail = (error, status = 400, extra = {}) => ({ ok: false, error, status, ...extra });
const ok = (value) => ({ ok: true, value });

// Unknown names still pay the cost of a real check, so timing does not reveal accounts.
const DECOY_HASH = hashPassword(randomUUID());

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function publicDriver(d) {
  return { id: d.id, name: d.name, taxiId: d.taxiId, taxi: { ...emptyTaxi(), ...d.taxi }, hasPin: Boolean(d.pinHash), createdAt: d.createdAt };
}

// The sign-in key for a name: case and extra spaces do not matter ("Juan  dela Cruz" = "juan dela cruz").
export function nameKey(name) {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function emptyTaxi() {
  return Object.fromEntries(Object.keys(TAXI_FIELDS).map((k) => [k, '']));
}

// Returns { taxi } with trimmed strings, or { error }. `base` supplies fields the input leaves out.
function checkTaxi(input, base = emptyTaxi()) {
  if (input === undefined || input === null) return { taxi: base };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'taxi must be an object' };
  const taxi = { ...base };
  for (const [key, max] of Object.entries(TAXI_FIELDS)) {
    if (input[key] === undefined) continue;
    const v = typeof input[key] === 'string' ? input[key].trim().replace(/\s+/g, ' ') : null;
    if (v === null || v.length > max) return { error: `${key} must be text of at most ${max} characters` };
    taxi[key] = v;
  }
  if (taxi.franchiseExpiry && !(DATE.test(taxi.franchiseExpiry) && !Number.isNaN(Date.parse(taxi.franchiseExpiry)))) {
    return { error: 'franchiseExpiry must be a date like 2027-03-31' };
  }
  return { taxi };
}

// Session tokens are 32 random bytes, so a fast hash is enough to make a leaked data file useless.
function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function checkPin(pin) {
  return typeof pin === 'string' && PIN.test(pin) ? null : 'PIN must be 4 to 6 digits';
}

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < DESK_LIMITS.passwordMin || p.length > DESK_LIMITS.passwordMax) {
    return `password must be ${DESK_LIMITS.passwordMin}-${DESK_LIMITS.passwordMax} characters`;
  }
  return null;
}

// onDriverOff(taxiId) runs when a driver stops reporting for a taxi: sign-out, session expiry,
// PIN reset, removal, or a move to another taxi.
export function createDesk({ file = null, now = Date.now, limits = DESK_LIMITS, onDriverOff = () => {} } = {}) {
  const drivers = new Map(); // id -> record incl. pinHash (never sent to clients)
  const messages = []; // { id, to: driverId | 'all', text, at, readBy: [driverId] }
  const reports = []; // { id, driverId, driverName, taxiId, type, text, lat, lng, status, at, updatedAt }
  const trips = []; // { id, driverId, driverName, taxiId, startedAt, endedAt, durationSec, distanceKm, at }
  const sessions = new Map(); // tokenHash(token) -> { role, driverId?, expires }
  const failures = new Map(); // client key -> { count, since }
  const nameFailures = new Map(); // nameKey -> { count, since }
  const lastReportAt = new Map(); // driverId -> ms
  let ownerHash = null;
  let version = 0; // bumps on every saved change, lets the broadcaster skip idle ticks
  let saveTimer = null;

  // ---------- persistence ----------

  function load() {
    if (!file || !existsSync(file)) return;
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      // Refuse to start rather than overwrite a file we could not read.
      throw new Error(`${file} is not valid JSON (${err.message}). Move it aside to start with empty data.`);
    }
    for (const d of data.drivers ?? []) drivers.set(d.id, d);
    messages.push(...(data.messages ?? []));
    reports.push(...(data.reports ?? []));
    trips.push(...(data.trips ?? []));
    for (const { hash, ...s } of data.sessions ?? []) if (s.expires >= now()) sessions.set(hash, s);
    ownerHash = data.ownerHash ?? null;
  }

  function save() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    pruneSessions();
    const saved = [...sessions].map(([hash, s]) => ({ hash, ...s }));
    writeFileSync(tmp, JSON.stringify({ version: 1, drivers: [...drivers.values()], messages, reports, trips, sessions: saved, ownerHash }, null, 2));
    renameSync(tmp, file);
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    save();
  }

  // Saves soon. Sign-ins use this alone: they are not desk data, so clients need not refetch.
  function persist() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(flush, 200); // batch bursts of writes into one save
  }

  function changed() {
    version++;
    persist();
  }

  // ---------- sign-in and sessions ----------

  // Milliseconds until a locked key may try again; 0 when it is not locked.
  function lockedMs(key, map = failures, max = limits.loginMaxFailures) {
    const f = map.get(key);
    if (!f) return 0;
    if (now() - f.since > limits.loginWindowMs) {
      map.delete(key);
      return 0;
    }
    return f.count >= max ? f.since + limits.loginWindowMs - now() : 0;
  }

  function recordFailure(key, map = failures) {
    const t = now();
    const f = map.get(key);
    if (!f || t - f.since > limits.loginWindowMs) map.set(key, { count: 1, since: t });
    else f.count++;
  }

  function dropSession(hash) {
    const s = sessions.get(hash);
    if (!s || !sessions.delete(hash)) return false;
    const d = s.role === 'driver' && drivers.get(s.driverId);
    const t = now();
    const stillIn = [...sessions.values()].some((o) => o.driverId === s.driverId && o.expires >= t);
    if (d && !stillIn) onDriverOff(d.taxiId);
    return true;
  }

  function pruneSessions() {
    const t = now();
    for (const [hash, s] of sessions) if (s.expires < t) dropSession(hash);
  }

  // Ends every session that matches; saves when any ended.
  function endSessions(match) {
    let ended = false;
    for (const [hash, s] of sessions) if (match(s) && dropSession(hash)) ended = true;
    if (ended) persist();
  }

  function openSession(session) {
    const token = randomBytes(32).toString('base64url');
    pruneSessions();
    sessions.set(tokenHash(token), { ...session, expires: now() + limits.sessionMs });
    persist();
    return token;
  }

  function sessionFor(token, role) {
    if (typeof token !== 'string' || !token) return null;
    const hash = tokenHash(token);
    const s = sessions.get(hash);
    if (!s) return null;
    if (s.expires < now()) {
      dropSession(hash);
      persist();
      return null;
    }
    return role && s.role !== role ? null : s;
  }

  function closeSession(token) {
    if (typeof token === 'string' && token && dropSession(tokenHash(token))) persist();
  }

  // Returns the driver record for a valid driver session, or null (also after the driver was removed).
  function driverFor(token) {
    const s = sessionFor(token, 'driver');
    return (s && drivers.get(s.driverId)) || null;
  }

  // Keeps owner sign-ins from before a restart only while the password is the same.
  async function setOwnerPassword(password) {
    const err = checkPassword(password);
    if (err) throw new Error(`OWNER_PASSWORD: ${err}`);
    if (ownerHash && (await verifyPassword(password, ownerHash))) return;
    ownerHash = await hashPassword(password);
    endSessions((s) => s.role === 'owner');
    persist();
  }

  async function ownerLogin({ password, key }) {
    const wait = lockedMs(key);
    if (wait > 0) return lockedOut(wait);
    const good = typeof password === 'string' && ownerHash !== null && (await verifyPassword(password, ownerHash));
    if (!good) {
      recordFailure(key);
      return fail('wrong password', 401);
    }
    failures.delete(key);
    return ok({ token: openSession({ role: 'owner' }), expiresInMs: limits.sessionMs });
  }

  // 429 with the time left in seconds, for the countdown on the sign-in screen.
  function lockedOut(waitMs, error = 'too many failed sign-ins') {
    const retryAfter = Math.ceil(waitMs / 1000);
    return fail(error, 429, { retryAfter });
  }

  // Name + PIN. Wrong PINs count against the address and against the name, so one
  // driver's PIN cannot be guessed from many addresses either.
  async function driverLogin({ name, pin, key }) {
    const nk = nameKey(name);
    const wait = Math.max(lockedMs(key), lockedMs(nk, nameFailures, limits.nameMaxFailures));
    if (wait > 0) return lockedOut(wait, 'too many wrong PINs; ask the owner for help or wait');
    const driver = nk ? [...drivers.values()].find((d) => nameKey(d.name) === nk) : null;
    const hash = driver?.pinHash || (await DECOY_HASH); // a driver without a PIN yet cannot sign in
    const good = typeof pin === 'string' && PIN.test(pin) && (await verifyPassword(pin, hash)) && Boolean(driver?.pinHash);
    if (!good) {
      recordFailure(key);
      if (nk) recordFailure(nk, nameFailures);
      return fail('that name and PIN do not match', 401);
    }
    failures.delete(key);
    nameFailures.delete(nk);
    return ok({ token: openSession({ role: 'driver', driverId: driver.id }), driver: publicDriver(driver) });
  }

  // ---------- drivers ----------

  // Checks name and taxi ID for a driver record; `selfId` skips the record being edited.
  function checkIdentity(name, taxiId, selfId = null) {
    if (!name || name.length > 60) return 'name must be 1-60 characters';
    if (!TAXI_ID.test(taxiId)) return 'taxiId must be 1-64 characters: letters, digits, . _ -';
    const others = [...drivers.values()].filter((d) => d.id !== selfId);
    if (others.some((d) => nameKey(d.name) === nameKey(name))) return 'another driver already has that name; add a middle initial or surname';
    if (others.some((d) => d.taxiId === taxiId)) return 'that taxi ID already has a driver';
    return null;
  }

  async function addDriver(input) {
    const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    const taxiId = typeof input?.taxiId === 'string' ? input.taxiId.trim() : '';
    const idErr = checkIdentity(name, taxiId);
    if (idErr) return fail(idErr, idErr.startsWith('another') || idErr.startsWith('that taxi') ? 409 : 400);
    const pinErr = checkPin(input.pin);
    if (pinErr) return fail(pinErr);
    const { taxi, error } = checkTaxi(input.taxi);
    if (error) return fail(error);

    const d = {
      id: randomUUID(),
      name,
      taxiId,
      taxi,
      pinHash: await hashPassword(input.pin),
      createdAt: now(),
    };
    drivers.set(d.id, d);
    nameFailures.delete(nameKey(name));
    changed();
    return ok(publicDriver(d));
  }

  // Edits name, taxi ID, taxi details, and/or resets the PIN. A PIN reset ends the driver's sessions.
  async function updateDriver(id, input) {
    const d = drivers.get(id);
    if (!d) return fail('driver not found', 404);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('body must be a JSON object');
    const name = input.name === undefined ? d.name : typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    const taxiId = input.taxiId === undefined ? d.taxiId : typeof input.taxiId === 'string' ? input.taxiId.trim() : '';
    const idErr = checkIdentity(name, taxiId, id);
    if (idErr) return fail(idErr, idErr.startsWith('another') || idErr.startsWith('that taxi') ? 409 : 400);
    const { taxi, error } = checkTaxi(input.taxi, { ...emptyTaxi(), ...d.taxi });
    if (error) return fail(error);
    let pinHash = d.pinHash;
    if (input.pin !== undefined && input.pin !== '') {
      const pinErr = checkPin(input.pin);
      if (pinErr) return fail(pinErr);
      pinHash = await hashPassword(input.pin);
      endSessions((s) => s.driverId === id);
      nameFailures.delete(nameKey(d.name));
    }
    if (taxiId !== d.taxiId) onDriverOff(d.taxiId);
    Object.assign(d, { name, taxiId, taxi, pinHash });
    delete d.username; // records from before PIN sign-in
    delete d.passwordHash;
    changed();
    return ok(publicDriver(d));
  }

  function removeDriver(id) {
    if (!drivers.has(id)) return false;
    endSessions((s) => s.driverId === id);
    drivers.delete(id);
    changed();
    return true;
  }

  function listDrivers() {
    return [...drivers.values()].map(publicDriver).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- messages ----------

  function sendMessage({ to, text }) {
    if (to !== 'all' && !drivers.has(to)) return fail('to must be "all" or an existing driver id');
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body || body.length > limits.maxMessageLen) return fail(`message must be 1-${limits.maxMessageLen} characters`);
    const m = { id: randomUUID(), to, text: body, at: now(), readBy: [] };
    messages.push(m);
    while (messages.length > limits.maxMessages) messages.shift();
    changed();
    return ok(m);
  }

  function inboxFor(driverId) {
    return messages
      .filter((m) => m.to === driverId || m.to === 'all')
      .slice(-100)
      .reverse()
      .map((m) => ({ id: m.id, text: m.text, at: m.at, read: m.readBy.includes(driverId) }));
  }

  function markRead(driverId, messageId) {
    const m = messages.find((x) => x.id === messageId);
    if (!m || (m.to !== driverId && m.to !== 'all')) return false;
    if (!m.readBy.includes(driverId)) {
      m.readBy.push(driverId);
      changed();
    }
    return true;
  }

  function sentMessages() {
    return messages
      .slice(-100)
      .reverse()
      .map((m) => ({
        id: m.id,
        to: m.to,
        toName: m.to === 'all' ? 'All drivers' : (drivers.get(m.to)?.name ?? 'removed driver'),
        text: m.text,
        at: m.at,
        readCount: m.readBy.length,
      }));
  }

  // ---------- reports ----------

  // `fallbackFix` is the driver's last GPS ping, used only when the report carries no location.
  function addReport(driver, input, fallbackFix = null) {
    const type = input.type;
    if (!REPORT_TYPES.includes(type)) return fail(`type must be one of ${REPORT_TYPES.join(', ')}`);

    let note = '';
    if (input.text !== undefined && input.text !== null) {
      if (typeof input.text !== 'string' || input.text.trim().length > limits.maxNoteLen) {
        return fail(`text must be a string of at most ${limits.maxNoteLen} characters`);
      }
      note = input.text.trim();
    }
    if (type === 'other' && !note) return fail('add a short description for an "other" report');

    let spot;
    if (input.lat !== undefined || input.lng !== undefined) {
      if (!isNum(input.lat) || input.lat < -90 || input.lat > 90) return fail('lat must be a number in [-90, 90]');
      if (!isNum(input.lng) || input.lng < -180 || input.lng > 180) return fail('lng must be a number in [-180, 180]');
      spot = { lat: input.lat, lng: input.lng };
    } else if (fallbackFix) {
      spot = { lat: fallbackFix.lat, lng: fallbackFix.lng };
    } else {
      return fail('location unknown: allow location on the phone, or send lat and lng');
    }

    const t = now();
    if (t - (lastReportAt.get(driver.id) ?? -Infinity) < limits.reportCooldownMs) {
      return fail('wait a few seconds before sending another report', 429);
    }
    lastReportAt.set(driver.id, t);

    const r = {
      id: randomUUID(),
      driverId: driver.id,
      driverName: driver.name,
      taxiId: driver.taxiId,
      type,
      text: note,
      lat: spot.lat,
      lng: spot.lng,
      status: 'open',
      at: t,
      updatedAt: t,
    };
    reports.push(r);
    while (reports.length > limits.maxReports) {
      const i = reports.findIndex((x) => x.status === 'resolved');
      reports.splice(i >= 0 ? i : 0, 1);
    }
    changed();
    return ok(r);
  }

  function setReportStatus(id, status) {
    if (!REPORT_STATUSES.includes(status)) return fail(`status must be one of ${REPORT_STATUSES.join(', ')}`);
    const r = reports.find((x) => x.id === id);
    if (!r) return fail('report not found', 404);
    r.status = status;
    r.updatedAt = now();
    changed();
    return ok(r);
  }

  // What anyone viewing the map may see: no driver names, no account data.
  function publicReports() {
    const cutoff = now() - limits.publicResolvedMs;
    return reports
      .filter((r) => r.status !== 'resolved' || r.updatedAt >= cutoff)
      .map(({ id, type, text, taxiId, lat, lng, status, at }) => ({ id, type, text, taxiId, lat, lng, status, at }));
  }

  function ownerReports() {
    return reports.slice(-200).reverse();
  }

  // ---------- passenger trips ----------

  function addTrip(driver, input = {}) {
    const t = now();
    const durationSec = isNum(input.durationSec) && input.durationSec >= 0 ? Math.round(input.durationSec) : 0;
    const distanceKm = isNum(input.distanceKm) && input.distanceKm >= 0 ? Math.round(input.distanceKm * 100) / 100 : 0;
    const endedAt = isNum(input.endedAt) ? input.endedAt : t;
    const startedAt = isNum(input.startedAt) ? input.startedAt : endedAt - durationSec * 1000;
    const trip = {
      id: randomUUID(),
      driverId: driver.id,
      driverName: driver.name,
      taxiId: driver.taxiId,
      startedAt,
      endedAt,
      durationSec,
      distanceKm,
      at: t,
    };
    trips.push(trip);
    while (trips.length > (limits.maxTrips ?? 1000)) trips.shift();
    changed();
    return ok(trip);
  }

  function listTrips() {
    return trips.slice(-200).reverse();
  }

  function driverTrips(driverId) {
    return trips.filter((x) => x.driverId === driverId).slice(-50).reverse();
  }

  load();

  return {
    setOwnerPassword,
    ownerLogin,
    driverLogin,
    sessionFor,
    driverFor,
    closeSession,
    addDriver,
    updateDriver,
    removeDriver,
    listDrivers,
    sendMessage,
    inboxFor,
    markRead,
    sentMessages,
    addReport,
    setReportStatus,
    publicReports,
    ownerReports,
    addTrip,
    listTrips,
    driverTrips,
    flush,
    get version() {
      return version;
    },
  };
}
