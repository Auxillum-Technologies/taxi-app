// Dashboard numbers: KPIs for now, a 30-minute series sampled every 15 s,
// per-taxi rows and slow zones. Everything is derived from the fleet store.

export const STATS = {
  sampleMs: 15_000,
  points: 120, // 120 x 15 s = 30 min
  movingKmh: 3, // slower than this counts as stopped for the average speed
};

export function createStats(fleet, { now = Date.now, opts = STATS } = {}) {
  const startedAt = now();
  const series = [];

  function kpis(vehicles, zones, t) {
    let free = 0;
    let onTrip = 0;
    let offline = 0;
    let alerts = 0;
    let moving = 0;
    let speedSum = 0;
    for (const v of vehicles) {
      if (v.status === 'free') free++;
      else if (v.status === 'on_trip') onTrip++;
      else offline++;
      if (v.alerts.length) alerts++;
      if (v.status !== 'offline' && v.speed >= opts.movingKmh) {
        moving++;
        speedSum += v.speed;
      }
    }
    const online = free + onTrip;
    return {
      total: vehicles.length,
      online,
      free,
      onTrip,
      offline,
      alerts,
      moving,
      utilization: online ? onTrip / online : 0,
      avgMovingKmh: moving ? Math.round((speedSum / moving) * 10) / 10 : 0,
      tripsLastHour: fleet.tripsSince(t - 60 * 60_000),
      slowZones: zones.filter((z) => z.level !== 'flowing').length,
      jams: zones.filter((z) => z.level === 'jam').length,
    };
  }

  // Record one point of the time series.
  function sample(t = now()) {
    const { vehicles } = fleet.snapshot(t);
    const k = kpis(vehicles, fleet.congestion(t), t);
    series.push({
      t,
      free: k.free,
      onTrip: k.onTrip,
      offline: k.offline,
      avgMovingKmh: k.avgMovingKmh,
      alerts: k.alerts,
      slowZones: k.slowZones,
    });
    while (series.length > opts.points) series.shift();
  }

  // Everything the dashboard shows, in one message.
  function summary(t = now()) {
    const { vehicles } = fleet.snapshot(t);
    const zones = fleet.congestion(t);
    return {
      at: t,
      startedAt,
      sampleMs: opts.sampleMs,
      kpis: kpis(vehicles, zones, t),
      series: series.slice(),
      congestion: zones,
      vehicles: fleet.vehicleStats(t),
    };
  }

  return { sample, summary };
}
