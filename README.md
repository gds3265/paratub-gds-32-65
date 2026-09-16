## v1.2.51 - Modification des analyses et assainissement sans assistant

- Les analyses saisies manuellement peuvent être modifiées ou supprimées depuis la fiche éleveur.
- L'assistant référentiel et la proposition associée sont masqués pour les cheptels en assainissement.
- Le bouton Traiter lié au référentiel reste réservé aux cheptels en garantie.

## v1.2.48 - Assainissement et taux de réalisation
- L’assistant référentiel distingue désormais strictement les cheptels en Assainissement : il ne propose plus un statut Favorable A/B réservé à la Garantie.
- La saisie manuelle d’une analyse préremplit la population prévue (>24 mois ou 24-72 mois) depuis la programmation de campagne.
- Ajout du nombre de bovins programmés, du nombre de douteux et du calcul automatique des négatifs.
- Calcul du taux de réalisation (dépistés / programmés) et des proportions négatifs / positifs / douteux rapportées aux bovins programmés.
- Le taux est signalé en rouge s’il est inférieur à 95 %, et le moteur ne propose plus automatiquement une validation favorable tant que le dépistage est incomplet.

## v1.2.39 - filtre résultats non reçus + version PWA
- Le filtre « Résultat non reçu » exclut désormais les années intermédiaires sans dépistage, les résultats historiques déjà enregistrés et les PCR positives hors prophylaxie.
- L'affichage de version, le manifeste PWA, les icônes et le cache sont synchronisés sur v1.2.39.

## v1.2.37 - correction du décalage début/fin de campagne 2025/2026

- Correction des qualifications actuelles des départements 32 et 65 à partir des fichiers engagés.
- N-1 conserve la qualification de début de campagne 2025/2026 (équivalente à la situation fin 2024/2025).
- N reprend désormais la qualification SIGAL après prophylaxie / mise à jour dossier, donc la situation de fin de campagne 2025/2026.
- La qualification AGDS courante est recalée sur l'équivalent de la qualification SIGAL de fin de campagne.
- Migration ciblée lors du passage depuis v1.2.36 : elle ne corrige que les fiches qui portent encore les anciennes valeurs de début de campagne, afin de préserver les corrections manuelles.

## v1.2.36 - SIGAL corrigé et situation N mise en évidence

- Le bloc N (situation actuelle) est visuellement prioritaire : fond rose très clair, bordure renforcée et repère « SITUATION ACTUELLE ».
- Référentiels AGDS et SIGAL désormais réellement séparés.
- AGDS standard conservé : PA, DS, 0N, 0I, 1, PO, S1 avec libellés complets.
- SIGAL généraliste : acquisition, dépistage systématique, année 1, année >1, intermédiaire, plan de maîtrise, suspendu.
- Équivalences par défaut : PA→acquisition ; DS→ds ; 1→année1 ; 0N→année >1 ; 0I→inter ; PO→plan maitrise ; S1→susp.
- Favorable A/B restent des statuts/historique, pas de fausses qualifications AGDS ou SIGAL.
- Les variantes historiques (SUSP, PO, DS, acqui, >1...) sont normalisées à l'affichage.
- La mise à jour de version ne recharge plus automatiquement toute la base historique si elle est déjà complète, afin de préserver les modifications locales.

## v1.2.35 - remise à niveau depuis les fiches Excel éleveur
- Réintègre la base consolidée issue des fiches Excel éleveur avec les évolutions N-1 / N / N+1.
- Tous les descendants présents dans les fiches Excel sont marqués EXCME AGDS vu/saisi ; tous les imports Garantie sont marqués EXCIN AGDS vu/saisi.
- Une clôture n’est confirmée que lorsqu’une information de clôture est réellement disponible ; sinon le dossier reste à vérifier/clôturer.
- Les exports AGDS du 10/09/2026 sont utilisés comme preuve positive complémentaire, sans considérer leur absence comme une absence d’événement.

# Paratuberculose GDS 32-65 - v1.2.7

Application PWA de suivi de la paratuberculose bovine.

## Correctif v1.2.7
- Corrige l’erreur de démarrage `kpi is not defined`.
- Rétablit l’ouverture des fiches éleveurs, de la campagne, du bilan et des autres vues.
- Ne force pas une nouvelle restauration de l’historique v1.2.4 : les données locales et modifications déjà présentes sont conservées.
- Nouveau cache PWA `ptb-gds-v1.2.7` pour forcer le chargement du code corrigé.

