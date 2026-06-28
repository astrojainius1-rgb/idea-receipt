/* queue.js — offline-first write queue for idea-receipt.
 *
 * The PWA is read-only today (renders data.json, polls every 30s). This module
 * adds *writes*: create / edit / delete an idea against the SPINE backend
 * (Cloudflare Worker + D1, REST /api, session-cookie auth). Writes are recorded
 * as immutable *operations* in IndexedDB first, then flushed to the network when
 * online. On reconnect the queue replays in order; the server is the system of
 * record and reconciliation is last-write-wins by `updated_at`.
 *
 * Design goals:
 *   - Zero dependencies, standalone ES module, importable in app.js or a SW.
 *   - Never lose a user write, even across reloads / cold starts (IndexedDB).
 *   - Idempotent replay: each op carries a client-generated op_id; the backend
 *     should treat a repeated op_id as a no-op (at-least-once delivery).
 *   - Optimistic: callers get an immediate local idea (with a temp client id)
 *     and an event stream to reconcile once the server responds.
 *
 * Backend endpoints this module depends on (SHARED SPINE):
 *   POST   /api/ideas        -> create; body {client_id, title, body, tags[],
 *                               list_id, priority, due_at, source}; returns the
 *                               canonical idea {id, ...timestamps}.
 *   PATCH  /api/ideas/:id     -> partial update by server id.
 *   DELETE /api/ideas/:id     -> delete by server id.
 *   GET    /api/lists         -> {lists:[{id,title,...}]} (used elsewhere; the
 *                               queue only needs it indirectly for list_id).
 * Auth: session cookie, so every fetch uses credentials:"include".
 *
 * NOTE ON id MAPPING: an offline-created idea has only a client_id until its
 * POST succeeds. A later edit/delete of that same idea (still offline) is queued
 * against the client_id; at flush time we resolve client_id -> server id from a
 * local map populated by the create's response. Ops blocked on an unresolved
 * client_id are skipped this pass and retried after the create lands.
 */

const DB_NAME = "idea-receipt-capture";
const DB_VERSION = 1;
const STORE_OPS = "ops";       // queued write operations (pending sync)
const STORE_MAP = "idmap";     // client_id -> server id, once known

const API_BASE = "/api";

/* ---- tiny IndexedDB promise wrapper -------------------------------------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_OPS)) {
        const s = db.createObjectStore(STORE_OPS, { keyPath: "op_id" });
        s.createIndex("seq", "seq", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_MAP)) {
        db.createObjectStore(STORE_MAP, { keyPath: "client_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqP(idbRequest) {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

/* ---- ids ----------------------------------------------------------------- */
function uid(prefix) {
  const r = (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
  return prefix ? prefix + "_" + r : r;
}

/* ---- event emitter so the UI can react to flush results ------------------ */
const listeners = new Set();
export function onQueueEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type, detail) { listeners.forEach((fn) => { try { fn({ type, ...detail }); } catch (e) {} }); }

/* ---- public API ---------------------------------------------------------- */

/**
 * Enqueue a write. `kind` is "create" | "update" | "delete".
 *   create: payload = {client_id?, title, body, tags, list_id, priority, due_at}
 *   update: payload = {id?|client_id?, ...changed fields}
 *   delete: payload = {id?|client_id?}
 * Returns the stored op (incl. its op_id and, for creates, the client_id).
 */
export async function enqueue(kind, payload) {
  const db = await openDB();
  const client_id = payload.client_id || (kind === "create" ? uid("c") : payload.client_id);
  const op = {
    op_id: uid("op"),
    seq: Date.now(),               // monotonic-ish ordering key
    kind,
    client_id: client_id || null,  // present for create + any op on a not-yet-synced idea
    server_id: payload.id || null, // present when we already know the server id
    payload,
    tries: 0,
    queued_at: new Date().toISOString(),
  };
  await tx(db, STORE_OPS, "readwrite", (s) => reqP(s.put(op)));
  emit("queued", { op });
  // fire-and-forget flush; harmless if offline (it will no-op and retry later)
  flush().catch(() => {});
  return op;
}

/** Convenience wrappers mirroring the composer's intent. */
export const queueCreate = (idea) => enqueue("create", idea);
export const queueUpdate = (idOrClient, changes) =>
  enqueue("update", { ...changes, ...(idOrClient.startsWith("c_") || idOrClient.startsWith("c")
    ? { client_id: idOrClient } : { id: idOrClient }) });
