// In-memory fleet state: validated ingest, derived status and alerts, and
// a bounded per-vehicle history for playback. No database, by design for v1.

export const LIMITS = {
  speedLimitKmh: 90, // speeding alert above this
  idleAlertMs: 5 * 60_000, // on-trip vehicle stationary this long
  offlineMs: 60_000, // no ping this long => offline, or asleep for a phone that is still sharing
  forgetMs: 30 * 60_000, // drop vehicles unseen this long
  historyMs: 30 * 60_000, // playback window
  maxSamples: 2000, // hard cap per vehicle history
  maxClockSkewMs: 60_000,
  maxAgeMs: 24 * 60 * 60_000,
  tripWindowMs: 24 * 60 * 60_000, // trip starts kept per vehicle
  congestionWindowMs: 5 * 60_000, // samples used for slow zones
  congestionCellDeg: 0.005, // about 550 m in Davao
  congestionMinVehicles: 2, // a zone needs this many moving taxis
  jamKmh: 10, // median below this = jam
  slowKmh: 20, // median below this = slow
  stopGraceMs: 2 * 60_000, // a stop counts as traffic only this soon after moving
  maxJumpKm: 2, // ignore GPS jumps longer than this when adding up distance
};

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Validate one ping. Returns { ok: true, value } or { ok: false, error }.
// Strict on purpose: this is a trust boundary for trackers and phones.
export function parsePing(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('body must be a JSON object');
  }
  const { vehicleId, lat, lng, speed = 0, heading = 0, ts = now, onTrip = false } = input;

  if (typeof vehicleId !== 'string' || !ID_PATTERN.test(vehicleId)) {
    return fail('vehicleId must be 1-64 chars of letters, digits, . _ -');
  }
  if (!isNum(lat) || lat < -90 || lat > 90) return fail('lat must be a number in [-90, 90]');
  if (!isNum(lng) || lng < -180 || lng > 180) return fail('lng must be a number in [-180, 180]');
  if (!isNum(speed) || speed < 0 || speed > 300) return fail('speed must be km/h in [0, 300]');
  if (!isNum(heading) || heading < 0 || heading > 360) return fail('heading must be in [0, 360]');
  if (!isNum(ts) || ts > now + LIMITS.maxClockSkewMs || ts < now - LIMITS.maxAgeMs) {
    return fail('ts must be a ms epoch timestamp within the last 24 hours');
  }
  if (typeof onTrip !== 'boolean') return fail('onTrip must be a boolean when given');

  return { ok: true, value: { vehicleId, lat, lng, speed, heading, ts, onTrip } };
}

// When a phone's GPS fix was taken, on the server clock. The phone sends the fix age measured
// on its own clock, so a phone whose clock is wrong still reports honest freshness.
// Never in the future, never older than maxAgeMs, never before the previous fix (so it is not dropped as out of order).
export function phoneFixTs(fixAgeMs, prevTs, now = Date.now()) {
  const age = isNum(fixAgeMs) ? Math.min(Math.max(fixAgeMs, 0), LIMITS.maxAgeMs) : 0;
  return Math.max(now - age, prevTs ?? -Infinity);
}

function fail(error) {
  return { ok: false, error };
}

