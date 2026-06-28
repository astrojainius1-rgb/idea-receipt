/* filters.js — DOM-agnostic filter + sort predicates over the idea model.
 *
 * The "idea model" here is the SPINE shape (D1 `ideas` row, see
 * platform/backend/schema.sql), normalised to a plain object:
 *
 *   {
 *     id:        string,
 *     list_id:   string | null,
 *     title:     string,
 *     body:      string,            // free text (old `details` joined with "\n")
 *     tags:      string[],
 *     status:    'active' | 'done' | 'archived',
 *     priority:  number,            // 0 = none; higher = more urgent
 *     due_at:    string | null,     // ISO-8601 UTC
 *     created_at:string,            // ISO-8601 UTC
 *     updated_at:string,            // ISO-8601 UTC
 *   }
 *
 * The legacy receipt model (data.json: { title, details[], tags[], added })
 * can be lifted into this shape with `fromLegacy()` so the existing render path
 * and the new filters share one vocabulary.
 *
 * Everything here is pure: no DOM, no localStorage, no fetch. The PWA wires the
 * predicates into `render()`/`sortItems()`; the worker can reuse the same query
 * vocabulary for `GET /api/ideas`.
 */

export const STATUSES = ['active', 'done', 'archived'];

/* ---- normalisation ------------------------------------------------------- */

// Lift a legacy receipt item ({title, details[], tags[], added}) into the
// SPINE idea shape so old data flows through the new predicates unchanged.
export function fromLegacy(it, i = 0) {
  const details = Array.isArray(it.details) ? it.details : [];
  return {
    id: it.id || ('legacy-' + i),
    list_id: it.list_id ?? null,
    title: String(it.title || 'Untitled idea').trim(),
    body: details.join('\n'),
    tags: Array.isArray(it.tags) ? it.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    status: it.status || (it.done ? 'done' : 'active'),
    priority: Number(it.priority) || 0,
    due_at: it.due_at ?? null,
    created_at: it.created_at || it.added || null,
    updated_at: it.updated_at || it.added || null,
    _legacy: it, // keep the original around for the renderer
  };
}

/* ---- filter spec --------------------------------------------------------- */

// A FilterSpec is a plain serialisable object — it maps 1:1 onto the query
// params the backend accepts on GET /api/ideas, so the same object filters
// locally (instant) and can be sent to the server for the full set.
//
//   {
//     q:        string,            // free-text (handled by search.js, not here)
//     status:   string|string[],  // one or many of STATUSES; default ['active','done']
//     list_id:  string|null|'*',   // '*' or undefined = any; null = inbox (no list)
//     tags:     string[],          // AND semantics (idea must have ALL)
//     tagsAny:  string[],          // OR semantics (idea must have ANY)
//     priority: { min?:number, max?:number },
//     due:      'overdue'|'today'|'week'|'none'|'any',
//     sort:     'default'|'new'|'old'|'priority'|'due'|'az'|'za'|'price',
//   }

