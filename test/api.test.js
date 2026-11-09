import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {loadConfig} from '../src/config/index.js';
import {createApp} from '../src/app.js';
import {createRunner} from '../src/services/jobRunner.js';

const readCsv = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
const sparse = readCsv('./fixtures/sample-sparse-real.csv');                 // the real tracker data (point every ~18-60 s)
const asObjects = sparse.map(([a, b, c, d]) => ({latitude: +a, longitude: +b, timeStamp: c, speed: +d}));

const openServers = [];
// whatever happens in a test, never leave a server running (it would keep the process alive)
after(() => openServers.forEach(server => { server.closeAllConnections?.(); server.close(); }));

const start = async (env = {}, deps) => {
  const config = loadConfig({NODE_ENV: 'test', SERVE_TEST_PAGE: 'false', ...env});
  const server = createApp(config, deps).listen(0);
  openServers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}, url = '/api/v1/farming/analyze') =>
    fetch(base + url, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)});
  return {base, post, close: () => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); }};
};

test('health is open and reports status', async () => {
  const s = await start({NODE_ENV: 'production', API_KEYS: 'k1'});
  const r = await fetch(s.base + '/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  await s.close();
});

test('API keys: 401 without/with wrong key, 200 with X-API-Key or Bearer', async () => {
  const s = await start({API_KEYS: 'secret-one,secret-two'});
  const body = {points: asObjects};
  assert.equal((await s.post(body)).status, 401);
  assert.equal((await s.post(body, {'x-api-key': 'nope'})).status, 401);
  assert.equal((await s.post(body, {'x-api-key': 'secret-two'})).status, 200);
  assert.equal((await s.post(body, {authorization: 'Bearer secret-one'})).status, 200);
  await s.close();
});

test('production without keys is refused with 503 on the API', async () => {
  const s = await start({NODE_ENV: 'production'});
  const r = await s.post({points: asObjects});
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'NO_AUTH_CONFIGURED');
  await s.close();
});

test('validation errors are clear JSON', async () => {
  const s = await start({MAX_POINTS: '1000'});
  const few = asObjects.slice(0, 60);
  const cases = [
    [{}, 400, 'BAD_REQUEST'],
    [{points: []}, 400, 'BAD_REQUEST'],
    [{points: few, date: '02-11-2026'}, 400, 'BAD_REQUEST'],
    [{points: few, date: '2026-02-30'}, 400, 'BAD_REQUEST'],
    [{points: few, mode: 'turbo'}, 400, 'BAD_REQUEST'],
    [{points: few, farmingPercent: 150}, 400, 'BAD_REQUEST'],
    [{points: asObjects}, 413, 'TOO_MANY_POINTS'],              // 1630 points > MAX_POINTS=1000
    [{points: [{lat: 'x', lng: 'y'}, {lat: 0, lng: 0}]}, 422, 'NOT_ENOUGH_POINTS'],
  ];
  for (const [body, status, code] of cases) {
    const r = await s.post(body);
    const j = await r.json();
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 80));
    assert.equal(j.code, code);
    assert.equal(j.status, false);
  }
  assert.equal((await s.post('{ this is not json')).status, 400);
  await s.close();
});

test('unknown paths return a JSON API error', async () => {
  const s = await start();
  const r = await fetch(`${s.base}/unknown`);
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await r.json(), {status: false, code: 'NOT_FOUND', message: 'Unknown endpoint'});
  await s.close();
});

