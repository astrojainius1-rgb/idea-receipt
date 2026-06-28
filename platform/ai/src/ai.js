/* idea-receipt — AI workstream (#10 auto-tag, #11 expand, #12 digest, #13 semantic search)
 *
 * A deployable Cloudflare Worker module. It implements four endpoints plus a weekly
 * cron and an ingest hook, against the shared spine (D1 + Vectorize + KV + Workers AI),
 * and calls the Anthropic Claude API for generation.
 *
 * This is real, runnable code. It is NOT deployed by the author of this file — wire the
 * bindings from wrangler.snippet.toml into the backend's wrangler.toml, set the
 * ANTHROPIC_API_KEY secret, enable Workers AI, and create the Vectorize index. See README.md.
 *
 * Bindings (env):
 *   env.DB         — D1 (system of record; ideas, digests)
 *   env.VECTORIZE  — Vectorize index `idea-receipt-ideas` (768-dim, cosine)
 *   env.AI         — Workers AI (embeddings)
 *   env.AI_KV      — KV (rate-limit buckets, latest digest, reindex queue, expand cache)
 *   env.ANTHROPIC_API_KEY — secret
 *
 * Prompt templates are imported as text modules (see wrangler.snippet.toml `rules`).
 */

import TAG_PROMPT from "../prompts/tag.md";
import EXPAND_PROMPT from "../prompts/expand.md";
import DIGEST_PROMPT from "../prompts/digest.md";

// ---- config -----------------------------------------------------------------
// Cheapest model that fits these short, single-turn tasks. One-line swap to
// `claude-sonnet-4-6` if quality ever falls short. See docs/PLAN-ai.md.
const MODEL = "claude-haiku-4-5";
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768-dim
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const RATE_LIMITS = { tag: 60, expand: 20, search: 120, digest_run: 2 };
const RL_WINDOW_S = 60; // per-minute buckets (digest_run uses a day window, handled inline)

// ---- router -----------------------------------------------------------------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const session = await requireSession(req, env); // { user_id, is_admin }
      const path = url.pathname;

      if (path === "/api/ai/tag" && req.method === "POST")
        return await handleTag(req, env, session, cors);
      if (path === "/api/ai/expand" && req.method === "POST")
        return await handleExpand(req, env, session, cors);
      if (path === "/api/ai/digest" && req.method === "GET")
        return await handleGetDigest(req, env, session, cors);
      if (path === "/api/ai/digest/run" && req.method === "POST")
        return await handleRunDigest(req, env, session, ctx, cors);
      if (path === "/api/search" && req.method === "POST")
        return await handleSearch(req, env, session, cors);

      return json({ error: "not_found" }, 404, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code }, e.status, cors);
      console.error("ai worker error", e);
      return json({ error: "internal" }, 500, cors);
    }
  },

  // Weekly digest cron (schedule in wrangler.snippet.toml: "0 13 * * 1").
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWeeklyDigest(env, ctx));
  },
};

// =============================================================================
// #10 — Auto-tagging
// =============================================================================
async function handleTag(req, env, session, cors) {
  await enforceRateLimit(env, session.user_id, "tag");
  const bodyReq = await readJson(req);
  const idea = await loadOwnedIdea(env, session.user_id, bodyReq.idea_id, bodyReq);

  // Known vocabulary: the user's existing tags (growing set), most-used first.
  const knownVocab = await userVocabulary(env, session.user_id); // string[]

  // Related ideas (also used to cluster tags) — best-effort.
  let related = [];
  try {
    const vec = await embedIdea(env, idea);
    related = await queryRelated(env, session.user_id, vec, idea.id, 5);
  } catch (e) {
    console.warn("tag: related lookup failed", e);
  }

  let suggested = [];
  try {
    const filled = fill(TAG_PROMPT, {
      known_vocab: knownVocab.length ? knownVocab.join(", ") : "(none yet)",
      related: related.length
        ? related.map((r) => `- ${r.title} [${(r.tags || []).join(", ")}]`).join("\n")
        : "(none)",
      title: idea.title,
      body: bulletText(idea.body),
      existing_tags: (idea.tags || []).join(", ") || "(none)",
    });
    const out = await claudeJSON(env, filled, TAG_SCHEMA, 256);
    suggested = normalizeTags(out.tags, idea.tags || [], knownVocab);
  } catch (e) {
    console.warn("tag: claude failed, returning related-only", e);
  }

  return json({ suggested_tags: suggested, related }, 200, cors);
}

