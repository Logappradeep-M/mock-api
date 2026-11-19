// CRUD, custom resources and dummyjson-style query params. Runs against the
// in-memory store by default; set TEST_MONGODB_URI to run the same tests on MongoDB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { MemoryStore, MongoStore } from '../src/store.js';
import { createOAuthClient } from './helpers.js';

const config = {
  tokenTtlSeconds: 3600, rateLimitMax: 1000, rateLimitWindowSeconds: 60,
  vmCount: 50, dataSeed: 7, maxPageSize: 200,
};

let base, app, store, CLIENT;
before(async () => {
  if (process.env.TEST_MONGODB_URI) {
    store = new MongoStore(process.env.TEST_MONGODB_URI, `mock_test_${Date.now()}`);
  } else store = new MemoryStore();
  app = await createApp(config, { log: () => {}, store });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  CLIENT = await createOAuthClient(base);
});
after(async () => {
  app.server.close();
  if (store instanceof MongoStore) await store.dropDatabase();
  await store.close();
});

// Calls without explicit headers act like the UI: record CRUD goes through the
// open management routes (/__admin/data/...), which skip credentials.
const A = { 'Content-Type': 'application/json' };
const call = async (method, path, body, headers) => {
  if (!headers) path = path.replace(/^\/api\/v1\//, '/__admin/data/');
  const res = await fetch(base + path, { method, headers: headers || A, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json(), headers: res.headers };
};
async function token(scope) {
  const r = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT.id, client_secret: CLIENT.secret, scope }),
  });
  return (await r.json()).access_token;
}

test('create a VM in the UI and read it back over OAuth', async () => {
  const vm = { vm_id: 'vm-ui-1', hostname: 'ui-made-01', ip_address: '10.9.9.9', status: 'running', guest_os: { family: 'Linux', name: 'Ubuntu' } };
  const created = await call('POST', '/api/v1/vms', vm);
  assert.equal(created.status, 201);
  assert.equal(created.body.hostname, 'ui-made-01');

  const t = await token('inventory.read');
  const got = await call('GET', '/api/v1/vms/vm-ui-1', undefined, { Authorization: `Bearer ${t}` });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, vm);

  // It is part of the delta window right away.
  const since = encodeURIComponent(new Date(Date.now() - 5000).toISOString());
  const delta = await call('GET', `/api/v1/vms?updated_since=${since}`, undefined, { Authorization: `Bearer ${t}` });
  assert.ok(delta.body.vms.some((v) => v.vm_id === 'vm-ui-1'));
});

test('duplicate id is 409, missing id is auto-generated', async () => {
  assert.equal((await call('POST', '/api/v1/vms', { vm_id: 'vm-ui-1' })).status, 409);
  const auto = await call('POST', '/api/v1/vms', { hostname: 'auto-id' });
  assert.equal(auto.status, 201);
  assert.match(auto.body.vm_id, /^vm-\d{3,}$/);
});

test('PATCH merges (null removes), PUT replaces, DELETE removes', async () => {
  let r = await call('PATCH', '/api/v1/vms/vm-ui-1', { status: 'stopped', guest_os: { version: '22.04' }, ip_address: null });
  assert.equal(r.body.status, 'stopped');
  assert.deepEqual(r.body.guest_os, { family: 'Linux', name: 'Ubuntu', version: '22.04' });
  assert.ok(!('ip_address' in r.body));

  r = await call('PUT', '/api/v1/vms/vm-ui-1', { hostname: 'replaced' });
  assert.deepEqual(r.body, { hostname: 'replaced', vm_id: 'vm-ui-1' });

  r = await call('DELETE', '/api/v1/vms/vm-ui-1');
  assert.equal(r.body.deleted, true);
  assert.equal((await call('GET', '/api/v1/vms/vm-ui-1')).status, 404);
});

