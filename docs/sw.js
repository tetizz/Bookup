const CACHE_PREFIX = "bookup-";
const CACHE_NAME = `${CACHE_PREFIX}shell-v14`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.html",
  "./styles.min.css",
  "./product-shell.css",
  "./product-shell.js",
  "./position-analysis.min.js",
  "./smart-theory-engine.min.js",
  "./web-app.min.js",
  "./vendor/chess.min.js",
  "./vendor/stockfish/stockfish-18-lite-single.js",
  "./vendor/stockfish/stockfish-18-lite-single.wasm",
  "./vendor/stockfish/COPYING.txt",
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
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
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
        .then(async (response) => {
          const contentType = response.headers.get("content-type") || "";
          if (response.ok && response.type === "basic" && contentType.includes("text/html")) {
            const copy = response.clone();
            const cache = await caches.open(CACHE_NAME);
            await cache.put("./index.html", copy);
          }
          return response;
        })
        .catch(async () => (
          await caches.match("./index.html") ||
          new Response("Bookup is offline and the app shell is not cached yet.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        ))
    );
    return;
  }

  // Normalize cache-busting query strings to one key so a refreshed asset
  // replaces the install-time entry instead of competing with it forever.
  const cacheKey = `${requestUrl.origin}${requestUrl.pathname}`;
  const cached = caches.match(cacheKey);
  const update = fetch(event.request).then(async (response) => {
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  });

  event.waitUntil(update.then(() => undefined).catch(() => undefined));
  event.respondWith(cached.then((match) => match || update.catch(() => (
    new Response("Bookup could not load this local asset.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  ))));
});
