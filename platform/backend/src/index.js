/* idea-receipt backend API — Cloudflare Worker.
 *
 * The "spine": D1 = system of record, Vectorize = idea embeddings (semantic search,
 * consumed by the AI workstream), KV = sessions + push subscriptions.
 *
 * REST under /api, JSON bodies, HttpOnly session-cookie auth. Everything is scoped to
 * the authenticated user. This single file is a small hand-rolled router; the full
 * contract it implements is documented in docs/PLAN-backend.md.
 *
 * Bindings (see wrangler.toml): DB (D1), SESSIONS (KV), PUSH_SUBS (KV),
 *   IDEAS_VEC (Vectorize), AI (Workers AI). Secrets: GOOGLE_CLIENT_SECRET,
 *   NOTION_IMPORT_TOKEN, MAGIC_LINK_SECRET.
 */

const COOKIE = "ir_session";
const json = (obj, status = 200, extra = {}) =>
  new Response(obj === null ? "" : JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/* ── CORS ──────────────────────────────────────────────────────────────────── */
function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : (allowed[0] || "*"),
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Vary": "Origin",
  };
}

/* ── sessions (KV authoritative, D1 audit copy) ────────────────────────────── */
function cookieFromReq(req) {
  const raw = req.headers.get("Cookie") || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(token, env) {
  const days = parseInt(env.SESSION_TTL_DAYS || "30", 10);
  const maxAge = days * 86400;
  // SameSite=None;Secure is required because the PWA (GitHub Pages) and the API are
  // on different origins. HttpOnly keeps JS from reading the session.
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;
}
function clearCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`;
}
async function createSession(env, userId, userAgent) {
  const token = uuid() + uuid().replace(/-/g, "");
  const days = parseInt(env.SESSION_TTL_DAYS || "30", 10);
  const expIso = new Date(Date.now() + days * 86400e3).toISOString();
  await env.SESSIONS.put(token, JSON.stringify({ user_id: userId }), { expirationTtl: days * 86400 });
  // best-effort audit copy in D1
  try {
    await env.DB.prepare(
      "INSERT INTO sessions (token,user_id,user_agent,created_at,expires_at) VALUES (?,?,?,?,?)"
    ).bind(token, userId, userAgent || null, nowIso(), expIso).run();
  } catch (_) {}
  return token;
}
async function userFromReq(req, env) {
  const token = cookieFromReq(req);
  if (!token) return null;
  const raw = await env.SESSIONS.get(token);
  if (!raw) return null;
  let sess;
  try { sess = JSON.parse(raw); } catch { return null; }
  const row = await env.DB.prepare("SELECT id,email,name,created_at FROM users WHERE id=?")
    .bind(sess.user_id).first();
  return row ? { ...row, _token: token } : null;
}

/* ── small helpers ─────────────────────────────────────────────────────────── */
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
function tagsToJson(tags) {
  if (Array.isArray(tags)) return JSON.stringify(tags.map(String));
  if (typeof tags === "string") return JSON.stringify(tags.split(",").map((s) => s.trim()).filter(Boolean));
  return "[]";
}
function ideaOut(row) {
  return {
    id: row.id, list_id: row.list_id, title: row.title, body: row.body,
    tags: safeJson(row.tags, []), status: row.status, priority: row.priority,
    due_at: row.due_at, source: row.source, notion_block_id: row.notion_block_id,
    created_at: row.created_at, updated_at: row.updated_at, deleted_at: row.deleted_at,
  };
}
function safeJson(s, dflt) { try { return JSON.parse(s); } catch { return dflt; } }

async function upsertUserByEmail(env, email, name) {
  email = String(email || "").trim().toLowerCase();
  if (!email) throw new Error("email required");
  let u = await env.DB.prepare("SELECT id,email,name,created_at FROM users WHERE email=?").bind(email).first();
  if (u) return u;
  const id = uuid();
  const created = nowIso();
  await env.DB.prepare("INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)")
    .bind(id, email, name || null, created).run();
  return { id, email, name: name || null, created_at: created };
}

/* ── embeddings (Vectorize) — best-effort, never blocks the write ──────────── */
async function indexIdea(env, ctx, idea) {
  if (!env.AI || !env.IDEAS_VEC) return;
  const text = [idea.title, idea.body].filter(Boolean).join("\n").slice(0, 2000);
  if (!text) return;
  const work = (async () => {
    try {
      const r = await env.AI.run(env.EMBED_MODEL || "@cf/baai/bge-base-en-v1.5", { text: [text] });
      const vec = r.data?.[0];
      if (!vec) return;
      await env.IDEAS_VEC.upsert([{ id: idea.id, values: vec, metadata: { user_id: idea.user_id, title: idea.title } }]);
    } catch (_) {}
  })();
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
}
async function deindexIdea(env, ctx, id) {
  if (!env.IDEAS_VEC) return;
  const work = env.IDEAS_VEC.deleteByIds([id]).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
}

/* ── router ────────────────────────────────────────────────────────────────── */
export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const send = (obj, status = 200, extra = {}) => json(obj, status, { ...cors, ...extra });

    try {
      // ── health ──
      if (path === "/" || path === "/api" || path === "/api/health")
        return send({ ok: true, service: "idea-receipt-api" });

      // ── AUTH ──────────────────────────────────────────────────────────────
      // POST /api/auth/start  { provider?, email? } → { redirect } (OAuth) or { sent:true } (magic)
      if (path === "/api/auth/start" && req.method === "POST")
        return authStart(req, env, send);

      // GET /api/auth/callback?code&state  (OAuth)  OR  ?token (magic-link)
      if (path === "/api/auth/callback" && req.method === "GET")
        return authCallback(req, env, ctx, cors);

      // POST /api/auth/signout
      if (path === "/api/auth/signout" && req.method === "POST") {
        const token = cookieFromReq(req);
        if (token) { await env.SESSIONS.delete(token); ctx.waitUntil(env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(token).run().catch(() => {})); }
        return send({ ok: true }, 200, { "Set-Cookie": clearCookie() });
      }

      // GET /api/me
      if (path === "/api/me" && req.method === "GET") {
        const u = await userFromReq(req, env);
        if (!u) return send({ error: "unauthorized" }, 401);
        return send({ id: u.id, email: u.email, name: u.name, created_at: u.created_at });
      }

      // ── NOTION IMPORT (bearer-auth, not cookie) ─────────────────────────────
      // POST /api/import/notion  Authorization: Bearer <NOTION_IMPORT_TOKEN>
      if (path === "/api/import/notion" && req.method === "POST")
        return importNotion(req, env, ctx, send);

      // ── everything below requires a session ────────────────────────────────
      const user = await userFromReq(req, env);
      if (!user) return send({ error: "unauthorized" }, 401);
      const uid = user.id;

      // ── IDEAS ───────────────────────────────────────────────────────────────
      if (path === "/api/ideas" && req.method === "GET")  return listIdeas(req, env, uid, url, send);
      if (path === "/api/ideas" && req.method === "POST") return createIdea(req, env, ctx, uid, send);
      let m;
      if ((m = path.match(/^\/api\/ideas\/([^/]+)$/))) {
        if (req.method === "PATCH")  return patchIdea(req, env, ctx, uid, m[1], send);
        if (req.method === "DELETE") return deleteIdea(req, env, ctx, uid, m[1], send);
      }

      // ── LISTS ────────────────────────────────────────────────────────────────
      if (path === "/api/lists" && req.method === "GET")  return listLists(env, uid, send);
      if (path === "/api/lists" && req.method === "POST") return createList(req, env, uid, send);
      if ((m = path.match(/^\/api\/lists\/([^/]+)$/))) {
        if (req.method === "PATCH")  return patchList(req, env, uid, m[1], send);
        if (req.method === "DELETE") return deleteList(env, uid, m[1], send);
      }

      // ── STATE (device-synced settings + cross-off/billed-to) ────────────────
      if (path === "/api/state" && req.method === "GET")   return getState(env, uid, send);
      if (path === "/api/state" && req.method === "PATCH") return patchState(req, env, uid, send);

      return send({ error: "not_found", path }, 404);
    } catch (err) {
      return send({ error: "internal", message: String(err && err.message || err) }, 500);
    }
  },
};

/* ════════════════════════ AUTH ════════════════════════════════════════════ */
async function authStart(req, env, send) {
  const body = await readJson(req);
  const provider = body.provider || env.OAUTH_PROVIDER || "google";

  if (provider === "magic") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return send({ error: "valid_email_required" }, 400);
    const token = await signMagic(env, email);
    const link = `${apiBase(env)}${env.OAUTH_REDIRECT_PATH || "/api/auth/callback"}?token=${encodeURIComponent(token)}`;
    // Delivery is the email workstream's job; we return the link in dev so it's testable.
    // In production, enqueue an email here and return { sent:true } only.
    return send({ sent: true, dev_link: link });
  }

  // Google OAuth (default). Provider-agnostic: swap the endpoints/scope to change IdP.
  if (provider === "google") {
    const state = uuid();
    const redirect = `${apiBase(env)}${env.OAUTH_REDIRECT_PATH || "/api/auth/callback"}`;
    const p = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID || "",
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid email profile",
      access_type: "online",
      state,
      prompt: "select_account",
    });
    // state is short-lived; stash in KV so the callback can verify it.
    await env.SESSIONS.put("oauth_state:" + state, "1", { expirationTtl: 600 });
    return send({ redirect: "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString() });
  }

  return send({ error: "unknown_provider", provider }, 400);
}

async function authCallback(req, env, ctx, cors) {
  const url = new URL(req.url);
  const back = (token) =>
    new Response(null, { status: 302, headers: { ...cors, Location: env.APP_ORIGIN || "/", "Set-Cookie": setCookie(token, env) } });

  // magic-link path
  const magic = url.searchParams.get("token");
  if (magic) {
    const email = await verifyMagic(env, magic);
    if (!email) return json({ error: "invalid_or_expired" }, 400, cors);
    const u = await upsertUserByEmail(env, email);
    await linkIdentity(env, u.id, "magic", email);
    const token = await createSession(env, u.id, req.headers.get("User-Agent"));
    return back(token);
  }

  // OAuth (Google) path
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return json({ error: "missing_code" }, 400, cors);
  const ok = await env.SESSIONS.get("oauth_state:" + state);
  if (!ok) return json({ error: "bad_state" }, 400, cors);
  await env.SESSIONS.delete("oauth_state:" + state);

  const redirect = `${apiBase(env)}${env.OAUTH_REDIRECT_PATH || "/api/auth/callback"}`;
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID || "",
      client_secret: env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }),
  });
  if (!tokRes.ok) return json({ error: "token_exchange_failed", detail: await tokRes.text() }, 400, cors);
  const tok = await tokRes.json();
  const profile = await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: "Bearer " + tok.access_token },
  })).json();
  const email = String(profile.email || "").toLowerCase();
  if (!email) return json({ error: "no_email" }, 400, cors);

  const u = await upsertUserByEmail(env, email, profile.name);
  await linkIdentity(env, u.id, "google", profile.sub || email);
  const token = await createSession(env, u.id, req.headers.get("User-Agent"));
  return back(token);
}

async function linkIdentity(env, userId, provider, subject) {
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO auth_identities (id,user_id,provider,subject,created_at) VALUES (?,?,?,?,?)"
    ).bind(uuid(), userId, provider, String(subject), nowIso()).run();
  } catch (_) {}
}

// Magic-link token = base64url(payload).hmac, payload = {e:email, x:expiryMs}
async function signMagic(env, email) {
  const payload = btoa(JSON.stringify({ e: email, x: Date.now() + 30 * 60e3 })).replace(/=+$/, "");
  const sig = await hmac(env, payload);
  return payload + "." + sig;
}
async function verifyMagic(env, token) {
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  if ((await hmac(env, payload)) !== sig) return null;
  let p; try { p = JSON.parse(atob(payload)); } catch { return null; }
  if (!p.e || !p.x || Date.now() > p.x) return null;
  return p.e;
}
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.MAGIC_LINK_SECRET || "dev-insecure-magic-secret"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function apiBase(env) {
  // Where this Worker is reachable. Prefer an explicit var; the callback uses it to
  // build the OAuth redirect_uri, which MUST match the registered redirect exactly.
  return env.API_ORIGIN || "https://idea-receipt-api.workers.dev";
}

/* ════════════════════════ IDEAS ════════════════════════════════════════════ */
async function listIdeas(req, env, uid, url, send) {
  const status = url.searchParams.get("status");           // active|done|archived
  const listId = url.searchParams.get("list_id");
  const since = url.searchParams.get("since");             // ISO — for offline delta sync
  const includeDeleted = url.searchParams.get("include_deleted") === "1" || !!since;
  const cond = ["user_id=?"], args = [uid];
  if (!includeDeleted) cond.push("deleted_at IS NULL");
  if (status) { cond.push("status=?"); args.push(status); }
  if (listId) { cond.push("list_id=?"); args.push(listId); }
  if (since)  { cond.push("updated_at>?"); args.push(since); }
  const rows = await env.DB.prepare(
    `SELECT * FROM ideas WHERE ${cond.join(" AND ")} ORDER BY priority DESC, created_at DESC`
  ).bind(...args).all();
  return send({ ideas: (rows.results || []).map(ideaOut), server_time: nowIso() });
}

async function createIdea(req, env, ctx, uid, send) {
  const b = await readJson(req);
  if (!b.title || !String(b.title).trim()) return send({ error: "title_required" }, 400);
  const id = b.id || uuid();                      // client may mint id offline
  const ts = nowIso();
  const idea = {
    id, user_id: uid, list_id: b.list_id || null, title: String(b.title).trim(),
    body: b.body || "", tags: tagsToJson(b.tags), status: b.status || "active",
    priority: Number.isFinite(b.priority) ? b.priority : 0, due_at: b.due_at || null,
    source: b.source === "notion" ? "notion" : "manual", notion_block_id: b.notion_block_id || null,
    created_at: b.created_at || ts, updated_at: ts, deleted_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO ideas (id,user_id,list_id,title,body,tags,status,priority,due_at,source,notion_block_id,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(id) DO UPDATE SET
       list_id=excluded.list_id, title=excluded.title, body=excluded.body, tags=excluded.tags,
       status=excluded.status, priority=excluded.priority, due_at=excluded.due_at,
       updated_at=excluded.updated_at, deleted_at=NULL
     WHERE ideas.user_id=excluded.user_id AND ideas.updated_at < excluded.updated_at`
  ).bind(idea.id, idea.user_id, idea.list_id, idea.title, idea.body, idea.tags, idea.status,
         idea.priority, idea.due_at, idea.source, idea.notion_block_id, idea.created_at, idea.updated_at).run();
  await indexIdea(env, ctx, idea);
  const row = await env.DB.prepare("SELECT * FROM ideas WHERE id=? AND user_id=?").bind(id, uid).first();
  return send({ idea: ideaOut(row) }, 201);
}

