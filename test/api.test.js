import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, parseUpdatedSince } from '../src/app.js';
import { createOAuthClient } from './helpers.js';

const config = {
  port: 0,
  tokenTtlSeconds: 3600,
  rateLimitMax: 1000,
  rateLimitWindowSeconds: 60,
  vmCount: 450,
  dataSeed: 42,
  maxPageSize: 200,
};

let base, app, CLIENT;
before(async () => {
  app = await createApp(config, { log: () => {} });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  CLIENT = await createOAuthClient(base);
});
after(() => app.server.close());

const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const admin = (path, body) =>
  fetch(`${base}/__admin${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });

async function getToken() {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: FORM,
    body: form({ grant_type: 'client_credentials', client_id: CLIENT.id, client_secret: CLIENT.secret, scope: 'inventory.read' }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).access_token;
}
const vms = (token, qs = '') =>
  fetch(`${base}/api/v1/vms${qs}`, { headers: { Authorization: `Bearer ${token}` } });

test('token: client_secret_post', async () => {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: FORM,
    body: form({ grant_type: 'client_credentials', client_id: CLIENT.id, client_secret: CLIENT.secret, scope: 'inventory.read' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.scope, 'inventory.read');
  assert.equal(body.expires_in, 3600);
  assert.match(body.access_token, /^[0-9a-f]{64}$/);
});

test('token: client_secret_basic', async () => {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { ...FORM, Authorization: 'Basic ' + Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString('base64') },
    body: form({ grant_type: 'client_credentials' }),
  });
  assert.equal(res.status, 200);
});

test('token: errors', async () => {
  const post = (b) => fetch(`${base}/oauth/token`, { method: 'POST', headers: FORM, body: form(b) });
  let res = await post({ grant_type: 'client_credentials', client_id: CLIENT.id, client_secret: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'invalid_client');
  res = await post({ grant_type: 'password', client_id: CLIENT.id, client_secret: CLIENT.secret });
  assert.equal((await res.json()).error, 'unsupported_grant_type');
  res = await post({ grant_type: 'client_credentials', client_id: CLIENT.id, client_secret: CLIENT.secret, scope: 'bogus.scope' });
  assert.equal((await res.json()).error, 'invalid_scope');
});

test('vms: requires a valid bearer token', async () => {
  assert.equal((await fetch(`${base}/api/v1/vms`)).status, 401);
  const res = await vms('nope');
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /invalid_token/);
});

test('vms: pagination walks to total_pages', async () => {
  const token = await getToken();
  const seen = new Set();
  let page = 1;
  let total;
  do {
    const body = await (await vms(token, `?page=${page}&page_size=200`)).json();
    total = body.total_pages;
    assert.equal(body.page, page);
    body.vms.forEach((v) => seen.add(v.vm_id));
    page++;
  } while (page <= total);
  assert.equal(total, 3);
  assert.equal(seen.size, 450);
});

test('vms: first page starts with the exact sample records', async () => {
  const token = await getToken();
  const body = await (await vms(token, '?page=1')).json();
  assert.deepEqual(body.vms.slice(0, 4).map((v) => v.vm_id), ['vm-001', 'vm-002', 'vm-003', 'vm-004']);
  assert.equal(body.vms[0].hostname, ' WEB-PROD-01 ');
  assert.equal(body.vms[3].ip_address, '999.1.1.1');
  assert.ok(!('_updated_at' in body.vms[0]), 'internal fields must not leak');
});

test('vms: page_size is capped at 200 and bad params are 400', async () => {
  const token = await getToken();
  const body = await (await vms(token, '?page_size=1000')).json();
  assert.equal(body.vms.length, 200);
  assert.equal((await vms(token, '?page=0')).status, 400);
  assert.equal((await vms(token, '?updated_since=yesterday')).status, 400);
});

test('vms: updated_since filters, and empty result still has total_pages=1', async () => {
  const token = await getToken();
  const future = new Date(Date.now() + 86400000).toISOString();
  const body = await (await vms(token, `?updated_since=${future}`)).json();
  assert.deepEqual(body, { page: 1, total_pages: 1, vms: [] });

  await admin('/touch', { vm_ids: ['vm-010', 'vm-020'] });
  const since = new Date(Date.now() - 5000).toISOString();
  const delta = await (await vms(token, `?updated_since=${encodeURIComponent(since)}`)).json();
  assert.deepEqual(delta.vms.map((v) => v.vm_id).sort(), ['vm-010', 'vm-020']);
});

test('parseUpdatedSince accepts ISO, date-only and GlideDateTime formats', () => {
  assert.equal(parseUpdatedSince('2026-11-18T02:00:00Z').toISOString(), '2026-11-18T02:00:00.000Z');
  assert.equal(parseUpdatedSince('2026-11-18').toISOString(), '2026-11-18T00:00:00.000Z');
  assert.equal(parseUpdatedSince('2026-11-18 02:00:00').toISOString(), '2026-11-18T02:00:00.000Z');
  assert.equal(parseUpdatedSince('2026-11-18T07:30:00+05:30').toISOString(), '2026-11-18T02:00:00.000Z');
  assert.equal(parseUpdatedSince('18/11/2026'), null);
});

test('chaos: simulated 401 then token refresh works', async () => {
  const token = await getToken();
  await admin('/chaos', { unauthorized_next: 1 });
  assert.equal((await vms(token)).status, 401);
  assert.equal((await vms(token)).status, 200);
});

test('chaos: revoked token gives 401, new token works', async () => {
  const token = await getToken();
  await admin('/revoke-tokens', {});
  assert.equal((await vms(token)).status, 401);
  assert.equal((await vms(await getToken())).status, 200);
});

test('chaos: simulated 429 has Retry-After', async () => {
  const token = await getToken();
  await admin('/chaos', { rate_limit_next: 2 });
  const r1 = await vms(token);
  assert.equal(r1.status, 429);
  assert.equal(r1.headers.get('retry-after'), '2');
  assert.equal((await vms(token)).status, 429);
  assert.equal((await vms(token)).status, 200);
});

test('real rate limit returns 429 with Retry-After', async () => {
  const limited = await createApp({ ...config, rateLimitMax: 2 }, { log: () => {} });
  await new Promise((r) => limited.server.listen(0, r));
  const b = `http://127.0.0.1:${limited.server.address().port}`;
  const LC = await createOAuthClient(b);
  const tok = await (await fetch(`${b}/oauth/token`, {
    method: 'POST', headers: FORM,
    body: form({ grant_type: 'client_credentials', client_id: LC.id, client_secret: LC.secret, scope: 'inventory.read' }),
  })).json();
  const call = () => fetch(`${b}/api/v1/vms`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  const r = await call();
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  limited.server.close();
});

