// Önce ağdan dener, olmazsa önbellekten verir: okunan dersler internetsiz de açılır.
const CACHE = "egitim-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Linux çekirdeği ve öykünücü büyük; tarayıcının kendi önbelleğine bırak.
  if (url.hostname === "i.copy.sh" || url.pathname.includes("/v86")) return;
  // Üyelik ve korumalı içerik (Supabase): kimlik doğrulamalı yanıtlar önbelleğe alınmaz
  if (url.hostname.endsWith(".supabase.co")) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
