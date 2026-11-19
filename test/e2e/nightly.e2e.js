// End-to-end test: starts the real server (node src/server.js) as a separate
// process and drives it over HTTP the way the UI and a ServiceNow nightly job would.
//
//   npm run test:e2e
//
// Storage: uses MONGODB_URI from .env (e.g. Atlas) with a throwaway database
// named mock_e2e_<timestamp>, which is dropped at the end. Set E2E_MEMORY=1 to
// run against in-memory storage instead.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = `mock_e2e_${Date.now()}`;
let base;
let child;
let storage;
const serverLog = [];

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, p, { headers = {}, body, form } = {}) {
  const h = { ...headers };
  let payload;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, json, text };
}
const basicAuth = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const glideNow = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' '); // GlideDateTime.getValue()

// ---- A ServiceNow-style nightly job, written from the integration requirements ----
// OAuth client credentials; paginate until page == total_pages with a max-page cap;
// on 401 refresh the token and retry once; on 429 back off for Retry-After and retry.
async function nightlyJob({ clientId, clientSecret, updatedSince, maxPages = 20, events = [] }) {
  const getToken = async () => {
    const r = await http('POST', '/oauth/token', { headers: basicAuth(clientId, clientSecret), form: { grant_type: 'client_credentials', scope: 'inventory.read' } });
    if (r.status !== 200) throw new Error(`token request failed: ${r.status} ${r.text}`);
    events.push('token');
    return r.json.access_token;
  };
  let token = await getToken();
  const vms = [];
  let page = 1;
  let totalPages = 1;
  do {
    if (page > maxPages) throw new Error('max page cap reached');
    const qs = new URLSearchParams({ page, page_size: 200 });
    if (updatedSince) qs.set('updated_since', updatedSince);
    let r;
    let refreshed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      r = await http('GET', `/api/v1/vms?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 401 && !refreshed) { events.push('401→refresh'); token = await getToken(); refreshed = true; continue; }
      if (r.status === 429) { const wait = Number(r.headers.get('retry-after') || 1); events.push(`429→wait ${wait}s`); await sleep(wait * 1000); continue; }
      break;
    }
    if (r.status !== 200) throw new Error(`page ${page} failed: ${r.status} ${r.json?.error || ''}`);
    vms.push(...r.json.vms);
    totalPages = r.json.total_pages;
    page = r.json.page + 1;
  } while (page <= totalPages);
  return { vms, totalPages };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), MONGODB_DB: DB, RATE_LIMIT_MAX: '1000', TOKEN_TTL_SECONDS: '3600' };
  if (process.env.E2E_MEMORY) env.MONGODB_URI = ''; // empty = in-memory storage
  child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    const onData = (buf) => {
      const s = buf.toString();
      serverLog.push(s);
      if (s.includes('listening on')) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${serverLog.join('')}`)));
  });
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('server did not start in 60s')), 60_000); });
  await Promise.race([ready, timeout]).finally(() => clearTimeout(timer));
  storage = (await http('GET', '/health')).json.storage;
});

after(async () => {
  if (storage === 'mongodb') {
    // Drop the throwaway database through the server's own driver.
    const { MongoStore } = await import('../../src/store.js');
    process.loadEnvFile?.(path.join(ROOT, '.env'));
    const s = new MongoStore(process.env.MONGODB_URI, DB);
    await s.init();
    await s.dropDatabase();
    await s.close();
  }
  child?.kill('SIGTERM');
});

