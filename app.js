import { loadDatabase, saveDatabase, loadDraft, saveDraft, clearDraft, replaceDatabase } from './storage.js';
import { uid, formatDate, formatDateTime, escapeHtml, downloadJson, slugify } from './utils.js';
import { THRESHOLDS, CATEGORY_RULE_MAP } from './analysis-rules.js';
import { KNOWLEDGE_AXES, KNOWLEDGE_RULES } from './knowledge-base.js';

let db = loadDatabase();
let currentView = 'dashboard';
let editingVisitId = null;
let activeVisitId = localStorage.getItem('audit-bovin-active-visit') || localStorage.getItem('audit-bovin-active-visit') || localStorage.getItem('audit-bovin-active-visit') || '';
let openSubjectId = null;
let activeAnalysisSection = localStorage.getItem('audit-bovin-active-analysis-section') || 'numeric';
let activeAnalysisFamily = localStorage.getItem('audit-bovin-active-analysis-family') || 'Urines';
let activeGeneralKind = localStorage.getItem('audit-bovin-active-general-kind') || 'tamis';
let focusedAnalysisSubjectId = localStorage.getItem('audit-bovin-focused-analysis-subject') || '';
const app = document.getElementById('app');
const fileInput = document.getElementById('json-file-input');


// V14.2.1 — fonctions communes restaurées après fusion des modules restitution/pilotage.
function normalizeSearchText(value='') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureVisitConclusion(visit) {
  if (!visit) return { strengths:[], high:'', medium:'', low:'', general:'', priorities:[], next:'' };
  const current = visit.visitConclusion && typeof visit.visitConclusion === 'object' ? visit.visitConclusion : {};
  current.strengths = Array.isArray(current.strengths)
    ? current.strengths
    : String(current.strengths || '').split(/\n+/).map(x=>x.trim()).filter(Boolean);
  current.high = String(current.high || '');
  current.medium = String(current.medium || '');
  current.low = String(current.low || '');
  current.general = String(current.general || '');
  current.next = String(current.next || '');
  current.priorities = Array.isArray(current.priorities) ? current.priorities : [];
  current.priorities = current.priorities.map(item => typeof item === 'string'
    ? { text:item, source:'', decision:'À étudier', comment:'' }
    : { text:'', source:'', decision:'À étudier', comment:'', ...item });
  while (current.priorities.length < 3) current.priorities.push({ text:'', source:'', decision:'À étudier', comment:'' });
  visit.visitConclusion = current;
  return current;
}

function smartConclusionCandidates(visit){
  const candidates=[];
  const add=(text,source,score=0,decision='À étudier',comment='',theme='')=>{
    text=String(text||'').trim();if(!text)return;
    const key=normalizeSearchText(theme||text).replace(/\b(controle|controler|verifier|revoir|surveiller|adapter|examiner|faire|realiser|reprendre)\b/g,'').trim();
    candidates.push({text,source,score:Number(score)||0,decision,comment,theme:key||normalizeSearchText(text)});
  };
  try{
    (categoryAnalysis(visit)||[]).forEach(group=>{
      (buildKnowledgePistes(visit,group)||[]).forEach(h=>{
        const state=reasoningState(visit,`${group.category}:${h.id}`);if(state.status==='dismissed')return;
        const confidence={high:5,medium:3,low:1}[h.confidence?.className]||1;
        const evidence=(h.evidence||[]).length, sources=h.sourceCount||1, base=confidence+evidence+sources*2;
        const action=(h.checks||[])[0]||h.action||`Revoir ${h.title||h.summary||'ce point'}`;
        add(`${group.category} — ${action}`,`${h.title||'Analyse croisée'} · ${sources} source(s)`,base+(state.status==='watch'?-1:0),'À étudier',(h.evidence||[]).slice(0,3).join(' · '),h.id||h.title);
      });
    });
  }catch(e){console.warn('Pistes croisées indisponibles',e)}
  try{(suggestedActions(visit)||[]).forEach(x=>add(`${x.category?x.category+' — ':''}${x.action||x.title||''}`,`${x.theme||x.category||'Mesures animales'}`,x.level==='danger'?8:5,'À étudier',x.text||'',x.theme||x.title));}catch{}
  try{
    const build=buildingRecords(visit),bad=build.questionnaire.filter(q=>['À surveiller','À corriger'].includes(q.status));
    if(bad.length)add(`Bâtiment — corriger les ${bad.length} point(s) défavorables identifiés puis recontrôler.`,`Questionnaire bâtiment`,6+Math.min(4,bad.length),'À faire',bad.slice(0,4).map(x=>x.question||x.label||x.status).filter(Boolean).join(' · '),'building');
  }catch{}
  try{
    const ms=metabolicSummary(visit),ab=ms.filter(x=>x.low||x.high),n=ab.reduce((n,x)=>n+x.low+x.high,0);
    if(n)add(`Profil métabolique — revoir les apports, l’ingestion réelle et les antagonismes puis contrôler les paramètres anormaux.`,`Profil métabolique · ${n} résultat(s) hors repère`,6+Math.min(4,n),'À étudier',ab.map(x=>`${x.label}: ${x.low} bas / ${x.high} haut`).join(' · '),'metabolic');
  }catch{}
  try{
    const ps=parasiteSummary(visit),n=ps.reduce((n,x)=>n+x.statuses.filter(s=>['modere','eleve','positif'].includes(s)).length,0);
    if(n)add(`Parasitisme — interpréter les résultats avec le contexte de pâturage et décider du contrôle / traitement avec le vétérinaire.`,`Parasitisme · ${n} résultat(s) à surveiller`,6+Math.min(4,n),'À étudier','', 'parasitism');
  }catch{}
  try{
    const w=ensureWaterLab(visit),bad=(w.points||[]).flatMap(pt=>(pt.rows||[]).filter(r=>waterStatus(r)==='hors repère').map(r=>`${pt.name||'Point eau'}: ${r.parameter}`));
    if(bad.length)add(`Eau — sécuriser le ou les points d’eau hors repère et rechercher une dégradation entre source, réseau et abreuvoir.`,`Analyse d’eau · ${bad.length} paramètre(s) hors repère`,7+Math.min(4,bad.length),'À faire',bad.slice(0,5).join(' · '),'water');
  }catch{}
  (visit.analysisActions||[]).filter(a=>a.text).forEach(a=>add(a.text,'Plan d’action',a.priority==='Haute'?12:a.priority==='Moyenne'?8:5,a.status||'À faire',a.progressNote||'',`manual:${normalizeSearchText(a.text)}`));
  const merged=[];
  candidates.sort((a,b)=>b.score-a.score);
  candidates.forEach(c=>{
    const found=merged.find(x=>x.theme===c.theme || normalizeSearchText(x.text)===normalizeSearchText(c.text));
    if(found){
      if(c.score>found.score)Object.assign(found,c);
      else if(c.source&&!found.source.includes(c.source))found.source+=` + ${c.source}`;
      return;
    }
    merged.push(c);
  });
  return merged;
}
function autoVisitConclusion(visit) {
  const saved = ensureVisitConclusion(visit);
  const strengths = [...saved.strengths];
  const groups = typeof categoryAnalysis === 'function' ? categoryAnalysis(visit) : [];
  if ((visit.subjects || []).length && groups.length) strengths.push(`${groups.length} catégorie(s) analysée(s) avec des mesures exploitables.`);
  if ((visit.photos || []).length) strengths.push(`${visit.photos.length} photo(s) documentent la visite.`);
  if ((visit.feeding?.rations || []).length) strengths.push('La ration et les modalités de distribution sont renseignées.');
  const uniqueStrengths = [...new Set(strengths.map(x=>String(x).trim()).filter(Boolean))].slice(0,6);
  const proposed=smartConclusionCandidates(visit).map(x=>({text:x.text,source:x.source,decision:x.decision||'À étudier',comment:x.comment||'',score:x.score}));
  const merged=[];
  [...saved.priorities.filter(x=>x.text).map(x=>({...x,score:x.score||15})), ...proposed].forEach(x=>{
    const key=normalizeSearchText(x.text);if(!key)return;
    const same=merged.find(y=>normalizeSearchText(y.text)===key);
    if(!same)merged.push(x); else if((x.score||0)>(same.score||0))Object.assign(same,x);
  });
  merged.sort((a,b)=>(b.score||0)-(a.score||0));
  while(merged.length<3) merged.push({text:'',source:'',decision:'À étudier',comment:'',score:0});
  return {...saved, strengths:uniqueStrengths, priorities:merged.slice(0,6)};
}
const visitTypes = ['Bilan 5MVet', 'Audit complet', 'Visite métabolique', 'Audit bâtiment', 'Audit alimentation', 'Audit sanitaire', 'Audit vêlage', 'Audit veaux', 'Suivi', 'Autre'];
const categories = ['Non classé', 'Veau 0–15 jours', 'Veau 15–60 jours', 'Génisse', 'Engraissement', 'Préparation vêlage', 'Tarie', 'Fraîche vêlée', 'Début lactation', 'Pic de lactation', 'Milieu lactation', 'Fin lactation', 'Vache allaitante', 'Autre'];
const physiologicalStages = ['Non renseigné', 'Vide', 'Synchronisation des chaleurs', 'Pleine', 'Lactation'];
const feedingCategories = ['Veaux', 'Génisses', 'Engraissement', 'Vaches en production', 'Préparation vêlage', 'Vaches taries', 'Vaches allaitantes', 'Taureaux', 'Autre'];
const feedTypes = ['Ensilage', 'Enrubanné', 'Foin', 'Regain', 'Paille', 'Concentré', 'Correcteur', 'Minéral', 'Sel', 'Bicarbonate', 'Levures', 'Mélasse / sucre', 'Autre'];
const feedUnits = ['kg brut/j', 'kg MS/j', 'g/j', 'L/j', 'À volonté', 'Autre'];
const distributionModes = ['Mélangeuse', 'Désileuse', 'Râtelier', 'Cornadis', 'DAC', 'Robot', 'Libre-service', 'Manuel', 'Pâturage', 'Autre'];
const buildingTypes = ['Stabulation libre', 'Stabulation entravée', 'Aire paillée', 'Logettes', 'Nurserie', 'Bâtiment veaux', 'Bâtiment engraissement', 'Mixte', 'Autre'];
const buildingOrientations = ['Nord', 'Nord-Est', 'Est', 'Sud-Est', 'Sud', 'Sud-Ouest', 'Ouest', 'Nord-Ouest', 'Non renseignée'];
const ventilationTypes = ['Naturelle', 'Mécanique', 'Mixte', 'Non renseignée'];
const drinkerTypes = ['Bac collectif', 'Bol individuel', 'Abreuvoir à niveau constant', 'Abreuvoir à palette', 'Abreuvoir à pipette', 'Abreuvoir chauffant', 'Autre'];
const drinkerMaterials = ['Inox', 'Plastique', 'Béton', 'Fonte', 'Acier galvanisé', 'Résine / composite', 'Autre'];
const waterOrigins = ['Réseau', 'Source', 'Forage', 'Puits', 'Eau de pluie', 'Mixte', 'Autre'];
const litterTypes = ['Paille', 'Sciure', 'Copeaux', 'Sable', 'Matelas', 'Compost', 'Mixte', 'Autre'];
const buildingQuestionGroups = [
  ['Eau et abreuvement', ['Accès à l’eau suffisant pour tous les animaux', 'Nombre de points d’eau adapté', 'Débit satisfaisant', 'Hauteur adaptée', 'Abreuvoirs propres', 'Absence de concurrence excessive']],
  ['Couchage et litière', ['Surface de couchage suffisante', 'Litière sèche et confortable', 'Paillage régulier', 'Curage adapté', 'Absence de zones glissantes', 'Absence de blessures liées au couchage']],
  ['Ventilation et ambiance', ['Entrées d’air suffisantes', 'Sorties d’air efficaces', 'Absence de condensation', 'Absence d’odeur forte d’ammoniac', 'Luminosité suffisante', 'Absence de courants d’air directs sur les animaux']],
  ['Circulation et sécurité', ['Circulation fluide des animaux', 'Sols en bon état', 'Barrières et cornadis sécurisés', 'Absence de points dangereux', 'Zone d’isolement disponible', 'Accès facile pour les soins']],
  ['Veaux et mise bas', ['Cases de vêlage propres', 'Zone veaux adaptée', 'Séparation des malades possible', 'Nettoyage et désinfection organisés', 'Matériel de soins disponible']],
  ['Hygiène et biosécurité', ['Gestion des nuisibles', 'Stockage des aliments protégé', 'Nettoyage du matériel', 'Gestion des cadavres', 'Accès visiteurs maîtrisé']]
];


const auditGlobalSections = [
  { id:'sanitaire', title:'Sanitaire et gestion du troupeau', icon:'🩺', questions:[
    'Principaux problèmes sanitaires rencontrés sur les 12 derniers mois','Mortalité veaux (%)','Mortalité adultes (%)','Diarrhées néonatales — nombre de veaux atteints/an','Diarrhées (tous âges) — nombre d’animaux atteints/an','Pathologies respiratoires / pneumonies — nombre d’animaux atteints/an','Mammites cliniques — nombre de vaches atteintes/an','Boiteries — nombre d’animaux atteints/an','Omphalites / arthrites — nombre de veaux atteints/an','Troubles de reproduction — nombre de femelles atteintes/an','Avortements (nombre/an)','Vêlages difficiles avec intervention — nombre/an','Réformes suite au vêlage — nombre/an','Usage antiparasitaires (traitements/an)','Usage antibiotiques (traitements/UGB/an)','Organisation de la vaccination','Gestion du parasitisme et recours aux coprologies','Gestion des traitements et respect des délais d’attente','Registre sanitaire et traçabilité des interventions','Gestion des animaux malades et possibilité d’isolement','Gestion des introductions et quarantaine','Statut sanitaire des animaux achetés','Gestion des cadavres et des déchets de soins','Plan de lutte contre les nuisibles','Relation et fréquence de suivi avec le vétérinaire sanitaire'
  ]},
  { id:'reproduction', title:'Reproduction et conduite du renouvellement', icon:'🐄', questions:[
    'Mode de mise à la reproduction','Période de mise à la reproduction','Méthode de détection des chaleurs','Fréquence et moments d’observation des chaleurs','Suivi des retours en chaleur','Diagnostics de gestation','Taux de gestation (%)','Veaux sevrés par vache (nb)','Gestion des vaches vides','Nombre de taureaux réellement utilisés à la reproduction','Âge / statut jeune ou adulte des taureaux','Contrôle de fertilité des taureaux','Organisation des lots de femelles à la reproduction','Nombre réel de femelles accessibles à chaque taureau','Durée de contact taureau-femelles','Plusieurs taureaux ensemble / rotation / un taureau par lot','IA puis rattrapage taureau / monte naturelle uniquement','Gestion des génisses de renouvellement à la reproduction','Préparation des animaux à la mise bas','Surveillance des vêlages','Gestion des délivrances et complications post-partum','Gestion et datation des avortements / mort-nés','Événements sanitaires ayant pu perturber la reproduction','Changements alimentaires / fourrages autour des périodes à problème','Âge moyen au premier vêlage','Intervalle vêlage-vêlage','Origine des génisses de renouvellement','Critères de sélection des génisses'
  ]},
  { id:'jeunes', title:'Soins aux jeunes et conduite des veaux', icon:'🐮', questions:[
    'Prise en charge du veau immédiatement après la naissance','Désinfection du nombril','Délai de distribution du colostrum','Contrôle de la qualité du colostrum','Quantité de colostrum distribuée','Traçabilité du colostrum et des soins','Mode de logement des veaux','Nettoyage et désinfection entre lots','Accès à l’eau et à l’aliment solide','Mode et âge de sevrage','Suivi de la croissance','Gestion des diarrhées et troubles respiratoires'
  ]},
  { id:'pratiques', title:'Pratiques d’élevage et conduite des lots', icon:'📋', questions:[
    'Organisation de l’allotement','Mode de pâturage','Gestion de l’estive','Transitions alimentaires','Organisation du tarissement','Préparation des mises bas','Gestion des animaux à risque ou fragiles','Fréquence d’observation du troupeau','Manipulations et contention','Parage et suivi des aplombs','Organisation des réformes','Répartition des tâches dans l’élevage'
  ]},
  { id:'fourrages', title:'Fourrages et cultures', icon:'🌾', questions:[
    'Type de sol des principales surfaces','Type de prairies','Pratique du sur-semis','Espèces semées dans les prairies temporaires ou sur-semis','Rotation des cultures et prairies','Fertilisation et amendements','Irrigation','Stade de récolte des fourrages','Hauteur de coupe','Qualité visuelle du foin','Matière sèche du foin','Méthode de réalisation du foin','Réalisation des ensilages','Tassement, bâchage et protection des silos','Réalisation de l’enrubannage','Stockage des fourrages','Analyses de fourrages disponibles','Gestion du front d’attaque et distribution'
  ]},
  { id:'organisation', title:'Organisation, travail et objectifs', icon:'👥', questions:[
    'Temps de travail et astreintes','Procédures pour les tâches sensibles','Transmission des informations entre intervenants','Suivi des actions décidées lors des visites précédentes','Indicateurs techniques consultés régulièrement','Documents et analyses facilement accessibles','Plan d’urgence et contacts disponibles'
  ]},
  { id:'partenaire', title:'Données technico-économiques / partenaire', icon:'💶', questions:[
    'Produits animaux lait + viande (€ / an)','Aides PAC totales (€ / an)','Prix du lait (€/1000 L)','Lait produit (L / an)','Prix moyen kg carcasse (€)','Total kg carcasse produits (kg / an)','Nombre moyen de vaches sur exercice','Charge aliments / concentrés (€ / an)','Charge minéraux (€ / an)','Frais vétérinaires honoraires + produits (€ / an)','Marge brute atelier élevage (€ / an)','SFP (ha)','Fertilisation (€ / an)','Semences (€ / an)','Traitements cultures (€ / an)','Travaux par tiers (€ / an)','Autres charges SFP bâches ficelles (€ / an)','EBE exploitation (€ / an)','Revenu disponible exploitation (€ / an)','Taux d’endettement (%)','Poids veaux au sevrage (kg)','GMQ jeunes bovins (g/j)','Âge moyen vente / abattage (jours)','Poids carcasse moyen broutards (kg)','Poids carcasse moyen génisses (kg)','Poids carcasse moyen réformes (kg)','Classement moyen des carcasses','Concentrés par vache (kg/an)','Autonomie fourragère (%)','Chargement (UGB/ha)','Consommation d’eau (L/animal/jour)','Kg viande/vache/an','Kg viande/ha','Concentrés/kg viande (kg/kg)'
  ]}
];


const plancheGroups = [
  { id:'animaux', icon:'🐄', title:'Animaux', subtitle:'NEC, remplissage du rumen, bouses, urines et aplombs.' },
  { id:'sang', icon:'🩸', title:'Sang & énergie', subtitle:'BOH, glycémie, urée et facteurs influençant énergie/azote.' },
  { id:'colostrum', icon:'🍼', title:'Colostrum & veaux', subtitle:'Brix colostral, protéines sériques et conduite à tenir.' },
  { id:'eau', icon:'💧', title:'Eau', subtitle:'Débit, pH, redox, conductivité, nitrates et température.' },
  { id:'fourrages', icon:'🌾', title:'Fourrages', subtitle:'Tamis à bouses, fibres et repères de conservation.' },
  { id:'nutrition', icon:'⚖️', title:'Nutrition', subtitle:'Énergie, protéines, équilibre énergie/azote et BACA.' },
  { id:'sol-plantes', icon:'🌱', title:'Sol et plantes', subtitle:'pH, redox, Brix, conductivité et repères de prélèvement.' },
  { id:'courants', icon:'⚡', title:'Électricité AC/DC', subtitle:'Schéma de mesure, sécurité, points de contrôle et erreurs.' },
  { id:'protocoles', icon:'📑', title:'Protocoles terrain', subtitle:'Check-lists eau, électricité, veaux, colostrum et alimentation.' },
  { id:'environnement', icon:'🏡', title:'Environnement & litière', subtitle:'Litière, ambiance et repères d’environnement.' },
  { id:'appareils', icon:'🔬', title:'Appareils', subtitle:'Modes d’emploi terrain des appareils de mesure.' }
];

let activePlanche = localStorage.getItem('audit-bovin-active-planche') || 'animaux';

const plancheAlias = {
  'Urines':'animaux','Sang':'animaux','Bouses':'animaux','Observations physiques':'animaux','Physique':'animaux',
  'Lait':'animaux','Colostrum':'animaux','Tamis':'fourrages','Tamis à bouses':'fourrages',
  'Silos':'fourrages','Silos / ensilages':'fourrages','Sol':'sol-plantes','Plantes':'sol-plantes','Plantes / herbe':'sol-plantes',
  'Eau':'eau','Abreuvoirs':'eau','Eau / abreuvoirs':'eau','Électricité':'courants','Courants électriques':'courants',
  'Plan bâtiment':'courants','Litière':'environnement','Environnement':'environnement','Alimentation':'nutrition','Nutrition':'nutrition','Énergie':'nutrition','Protéines':'nutrition','BACA':'nutrition','Fourrages':'fourrages','Audit global':'animaux'
};

function plancheTable(headers, rows) {
  return `<div class="table-wrap"><table class="planche-table"><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function plancheContent(id) {
  if (id === 'animaux') return `
    <section class="card planche-main">
      <h3>🐄 Repères visuels animaux</h3>
      <p class="muted">Planche synthétique : remplissage du rumen, aplombs, types de bouses et couleurs des urines.</p>
      <img class="planche-image" src="planches-visuelles.png" alt="Repères visuels animaux : rumen, aplombs, bouses et urines">
      <div class="planche-note"><strong>Lecture :</strong> toujours rattacher l’observation à la catégorie et au stade physiologique du sujet, puis la confronter aux autres mesures.</div>
      <h4 class="animal-memos-title">Mémos complémentaires</h4>
      <div class="memo-grid animal-memo-grid">
        <article class="memo-card"><h4>🐄 Score des aplombs</h4><button type="button" class="memo-image-button" data-library-image="memo-aplombs.jpeg" data-library-title="Score des aplombs"><img src="memo-aplombs.jpeg" alt="Mémo score des aplombs"></button><p>Repères visuels des scores 1, 2 et 3, avec exemples cagneux/panard.</p></article>
        <article class="memo-card"><h4>🍽️ SRR / remplissage du rumen selon la période</h4><button type="button" class="memo-image-button" data-library-image="memo-srr.jpeg" data-library-title="Frise SRR par période"><img src="memo-srr.jpeg" alt="Frise SRR par période"></button><p>Frise de repères autour du tarissement, du vêlage et de la lactation.</p></article>
        <article class="memo-card"><h4>⚖️ Note d’état corporel</h4><button type="button" class="memo-image-button" data-library-image="memo-nec.jpeg" data-library-title="Notation de l’état corporel"><img src="memo-nec.jpeg" alt="Mémo note d’état corporel"></button><p>Aide visuelle pour comparer les principaux repères anatomiques lors de la notation.</p></article>
      </div>
    </section>`;
  if (id === 'sang') return `
    <section class="card planche-main"><h3>🩸 Sang, énergie et azote</h3>
      <div class="planche-grid">
        <article><h4>BOH / BHB</h4><p><strong>À retenir :</strong> corps cétonique qui augmente lorsque l'animal mobilise ses réserves graisseuses.</p><ul><li>Toujours croiser avec glycémie, NEC, ingestion, stade physiologique et remplissage ruminal.</li><li>Une valeur isolée ne suffit pas à conclure.</li><li>Noter l'heure, le délai depuis le repas et le contexte clinique.</li></ul></article>
        <article><h4>Ce qui influence l'énergie</h4><ul><li>Ingestion réelle et accès à l'auge.</li><li>Densité énergétique et digestibilité.</li><li>Transition alimentaire et tri.</li><li>Lactation, gestation, croissance, froid/chaleur.</li><li>Douleur, inflammation, parasitisme, stress.</li><li>Accès à l'eau.</li></ul></article>
        <article><h4>Ce qui influence l'azote / urée</h4><ul><li>Quantité et dégradabilité des protéines.</li><li>Synchronisation avec l'énergie fermentescible.</li><li>Ingestion, transit, hydratation.</li><li>Qualité des fourrages et stade physiologique.</li><li>Fonction rénale et état sanitaire.</li></ul></article>
      </div>
      <div class="planche-warning">Ne pas résumer « urée haute = trop de protéines » : vérifier l'énergie disponible, l'ingestion, l'eau et le contexte.</div>
    </section>`;
  if (id === 'colostrum') return `
    <section class="card planche-main"><h3>🍼 Colostrum et transfert d'immunité</h3>
      ${plancheTable(['Mesure','Lecture pratique','Conseil terrain'],[
        ['Brix colostrum ≥ 22 %','Bonne qualité pour le premier repas','Distribuer rapidement et tracer quantité/heure.'],
        ['Brix 18 à 21,9 %','Qualité intermédiaire','Compléter avec un colostrum de meilleure qualité ou un produit adapté.'],
        ['Brix < 18 %','Qualité faible','Ne pas utiliser seul pour le premier repas.'],
        ['Protéines sériques ≥ 6,2 g/dL','Transfert excellent à l’échelle du lot','Maintenir le protocole et contrôler plusieurs veaux.'],
        ['5,8 à 6,1 g/dL','Bon','Poursuivre la surveillance.'],
        ['5,1 à 5,7 g/dL','Intermédiaire','Revoir délai, quantité, qualité et hygiène.'],
        ['< 5,1 g/dL','Transfert faible / risque accru','Auditer rapidement la conduite colostrale ; ce n’est pas une preuve d’infection.']
      ])}
      <div class="planche-grid"><article><h4>Premier repas</h4><ul><li>Le plus tôt possible après la naissance.</li><li>Mesurer la qualité avant distribution.</li><li>Noter heure et quantité réellement bues.</li><li>Prévoir une banque de colostrum congelé identifié.</li></ul></article><article><h4>Complément</h4><ul><li>Un sachet n'apporte pas toujours la même quantité d'IgG.</li><li>Lire l'étiquette : supplément ou substitut complet.</li><li>Calculer selon la teneur en IgG et le poids du veau.</li></ul></article></div>
    </section>`;
  if (id === 'eau') return `
    <section class="card planche-main"><h3>💧 Eau et abreuvement</h3>
      ${plancheTable(['Point à contrôler','Ce qu’il faut noter','Vigilance terrain'],[
        ['Débit','L/min mesurés au point d’eau','Mesurer réellement, ne pas se fier au débit théorique.'],
        ['Hauteur / accessibilité','Hauteur, position, concurrence','Observer si tous les animaux peuvent boire facilement.'],
        ['pH','Valeur et lieu de prélèvement','Interpréter avec l’origine et le réseau de distribution.'],
        ['Redox','Valeur, appareil et conditions','Comparer des mesures réalisées dans des conditions identiques.'],
        ['Conductivité','Valeur et unité','Noter l’unité et l’appareil utilisé.'],
        ['Nitrates','Résultat d’analyse','Conserver la date et le laboratoire.'],
        ['Température','°C au moment du contrôle','Noter la saison et le point de mesure.']
      ])}
      <div class="planche-note">Les seuils précis restent ceux validés dans le moteur d’analyse et dépendent du contexte de l’élevage.</div>
    </section>`;
  if (id === 'fourrages') return `
    <section class="card planche-main"><h3>🌾 Fourrages et tamis</h3>
      <div class="planche-grid">
        <article><h4>Tamis à bouses</h4><ol><li>Prélever un mélange représentatif du lot.</li><li>Peser le poids total.</li><li>Peser chaque fraction retenue.</li><li>Laisser l’application calculer les pourcentages.</li></ol></article>
        <article><h4>Foin / ensilage / enrubannage</h4><ul><li>Aspect, odeur, échauffement et moisissures.</li><li>Stade et hauteur de récolte.</li><li>Conditionnement, conservateur et stockage.</li><li>Noter la matière sèche si disponible.</li></ul></article>
        <article><h4>Fibres</h4><ul><li>Observer la longueur et l’homogénéité.</li><li>Comparer la ration distribuée, les refus et les bouses.</li><li>Une observation isolée ne suffit pas.</li></ul></article>
      </div>
    </section>`;
  if (id === 'nutrition') return `
    <section class="card planche-main"><h3>⚖️ Équilibre énergie / protéines</h3>
      <div class="planche-grid">
        <article><h4>🟠 Énergie : le carburant</h4><p>Elle couvre l’entretien, la thermorégulation, la croissance, la gestation et la production de lait.</p><ul><li><strong>Déficit :</strong> amaigrissement, baisse de lait, BOH élevé, cétose, reproduction retardée.</li><li><strong>Excès ou énergie trop rapide :</strong> engraissement, acidose, tri et baisse d’ingestion.</li><li><strong>Sources :</strong> maïs ensilage ou grain, céréales, pulpes, mélasse, betteraves, herbe jeune.</li></ul></article>
        <article><h4>🔵 Protéines : les briques</h4><p>Elles alimentent les microbes du rumen et fournissent les acides aminés nécessaires aux tissus, à la croissance et au lait.</p><ul><li><strong>Déficit :</strong> baisse de croissance ou de production, ingestion et taux protéique parfois faibles.</li><li><strong>Excès mal valorisé :</strong> urée élevée, pertes d’azote, coût inutile et charge métabolique.</li><li><strong>Sources :</strong> herbe et légumineuses, luzerne, trèfle, tourteaux de soja, colza ou tournesol.</li></ul></article>
        <article><h4>🟢 Pourquoi les équilibrer ?</h4><p>Les microbes du rumen ont besoin d’azote et d’énergie fermentescible disponibles au même moment.</p><ul><li>Protéines sans énergie suffisante : azote moins bien valorisé, urée potentiellement élevée.</li><li>Énergie sans azote suffisant : activité microbienne et digestion des fibres limitées.</li><li>Le bon aliment est celui qui complète la ration et non celui qui est simplement le plus riche.</li></ul></article>
      </div>
      ${plancheTable(['Aliment','Apport dominant','Repère pratique'],[
        ['Maïs ensilage','Énergie + amidon','Énergétique, mais relativement pauvre en protéines.'],
        ['Céréales : maïs, orge, blé','Énergie rapidement fermentescible','À sécuriser par les fibres et une distribution adaptée.'],
        ['Pulpes / betteraves','Énergie digestible','Énergie moins amidonnée, selon la présentation.'],
        ['Herbe jeune / ensilage d’herbe','Protéines + énergie','Valeur très dépendante du stade et de la conservation.'],
        ['Foin précoce','Fibres + valeur alimentaire','Plus riche et digestible qu’un foin récolté tardivement.'],
        ['Foin tardif / paille','Fibres','Valeur énergétique et protéique faible ; rôle surtout structural.'],
        ['Luzerne / trèfle','Protéines + calcium','Souvent riches en potassium : vigilance chez les taries.'],
        ['Tourteau de soja','Protéines concentrées','Correcteur protéique très riche.'],
        ['Tourteau de colza','Protéines','Correcteur protéique avec profil différent du soja.'],
        ['Mélasse / sucres','Énergie fermentescible','À raisonner avec l’ensemble des sucres et amidons.']
      ])}
      <div class="planche-note"><strong>Lecture terrain :</strong> croiser la ration réellement ingérée avec NEC, remplissage ruminal, tri, bouses, glycémie, BOH et urée. Une seule mesure ne permet pas de conclure.</div>
    </section>
    <section class="card planche-main"><h3>🧂 BACA – bilan alimentaire cations-anions</h3>
      <p>La BACA traduit l’équilibre entre les ions principalement alcalinisants (<strong>sodium et potassium</strong>) et acidifiants (<strong>chlore et soufre</strong>) de la ration. Elle s’exprime généralement en mEq/kg de matière sèche.</p>
      <div class="planche-grid">
        <article><h4>BACA élevée</h4><ul><li>Souvent liée à des fourrages riches en potassium.</li><li>Peut limiter l’efficacité de la mobilisation du calcium autour du vêlage.</li><li>Herbe jeune, luzerne et parcelles fortement fertilisées peuvent l’augmenter.</li></ul></article>
        <article><h4>BACA abaissée chez les taries</h4><ul><li>Utilisée durant la préparation au vêlage selon un protocole maîtrisé.</li><li>Favorise l’adaptation du métabolisme calcique.</li><li>Doit être contrôlée par la ration, les analyses minérales et le pH urinaire.</li></ul></article>
        <article><h4>Vigilances</h4><ul><li>Ne pas ajouter des sels anioniques sans calcul de ration.</li><li>Vérifier ingestion, appétence, magnésium et apport calcique.</li><li>Interpréter le pH urinaire selon l’espèce, la ration et le protocole retenu.</li></ul></article>
      </div>
      <div class="planche-warning">La BACA est surtout un outil de prévention autour du vêlage. Toute correction importante doit être validée avec le nutritionniste ou le vétérinaire de l’élevage.</div>
      <div class="planche-note"><strong>Formule courante :</strong> BACA = (Na × 43,5 + K × 25,6) − (Cl × 28,2 + S × 62,5), avec les éléments exprimés en % de matière sèche. Vérifier cependant la formule et les unités utilisées par le laboratoire.</div>
    </section>`;
  if (id === 'sol-plantes') return `
    <section class="card planche-main"><h3>🌱 Sol et plantes</h3>
      ${plancheTable(['Mesure','À renseigner','Conditions à noter'],[
        ['Sol – pH','Valeur par parcelle / zone','Humidité, profondeur et méthode.'],
        ['Sol – redox','Valeur et unité','État du sol, météo récente et heure.'],
        ['Plantes – Brix','Valeur par prélèvement','Espèce, stade, heure et météo.'],
        ['Plantes – pH / redox','Valeurs et appareil','Méthode de préparation de l’échantillon.'],
        ['Minéraux / nitrates','K, Ca, Na, nitrates si mesurés','Unité et laboratoire / appareil.']
      ])}
      <div class="planche-note">Comparer uniquement des prélèvements réalisés avec une méthode et des conditions suffisamment proches.</div>
    </section>`;
  if (id === 'courants') return `
    <section class="card planche-main"><h3>⚡ Mesure des courants parasites</h3>
      <div class="electric-schema"><svg viewBox="0 0 760 230" role="img" aria-label="Schéma simplifié mesure électrique abreuvoir sol"><rect x="35" y="55" width="220" height="95" rx="16" fill="#dbeef5" stroke="#39748c" stroke-width="3"/><text x="145" y="105" text-anchor="middle" font-size="22" fill="#244d60">Abreuvoir / métal</text><circle cx="300" cy="102" r="10" fill="#d43e58"/><line x1="255" y1="102" x2="300" y2="102" stroke="#d43e58" stroke-width="5"/><rect x="325" y="45" width="150" height="115" rx="14" fill="#fff" stroke="#b53670" stroke-width="4"/><text x="400" y="85" text-anchor="middle" font-size="20">Multimètre</text><text x="400" y="118" text-anchor="middle" font-size="24" font-weight="700" fill="#b53670">mV AC</text><circle cx="500" cy="102" r="10" fill="#222"/><line x1="475" y1="102" x2="620" y2="180" stroke="#222" stroke-width="5"/><line x1="40" y1="190" x2="720" y2="190" stroke="#7b6758" stroke-width="8"/><line x1="620" y1="180" x2="620" y2="200" stroke="#222" stroke-width="8"/><text x="635" y="220" font-size="18">Sol humide / référence</text><text x="280" y="35" font-size="16" fill="#d43e58">Pointe rouge</text><text x="500" y="35" font-size="16">Pointe noire</text></svg></div>
      <div class="planche-note"><strong>AC :</strong> courant alternatif, à tester en premier pour une recherche liée au réseau. <strong>DC :</strong> courant continu, à utiliser si le contexte le justifie (batterie, alimentation électronique, installation spécifique).</div>
      <div class="planche-grid">
        <article><h4>Où mesurer ?</h4><ul><li>Abreuvoirs.</li><li>Cornadis et barrières.</li><li>Équipements métalliques accessibles aux animaux.</li><li>Points signalés sur le plan du bâtiment.</li></ul></article>
        <article><h4>Comment noter ?</h4><ul><li>Emplacement exact.</li><li>AC ou DC.</li><li>Unité affichée par l’appareil.</li><li>Conditions de mesure et correction éventuelle.</li></ul></article>
        <article><h4>Après correction</h4><ul><li>Refaire la mesure au même point.</li><li>Conserver la valeur avant / après.</li><li>Relier la mesure à l’objet du plan.</li></ul></article>
      </div>
      <div class="planche-warning">Ne jamais improviser une intervention électrique : la recherche de cause et les travaux relèvent d’un professionnel compétent.</div>
    </section>`;
  if (id === 'protocoles') return `
    <section class="card planche-main"><h3>📑 Protocoles GDS – check-lists terrain</h3>
      <details open><summary><strong>💧 Audit eau</strong></summary><ol><li>Recenser origine et réseau.</li><li>Compter les points d'eau et observer la concurrence.</li><li>Mesurer réellement le débit.</li><li>Contrôler propreté, hauteur et accessibilité.</li><li>Noter température, pH/redox et analyses disponibles.</li><li>Photographier les anomalies et prévoir le recontrôle.</li></ol></details>
      <details><summary><strong>⚡ Audit électrique</strong></summary><ol><li>Sécuriser la zone et identifier le point de référence.</li><li>Commencer en mV AC.</li><li>Mesurer eau/métal vers sol humide ou référence adaptée.</li><li>Répéter appareils en marche puis arrêtés.</li><li>Noter emplacement, unité, AC/DC et conditions.</li><li>Faire intervenir un professionnel pour la recherche de cause/travaux.</li></ol></details>
      <details><summary><strong>🍼 Audit colostrum / veaux</strong></summary><ol><li>Mesurer le Brix du colostrum avant distribution.</li><li>Tracer heure et quantité.</li><li>Contrôler hygiène du matériel et stockage.</li><li>Échantillonner plusieurs veaux pour le transfert passif.</li><li>Croiser avec diarrhées, mortalité, logement et ventilation.</li></ol></details>
      <details><summary><strong>🍽️ Audit alimentation</strong></summary><ol><li>Décrire la ration réellement distribuée.</li><li>Observer mélange, tri, refus et accès à l'auge.</li><li>Contrôler transition, eau, sel et minéral.</li><li>Réaliser tamis/observations bouses si pertinent.</li><li>Croiser avec NEC, rumen, BOH, glycémie et urée.</li></ol></details>
      <details><summary><strong>🐄 Audit reproduction</strong></summary><ol><li>IVV et âge au premier vêlage.</li><li>Vaches vides et délai de décision.</li><li>Suivi chaleurs, diagnostics et périodes de reproduction.</li><li>Renouvellement et motifs de réforme.</li><li>Croiser avec NEC, énergie, sanitaire et conduite des lots.</li></ol></details>
    </section>`;
  if (id === 'environnement') return `
    <section class="card planche-main"><h3>🏡 Environnement & litière</h3>
      <div class="planche-grid"><article><h4>Litière</h4><ul><li>Observer humidité, propreté, odeur, échauffement et confort.</li><li>Relier l’état de la litière à la ventilation, au paillage et à la densité animale.</li><li>Noter le contexte et les mesures réalisées le jour de la visite.</li></ul></article><article><h4>Ambiance</h4><ul><li>Ventilation, courants d’air, condensation et zones humides.</li><li>Confort de couchage et accessibilité.</li><li>Croiser avec les observations sanitaires du troupeau.</li></ul></article></div>
    </section>`;
  return `
    <section class="card planche-main"><h3>🔬 Appareils de terrain</h3>
      ${plancheTable(['Appareil','Avant mesure','Après mesure'],[
        ['pH-mètre','Étalonnage adapté, sonde rincée, solution non périmée.','Rincer, sécher sans frotter agressivement, stocker selon la notice.'],
        ['Redox','Vérifier la sonde et la stabilité de lecture.','Rincer et conserver la méthode de mesure.'],
        ['Réfractomètre / Brix','Nettoyer le prisme et vérifier le zéro.','Nettoyer immédiatement sans rayer.'],
        ['Laquatwin','Utiliser la solution d’étalonnage prévue et remplir correctement le capteur.','Rincer le capteur sans l’endommager.'],
        ['Lecteur glycémie / BOH','Bonne bandelette, péremption et goutte suffisante.','Jeter la bandelette, nettoyer l’extérieur du lecteur.'],
        ['Lysun / autre appareil','Suivre le mode opératoire validé pour l’appareil.','Noter tout code erreur et contrôler les consommables.']
      ])}
      <div class="planche-note">Ces rappels ne remplacent pas la notice du fabricant ni les fiches de procédure internes.</div>
    </section>`;
}


const libraryPdfCatalog = [
  {groups:['protocoles'],kind:'Fiche thématique complète',title:'Approche globale & protocole',file:'theme-approche-globale.pdf',thumb:'theme-approche-globale.jpg',note:'Repères + visuels/mémo terrain.'},
  {groups:['animaux'],kind:'Fiche thématique complète',title:'Observation du troupeau & hydratation',file:'theme-observation-troupeau.pdf',thumb:'theme-observation-troupeau.jpg',note:'Observation adultes/veaux, températures et signes pratiques de déshydratation.'},
  {groups:['animaux','eau'],kind:'Fiche thématique complète',title:'Urines & pilotage de l’hydratation',file:'theme-urines.pdf',thumb:'theme-urines.jpg',note:'pH, densité, Brix, Redox, échantillonnage et suivi de l’hydratation.'},
  {groups:['sang'],kind:'Fiche thématique complète',title:'Sang',file:'theme-sang.pdf',thumb:'theme-sang.jpg',note:'Glycémie, BOH et interprétation rapide.'},
  {groups:['fourrages'],kind:'Fiche thématique complète',title:'Fèces & digestion',file:'theme-feces-digestion.pdf',thumb:'theme-feces-digestion.jpg',note:'Observation, pH/Redox et tamisage.'},
  {groups:['eau','courants','animaux'],kind:'Fiche thématique complète',title:'Eau, abreuvement & courants parasites',file:'theme-eau-abreuvement.pdf',thumb:'theme-eau-abreuvement.jpg',note:'Besoins en eau, accessibilité, types d’abreuvoirs, qualité de l’eau et tensions parasites.'},
  {groups:['eau','animaux','courants','protocoles'],kind:'Fiche complète enrichie',title:'Hydratation des ruminants en bâtiment',file:'theme-hydratation-ruminants.pdf',note:'Synthèse GDS 32-65 : signes de déshydratation, urines, besoins, accès à l’eau, qualité et courants parasites.'},
  {groups:['eau','animaux','courants','protocoles'],kind:'Référence technique',title:'Clim’Alim 2026 – Améliorer l’hydratation des ruminants en bâtiment',file:'reference-climalim-hydratation-2026.pdf',note:'Livret technique original complet intégré pour consultation hors ligne.'},
  {groups:['colostrum'],kind:'Fiche thématique complète',title:'Lait, colostrum & veaux',file:'theme-lait-colostrum-veaux.pdf',thumb:'theme-lait-colostrum-veaux.jpg',note:'Colostrum, transfert et conduite des veaux.'},
  {groups:['sol-plantes'],kind:'Fiche thématique complète',title:'Sol',file:'theme-sol.pdf',thumb:'theme-sol.jpg',note:'Repères et mesures du sol.'},
  {groups:['sol-plantes'],kind:'Fiche thématique complète',title:'Plantes, pâturage & herbe',file:'theme-plantes-paturage.pdf',thumb:'theme-plantes-paturage.jpg',note:'Repères plante/herbe et contexte de prélèvement.'},
  {groups:['fourrages','nutrition'],kind:'Fiche thématique complète',title:'Fourrages & alimentation',file:'theme-fourrages-alimentation.pdf',thumb:'theme-fourrages-alimentation.jpg',note:'Fourrages, ration et interprétation terrain.'},
  {groups:['protocoles','appareils'],kind:'Fiche thématique complète',title:'Outils, étalonnage & prélèvements',file:'theme-outils-prelevements.pdf',thumb:'theme-outils-prelevements.jpg',note:'Bonnes pratiques de mesure et prélèvement.'},
  {groups:['environnement'],kind:'Fiche thématique complète',title:'Litière & environnement',file:'theme-litiere-environnement.pdf',thumb:'theme-litiere-environnement.jpg',note:'Litière, ambiance et environnement.'},

  {groups:['appareils'],kind:'Mode d’emploi',title:'LAQUAtwin 4M',file:'outil-laquatwin-4m.pdf',thumb:'outil-laquatwin-4m.jpg',note:'K+, Ca2+, NO3- et Na+.'},
  {groups:['appareils','sang'],kind:'Mode d’emploi',title:'LYSUN RFM101 - Urée',file:'outil-lysun-uree.pdf',thumb:'outil-lysun-uree.jpg',note:'Utilisation et interprétation rapide.'},
  {groups:['appareils','eau'],kind:'Mode d’emploi',title:'CONTROL TH - Dureté de l’eau',file:'outil-control-th.pdf',thumb:'outil-control-th.jpg',note:'Mesure de dureté de l’eau.'},
  {groups:['appareils','eau'],kind:'Mode d’emploi',title:'HANNA HI701 - Chlore libre',file:'outil-hanna-hi701.pdf',thumb:'outil-hanna-hi701.jpg',note:'Mesure du chlore libre.'},
  {groups:['appareils','sang'],kind:'Mode d’emploi',title:'FreeStyle Optium Neo H - Glycémie / BOH',file:'outil-freestyle-optium.pdf',thumb:'outil-freestyle-optium.jpg',note:'Glycémie, BOH et codes/lecture terrain.'},
  {groups:['appareils','eau','sol-plantes'],kind:'Mode d’emploi',title:'APERA PH5F - pH',file:'outil-apera-ph5f.pdf',thumb:'outil-apera-ph5f.jpg',note:'Mesure du pH et entretien.'},
  {groups:['appareils','eau','sol-plantes'],kind:'Mode d’emploi',title:'EXTECH PH100 ExStik - pH',file:'outil-extech-ph100.pdf',thumb:'outil-extech-ph100.jpg',note:'Mesure du pH et entretien.'},
  {groups:['appareils','eau','sol-plantes'],kind:'Mode d’emploi',title:'EXTECH RE300 ExStik - ORP / Redox',file:'outil-extech-re300.pdf',thumb:'outil-extech-re300.jpg',note:'ORP/Redox : utilisation terrain.'},
  {groups:['appareils','courants'],kind:'Mode d’emploi',title:'Multimètre - Tensions parasites',file:'outil-multimetre.pdf',thumb:'outil-multimetre.jpg',note:'Mesure des courants/tensions parasites en élevage.'}
];
function libraryPdfCardsHtml(groupId){
  const items=libraryPdfCatalog.filter(x=>x.groups.includes(groupId));
  if(!items.length)return '';
  return `<section class="card library-pdf-section"><div class="section-title"><div><h3>📚 Fiches pratiques du thème</h3><div class="muted">Fiches GDS 32-65 intégrées à l’application et disponibles hors ligne.</div></div><span class="badge autosave">${items.length} fiche(s)</span></div><div class="library-pdf-grid">${items.map(x=>`<article class="library-pdf-card"><div class="library-pdf-icon" aria-hidden="true">📄</div><div><span class="library-pdf-kind">${escapeHtml(x.kind)}</span><h4>${escapeHtml(x.title)}</h4><p>${escapeHtml(x.note)}</p><button type="button" class="btn small" data-library-pdf="${x.file}" data-library-pdf-title="${escapeHtml(x.title)}">Ouvrir la fiche PDF</button></div></article>`).join('')}</div></section>`;
}

function ensureLibraryNotebook(){
  db.libraryNotebook=db.libraryNotebook&&typeof db.libraryNotebook==='object'?db.libraryNotebook:{};
  db.libraryNotebook.notes=String(db.libraryNotebook.notes||'');
  db.libraryNotebook.info=String(db.libraryNotebook.info||'');
  db.libraryNotebook.photos=Array.isArray(db.libraryNotebook.photos)?db.libraryNotebook.photos:[];
  return db.libraryNotebook;
}
function libraryNotebookHtml(){
  const n=ensureLibraryNotebook();
  return `<section class="card library-notebook"><div class="section-title"><div><h3>📝 Mon carnet technique</h3><div class="muted">Notes personnelles, informations utiles et petites photos de repérage. Ces éléments sont sauvegardés avec la base.</div></div><span class="badge autosave">${n.photos.length} photo(s)</span></div><div class="grid cols-2"><div class="field"><label>Informations / repères à conserver</label><textarea id="library-info" placeholder="Ex. méthode utilisée, références internes, matériel, contacts…">${escapeHtml(n.info)}</textarea></div><div class="field"><label>Notes libres</label><textarea id="library-notes" placeholder="Notes techniques personnelles…">${escapeHtml(n.notes)}</textarea></div></div><div class="actions"><button class="btn" id="library-add-photo" type="button">📷 Ajouter une petite photo</button><input id="library-photo-input" type="file" accept="image/*" multiple hidden></div>${n.photos.length?`<div class="library-photo-grid">${n.photos.map(ph=>`<figure><button type="button" data-library-photo-open="${ph.id}"><img src="${ph.dataUrl}" alt="Photo du carnet technique"></button><textarea data-library-photo-comment="${ph.id}" rows="2" placeholder="Légende / information">${escapeHtml(ph.comment||'')}</textarea><button type="button" class="btn small danger" data-library-photo-delete="${ph.id}">Supprimer</button></figure>`).join('')}</div>`:'<div class="empty compact">Aucune photo ajoutée au carnet.</div>'}</section>`;
}
function openLibraryImage(src,title='Mémo'){const overlay=document.createElement('div');overlay.className='photo-overlay';overlay.innerHTML=`<div class="photo-viewer library-memo-viewer"><button class="photo-modal-close" aria-label="Fermer">×</button><strong>${escapeHtml(title)}</strong><img src="${src}" alt="${escapeHtml(title)}"></div>`;document.body.appendChild(overlay);overlay.onclick=e=>{if(e.target===overlay||e.target.closest('.photo-modal-close'))overlay.remove();};}

function openLibraryPdf(src,title='Fiche PDF'){
  const overlay=document.createElement('div');
  overlay.className='library-pdf-overlay';
  const previousOverflow=document.body.style.overflow;
  document.body.style.overflow='hidden';
  overlay.innerHTML=`<div class="library-pdf-viewer" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
    <div class="library-pdf-viewer-head">
      <strong>${escapeHtml(title)}</strong>
      <button type="button" class="library-pdf-close" aria-label="Fermer la fiche">✕ <span>Fermer</span></button>
    </div>
    <iframe class="library-pdf-frame" src="${src}#view=FitH" title="${escapeHtml(title)}"></iframe>
    <div class="library-pdf-viewer-foot">
      <button type="button" class="btn library-pdf-close-bottom">← Fermer la fiche</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const close=()=>{
    document.body.style.overflow=previousOverflow;
    document.removeEventListener('keydown',onKey);
    overlay.remove();
  };
  const onKey=e=>{if(e.key==='Escape')close();};
  document.addEventListener('keydown',onKey);
  overlay.querySelector('.library-pdf-close').onclick=close;
  overlay.querySelector('.library-pdf-close-bottom').onclick=close;
  overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
}

function bindLibraryNotebook(){
  const n=ensureLibraryNotebook();
  const saveText=()=>{n.info=document.getElementById('library-info')?.value||'';n.notes=document.getElementById('library-notes')?.value||'';saveDatabase(db);};
  document.getElementById('library-info')?.addEventListener('input',saveText);document.getElementById('library-notes')?.addEventListener('input',saveText);
  document.getElementById('library-add-photo')?.addEventListener('click',()=>document.getElementById('library-photo-input')?.click());
  document.getElementById('library-photo-input')?.addEventListener('change',async e=>{for(const file of [...(e.target.files||[])]){if(!file.type.startsWith('image/'))continue;try{const dataUrl=await photoFileToDataUrl(file);n.photos.unshift({id:uid('library-photo'),dataUrl,comment:'',createdAt:new Date().toISOString()});}catch(err){console.error(err);showToast('Une photo du carnet n’a pas pu être ajoutée.');}}saveDatabase(db);renderPlanches();});
  app.querySelectorAll('[data-library-photo-comment]').forEach(el=>el.oninput=()=>{const ph=n.photos.find(x=>x.id===el.dataset.libraryPhotoComment);if(ph){ph.comment=el.value;saveDatabase(db);}});
  app.querySelectorAll('[data-library-photo-delete]').forEach(b=>b.onclick=()=>{if(!confirm('Supprimer cette photo du carnet technique ?'))return;n.photos=n.photos.filter(x=>x.id!==b.dataset.libraryPhotoDelete);saveDatabase(db);renderPlanches();});
  app.querySelectorAll('[data-library-photo-open]').forEach(b=>b.onclick=()=>{const ph=n.photos.find(x=>x.id===b.dataset.libraryPhotoOpen);if(ph)openLibraryImage(ph.dataUrl,ph.comment||'Photo du carnet technique');});
  app.querySelectorAll('[data-library-image]').forEach(b=>b.onclick=()=>openLibraryImage(b.dataset.libraryImage,b.dataset.libraryTitle||'Mémo'));
  app.querySelectorAll('[data-library-pdf]').forEach(b=>b.onclick=()=>openLibraryPdf(b.dataset.libraryPdf,b.dataset.libraryPdfTitle||'Fiche PDF'));
}
function renderPlanches() {
  const selected = plancheGroups.find(x=>x.id===activePlanche) || plancheGroups[0];
  app.innerHTML = `<div class="section-title"><div><h2>Bibliothèque technique</h2><div class="muted">Repères visuels, fiches pratiques et carnet technique, disponibles hors ligne.</div></div><span class="badge autosave">v14.6.21.68</span></div>
    <div class="planche-layout">
      <nav class="planche-menu">${plancheGroups.map(g=>`<button class="planche-menu-btn ${g.id===selected.id?'active':''}" data-planche="${g.id}"><span>${g.icon}</span><span><strong>${escapeHtml(g.title)}</strong><small>${escapeHtml(g.subtitle)}</small></span></button>`).join('')}</nav>
      <div class="planche-content">${plancheContent(selected.id)}${libraryPdfCardsHtml(selected.id)}${libraryNotebookHtml()}</div>
    </div>`;
  app.querySelectorAll('[data-planche]').forEach(btn=>btn.onclick=()=>{
    activePlanche=btn.dataset.planche;
    localStorage.setItem('audit-bovin-active-planche',activePlanche);
    renderPlanches();
    window.scrollTo({top:0,behavior:'smooth'});
  });
  bindLibraryNotebook();
}

function openPlanche(theme) {
  activePlanche = plancheAlias[theme] || 'animaux';
  localStorage.setItem('audit-bovin-active-planche',activePlanche);
  currentView='planches';
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view==='planches'));
  renderPlanches();
  window.scrollTo({top:0,behavior:'smooth'});
}

function openLibraryTheme(theme){ openPlanche(theme); }

const measurementFamilies = [
  ['urine', 'Urines', '🟡'], ['blood', 'Sang', '🔴'], ['feces', 'Bouses', '🟤'],
  ['physical', 'Observations physiques', '🟢'], ['milk', 'Lait', '🔵'], ['colostrum', 'Colostrum', '🟣']
];

function migrateDatabase() {
  // Conserver une copie locale avant toute normalisation de structure.
  try {
    if (!localStorage.getItem('audit-bovin-v10-backup-before-10-7')) {
      localStorage.setItem('audit-bovin-v10-backup-before-10-7', JSON.stringify(db));
    }
  } catch (error) { console.warn('Sauvegarde de sécurité impossible', error); }

  const legacyKeys = ['nec','urineColor','urinePH','urineRedox','urineBrix','urineDensity','glucose','boh','bloodPH','urea','fecesPH','fecesRedox','milkPH','milkBrix','colostrumBrix','colostrumDensity','colostrumPH'];
  db.farms = Array.isArray(db.farms) ? db.farms : [];
  db.visits = Array.isArray(db.visits) ? db.visits : [];
  db.herdImports = Array.isArray(db.herdImports) ? db.herdImports : [];
  db.visits.forEach(visit => {
    visit.subjects = Array.isArray(visit.subjects) ? visit.subjects : [];
    visit.subjects.forEach(subject => {
      subject.measurements = subject.measurements && typeof subject.measurements === 'object' ? subject.measurements : {};
      const current = subject.measurements.analysis && typeof subject.measurements.analysis === 'object' ? subject.measurements.analysis : {};
      const candidates = [
        subject.analysis,
        subject.measurements.numeric,
        subject.measurements.values,
        subject.measurements,
        visit.analysisBySubject?.[subject.id],
        ...(Array.isArray(visit.analysisRecords) ? visit.analysisRecords.filter(r => [r.subjectId,r.animalId,r.id].includes(subject.id)).map(r => r.measurements || r.values || r) : [])
      ].filter(x => x && typeof x === 'object');
      candidates.forEach(source => legacyKeys.forEach(key => {
        if ((current[key] === undefined || current[key] === null || current[key] === '') && source[key] !== undefined && source[key] !== null && source[key] !== '') current[key] = source[key];
      }));
      subject.measurements.analysis = current;
      subject.measurements.observations = subject.measurements.observations && typeof subject.measurements.observations === 'object' ? subject.measurements.observations : {};
      subject.measurements.comments = subject.measurements.comments && typeof subject.measurements.comments === 'object' ? subject.measurements.comments : {};
    });
    visit.feeding = visit.feeding && typeof visit.feeding === 'object' ? visit.feeding : {};
    visit.feeding.rations = Array.isArray(visit.feeding.rations) ? visit.feeding.rations : [];
    visit.feeding.settings = visit.feeding.settings && typeof visit.feeding.settings === 'object' ? visit.feeding.settings : {};
    visit.feeding.history = Array.isArray(visit.feeding.history) ? visit.feeding.history : [];
    visit.feeding.nutrition = visit.feeding.nutrition && typeof visit.feeding.nutrition === 'object' ? visit.feeding.nutrition : {};
    visit.feeding.nutrition.forageAnalyses = Array.isArray(visit.feeding.nutrition.forageAnalyses) ? visit.feeding.nutrition.forageAnalyses : [];
    visit.feeding.nutrition.ration = visit.feeding.nutrition.ration && typeof visit.feeding.nutrition.ration === 'object' ? visit.feeding.nutrition.ration : {};
    visit.buildingAudits = visit.buildingAudits && typeof visit.buildingAudits === 'object' ? visit.buildingAudits : {};
    visit.auditGlobal = visit.auditGlobal && typeof visit.auditGlobal === 'object' ? visit.auditGlobal : { answers:{}, outlets:[], reforms:{}, renewal:{}, notes:'' };
    visit.auditGlobal.answers = visit.auditGlobal.answers && typeof visit.auditGlobal.answers === 'object' ? visit.auditGlobal.answers : {};
    visit.auditGlobal.outlets = Array.isArray(visit.auditGlobal.outlets) ? visit.auditGlobal.outlets : [];
    visit.auditGlobal.reforms = visit.auditGlobal.reforms && typeof visit.auditGlobal.reforms === 'object' ? visit.auditGlobal.reforms : {};
    visit.auditGlobal.renewal = visit.auditGlobal.renewal && typeof visit.auditGlobal.renewal === 'object' ? visit.auditGlobal.renewal : {};
    visit.photos = Array.isArray(visit.photos) ? visit.photos : [];
    visit.farmerQuestionnaires = Array.isArray(visit.farmerQuestionnaires) ? visit.farmerQuestionnaires : [];
    const linkedHerd = visit.auditGlobal?.importedHerdData;
    if (linkedHerd?.sourceId && !linkedHerd.snapshot) {
      const source = db.herdImports.find(x => x.id === linkedHerd.sourceId && (!x.farmId || x.farmId === visit.farmId));
      if (source) linkedHerd.snapshot = JSON.parse(JSON.stringify(source));
    }
    if (Array.isArray(visit.reproductionRegistry) && visit.reproductionRegistry.length) {
      visit.reproductionRegistrySource = visit.reproductionRegistrySource && typeof visit.reproductionRegistrySource === 'object' ? visit.reproductionRegistrySource : {};
      visit.reproductionRegistrySource.farmId = visit.farmId;
    }
  });
  db.farms.forEach(farm => {
    farm.buildings = Array.isArray(farm.buildings) ? farm.buildings : [];
    farm.documents = Array.isArray(farm.documents) ? farm.documents : [];
    farm.herdRegistry = Array.isArray(farm.herdRegistry) ? farm.herdRegistry : [];
    farm.buildings.forEach(building => {
      building.plan = building.plan && typeof building.plan === 'object' ? building.plan : { shapes: [] };
      building.plan.shapes = Array.isArray(building.plan.shapes) ? building.plan.shapes : [];
    });
  });
  if (activeVisitId && !db.visits.some(v => v.id === activeVisitId)) setActiveVisit('');
  saveDatabase(db);
}
migrateDatabase();

function showToast(message) {
  const node = document.getElementById('toast-template').content.firstElementChild.cloneNode(true);
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

function addJournal(visit, message) {
  visit.journal = Array.isArray(visit.journal) ? visit.journal : [];
  visit.journal.unshift({ at: new Date().toISOString(), message });
}

function setView(view) {
  currentView = view;
  window.__auditApplyPhaseForView?.(view);
  document.querySelectorAll('.nav-btn').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  render();
  app.focus({ preventScroll: true });
}

document.addEventListener('click', event => {
  const button = event.target.closest('.nav-btn[data-view]');
  if (!button) return;
  event.preventDefault();
  setView(button.dataset.view);
});

window.addEventListener('audit-bovin-cloud-merged',event=>{
  const previousVisitId=activeVisitId;
  // Les écrans de saisie lourde (dont les imports labo/OCR) ne doivent pas être
  // remplacés en plein travail : cela détachait l'objet visite pendant la lecture
  // du PDF et le document semblait reconnu puis disparaissait au rendu suivant.
  const noHotReload=new Set(['audit','visits','building','analysis','animals','feeding','questionnaires','herddata','metabolic','parasitism','waterlab']);
  if(noHotReload.has(currentView)){
    if(event.detail?.message)showToast(event.detail.message);
    return;
  }
  db=loadDatabase();
  if(previousVisitId&&db.visits.some(v=>v.id===previousVisitId))setActiveVisit(previousVisitId);
  else if(activeVisitId&&!db.visits.some(v=>v.id===activeVisitId))setActiveVisit('');
  applyPeerReviewDeepLink();
  render();
  if(event.detail?.message)showToast(event.detail.message);
});

function farmName(farmId) {
  return db.farms.find(farm => farm.id === farmId)?.name || 'Exploitation non renseignée';
}

function visitLabel(visit) {
  return `${farmName(visit.farmId)} — ${formatDate(visit.date)} — ${visit.type || 'Visite'}`;
}

function previousVisitFor(farmId, date, excludeId='') {
  return db.visits
    .filter(v => v.farmId === farmId && v.id !== excludeId && (v.date || '') < (date || '9999-12-31'))
    .sort((a,b) => (b.date || '').localeCompare(a.date || ''))[0] || null;
}
function followupSourceItems(previousVisit) {
  if (!previousVisit) return [];
  const c = previousVisit.visitConclusion || null;
  const items = [];
  (c?.priorities || []).filter(a => String(a.text || '').trim() && a.decision !== 'Refusée').forEach((a, i) => items.push({
    id: uid('review'), kind: 'priority', label: String(a.text).trim(), source: a.source || `Action ${i+1}`,
    previousDecision: a.decision || '', previousComment: a.comment || '', status: 'À vérifier', comment: '', completedDate: ''
  }));
  splitUsefulLines(c?.next || '').forEach(text => items.push({
    id: uid('review'), kind: 'check', label: text, source: 'À vérifier lors de la prochaine visite',
    previousDecision: '', previousComment: '', status: 'À vérifier', comment: '', completedDate: ''
  }));
  return uniqueText(items.map(x => x.label)).map(label => items.find(x => x.label === label));
}
function ensurePreviousVisitReview(visit) {
  if (visit.previousVisitReview) return visit.previousVisitReview;
  const previous = previousVisitFor(visit.farmId, visit.date, visit.id);
  visit.previousVisitReview = {
    previousVisitId: previous?.id || '', previousVisitDate: previous?.date || '',
    items: followupSourceItems(previous), generalComment: '', completedAt: '', updatedAt: new Date().toISOString()
  };
  return visit.previousVisitReview;
}
function renderPreviousVisitReview(visit) {
  const review = ensurePreviousVisitReview(visit);
  const previous = db.visits.find(v => v.id === review.previousVisitId);
  if (!previous) return `<section class="card notice" style="margin-top:16px"><strong>Première visite enregistrée pour cette exploitation.</strong><br><span class="muted">Aucune priorité antérieure à contrôler.</span></section>`;
  const done = review.items.filter(i => i.status === 'Réalisée').length;
  const partial = review.items.filter(i => i.status === 'Partiellement réalisée').length;
  const pending = review.items.filter(i => ['Non réalisée','À vérifier'].includes(i.status)).length;
  return `<section class="card previous-review-card" style="margin-top:16px">
    <div class="section-title"><div><h3>✅ Démarrage de la visite : suivi de la visite précédente</h3><span class="muted">Visite du ${formatDate(previous.date)} · vérifiez avec l’éleveur ce qui a réellement été mis en place.</span></div><span class="badge ${pending ? 'in-progress' : 'complete'}">${done}/${review.items.length} réalisée(s)</span></div>
    ${review.items.length ? `<div class="previous-review-list">${review.items.map((item,i)=>`<article class="previous-review-item"><div class="review-number">${i+1}</div><div class="review-main"><strong>${escapeHtml(item.label)}</strong>${item.source?`<small>${escapeHtml(item.source)}</small>`:''}${item.previousComment?`<div class="muted small-text">Commentaire précédent : ${escapeHtml(item.previousComment)}</div>`:''}<div class="row"><div class="field"><label>État constaté</label><select data-review-field="status" data-review-id="${item.id}">${['À vérifier','Réalisée','Partiellement réalisée','Non réalisée','Abandonnée / devenue inutile'].map(v=>`<option ${item.status===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Date de réalisation</label><input type="date" data-review-field="completedDate" data-review-id="${item.id}" value="${escapeHtml(item.completedDate||'')}"></div></div><div class="field"><label>Commentaire / changement observé</label><textarea rows="2" data-review-field="comment" data-review-id="${item.id}">${escapeHtml(item.comment||'')}</textarea></div></div></article>`).join('')}</div>` : '<div class="empty">Aucune action ou vérification n’avait été enregistrée dans la visite précédente.</div>'}
    <div class="grid cols-2 review-summary"><article class="notice positive"><strong>${done} réalisée(s)</strong><br><span class="muted">${partial} partiellement réalisée(s)</span></article><article class="notice warning"><strong>${pending} restant à vérifier ou non réalisée(s)</strong><br><span class="muted">Les éléments inachevés peuvent être repris dans le nouveau plan d’action.</span></article></div>
    <div class="field"><label>Bilan général depuis la visite précédente</label><textarea rows="4" id="previous-review-general">${escapeHtml(review.generalComment||'')}</textarea></div>
    <div class="actions"><button class="btn primary" id="validate-previous-review">Valider le point de départ</button><button class="btn secondary" id="carry-unfinished-actions">Reprendre les actions inachevées dans la conclusion</button></div>
  </section>`;
}
function bindPreviousVisitReview(visit) {
  const review = ensurePreviousVisitReview(visit);
  app.querySelectorAll('[data-review-field]').forEach(el => {
    const save = () => { const item=review.items.find(i=>i.id===el.dataset.reviewId); if(!item)return; item[el.dataset.reviewField]=el.value; review.updatedAt=new Date().toISOString(); visit.updatedAt=review.updatedAt; saveDatabase(db); };
    el.onchange=save; el.oninput=save;
  });
  const general=document.getElementById('previous-review-general'); if(general)general.oninput=()=>{review.generalComment=general.value;review.updatedAt=new Date().toISOString();saveDatabase(db);};
  const validate=document.getElementById('validate-previous-review'); if(validate)validate.onclick=()=>{review.completedAt=new Date().toISOString();addJournal(visit,'Suivi des actions de la visite précédente vérifié.');saveDatabase(db);showToast('Suivi de la visite précédente enregistré.');renderVisits();};
  const carry=document.getElementById('carry-unfinished-actions'); if(carry)carry.onclick=()=>{const unfinished=review.items.filter(i=>['À vérifier','Partiellement réalisée','Non réalisée'].includes(i.status));const c=ensureVisitConclusion(visit);unfinished.forEach(item=>{if(!c.priorities.some(a=>String(a.text||'').trim().toLowerCase()===item.label.toLowerCase()))c.priorities.push({text:item.label,source:'Reprise de la visite précédente',decision:'À étudier',comment:item.comment||''});});c.priorities=c.priorities.filter(a=>a.text).slice(0,6);while(c.priorities.length<3)c.priorities.push({text:'',source:'',decision:'À étudier',comment:''});saveDatabase(db);showToast(`${unfinished.length} action(s) reprise(s) dans la conclusion.`);};
}

function currentCollaboratorEmail(){try{return String(JSON.parse(localStorage.getItem('audit-bovin-supabase-session')||'null')?.user?.email||'').trim().toLowerCase();}catch(_){return '';}}
function collaborationPresenceForVisit(visitId){
  const now=Date.now(),me=currentCollaboratorEmail();
  return Object.entries(db.collaborationPresence||{}).map(([email,p])=>({email,...p})).filter(p=>p.visitId===visitId&&p.email!==me&&(now-Date.parse(p.seenAt||0))<120000);
}
function refreshVisitPresence(save=true){
  const email=currentCollaboratorEmail();if(!email)return;
  db.collaborationPresence=db.collaborationPresence||{};
  const now=Date.now();Object.keys(db.collaborationPresence).forEach(k=>{if(now-Date.parse(db.collaborationPresence[k]?.seenAt||0)>10*60*1000)delete db.collaborationPresence[k];});
  if(activeVisitId)db.collaborationPresence[email]={visitId:activeVisitId,seenAt:new Date().toISOString(),view:currentView||''};
  else delete db.collaborationPresence[email];
  if(save)saveDatabase(db);
}
function setActiveVisit(id) {
  activeVisitId = id || '';
  if (activeVisitId) localStorage.setItem('audit-bovin-active-visit', activeVisitId);
  else localStorage.removeItem('audit-bovin-active-visit');
  setTimeout(()=>refreshVisitPresence(true),0);
}
function activeVisit() { return db.visits.find(v => v.id === activeVisitId) || null; }
function renderNoActiveVisit(moduleName = 'ce module') {
  app.innerHTML = `<section class="card notice warning"><strong>Aucune visite active.</strong><br><span class="muted">${escapeHtml(moduleName)} doit être rattaché à une visite. Sur un nouvel appareil, créez une visite ou importez votre sauvegarde, puis ouvrez-la depuis l’onglet Visites.</span><div class="actions" style="margin-top:12px"><button class="btn primary" id="go-to-visits">Aller aux visites</button><button class="btn secondary" id="go-to-backup">Importer une sauvegarde</button></div></section>`;
  document.getElementById('go-to-visits')?.addEventListener('click', () => setView('visits'));
  document.getElementById('go-to-backup')?.addEventListener('click', () => setView('backup'));
}

function activeVisitBanner(visit) {
  if (!visit) return `<section class="card notice warning"><strong>Aucune visite active.</strong><br><span class="muted">Choisissez une visite dans l’onglet Visites.</span></section>`;
  const others=collaborationPresenceForVisit(visit.id);
  const presence=others.length?`<span class="visit-presence-warning">👥 Déjà ouverte par ${others.map(p=>escapeHtml((p.email||'').split('@')[0])).join(', ')}</span>`:`<span class="visit-presence-ok">✓ Aucun autre technicien détecté sur cette visite</span>`;
  return `<section class="card active-visit-banner"><div><span class="muted">Visite active — verrouillée pour la saisie</span><strong>${escapeHtml(visitLabel(visit))}</strong>${presence}</div><span class="badge complete">${visit.subjects?.length || 0} sujet(s)</span><span class="muted small-text">La visite ne peut être changée que depuis l’onglet Visites.</span></section>`;
}


function harmonizeActionButtons(root=document){
  root.querySelectorAll('.btn').forEach(button=>{
    const label=normalizedSearchText(button.textContent).trim();
    button.classList.remove('action-add','action-validate','action-export','action-warning');
    if(/^(supprimer|tout effacer|reinitialiser|retirer)/.test(label)){button.classList.add('danger');return;}
    if(/^(valider|enregistrer|confirmer|terminer|appliquer|completer|synchroniser)/.test(label)){button.classList.add('action-validate');return;}
    if(/^(exporter|telecharger|imprimer|pdf|word|partager)/.test(label)){button.classList.add('action-export');return;}
    if(/^(dupliquer|remplacer|reprendre|archiver)/.test(label)){button.classList.add('action-warning');return;}
    if(/^(ajouter|creer|nouvelle|nouveau|prendre une photo|choisir dans la galerie)/.test(label)){button.classList.add('action-add');}
  });
}

function render() {
  if(currentView!=='reproduction')closeReproDetailModal();
  const renderers = { dashboard: renderDashboard, farms: renderFarms, journal: renderJournalSuivi, documents: renderFarmDocuments, visits: renderVisits, questionnaires: renderFarmerQuestionnaires, prepprint: renderPreparationPrints, animals: renderAnimals, analysis: renderAnalysis, assistant: renderAssistantGDS, review: renderPeerReview, feeding: renderFeeding, nutrition: renderNutritionAnalysis, reproduction: renderReproduction, building: renderBuilding, audit: renderAuditGlobal, planches: renderPlanches, photos: renderPhotos, herddata: renderHerdData, metabolic: renderMetabolic, parasitism: renderParasitism, waterlab: renderWaterLab, references: renderReferenceSettings, followup: renderFollowup, checkout: renderEndVisitCheckup, study: renderStudyTracking, economy: renderEconomicProgress, pilotage: renderPilotageActions, reports: renderReports, backup: renderBackup };
  app.innerHTML = '';
  try {
    const renderer = renderers[currentView] || renderDashboard;
    renderer();
    harmonizeActionButtons(app);
    renderSmartLabImportCard(currentView,activeVisit());
  } catch (error) {
    console.error('Erreur de rendu', currentView, error);
    app.innerHTML = `<section class="card notice warning"><strong>Le module n’a pas pu s’afficher.</strong><br><span class="muted">${escapeHtml(error?.message || String(error))}</span><div class="actions" style="margin-top:12px"><button class="btn primary" id="return-dashboard-after-error">Retour à l’accueil</button></div></section>`;
    document.getElementById('return-dashboard-after-error')?.addEventListener('click',()=>setView('dashboard'));
  }
}


function visitProfessionalStats(visit){
  if(!visit)return {completion:0,anomalies:0,measured:0,photos:0,actions:0,actionsDone:0,auditPct:0,pistes:[]};
  const subjects=visit.subjects||[],groups=categoryAnalysis(visit);
  const measured=subjects.filter(s=>Object.values(s.measurements?.analysis||{}).some(v=>numericValue(v)!==null)).length;
  const anomalies=groups.reduce((sum,g)=>sum+g.parameterResults.reduce((n,r)=>n+r.outOfRange,0),0);
  const a=ensureAuditGlobal(visit),auditPct=auditCompletion(a).pct;
  const actions=visit.analysisActions||[],actionsDone=actions.filter(x=>x.status==='Réalisé').length;
  const modules=[
    subjects.length>0,
    measured>0,
    (visit.feeding?.rations||[]).length>0,
    Object.keys(visit.buildingAudits||{}).length>0,
    auditPct>=50,
    !!visit.visitConclusion?.general,
    (visit.photos||[]).length>0
  ];
  const completion=Math.round((modules.filter(Boolean).length/modules.length)*100);
  const rawPistes=[];groups.forEach(g=>buildKnowledgePistes(visit,g).forEach(p=>{const state=reasoningState(visit,`${g.category}:${p.id}`);if(state.status!=='dismissed')rawPistes.push({...p,category:g.category,state});}));
  // Regrouper une même piste technique lorsqu'elle est retrouvée dans plusieurs catégories bovines.
  // La clé stable est l'id de la règle (et non le texte de confiance/les scores qui varient selon le lot).
  const groupedPistesMap=new Map();
  const confidenceRank={high:3,medium:2,low:1};
  rawPistes.forEach(p=>{
    const key=p.id||normalizeSearchText(p.title||'');
    const current=groupedPistesMap.get(key);
    if(!current){groupedPistesMap.set(key,{...p,categories:[p.category],category:p.category});return;}
    if(!current.categories.includes(p.category))current.categories.push(p.category);
    current.category=current.categories.join(' + ');
    // Pour l'ordre et le badge, conserver la version la mieux étayée parmi les catégories regroupées.
    const curRank=confidenceRank[current.confidence?.className]||0, nextRank=confidenceRank[p.confidence?.className]||0;
    if(nextRank>curRank || (nextRank===curRank && (p.score||0)>(current.score||0))){
      const cats=current.categories.slice();
      Object.assign(current,p);
      current.categories=cats;
      current.category=cats.join(' + ');
    }
  });
  const pistes=[...groupedPistesMap.values()];
  pistes.sort((a,b)=>(confidenceRank[b.confidence.className]||0)-(confidenceRank[a.confidence.className]||0)||b.score-a.score);
  return {completion,anomalies,measured,photos:(visit.photos||[]).length,actions:actions.length,actionsDone,auditPct,pistes};
}
function professionalAttentionItems(visit){
  if(!visit)return [];
  const s=visitProfessionalStats(visit),items=[];
  if(!(visit.subjects||[]).length)items.push({level:'warning',icon:'🐄',text:'Aucun sujet enregistré',view:'animals'});
  if(s.measured===0)items.push({level:'warning',icon:'🧪',text:'Aucune mesure numérique saisie',view:'analysis'});
  if(s.anomalies>0)items.push({level:'danger',icon:'⚠️',text:`${s.anomalies} valeur(s) hors référence à relire`,view:'analysis'});
  if(s.auditPct<70)items.push({level:'warning',icon:'📋',text:`Audit global complété à ${s.auditPct} %`,view:'audit'});
  if(!visit.visitConclusion?.general)items.push({level:'warning',icon:'✍️',text:'Conclusion de visite à valider',view:'analysis'});
  const pending=(visit.analysisActions||[]).filter(a=>a.status!=='Réalisé').length;if(pending)items.push({level:'info',icon:'🎯',text:`${pending} action(s) encore ouvertes`,view:'pilotage'});
  const today=new Date().toISOString().slice(0,10),overdue=(visit.analysisActions||[]).filter(a=>a.status!=='Réalisé'&&a.dueDate&&a.dueDate<today).length;if(overdue)items.unshift({level:'danger',icon:'⏰',text:`${overdue} action(s) en retard`,view:'pilotage'});
  if(!(visit.generatedReports||[]).length)items.push({level:'info',icon:'📄',text:'Aucun rapport généré',view:'reports'});
  items.push(...metabolicParasitismAttention(visit));
  return items;
}
function domainIndicators(visit){
  if(!visit)return [];
  const groups=categoryAnalysis(visit),a=ensureAuditGlobal(visit),build=buildingRecords(visit);
  const countOutside=keys=>groups.reduce((n,g)=>n+g.parameterResults.filter(r=>keys.includes(r.parameter.key)).reduce((s,r)=>s+r.outOfRange,0),0);
  const score=(base,penalty)=>Math.max(0,Math.min(100,Math.round(base-penalty)));
  const analysisBase=groups.length?85:20;
  return [
    {label:'Santé / analyses',icon:'🩺',value:score(analysisBase,countOutside(['glucose','boh','bloodPH','urea'])*4)},
    {label:'Digestion',icon:'🧪',value:score(analysisBase,countOutside(['fecesPH','fecesRedox'])*5)},
    {label:'Eau',icon:'💧',value:score(build.drinkers.length?90:30,build.drinkers.filter(d=>(numericValue(d.flow)||99)<10||['Moyenne','Insuffisante'].includes(d.accessibility)).length*15)},
    {label:'Bâtiment',icon:'🏠',value:score(Object.keys(visit.buildingAudits||{}).length?85:25,build.questionnaire.filter(q=>['À surveiller','À corriger'].includes(q.status)).length*5)},
    {label:'Alimentation',icon:'🌾',value:(visit.feeding?.rations||[]).length?80:25},
    {label:'Reproduction',icon:'📈',value:score(a.answers?.['Intervalle vêlage-vêlage']?.answer?80:35,auditAttentionCount(visit,'reproduction')*4)}
  ];
}
function renderProfessionalIndicators(visit){return `<div class="professional-score-grid">${domainIndicators(visit).map(x=>`<article class="professional-score-card"><span>${x.icon} ${escapeHtml(x.label)}</span><strong>${x.value}</strong><div class="professional-score-bar"><i style="width:${x.value}%"></i></div><small>Indice de suivi, non diagnostique</small></article>`).join('')}</div>`;}

function ensurePeerReview(visit){
  const r=visit.peerReview&&typeof visit.peerReview==='object'?visit.peerReview:{};
  r.reviewer=String(r.reviewer||''); r.general=String(r.general||''); r.validatedAt=String(r.validatedAt||'');
  r.cards=r.cards&&typeof r.cards==='object'?r.cards:{};
  r.request=r.request&&typeof r.request==='object'?r.request:{};
  r.request.email=String(r.request.email||'');
  r.request.status=String(r.request.status||'Non demandée');
  r.request.requestedAt=String(r.request.requestedAt||'');
  r.request.openedAt=String(r.request.openedAt||'');
  r.request.completedAt=String(r.request.completedAt||'');
  r.request.deadline=String(r.request.deadline||'');
  visit.peerReview=r; return r;
}
function peerReviewLink(visit){
  const u=new URL(window.location.href);
  u.searchParams.set('reviewVisit',visit.id);
  u.searchParams.set('reviewMode','1');
  u.hash='';
  return u.toString();
}
function peerReviewRequestStatusClass(v){return v==='Terminée'?'complete':v==='En cours'?'in-progress':v==='Demandée'?'warning':'archived';}
function peerReviewMailText(visit,review){
  const farm=farmName(visit.farmId),link=peerReviewLink(visit),deadline=review.request.deadline?`\nÉchéance souhaitée : ${formatDate(review.request.deadline)}`:'';
  const subject=`Demande de relecture — ${farm} — ${formatDate(visit.date)}`;
  const body=`Bonjour${review.reviewer?' '+review.reviewer:''},\n\nPeux-tu relire la visite bovine suivante ?\n\nExploitation : ${farm}\nDate de visite : ${formatDate(visit.date)}\nTechnicien : ${visit.technician||'Non renseigné'}${deadline}\n\nLien direct vers la relecture :\n${link}\n\nTu peux valider chaque thème, signaler les points à discuter ou à modifier, puis terminer la relecture dans l’application.\n\nMerci.`;
  return {subject,body,link};
}
function markPeerReviewRequested(visit,review,status='Demandée'){
  review.request.status=status;
  if(!review.request.requestedAt)review.request.requestedAt=new Date().toISOString();
  visit.updatedAt=new Date().toISOString();
  addJournal(visit,`Demande de relecture ${status.toLowerCase()}${review.reviewer?' pour '+review.reviewer:''}.`);
  saveDatabase(db);
}
function applyPeerReviewDeepLink(){
  const params=new URLSearchParams(window.location.search),id=params.get('reviewVisit');
  if(!id)return false;
  const visit=db.visits.find(v=>v.id===id); if(!visit)return false;
  setActiveVisit(id); currentView='review';
  document.body.classList.toggle('shared-review-mode',params.get('reviewMode')==='1');
  const review=ensurePeerReview(visit);
  if(review.request.status==='Demandée'){
    review.request.status='En cours'; review.request.openedAt=review.request.openedAt||new Date().toISOString(); visit.updatedAt=new Date().toISOString(); saveDatabase(db);
  }
  return true;
}
function peerReviewCardState(review,key){
  if(!review.cards[key])review.cards[key]={status:'À discuter',note:''};
  return review.cards[key];
}
function peerStatusClass(v){return v==='Validé'?'complete':v==='À modifier'?'in-progress':v==='À discuter'?'warning':'archived';}
function peerReviewCard(key,title,subtitle,body,review){
  const st=peerReviewCardState(review,key);
  return `<article class="card peer-review-card" data-peer-card="${escapeHtml(key)}"><div class="section-title"><div><h3>${title}</h3><span class="muted">${subtitle}</span></div><span class="badge ${peerStatusClass(st.status)}">${escapeHtml(st.status)}</span></div>${body}<div class="peer-review-controls"><div class="field"><label>Avis de relecture</label><select data-peer-status="${escapeHtml(key)}">${['Validé','À discuter','À modifier','Non revu'].map(v=>`<option ${st.status===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field peer-note"><label>Commentaire de la collègue</label><textarea rows="2" data-peer-note="${escapeHtml(key)}" placeholder="Point à discuter, précision, modification proposée…">${escapeHtml(st.note||'')}</textarea></div></div></article>`;
}
function peerInterpretationKey(item){return normalizeSearchText(`${item?.theme||''}|${item?.title||''}`)}
function groupedPeerInterpretations(groups){
  const byKey=new Map();
  for(const group of groups){for(const item of interpretationItems(group)){const key=peerInterpretationKey(item);if(!key)continue;const current=byKey.get(key)||{item,categories:[]};if(!current.categories.includes(group.category))current.categories.push(group.category);byKey.set(key,current)}}
  const common=[...byKey.entries()].filter(([,x])=>x.categories.length>=2);
  const commonKeys=new Set(common.map(([k])=>k));
  return {common:common.map(([,x])=>x),commonKeys};
}
function renderPeerReview(){
  const visit=activeVisit(); if(!visit){renderNoActiveVisit('la relecture de visite');return;}
  const review=ensurePeerReview(visit),stats=visitProfessionalStats(visit),groups=categoryAnalysis(visit),conclusion=ensureVisitConclusion(visit),audit=ensureAuditGlobal(visit),auditPct=auditCompletion(audit).pct;
  const cards=[],groupedInts=groupedPeerInterpretations(groups);
  if(groupedInts.common.length){const commonBody=`<div class="peer-interpretations"><h4>Tendances retrouvées dans plusieurs catégories</h4>${groupedInts.common.map(x=>`<div class="analysis-message ${x.item.level}"><strong>${escapeHtml(x.item.title)}</strong><span>${escapeHtml(x.item.text)}</span><small><b>Catégories concernées :</b> ${escapeHtml(x.categories.join(', '))}<br>Action proposée : ${escapeHtml(x.item.action)}</small></div>`).join('')}</div><p class="muted">Les interprétations identiques sont regroupées ici. Les cartes par catégorie ne conservent ensuite que leurs particularités.</p>`;cards.push(peerReviewCard('theme:cross-interpretations','🔗 Tendances communes',`${groupedInts.common.length} interprétation(s) recoupée(s)`,commonBody,review));}
  groups.forEach(group=>{
    const ints=interpretationItems(group).filter(i=>!groupedInts.commonKeys.has(peerInterpretationKey(i))), abnormal=group.parameterResults.filter(r=>r.outOfRange>0);
    const body=`<div class="peer-key-results">${abnormal.length?abnormal.slice(0,8).map(r=>`<div class="peer-result ${r.worst.result.status}"><strong>${escapeHtml(r.parameter.label)}</strong><span>Moy. ${r.average.toLocaleString('fr-FR',{maximumFractionDigits:2})} · ${r.outOfRange}/${r.measured.length} hors réf.</span><small>${escapeHtml(referenceText(r.rule))}</small></div>`).join(''):'<div class="notice positive"><strong>Aucune valeur hors référence détectée dans les paramètres exploitables.</strong></div>'}</div>${ints.length?`<div class="peer-interpretations"><h4>Interprétation automatique</h4>${ints.map(i=>`<div class="analysis-message ${i.level}"><strong>${escapeHtml(i.title)}</strong><span>${escapeHtml(i.text)}</span><small>Action proposée : ${escapeHtml(i.action)}</small></div>`).join('')}</div>`:''}<div class="peer-tech-conclusion"><strong>Conclusion du technicien</strong><p>${escapeHtml(visit.analysisConclusions?.[group.category]||'Aucune conclusion renseignée.').replace(/\n/g,'<br>')}</p></div>`;
    cards.push(peerReviewCard('cat:'+group.category,escapeHtml(group.category),`${group.subjects.length} sujet(s) · ${group.parameterResults.length} paramètre(s)`,body,review));
  });
  const feedRows=visit.feeding?.rations||visit.feeding||[];
  if(Array.isArray(feedRows)&&feedRows.length){cards.push(peerReviewCard('theme:feeding','🍽️ Alimentation',`${feedRows.length} ligne(s) de ration renseignée(s)`,`<div class="notice"><strong>Ration documentée.</strong><br><span class="muted">Utilisez ce point pour confronter ration observée, mesures et interprétation métabolique.</span></div>`,review));}
  const building=visit.building||{}; const buildingCount=(building.litters?.length||0)+(building.electric?.length||0)+(building.questionnaire?.length||0);
  if(buildingCount){cards.push(peerReviewCard('theme:building','🏠 Bâtiment',`${buildingCount} élément(s) renseigné(s)`,`<div class="notice"><strong>Points bâtiment disponibles.</strong><br><span class="muted">Relire ensemble litière, ambiance, électricité et questionnaire avant de valider les liens avec les résultats animaux.</span></div>`,review));}
  cards.push(peerReviewCard('theme:audit','📋 Audit global',`Avancement ${auditPct} %`,`<div class="progress-track large"><div style="width:${auditPct}%"></div></div><p class="muted">Les conclusions doivent tenir compte des réponses manquantes : une absence de donnée n’est pas une normalité.</p>`,review));
  const priorities=(conclusion.priorities||[]).filter(a=>String(a.text||'').trim());
  cards.push(peerReviewCard('theme:actions','🎯 Conclusion & plan d’action',`${priorities.length} priorité(s)`,`<div class="peer-actions">${priorities.length?priorities.map((a,i)=>`<div><strong>${i+1}. ${escapeHtml(a.text)}</strong><span>${escapeHtml(a.decision||'À étudier')}${a.comment?' · '+escapeHtml(a.comment):''}</span></div>`).join(''):'<div class="empty">Aucune priorité renseignée.</div>'}</div><div class="peer-tech-conclusion"><strong>Conclusion générale</strong><p>${escapeHtml(conclusion.general||'Aucune conclusion générale renseignée.').replace(/\n/g,'<br>')}</p></div>`,review));
  const reviewed=Object.values(review.cards).filter(x=>x.status==='Validé').length, flagged=Object.entries(review.cards).filter(([,x])=>x.status==='À discuter'||x.status==='À modifier');
  const req=review.request,reqStatus=req.status||'Non demandée';
  app.innerHTML=`<div class="section-title peer-review-title"><div><h2>👥 Relecture de la visite</h2><div class="muted">Vue interne pour discuter les résultats et valider les interprétations à deux.</div></div><div class="actions"><button class="btn secondary" id="peer-presentation">🖥️ Mode présentation</button>${document.body.classList.contains('shared-review-mode')?'<button class="btn secondary" id="peer-exit-shared">↩ Retour application</button>':''}<span class="badge autosave">v14.6.21.68</span></div></div>${activeVisitBanner(visit)}
  <section class="card peer-review-request"><div class="section-title"><div><h3>📨 Demande de relecture</h3><span class="muted">Envoi par e-mail, partage (WhatsApp, Messages…) ou copie du lien direct.</span></div><span class="badge ${peerReviewRequestStatusClass(reqStatus)}">${escapeHtml(reqStatus)}</span></div><div class="grid cols-3"><div class="field"><label>Collègue</label><input id="peer-reviewer" value="${escapeHtml(review.reviewer)}" placeholder="Nom de la collègue"></div><div class="field"><label>Adresse e-mail</label><input id="peer-review-email" type="email" value="${escapeHtml(req.email)}" placeholder="prenom.nom@..."></div><div class="field"><label>Échéance souhaitée (facultatif)</label><input id="peer-review-deadline" type="date" value="${escapeHtml(req.deadline)}"></div></div><div class="peer-review-link"><input id="peer-review-link" readonly value="${escapeHtml(peerReviewLink(visit))}"><div class="actions"><button class="btn primary" id="peer-send-email">✉️ Envoyer par e-mail</button><button class="btn" id="peer-share">📲 Partager</button><button class="btn secondary" id="peer-copy-link">🔗 Copier le lien</button></div></div>${req.requestedAt?`<div class="muted peer-request-meta">Demandée le ${formatDateTime(req.requestedAt)}${req.openedAt?` · ouverte le ${formatDateTime(req.openedAt)}`:''}${req.completedAt?` · terminée le ${formatDateTime(req.completedAt)}`:''}</div>`:''}</section>
  <section class="card peer-review-head"><div class="grid cols-4"><div><span>Sujets</span><strong>${visit.subjects?.length||0}</strong></div><div><span>Valeurs hors réf.</span><strong>${stats.anomalies}</strong></div><div><span>Audit global</span><strong>${auditPct}%</strong></div><div><span>Actions</span><strong>${stats.actionsDone}/${stats.actions}</strong></div></div><div class="grid cols-2" style="margin-top:14px"><div class="field"><label>État de la relecture</label><div class="peer-review-summary"><span class="badge complete">${reviewed} validé(s)</span><span class="badge warning">${flagged.length} à revoir</span></div></div><div class="field"><label>Demande</label><div class="peer-review-summary"><span class="badge ${peerReviewRequestStatusClass(reqStatus)}">${escapeHtml(reqStatus)}</span></div></div></div></section>
  <div class="peer-review-list">${cards.join('')}</div>
  <section class="card peer-review-final"><div class="section-title"><div><h3>🔎 Synthèse des points à reprendre</h3><span class="muted">Seuls les désaccords et modifications sont repris ici.</span></div></div><div id="peer-flagged">${flagged.length?flagged.map(([k,x])=>`<div class="peer-flagged-item"><strong>${escapeHtml(k.replace(/^cat:/,'').replace('theme:',''))}</strong><span>${escapeHtml(x.status)}${x.note?' — '+escapeHtml(x.note):''}</span></div>`).join(''):'<div class="notice positive"><strong>Aucun point marqué à discuter ou modifier.</strong></div>'}</div><div class="field"><label>Conclusion de la relecture</label><textarea rows="4" id="peer-general" placeholder="Accords, réserves, éléments à compléter avant restitution…">${escapeHtml(review.general)}</textarea></div><div class="actions"><button class="btn primary" id="peer-validate">✓ Relecture terminée</button>${review.validatedAt?`<span class="badge complete">Validée le ${formatDateTime(review.validatedAt)}</span>`:''}</div></section>`;
  const save=()=>{visit.updatedAt=new Date().toISOString();saveDatabase(db);};
  document.getElementById('peer-reviewer').oninput=e=>{review.reviewer=e.target.value;save();};
  document.getElementById('peer-review-email').oninput=e=>{review.request.email=e.target.value;save();};
  document.getElementById('peer-review-deadline').onchange=e=>{review.request.deadline=e.target.value;save();};
  document.getElementById('peer-general').oninput=e=>{review.general=e.target.value;save();};
  document.getElementById('peer-send-email').onclick=()=>{const m=peerReviewMailText(visit,review);if(!review.request.email.trim()){showToast('Renseignez l’adresse e-mail de la collègue.');document.getElementById('peer-review-email')?.focus();return;}markPeerReviewRequested(visit,review,'Demandée');window.location.href=`mailto:${encodeURIComponent(review.request.email.trim())}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`;setTimeout(renderPeerReview,250);};
  document.getElementById('peer-share').onclick=async()=>{const m=peerReviewMailText(visit,review);try{if(navigator.share){await navigator.share({title:m.subject,text:m.body,url:m.link});markPeerReviewRequested(visit,review,'Demandée');renderPeerReview();}else{await navigator.clipboard.writeText(m.link);markPeerReviewRequested(visit,review,'Demandée');showToast('Lien copié. Vous pouvez le coller dans WhatsApp ou Messages.');renderPeerReview();}}catch(err){if(err?.name!=='AbortError')showToast('Partage impossible sur cet appareil. Utilisez « Copier le lien ».');}};
  document.getElementById('peer-copy-link').onclick=async()=>{const m=peerReviewMailText(visit,review);try{await navigator.clipboard.writeText(m.link);markPeerReviewRequested(visit,review,'Demandée');showToast('Lien de relecture copié.');renderPeerReview();}catch(_){const input=document.getElementById('peer-review-link');input?.select();document.execCommand('copy');markPeerReviewRequested(visit,review,'Demandée');showToast('Lien de relecture copié.');renderPeerReview();}};
  document.getElementById('peer-exit-shared')?.addEventListener('click',()=>{document.body.classList.remove('shared-review-mode');const u=new URL(window.location.href);u.searchParams.delete('reviewVisit');u.searchParams.delete('reviewMode');history.replaceState({},'',u);setView('dashboard');});
  app.querySelectorAll('[data-peer-status]').forEach(el=>el.onchange=()=>{peerReviewCardState(review,el.dataset.peerStatus).status=el.value;save();renderPeerReview();});
  app.querySelectorAll('[data-peer-note]').forEach(el=>el.oninput=()=>{peerReviewCardState(review,el.dataset.peerNote).note=el.value;save();});
  document.getElementById('peer-validate').onclick=()=>{review.validatedAt=new Date().toISOString();review.request.status='Terminée';review.request.completedAt=review.validatedAt;addJournal(visit,`Relecture collégiale terminée${review.reviewer?' avec '+review.reviewer:''}.`);save();showToast('Relecture enregistrée.');renderPeerReview();};
  document.getElementById('peer-presentation').onclick=()=>{document.body.classList.toggle('peer-presentation-mode');const on=document.body.classList.contains('peer-presentation-mode');document.getElementById('peer-presentation').textContent=on?'↩ Quitter présentation':'🖥️ Mode présentation';if(on&&document.documentElement.requestFullscreen)document.documentElement.requestFullscreen().catch(()=>{});};
}

function renderAssistantGDS(){
  const visit=activeVisit();if(!visit){renderNoActiveVisit('Assistant GDS');return;}
  const stats=visitProfessionalStats(visit),auto=autoVisitConclusion(visit),attention=professionalAttentionItems(visit);
  app.innerHTML=`<div class="section-title"><div><h2>Analyse & interprétation</h2><div class="muted">Synthèse professionnelle des données de la visite active.</div></div><span class="badge autosave">v14.3 Professional</span></div>${activeVisitBanner(visit)}
  <section class="assistant-hero"><div><span class="assistant-kicker">SYNTHESE AUTOMATIQUE</span><h3>${escapeHtml(farmName(visit.farmId))}</h3><p>Les éléments ci-dessous sont construits à partir des données saisies et restent soumis à la validation du technicien.</p></div><div class="assistant-completion"><strong>${stats.completion}%</strong><span>visite structurée</span></div></section>
  <section class="grid cols-4 professional-kpis"><article class="card"><span>Anomalies</span><strong>${stats.anomalies}</strong></article><article class="card"><span>Sujets mesurés</span><strong>${stats.measured}</strong></article><article class="card"><span>Photos</span><strong>${stats.photos}</strong></article><article class="card"><span>Actions réalisées</span><strong>${stats.actionsDone}/${stats.actions}</strong></article></section>
  <section class="card"><div class="section-title"><div><h3>Indicateurs par domaine</h3><div class="muted">Repères de suivi calculés à partir de la complétude et des vigilances détectées.</div></div></div>${renderProfessionalIndicators(visit)}</section>
  <section class="grid cols-2"><article class="card"><h3>✅ Points favorables proposés</h3>${auto.strengths.length?`<ul>${auto.strengths.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>`:'<div class="empty">Aucun point favorable automatique suffisamment étayé.</div>'}</article><article class="card"><h3>🔔 Centre d’attention</h3>${attention.length?`<div class="attention-list">${attention.map(x=>`<button class="attention-item ${x.level}" data-attention-view="${x.view}"><span>${x.icon}</span><strong>${escapeHtml(x.text)}</strong><b>›</b></button>`).join('')}</div>`:'<div class="notice"><strong>Aucune étape importante en attente.</strong></div>'}</article></section>
  <section class="card"><div class="section-title"><div><h3>🧠 Pistes prioritaires</h3><div class="muted">Classées selon la convergence des éléments, les contradictions, les données manquantes et la diversité des sources.</div></div><button class="btn primary" id="assistant-open-analysis">Ouvrir l’analyse détaillée</button></div>${stats.pistes.length?`<div class="assistant-pistes">${stats.pistes.slice(0,6).map((p,i)=>`<article><span class="assistant-rank">${i+1}</span><div><small>${escapeHtml(p.category)}</small><h4>${escapeHtml(p.title)}</h4><p>${escapeHtml(p.summary)}</p><span class="confidence ${p.confidence.className}">Confiance ${escapeHtml(p.confidence.label)} · ${p.sourceCount} source(s)</span>${confidenceBreakdownHtml(p,true)}</div></article>`).join('')}</div>`:'<div class="empty">Aucune piste suffisamment étayée. Complétez les mesures et les modules de contexte.</div>'}</section>
  <section class="grid cols-2"><article class="card"><h3>🧬 Profil métabolique</h3>${metabolicSummary(visit).length?metabolicSummary(visit).map(x=>`<div class="mini-result"><strong>${escapeHtml(x.label)}</strong><span>${x.low} bas · ${x.high} haut · ${x.normal} dans le repère</span></div>`).join(''):'<div class="empty">Aucun profil métabolique.</div>'}<div class="actions"><button class="btn secondary" data-go-special="metabolic">Ouvrir le module</button></div></article><article class="card"><h3>🦠 Parasitisme</h3>${parasiteSummary(visit).length?parasiteSummary(visit).map(x=>`<div class="mini-result"><strong>${escapeHtml(x.label)}</strong><span>${x.statuses.join(', ')}</span></div>`).join(''):'<div class="empty">Aucune analyse parasitaire.</div>'}<div class="actions"><button class="btn secondary" data-go-special="parasitism">Ouvrir le module</button></div></article></section>
  <section class="card"><h3>🎯 Proposition de plan d’action</h3><div class="assistant-actions">${auto.priorities.filter(x=>x.text).map((x,i)=>`<div><span>${i+1}</span><strong>${escapeHtml(x.text)}</strong><small>${escapeHtml(x.source||'')}</small></div>`).join('')||'<div class="empty">Aucune action automatique proposée.</div>'}</div><div class="actions"><button class="btn" id="assistant-open-conclusion">Valider dans la conclusion</button><button class="btn secondary" id="assistant-open-reports">Préparer le rapport</button></div></section>`;
  app.querySelectorAll('[data-attention-view]').forEach(b=>b.onclick=()=>setView(b.dataset.attentionView));
  app.querySelectorAll('[data-go-special]').forEach(b=>b.onclick=()=>setView(b.dataset.goSpecial));
  document.getElementById('assistant-open-analysis').onclick=()=>{activeAnalysisSection='reasoning';localStorage.setItem('audit-bovin-active-analysis-section','reasoning');setView('analysis');};
  document.getElementById('assistant-open-conclusion').onclick=()=>{activeAnalysisSection='conclusion';localStorage.setItem('audit-bovin-active-analysis-section','conclusion');setView('analysis');};
  document.getElementById('assistant-open-reports').onclick=()=>setView('reports');
}
function renderDashboard() {
  const inProgress=db.visits.filter(v=>v.status==='in-progress'),complete=db.visits.filter(v=>v.status==='complete');
  const subjectCount=db.visits.reduce((sum,v)=>sum+(v.subjects?.length||0),0),draft=loadDraft(),visit=activeVisit(),stats=visitProfessionalStats(visit),attention=professionalAttentionItems(visit);
  app.innerHTML=`<div class="professional-dashboard-head"><div><span class="assistant-kicker">AUDIT BOVIN GDS 32-65</span><h2>Tableau de bord professionnel</h2><p>${visit?`Visite active : <strong>${escapeHtml(visitLabel(visit))}</strong>`:'Ouvrez une visite pour afficher son avancement détaillé.'}</p></div>${visit?`<div class="dashboard-ring" style="--pct:${stats.completion}"><strong>${stats.completion}%</strong><span>avancement</span></div>`:''}</div>
  <section class="grid cols-4 professional-kpis"><article class="card"><span>Exploitations</span><strong>${db.farms.length}</strong></article><article class="card"><span>Visites en cours</span><strong>${inProgress.length}</strong></article><article class="card"><span>Visites terminées</span><strong>${complete.length}</strong></article><article class="card"><span>Sujets enregistrés</span><strong>${subjectCount}</strong></article></section>
  ${draft?`<section class="card notice warning" style="margin-top:16px"><strong>Une saisie non finalisée a été retrouvée.</strong><div class="actions" style="margin-top:10px"><button class="btn primary" id="resume-draft">Reprendre la saisie</button><button class="btn secondary" id="discard-draft">Ignorer</button></div></section>`:''}
  ${visit?`<section class="grid cols-4 dashboard-visit-kpis"><article class="card"><span>🧪 Valeurs hors réf.</span><strong>${stats.anomalies}</strong></article><article class="card"><span>📷 Photos</span><strong>${stats.photos}</strong></article><article class="card"><span>📋 Audit global</span><strong>${stats.auditPct}%</strong></article><article class="card"><span>🎯 Actions réalisées</span><strong>${stats.actionsDone}/${stats.actions}</strong></article></section>
  <section class="grid cols-2"><article class="card"><div class="section-title"><div><h3>Centre d’attention</h3><div class="muted">Ce qui mérite une action ou une vérification.</div></div></div>${attention.length?`<div class="attention-list">${attention.slice(0,7).map(x=>`<button class="attention-item ${x.level}" data-attention-view="${x.view}"><span>${x.icon}</span><strong>${escapeHtml(x.text)}</strong><b>›</b></button>`).join('')}</div>`:'<div class="notice"><strong>La visite ne présente aucune étape majeure en attente.</strong></div>'}</article><article class="card"><div class="section-title"><div><h3>Assistant GDS</h3><div class="muted">Pistes prioritaires actuellement détectées.</div></div><button class="btn primary" id="open-assistant">Ouvrir</button></div>${stats.pistes.length?`<div class="dashboard-pistes">${stats.pistes.slice(0,3).map(p=>`<div><strong>${escapeHtml(p.title)}</strong><span>${escapeHtml(p.category)} · confiance ${escapeHtml(p.confidence.label)}</span></div>`).join('')}</div>`:'<div class="empty">Complétez les mesures pour générer les pistes.</div>'}</article></section>
  <section class="card"><h3>Indicateurs de suivi par domaine</h3>${renderProfessionalIndicators(visit)}</section>`:''}
  <section class="grid cols-2" style="margin-top:16px"><article class="card"><h2>Actions rapides</h2><div class="actions"><button class="btn primary" id="new-farm">Nouvelle exploitation</button><button class="btn" id="new-visit">Nouvelle visite</button><button class="btn" id="open-animals">Ouvrir les animaux</button>${visit?'<button class="btn secondary" id="open-report">Rapports</button>':''}</div></article><article class="card"><h2>Dernières visites</h2>${db.visits.length?`<ul class="journal">${db.visits.slice().sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,5).map(v=>`<li><strong>${escapeHtml(farmName(v.farmId))}</strong> — ${formatDate(v.date)}<br><span class="muted">${escapeHtml(v.type||'Visite')} · ${v.subjects?.length||0} sujet(s) · ${escapeHtml(v.status==='complete'?'Terminée':'En cours')}</span></li>`).join('')}</ul>`:'<div class="empty">Aucune visite enregistrée.</div>'}</article></section>`;
  document.getElementById('new-farm').onclick=()=>{setView('farms');setTimeout(()=>document.getElementById('farm-name')?.focus(),0)};
  document.getElementById('new-visit').onclick=()=>{setView('visits');setTimeout(()=>document.getElementById('visit-farm')?.focus(),0)};
  document.getElementById('open-animals').onclick=()=>setView('animals');document.getElementById('open-report')?.addEventListener('click',()=>setView('reports'));document.getElementById('open-assistant')?.addEventListener('click',()=>setView('assistant'));
  app.querySelectorAll('[data-attention-view]').forEach(b=>b.onclick=()=>setView(b.dataset.attentionView));
  document.getElementById('resume-draft')?.addEventListener('click',()=>setView(draft.kind==='farm'?'farms':'visits'));document.getElementById('discard-draft')?.addEventListener('click',()=>{clearDraft();renderDashboard()});
}

function renderFarms() {
  const draft = loadDraft();
  const farmDraft = draft?.kind === 'farm' ? draft.data : {};
  app.innerHTML = `
    <div class="section-title"><h2>Exploitations</h2><span class="muted">${db.farms.length} exploitation(s)</span></div>
    <section class="grid cols-2">
      <form id="farm-form" class="card">
        <h3>Ajouter une exploitation</h3>
        <div class="field"><label for="farm-name">Nom de l’exploitation *</label><input id="farm-name" name="name" required value="${escapeHtml(farmDraft.name || '')}" /></div>
        <div class="field"><label for="farm-number">N° cheptel / EDE / exploitation</label><input id="farm-number" name="farmNumber" inputmode="numeric" autocomplete="off" placeholder="Ex. 65039026" value="${escapeHtml(farmDraft.farmNumber || '')}" /><small class="muted">Ce numéro relie automatiquement les données importées aux visites de l’exploitation.</small></div>
        <div class="row"><div class="field"><label>Éleveur</label><input name="farmer" value="${escapeHtml(farmDraft.farmer || '')}" /></div><div class="field"><label>Commune</label><input name="commune" value="${escapeHtml(farmDraft.commune || '')}" /></div></div>
        <div class="row"><div class="field"><label>Téléphone</label><input name="phone" inputmode="tel" value="${escapeHtml(farmDraft.phone || '')}" /></div><div class="field"><label>Courriel</label><input name="email" type="email" value="${escapeHtml(farmDraft.email || '')}" /></div></div>
        <div class="field"><label>Informations permanentes</label><textarea name="notes">${escapeHtml(farmDraft.notes || '')}</textarea></div>
        <button class="btn primary" type="submit">Ajouter l’exploitation</button>
      </form>
      <section class="card">
        <h3>Liste des exploitations</h3>
        ${db.farms.length ? `<div class="table-wrap"><table><thead><tr><th>Exploitation</th><th>Commune</th><th>Visites</th><th></th></tr></thead><tbody>${db.farms.map(f => `<tr><td><strong>${escapeHtml(f.name)}</strong><br><span class="muted">${escapeHtml(f.farmer || '')}${f.farmNumber?` · EDE ${escapeHtml(f.farmNumber)}`:''}</span></td><td>${escapeHtml(f.commune || '—')}</td><td>${db.visits.filter(v => v.farmId === f.id).length}</td><td><div class="actions"><button class="btn small" data-open-farm-journal="${f.id}">Journal</button><button class="btn small" data-open-farm-documents="${f.id}">Documents</button><button class="btn small" data-set-farm-number="${f.id}">N° EDE</button><button class="btn small danger" data-delete-farm="${f.id}">Supprimer</button></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucune exploitation.</div>'}
      </section>
    </section>`;
  const form = document.getElementById('farm-form');
  form.addEventListener('input', () => saveDraft({ kind: 'farm', data: Object.fromEntries(new FormData(form)) }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.name.trim()) return;
    db.farms.push({ id: uid('farm'), ...data, buildings:[], documents:[], journal:[], vigilances:[], registryLinked: !!registryAnimal, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    saveDatabase(db); clearDraft(); showToast('Exploitation ajoutée.'); renderFarms();
  });
  app.querySelectorAll('[data-open-farm-journal]').forEach(button=>button.onclick=()=>{localStorage.setItem('audit-bovin-journal-farm',button.dataset.openFarmJournal);setView('journal');});
  app.querySelectorAll('[data-open-farm-documents]').forEach(button=>button.onclick=()=>{localStorage.setItem('audit-bovin-documents-farm',button.dataset.openFarmDocuments);setView('documents');});
  app.querySelectorAll('[data-set-farm-number]').forEach(button => button.onclick = () => { const farm=db.farms.find(f=>f.id===button.dataset.setFarmNumber);if(!farm)return;const value=prompt('N° cheptel / EDE / exploitation',farm.farmNumber||normalizeHerdNumber(farm.farmer)||'');if(value===null)return;farm.farmNumber=String(value).trim();farm.updatedAt=new Date().toISOString();saveDatabase(db);showToast('Numéro EDE enregistré.');renderFarms(); });
  app.querySelectorAll('[data-delete-farm]').forEach(button => button.onclick = () => {
    const id = button.dataset.deleteFarm;
    if (db.visits.some(v => v.farmId === id)) return showToast('Suppression impossible : cette exploitation possède des visites.');
    if (confirm('Supprimer cette exploitation ?')) { db.farms = db.farms.filter(f => f.id !== id); saveDatabase(db); renderFarms(); }
  });
}



const farmDocumentCategories=['Analyse de fourrage','Analyse d’eau','Analyse de sol','Résultat de laboratoire','Rapport vétérinaire','Plan de bâtiment','Rapport d’audit','Photo de référence','Document partenaire','Autre document'];
function ensureFarmDocuments(farm){farm.documents=Array.isArray(farm.documents)?farm.documents:[];return farm.documents;}
function humanFileSize(bytes=0){if(bytes<1024)return `${bytes} o`;if(bytes<1048576)return `${(bytes/1024).toFixed(1)} Ko`;return `${(bytes/1048576).toFixed(1)} Mo`;}
function dataUrlToBlob(dataUrl){
  const parts=String(dataUrl||'').split(',');if(parts.length<2)throw new Error('Données de fichier invalides');
  const mime=(parts[0].match(/data:([^;]+)/)||[])[1]||'application/octet-stream';
  const binary=parts[0].includes(';base64')?atob(parts[1]):decodeURIComponent(parts[1]);
  const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes],{type:mime});
}
function downloadStoredDocument(docu){
  if(!docu?.dataUrl)return showToast('Le fichier n’est pas disponible sur cet appareil.');
  try{const blob=dataUrlToBlob(docu.dataUrl),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=docu.fileName||docu.title||'document';a.target='_blank';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(err){console.error(err);showToast('Impossible d’ouvrir ce document. Réimportez-le depuis le fichier d’origine.');}
}
function renderFarmDocuments(){
  const farmId=localStorage.getItem('audit-bovin-documents-farm')||activeVisit()?.farmId||db.farms[0]?.id||'';
  const farm=db.farms.find(f=>f.id===farmId);if(farm)ensureFarmDocuments(farm);
  const docs=farm?.documents?.slice().sort((a,b)=>(b.documentDate||b.createdAt||'').localeCompare(a.documentDate||a.createdAt||''))||[];
  app.innerHTML=`<div class="section-title"><div><h2>📁 Documents de l’exploitation</h2><div class="muted">Analyses de fourrages, eau, sol, résultats de laboratoire, plans et rapports externes.</div></div><span class="badge autosave">Sauvegarde locale + cloud</span></div>
  <section class="card"><div class="field"><label>Exploitation</label><select id="documents-farm-select"><option value="">Choisir…</option>${db.farms.map(f=>`<option value="${f.id}" ${f.id===farmId?'selected':''}>${escapeHtml(f.name)}${f.farmNumber?' · EDE '+escapeHtml(f.farmNumber):''}</option>`).join('')}</select></div></section>
  ${!farm?'<section class="card empty">Sélectionnez une exploitation.</section>':`<section class="grid cols-2"><form id="farm-document-form" class="card"><h3>Ajouter un document</h3><div class="field"><label>Fichier *</label><input id="farm-document-file" name="file" type="file" required accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt,application/pdf,image/*"></div><div class="row"><div class="field"><label>Catégorie</label><select name="category">${farmDocumentCategories.map(c=>`<option>${escapeHtml(c)}</option>`).join('')}</select></div><div class="field"><label>Date du document</label><input name="documentDate" type="date" value="${new Date().toISOString().slice(0,10)}"></div></div><div class="field"><label>Titre</label><input name="title" placeholder="Ex. Analyse ensilage maïs 2026"></div><div class="field"><label>Commentaire</label><textarea name="notes" placeholder="Résultat important, laboratoire, parcelle, lot concerné…"></textarea></div><button class="btn primary" type="submit">Enregistrer le document</button><p class="muted small-text">Pour préserver la sauvegarde et la synchronisation, la taille maximale est limitée à 4 Mo par fichier. Les fichiers sont inclus dans la base partagée.</p></form><article class="card"><h3>Résumé du dossier</h3><div class="grid cols-2 professional-kpis"><div><span>Documents</span><strong>${docs.length}</strong></div><div><span>Volume enregistré</span><strong>${humanFileSize(docs.reduce((s,d)=>s+(Number(d.size)||0),0))}</strong></div></div><div class="document-category-summary">${farmDocumentCategories.map(c=>{const n=docs.filter(d=>d.category===c).length;return n?`<span>${escapeHtml(c)} <b>${n}</b></span>`:''}).join('')}</div></article></section>
  <section class="card"><div class="section-title"><div><h3>Documents enregistrés</h3><div class="muted">Ils suivent l’exploitation dans les exports JSON et la synchronisation Supabase.</div></div><input id="documents-search" placeholder="Rechercher un titre, une catégorie…"></div><div id="documents-list" class="farm-documents-list"></div></section>`}`;
  document.getElementById('documents-farm-select').onchange=e=>{localStorage.setItem('audit-bovin-documents-farm',e.target.value);renderFarmDocuments();};
  if(!farm)return;
  const renderList=()=>{const q=normalizeSearchText(document.getElementById('documents-search')?.value||'');const list=docs.filter(d=>!q||normalizeSearchText([d.title,d.category,d.fileName,d.notes].join(' ')).includes(q));document.getElementById('documents-list').innerHTML=list.length?list.map(d=>`<article class="farm-document-card"><div class="farm-document-icon">${String(d.mimeType||'').startsWith('image/')?'🖼️':String(d.mimeType||'').includes('pdf')?'📄':'📎'}</div><div><span class="badge">${escapeHtml(d.category||'Document')}</span><h4>${escapeHtml(d.title||d.fileName||'Document')}</h4><small>${d.documentDate?formatDate(d.documentDate):formatDateTime(d.createdAt)} · ${humanFileSize(d.size)} · ${escapeHtml(d.fileName||'')}</small>${d.notes?`<p>${escapeHtml(d.notes)}</p>`:''}</div><div class="actions"><button class="btn small action-export" data-download-farm-doc="${d.id}">Ouvrir / télécharger</button><button class="btn small danger" data-delete-farm-doc="${d.id}">Supprimer</button></div></article>`).join(''):'<div class="empty">Aucun document correspondant.</div>';app.querySelectorAll('[data-download-farm-doc]').forEach(b=>b.onclick=()=>downloadStoredDocument(farm.documents.find(d=>d.id===b.dataset.downloadFarmDoc)));app.querySelectorAll('[data-delete-farm-doc]').forEach(b=>b.onclick=()=>{if(!confirm('Supprimer définitivement ce document ?'))return;farm.documents=farm.documents.filter(d=>d.id!==b.dataset.deleteFarmDoc);farm.updatedAt=new Date().toISOString();saveDatabase(db);renderFarmDocuments();});};
  document.getElementById('documents-search').oninput=renderList;renderList();
  document.getElementById('farm-document-form').onsubmit=e=>{e.preventDefault();const file=document.getElementById('farm-document-file').files?.[0];if(!file)return showToast('Choisissez un fichier.');if(file.size>4*1024*1024)return showToast('Fichier trop volumineux : maximum 4 Mo.');const fd=Object.fromEntries(new FormData(e.currentTarget));const reader=new FileReader();reader.onerror=()=>showToast('Lecture du fichier impossible.');reader.onload=()=>{try{farm.documents.push({id:uid('document'),category:fd.category,title:(fd.title||file.name).trim(),documentDate:fd.documentDate,notes:fd.notes||'',fileName:file.name,mimeType:file.type||'application/octet-stream',size:file.size,dataUrl:reader.result,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});farm.updatedAt=new Date().toISOString();saveDatabase(db);showToast('Document enregistré dans le dossier de l’exploitation.');renderFarmDocuments();}catch(err){console.error(err);showToast('Enregistrement impossible : espace local insuffisant. Réduisez la taille du fichier.');}};reader.readAsDataURL(file);};
}

const journalEventTypes=['Appel téléphonique','Mail / message','Passage rapide','Action réalisée','Action partiellement réalisée','Difficulté / blocage','Problème sanitaire','Alimentation / ration','Bâtiment / eau / électricité','Reproduction','Mortalité','Retour vétérinaire','Autre'];
const journalLevels=['Information','À surveiller','Urgent'];
function ensureFarmTracking(farm){farm.journal=Array.isArray(farm.journal)?farm.journal:[];farm.vigilances=Array.isArray(farm.vigilances)?farm.vigilances:[];return farm;}
function renderJournalSuivi(){
  const farmId=localStorage.getItem('audit-bovin-journal-farm')||db.farms[0]?.id||'',farm=db.farms.find(f=>f.id===farmId);if(farm)ensureFarmTracking(farm);
  const visits=farm?db.visits.filter(v=>v.farmId===farm.id).sort((a,b)=>(b.date||'').localeCompare(a.date||'')):[];
  const actions=visits.flatMap(v=>(v.analysisActions||[]).map(a=>({visit:v,action:a}))),preAction=localStorage.getItem('audit-bovin-journal-action')||'';localStorage.removeItem('audit-bovin-journal-action');
  app.innerHTML=`<div class="section-title"><div><h2>📒 Journal & points de vigilance</h2><div class="muted">Noter les nouvelles reçues entre deux visites, les difficultés et les événements sanitaires.</div></div><span class="badge autosave">v14.6.21.68</span></div>
  <section class="card journal-farm-select"><div class="field"><label>Exploitation</label><select id="journal-farm-select"><option value="">Choisir…</option>${db.farms.map(f=>`<option value="${f.id}" ${f.id===farmId?'selected':''}>${escapeHtml(f.name)}${f.farmNumber?' · '+escapeHtml(f.farmNumber):''}</option>`).join('')}</select></div></section>
  ${!farm?'<section class="card empty">Sélectionnez une exploitation.</section>':`
  <section class="grid cols-2"><form id="journal-entry-form" class="card"><h3>Ajouter une nouvelle</h3><div class="row"><div class="field"><label>Date et heure</label><input name="date" type="datetime-local" value="${new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}"></div><div class="field"><label>Origine / type</label><select name="type">${journalEventTypes.map(x=>`<option>${x}</option>`).join('')}</select></div></div><div class="row"><div class="field"><label>Niveau</label><select name="level">${journalLevels.map(x=>`<option>${x}</option>`).join('')}</select></div><div class="field"><label>Statut</label><select name="status"><option>Ouvert</option><option>Résolu</option><option>À revoir à la prochaine visite</option></select></div></div><div class="field"><label>Description *</label><textarea name="text" required placeholder="Ex. L'éleveur indique que le deuxième abreuvoir est installé…"></textarea></div><div class="row"><div class="field"><label>Visite liée</label><select name="visitId"><option value="">Aucune</option>${visits.map(v=>`<option value="${v.id}">${formatDate(v.date)} · ${escapeHtml(v.type||'Visite')}</option>`).join('')}</select></div><div class="field"><label>Action liée</label><select name="actionId"><option value="">Aucune</option>${actions.map(x=>`<option value="${x.action.id}" ${x.action.id===preAction?'selected':''}>${escapeHtml(x.action.text||'Action')}</option>`).join('')}</select></div></div><div class="field"><label>Technicien</label><input name="technician" value="${escapeHtml(window.auditCloud?.session?.user?.email||'')}"></div><button class="btn primary" type="submit">Enregistrer la nouvelle</button></form>
  <form id="vigilance-form" class="card"><h3>🚩 Ajouter un point de vigilance</h3><div class="field"><label>Point à garder en mémoire *</label><textarea name="text" required placeholder="Ex. Recontrôler le débit du nouvel abreuvoir."></textarea></div><div class="row"><div class="field"><label>Échéance indicative</label><input name="dueDate" type="date"></div><div class="field"><label>Priorité</label><select name="priority"><option>Haute</option><option selected>Moyenne</option><option>Basse</option></select></div></div><button class="btn primary" type="submit">Ajouter la vigilance</button><hr><h4>Points actifs</h4><div class="vigilance-list">${farm.vigilances.filter(v=>!v.done).length?farm.vigilances.filter(v=>!v.done).map(v=>`<article class="vigilance-item ${v.priority==='Haute'?'high':''}"><div><strong>${escapeHtml(v.text)}</strong><small>${v.dueDate?'Échéance '+formatDate(v.dueDate):'Sans échéance'} · ${escapeHtml(v.priority)}</small></div><button type="button" class="btn small" data-close-vigilance="${v.id}">Marquer vérifié</button></article>`).join(''):'<div class="empty compact">Aucun point actif.</div>'}</div></form></section>
  <section class="card"><div class="section-title"><div><h3>Chronologie de l'exploitation</h3><div class="muted">Les informations restent indépendantes des visites et sont partagées par la base cloud.</div></div></div><div class="farm-timeline">${farm.journal.length?farm.journal.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map(e=>`<article class="timeline-note level-${e.level==='Urgent'?'urgent':e.level==='À surveiller'?'watch':'info'}"><div class="timeline-dot"></div><div><header><strong>${escapeHtml(e.type)}</strong><span>${formatDateTime(e.date)}</span></header><p>${escapeHtml(e.text).replace(/\n/g,'<br>')}</p><small>${escapeHtml(e.technician||'Technicien non renseigné')} · ${escapeHtml(e.status||'Ouvert')}</small>${e.actionId?'<span class="badge">Lié à une action</span>':''}</div><button class="btn small danger" data-delete-journal="${e.id}">Supprimer</button></article>`).join(''):'<div class="empty">Aucune nouvelle enregistrée.</div>'}</div></section>`}`;
  document.getElementById('journal-farm-select').onchange=e=>{localStorage.setItem('audit-bovin-journal-farm',e.target.value);renderJournalSuivi();};
  document.getElementById('journal-entry-form')?.addEventListener('submit',e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));if(!d.text.trim())return;const entry={id:uid('journal'),...d,date:new Date(d.date).toISOString(),createdAt:new Date().toISOString()};farm.journal.push(entry);if(d.actionId){const x=actions.find(x=>x.action.id===d.actionId);if(x){x.action.history=Array.isArray(x.action.history)?x.action.history:[];x.action.history.push({id:uid('action-history'),date:entry.date,status:x.action.status,note:d.text,technician:d.technician});if(d.type==='Action réalisée')x.action.status='Réalisé';if(d.type==='Action partiellement réalisée')x.action.status='En cours';if(d.type==='Difficulté / blocage')x.action.status='Bloquée';x.action.progressNote=d.text;}}farm.updatedAt=new Date().toISOString();saveDatabase(db);showToast('Nouvelle enregistrée.');renderJournalSuivi();});
  document.getElementById('vigilance-form')?.addEventListener('submit',e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));if(!d.text.trim())return;farm.vigilances.push({id:uid('vigilance'),...d,done:false,createdAt:new Date().toISOString()});farm.updatedAt=new Date().toISOString();saveDatabase(db);renderJournalSuivi();});
  app.querySelectorAll('[data-close-vigilance]').forEach(b=>b.onclick=()=>{const v=farm.vigilances.find(x=>x.id===b.dataset.closeVigilance);if(v){v.done=true;v.doneAt=new Date().toISOString();saveDatabase(db);renderJournalSuivi();}});
  app.querySelectorAll('[data-delete-journal]').forEach(b=>b.onclick=()=>{if(!confirm('Supprimer cette entrée du journal ?'))return;farm.journal=farm.journal.filter(x=>x.id!==b.dataset.deleteJournal);saveDatabase(db);renderJournalSuivi();});
}

function visitFormHtml(visit = {}) {
  const draft = loadDraft();
  const visitDraft = draft?.kind === 'visit' ? draft.data : {};
  const data = { ...visitDraft, ...visit };
  return `<form id="visit-form" class="card">
    <h3>${visit.id ? 'Modifier la visite' : 'Nouvelle visite'}</h3>
    ${!db.farms.length ? '<div class="notice warning">Ajoutez d’abord une exploitation.</div>' : ''}
    <div class="field"><label for="visit-farm">Exploitation *</label><select id="visit-farm" name="farmId" required><option value="">Sélectionner…</option>${db.farms.map(f => `<option value="${f.id}" ${data.farmId===f.id?'selected':''}>${escapeHtml(f.name)}</option>`).join('')}</select></div>
    <div class="row"><div class="field"><label>Date *</label><input name="date" type="date" required value="${escapeHtml(data.date || new Date().toISOString().slice(0,10))}" /></div><div class="field"><label>Technicien</label><input name="technician" value="${escapeHtml(data.technician || '')}" /></div></div>
    <div class="field"><label>Type de visite</label><select name="type">${visitTypes.map(type => `<option ${data.type===type?'selected':''}>${type}</option>`).join('')}</select></div>
    <div class="field"><label>Objectif / attentes</label><textarea name="objective">${escapeHtml(data.objective || '')}</textarea></div>
    <div class="field"><label>Statut</label><select name="status"><option value="in-progress" ${data.status!=='complete'?'selected':''}>En cours</option><option value="complete" ${data.status==='complete'?'selected':''}>Terminée</option></select></div>
    <div class="actions"><button class="btn primary" type="submit">${visit.id ? 'Mettre à jour' : 'Créer la visite'}</button>${visit.id ? '<button type="button" class="btn secondary" id="cancel-edit">Annuler</button>' : ''}</div>
  </form>`;
}

async function shareVisitFile(visit){
  if(!visit)return;
  const farm=db.farms.find(f=>f.id===visit.farmId);
  const payload={schemaVersion:2,farm,visit};
  const filename=`${slugify(farmName(visit.farmId))}-${visit.date||'visite'}.json`;
  const json=JSON.stringify(payload,null,2);
  try{
    const file=new File([json],filename,{type:'application/json'});
    if(navigator.share&&navigator.canShare?.({files:[file]})){
      await navigator.share({title:`Visite ${farmName(visit.farmId)}`,text:`Visite du ${formatDate(visit.date)} à importer dans Audit Bovin GDS 32-65.`,files:[file]});
      showToast('Visite partagée.');
      return;
    }
  }catch(err){if(err?.name==='AbortError')return;console.warn('Partage système indisponible',err);}
  downloadJson(filename,payload);
  showToast('Le fichier JSON de la visite a été téléchargé : envoyez-le à votre collègue.');
}

function renderVisits() {
  const editVisit = editingVisitId ? db.visits.find(v => v.id === editingVisitId) : null;
  const farmFilter=localStorage.getItem('audit-bovin-visits-farm')||'';
  const statusFilter=localStorage.getItem('audit-bovin-visits-status')||'';
  const search=(localStorage.getItem('audit-bovin-visits-search')||'').trim().toLowerCase();
  const ordered=db.visits.slice().sort((a,b)=>(b.date||b.updatedAt||'').localeCompare(a.date||a.updatedAt||''));
  const filtered=ordered.filter(v=>(!farmFilter||v.farmId===farmFilter)&&(!statusFilter||v.status===statusFilter)&&(!search||[farmName(v.farmId),v.technician,v.type,v.date].join(' ').toLowerCase().includes(search)));
  app.innerHTML = `
    <div class="section-title"><div><h2>Visites</h2><div class="muted">Toutes les visites enregistrées restent accessibles, y compris les plus anciennes.</div></div><span class="badge autosave">v14.6.21.68</span></div>
    <section class="grid cols-2">${visitFormHtml(editVisit || {})}<section class="card"><div class="section-title"><div><h3>Historique complet</h3><div class="muted">${filtered.length} visite(s) affichée(s) sur ${db.visits.length}</div></div><button class="btn small" id="reset-visit-filters">Réinitialiser</button></div>
    <div class="grid cols-3 visit-history-filters"><div class="field"><label>Rechercher</label><input id="visit-search" value="${escapeHtml(search)}" placeholder="Exploitation, technicien, type…"></div><div class="field"><label>Exploitation</label><select id="visit-farm-filter"><option value="">Toutes</option>${db.farms.map(f=>`<option value="${f.id}" ${f.id===farmFilter?'selected':''}>${escapeHtml(f.name)}</option>`).join('')}</select></div><div class="field"><label>Statut</label><select id="visit-status-filter"><option value="">Tous</option><option value="in-progress" ${statusFilter==='in-progress'?'selected':''}>En cours</option><option value="complete" ${statusFilter==='complete'?'selected':''}>Terminées</option></select></div></div>
    ${filtered.length?`<div class="table-wrap visit-history-table"><table><thead><tr><th>Exploitation</th><th>Date</th><th>Type</th><th>Sujets</th><th>Statut</th><th>Actions</th></tr></thead><tbody>${filtered.map(v=>`<tr class="${v.id===activeVisitId?'active-history-row':''}"><td><strong>${escapeHtml(farmName(v.farmId))}</strong><br><span class="muted">${escapeHtml(v.technician||'')}</span></td><td>${formatDate(v.date)}</td><td>${escapeHtml(v.type||'—')}</td><td>${v.subjects?.length||0}</td><td><span class="badge ${v.status==='complete'?'complete':'in-progress'}">${v.status==='complete'?'Terminée':'En cours'}</span></td><td><div class="actions"><button class="btn small primary" data-select-visit="${v.id}">Choisir</button><button class="btn small" data-edit-visit="${v.id}">Modifier</button><button class="btn small" data-open-animals="${v.id}">Animaux</button><button class="btn small" data-open-questionnaires="${v.id}">Questionnaires</button><button class="btn small secondary" data-compare-visit="${v.id}">Comparer</button><button class="btn small" data-share-visit="${v.id}">Partager</button><button class="btn small secondary" data-export-visit="${v.id}">JSON</button><button class="btn small danger" data-delete-visit="${v.id}">Supprimer</button></div></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aucune visite ne correspond aux filtres.</div>'}</section></section>
    ${editVisit?renderPreviousVisitReview(editVisit):''}${editVisit?`<section class="card" style="margin-top:16px"><h3>Journal de la visite</h3>${editVisit.journal?.length?`<ul class="journal">${editVisit.journal.map(j=>`<li><strong>${formatDateTime(j.at)}</strong><br>${escapeHtml(j.message)}</li>`).join('')}</ul>`:'<div class="empty">Aucune modification enregistrée.</div>'}</section>`:''}`;
  const form=document.getElementById('visit-form');
  form.addEventListener('input',()=>saveDraft({kind:'visit',data:Object.fromEntries(new FormData(form))}));
  form.addEventListener('submit',event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));if(!data.farmId||!data.date)return showToast('Exploitation et date obligatoires.');if(editVisit){Object.assign(editVisit,data,{updatedAt:new Date().toISOString()});addJournal(editVisit,'Informations générales mises à jour.');showToast('Visite mise à jour.');}else{const visit={id:uid('visit'),...data,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),journal:[],subjects:[]};addJournal(visit,'Visite créée.');db.visits.push(visit);ensurePreviousVisitReview(visit);setActiveVisit(visit.id);editingVisitId=null;showToast(visit.previousVisitReview?.previousVisitId?'Visite créée : commencez par contrôler les actions précédentes.':'Visite créée.');}saveDatabase(db);clearDraft();editingVisitId=null;renderVisits();});
  document.getElementById('cancel-edit')?.addEventListener('click',()=>{editingVisitId=null;clearDraft();renderVisits();});
  const rerender=()=>{const y=window.scrollY;const table=app.querySelector('.visit-history-table');const x=table?.scrollLeft||0;const top=table?.scrollTop||0;renderVisits();requestAnimationFrame(()=>{window.scrollTo({top:y,behavior:'auto'});const t=app.querySelector('.visit-history-table');if(t){t.scrollLeft=x;t.scrollTop=top;}})};
  const visitSearch=document.getElementById('visit-search');if(visitSearch){visitSearch.addEventListener('input',e=>{localStorage.setItem('audit-bovin-visits-search',e.target.value);});visitSearch.addEventListener('change',rerender);visitSearch.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();rerender();}});}
  document.getElementById('visit-farm-filter')?.addEventListener('change',e=>{localStorage.setItem('audit-bovin-visits-farm',e.target.value);rerender()});
  document.getElementById('visit-status-filter')?.addEventListener('change',e=>{localStorage.setItem('audit-bovin-visits-status',e.target.value);rerender()});
  document.getElementById('reset-visit-filters')?.addEventListener('click',()=>{['audit-bovin-visits-search','audit-bovin-visits-farm','audit-bovin-visits-status'].forEach(k=>localStorage.removeItem(k));rerender()});
  app.querySelectorAll('[data-select-visit]').forEach(b=>b.onclick=()=>{const y=window.scrollY;setActiveVisit(b.dataset.selectVisit);app.querySelectorAll('.visit-history-table tbody tr').forEach(r=>r.classList.remove('active-history-row'));b.closest('tr')?.classList.add('active-history-row');requestAnimationFrame(()=>window.scrollTo({top:y,behavior:'auto'}));showToast(`Visite du ${formatDate(db.visits.find(v=>v.id===b.dataset.selectVisit)?.date||'')} sélectionnée. La liste reste à sa position.`);});app.querySelectorAll('[data-edit-visit]').forEach(b=>b.onclick=()=>{setActiveVisit(b.dataset.editVisit);editingVisitId=b.dataset.editVisit;clearDraft();renderVisits();document.getElementById('visit-form')?.scrollIntoView({block:'start'});});
  app.querySelectorAll('[data-open-animals]').forEach(b=>b.onclick=()=>{setActiveVisit(b.dataset.openAnimals);setView('animals')});
  app.querySelectorAll('[data-open-questionnaires]').forEach(b=>b.onclick=()=>{setActiveVisit(b.dataset.openQuestionnaires);setView('questionnaires')});
  app.querySelectorAll('[data-compare-visit]').forEach(b=>b.onclick=()=>{const v=db.visits.find(x=>x.id===b.dataset.compareVisit);if(!v)return;localStorage.setItem('audit-bovin-followup-farm',v.farmId);localStorage.setItem('audit-bovin-followup-visits',JSON.stringify([v.id]));setView('followup')});
  app.querySelectorAll('[data-share-visit]').forEach(b=>b.onclick=()=>shareVisitFile(db.visits.find(v=>v.id===b.dataset.shareVisit)));
  app.querySelectorAll('[data-export-visit]').forEach(b=>b.onclick=()=>{const visit=db.visits.find(v=>v.id===b.dataset.exportVisit);downloadJson(`${slugify(farmName(visit.farmId))}-${visit.date||'visite'}.json`,{schemaVersion:2,farm:db.farms.find(f=>f.id===visit.farmId),visit})});
  app.querySelectorAll('[data-delete-visit]').forEach(b=>b.onclick=()=>{const id=b.dataset.deleteVisit,visit=db.visits.find(v=>v.id===id);if(!visit)return;if(confirm(`Supprimer définitivement la visite du ${formatDate(visit.date)} pour ${farmName(visit.farmId)} ?\n\nElle sera aussi supprimée de la base commune.`)){db.deletedVisitIds=[...new Set([...(db.deletedVisitIds||[]),id])];db.visits=db.visits.filter(v=>v.id!==id);if(activeVisitId===id)setActiveVisit('');if(editingVisitId===id)editingVisitId=null;saveDatabase(db);showToast('Visite supprimée. La suppression sera synchronisée dans le cloud.');renderVisits();}});
  if(editVisit)bindPreviousVisitReview(editVisit);
}


// v14.6.21.12 — Pré-questionnaire éleveur / questions restantes
const farmerDocumentQuestions=[
  ['soil-analysis','Analyses de sol','Analyse de sol'],
  ['forage-analysis','Analyses de fourrages','Analyse de fourrage'],
  ['ration-analysis','Analyses de ration','Analyse de ration'],
  ['metabolic-profile','Bilans métaboliques / sanguins','Bilan métabolique'],
  ['feed-labels','Étiquettes / fiches techniques des aliments','Étiquette aliment'],
  ['mineral-labels','Étiquettes / fiches des minéraux','Étiquette minéral'],
  ['water-analysis','Analyses d’eau','Analyse eau'],
  ['parasite-analysis','Analyses parasitaires (coproscopie, strongles, douves, paramphistomes, coccidies…)','Analyse parasitaire']
];
const farmerQuestionnaireSections=[
  {id:'documents',title:'📎 Analyses et documents disponibles',default:true},
  {id:'sanitaire',title:'🩺 Sanitaire et gestion du troupeau',default:true},
  {id:'reproduction',title:'🐄 Conduite de la reproduction',default:true},
  {id:'jeunes',title:'🐮 Soins aux jeunes et conduite des veaux',default:true},
  {id:'pratiques',title:'📋 Pratiques d’élevage et conduite des lots',default:true},
  {id:'fourrages',title:'🌾 Fourrages et cultures',default:true},
  {id:'organisation',title:'👥 Organisation, travail et objectifs',default:true},
  {id:'partenaire',title:'💶 Données technico-économiques / partenaire',default:true},
  {id:'building',title:'🏠 Bâtiment — questions déclaratives',default:true},
  {id:'economics',title:'💶 Compléments économiques / résultat disponible',default:true}
];
function farmerQuestionId(prefix,value){return `${prefix}:${normalizeSearchText(value).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}`}
function farmerAuditQuestionSchema(q){
  const c=qConfig(q),type=c.type==='multi'?'multi':c.type==='select'?'select':c.type==='number'?'number':'textarea';
  return {id:farmerQuestionId('audit',q),label:q,type,options:c.options||[],unit:c.unit||'',target:{kind:'audit',question:q}};
}
function farmerBuildingQuestionSchema(group,q){return {id:farmerQuestionId('building',q),label:q,type:'select',options:['Oui','Non','Je ne sais pas','Non concerné'],target:{kind:'building',group,question:q},comment:true}}
function farmerDocumentQuestionSchema([id,label,category]){const extras=[{id:'date',label:'Date approximative / date de l’analyse',type:'date'}];if(id==='parasite-analysis')extras.push({id:'parasites',label:'Type si connu (coproscopie, strongles, douves, paramphistomes, coccidies, autre)',type:'text'},{id:'treatment',label:'Traitement antiparasitaire réalisé ensuite ? Produit / date si connu',type:'text'});return {id:`doc:${id}`,label,type:'availability',options:['Oui','Non','Je ne sais pas'],fileAllowed:true,extraFields:extras,target:{kind:'document',category},help:'Si oui, vous pouvez joindre le compte rendu, un PDF ou une photo.'}}
function farmerEconomicsQuestions(){return [
  {id:'econ:sanitaryRange',label:'Charges sanitaires annuelles — fourchette',type:'select',options:['< 2 000 €','2 000–5 000 €','5 000–10 000 €','10 000–20 000 €','> 20 000 €'],target:{kind:'economics',field:'sanitaryRange'}},
  {id:'econ:sanitaryAmount',label:'Charges sanitaires annuelles — montant exact si connu',type:'number',unit:'€',target:{kind:'economics',field:'sanitaryAmount'}},
  {id:'econ:resultType',label:'Indicateur économique disponible',type:'select',options:['EBE','Marge brute','Résultat courant','Résultat disponible','Autre'],target:{kind:'economics',field:'resultType'}},
  {id:'econ:annualResult',label:'Montant de l’indicateur économique',type:'number',unit:'€',target:{kind:'economics',field:'annualResult'}},
  {id:'org:pluriactive',label:'L’exploitation est-elle en situation de pluriactivité ?',type:'select',options:['Non','Oui'],target:{kind:'organization',field:'pluriactive'}},
  {id:'org:pluriactivityDetail',label:'Si oui : période / répartition / part du temps',type:'text',target:{kind:'organization',field:'pluriactivityDetail'}}
]}
function derivedAuditValue(visit,label){
  try{
    const snap=visitReproductionSnapshot(visit)||{},a=ensureAuditGlobal(visit),item=linkedHerdImportForVisit(visit),st=item?.current?.structure||{},mort=item?.years?.N?.mortality||{},rep=item?.years?.N?.reproduction||{};
    const direct=l=>partnerExcelNumber((a.answers?.[l]||{}).answer);
    const map={'Intervalle vêlage-vêlage':snap.ivvMean,'Âge moyen au premier vêlage':snap.firstCalvingAgeMean,'Mortalité veaux (%)':snap.calfMortalityRate,'Nombre moyen de vaches sur exercice':partnerExcelNumber(a.renewal.cowsTotal)||st.femalesOver36||snap.cows,'Brix colostrum':partnerAverageMeasure(visit,'colostrumBrix')};
    if(map[label]!==undefined&&map[label]!==null)return map[label];
    if(label==='Avortements (nombre/an)'&&rep.abortions!==undefined)return rep.abortions;
    if(label==='Mortalité adultes (%)'){const cows=partnerExcelNumber(a.renewal.cowsTotal)||st.femalesOver36||snap.cows||0,ad=partnerExcelNumber(mort.over24)||0;if(cows)return Math.round(ad/cows*1000)/10;}
    const sfp=direct('SFP (ha)'),cows=direct('Nombre moyen de vaches sur exercice')||partnerExcelNumber(a.renewal.cowsTotal)||st.femalesOver36||snap.cows||null,totalKg=direct('Total kg carcasse produits (kg / an)'),concCow=direct('Concentrés par vache (kg/an)');
    if(label==='Chargement (UGB/ha)'&&sfp){const src=reproductionSourceForVisit(visit,db.farms.find(f=>f.id===visit.farmId)),reg=(src.registry||[]).filter(x=>isRegistryAnimalPresent(x,visit.date));let ugb=0;for(const x of reg){const m=monthsBetweenDates(x.birthDate,visit.date);if(m==null)continue;ugb+=m>=24?1:m>=6?0.6:0.4;}if(!ugb&&cows)ugb=cows;return ugb?Math.round(ugb/sfp*100)/100:null;}
    if(label==='Kg viande/vache/an'&&totalKg&&cows)return Math.round(totalKg/cows*10)/10;
    if(label==='Kg viande/ha'&&totalKg&&sfp)return Math.round(totalKg/sfp*10)/10;
    if(label==='Concentrés/kg viande (kg/kg)'&&totalKg&&concCow&&cows)return Math.round((concCow*cows)/totalKg*100)/100;
    return null;
  }catch(e){return null}
}
function partnerSmartValue(visit,label){const raw=partnerAuditAnswer(visit,label);if(raw!==''&&raw!==null&&raw!==undefined)return raw;const d=derivedAuditValue(visit,label);return d===null||d===undefined?'':d;}

function answerAlreadyKnown(visit,q){
  const a=ensureAuditGlobal(visit),t=q.target||{};
  if(t.kind==='audit'){const x=a.answers[t.question]||{};return !!(x.answer||(Array.isArray(x.values)&&x.values.length)||x.comment)||derivedAuditValue(visit,t.question)!==null}
  if(t.kind==='building'){
    const contexts=Object.values(visit.buildingAudits||{});return contexts.some(x=>{const y=x?.questionnaire?.[t.question]||{};return !!(y.status||y.comment||y.farmerAnswer)});
  }
  if(t.kind==='economics')return !!a.economics?.[t.field];
  if(t.kind==='organization')return !!a.organization?.[t.field];
  return false;
}
function buildFarmerQuestionnaireSchema(visit,type,selectedIds,technicianNote=''){
  const farm=db.farms.find(f=>f.id===visit.farmId)||{},sections=[];
  const remaining=type==='remaining';
  const wanted=new Set(selectedIds||farmerQuestionnaireSections.filter(x=>x.default).map(x=>x.id));
  if(wanted.has('documents')){let qs=farmerDocumentQuestions.map(farmerDocumentQuestionSchema);if(remaining){const farmDocs=db.farms.find(f=>f.id===visit.farmId)?.documentAvailability||{};qs=qs.filter(q=>!farmDocs[q.target?.category]?.answer)}if(qs.length)sections.push({id:'documents',title:'📎 Analyses et documents disponibles',intro:'Indiquez les documents dont vous disposez. Si vous les avez, vous pouvez les joindre directement.',questions:qs});}
  auditGlobalSections.forEach(sec=>{if(!wanted.has(sec.id))return;let qs=sec.questions.map(farmerAuditQuestionSchema);/* Pré-visite et questions restantes : ne jamais redemander ce que les imports ou calculs ont déjà fourni. */qs=qs.filter(q=>!answerAlreadyKnown(visit,q));if(qs.length)sections.push({id:sec.id,title:`${sec.icon} ${sec.title}`,questions:qs})});
  if(wanted.has('building')){
    let qs=buildingQuestionGroups.flatMap(([group,questions])=>questions.map(q=>farmerBuildingQuestionSchema(group,q)));if(remaining)qs=qs.filter(q=>!answerAlreadyKnown(visit,q));
    if(qs.length)sections.push({id:'building',title:'🏠 Bâtiment — informations déclarées par l’éleveur',intro:'Ces réponses complètent la visite mais ne remplacent pas le constat du technicien sur place.',questions:qs});
  }
  if(wanted.has('economics')){let qs=farmerEconomicsQuestions();if(remaining)qs=qs.filter(q=>!answerAlreadyKnown(visit,q));if(qs.length)sections.push({id:'economics',title:'💶 Informations technico-économiques à compléter',questions:qs})}
  const baseIntro=type==='remaining'?'Merci de compléter uniquement les éléments encore manquants.':'Les effectifs, mouvements, mortalités et données de reproduction sont récupérés par import lorsqu’ils sont disponibles : ils ne sont donc pas redemandés ici.';
  const note=String(technicianNote||'').trim();
  return {version:2,type,farmName:farm.name||'',farmer:farm.farmer||farm.manager||'',visitDate:visit.date||'',visitId:visit.id,farmId:visit.farmId,title:type==='remaining'?'Questions restantes après la visite':'Pré-questionnaire de préparation de visite',intro:note?`${baseIntro}\n\nPoint(s) que le technicien souhaite revoir avec vous : ${note}`:baseIntro,technicianNote:note,sections};
}
function questionnaireCloudState(){
  try{const config=JSON.parse(localStorage.getItem('audit-bovin-supabase-config')||'null'),session=JSON.parse(localStorage.getItem('audit-bovin-supabase-session')||'null');return {config,session}}catch{return {config:null,session:null}}
}
async function sha256Hex(value){const data=new TextEncoder().encode(value),hash=await crypto.subtle.digest('SHA-256',data);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')}
function secureQuestionnaireToken(){const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function questionnaireAuthRequest(path,{method='GET',body}={}){
  const {config,session}=questionnaireCloudState();if(!config?.url||!config?.key)throw new Error('Supabase n’est pas configuré sur cet appareil.');if(!session?.access_token)throw new Error('Connectez-vous au cloud technicien avant de créer un questionnaire.');
  const res=await fetch(`${config.url}${path}`,{method,headers:{apikey:config.key,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body)}),text=await res.text();let data=null;try{data=text?JSON.parse(text):null}catch{data=text}if(!res.ok)throw new Error(data?.message||data?.hint||data?.details||String(data)||`Erreur ${res.status}`);return data;
}
function questionnairePublicLink(token){const {config}=questionnaireCloudState();const base=new URL('./questionnaire.html',location.href);base.searchParams.set('token',token);base.searchParams.set('url',config.url);base.searchParams.set('key',config.key);return base.toString()}
async function createFarmerQuestionnaire(visit,type,selectedIds,technicianNote=''){
  const token=secureQuestionnaireToken(),schema=buildFarmerQuestionnaireSchema(visit,type,selectedIds,technicianNote);if(!schema.sections.some(s=>s.questions.length))throw new Error('Aucune question à envoyer avec cette sélection.');
  const expires=new Date();expires.setDate(expires.getDate()+(type==='remaining'?30:14));const hash=await sha256Hex(token),createdBy=questionnaireCloudState().session?.user?.email||'';
  const rows=await questionnaireAuthRequest('/rest/v1/farmer_questionnaires',{method:'POST',body:{visit_id:visit.id,farm_id:visit.farmId,type,title:schema.title,schema,token_hash:hash,status:'sent',expires_at:expires.toISOString(),created_by:createdBy}}),row=Array.isArray(rows)?rows[0]:rows;
  visit.farmerQuestionnaires=Array.isArray(visit.farmerQuestionnaires)?visit.farmerQuestionnaires:[];visit.farmerQuestionnaires.push({id:row?.id||uid('questionnaire'),remoteId:row?.id||'',type,title:schema.title,status:'sent',createdAt:new Date().toISOString(),expiresAt:expires.toISOString(),token,link:questionnairePublicLink(token),questionCount:schema.sections.reduce((n,s)=>n+s.questions.length,0),responseIntegrated:false});visit.updatedAt=new Date().toISOString();saveDatabase(db);return visit.farmerQuestionnaires.at(-1);
}
async function fetchRemoteQuestionnaires(visit){return questionnaireAuthRequest(`/rest/v1/farmer_questionnaires?visit_id=eq.${encodeURIComponent(visit.id)}&select=id,visit_id,farm_id,type,title,status,schema,response,created_at,submitted_at,expires_at,updated_at&order=created_at.desc`)}
function mergeQuestionnaireRemoteMeta(visit,rows){visit.farmerQuestionnaires=Array.isArray(visit.farmerQuestionnaires)?visit.farmerQuestionnaires:[];for(const row of rows||[]){let local=visit.farmerQuestionnaires.find(x=>x.remoteId===row.id||x.id===row.id);if(!local){local={id:row.id,remoteId:row.id,type:row.type,title:row.title,createdAt:row.created_at,expiresAt:row.expires_at,token:'',link:'',questionCount:row.schema?.sections?.reduce((n,s)=>n+(s.questions?.length||0),0)||0,responseIntegrated:false};visit.farmerQuestionnaires.push(local)}Object.assign(local,{status:row.status||local.status,submittedAt:row.submitted_at||'',remoteResponse:row.response||null,remoteSchema:row.schema||null,expiresAt:row.expires_at||local.expiresAt})}saveDatabase(db)}
function appendFarmerComment(existing,value,submittedAt){const line=`[Éleveur ${submittedAt?formatDateTime(submittedAt):''}] ${value}`;return existing?`${existing}\n${line}`:line}
function integrateQuestionnaireResponse(visit,row){
  const response=row?.response||{},answers=response.answers||{},schema=row?.schema||{},audit=ensureAuditGlobal(visit),farm=db.farms.find(f=>f.id===visit.farmId);let integrated=0,docs=0;
  for(const sec of schema.sections||[])for(const q of sec.questions||[]){const a=answers[q.id];if(!a)continue;const hasValue=(a.value!==undefined&&a.value!==null&&a.value!=='')||(Array.isArray(a.values)&&a.values.length)||a.comment;if(!hasValue&&!a.attachments?.length)continue;const t=q.target||{};
    if(t.kind==='audit'){const item=audit.answers[t.question]=audit.answers[t.question]||{};if(Array.isArray(a.values)&&a.values.length)item.values=a.values;if(a.value!==undefined&&a.value!=='')item.answer=String(a.value);if(a.comment)item.comment=appendFarmerComment(item.comment,a.comment,row.submitted_at);item.farmerSource={questionnaireId:row.id,submittedAt:row.submitted_at};integrated++;}
    else if(t.kind==='building'){const ctx=currentBuildingContext();if(ctx.audit){const item=ctx.audit.questionnaire[t.question]=ctx.audit.questionnaire[t.question]||{};item.farmerAnswer=a.value||'';item.farmerSubmittedAt=row.submitted_at||'';if(a.comment)item.comment=appendFarmerComment(item.comment,a.comment,row.submitted_at);integrated++;}else{visit.farmerBuildingResponses=visit.farmerBuildingResponses||{};visit.farmerBuildingResponses[t.question]={answer:a.value||'',comment:a.comment||'',submittedAt:row.submitted_at};integrated++;}}
    else if(t.kind==='economics'){audit.economics[t.field]=a.value??'';integrated++;}
    else if(t.kind==='organization'){audit.organization[t.field]=a.value??'';integrated++;}
    if(t.kind==='document'&&farm){farm.documentAvailability=farm.documentAvailability||{};farm.documentAvailability[t.category]={answer:a.value||'',comment:a.comment||'',date:a.extras?.date||'',parasites:a.extras?.parasites||'',treatment:a.extras?.treatment||'',updatedAt:row.submitted_at||new Date().toISOString()};for(const f of a.attachments||[]){if(!f?.dataUrl)continue;ensureFarmDocuments(farm).push({id:uid('document'),category:t.category,title:f.title||q.label,documentDate:a.extras?.date||new Date().toISOString().slice(0,10),notes:`Transmis par l’éleveur via ${row.title||'questionnaire'}.${a.extras?.parasites?' Type : '+a.extras.parasites+'.':''}${a.extras?.treatment?' Traitement : '+a.extras.treatment+'.':''}${a.comment?' '+a.comment:''}`,fileName:f.fileName||'document',mimeType:f.mimeType||'application/octet-stream',size:f.size||0,dataUrl:f.dataUrl,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});docs++;}integrated++;}
  }
  const local=visit.farmerQuestionnaires?.find(x=>x.remoteId===row.id||x.id===row.id);if(local)local.responseIntegrated=true;visit.updatedAt=new Date().toISOString();if(farm)farm.updatedAt=new Date().toISOString();saveDatabase(db);return {integrated,docs};
}
function questionnaireStatusLabel(q){if(q.responseIntegrated)return '✓ Intégré';if(q.status==='submitted'||q.submittedAt)return '📥 Réponses reçues';if(q.expiresAt&&new Date(q.expiresAt)<new Date())return 'Expiré';return 'En attente'}
function questionnaireStatusClass(q){if(q.responseIntegrated)return 'complete';if(q.status==='submitted'||q.submittedAt)return 'in-progress';return ''}
async function shareQuestionnaire(q){if(!q.link)return showToast('Le lien d’origine n’est pas disponible sur cet appareil. Vous pouvez recréer un questionnaire.');try{if(navigator.share){await navigator.share({title:q.title,text:`${q.title} — Audit Bovin GDS 32-65`,url:q.link});return}}catch(e){if(e?.name==='AbortError')return}try{await navigator.clipboard.writeText(q.link);showToast('Lien copié dans le presse-papiers.')}catch{prompt('Copiez ce lien :',q.link)}}
function renderFarmerQuestionnaires(){
  const visit=activeVisit();if(!visit){renderNoActiveVisit('Questionnaires éleveur');return}const farm=db.farms.find(f=>f.id===visit.farmId)||{},qs=visit.farmerQuestionnaires||[],hasImported=!!visit.auditGlobal?.importedHerdData||!!visit.reproductionRegistry?.length;
  app.innerHTML=`<div class="section-title"><div><h2>📨 Questionnaires éleveur</h2><div class="muted">Préparer la visite puis récupérer uniquement les réponses encore manquantes.</div></div><span class="badge autosave">v14.6.21.68</span></div>${activeVisitBanner(visit)}
  <section class="card questionnaire-workflow"><h3>Organisation conseillée</h3><div class="questionnaire-steps"><span class="${hasImported?'done':''}"><b>1</b> Importer effectifs, mouvements, mortalité et reproduction</span><span><b>2</b> Envoyer le pré-questionnaire</span><span><b>3</b> Réaliser la visite</span><span><b>4</b> Envoyer les questions restantes si besoin</span></div>${hasImported?'<div class="notice"><strong>✓ Des données ont déjà été importées.</strong> Elles ne seront pas redemandées à l’éleveur.</div>':'<div class="notice warning"><strong>Conseil :</strong> faites d’abord les imports disponibles afin d’éviter de demander à l’éleveur des données déjà connues.</div>'}</section>
  <section class="grid cols-2"><article class="card"><h3>📤 Pré-questionnaire</h3><p>À envoyer avant la visite. Les analyses et documents disponibles sont proposés en premier.</p><div class="questionnaire-section-selector">${farmerQuestionnaireSections.map(x=>`<label><input type="checkbox" data-fq-section value="${x.id}" ${x.default?'checked':''}><span>${x.title}</span></label>`).join('')}</div><div class="actions"><button class="btn primary" id="create-pre-questionnaire">Créer et partager</button><button class="btn secondary" id="print-pre-questionnaire">Support papier pré-visite</button></div></article><article class="card"><h3>📤 Questionnaire post-visite / éléments manquants</h3><p>À envoyer après la visite si des documents, valeurs économiques, étiquettes ou précisions manquent. Seules les informations encore non renseignées sont proposées.</p><div class="questionnaire-section-selector">${farmerQuestionnaireSections.map(x=>`<label><input type="checkbox" data-fq-remaining-section value="${x.id}" ${x.default?'checked':''}><span>${x.title}</span></label>`).join('')}</div><div class="field" style="margin-top:12px"><label>Point(s) à revoir avec l’éleveur — facultatif</label><textarea id="remaining-questionnaire-note" rows="3" placeholder="Ex. Revoir la distribution d’eau au lot des taries, préciser le changement de ration…"></textarea><small class="muted">Ce commentaire apparaîtra en introduction du questionnaire envoyé à l’éleveur.</small></div><div class="actions"><button class="btn primary" id="create-remaining-questionnaire">Créer le post-visite</button><button class="btn secondary" id="print-terrain-support">Support papier terrain</button></div></article></section>
  <section class="card"><div class="section-title"><div><h3>Questionnaires de cette visite</h3><div class="muted">${escapeHtml(farm.name||'')} · ${formatDate(visit.date)}</div></div><button class="btn secondary" id="refresh-questionnaires">Actualiser les réponses</button></div><div id="questionnaire-list">${qs.length?qs.slice().sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(q=>`<article class="questionnaire-card"><div><span class="badge ${questionnaireStatusClass(q)}">${questionnaireStatusLabel(q)}</span><h4>${escapeHtml(q.title||q.type)}</h4><small>${q.questionCount||'—'} question(s) · créé le ${formatDateTime(q.createdAt)}${q.expiresAt?` · expire le ${formatDate(q.expiresAt)}`:''}</small></div><div class="actions">${q.link?`<button class="btn small" data-share-questionnaire="${q.id}">Partager le lien</button>`:''}${q.status==='submitted'||q.submittedAt?`<button class="btn small primary" data-integrate-questionnaire="${q.remoteId||q.id}">${q.responseIntegrated?'Réintégrer':'Vérifier et intégrer'}</button>`:''}</div></article>`).join(''):'<div class="empty">Aucun questionnaire créé pour cette visite.</div>'}</div></section>`;
  document.getElementById('print-pre-questionnaire')?.addEventListener('click',()=>printQuestionnaireSupport(visit,'pre'));document.getElementById('print-terrain-support')?.addEventListener('click',()=>printQuestionnaireSupport(visit,'terrain'));document.getElementById('create-pre-questionnaire').onclick=async()=>{const ids=[...app.querySelectorAll('[data-fq-section]:checked')].map(x=>x.value);try{const q=await createFarmerQuestionnaire(visit,'pre',ids);showToast('Pré-questionnaire créé.');await shareQuestionnaire(q);renderFarmerQuestionnaires()}catch(e){showToast(`Création impossible : ${e.message}`)}};
  document.getElementById('create-remaining-questionnaire').onclick=async()=>{const ids=[...app.querySelectorAll('[data-fq-remaining-section]:checked')].map(x=>x.value),note=document.getElementById('remaining-questionnaire-note')?.value||'';try{const q=await createFarmerQuestionnaire(visit,'remaining',ids,note);showToast('Questionnaire des éléments manquants créé.');await shareQuestionnaire(q);renderFarmerQuestionnaires()}catch(e){showToast(`Création impossible : ${e.message}`)}};
  document.getElementById('refresh-questionnaires').onclick=async()=>{try{const rows=await fetchRemoteQuestionnaires(visit);mergeQuestionnaireRemoteMeta(visit,rows);showToast('Statuts actualisés.');renderFarmerQuestionnaires()}catch(e){showToast(`Actualisation impossible : ${e.message}`)}};
  app.querySelectorAll('[data-share-questionnaire]').forEach(b=>b.onclick=()=>shareQuestionnaire(qs.find(q=>q.id===b.dataset.shareQuestionnaire)));
  app.querySelectorAll('[data-integrate-questionnaire]').forEach(b=>b.onclick=async()=>{try{const rows=await fetchRemoteQuestionnaires(visit),row=rows.find(x=>x.id===b.dataset.integrateQuestionnaire);if(!row?.response)return showToast('Aucune réponse reçue.');const preview=(row.schema?.sections||[]).map(sec=>`${sec.title} : ${(sec.questions||[]).filter(q=>{const a=row.response?.answers?.[q.id];return a&&(a.value||a.comment||a.values?.length||a.attachments?.length)}).length} réponse(s)`).join('\n');if(!confirm(`Intégrer les réponses reçues ?\n\n${preview}\n\nLes réponses déclaratives bâtiment seront identifiées comme telles et ne remplacent pas le constat du technicien.`))return;const r=integrateQuestionnaireResponse(visit,row);showToast(`${r.integrated} réponse(s) intégrée(s)${r.docs?` · ${r.docs} document(s) ajouté(s)`:''}.`);mergeQuestionnaireRemoteMeta(visit,rows);const local=visit.farmerQuestionnaires.find(x=>x.remoteId===row.id||x.id===row.id);if(local)local.responseIntegrated=true;saveDatabase(db);renderFarmerQuestionnaires()}catch(e){showToast(`Intégration impossible : ${e.message}`)}});
}


function printQuestionnaireSupport(visit,mode){
 const title=mode==='pre'?'Pré-questionnaire / documents à préparer':'Support terrain / questions & mesures';
 const sections=mode==='pre'?buildFarmerQuestionnaireSchema(visit,'pre',farmerQuestionnaireSections.filter(x=>x.default).map(x=>x.id)).sections:auditGlobalSections;
 const body=mode==='pre'?sections.map(sec=>`<h2>${escapeHtml(sec.title)}</h2><ul>${(sec.questions||[]).map(q=>`<li><b>${escapeHtml(q.label)}</b><div class="line"></div></li>`).join('')}</ul>`).join(''):auditGlobalSections.map(sec=>`<h2>${sec.icon} ${escapeHtml(sec.title)}</h2>${sec.questions.map(q=>{const m=auditQuestionSource(q);return `<div class="paper-q"><span class="source-badge ${m.key}">${m.label}</span><b>${escapeHtml(q)}</b><div class="line"></div></div>`}).join('')}`).join('');
 const w=window.open('','_blank');if(!w)return showToast('Autorisez les fenêtres surgissantes.');w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;padding:20px;color:#222}h1{color:#b12c67}h2{margin-top:22px;border-bottom:2px solid #ddd;padding-bottom:4px}.line{height:26px;border-bottom:1px solid #aaa;margin:4px 0 8px}.paper-q{margin:10px 0}.source-badge{display:inline-block;padding:3px 7px;border-radius:12px;margin-right:6px;font-size:11px}.ask{background:#e8f1ff}.measure{background:#fff1d9}.later{background:#f1e7ff}.calc{background:#e5f7e8}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Imprimer / PDF</button><h1>${escapeHtml(title)}</h1>${body}</body></html>`);w.document.close();
}


function preparedQuestionValue(visit,label){
  const direct=partnerAuditAnswer(visit,label);if(direct!==''&&direct!=null)return direct;
  const farm=db.farms.find(f=>f.id===visit.farmId),item=linkedHerdImportForVisit(visit),mort=item?.years?.N?.mortality||{},rep=item?.years?.N?.reproduction||{},st=item?.current?.structure||{};
  const map={
    'Mortalité veaux (%)': mort.calfMortalityRate??mort.calvesRate??'',
    'Mortalité adultes (%)': mort.adultMortalityRate??mort.cowsRate??'',
    'Nombre moyen de vaches sur exercice': st.femalesOver36??'',
  };
  if(map[label]!==undefined&&map[label]!=='')return map[label];
  return '';
}
function paperWindow(title,body){
  const w=window.open('','_blank');if(!w)return showToast('Autorisez les fenêtres surgissantes.');
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;color:#222;padding:16px;max-width:1050px;margin:auto}h1{color:#b53670}h2{border-bottom:2px solid #ddd;padding-bottom:5px;margin-top:22px}.toolbar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #ddd}.toolbar button{margin-right:8px}.q{padding:8px 0;border-bottom:1px solid #eee}.known{background:#eef8f0;padding:4px 7px;border-radius:6px}.line{height:26px;border-bottom:1px solid #aaa}.source{font-size:11px;font-weight:bold;padding:2px 6px;border-radius:10px;margin-right:5px}.ask{background:#e8f1ff}.measure{background:#fff0d5}.later{background:#f2e7ff}.calc{background:#e5f7e8}.print-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0 16px}.print-metric{border:1px solid #ddd;border-radius:8px;padding:8px;text-align:center;break-inside:avoid}.print-metric strong{display:block;font-size:18px;color:#b53670}.print-metric span{display:block;font-weight:bold;font-size:9pt;margin-top:3px}.print-metric small{display:block;color:#666;margin-top:2px}.period-alert{border-left:4px solid #d36b2c;background:#fff7ed;padding:8px 10px;margin:7px 0;break-inside:avoid}.notes{border:1px solid #bbb;min-height:110px;padding:8px;margin-top:12px}table{width:100%;border-collapse:collapse;font-size:9pt}th,td{border:1px solid #ccc;padding:5px;text-align:left}@media print{.toolbar{display:none}.q{break-inside:avoid}}</style></head><body><div class="toolbar"><button onclick="window.print()">🖨️ Imprimer / PDF</button><button onclick="window.close()">↩ Fermer / retour audit</button></div>${body}</body></html>`);w.document.close();try{w.focus()}catch(e){};
}
function preparedAuditBody(visit,blank=false){return `<h1>${blank?'Support papier complet vierge':'Support papier complet préparé'}</h1>${activeFarmNameForPrint(visit)}${fullVisitPaperHtml(visit,!blank)}`;}
function activeFarmNameForPrint(visit){const f=db.farms.find(x=>x.id===visit.farmId);return `<p><b>Exploitation :</b> ${escapeHtml(f?.name||'—')} &nbsp; <b>Visite :</b> ${formatDate(visit.date)}</p>`}
function printPreparedAudit(blank=false){const v=activeVisit();if(!v)return showToast('Ouvrez une visite.');printAuditDocument(v,blank?'full-blank':'full-prepared');}
function workNumberSortValue(v){const s=String(v??'').trim();const m=s.match(/\d+/g);return m?Number(m.join('')):Number.MAX_SAFE_INTEGER;}
function sortByWorkNumber(a,b){const av=workNumberSortValue(a?.workNumber||a?.tag||a?.id),bv=workNumberSortValue(b?.workNumber||b?.tag||b?.id);return av-bv||String(a?.workNumber||a?.id||'').localeCompare(String(b?.workNumber||b?.id||''),'fr',{numeric:true});}
function printReproMortalityPrep(){
  const v=activeVisit();if(!v)return;
  const f=db.farms.find(x=>x.id===v.farmId),x=reproPreparationSnapshot(v,f),item=linkedHerdImportForVisit(v);
  if(!x){paperWindow('Bilan reproduction et mortalité',`<h1>Bilan préparatoire — reproduction & mortalité</h1>${activeFarmNameForPrint(v)}<div class="notice warning">Aucun registre bovins avec mouvements n’est disponible pour cette visite. Importez le registre dans Préparation → Imports / technico-éco.</div>`);return;}
  const meanIVV=x.cows.filter(r=>r.meanIVV!=null).length?Math.round(x.cows.filter(r=>r.meanIVV!=null).reduce((a,r)=>a+r.meanIVV,0)/x.cows.filter(r=>r.meanIVV!=null).length):null;
  const firstAges=x.cows.map(r=>r.firstCalvingAgeMonths).filter(n=>n!=null),firstMean=firstAges.length?Math.round(firstAges.reduce((a,b)=>a+b,0)/firstAges.length*10)/10:null;
  const paternityAll=x.allBirths.length?Math.round(x.fatherKnownAll/x.allBirths.length*1000)/10:null,paternity12=x.births.length?Math.round(x.fatherKnown/x.births.length*1000)/10:null;
  const pct=(n,d)=>d?Math.round(n/d*1000)/10:null;
  const metric=(label,value,sub='')=>`<div class="print-metric"><strong>${value==null||value===''?'—':escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span>${sub?`<small>${escapeHtml(sub)}</small>`:''}</div>`;
  const ageVals=x.females24.map(a=>({a,m:monthsBetweenDates(a.birthDate,x.date)})).filter(z=>z.m!=null),ageMean=ageVals.length?Math.round(ageVals.reduce((n,z)=>n+z.m,0)/ageVals.length/12*10)/10:null,ageMax=ageVals.length?Math.max(...ageVals.map(z=>z.m)):null,oldest=ageMax==null?[]:ageVals.filter(z=>z.m===ageMax).map(z=>z.a);const structure=`<h2>1. Structure du troupeau à la date de visite</h2><div class="print-metrics">${metric('Animaux présents',x.present.length)}${metric('Femelles >24 mois',x.females24.length)}${metric('Femelles >36 mois',x.females36.length)}${metric('Mâles >24 mois',x.males24.length)}${metric('Mâles >36 mois',x.males36.length)}${metric('Femelles >36 mois sans vêlage',x.heifers36.length,'alerte prioritaire')}${metric('Naissances sur 12 mois',x.births.length,`${formatDate(x.startIso)} → ${formatDate(x.date)}`)}${metric('Âge moyen femelles ≥24m',ageMean==null?'—':String(ageMean).replace('.',',')+' ans')}${metric('Âge maximum',ageMax==null?'—':Math.floor(ageMax/12)+' a '+ageMax%12+' m',oldest.map(a=>a.name||a.workNumber||a.id).join(', '))}</div>`;
  const repro=`<h2>2. Reproduction — indicateurs calculés</h2><div class="print-metrics">${metric('Vaches avec vêlage',x.cows.length)}${metric('Vaches avec IVV calculable',x.cows.filter(r=>r.meanIVV!=null).length)}${metric('IVV moyen',meanIVV==null?'—':meanIVV+' j')}${metric('IVV ≤400 j',x.ivvLe400.length)}${metric('IVV 401–450 j',x.ivv401to450.length)}${metric('IVV 451–500 j',x.ivv451to500.length)}${metric('IVV >500 j',x.ivvOver500.length)}${metric('Âge moyen au 1er vêlage',firstMean==null?'—':firstMean+' mois')}${metric('Vaches à problème',x.cowProblems.length)}</div>`;
  const mortality=`<h2>3. Mortalité</h2><div class="print-metrics">${metric('Veaux suivis',x.calves.length)}${metric('Veaux morts <6 mois',x.dead6.length)}${metric('Mortalité veaux <6 mois',pct(x.dead6.length,x.calves.length)==null?'—':pct(x.dead6.length,x.calves.length)+' %')}</div>`;
  const periods=['N','N-1','N-2'];
  const annual=item?`<h3>Historique technico-économique importé</h3><table><thead><tr><th>Indicateur</th>${periods.map(p=>`<th>${p}</th>`).join('')}</tr></thead><tbody>
    <tr><td>Naissances</td>${periods.map(p=>`<td>${item.years?.[p]?.births??'—'}</td>`).join('')}</tr>
    <tr><td>Mortalité totale</td>${periods.map(p=>`<td>${item.years?.[p]?.mortality?.total??'—'}</td>`).join('')}</tr>
    <tr><td>Taux mortalité jeunes &lt;12m</td>${periods.map(p=>`<td>${item.years?.[p]?.mortality?.youngRate??'—'}${item.years?.[p]?.mortality?.youngRate!=null?' %':''}</td>`).join('')}</tr>
    <tr><td>Morts 0–48 h</td>${periods.map(p=>`<td>${item.years?.[p]?.mortality?.h0_48??'—'}</td>`).join('')}</tr>
    <tr><td>Morts 1–6 mois</td>${periods.map(p=>`<td>${item.years?.[p]?.mortality?.m1_6??'—'}</td>`).join('')}</tr>
    <tr><td>Âge au 1er vêlage</td>${periods.map(p=>`<td>${item.years?.[p]?.reproduction?.firstCalvingAge??'—'}</td>`).join('')}</tr>
    <tr><td>IVV moyen</td>${periods.map(p=>`<td>${item.years?.[p]?.reproduction?.ivv??'—'}${item.years?.[p]?.reproduction?.ivv!=null?' j':''}</td>`).join('')}</tr>
    <tr><td>Vaches IVV &gt;390 j</td>${periods.map(p=>`<td>${item.years?.[p]?.reproduction?.ivv390??'—'}</td>`).join('')}</tr>
    <tr><td>Vaches IVV &gt;420 j</td>${periods.map(p=>`<td>${item.years?.[p]?.reproduction?.ivv420??'—'}</td>`).join('')}</tr>
    <tr><td>Avortements</td>${periods.map(p=>`<td>${item.years?.[p]?.reproduction?.abortions??'—'}</td>`).join('')}</tr>
    <tr><td>Productivité numérique</td>${periods.map(p=>`<td>${item.years?.[p]?.reproduction?.productivity??'—'}</td>`).join('')}</tr>
    </tbody></table>${item.current?.unproductiveFemales!=null?`<p><b>Femelles improductives (fichier technico-éco) :</b> ${escapeHtml(String(item.current.unproductiveFemales))}</p>`:''}`:`<p class="muted">Aucun historique technico-économique annuel lié à cette visite.</p>`;
  const paternity=`<h2>4. Paternité — uniquement lorsqu’elle est renseignée</h2><p><b>Couverture de la paternité :</b> ${paternityAll==null?'—':paternityAll+' %'} sur l’historique complet · ${paternity12==null?'—':paternity12+' %'} sur les 12 derniers mois. L’absence de paternité n’est pas interprétée comme une anomalie.</p>${x.sires.length?`<table><thead><tr><th>Taureau ayant figuré dans l’exploitation</th><th>Présent actuellement</th><th>Veaux attribués<br>historique complet</th><th>Mères distinctes</th><th>Part des mères attribuées</th><th>1re naissance</th><th>Dernière naissance</th></tr></thead><tbody>${x.sires.map(s=>`<tr><td><b>${escapeHtml(s.name||s.workNumber||s.fatherId)}</b><br><small>${s.workNumber?`N° travail ${escapeHtml(s.workNumber)} · `:''}${escapeHtml(s.fatherId||'')}</small></td><td>${s.present?'Oui':'Non'}</td><td>${s.calves}</td><td>${s.mothersCount}</td><td>${s.pctFemales==null?'—':s.pctFemales+' %'}</td><td>${s.firstBirth?formatDate(s.firstBirth):'—'}</td><td>${s.lastBirth?formatDate(s.lastBirth):'—'}</td></tr>`).join('')}</tbody></table>`:'<p>Aucun père correspondant à un mâle ayant figuré dans le registre de l’exploitation.</p>'}<p><b>Taureaux/pères IA ou jamais présents dans le registre :</b> ${x.aiSireCount}. Ils sont comptés mais non détaillés.</p><p class="muted"><i>La part des mères attribuées n’est pas un taux de saillies : les saillies sans naissance ne sont pas connues dans le registre.</i></p>`;
  const problems=`<h2>5. Vaches à problèmes</h2><table><thead><tr><th>N° travail / animal</th><th>Score</th><th>Pourquoi ce score ?</th><th>Âge</th><th>Dernier vêlage</th><th>Jours depuis vêlage</th><th>IVV moyen</th><th>IVV complet</th><th>1er vêlage</th><th>Veaux morts &lt;6m</th></tr></thead><tbody>${x.cowProblems.map(r=>{const sd=reproductionScoreDetails(r),why=sd.lines.filter(z=>z.delta<0).map(z=>`${z.label} (${z.delta} pt${z.delta<-1?'s':''})`).join(' · ')||'Aucune pénalité calculée';return `<tr><td><b>${escapeHtml(r.cow.workNumber||r.cow.id)}</b>${r.cow.name?` · ${escapeHtml(r.cow.name)}`:''}<br><small>${escapeHtml(r.cow.id||'')}</small></td><td><b>${sd.score}/100</b></td><td>${escapeHtml(why)}</td><td>${escapeHtml(ageLabelAt(r.cow.birthDate,x.date)||'—')}</td><td>${r.lastCalvingDate?formatDate(r.lastCalvingDate):'—'}</td><td>${r.daysSinceLast??'—'}</td><td>${r.meanIVV??'—'}</td><td>${r.intervals?.length?r.intervals.join(' / ')+' j':'—'}</td><td>${r.firstCalvingAgeMonths??'—'}${r.firstCalvingAgeMonths!=null?' mois':''}</td><td>${(r.deadBefore6||[]).length}</td></tr>`}).join('')||'<tr><td colspan="10">Aucune alerte selon les critères actuels.</td></tr>'}</tbody></table>`;
  const heifers=`<h2>6. Femelles &gt;36 mois sans vêlage</h2>${x.heifers36.length?`<table><thead><tr><th>N° travail / animal</th><th>Date naissance</th><th>Âge</th><th>Race</th><th>Date entrée</th></tr></thead><tbody>${x.heifers36.slice().sort(sortByWorkNumber).map(a=>`<tr><td><b>${escapeHtml(a.workNumber||a.id)}</b>${a.name?` · ${escapeHtml(a.name)}`:''}<br><small>${escapeHtml(a.id||'')}</small></td><td>${a.birthDate?formatDate(a.birthDate):'—'}</td><td>${escapeHtml(ageLabelAt(a.birthDate,x.date)||'—')}</td><td>${escapeHtml(a.breed||'—')}</td><td>${a.entryDate?formatDate(a.entryDate):'—'}</td></tr>`).join('')}</tbody></table>`:'<p>Aucune femelle &gt;36 mois sans vêlage détectée.</p>'}`;
  const chrono=`<h2>7. Chronologie des performances — analyse croisée</h2><p>Seules les dégradations suffisamment nettes sont remontées. Les fluctuations trimestrielles mineures ne sont pas imprimées.</p>${reproChronologyInsightHtml(x.chrono||{buckets:[]},{print:true})}`;
  const ez=prepEconomicSnapshot(v,f),euro=n=>Math.round(n||0).toLocaleString('fr-FR')+' €';const economics=ez?`<h2>8. Gestion économique — estimation pré-visite</h2><p><b>Total minimum estimé :</b> ${euro(ez.total)}. Chiffrage partiel : mortalité veaux au-dessus du repère, décès bovins ≥24 mois et jours d’IVV au-delà de la cible.</p><table><thead><tr><th>Poste</th><th>Base</th><th>Estimation</th></tr></thead><tbody><tr><td>Mortalité veaux excédentaire</td><td>${ez.dead}/${ez.births} · repère ${ez.target}% · valeur veau ${euro(ez.calfValue)}</td><td>${euro(ez.calfLoss)}</td></tr><tr><td>Décès bovins ≥24 mois</td><td>${ez.adultDeaths.length} décès</td><td>${euro(ez.adultLoss)}</td></tr><tr><td>Décalage IVV</td><td>${ez.excessIvvDays} jours excédentaires ≈ ${ez.missingCalfEq.toFixed(2).replace('.',',')} veau(x)</td><td>${euro(ez.ivvLoss)}</td></tr></tbody></table><p class="muted"><i>Non inclus : surcoût alimentaire des jours improductifs, frais vétérinaires, traitements, analyses, main-d’œuvre, baisse de croissance et autres conséquences indirectes.</i></p>`:'';const toClarify=`<h2>9. Points à éclaircir pendant l’audit</h2>${questions.length?`<ul>${questions.map(q=>`<li>${escapeHtml(q)}</li>`).join('')}</ul>`:'<p>Aucun point automatique supplémentaire détecté.</p>'}<div class="notes"><b>Notes technicien :</b><br><br><br><br><br></div>`;
  const body=`<h1>Bilan préparatoire — reproduction, mortalité, économie & chronologie des performances</h1>${activeFarmNameForPrint(v)}<p><b>Objectif :</b> analyser les données disponibles avant la visite, repérer ce qui cloche et depuis quand, chiffrer les enjeux déjà objectivables, puis utiliser l’entretien éleveur pour expliquer les anomalies.</p>${structure}${repro}${mortality}${annual}${paternity}${problems}${heifers}${chrono}${economics}${toClarify}`;
  paperWindow('Bilan préparatoire reproduction, mortalité et chronologie',body)
}
function printPresentAnimals(){const v=activeVisit();if(!v)return;const f=db.farms.find(x=>x.id===v.farmId),src=reproductionSourceForVisit(v,f),reg=(src.registry||[]).filter(a=>isRegistryAnimalPresent(a,v.date)).sort(sortByWorkNumber),rf={...f,herdRegistry:src.registry||[]};const rows=reg.map(a=>{const r=reproductionForCow(rf,a.id);return `<tr><td><b>${escapeHtml(a.workNumber||'')}</b></td><td>${escapeHtml(a.id)}</td><td>${escapeHtml(a.name||'')}</td><td>${escapeHtml(ageLabelAt(a.birthDate,v.date)||'—')}</td><td>${escapeHtml(a.breed||'—')}</td><td>${r?.lastCalvingDate?formatDate(r.lastCalvingDate):'—'}</td><td>${r?.meanIVV??'—'}</td><td>${r?.calves?.length??0}</td></tr>`}).join('');paperWindow('Animaux présents',`<h1>Listing des animaux présents</h1>${activeFarmNameForPrint(v)}<p><b>Classement :</b> n° de travail croissant.</p><table><thead><tr><th>N° travail</th><th>Boucle</th><th>Nom</th><th>Âge</th><th>Race</th><th>Dernier vêlage</th><th>IVV moyen</th><th>Rang / veaux</th></tr></thead><tbody>${rows||'<tr><td colspan="8">Aucun registre présent disponible.</td></tr>'}</tbody></table>`)}
function renderPreparationPrints(){const v=activeVisit();if(!v){renderNoActiveVisit('Documents imprimables');return}app.innerHTML=`<div class="section-title"><div><h2>🖨️ Documents imprimables — préparation de visite</h2><div class="muted">Supports papier complets pour une visite réalisable sans tablette et conçus pour faciliter la relecture / transcription automatique.</div></div><span class="badge autosave">v14.6.21.68</span></div>${activeVisitBanner(v)}<section class="print-prep-grid"><article class="card print-prep-card"><h3>📄 Modèle vierge complet</h3><p>Toutes les questions, cases à cocher, questionnaire bâtiment, tableaux de prélèvements, grille de mesures, alimentation, mortalité, achats et ventes. Aucune donnée de l’exploitation.</p><button class="btn" id="pp-blank">Ouvrir / imprimer</button></article><article class="card print-prep-card"><h3>📝 Support préparé complet</h3><p>Même trame que le modèle vierge, mais avec les réponses, calculs et données déjà connus préremplis / cochés quand c’est possible.</p><button class="btn" id="pp-prepared">Ouvrir / imprimer</button></article><article class="card print-prep-card"><h3>🐄 Bilan préparatoire repro + mortalité</h3><p>Tableau de bord complet, paternité, historique technico-éco, vaches à problèmes, femelles &gt;36 mois sans vêlage et chronologie des performances.</p><button class="btn" id="pp-repro">Ouvrir / imprimer</button></article><article class="card print-prep-card"><h3>📋 Animaux présents</h3><p>Uniquement les animaux présents, classés par n° de travail.</p><button class="btn" id="pp-animals">Ouvrir / imprimer</button></article></section><section class="card"><h3>📷 Import d’un audit papier</h3><div class="paper-import-zone"><p>Photographiez ou joignez le formulaire papier. Les codes courts imprimés devant les questions et la structure stable des cases facilitent la future relecture/transcription automatique.</p><input id="paper-audit-file" type="file" accept="image/*,.pdf,application/pdf" capture="environment"><div id="paper-audit-info" class="muted" style="margin-top:8px"></div><p class="muted small-text">La reconnaissance automatique de l’écriture manuscrite dépend d’un moteur OCR compatible. Toute valeur reconnue devra rester validable avant intégration.</p></div></section>`;document.getElementById('pp-blank').onclick=()=>printPreparedAudit(true);document.getElementById('pp-prepared').onclick=()=>printPreparedAudit(false);document.getElementById('pp-repro').onclick=printReproMortalityPrep;document.getElementById('pp-animals').onclick=printPresentAnimals;document.getElementById('paper-audit-file').onchange=async(e)=>{const file=e.target.files?.[0];if(!file)return;v.paperAudits=Array.isArray(v.paperAudits)?v.paperAudits:[];const rec={id:uid('paper'),name:file.name,type:file.type,size:file.size,createdAt:new Date().toISOString(),ocrText:'',dataUrl:''};if(file.size<=4*1024*1024){try{rec.dataUrl=await new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(file)})}catch{}}if(file.type.startsWith('image/')&&'TextDetector' in window){try{const bmp=await createImageBitmap(file),det=new TextDetector(),blocks=await det.detect(bmp);rec.ocrText=blocks.map(x=>x.rawValue||'').filter(Boolean).join('\n')}catch{}}v.paperAudits.unshift(rec);saveDatabase(db);document.getElementById('paper-audit-info').innerHTML=`<strong>✓ ${escapeHtml(file.name)}</strong> enregistré pour cette visite.${rec.ocrText?'<br>Texte détecté automatiquement : à vérifier avant toute intégration.':'<br>Aucun OCR natif disponible sur ce navigateur : le scan reste joint à la visite.'}`;};}

function initLegacyStaticSearch(){const btn=document.getElementById('global-search-btn'),dlg=document.getElementById('global-search-dialog'),inp=document.getElementById('global-search-input'),out=document.getElementById('global-search-results');if(!btn||!dlg)return;const entries=[...document.querySelectorAll('[data-view]')].map(b=>({view:b.dataset.view,label:(b.textContent||'').trim(),group:b.closest('.utility-nav')?'Outils':'Navigation'})).filter((x,i,a)=>x.view&&a.findIndex(y=>y.view===x.view)===i);const extras=[['audit','Mortalité, diarrhées, mammites, boiteries, omphalites, avortements, sanitaire'],['feeding','Minéraux, ration, aliments, étiquettes'],['building','Bâtiment, eau, abreuvoirs, redox, électricité'],['reproduction','IVV, vêlage, vaches à problèmes, mortalité veaux'],['study','Factures, analyses, intervenants, temps'],['economy','Marge de progrès, bénéfice, coût, GMQ'],['prepprint','Imprimer, support papier, animaux présents']];extras.forEach(([v,t])=>{const e=entries.find(x=>x.view===v);if(e)e.keywords=t});const render=()=>{const q=normalizeSearchText(inp.value);const r=entries.filter(e=>!q||normalizeSearchText(`${e.label} ${e.keywords||''}`).includes(q));out.innerHTML=r.map(e=>`<button class="global-search-result" data-search-view="${e.view}"><span><b>${escapeHtml(e.label)}</b><small>${escapeHtml(e.keywords||e.group)}</small></span><span>→</span></button>`).join('')||'<div class="empty">Aucun résultat.</div>';out.querySelectorAll('[data-search-view]').forEach(b=>b.onclick=()=>{dlg.close();setView(b.dataset.searchView)})};btn.onclick=()=>{dlg.showModal();inp.value='';render();setTimeout(()=>inp.focus(),30)};document.getElementById('global-search-close').onclick=()=>dlg.close();inp.oninput=render;}

function initAccordionMemory(){const key='audit-bovin-open-details-v35';let state={};try{state=JSON.parse(localStorage.getItem(key)||'{}')}catch{};const idFor=d=>normalizeSearchText(d.querySelector('summary')?.textContent||'').slice(0,120);const restore=root=>root.querySelectorAll?.('details').forEach(d=>{const id=idFor(d);if(id&&state[id]===true)d.open=true});document.addEventListener('toggle',e=>{const d=e.target;if(!(d instanceof HTMLDetailsElement))return;const id=idFor(d);if(!id)return;state[id]=d.open;localStorage.setItem(key,JSON.stringify(state))},true);new MutationObserver(m=>m.forEach(x=>x.addedNodes.forEach(n=>{if(n.nodeType===1){if(n.matches?.('details'))restore(n.parentElement||document);else restore(n)}}))).observe(document.getElementById('app'),{childList:true,subtree:true});restore(document)}

function classificationCompleteness(subject) {
  const fields = [subject.category, subject.stage, subject.age, subject.rank, subject.lot];
  return fields.filter(value => value && !['Non classé', 'Non renseigné'].includes(value)).length;
}

function measurementStatus(subject, key) {
  const analysis = subject.measurements?.analysis || {};
  const observations = subject.measurements?.observations || {};
  const familyKeys = {
    urine: ['urineColor','urinePH','urineRedox','urineBrix','urineDensity'],
    blood: ['glucose','boh','bloodPH','urea'],
    feces: ['fecesPH','fecesRedox'],
    physical: ['nec'],
    milk: ['milkPH','milkBrix'],
    colostrum: ['colostrumBrix','colostrumDensity','colostrumPH']
  };
  const obsKeys = { feces:['fecesAspect'], physical:['muscles','coat','limbs','locomotion','rumenFill','temperature'] };
  const values = [...(familyKeys[key] || []).map(k => analysis[k]), ...(obsKeys[key] || []).map(k => observations[k])];
  const filled = values.filter(v => Array.isArray(v) ? v.length : v !== '' && v !== null && v !== undefined).length;
  if (!filled) return 'none';
  return filled >= Math.max(1, Math.ceil(values.length * 0.6)) ? 'complete' : 'partial';
}

function measurementStatusDot(status){return status==='complete'?'complete':status==='partial'?'partial':'none';}
function subjectMeasurementDots(subject){
  const common=[['urine','Urines'],['blood','Sang'],['feces','Bouses'],['physical','Physique']];
  const optional=[['milk','Lait'],['colostrum','Colostrum']].filter(([k])=>measurementStatus(subject,k)!=='none');
  return [...common,...optional].map(([k,label])=>{const st=measurementStatus(subject,k);return `<span class="measure-status-dot ${measurementStatusDot(st)}" title="${escapeHtml(label)} : ${st==='complete'?'complet':st==='partial'?'partiel':'non saisi'}"><i></i><small>${escapeHtml(label)}</small></span>`;}).join('');
}
function subjectClassificationDone(subject){return !!subject.category&&subject.category!=='Non classé';}

function registryCoherenceIssues(subject,a,atDate){
  const issues=[];
  if(subject.birthDate&&a.birthDate&&subject.birthDate!==a.birthDate)issues.push(`date de naissance saisie ${formatDate(subject.birthDate)} ≠ registre ${formatDate(a.birthDate)}`);
  if(subject.breedCode&&a.breed&&normalizeSearchText(subject.breedCode)!==normalizeSearchText(a.breed))issues.push(`race saisie ${subject.breedCode} ≠ registre ${a.breed}`);
  if(subject.sex&&a.sex&&normalizeSearchText(subject.sex)!==normalizeSearchText(a.sex))issues.push(`sexe saisi ${subject.sex} ≠ registre ${a.sex}`);
  const femaleCats=['Génisse','Préparation vêlage','Tarie','Fraîche vêlée','Début lactation','Pic de lactation','Milieu lactation','Fin lactation','Vache allaitante'];
  if(a.sex==='M'&&femaleCats.includes(subject.category))issues.push(`catégorie « ${subject.category} » incohérente avec le sexe M du registre`);
  const age=monthsBetweenDates(a.birthDate,atDate);
  if(subject.category==='Veau 0–15 jours'&&age!=null&&age>1)issues.push('catégorie veau 0–15 jours incohérente avec l’âge du registre');
  if(subject.category==='Veau 15–60 jours'&&age!=null&&age>3)issues.push('catégorie veau 15–60 jours incohérente avec l’âge du registre');
  return issues;
}
function linkSubjectToReproduction(subject,visit,{fillBlanks=true}={}){
  if(!subject||!visit)return {status:'none'};
  const farm=db.farms.find(f=>f.id===visit.farmId);if(!farm)return {status:'none'};
  const source=reproductionSourceForVisit(visit,farm),registry=source.registry||[];if(!registry.length){subject.registryLinkStatus='no-registry';subject.registryCoherenceIssues=[];return {status:'no-registry'};}
  const registryFarm={...farm,herdRegistry:registry},query=subject.registryAnimalId||subject.workNumber||subject.tag||subject.identifier||'',match=resolveRegistryAnimal(registryFarm,query);
  if(match?.ambiguous){subject.registryLinked=false;subject.registryLinkStatus='ambiguous';subject.registryCoherenceIssues=[`Plusieurs bovins correspondent à « ${query} » dans le registre Reproduction.`];return {status:'ambiguous',items:match.items,registryFarm};}
  if(!match?.animal){subject.registryLinked=false;subject.registryLinkStatus='not-found';subject.registryCoherenceIssues=[`« ${query} » n’a pas été retrouvé dans le registre Reproduction de cette visite.`];return {status:'not-found',registryFarm};}
  const a=match.animal,repro=reproductionForCow(registryFarm,a.id),atDate=visit.date||new Date().toISOString().slice(0,10),issues=registryCoherenceIssues(subject,a,atDate);
  const fill=(key,value)=>{if(fillBlanks&&(subject[key]===undefined||subject[key]===null||subject[key]==='')&&value!==undefined&&value!==null&&value!=='')subject[key]=value;};
  subject.registryAnimalId=a.id;subject.registryWorkNumber=a.workNumber||subject.registryWorkNumber||'';subject.registryLinked=true;subject.registryLinkStatus=issues.length?'warning':'ok';subject.registryMatchType=match.matchType||'';subject.registryCoherenceIssues=issues;
  fill('name',a.name||'');fill('birthDate',a.birthDate||'');fill('age',a.birthDate?ageLabelAt(a.birthDate,atDate):'');fill('breedCode',a.breed||'');fill('sex',a.sex||'');fill('motherNumber',a.motherId||'');
  fill('rank',repro?.calves?.length??'');fill('lastCalvingDate',repro?.lastCalvingDate||'');fill('lastCalfId',repro?.lastCalf?.id||'');fill('firstCalvingAgeMonths',repro?.firstCalvingAgeMonths??'');fill('lastIVV',repro?.lastIVV??'');fill('meanIVV',repro?.meanIVV??'');
  return {status:subject.registryLinkStatus,animal:a,repro,registryFarm};
}
function enrichVisitSubjectsFromReproduction(visit){
  if(!visit)return false;
  const before=JSON.stringify((visit.subjects||[]).map(s=>({id:s.id,registryAnimalId:s.registryAnimalId,registryLinked:s.registryLinked,registryLinkStatus:s.registryLinkStatus,registryCoherenceIssues:s.registryCoherenceIssues,name:s.name,birthDate:s.birthDate,age:s.age,breedCode:s.breedCode,sex:s.sex,motherNumber:s.motherNumber,rank:s.rank,lastCalvingDate:s.lastCalvingDate,lastIVV:s.lastIVV,meanIVV:s.meanIVV})));
  (visit.subjects||[]).forEach(subject=>linkSubjectToReproduction(subject,visit,{fillBlanks:true}));
  const after=JSON.stringify((visit.subjects||[]).map(s=>({id:s.id,registryAnimalId:s.registryAnimalId,registryLinked:s.registryLinked,registryLinkStatus:s.registryLinkStatus,registryCoherenceIssues:s.registryCoherenceIssues,name:s.name,birthDate:s.birthDate,age:s.age,breedCode:s.breedCode,sex:s.sex,motherNumber:s.motherNumber,rank:s.rank,lastCalvingDate:s.lastCalvingDate,lastIVV:s.lastIVV,meanIVV:s.meanIVV})));
  const changed=before!==after;if(changed){visit.updatedAt=new Date().toISOString();saveDatabase(db);}return changed;
}

function subjectCardHtml(subject, index) {
  const isOpen = openSubjectId === subject.id;
  const category = subject.category || 'Non classé';
  const stageDetail = subject.stage === 'Pleine' && subject.gestationMonths ? `${subject.gestationMonths} mois` : subject.stage === 'Lactation' && subject.lactationDays ? `${subject.lactationDays} JEL` : subject.stage || 'Non renseigné';
  return `<article class="subject-card ${isOpen ? 'open' : ''}" data-subject-card="${subject.id}">
    <button type="button" class="subject-summary" data-toggle-subject="${subject.id}" aria-expanded="${isOpen}">
      <span class="subject-number">${index + 1}</span>
      <span class="subject-main"><strong>${escapeHtml(subject.tag || `Sujet ${index + 1}`)}${subject.name?` · ${escapeHtml(subject.name)}`:''}</strong><small>${escapeHtml(subject.location || 'Emplacement non renseigné')}${subject.registryAnimalId&&normalizeAnimalId(subject.registryAnimalId)!==normalizeAnimalId(subject.tag)?` · Boucle ${escapeHtml(subject.registryAnimalId)}`:''}${subject.age?` · ${escapeHtml(subject.age)}`:''}${subject.lastCalvingDate?` · Dernier vêlage ${formatDate(subject.lastCalvingDate)}`:''}</small>${subject.registryLinkStatus==='warning'||subject.registryLinkStatus==='ambiguous'||subject.registryLinkStatus==='not-found'?`<em class="registry-warning-inline">⚠ Cohérence registre à vérifier</em>`:subject.registryLinkStatus==='ok'?`<em class="registry-ok-inline">✓ Retrouvé dans le registre Repro</em>`:''}</span>
      <span class="subject-class"><span class="badge ${category === 'Non classé' ? 'unclassified' : 'complete'}">${escapeHtml(category)}</span><small>${escapeHtml(stageDetail)}</small></span>
      <span class="chevron">${isOpen ? '▲' : '▼'}</span>
    </button>
    ${isOpen ? subjectDetailsHtml(subject) : ''}
  </article>`;
}

function subjectDetailsHtml(subject) {
  return `<form class="subject-details" data-subject-form="${subject.id}">
    <div class="grid cols-2">
      <section>
        <h4>Identification</h4>
        <div class="row"><div class="field"><label>Numéro de boucle / repère</label><input name="tag" value="${escapeHtml(subject.tag || '')}" required inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" /></div><div class="field"><label>Nom (facultatif)</label><input name="name" value="${escapeHtml(subject.name || '')}" /></div></div>
        <div class="field"><label>Emplacement</label><input name="location" value="${escapeHtml(subject.location || '')}" placeholder="Ex. 2e place, 3e travée" /></div>
        <div class="field"><label>Observation d’identification</label><textarea name="notes" placeholder="Ex. corne cassée, robe particulière…">${escapeHtml(subject.notes || '')}</textarea></div>
      </section>
      <section>
        <h4>Classement</h4>
        <div class="row subject-pair-row"><div class="field"><label>Catégorie</label><select name="category">${categories.map(value => `<option ${subject.category === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div><div class="field"><label>Stade physiologique</label><select name="stage">${physiologicalStages.map(value => `<option ${subject.stage === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div></div>
        <div class="row"><div class="field"><label>Mois de gestation</label><input name="gestationMonths" type="number" min="1" max="9" inputmode="numeric" value="${escapeHtml(subject.gestationMonths || '')}" /></div><div class="field"><label>Jours en lactation</label><input name="lactationDays" type="number" min="0" inputmode="numeric" value="${escapeHtml(subject.lactationDays || '')}" /></div></div>
        <div class="row"><div class="field"><label>Âge</label><input name="age" value="${escapeHtml(subject.age || '')}" placeholder="Ex. 4 ans" /></div><div class="field"><label>Rang (nombre de veaux)</label><input name="rank" type="number" min="0" inputmode="numeric" value="${escapeHtml(subject.rank ?? '')}" /></div></div>
        <div class="row"><div class="field"><label>Code race</label><input name="breedCode" value="${escapeHtml(subject.breedCode || '')}" placeholder="Code race du registre" /></div><div class="field"><label>Date du dernier vêlage</label><input name="lastCalvingDate" type="date" value="${escapeHtml(subject.lastCalvingDate || '')}" /></div></div>
        <div class="field"><label>Lot</label><input name="lot" value="${escapeHtml(subject.lot || '')}" /></div>
      </section>
    </div>
    ${subject.registryLinked?`<section class="subject-registry-info"><h4>📋 Données du registre Reproduction</h4><div class="subject-registry-grid"><span><small>N° travail</small><strong>${escapeHtml(subject.registryWorkNumber||'—')}</strong></span><span><small>N° bovin</small><strong>${escapeHtml(subject.registryAnimalId||'—')}</strong></span><span><small>Nom</small><strong>${escapeHtml(subject.name||'—')}</strong></span><span><small>Date de naissance</small><strong>${subject.birthDate?formatDate(subject.birthDate):'—'}</strong></span><span><small>Âge à la visite</small><strong>${escapeHtml(subject.age||'—')}</strong></span><span><small>Race</small><strong>${escapeHtml(subject.breedCode||'—')}</strong></span><span><small>Dernier vêlage</small><strong>${subject.lastCalvingDate?formatDate(subject.lastCalvingDate):'—'}</strong></span><span><small>Dernier IVV</small><strong>${subject.lastIVV!==''&&subject.lastIVV!=null?`${subject.lastIVV} j`:'—'}</strong></span></div>${subject.registryCoherenceIssues?.length?`<div class="registry-coherence warning"><strong>⚠ Problème de cohérence</strong><ul>${subject.registryCoherenceIssues.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`:'<div class="registry-coherence ok">✓ Identification cohérente avec le registre Reproduction.</div>'}</section>`:subject.registryLinkStatus==='not-found'||subject.registryLinkStatus==='ambiguous'?`<section class="registry-coherence warning"><strong>⚠ Lien registre Reproduction</strong><p>${escapeHtml(subject.registryCoherenceIssues?.[0]||'Bovin non retrouvé.')}</p></section>`:''}
    <section class="measurement-overview"><h4>Suivi des mesures</h4><div class="measure-chips">${measurementFamilies.map(([key,label,icon]) => { const status = measurementStatus(subject,key); return `<button type="button" class="measure-chip ${status}" data-open-measure="${key}" data-subject-id="${subject.id}">${icon} ${label}<small>${status === 'complete' ? 'Fait' : status === 'partial' ? 'Partiel' : 'Non réalisé'}</small></button>`; }).join('')}</div><p class="muted small-text">Cliquez sur une famille pour ouvrir directement sa matrice et la ligne de cet animal.</p></section>
    <div class="actions subject-actions"><span class="autosave-indicator">✓ Enregistrement automatique</span><div class="subject-action-buttons"><button type="button" class="btn primary subject-collapse-new" data-collapse-new-subject="${subject.id}">↑ Replier et nouveau sujet</button><button type="button" class="btn danger" data-delete-subject="${subject.id}">Supprimer le sujet</button></div></div>
  </form>`;
}


function enhanceNumericEntry(root=app){
  if(!root)return;
  root.querySelectorAll('input[type="number"]').forEach(el=>{
    const decimal=el.step==='any'||el.getAttribute('step')?.includes('.')||el.hasAttribute('data-numeric-general')||el.hasAttribute('data-numeric-observation');
    if(!el.hasAttribute('inputmode'))el.setAttribute('inputmode',decimal?'decimal':'numeric');
  });
  root.querySelectorAll('.analysis-input,[data-numeric-general],[data-numeric-observation]').forEach(el=>{el.setAttribute('inputmode','decimal');el.setAttribute('enterkeyhint','next');});
  root.querySelectorAll('#subject-tag,input[name="tag"]').forEach(el=>{
    el.setAttribute('inputmode','numeric');
    el.setAttribute('pattern','[0-9]*');
    el.setAttribute('enterkeyhint','next');
  });
  root.querySelectorAll('input[inputmode="numeric"],input[inputmode="decimal"],.analysis-input').forEach(el=>{
    if(!el.getAttribute('enterkeyhint'))el.setAttribute('enterkeyhint','next');
    if(el.dataset.fastNavBound==='1')return;
    el.dataset.fastNavBound='1';
    el.addEventListener('keydown',event=>{
      if(event.altKey||event.ctrlKey||event.metaKey)return;
      const key=event.key;
      if(!['Enter','ArrowRight','ArrowLeft','ArrowUp','ArrowDown'].includes(key))return;
      const numericInputs=[...root.querySelectorAll('input[inputmode="numeric"],input[inputmode="decimal"],.analysis-input')].filter(x=>!x.disabled&&!x.readOnly&&x.offsetParent!==null);
      const focusInput=target=>{if(!target)return false;event.preventDefault();target.focus();if(typeof target.select==='function')target.select();return true;};
      if(key==='ArrowUp'||key==='ArrowDown'){
        const row=el.closest('tr');
        if(row){
          const cell=el.closest('td,th');
          const cells=[...row.children];
          const cellIndex=cells.indexOf(cell);
          let sibling=key==='ArrowDown'?row.nextElementSibling:row.previousElementSibling;
          while(sibling){
            const targetCell=sibling.children?.[cellIndex];
            const target=targetCell?.querySelector('input[inputmode="numeric"],input[inputmode="decimal"],.analysis-input');
            if(target&&!target.disabled&&!target.readOnly&&target.offsetParent!==null){focusInput(target);return;}
            sibling=key==='ArrowDown'?sibling.nextElementSibling:sibling.previousElementSibling;
          }
        }
      }
      const i=numericInputs.indexOf(el);
      if(i<0)return;
      if(key==='Enter'){
        // Saisie terrain : Entrée valide la valeur puis passe à la case numérique suivante.
        // Le clavier reste donc disponible pour les saisies en série ; le bouton dédié le ferme quand on a terminé.
        el.dispatchEvent(new Event('change',{bubbles:true}));
        focusInput(numericInputs[i+1]);
      }
      else if(key==='ArrowRight'){
        const end=typeof el.selectionEnd==='number'?el.selectionEnd:String(el.value||'').length;
        if(end>=String(el.value||'').length)focusInput(numericInputs[i+1]);
      } else if(key==='ArrowLeft'){
        const start=typeof el.selectionStart==='number'?el.selectionStart:0;
        if(start<=0)focusInput(numericInputs[i-1]);
      } else if(key==='ArrowDown')focusInput(numericInputs[i+1]);
      else if(key==='ArrowUp')focusInput(numericInputs[i-1]);
    });
  });
}

function renderAnimals() {
  const visits = db.visits.slice().sort((a,b) => (b.date || '').localeCompare(a.date || ''));
  if (!activeVisitId && visits.length) setActiveVisit(visits[0].id);
  const visit = activeVisit();
  if(visit)enrichVisitSubjectsFromReproduction(visit);
  app.innerHTML = `
    <div class="section-title"><div><h2>Animaux / sujets de la visite</h2><div class="muted">Saisir d’abord le numéro de boucle et l’emplacement. Le classement peut être complété plus tard.</div></div><span class="badge autosave">Sauvegarde automatique</span></div>
    ${activeVisitBanner(visit)}
    ${!visit ? `<section class="empty" style="margin-top:16px">Créez ou sélectionnez une visite avant d’ajouter des sujets.</section>` : `
      <section class="grid cols-2 animal-workspace" style="margin-top:16px">
        <form id="quick-subject-form" class="card quick-subject-form">
          <h3>Ajouter un sujet</h3>
          <p class="muted">Le numéro de travail suffit s’il est présent dans le fichier Reproduction : nom, âge, race et dernier vêlage seront récupérés automatiquement.</p>
          <div class="field"><label for="subject-tag">Numéro de boucle / n° de travail *</label><input id="subject-tag" name="tag" required autocomplete="off" inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" placeholder="Ex. 6248" /></div><div id="subject-registry-preview" class="registry-lookup-preview muted">Saisissez un numéro : l’application cherchera automatiquement le bovin dans le fichier Reproduction de cette visite.</div>
          <div class="field"><label for="subject-location">Emplacement</label><input id="subject-location" name="location" autocomplete="off" placeholder="Ex. 2e place, 3e travée" /></div>
          <button type="submit" class="btn primary">Ajouter le sujet</button>
        </form>
        <article class="card">
          <h3>Suivi des sujets</h3>
          <p class="muted small-text">✔ = catégorie attribuée. Les points indiquent l’état des mesures : vert complet, jaune partiel, gris non saisi. Lait et colostrum n’apparaissent que s’ils sont utilisés.</p>
          ${visit.subjects?.length ? `<div class="subject-status-list">${visit.subjects.map(s => `<div class="subject-status-row"><strong>${escapeHtml(s.tag || 'Sujet')}</strong><span class="classification-check ${subjectClassificationDone(s)?'done':'todo'}">${subjectClassificationDone(s)?'✔ Catégorie':'○ À classer'}</span><div class="measure-status-dots">${subjectMeasurementDots(s)}</div></div>`).join('')}</div>` : '<div class="empty">Aucun sujet pour cette visite.</div>'}
        </article>
      </section>
      <section style="margin-top:16px">
        <div class="section-title"><h3>Liste des sujets</h3><span class="muted">Cliquez sur une fiche pour la compléter</span></div>
        <div class="subject-list">${visit.subjects?.length ? visit.subjects.map(subjectCardHtml).join('') : '<div class="empty">Aucun sujet. Ajoutez le premier animal avec le formulaire ci-dessus.</div>'}</div>
      </section>`}`;


  enhanceNumericEntry(app);
  const quickForm = document.getElementById('quick-subject-form');
  const tagInput=document.getElementById('subject-tag'),registryPreview=document.getElementById('subject-registry-preview');
  const visitFarm=db.farms.find(f=>f.id===visit?.farmId),visitReproSource=visit&&visitFarm?reproductionSourceForVisit(visit,visitFarm):{registry:[]},visitRegistryFarm=visitFarm?{...visitFarm,herdRegistry:visitReproSource.registry||[]}:null;
  const renderRegistryPreview=()=>{if(!tagInput||!registryPreview||!visitRegistryFarm)return;const q=tagInput.value.trim();if(!q){registryPreview.className='registry-lookup-preview muted';registryPreview.textContent='Saisissez un numéro : l’application cherchera automatiquement le bovin dans le fichier Reproduction de cette visite.';return;}if(!(visitReproSource.registry||[]).length){registryPreview.className='registry-lookup-preview warning';registryPreview.innerHTML='<strong>⚠ Aucun registre Reproduction lié à cette visite.</strong>';return;}const m=resolveRegistryAnimal(visitRegistryFarm,q);if(m?.ambiguous){registryPreview.className='registry-lookup-preview warning';registryPreview.innerHTML=`<strong>⚠ ${m.items.length} bovins correspondent à « ${escapeHtml(q)} ».</strong> Il faudra choisir le bon bovin à l’ajout.`;return;}if(!m?.animal){registryPreview.className='registry-lookup-preview warning';registryPreview.innerHTML=`<strong>⚠ « ${escapeHtml(q)} » non retrouvé dans le registre Reproduction.</strong> Vérifiez le numéro ou ajoutez-le quand même si nécessaire.`;return;}const a=m.animal,r=reproductionForCow(visitRegistryFarm,a.id);if(!isRegistryAnimalPresent(a,visit.date)){registryPreview.className='registry-lookup-preview warning';registryPreview.innerHTML=`<strong>⚠ Bovin retrouvé mais sorti du cheptel avant la visite.</strong> ${a.exitDate?`Sortie le ${formatDate(a.exitDate)}`:''}`;return;}registryPreview.className='registry-lookup-preview ok';registryPreview.innerHTML=`<strong>✓ Bovin retrouvé :</strong> ${a.workNumber?`travail ${escapeHtml(a.workNumber)} · `:''}${escapeHtml(a.id)}${a.name?` · <b>${escapeHtml(a.name)}</b>`:''}${a.birthDate?` · ${escapeHtml(ageLabelAt(a.birthDate,visit.date))}`:''}${r?.lastCalvingDate?` · dernier vêlage ${formatDate(r.lastCalvingDate)}`:''}`;};
  tagInput?.addEventListener('input',renderRegistryPreview);renderRegistryPreview();
  quickForm?.addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(quickForm));
    const enteredTag = data.tag.trim();
    if (!enteredTag) return showToast('Le numéro de boucle ou le numéro de travail est obligatoire.');
    const farm = db.farms.find(f=>f.id===visit.farmId);
    const reproSource=reproductionSourceForVisit(visit,farm),registryFarm={...farm,herdRegistry:reproSource.registry||[]};
    let match = resolveRegistryAnimal(registryFarm, enteredTag),registryAnimal=null;
    if (match?.ambiguous) {
      match.items=(match.items||[]).filter(a=>isRegistryAnimalPresent(a,visit.date));
      if(!match.items.length)return showToast('Ce numéro correspond uniquement à des bovins sortis du cheptel avant cette visite.');
      const choices = match.items.map((a,i)=>`${i+1}. travail ${a.workNumber||'—'} · ${a.id}${a.name?' · '+a.name:''} · ${a.birthDate ? formatDate(a.birthDate) : 'date inconnue'} · race ${a.breed||'—'}`).join('\n');
      const choice = Number(prompt(`Plusieurs bovins correspondent à « ${enteredTag} ». Choisissez le bon bovin :\n${choices}`, '1'));
      if (!choice || !match.items[choice-1]) return showToast('Ajout annulé : bovin non sélectionné.');
      registryAnimal=match.items[choice-1];
    } else if (match?.animal) { if(!isRegistryAnimalPresent(match.animal,visit.date)) return showToast(`Ce bovin est sorti du cheptel${match.animal.exitDate?` le ${formatDate(match.animal.exitDate)}`:''} et ne peut pas être ajouté à une visite terrain.`); registryAnimal=match.animal; }
    if(!registryAnimal&&(reproSource.registry||[]).length&&!confirm(`Le numéro « ${enteredTag} » n’est pas retrouvé dans le registre Reproduction de cette visite.\n\nVoulez-vous quand même ajouter ce sujet ?`))return;
    const registryId=registryAnimal?.id||'';
    if (visit.subjects.some(subject => (registryId&&normalizeAnimalId(subject.registryAnimalId||subject.tag)===normalizeAnimalId(registryId)) || normalizeAnimalId(subject.tag)===normalizeAnimalId(enteredTag))) return showToast('Ce bovin est déjà présent dans la visite.');
    const repro = registryAnimal ? reproductionForCow(registryFarm, registryAnimal.id) : null;
    const subject = {
      id: uid('subject'), tag:enteredTag, registryAnimalId:registryId, registryWorkNumber:registryAnimal?.workNumber||'', registryLinked:!!registryAnimal, registryLinkStatus:registryAnimal?'ok':((reproSource.registry||[]).length?'not-found':'no-registry'), registryCoherenceIssues:registryAnimal?[]:[`« ${enteredTag} » n’a pas été retrouvé dans le registre Reproduction de cette visite.`], location: data.location.trim(), name: registryAnimal?.name || '', category: 'Non classé', stage: 'Non renseigné',
      gestationMonths: '', lactationDays: '', age: registryAnimal?.birthDate ? ageLabelAt(registryAnimal.birthDate, visit.date) : '', rank: repro?.calves?.length ?? '', lot: '', notes: '', measurements: {},
      birthDate: registryAnimal?.birthDate || '', breedCode: registryAnimal?.breed || '', sex: registryAnimal?.sex || '', motherNumber: registryAnimal?.motherId || '',
      lastCalvingDate: repro?.lastCalvingDate || '', lastCalfId: repro?.lastCalf?.id || '', firstCalvingAgeMonths: repro?.firstCalvingAgeMonths ?? '', lastIVV: repro?.lastIVV ?? '', meanIVV: repro?.meanIVV ?? '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    visit.subjects.push(subject);
    visit.updatedAt = new Date().toISOString();
    addJournal(visit, `Sujet ajouté : ${enteredTag}${registryAnimal?` → ${registryAnimal.id}`:''}.`);
    saveDatabase(db);
    openSubjectId = subject.id;
    showToast(registryAnimal?'Sujet ajouté et relié au registre Reproduction.':'Sujet ajouté sans correspondance dans le registre Reproduction.');
    renderAnimals();
    setTimeout(() => document.querySelector(`[data-subject-card="${subject.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  });

  app.querySelectorAll('[data-toggle-subject]').forEach(button => button.addEventListener('click', () => {
    openSubjectId = openSubjectId === button.dataset.toggleSubject ? null : button.dataset.toggleSubject;
    renderAnimals();
    if (openSubjectId) setTimeout(() => document.querySelector(`[data-subject-card="${openSubjectId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }));

  app.querySelectorAll('[data-subject-form]').forEach(form => {
    const subject = visit.subjects.find(item => item.id === form.dataset.subjectForm);
    const autosave = () => {
      const values = Object.fromEntries(new FormData(form));
      Object.assign(subject, values, { updatedAt: new Date().toISOString() });
      visit.updatedAt = new Date().toISOString();
      saveDatabase(db);
      const indicator = form.querySelector('.autosave-indicator');
      if (indicator) { indicator.textContent = '✓ Enregistré'; setTimeout(() => { indicator.textContent = '✓ Enregistrement automatique'; }, 1200); }
      const headerBadge = document.querySelector(`[data-subject-card="${subject.id}"] .subject-class .badge`);
      if (headerBadge) headerBadge.textContent = subject.category || 'Non classé';
    };
    form.addEventListener('input', autosave);
    form.addEventListener('change', autosave);
    form.querySelector('input[name="tag"]')?.addEventListener('change',()=>{subject.registryAnimalId='';subject.registryWorkNumber='';linkSubjectToReproduction(subject,visit,{fillBlanks:true});visit.updatedAt=new Date().toISOString();saveDatabase(db);renderAnimals();});
    form.querySelector('select[name="category"]')?.addEventListener('change',()=>{linkSubjectToReproduction(subject,visit,{fillBlanks:false});saveDatabase(db);renderAnimals();});
  });

  app.querySelectorAll('[data-open-measure]').forEach(button => button.addEventListener('click', () => {
    const familyMap = { urine:'Urines', blood:'Sang', feces:'Bouses', physical:'Physique', milk:'Lait', colostrum:'Colostrum' };
    setActiveVisit(visit.id);
    activeAnalysisSection = 'numeric';
    activeAnalysisFamily = familyMap[button.dataset.openMeasure] || 'Urines';
    focusedAnalysisSubjectId = button.dataset.subjectId || '';
    localStorage.setItem('audit-bovin-active-analysis-section', activeAnalysisSection);
    localStorage.setItem('audit-bovin-active-analysis-family', activeAnalysisFamily);
    localStorage.setItem('audit-bovin-focused-analysis-subject', focusedAnalysisSubjectId);
    setView('analysis');
  }));

  app.querySelectorAll('[data-collapse-new-subject]').forEach(button => button.addEventListener('click', () => {
    const active=document.activeElement;
    if(active && typeof active.blur==='function') active.blur();
    openSubjectId = null;
    renderAnimals();
    setTimeout(()=>{
      const form=document.getElementById('quick-subject-form');
      form?.scrollIntoView({behavior:'smooth',block:'start'});
      setTimeout(()=>document.getElementById('subject-tag')?.focus({preventScroll:true}),220);
    },0);
  }));

  app.querySelectorAll('[data-delete-subject]').forEach(button => button.addEventListener('click', () => {
    const subject = visit.subjects.find(item => item.id === button.dataset.deleteSubject);
    if (!subject || !confirm(`Supprimer le sujet ${subject.tag || ''} ?`)) return;
    visit.subjects = visit.subjects.filter(item => item.id !== subject.id);
    visit.updatedAt = new Date().toISOString();
    addJournal(visit, `Sujet supprimé : ${subject.tag || 'sans numéro'}.`);
    saveDatabase(db); openSubjectId = null; showToast('Sujet supprimé.'); renderAnimals();
  }));
}


// V10.4 — Module Analyse complet
const analysisParameters = [
  { key: 'nec', label: 'NEC', short: 'NEC', step: '0.25', group: 'Physique' },
  { key: 'urineColor', label: 'Couleur urine', short: 'Coul.', step: '1', min: '1', max: '5', group: 'Urines' },
  { key: 'urinePH', label: 'pH urine', short: 'pH U', step: '0.01', group: 'Urines' },
  { key: 'urineRedox', label: 'Redox urine', short: 'Redox U', step: '1', group: 'Urines' },
  { key: 'urineBrix', label: 'Brix urine (%)', short: 'Brix U', step: '0.1', group: 'Urines' },
  { key: 'urineDensity', label: 'Densité urine', short: 'Densité', step: '1', group: 'Urines' },
  { key: 'glucose', label: 'Glycémie', short: 'Gly', step: '0.1', group: 'Sang' },
  { key: 'boh', label: 'BOH', short: 'BOH', step: '0.01', group: 'Sang' },
  { key: 'bloodPH', label: 'pH sanguin', short: 'pH S', step: '0.01', group: 'Sang' },
  { key: 'urea', label: 'Urémie', short: 'Urée', step: '0.01', group: 'Sang' },
  { key: 'fecesPH', label: 'pH bouses', short: 'pH B', step: '0.01', group: 'Bouses' },
  { key: 'fecesRedox', label: 'Redox bouses', short: 'Redox B', step: '1', group: 'Bouses' },
  { key: 'milkPH', label: 'pH lait', short: 'pH lait', step: '0.01', group: 'Lait' },
  { key: 'milkBrix', label: 'Brix lait (%)', short: 'Brix lait', step: '0.1', group: 'Lait' },
  { key: 'colostrumBrix', label: 'Brix colostrum (%)', short: 'Brix colo.', step: '0.1', group: 'Colostrum' },
  { key: 'colostrumDensity', label: 'Densité colostrum', short: 'Dens. colo.', step: '1', group: 'Colostrum' },
  { key: 'colostrumPH', label: 'pH colostrum', short: 'pH colo.', step: '0.01', group: 'Colostrum' }
];

const observationFields = [
  { key:'muscles', label:'Muscles', type:'single', options:['--','-','0','+','++'] },
  { key:'coat', label:'Poils', type:'multi', options:['Fins','Soyeux','Longs','Piqués','Hirsutes','Pelucheux','Mue','Ternes'] },
  { key:'fecesAspect', label:'Aspect des bouses', type:'multi', options:['Dures','Avec mucus','Collantes','Liquides','Moulées','Molles','Fibres longues','Fibres courtes','Grains','Bulles'] },
  { key:'limbs', label:'Membres', type:'multi', options:['Bons','Blessures','Cagneux','Panard','Coudés','Boiterie','Enflammé'] },
  { key:'locomotion', label:'Score locomotion', type:'single', options:['1','2','3'] },
  { key:'rumenFill', label:'SRR / remplissage du rumen', type:'single', options:['1','1,5','2','2,5','3','3,5','4','4,5','5'] },
  { key:'temperature', label:'Température (°C)', type:'number', step:'0.1' },
  { key:'notes', label:'Observations', type:'text' }
];

const generalConfigs = {
  tamis: { title:'Tamis à bouses', icon:'🟤', fields:[
    ['date','Date du relevé','date'], ['category','Catégorie','select',['Veaux','Engraissement','Génisses','Vaches en production','Taries','Autre']],
    ['represented','Nombre d’animaux représentés','number'], ['total','Poids total (g)','number'], ['t1','Tamis 1 — 5 mm (g)','number'], ['t2','Tamis 2 — 2 mm (g)','number'], ['comment','Commentaire','text']
  ]},
  silos: { title:'Silos / ensilages', icon:'🌽', fields:[
    ['date','Date du relevé','date'], ['name','Nom / repère','text'], ['type','Type','select',['Ensilage maïs','Ensilage herbe','Méteil','Silo couloir','Silo boudin','Autre']], ['ph','pH','number'], ['redox','Redox','number'], ['dm','MS (%)','number'],
    ['earing','Stade','select',['Épié','Non épié','Non renseigné']], ['mowTime','Heure de fauche','time'], ['mowHeight','Hauteur de fauche (cm)','number'],
    ['conditioned','Conditionnement','select',['Conditionné','Non conditionné','Non renseigné']], ['preservative','Conservateur','text'], ['doubleCover','Bâchage','select',['Double bâche','Bâche simple','Autre']], ['comment','Réalisation / stockage / distribution','text']
  ]},
  soils: { title:'Sol', icon:'🌱', fields:[
    ['date','Date du relevé','date'], ['name','Parcelle / repère','text'], ['type','Type de sol','select',['Argileux','Limoneux','Sableux','Argilo-limoneux','Limono-argileux','Calcaire','Hydromorphe','Tourbeux','Autre']], ['ph','pH','number'], ['redox','Redox','number'], ['conditions','Conditions de mesure','text'], ['fertilization','Fertilisation / amendements','text'], ['comment','Observation','text']
  ]},
  plants: { title:'Plantes / herbe', icon:'🌾', fields:[
    ['date','Date du relevé','date'], ['name','Parcelle / plante','text'], ['weather','Météo','multi',['Ensoleillé','Couvert','Pluie récente','Pluie en cours','Chaud','Sec','Froid','Venté','Rosée','Autre']], ['time','Heure de mesure','time'],
    ['brix','Brix (%)','number'], ['redox','Redox','number'], ['ph','pH','number'], ['height','Hauteur (cm)','number'], ['grazing','Temps de pâturage','text'], ['fertilization','Fertilisation','text'],
    ['potassium','Potassium','number'], ['calcium','Calcium','number'], ['nitrates','Nitrates','number'], ['sodium','Sodium','number'], ['comment','Commentaire','text']
  ]}
};

function normalizeDecimalText(value) {
  if (value === '' || value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g,'').replace(',', '.');
}
function numericValue(value) {
  const normalized = normalizeDecimalText(value);
  if (normalized === '') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}
function normalizedMeasurementValue(value) {
  const normalized = normalizeDecimalText(value);
  if (normalized === '') return '';
  return numericValue(normalized) === null ? String(value ?? '').trim() : normalized;
}
function ensureReferenceSettings(){db.settings=db.settings&&typeof db.settings==='object'?db.settings:{};db.settings.referenceThresholdOverrides=db.settings.referenceThresholdOverrides&&typeof db.settings.referenceThresholdOverrides==='object'?db.settings.referenceThresholdOverrides:{};db.settings.metabolicLabs=Array.isArray(db.settings.metabolicLabs)?db.settings.metabolicLabs:[];db.settings.metabolicLabs.forEach(l=>(l.references||[]).forEach(r=>{if(r.analyte==='Cobalt / Vitamine B12')r.analyte='Cobalt (Co)'}));if(!db.settings.metabolicLabs.some(l=>/Vend[ée]e|LEAV/i.test(l.name||'')))db.settings.metabolicLabs.push({id:'lab-leav-bovin',name:'LEAV Vendée — Bovins',updatedAt:'2026-04-08',notes:'Valeurs usuelles LEAV, plasma, ICP-MS — Révision 3',references:[['Cuivre (Cu)','Plasma','µg/L','770','1000'],['Cobalt (Co)','Plasma','µg/L','0.5','1.9'],['Zinc (Zn)','Plasma','µg/L','850','1100'],['Manganèse (Mn)','Plasma','µg/L','1.8','2.6'],['Sélénium (Se)','Plasma','µg/L','50','90'],['Iode','Plasma','µg/L','49','110']].map((x,i)=>({id:'leav'+i,analyte:x[0],sampleType:x[1],unit:x[2],refMin:x[3],refMax:x[4]}))});if(!db.settings.metabolicLabs.some(l=>/Iodolab/i.test(l.name||'')))db.settings.metabolicLabs.push({id:'lab-iodolab-bovin',name:'Iodolab — Bovins',updatedAt:'2026-04-17',notes:'Références visibles sur rapport Iodolab bovin fourni',references:[['Zinc (Zn)','Sang total','µmol/L','12','21'],['Cuivre (Cu)','Sang total','µmol/L','11','18'],['Sélénium (Se)','Sang total','µg/L','80','300'],['Iode','Sang total','µg/L','51',''],['Cobalt (Co)','Sang total','µg/L','0.67',''],['Manganèse (Mn)','Sang total','µg/L','2.1','10'],['Vitamine A','Sang total','µg/dL','30','70'],['Vitamine E','Sang total','µg/mL','3','10'],['Vitamine D3 (25-OH-D3)','Sang total','ng/mL','20','80'],['Magnésium (Mg)','Sang total','mg/L','19.44','29.16']].map((x,i)=>({id:'iodo'+i,analyte:x[0],sampleType:x[1],unit:x[2],refMin:x[3],refMax:x[4]}))});db.settings.parasiteLabs=Array.isArray(db.settings.parasiteLabs)?db.settings.parasiteLabs:[{id:'public-labos',name:'Public Labos',notes:'Coproscopie quantitative + grilles labo'},{id:'lpl',name:'LPL — Laboratoires des Pyrénées et des Landes',notes:'Quantitatif, qualitatif et seuil de détection variable'},{id:'labocea',name:'Labocéa',notes:'Pepsinogène sérique et sérologie parasitaire'}];db.settings.waterLabs=Array.isArray(db.settings.waterLabs)?db.settings.waterLabs:[{id:'public-labos-water',name:'Public Labos',parameters:['Turbidité','pH','Conductivité','Dureté','Nitrites','Coliformes','Escherichia coli','Entérocoques intestinaux','Spores ASR']},{id:'lpl-water',name:'LPL',parameters:['Spores ASR','Bactéries coliformes','Escherichia coli','Flore revivifiable 22°C','Flore revivifiable 36°C','Entérocoques intestinaux']}];db.settings.supplementProducts=Array.isArray(db.settings.supplementProducts)?db.settings.supplementProducts:[];db.settings.feedReferenceOverrides=db.settings.feedReferenceOverrides&&typeof db.settings.feedReferenceOverrides==='object'?db.settings.feedReferenceOverrides:{};db.settings.customFeedReferences=Array.isArray(db.settings.customFeedReferences)?db.settings.customFeedReferences:[];db.settings.mineralNeedTargets=db.settings.mineralNeedTargets&&typeof db.settings.mineralNeedTargets==='object'?db.settings.mineralNeedTargets:{};return db.settings;}
function thresholdFor(subject,key){const mapped=CATEGORY_RULE_MAP[subject.category];if(!mapped)return null;const base=THRESHOLDS[mapped]?.[key]||null,ov=ensureReferenceSettings().referenceThresholdOverrides?.[mapped]?.[key];return ov&&typeof ov==='object'?{...(base||{}),...ov}:base;}
function classifyValue(value, rule) {
  const number = numericValue(value);
  if (number === null) return { status:'empty', label:'Non mesuré' };
  if (!rule) return { status:'pending', label:'Référence indisponible' };
  const { redLow, greenLow, greenHigh, redHigh, labels = {} } = rule;
  if (redLow !== null && number <= redLow) return { status:'red-low', label:labels.redLow || 'Très bas' };
  if (greenLow !== null && number < greenLow) return { status:'yellow-low', label:labels.yellowLow || 'Bas' };
  if (greenHigh !== null && number <= greenHigh && (greenLow === null || number >= greenLow)) return { status:'green', label:labels.green || 'Référence' };
  if (redHigh !== null && number >= redHigh) return { status:'red-high', label:labels.redHigh || 'Très haut' };
  if (greenHigh !== null && number > greenHigh) return { status:'yellow-high', label:labels.yellowHigh || 'Haut' };
  if (greenLow !== null && number >= greenLow) return { status:'green', label:labels.green || 'Référence' };
  return { status:'pending', label:'À interpréter' };
}
function referenceText(rule) { return rule ? (rule.labels?.green || 'Plage disponible') : 'Pas de seuil validé'; }
function statusSeverity(status) { return { 'red-low':3,'red-high':3,'yellow-low':2,'yellow-high':2,pending:1,green:0,empty:0 }[status] ?? 0; }
function ensureAnalysisVisit(visit) {
  visit.analysisConclusions = visit.analysisConclusions || {};
  visit.analysisGeneral = visit.analysisGeneral || { tamis:[], silos:[], soils:[], plants:[] };
  Object.keys(generalConfigs).forEach(key => visit.analysisGeneral[key] = Array.isArray(visit.analysisGeneral[key]) ? visit.analysisGeneral[key] : []);
  visit.analysisActions = Array.isArray(visit.analysisActions) ? visit.analysisActions : [];
  visit.reasoningReview = visit.reasoningReview && typeof visit.reasoningReview === 'object' ? visit.reasoningReview : {};
  (visit.subjects || []).forEach(subject => {
    subject.measurements = subject.measurements && typeof subject.measurements === 'object' ? subject.measurements : {};
    subject.measurements.analysis = subject.measurements.analysis && typeof subject.measurements.analysis === 'object' ? subject.measurements.analysis : {};
    subject.measurements.observations = subject.measurements.observations && typeof subject.measurements.observations === 'object' ? subject.measurements.observations : {};
    subject.measurements.comments = subject.measurements.comments && typeof subject.measurements.comments === 'object' ? subject.measurements.comments : {};
  });
}
let analysisSaveTimer=null;
function syncVisibleAnalysisInputs(visitId){
  const visit=db.visits.find(v=>v.id===visitId);if(!visit)return;
  document.querySelectorAll('.analysis-input[data-subject-id][data-param]').forEach(input=>{
    const subject=(visit.subjects||[]).find(s=>s.id===input.dataset.subjectId);if(!subject)return;
    subject.measurements=subject.measurements||{};subject.measurements.analysis=subject.measurements.analysis||{};
    const value=input.value ?? '';
    subject.measurements.analysis[input.dataset.param]=value;
    writeAnalysisPending(visit.id,subject.id,input.dataset.param,value);
  });
}
function scheduleAnalysisSave(delay=450,visitId=activeVisit()?.id){
  clearTimeout(analysisSaveTimer);
  analysisSaveTimer=setTimeout(()=>{analysisSaveTimer=null;try{saveDatabase(db);if(visitId)pruneAnalysisPendingVisit(visitId);}catch(e){console.error('Sauvegarde mesures différée impossible',e);}},delay);
}
const ANALYSIS_PENDING_KEY='audit-bovin-analysis-pending-v1';
function readAnalysisPending(){try{return JSON.parse(localStorage.getItem(ANALYSIS_PENDING_KEY)||'{}')||{}}catch(_){return {};}}
function writeAnalysisPending(visitId,subjectId,param,value){
  if(!visitId||!subjectId||!param)return;
  const pending=readAnalysisPending();
  pending[visitId]=pending[visitId]||{};
  pending[visitId][subjectId]=pending[visitId][subjectId]||{};
  pending[visitId][subjectId][param]=value;
  try{localStorage.setItem(ANALYSIS_PENDING_KEY,JSON.stringify(pending));}catch(_){}
}
function clearAnalysisPendingVisit(visitId){
  if(!visitId)return;
  const pending=readAnalysisPending();
  if(pending[visitId]){delete pending[visitId];try{localStorage.setItem(ANALYSIS_PENDING_KEY,JSON.stringify(pending));}catch(_){}}
}
function clearAnalysisPendingValue(visitId,subjectId,param){
  if(!visitId||!subjectId||!param)return;
  const pending=readAnalysisPending();
  if(!pending[visitId]?.[subjectId])return;
  delete pending[visitId][subjectId][param];
  if(!Object.keys(pending[visitId][subjectId]).length)delete pending[visitId][subjectId];
  if(!Object.keys(pending[visitId]).length)delete pending[visitId];
  try{localStorage.setItem(ANALYSIS_PENDING_KEY,JSON.stringify(pending));}catch(_){}
}
function pruneAnalysisPendingVisit(visitId){
  if(!visitId)return;
  const pending=readAnalysisPending(),visit=db.visits.find(v=>v.id===visitId);if(!pending[visitId]||!visit)return;
  Object.entries(pending[visitId]).forEach(([subjectId,values])=>{
    const subject=(visit.subjects||[]).find(s=>s.id===subjectId);if(!subject)return;
    Object.entries(values||{}).forEach(([param,value])=>{
      if(String(subject.measurements?.analysis?.[param]??'')===String(value??''))delete pending[visitId][subjectId][param];
    });
    if(!Object.keys(pending[visitId][subjectId]||{}).length)delete pending[visitId][subjectId];
  });
  if(!Object.keys(pending[visitId]||{}).length)delete pending[visitId];
  try{localStorage.setItem(ANALYSIS_PENDING_KEY,JSON.stringify(pending));}catch(_){}
}

function restoreAnalysisPending(visit){
  if(!visit?.id)return false;
  const entries=readAnalysisPending()[visit.id];if(!entries)return false;
  let changed=false;
  Object.entries(entries).forEach(([subjectId,values])=>{const s=(visit.subjects||[]).find(x=>x.id===subjectId);if(!s)return;s.measurements=s.measurements||{};s.measurements.analysis=s.measurements.analysis||{};Object.entries(values||{}).forEach(([param,value])=>{s.measurements.analysis[param]=value;changed=true;});});
  return changed;
}
function flushAnalysisSave(visitId){
  clearTimeout(analysisSaveTimer);analysisSaveTimer=null;if(visitId)syncVisibleAnalysisInputs(visitId);saveDatabase(db);if(visitId)pruneAnalysisPendingVisit(visitId);
}
function subjectContextMini(subject){
  const items=[];
  if(subject.name)items.push(`<span><b>Nom</b> ${escapeHtml(subject.name)}</span>`);
  if(subject.age)items.push(`<span><b>Âge</b> ${escapeHtml(subject.age)}</span>`);
  if(subject.lastCalvingDate)items.push(`<span><b>DV</b> ${formatDate(subject.lastCalvingDate)}</span>`);
  if(subject.breedCode)items.push(`<span><b>Race</b> ${escapeHtml(subject.breedCode)}</span>`);
  if(subject.rank!==''&&subject.rank!==null&&subject.rank!==undefined)items.push(`<span><b>Rang</b> ${escapeHtml(subject.rank)}</span>`);
  return items.length?`<div class="subject-context-mini">${items.join('')}</div>`:'';
}
function analysisCell(subject, parameter) {
  const value = subject.measurements.analysis?.[parameter.key] ?? '';
  const rule = thresholdFor(subject, parameter.key);
  const result = subject.category && subject.category !== 'Non classé' ? classifyValue(value, rule) : (value === '' ? {status:'empty',label:'Non mesuré'} : {status:'unclassified',label:'Classer le sujet'});
  return `<td class="analysis-value-cell ${result.status}" title="${escapeHtml(result.label)} · ${escapeHtml(referenceText(rule))}"><input class="analysis-input decimal-input" data-subject-id="${subject.id}" data-param="${parameter.key}" type="text" inputmode="decimal" autocomplete="off" data-step="${parameter.step}" ${parameter.min!==undefined ? `data-min="${parameter.min}"` : ''} ${parameter.max!==undefined ? `data-max="${parameter.max}"` : ''} value="${escapeHtml(value)}"/><small>${escapeHtml(result.label)}</small></td>`;
}
function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a,b)=>a+b,0)/values.length;
  return Math.sqrt(values.reduce((sum,v)=>sum+((v-mean)**2),0)/values.length);
}
function categoryAnalysis(visit) {
  const groups = new Map();
  (visit.subjects || []).filter(s => s.category && s.category !== 'Non classé').forEach(subject => {
    if(!groups.has(subject.category)) groups.set(subject.category,[]);
    groups.get(subject.category).push(subject);
  });
  return [...groups.entries()].map(([category,subjects]) => ({
    category, subjects,
    parameterResults: analysisParameters.map(parameter => {
      const measured = subjects.map(subject => {
        const value = numericValue(subject.measurements.analysis?.[parameter.key]);
        if(value===null) return null;
        const rule = thresholdFor(subject,parameter.key);
        return { value, result:classifyValue(value,rule), rule, subject };
      }).filter(Boolean);
      if(!measured.length) return null;
      const values = measured.map(i=>i.value);
      const average = values.reduce((a,b)=>a+b,0)/values.length;
      const worst = measured.slice().sort((a,b)=>statusSeverity(b.result.status)-statusSeverity(a.result.status))[0];
      return { parameter, measured, average, minimum:Math.min(...values), maximum:Math.max(...values), standardDeviation:standardDeviation(values), outOfRange:measured.filter(i=>statusSeverity(i.result.status)>=2).length, worst, rule:measured[0].rule };
    }).filter(Boolean)
  }));
}

function dominantValues(subjects,key) {
  const counts={}; subjects.forEach(s=>{const raw=s.measurements.observations?.[key]; const vals=Array.isArray(raw)?raw:(raw?[raw]:[]); vals.forEach(v=>counts[v]=(counts[v]||0)+1);});
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,4);
}
function interpretationItems(group) {
  const byKey=Object.fromEntries(group.parameterResults.map(i=>[i.parameter.key,i])); const items=[];
  const abnormal=i=>i&&statusSeverity(i.worst.result.status)>=2, high=i=>i&&['yellow-high','red-high'].includes(i.worst.result.status), low=i=>i&&['yellow-low','red-low'].includes(i.worst.result.status);
  if(high(byKey.urineDensity)||high(byKey.urineColor))items.push({level:'warning',theme:'Hydratation',title:'Accès à l’eau à vérifier',text:'Urines concentrées ou foncées : croiser avec débit, nombre d’abreuvoirs, concurrence, météo et durée avant prélèvement.',action:'Contrôler les débits, la propreté et l’accessibilité des abreuvoirs.'});
  if(abnormal(byKey.urinePH)||abnormal(byKey.urineRedox))items.push({level:'warning',theme:'Équilibre acido-basique',title:'Profil urinaire à investiguer',text:'Le pH ou le redox urinaire s’écarte du repère catégoriel. Croiser avec la ration, les minéraux, les fourrages et le stade physiologique.',action:'Revoir ration, minéralisation et analyses des fourrages.'});
  if(high(byKey.boh)||low(byKey.glucose))items.push({level:'danger',theme:'Énergie',title:'Déficit énergétique possible',text:'Le couple BOH/glycémie comporte un écart. Vérifier ingestion, densité énergétique, transition, état corporel et compétition alimentaire.',action:'Contrôler ingestion et transition alimentaire puis recontrôler BOH/glycémie.'});
  if(abnormal(byKey.urea))items.push({level:'warning',theme:'Azote',title:'Équilibre azoté à vérifier',text:'L’urémie s’écarte du repère. Croiser avec énergie fermentescible, azote soluble, ration et hydratation.',action:'Vérifier les apports azotés et leur synchronisation avec l’énergie.'});
  if(abnormal(byKey.fecesPH)||abnormal(byKey.fecesRedox))items.push({level:'warning',theme:'Digestion',title:'Fermentations digestives à vérifier',text:'Les mesures fécales suggèrent de contrôler transit, fibrosité, tri et transitions.',action:'Observer la ration, le tri, les fibres et réaliser/relire le tamis.'});
  if(abnormal(byKey.nec))items.push({level:'warning',theme:'État corporel',title:'NEC à surveiller',text:'La NEC moyenne ou certaines valeurs s’écartent du repère de la catégorie.',action:'Suivre la dynamique de NEC et adapter la conduite du lot.'});
  const feces=dominantValues(group.subjects,'fecesAspect'); if(feces.some(([v])=>['Liquides','Collantes','Grains','Fibres longues'].includes(v)))items.push({level:'warning',theme:'Bouses',title:'Observations de bouses défavorables',text:`Observations dominantes : ${feces.map(([v,n])=>`${v} (${n})`).join(', ')}.`,action:'Croiser avec le tamis, la fibrosité et la vitesse de transition.'});
  const limbs=dominantValues(group.subjects,'limbs'); if(limbs.some(([v])=>['Boiterie','Enflammé','Blessures'].includes(v)))items.push({level:'danger',theme:'Locomotion',title:'Atteintes des membres observées',text:`Signes relevés : ${limbs.map(([v,n])=>`${v} (${n})`).join(', ')}.`,action:'Examiner couchage, sols, parage et prise en charge des animaux atteints.'});
  if(!items.length&&group.parameterResults.length)items.push({level:'good',theme:'Ensemble',title:'Profil globalement dans les repères',text:'Les valeurs renseignées sont majoritairement dans les plages utilisées. À confronter aux observations et aux autres volets.',action:'Maintenir les pratiques et surveiller l’évolution.'});
  return items;
}
function ratioCount(subjects, predicate) {
  const matching = subjects.filter(predicate).length;
  return { matching, total:subjects.length, ratio:subjects.length ? matching/subjects.length : 0 };
}
function resultFor(subject,key) {
  const value=numericValue(subject.measurements.analysis?.[key]);
  return value===null ? null : {value,classification:classifyValue(value,thresholdFor(subject,key))};
}
function isLow(subject,key){const r=resultFor(subject,key);return r&&['red-low','yellow-low'].includes(r.classification.status);}
function isHigh(subject,key){const r=resultFor(subject,key);return r&&['red-high','yellow-high'].includes(r.classification.status);}
function hasObservation(subject,key,values){const raw=subject.measurements.observations?.[key];const list=Array.isArray(raw)?raw:(raw?[raw]:[]);return list.some(v=>values.includes(v));}
function confidenceLabel(score,evidenceCount,contradictionsCount,sourceCount=1){
  if(evidenceCount>=4&&sourceCount>=2&&score>=7&&contradictionsCount<=1)return{label:'élevée',className:'high'};
  if(evidenceCount>=2&&score>=3)return{label:'modérée',className:'medium'};
  return{label:'faible',className:'low'};
}
function confidenceBreakdownHtml(h,compact=false){
  const favorable=(h.evidence||[]).length,prudence=(h.nuance||[]).length,missing=(h.missing||[]).length,sources=h.sourceCount||0;
  const detail=`${favorable} élément(s) en faveur · ${prudence} prudence/contradiction(s) · ${missing} donnée(s) manquante(s) · ${sources} source(s) distincte(s)`;
  if(compact)return `<small class="confidence-breakdown compact">${escapeHtml(detail)}</small>`;
  return `<div class="confidence-breakdown"><span>✓ Pour : <b>${favorable}</b></span><span>⚠ Prudence : <b>${prudence}</b></span><span>… Manquants : <b>${missing}</b></span><span>◉ Sources : <b>${sources}</b></span></div>`;
}
function auditAttentionCount(visit, sectionId){
  const answers=visit.auditGlobal?.answers||{};
  const section=auditGlobalSections.find(x=>x.id===sectionId);
  if(!section)return 0;
  return section.questions.filter(q=>['À surveiller','À corriger'].includes(answers[q]?.status||answers[q]?.evaluation||'')).length;
}
function buildingRecords(visit){
  const audits=Object.values(visit.buildingAudits||{});
  return {
    drinkers:audits.flatMap(a=>a.drinkers||[]), electric:audits.flatMap(a=>a.electric||[]),
    litters:audits.flatMap(a=>a.litters||[]), ambience:audits.map(a=>a.ambience||{}),
    questionnaire:audits.flatMap(a=>Object.values(a.questionnaire||{}))
  };
}
function dataQualityForGroup(visit, group){
  const subjects=group.subjects,total=Math.max(1,subjects.length);
  const count=(keys,source='analysis')=>subjects.filter(s=>keys.some(k=>{const v=s.measurements?.[source]?.[k];return Array.isArray(v)?v.length>0:(v!==''&&v!==null&&v!==undefined);})).length;
  const build=buildingRecords(visit);
  const rows=[
    {label:'Urines',value:count(['urinePH','urineRedox','urineDensity','urineColor']),total},
    {label:'Sang',value:count(['glucose','boh','bloodPH','urea']),total},
    {label:'Bouses',value:count(['fecesPH','fecesRedox'])+count(['fecesAspect'],'observations'),total:total*2},
    {label:'Physique',value:count(['nec'])+count(['rumenFill','muscles','coat','limbs'],'observations'),total:total*2},
    {label:'Alimentation',value:(visit.feeding?.rations||[]).length?1:0,total:1},
    {label:'Bâtiment / eau',value:(build.drinkers.length+build.litters.length+build.electric.length)>0?1:0,total:1}
  ];
  return rows.map(r=>({...r,ratio:r.total?r.value/r.total:0,level:r.total&&r.value/r.total>=.7?'high':r.total&&r.value/r.total>=.3?'medium':'low'}));
}
function makePiste(rule,evidence,nuance,missing,score,sources){
  return {...rule,evidence,nuance,missing,causes:rule.causes||[],confidence:confidenceLabel(score,evidence.length,nuance.length,new Set(sources).size),sourceCount:new Set(sources).size};
}
function buildKnowledgePistes(visit,group){
  const subjects=group.subjects,pistes=[];
  const rule=id=>KNOWLEDGE_RULES.find(r=>r.id===id);
  const measured=(key)=>subjects.filter(s=>numericValue(s.measurements.analysis?.[key])!==null);
  const abnormal=(key,direction='any')=>subjects.filter(s=>{const r=resultFor(s,key);if(!r)return false;const st=r.classification.status;return direction==='low'?['red-low','yellow-low'].includes(st):direction==='high'?['red-high','yellow-high'].includes(st):statusSeverity(st)>=2;});
  const obs=(key,vals)=>subjects.filter(s=>hasObservation(s,key,vals));
  const build=buildingRecords(visit);
  {
    const e=[],n=[],m=[],src=[];let score=0;
    const boh=abnormal('boh','high'),gly=abnormal('glucose','low'),nec=abnormal('nec','low'),rumen=obs('rumenFill',['1','1,5','1.5','2']),muscle=obs('muscles',['--','-']);
    if(boh.length){e.push(`${boh.length}/${subjects.length} BOH au-dessus du repère`);score+=3;src.push('sang')}
    if(gly.length){e.push(`${gly.length}/${subjects.length} glycémie(s) basse(s)`);score+=2;src.push('sang')}
    if(nec.length){e.push(`${nec.length}/${subjects.length} NEC basse(s)`);score+=2;src.push('physique')}
    if(rumen.length){e.push(`${rumen.length}/${subjects.length} remplissage(s) ruminal(aux) faible(s)`);score+=1;src.push('observation')}
    if(muscle.length){e.push(`${muscle.length}/${subjects.length} musculature(s) faible(s)`);score+=1;src.push('observation')}
    if(measured('glucose').length&&abnormal('glucose').length===0)n.push('Les glycémies renseignées sont majoritairement dans la plage de référence.');
    if(!measured('glucose').length)m.push('Glycémies non renseignées');if(!measured('boh').length)m.push('BOH non renseignés');if(!measured('nec').length)m.push('NEC non renseignées');
    if(e.length)pistes.push(makePiste(rule('energy-balance'),e,n,m,score,src));
  }
  {
    const e=[],n=[],m=[],src=[];let score=0;const ph=abnormal('urinePH'),redox=abnormal('urineRedox');
    if(ph.length){e.push(`${ph.length}/${subjects.length} pH urinaire(s) hors repère`);score+=2;src.push('urines')}
    if(redox.length){e.push(`${redox.length}/${subjects.length} redox urinaire(s) hors repère`);score+=2;src.push('urines')}
    if(visit.feeding?.settings?.mineralization){e.push('Minéralisation renseignée dans le module Alimentation');score+=1;src.push('alimentation')}
    if(!measured('urinePH').length)m.push('pH urinaires non renseignés');if(!measured('urineRedox').length)m.push('Redox urinaires non renseignés');
    if(e.length)pistes.push(makePiste(rule('urine-balance'),e,n,m,score,src));
  }
  {
    const e=[],n=[],m=[],src=[];let score=0;const ph=abnormal('fecesPH'),redox=abnormal('fecesRedox'),aspect=obs('fecesAspect',['Liquides','Molles','Collantes','Grains','Fibres longues']),rumen=obs('rumenFill',['1','1,5','1.5','2']);
    if(ph.length){e.push(`${ph.length}/${subjects.length} pH de bouses hors repère`);score+=2;src.push('bouses')}
    if(redox.length){e.push(`${redox.length}/${subjects.length} redox de bouses hors repère`);score+=2;src.push('bouses')}
    if(aspect.length){e.push(`${aspect.length}/${subjects.length} aspect(s) de bouses à surveiller`);score+=2;src.push('observation')}
    if(rumen.length){e.push(`${rumen.length}/${subjects.length} remplissage(s) ruminal(aux) faible(s)`);score+=1;src.push('observation')}
    if((visit.analysisGeneral?.tamis||[]).length){e.push(`${visit.analysisGeneral.tamis.length} relevé(s) de tamis disponible(s)`);score+=1;src.push('tamis')}
    if(!measured('fecesPH').length)m.push('pH des bouses non renseigné');if(!measured('fecesRedox').length)m.push('Redox des bouses non renseigné');
    if(e.length)pistes.push(makePiste(rule('intestinal-imbalance'),e,n,m,score,src));
    const fiberEvidence=[];let fiberScore=0;const fibers=obs('fecesAspect',['Fibres longues','Grains']),lowRumen=obs('rumenFill',['1','2']);
    if(fibers.length){fiberEvidence.push(`${fibers.length}/${subjects.length} sujet(s) avec fibres longues ou grains visibles dans les bouses`);fiberScore+=2;}
    if(lowRumen.length){fiberEvidence.push(`${lowRumen.length}/${subjects.length} remplissage(s) ruminal(aux) faible(s)`);fiberScore+=1;}
    if((visit.analysisGeneral?.tamis||[]).length){fiberEvidence.push(`${visit.analysisGeneral.tamis.length} relevé(s) de tamis disponible(s)`);fiberScore+=1;}
    if(fiberEvidence.length>=2)pistes.push(makePiste(rule('fiber-structure'),fiberEvidence,[],[],fiberScore,['bouses','physique','tamis']));
  }
  {
    const e=[],n=[],m=[],src=[];let score=0;const dense=abnormal('urineDensity','high'),dark=abnormal('urineColor','high'),lowFlow=build.drinkers.filter(d=>numericValue(d.flow)!==null&&numericValue(d.flow)<10),poorAccess=build.drinkers.filter(d=>['Moyenne','Insuffisante'].includes(d.accessibility));
    if(dense.length){e.push(`${dense.length}/${subjects.length} densité(s) urinaire(s) élevée(s)`);score+=2;src.push('urines')}
    if(dark.length){e.push(`${dark.length}/${subjects.length} urine(s) foncée(s)`);score+=1;src.push('urines')}
    if(lowFlow.length){e.push(`${lowFlow.length} abreuvoir(s) avec débit inférieur à 10 L/min`);score+=2;src.push('bâtiment')}
    if(poorAccess.length){e.push(`${poorAccess.length} point(s) d’eau à accessibilité moyenne ou insuffisante`);score+=2;src.push('bâtiment')}
    if(!build.drinkers.length)m.push('Aucun abreuvoir renseigné dans le bâtiment');if(!measured('urineDensity').length)m.push('Densités urinaires non renseignées');
    if(e.length)pistes.push(makePiste(rule('water-access'),e,n,m,score,src));
  }
  {
    const e=[],n=[],m=[],src=[];let score=0;const ration=visit.feeding?.rations||[],settings=visit.feeding?.settings||{};
    if(ration.length){e.push(`${ration.length} ligne(s) de ration renseignée(s)`);score+=1;src.push('alimentation')}
    if(settings.transition){e.push('Une transition alimentaire est documentée');score+=1;src.push('alimentation')}
    if(settings.saltAccess==='Absent'){e.push('Accès au sel indiqué comme absent');score+=2;src.push('alimentation')}
    if((visit.analysisGeneral?.silos||[]).length){e.push(`${visit.analysisGeneral.silos.length} relevé(s) de silo disponible(s)`);score+=1;src.push('fourrages')}
    if(!ration.length)m.push('Ration non renseignée');if(!settings.mineralization)m.push('Minéralisation non précisée');
    if(e.length>=2||settings.saltAccess==='Absent')pistes.push(makePiste(rule('feeding-practices'),e,n,m,score,src));
    if(settings.saltAccess==='Absent'||settings.saltAccess==='Insuffisant'||/absent|insuffisant|rare/i.test(settings.mineralization||'')){
      const se=['Accès au sel indiqué comme absent ou insuffisant'];
      if(abnormal('urineDensity','high').length)se.push('Urines concentrées sur une partie du lot');
      if(build.drinkers.some(d=>numericValue(d.flow)!==null&&numericValue(d.flow)<10))se.push('Au moins un débit d’abreuvoir faible');
      pistes.push(makePiste(rule('salt-deficiency'),se,[],['Consommation réelle de sel non mesurée'],3+se.length,['alimentation','urines','bâtiment']));
    }
    const ureaHigh=abnormal('urea','high'),ureaLow=abnormal('urea','low');
    if(ureaHigh.length||ureaLow.length){
      const ne=[];if(ureaHigh.length)ne.push(`${ureaHigh.length}/${subjects.length} urémie(s) élevée(s)`);if(ureaLow.length)ne.push(`${ureaLow.length}/${subjects.length} urémie(s) basse(s)`);
      if(ration.length)ne.push('Ration renseignée pour permettre un croisement azote–énergie');
      pistes.push(makePiste(rule('nitrogen-balance'),ne,[],ration.length?[]:['Ration non renseignée'],2+ne.length,['sang','alimentation']));
    }
  }
  {
    const e=[],n=[],m=[],src=[];let score=0;const wet=build.litters.filter(l=>numericValue(l.humidity)!==null&&numericValue(l.humidity)>=60),hot=build.litters.filter(l=>numericValue(l.temperature)!==null&&numericValue(l.temperature)>=35),electric=build.electric.filter(x=>numericValue(x.value)!==null&&numericValue(x.value)>20),q=build.questionnaire.filter(x=>['À surveiller','À corriger'].includes(x.status));
    if(wet.length){e.push(`${wet.length} zone(s) de litière avec humidité élevée`);score+=2;src.push('litière')}
    if(hot.length){e.push(`${hot.length} zone(s) de litière avec température élevée`);score+=2;src.push('litière')}
    if(electric.length){e.push(`${electric.length} mesure(s) électrique(s) supérieure(s) à 20 mV`);score+=2;src.push('électricité')}
    if(q.length){e.push(`${q.length} point(s) du questionnaire bâtiment à surveiller ou corriger`);score+=2;src.push('questionnaire')}
    if(!(build.litters.length+build.electric.length+build.questionnaire.length))m.push('Volet bâtiment peu ou pas renseigné');
    if(e.length)pistes.push(makePiste(rule('building-conditions'),e,n,m,score,src));
  }
  {
    const e=[],n=[],m=[],src=[];let score=0;const count=auditAttentionCount(visit,'reproduction');
    if(count){e.push(`${count} réponse(s) reproduction à surveiller ou corriger`);score+=Math.min(4,count);src.push('audit')}
    if(visit.auditGlobal?.renewal?.cowsEmpty){e.push(`${visit.auditGlobal.renewal.cowsEmpty} vache(s) vide(s) renseignée(s)`);score+=1;src.push('renouvellement')}
    if(!visit.auditGlobal)m.push('Audit global non renseigné');
    if(e.length)pistes.push(makePiste(rule('reproduction-practices'),e,n,m,score,src));
  }
  return pistes;
}
function reasoningState(visit,pisteId){visit.reasoningReview=visit.reasoningReview||{};return visit.reasoningReview[pisteId]||{status:'active',note:''};}
function renderQualityTable(rows){return `<div class="quality-grid">${rows.map(r=>`<div class="quality-item ${r.level}"><div><strong>${escapeHtml(r.label)}</strong><small>${r.value}/${r.total}</small></div><div class="quality-bar"><i style="width:${Math.min(100,Math.round(r.ratio*100))}%"></i></div></div>`).join('')}</div>`;}
function renderKnowledgePiste(visit,h,group){const state=reasoningState(visit,`${group.category}:${h.id}`);const list=(title,items,cls)=>items?.length?`<div class="reason-block ${cls}"><strong>${title}</strong><ul>${items.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`:'';return `<article class="reason-card ${state.status==='dismissed'?'dismissed':''}"><div class="reason-head"><div><span class="reason-domain">${escapeHtml(KNOWLEDGE_AXES.find(a=>a.id===h.axis)?.label||h.axis)}</span><h4>${escapeHtml(h.title)}</h4></div><span class="confidence ${h.confidence.className}">Confiance ${h.confidence.label} · ${h.sourceCount} source(s)</span></div>${confidenceBreakdownHtml(h)}<p>${escapeHtml(h.summary)}</p>${h.mechanism?`<div class="reason-explanation"><strong>Ce que cette piste peut traduire</strong><p>${escapeHtml(h.mechanism)}</p></div>`:''}${list('Faits et observations qui vont dans ce sens',h.evidence,'supports')}${list('Éléments qui invitent à la prudence',h.nuance,'nuances')}${list('Facteurs possibles à examiner',h.causes,'causes')}${list('Données manquantes',h.missing,'missing')}${list('Pistes de vérification',h.checks,'checks')}<div class="reason-review"><select data-reason-status="${escapeHtml(group.category+':'+h.id)}"><option value="active" ${state.status==='active'?'selected':''}>Piste retenue</option><option value="dismissed" ${state.status==='dismissed'?'selected':''}>Piste écartée</option><option value="watch" ${state.status==='watch'?'selected':''}>À surveiller</option></select><textarea data-reason-note="${escapeHtml(group.category+':'+h.id)}" placeholder="Justification / commentaire du technicien">${escapeHtml(state.note||'')}</textarea></div></article>`;}
function abnormalSubjectsForGroup(group){
  const bySubject=new Map();
  (group.parameterResults||[]).forEach(r=>(r.measured||[]).forEach(m=>{if(statusSeverity(m.result.status)<2)return;const id=m.subject.id;const row=bySubject.get(id)||{subject:m.subject,items:[]};row.items.push({label:r.parameter.label,value:m.value,status:m.result.status});bySubject.set(id,row);}));
  return [...bySubject.values()];
}
function abnormalSubjectsHtml(group){
  const rows=abnormalSubjectsForGroup(group);if(!rows.length)return '<div class="notice positive compact"><strong>Aucun animal hors référence dans les mesures exploitables.</strong></div>';
  return `<div class="abnormal-subjects"><strong>🐄 Animal(aux) hors référence :</strong>${rows.map(r=>`<div><b>${escapeHtml(r.subject.tag||r.subject.name||'Sujet')}</b>${r.subject.name&&r.subject.name!==r.subject.tag?` · ${escapeHtml(r.subject.name)}`:''}<span>${r.items.map(x=>`${escapeHtml(x.label)} : ${escapeHtml(String(x.value).replace('.',','))}`).join(' · ')}</span></div>`).join('')}</div>`;
}

function renderReasoningSection(visit){
  const groups=categoryAnalysis(visit);if(!groups.length)return'<div class="empty">Classez les sujets et saisissez des valeurs pour générer le raisonnement.</div>';
  return `<div class="notice"><strong>Moteur transparent :</strong> les faits mesurés, observations, données manquantes et pistes d’interprétation sont séparés. Le technicien peut retenir, surveiller ou écarter chaque piste.</div><div class="reason-groups">${groups.map(group=>{const quality=dataQualityForGroup(visit,group),pistes=buildKnowledgePistes(visit,group);return `<section class="card"><div class="section-title"><div><h3>${escapeHtml(group.category)}</h3><span class="muted">${group.subjects.length} sujet(s) · analyse par lot</span></div></div><h4>Fiabilité des données</h4>${renderQualityTable(quality)}${abnormalSubjectsHtml(group)}<h4 style="margin-top:18px">Pistes d’interprétation</h4>${pistes.length?`<div class="reason-grid">${pistes.map(h=>renderKnowledgePiste(visit,h,group)).join('')}</div>`:'<div class="empty">Aucune piste suffisamment étayée avec les données actuelles.</div>'}</section>`}).join('')}</div>`;
}

function renderAnalysisSummary(visit) {
  const groups=categoryAnalysis(visit), unclassified=(visit.subjects||[]).filter(s=>!s.category||s.category==='Non classé');
  if(!groups.length)return '<div class="empty">Classez les sujets et saisissez des mesures pour obtenir une synthèse.</div>';
  return `<div class="analysis-summary-groups">${groups.map(group=>{const interpretations=interpretationItems(group);return `<article class="card analysis-category-card"><div class="section-title"><div><h3>${escapeHtml(group.category)}</h3><span class="muted">${group.subjects.length} sujet(s)</span></div><span class="analysis-category-score">${group.parameterResults.length} paramètre(s)</span></div>${abnormalSubjectsHtml(group)}<div class="table-wrap"><table class="stats-table"><thead><tr><th>Paramètre</th><th>n</th><th>Min</th><th>Moyenne</th><th>Max</th><th>Hors réf.</th><th>Animal(aux) concerné(s)</th><th>Référence</th></tr></thead><tbody>${group.parameterResults.map(i=>{const out=i.measured.filter(m=>statusSeverity(m.result.status)>=2);return `<tr><td><strong>${escapeHtml(i.parameter.label)}</strong></td><td>${i.measured.length}</td><td>${i.minimum.toLocaleString('fr-FR',{maximumFractionDigits:2})}</td><td class="stat-main ${i.worst.result.status}">${i.average.toLocaleString('fr-FR',{maximumFractionDigits:2})}</td><td>${i.maximum.toLocaleString('fr-FR',{maximumFractionDigits:2})}</td><td>${i.outOfRange}/${i.measured.length}</td><td>${out.length?out.map(m=>escapeHtml(m.subject.tag||m.subject.name||'Sujet')).join(', '):'—'}</td><td>${escapeHtml(referenceText(i.rule))}</td></tr>`}).join('')}</tbody></table></div><div class="analysis-interpretations">${interpretations.map(i=>`<div class="analysis-message ${i.level}"><strong>${escapeHtml(i.title)}</strong><span>${escapeHtml(i.text)}</span><small>Action proposée : ${escapeHtml(i.action)}</small></div>`).join('')}</div><div class="field"><label>Conclusion du technicien</label><textarea data-analysis-conclusion="${escapeHtml(group.category)}">${escapeHtml(visit.analysisConclusions?.[group.category]||'')}</textarea></div></article>`;}).join('')}</div>${unclassified.length?`<div class="notice warning" style="margin-top:14px"><strong>${unclassified.length} sujet(s) non classé(s)</strong> : pas d’interprétation catégorielle.</div>`:''}`;
}

function renderNumericSection(visit) {
  const families = ['Urines','Sang','Bouses','Physique','Lait','Colostrum'];
  if (!families.includes(activeAnalysisFamily)) activeAnalysisFamily = 'Urines';
  const params = analysisParameters.filter(p => p.group === activeAnalysisFamily);
  const minWidth = 140 + 125 + (params.length * 105) + 210;
  const rows = visit.subjects.map(subject => `<tr data-analysis-subject-row="${subject.id}" class="${focusedAnalysisSubjectId===subject.id?'focused-subject-row':''}">
    <td class="sticky-col subject-sticky-cell" style="min-width:140px"><strong class="subject-sticky-tag">${escapeHtml(subject.tag||'Sujet')}</strong>${subject.name?`<small class="subject-sticky-name">${escapeHtml(subject.name)}</small>`:''}${subject.location?`<small class="subject-sticky-location">${escapeHtml(subject.location)}</small>`:''}${subjectContextMini(subject)}</td>
    <td class="sticky-col-2" style="min-width:125px"><span class="badge ${subject.category&&subject.category!=='Non classé'?'complete':'unclassified'}">${escapeHtml(subject.category||'Non classé')}</span></td>
    ${params.map(p=>analysisCell(subject,p)).join('')}
    <td class="matrix-comment-cell" style="min-width:200px"><textarea class="matrix-comment" data-family-comment data-subject-id="${subject.id}" data-family="${activeAnalysisFamily}" placeholder="Commentaire libre…">${escapeHtml(subject.measurements.comments?.[activeAnalysisFamily]||'')}</textarea></td>
  </tr>`).join('');
  return `<section class="card"><div class="section-title"><div><h3>Mesures numériques par famille</h3><span class="muted">Les sujets sont repris automatiquement. La valeur complète est validée et sauvegardée quand vous quittez la cellule.</span></div><span class="analysis-legend"><i class="green"></i> Référence <i class="yellow"></i> Vigilance <i class="red"></i> Écart <i class="grey"></i> En attente</span></div>
  <div class="family-tabs-row"><nav class="family-tabs">${families.map(f=>`<button class="family-tab ${activeAnalysisFamily===f?'active':''}" data-analysis-family="${f}">${f}</button>`).join('')}</nav><button class="btn secondary library-context-btn" data-open-library-theme="${escapeHtml(activeAnalysisFamily)}">📑 Planche ${escapeHtml(activeAnalysisFamily)}</button></div>
  ${params.length ? `<div class="table-wrap analysis-table-wrap"><table class="analysis-table matrix-table" style="min-width:${minWidth}px;width:${minWidth}px"><thead><tr><th class="sticky-col" style="min-width:140px">Sujet</th><th class="sticky-col-2" style="min-width:125px">Catégorie</th>${params.map(p=>`<th style="min-width:105px">${escapeHtml(p.short)}</th>`).join('')}<th class="comment-head" style="min-width:200px">Commentaire / observation</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="notice warning"><strong>Aucun paramètre configuré pour ${escapeHtml(activeAnalysisFamily)}.</strong></div>`}
  </section>`;
}

function obsControl(subject,field) { const data=subject.measurements.observations||{}; const current=data[field.key]; if(field.type==='number')return `<input data-observation data-numeric-observation class="decimal-input" data-subject-id="${subject.id}" data-key="${field.key}" type="text" inputmode="decimal" autocomplete="off" data-step="${field.step||'1'}" value="${escapeHtml(current??'')}"/>`; if(field.type==='text')return `<input data-observation data-subject-id="${subject.id}" data-key="${field.key}" value="${escapeHtml(current??'')}"/>`; if(field.type==='single')return `<select data-observation data-subject-id="${subject.id}" data-key="${field.key}"><option value="">—</option>${field.options.map(o=>{const same=String(current??'').replace('.',',')===String(o).replace('.',',');return `<option value="${escapeHtml(o)}" ${same?'selected':''}>${escapeHtml(o)}</option>`}).join('')}</select>`; const selected=Array.isArray(current)?current:[]; return `<div class="chip-options">${field.options.map(o=>`<label class="choice-chip ${selected.includes(o)?'selected':''}"><input type="checkbox" data-observation-multi data-subject-id="${subject.id}" data-key="${field.key}" value="${escapeHtml(o)}" ${selected.includes(o)?'checked':''}/>${escapeHtml(o)}</label>`).join('')}</div>`; }
function renderObservationsSection(visit) { return `<div class="subject-observation-list">${visit.subjects.map((s,i)=>`<details class="card observation-card" ${i===0?'open':''}><summary><div class="observation-subject-head"><strong>${escapeHtml(s.tag||`Sujet ${i+1}`)}${s.name?` · ${escapeHtml(s.name)}`:''}</strong><span>${escapeHtml(s.category||'Non classé')}${s.location?` · ${escapeHtml(s.location)}`:''}</span>${subjectContextMini(s)}</div><span class="observation-chevron">▾</span></summary><div class="observation-grid">${observationFields.map(f=>`<div class="field"><label>${escapeHtml(f.label)}</label>${obsControl(s,f)}</div>`).join('')}</div></details>`).join('')}</div>`; }
function generalField(record,configKey,field) { const [key,label,type,options]=field; const value=record[key]??''; if(type==='select')return `<div class="field"><label>${label}</label><select data-general-field data-kind="${configKey}" data-id="${record.id}" data-key="${key}"><option value="">—</option>${options.map(o=>`<option ${value===o?'selected':''}>${escapeHtml(o)}</option>`).join('')}</select></div>`; if(type==='multi'){const selected=Array.isArray(value)?value:[];return `<div class="field field-wide"><label>${label}</label><div class="chip-options">${options.map(o=>`<label class="choice-chip ${selected.includes(o)?'selected':''}"><input type="checkbox" data-general-multi data-kind="${configKey}" data-id="${record.id}" data-key="${key}" value="${escapeHtml(o)}" ${selected.includes(o)?'checked':''}/>${escapeHtml(o)}</label>`).join('')}</div></div>`;} return `<div class="field ${type==='text'&&key==='comment'?'field-wide':''}"><label>${label}</label><input data-general-field ${type==='number'?'data-numeric-general class="decimal-input"':''} data-kind="${configKey}" data-id="${record.id}" data-key="${key}" type="${type==='number'?'text':type}" ${type==='number'?'inputmode="decimal" autocomplete="off"':''} value="${escapeHtml(value)}"/></div>`; }
function dungSieveResult(total,t1,t2){
  const base=numericValue(total),v1=numericValue(t1),v2=numericValue(t2);
  const p1=base>0&&v1!==null?100*v1/base:null,p2=base>0&&v2!==null?100*v2/base:null;
  const c1=p1===null?'pending':p1<=10?'reference':p1<=15?'watch':'alert';
  let c2='pending';
  if(p2!==null){const aboveFirst=p1===null||p2>p1,delta=Math.abs(p2-12);c2=aboveFirst&&delta<=3?'reference':aboveFirst&&delta<=6?'watch':'alert';}
  return {p1,p2,c1,c2};
}
function dungSieveBox(r){const x=dungSieveResult(r.total,r.t1,r.t2),fmt=v=>v===null?'—':v.toFixed(1);return `<div class="calculated-box dung-sieve-box"><strong>Pourcentages automatiques</strong><span class="sieve-result ${x.c1}">Tamis 1 · 5 mm : <b>${fmt(x.p1)} %</b></span><span class="sieve-result ${x.c2}">Tamis 2 · 2 mm : <b>${fmt(x.p2)} %</b></span><small>Repères pratiques : 5 mm &lt; 10 % ; 2 mm autour de 12 % et supérieur au 5 mm.</small></div>`;}
function renderGeneralSection(visit) {
  const kinds = Object.keys(generalConfigs);
  if (!generalConfigs[activeGeneralKind]) activeGeneralKind = 'tamis';
  const cfg = generalConfigs[activeGeneralKind];
  const records = visit.analysisGeneral[activeGeneralKind] || [];
  const tabs = kinds.map(kind => {
    const item = generalConfigs[kind];
    const count = (visit.analysisGeneral[kind] || []).length;
    return `<button class="general-kind-tab ${activeGeneralKind===kind?'active':''}" data-general-kind="${kind}">${item.icon} ${escapeHtml(item.title)} <span class="count-badge">${count}</span></button>`;
  }).join('');
  return `<nav class="general-kind-tabs">${tabs}</nav>
  <section class="card general-active-card">
    <div class="section-title"><div><h3>${cfg.icon} ${cfg.title}</h3><span class="muted">Relevés indépendants des animaux · sauvegarde automatique.</span></div><div class="actions"><button class="btn secondary" data-open-library-theme="${escapeHtml(cfg.title)}">📑 Planche</button><button class="btn primary" data-add-general="${activeGeneralKind}">Ajouter un relevé</button></div></div>
    <div class="general-records">${records.length?records.map((r,i)=>`<article class="general-record"><div class="section-title"><strong>${escapeHtml(cfg.title)} ${i+1}</strong><button class="btn small danger" data-remove-general="${activeGeneralKind}" data-id="${r.id}">Supprimer</button></div><div class="general-grid">${cfg.fields.map(f=>generalField(r,activeGeneralKind,f)).join('')}${activeGeneralKind==='tamis'?dungSieveBox(r):''}</div></article>`).join(''):`<div class="empty">Aucun relevé. Cliquez sur « Ajouter un relevé ».</div>`}</div>
  </section>`;
}
function suggestedActions(visit) { const out=[]; categoryAnalysis(visit).forEach(g=>interpretationItems(g).filter(i=>i.level!=='good').forEach(i=>out.push({category:g.category,...i}))); return out; }
function ensureActionFields(action){
  action.priority=action.priority||'Moyenne';
  action.status=action.status||'À faire';
  action.responsible=action.responsible||'';
  action.dueDate=action.dueDate||'';
  action.progressNote=action.progressNote||'';
  action.createdAt=action.createdAt||new Date().toISOString();
  return action;
}
function actionPriorityClass(priority){return priority==='Haute'?'danger':priority==='Basse'?'archived':'in-progress';}
function renderSynthesisSection(visit) {
  const suggestions=suggestedActions(visit);visit.analysisActions=Array.isArray(visit.analysisActions)?visit.analysisActions:[];visit.analysisActions.forEach(ensureActionFields);
  return `<div id="analysis-summary">${renderAnalysisSummary(visit)}</div><section class="card" style="margin-top:16px"><div class="section-title"><div><h3>Plan d’action vivant</h3><span class="muted">Priorité, responsable, échéance et état d’avancement.</span></div><button class="btn" id="add-custom-action">Ajouter une action libre</button></div><div class="action-suggestions">${suggestions.length?suggestions.map((a,i)=>`<div class="action-line"><span class="badge ${a.level==='danger'?'in-progress':'archived'}">${a.level==='danger'?'Priorité haute':'À surveiller'}</span><div><strong>${escapeHtml(a.category)} — ${escapeHtml(a.theme)}</strong><br><span>${escapeHtml(a.action)}</span></div><button class="btn small" data-accept-action="${i}">Ajouter</button></div>`).join(''):'<div class="empty">Aucune action automatique proposée à ce stade.</div>'}</div><div class="action-list enriched">${visit.analysisActions.length?visit.analysisActions.map(a=>`<article class="action-edit enriched"><div class="action-edit-head"><select data-action-field="priority" data-action-id="${a.id}" class="priority-${escapeHtml(a.priority.toLowerCase())}"><option ${a.priority==='Haute'?'selected':''}>Haute</option><option ${a.priority==='Moyenne'?'selected':''}>Moyenne</option><option ${a.priority==='Basse'?'selected':''}>Basse</option></select><select data-action-field="status" data-action-id="${a.id}"><option ${a.status==='À faire'?'selected':''}>À faire</option><option ${a.status==='En cours'?'selected':''}>En cours</option><option ${a.status==='Réalisé'?'selected':''}>Réalisé</option><option ${a.status==='Abandonné'?'selected':''}>Abandonné</option></select><button class="btn small danger" data-remove-action="${a.id}">Supprimer</button></div><div class="field"><label>Action</label><input data-action-field="text" data-action-id="${a.id}" value="${escapeHtml(a.text||'')}"/></div><div class="row"><div class="field"><label>Responsable</label><input data-action-field="responsible" data-action-id="${a.id}" placeholder="Éleveur, technicien…" value="${escapeHtml(a.responsible||'')}"/></div><div class="field"><label>Échéance</label><input type="date" data-action-field="dueDate" data-action-id="${a.id}" value="${escapeHtml(a.dueDate||'')}"/></div></div><div class="field"><label>Point d’avancement</label><textarea data-action-field="progressNote" data-action-id="${a.id}" placeholder="Ce qui a été fait, difficultés, prochaine étape…">${escapeHtml(a.progressNote||'')}</textarea></div></article>`).join(''):''}</div></section>`;
}

function allPilotageActions(){
  const rows=[];db.visits.forEach(v=>(v.analysisActions||[]).forEach(a=>{ensureActionFields(a);rows.push({action:a,visit:v,farm:db.farms.find(f=>f.id===v.farmId)});}));return rows;
}
function renderPilotageActions(){
  const today=new Date().toISOString().slice(0,10),all=allPilotageActions();
  const open=all.filter(x=>!['Réalisé','Abandonné'].includes(x.action.status));
  const overdue=open.filter(x=>x.action.dueDate&&x.action.dueDate<today);
  const dueSoon=open.filter(x=>x.action.dueDate&&x.action.dueDate>=today&&x.action.dueDate<=new Date(Date.now()+30*86400000).toISOString().slice(0,10));
  const completed=all.filter(x=>x.action.status==='Réalisé');
  const farmsWithOpen=new Set(open.map(x=>x.visit.farmId)).size;
  const rows=all.slice().sort((a,b)=>{const pa={Haute:0,Moyenne:1,Basse:2}[a.action.priority]??3,pb={Haute:0,Moyenne:1,Basse:2}[b.action.priority]??3;return pa-pb||(a.action.dueDate||'9999').localeCompare(b.action.dueDate||'9999');});
  app.innerHTML=`<div class="section-title"><div><h2>🎯 Pilotage des actions</h2><div class="muted">Vue commune de toutes les actions décidées lors des visites.</div></div><span class="badge autosave">v14.6.21.68</span></div>
  <section class="grid cols-4 professional-kpis"><article class="card"><span>Actions ouvertes</span><strong>${open.length}</strong></article><article class="card"><span>En retard</span><strong>${overdue.length}</strong></article><article class="card"><span>Échéance sous 30 j</span><strong>${dueSoon.length}</strong></article><article class="card"><span>Exploitations concernées</span><strong>${farmsWithOpen}</strong></article></section>
  <section class="card pilotage-toolbar"><div class="field"><label>Filtrer</label><select id="pilotage-filter"><option value="all">Toutes les actions</option><option value="open">Ouvertes</option><option value="overdue">En retard</option><option value="high">Priorité haute</option><option value="done">Réalisées</option></select></div><div class="field"><label>Recherche</label><input id="pilotage-search" placeholder="Exploitation, action, responsable…"></div><div class="actions"><button class="btn secondary" id="pilotage-csv">Exporter CSV</button><button class="btn" id="pilotage-print">Imprimer / PDF</button></div></section>
  <section class="card"><div id="pilotage-list" class="pilotage-list"></div></section>`;
  const renderList=()=>{const f=document.getElementById('pilotage-filter').value,q=normalizeSearchText(document.getElementById('pilotage-search').value);let list=rows.filter(x=>{if(f==='open'&&['Réalisé','Abandonné'].includes(x.action.status))return false;if(f==='overdue'&&!(x.action.dueDate&&x.action.dueDate<today&&!['Réalisé','Abandonné'].includes(x.action.status)))return false;if(f==='high'&&x.action.priority!=='Haute')return false;if(f==='done'&&x.action.status!=='Réalisé')return false;const hay=normalizeSearchText([x.farm?.name,x.farm?.farmNumber,x.action.text,x.action.responsible,x.action.progressNote].join(' '));return !q||hay.includes(q);});document.getElementById('pilotage-list').innerHTML=list.length?list.map(x=>{const late=x.action.dueDate&&x.action.dueDate<today&&!['Réalisé','Abandonné'].includes(x.action.status);return `<article class="pilotage-action ${late?'overdue':''}"><div class="pilotage-action-main"><select data-pilotage-field="priority" data-action-id="${x.action.id}" data-visit-id="${x.visit.id}"><option ${x.action.priority==='Haute'?'selected':''}>Haute</option><option ${x.action.priority==='Moyenne'?'selected':''}>Moyenne</option><option ${x.action.priority==='Basse'?'selected':''}>Basse</option></select><div><strong>${escapeHtml(x.action.text||'Action sans intitulé')}</strong><small>${escapeHtml(x.farm?.name||'Exploitation')} · visite du ${formatDate(x.visit.date)}</small></div></div><div class="pilotage-action-meta"><input data-pilotage-field="responsible" data-action-id="${x.action.id}" data-visit-id="${x.visit.id}" value="${escapeHtml(x.action.responsible||'')}" placeholder="Responsable"><input type="date" data-pilotage-field="dueDate" data-action-id="${x.action.id}" data-visit-id="${x.visit.id}" value="${escapeHtml(x.action.dueDate||'')}"><select data-pilotage-status="${x.action.id}" data-visit-id="${x.visit.id}"><option ${x.action.status==='À faire'?'selected':''}>À faire</option><option ${x.action.status==='En cours'?'selected':''}>En cours</option><option ${x.action.status==='Réalisé'?'selected':''}>Réalisé</option><option ${x.action.status==='Bloquée'?'selected':''}>Bloquée</option><option ${x.action.status==='Abandonné'?'selected':''}>Abandonné</option></select><button class="btn small" data-action-news="${x.action.id}" data-farm-id="${x.farm?.id||''}">Ajouter une nouvelle</button><button class="btn small" data-open-pilotage-visit="${x.visit.id}">Ouvrir la visite</button></div>${x.action.progressNote?`<p>${escapeHtml(x.action.progressNote)}</p>`:''}</article>`;}).join(''):'<div class="empty">Aucune action correspondant au filtre.</div>';document.querySelectorAll('[data-pilotage-status]').forEach(el=>el.onchange=()=>{const v=db.visits.find(v=>v.id===el.dataset.visitId),a=v?.analysisActions?.find(a=>a.id===el.dataset.pilotageStatus);if(a){a.status=el.value;a.updatedAt=new Date().toISOString();saveDatabase(db);renderPilotageActions();}});document.querySelectorAll('[data-pilotage-field]').forEach(el=>el.onchange=()=>{const v=db.visits.find(v=>v.id===el.dataset.visitId),a=v?.analysisActions?.find(a=>a.id===el.dataset.actionId);if(a){a[el.dataset.pilotageField]=el.value;a.updatedAt=new Date().toISOString();saveDatabase(db);renderPilotageActions();}});document.querySelectorAll('[data-action-news]').forEach(b=>b.onclick=()=>{localStorage.setItem('audit-bovin-journal-farm',b.dataset.farmId);localStorage.setItem('audit-bovin-journal-action',b.dataset.actionNews);setView('journal');});document.querySelectorAll('[data-open-pilotage-visit]').forEach(b=>b.onclick=()=>{setActiveVisit(b.dataset.openPilotageVisit);setView('analysis');});};
  document.getElementById('pilotage-filter').onchange=renderList;document.getElementById('pilotage-search').oninput=renderList;document.getElementById('pilotage-csv').onclick=()=>{const lines=[['Exploitation','EDE','Date visite','Action','Priorité','Statut','Responsable','Échéance','Avancement'],...rows.map(x=>[x.farm?.name||'',x.farm?.farmNumber||'',x.visit.date||'',x.action.text||'',x.action.priority||'',x.action.status||'',x.action.responsible||'',x.action.dueDate||'',x.action.progressNote||''])];const csv=lines.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n');const blob=new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`pilotage-actions-${today}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);};document.getElementById('pilotage-print').onclick=()=>window.print();renderList();
}

function renderConclusionSection(visit){
  const c=ensureVisitConclusion(visit),auto=autoVisitConclusion(visit);
  const autoStrengths=auto.strengths.filter(x=>!c.strengths.includes(x));
  return `<div class="conclusion-layout"><section class="card conclusion-card"><div class="section-title"><div><h3>✅ Conclusion de visite</h3><div class="muted">Validez ici la synthèse qui sera reprise dans les rapports.</div></div><span class="badge autosave">Sauvegarde automatique</span></div><div class="field"><label>Points favorables (un par ligne)</label><textarea id="conclusion-strengths" rows="5">${escapeHtml(c.strengths.join('\n'))}</textarea></div>${autoStrengths.length?`<div class="conclusion-suggestions"><strong>Suggestions automatiques</strong>${autoStrengths.map((x,i)=>`<button type="button" class="btn small secondary" data-add-conclusion-strength="${i}">+ ${escapeHtml(x)}</button>`).join('')}</div>`:''}<div class="grid cols-3"><div class="field"><label>Priorité haute</label><textarea id="conclusion-high" rows="4" placeholder="Point(s) à traiter en priorité">${escapeHtml(c.high)}</textarea></div><div class="field"><label>Priorité moyenne</label><textarea id="conclusion-medium" rows="4">${escapeHtml(c.medium)}</textarea></div><div class="field"><label>Priorité basse / surveillance</label><textarea id="conclusion-low" rows="4">${escapeHtml(c.low)}</textarea></div></div><div class="field"><label>Conclusion générale</label><textarea id="conclusion-general" rows="6" placeholder="Synthèse validée par le technicien">${escapeHtml(c.general)}</textarea></div><div class="field"><label>À revoir lors de la prochaine visite</label><textarea id="conclusion-next" rows="3">${escapeHtml(c.next)}</textarea></div></section><section class="card conclusion-card"><div class="section-title"><div><h3>🎯 Priorités / décisions</h3><div class="muted">Jusqu’à 6 lignes. Les propositions automatiques peuvent être modifiées librement.</div></div><button type="button" class="btn small" id="conclusion-use-auto">Reprendre les propositions</button></div><div class="conclusion-priority-list">${c.priorities.slice(0,6).map((x,i)=>`<article class="conclusion-priority"><span>${i+1}</span><div class="field"><label>Action / priorité</label><input data-conclusion-priority="text" data-index="${i}" value="${escapeHtml(x.text||'')}"></div><div class="field"><label>Source</label><input data-conclusion-priority="source" data-index="${i}" value="${escapeHtml(x.source||'')}"></div><div class="field"><label>Décision</label><select data-conclusion-priority="decision" data-index="${i}">${['À étudier','À faire','En cours','Réalisé','Surveillance'].map(v=>`<option ${x.decision===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Commentaire</label><input data-conclusion-priority="comment" data-index="${i}" value="${escapeHtml(x.comment||'')}"></div></article>`).join('')}</div></section></div>`;
}
function bindConclusionEvents(visit){
  const c=ensureVisitConclusion(visit),save=()=>{visit.updatedAt=new Date().toISOString();saveDatabase(db);};
  const map=[['conclusion-strengths','strengths'],['conclusion-high','high'],['conclusion-medium','medium'],['conclusion-low','low'],['conclusion-general','general'],['conclusion-next','next']];
  map.forEach(([id,key])=>{const el=document.getElementById(id);if(!el)return;el.oninput=()=>{if(key==='strengths')c.strengths=el.value.split(/\n+/).map(x=>x.trim()).filter(Boolean);else c[key]=el.value;save();};});
  app.querySelectorAll('[data-conclusion-priority]').forEach(el=>{const fn=()=>{const i=Number(el.dataset.index);while(c.priorities.length<=i)c.priorities.push({text:'',source:'',decision:'À étudier',comment:''});c.priorities[i][el.dataset.conclusionPriority]=el.value;save();};el.oninput=fn;el.onchange=fn;});
  const auto=autoVisitConclusion(visit);app.querySelectorAll('[data-add-conclusion-strength]').forEach(b=>b.onclick=()=>{const x=auto.strengths.filter(x=>!c.strengths.includes(x))[Number(b.dataset.addConclusionStrength)];if(x&&!c.strengths.includes(x)){c.strengths.push(x);save();renderAnalysis();}});
  document.getElementById('conclusion-use-auto')?.addEventListener('click',()=>{const a=autoVisitConclusion(visit);c.priorities=a.priorities.map(x=>({...x}));save();renderAnalysis();});
}

let analysisHeaderCloneCleanup=null;
function setupPersistentAnalysisHeader(){
  if(analysisHeaderCloneCleanup){analysisHeaderCloneCleanup();analysisHeaderCloneCleanup=null;}
  document.querySelectorAll('.analysis-floating-head').forEach(x=>x.remove());
  const wrap=app.querySelector('.analysis-table-wrap');
  const table=wrap?.querySelector('.analysis-table');
  const thead=table?.querySelector('thead');
  if(!wrap||!table||!thead)return;
  const overlay=document.createElement('div');
  overlay.className='analysis-floating-head';
  overlay.setAttribute('aria-hidden','true');
  const inner=document.createElement('div');inner.className='analysis-floating-head-inner';
  const clone=document.createElement('table');clone.className='analysis-table matrix-table analysis-floating-table';
  clone.appendChild(thead.cloneNode(true));inner.appendChild(clone);overlay.appendChild(inner);document.body.appendChild(overlay);
  let raf=0;
  const sync=()=>{
    raf=0;
    if(!document.body.contains(wrap)){overlay.remove();return;}
    const wr=wrap.getBoundingClientRect();
    const vv=window.visualViewport;
    const topEdge=Math.max(0,vv?vv.offsetTop:0);
    const originalHead=thead.getBoundingClientRect();
    const headH=Math.max(1,originalHead.height||thead.offsetHeight||36);
    const intersects=wr.bottom>topEdge+headH && wr.top<((vv?vv.height:window.innerHeight)+topEdge);
    const headerLost=wr.top<topEdge && originalHead.top<topEdge+1;
    overlay.classList.toggle('visible',Boolean(intersects&&headerLost));
    overlay.style.top=`${topEdge}px`;
    overlay.style.left=`${Math.max(0,wr.left)}px`;
    overlay.style.width=`${Math.max(0,Math.min(wr.right,window.innerWidth)-Math.max(0,wr.left))}px`;
    clone.style.width=`${table.scrollWidth}px`;
    clone.style.transform=`translateX(${-wrap.scrollLeft}px)`;
    const src=[...thead.querySelectorAll('th')], dst=[...clone.querySelectorAll('th')];
    src.forEach((th,i)=>{if(dst[i]){const w=th.getBoundingClientRect().width;dst[i].style.width=`${w}px`;dst[i].style.minWidth=`${w}px`;dst[i].style.maxWidth=`${w}px`;}});
  };
  const requestSync=()=>{if(!raf)raf=requestAnimationFrame(sync);};
  wrap.addEventListener('scroll',requestSync,{passive:true});
  window.addEventListener('scroll',requestSync,{passive:true});
  window.addEventListener('resize',requestSync,{passive:true});
  window.visualViewport?.addEventListener('resize',requestSync,{passive:true});
  window.visualViewport?.addEventListener('scroll',requestSync,{passive:true});
  wrap.querySelectorAll('input,textarea,select').forEach(el=>el.addEventListener('focus',requestSync,{passive:true}));
  requestSync();
  analysisHeaderCloneCleanup=()=>{
    if(raf)cancelAnimationFrame(raf);
    wrap.removeEventListener('scroll',requestSync);
    window.removeEventListener('scroll',requestSync);
    window.removeEventListener('resize',requestSync);
    window.visualViewport?.removeEventListener('resize',requestSync);
    window.visualViewport?.removeEventListener('scroll',requestSync);
    overlay.remove();
  };
}

function renderAnalysis() {
  const visits=db.visits.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  if(!activeVisitId&&visits.length)setActiveVisit(visits[0].id);
  const visit=activeVisit();
  if(visit){enrichVisitSubjectsFromReproduction(visit);ensureAnalysisVisit(visit);restoreAnalysisPending(visit);}
  const tabs=[['numeric','Matrices par famille'],['observations','Observations'],['general','Tamis · Silos · Sol · Plantes'],['reasoning','Raisonnement'],['summary','Statistiques & actions'],['conclusion','Conclusion de visite']];
  if(!tabs.some(([k])=>k===activeAnalysisSection)){activeAnalysisSection='numeric';localStorage.setItem('audit-bovin-active-analysis-section','numeric');}
  app.innerHTML=`<div class="section-title"><div><h2>Mesures</h2><div class="muted">Saisie des mesures, observations et relevés généraux. La synthèse et le raisonnement restent accessibles dans les onglets internes.</div></div><span class="badge autosave">Sauvegarde automatique</span></div>
  ${activeVisitBanner(visit)}
  ${!visit?'<div class="empty" style="margin-top:16px">Choisissez une visite dans l’onglet Visites.</div>':!visit.subjects?.length?'<div class="empty" style="margin-top:16px">Ajoutez des sujets dans l’onglet Animaux.</div>':`<section class="card analysis-utilities"><div class="actions"><button class="btn" id="analysis-demo">Jeu d’essai</button><button class="btn secondary" id="analysis-clear">Effacer l’analyse</button></div></section><nav class="analysis-tabs">${tabs.map(([k,l])=>`<button class="analysis-tab ${activeAnalysisSection===k?'active':''}" data-analysis-section="${k}">${l}</button>`).join('')}</nav><section class="analysis-content">${activeAnalysisSection==='numeric'?renderNumericSection(visit):activeAnalysisSection==='observations'?renderObservationsSection(visit):activeAnalysisSection==='general'?renderGeneralSection(visit):activeAnalysisSection==='reasoning'?renderReasoningSection(visit):activeAnalysisSection==='summary'?renderSynthesisSection(visit):renderConclusionSection(visit)}</section>`}`;
  enhanceNumericEntry(app);
  app.querySelectorAll('[data-analysis-section]').forEach(b=>b.onclick=()=>{activeAnalysisSection=b.dataset.analysisSection;localStorage.setItem('audit-bovin-active-analysis-section',activeAnalysisSection);renderAnalysis();});
  app.querySelectorAll('[data-analysis-family]').forEach(b=>b.onclick=()=>{activeAnalysisFamily=b.dataset.analysisFamily;localStorage.setItem('audit-bovin-active-analysis-family',activeAnalysisFamily);renderAnalysis();});
  app.querySelectorAll('[data-general-kind]').forEach(b=>b.onclick=()=>{activeGeneralKind=b.dataset.generalKind;localStorage.setItem('audit-bovin-active-general-kind',activeGeneralKind);renderAnalysis();});
  app.querySelectorAll('[data-open-library-theme]').forEach(b=>b.onclick=()=>openLibraryTheme(b.dataset.openLibraryTheme));
  bindAnalysisEvents(visit);
  setupPersistentAnalysisHeader();
  if(activeAnalysisSection==='conclusion')bindConclusionEvents(visit);
  if (focusedAnalysisSubjectId && activeAnalysisSection === 'numeric') {
    setTimeout(() => {
      const row = app.querySelector(`[data-analysis-subject-row="${focusedAnalysisSubjectId}"]`);
      row?.scrollIntoView({ behavior:'smooth', block:'center', inline:'nearest' });
      row?.querySelector('input')?.focus({ preventScroll:true });
      focusedAnalysisSubjectId='';
      localStorage.removeItem('audit-bovin-focused-analysis-subject');
    }, 80);
  }
}

function bindAnalysisEvents(visit) {
  if(!visit)return;
  enhanceNumericEntry(app);
  app.querySelectorAll('.analysis-input').forEach(input=>{
    let committedValue=String(input.value??'');
    const subject=visit.subjects.find(x=>x.id===input.dataset.subjectId);
    if(!subject)return;
    const refreshCell=(value)=>{const result=subject.category&&subject.category!=='Non classé'?classifyValue(value,thresholdFor(subject,input.dataset.param)):(value===''?{status:'empty',label:'Non mesuré'}:{status:'unclassified',label:'Classer le sujet'});const cell=input.closest('.analysis-value-cell');if(cell){cell.className=`analysis-value-cell ${result.status}`;const small=cell.querySelector('small');if(small)small.textContent=result.label;}};
    const draft=()=>{const value=String(input.value??'');writeAnalysisPending(visit.id,subject.id,input.dataset.param,value);refreshCell(value);};
    const commit=()=>{let value=String(input.value??'');value=normalizedMeasurementValue(value);input.value=value;subject.measurements=subject.measurements||{};subject.measurements.analysis=subject.measurements.analysis||{};subject.measurements.analysis[input.dataset.param]=value;subject.updatedAt=new Date().toISOString();visit.updatedAt=new Date().toISOString();committedValue=value;/* filet local immédiat avant tout changement de case */writeAnalysisPending(visit.id,subject.id,input.dataset.param,value);refreshCell(value);scheduleAnalysisSave(120,visit.id);};
    input.addEventListener('input',draft);
    input.addEventListener('compositionend',draft);
    input.addEventListener('change',commit);
    input.addEventListener('blur',()=>{requestAnimationFrame(()=>commit());});
    input.addEventListener('keydown',e=>{if(e.key==='Enter')commit();},true);
  });
  app.querySelectorAll('[data-family-comment]').forEach(el=>{const save=(immediate=false)=>{const s=visit.subjects.find(x=>x.id===el.dataset.subjectId);if(!s)return;s.measurements.comments=s.measurements.comments||{};s.measurements.comments[el.dataset.family]=el.value;s.updatedAt=new Date().toISOString();visit.updatedAt=new Date().toISOString();if(immediate)scheduleAnalysisSave(80,visit.id);else scheduleAnalysisSave(650,visit.id);};el.oninput=()=>save(false);el.onchange=()=>save(true);el.onblur=()=>save(true);});
  app.querySelectorAll('[data-observation]').forEach(el=>{const numeric=el.hasAttribute('data-numeric-observation');const save=()=>{const s=visit.subjects.find(x=>x.id===el.dataset.subjectId);if(!s)return;let value=el.value;if(numeric){value=normalizedMeasurementValue(value);el.value=value;}s.measurements.observations[el.dataset.key]=value;visit.updatedAt=new Date().toISOString();scheduleAnalysisSave(120,visit.id);};if(numeric){el.onchange=save;el.onblur=()=>requestAnimationFrame(save);el.addEventListener('keydown',e=>{if(e.key==='Enter')save();},true);}else{el.oninput=save;el.onchange=save;el.onblur=save;}});
  app.querySelectorAll('[data-observation-multi]').forEach(el=>el.onchange=()=>{const s=visit.subjects.find(x=>x.id===el.dataset.subjectId);const key=el.dataset.key;s.measurements.observations[key]=[...app.querySelectorAll(`[data-observation-multi][data-subject-id="${s.id}"][data-key="${key}"]:checked`)].map(x=>x.value);visit.updatedAt=new Date().toISOString();saveDatabase(db);el.closest('.choice-chip')?.classList.toggle('selected',el.checked);});
  app.querySelectorAll('.observation-card').forEach(d=>d.addEventListener('toggle',()=>{if(!d.open)return;app.querySelectorAll('.observation-card').forEach(other=>{if(other!==d)other.open=false;});}));
  app.querySelectorAll('[data-add-general]').forEach(b=>b.onclick=()=>{visit.analysisGeneral[b.dataset.addGeneral].push({id:uid(b.dataset.addGeneral),date:new Date().toISOString().slice(0,10)});saveDatabase(db);renderAnalysis();});
  app.querySelectorAll('[data-remove-general]').forEach(b=>b.onclick=()=>{visit.analysisGeneral[b.dataset.removeGeneral]=visit.analysisGeneral[b.dataset.removeGeneral].filter(r=>r.id!==b.dataset.id);saveDatabase(db);renderAnalysis();});
  app.querySelectorAll('[data-general-field]').forEach(el=>{const numeric=el.hasAttribute('data-numeric-general');const save=()=>{const r=visit.analysisGeneral[el.dataset.kind].find(x=>x.id===el.dataset.id);if(!r)return;let value=el.value;if(numeric){value=normalizedMeasurementValue(value);el.value=value;}r[el.dataset.key]=value;visit.updatedAt=new Date().toISOString();scheduleAnalysisSave(120,visit.id);if(el.dataset.kind==='tamis'&&['total','t1','t2'].includes(el.dataset.key)){const box=el.closest('.general-record')?.querySelector('.dung-sieve-box');if(box){const wrap=document.createElement('div');wrap.innerHTML=dungSieveBox(r);box.replaceWith(wrap.firstElementChild);}}};if(numeric){el.onchange=save;el.onblur=()=>requestAnimationFrame(save);el.addEventListener('keydown',e=>{if(e.key==='Enter')save();},true);}else{el.oninput=save;el.onchange=save;el.onblur=save;}});
  app.querySelectorAll('[data-general-multi]').forEach(el=>el.onchange=()=>{const r=visit.analysisGeneral[el.dataset.kind].find(x=>x.id===el.dataset.id);r[el.dataset.key]=[...app.querySelectorAll(`[data-general-multi][data-kind="${el.dataset.kind}"][data-id="${el.dataset.id}"][data-key="${el.dataset.key}"]:checked`)].map(x=>x.value);saveDatabase(db);el.closest('.choice-chip')?.classList.toggle('selected',el.checked);});
  app.querySelectorAll('[data-analysis-conclusion]').forEach(el=>el.oninput=()=>{visit.analysisConclusions[el.dataset.analysisConclusion]=el.value;saveDatabase(db);});
  const suggestions=suggestedActions(visit); app.querySelectorAll('[data-accept-action]').forEach(b=>b.onclick=()=>{const s=suggestions[Number(b.dataset.acceptAction)];visit.analysisActions.push({id:uid('action'),text:`${s.category} — ${s.action}`,responsible:'',status:'À faire',priority:s.level==='danger'?'Haute':'Moyenne',dueDate:'',progressNote:'',createdAt:new Date().toISOString()});saveDatabase(db);renderAnalysis();});
  document.getElementById('add-custom-action')?.addEventListener('click',()=>{visit.analysisActions.push({id:uid('action'),text:'',responsible:'',status:'À faire',priority:'Moyenne',dueDate:'',progressNote:'',createdAt:new Date().toISOString()});saveDatabase(db);renderAnalysis();});
  app.querySelectorAll('[data-action-field]').forEach(el=>{const save=()=>{const a=visit.analysisActions.find(x=>x.id===el.dataset.actionId);a[el.dataset.actionField]=el.value;saveDatabase(db);};el.oninput=save;el.onchange=save;});
  app.querySelectorAll('[data-remove-action]').forEach(b=>b.onclick=()=>{visit.analysisActions=visit.analysisActions.filter(a=>a.id!==b.dataset.removeAction);saveDatabase(db);renderAnalysis();});
  app.querySelectorAll('[data-reason-status]').forEach(el=>el.onchange=()=>{visit.reasoningReview=visit.reasoningReview||{};const cur=visit.reasoningReview[el.dataset.reasonStatus]||{};visit.reasoningReview[el.dataset.reasonStatus]={...cur,status:el.value};saveDatabase(db);renderAnalysis();});
  app.querySelectorAll('[data-reason-note]').forEach(el=>el.oninput=()=>{visit.reasoningReview=visit.reasoningReview||{};const cur=visit.reasoningReview[el.dataset.reasonNote]||{status:'active'};visit.reasoningReview[el.dataset.reasonNote]={...cur,note:el.value};saveDatabase(db);});
  document.getElementById('analysis-demo')?.addEventListener('click',()=>{if(!confirm('Charger un jeu d’essai ?'))return;const cats=['Fraîche vêlée','Pic de lactation','Préparation vêlage','Fin lactation'];visit.subjects.forEach((s,i)=>{if(!s.category||s.category==='Non classé')s.category=cats[i%cats.length];const alert=i%3===1;s.measurements.analysis={nec:alert?'2':'3.25',urineColor:alert?'4':'2',urinePH:alert?'8.7':'7.3',urineRedox:alert?'15':'-10',urineBrix:alert?'9':'4',urineDensity:alert?'1036':'1020',glucose:alert?'39':'58',boh:alert?'1.5':'0.4',bloodPH:alert?'7.5':'7.4',urea:alert?'0.34':'0.25',fecesPH:alert?'6.2':'6.65',fecesRedox:alert?'-145':'-205',milkPH:'6.6',milkBrix:'11',colostrumBrix:'24'};s.measurements.observations={muscles:alert?'-':'0',coat:alert?['Ternes','Hirsutes']:['Fins','Soyeux'],fecesAspect:alert?['Liquides','Grains']:['Moulées'],limbs:alert?['Boiterie']:[],locomotion:alert?'2':'1',rumenFill:alert?'2':'4'};});visit.analysisGeneral.tamis=[{id:uid('tamis'),category:'Vaches en production',represented:'8',total:'500',t1:'80',t2:'65',comment:'Mélange du lot'}];saveDatabase(db);renderAnalysis();});
  document.getElementById('analysis-clear')?.addEventListener('click',()=>{if(!confirm('Effacer toutes les données du module Analyse ?'))return;visit.subjects.forEach(s=>{s.measurements.analysis={};s.measurements.observations={};s.measurements.comments={};});visit.analysisGeneral={tamis:[],silos:[],soils:[],plants:[]};visit.analysisConclusions={};visit.analysisActions=[];saveDatabase(db);renderAnalysis();});
}


function feedingRowHtml(row, index) {
  return `<tr data-feeding-row="${row.id}">
    <td class="row-number">${index + 1}</td>
    <td><select data-feeding-field="category" data-id="${row.id}">${feedingCategories.map(v => `<option ${row.category===v?'selected':''}>${v}</option>`).join('')}</select></td>
    <td><select data-feeding-field="type" data-id="${row.id}">${feedTypes.map(v => `<option ${row.type===v?'selected':''}>${v}</option>`).join('')}</select></td>
    <td><input data-feeding-field="nature" data-id="${row.id}" value="${escapeHtml(row.nature || '')}" placeholder="Ex. maïs, prairie, VL18…" /><select data-feeding-field="feedRefId" data-id="${row.id}" title="Valeur type si absence d’analyse"><option value="">Sans valeur type</option>${Object.entries(allFeedReferences()).map(([k,v])=>`<option value="${k}" ${row.feedRefId===k?'selected':''}>📚 ${escapeHtml(v.label)}</option>`).join('')}</select></td>
    <td><input data-feeding-field="quantity" data-id="${row.id}" inputmode="decimal" value="${escapeHtml(row.quantity || '')}" placeholder="Quantité" /></td>
    <td><select data-feeding-field="unit" data-id="${row.id}">${feedUnits.map(v => `<option ${row.unit===v?'selected':''}>${v}</option>`).join('')}</select></td>
    <td><select data-feeding-field="distribution" data-id="${row.id}">${distributionModes.map(v => `<option ${row.distribution===v?'selected':''}>${v}</option>`).join('')}</select></td>
    <td><input data-feeding-field="frequency" data-id="${row.id}" value="${escapeHtml(row.frequency || '')}" placeholder="Ex. 2 fois/j, 8 h–18 h" /></td>
    <td><textarea data-feeding-field="comment" data-id="${row.id}" placeholder="Commentaire">${escapeHtml(row.comment || '')}</textarea></td>
    <td><div class="feeding-row-actions"><button type="button" class="btn small" data-duplicate-feed="${row.id}">Dupliquer</button><button type="button" class="btn small danger" data-delete-feed="${row.id}">Supprimer</button></div></td>
  </tr>`;
}



const TYPICAL_FEED_LIBRARY={
  mais_grain:{label:'Maïs grain',source:'Table type INRAE/AFZ — estimation',ms:86.3,mat:8.8,ndf:12.4,starch:73.9,sugar:2.0,ca:0.03,p:0.30,cu:3,zn:25,mn:7,se:0.05,co:0.05},
  mais_ensilage:{label:'Ensilage de maïs',source:'Valeur type — estimation',ms:33,mat:8.0,ndf:42,starch:33,sugar:2.0,ca:0.23,p:0.22,cu:5,zn:25,mn:35,se:0.05,co:0.08},
  sorgho_ensilage:{label:'Ensilage de sorgho',source:'Valeur type — estimation',ms:30,mat:8.5,ndf:55,starch:18,sugar:4,ca:0.35,p:0.25,cu:7,zn:30,mn:45,se:0.08,co:0.10},
  enrubannage_prairie:{label:'Enrubannage de prairie',source:'Valeur type — estimation',ms:55,mat:13.5,ndf:50,starch:2,sugar:7,ca:0.60,p:0.30,cu:8,zn:35,mn:70,se:0.08,co:0.15},
  enrubannage_luzerne:{label:'Enrubannage de luzerne',source:'Valeur type — estimation',ms:55,mat:18.0,ndf:44,starch:2,sugar:5,ca:1.35,p:0.28,cu:10,zn:25,mn:35,se:0.10,co:0.20},
  foin_prairie:{label:'Foin de prairie',source:'Valeur type — estimation',ms:85,mat:10.0,ndf:60,starch:2,sugar:9,ca:0.55,p:0.25,cu:7,zn:30,mn:60,se:0.08,co:0.15},
  foin_luzerne:{label:'Foin de luzerne',source:'Valeur type — estimation',ms:85,mat:17.0,ndf:48,starch:2,sugar:7,ca:1.40,p:0.27,cu:10,zn:25,mn:35,se:0.10,co:0.20},
  herbe_paturee:{label:'Herbe pâturée / prairie',source:'Valeur type — estimation',ms:20,mat:18.0,ndf:45,starch:2,sugar:12,ca:0.70,p:0.35,cu:8,zn:35,mn:80,se:0.10,co:0.20},
  paille:{label:'Paille de céréales',source:'Valeur type — estimation',ms:86,mat:4.0,ndf:78,starch:2,sugar:2,ca:0.30,p:0.10,cu:4,zn:20,mn:40,se:0.05,co:0.10},
  orge:{label:'Orge grain',source:'Table type INRAE/AFZ — estimation',ms:87.2,mat:11.4,ndf:21.4,starch:60.0,sugar:2.5,ca:0.05,p:0.35,cu:5,zn:28,mn:18,se:0.08,co:0.05},
  ble:{label:'Blé grain',source:'Valeur type — estimation',ms:87,mat:12.0,ndf:13,starch:67,sugar:2.5,ca:0.06,p:0.35,cu:5,zn:30,mn:35,se:0.08,co:0.05},
  triticale:{label:'Triticale grain',source:'Valeur type — estimation',ms:87,mat:11.5,ndf:15,starch:64,sugar:2.5,ca:0.06,p:0.35,cu:5,zn:30,mn:35,se:0.08,co:0.05},
  sorgho_grain:{label:'Sorgho grain',source:'INRA-CIRAD-AFZ — estimation',ms:87.8,mat:10.6,ndf:11.1,starch:73.6,sugar:1.3,ca:0.03,p:0.35,cu:6,zn:24,mn:15,se:0.05,co:0.05}
};
const DEFAULT_MINERAL_TARGETS={co:0.20,cu:10,i:0.50,mn:40,se:0.30,zn:50};
const MINERAL_LABELS={co:'Cobalt (Co)',cu:'Cuivre (Cu)',i:'Iode (I)',mn:'Manganèse (Mn)',se:'Sélénium (Se)',zn:'Zinc (Zn)'};
function allFeedReferences(){const custom={};ensureReferenceSettings().customFeedReferences.forEach(r=>{if(r?.id)custom[r.id]=r;});return {...TYPICAL_FEED_LIBRARY,...custom};}
function feedReference(key){const b=allFeedReferences()[key];if(!b)return null;return {...b,...(ensureReferenceSettings().feedReferenceOverrides?.[key]||{})};}
function mineralTarget(key){const v=nValue(ensureReferenceSettings().mineralNeedTargets?.[key]);return v===null?DEFAULT_MINERAL_TARGETS[key]:v;}
function ensureSupplementation(visit){visit.feeding=visit.feeding&&typeof visit.feeding==='object'?visit.feeding:{rations:[],settings:{},history:[]};visit.feeding.supplementation=visit.feeding.supplementation&&typeof visit.feeding.supplementation==='object'?visit.feeding.supplementation:{};const x=visit.feeding.supplementation;x.category=x.category||'Vaches allaitantes';x.dmIntake=x.dmIntake||'';x.productId=x.productId||'';x.dose=x.dose||'';x.doseUnit=x.doseUnit||'g/j';x.notes=x.notes||'';return x;}
function supplementProducts(){return ensureReferenceSettings().supplementProducts;}
function supplementDailyContribution(product,sup){if(!product)return {};const out={};const dose=nValue(sup.dose);if(dose===null||dose<0)return out;const isBolus=product.type==='Bolus';for(const k of ['cu','zn','mn','se','co','i']){const c=nValue(product.composition?.[k]);if(c===null)continue;if(isBolus){const days=Math.max(1,nValue(product.releaseDays)||1);out[k]=c/days;}else{let kg=0;if(sup.doseUnit==='kg/j')kg=dose;else if(sup.doseUnit==='g/j')kg=dose/1000;else kg=dose/1000;out[k]=c*kg;}}return out;}
function rationEstimatedMinerals(visit,category){const totals={dm:0,cu:0,zn:0,mn:0,se:0,co:0};for(const r of (visit.feeding?.rations||[]).filter(x=>!category||x.category===category)){const ref=feedReference(r.feedRefId);if(!ref)continue;const q=nValue(r.quantity);if(q===null)continue;let kgBrut=q;if(r.unit==='kg MS/j')kgBrut=q/(ref.ms/100);else if(r.unit==='g/j')kgBrut=q/1000;else if(r.unit!=='kg brut/j')continue;const dm=kgBrut*(ref.ms/100);totals.dm+=dm;for(const k of ['cu','zn','mn','se','co']){const v=nValue(ref[k]);if(v!==null)totals[k]+=v*dm;}}return totals;}
function mineralCoverageRows(visit){const sup=ensureSupplementation(visit),prod=supplementProducts().find(x=>x.id===sup.productId),fromSupplement=supplementDailyContribution(prod,sup),fromRation=rationEstimatedMinerals(visit,sup.category),dm=nValue(sup.dmIntake)??(fromRation.dm||null);return ['co','cu','i','mn','se','zn'].map(k=>{const target=mineralTarget(k),need=dm!==null?target*dm:null,feed=fromRation[k]||0,add=fromSupplement[k]||0,total=(k==='i'?add:feed+add),coverage=need&&need>0?total/need*100:null;return {k,label:MINERAL_LABELS[k],target,need,feed,add,total,coverage};});}

const forageTypes = ['Ensilage de maïs','Ensilage d’herbe','Enrubannage','Foin de prairie','Foin de luzerne','Herbe pâturée','Paille','Maïs grain humide','Autre'];
function nValue(v){const n=Number(String(v??'').replace(',','.'));return Number.isFinite(n)?n:null;}
function nutritionFlag(level,title,text){return `<div class="analysis-message ${level}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>`;}
function interpretForage(a){
  const out=[]; const ms=nValue(a.ms), mat=nValue(a.mat), ndf=nValue(a.ndf), starch=nValue(a.starch), sugar=nValue(a.sugar), ph=nValue(a.ph), dmo=nValue(a.dmo), ca=nValue(a.ca), p=nValue(a.p), k=nValue(a.k), na=nValue(a.na), cl=nValue(a.cl), sulfur=nValue(a.s);
  if(ms!==null){if(a.type.includes('Ensilage')&&ms<28)out.push(['warning','Matière sèche basse','Fourrage humide : surveiller les jus, l’ingestion et la qualité de fermentation.']);else if(a.type.includes('Ensilage')&&ms>40)out.push(['warning','Matière sèche élevée','Tassement et conservation potentiellement plus délicats ; vérifier échauffement et tri.']);else out.push(['good','Matière sèche renseignée',`MS : ${ms} %. À rapprocher des quantités réellement ingérées.`]);}
  if(mat!==null){if(mat<8)out.push(['danger','Protéines faibles',`MAT ${mat} % MS : apport protéique faible, à confronter aux besoins du lot.`]);else if(mat>18)out.push(['warning','Protéines élevées',`MAT ${mat} % MS : vérifier l’équilibre avec l’énergie fermentescible et l’urée.`]);else out.push(['good','Niveau protéique intermédiaire',`MAT ${mat} % MS.`]);}
  if(ndf!==null){if(ndf<30)out.push(['warning','NDF faible','Peu de fibre totale : vérifier la fibre physiquement efficace et le risque acidogène.']);else if(ndf>60)out.push(['warning','NDF élevée','Fourrage très fibreux : ingestion et digestibilité peuvent être limitées.']);else out.push(['good','Fibres présentes',`NDF ${ndf} % MS, à interpréter avec la digestibilité et la longueur des particules.`]);}
  if(starch!==null&&starch>35)out.push(['warning','Amidon élevé',`Amidon ${starch} % MS : sécuriser la transition, la fibre et la répartition des apports.`]);
  if(sugar!==null&&sugar>15)out.push(['warning','Sucres élevés',`Sucres ${sugar} % MS : tenir compte de l’ensemble de la ration fermentescible.`]);
  if(dmo!==null){if(dmo<60)out.push(['warning','Digestibilité faible',`Digestibilité ${dmo} % : la valeur énergétique et l’ingestion peuvent être pénalisées.`]);else if(dmo>=70)out.push(['good','Bonne digestibilité',`Digestibilité ${dmo} % : fourrage potentiellement bien valorisable si la conservation et l’ingestion sont bonnes.`]);}
  if(ph!==null&&a.type.includes('Ensilage')){if(ph>4.5)out.push(['warning','pH de conservation à vérifier',`pH ${ph} : à interpréter avec la matière sèche, le type d’ensilage, l’odeur et l’échauffement.`]);else out.push(['good','pH de fermentation bas',`pH ${ph}, à confirmer avec l’aspect, l’odeur et la stabilité à l’air.`]);}
  if(ca!==null&&p!==null&&p>0){const ratio=ca/p; if(ratio<1.2||ratio>3)out.push(['warning','Rapport calcium/phosphore à surveiller',`Ca/P ≈ ${ratio.toFixed(1)} sur ce fourrage seul. L’équilibre doit être calculé sur la ration complète.`]);}
  if([na,k,cl,sulfur].every(x=>x!==null)){const baca=na*43.5+k*25.6-cl*28.2-sulfur*62.5; out.push([baca>300?'warning':'good','BACA estimée du fourrage',`${Math.round(baca)} mEq/kg MS (formule indicative). ${baca>300?'Valeur élevée, vigilance particulière pour les taries.':'À intégrer au calcul de la ration complète.'}`]);}
  if(!out.length)out.push(['warning','Analyse incomplète','Renseignez au minimum la matière sèche, la MAT et les fibres pour obtenir une première lecture.']);
  return out;
}
function interpretRation(r){
  const out=[]; const dm=nValue(r.dm), ufl=nValue(r.ufl), needUfl=nValue(r.needUfl), pdi=nValue(r.pdi), needPdi=nValue(r.needPdi), mat=nValue(r.mat), ndf=nValue(r.ndf), starch=nValue(r.starch), sugar=nValue(r.sugar), ca=nValue(r.ca), phosphorus=nValue(r.p), baca=nValue(r.baca);
  if(ufl!==null&&needUfl!==null&&needUfl>0){const cov=ufl/needUfl*100;out.push([cov<90?'danger':cov>115?'warning':'good','Couverture énergétique',`${Math.round(cov)} % du besoin saisi. ${cov<90?'Déficit théorique : vérifier ingestion réelle, pertes, tri et stade physiologique.':cov>115?'Apport supérieur au besoin saisi : vérifier le risque d’engraissement ou de ration trop dense.':'Couverture théorique proche de l’objectif.'}`]);}
  if(pdi!==null&&needPdi!==null&&needPdi>0){const cov=pdi/needPdi*100;out.push([cov<90?'danger':cov>120?'warning':'good','Couverture protéique',`${Math.round(cov)} % du besoin PDI saisi. ${cov<90?'Apport potentiellement insuffisant.':cov>120?'Apport élevé : vérifier la valorisation de l’azote et l’urée.':'Couverture théorique proche de l’objectif.'}`]);}
  if(ufl!==null&&pdi!==null&&ufl>0)out.push(['good','Rapport protéines / énergie',`${Math.round(pdi/ufl)} g PDI/UFL. À comparer aux objectifs du lot et au système de rationnement utilisé.`]);
  if(mat!==null){if(mat<11)out.push(['warning','MAT de ration basse',`MAT ${mat} % MS : peut limiter les performances selon le lot.`]);else if(mat>18)out.push(['warning','MAT de ration élevée',`MAT ${mat} % MS : contrôler l’équilibre énergétique et l’urée.`]);}
  if(ndf!==null){if(ndf<28)out.push(['danger','Fibres totales faibles',`NDF ${ndf} % MS : risque de rumination insuffisante selon la fibre efficace.`]);else if(ndf>48)out.push(['warning','Fibres élevées',`NDF ${ndf} % MS : l’encombrement peut limiter l’ingestion.`]);else out.push(['good','NDF dans une zone intermédiaire',`NDF ${ndf} % MS ; vérifier aussi la longueur des particules et le tri.`]);}
  if(starch!==null&&starch>28)out.push(['warning','Amidon élevé',`Amidon ${starch} % MS : vigilance acidose, transition et répartition des repas.`]);
  if(sugar!==null&&sugar>10)out.push(['warning','Sucres élevés',`Sucres ${sugar} % MS : additionner sucres, amidon et autres glucides rapidement fermentescibles.`]);
  if(ca!==null&&phosphorus!==null&&phosphorus>0){const ratio=ca/phosphorus;out.push([ratio<1.3||ratio>2.5?'warning':'good','Rapport Ca/P',`Rapport ≈ ${ratio.toFixed(1)}. À adapter à la catégorie et au stade physiologique.`]);}
  if(baca!==null){if(r.category==='Préparation vêlage')out.push([baca>100?'warning':'good','BACA des taries',`${baca} mEq/kg MS : ${baca>100?'valeur positive, vérifier l’objectif du protocole et le pH urinaire.':'valeur abaissée ; contrôler ingestion, minéraux et pH urinaire.'}`]);else out.push(['good','BACA renseignée',`${baca} mEq/kg MS. L’objectif dépend du lot et du stade physiologique.`]);}
  if(dm!==null&&dm<=0)out.push(['danger','Ingestion invalide','La matière sèche ingérée doit être supérieure à zéro.']);
  if(!out.length)out.push(['warning','Ration incomplète','Renseignez les apports et besoins énergie/protéines ou, au minimum, MAT, NDF et amidon.']);
  return out;
}
function renderNutritionAnalysis(){
  const visit=activeVisit();
  if(!visit){app.innerHTML=`<div class="section-title"><div><h2>Analyse nutritionnelle</h2><div class="muted">Interprétation simple des analyses de fourrage et de ration.</div></div><span class="badge autosave">v14.6.21.68</span></div><section class="empty">Choisissez une visite dans l’onglet Visites.</section>`;return;}
  visit.feeding=visit.feeding&&typeof visit.feeding==='object'?visit.feeding:{rations:[],settings:{},history:[]};
  visit.feeding.nutrition=visit.feeding.nutrition&&typeof visit.feeding.nutrition==='object'?visit.feeding.nutrition:{};
  const nutrition=visit.feeding.nutrition;
  nutrition.forageAnalyses=Array.isArray(nutrition.forageAnalyses)?nutrition.forageAnalyses:[];
  nutrition.ration=nutrition.ration&&typeof nutrition.ration==='object'?nutrition.ration:{};
  const fields=(a)=>`<div class="grid cols-4 nutrition-fields">
    <div class="field"><label>Nom / lot</label><input data-forage-field="name" data-id="${a.id}" value="${escapeHtml(a.name||'')}" placeholder="Ex. silo maïs 2026"></div>
    <div class="field"><label>Type</label><select data-forage-field="type" data-id="${a.id}">${forageTypes.map(v=>`<option ${a.type===v?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>MS (%)</label><input inputmode="decimal" data-forage-field="ms" data-id="${a.id}" value="${escapeHtml(a.ms||'')}"></div>
    <div class="field"><label>MAT (% MS)</label><input inputmode="decimal" data-forage-field="mat" data-id="${a.id}" value="${escapeHtml(a.mat||'')}"></div>
    <div class="field"><label>NDF (% MS)</label><input inputmode="decimal" data-forage-field="ndf" data-id="${a.id}" value="${escapeHtml(a.ndf||'')}"></div>
    <div class="field"><label>ADF (% MS)</label><input inputmode="decimal" data-forage-field="adf" data-id="${a.id}" value="${escapeHtml(a.adf||'')}"></div>
    <div class="field"><label>Amidon (% MS)</label><input inputmode="decimal" data-forage-field="starch" data-id="${a.id}" value="${escapeHtml(a.starch||'')}"></div>
    <div class="field"><label>Sucres (% MS)</label><input inputmode="decimal" data-forage-field="sugar" data-id="${a.id}" value="${escapeHtml(a.sugar||'')}"></div>
    <div class="field"><label>Digestibilité (%)</label><input inputmode="decimal" data-forage-field="dmo" data-id="${a.id}" value="${escapeHtml(a.dmo||'')}"></div>
    <div class="field"><label>pH</label><input inputmode="decimal" data-forage-field="ph" data-id="${a.id}" value="${escapeHtml(a.ph||'')}"></div>
    <div class="field"><label>Ca (% MS)</label><input inputmode="decimal" data-forage-field="ca" data-id="${a.id}" value="${escapeHtml(a.ca||'')}"></div>
    <div class="field"><label>P (% MS)</label><input inputmode="decimal" data-forage-field="p" data-id="${a.id}" value="${escapeHtml(a.p||'')}"></div>
    <div class="field"><label>Na (% MS)</label><input inputmode="decimal" data-forage-field="na" data-id="${a.id}" value="${escapeHtml(a.na||'')}"></div>
    <div class="field"><label>K (% MS)</label><input inputmode="decimal" data-forage-field="k" data-id="${a.id}" value="${escapeHtml(a.k||'')}"></div>
    <div class="field"><label>Cl (% MS)</label><input inputmode="decimal" data-forage-field="cl" data-id="${a.id}" value="${escapeHtml(a.cl||'')}"></div>
    <div class="field"><label>S (% MS)</label><input inputmode="decimal" data-forage-field="s" data-id="${a.id}" value="${escapeHtml(a.s||'')}"></div>
  </div>`;
  const r=nutrition.ration;
  app.innerHTML=`<div class="section-title"><div><h2>Analyse nutritionnelle</h2><div class="muted">Lecture pratique des analyses de laboratoire et de la ration complète.</div></div><div class="actions"><button class="btn secondary" id="nutrition-library">📚 Fiches énergie, protéines et BACA</button><span class="badge autosave">v14.6.21.68</span></div></div>${activeVisitBanner(visit)}
  <div class="notice warning"><strong>Outil d’aide à l’interprétation.</strong> Les repères sont généraux et ne remplacent pas un calcul de ration validé selon l’espèce, la production, le stade physiologique et les unités du laboratoire.</div>
  <section class="card"><div class="section-title"><div><h3>🌾 Analyses de fourrage</h3><div class="muted">Saisissez une analyse réelle ou chargez une valeur type si l’éleveur n’a pas fait analyser le fourrage.</div></div><div class="actions"><select id="typical-feed-add"><option value="">📚 Ajouter une valeur type…</option>${Object.entries(allFeedReferences()).map(([k,v])=>`<option value="${k}">${escapeHtml(v.label)}</option>`).join('')}</select><button class="btn primary" id="add-forage-analysis">Ajouter une analyse</button></div></div>
  ${nutrition.forageAnalyses.length?nutrition.forageAnalyses.map(a=>`<article class="nutrition-analysis-card"><div class="section-title"><h4>${escapeHtml(a.name||a.type||'Analyse de fourrage')} ${a.estimated?'<span class="badge warning">📚 estimé</span>':'<span class="badge positive">🧪 analysé/saisi</span>'}</h4><button class="btn small danger" data-delete-forage="${a.id}">Supprimer</button></div>${fields(a)}<div class="analysis-interpretations">${interpretForage(a).map(x=>nutritionFlag(...x)).join('')}</div><div class="field"><label>Commentaire du technicien</label><textarea data-forage-field="comment" data-id="${a.id}">${escapeHtml(a.comment||'')}</textarea></div></article>`).join(''):'<div class="empty">Aucune analyse renseignée.</div>'}</section>
  <section class="card" style="margin-top:16px"><h3>🥣 Analyse de la ration complète</h3><div class="grid cols-4 nutrition-fields">
    <div class="field"><label>Catégorie</label><select data-ration-field="category">${feedingCategories.map(v=>`<option ${r.category===v?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>Ingestion MS (kg/j)</label><input inputmode="decimal" data-ration-field="dm" value="${escapeHtml(r.dm||'')}"></div>
    <div class="field"><label>Apport énergie (UFL/j)</label><input inputmode="decimal" data-ration-field="ufl" value="${escapeHtml(r.ufl||'')}"></div>
    <div class="field"><label>Besoin énergie (UFL/j)</label><input inputmode="decimal" data-ration-field="needUfl" value="${escapeHtml(r.needUfl||'')}"></div>
    <div class="field"><label>Apport PDI (g/j)</label><input inputmode="decimal" data-ration-field="pdi" value="${escapeHtml(r.pdi||'')}"></div>
    <div class="field"><label>Besoin PDI (g/j)</label><input inputmode="decimal" data-ration-field="needPdi" value="${escapeHtml(r.needPdi||'')}"></div>
    <div class="field"><label>MAT ration (% MS)</label><input inputmode="decimal" data-ration-field="mat" value="${escapeHtml(r.mat||'')}"></div>
    <div class="field"><label>NDF ration (% MS)</label><input inputmode="decimal" data-ration-field="ndf" value="${escapeHtml(r.ndf||'')}"></div>
    <div class="field"><label>Amidon (% MS)</label><input inputmode="decimal" data-ration-field="starch" value="${escapeHtml(r.starch||'')}"></div>
    <div class="field"><label>Sucres (% MS)</label><input inputmode="decimal" data-ration-field="sugar" value="${escapeHtml(r.sugar||'')}"></div>
    <div class="field"><label>Ca (% MS)</label><input inputmode="decimal" data-ration-field="ca" value="${escapeHtml(r.ca||'')}"></div>
    <div class="field"><label>P (% MS)</label><input inputmode="decimal" data-ration-field="p" value="${escapeHtml(r.p||'')}"></div>
    <div class="field"><label>BACA (mEq/kg MS)</label><input inputmode="decimal" data-ration-field="baca" value="${escapeHtml(r.baca||'')}"></div>
  </div><div class="analysis-interpretations">${interpretRation(r).map(x=>nutritionFlag(...x)).join('')}</div><div class="field"><label>Conclusion du technicien</label><textarea data-ration-field="comment">${escapeHtml(r.comment||'')}</textarea></div></section>`;
  document.getElementById('nutrition-library').onclick=()=>openPlanche('Nutrition');
  document.getElementById('add-forage-analysis').onclick=()=>{nutrition.forageAnalyses.push({id:uid('forage'),name:'',type:'Ensilage de maïs',source:'Analyse / saisie manuelle'});saveDatabase(db);renderNutritionAnalysis();};
  document.getElementById('typical-feed-add')?.addEventListener('change',e=>{const ref=feedReference(e.target.value);if(!ref)return;nutrition.forageAnalyses.push({id:uid('forage'),name:ref.label+' — valeur type',type:ref.label.includes('Ensilage')?ref.label:'Autre',ms:String(ref.ms??''),mat:String(ref.mat??''),ndf:String(ref.ndf??''),starch:String(ref.starch??''),sugar:String(ref.sugar??''),ca:String(ref.ca??''),p:String(ref.p??''),source:ref.source,estimated:true,comment:'Valeur type utilisée faute d’analyse propre à l’exploitation.'});saveDatabase(db);renderNutritionAnalysis();});
  app.querySelectorAll('[data-forage-field]').forEach(el=>{const save=()=>{const a=nutrition.forageAnalyses.find(x=>x.id===el.dataset.id);if(!a)return;a[el.dataset.forageField]=el.value;visit.updatedAt=new Date().toISOString();saveDatabase(db);};el.onchange=()=>{save();renderNutritionAnalysis()};el.onblur=save;});
  app.querySelectorAll('[data-delete-forage]').forEach(b=>b.onclick=()=>{if(confirm('Supprimer cette analyse de fourrage ?')){nutrition.forageAnalyses=nutrition.forageAnalyses.filter(x=>x.id!==b.dataset.deleteForage);saveDatabase(db);renderNutritionAnalysis();}});
  app.querySelectorAll('[data-ration-field]').forEach(el=>{const save=()=>{nutrition.ration[el.dataset.rationField]=el.value;visit.updatedAt=new Date().toISOString();saveDatabase(db);};el.onchange=()=>{save();renderNutritionAnalysis()};el.onblur=save;});
}


function supplementationCardHtml(visit){const sup=ensureSupplementation(visit),products=supplementProducts(),prod=products.find(x=>x.id===sup.productId),rows=mineralCoverageRows(visit);return `<section class="card" style="margin-top:16px"><div class="section-title"><div><h3>🧂 Complémentation minérale / bolus</h3><div class="muted">Calcul de l’apport journalier à partir de la composition enregistrée, puis comparaison à des repères internes modifiables.</div></div><button class="btn secondary" id="open-supp-settings">⚙️ Gérer les produits & besoins</button></div><div class="grid supplement-entry-grid"><div class="field"><label>Catégorie</label><select data-sup-field="category">${feedingCategories.map(v=>`<option ${sup.category===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Ingestion MS (kg/j)</label><input inputmode="decimal" data-sup-field="dmIntake" value="${escapeHtml(sup.dmIntake||'')}" placeholder="Laisser vide pour calcul auto"><small class="muted">Si vide, calculée à partir des aliments reliés à une valeur type.</small></div><div class="field"><label>Produit</label><select data-sup-field="productId"><option value="">Aucun produit sélectionné</option>${products.map(x=>`<option value="${x.id}" ${sup.productId===x.id?'selected':''}>${escapeHtml(x.name)}</option>`).join('')}</select></div><div class="field"><label>Dose réelle / animal</label><div class="supplement-dose-row"><input inputmode="decimal" data-sup-field="dose" value="${escapeHtml(sup.dose||'')}" placeholder="Dose"><select data-sup-field="doseUnit">${['g/j','kg/j','bolus'].map(v=>`<option ${sup.doseUnit===v?'selected':''}>${v}</option>`).join('')}</select></div></div></div>${prod?`<div class="notice"><strong>${escapeHtml(prod.name)}</strong> — ${escapeHtml(prod.type||'Complément')} · ${prod.type==='Bolus'?`libération renseignée : ${escapeHtml(prod.releaseDays||'—')} jours`:'composition exprimée en mg/kg de produit'}.</div>`:'<div class="notice warning">Enregistrez d’abord votre minéral ou bolus dans Paramètres & seuils, puis sélectionnez-le ici.</div>'}<div class="table-wrap"><table class="compact-table"><thead><tr><th>Élément</th><th>Repère ration (mg/kg MS)</th><th>Besoin estimé (mg/j)</th><th>Ration estimée</th><th>Complément</th><th>Total</th><th>Couverture</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.label)}</td><td>${r.target}</td><td>${r.need===null?'—':r.need.toFixed(1)}</td><td>${r.k==='i'?'—':r.feed.toFixed(1)}</td><td>${r.add.toFixed(1)}</td><td>${r.total.toFixed(1)}</td><td>${r.coverage===null?'—':`<span class="badge ${r.coverage<80?'danger':r.coverage<95?'warning':'positive'}">${Math.round(r.coverage)} %</span>`}</td></tr>`).join('')}</tbody></table></div><p class="muted small-text">⚠️ Calcul indicatif : les valeurs types des fourrages et les repères de besoins sont des estimations. Si la ration n’est pas analysée, le résultat doit être affiché comme « estimé ». Les antagonismes (notamment Mo/S/Fe pour le cuivre), la biodisponibilité et la consommation réelle peuvent modifier la couverture biologique.</p><div class="field"><label>Commentaire complémentation</label><textarea data-sup-field="notes">${escapeHtml(sup.notes||'')}</textarea></div></section>`;}

function renderFeeding() {
  const visit = activeVisit();
  if (visit) {
    visit.feeding = visit.feeding && typeof visit.feeding === 'object' ? visit.feeding : { rations: [], settings: {}, history: [] };
    visit.feeding.rations = Array.isArray(visit.feeding.rations) ? visit.feeding.rations : [];
    visit.feeding.settings = visit.feeding.settings && typeof visit.feeding.settings === 'object' ? visit.feeding.settings : {};
  }
  const settings = visit?.feeding?.settings || {};
  const rows = visit?.feeding?.rations || [];
  app.innerHTML = `
    <div class="section-title"><div><h2>Alimentation</h2><div class="muted">Rations par catégorie, distribution, minéralisation et transitions.</div></div><div class="actions"><button class="btn primary" id="open-nutrition-analysis">🧪 Analyser fourrage / ration</button><button class="btn secondary" data-open-library-theme="Alimentation">📑 Fiches nutrition</button><span class="badge autosave">Sauvegarde automatique</span></div></div>
    ${activeVisitBanner(visit)}
    ${!visit ? '<section class="empty">Choisissez une visite dans l’onglet Visites.</section>' : `
      <section class="card feeding-card">
        <div class="section-title"><div><h3>Tableau des rations</h3><div class="muted">Ajoutez autant d’aliments que nécessaire pour chaque catégorie.</div></div><div class="actions"><button type="button" class="btn primary" id="add-feed-row">Ajouter un aliment</button><button type="button" class="btn" id="add-feed-category">Ajouter une ration type</button></div></div>
        ${rows.length ? `<div class="table-wrap feeding-table-wrap"><table class="feeding-table"><thead><tr><th>#</th><th>Catégorie</th><th>Type d’aliment</th><th>Nature / composition</th><th>Quantité</th><th>Unité</th><th>Mode de distribution</th><th>Fréquence / horaires</th><th>Commentaire</th><th>Actions</th></tr></thead><tbody>${rows.map(feedingRowHtml).join('')}</tbody></table></div>` : '<div class="empty">Aucun aliment renseigné. Cliquez sur « Ajouter un aliment ».</div>'}
      </section>
      <section class="grid cols-2" style="margin-top:16px">
        <article class="card"><h3>Distribution et mélangeuse</h3>
          <div class="field"><label>Ordre de chargement / distribution</label><textarea data-feeding-setting="loadingOrder" placeholder="Ex. paille, foin, concentrés, minéraux, ensilage…">${escapeHtml(settings.loadingOrder || '')}</textarea></div>
          <div class="row"><div class="field"><label>Nombre de distributions / jour</label><input data-feeding-setting="distributionsPerDay" inputmode="numeric" value="${escapeHtml(settings.distributionsPerDay || '')}" /></div><div class="field"><label>Temps de mélange</label><input data-feeding-setting="mixingTime" value="${escapeHtml(settings.mixingTime || '')}" placeholder="Ex. 10 min" /></div></div>
          <div class="field"><label>Matériel / mélangeuse</label><input data-feeding-setting="equipment" value="${escapeHtml(settings.equipment || '')}" placeholder="Marque, modèle, capacité…" /></div>
          <div class="field"><label>Observations sur la distribution</label><textarea data-feeding-setting="distributionNotes">${escapeHtml(settings.distributionNotes || '')}</textarea></div>
        </article>
        <article class="card"><h3>Transitions, sel et minéralisation</h3>
          <div class="field"><label>Transition alimentaire</label><textarea data-feeding-setting="transition" placeholder="Durée, modalités, changements récents…">${escapeHtml(settings.transition || '')}</textarea></div>
          <div class="field"><label>Accès au sel</label><select data-feeding-setting="saltAccess"><option value="">Non renseigné</option>${['Permanent', 'Ponctuel', 'Absent', 'Variable selon les lots'].map(v=>`<option ${settings.saltAccess===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="field"><label>Minéralisation / compléments</label><textarea data-feeding-setting="mineralization" placeholder="Produit, quantité, fréquence, mode de distribution…">${escapeHtml(settings.mineralization || '')}</textarea></div>
          <div class="field"><label>Eau et restriction éventuelle</label><textarea data-feeding-setting="waterNotes">${escapeHtml(settings.waterNotes || '')}</textarea></div>
        </article>
      </section>
      ${supplementationCardHtml(visit)}
      <section class="card" style="margin-top:16px"><h3>Commentaire général alimentation</h3><textarea class="feeding-general-comment" data-feeding-setting="generalComment" placeholder="Synthèse de la ration, points forts, points à vérifier…">${escapeHtml(settings.generalComment || '')}</textarea></section>`}`;

  app.querySelectorAll('[data-open-library-theme]').forEach(b=>b.onclick=()=>openLibraryTheme(b.dataset.openLibraryTheme));
  document.getElementById('open-nutrition-analysis')?.addEventListener('click',()=>setView('nutrition'));
  if (!visit) return;
  document.getElementById('open-supp-settings')?.addEventListener('click',()=>setView('references'));
  app.querySelectorAll('[data-sup-field]').forEach(el=>{const save=()=>{const x=ensureSupplementation(visit);x[el.dataset.supField]=el.value;visit.updatedAt=new Date().toISOString();saveDatabase(db)};el.oninput=save;el.onchange=()=>{save();renderFeeding()};el.onblur=save;});
  const addRow = (preset = {}) => {
    visit.feeding.rations.push({ id: uid('feed'), category: preset.category || 'Vaches en production', type: preset.type || 'Ensilage', nature: '', quantity: '', unit: 'kg brut/j', distribution: 'Mélangeuse', frequency: '', comment: '', ...preset });
    visit.updatedAt = new Date().toISOString();
    saveDatabase(db); renderFeeding();
  };
  document.getElementById('add-feed-row')?.addEventListener('click', () => addRow());
  document.getElementById('add-feed-category')?.addEventListener('click', () => {
    const category = prompt('Nom de la catégorie animale :', 'Vaches en production');
    if (!category) return;
    ['Ensilage','Foin','Concentré','Minéral','Sel'].forEach(type => addRow({ category, type }));
  });
  app.querySelectorAll('[data-feeding-field]').forEach(el => {
    const save = () => {
      const row = visit.feeding.rations.find(r => r.id === el.dataset.id);
      if (!row) return;
      row[el.dataset.feedingField] = el.value;
      row.updatedAt = new Date().toISOString();
      visit.updatedAt = new Date().toISOString();
      saveDatabase(db);
    };
    el.addEventListener('input', save); el.addEventListener('change', save); el.addEventListener('blur', save);
  });
  app.querySelectorAll('[data-feeding-setting]').forEach(el => {
    const save = () => { visit.feeding.settings[el.dataset.feedingSetting] = el.value; visit.updatedAt = new Date().toISOString(); saveDatabase(db); };
    el.addEventListener('input', save); el.addEventListener('change', save); el.addEventListener('blur', save);
  });
  app.querySelectorAll('[data-delete-feed]').forEach(button => button.onclick = () => {
    if (!confirm('Supprimer cette ligne de ration ?')) return;
    visit.feeding.rations = visit.feeding.rations.filter(r => r.id !== button.dataset.deleteFeed); saveDatabase(db); renderFeeding();
  });
  app.querySelectorAll('[data-duplicate-feed]').forEach(button => button.onclick = () => {
    const source = visit.feeding.rations.find(r => r.id === button.dataset.duplicateFeed); if (!source) return;
    visit.feeding.rations.push({ ...source, id: uid('feed'), nature: source.nature || '', updatedAt: new Date().toISOString() }); saveDatabase(db); renderFeeding();
  });
}


let activeBuildingTab = localStorage.getItem('audit-bovin-building-tab') || 'structure';
let activeBuildingId = localStorage.getItem('audit-bovin-active-building') || '';
let planRuntime = null;

function ensureBuildingAudit(visit, buildingId) {
  visit.buildingAudits = visit.buildingAudits || {};
  const audit = visit.buildingAudits[buildingId] || {};
  audit.drinkers = Array.isArray(audit.drinkers) ? audit.drinkers : [];
  audit.electric = Array.isArray(audit.electric) ? audit.electric : [];
  audit.litters = Array.isArray(audit.litters) ? audit.litters : [];
  audit.ambience = audit.ambience && typeof audit.ambience === 'object' ? audit.ambience : {};
  audit.questionnaire = audit.questionnaire && typeof audit.questionnaire === 'object' ? audit.questionnaire : {};
  visit.buildingAudits[buildingId] = audit;
  return audit;
}

function currentBuildingContext() {
  const visit = activeVisit();
  if (!visit) return { visit:null, farm:null, building:null, audit:null };
  const farm = db.farms.find(f => f.id === visit.farmId);
  farm.buildings = Array.isArray(farm.buildings) ? farm.buildings : [];
  if (!activeBuildingId || !farm.buildings.some(b => b.id === activeBuildingId)) {
    activeBuildingId = farm.buildings[0]?.id || '';
    if (activeBuildingId) localStorage.setItem('audit-bovin-active-building', activeBuildingId);
  }
  const building = farm.buildings.find(b => b.id === activeBuildingId) || null;
  return { visit, farm, building, audit: building ? ensureBuildingAudit(visit, building.id) : null };
}

function buildingTabsHtml() {
  const tabs=[['structure','Structure'],['plan','Plan'],['water','Eau / abreuvoirs'],['electric','Électricité'],['litter','Litière'],['ambience','Ambiance'],['questionnaire','Questionnaire']];
  return `<div class="building-tabs">${tabs.map(([id,label])=>`<button class="building-tab ${activeBuildingTab===id?'active':''}" data-building-tab="${id}">${label}</button>`).join('')}</div>`;
}

function saveBuildingPermanent(building, field, value) {
  building[field]=value; building.updatedAt=new Date().toISOString(); saveDatabase(db);
}
function saveBuildingAudit(visit) { visit.updatedAt=new Date().toISOString(); saveDatabase(db); }

function renderBuilding() {
  const ctx=currentBuildingContext();
  const {visit,farm,building,audit}=ctx;
  app.innerHTML=`<div class="section-title"><div><h2>Bâtiment</h2><div class="muted">Données permanentes, mesures de visite et plan interactif.</div></div><div class="actions"><button class="btn secondary" data-open-library-theme="Plan bâtiment">📑 Planche</button><span class="badge autosave">Sauvegarde automatique</span></div></div>
  ${activeVisitBanner(visit)}
  ${!visit?'<section class="empty">Choisissez une visite dans l’onglet Visites.</section>':`
    <section class="card building-selector"><div class="field no-margin"><label>Bâtiment étudié</label><select id="building-select"><option value="">Sélectionner…</option>${farm.buildings.map(b=>`<option value="${b.id}" ${b.id===activeBuildingId?'selected':''}>${escapeHtml(b.name||'Bâtiment')}</option>`).join('')}</select></div><div class="actions"><button class="btn primary" id="add-building">Ajouter un bâtiment</button>${building?'<button class="btn danger" id="delete-building">Supprimer</button>':''}</div></section>
    ${!building?'<section class="empty">Ajoutez un bâtiment pour commencer.</section>':`${buildingTabsHtml()}<section id="building-panel"></section>`}
  `}`;
  app.querySelectorAll('[data-open-library-theme]').forEach(b=>b.onclick=()=>openLibraryTheme(b.dataset.openLibraryTheme));
  document.getElementById('building-select')?.addEventListener('change',e=>{activeBuildingId=e.target.value; localStorage.setItem('audit-bovin-active-building',activeBuildingId); renderBuilding();});
  document.getElementById('add-building')?.addEventListener('click',()=>{
    const name=prompt('Nom du bâtiment :','Bâtiment principal'); if(!name) return;
    const b={id:uid('building'),name,type:'Stabulation libre',orientation:'Non renseignée',ventilation:'Non renseignée',plan:{shapes:[]},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    farm.buildings.push(b); activeBuildingId=b.id; localStorage.setItem('audit-bovin-active-building',b.id); ensureBuildingAudit(visit,b.id); saveDatabase(db); renderBuilding();
  });
  document.getElementById('delete-building')?.addEventListener('click',()=>{if(!confirm('Supprimer ce bâtiment et ses données de cette visite ?'))return; farm.buildings=farm.buildings.filter(b=>b.id!==building.id); delete visit.buildingAudits[building.id]; activeBuildingId=farm.buildings[0]?.id||''; localStorage.setItem('audit-bovin-active-building',activeBuildingId); saveDatabase(db); renderBuilding();});
  app.querySelectorAll('[data-building-tab]').forEach(btn=>btn.onclick=()=>{activeBuildingTab=btn.dataset.buildingTab; localStorage.setItem('audit-bovin-building-tab',activeBuildingTab); renderBuilding();});
  if(building) renderBuildingPanel(ctx);
}

function renderBuildingPanel(ctx){
  const panel=document.getElementById('building-panel'); if(!panel)return;
  const renderers={structure:renderBuildingStructure,plan:renderBuildingPlan,water:renderBuildingWater,electric:renderBuildingElectric,litter:renderBuildingLitter,ambience:renderBuildingAmbience,questionnaire:renderBuildingQuestionnaire};
  renderers[activeBuildingTab]?.(panel,ctx);
}

function updateBuildingOutline(building){
  const lengthM=Number(building.length), widthM=Number(building.width);
  if(!(lengthM>0&&widthM>0)) return false;
  building.plan=building.plan||{shapes:[]};
  building.plan.shapes=Array.isArray(building.plan.shapes)?building.plan.shapes:[];
  const maxW=860,maxH=520,padX=70,padY=65;
  const scale=Math.min(maxW/lengthM,maxH/widthM);
  const w=Math.max(80,lengthM*scale),h=Math.max(60,widthM*scale);
  let outline=building.plan.shapes.find(x=>x.type==='building_outline');
  if(!outline){
    outline={id:'building-outline',type:'building_outline'};
    building.plan.shapes.unshift(outline);
  }
  Object.assign(outline,{x:(1000-w)/2,y:(650-h)/2,w,h,label:`${building.name||'Bâtiment'} — ${lengthM} × ${widthM} m`,lengthM,widthM,color:'#b53670',width:5,locked:true});
  building.plan.scalePxPerM=scale;
  building.updatedAt=new Date().toISOString();
  saveDatabase(db);
  return true;
}

function renderBuildingStructure(panel,{visit,building}){
  panel.innerHTML=`<section class="card"><div class="section-title"><div><h3>Fiche permanente du bâtiment</h3><div class="muted">Renseignez longueur et largeur : le contour du bâtiment est créé automatiquement sur le plan.</div></div><button class="btn primary" id="create-building-outline">Créer / actualiser le contour</button></div><div class="grid cols-3">
    <div class="field"><label>Nom</label><input data-bfield="name" value="${escapeHtml(building.name||'')}"></div>
    <div class="field"><label>Type</label><select data-bfield="type">${buildingTypes.map(v=>`<option ${building.type===v?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>Année / ancienneté</label><input data-bfield="year" value="${escapeHtml(building.year||'')}"></div>
    <div class="field"><label>Orientation</label><select data-bfield="orientation">${buildingOrientations.map(v=>`<option ${building.orientation===v?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>Ventilation</label><select data-bfield="ventilation">${ventilationTypes.map(v=>`<option ${building.ventilation===v?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>Catégories accueillies</label><input data-bfield="categories" value="${escapeHtml(building.categories||'')}" placeholder="Veaux, génisses, vaches…"></div>
    <div class="field"><label>Longueur du bâtiment (m)</label><input type="number" step="0.1" min="0" data-bfield="length" value="${escapeHtml(building.length||'')}"></div>
    <div class="field"><label>Largeur du bâtiment (m)</label><input type="number" step="0.1" min="0" data-bfield="width" value="${escapeHtml(building.width||'')}"></div>
    <div class="field"><label>Hauteur / volume</label><input data-bfield="height" value="${escapeHtml(building.height||'')}"></div>
    <div class="field"><label>Sol</label><input data-bfield="floor" value="${escapeHtml(building.floor||'')}"></div>
    <div class="field"><label>Toiture</label><input data-bfield="roof" value="${escapeHtml(building.roof||'')}"></div>
    <div class="field"><label>Bardage / ouvertures</label><input data-bfield="cladding" value="${escapeHtml(building.cladding||'')}"></div>
    <div class="field field-wide"><label>Observations permanentes</label><textarea data-bfield="notes">${escapeHtml(building.notes||'')}</textarea></div>
  </div><div class="info-box small-text">Le rectangle est mis à l’échelle pour tenir dans le plan. Vous pourrez ensuite ajouter les cloisons, zones et équipements à l’intérieur.</div></section>`;
  panel.querySelectorAll('[data-bfield]').forEach(el=>{
    const save=()=>{saveBuildingPermanent(building,el.dataset.bfield,el.value);if(['length','width','name'].includes(el.dataset.bfield))updateBuildingOutline(building)};
    el.addEventListener('input',save);el.addEventListener('change',save);el.addEventListener('blur',save);
  });
  document.getElementById('create-building-outline')?.addEventListener('click',()=>{
    if(updateBuildingOutline(building)){toast('Contour du bâtiment créé / actualisé.');activeBuildingTab='plan';localStorage.setItem('audit-bovin-building-tab','plan');renderBuilding();}
    else toast('Renseignez une longueur et une largeur supérieures à 0.');
  });
}

function planToolButton(tool,icon,label,title=''){return `<button class="plan-tool" data-tool="${tool}" title="${escapeHtml(title||label)}"><span class="plan-tool-icon">${icon}</span><span>${label}</span></button>`}
function planToolGroup(title,buttons){return `<details class="plan-toolbox-group"><summary><span>${title}</span><span class="plan-group-chevron">⌄</span></summary><div class="plan-toolbox-grid">${buttons.join('')}</div></details>`}
function planCanvasHtml(){return `<section class="card plan-card"><div class="section-title plan-title"><div><h3>Plan interactif</h3><div class="muted">Les familles d’outils sont repliées par défaut. Ouvrez uniquement celle dont vous avez besoin.</div></div><span class="badge autosave">Auto</span></div>
  <div class="plan-designer-grid">
    <aside class="plan-toolbox" aria-label="Outils du plan">
      ${planToolGroup('Dessin',[`<button class="plan-tool active" data-tool="select"><span class="plan-tool-icon">↖</span><span>Sélection</span></button>`,planToolButton('free','✏️','Libre'),planToolButton('line','📏','Trait droit'),planToolButton('rect','▭','Rectangle'),planToolButton('text','T','Texte')])}
      ${planToolGroup('Structure',[planToolButton('porte','🚪','Porte'),planToolButton('fenetre','▣','Fenêtre'),planToolButton('barriere','━','Barrière'),planToolButton('passage_homme','🚶','Passage homme')])}
      ${planToolGroup('Alimentation',[planToolButton('cornadis','▥','Cornadis'),planToolButton('barre_garrot','▔','Barre garrot'),planToolButton('attaches','⛓️','Attaches'),planToolButton('mangeoire','🥣','Mangeoire')])}
      ${planToolGroup('Eau / ambiance',[planToolButton('water','💧','Abreuvoir'),planToolButton('ventilateur','🌀','Ventilateur'),planToolButton('electric','⚡','Point électrique')])}
      ${planToolGroup('Zones',[planToolButton('zone_litter','🛏️','Aire paillée'),planToolButton('zone_feed','🌾','Couloir alim.'),planToolButton('zone_exercise','🐄','Aire exercice'),planToolButton('logette','▱','Logette'),planToolButton('litter','🟫','Litière mesurée'),planToolButton('zone_custom','🏷️','Zone libre')])}
      <details class="plan-toolbox-group plan-toolbox-settings"><summary><span>Réglages</span><span class="plan-group-chevron">⌄</span></summary><div class="plan-toolbox-settings-body"><label class="plan-width compact">Épaisseur <select id="plan-width"><option value="2">Fine</option><option value="4" selected>Moyenne</option><option value="7">Épaisse</option></select></label><div class="plan-history-actions"><button class="btn small" id="plan-fit" title="Afficher tout le bâtiment">⛶ Ajuster</button><button class="btn small" id="plan-undo" title="Annuler">↩ Annuler</button><button class="btn small" id="plan-redo" title="Rétablir">↪ Rétablir</button><button class="btn small danger" id="plan-delete-selected" title="Supprimer la sélection">🗑 Sélection</button><button class="btn small danger" id="plan-clear" title="Effacer tout sauf le contour">Effacer le contenu</button></div></div></details>
    </aside>
    <div class="plan-canvas-column"><div class="plan-canvas-wrap"><canvas id="building-canvas" width="1000" height="650"></canvas></div><div class="muted small-text">Le contour vert correspond aux dimensions renseignées dans la fiche Structure. Les objets linéaires et les zones se dessinent par glisser-déposer.</div></div>
    <aside id="plan-inspector" class="plan-inspector collapsed"><h4>Objet sélectionné</h4><p class="muted">Cliquez sur un objet pour afficher ses propriétés.</p></aside>
  </div></section>`;}

function renderBuildingPlan(panel,{building,audit,visit}){
  if(!building.plan?.shapes?.some(s=>s.type==='building_outline')) updateBuildingOutline(building);
  panel.innerHTML=planCanvasHtml(); initPlanCanvas(building,audit,visit);
}

function initPlanCanvas(building,audit,visit){
  const canvas=document.getElementById('building-canvas'); if(!canvas)return; const ctx=canvas.getContext('2d');
  building.plan=building.plan||{shapes:[]}; building.plan.shapes=Array.isArray(building.plan.shapes)?building.plan.shapes:[];
  let tool='select',drawing=false,start=null,temp=null,redo=[],selectedId='',dragOffset=null; const history=building.plan.shapes;
  const point=e=>{const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}};
  const objectMeta={
    cornadis:{label:'Cornadis',icon:'C',color:'#475569',kind:'linear'},barriere:{label:'Barrière',icon:'B',color:'#6b7280',kind:'linear'},barre_garrot:{label:'Barre au garrot',icon:'BG',color:'#9a3412',kind:'linear'},attaches:{label:'Attaches individuelles',icon:'AI',color:'#7e22ce',kind:'linear'},passage_homme:{label:'Passage d’homme',icon:'PH',color:'#7c3aed',kind:'linear'},
    mangeoire:{label:'Mangeoire',icon:'M',color:'#ca8a04',kind:'point'},logette:{label:'Logette',icon:'L',color:'#8b5cf6',kind:'point'},ventilateur:{label:'Ventilateur',icon:'V',color:'#0f766e',kind:'point'},porte:{label:'Porte',icon:'P',color:'#92400e',kind:'point'},fenetre:{label:'Fenêtre',icon:'F',color:'#38bdf8',kind:'point'},
    zone_litter:{label:'Aire paillée',color:'#d6a85f',kind:'zone'},zone_feed:{label:'Couloir alimentation',color:'#d4b44c',kind:'zone'},zone_exercise:{label:'Aire d’exercice',color:'#6ba88a',kind:'zone'},zone_custom:{label:'Zone personnalisée',color:'#94a3b8',kind:'zone'},
    water:{label:'Abreuvoir',icon:'A',color:'#0ea5e9',kind:'point'},electric:{label:'Électricité',icon:'E',color:'#eab308',kind:'point'},litter:{label:'Litière',icon:'Li',color:'#a16207',kind:'zone'}
  };
  const color=t=>({free:'#1f2937',line:'#1f2937',rect:'#b53670',text:'#1f2937',...Object.fromEntries(Object.entries(objectMeta).map(([k,v])=>[k,v.color]))}[t]||'#1f2937');
  const meta=s=>objectMeta[s.type]; const isLinear=s=>meta(s)?.kind==='linear'; const isZone=s=>meta(s)?.kind==='zone'; const isPoint=s=>meta(s)?.kind==='point'; const isObject=s=>!!meta(s);
  const drawShape=s=>{ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle=s.color||color(s.type);ctx.fillStyle=s.color||color(s.type);ctx.lineWidth=s.width||4;
    if(s.type==='building_outline'){ctx.strokeStyle=s.color||'#b53670';ctx.lineWidth=s.width||5;ctx.setLineDash([12,6]);ctx.strokeRect(s.x,s.y,s.w,s.h);ctx.setLineDash([]);ctx.fillStyle='#b53670';ctx.font='bold 15px sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom';ctx.fillText(s.label||'Contour du bâtiment',s.x,s.y-8);ctx.restore();return;}
    if(s.type==='free'){ctx.beginPath();s.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();}
    if(s.type==='line'||isLinear(s)){ctx.beginPath();ctx.moveTo(s.x1,s.y1);ctx.lineTo(s.x2,s.y2);ctx.stroke();if(isLinear(s)){const mx=(s.x1+s.x2)/2,my=(s.y1+s.y2)/2;ctx.fillStyle='#fff';ctx.strokeStyle=s.color||color(s.type);ctx.lineWidth=1;ctx.font='bold 11px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';const label=s.label||meta(s).label;const tw=ctx.measureText(label).width+10;ctx.fillRect(mx-tw/2,my-10,tw,20);ctx.strokeRect(mx-tw/2,my-10,tw,20);ctx.fillStyle=s.color||color(s.type);ctx.fillText(label,mx,my);}}
    if(s.type==='rect'){ctx.strokeRect(s.x,s.y,s.w,s.h);}
    if(isZone(s)){ctx.globalAlpha=.22;ctx.fillRect(s.x,s.y,s.w,s.h);ctx.globalAlpha=1;ctx.strokeRect(s.x,s.y,s.w,s.h);ctx.fillStyle='#1f2937';ctx.font='bold 13px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText((s.label||meta(s).label).slice(0,28),s.x+s.w/2,s.y+s.h/2);}
    if(isPoint(s)){const w=s.w||54,h=s.h||38;ctx.globalAlpha=.92;ctx.fillRect(s.x-w/2,s.y-h/2,w,h);ctx.globalAlpha=1;ctx.fillStyle='#fff';ctx.font='bold 15px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(meta(s).icon,s.x,s.y-3);ctx.font='10px sans-serif';ctx.fillText((s.label||meta(s).label).slice(0,12),s.x,s.y+12);}
    if(s.type==='text'){ctx.font='18px sans-serif';ctx.fillText(s.text||'',s.x,s.y);}
    if(s.id===selectedId){ctx.save();ctx.strokeStyle='#dc2626';ctx.lineWidth=3;ctx.setLineDash([7,5]);if(isPoint(s)){const w=s.w||54,h=s.h||38;ctx.strokeRect(s.x-w/2-5,s.y-h/2-5,w+10,h+10)}else if(isZone(s)||s.type==='rect')ctx.strokeRect(s.x-4,s.y-4,s.w+8,s.h+8);else if(isLinear(s)||s.type==='line'){ctx.beginPath();ctx.moveTo(s.x1,s.y1);ctx.lineTo(s.x2,s.y2);ctx.stroke()}ctx.restore();}
    ctx.restore();};
  const renderCanvas=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#edf2ef';ctx.lineWidth=1;for(let x=0;x<canvas.width;x+=25){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke()}for(let y=0;y<canvas.height;y+=25){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke()}history.forEach(drawShape);if(temp)drawShape(temp)};
  const persist=()=>{building.updatedAt=new Date().toISOString();saveDatabase(db);renderInspector();renderCanvas()};
  const commit=s=>{if(!s)return;s.id=s.id||uid('shape');history.push(s);redo=[];temp=null;selectedId=s.id;persist();};
  const distanceToSegment=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(!l2)return Math.hypot(p.x-a.x,p.y-a.y);let t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;t=Math.max(0,Math.min(1,t));return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy))};
  const hit=p=>[...history].reverse().find(s=>{if(s.type==='building_outline')return false;if(isPoint(s))return Math.abs(p.x-s.x)<(s.w||54)/2+8&&Math.abs(p.y-s.y)<(s.h||38)/2+8;if(isZone(s)||s.type==='rect')return p.x>=s.x-7&&p.x<=s.x+s.w+7&&p.y>=s.y-7&&p.y<=s.y+s.h+7;if(isLinear(s)||s.type==='line')return distanceToSegment(p,{x:s.x1,y:s.y1},{x:s.x2,y:s.y2})<12;if(s.type==='text')return Math.abs(p.x-s.x)<80&&Math.abs(p.y-s.y)<24;return false});
  const linkedRow=s=>s.linkKind==='drinker'?audit.drinkers.find(r=>r.id===s.linkId):s.linkKind==='electric'?audit.electric.find(r=>r.id===s.linkId):s.linkKind==='litter'?audit.litters.find(r=>r.id===s.linkId):null;
  const setLinearLength=(s,newLength)=>{const dx=s.x2-s.x1,dy=s.y2-s.y1,old=Math.hypot(dx,dy)||1;const ux=dx/old,uy=dy/old;s.x2=s.x1+ux*newLength;s.y2=s.y1+uy*newLength};
  const renderInspector=()=>{const box=document.getElementById('plan-inspector');if(!box)return;const s=history.find(x=>x.id===selectedId);if(!s){box.classList.add('collapsed');box.innerHTML='<h4>Objet sélectionné</h4><p class="muted">Cliquez sur un objet pour afficher ses propriétés.</p>';return}box.classList.remove('collapsed');const row=linkedRow(s);const m=meta(s);const isLin=isLinear(s),isZn=isZone(s),isPt=isPoint(s);const length=isLin?Math.round(Math.hypot(s.x2-s.x1,s.y2-s.y1)):0;box.innerHTML=`<h4>${escapeHtml(s.label||m?.label||s.type)}</h4><div class="field"><label>Libellé / nom de zone</label><input id="shape-label" value="${escapeHtml(s.label||'')}"></div><div class="muted small-text">Type : ${escapeHtml(m?.label||s.type)}</div>${s.type==='cornadis'?`<div class="field"><label>Nombre de places</label><input id="shape-places" type="number" min="0" step="1" value="${escapeHtml(s.places??'')}"></div><div class="field"><label>Type de cornadis</label><select id="shape-cornadis-type">${['Autobloquant','Simple','Tubulaire','Autre'].map(v=>`<option ${s.cornadisType===v?'selected':''}>${v}</option>`).join('')}</select></div>`:''}${s.type==='barre_garrot'?`<div class="field"><label>Hauteur (cm)</label><input id="shape-garrot-height" type="number" min="0" step="1" value="${escapeHtml(s.heightCm??'')}"></div>`:''}${s.type==='attaches'?`<div class="field"><label>Nombre d’attaches</label><input id="shape-places" type="number" min="0" step="1" value="${escapeHtml(s.places??'')}"></div><div class="field"><label>Type d’attache</label><select id="shape-attach-type">${['Chaîne','Collier','Licol','Câble','Autre'].map(v=>`<option ${s.attachType===v?'selected':''}>${v}</option>`).join('')}</select></div>`:''}${isLin?`<div class="field"><label>Longueur sur le plan</label><input id="shape-length" type="number" min="20" max="950" value="${length}"></div><div class="actions compact"><button class="btn small" id="linear-horizontal">Horizontal</button><button class="btn small" id="linear-vertical">Vertical</button></div>`:''}${isZn||isPt?`<div class="grid cols-2"><div class="field"><label>Largeur</label><input id="shape-w" type="number" min="20" max="950" value="${Math.round(s.w||(isPt?54:150))}"></div><div class="field"><label>Hauteur</label><input id="shape-h" type="number" min="20" max="550" value="${Math.round(s.h||(isPt?38:100))}"></div></div>`:''}${isZn?`<div class="field"><label>Correspondance / usage de la zone</label><select id="shape-zone-type">${['Aire paillée','Couloir d’alimentation','Aire d’exercice','Logettes','Case veaux','Zone de stockage','Aire d’attente','Parc d’isolement','Autre'].map(v=>`<option ${s.zoneType===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Commentaire de zone</label><textarea id="shape-zone-comment">${escapeHtml(s.comment||'')}</textarea></div>`:''}${row?`<div class="plan-linked-summary">${s.linkKind==='drinker'?`Type : ${escapeHtml(row.type||'')}<br>Matériau : ${escapeHtml(row.material||'')}<br>Débit : ${escapeHtml(row.flow||'—')} L/min`:s.linkKind==='electric'?`Valeur : ${escapeHtml(row.value||'—')} ${escapeHtml(row.unit||'')}`:`Zone : ${escapeHtml(row.zone||'')}<br>pH : ${escapeHtml(row.ph||'—')}`}</div><button class="btn primary" id="open-linked-row">Ouvrir la fiche liée</button>`:'<p class="muted">Objet permanent du plan.</p>'}<button class="btn danger" id="delete-shape-inspector">Supprimer cet objet</button>`;
    document.getElementById('shape-label')?.addEventListener('input',e=>{s.label=e.target.value;if(row){if(s.linkKind==='drinker')row.name=e.target.value;if(s.linkKind==='electric')row.equipment=e.target.value;if(s.linkKind==='litter')row.zone=e.target.value;saveBuildingAudit(visit)}persist()});
    document.getElementById('shape-length')?.addEventListener('change',e=>{setLinearLength(s,Math.max(20,Number(e.target.value)||20));persist()});
    document.getElementById('linear-horizontal')?.addEventListener('click',()=>{const len=Math.hypot(s.x2-s.x1,s.y2-s.y1)||120;s.x2=s.x1+len;s.y2=s.y1;persist()});
    document.getElementById('linear-vertical')?.addEventListener('click',()=>{const len=Math.hypot(s.x2-s.x1,s.y2-s.y1)||120;s.x2=s.x1;s.y2=s.y1+len;persist()});
    document.getElementById('shape-w')?.addEventListener('change',e=>{s.w=Math.max(20,Number(e.target.value)||20);persist()});document.getElementById('shape-h')?.addEventListener('change',e=>{s.h=Math.max(20,Number(e.target.value)||20);persist()});
    document.getElementById('shape-zone-type')?.addEventListener('change',e=>{s.zoneType=e.target.value;persist()});document.getElementById('shape-zone-comment')?.addEventListener('input',e=>{s.comment=e.target.value;persist()});
    document.getElementById('shape-places')?.addEventListener('change',e=>{s.places=Math.max(0,Number(e.target.value)||0);persist()});document.getElementById('shape-cornadis-type')?.addEventListener('change',e=>{s.cornadisType=e.target.value;persist()});document.getElementById('shape-garrot-height')?.addEventListener('change',e=>{s.heightCm=Math.max(0,Number(e.target.value)||0);persist()});document.getElementById('shape-attach-type')?.addEventListener('change',e=>{s.attachType=e.target.value;persist()});
    document.getElementById('delete-shape-inspector').onclick=()=>{const i=history.findIndex(x=>x.id===s.id);if(i>=0)history.splice(i,1);selectedId='';persist()};
    document.getElementById('open-linked-row')?.addEventListener('click',()=>{activeBuildingTab=s.linkKind==='drinker'?'water':s.linkKind==='electric'?'electric':'litter';localStorage.setItem('audit-bovin-building-tab',activeBuildingTab);renderBuilding();setTimeout(()=>document.querySelector(`[data-id="${s.linkId}"]`)?.scrollIntoView({behavior:'smooth',block:'center'}),100)});};
  const createLinkedObject=(type,p)=>{let row,label;if(type==='water'){const n=audit.drinkers.length+1;row={id:uid('drinker'),name:`Abreuvoir ${n}`,type:'Bac collectif',material:'Inox',origin:'Réseau'};audit.drinkers.push(row);label=row.name;saveBuildingAudit(visit);commit({type,x:p.x,y:p.y,label,linkKind:'drinker',linkId:row.id,w:60,h:40});}else if(type==='electric'){const n=audit.electric.length+1;row={id:uid('electric'),equipment:`Point électrique ${n}`,unit:'mV',current:'AC'};audit.electric.push(row);label=row.equipment;saveBuildingAudit(visit);commit({type,x:p.x,y:p.y,label,linkKind:'electric',linkId:row.id,w:58,h:40});}};
  const createLinkedLitterZone=(rect)=>{const n=audit.litters.length+1;const row={id:uid('litter'),zone:`Zone litière ${n}`,type:'Paille',quantityUnit:'kg/j'};audit.litters.push(row);saveBuildingAudit(visit);commit({...rect,type:'litter',label:row.zone,zoneType:'Aire paillée',linkKind:'litter',linkId:row.id});};
  document.querySelectorAll('.plan-tool').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('.plan-tool').forEach(b=>b.classList.remove('active'));btn.classList.add('active');tool=btn.dataset.tool;document.querySelectorAll('.plan-more[open]').forEach(d=>d.removeAttribute('open'));if(window.matchMedia('(max-width:760px)').matches){const group=btn.closest('details.plan-toolbox-group');if(group)group.removeAttribute('open');document.querySelector('.plan-canvas-wrap')?.scrollIntoView({behavior:'smooth',block:'start'});}});
  document.getElementById('plan-fit')?.addEventListener('click',()=>{document.querySelector('.plan-canvas-wrap')?.scrollIntoView({behavior:'smooth',block:'center'});renderCanvas();});
  canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);const p=point(e);const width=Number(document.getElementById('plan-width')?.value||4);if(tool==='select'){const s=hit(p);selectedId=s?.id||'';if(s){if(isPoint(s))dragOffset={kind:'point',x:p.x-s.x,y:p.y-s.y};else if(isZone(s)||s.type==='rect')dragOffset={kind:'zone',x:p.x-s.x,y:p.y-s.y};else if(isLinear(s)||s.type==='line')dragOffset={kind:'linear',x:p.x-s.x1,y:p.y-s.y1,x2:s.x2-s.x1,y2:s.y2-s.y1};drawing=true}else dragOffset=null;renderInspector();renderCanvas();return}if(['water','electric'].includes(tool)){createLinkedObject(tool,p);return}if(isPoint({type:tool})){commit({type:tool,x:p.x,y:p.y,label:meta({type:tool}).label,w:54,h:38});return}if(tool==='text'){const text=prompt('Texte à ajouter :');if(text)commit({type:'text',x:p.x,y:p.y,text});return}drawing=true;start=p;if(tool==='free')temp={type:'free',points:[p],width,color:color(tool)};});
  canvas.addEventListener('pointermove',e=>{if(!drawing)return;const p=point(e);if(tool==='select'){const s=history.find(x=>x.id===selectedId);if(s&&dragOffset){if(dragOffset.kind==='point'){s.x=p.x-dragOffset.x;s.y=p.y-dragOffset.y}else if(dragOffset.kind==='zone'){s.x=p.x-dragOffset.x;s.y=p.y-dragOffset.y}else if(dragOffset.kind==='linear'){s.x1=p.x-dragOffset.x;s.y1=p.y-dragOffset.y;s.x2=s.x1+dragOffset.x2;s.y2=s.y1+dragOffset.y2}renderCanvas()}return}const width=Number(document.getElementById('plan-width')?.value||4);if(tool==='free')temp.points.push(p);if(tool==='line'||['cornadis','barriere','barre_garrot','attaches','passage_homme'].includes(tool))temp={type:tool,x1:start.x,y1:start.y,x2:p.x,y2:p.y,width,color:color(tool),label:meta({type:tool})?.label};if(tool==='rect'||['zone_litter','zone_feed','zone_exercise','zone_custom','litter'].includes(tool))temp={type:tool,x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y),width,color:color(tool),label:meta({type:tool})?.label,zoneType:meta({type:tool})?.label};renderCanvas();});
  const finish=()=>{if(!drawing)return;drawing=false;if(tool==='select'){persist();return}if(temp&&(tool==='free'?temp.points.length>1:(isLinear(temp)||temp.type==='line'?Math.hypot(temp.x2-temp.x1,temp.y2-temp.y1)>8:(isZone(temp)||temp.type==='rect'?temp.w>8&&temp.h>8:true)))){if(tool==='litter')createLinkedLitterZone(temp);else commit(temp)}else{temp=null;renderCanvas()}};canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',finish);
  document.getElementById('plan-undo').onclick=()=>{const s=history.pop();if(s)redo.push(s);selectedId='';persist()};document.getElementById('plan-redo').onclick=()=>{const s=redo.pop();if(s)history.push(s);persist()};document.getElementById('plan-delete-selected').onclick=()=>{if(!selectedId)return;const i=history.findIndex(x=>x.id===selectedId);if(i>=0)history.splice(i,1);selectedId='';persist()};document.getElementById('plan-clear').onclick=()=>{if(confirm('Effacer tous les objets ajoutés en conservant le contour du bâtiment ?')){const kept=history.filter(s=>s.type==='building_outline');const removed=history.filter(s=>s.type!=='building_outline');redo.push(...removed);history.splice(0,history.length,...kept);selectedId='';persist()}};
  renderCanvas();renderInspector();planRuntime={renderCanvas};
}

function rowInput(value,attrs=''){return `<input ${attrs} value="${escapeHtml(value??'')}">`}
function renderBuildingWater(panel,{visit,audit}){
  panel.innerHTML=`<section class="card"><div class="section-title"><div><h3>Eau et abreuvoirs</h3><div class="muted">Une ligne par point d’eau. Les éléments posés sur le plan apparaissent automatiquement ici.</div></div><button class="btn primary" id="add-drinker">Ajouter un abreuvoir</button></div>${audit.drinkers.length?`<div class="table-wrap"><table class="building-table"><thead><tr><th>Nom</th><th>Type</th><th>Matériau</th><th>Catégorie</th><th>Origine</th><th>Position</th><th>Animaux desservis</th><th>Débit L/min</th><th>Hauteur cm</th><th>Volume L</th><th>Temp. °C</th><th>pH</th><th>Redox</th><th>Conductivité</th><th>Nitrates</th><th>Accessibilité</th><th>Concurrence</th><th>Antigel</th><th>État / fuites</th><th>Nettoyage</th><th>Commentaire</th><th></th></tr></thead><tbody>${audit.drinkers.map(r=>`<tr><td>${rowInput(r.name,`data-drinker-field="name" data-id="${r.id}"`)}</td><td><select data-drinker-field="type" data-id="${r.id}">${drinkerTypes.map(v=>`<option ${r.type===v?'selected':''}>${v}</option>`).join('')}</select></td><td><select data-drinker-field="material" data-id="${r.id}">${drinkerMaterials.map(v=>`<option ${r.material===v?'selected':''}>${v}</option>`).join('')}</select></td><td>${rowInput(r.category,`data-drinker-field="category" data-id="${r.id}"`)}</td><td><select data-drinker-field="origin" data-id="${r.id}">${waterOrigins.map(v=>`<option ${r.origin===v?'selected':''}>${v}</option>`).join('')}</select></td><td>${rowInput(r.position,`data-drinker-field="position" data-id="${r.id}"`)}</td><td>${rowInput(r.animalsServed,`type="number" step="1" data-drinker-field="animalsServed" data-id="${r.id}"`)}</td>${['flow','height','volume','temperature','ph','redox','conductivity','nitrates'].map(f=>`<td>${rowInput(r[f],`type="number" step="any" inputmode="decimal" data-drinker-field="${f}" data-id="${r.id}"`)}</td>`).join('')}<td><select data-drinker-field="accessibility" data-id="${r.id}">${['','Bonne','Moyenne','Insuffisante'].map(v=>`<option ${r.accessibility===v?'selected':''}>${v||'Non renseignée'}</option>`).join('')}</select></td><td><select data-drinker-field="competition" data-id="${r.id}">${['','Non','Oui','Non observée'].map(v=>`<option ${r.competition===v?'selected':''}>${v||'Non renseignée'}</option>`).join('')}</select></td><td><select data-drinker-field="antifreeze" data-id="${r.id}">${['','Oui','Non','Non concerné'].map(v=>`<option ${r.antifreeze===v?'selected':''}>${v||'Non renseigné'}</option>`).join('')}</select></td><td>${rowInput(r.condition,`data-drinker-field="condition" data-id="${r.id}"`)}</td><td>${rowInput(r.cleaning,`data-drinker-field="cleaning" data-id="${r.id}"`)}</td><td><textarea data-drinker-field="comment" data-id="${r.id}">${escapeHtml(r.comment||'')}</textarea></td><td><button class="btn small danger" data-delete-drinker="${r.id}">Suppr.</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aucun abreuvoir renseigné.</div>'}</section>`;
  document.getElementById('add-drinker').onclick=()=>{audit.drinkers.push({id:uid('drinker'),name:`Abreuvoir ${audit.drinkers.length+1}`,type:'Bac collectif',material:'Inox',origin:'Réseau'});saveBuildingAudit(visit);renderBuildingWater(panel,currentBuildingContext())};
  panel.querySelectorAll('[data-drinker-field]').forEach(el=>{const save=()=>{const r=audit.drinkers.find(x=>x.id===el.dataset.id);if(r){r[el.dataset.drinkerField]=el.value;const ctx=currentBuildingContext();const shape=ctx.building?.plan?.shapes?.find(s=>s.linkKind==='drinker'&&s.linkId===r.id);if(shape&&el.dataset.drinkerField==='name')shape.label=el.value;saveBuildingAudit(visit);if(shape)saveDatabase(db)}};el.addEventListener('input',save);el.addEventListener('change',save);el.addEventListener('blur',save)});panel.querySelectorAll('[data-delete-drinker]').forEach(b=>b.onclick=()=>{audit.drinkers=audit.drinkers.filter(x=>x.id!==b.dataset.deleteDrinker);const ctx=currentBuildingContext();if(ctx.building?.plan?.shapes)ctx.building.plan.shapes=ctx.building.plan.shapes.filter(s=>!(s.linkKind==='drinker'&&s.linkId===b.dataset.deleteDrinker));saveBuildingAudit(visit);renderBuildingWater(panel,currentBuildingContext())});
}

function renderBuildingElectric(panel,{visit,audit}){
  panel.innerHTML=`<section class="card"><div class="section-title"><div><h3>Mesures électriques</h3><div class="muted">Abreuvoirs, barrières, cornadis, auges, logettes…</div></div><button class="btn primary" id="add-electric">Ajouter une mesure</button></div>${audit.electric.length?`<div class="table-wrap"><table class="building-table"><thead><tr><th>Équipement</th><th>Localisation</th><th>Valeur</th><th>Unité</th><th>AC / DC</th><th>Conditions</th><th>Correction</th><th>Valeur après</th><th>Commentaire</th><th></th></tr></thead><tbody>${audit.electric.map(r=>`<tr><td>${rowInput(r.equipment,`data-electric-field="equipment" data-id="${r.id}"`)}</td><td>${rowInput(r.location,`data-electric-field="location" data-id="${r.id}"`)}</td><td>${rowInput(r.value,`type="number" step="any" inputmode="decimal" data-electric-field="value" data-id="${r.id}"`)}</td><td><select data-electric-field="unit" data-id="${r.id}">${['mV','V','µA','mA'].map(v=>`<option ${r.unit===v?'selected':''}>${v}</option>`).join('')}</select></td><td><select data-electric-field="current" data-id="${r.id}">${['AC','DC','Non précisé'].map(v=>`<option ${r.current===v?'selected':''}>${v}</option>`).join('')}</select></td><td>${rowInput(r.conditions,`data-electric-field="conditions" data-id="${r.id}"`)}</td><td>${rowInput(r.correction,`data-electric-field="correction" data-id="${r.id}"`)}</td><td>${rowInput(r.after,`type="number" step="any" data-electric-field="after" data-id="${r.id}"`)}</td><td><textarea data-electric-field="comment" data-id="${r.id}">${escapeHtml(r.comment||'')}</textarea></td><td><button class="btn small danger" data-delete-electric="${r.id}">Suppr.</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aucune mesure électrique.</div>'}</section>`;
  document.getElementById('add-electric').onclick=()=>{audit.electric.push({id:uid('electric'),equipment:'Abreuvoir',unit:'mV',current:'AC'});saveBuildingAudit(visit);renderBuildingElectric(panel,currentBuildingContext())};
  panel.querySelectorAll('[data-electric-field]').forEach(el=>{const save=()=>{const r=audit.electric.find(x=>x.id===el.dataset.id);if(r){r[el.dataset.electricField]=el.value;saveBuildingAudit(visit)}};el.addEventListener('input',save);el.addEventListener('change',save);el.addEventListener('blur',save)});panel.querySelectorAll('[data-delete-electric]').forEach(b=>b.onclick=()=>{audit.electric=audit.electric.filter(x=>x.id!==b.dataset.deleteElectric);saveBuildingAudit(visit);renderBuildingElectric(panel,currentBuildingContext())});
}

function renderBuildingLitter(panel,{visit,audit}){
  panel.innerHTML=`<section class="card"><div class="section-title"><div><h3>Litière et paillage</h3><div class="muted">Une ligne par zone ou lot.</div></div><button class="btn primary" id="add-litter">Ajouter une zone</button></div>${audit.litters.length?`<div class="table-wrap"><table class="building-table"><thead><tr><th>Zone / lot</th><th>Type</th><th>pH</th><th>Redox</th><th>Temp. °C</th><th>Humidité %</th><th>Épaisseur cm</th><th>Fréquence paillage</th><th>Quantité</th><th>Unité</th><th>Curage</th><th>Nettoyage</th><th>Désinfection</th><th>Taux vibratoire</th><th>Failles</th><th>Commentaire</th><th></th></tr></thead><tbody>${audit.litters.map(r=>`<tr><td>${rowInput(r.zone,`data-litter-field="zone" data-id="${r.id}"`)}</td><td><select data-litter-field="type" data-id="${r.id}">${litterTypes.map(v=>`<option ${r.type===v?'selected':''}>${v}</option>`).join('')}</select></td>${['ph','redox','temperature','humidity','thickness'].map(f=>`<td>${rowInput(r[f],`type="number" step="any" inputmode="decimal" data-litter-field="${f}" data-id="${r.id}"`)}</td>`).join('')}<td>${rowInput(r.beddingFrequency,`data-litter-field="beddingFrequency" data-id="${r.id}"`)}</td><td>${rowInput(r.quantity,`type="number" step="any" data-litter-field="quantity" data-id="${r.id}"`)}</td><td><select data-litter-field="quantityUnit" data-id="${r.id}">${['kg/j','kg/semaine','bottes/j','bottes/semaine','Autre'].map(v=>`<option ${r.quantityUnit===v?'selected':''}>${v}</option>`).join('')}</select></td><td>${rowInput(r.cleanout,`data-litter-field="cleanout" data-id="${r.id}"`)}</td><td>${rowInput(r.cleaning,`data-litter-field="cleaning" data-id="${r.id}"`)}</td><td>${rowInput(r.disinfection,`data-litter-field="disinfection" data-id="${r.id}"`)}</td><td>${rowInput(r.vibration,`type="number" step="any" data-litter-field="vibration" data-id="${r.id}"`)}</td><td>${rowInput(r.cracks,`data-litter-field="cracks" data-id="${r.id}"`)}</td><td><textarea data-litter-field="comment" data-id="${r.id}">${escapeHtml(r.comment||'')}</textarea></td><td><button class="btn small danger" data-delete-litter="${r.id}">Suppr.</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aucune zone de litière.</div>'}</section>`;
  document.getElementById('add-litter').onclick=()=>{audit.litters.push({id:uid('litter'),zone:`Zone ${audit.litters.length+1}`,type:'Paille',quantityUnit:'kg/j'});saveBuildingAudit(visit);renderBuildingLitter(panel,currentBuildingContext())};
  panel.querySelectorAll('[data-litter-field]').forEach(el=>{const save=()=>{const r=audit.litters.find(x=>x.id===el.dataset.id);if(r){r[el.dataset.litterField]=el.value;saveBuildingAudit(visit)}};el.addEventListener('input',save);el.addEventListener('change',save);el.addEventListener('blur',save)});panel.querySelectorAll('[data-delete-litter]').forEach(b=>b.onclick=()=>{audit.litters=audit.litters.filter(x=>x.id!==b.dataset.deleteLitter);saveBuildingAudit(visit);renderBuildingLitter(panel,currentBuildingContext())});
}

function renderBuildingAmbience(panel,{visit,audit}){
  const a=audit.ambience;
  panel.innerHTML=`<section class="card"><h3>Ambiance du bâtiment</h3><div class="grid cols-3">${[['temperature','Température °C'],['humidity','Hygrométrie %'],['co2','CO₂ ppm'],['nh3','NH₃ ppm'],['light','Luminosité'],['noise','Bruit'],['airSpeed','Vitesse d’air'],['odor','Odeurs'],['flies','Mouches / nuisibles']].map(([k,l])=>`<div class="field"><label>${l}</label><input data-ambience="${k}" value="${escapeHtml(a[k]||'')}"></div>`).join('')}<div class="field field-wide"><label>Observations</label><textarea data-ambience="comment">${escapeHtml(a.comment||'')}</textarea></div></div></section>`;
  panel.querySelectorAll('[data-ambience]').forEach(el=>{const save=()=>{a[el.dataset.ambience]=el.value;saveBuildingAudit(visit)};el.addEventListener('input',save);el.addEventListener('change',save);el.addEventListener('blur',save)});
}


const sectionPalette=['violet','blue','teal','amber','coral','rose'];
const auditSectionThemes={sanitaire:'violet',reproduction:'blue',jeunes:'teal',pratiques:'amber',fourrages:'coral',organisation:'rose'};
function auditSectionTheme(section,index=0){return auditSectionThemes[section?.id]||sectionPalette[index%sectionPalette.length];}
function completionState(done,total){return done<=0?'empty':done>=total?'complete':'progress';}
function buildingGroupIcon(group=''){if(group.includes('Eau'))return '💧';if(group.includes('Couchage'))return '🛏️';if(group.includes('Ventilation'))return '🌬️';if(group.includes('Circulation'))return '🚪';if(group.includes('Veaux'))return '🐮';if(group.includes('Hygiène'))return '🧼';return '🏠';}
function auditSectionProgress(section,a){const done=section.questions.filter(q=>{const i=a.answers[q]||{};return i.answer||(i.values||[]).length||i.comment}).length;return{done,total:section.questions.length,pct:Math.round(done/Math.max(1,section.questions.length)*100),state:completionState(done,section.questions.length)};}
function renderBuildingQuestionnaire(panel,{visit,audit}){
  const groupStats=buildingQuestionGroups.map(([group,questions],gi)=>{const done=questions.filter(q=>audit.questionnaire[q]?.status).length;return{group,questions,gi,done,total:questions.length,pct:Math.round(done/questions.length*100),state:completionState(done,questions.length)};});
  panel.innerHTML=`<div class="section-title"><div><h3>Questionnaire bâtiment</h3><div class="muted">Les sous-rubriques restent ouvertes pendant la saisie.</div></div><div class="actions"><button class="btn small" id="open-all-building-q">Tout ouvrir</button><button class="btn small secondary" id="close-all-building-q">Tout fermer</button></div></div><div class="building-progress-overview">${groupStats.map(x=>`<button class="building-progress-chip theme-${sectionPalette[x.gi%sectionPalette.length]} state-${x.state}" data-open-building-group="${x.gi}"><span>${buildingGroupIcon(x.group)}</span><b>${escapeHtml(x.group)}</b><small>${x.done}/${x.total}</small><i><em style="width:${x.pct}%"></em></i></button>`).join('')}</div><div class="question-groups">${groupStats.map(x=>`<details class="card question-group theme-${sectionPalette[x.gi%sectionPalette.length]} state-${x.state}" data-building-group="${x.gi}"><summary><span class="section-summary-title"><span class="section-icon">${buildingGroupIcon(x.group)}</span><strong>${escapeHtml(x.group)}</strong></span><span class="section-progress"><b>${x.done}/${x.total}</b><small>${x.state==='complete'?'✓ Terminé':x.state==='progress'?'En cours':'À commencer'}</small></span></summary><div class="question-list">${x.questions.map(q=>{const item=audit.questionnaire[q]||{};return `<div class="question-row"><div><strong>${escapeHtml(q)}</strong>${item.farmerAnswer?`<div class="farmer-declared-answer">👨‍🌾 Réponse éleveur : <b>${escapeHtml(item.farmerAnswer)}</b>${item.farmerSubmittedAt?` · ${formatDateTime(item.farmerSubmittedAt)}`:''}</div>`:''}<input class="question-comment" data-qcomment="${escapeHtml(q)}" value="${escapeHtml(item.comment||'')}" placeholder="Commentaire"></div><select data-qstatus="${escapeHtml(q)}"><option value="">Non renseigné</option>${['Satisfaisant','À surveiller','À corriger','Non concerné'].map(v=>`<option ${item.status===v?'selected':''}>${v}</option>`).join('')}</select></div>`}).join('')}</div></details>`).join('')}</div>`;
  const scrollBuildingGroupTop=d=>setTimeout(()=>d?.scrollIntoView({behavior:'smooth',block:'start'}),40);
  const updateBuildingGroupProgress=gi=>{
    const stat=buildingQuestionGroups[gi];if(!stat)return;const [group,questions]=stat;
    const done=questions.filter(q=>audit.questionnaire[q]?.status).length,total=questions.length,pct=Math.round(done/Math.max(1,total)*100),state=completionState(done,total);
    const detail=panel.querySelector(`[data-building-group="${gi}"]`),chip=panel.querySelector(`[data-open-building-group="${gi}"]`);
    if(detail){detail.classList.remove('state-empty','state-progress','state-complete');detail.classList.add(`state-${state}`);const prog=detail.querySelector('.section-progress');if(prog)prog.innerHTML=`<b>${done}/${total}</b><small>${state==='complete'?'✓ Terminé':state==='progress'?'En cours':'À commencer'}</small>`;}
    if(chip){chip.classList.remove('state-empty','state-progress','state-complete');chip.classList.add(`state-${state}`);const small=chip.querySelector('small');if(small)small.textContent=`${done}/${total}`;const em=chip.querySelector('i em');if(em)em.style.width=`${pct}%`;}
  };
  panel.querySelectorAll('[data-open-building-group]').forEach(b=>b.onclick=()=>{const d=panel.querySelector(`[data-building-group="${b.dataset.openBuildingGroup}"]`);if(d){d.open=true;scrollBuildingGroupTop(d);}});document.getElementById('open-all-building-q')?.addEventListener('click',()=>panel.querySelectorAll('.question-group').forEach(d=>d.open=true));document.getElementById('close-all-building-q')?.addEventListener('click',()=>panel.querySelectorAll('.question-group').forEach(d=>d.open=false));
  panel.querySelectorAll('.question-group').forEach(d=>d.addEventListener('toggle',()=>{ /* pas de recentrage automatique : l’utilisateur garde sa position */ }));
  panel.querySelectorAll('[data-qstatus]').forEach(el=>el.addEventListener('change',()=>{const q=el.dataset.qstatus;audit.questionnaire[q]=audit.questionnaire[q]||{};audit.questionnaire[q].status=el.value;saveBuildingAudit(visit);const d=el.closest('[data-building-group]');if(d)updateBuildingGroupProgress(Number(d.dataset.buildingGroup));}));
  panel.querySelectorAll('[data-qcomment]').forEach(el=>{const save=()=>{const q=el.dataset.qcomment;audit.questionnaire[q]=audit.questionnaire[q]||{};audit.questionnaire[q].comment=el.value;saveBuildingAudit(visit)};el.addEventListener('input',save);el.addEventListener('blur',save)});
}


const auditQuestionConfigs = {
  'Principaux problèmes sanitaires rencontrés sur les 12 derniers mois': ['multi',['Aucun problème majeur','Diarrhées','Troubles respiratoires','Avortements','Mammites','Boiteries','Omphalites / arthrites','Mortalité veaux','Mortalité adultes','Problèmes de reproduction','Autre']],
  'Organisation de la vaccination': ['multi',['Plan écrit','Plan oral','Vaccination collective','Vaccination ciblée','Rappels planifiés','Selon le contexte','Aucune vaccination','Autre']],
  'Gestion du parasitisme et recours aux coprologies': ['multi',['Coprologies régulières','Coprologies ponctuelles','Traitement raisonné selon résultats','Traitement selon risque / saison','Traitement systématique','Aucun suivi','Autre']],
  'Gestion des traitements et respect des délais d’attente': ['select',['Traçabilité complète','Traçabilité partielle','Gestion orale / mémoire','À améliorer']],
  'Registre sanitaire et traçabilité des interventions': ['select',['Papier à jour','Informatique à jour','Mise à jour irrégulière','Non tenu']],
  'Gestion des animaux malades et possibilité d’isolement': ['multi',['Case dédiée','Lot spécifique','Isolement ponctuel','Soins dans le lot','Pas de zone dédiée','Autre']],
  'Gestion des introductions et quarantaine': ['multi',['Pas d’introduction','Quarantaine systématique','Quarantaine ponctuelle','Analyses avant introduction','Vaccination avant mélange','Mélange direct','Autre']],
  'Statut sanitaire des animaux achetés': ['multi',['Documents contrôlés','Analyses demandées','Historique sanitaire connu','Contrôle partiel','Non vérifié','Pas d’achat']],
  'Gestion des cadavres et des déchets de soins': ['multi',['Zone dédiée','Équarrissage organisé','Déchets de soins triés','Stockage temporaire sécurisé','À améliorer']],
  'Plan de lutte contre les nuisibles': ['multi',['Dératisation planifiée','Pièges / appâts suivis','Lutte contre les mouches','Protection des aliments','Prestataire','Aucun plan']],
  'Relation et fréquence de suivi avec le vétérinaire sanitaire': ['select',['Suivi régulier planifié','À la demande','Urgences principalement','Peu de suivi']],
  'Mode de mise à la reproduction': ['multi',['Monte naturelle','Insémination artificielle','Synchronisation','Transfert embryonnaire','Mixte','Autre']],
  'Période de mise à la reproduction': ['select',['Toute l’année','Saison groupée','Deux périodes','Variable selon lots','Autre']],
  'Suivi des chaleurs et des retours': ['multi',['Observation visuelle','Taureau détecteur','Colliers / capteurs','Planning papier','Logiciel','Peu de suivi','Autre']],
  'Diagnostics de gestation': ['select',['Systématiques','Sur une partie du troupeau','Selon suspicion','Non réalisés']],
  'Gestion des vaches vides': ['multi',['Réforme rapide','Nouvelle mise à la reproduction','Lot spécifique','Engraissement avant vente','Décision au cas par cas','Autre']],
  'Préparation des animaux à la mise bas': ['multi',['Lot dédié','Ration spécifique','Minéral spécifique','Surveillance renforcée','Case de vêlage','Pas de préparation particulière','Autre']],
  'Surveillance des vêlages': ['multi',['Présence régulière','Caméra','Capteur de vêlage','Rondes nocturnes','Surveillance ponctuelle','Autre']],
  'Gestion des délivrances et complications post-partum': ['multi',['Protocole vétérinaire','Surveillance systématique','Traitement selon signes','Enregistrement des cas','Pas de protocole','Autre']],
  'Taux de gestation (%)': ['number','%'],
  'Veaux sevrés par vache (nb)': ['number','veaux/vache'],
  'Âge moyen au premier vêlage': ['number','mois'],
  'Intervalle vêlage-vêlage': ['number','jours'],
  'Origine des génisses de renouvellement': ['select',['100 % élevage','Majoritairement élevage','Mixte élevage / achat','Majoritairement achat','100 % achat']],
  'Critères de sélection des génisses': ['multi',['Origine maternelle','Croissance','Conformation','Aplombs','Docilité','Santé','Valeur génétique','Facilité de naissance','Autre']],
  'Désinfection du nombril': ['select',['Systématique à la naissance','Systématique avec renouvellement','Selon état','Rarement','Jamais']],
  'Délai de distribution du colostrum': ['select',['Moins de 2 h','2 à 4 h','4 à 6 h','Plus de 6 h','Variable / non suivi']],
  'Contrôle de la qualité du colostrum': ['select',['Réfractomètre systématique','Réfractomètre ponctuel','Contrôle visuel','Non contrôlée']],
  'Quantité de colostrum distribuée': ['select',['Quantité mesurée et adaptée','Quantité estimée','Tétée naturelle surveillée','Variable','Non suivie']],
  'Mode de logement des veaux': ['multi',['Case individuelle','Case collective','Nurserie','Avec la mère','Extérieur','Mixte','Autre']],
  'Nettoyage et désinfection entre lots': ['multi',['Curage complet','Lavage','Désinfection','Vide sanitaire','Paillage seul','Pas systématique','Autre']],
  'Accès à l’eau et à l’aliment solide': ['multi',['Eau dès la naissance','Eau après quelques jours','Concentré précoce','Foin précoce','Accès irrégulier','Autre']],
  'Mode et âge de sevrage': ['multi',['Progressif','Brutal','Selon âge','Selon poids','Selon consommation','Par lot','Autre']],
  'Suivi de la croissance': ['multi',['Pesées régulières','Pesées ponctuelles','Ruban barymétrique','Observation visuelle','Pas de suivi','Autre']],
  'Organisation de l’allotement': ['multi',['Par âge','Par poids','Par stade physiologique','Par besoins alimentaires','Par sexe','Peu d’allotement','Autre']],
  'Mode de pâturage': ['multi',['Continu','Tournant','Tournant dynamique','Paddocks','Estive','Affouragement au champ','Pas de pâturage','Autre']],
  'Gestion de l’estive': ['select',['Pas d’estive','Tous les animaux concernés','Une partie du troupeau','Selon années','Autre']],
  'Transitions alimentaires': ['select',['Plus de 2 semaines','7–14 jours','Moins de 7 jours','Sans transition','Variable']],
  'Organisation du tarissement': ['multi',['Lot dédié','Ration dédiée','Tarissement groupé','Tarissement individuel','Pas de conduite spécifique','Non concerné','Autre']],
  'Fréquence d’observation du troupeau': ['select',['Plusieurs fois par jour','Une fois par jour','Quelques fois par semaine','Irrégulière']],
  'Parage et suivi des aplombs': ['multi',['Parage préventif planifié','Parage curatif','Observation régulière','Intervention ponctuelle','Pas de suivi','Autre']],
  'Type de sol des principales surfaces': ['multi',['Argileux','Limoneux','Sableux','Argilo-limoneux','Limono-argileux','Calcaire','Hydromorphe','Tourbeux','Plusieurs types','Non connu','Autre']],
  'Type de prairies': ['multi',['Prairies permanentes','Prairies temporaires','Parcours / landes','Prairies naturelles','Mixte','Autre']],
  'Pratique du sur-semis': ['select',['Régulière','Occasionnelle','Après dégradation','Jamais']],
  'Espèces semées dans les prairies temporaires ou sur-semis': ['multi',['Ray-grass anglais','Ray-grass hybride','Ray-grass italien','Dactyle','Fétuque élevée','Fétuque des prés','Fléole','Brome','Luzerne','Trèfle blanc','Trèfle violet','Lotier','Méteil','Mélange multi-espèces','Autre']],
  'Rotation des cultures et prairies': ['multi',['Rotation planifiée','Prairie longue durée','Maïs / prairie','Céréales / prairie','Luzerne dans la rotation','Rotation variable','Pas de rotation formalisée','Autre']],
  'Fertilisation et amendements': ['multi',['Fumier','Lisier','Compost','Azote minéral','Phosphore','Potasse','Chaulage','Analyse de sol utilisée','Plan de fumure','Selon habitudes','Autre']],
  'Irrigation': ['select',['Aucune','Ponctuelle','Régulière','Uniquement certaines cultures','Selon disponibilité en eau']],
  'Stade de récolte des fourrages': ['multi',['Feuillu / précoce','Début épiaison','Épiaison','Floraison','Après floraison','Variable selon météo','Autre']],
  'Hauteur de coupe': ['select',['Moins de 5 cm','5–7 cm','7–10 cm','Plus de 10 cm','Variable / non mesurée']],
  'Qualité visuelle du foin': ['multi',['Vert','Bonne odeur','Peu poussiéreux','Sans moisissure','Jauni','Poussiéreux','Moisissures visibles','Échauffement','Hétérogène selon lots','Autre']],
  'Matière sèche du foin': ['select',['Mesurée','Estimée','Non connue','Variable selon lots']],
  'Méthode de réalisation du foin': ['multi',['Fauché sans conditionneur','Fauché avec conditionneur','Fanage','Andains de nuit','Andainage au soleil','Balles rondes','Balles carrées','Séchage en grange','Conservateur','Autre']],
  'Réalisation des ensilages': ['multi',['Récolte directe','Préfanage','Conditionneur','Hachage court','Hachage long','Conservateur','Chantier rapide','Chantier étalé','Autre']],
  'Tassement, bâchage et protection des silos': ['multi',['Tassage continu','Couches fines','Double bâche','Film barrière oxygène','Bâche simple','Filet / sacs','Pneus','Protection des bords','Défauts visibles','Autre']],
  'Réalisation de l’enrubannage': ['multi',['Préfanage','Balles rondes','Balles carrées','4 couches','6 couches ou plus','Film clair','Film foncé','Stockage vertical','Stockage horizontal','Perforations observées','Autre']],
  'Stockage des fourrages': ['multi',['Sous bâtiment','Sur dalle','Sur palettes','Bâché extérieur','Directement au sol','Séparé par lots','Protégé des nuisibles','Autre']],
  'Analyses de fourrages disponibles': ['multi',['Foin','Enrubannage','Ensilage maïs','Ensilage herbe','Céréales','Méteil','Paille','Minéral','Aucune','Autre']],
  'Gestion du front d’attaque et distribution': ['multi',['Avancement régulier','Front net','Reprise quotidienne','Échauffement limité','Échauffement présent','Moisissures retirées','Mélange des lots','Autre']],
  'Temps de travail et astreintes': ['select',['Compatible avec l’organisation','Tendu en période de pointe','Très contraignant','Recours fréquent à des prestataires','À réorganiser']],
  'Suivi des actions décidées lors des visites précédentes': ['select',['Systématique','Partiel','Occasionnel','Non formalisé','Première visite']],
  'Mortalité veaux (%)':['number','%'],'Mortalité adultes (%)':['number','%'],'Diarrhées néonatales — nombre de veaux atteints/an':['number','cas/an'],'Pathologies respiratoires / pneumonies — nombre d’animaux atteints/an':['number','cas/an'],'Mammites cliniques — nombre de vaches atteintes/an':['number','cas/an'],'Boiteries — nombre d’animaux atteints/an':['number','cas/an'],'Omphalites / arthrites — nombre de veaux atteints/an':['number','cas/an'],'Troubles de reproduction — nombre de femelles atteintes/an':['number','cas/an'],'Avortements (nombre/an)':['number','cas/an'],'Vêlages difficiles avec intervention — nombre/an':['number','cas/an'],'Réformes suite au vêlage — nombre/an':['number','cas/an'],'Usage antiparasitaires (traitements/an)':['number','trait./an'],'Usage antibiotiques (traitements/UGB/an)':['number','trait./UGB/an'],
  'Diarrhées néonatales — nombre de veaux atteints/an':['number','veaux/an'],'Diarrhées (tous âges) — nombre d’animaux atteints/an':['number','animaux/an'],'Pathologies respiratoires / pneumonies — nombre d’animaux atteints/an':['number','animaux/an'],'Mammites cliniques — nombre de vaches atteintes/an':['number','vaches/an'],'Boiteries — nombre d’animaux atteints/an':['number','animaux/an'],'Omphalites / arthrites — nombre de veaux atteints/an':['number','veaux/an'],'Troubles de reproduction — nombre de femelles atteintes/an':['number','femelles/an'],'Avortements (nombre/an)':['number','/an'],'Vêlages difficiles avec intervention — nombre/an':['number','/an'],'Réformes suite au vêlage — nombre/an':['number','/an'],'Usage antiparasitaires (traitements/an)':['number','traitements/an'],'Usage antibiotiques (traitements/UGB/an)':['number','traitements/UGB/an'],
  'Produits animaux lait + viande (€ / an)':['number','€'],'Aides PAC totales (€ / an)':['number','€'],'Prix du lait (€/1000 L)':['number','€/1000 L'],'Lait produit (L / an)':['number','L'],'Prix moyen kg carcasse (€)':['number','€/kg'],'Total kg carcasse produits (kg / an)':['number','kg'],'Nombre moyen de vaches sur exercice':['number','vaches'],'Charge aliments / concentrés (€ / an)':['number','€'],'Charge minéraux (€ / an)':['number','€'],'Frais vétérinaires honoraires + produits (€ / an)':['number','€'],'Marge brute atelier élevage (€ / an)':['number','€'],'SFP (ha)':['number','ha'],'Fertilisation (€ / an)':['number','€'],'Semences (€ / an)':['number','€'],'Traitements cultures (€ / an)':['number','€'],'Travaux par tiers (€ / an)':['number','€'],'Autres charges SFP bâches ficelles (€ / an)':['number','€'],'EBE exploitation (€ / an)':['number','€'],'Revenu disponible exploitation (€ / an)':['number','€'],'Taux d’endettement (%)':['number','%'],'Poids veaux au sevrage (kg)':['number','kg'],'GMQ jeunes bovins (g/j)':['number','g/j'],'Âge moyen vente / abattage (jours)':['number','j'],'Poids carcasse moyen broutards (kg)':['number','kg'],'Poids carcasse moyen génisses (kg)':['number','kg'],'Poids carcasse moyen réformes (kg)':['number','kg'],'Concentrés par vache (kg/an)':['number','kg/an'],'Autonomie fourragère (%)':['number','%'],'Chargement (UGB/ha)':['number','UGB/ha'],'Consommation d’eau (L/animal/jour)':['number','L/j'],'Kg viande/vache/an':['number','kg/an'],'Kg viande/ha':['number','kg/ha'],'Concentrés/kg viande (kg/kg)':['number','kg/kg']
};
const herdTimelineTypes=['Mise à l’herbe','Retour en bâtiment','Estive','Descente d’estive','Changement de ration','Changement de fourrage','Changement de minéral','Vaccination du troupeau','Vermifugation','Coproscopie','Parage','Autre'];
const cropTimelineTypes=['Préparation du sol','Semis printemps','Semis été','Semis automne','Semis hiver','Fumier','Lisier','Compost','Fertilisation','Irrigation','Traitement','Fauche foin','Regain','Enrubannage','Ensilage','Récolte grain','Pâturage','Autre'];
const purchaseProducts=['Foin','Paille','Ensilage','Enrubannage','Maïs grain','Maïs épi','Luzerne','Aliment complet','Concentré','Minéral','Correcteur azoté','Pulpes','Coproduits','Autre'];
const saleProducts=['Céréales','Foin','Paille','Enrubannage','Ensilage','Fourrage autre','Reproducteurs','Broutards','Veaux sous la mère','Animaux engraissés','Vente directe viande','Vaches de réforme','Autre'];
const reformReasons=['Problème de reproduction','Aplombs / boiterie','Âge','Mamelle','Sanitaire','Production insuffisante','Accident','Tempérament','Autre'];
const mortalityClasses=['0–2 jours','2 jours–1 mois','1–6 mois','6–12 mois','12–24 mois','> 24 mois'];
const mortalityCauses=['Diarrhée','Respiratoire','Accident','Métabolique','Mise bas','Intoxication','Prédation','Malformation','Inconnue','Autre'];
const farmerObjectives=['Gain économique / réduction des coûts','Améliorer la santé animale','Améliorer la reproduction','Améliorer les performances','Mieux valoriser les fourrages','Gagner en autonomie','Simplifier la charge de travail','Améliorer le bien-être animal','Transmission / installation','Adapter les bâtiments','Autre'];

const AUDIT_DRAFT_PREFIX='audit-bovin-audit-draft-v43:';
function auditDraftKey(visit){return visit?.id?AUDIT_DRAFT_PREFIX+visit.id:''}
function saveAuditDraftLocal(visit,a){const key=auditDraftKey(visit);if(!key)return;try{localStorage.setItem(key,JSON.stringify({updatedAt:new Date().toISOString(),answers:a.answers||{},chapterSummaries:a.chapterSummaries||{}}))}catch(_){}}
function restoreAuditDraftLocal(visit,a){const key=auditDraftKey(visit);if(!key)return;try{const d=JSON.parse(localStorage.getItem(key)||'null');if(!d)return;const draftAt=Date.parse(d.updatedAt||0)||0,visitAt=Date.parse(visit.updatedAt||0)||0;if(draftAt>=visitAt){a.answers={...(a.answers||{}),...(d.answers||{})};a.chapterSummaries={...(a.chapterSummaries||{}),...(d.chapterSummaries||{})}}}catch(_){}}
function ensureAuditGlobal(visit){const a=visit.auditGlobal=visit.auditGlobal&&typeof visit.auditGlobal==='object'?visit.auditGlobal:{};a.answers=a.answers&&typeof a.answers==='object'?a.answers:{};a.purchases=Array.isArray(a.purchases)?a.purchases:[];a.sales=Array.isArray(a.sales)?a.sales:(Array.isArray(a.outlets)?a.outlets.map(x=>({...x,product:x.product||x.type})):[]);a.reforms=a.reforms&&typeof a.reforms==='object'?a.reforms:{};a.reforms.reasons=a.reforms.reasons&&typeof a.reforms.reasons==='object'?a.reforms.reasons:{};a.renewal=a.renewal&&typeof a.renewal==='object'?a.renewal:{};a.mortality=a.mortality&&typeof a.mortality==='object'?a.mortality:{};mortalityClasses.forEach(c=>a.mortality[c]=a.mortality[c]&&typeof a.mortality[c]==='object'?a.mortality[c]:{count:'',causes:[]});a.economics=a.economics&&typeof a.economics==='object'?a.economics:{};a.organization=a.organization&&typeof a.organization==='object'?a.organization:{objectives:[]};a.organization.objectives=Array.isArray(a.organization.objectives)?a.organization.objectives:[];a.chapterSummaries=a.chapterSummaries&&typeof a.chapterSummaries==='object'?a.chapterSummaries:{};a.timelines=a.timelines&&typeof a.timelines==='object'?a.timelines:{};a.timelines.startMonth=a.timelines.startMonth||`${(visit.date||new Date().toISOString().slice(0,10)).slice(0,7)}`;a.timelines.herd=Array.isArray(a.timelines.herd)?a.timelines.herd:[];a.timelines.crops=Array.isArray(a.timelines.crops)?a.timelines.crops:[];restoreAuditDraftLocal(visit,a);return a}
function auditCompletion(a){const qs=auditGlobalSections.flatMap(s=>s.questions),done=qs.filter(q=>{const i=a.answers[q]||{};return i.answer||(Array.isArray(i.values)&&i.values.length)||i.comment}).length,extra=[a.purchases.length,a.sales.length,Object.values(a.renewal).filter(Boolean).length,Object.values(a.mortality).filter(x=>x?.count).length].filter(Boolean).length;return{done:done+extra,total:qs.length+4,pct:Math.round((done+extra)/(qs.length+4)*100)}}
function saveAuditGlobal(v){v.updatedAt=new Date().toISOString();saveDatabase(db)}
function qConfig(q){const c=auditQuestionConfigs[q];return c?{type:c[0],options:Array.isArray(c[1])?c[1]:[],unit:typeof c[1]==='string'?c[1]:''}:{type:'text'}}
function auditInputHtml(q,item){const c=qConfig(q);if(c.type==='select')return `<select data-audit-answer="${escapeHtml(q)}"><option value="">Choisir…</option>${c.options.map(v=>`<option value="${escapeHtml(v)}" ${item.answer===v?'selected':''}>${escapeHtml(v)}</option>`).join('')}</select>`;if(c.type==='number')return `<div class="input-with-unit"><input type="number" step="any" data-audit-answer="${escapeHtml(q)}" value="${escapeHtml(item.answer||'')}"><span>${escapeHtml(c.unit)}</span></div>`;if(c.type==='multi'){const vals=Array.isArray(item.values)?item.values:[];return `<div class="audit-multi">${c.options.map(v=>`<label><input type="checkbox" data-audit-multi="${escapeHtml(q)}" value="${escapeHtml(v)}" ${vals.includes(v)?'checked':''}><span>${escapeHtml(v)}</span></label>`).join('')}</div><input data-audit-answer="${escapeHtml(q)}" value="${escapeHtml(item.answer||'')}" placeholder="Précision / autre">`}return `<textarea data-audit-answer="${escapeHtml(q)}" placeholder="Réponse / description">${escapeHtml(item.answer||'')}</textarea>`}
function auditQuestionSource(q){
  const text=normalizeSearchText(q);
  const calculated=['intervalle velage','age moyen au premier velage','mortalite veaux','mortalite adultes','kg viande/vache','kg viande/ha','chargement','concentres/kg','nombre moyen de vaches'];
  const later=['EBE exploitation (€ / an)','Revenu disponible exploitation (€ / an)','Taux d’endettement (%)','Aides PAC totales (€ / an)','Charge aliments / concentrés (€ / an)','Charge minéraux (€ / an)','Frais vétérinaires honoraires + produits (€ / an)','Marge brute atelier élevage (€ / an)','Fertilisation (€ / an)','Semences (€ / an)','Traitements cultures (€ / an)','Travaux par tiers (€ / an)','Autres charges SFP bâches ficelles (€ / an)','Produits animaux lait + viande (€ / an)'];
  if(calculated.some(x=>text.includes(x)))return {key:'calc',label:'🧮 Calculable si données disponibles'};
  if(later.some(x=>text.includes(normalizeSearchText(x))))return {key:'later',label:'📎 À demander / document comptable si disponible'};
  return {key:'ask',label:'💬 À demander / confirmer'};
}
function auditQuestionRow(q,a){const i=a.answers[q]||{},m=auditQuestionSource(q),dv=derivedAuditValue(activeVisit(),q),auto=dv!==null&&dv!==undefined&&dv!=='';const control=(m.key==='calc'&&auto)?`<div class="calculated-answer"><strong>${escapeHtml(String(dv).replace('.',','))}</strong><small>Calculé automatiquement à partir des fichiers disponibles — seule la cause / le contexte est à confirmer.</small></div>`:auditInputHtml(q,i);return `<div class="audit-question-row audit-question-smart source-${m.key}"><div class="audit-question-title"><strong>${escapeHtml(q)}</strong><span class="source-badge ${m.key}">${m.label}</span>${auto?`<span class="derived-value">Auto : ${escapeHtml(String(dv).replace('.',','))}</span>`:''}</div><div class="audit-question-control">${control}</div><textarea data-audit-comment="${escapeHtml(q)}" placeholder="Causes / contexte / commentaire facultatif">${escapeHtml(i.comment||'')}</textarea></div>`}
function chapterSummaryHtml(id,a){const s=a.chapterSummaries[id]||{};return `<div class="chapter-summary"><h4>Synthèse du technicien</h4><div class="grid cols-3"><div class="field"><label>Points forts</label><textarea data-summary="${id}" data-summary-field="strengths">${escapeHtml(s.strengths||'')}</textarea></div><div class="field"><label>Points de vigilance</label><textarea data-summary="${id}" data-summary-field="watch">${escapeHtml(s.watch||'')}</textarea></div><div class="field"><label>Commentaires / pistes</label><textarea data-summary="${id}" data-summary-field="comments">${escapeHtml(s.comments||'')}</textarea></div></div></div>`}
function timelineMonths(start){const[y,m]=(start||new Date().toISOString().slice(0,7)).split('-').map(Number);return Array.from({length:18},(_,i)=>{const d=new Date(y,m-1+i,1);return{key:d.toISOString().slice(0,7),label:d.toLocaleDateString('fr-FR',{month:'short',year:'2-digit'})}})}
function timelineVisual(kind,a){const ms=timelineMonths(a.timelines.startMonth),events=a.timelines[kind]||[];return `<div class="timeline-board"><div class="timeline-months">${ms.map(m=>`<span>${escapeHtml(m.label)}</span>`).join('')}</div><div class="timeline-events">${events.length?events.map(ev=>{const si=Math.max(0,ms.findIndex(m=>m.key===ev.start)),ri=ms.findIndex(m=>m.key===(ev.end||ev.start)),ei=Math.max(si,ri<0?si:ri);return `<div class="timeline-event-row"><div class="timeline-event-label"><strong>${escapeHtml(ev.type)}</strong>${ev.comment?`<small>${escapeHtml(ev.comment)}</small>`:''}</div><div class="timeline-track"><div class="timeline-bar ${kind}" style="left:${si/18*100}%;width:${(ei-si+1)/18*100}%">${si===ei?'●':''}</div></div><button class="btn small danger" data-delete-timeline="${kind}" data-id="${ev.id}">×</button></div>`}).join(''):'<div class="empty compact">Aucun événement placé.</div>'}</div></div>`}
function timelineEditor(kind,a){const ms=timelineMonths(a.timelines.startMonth),types=kind==='herd'?herdTimelineTypes:cropTimelineTypes;return `<section class="card timeline-card"><div class="section-title"><div><h3>${kind==='herd'?'🐄 Frise conduite de l’élevage':'🌱 Frise cultures et fourrages'}</h3><div class="muted">Repères globaux sur la façon de travailler.</div></div></div>${timelineVisual(kind,a)}<div class="timeline-add"><select data-timeline-type="${kind}">${types.map(v=>`<option>${escapeHtml(v)}</option>`).join('')}</select><select data-timeline-start="${kind}">${ms.map(m=>`<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('')}</select><select data-timeline-end="${kind}">${ms.map(m=>`<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('')}</select><input data-timeline-comment="${kind}" placeholder="Note facultative"><button class="btn primary" data-add-timeline="${kind}">Ajouter</button></div></section>`}
function economicTable(kind,rows,products){const purchase=kind==='purchase';return `<section class="card"><div class="section-title"><div><h3>${purchase?'Achats':'Ventes / revenus'}</h3></div><button class="btn primary" data-add-economic="${kind}">Ajouter une ligne</button></div>${rows.length?`<div class="table-wrap"><table class="audit-table"><thead><tr><th>Produit</th><th>Précision</th><th>Quantité</th><th>Unité</th><th>Tarif unitaire €</th><th>Total €</th><th>${purchase?'Fournisseur':'Acheteur / débouché'}</th><th>Commentaire</th><th></th></tr></thead><tbody>${rows.map(r=>{const total=(Number(r.quantity)||0)*(Number(r.unitPrice)||0);return `<tr><td><select data-economic-field="product" data-kind="${kind}" data-id="${r.id}">${products.map(v=>`<option ${r.product===v?'selected':''}>${escapeHtml(v)}</option>`).join('')}</select></td><td><input data-economic-field="detail" data-kind="${kind}" data-id="${r.id}" value="${escapeHtml(r.detail||'')}"></td><td><input type="number" step="any" data-economic-field="quantity" data-kind="${kind}" data-id="${r.id}" value="${escapeHtml(r.quantity||'')}"></td><td><input data-economic-field="unit" data-kind="${kind}" data-id="${r.id}" value="${escapeHtml(r.unit||'')}"></td><td><input type="number" step="any" data-economic-field="unitPrice" data-kind="${kind}" data-id="${r.id}" value="${escapeHtml(r.unitPrice||'')}"></td><td><strong>${total?total.toLocaleString('fr-FR',{maximumFractionDigits:2}):''}</strong></td><td><input data-economic-field="partner" data-kind="${kind}" data-id="${r.id}" value="${escapeHtml(r.partner||'')}"></td><td><textarea data-economic-field="comment" data-kind="${kind}" data-id="${r.id}">${escapeHtml(r.comment||'')}</textarea></td><td><button class="btn small danger" data-delete-economic="${kind}" data-id="${r.id}">Suppr.</button></td></tr>`}).join('')}</tbody></table></div>`:'<div class="empty">Aucune ligne renseignée.</div>'}</section>`}
const renewalRate=a=>Number(a.cowsTotal)?Math.round((Number(a.replacementHeifers)||0)/Number(a.cowsTotal)*1000)/10:null;
const reformRate=a=>Number(a.cowsTotal)?Math.round((Number(a.annualReforms)||0)/Number(a.cowsTotal)*1000)/10:null;
function renderAuditGlobal(){const visit=activeVisit();if(!visit){renderNoActiveVisit('Audit de l’exploitation');return}const a=ensureAuditGlobal(visit),c=auditCompletion(a),rr=renewalRate(a.renewal),rf=reformRate(a.renewal);app.innerHTML=`<div class="section-title"><div><h2>Audit de l’exploitation</h2><div class="muted">Réponses adaptées à chaque question et tableaux technico-économiques.</div></div><div class="actions"><span class="badge autosave">Sauvegarde automatique</span></div></div>${activeVisitBanner(visit)}<section class="card source-legend"><strong>Repères de saisie :</strong><span class="source-badge ask">💬 À demander / confirmer</span><span class="source-badge measure">📏 À mesurer / relever</span><span class="source-badge later">📎 À récupérer / compléter après</span><span class="source-badge calc">🧮 Calculable si données disponibles</span><small>Une information calculable n’est pas redemandée si elle est déjà disponible dans les imports ou une visite précédente.</small></section>${a.importedHerdData?`<section class="notice imported-data-notice"><strong>📥 Données d’élevage importées</strong><br>Source : ${escapeHtml(a.importedHerdData.sourceFile||'CSV')} · appliquées le ${formatDateTime(a.importedHerdData.appliedAt)}. Les effectifs, mortalités, achats, débouchés et indicateurs de reproduction doivent être vérifiés avec l’éleveur.<details><summary>Voir les indicateurs complémentaires</summary><div class="grid cols-3">${Object.entries(a.importedHerdData.summary||{}).filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([k,v])=>`<div class="calculated-box"><span>${escapeHtml(({totalHerd:'Effectif total',births:'Naissances',purchases:'Achats',totalOutputs:'Sorties totales',mortalityTotal:'Mortalité totale',mortalityYoungRate:'Taux mortalité jeunes (%)',abortions:'Avortements',productivity:'Productivité numérique',unproductiveFemales:'Femelles improductives'})[k]||k)}</span><strong>${escapeHtml(String(v).replace('.',','))}</strong></div>`).join('')}</div></details></section>`:''}<section class="card audit-progress-card"><div><strong>Avancement</strong><span>${c.done}/${c.total} éléments</span></div><div class="progress-track large"><div style="width:${c.pct}%"></div></div><strong>${c.pct}%</strong></section><section class="card timeline-settings"><div class="field"><label>Mois de départ des frises</label><input type="month" id="timeline-start-month" value="${escapeHtml(a.timelines.startMonth)}"></div></section><div class="timeline-grid">${timelineEditor('herd',a)}${timelineEditor('crops',a)}</div><div class="audit-section-overview">${auditGlobalSections.map((s,si)=>{const p=auditSectionProgress(s,a);return `<button class="audit-overview-item theme-${auditSectionTheme(s,si)} state-${p.state}" data-open-audit-section="${s.id}"><span>${s.icon}</span><b>${escapeHtml(s.title)}</b><small>${p.done}/${p.total}</small><i><em style="width:${p.pct}%"></em></i></button>`}).join('')}</div><div class="audit-sections">${auditGlobalSections.map((s,si)=>{const p=auditSectionProgress(s,a);return `<details class="card audit-section theme-${auditSectionTheme(s,si)} state-${p.state}" data-audit-section-id="${s.id}" data-audit-loaded="0"><summary><span><span class="audit-icon">${s.icon}</span><strong>${escapeHtml(s.title)}</strong></span><span class="audit-section-status"><span class="audit-count">${p.done}/${p.total}</span><small>${p.state==='complete'?'✓ Terminé':p.state==='progress'?'En cours':'À commencer'}</small></span></summary><div class="audit-question-list audit-question-list-lazy"></div></details>`}).join('')}</div><section class="card structured-audit accent-rose"><h3>🎯 Objectifs de l’éleveur et pluriactivité</h3><div class="audit-multi objectives">${farmerObjectives.map(v=>`<label><input type="checkbox" data-objective value="${escapeHtml(v)}" ${a.organization.objectives.includes(v)?'checked':''}><span>${escapeHtml(v)}</span></label>`).join('')}</div><div class="grid cols-3"><div class="field"><label>Pluriactif</label><select data-org="pluriactive"><option value="">Non renseigné</option>${['Non','Oui'].map(v=>`<option ${a.organization.pluriactive===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Organisation</label><select data-org="pluriactivityMode"><option value="">Choisir…</option>${['Activité annuelle','Activité saisonnière','Activité ponctuelle'].map(v=>`<option ${a.organization.pluriactivityMode===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Période / répartition / % du temps</label><input data-org="pluriactivityDetail" value="${escapeHtml(a.organization.pluriactivityDetail||'')}"></div></div></section><section class="grid cols-2 structured-audit"><article class="card accent-teal"><h3>🐄 Structure du troupeau et renouvellement</h3>${[['cowsTotal','Vaches mères / production'],['cowsPregnant','Vaches pleines'],['cowsEmpty','Vaches vides'],['nurseCows','Tantes / nourrices'],['bulls','Taureaux reproducteurs'],['pregnantHeifers','Génisses pleines'],['heifers12_24','Génisses 12–24 mois'],['heifers6_12','Génisses 6–12 mois'],['calvesUnder6','Veaux < 6 mois'],['replacementHeifers','Génisses de renouvellement'],['annualReforms','Nombre annuel de réformes']].map(([k,l])=>`<div class="field inline-field"><label>${l}</label><input type="number" min="0" data-renewal="${k}" value="${escapeHtml(a.renewal[k]||'')}"></div>`).join('')}<div class="calculated-box"><span>Taux de renouvellement</span><strong>${rr===null?'—':rr+' %'}</strong></div><div class="calculated-box"><span>Taux de réforme</span><strong>${rf===null?'—':rf+' %'}</strong></div></article><article class="card accent-coral"><h3>📉 Motifs des réformes</h3>${reformReasons.map(v=>`<div class="field inline-field"><label>${v}</label><input type="number" min="0" data-reform-reason="${v}" value="${escapeHtml(a.reforms.reasons[v]||'')}"></div>`).join('')}<div class="field"><label>Commentaire</label><textarea data-reform-comment>${escapeHtml(a.reforms.comment||'')}</textarea></div></article></section>${a.importedHerdData?`<section class="card imported-mortality-recap"><div class="section-title"><div><h3>📥 Mortalité importée</h3><div class="muted">Valeurs issues du fichier élevage et reprises ci-dessous dans les champs de l’audit.</div></div></div><div class="grid cols-3">${mortalityClasses.map(cl=>`<div class="calculated-box"><span>${escapeHtml(cl)}</span><strong>${escapeHtml(a.mortality[cl]?.count||'—')}</strong></div>`).join('')}</div></section>`:''}<section class="card structured-audit accent-red"><h3>⚕️ Mortalité par classe d’âge</h3><div class="table-wrap"><table class="audit-table"><thead><tr><th>Classe</th><th>Nombre</th><th>Causes</th><th>Commentaire</th></tr></thead><tbody>${mortalityClasses.map(cl=>{const r=a.mortality[cl];return `<tr><td><strong>${cl}</strong></td><td><input type="number" min="0" data-mortality-count="${cl}" value="${escapeHtml(r.count||'')}"></td><td><div class="audit-multi compact">${mortalityCauses.map(v=>`<label><input type="checkbox" data-mortality-cause="${cl}" value="${v}" ${r.causes.includes(v)?'checked':''}><span>${v}</span></label>`).join('')}</div></td><td><textarea data-mortality-comment="${cl}">${escapeHtml(r.comment||'')}</textarea></td></tr>`}).join('')}</tbody></table></div></section><section class="grid cols-2 structured-audit"><article class="card accent-violet"><h3>💊 Charges sanitaires annuelles</h3><div class="field"><label>Fourchette</label><select data-econ="sanitaryRange"><option value="">Choisir…</option>${['< 2 000 €','2 000–5 000 €','5 000–10 000 €','10 000–20 000 €','> 20 000 €'].map(v=>`<option ${a.economics.sanitaryRange===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Somme exacte (€)</label><input type="number" data-econ="sanitaryAmount" value="${escapeHtml(a.economics.sanitaryAmount||'')}"></div><div class="field"><label>Précisions</label><textarea data-econ="sanitaryComment">${escapeHtml(a.economics.sanitaryComment||'')}</textarea></div></article><article class="card accent-amber"><h3>💶 Résultat économique annuel</h3><div class="field"><label>Indicateur</label><select data-econ="resultType"><option value="">Choisir…</option>${['EBE','Marge brute','Résultat courant','Résultat disponible','Autre'].map(v=>`<option ${a.economics.resultType===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Montant (€)</label><input type="number" data-econ="annualResult" value="${escapeHtml(a.economics.annualResult||'')}"></div><div class="field"><label>Commentaire</label><textarea data-econ="resultComment">${escapeHtml(a.economics.resultComment||'')}</textarea></div></article></section>${economicTable('purchase',a.purchases,purchaseProducts)}${economicTable('sale',a.sales,saleProducts)}<section class="card"><h3>Conclusion libre</h3><textarea id="audit-global-notes">${escapeHtml(a.notes||'')}</textarea></section>`;
let auditSaveTimer=null;
const refreshAuditProgressUi=()=>{const cc=auditCompletion(a),card=app.querySelector('.audit-progress-card');if(card){const span=card.querySelector('span'),bar=card.querySelector('.progress-track>div'),strong=card.querySelector(':scope > strong');if(span)span.textContent=`${cc.done}/${cc.total} éléments`;if(bar)bar.style.width=`${cc.pct}%`;if(strong)strong.textContent=`${cc.pct}%`;}auditGlobalSections.forEach(sec=>{const p=auditSectionProgress(sec,a),btn=app.querySelector(`[data-open-audit-section="${CSS.escape(sec.id)}"]`),det=app.querySelector(`[data-audit-section-id="${CSS.escape(sec.id)}"]`);if(btn){btn.classList.remove('state-complete','state-progress','state-empty');btn.classList.add(`state-${p.state}`);const sm=btn.querySelector('small'),em=btn.querySelector('em');if(sm)sm.textContent=`${p.done}/${p.total}`;if(em)em.style.width=`${p.pct}%`;}if(det){det.classList.remove('state-complete','state-progress','state-empty');det.classList.add(`state-${p.state}`);const ct=det.querySelector('.audit-count'),sm=det.querySelector('.audit-section-status small');if(ct)ct.textContent=`${p.done}/${p.total}`;if(sm)sm.textContent=p.state==='complete'?'✓ Terminé':p.state==='progress'?'En cours':'À commencer';}})};
const persistAuditNow=()=>{clearTimeout(auditSaveTimer);auditSaveTimer=null;saveAuditDraftLocal(visit,a);saveAuditGlobal(visit);refreshAuditProgressUi()};
const queueAuditSave=(delay=120)=>{saveAuditDraftLocal(visit,a);refreshAuditProgressUi();clearTimeout(auditSaveTimer);auditSaveTimer=setTimeout(persistAuditNow,delay)};
const flushAuditSave=()=>persistAuditNow();
const saveA=(q,f,v,immediate=false)=>{a.answers[q]=a.answers[q]||{};a.answers[q][f]=v;immediate?flushAuditSave():queueAuditSave()};
const bindAuditQuestionControls=(root)=>{
  root.querySelectorAll('[data-open-library-theme]').forEach(b=>b.onclick=()=>openLibraryTheme(b.dataset.openLibraryTheme));
  root.querySelectorAll('[data-audit-answer]').forEach(e=>{
    const update=()=>saveA(e.dataset.auditAnswer,'answer',e.value,false);
    e.addEventListener('input',update);
    e.addEventListener('change',()=>saveA(e.dataset.auditAnswer,'answer',e.value,true));
    e.addEventListener('blur',()=>saveA(e.dataset.auditAnswer,'answer',e.value,true));
  });
  root.querySelectorAll('[data-audit-multi]').forEach(e=>e.onchange=()=>{const q=e.dataset.auditMulti;a.answers[q]=a.answers[q]||{};a.answers[q].values=[...root.querySelectorAll(`[data-audit-multi="${CSS.escape(q)}"]:checked`)].map(x=>x.value);flushAuditSave()});
  root.querySelectorAll('[data-audit-comment]').forEach(e=>{e.oninput=()=>saveA(e.dataset.auditComment,'comment',e.value,false);e.onblur=()=>saveA(e.dataset.auditComment,'comment',e.value,true)});
  root.querySelectorAll('[data-summary]').forEach(e=>{e.oninput=()=>{a.chapterSummaries[e.dataset.summary]=a.chapterSummaries[e.dataset.summary]||{};a.chapterSummaries[e.dataset.summary][e.dataset.summaryField]=e.value;queueAuditSave()};e.onblur=flushAuditSave});
};
const loadAuditSection=(d)=>{if(!d||d.dataset.auditLoaded==='1')return;const sec=auditGlobalSections.find(x=>x.id===d.dataset.auditSectionId),box=d.querySelector('.audit-question-list');if(!sec||!box)return;box.innerHTML=sec.questions.map(q=>auditQuestionRow(q,a)).join('')+chapterSummaryHtml(sec.id,a);d.dataset.auditLoaded='1';bindAuditQuestionControls(box)};
app.querySelectorAll('.audit-section').forEach(d=>d.addEventListener('toggle',()=>{if(d.open)loadAuditSection(d)}));
document.getElementById('open-all-audit')?.addEventListener('click',()=>app.querySelectorAll('.audit-section').forEach(d=>{loadAuditSection(d);d.open=true}));
document.getElementById('close-all-audit')?.addEventListener('click',()=>app.querySelectorAll('.audit-section').forEach(d=>d.open=false));
app.querySelectorAll('[data-open-audit-section]').forEach(b=>b.onclick=()=>{const d=app.querySelector(`[data-audit-section-id="${CSS.escape(b.dataset.openAuditSection)}"]`);if(d){loadAuditSection(d);d.open=true;requestAnimationFrame(()=>d.scrollIntoView({behavior:'auto',block:'nearest'}));}});
window.addEventListener('pagehide',flushAuditSave,{once:true});document.getElementById('timeline-start-month').onchange=e=>{a.timelines.startMonth=e.target.value;saveAuditGlobal(visit);renderAuditGlobal()};app.querySelectorAll('[data-add-timeline]').forEach(b=>b.onclick=()=>{const k=b.dataset.addTimeline,type=app.querySelector(`[data-timeline-type="${k}"]`).value,start=app.querySelector(`[data-timeline-start="${k}"]`).value,end=app.querySelector(`[data-timeline-end="${k}"]`).value,comment=app.querySelector(`[data-timeline-comment="${k}"]`).value;a.timelines[k].push({id:uid('event'),type,start,end:end<start?start:end,comment});saveAuditGlobal(visit);renderAuditGlobal()});app.querySelectorAll('[data-delete-timeline]').forEach(b=>b.onclick=()=>{const k=b.dataset.deleteTimeline;a.timelines[k]=a.timelines[k].filter(x=>x.id!==b.dataset.id);saveAuditGlobal(visit);renderAuditGlobal()});app.querySelectorAll('[data-objective]').forEach(e=>e.onchange=()=>{a.organization.objectives=[...app.querySelectorAll('[data-objective]:checked')].map(x=>x.value);saveAuditGlobal(visit)});app.querySelectorAll('[data-org]').forEach(e=>{const s=()=>{a.organization[e.dataset.org]=e.value;saveAuditGlobal(visit)};e.addEventListener('input',s);e.addEventListener('change',s)});app.querySelectorAll('[data-renewal]').forEach(e=>{e.oninput=()=>{a.renewal[e.dataset.renewal]=e.value;saveAuditGlobal(visit)};e.onblur=()=>{}});app.querySelectorAll('[data-reform-reason]').forEach(e=>e.oninput=()=>{a.reforms.reasons[e.dataset.reformReason]=e.value;saveAuditGlobal(visit)});app.querySelector('[data-reform-comment]').oninput=e=>{a.reforms.comment=e.target.value;saveAuditGlobal(visit)};app.querySelectorAll('[data-mortality-count]').forEach(e=>e.oninput=()=>{a.mortality[e.dataset.mortalityCount].count=e.value;saveAuditGlobal(visit)});app.querySelectorAll('[data-mortality-cause]').forEach(e=>e.onchange=()=>{const c=e.dataset.mortalityCause;a.mortality[c].causes=[...app.querySelectorAll(`[data-mortality-cause="${CSS.escape(c)}"]:checked`)].map(x=>x.value);saveAuditGlobal(visit)});app.querySelectorAll('[data-mortality-comment]').forEach(e=>e.oninput=()=>{a.mortality[e.dataset.mortalityComment].comment=e.value;saveAuditGlobal(visit)});app.querySelectorAll('[data-econ]').forEach(e=>{const s=()=>{a.economics[e.dataset.econ]=e.value;saveAuditGlobal(visit)};e.addEventListener('input',s);e.addEventListener('change',s)});app.querySelectorAll('[data-add-economic]').forEach(b=>b.onclick=()=>{const k=b.dataset.addEconomic,arr=k==='purchase'?a.purchases:a.sales,p=k==='purchase'?purchaseProducts:saleProducts;arr.push({id:uid(k),product:p[0],unit:'t'});saveAuditGlobal(visit);renderAuditGlobal()});app.querySelectorAll('[data-economic-field]').forEach(e=>{const s=()=>{const arr=e.dataset.kind==='purchase'?a.purchases:a.sales,r=arr.find(x=>x.id===e.dataset.id);if(r){r[e.dataset.economicField]=e.value;saveAuditGlobal(visit)}};e.addEventListener('input',s);e.addEventListener('change',s);e.onblur=()=>{s();/* calcul actualisé à la prochaine ouverture pour éviter un rerendu lourd */}});app.querySelectorAll('[data-delete-economic]').forEach(b=>b.onclick=()=>{const arr=b.dataset.deleteEconomic==='purchase'?a.purchases:a.sales,i=arr.findIndex(x=>x.id===b.dataset.id);if(i>=0)arr.splice(i,1);saveAuditGlobal(visit);renderAuditGlobal()});document.getElementById('audit-global-notes').oninput=e=>{a.notes=e.target.value;saveAuditGlobal(visit)};document.getElementById('print-full-blank')?.addEventListener('click',()=>printAuditDocument(visit,'full-blank'));document.getElementById('print-analysis-blank')?.addEventListener('click',()=>printAuditDocument(visit,'analysis-blank'));document.getElementById('print-audit-blank')?.addEventListener('click',()=>printAuditDocument(visit,'audit-blank'));document.getElementById('print-audit-filled')?.addEventListener('click',()=>printAuditDocument(visit,'audit-filled'))}
function printBaseStyles(){return `body{font-family:Arial,sans-serif;color:#172033;margin:18px}h1{color:#b53670}h2{color:#8e2e5b;border-bottom:2px solid #efd5e1;padding-bottom:4px;page-break-after:avoid}h3{page-break-after:avoid}.print-note{background:#fff6fb;border:1px solid #e7bfd2;padding:8px;border-radius:7px;margin:8px 0}.source{display:inline-block;border-radius:10px;padding:2px 6px;font-size:8pt;margin-right:5px}.source.ask{background:#e8f1ff}.source.measure{background:#fff1d9}.source.later{background:#f1e7ff}.source.calc{background:#e5f7e8}.qid{font-size:7.5pt;color:#6d7280;font-family:monospace}.known{background:#eef9f0;border-left:4px solid #3c9b59;padding:5px 7px;margin:4px 0}.paper-choice{display:inline-block;margin:1px 8px 2px 0;white-space:nowrap}.paper-box{font-size:13pt;vertical-align:-1px}.write-line{min-height:20px;border-bottom:1px solid #9aa1ab;margin-top:4px}.comment-lines{height:34px;background:repeating-linear-gradient(to bottom,transparent 0,transparent 16px,#c5c8ce 17px)}table{width:100%;border-collapse:collapse;margin-bottom:18px}tr{page-break-inside:avoid}th,td{border:1px solid #aab5ad;padding:6px;vertical-align:top;font-size:9pt}th{background:#fbeaf2}.meta,.summary-print{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin:15px 0}.box{border:1px solid #aab5ad;padding:10px;min-height:44px}.blank-line{height:24px}.writing{min-height:40px}.checks{line-height:1.6}.landscape{font-size:7.6pt}.prelev-table td{height:24px}.prelev-head{background:#eef5ff}.prepared-tag{color:#267642;font-weight:bold}.page-break{page-break-before:always}@page{size:A4;margin:9mm}@media print{button{display:none}.landscape-page{page:landscape}}`}
function printChapter(id,a,filled){const s=filled?(a.chapterSummaries[id]||{}):{};return `<div class="summary-print"><div class="box"><b>Points forts</b><br>${escapeHtml(s.strengths||'')}</div><div class="box"><b>Points de vigilance</b><br>${escapeHtml(s.watch||'')}</div><div class="box"><b>Commentaires / pistes</b><br>${escapeHtml(s.comments||'')}</div></div>`}
function paperChoicesForQuestion(q,item,filled){
  const c=qConfig(q),vals=Array.isArray(item?.values)?item.values:[],answer=String(item?.answer||'');
  if(c.options?.length)return c.options.map(v=>{const checked=filled&&(vals.includes(v)||answer===v);return `<span class="paper-choice"><span class="paper-box">${checked?'☒':'☐'}</span> ${escapeHtml(v)}</span>`}).join(' ');
  if(c.type==='number')return `<span class="write-line">${filled&&answer?`<span class="prepared-tag">${escapeHtml(answer)} ${escapeHtml(c.unit||'')}</span>`:`Valeur : __________________ ${escapeHtml(c.unit||'')}`}</span>`;
  return `<div class="write-line">${filled&&answer?`<span class="prepared-tag">${escapeHtml(answer)}</span>`:''}</div>`;
}
function auditPrintHtml(visit,filled){
  const a=ensureAuditGlobal(visit);let qn=0;
  let h=`<div class="print-note"><b>Légende :</b> 💬 à demander / confirmer · 📏 à mesurer / relever · 📎 à récupérer / compléter après · 🧮 calculable si données disponibles. ${filled?'<br><b>Support préparé :</b> les informations déjà connues sont imprimées en vert ; les cases correspondantes sont cochées lorsque possible.':'<br><b>Modèle vierge :</b> aucune donnée exploitation n’est préremplie.'}</div>`;
  h+=auditGlobalSections.map(s=>`<h2>${s.icon} ${escapeHtml(s.title)}</h2>${s.questions.map((q,qi)=>{qn++;const m=auditQuestionSource(q),i=filled?(a.answers[q]||{}):{},derived=filled?preparedQuestionValue(visit,q):'',known=((i.values||[]).join(', ')||i.answer||derived||'');return `<div class="paper-q"><div><span class="source ${m.key}">${m.label}</span><span class="qid">${escapeHtml(s.id.toUpperCase())}-${String(qi+1).padStart(2,'0')}</span> <b>${escapeHtml(q)}</b></div>${known?`<div class="known">Déjà disponible : ${escapeHtml(known)}</div>`:''}<div class="checks">${paperChoicesForQuestion(q,i,filled)}</div><div class="comment-lines"></div></div>`}).join('')}${printChapter(s.id,a,filled)}`).join('');
  h+=structuredPrintHtml(a,filled);return h;
}
function printRows(rows,filled){const r=filled&&rows.length?rows:Array.from({length:8},()=>({}));return r.map(x=>`<tr><td>${escapeHtml(x.product||'')}</td><td>${escapeHtml(x.detail||'')}</td><td>${escapeHtml(x.quantity||'')}</td><td>${escapeHtml(x.unit||'')}</td><td>${escapeHtml(x.unitPrice||'')}</td><td>${escapeHtml(x.partner||'')}</td><td>${escapeHtml(x.comment||'')}</td></tr>`).join('')}
function structuredPrintHtml(a,filled){return `<h2>Structure du troupeau et renouvellement</h2><table><tbody>${[['cowsTotal','Vaches mères / production'],['cowsPregnant','Vaches pleines'],['cowsEmpty','Vaches vides'],['nurseCows','Tantes / nourrices'],['bulls','Taureaux reproducteurs'],['pregnantHeifers','Génisses pleines'],['heifers12_24','Génisses 12–24 mois'],['heifers6_12','Génisses 6–12 mois'],['calvesUnder6','Veaux < 6 mois'],['replacementHeifers','Génisses de renouvellement'],['annualReforms','Réformes annuelles']].map(([k,l])=>`<tr><th>${l}</th><td>${filled?escapeHtml(a.renewal[k]||''):''}</td></tr>`).join('')}</tbody></table><h2>Mortalité</h2><table><thead><tr><th>Classe</th><th>Nombre</th><th>Causes à cocher</th><th>Commentaire</th></tr></thead><tbody>${mortalityClasses.map(c=>{const r=a.mortality[c];return `<tr><td>${c}</td><td>${filled?escapeHtml(r.count||''):''}</td><td class="checks">${mortalityCauses.map(v=>`<span class="paper-choice">${filled&&r.causes.includes(v)?'☒':'☐'} ${v}</span>`).join(' ')}</td><td>${filled?escapeHtml(r.comment||''):''}</td></tr>`}).join('')}</tbody></table><h2>Achats</h2><table><thead><tr><th>Produit</th><th>Précision</th><th>Quantité</th><th>Unité</th><th>Tarif</th><th>Fournisseur</th><th>Commentaire</th></tr></thead><tbody>${printRows(a.purchases,filled)}</tbody></table><h2>Ventes / revenus</h2><table><thead><tr><th>Produit</th><th>Précision</th><th>Quantité</th><th>Unité</th><th>Tarif</th><th>Acheteur</th><th>Commentaire</th></tr></thead><tbody>${printRows(a.sales,filled)}</tbody></table>`}
function buildingPrintHtml(visit,filled){
  const audits=Object.values(visit.buildingAudits||{}),answers={};audits.forEach(a=>Object.entries(a.questionnaire||{}).forEach(([k,v])=>{if(!answers[k]||['À corriger','À surveiller'].includes(v?.status))answers[k]=v||{}}));
  return `<h2 class="page-break">🏠 Questionnaire bâtiment</h2><p class="print-note">Cases identiques à l’application afin de pouvoir cocher rapidement sur papier.</p>${buildingQuestionGroups.map(([group,qs])=>`<h3>${escapeHtml(group)}</h3><table><thead><tr><th>Point contrôlé</th><th>Évaluation</th><th>Commentaire</th></tr></thead><tbody>${qs.map((q,qi)=>{const x=filled?(answers[q]||{}):{};return `<tr><td><span class="qid">BAT-${normalizeSearchText(group).slice(0,4).toUpperCase()}-${String(qi+1).padStart(2,'0')}</span><br><b>${escapeHtml(q)}</b></td><td class="checks">${['Satisfaisant','À surveiller','À corriger','Non concerné'].map(v=>`<span class="paper-choice">${x.status===v?'☒':'☐'} ${v}</span>`).join('<br>')}</td><td>${filled?escapeHtml(x.comment||''):''}<div class="comment-lines"></div></td></tr>`}).join('')}</tbody></table>`).join('')}`;
}
function samplingPrintHtml(visit,filled){
  const subjects=filled?(visit.subjects||[]):[];
  const rows=(subjects.length?subjects:Array.from({length:18},()=>({}))).slice(0,30);
  return `<h2 class="page-break">🧪 Plan de prélèvements / mesures</h2><p class="print-note">Une ligne par animal ou lot. Cocher les prélèvements prévus/réalisés puis noter le numéro de tube/échantillon. Ces repères sont conçus pour faciliter la relecture/transcription automatique du support papier.</p><table class="prelev-table landscape"><thead><tr class="prelev-head"><th>N° travail / animal</th><th>Lot / catégorie</th><th>Urine</th><th>Sang</th><th>Bouses</th><th>Lait</th><th>Colostrum</th><th>Poils / autre</th><th>N° tube / échantillon</th><th>Observations</th></tr></thead><tbody>${rows.map((s,i)=>`<tr><td>${filled?escapeHtml(s.tag||s.workNumber||s.name||''):''}</td><td>${filled?escapeHtml(s.category||''):''}</td>${Array.from({length:6},()=>'<td>☐</td>').join('')}<td></td><td></td></tr>`).join('')}</tbody></table><h3>Grille complète des mesures animales</h3>${analysisPrintHtml(false)}`;
}
function analysisPrintHtml(compactTitle=true){return `${compactTitle?'<h2>📏 Grille des mesures animales</h2>':''}<div class="landscape-page"><table class="landscape"><thead><tr>${['Boucle / sujet','Emplacement','Catégorie','NEC','Coul. urine','pH U','Redox U','Brix U','Densité U','Gly','BOH','Urée','pH sang','Aspect bouses','pH B','Redox B','Muscles','Poils','Membres','SRR','Temp.','Commentaire'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${Array.from({length:20},()=>`<tr>${Array.from({length:22},()=>'<td class="blank-line"></td>').join('')}</tr>`).join('')}</tbody></table></div>`}
function feedingPrintHtml(visit=null,filled=false){const rows=filled&&visit?.feeding?.rations?.length?visit.feeding.rations:Array.from({length:18},()=>({}));return `<h2>🍽️ Alimentation / ration</h2><table><thead><tr>${['Catégorie','Type d’aliment','Nature / composition','Quantité','Unité','Distribution','Fréquence','Commentaire'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><td>${filled?escapeHtml(r.category||''):''}</td><td>${filled?escapeHtml(r.type||r.feedType||''):''}</td><td>${filled?escapeHtml(r.name||r.composition||''):''}</td><td>${filled?escapeHtml(r.quantity||''):''}</td><td>${filled?escapeHtml(r.unit||''):''}</td><td>${filled?escapeHtml(r.mode||r.distribution||''):''}</td><td>${filled?escapeHtml(r.frequency||''):''}</td><td>${filled?escapeHtml(r.comment||''):''}</td></tr>`).join('')}</tbody></table>`}
function fullVisitPaperHtml(visit,filled){return samplingPrintHtml(visit,filled)+feedingPrintHtml(visit,filled)+buildingPrintHtml(visit,filled)+auditPrintHtml(visit,filled)}
function printAuditDocument(visit,mode){const filled=mode==='audit-filled'||mode==='full-prepared';let title,content;if(mode==='full-blank'){title='Support papier complet vierge';content=fullVisitPaperHtml(visit,false)}else if(mode==='full-prepared'){title='Support papier complet préparé';content=fullVisitPaperHtml(visit,true)}else if(mode==='analysis-blank'){title='Grilles analyses vierges';content=samplingPrintHtml(visit,false)}else if(mode==='audit-blank'){title='Audit vierge';content=auditPrintHtml(visit,false)}else{title='Audit renseigné';content=auditPrintHtml(visit,true)}const w=window.open('','_blank');if(!w){showToast('Autorisez les fenêtres surgissantes.');return}w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${printBaseStyles()}</style></head><body><button onclick="window.print()">Imprimer / Enregistrer en PDF</button><h1>Audit Bovin GDS 32-65 — ${title}</h1><div class="meta"><div class="box"><b>Exploitation</b><br>${mode.includes('blank')?'':escapeHtml(farmName(visit.farmId))}</div><div class="box"><b>Date</b><br>${mode.includes('blank')?'':escapeHtml(formatDate(visit.date))}</div><div class="box"><b>Technicien</b><br>${mode.includes('blank')?'':escapeHtml(visit.technician||'')}</div></div>${content}</body></html>`);w.document.close()}
function printAuditGuide(visit,filled){printAuditDocument(visit,filled?'audit-filled':'audit-blank')}



function reportLines(value){
  return String(value||'').split(/\n|•|;/).map(x=>x.trim()).filter(Boolean);
}
function reportList(value, empty='Aucun élément renseigné.'){
  const items=reportLines(value);
  return items.length?`<ul>${items.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>`:`<p class="report-empty">${escapeHtml(empty)}</p>`;
}
function reportFarm(visit){return db.farms.find(f=>f.id===visit.farmId)||{};}
function reportMeta(visit){
  const farm=reportFarm(visit);
  return {farm:farm.name||'Exploitation non renseignée',farmer:farm.manager||farm.owner||'',date:formatDate(visit.date),technician:visit.technician||'',type:visit.type||'',location:farm.address||farm.city||''};
}
function reportStats(visit){
  const subjects=visit.subjects||[];
  const measured=subjects.filter(s=>Object.values(s.measurements?.analysis||{}).some(v=>v!==''&&v!==null&&v!==undefined)).length;
  const general=visit.analysisGeneral||{};
  return {subjects:subjects.length,measured,general:(general.tamis?.length||0)+(general.silos?.length||0)+(general.soils?.length||0)+(general.plants?.length||0)};
}

async function photoFileToDataUrl(file){
  const source=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=URL.createObjectURL(file);});
  const maxSide=1280,scale=Math.min(1,maxSide/Math.max(source.naturalWidth,source.naturalHeight));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(source.naturalWidth*scale));canvas.height=Math.max(1,Math.round(source.naturalHeight*scale));
  const ctx=canvas.getContext('2d');ctx.drawImage(source,0,0,canvas.width,canvas.height);URL.revokeObjectURL(source.src);
  return canvas.toDataURL('image/jpeg',0.72);
}
function photoSubjectLabel(visit,subjectId){const s=(visit.subjects||[]).find(x=>x.id===subjectId);return s?(s.identifier||s.name||s.category||'Sujet'):'Photo générale';}
function photoCardHtml(visit,photo){return `<article class="photo-card"><button class="photo-open" data-open-photo="${photo.id}" aria-label="Ouvrir la photo"><img src="${photo.dataUrl}" alt="${escapeHtml(photo.comment||'Photo de visite')}"></button><div class="photo-card-body"><div class="photo-meta"><strong>${escapeHtml(photoSubjectLabel(visit,photo.subjectId))}</strong><span>${formatDateTime(photo.createdAt)}</span></div><textarea data-photo-comment="${photo.id}" rows="2" placeholder="Commentaire de la photo">${escapeHtml(photo.comment||'')}</textarea><div class="actions"><button class="btn small" data-annotate-photo="${photo.id}">✏️ Annoter</button><button class="btn small danger" data-delete-photo="${photo.id}">Supprimer</button></div></div></article>`;}


// V11.9 — Suivi longitudinal et comparaison de plusieurs visites
function farmVisitsChronological(farmId){
  return db.visits.filter(v=>v.farmId===farmId).slice().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
}
function avgForVisit(visit,key,category=''){
  const values=(visit.subjects||[]).filter(s=>!category||s.category===category).map(s=>numericValue(s.measurements?.analysis?.[key])).filter(v=>v!==null);
  return values.length?{avg:values.reduce((a,b)=>a+b,0)/values.length,n:values.length,min:Math.min(...values),max:Math.max(...values)}:null;
}
function followupFmt(v,key){if(v===null||v===undefined)return '—';const p=['urineDensity','urineRedox','fecesRedox','colostrumDensity'].includes(key)?0:2;return Number(v).toLocaleString('fr-FR',{maximumFractionDigits:p});}
function followupTrend(first,last){
  if(first===null||last===null)return {icon:'—',label:'Non comparable',cls:'neutral'};
  const d=last-first, tolerance=Math.max(Math.abs(first)*0.03,0.02);
  if(Math.abs(d)<=tolerance)return {icon:'→',label:'Stable',cls:'stable'};
  return d>0?{icon:'↗',label:'En hausse',cls:'up'}:{icon:'↘',label:'En baisse',cls:'down'};
}
function sparklineSvg(points){
  const vals=points.filter(v=>v!==null);if(vals.length<2)return '<span class="muted">Données insuffisantes</span>';
  const min=Math.min(...vals),max=Math.max(...vals),span=max-min||1,w=160,h=42,p=5;
  const coords=points.map((v,i)=>v===null?null:[p+i*(w-2*p)/Math.max(1,points.length-1),h-p-(v-min)*(h-2*p)/span]);
  const segments=[];let current=[];coords.forEach(pt=>{if(pt)current.push(pt);else if(current.length){segments.push(current);current=[]}});if(current.length)segments.push(current);
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" role="img" aria-label="Courbe d’évolution">${segments.map(seg=>`<polyline points="${seg.map(x=>x.join(',')).join(' ')}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}${coords.filter(Boolean).map(pt=>`<circle cx="${pt[0]}" cy="${pt[1]}" r="2.6" fill="currentColor"/>`).join('')}</svg>`;
}
function normalizedTag(tag){return String(tag||'').toUpperCase().replace(/[^A-Z0-9]/g,'');}
function individualFollowupRows(visits,key){
  const map=new Map();visits.forEach(v=>(v.subjects||[]).forEach(s=>{const tag=normalizedTag(s.tag);const val=numericValue(s.measurements?.analysis?.[key]);if(!tag||val===null)return;if(!map.has(tag))map.set(tag,{tag:s.tag||tag,values:new Array(visits.length).fill(null)});map.get(tag).values[visits.indexOf(v)]=val;}));
  return [...map.values()].filter(x=>x.values.filter(v=>v!==null).length>=2);
}

function visitReproductionSnapshot(visit){
  const farm=db.farms.find(f=>f.id===visit?.farmId);if(!visit||!farm)return {};
  const source=reproductionSourceForVisit(visit,farm),original=farm.herdRegistry;farm.herdRegistry=source.registry||[];
  const today=visit.date||new Date().toISOString().slice(0,10),registry=farm.herdRegistry||[],cows=currentReproductionCows(farm,today),present=registry.filter(a=>a.sex==='F'&&isRegistryAnimalPresent(a,today));
  const cowIds=new Set(cows.map(r=>normalizeAnimalId(r.cow.id))),breedingFemales=present.filter(a=>monthsBetweenDates(a.birthDate,today)>24),heifers=breedingFemales.filter(a=>!cowIds.has(normalizeAnimalId(a.id)));
  const allIvvs=cows.flatMap(r=>r.intervals),firstIvvs=cows.map(r=>r.intervals[0]).filter(x=>x!=null),calves=cows.flatMap(r=>r.calves),dead=calves.filter(c=>c.exitCause==='M'&&c.exitDate&&daysBetweenDates(c.birthDate,c.exitDate)<183);
  const firstAges=cows.map(r=>r.firstCalvingAgeMonths).filter(x=>x!=null),cowAges=cows.map(r=>monthsBetweenDates(r.cow.birthDate,today)).filter(x=>x!=null),ivvCows=cows.filter(r=>r.meanIVV!=null);
  const maleIds=new Set(registry.filter(a=>a.sex==='M').map(a=>normalizeAnimalId(a.id)));const knownFather=calves.filter(c=>c.fatherId);const probableIA=knownFather.filter(c=>!maleIds.has(normalizeAnimalId(c.fatherId))).length;
  const primiparous=cows.filter(r=>r.calves.length===1),yearAgo=new Date(today+'T12:00:00');yearAgo.setFullYear(yearAgo.getFullYear()-1);const yearAgoIso=yearAgo.toISOString().slice(0,10);
  const calvesLast12=calves.filter(c=>c.birthDate>=yearAgoIso&&c.birthDate<=today),calvedLast12=new Set(calvesLast12.map(c=>normalizeAnimalId(c.motherId))).size;
  const a=ensureAuditGlobal(visit),mortTotal=Object.values(a.mortality||{}).reduce((n,x)=>n+(Number(x?.count)||0),0),rr=renewalRate(a.renewal),rf=reformRate(a.renewal);
  farm.herdRegistry=original;
  return {ivvMean:allIvvs.length?Math.round(allIvvs.reduce((x,y)=>x+y,0)/allIvvs.length):null,ivv12:firstIvvs.length?Math.round(firstIvvs.reduce((x,y)=>x+y,0)/firstIvvs.length):null,ivvLe400:allIvvs.filter(x=>x<=400).length,ivv401450:allIvvs.filter(x=>x>400&&x<=450).length,ivv451500:allIvvs.filter(x=>x>450&&x<=500).length,ivvOver500:allIvvs.filter(x=>x>500).length,ivvOver410Rate:ivvCows.length?Math.round(ivvCows.filter(r=>r.meanIVV>410).length/ivvCows.length*1000)/10:null,firstCalvingAgeMean:firstAges.length?Math.round(firstAges.reduce((x,y)=>x+y,0)/firstAges.length*10)/10:null,meanCowAgeYears:cowAges.length?Math.round(cowAges.reduce((x,y)=>x+y,0)/cowAges.length/12*10)/10:null,cows:cows.length,withoutCalving:heifers.length,calves:calves.length,birthsLast12:calvesLast12.length,deadCalves:dead.length,calfMortalityRate:calves.length?Math.round(dead.length/calves.length*1000)/10:null,probableIA:knownFather.length?probableIA:null,probableIARate:knownFather.length?Math.round(probableIA/knownFather.length*1000)/10:null,calvingRate:breedingFemales.length?Math.round(calvedLast12/breedingFemales.length*1000)/10:null,primiparous:primiparous.length,primiparousRate:cows.length?Math.round(primiparous.length/cows.length*1000)/10:null,renewalRate:rr,reformRate:rf,mortalityTotal:mortTotal};
}
function compareScalarRows(selected){
 const defs=[['Reproduction','Taux de vêlage (12 mois)','calvingRate','%'],['Reproduction','Primipares','primiparous',''],['Reproduction','Part de primipares','primiparousRate','%'],['Reproduction','IVV moyen','ivvMean','j'],['Reproduction','IVV1–IVV2 moyen','ivv12','j'],['Reproduction','IVV ≤ 400 j','ivvLe400',''],['Reproduction','IVV 401–450 j','ivv401450',''],['Reproduction','IVV 451–500 j','ivv451500',''],['Reproduction','IVV > 500 j','ivvOver500',''],['Reproduction','Femelles > 24 mois sans vêlage','withoutCalving',''],['Reproduction','Veaux probablement issus d’IA','probableIA',''],['Reproduction','Part probable IA','probableIARate','%'],['Reproduction','Mortalité veaux < 6 mois','calfMortalityRate','%'],['Troupeau','Taux de renouvellement','renewalRate','%'],['Troupeau','Taux de réforme','reformRate','%'],['Mortalité','Mortalité totale saisie','mortalityTotal','']];
 const snaps=selected.map(visitReproductionSnapshot);return defs.map(([group,label,key,unit])=>({group,label,values:snaps.map(x=>x[key]??null),unit}));
}
function visitTextSummary(visit,type){
 if(type==='feeding')return (visit.feeding?.rations||[]).map(r=>[r.category,r.nature||r.detail,r.quantity,r.unit].filter(Boolean).join(' ')).join(' · ');
 if(type==='building'){const r=buildingRecords(visit);return `${r.drinkers.length} abreuvoir(s) · ${r.electric.length} mesure(s) électrique(s) · ${r.litters.length} zone(s) litière`;}
 if(type==='actions'){const c=ensureVisitConclusion(visit);return (c.priorities||[]).filter(x=>x.text).map(x=>`${x.text}${x.decision?' ('+x.decision+')':''}`).join(' · ');}
 return '';
}
function renderFollowup(){
  const defaultFarm=activeVisit()?.farmId||db.farms[0]?.id||'';
  const farmId=localStorage.getItem('audit-bovin-followup-farm')||defaultFarm;
  const visits=farmVisitsChronological(farmId);
  let selectedIds=JSON.parse(localStorage.getItem('audit-bovin-followup-visits')||'[]').filter(id=>visits.some(v=>v.id===id));
  if(!selectedIds.length&&visits.length)selectedIds=visits.slice(-2).map(v=>v.id);
  const selected=visits.filter(v=>selectedIds.includes(v.id)).slice(-2);
  const category=localStorage.getItem('audit-bovin-followup-category')||'';
  const availableCats=[...new Set(visits.flatMap(v=>(v.subjects||[]).map(s=>s.category).filter(c=>c&&c!=='Non classé')))].sort();
  const measureRows=analysisParameters.map(param=>{const stats=selected.map(v=>avgForVisit(v,param.key,category));const vals=stats.map(x=>x?.avg??null);if(!vals.some(v=>v!==null))return'';const d=vals.length===2&&vals[0]!=null&&vals[1]!=null?Math.round((vals[1]-vals[0])*100)/100:null;return `<tr><td><strong>${escapeHtml(param.label)}</strong><br><small>${escapeHtml(param.group)}</small></td>${stats.map(x=>`<td>${x?`<strong>${followupFmt(x.avg,param.key)}</strong><br><small>n=${x.n} · ${followupFmt(x.min,param.key)}–${followupFmt(x.max,param.key)}</small>`:'—'}</td>`).join('')}<td>${d==null?'—':(d>0?'+':'')+d}</td></tr>`}).join('');
  const scalarRows=compareScalarRows(selected);
  const grouped=[...new Set(scalarRows.map(r=>r.group))].map(g=>`<section class="card"><h3>${escapeHtml(g)}</h3><div class="table-wrap"><table class="followup-table"><thead><tr><th>Indicateur</th>${selected.map(v=>`<th>${formatDate(v.date)}</th>`).join('')}<th>Écart</th></tr></thead><tbody>${scalarRows.filter(r=>r.group===g).map(r=>{const a=r.values[0],b=r.values[1],d=a!=null&&b!=null?Math.round((b-a)*10)/10:null;return `<tr><td><strong>${escapeHtml(r.label)}</strong></td>${r.values.map(v=>`<td>${v==null?'—':v+' '+r.unit}</td>`).join('')}<td><span class="trend-badge ${d==null?'stable':d>0?'up':d<0?'down':'stable'}">${d==null?'—':(d>0?'+':'')+d+' '+r.unit}</span></td></tr>`}).join('')}</tbody></table></div></section>`).join('');
  app.innerHTML=`<div class="section-title"><div><h2>Historique & évolution</h2><div class="muted">Comparer deux visites d’une même exploitation : reproduction, mortalité, mesures, alimentation, bâtiment et plans d’action.</div></div><span class="badge autosave">v14.6.21.68</span></div>
  <section class="card followup-filters"><div class="grid cols-2"><div class="field"><label>Exploitation</label><select id="followup-farm">${db.farms.map(f=>`<option value="${f.id}" ${f.id===farmId?'selected':''}>${escapeHtml(f.name)}</option>`).join('')}</select></div><div class="field"><label>Catégorie pour les mesures</label><select id="followup-category"><option value="">Toutes les catégories</option>${availableCats.map(c=>`<option ${c===category?'selected':''}>${escapeHtml(c)}</option>`).join('')}</select></div></div><div class="followup-visit-picker"><strong>Sélectionner exactement deux visites</strong>${visits.length?visits.map(v=>`<label><input type="checkbox" data-followup-visit value="${v.id}" ${selectedIds.includes(v.id)?'checked':''}><span>${formatDate(v.date)} · ${escapeHtml(v.type||'Visite')} · ${(v.subjects||[]).length} sujet(s)</span></label>`).join(''):'<div class="empty">Cette exploitation ne possède aucune visite.</div>'}</div></section>
  ${selected.length!==2?'<section class="card notice warning"><strong>Sélectionnez exactement deux visites.</strong><br><span class="muted">Décochez ou cochez les visites souhaitées.</span></section>':`${grouped}<section class="card"><div class="section-title"><h3>Mesures biologiques et terrain</h3><button class="btn secondary" id="print-followup">Imprimer / PDF</button></div><div class="table-wrap"><table class="followup-table"><thead><tr><th>Mesure</th>${selected.map(v=>`<th>${formatDate(v.date)}</th>`).join('')}<th>Écart</th></tr></thead><tbody>${measureRows||'<tr><td colspan="4">Aucune mesure comparable.</td></tr>'}</tbody></table></div></section><section class="grid cols-3 comparison-text-grid"><article class="card"><h3>🥣 Alimentation</h3>${selected.map(v=>`<h4>${formatDate(v.date)}</h4><p>${escapeHtml(visitTextSummary(v,'feeding')||'Aucune ration renseignée.')}</p>`).join('')}</article><article class="card"><h3>🏠 Bâtiment</h3>${selected.map(v=>`<h4>${formatDate(v.date)}</h4><p>${escapeHtml(visitTextSummary(v,'building'))}</p>`).join('')}</article><article class="card"><h3>📋 Plan d’action</h3>${selected.map(v=>`<h4>${formatDate(v.date)}</h4><p>${escapeHtml(visitTextSummary(v,'actions')||'Aucune priorité renseignée.')}</p>`).join('')}</article></section>`}`;
  document.getElementById('followup-farm')?.addEventListener('change',e=>{localStorage.setItem('audit-bovin-followup-farm',e.target.value);localStorage.removeItem('audit-bovin-followup-visits');renderFollowup()});
  document.getElementById('followup-category')?.addEventListener('change',e=>{localStorage.setItem('audit-bovin-followup-category',e.target.value);renderFollowup()});
  app.querySelectorAll('[data-followup-visit]').forEach(e=>e.onchange=()=>{let ids=[...app.querySelectorAll('[data-followup-visit]:checked')].map(x=>x.value);if(ids.length>2){e.checked=false;showToast('Deux visites maximum.');ids=[...app.querySelectorAll('[data-followup-visit]:checked')].map(x=>x.value);}localStorage.setItem('audit-bovin-followup-visits',JSON.stringify(ids));renderFollowup()});
  document.getElementById('print-followup')?.addEventListener('click',()=>window.print());
}


// V14.6.21.32 — Profil métabolique & parasitisme
const METABOLIC_KNOWLEDGE={
  cuivre:{label:'Cuivre (Cu)',aliases:['cuivre','cu'],impacts:['Immunité et résistance aux infections','Fertilité / reproduction','Hématopoïèse et risque d’anémie','Qualité du poil et pigmentation'],checks:['Apport réel du minéral','Molybdène, soufre et fer : antagonismes possibles','Analyse de ration / fourrages','Consommation effective des compléments'],corrections:['Vérifier l’apport et la forme du cuivre dans la ration','Rechercher et corriger les antagonismes avant de simplement augmenter la dose','Valider la stratégie de complémentation avec vétérinaire / nutritionniste'],caution:'Le cuivre sanguin reflète imparfaitement les réserves : le contexte, le foie et les antagonistes sont essentiels.'},
  selenium:{label:'Sélénium (Se)',aliases:['selenium','sélénium','se'],impacts:['Défenses antioxydantes','Immunité','Reproduction / délivrance','Fonction musculaire, notamment chez les veaux'],checks:['Statut vitamine E','Apport minéral réel','Historique de veaux faibles / myopathies','Ration et distribution'],corrections:['Revoir la complémentation Se + vitamine E dans son ensemble','Éviter toute supplémentation empirique excessive : marge de sécurité limitée','Valider dose et forme avec vétérinaire / nutritionniste'],caution:'Interpréter conjointement avec la vitamine E et le contexte clinique.'},
  zinc:{label:'Zinc (Zn)',aliases:['zinc','zn'],impacts:['Peau, poils et onglons','Cicatrisation','Immunité','Fertilité et croissance'],checks:['Apport du minéral','Interactions avec fer/calcium selon ration','État des pieds et de la peau','Consommation du complément'],corrections:['Vérifier la couverture de ration et la biodisponibilité','Corriger les facteurs limitant la consommation du minéral','Recontrôler après correction si le contexte le justifie'],caution:'Les signes sont peu spécifiques : toujours croiser avec ration et clinique.'},
  iode:{label:'Iode (I)',aliases:['iode','iodine','i'],impacts:['Fonction thyroïdienne','Fertilité','Vigueur des nouveau-nés','Risque de goitre en déficit marqué'],checks:['Sel iodé / minéral','Plantes ou facteurs goitrogènes','Reproduction et vigueur des veaux','Apports réels'],corrections:['Vérifier la source iodée et la consommation','Éviter la sur-correction sans bilan de ration','Validation nutritionnelle / vétérinaire'],caution:'Le biomarqueur et le type de prélèvement doivent être pris en compte.'},
  cobalt:{label:'Cobalt (Co)',aliases:['cobalt','co'],impacts:['Précurseur indispensable à la synthèse ruminale de vitamine B12','Appétit et croissance','Métabolisme énergétique','État général'],checks:['Apport cobalt du minéral','Qualité / origine des fourrages','Croissance et NEC','Statut B12 si dosé séparément'],corrections:['Revoir la couverture en cobalt et la distribution minérale','Croiser avec ration et performances','Valider la correction avec nutritionniste / vétérinaire'],caution:'Le cobalt et la vitamine B12 sont liés physiologiquement mais sont deux analytes distincts : ils ont désormais leurs propres unités et seuils.'},
  vitB12:{label:'Vitamine B12 (cobalamine)',aliases:['b12','vitamine b12','cobalamine'],impacts:['Métabolisme énergétique','Appétit et croissance','Fonction hématopoïétique','État général'],checks:['Statut cobalt','Type de prélèvement et méthode du laboratoire','Croissance / état corporel','Contexte hépatique et digestif'],corrections:['Interpréter séparément du cobalt tout en recherchant une cohérence entre les deux','Vérifier ration et complémentation','Valider la correction avec vétérinaire / nutritionniste'],caution:'La B12 sanguine ne doit pas être assimilée automatiquement au cobalt alimentaire ; utiliser les références propres au laboratoire.'},
  manganese:{label:'Manganèse (Mn)',aliases:['manganese','manganèse','mn'],impacts:['Fertilité','Développement osseux','Croissance','Fonctions enzymatiques'],checks:['Minéral distribué','Ration totale','Performances de reproduction','Croissance des jeunes'],corrections:['Vérifier couverture et disponibilité du manganèse','Ne pas conclure sur un signe isolé','Valider la correction nutritionnelle'],caution:'Les signes cliniques sont peu spécifiques.'},
  fer:{label:'Fer (Fe)',aliases:['fer','iron','fe'],impacts:['Hémoglobine / anémie en déficit','Un excès peut interférer avec le statut cuivre'],checks:['Inflammation / maladie concomitante','Qualité de l’eau et du sol','Cuivre associé','Hémogramme si pertinent'],corrections:['Ne pas supplémenter automatiquement sur une valeur sérique basse','Rechercher inflammation, pertes ou défaut d’apport','Si élevé, rechercher la source et les antagonismes'],caution:'Le fer sérique peut varier avec l’inflammation et ne traduit pas toujours les réserves.'},
  vitA:{label:'Vitamine A',aliases:['vitamine a','vit a','retinol','rétinol'],impacts:['Épithéliums et muqueuses','Immunité','Reproduction','Vision / développement'],checks:['Qualité et conservation des fourrages','Complément vitaminé','Durée de stockage','Signes cliniques compatibles'],corrections:['Vérifier ration et complément vitaminé','Adapter la stratégie aux fourrages et au stade physiologique','Éviter les surdosages'],caution:'Interpréter selon le laboratoire et le type de dosage.'},
  vitE:{label:'Vitamine E',aliases:['vitamine e','vit e','tocopherol','tocophérol'],impacts:['Antioxydant majeur','Immunité','Fonction musculaire','Reproduction'],checks:['Sélénium associé','Conservation des fourrages','Apport du complément','Veaux faibles / troubles musculaires'],corrections:['Raisonner vitamine E et sélénium ensemble','Revoir les apports et la conservation des aliments','Valider la complémentation'],caution:'Le statut doit être rapproché du sélénium.'},
  calcium:{label:'Calcium (Ca)',aliases:['calcium','ca'],impacts:['Fonction neuromusculaire','Péri-partum','Santé osseuse'],checks:['Stade physiologique','BACA / ration de préparation vêlage','Magnésium associé','Apport et absorption'],corrections:['Raisonner avec la ration et le stade','En péri-partum, intégrer BACA et magnésium','Validation vétérinaire en cas d’hypocalcémie clinique'],caution:'Les valeurs sanguines sont très régulées et doivent être interprétées dans le contexte.'},
  magnesium:{label:'Magnésium (Mg)',aliases:['magnesium','magnésium','mg'],impacts:['Fonction neuromusculaire','Risque de tétanie en déficit'],checks:['Herbe jeune / potassium élevé','Apport minéral','Saison et pâturage'],corrections:['Vérifier l’apport et les facteurs limitant l’absorption','Adapter la complémentation au pâturage'],caution:'Une situation clinique aiguë nécessite une prise en charge vétérinaire.'},
  phosphore:{label:'Phosphore (P)',aliases:['phosphore','phosphorus','p'],impacts:['Métabolisme énergétique','Os','Croissance et reproduction'],checks:['Rapport Ca/P','Ration et analyses fourrages','Consommation réelle'],corrections:['Raisonner le phosphore avec calcium et ration complète','Éviter la supplémentation systématique sans calcul de ration'],caution:'Le résultat isolé ne suffit pas à conclure sur les apports.'}
};
function metabolicKey(name=''){const n=normalizeCsvHeader(name);for(const [k,x] of Object.entries(METABOLIC_KNOWLEDGE)){if(x.aliases.some(a=>{const aa=normalizeCsvHeader(a);return n===aa||n.includes(aa)}))return k;}return ''}
function ensureMetabolic(visit){visit.metabolicProfile=visit.metabolicProfile&&typeof visit.metabolicProfile==='object'?visit.metabolicProfile:{lab:'',date:'',sampleType:'Sérum',category:'',notes:'',rows:[],sourceFile:'',importedAt:''};visit.metabolicProfile.rows=Array.isArray(visit.metabolicProfile.rows)?visit.metabolicProfile.rows:[];return visit.metabolicProfile}
function metabolicLabProfiles(){return ensureReferenceSettings().metabolicLabs;}function metabolicLabById(id){return metabolicLabProfiles().find(x=>x.id===id)||null;}function metabolicLabReference(lab,analyte,sampleType){if(!lab)return null;const key=metabolicKey(analyte),sample=normalizeSearchText(sampleType||''),refs=Array.isArray(lab.references)?lab.references:[];return refs.find(r=>metabolicKey(r.analyte)===key&&(!r.sampleType||normalizeSearchText(r.sampleType)===sample))||refs.find(r=>metabolicKey(r.analyte)===key)||null;}function applyMetabolicLabReference(row,lab,sampleType){const ref=metabolicLabReference(lab,row.analyte,sampleType);if(!ref)return false;row.unit=ref.unit||row.unit||'';row.refMin=ref.refMin??'';row.refMax=ref.refMax??'';row.referenceSource=lab.name||'';row.referenceUpdatedAt=lab.updatedAt||'';return true;}function applyMetabolicLabToRows(m,onlyBlank=false){const lab=metabolicLabById(m.labId);if(!lab)return 0;let n=0;(m.rows||[]).forEach(r=>{if(onlyBlank&&(r.unit||r.refMin||r.refMax))return;if(applyMetabolicLabReference(r,lab,m.sampleType))n++;});m.lab=lab.name;return n;}

function metabolicStatus(row){const v=parseFrenchNumber(row.value),lo=parseFrenchNumber(row.refMin),hi=parseFrenchNumber(row.refMax);if(row.labStatus&&row.labStatus!=='auto')return row.labStatus;if(v===null)return 'non-classe';if(lo!==null&&v<lo)return 'bas';if(hi!==null&&v>hi)return 'haut';if(lo!==null||hi!==null)return 'normal';return 'non-classe'}
function metabolicStatusBadge(s){return s==='bas'?'<span class="result-chip result-red">🔴 Bas</span>':s==='haut'?'<span class="result-chip result-orange">🟠 Haut</span>':s==='normal'?'<span class="result-chip result-green">🟢 Dans le repère labo</span>':'<span class="result-chip">⚪ À interpréter</span>'}
function metabolicSummary(visit){const m=ensureMetabolic(visit),by={};m.rows.forEach(r=>{const key=metabolicKey(r.analyte)||normalizeCsvHeader(r.analyte)||'autre',status=metabolicStatus(r);by[key]=by[key]||{key,label:METABOLIC_KNOWLEDGE[key]?.label||r.analyte||'Autre',low:0,normal:0,high:0,unclassified:0,rows:[]};by[key].rows.push(r);if(status==='bas')by[key].low++;else if(status==='haut')by[key].high++;else if(status==='normal')by[key].normal++;else by[key].unclassified++;});return Object.values(by)}
function metabolicInterpretationHtml(item){const k=METABOLIC_KNOWLEDGE[item.key];if(!k)return `<div class="notice"><strong>${escapeHtml(item.label)}</strong><br><span class="muted">Pas de fiche d’interprétation intégrée : utilisez les références et commentaires du laboratoire.</span></div>`;const abnormal=item.low||item.high;return `<article class="interpret-card ${item.low?'danger':item.high?'warning':'positive'}"><div class="section-title"><div><h4>${escapeHtml(k.label)}</h4><span class="muted">${item.low} bas · ${item.normal} dans le repère · ${item.high} haut · ${item.unclassified} non classé(s)</span></div>${item.low?'<span class="badge danger">Déficit possible</span>':item.high?'<span class="badge warning">Excès / déséquilibre possible</span>':'<span class="badge complete">Pas de déficit objectivé</span>'}</div>${abnormal?`<div class="grid cols-3"><div><strong>Impacts possibles</strong><ul>${k.impacts.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div><div><strong>À rechercher</strong><ul>${k.checks.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div><div><strong>Corrections possibles</strong><ul>${k.corrections.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div></div>`:''}<p class="muted small-text">⚠️ ${escapeHtml(k.caution)}</p></article>`}
function metabolicRowHtml(r){const st=metabolicStatus(r);return `<tr data-met-id="${r.id}"><td><input data-met-field="animal" value="${escapeHtml(r.animal||'')}" placeholder="N° / lot"></td><td><input list="met-analytes" data-met-field="analyte" value="${escapeHtml(r.analyte||'')}" placeholder="Cuivre, Se…"></td><td><input inputmode="decimal" data-met-field="value" value="${escapeHtml(r.value||'')}"></td><td><input data-met-field="unit" value="${escapeHtml(r.unit||'')}" placeholder="µmol/L…"></td><td><input inputmode="decimal" data-met-field="refMin" value="${escapeHtml(r.refMin||'')}" placeholder="min"></td><td><input inputmode="decimal" data-met-field="refMax" value="${escapeHtml(r.refMax||'')}" placeholder="max"></td><td><select data-met-field="labStatus"><option value="auto" ${(!r.labStatus||r.labStatus==='auto')?'selected':''}>Auto selon bornes</option><option value="bas" ${r.labStatus==='bas'?'selected':''}>Bas</option><option value="normal" ${r.labStatus==='normal'?'selected':''}>Normal</option><option value="haut" ${r.labStatus==='haut'?'selected':''}>Haut</option><option value="non-classe" ${r.labStatus==='non-classe'?'selected':''}>Non classé</option></select><div>${metabolicStatusBadge(st)}</div></td><td><button class="btn small danger" data-met-delete="${r.id}">×</button></td></tr>`}
function metabolicPaperPreset(m,preset='essential'){
 const essential=['Cuivre (Cu)','Sélénium (Se)','Zinc (Zn)','Iode (I)','Cobalt (Co)','Vitamine B12 (cobalamine)','Manganèse (Mn)','Fer (Fe)','Vitamine A','Vitamine E'];
 const macro=['Calcium (Ca)','Magnésium (Mg)','Phosphore (P)'];
 const list=preset==='macro'?macro:preset==='complete'?[...essential,...macro]:essential;
 const subject=(m.paperSubject||m.category||'').trim();
 list.forEach(analyte=>{const exists=m.rows.some(r=>normalizeCsvHeader(r.analyte)===normalizeCsvHeader(analyte)&&normalizeCsvHeader(r.animal||'')===normalizeCsvHeader(subject));if(!exists)m.rows.push({id:uid('met'),animal:subject,analyte,value:'',unit:'',refMin:'',refMax:'',labStatus:'auto'});});
}
function applyMetabolicPaperSubject(m){const subject=(document.getElementById('met-paper-subject')?.value||'').trim();m.paperSubject=subject;if(subject)m.rows.forEach(r=>{if(!String(r.animal||'').trim())r.animal=subject;});}
function renderMetabolic(){const visit=activeVisit();if(!visit){renderNoActiveVisit('Profil métabolique');return;}const m=ensureMetabolic(visit),sum=metabolicSummary(visit);app.innerHTML=`<div class="section-title"><div><h2>🧬 Profil métabolique — oligo-éléments & vitamines</h2><div class="muted">Saisie rapide depuis un compte rendu papier, lecture selon les références du laboratoire, impacts et pistes de correction.</div></div><span class="badge autosave">v14.6.21.68</span></div>${activeVisitBanner(visit)}<section class="card notice warning"><strong>Principe d’interprétation</strong><br>Choisissez un laboratoire enregistré pour reprendre automatiquement ses unités et seuils. Sinon, saisissez les bornes du compte rendu ou le statut donné par le labo. Les seuils utilisés sont conservés dans chaque analyse historique.</section><section class="card"><div class="grid cols-4"><div class="field"><label>Laboratoire</label><select id="met-lab-id"><option value="">Références internes / saisie manuelle</option>${metabolicLabProfiles().map(l=>`<option value="${l.id}" ${m.labId===l.id?'selected':''}>${escapeHtml(l.name)}</option>`).join('')}</select><small class="muted">Unités et seuils repris automatiquement du labo sélectionné.</small></div><div class="field"><label>Date d’analyse</label><input id="met-date" type="date" value="${escapeHtml(m.date||'')}"></div><div class="field"><label>Type de prélèvement</label><select id="met-sample">${['Sérum','Plasma','Sang total','Foie','Autre'].map(x=>`<option ${m.sampleType===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Catégorie / lot</label><input id="met-category" value="${escapeHtml(m.category||'')}"></div></div><div class="paper-entry-box"><div class="paper-entry-head"><div><strong>📝 Saisie rapide depuis le résultat papier</strong><div class="muted small-text">Préparez toutes les lignes d’un clic, puis recopiez simplement les valeurs et les références indiquées par le laboratoire.</div></div></div><div class="grid cols-3 paper-entry-controls"><div class="field"><label>N° animal / lot à appliquer</label><input id="met-paper-subject" value="${escapeHtml(m.paperSubject||m.category||'')}" placeholder="ex. lot taries / 4123"></div><div class="actions"><button class="btn primary" id="met-paper-essential">Oligos + vitamines</button><button class="btn secondary" id="met-paper-complete">Profil complet + Ca/Mg/P</button></div><div class="actions"><button class="btn secondary" id="met-apply-subject">Appliquer le n°/lot aux lignes vides</button><button class="btn" id="met-go-summary">Analyser le profil ↓</button></div></div></div><div class="actions"><button class="btn secondary" id="met-add">+ Ajouter un autre dosage</button><button class="btn secondary" id="met-apply-lab">↻ Appliquer les seuils du labo</button><button class="btn" id="met-open-references">⚙️ Gérer laboratoires & seuils</button><details class="advanced-import"><summary>Options avancées / import CSV</summary><div class="actions"><button class="btn secondary" id="met-import">Importer CSV</button><input id="met-file" type="file" accept=".csv,text/csv" hidden></div><p class="muted small-text">CSV : Animal/Lot ; Paramètre ; Valeur ; Unité ; Réf min ; Réf max ; Statut.</p></details></div></section><datalist id="met-analytes">${Object.values(METABOLIC_KNOWLEDGE).map(x=>`<option value="${escapeHtml(x.label)}">`).join('')}</datalist><section class="card" id="met-results"><h3>Résultats</h3><div class="paper-tip">💡 Si le laboratoire indique seulement « bas / normal / haut », laissez les bornes vides et choisissez directement l’interprétation labo dans la colonne Lecture.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Animal / lot</th><th>Paramètre</th><th>Valeur</th><th>Unité</th><th>Réf min</th><th>Réf max</th><th>Lecture</th><th></th></tr></thead><tbody>${m.rows.length?m.rows.map(metabolicRowHtml).join(''):'<tr><td colspan="8" class="empty">Aucun résultat saisi.</td></tr>'}</tbody></table></div></section><section class="card" id="met-summary"><div class="section-title"><div><h3>Synthèse & impacts possibles</h3><span class="muted">Regroupement de tous les animaux / lots saisis.</span></div></div><div class="interpret-list">${sum.length?sum.map(metabolicInterpretationHtml).join(''):'<div class="empty">Ajoutez les résultats pour générer la synthèse.</div>'}</div></section><section class="card"><div class="field"><label>Commentaire / conclusion technicien</label><textarea id="met-notes" rows="4">${escapeHtml(m.notes||'')}</textarea></div></section>`;
 const saveMeta=()=>{m.labId=document.getElementById('met-lab-id')?.value||'';m.lab=metabolicLabById(m.labId)?.name||m.lab||'';m.date=document.getElementById('met-date').value;m.sampleType=document.getElementById('met-sample').value;m.category=document.getElementById('met-category').value;m.notes=document.getElementById('met-notes').value;visit.updatedAt=new Date().toISOString();saveDatabase(db)};['met-date','met-sample','met-category','met-notes'].forEach(id=>{const e=document.getElementById(id);if(e){e.onchange=saveMeta;e.oninput=saveMeta}});document.getElementById('met-lab-id')?.addEventListener('change',e=>{m.labId=e.target.value;m.lab=metabolicLabById(m.labId)?.name||'';applyMetabolicLabToRows(m,true);saveDatabase(db);renderMetabolic()});document.getElementById('met-apply-lab')?.addEventListener('click',()=>{const n=applyMetabolicLabToRows(m,false);saveDatabase(db);showToast(n?`${n} ligne(s) mises à jour avec les références du laboratoire.`:'Aucune référence correspondante trouvée.');renderMetabolic()});document.getElementById('met-open-references')?.addEventListener('click',()=>setView('references'));document.getElementById('met-add').onclick=()=>{m.rows.push({id:uid('met'),animal:'',analyte:'',value:'',unit:'',refMin:'',refMax:'',labStatus:'auto'});saveDatabase(db);renderMetabolic()};document.getElementById('met-paper-essential')?.addEventListener('click',()=>{m.paperSubject=document.getElementById('met-paper-subject')?.value||'';metabolicPaperPreset(m,'essential');saveDatabase(db);renderMetabolic();setTimeout(()=>document.getElementById('met-results')?.scrollIntoView({behavior:'smooth',block:'start'}),50)});document.getElementById('met-paper-complete')?.addEventListener('click',()=>{m.paperSubject=document.getElementById('met-paper-subject')?.value||'';metabolicPaperPreset(m,'complete');saveDatabase(db);renderMetabolic();setTimeout(()=>document.getElementById('met-results')?.scrollIntoView({behavior:'smooth',block:'start'}),50)});document.getElementById('met-apply-subject')?.addEventListener('click',()=>{applyMetabolicPaperSubject(m);saveDatabase(db);renderMetabolic()});document.getElementById('met-go-summary')?.addEventListener('click',()=>{applyMetabolicPaperSubject(m);saveDatabase(db);renderMetabolic();setTimeout(()=>document.getElementById('met-summary')?.scrollIntoView({behavior:'smooth',block:'start'}),50)});document.getElementById('met-paper-subject')?.addEventListener('input',e=>{m.paperSubject=e.target.value;saveDatabase(db)});app.querySelectorAll('[data-met-field]').forEach(el=>{const go=()=>{const r=m.rows.find(x=>x.id===el.closest('tr').dataset.metId);if(r){r[el.dataset.metField]=el.value;if(el.dataset.metField==='analyte'&&m.labId)applyMetabolicLabReference(r,metabolicLabById(m.labId),m.sampleType);visit.updatedAt=new Date().toISOString();saveDatabase(db)}};el.onchange=()=>{go();renderMetabolic()};el.oninput=go});app.querySelectorAll('[data-met-delete]').forEach(b=>b.onclick=()=>{m.rows=m.rows.filter(x=>x.id!==b.dataset.metDelete);saveDatabase(db);renderMetabolic()});document.getElementById('met-import').onclick=()=>document.getElementById('met-file').click();document.getElementById('met-file').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const rows=parseCsvText(await f.text());for(const row of rows){const l=rowLookup(row),analyte=l.exact('Paramètre','Parametre','Analyte','Élément','Element','Dosage');if(!analyte)continue;m.rows.push({id:uid('met'),animal:l.exact('Animal','N° animal','Numero animal','Lot','Sujet'),analyte,value:l.exact('Valeur','Résultat','Resultat'),unit:l.exact('Unité','Unite'),refMin:l.exact('Réf min','Ref min','Minimum','Borne basse'),refMax:l.exact('Réf max','Ref max','Maximum','Borne haute'),labStatus:(()=>{const x=normalizeCsvHeader(l.exact('Statut','Interprétation','Interpretation'));return x.includes('bas')?'bas':x.includes('haut')?'haut':x.includes('normal')?'normal':'auto'})()});}m.sourceFile=f.name;m.importedAt=new Date().toISOString();saveDatabase(db);showToast(`${m.rows.length} résultat(s) disponible(s).`);renderMetabolic()}catch(err){showToast('Import impossible : '+err.message)}};document.getElementById('pep-add')?.addEventListener('click',()=>{p.pepsinogen.push({id:uid('pep'),animal:'',value:''});saveDatabase(db);renderParasitism()});app.querySelectorAll('[data-pep-field]').forEach(el=>{const f=()=>{const r=p.pepsinogen.find(x=>x.id===el.closest('[data-pep-id]').dataset.pepId);r[el.dataset.pepField]=el.value;saveDatabase(db)};el.oninput=f;el.onchange=f});app.querySelectorAll('[data-pep-del]').forEach(b=>b.onclick=()=>{p.pepsinogen=p.pepsinogen.filter(x=>x.id!==b.dataset.pepDel);saveDatabase(db);renderParasitism()});document.getElementById('sero-add')?.addEventListener('click',()=>{p.serologies.push({id:uid('sero'),animal:'',count:'',result:'Négatif'});saveDatabase(db);renderParasitism()});app.querySelectorAll('[data-sero-field]').forEach(el=>{const f=()=>{const r=p.serologies.find(x=>x.id===el.closest('[data-sero-id]').dataset.seroId);r[el.dataset.seroField]=el.value;saveDatabase(db)};el.oninput=f;el.onchange=f});app.querySelectorAll('[data-sero-del]').forEach(b=>b.onclick=()=>{p.serologies=p.serologies.filter(x=>x.id!==b.dataset.seroDel);saveDatabase(db);renderParasitism()})}

const PARASITE_KNOWLEDGE={
 strongyles:{label:'Strongles digestifs',aliases:['strongles digestifs','strongles gastro','strongyle'],impacts:['Baisse de croissance','Moindre valorisation alimentaire','Perte d’état / NEC','Diarrhée possible'],checks:['Âge et immunité du lot','Pâturage / saison','Dernier traitement, famille et date','Poids réellement utilisé pour le dosage'],molecules:[['Éprinomectine','EPRINEX Pour-On, EPRIZERO — exemples AMM France'],['Ivermectine','IVOMEC Pour-On, VIRBAMEC — exemples AMM France'],['Fenbendazole','PANACUR 10 % — exemple AMM France'],['Lévamisole','LEVASOLE 20 — exemple AMM France']],note:'Le comptage d’œufs ne doit pas être le seul critère de traitement. Rechercher une résistance si l’efficacité clinique ou le test de réduction est insuffisant.'},
 dictyocaulus:{label:'Strongle pulmonaire / Dictyocaulus',aliases:['dictyocaulus','strongle pulmonaire','lungworm'],impacts:['Toux','Dyspnée / atteinte respiratoire','Baisse de croissance','Risque clinique parfois rapide'],checks:['Toux au pâturage','Résultat Baermann / PCR selon labo','Historique de vaccination / traitement','Gravité clinique'],molecules:[['Éprinomectine','EPRINEX Pour-On — exemple AMM France'],['Ivermectine','IVOMEC Pour-On — exemple AMM France'],['Fenbendazole','PANACUR 10 % — exemple AMM France'],['Lévamisole','LEVASOLE 20 — exemple AMM France']],note:'Un animal dyspnéique ou fortement atteint nécessite une appréciation vétérinaire rapide.'},
 fasciola:{label:'Grande douve / Fasciola hepatica',aliases:['fasciola','grande douve','douve du foie'],impacts:['Baisse d’état et de performances','Atteinte hépatique','Anémie / hypoalbuminémie possibles','Impact indirect sur reproduction'],checks:['Prairies humides / zones à limnées','Stade de l’infestation','Type de test : copro, sérologie, antigène','Historique des traitements fasciolicides'],molecules:[['Triclabendazole','FASCINEX 240 — exemple AMM France'],['Clorsulone + ivermectine','IVOMEC D — exemple AMM France pour infestations mixtes selon RCP']],note:'Une copro négative n’exclut pas une infestation prépatente. Le choix dépend notamment des stades à cibler et du RCP.'},
 paramphistomes:{label:'Paramphistomes',aliases:['paramphistome','paramphistomum'],impacts:['Souvent peu de signes chez l’adulte','Formes immatures potentiellement digestives','Diarrhée / amaigrissement selon contexte'],checks:['Âge et signes cliniques','Charge et méthode labo','Co-infestation par douve','Zones humides'],molecules:[],note:'Le choix thérapeutique est spécifique : ne pas extrapoler automatiquement les molécules actives sur la grande douve. Validation vétérinaire recommandée.'},
 coccidies:{label:'Coccidies / Eimeria',aliases:['coccidie','eimeria'],impacts:['Diarrhée chez les jeunes','Retard de croissance','Déshydratation / douleur digestive','Contamination environnementale'],checks:['Âge des veaux','Espèces Eimeria pathogènes si identifiées','Historique clinique du lot','Humidité, densité, hygiène des cases'],molecules:[['Toltrazuril','BAYCOX MULTI 50 mg/mL — exemple AMM France, indications préventives précises selon RCP'],['Diclazuril','COCCIRIL 2,5 mg/mL — exemple AMM France, prévention chez le veau selon RCP']],note:'Le nombre d’oocystes seul ne suffit pas à diagnostiquer une coccidiose clinique. Les RCP précisent âge, contexte et conditions d’emploi.'},
 crypto:{label:'Cryptosporidium',aliases:['cryptosporidium','crypto'],impacts:['Diarrhée néonatale','Déshydratation','Retard de croissance','Forte contamination de l’environnement'],checks:['Âge du veau','Autres agents de diarrhée','Colostrum / hygiène','Déshydratation et état général'],molecules:[],note:'Priorité à la prise en charge du veau, à l’hydratation et à la maîtrise environnementale ; le traitement doit suivre l’avis vétérinaire et le RCP.'}
};
function parasiteKey(name=''){const n=normalizeCsvHeader(name);for(const [k,x] of Object.entries(PARASITE_KNOWLEDGE)){if(x.aliases.some(a=>n.includes(normalizeCsvHeader(a))))return k;}return ''}
function ensureParasitism(visit){visit.parasitism=visit.parasitism&&typeof visit.parasitism==='object'?visit.parasitism:{labId:'',lab:'',date:'',category:'',pasture:'',symptoms:'',lastTreatment:'',lastMolecule:'',notes:'',rows:[],pepsinogen:[],serologies:[],fecrt:{before:'',after:'',days:'14'}};visit.parasitism.rows=Array.isArray(visit.parasitism.rows)?visit.parasitism.rows:[];visit.parasitism.pepsinogen=Array.isArray(visit.parasitism.pepsinogen)?visit.parasitism.pepsinogen:[];visit.parasitism.serologies=Array.isArray(visit.parasitism.serologies)?visit.parasitism.serologies:[];visit.parasitism.fecrt=visit.parasitism.fecrt||{before:'',after:'',days:'14'};return visit.parasitism}
function parasiteStatus(r){if(r.labStatus&&r.labStatus!=='auto')return r.labStatus;const key=parasiteKey(r.parasite),n=parseFrenchNumber(r.value),text=normalizeCsvHeader(r.value);if(/negatif|absence|non detecte/.test(text))return 'negatif';if(/positif|detecte|presence/.test(text))return 'positif';if(key==='strongyles'&&n!==null){if(n<200)return 'faible';if(n<=500)return 'modere';return 'eleve'}if(n!==null&&n>0)return 'positif';return 'non-classe'}
function parasiteStatusBadge(s){return s==='negatif'?'<span class="result-chip result-green">🟢 Négatif</span>':s==='faible'?'<span class="result-chip result-green">🟢 Faible</span>':s==='modere'?'<span class="result-chip result-orange">🟠 Modéré</span>':s==='eleve'?'<span class="result-chip result-red">🔴 Élevé</span>':s==='positif'?'<span class="result-chip result-orange">🟠 Positif</span>':'<span class="result-chip">⚪ À contextualiser</span>'}
function parasiteSummary(visit){const p=ensureParasitism(visit),by={};p.rows.forEach(r=>{const key=parasiteKey(r.parasite)||'autre',st=parasiteStatus(r);by[key]=by[key]||{key,label:PARASITE_KNOWLEDGE[key]?.label||r.parasite||'Autre',rows:[],statuses:[]};by[key].rows.push(r);by[key].statuses.push(st)});return Object.values(by)}
function parasiteInterpretationHtml(item){const k=PARASITE_KNOWLEDGE[item.key],sev=item.statuses.includes('eleve')||item.statuses.includes('positif')?'warning':item.statuses.includes('modere')?'warning':'positive';if(!k)return `<div class="notice"><strong>${escapeHtml(item.label)}</strong><br>Résultat à interpréter avec le laboratoire et le vétérinaire.</div>`;return `<article class="interpret-card ${sev}"><div class="section-title"><div><h4>${escapeHtml(k.label)}</h4><span class="muted">${item.rows.length} résultat(s) · ${item.statuses.map(x=>x).join(', ')}</span></div></div><div class="grid cols-3"><div><strong>Impacts possibles</strong><ul>${k.impacts.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div><div><strong>À vérifier avant décision</strong><ul>${k.checks.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div><div><strong>Molécules / exemples de produits</strong>${k.molecules.length?`<ul>${k.molecules.map(([m,p])=>`<li><strong>${escapeHtml(m)}</strong><br><span class="muted">${escapeHtml(p)}</span></li>`).join('')}</ul>`:'<p class="muted">Pas de proposition automatique pour ce parasite.</p>'}</div></div><p class="notice warning small-text"><strong>⚠️ Aide au choix, pas une prescription.</strong> ${escapeHtml(k.note)} Vérifier systématiquement le RCP ANMV à jour, le statut lait/viande, les délais d’attente, contre-indications et traitements précédents.</p></article>`}
function fecrtValue(p){const a=parseFrenchNumber(p.fecrt.before),b=parseFrenchNumber(p.fecrt.after);return a!==null&&a>0&&b!==null?Math.round((1-b/a)*1000)/10:null}
function parasitismPaperPreset(p,preset='standard'){
 const presets={standard:['Strongles digestifs','Grande douve / Fasciola hepatica','Paramphistomes','Coccidies / Eimeria'],veaux:['Coccidies / Eimeria','Cryptosporidium','Strongles digestifs'],complete:['Strongles digestifs','Strongle pulmonaire / Dictyocaulus','Grande douve / Fasciola hepatica','Paramphistomes','Coccidies / Eimeria','Cryptosporidium']};
 const list=presets[preset]||presets.standard, subject=(p.paperSubject||p.category||'').trim();
 list.forEach(parasite=>{const exists=p.rows.some(r=>normalizeCsvHeader(r.parasite)===normalizeCsvHeader(parasite)&&normalizeCsvHeader(r.animal||'')===normalizeCsvHeader(subject));if(!exists)p.rows.push({id:uid('par'),animal:subject,parasite,value:'',unit:parasite==='Strongles digestifs'?'OPG':'',labStatus:'auto'});});
}
function applyParasitismPaperSubject(p){const subject=(document.getElementById('par-paper-subject')?.value||'').trim();p.paperSubject=subject;if(subject)p.rows.forEach(r=>{if(!String(r.animal||'').trim())r.animal=subject;});}
function renderParasitism(){const visit=activeVisit();if(!visit){renderNoActiveVisit('Parasitisme');return;}const p=ensureParasitism(visit),sum=parasiteSummary(visit),fe=fecrtValue(p);app.innerHTML=`<div class="section-title"><div><h2>🦠 Parasitisme</h2><div class="muted">Recopie rapide d’un résultat papier, contexte d’élevage, impact probable, familles de molécules et contrôle d’efficacité.</div></div><span class="badge autosave">v14.6.21.68</span></div>${activeVisitBanner(visit)}<section class="card notice warning"><strong>Important</strong><br>Le module aide au raisonnement. Le choix final du médicament, de la dose et du protocole doit respecter le RCP à jour et, lorsqu’il s’agit d’un médicament soumis à ordonnance, la prescription vétérinaire. Les noms commerciaux ci-dessous sont des exemples de spécialités autorisées en France vérifiées dans l’index ANMV en août 2026.</section><section class="card"><div class="grid cols-4"><div class="field"><label>Laboratoire</label><input id="par-lab" value="${escapeHtml(p.lab||'')}"></div><div class="field"><label>Date</label><input id="par-date" type="date" value="${escapeHtml(p.date||'')}"></div><div class="field"><label>Catégorie / lot</label><input id="par-category" value="${escapeHtml(p.category||'')}"></div><div class="field"><label>Pâturage / contexte</label><input id="par-pasture" value="${escapeHtml(p.pasture||'')}"></div></div><div class="grid cols-2"><div class="field"><label>Signes observés</label><textarea id="par-symptoms" rows="2">${escapeHtml(p.symptoms||'')}</textarea></div><div class="field"><label>Dernier antiparasitaire : date / molécule</label><div class="row"><input id="par-last-treatment" type="date" value="${escapeHtml(p.lastTreatment||'')}"><input id="par-last-molecule" value="${escapeHtml(p.lastMolecule||'')}" placeholder="Ivermectine, fenbendazole…"></div></div></div><div class="paper-entry-box"><div class="paper-entry-head"><div><strong>📝 Saisie rapide depuis la feuille du laboratoire</strong><div class="muted small-text">Choisissez le type de bilan : les lignes usuelles sont préparées automatiquement.</div></div></div><div class="grid cols-3 paper-entry-controls"><div class="field"><label>Animal / lot à appliquer</label><input id="par-paper-subject" value="${escapeHtml(p.paperSubject||p.category||'')}" placeholder="ex. génisses 12–18 mois"></div><div class="actions"><button class="btn primary" id="par-paper-standard">Copro standard</button><button class="btn secondary" id="par-paper-calves">Veaux</button><button class="btn secondary" id="par-paper-complete">Bilan complet</button></div><div class="actions"><button class="btn secondary" id="par-apply-subject">Appliquer le lot aux lignes vides</button><button class="btn" id="par-go-summary">Analyser ↓</button></div></div></div><div class="actions"><button class="btn secondary" id="par-add">+ Ajouter un autre résultat</button><details class="advanced-import"><summary>Options avancées / import CSV</summary><div class="actions"><button class="btn secondary" id="par-import">Importer CSV</button><input id="par-file" type="file" accept=".csv,text/csv" hidden></div></details></div></section><section class="card" id="par-results"><h3>Résultats parasitologiques</h3><div class="paper-tip">💡 Vous pouvez saisir un chiffre (ex. OPG), « positif / négatif », ou utiliser directement l’interprétation du laboratoire.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Animal / lot</th><th>Parasite / test</th><th>Résultat</th><th>Unité</th><th>Interprétation labo</th><th>Lecture</th><th></th></tr></thead><tbody>${p.rows.length?p.rows.map(r=>`<tr data-par-id="${r.id}"><td><input data-par-field="animal" value="${escapeHtml(r.animal||'')}" placeholder="lot / n°"></td><td><select data-par-field="parasite"><option value="">Choisir…</option>${Object.values(PARASITE_KNOWLEDGE).map(x=>`<option ${r.parasite===x.label?'selected':''}>${escapeHtml(x.label)}</option>`).join('')}<option ${r.parasite&&!parasiteKey(r.parasite)?'selected':''}>${r.parasite&&!parasiteKey(r.parasite)?escapeHtml(r.parasite):'Autre'}</option></select></td><td><input data-par-field="value" value="${escapeHtml(r.value||'')}" placeholder="OPG / positif…"></td><td><input data-par-field="unit" value="${escapeHtml(r.unit||'')}" placeholder="OPG"></td><td><select data-par-field="labStatus"><option value="auto" ${(!r.labStatus||r.labStatus==='auto')?'selected':''}>Auto</option>${[['negatif','Négatif'],['faible','Faible'],['modere','Modéré'],['eleve','Élevé'],['positif','Positif'],['non-classe','Non classé']].map(([v,l])=>`<option value="${v}" ${r.labStatus===v?'selected':''}>${l}</option>`).join('')}</select></td><td>${parasiteStatusBadge(parasiteStatus(r))}</td><td><button class="btn small danger" data-par-delete="${r.id}">×</button></td></tr>`).join(''):'<tr><td colspan="7" class="empty">Aucun résultat saisi.</td></tr>'}</tbody></table></div><p class="muted small-text">Pour les strongles digestifs uniquement, le repère interne d’affichage OPG est : &lt;200 faible, 200–500 modéré, &gt;500 élevé. Il sert au tri et doit être contextualisé par âge, saison, clinique et méthode du laboratoire.</p></section><section class="card"><h3>Contrôle d’efficacité — réduction d’excrétion</h3><div class="grid cols-4"><div class="field"><label>OPG avant</label><input id="fe-before" inputmode="numeric" value="${escapeHtml(p.fecrt.before||'')}"></div><div class="field"><label>OPG après</label><input id="fe-after" inputmode="numeric" value="${escapeHtml(p.fecrt.after||'')}"></div><div class="field"><label>Jours après traitement</label><input id="fe-days" inputmode="numeric" value="${escapeHtml(p.fecrt.days||'14')}"></div><div class="calculated-box"><span>Réduction calculée</span><strong>${fe===null?'—':fe+' %'}</strong></div></div>${fe!==null?`<div class="notice ${fe>=95?'positive':fe>=90?'warning':'warning'}"><strong>${fe>=95?'Réduction élevée':fe>=90?'Réduction à interpréter':'Efficacité potentiellement insuffisante à investiguer'}</strong><br><span class="muted">Ce calcul simple doit être interprété selon protocole, parasite, molécule et recommandations vétérinaires.</span></div>`:''}</section><section class="card"><div class="section-title"><div><h3>🩸 Pepsinogène sérique</h3><span class="muted">Labocéa : repère normal indiqué sur le rapport fourni 300–600 mUT.</span></div><button class="btn secondary" id="pep-add">+ Dosage</button></div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Animal</th><th>Résultat mUT</th><th>Lecture</th><th></th></tr></thead><tbody>${(p.pepsinogen||[]).map(r=>{const v=parseFrenchNumber(r.value),st=v===null?'non classé':v<300?'bas':v<=600?'normal':'élevé';return `<tr data-pep-id="${r.id}"><td><input data-pep-field="animal" value="${escapeHtml(r.animal||'')}"></td><td><input data-pep-field="value" value="${escapeHtml(r.value||'')}" inputmode="decimal"></td><td><span class="badge ${st==='normal'?'complete':st==='élevé'?'warning':''}">${st}</span></td><td><button class="btn danger small" data-pep-del="${r.id}">×</button></td></tr>`}).join('')||'<tr><td colspan="4" class="empty">Aucun dosage.</td></tr>'}</tbody></table></div></section><section class="card"><div class="section-title"><div><h3>🧪 Sérologie grande douve</h3><span class="muted">Fasciola hepatica : individuel ou mélange, résultat Négatif / Douteux / Positif / Ininterprétable.</span></div><button class="btn secondary" id="sero-add">+ Sérologie</button></div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Animal / mélange</th><th>Nb animaux</th><th>Résultat</th><th></th></tr></thead><tbody>${(p.serologies||[]).map(r=>`<tr data-sero-id="${r.id}"><td><input data-sero-field="animal" value="${escapeHtml(r.animal||'')}"></td><td><input data-sero-field="count" value="${escapeHtml(r.count||'')}" inputmode="numeric"></td><td><select data-sero-field="result">${['Négatif','Douteux','Positif','Ininterprétable'].map(x=>`<option ${r.result===x?'selected':''}>${x}</option>`).join('')}</select></td><td><button class="btn danger small" data-sero-del="${r.id}">×</button></td></tr>`).join('')||'<tr><td colspan="4" class="empty">Aucune sérologie.</td></tr>'}</tbody></table></div></section><section class="card" id="par-summary"><h3>Synthèse, impacts et options thérapeutiques</h3><div class="interpret-list">${sum.length?sum.map(parasiteInterpretationHtml).join(''):'<div class="empty">Ajoutez les résultats pour générer la synthèse.</div>'}</div></section><section class="card"><div class="field"><label>Commentaire / conclusion technicien</label><textarea id="par-notes" rows="4">${escapeHtml(p.notes||'')}</textarea></div></section>`;
 const save=()=>{p.lab=document.getElementById('par-lab').value;p.date=document.getElementById('par-date').value;p.category=document.getElementById('par-category').value;p.pasture=document.getElementById('par-pasture').value;p.symptoms=document.getElementById('par-symptoms').value;p.lastTreatment=document.getElementById('par-last-treatment').value;p.lastMolecule=document.getElementById('par-last-molecule').value;p.notes=document.getElementById('par-notes').value;p.fecrt.before=document.getElementById('fe-before').value;p.fecrt.after=document.getElementById('fe-after').value;p.fecrt.days=document.getElementById('fe-days').value;visit.updatedAt=new Date().toISOString();saveDatabase(db)};['par-lab','par-date','par-category','par-pasture','par-symptoms','par-last-treatment','par-last-molecule','par-notes','fe-before','fe-after','fe-days'].forEach(id=>{const e=document.getElementById(id);if(e){e.oninput=save;e.onchange=()=>{save();if(id.startsWith('fe-'))renderParasitism()}}});document.getElementById('par-add').onclick=()=>{p.rows.push({id:uid('par'),animal:'',parasite:'Strongles digestifs',value:'',unit:'OPG',labStatus:'auto'});saveDatabase(db);renderParasitism()};document.getElementById('par-paper-standard')?.addEventListener('click',()=>{p.paperSubject=document.getElementById('par-paper-subject')?.value||'';parasitismPaperPreset(p,'standard');saveDatabase(db);renderParasitism();setTimeout(()=>document.getElementById('par-results')?.scrollIntoView({behavior:'smooth',block:'start'}),50)});document.getElementById('par-paper-calves')?.addEventListener('click',()=>{p.paperSubject=document.getElementById('par-paper-subject')?.value||'';parasitismPaperPreset(p,'veaux');saveDatabase(db);renderParasitism();setTimeout(()=>document.getElementById('par-results')?.scrollIntoView({behavior:'smooth',block:'start'}),50)});document.getElementById('par-paper-complete')?.addEventListener('click',()=>{p.paperSubject=document.getElementById('par-paper-subject')?.value||'';parasitismPaperPreset(p,'complete');saveDatabase(db);renderParasitism();setTimeout(()=>document.getElementById('par-results')?.scrollIntoView({behavior:'smooth',block:'start'}),50)});document.getElementById('par-apply-subject')?.addEventListener('click',()=>{applyParasitismPaperSubject(p);saveDatabase(db);renderParasitism()});document.getElementById('par-go-summary')?.addEventListener('click',()=>{applyParasitismPaperSubject(p);saveDatabase(db);renderParasitism();setTimeout(()=>document.getElementById('par-summary')?.scrollIntoView({behavior:'smooth',block:'start'}),50)});document.getElementById('par-paper-subject')?.addEventListener('input',e=>{p.paperSubject=e.target.value;saveDatabase(db)});app.querySelectorAll('[data-par-field]').forEach(el=>{const saveRow=()=>{const r=p.rows.find(x=>x.id===el.closest('tr').dataset.parId);if(r){r[el.dataset.parField]=el.value;saveDatabase(db)}};el.oninput=saveRow;el.onchange=()=>{saveRow();renderParasitism()}});app.querySelectorAll('[data-par-delete]').forEach(b=>b.onclick=()=>{p.rows=p.rows.filter(x=>x.id!==b.dataset.parDelete);saveDatabase(db);renderParasitism()});document.getElementById('par-import').onclick=()=>document.getElementById('par-file').click();document.getElementById('par-file').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{for(const row of parseCsvText(await f.text())){const l=rowLookup(row),parasite=l.exact('Parasite','Analyse','Paramètre','Parametre','Test');if(!parasite)continue;p.rows.push({id:uid('par'),animal:l.exact('Animal','N° animal','Lot','Sujet'),parasite,value:l.exact('Résultat','Resultat','Valeur','OPG'),unit:l.exact('Unité','Unite')||(/opg/i.test(JSON.stringify(row))?'OPG':''),labStatus:(()=>{const x=normalizeCsvHeader(l.exact('Statut','Interprétation','Interpretation'));return x.includes('negatif')?'negatif':x.includes('faible')?'faible':x.includes('modere')?'modere':x.includes('eleve')?'eleve':x.includes('positif')?'positif':'auto'})()})}saveDatabase(db);renderParasitism();showToast('Analyse parasitaire importée.')}catch(err){showToast('Import impossible : '+err.message)}}}

const WATER_INTERNAL_REFS={
  ph:{label:'pH',unit:'',bovine:[5.5,8.5],ovine:[6,7]}, conductivity:{label:'Conductivité',unit:'µS/cm',min:200,max:1100}, hardness:{label:'Dureté',unit:'°f',min:2,max:25}, redox:{label:'Redox',unit:'mV',min:0,max:350}, nitrates:{label:'Nitrates',unit:'mg/L',max:50}, iron:{label:'Fer',unit:'µg/L',max:200}, manganese:{label:'Manganèse',unit:'µg/L',max:50}, chlorine:{label:'Chlore',unit:'ppm',max:0.1}, ammonium:{label:'Ammonium',unit:'mg/L',max:0.10}, ecoli:{label:'Escherichia coli',unit:'UFC/100mL',max:0}, entero:{label:'Entérocoques intestinaux',unit:'UFC/100mL',max:0}, coliforms:{label:'Coliformes totaux',unit:'UFC/100mL',max:0}, flora22:{label:'Flore totale 22°C',unit:'UFC/mL',max:10}, flora37:{label:'Flore totale 37°C',unit:'UFC/mL',max:100}, tds:{label:'Matières totales dissoutes (TDS)',unit:'mg/L',max:1000}
};
function ensureWaterLab(visit){visit.waterLab=visit.waterLab&&typeof visit.waterLab==='object'?visit.waterLab:{labId:'',lab:'',date:'',source:'',treated:'',notes:'',points:[]};visit.waterLab.points=Array.isArray(visit.waterLab.points)?visit.waterLab.points:[];return visit.waterLab}
function waterKey(name=''){const n=normalizeCsvHeader(name);const map={ph:['ph'],conductivity:['conductiv'],hardness:['durete','th'],redox:['redox'],nitrates:['nitrate'],nitrites:['nitrite'],iron:['fer'],manganese:['manganese'],chlorine:['chlore'],ammonium:['ammonium'],ecoli:['escherichia','e coli','ecoli'],entero:['enterocoque'],coliforms:['coliform'],flora22:['22'],flora37:['36','37'],tds:['tds','matieres totales dissoutes'],turbidity:['turbid'],asr:['asr','anaerobies sulfito']};for(const [k,a] of Object.entries(map))if(a.some(x=>n.includes(normalizeCsvHeader(x))))return k;return n}
function waterStatus(r){const v=parseFrenchNumber(r.value);if(v===null)return 'non classé';const ref=WATER_INTERNAL_REFS[waterKey(r.parameter)];if(!ref)return 'à interpréter';if(ref.min!=null&&v<ref.min)return 'à surveiller';if(ref.max!=null&&v>ref.max)return 'hors repère';if(ref.bovine&&(v<ref.bovine[0]||v>ref.bovine[1]))return 'hors repère';return 'dans le repère'}
function linkedTerrainWater(visit){const a=ensureBuildingAudit(visit);return (a.drinkers||[]).map(d=>({id:d.id,name:d.name||'Point eau',ph:d.ph,redox:d.redox,conductivity:d.conductivity,nitrates:d.nitrates,origin:d.origin}))}
function renderWaterLab(){const visit=activeVisit();if(!visit){renderNoActiveVisit('Analyse d’eau');return;}const w=ensureWaterLab(visit),labs=ensureReferenceSettings().waterLabs||[],terrain=linkedTerrainWater(visit);app.innerHTML=`<div class="section-title"><div><h2>💧 Analyse d’eau — laboratoire & mesures terrain</h2><div class="muted">Croisement des résultats laboratoire avec pH, redox, conductivité et nitrates mesurés sur place.</div></div><span class="badge autosave">v14.6.21.68</span></div>${activeVisitBanner(visit)}<section class="card"><div class="grid cols-4"><div class="field"><label>Laboratoire</label><select id="wat-lab"><option value="">Autre / saisie libre</option>${labs.map(l=>`<option value="${l.id}" ${w.labId===l.id?'selected':''}>${escapeHtml(l.name)}</option>`).join('')}</select></div><div class="field"><label>Date analyse</label><input id="wat-date" type="date" value="${escapeHtml(w.date||'')}"></div><div class="field"><label>Origine eau</label><select id="wat-source">${waterOrigins.map(x=>`<option ${w.source===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Traitement</label><input id="wat-treated" value="${escapeHtml(w.treated||'')}" placeholder="UV, chloration, filtration…"></div></div><div class="actions"><button class="btn primary" id="wat-add-point">+ Point de prélèvement</button><button class="btn secondary" id="wat-template-public">Grille Public Labos</button><button class="btn secondary" id="wat-template-lpl">Grille LPL</button></div></section><section class="card"><h3>Mesures terrain déjà saisies</h3>${terrain.length?`<div class="table-wrap"><table class="compact-table"><thead><tr><th>Point</th><th>Origine</th><th>pH</th><th>Redox</th><th>Conductivité</th><th>Nitrates</th></tr></thead><tbody>${terrain.map(t=>`<tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.origin||'')}</td><td>${escapeHtml(t.ph||'—')}</td><td>${escapeHtml(t.redox||'—')}</td><td>${escapeHtml(t.conductivity||'—')}</td><td>${escapeHtml(t.nitrates||'—')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aucune mesure eau enregistrée dans Bâtiment → Eau / abreuvoirs.</div>'}</section><section class="card"><h3>Résultats laboratoire</h3>${w.points.map((pt,pi)=>`<article class="water-point" data-wpt="${pt.id}"><div class="section-title"><div><h4>${escapeHtml(pt.name||`Point ${pi+1}`)}</h4><span class="muted">${escapeHtml(pt.location||'')}</span></div><button class="btn danger small" data-del-wpt="${pt.id}">Supprimer</button></div><div class="grid cols-3"><div class="field"><label>Nom point</label><input data-wpt-field="name" value="${escapeHtml(pt.name||'')}"></div><div class="field"><label>Position / prélèvement</label><input data-wpt-field="location" value="${escapeHtml(pt.location||'')}"></div><div class="field"><label>Lier à un point terrain</label><select data-wpt-field="linkedDrinkerId"><option value="">Non lié</option>${terrain.map(t=>`<option value="${t.id}" ${pt.linkedDrinkerId===t.id?'selected':''}>${escapeHtml(t.name)}</option>`).join('')}</select></div></div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Paramètre</th><th>Résultat</th><th>Unité</th><th>Lecture</th><th></th></tr></thead><tbody>${(pt.rows||[]).map(r=>`<tr data-wrow="${r.id}"><td><input data-wrow-field="parameter" value="${escapeHtml(r.parameter||'')}"></td><td><input data-wrow-field="value" inputmode="decimal" value="${escapeHtml(r.value||'')}"></td><td><input data-wrow-field="unit" value="${escapeHtml(r.unit||'')}"></td><td><span class="badge ${waterStatus(r)==='dans le repère'?'complete':waterStatus(r)==='hors repère'?'danger':'warning'}">${escapeHtml(waterStatus(r))}</span></td><td><button class="btn danger small" data-del-wrow="${r.id}">×</button></td></tr>`).join('')}</tbody></table></div><button class="btn secondary small" data-add-wrow="${pt.id}">+ Paramètre</button></article>`).join('')||'<div class="empty">Ajoutez un point ou utilisez une grille laboratoire.</div>'}</section><section class="card"><h3>Synthèse eau</h3><div class="interpret-list">${w.points.map(pt=>{const bad=(pt.rows||[]).filter(r=>waterStatus(r)==='hors repère');const linked=terrain.find(t=>t.id===pt.linkedDrinkerId);return `<div class="notice ${bad.length?'warning':'positive'}"><strong>${escapeHtml(pt.name||'Point eau')}</strong> — ${bad.length?bad.length+' paramètre(s) hors repère':'aucun dépassement interne identifié'}${linked?`<br><span class="muted">Terrain lié : pH ${escapeHtml(linked.ph||'—')} · redox ${escapeHtml(linked.redox||'—')} mV · conductivité ${escapeHtml(linked.conductivity||'—')} µS/cm</span>`:''}</div>`}).join('')||'<div class="empty">Pas encore de résultats.</div>'}</div><div class="field"><label>Conclusion technicien</label><textarea id="wat-notes">${escapeHtml(w.notes||'')}</textarea></div></section>`;
 const save=()=>{w.labId=document.getElementById('wat-lab')?.value||'';w.lab=labs.find(x=>x.id===w.labId)?.name||'';w.date=document.getElementById('wat-date')?.value||'';w.source=document.getElementById('wat-source')?.value||'';w.treated=document.getElementById('wat-treated')?.value||'';w.notes=document.getElementById('wat-notes')?.value||'';saveDatabase(db)};['wat-lab','wat-date','wat-source','wat-treated','wat-notes'].forEach(id=>document.getElementById(id)?.addEventListener('change',save));document.getElementById('wat-notes')?.addEventListener('input',save);
 const mkRows=names=>names.map((n,i)=>({id:uid('wrow'),parameter:n,value:'',unit:(WATER_INTERNAL_REFS[waterKey(n)]||{}).unit||''}));const addTemplate=(name,rows)=>{w.points.push({id:uid('wpt'),name,location:'',linkedDrinkerId:'',rows:mkRows(rows)});saveDatabase(db);renderWaterLab()};document.getElementById('wat-add-point').onclick=()=>addTemplate('Nouveau point',[]);document.getElementById('wat-template-public').onclick=()=>addTemplate('Analyse Public Labos',['Turbidité','pH','Conductivité','Dureté','Nitrites','Coliformes totaux','Escherichia coli','Entérocoques intestinaux','Spores ASR']);document.getElementById('wat-template-lpl').onclick=()=>addTemplate('Analyse LPL',['Spores ASR','Bactéries coliformes','Escherichia coli','Flore totale 22°C','Flore totale 37°C','Entérocoques intestinaux']);app.querySelectorAll('[data-wpt-field]').forEach(el=>{const f=()=>{const pt=w.points.find(x=>x.id===el.closest('[data-wpt]').dataset.wpt);pt[el.dataset.wptField]=el.value;saveDatabase(db)};el.oninput=f;el.onchange=f});app.querySelectorAll('[data-wrow-field]').forEach(el=>{const f=()=>{const pt=w.points.find(x=>x.id===el.closest('[data-wpt]').dataset.wpt),r=pt.rows.find(x=>x.id===el.closest('[data-wrow]').dataset.wrow);r[el.dataset.wrowField]=el.value;saveDatabase(db)};el.oninput=f;el.onchange=()=>{f();renderWaterLab()}});app.querySelectorAll('[data-add-wrow]').forEach(b=>b.onclick=()=>{const pt=w.points.find(x=>x.id===b.dataset.addWrow);pt.rows.push({id:uid('wrow'),parameter:'',value:'',unit:''});saveDatabase(db);renderWaterLab()});app.querySelectorAll('[data-del-wrow]').forEach(b=>b.onclick=()=>{const pt=w.points.find(x=>x.id===b.closest('[data-wpt]').dataset.wpt);pt.rows=pt.rows.filter(x=>x.id!==b.dataset.delWrow);saveDatabase(db);renderWaterLab()});app.querySelectorAll('[data-del-wpt]').forEach(b=>b.onclick=()=>{w.points=w.points.filter(x=>x.id!==b.dataset.delWpt);saveDatabase(db);renderWaterLab()})}

function reportMetabolicHtml(visit){const m=ensureMetabolic(visit),sum=metabolicSummary(visit);if(!m.rows.length)return '<p class="report-empty">Aucun profil métabolique renseigné.</p>';return `<p><strong>Laboratoire :</strong> ${escapeHtml(m.lab||'Références internes / non précisé')} · <strong>Date :</strong> ${escapeHtml(formatDate(m.date)||'—')} · <strong>Prélèvement :</strong> ${escapeHtml(m.sampleType||'—')}</p><table><thead><tr><th>Animal / lot</th><th>Paramètre</th><th>Valeur</th><th>Référence utilisée</th><th>Lecture</th></tr></thead><tbody>${m.rows.map(r=>`<tr><td>${escapeHtml(r.animal||'—')}</td><td>${escapeHtml(r.analyte||'—')}</td><td>${escapeHtml(r.value||'—')} ${escapeHtml(r.unit||'')}</td><td>${escapeHtml(r.refMin||'—')} – ${escapeHtml(r.refMax||'—')}</td><td>${escapeHtml(metabolicStatus(r))}</td></tr>`).join('')}</tbody></table>${sum.map(i=>{const k=METABOLIC_KNOWLEDGE[i.key];return k&& (i.low||i.high)?`<article class="report-box ${i.low?'warning':''}"><h3>${escapeHtml(k.label)} — ${i.low?'déficit possible':'excès / déséquilibre possible'}</h3><p><strong>Impacts :</strong> ${escapeHtml(k.impacts.join(' ; '))}</p><p><strong>À vérifier :</strong> ${escapeHtml(k.checks.join(' ; '))}</p><p><strong>Pistes de correction :</strong> ${escapeHtml(k.corrections.join(' ; '))}</p><small>${escapeHtml(k.caution)}</small></article>`:''}).join('')}${m.notes?`<p><strong>Conclusion technicien :</strong> ${escapeHtml(m.notes)}</p>`:''}`}
function reportParasitismHtml(visit){const p=ensureParasitism(visit),sum=parasiteSummary(visit),fe=fecrtValue(p);if(!p.rows.length)return '<p class="report-empty">Aucune analyse parasitaire renseignée.</p>';return `<p><strong>Laboratoire :</strong> ${escapeHtml(p.lab||'—')} · <strong>Date :</strong> ${escapeHtml(formatDate(p.date)||'—')} · <strong>Lot :</strong> ${escapeHtml(p.category||'—')}</p><p><strong>Contexte :</strong> ${escapeHtml(p.pasture||'—')} · <strong>Signes :</strong> ${escapeHtml(p.symptoms||'—')} · <strong>Dernier traitement :</strong> ${escapeHtml([p.lastTreatment,p.lastMolecule].filter(Boolean).join(' · ')||'—')}</p><table><thead><tr><th>Animal / lot</th><th>Parasite</th><th>Résultat</th><th>Lecture</th></tr></thead><tbody>${p.rows.map(r=>`<tr><td>${escapeHtml(r.animal||'—')}</td><td>${escapeHtml(r.parasite||'—')}</td><td>${escapeHtml(r.value||'—')} ${escapeHtml(r.unit||'')}</td><td>${escapeHtml(parasiteStatus(r))}</td></tr>`).join('')}</tbody></table>${fe!==null?`<p><strong>Réduction d’excrétion :</strong> ${fe} % (${escapeHtml(p.fecrt.before)} → ${escapeHtml(p.fecrt.after)} OPG, ${escapeHtml(p.fecrt.days)} j)</p>`:''}${sum.map(i=>{const k=PARASITE_KNOWLEDGE[i.key];return k?`<article class="report-box"><h3>${escapeHtml(k.label)}</h3><p><strong>Impacts possibles :</strong> ${escapeHtml(k.impacts.join(' ; '))}</p><p><strong>À vérifier :</strong> ${escapeHtml(k.checks.join(' ; '))}</p>${k.molecules.length?`<p><strong>Molécules / exemples :</strong> ${k.molecules.map(([a,b])=>`${escapeHtml(a)} (${escapeHtml(b)})`).join(' ; ')}</p>`:''}<small>Exemples indicatifs — vérifier RCP ANMV, statut lait/viande, délais d’attente et prescription vétérinaire.</small></article>`:''}).join('')}${p.notes?`<p><strong>Conclusion technicien :</strong> ${escapeHtml(p.notes)}</p>`:''}`}
function metabolicParasitismAttention(visit){const out=[];const ms=metabolicSummary(visit);const low=ms.reduce((n,x)=>n+x.low,0),high=ms.reduce((n,x)=>n+x.high,0);if(low||high)out.push({level:'warning',icon:'🧬',text:`Profil métabolique : ${low} valeur(s) basse(s), ${high} haute(s)`,view:'metabolic'});const ps=parasiteSummary(visit);const concern=ps.reduce((n,x)=>n+x.statuses.filter(s=>['modere','eleve','positif'].includes(s)).length,0);if(concern)out.push({level:'warning',icon:'🦠',text:`Parasitisme : ${concern} résultat(s) à interpréter / surveiller`,view:'parasitism'});return out}

function renderPhotos(){
  const visit=activeVisit();if(!visit){renderNoActiveVisit('Photothèque');return;}visit.photos=Array.isArray(visit.photos)?visit.photos:[];
  const subjectOptions=(visit.subjects||[]).map(s=>`<option value="${s.id}">${escapeHtml(s.identifier||s.name||s.category||'Sujet')}</option>`).join('');
  app.innerHTML=`<div class="section-title"><div><h2>Photothèque de la visite</h2><div class="muted">Photo directe ou galerie, commentaire et annotation au doigt.</div></div><span class="badge autosave">v14.6.21.68</span></div>${activeVisitBanner(visit)}<section class="card photo-toolbar"><div class="field"><label>Associer les prochaines photos à</label><select id="photo-subject"><option value="">Visite générale</option>${subjectOptions}</select></div><div class="photo-add-actions"><button class="btn primary" id="take-photo">📷 Prendre une photo</button><button class="btn" id="choose-photo">🖼️ Choisir dans la galerie</button></div><input id="camera-photo-input" type="file" accept="image/*" capture="environment" hidden><input id="gallery-photo-input" type="file" accept="image/*" multiple hidden></section><section class="card notice"><strong>${visit.photos.length} photo(s)</strong><br><span class="muted">Les images sont automatiquement réduites pour limiter le poids de la sauvegarde. Pensez à exporter régulièrement la sauvegarde JSON.</span></section><section class="photo-grid">${visit.photos.length?visit.photos.map(p=>photoCardHtml(visit,p)).join(''):'<div class="card empty">Aucune photo pour cette visite.</div>'}</section>`;
  const addFiles=async files=>{for(const file of files){if(!file.type.startsWith('image/'))continue;try{const dataUrl=await photoFileToDataUrl(file);visit.photos.unshift({id:uid('photo'),dataUrl,originalDataUrl:dataUrl,comment:'',subjectId:document.getElementById('photo-subject')?.value||'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});saveDatabase(db);}catch(e){console.error(e);showToast('Une photo n’a pas pu être ajoutée.');}}renderPhotos();showToast('Photo(s) ajoutée(s).');};
  document.getElementById('take-photo').onclick=()=>document.getElementById('camera-photo-input').click();document.getElementById('choose-photo').onclick=()=>document.getElementById('gallery-photo-input').click();
  document.getElementById('camera-photo-input').onchange=e=>addFiles([...e.target.files]);document.getElementById('gallery-photo-input').onchange=e=>addFiles([...e.target.files]);
  app.querySelectorAll('[data-photo-comment]').forEach(el=>{const save=()=>{const photo=visit.photos.find(p=>p.id===el.dataset.photoComment);if(!photo)return;photo.comment=el.value;photo.updatedAt=new Date().toISOString();saveDatabase(db);};el.oninput=save;el.onblur=save;});
  app.querySelectorAll('[data-delete-photo]').forEach(b=>b.onclick=()=>{if(!confirm('Supprimer cette photo ?'))return;visit.photos=visit.photos.filter(p=>p.id!==b.dataset.deletePhoto);saveDatabase(db);renderPhotos();});
  app.querySelectorAll('[data-open-photo]').forEach(b=>b.onclick=()=>openPhotoViewer(visit.photos.find(p=>p.id===b.dataset.openPhoto)));
  app.querySelectorAll('[data-annotate-photo]').forEach(b=>b.onclick=()=>openPhotoAnnotator(visit,visit.photos.find(p=>p.id===b.dataset.annotatePhoto)));
}
function openPhotoViewer(photo){if(!photo)return;const overlay=document.createElement('div');overlay.className='photo-overlay';overlay.innerHTML=`<div class="photo-viewer"><button class="photo-modal-close" aria-label="Fermer">×</button><img src="${photo.dataUrl}" alt="Photo"><p>${escapeHtml(photo.comment||'')}</p></div>`;document.body.appendChild(overlay);overlay.onclick=e=>{if(e.target===overlay||e.target.closest('.photo-modal-close'))overlay.remove();};}
function openPhotoAnnotator(visit,photo){if(!photo)return;const overlay=document.createElement('div');overlay.className='photo-overlay';overlay.innerHTML=`<div class="photo-annotator"><div class="photo-modal-head"><strong>Annoter la photo</strong><button class="photo-modal-close">×</button></div><canvas id="photo-annotation-canvas"></canvas><div class="annotation-tools"><label>Couleur <input type="color" id="annotation-color" value="#e32636"></label><label>Épaisseur <input type="range" id="annotation-width" min="2" max="18" value="6"></label><button class="btn" id="annotation-undo">Annuler le trait</button><button class="btn" id="annotation-reset">Revenir à l’original</button><button class="btn primary" id="annotation-save">Enregistrer</button></div></div>`;document.body.appendChild(overlay);
  const canvas=overlay.querySelector('canvas'),ctx=canvas.getContext('2d'),img=new Image(),history=[];let drawing=false,last=null;
  const snapshot=()=>{history.push(canvas.toDataURL('image/jpeg',.8));if(history.length>15)history.shift();};
  img.onload=()=>{canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;ctx.drawImage(img,0,0);};img.src=photo.dataUrl;
  const pos=e=>{const r=canvas.getBoundingClientRect(),t=e.touches?.[0]||e;return{x:(t.clientX-r.left)*canvas.width/r.width,y:(t.clientY-r.top)*canvas.height/r.height};};
  const start=e=>{e.preventDefault();snapshot();drawing=true;last=pos(e);};const move=e=>{if(!drawing)return;e.preventDefault();const q=pos(e);ctx.strokeStyle=overlay.querySelector('#annotation-color').value;ctx.lineWidth=Number(overlay.querySelector('#annotation-width').value);ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(q.x,q.y);ctx.stroke();last=q;};const end=()=>{drawing=false;last=null;};
  canvas.addEventListener('pointerdown',start);canvas.addEventListener('pointermove',move);window.addEventListener('pointerup',end,{once:false});
  overlay.querySelector('.photo-modal-close').onclick=()=>overlay.remove();overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
  overlay.querySelector('#annotation-undo').onclick=()=>{const src=history.pop();if(!src)return;const i=new Image();i.onload=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(i,0,0);};i.src=src;};
  overlay.querySelector('#annotation-reset').onclick=()=>{snapshot();const i=new Image();i.onload=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(i,0,0,canvas.width,canvas.height);};i.src=photo.originalDataUrl||photo.dataUrl;};
  overlay.querySelector('#annotation-save').onclick=()=>{photo.dataUrl=canvas.toDataURL('image/jpeg',.76);photo.updatedAt=new Date().toISOString();saveDatabase(db);overlay.remove();renderPhotos();showToast('Annotation enregistrée.');};
}
function reportPhotosHtml(visit){const photos=visit.photos||[];if(!photos.length)return '<p class="report-empty">Aucune photo enregistrée.</p>';return `<div class="report-photo-grid">${photos.map(p=>`<figure><img src="${p.dataUrl}" alt="Photo de visite"><figcaption><strong>${escapeHtml(photoSubjectLabel(visit,p.subjectId))}</strong>${p.comment?`<br>${escapeHtml(p.comment)}`:''}</figcaption></figure>`).join('')}</div>`;}

function reportHeader(visit,title,subtitle=''){
  const m=reportMeta(visit),st=reportStats(visit);
  return `<header class="report-cover"><div class="report-brand"><div class="report-logo">GDS<br>32-65</div><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div></div><div class="report-cover-grid"><div><span>Exploitation</span><strong>${escapeHtml(m.farm)}</strong></div><div><span>Date</span><strong>${escapeHtml(m.date)}</strong></div><div><span>Technicien</span><strong>${escapeHtml(m.technician||'Non renseigné')}</strong></div><div><span>Type de visite</span><strong>${escapeHtml(m.type||'Non renseigné')}</strong></div><div><span>Sujets observés</span><strong>${st.subjects}</strong></div><div><span>Sujets avec mesures</span><strong>${st.measured}</strong></div></div></header>`;
}
function reportConclusionHtml(visit){
  const c=ensureVisitConclusion(visit);
  const priorities=(c.priorities||[]).filter(x=>x.text);
  return `<section class="report-section"><h2>Résumé de la visite</h2><div class="report-summary-grid"><article class="report-box positive"><h3>✅ Points forts</h3>${reportList(c.strengths)}</article><article class="report-box warning"><h3>⚠️ Points à améliorer</h3>${reportList([c.high,c.medium,c.low].filter(Boolean).join('\n'))}</article></div><article class="report-box"><h3>Conclusion générale</h3><p>${escapeHtml(c.general||'').replace(/\n/g,'<br>')}</p></article></section><section class="report-section"><h2>Actions principales</h2><table><thead><tr><th>Action</th><th>Décision</th><th>Commentaire</th></tr></thead><tbody>${priorities.length?priorities.map((a,i)=>`<tr><td><strong>${i+1}. ${escapeHtml(a.text)}</strong>${a.source?`<br><small>${escapeHtml(a.source)}</small>`:''}</td><td>${escapeHtml(a.decision||'À étudier')}</td><td>${escapeHtml(a.comment||'')}</td></tr>`).join(''):'<tr><td colspan="3">Aucune action principale renseignée.</td></tr>'}</tbody></table><h3>À vérifier lors de la prochaine visite</h3>${reportList(c.next)}</section>`;
}
function reportStatusClass(status=''){
  if(status==='green')return 'report-value-green';
  if(status==='yellow-low'||status==='yellow-high')return 'report-value-yellow';
  if(status==='red-low'||status==='red-high')return 'report-value-red';
  return '';
}
function reportSubjectLabel(s){return [s.tag,s.name].filter(Boolean).join(' · ')||'Sujet';}
function reportAnalysisTable(visit){
  const groups=categoryAnalysis(visit);
  if(!groups.length)return '<p class="report-empty">Aucune donnée d’analyse exploitable.</p>';
  return groups.map(g=>`<article class="report-subsection"><h3>${escapeHtml(g.category)} <small>(${g.subjects.length} sujet(s))</small></h3>${abnormalSubjectsHtml(g)}<table><thead><tr><th>Paramètre</th><th>n</th><th>Min</th><th>Moy.</th><th>Max</th><th>Hors réf.</th><th>Animal(aux) hors réf.</th></tr></thead><tbody>${g.parameterResults.map(r=>{const out=r.measured.filter(m=>statusSeverity(m.result.status)>=2);return `<tr><td>${escapeHtml(r.parameter.label)}</td><td>${r.measured.length}</td><td>${r.minimum.toLocaleString('fr-FR',{maximumFractionDigits:2})}</td><td class="${reportStatusClass(r.worst.result.status)}">${r.average.toLocaleString('fr-FR',{maximumFractionDigits:2})}</td><td>${r.maximum.toLocaleString('fr-FR',{maximumFractionDigits:2})}</td><td>${r.outOfRange}/${r.measured.length}</td><td>${out.length?out.map(m=>escapeHtml(reportSubjectLabel(m.subject))).join('<br>'):'—'}</td></tr>`}).join('')}</tbody></table>${visit.analysisConclusions?.[g.category]?`<p><strong>Conclusion du technicien :</strong> ${escapeHtml(visit.analysisConclusions[g.category])}</p>`:''}</article>`).join('');
}
function reportRawMeasurementsHtml(visit){
  const subjects=visit.subjects||[];if(!subjects.length)return '<p class="report-empty">Aucun sujet enregistré.</p>';
  const used=analysisParameters.filter(p=>subjects.some(s=>numericValue(s.measurements?.analysis?.[p.key])!==null));
  if(!used.length)return '<p class="report-empty">Aucune mesure numérique saisie.</p>';
  const head=`<th>Sujet</th><th>Catégorie</th>${used.map(p=>`<th>${escapeHtml(p.short||p.label)}</th>`).join('')}`;
  const rows=subjects.map(sub=>`<tr><td><strong>${escapeHtml(reportSubjectLabel(sub))}</strong></td><td>${escapeHtml(sub.category||'Non classé')}</td>${used.map(param=>{const raw=sub.measurements?.analysis?.[param.key],v=numericValue(raw);if(v===null)return '<td>—</td>';const result=classifyValue(v,thresholdFor(sub,param.key));return `<td class="${reportStatusClass(result.status)}"><strong>${escapeHtml(String(raw).replace('.',','))}</strong><br><small>${escapeHtml(result.label)}</small></td>`}).join('')}</tr>`).join('');
  return `<div class="report-color-legend"><span class="report-value-green">Vert = repère</span><span class="report-value-yellow">Jaune = vigilance</span><span class="report-value-red">Rouge = écart</span></div><div class="report-wide-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function reportObservationsHtml(visit){
  const rows=(visit.subjects||[]).map(sub=>{const obs=sub.measurements?.observations||{};const vals=observationFields.map(f=>{const raw=obs[f.key];const text=Array.isArray(raw)?raw.join(', '):raw;return text!==undefined&&text!==null&&String(text).trim()?`${f.label} : ${text}`:''}).filter(Boolean);const comments=Object.entries(sub.measurements?.comments||{}).filter(([,v])=>String(v||'').trim()).map(([k,v])=>`${k} : ${v}`);return {sub,vals:[...vals,...comments]};}).filter(x=>x.vals.length);
  if(!rows.length)return '<p class="report-empty">Aucune observation renseignée.</p>';
  return `<table><thead><tr><th>Sujet</th><th>Catégorie</th><th>Observations / commentaires</th></tr></thead><tbody>${rows.map(x=>`<tr><td><strong>${escapeHtml(reportSubjectLabel(x.sub))}</strong></td><td>${escapeHtml(x.sub.category||'Non classé')}</td><td>${x.vals.map(v=>escapeHtml(v)).join('<br>')}</td></tr>`).join('')}</tbody></table>`;
}
function reportReasoningHtml(visit){
  const groups=categoryAnalysis(visit),byKey=new Map(),rank={high:3,medium:2,low:1};
  groups.forEach(g=>buildKnowledgePistes(visit,g).forEach(h=>{const state=reasoningState(visit,`${g.category}:${h.id}`);if(state.status==='dismissed')return;const key=h.id||normalizeSearchText(h.title||'');const existing=byKey.get(key);if(!existing){byKey.set(key,{...h,categories:[g.category],notes:state.note?[`${g.category} : ${state.note}`]:[]});return;}if(!existing.categories.includes(g.category))existing.categories.push(g.category);if(state.note)existing.notes.push(`${g.category} : ${state.note}`);const er=rank[existing.confidence?.className]||0,nr=rank[h.confidence?.className]||0;if(nr>er||(nr===er&&(h.score||0)>(existing.score||0))){const cats=existing.categories,notes=existing.notes;Object.assign(existing,h);existing.categories=cats;existing.notes=notes;}}));
  const cards=[...byKey.values()].sort((a,b)=>(rank[b.confidence?.className]||0)-(rank[a.confidence?.className]||0)||(b.score||0)-(a.score||0));
  if(!cards.length)return '<p class="report-empty">Aucune piste de raisonnement retenue.</p>';
  return cards.map(h=>`<article class="report-reason"><h3>${escapeHtml(h.title)}</h3><p><strong>Catégorie(s) concernée(s) :</strong> ${escapeHtml(h.categories.join(' + '))}</p><p><strong>Confiance :</strong> ${escapeHtml(h.confidence.label)} · ${h.sourceCount} source(s) — ${(h.evidence||[]).length} élément(s) en faveur, ${(h.nuance||[]).length} prudence/contradiction(s), ${(h.missing||[]).length} donnée(s) manquante(s).</p><p>${escapeHtml(h.summary)}</p>${h.mechanism?`<p><strong>Ce que cette piste peut traduire :</strong> ${escapeHtml(h.mechanism)}</p>`:''}<div class="report-columns"><div><h4>Éléments en faveur</h4>${reportList((h.evidence||[]).join('\n'))}</div><div><h4>Prudence / contradictions</h4>${reportList((h.nuance||[]).join('\n'))}</div><div><h4>Facteurs à examiner</h4>${reportList((h.causes||[]).join('\n'))}</div><div><h4>Données manquantes</h4>${reportList((h.missing||[]).join('\n'))}</div></div>${h.notes?.length?`<p><strong>Commentaires du technicien :</strong><br>${h.notes.map(n=>escapeHtml(n)).join('<br>')}</p>`:''}</article>`).join('');
}

function reportFeedingHtml(visit){
  const rows=visit.feeding?.rations||[];
  if(!rows.length)return '<p class="report-empty">Aucune ration renseignée.</p>';
  return `<table><thead><tr><th>Catégorie</th><th>Type</th><th>Nature</th><th>Quantité</th><th>Distribution</th><th>Commentaire</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.category||'')}</td><td>${escapeHtml(r.type||'')}</td><td>${escapeHtml(r.nature||r.detail||'')}</td><td>${escapeHtml([r.quantity,r.unit].filter(Boolean).join(' '))}</td><td>${escapeHtml(r.distribution||'')}</td><td>${escapeHtml(r.comment||'')}</td></tr>`).join('')}</tbody></table>`;
}
function reportBuildingHtml(visit){
  const rec=buildingRecords(visit);
  return `<div class="report-kpis"><div><span>Abreuvoirs</span><strong>${rec.drinkers.length}</strong></div><div><span>Mesures électriques</span><strong>${rec.electric.length}</strong></div><div><span>Zones de litière</span><strong>${rec.litters.length}</strong></div></div>${rec.drinkers.length?`<h3>Abreuvoirs</h3><table><thead><tr><th>Nom</th><th>Type</th><th>Matériau</th><th>Débit</th><th>pH</th><th>Redox</th><th>Commentaire</th></tr></thead><tbody>${rec.drinkers.map(d=>`<tr><td>${escapeHtml(d.name||'')}</td><td>${escapeHtml(d.type||'')}</td><td>${escapeHtml(d.material||'')}</td><td>${escapeHtml(d.flow||'')}</td><td>${escapeHtml(d.ph||'')}</td><td>${escapeHtml(d.redox||'')}</td><td>${escapeHtml(d.comment||'')}</td></tr>`).join('')}</tbody></table>`:''}`;
}
function reportAuditHtml(visit){
  const a=ensureAuditGlobal(visit);
  return auditGlobalSections.map(s=>{const summary=a.chapterSummaries?.[s.id]||{};return `<article class="report-subsection"><h3>${s.icon} ${escapeHtml(s.title)}</h3><table><thead><tr><th>Question / point contrôlé</th><th>Réponse</th><th>Commentaire</th></tr></thead><tbody>${s.questions.map(q=>{const x=a.answers[q]||{};const answer=x.answer||((x.values||[]).join(', '))||'—';return `<tr><td>${escapeHtml(q)}</td><td>${escapeHtml(answer)}</td><td>${escapeHtml(x.comment||'')}</td></tr>`}).join('')}</tbody></table>${summary.strengths?`<p><strong>Points forts :</strong> ${escapeHtml(summary.strengths)}</p>`:''}${summary.watch?`<p><strong>Points de vigilance :</strong> ${escapeHtml(summary.watch)}</p>`:''}${summary.comments?`<p><strong>Commentaires :</strong> ${escapeHtml(summary.comments)}</p>`:''}</article>`}).join('');
}

function reportReproductionHtml(visit,includeProblemCows=false){
  const farm=db.farms.find(f=>f.id===visit.farmId),source=reproductionSourceForVisit(visit,farm),registry=source.registry||[];
  if(!registry.length)return '<p class="report-empty">Aucun registre Reproduction lié à cette visite.</p>';
  const reproFarm={...farm,herdRegistry:registry},full=reproductionRegistryPeriod(registry),periodMin=source.meta?.period?.from||full.from||'',periodMax=source.meta?.period?.to||full.to||new Date().toISOString().slice(0,10),periodKey=`audit-bovin-repro-period-${visit.id||visit.farmId||'default'}`;
  let saved={};try{saved=JSON.parse(localStorage.getItem(periodKey)||'{}')||{}}catch(_){saved={};}
  const periodStart=saved.start||reproductionDefaultYearStart(periodMin,periodMax),periodEnd=saved.end||periodMax,analysisDate=periodEnd||new Date().toISOString().slice(0,10);
  const presentFemales=registry.filter(a=>a.sex==='F'&&isRegistryAnimalPresent(a,analysisDate)),cows=currentReproductionCows(reproFarm,analysisDate),breeding24=presentFemales.filter(a=>monthsBetweenDates(a.birthDate,analysisDate)>24),breeding36=presentFemales.filter(a=>monthsBetweenDates(a.birthDate,analysisDate)>36);
  const intervalEvents=cows.flatMap(r=>r.intervals.map((v,i)=>({v,date:r.calvingDates[i+1]||''}))).filter(e=>e.date&&(!periodStart||e.date>=periodStart)&&(!periodEnd||e.date<=periodEnd)),ivvs=intervalEvents.map(e=>e.v),calves=cows.flatMap(r=>r.calves).filter(c=>c.birthDate&&(!periodStart||c.birthDate>=periodStart)&&(!periodEnd||c.birthDate<=periodEnd));
  const mothers=new Set(calves.map(c=>normalizeAnimalId(c.motherId))),ids24=new Set(breeding24.map(a=>normalizeAnimalId(a.id))),ids36=new Set(breeding36.map(a=>normalizeAnimalId(a.id))),calved24=[...mothers].filter(id=>ids24.has(id)).length,calved36=[...mothers].filter(id=>ids36.has(id)).length;
  const rate24=breeding24.length?Math.round(calved24/breeding24.length*1000)/10:null,rate36=breeding36.length?Math.round(calved36/breeding36.length*1000)/10:null,mean=ivvs.length?Math.round(ivvs.reduce((a,b)=>a+b,0)/ivvs.length):null,min=ivvs.length?Math.min(...ivvs):null,max=ivvs.length?Math.max(...ivvs):null;
  const dead=calves.filter(c=>c.exitCause==='M'&&c.exitDate&&daysBetweenDates(c.birthDate,c.exitDate)<183),firstAges=cows.map(r=>r.firstCalvingAgeMonths).filter(v=>v!=null),firstMean=firstAges.length?Math.round(firstAges.reduce((a,b)=>a+b,0)/firstAges.length*10)/10:null;
  const problemCows=cows.filter(r=>r.daysSinceLast>400||r.meanIVV>450||r.deadBefore6.length>=2||r.firstCalvingAgeMonths>36||reproductionScore(r)<60).sort((a,b)=>reproductionScore(a)-reproductionScore(b)||b.deadBefore6.length-a.deadBefore6.length||(b.meanIVV||0)-(a.meanIVV||0)||(b.daysSinceLast||0)-(a.daysSinceLast||0));
  let html=`<p><strong>Période analysée :</strong> ${periodStart?formatDate(periodStart):'—'} → ${periodEnd?formatDate(periodEnd):'—'}${source.meta?.fileName?` · Source : ${escapeHtml(source.meta.fileName)}`:''}</p><div class="report-kpis"><div><span>Taux vêlage &gt;24 mois</span><strong>${rate24??'—'}%</strong></div><div><span>Taux vêlage &gt;36 mois</span><strong>${rate36??'—'}%</strong></div><div><span>IVV moyen</span><strong>${mean??'—'} j</strong></div><div><span>IVV mini</span><strong>${min??'—'} j</strong></div><div><span>IVV maxi</span><strong>${max??'—'} j</strong></div><div><span>Âge moyen 1er vêlage</span><strong>${firstMean??'—'} mois</strong></div><div><span>Mortalité veaux &lt;6 mois</span><strong>${calves.length?Math.round(dead.length/calves.length*1000)/10:'—'}%</strong></div><div><span>Vaches à surveiller</span><strong>${problemCows.length}</strong></div></div>${reproductionScoreLegendHtml(true)}`;
  if(includeProblemCows)html+=problemCows.length?`<h3>Détail des vaches à problème / à surveiller</h3><p class="report-note">Classement : score le plus faible en premier, puis mortalité des veaux, IVV moyen et ancienneté du dernier vêlage.</p><table class="report-repro-problem-table"><thead><tr><th rowspan="2">N° + nom</th><th rowspan="2">Âge</th><th rowspan="2">1er V</th><th rowspan="2">Dernier V</th><th rowspan="2">IVV moy.</th><th rowspan="2">IVV min/max</th><th colspan="2">Veaux</th><th colspan="2">Score</th></tr><tr><th>Nés</th><th>Morts &lt;6 m</th><th>/100</th><th>Détail</th></tr></thead><tbody>${problemCows.map(r=>{const d=reproductionScoreDetails(r),detail=d.lines.filter(x=>x.delta<0).map(x=>`${x.label} ${x.delta}`).join(' · ')||'Aucune pénalité';return `<tr><td><strong>${escapeHtml(r.cow.workNumber||r.cow.id)}</strong>${r.cow.name?`<br><small>${escapeHtml(r.cow.name)}</small>`:''}<br><small>${escapeHtml(r.cow.id)}</small></td><td>${escapeHtml(ageLabelAt(r.cow.birthDate,analysisDate)||'—')}</td><td>${r.firstCalvingDate?formatDate(r.firstCalvingDate):'—'}${r.firstCalvingAgeMonths!=null?`<br><small>${r.firstCalvingAgeMonths} mois</small>`:''}</td><td>${r.lastCalvingDate?formatDate(r.lastCalvingDate):'—'}${r.daysSinceLast!=null?`<br><small>${r.daysSinceLast} j</small>`:''}</td><td>${r.meanIVV??'—'}</td><td>${r.minIVV??'—'} / ${r.maxIVV??'—'}</td><td>${r.calves.length}</td><td>${r.deadBefore6.length}</td><td class="score-${reproductionScore(r)<60?'bad':reproductionScore(r)<75?'warn':'ok'}"><strong>${reproductionScore(r)}</strong></td><td><small>${escapeHtml(detail)}</small></td></tr>`}).join('')}</tbody></table>`:'<p>Aucune vache ne répond aux critères d’alerte retenus.</p>';
  return html;
}
function reportDocumentHtml(visit,type,options={}){
  const titles={farmer:'Rapport Éleveur',technical:'Rapport Technique',expert:'Rapport Expert'};
  let body=reportHeader(visit,titles[type]||'Rapport de visite',type==='farmer'?'Synthèse claire et plan d’action':type==='technical'?'Relevé détaillé de l’audit et des données recueillies':'Calculs, interprétations et raisonnement technique');
  body+=reportConclusionHtml(visit);
  if(type!=='farmer'){
    if(options.rawMeasurements!==false)body+=`<section class="report-section page-break"><h2>Mesures individuelles — données brutes et classement</h2>${reportRawMeasurementsHtml(visit)}</section>`;
    if(options.observations!==false)body+=`<section class="report-section"><h2>Observations individuelles</h2>${reportObservationsHtml(visit)}</section>`;
    if(options.audit!==false)body+=`<section class="report-section page-break"><h2>Audit / questionnaire — réponses détaillées</h2>${reportAuditHtml(visit)}</section>`;
    if(options.reproduction!==false)body+=`<section class="report-section"><h2>Reproduction</h2>${reportReproductionHtml(visit,options.reproductionDetails===true)}</section>`;
    if(options.feeding!==false)body+=`<section class="report-section"><h2>Alimentation</h2>${reportFeedingHtml(visit)}</section>`;
    if(options.building!==false)body+=`<section class="report-section"><h2>Bâtiment, eau et environnement</h2>${reportBuildingHtml(visit)}</section>`;
    if(options.herddata!==false)body+=`<section class="report-section page-break"><h2>Données technico-économiques</h2>${reportHerdDataHtml(visit)}</section>`;
    if(options.metabolic!==false)body+=`<section class="report-section page-break"><h2>Profil métabolique — oligo-éléments & vitamines</h2>${reportMetabolicHtml(visit)}</section>`;
    if(options.parasitism!==false)body+=`<section class="report-section page-break"><h2>Parasitisme</h2>${reportParasitismHtml(visit)}</section>`;
    if(options.analysis!==false)body+=`<section class="report-section page-break"><h2>Calculs, analyses et synthèses</h2>${reportAnalysisTable(visit)}</section>`;
    if(options.reasoning!==false)body+=`<section class="report-section page-break"><h2>Raisonnement regroupé</h2>${reportReasoningHtml(visit)}</section>`;
    if(options.photos!==false)body+=`<section class="report-section page-break"><h2>Photothèque de la visite</h2>${reportPhotosHtml(visit)}</section>`;
  }
  body+=`<footer class="report-footer"><p>Ce rapport constitue une aide au raisonnement fondée sur les données recueillies lors de la visite. Les pistes proposées restent soumises à la validation du technicien et, lorsque nécessaire, à l’appréciation du vétérinaire.</p><div class="signature-grid"><div><strong>Éleveur</strong><br><br>Signature :</div><div><strong>Technicien</strong><br><br>Signature :</div></div></footer>`;
  return body;
}

function fullReportStyles(){return `${printBaseStyles()} body{max-width:980px;margin:0 auto;padding:20px;background:#fff;color:#16231c}.report-cover{padding:24px;border:2px solid #b53670;border-radius:16px;margin-bottom:24px}.report-brand{display:flex;gap:18px;align-items:center}.report-logo{width:72px;height:72px;border-radius:18px;background:#b53670;color:white;display:grid;place-items:center;text-align:center;font-weight:800}.report-cover h1{margin:0}.report-cover-grid,.report-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:20px}.report-cover-grid>div,.report-kpis>div{padding:10px;background:#fff4f8;border-radius:8px}.report-cover-grid span,.report-kpis span{display:block;color:#66756c;font-size:9pt}.report-cover-grid strong,.report-kpis strong{display:block;margin-top:3px}.report-section{margin:22px 0}.report-summary-grid,.report-columns,.herd-chart-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.report-box,.report-reason,.report-subsection,.herd-chart-card{border:1px solid #cfdad3;border-radius:10px;padding:12px;margin:10px 0}.report-box.positive{border-left:6px solid #b53670}.report-box.warning{border-left:6px solid #e0a326}.report-empty{color:#6b746e;font-style:italic}.report-footer{margin-top:30px;border-top:2px solid #d5dfd8;padding-top:16px}.signature-grid{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:25px}.signature-grid>div{min-height:90px;border:1px solid #aab5ad;padding:12px}.report-photo-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.report-photo-grid figure{margin:0;break-inside:avoid;border:1px solid #cfdad3;border-radius:10px;padding:8px}.report-photo-grid img{width:100%;max-height:360px;object-fit:contain}.report-photo-grid figcaption{padding:7px 2px;font-size:10pt}.herd-chart-grid{grid-template-columns:1fr}.herd-chart-card{break-inside:avoid;background:#fffafd}.herd-svg-chart{width:100%;height:auto;display:block}.herd-chart-legend{display:flex;gap:12px;flex-wrap:wrap;margin:6px 0 10px}.herd-chart-legend span{display:inline-flex;align-items:center;gap:6px;font-size:10pt;color:#425047}.herd-chart-legend i{width:12px;height:12px;border-radius:3px;display:inline-block}.legend-square{font-size:15pt;line-height:1}.report-color-legend{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 12px}.report-color-legend span{padding:5px 9px;border:1px solid #b8c4bd;border-radius:6px;font-weight:700}.report-value-green{background:#dff3e7!important;color:#174d2e!important}.report-value-yellow{background:#fff0b8!important;color:#6b5300!important}.report-value-red{background:#ffd5d2!important;color:#7d1b17!important}.report-wide-table{overflow:visible}.report-wide-table table{font-size:8.5pt}.abnormal-subjects{margin:10px 0;padding:9px 11px;border-left:4px solid #d14d49;background:#fff5f4}.abnormal-subjects>div{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}.abnormal-subjects span{color:#5e4a4a}.page-break{page-break-before:always}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}@media print{.herd-chart-legend .legend-square{display:inline!important}.report-value-green,.report-value-yellow,.report-value-red{box-shadow:inset 0 0 0 1000px currentColor 0!important}}@media(max-width:700px){.report-cover-grid,.report-kpis,.report-summary-grid,.report-columns{grid-template-columns:1fr}}`}
function reportStandaloneHtml(visit,type,options={}){return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapport ${type}</title><style>${fullReportStyles()}</style></head><body><div class="no-print" style="position:sticky;top:0;background:white;padding:8px;border-bottom:1px solid #ddd;z-index:5"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div>${reportDocumentHtml(visit,type,options)}</body></html>`;}
function downloadReportHtml(visit,type,options={}){const blob=new Blob(['\ufeff',reportStandaloneHtml(visit,type,options)],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`rapport-${type}-${slugify(farmName(visit.farmId))}-${visit.date||'visite'}.html`;a.target='_blank';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function openReportWindow(visit,type,options={}){
  const w=window.open('','_blank');if(!w){downloadReportHtml(visit,type,options);showToast('Le rapport a été téléchargé. Ouvrez-le puis utilisez Imprimer / PDF.');return null;}
  w.document.open();w.document.write(reportStandaloneHtml(visit,type,options));w.document.close();try{w.focus();}catch(e){}return w;
}
function downloadWordReport(visit,type,options={}){
  const html=`<!doctype html><html><head><meta charset="utf-8"><style>${fullReportStyles()}</style></head><body>${reportDocumentHtml(visit,type,options)}</body></html>`;
  const blob=new Blob(['\ufeff',html],{type:'application/msword'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`rapport-${type}-${slugify(farmName(visit.farmId))}-${visit.date||'visite'}.doc`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  visit.generatedReports=Array.isArray(visit.generatedReports)?visit.generatedReports:[];visit.generatedReports.unshift({id:uid('report'),type,format:'Word',createdAt:new Date().toISOString()});saveDatabase(db);
}

function partnerExcelEscapeXml(value=''){return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function partnerExcelNumber(value){if(value===null||value===undefined||value==='')return null;const n=Number(String(value).replace(',','.').replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null;}
function partnerAuditAnswer(visit,label){const item=ensureAuditGlobal(visit).answers?.[label]||{};return item.answer||((item.values||[]).join(', '))||'';}
function partnerAverageMeasure(visit,key){const vals=(visit.subjects||[]).map(s=>partnerExcelNumber(s.measurements?.analysis?.[key])).filter(v=>v!==null);return vals.length?Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*100)/100:null;}
function partnerPhaseColumn(visit,forced='auto'){
  if(forced&&forced!=='auto')return forced==='initial'?'C':forced==='final'?'E':'D';
  const visits=db.visits.filter(v=>v.farmId===visit.farmId).slice().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const idx=visits.findIndex(v=>v.id===visit.id);if(idx<=0)return 'C';if(idx===visits.length-1&&/final/i.test(visit.type||''))return 'E';return 'D';
}
function partnerVisitSummary(visit){
  const c=ensureVisitConclusion(visit),a=ensureAuditGlobal(visit);
  return {
    expectations:[visit.objective,(a.organization.objectives||[]).join(', ')].filter(Boolean).join('\n'),
    problems:[c.high,c.medium,c.low,a.chapterSummaries?.sanitaire?.watch].filter(Boolean).join('\n'),
    advice:(c.priorities||[]).filter(x=>x.text).map((x,i)=>`${i+1}. ${x.text}${x.decision?` — ${x.decision}`:''}`).join('\n'),
    objectives:[c.next,c.general].filter(Boolean).join('\n')
  };
}
async function partnerWorkbookSetCell(zip,path,ref,value,cache){
  if(value===null||value===undefined||value==='')return;
  let entry=cache[path];if(!entry){const raw=await zip.file(path).async('string');entry=cache[path]={doc:new DOMParser().parseFromString(raw,'application/xml')};}
  const doc=entry.doc,ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';let cell=[...doc.getElementsByTagNameNS(ns,'c')].find(c=>c.getAttribute('r')===ref);if(!cell)return;
  [...cell.children].forEach(ch=>{if(['v','is','f'].includes(ch.localName))cell.removeChild(ch);});
  const numeric=typeof value==='number'&&Number.isFinite(value);if(numeric){cell.removeAttribute('t');const v=doc.createElementNS(ns,'v');v.textContent=String(value);cell.appendChild(v);}else{cell.setAttribute('t','inlineStr');const is=doc.createElementNS(ns,'is'),t=doc.createElementNS(ns,'t');t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');t.textContent=String(value);is.appendChild(t);cell.appendChild(is);}
}
async function exportPartnerWorkbook(visit,phase='auto'){
  if(typeof JSZip==='undefined'){showToast('Module Excel indisponible.');return;}
  const farm=db.farms.find(f=>f.id===visit.farmId);if(!farm)return showToast('Exploitation introuvable.');
  let response=await fetch('./modele-partenaires-passage-bv.xlsx?v=14.4.2',{cache:'no-store'});if(!response.ok)response=await fetch('./modele-partenaires-passage-bv.xlsx',{cache:'reload'});if(!response.ok)throw new Error('Modèle partenaire introuvable');
  const zip=await JSZip.loadAsync(await response.arrayBuffer()),cache={};const requiredSheets=[1,2,3,4,5].map(n=>`xl/worksheets/sheet${n}.xml`);const missingSheets=requiredSheets.filter(path=>!zip.file(path));if(missingSheets.length)throw new Error(`Modèle partenaire incomplet : ${missingSheets.join(', ')}`);const a=ensureAuditGlobal(visit),item=linkedHerdImportForVisit(visit),col=partnerPhaseColumn(visit,phase),summary=partnerVisitSummary(visit),st=item?.current?.structure||{},mv=item?.current?.movements||{},mort=item?.years?.N?.mortality||{},rep=item?.years?.N?.reproduction||{};
  const writes=[];const set=(sheet,cell,value)=>writes.push(()=>partnerWorkbookSetCell(zip,`xl/worksheets/sheet${sheet}.xml`,cell,value,cache));
  // Données exploitation
  set(1,'B2',farm.farmer||farm.name);set(1,'B4',farm.name);set(1,'B5',[farm.commune,farm.farmNumber?`N° EDE ${farm.farmNumber}`:''].filter(Boolean).join(' — '));set(1,'B16','Bovin viande');set(1,'B17',partnerExcelNumber(a.renewal.cowsTotal)||st.femalesOver36);set(1,'B18',st.total);set(1,'B28',partnerExcelNumber(a.renewal.replacementHeifers));set(1,'B31',partnerExcelNumber(a.renewal.bulls));set(1,'B32',partnerAuditAnswer(visit,'Période de mise à la reproduction'));
  const repro=partnerAuditAnswer(visit,'Mode de mise à la reproduction').toLowerCase();if(repro){set(1,'C34',repro.includes('insémin')||repro.includes('ia')?'Oui':'');set(1,'E34',repro.includes('monte')?'Oui':'');set(1,'G34',repro.includes('mixte')?'Oui':'');}
  set(1,'B45',visit.previousVisitReview?.summary||'');set(1,'B54',partnerAuditAnswer(visit,'Principaux problèmes sanitaires rencontrés sur les 12 derniers mois'));set(1,'B55',a.notes||'');set(1,'B67',summary.expectations);
  // Bilan sanitaire : colonne selon phase
  const snap=visitReproductionSnapshot(visit),cows=partnerExcelNumber(a.renewal.cowsTotal)||st.femalesOver36||snap.cows;const renewal=renewalRate(a.renewal);const births=partnerExcelNumber(mv.births)||partnerExcelNumber(item?.years?.N?.births)||snap.birthsLast12;const calfDeaths=['h0_48','d2_7','d8_30','m1_6','m6_12'].reduce((s,k)=>s+(partnerExcelNumber(mort[k])||0),0);const adultDeaths=partnerExcelNumber(mort.over24)||0;
  set(4,`${col}3`,cows);set(4,`${col}4`,renewal??snap.renewalRate);set(4,`${col}5`,snap.meanCowAgeYears);set(4,`${col}6`,partnerExcelNumber(rep.gestationRate)||partnerExcelNumber(partnerSmartValue(visit,'Taux de gestation (%)')));set(4,`${col}7`,partnerExcelNumber(rep.ivv)||partnerExcelNumber(partnerSmartValue(visit,'Intervalle vêlage-vêlage'))||snap.ivvMean);set(4,`${col}8`,snap.ivvOver410Rate);set(4,`${col}9`,partnerExcelNumber(rep.weanedCalvesPerCow)||partnerExcelNumber(rep.productivity)||partnerExcelNumber(partnerSmartValue(visit,'Veaux sevrés par vache (nb)')));set(4,`${col}10`,partnerExcelNumber(rep.firstCalvingAge)||partnerExcelNumber(partnerSmartValue(visit,'Âge moyen au premier vêlage'))||snap.firstCalvingAgeMean);const difficult=partnerExcelNumber(partnerAuditAnswer(visit,'Vêlages difficiles avec intervention — nombre/an')),postCalvingReforms=partnerExcelNumber(partnerAuditAnswer(visit,'Réformes suite au vêlage — nombre/an'));set(4,`${col}11`,births&&difficult!=null?Math.round(difficult/births*1000)/10:null);set(4,`${col}12`,cows&&postCalvingReforms!=null?Math.round(postCalvingReforms/cows*1000)/10:null);set(4,`${col}13`,snap.calvingRate);set(4,`${col}14`,partnerExcelNumber(partnerSmartValue(visit,'Poids veaux au sevrage (kg)')));set(4,`${col}15`,partnerExcelNumber(partnerSmartValue(visit,'GMQ jeunes bovins (g/j)')));set(4,`${col}16`,partnerExcelNumber(partnerSmartValue(visit,'Âge moyen vente / abattage (jours)')));set(4,`${col}17`,partnerExcelNumber(partnerSmartValue(visit,'Poids carcasse moyen broutards (kg)')));set(4,`${col}18`,partnerExcelNumber(partnerSmartValue(visit,'Poids carcasse moyen génisses (kg)')));set(4,`${col}19`,partnerExcelNumber(partnerSmartValue(visit,'Poids carcasse moyen réformes (kg)')));set(4,`${col}20`,partnerSmartValue(visit,'Classement moyen des carcasses'));set(4,`${col}21`,partnerAverageMeasure(visit,'colostrumBrix'));set(4,`${col}22`,births?Math.round(calfDeaths/births*1000)/10:null);set(4,`${col}23`,cows?Math.round(adultDeaths/cows*1000)/10:null);set(4,`${col}24`,partnerExcelNumber(rep.abortions)||partnerExcelNumber(partnerSmartValue(visit,'Avortements (nombre/an)')));
  const mortalityPairs=[['0–2 jours',mort.h0_48],['2 jours–1 mois',(partnerExcelNumber(mort.d2_7)||0)+(partnerExcelNumber(mort.d8_30)||0)],['1–6 mois',mort.m1_6],['6–12 mois',mort.m6_12],['12–24 mois',mort.m12_24],['> 24 mois',mort.over24]].map(([k,v])=>[k,partnerExcelNumber(v)||0]);const maxMort=mortalityPairs.sort((x,y)=>y[1]-x[1])[0];set(4,'G22',maxMort&&maxMort[1]?`${maxMort[0]} : ${maxMort[1]} mortalité(s)`:null);set(4,'G24',rep.abortions?`${rep.abortions} avortement(s) importé(s) — cause à préciser`:null);
  const presentRegistry=(reproductionSourceForVisit(visit,db.farms.find(f=>f.id===visit.farmId)).registry||[]).filter(a=>isRegistryAnimalPresent(a,visit.date));const presentCount=presentRegistry.length||st.total||null;const femaleCount=presentRegistry.filter(a=>a.sex==='F').length||cows||null;const pct=(n,d)=>{n=partnerExcelNumber(n);d=partnerExcelNumber(d);return n!=null&&d?Math.round(n/d*1000)/10:null};const diarrCount=partnerAuditAnswer(visit,'Diarrhées néonatales — nombre de veaux atteints/an'),diarrAll=partnerAuditAnswer(visit,'Diarrhées (tous âges) — nombre d’animaux atteints/an'),respCount=partnerAuditAnswer(visit,'Pathologies respiratoires / pneumonies — nombre d’animaux atteints/an'),reprCount=partnerAuditAnswer(visit,'Troubles de reproduction — nombre de femelles atteints/an')||partnerAuditAnswer(visit,'Troubles de reproduction — nombre de femelles atteintes/an'),omphCount=partnerAuditAnswer(visit,'Omphalites / arthrites — nombre de veaux atteints/an');set(4,`${col}25`,pct(diarrCount,births));set(4,`${col}26`,pct(respCount,presentCount));set(4,`${col}27`,pct(reprCount,femaleCount));set(4,`${col}28`,pct(diarrAll||diarrCount,presentCount));set(4,`${col}29`,pct(respCount,presentCount));set(4,`${col}30`,pct(omphCount,births));set(4,`${col}31`,partnerExcelNumber(partnerAuditAnswer(visit,'Usage antiparasitaires (traitements/an)'))||partnerAuditAnswer(visit,'Gestion du parasitisme et recours aux coprologies'));set(4,`${col}32`,partnerExcelNumber(partnerAuditAnswer(visit,'Usage antibiotiques (traitements/UGB/an)')));set(4,`${col}33`,partnerAuditAnswer(visit,'Gestion du parasitisme et recours aux coprologies'));set(4,`${col}34`,partnerExcelNumber(partnerSmartValue(visit,'Concentrés par vache (kg/an)')));set(4,`${col}35`,partnerExcelNumber(partnerSmartValue(visit,'Autonomie fourragère (%)')));set(4,`${col}36`,partnerExcelNumber(partnerSmartValue(visit,'Chargement (UGB/ha)')));set(4,`${col}37`,partnerExcelNumber(partnerSmartValue(visit,'Consommation d’eau (L/animal/jour)')));set(4,`${col}38`,partnerExcelNumber(partnerSmartValue(visit,'Kg viande/vache/an')));set(4,`${col}39`,partnerExcelNumber(partnerSmartValue(visit,'Kg viande/ha')));set(4,`${col}40`,partnerExcelNumber(partnerSmartValue(visit,'Concentrés/kg viande (kg/kg)')));
  // Données technico-économiques partenaire : feuille dédiée. Aucune écriture dans « Suivi tps et budget ».
  const teMap={8:'Produits animaux lait + viande (€ / an)',9:'Aides PAC totales (€ / an)',10:'Prix du lait (€/1000 L)',11:'Lait produit (L / an)',12:'Prix moyen kg carcasse (€)',13:'Total kg carcasse produits (kg / an)',18:'Nombre moyen de vaches sur exercice',19:'Charge aliments / concentrés (€ / an)',20:'Charge minéraux (€ / an)',21:'Frais vétérinaires honoraires + produits (€ / an)',22:'Marge brute atelier élevage (€ / an)',27:'SFP (ha)',28:'Fertilisation (€ / an)',29:'Semences (€ / an)',30:'Traitements cultures (€ / an)',31:'Travaux par tiers (€ / an)',32:'Autres charges SFP bâches ficelles (€ / an)',36:'EBE exploitation (€ / an)',37:'Revenu disponible exploitation (€ / an)',38:'Taux d’endettement (%)'};
  const teCol=col==='C'?'C':col==='D'?'E':'G';Object.entries(teMap).forEach(([row,label])=>set(5,`${teCol}${row}`,partnerExcelNumber(partnerSmartValue(visit,label))));
  // Calendrier : une visite = date, durée sur ferme, intervenants et évolution. Les temps préparation/CR restent internes à l'application.
  const visits=db.visits.filter(v=>v.farmId===visit.farmId).slice().sort((x,y)=>(x.date||'').localeCompare(y.date||''));
  const calInfo=v=>{const st=ensureStudyTracking(v),atts=st.attendees||[],by=r=>atts.filter(a=>normalizeSearchText(a.role||'').includes(r));const fmt=arr=>arr.map(a=>[a.name,a.organization,a.timeHours?`${String(a.timeHours).replace('.',',')} h`:''].filter(Boolean).join(' — ')).join(' ; ');const others=atts.filter(a=>!['veterinaire','technicien gds','technicien chambre','eleveur'].some(r=>normalizeSearchText(a.role||'').includes(r)));const gds=by('technicien gds');const onSite=numE(st.gdsTime?.onSite)||(gds.length?Math.max(...gds.map(a=>numE(a.timeHours))):0);const changes=(st.farmerChanges||[]).filter(x=>x.action).map(x=>`${x.action}${x.date?' ('+formatDate(x.date)+')':''}`).join(' ; ');return {duration:onSite||'',period:st.periodTarget||v.type||'',animator:[v.technician||'',others.length?`Autres : ${fmt(others)}`:''].filter(Boolean).join('\n'),cda:fmt(by('technicien chambre')),vet:fmt(by('veterinaire')),expert:fmt(atts.filter(a=>normalizeSearchText(a.role||'').includes('expert gds'))),evolution:changes||v.previousVisitReview?.summary||partnerVisitSummary(v).objectives||''};};
  const initial=visits[0];if(initial){const ci=calInfo(initial);set(2,'B2',formatDate(initial.date));set(2,'B3',ci.duration);set(2,'B4',ci.animator);set(2,'B5',ci.cda);set(2,'B6',ci.vet);set(2,'B7',ci.expert);}
  const final=visits.find(v=>/final/i.test(v.type||''));const followVisits=visits.filter(v=>v!==initial&&v!==final).slice(0,6);const followRows=[10,19,28,37,46,55];followVisits.forEach((v,i)=>{const row=followRows[i];if(!row)return;const ci=calInfo(v);set(2,`B${row}`,formatDate(v.date));set(2,`B${row+1}`,ci.duration);set(2,`B${row+2}`,ci.period);set(2,`B${row+3}`,ci.animator);set(2,`B${row+4}`,ci.cda);set(2,`B${row+5}`,ci.vet);set(2,`B${row+6}`,ci.evolution);});
  if(final){const ci=calInfo(final),ps=partnerVisitSummary(final);set(2,'E10',formatDate(final.date));set(2,'E11',ci.duration);set(2,'E12',ci.animator);set(2,'E13',ci.cda);set(2,'E14',ci.vet);set(2,'E15',ci.evolution);set(2,'E16',ps.advice||ps.objectives);}
  // Conseil ASG
  if(initial){const s=partnerVisitSummary(initial);set(3,'A3',s.expectations);set(3,'A13',s.problems);set(3,'A23',s.advice);set(3,'A36',s.objectives);}
  const followCols=['C','E','G','J','L','N'];visits.slice(1,7).forEach((v,i)=>{const c=followCols[i];if(!c)return;const s=partnerVisitSummary(v),review=v.previousVisitReview;const done=(review?.items||[]).map(x=>`${x.status||'À vérifier'} — ${x.text}${x.comment?` : ${x.comment}`:''}`).join('\n');set(3,`${c}3`,done||s.expectations);set(3,`${c}13`,s.problems);set(3,`${c}26`,s.advice);});if(final){const s=partnerVisitSummary(final);set(3,'C42',s.objectives);set(3,'C54',s.advice);}
  // IMPORTANT partenaire : ne jamais écrire dans l’onglet « Suivi tps et budget ».

  for(const write of writes)await write();for(const [path,entry] of Object.entries(cache))zip.file(path,new XMLSerializer().serializeToString(entry.doc));
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`PASSAGE-${slugify(farm.name)}-${visit.date||'visite'}.xlsx`;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);visit.generatedReports=Array.isArray(visit.generatedReports)?visit.generatedReports:[];visit.generatedReports.unshift({id:uid('report'),type:'Fichier partenaire PASSAGE',format:'Excel',createdAt:new Date().toISOString()});saveDatabase(db);showToast('Fichier partenaire Excel généré. Vérifiez les champs laissés vides avant transmission.');
}
function reportOptionsFromUi(type){
  if(type==='farmer')return {};
  const prefix=type==='expert'?'expert':'technical';
  const checked=(key,def=true)=>{const el=document.getElementById(`report-${prefix}-${key}`);return el?el.checked:def;};
  return {rawMeasurements:checked('raw',type==='technical'),observations:checked('observations',true),analysis:checked('analysis',type==='expert'),reasoning:checked('reasoning',type==='expert'),reproduction:checked('reproduction',true),reproductionDetails:checked('reproduction-details',type==='expert'),feeding:checked('feeding',true),building:checked('building',true),audit:checked('audit',type==='technical'),herddata:checked('herddata',true),metabolic:checked('metabolic',true),parasitism:checked('parasitism',true),photos:checked('photos',false)};
}
function reportOptionPanel(prefix,title,subtitle,defaults={}){
  const box=(key,label)=>`<label><input type="checkbox" id="report-${prefix}-${key}" ${defaults[key]?'checked':''}> ${label}</label>`;
  return `<article class="card report-options-card"><h3>${title}</h3><p class="muted">${subtitle}</p><div class="report-options">${box('raw','Mesures individuelles + couleurs')}${box('observations','Observations individuelles')}${box('analysis','Calculs, analyses & synthèses')}${box('reasoning','Raisonnement regroupé')}${box('audit','Audit / toutes les questions-réponses')}${box('reproduction','Reproduction')}${box('reproduction-details','Détail vaches à problème')}${box('feeding','Alimentation')}${box('building','Bâtiment & eau')}${box('herddata','Données technico-économiques + graphiques')}${box('metabolic','Profil métabolique')}${box('parasitism','Parasitisme')}${box('photos','Photos')}</div></article>`;
}
function renderReports(){
  const visit=activeVisit();if(!visit){renderNoActiveVisit('Restitution');return;}
  visit.generatedReports=Array.isArray(visit.generatedReports)?visit.generatedReports:[];
  const technicalDefaults={raw:true,observations:true,analysis:false,reasoning:false,audit:true,reproduction:true,'reproduction-details':false,feeding:true,building:true,herddata:true,metabolic:true,parasitism:true,photos:false};
  const expertDefaults={raw:false,observations:true,analysis:true,reasoning:true,audit:false,reproduction:true,'reproduction-details':true,feeding:true,building:true,herddata:true,metabolic:true,parasitism:true,photos:false};
  app.innerHTML=`<div class="section-title"><div><h2>Restitution</h2><div class="muted">Trois niveaux distincts : synthèse éleveur, relevé détaillé de l’audit, puis analyse/interprétation experte.</div></div><span class="badge autosave">v14.6.21.68</span></div>${activeVisitBanner(visit)}<section class="report-choice-grid"><article class="card report-choice"><div class="report-choice-icon">👨‍🌾</div><h3>Rapport Éleveur</h3><p>Résumé, points forts, points à améliorer et actions principales.</p><div class="actions"><button class="btn" data-report-pdf="farmer">PDF / Imprimer</button><button class="btn secondary" data-report-word="farmer">Word modifiable</button></div></article><article class="card report-choice"><div class="report-choice-icon">👨‍⚕️</div><h3>Rapport Technique</h3><p>Relevé de ce qui a été fait : mesures, observations, questions de l’audit, données terrain.</p><div class="actions"><button class="btn" data-report-pdf="technical">PDF / Imprimer</button><button class="btn secondary" data-report-word="technical">Word modifiable</button></div></article><article class="card report-choice"><div class="report-choice-icon">🎓</div><h3>Rapport Expert</h3><p>Calculs, synthèses, interprétations et raisonnement regroupé par problématique.</p><div class="actions"><button class="btn" data-report-pdf="expert">PDF / Imprimer</button><button class="btn secondary" data-report-word="expert">Word modifiable</button></div></article></section><section class="report-options-grid">${reportOptionPanel('technical','Options du rapport Technique','Réglages indépendants du rapport Expert.',technicalDefaults)}${reportOptionPanel('expert','Options du rapport Expert','Réglages indépendants du rapport Technique.',expertDefaults)}</section><section class="card partner-export-card"><div class="section-title"><div><h3>Fichier partenaire PASSAGE</h3><div class="muted">Génère une copie du modèle Excel en complétant automatiquement les informations disponibles.</div></div></div><div class="row"><div class="field"><label>Colonne du bilan sanitaire</label><select id="partner-export-phase"><option value="auto">Détection automatique</option><option value="initial">Audit initial</option><option value="intermediate">Intermédiaire</option><option value="final">Audit final</option></select></div><div class="field partner-export-action"><label>&nbsp;</label><button class="btn primary" id="export-partner-excel">Exporter le fichier partenaire Excel</button></div></div><p class="muted">Les onglets Données exploitation, Calendrier des travaux, Conseil ASG, Bilan sanitaire et Données technico-économiques sont complétés quand les données sont disponibles. L’onglet « Suivi tps et budget » n’est jamais modifié. Les données absentes restent vides.</p></section><section class="card"><div class="section-title"><div><h3>Plan d’action sur une page</h3><div class="muted">Export court destiné au suivi avec l’éleveur.</div></div><button class="btn" id="print-action-report">Imprimer / PDF</button></div></section><section class="card"><h3>Historique des exports</h3>${visit.generatedReports.length?`<div class="report-history">${visit.generatedReports.slice(0,12).map(r=>`<div><strong>${escapeHtml(r.type)}</strong><span>${escapeHtml(r.format)} · ${formatDateTime(r.createdAt)}</span></div>`).join('')}</div>`:'<div class="empty">Aucun export enregistré pour cette visite.</div>'}</section>`;
  app.querySelectorAll('[data-report-pdf]').forEach(b=>b.onclick=()=>{const type=b.dataset.reportPdf;openReportWindow(visit,type,reportOptionsFromUi(type));visit.generatedReports.unshift({id:uid('report'),type,format:'PDF / impression',createdAt:new Date().toISOString()});saveDatabase(db);});
  app.querySelectorAll('[data-report-word]').forEach(b=>b.onclick=()=>{const type=b.dataset.reportWord;downloadWordReport(visit,type,reportOptionsFromUi(type));});
  document.getElementById('export-partner-excel')?.addEventListener('click',async()=>{const btn=document.getElementById('export-partner-excel');btn.disabled=true;const old=btn.textContent;btn.textContent='Génération…';try{await exportPartnerWorkbook(visit,document.getElementById('partner-export-phase')?.value||'auto');}catch(err){console.error(err);alert('Impossible de générer le fichier partenaire. Vérifiez que tous les fichiers de la version ont été déployés.');}finally{btn.disabled=false;btn.textContent=old;}});
  document.getElementById('print-action-report').onclick=()=>{const c=ensureVisitConclusion(visit),w=window.open('','_blank');if(!w){showToast('Autorisez les fenêtres surgissantes.');return;}w.document.write(`<!doctype html><html><head><meta charset="utf-8"><style>${fullReportStyles()}</style></head><body><button onclick="window.print()">Imprimer / Enregistrer en PDF</button>${reportHeader(visit,'Plan d’action','Synthèse sur une page')}<section class="report-section"><h2>Actions décidées</h2><table><thead><tr><th>Action</th><th>Décision</th><th>Commentaire</th><th>Réalisée</th></tr></thead><tbody>${(c.priorities||[]).filter(a=>a.text).map(a=>`<tr><td>${escapeHtml(a.text)}</td><td>${escapeHtml(a.decision||'')}</td><td>${escapeHtml(a.comment||'')}</td><td>☐</td></tr>`).join('')}</tbody></table><h2>À vérifier lors de la prochaine visite</h2>${reportList(c.next)}</section></body></html>`);w.document.close();};
}


// V11.10 — import des données techniques issues d'autres logiciels
let herdImportPreview = null;
let herdImportReadToken = 0;
let herdLibraryOpen = false;
let herdCsvDetailOpen = false; // conserve l'ouverture des graphiques malgré une synchro cloud

function normalizeCsvHeader(value='') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[’']/g,"'").replace(/[^a-z0-9]+/g,' ').trim();
}
function parseFrenchNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/\s/g,'').replace(',','.'));
  return Number.isFinite(n) ? n : null;
}
function parseCsvText(text) {
  const clean = text.replace(/^\uFEFF/,'');
  const firstLine = clean.split(/\r?\n/,1)[0] || '';
  const delimiter = (firstLine.match(/;/g)||[]).length >= (firstLine.match(/,/g)||[]).length ? ';' : ',';
  const rows=[]; let row=[], cell='', quoted=false;
  for(let i=0;i<clean.length;i++){
    const ch=clean[i], next=clean[i+1];
    if(ch==='"' && quoted && next==='"'){cell+='"';i++;continue;}
    if(ch==='"'){quoted=!quoted;continue;}
    if(ch===delimiter && !quoted){row.push(cell);cell='';continue;}
    if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&next==='\n')i++;row.push(cell);cell='';if(row.some(v=>v!==''))rows.push(row);row=[];continue;}
    cell+=ch;
  }
  if(cell!==''||row.length){row.push(cell);if(row.some(v=>v!==''))rows.push(row);}
  const headers=(rows.shift()||[]).map(h=>h.trim());
  return rows.map(values=>Object.fromEntries(headers.map((h,i)=>[h,(values[i]||'').trim()])));
}
function rowLookup(row) {
  const entries=Object.entries(row); const normalized=new Map(entries.map(([k,v])=>[normalizeCsvHeader(k),v]));
  return {
    exact:(...names)=>{for(const name of names){const v=normalized.get(normalizeCsvHeader(name));if(v!==undefined&&v!=='')return v;}return '';},
    includes:(tokens, period='')=>{const wanted=tokens.map(normalizeCsvHeader);const per=normalizeCsvHeader(period);for(const [k,v] of normalized){if(v!==''&&wanted.every(t=>k.includes(t))&&(!per||k.includes(per)))return v;}return '';},
    entries
  };
}
function periodValue(lookup, labelTokens, period) {
  const p=normalizeCsvHeader(period);
  for(const [key,value] of lookup.entries){const n=normalizeCsvHeader(key);if(value!==''&&labelTokens.every(t=>n.includes(normalizeCsvHeader(t)))&&n.endsWith(`periode ${p}`))return parseFrenchNumber(value);}
  return null;
}
function extractHerdRow(row, fileName='') {
  const l=rowLookup(row); const periods=['N-2','N-1','N'];
  const monthly=(kind,period)=>Array.from({length:12},(_,i)=>periodValue(l,['nombre','mouvements',kind,'mois',String(i+1)],period));
  const result={
    id:uid('herdimport'), sourceFile:fileName, importedAt:new Date().toISOString(), rawHeaderCount:Object.keys(row).length,
    identity:{
      holder:l.exact('Nom du détenteur','Nom détenteur','Eleveur','Éleveur'), farmNumber:l.exact("Numéro d'exploitation","N° exploitation",'Numero exploitation'), holderNumber:l.exact('Numéro de détenteur','N° détenteur','Numero detenteur'), siret:l.exact('N° SIRET','SIRET'), commune:l.exact('Commune'), postalCode:l.exact('Code postal'), phone:l.exact('Numéro portable','Telephone portable','Téléphone'), email:l.exact('Adresse mail','Email'), production:l.exact('Production bovine')
    },
    period:{start:l.exact('Date de début de période','Debut periode'),end:l.exact('Date de fin de période','Fin periode'),generated:l.exact("Date de génération du fichier = date d'impression sur le document",'Date de génération du fichier','Date generation')},
    years:{}, raw:row
  };
  periods.forEach(period=>{
    result.years[period]={
      births:periodValue(l,['nombre total','mouvements','naissance'],period), purchases:periodValue(l,['nombre total','mouvements','achat'],period), deaths:periodValue(l,['nombre total','mouvements','mort'],period),
      monthly:{births:monthly('naissance',period),purchases:monthly('achat',period),deaths:monthly('mort',period)},
      mortality:{h0_48:periodValue(l,['mortalite','0','48 heures'],period),d2_7:periodValue(l,['mortalite','48 heures','7 jours'],period),d8_30:periodValue(l,['mortalite','7 jours','1 mois'],period),m1_6:periodValue(l,['mortalite','1 mois','6 mois'],period),m6_12:periodValue(l,['mortalite','6 mois','12 mois'],period),m12_24:periodValue(l,['mortalite','12 mois','24 mois'],period),over24:periodValue(l,['mortalite','24 mois'],period),total:periodValue(l,['mortalite totale'],period),youngRate:periodValue(l,['taux','mortalite','jeunes','12 mois'],period)},
      reproduction:{firstCalvingAge:periodValue(l,['age','premier velage'],period),ivv:periodValue(l,['intervalle','velage','velage','moyen'],period),ivv390:periodValue(l,['nombre','vaches','ivv','390'],period),ivv420:periodValue(l,['nombre','vaches','ivv','420'],period),abortions:periodValue(l,['nombre','avortements'],period),productivity:periodValue(l,['productivite','numerique','nette'],period)}
    };
  });
  result.current={
    unproductiveFemales:parseFrenchNumber(l.includes(['femelles','improductives'])),
    structure:{
      males0_6:parseFrenchNumber(l.exact('Fin de période - Nombre de mâles présents de 0 à 6 mois')),
      males6_12:parseFrenchNumber(l.exact('Fin de période - Nombre de mâles présents de 6 à 12 mois')),
      males12_24:parseFrenchNumber(l.exact('Fin de période - Nombre de mâles présents de 12 à 24 mois')),
      males24_36:parseFrenchNumber(l.exact('Fin de période - Nombre de mâles présents de 24 à 36 mois')),
      malesOver36:parseFrenchNumber(l.exact('Fin de période - Nombre de mâles présents de plus de 36 mois')),
      females0_6:parseFrenchNumber(l.exact('Fin de période - Nombre de femelles présentes de 0 à 6 mois')),
      females6_12:parseFrenchNumber(l.exact('Fin de période - Nombre de femelles présentes de 6 à 12 mois')),
      females12_24:parseFrenchNumber(l.exact('Fin de période - Nombre de femelles présentes de 12 à 24 mois')),
      females24_36:parseFrenchNumber(l.exact('Fin de période - Nombre de femelles présentes de 24 à 36 mois')),
      femalesOver36:parseFrenchNumber(l.exact('Fin de période - Nombre de femelles présentes de plus de 36 mois')),
      total0_6:parseFrenchNumber(l.exact('Fin de période - Nombre total de bovins présents de 0 à 6 mois')),
      total6_12:parseFrenchNumber(l.exact('Fin de période - Nombre total de bovins présents de 6 à 12 mois')),
      total12_24:parseFrenchNumber(l.exact('Fin de période - Nombre total de bovins présents de 12 à 24 mois')),
      total24_36:parseFrenchNumber(l.exact('Fin de période - Nombre total de bovins présents de 24 à 36 mois')),
      totalOver36:parseFrenchNumber(l.exact('Fin de période - Nombre total de bovins présents de plus de 36 mois')),
      total:parseFrenchNumber(l.exact('Fin de période - Nombre total de bovins présents'))
    },
    movements:{
      births:parseFrenchNumber(l.exact("Nombre de mouvements d'entrée Naissance période N")),
      purchases:parseFrenchNumber(l.exact("Nombre de mouvements d'entrée Achat période N")),
      salesBreeding:parseFrenchNumber(l.exact('Nombre de mouvements de sortie Elevage période N')),
      salesSlaughter:parseFrenchNumber(l.exact('Nombre de mouvements de sortie Boucherie période N')),
      deaths:parseFrenchNumber(l.exact('Nombre de mouvements de sortie Mort période N')),
      otherOutputs:parseFrenchNumber(l.exact('Nombre de mouvements de sortie Autre période N')),
      totalOutputs:parseFrenchNumber(l.exact('Nombre total de mouvements de sortie période N'))
    }
  };
  // Effectifs : conserver tous les champs contenant « effectif » afin de rester compatible avec d'autres exports.
  result.effectives=l.entries.filter(([k,v])=>normalizeCsvHeader(k).includes('effectif')&&v!=='').map(([label,value])=>({label,value:parseFrenchNumber(value)??value}));
  return result;
}
function repairHerdImport(item){
  if(!item||!item.raw||typeof item.raw!=='object')return item;
  const rebuilt=extractHerdRow(item.raw,item.sourceFile||'');
  return {...rebuilt,...item,id:item.id||rebuilt.id,farmId:item.farmId||'',importedAt:item.importedAt||rebuilt.importedAt,raw:JSON.parse(JSON.stringify(item.raw))};
}
function herdImportLabel(item){return `${item.identity.holder||item.identity.farmNumber||'Élevage'} — ${item.period.start||'?'} au ${item.period.end||'?'}`;}
function normalizeHerdNumber(value=''){const digits=String(value||'').replace(/\D/g,'');return digits.length>=6?digits:'';}
function farmHerdNumbers(f){return [f.farmNumber,f.herdNumber,f.edeNumber,f.exploitationNumber,f.farmer,f.name].map(normalizeHerdNumber).filter(Boolean);}
function findFarmForImport(item){const num=normalizeHerdNumber(item.identity.farmNumber||item.identity.holderNumber);const holder=normalizeCsvHeader(item.identity.holder||'');return db.farms.find(f=>(num&&farmHerdNumbers(f).includes(num))||(holder&&[f.farmer,f.name].some(v=>normalizeCsvHeader(v||'')===holder)));}
function repairLegacyFarmNumbers(){let changed=false;db.farms.forEach(f=>{if(!f.farmNumber){const legacy=[f.herdNumber,f.edeNumber,f.exploitationNumber,f.farmer].map(normalizeHerdNumber).find(Boolean);if(legacy){f.farmNumber=legacy;changed=true;}}});if(changed)saveDatabase(db);return changed;}
function repairHerdImportFarmLinks(){repairLegacyFarmNumbers();let linked=0;(db.herdImports||[]).forEach(item=>{if(item.farmId)return;const matched=findFarmForImport(item);if(matched){item.farmId=matched.id;linked++;}});if(linked)saveDatabase(db);return{linked,applied:0};}
function metricCell(value,suffix=''){return value===null||value===undefined?'<span class="muted">—</span>':`<strong>${escapeHtml(String(value).replace('.',','))}${suffix}</strong>`;}
function miniBars(values){const nums=values.map(v=>Number(v)||0),max=Math.max(1,...nums);return `<div class="herd-mini-bars">${nums.map((v,i)=>`<i title="Mois ${i+1} : ${v}" style="height:${Math.max(3,Math.round(v/max*44))}px"></i>`).join('')}</div>`;}

function parseFrenchDate(value=''){const m=String(value||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);return m?new Date(Number(m[3]),Number(m[2])-1,Number(m[1])):null;}
function herdPeriodDisplay(item){const end=parseFrenchDate(item?.period?.end||'');if(!end)return {'N-2':'N-2','N-1':'N-1','N':'N'};const y=end.getFullYear();return {'N-2':String(y-2),'N-1':String(y-1),'N':String(y)};}
function chartValue(v){return v===null||v===undefined||v===''||Number.isNaN(Number(v))?null:Number(v);}
function herdChartEmpty(label='Aucune donnée graphique disponible.'){return `<div class="empty compact">${escapeHtml(label)}</div>`;}
function herdChartLegend(series){return `<div class="herd-chart-legend">${series.map(s=>`<span><b class="legend-square" style="color:${s.color}">■</b>${escapeHtml(s.label)}</span>`).join('')}</div>`;}
function herdLineChartSvg(labels,values,{color='#2F6F73',height=300}={}){
  const vals=values.map(chartValue);if(!vals.some(v=>v!==null))return herdChartEmpty();
  const width=760,pad={top:28,right:24,bottom:50,left:52};
  const real=vals.filter(v=>v!==null);let min=Math.min(...real),max=Math.max(...real);if(min===max){min-=1;max+=1;}
  const range=max-min||1;const plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom;
  const x=i=>pad.left+(labels.length===1?plotW/2:(i*plotW/Math.max(1,labels.length-1)));const y=v=>pad.top+(max-v)/range*plotH;
  let path='';let started=false;vals.forEach((v,i)=>{if(v===null){started=false;return;}path+=`${started?'L':'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;started=true;});
  const grid=Array.from({length:4},(_,i)=>{const gv=min+range*(i/3);const gy=y(gv);return `<line x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${width-pad.right}" y2="${gy.toFixed(1)}" stroke="#d9e4dd" stroke-width="1"/><text x="${pad.left-6}" y="${(gy+4).toFixed(1)}" text-anchor="end" font-size="13" fill="#66756c">${Math.round(gv)}</text>`;}).join('');
  const points=vals.map((v,i)=>v===null?'':`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="5.2" fill="${color}"/><text x="${x(i).toFixed(1)}" y="${(y(v)-10).toFixed(1)}" text-anchor="middle" font-size="14" font-weight="700" fill="#22312a">${String(v).replace('.',',')}</text>`).join('');
  const xLabels=labels.map((lbl,i)=>`<text x="${x(i).toFixed(1)}" y="${height-14}" text-anchor="middle" font-size="14" fill="#4a5750">${escapeHtml(lbl)}</text>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="herd-svg-chart" aria-hidden="true"><rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="#fffafd"/><g>${grid}<line x1="${pad.left}" y1="${height-pad.bottom}" x2="${width-pad.right}" y2="${height-pad.bottom}" stroke="#b9c9bf" stroke-width="1.2"/><path d="${path.trim()}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${points}${xLabels}</g></svg>`;
}
function herdGroupedBarChartSvg(labels,series,{height=300}={}){
  if(!series.length)return herdChartEmpty();
  const width=760,pad={top:32,right:24,bottom:52,left:52};
  const numeric=series.flatMap(s=>s.values.map(chartValue).filter(v=>v!==null));if(!numeric.length)return herdChartEmpty();
  const max=Math.max(...numeric,1),plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom,groupW=plotW/Math.max(1,labels.length),barW=Math.min(26,(groupW-16)/Math.max(1,series.length));
  const y=v=>pad.top+(1-v/max)*plotH;
  const grid=Array.from({length:4},(_,i)=>{const gv=max*(i/3),gy=y(gv);return `<line x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${width-pad.right}" y2="${gy.toFixed(1)}" stroke="#d9e4dd" stroke-width="1"/><text x="${pad.left-6}" y="${(gy+4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b746e">${Math.round(gv)}</text>`;}).join('');
  let bars='';
  labels.forEach((lbl,i)=>{const baseX=pad.left+i*groupW+8;series.forEach((s,j)=>{const v=chartValue(s.values[i]);if(v===null)return;const bh=Math.max(0,(v/max)*plotH);const bx=baseX+j*barW,by=pad.top+plotH-bh;bars+=`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(barW-4).toFixed(1)}" height="${bh.toFixed(1)}" rx="5" fill="${s.color}"/><text x="${(bx+(barW-4)/2).toFixed(1)}" y="${(by-6).toFixed(1)}" text-anchor="middle" font-size="11" fill="#22312a">${String(v).replace('.',',')}</text>`;});bars+=`<text x="${(pad.left+i*groupW+groupW/2).toFixed(1)}" y="${height-14}" text-anchor="middle" font-size="12" fill="#4a5750">${escapeHtml(lbl)}</text>`;});
  return `${herdChartLegend(series)}<svg viewBox="0 0 ${width} ${height}" class="herd-svg-chart" aria-hidden="true"><rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="#fffafd"/><g>${grid}<line x1="${pad.left}" y1="${height-pad.bottom}" x2="${width-pad.right}" y2="${height-pad.bottom}" stroke="#b9c9bf" stroke-width="1.2"/>${bars}</g></svg>`;
}
function herdStackedBarChartSvg(labels,series,{height=300}={}){
  if(!series.length)return herdChartEmpty();
  const width=760,pad={top:32,right:24,bottom:52,left:52};
  const totals=labels.map((_,i)=>series.reduce((sum,s)=>sum+(chartValue(s.values[i])||0),0));if(!totals.some(v=>v>0))return herdChartEmpty();
  const max=Math.max(...totals,1),plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom,barW=Math.min(72,plotW/Math.max(1,labels.length)-18);
  const y=v=>pad.top+(1-v/max)*plotH;
  const grid=Array.from({length:4},(_,i)=>{const gv=max*(i/3),gy=y(gv);return `<line x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${width-pad.right}" y2="${gy.toFixed(1)}" stroke="#d9e4dd" stroke-width="1"/><text x="${pad.left-6}" y="${(gy+4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b746e">${Math.round(gv)}</text>`;}).join('');
  let bars='';
  labels.forEach((lbl,i)=>{const x=pad.left+i*(plotW/Math.max(1,labels.length))+(plotW/Math.max(1,labels.length)-barW)/2;let cumulative=0;series.forEach(s=>{const v=chartValue(s.values[i])||0;if(v<=0)return;const y0=y(cumulative+v),y1=y(cumulative),h=y1-y0;bars+=`<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"/>`;cumulative+=v;});bars+=`<text x="${(x+barW/2).toFixed(1)}" y="${(y(cumulative)-8).toFixed(1)}" text-anchor="middle" font-size="11" fill="#22312a">${cumulative||''}</text><text x="${(x+barW/2).toFixed(1)}" y="${height-14}" text-anchor="middle" font-size="12" fill="#4a5750">${escapeHtml(lbl)}</text>`;});
  return `${herdChartLegend(series)}<svg viewBox="0 0 ${width} ${height}" class="herd-svg-chart" aria-hidden="true"><rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="#fffafd"/><g>${grid}<line x1="${pad.left}" y1="${height-pad.bottom}" x2="${width-pad.right}" y2="${height-pad.bottom}" stroke="#b9c9bf" stroke-width="1.2"/>${bars}</g></svg>`;
}
function herdSummaryCards(item){
  const current=item.current||{},st=current.structure||{},mv=current.movements||{},rep=item.years?.N?.reproduction||{},mort=item.years?.N?.mortality||{};
  return [
    ['Effectif total',st.total],['Naissances (N)',mv.births],['Achats (N)',mv.purchases],['Sorties totales (N)',mv.totalOutputs],['IVV moyen (N)',rep.ivv!==null&&rep.ivv!==undefined?`${String(rep.ivv).replace('.',',')} j`:null],['Mortalité totale (N)',mort.total]
  ].filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([l,v])=>`<div class="calculated-box"><span>${escapeHtml(l)}</span><strong>${escapeHtml(String(v).replace('.',','))}</strong></div>`).join('');
}
function herdChartsHtml(item,{forReport=false}={}){
  const labelsMap=herdPeriodDisplay(item),periods=['N-2','N-1','N'];const labels=periods.map(p=>labelsMap[p]||p);
  const ivv=periods.map(p=>item.years?.[p]?.reproduction?.ivv);
  const movements=[
    {label:'Naissances',color:'#3F7C85',values:periods.map(p=>item.years?.[p]?.births)},
    {label:'Achats',color:'#7AA37A',values:periods.map(p=>item.years?.[p]?.purchases)},
    {label:'Mortalités',color:'#C9795A',values:periods.map(p=>item.years?.[p]?.deaths)}
  ];
  const mortalitySeries=[
    {label:'0–2 j',color:'#3F6F8F',values:periods.map(p=>item.years?.[p]?.mortality?.h0_48)},
    {label:'2 j – 1 mois',color:'#C9795A',values:periods.map(p=>(chartValue(item.years?.[p]?.mortality?.d2_7)||0)+(chartValue(item.years?.[p]?.mortality?.d8_30)||0))},
    {label:'1–6 mois',color:'#8A9A91',values:periods.map(p=>item.years?.[p]?.mortality?.m1_6)},
    {label:'6–12 mois',color:'#D6A84B',values:periods.map(p=>item.years?.[p]?.mortality?.m6_12)},
    {label:'12–24 mois',color:'#6C8FB5',values:periods.map(p=>item.years?.[p]?.mortality?.m12_24)},
    {label:'> 24 mois',color:'#5F8A6B',values:periods.map(p=>item.years?.[p]?.mortality?.over24)}
  ];
  return `<div class="herd-chart-grid${forReport?' report-mode':''}">
    <article class="card herd-chart-card"><h4>Évolution IVV</h4><p class="muted">Intervalle vêlage-vêlage moyen par année.</p>${herdLineChartSvg(labels,ivv,{color:'#2F6F73'})}</article>
    <article class="card herd-chart-card"><h4>Répartition des mortalités par classe d’âge</h4><p class="muted">Empilé par période importée.</p>${herdStackedBarChartSvg(labels,mortalitySeries)}</article>
    <article class="card herd-chart-card"><h4>Mouvements du troupeau</h4><p class="muted">Naissances, achats et mortalités enregistrées.</p>${herdGroupedBarChartSvg(labels,movements)}</article>
  </div>`;
}
function linkedHerdImportForVisit(visit){const linked=ensureAuditGlobal(visit).importedHerdData;if(linked?.snapshot)return repairHerdImport(linked.snapshot);const sourceId=linked?.sourceId;const item=sourceId?(db.herdImports?.find(x=>x.id===sourceId)||null):null;if(item&&linked&&!linked.snapshot){linked.snapshot=JSON.parse(JSON.stringify(item));saveDatabase(db);}return item;}
function reportHerdDataHtml(visit){const item=linkedHerdImportForVisit(visit);if(!item)return '<p class="report-empty">Aucune donnée élevage importée pour cette exploitation.</p>';return `<div class="report-kpis">${herdSummaryCards(item)}</div><article class="report-subsection"><h3>Origine des données élevage</h3><p><strong>Fichier :</strong> ${escapeHtml(item.sourceFile||'CSV')}<br><strong>Période :</strong> ${escapeHtml(item.period?.start||'—')} au ${escapeHtml(item.period?.end||'—')}<br><strong>Importé le :</strong> ${escapeHtml(formatDateTime(item.importedAt))}</p></article>${herdChartsHtml(item,{forReport:true})}`;}

function latestVisitForFarm(farmId){return db.visits.filter(v=>v.farmId===farmId).slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''))[0]||null;}
function importedValue(value){return value===null||value===undefined||value===''?'':String(value);}
function setIfBlank(obj,key,value,changes,label,overwrite=false){if(value===null||value===undefined||value==='')return;if(overwrite||obj[key]===undefined||obj[key]===null||obj[key]===''){obj[key]=importedValue(value);changes.push(label);}}
function appendImportedEconomic(arr,row,sourceId){if(!row.quantity)return;const existing=arr.find(x=>x.importSourceId===sourceId&&x.importKey===row.importKey);if(existing)Object.assign(existing,row);else arr.push({...row,id:uid('econ'),importSourceId:sourceId});}
function cloneImportValue(value){return value===undefined?null:JSON.parse(JSON.stringify(value));}
function getPathValue(root,path){return path.reduce((cur,key)=>cur==null?undefined:cur[key],root);}
function setPathValue(root,path,value){let cur=root;for(let i=0;i<path.length-1;i++){const key=path[i];if(!cur[key]||typeof cur[key]!=='object')cur[key]={};cur=cur[key];}cur[path[path.length-1]]=cloneImportValue(value);}
function rememberImportedField(a,path,newValue,sourceId){
  a.importedHerdFieldState=Array.isArray(a.importedHerdFieldState)?a.importedHerdFieldState:[];
  const key=path.join('.');
  let state=a.importedHerdFieldState.find(x=>x.key===key&&x.sourceId===sourceId);
  if(!state){state={key,path:[...path],sourceId,previousValue:cloneImportValue(getPathValue(a,path))};a.importedHerdFieldState.push(state);}
  state.importedValue=cloneImportValue(newValue);
}
function setImportedField(a,path,value,sourceId,changes,label,overwrite=false){
  if(value===null||value===undefined||value==='')return;
  const current=getPathValue(a,path);
  if(overwrite||current===undefined||current===null||current===''){
    rememberImportedField(a,path,importedValue(value),sourceId);
    setPathValue(a,path,importedValue(value));
    changes.push(label);
  }
}
function removeHerdImportFromVisit(visit,sourceId=''){
  const a=ensureAuditGlobal(visit),oldId=sourceId||a.importedHerdData?.sourceId||'';
  if(!oldId)return 0;let removed=0;
  const states=(a.importedHerdFieldState||[]).filter(x=>x.sourceId===oldId);
  states.slice().reverse().forEach(state=>{
    const current=getPathValue(a,state.path||String(state.key||'').split('.'));
    if(JSON.stringify(current)===JSON.stringify(state.importedValue)){
      setPathValue(a,state.path||String(state.key||'').split('.'),state.previousValue??'');removed++;
    }
  });
  a.importedHerdFieldState=(a.importedHerdFieldState||[]).filter(x=>x.sourceId!==oldId);
  ['purchases','sales'].forEach(k=>{const before=(a[k]||[]).length;a[k]=(a[k]||[]).filter(x=>x.importSourceId!==oldId);removed+=before-a[k].length;});
  a.importedHerdData=null;visit.updatedAt=new Date().toISOString();return removed;
}
function applyHerdImportToVisit(item,visit,overwrite=false){
  item=repairHerdImport(JSON.parse(JSON.stringify(item)));
  const a=ensureAuditGlobal(visit),changes=[],st=item.current?.structure||{},mv=item.current?.movements||{},yr=item.years?.N||{},mort=yr.mortality||{},rep=yr.reproduction||{};
  if(a.importedHerdData?.sourceId&&a.importedHerdData.sourceId!==item.id)removeHerdImportFromVisit(visit,a.importedHerdData.sourceId);
  setImportedField(a,['renewal','cowsTotal'],st.femalesOver36,item.id,changes,'Vaches / femelles de plus de 36 mois',overwrite);
  setImportedField(a,['renewal','calvesUnder6'],st.total0_6,item.id,changes,'Veaux de moins de 6 mois',overwrite);
  setImportedField(a,['renewal','heifers6_12'],st.females6_12,item.id,changes,'Génisses de 6 à 12 mois',overwrite);
  setImportedField(a,['renewal','heifers12_24'],st.females12_24,item.id,changes,'Génisses de 12 à 24 mois',overwrite);
  setImportedField(a,['renewal','replacementHeifers'],((st.females6_12??0)+(st.females12_24??0))||null,item.id,changes,'Potentiel de génisses de renouvellement 6–24 mois',overwrite);
  setImportedField(a,['renewal','annualReforms'],mv.salesSlaughter,item.id,changes,'Réformes / sorties boucherie',overwrite);
  const mortalityMap={'0–2 jours':mort.h0_48,'2 jours–1 mois':((mort.d2_7??0)+(mort.d8_30??0))||null,'1–6 mois':mort.m1_6,'6–12 mois':mort.m6_12,'12–24 mois':mort.m12_24,'> 24 mois':mort.over24};
  Object.entries(mortalityMap).forEach(([cl,v])=>{
    if(v===null||v===undefined)return;const r=a.mortality[cl];
    if(overwrite||!r.count){
      rememberImportedField(a,['mortality',cl,'count'],importedValue(v),item.id);setPathValue(a,['mortality',cl,'count'],importedValue(v));
      const comment=`Donnée importée (${item.sourceFile||'CSV'}, période N).`;
      rememberImportedField(a,['mortality',cl,'comment'],comment,item.id);setPathValue(a,['mortality',cl,'comment'],comment);changes.push(`Mortalité ${cl}`);
    }
  });
  a.answers['Âge moyen au premier vêlage']=a.answers['Âge moyen au premier vêlage']||{};
  if(rep.firstCalvingAge!==null&&rep.firstCalvingAge!==undefined&&(overwrite||!a.answers['Âge moyen au premier vêlage'].answer)){
    setImportedField(a,['answers','Âge moyen au premier vêlage','answer'],rep.firstCalvingAge,item.id,changes,'Âge au premier vêlage',true);
    const c=`Valeur importée depuis ${item.sourceFile||'CSV'} (période N), unité : mois.`;rememberImportedField(a,['answers','Âge moyen au premier vêlage','comment'],c,item.id);setPathValue(a,['answers','Âge moyen au premier vêlage','comment'],c);
  }
  a.answers['Intervalle vêlage-vêlage']=a.answers['Intervalle vêlage-vêlage']||{};
  if(rep.ivv!==null&&rep.ivv!==undefined&&(overwrite||!a.answers['Intervalle vêlage-vêlage'].answer)){
    setImportedField(a,['answers','Intervalle vêlage-vêlage','answer'],rep.ivv,item.id,changes,'IVV',true);
    const c=`IVV > 390 j : ${rep.ivv390??'—'} ; IVV > 420 j : ${rep.ivv420??'—'}. Valeur importée, unité : jours.`;rememberImportedField(a,['answers','Intervalle vêlage-vêlage','comment'],c,item.id);setPathValue(a,['answers','Intervalle vêlage-vêlage','comment'],c);
  }
  appendImportedEconomic(a.purchases,{importKey:'animals',product:'Autre',detail:'Achats de bovins',quantity:mv.purchases,unit:'animaux',unitPrice:'',partner:'',comment:'Quantité importée – période N'},item.id);
  appendImportedEconomic(a.sales,{importKey:'breeding',product:'Reproducteurs',detail:'Vente pour élevage / reproduction',quantity:mv.salesBreeding,unit:'animaux',unitPrice:'',partner:'Débouché élevage',comment:'Quantité importée – période N'},item.id);
  appendImportedEconomic(a.sales,{importKey:'slaughter',product:'Vaches de réforme',detail:'Vente / réforme boucherie',quantity:mv.salesSlaughter,unit:'animaux',unitPrice:'',partner:'Débouché boucherie',comment:'Quantité importée – période N'},item.id);
  appendImportedEconomic(a.sales,{importKey:'other',product:'Autre',detail:'Autres sorties',quantity:mv.otherOutputs,unit:'animaux',unitPrice:'',partner:'Autre débouché',comment:'Nature du débouché à préciser pendant la visite'},item.id);
  const frozen=JSON.parse(JSON.stringify(item));
  a.importedHerdData={sourceId:item.id,importInstanceId:item.importInstanceId||item.id,sourceFile:item.sourceFile||'',period:cloneImportValue(item.period||{}),snapshot:frozen,appliedAt:new Date().toISOString(),changes:[...changes],summary:{totalHerd:st.total,births:mv.births,purchases:mv.purchases,totalOutputs:mv.totalOutputs,mortalityTotal:mort.total,mortalityYoungRate:mort.youngRate,abortions:rep.abortions,productivity:rep.productivity,unproductiveFemales:item.current?.unproductiveFemales}};
  visit.updatedAt=new Date().toISOString();saveDatabase(db);return changes;
}
function herdAuditLinkHtml(item){const visits=db.visits.filter(v=>v.farmId===item.farmId).slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));const farm=db.farms.find(f=>f.id===item.farmId);const relink=`<div class="herd-relink"><div class="field"><label>Exploitation liée à cet import</label><select data-relink-herd-import="${item.id}"><option value="">Choisir…</option>${db.farms.map(f=>`<option value="${f.id}" ${f.id===item.farmId?'selected':''}>${escapeHtml(f.name)}${f.farmNumber?` — EDE ${escapeHtml(f.farmNumber)}`:''}</option>`).join('')}</select></div><button class="btn secondary" data-confirm-relink-herd="${item.id}">Relier à cette exploitation</button></div>`;if(!visits.length)return `${relink}<div class="notice warning"><strong>Aucune visite liée.</strong> L’import est actuellement associé à <strong>${escapeHtml(farm?.name||'une exploitation sans visite')}</strong>. Sélectionnez ci-dessus l’exploitation qui possède la visite.</div>`;const suggested=(activeVisit()?.farmId===item.farmId?activeVisit():latestVisitForFarm(item.farmId));return `${relink}<div class="herd-audit-link"><div class="field"><label>Visite à compléter</label><select data-herd-target-visit="${item.id}">${visits.map(v=>`<option value="${v.id}" ${v.id===suggested?.id?'selected':''}>${formatDate(v.date)} — ${escapeHtml(v.type||'Visite')}</option>`).join('')}</select></div><label class="checkbox-line"><input type="checkbox" data-herd-overwrite="${item.id}"> Remplacer aussi les valeurs déjà saisies</label><button class="btn primary" data-apply-herd-audit="${item.id}">Compléter l’audit avec ces données</button><div class="muted">Par défaut, seules les rubriques vides sont complétées. Les données importées restent identifiées.</div></div>`;}
function renderHerdImportDetail(item){
  const periods=['N-2','N-1','N'];
  return `<section class="card herd-detail"><div class="section-title"><div><h3>${escapeHtml(herdImportLabel(item))}</h3><span class="muted">Importé le ${formatDateTime(item.importedAt)} · ${item.rawHeaderCount} colonnes reconnues</span></div><button class="btn small danger" data-delete-herd-import="${item.id}">Supprimer</button></div>
  <div class="herd-identity"><span><b>N° exploitation</b>${escapeHtml(item.identity.farmNumber||'—')}</span><span><b>Détenteur</b>${escapeHtml(item.identity.holder||'—')}</span><span><b>Commune</b>${escapeHtml(item.identity.commune||'—')}</span><span><b>Fichier source</b>${escapeHtml(item.sourceFile||'—')}</span></div>
  ${herdAuditLinkHtml(item)}
  <div class="grid cols-3 herd-summary-strip">${herdSummaryCards(item)}</div>
  ${herdChartsHtml(item)}
  <h4>Activité et mouvements</h4><div class="table-wrap"><table class="herd-table"><thead><tr><th>Indicateur</th>${periods.map(p=>`<th>${p}</th>`).join('')}</tr></thead><tbody>
  <tr><td>Naissances</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.births)}${miniBars(item.years[p]?.monthly?.births||[])}</td>`).join('')}</tr>
  <tr><td>Achats</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.purchases)}${miniBars(item.years[p]?.monthly?.purchases||[])}</td>`).join('')}</tr>
  <tr><td>Mortalités</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.deaths)}${miniBars(item.years[p]?.monthly?.deaths||[])}</td>`).join('')}</tr></tbody></table></div>
  <h4>Mortalité</h4><div class="table-wrap"><table class="herd-table"><thead><tr><th>Indicateur</th>${periods.map(p=>`<th>${p}</th>`).join('')}</tr></thead><tbody>
  <tr><td>Mortalité totale</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.mortality?.total)}</td>`).join('')}</tr><tr><td>Taux jeunes &lt; 12 mois</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.mortality?.youngRate,' %')}</td>`).join('')}</tr><tr><td>0–48 h</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.mortality?.h0_48)}</td>`).join('')}</tr><tr><td>1–6 mois</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.mortality?.m1_6)}</td>`).join('')}</tr></tbody></table></div>
  <h4>Reproduction</h4><div class="table-wrap"><table class="herd-table"><thead><tr><th>Indicateur</th>${periods.map(p=>`<th>${p}</th>`).join('')}</tr></thead><tbody>
  <tr><td>Âge au premier vêlage</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.reproduction?.firstCalvingAge)}</td>`).join('')}</tr><tr><td>IVV moyen</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.reproduction?.ivv,' j')}</td>`).join('')}</tr><tr><td>Vaches avec IVV &gt; 390 j</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.reproduction?.ivv390)}</td>`).join('')}</tr><tr><td>Vaches avec IVV &gt; 420 j</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.reproduction?.ivv420)}</td>`).join('')}</tr><tr><td>Avortements déclarés</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.reproduction?.abortions)}</td>`).join('')}</tr><tr><td>Productivité numérique nette</td>${periods.map(p=>`<td>${metricCell(item.years[p]?.reproduction?.productivity)}</td>`).join('')}</tr></tbody></table></div>
  ${item.current.unproductiveFemales!==null?`<div class="notice warning"><strong>Femelles improductives :</strong> ${item.current.unproductiveFemales}</div>`:''}
  ${item.effectives.length?`<details><summary><strong>Effectifs importés (${item.effectives.length} indicateurs)</strong></summary><div class="table-wrap"><table><tbody>${item.effectives.map(e=>`<tr><td>${escapeHtml(e.label)}</td><td>${metricCell(e.value)}</td></tr>`).join('')}</tbody></table></div></details>`:''}</section>`;
}
async function importBovineRegistryCsvForVisit(file,visit,farm){
  if(!file||!visit||!farm)throw new Error('Visite ou exploitation non sélectionnée.');
  const animals=importHerdRegistryRows(parseSemicolonCsv(await file.text())),importedAt=new Date().toISOString(),period=reproductionRegistryPeriod(animals),targetNumber=normalizeHerdNumber(farm?.farmNumber||farm?.herdNumber||farm?.ede||''),fileNumbers=[...new Set(animals.map(a=>normalizeHerdNumber(a.farmNumber||'')).filter(Boolean))];
  if(targetNumber&&fileNumbers.length&&!fileNumbers.includes(targetNumber))throw new Error(`ce registre appartient à l’exploitation ${fileNumbers.join(', ')} et non à ${targetNumber}`);
  visit.reproductionRegistry=JSON.parse(JSON.stringify(animals));visit.reproductionRegistrySource={fileName:file.name,importedAt,rowCount:animals.length,period,farmId:visit.farmId,farmNumber:targetNumber};visit.updatedAt=importedAt;saveDatabase(db);return animals;
}


function reproPreparationSnapshot(visit,farm){
  const source=reproductionSourceForVisit(visit,farm),registry=source.registry||[],date=visit?.date||new Date().toISOString().slice(0,10);
  if(!registry.length)return null;
  const present=registry.filter(a=>isRegistryAnimalPresent(a,date)),months=a=>monthsBetweenDates(a.birthDate,date);
  const females24=present.filter(a=>a.sex==='F'&&months(a)!=null&&months(a)>24),females36=present.filter(a=>a.sex==='F'&&months(a)!=null&&months(a)>36);
  const males24=present.filter(a=>a.sex==='M'&&months(a)!=null&&months(a)>24),males36=present.filter(a=>a.sex==='M'&&months(a)!=null&&months(a)>36);
  const end=new Date(date+'T00:00:00'),start=new Date(end);start.setFullYear(start.getFullYear()-1);const startIso=start.toISOString().slice(0,10);
  const births12=registry.filter(a=>a.birthDate&&a.birthDate>=startIso&&a.birthDate<=date);
  const allBirths=registry.filter(a=>a.birthDate&&a.birthDate<=date&&a.motherId);
  const maleById=new Map(registry.filter(a=>a.sex==='M').map(a=>[normalizeAnimalId(a.id),a]));
  // Un père détaillé n'est considéré comme taureau de l'exploitation que s'il existe réellement dans le registre bovins.
  const residentSireMap=new Map(),aiSires=new Set();
  allBirths.filter(c=>c.fatherId).forEach(c=>{
    const key=normalizeAnimalId(c.fatherId),male=maleById.get(key);if(!key)return;
    const conception=c.birthDate?dateShiftDays(c.birthDate,-283):'';
    // Un père n'est détaillé comme taureau de monte naturelle que s'il était réellement présent
    // sur l'exploitation autour de la conception estimée du veau. Un identifiant présent dans
    // l'historique mais hors période de présence reste classé IA / extérieur.
    if(!male||!conception||!isRegistryAnimalPresent(male,conception)){aiSires.add(key);return;}
    if(!residentSireMap.has(key))residentSireMap.set(key,{fatherId:c.fatherId,male,calves:0,mothers:new Set(),birthDates:[],conceptionDates:[]});
    const r=residentSireMap.get(key);r.calves++;if(c.motherId)r.mothers.add(normalizeAnimalId(c.motherId));r.birthDates.push(c.birthDate);r.conceptionDates.push(conception);
  });
  const knownResidentDams=new Set([...residentSireMap.values()].flatMap(r=>[...r.mothers]));
  const sires=[...residentSireMap.values()].map(r=>({fatherId:r.fatherId,calves:r.calves,mothersCount:r.mothers.size,pctFemales:knownResidentDams.size?Math.round(r.mothers.size/knownResidentDams.size*1000)/10:null,present:isRegistryAnimalPresent(r.male,date),workNumber:r.male.workNumber||'',name:r.male.name||'',age:r.male.birthDate?ageLabelAt(r.male.birthDate,date):'',firstBirth:r.birthDates.slice().sort()[0]||'',lastBirth:r.birthDates.slice().sort().at(-1)||''})).sort((a,b)=>b.calves-a.calves);
  const fatherKnown12=births12.filter(c=>c.fatherId).length;
  const fatherKnownAll=allBirths.filter(c=>c.fatherId).length;
  const reproFarm={...farm,herdRegistry:registry},cows=currentReproductionCows(reproFarm,date),heifers36=females36.filter(a=>!(reproductionForCow(reproFarm,a.id)?.calves||[]).some(c=>c.birthDate<=date));
  const cowProblems=cows.filter(r=>(r.daysSinceLast||0)>400||(r.meanIVV||0)>450||(r.deadBefore6||[]).length>=2||(r.firstCalvingAgeMonths||0)>36).sort((a,b)=>sortByWorkNumber(a.cow,b.cow));
  const ivvLe400=cows.filter(r=>r.meanIVV!=null&&r.meanIVV<=400),ivv401to450=cows.filter(r=>r.meanIVV>=401&&r.meanIVV<=450),ivv451to500=cows.filter(r=>r.meanIVV>=451&&r.meanIVV<=500),ivvOver500=cows.filter(r=>r.meanIVV>500);
  const calves=cows.flatMap(r=>r.calves||[]),dead6=calves.filter(c=>c.exitCause==='M'&&c.exitDate&&daysBetweenDates(c.birthDate,c.exitDate)<183);
  const chrono=reproChronology(registry,cows,reproductionRegistryPeriod(registry).from||startIso,date,ensureReproInvestigation(visit));
  return {date,startIso,present,females24,females36,males24,males36,births:births12,allBirths,sires,aiSireCount:aiSires.size,fatherKnown:fatherKnown12,fatherKnownAll,heifers36,cows,cowProblems,ivvLe400,ivv401to450,ivv451to500,ivvOver500,calves,dead6,chrono};
}
function closePrepReproModal(){document.getElementById('prep-repro-modal')?.remove();}
function prepAnimalRow(a,date){return `<tr><td><strong>${escapeHtml(a.workNumber||a.id)}</strong>${a.name?`<br>${escapeHtml(a.name)}`:''}<br><small>${escapeHtml(a.id||'')}</small></td><td>${escapeHtml(a.sex||'—')}</td><td>${a.birthDate?formatDate(a.birthDate):'—'}</td><td>${escapeHtml(ageLabelAt(a.birthDate,date)||'—')}</td><td>${a.entryDate?formatDate(a.entryDate):'Né(e) exploitation / non renseigné'}</td></tr>`;}
function showPrepReproList(title,html){closePrepReproModal();const o=document.createElement('div');o.id='prep-repro-modal';o.className='repro-detail-overlay';o.innerHTML=`<div class="repro-detail-dialog"><div class="section-title"><h3>${escapeHtml(title)}</h3><button class="btn secondary" id="prep-repro-close">✕ Fermer</button></div>${html}</div>`;document.body.appendChild(o);document.getElementById('prep-repro-close').onclick=closePrepReproModal;o.onclick=e=>{if(e.target===o)closePrepReproModal();};}
function prepReproMetric(label,value,key,sub=''){return `<button type="button" class="metric prep-repro-metric" data-prep-repro-list="${key}"><strong>${value}</strong><span>${label}</span>${sub?`<small>${sub}</small>`:''}<small>Cliquer pour le détail</small></button>`;}

function prepReproNativeAnimalTable(rows,date){return `<div class="table-wrap prep-native-detail-table"><table><thead><tr><th>Animal</th><th>Sexe</th><th>Naissance</th><th>Âge</th><th>Entrée</th></tr></thead><tbody>${(rows||[]).map(a=>prepAnimalRow(a,date)).join('')||'<tr><td colspan="5">Aucun animal.</td></tr>'}</tbody></table></div>`;}
function prepReproNativeCowTable(rows,date){return `<div class="table-wrap prep-native-detail-table"><table><thead><tr><th>Vache</th><th>Âge</th><th>Dernier vêlage</th><th>IVV moyen</th><th>IVV complet</th><th>Score</th><th>Pourquoi ?</th></tr></thead><tbody>${(rows||[]).map(z=>{const sd=reproductionScoreDetails(z),why=sd.lines.filter(q=>q.delta<0).map(q=>q.label).join(' · ')||'Pas de pénalité';return `<tr><td><strong>${escapeHtml(z.cow.workNumber||z.cow.id)}</strong>${z.cow.name?`<br>${escapeHtml(z.cow.name)}`:''}<br><small>${escapeHtml(z.cow.id)}</small></td><td>${escapeHtml(ageLabelAt(z.cow.birthDate,date)||'—')}</td><td>${z.lastCalvingDate?formatDate(z.lastCalvingDate):'—'}</td><td>${z.meanIVV??'—'}</td><td>${z.intervals.length?z.intervals.join(' / ')+' j':'—'}</td><td>${sd.score}/100</td><td>${escapeHtml(why)}</td></tr>`}).join('')||'<tr><td colspan="7">Aucune vache.</td></tr>'}</tbody></table></div>`;}
function prepReproNativeMetric(label,value,sub,detailHtml){return `<details class="metric prep-repro-metric prep-repro-native"><summary><strong>${value}</strong><span>${label}</span>${sub?`<small>${sub}</small>`:''}<small class="prep-open-hint">Cliquer pour le détail ▾</small></summary><div class="prep-native-detail"><h4>${escapeHtml(label)}</h4>${detailHtml}</div></details>`;}
function reproPreparationHtml(visit,farm){
  const x=reproPreparationSnapshot(visit,farm);if(!x)return `<section class="card"><h3>🔎 Analyse préparatoire reproduction</h3><div class="empty">Importez d’abord le CSV bovins avec mouvements pour préparer l’enquête reproduction avant la visite.</div></section>`;
  const paternity=x.births.length?Math.round(x.fatherKnown/x.births.length*1000)/10:null,allPat=x.allBirths.length?Math.round(x.fatherKnownAll/x.allBirths.length*1000)/10:null;
  const meanIVV=x.cows.filter(r=>r.meanIVV!=null).length?Math.round(x.cows.filter(r=>r.meanIVV!=null).reduce((a,r)=>a+r.meanIVV,0)/x.cows.filter(r=>r.meanIVV!=null).length):null;
  const alerts=[];
  if(x.heifers36.length)alerts.push(`<li><strong>${x.heifers36.length} femelle(s) &gt;36 mois sans vêlage</strong> : à éclaircir pendant l’audit.</li>`);
  if(x.males24.length===0&&x.females24.length)alerts.push(`<li><strong>Aucun mâle &gt;24 mois présent</strong> dans le registre : vérifier IA, taureau extérieur ou dates de présence.</li>`);
  if(x.chrono?.problems?.length)alerts.push(`<li><strong>${x.chrono.problems.length} période(s) à investiguer</strong> dans la chronologie ; préparer les questions à partir de la plus ancienne.</li>`);
  return `<section class="card repro-prep-analysis"><div class="section-title"><div><h3>🔎 Tableau de bord reproduction — préparation de visite</h3><div class="muted">Analyse des données avant de questionner l’éleveur. Toutes les tuiles sont cliquables pour ouvrir les animaux concernés.</div></div><span class="badge">Préparation</span></div>
  <h4>Structure actuelle</h4><div class="repro-kpi-grid compact">${prepReproNativeMetric('Femelles >24 mois',x.females24.length,'',prepReproNativeAnimalTable(x.females24,x.date))}${prepReproNativeMetric('Femelles >36 mois',x.females36.length,'',prepReproNativeAnimalTable(x.females36,x.date))}${prepReproNativeMetric('Mâles >24 mois',x.males24.length,'',prepReproNativeAnimalTable(x.males24,x.date))}${prepReproNativeMetric('Mâles >36 mois',x.males36.length,'',prepReproNativeAnimalTable(x.males36,x.date))}${prepReproNativeMetric('Femelles >36 m sans vêlage',x.heifers36.length,'',prepReproNativeAnimalTable(x.heifers36,x.date))}${prepReproNativeMetric('Naissances 12 mois',x.births.length,`${formatDate(x.startIso)} → ${formatDate(x.date)}`,prepReproNativeAnimalTable(x.births,x.date))}</div>
  <h4>IVV et performances</h4><div class="repro-kpi-grid compact">${prepReproNativeMetric('Vaches avec IVV calculable',x.cows.filter(r=>r.meanIVV!=null).length,meanIVV?`IVV moyen ${meanIVV} j`:'',prepReproNativeCowTable(x.cows.filter(r=>r.meanIVV!=null),x.date))}${prepReproNativeMetric('IVV ≤400 j',x.ivvLe400.length,'',prepReproNativeCowTable(x.ivvLe400,x.date))}${prepReproNativeMetric('IVV 401–450 j',x.ivv401to450.length,'',prepReproNativeCowTable(x.ivv401to450,x.date))}${prepReproNativeMetric('IVV 451–500 j',x.ivv451to500.length,'',prepReproNativeCowTable(x.ivv451to500,x.date))}${prepReproNativeMetric('IVV >500 j',x.ivvOver500.length,'',prepReproNativeCowTable(x.ivvOver500,x.date))}${prepReproNativeMetric('Vaches à problème',x.cowProblems.length,'',prepReproNativeCowTable(x.cowProblems,x.date))}${prepReproNativeMetric('Veaux morts <6 mois',x.dead6.length,x.calves.length?`${Math.round(x.dead6.length/x.calves.length*1000)/10}% des veaux`:'',prepReproNativeAnimalTable(x.dead6,x.date))}</div>
  ${alerts.length?`<div class="notice warning"><strong>Points à préparer avant les questions terrain</strong><ul>${alerts.join('')}</ul></div>`:''}
  <h4>Paternité — historique complet disponible</h4><div class="notice"><strong>Couverture paternité :</strong> ${allPat??'—'}${allPat!=null?'%':''} sur l’historique · ${paternity??'—'}${paternity!=null?'%':''} sur les 12 derniers mois. <strong>L’absence de paternité n’est pas considérée comme une anomalie</strong> : certains élevages ne réalisent pas ce suivi.</div>
  ${x.sires.length?`<div class="table-wrap"><table><thead><tr><th>Taureau ayant été dans l’exploitation</th><th>Présent actuellement</th><th>Veaux attribués — historique complet</th><th>Mères distinctes</th><th>Part des mères attribuées</th><th>1re / dernière naissance</th></tr></thead><tbody>${x.sires.map(s=>`<tr><td><strong>${escapeHtml(s.name||s.workNumber||s.fatherId)}</strong><br><small>${s.workNumber?`N° travail ${escapeHtml(s.workNumber)} · `:''}${escapeHtml(s.fatherId)}${s.age?` · ${escapeHtml(s.age)}`:''}</small></td><td>${s.present?'✅ oui':'Non actuellement'}</td><td>${s.calves}</td><td>${s.mothersCount}</td><td>${s.pctFemales!=null?s.pctFemales+'%':'—'}</td><td>${s.firstBirth?formatDate(s.firstBirth):'—'} / ${s.lastBirth?formatDate(s.lastBirth):'—'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aucun père correspondant à un mâle ayant figuré dans le registre de l’exploitation.</div>'}
  <p class="muted small-text"><strong>${x.aiSireCount}</strong> père(s) d’IA / père(s) jamais présents dans le registre détecté(s). Ils sont comptés mais volontairement non détaillés. La « part des mères » est calculée parmi les mères ayant au moins un veau attribué à un taureau de l’exploitation ; ce n’est pas un taux exact de saillies.</p>
  <details open><summary><strong>🕰️ Chronologie des performances — analyse croisée</strong></summary><p class="muted">L’application ne remonte plus chaque trimestre isolément : elle regroupe les ruptures nettes et cherche les événements qui les précèdent ou les accompagnent.</p>${reproChronologyInsightHtml(x.chrono||{buckets:[]})}</details></section>`;
}
function bindPrepReproClicks(visit,farm){
  const x=reproPreparationSnapshot(visit,farm);if(!x)return;
  const table=rows=>`<div class="table-wrap"><table><thead><tr><th>Animal</th><th>Sexe</th><th>Naissance</th><th>Âge</th><th>Entrée</th></tr></thead><tbody>${rows.map(a=>prepAnimalRow(a,x.date)).join('')||'<tr><td colspan="5">Aucun animal.</td></tr>'}</tbody></table></div>`;
  const reproRows=r=>`<div class="table-wrap"><table><thead><tr><th>Vache</th><th>Âge</th><th>Dernier vêlage</th><th>IVV moyen</th><th>IVV complet</th><th>Score</th><th>Pourquoi ?</th></tr></thead><tbody>${r.map(z=>{const sd=reproductionScoreDetails(z),why=sd.lines.filter(q=>q.delta<0).map(q=>q.label).join(' · ')||'Pas de pénalité';return `<tr><td><strong>${escapeHtml(z.cow.workNumber||z.cow.id)}</strong>${z.cow.name?`<br>${escapeHtml(z.cow.name)}`:''}<br><small>${escapeHtml(z.cow.id)}</small></td><td>${escapeHtml(ageLabelAt(z.cow.birthDate,x.date)||'—')}</td><td>${z.lastCalvingDate?formatDate(z.lastCalvingDate):'—'}</td><td>${z.meanIVV??'—'}</td><td>${z.intervals.length?z.intervals.join(' / ')+' j':'—'}</td><td>${sd.score}/100</td><td>${escapeHtml(why)}</td></tr>`}).join('')||'<tr><td colspan="7">Aucune vache.</td></tr>'}</tbody></table></div>`;
  const openTile=(b)=>{
    const k=b?.dataset?.prepReproList;if(!k)return;
    let title=b.querySelector('span')?.textContent||'Détail',html='';
    if(k==='f24')html=table(x.females24);else if(k==='f36')html=table(x.females36);else if(k==='m24')html=table(x.males24);else if(k==='m36')html=table(x.males36);else if(k==='h36')html=table(x.heifers36);else if(k==='births')html=table(x.births);else if(k==='dead6')html=table(x.dead6);else if(k==='ivvcalc')html=reproRows(x.cows.filter(r=>r.meanIVV!=null));else if(k==='ivv400')html=reproRows(x.ivvLe400);else if(k==='ivv450')html=reproRows(x.ivv401to450);else if(k==='ivv500')html=reproRows(x.ivv451to500);else if(k==='ivvover')html=reproRows(x.ivvOver500);else if(k==='problems')html=reproRows(x.cowProblems);else html='<div class="empty">Aucun détail disponible.</div>';
    showPrepReproList(title,html);
  };
  // Liaison directe des tuiles : la précédente délégation sur #app pouvait ne pas
  // déclencher selon le rerendu / la cible exacte du clic. Chaque tuile porte
  // maintenant son propre gestionnaire, avec activation clavier en secours.
  app.querySelectorAll('[data-prep-repro-list]').forEach(b=>{
    b.style.cursor='pointer';
    b.setAttribute('aria-haspopup','dialog');
    b.onclick=(ev)=>{ev.preventDefault();ev.stopPropagation();openTile(b);};
    b.onkeydown=(ev)=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();openTile(b);}};
  });
}

function prepImportedAnnualHtml(item){
  if(!item)return '';
  const periods=['N','N-1','N-2'],tile=(label,val,suf='')=>`<article class="metric"><strong>${val==null||val===''?'—':escapeHtml(String(val).replace('.',','))+suf}</strong><span>${escapeHtml(label)}</span></article>`;
  const one=p=>{const y=item.years?.[p]||{},m=y.mortality||{},r=y.reproduction||{};return `<details ${p==='N'?'open':''}><summary><strong>${p} — reproduction et mortalité importées</strong></summary><div class="repro-kpi-grid compact">${tile('Naissances',y.births)}${tile('Mortalité totale',m.total)}${tile('Taux mortalité jeunes <12m',m.youngRate,' %')}${tile('Morts 0–48 h',m.h0_48)}${tile('Morts 1–6 mois',m.m1_6)}${tile('Âge 1er vêlage',r.firstCalvingAge)}${tile('IVV moyen',r.ivv,' j')}${tile('Vaches IVV >390 j',r.ivv390)}${tile('Vaches IVV >420 j',r.ivv420)}${tile('Avortements',r.abortions)}${tile('Productivité numérique',r.productivity)}</div></details>`};
  return `<section class="card"><div class="section-title"><div><h3>📊 Historique technico-économique — reproduction & mortalité</h3><div class="muted">Les indicateurs annuels importés sont regroupés ici pour éviter d’avoir à les rechercher ailleurs dans l’application.</div></div></div>${periods.map(one).join('')}${item.current?.unproductiveFemales!=null?`<button class="metric prep-aggregate-tile" type="button" id="prep-unproductive-aggregate"><strong>${escapeHtml(String(item.current.unproductiveFemales))}</strong><span>Femelles improductives (fichier technico-éco)</span><small>Cliquer pour comprendre la source</small></button>`:''}</section>`;
}


// v14.6.21.68 — estimation économique pré-visite, calculée uniquement sur les données déjà disponibles.
const PREP_MARKET_REFERENCES={
  'Charolaise':{liveKg:6.17,weight:350,label:'Charolaise U 6–12 mois 350 kg',source:'FranceAgriMer — semaine 16/2026'},
  'Limousine':{liveKg:6.10,weight:300,label:'Limousine U 6–12 mois 300 kg',source:'DRAAF Nouvelle-Aquitaine / FranceAgriMer — fin avril 2026'},
  "Blonde d’Aquitaine":{liveKg:6.50,weight:300,label:'Blonde d’Aquitaine U 6–12 mois 300 kg',source:'DRAAF Nouvelle-Aquitaine / FranceAgriMer — fin avril 2026'}
};
function prepCanonicalBreed(raw=''){
  const x=normalizeSearchText(raw||'');
  if(x.includes('charol'))return 'Charolaise';
  if(x.includes('limous'))return 'Limousine';
  if(x.includes('blonde')||x.includes('aquitaine'))return "Blonde d’Aquitaine";
  if(x.includes('aubrac'))return 'Aubrac';
  if(x.includes('salers'))return 'Salers';
  if(x.includes('gascon'))return 'Gasconne';
  if(x.includes('bazada'))return 'Bazadaise';
  return raw||'Autre / croisé';
}
function prepDominantBreed(x){
  const m=new Map();(x?.females24||[]).forEach(a=>{const b=prepCanonicalBreed(a.breed||'Autre / croisé');m.set(b,(m.get(b)||0)+1)});
  return [...m.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'Autre / croisé';
}
function ensurePrepEconomics(farm,x){
  farm.prepEconomicSettings=farm.prepEconomicSettings&&typeof farm.prepEconomicSettings==='object'?farm.prepEconomicSettings:{};
  const e=farm.prepEconomicSettings,detected=prepDominantBreed(x),ref=PREP_MARKET_REFERENCES[detected];
  if(!e.breed)e.breed=detected;
  if(e.calfLiveKg===undefined||e.calfLiveKg==='')e.calfLiveKg=ref?.liveKg||6;
  if(e.calfSaleWeight===undefined||e.calfSaleWeight==='')e.calfSaleWeight=ref?.weight||300;
  if(e.calfValueOverride===undefined)e.calfValueOverride='';
  if(e.calfMortalityTarget===undefined||e.calfMortalityTarget==='')e.calfMortalityTarget=8;
  if(e.ivvTarget===undefined||e.ivvTarget==='')e.ivvTarget=400;
  if(e.adultDeathNetCost===undefined||e.adultDeathNetCost==='')e.adultDeathNetCost=1800;
  return e;
}
function prepEconomicSnapshot(visit,farm){
  const x=reproPreparationSnapshot(visit,farm);if(!x)return null;
  const e=ensurePrepEconomics(farm,x),date=x.date,start=x.startIso,reproFarm={...farm,herdRegistry:reproductionSourceForVisit(visit,farm).registry||[]};
  const calfValue=numE(e.calfValueOverride)>0?numE(e.calfValueOverride):numE(e.calfLiveKg)*numE(e.calfSaleWeight);
  const births=x.births.length,dead=x.dead6.filter(c=>c.birthDate>=start&&c.birthDate<=date).length,actualMort=births?dead/births*100:null,target=numE(e.calfMortalityTarget);
  const excessDead=births&&actualMort!=null?Math.max(0,dead-(births*target/100)):0,calfLoss=excessDead*calfValue;
  const reg=reproductionSourceForVisit(visit,farm).registry||[];
  const adultDeaths=reg.filter(a=>a.exitCause==='M'&&a.exitDate&&a.exitDate>=start&&a.exitDate<=date&&monthsBetweenDates(a.birthDate,a.exitDate)>=24);
  const adultLoss=adultDeaths.length*numE(e.adultDeathNetCost);
  let excessIvvDays=0,ivvCount=0,ivvOver=0;
  x.cows.forEach(r=>{const ds=r.calvingDates||[];for(let i=1;i<ds.length;i++){const endDate=ds[i];if(endDate<start||endDate>date)continue;const d=daysBetweenDates(ds[i-1],ds[i]);if(d==null)continue;ivvCount++;if(d>numE(e.ivvTarget)){ivvOver++;excessIvvDays+=d-numE(e.ivvTarget)}}});
  const missingCalfEq=excessIvvDays/365,ivvLoss=missingCalfEq*calfValue,total=calfLoss+adultLoss+ivvLoss;
  return {x,e,calfValue,births,dead,actualMort,target,excessDead,calfLoss,adultDeaths,adultLoss,excessIvvDays,ivvCount,ivvOver,missingCalfEq,ivvLoss,total};
}
function prepEconomicHtml(visit,farm){
  const z=prepEconomicSnapshot(visit,farm);if(!z)return `<section class="card"><h3>💶 Gestion économique — estimation pré-visite</h3><div class="empty">Importez le registre bovins pour calculer une première estimation économique.</div></section>`;
  const e=z.e,ref=PREP_MARKET_REFERENCES[e.breed];
  const breeds=['Charolaise','Limousine',"Blonde d’Aquitaine",'Aubrac','Salers','Gasconne','Bazadaise','Autre / croisé'];
  const euro=n=>Math.round(n||0).toLocaleString('fr-FR')+' €';
  const mortText=z.actualMort==null?'—':`${z.actualMort.toFixed(1).replace('.',',')} %`;
  return `<section class="card prep-economy-card"><div class="section-title"><div><h3>💶 Gestion économique — estimation pré-visite</h3><div class="muted">Chiffrage volontairement partiel à partir des données déjà disponibles, avant discussion avec l’éleveur.</div></div><span class="badge ${z.total>0?'in-progress':'complete'}">${euro(z.total)} de manque à gagner estimé</span></div>
  <div class="notice"><strong>Lecture :</strong> ce total chiffre uniquement les pertes directement estimables ici. <strong>Il n’inclut pas</strong> le surcoût alimentaire des jours improductifs, les frais vétérinaires, traitements, main-d’œuvre, analyses, baisse de croissance ou autres conséquences indirectes.</div>
  <div class="grid cols-4 prep-econ-settings"><div class="field"><label>Race dominante</label><select data-prep-econ="breed">${breeds.map(b=>`<option value="${escapeHtml(b)}" ${e.breed===b?'selected':''}>${escapeHtml(b)}</option>`).join('')}</select><small>Détectée automatiquement dans le registre, modifiable.</small></div><div class="field"><label>Prix indicatif €/kg vif</label><input data-prep-econ="calfLiveKg" inputmode="decimal" value="${escapeHtml(e.calfLiveKg)}"></div><div class="field"><label>Poids de vente indicatif (kg)</label><input data-prep-econ="calfSaleWeight" inputmode="decimal" value="${escapeHtml(e.calfSaleWeight)}"></div><div class="field"><label>Valeur veau/broutard €/tête (option)</label><input data-prep-econ="calfValueOverride" inputmode="decimal" value="${escapeHtml(e.calfValueOverride||'')}" placeholder="Sinon calcul €/kg × poids"></div></div>
  <p class="muted small-text">${ref?`Référence préremplie : ${escapeHtml(ref.label)} — ${ref.liveKg.toFixed(2).replace('.',',')} €/kg vif, ${escapeHtml(ref.source)}. Ces cotations sont des repères de marché et restent modifiables selon sexe, poids, conformation et débouché.`:'Aucune cotation raciale précise n’est imposée pour cette race : utilisez le prix réellement observé dans l’élevage ou modifiez le €/kg et le poids.'}</p>
  <div class="repro-kpi-grid compact"><article class="card metric"><strong>${mortText}</strong><span>Mortalité veaux &lt;6 mois</span><small>${z.dead}/${z.births} naissance(s) sur 12 mois · repère de calcul ${String(z.target).replace('.',',')} %</small></article><article class="card metric"><strong>${z.adultDeaths.length}</strong><span>Décès bovins ≥24 mois</span><small>Sur les 12 derniers mois</small></article><article class="card metric"><strong>${z.excessIvvDays}</strong><span>Jours d’IVV au-delà de ${e.ivvTarget} j</span><small>${z.ivvOver}/${z.ivvCount} IVV concernés sur 12 mois</small></article><article class="card metric"><strong>${z.missingCalfEq.toFixed(1).replace('.',',')}</strong><span>Veaux théoriques non produits</span><small>Équivalent calculé à partir des jours d’IVV excédentaires</small></article></div>
  <div class="table-wrap"><table class="compact-table"><thead><tr><th>Poste</th><th>Calcul retenu</th><th>Manque à gagner estimé</th></tr></thead><tbody><tr><td><strong>Mortalité veaux au-dessus du repère</strong></td><td>${z.births} naissances · ${z.dead} morts · repère ${String(z.target).replace('.',',')} % → ${z.excessDead.toFixed(1).replace('.',',')} décès excédentaire(s) × ${euro(z.calfValue)}</td><td><strong>${euro(z.calfLoss)}</strong></td></tr><tr><td><strong>Mortalité adulte</strong></td><td>${z.adultDeaths.length} décès ≥24 mois × ${euro(e.adultDeathNetCost)}</td><td><strong>${euro(z.adultLoss)}</strong></td></tr><tr><td><strong>Décalage des IVV</strong></td><td>${z.excessIvvDays} jours au-delà de ${e.ivvTarget} j / 365 = ${z.missingCalfEq.toFixed(2).replace('.',',')} veau(x) théorique(s) × ${euro(z.calfValue)}</td><td><strong>${euro(z.ivvLoss)}</strong></td></tr></tbody><tfoot><tr><th colspan="2">Total minimum estimé</th><th>${euro(z.total)}</th></tr></tfoot></table></div>
  <details class="prep-econ-adjust"><summary><strong>⚙️ Ajuster les hypothèses de calcul</strong></summary><div class="grid cols-3"><div class="field"><label>Repère mortalité veaux (%)</label><input data-prep-econ="calfMortalityTarget" inputmode="decimal" value="${escapeHtml(e.calfMortalityTarget)}"><small>IDELE Mortaliveau : moyenne nationale ≈8 %, avec variation d’environ 5 à 15 % selon la race de la mère.</small></div><div class="field"><label>IVV cible (jours)</label><input data-prep-econ="ivvTarget" inputmode="decimal" value="${escapeHtml(e.ivvTarget)}"></div><div class="field"><label>Perte nette par décès adulte (€)</label><input data-prep-econ="adultDeathNetCost" inputmode="decimal" value="${escapeHtml(e.adultDeathNetCost)}"></div></div></details>
  <div class="notice warning"><strong>À présenter comme ordre de grandeur.</strong> Ce n’est pas une marge comptable certifiée. Le but est d’objectiver l’enjeu avant l’audit, puis d’affiner dans « Marge de progrès » avec les prix réels, coûts alimentaires, frais vétérinaires et autres charges.</div></section>`;
}
function bindPrepEconomics(visit,farm){
  app.querySelectorAll('[data-prep-econ]').forEach(el=>el.addEventListener('change',e=>{const x=reproPreparationSnapshot(visit,farm),s=ensurePrepEconomics(farm,x),k=el.dataset.prepEcon;s[k]=k==='breed'?el.value:numE(el.value);if(k==='breed'){const ref=PREP_MARKET_REFERENCES[s.breed];if(ref){s.calfLiveKg=ref.liveKg;s.calfSaleWeight=ref.weight;s.calfValueOverride='';}}saveDatabase(db);renderHerdData();}));
}

function renderHerdData(){
  db.herdImports=Array.isArray(db.herdImports)?db.herdImports:[];
  db.herdImports=db.herdImports.map(repairHerdImport);saveDatabase(db);
  repairHerdImportFarmLinks();
  const visit=activeVisit();
  if(!visit){
    app.innerHTML=`<div class="section-title"><div><h2>Données technico-économiques</h2><span class="muted">Sélectionnez d’abord une visite.</span></div><span class="badge autosave">v14.6.21.68</span></div><section class="notice warning"><strong>Aucune visite sélectionnée.</strong> Ouvrez une visite avant d’importer ou d’afficher ses données CSV.</section>`;
    return;
  }
  const farm=db.farms.find(f=>f.id===visit.farmId);
  const audit=ensureAuditGlobal(visit);
  const currentSourceId=audit.importedHerdData?.sourceId||'';
  const currentImport=audit.importedHerdData?.snapshot||db.herdImports.find(x=>x.id===currentSourceId)||null;
  const hasCurrentCsv=!!currentImport;
  const registryMeta=visit.reproductionRegistrySource||null,registryCount=(visit.reproductionRegistry||[]).length;
  const compatible=db.herdImports.filter(x=>x.farmId===visit.farmId&&x.id!==currentSourceId).slice().sort((a,b)=>(b.importedAt||'').localeCompare(a.importedAt||''));
  const currentHtml=currentImport?`${prepImportedAnnualHtml(currentImport)}<section class="card"><div class="section-title"><div><h3>CSV associé à cette visite</h3><span class="muted">Un seul fichier est utilisé pour cette visite.</span></div><button class="btn small danger" id="detach-herd-visit">Retirer de la visite</button></div><div class="herd-identity"><span><b>Exploitation</b>${escapeHtml(farm?.name||currentImport.identity?.holder||'—')}</span><span><b>Visite</b>${formatDate(visit.date)} — ${escapeHtml(visit.type||'Visite')}</span><span><b>Fichier source</b>${escapeHtml(currentImport.sourceFile||audit.importedHerdData?.sourceFile||'—')}</span><span><b>Période</b>${escapeHtml(herdImportLabel(currentImport))}</span></div><div class="grid cols-3 herd-summary-strip">${herdSummaryCards(currentImport)}</div><details id="herd-current-detail" ${herdCsvDetailOpen?'open':''}><summary><strong>Voir tous les autres indicateurs du CSV associé</strong></summary>${herdChartsHtml(currentImport)}</details></section>`:`<section class="notice warning"><strong>Aucun CSV associé à cette visite.</strong> Importez un fichier ou choisissez-en un parmi les fichiers de cette exploitation.</section>`;
  const registryImportHtml=`<section class="card import-type-card"><h3>1 · Import CSV bovins de l’exploitation (avec mouvements)</h3><p class="muted">Registre des bovins avec naissances, mouvements, sorties et données nécessaires aux animaux présents et à la reproduction. À importer en préparation de visite.</p><div class="row"><div class="field"><label>Fichier CSV bovins / mouvements</label><input id="prep-registry-csv" type="file" accept=".csv,text/csv"></div><div class="field"><label>État</label><div class="calculated-answer"><strong>${registryCount?registryCount+' bovin(s) importé(s)':'Non importé'}</strong><small>${registryMeta?.fileName?escapeHtml(registryMeta.fileName):'Ce fichier alimentera aussi automatiquement le module Reproduction.'}</small></div></div></div></section>`;
  const importHtml=`<section class="card import-type-card"><h3>2 · Import CSV bilan sanitaire / technico-économique</h3><p class="muted">Fichier de bilan sanitaire utilisé actuellement : mortalités, indicateurs annuels et données technico-économiques. Il est distinct du registre bovins avec mouvements.</p><div class="row"><div class="field"><label>Exploitation de destination</label><input value="${escapeHtml(farm?.name||'')}" disabled></div><div class="field"><label>Fichier CSV</label><input id="herd-csv-input" type="file" accept=".csv,text/csv"></div></div><div id="herd-preview">${herdImportPreview?`<div class="notice"><strong>Fichier sélectionné : ${escapeHtml(herdImportPreview.fileName)}</strong><br>${herdImportPreview.items.length} ligne(s) détectée(s).<div class="actions" style="margin-top:10px"><button class="btn primary" id="confirm-herd-import">Enregistrer et utiliser pour cette visite</button><button class="btn secondary" id="cancel-herd-import">Annuler</button></div></div>`:'<div class="empty">Sélectionnez un CSV pour afficher son aperçu avant validation.</div>'}</div></section>`;
  const libraryHtml=herdLibraryOpen?`<section class="card"><div class="section-title"><div><h3>Autres CSV de cette exploitation</h3><span class="muted">Aucun fichier d’une autre exploitation n’est affiché ici.</span></div><button class="btn secondary small" id="close-herd-library">Fermer</button></div>${compatible.length?compatible.map(item=>`<article class="card" style="margin-top:10px"><div class="section-title"><div><h4>${escapeHtml(herdImportLabel(item))}</h4><span class="muted">${escapeHtml(item.sourceFile||'CSV')} · importé le ${formatDateTime(item.importedAt)}</span></div><button class="btn primary small" data-use-herd-import="${item.id}">Utiliser pour cette visite</button></div><div class="herd-identity"><span><b>N° exploitation</b>${escapeHtml(item.identity?.farmNumber||'—')}</span><span><b>Détenteur</b>${escapeHtml(item.identity?.holder||'—')}</span><span><b>Commune</b>${escapeHtml(item.identity?.commune||'—')}</span></div></article>`).join(''):'<div class="empty">Aucun autre CSV enregistré pour cette exploitation.</div>'}</section>`:'';
  app.innerHTML=`<div class="section-title"><div><h2>Données technico-économiques</h2><span class="muted">Visite du ${formatDate(visit.date)} — ${escapeHtml(farm?.name||'Exploitation')}</span></div><span class="badge autosave">v14.6.21.68</span></div>${registryImportHtml}${reproPreparationHtml(visit,farm)}${prepEconomicHtml(visit,farm)}${currentHtml}<div class="actions"><button class="btn secondary" id="toggle-herd-library">${hasCurrentCsv?'Changer de CSV':'Choisir un CSV déjà importé'}</button></div>${libraryHtml}${importHtml}`;
  bindPrepReproClicks(visit,farm);
  bindPrepEconomics(visit,farm);
  document.getElementById('prep-unproductive-aggregate')?.addEventListener('click',()=>showPrepReproList('Femelles improductives — donnée agrégée',`<div class="notice warning"><strong>Le fichier technico-économique fournit ici uniquement un nombre (${escapeHtml(String(currentImport?.current?.unproductiveFemales??'—'))}).</strong><br>Il ne contient pas l’identité des femelles correspondantes, donc l’application ne peut pas fabriquer une liste. Les listes animales cliquables ci-dessus sont calculées à partir du registre bovins, lorsqu’il permet d’identifier précisément les animaux.</div>`));
  document.getElementById('prep-registry-csv')?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{const animals=await importBovineRegistryCsvForVisit(file,visit,farm);showToast(`${animals.length} bovin(s) importé(s). Le registre est disponible dans Préparation et Reproduction.`);renderHerdData()}catch(err){console.error(err);showToast(`Import bovins impossible : ${err.message}`)}});
  document.getElementById('herd-current-detail')?.addEventListener('toggle',e=>{herdCsvDetailOpen=!!e.currentTarget.open;});
  document.getElementById('toggle-herd-library')?.addEventListener('click',()=>{herdLibraryOpen=!herdLibraryOpen;renderHerdData();});
  document.getElementById('close-herd-library')?.addEventListener('click',()=>{herdLibraryOpen=false;renderHerdData();});
  document.getElementById('detach-herd-visit')?.addEventListener('click',()=>{if(!confirm('Retirer les données de ce CSV de cette visite ? Le fichier restera enregistré dans la bibliothèque de cette exploitation.'))return;removeHerdImportFromVisit(visit,currentSourceId);saveDatabase(db);showToast('CSV retiré uniquement de cette visite.');renderHerdData();});
  app.querySelectorAll('[data-use-herd-import]').forEach(b=>b.onclick=()=>{const item=db.herdImports.find(x=>x.id===b.dataset.useHerdImport);if(!item)return;if(hasCurrentCsv&&currentSourceId!==item.id&&!confirm('Remplacer le CSV actuellement associé à cette visite ?'))return;const changes=applyHerdImportToVisit(item,visit,false);herdLibraryOpen=false;showToast(changes.length?`${changes.length} rubrique(s) mises à jour dans cette visite.`:'CSV associé à cette visite.');renderHerdData();});
  document.getElementById('herd-csv-input')?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;const token=++herdImportReadToken;try{const text=await file.text();if(token!==herdImportReadToken)return;const rows=parseCsvText(text);if(!rows.length)throw new Error('Aucune ligne');herdImportPreview={fileName:file.name,fileSize:file.size,lastModified:file.lastModified,targetFarmId:visit.farmId,items:rows.map(r=>extractHerdRow(r,file.name))};renderHerdData();}catch(err){console.error(err);herdImportPreview=null;alert('Impossible de lire ce CSV. Vérifiez son format.');renderHerdData();}});
  document.getElementById('cancel-herd-import')?.addEventListener('click',()=>{herdImportReadToken++;herdImportPreview=null;renderHerdData();});
  document.getElementById('confirm-herd-import')?.addEventListener('click',()=>{if(!herdImportPreview?.items?.length)return showToast('Aucun fichier prêt à importer.');if(herdImportPreview.targetFarmId!==visit.farmId){herdImportPreview=null;return alert('La visite active a changé pendant la lecture du CSV. Sélectionnez de nouveau le fichier pour éviter toute association à la mauvaise exploitation.');}const importedFile=herdImportPreview.fileName;const farmNumber=normalizeHerdNumber(farm?.farmNumber||farm?.herdNumber||farm?.ede||'');const explicitNumbers=[...new Set(herdImportPreview.items.map(x=>normalizeHerdNumber(x.identity?.farmNumber||'')).filter(Boolean))];let rawItem=farmNumber?herdImportPreview.items.find(x=>normalizeHerdNumber(x.identity?.farmNumber||'')===farmNumber):null;if(farmNumber&&!rawItem&&explicitNumbers.length){return alert(`Import bloqué : le CSV indique l’exploitation ${explicitNumbers.join(', ')} alors que la visite ouverte est liée à ${farmNumber}. Ouvrez la bonne exploitation avant d’importer ce fichier.`);}if(!rawItem&&herdImportPreview.items.length>1){return alert('Import bloqué : plusieurs exploitations sont présentes dans ce CSV et aucune correspondance certaine avec la visite active n’a été trouvée. Renseignez le n° EDE de l’exploitation puis recommencez.');}rawItem=rawItem||herdImportPreview.items[0];let item=repairHerdImport(JSON.parse(JSON.stringify(rawItem)));item.farmId=visit.farmId;item.id=uid('herdimport');item.importInstanceId=uid('csv');item.importedAt=new Date().toISOString();db.herdImports.push(item);saveDatabase(db);herdImportPreview=null;if(hasCurrentCsv&&currentSourceId!==item.id&&!confirm('Cette visite possède déjà un CSV. Le remplacer par le nouveau fichier ?')){showToast(`Fichier « ${importedFile} » enregistré pour cette exploitation, sans modifier la visite.`);return renderHerdData();}const changes=applyHerdImportToVisit(item,visit,false);showToast(`Fichier « ${importedFile} » associé uniquement à cette visite${changes.length?` · ${changes.length} rubrique(s) complétée(s)`:''}.`);renderHerdData();});
}


function supplementSettingsHtml(settings){const products=supplementProducts();return `<section class="card"><div class="section-title"><div><h3>🧂 Minéraux / bolus enregistrés</h3><div class="muted">Composition réutilisable d’un élevage à l’autre. Pour un minéral : mg/kg de produit. Pour un bolus : mg par bolus + durée de libération.</div></div><button class="btn primary" id="add-supp-product">+ Ajouter un produit</button></div>${products.map(p=>`<article class="card compact" data-supp-product="${p.id}"><div class="grid cols-4"><div class="field"><label>Nom</label><input data-supp-field-setting="name" value="${escapeHtml(p.name||'')}"></div><div class="field"><label>Fabricant</label><input data-supp-field-setting="manufacturer" value="${escapeHtml(p.manufacturer||'')}"></div><div class="field"><label>Type</label><select data-supp-field-setting="type">${['Minéral poudre','Seau / pierre','Bolus','Liquide','Autre'].map(x=>`<option ${p.type===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Durée libération (jours, bolus)</label><input inputmode="decimal" data-supp-field-setting="releaseDays" value="${escapeHtml(p.releaseDays||'')}"></div></div><div class="grid cols-4">${['cu','zn','mn','se','co','i'].map(k=>`<div class="field"><label>${MINERAL_LABELS[k]} ${p.type==='Bolus'?'mg/bolus':'mg/kg'}</label><input inputmode="decimal" data-supp-composition="${k}" value="${escapeHtml(p.composition?.[k]??'')}"></div>`).join('')}</div><div class="actions"><button class="btn danger small" data-delete-supp="${p.id}">Supprimer</button></div></article>`).join('')||'<div class="empty">Aucun minéral ou bolus enregistré.</div>'}<h4>Repères internes de couverture</h4><p class="muted small-text">Concentrations cibles indicatives en mg/kg MS. Elles sont modifiables et servent uniquement au calcul d’aide à la décision.</p><div class="grid cols-4">${Object.keys(DEFAULT_MINERAL_TARGETS).map(k=>`<div class="field"><label>${MINERAL_LABELS[k]}</label><input inputmode="decimal" data-min-target="${k}" placeholder="${DEFAULT_MINERAL_TARGETS[k]}" value="${escapeHtml(settings.mineralNeedTargets?.[k]??'')}"></div>`).join('')}</div></section>`;}
function feedReferenceSettingsHtml(settings){const custom=settings.customFeedReferences||[];const fields=['ms','mat','ndf','starch','ca','p','cu','zn','mn','se','co'];return `<section class="card"><div class="section-title"><div><h3>📚 Valeurs types des aliments</h3><div class="muted">Utilisées uniquement quand aucune analyse de l’exploitation n’est disponible. Les valeurs INRAE-CIRAD-AFZ peuvent être ajoutées au référentiel local.</div></div><div class="actions"><button class="btn primary" id="add-custom-feed-ref">+ Ajouter un aliment</button><button class="btn secondary" id="open-inrae-feedtables">🌐 Ouvrir les tables INRAE-CIRAD-AFZ</button><button class="btn secondary" id="reset-feed-refs">Réinitialiser les valeurs types</button></div></div><div class="notice"><strong>Ajouter un aliment absent :</strong> ouvrez les tables INRAE-CIRAD-AFZ, recherchez l’aliment, puis recopiez ici les valeurs de référence. L’aliment ajouté devient ensuite disponible dans toutes les rations. Une analyse réelle de l’élevage reste prioritaire.</div>${custom.length?`<h4>Aliments ajoutés</h4><div class="custom-feed-grid">${custom.map(r=>`<article class="card compact custom-feed-card" data-custom-feed-id="${r.id}"><div class="grid cols-3"><div class="field"><label>Nom de l’aliment</label><input data-custom-feed-field="label" value="${escapeHtml(r.label||'')}"></div><div class="field"><label>Source</label><input data-custom-feed-field="source" value="${escapeHtml(r.source||'Tables INRAE-CIRAD-AFZ')}"></div><div class="actions align-end"><button class="btn danger small" data-delete-custom-feed="${r.id}">Supprimer</button></div></div><div class="grid cols-4">${fields.map(f=>`<div class="field"><label>${({ms:'MS %',mat:'MAT %MS',ndf:'NDF %MS',starch:'Amidon %MS',ca:'Ca %MS',p:'P %MS',cu:'Cu mg/kg MS',zn:'Zn mg/kg MS',mn:'Mn mg/kg MS',se:'Se mg/kg MS',co:'Co mg/kg MS'})[f]}</label><input inputmode="decimal" data-custom-feed-field="${f}" value="${escapeHtml(r[f]??'')}"></div>`).join('')}</div></article>`).join('')}</div>`:''}<h4>Bibliothèque intégrée</h4><div class="table-wrap"><table class="compact-table"><thead><tr><th>Aliment</th><th>MS %</th><th>MAT %MS</th><th>NDF %MS</th><th>Amidon %MS</th><th>Ca %MS</th><th>P %MS</th><th>Cu</th><th>Zn</th><th>Mn</th><th>Se</th><th>Co</th></tr></thead><tbody>${Object.entries(TYPICAL_FEED_LIBRARY).map(([k,b])=>{const r=feedReference(k);return `<tr data-feed-ref-row="${k}"><td><strong>${escapeHtml(b.label)}</strong><br><small>${escapeHtml(b.source)}</small></td>${fields.map(f=>`<td><input inputmode="decimal" data-feed-ref-field="${f}" value="${escapeHtml(settings.feedReferenceOverrides?.[k]?.[f]??'')}" placeholder="${escapeHtml(b[f]??'')}"></td>`).join('')}</tr>`}).join('')}</tbody></table></div><p class="muted small-text">Les oligo-éléments des fourrages sont particulièrement variables selon sol, fertilisation, stade et conservation : une analyse réelle reste prioritaire. Les valeurs types sont identifiées comme estimations dans les rapports.</p></section>`;}
function renderReferenceSettings(){const settings=ensureReferenceSettings(),labs=metabolicLabProfiles(),rows=[];Object.entries(THRESHOLDS||{}).forEach(([stage,rules])=>Object.entries(rules||{}).forEach(([key,rule])=>rows.push({stage,key,rule,ov:settings.referenceThresholdOverrides?.[stage]?.[key]||{}})));const labCards=labs.map(l=>`<article class="card" data-lab-card="${l.id}"><div class="section-title"><div><h3>${escapeHtml(l.name)}</h3><span class="muted">Mis à jour : ${escapeHtml(l.updatedAt?formatDate(l.updatedAt):'non renseigné')}</span></div><div class="actions"><button class="btn secondary small" data-add-lab-ref="${l.id}">+ Paramètre</button><button class="btn danger small" data-delete-lab="${l.id}">Supprimer labo</button></div></div><div class="grid cols-3"><div class="field"><label>Nom</label><input data-lab-name="${l.id}" value="${escapeHtml(l.name||'')}"></div><div class="field"><label>Date de mise à jour</label><input type="date" data-lab-date="${l.id}" value="${escapeHtml((l.updatedAt||'').slice(0,10))}"></div><div class="field"><label>Source / commentaire</label><input data-lab-notes="${l.id}" value="${escapeHtml(l.notes||'')}"></div></div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Paramètre</th><th>Matrice</th><th>Unité</th><th>Seuil bas</th><th>Seuil haut</th><th></th></tr></thead><tbody>${(l.references||[]).map(r=>`<tr data-lab-ref-row="${r.id}"><td><input list="met-analytes-settings" data-lab-ref-field="analyte" value="${escapeHtml(r.analyte||'')}"></td><td><select data-lab-ref-field="sampleType">${['','Sérum','Plasma','Sang total','Foie','Autre'].map(x=>`<option value="${x}" ${r.sampleType===x?'selected':''}>${x||'Toutes'}</option>`).join('')}</select></td><td><input data-lab-ref-field="unit" value="${escapeHtml(r.unit||'')}"></td><td><input inputmode="decimal" data-lab-ref-field="refMin" value="${escapeHtml(r.refMin??'')}"></td><td><input inputmode="decimal" data-lab-ref-field="refMax" value="${escapeHtml(r.refMax??'')}"></td><td><button class="btn danger small" data-delete-lab-ref="${r.id}" data-lab-id="${l.id}">×</button></td></tr>`).join('')}</tbody></table></div></article>`).join('');app.innerHTML=`<div class="section-title"><div><h2>⚙️ Paramètres & seuils</h2><div class="muted">Référentiel central modifiable pour les analyses et les laboratoires.</div></div><span class="badge autosave">v14.6.21.68</span></div><section class="card notice"><strong>Historique protégé</strong><br>Une modification d’un laboratoire change les références proposées pour les <b>nouvelles saisies</b>. Les analyses déjà enregistrées gardent les unités et seuils utilisés au moment du résultat, sauf si vous appuyez volontairement sur « Appliquer les seuils du labo » dans la visite.</section><section class="card"><div class="section-title"><div><h3>🧬 Laboratoires — oligo-éléments & vitamines</h3><span class="muted">Nom, matrice, unité et bornes propres à chaque laboratoire.</span></div><button class="btn primary" id="add-met-lab">+ Ajouter un laboratoire</button></div><datalist id="met-analytes-settings">${Object.values(METABOLIC_KNOWLEDGE).map(x=>`<option value="${escapeHtml(x.label)}">`).join('')}</datalist>${labCards||'<div class="empty">Aucun laboratoire enregistré.</div>'}</section><section class="card"><div class="section-title"><div><h3>📏 Seuils internes des différentes analyses</h3><span class="muted">Valeur vide = seuil d’origine de l’application.</span></div><button class="btn secondary" id="reset-threshold-overrides">Réinitialiser les personnalisations</button></div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Stade</th><th>Analyse</th><th>Rouge bas</th><th>Vert bas</th><th>Vert haut</th><th>Rouge haut</th></tr></thead><tbody>${rows.map(({stage,key,rule,ov})=>`<tr data-th-stage="${escapeHtml(stage)}" data-th-key="${escapeHtml(key)}"><td>${escapeHtml(stage)}</td><td>${escapeHtml(key)}</td>${['redLow','greenLow','greenHigh','redHigh'].map(k=>`<td><input inputmode="decimal" data-th-field="${k}" placeholder="${escapeHtml(rule?.[k]??'—')}" value="${escapeHtml(ov?.[k]??'')}"></td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="muted small-text">Les règles contextuelles non numériques (par exemple certains raisonnements reproduction, bâtiment ou parasitisme) restent configurées dans leur module ; cet écran couvre tous les seuils numériques exposés par le moteur d’analyse.</p></section>${supplementSettingsHtml(settings)}${feedReferenceSettingsHtml(settings)}`;document.getElementById('add-met-lab')?.addEventListener('click',()=>{labs.push({id:uid('lab'),name:'Nouveau laboratoire',updatedAt:new Date().toISOString().slice(0,10),notes:'',references:[]});saveDatabase(db);renderReferenceSettings()});app.querySelectorAll('[data-lab-name]').forEach(el=>el.oninput=()=>{const l=metabolicLabById(el.dataset.labName);if(l){l.name=el.value;saveDatabase(db)}});app.querySelectorAll('[data-lab-date]').forEach(el=>el.onchange=()=>{const l=metabolicLabById(el.dataset.labDate);if(l){l.updatedAt=el.value;saveDatabase(db)}});app.querySelectorAll('[data-lab-notes]').forEach(el=>el.oninput=()=>{const l=metabolicLabById(el.dataset.labNotes);if(l){l.notes=el.value;saveDatabase(db)}});app.querySelectorAll('[data-add-lab-ref]').forEach(b=>b.onclick=()=>{const l=metabolicLabById(b.dataset.addLabRef);if(l){l.references=Array.isArray(l.references)?l.references:[];l.references.push({id:uid('labref'),analyte:'Cuivre (Cu)',sampleType:'Sérum',unit:'',refMin:'',refMax:''});saveDatabase(db);renderReferenceSettings()}});app.querySelectorAll('[data-delete-lab]').forEach(b=>b.onclick=()=>{if(!confirm('Supprimer ce laboratoire ? Les anciennes analyses gardent leurs seuils enregistrés.'))return;settings.metabolicLabs=settings.metabolicLabs.filter(l=>l.id!==b.dataset.deleteLab);saveDatabase(db);renderReferenceSettings()});app.querySelectorAll('[data-lab-ref-field]').forEach(el=>{const save=()=>{const tr=el.closest('[data-lab-ref-row]'),card=el.closest('[data-lab-card]'),l=metabolicLabById(card?.dataset.labCard),r=l?.references?.find(x=>x.id===tr?.dataset.labRefRow);if(r){r[el.dataset.labRefField]=el.value;l.updatedAt=new Date().toISOString().slice(0,10);saveDatabase(db)}};el.oninput=save;el.onchange=save});app.querySelectorAll('[data-delete-lab-ref]').forEach(b=>b.onclick=()=>{const l=metabolicLabById(b.dataset.labId);if(l){l.references=l.references.filter(r=>r.id!==b.dataset.deleteLabRef);saveDatabase(db);renderReferenceSettings()}});app.querySelectorAll('[data-th-field]').forEach(el=>{const save=()=>{const tr=el.closest('tr'),stage=tr.dataset.thStage,key=tr.dataset.thKey;settings.referenceThresholdOverrides[stage]=settings.referenceThresholdOverrides[stage]||{};settings.referenceThresholdOverrides[stage][key]=settings.referenceThresholdOverrides[stage][key]||{};const v=parseFrenchNumber(el.value);if(v===null)delete settings.referenceThresholdOverrides[stage][key][el.dataset.thField];else settings.referenceThresholdOverrides[stage][key][el.dataset.thField]=v;if(!Object.keys(settings.referenceThresholdOverrides[stage][key]).length)delete settings.referenceThresholdOverrides[stage][key];saveDatabase(db)};el.oninput=save;el.onchange=save});document.getElementById('reset-threshold-overrides')?.addEventListener('click',()=>{if(!confirm('Revenir à tous les seuils internes d’origine ?'))return;settings.referenceThresholdOverrides={};saveDatabase(db);renderReferenceSettings();showToast('Seuils internes réinitialisés.')});
 document.getElementById('add-supp-product')?.addEventListener('click',()=>{settings.supplementProducts.push({id:uid('supp'),name:'Nouveau minéral',manufacturer:'',type:'Minéral poudre',releaseDays:'',composition:{cu:'',zn:'',mn:'',se:'',co:'',i:''}});saveDatabase(db);renderReferenceSettings()});
 app.querySelectorAll('[data-supp-field-setting]').forEach(el=>{const save=()=>{const card=el.closest('[data-supp-product]'),p=settings.supplementProducts.find(x=>x.id===card?.dataset.suppProduct);if(p){p[el.dataset.suppFieldSetting]=el.value;saveDatabase(db)}};el.oninput=save;el.onchange=()=>{save();renderReferenceSettings()}});
 app.querySelectorAll('[data-supp-composition]').forEach(el=>{const save=()=>{const card=el.closest('[data-supp-product]'),p=settings.supplementProducts.find(x=>x.id===card?.dataset.suppProduct);if(p){p.composition=p.composition||{};p.composition[el.dataset.suppComposition]=el.value;saveDatabase(db)}};el.oninput=save;el.onchange=save});
 app.querySelectorAll('[data-delete-supp]').forEach(b=>b.onclick=()=>{if(!confirm('Supprimer ce produit ?'))return;settings.supplementProducts=settings.supplementProducts.filter(x=>x.id!==b.dataset.deleteSupp);saveDatabase(db);renderReferenceSettings()});
 app.querySelectorAll('[data-min-target]').forEach(el=>{const save=()=>{const v=parseFrenchNumber(el.value);if(v===null)delete settings.mineralNeedTargets[el.dataset.minTarget];else settings.mineralNeedTargets[el.dataset.minTarget]=v;saveDatabase(db)};el.oninput=save;el.onchange=save});
 app.querySelectorAll('[data-feed-ref-field]').forEach(el=>{const save=()=>{const tr=el.closest('[data-feed-ref-row]'),k=tr?.dataset.feedRefRow;settings.feedReferenceOverrides[k]=settings.feedReferenceOverrides[k]||{};const v=parseFrenchNumber(el.value);if(v===null)delete settings.feedReferenceOverrides[k][el.dataset.feedRefField];else settings.feedReferenceOverrides[k][el.dataset.feedRefField]=v;if(!Object.keys(settings.feedReferenceOverrides[k]).length)delete settings.feedReferenceOverrides[k];saveDatabase(db)};el.oninput=save;el.onchange=save});
 document.getElementById('add-custom-feed-ref')?.addEventListener('click',()=>{settings.customFeedReferences.push({id:uid('feedref'),label:'Nouvel aliment',source:'Tables INRAE-CIRAD-AFZ',ms:'',mat:'',ndf:'',starch:'',ca:'',p:'',cu:'',zn:'',mn:'',se:'',co:''});saveDatabase(db);renderReferenceSettings();});document.getElementById('open-inrae-feedtables')?.addEventListener('click',()=>window.open('https://www.feedtables.com/fr','_blank','noopener'));app.querySelectorAll('[data-custom-feed-field]').forEach(el=>{const save=()=>{const card=el.closest('[data-custom-feed-id]'),r=settings.customFeedReferences.find(x=>x.id===card?.dataset.customFeedId);if(!r)return;const k=el.dataset.customFeedField;r[k]=['label','source'].includes(k)?el.value:(parseFrenchNumber(el.value)??'');saveDatabase(db);};el.oninput=save;el.onchange=save;});app.querySelectorAll('[data-delete-custom-feed]').forEach(b=>b.onclick=()=>{if(!confirm('Supprimer cet aliment du référentiel ?'))return;settings.customFeedReferences=settings.customFeedReferences.filter(x=>x.id!==b.dataset.deleteCustomFeed);saveDatabase(db);renderReferenceSettings();});document.getElementById('reset-feed-refs')?.addEventListener('click',()=>{if(!confirm('Réinitialiser toutes les valeurs types des aliments ?'))return;settings.feedReferenceOverrides={};saveDatabase(db);renderReferenceSettings();showToast('Valeurs types réinitialisées.')});} 

function renderBackup() {
  app.innerHTML = `
    <div class="section-title"><h2>Sauvegarde et administration locale</h2></div>
    <section class="grid cols-2">
      <article class="card"><h3>Enregistrer toute la base</h3><p class="muted">Exporte toutes les exploitations, visites et sujets dans un fichier JSON.</p><button class="btn primary" id="export-db">Télécharger la sauvegarde complète</button></article>
      <article class="card"><h3>Ouvrir une sauvegarde</h3><p class="muted">Remplace la base locale par le contenu d’un fichier JSON précédemment exporté.</p><button class="btn" id="import-db">Choisir un fichier JSON</button></article>
      <article class="card"><h3>État de la sauvegarde locale</h3><p>Dernière modification : <strong>${formatDateTime(db.updatedAt)}</strong></p><p class="muted">La base est enregistrée automatiquement à chaque création ou modification.</p></article>
      <article class="card"><h3>Réinitialiser</h3><p class="muted">Efface toutes les exploitations, visites et sujets de cet appareil.</p><button class="btn danger" id="reset-db">Tout effacer</button></article>
    </section>`;
  document.getElementById('export-db').onclick = () => downloadJson(`audit-bovin-sauvegarde-${new Date().toISOString().slice(0,10)}.json`, db);
  document.getElementById('import-db').onclick = () => fileInput.click();
  document.getElementById('reset-db').onclick = () => {
    if (confirm('Effacer définitivement toutes les données de cet appareil ?')) { db = replaceDatabase({ farms: [], visits: [] }); clearDraft(); setActiveVisit(''); showToast('Base locale effacée.'); renderBackup(); }
  };
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.farm && parsed.visit) {
      const farm = parsed.farm;
      const existingFarm = db.farms.find(f => f.id === farm.id) || db.farms.find(f => f.name.toLowerCase() === farm.name.toLowerCase());
      const farmId = existingFarm?.id || farm.id || uid('farm');
      if (!existingFarm) db.farms.push({ ...farm, id: farmId });
      db.visits = db.visits.filter(v => v.id !== parsed.visit.id);
      db.visits.push({ ...parsed.visit, farmId, subjects: Array.isArray(parsed.visit.subjects) ? parsed.visit.subjects : [] });
      setActiveVisit(parsed.visit.id);
      saveDatabase(db);
      showToast('Visite importée.');
    } else if (Array.isArray(parsed.farms) && Array.isArray(parsed.visits)) {
      db = replaceDatabase(parsed);
      migrateDatabase();
      showToast('Sauvegarde complète restaurée.');
    } else {
      throw new Error('Format non reconnu');
    }
    render();
  } catch (error) {
    console.error(error);
    alert('Ce fichier JSON ne correspond pas à une sauvegarde Audit Bovin valide.');
  } finally {
    fileInput.value = '';
  }
});

window.addEventListener('error', event => {
  console.error(event.error || event.message);
  const errorBox = document.createElement('div');
  errorBox.className = 'card notice warning';
  errorBox.innerHTML = `<strong>Une erreur a été détectée.</strong><br><span class="muted">${escapeHtml(event.message || 'Erreur inconnue')}</span>`;
  app.prepend(errorBox);
});

window.addEventListener('unhandledrejection', event => {
  console.error(event.reason);
  const message = event.reason?.message || String(event.reason || 'Erreur asynchrone inconnue');
  const errorBox = document.createElement('div');
  errorBox.className = 'card notice warning';
  errorBox.innerHTML = `<strong>Une erreur a été détectée.</strong><br><span class="muted">${escapeHtml(message)}</span>`;
  app.prepend(errorBox);
});



function normalizedSearchText(value=''){
  return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}
function collectSearchStrings(value, depth=0){
  if(depth>3||value===null||value===undefined)return [];
  if(['string','number','boolean'].includes(typeof value))return [String(value)];
  if(Array.isArray(value))return value.flatMap(v=>collectSearchStrings(v,depth+1));
  if(typeof value==='object')return Object.values(value).flatMap(v=>collectSearchStrings(v,depth+1));
  return [];
}
let __auditSearchIndexCache=null;
function buildAuditSearchIndex(){
  const navigation=[
    {view:'analysis',icon:'📏',title:'Mesures — Sang',keywords:'sang glycemie glucose boh beta hydroxybutyrate uree hematocrite ph sanguin'},
    {view:'analysis',icon:'📏',title:'Mesures — Urines',keywords:'urine urines ph redox densite brix couleur conductivite'},
    {view:'analysis',icon:'📏',title:'Mesures — Bouses',keywords:'bouse bouses feces digestion tamis ph redox'},
    {view:'analysis',icon:'🥛',title:'Mesures — Lait / colostrum',keywords:'lait colostrum brix refractometre'},
    {view:'metabolic',icon:'🧬',title:'Profil métabolique / oligo',keywords:'sang oligo cuivre zinc selenium iode cobalt manganese magnesium vitamine d3 25ohd3 laboratoire resultat'},
    {view:'parasitism',icon:'🦠',title:'Parasitisme',keywords:'copro coproscopie strongles douve fasciola pepsinogene serologie laboratoire resultat'},
    {view:'waterlab',icon:'💧',title:'Analyse d’eau',keywords:'eau laboratoire bacteriologie coliformes ecoli enterocoques nitrites nitrates ph redox conductivite'},
    {view:'building',icon:'🏠',title:'Bâtiment / eau / électricité',keywords:'batiment eau abreuvoir redox ph conductivite electricite litiere ambiance questionnaire'},
    {view:'feeding',icon:'🍽️',title:'Alimentation / minéraux',keywords:'ration aliment aliments mineraux mineral bolus etiquette fourrage silo'},
    {view:'audit',icon:'📋',title:'Questions terrain / sanitaire',keywords:'mortalite diarrhee diarrhees mammite mammites boiterie boiteries omphalite omphalites avortement avortements pneumonie pneumonies sanitaire questions terrain audit exploitation'},
    {view:'reproduction',icon:'🐄',title:'Reproduction',keywords:'ivv velage gestation premier velage vaches problemes repro mortalite veaux'},
    {view:'prepprint',icon:'🖨️',title:'Documents imprimables',keywords:'imprimer papier support visite liste animaux mortalite repro vaches problemes audit papier scan photo'},
    {view:'study',icon:'📁',title:'Suivi de l’étude',keywords:'intervenant veterinaire cda chambre analyses factures justificatifs temps journal observations'},
    {view:'journal',icon:'📒',title:'Journal / observations',keywords:'journal observation observations suivi note notes evolution'},
    {view:'economy',icon:'💶',title:'Marge de progrès',keywords:'economie economique benefice cout gmq prix veau vache lait viande mortalite boiterie mammite avortement'},
    {view:'references',icon:'⚙️',title:'Paramètres & seuils',keywords:'parametres seuils references laboratoire'},
    {view:'planches',icon:'📚',title:'Bibliothèque',keywords:'bibliotheque fiche fiches support technique'},
    {view:'backup',icon:'💾',title:'Sauvegarde',keywords:'sauvegarde restauration cloud export'}
  ];
  const out=navigation.map(x=>({kind:'Rubrique',...x,hay:normalizedSearchText(x.title+' '+x.keywords)}));
  db.farms.forEach(f=>out.push({kind:'Exploitation',icon:'👨‍🌾',title:f.name||'Exploitation',subtitle:[f.farmNumber,f.commune,f.farmer].filter(Boolean).join(' · '),view:'farms',farmId:f.id,hay:normalizedSearchText(collectSearchStrings({name:f.name,farmer:f.farmer,commune:f.commune,farmNumber:f.farmNumber,holderNumber:f.holderNumber,notes:f.notes}).join(' '))}));
  db.visits.forEach(v=>{const farm=farmName(v.farmId);out.push({kind:'Visite',icon:'📅',title:`${farm} — ${formatDate(v.date)}`,subtitle:[v.type,v.technician].filter(Boolean).join(' · '),view:'visits',visitId:v.id,hay:normalizedSearchText(collectSearchStrings({farm,date:v.date,type:v.type,technician:v.technician,objective:v.objective,notes:v.notes}).join(' '))});(v.subjects||[]).forEach(s=>out.push({kind:'Animal / sujet',icon:'🐄',title:s.identifier||s.tag||s.name||s.category||'Sujet',subtitle:`${farm} · ${formatDate(v.date)} · ${s.category||''}`,view:'animals',visitId:v.id,subjectId:s.id,hay:normalizedSearchText(collectSearchStrings(s).join(' '))}));});
  return out;
}
function universalSearchResults(query){const q=normalizedSearchText(query).trim();if(!q)return [];const words=q.split(/\s+/).filter(Boolean);if(!__auditSearchIndexCache)__auditSearchIndexCache=buildAuditSearchIndex();return __auditSearchIndexCache.filter(x=>words.every(w=>x.hay.includes(w))).slice(0,35);}
function openUniversalSearch(){
  document.querySelector('.global-search-overlay')?.remove();
  const overlay=document.createElement('div');overlay.className='global-search-overlay';
  overlay.innerHTML=`<section class="global-search-panel"><div class="global-search-head"><div><strong>🔎 Recherche dans l’application</strong><small>Tapez un mot : sang, urine, Brix, redox, IVV, minéral, facture…</small></div><button type="button" aria-label="Fermer">×</button></div><input id="global-search-input" type="search" autocomplete="off" inputmode="search" placeholder="Rechercher une rubrique, un animal, une exploitation…"><div id="global-search-results" class="global-search-results"><div class="empty compact">Saisissez un mot.</div></div></section>`;
  document.body.appendChild(overlay);const input=overlay.querySelector('#global-search-input'),box=overlay.querySelector('#global-search-results');const close=()=>overlay.remove();overlay.querySelector('.global-search-head button').onclick=close;overlay.onclick=e=>{if(e.target===overlay)close();};let timer=0;const renderResults=()=>{clearTimeout(timer);timer=setTimeout(()=>{const results=universalSearchResults(input.value);box.innerHTML=input.value.trim()?results.length?results.map((r,i)=>`<button class="global-search-result" data-search-index="${i}"><span>${r.icon}</span><span><strong>${escapeHtml(r.title)}</strong><small>${escapeHtml(r.kind)}${r.subtitle?` · ${escapeHtml(r.subtitle)}`:''}</small></span><b>›</b></button>`).join(''):'<div class="empty compact">Aucun résultat.</div>':'<div class="empty compact">Saisissez un mot.</div>';box.querySelectorAll('[data-search-index]').forEach(b=>b.onclick=()=>{const r=results[Number(b.dataset.searchIndex)];if(r.visitId)setActiveVisit(r.visitId);if(r.subjectId){openSubjectId=r.subjectId;focusedAnalysisSubjectId=r.subjectId;localStorage.setItem('audit-bovin-focused-analysis-subject',r.subjectId);}close();setView(r.view);});},35)};input.oninput=renderResults;
}
function initGlobalSearch(){
  const header=document.querySelector('.app-header');if(!header||document.getElementById('global-search-button'))return;
  let tools=header.querySelector('.header-tools');if(!tools){tools=document.createElement('div');tools.className='header-tools';const version=header.querySelector('.version');if(version)header.insertBefore(tools,version);else header.appendChild(tools);}
  const btn=document.createElement('button');btn.id='global-search-button';btn.className='global-search-button';btn.type='button';btn.textContent='🔎 Rechercher';btn.onclick=openUniversalSearch;tools.prepend(btn);
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openUniversalSearch();}});
}


// V14.4 — Registre bovins et module Reproduction
function cleanCsvCell(value='') {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().replace(/^="(.*)"$/s, '$1').replace(/^"(.*)"$/s, '$1').trim();
}
function parseRegistryFrenchDate(value='') {
  const v=cleanCsvCell(value); if(!v)return '';
  const m=v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(m)return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(v)?v:'';
}
function parseSemicolonCsv(text='') {
  const rows=[]; let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i],n=text[i+1];
    if(c==='"' && quoted && n==='"'){cell+='"';i++;continue;}
    if(c==='"'){quoted=!quoted;cell+=c;continue;}
    if(c===';'&&!quoted){row.push(cleanCsvCell(cell));cell='';continue;}
    if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&n==='\n')i++;row.push(cleanCsvCell(cell));cell='';if(row.some(x=>x!==''))rows.push(row);row=[];continue;}
    cell+=c;
  }
  if(cell||row.length){row.push(cleanCsvCell(cell));if(row.some(x=>x!==''))rows.push(row);}
  return rows;
}
function normalizeAnimalId(value=''){return String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^FR/,'FR');}
function animalDigits(value=''){return normalizeAnimalId(value).replace(/^[A-Z]+/,'');}
function monthsBetweenDates(a,b){if(!a||!b)return null;const d1=new Date(a+'T12:00:00'),d2=new Date(b+'T12:00:00');if(isNaN(d1)||isNaN(d2))return null;return Math.round(((d2-d1)/86400000)/30.4375*10)/10;}
function daysBetweenDates(a,b){if(!a||!b)return null;const d1=new Date(a+'T12:00:00'),d2=new Date(b+'T12:00:00');if(isNaN(d1)||isNaN(d2))return null;return Math.round((d2-d1)/86400000);}
function ageLabelAt(birthDate,atDate){const m=monthsBetweenDates(birthDate,atDate||new Date().toISOString().slice(0,10));if(m===null)return '';if(m<24)return `${Math.floor(m)} mois`;const y=Math.floor(m/12),rm=Math.round(m-y*12);return `${y} an${y>1?'s':''}${rm?` ${rm} mois`:''}`;}
function resolveRegistryAnimal(farm,query){
  const list=farm?.herdRegistry||[],raw=String(query||'').trim(),q=normalizeAnimalId(raw),digits=String(raw).replace(/\D/g,'');if(!q&&!digits)return null;
  // 1) Priorité au numéro complet puis au numéro de travail exact.
  let items=list.filter(a=>normalizeAnimalId(a.id)===q);
  if(items.length===1)return {animal:items[0],matchType:'id'};
  if(items.length>1)return {ambiguous:true,items,matchType:'id'};
  items=list.filter(a=>normalizeAnimalId(a.workNumber)===q||(digits&&String(a.workNumber||'').replace(/\D/g,'')===digits));
  if(items.length===1)return {animal:items[0],matchType:'work'};
  if(items.length>1)return {ambiguous:true,items,matchType:'work'};
  // 2) En dernier recours, accepte la fin du numéro national si elle est assez discriminante.
  if(digits&&digits.length>=3){items=list.filter(a=>animalDigits(a.id).endsWith(digits));}
  if(items.length===1)return {animal:items[0],matchType:'suffix'};
  if(items.length>1)return {ambiguous:true,items,matchType:'suffix'};
  return null;
}
function reproductionForCow(farm,cowId){
  const list=farm?.herdRegistry||[],key=normalizeAnimalId(cowId),cow=list.find(a=>normalizeAnimalId(a.id)===key);
  const calves=list.filter(a=>normalizeAnimalId(a.motherId)===key&&a.birthDate).sort((a,b)=>a.birthDate.localeCompare(b.birthDate));
  const dates=[...new Set(calves.map(a=>a.birthDate))].sort(); const intervals=[];for(let i=1;i<dates.length;i++){const d=daysBetweenDates(dates[i-1],dates[i]);if(d!==null)intervals.push(d);}
  const deadBefore6=calves.filter(c=>c.exitCause==='M'&&c.exitDate&&daysBetweenDates(c.birthDate,c.exitDate)!==null&&daysBetweenDates(c.birthDate,c.exitDate)<183);
  const first=calves[0]||null,last=calves.at(-1)||null; const firstAge=cow&&first?monthsBetweenDates(cow.birthDate,first.birthDate):null;
  const mean=intervals.length?Math.round(intervals.reduce((a,b)=>a+b,0)/intervals.length):null;
  return {cow,calves,calvingDates:dates,intervals,firstCalvingDate:first?.birthDate||'',lastCalvingDate:last?.birthDate||'',firstCalvingAgeMonths:firstAge,lastCalf:last,lastIVV:intervals.at(-1)??null,meanIVV:mean,minIVV:intervals.length?Math.min(...intervals):null,maxIVV:intervals.length?Math.max(...intervals):null,deadBefore6,daysSinceLast:last?daysBetweenDates(last.birthDate,new Date().toISOString().slice(0,10)):null};
}
function reproductionScoreDetails(r){const lines=[];let score=100;lines.push({label:'Base',delta:0,value:'100 points'});if(r.firstCalvingAgeMonths!=null){if(r.firstCalvingAgeMonths>36){score-=20;lines.push({label:'1er vêlage après 36 mois',delta:-20,value:`${r.firstCalvingAgeMonths} mois`});}else if(r.firstCalvingAgeMonths>28){score-=8;lines.push({label:'1er vêlage entre 28 et 36 mois',delta:-8,value:`${r.firstCalvingAgeMonths} mois`});}else lines.push({label:'Âge au 1er vêlage',delta:0,value:`${r.firstCalvingAgeMonths} mois`});}else lines.push({label:'Âge au 1er vêlage non calculable',delta:0,value:'—'});if(r.meanIVV!=null){if(r.meanIVV>500){score-=30;lines.push({label:'IVV moyen > 500 j',delta:-30,value:`${r.meanIVV} j`});}else if(r.meanIVV>450){score-=20;lines.push({label:'IVV moyen 451–500 j',delta:-20,value:`${r.meanIVV} j`});}else if(r.meanIVV>400){score-=10;lines.push({label:'IVV moyen 401–450 j',delta:-10,value:`${r.meanIVV} j`});}else lines.push({label:'IVV moyen ≤ 400 j',delta:0,value:`${r.meanIVV} j`});}else lines.push({label:'IVV non calculable (un seul vêlage)',delta:0,value:'—'});if(r.maxIVV>730){score-=15;lines.push({label:'IVV maximum > 730 j',delta:-15,value:`${r.maxIVV} j`});}else if(r.maxIVV>500){score-=8;lines.push({label:'IVV maximum 501–730 j',delta:-8,value:`${r.maxIVV} j`});}const mortalityPenalty=Math.min(30,r.deadBefore6.length*12);if(mortalityPenalty){score-=mortalityPenalty;lines.push({label:'Veaux morts avant 6 mois',delta:-mortalityPenalty,value:`${r.deadBefore6.length} veau(x)`});}return {score:Math.max(0,Math.round(score)),lines};}
function reproductionScore(r){return reproductionScoreDetails(r).score;}
function reproductionScoreLegendHtml(compact=false){
  const rows=[
    ['Base','100 points'],
    ['1er vêlage ≤ 28 mois','0'],
    ['1er vêlage 29–36 mois','−8'],
    ['1er vêlage > 36 mois','−20'],
    ['IVV moyen ≤ 400 j','0'],
    ['IVV moyen 401–450 j','−10'],
    ['IVV moyen 451–500 j','−20'],
    ['IVV moyen > 500 j','−30'],
    ['IVV maximum ≤ 500 j','0'],
    ['IVV maximum 501–730 j','−8'],
    ['IVV maximum > 730 j','−15'],
    ['Veau mort avant 6 mois','−12 par veau, plafonné à −30']
  ];
  return `<div class="repro-score-legend ${compact?'compact':''}"><p><strong>Principe :</strong> score initial 100, puis soustraction des pénalités. Le score final est borné à 0. <span class="badge complete">≥75 vert</span> <span class="badge in-progress">60–74 orange</span> <span class="badge danger">&lt;60 rouge</span></p><table><thead><tr><th>Événement / critère</th><th>Impact</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r[0]}</td><td><strong>${r[1]}</strong></td></tr>`).join('')}</tbody></table></div>`;
}

function isRegistryAnimalPresent(animal,atDate=new Date().toISOString().slice(0,10)){
  if(!animal)return false;
  return !animal.exitDate || animal.exitDate>atDate;
}
function currentReproductionCows(farm,atDate=new Date().toISOString().slice(0,10)){
  return (farm?.herdRegistry||[])
    .filter(a=>a.sex==='F'&&isRegistryAnimalPresent(a,atDate))
    .map(c=>reproductionForCow(farm,c.id))
    .filter(r=>r.calves.length>=1);
}
function importHerdRegistryRows(rows){
  if(rows.length<2)throw new Error('Fichier vide ou illisible.');
  const headers=rows[0].map(x=>normalizeSearchText(x)); const col=(...names)=>{for(const n of names){const i=headers.indexOf(normalizeSearchText(n));if(i>=0)return i;}return -1;};
  const ix={id:col('Identifiant bovin'),work:col('Numéro travail','Numero travail'),birth:col('Date naissance'),sex:col('Sexe'),breed:col('Type racial'),name:col('Nom'),mother:col('Numéro mère','Numero mere'),motherBreed:col('Type racial mère','Type racial mere'),farm:col('Exploitation'),entry:col('Date entrée','Date entree'),entryCause:col("Cause d'entrée"),exit:col('Date sortie'),exitCause:col('Cause de sortie'),father:col('Numéro père','Numero pere','Père','Pere')};
  if(ix.id<0||ix.birth<0||ix.mother<0)throw new Error('Colonnes Identifiant bovin, Date naissance ou Numéro mère introuvables.');
  return rows.slice(1).map(r=>({id:cleanCsvCell(r[ix.id]),workNumber:ix.work>=0?cleanCsvCell(r[ix.work]):'',birthDate:parseRegistryFrenchDate(r[ix.birth]),sex:ix.sex>=0?cleanCsvCell(r[ix.sex]):'',breed:ix.breed>=0?cleanCsvCell(r[ix.breed]):'',name:ix.name>=0?cleanCsvCell(r[ix.name]):'',motherId:ix.mother>=0?cleanCsvCell(r[ix.mother]):'',fatherId:ix.father>=0?cleanCsvCell(r[ix.father]):'',motherBreed:ix.motherBreed>=0?cleanCsvCell(r[ix.motherBreed]):'',farmNumber:ix.farm>=0?cleanCsvCell(r[ix.farm]):'',entryDate:ix.entry>=0?parseRegistryFrenchDate(r[ix.entry]):'',entryCause:ix.entryCause>=0?cleanCsvCell(r[ix.entryCause]):'',exitDate:ix.exit>=0?parseRegistryFrenchDate(r[ix.exit]):'',exitCause:ix.exitCause>=0?cleanCsvCell(r[ix.exitCause]):''})).filter(a=>a.id);
}
let reproductionSort=localStorage.getItem('audit-bovin-repro-sort')||'lastCalvingOld';
let reproductionFilter=localStorage.getItem('audit-bovin-repro-filter')||'all';
function reproductionRegistryPeriod(registry=[]){
  const dates=registry.flatMap(a=>[a.birthDate,a.entryDate,a.exitDate]).filter(Boolean).sort();
  return dates.length?{from:dates[0],to:dates.at(-1)}:{from:'',to:''};
}
function reproductionDefaultYearStart(periodMin='',periodMax=''){
  if(!periodMax)return periodMin||'';
  const d=new Date(periodMax+'T12:00:00');if(isNaN(d))return periodMin||'';d.setFullYear(d.getFullYear()-1);
  const iso=d.toISOString().slice(0,10);return periodMin&&iso<periodMin?periodMin:iso;
}
function reproductionSourceForVisit(visit,farm){
  if(visit&&visit.farmId===farm?.id&&Array.isArray(visit.reproductionRegistry)){
    return {registry:visit.reproductionRegistry,meta:visit.reproductionRegistrySource||null,scope:'visit'};
  }
  return {registry:farm?.herdRegistry||[],meta:farm?.herdRegistrySource||null,scope:'legacy'};
}
function closeReproDetailModal(){document.getElementById('repro-detail-modal')?.remove();}
function showReproScoreModal(reproFarm,cowId,mode='score'){
  const r=reproductionForCow(reproFarm,cowId);if(!r)return;
  closeReproDetailModal();
  const overlay=document.createElement('div');overlay.id='repro-detail-modal';overlay.className='repro-detail-overlay';
  if(mode==='history'){
    overlay.innerHTML=`<div class="repro-detail-dialog"><div class="section-title"><div><h3>${escapeHtml(r.cow.workNumber||r.cow.id)}${r.cow.name?` · ${escapeHtml(r.cow.name)}`:''} — historique complet</h3></div><button class="btn secondary" id="close-repro-detail">✕ Fermer</button></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Veau</th><th>Père</th><th>Sortie</th><th>IVV précédent</th></tr></thead><tbody>${r.calves.map((c,i)=>`<tr><td>${formatDate(c.birthDate)}</td><td>${escapeHtml(c.workNumber||c.id)}</td><td>${escapeHtml(c.fatherId||'Non renseigné')}</td><td>${escapeHtml(c.exitCause||'Présent')}</td><td>${i?r.intervals[i-1]+' j':'—'}</td></tr>`).join('')}</tbody></table></div></div>`;
  }else{
    const d=reproductionScoreDetails(r);
    overlay.innerHTML=`<div class="repro-detail-dialog"><div class="section-title"><div><h3>Détail du score · ${escapeHtml(r.cow.workNumber||r.cow.id)}${r.cow.name?` · ${escapeHtml(r.cow.name)}`:''}</h3><div class="muted">Score actuel : <strong>${reproductionScore(r)}/100</strong></div></div><button class="btn secondary" id="close-repro-detail">✕ Fermer</button></div><div class="table-wrap"><table><thead><tr><th>Critère</th><th>Valeur</th><th>Pénalité</th></tr></thead><tbody>${d.lines.map(x=>`<tr><td>${escapeHtml(x.label)}</td><td>${escapeHtml(x.value)}</td><td>${x.delta}</td></tr>`).join('')}</tbody></table></div>${reproductionScoreLegendHtml()}</div>`;
  }
  document.body.appendChild(overlay);document.getElementById('close-repro-detail')?.addEventListener('click',closeReproDetailModal);overlay.addEventListener('click',e=>{if(e.target===overlay)closeReproDetailModal();});
}


function ensureReproInvestigation(visit){
  if(!visit)return {heat:{},bulls:[],events:[],settings:{}};
  visit.reproInvestigation=visit.reproInvestigation&&typeof visit.reproInvestigation==='object'?visit.reproInvestigation:{};
  const x=visit.reproInvestigation;
  x.heat=x.heat&&typeof x.heat==='object'?x.heat:{};
  x.bulls=Array.isArray(x.bulls)?x.bulls:[];
  x.events=Array.isArray(x.events)?x.events:[];
  x.settings=x.settings&&typeof x.settings==='object'?x.settings:{};
  x.weather=x.weather&&typeof x.weather==='object'?x.weather:{};
  x.weather.records=Array.isArray(x.weather.records)?x.weather.records:[];
  if(x.settings.adultBullMax==null)x.settings.adultBullMax=30;
  if(x.settings.youngBullMax==null)x.settings.youngBullMax=20;
  return x;
}
function reproAgeMonths(animal,date){const m=monthsBetweenDates(animal?.birthDate,date);return m==null?null:m;}
function reproAgeInRange(animal,date,minM,maxM){const m=reproAgeMonths(animal,date);return m!=null&&m>=minM&&m<=maxM;}
function reproAgeRangeLabel(minM,maxM){const fmt=m=>m>=180?'15 ans +':m%12===0?`${m/12} ans`:`${Math.floor(m/12)} a ${m%12} m`;return `${fmt(minM)} → ${fmt(maxM)}`;}
function reproHeatAssessment(inv,stats){
  const h=inv?.heat||{},method=h.method||'',freq=Number(h.frequency||0),returns=h.returns||'',notes=[];let level='unknown';
  if(!method)return {level:'unknown',label:'À renseigner',notes:['Méthode de détection des chaleurs non renseignée.']};
  if(method==='none'){level='danger';notes.push('Aucune détection organisée des chaleurs.');}
  else if(method==='visual'&&freq<2){level='warning';notes.push('Observation visuelle moins de 2 fois/jour : risque de chaleurs manquées.');}
  else {level='ok';notes.push('Organisation de détection des chaleurs renseignée.');}
  if(returns==='no'){level=level==='danger'?'danger':'warning';notes.push('Les retours en chaleurs ne sont pas suivis systématiquement.');}
  if(stats?.ivvMean!=null&&stats.ivvMean>430&&level==='ok')notes.push('Malgré une détection apparemment organisée, les résultats repro restent dégradés : approfondir lots, taureaux, état corporel, alimentation et sanitaire.');
  return {level,label:level==='ok'?'Organisation convenable':level==='warning'?'À surveiller':level==='danger'?'Point critique':'À renseigner',notes};
}
function reproBullAssessment(inv,stats){
  const bulls=inv?.bulls||[],adultMax=Number(inv?.settings?.adultBullMax||30),youngMax=Number(inv?.settings?.youngBullMax||20);
  const used=bulls.filter(b=>Number(b.females||0)>0),details=used.map(b=>{const females=Number(b.females||0),lim=b.ageClass==='young'?youngMax:adultMax,ratio=females,status=females<=lim?'ok':females<=lim*1.2?'warning':'danger';return {...b,females,limit:lim,ratio,status};});
  let overall=details.some(x=>x.status==='danger')?'danger':details.some(x=>x.status==='warning')?'warning':details.length?'ok':'unknown';
  const totalFemales=details.reduce((a,b)=>a+b.females,0),avg=details.length?Math.round(totalFemales/details.length*10)/10:null;
  const notes=[];
  if(!details.length)notes.push('Aucun taureau de reproduction renseigné.');
  else notes.push(`${details.length} taureau(x), ${totalFemales} femelle(s) réellement exposée(s), moyenne ${avg} femelle(s)/taureau.`);
  if(stats?.ivvMean!=null&&stats.ivvMean>430&&overall==='ok')notes.push('Le ratio paraît convenable mais les performances sont insuffisantes : vérifier la répartition réelle des lots, la durée de contact, la fertilité et les interruptions de présence du taureau.');
  return {overall,details,totalFemales,avg,notes};
}
function dateShiftDays(iso,days){if(!iso)return '';const d=new Date(iso+'T12:00:00');if(isNaN(d))return '';d.setDate(d.getDate()+days);return d.toISOString().slice(0,10);}
function quarterKey(iso){if(!iso)return '';const d=new Date(iso+'T12:00:00');if(isNaN(d))return '';return `${d.getFullYear()}-T${Math.floor(d.getMonth()/3)+1}`;}
function quarterSortValue(k){const m=String(k).match(/(\d{4})-T([1-4])/);return m?Number(m[1])*10+Number(m[2]):0;}
function quarterDateRange(k){const m=String(k).match(/(\d{4})-T([1-4])/);if(!m)return {from:'',to:''};const y=Number(m[1]),q=Number(m[2]),sm=(q-1)*3,from=`${y}-${String(sm+1).padStart(2,'0')}-01`;const d=new Date(y,sm+3,0,12);return {from,to:d.toISOString().slice(0,10)};}
function reproWeatherDepartment(farm){const raw=String(farm?.farmNumber||'').replace(/\D/g,'');if(raw.startsWith('65'))return '65';if(raw.startsWith('32'))return '32';return '';}
function reproWeatherNum(v){if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(',','.'));return Number.isFinite(n)?n:null;}
function parseCsvRobust(text){
  const clean=String(text||'').replace(/^\uFEFF/,'');
  const firstLine=clean.split(/\r?\n/,1)[0]||'';
  const counts={';':(firstLine.match(/;/g)||[]).length,',':(firstLine.match(/,/g)||[]).length,'\t':(firstLine.match(/\t/g)||[]).length};
  const delimiter=counts[';']>=counts[',']&&counts[';']>=counts['\t']?';':counts['\t']>counts[',']?'\t':',';
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<clean.length;i++){
    const ch=clean[i],next=clean[i+1];
    if(ch==='"'&&quoted&&next==='"'){cell+='"';i++;continue;}
    if(ch==='"'){quoted=!quoted;continue;}
    if(ch===delimiter&&!quoted){row.push(cell.trim());cell='';continue;}
    if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&next==='\n')i++;row.push(cell.trim());cell='';if(row.some(v=>v!==''))rows.push(row);row=[];continue;}
    cell+=ch;
  }
  if(cell!==''||row.length){row.push(cell.trim());if(row.some(v=>v!==''))rows.push(row);}
  return rows;
}
function reproWeatherParseDetailedCsv(text){
  const rows=parseCsvRobust(String(text||'').replace(/^\uFEFF/,''));if(rows.length<2)return [];
  const h=rows[0].map(x=>normalizeSearchText(x).replace(/[^a-z0-9]/g,''));
  const col=(...names)=>{for(const n of names){const key=normalizeSearchText(n).replace(/[^a-z0-9]/g,'');const i=h.indexOf(key);if(i>=0)return i;}return -1};
  const ix={date:col('DATE','AAAAMMJJ','DATEOBS','DAT'),rr:col('RR','RR24','PRECIPITATION','PRECIPITATIONS','HAUTEURPRECIPITATIONS'),tn:col('TN','TMIN','TEMPERATUREMINIMALE'),tx:col('TX','TMAX','TEMPERATUREMAXIMALE'),tm:col('TM','TMK','TMOY','TEMPERATUREMOYENNE'),sid:col('NUM_POSTE','NUMPOSTE','IDSTATION','ID_STATION','POSTE'),sname:col('NOM_USUEL','NOMUSUEL','NOM_STATION','NOMSTATION','NOM')};
  if(ix.date<0)throw new Error('Colonne date Météo-France introuvable dans le CSV.');
  const dateValue=v=>{const z=String(v||'').trim();if(/^\d{8}$/.test(z))return `${z.slice(0,4)}-${z.slice(4,6)}-${z.slice(6,8)}`;const iso=parseRegistryFrenchDate(z);return iso||(/^\d{4}-\d{2}-\d{2}/.test(z)?z.slice(0,10):'')};
  return rows.slice(1).map(r=>({date:dateValue(r[ix.date]),rr:ix.rr>=0?reproWeatherNum(r[ix.rr]):null,tn:ix.tn>=0?reproWeatherNum(r[ix.tn]):null,tx:ix.tx>=0?reproWeatherNum(r[ix.tx]):null,tm:ix.tm>=0?reproWeatherNum(r[ix.tm]):null,stationId:ix.sid>=0?String(r[ix.sid]||'').trim():'',stationName:ix.sname>=0?String(r[ix.sname]||'').trim():''})).filter(r=>r.date&&(r.rr!=null||r.tn!=null||r.tx!=null||r.tm!=null));
}
function parseMeteoFranceDailyCsv(text){return reproWeatherParseDetailedCsv(text).map(({date,rr,tn,tx,tm})=>({date,rr,tn,tx,tm}));}
function reproWeatherQuarterSummary(records=[]){
  const m=new Map();for(const r of records){const k=quarterKey(r.date);if(!k)continue;if(!m.has(k))m.set(k,{key:k,rain:0,rainDays:0,tempSum:0,tempDays:0,days:0});const b=m.get(k);b.days++;if(r.rr!=null){b.rain+=Number(r.rr)||0;b.rainDays++;}const t=r.tm!=null?r.tm:(r.tn!=null&&r.tx!=null?(r.tn+r.tx)/2:null);if(t!=null){b.tempSum+=t;b.tempDays++;}}
  const arr=[...m.values()].map(b=>({...b,rain:b.rainDays?Math.round(b.rain*10)/10:null,temp:b.tempDays?Math.round(b.tempSum/b.tempDays*10)/10:null}));
  const rains=arr.filter(x=>x.rain!=null&&x.days>=20).map(x=>x.rain).sort((a,b)=>a-b),temps=arr.filter(x=>x.temp!=null&&x.days>=20).map(x=>x.temp).sort((a,b)=>a-b);
  const median=a=>a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):null,baseRain=median(rains),baseTemp=median(temps);
  arr.forEach(b=>{const tags=[];if(b.days>=20&&baseRain!=null&&b.rain!=null){if(b.rain<baseRain*.6)tags.push('nettement plus sec');else if(b.rain>baseRain*1.6)tags.push('nettement plus humide');}if(b.days>=20&&baseTemp!=null&&b.temp!=null){if(b.temp>baseTemp+2)tags.push('nettement plus chaud');else if(b.temp<baseTemp-2)tags.push('nettement plus froid');}b.tags=tags;});
  return new Map(arr.map(x=>[x.key,x]));
}
function reproWeatherCardHtml(inv,farm,periodStart,periodEnd){
  const w=inv?.weather||{},dept=w.department||reproWeatherDepartment(farm)||'',rec=w.records||[],from=rec.length?rec[0].date:'',to=rec.length?rec.at(-1).date:'';
  return `<section class="card repro-weather-card"><div class="section-title"><div><h3>🌦️ Historique Météo-France</h3><div class="muted">Température et pluie quotidiennes pour la chronologie reproduction/mortalité.</div></div><span class="badge ${rec.length?'complete':''}">${rec.length?rec.length+' jour(s) chargé(s)':'Non chargé'}</span></div>${rec.length?`<div class="notice"><strong>Source enregistrée :</strong> Météo-France · ${escapeHtml(w.stationName||w.stationId||'station')} · ${formatDate(from)} → ${formatDate(to)}.</div>`:''}<details ${rec.length?'':'open'}><summary><strong>${rec.length?'Mettre à jour les données météo':'Charger l’historique Météo-France'}</strong></summary><div class="grid cols-2" style="margin-top:12px"><div class="field"><label>Département</label><input id="repro-weather-dept" inputmode="numeric" maxlength="3" value="${escapeHtml(dept)}" placeholder="32 ou 65"></div><div class="field"><label>Période utile</label><div class="muted">${periodStart&&periodEnd?formatDate(periodStart)+' → '+formatDate(periodEnd):'Historique du registre'}</div></div></div><div class="notice"><strong>Fichiers météo inclus dans cette version :</strong> les historiques RR-T-Vent des départements 32 et 65 fournis le 28/08/2026. <button type="button" class="btn secondary small" id="repro-weather-bundled">Utiliser les fichiers inclus</button></div><div class="actions"><select id="repro-weather-station"><option value="${escapeHtml(w.stationId||'')}">${w.stationId?escapeHtml((w.stationName||w.stationId)+' — station enregistrée'):'Choisir une station…'}</option></select><button class="btn primary small" id="repro-weather-import" type="button">Intégrer la station choisie</button>${rec.length?'<button class="btn secondary small" id="repro-weather-export" type="button">Exporter le CSV météo chargé</button><button class="btn danger small" id="repro-weather-clear" type="button">Effacer météo</button>':''}</div><div id="repro-weather-status" class="muted" style="margin-top:8px">Choisis le département, charge les fichiers inclus puis sélectionne la station.</div><div class="notice" style="margin-top:12px"><strong>📌 Pour une future mise à jour Météo-France</strong><br>Site : <a href="https://www.data.gouv.fr/datasets/donnees-climatologiques-de-base-quotidiennes/" target="_blank" rel="noopener">data.gouv.fr — Données climatologiques de base quotidiennes</a>.<br>Prendre les fichiers <code>Q_XX_previous-…_RR-T-Vent.csv.gz</code> et <code>Q_XX_latest-…_RR-T-Vent.csv.gz</code> (XX = 32 ou 65). Tu peux sélectionner les deux fichiers en même temps ci-dessous ; l’application les fusionne.</div><div class="field" style="margin-top:12px"><label>Importer / actualiser manuellement les fichiers Météo-France</label><input id="repro-weather-file" type="file" multiple accept=".csv,.gz,text/csv,application/gzip"><small class="muted">Sélection multiple acceptée : ancien historique + fichier récent. Les doublons station/date sont supprimés automatiquement.</small></div></details></section>`;
}
function reproWeatherBundledFiles(dept,start='',end=''){
  const d=String(dept||'').padStart(2,'0');if(!['32','65'].includes(d))return [];
  const sy=Number(String(start||'').slice(0,4))||null,ey=Number(String(end||'').slice(0,4))||null;
  const files=[];
  if(!sy||sy<=2024)files.push(`./Q_${d}_previous-1950-2024_RR-T-Vent.csv.gz`);
  if(!ey||ey>=2025)files.push(`./Q_${d}_latest-2025-2026_RR-T-Vent.csv.gz`);
  return files;
}
async function reproWeatherLoadBundled(dept,start,end,onProgress){
  const files=reproWeatherBundledFiles(dept,start,end);if(!files.length)throw new Error('Les fichiers inclus concernent uniquement les départements 32 et 65.');
  const all=[];let used=0;
  for(let i=0;i<files.length;i++){
    onProgress?.(`Lecture du fichier météo inclus ${i+1}/${files.length}…`);
    let r=await fetch(files[i],{cache:'no-store'});let usedUrl=files[i];if(!r.ok){const legacy='./meteo/'+files[i].split('/').pop();const r2=await fetch(legacy,{cache:'no-store'});if(r2.ok){r=r2;usedUrl=legacy;}else throw new Error(`Fichier météo inclus absent (${r.status}/${r2.status}) : ${files[i].split('/').pop()}. Vérifie que les 4 fichiers Q_32/Q_65 *_RR-T-Vent.csv.gz ont bien été déposés à la racine GitHub.`);} 
    const text=await reproWeatherUngzipResponse(r,usedUrl);
    const parsed=reproWeatherParseDetailedCsv(text);
    const rows=parsed.filter(z=>(!start||z.date>=start)&&(!end||z.date<=end));
    onProgress?.(`${parsed.length} lignes météo lues, ${rows.length} dans la période utile…`);
    if(rows.length){all.push(...rows);used++;}
  }
  const uniq=new Map();for(const x of all){const k=`${x.stationId||x.stationName}|${x.date}`;if(!uniq.has(k))uniq.set(k,x);}
  if(!uniq.size)throw new Error('Aucune donnée exploitable dans les fichiers météo inclus pour cette période.');
  return {rows:[...uniq.values()],resourcesUsed:used};
}

function reproWeatherResourceText(r){return `${r?.title||''} ${r?.description||''} ${r?.url||''}`;}
function reproWeatherResourceYears(r){const ys=[...reproWeatherResourceText(r).matchAll(/(?:19|20)\d{2}/g)].map(m=>Number(m[0]));return ys.length?[Math.min(...ys),Math.max(...ys)]:[null,null];}
async function reproWeatherUngzipResponse(resp,url=''){
  const buf=await resp.arrayBuffer();
  const isGz=/\.gz(?:\?|$)/i.test(url)||String(resp.headers.get('content-type')||'').includes('gzip');
  if(!isGz)return new TextDecoder('utf-8').decode(buf);
  if(typeof DecompressionStream==='undefined')throw new Error('Ce navigateur ne sait pas décompresser les fichiers .csv.gz Météo-France.');
  const ds=new DecompressionStream('gzip'),stream=new Blob([buf]).stream().pipeThrough(ds);return await new Response(stream).text();
}
async function reproWeatherReadFile(file){if(/\.gz$/i.test(file.name)||file.type.includes('gzip')){if(typeof DecompressionStream==='undefined')throw new Error('Décompression .gz non prise en charge sur ce navigateur.');const stream=file.stream().pipeThrough(new DecompressionStream('gzip'));return await new Response(stream).text();}return await file.text();}
async function reproWeatherDataGouvResources(dept,start,end){
  const metaUrl='https://www.data.gouv.fr/api/1/datasets/donnees-climatologiques-de-base-quotidiennes/';
  const r=await fetch(metaUrl,{headers:{accept:'application/json'}});if(!r.ok)throw new Error(`data.gouv.fr : erreur ${r.status}`);const j=await r.json(),all=Array.isArray(j?.resources)?j.resources:[];
  const d=String(dept||'').padStart(2,'0'),sy=Number(String(start||'').slice(0,4)),ey=Number(String(end||'').slice(0,4));
  let res=all.filter(x=>{const t=reproWeatherResourceText(x);return new RegExp(`(?:^|[/_\\-])Q?[_-]?${d}(?:[_\\-.]|$)`,'i').test(t)&&/\.csv\.gz(?:\?|$)/i.test(x.url||t);});
  res=res.filter(x=>{const [a,b]=reproWeatherResourceYears(x);return a==null||b==null||(!sy&&!ey)||(b>=sy&&a<=ey)});
  res.sort((a,b)=>{const ta=reproWeatherResourceText(a),tb=reproWeatherResourceText(b),pa=/RR[-_]?T/i.test(ta)?1:0,pb=/RR[-_]?T/i.test(tb)?1:0;if(pa!==pb)return pb-pa;const ya=reproWeatherResourceYears(a)[1]||0,yb=reproWeatherResourceYears(b)[1]||0;return yb-ya;});
  if(!res.length)throw new Error(`Aucun fichier quotidien Météo-France trouvé pour le département ${d} et cette période.`);return res;
}
async function reproWeatherLoadDepartment(dept,start,end,onProgress){
  const resources=await reproWeatherDataGouvResources(dept,start,end),all=[];let used=0;
  for(let i=0;i<resources.length;i++){const x=resources[i];onProgress?.(`Téléchargement météo ${i+1}/${resources.length}…`);try{const r=await fetch(x.url);if(!r.ok)continue;const text=await reproWeatherUngzipResponse(r,x.url);const rows=reproWeatherParseDetailedCsv(text).filter(z=>(!start||z.date>=start)&&(!end||z.date<=end));if(rows.length){all.push(...rows);used++;}}catch(e){console.warn('Météo data.gouv ressource ignorée',e);}}
  if(!all.length)throw new Error('Les fichiers du département ont été trouvés mais aucune donnée exploitable n’a pu être lue pour la période.');
  const uniq=new Map();for(const x of all){const k=`${x.stationId}|${x.date}`;if(!uniq.has(k))uniq.set(k,x);}return {rows:[...uniq.values()],resourcesUsed:used};
}
function reproWeatherStationsFromRows(rows){const m=new Map();for(const r of rows){const id=r.stationId||r.stationName;if(!id)continue;if(!m.has(id))m.set(id,{id,name:r.stationName||id,count:0,from:r.date,to:r.date});const x=m.get(id);x.count++;if(r.date<x.from)x.from=r.date;if(r.date>x.to)x.to=r.date;}return [...m.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name),'fr'));}
function reproWeatherExportCsv(inv){const w=inv?.weather||{},rows=w.records||[];if(!rows.length)return;const esc=v=>`"${String(v??'').replace(/"/g,'""')}"`;const csv=['DATE;STATION;NOM;RR;TN;TX;TM',...rows.map(r=>[r.date,w.stationId||'',w.stationName||'',r.rr??'',r.tn??'',r.tx??'',r.tm??''].map(esc).join(';'))].join('\n');const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`meteo_${String(w.department||'').padStart(2,'0')}_${(w.stationName||w.stationId||'station').replace(/[^a-z0-9]+/gi,'_')}_${w.from||'debut'}_${w.to||'fin'}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function reproIsPurchaseIntroduction(a){
  const raw=String(a?.entryCause||'').trim(),cause=normalizeSearchText(raw).trim();
  if(!cause)return false;
  if(/naiss|ne sur|né sur|birth|mutation interne|transfert interne/.test(cause))return false;
  // Mouvements réellement assimilés à une introduction dans le registre métier :
  // uniquement ACHAT et PENSION. Les autres libellés/codes ne sont pas comptés.
  return cause==='achat' || cause==='pension';
}
function reproDateInRange(d,from,to){return !!d&&(!from||d>=from)&&(!to||d<=to);}
function reproQuarterEndDates(from,to){
  if(!from||!to)return [];
  const a=new Date(from+'T12:00:00'),b=new Date(to+'T12:00:00');if(isNaN(a)||isNaN(b))return [];
  const out=[];let y=a.getFullYear(),q=Math.floor(a.getMonth()/3)+1;
  while(true){const d=new Date(y,q*3,0,12),iso=d.toISOString().slice(0,10);if(iso>=from&&iso<=to)out.push(iso);q++;if(q>4){q=1;y++;}if(y>b.getFullYear()+1)break;if(iso>to)break;}
  if(!out.length||out.at(-1)<to)out.push(to);
  return [...new Set(out)];
}
function reproWindowStart(endIso,days=364){return dateShiftDays(endIso,-days);}
function reproMedian(values=[]){const a=values.filter(Number.isFinite).slice().sort((x,y)=>x-y);if(!a.length)return null;const i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;}
function reproRollingStats(records,calves,purchases,endIso){
  const from=reproWindowStart(endIso,364),prevEnd=dateShiftDays(from,-1),prevFrom=reproWindowStart(prevEnd,364);
  const calc=(a,b)=>{const rr=records.filter(x=>reproDateInRange(x.nextCalving,a,b)),vals=rr.map(x=>x.ivv),births=calves.filter(x=>reproDateInRange(x.birthDate,a,b)),deaths=births.filter(x=>x.exitCause==='M'&&x.exitDate&&daysBetweenDates(x.birthDate,x.exitDate)>=0&&daysBetweenDates(x.birthDate,x.exitDate)<183);return {from:a,to:b,records:rr,n:vals.length,avg:vals.length?Math.round(vals.reduce((s,v)=>s+v,0)/vals.length):null,median:vals.length?Math.round(reproMedian(vals)):null,badRate:vals.length?Math.round(vals.filter(v=>v>450).length/vals.length*100):null,births:births.length,deaths:deaths.length,mortRate:births.length?Math.round(deaths.length/births.length*1000)/10:null};};
  const cur=calc(from,endIso),prev=calc(prevFrom,prevEnd);cur.prev=prev;cur.deltaAvg=cur.avg!=null&&prev.avg!=null?cur.avg-prev.avg:null;cur.deltaMedian=cur.median!=null&&prev.median!=null?cur.median-prev.median:null;cur.deltaBad=cur.badRate!=null&&prev.badRate!=null?cur.badRate-prev.badRate:null;cur.deltaMort=cur.mortRate!=null&&prev.mortRate!=null?Math.round((cur.mortRate-prev.mortRate)*10)/10:null;
  const longConcept=cur.records.filter(x=>x.ivv>450&&x.conception).map(x=>x.conception).sort();const contextFrom=longConcept.length?dateShiftDays(longConcept[0],-90):from,contextTo=longConcept.length?longConcept.at(-1):endIso;
  cur.purchases=purchases.filter(x=>reproDateInRange(x.entryDate,contextFrom,contextTo));cur.contextFrom=contextFrom;cur.contextTo=contextTo;
  return cur;
}
function reproMonthKey(date){return date?String(date).slice(0,7):'';}
function reproMonthStart(key){return key?`${key}-01`:'';}
function reproMonthEnd(key){if(!key)return '';const [y,m]=key.split('-').map(Number),d=new Date(y,m,0,12);return d.toISOString().slice(0,10);}
function reproMonthsBetween(from,to){if(!from||!to)return [];const a=new Date(from+'T12:00:00'),b=new Date(to+'T12:00:00');if(isNaN(a)||isNaN(b))return [];const out=[];let y=a.getFullYear(),m=a.getMonth();while(y<b.getFullYear()||(y===b.getFullYear()&&m<=b.getMonth())){out.push(`${y}-${String(m+1).padStart(2,'0')}`);m++;if(m>11){m=0;y++;}}return out;}
function reproWeatherTagsForRange(records,from,to){
  const qs=reproWeatherQuarterSummary(records||[]),tags=new Set();
  for(const m of reproMonthsBetween(from,to)){const [y,mo]=m.split('-').map(Number),q=`${y}-T${Math.floor((mo-1)/3)+1}`;for(const t of qs.get(q)?.tags||[])tags.add(t);}
  return [...tags];
}
function reproProbableAbortionEvents(cows=[]){
  // Heuristique prudente : un veau mort à la naissance/≤2 j, avec une mise bas précédente
  // moins de 240 jours auparavant, ne peut pas correspondre à une gestation bovine normale à terme.
  // On le signale comme « avortement / mise bas prématurée probable », jamais comme diagnostic certain.
  const out=[];
  for(const r of cows||[]){
    const cs=(r.calves||[]).filter(c=>c.birthDate).slice().sort((a,b)=>a.birthDate.localeCompare(b.birthDate));
    for(let i=1;i<cs.length;i++){
      const prev=cs[i-1],c=cs[i],gap=daysBetweenDates(prev.birthDate,c.birthDate),ageDeath=c.exitDate?daysBetweenDates(c.birthDate,c.exitDate):null;
      if(gap!=null&&gap>0&&gap<240&&c.exitCause==='M'&&ageDeath!=null&&ageDeath>=0&&ageDeath<=2){
        out.push({date:c.birthDate,cow:r.cow,calf:c,previousCalving:prev.birthDate,gapDays:gap,label:`Mort-né/décès ≤2 j ${gap} j après la mise bas précédente`});
      }
    }
  }
  return out;
}
function reproMortalityEventsForRange(registry=[],from='',to=''){
  return (registry||[]).filter(a=>a.exitCause==='M'&&a.exitDate&&reproDateInRange(a.exitDate,from,to)).map(a=>{
    const age=a.birthDate?daysBetweenDates(a.birthDate,a.exitDate):null;
    let ageClass='âge inconnu';
    if(age!=null){if(age<=2)ageClass='0–2 j';else if(age<31)ageClass='3 j–1 mois';else if(age<183)ageClass='1–6 mois';else if(age<365)ageClass='6–12 mois';else if(age<730)ageClass='12–24 mois';else ageClass='>24 mois';}
    return {...a,ageDays:age,ageClass};
  });
}
function reproMortalitySummary(events=[]){const m=new Map();for(const e of events)m.set(e.ageClass,(m.get(e.ageClass)||0)+1);return [...m.entries()].map(([k,v])=>`${v} ${k}`).join(', ');}
function reproConceptionDelayEpisodes(intervals,calves,purchases,cows,registry,inv,weatherRecords){
  // On cherche une concentration de retards de conception, et non un « IVV trimestriel ».
  // Référence : IVV cible 400 j => conception attendue ~117 j après le vêlage précédent (400-283).
  const delayed=intervals.filter(x=>x.ivv>420&&x.prevCalving&&x.nextCalving).map(x=>{
    const expected=dateShiftDays(x.prevCalving,117),actual=dateShiftDays(x.nextCalving,-283),delay=Math.max(0,daysBetweenDates(expected,actual));
    return {...x,expectedConception:expected,actualConception:actual,delayDays:delay};
  }).filter(x=>x.delayDays>=21&&x.expectedConception&&x.actualConception&&x.actualConception>=x.expectedConception);
  if(delayed.length<3)return [];
  const min=delayed.map(x=>x.expectedConception).sort()[0],max=delayed.map(x=>x.actualConception).sort().at(-1),months=reproMonthsBetween(min,max);
  const minCount=Math.max(3,Math.ceil(intervals.length*0.12));
  const active=months.map(key=>{const from=reproMonthStart(key),to=reproMonthEnd(key),rows=delayed.filter(x=>x.expectedConception<=to&&x.actualConception>=from);return {key,from,to,rows,count:new Set(rows.map(x=>normalizeAnimalId(x.cow?.id||''))).size};}).filter(x=>x.count>=minCount);
  if(!active.length)return [];
  const groups=[];for(const m of active){const last=groups.at(-1);if(last&&daysBetweenDates(last.at(-1).to,m.from)<=35)last.push(m);else groups.push([m]);}
  return groups.map(g=>{
    const from=g[0].from,to=g.at(-1).to,rows=[...new Map(g.flatMap(x=>x.rows).map(r=>[`${normalizeAnimalId(r.cow?.id||'')}|${r.nextCalving}`,r])).values()];
    const cowsCount=new Set(rows.map(r=>normalizeAnimalId(r.cow?.id||''))).size,delays=rows.map(r=>r.delayDays).filter(Number.isFinite),medianDelay=Math.round(reproMedian(delays)||0),maxDelay=Math.max(...delays);
    const dead=calves.filter(c=>c.exitCause==='M'&&c.exitDate&&reproDateInRange(c.exitDate,dateShiftDays(from,-30),dateShiftDays(to,30))&&c.birthDate&&daysBetweenDates(c.birthDate,c.exitDate)>=0&&daysBetweenDates(c.birthDate,c.exitDate)<183);
    const mortalityAll=reproMortalityEventsForRange(registry,dateShiftDays(from,-30),dateShiftDays(to,30));
    const intros=purchases.filter(a=>reproDateInRange(a.entryDate,dateShiftDays(from,-90),to));
    const events=(inv?.events||[]).filter(e=>e.date&&reproDateInRange(e.date,dateShiftDays(from,-45),dateShiftDays(to,45)));
    const abortions=events.filter(e=>/avort/i.test(`${e.type||''} ${e.label||''}`));
    const probableAbortions=reproProbableAbortionEvents(cows).filter(e=>reproDateInRange(e.date,dateShiftDays(from,-45),dateShiftDays(to,45)));
    const sanitary=events.filter(e=>/malad|sanit|virus|diarr|respir|fiev|fièv/i.test(`${e.type||''} ${e.label||''}`));
    const feeding=events.filter(e=>/aliment|fourrage|ration|mineral|minéral|ensilage|paturage|pâturage/i.test(`${e.type||''} ${e.label||''}`));
    const weatherTags=reproWeatherTagsForRange(weatherRecords,from,to);
    let score=3;if(cowsCount>=Math.max(5,Math.ceil(intervals.length*0.2)))score++;if(dead.length||mortalityAll.length>=2||abortions.length||probableAbortions.length||sanitary.length)score+=2;if(intros.length||feeding.length||weatherTags.length)score++;
    return {from,to,cowsCount,rows,medianDelay,maxDelay,dead,mortalityAll,intros,events,abortions,probableAbortions,sanitary,feeding,weatherTags,severity:score};
  }).sort((a,b)=>b.severity-a.severity||b.cowsCount-a.cowsCount).slice(0,4);
}
function reproChronology(registry,cows,periodStart,periodEnd,inv){
  const intervals=[];
  for(const r of cows){for(let i=0;i<r.intervals.length;i++){const ivv=r.intervals[i],prevCalving=r.calvingDates[i],nextCalving=r.calvingDates[i+1],conception=dateShiftDays(nextCalving,-283);if(ivv&&nextCalving)intervals.push({ivv,cow:r.cow,prevCalving,nextCalving,conception});}}
  const calves=cows.flatMap(r=>r.calves||[]).filter(c=>c.birthDate);
  const purchases=(registry||[]).filter(reproIsPurchaseIntroduction);
  const minDate=periodStart||intervals.map(x=>x.nextCalving).sort()[0]||calves.map(x=>x.birthDate).sort()[0]||'',maxDate=periodEnd||intervals.map(x=>x.nextCalving).sort().at(-1)||calves.map(x=>x.birthDate).sort().at(-1)||'';
  const weatherMap=reproWeatherQuarterSummary(inv?.weather?.records||[]);
  const buckets=reproQuarterEndDates(minDate,maxDate).map(end=>{
    const x=reproRollingStats(intervals,calves,purchases,end),q=quarterKey(end),w=weatherMap.get(q)||null;
    let severity=0;const reasons=[];
    const enough=x.n>=12,prevEnough=x.prev.n>=8;
    const clearRise=enough&&prevEnough&&((x.deltaAvg!=null&&x.deltaAvg>=25&&x.avg>=410)||(x.deltaMedian!=null&&x.deltaMedian>=20&&x.median>=410)||(x.deltaBad!=null&&x.deltaBad>=15&&x.badRate>=25));
    const absolutePoor=enough&&x.median!=null&&x.median>=430&&x.badRate>=35;
    if(clearRise){severity+=3;reasons.push('dégradation nette par rapport aux 12 mois précédents');}
    if(absolutePoor){severity+=2;reasons.push('niveau IVV durablement défavorable');}
    const mortRise=x.births>=15&&x.mortRate!=null&&((x.prev.births>=10&&x.deltaMort!=null&&x.deltaMort>=5&&x.mortRate>=8)||x.mortRate>=15);
    if(mortRise){severity+=3;reasons.push('hausse significative de mortalité veaux');}
    return {...x,key:q,endDate:end,severity,reasons,weather:w};
  });
  const problems=buckets.filter(b=>b.severity>=3);
  const conceptionEpisodes=reproConceptionDelayEpisodes(intervals,calves,purchases,cows,registry,inv,inv?.weather?.records||[]);
  return {buckets,problems,conceptionEpisodes};
}
function reproChronologyInsights(chrono){
  const out=[];
  for(const ep of chrono?.conceptionEpisodes||[]){
    const signals=[`${ep.cowsCount} vache(s) présentent un retard de conception qui se recouvre sur cette période`, `retard médian estimé ${ep.medianDelay} j${ep.maxDelay>ep.medianDelay?` (max ${ep.maxDelay} j)`:''}`];
    const links=[];
    if(ep.abortions.length)links.push(`${ep.abortions.length} événement(s) d’avortement saisi(s) à proximité`);
    if(ep.probableAbortions?.length)links.push(`${ep.probableAbortions.length} mort-né(s)/décès ≤2 j avec intervalle de vêlage <240 j : avortement ou mise bas prématurée probable à vérifier`);
    if(ep.mortalityAll?.length)links.push(`${ep.mortalityAll.length} mortalité(s) toutes classes d’âge à proximité (${reproMortalitySummary(ep.mortalityAll)})`);
    if(ep.sanitary.length)links.push(`${ep.sanitary.length} événement(s) sanitaire(s) saisi(s)`);
    if(ep.intros.length)links.push(`${ep.intros.length} introduction(s) ACHAT ou PENSION dans les 90 j précédents ou pendant la période`);
    if(ep.feeding.length)links.push(`${ep.feeding.length} changement(s) alimentation/fourrage saisi(s)`);
    if(ep.weatherTags.length)links.push(`météo : ${ep.weatherTags.join(', ')}`);
    const questions=[];
    if(ep.intros.length)questions.push('Vérifier statut sanitaire, quarantaine et chronologie des animaux introduits/pensionnés.');
    if(ep.abortions.length||ep.probableAbortions?.length||ep.sanitary.length||ep.mortalityAll?.length)questions.push('La concomitance reproduction–sanitaire mérite d’être vérifiée : avortements/mises bas prématurées, fièvre, diarrhées, respiratoire, analyses et vaccination autour de cette période.');
    if(ep.feeding.length||ep.weatherTags.some(x=>/sec|chaud|pluie|hum/i.test(x)))questions.push('Vérifier ration, changement de fourrage, état corporel, abreuvement et conséquences de la météo sur la quantité/qualité des fourrages.');
    if(!questions.length)questions.push('Rechercher ce qui a changé pendant cette fenêtre : taureaux/lots, détection des chaleurs, alimentation, sanitaire, bâtiment ou météo.');
    out.push({label:`${formatDate(ep.from)} → ${formatDate(ep.to)}`,signals,links,questions,peak:{severity:ep.severity},kind:'conception'});
  }
  if(out.length)return out.slice(0,4);
  const flagged=(chrono?.problems||[]).slice().sort((a,b)=>a.endDate.localeCompare(b.endDate));if(!flagged.length)return [];
  const groups=[];for(const b of flagged){const last=groups.at(-1);if(last&&daysBetweenDates(last.at(-1).endDate,b.endDate)<=100)last.push(b);else groups.push([b]);}
  return groups.map(g=>{
    const peak=g.slice().sort((a,b)=>b.severity-a.severity||((b.deltaAvg||0)-(a.deltaAvg||0)))[0];
    const signals=[];
    if(peak.n>=12&&peak.avg!=null){signals.push(`IVV sur 12 mois : moyenne ${peak.avg} j, médiane ${peak.median} j (${peak.n} IVV)`);if(peak.deltaAvg!=null&&peak.deltaAvg>0)signals.push(`+${Math.round(peak.deltaAvg)} j de moyenne vs les 12 mois précédents`);if(peak.badRate!=null)signals.push(`${peak.badRate}% des IVV >450 j`);}
    if(peak.births>=15&&peak.mortRate!=null&&peak.severity>=3){if(peak.deltaMort!=null&&peak.deltaMort>0)signals.push(`mortalité veaux ${peak.mortRate}% (+${peak.deltaMort} points)`);else if(peak.mortRate>=15)signals.push(`mortalité veaux ${peak.mortRate}%`);}
    const links=[];if(peak.purchases.length)links.push(`${peak.purchases.length} introduction(s) ACHAT ou PENSION réellement identifiée(s)`);if(peak.weather?.tags?.length)links.push(`météo : ${peak.weather.tags.join(', ')}`);
    const questions=[];if(peak.purchases.length)questions.push('Vérifier si les introductions/pensions précèdent l’apparition du problème et leur statut sanitaire ; cette proximité temporelle ne prouve pas un lien.');if(peak.weather?.tags?.some(x=>/sec|chaud/i.test(x)))questions.push('Vérifier disponibilité et qualité des fourrages, état corporel, abreuvement et complémentation sur cette période.');if(peak.mortRate>=8&&peak.avg>=430)questions.push('Reproduction et mortalité se dégradent ensemble : rechercher une cause commune sanitaire, alimentaire ou environnementale.');if(!questions.length)questions.push('Cibler pendant l’audit les changements de conduite, alimentation, sanitaire, lots/taureaux et détection des chaleurs autour de cette période.');
    const label=g.length>1?`${g[0].key} → ${g.at(-1).key}`:`${peak.key}`;
    return {label,signals,links,questions,peak,kind:'rolling'};
  }).sort((a,b)=>b.peak.severity-a.peak.severity).slice(0,4);
}
function reproChronologyInsightHtml(chrono,{print=false}={}){
  const insights=reproChronologyInsights(chrono);if(!insights.length)return '<div class="notice"><strong>✓ Pas de période commune de retard de conception ni de dégradation majeure mise en évidence.</strong><br><span class="muted">L’analyse cherche d’abord des retards de conception qui se chevauchent chez plusieurs vaches, puis utilise les fenêtres glissantes de 12 mois comme contrôle de tendance.</span></div>';
  return `<div class="repro-cross-analysis">${insights.map((x,i)=>`<article class="notice ${i===0?'warning':''}"><strong>${i===0?'🔴':'🟠'} ${escapeHtml(x.label)} — ${x.kind==='conception'?'fenêtre probable de perturbation de la conception':'tendance à éclaircir'}</strong><div><b>Pourquoi cette période ressort :</b> ${escapeHtml(x.signals.join(' · ')||'signal confirmé')}</div>${x.links.length?`<div><b>Éléments concomitants à vérifier :</b> ${escapeHtml(x.links.join(' · '))}</div>`:'<div class="muted">Aucun événement sanitaire, introduction/pension, changement alimentaire ou signal météo n’est automatiquement associé à cette fenêtre.</div>'}<div><b>À éclaircir pendant l’audit :</b> ${escapeHtml(x.questions.join(' '))}</div></article>`).join('')}</div>`;
}
function reproChronologyHtml(chrono){
  if(!chrono.buckets.length)return '<div class="empty">Pas assez d’historique pour construire une chronologie.</div>';
  const synthesis=reproChronologyInsightHtml(chrono);
  const timeline=`<details class="chrono-raw-detail"><summary><strong>Voir le contrôle technique — tendances glissantes de 12 mois</strong></summary><div class="muted">Ce tableau sert seulement de contrôle de tendance. La synthèse ci-dessus cherche prioritairement une période où plusieurs vaches ont simultanément pris du retard à la conception. Une baisse d’IVV n’est jamais considérée comme une dégradation.</div><div class="table-wrap"><table class="compact-table"><thead><tr><th>Fin de période</th><th>IVV 12 mois</th><th>Médiane</th><th>IVV &gt;450 j</th><th>Évolution vs 12 mois précédents</th><th>Naissances</th><th>Morts &lt;6m</th><th>Introductions ACHAT/PENSION*</th><th>Météo</th></tr></thead><tbody>${chrono.buckets.map(b=>`<tr class="${b.severity>=3?'repro-period-warning':''}"><td><strong>${b.key}</strong><br><small>${formatDate(b.from)} → ${formatDate(b.to)}</small></td><td>${b.avg??'—'}${b.avg!=null?' j':''} <small>(${b.n})</small></td><td>${b.median??'—'}${b.median!=null?' j':''}</td><td>${b.badRate==null?'—':b.badRate+'%'}</td><td>${b.deltaAvg==null?'—':(b.deltaAvg>0?'+':'')+Math.round(b.deltaAvg)+' j'}${b.deltaBad==null?'':`<br><small>${b.deltaBad>0?'+':''}${b.deltaBad} points &gt;450 j</small>`}</td><td>${b.births}</td><td>${b.mortRate==null?'—':b.mortRate+'%'}</td><td>${b.purchases.length}</td><td>${b.weather?`${b.weather.rain==null?'—':b.weather.rain+' mm'}<br><small>${b.weather.temp==null?'—':b.weather.temp+' °C'}${b.weather.tags?.length?' · '+escapeHtml(b.weather.tags.join(', ')):''}</small>`:'—'}</td></tr>`).join('')}</tbody></table></div><div class="muted">* Sont considérés comme introductions uniquement les mouvements dont la cause est ACHAT ou PENSION. Les naissances sur l’exploitation ne sont jamais comptées. Les avortements issus du fichier technico-économique sont annuels : faute de date précise, ils ne sont pas artificiellement rattachés à un mois ; seuls les événements datés peuvent être croisés à une fenêtre précise.</div></details>`;
  return synthesis+timeline;
}
function reproInvestigationHtml(visit,inv,stats){
  const heat=reproHeatAssessment(inv,stats),bull=reproBullAssessment(inv,stats);
  const badge=x=>x==='ok'?'complete':x==='danger'?'danger':x==='warning'?'in-progress':'';
  return `<section class="card"><div class="section-title"><div><h3>🔥 Détection des chaleurs</h3><div class="muted">L’organisation est croisée avec les résultats reproduction.</div></div><span class="badge ${badge(heat.level)}">${escapeHtml(heat.label)}</span></div><div class="grid cols-3"><div class="field"><label>Méthode principale</label><select data-repro-heat="method"><option value="">Non renseigné</option><option value="visual" ${inv.heat.method==='visual'?'selected':''}>Observation visuelle</option><option value="marker" ${inv.heat.method==='marker'?'selected':''}>Marqueur / patch / détecteur de monte</option><option value="activity" ${inv.heat.method==='activity'?'selected':''}>Collier / podomètre / activité</option><option value="bull" ${inv.heat.method==='bull'?'selected':''}>Taureau / mâle détecteur</option><option value="mixed" ${inv.heat.method==='mixed'?'selected':''}>Plusieurs méthodes</option><option value="none" ${inv.heat.method==='none'?'selected':''}>Pas de détection organisée</option></select></div><div class="field"><label>Observations / jour</label><input type="number" min="0" max="10" step="1" data-repro-heat="frequency" value="${escapeHtml(inv.heat.frequency??'')}"></div><div class="field"><label>Suivi des retours en chaleurs</label><select data-repro-heat="returns"><option value="">Non renseigné</option><option value="yes" ${inv.heat.returns==='yes'?'selected':''}>Oui, systématique</option><option value="partial" ${inv.heat.returns==='partial'?'selected':''}>Partiel</option><option value="no" ${inv.heat.returns==='no'?'selected':''}>Non</option></select></div></div><div class="field"><label>Organisation / qui observe / horaires / difficultés</label><textarea data-repro-heat="notes">${escapeHtml(inv.heat.notes||'')}</textarea></div><div class="notice"><strong>Lecture :</strong> ${heat.notes.map(escapeHtml).join(' ')}</div></section>
  <section class="card"><div class="section-title"><div><h3>🐂 Taureaux et organisation des lots</h3><div class="muted">Le calcul utilise les femelles réellement en contact avec chaque taureau, pas seulement l’effectif total.</div></div><span class="badge ${badge(bull.overall)}">${bull.overall==='ok'?'Ratios convenables':bull.overall==='warning'?'À surveiller':bull.overall==='danger'?'Ratio élevé':'À renseigner'}</span></div><div class="grid cols-3"><div class="field"><label>Mode de reproduction</label><select data-repro-setting="mode"><option value="">Non renseigné</option><option value="natural" ${inv.settings.mode==='natural'?'selected':''}>Monte naturelle</option><option value="ai" ${inv.settings.mode==='ai'?'selected':''}>IA</option><option value="mixed" ${inv.settings.mode==='mixed'?'selected':''}>IA + rattrapage taureau</option></select></div><div class="field"><label>Seuil adulte (femelles/taureau)</label><input type="number" min="5" max="80" data-repro-setting="adultBullMax" value="${escapeHtml(inv.settings.adultBullMax)}"></div><div class="field"><label>Seuil jeune taureau</label><input type="number" min="5" max="60" data-repro-setting="youngBullMax" value="${escapeHtml(inv.settings.youngBullMax)}"></div></div><div id="repro-bull-list">${inv.bulls.map((b,i)=>`<div class="repro-bull-row" data-repro-bull-row="${i}"><input placeholder="Nom / n° taureau" data-bull-field="name" value="${escapeHtml(b.name||'')}"><select data-bull-field="ageClass"><option value="adult" ${b.ageClass!=='young'?'selected':''}>Adulte</option><option value="young" ${b.ageClass==='young'?'selected':''}>Jeune</option></select><input type="number" min="0" placeholder="Femelles réellement exposées" data-bull-field="females" value="${escapeHtml(b.females??'')}"><input type="number" min="0" placeholder="Jours de contact" data-bull-field="contactDays" value="${escapeHtml(b.contactDays??'')}"><select data-bull-field="fertility"><option value="">Fertilité ?</option><option value="yes" ${b.fertility==='yes'?'selected':''}>Contrôlée</option><option value="no" ${b.fertility==='no'?'selected':''}>Non contrôlée</option></select><button class="btn danger small" data-delete-bull="${i}">×</button></div>`).join('')}</div><button class="btn secondary small" id="add-repro-bull">+ Ajouter un taureau</button>${bull.details.length?`<div class="table-wrap" style="margin-top:12px"><table class="compact-table"><thead><tr><th>Taureau</th><th>Femelles</th><th>Seuil</th><th>Lecture</th></tr></thead><tbody>${bull.details.map(b=>`<tr><td>${escapeHtml(b.name||'Sans nom')}</td><td>${b.females}</td><td>${b.limit}</td><td><span class="badge ${badge(b.status)}">${b.status==='ok'?'Convenable':b.status==='warning'?'À surveiller':'Trop élevé'}</span></td></tr>`).join('')}</tbody></table></div>`:''}<div class="notice"><strong>Analyse :</strong> ${bull.notes.map(escapeHtml).join(' ')}</div><div class="field"><label>Organisation réelle des lots / rotations / taureaux absents / estive</label><textarea data-repro-setting="lotNotes">${escapeHtml(inv.settings.lotNotes||'')}</textarea></div></section>`;
}
function reproAgeDistributionHtml(animals=[],analysisDate=''){
  const vals=animals.map(a=>({animal:a,months:monthsBetweenDates(a.birthDate,analysisDate)})).filter(x=>x.months!=null&&x.months>=24);
  if(!vals.length)return `<section class="card"><h3>🥧 Répartition des femelles par âge</h3><div class="empty">Âges non disponibles dans le registre.</div></section>`;
  const years=new Map();for(const x of vals){const y=Math.max(2,Math.floor(x.months/12));years.set(y,(years.get(y)||0)+1);}
  const entries=[...years.entries()].sort((a,b)=>a[0]-b[0]),total=vals.length;
  let cursor=0;const colors=['#f5a3c2','#de6f9c','#bd4a7c','#9b3a68','#7d4a8d','#6970a5','#5b8aa1','#62a08d','#83aa6a','#b4ae5f','#c7905c','#b86a66'];
  const stops=entries.map(([y,n],i)=>{const start=cursor,end=cursor+n/total*100;cursor=end;return `${colors[i%colors.length]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;}).join(',');
  const legend=entries.map(([y,n],i)=>{const pct=Math.round(n/total*1000)/10;return `<button type="button" class="repro-age-legend-item" data-age-year="${y}" title="Voir les femelles de ${y} ans"><i style="background:${colors[i%colors.length]}"></i><span><strong>${y} an${y>1?'s':''}</strong> — ${n} (${pct}%)</span></button>`;}).join('');
  const avg=Math.round(vals.reduce((a,x)=>a+x.months,0)/vals.length/12*10)/10,max=Math.max(...vals.map(x=>x.months)),oldest=vals.filter(x=>x.months===max).map(x=>x.animal);
  return `<section class="card repro-age-distribution"><div class="section-title"><div><h3>🥧 Répartition des femelles par âge</h3><div class="muted">Femelles présentes de 24 mois et plus, indépendamment du filtre d’âge utilisé pour les IVV.</div></div><span class="badge">${total} femelle(s)</span></div><div class="repro-age-overview"><div class="repro-age-donut" style="background:conic-gradient(${stops})"><span>${total}<small>femelles</small></span></div><div class="repro-age-legend">${legend}</div></div><div class="repro-kpi-grid compact"><article class="card metric"><strong>${String(avg).replace('.',',')} ans</strong><span>Âge moyen des femelles ≥24 mois</span></article><article class="card metric"><strong>${Math.floor(max/12)} a ${max%12} m</strong><span>Âge maximum</span><small>${oldest.map(a=>escapeHtml(a.name||a.workNumber||a.id)).join(', ')}</small></article></div><div id="repro-age-year-detail"></div></section>`;
}
function renderReproduction(){
  const visit=activeVisit(),selectedFarmId=visit?.farmId||localStorage.getItem('audit-bovin-repro-farm')||db.farms[0]?.id||'',farm=db.farms.find(f=>f.id===selectedFarmId),source=reproductionSourceForVisit(visit,farm),registry=source.registry||[],meta=source.meta;
  if(!farm){app.innerHTML='<section class="card empty">Créez une exploitation avant d’utiliser la reproduction.</section>';return;}
  const reproFarm={...farm,herdRegistry:registry};
  const fullPeriod=reproductionRegistryPeriod(registry),periodMin=meta?.period?.from||fullPeriod.from||'',periodMax=meta?.period?.to||fullPeriod.to||new Date().toISOString().slice(0,10);
  const periodKey=`audit-bovin-repro-period-${visit?.id||selectedFarmId||'default'}`;
  let saved={};try{saved=JSON.parse(localStorage.getItem(periodKey)||'{}')||{}}catch(_){saved={};}
  const defaultYearStart=reproductionDefaultYearStart(periodMin,periodMax);let periodStart=saved.start||defaultYearStart,periodEnd=saved.end||periodMax;
  if(periodMin&&periodStart<periodMin)periodStart=periodMin;if(periodMax&&periodEnd>periodMax)periodEnd=periodMax;if(periodStart&&periodEnd&&periodStart>periodEnd){periodStart=periodMin;periodEnd=periodMax;}
  const analysisDate=periodEnd||new Date().toISOString().slice(0,10);
  const ageKey=`audit-bovin-repro-age-${visit?.id||selectedFarmId||'default'}`;let ageSaved={};try{ageSaved=JSON.parse(localStorage.getItem(ageKey)||'{}')||{}}catch(_){ageSaved={};}let ageMin=Math.max(18,Number(ageSaved.min??36)),ageMax=Math.min(180,Number(ageSaved.max??180));if(ageMin>ageMax)[ageMin,ageMax]=[ageMax,ageMin];
  const presentFemalesAll=registry.filter(a=>a.sex==='F'&&isRegistryAnimalPresent(a,analysisDate)),currentCowsAll=currentReproductionCows(reproFarm,analysisDate),presentFemales=presentFemalesAll.filter(a=>reproAgeInRange(a,analysisDate,ageMin,ageMax)),currentCows=currentCowsAll.filter(r=>reproAgeInRange(r.cow,analysisDate,ageMin,ageMax)),cowIds=new Set(currentCowsAll.map(r=>normalizeAnimalId(r.cow.id))),breeding24=presentFemales.filter(a=>monthsBetweenDates(a.birthDate,analysisDate)>24),breeding36=presentFemales.filter(a=>monthsBetweenDates(a.birthDate,analysisDate)>36),presentHeifers=breeding24.filter(a=>!cowIds.has(normalizeAnimalId(a.id))),heifers36=presentHeifers.filter(a=>monthsBetweenDates(a.birthDate,analysisDate)>36);
  const intervalEvents=currentCows.flatMap(r=>r.intervals.map((v,i)=>({v,date:r.calvingDates[i+1]||''}))).filter(e=>e.date&&(!periodStart||e.date>=periodStart)&&(!periodEnd||e.date<=periodEnd)),allIvvs=intervalEvents.map(e=>e.v);
  const firstIvvs=currentCows.map(r=>({v:r.intervals[0],date:r.calvingDates[1]||''})).filter(e=>e.v!=null&&e.date&&(!periodStart||e.date>=periodStart)&&(!periodEnd||e.date<=periodEnd)).map(e=>e.v);
  const allCalves=currentCows.flatMap(r=>r.calves).filter(c=>c.birthDate&&(!periodStart||c.birthDate>=periodStart)&&(!periodEnd||c.birthDate<=periodEnd)),deadCalves=allCalves.filter(c=>c.exitCause==='M'&&c.exitDate&&daysBetweenDates(c.birthDate,c.exitDate)<183),maleIds=new Set(registry.filter(a=>a.sex==='M').map(a=>normalizeAnimalId(a.id))),knownFather=allCalves.filter(c=>c.fatherId),probableIA=knownFather.filter(c=>!maleIds.has(normalizeAnimalId(c.fatherId)));
  const presentNow=registry.filter(a=>isRegistryAnimalPresent(a,analysisDate)),ageM=a=>monthsBetweenDates(a.birthDate,analysisDate),females24Count=presentNow.filter(a=>a.sex==='F'&&ageM(a)!=null&&ageM(a)>24).length,females36Count=presentNow.filter(a=>a.sex==='F'&&ageM(a)!=null&&ageM(a)>36).length,males24Count=presentNow.filter(a=>a.sex==='M'&&ageM(a)!=null&&ageM(a)>24).length,males36Count=presentNow.filter(a=>a.sex==='M'&&ageM(a)!=null&&ageM(a)>36).length;
  const mothers=new Set(allCalves.map(c=>normalizeAnimalId(c.motherId))),ids24=new Set(breeding24.map(a=>normalizeAnimalId(a.id))),ids36=new Set(breeding36.map(a=>normalizeAnimalId(a.id))),calved24=[...mothers].filter(id=>ids24.has(id)).length,calved36=[...mothers].filter(id=>ids36.has(id)).length;
  const primipares=currentCows.filter(r=>r.calves.length===1);
  const stats={ivvMean:allIvvs.length?Math.round(allIvvs.reduce((a,b)=>a+b,0)/allIvvs.length):null,ivv12:firstIvvs.length?Math.round(firstIvvs.reduce((a,b)=>a+b,0)/firstIvvs.length):null,ivvMin:allIvvs.length?Math.min(...allIvvs):null,ivvMax:allIvvs.length?Math.max(...allIvvs):null,firstMean:(()=>{const v=currentCows.map(r=>r.firstCalvingAgeMonths).filter(x=>x!=null);return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length*10)/10:null})(),calvingRate24:breeding24.length?Math.round(calved24/breeding24.length*1000)/10:null,calvingRate36:breeding36.length?Math.round(calved36/breeding36.length*1000)/10:null,primipRate:currentCows.length?Math.round(primipares.length/currentCows.length*1000)/10:null};
  let rows=currentCows.slice();if(reproductionFilter==='400')rows=rows.filter(r=>r.daysSinceLast>400);if(reproductionFilter==='ivvLe400')rows=rows.filter(r=>r.meanIVV!=null&&r.meanIVV<=400);if(reproductionFilter==='ivv401to450')rows=rows.filter(r=>r.meanIVV>400&&r.meanIVV<=450);if(reproductionFilter==='ivv451to500')rows=rows.filter(r=>r.meanIVV>450&&r.meanIVV<=500);if(reproductionFilter==='ivvOver500')rows=rows.filter(r=>r.meanIVV>500);if(reproductionFilter==='dead')rows=rows.filter(r=>r.deadBefore6.length>=2);if(reproductionFilter==='under28')rows=rows.filter(r=>r.firstCalvingAgeMonths!=null&&r.firstCalvingAgeMonths<28);if(reproductionFilter==='28to36')rows=rows.filter(r=>r.firstCalvingAgeMonths>=28&&r.firstCalvingAgeMonths<=36);if(reproductionFilter==='over36')rows=rows.filter(r=>r.firstCalvingAgeMonths>36);
  const sorts={lastCalvingOld:(a,b)=>(a.lastCalvingDate||'').localeCompare(b.lastCalvingDate||''),ivvHigh:(a,b)=>(b.meanIVV||0)-(a.meanIVV||0),firstAgeHigh:(a,b)=>(b.firstCalvingAgeMonths||0)-(a.firstCalvingAgeMonths||0),deadHigh:(a,b)=>b.deadBefore6.length-a.deadBefore6.length,scoreLow:(a,b)=>reproductionScore(a)-reproductionScore(b)};rows.sort(sorts[reproductionSort]||sorts.lastCalvingOld);
  const ivvBands=[['≤ 400 j',allIvvs.filter(x=>x<=400).length],['401–450 j',allIvvs.filter(x=>x>400&&x<=450).length],['451–500 j',allIvvs.filter(x=>x>450&&x<=500).length],['> 500 j',allIvvs.filter(x=>x>500).length]];
  const inv=ensureReproInvestigation(visit),chrono=reproChronology(registry,currentCowsAll,periodStart,periodEnd,inv);
  const sourceInfo=meta?`<div class="repro-source-card"><div class="repro-source-head"><strong>📄 CSV utilisé pour cette visite</strong><span class="repro-file">${escapeHtml(meta.fileName||'Nom non disponible')}</span></div><div class="repro-source-meta"><span class="repro-meta-pill">${meta.rowCount||registry.length} ligne(s)</span>${meta.importedAt?`<span class="repro-meta-pill">Importé le ${formatDateTime(meta.importedAt)}</span>`:''}${meta.period?.from||meta.period?.to?`<span class="repro-meta-pill">Données CSV ${meta.period?.from?formatDate(meta.period.from):'—'} → ${meta.period?.to?formatDate(meta.period.to):'—'}</span>`:''}</div><div class="repro-period-bar"><div class="field"><label>Période d’analyse</label><div class="repro-period-inputs"><input id="repro-period-start" type="date" min="${periodMin}" max="${periodMax}" value="${periodStart}"><span>→</span><input id="repro-period-end" type="date" min="${periodMin}" max="${periodMax}" value="${periodEnd}"></div></div><button class="btn secondary btn small" id="repro-period-reset" type="button">Toute la période importée</button></div></div>`:`<div class="notice warning"><strong>CSV source non identifié.</strong> Réimportez le registre une fois pour enregistrer son nom avec cette visite.</div>`;
  app.innerHTML=`<div class="section-title"><div><h2>Reproduction</h2><div class="muted">Tableau de bord filtrable par âge, chaleurs, taureaux et chronologie des performances.</div></div><span class="badge autosave">v14.6.21.68</span></div>${activeVisitBanner(visit)}<section class="card repro-import-card"><div class="row"><div class="field"><label>Exploitation</label><select id="repro-farm" ${visit?'disabled':''}>${db.farms.map(f=>`<option value="${f.id}" ${f.id===selectedFarmId?'selected':''}>${escapeHtml(f.name)}</option>`).join('')}</select></div><div class="field"><label>${meta?'Remplacer le registre bovins CSV':'Importer le registre bovins CSV'}</label><input id="repro-file" type="file" accept=".csv,text/csv"></div></div>${sourceInfo}${registry.length?`<div class="repro-summary-chips"><span>${registry.length} bovin(s) historiques</span><span>${presentFemalesAll.length} femelle(s) présente(s)</span><span>${currentCowsAll.length} vache(s) avec vêlage</span></div>`:'<div class="muted">Aucun registre importé pour cette visite.</div>'}</section>${!registry.length?'<section class="empty" style="margin-top:16px">Importez le fichier CSV Reproduction.</section>':`<section class="card repro-age-filter"><div class="section-title"><div><h3>🎚️ Catégorie d’âge analysée</h3><div class="muted">Tous les indicateurs du tableau de bord ci-dessous se recalculent sur cette tranche d’âge.</div></div><span class="badge" id="repro-age-label">${reproAgeRangeLabel(ageMin,ageMax)}</span></div><div class="repro-age-sliders"><label>Âge minimum <input id="repro-age-min" type="range" min="18" max="180" step="6" value="${ageMin}"></label><label>Âge maximum <input id="repro-age-max" type="range" min="18" max="180" step="6" value="${ageMax}"></label></div><div class="actions"><button class="btn small secondary" data-age-preset="24,36">24–36 mois</button><button class="btn small secondary" data-age-preset="36,180">&gt;36 mois</button><button class="btn small secondary" data-age-preset="36,60">3–5 ans</button><button class="btn small secondary" data-age-preset="60,96">5–8 ans</button><button class="btn small secondary" data-age-preset="96,180">8 ans et +</button><button class="btn small secondary" data-age-preset="24,180">Toutes ≥24 mois</button></div></section>${reproAgeDistributionHtml(presentFemalesAll,analysisDate)}<section class="repro-kpi-grid compact"><article class="card metric"><strong>${females24Count}</strong><span>Femelles &gt;24 mois</span><small>Présentes à la date d’analyse</small></article><article class="card metric"><strong>${females36Count}</strong><span>Femelles &gt;36 mois</span><small>Présentes à la date d’analyse</small></article><article class="card metric"><strong>${males24Count}</strong><span>Mâles &gt;24 mois</span><small>Présents à la date d’analyse</small></article><article class="card metric"><strong>${males36Count}</strong><span>Mâles &gt;36 mois</span><small>Présents à la date d’analyse</small></article><article class="card metric"><strong>${allCalves.length}</strong><span>Naissances</span><small>Période sélectionnée</small></article><article class="card metric"><strong>${stats.calvingRate24??'—'}%</strong><span>Taux de vêlage &gt; 24 mois</span><small>Tranche d’âge sélectionnée</small></article><article class="card metric"><strong>${stats.calvingRate36??'—'}%</strong><span>Taux de vêlage &gt; 36 mois</span><small>Tranche d’âge sélectionnée</small></article><article class="card metric"><strong>${primipares.length}</strong><span>Primipares</span><small>${stats.primipRate??'—'}% des vaches filtrées</small></article><article class="card metric"><strong>${stats.ivvMean??'—'}</strong><span>IVV moyen</span><small>En jours</small></article><article class="card metric"><strong>${stats.ivvMin??'—'}</strong><span>IVV mini</span><small>En jours</small></article><article class="card metric"><strong>${stats.ivvMax??'—'}</strong><span>IVV maxi</span><small>En jours</small></article><article class="card metric"><strong>${stats.ivv12??'—'}</strong><span>IVV1–IVV2 moyen</span><small>En jours</small></article><article class="card metric"><strong>${stats.firstMean??'—'}</strong><span>Âge moyen au 1er vêlage</span><small>En mois</small></article><article class="card metric"><strong>${heifers36.length}</strong><span>Femelles &gt; 36 mois sans vêlage</span><small>Alerte prioritaire</small></article><article class="card metric"><strong>${allCalves.length?Math.round(deadCalves.length/allCalves.length*1000)/10:'—'}%</strong><span>Mortalité veaux &lt; 6 mois</span><small>${deadCalves.length}/${allCalves.length} veaux</small></article><article class="card metric"><strong>${knownFather.length?probableIA.length:'—'}</strong><span>Veaux probablement issus d’IA</span><small>${knownFather.length?`${Math.round(probableIA.length/knownFather.length*1000)/10}% des pères renseignés`:'Colonne père absente ou vide'}</small></article></section>${visit?reproPreparationHtml(visit,farm):''}<section class="card repro-ivv-card"><h3>Répartition des IVV sur la période et l’âge sélectionnés</h3><div class="ivv-band-grid">${ivvBands.map(([l,n])=>`<div><strong>${n}</strong><span>${l}</span></div>`).join('')}</div></section>${visit?reproWeatherCardHtml(inv,farm,periodStart,periodEnd):''}<section class="card"><div class="section-title"><div><h3>🕰️ Chronologie des performances</h3><div class="muted">Les IVV sont replacés sur la période probable de conception (≈ 283 j avant le vêlage) et croisés avec mortalité, introductions, événements saisis et historique Météo-France lorsqu’il est chargé.</div></div><span class="badge">${chrono.problems.length} période(s) à investiguer</span></div>${reproChronologyHtml(chrono)}${visit?`<details class="repro-event-editor"><summary><strong>+ Ajouter un événement historique à croiser</strong></summary><div class="grid cols-3"><div class="field"><label>Date</label><input id="repro-event-date" type="date"></div><div class="field"><label>Type</label><select id="repro-event-type"><option>Alimentation / fourrage</option><option>Maladie / sanitaire</option><option>Avortement / mort-né</option><option>Changement de lot</option><option>Taureau / reproduction</option><option>Météo / sécheresse / pluie</option><option>Bâtiment / abreuvement</option><option>Autre</option></select></div><div class="field"><label>Événement</label><input id="repro-event-label" placeholder="Ex. changement d’ensilage, épisode diarrhées…"></div></div><button class="btn primary small" id="add-repro-event">Ajouter</button>${inv.events.length?`<div class="table-wrap"><table class="compact-table"><tbody>${inv.events.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map(e=>`<tr><td>${formatDate(e.date)}</td><td>${escapeHtml(e.type||'')}</td><td>${escapeHtml(e.label||'')}</td><td><button class="btn danger small" data-delete-repro-event="${escapeHtml(e.id)}">×</button></td></tr>`).join('')}</tbody></table></div>`:''}</details>`:''}</section>${visit?reproInvestigationHtml(visit,inv,stats):'<section class="notice warning">Ouvrez une visite pour enregistrer l’enquête chaleurs / taureaux.</section>'}<details class="card repro-score-help"><summary><strong>ℹ️ Comment est calculé le score reproduction ?</strong></summary>${reproductionScoreLegendHtml()}</details><section class="card"><div class="row"><div class="field"><label>Filtre <span class="badge">${rows.length}</span></label><select id="repro-filter"><option value="all">Toutes les vaches présentes</option><option value="400">Sans vêlage depuis plus de 400 j</option><option value="ivvLe400">IVV moyen ≤ 400 j</option><option value="ivv401to450">IVV moyen 401–450 j</option><option value="ivv451to500">IVV moyen 451–500 j</option><option value="ivvOver500">IVV moyen &gt; 500 j</option><option value="dead">Au moins 2 veaux morts avant 6 mois</option><option value="under28">1er vêlage avant 28 mois</option><option value="28to36">1er vêlage 28–36 mois</option><option value="over36">1er vêlage après 36 mois</option></select></div><div class="field"><label>Classement</label><select id="repro-sort"><option value="lastCalvingOld">Dernier vêlage le plus ancien</option><option value="ivvHigh">IVV moyen le plus élevé</option><option value="firstAgeHigh">1er vêlage le plus tardif</option><option value="deadHigh">Mortalité veaux la plus élevée</option><option value="scoreLow">Score le plus faible</option></select></div></div><div class="muted repro-filter-count"><strong>${rows.length}</strong> vache(s) correspondent au filtre sur ${currentCows.length} dans la tranche d’âge.</div><div class="table-wrap"><table><thead><tr><th>Vache</th><th>Âge / race</th><th>1er vêlage</th><th>Dernier vêlage</th><th>IVV complet</th><th>Veaux</th><th>Score</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${escapeHtml(r.cow.workNumber||r.cow.id)}</strong>${r.cow.name?`<br><span class="repro-cow-name">${escapeHtml(r.cow.name)}</span>`:''}<br><small>${escapeHtml(r.cow.id)}</small></td><td>${ageLabelAt(r.cow.birthDate,analysisDate)||'—'}<br><small>Race ${escapeHtml(r.cow.breed||'—')}</small></td><td>${r.firstCalvingDate?formatDate(r.firstCalvingDate):'—'}<br><small>${r.firstCalvingAgeMonths!=null?`${r.firstCalvingAgeMonths} mois`:'—'}</small></td><td>${r.lastCalvingDate?formatDate(r.lastCalvingDate):'—'}<br><small>${r.daysSinceLast??'—'} j</small></td><td>Moy. ${r.meanIVV??'—'} · mini ${r.minIVV??'—'} · maxi ${r.maxIVV??'—'}<br><small>${r.intervals.length?r.intervals.join(' / ')+' j':'Un seul vêlage'}</small></td><td>${r.calves.length}<br><small>${r.deadBefore6.length} mort(s) &lt;6 mois</small></td><td><button class="badge ${reproductionScore(r)>=75?'complete':reproductionScore(r)>=60?'in-progress':'danger'}" data-repro-score="${escapeHtml(r.cow.id)}">${reproductionScore(r)}/100</button></td><td><button class="btn small" data-repro-detail="${escapeHtml(r.cow.id)}">Voir</button></td></tr>`).join('')||'<tr><td colspan="8">Aucun animal correspondant.</td></tr>'}</tbody></table></div></section><section class="card"><div class="section-title"><div><h3>Femelles présentes sans vêlage</h3><div class="muted">Les &gt;36 mois sont affichées en alerte prioritaire. Le tableau respecte le filtre d’âge.</div></div><span class="badge danger">${heifers36.length} &gt;36 mois</span></div>${presentHeifers.length?`<div class="table-wrap"><table><thead><tr><th>Femelle</th><th>Date de naissance</th><th>Âge</th><th>Race</th><th>Alerte</th></tr></thead><tbody>${presentHeifers.sort(sortByWorkNumber).map(g=>{const age=monthsBetweenDates(g.birthDate,analysisDate);return `<tr><td><strong>${escapeHtml(g.workNumber||g.id)}</strong>${g.name?`<br><span class="repro-cow-name">${escapeHtml(g.name)}</span>`:''}<br><small>${escapeHtml(g.id)}</small></td><td>${g.birthDate?formatDate(g.birthDate):'—'}</td><td>${ageLabelAt(g.birthDate,analysisDate)||'—'}</td><td>${escapeHtml(g.breed||'—')}</td><td>${age!=null&&age>36?'<span class="badge danger">Plus de 36 mois sans vêlage</span>':age!=null&&age>28?'<span class="badge in-progress">À surveiller</span>':'<span class="badge">24–28 mois</span>'}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="empty">Aucune femelle sans vêlage dans cette tranche d’âge.</div>'}</section><section id="repro-detail"></section>`}`;
  const fs=document.getElementById('repro-farm');if(fs&&!visit)fs.onchange=()=>{localStorage.setItem('audit-bovin-repro-farm',fs.value);renderReproduction()};
  const fi=document.getElementById('repro-file');if(fi)fi.onchange=async()=>{const file=fi.files?.[0];if(!file)return;try{const animals=await importBovineRegistryCsvForVisit(file,visit,farm);localStorage.removeItem(periodKey);showToast(`${animals.length} bovin(s) importé(s). Le même registre est visible dans Préparation / Imports.`);renderReproduction()}catch(e){showToast(`Import impossible : ${e.message}`)}};
  const ps=document.getElementById('repro-period-start'),pe=document.getElementById('repro-period-end'),pr=document.getElementById('repro-period-reset');const updatePeriod=()=>{const start=ps?.value||periodMin,end=pe?.value||periodMax;if(start&&end&&start>end){showToast('La date de début doit être antérieure à la date de fin.');return;}localStorage.setItem(periodKey,JSON.stringify({start,end}));renderReproduction();};if(ps)ps.onchange=updatePeriod;if(pe)pe.onchange=updatePeriod;if(pr)pr.onclick=()=>{localStorage.setItem(periodKey,JSON.stringify({start:periodMin,end:periodMax}));renderReproduction();};
  const saveAge=(min,max)=>{min=Math.max(18,Number(min));max=Math.min(180,Number(max));if(min>max){if(document.activeElement?.id==='repro-age-min')min=max;else max=min;}localStorage.setItem(ageKey,JSON.stringify({min,max}));renderReproduction();};const amin=document.getElementById('repro-age-min'),amax=document.getElementById('repro-age-max');if(amin)amin.onchange=()=>saveAge(amin.value,amax?.value||180);if(amax)amax.onchange=()=>saveAge(amin?.value||18,amax.value);app.querySelectorAll('[data-age-preset]').forEach(b=>b.onclick=()=>{const [mn,mx]=b.dataset.agePreset.split(',').map(Number);saveAge(mn,mx)});app.querySelectorAll('[data-age-year]').forEach(b=>b.onclick=()=>{const y=Number(b.dataset.ageYear),list=presentFemalesAll.filter(a=>{const m=monthsBetweenDates(a.birthDate,analysisDate);return m!=null&&Math.floor(m/12)===y;}).sort(sortByWorkNumber),target=document.getElementById('repro-age-year-detail');if(target)target.innerHTML=`<div class="notice" style="margin-top:12px"><strong>${y} an${y>1?'s':''} — ${list.length} femelle(s)</strong><div class="table-wrap"><table class="compact-table"><thead><tr><th>Animal</th><th>Nom</th><th>Date naissance</th><th>Âge</th></tr></thead><tbody>${list.map(a=>`<tr><td>${escapeHtml(a.workNumber||a.id)}</td><td>${escapeHtml(a.name||'—')}</td><td>${a.birthDate?formatDate(a.birthDate):'—'}</td><td>${escapeHtml(ageLabelAt(a.birthDate,analysisDate)||'—')}</td></tr>`).join('')}</tbody></table></div></div>`;});
  const filter=document.getElementById('repro-filter');if(filter){filter.value=reproductionFilter;filter.onchange=()=>{reproductionFilter=filter.value;localStorage.setItem('audit-bovin-repro-filter',reproductionFilter);renderReproduction()}};const sort=document.getElementById('repro-sort');if(sort){sort.value=reproductionSort;sort.onchange=()=>{reproductionSort=sort.value;localStorage.setItem('audit-bovin-repro-sort',reproductionSort);renderReproduction()}};
  if(visit){const saveInv=()=>{visit.updatedAt=new Date().toISOString();saveDatabase(db)};app.querySelectorAll('[data-repro-heat]').forEach(el=>{const f=el.dataset.reproHeat;const fn=()=>{inv.heat[f]=el.value;saveInv()};el.onchange=()=>{fn();renderReproduction()};el.oninput=fn});app.querySelectorAll('[data-repro-setting]').forEach(el=>{const f=el.dataset.reproSetting;const fn=()=>{inv.settings[f]=el.type==='number'?Number(el.value||0):el.value;saveInv()};el.onchange=()=>{fn();renderReproduction()};el.oninput=fn});app.querySelectorAll('[data-bull-field]').forEach(el=>{const row=el.closest('[data-repro-bull-row]'),i=Number(row?.dataset.reproBullRow),f=el.dataset.bullField;const fn=()=>{if(!inv.bulls[i])return;inv.bulls[i][f]=el.type==='number'?Number(el.value||0):el.value;saveInv()};el.oninput=fn;el.onchange=()=>{fn();renderReproduction()}});document.getElementById('add-repro-bull')?.addEventListener('click',()=>{inv.bulls.push({id:uid('bull'),name:'',ageClass:'adult',females:'',contactDays:'',fertility:''});saveInv();renderReproduction()});app.querySelectorAll('[data-delete-bull]').forEach(b=>b.onclick=()=>{inv.bulls.splice(Number(b.dataset.deleteBull),1);saveInv();renderReproduction()});document.getElementById('add-repro-event')?.addEventListener('click',()=>{const date=document.getElementById('repro-event-date')?.value,label=document.getElementById('repro-event-label')?.value.trim(),type=document.getElementById('repro-event-type')?.value;if(!date||!label){showToast('Renseignez la date et l’événement.');return;}inv.events.push({id:uid('reproevt'),date,type,label});saveInv();renderReproduction()});app.querySelectorAll('[data-delete-repro-event]').forEach(b=>b.onclick=()=>{inv.events=inv.events.filter(e=>e.id!==b.dataset.deleteReproEvent);saveInv();renderReproduction()});
    const weatherStatus=t=>{const el=document.getElementById('repro-weather-status');if(el)el.textContent=t};
    let weatherDeptRows=[];
    const weatherFrom=periodStart||periodMin||fullPeriod.from,weatherTo=periodEnd||periodMax||fullPeriod.to;
    const populateWeatherStations=(rows,label='données météo')=>{weatherDeptRows=rows;const stations=reproWeatherStationsFromRows(rows),sel=document.getElementById('repro-weather-station');if(!stations.length)throw new Error('Aucune station identifiable.');sel.innerHTML=stations.map(x=>`<option value="${escapeHtml(String(x.id))}" data-name="${escapeHtml(x.name||'')}">${escapeHtml(x.name||String(x.id))} — ${x.count} j (${formatDate(x.from)} → ${formatDate(x.to)})</option>`).join('');if(inv.weather.stationId&&[...sel.options].some(o=>o.value===String(inv.weather.stationId)))sel.value=String(inv.weather.stationId);weatherStatus(`${stations.length} station(s) trouvée(s) dans ${label}. Choisis la station la plus représentative de l’exploitation.`);};
    document.getElementById('repro-weather-bundled')?.addEventListener('click',async()=>{const dept=document.getElementById('repro-weather-dept')?.value.trim();try{weatherStatus('Lecture des fichiers météo inclus dans l’application…');const got=await reproWeatherLoadBundled(dept,weatherFrom,weatherTo,weatherStatus);populateWeatherStations(got.rows,`${got.resourcesUsed} fichier(s) inclus`);}catch(e){weatherStatus(`Météo incluse non chargée : ${e.message}`)}});
    document.getElementById('repro-weather-import')?.addEventListener('click',()=>{const sel=document.getElementById('repro-weather-station'),stationId=sel?.value,stationName=sel?.selectedOptions?.[0]?.dataset?.name||sel?.selectedOptions?.[0]?.textContent||stationId,dept=document.getElementById('repro-weather-dept')?.value.trim();if(!stationId||!weatherDeptRows.length){weatherStatus('Charge d’abord les fichiers inclus ou sélectionne des fichiers Météo-France, puis choisis une station.');return;}const selected=weatherDeptRows.filter(r=>String(r.stationId||r.stationName)===String(stationId)).map(({date,rr,tn,tx,tm})=>({date,rr,tn,tx,tm})).sort((a,b)=>a.date.localeCompare(b.date));if(!selected.length){weatherStatus('Aucune donnée trouvée pour cette station.');return;}inv.weather={...inv.weather,department:dept,stationId:String(stationId),stationName:String(stationName).replace(/\s+—.*$/,''),records:selected,source:'Météo-France — RR-T-Vent',importedAt:new Date().toISOString(),from:selected[0].date,to:selected.at(-1).date};saveInv();showToast(`${selected.length} jour(s) Météo-France enregistrés.`);renderReproduction();});
    document.getElementById('repro-weather-file')?.addEventListener('change',async e=>{const files=[...(e.target.files||[])];if(!files.length)return;try{const merged=[];for(let i=0;i<files.length;i++){weatherStatus(`Lecture fichier météo ${i+1}/${files.length} : ${files[i].name}`);merged.push(...reproWeatherParseDetailedCsv(await reproWeatherReadFile(files[i])));}const uniq=new Map();for(const r of merged){const k=`${r.stationId||r.stationName}|${r.date}`;uniq.set(k,r);}const detailed=[...uniq.values()].filter(r=>(!weatherFrom||r.date>=weatherFrom)&&(!weatherTo||r.date<=weatherTo));if(!detailed.length)throw new Error('Aucune donnée pluie/température reconnue pour la période du registre.');populateWeatherStations(detailed,`${files.length} fichier(s) importé(s)`);weatherStatus(`${files.length} fichier(s) fusionné(s). Choisis maintenant la station puis clique sur « Intégrer la station choisie ».`);}catch(err){weatherStatus(`Fichier météo non importé : ${err.message}`)}});
    document.getElementById('repro-weather-export')?.addEventListener('click',()=>reproWeatherExportCsv(inv));
    document.getElementById('repro-weather-clear')?.addEventListener('click',()=>{if(confirm('Effacer les données météo enregistrées pour cette visite ?')){inv.weather={records:[]};saveInv();renderReproduction();}});
  }
  app.querySelectorAll('[data-repro-score]').forEach(b=>b.onclick=()=>showReproScoreModal(reproFarm,b.dataset.reproScore,'score'));app.querySelectorAll('[data-repro-detail]').forEach(b=>b.onclick=()=>showReproScoreModal(reproFarm,b.dataset.reproDetail,'history'));
}
window.addEventListener('pagehide',()=>{const v=activeVisit();if(v?.id){try{syncVisibleAnalysisInputs(v.id);flushAnalysisSave(v.id);}catch(_){}}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){const v=activeVisit();if(v?.id){try{syncVisibleAnalysisInputs(v.id);flushAnalysisSave(v.id);}catch(_){}}}});

function applyWorkMode(mode){
  const normalized=mode==='terrain'?'terrain':'bureau';
  document.body.classList.toggle('terrain-mode',normalized==='terrain');
  localStorage.setItem('audit-bovin-work-mode',normalized);
  const b=document.getElementById('work-mode-toggle');
  if(b){
    b.textContent=normalized==='terrain'?'🖥️ Passer en mode Bureau':'📱 Passer en mode Terrain';
    b.setAttribute('aria-pressed',normalized==='terrain'?'true':'false');
    b.title=normalized==='terrain'?'Afficher tous les modules et bilans':'Simplifier l’interface pour la saisie sur le terrain';
  }
}
function initWorkMode(){
  const header=document.querySelector('.app-header');
  if(!header)return;
  let tools=header.querySelector('.header-tools');
  if(!tools){
    tools=document.createElement('div');
    tools.className='header-tools';
    const version=header.querySelector('.version');
    if(version)header.insertBefore(tools,version);else header.appendChild(tools);
  }
  let button=document.getElementById('work-mode-toggle');
  if(!button){
    button=document.createElement('button');
    button.id='work-mode-toggle';
    button.className='work-mode-toggle';
    button.type='button';
    tools.appendChild(button);
  }
  button.onclick=()=>applyWorkMode(document.body.classList.contains('terrain-mode')?'bureau':'terrain');
  applyWorkMode(localStorage.getItem('audit-bovin-work-mode')||'bureau');
}
window.addEventListener('pagehide',()=>{if(analysisSaveTimer){try{flushAnalysisSave(activeVisit()?.id);}catch(_){}}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&analysisSaveTimer){try{flushAnalysisSave(activeVisit()?.id);}catch(_){}}});
function initKeyboardDismissButton(){
  let button=document.getElementById('keyboard-dismiss');
  if(!button){
    button=document.createElement('button');
    button.id='keyboard-dismiss';
    button.type='button';
    button.className='keyboard-dismiss';
    button.innerHTML='⌄ <span>Clavier</span>';
    button.setAttribute('aria-label','Fermer le clavier');
    document.body.appendChild(button);
  }
  const editable=el=>el && (el.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]), textarea'));
  const update=()=>button.classList.toggle('visible',editable(document.activeElement));
  document.addEventListener('focusin',()=>setTimeout(update,0));
  document.addEventListener('focusout',()=>setTimeout(update,120));
  button.addEventListener('pointerdown',e=>e.preventDefault());
  button.addEventListener('click',()=>{const el=document.activeElement;if(editable(el)){el.dispatchEvent(new Event('change',{bubbles:true}));el.blur();}button.classList.remove('visible');});
  if(window.visualViewport)window.visualViewport.addEventListener('resize',update);
}

let deferredInstallPrompt=null;
function initInstallButton(){
  const header=document.querySelector('.app-header');if(!header)return;
  let tools=header.querySelector('.header-tools');if(!tools){tools=document.createElement('div');tools.className='header-tools';header.appendChild(tools);}
  let btn=document.getElementById('install-app-button');
  if(!btn){btn=document.createElement('button');btn.id='install-app-button';btn.type='button';btn.className='install-app-button';btn.textContent='⬇ Installer';tools.appendChild(btn);}
  const standalone=window.matchMedia?.('(display-mode: standalone)').matches||window.navigator.standalone===true;
  if(standalone){btn.hidden=true;return;}
  btn.hidden=false;
  btn.onclick=async()=>{
    if(deferredInstallPrompt){
      deferredInstallPrompt.prompt();
      try{await deferredInstallPrompt.userChoice;}catch(_){}
      deferredInstallPrompt=null;
      return;
    }
    showToast('Chrome ne propose pas encore l’installation. Fermer toute fenêtre DNC, actualiser Audit Bovin avec Ctrl+F5, puis rouvrir le menu ⋮. Si DNC capte encore Audit Bovin, désinstaller temporairement DNC puis réessayer.');
  };
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;btn.hidden=false;});
  window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;btn.hidden=true;showToast('Audit Bovin est installé.');});
}
setInterval(()=>{if(document.visibilityState==='visible'&&activeVisitId)refreshVisitPresence(true)},45000);
window.addEventListener('pagehide',()=>{try{refreshVisitPresence(false);}catch(_){}});

initWorkMode();
initGlobalSearch();
initInstallButton();
initKeyboardDismissButton();
applyPeerReviewDeepLink();
if ('serviceWorker' in navigator){
  const AUDIT_PATH='/audit-bovin-gds-32-65-v2/';
  const AUDIT_SW=location.origin+AUDIT_PATH+'sw.js?v=14.6.21.46';
  const AUDIT_SCOPE=location.origin+AUDIT_PATH;
  (async()=>{
    try{
      // Nettoyage d'anciens service workers d'une autre appli qui couvriraient par erreur Audit Bovin.
      const regs=await navigator.serviceWorker.getRegistrations();
      for(const reg of regs){
        const scope=String(reg.scope||'');
        const script=String((reg.active||reg.waiting||reg.installing)?.scriptURL||'');
        const coversAudit=location.href.startsWith(scope);
        const isAudit=scope.includes(AUDIT_PATH) || script.includes(AUDIT_PATH+'sw.js');
        if(coversAudit && !isAudit){
          try{await reg.unregister();}catch(_){}
        }
      }
      const reg=await navigator.serviceWorker.register(AUDIT_SW,{scope:AUDIT_SCOPE,updateViaCache:'none'});
      console.info('Audit Bovin PWA scope actif :',reg.scope);
      try{await reg.update();}catch(_){}
      if(!navigator.serviceWorker.controller){
        await navigator.serviceWorker.ready;
        if(!sessionStorage.getItem('audit-sw-first-reload')){
          sessionStorage.setItem('audit-sw-first-reload','1');
          location.reload();
          return;
        }
      }else{
        const script=String(navigator.serviceWorker.controller.scriptURL||'');
        if(!script.includes(AUDIT_PATH+'sw.js') && !sessionStorage.getItem('audit-sw-takeover-reload')){
          sessionStorage.setItem('audit-sw-takeover-reload','1');
          navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});
          setTimeout(()=>location.reload(),1500);
          return;
        }
      }
      sessionStorage.removeItem('audit-sw-first-reload');
      sessionStorage.removeItem('audit-sw-takeover-reload');
    }catch(err){console.error('Audit Bovin service worker',err);}
  })();
}
function detectLabNameFromText(text=''){const n=normalizeSearchText(text);for(const name of ['Iodolab','LEAV','Labocéa','Labocea','LPL','Public Labos'])if(n.includes(normalizeSearchText(name)))return name;return ''}
function smartTextLines(text=''){return String(text||'').split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean)}
function smartNumericTokens(text=''){return [...String(text||'').matchAll(/(?:<|>|≤|≥)?\s*-?\d+(?:[.,]\d+)?/g)].map(m=>({raw:m[0].replace(/\s+/g,'').replace(',','.'),index:m.index||0,end:(m.index||0)+m[0].length}))}
function smartUnitFromLine(line=''){const m=String(line).match(/(?:µg\/L|ug\/L|mg\/L|mg\/dL|µmol\/L|umol\/L|ng\/mL|µg\/dL|ug\/dL|µg\/mL|ug\/mL|mUT|OPG|oeufs?\/g|oocystes?\/g|UFC\/mL|UFC\/100\s*mL|NPP\/100\s*mL|NFU|µS\/cm|uS\/cm|°f|ppm|mV)/i);return m?m[0]:''}
function smartFoldKeepLength(text=''){return String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()}
function smartAliasMatch(line,aliases=[]){const folded=smartFoldKeepLength(line);let best=null;for(const a of aliases){const aa=smartFoldKeepLength(a).trim();if(!aa)continue;const escaped=aa.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');let m=null;if(aa.length<=2){const re=new RegExp(`(^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`,'i');m=folded.match(re);if(m){const idx=(m.index||0)+(m[1]?.length||0);/* Les symboles courts (Mg, Ca, I...) sont acceptés surtout en début de ligne : sinon ils correspondent souvent à une unité. */if(idx>24)continue;m={index:idx,0:m[2]};}}else{const idx=folded.indexOf(aa);if(idx>=0)m={index:idx,0:aa};}if(m){const cand={alias:aa,idx:m.index,end:m.index+String(m[0]).length};if(!best||cand.idx<best.idx||(cand.idx===best.idx&&cand.alias.length>best.alias.length))best=cand;}}return best}
function smartTokenContext(line,tok){const before=smartFoldKeepLength(line.slice(Math.max(0,tok.index-24),tok.index));const after=smartFoldKeepLength(line.slice(tok.end,Math.min(line.length,tok.end+24)));return {before,after,near:`${before} ${after}`}}
function smartLikelyResultToken(line,aliases=[]){const match=smartAliasMatch(line,aliases);if(!match)return null;const tokens=smartNumericTokens(line).filter(t=>!(t.index<match.end&&t.end>match.idx));if(!tokens.length)return null;let best=null;for(const t of tokens){const num=parseFloat(t.raw.replace(/[<>≤≥]/g,''));if(!Number.isFinite(num)|| (num>=1900&&num<=2100))continue;const ctx=smartTokenContext(line,t);if(/(?:^|[\/.-])\d{1,2}[\/.-]?$/.test(ctx.before.slice(-4))||/^\s*[\/.-]\d{1,2}(?:[\/.-]\d{2,4})/.test(ctx.after))continue;let score=0;const d=t.index-match.end;if(d>=0&&d<=8)score+=14;else if(d>8&&d<=28)score+=9;else if(d>28&&d<=60)score+=4;else if(d<0&&Math.abs(d)<=16)score+=2;else score-=3;
    // Écarter les nombres qui font partie du nom du paramètre (ex. flore 22 °C / 37 °C).
    if(/°\s*c/i.test(line.slice(t.end,t.end+5))&&t.index<=match.end+8)score-=20;
    // Les colonnes de référence/min/max sont moins probables que le résultat.
    if(/\b(ref|reference|norme|normes|seuil|limite|min|max|mini|maxi|intervalle)\b/.test(ctx.before))score-=10;
    if(/\b(ref|reference|norme|normes|seuil|limite|min|max|mini|maxi|intervalle)\b/.test(ctx.after)&&d>20)score-=5;
    // Un nombre immédiatement voisin d'une unité analytique est au contraire plausible.
    if(/(?:µg\/l|ug\/l|mg\/l|mg\/dl|µmol\/l|umol\/l|ng\/ml|mut|opg|ufc|npp|nfu|µs\/cm|us\/cm|°f|ppm|mv)/.test(ctx.near))score+=3;
    if(!best||score>best.score||(score===best.score&&Math.abs(d)<Math.abs(best.distance)))best={...t,score,distance:d};
  }
  return best&&best.score>=1?best:null;
}
function smartResultFromCandidate(line,aliases=[]){const tok=smartLikelyResultToken(line,aliases);return tok?tok.raw:null}
function smartQualitativeResult(line=''){const n=smartFoldKeepLength(line);if(/\b(absence|absent|negatif|negative|non detecte|non detectee|nd)\b/.test(n))return 'Négatif';if(/\b(positif|positive|presence|present)\b/.test(n))return 'Positif';if(/\b(douteux|douteuse|equivoque|ininterpretable)\b/.test(n))return 'Douteux';return ''}
function smartFindProposals(text,defs){const lines=smartTextLines(text),out=[];for(const d of defs){for(let i=0;i<lines.length;i++){const here=lines[i],m=smartAliasMatch(here,d.aliases||[d.label]);if(!m)continue;let source=here,value=smartResultFromCandidate(here,d.aliases||[d.label]);if(value===null&&d.qualitative)value=smartQualitativeResult(here)||null;
      if(value===null&&i+1<lines.length){const next=lines[i+1];const nextFold=smartFoldKeepLength(next);/* Une ligne suivante n'est utilisée que si elle ressemble réellement à une cellule résultat isolée. */if(/^\s*(?:<|>|≤|≥)?\s*-?\d+(?:[.,]\d+)?(?:\s*(?:µg\/L|ug\/L|mg\/L|mg\/dL|µmol\/L|umol\/L|ng\/mL|mUT|OPG|UFC|NPP|NFU|µS\/cm|uS\/cm|°f|ppm|mV))?\s*$/i.test(next)){source=`${here} ⟶ ${next}`;value=smartNumericTokens(next)[0]?.raw||null}else if(d.qualitative){const q=smartQualitativeResult(next);if(q&&nextFold.length<60){source=`${here} ⟶ ${next}`;value=q}}}
      if(value!==null){out.push({key:d.key||d.label,label:d.label,value,unit:smartUnitFromLine(source)||d.unit||'',sourceLine:source,confidence:'à vérifier'});break}}
  }return out}
function smartLabDefinitions(view){
  if(view==='metabolic')return Object.entries(METABOLIC_KNOWLEDGE).map(([key,x])=>({key,label:x.label,aliases:[x.label,...(x.aliases||[])].filter(a=>{const z=smartFoldKeepLength(a).trim();return z.length>1 || !['i','p'].includes(z)})}));
  if(view==='parasitism')return [
    {key:'strongles_digestifs',label:'Strongles digestifs',aliases:['strongles digestifs','strongles gastro intestinaux','strongles gastro-intestinaux','strongyles digestifs','strongyles gastro','trichostrongles'],qualitative:true,unit:'OPG'},
    {key:'nematodirus',label:'Nematodirus',aliases:['nematodirus'],qualitative:true,unit:'OPG'},
    {key:'coccidies',label:'Coccidies',aliases:['coccidies','coccidia','oocystes'],qualitative:true,unit:'OPG'},
    {key:'paramphistomes',label:'Paramphistomes',aliases:['paramphistome','paramphistomum'],qualitative:true,unit:'OPG'},
    {key:'grande_douve',label:'Grande douve',aliases:['fasciola','fasciola hepatica','grande douve'],qualitative:true},
    {key:'strongles_respiratoires',label:'Strongles respiratoires',aliases:['strongles respiratoires','dictyocaulus','strongyles respiratoires'],qualitative:true},
    {key:'pepsinogene',label:'Pepsinogène',aliases:['pepsinogene','pepsinogène'],unit:'mUT'}
  ];
  return [
    {key:'turbidite',label:'Turbidité',aliases:['turbidite','turbidité'],unit:'NFU'},
    {key:'ph',label:'pH',aliases:['ph']},
    {key:'conductivite',label:'Conductivité',aliases:['conductivite','conductivité'],unit:'µS/cm'},
    {key:'durete',label:'Dureté',aliases:['durete','dureté','titre hydrotimetrique','titre hydrotimétrique','th'],unit:'°f'},
    {key:'redox',label:'Potentiel redox',aliases:['potentiel redox','redox','oxydo reduction','oxydo-réduction'],unit:'mV'},
    {key:'cot',label:'Carbone organique total (COT)',aliases:['carbone organique total','cot'],unit:'mg/L'},
    {key:'ammonium',label:'Ammonium',aliases:['ammonium','nh4'],unit:'mg/L'},
    {key:'nitrites',label:'Nitrites',aliases:['nitrites','no2'],unit:'mg/L'},
    {key:'nitrates',label:'Nitrates',aliases:['nitrates','no3'],unit:'mg/L'},
    {key:'fer',label:'Fer',aliases:['fer total','fer','fe'],unit:'µg/L'},
    {key:'manganese',label:'Manganèse',aliases:['manganese','manganèse','mn'],unit:'µg/L'},
    {key:'chlore',label:'Chlore libre',aliases:['chlore libre','chlore residuel','chlore résiduel'],unit:'ppm'},
    {key:'coliformes',label:'Coliformes totaux',aliases:['coliformes totaux','bacteries coliformes','bactéries coliformes'],unit:'/100 mL'},
    {key:'ecoli',label:'Escherichia coli',aliases:['escherichia coli','e. coli','e coli'],unit:'/100 mL'},
    {key:'enterocoques',label:'Entérocoques intestinaux',aliases:['enterocoques intestinaux','entérocoques intestinaux','enterocoques','entérocoques'],unit:'/100 mL'},
    {key:'asr',label:'Spores ASR',aliases:['asr','anaerobies sulfito reducteurs','anaérobies sulfito-réducteurs'],unit:'/100 mL'},
    {key:'flore22',label:'Flore totale 22°C',aliases:['flore totale 22','flore 22','germes a 22','germes à 22'],unit:'UFC/mL'},
    {key:'flore37',label:'Flore totale 37°C',aliases:['flore totale 37','flore 37','germes a 37','germes à 37'],unit:'UFC/mL'}
  ]
}
function extractSmartLabProposals(view,text=''){return smartFindProposals(text,smartLabDefinitions(view)).map((x,i)=>({...x,id:`p${i}_${Date.now()}`,selected:true}))}
function integrateSmartLabProposals(view,visit,proposals,fileName=''){let count=0;const selected=(proposals||[]).filter(x=>x.selected!==false);const lab=detectLabNameFromText((visit.labImports||[]).find(x=>x.name===fileName)?.ocrText||'');if(view==='metabolic'){const m=ensureMetabolic(visit);if(lab){const lp=metabolicLabProfiles().find(x=>normalizeSearchText(x.name).includes(normalizeSearchText(lab)));if(lp){m.labId=lp.id;m.lab=lp.name}else m.lab=lab;}selected.forEach(v=>{if((m.rows||[]).some(r=>metabolicKey(r.analyte)===v.key&&String(r.value)===String(v.value)))return;const row={id:uid('met'),animal:m.paperSubject||m.category||'',analyte:v.label,value:v.value,unit:v.unit||'',refMin:'',refMax:'',labStatus:'auto',importSource:fileName};applyMetabolicLabReference(row,metabolicLabById(m.labId),m.sampleType);m.rows.push(row);count++});if(count){m.sourceFile=fileName;m.importedAt=new Date().toISOString();}}
else if(view==='parasitism'){const p=ensureParasitism(visit);if(lab)p.lab=lab;selected.forEach(v=>{if(v.key==='pepsinogene'){if(!(p.pepsinogen||[]).some(r=>String(r.value)===String(v.value))){p.pepsinogen.push({id:uid('pep'),animal:p.paperSubject||p.category||'',value:v.value,importSource:fileName});count++}return}if((p.rows||[]).some(r=>normalizeSearchText(r.parasite)===normalizeSearchText(v.label)&&String(r.value)===String(v.value)))return;p.rows.push({id:uid('par'),animal:p.paperSubject||p.category||'',parasite:v.label,value:v.value,unit:v.unit||'OPG',labStatus:'auto',importSource:fileName});count++})}
else if(view==='waterlab'){const w=ensureWaterLab(visit);if(lab)w.lab=lab;if(selected.length){let pt=w.points.find(x=>x.importSource===fileName);if(!pt){pt={id:uid('wpt'),name:`Import ${fileName}`.slice(0,80),location:'',linkedDrinkerId:'',importSource:fileName,rows:[]};w.points.unshift(pt)}selected.forEach(v=>{if(pt.rows.some(r=>normalizeSearchText(r.parameter)===normalizeSearchText(v.label)&&String(r.value)===String(v.value)))return;pt.rows.push({id:uid('wrow'),parameter:v.label,value:v.value,unit:v.unit||'',importSource:fileName});count++})}}return count}
function loadExternalScript(src,testFn){return new Promise((resolve,reject)=>{try{if(testFn?.())return resolve();const existing=[...document.scripts].find(s=>s.src===src);if(existing){if(testFn?.())return resolve();existing.addEventListener('load',()=>resolve(),{once:true});existing.addEventListener('error',()=>reject(new Error('Chargement impossible')),{once:true});return}const sc=document.createElement('script');sc.src=src;sc.async=true;sc.crossOrigin='anonymous';sc.onload=()=>resolve();sc.onerror=()=>reject(new Error('Chargement impossible'));document.head.appendChild(sc)}catch(e){reject(e)}})}
async function ensurePdfJs(){if(globalThis.pdfjsLib)return globalThis.pdfjsLib;await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',()=>!!globalThis.pdfjsLib);if(!globalThis.pdfjsLib)throw new Error('Moteur PDF indisponible');globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';return globalThis.pdfjsLib}
let smartTesseractWorker=null;
async function ensureTesseract(progress){if(smartTesseractWorker)return smartTesseractWorker;if(!globalThis.Tesseract)await loadExternalScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',()=>!!globalThis.Tesseract);if(!globalThis.Tesseract)throw new Error('Moteur OCR indisponible');progress?.('Chargement du moteur OCR…');smartTesseractWorker=await globalThis.Tesseract.createWorker('fra+eng',1,{logger:m=>{if(m?.status)progress?.(`${m.status}${m.progress!=null?` · ${Math.round(m.progress*100)} %`:''}`)}});return smartTesseractWorker}
async function ocrImageSource(source,progress){const worker=await ensureTesseract(progress);const r=await worker.recognize(source);return String(r?.data?.text||'')}
async function canvasForOcr(source,maxW=2200,maxH=3000){const bmp=source instanceof ImageBitmap?source:await createImageBitmap(source);const ratio=Math.min(1,maxW/bmp.width,maxH/bmp.height),c=document.createElement('canvas');c.width=Math.max(1,Math.round(bmp.width*ratio));c.height=Math.max(1,Math.round(bmp.height*ratio));const ctx=c.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(bmp,0,0,c.width,c.height);try{if(!(source instanceof ImageBitmap))bmp.close?.()}catch(_){}return c}
function pdfItemsToLines(items=[]){const rows=[];for(const it of items){const str=String(it.str||'').trim();if(!str)continue;const y=Math.round(Number(it.transform?.[5]||0)*2)/2,x=Number(it.transform?.[4]||0);let row=rows.find(r=>Math.abs(r.y-y)<=2);if(!row){row={y,parts:[]};rows.push(row)}row.parts.push({x,str})}rows.sort((a,b)=>b.y-a.y);return rows.map(r=>r.parts.sort((a,b)=>a.x-b.x).map(p=>p.str).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean).join('\n')}
async function readPdfTextAndOcr(file,progress){const pdfjs=await ensurePdfJs(),buf=await file.arrayBuffer(),pdf=await pdfjs.getDocument({data:new Uint8Array(buf)}).promise;let text='',mode='pdf-text';const pages=Math.min(pdf.numPages,8);for(let i=1;i<=pages;i++){progress?.(`Lecture PDF page ${i}/${pages}…`);const page=await pdf.getPage(i),tc=await page.getTextContent();text+=pdfItemsToLines(tc.items)+'\n'}if(text.replace(/\s/g,'').length>=40)return{text,mode};mode='ocr-pdf';text='';for(let i=1;i<=Math.min(pdf.numPages,4);i++){progress?.(`OCR du PDF page ${i}/${Math.min(pdf.numPages,4)}…`);const page=await pdf.getPage(i),vp0=page.getViewport({scale:1}),scale=Math.min(2.2,2200/Math.max(1,vp0.width)),vp=page.getViewport({scale});const c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);await page.render({canvasContext:c.getContext('2d',{alpha:false}),viewport:vp,background:'white'}).promise;text+=await ocrImageSource(c,progress)+'\n'}return{text,mode}}
async function smartLabReadFile(file,onProgress){let text='',dataUrl='',readMode='none',error='';if(file.size<=4*1024*1024){try{dataUrl=await new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(file)})}catch{}}try{if(file.type==='application/pdf'||/\.pdf$/i.test(file.name)){const r=await readPdfTextAndOcr(file,onProgress);text=r.text;readMode=r.mode}else if(file.type.startsWith('image/')){if('TextDetector'in window){try{onProgress?.('Lecture de la photo…');const bmp=await createImageBitmap(file),det=new TextDetector(),res=await det.detect(bmp);text=res.map(x=>x.rawValue||'').join('\n');readMode=text.trim()?'ocr-natif':'none';bmp.close?.()}catch(_){}}if(text.replace(/\s/g,'').length<20){onProgress?.('OCR de la photo…');const canvas=await canvasForOcr(file);text=await ocrImageSource(canvas,onProgress);readMode='ocr-tesseract'}}else if(/^text\//.test(file.type)){text=await file.text();readMode='texte'}}catch(e){console.error('Lecture labo',e);error=String(e?.message||e||'Erreur de lecture')}return{text,dataUrl,readMode,error}}
function labReadModeLabel(mode=''){return ({'pdf-text':'texte PDF','ocr-pdf':'OCR PDF','ocr-natif':'OCR appareil','ocr-tesseract':'OCR image','texte':'texte'})[mode]||'document conservé'}
function removeSmartLabImportedValues(view,visit,fileName=''){
  let removed=0;
  if(view==='metabolic'){const m=ensureMetabolic(visit),before=m.rows.length;m.rows=m.rows.filter(r=>r.importSource!==fileName);removed=before-m.rows.length;}
  else if(view==='parasitism'){const p=ensureParasitism(visit);let before=p.rows.length;p.rows=p.rows.filter(r=>r.importSource!==fileName);removed+=before-p.rows.length;before=p.pepsinogen.length;p.pepsinogen=p.pepsinogen.filter(r=>r.importSource!==fileName);removed+=before-p.pepsinogen.length;}
  else if(view==='waterlab'){const w=ensureWaterLab(visit);w.points.forEach(pt=>{const before=(pt.rows||[]).length;pt.rows=(pt.rows||[]).filter(r=>r.importSource!==fileName);removed+=before-pt.rows.length});w.points=w.points.filter(pt=>!(pt.importSource===fileName && !(pt.rows||[]).length));}
  return removed;
}
function smartLabProposalHtml(x,docId){return `<tr data-lab-proposal-row="${escapeHtml(x.id)}"><td><input type="checkbox" data-lab-proposal-check="${escapeHtml(x.id)}" ${x.selected!==false?'checked':''}></td><td><strong>${escapeHtml(x.label||'')}</strong></td><td><input data-lab-proposal-value="${escapeHtml(x.id)}" value="${escapeHtml(x.value??'')}" inputmode="decimal"></td><td><input data-lab-proposal-unit="${escapeHtml(x.id)}" value="${escapeHtml(x.unit||'')}"></td><td class="small-text">${escapeHtml(x.sourceLine||'')}</td></tr>`}
function renderSmartLabImportCard(view,visit){
 if(!visit||!['metabolic','parasitism','waterlab'].includes(view))return;
 const labels={metabolic:'profil métabolique / oligo',parasitism:'parasitisme',waterlab:'analyse d’eau'};
 visit.labImports=Array.isArray(visit.labImports)?visit.labImports:[];
 const existing=visit.labImports.filter(x=>x.module===view),integrated=existing.reduce((n,x)=>n+(Number(x.integratedCount)||0),0);
 const card=document.createElement('section');card.className='card smart-lab-import';
 card.innerHTML=`<div class="section-title"><div><h3>📄 Résultats labo — ${escapeHtml(labels[view])}</h3><div class="muted">${existing.length?`✅ ${existing.length} document(s) chargé(s) · ${integrated} valeur(s) validée(s) et intégrée(s)`:'Aucun résultat labo chargé dans ce module.'}</div></div>${existing.length?`<span class="badge complete">${existing.length} chargé(s)</span>`:''}</div>
 <div class="notice warning"><strong>Nouvelle méthode de lecture :</strong> l’OCR ne renseigne plus directement les tableaux. Il propose d’abord les valeurs trouvées avec la ligne du document d’origine. Vérifiez puis cliquez sur <b>Intégrer les valeurs cochées</b>. Cela évite de confondre résultat, seuil, date ou n° d’échantillon.</div>
 <input type="file" accept="image/*,.pdf,application/pdf" data-smart-lab-file multiple><div class="small lab-import-progress" data-smart-lab-info></div>
 <div class="lab-import-list">${existing.length?existing.map(x=>{const props=Array.isArray(x.proposals)?x.proposals:[];return `<article class="lab-import-review ${props.length?'needs-review':''}" data-lab-doc="${x.id}"><div class="lab-import-item"><span><b>${escapeHtml(x.name)}</b><small>${formatDateTime(x.createdAt)} · ${props.length} proposition(s) détectée(s) · ${Number(x.integratedCount)||0} intégrée(s) · ${x.processing?'⏳ lecture en cours':escapeHtml(labReadModeLabel(x.readMode|| (x.ocrText?'ocr-natif':'')))}${x.readError?` · ⚠️ ${escapeHtml(x.readError)}`:''}</small></span><div class="actions">${x.dataUrl?`<button class="btn small" data-retry-lab-import="${x.id}">↻ Relire</button><button class="btn small" data-open-lab-import="${x.id}">Ouvrir</button>`:''}${Number(x.integratedCount)?`<button class="btn small secondary" data-remove-lab-values="${x.id}">Retirer les valeurs importées</button>`:''}<button class="btn small danger" data-delete-lab-import="${x.id}">Supprimer</button></div></div>
 ${props.length?`<div class="notice warning lab-review-callout"><strong>⚠️ Valeurs à vérifier ci-dessous</strong> — rien n’est intégré tant que vous n’avez pas validé.</div><div class="table-wrap"><table class="compact-table lab-review-table"><thead><tr><th>✓</th><th>Paramètre</th><th>Valeur détectée</th><th>Unité</th><th>Ligne réellement lue dans le document</th></tr></thead><tbody>${props.map(p=>smartLabProposalHtml(p,x.id)).join('')}</tbody></table></div><div class="actions"><button class="btn primary" data-integrate-lab-proposals="${x.id}">✓ Intégrer les valeurs cochées</button><span class="muted small-text">Vous pouvez corriger la valeur ou l’unité avant validation.</span></div>`:`<div class="notice"><strong>Aucune proposition exploitable.</strong> Le document est bien conservé, mais aucune valeur ne sera inventée. Ouvrez le document et saisissez manuellement si nécessaire.</div>`}${x.ocrText?`<details class="lab-ocr-raw"><summary>Voir le texte réellement lu dans le document</summary><pre>${escapeHtml(x.ocrText.slice(0,12000))}</pre></details>`:''}</article>`}).join(''):'<div class="empty compact">Aucun résultat labo importé dans ce module.</div>'}</div>`;
 app.prepend(card);
 const processFile=async(file,existingImport=null)=>{
  const visitId=visit.id;
  const info=card.querySelector('[data-smart-lab-info]');
  const progress=msg=>{if(info&&info.isConnected)info.textContent=`${file.name} — ${msg}`};
  let docId=existingImport?.id||'';
  // Enregistrer le document AVANT l'OCR. Ainsi, même si la lecture prend du temps
  // ou si une synchronisation intervient, le fichier reste visible dans la visite.
  if(!docId){
    docId=uid('labimp');
    let initialDataUrl='';
    if(file.size<=4*1024*1024){try{initialDataUrl=await new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(file)})}catch{}}
    const liveVisit=db.visits.find(v=>v.id===visitId)||visit;
    liveVisit.labImports=Array.isArray(liveVisit.labImports)?liveVisit.labImports:[];
    liveVisit.labImports.unshift({id:docId,module:view,name:file.name,type:file.type,size:file.size,createdAt:new Date().toISOString(),ocrText:'',dataUrl:initialDataUrl,integratedCount:0,proposals:[],readMode:'lecture-en-cours',readError:'',processing:true});
    liveVisit.updatedAt=new Date().toISOString();
    saveDatabase(db);
  }
  progress('fichier enregistré · lecture en cours…');
  const{text,dataUrl,readMode,error}=await smartLabReadFile(file,progress);
  progress(text.trim()?'Analyse prudente des lignes du document…':error||'Aucun texte détecté.');
  const proposals=extractSmartLabProposals(view,text);
  // Toujours raccrocher le résultat OCR à la visite actuellement présente dans db,
  // jamais à une ancienne référence DOM/visite devenue obsolète.
  const liveVisit=db.visits.find(v=>v.id===visitId)||visit;
  liveVisit.labImports=Array.isArray(liveVisit.labImports)?liveVisit.labImports:[];
  let target=liveVisit.labImports.find(x=>x.id===docId);
  if(!target){target={id:docId,module:view,name:file.name,type:file.type,size:file.size,createdAt:new Date().toISOString(),integratedCount:0};liveVisit.labImports.unshift(target)}
  target.ocrText=text;target.readMode=readMode;target.readError=error;target.proposals=proposals;target.processing=false;target.reReadAt=new Date().toISOString();if(dataUrl&&!target.dataUrl)target.dataUrl=dataUrl;
  liveVisit.updatedAt=new Date().toISOString();
  saveDatabase(db);
  return{proposalCount:proposals.length,text,error,readMode,docId:target.id};
 };
 card.querySelector('[data-smart-lab-file]').onchange=async e=>{const files=[...(e.target.files||[])];if(!files.length)return;let ok=0,total=0,readDocs=0,errors=[],lastDocId='';for(const file of files){const r=await processFile(file);ok++;total+=r.proposalCount;lastDocId=r.docId||lastDocId;if(r.text.trim())readDocs++;if(r.error)errors.push(r.error)}const liveVisit=db.visits.find(v=>v.id===visit.id)||visit;liveVisit.updatedAt=new Date().toISOString();saveDatabase(db);if(total)showToast(`${ok} document(s) enregistré(s) · ${total} valeur(s) proposée(s) à vérifier.`);else if(readDocs)showToast(`${ok} document(s) enregistré(s), mais aucune valeur suffisamment fiable n’a été proposée.`);else showToast(errors.length?'Le document est enregistré, mais l’OCR n’a pas pu démarrer.':'Document enregistré, mais aucun texte exploitable n’a été détecté.');render();setTimeout(()=>{app.scrollLeft=0;const box=lastDocId?app.querySelector(`[data-lab-doc="${lastDocId}"]`):app.querySelector('.lab-import-review.needs-review');box?.scrollIntoView({behavior:'auto',block:'start'});box?.classList.add('just-imported')},80)};
 card.querySelectorAll('[data-lab-doc]').forEach(box=>{const x=visit.labImports.find(y=>y.id===box.dataset.labDoc);if(!x)return;box.querySelectorAll('[data-lab-proposal-check]').forEach(el=>el.onchange=e=>{const p=(x.proposals||[]).find(z=>z.id===el.dataset.labProposalCheck);if(p){p.selected=e.target.checked;saveDatabase(db)}});box.querySelectorAll('[data-lab-proposal-value]').forEach(el=>el.oninput=e=>{const p=(x.proposals||[]).find(z=>z.id===el.dataset.labProposalValue);if(p){p.value=e.target.value;saveDatabase(db)}});box.querySelectorAll('[data-lab-proposal-unit]').forEach(el=>el.oninput=e=>{const p=(x.proposals||[]).find(z=>z.id===el.dataset.labProposalUnit);if(p){p.unit=e.target.value;saveDatabase(db)}})});
 card.querySelectorAll('[data-integrate-lab-proposals]').forEach(b=>b.onclick=()=>{const x=visit.labImports.find(y=>y.id===b.dataset.integrateLabProposals);if(!x)return;const count=integrateSmartLabProposals(view,visit,x.proposals||[],x.name);x.integratedCount=(Number(x.integratedCount)||0)+count;x.validatedAt=new Date().toISOString();visit.updatedAt=new Date().toISOString();saveDatabase(db);showToast(count?`${count} valeur(s) validée(s) et intégrée(s) dans le tableau.`:'Aucune nouvelle valeur à intégrer.');render()});
 card.querySelectorAll('[data-remove-lab-values]').forEach(b=>b.onclick=()=>{const x=visit.labImports.find(y=>y.id===b.dataset.removeLabValues);if(!x)return;if(!confirm(`Retirer du module toutes les valeurs précédemment importées depuis « ${x.name} » ? Le document restera joint.`))return;const removed=removeSmartLabImportedValues(view,visit,x.name);x.integratedCount=0;saveDatabase(db);showToast(`${removed} valeur(s) importée(s) retirée(s).`);render()});
 card.querySelectorAll('[data-retry-lab-import]').forEach(b=>b.onclick=async()=>{const x=visit.labImports.find(y=>y.id===b.dataset.retryLabImport);if(!x?.dataUrl)return showToast('Fichier non disponible sur cet appareil.');try{const blob=dataUrlToBlob(x.dataUrl),file=new File([blob],x.name||'resultat-labo',{type:x.type||blob.type||'application/octet-stream'});const r=await processFile(file,x);visit.updatedAt=new Date().toISOString();saveDatabase(db);showToast(r.proposalCount?`${r.proposalCount} valeur(s) proposée(s) à vérifier.`:r.text.trim()?'Document relu : aucune valeur suffisamment fiable proposée.':'Impossible de lire le texte de ce document.');render();setTimeout(()=>{app.scrollLeft=0;const box=app.querySelector(`[data-lab-doc="${x.id}"]`);box?.scrollIntoView({behavior:'auto',block:'start'});box?.classList.add('just-imported')},80)}catch(e){console.error(e);showToast('Impossible de relire ce document.')}});
 card.querySelectorAll('[data-open-lab-import]').forEach(b=>b.onclick=()=>{const x=visit.labImports.find(y=>y.id===b.dataset.openLabImport);if(!x?.dataUrl)return showToast('Fichier non disponible sur cet appareil.');try{const blob=dataUrlToBlob(x.dataUrl),url=URL.createObjectURL(blob);window.open(url,'_blank');setTimeout(()=>URL.revokeObjectURL(url),30000)}catch{showToast('Impossible d’ouvrir ce fichier.')}});
 card.querySelectorAll('[data-delete-lab-import]').forEach(b=>b.onclick=()=>{const x=visit.labImports.find(y=>y.id===b.dataset.deleteLabImport);if(!x)return;if(!confirm('Supprimer ce document labo de la visite ? Les valeurs déjà intégrées ne seront pas supprimées automatiquement.'))return;visit.labImports=visit.labImports.filter(y=>y.id!==x.id);saveDatabase(db);render()});
}


(function initWorkflowPhases(){const map={dashboard:'prepare',farms:'prepare',visits:'prepare',documents:'prepare',herddata:'prepare',questionnaires:'prepare',prepprint:'prepare',followup:'prepare',animals:'terrain',analysis:'terrain',feeding:'terrain',building:'terrain',audit:'terrain',photos:'terrain',checkout:'terrain',nutrition:'report',reproduction:'report',metabolic:'report',parasitism:'report',waterlab:'report',assistant:'report',pilotage:'report',reports:'report',review:'report',study:'follow',economy:'follow',journal:'follow'};function apply(phase){localStorage.setItem('audit-bovin-phase',phase);document.querySelectorAll('.phase-btn').forEach(b=>b.classList.toggle('active',b.dataset.phase===phase));document.querySelectorAll('.nav-btn[data-phase-item]').forEach(b=>b.classList.toggle('phase-hidden',b.dataset.phaseItem!==phase));}window.__auditApplyPhaseForView=view=>{const ph=map[view];if(ph)apply(ph)};document.querySelectorAll('.phase-btn').forEach(b=>b.addEventListener('click',()=>apply(b.dataset.phase)));apply(map[currentView]||localStorage.getItem('audit-bovin-phase')||'prepare');})();


// v14.6.21.68 — check-up, suivi d'étude, économie et conservation globale du défilement horizontal
function ensureEndVisitCheckup(visit){
  visit.endVisitCheckup=visit.endVisitCheckup&&typeof visit.endVisitCheckup==='object'?visit.endVisitCheckup:{};
  const defaults=[
    ['animalSamples','Prélèvements animaux réalisés / identifiés'],['siloSamples','Échantillons fourrages / silos'],['electric','Mesures électriques'],['waterSamples','Échantillons d’eau'],['coproSamples','Prélèvements copro / analyses parasito récupérées'],['rations','Rations relevées'],['feedLabels','Étiquettes aliments récupérées'],['mineralLabels','Étiquettes minéraux / bolus récupérées'],['photos','Photos utiles'],['documents','Documents / analyses déjà disponibles récupérés'],['farmerQuestions','Questions restantes posées à l’éleveur']
  ];
  defaults.forEach(([k,l])=>{if(!visit.endVisitCheckup[k])visit.endVisitCheckup[k]={status:'À faire',label:l,note:''};});
  return visit.endVisitCheckup;
}
function autoCheckupStatus(visit,key){
  if(key==='animalSamples')return (visit.subjects||[]).length?'Fait':null;
  if(key==='waterSamples')return (visit.waterLab?.points||[]).length?'Fait':null;
  if(key==='coproSamples')return (visit.parasitism?.rows||[]).length|| (visit.parasitism?.serologies||[]).length?'Fait':null;
  if(key==='rations')return (visit.feeding?.rations||[]).length || (visit.feeding?.rationLines||[]).length?'Fait':null;
  if(key==='photos')return (visit.photos||[]).length?'Fait':null;
  return null;
}
function renderEndVisitCheckup(){
  const v=activeVisit();if(!v){renderNoActiveVisit('Check-up fin de visite');return;}const c=ensureEndVisitCheckup(v);
  Object.keys(c).forEach(k=>{const a=autoCheckupStatus(v,k);if(a&&c[k].status==='À faire')c[k].status=a;});
  const rows=Object.entries(c);const left=rows.filter(([,x])=>x.status==='À faire').length;
  app.innerHTML=`<div class="section-title"><div><h2>✅ Check-up fin de visite</h2><div class="muted">Dernier balayage avant de quitter l’élevage. Rien n’est bloquant : Fait / À faire / Non nécessaire.</div></div><span class="badge ${left?'in-progress':'complete'}">${left?left+' à vérifier':'Complet'}</span></div>${activeVisitBanner(v)}<section class="notice"><strong>Principe terrain :</strong> il suffit de récupérer les informations impossibles à reconstituer ensuite. Exemple minéral : photo/étiquette + quantité distribuée ; la composition détaillée peut être saisie au bureau après la visite.</section><section class="card"><div class="checkup-cards">${rows.map(([k,x])=>`<article class="checkup-item" data-checkup="${k}"><strong>${escapeHtml(x.label)}</strong><select data-checkup-status><option ${x.status==='Fait'?'selected':''}>Fait</option><option ${x.status==='À faire'?'selected':''}>À faire</option><option ${x.status==='Non nécessaire'?'selected':''}>Non nécessaire</option></select><input data-checkup-note value="${escapeHtml(x.note||'')}" placeholder="Commentaire / ce qui manque"></article>`).join('')}</div></section><section class="card notice ${left?'warning':''}"><strong>${left?'⚠️ Il reste '+left+' point(s) à vérifier.':'✓ Check-up terminé.'}</strong><br>Vous pouvez néanmoins passer à Analyse & restitution à tout moment.</section>`;
  app.querySelectorAll('[data-checkup]').forEach(tr=>{const x=c[tr.dataset.checkup];tr.querySelector('[data-checkup-status]').onchange=e=>{x.status=e.target.value;saveDatabase(db);renderEndVisitCheckup()};tr.querySelector('[data-checkup-note]').oninput=e=>{x.note=e.target.value;saveDatabase(db)}});
}
function ensureStudyTracking(v){
  v.studyTracking=v.studyTracking&&typeof v.studyTracking==='object'?v.studyTracking:{};const s=v.studyTracking;
  s.attendees=Array.isArray(s.attendees)?s.attendees:[];s.tests=Array.isArray(s.tests)?s.tests:[];s.farmerChanges=Array.isArray(s.farmerChanges)?s.farmerChanges:[];s.notes=s.notes||'';s.periodTarget=s.periodTarget||'';s.gdsTime=s.gdsTime&&typeof s.gdsTime==='object'?s.gdsTime:{preparation:'',onSite:'',reporting:'',followup:''};return s;
}
function addStudyAttendee(){const v=activeVisit();if(!v)return;ensureStudyTracking(v).attendees.push({id:uid('att'),role:'Vétérinaire',name:'',organization:'',timeHours:''});saveDatabase(db);renderStudyTracking();}
function addStudyTest(){const v=activeVisit();if(!v)return;ensureStudyTracking(v).tests.push({id:uid('test'),type:'Parasitologie',lab:'',requested:'',sampled:'',received:'',interpreted:'',invoiceReceived:false,invoicePaid:false,cost:'',documentNote:''});saveDatabase(db);renderStudyTracking();}
function addFarmerChange(){const v=activeVisit();if(!v)return;ensureStudyTracking(v).farmerChanges.push({id:uid('chg'),action:'',date:'',cost:'',benefitEstimated:'',benefitMeasured:'',evidence:''});saveDatabase(db);renderStudyTracking();}
function renderStudyTracking(){
 const v=activeVisit();if(!v){renderNoActiveVisit('Suivi de l’étude');return;}const s=ensureStudyTracking(v);
 app.innerHTML=`<div class="section-title"><div><h2>📁 Suivi de l’étude</h2><div class="muted">Intervenants, temps passé, analyses demandées, factures/justificatifs et changements réellement mis en place.</div></div></div>${activeVisitBanner(v)}<section class="card"><div class="field"><label>Période / étape ciblée lors de cette visite</label><input id="study-period-target" value="${escapeHtml(s.periodTarget||'')}" placeholder="Ex. fin de gestation, reproduction, tarissement, engraissement…"></div></section><section class="card"><div class="section-title"><h3>👥 Qui était présent ?</h3><button class="btn" id="add-attendee">+ Intervenant</button></div>${s.attendees.map(a=>`<div class="grid cols-4 study-row" data-att="${a.id}"><select data-f="role">${['Éleveur','Vétérinaire','Technicien GDS','Expert GDS','Technicien Chambre / CDA','Nutritionniste','Autre'].map(x=>`<option ${a.role===x?'selected':''}>${x}</option>`).join('')}</select><input data-f="name" value="${escapeHtml(a.name)}" placeholder="Nom"><input data-f="organization" value="${escapeHtml(a.organization)}" placeholder="Organisme"><input data-f="timeHours" inputmode="decimal" value="${escapeHtml(a.timeHours||'')}" placeholder="Temps sur place (h)"></div>`).join('')||'<div class="muted">Aucun intervenant renseigné.</div>'}<p class="muted">Le temps peut être saisi en décimal : 1,5 = 1 h 30.</p></section><section class="card"><h3>⏱️ Temps GDS consacré à l’étude</h3><div class="grid cols-4"><div class="field"><label>Préparation avant visite (h)</label><input data-gds-time="preparation" inputmode="decimal" value="${escapeHtml(s.gdsTime.preparation||'')}"></div><div class="field"><label>Temps sur place GDS (h)</label><input data-gds-time="onSite" inputmode="decimal" value="${escapeHtml(s.gdsTime.onSite||'')}"></div><div class="field"><label>Compte rendu / analyse (h)</label><input data-gds-time="reporting" inputmode="decimal" value="${escapeHtml(s.gdsTime.reporting||'')}"></div><div class="field"><label>Suivi après visite (h)</label><input data-gds-time="followup" inputmode="decimal" value="${escapeHtml(s.gdsTime.followup||'')}"></div></div><div class="notice"><strong>Total GDS :</strong> ${(numE(s.gdsTime.preparation)+numE(s.gdsTime.onSite)+numE(s.gdsTime.reporting)+numE(s.gdsTime.followup)).toFixed(2).replace('.',',')} h</div></section><section class="card"><div class="section-title"><h3>🧪 Analyses / prestations</h3><button class="btn" id="add-study-test">+ Analyse</button></div><div class="table-wrap"><table><thead><tr><th>Type</th><th>Labo</th><th>Demandée</th><th>Prélevée</th><th>Résultat reçu</th><th>Interprétée</th><th>Facture</th><th>Réglée</th><th>Coût €</th><th>Justificatif / note</th></tr></thead><tbody>${s.tests.map(t=>`<tr data-test="${t.id}"><td><select data-f="type">${['Parasitologie','Eau','Ration / fourrage','Oligo / vitamines','Sérologie','Pepsinogène','Autre'].map(x=>`<option ${t.type===x?'selected':''}>${x}</option>`).join('')}</select></td><td><input data-f="lab" value="${escapeHtml(t.lab)}"></td>${['requested','sampled','received','interpreted'].map(k=>`<td><input type="date" data-f="${k}" value="${escapeHtml(t[k]||'')}"></td>`).join('')}<td><input type="checkbox" data-f="invoiceReceived" ${t.invoiceReceived?'checked':''}></td><td><input type="checkbox" data-f="invoicePaid" ${t.invoicePaid?'checked':''}></td><td><input data-f="cost" inputmode="decimal" value="${escapeHtml(t.cost||'')}"></td><td><input data-f="documentNote" value="${escapeHtml(t.documentNote||'')}" placeholder="nom facture / emplacement"></td></tr>`).join('')||'<tr><td colspan="10">Aucune analyse suivie.</td></tr>'}</tbody></table></div><p class="muted">Les PDF, factures et rapports peuvent être stockés dans Documents exploitation ; renseignez ici leur nom pour les retrouver rapidement.</p></section><section class="card"><div class="section-title"><h3>🔧 Modifications faites par l’éleveur</h3><button class="btn" id="add-change">+ Modification</button></div>${s.farmerChanges.map(x=>`<div class="grid cols-4 study-row" data-change="${x.id}"><input data-f="action" value="${escapeHtml(x.action)}" placeholder="Action réalisée"><input type="date" data-f="date" value="${escapeHtml(x.date)}"><input data-f="cost" value="${escapeHtml(x.cost)}" placeholder="Coût réel €"><input data-f="benefitEstimated" value="${escapeHtml(x.benefitEstimated)}" placeholder="Bénéfice estimé €"><input data-f="benefitMeasured" value="${escapeHtml(x.benefitMeasured)}" placeholder="Bénéfice mesuré €"><input data-f="evidence" value="${escapeHtml(x.evidence)}" placeholder="Facture / preuve / commentaire"></div>`).join('')||'<div class="muted">Aucune modification enregistrée.</div>'}</section>`;
 document.getElementById('study-period-target')?.addEventListener('input',e=>{s.periodTarget=e.target.value;saveDatabase(db)});document.getElementById('add-attendee').onclick=addStudyAttendee;document.getElementById('add-study-test').onclick=addStudyTest;document.getElementById('add-change').onclick=addFarmerChange;
 app.querySelectorAll('[data-gds-time]').forEach(el=>el.onchange=e=>{s.gdsTime[el.dataset.gdsTime]=e.target.value;saveDatabase(db);renderStudyTracking()});
 app.querySelectorAll('[data-att],[data-test],[data-change]').forEach(row=>{const arr=row.dataset.att?s.attendees:row.dataset.test?s.tests:s.farmerChanges;const idv=row.dataset.att||row.dataset.test||row.dataset.change;const obj=arr.find(x=>x.id===idv);row.querySelectorAll('[data-f]').forEach(el=>{const ev=el.type==='checkbox'?'change':'input';el.addEventListener(ev,e=>{obj[el.dataset.f]=el.type==='checkbox'?el.checked:el.value;saveDatabase(db)})})});
}
function ensureFarmEconomics(farm){farm.economicSettings=farm.economicSettings&&typeof farm.economicSettings==='object'?farm.economicSettings:{};const d={calfPrice:800,cowValue:1800,heiferValue:1500,milkPrice:0.48,liveKgPrice:3.5,carcassKgPrice:6,feedCostDayCalf:2.2,heiferCostDay:2.8,lamenessCaseCost:250,mastitisCaseCost:230,abortionCaseCost:900,adultDeathNetCost:1500};Object.entries(d).forEach(([k,v])=>{if(farm.economicSettings[k]===undefined||farm.economicSettings[k]==='')farm.economicSettings[k]=v});return farm.economicSettings;}
function numE(x){const n=Number(String(x??'').replace(',','.'));return Number.isFinite(n)?n:0;}
function economicReproSnapshot(v){
 const farm=db.farms.find(f=>f.id===v.farmId);if(!farm)return{};const source=reproductionSourceForVisit(v,farm),reg=source.registry||[];if(!reg.length)return{};const reproFarm={...farm,herdRegistry:reg};const date=v.date||new Date().toISOString().slice(0,10);const cows=currentReproductionCows(reproFarm,date);const ivvs=cows.flatMap(r=>r.intervals||[]);const calves=cows.flatMap(r=>r.calves||[]).filter(c=>!v.date||c.birthDate<=date);const dead=calves.filter(c=>c.exitCause==='M'&&c.exitDate&&daysBetweenDates(c.birthDate,c.exitDate)<183);const fca=cows.map(r=>r.firstCalvingAgeMonths).filter(x=>x!=null);return {cowCount:cows.length,ivv:ivvs.length?ivvs.reduce((a,b)=>a+b,0)/ivvs.length:null,calves:calves.length,calfMortality:calves.length?dead.length/calves.length*100:null,firstCalving:fca.length?fca.reduce((a,b)=>a+b,0)/fca.length:null};
}
function economicPrevVisit(v){return db.visits.filter(x=>x.farmId===v.farmId&&x.id!==v.id&&x.date&&x.date<v.date).sort((a,b)=>b.date.localeCompare(a.date))[0]||null;}
function calcEconomicRows(v){const farm=db.farms.find(f=>f.id===v.farmId),p=ensureFarmEconomics(farm),prev=economicPrevVisit(v),cur=economicReproSnapshot(v),old=prev?economicReproSnapshot(prev):{};const m=v.economicManual=v.economicManual||{};const rows=[];
 function push(label,formula,gain,source='Saisie / hypothèse'){rows.push({label,formula,gain:Number.isFinite(gain)?gain:0,source});}
 const calves=numE(m.calvesAtRisk||cur.calves),mortOld=numE(m.calfMortalityBefore||old.calfMortality),mortNew=numE(m.calfMortalityAfter||cur.calfMortality);if(calves&&mortOld>=mortNew)push('Mortalité des veaux',`${calves} veaux × ${(mortOld-mortNew).toFixed(1)} % × ${p.calfPrice} €`,calves*(mortOld-mortNew)/100*p.calfPrice,old.calfMortality!=null&&cur.calfMortality!=null?'Comparaison visites':'Saisie');
 const adultSaved=numE(m.adultDeathsAvoided);if(adultSaved)push('Mortalité adulte',`${adultSaved} décès évité(s) × ${p.adultDeathNetCost} €`,adultSaved*p.adultDeathNetCost);
 const cows=numE(m.cowsForIVV||cur.cowCount),ivvOld=numE(m.ivvBefore||old.ivv),ivvNew=numE(m.ivvAfter||cur.ivv);if(cows&&ivvOld>ivvNew&&ivvNew>0){const extra=cows*(ivvOld-ivvNew)/365;push('IVV réduit',`${cows} vaches × ${Math.round(ivvOld-ivvNew)} j gagnés / 365 = ${extra.toFixed(1)} veau(x) théorique(s) × ${p.calfPrice} €`,extra*p.calfPrice,old.ivv&&cur.ivv?'Comparaison visites':'Saisie');}
 const heifers=numE(m.heifers),fcaOld=numE(m.firstCalvingBefore||old.firstCalving),fcaNew=numE(m.firstCalvingAfter||cur.firstCalving);if(heifers&&fcaOld>fcaNew&&fcaNew>0){const days=(fcaOld-fcaNew)*30.44;push('Âge au 1er vêlage avancé',`${heifers} génisses × ${Math.round(days)} j × ${p.heiferCostDay} €/j`,heifers*days*p.heiferCostDay,old.firstCalving&&cur.firstCalving?'Comparaison visites':'Saisie');}
 const milk=numE(m.extraMilkLitres);if(milk)push('Production laitière',`${milk} L × ${p.milkPrice} €/L`,milk*p.milkPrice);
 const lameness=numE(m.lamenessCasesAvoided);if(lameness)push('Boiteries évitées',`${lameness} cas × ${p.lamenessCaseCost} €`,lameness*p.lamenessCaseCost);
 const mastitis=numE(m.mastitisCasesAvoided);if(mastitis)push('Mammites évitées',`${mastitis} cas × ${p.mastitisCaseCost} €`,mastitis*p.mastitisCaseCost);
 const abortions=numE(m.abortionsAvoided);if(abortions)push('Avortements évités',`${abortions} cas × ${p.abortionCaseCost} €`,abortions*p.abortionCaseCost);
 const ncalves=numE(m.gmqCalves),gmq0=numE(m.gmqBefore),gmq1=numE(m.gmqAfter),days=numE(m.gmqDays);if(ncalves&&gmq1>gmq0&&days){const kg=ncalves*(gmq1-gmq0)/1000*days;push('GMQ amélioré / poids supplémentaire',`${ncalves} veaux × ${gmq1-gmq0} g/j × ${days} j = ${kg.toFixed(0)} kg × ${p.liveKgPrice} €/kg`,kg*p.liveKgPrice);}
 const saleDays=numE(m.saleDaysEarlier),saleCalves=numE(m.saleCalves);if(saleDays&&saleCalves)push('Vente plus précoce / aliment économisé',`${saleCalves} veaux × ${saleDays} j × ${p.feedCostDayCalf} €/j`,saleCalves*saleDays*p.feedCostDayCalf);
 return rows;}
function renderEconomicProgress(){
 const v=activeVisit();if(!v){renderNoActiveVisit('Marge de progrès économique');return;}const farm=db.farms.find(f=>f.id===v.farmId);if(!farm)return;const p=ensureFarmEconomics(farm),m=v.economicManual=v.economicManual||{},rows=calcEconomicRows(v),total=rows.reduce((s,r)=>s+r.gain,0),prev=economicPrevVisit(v);
 const priceFields=[['calfPrice','Prix moyen veau €'],['cowValue','Valeur vache €'],['heiferValue','Valeur génisse €'],['milkPrice','Prix lait €/L'],['liveKgPrice','Prix kg vif €'],['carcassKgPrice','Prix kg carcasse €'],['feedCostDayCalf','Coût aliment veau €/j'],['heiferCostDay','Coût génisse €/j'],['lamenessCaseCost','Coût moyen boiterie €'],['mastitisCaseCost','Coût moyen mammite €'],['abortionCaseCost','Coût moyen avortement €'],['adultDeathNetCost','Perte nette décès adulte €']];
 const manual=[['calvesAtRisk','Nb veaux concernés'],['calfMortalityBefore','Mortalité veaux avant %'],['calfMortalityAfter','Mortalité veaux après %'],['adultDeathsAvoided','Décès adultes évités'],['cowsForIVV','Nb vaches IVV'],['ivvBefore','IVV avant (j)'],['ivvAfter','IVV après (j)'],['heifers','Nb génisses'],['firstCalvingBefore','1er vêlage avant (mois)'],['firstCalvingAfter','1er vêlage après (mois)'],['extraMilkLitres','Litres de lait supplémentaires'],['lamenessCasesAvoided','Boiteries évitées'],['mastitisCasesAvoided','Mammites évitées'],['abortionsAvoided','Avortements évités'],['gmqCalves','Nb veaux GMQ'],['gmqBefore','GMQ avant g/j'],['gmqAfter','GMQ après g/j'],['gmqDays','Durée GMQ (j)'],['saleCalves','Nb veaux vendus plus tôt'],['saleDaysEarlier','Jours de vente gagnés']];
 app.innerHTML=`<div class="section-title"><div><h2>💶 Marge de progrès économique</h2><div class="muted">Potentiel théorique, gains estimés et comparaison automatique avec la visite précédente lorsqu’elle contient les données nécessaires.</div></div><span class="badge complete">${Math.round(total).toLocaleString('fr-FR')} € potentiel calculé</span></div>${activeVisitBanner(v)}<section class="card"><h3>💰 Prix et coûts propres à ${escapeHtml(farm.name||'l’élevage')}</h3><div class="grid cols-4">${priceFields.map(([k,l])=>`<div class="field"><label>${l}</label><input data-eco-price="${k}" inputmode="decimal" value="${escapeHtml(p[k])}"></div>`).join('')}</div><p class="muted">Ces valeurs sont propres à l’exploitation et peuvent être remplacées par les prix réels de vente, factures ou coûts de l’éleveur.</p></section><section class="card"><h3>📊 Données de comparaison / hypothèses</h3>${prev?`<div class="notice">Visite précédente détectée : <strong>${formatDate(prev.date)}</strong>. Les indicateurs reproduction disponibles sont utilisés automatiquement ; les cases ci-dessous restent modifiables.</div>`:''}<div class="grid cols-4">${manual.map(([k,l])=>`<div class="field"><label>${l}</label><input data-eco-manual="${k}" inputmode="decimal" value="${escapeHtml(m[k]??'')}"></div>`).join('')}</div></section><section class="card"><h3>📈 Bénéfice théorique automatique</h3><div class="table-wrap"><table><thead><tr><th>Poste</th><th>Calcul</th><th>Source</th><th>Gain théorique</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${escapeHtml(r.label)}</strong></td><td>${escapeHtml(r.formula)}</td><td>${escapeHtml(r.source)}</td><td><strong>+ ${Math.round(r.gain).toLocaleString('fr-FR')} €</strong></td></tr>`).join('')||'<tr><td colspan="4">Renseignez les indicateurs disponibles pour obtenir les calculs.</td></tr>'}</tbody><tfoot><tr><th colspan="3">Total indicatif</th><th>${Math.round(total).toLocaleString('fr-FR')} €</th></tr></tfoot></table></div><div class="notice warning"><strong>Attention aux doubles comptes.</strong> Les effets sanitaires peuvent se recouper (ex. boiterie → reproduction). Le total est une aide de discussion, pas une marge comptable certifiée.</div></section>`;
 app.querySelectorAll('[data-eco-price]').forEach(el=>el.onchange=e=>{p[el.dataset.ecoPrice]=numE(e.target.value);saveDatabase(db);renderEconomicProgress()});app.querySelectorAll('[data-eco-manual]').forEach(el=>el.onchange=e=>{m[el.dataset.ecoManual]=e.target.value;saveDatabase(db);renderEconomicProgress()});
}

// Mémorisation du défilement horizontal de tous les tableaux et sous-rubans, même après rerender/synchronisation.
const __auditHorizontalScroll=new Map();
function scrollKeyFor(el,i){const host=el.closest('[data-building-panel],section,.card')||el.parentElement;const id=host?.id||host?.dataset?.buildingPanel||host?.querySelector('h2,h3')?.textContent||'';return `${currentView}|${el.className}|${id}|${i}`;}
function preserveHorizontalScroll(root=document){
 const els=[...root.querySelectorAll('.table-wrap,.tabs,.top-nav,.building-tabs,.analysis-tabs,.subtabs')].filter(el=>el.scrollWidth>el.clientWidth+4);
 els.forEach((el,i)=>{const k=scrollKeyFor(el,i);if(__auditHorizontalScroll.has(k))el.scrollLeft=__auditHorizontalScroll.get(k);const save=()=>__auditHorizontalScroll.set(k,el.scrollLeft);el.addEventListener('scroll',save,{passive:true});el.addEventListener('pointerup',save,{passive:true});el.addEventListener('focusin',()=>setTimeout(()=>{const a=document.activeElement;if(a&&el.contains(a))a.scrollIntoView({block:'nearest',inline:'nearest'});save()},0));});
}
const __oldRenderForScroll=render;render=function(){__oldRenderForScroll();requestAnimationFrame(()=>preserveHorizontalScroll(app));};

// v14.6.21.68 — suivi du temps par intervenant + temps GDS préparation/terrain/compte rendu/suivi

// v14.6.21.68 — questionnaires persistants, repères de saisie, bilan sanitaire/éco partenaire, supports papier, check-up responsive.

window.addEventListener('DOMContentLoaded',()=>{initGlobalSearch();initAccordionMemory();});
// v14.6.21.68 — cohérence, imprimables préparation, animaux présents, recherche globale.
