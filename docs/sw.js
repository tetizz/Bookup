const CACHE_NAME = "bookup-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.html",
  "./styles.min.css",
  "./web-app.min.js",
  "./vendor/chess.min.js",
  "./assets/pieces/cburnett/wP.svg",
  "./assets/pieces/cburnett/wN.svg",
  "./assets/pieces/cburnett/wB.svg",
  "./assets/pieces/cburnett/wR.svg",
  "./assets/pieces/cburnett/wQ.svg",
  "./assets/pieces/cburnett/wK.svg",
  "./assets/pieces/cburnett/bP.svg",
  "./assets/pieces/cburnett/bN.svg",
  "./assets/pieces/cburnett/bB.svg",
  "./assets/pieces/cburnett/bR.svg",
  "./assets/pieces/cburnett/bQ.svg",
  "./assets/pieces/cburnett/bK.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});
