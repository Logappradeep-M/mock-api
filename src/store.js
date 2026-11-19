// Storage layer: resources (collections) and their records.
// Two interchangeable implementations with the same async API:
//   MongoStore  – used when MONGODB_URI is set and reachable
//   MemoryStore – used in tests, or as a fallback when MongoDB isn't available
//
// Records are stored as given, plus internal fields that the API never returns:
//   _updated_at (Date)  – drives ?updated_since delta queries
//   _created_at (Date)
//   _search     (string) – lowercase JSON of the record, for ?q= search

export class ConflictError extends Error {
  constructor(msg) { super(msg); this.status = 409; }
}
export class NotFoundError extends Error {
  constructor(msg) { super(msg); this.status = 404; }
}

const INTERNAL = new Set(['_id', '_updated_at', '_created_at', '_search']);

export function stripInternal(doc) {
  if (!doc) return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

function withMeta(doc, { created } = {}) {
  const now = new Date();
  const clean = stripInternal(doc);
  return {
    ...clean,
    _updated_at: doc._updated_at ? new Date(doc._updated_at) : now,
    _created_at: created ? new Date(created) : now,
    _search: JSON.stringify(clean).toLowerCase(),
  };
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Query: { since?: Date, q?: string, eq?: { 'field.path': string } }
function matchesMemory(doc, query) {
  if (query.since && !(doc._updated_at >= query.since)) return false;
  if (query.q && !doc._search.includes(query.q.toLowerCase())) return false;
  for (const [field, value] of Object.entries(query.eq || {})) {
    const v = getPath(doc, field);
    if (v === undefined || String(v) !== value) return false;
  }
  return true;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------

export class MemoryStore {
  kind = 'memory';
  #resources = new Map();
  #records = new Map(); // name -> Map(id -> doc)

  async init() {}
  async close() {}

  async listResources() {
    return [...this.#resources.values()].map((r) => ({ ...r, count: this.#records.get(r.name).size }));
  }
  async getResource(name) {
    const r = this.#resources.get(name);
    return r ? { ...r } : null;
  }
  async createResource(def) {
    if (this.#resources.has(def.name)) throw new ConflictError(`Resource "${def.name}" already exists`);
    this.#resources.set(def.name, { next_id: 1, ...def, created_at: new Date().toISOString() });
    this.#records.set(def.name, new Map());
    return this.getResource(def.name);
  }
  async updateResource(name, patch) {
    const r = this.#resources.get(name);
    if (!r) throw new NotFoundError(`Resource "${name}" not found`);
    Object.assign(r, patch);
    return { ...r };
  }
  async deleteResource(name) {
    this.#resources.delete(name);
    this.#records.delete(name);
  }
  async nextId(name) {
    const r = this.#resources.get(name);
    return r.next_id++;
  }

  // Credentials (API keys and OAuth clients). Secrets are stored only as hashes.
  #creds = new Map();
  async listCredentials() {
    return [...this.#creds.values()].map((c) => structuredClone(c))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async findCredential(by) {
    const [k, v] = Object.entries(by)[0];
    const c = [...this.#creds.values()].find((x) => x[k] === v);
    return c ? structuredClone(c) : null;
  }
  async createCredential(cred) {
    this.#creds.set(cred.id, structuredClone(cred));
    return structuredClone(cred);
  }
  async updateCredential(id, patch) {
    const c = this.#creds.get(id);
    if (!c) throw new NotFoundError('Credential not found');
    Object.assign(c, structuredClone(patch));
    return structuredClone(c);
  }
  async deleteCredential(id) {
    return this.#creds.delete(id);
  }
  async deleteCredentialsFor(resource) {
    for (const [id, c] of this.#creds) if (c.resource === resource) this.#creds.delete(id);
  }

  #col(name) {
    const c = this.#records.get(name);
    if (!c) throw new NotFoundError(`Resource "${name}" not found`);
    return c;
  }

  async find(name, idField, { query = {}, sortBy, order = 'asc', skip = 0, limit = 0 } = {}) {
    let items = [...this.#col(name).values()].filter((d) => matchesMemory(d, query));
    const field = sortBy || idField;
    const dir = order === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      const va = getPath(a, field);
      const vb = getPath(b, field);
      if (va === vb) return 0;
      if (va === undefined || va === null) return 1;
      if (vb === undefined || vb === null) return -1;
      if (va instanceof Date || typeof va === 'number') return (va < vb ? -1 : 1) * dir;
      return collator.compare(String(va), String(vb)) * dir;
    });
    const total = items.length;
    items = limit ? items.slice(skip, skip + limit) : items.slice(skip);
    return { total, items: items.map((d) => structuredClone(d)) };
  }
  async get(name, id) {
    const d = this.#col(name).get(String(id));
    return d ? structuredClone(d) : null;
  }
  async insert(name, idField, doc) {
    const c = this.#col(name);
    const id = String(doc[idField]);
    if (c.has(id)) throw new ConflictError(`${idField} "${id}" already exists`);
    const stored = withMeta(doc);
    c.set(id, stored);
    return structuredClone(stored);
  }
  async insertMany(name, idField, docs) {
    for (const d of docs) await this.insert(name, idField, d);
    return docs.length;
  }
  async replace(name, idField, id, doc) {
    const c = this.#col(name);
    const prev = c.get(String(id));
    if (!prev) throw new NotFoundError(`${idField} "${id}" not found`);
    const newId = String(doc[idField]);
    if (newId !== String(id) && c.has(newId)) throw new ConflictError(`${idField} "${newId}" already exists`);
    const stored = withMeta({ ...doc, _updated_at: doc._updated_at }, { created: prev._created_at });
    c.delete(String(id));
    c.set(newId, stored);
    return structuredClone(stored);
  }
  async remove(name, id) {
    return this.#col(name).delete(String(id));
  }
  async clear(name) {
    this.#col(name).clear();
  }
}

// ---------------------------------------------------------------------------

export class MongoStore {
  kind = 'mongodb';
  #client;
  #db;

  constructor(uri, dbName) {
    this.uri = uri;
    this.dbName = dbName;
  }

  async init() {
    const { MongoClient } = await import('mongodb');
    this.#client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 3000 });
    await this.#client.connect();
    this.#db = this.#client.db(this.dbName);
    await this.#db.collection('resources').createIndex({ name: 1 }, { unique: true });
    const creds = this.#db.collection('credentials');
    await creds.createIndex({ id: 1 }, { unique: true });
    await creds.createIndex({ key_hash: 1 }, { unique: true, partialFilterExpression: { key_hash: { $type: 'string' } } });
    await creds.createIndex({ client_id: 1 }, { unique: true, partialFilterExpression: { client_id: { $type: 'string' } } });
    await creds.createIndex({ username: 1 }, { unique: true, partialFilterExpression: { username: { $type: 'string' } } });
  }

  // Credentials (API keys and OAuth clients). Secrets are stored only as hashes.
  #creds() { return this.#db.collection('credentials'); }
  async listCredentials() {
    return this.#creds().find({}, { projection: { _id: 0 } }).sort({ created_at: 1 }).toArray();
  }
  async findCredential(by) {
    return this.#creds().findOne(by, { projection: { _id: 0 } });
  }
  async createCredential(cred) {
    await this.#creds().insertOne({ ...cred });
    return cred;
  }
  async updateCredential(id, patch) {
    const r = await this.#creds().findOneAndUpdate({ id }, { $set: patch }, { returnDocument: 'after', projection: { _id: 0 } });
    if (!r) throw new NotFoundError('Credential not found');
    return r;
  }
  async deleteCredential(id) {
    return (await this.#creds().deleteOne({ id })).deletedCount > 0;
  }
  async deleteCredentialsFor(resource) {
    await this.#creds().deleteMany({ resource });
  }
  async close() {
    await this.#client?.close();
  }
  // Used by tests to remove their temporary database.
  async dropDatabase() {
    await this.#db.dropDatabase();
  }

  #meta() { return this.#db.collection('resources'); }
  #col(name) { return this.#db.collection(`res_${name}`); }

  async listResources() {
    const defs = await this.#meta().find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray();
    return Promise.all(defs.map(async (r) => ({ ...r, count: await this.#col(r.name).estimatedDocumentCount() })));
  }
  async getResource(name) {
    return this.#meta().findOne({ name }, { projection: { _id: 0 } });
  }
  async createResource(def) {
    try {
      await this.#meta().insertOne({ next_id: 1, ...def, created_at: new Date().toISOString() });
    } catch (e) {
      if (e.code === 11000) throw new ConflictError(`Resource "${def.name}" already exists`);
      throw e;
    }
    await this.#col(def.name).createIndex({ [def.id_field]: 1 }, { unique: true });
    await this.#col(def.name).createIndex({ _updated_at: 1 });
    return this.getResource(def.name);
  }
  async updateResource(name, patch) {
    const r = await this.#meta().findOneAndUpdate(
      { name }, { $set: patch }, { returnDocument: 'after', projection: { _id: 0 } },
    );
    if (!r) throw new NotFoundError(`Resource "${name}" not found`);
    return r;
  }
  async deleteResource(name) {
    await this.#meta().deleteOne({ name });
    await this.#col(name).drop().catch(() => {});
  }
  async nextId(name) {
    const r = await this.#meta().findOneAndUpdate(
      { name }, { $inc: { next_id: 1 } }, { returnDocument: 'before' },
    );
    return r.next_id;
  }

  #filter(query) {
    const f = {};
    if (query.since) f._updated_at = { $gte: query.since };
    if (query.q) f._search = { $regex: query.q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    for (const [field, value] of Object.entries(query.eq || {})) {
      const variants = [value];
      if (value !== '' && !Number.isNaN(Number(value))) variants.push(Number(value));
      if (value === 'true' || value === 'false') variants.push(value === 'true');
      f[field] = { $in: variants };
    }
    return f;
  }

  async find(name, idField, { query = {}, sortBy, order = 'asc', skip = 0, limit = 0 } = {}) {
    const filter = this.#filter(query);
    const col = this.#col(name);
    const [total, items] = await Promise.all([
      col.countDocuments(filter),
      col.find(filter, { projection: { _id: 0 } })
        .collation({ locale: 'en', numericOrdering: true })
        .sort({ [sortBy || idField]: order === 'desc' ? -1 : 1, _created_at: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);
    return { total, items };
  }
  async get(name, id) {
    const r = await this.getResource(name);
    if (!r) throw new NotFoundError(`Resource "${name}" not found`);
    return this.#col(name).findOne({ [r.id_field]: String(id) }, { projection: { _id: 0 } });
  }
  async insert(name, idField, doc) {
    const stored = withMeta(doc);
    try {
      await this.#col(name).insertOne(stored);
    } catch (e) {
      if (e.code === 11000) throw new ConflictError(`${idField} "${doc[idField]}" already exists`);
      throw e;
    }
    delete stored._id;
    return stored;
  }
  async insertMany(name, idField, docs) {
    if (!docs.length) return 0;
    try {
      const r = await this.#col(name).insertMany(docs.map((d) => withMeta(d)), { ordered: true });
      return r.insertedCount;
    } catch (e) {
      if (e.code === 11000) throw new ConflictError(`Duplicate ${idField} in import: ${e.message}`);
      throw e;
    }
  }
  async replace(name, idField, id, doc) {
    const col = this.#col(name);
    const prev = await col.findOne({ [idField]: String(id) });
    if (!prev) throw new NotFoundError(`${idField} "${id}" not found`);
    const stored = withMeta({ ...doc, _updated_at: doc._updated_at }, { created: prev._created_at });
    try {
      await col.replaceOne({ _id: prev._id }, stored);
    } catch (e) {
      if (e.code === 11000) throw new ConflictError(`${idField} "${doc[idField]}" already exists`);
      throw e;
    }
    return stored;
  }
  async remove(name, id) {
    const r = await this.getResource(name);
    const res = await this.#col(name).deleteOne({ [r.id_field]: String(id) });
    return res.deletedCount > 0;
  }
  async clear(name) {
    await this.#col(name).deleteMany({});
  }
}

export async function openStore(config, log = console.log) {
  if (config.mongoUri) {
    const store = new MongoStore(config.mongoUri, config.mongoDb);
    try {
      await store.init();
      log(`Storage: MongoDB (${config.mongoDb})`);
      return store;
    } catch (e) {
      if (config.requireMongo) throw e;
      log(`Storage: MongoDB unreachable (${e.message}). Falling back to in-memory storage; data resets on restart.`);
    }
  } else {
    log('Storage: in-memory (set MONGODB_URI to persist). Data resets on restart.');
  }
  const mem = new MemoryStore();
  await mem.init();
  return mem;
}
