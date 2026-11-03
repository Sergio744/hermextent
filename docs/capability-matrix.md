# Matrice de capacité — Hermes Browser 0.1.0

Dernière mise à jour : 3 novembre 2026. « Implémenté » signifie présent dans le code; « test synthétique » n’équivaut jamais à une validation en conditions réelles.

| Capacité | État dans 0.1.0 | Preuve actuelle / limite |
|---|---|---|
| Runtime et exécution des outils Hermes | Hermes Agent reste le runtime; le panneau utilise son API locale. Le relais convertit des tool calls web en format OpenAI pour que Hermes les exécute. | Parsers et contrat du relais testés synthétiquement; aucun vrai tour d’outil avec Hermes n’a été exécuté ici. |
| Fournisseurs web « 0 token API » | Les 11 adaptateurs ChromeClaw sont intégrés et sélectionnables. | Chaque builder construit une requête HTTPS avec une session factice; aucune session connectée ni génération réelle validée. Quotas, abonnements et règles fournisseurs restent applicables. |
| Texte et flux | Chat texte, streaming SSE et erreurs. | Formats du relais testés localement; panneau rendu dans Chromium headless avec `chrome.*` simulé. Aucun vrai service worker, extension installée ou Hermes réel. |
| Sessions Hermes | `X-Hermes-Session-Id` et `X-Hermes-Session-Key` sont conservés et relayés. | En-têtes testés par doubles HTTP; reprise de session réelle non vérifiée. |
| Annulation | Bouton d’arrêt, fermeture du client HTTP, annulation du relais et signal AbortController vers l’endpoint web. Les requêtes vers le même site sont sérialisées pour éviter les collisions du hook `fetch`. | Tests par unité et disconnect HTTP; propagation dans Chrome et auprès de chaque fournisseur non vérifiée. |
| Authentification des sessions web | Lecture heuristique des cookies; les hooks de rafraîchissement présents dans les plugins sont appelés quand disponibles. | Les badges indiquent un indice de session, pas un compte validé. Certains fournisseurs conservent leurs jetons en localStorage ou utilisent des challenges privés. |
| Approbations sensibles / demandes d’autorisation | Pas d’interface dédiée au panneau. | Utiliser le flux Hermes CLI/Gateway tant qu’une surface d’approbation navigateur n’a pas été conçue et testée. |
| Tâches longues / notifications / exécutions en arrière-plan | Non exposées par le side panel 0.1.0. | Restent dans les surfaces Hermes existantes; aucun faux support revendiqué. |
| Fichiers, pièces jointes, images, audio/voix | Le compositeur 0.1.0 ne prend en charge que du texte. | Non exposés ni testés dans le panneau. |
| Gestion des skills, profils, toolsets et configurations Hermes | Pas d’éditeur dans l’extension. | Le runtime Hermes installé séparément reste l’autorité; configuration via ses outils/CLI. |
| Installation Chrome + compagnon | Archives zip, manifeste MV3, hôte Python, installateur et désinstalleur. | Cycle CLI d’installation/mise à jour/désinstallation testé sur Linux temporaire; plugin découvert par le `providers.get_provider_profile` Hermes officiel et alias vérifié. Windows/macOS, serveur Hermes réel et chargement Chrome restent à tester. |
| Sécurité locale | Native Messaging, hôte loopback, bearer token aléatoire, validation des URLs/redirects Hermes, limite de concurrence. | Tests unitaires; audit système complet, vérification de permissions en vrai navigateur et revue sécurité indépendante non réalisés. |

## Critères de sortie de préversion

1. Charger l’extension et installer le compagnon dans une installation Hermes supportée sur chaque OS annoncé.
2. Valider plugin/profile discovery via l’installation Hermes complète, sans stubs.
3. Pour chaque fournisseur : login, session expirée/rafraîchie, vraie génération, streaming, erreur réseau et annulation.
4. Avec Hermes réel : reprendre une session, faire exécuter puis retourner un outil et vérifier que l’appel n’est exécuté qu’une fois; tester également outils refusés/approbations.
5. Tester messages longs, caractères Unicode, demandes parallèles, fermeture de panneau et redémarrage du service worker.
6. Vérifier permissions Chrome, stockage des clés, scénario de désinstallation et politiques de chaque fournisseur; publier le résultat par OS/fournisseur.
7. Décider explicitement quels parcours Hermes supplémentaires (images, pièces jointes, tâches, approvals, skills) seront livrés dans l’extension et lesquels resteront dans le CLI/Gateway.