async function patchIdea(req, env, ctx, uid, id, send) {
  const cur = await env.DB.prepare("SELECT * FROM ideas WHERE id=? AND user_id=?").bind(id, uid).first();
  if (!cur) return send({ error: "not_found" }, 404);
  const b = await readJson(req);
  // last-write-wins guard: client may send updated_at it last saw; reject stale writes
  if (b.updated_at && b.updated_at < cur.updated_at)
    return send({ error: "stale", current: ideaOut(cur) }, 409);
  const sets = [], args = [];
  const setIf = (key, col, tx) => { if (key in b) { sets.push(`${col}=?`); args.push(tx ? tx(b[key]) : b[key]); } };
  setIf("list_id", "list_id");
  setIf("title", "title", (v) => String(v).trim());
  setIf("body", "body");
  setIf("tags", "tags", tagsToJson);
  setIf("status", "status");
  setIf("priority", "priority");
  setIf("due_at", "due_at");
  const ts = nowIso();
  sets.push("updated_at=?"); args.push(ts);
  args.push(id, uid);
  await env.DB.prepare(`UPDATE ideas SET ${sets.join(",")} WHERE id=? AND user_id=?`).bind(...args).run();
  const row = await env.DB.prepare("SELECT * FROM ideas WHERE id=? AND user_id=?").bind(id, uid).first();
  await indexIdea(env, ctx, { ...row, user_id: uid });
  return send({ idea: ideaOut(row) });
}