export const DEFAULT_FILTER = Object.freeze({
  status: ['active', 'done'], // archived hidden unless explicitly asked
  list_id: '*',
  tags: [],
  tagsAny: [],
  priority: {},
  due: 'any',
  sort: 'default',
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function dueBucket(due_at, now) {
  if (!due_at) return 'none';
  const t = Date.parse(due_at);
  if (isNaN(t)) return 'none';
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = startOfDay.getTime() + 864e5;
  const endOfWeek = startOfDay.getTime() + 7 * 864e5;
  if (t < startOfDay.getTime()) return 'overdue';
  if (t < endOfDay) return 'today';
  if (t < endOfWeek) return 'week';
  return 'future';
}

/* ---- predicates ---------------------------------------------------------- */

// Build a single predicate fn(idea) -> boolean from a FilterSpec.
// `now` is injectable so due-date buckets are testable/deterministic.
export function makePredicate(spec = {}, now = Date.now()) {
  const f = { ...DEFAULT_FILTER, ...spec };
  const statuses = asArray(f.status);
  const tagsAll = asArray(f.tags);
  const tagsAny = asArray(f.tagsAny);
  const pmin = f.priority && f.priority.min != null ? f.priority.min : -Infinity;
  const pmax = f.priority && f.priority.max != null ? f.priority.max : Infinity;

  return function predicate(idea) {
    if (statuses.length && !statuses.includes(idea.status)) return false;

    if (f.list_id !== '*' && f.list_id !== undefined) {
      // null = the "inbox" (ideas with no list); any other value = exact match
      if (f.list_id === null) { if (idea.list_id != null) return false; }
      else if (idea.list_id !== f.list_id) return false;
    }

    if (tagsAll.length) {
      const have = new Set(idea.tags || []);
      if (!tagsAll.every((t) => have.has(t))) return false;
    }
    if (tagsAny.length) {
      const have = new Set(idea.tags || []);
      if (!tagsAny.some((t) => have.has(t))) return false;
    }

    const p = Number(idea.priority) || 0;
    if (p < pmin || p > pmax) return false;

    if (f.due && f.due !== 'any') {
      const b = dueBucket(idea.due_at, now);
      if (f.due === 'overdue' && b !== 'overdue') return false;
      else if (f.due === 'today' && b !== 'today' && b !== 'overdue') return false;
      else if (f.due === 'week' && (b === 'none' || b === 'future')) return false;
      else if (f.due === 'none' && b !== 'none') return false;
    }
    return true;
  };
}

export function applyFilter(ideas, spec, now = Date.now()) {
  return ideas.filter(makePredicate(spec, now));
}

/* ---- sorting ------------------------------------------------------------- */

// Stable-ish comparators keyed by sort name. `priceOf` lets the receipt inject
// its own market-price metric (app.js: ideaWords × unitPrice) without this
// module depending on it.
export function makeComparator(sort = 'default', { priceOf } = {}) {
  const t = (x) => Date.parse(x || '') || 0;
  switch (sort) {
    case 'new':      return (a, b) => t(b.created_at) - t(a.created_at);
    case 'old':      return (a, b) => t(a.created_at) - t(b.created_at);
    case 'az':       return (a, b) => String(a.title).localeCompare(String(b.title));
    case 'za':       return (a, b) => String(b.title).localeCompare(String(a.title));
    case 'priority': return (a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)
                                      || t(a.due_at) - t(b.due_at);
    case 'due':      // nulls sort last
      return (a, b) => {
        const da = t(a.due_at) || Infinity, db = t(b.due_at) || Infinity;
        return da - db;
      };
    case 'price':
      if (typeof priceOf === 'function') return (a, b) => priceOf(b) - priceOf(a);
      return () => 0;
    default:         return () => 0; // 'default' = preserve incoming (Notion) order
  }
}

export function sortIdeas(ideas, sort = 'default', opts) {
  // copy + stable sort (Array.sort is stable in modern engines)
  return ideas.slice().sort(makeComparator(sort, opts));
}

// Convenience: filter then sort in one call (what render() would use).
export function organize(ideas, spec = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const filtered = applyFilter(ideas, spec, now);
  return sortIdeas(filtered, (spec.sort || 'default'), opts);
}

/* ---- facets (for building the filter UI from the loaded set) ------------- */

// Distinct values present in the loaded ideas, so the filter bar only offers
// chips that actually match something.
export function facets(ideas) {
  const tags = new Set(), lists = new Set(), statuses = new Set();
  let maxPriority = 0, hasDue = false;
  for (const it of ideas) {
    (it.tags || []).forEach((t) => tags.add(t));
    if (it.list_id != null) lists.add(it.list_id);
    if (it.status) statuses.add(it.status);
    maxPriority = Math.max(maxPriority, Number(it.priority) || 0);
    if (it.due_at) hasDue = true;
  }
  return {
    tags: [...tags].sort(),
    lists: [...lists],
    statuses: [...statuses],
    maxPriority,
    hasDue,
  };
}

/* ---- backend query param mapping ----------------------------------------
 * Serialise a FilterSpec into the GET /api/ideas query string the backend
 * workstream must support. Kept here so client + server agree on the wire
 * format in one place.
 *   status -> repeated ?status=active&status=done   (or omit for default)
 *   list_id -> ?list=<id> | ?list=none
 *   tags -> ?tag=a&tag=b (AND) ; tagsAny -> ?anytag=a&anytag=b
 *   priority -> ?pmin=&pmax=
 *   due -> ?due=overdue|today|week|none
 *   sort -> ?sort=new
 *   q -> ?q=<text>
 */
export function toQueryParams(spec = {}) {
  const p = new URLSearchParams();
  asArray(spec.status).forEach((s) => p.append('status', s));
  if (spec.list_id === null) p.set('list', 'none');
  else if (spec.list_id && spec.list_id !== '*') p.set('list', spec.list_id);
  asArray(spec.tags).forEach((t) => p.append('tag', t));
  asArray(spec.tagsAny).forEach((t) => p.append('anytag', t));
  if (spec.priority && spec.priority.min != null) p.set('pmin', spec.priority.min);
  if (spec.priority && spec.priority.max != null) p.set('pmax', spec.priority.max);
  if (spec.due && spec.due !== 'any') p.set('due', spec.due);
  if (spec.sort && spec.sort !== 'default') p.set('sort', spec.sort);
  if (spec.q) p.set('q', spec.q);
  return p;
}

/* ---- tests-in-comments --------------------------------------------------
 * Run mentally / port to a test runner. `now` fixed to 2026-06-27T12:00Z.
 *
 *   const NOW = Date.parse('2026-06-27T12:00:00Z');
 *   const a = { id:'a', status:'active', priority:2, due_at:'2026-06-26T00:00:00Z', tags:['hw'], list_id:'L1', created_at:'2026-06-01' };
 *   const b = { id:'b', status:'done',   priority:0, due_at:null,                  tags:['sw'], list_id:null, created_at:'2026-06-20' };
 *   const c = { id:'c', status:'archived',priority:5,due_at:'2026-06-27T20:00:00Z',tags:['hw','sw'], list_id:'L1', created_at:'2026-06-25' };
 *
 *   applyFilter([a,b,c], {}, NOW).map(x=>x.id)                    // ['a','b']  (archived hidden by default)
 *   applyFilter([a,b,c], {status:'archived'}, NOW).map(x=>x.id)   // ['c']
 *   applyFilter([a,b,c], {list_id:null}, NOW).map(x=>x.id)        // ['b']      (inbox)
 *   applyFilter([a,b,c], {status:STATUSES, tags:['hw','sw']}, NOW).map(x=>x.id) // ['c']
 *   applyFilter([a,b,c], {status:STATUSES, due:'overdue'}, NOW).map(x=>x.id)    // ['a']
 *   applyFilter([a,b,c], {status:STATUSES, due:'today'}, NOW).map(x=>x.id)      // ['a','c'] (overdue counts as due today)
 *   applyFilter([a,b,c], {status:STATUSES, priority:{min:3}}, NOW).map(x=>x.id) // ['c']
 *
 *   sortIdeas([a,b,c], 'priority').map(x=>x.id)                   // ['c','a','b']
 *   sortIdeas([a,b,c], 'due').map(x=>x.id)                        // ['a','c','b'] (null due last)
 *   sortIdeas([a,b,c], 'new').map(x=>x.id)                        // ['c','b','a']
 *
 *   toQueryParams({status:['active'],tags:['hw'],due:'overdue',sort:'new'}).toString()
 *     // 'status=active&tag=hw&due=overdue&sort=new'
 *   toQueryParams({list_id:null}).toString()                      // 'list=none'
 *
 *   facets([a,b,c]).tags                                          // ['hw','sw']
 *   facets([a,b,c]).maxPriority                                   // 5
 */
