/* selection.js — a multi-select state machine for bulk actions on a receipt.
 *
 * Pure logic: holds which idea ids are selected, whether "select mode" is on,
 * and translates a chosen bulk action into a batch of PATCH/DELETE operations
 * the PWA can fire at the backend. No DOM, no fetch.
 *
 * UX model (the receipt):
 *   - Tapping an idea normally crosses it off (existing behaviour).
 *   - Long-press (or a "select" toolbar button) calls enter() -> select mode.
 *   - In select mode, tapping toggles membership instead of crossing off;
 *     checkboxes appear on each row.
 *   - A bulk action bar shows count + actions; performing one yields an
 *     operation batch and then exits select mode.
 *
 * The machine is an observable: subscribe() to re-render the UI when state
 * changes. It never mutates ideas itself — it emits the batch and lets the
 * caller apply it optimistically + reconcile with the server.
 */

export const BULK_ACTIONS = ['done', 'active', 'move', 'tag', 'untag', 'archive', 'delete'];

export class Selection {
  constructor() {
    this.active = false;        // select mode on/off
    this.ids = new Set();       // selected idea ids
    this._anchor = null;        // last toggled id, for range-select (shift / drag)
    this._listeners = new Set();
  }

  /* ---- subscription ----------------------------------------------------- */
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) fn(this.snapshot()); }
  snapshot() {
    return { active: this.active, count: this.ids.size, ids: [...this.ids], anchor: this._anchor };
  }

  /* ---- mode ------------------------------------------------------------- */
  // Enter select mode, optionally seeding the first selected id (e.g. the row
  // that was long-pressed).
  enter(seedId = null) {
    const was = this.active;
    this.active = true;
    if (seedId != null) { this.ids.add(seedId); this._anchor = seedId; }
    if (!was || seedId != null) this._emit();
    return this;
  }

  exit() {
    if (!this.active && this.ids.size === 0) return this;
    this.active = false;
    this.ids.clear();
    this._anchor = null;
    this._emit();
    return this;
  }

  /* ---- membership ------------------------------------------------------- */
  isSelected(id) { return this.ids.has(id); }

  toggle(id) {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this._anchor = id;
    // auto-exit when the last item is deselected — matches iOS/Android feel
    if (this.ids.size === 0) { this.active = false; this._anchor = null; }
    this._emit();
    return this;
  }

  // Select the contiguous range between the anchor and `id` within the given
  // ordered id list (shift-click / drag-select over the rendered order).
  selectRange(id, orderedIds) {
    if (this._anchor == null || !orderedIds || !orderedIds.length) return this.toggle(id);
    const a = orderedIds.indexOf(this._anchor);
    const b = orderedIds.indexOf(id);
    if (a === -1 || b === -1) return this.toggle(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) this.ids.add(orderedIds[i]);
    this._anchor = id;
    this.active = true;
    this._emit();
    return this;
  }

  selectAll(ids) {
    ids.forEach((id) => this.ids.add(id));
    if (ids.length) this.active = true;
    this._emit();
    return this;
  }

  clear() {
    this.ids.clear();
    this._anchor = null;
    this._emit();
    return this;
  }

  /* ---- bulk action -> operation batch ----------------------------------
   * Translate a chosen action into a list of operations the PWA fires as
   * batched PATCH/DELETE calls. Returns:
   *   { ops: Operation[], action, ids }
   * where Operation is one of:
   *   { method:'PATCH',  id, body:{...} }   // status/list/priority/tags change
   *   { method:'DELETE', id }               // soft-delete (server sets deleted_at)
   *
   * The backend should also accept these as ONE request via a batch endpoint
   * (see PLAN) — `toBatchРayload()` builds that. Per-op form is the fallback.
   *
   * payload depends on action:
   *   'done'|'active'|'archive' -> none (status implied)
   *   'move'                    -> { list_id }
   *   'tag'                     -> { tag }   (add to each idea's tags[])
   *   'untag'                   -> { tag }   (remove from each idea's tags[])
   *   'delete'                  -> none
   */
  buildOps(action, payload = {}) {
    const ids = [...this.ids];
    if (!BULK_ACTIONS.includes(action)) throw new Error('unknown bulk action: ' + action);
    const ops = ids.map((id) => {
      switch (action) {
        case 'done':    return { method: 'PATCH', id, body: { status: 'done' } };
        case 'active':  return { method: 'PATCH', id, body: { status: 'active' } };
        case 'archive': return { method: 'PATCH', id, body: { status: 'archived' } };
        case 'move':    return { method: 'PATCH', id, body: { list_id: payload.list_id ?? null } };
        case 'tag':     return { method: 'PATCH', id, body: { addTags: [payload.tag] } };
        case 'untag':   return { method: 'PATCH', id, body: { removeTags: [payload.tag] } };
        case 'delete':  return { method: 'DELETE', id };
      }
    });
    return { ops, action, ids };
  }

  // Build the single-request batch body for PATCH /api/ideas (bulk endpoint).
  // Groups identical PATCH bodies so "archive 12 ideas" is one op over 12 ids.
  toBatchPayload(action, payload = {}) {
    const { ops, ids } = this.buildOps(action, payload);
    if (action === 'delete') return { delete: ids };
    const body = ops[0] ? ops[0].body : {};
    return { ids, patch: body };
  }
}

// Factory + a tiny pure helper so callers don't need `new`.
export function createSelection() { return new Selection(); }

/* ---- tests-in-comments ---------------------------------------------------
 *   const sel = new Selection();
 *   sel.active                          // false
 *   sel.enter('a'); sel.active          // true
 *   sel.snapshot().count                // 1
 *   sel.toggle('b').snapshot().count    // 2
 *   sel.toggle('b').snapshot().count    // 1  (deselected)
 *   sel.toggle('a').active              // false (last item removed -> auto-exit)
 *
 *   const order = ['a','b','c','d'];
 *   const s2 = new Selection(); s2.enter('a'); s2.selectRange('c', order);
 *   s2.snapshot().ids                   // ['a','b','c']
 *
 *   const s3 = new Selection(); s3.enter('x'); s3.toggle('y');
 *   s3.buildOps('archive').ops          // [{method:'PATCH',id:'x',body:{status:'archived'}}, {...'y'}]
 *   s3.buildOps('move', {list_id:'L9'}).ops[0].body   // { list_id:'L9' }
 *   s3.buildOps('delete').ops[0]        // { method:'DELETE', id:'x' }
 *   s3.toBatchPayload('archive')        // { ids:['x','y'], patch:{status:'archived'} }
 *   s3.toBatchPayload('delete')         // { delete:['x','y'] }
 *
 *   let calls = 0; const off = s3.subscribe(()=>calls++); s3.toggle('z'); calls // 1
 *   off(); s3.toggle('z'); calls        // still 1 (unsubscribed)
 */
