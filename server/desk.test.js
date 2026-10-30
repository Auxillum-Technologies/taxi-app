import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesk, hashPassword, verifyPassword, DESK_LIMITS } from './desk.js';

// A clock the tests can move forward by hand.
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms) };
}

async function newDesk(opts = {}) {
  const desk = createDesk({ now: opts.now ?? Date.now, ...opts });
  await desk.setOwnerPassword('owner-secret-1');
  return desk;
}

async function addDriver(desk, overrides = {}) {
  const r = await desk.addDriver({
    name: 'Juan Dela Cruz',
    taxiId: 'TX-042',
    pin: '482913',
    taxi: { plate: 'LAB 1234', model: 'Toyota Vios', bodyNumber: '042', franchiseNo: 'CPC-2019-0042', franchiseExpiry: '2027-03-31' },
    ...overrides,
  });
  assert.equal(r.ok, true, r.error);
  return r.value;
}

test('password hash verifies the right password and rejects others', async () => {
  const stored = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
});

test('addDriver validates fields and rejects duplicates', async () => {
  const desk = await newDesk();
  assert.equal((await desk.addDriver({ name: '', taxiId: 'TX-1', pin: '1234' })).ok, false);
  assert.equal((await desk.addDriver({ name: 'A', taxiId: 'TX 1', pin: '1234' })).ok, false);
  assert.equal((await desk.addDriver({ name: 'A', taxiId: 'TX-1', pin: '123' })).ok, false, 'PIN too short');
  assert.equal((await desk.addDriver({ name: 'A', taxiId: 'TX-1', pin: '1234567' })).ok, false, 'PIN too long');
  assert.equal((await desk.addDriver({ name: 'A', taxiId: 'TX-1', pin: '12a4' })).ok, false, 'PIN digits only');
  assert.equal((await desk.addDriver({ name: 'A', taxiId: 'TX-1', pin: 1234 })).ok, false, 'PIN must be a string');
  assert.equal((await desk.addDriver({ name: 'A', taxiId: 'TX-1', pin: '1234', taxi: { plate: 'x'.repeat(17) } })).ok, false);
  assert.equal((await desk.addDriver({ name: 'A', taxiId: 'TX-1', pin: '1234', taxi: { franchiseExpiry: '31/03/2027' } })).ok, false);

  await addDriver(desk);
  // The name is the sign-in, so it must be unique whatever its case or spacing.
  const dupName = await desk.addDriver({ name: '  juan   DELA cruz ', taxiId: 'TX-100', pin: '1234' });
  assert.equal(dupName.status, 409);
  const dupTaxi = await desk.addDriver({ name: 'Maria Santos', taxiId: 'TX-042', pin: '1234' });
  assert.equal(dupTaxi.status, 409);
});

test('listed drivers carry taxi details but never the PIN hash', async () => {
  const desk = await newDesk();
  await addDriver(desk);
  const [d] = desk.listDrivers();
  assert.equal('pinHash' in d, false);
  assert.equal(d.hasPin, true);
  assert.equal(d.taxi.plate, 'LAB 1234');
  assert.equal(d.taxi.franchiseExpiry, '2027-03-31');
});

test('driver signs in with the registered name and PIN; case and spacing do not matter', async () => {
  const desk = await newDesk();
  const d = await addDriver(desk);

  const bad = await desk.driverLogin({ name: 'Juan Dela Cruz', pin: '000000', key: 'ip1' });
  assert.equal(bad.status, 401);
  assert.equal((await desk.driverLogin({ name: 'Juan', pin: '482913', key: 'ip1' })).status, 401, 'partial name');
  assert.equal((await desk.driverLogin({ name: 'Nobody', pin: '482913', key: 'ip1' })).error, bad.error, 'same message for unknown names');

  const good = await desk.driverLogin({ name: '  juan  dela CRUZ ', pin: '482913', key: 'ip1' });
  assert.equal(good.ok, true);
  assert.equal(good.value.driver.taxiId, 'TX-042');
  assert.equal(desk.driverFor(good.value.token).id, d.id);

  desk.removeDriver(d.id);
  assert.equal(desk.driverFor(good.value.token), null);
});

