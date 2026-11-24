// Service worker: aplikasi tetap bisa dibuka saat sinyal lemah.
// Strategi "network-first": selalu ambil versi terbaru, pakai cache jika offline.
const CACHE = "maker-soal-v10";
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // panggilan AI tidak di-cache
  e.respondWith(
    // cache: "no-cache" → selalu cek ke server (murah, 304 jika tidak berubah) agar file lama & baru tidak tercampur
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