async function deleteIdea(req, env, ctx, uid, id, send) {
  const ts = nowIso();
  const r = await env.DB.prepare(
    "UPDATE ideas SET deleted_at=?, updated_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL"
  ).bind(ts, ts, id, uid).run();
  await deindexIdea(env, ctx, id);
  return send({ ok: true, deleted: (r.meta?.changes || 0) > 0, deleted_at: ts });
}

/* ════════════════════════ LISTS ════════════════════════════════════════════ */
async function listLists(env, uid, send) {
  const rows = await env.DB.prepare(
    "SELECT * FROM lists WHERE user_id=? AND deleted_at IS NULL ORDER BY position ASC, created_at ASC"
  ).bind(uid).all();
  return send({ lists: rows.results || [] });
}
async function createList(req, env, uid, send) {
  const b = await readJson(req);
  if (!b.title || !String(b.title).trim()) return send({ error: "title_required" }, 400);
  const id = b.id || uuid();
  const ts = nowIso();
  await env.DB.prepare(
    "INSERT INTO lists (id,user_id,title,position,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
  ).bind(id, uid, String(b.title).trim(), Number.isFinite(b.position) ? b.position : 0, ts, ts).run();
  const row = await env.DB.prepare("SELECT * FROM lists WHERE id=? AND user_id=?").bind(id, uid).first();
  return send({ list: row }, 201);
}
async function patchList(req, env, uid, id, send) {
  const cur = await env.DB.prepare("SELECT * FROM lists WHERE id=? AND user_id=?").bind(id, uid).first();
  if (!cur) return send({ error: "not_found" }, 404);
  const b = await readJson(req);
  const sets = [], args = [];
  if ("title" in b) { sets.push("title=?"); args.push(String(b.title).trim()); }
  if ("position" in b) { sets.push("position=?"); args.push(b.position); }
  if (!sets.length) return send({ list: cur });
  sets.push("updated_at=?"); args.push(nowIso());
  args.push(id, uid);
  await env.DB.prepare(`UPDATE lists SET ${sets.join(",")} WHERE id=? AND user_id=?`).bind(...args).run();
  const row = await env.DB.prepare("SELECT * FROM lists WHERE id=? AND user_id=?").bind(id, uid).first();
  return send({ list: row });
}
async function deleteList(env, uid, id, send) {
  const ts = nowIso();
  // soft-delete the list; orphan its ideas (list_id → NULL handled by FK ON DELETE SET NULL
  // only on hard delete, so do it explicitly for the soft case)
  await env.DB.prepare("UPDATE lists SET deleted_at=?, updated_at=? WHERE id=? AND user_id=?").bind(ts, ts, id, uid).run();
  await env.DB.prepare("UPDATE ideas SET list_id=NULL, updated_at=? WHERE list_id=? AND user_id=?").bind(ts, id, uid).run();
  return send({ ok: true, deleted_at: ts });
}