const TAG_SCHEMA = {
  type: "object",
  properties: {
    tags: {
      type: "array",
      items: {
        type: "object",
        properties: { tag: { type: "string" }, new: { type: "boolean" } },
        required: ["tag", "new"],
        additionalProperties: false,
      },
    },
  },
  required: ["tags"],
  additionalProperties: false,
};

function normalizeTags(raw, existing, knownVocab) {
  const have = new Set(existing.map(kebab));
  const known = new Set(knownVocab.map(kebab));
  const seen = new Set();
  const out = [];
  for (const t of raw || []) {
    const tag = kebab(t.tag || "");
    if (!tag || have.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, new: !known.has(tag) });
    if (out.length >= 4) break;
  }
  return out;
}

// =============================================================================
// #11 — Expand an idea
// =============================================================================
async function handleExpand(req, env, session, cors) {
  await enforceRateLimit(env, session.user_id, "expand");
  const { idea_id } = await readJson(req);
  const idea = await loadOwnedIdea(env, session.user_id, idea_id, null);

  // Cache by idea content hash — repeat taps on an unchanged idea are free.
  const hash = await contentHash(idea);
  const cacheKey = `expand:${idea.id}:${hash}`;
  const cached = await env.AI_KV.get(cacheKey, "json");
  if (cached) return json(cached, 200, cors);

  let brief;
  try {
    const filled = fill(EXPAND_PROMPT, { title: idea.title, body: bulletText(idea.body) });
    brief = await claudeJSON(env, filled, EXPAND_SCHEMA, 512);
  } catch (e) {
    console.error("expand: claude failed", e);
    return json({ error: "expand_unavailable" }, 503, cors);
  }

  const result = {
    framing: brief.framing || "",
    next_steps: Array.isArray(brief.next_steps) ? brief.next_steps.slice(0, 5) : [],
    watch_out: brief.watch_out || "",
  };
  await env.AI_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 7 * 24 * 3600 });
  return json(result, 200, cors);
}

const EXPAND_SCHEMA = {
  type: "object",
  properties: {
    framing: { type: "string" },
    next_steps: { type: "array", items: { type: "string" } },
    watch_out: { type: "string" },
  },
  required: ["framing", "next_steps", "watch_out"],
  additionalProperties: false,
};

// =============================================================================
// #12 — Weekly digest
// =============================================================================
async function handleGetDigest(req, env, session, cors) {
  await enforceRateLimit(env, session.user_id, "search"); // cheap read; reuse the generous bucket
  const latest = await env.AI_KV.get(`digest:${session.user_id}:latest`, "json");
  if (!latest) return new Response(null, { status: 204, headers: cors });
  return json(latest, 200, cors);
}

async function handleRunDigest(req, env, session, ctx, cors) {
  if (!session.is_admin) throw new HttpError(403, "forbidden");
  await enforceDailyLimit(env, session.user_id, "digest_run", RATE_LIMITS.digest_run);
  const { user_id } = await readJson(req);
  const target = user_id || session.user_id;
  const digest = await buildDigestForUser(env, target);
  return json(digest || { note: "quiet_week" }, 200, cors);
}

