const CACHE_NAME = "local-speech-v1";
const CACHE_PREFIX = "local-speech-";
const APP_FILES = [
  "index.html",
  "styles/app.css",
  "src/demo.js",
  "src/index.js",
  "src/asr/chrome-local.js",
  "src/asr/whistle-local.js",
  "src/lib/errors.js",
  "src/lib/resampler.js",
  "src/lib/transcript-buffer.js",
  "src/lib/commitment-core.js",
  "src/audio-capture-worklet.js",
  "src/whistle-worker.js",
  "vendor/cactus/needle.js",
];

function scopedUrl(path) {
  return new URL(path, self.registration.scope);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_FILES.map(scopedUrl));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  if (requestUrl.origin !== scopeUrl.origin || !requestUrl.pathname.startsWith(scopeUrl.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const modelAsset = requestUrl.pathname.endsWith(".wasm") || requestUrl.pathname.endsWith(".cact");
    if (modelAsset && cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const cacheKey = new Request(requestUrl.href, { method: "GET", headers: request.headers });
        await cache.put(cacheKey, response.clone());
      }
      return response;
    } catch (error) {
      if (cached) return cached;
      if (request.mode === "navigate") {
        const appShell = await cache.match(scopedUrl("index.html"));
        if (appShell) return appShell;
      }
      throw error;
    }
  })());
});