describe('end to end', { concurrency: false }, () => {
  const ctx = {};

  test('server starts, serves the UI, and exposes no admin key or built-in client', async () => {
    assert.equal((await http('GET', '/health')).json.status, 'ok');
    const html = await http('GET', '/');
    assert.equal(html.status, 200);
    assert.match(html.text, /Mock API Studio/);
    assert.doesNotMatch(html.text, /Admin Key|Unlock|lock-form/);
    const js = await http('GET', '/app.js');
    assert.doesNotMatch(js.text, /X-Admin-Key|OAUTH_CLIENT|ADMIN_KEY|Built-in client/);
    const info = (await http('GET', '/__admin/info')).json;
    assert.ok(!('client_id' in info.oauth) && !('scopes' in info.oauth) && !('admin_key_required' in info));
    assert.deepEqual((await http('GET', '/__admin/credentials')).json, { credentials: [] });
    assert.ok(!serverLog.join('').match(/OAUTH_CLIENT|ADMIN_KEY|scopes: inventory/), 'startup log shows no env credentials');
  });

  test('UI data: 450 generated VMs, private vms collection refuses anonymous and admin-header calls', async () => {
    const list = await http('GET', '/__admin/data/vms?limit=0');
    assert.equal(list.json.total, 450);
    assert.equal((await http('GET', '/api/v1/vms')).status, 401);
    assert.equal((await http('GET', '/api/v1/vms', { headers: { 'X-Admin-Key': 'anything' } })).status, 401);
  });

  test('create a ServiceNow OAuth client in the UI (vms read, scope inventory.read)', async () => {
    const r = await http('POST', '/__admin/credentials', {
      body: { type: 'oauth_client', label: 'ServiceNow nightly', grants: [{ resource: 'vms', permissions: ['read'], scope: 'inventory.read' }] },
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.scopes, ['inventory.read']);
    ctx.sn = { id: r.json.client_id, secret: r.json.client_secret, credId: r.json.id };
    const listed = (await http('GET', '/__admin/credentials')).text;
    assert.ok(!listed.includes(ctx.sn.secret) && !listed.includes('secret_hash'), 'secret never listed');
  });

  test('token endpoint: Basic and form auth work; wrong secret, other scopes and grant types fail', async () => {
    assert.equal((await http('POST', '/oauth/token', { headers: basicAuth(ctx.sn.id, ctx.sn.secret), form: { grant_type: 'client_credentials' } })).status, 200);
    const post = await http('POST', '/oauth/token', { form: { grant_type: 'client_credentials', client_id: ctx.sn.id, client_secret: ctx.sn.secret, scope: 'inventory.read' } });
    assert.equal(post.json.scope, 'inventory.read');
    assert.equal(post.json.token_type, 'Bearer');
    assert.equal((await http('POST', '/oauth/token', { headers: basicAuth(ctx.sn.id, 'nope'), form: { grant_type: 'client_credentials' } })).status, 401);
    assert.equal((await http('POST', '/oauth/token', { headers: basicAuth(ctx.sn.id, ctx.sn.secret), form: { grant_type: 'client_credentials', scope: 'inventory.write' } })).json.error, 'invalid_scope');
    assert.equal((await http('POST', '/oauth/token', { headers: basicAuth(ctx.sn.id, ctx.sn.secret), form: { grant_type: 'password' } })).json.error, 'unsupported_grant_type');
  });

  test('nightly run 1 (full load): paginates 3 pages, gets all 450 VMs with the sample records', async () => {
    ctx.runStart = new Date(Date.now() - 1000);
    const { vms, totalPages } = await nightlyJob({ clientId: ctx.sn.id, clientSecret: ctx.sn.secret });
    assert.equal(totalPages, 3);
    assert.equal(vms.length, 450);
    assert.equal(new Set(vms.map((v) => v.vm_id)).size, 450);
    const byId = Object.fromEntries(vms.map((v) => [v.vm_id, v]));
    assert.equal(byId['vm-001'].hostname, ' WEB-PROD-01 ');
    assert.equal(byId['vm-002'].guest_os.family, 'Windows');
    assert.equal(byId['vm-004'].ip_address, '999.1.1.1');
    assert.ok(vms.every((v) => !Object.keys(v).some((k) => k.startsWith('_'))), 'no internal fields leak');
    ctx.lastSuccessfulRun = glideNow(ctx.runStart); // job stores this only after a fully successful run
  });

  test('changes made in the UI show up in the next delta run (GlideDateTime updated_since)', async () => {
    await sleep(1100);
    const since = glideNow();
    await sleep(1100);
    // Edit one VM and create one through the UI, and mark two as changed with Test Controls.
    assert.equal((await http('PATCH', '/__admin/data/vms/vm-005', { body: { status: 'stopped', hostname: 'edited-in-ui' } })).status, 200);
    const created = await http('POST', '/__admin/data/vms', { body: { hostname: 'new-from-ui', ip_address: '10.1.2.3', guest_os: { family: 'Linux' }, status: 'running' } });
    assert.equal(created.status, 201);
    ctx.newVm = created.json.vm_id;
    await http('POST', '/__admin/touch', { body: { vm_ids: ['vm-010', 'vm-020'] } });

    const { vms } = await nightlyJob({ clientId: ctx.sn.id, clientSecret: ctx.sn.secret, updatedSince: since });
    assert.deepEqual(vms.map((v) => v.vm_id).sort(), ['vm-005', 'vm-010', 'vm-020', ctx.newVm].sort());
    assert.equal(vms.find((v) => v.vm_id === 'vm-005').hostname, 'edited-in-ui');
  });

  test('resilience: 401 → refresh once, 429 → back off, 503 → run fails and last_successful_run stays put', async () => {
    await http('POST', '/__admin/chaos', { body: { unauthorized_next: 1, rate_limit_next: 1 } });
    const events = [];
    const ok = await nightlyJob({ clientId: ctx.sn.id, clientSecret: ctx.sn.secret, events });
    assert.equal(ok.vms.length, 451);
    assert.deepEqual(events, ['token', '401→refresh', 'token', '429→wait 2s']);

    const before = ctx.lastSuccessfulRun;
    await http('POST', '/__admin/chaos', { body: { server_error_next: 1 } });
    let failed = false;
    try {
      await nightlyJob({ clientId: ctx.sn.id, clientSecret: ctx.sn.secret, updatedSince: before });
      ctx.lastSuccessfulRun = glideNow();
    } catch (e) {
      failed = /503/.test(e.message);
    }
    assert.ok(failed, 'run failed on 503');
    assert.equal(ctx.lastSuccessfulRun, before, 'delta property not advanced');
  });

  test('API key and Basic login with grants across collections', async () => {
    assert.equal((await http('POST', '/__admin/resources', { body: { name: 'orders', auth_required: true, records: [{ total: 5 }] } })).status, 201);
    assert.equal((await http('GET', '/api/v1/orders')).status, 401, 'private');
    assert.equal((await http('POST', '/__admin/resources', { body: { name: 'products', records: [{ title: 'Pen' }] } })).json.auth_required, false, 'new collections start public');
    assert.equal((await http('GET', '/api/v1/products')).status, 200);

    const key = (await http('POST', '/__admin/credentials', { body: { type: 'api_key', label: 'Reporting', grants: [{ resource: 'vms', permissions: ['read'] }, { resource: 'orders', permissions: ['read', 'write'] }] } })).json;
    const K = { 'X-API-Key': key.api_key };
    assert.equal((await http('GET', '/api/v1/vms?limit=1', { headers: K })).status, 200);
    assert.equal((await http('POST', '/api/v1/orders', { headers: K, body: { total: 9 } })).status, 201);
    assert.equal((await http('POST', '/api/v1/vms', { headers: K, body: {} })).status, 403);

    const user = (await http('POST', '/__admin/credentials', { body: { type: 'basic', username: 'e2e-user', grants: [{ resource: '*', permissions: ['read'] }] } })).json;
    assert.equal(user.username, 'e2e-user');
    const B = basicAuth(user.username, user.password);
    assert.equal((await http('GET', '/api/v1/orders', { headers: B })).json.orders.length, 2);
    assert.equal((await http('POST', '/api/v1/orders', { headers: B, body: {} })).status, 403);
    ctx.key = key;
  });

  test('disable, rotate and revoke take effect immediately', async () => {
    const K = { 'X-API-Key': ctx.key.api_key };
    await http('PATCH', `/__admin/credentials/${ctx.key.id}`, { body: { disabled: true } });
    assert.match((await http('GET', '/api/v1/vms', { headers: K })).json.error_description, /disabled/);
    await http('PATCH', `/__admin/credentials/${ctx.key.id}`, { body: { disabled: false } });
    assert.equal((await http('GET', '/api/v1/vms?limit=1', { headers: K })).status, 200);

    const rotated = (await http('POST', `/__admin/credentials/${ctx.key.id}/rotate`)).json;
    assert.equal((await http('GET', '/api/v1/vms', { headers: K })).status, 401);
    assert.equal((await http('GET', '/api/v1/vms?limit=1', { headers: { 'X-API-Key': rotated.api_key } })).status, 200);

    // Revoking the ServiceNow client kills its live tokens too.
    const t = (await http('POST', '/oauth/token', { headers: basicAuth(ctx.sn.id, ctx.sn.secret), form: { grant_type: 'client_credentials' } })).json.access_token;
    await http('DELETE', `/__admin/credentials/${ctx.sn.credId}`);
    assert.equal((await http('GET', '/api/v1/vms', { headers: { Authorization: `Bearer ${t}` } })).status, 401);
    assert.equal((await http('POST', '/oauth/token', { headers: basicAuth(ctx.sn.id, ctx.sn.secret), form: { grant_type: 'client_credentials' } })).status, 401);
  });

  test('request log records the integration traffic', async () => {
    const st = (await http('GET', '/__admin/state')).json;
    const actors = new Set(st.recent_requests.map((r) => r.actor));
    assert.ok(actors.has('oauth') && actors.has('api_key') && actors.has('basic'));
    assert.ok(!actors.has('admin'));
    assert.ok(st.stats.token_issued >= 5);
  });
});