test('real sparse data: both fields detected, compact response with polygons + calculations', async () => {
  const s = await start();
  const r = await s.post({points: asObjects});
  const text = await r.text();
  const j = JSON.parse(text);
  assert.equal(r.status, 200);
  assert.equal(j.status, true);
  assert.equal(j.data.detectionMode, 'sparse');
  assert.equal(j.data.summary.areaCount, 2);
  assert.ok(Math.abs(j.data.summary.totalArea.guntha - 389.9) < 1, `guntha ${j.data.summary.totalArea.guntha}`);
  assert.ok(j.data.summary.totalArea.squareMeters > 39000 && j.data.summary.totalArea.hectares > 3.9);
  assert.ok(text.length < 60000, `response should be compact, was ${text.length} bytes`);
  for (const area of j.data.areas) {
    assert.ok(area.polygon.length >= 4);
    for (const p of area.polygon) {
      assert.ok(typeof p.latitude === 'number' && typeof p.longitude === 'number');
      assert.ok(p.latitude > 18.1 && p.latitude < 18.2 && p.longitude > 74.8 && p.longitude < 74.9);
    }
    assert.ok(area.startTime && area.endTime && area.date === '2026-11-02');
    assert.ok(area.farmingTime.seconds > 0 && area.areaByUnit.guntha > 100 && area.areaSquareMeters > 10000);
    assert.equal(area.points, undefined);
    assert.equal(area.rectangle, undefined);
  }
  assert.equal(j.data.path, undefined);
  assert.ok(j.meta.processingMs >= 0);
  await s.close();
});

test('includePoints / includePath are opt-in', async () => {
  const s = await start();
  const j = await (await s.post({points: asObjects, includePoints: true, includePath: true})).json();
  assert.ok(j.data.areas[0].points.length > 50);
  assert.ok(Array.isArray(j.data.path) && j.data.path.length > 100);
  await s.close();
});

test('accepts lat/lng aliases, [lat,lng,time,speed] arrays and epoch timestamps - same answer', async () => {
  const s = await start();
  const ref = (await (await s.post({points: asObjects})).json()).data.summary.totalArea.guntha;
  const aliases = asObjects.map(p => ({lat: String(p.latitude), lng: String(p.longitude), time: p.timeStamp, Speed: p.speed}));
  const arrays = asObjects.map(p => [p.latitude, p.longitude, p.timeStamp, p.speed]);
  const epoch = asObjects.map(p => ({latitude: p.latitude, longitude: p.longitude, timestamp: Math.floor(new Date(p.timeStamp.replace(' ', 'T')).getTime() / 1000), speed: p.speed}));
  for (const [name, points] of [['aliases', aliases], ['arrays', arrays], ['epoch', epoch]]) {
    const j = await (await s.post({points})).json();
    assert.equal(j.data.summary.areaCount, 2, name);
    assert.ok(Math.abs(j.data.summary.totalArea.guntha - ref) < 1, `${name}: ${j.data.summary.totalArea.guntha} vs ${ref}`);
  }
  await s.close();
});

test('unordered points are sorted by time (with a warning); bad points are dropped (with a warning)', async () => {
  const s = await start();
  const shuffled = [...asObjects].sort(() => Math.random() - 0.5);
  const j = await (await s.post({points: shuffled})).json();
  assert.equal(j.data.summary.areaCount, 2);
  assert.ok(Math.abs(j.data.summary.totalArea.guntha - 389.9) < 1);
  assert.ok(j.warnings.some(w => /sorted by timestamp/.test(w)));

  const dirty = [...asObjects, {latitude: 0, longitude: 0}, {latitude: 'abc', longitude: 1}, null];
  const d = await (await s.post({points: dirty})).json();
  assert.equal(d.data.summary.areaCount, 2);
  assert.ok(d.warnings.some(w => /3 point\(s\) ignored/.test(w)), JSON.stringify(d.warnings));
  await s.close();
});

test('date filter and available dates', async () => {
  const s = await start();
  const hit = await (await s.post({points: asObjects, date: '2026-11-02'})).json();
  assert.equal(hit.data.summary.areaCount, 2);
  assert.deepEqual(hit.data.availableDates.map(d => d.date), ['2026-11-02']);
  const miss = await (await s.post({points: asObjects, date: '2026-11-03'})).json();
  assert.equal(miss.data.summary.areaCount, 0);
  await s.close();
});

test('dense data still uses the original detector (single plot, 24.6 guntha)', async () => {
  const s = await start();
  const dense = readCsv('../public/sample-points.csv').map(([a, b, c, d]) => ({latitude: +a, longitude: +b, timeStamp: c, speed: +d}));
  const j = await (await s.post({points: dense})).json();
  assert.equal(j.data.detectionMode, 'dense');
  assert.equal(j.data.summary.areaCount, 1);
  assert.ok(Math.abs(j.data.summary.totalArea.guntha - 24.61) < 0.1);
  await s.close();
});

