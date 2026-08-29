const CACHE='ptb-gds-v1.2.17';
const BASE='/paratub-gds-32-65/';
const CORE=[
  BASE,
  BASE+'index.html',
  BASE+'styles.css',
  BASE+'app.js',
  BASE+'manifest.webmanifest',
  BASE+'ptb-icon-192.png',
  BASE+'ptb-icon-512.png',
  BASE+'ptb-icon-maskable-512.png',
  BASE+'apple-touch-icon.png',
  BASE+'history_seed.js',
  BASE+'migration/history_seed.json'
];

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
  if(url.origin!==self.location.origin || !url.pathname.startsWith(BASE)) return;

  if(req.mode==='navigate' || url.pathname===BASE+'manifest.webmanifest'){
    event.respondWith(
      fetch(req).then(resp=>{
        if(resp && resp.status===200){const clone=resp.clone();caches.open(CACHE).then(c=>c.put(req,clone));}
        return resp;
      }).catch(()=>caches.match(req).then(r=>r||caches.match(BASE+'index.html')))
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
