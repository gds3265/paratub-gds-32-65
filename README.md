# Paratuberculose GDS 32-65 - v1.2.2

Application PWA de suivi de la paratuberculose bovine.

## v1.2.2 - moteur référentiel étendu

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


## Correctifs v1.2.2
- Campagne active initiale maintenue sur 2025/2026 tant que l’utilisateur ne la change pas explicitement.
- Historique fourni chargé automatiquement au premier démarrage si la base locale est vide.
- Recherche éleveur corrigée : saisie continue d’un EDE complet sans perte de focus à chaque chiffre.
- Import historique étendu aux animaux 32/65.
- Camembert des causes de sortie ajouté au bilan.


## v1.2.2
- Historique initial complet embarqué en JSON : 193 éleveurs, 1 959 campagnes, 2 165 non négatifs, 1 004 descendants, 1 414 introductions.
- Restauration automatique au premier lancement de la version, plus bouton de restauration manuelle.
- Campagne active conservée sur 2025/2026.
- Correction des intitulés de colonnes lors d’un import Excel manuel.
- Recherche EDE sans rechargement à chaque chiffre et camembert des causes de sortie conservés.