async function runWeeklyDigest(env, ctx) {
  // Paginate active users from D1 so a large account can't blow the CPU budget.
  let cursor = 0;
  const PAGE = 100;
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM users WHERE active = 1 ORDER BY id LIMIT ? OFFSET ?`
    )
      .bind(PAGE, cursor)
      .all();
    if (!results || results.length === 0) break;
    for (const row of results) {
      // Each user isolated: one failure doesn't abort the run.
      ctx.waitUntil(
        buildDigestForUser(env, row.id).catch((e) =>
          console.error("digest failed for", row.id, e)
        )
      );
    }
    if (results.length < PAGE) break;
    cursor += PAGE;
  }
}

async function buildDigestForUser(env, userId) {
  const weekStart = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, title, body, tags FROM ideas
       WHERE user_id = ? AND added >= ? ORDER BY added DESC LIMIT 60`
  )
    .bind(userId, weekStart)
    .all();

  const ideas = (results || []).map(deserializeIdea);
  if (ideas.length === 0) return null; // quiet week — nothing stored

  const idsText = ideas
    .map((i) => `- ${i.title}${(i.tags || []).length ? ` [${i.tags.join(", ")}]` : ""}`)
    .join("\n");

  const filled = fill(DIGEST_PROMPT, { count: String(ideas.length), ideas: idsText });
  const out = await claudeJSON(env, filled, DIGEST_SCHEMA, 512);

  const digest = {
    week_start: weekStart,
    generated_at: new Date().toISOString(),
    recap: out.recap || "",
    themes: Array.isArray(out.themes) ? out.themes.slice(0, 3) : [],
    nudge: out.nudge || "",
  };

  // D1 = durable record; KV = fast latest-read. push/email later reads the `delivered` flag.
  await env.DB.prepare(
    `INSERT INTO digests (user_id, week_start, generated_at, recap, themes, nudge, delivered)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  )
    .bind(userId, digest.week_start, digest.generated_at, digest.recap, JSON.stringify(digest.themes), digest.nudge)
    .run();
  await env.AI_KV.put(`digest:${userId}:latest`, JSON.stringify(digest));
  return digest;
}

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    recap: { type: "string" },
    themes: { type: "array", items: { type: "string" } },
    nudge: { type: "string" },
  },
  required: ["recap", "themes", "nudge"],
  additionalProperties: false,
};

// =============================================================================
// #13 — Semantic search (+ ingest hook)
// =============================================================================
async function handleSearch(req, env, session, cors) {
  await enforceRateLimit(env, session.user_id, "search");
  const { q, list_id, k = 20, hybrid = false } = await readJson(req);
  if (!q || typeof q !== "string") throw new HttpError(400, "missing_query");

  let semantic = [];
  try {
    const [vec] = await embedTexts(env, [q]);
    const filter = { user_id: session.user_id };
    if (list_id) filter.list_id = list_id;
    const res = await env.VECTORIZE.query(vec, {
      topK: Math.min(k, 50),
      filter,
      returnMetadata: false,
    });
    semantic = (res.matches || []).map((m, i) => ({ id: m.id, score: m.score, rank: i + 1 }));
  } catch (e) {
    console.error("search: vectorize failed", e);
    if (!hybrid) return json({ error: "search_unavailable" }, 503, cors);
  }

  if (!hybrid) {
    return json(
      { results: semantic.map((s) => ({ id: s.id, score: s.score, match: "semantic" })) },
      200,
      cors
    );
  }

  // Hybrid: fuse with the Organize workstream's keyword search via Reciprocal Rank Fusion.
  // Contract: keywordSearch returns [{ id, rank }] for the same user. If unavailable,
  // RRF over semantic alone == pure semantic ordering, so hybrid degrades gracefully.
  let keyword = [];
  try {
    keyword = await keywordSearch(env, session.user_id, q, list_id, k);
  } catch (e) {
    console.warn("search: keyword backend unavailable, semantic-only", e);
  }
  const fused = reciprocalRankFusion(semantic, keyword, k);
  return json({ results: fused }, 200, cors);
}

// Called from the backend's idea-write handler (spine owns the route). Best-effort:
// must NEVER block or fail the D1 write — caller wraps in ctx.waitUntil and ignores throws.
export async function embedAndUpsert(env, idea) {
  const hash = await contentHash(idea);
  if (idea.ai_hash === hash) return; // unchanged — no-op
  try {
    const vec = await embedIdea(env, idea);
    await env.VECTORIZE.upsert([
      {
        id: idea.id,
        values: vec,
        metadata: { user_id: idea.user_id, list_id: idea.list_id, status: idea.status || "open" },
      },
    ]);
    // The caller should persist ai_hash on the idea row after this resolves.
    return hash;
  } catch (e) {
    console.error("embedAndUpsert failed; queueing for backfill", idea.id, e);
    await env.AI_KV.put(`reindex:${idea.id}`, idea.id, { expirationTtl: 7 * 24 * 3600 });
    throw e;
  }
}

export async function removeIdeaVector(env, ideaId) {
  await env.VECTORIZE.deleteByIds([ideaId]);
}

// RRF: rank-based fusion needs no score calibration between the two systems.
function reciprocalRankFusion(semantic, keyword, k) {
  const K = 60;
  const acc = new Map(); // id -> { score, sources:Set }
  const add = (list, source) => {
    for (const item of list) {
      const cur = acc.get(item.id) || { score: 0, sources: new Set() };
      cur.score += 1 / (K + item.rank);
      cur.sources.add(source);
      acc.set(item.id, cur);
    }
  };
  add(semantic, "semantic");
  add(keyword, "keyword");
  return [...acc.entries()]
    .map(([id, v]) => ({
      id,
      score: v.score,
      match: v.sources.size === 2 ? "both" : [...v.sources][0],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// =============================================================================
// Shared: Claude + embeddings
// =============================================================================
async function claudeJSON(env, prompt, schema, maxTokens) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(501, "anthropic_not_configured");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      // Structured output guarantees parseable JSON — no prefill, no regex scraping.
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("claude error", res.status, text);
    throw new Error(`claude ${res.status}`);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("claude_refusal");
  const block = (data.content || []).find((b) => b.type === "text");
  if (!block) throw new Error("claude_no_text");
  return JSON.parse(block.text); // always parse JSON — never raw-string-match tool/format output
}

async function embedIdea(env, idea) {
  const text = `${idea.title}\n${bulletText(idea.body)}`.trim();
  const [vec] = await embedTexts(env, [text]);
  return vec;
}

async function embedTexts(env, texts) {
  if (!env.AI) throw new HttpError(501, "workers_ai_not_configured");
  const out = await env.AI.run(EMBED_MODEL, { text: texts });
  return out.data; // array of 768-dim arrays
}

async function queryRelated(env, userId, vec, selfId, k) {
  const res = await env.VECTORIZE.query(vec, {
    topK: k + 1,
    filter: { user_id: userId },
    returnMetadata: false,
  });
  const ids = (res.matches || []).filter((m) => m.id !== selfId).slice(0, k);
  if (ids.length === 0) return [];
  // Hydrate titles + tags from D1 for the "related" output and tag clustering.
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, title, tags FROM ideas WHERE user_id = ? AND id IN (${placeholders})`
  )
    .bind(userId, ...ids.map((m) => m.id))
    .all();
  const byId = new Map((results || []).map((r) => [r.id, deserializeIdea(r)]));
  return ids
    .filter((m) => byId.has(m.id))
    .map((m) => ({ id: m.id, title: byId.get(m.id).title, tags: byId.get(m.id).tags, score: m.score }));
}

