# Capture & Editing workstream — implementation plan

Covers user features **#4 in-app add/edit/delete**, **#5 register PWA as a share
target**, and **#6 quick capture**. This is the plan + a real scaffold under
`platform/capture/`. It builds *against* the SHARED SPINE backend (Cloudflare
Worker + D1, REST `/api`, session-cookie auth) — that backend is being built in
parallel; here we conform to its contract and note every dependency.

> **Constraint honoured:** nothing in the existing app is modified. All new code
> lives in `platform/capture/` and `docs/`. The integration sections below
> *describe* the edits to `app.js` / `index.html` / `manifest.webmanifest` /
> `sw.js` that a follow-up change would make — they do **not** make them.

---

## 0. The model shift (read first)

Today the app is **read-only**: `sync_notion.py` writes `data.json`, the SW
serves it network-first, and `app.js` polls it every 30s. User state
(cross-off, billed-to, settings, "pending ideas") is **localStorage only**.

After this workstream the PWA becomes an **offline-first client of the SPINE
API**. Notion becomes *one importer*, not the source of truth — ideas can be
born in the app. Concretely:

- **Writes** (create/edit/delete) go to the backend, but are recorded locally
  first (IndexedDB) and replayed on reconnect — see `queue.js`.
- **Reads** still come from `data.json` for now (no change to the render path);
  a later phase can repoint reads at `GET /api/ideas`. Until then, the existing
  `mergePending()` path in `app.js` is the seam we reuse to show optimistic
  ideas (details below).
- **Reconciliation** is last-write-wins by `updated_at`, enforced server-side.

### Backend endpoints this workstream depends on

| Method & path        | Used by              | Notes |
|----------------------|----------------------|-------|
| `POST /api/ideas`    | queue.js (create)    | body `{client_id, title, body, tags[], list_id, priority, due_at, source:'manual'}`; returns canonical idea incl. `id`, timestamps. Must treat a repeated `client_id`/`op_id` as idempotent. |
| `PATCH /api/ideas/:id` | queue.js (update)  | partial fields; server resolves LWW by `updated_at`. |
| `DELETE /api/ideas/:id` | queue.js (delete) | `204`; a `404` (already gone) is treated as success client-side. |
| `GET /api/lists`     | composer (list pick) | `{lists:[{id,title}]}` for the list dropdown. |

Auth is the **session cookie**, so every request uses
`fetch(..., { credentials: "include" })`. A `401` pauses the queue and raises an
`auth-required` event for the UI to prompt sign-in.

---

## 1. In-app add / edit / delete (#4)

### 1.1 UX

- **Composer sheet**: a bottom sheet matching the existing settings/stats sheets
  (`.sheet` / `.sheet-card`), with fields: **Title**, **Note/body**
  (multi-line; `#tags` inline are auto-extracted), **List** (`GET /api/lists`),
  **Priority** (low/normal/high), **Due** (date). Save / Cancel / (in edit mode)
  Delete.
- **Entry points**:
  - The existing `#jot` button (`+ jot a new idea…`) currently deep-links to
    Notion. We *keep* it but, when a backend session exists, intercept its click
    to open the composer instead (graceful fallback to the Notion link when
    signed-out / offline-first-not-configured).
  - Tapping an existing idea row currently crosses it off. We add a **long-press
    / edit affordance** (a small `✎` on the row, like the existing `↗` link) that
    opens the composer in edit mode. Cross-off behaviour is unchanged.
- **Optimistic UI**: on Save the idea appears on the receipt *immediately* with
  the existing `pending` styling, with the printer animation. It reconciles to a
  confirmed row when the queue flush succeeds.
- **Delete**: row animates out; a `delete` op is queued; undo = re-queue a
  create from the cached idea (nice-to-have, phase 2).

### 1.2 How it calls the backend

All writes go through **`compose.js` → `queue.js`**, never `fetch` directly:

