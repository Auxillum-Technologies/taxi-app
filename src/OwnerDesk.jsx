import { useCallback, useEffect, useState } from 'react';
import { api } from './useLiveFleet.js';
import { REPORT_LABEL, REPORT_STATUS_LABEL, ago } from './labels.js';
import { Icon } from './icons.jsx';
import { sentence } from './SignIn.jsx';

const EMPTY = { drivers: [], reports: [] };
const FALLBACK_POLL_MS = 60_000; // the live socket's deskVersion normally triggers refreshes

// Owner desk: driver accounts and driver reports. Opens over the map; the console's sign-in covers it.
export default function OwnerDesk({ onClose, deskVersion, token, onSignOut }) {
  const [data, setData] = useState(EMPTY);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const [d, r] = await Promise.all([api('/api/owner/drivers', { token }), api('/api/owner/reports', { token })]);
    if (d.status === 401 || r.status === 401) return onSignOut();
    if (!d.ok || !r.ok) return setError('Could not load the desk. Retrying…');
    setError('');
    setData({ drivers: d.data.drivers, reports: r.data.reports });
  }, [token, onSignOut]);

  useEffect(() => {
    const id = setInterval(() => refresh().catch(() => setError('Could not reach the server. Retrying…')), FALLBACK_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Refetch as soon as the server says desk data changed.
  useEffect(() => {
    refresh().catch(() => setError('Could not reach the server. Retrying…'));
  }, [refresh, deskVersion]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="desk-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="panel desk" role="dialog" aria-modal="true" aria-labelledby="desk-title">
        <div className="card-head">
          <h2 id="desk-title" className="desk-title">Owner desk</h2>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {error && <p className="alert-text small" role="status">{error}</p>}
        <DriversSection drivers={data.drivers} token={token} onChanged={refresh} />
        <ReportsSection reports={data.reports} token={token} onChanged={refresh} />
      </section>
    </div>
  );
}

const TAXI_FIELDS = [
  { key: 'plate', label: 'Plate number', max: 16, placeholder: 'LAB 1234' },
  { key: 'model', label: 'Make and model', max: 40, placeholder: 'Toyota Vios' },
  { key: 'bodyNumber', label: 'Body number', max: 16, placeholder: '042' },
  { key: 'franchiseNo', label: 'Franchise / permit no.', max: 40, placeholder: 'CPC-2019-0042' },
];
const EMPTY_TAXI = { plate: '', model: '', bodyNumber: '', franchiseNo: '', franchiseExpiry: '' };
const EMPTY_DRIVER = { name: '', taxiId: '', pin: '', taxi: EMPTY_TAXI };

// Days until a YYYY-MM-DD date (negative once it has passed), counted in local days.
function daysUntil(date, now = new Date()) {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d) - today) / 86_400_000);
}

function FranchiseBadge({ date }) {
  const days = daysUntil(date);
  if (days === null) return null;
  if (days < 0) return <span className="badge bad">Franchise expired</span>;
  if (days <= 30) return <span className="badge warn">{`Franchise expires in ${days} day${days === 1 ? '' : 's'}`}</span>;
  return null;
}