// =============================================================================
// Shared: D1 / vocab / spine adapters
// =============================================================================
async function loadOwnedIdea(env, userId, ideaId, inlineBody) {
  if (!ideaId) throw new HttpError(400, "missing_idea_id");
  const row = await env.DB.prepare(
    `SELECT id, user_id, list_id, title, body, tags, status, ai_hash FROM ideas WHERE id = ?`
  )
    .bind(ideaId)
    .first();
  if (!row) throw new HttpError(404, "idea_not_found");
  if (row.user_id !== userId) throw new HttpError(403, "forbidden"); // never trust caller-supplied owner
  const idea = deserializeIdea(row);
  // Allow the client to pass freshly-edited title/body before the write lands.
  if (inlineBody) {
    if (typeof inlineBody.title === "string") idea.title = inlineBody.title;
    if (Array.isArray(inlineBody.body)) idea.body = inlineBody.body;
  }
  return idea;
}

async function userVocabulary(env, userId) {
  // Existing tags, most-used first — the growing constrained vocabulary.
  const { results } = await env.DB.prepare(
    `SELECT tag, COUNT(*) n FROM idea_tags WHERE user_id = ? GROUP BY tag ORDER BY n DESC LIMIT 200`
  )
    .bind(userId)
    .all();
  return (results || []).map((r) => r.tag);
}

