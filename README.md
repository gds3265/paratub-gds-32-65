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
