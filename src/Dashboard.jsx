import { useEffect, useMemo, useRef, useState } from 'react';
import { BarList, TimeChart } from './charts.jsx';
import { Icon } from './icons.jsx';
import {
  LEVEL_HEX,
  LEVEL_LABEL,
  REPORT_COLOR,
  REPORT_LABEL,
  REPORT_ORDER,
  REPORT_STATUS_LABEL,
  STATUS_HEX,
  STATUS_LABEL,
  ago,
  clock,
} from './labels.js';

const STATUS_SERIES = [
  { key: 'free', label: 'Free', color: STATUS_HEX.free },
  { key: 'onTrip', label: 'On trip', color: STATUS_HEX.on_trip },
];
const SPEED_SERIES = [{ key: 'avgMovingKmh', label: 'Average moving speed', color: STATUS_HEX.free }];
const STATUS_RANK = { on_trip: 0, free: 1, offline: 2 };

const COLUMNS = [
  { key: 'id', label: 'Taxi' },
  { key: 'status', label: 'Status' },
  { key: 'speed', label: 'Speed', unit: 'km/h', numeric: true },
  { key: 'distanceKm', label: 'Distance, 30 min', unit: 'km', numeric: true },
  { key: 'trips', label: 'Trips', numeric: true },
  { key: 'idleMin', label: 'Stopped', unit: 'min', numeric: true },
  { key: 'alerts', label: 'Alerts', numeric: true },
];

// Animate a number toward its new value. Instant for reduced-motion users.
function useTween(value, ms = 450) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value;
      setShown(value);
      return undefined;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now) => {
      const k = Math.min(1, (now - start) / ms);
      const v = a + (value - a) * (1 - (1 - k) ** 3);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

function Kpi({ label, value, decimals = 0, suffix = '', sub, tone }) {
  const shown = useTween(value);
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd>
        <span className="kpi-value">{shown.toFixed(decimals)}</span>
        {suffix && <span className="kpi-suffix">{suffix}</span>}
      </dd>
      {sub && <p className="kpi-sub">{sub}</p>}
    </div>
  );
}