test('wrong PINs lock that name even across addresses', async () => {
  const c = clock();
  const desk = await newDesk({ now: c.now });
  await addDriver(desk);
  for (let i = 0; i < DESK_LIMITS.nameMaxFailures; i++) {
    await desk.driverLogin({ name: 'Juan Dela Cruz', pin: String(1000 + i), key: `ip${i}` });
  }
  const locked = await desk.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'fresh-ip' });
  assert.equal(locked.status, 429);
  c.tick(DESK_LIMITS.loginWindowMs + 1);
  assert.equal((await desk.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'fresh-ip' })).ok, true);
});

test('updateDriver edits details, keeps names unique, and a PIN reset ends sessions', async () => {
  const desk = await newDesk();
  const juan = await addDriver(desk);
  await addDriver(desk, { name: 'Maria Santos', taxiId: 'TX-077', pin: '1234' });
  const session = await desk.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'k' });

  const edited = await desk.updateDriver(juan.id, { taxi: { plate: 'NBC 5678' } });
  assert.equal(edited.ok, true);
  assert.equal(edited.value.taxi.plate, 'NBC 5678');
  assert.equal(edited.value.taxi.model, 'Toyota Vios', 'fields left out keep their value');
  assert.ok(desk.driverFor(session.value.token), 'detail edits keep the driver signed in');

  assert.equal((await desk.updateDriver(juan.id, { name: 'maria santos' })).status, 409);
  assert.equal((await desk.updateDriver(juan.id, { pin: '12' })).ok, false);
  assert.equal((await desk.updateDriver('missing', { pin: '1234' })).status, 404);

  assert.equal((await desk.updateDriver(juan.id, { pin: '7777' })).ok, true);
  assert.equal(desk.driverFor(session.value.token), null, 'PIN reset signs the driver out');
  assert.equal((await desk.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'k' })).ok, false);
  assert.equal((await desk.driverLogin({ name: 'Juan Dela Cruz', pin: '7777', key: 'k' })).ok, true);
});

test('a driver saved before PIN sign-in cannot sign in until the owner sets a PIN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-legacy-'));
  const file = join(dir, 'desk.json');
  try {
    const legacy = { id: 'old-1', name: 'Pedro Reyes', username: 'pedro', taxiId: 'TX-009', passwordHash: await hashPassword('old-password'), createdAt: 1 };
    writeFileSync(file, JSON.stringify({ version: 1, drivers: [legacy], messages: [], reports: [] }));
    const desk = await newDesk({ file });
    const [d] = desk.listDrivers();
    assert.equal(d.hasPin, false);
    assert.equal(d.taxi.plate, '');
    assert.equal((await desk.driverLogin({ name: 'Pedro Reyes', pin: '1234', key: 'k' })).ok, false);
    assert.equal((await desk.updateDriver('old-1', { pin: '2468' })).ok, true);
    assert.equal((await desk.driverLogin({ name: 'Pedro Reyes', pin: '2468', key: 'k' })).ok, true);
    desk.flush();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('owner token cannot act as a driver, and the reverse', async () => {
  const desk = await newDesk();
  await addDriver(desk);
  const owner = await desk.ownerLogin({ password: 'owner-secret-1', key: 'ip1' });
  const driver = await desk.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'ip1' });
  assert.ok(desk.sessionFor(owner.value.token, 'owner'));
  assert.equal(desk.sessionFor(owner.value.token, 'driver'), null);
  assert.equal(desk.driverFor(owner.value.token), null);
  assert.equal(desk.sessionFor(driver.value.token, 'owner'), null);
});

