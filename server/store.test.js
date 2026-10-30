import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFleet, parsePing, LIMITS } from './store.js';

const NOW = 1_800_000_000_000;
const base = { vehicleId: 'TX-1', lat: 40.75, lng: -73.98, speed: 30, heading: 90, ts: NOW, onTrip: true };

test('parsePing accepts a valid ping and fills defaults', () => {
  const r = parsePing({ vehicleId: 'TX-1', lat: 1, lng: 2, ts: NOW }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.speed, 0);
  assert.equal(r.value.onTrip, false);
});

test('parsePing rejects bad input with a readable error', () => {
  const cases = [
    [null, 'body'],
    [{ ...base, vehicleId: 'bad id!' }, 'vehicleId'],
    [{ ...base, lat: 91 }, 'lat'],
    [{ ...base, lng: '5' }, 'lng'],
    [{ ...base, speed: -1 }, 'speed'],
    [{ ...base, heading: 361 }, 'heading'],
    [{ ...base, ts: NOW + 10 * 60_000 }, 'ts'],
    [{ ...base, ts: NOW - 2 * LIMITS.maxAgeMs }, 'ts'],
    [{ ...base, onTrip: 'yes' }, 'onTrip'],
  ];
  for (const [input, word] of cases) {
    const r = parsePing(input, NOW);
    assert.equal(r.ok, false, `expected rejection for ${word}`);
    assert.match(r.error, new RegExp(word));
  }
});

test('ingest ignores out-of-order pings', () => {
  const f = createFleet();
  f.ingest(base, 'tracker', NOW);
  const older = f.ingest({ ...base, ts: NOW - 5000, lat: 10 }, 'tracker', NOW);
  assert.equal(older.stale, true);
  const snap = f.snapshot(NOW);
  assert.equal(snap.vehicles[0].lat, 40.75);
});

test('status is free, on_trip or offline', () => {
  const f = createFleet();
  f.ingest({ ...base, onTrip: false }, 'tracker', NOW);
  f.ingest({ ...base, vehicleId: 'TX-2' }, 'tracker', NOW);
  f.ingest({ ...base, vehicleId: 'TX-3', ts: NOW - LIMITS.offlineMs - 1 }, 'tracker', NOW);
  const byId = Object.fromEntries(f.snapshot(NOW).vehicles.map((v) => [v.id, v.status]));
  assert.equal(byId['TX-1'], 'free');
  assert.equal(byId['TX-2'], 'on_trip');
  assert.equal(byId['TX-3'], 'offline');
});

test('speeding and idle-on-trip alerts fire', () => {
  const f = createFleet();
  f.ingest({ ...base, speed: 120 }, 'tracker', NOW);
  let v = f.snapshot(NOW).vehicles[0];
  assert.ok(v.alerts.some((a) => a.type === 'speeding'));

  const g = createFleet();
  for (let t = NOW - LIMITS.idleAlertMs - 1000; t <= NOW; t += 30_000) g.ingest({ ...base, speed: 0, ts: t }, 'tracker', t);
  g.ingest({ ...base, speed: 0, ts: NOW }, 'tracker', NOW);
  v = g.snapshot(NOW).vehicles[0];
  assert.ok(v.alerts.some((a) => a.type === 'idle'), 'idle alert on trip');
});

test('playback returns the last sample at or before a time', () => {
  const f = createFleet();
  f.ingest({ ...base, lat: 1, ts: NOW - 20_000 }, 'tracker', NOW);
  f.ingest({ ...base, lat: 2, ts: NOW - 10_000 }, 'tracker', NOW);
  f.ingest({ ...base, lat: 3, ts: NOW }, 'tracker', NOW);
  const at = f.snapshotAt(NOW - 15_000).vehicles[0];
  assert.equal(at.lat, 1);
  assert.equal(f.snapshotAt(NOW - 30_000).vehicles.length, 0, 'no sample before first ping');
});

test('history is bounded by the playback window', () => {
  const f = createFleet();
  f.ingest({ ...base, ts: NOW - LIMITS.historyMs - 60_000 }, 'tracker', NOW - LIMITS.historyMs - 60_000);
  f.ingest({ ...base, ts: NOW }, 'tracker', NOW);
  assert.equal(f.snapshotAt(NOW - LIMITS.historyMs - 60_000).vehicles.length, 0, 'old sample trimmed');
});

test('a sharing phone that goes quiet shows as asleep with its real last fix time', () => {
  const f = createFleet();
  f.ingest({ ...base, speed: 0 }, 'driver-phone', NOW);
  const later = NOW + LIMITS.idleAlertMs + 60_000;
  const v = f.snapshot(later).vehicles[0];
  assert.equal(v.status, 'asleep');
  assert.equal(v.ts, NOW, 'last fix time is kept, not refreshed');
  assert.deepEqual(v.alerts, [{ type: 'asleep', text: 'Phone asleep, last fix 6 min ago' }], 'no false stop alert from stale data');
  assert.equal(f.vehicleStats(later)[0].idleMin, 0);
});

test('a phone that stopped sharing, or a quiet tracker, shows as offline', () => {
  const f = createFleet();
  f.ingest(base, 'driver-phone', NOW);
  f.ingest({ ...base, vehicleId: 'TX-2' }, 'tracker', NOW);
  f.stopSharing('TX-1');
  const byId = Object.fromEntries(f.snapshot(NOW + LIMITS.offlineMs + 1000).vehicles.map((v) => [v.id, v]));
  assert.equal(byId['TX-1'].status, 'offline');
  assert.equal(byId['TX-2'].status, 'offline');
  assert.equal(byId['TX-1'].alerts[0].type, 'offline');
});

test('the simulator does not take over a sleeping phone', () => {
  const f = createFleet();
  f.ingest(base, 'driver-phone', NOW);
  const later = NOW + 5 * 60_000;
  const r = f.ingest({ ...base, lat: 1, ts: later }, 'sim', later);
  assert.equal(r.stale, true);
  assert.equal(f.snapshot(later).vehicles[0].status, 'asleep');
});

test('a stop starts again after a gap with no fixes', () => {
  const f = createFleet();
  f.ingest({ ...base, speed: 0 }, 'driver-phone', NOW);
  const later = NOW + 10 * 60_000;
  f.ingest({ ...base, speed: 0, ts: later }, 'driver-phone', later);
  const v = f.snapshot(later).vehicles[0];
  assert.equal(v.status, 'on_trip');
  assert.ok(!v.alerts.some((a) => a.type === 'idle'), 'time asleep does not count as stopped');
});