test('legacy route /api/farming/analyze still works', async () => {
  const s = await start();
  const r = await s.post({points: asObjects}, {}, '/api/farming/analyze');
  assert.equal(r.status, 200);
  await s.close();
});

test('rate limit returns 429 after the allowed number of requests', async () => {
  const s = await start({RATE_LIMIT_PER_MIN: '3'});
  const tiny = {points: asObjects.slice(0, 40)};
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.post(tiny)).status);
  assert.deepEqual(codes.slice(0, 3).every(c => c === 200 || c === 422), true);
  assert.equal(codes[4], 429);
  await s.close();
});

test('runner: times out slow jobs, refuses when busy', async () => {
  const slow = createRunner({maxConcurrent: 1, maxQueue: 0, timeoutMs: 1});
  await assert.rejects(slow.run({points: asObjects, farmingPercent: 0, date: null, mode: 'auto'}), e => e.code === 'TIMEOUT');

  const busy = createRunner({maxConcurrent: 1, maxQueue: 0, timeoutMs: 60000});
  const first = busy.run({points: asObjects, farmingPercent: 0, date: null, mode: 'auto'});
  await assert.rejects(busy.run({points: asObjects, farmingPercent: 0, date: null, mode: 'auto'}), e => e.code === 'BUSY');
  assert.equal((await first).areaCount, 2);
});

test('API maps runner timeout to 504 and busy to 503', async () => {
  const s = await start({}, {runner: createRunner({maxConcurrent: 1, maxQueue: 0, timeoutMs: 1})});
  const r = await s.post({points: asObjects});
  assert.equal(r.status, 504);
  assert.equal((await r.json()).code, 'TIMEOUT');
  await s.close();
});

test('deviceId + fromDate/toDate: loads points from the database, same response as sending them', async () => {
  const calls = [];
  const deviceData = {loadPoints: async (...args) => { calls.push(args); return asObjects; }};
  const s = await start({}, {deviceData});
  const strip = j => { delete j.meta.processingMs; return j; };
  const viaDevice = strip(await (await s.post({deviceId: 1555, fromDate: '2026-11-02', toDate: '2026-11-02 23:00', includePath: true})).json());
  const viaPoints = strip(await (await s.post({points: asObjects, includePath: true})).json());
  assert.deepEqual(viaDevice, viaPoints);
  assert.deepEqual(calls[0], [1555, '2026-11-02 00:00:00', '2026-11-02 23:00:00']);
  await s.close();
});

test('deviceId requests: validation, no data, no database, database error', async () => {
  const s = await start({}, {deviceData: {loadPoints: async () => []}});
  const cases = [
    [{deviceId: 'x', fromDate: '2026-11-02', toDate: '2026-11-02'}, 400, 'BAD_REQUEST'],
    [{deviceId: 5, fromDate: '02-11-2026', toDate: '2026-11-02'}, 400, 'BAD_REQUEST'],
    [{deviceId: 5, fromDate: '2026-11-03', toDate: '2026-11-02'}, 400, 'BAD_REQUEST'],
    [{deviceId: 5, fromDate: '2026-11-02', toDate: '2026-11-02'}, 404, 'NO_DATA'],
  ];
  for (const [body, status, code] of cases) {
    const r = await s.post(body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal((await r.json()).code, code);
  }
  await s.close();

  const noDb = await start({}, {deviceData: null});
  assert.equal((await (await noDb.post({deviceId: 5, fromDate: '2026-11-02', toDate: '2026-11-02'})).json()).code, 'DB_NOT_CONFIGURED');
  await noDb.close();

  const broken = await start({}, {deviceData: {loadPoints: async () => { throw new Error('connect ETIMEDOUT'); }}});
  const r = await broken.post({deviceId: 5, fromDate: '2026-11-02', toDate: '2026-11-02'});
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'DB_ERROR');
  await broken.close();
});
