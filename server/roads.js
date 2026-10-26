// Main-road graph for the simulator: OpenStreetMap trunk, primary and secondary
// roads around Davao (see main-roads.json for the source and licence).
import { readFileSync } from 'node:fs';

const M_PER_DEG = 111_320;

export function loadRoads(file = new URL('./main-roads.json', import.meta.url)) {
  const { nodes, edges } = JSON.parse(readFileSync(file, 'utf8'));
  return buildRoads(nodes, edges);
}

// nodes: [[lat, lng], ...]; edges: [[a, b], ...] (undirected).
export function buildRoads(nodes, edges) {
  const adj = nodes.map(() => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return { nodes, adj };
}

// Metres between two [lat, lng] points; plenty accurate at city scale.
export function distanceM([lat1, lng1], [lat2, lng2]) {
  const dx = (lng2 - lng1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(lat2 - lat1, dx) * M_PER_DEG;
}

// Compass bearing in degrees, 0 = north, clockwise.
export function bearing([lat1, lng1], [lat2, lng2]) {
  const dx = (lng2 - lng1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return ((Math.atan2(dx, lat2 - lat1) * 180) / Math.PI + 360) % 360;
}
