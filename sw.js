const CACHE='ptb-gds-v1.2.16';
const CORE=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./ptb-icon-192.png','./ptb-icon-512.png','./ptb-icon-maskable-512.png','./apple-touch-icon.png','./history_seed.js','./migration/history_seed.json'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k.startsWith('ptb-gds-')&&k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const req=event.request;
  const url=new URL(req.url);

  // Documents and manifest: prefer network so an old PWA/service worker cannot keep stale identity.
  if(req.mode==='navigate' || url.pathname.endsWith('/manifest.webmanifest')){
    event.respondWith(
      fetch(req).then(resp=>{
        if(resp && resp.status===200){const clone=resp.clone();caches.open(CACHE).then(c=>c.put(req,clone));}
        return resp;
      }).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(r=>r||fetch(req).then(resp=>{
      if(resp && resp.status===200){const clone=resp.clone();caches.open(CACHE).then(c=>c.put(req,clone));}
      return resp;
    }))
  );
});
