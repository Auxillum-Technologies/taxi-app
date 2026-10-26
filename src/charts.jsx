// Small SVG charts for the dashboard. One y-axis per chart, 2px lines, recessive grid,
// crosshair tooltip on hover or arrow keys, and a data table for screen readers.
import { useEffect, useMemo, useRef, useState } from 'react';
import { clock } from './labels.js';

const PAD = { l: 36, r: 12, t: 12, b: 24 };

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Smallest 1/2/5 x 10^n at or above v.
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const linePath = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

/**
 * Time series chart.
 * series: [{ key, label, color }]; data: [{ t, [key]: number }].
 * stacked: fills stack bottom-up in series order (2px surface gap between fills).
 */
export function TimeChart({ title, data, series, stacked = false, height = 190, format = (v) => String(Math.round(v)), empty }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const ready = data.length >= 2 && width > 0;

  const geo = useMemo(() => {
    if (!ready) return null;
    const t0 = data[0].t;
    const t1 = data[data.length - 1].t;
    const innerW = width - PAD.l - PAD.r;
    const innerH = height - PAD.t - PAD.b;
    const tops = data.map((d) =>
      stacked ? series.reduce((sum, s) => sum + d[s.key], 0) : Math.max(...series.map((s) => d[s.key])),
    );
    const max = niceMax(Math.max(1, ...tops));
    const x = (t) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * innerW;
    const y = (v) => PAD.t + innerH - (v / max) * innerH;
    const layers = series.map((s, i) => {
      const lower = data.map((d) => (stacked ? series.slice(0, i).reduce((sum, k) => sum + d[k.key], 0) : 0));
      const upper = data.map((d, j) => (stacked ? lower[j] + d[s.key] : d[s.key]));
      const top = data.map((d, j) => [x(d.t), y(upper[j])]);
      const bottom = data.map((d, j) => [x(d.t), y(lower[j])]).reverse();
      return { ...s, upper, top, area: `${linePath(top)}L${bottom.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')}Z` };
    });
    return { x, y, max, layers, innerW, innerH };
  }, [ready, data, series, stacked, width, height]);

  function pick(clientX, rect) {
    const px = clientX - rect.left;
    let best = 0;
    for (let i = 1; i < data.length; i++) {
      if (Math.abs(geo.x(data[i].t) - px) < Math.abs(geo.x(data[best].t) - px)) best = i;
    }
    setHover(best);
  }

  function onKey(e) {
    if (!geo) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.key === 'ArrowLeft' ? -1 : 1;
      setHover((h) => Math.max(0, Math.min(data.length - 1, (h ?? data.length - 1) + step)));
    } else if (e.key === 'Escape') {
      setHover(null);
    }
  }

  const last = data[data.length - 1];
  const h = hover !== null && geo ? hover : null;

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        {series.length > 1 ? (
          <ul className="legend">
            {series.map((s) => (
              <li key={s.key}>
                <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.label}
                {last && <strong>{format(last[s.key])}</strong>}
              </li>
            ))}
          </ul>
        ) : (
          last && <strong className="chart-now">{format(last[series[0].key])}</strong>
        )}
      </figcaption>

      <div ref={ref} className="chart-plot" style={{ height }}>
        {!ready && <p className="muted chart-empty">{empty || 'Collecting data…'}</p>}
        {geo && (
          <svg
            width={width}
            height={height}
            role="img"
            tabIndex={0}
            aria-label={`${title}. Use left and right arrow keys to read values.`}
            onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setHover(null)}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
          >
            {[0, 0.5, 1].map((f) => (
              <g key={f} className="grid">
                <line x1={PAD.l} x2={width - PAD.r} y1={geo.y(geo.max * f)} y2={geo.y(geo.max * f)} />
                <text x={PAD.l - 6} y={geo.y(geo.max * f) + 4} textAnchor="end">
                  {format(geo.max * f)}
                </text>
              </g>
            ))}
            {geo.layers.map((l) =>
              stacked ? (
                <path key={l.key} d={l.area} fill={l.color} stroke="var(--chart-surface)" strokeWidth="2" strokeLinejoin="round" />
              ) : (
                <g key={l.key}>
                  <path d={l.area} fill={l.color} opacity="0.12" />
                  <path d={linePath(l.top)} fill="none" stroke={l.color} strokeWidth="2" strokeLinejoin="round" />
                </g>
              ),
            )}
            <text className="axis" x={PAD.l} y={height - 6}>{clock(data[0].t)}</text>
            <text className="axis" x={width - PAD.r} y={height - 6} textAnchor="end">{clock(last.t)}</text>
            {h !== null && (
              <g className="crosshair">
                <line x1={geo.x(data[h].t)} x2={geo.x(data[h].t)} y1={PAD.t} y2={height - PAD.b} />
                {geo.layers.map((l) => (
                  <circle key={l.key} cx={geo.x(data[h].t)} cy={geo.y(l.upper[h])} r="5" fill={l.color} stroke="var(--chart-surface)" strokeWidth="2" />
                ))}
              </g>
            )}
          </svg>
        )}
        {h !== null && (
          <div
            className="tooltip"
            style={{ left: Math.min(Math.max(geo.x(data[h].t), 70), width - 70) }}
            role="status"
          >
            <span className="muted">{clock(data[h].t)}</span>
            {series.map((s) => (
              <span key={s.key}>
                <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.label} <strong>{format(data[h][s.key])}</strong>
              </span>
            ))}
          </div>
        )}
      </div>

      {data.length > 0 && (
        <details className="chart-table">
          <summary>Data table</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">Time</th>
                {series.map((s) => (
                  <th key={s.key} scope="col">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.slice(-12).reverse().map((d) => (
                <tr key={d.t}>
                  <td>{clock(d.t)}</td>
                  {series.map((s) => (
                    <td key={s.key}>{format(d[s.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}

// Horizontal bars with the value always printed (some hues are under 3:1 on white).
export function BarList({ items, emptyText = 'Nothing yet.' }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.every((i) => i.value === 0)) return <p className="muted">{emptyText}</p>;
  return (
    <ul className="barlist">
      {items.map((i) => (
        <li key={i.key} title={`${i.label}: ${i.value}`}>
          <span className="barlist-label">{i.label}</span>
          <span className="barlist-track" aria-hidden="true">
            <span className="barlist-bar" style={{ width: `${(i.value / max) * 100}%`, background: i.color }} />
          </span>
          <strong className="barlist-value">{i.value}</strong>
        </li>
      ))}
    </ul>
  );
}
