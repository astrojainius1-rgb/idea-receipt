/* Idea Receipt service worker — offline shell + last-known ideas.
   Shell assets are cache-first (instant load); data.json is network-first
   so you always get fresh ideas online but still see the last receipt offline. */
const CACHE = "idea-receipt-v3";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "vendor/qrcode.js",
  "manifest.webmanifest",
  "icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // data.json (fetched with a ?ts= cache-buster): network-first, fall back to last good copy.
  if (url.pathname.endsWith("data.json")) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("data.json", copy));
          return res;
        })
        .catch(() => caches.match("data.json"))
    );
    return;
  }

  // shell: cache-first, fall back to network.
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});
