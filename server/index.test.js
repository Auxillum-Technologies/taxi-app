import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the real server as a child process, the way a phone and the owner dashboard reach it.

const SERVER = fileURLToPath(new URL('./index.js', import.meta.url));
let dir;
let server;
let base;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'taxi-server-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), SIM_COUNT: '5', INGEST_TOKEN: 'test', OWNER_PASSWORD: 'test-owner-pass', DATA_FILE: join(dir, 'desk.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
    server.stdout.on('data', (b) => String(b).includes('taxi monitor API') && resolve());
  });
});

// Waits for the server to exit so it stops writing desk.json before the folder is deleted.
function stopServer(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

after(async () => {
  await stopServer(server);
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function signIn() {
  const owner = (await call('POST', '/api/owner/login', null, { password: 'test-owner-pass' })).body.token;
  const driver = (await call('POST', '/api/driver/login', null, { name: 'alai01', pin: '1215' })).body.token;
  assert.ok(owner && driver, 'owner and driver sign in');
  return { owner, driver };
}

test('driver pings do not add points to the 30-minute dashboard series', async () => {
  const { owner, driver } = await signIn();
  const before = (await call('GET', '/api/stats', owner)).body.series.length;
  for (let i = 0; i < 130; i++) {
    const r = await call('POST', '/api/driver/ping', driver, { lat: 7.07 + i * 1e-5, lng: 125.61, speed: 20, heading: 0 });
    assert.equal(r.status, 202);
  }
  const { series } = (await call('GET', '/api/stats', owner)).body;
  // Points come only from the 15 s sampler; the pings above take well under 15 s.
  assert.ok(series.length <= before + 1, `series grew from ${before} to ${series.length} points`);
});

test("the driver's own live row comes back from /api/driver/me", async () => {
  const { driver } = await signIn();
  await call('POST', '/api/driver/ping', driver, { lat: 7.08, lng: 125.62, speed: 30, heading: 90, onTrip: true });
  await call('POST', '/api/driver/ping', driver, { lat: 7.081, lng: 125.62, speed: 30, heading: 90, onTrip: true });
  const { status, body } = await call('GET', '/api/driver/me', driver);
  assert.equal(status, 200);
  assert.equal(body.driver.taxiId, 'ALAI-01');
  assert.equal(body.live.status, 'on_trip');
  assert.equal(body.live.speed, 30);
  assert.ok(body.live.distanceKm > 0, `distance ${body.live.distanceKm}`);
  assert.equal(body.live.historyMinutes, 30);
});
