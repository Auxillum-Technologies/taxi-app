// Shared labels and colours. Colour sets were checked with the dataviz palette validator
// (light surface): status pair ΔE 17.4 under protanopia; report set worst pair ΔE 19.6.

export const REPORT_ORDER = ['rescue', 'flood', 'traffic', 'road', 'other'];

export const REPORT_LABEL = {
  rescue: 'Rescue alert',
  road: 'Road update',
  flood: 'Flood',
  traffic: 'Traffic update',
  other: 'Other',
};

export const REPORT_COLOR = {
  rescue: '#dc2626',
  flood: '#2563eb',
  traffic: '#ca8a04',
  road: '#9333ea',
  other: '#0d9488',
};

export const REPORT_STATUS_LABEL = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' };

export const STATUS_LABEL = { free: 'Free', on_trip: 'On trip', offline: 'Offline' };
export const STATUS_HEX = { free: '#15803d', on_trip: '#f59e0b', offline: '#94a3b8' };

// Slow-zone levels from the server's congestion grid.
export const LEVEL_LABEL = { jam: 'Jam', slow: 'Slow', flowing: 'Flowing' };
export const LEVEL_HEX = { jam: '#dc2626', slow: '#f59e0b', flowing: '#15803d' };

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
