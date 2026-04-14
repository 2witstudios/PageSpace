/**
 * PageSpace Service Worker
 *
 * Provides offline caching for recently viewed pages and static assets.
 * Uses network-first strategy for API data, cache-first for static assets.
 *
 * Routing is delegated to classifyRequest in sw-router.js so the decision
 * logic can be unit-tested in isolation. See that file for the layered
 * invariants this SW enforces — in particular, the rule that top-level
 * navigations must not be owned by the service worker.
 */

importScripts('/sw-router.js');

const CACHE_NAME = 'pagespace-v3';
const STATIC_CACHE_NAME = 'pagespace-static-v3';

// Core pages to cache for offline access
const OFFLINE_URLS = ['/', '/offline'];

// Static assets to pre-cache
const STATIC_ASSETS = ['/manifest.json', '/favicon.ico', '/favicon-32x32.png'];

// Install event - pre-cache essential assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE_NAME).then((cache) => {
        return cache.addAll(STATIC_ASSETS);
      }),
      caches.open(CACHE_NAME).then((cache) => {
        return cache.addAll(OFFLINE_URLS);
      }),
    ])
  );
  // Activate immediately
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Take control of all pages immediately
  self.clients.claim();
});

// Fetch event - handle requests
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip cross-origin requests
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const classification = self.classifyRequest({
    mode: request.mode,
    method: request.method,
    url: request.url,
  });

  switch (classification) {
    case 'not-intercepted':
    case 'native-pass-through':
      // Returning without calling event.respondWith hands the request
      // back to the browser. This is operationally different from
      // event.respondWith(fetch(request)): that would move redirect
      // following into the fetch API, which cannot dispatch to custom
      // schemes like pagespace:// and would break desktop OAuth.
      return;

    case 'api-network-first':
      event.respondWith(networkFirstWithCache(request));
      return;

    case 'cache-first':
      event.respondWith(cacheFirstWithNetwork(request));
      return;

    case 'network-first': {
      // Next.js RSC (React Server Component) flight data and prefetch
      // requests must NEVER be cache-first — same URL serves different
      // content based on headers, and payloads become stale after
      // deploys.
      if (
        request.headers.get('rsc') ||
        request.headers.get('next-router-prefetch') ||
        request.headers.get('next-router-state-tree') ||
        request.headers.get('next-url')
      ) {
        event.respondWith(
          fetch(request).catch(
            () => new Response('', { status: 503, statusText: 'Service Unavailable' })
          )
        );
        return;
      }

      // HTML pages with network-first + offline fallback. Note that
      // top-level HTML navigations never reach this branch — they are
      // classified 'native-pass-through' by rule 1 above. This branch
      // handles non-navigate HTML sub-requests (e.g. iframe loads).
      if (request.headers.get('accept')?.includes('text/html')) {
        event.respondWith(networkFirstWithOfflineFallback(request));
        return;
      }

      event.respondWith(networkFirstWithCache(request));
      return;
    }
  }
});

/**
 * Network-first strategy with cache fallback.
 * Best for API data that should be fresh but has offline fallback.
 */
async function networkFirstWithCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Return a JSON error for API requests when offline
    return new Response(JSON.stringify({ error: 'offline', message: 'You are offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Cache-first strategy with network fallback.
 * Best for static assets that rarely change.
 */
async function cacheFirstWithNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return nothing if not cached and offline
    return new Response('', { status: 503 });
  }
}

/**
 * Network-first with offline page fallback.
 * Best for HTML page requests.
 */
async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Try cached version first
    const cached = await caches.match(request);
    if (cached) return cached;

    // Fall back to offline page
    const offlinePage = await caches.match('/offline');
    if (offlinePage) return offlinePage;

    // Ultimate fallback if offline page not cached
    return new Response('You are offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// Listen for messages from the app with origin verification
self.addEventListener('message', (event) => {
  // Fail-closed: reject messages without a valid same-origin source
  if (!event.origin || event.origin !== self.location.origin) {
    return;
  }

  // Fail-closed: reject messages not from a WindowClient (browser tab)
  if (!event.source || !('visibilityState' in event.source)) {
    return;
  }

  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((names) => {
        return Promise.all(names.map((name) => caches.delete(name)));
      })
    );
  }
});
