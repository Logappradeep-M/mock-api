import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventory } from './data.js';
import { MemoryStore, stripInternal, ConflictError, NotFoundError } from './store.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.svg', 'image/svg+xml'],
};

const RESOURCE_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const LIST_PARAMS = new Set(['page', 'page_size', 'limit', 'skip', 'sortBy', 'order', 'q', 'select', 'delay', 'updated_since', 'include_meta']);
const BUILTIN = { name: 'vms', id_field: 'vm_id', auth_required: true, builtin: true, description: 'Sample cloud VM inventory' };

class HttpError extends Error {
  constructor(status, error, description, headers) {
    super(description);
    Object.assign(this, { status, error, headers });
  }
}

const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
};

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

const readBody = (req, limit = 5 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', 'Request body exceeds 5 MB'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const parseBody = (req, raw) => {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!raw) return {};
  if (type === 'application/json') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid_request', 'Malformed JSON body');
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
};

const readJson = async (req) => parseBody(req, await readBody(req));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// RFC 7396 JSON Merge Patch: objects merge recursively, null removes a key.
function mergePatch(target, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

// Accepts ISO 8601 ("2026-11-18T02:00:00Z"), date only ("2026-11-18") and
// space-separated date-time ("2026-11-18 02:00:00", treated as UTC).
export function parseUpdatedSince(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) value += 'T00:00:00Z';
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) value = value.replace(' ', 'T') + 'Z';
  else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const toPublic = (doc, select, meta = false) => {
  const out = stripInternal(doc);
  if (meta) {
    out._updated_at = new Date(doc._updated_at).toISOString();
    out._created_at = new Date(doc._created_at).toISOString();
  }
  if (!select) return out;
  const picked = {};
  for (const k of select) if (k in out) picked[k] = out[k];
  return picked;
};