export default function Dashboard({ stats, reports, connected, onLocateVehicle, onLocatePoint }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'status', dir: 1 });

  const rows = useMemo(() => {
    if (!stats) return [];
    const q = query.trim().toLowerCase();
    const value = (r) => (sort.key === 'status' ? STATUS_RANK[r.status] : sort.key === 'alerts' ? r.alerts.length : r[sort.key]);
    return stats.vehicles
      .filter((r) => !q || r.id.toLowerCase().includes(q))
      .sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
        return c * sort.dir || a.id.localeCompare(b.id);
      });
  }, [stats, query, sort]);

  const openReports = reports.filter((r) => r.status !== 'resolved');
  const reportCounts = REPORT_ORDER.map((type) => ({
    key: type,
    label: REPORT_LABEL[type],
    color: REPORT_COLOR[type],
    value: openReports.filter((r) => r.type === type).length,
  }));
  const latestReports = [...reports].sort((a, b) => b.at - a.at).slice(0, 8);

  if (!stats) {
    return (
      <main className="dashboard" aria-label="Fleet dashboard" aria-busy="true">
        <p className="muted dash-loading">{connected ? 'Loading fleet numbers…' : 'Connecting to the fleet server…'}</p>
      </main>
    );
  }

  const k = stats.kpis;
  const zones = stats.congestion.filter((z) => z.level !== 'flowing');
  const historyMin = Math.round((stats.at - stats.startedAt) / 60_000);

  function sortBy(key) {
    setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'id' || key === 'status' ? 1 : -1 }));
  }

  return (
    <main className="dashboard" aria-label="Fleet dashboard">
      <div className="dash-head">
        <div>
          <h2 className="dash-title">Fleet today</h2>
          <p className="muted small">
            Updated {clock(stats.at)} · history since {clock(stats.startedAt)}
            {historyMin < 30 ? ` (server started ${historyMin} min ago)` : ''}
          </p>
        </div>
      </div>

      <dl className="kpis">
        <Kpi label="Online" value={k.online} sub={`of ${k.total} taxis · ${k.offline} offline`} />
        <Kpi label="On trip" value={k.utilization * 100} suffix="%" sub={`${k.onTrip} taxis carrying passengers`} />
        <Kpi label="Moving speed" value={k.avgMovingKmh} decimals={1} suffix="km/h" sub={`average of ${k.moving} moving taxis`} />
        <Kpi label="Trips, last hour" value={k.tripsLastHour} sub="free → on trip changes" />
        <Kpi label="Slow zones" value={k.slowZones} sub={`${k.jams} jammed`} tone={k.jams ? 'alert' : undefined} />
        <Kpi label="Alerts" value={k.alerts} sub={`${openReports.length} open driver reports`} tone={k.alerts ? 'alert' : undefined} />
      </dl>

      <div className="dash-grid">
        <section className="dash-card" aria-label="Fleet status over time">
          <TimeChart
            title="Online taxis, last 30 min"
            data={stats.series}
            series={STATUS_SERIES}
            stacked
            empty="The first points appear within 30 seconds of the server starting."
          />
        </section>
        <section className="dash-card" aria-label="Average speed over time">
          <TimeChart
            title="Average moving speed (km/h)"
            data={stats.series}
            series={SPEED_SERIES}
            format={(v) => v.toFixed(0)}
            empty="The first points appear within 30 seconds of the server starting."
          />
        </section>

        <section className="dash-card" aria-labelledby="zones-h">
          <div className="card-title-row">
            <h3 id="zones-h">Slow zones</h3>
            <span className="muted small">from taxi speeds, last 5 min</span>
          </div>
          {zones.length === 0 ? (
            <p className="muted">Traffic is moving. A zone shows here when 2 or more taxis in the same 500 m area average under 20 km/h.</p>
          ) : (
            <ul className="zone-list">
              {zones.slice(0, 8).map((z) => (
                <li key={z.id}>
                  <span className={`level level-${z.level}`}>
                    <span className="swatch" style={{ background: LEVEL_HEX[z.level] }} aria-hidden="true" />
                    {LEVEL_LABEL[z.level]}
                  </span>
                  <span className="zone-speed">
                    <strong>{z.medianKmh.toFixed(0)}</strong> km/h
                  </span>
                  <span className="muted small">{z.vehicles} taxis</span>
                  <button type="button" className="ghost icon-btn" onClick={() => onLocatePoint(z)} aria-label={`Show ${LEVEL_LABEL[z.level].toLowerCase()} zone on map`}>
                    <Icon name="location_on" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="dash-card" aria-labelledby="reports-h">
          <div className="card-title-row">
            <h3 id="reports-h">Driver reports</h3>
            <span className="muted small">{openReports.length} open</span>
          </div>
          <BarList items={reportCounts} emptyText="No open reports from drivers." />
          {latestReports.length > 0 && (
            <ul className="feed">
              {latestReports.map((r) => (
                <li key={r.id}>
                  <span className="swatch" style={{ background: REPORT_COLOR[r.type] }} aria-hidden="true" />
                  <span className="feed-main">
                    <strong>{REPORT_LABEL[r.type]}</strong> · taxi {r.taxiId}
                    <span className="muted small"> · {ago(r.at)} · {REPORT_STATUS_LABEL[r.status]}</span>
                    {r.text && <span className="feed-text">{r.text}</span>}
                  </span>
                  <button type="button" className="ghost icon-btn" onClick={() => onLocatePoint(r)} aria-label={`Show ${REPORT_LABEL[r.type]} report on map`}>
                    <Icon name="location_on" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="dash-card dash-table" aria-labelledby="taxis-h">
        <div className="card-title-row">
          <h3 id="taxis-h">Taxis ({rows.length})</h3>
          <label className="table-search">
            <Icon name="search" size={18} />
            <span className="sr-only">Search taxi ID</span>
            <input type="search" placeholder="Search taxi ID" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={c.numeric ? 'num' : ''}
                    aria-sort={sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}
                  >
                    <button type="button" className="th-btn" onClick={() => sortBy(c.key)}>
                      {c.label}
                      {sort.key === c.key && <Icon name={sort.dir > 0 ? 'arrow_upward' : 'arrow_downward'} size={16} />}
                    </button>
                  </th>
                ))}
                <th scope="col"><span className="sr-only">Locate</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r) => (
                <tr key={r.id}>
                  <th scope="row" className="taxi-id">{r.id}</th>
                  <td>
                    <span className="status">
                      <span className="swatch" style={{ background: STATUS_HEX[r.status] }} aria-hidden="true" />
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="num">{Math.round(r.speed)}</td>
                  <td className="num">{r.distanceKm.toFixed(1)}</td>
                  <td className="num">{r.trips}</td>
                  <td className="num">{r.idleMin || '–'}</td>
                  <td className="num">
                    {r.alerts.length ? (
                      <span className="alert-text">
                        <Icon name="warning" size={16} /> {r.alerts.join(', ')}
                      </span>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    <button type="button" className="ghost icon-btn" onClick={() => onLocateVehicle(r.id)} aria-label={`Show taxi ${r.id} on map`}>
                      <Icon name="location_on" />
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="muted">No taxis match.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted small">Distance, trips and stopped time cover data received since the server started.</p>
      </section>
    </main>
  );
}