export function createFleet({ limits = LIMITS } = {}) {
  const vehicles = new Map(); // id -> latest state
  let version = 0; // bumps on every accepted ping, lets the broadcaster skip idle ticks

  function ingest(ping, source = 'tracker', now = Date.now()) {
    const parsed = parsePing(ping, now);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const prev = vehicles.get(p.vehicleId);

    // A live tracker or driver phone overrides the simulator for the same taxi ID,
    // including a sharing phone that has gone quiet: the owner must see it asleep, not simulated.
    if (source === 'sim' && prev && prev.source !== 'sim' && (prev.sharing || now - prev.ts <= limits.offlineMs)) {
      return { ok: true, value: prev, stale: true };
    }

    // Ignore out-of-order pings so an old packet never overwrites a newer one.
    if (prev && p.ts < prev.ts) return { ok: true, value: prev, stale: true };

    const stationary = p.speed < 1;
    // After a gap with no fixes, nothing is known about the stop, so it starts again.
    const gap = prev && p.ts - prev.ts > limits.offlineMs;
    const stoppedSince = stationary ? ((!gap && prev?.stoppedSince) || p.ts) : null;
    const last = prev?.history.at(-1);
    const v = {
      id: p.vehicleId,
      lat: p.lat,
      lng: p.lng,
      speed: p.speed,
      heading: p.heading,
      onTrip: p.onTrip,
      ts: p.ts,
      source,
      sharing: source === 'driver-phone', // until the phone says it stopped
      stoppedSince,
      history: prev?.history ?? [],
      tripStarts: prev?.tripStarts ?? [], // ms of each free -> on-trip change, last 24 h
      // Distance along `history`, kept as a running total so a stats read does not walk every sample.
      distanceKm: prev?.distanceKm ?? 0,
    };
    // A trip starts when a known vehicle switches from free to on trip.
    if (prev && !prev.onTrip && p.onTrip) v.tripStarts.push(p.ts);
    while (v.tripStarts.length && v.tripStarts[0] < now - limits.tripWindowMs) v.tripStarts.shift();
    const sample = { ts: p.ts, lat: p.lat, lng: p.lng, speed: p.speed, heading: p.heading, onTrip: p.onTrip };
    if (last) v.distanceKm += segmentKm(last, sample, limits.maxJumpKm);
    v.history.push(sample);
    v.distanceKm -= trimHistory(v.history, now, limits);
    // Start again from zero with one sample left, so rounding errors cannot build up.
    if (v.history.length < 2 || v.distanceKm < 0) v.distanceKm = 0;
    vehicles.set(p.vehicleId, v);
    version++;
    return { ok: true, value: v };
  }

  // The driver's phone stopped sharing on purpose (button or sign-out).
  function stopSharing(id) {
    const v = vehicles.get(id);
    if (!v || !v.sharing) return;
    v.sharing = false;
    version++;
  }

  // Derived status and alerts for the live view. A quiet vehicle is 'asleep' when it is a
  // phone that never said it stopped sharing (screen locked, app in background), else 'offline'.
  // Speed and stop alerts need fresh data, so neither fires for a quiet vehicle.
  function describe(v, now) {
    const quiet = now - v.ts > limits.offlineMs;
    const asleep = quiet && v.sharing;
    const alerts = [];
    if (asleep) {
      alerts.push({ type: 'asleep', text: `Phone asleep, last fix ${Math.max(1, Math.round((now - v.ts) / 60_000))} min ago` });
    } else if (quiet) {
      alerts.push({ type: 'offline', text: `No signal for ${Math.round((now - v.ts) / 1000)}s` });
    }
    if (!quiet && v.speed > limits.speedLimitKmh) {
      alerts.push({ type: 'speeding', text: `${Math.round(v.speed)} km/h` });
    }
    if (!quiet && v.onTrip && v.stoppedSince && now - v.stoppedSince > limits.idleAlertMs) {
      alerts.push({ type: 'idle', text: `Stopped on trip for ${Math.round((now - v.stoppedSince) / 60_000)} min` });
    }
    const status = asleep ? 'asleep' : quiet ? 'offline' : v.onTrip ? 'on_trip' : 'free';
    return {
      id: v.id,
      lat: v.lat,
      lng: v.lng,
      speed: v.speed,
      heading: v.heading,
      status,
      ts: v.ts,
      source: v.source,
      alerts,
    };
  }

  function snapshot(now = Date.now()) {
    forget(now);
    return { at: now, version, vehicles: [...vehicles.values()].map((v) => describe(v, now)) };
  }

  // Each vehicle's last known sample at or before `at`, for playback.
  function snapshotAt(at) {
    const out = [];
    for (const v of vehicles.values()) {
      const h = v.history;
      if (!h.length || h[0].ts > at) continue; // no sample that old
      let lo = 0;
      let hi = h.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (h[mid].ts <= at) lo = mid;
        else hi = mid - 1;
      }
      const s = h[lo];
      out.push({ id: v.id, lat: s.lat, lng: s.lng, speed: s.speed, heading: s.heading, ts: s.ts, status: s.onTrip ? 'on_trip' : 'free' });
    }
    return { at, vehicles: out };
  }

  function forget(now) {
    for (const [id, v] of vehicles) {
      if (now - v.ts > limits.forgetMs) vehicles.delete(id);
    }
  }

  // Last accepted position for one vehicle, or null.
  function get(id) {
    const v = vehicles.get(id);
    return v ? { lat: v.lat, lng: v.lng, ts: v.ts } : null;
  }

  // Trip starts across the fleet at or after `from`.
  function tripsSince(from) {
    let n = 0;
    for (const v of vehicles.values()) for (const t of v.tripStarts) if (t >= from) n++;
    return n;
  }

  // Per-taxi rows for the dashboard table.
  function vehicleStats(now = Date.now()) {
    forget(now);
    return [...vehicles.values()].map((v) => statsRow(v, now));
  }

  // One taxi's dashboard row, or null when it is unknown or forgotten. Cost does not grow with the fleet.
  function vehicleStat(id, now = Date.now()) {
    const v = vehicles.get(id);
    if (!v) return null;
    if (now - v.ts > limits.forgetMs) {
      vehicles.delete(id);
      return null;
    }
    return statsRow(v, now);
  }

  function statsRow(v, now) {
    const d = describe(v, now);
    return {
      id: v.id,
      status: d.status,
      speed: v.speed,
      source: v.source,
      alerts: d.alerts.map((a) => a.type),
      distanceKm: round(v.distanceKm, 2),
      trips: v.tripStarts.length,
      idleMin: v.stoppedSince && (d.status === 'free' || d.status === 'on_trip') ? Math.floor((now - v.stoppedSince) / 60_000) : 0,
      ts: v.ts,
    };
  }

  // Slow zones from the fleet's own speeds. Taxis parked for the whole window are left out,
  // so a taxi rank does not look like a traffic jam.
  function congestion(now = Date.now()) {
    const from = now - limits.congestionWindowMs;
    const size = limits.congestionCellDeg;
    const cells = new Map();
    for (const v of vehicles.values()) {
      if (now - v.ts > limits.offlineMs) continue;
      let lastMoving = -Infinity;
      for (const s of v.history) {
        const stopped = s.speed < 1;
        if (!stopped) lastMoving = s.ts;
        if (s.ts < from) continue;
        // A stop is traffic only for a taxi with a passenger that was moving moments ago.
        // Free taxis waiting for a fare and long stops (parking, drop-offs) are left out.
        if (stopped && (!s.onTrip || s.ts - lastMoving > limits.stopGraceMs)) continue;
        const r = Math.floor(s.lat / size);
        const c = Math.floor(s.lng / size);
        const key = `${r}:${c}`;
        let cell = cells.get(key);
        if (!cell) cells.set(key, (cell = { r, c, byVehicle: new Map(), samples: 0 }));
        if (!cell.byVehicle.has(v.id)) cell.byVehicle.set(v.id, []);
        cell.byVehicle.get(v.id).push(s.speed);
        cell.samples++;
      }
    }
    const out = [];
    for (const cell of cells.values()) {
      if (cell.byVehicle.size < limits.congestionMinVehicles) continue;
      // One vote per taxi: a taxi that lingers in a cell sends many samples and would
      // otherwise outvote the taxis that pass through.
      const median = medianOf([...cell.byVehicle.values()].map(medianOf));
      out.push({
        id: `${cell.r}:${cell.c}`,
        lat: round((cell.r + 0.5) * size, 5),
        lng: round((cell.c + 0.5) * size, 5),
        vehicles: cell.byVehicle.size,
        samples: cell.samples,
        medianKmh: round(median, 1),
        level: median < limits.jamKmh ? 'jam' : median < limits.slowKmh ? 'slow' : 'flowing',
      });
    }
    return out.sort((a, b) => a.medianKmh - b.medianKmh);
  }

  return {
    ingest,
    stopSharing,
    get,
    tripsSince,
    vehicleStats,
    vehicleStat,
    congestion,
    snapshot,
    snapshotAt,
    get version() {
      return version;
    },
    get size() {
      return vehicles.size;
    },
  };
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Great-circle distance in km.
function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

// Distance between two samples, or 0 for a jump longer than maxJumpKm (a bad GPS fix).
function segmentKm(a, b, maxJumpKm) {
  const d = haversineKm(a, b);
  return d <= maxJumpKm ? d : 0;
}

// Drops samples older than the playback window. Returns the distance that left the window with them.
function trimHistory(history, now, limits) {
  const cutoff = now - limits.historyMs;
  let drop = 0;
  while (drop < history.length && history[drop].ts < cutoff) drop++;
  if (history.length - drop > limits.maxSamples) drop = history.length - limits.maxSamples;
  if (drop === 0) return 0;
  let km = 0;
  for (let i = 1; i <= drop && i < history.length; i++) km += segmentKm(history[i - 1], history[i], limits.maxJumpKm);
  history.splice(0, drop);
  return km;
}