```
composer form  →  compose.createIdea(draft)   →  queue.queueCreate(...)  →  IndexedDB op
                  compose.editIdea(id, chg)    →  queue.queueUpdate(...)
                  compose.deleteIdea(id)       →  queue.queueDelete(...)
                                                        │
                                          (online) flush() → POST/PATCH/DELETE /api/ideas
```

`compose.js` normalises the draft into the SPINE shape (title/body/tags/
priority/due/list), validates it, and returns an **optimistic receipt-item**
(`toReceiptItem`) for instant render. `queue.js` owns durability + replay.

### 1.3 Offline write queue (IndexedDB)

Implemented in **`platform/capture/queue.js`**. Key properties:

- **Durable**: ops live in IndexedDB (`ops` store, keyed by `op_id`), surviving
  reloads and cold starts. localStorage is *not* used for the queue (too small,
  synchronous, and the app already leans on it heavily).
- **Ordered replay**: ops carry a monotonic `seq`; `flush()` replays oldest-first.
- **Idempotent**: every op has a client `op_id`, and creates carry a `client_id`.
  The backend must treat a repeated `op_id`/`client_id` as a no-op so
  at-least-once delivery is safe.
- **client→server id mapping**: an idea created offline only has a `client_id`.
  If the user then edits/deletes it *before* the create has flushed, those ops
  are queued against the `client_id`; at flush time we resolve `client_id →
  server id` from the `idmap` store (populated by the create's response). Ops
  whose id isn't known yet are skipped this pass and retried after the create
  lands.
- **Error policy**: `401` → stop, emit `auth-required`. Permanent `4xx`
  (e.g. `404` on delete) → drop the op, emit `dropped`. Transient (offline /
  `5xx` / `429` / `409`) → keep, bump `tries`, stop the pass, retry later.
- **Auto-flush triggers** (`installAutoFlush()`): `window 'online'`,
  `visibilitychange → visible`, and an opportunistic kick on load. Mirrors the
  app's existing visibility-aware polling.
- **Events** (`onQueueEvent`): `queued`, `reconciled`, `dropped`,
  `retry-later`, `auth-required`, `drained` — the UI subscribes to swap
  optimistic rows for confirmed ones and to show an "n unsynced" badge
  (`pendingCount()`).

### 1.4 Exact integration into the existing app (described, not done)

These are the surgical edits a follow-up PR would make. **No file is touched
now.**

**`index.html`**
- Add one `<div class="sheet" id="composeSheet" hidden>…</div>` block alongside
  the existing `#sheet` and `#statsSheet` (same markup pattern). Fields as in
  §1.1.
- No other markup needed; `#jot` and the item rows already exist.

**`app.js`** (all additive; existing functions unchanged)
- `import { createIdea, editIdea, deleteIdea, setStatus } from "./platform/capture/compose.js";`
  and `import { onQueueEvent, installAutoFlush, pendingCount } from "./platform/capture/queue.js";`
  (the app currently uses no ES `import`, so the `<script src="app.js">` tag
  would need `type="module"` — that single attribute change is the only edit to
  the `<script>` line, and is back-compatible because the app is plain script).
  *Fallback if module conversion is undesirable:* ship `queue.js`/`compose.js`
  via a tiny `<script type="module">` shim in `index.html` that assigns the API
  onto `window.capture`, and have `app.js` call `window.capture?.createIdea`.
- **Open composer**: add `openCompose(item)` that fills `#composeSheet` and
  shows it; wire `#jot`'s click to call it (when capture is enabled) instead of
  following the href; add the per-row `✎` button in `render()`'s row builder
  (next to the existing `it.id` `↗` link, using the same
  `e.stopPropagation()` guard so it doesn't cross the idea off).
- **Save handler**: call `createIdea(draft)` / `editIdea(id, changes)`; on the
  returned `optimistic` item, push it through the **existing** optimistic path.
  The app already has `pendingIdeas`/`mergePending()`; we extend `mergePending`
  to also fold in queued composer ideas (read from `pendingOps()`), reusing the
  `pending: true` rendering that's already styled. This means **no new render
  code** — optimistic ideas reuse the "sending to Notion — prints on next sync"
  treatment (copy can be generalised to "saving…").
- **Reconcile**: subscribe via `onQueueEvent`; on `reconciled`/`drained`, call
  the existing `rerender()`. On `auth-required`, surface a sign-in prompt
  (reusing `flashAdd`-style toast).
- **Cross-off bridge**: the existing `toggleDone(title)` (localStorage) can
  additionally call `setStatus(id, 'done'|'active')` when an idea has a backend
  id, so done-state round-trips. Optional, phase 2.

**`sw.js`**
- Add the new static assets to `SHELL` so the composer + share target work
  offline: `platform/capture/sharetarget.html`, `platform/capture/queue.js`,
  `platform/capture/compose.js`. Bump `CACHE` to `idea-receipt-v5`.
- The SW does **not** need to handle `/api/*` — the queue handles offline writes
  itself; API GETs are simply network-only (the existing fetch handler already
  ignores non-GET and non-`data.json` paths, falling through to network).

---

## 2. Share Target (#5)

### 2.1 Manifest additions

The Web Share Target API is declared in the manifest. The exact snippet to
**merge** into `manifest.webmanifest` is in
[`platform/capture/manifest.snippet.json`](../platform/capture/manifest.snippet.json):

```json
"share_target": {
  "action": "platform/capture/sharetarget.html",
  "method": "GET",
  "enctype": "application/x-www-form-urlencoded",
  "params": { "title": "title", "text": "text", "url": "url" }
}
```

We use **GET** (not POST/multipart) because we only accept text/URL/title — GET
share targets are the broadly-supported tier and need no SW interception. (A
POST `enctype: multipart/form-data` target would be required only to accept
*files*/images, which is out of scope here.)

The same snippet also adds a **`shortcuts`** entry ("New idea") so a long-press
on the installed icon offers a direct quick-add (`sharetarget.html?compose=1`).

### 2.2 The handler page

[`platform/capture/sharetarget.html`](../platform/capture/sharetarget.html) is
the landing route. When the OS shares into the app it opens this page with
`?title=&text=&url=`. The page:

1. Parses the params; tolerates platforms that bury the URL inside `text`
   (extracts the first `https?://` match).
2. **Prefills** a tiny composer: title from the shared title (or the URL's
   hostname, or the first line of text); note = text + URL.
3. **Enriches a shared URL** into title+note: a best-effort `fetch(url)` lifts
   the page's `<title>` to replace a bare-hostname title. Cross-origin pages
   usually block this (CORS) — that's expected; we silently fall back to the
   hostname. (A future server-side enricher endpoint on the SPINE could do this
   reliably; noted as a backend ask, not a hard dependency.)
4. On Save, calls `compose.createIdea(...)` → the **same offline queue**, then
   redirects back to `index.html`. Because the write is queued durably, sharing
   works even with no connection.

### 2.3 iOS vs Android reality + fallback

- **Android (Chrome/Edge/Samsung Internet)**: full Web Share Target support once
  the PWA is **installed** (added to home screen). The app shows up in the
  system share sheet. This is the happy path.
- **iOS/iPadOS (Safari)**: **does not support the Web Share Target API at all**
  (as of 2026). An installed PWA cannot register as a share *target* on iOS.
  - **Fallback on iOS**: (a) the **app-shortcut / `?compose=1`** quick-add still
    works from the home-screen icon long-press where supported; (b) document an
    **iOS Shortcuts** recipe (Share Sheet → "Run Shortcut" → open
    `…/platform/capture/sharetarget.html?title=…&text=…&url=…` with the shared
    content URL-encoded) as the supported path for power users; (c) the in-app
    quick-add (#6) is always available. The share-target page is written to work
    identically whether it's reached via a real share target *or* a Shortcuts/URL
    invocation, so no extra code is needed for the fallback.
- **Desktop**: Web Share Target is irrelevant; the in-app composer covers it.

**Hard prerequisite:** a share target only appears **after the PWA is
installed** (and, on Android, after the manifest with `share_target` has been
fetched). It cannot be tested from a normal browser tab.

---

## 3. Quick capture (#6)

A fast path to a new idea, three affordances:

### 3.1 Minimal "＋" quick-add

- A persistent **`＋` affordance** (reuse/relabel the existing `#jot` button, or
  add a small floating button) opens a **single-line** composer: one text input
  that accepts `title #tags` and Enter-to-save. `compose.extractTags()` already
  splits inline `#tags` out of the text, and `normalizeDraft()` derives a title
  from the first line — so a one-field capture is genuinely one step.
- Saves via `compose.createIdea` (offline-safe). Optimistic row appears instantly.

### 3.2 Voice capture (Web Speech API)

- A **🎤 mic button** in the quick-add bar uses
  `window.SpeechRecognition || window.webkitSpeechRecognition`. On result, the
  transcript fills the title/body input; the user confirms with Save. (We do not
  auto-submit — speech recognition is error-prone; a confirm step avoids garbage
  ideas.)
- **Graceful fallback**: if neither constructor exists (Firefox, many in-app
  webviews, older iOS), the mic button is **hidden** and only the text field
  shows. Detection is a one-liner; no polyfill is shipped.
- **iOS limitations (important):**
  - Safari's `webkitSpeechRecognition` support is **partial/*flaky*** and has
    historically required a Siri/dictation backend; it may be unavailable in
    standalone (home-screen) PWA mode and in third-party webviews. Treat iOS Web
    Speech as **best-effort**: feature-detect, and where it fails, fall back to
    the **native keyboard's dictation mic** (the OS-level mic on the keyboard),
    which always works because it's just text input into our field.
  - Microphone access requires a user gesture and HTTPS; the button-press
    satisfies the gesture.
- This is a **draft module** boundary: voice lives in the composer UI layer (to
  be added to `app.js`/the composer sheet), feeding the same `compose.js` core.
  No voice code is in the scaffold because it is inherently DOM/permission-bound;
  `compose.js` stays DOM-agnostic and testable.

### 3.3 Share / app-shortcut entry

- The **manifest `shortcuts`** entry (§2.1) gives a home-screen long-press
  "New idea" jump straight into quick-add (`?compose=1`).
- The **share target** (§2) is itself a quick-capture path from any other app.

---

## 4. Files delivered in this workstream

| File | Kind | Purpose |
|------|------|---------|
| `docs/PLAN-capture.md` | doc | this plan |
| `platform/capture/queue.js` | real module | IndexedDB offline write queue + replay/reconcile against `/api/ideas` |
| `platform/capture/compose.js` | real module | DOM-agnostic add/edit/delete core; draft normalisation + optimistic receipt-item adapter |
| `platform/capture/sharetarget.html` | real page | share-target landing + quick-add; posts to the queue, redirects home |
| `platform/capture/manifest.snippet.json` | snippet | exact `share_target` + `shortcuts` keys to merge into the manifest |

---

## 5. Setup / credential blockers (call-outs)

- **Backend contract must land**: `POST/PATCH/DELETE /api/ideas`, `GET
  /api/lists`, session-cookie auth, and **idempotent `op_id`/`client_id`**
  handling. The queue assumes at-least-once delivery is safe.
- **Share target requires installation**: it only appears after the PWA is
  installed; not testable in a normal tab. Android-only as a true share target.
- **iOS caveats**: no Web Share Target API → rely on app-shortcut + iOS Shortcuts
  recipe + in-app quick-add. Web Speech API is flaky/partial on iOS → fall back
  to keyboard dictation.
- **HTTPS required** for service worker, microphone, and install — the CDN/static
  host must serve over TLS (GitHub Pages already does).
- **Module loading**: enabling imports in `app.js` needs `type="module"` on its
  `<script>` tag (one-line change) *or* the `window.capture` shim described in
  §1.4 — a decision for the integration PR.
- **CORS for URL enrichment** is not guaranteed; treat the `<title>` lift as
  best-effort, or add a server-side enricher to the SPINE later.
- **SW cache version bump** (`v4 → v5`) needed when the new assets are added so
  clients pick them up.
