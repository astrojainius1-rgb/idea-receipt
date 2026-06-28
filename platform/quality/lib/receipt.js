/* idea-receipt — pure helper library (ES module).
 *
 * These functions are COPIED VERBATIM from the repo-root app.js so they can be
 * imported and unit-tested in isolation (Node, no DOM). This file is also the
 * reference for the proposed refactor described in docs/PLAN-platform.md:
 * eventually app.js would `import` these from a real ./lib/receipt.js instead of
 * defining them inline.
 *
 * RULE: every function here is PURE — no DOM, no localStorage, no Date.now(),
 * no module-level mutable state. `agoText`/`stamp` take their clock as an
 * argument (`now`/`iso`) instead of reading Date.now() implicitly, which is the
 * one deliberate, behavior-preserving change vs app.js (see PLAN) so they're
 * deterministically testable. Callers in app.js pass Date.now() explicitly.
 *
 * Constants mirror app.js. Keep in sync until the real extraction lands.
 */

export const RATE = 0.55;      // base $/word — the "list price"
export const STALE_MIN = 90;   // minutes before the "synced" stamp goes amber

export const money = (n) => "$" + n.toFixed(2);

// stable 32-bit hash of a string (FNV-1a) — same idea always gets the same number
export function hash32(s) {
  let h = 2166136261;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// "market price" per word: every idea trades at a stable price seeded by its
// title, ranging 0.38–0.92 around the 0.55 list rate.
export function unitPrice(title) {
  const f = hash32(title) / 4294967295; // 0..1
  return Math.round((0.38 + f * 0.54) * 100) / 100;
}

// human "x ago" for the synced stamp.
// NOTE: `now` is injected (app.js passes Date.now()) so this stays pure/testable.
export function agoText(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (isNaN(t)) return { text: "synced --", stale: false };
  const mins = Math.max(0, Math.round((now - t) / 60000));
  let text;
  if (mins < 1) text = "synced just now";
  else if (mins < 60) text = `synced ${mins} min ago`;
  else if (mins < 1440) text = `synced ${Math.round(mins / 60)}h ago`;
  else text = `synced ${Math.round(mins / 1440)}d ago`;
  return { text, stale: mins >= STALE_MIN };
}

// word count of a string (whitespace-delimited tokens)
export const wordsIn = (s) => (String(s || "").trim().match(/\S+/g) || []).length;

// total words for one idea: title + all detail lines
export function ideaWords(it) {
  const details = Array.isArray(it.details) ? it.details : [];
  return wordsIn(it.title) + details.reduce((n, d) => n + wordsIn(d), 0);
}

// date/time/serial parts for a receipt. `iso` (or "now") drives it.
// NOTE: in app.js this reads `new Date()` when iso is falsy; here we keep that
// behavior but allow passing iso for determinism in tests.
export function stamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  if (isNaN(d)) return { date: "--", time: "", ymd: "00000000", hm: "0000", year: "----" };
  const dd = p(d.getDate()), mm = p(d.getMonth() + 1), yyyy = d.getFullYear();
  const h24 = d.getHours();
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 < 12 ? "AM" : "PM";
  return {
    date: `${dd}/${mm}/${yyyy}`,
    time: `${h12}:${p(d.getMinutes())} ${ampm}`,
    ymd: `${yyyy}${mm}${dd}`,
    hm: `${p(h24)}${p(d.getMinutes())}`,
    year: String(yyyy),
  };
}

// Luhn check digit, so the printed serial is *valid* like a real product barcode.
export function luhn(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = +num[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}

// Serial encodes: print date (YYYYMMDD) · idea count (2) · word count (4) · check digit.
export function serial(ymd, items, words) {
  const base = ymd
    + String(Math.min(items, 99)).padStart(2, "0")
    + String(Math.min(words, 9999)).padStart(4, "0");
  return base + luhn(base);
}

export const group4 = (s) => s.replace(/(.{4})/g, "$1 ").trim();

// longest run of consecutive calendar days present in a history list.
export function longestStreak(hist) {
  const days = [...new Set(hist.map((h) => h.ymd))].sort();
  let best = 0, cur = 0, prev = null;
  for (const ymd of days) {
    const d = Date.parse(ymd.slice(0, 4) + "-" + ymd.slice(4, 6) + "-" + ymd.slice(6, 8));
    cur = (prev !== null && d - prev === 864e5) ? cur + 1 : 1;
    if (cur > best) best = cur;
    prev = d;
  }
  return best;
}

// tiny SVG sparkline polyline from a series of numbers ("" if fewer than 2 points)
export function sparkline(vals) {
  if (vals.length < 2) return "";
  const w = 260, h = 46, pad = 4;
  const max = Math.max(...vals, 1), min = Math.min(...vals, 0), rng = (max - min) || 1;
  const step = (w - 2 * pad) / (vals.length - 1);
  const pts = vals.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / rng) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#7d8da0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/* ---- Notion #tag parsing ------------------------------------------------
 * Mirrors the heading-parsing rule in sync_notion.py (build_items): pull
 * #hashtags out of a heading's raw text → tags; the remainder (with a
 * trailing ":" already stripped by the caller in Python) is the title.
 * Provided here so the JS and Python implementations can be tested against
 * the SAME fixtures and kept in lockstep.
 */
export function parseHeading(raw) {
  raw = String(raw == null ? "" : raw).replace(/:\s*$/, "").trim();
  const tags = (raw.match(/#(\w[\w-]*)/g) || []).map((m) => m.slice(1));
  const title = raw.replace(/\s*#\w[\w-]*/g, "").trim() || raw;
  return { title, tags };
}
