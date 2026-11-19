// Credentials: API keys, Basic users and OAuth clients with grants across collections.
// The management API is open to everyone. Uses MongoDB when TEST_MONGODB_URI is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { MemoryStore, MongoStore } from '../src/store.js';
import { createOAuthClient } from './helpers.js';

const config = {
  tokenTtlSeconds: 3600, rateLimitMax: 1000, rateLimitWindowSeconds: 60,
  vmCount: 20, dataSeed: 3, maxPageSize: 200,
};

let base, app, store;
before(async () => {
  store = process.env.TEST_MONGODB_URI ? new MongoStore(process.env.TEST_MONGODB_URI, `mock_test_cred_${Date.now()}`) : new MemoryStore();
  app = await createApp(config, { log: () => {}, store });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await mgmt('POST', '/__admin/resources', { name: 'users', auth_required: true, records: [{ name: 'Alice' }] });
  await mgmt('POST', '/__admin/resources', { name: 'orders', auth_required: true, records: [{ total: 10 }] });
  await mgmt('POST', '/__admin/resources', { name: 'products', auth_required: false, records: [{ title: 'Pen' }] });
});
after(async () => {
  app.server.close();
  if (store instanceof MongoStore) await store.dropDatabase();
  await store.close();
});

async function mgmt(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function call(method, path, headers = {}, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
async function token(id, secret, scope) {
  const params = { grant_type: 'client_credentials' };
  if (scope) params.scope = scope;
  const r = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...basic(id, secret) },
    body: new URLSearchParams(params),
  });
  return { status: r.status, body: await r.json() };
}

test('management API and UI data routes are open to everyone', async () => {
  const info = (await mgmt('GET', '/__admin/info')).body;
  assert.ok(!('admin_key_required' in info), 'no admin key concept');
  assert.ok(!('client_id' in info.oauth), 'no built-in OAuth client is exposed');
  const r = await mgmt('GET', '/__admin/data/users');
  assert.equal(r.status, 200);
  assert.equal(r.body.users.length, 1);
  // ...but the public API still enforces credentials on private collections.
  assert.equal((await call('GET', '/api/v1/users')).status, 401);
  assert.equal((await call('GET', '/api/v1/products')).status, 200);
});

test('API key with grants on several collections and different permissions', async () => {
  const c = await mgmt('POST', '/__admin/credentials', {
    type: 'api_key', label: 'Partner',
    grants: [{ resource: 'users', permissions: ['read', 'write'] }, { resource: 'orders', permissions: ['read'] }],
  });
  assert.equal(c.status, 201);
  const key = { 'X-API-Key': c.body.api_key };
  assert.equal((await call('GET', '/api/v1/users', key)).status, 200);
  assert.equal((await call('POST', '/api/v1/users', key, { name: 'Bob' })).status, 201);
  assert.equal((await call('GET', '/api/v1/orders', key)).status, 200);
  const denied = await call('POST', '/api/v1/orders', key, { total: 1 });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error_description, /write permission on orders/);
  assert.match((await call('GET', '/api/v1/vms', key)).body.error_description, /no access to vms/);

  // Listing never exposes the secret or its hash.
  const list = await mgmt('GET', '/__admin/credentials');
  const raw = JSON.stringify(list.body);
  assert.ok(!raw.includes(c.body.api_key));
  assert.ok(!raw.includes('key_hash'));
});

test('Basic auth user: generated or chosen username, all-collections grant', async () => {
  const c = await mgmt('POST', '/__admin/credentials', { type: 'basic', label: 'Reporting Bot', grants: [{ resource: '*', permissions: ['read'] }] });
  assert.equal(c.status, 201);
  assert.match(c.body.username, /^reporting-bot-[0-9a-f]{6}$/);
  const auth = basic(c.body.username, c.body.password);
  assert.equal((await call('GET', '/api/v1/users', auth)).status, 200);
  assert.equal((await call('GET', '/api/v1/vms', auth)).status, 200);
  assert.equal((await call('POST', '/api/v1/users', auth, {})).status, 403);
  assert.equal((await call('GET', '/api/v1/users', basic(c.body.username, 'wrong'))).status, 401);

  const named = await mgmt('POST', '/__admin/credentials', { type: 'basic', username: 'reporting-svc', grants: [{ resource: 'vms', permissions: ['read'] }] });
  assert.equal(named.body.username, 'reporting-svc');
  assert.equal((await mgmt('POST', '/__admin/credentials', { type: 'basic', username: 'reporting-svc', grants: [{ resource: 'vms', permissions: ['read'] }] })).status, 409);
});

