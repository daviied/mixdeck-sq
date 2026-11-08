const C = "mixdeck-sq-v1";
const SHELL = ["/", "/index.html", "/style.css", "/desk.css", "/manifest.webmanifest", "/icons/icon-192.png",
  "/js/app.js", "/js/core.js", "/js/ui.js", "/js/eq.js", "/js/mix.js", "/js/inspector.js", "/js/pages.js", "/js/follow.js", "/js/desk.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then((r) => {
    const cp = r.clone(); caches.open(C).then((c) => c.put(e.request, cp)); return r;
  }).catch(() => caches.match(e.request).then((m) => m || caches.match("/index.html"))));
});
