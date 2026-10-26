import { StrictMode, Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import SignIn from './SignIn.jsx';
import { api } from './useLiveFleet.js';
import { OWNER_TOKEN, readToken, writeToken } from './session.js';
import './styles.css';

// The console (MapLibre and three.js) loads only after the owner signs in,
// so the sign-in screen stays light on a driver's phone.
const App = lazy(() => import('./App.jsx'));

function Root() {
  const [token, setToken] = useState(readToken(OWNER_TOKEN));
  const [checked, setChecked] = useState(!token); // a saved token is checked before the console opens
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (checked) return;
    api('/api/owner/me', { token })
      .then((res) => {
        if (res.status === 401) {
          writeToken(OWNER_TOKEN, '');
          setToken('');
          setNotice('Your sign-in ended. Sign in again.');
        }
      })
      .catch(() => {}) // offline: open the console; its live feed shows the reconnecting state
      .finally(() => setChecked(true));
  }, [checked, token]);

  const signIn = useCallback((t) => {
    writeToken(OWNER_TOKEN, t);
    setNotice('');
    setToken(t);
  }, []);

  const signOut = useCallback(
    (reason = 'expired') => {
      if (reason === 'manual') api('/api/owner/logout', { method: 'POST', token }).catch(() => {});
      writeToken(OWNER_TOKEN, '');
      setToken('');
      setNotice(reason === 'manual' ? 'Signed out.' : 'Your sign-in ended. Sign in again.');
    },
    [token],
  );

  if (!checked) return <p className="boot muted" role="status">Checking your sign-in…</p>;
  if (!token) return <SignIn onOwnerToken={signIn} notice={notice} />;
  return (
    <Suspense fallback={<p className="boot muted" role="status">Loading the fleet console…</p>}>
      <App token={token} onSignOut={signOut} />
    </Suspense>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
