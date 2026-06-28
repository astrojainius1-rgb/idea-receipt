/* idea-receipt — privacy-friendly client error reporter (standalone, no deps).
 *
 * WHY a custom reporter instead of Sentry: the app is a tiny static PWA with no
 * build step and no third-party scripts today (only a vendored qrcode lib). A
 * 3rd-party SDK would add a CDN dependency, a privacy policy obligation, and a
 * DSN to manage. Since the backend (Cloudflare Worker + D1) already exists, the
 * cheapest privacy-preserving option is to POST a tiny, scrubbed payload to our
 * OWN endpoint: POST {API_BASE}/api/log. See docs/PLAN-platform.md (#15) for the
 * Sentry alternative and the trade-off.
 *
 * INTEGRATION (no existing file is edited — add ONE line to index.html's <head>,
 * BEFORE app.js, when you adopt this):
 *
 *     <script>window.IDEA_ERR = { api: "https://idea-receipt-api.<acct>.workers.dev" };</script>
 *     <script src="errors.js"></script>
 *
 * If `window.IDEA_ERR.api` is unset it falls back to same-origin "/api/log"
 * (harmless on GitHub Pages — POSTs 405 and are dropped). Set it to the Worker
 * origin from platform/backend/wrangler.toml (APP_ORIGIN's API counterpart).
 *
 * PRIVACY: we capture ONLY what's needed to fix a crash — message, error name,
 * a stack with absolute URLs reduced to filenames, the source line/col, the
 * pathname (never query/hash, which could carry a Notion page id), UA, and a
 * coarse viewport. We DO NOT capture: localStorage (ideas, billedTo, history),
 * the receipt DOM/text, full URLs, cookies, or any idea content. A random,
 * rotating client id (sessionStorage, not persistent) lets us group a session's
 * errors without identifying the user.
 */
(function () {
  "use strict";

  var CFG = (typeof window !== "undefined" && window.IDEA_ERR) || {};
  var API_BASE = (CFG.api || "").replace(/\/+$/, "");
  var ENDPOINT = (API_BASE || "") + "/api/log";
  var MAX_PER_SESSION = 20;      // never spam the backend
  var DEDUPE_MS = 10000;         // collapse identical bursts
  var sent = 0;
  var lastKey = "";
  var lastAt = 0;

  // ephemeral session id — NOT tied to identity, gone when the tab closes
  function sessionId() {
    try {
      var k = "errSid";
      var v = sessionStorage.getItem(k);
      if (!v) {
        v = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16);
        sessionStorage.setItem(k, v);
      }
      return v;
    } catch (e) { return "nostore"; }
  }

  // strip absolute origins from a stack/filename so we never leak full URLs
  function scrub(s) {
    if (!s) return "";
    return String(s)
      .replace(/https?:\/\/[^/]+\//g, "")   // drop scheme+host -> relative path
      .replace(/[?#][^\s)'"]*/g, "")          // drop any query/hash fragments
      .slice(0, 4000);
  }

  function payload(kind, fields) {
    return Object.assign({
      kind: kind,                              // "error" | "unhandledrejection"
      sid: sessionId(),
      at: new Date().toISOString(),            // ISO-8601 UTC, matches backend convention
      path: (location && location.pathname) || "",  // pathname only — no query/hash
      ua: (navigator && navigator.userAgent) || "",
      vw: (window.innerWidth || 0) + "x" + (window.innerHeight || 0),
      app: "idea-receipt",
      v: (CFG.release || "unversioned"),
    }, fields);
  }

  function post(body) {
    // dedupe identical bursts
    var key = body.kind + "|" + (body.message || "") + "|" + (body.line || "");
    var now = Date.now();
    if (key === lastKey && now - lastAt < DEDUPE_MS) return;
    lastKey = key; lastAt = now;
    if (sent >= MAX_PER_SESSION) return;
    sent++;

    var json = JSON.stringify(body);
    try {
      // sendBeacon survives the unload that often follows a fatal error
      if (navigator.sendBeacon) {
        var blob = new Blob([json], { type: "application/json" });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (e) { /* fall through */ }
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json,
        keepalive: true,
        mode: "cors",
        credentials: "omit",       // no cookies — anonymous, no CSRF surface
      }).catch(function () {});
    } catch (e) { /* give up silently — never let the reporter throw */ }
  }

  window.addEventListener("error", function (e) {
    // resource-load errors (img/script) have no .error and a target — skip those
    if (e && e.target && e.target !== window && (e.target.src || e.target.href)) return;
    var err = e && e.error;
    post(payload("error", {
      message: scrub((e && e.message) || (err && err.message) || "Unknown error"),
      name: (err && err.name) || "Error",
      stack: scrub(err && err.stack),
      file: scrub(e && e.filename),
      line: (e && e.lineno) || 0,
      col: (e && e.colno) || 0,
    }));
  });

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    var msg = (r && r.message) || (typeof r === "string" ? r : "Unhandled promise rejection");
    post(payload("unhandledrejection", {
      message: scrub(msg),
      name: (r && r.name) || "UnhandledRejection",
      stack: scrub(r && r.stack),
    }));
  });

  // expose a manual hook so app.js's catch blocks could opt in later:
  //   window.reportError && window.reportError(err, "saveImage")
  window.reportError = function (err, context) {
    try {
      post(payload("error", {
        message: scrub((err && err.message) || String(err)),
        name: (err && err.name) || "Error",
        stack: scrub(err && err.stack),
        context: scrub(context || ""),
        manual: true,
      }));
    } catch (e) {}
  };
})();
