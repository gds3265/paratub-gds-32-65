const CONFIG_KEY = 'audit-bovin-supabase-config';
const SESSION_KEY = 'audit-bovin-supabase-session';
const DB_KEY = 'audit-bovin-v10-core';
const STATE_ID = 'main';
let config = loadJson(CONFIG_KEY, null);
let session = loadJson(SESSION_KEY, null);
let syncTimer = null;
let pollTimer = null;
let syncing = false;
let syncUiSilent = false;
let lastUploadedAt = '';
let lastRemoteVersion = 0;

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function localDb() { return loadJson(DB_KEY, { farms: [], visits: [], updatedAt: '' }); }
function normalizeUrl(url='') { return url.trim().replace(/\/+$/, ''); }
function configured() { return !!(config?.url && config?.key); }
function signedIn() { return !!(session?.access_token && session?.user?.email); }
function nowIso() { return new Date().toISOString(); }

function objectTimestamp(value){
  if(!value||typeof value!=='object')return 0;
  return Date.parse(value.updatedAt||value.appliedAt||value.importedAt||value.createdAt||0)||0;
}
function atomicSharedObject(value){
  return !!(value&&typeof value==='object'&&(
    value.snapshot || value.importInstanceId || value.reproductionRegistrySource || value.previousVisitReview
  ));
}
function mergeSharedData(base, incoming){
  if(Array.isArray(base)||Array.isArray(incoming)){
    const a=Array.isArray(base)?base:[],b=Array.isArray(incoming)?incoming:[];
    const combined=[...a,...b];
    const identifiable=combined.length>0&&combined.every(x=>x&&typeof x==='object'&&x.id!==undefined);
    if(!identifiable)return JSON.parse(JSON.stringify(b.length?b:a));
    const map=new Map(a.map(x=>[String(x.id),JSON.parse(JSON.stringify(x))]));
    b.forEach(x=>{
      const key=String(x.id),existing=map.get(key);
      if(!existing){map.set(key,JSON.parse(JSON.stringify(x)));return;}
      const oldTime=objectTimestamp(existing),newTime=objectTimestamp(x);
      // Une visite/import daté est traité comme un bloc : la version la plus récente gagne.
      // Cela évite de recombiner récursivement deux CSV ou deux registres différents.
      if((oldTime||newTime) && (existing.subjects||x.subjects||existing.importedAt||x.importedAt)){
        map.set(key,JSON.parse(JSON.stringify(newTime>=oldTime?x:existing)));
      }else{
        map.set(key,mergeSharedData(existing,x));
      }
    });
    return [...map.values()];
  }
  if(base&&typeof base==='object'&&incoming&&typeof incoming==='object'){
    if(atomicSharedObject(base)||atomicSharedObject(incoming)){
      const bt=objectTimestamp(base),it=objectTimestamp(incoming);
      return JSON.parse(JSON.stringify(it>=bt?incoming:base));
    }
    const out={...base};
    Object.keys(incoming).forEach(k=>{out[k]=(k in out)?mergeSharedData(out[k],incoming[k]):JSON.parse(JSON.stringify(incoming[k]));});
    return out;
  }
  return incoming===undefined?base:incoming;
}
function applyDeletionTombstones(payload){
  if(!payload||typeof payload!=='object')return payload;
  const deleted=[...new Set(Array.isArray(payload.deletedVisitIds)?payload.deletedVisitIds.map(String):[])];
  payload.deletedVisitIds=deleted;
  if(Array.isArray(payload.visits)&&deleted.length){const gone=new Set(deleted);payload.visits=payload.visits.filter(v=>!gone.has(String(v?.id)));}
  return payload;
}
// v14.6.21.11 — protection de la saisie terrain.
// Une fusion cloud ne doit jamais remplacer/recharger l'écran pendant qu'un champ est actif.
// Les données distantes sont mises en attente puis fusionnées avec la base locale la plus récente
// seulement lorsque l'utilisateur a réellement terminé sa série de saisies.
let deferredMergedPayload=null;
let deferredMergedMessage='';
let deferredMergeTimer=null;
function cloudEditableActive(){
  const el=document.activeElement;
  if(!el||el===document.body)return false;
  return !!el.matches?.('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select, [contenteditable="true"]');
}
function commitMergedLocal(payload,message=''){
  payload=applyDeletionTombstones(payload);
  localStorage.setItem(DB_KEY,JSON.stringify(payload));
  window.dispatchEvent(new CustomEvent('audit-bovin-cloud-merged',{detail:{message}}));
}
function scheduleDeferredMergeFlush(delay=450){
  clearTimeout(deferredMergeTimer);
  deferredMergeTimer=setTimeout(flushDeferredMergedLocal,delay);
}
function flushDeferredMergedLocal(){
  clearTimeout(deferredMergeTimer);deferredMergeTimer=null;
  if(!deferredMergedPayload)return;
  if(cloudEditableActive()){scheduleDeferredMergeFlush(500);return;}
  // La base locale a pu évoluer depuis la réponse Supabase : elle est refusionnée au dernier moment.
  // Pour une visite datée, la version locale la plus récente gagne donc sur une réponse cloud plus ancienne.
  const current=localDb();
  const safe=applyDeletionTombstones(mergeSharedData(deferredMergedPayload,current));
  const message=deferredMergedMessage;
  deferredMergedPayload=null;deferredMergedMessage='';
  commitMergedLocal(safe,message);
}
function applyMergedLocal(payload, message=''){
  payload=applyDeletionTombstones(payload);
  if(cloudEditableActive()){
    deferredMergedPayload=deferredMergedPayload?mergeSharedData(deferredMergedPayload,payload):JSON.parse(JSON.stringify(payload));
    if(message)deferredMergedMessage=message;
    scheduleDeferredMergeFlush(500);
    return;
  }
  // Même hors saisie, refusionner avec l'état local courant protège les changements arrivés
  // entre le début de la requête réseau et sa réponse.
  const safe=applyDeletionTombstones(mergeSharedData(payload,localDb()));
  commitMergedLocal(safe,message);
}
document.addEventListener('focusin',()=>{if(deferredMergeTimer){clearTimeout(deferredMergeTimer);deferredMergeTimer=null;}});
document.addEventListener('focusout',()=>{if(deferredMergedPayload)scheduleDeferredMergeFlush(500);});
window.addEventListener('pagehide',()=>{if(deferredMergedPayload&&!cloudEditableActive())flushDeferredMergedLocal();});

