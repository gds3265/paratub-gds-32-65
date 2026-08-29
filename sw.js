const CACHE='ptb-gds-v1.2.13';
const CORE=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./icons/icon.svg','./history_seed.js','./migration/history_seed.json'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
    if(e.request.method==='GET' && resp && resp.status===200){const clone=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,clone));}
    return resp;
  }).catch(()=>caches.match('./index.html'))));
});
