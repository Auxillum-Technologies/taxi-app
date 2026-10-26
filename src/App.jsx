import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map as MlMap, Marker as MlMarker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
// MapLibre finds its worker next to its own module file. Bundling moves that file,
// so hand it the worker's built URL (this is what fixed the blank map in production).
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createFleetLayer } from './fleetLayer.js';
import { useLiveFleet, fetchJson } from './useLiveFleet.js';
import OwnerDesk from './OwnerDesk.jsx';
import Dashboard from './Dashboard.jsx';
import { Icon } from './icons.jsx';
import {
  LEVEL_HEX,
  LEVEL_LABEL,
  REPORT_COLOR,
  REPORT_LABEL,
  REPORT_STATUS_LABEL,
  STATUS_HEX,
  STATUS_LABEL,
  ago,
} from './labels.js';

setWorkerUrl(workerUrl);

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'free', label: 'Free' },
  { id: 'on_trip', label: 'On trip' },
  { id: 'offline', label: 'Offline' },
  { id: 'alerts', label: 'Alerts' },
];
const CLICK_RADIUS_PX = 24;
const VIEWS = ['map', 'dashboard'];
const viewFromHash = () => (window.location.hash === '#dashboard' ? 'dashboard' : 'map');
const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };

const FALLBACK_CONFIG = { center: { lat: 7.07, lng: 125.61 }, simulated: false, limits: { idleAlertMinutes: 5, historyMinutes: 30, speedLimitKmh: 90 } };

