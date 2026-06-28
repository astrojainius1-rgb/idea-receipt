/* search.js — client-side instant text search over loaded ideas.
 *
 * Two layers, mirroring the SPINE split:
 *   1. THIS module — an in-memory substring + fuzzy-subsequence index over the
 *      ideas already loaded in the PWA. Zero-latency, works offline, used for
 *      the instant filter-as-you-type box.
 *   2. The backend — for the *full* set (ideas not currently loaded) the client
 *      falls back to `GET /api/ideas?q=` (lexical) and `POST /api/search`
 *      (semantic, owned by the AI workstream). See `remoteSearch` doc below.
 *
 * Pure logic: no DOM, no fetch. The PWA owns debouncing + when to escalate to
 * the server. Operates on the normalised idea shape from filters.js
 * (title, body, tags[]).
 */

/* ---- tokenisation -------------------------------------------------------- */

const WORD_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(s) {
  return (String(s || '').toLowerCase().match(WORD_RE) || []);
}

// Fields contribute to relevance with different weights.
const FIELD_WEIGHTS = { title: 3, tags: 2, body: 1 };

function ideaText(idea) {
  return {
    title: String(idea.title || ''),
    tags: (idea.tags || []).join(' '),
    body: String(idea.body || ''),
  };
}

/* ---- fuzzy subsequence ---------------------------------------------------
 * Returns a score in [0,1] if every char of `needle` appears in `haystack` in
 * order (subsequence match), else 0. Contiguous runs and early matches score
 * higher — the usual "command-palette" feel. Cheap, no allocation per char.
 */
export function fuzzyScore(needle, haystack) {
  needle = needle.toLowerCase();
  haystack = haystack.toLowerCase();
  if (!needle) return 1;
  if (!haystack) return 0;
  let h = 0, run = 0, score = 0, matched = 0;
  for (let n = 0; n < needle.length; n++) {
    const ch = needle[n];
    let found = -1;
    for (; h < haystack.length; h++) {
      if (haystack[h] === ch) { found = h; break; }
    }
    if (found === -1) return 0;        // not a subsequence
    matched++;
    run = (found === 0 || haystack[found - 1] === ' ') ? run + 2 : run + 1; // word-start bonus
    score += run;
    h = found + 1;
  }
  // normalise: best case is every char contiguous from the start
  const best = (needle.length * (needle.length + 1)) / 2 + needle.length;
  return Math.min(1, score / best) * (matched / needle.length);
}

/* ---- index --------------------------------------------------------------- */

export class SearchIndex {
  constructor(ideas = []) { this.build(ideas); }

  build(ideas) {
    this.ideas = ideas;
    // pre-lowercased field text + token set per idea, so query() does no
    // repeated allocation. Rebuild when the loaded set changes.
    this.docs = ideas.map((idea) => {
      const f = ideaText(idea);
      return {
        idea,
        title: f.title.toLowerCase(),
        tags: f.tags.toLowerCase(),
        body: f.body.toLowerCase(),
        tokens: new Set([...tokenize(f.title), ...tokenize(f.tags), ...tokenize(f.body)]),
      };
    });
    return this;
  }

  /* Score one doc against a parsed query. Strategy, best-first:
   *   - exact token hit in a field   -> field weight × 4
   *   - substring hit in a field     -> field weight × 2
   *   - fuzzy subsequence in title    -> up to title weight
   * Multi-term queries are AND: every term must contribute, else score 0. */
  _scoreDoc(doc, terms) {
    let total = 0;
    for (const term of terms) {
      let best = 0;
      for (const field of ['title', 'tags', 'body']) {
        const text = doc[field];
        const w = FIELD_WEIGHTS[field];
        if (doc.tokens.has(term)) { best = Math.max(best, w * 4); continue; }
        const idx = text.indexOf(term);
        if (idx !== -1) {
          // word-boundary substring scores a touch higher than mid-word
          const boundary = idx === 0 || text[idx - 1] === ' ';
          best = Math.max(best, w * (boundary ? 2.5 : 2));
        }
      }
      if (best === 0) {
        // last resort: fuzzy against the title only (typo tolerance)
        const fz = fuzzyScore(term, doc.title);
        if (fz > 0.5) best = fz * FIELD_WEIGHTS.title;
      }
      if (best === 0) return 0; // AND semantics: this term matched nothing
      total += best;
    }
    return total;
  }

