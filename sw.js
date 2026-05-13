var CACHE_NAME = 'agus-static-v2';

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(['/']).catch(function() {});
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(n) {
        if (n !== CACHE_NAME) return caches.delete(n);
      }));
    })
  );
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // Don't intercept API calls — they cross origins without CORS
  if (req.url.includes('script.google.com') || req.url.includes('?action=')) return;

  // Cache static assets (CDN, fonts, icons, map tiles)
  e.respondWith(
    caches.match(req).then(function(cached) {
      return cached || fetch(req).then(function(res) {
        if (res && res.ok && !req.url.includes('script.google.com')) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(req, clone); });
        }
        return res;
      });
    }).catch(function() {
      return caches.match(req);
    })
  );
});
