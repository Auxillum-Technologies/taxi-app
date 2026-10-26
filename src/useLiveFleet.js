import { useEffect, useState } from 'react';

// Live fleet over WebSocket. Reconnects with capped exponential backoff.
// The first frame sent is { type: 'auth', token } (owner only); close code 4401 means sign in again.
// `snapshot` frames carry positions, public reports and deskVersion; `stats` frames carry dashboard numbers.
export function useLiveFleet(token, onUnauthorized) {
  const [state, setState] = useState({ connected: false, at: 0, vehicles: [], reports: [], deskVersion: 0, stats: null });

  useEffect(() => {
    let ws = null;
    let timer = null;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
        attempt = 0;
        setState((s) => ({ ...s, connected: true }));
      };
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return; // ignore malformed frames rather than crash the view
        }
        if (msg.type === 'snapshot' && Array.isArray(msg.data?.vehicles)) {
          setState((s) => ({
            ...s,
            connected: true,
            at: msg.data.at,
            vehicles: msg.data.vehicles,
            reports: Array.isArray(msg.data.reports) ? msg.data.reports : [],
            deskVersion: Number(msg.data.deskVersion) || 0,
          }));
        } else if (msg.type === 'stats' && msg.data?.kpis) {
          setState((s) => ({ ...s, stats: msg.data }));
        }
      };
      ws.onclose = (event) => {
        setState((s) => ({ ...s, connected: false }));
        if (closed) return;
        if (event.code === 4401) {
          onUnauthorized?.();
          return;
        }
        attempt++;
        timer = setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [token, onUnauthorized]);

  return state;
}

export async function fetchJson(url, { signal, token } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { signal, headers });
  if (!res.ok) throw Object.assign(new Error(`${url} -> ${res.status}`), { status: res.status });
  return res.json();
}

// JSON request for the owner and driver endpoints. Never throws on HTTP errors; returns { ok, status, data }.
export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
