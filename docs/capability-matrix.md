# Matrice des capacités — Hermes Web Gateway 0.2.0

Mis à jour : 3 novembre 2026. « Implémenté » décrit le code présent, pas une validation réelle auprès d’un fournisseur.

| Capacité | État | Preuve et limites |
|---|---|---|
| Routeur API local | Implémenté | Endpoints OpenAI-compatible `/v1/models` et `/v1/chat/completions`; tests locaux avec profil Hermes temporaire. Aucun essai Hermes Desktop réel. |
| Utilisation sans clé API fournisseur | Architecture implémentée | Le navigateur dédié utilise les sessions de sites web connectées. Le bearer token de la passerelle est un secret local d’authentification, pas une clé API d’un fournisseur. Les comptes, quotas et politiques des sites s’appliquent. |
| Navigateur dédié sans extension | Implémenté | Playwright Core ouvre Chrome/Edge avec profil persistant isolé sous Hermes home. Login réel, démarrage sur chaque OS et compatibilité anti-automation non testés ici. |
| Fournisseurs web | 11 adapters présents | chatgpt-web, claude-web, deepseek-web, doubao-web, gemini-web, glm-web, glm-intl-web, kimi-web, qwen-cn-web, qwen-web, rakuten-web. Builders/adapters testés avec données synthétiques; aucun endpoint live validé. |
| Sessions | Gestion locale par profil browser | Le dashboard signale seulement des cookies indicateurs heuristiques. Un badge ne prouve pas l’authentification réelle; certains sites utilisent localStorage ou autres challenges. |
| Streaming texte | Implémenté dans le chemin OpenAI-compatible | Parseurs/adapters synthétiques et contrats HTTP testés. Aucun flux live fournisseur ni vrai client Hermes testé. |
| Appels d’outils Hermes | Traduction XML ↔ OpenAI `tool_calls` présente | Parseurs/tests synthétiques réutilisés. Pas encore validé qu’un vrai Hermes exécute une séquence tool call → résultat → continuation via ce gateway. |
| Annulation | Relais d’annulation vers la page en cours | Le handler de page peut recevoir `WEB_LLM_CANCEL`; couverture des handlers et propagation réelle fournisseur non vérifiées. |
| Modèles et health | Liste issue des modèles par défaut déclarés; `/health` local | Les noms/modèles peuvent changer côté site. Le health du gateway ne vérifie pas l’authentification fournisseur ni une génération. |
| Authentification locale | Loopback uniquement, bearer token, vérification Host et Origin sur actions de login | Tests HTTP négatifs/positifs et absence de secret dans les logs. Permissions Windows/ACL et audit sécurité indépendant non vérifiés. |
| Fonctionnalités Hermes hors inférence | Fournies par Hermes installé séparément | Le gateway n’implémente pas approvals, skills, tâches longues, pièces jointes, image, audio, mémoire Hermes ou exécution d’outils; il transporte seulement la requête/réponse de modèle. |
| Ancienne extension et Native Messaging | Conservées comme chemin legacy expérimental | Non nécessaires pour le gateway principal. Les deux routes ne doivent pas être confondues : extension/Native Messaging port 8765 vs gateway local port 20128. |

## Conditions de sortie de préversion

1. Tester installation du profil, lancement Chrome/Edge et persistance des sessions sur Windows, macOS et Linux annoncés.
2. Pour chaque fournisseur : login, état session expirée, génération réelle, streaming, erreurs, déconnexion et annulation.
3. Avec une vraie installation Hermes : charger le profil officiel, réaliser une génération non-streaming et streaming, vérifier un outil réellement appelé une seule fois puis une continuation à partir de son résultat.
4. Tester les requêtes longues, caractères Unicode, demandes parallèles, fermeture du navigateur pendant le streaming et redémarrage du gateway.
5. Vérifier la protection locale du profil de navigation et du fichier `.env`; effectuer une revue sécurité indépendante.
6. Documenter séparément les essais réels par fournisseur/OS. Ne pas extrapoler un succès d’un fournisseur aux autres.
7. Vérifier les politiques applicables de chaque site; ne pas contourner paywalls, quotas ou challenges.
