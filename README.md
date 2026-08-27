# Paratuberculose GDS 32-65 - v1.1.0

Application PWA de suivi de la paratuberculose bovine.

## Navigation simplifiée

- **À traiter** : file priorisée des résultats de la campagne, positifs en premier.
- **Campagne** : tous les engagés avec résultat reçu / non reçu, statut et proposition N+1.
- **Éleveurs** : recherche puis dossier complet avec situation, analyses, non négatifs, descendants, animaux et historique.
- **Imports** : historique initial, bovins 32/65, analyses 32/65.
- **Exports** : listes d'engagés, Garantie/Assainissement, bovins et suivi campagne.
- **Bilan & récap** : indicateurs et graphiques de campagne.
- **Paramètres** : campagne active, sauvegardes et Supabase.

## Référentiel intelligent

Le moteur propose une gestion à partir de :

- protocole et ancienneté lorsqu'ils sont connus ;
- qualification actuelle ;
- effectif dépisté et nombre de positifs ;
- seuils de résultats non négatifs (1 / 2 / 3 selon l'effectif) ;
- résultat PCR saisi lors du traitement du dossier.

Il affiche la **qualification proposée**, le **dépistage N+1 proposé**, les actions à faire et le **cas du référentiel** utilisé. La proposition reste à valider par le gestionnaire.

Référentiels intégrés dans `referentiel/` :

- *Paratuberculose bovine - Référentiel pour un statut favorable*, version 3, novembre 2025.
- *Gestion des résultats non négatifs*, version 2, novembre 2025.

## Correction v1.1.0

La fenêtre fantôme qui bloquait l'écran au démarrage est corrigée (`.modal[hidden]`).

## Migration

Le classeur `migration/Suivi_Paratuberculose_32_65_V9_1_final_sans_analyses.xlsx` sert à charger l'historique existant.
