# idea-receipt — AI workstream plan

The intelligence layer for idea-receipt. Four features, all new `/api/ai/*` (and
`/api/search`) endpoints on the shared Cloudflare Worker backend (D1 + Vectorize +
KV), all leaning on Claude. This document is the plan; the deployable scaffold lives
under `platform/ai/`.

We are literally built on Claude — so generation tasks call the **Anthropic Claude
API**, and we use it confidently for tagging, expansion, and digesting rather than
hand-rolling heuristics.

---

## 0. Shared decisions (read this first)

### Idea shape (system of record = D1)

From `app.js` / `sync_notion.py`, an idea is:

```
{ id, user_id, list_id, title, body[], tags[], status, priority, added/timestamps }
```

`body` is the bullet/`details` array. The receipt UI treats `title` + `details` as
the substance of an idea; the AI features operate on the same two fields plus `tags`.

### Model choice — `claude-haiku-4-5` for all four features

The SPINE suggests `claude-sonnet-4-6` for "cheap/fast tasks." We go one tier cheaper:
**Claude Haiku 4.5** (`claude-haiku-4-5`, $1 / $5 per 1M in/out, 200K context).

Why Haiku and not Sonnet:

| Task | Output size | Why Haiku is enough |
|---|---|---|
| Auto-tag (#10) | 1–4 short tags (JSON) | Constrained classification against a supplied vocabulary — Haiku-class. |
| Expand (#11) | a short brief (~300 tokens) | Single idea in, structured brief out; no multi-step reasoning. |
| Weekly digest (#12) | ~250-token summary | Summarization over a bounded week of ideas. |

All three are short-output, single-turn, latency-sensitive, and run at volume (tagging
fires on every write). Haiku is the cheapest model that fits and keeps per-call cost
~1/3 of Sonnet. The model id is a single config constant (`MODEL` in `src/ai.js`); if
quality ever falls short, swap to `claude-sonnet-4-6` in one line.

Thinking is **off** for all three — these are fast, shallow tasks where adaptive
thinking would only add latency and cost. (Haiku 4.5 does not support the `effort`
parameter; we simply omit `thinking`.)

We pin `anthropic-version: 2023-06-01` and call the REST API directly with `fetch`
(Workers have no Node SDK; raw HTTP is the correct surface here).

### Embeddings — Cloudflare Workers AI `@cf/baai/bge-base-en-v1.5`

768-dim, English, runs **inside the Worker** via the `AI` binding. Chosen over an
embeddings API (e.g. OpenAI/Voyage) because:

- **No extra secret, no egress.** The write path (D1 write → embed → Vectorize upsert)
  stays entirely inside Cloudflare; one fewer vendor and key to manage.
- **Cost.** Billed in Cloudflare "neurons" from the same Workers AI allotment; an idea
  is short (title + a few bullets), so each embed is a few hundred tokens — negligible.
- **Latency.** Same-datacenter call, no public-internet round trip.

Vectorize index: `idea-receipt-ideas`, **768 dimensions, cosine** metric. Vectors are
keyed by **idea id** so write = upsert and delete = delete (no orphans). Per-vector
metadata: `{ user_id, list_id, status }` so queries can filter to the caller's own
ideas server-side. Embedding input is `title + "\n" + body.join("\n")`.

> If the team prefers a hosted embeddings API later, only `embedIdea()` in `src/ai.js`
> and the index dimensionality change; the ingest/query flow is identical.

### Cross-cutting concerns (apply to every endpoint)

- **Auth.** Every endpoint is behind the spine's session-cookie auth. The handler
  resolves `user_id` from the session; an idea is only touched if it belongs to the
  caller. Never trust a `user_id`/`list_id` from the request body.
- **Rate limiting.** Per-user token-bucket in **KV** (`rl:<user_id>:<feature>`), checked
  before any Claude/Workers-AI call. Defaults: tag 60/min, expand 20/min, search 120/min,
  digest is cron-only (not user-triggerable) plus a manual 2/day admin path. Over-limit →
  `429` with `Retry-After`.
- **Failure / fallback.** Claude or Workers AI is a best-effort enhancement, never a hard
  dependency of a write:
  - Tagging failure → idea still saves with whatever tags the user typed; we just skip
    suggestions (log + move on).
  - Embedding failure on write → idea still saves; we enqueue the id in KV
    (`reindex:<id>`) for a later backfill so search eventually catches up.
  - Expand failure → `503` with a friendly message; the UI shows "couldn't expand, try
    again."
  - Digest failure → cron logs it and retries next run; nothing user-facing breaks.
- **Cost guardrails.** Inputs are tiny (one idea, or one week of ideas), so per-call cost
  is fractions of a cent. The real lever is *call volume* — hence rate limiting and the
  "tag on debounced write, not on keystroke" rule below.
- **Idempotency.** Tagging and embedding are keyed by idea id and content hash; re-running
  on unchanged content is a no-op (we store `ai_hash` on the idea row and skip if equal).

### Secrets & bindings the user must set

Secrets (`wrangler secret put`):
- `ANTHROPIC_API_KEY` — Claude API key. **Blocker: user must supply.**

Bindings (in `wrangler.snippet.toml`, merged into the main backend `wrangler.toml`):
- `AI` — Workers AI binding (**requires Workers AI enabled on the account**).
- `VECTORIZE` → index `idea-receipt-ideas` (768-dim, cosine) — **must be created once**:
  `wrangler vectorize create idea-receipt-ideas --dimensions=768 --metric=cosine`
- `DB` — the existing D1 binding (system of record).
- `AI_KV` — KV namespace for rate-limit buckets, digest storage, and reindex queue.
- Cron trigger `0 13 * * 1` (Mon 13:00 UTC) for the weekly digest.

---

## 1. Auto-tagging (#10) — `POST /api/ai/tag`

### Goal
On idea create/update, suggest 1–4 tags. Tags are constrained to a **growing
vocabulary**: the union of the user's existing tags (the "known vocab") plus a small
number of genuinely new "free" tags when nothing existing fits. Also surface *related
ideas* so the user can dedup/cluster.

### Trigger & UX
- Fires server-side on idea create/update — but **debounced**: the client calls `/api/ai/tag`
  ~1.5s after the user stops editing, not on every keystroke. Saving the idea does not block
  on tagging.
- Response returns `suggested_tags` (with a `new: true/false` flag each) and `related` ideas.
  The UI shows suggested tags as tappable chips below the idea ("+ #productivity"); tapping
  adds the tag. Related ideas show as a subtle "similar to: …" line.

### Request / response
```
POST /api/ai/tag
{ "idea_id": "abc", "title": "...", "body": ["...","..."] }   // body optional; server can load from D1

200
{
  "suggested_tags": [
    { "tag": "writing", "new": false },
    { "tag": "side-project", "new": true }
  ],
  "related": [ { "id": "def", "title": "...", "score": 0.83 } ]
}
```

### How it works
1. Resolve `user_id` from session; load the idea + the user's existing tag vocabulary
   from D1 (`SELECT DISTINCT tag ... WHERE user_id=?`), capped at ~200 most-used.
2. Compute `related` by embedding the idea (reuse the write-path embedding if fresh) and
   running a Vectorize query (top-5, filtered to this user, excluding self). This both
   powers the "related" output and gives Claude *context for clustering* — if there's a
   tight neighbour, Claude is told its tags so suggestions cluster rather than fragment
   (e.g. don't invent `#sideproject` when neighbours use `#side-project`).
3. Call Claude (`claude-haiku-4-5`) with the tag prompt (below), passing: the idea, the
   known vocabulary, and the neighbours' tags. **Structured output** (`output_config.format`,
   a JSON schema) guarantees a parseable `{tags:[{tag,new}]}` — no prefill, no regex.
4. Post-process: lowercase, kebab-case, strip `#`, drop dupes and anything already on the
   idea, cap at 4. Mark `new:true` only if the tag isn't in the known vocab. Persist nothing
   automatically — suggestions are opt-in by the user. (When the user accepts a tag, the
   normal idea-update path stores it, which also grows the vocabulary for next time.)

### Prompt
See `platform/ai/prompts/tag.md` (loaded verbatim, with `{{...}}` placeholders filled by
the worker). Summary: system role constrains output to 1–4 tags, prefers reusing the
supplied vocabulary, only coins a new tag when nothing fits, forbids near-duplicates of
existing tags, and returns strict JSON.

### Cost / latency
~400 input + ~40 output tokens → ~$0.0006/call on Haiku. One Vectorize query + one embed
(often cached). Sub-second p50. Rate-limited 60/min/user.

### Failure / fallback
Claude error or bad JSON → return `{ suggested_tags: [], related: [...] }` (related still
works from Vectorize alone). The idea write itself never depends on this call.

---

## 2. Expand an idea (#11) — `POST /api/ai/expand`

### Goal
Turn a one-line idea into a short, actionable mini-brief: a one-sentence framing, 3–5
concrete next steps, and an optional "watch out for" note.

### Trigger & UX
Tap an idea on the receipt → an "expand ✦" action → calls `/api/ai/expand`. The brief
renders in an expandable panel under the idea. The user can copy it, or "save as bullets"
which appends the next-steps to the idea's `body` via the normal update path (and back to
Notion on next sync).

### Request / response
```
POST /api/ai/expand
{ "idea_id": "abc" }                       // server loads title+body from D1

200
{
  "framing": "A weekly email that…",
  "next_steps": ["Sketch the data model", "Pick a sender (Resend?)", "..."],
  "watch_out": "Don't over-build the editor before you have 1 subscriber."
}
```

### How it works
1. Resolve session → `user_id`; load the idea from D1 (authorize ownership).
2. Call Claude (`claude-haiku-4-5`) with the expand prompt, idea title + body. Structured
   output schema → `{framing, next_steps[], watch_out}`.
3. Return as-is. Optionally cache the brief in KV (`expand:<idea_id>:<ai_hash>`, 7-day TTL)
   so repeat taps on an unchanged idea are free.

### Prompt
See `platform/ai/prompts/expand.md`. Concise, action-oriented, no fluff; tailors depth to
how much the idea already says; explicitly avoids generic "do market research" filler.

### Cost / latency
~250 input + ~250 output → ~$0.0015/call on Haiku. ~1s p50. Rate-limited 20/min/user; KV
cache makes repeat taps free.

### Failure / fallback
Claude error → `503` + UI toast "couldn't expand, try again." Nothing persisted, idea
untouched.

---

## 3. Weekly digest (#12) — cron + `GET /api/ai/digest`

### Goal
Once a week, summarize the week's new ideas: a short recap, 2–3 emergent themes, and one
gentle nudge ("you keep circling writing tools — pick one and ship it"). Store it; later,
push/email it.

### Trigger
A Cloudflare **cron trigger** (`0 13 * * 1` — Monday 13:00 UTC) iterates active users,
builds each user's digest, and writes it to D1 (`digests` table) + KV (`digest:<user_id>:latest`).
`GET /api/ai/digest` returns the caller's latest stored digest for display (the receipt
app can show "your week in ideas"). Generation is **not** user-triggerable (cost control);
an admin-only `POST /api/ai/digest/run` exists for manual regen, rate-limited 2/day.

### Cron config
```toml
[triggers]
crons = ["0 13 * * 1"]
```
The Worker's `scheduled()` handler fans out over users (paginated from D1), each in a
`ctx.waitUntil`, with a per-user cap so a big account can't blow the CPU-time budget.

### How it works
1. For each user, `SELECT` ideas with `added >= now-7d` (and a count of total ideas for
   context). If zero new ideas, skip (or store a "quiet week" note).
2. Call Claude (`claude-haiku-4-5`) with the digest prompt: the week's ideas (titles +
   tags, bodies truncated). Structured output → `{recap, themes[], nudge}`.