## v1.2.4 - moteur référentiel étendu

Le moteur d'aide à la décision s'appuie sur les documents intégrés de novembre 2025 :

- Référentiel pour un statut favorable, version 3.
- Gestion des résultats non négatifs, version 2.

Il couvre maintenant :

- clinique évocatrice ;
- point d'attention IDC dans les 3 mois ;
- positifs/douteux en nombre isolé et procédure de recontrôle LR ;
- douteux seuls ;
- bovins présumés non infectés, suspects et infectés ;
- Cas n°1 (maintien A) ;
- Cas n°2a, 2b et 2c (référentiels 1 / 1 bis) ;
- Cas n°3 (référentiels 2 / 2 bis) ;
- Cas n°4 (référentiel 3) ;
- absence de réforme des infectés et de la descendance N/N-1 ;
- Cas n°5, 6 et 7 liés aux introductions/mouvements.

Dans la fenêtre « Traitement / assistant référentiel », le gestionnaire peut renseigner PS2, PCR, PCRe, conclusion du laboratoire de référence, Ct, réforme et gestion des descendants. La proposition se recalcule immédiatement.

La proposition reste une **aide à la décision à valider par le gestionnaire**. Les cas non prévus ou particulièrement complexes doivent être instruits selon le référentiel et, si nécessaire, soumis à la cellule nationale de gestion des cas particuliers.

## Navigation

- À traiter
- Campagne
- Éleveurs
- Imports
- Exports
- Bilan & récap
- Paramètres

Les non négatifs, descendants, animaux et analyses sont consultés dans la fiche de l'éleveur.


## Correctifs v1.2.4
- Campagne active initiale maintenue sur 2025/2026 tant que l’utilisateur ne la change pas explicitement.
- Historique fourni chargé automatiquement au premier démarrage si la base locale est vide.
- Recherche éleveur corrigée : saisie continue d’un EDE complet sans perte de focus à chaque chiffre.
- Import historique étendu aux animaux 32/65.
- Camembert des causes de sortie ajouté au bilan.


## v1.2.4
- Historique initial complet embarqué en JSON : 193 éleveurs, 1 959 campagnes, 2 165 non négatifs, 1 004 descendants, 1 414 introductions.
- Restauration automatique au premier lancement de la version, plus bouton de restauration manuelle.
- Campagne active conservée sur 2025/2026.
- Correction des intitulés de colonnes lors d’un import Excel manuel.
- Recherche EDE sans rechargement à chaque chiffre et camembert des causes de sortie conservés.


## v1.2.4
- Historique embarqué directement dans `history_seed.js` : plus de dépendance au chargement du sous-dossier `migration` au démarrage.
- 193 éleveurs, 1 959 campagnes, 2 165 non négatifs, 1 004 descendants et 1 414 introductions intégrés.
- 3 964 bovins 32/65 intégrés depuis les derniers exports disponibles.
- Campagne active par défaut : 2025/2026.
- Le bouton de restauration réinjecte l’ensemble de ces données dans IndexedDB.


## Correctifs v1.2.4
- Historique : regroupement des lignes d’une même campagne et addition des prélèvements lorsque plusieurs lignes existent.
- Années intermédiaires sans dépistage affichées explicitement.
- N+1 recalculé après une année intermédiaire ; exemple 65216002 : 24-72 mois en 2026/2027.
- Fiche éleveur et historique modifiables.
- Bilan séparé 32 / 65 et prise en compte des résultats historiques si aucun import analyse n’est encore chargé.
- Exemple 65216002 2024/2025 corrigé : 57 + 13 + 4 = 74 prélèvements.


## Correctif v1.2.7
- Version distincte de la v1.2.5 pour éviter tout conflit de cache/version.
- Conservation du correctif `kpi` qui débloque le démarrage, les fiches éleveurs et le bilan.
- Nouveau cache PWA `ptb-gds-v1.2.7`.
- Aucune réinitialisation volontaire des données locales ou de l’historique.