test('OAuth client: multi-collection scopes, custom scope names, narrowing', async () => {
  const c = await mgmt('POST', '/__admin/credentials', {
    type: 'oauth_client', label: 'Sync client', token_ttl_seconds: 120,
    grants: [
      { resource: 'vms', permissions: ['read'], scope: 'inventory.read' },
      { resource: 'users', permissions: ['read', 'write'] },
    ],
  });
  assert.equal(c.status, 201);
  assert.deepEqual(c.body.scopes, ['inventory.read', 'users.read', 'users.write']);
  assert.match(c.body.client_id, /^ic_[0-9a-f]{20}$/);

  const all = await token(c.body.client_id, c.body.client_secret);
  assert.equal(all.body.expires_in, 120);
  assert.equal(all.body.scope, 'inventory.read users.read users.write');
  const bearer = { Authorization: `Bearer ${all.body.access_token}` };
  assert.equal((await call('GET', '/api/v1/vms', bearer)).status, 200);
  assert.equal((await call('POST', '/api/v1/users', bearer, { name: 'C' })).status, 201);
  assert.equal((await call('GET', '/api/v1/orders', bearer)).status, 403);

  const narrow = await token(c.body.client_id, c.body.client_secret, 'inventory.read');
  const nb = { Authorization: `Bearer ${narrow.body.access_token}` };
  assert.equal((await call('GET', '/api/v1/vms', nb)).status, 200);
  assert.equal((await call('GET', '/api/v1/users', nb)).status, 403);
  assert.equal((await token(c.body.client_id, c.body.client_secret, 'orders.read')).body.error, 'invalid_scope');
});

test('disable, expiry, edit grants, rotate and revoke take effect immediately', async () => {
  const c = (await mgmt('POST', '/__admin/credentials', { type: 'oauth_client', grants: [{ resource: 'users', permissions: ['read'] }] })).body;
  const t = await token(c.client_id, c.client_secret);
  const b = { Authorization: `Bearer ${t.body.access_token}` };
  assert.equal((await call('GET', '/api/v1/users', b)).status, 200);

  // Disable → token revoked and new tokens refused.
  await mgmt('PATCH', `/__admin/credentials/${c.id}`, { disabled: true });
  assert.equal((await call('GET', '/api/v1/users', b)).status, 401);
  assert.match((await token(c.client_id, c.client_secret)).body.error_description, /disabled/);
  await mgmt('PATCH', `/__admin/credentials/${c.id}`, { disabled: false });

  // Expired.
  await mgmt('PATCH', `/__admin/credentials/${c.id}`, { expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.match((await token(c.client_id, c.client_secret)).body.error_description, /expired/);
  await mgmt('PATCH', `/__admin/credentials/${c.id}`, { expires_at: null });

  // Edit grants → now orders works too.
  await mgmt('PATCH', `/__admin/credentials/${c.id}`, { grants: [{ resource: 'users', permissions: ['read'] }, { resource: 'orders', permissions: ['read'] }] });
  const t2 = await token(c.client_id, c.client_secret);
  assert.equal((await call('GET', '/api/v1/orders', { Authorization: `Bearer ${t2.body.access_token}` })).status, 200);

  // Rotate.
  const r = (await mgmt('POST', `/__admin/credentials/${c.id}/rotate`)).body;
  assert.equal((await token(c.client_id, c.client_secret)).status, 401);
  assert.equal((await token(c.client_id, r.client_secret)).status, 200);

  // Revoke.
  await mgmt('DELETE', `/__admin/credentials/${c.id}`);
  assert.equal((await token(c.client_id, r.client_secret)).status, 401);
});

test('deleting a collection removes it from grants', async () => {
  await mgmt('POST', '/__admin/resources', { name: 'temp', auth_required: true });
  const c = (await mgmt('POST', '/__admin/credentials', {
    type: 'api_key', grants: [{ resource: 'temp', permissions: ['read'] }, { resource: 'users', permissions: ['read'] }],
  })).body;
  await mgmt('DELETE', '/__admin/resources/temp');
  const after = (await mgmt('GET', '/__admin/credentials')).body.credentials.find((x) => x.id === c.id);
  assert.deepEqual(after.grants, [{ resource: 'users', permissions: ['read'] }]);
});

test('invalid credential requests are rejected', async () => {
  const bad = (body) => mgmt('POST', '/__admin/credentials', body).then((r) => r.status);
  assert.equal(await bad({ type: 'password', grants: [{ resource: 'users', permissions: ['read'] }] }), 400);
  assert.equal(await bad({ type: 'api_key', grants: [] }), 400);
  assert.equal(await bad({ type: 'api_key', grants: [{ resource: 'nope', permissions: ['read'] }] }), 400);
  assert.equal(await bad({ type: 'api_key', grants: [{ resource: 'users', permissions: [] }] }), 400);
  assert.equal(await bad({ type: 'oauth_client', grants: [{ resource: 'users', permissions: ['read'], scope: 'x' }, { resource: 'orders', permissions: ['read'], scope: 'x' }] }), 400);
  assert.equal(await bad({ type: 'oauth_client', token_ttl_seconds: 5, grants: [{ resource: 'users', permissions: ['read'] }] }), 400);
});

test('client with custom scopes on all collections reaches every private collection', async () => {
  const sn = await createOAuthClient(base);
  const t = await token(sn.id, sn.secret, 'inventory.read');
  const b = { Authorization: `Bearer ${t.body.access_token}` };
  assert.equal((await call('GET', '/api/v1/users', b)).status, 200);
  assert.equal((await call('GET', '/api/v1/orders', b)).status, 200);
  assert.equal((await call('POST', '/api/v1/orders', b, {})).status, 403);
});