function statusLabel() {
  if (!configured()) return 'Cloud à configurer';
  if (!signedIn()) return 'Connexion technicien';
  if (!navigator.onLine) return 'Hors ligne';
  if (syncing && !syncUiSilent) return 'Synchronisation…';
  return `Synchronisé · ${session.user.email}`;
}

function setAppAccess(allowed){
  document.body.classList.toggle('auth-authorized',!!allowed);
  document.body.classList.toggle('auth-locked',!allowed);
  document.querySelector('.top-nav')?.setAttribute('aria-hidden',allowed?'false':'true');
  document.getElementById('app')?.setAttribute('aria-hidden',allowed?'false':'true');
  if(allowed) document.getElementById('secure-auth-gate')?.remove();
}
function secureGateBody(){
  if(!configured()) return `<p class="secure-gate-intro">Cette application est réservée aux techniciens autorisés du GDS 32-65.</p>${setupHtml()}`;
  if(!signedIn()) return `<p class="secure-gate-intro">Connexion obligatoire. Aucun accès local n’est possible sans compte technicien autorisé.</p>${loginHtml()}`;
  return `<p class="secure-gate-intro">Vérification de la session technicien…</p><div class="secure-loader" aria-label="Chargement"></div>`;
}
function renderSecureGate(){
  if(signedIn() && (document.body.classList.contains('auth-authorized'))) return;
  let gate=document.getElementById('secure-auth-gate');
  if(!gate){gate=document.createElement('div');gate.id='secure-auth-gate';gate.className='secure-auth-gate';document.body.appendChild(gate);}
  gate.innerHTML=`<div class="secure-auth-card"><div class="secure-auth-brand"><img src="icon-192.png?v=12.2.0" alt=""><div><strong>Audit Bovin GDS 32-65</strong><span>Accès sécurisé techniciens</span></div></div><div class="secure-auth-badge">🔒 Application protégée</div>${secureGateBody()}<p class="secure-auth-note">Aucun accès n’est prévu pour les éleveurs ni pour les utilisateurs non autorisés.</p></div>`;
  bindPanel(gate);
}
async function validateStoredSession(){
  if(!signedIn()) return false;
  if(!navigator.onLine) return true;
  try{
    const user=await request('/auth/v1/user');
    if(user?.email){session.user=user;saveJson(SESSION_KEY,session);return true;}
    return false;
  }catch(e){console.warn('Session invalide',e);return false;}
}
function toast(message) {
  const el=document.createElement('div');el.className='cloud-toast';el.textContent=message;document.body.appendChild(el);setTimeout(()=>el.remove(),3200);
}
function renderStatus() {
  let btn=document.getElementById('cloud-status-btn');
  if(!btn){
    btn=document.createElement('button');btn.id='cloud-status-btn';btn.className='cloud-status-btn';btn.type='button';btn.onclick=openCloudPanel;
    (document.querySelector('.header-tools')||document.querySelector('.app-header'))?.appendChild(btn);
  }
  btn.textContent=statusLabel();
  btn.dataset.state=!configured()?'setup':!signedIn()?'login':navigator.onLine?'online':'offline';
}
async function request(path,{method='GET',body,auth=true,headers={}}={}){
  if(!configured()) throw new Error('Configuration Supabase absente.');
  const h={'apikey':config.key,'Content-Type':'application/json',...headers};
  if(auth && session?.access_token) h.Authorization=`Bearer ${session.access_token}`;
  const res=await fetch(`${config.url}${path}`,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});
  if(res.status===401 && auth && session?.refresh_token){
    const ok=await refreshSession();if(ok)return request(path,{method,body,auth,headers});
  }
  const text=await res.text();let data=null;try{data=text?JSON.parse(text):null;}catch{data=text;}
  if(!res.ok) throw new Error(data?.message||data?.error_description||data?.hint||data?.details||String(data)||`Erreur ${res.status}`);
  return data;
}
async function refreshSession(){
  try{
    const data=await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',auth:false,body:{refresh_token:session.refresh_token}});
    session=data;saveJson(SESSION_KEY,session);renderStatus();return true;
  }catch(e){console.warn(e);session=null;localStorage.removeItem(SESSION_KEY);setAppAccess(false);renderStatus();renderSecureGate();return false;}
}
async function signIn(email,password){
  const data=await request('/auth/v1/token?grant_type=password',{method:'POST',auth:false,body:{email,password}});
  session=data;saveJson(SESSION_KEY,session);setAppAccess(true);renderStatus();startPolling();await initialSync();
}
function signOut(){session=null;localStorage.removeItem(SESSION_KEY);stopPolling();setAppAccess(false);renderStatus();renderSecureGate();}
async function fetchRemoteState(){
  const rows=await request(`/rest/v1/shared_state?id=eq.${encodeURIComponent(STATE_ID)}&select=id,payload,version,updated_at,updated_by`);
  return Array.isArray(rows)?rows[0]||null:null;
}
async function uploadState({silent=false}={}){
  if(!signedIn()||!navigator.onLine||syncing)return;
  const db=localDb();if(!db?.updatedAt)return;
  syncing=true;syncUiSilent=!!silent;renderStatus();
  try{
    const remote=await fetchRemoteState();
    const merged=applyDeletionTombstones(remote?.payload?mergeSharedData(remote.payload,db):db);
    merged.updatedAt=nowIso();
    const version=Date.now();
    await request('/rest/v1/shared_state?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:{id:STATE_ID,payload:merged,version,updated_at:nowIso(),updated_by:session.user.email}});
    applyMergedLocal(merged);
    lastUploadedAt=merged.updatedAt;lastRemoteVersion=version;
    await createDailyBackup(merged);
    if(!silent)toast('Toutes les visites sont sauvegardées dans le cloud.');
  }catch(e){console.error(e);if(!silent)toast(`Synchronisation impossible : ${e.message}`);}
  finally{syncing=false;syncUiSilent=false;renderStatus();}
}
async function createDailyBackup(db){
  const date=new Date().toISOString().slice(0,10);
  await request('/rest/v1/backup_snapshots?on_conflict=backup_date',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:{backup_date:date,payload:db,updated_at:nowIso(),created_by:session.user.email}});
}
async function initialSync(){
  if(!signedIn()||!navigator.onLine)return;
  syncing=true;renderStatus();
  try{
    const remote=await fetchRemoteState();const local=localDb();
    if(!remote){syncing=false;await uploadState({silent:true});toast('Base locale envoyée dans le cloud.');return;}
    lastRemoteVersion=Number(remote.version)||0;
    const remoteTime=Date.parse(remote.payload?.updatedAt||remote.updated_at||0)||0;
    const localTime=Date.parse(local?.updatedAt||0)||0;
    if(remoteTime>localTime){
      const merged=applyDeletionTombstones(mergeSharedData(local,remote.payload));
      applyMergedLocal(merged,'Base commune fusionnée sans quitter la page.');
      lastUploadedAt=merged.updatedAt||'';
      toast('Base commune fusionnée sans quitter la page.');
    }else if(localTime>remoteTime){
      syncing=false;await uploadState({silent:true});toast('Modifications locales envoyées dans le cloud.');
    }else{toast('Base commune à jour.');}
  }catch(e){console.error(e);toast(`Connexion cloud : ${e.message}`);}
  finally{syncing=false;renderStatus();}
}
async function pollRemote(){
  if(!signedIn()||!navigator.onLine||syncing)return;
  try{
    const remote=await fetchRemoteState();if(!remote)return;
    const remoteVersion=Number(remote.version)||0;if(remoteVersion<=lastRemoteVersion)return;
    const local=localDb();const localDirty=local.updatedAt && local.updatedAt!==lastUploadedAt;
    if(localDirty){await uploadState({silent:true});return;}
    lastRemoteVersion=remoteVersion;
    const merged=applyDeletionTombstones(mergeSharedData(local,remote.payload));
    applyMergedLocal(merged,`Mise à jour de ${remote.updated_by||'un collègue'} reçue sans quitter la page.`);
    lastUploadedAt=merged.updatedAt||'';
    toast(`Mise à jour de ${remote.updated_by||'un collègue'} reçue sans quitter la page.`);
  }catch(e){console.warn('Vérification cloud',e);}
}
function scheduleUpload(){
  if(!signedIn())return;clearTimeout(syncTimer);syncTimer=setTimeout(()=>uploadState({silent:true}),2200);
}
function startPolling(){stopPolling();if(signedIn())pollTimer=setInterval(pollRemote,30000);}
function stopPolling(){if(pollTimer)clearInterval(pollTimer);pollTimer=null;}
function closePanel(){document.getElementById('cloud-overlay')?.remove();}
function openCloudPanel(){
  closePanel();const overlay=document.createElement('div');overlay.id='cloud-overlay';overlay.className='cloud-overlay';
  const body=!configured()?setupHtml():!signedIn()?loginHtml():accountHtml();
  overlay.innerHTML=`<div class="cloud-panel"><div class="cloud-panel-head"><div><strong>Base commune techniciens</strong><small>v14.6.21.21 sécurisée</small></div><button type="button" data-cloud-close>×</button></div>${body}</div>`;
  document.body.appendChild(overlay);overlay.onclick=e=>{if(e.target===overlay||e.target.closest('[data-cloud-close]'))closePanel();};
  bindPanel(overlay);
}
function setupHtml(){return `<p>Renseigne les deux informations publiques de ton projet Supabase. Ne mets jamais la clé <b>service_role</b>.</p><label>URL du projet<input id="cloud-url" placeholder="https://xxxx.supabase.co"></label><label>Clé publique / publishable key<textarea id="cloud-key" rows="4" placeholder="sb_publishable_… ou clé anon publique"></textarea></label><button class="btn primary" id="cloud-save-config">Enregistrer la configuration</button><details><summary>Où trouver ces informations ?</summary><p>Supabase → Project Settings → API. Copie l’URL du projet et la clé publique.</p></details>`;}
function loginHtml(){return `<p>Connexion réservée aux techniciens. Les éleveurs n’ont aucun accès.</p><label>Adresse e-mail<input id="cloud-email" type="email" autocomplete="username"></label><label>Mot de passe<input id="cloud-password" type="password" autocomplete="current-password"></label><button class="btn primary" id="cloud-login">Se connecter</button><button class="btn secondary" id="cloud-change-config">Modifier la configuration Supabase</button>`;}
function accountHtml(){return `<div class="cloud-account"><p><b>Technicien connecté :</b><br>${escapeHtml(session.user.email)}</p><p><b>Sauvegarde automatique :</b><br>chaque modification est enregistrée localement puis envoyée dans la base commune. Une copie complète quotidienne est également conservée.</p><div class="cloud-actions"><button class="btn primary" id="cloud-sync-now">Synchroniser maintenant</button><button class="btn secondary" id="cloud-download">Télécharger la base commune</button><button class="btn secondary" id="cloud-upload">Envoyer cette base locale</button><button class="btn danger" id="cloud-logout">Se déconnecter</button></div></div>`;}
function escapeHtml(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function bindPanel(root){
  root.querySelector('#cloud-save-config')?.addEventListener('click',()=>{const url=normalizeUrl(root.querySelector('#cloud-url').value),key=root.querySelector('#cloud-key').value.trim();if(!url||!key)return toast('URL et clé publique obligatoires.');config={url,key};saveJson(CONFIG_KEY,config);closePanel();renderStatus();if(document.body.classList.contains('auth-locked'))renderSecureGate();else openCloudPanel();});
  root.querySelector('#cloud-change-config')?.addEventListener('click',()=>{config=null;localStorage.removeItem(CONFIG_KEY);closePanel();setAppAccess(false);renderStatus();renderSecureGate();});
  root.querySelector('#cloud-login')?.addEventListener('click',async()=>{const email=root.querySelector('#cloud-email').value.trim(),password=root.querySelector('#cloud-password').value;try{root.querySelector('#cloud-login').disabled=true;await signIn(email,password);closePanel();}catch(e){toast(`Connexion refusée : ${e.message}`);root.querySelector('#cloud-login').disabled=false;}});
  root.querySelector('#cloud-sync-now')?.addEventListener('click',async()=>{await initialSync();closePanel();});
  root.querySelector('#cloud-upload')?.addEventListener('click',async()=>{if(confirm('Envoyer la base de cet appareil et remplacer la base commune actuelle ?')){await uploadState();closePanel();}});
  root.querySelector('#cloud-download')?.addEventListener('click',async()=>{if(!confirm('Télécharger la base commune et remplacer la base locale de cet appareil ?'))return;try{const remote=await fetchRemoteState();if(!remote)throw new Error('Aucune base commune');localStorage.setItem(DB_KEY,JSON.stringify(remote.payload));location.reload();}catch(e){toast(e.message);}});
  root.querySelector('#cloud-logout')?.addEventListener('click',()=>{signOut();closePanel();});
}
window.addEventListener('audit-bovin-db-saved',scheduleUpload);
window.addEventListener('online',async()=>{renderStatus();if(!signedIn()){setAppAccess(false);renderSecureGate();return;}const valid=await validateStoredSession();if(valid){setAppAccess(true);initialSync();}else{signOut();}});
window.addEventListener('offline',renderStatus);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pollRemote();});
window.addEventListener('DOMContentLoaded',async()=>{
  setAppAccess(false);renderStatus();
  if(!signedIn()){renderSecureGate();return;}
  if(!navigator.onLine){setAppAccess(true);startPolling();toast('Mode hors ligne autorisé sur cet appareil déjà authentifié.');return;}
  renderSecureGate();
  const valid=await validateStoredSession();
  if(!valid){session=null;localStorage.removeItem(SESSION_KEY);setAppAccess(false);renderStatus();renderSecureGate();return;}
  setAppAccess(true);renderStatus();startPolling();setTimeout(initialSync,500);
});
