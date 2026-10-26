// Sign-in tokens. The owner's lasts for this browser tab (sessionStorage); the driver's
// survives a phone restart (localStorage), because drivers keep the page open all shift.
export const OWNER_TOKEN = 'taxi.ownerToken';
export const DRIVER_TOKEN = 'taxi.driverToken';

function store(key) {
  return key === OWNER_TOKEN ? sessionStorage : localStorage;
}

export function readToken(key) {
  try {
    return store(key).getItem(key) || '';
  } catch {
    return ''; // storage blocked: the sign-in lasts only while this page stays open
  }
}

export function writeToken(key, token) {
  try {
    if (token) store(key).setItem(key, token);
    else store(key).removeItem(key);
  } catch {
    /* ignore: see readToken */
  }
}
