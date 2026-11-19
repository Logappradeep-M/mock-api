// Shared test helpers. There are no built-in credentials, so tests create them
// through the management API exactly like the UI does.

// Full access to every collection, exposed under custom scope names
// (inventory.read / inventory.write) so tests also cover custom scopes.
export const FULL_ACCESS_GRANTS = [
  { resource: '*', permissions: ['read'], scope: 'inventory.read' },
  { resource: '*', permissions: ['write'], scope: 'inventory.write' },
];

export async function createCredential(base, body) {
  const r = await fetch(`${base}/__admin/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (r.status !== 201) throw new Error(`createCredential failed: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

export async function createOAuthClient(base, grants = FULL_ACCESS_GRANTS, extra = {}) {
  const c = await createCredential(base, { type: 'oauth_client', label: 'test client', grants, ...extra });
  return { id: c.client_id, secret: c.client_secret, credential: c };
}
