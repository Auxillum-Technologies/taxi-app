import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFleet, LIMITS } from './store.js';
import { createStats, STATS } from './stats.js';

const T0 = 1_800_000_000_000;

// Feed one ping at T0 + sec seconds.
function feed(fleet, id, sec, fields) {
  const ts = T0 + sec * 1000;
  const r = fleet.ingest({ vehicleId: id, lat: 7.19, lng: 125.45, speed: 0, heading: 0, ts, ...fields }, 'sim', ts);
  assert.equal(r.ok, true, r.error);
}

test('a trip starts when a taxi switches from free to on trip', () => {
  const fleet = createFleet();
  feed(fleet, 'TX-1', 0, { onTrip: true }); // first ping: start time unknown, not counted
  feed(fleet, 'TX-1', 10, { onTrip: false });
  feed(fleet, 'TX-1', 20, { onTrip: true });
  feed(fleet, 'TX-1', 30, { onTrip: true });
  feed(fleet, 'TX-1', 40, { onTrip: false });
  feed(fleet, 'TX-1', 50, { onTrip: true });
  assert.equal(fleet.tripsSince(T0), 2);
  assert.equal(fleet.tripsSince(T0 + 45_000), 1);
  assert.equal(fleet.vehicleStats(T0 + 50_000)[0].trips, 2);
});

test('distance adds up the path and skips GPS jumps', () => {
  const fleet = createFleet();
  feed(fleet, 'TX-1', 0, { lat: 7.19, speed: 30 });
  feed(fleet, 'TX-1', 10, { lat: 7.191, speed: 30 }); // ~0.11 km
  feed(fleet, 'TX-1', 20, { lat: 7.25, speed: 30 }); // ~6.6 km jump, ignored
  feed(fleet, 'TX-1', 30, { lat: 7.251, speed: 30 }); // ~0.11 km
  const [row] = fleet.vehicleStats(T0 + 30_000);
  assert.ok(row.distanceKm > 0.2 && row.distanceKm < 0.25, `got ${row.distanceKm}`);
});

test('idle minutes count while stopped and reset when moving', () => {
  const fleet = createFleet();
  feed(fleet, 'TX-1', 0, { speed: 0 });
  feed(fleet, 'TX-1', 50, { speed: 0 });
  // The taxi keeps pinging every 50 s while stopped, so it never goes offline.
  for (let s = 100; s <= 250; s += 50) feed(fleet, 'TX-1', s, { speed: 0 });
  assert.equal(fleet.vehicleStats(T0 + 250_000)[0].idleMin, 4);
  feed(fleet, 'TX-1', 260, { speed: 20 });
  assert.equal(fleet.vehicleStats(T0 + 260_000)[0].idleMin, 0);
});

test('slow zones need two moving taxis and ignore parked ones', () => {
  const fleet = createFleet();
  for (let s = 0; s < 60; s += 10) {
    // Two taxis crawling through the same cell: a jam.
    feed(fleet, 'A', s, { lat: 7.1901, lng: 125.4501, speed: 4 });
    feed(fleet, 'B', s, { lat: 7.1902, lng: 125.4502, speed: 6 });
    // Two taxis parked at a rank in another cell: not traffic.
    feed(fleet, 'P1', s, { lat: 7.2101, lng: 125.4701, speed: 0 });
    feed(fleet, 'P2', s, { lat: 7.2102, lng: 125.4702, speed: 0 });
    // One taxi alone in a third cell: not enough to judge.
    feed(fleet, 'C', s, { lat: 7.2301, lng: 125.4901, speed: 5 });
  }
  const zones = fleet.congestion(T0 + 60_000);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].vehicles, 2);
  assert.equal(zones[0].level, 'jam');
  assert.equal(zones[0].medianKmh, 5);
});

