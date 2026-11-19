// Shared test helpers. There are no built-in credentials, so tests create them
// through the management API exactly like the UI does.

// The access ServiceNow needs: read (and optionally write) on every collection,
// exposed under the scope names from the integration spec.
export const SERVICENOW_GRANTS = [
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

export async function createOAuthClient(base, grants = SERVICENOW_GRANTS, extra = {}) {
  const c = await createCredential(base, { type: 'oauth_client', label: 'test client', grants, ...extra });
  return { id: c.client_id, secret: c.client_secret, credential: c };
}