export const queueDelete = (idOrClient) =>
  enqueue("delete", idOrClient.startsWith("c") ? { client_id: idOrClient } : { id: idOrClient });

/** How many writes are still pending (for a "n unsynced" badge). */
export async function pendingCount() {
  const db = await openDB();
  return tx(db, STORE_OPS, "readonly", (s) => reqP(s.count()));
}

/** All pending ops, ordered, for inspection / optimistic merge. */
export async function pendingOps() {
  const db = await openDB();
  const all = await tx(db, STORE_OPS, "readonly", (s) => reqP(s.getAll()));
  return all.sort((a, b) => a.seq - b.seq);
}

async function getServerId(db, client_id) {
  if (!client_id) return null;
  const row = await tx(db, STORE_MAP, "readonly", (s) => reqP(s.get(client_id)));
  return row ? row.server_id : null;
}
async function setServerId(db, client_id, server_id) {
  await tx(db, STORE_MAP, "readwrite", (s) => reqP(s.put({ client_id, server_id })));
}
async function removeOp(db, op_id) {
  await tx(db, STORE_OPS, "readwrite", (s) => reqP(s.delete(op_id)));
}
async function bumpTries(db, op) {
  op.tries += 1;
  op.last_error = op.last_error || null;
  await tx(db, STORE_OPS, "readwrite", (s) => reqP(s.put(op)));
}

/* ---- network ------------------------------------------------------------- */
async function api(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    credentials: "include",                 // session-cookie auth
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { const e = new Error("unauthorized"); e.auth = true; throw e; }
  if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
  return res.status === 204 ? null : res.json();
}

let flushing = false;

/**
 * Replay all queued ops against the backend, in order. Safe to call often
 * (debounced by the `flushing` guard). Resolves when the queue is drained or a
 * pass stalls (offline / auth / server-id not yet known).
 *
 * Reconciliation: a create returns the canonical idea; we record client_id ->
 * server.id so later ops resolve, and emit "reconciled" so the UI can swap the
 * optimistic temp row for the server's. Last-write-wins is enforced server-side
 * by comparing updated_at; the client simply replays its intent.
 */
export async function flush() {
  if (flushing) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  flushing = true;
  try {
    const db = await openDB();
    const ops = (await tx(db, STORE_OPS, "readonly", (s) => reqP(s.getAll())))
      .sort((a, b) => a.seq - b.seq);

    for (const op of ops) {
      try {
        if (op.kind === "create") {
          const idea = await api("POST", "/ideas", {
            client_id: op.client_id,
            source: "manual",
            ...op.payload,
          });
          if (op.client_id && idea && idea.id) await setServerId(db, op.client_id, idea.id);
          await removeOp(db, op.op_id);
          emit("reconciled", { op, idea, client_id: op.client_id });
        } else {
          // update / delete need a server id; resolve from op or the id map.
          let id = op.server_id || (await getServerId(db, op.client_id));
          if (!id) {
            // its create hasn't landed yet — leave it queued, retry next pass.
            continue;
          }
          if (op.kind === "update") {
            const idea = await api("PATCH", "/ideas/" + id, op.payload);
            await removeOp(db, op.op_id);
            emit("reconciled", { op, idea });
          } else if (op.kind === "delete") {
            await api("DELETE", "/ideas/" + id);
            await removeOp(db, op.op_id);
            emit("reconciled", { op, deleted: id });
          }
        }
      } catch (err) {
        if (err.auth) { emit("auth-required", { op }); break; }       // stop; need login
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 409 && err.status !== 429) {
          // permanent client error (e.g. 404 on a delete of an already-gone idea):
          // drop the op so it doesn't wedge the queue, and report it.
          await removeOp(db, op.op_id);
          emit("dropped", { op, error: String(err) });
          continue;
        }
        // transient (offline / 5xx / 429 / 409 conflict): keep it, count the try, stop the pass.
        op.last_error = String(err);
        await bumpTries(db, op);
        emit("retry-later", { op, error: String(err) });
        break;
      }
    }
    emit("drained", { remaining: await pendingCount() });
  } finally {
    flushing = false;
  }
}

/* ---- auto-flush triggers -------------------------------------------------- */
/** Wire the queue to flush when connectivity / focus returns. Call once. */
export function installAutoFlush() {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => flush().catch(() => {}));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flush().catch(() => {});
  });
  // opportunistic kick on load
  flush().catch(() => {});
}