/* ════════════════════════ STATE ════════════════════════════════════════════ */
async function getState(env, uid, send) {
  const row = await env.DB.prepare("SELECT data,updated_at FROM user_state WHERE user_id=?").bind(uid).first();
  if (!row) return send({ data: {}, updated_at: null });
  return send({ data: safeJson(row.data, {}), updated_at: row.updated_at });
}
async function patchState(req, env, uid, send) {
  const b = await readJson(req);
  const incoming = (b && typeof b.data === "object" && b.data) ? b.data : (typeof b === "object" ? b : {});
  const ts = nowIso();
  const cur = await env.DB.prepare("SELECT data,updated_at FROM user_state WHERE user_id=?").bind(uid).first();
  // shallow-merge so partial state patches (e.g. just billedTo) don't clobber settings.
  const merged = Object.assign({}, cur ? safeJson(cur.data, {}) : {}, incoming);
  await env.DB.prepare(
    "INSERT INTO user_state (user_id,data,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at"
  ).bind(uid, JSON.stringify(merged), ts).run();
  return send({ data: merged, updated_at: ts });
}

/* ════════════════════════ NOTION IMPORT ════════════════════════════════════ */
// The existing sync_notion.py POSTs here instead of writing data.json. Body:
//   { email: "owner@…", list: { title, notion_page_id }, items: [ {title, details[], tags[], notion_block_id, added} ] }
// Auth: Authorization: Bearer <NOTION_IMPORT_TOKEN>. Idempotent on (user, notion_block_id):
// existing notion-sourced ideas are updated in place; ideas removed from Notion are
// soft-deleted (only those with source='notion').
async function importNotion(req, env, ctx, send) {
  const auth = req.headers.get("Authorization") || "";
  const tok = auth.replace(/^Bearer\s+/i, "");
  if (!env.NOTION_IMPORT_TOKEN || tok !== env.NOTION_IMPORT_TOKEN)
    return send({ error: "unauthorized" }, 401);

  const b = await readJson(req);
  const email = String(b.email || "").trim().toLowerCase();
  if (!email) return send({ error: "email_required" }, 400);
  const items = Array.isArray(b.items) ? b.items : [];
  const user = await upsertUserByEmail(env, email);
  const uid = user.id;
  const ts = nowIso();

  // resolve/create the target list (keyed by notion_page_id stashed in title is brittle;
  // we match on title and create if missing — listing stays simple for the importer).
  let listId = null;
  if (b.list && b.list.title) {
    const found = await env.DB.prepare("SELECT id FROM lists WHERE user_id=? AND title=? AND deleted_at IS NULL")
      .bind(uid, b.list.title).first();
    if (found) listId = found.id;
    else {
      listId = uuid();
      await env.DB.prepare("INSERT INTO lists (id,user_id,title,position,created_at,updated_at) VALUES (?,?,?,0,?,?)")
        .bind(listId, uid, b.list.title, ts, ts).run();
    }
  }

  const seen = [];
  for (const it of items) {
    const title = String(it.title || "").trim();
    if (!title) continue;
    const blockId = it.notion_block_id || it.id || null;
    const body = Array.isArray(it.details) ? it.details.join("\n") : (it.body || "");
    const tags = tagsToJson(it.tags);
    const created = it.added || ts;
    // upsert keyed by (user, notion_block_id) when present, else by (user, title, source)
    let existing = null;
    if (blockId)
      existing = await env.DB.prepare("SELECT id FROM ideas WHERE user_id=? AND notion_block_id=?").bind(uid, blockId).first();
    if (!existing)
      existing = await env.DB.prepare("SELECT id FROM ideas WHERE user_id=? AND title=? AND source='notion'").bind(uid, title).first();
    let id;
    if (existing) {
      id = existing.id;
      await env.DB.prepare(
        "UPDATE ideas SET title=?,body=?,tags=?,list_id=?,deleted_at=NULL,updated_at=? WHERE id=? AND user_id=?"
      ).bind(title, body, tags, listId, ts, id, uid).run();
    } else {
      id = uuid();
      await env.DB.prepare(
        `INSERT INTO ideas (id,user_id,list_id,title,body,tags,status,priority,source,notion_block_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?, 'active',0,'notion',?,?,?)`
      ).bind(id, uid, listId, title, body, tags, blockId, created, ts).run();
    }
    seen.push(id);
    await indexIdea(env, ctx, { id, user_id: uid, title, body });
  }

  // soft-delete notion ideas that disappeared from the page (scoped to this list if given)
  let pruned = 0;
  if (b.prune !== false) {
    const placeholders = seen.map(() => "?").join(",") || "''";
    const where = listId
      ? `user_id=? AND source='notion' AND list_id=? AND deleted_at IS NULL AND id NOT IN (${placeholders})`
      : `user_id=? AND source='notion' AND deleted_at IS NULL AND id NOT IN (${placeholders})`;
    const args = listId ? [uid, listId, ...seen] : [uid, ...seen];
    const r = await env.DB.prepare(`UPDATE ideas SET deleted_at=?, updated_at=? WHERE ${where}`)
      .bind(ts, ts, ...args).run();
    pruned = r.meta?.changes || 0;
  }

  return send({ ok: true, imported: seen.length, pruned, user_id: uid, list_id: listId });
}