test('repeated wrong passwords from one address are throttled', async () => {
  const c = clock();
  const desk = await newDesk({ now: c.now });
  for (let i = 0; i < DESK_LIMITS.loginMaxFailures; i++) {
    await desk.ownerLogin({ password: 'wrong-guess-x', key: 'attacker' });
  }
  const blocked = await desk.ownerLogin({ password: 'owner-secret-1', key: 'attacker' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.retryAfter, DESK_LIMITS.loginWindowMs / 1000);
  c.tick(60_000);
  const later = await desk.ownerLogin({ password: 'owner-secret-1', key: 'attacker' });
  assert.equal(later.retryAfter, DESK_LIMITS.loginWindowMs / 1000 - 60);
  // Another address is unaffected.
  assert.equal((await desk.ownerLogin({ password: 'owner-secret-1', key: 'office' })).ok, true);
  // The window expires.
  c.tick(DESK_LIMITS.loginWindowMs + 1);
  assert.equal((await desk.ownerLogin({ password: 'owner-secret-1', key: 'attacker' })).ok, true);
});

test('messages reach the named driver or everyone, and read state is per driver', async () => {
  const desk = await newDesk();
  const juan = await addDriver(desk);
  const maria = await addDriver(desk, { name: 'Maria', taxiId: 'TX-077' });

  const one = desk.sendMessage({ to: juan.id, text: 'Go to the airport rank' });
  const all = desk.sendMessage({ to: 'all', text: 'Heavy rain on the highway' });
  assert.equal(one.ok && all.ok, true);

  assert.deepEqual(desk.inboxFor(juan.id).map((m) => m.text), ['Heavy rain on the highway', 'Go to the airport rank']);
  assert.deepEqual(desk.inboxFor(maria.id).map((m) => m.text), ['Heavy rain on the highway']);

  desk.markRead(juan.id, all.value.id);
  assert.equal(desk.inboxFor(juan.id)[0].read, true);
  assert.equal(desk.inboxFor(maria.id)[0].read, false);

  // A driver cannot mark someone else's direct message as read.
  assert.equal(desk.markRead(maria.id, one.value.id), false);
});

test('sendMessage rejects unknown recipients and empty text', async () => {
  const desk = await newDesk();
  assert.equal(desk.sendMessage({ to: 'nobody', text: 'hi' }).ok, false);
  assert.equal(desk.sendMessage({ to: 'all', text: '   ' }).ok, false);
  assert.equal(desk.sendMessage({ to: 'all', text: 'x'.repeat(DESK_LIMITS.maxMessageLen + 1) }).ok, false);
});

test('reports need a known type, a location, and a note for "other"', async () => {
  const desk = await newDesk();
  const d = await addDriver(desk);
  assert.equal(desk.addReport(d, { type: 'fire', lat: 7, lng: 125 }).ok, false);
  assert.equal(desk.addReport(d, { type: 'flood' }).ok, false, 'no location and no fallback');
  assert.equal(desk.addReport(d, { type: 'flood', lat: 91, lng: 125 }).ok, false);
  assert.equal(desk.addReport(d, { type: 'other', lat: 7, lng: 125 }).ok, false, 'other needs text');
});

test('a report without coordinates uses the fallback fix', async () => {
  const c = clock();
  const desk = await newDesk({ now: c.now });
  const d = await addDriver(desk);
  const r = desk.addReport(d, { type: 'road', text: 'Pothole near the bridge' }, { lat: 7.19, lng: 125.45 });
  assert.equal(r.ok, true);
  assert.equal(r.value.lat, 7.19);
  assert.equal(r.value.status, 'open');
});

test('reports are rate-limited per driver', async () => {
  const c = clock();
  const desk = await newDesk({ now: c.now });
  const d = await addDriver(desk);
  assert.equal(desk.addReport(d, { type: 'traffic', lat: 7, lng: 125 }).ok, true);
  const again = desk.addReport(d, { type: 'traffic', lat: 7, lng: 125 });
  assert.equal(again.status, 429);
  c.tick(DESK_LIMITS.reportCooldownMs);
  assert.equal(desk.addReport(d, { type: 'traffic', lat: 7, lng: 125 }).ok, true);
});

test('public reports hide driver names and resolved reports age off the map', async () => {
  const c = clock();
  const desk = await newDesk({ now: c.now });
  const d = await addDriver(desk);
  const r = desk.addReport(d, { type: 'rescue', text: 'Flat tire, passenger safe', lat: 7, lng: 125 });
  const pub = desk.publicReports();
  assert.equal(pub.length, 1);
  assert.equal('driverName' in pub[0], false);
  assert.equal(pub[0].taxiId, 'TX-042');

  desk.setReportStatus(r.value.id, 'resolved');
  assert.equal(desk.publicReports().length, 1, 'still shown briefly after resolving');
  c.tick(DESK_LIMITS.publicResolvedMs + 1);
  assert.equal(desk.publicReports().length, 0);
  assert.equal(desk.ownerReports().length, 1, 'owner keeps the record');
});

test('setReportStatus rejects bad statuses and missing reports', async () => {
  const desk = await newDesk();
  const d = await addDriver(desk);
  const r = desk.addReport(d, { type: 'flood', lat: 7, lng: 125 });
  assert.equal(desk.setReportStatus(r.value.id, 'closed').ok, false);
  assert.equal(desk.setReportStatus('missing', 'resolved').status, 404);
});

test('state survives a restart when a data file is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-test-'));
  const file = join(dir, 'desk.json');
  try {
    const first = await newDesk({ file });
    const d = await addDriver(first);
    first.sendMessage({ to: d.id, text: 'Back to base at 6' });
    first.flush();

    const second = await newDesk({ file });
    assert.equal(second.listDrivers()[0].taxi.plate, 'LAB 1234');
    assert.equal(second.inboxFor(d.id)[0].text, 'Back to base at 6');
    assert.equal((await second.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'k' })).ok, true);
    second.flush();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A deploy restarts the server; signed-in phones must keep sharing without typing the PIN again.