3. Store `{ generated_at, week_start, recap, themes, nudge }` in D1 `digests` and mirror
   the latest to KV for fast reads.
4. (Later) push via Web Push / email via Resend — out of scope for this milestone, but the
   stored shape is push/email-ready. A `delivered` flag on the row tracks it.

### Request / response (read path)
```
GET /api/ai/digest
200 { "week_start": "...", "recap": "...", "themes": ["...","..."], "nudge": "..." }
204 (no digest yet)
```

### Prompt
See `platform/ai/prompts/digest.md`. Warm but brief, receipt-app voice; one nudge max, no
guilt-tripping; grounds themes in the actual ideas (no invented patterns).

### Cost / latency
~800 input + ~250 output → ~$0.002/user/week. Runs off the request path, so latency is
irrelevant. The cost lever is user count × weekly cadence — trivial at small scale.

### Failure / fallback
Per-user failure is caught and logged; the cron continues to the next user and retries the
failed one next week. No partial/corrupt digest is stored.

---

## 4. Semantic search (#13) — ingest on write + `POST /api/search`

### Goal
Find ideas by meaning, not just keyword. "things about staying focused" should surface
`#productivity` ideas even without the word.

### Ingest path (on every idea write)
On idea create/update in the backend's idea-write handler (the spine owns that route; this
workstream provides `embedAndUpsert(idea)` to call from it):
1. Build embedding input = `title + "\n" + body.join("\n")`.
2. `env.AI.run("@cf/baai/bge-base-en-v1.5", { text })` → 768-dim vector.
3. `env.VECTORIZE.upsert([{ id: idea.id, values, metadata: { user_id, list_id, status } }])`.
4. Store `ai_hash` (hash of the input) on the idea row; skip steps 1–3 if unchanged.

