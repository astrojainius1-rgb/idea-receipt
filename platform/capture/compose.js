/* compose.js — add/edit composer logic for an idea (DOM-agnostic core).
 *
 * This is the model layer behind the in-app composer (#4). It validates and
 * normalises a draft into the SPINE idea shape, builds an optimistic local idea
 * for immediate render, and hands writes to the offline queue (queue.js). It
 * deliberately holds NO DOM references so it can be unit-tested and reused from
 * a quick-add bar, the share-target page, or voice capture.
 *
 * SPINE idea fields: id, user_id, list_id, title, body, tags[],
 *   status['active'|'done'|'archived'], priority, due_at, source['manual'|'notion'],
 *   notion_block_id, timestamps.
 *
 * The existing receipt renderer (app.js) speaks a lighter shape:
 *   { title, details[], tags[], added, id?, pending? }
 * `toReceiptItem()` adapts a SPINE idea to that shape so an optimistic idea can
 * be dropped straight into the rendered list (details = body split into lines).
 */

import { queueCreate, queueUpdate, queueDelete } from "./queue.js";

export const PRIORITIES = ["low", "normal", "high"];

/** Parse "#tag inline #tags" out of free text; returns {text, tags[]}. */
export function extractTags(text) {
  const tags = [];
  const stripped = String(text || "").replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_m, pre, tag) => {
    tags.push(tag.toLowerCase());
    return pre; // remove the #tag token from the body text
  });
  return { text: stripped.replace(/\s{2,}/g, " ").trim(), tags: dedupe(tags) };
}

function dedupe(arr) { return [...new Set(arr.filter(Boolean))]; }

/** Normalise a raw draft (from any capture surface) into a SPINE-ready object. */
export function normalizeDraft(draft = {}) {
  let title = String(draft.title || "").trim();
  let body = String(draft.body || "").trim();
  let tags = Array.isArray(draft.tags) ? draft.tags.map((t) => String(t).replace(/^#/, "").toLowerCase()) : [];

  // If no explicit title, derive one from the first line of the body.
  if (!title && body) {
    const [first, ...rest] = body.split(/\n/);
    title = first.trim();
    body = rest.join("\n").trim();
  }
  // Pull inline #tags from both fields.
  const fromTitle = extractTags(title); title = fromTitle.text;
  const fromBody = extractTags(body); body = fromBody.text;
  tags = dedupe([...tags, ...fromTitle.tags, ...fromBody.tags]);

  const out = {
    title,
    body,
    tags,
    list_id: draft.list_id || null,
    priority: PRIORITIES.includes(draft.priority) ? draft.priority : "normal",
    due_at: normalizeDue(draft.due_at),
    source: draft.source || "manual",
  };
  if (draft.id) out.id = draft.id;
  if (draft.client_id) out.client_id = draft.client_id;
  return out;
}

function normalizeDue(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
}

/** Validate a normalised draft. Returns {ok, errors[]}. */
export function validateDraft(d) {
  const errors = [];
  if (!d.title || d.title.length < 1) errors.push("Give the idea a title.");
  if (d.title && d.title.length > 200) errors.push("Title is too long (200 char max).");
  if (d.due_at === undefined) errors.push("Due date is invalid.");
  return { ok: errors.length === 0, errors };
}

/** Adapt a SPINE idea (or optimistic draft) to the receipt renderer's item shape. */
export function toReceiptItem(idea) {
  return {
    id: idea.id || idea.client_id || undefined,
    title: idea.title,
    details: idea.body ? String(idea.body).split(/\n+/).map((s) => s.trim()).filter(Boolean) : [],
    tags: Array.isArray(idea.tags) ? idea.tags : [],
    added: idea.created_at || new Date().toISOString(),
    pending: true, // optimistic until the queue reconciles it
  };
}

/**
 * Create an idea. Returns {idea, optimistic} where:
 *   - optimistic is a receipt-item you can render immediately,
 *   - idea is the normalised SPINE payload that was queued.
 * The actual network write is handled by the queue (offline-safe).
 */
export async function createIdea(rawDraft) {
  const draft = normalizeDraft(rawDraft);
  const v = validateDraft(draft);
  if (!v.ok) { const e = new Error(v.errors.join(" ")); e.validation = v.errors; throw e; }
  const op = await queueCreate(draft);
  const optimistic = toReceiptItem({ ...draft, client_id: op.client_id });
  return { idea: draft, optimistic, client_id: op.client_id, op };
}

/** Edit an existing idea by server id or client id. `changes` is a partial draft. */
export async function editIdea(idOrClient, changes) {
  // Only send the fields that are present, but normalise them consistently.
  const partial = {};
  const norm = normalizeDraft({ title: "x", ...changes }); // title placeholder so validation of others is skippable
  for (const k of ["title", "body", "tags", "list_id", "priority", "due_at"]) {
    if (k in changes) partial[k] = norm[k];
  }
  return queueUpdate(idOrClient, partial);
}

/** Mark done/active/archived — a thin status edit (mirrors app.js cross-off). */
export function setStatus(idOrClient, status) {
  if (!["active", "done", "archived"].includes(status)) throw new Error("bad status");
  return queueUpdate(idOrClient, { status });
}

/** Delete an idea. */
export function deleteIdea(idOrClient) {
  return queueDelete(idOrClient);
}