test('expired token returns 401', async () => {
  const short = await createApp({ ...config, tokenTtlSeconds: 0 }, { log: () => {} });
  await new Promise((r) => short.server.listen(0, r));
  const b = `http://127.0.0.1:${short.server.address().port}`;
  const LC = await createOAuthClient(b);
  const tok = await (await fetch(`${b}/oauth/token`, {
    method: 'POST', headers: FORM,
    body: form({ grant_type: 'client_credentials', client_id: LC.id, client_secret: LC.secret, scope: 'inventory.read' }),
  })).json();
  const r = await fetch(`${b}/api/v1/vms`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error_description, /expired/);
  short.server.close();
});

test('no admin bypass: management API is open, private API always needs a credential', async () => {
  assert.equal((await fetch(`${base}/__admin/state`)).status, 200);
  const info = await (await fetch(`${base}/__admin/info`)).json();
  assert.ok(!('client_id' in info.oauth) && !('scopes' in info.oauth), 'no built-in client is exposed');
  assert.equal((await fetch(`${base}/api/v1/vms`, { headers: { 'X-Admin-Key': 'anything' } })).status, 401);
});

test('dataset contains every dirty-data case the integration must handle', async () => {
  const { vms: all } = await (await admin('/vms')).json();
  const ipv4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
  const fam = (v) => (v.guest_os?.family || '').toLowerCase();
  assert.ok(all.some((v) => !(v.hostname || '').trim()), 'empty hostname');
  assert.ok(all.some((v) => !ipv4.test(v.ip_address || '')), 'invalid ip');
  assert.ok(all.some((v) => fam(v) === 'windows'), 'windows');
  assert.ok(all.some((v) => fam(v) === 'linux'), 'linux');
  assert.ok(all.some((v) => !['windows', 'linux'].includes(fam(v))), 'unknown os family');
  assert.ok(all.some((v) => v.guest_os?.name === 'Win Server 2022'), 'os name variant');
  assert.ok(all.some((v) => !['running', 'stopped'].includes(v.status)), 'unmapped status');
  assert.ok(all.some((v) => v.cpu_manufacturer === 'GenuineIntel'), 'cpu variant');
  assert.ok(all.some((v) => {
    const sw = v.installed_software || [];
    return new Set(sw.map((s) => `${s.name}|${s.version}`)).size < sw.length;
  }), 'duplicate software entry');
});