On idea delete → `env.VECTORIZE.deleteByIds([idea.id])`. Vectors are keyed by idea id, so
there are never orphans. A KV `reindex:<id>` queue + a small cron sweep backfills any embed
that failed during a write (failure must never block the D1 write).

### Query path — `POST /api/search`
```
POST /api/search
{ "q": "staying focused", "list_id": "optional", "k": 20, "hybrid": true }

200
{ "results": [ { "id": "abc", "score": 0.81, "match": "semantic" }, ... ] }
```
1. Resolve session → `user_id`.
2. Embed `q` with the same `@cf/baai/bge-base-en-v1.5` model.
3. `env.VECTORIZE.query(vector, { topK: k, filter: { user_id }, returnMetadata: true })`.
   Filtering by `user_id` (and optional `list_id`) is done **server-side in Vectorize** so a
   user only ever matches their own ideas.
4. Return ranked **idea ids + scores** (the client/spine hydrates titles from D1 — search
   returns ids, never leaks other users' content).

### Composing with the Organize workstream's keyword search
The Organize workstream owns lexical/keyword search over D1. `/api/search` supports a
**hybrid** mode: when `hybrid:true`, the handler also asks the keyword search for its ranked
ids, then fuses the two rankings with **Reciprocal Rank Fusion** (`score = Σ 1/(k+rank)`,
k=60). This is rank-based so it needs no score calibration between the two systems. Results
carry a `match` field (`semantic` / `keyword` / `both`) so the UI can explain *why* an idea
matched. If the Organize search isn't wired up yet, `hybrid` degrades to pure semantic.
Contract between the two: both return `[{id, rank}]` for the same `user_id`; the fuser lives
here.

### Cost / latency
One embed per query (Workers AI, in-datacenter) + one Vectorize query. No Claude call →
effectively free and fast (p50 < 150ms). Rate-limited 120/min/user.

### Failure / fallback
Vectorize/embedding error → fall back to keyword-only results (if Organize is available),
else `503`. Search is read-only; nothing to corrupt.

---

## Appendix — endpoint summary

| Endpoint | Method | Model / index | Rate limit |
|---|---|---|---|
| `/api/ai/tag` | POST | `claude-haiku-4-5` + Vectorize | 60/min |
| `/api/ai/expand` | POST | `claude-haiku-4-5` | 20/min |
| `/api/ai/digest` | GET | (reads stored) | 120/min |
| `/api/ai/digest/run` | POST (admin) | `claude-haiku-4-5` | 2/day |
| `/api/search` | POST | `@cf/baai/bge-base-en-v1.5` + Vectorize | 120/min |
| (cron) weekly digest | — | `claude-haiku-4-5` | `0 13 * * 1` |
| (ingest hook) `embedAndUpsert` | — | `@cf/baai/bge-base-en-v1.5` + Vectorize | on write |

**User credential blockers:** set `ANTHROPIC_API_KEY` (secret); enable **Workers AI** on the
account; create the **Vectorize** index `idea-receipt-ideas` (768-dim, cosine). Without these
three the AI endpoints return `503`/`501` cleanly rather than crashing.
