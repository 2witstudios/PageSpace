/**
 * PageSpace Service Worker
 *
 * Provides offline caching for recently viewed pages and static assets.
 * Uses network-first strategy for API data, cache-first for static assets.
 */

const CACHE_NAME = 'pagespace-v2';
const STATIC_CACHE_NAME = 'pagespace-static-v2';

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
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip cross-origin requests
  if (url.origin !== self.location.origin) return;

  // API requests: network-first with cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstWithCache(request));
    return;
  }

  // Next.js RSC (React Server Component) flight data and prefetch requests
  // must NEVER be cache-first — same URL serves different content based on
  // headers, and payloads become stale after deploys.
  if (request.headers.get('rsc') ||
      request.headers.get('next-router-prefetch') ||
      request.headers.get('next-router-state-tree') ||
      request.headers.get('next-url')) {
    event.respondWith(fetch(request));
    return;
  }

  // Static assets (fonts, images, content-hashed JS/CSS): cache-first
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirstWithNetwork(request));
    return;
  }

  // HTML pages: network-first, fallback to offline page
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  // Everything else: network-first to avoid serving stale dynamic content
  event.respondWith(networkFirstWithCache(request));
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

/**
 * Check if URL is a static asset.
 */
function isStaticAsset(pathname) {
  const staticExtensions = [
    '.js',
    '.css',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
  ];
  return staticExtensions.some((ext) => pathname.endsWith(ext));
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