function DriversSection({ drivers, token, onChanged }) {
  const [editing, setEditing] = useState(null); // driver id, 'new', or null
  const [note, setNote] = useState('');
  const [confirmId, setConfirmId] = useState(null);

  // Removing takes two presses so a stray tap cannot delete an account.
  async function remove(d) {
    if (confirmId !== d.id) return setConfirmId(d.id);
    const res = await api(`/api/owner/drivers/${d.id}`, { method: 'DELETE', token }).catch(() => null);
    setConfirmId(null);
    setNote(res?.ok ? `${d.name} removed.` : 'Could not remove the driver.');
    onChanged();
  }

  return (
    <section className="desk-section" aria-labelledby="desk-drivers">
      <div className="row-between">
        <h3 id="desk-drivers">Drivers ({drivers.length})</h3>
        {editing !== 'new' && (
          <button type="button" className="chip" onClick={() => setEditing('new')}>
            Add driver
          </button>
        )}
      </div>
      <p className="muted small">A driver signs in with their name exactly as entered here, and their PIN.</p>
      {editing === 'new' && (
        <DriverForm
          token={token}
          onDone={(msg) => {
            setEditing(null);
            if (msg) setNote(msg);
            onChanged();
          }}
        />
      )}
      {drivers.length === 0 && editing !== 'new' && <p className="muted">No drivers yet. Add one to give them a sign-in.</p>}
      <ul className="desk-list">
        {drivers.map((d) =>
          editing === d.id ? (
            <li key={d.id} className="desk-item">
              <DriverForm
                token={token}
                driver={d}
                onDone={(msg) => {
                  setEditing(null);
                  if (msg) setNote(msg);
                  onChanged();
                }}
              />
            </li>
          ) : (
            <li key={d.id} className="desk-item driver-row">
              <div>
                <p>
                  <strong>{d.name}</strong>
                  <span className="muted">{` · taxi ${d.taxiId}`}</span>
                </p>
                <p className="muted small">
                  {[d.taxi.plate, d.taxi.model, d.taxi.bodyNumber && `body ${d.taxi.bodyNumber}`].filter(Boolean).join(' · ') || 'No taxi details yet'}
                </p>
                <p className="badges">
                  {!d.hasPin && <span className="badge bad">No PIN: cannot sign in</span>}
                  <FranchiseBadge date={d.taxi.franchiseExpiry} />
                </p>
              </div>
              <div className="btn-row">
                <button type="button" className="chip" onClick={() => setEditing(d.id)}>
                  <Icon name="edit" size={18} />
                  Edit
                </button>
                <button type="button" className="chip" onClick={() => remove(d)}>
                  {confirmId === d.id ? 'Confirm remove' : 'Remove'}
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
      <p className="muted small" role="status">{note}</p>
    </section>
  );
}

// Add (no `driver`) or edit. When editing, a blank PIN keeps the current one.
function DriverForm({ token, driver, onDone }) {
  const [form, setForm] = useState(() =>
    driver ? { name: driver.name, taxiId: driver.taxiId, pin: '', taxi: { ...EMPTY_TAXI, ...driver.taxi } } : EMPTY_DRIVER,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = driver?.id ?? 'new';
  const field = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const taxiField = (key) => (e) => setForm((f) => ({ ...f, taxi: { ...f.taxi, [key]: e.target.value } }));

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = driver && !form.pin ? { name: form.name, taxiId: form.taxiId, taxi: form.taxi } : form;
    const res = await api(driver ? `/api/owner/drivers/${driver.id}` : '/api/owner/drivers', {
      method: driver ? 'PATCH' : 'POST',
      token,
      body,
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(sentence(res?.data?.error) || 'Could not save. Check the connection.');
    const saved = res.data.driver;
    if (!driver) return onDone(`Added ${saved.name}. They sign in as “${saved.name}” with the PIN you set.`);
    return onDone(form.pin ? `Saved. ${saved.name}'s PIN changed; they were signed out.` : `Saved ${saved.name}.`);
  }

  return (
    <form onSubmit={save} className="desk-form driver-form" aria-label={driver ? `Edit ${driver.name}` : 'Add a driver'}>
      <fieldset>
        <legend>Driver</legend>
        <label htmlFor={`${id}-name`}>Full name (used to sign in)</label>
        <input id={`${id}-name`} value={form.name} onChange={field('name')} maxLength={60} autoComplete="off" autoFocus required />
        <label htmlFor={`${id}-pin`}>{driver ? 'New PIN (leave blank to keep)' : 'PIN (4 to 6 digits)'}</label>
        <input
          id={`${id}-pin`}
          value={form.pin}
          onChange={field('pin')}
          inputMode="numeric"
          pattern="[0-9]{4,6}"
          minLength={4}
          maxLength={6}
          autoComplete="new-password"
          required={!driver}
          aria-describedby={`${id}-pin-hint`}
        />
        <p id={`${id}-pin-hint`} className="hint">
          Use 6 digits where you can; it is much harder to guess. Tell the driver in person.
        </p>
      </fieldset>
      <fieldset>
        <legend>Taxi</legend>
        <label htmlFor={`${id}-taxi`}>Taxi ID (matches its GPS tracker)</label>
        <input id={`${id}-taxi`} value={form.taxiId} onChange={field('taxiId')} maxLength={64} autoComplete="off" required />
        <div className="field-grid">
          {TAXI_FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
              <input
                id={`${id}-${f.key}`}
                value={form.taxi[f.key]}
                onChange={taxiField(f.key)}
                maxLength={f.max}
                placeholder={f.placeholder}
                autoComplete="off"
              />
            </div>
          ))}
          <div>
            <label htmlFor={`${id}-expiry`}>Franchise expiry</label>
            <input id={`${id}-expiry`} type="date" value={form.taxi.franchiseExpiry} onChange={taxiField('franchiseExpiry')} />
          </div>
        </div>
      </fieldset>
      <div className="btn-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : driver ? 'Save changes' : 'Add driver'}
        </button>
        <button type="button" className="ghost" onClick={() => onDone('')}>
          Cancel
        </button>
      </div>
      <p className="alert-text small" role="alert">
        {error}
      </p>
    </form>
  );
}

function ReportsSection({ reports, token, onChanged }) {
  const open = reports.filter((r) => r.status !== 'resolved').length;
  const [note, setNote] = useState('');

  async function setStatus(id, status) {
    const res = await api(`/api/owner/reports/${id}`, { method: 'PATCH', token, body: { status } }).catch(() => null);
    setNote(res?.ok ? '' : 'Could not update that report.');
    onChanged();
  }

  return (
    <section className="desk-section" aria-labelledby="desk-reports">
      <h3 id="desk-reports">Reports ({open} open)</h3>
      {reports.length === 0 && <p className="muted">No driver reports yet.</p>}
      <ul className="desk-list">
        {reports.slice(0, 50).map((r) => (
          <li key={r.id} className="desk-item">
            <p>
              <strong className={r.type === 'rescue' ? 'alert-text' : ''}>{REPORT_LABEL[r.type]}</strong>
              {` · taxi ${r.taxiId} · ${r.driverName}`}
            </p>
            <p className="muted small">
              {ago(r.at)} · {REPORT_STATUS_LABEL[r.status]}
            </p>
            {r.text && <p>{r.text}</p>}
            {r.status !== 'resolved' && (
              <div className="btn-row">
                {r.status === 'open' && (
                  <button type="button" className="chip" onClick={() => setStatus(r.id, 'acknowledged')}>
                    Acknowledge
                  </button>
                )}
                <button type="button" className="chip" onClick={() => setStatus(r.id, 'resolved')}>
                  Resolve
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {note && <p className="alert-text small" role="status">{note}</p>}
    </section>
  );
}
