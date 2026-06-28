# idea-receipt — Backend Plan & API Contract (the SHARED SPINE)

**Status:** authoritative. Every workstream (frontend rewire, AI/semantic search, push
notifications, Notion importer) builds against the contract in this document. If you need a
change to the contract, change it *here first*.

**Owner of this spine:** the backend workstream (user features #1 backend, #2 accounts/auth,
#3 cross-device sync).

---

## 1. What changes and why

Today the PWA (`index.html` + `app.js`) is **read-only** and **Notion-locked**: it reads a
static `data.json` (regenerated from Notion by `sync_notion.py` via a GitHub Action + a
Cloudflare cron). All user state — cross-offs (`done:*`), `billedTo`, `settings`, coupons,
history, lifetime ideas — lives in **localStorage only**, so it never follows the user to
another device.

The spine introduces a **Cloudflare Worker API** so:
- ideas become **read/write** (create/edit/delete from the app, not just Notion),
- users get **accounts** (Google OAuth + magic-link fallback),
- cross-off/done, billed-to, and settings **sync across devices** (offline-first),
- Notion becomes *one source among many* — the importer POSTs into the API instead of
  writing `data.json`,
- ideas get **embeddings** (Vectorize) so the AI workstream can do semantic search.

### Platform pieces
| Piece | Role |
|---|---|
| **Cloudflare Worker** (`idea-receipt-api`) | the REST API under `/api` |
| **D1** (SQLite) | system of record (users, ideas, lists, state) |
| **Vectorize** | idea embeddings, keyed by idea id (semantic search) |
| **KV** | sessions (`SESSIONS`) + push subscriptions (`PUSH_SUBS`) |
| **Workers AI** | generate embeddings on idea write (`@cf/baai/bge-base-en-v1.5`, 768-dim) |

Scaffold lives in [`platform/backend/`](../platform/backend/). It does **not** touch any
existing file.

---

## 2. Data model (D1) — see [`platform/backend/schema.sql`](../platform/backend/schema.sql)

```
users(id, email, name, created_at)
auth_identities(id, user_id→users, provider, subject, created_at)   UNIQUE(provider,subject)
sessions(token, user_id→users, user_agent, created_at, expires_at)  -- audit copy; KV is authoritative
lists(id, user_id→users, title, position, created_at, updated_at, deleted_at)
ideas(id, user_id→users, list_id→lists, title, body, tags(json), status, priority,
      due_at, source, notion_block_id, created_at, updated_at, deleted_at)
user_state(user_id→users, data(json), updated_at)                   -- settings + billed-to + cross-off blob
```

**Decisions that affect every workstream:**
- **IDs are client-mintable UUIDs** (`crypto.randomUUID()`), not autoincrement. The client
  can create an idea offline, give it an id, and that id is stable through sync. Vectorize
  uses the same id as its vector key.
- **Soft delete** via `deleted_at` (NULL = live). Deletes are tombstones so offline clients
  can reconcile them; they never just "vanish".
- **`updated_at` is the merge clock** for last-write-wins (LWW). Every mutation bumps it.
- **`status`** ∈ `active|done|archived`. **Cross-off = `status:'done'`** (server-side now,
  replacing localStorage `done:*`). `archived` is for hidden-but-kept.
- **`tags`** is a JSON array stored as TEXT.
- **`source`** ∈ `manual|notion`; `notion_block_id` makes Notion re-imports idempotent and
  lets the importer prune only what it owns.

---

## 3. API contract

- Base: the worker origin, e.g. `https://idea-receipt-api.<subdomain>.workers.dev`. All paths
  under `/api`. JSON in/out (`content-type: application/json`).
- **Auth:** HttpOnly session cookie `ir_session` (`Secure; SameSite=None` — the PWA on GitHub
  Pages and the API are cross-origin). Browser clients **must** send `credentials: 'include'`
  on every fetch. CORS reflects `Origin` against `ALLOWED_ORIGINS` and sets
  `Access-Control-Allow-Credentials: true`.
- **Errors:** non-2xx return `{ "error": "<code>", ... }`. Codes used: `unauthorized` (401),
  `not_found` (404), `stale` (409, LWW conflict — body includes `current`), `*_required`
  (400), `internal` (500).
- `server_time` (ISO-8601 UTC) is returned by list endpoints so clients can checkpoint deltas.

### 3.1 Auth

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/api/auth/start` | none | `{ provider?: "google"\|"magic", email? }` | OAuth: `{ redirect }` (client does `location = redirect`). Magic: `{ sent: true, dev_link }` (dev only; prod returns `{ sent:true }`). |
| GET | `/api/auth/callback` | none | OAuth: `?code&state`. Magic: `?token`. | `302` to `APP_ORIGIN` with `Set-Cookie: ir_session=…`. |
| POST | `/api/auth/signout` | cookie | — | `{ ok:true }`, clears cookie. |
| GET | `/api/me` | cookie | — | `{ id, email, name, created_at }` or `401`. |

Flow (Google): app `POST /api/auth/start {provider:"google"}` → redirect user to Google →
Google calls `/api/auth/callback?code&state` → worker exchanges code, upserts user, links
identity, mints session, `302` back to the app with the cookie set. Magic-link: `POST
/api/auth/start {provider:"magic", email}` → worker signs a 30-min HMAC token → emailed link
(or `dev_link`) hits `/api/auth/callback?token=…` → same session/redirect.

### 3.2 Ideas — all scoped to the authenticated user

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/ideas` | query: `status`, `list_id`, `since` (ISO; returns rows with `updated_at>since`, **including tombstones** for delta sync), `include_deleted=1` | `{ ideas:[…], server_time }` |
| POST | `/api/ideas` | `{ id?, title*, body?, tags?, list_id?, status?, priority?, due_at?, source?, notion_block_id?, created_at? }` | `201 { idea }`. Upsert by `id` with LWW (only overwrites if incoming `updated_at` newer). |
| PATCH | `/api/ideas/:id` | any subset of `{ title, body, tags, list_id, status, priority, due_at, updated_at? }` | `{ idea }`, or `409 { error:"stale", current }` if `updated_at` predates server. |
| DELETE | `/api/ideas/:id` | — | `{ ok:true, deleted, deleted_at }` (soft delete + Vectorize de-index). |

`idea` shape: `{ id, list_id, title, body, tags:[…], status, priority, due_at, source,
notion_block_id, created_at, updated_at, deleted_at }`.

Writes also (best-effort, non-blocking via `waitUntil`) upsert/delete the idea's embedding in
Vectorize keyed by `id`, with metadata `{ user_id, title }` — this is the AI workstream's read
surface.

### 3.3 Lists

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/lists` | — | `{ lists:[…] }` (live only, ordered by `position,created_at`) |
| POST | `/api/lists` | `{ id?, title*, position? }` | `201 { list }` |
| PATCH | `/api/lists/:id` | `{ title?, position? }` | `{ list }` |
| DELETE | `/api/lists/:id` | — | `{ ok:true, deleted_at }` (soft delete; its ideas get `list_id=NULL`) |

### 3.4 State (device-synced settings + cross-off/billed-to)

Replaces the localStorage blob. One JSON document per user.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/state` | — | `{ data:{…}, updated_at }` |
| PATCH | `/api/state` | `{ data:{ … } }` (or a bare object) | `{ data:{…merged}, updated_at }` — **shallow-merged** so a partial patch (e.g. just `billedTo`) doesn't clobber `settings`. |

Suggested `data` shape (frontend owns the exact keys):
```json
{ "settings": { "theme":"auto","sort":"default","sound":true,"season":true,
                "seasonPick":"auto","coupon":true,"notify":false },
  "billedTo": "—",
  "coupons":  { "20260627": true } }
```
Per-idea cross-off/done is **not** here — it's `ideas.status`. `user_state` is only for
device UI prefs + ad-hoc flags that have no first-class column.

### 3.5 Notion import (machine-to-machine)

| Method | Path | Auth | Request |
|---|---|---|---|
| POST | `/api/import/notion` | `Authorization: Bearer <NOTION_IMPORT_TOKEN>` | `{ email*, list?:{title, notion_page_id}, items:[ {title*, details?:[…], tags?:[…], notion_block_id?, added?} ], prune?:true }` |

Response: `{ ok:true, imported, pruned, user_id, list_id }`. Idempotent on
`(user, notion_block_id)`: existing notion ideas update in place; ideas that vanished from
Notion are **soft-deleted** (only `source='notion'`, scoped to the list if given) unless
`prune:false`. Manual ideas are never touched.

### 3.6 Reserved for other workstreams (named here so paths don't collide)
- AI: `GET /api/search?q=…` (Vectorize semantic search), `POST /api/ideas/:id/similar`.
- Push: `POST /api/push/subscribe`, `DELETE /api/push/subscribe`, server VAPID send (uses the
  `PUSH_SUBS` KV namespace). Not implemented in this scaffold — the binding exists.

---

## 4. Auth design (provider-agnostic)

- **Session model** is provider-independent: a random opaque token in the `ir_session` cookie;
  KV maps token → `{user_id}` with a TTL (`SESSION_TTL_DAYS`, default 30). D1 `sessions` is a
  best-effort audit/index for "list & revoke my devices". KV is authoritative for auth checks.
- **Identity** is decoupled in `auth_identities(provider, subject)`. The same user can have a
  `google` identity *and* a `magic` identity. To swap OAuth providers (GitHub, Apple…), add a
  branch in `authStart`/`authCallback` and a new `provider` value — **no schema change, no
  contract change** for consumers.
- **Primary = Google OAuth.** `authStart` builds the Google consent URL with a one-time
  `state` stashed in KV; `authCallback` verifies `state`, exchanges the code, reads
  `userinfo`, upserts the user by email, and mints the session.
- **Fallback = email magic-link.** `authStart {provider:"magic"}` signs a 30-min HMAC token
  (`MAGIC_LINK_SECRET`); the link hits the same callback. Email *delivery* is the email/push
  workstream's job — until then `dev_link` is returned so it's testable.
- **Cookie:** `HttpOnly; Secure; SameSite=None; Path=/`. SameSite=None is required for the
  cross-origin GitHub-Pages↔Worker setup; that's also why CORS must echo the exact origin and
  send `Allow-Credentials: true` (you cannot use `*` with credentials).

---

## 5. Offline-first sync (#3) — the reconciliation contract

The client keeps a **local mirror** (IndexedDB/localStorage) and an **outbox queue**, and
treats the server as the convergence point. LWW on `updated_at`.

**Pull (server → client):**
1. Client stores a `lastSync` checkpoint (ISO). On load/foreground: `GET /api/ideas?since=<lastSync>`.
2. The response includes **tombstones** (rows with `deleted_at`) so deletions propagate.
3. Merge each row: if the local copy's `updated_at` ≤ server's, replace it (server wins);
   if local is newer (an un-pushed edit), keep local and let the push step resolve.
4. Set `lastSync = server_time` from the response. Also `GET /api/state` and merge settings.

**Push (client → server, draining the outbox):**
- Create/edit: `POST /api/ideas` (upsert by id) or `PATCH /api/ideas/:id` carrying the
  `updated_at` the client last saw. The server applies LWW: a `PATCH` with a stale
  `updated_at` returns **409 `{error:"stale", current}`** — the client then takes `current`,
  re-applies its intent if still meaningful, and retries.
- Delete: `DELETE /api/ideas/:id` (idempotent — deleting an already-deleted idea is `ok:true`).
- Cross-off/done: a `PATCH /api/ideas/:id {status:"done"|"active"}`. Because the whole row
  carries one `updated_at`, toggling done on two devices resolves by latest write.
- Settings/billed-to: `PATCH /api/state {data:{…}}` (shallow-merge; last write wins per key
  via the merge + `updated_at`).

**Conflict policy:** LWW by `updated_at`, field-granularity not attempted — an idea is the
unit. This is intentionally simple and good enough for a personal idea list; document it so the
AI/frontend workstreams don't assume CRDT semantics.

**First-run migration (frontend workstream):** on first authenticated load, read the existing
localStorage (`settings`, `billedTo`, `done:*`, `coupon:*`, `pendingIdeas`) and POST it up:
ideas from `data.json` → `POST /api/ideas` (source `manual` or let the Notion import own them),
`done:*` → `status:'done'`, the rest → `PATCH /api/state`. Then switch reads to the API.

---

## 6. How the Notion importer changes (describe only — do **not** edit `sync_notion.py`)

Today `sync_notion.py` writes `data.json` and the Action commits it. The new path keeps all the
parsing logic and changes only the **output**:

1. Keep `build_items()` / `bullets_from()` / `page_title()` exactly as they are.
2. Instead of `json.dump(..., OUT)`, **POST** to `/api/import/notion`:
   - URL from a new env var `IMPORT_URL` (e.g. `https://idea-receipt-api.…workers.dev/api/import/notion`).
   - Header `Authorization: Bearer $NOTION_IMPORT_TOKEN` (new repo secret, matches the worker
     secret of the same name).
   - Body per list: `{ "email": "<owner email>", "list": {"title": <page title>,
     "notion_page_id": <pid>}, "items": [ {"title","details","tags","notion_block_id": <block id>,
     "added"} ] }`. Map the current item fields: `id`→`notion_block_id`, `details`→`details`,
     `added`→`added`, `tags`→`tags`.
   - New env var `OWNER_EMAIL` so the importer knows which user to write into.
3. The GitHub Action (`.github/workflows/sync.yml`) drops the "commit & push data.json" step and
   instead just runs the script with `IMPORT_URL`, `NOTION_IMPORT_TOKEN`, `OWNER_EMAIL` set as
   secrets/vars. The Cloudflare cron worker (`sync-worker.js`) can keep triggering the Action
   unchanged.
4. **Transition:** the importer can write `data.json` *and* POST during a migration window so
   the old read path keeps working until the frontend cuts over to the API.

(All of the above is a description of changes for the Notion workstream; this plan does not edit
`sync_notion.py` or the workflow.)

---

## 7. Deploy guide (exact steps)

All `wrangler` commands run from **`platform/backend/`**. Prereq: `npm i -g wrangler` and
`wrangler login` (the owner's Cloudflare account is connected).

### 7.1 Create resources
```bash
wrangler d1 create idea_receipt
wrangler vectorize create idea-receipt-ideas --dimensions=768 --metric=cosine
wrangler kv namespace create SESSIONS
wrangler kv namespace create PUSH_SUBS
```
Each prints an id. Paste them into `wrangler.toml`:
- D1 → `[[d1_databases]] database_id`
- KV → the two `[[kv_namespaces]] id` blocks (`SESSIONS`, `PUSH_SUBS`)
- Vectorize `index_name` already matches; no id needed.

### 7.2 Apply the schema
```bash
wrangler d1 execute idea_receipt --file=./schema.sql --remote
```

### 7.3 Set secrets
```bash
wrangler secret put GOOGLE_CLIENT_SECRET     # from the Google OAuth client (§7.5)
wrangler secret put NOTION_IMPORT_TOKEN      # generate: openssl rand -hex 32
wrangler secret put MAGIC_LINK_SECRET        # generate: openssl rand -hex 32
```

### 7.4 Set vars in `wrangler.toml [vars]`
- `GOOGLE_CLIENT_ID` — public OAuth client id.
- `APP_ORIGIN` — where the PWA is served (`https://astrojainius1-rgb.github.io`, adjust if the
  Pages path includes the repo, e.g. `/idea-receipt/`).
- `ALLOWED_ORIGINS` — comma-separated: prod Pages origin + local dev origins.
- Add `API_ORIGIN` = the deployed worker URL (you get it after the first `wrangler deploy`;
  it's needed because the OAuth `redirect_uri` must be absolute and exact).

### 7.5 Register the Google OAuth app
1. Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client
   ID → Web application**.
2. **Authorized redirect URIs:** `<API_ORIGIN>/api/auth/callback`
   (e.g. `https://idea-receipt-api.<subdomain>.workers.dev/api/auth/callback`).
3. (Authorized JavaScript origins are not required — the redirect is server-side.)
4. Copy the **Client ID** → `GOOGLE_CLIENT_ID` var; **Client secret** → `GOOGLE_CLIENT_SECRET`
   secret. Configure the OAuth consent screen (External, add your email as a test user) so you
   can sign in before verification.

### 7.6 Deploy
```bash
wrangler deploy
```
Note the printed worker URL → set it as `API_ORIGIN`, ensure it matches the Google redirect
URI, then `wrangler deploy` once more. Smoke-test per the backend `README.md`.

### 7.7 Wire the Notion importer (Notion workstream)
Add repo secrets: `NOTION_IMPORT_TOKEN` (same value as the worker secret), `IMPORT_URL`
(`<API_ORIGIN>/api/import/notion`), `OWNER_EMAIL`. Update `sync_notion.py` to POST (per §6).

---

## 8. Credential / deploy blockers the user must clear (only the user can do these)
1. **Google OAuth client** — create it and provide `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`,
   with the redirect URI set to `<API_ORIGIN>/api/auth/callback`. *(Hard blocker for sign-in.)*
2. **`wrangler login`** on the owner's Cloudflare account (for D1/Vectorize/KV/Workers create
   + deploy).
3. **Confirm the exact `APP_ORIGIN`** (GitHub Pages serves at
   `https://astrojainius1-rgb.github.io/idea-receipt/` if it's a project page — the cookie
   `Domain`/CORS origin must match).
4. **Owner email** for the Notion importer (`OWNER_EMAIL`) — which user the synced ideas belong
   to.
5. **Random secrets** — generate `NOTION_IMPORT_TOKEN` and `MAGIC_LINK_SECRET`
   (`openssl rand -hex 32`) and set them both on the worker and (the import token) as a repo
   secret.
6. **Email delivery for magic-link** — out of scope for this scaffold (the email/push
   workstream owns it); until then magic-link works via the returned `dev_link`.

---

## 9. Notes for the other four workstreams
- **Frontend rewire:** consume §3. Use `fetch(..., {credentials:'include'})`. Implement the
  §5 pull/push + first-run migration. Cross-off → `PATCH /api/ideas/:id {status}`; settings &
  billed-to → `/api/state`. Don't assume CRDT — it's LWW per idea.
- **AI / semantic search:** every idea write already upserts a 768-dim embedding to the
  `IDEAS_VEC` Vectorize index, key = idea id, metadata `{user_id,title}`. Add `GET /api/search`
  (filter by `user_id` in metadata). Don't change the embedding model/dimensions without
  re-indexing (the index is created `--dimensions=768`).
- **Push:** the `PUSH_SUBS` KV binding is provisioned. Add `/api/push/subscribe` and a VAPID
  sender; subscriptions are per-user (gate on the session cookie).
- **Notion importer:** §6. POST into `/api/import/notion`; it's idempotent and prunes only
  notion-sourced ideas.
- **Contract stability:** ids are UUID strings; timestamps are ISO-8601 UTC; deletes are soft;
  `updated_at` is the merge clock. Treat these as load-bearing.