test('sign-ins survive a restart, and the data file keeps only token hashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-test-'));
  const file = join(dir, 'desk.json');
  try {
    const first = await newDesk({ file });
    const d = await addDriver(first);
    const owner = (await first.ownerLogin({ password: 'owner-secret-1', key: 'k' })).value.token;
    const driver = (await first.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'k' })).value.token;
    first.flush();

    const saved = readFileSync(file, 'utf8');
    assert.equal(saved.includes(owner), false, 'raw owner token is not stored');
    assert.equal(saved.includes(driver), false, 'raw driver token is not stored');

    const second = await newDesk({ file });
    assert.ok(second.sessionFor(owner, 'owner'), 'owner stays signed in');
    assert.equal(second.driverFor(driver)?.id, d.id, 'driver stays signed in');
    assert.equal(second.sessionFor(driver, 'owner'), null, 'role still checked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sign-out, PIN reset and driver removal still end sessions across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-test-'));
  const file = join(dir, 'desk.json');
  try {
    const first = await newDesk({ file });
    const juan = await addDriver(first);
    const maria = await addDriver(first, { name: 'Maria Santos', taxiId: 'TX-043', pin: '1234' });
    const pedro = await addDriver(first, { name: 'Pedro Reyes', taxiId: 'TX-044', pin: '5678' });
    const owner = (await first.ownerLogin({ password: 'owner-secret-1', key: 'k' })).value.token;
    const juanToken = (await first.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'k' })).value.token;
    const mariaToken = (await first.driverLogin({ name: 'Maria Santos', pin: '1234', key: 'k' })).value.token;
    const pedroToken = (await first.driverLogin({ name: 'Pedro Reyes', pin: '5678', key: 'k' })).value.token;
    first.closeSession(owner);
    await first.updateDriver(juan.id, { pin: '111111' });
    first.removeDriver(maria.id);
    first.flush();

    const second = await newDesk({ file });
    assert.equal(second.sessionFor(owner, 'owner'), null, 'signed-out owner');
    assert.equal(second.driverFor(juanToken), null, 'PIN reset');
    assert.equal(second.driverFor(mariaToken), null, 'removed driver');
    assert.equal(second.driverFor(pedroToken)?.id, pedro.id, 'untouched driver keeps the sign-in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expired sessions are pruned from the data file and do not come back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-test-'));
  const file = join(dir, 'desk.json');
  const c = clock();
  try {
    const first = await newDesk({ file, now: c.now });
    await addDriver(first);
    const old = (await first.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'k' })).value.token;
    c.tick(DESK_LIMITS.sessionMs - 1000);
    const fresh = (await first.ownerLogin({ password: 'owner-secret-1', key: 'k' })).value.token;
    c.tick(2000); // `old` is now past its expiry, `fresh` is not
    first.flush();

    assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 1, 'only the live session is saved');
    const second = await newDesk({ file, now: c.now });
    assert.equal(second.driverFor(old), null);
    assert.ok(second.sessionFor(fresh, 'owner'));
    c.tick(DESK_LIMITS.sessionMs);
    assert.equal(second.sessionFor(fresh, 'owner'), null, 'restored sessions still expire');
    second.flush();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new owner password ends owner sessions saved before the restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-test-'));
  const file = join(dir, 'desk.json');
  try {
    const first = await newDesk({ file });
    const owner = (await first.ownerLogin({ password: 'owner-secret-1', key: 'k' })).value.token;
    first.flush();

    const same = await newDesk({ file });
    assert.ok(same.sessionFor(owner, 'owner'), 'same password keeps the sign-in');
    same.flush();

    const changed = createDesk({ file });
    await changed.setOwnerPassword('owner-secret-2');
    assert.equal(changed.sessionFor(owner, 'owner'), null);
    changed.flush();
    const after = createDesk({ file });
    await after.setOwnerPassword('owner-secret-2');
    assert.equal(after.sessionFor(owner, 'owner'), null, 'revocation is saved');
    after.flush();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a driver session the server ends stops that taxi sharing; the move to a new taxi stops the old one', async () => {
  const c = clock();
  const off = [];
  const desk = await newDesk({ now: c.now, onDriverOff: (taxiId) => off.push(taxiId) });
  const juan = await addDriver(desk);
  const maria = await addDriver(desk, { name: 'Maria Santos', taxiId: 'TX-077', pin: '1234' });
  const signIn = async (name, pin) => (await desk.driverLogin({ name, pin, key: 'k' })).value.token;

  const juanToken = await signIn('Juan Dela Cruz', '482913');
  await desk.updateDriver(juan.id, { taxi: { plate: 'NBC 5678' } });
  assert.deepEqual(off, [], 'detail edits keep sharing');

  await desk.updateDriver(juan.id, { pin: '7777' });
  assert.deepEqual(off, ['TX-042'], 'PIN reset');

  off.length = 0;
  await desk.updateDriver(juan.id, { taxiId: 'TX-050' });
  assert.deepEqual(off, ['TX-042'], 'taxi change stops the old taxi');

  await signIn('Maria Santos', '1234');
  assert.equal(desk.removeDriver(maria.id), true);
  assert.equal(off.at(-1), 'TX-077', 'removal');

  const again = await signIn('Juan Dela Cruz', '7777');
  desk.closeSession(again);
  assert.equal(off.at(-1), 'TX-050', 'sign-out');

  const late = await signIn('Juan Dela Cruz', '7777');
  off.length = 0;
  c.tick(DESK_LIMITS.sessionMs + 1);
  assert.equal(desk.driverFor(late), null);
  assert.deepEqual(off, ['TX-050'], 'session expiry');
  assert.equal(desk.driverFor(juanToken), null);
});

test('a driver signed in on two phones keeps sharing until the last session ends', async () => {
  const c = clock();
  const off = [];
  const desk = await newDesk({ now: c.now, onDriverOff: (taxiId) => off.push(taxiId) });
  const juan = await addDriver(desk);
  const signIn = async () => (await desk.driverLogin({ name: 'Juan Dela Cruz', pin: '482913', key: 'k' })).value.token;

  const a = await signIn();
  c.tick(3 * 60 * 60_000);
  const b = await signIn();
  c.tick(DESK_LIMITS.sessionMs - 3 * 60 * 60_000 + 1);
  assert.equal(desk.driverFor(a), null, 'phone A expired');
  assert.ok(desk.driverFor(b), 'phone B is still signed in');
  assert.deepEqual(off, [], 'expiry of one phone keeps the taxi sharing');

  const c2 = await signIn();
  desk.closeSession(c2);
  assert.deepEqual(off, [], 'sign-out on one phone keeps the taxi sharing');

  await signIn();
  await desk.updateDriver(juan.id, { pin: '7777' });
  assert.deepEqual(off, ['TX-042'], 'a PIN reset ends every session and stops sharing once');
});