## v1.2.10
- Fiche éleveur réorganisée autour de 3 cadres de gestion : Non négatifs, Descendants, Introductions.
- Introductions affichées uniquement pour les cheptels Garantie.
- Non négatifs modifiables : résultats, PCR, PS2, conclusion, réforme, présence, sortie, cause, décision et contrôle N+1.
- Descendants et introductions ajoutables/modifiables/supprimables.
- Liste brute des animaux déplacée derrière un bouton « Voir les animaux ».
- Bilan clarifié : légendes explicites des camemberts, dénominateurs affichés, compteur positifs séparé sans camembert trompeur.
- Export Excel complet de la base : CHEPTELS, CAMPAGNES, NON_NEGATIFS, DESCENDANTS, INTRODUCTIONS, ANIMAUX, ANALYSES_LOTS, TRAITEMENTS, PARAMETRES.


## v1.2.10
- Bilans bornés explicitement du 1er juillet au 30 juin selon la campagne sélectionnée.
- Compteur unique des non négatifs détectés pendant la campagne.
- Causes de sortie calculées uniquement sur les non négatifs sortis pendant la période de campagne.
- Période rappelée dans le titre et les légendes du bilan.


## v1.2.13
- Bilan borné sur la campagne sélectionnée : ajout du nombre de non négatifs détectés dont la mère était déjà connue non négative.
- Détection basée sur le champ historique, les liens descendants et, lorsque disponible, l'identifiant de la mère dans les imports animaux.
- Champ modifiable dans la fiche d'un non négatif : « Mère déjà connue non négative ? ».
- Cache PWA et numéro de version incrémentés.


## v1.2.13
- Bilan : camembert des causes de sortie des descendants de bovins non négatifs, borné sur la campagne (1er juillet - 30 juin), avec nombres et pourcentages.
- Fiche éleveur 32 : suivi remboursement analyses (facture reçue, date de réception, année 1 à 4, date de réponse à la comptabilité).
- Supabase multi-support : connexion e-mail/mot de passe, rôles Lecture / Écriture / Admin, récupération et envoi de la base cloud, administration des rôles par un compte admin.
- Les comptes Lecture sont bloqués sur les principaux écrans de modification/import.


## v1.2.14
- Nouveau logo PTB 32 65 intégré.
- Icônes PWA PNG 192x192, 512x512 et maskable 512x512.
- Icône Apple Touch pour installation sur iPhone/iPad.
- Manifest PWA renforcé (id, scope, icônes any/maskable).
- Logo affiché dans l’en-tête de l’application.


## v1.2.17
- Icônes PWA déplacées aussi à la racine pour GitHub Pages.
- Manifest et service worker corrigés.
- Bouton « Installer l’appli » ajouté dans l’en-tête avec prompt natif quand disponible et aide de secours sinon.

## v1.2.17 - identité PWA PTB distincte
- Donne à l'application PTB 32-65 une identité PWA unique (`id` dédié) pour éviter toute confusion avec une autre PWA GDS, notamment Vaccination DNC.
- `start_url` propre à PTB 32-65.
- Manifest et icônes versionnés pour contourner les anciens caches navigateur.
- Service worker v1.2.17 avec activation immédiate et mise à jour sans cache.
- Le nettoyage du cache est limité aux caches `ptb-gds-*` afin de ne pas supprimer les caches d'autres applications.


## v1.2.17 - isolation PWA stricte
- Identité PWA absolue : `/paratub-gds-32-65/`.
- `start_url` et `scope` limités strictement au dossier Paratube.
- Service worker enregistré explicitement avec le même scope.
- Le service worker ignore toute URL hors du dossier Paratube.
- Aucun changement sur les autres applications GitHub Pages.


## v1.2.18 - cohérence résultats historiques + programmation N+1
- La fiche éleveur utilise désormais le résultat historique de la campagne active lorsqu'aucun import d'analyses récent n'est chargé.
- Un cheptel avec des résultats historiques (ex. 33 négatifs) n'est plus affiché comme « Résultats non reçus » dans l'assistant.
- Les qualifications numériques/anciennes devenues incohérentes sont remplacées à l'affichage par le statut enregistré dans la campagne active lorsqu'il est plus récent et explicite.
- Nouvel onglet « Programmation N+1 » avec listes Année intermédiaire, >24 mois, 24-72 mois et À vérifier, filtres 32/65, mode et recherche.
- Export CSV de toute la programmation de la campagne suivante.