test('stopped free taxis do not count as traffic, stopped on-trip taxis do', () => {
  const fleet = createFleet();
  for (let s = 0; s < 60; s += 10) {
    // Cell 1: two taxis that drove in, then one waits for a fare (free, stopped).
    feed(fleet, 'A', s, { lat: 7.1901, lng: 125.4501, speed: s < 30 ? 30 : 0, onTrip: false });
    feed(fleet, 'B', s, { lat: 7.1902, lng: 125.4502, speed: 30 });
    // Cell 2: two taxis with passengers stuck at 0 km/h after moving.
    feed(fleet, 'C', s, { lat: 7.2101, lng: 125.4701, speed: s < 10 ? 8 : 0, onTrip: true });
    feed(fleet, 'D', s, { lat: 7.2102, lng: 125.4702, speed: s < 10 ? 8 : 0, onTrip: true });
  }
  const zones = Object.fromEntries(fleet.congestion(T0 + 60_000).map((z) => [z.lat > 7.2 ? 'stuck' : 'rank', z]));
  assert.equal(zones.rank.level, 'flowing', 'the waiting free taxi is ignored');
  assert.equal(zones.stuck.level, 'jam');
});

test('a long stop with a passenger (parked, drop-off) is not traffic', () => {
  const fleet = createFleet();
  // Moving until 0 s, then stopped with a passenger for 4 minutes: only the first 2 min count.
  for (let s = -10; s <= 240; s += 10) {
    feed(fleet, 'A', s, { lat: 7.1901, lng: 125.4501, speed: s <= 0 ? 30 : 0, onTrip: true });
    feed(fleet, 'B', s, { lat: 7.1902, lng: 125.4502, speed: s <= 0 ? 30 : 0, onTrip: true });
  }
  const zones = fleet.congestion(T0 + 240_000);
  assert.equal(zones.length, 1);
  assert.ok(zones[0].samples < 30, `stale stop samples dropped, got ${zones[0].samples}`);
  // Once the 5-minute window starts after the 2-minute grace, nothing counts.
  for (let s = 250; s <= 430; s += 10) {
    feed(fleet, 'A', s, { lat: 7.1901, lng: 125.4501, speed: 0, onTrip: true });
    feed(fleet, 'B', s, { lat: 7.1902, lng: 125.4502, speed: 0, onTrip: true });
  }
  assert.equal(fleet.congestion(T0 + 430_000).length, 0);
});

test('zone level follows median speed thresholds', () => {
  const fleet = createFleet();
  for (let s = 0; s < 40; s += 10) {
    feed(fleet, 'A', s, { lat: 7.1901, lng: 125.4501, speed: 15 });
    feed(fleet, 'B', s, { lat: 7.1902, lng: 125.4502, speed: 15 });
    feed(fleet, 'C', s, { lat: 7.2101, lng: 125.4701, speed: 40 });
    feed(fleet, 'D', s, { lat: 7.2102, lng: 125.4702, speed: 40 });
  }
  const levels = fleet.congestion(T0 + 40_000).map((z) => z.level);
  assert.deepEqual(levels, ['slow', 'flowing']);
  assert.ok(LIMITS.jamKmh < 15 && LIMITS.slowKmh > 15);
});

test('stats summary reports KPIs and keeps a bounded series', () => {
  let t = T0;
  const fleet = createFleet();
  const stats = createStats(fleet, { now: () => t });
  feed(fleet, 'A', 0, { speed: 30, onTrip: true });
  feed(fleet, 'B', 0, { speed: 0, onTrip: false });
  for (let i = 0; i < STATS.points + 10; i++) stats.sample(t);
  const s = stats.summary(t);
  assert.equal(s.series.length, STATS.points);
  assert.equal(s.kpis.online, 2);
  assert.equal(s.kpis.onTrip, 1);
  assert.equal(s.kpis.utilization, 0.5);
  assert.equal(s.kpis.avgMovingKmh, 30, 'stopped taxis do not drag the average down');
  assert.equal(s.vehicles.length, 2);
});