// The fleet console. Rendered only for a signed-in owner (see main.jsx).
export default function App({ token, onSignOut }) {
  const live = useLiveFleet(token, onSignOut);
  const [config, setConfig] = useState(null);
  const [view, setView] = useState(viewFromHash);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedReportId, setSelectedReportId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [vehicleListOpen, setVehicleListOpen] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  const [replayMin, setReplayMin] = useState(0); // 0 = live
  const [replayVehicles, setReplayVehicles] = useState([]);
  const [replayError, setReplayError] = useState(false);
  const [replayEmpty, setReplayEmpty] = useState(false);
  const [ready, setReady] = useState(false);
  const [deskOpen, setDeskOpen] = useState(false);
  const [trafficOn, setTrafficOn] = useState(true);
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const fleetRef = useRef(null);
  const liveRef = useRef([]);
  const hudRef = useRef(null);
  const reportPinsRef = useRef(new Map()); // report id -> maplibre Marker

  useEffect(() => {
    fetchJson('/api/config', { token })
      .then(setConfig)
      .catch((err) => (err.status === 401 ? onSignOut() : setConfig(FALLBACK_CONFIG)));
  }, [token, onSignOut]);

  // Tabs follow the URL hash, so reload and the back button keep the view.
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const showView = useCallback((v) => {
    const hash = v === 'dashboard' ? '#dashboard' : '#map';
    if (window.location.hash !== hash) window.location.hash = hash;
    setView(v);
  }, []);

  // Build the map once the center is known.
  useEffect(() => {
    if (!config || !mapEl.current || mapRef.current) return;
    const map = new MlMap({
      container: mapEl.current,
      style: MAP_STYLE,
      center: [config.center.lng, config.center.lat],
      zoom: 14.2,
      pitch: 55,
      bearing: -18,
      antialias: true,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
    const fleet = createFleetLayer({ origin: { lng: config.center.lng, lat: config.center.lat } });
    fleetRef.current = fleet;
    mapRef.current = map;
    map.on('load', () => {
      // Slow zones sit under the taxis. Circle radius grows with zoom so a zone keeps about 275 m on the ground.
      map.addSource('congestion', { type: 'geojson', data: EMPTY_GEOJSON });
      map.addLayer({
        id: 'congestion',
        type: 'circle',
        source: 'congestion',
        paint: {
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, 1.8, 18, 464],
          'circle-color': ['match', ['get', 'level'], 'jam', LEVEL_HEX.jam, 'slow', LEVEL_HEX.slow, LEVEL_HEX.flowing],
          'circle-opacity': ['match', ['get', 'level'], 'flowing', 0.08, 0.22],
          'circle-stroke-color': ['match', ['get', 'level'], 'jam', LEVEL_HEX.jam, 'slow', LEVEL_HEX.slow, LEVEL_HEX.flowing],
          'circle-stroke-width': ['match', ['get', 'level'], 'flowing', 0, 2],
          'circle-pitch-alignment': 'map',
        },
      });
      map.addLayer(fleet.layer);
      setReady(true);
    });
    map.on('click', (e) => {
      // Report pins handle their own clicks.
      if (e.originalEvent?.target?.closest?.('.report-pin')) return;
      const hit = nearestVehicle(map, liveRef.current, e.point);
      setSelectedId(hit ? hit.id : null);
      setSelectedReportId(null);
    });
    map.on('error', (e) => {
      // Tile or style hiccups are non-fatal; log for debugging only.
      console.warn('map error', e?.error?.message || e);
    });
    return () => {
      map.remove();
      mapRef.current = null;
      fleetRef.current = null;
    };
  }, [config]);

  // Keep the layer's copy of the latest vehicles for click hit-testing.
  liveRef.current = live.vehicles;

  // Slow-zone circles from the latest dashboard stats.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const zones = trafficOn ? live.stats?.congestion ?? [] : [];
    map.getSource('congestion')?.setData({
      type: 'FeatureCollection',
      features: zones.map((z) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [z.lng, z.lat] },
        properties: { level: z.level },
      })),
    });
  }, [live.stats, trafficOn, ready]);

  // Report pins: one button per open or acknowledged report.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const pins = reportPinsRef.current;
    const seen = new Set();
    for (const r of live.reports) {
      seen.add(r.id);
      let marker = pins.get(r.id);
      if (!marker) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'report-pin';
        el.style.setProperty('--pin', REPORT_COLOR[r.type] || '#fff');
        el.setAttribute('aria-label', `${REPORT_LABEL[r.type]} report, taxi ${r.taxiId}`);
        el.innerHTML = '<span aria-hidden="true"></span>';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          setSelectedReportId(r.id);
          setSelectedId(null);
        });
        marker = new MlMarker({ element: el, anchor: 'center' }).setLngLat([r.lng, r.lat]).addTo(map);
        pins.set(r.id, marker);
      } else {
        marker.setLngLat([r.lng, r.lat]);
      }
      marker.getElement().dataset.status = r.status;
    }
    for (const [id, marker] of pins) {
      if (!seen.has(id)) {
        marker.remove();
        pins.delete(id);
      }
    }
  }, [live.reports, ready]);

  // Playback: fetch positions at a past time when the replay slider moves.
  useEffect(() => {
    if (replayMin === 0) {
      setReplayVehicles([]);
      setReplayError(false);
      setReplayEmpty(false);
      return;
    }
    const ctl = new AbortController();
    const at = Date.now() - replayMin * 60_000;
    fetchJson(`/api/snapshot?at=${at}`, { signal: ctl.signal, token })
      .then((d) => {
        setReplayError(false);
        setReplayEmpty(d.vehicles.length === 0);
        setReplayVehicles(d.vehicles.map((v) => ({ ...v, alerts: [] })));
      })
      .catch((err) => {
        if (err.status === 401) onSignOut();
        else if (err.name !== 'AbortError') setReplayError(true);
      });
    return () => ctl.abort();
  }, [replayMin, token, onSignOut]);

  const displayed = replayMin > 0 ? replayVehicles : live.vehicles;

  // The map sits behind the dashboard; skip redraws while it cannot be seen.
  useEffect(() => {
    if (!ready || !fleetRef.current || view !== 'map') return;
    fleetRef.current.update(displayed, { playback: replayMin > 0 });
  }, [displayed, ready, replayMin, view]);

  const counts = useMemo(() => {
    const c = { free: 0, on_trip: 0, offline: 0, alerts: 0 };
    for (const v of live.vehicles) {
      c[v.status] = (c[v.status] || 0) + 1;
      if (v.alerts.length) c.alerts++;
    }
    return c;
  }, [live.vehicles]);

  const openReports = live.reports.filter((r) => r.status !== 'resolved').length;

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return live.vehicles
      .filter((v) => {
        if (filter === 'alerts' && v.alerts.length === 0) return false;
        if (filter !== 'all' && filter !== 'alerts' && v.status !== filter) return false;
        return !q || v.id.toLowerCase().includes(q);
      })
      .sort((a, b) => b.alerts.length - a.alerts.length || a.id.localeCompare(b.id));
  }, [live.vehicles, filter, query]);

  const selected = live.vehicles.find((v) => v.id === selectedId) || null;
  const selectedReport = selected ? null : live.reports.find((r) => r.id === selectedReportId) || null;

  useEffect(() => {
    if (!selected || !mapRef.current) return;
    mapRef.current.easeTo({ center: [selected.lng, selected.lat], duration: 600 });
  }, [selectedId]); // fly only when the selection changes, not on every tick

  function focus(v) {
    setSelectedReportId(null);
    setSelectedId(v.id);
  }

  // From the dashboard: open the map on a taxi, a slow zone or a report.
  function locateVehicle(id) {
    showView('map');
    setSelectedReportId(null);
    setSelectedId(id);
    const v = live.vehicles.find((x) => x.id === id);
    if (v) mapRef.current?.easeTo({ center: [v.lng, v.lat], zoom: Math.max(mapRef.current.getZoom(), 15), duration: 700 });
  }

  function locatePoint(p) {
    showView('map');
    setSelectedId(null);
    setSelectedReportId(p.type && REPORT_LABEL[p.type] ? p.id : null);
    mapRef.current?.easeTo({ center: [p.lng, p.lat], zoom: 15.5, duration: 700 });
  }

  const closeDesk = useCallback(() => setDeskOpen(false), []);

  // Parallax: the selection card and replay bar drift slightly with the pointer.
  // The header and vehicle list stay still.
  function onPointerMove(e) {
    const el = hudRef.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = (e.clientY / window.innerHeight) * 2 - 1;
    el.style.setProperty('--mx', x.toFixed(3));
    el.style.setProperty('--my', y.toFixed(3));
  }

  return (
    <div className="app" onPointerMove={view === 'map' ? onPointerMove : undefined}>
      <div ref={mapEl} className="map" aria-label="Map of taxi positions" role="region" />

      <header className="topbar">
        <div className="brand">
          <h1>Taxi fleet</h1>
          <p className="muted conn">
            <span className={`dot ${live.connected ? 'ok' : 'bad'}`} aria-hidden="true" />
            {live.connected ? 'Live' : 'Reconnecting…'}
            {config?.simulated ? ' · simulated' : ''}
          </p>
        </div>

        <nav className="tabs" role="tablist" aria-label="View">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              id={`tab-${v}`}
              aria-selected={view === v}
              aria-controls={`panel-${v}`}
              className={view === v ? 'tab on' : 'tab'}
              onClick={() => showView(v)}
            >
              {v === 'map' ? 'Map' : 'Dashboard'}
            </button>
          ))}
        </nav>

        <div className="top-actions">
          <dl className="counts">
            <div>
              <dt><span className="swatch" style={{ background: STATUS_HEX.free }} aria-hidden="true" />Free</dt>
              <dd>{counts.free}</dd>
            </div>
            <div>
              <dt><span className="swatch" style={{ background: STATUS_HEX.on_trip }} aria-hidden="true" />On trip</dt>
              <dd>{counts.on_trip}</dd>
            </div>
            <div>
              <dt>Alerts</dt>
              <dd className={counts.alerts ? 'alert-text' : ''}>{counts.alerts}</dd>
            </div>
            <div>
              <dt>Reports</dt>
              <dd className={openReports ? 'alert-text' : ''}>{openReports}</dd>
            </div>
          </dl>
          <button type="button" className="ghost desk-open" onClick={() => setDeskOpen(true)} aria-haspopup="dialog">
            <Icon name="chat" />
            <span>Desk</span>
          </button>
          <button type="button" className="ghost desk-open" onClick={() => onSignOut('manual')}>
            <Icon name="logout" />
            <span>Sign out</span>
          </button>
        </div>
      </header>

      <div ref={hudRef} className="hud" id="panel-map" role="tabpanel" aria-labelledby="tab-map" hidden={view !== 'map'}>
        <aside className={`panel side${vehicleListOpen ? '' : ' list-collapsed'}`} aria-label="Vehicle list">
          <div className="vehicle-list-head">
            <strong>Vehicles <span className="muted">({listed.length})</span></strong>
            <button
              type="button"
              className="ghost vehicle-list-toggle"
              aria-expanded={vehicleListOpen}
              aria-controls="vehicle-list-content"
              onClick={() => setVehicleListOpen((open) => !open)}
            >
              {vehicleListOpen ? 'Hide list' : 'Show list'}
            </button>
          </div>
          <div className="vehicle-list-content" id="vehicle-list-content" hidden={!vehicleListOpen}>
          <label className="table-search">
            <Icon name="search" size={18} />
            <span className="sr-only">Search vehicle ID</span>
            <input type="search" placeholder="Search vehicle ID" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="chips" role="group" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={filter === f.id ? 'chip on' : 'chip'}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <ul className="vehicles">
            {listed.slice(0, 200).map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={v.id === selectedId ? 'row selected' : 'row'}
                  onClick={() => focus(v)}
                >
                  <span className="swatch" style={{ background: STATUS_HEX[v.status] }} aria-hidden="true" />
                  <span className="id">{v.id}</span>
                  <span className="meta">{Math.round(v.speed)} km/h</span>
                  {v.alerts.length > 0 ? <Icon name="warning" size={18} className="alert-text" /> : <span />}
                  <span className="sr-only">{STATUS_LABEL[v.status]}{v.alerts.length ? ', has alerts' : ''}</span>
                </button>
              </li>
            ))}
            {listed.length === 0 && <li className="muted empty">No vehicles match.</li>}
          </ul>
          </div>
        </aside>

        {selected && (
          <section className="panel card depth-3" aria-live="polite" aria-label="Selected vehicle">
            <div className="card-head">
              <strong>{selected.id}</strong>
              <button type="button" className="ghost icon-btn" onClick={() => setSelectedId(null)} aria-label="Close vehicle details">
                <Icon name="close" />
              </button>
            </div>
            <p className="status">
              <span className="swatch" style={{ background: STATUS_HEX[selected.status] }} aria-hidden="true" />
              {STATUS_LABEL[selected.status]} · {Math.round(selected.speed)} km/h · heading {Math.round(selected.heading)}°
            </p>
            <p className="muted small">Source: {selected.source} · updated {ago(selected.ts)}</p>
            {selected.alerts.length > 0 ? (
              <ul className="alerts">
                {selected.alerts.map((a) => (
                  <li key={a.type} className="alert-text">
                    <Icon name="warning" size={18} /> {a.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No active alerts.</p>
            )}
          </section>
        )}

        {selectedReport && (
          <section className="panel card depth-3" aria-live="polite" aria-label="Selected report">
            <div className="card-head">
              <strong>
                <span className="swatch" style={{ background: REPORT_COLOR[selectedReport.type] }} aria-hidden="true" />
                {REPORT_LABEL[selectedReport.type]}
              </strong>
              <button type="button" className="ghost icon-btn" onClick={() => setSelectedReportId(null)} aria-label="Close report details">
                <Icon name="close" />
              </button>
            </div>
            <p>Taxi {selectedReport.taxiId} · {REPORT_STATUS_LABEL[selectedReport.status]}</p>
            {selectedReport.text ? <p>{selectedReport.text}</p> : <p className="muted small">No note from the driver.</p>}
            <p className="muted small">Reported {ago(selectedReport.at)}</p>
          </section>
        )}

        <footer className="panel bottom depth-1" aria-label="Playback and layers">
          <div className="replay">
            <button type="button" className={replayMin === 0 ? 'live on' : 'live'} onClick={() => setReplayMin(0)}>
              Live
            </button>
            <label htmlFor="replay">
              <span className="replay-label-full">{replayMin === 0 ? 'Showing live positions' : `Replay ${replayMin} min ago`}</span>
              <span className="replay-label-short" aria-hidden="true">{replayMin === 0 ? 'Now' : `-${replayMin}m`}</span>
            </label>
            <input
              id="replay"
              type="range"
              min="0"
              max={config?.limits?.historyMinutes ?? 30}
              step="1"
              value={replayMin}
              onChange={(e) => setReplayMin(Number(e.target.value))}
              aria-valuetext={replayMin === 0 ? 'live' : `${replayMin} minutes ago`}
            />
            <button type="button" className={trafficOn ? 'chip on' : 'chip'} aria-pressed={trafficOn} onClick={() => setTrafficOn((t) => !t)}>
              <Icon name={trafficOn ? 'visibility' : 'visibility_off'} size={18} />
              Traffic
            </button>
          </div>
          {trafficOn && (
            <ul className="legend traffic-legend" aria-label="Traffic legend">
              {['jam', 'slow'].map((l) => (
                <li key={l}>
                  <span className="swatch" style={{ background: LEVEL_HEX[l] }} aria-hidden="true" />
                  {LEVEL_LABEL[l]}
                </li>
              ))}
              <li className="muted">from taxi speeds, last 5 min</li>
            </ul>
          )}
          {replayError && <p className="alert-text small">Could not load that moment. Try again.</p>}
          {!replayError && replayEmpty && <p className="muted small">No positions were recorded at that time. The server keeps the last 30 minutes.</p>}
          {!live.connected && <p className="alert-text small">Connection lost. Retrying…</p>}
        </footer>
      </div>

      {view === 'dashboard' && (
        <div id="panel-dashboard" role="tabpanel" aria-labelledby="tab-dashboard" className="dashboard-wrap">
          <Dashboard
            stats={live.stats}
            reports={live.reports}
            connected={live.connected}
            onLocateVehicle={locateVehicle}
            onLocatePoint={locatePoint}
          />
        </div>
      )}

      {deskOpen && <OwnerDesk onClose={closeDesk} deskVersion={live.deskVersion} token={token} onSignOut={onSignOut} />}
    </div>
  );
}

// Nearest vehicle to a click, by projected screen position.
function nearestVehicle(map, vehicles, point) {
  let best = null;
  let bestD = CLICK_RADIUS_PX;
  for (const v of vehicles) {
    const p = map.project([v.lng, v.lat]);
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}
