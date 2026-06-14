// Service worker for FIFA World Cup 2026 – Tunisia Time
// Strategy: cache-first for the static app shell, network-only for ESPN API calls
// (so live scores/standings always try the network and never serve stale cached data)

const CACHE_NAME = 'wc2026-shell-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Install: pre-cache the app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old cache versions
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for ESPN API (live data), cache-first for everything else
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept ESPN API requests — always go to network
  if (url.includes('site.api.espn.com') || url.includes('sports.core.api.espn.com')) {
    return; // let the browser handle it normally
  }

  // Only handle same-origin GET requests for the app shell
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache a copy of newly fetched shell files for next time
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