## v1.2.19
- reprend toutes les corrections de la v1.2.18 (historique utilisé comme résultat de campagne à défaut d’import récent, affichage des qualifications historiques obsolètes, programmation N+1) ;
- ajoute un onglet Référentiels accessible en permanence ;
- intègre des accès directs au Référentiel statut favorable v3 novembre 2025 et au document Gestion des résultats non négatifs v2 novembre 2025 ;
- depuis une fiche éleveur, les liens sous la proposition du moteur ouvrent directement la page PDF correspondant au cas calculé (cas 1 à 7, douteux/recontrôle, surveillance/acquisition).


## v1.2.21 — correction campagne clôturée
- Les résultats repris uniquement depuis l'historique sont considérés comme déjà clôturés et ne rouvrent plus la file À traiter.
- Le compteur À traiter ne compte plus les positifs historiques.
- Le compteur devient Traités / clôturés pour distinguer les validations actives et l'historique déjà enregistré.
- Restaurer l'historique initial ne supprime plus ANALYSES_LOTS ni TRAITEMENTS.
- Les résultats historiques restent visibles dans Campagne et dans les fiches éleveurs, sans être transformés en nouveaux dossiers à instruire.

## v1.2.21 — fiches éleveurs et campagnes historiques
- Restaure la fonction `nonNegFollowupLabel` manquante qui bloquait l'ouverture des fiches éleveurs.
- Une campagne reprise de l'historique n'est plus réinterprétée comme « bovin infecté / statut suspendu » : le statut final enregistré de la campagne est affiché.
- Pour une campagne clôturée en `Favorable A`, les anciens compteurs bruts ne créent plus artificiellement de positifs dans l'affichage effectif.
- La colonne de qualification proposée reprend le statut final enregistré pour les campagnes historiques.
- Le KPI « Positifs à traiter » ne compte plus les campagnes historiques déjà clôturées.


## v1.2.22 — règle Assainissement
- Par défaut, tous les cheptels en Assainissement sont programmés chaque année sur tous les bovins ≥24 mois en sérologie individuelle.
- La règle est appliquée dans la campagne, la proposition N+1 et l'onglet Programmation N+1.
- Une programmation manuelle explicite reste prioritaire pour N+1.

## v1.2.24 — export et impression de la programmation filtrée
- L'export CSV de « Programmation N+1 » reprend désormais uniquement la sélection visible selon les filtres Département, Mode, Catégorie et Recherche.
- Ajout du bouton « Imprimer la sélection » : génère une liste imprimable A4 paysage contenant uniquement les cheptels correspondant aux filtres actifs.
- Le titre d'impression rappelle la campagne préparée et les filtres appliqués.


## v1.2.25 — correction des reprises historiques d’analyses
- Correction automatique des anciennes lignes où les colonnes négatifs / non négatifs avaient été inversées lors de la reprise historique.
- Règle sûre appliquée uniquement aux lignes historiques sources (.xlsx) où `négatifs=0` et `positifs + douteux = dépistés`.
- Les valeurs sont remappées en `négatifs = ancienne colonne positifs` et `positifs = ancien compteur non négatifs`; les faux volumes massifs de positifs disparaissent.
- Correction automatique des données déjà présentes en IndexedDB lors du premier démarrage de la v1.2.25.
- Les cartes d’historique affichent désormais aussi le nombre de négatifs.


## v1.2.27
- Saisie d’un résultat **hors prophylaxie** dans les non négatifs.
- La sérologie peut être laissée vide si une PCR est renseignée.
- Une PCR fèces positive hors prophylaxie suspend le statut du cheptel même pendant une année intermédiaire.
- Le cas apparaît dans la file À traiter, dans la campagne et dans la fiche éleveur.
- Le contexte du résultat est visible dans le tableau des non négatifs.


## v1.2.27 — qualification SIGAL de référence
- La qualification SIGAL affichée utilise en priorité le champ « qualif SIGAL suite réa prophy et MAJ dossier » issu des fichiers engagés 32/65.
- Une campagne plus récente réellement clôturée prend le dessus sur cette valeur historique.
- Une décision plus récente dans l’application (ex. PCR positive hors prophylaxie) prend également le dessus.
- La qualification AGDS reste affichée séparément sans être remplacée par la qualification SIGAL.
- La fiche éleveur affiche la source de la qualification SIGAL actuelle.
- Le champ « qualif SIGAL suite réa prophy et MAJ dossier » est modifiable et repris dans les sauvegardes/imports Excel complets.


