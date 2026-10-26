// Simulated fleet for testing. It feeds the same ingest path as real sources,
// so the UI, alerts and playback are exercised end to end. Taxis drive along
// the main-road graph (roads.js), so they stay on trunk/primary/secondary roads.
import { bearing, distanceM, loadRoads } from './roads.js';

// Default slow spots around the center, so the dashboard's congestion view has something to show.
function defaultJams(center) {
  return [
    { lat: center.lat + 0.004, lng: center.lng + 0.003, radiusDeg: 0.007 },
    { lat: center.lat - 0.012, lng: center.lng + 0.02, radiusDeg: 0.006 },
    { lat: center.lat + 0.018, lng: center.lng - 0.025, radiusDeg: 0.005 },
  ];
}

// Each simulated taxi works one district and stays within its radius, so the
// fleet is spread across the city instead of drifting out of it. Of every five
// taxis, three work downtown Davao City (the configured center), one Toril and
// one Lanang (approximate centers).
function districtFor(i, center) {
  const slot = i % 5;
  if (slot === 3) return { name: 'Toril', lat: 7.02, lng: 125.41, radiusDeg: 0.015 };
  if (slot === 4) return { name: 'Lanang', lat: 7.1036, lng: 125.62, radiusDeg: 0.015 };
  return { name: 'Downtown', lat: center.lat, lng: center.lng, radiusDeg: 0.03 };
}

function inDistrict([lat, lng], home) {
  return Math.hypot(lat - home.lat, (lng - home.lng) * 1.2) < home.radiusDeg;
}

export function startSimulator(fleet, { count = 10, center, intervalMs = 1000, random = Math.random, jams = defaultJams(center), roads = loadRoads() } = {}) {
  const { nodes, adj } = roads;
  const pick = (list) => list[Math.floor(random() * list.length)];
  // Road segments wholly inside each district, where its taxis start.
  const startEdges = new Map();
  function startEdge(home) {
    if (!startEdges.has(home.name)) {
      const list = [];
      nodes.forEach((p, a) => {
        if (!inDistrict(p, home)) return;
        for (const b of adj[a]) if (inDistrict(nodes[b], home)) list.push([a, b]);
      });
      if (!list.length) throw new Error(`no main roads inside the ${home.name} district`);
      startEdges.set(home.name, list);
    }
    return pick(startEdges.get(home.name));
  }

  // At a junction, carry on along the road most of the time, otherwise turn at
  // random; U-turn only at a dead end or the district edge.
  function nextNode(c) {
    const options = adj[c.to].filter((n) => n !== c.from && inDistrict(nodes[n], c.home));
    if (!options.length) return c.from;
    if (options.length === 1 || random() < 0.4) {
      const turn = (n) => Math.abs(((bearing(nodes[c.to], nodes[n]) - c.heading + 540) % 360) - 180);
      return options.reduce((best, n) => (turn(n) < turn(best) ? n : best));
    }
    return pick(options);
  }

  function drive(c, metres) {
    for (;;) {
      const length = distanceM(nodes[c.from], nodes[c.to]);
      if (c.along + metres < length) {
        c.along += metres;
        break;
      }
      metres -= length - c.along;
      const next = nextNode(c);
      c.from = c.to;
      c.to = next;
      c.along = 0;
      c.heading = bearing(nodes[c.from], nodes[c.to]);
    }
    const t = c.along / (distanceM(nodes[c.from], nodes[c.to]) || 1);
    const [lat1, lng1] = nodes[c.from];
    const [lat2, lng2] = nodes[c.to];
    c.lat = lat1 + (lat2 - lat1) * t;
    c.lng = lng1 + (lng2 - lng1) * t;
  }

  const cars = Array.from({ length: count }, (_, i) => {
    const home = districtFor(i, center);
    const [from, to] = startEdge(home);
    const car = {
      id: `SIM-${String(i + 1).padStart(3, '0')}`,
      district: home.name,
      home,
      from,
      to,
      along: 0,
      lat: nodes[from][0],
      lng: nodes[from][1],
      heading: bearing(nodes[from], nodes[to]),
      speed: 15 + random() * 35,
      cruise: 25 + random() * 20, // each driver's usual city speed, km/h
      onTrip: random() < 0.5,
      parked: 0, // seconds stopped, drives idle alerts
    };
    drive(car, random() * distanceM(nodes[from], nodes[to]));
    return car;
  });

  function tick(now = Date.now()) {
    for (const c of cars) {
      // Occasionally park or change speed/heading for realistic motion.
      if (c.parked > 0) {
        c.parked--;
        c.speed = 0;
      } else {
        // Park now and then for 2-7 minutes (about 30% of the fleet is stopped at any time).
        // A taxi parks after dropping off, so parking ends the trip.
        if (random() < 0.0015) {
          c.parked = 120 + Math.floor(random() * 300);
          c.onTrip = false;
        }
        // Drift around the driver's cruising speed.
        c.speed = Math.max(0, Math.min(70, c.speed + (c.cruise - c.speed) * 0.05 + (random() - 0.5) * 6));
        // Rare speeding bursts so the speed alert is visible but not constant.
        if (random() < 0.001) c.speed = 95 + random() * 20;
        // Crawl through slow spots.
        if (jams.some((j) => Math.hypot(c.lat - j.lat, c.lng - j.lng) < j.radiusDeg)) {
          c.speed = Math.min(c.speed, 2 + random() * 8);
        }
      }
      // About one change every 8 minutes per taxi, so trips last a realistic few minutes.
      if (random() < 0.002) {
        c.onTrip = !c.onTrip;
        if (c.onTrip) c.parked = 0; // picked up a passenger: drive off
      }

      drive(c, (c.speed / 3.6) * (intervalMs / 1000));

      fleet.ingest(
        {
          vehicleId: c.id,
          lat: round(c.lat, 6),
          lng: round(c.lng, 6),
          speed: round(c.speed, 1),
          heading: round(c.heading, 1),
          onTrip: c.onTrip,
          ts: now,
        },
        'sim',
        now,
      );
    }
  }

  tick();
  const timer = setInterval(() => tick(), intervalMs);
  return { stop: () => clearInterval(timer), tick, cars };
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