  // Returns ideas ranked by relevance. Empty/whitespace query -> all ideas in
  // their original order (so the search box clears back to the full list).
  query(q, { limit = Infinity } = {}) {
    const terms = tokenize(q);
    if (!terms.length) return this.ideas.slice();
    const scored = [];
    for (const doc of this.docs) {
      const s = this._scoreDoc(doc, terms);
      if (s > 0) scored.push({ idea: doc.idea, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const out = scored.map((x) => x.idea);
    return limit === Infinity ? out : out.slice(0, limit);
  }

  // Cheap boolean: does anything match? (for "search the server?" affordance)
  hasMatch(q) {
    const terms = tokenize(q);
    if (!terms.length) return true;
    return this.docs.some((doc) => this._scoreDoc(doc, terms) > 0);
  }
}

// Convenience one-shot (rebuilds an index each call — fine for small sets).
export function searchIdeas(ideas, q, opts) {
  return new SearchIndex(ideas).query(q, opts);
}

/* ---- remote search contract ---------------------------------------------
 * The PWA escalates to the backend when the local index is insufficient — e.g.
 * the loaded set is a single list but the user wants to search everything, or
 * they tap "search all ideas". The injected `fetchJson` keeps this testable and
 * DOM/fetch-free here.
 *
 *   mode 'lexical'  -> GET  /api/ideas?q=<text>&... (filter params from filters.toQueryParams)
 *   mode 'semantic' -> POST /api/search { q, k }    (Vectorize; AI workstream owns ranking)
 *
 * Both return { ideas: Idea[] } in the normalised shape. We re-rank lexical
 * results locally for a consistent feel; semantic results keep server order.
 */
export async function remoteSearch(q, { mode = 'lexical', filterParams, k = 30, fetchJson } = {}) {
  if (typeof fetchJson !== 'function') throw new Error('remoteSearch needs a fetchJson(url, init) injector');
  if (mode === 'semantic') {
    const res = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q, k }),
    });
    return res.ideas || [];
  }
  const params = filterParams instanceof URLSearchParams ? filterParams : new URLSearchParams();
  params.set('q', q);
  const res = await fetchJson('/api/ideas?' + params.toString());
  const ideas = res.ideas || [];
  return new SearchIndex(ideas).query(q); // local re-rank for consistency
}

/* ---- tests-in-comments ---------------------------------------------------
 *   const ideas = [
 *     { id:'1', title:'3D Printed Lamps', tags:['hardware'], body:'transparent PLA, ABS base' },
 *     { id:'2', title:'Claude Reminder',  tags:['software'], body:'whatsapp gmail evening summary' },
 *     { id:'3', title:'Shower Speaker',   tags:[],           body:'' },
 *   ];
 *   const ix = new SearchIndex(ideas);
 *
 *   ix.query('lamp').map(i=>i.id)        // ['1']           (substring in title)
 *   ix.query('pla').map(i=>i.id)         // ['1']           (token in body)
 *   ix.query('software').map(i=>i.id)    // ['2']           (tag match)
 *   ix.query('claud').map(i=>i.id)       // ['2']           (substring prefix)
 *   ix.query('clade').map(i=>i.id)       // ['2']           (fuzzy: typo for "claude")
 *   ix.query('shower speaker').map(i=>i.id) // ['3']        (AND, both terms)
 *   ix.query('lamp speaker').map(i=>i.id)   // []           (no idea has both)
 *   ix.query('').map(i=>i.id)            // ['1','2','3']   (empty = passthrough)
 *   ix.hasMatch('zzz')                   // false
 *
 *   fuzzyScore('abc','abc') === 1
 *   fuzzyScore('ac','abc') > 0 && fuzzyScore('ca','abc') === 0
 *   tokenize('Hi, 3D-printed!')          // ['hi','3d','printed']
 */