test('OAuth writes need inventory.write; read token gets 403', async () => {
  const read = await token('inventory.read');
  const r = await call('POST', '/api/v1/vms', { hostname: 'x' }, { Authorization: `Bearer ${read}`, 'Content-Type': 'application/json' });
  assert.equal(r.status, 403);
  const write = await token('inventory.read inventory.write');
  const ok = await call('POST', '/api/v1/vms', { hostname: 'y' }, { Authorization: `Bearer ${write}`, 'Content-Type': 'application/json' });
  assert.equal(ok.status, 201);
});

test('custom resource: create, public access, CRUD, query params', async () => {
  let r = await call('POST', '/__admin/resources', {
    name: 'users', auth_required: false,
    records: [
      { name: 'Alice', email: 'alice@acme.com', dept: 'IT', age: 30 },
      { name: 'Bob', email: 'bob@acme.com', dept: 'HR', age: 41 },
      { name: 'Carol', email: 'carol@acme.com', dept: 'IT', age: 25 },
    ],
  });
  assert.equal(r.status, 201);

  // Public: no auth needed.
  const pub = { 'Content-Type': 'application/json' };
  r = await call('GET', '/api/v1/users', undefined, pub);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.users.map((u) => u.id), ['1', '2', '3']);
  assert.equal(r.body.total_pages, 1);

  // dummyjson style limit/skip/select/sort
  r = await call('GET', '/api/v1/users?limit=2&skip=1&select=name&sortBy=age&order=desc', undefined, pub);
  assert.deepEqual(r.body, { users: [{ id: '1', name: 'Alice' }, { id: '3', name: 'Carol' }], total: 3, skip: 1, limit: 2 });

  // field filter + search
  r = await call('GET', '/api/v1/users?dept=IT', undefined, pub);
  assert.equal(r.body.users.length, 2);
  r = await call('GET', '/api/v1/users?q=BOB', undefined, pub);
  assert.deepEqual(r.body.users.map((u) => u.name), ['Bob']);
  r = await call('GET', '/api/v1/users?age=41', undefined, pub);
  assert.deepEqual(r.body.users.map((u) => u.name), ['Bob']);

  // Public write, auto id continues
  r = await call('POST', '/api/v1/users', { name: 'Dave' }, pub);
  assert.equal(r.body.id, '4');

  // Lock it down → now needs a token
  await call('PATCH', '/__admin/resources/users', { auth_required: true });
  assert.equal((await call('GET', '/api/v1/users', undefined, pub)).status, 401);

  const list = await call('GET', '/__admin/resources');
  const users = list.body.resources.find((x) => x.name === 'users');
  assert.equal(users.count, 4);

  assert.equal((await call('DELETE', '/__admin/resources/users')).status, 200);
  assert.equal((await call('GET', '/api/v1/users', undefined, A)).status, 404);
});

test('import replace, bad names, builtin protection', async () => {
  await call('POST', '/__admin/resources', { name: 'cost_centers', id_field: 'code' });
  let r = await call('POST', '/__admin/resources/cost_centers/import', { mode: 'replace', records: [{ code: 'CC100' }, { code: 'CC200' }] });
  assert.equal(r.body.imported, 2);
  r = await call('POST', '/__admin/resources/cost_centers/import', [{ code: 'CC100' }]);
  assert.equal(r.status, 409);
  r = await call('GET', '/api/v1/cost_centers/CC200');
  assert.deepEqual(r.body, { code: 'CC200' });

  assert.equal((await call('POST', '/__admin/resources', { name: '1bad name' })).status, 400);
  assert.equal((await call('POST', '/__admin/resources', { name: 'cost_centers' })).status, 409);
  assert.equal((await call('DELETE', '/__admin/resources/vms')).status, 400);
});

test('reset restores seeded VMs', async () => {
  await call('POST', '/api/v1/vms', { vm_id: 'temp-1' });
  await call('POST', '/__admin/reset', {});
  assert.equal((await call('GET', '/api/v1/vms/temp-1')).status, 404);
  const r = await call('GET', '/api/v1/vms?limit=0');
  assert.equal(r.body.total, 50);
});