## v1.2.29 — qualifications AGDS/SIGAL et vétérinaires
- La qualification SIGAL actuelle se propose automatiquement à partir de la qualification AGDS sélectionnée, tout en restant modifiable avant enregistrement.
- Le statut associé est affiché à côté dans la fiche et dans la fenêtre de modification.
- Les anciennes qualifications SIGAL restent visibles comme historique en lecture seule, pour éviter de maintenir plusieurs champs actuels à la main.
- Paramètres : catalogue AGDS → SIGAL modifiable, avec création/suppression de qualifications, libellés complets et statut associé.
- Paramètres : répertoire des vétérinaires ; les fiches utilisent une liste commune pour éviter les variantes de libellé.
- Lors du renommage d’un vétérinaire, option de remplacement du libellé dans toutes les fiches existantes.


## v1.2.40
- Import introductions/descendants = point d’entrée unique : création/mise à jour automatique du suivi Paratu, sans double saisie.
- Rapprochement orienté actions AGDS : événement EXCIN/EXCME à créer, à créer puis clôturer, à clôturer, déjà traité, déjà clôturé mais ressort dans la liste.
- Export Excel après import avec feuilles SYNTHESE, A_FAIRE_AGDS et RECAP_COMPLET.
- Les animaux historiques issus des fiches Excel restent considérés comme déjà traités dans AGDS ; les nouveaux animaux importés restent à traiter tant qu’aucun événement n’est retrouvé.


## v1.2.44
- Ajout d'un écran **Contrôle AGDS** qui part des suivis EXCME/EXCIN encore ouverts dans Paratu.
- Export Excel des suivis ouverts avec onglets SYNTHESE, A_CLOTURER_AGDS, A_VERIFIER_AGDS et TOUS_OUVERTS.
- Mise en évidence des animaux déjà sortis ou avec contrôle favorable afin de repérer les événements à clôturer dans AGDS.
- Le compte-rendu des imports descendants / introductions indique désormais aussi **ce qui a été mis à jour dans Paratu** (nouveau suivi, événement confirmé, clôture, date de sortie).
- Les introductions du contrôle AGDS restent limitées aux cheptels en Garantie.

## v1.2.45
- Remise à zéro unique des alertes historiques « Mères sorties — descendance à vérifier ».
- Les situations déjà présentes lors de la mise à jour sont considérées vérifiées d’après les anciennes fiches éleveur.
- Les nouvelles situations détectées après cette remise à zéro ressortent normalement.


## v1.2.47
- Mise en place d'un état initial T0 pour les alertes « À clôturer AGDS ».
- Toutes les alertes de clôture déjà présentes lors du premier démarrage en v1.2.47 sont acquittées sans marquer artificiellement EXCME/EXCIN comme clôturés.
- Les compteurs Campagne, fiches éleveur et Contrôle AGDS n'affichent plus ce stock historique.
- Une nouvelle sortie ou un nouveau contrôle favorable après le T0 peut faire réapparaître une alerte, grâce à une signature de l'état ayant été acquitté au T0.


## v1.2.47
- Correction : modifier uniquement une date de sortie sur un non négatif existant ne demande plus de renseigner une sérologie ou une PCR.
- Saisie rapide des dates : JJMMAA accepté dans les formulaires de suivi (ex. 220526), affichage JJ/MM/AA.
- Les dates restent stockées au format ISO en base pour conserver les tris et calculs.

## v1.2.51
- Analyses manuelles réellement modifiables, même si elles coexistent avec des lots importés.
- Ajout des résultats hémolysés et ininterprétables dans la saisie et les tableaux.
- Saisie dédiée des remboursements Gers depuis la fiche éleveur.
- Correction de la persistance du commentaire de situation.
- Export dédié des bovins introduits.
- Gestion des droits Lecture / Écriture / Admin explicitée dans Paramètres (Supabase).
- Date/heure de dernière mise à jour affichée sur chaque fiche éleveur et alimentée par les modifications principales.
