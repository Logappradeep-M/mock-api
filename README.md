# Mock API Studio

Build mock REST APIs from a web UI, in the spirit of [mockapi.io](https://mockapi.io) and [dummyjson.com](https://dummyjson.com). Create collections, edit records, and protect them with OAuth 2.0 clients, API keys or Basic logins. Whatever you save in the UI is what the API returns.

It ships with a sample `vms` collection: 450 cloud VMs, including deliberately messy records, so there's something realistic to call right away.

## Run

```bash
npm install
cp .env.example .env      # then set MONGODB_URI
npm start                 # API and UI on http://localhost:3000
npm test                  # unit tests
npm run test:e2e          # end-to-end test against a real server process (see below)
```

Open `http://localhost:3000`. The UI is open to everyone, like mockapi.io; there is no admin key. No credentials exist until you create them on the **Credentials** page.

### MongoDB

The server stores data in MongoDB when `MONGODB_URI` is reachable. Otherwise it falls back to in-memory storage and resets on restart; the UI's sidebar shows which one is in use. To install MongoDB locally on macOS:

```bash
brew tap mongodb/brew
brew trust mongodb/brew
brew install mongodb-community
brew services start mongodb-community
```

MongoDB Atlas works too: put its connection string in `MONGODB_URI`. On the first start the server creates the `vms` resource and loads it with the generated inventory. After that your edits persist. Set `REQUIRE_MONGODB=true` to make startup fail instead of falling back to memory.

To run the CRUD and credential tests against MongoDB: `TEST_MONGODB_URI=<your uri> npm test`. They use a temporary `mock_test_*` database and drop it afterwards.

## The UI

- **Resources**: a sortable, searchable table for each resource. VMs get a form editor (identity, guest OS, hardware, ownership, installed software) and a JSON tab. Other resources get a JSON editor. You can create, duplicate and delete records, and undo a delete.
- **New Resource**: create any collection, such as `users` or `cost_centers`, with its own ID field. Choose whether API callers need an OAuth token or can use it publicly, like mockapi.io. You can add starting records, or import a JSON array later.
- **Credentials**: create API keys, Basic logins and OAuth clients. Give each one access to one, several or all collections, with read and/or write, custom OAuth scope names, an expiry and a token lifetime. Filter by type or collection, see when each was last used, turn them off and on, edit, rotate or revoke them. Secrets are shown once, with copy buttons and ready-made headers.
- **Connection**: the token URL, endpoint URLs and curl examples.
- **Test Controls**: force 401, 429 or 503 responses, add latency, revoke tokens, mark VMs as changed, or reset everything.
- **Request Log**: live view of API calls, showing who called (OAuth, public or the UI), the status code and duration.

Keyboard: `/` search, `N` new record, `⌘S` save, `Esc` close the editor, arrow keys move between rows.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/oauth/token` | OAuth 2.0 token endpoint. Only `client_credentials` is accepted. |
| GET | `/api/v1/<resource>` | List records (see query params below) |
| POST | `/api/v1/<resource>` | Create a record. If the ID field is missing, one is generated. Returns `201`, or `409` if the ID already exists. |
| GET | `/api/v1/<resource>/<id>` | One record |
| PUT | `/api/v1/<resource>/<id>` | Replace a record. Changing the ID field in the body renames it. |
| PATCH | `/api/v1/<resource>/<id>` | JSON Merge Patch: nested objects merge and `null` removes a field |
| DELETE | `/api/v1/<resource>/<id>` | Delete a record. Returns the deleted record with `deleted: true`. |
| GET | `/health` | Liveness check and storage type, no auth. |
| * | `/__admin/*` | Used by the UI and for test controls. Open to everyone. The UI reads and writes records through `/__admin/data/<collection>`, which skips credentials. |

**Access.** Each collection is either public, meaning anyone can call it, or private (`vms` is private, and new collections start public). A private collection accepts any credential that has a grant for it:

| Type | How callers send it |
|---|---|
| **API key** | `X-API-Key: imk_…` header |
| **Basic auth** | `Authorization: Basic base64(username:password)`, e.g. `curl -u user:pass` |
| **OAuth client** | `POST /oauth/token` (client credentials, with the client ID and secret in a Basic header or the form body), then `Authorization: Bearer …` |

Create credentials on the **Credentials** page. Each one has:

- **Grants**: one or more rows, each with a collection (or *All collections*) and Read and/or Write. Read covers GET; Write covers POST, PUT, PATCH and DELETE.
- **Scopes** (OAuth only): each grant row unlocks `<collection>.read` / `<collection>.write`, or `all.read` / `all.write` for *All collections*. You can give a row a custom scope name instead, e.g. `inventory.read` → vms read. A token gets only the scopes it requests, or all of them if it requests none.
- **Expiry** (never, 7/30/90/365 days, or a date), an **Enabled** switch, and for OAuth clients a **token lifetime** (30–86400 s).

Secrets are random, shown once when created or rotated, and stored only as SHA-256 hashes. Disabling, expiring, editing grants, rotating and revoking all take effect immediately and cancel existing OAuth tokens. Deleting a collection removes it from every credential's grants. Each credential has its own rate limit, and the simulated failures in Test Controls apply to every credential type.

Credential admin routes: `GET|POST /__admin/credentials` (body `{ "type": "api_key" | "basic" | "oauth_client", "label", "grants": [{ "resource": "vms" | "*", "permissions": ["read","write"], "scope"? }], "expires_at"?, "token_ttl_seconds"?, "username"? }`), `PATCH /__admin/credentials/<id>` (`label`, `grants`, `expires_at`, `disabled`, `token_ttl_seconds`), `POST /__admin/credentials/<id>/rotate`, `DELETE /__admin/credentials/<id>`.

**List query params** (any resource):

| Param | Example | Notes |
|---|---|---|
| `page`, `page_size` | `?page=2&page_size=200` | Default style. Response is `{ page, total_pages, <resource>: [...] }`. `page_size` is capped at 200. |
| `limit`, `skip` | `?limit=10&skip=20` | dummyjson style. Response is `{ <resource>: [...], total, skip, limit }`. `limit=0` returns up to 1000. |
| `updated_since` | `?updated_since=2026-11-18 02:00:00` | Records created or changed at or after this time |
| `q` | `?q=ubuntu` | Case-insensitive search across the whole record |
| `sortBy`, `order` | `?sortBy=hostname&order=desc` | Dotted paths work, e.g. `guest_os.family` |
| `select` | `?select=hostname,ip_address` | The ID field is always included |
| any field | `?status=running&guest_os.family=Linux` | Exact match. Numbers and booleans also match their string form. |
| `delay` | `?delay=1500` | Waits this many ms before responding (0–5000) |

Every list response sets an `X-Total-Count` header.

### POST /oauth/token

The server takes client credentials as an HTTP Basic header (`client_secret_basic`) or as body fields (`client_secret_post`). It accepts form-encoded or JSON bodies.

```bash
curl -X POST http://localhost:3000/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \   # an OAuth client created on the Credentials page
  -d grant_type=client_credentials -d scope=inventory.read
```
```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 3600, "scope": "inventory.read" }
```
Errors follow RFC 6749: `401 invalid_client`, `400 unsupported_grant_type`, `400 invalid_scope`.

### GET /api/v1/vms

```json
{ "page": 1, "total_pages": 3, "vms": [ … ] }
```

- **`updated_since`** (optional): accepts ISO 8601 (`2026-11-18T02:00:00Z`, `+05:30` offsets), a date only (`2026-11-18`), or a space-separated date-time (`2026-11-18 02:00:00`, read as UTC). The filter is inclusive (`>=`). An invalid value returns `400`.
- **`page`**: starts at 1. A page past the end returns `vms: []`.
- **`page_size`**: defaults to 200 and is capped at 200.
- **`total_pages`** is always at least 1, so a loop that stops at `page == total_pages` ends even when the result is empty.
- Response headers: `X-Total-Count`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

| Status | When | What a client should do |
|---|---|---|
| 401 + `WWW-Authenticate` | Credential missing, unknown, disabled, expired or revoked; token expired | Get a new token and retry once |
| 403 `insufficient_scope` | The credential has no read (or write) access to this collection | Stop and report the error |
| 429 + `Retry-After` | Over `RATE_LIMIT_MAX` requests per window | Wait `Retry-After` seconds, then retry |
| 503 + `Retry-After` | Only when triggered from Test Controls | Retry later |
| 400 | Bad `page`, `page_size` or `updated_since` | Fix the request |

## Sample data

The `vms` collection has 450 VMs (3 pages at 200 per page), generated from `DATA_SEED`, so every restart produces the same data. The first four records (`vm-001` to `vm-004`) are hand-written examples. The rest deliberately include messy values, useful for testing how a client cleans and validates data:

| Field | Messy values in the data |
|---|---|
| `hostname` | `" WEB-PROD-01 "`, upper-case names, `""`, `"   "`, missing, duplicates on different `vm_id` |
| `ip_address` | `999.1.1.1`, `256.10.0.1`, `10.0.0`, `10.0.0.1.5`, `not-an-ip`, `fe80::1`, empty |
| `guest_os.family` | Linux and Windows in mixed case, other families (`FreeBSD`, `Solaris`), empty, missing |
| `guest_os.name` | `Win Server 2022`, `Win2019`, `Microsoft Windows Server 2019 Datacenter`, `RHEL` vs `Red Hat Enterprise Linux`, `ubuntu` vs `Ubuntu` |
| `cpu_manufacturer` | `Intel Corporation`, `GenuineIntel`, `intel`, `AuthenticAMD`, `AMD`, `Advanced Micro Devices, Inc.` |
| `manufacturer` / `model` | `VMware, Inc.`, `Amazon EC2`, `Microsoft Corporation`, `Google`, upper-case variants, missing |
| `environment` | `Production`/`Prod`/`PROD`, `Development`/`Dev`, `QA`, `Test`, `UAT`, `Staging`, `stage`, `DR`, `Sandbox` |
| `owner_email` | `alice@` … `erin@acme.com`, upper-case and padded variants, unknown users |
| `cost_center` | `CC100`–`CC400`, `CC999`, lower-case `cc100`, missing |
| `status` | `running`, `stopped`, `terminated`, `suspended`, `pending` |
| `ram_gb` | Includes fractional `0.5` |
| `installed_software` | Sometimes lists the same item twice |

You can delete the `vms` collection like any other; it stays deleted after a restart. **Test Controls → Restore Sample VMs** brings it back.

## Test controls (`/__admin`)

```bash
# Next call gets 401 → test "refresh token and retry once"
curl -X POST localhost:3000/__admin/chaos -H 'Content-Type: application/json' -d '{"unauthorized_next":1}'
# Next 2 calls get 429 Retry-After: 2 → test back-off
curl -X POST localhost:3000/__admin/chaos -H 'Content-Type: application/json' -d '{"rate_limit_next":2}'
# Next call gets 503 Service Unavailable
curl -X POST localhost:3000/__admin/chaos -H 'Content-Type: application/json' -d '{"server_error_next":1}'
# Add latency to every call (ms)
curl -X POST localhost:3000/__admin/chaos -H 'Content-Type: application/json' -d '{"delay_ms":1500}'
# Invalidate all issued tokens
curl -X POST localhost:3000/__admin/revoke-tokens
# Mark VMs as changed now → the next delta run picks up only these
curl -X POST localhost:3000/__admin/touch -H 'Content-Type: application/json' -d '{"vm_ids":["vm-001","vm-002"]}'
# Stats, current chaos settings and the last 100 requests
curl localhost:3000/__admin/state
# Full dataset including internal _updated_at
curl localhost:3000/__admin/vms
# Restore the original data and clear tokens, counters and chaos settings
curl -X POST localhost:3000/__admin/reset
```

Set `TOKEN_TTL_SECONDS=60` to test a real token expiry partway through a run. 

Other admin routes, which the UI uses: `GET /__admin/info`, `GET|POST /__admin/resources`, `PATCH|DELETE /__admin/resources/<name>`, `POST /__admin/resources/<name>/import` (body `{ "records": [...], "mode": "append" | "replace" }`), `POST /__admin/resources/<name>/reset`.

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | 3000 | |
| `TOKEN_TTL_SECONDS` | 3600 | Default OAuth token lifetime. Each OAuth client can override it. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | 30 / 60 | Per credential, on private collections |
| `VM_COUNT` | 450 | |
| `DATA_SEED` | 20261119 | |
| `MONGODB_URI` | empty | e.g. `mongodb://127.0.0.1:27017` or an Atlas URI. Empty means in-memory storage. |
| `MONGODB_DB` | `cloud_inventory_mock` | |
| `REQUIRE_MONGODB` | `false` | `true` makes startup fail if MongoDB is unreachable, instead of falling back to memory |

There are no credentials in `.env`. API keys, Basic logins and OAuth clients live in MongoDB, as hashes, and are managed in the UI.

## End-to-end test

`npm run test:e2e` starts the real server (`node src/server.js`) as a separate process and drives it over HTTP. It uses the `MONGODB_URI` from `.env` with a throwaway `mock_e2e_<timestamp>` database, which it drops afterwards; set `E2E_MEMORY=1` to use in-memory storage instead. It covers:

1. The UI is served, and nothing exposes an admin key or built-in client.
2. Private collections refuse anonymous calls, including ones that send an admin header.
3. Creating an OAuth client in the UI (vms read, custom scope `inventory.read`), and the token endpoint's success and error cases.
4. A nightly sync client: a full load (3 pages, 450 VMs), then a delta run with a space-separated `updated_since` that picks up exactly the VMs edited or created in the UI.
5. 401 → token refresh and one retry; 429 → back off for `Retry-After`; 503 → the run fails and the client keeps its previous sync time.
6. An API key and a Basic login with grants across collections; disable, rotate and revoke.
7. The request log records OAuth, API-key and Basic traffic.