// Organize workstream's keyword search. Adapter kept here so the contract is explicit;
// replace the body with a call to their service/binding. Returns [{ id, rank }].
async function keywordSearch(env, userId, q, listId, k) {
  if (!env.KEYWORD_SEARCH) throw new Error("keyword_search_not_bound");
  const res = await env.KEYWORD_SEARCH.fetch("https://internal/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, q, list_id: listId, k }),
  });
  if (!res.ok) throw new Error(`keyword_search ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r, i) => ({ id: r.id, rank: r.rank ?? i + 1 }));
}

function deserializeIdea(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    list_id: row.list_id,
    title: row.title || "",
    body: parseMaybeJson(row.body, []),
    tags: parseMaybeJson(row.tags, []),
    status: row.status,
    ai_hash: row.ai_hash,
  };
}

// =============================================================================
// Shared: auth, rate limiting, helpers
// =============================================================================
class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Spine owns session-cookie auth. This validates the cookie against the spine's session
// store and returns the resolved identity. Replace with the spine's helper/binding.
async function requireSession(req, env) {
  const cookie = req.headers.get("cookie") || "";
  const sid = /(?:^|;\s*)session=([^;]+)/.exec(cookie)?.[1];
  if (!sid) throw new HttpError(401, "unauthenticated");
  const sess = await env.AI_KV.get(`session:${sid}`, "json"); // spine writes these
  if (!sess || !sess.user_id) throw new HttpError(401, "unauthenticated");
  return { user_id: sess.user_id, is_admin: !!sess.is_admin };
}

// Per-user fixed-window token bucket in KV.
async function enforceRateLimit(env, userId, feature) {
  const limit = RATE_LIMITS[feature];
  const bucket = Math.floor(Date.now() / 1000 / RL_WINDOW_S);
  const key = `rl:${userId}:${feature}:${bucket}`;
  const n = parseInt((await env.AI_KV.get(key)) || "0", 10) + 1;
  if (n > limit) throw new HttpError(429, "rate_limited");
  await env.AI_KV.put(key, String(n), { expirationTtl: RL_WINDOW_S * 2 });
}

async function enforceDailyLimit(env, userId, feature, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${userId}:${feature}:${day}`;
  const n = parseInt((await env.AI_KV.get(key)) || "0", 10) + 1;
  if (n > limit) throw new HttpError(429, "rate_limited");
  await env.AI_KV.put(key, String(n), { expirationTtl: 25 * 3600 });
}

function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

function bulletText(body) {
  return (Array.isArray(body) ? body : []).map((b) => `- ${b}`).join("\n") || "(no details)";
}

function kebab(s) {
  return String(s)
    .toLowerCase()
    .replace(/^#+/, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function contentHash(idea) {
  const data = `${idea.title}\n${bulletText(idea.body)}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function parseMaybeJson(v, fallback) {
  if (v == null) return fallback;
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Credentials": "true",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