export async function createApp(config, { log = console.log, store } = {}) {
  store ??= new MemoryStore();
  await store.init?.();

  const state = {
    tokens: new Map(), // access_token -> { clientId, scope, expiresAt }
    rate: new Map(), // clientId -> { windowStart, count }
    chaos: { unauthorized_next: 0, rate_limit_next: 0, server_error_next: 0, delay_ms: 0 },
    stats: { token_issued: 0, token_rejected: 0, api_ok: 0, api_401: 0, api_429: 0, api_5xx: 0, api_4xx: 0 },
    requests: [], // last 300 request summaries
  };

  // Creates the sample vms collection. On startup it is skipped if the collection
  // exists, or if the user deleted it (remembered in meta, so it stays deleted).
  async function seedVms({ replace = false } = {}) {
    const existing = await store.getResource('vms');
    if (existing && !replace) return;
    if (!existing && !replace && await store.getMeta('vms_sample_deleted')) return;
    await store.setMeta('vms_sample_deleted', null);
    if (!existing) await store.createResource(BUILTIN);
    else await store.clear('vms');
    const vms = buildInventory({ count: config.vmCount, seed: config.dataSeed });
    await store.insertMany('vms', 'vm_id', vms);
    await store.updateResource('vms', { next_id: vms.length + 1 });
  }
  await seedVms();
  // One-time cleanup: databases created by older versions stored a previous default
  // description for the sample collection. Replace only that exact text.
  {
    const vms = await store.getResource('vms');
    if (vms?.builtin && vms.description === 'Cloud VM inventory (the contract ServiceNow consumes)') {
      await store.updateResource('vms', { description: BUILTIN.description });
    }
  }

  // ---- Credentials -------------------------------------------------------------
  // Three kinds of credentials, managed in the UI's Credentials page:
  //   api_key       – X-API-Key header
  //   basic         – Authorization: Basic base64(username:password)
  //   oauth_client  – client_id + client_secret for POST /oauth/token, then a Bearer token
  // Each has grants: [{ resource: '<name>' | '*', permissions: ['read','write'], scope? }].
  // For OAuth clients, every grant row defines the scope names that unlock it:
  // a custom `scope`, or <resource>.read / <resource>.write ('*' becomes "all").
  // Secrets are random, shown once, and stored only as SHA-256 hashes.
  // There are no built-in or environment-configured credentials: every API key,
  // Basic login and OAuth client is created in the UI (or via /__admin/credentials).
  const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const randomToken = (bytes) => crypto.randomBytes(bytes).toString('base64url');
  const PERMS = ['read', 'write'];
  const TYPES = ['api_key', 'basic', 'oauth_client'];
  const SECRET_FIELD = { api_key: 'api_key', basic: 'password', oauth_client: 'client_secret' };
  const lastUsedWrites = new Map(); // credId -> ms, throttles last_used_at updates

  // Older records stored a single { resource, permissions }; read them as one grant.
  function normalizeCred(c) {
    if (!c) return c;
    if (!Array.isArray(c.grants)) c.grants = c.resource ? [{ resource: c.resource, permissions: c.permissions || ['read'] }] : [];
    return c;
  }
  function publicCredential(c) {
    const { key_hash, secret_hash, password_hash, resource, permissions, ...rest } = normalizeCred(c);
    if (rest.type === 'oauth_client') rest.scopes = scopeTable(rest).map((s) => s.scope);
    rest.expired = isExpired(rest);
    return rest;
  }
  const isExpired = (c) => !!c.expires_at && new Date(c.expires_at).getTime() <= Date.now();

  // OAuth scope name -> { resource, permissions }[] for a client.
  function scopeTable(c) {
    const out = [];
    for (const g of c.grants) {
      const res = g.resource === '*' ? 'all' : g.resource;
      if (g.scope) out.push({ scope: g.scope, resource: g.resource, permissions: g.permissions });
      else for (const p of g.permissions) out.push({ scope: `${res}.${p}`, resource: g.resource, permissions: [p] });
    }
    return out;
  }
  const grantsAllow = (grants, resource, need) =>
    grants.some((g) => (g.resource === '*' || g.resource === resource) && g.permissions.includes(need));

  function touchCredential(id) {
    const now = Date.now();
    if (now - (lastUsedWrites.get(id) || 0) < 60_000) return;
    lastUsedWrites.set(id, now);
    store.updateCredential(id, { last_used_at: new Date(now).toISOString() }).catch(() => {});
  }
  function revokeTokensWhere(pred) {
    for (const [t, tok] of state.tokens) if (pred(tok)) state.tokens.delete(t);
  }

  async function validateGrants(grants, type) {
    if (!Array.isArray(grants) || !grants.length) throw new HttpError(400, 'invalid_request', 'Add at least one collection to grants');
    const names = new Set((await store.listResources()).map((r) => r.name));
    const seenScopes = new Set();
    const out = [];
    for (const g of grants) {
      const resource = String(g?.resource || '').trim();
      if (resource !== '*' && !names.has(resource)) throw new HttpError(400, 'invalid_request', `Collection "${resource}" doesn't exist`);
      const permissions = [...new Set((Array.isArray(g.permissions) ? g.permissions : []).filter((p) => PERMS.includes(p)))].sort();
      if (!permissions.length) throw new HttpError(400, 'invalid_request', `Choose read and/or write for "${resource === '*' ? 'all collections' : resource}"`);
      const grant = { resource, permissions };
      if (type === 'oauth_client' && g.scope && String(g.scope).trim()) {
        const scope = String(g.scope).trim();
        if (!/^[A-Za-z0-9_.:*-]{1,64}$/.test(scope)) throw new HttpError(400, 'invalid_request', `Scope "${scope}" may only use letters, numbers and . _ : - *`);
        grant.scope = scope;
      }
      out.push(grant);
    }
    if (type === 'oauth_client') {
      for (const s of scopeTable({ grants: out })) {
        if (seenScopes.has(s.scope)) throw new HttpError(400, 'invalid_request', `Scope "${s.scope}" is used twice. Give each row its own scope name.`);
        seenScopes.add(s.scope);
      }
    }
    return out;
  }
  function parseExpiry(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid_request', 'expires_at must be an ISO date or null');
    return d.toISOString();
  }
  function parseTtl(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 30 || n > 86400) throw new HttpError(400, 'invalid_request', 'token_ttl_seconds must be between 30 and 86400');
    return n;
  }
  function issueSecret(type) {
    if (type === 'api_key') {
      const secret = `imk_${randomToken(24)}`;
      return { secret, fields: { key_hash: sha256(secret), key_prefix: secret.slice(0, 8), secret_last4: secret.slice(-4) } };
    }
    if (type === 'basic') {
      const secret = `ibp_${randomToken(18)}`;
      return { secret, fields: { password_hash: sha256(secret), secret_last4: secret.slice(-4) } };
    }
    const secret = `ics_${randomToken(32)}`;
    return { secret, fields: { secret_hash: sha256(secret), secret_last4: secret.slice(-4) } };
  }
  const credentialProblem = (c) => (c.disabled ? 'This credential is disabled' : isExpired(c) ? 'This credential has expired' : null);

  // ---- OAuth -----------------------------------------------------------------
  async function handleToken(req, res) {
    const body = await readJson(req);

    // Client authentication: HTTP Basic (client_secret_basic) or body params (client_secret_post).
    let clientId = body.client_id;
    let clientSecret = body.client_secret;
    const auth = req.headers.authorization || '';
    if (auth.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > -1) {
        clientId = decodeURIComponent(decoded.slice(0, idx));
        clientSecret = decodeURIComponent(decoded.slice(idx + 1));
      }
    }

    const oauthError = (status, error, description, headers) =>
      json(res, status, { error, error_description: description }, headers);

    if (body.grant_type !== 'client_credentials') {
      return oauthError(400, 'unsupported_grant_type', 'Only grant_type=client_credentials is supported');
    }

    // Who is this client, and which scopes may it request?
    let client = null;
    if (clientId && clientSecret) {
      const cred = normalizeCred(await store.findCredential({ client_id: String(clientId) }));
      if (cred?.type === 'oauth_client' && safeEqual(sha256(clientSecret), cred.secret_hash)) {
        const problem = credentialProblem(cred);
        if (problem) {
          state.stats.token_rejected++;
          return oauthError(401, 'invalid_client', problem, { 'WWW-Authenticate': 'Basic realm="oauth"' });
        }
        const table = scopeTable(cred);
        client = { clientId: cred.client_id, credId: cred.id, table, defaultScopes: table.map((s) => s.scope), ttl: cred.token_ttl_seconds || config.tokenTtlSeconds };
        touchCredential(cred.id);
      }
    }
    if (!client) {
      state.stats.token_rejected++;
      return oauthError(401, 'invalid_client', 'Client authentication failed', { 'WWW-Authenticate': 'Basic realm="oauth"' });
    }

    const requested = body.scope ? [...new Set(String(body.scope).split(/\s+/).filter(Boolean))] : client.defaultScopes;
    const allowed = client.table.map((s) => s.scope);
    const bad = requested.filter((s) => !allowed.includes(s));
    if (bad.length) {
      return oauthError(400, 'invalid_scope', `Scope not allowed: ${bad.join(' ')}. This client may request: ${allowed.join(' ')}`);
    }

    const access_token = crypto.randomBytes(32).toString('hex');
    const scope = requested.join(' ');
    const grants = client.table.filter((s) => requested.includes(s.scope)).map(({ resource, permissions }) => ({ resource, permissions }));
    state.tokens.set(access_token, {
      clientId: client.clientId, credId: client.credId, scope, grants,
      expiresAt: Date.now() + client.ttl * 1000,
    });
    state.stats.token_issued++;
    return json(res, 200, { access_token, token_type: 'Bearer', expires_in: client.ttl, scope }, { Pragma: 'no-cache' });
  }

  function bearer(token) {
    const tok = state.tokens.get(token);
    if (!tok) return { error: 'invalid_token', description: 'Unknown or revoked access token' };
    if (tok.expiresAt <= Date.now()) {
      state.tokens.delete(token);
      return { error: 'invalid_token', description: 'Access token expired' };
    }
    return { token: tok };
  }

  function rateLimit(clientId) {
    const now = Date.now();
    const windowMs = config.rateLimitWindowSeconds * 1000;
    let entry = state.rate.get(clientId);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { windowStart: now, count: 0 };
      state.rate.set(clientId, entry);
    }
    entry.count++;
    const resetSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return {
      limited: entry.count > config.rateLimitMax,
      retryAfter: Math.max(1, resetSec),
      headers: {
        'X-RateLimit-Limit': String(config.rateLimitMax),
        'X-RateLimit-Remaining': String(Math.max(0, config.rateLimitMax - entry.count)),
        'X-RateLimit-Reset': String(resetSec),
      },
    };
  }

  // The UI and /__admin are open to everyone; /api/v1 private collections always
  // require a credential (there is no bypass header).

  const ALL_SCHEMES = 'Bearer realm="api", Basic realm="api", ApiKey realm="api"';

  // Runs the credential / chaos / rate-limit gauntlet for a private collection.
  // Accepts X-API-Key, Basic username:password, or a Bearer token.
  // Returns headers to attach to the eventual success response.
  async function guard(req, def, write) {
    if (state.chaos.unauthorized_next > 0) {
      state.chaos.unauthorized_next--;
      throw new HttpError(401, 'invalid_token', 'Access token expired (simulated)', {
        'WWW-Authenticate': 'Bearer error="invalid_token", error_description="Access token expired"',
      });
    }
    const need = write ? 'write' : 'read';
    const authz = req.headers.authorization || '';
    const apiKey = req.headers['x-api-key'];
    let principal;
    let grants;
    let what;

    const checkCred = (cred, kind) => {
      const problem = credentialProblem(cred);
      if (problem) throw new HttpError(401, 'invalid_credentials', problem, { 'WWW-Authenticate': ALL_SCHEMES });
      touchCredential(cred.id);
      principal = cred.id;
      grants = cred.grants;
      what = kind;
    };

    if (apiKey) {
      const cred = normalizeCred(await store.findCredential({ key_hash: sha256(apiKey) }));
      if (cred?.type !== 'api_key') throw new HttpError(401, 'invalid_api_key', 'Unknown or revoked API key', { 'WWW-Authenticate': ALL_SCHEMES });
      checkCred(cred, 'This API key');
    } else if (/^basic\s/i.test(authz)) {
      const decoded = Buffer.from(authz.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const username = idx > -1 ? decoded.slice(0, idx) : '';
      const password = idx > -1 ? decoded.slice(idx + 1) : '';
      const cred = normalizeCred(username ? await store.findCredential({ username }) : null);
      if (cred?.type !== 'basic' || !safeEqual(sha256(password), cred.password_hash)) {
        throw new HttpError(401, 'invalid_credentials', 'Wrong username or password', { 'WWW-Authenticate': ALL_SCHEMES });
      }
      checkCred(cred, 'This user');
    } else if (/^bearer\s/i.test(authz)) {
      const auth = bearer(authz.slice(7).trim());
      if (auth.error) {
        throw new HttpError(401, auth.error, auth.description, {
          'WWW-Authenticate': `Bearer error="${auth.error}", error_description="${auth.description}"`,
        });
      }
      if (auth.token.credId) touchCredential(auth.token.credId);
      principal = auth.token.clientId;
      grants = auth.token.grants;
      what = 'This token';
    } else {
      throw new HttpError(401, 'invalid_request', 'This collection is private. Send an X-API-Key header, Basic credentials or a Bearer token.', { 'WWW-Authenticate': ALL_SCHEMES });
    }

    if (!grantsAllow(grants, def.name, need)) {
      const canReach = grants.some((g) => g.resource === '*' || g.resource === def.name);
      throw new HttpError(403, 'insufficient_scope',
        canReach ? `${what} doesn't have ${need} permission on ${def.name}` : `${what} has no access to ${def.name}`,
        what === 'This token' ? { 'WWW-Authenticate': `Bearer error="insufficient_scope", error_description="${need} on ${def.name}"` } : {});
    }

    if (state.chaos.rate_limit_next > 0) {
      state.chaos.rate_limit_next--;
      throw new HttpError(429, 'rate_limited', 'Too many requests (simulated)', { 'Retry-After': '2' });
    }
    const rl = rateLimit(principal);
    if (rl.limited) {
      throw new HttpError(429, 'rate_limited', 'Too many requests', { ...rl.headers, 'Retry-After': String(rl.retryAfter) });
    }
    if (state.chaos.server_error_next > 0) {
      state.chaos.server_error_next--;
      throw new HttpError(503, 'service_unavailable', 'Upstream temporarily unavailable (simulated)', { 'Retry-After': '5' });
    }
    return rl.headers;
  }

  // ---- Resource API: /api/v1/:resource[/:id] ----------------------------------
  async function newId(def) {
    for (;;) {
      const n = await store.nextId(def.name);
      const id = def.name === 'vms' ? `vm-${String(n).padStart(3, '0')}` : String(n);
      if (!(await store.get(def.name, id))) return id;
    }
  }

  function prepare(def, body, { requireId = false } = {}) {
    if (!isPlainObject(body)) throw new HttpError(400, 'invalid_request', 'Body must be a JSON object');
    const doc = stripInternal(body);
    const idv = doc[def.id_field];
    if (idv === undefined || idv === null || String(idv).trim() === '') {
      if (requireId) throw new HttpError(400, 'invalid_request', `${def.id_field} is required`);
      delete doc[def.id_field];
    } else {
      doc[def.id_field] = String(idv).trim();
    }
    return doc;
  }

  async function handleResource(req, res, url, name, id, { trusted = false } = {}) {
    const def = await store.getResource(name);
    if (!def) throw new HttpError(404, 'not_found', `Resource "${name}" does not exist`);

    const q = url.searchParams;
    const write = req.method !== 'GET';
    const admin = trusted;
    let headers = {};

    if (!admin && def.auth_required) headers = await guard(req, def, write);
    if (!admin && state.chaos.delay_ms) await new Promise((r) => setTimeout(r, state.chaos.delay_ms));
    if (q.has('delay')) {
      const d = Math.min(5000, Math.max(0, Number(q.get('delay')) || 0));
      await new Promise((r) => setTimeout(r, d));
    }

    const idField = def.id_field;

    if (id === undefined) {
      if (req.method === 'GET') return listRecords(res, def, q, headers, admin && q.get('include_meta') === 'true');
      if (req.method === 'POST') {
        const doc = prepare(def, await readJson(req));
        doc[idField] ??= await newId(def);
        const saved = await store.insert(name, idField, doc);
        return json(res, 201, toPublic(saved), { ...headers, Location: `/api/v1/${name}/${encodeURIComponent(doc[idField])}` });
      }
      throw new HttpError(405, 'method_not_allowed', 'Use GET or POST', { Allow: 'GET, POST' });
    }

    const current = await store.get(name, id);
    if (req.method === 'GET') {
      if (!current) throw new HttpError(404, 'not_found', `${idField} "${id}" not found`);
      return json(res, 200, toPublic(current, selectFrom(q, idField)), headers);
    }
    if (!current) throw new HttpError(404, 'not_found', `${idField} "${id}" not found`);
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const body = await readJson(req);
      const merged = req.method === 'PATCH' ? mergePatch(stripInternal(current), body) : body;
      const doc = prepare(def, merged);
      doc[idField] ??= id;
      const saved = await store.replace(name, idField, id, doc);
      return json(res, 200, toPublic(saved), headers);
    }
    if (req.method === 'DELETE') {
      await store.remove(name, id);
      return json(res, 200, { ...toPublic(current), deleted: true, deleted_at: new Date().toISOString() }, headers);
    }
    throw new HttpError(405, 'method_not_allowed', 'Use GET, PUT, PATCH or DELETE', { Allow: 'GET, PUT, PATCH, DELETE' });
  }

  function selectFrom(q, idField) {
    const raw = q.getAll('select').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    return raw.length ? [...new Set([idField, ...raw])] : null;
  }

  function intParam(q, key, { min, fallback }) {
    if (!q.has(key)) return fallback;
    const v = Number(q.get(key));
    if (!Number.isInteger(v) || v < min) throw new HttpError(400, 'invalid_request', `${key} must be an integer >= ${min}`);
    return v;
  }

  async function listRecords(res, def, q, headers, meta) {
    const query = { eq: {} };
    if (q.get('updated_since')) {
      query.since = parseUpdatedSince(q.get('updated_since'));
      if (!query.since) throw new HttpError(400, 'invalid_request', 'updated_since must be ISO 8601, e.g. 2026-11-18T02:00:00Z');
    }
    if (q.get('q')) query.q = q.get('q');
    for (const [k, v] of q) if (!LIST_PARAMS.has(k)) query.eq[k] = v;

    const order = q.get('order') === 'desc' ? 'desc' : 'asc';
    const sortBy = q.get('sortBy') || undefined;
    if (sortBy && !/^[\w.]+$/.test(sortBy)) throw new HttpError(400, 'invalid_request', 'sortBy must be a field name');
    const select = selectFrom(q, def.id_field);

    // dummyjson style: ?limit=&skip=  → { <name>, total, skip, limit }
    if (q.has('limit') || q.has('skip')) {
      const limit = Math.min(intParam(q, 'limit', { min: 0, fallback: 30 }), 1000);
      const skip = intParam(q, 'skip', { min: 0, fallback: 0 });
      const { total, items } = await store.find(def.name, def.id_field, { query, sortBy, order, skip, limit: limit || 1000 });
      state.stats.api_ok++;
      return json(res, 200, { [def.name]: items.map((d) => toPublic(d, select, meta)), total, skip, limit: items.length },
        { ...headers, 'X-Total-Count': String(total) });
    }

    // Upstream-contract style: ?page=&page_size=  → { page, total_pages, <name> }
    const page = intParam(q, 'page', { min: 1, fallback: 1 });
    const pageSize = Math.min(intParam(q, 'page_size', { min: 1, fallback: config.maxPageSize }), config.maxPageSize);
    const { total, items } = await store.find(def.name, def.id_field, {
      query, sortBy, order, skip: (page - 1) * pageSize, limit: pageSize,
    });
    // total_pages is at least 1, so "page == total_pages" always terminates even with no data.
    const total_pages = Math.max(1, Math.ceil(total / pageSize));
    state.stats.api_ok++;
    return json(res, 200, { page, total_pages, [def.name]: items.map((d) => toPublic(d, select, meta)) },
      { ...headers, 'X-Total-Count': String(total) });
  }

  // ---- Admin API (UI + test controls) ------------------------------------------
  async function handleAdmin(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "__admin"
    const [section, name, action] = parts;
    const m = req.method;

    if (m === 'GET' && section === 'info') {
      return json(res, 200, {
        storage: store.kind,
        oauth: {
          token_path: '/oauth/token',
          grant_type: 'client_credentials',
          token_ttl_seconds: config.tokenTtlSeconds,
          client_auth: ['client_secret_basic', 'client_secret_post'],
        },
        rate_limit: { max: config.rateLimitMax, window_seconds: config.rateLimitWindowSeconds },
        max_page_size: config.maxPageSize,
      });
    }
    if (m === 'GET' && section === 'state') {
      return json(res, 200, {
        chaos: state.chaos,
        stats: state.stats,
        active_tokens: state.tokens.size,
        recent_requests: state.requests.slice(-100).reverse(),
      });
    }
    if (m === 'POST' && section === 'chaos') {
      const body = await readJson(req);
      for (const k of Object.keys(state.chaos)) {
        if (body[k] !== undefined) state.chaos[k] = Math.max(0, Math.min(k === 'delay_ms' ? 30000 : 100, Number(body[k]) || 0));
      }
      return json(res, 200, { chaos: state.chaos });
    }
    if (m === 'POST' && section === 'revoke-tokens') {
      const n = state.tokens.size;
      state.tokens.clear();
      return json(res, 200, { revoked: n });
    }
    if (m === 'POST' && section === 'touch') {
      // Mark VMs as changed now, to test delta loads. Body: { "vm_ids": [...] } or { "count": n }
      const body = await readJson(req);
      const { items } = await store.find('vms', 'vm_id', {});
      let targets;
      if (Array.isArray(body.vm_ids)) targets = items.filter((v) => body.vm_ids.includes(v.vm_id));
      else targets = items.sort(() => Math.random() - 0.5).slice(0, Math.min(Number(body.count) || 5, items.length));
      const now = new Date();
      for (const vm of targets) {
        const doc = stripInternal(vm);
        if (body.bump_last_seen !== false) doc.last_seen = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
        await store.replace('vms', 'vm_id', vm.vm_id, doc);
      }
      return json(res, 200, { touched: targets.map((v) => v.vm_id), updated_at: now.toISOString() });
    }
    if (m === 'POST' && section === 'samples' && name === 'vms') {
      // Restore the sample VM collection (recreates it if it was deleted).
      await seedVms({ replace: true });
      return json(res, 200, { restored: 'vms' });
    }
    if (m === 'POST' && section === 'reset') {
      await seedVms({ replace: true });
      state.tokens.clear();
      state.rate.clear();
      for (const k of Object.keys(state.chaos)) state.chaos[k] = 0;
      for (const k of Object.keys(state.stats)) state.stats[k] = 0;
      state.requests = [];
      return json(res, 200, { reset: true });
    }
    if (m === 'GET' && section === 'vms' && !name) {
      // Full VM dataset including internal _updated_at, for test verification.
      const { items } = await store.find('vms', 'vm_id', {});
      return json(res, 200, { count: items.length, vms: items.map(({ _search, ...rest }) => rest) });
    }

    if (section === 'resources') {
      if (!name) {
        if (m === 'GET') return json(res, 200, { resources: await store.listResources() });
        if (m === 'POST') {
          const body = await readJson(req);
          const rname = String(body.name || '').trim().toLowerCase();
          if (!RESOURCE_NAME.test(rname)) {
            throw new HttpError(400, 'invalid_request', 'name must start with a letter and use only a-z, 0-9, _ or - (max 40)');
          }
          const id_field = String(body.id_field || 'id').trim();
          if (!/^[A-Za-z_][\w]{0,39}$/.test(id_field)) throw new HttpError(400, 'invalid_request', 'id_field must be a simple field name');
          const def = await store.createResource({
            name: rname,
            id_field,
            auth_required: body.auth_required === true, // new collections start public
            description: String(body.description || '').slice(0, 200),
          });
          if (Array.isArray(body.records) && body.records.length) await importRecords(def, body.records, 'append');
          return json(res, 201, def);
        }
      }
      const def = await store.getResource(name);
      if (!def) throw new HttpError(404, 'not_found', `Resource "${name}" does not exist`);
      if (!action) {
        if (m === 'PATCH') {
          const body = await readJson(req);
          const patch = {};
          if (typeof body.auth_required === 'boolean') patch.auth_required = body.auth_required;
          if (typeof body.description === 'string') patch.description = body.description.slice(0, 200);
          return json(res, 200, await store.updateResource(name, patch));
        }
        if (m === 'DELETE') {
          await store.deleteResource(name);
          // Remember that the sample collection was removed so a restart doesn't bring it back.
          if (def.builtin) await store.setMeta('vms_sample_deleted', true);
          // Remove this collection from every credential's grants.
          for (const c of (await store.listCredentials()).map(normalizeCred)) {
            if (c.grants.some((g) => g.resource === name)) {
              await store.updateCredential(c.id, { grants: c.grants.filter((g) => g.resource !== name) });
              revokeTokensWhere((t) => t.credId === c.id);
            }
          }
          return json(res, 200, { deleted: name });
        }
      }
      if (m === 'POST' && action === 'import') {
        const body = await readJson(req);
        const records = Array.isArray(body) ? body : body.records;
        if (!Array.isArray(records)) throw new HttpError(400, 'invalid_request', 'Send a JSON array of records, or { "records": [...], "mode": "append" | "replace" }');
        const n = await importRecords(def, records, body.mode === 'replace' ? 'replace' : 'append');
        return json(res, 200, { imported: n });
      }
      if (m === 'POST' && action === 'reset') {
        if (def.builtin) await seedVms({ replace: true });
        else await store.clear(name);
        return json(res, 200, { reset: name });
      }
    }

    if (section === 'credentials') {
      if (!name && m === 'GET') {
        const all = (await store.listCredentials()).map(publicCredential);
        return json(res, 200, { credentials: all });
      }
      if (!name && m === 'POST') {
        const body = await readJson(req);
        const type = body.type;
        if (!TYPES.includes(type)) throw new HttpError(400, 'invalid_request', 'type must be "api_key", "basic" or "oauth_client"');
        const grants = await validateGrants(body.grants, type);
        const { secret, fields } = issueSecret(type);
        const label = String(body.label || '').trim().slice(0, 80) || { api_key: 'API key', basic: 'Basic user', oauth_client: 'OAuth client' }[type];
        const cred = {
          id: `cred_${crypto.randomBytes(8).toString('hex')}`,
          type, label, grants,
          disabled: false,
          expires_at: parseExpiry(body.expires_at),
          created_at: new Date().toISOString(),
          last_used_at: null,
          ...fields,
        };
        if (type === 'oauth_client') {
          cred.client_id = `ic_${crypto.randomBytes(10).toString('hex')}`;
          cred.token_ttl_seconds = parseTtl(body.token_ttl_seconds);
        }
        if (type === 'basic') {
          let username = String(body.username || '').trim();
          if (username) {
            if (!/^[A-Za-z0-9._@-]{3,64}$/.test(username)) throw new HttpError(400, 'invalid_request', 'Username must be 3–64 characters: letters, numbers, . _ @ -');
            if (await store.findCredential({ username })) throw new HttpError(409, 'conflict', `Username "${username}" is taken`);
          } else {
            const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'user';
            username = `${base}-${crypto.randomBytes(3).toString('hex')}`;
          }
          cred.username = username;
        }
        await store.createCredential(cred);
        return json(res, 201, { ...publicCredential(cred), [SECRET_FIELD[type]]: secret });
      }
      const cred = normalizeCred(name ? await store.findCredential({ id: name }) : null);
      if (!cred) throw new HttpError(404, 'not_found', 'Credential not found');
      if (m === 'PATCH' && !action) {
        const body = await readJson(req);
        const patch = {};
        if (typeof body.label === 'string') patch.label = body.label.trim().slice(0, 80) || cred.label;
        if (body.grants !== undefined) patch.grants = await validateGrants(body.grants, cred.type);
        if (body.expires_at !== undefined) patch.expires_at = parseExpiry(body.expires_at);
        if (typeof body.disabled === 'boolean') patch.disabled = body.disabled;
        if (cred.type === 'oauth_client' && body.token_ttl_seconds !== undefined) patch.token_ttl_seconds = parseTtl(body.token_ttl_seconds);
        const updated = await store.updateCredential(cred.id, patch);
        // Tokens carry the access they were issued with; drop them so changes apply now.
        if (patch.grants || patch.disabled || patch.expires_at !== undefined) revokeTokensWhere((t) => t.credId === cred.id);
        return json(res, 200, publicCredential(updated));
      }
      if (m === 'POST' && action === 'rotate') {
        const { secret, fields } = issueSecret(cred.type);
        const updated = await store.updateCredential(cred.id, { ...fields, rotated_at: new Date().toISOString() });
        revokeTokensWhere((t) => t.credId === cred.id);
        return json(res, 200, { ...publicCredential(updated), [SECRET_FIELD[cred.type]]: secret });
      }
      if (m === 'DELETE' && !action) {
        await store.deleteCredential(cred.id);
        revokeTokensWhere((t) => t.credId === cred.id);
        return json(res, 200, { deleted: cred.id });
      }
    }
    throw new HttpError(404, 'not_found', `No admin route for ${m} ${url.pathname}`);
  }

  async function importRecords(def, records, mode) {
    const docs = [];
    const seen = new Set();
    for (const r of records) {
      const doc = prepare(def, r);
      doc[def.id_field] ??= await newId(def);
      if (seen.has(doc[def.id_field])) throw new HttpError(400, 'invalid_request', `Duplicate ${def.id_field} "${doc[def.id_field]}" in import`);
      seen.add(doc[def.id_field]);
      docs.push(doc);
    }
    if (mode === 'replace') await store.clear(def.name);
    return store.insertMany(def.name, def.id_field, docs);
  }

  // ---- Static UI ---------------------------------------------------------------
  async function serveStatic(res, pathname) {
    const [file, type] = STATIC[pathname];
    try {
      const body = await fs.readFile(path.join(PUBLIC_DIR, file));
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        ...(file.endsWith('.html') ? { 'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'" } : {}),
      });
      res.end(body);
    } catch {
      json(res, 404, { error: 'not_found' });
    }
  }

  // ---- Router --------------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const authz = req.headers.authorization || '';
    const actor = req.headers['x-api-key'] ? 'api_key' : /^Bearer /i.test(authz) ? 'oauth' : /^Basic /i.test(authz) && url.pathname.startsWith('/api/') ? 'basic' : 'public';

    res.on('finish', () => {
      if (url.pathname.startsWith('/__admin') || STATIC[url.pathname]) return; // keep the log about API traffic
      const entry = {
        at: new Date(started).toISOString(),
        method: req.method,
        path: url.pathname,
        query: url.search || undefined,
        status: res.statusCode,
        ms: Date.now() - started,
        actor,
      };
      state.requests.push(entry);
      if (state.requests.length > 300) state.requests.shift();
      log(`${entry.at} ${entry.method} ${entry.path}${entry.query || ''} -> ${entry.status} (${entry.ms}ms) [${actor}]`);
    });

    try {
      if (req.method === 'GET' && STATIC[url.pathname]) return await serveStatic(res, url.pathname);
      if (url.pathname === '/health' && req.method === 'GET') {
        return json(res, 200, { status: 'ok', storage: store.kind, time: new Date().toISOString() });
      }
      if (url.pathname === '/oauth/token') {
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST', { Allow: 'POST' });
        return await handleToken(req, res);
      }
      const api = url.pathname.match(/^\/api\/v1\/([^/]+)(?:\/([^/]+))?\/?$/);
      if (api) return await handleResource(req, res, url, api[1], api[2] === undefined ? undefined : decodeURIComponent(api[2]));
      const data = url.pathname.match(/^\/__admin\/data\/([^/]+)(?:\/([^/]+))?\/?$/);
      if (data) {
        return await handleResource(req, res, url, data[1], data[2] === undefined ? undefined : decodeURIComponent(data[2]), { trusted: true });
      }
      if (url.pathname.startsWith('/__admin/')) return await handleAdmin(req, res, url);
      throw new HttpError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
    } catch (err) {
      let status = err.status || 500;
      if (err instanceof ConflictError) status = 409;
      if (err instanceof NotFoundError) status = 404;
      const error = err.error || (status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'server_error');
      if (url.pathname.startsWith('/api/')) {
        if (status === 401) state.stats.api_401++;
        else if (status === 429) state.stats.api_429++;
        else if (status >= 500) state.stats.api_5xx++;
        else state.stats.api_4xx++;
      }
      if (status === 500) log(`ERROR ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) json(res, status, { error, error_description: err.message }, err.headers || {});
    }
  });

  return { server, state, store };
}
