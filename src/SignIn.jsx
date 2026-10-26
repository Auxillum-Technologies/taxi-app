import { useEffect, useRef, useState } from 'react';
import { api } from './useLiveFleet.js';
import { DRIVER_TOKEN, writeToken } from './session.js';
import { Icon } from './icons.jsx';

const ROLES = [
  { id: 'owner', label: 'Owner', icon: 'lock' },
  { id: 'driver', label: 'Driver', icon: 'person' },
];

// `?as=driver` opens on the driver form; the driver page sends signed-out drivers here.
const roleFromUrl = () => (new URLSearchParams(window.location.search).get('as') === 'driver' ? 'driver' : 'owner');

// One sign-in screen for both roles. The owner gets the fleet console; a driver goes to /driver.html.
export default function SignIn({ onOwnerToken, notice: initialNotice = '' }) {
  const [role, setRole] = useState(roleFromUrl);
  const [notice, setNotice] = useState(initialNotice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lockedUntil, setLockedUntil] = useState(0); // ms timestamp; the server sets it after too many failed sign-ins
  const [now, setNow] = useState(() => Date.now());
  const firstField = useRef(null);
  const waitSeconds = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;

  useEffect(() => {
    firstField.current?.focus();
  }, [role]);

  // Ticks once a second while locked; when the wait ends the form opens again.
  useEffect(() => {
    if (!lockedUntil) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lockedUntil) {
        setLockedUntil(0);
        setError('');
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  function lockOut(res) {
    const seconds = Number(res.data.retryAfter) || 900;
    setNow(Date.now());
    setLockedUntil(Date.now() + seconds * 1000);
    setError(sentence(res.data.error) || 'Too many failed sign-ins.');
  }

  function pick(next) {
    setRole(next);
    setError('');
    setNotice('');
    const url = new URL(window.location.href);
    if (next === 'driver') url.searchParams.set('as', 'driver');
    else url.searchParams.delete('as');
    window.history.replaceState(null, '', url);
  }

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (role === 'owner') {
        const res = await api('/api/owner/login', { method: 'POST', body: { password: form.get('password') } });
        if (res.ok) return onOwnerToken(res.data.token);
        if (res.status === 429) return lockOut(res);
        setError(res.status === 401 ? 'That password is not right.' : sentence(res.data.error) || 'Sign-in failed.');
      } else {
        const res = await api('/api/driver/login', { method: 'POST', body: { name: form.get('name'), pin: form.get('pin') } });
        if (res.ok) {
          writeToken(DRIVER_TOKEN, res.data.token);
          window.location.assign('/driver.html');
          return;
        }
        if (res.status === 429) return lockOut(res);
        setError(res.status === 401 ? 'That name and PIN do not match. Use your name exactly as the owner registered it.' : sentence(res.data.error) || 'Sign-in failed.');
      }
    } catch {
      setError('Could not reach the server. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <section className="signin-card" aria-labelledby="signin-title">
        <p className="signin-brand">
          <span className="signin-mark" aria-hidden="true" />
          Taxi fleet · Davao
        </p>
        <h1 id="signin-title">Sign in</h1>

        <div className="role-switch" role="group" aria-label="Sign in as">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={role === r.id}
              className={role === r.id ? 'role on' : 'role'}
              onClick={() => pick(r.id)}
            >
              <Icon name={r.icon} size={18} />
              {r.label}
            </button>
          ))}
        </div>

        {notice && !error && (
          <p className="signin-note" role="status">
            {notice}
          </p>
        )}

        <form key={role} className="signin-form" onSubmit={submit} noValidate={false}>
          {role === 'owner' ? (
            <>
              <p className="muted">The fleet map, dashboard and driver accounts.</p>
              <label htmlFor="owner-password">Owner password</label>
              <PasswordInput id="owner-password" name="password" inputRef={firstField} autoComplete="current-password" />
            </>
          ) : (
            <>
              <p className="muted">Your profile, your taxi, and location sharing for your shift.</p>
              <label htmlFor="driver-name">Your name</label>
              <input
                ref={firstField}
                id="driver-name"
                name="name"
                autoComplete="username"
                autoCapitalize="words"
                maxLength={60}
                required
                aria-describedby="driver-name-hint"
              />
              <p id="driver-name-hint" className="hint">
                As the owner registered it. Capital letters do not matter.
              </p>
              <label htmlFor="driver-pin">PIN</label>
              <PasswordInput
                id="driver-pin"
                name="pin"
                autoComplete="current-password"
                inputMode="numeric"
                pattern="[0-9]{4,6}"
                minLength={4}
                maxLength={6}
                describedBy="driver-pin-hint"
              />
              <p id="driver-pin-hint" className="hint">
                4 to 6 digits. Forgot it? The owner can set a new one.
              </p>
            </>
          )}

          <button type="submit" className="primary signin-submit" disabled={busy || waitSeconds > 0}>
            {busy ? 'Signing in…' : waitSeconds > 0 ? 'Wait before trying again' : role === 'owner' ? 'Open the fleet console' : 'Open my page'}
          </button>
          <p className="alert-text small signin-error" role="alert">
            {error}
          </p>
          {waitSeconds > 0 && (
            <p className="signin-countdown small" aria-live="off">
              You can try again in <time>{formatWait(waitSeconds)}</time>.
            </p>
          )}
        </form>
      </section>
    </main>
  );
}

// 754 -> "12:34". Minutes are not padded, so a 15-minute lock reads "15:00".
export function formatWait(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Server errors are lower-case fragments; show them as sentences.
export function sentence(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.') : '';
}

// Password field with a show/hide toggle, so a PIN typed on a phone can be checked before sending.
function PasswordInput({ id, name, inputRef, describedBy, ...rest }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="secret">
      <input ref={inputRef} id={id} name={name} type={shown ? 'text' : 'password'} required aria-describedby={describedBy} {...rest} />
      <button type="button" className="ghost secret-toggle" onClick={() => setShown((s) => !s)} aria-pressed={shown} aria-controls={id}>
        <Icon name={shown ? 'visibility_off' : 'visibility'} size={20} />
        <span className="sr-only">{shown ? 'Hide' : 'Show'}</span>
      </button>
    </div>
  );
}
