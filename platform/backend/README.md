# idea-receipt backend (`idea-receipt-api`)

The Cloudflare Worker that turns idea-receipt from a read-only, Notion-locked PWA into a
real multi-device app. **D1** is the system of record, **Vectorize** holds idea embeddings
(semantic search for the AI workstream), **KV** holds sessions + push subscriptions.

This is a *separate* worker from the repo-root `sync-worker.js` (that one only triggers the
GitHub Action). Nothing here modifies the existing site; the PWA will call this API once the
frontend workstream wires it up.

> Full contract, schema, and design rationale: [`../../docs/PLAN-backend.md`](../../docs/PLAN-backend.md).

## Files
- `wrangler.toml` — bindings (D1 / Vectorize / KV / AI), vars, routes.
- `schema.sql` — D1 migration (users, auth_identities, sessions, lists, ideas, user_state).
- `src/index.js` — the Worker: router, auth (Google OAuth + magic-link), ideas/lists CRUD,
  `/api/import/notion`, `/api/state`.

## Prerequisites
- Node + `npm i -g wrangler` (or `npx wrangler …`).
- `wrangler login` (the owner's Cloudflare account is already connected).
- A Google OAuth client (see PLAN-backend.md → "OAuth app registration").

## Deploy (first time)
Run everything from `platform/backend/`.

```bash
# 1) Create resources — copy each printed id into wrangler.toml
wrangler d1 create idea_receipt
wrangler vectorize create idea-receipt-ideas --dimensions=768 --metric=cosine
wrangler kv namespace create SESSIONS
wrangler kv namespace create PUSH_SUBS

# 2) Apply the D1 schema
wrangler d1 execute idea_receipt --file=./schema.sql --remote

# 3) Set secrets (interactive — paste when prompted)
wrangler secret put GOOGLE_CLIENT_SECRET     # from Google Cloud OAuth client
wrangler secret put NOTION_IMPORT_TOKEN      # any long random string; the importer reuses it
wrangler secret put MAGIC_LINK_SECRET        # any long random string (HMAC key)

# 4) Set the public OAuth client id + origins in wrangler.toml [vars]:
#    GOOGLE_CLIENT_ID, APP_ORIGIN, ALLOWED_ORIGINS, and add API_ORIGIN
#    (= the deployed worker URL, needed so the OAuth redirect_uri matches).

# 5) Deploy
wrangler deploy
```

`wrangler deploy` prints the worker URL (e.g. `https://idea-receipt-api.<subdomain>.workers.dev`).
Put that value back into `wrangler.toml` as `API_ORIGIN` and into the Google OAuth client's
**Authorized redirect URIs** as `<API_ORIGIN>/api/auth/callback`, then `wrangler deploy` again.

## Local dev
```bash
wrangler dev          # runs the worker locally with --remote bindings via `wrangler dev --remote`
```
For magic-link in dev, `POST /api/auth/start {provider:"magic", email}` returns a `dev_link`
you can paste into the browser (no email infra needed yet).

## Smoke test
```bash
curl -i  $API/api/health
curl -i -X POST $API/api/auth/start -d '{"provider":"magic","email":"you@example.com"}' -H 'content-type: application/json'
# open the returned dev_link in a browser → it sets the cookie and redirects to APP_ORIGIN
curl -i  $API/api/me            --cookie "ir_session=…"
curl -i  $API/api/ideas         --cookie "ir_session=…"
```

## Costs
All within Cloudflare free tiers for a personal app:
- **Workers**: 100k requests/day free.
- **D1**: 5 GB storage, 5M rows read/day, 100k writes/day free.
- **KV**: 100k reads/day, 1k writes/day, 1 GB free.
- **Vectorize**: 30M queried vector-dimensions/month, 5M stored free.
- **Workers AI** (embeddings): a free daily allotment of neurons; bge-base is cheap.
