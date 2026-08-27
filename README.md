# Paratuberculose GDS 32-65 — v1.0.0

Application web/PWA locale-first pour le suivi de la paratuberculose bovine 32/65.

## Fonctions incluses

- Tableau de bord par campagne.
- Fichier unique des cheptels 32 + 65.
- Consultation par éleveur : situation actuelle + historique des campagnes.
- Import initial du classeur Excel historique V9.1.
- Imports bovins bruts 32 et 65.
- Imports analyses bruts 32 et 65, regroupés automatiquement par EDE et campagne.
- Gestion des statuts d'analyses : À TRAITER / POSITIF À TRAITER / TRAITÉ.
- Saisie individuelle manuelle des non négatifs.
- Consultation des descendants, introductions et animaux.
- Exports CSV : engagés, Garantie, Assainissement, par département, positifs, non négatifs présents, descendants, introductions et bilan annuel.
- Sauvegarde/restauration JSON complète.
- Synchronisation Supabase optionnelle.
- PWA installable et utilisable hors connexion après la première ouverture.

## Première utilisation

1. Publier le dossier sur GitHub Pages ou l'ouvrir via un petit serveur web local.
2. Aller dans **Imports** puis cliquer **Charger l’historique fourni**.
3. Le classeur V9.1 inclus dans le dossier est migré automatiquement.
4. Importer les fichiers bovins 32 et 65 les plus récents.
5. Au démarrage de la nouvelle campagne, importer séparément les analyses 32 et 65.

Le fichier d'analyses 65 fourni pendant la conception n'est pas préchargé : il servait uniquement d'exemple de structure.

## Déploiement GitHub Pages

Déposer le contenu du dossier à la racine du dépôt, puis activer **Settings > Pages > Deploy from branch** sur la branche `main`.

## Supabase

1. Exécuter `supabase.sql` dans l'éditeur SQL du projet.
2. Ouvrir **Paramètres** dans l'application.
3. Renseigner l'URL Supabase et la clé publique `anon`.
4. Utiliser **Envoyer vers Supabase** pour la première synchronisation.

La politique SQL fournie est volontairement simple pour un projet dédié. Pour un accès sécurisé multi-utilisateurs, ajouter Supabase Auth puis remplacer les politiques anon.

## Bibliothèque Excel

L'import XLSX initial utilise SheetJS 0.18.5 depuis jsDelivr. Une connexion Internet est donc nécessaire lors du premier import Excel si la bibliothèque n'est pas déjà en cache. Les imports CSV animaux/analyses ne dépendent d'aucune bibliothèque externe.
