# Faisabilité — Hermes Agent dans le navigateur

**État de l’étude :** 3 novembre 2026
**Décision d’architecture retenue :** extension Chrome + compagnon Hermes local
**Fournisseurs web demandés :** les 11 connecteurs présents dans ChromeClaw, intégrés progressivement

## Conclusion

**Oui, le projet est faisable avec le périmètre choisi**, à condition de conserver Hermes comme runtime Python local et de construire une extension qui lui sert d’interface. Une extension seule ne peut pas raisonnablement fournir la parité avec les fonctions Hermes qui dépendent d’un processus Python, d’outils système, de tâches persistantes ou de services d’arrière-plan.

Il faut distinguer deux fonctions complémentaires :

1. **Hermes local** conserve l’orchestration de l’agent et ses capacités : outils, exécution et approbations, mémoire, skills, MCP, sous-agents, planification et intégrations de passerelle.
2. **L’extension** fournit l’interface navigateur, la gestion des sessions de conversation et un pont vers les modèles web utilisant la session déjà ouverte dans le navigateur. Pour ces modèles, elle doit retransmettre le texte et les appels d’outils vers Hermes afin que ce soit Hermes — et non une deuxième boucle d’agent indépendante — qui exécute les outils.

La zone la plus risquée n’est donc pas le panneau de chat : c’est le **pont bidirectionnel d’inférence** entre le runtime Hermes et le contexte navigateur. Le serveur API Hermes sait déjà recevoir des clients HTTP/SSE, mais l’étude n’a pas établi qu’il sait, sans adaptation, déléguer une génération à une extension Chrome connectée. Ce relais devra être conçu et testé avant de promettre que les 11 fournisseurs fonctionnent de bout en bout.

## Ce que REA a confirmé dans ChromeClaw

### Méthode et portée

Le code étudié est le dépôt `algopian/chromeclaw`, checkout du commit `633fa6ffd5f09c0dd6ce0b25e53a38ba6f3b44b5` (version déclarée 2.3.0). REA (`rea-agents` 6.8.0) a analysé statiquement **63 fichiers ciblés** de `chrome-extension/src/background/web-providers/` et du pont d’agent : 431 830 octets lus, 41 343 nœuds AST visités, 544 constats et aucune erreur d’analyse syntaxique sur les fichiers sélectionnés. Le bundle de preuve est dans `.research/chromeclaw-rea-evidence.json`.

REA a ensuite tracé `requestWebGeneration` : deux correspondances initiales, 2 343 nœuds et 2 397 arêtes dans un graphe de couverture **partielle**. Ce résultat sert de carte statique, pas de preuve d’exécution. 931 fichiers n’étaient pas examinés pour cette sélection ; REA indique explicitement que les relations vers ces fichiers restent inconnues. Le marqueur littéral `WEB_LLM_FETCH` n’a pas donné de correspondance dans le graphe retenu : ce résultat négatif n’établit pas l’absence du mécanisme. Le flux ci-dessous a donc aussi été vérifié directement dans les sources et la documentation du dépôt.

### Architecture utile à réutiliser

Dans `chrome-extension/src/background/agents/stream-bridge.ts`, ChromeClaw route les appels vers le fournisseur cloud, un modèle local ou `requestWebGeneration()`. Les trois branches renvoient le même type de flux d’événements d’assistant : le reste de la boucle d’agent n’a donc pas besoin de connaître le protocole particulier du fournisseur web.

Le pont web (`web-providers/web-llm-bridge.ts`) suit essentiellement ce chemin :

1. résolution du fournisseur, de sa stratégie d’outils et de ses identifiants de conversation ;
2. préparation des messages, des instructions système et des outils ;
3. sélection ou ouverture d’un onglet sur le site du fournisseur ;
4. injection d’un relais en monde isolé et du `fetch` fournisseur en monde `MAIN` ;
5. utilisation de la session du navigateur pour la requête web ;
6. décodage du flux (SSE ou protocole binaire), extraction des deltas, normalisation du raisonnement et du texte ;
7. interprétation des appels d’outils sérialisés dans le texte, puis émission des événements attendus par la boucle d’agent.

Le contrat commun est défini dans `web-providers/types.ts` et `plugin-types.ts` : identité et état de connexion, URL/domaine de connexion, préparation des requêtes, analyse des fragments, rafraîchissement éventuel de session, adaptateur de flux et stratégie d’outils. Les fichiers `providers/*.plugin.ts` enregistrent les connecteurs ; le registre contient :

- Gemini, ChatGPT, Claude
- DeepSeek, Doubao, Kimi
- Qwen, Qwen CN
- GLM, GLM Intl
- Rakuten

Ce sont des intégrations aux protocoles web observés par le projet, pas des API publiques garanties par les fournisseurs. Leur stabilité, leur disponibilité et leur conformité aux conditions d’utilisation doivent être vérifiées séparément. Les sites peuvent modifier leurs protocoles et bloquer les automatisations.

### Sens de « 0 token »

Ici, cela désigne l’utilisation d’une **session web déjà ouverte** plutôt que l’envoi d’une clé API facturée au token par l’extension. Cela ne signifie pas : absence de tokens de contexte, génération illimitée, absence de quotas, ni gratuité garantie par le fournisseur. Limites de compte, abonnement, disponibilité, règles d’usage et changements de site continuent de s’appliquer. Il faut présenter cet état à l’utilisateur comme « session web », pas afficher une consommation API artificiellement fiable.

## Compatibilité Hermes

Le dépôt officiel `NousResearch/hermes-agent`, checkout du commit `c314285f077e91937c995d419b9fa40af9eb4981`, est un agent Python (`requires-python >=3.11,<3.15`), pas un frontend navigateur. Son architecture comprend notamment :

- un agent et une boucle d’outils qui restent dans le runtime ;
- des transports modèle (Chat Completions, Responses/Codex, Anthropic, Bedrock) ;
- des profils et plugins de fournisseurs (`providers/base.py`, `providers/__init__.py`) ;
- un serveur API documenté avec Chat Completions, Responses, exécutions longues et événements SSE, arrêt, approbation et clarification ;
- des routes de sessions, de tâches planifiées, de capacités, de skills et de toolsets.

La documentation Hermes précise que son API peut conserver outils, skills et mémoire tout en acceptant des instructions d’un client. Elle avertit aussi que l’API peut donner accès à des outils sensibles, notamment au terminal : authentification obligatoire, accès réseau restreint et consentement explicite sont indispensables.

### Point d’intégration recommandé

Ajouter au runtime Hermes un **fournisseur de session web** ou un transport compatible avec ses interfaces existantes. Ce fournisseur ne doit pas tenter d’ouvrir les cookies ou les onglets depuis Python. Il doit demander une génération au relais navigateur, recevoir le flux et le convertir dans le format attendu par Hermes. Hermes reste responsable de la décision et de l’exécution des appels d’outils.

L’extension maintient une connexion authentifiée au compagnon et effectue le trafic fournisseur depuis un onglet de ce fournisseur. Le compagnon transmet une requête de génération au navigateur connecté ; le navigateur renvoie les fragments et les éventuels appels d’outils. Il faudra décider si ce canal est ajouté à l’API Hermes ou fourni par un petit service compagnon dédié. **Le pont WebSocket/HTTP de génération n’existe pas encore dans ce dépôt : c’est un travail d’intégration, pas une fonction déjà acquise de l’API Hermes.**

Cette séparation évite deux erreurs : tenter de porter en JavaScript le runtime complet de Hermes dans une extension, ou faire fonctionner le chat « 0 token » dans une boucle parallèle qui perdrait les outils, la mémoire et la gestion des sessions Hermes.

## Plan d’implémentation proposé

### Jalon 1 — socle et contrat d’intégration

- Décider la distribution du compagnon (installation Python/paquet Hermes, configuration et démarrage), ainsi que le protocole local extension–compagnon.
- Définir l’authentification du compagnon, les origines autorisées, la reconnexion et l’isolation par session/profil.
- Définir un contrat de streaming qui préserve texte, raisonnement si disponible, appels d’outils, erreurs, annulation, approbations et métadonnées.
- Ajouter un fournisseur Hermes de développement et un relais navigateur simulé, afin de tester la boucle sans dépendre d’un site tiers.

### Jalon 2 — extension et boucle Hermes

- Construire le panneau latéral et les vues de sessions ; consommer les événements SSE de Hermes et prendre en charge l’arrêt, les erreurs et les décisions d’approbation.
- Vérifier avec un fournisseur API ordinaire que les outils sont exécutés par Hermes et que la mémoire/session survivent aux tours.
- Connecter le fournisseur web de bout en bout pour un seul site ; valider qu’un appel d’outil émis par le modèle revient à Hermes, s’exécute une seule fois et reprend correctement le flux.

### Jalon 3 — portage progressif des 11 connecteurs

Réutiliser la conception et les tests de chaque plugin ChromeClaw, mais adapter les types et le flux à Hermes au lieu de copier la boucle d’agent de ChromeClaw. Ajouter des tests par fournisseur pour l’authentification, l’expiration, le décodage en flux, le raisonnement, les outils, les erreurs, l’annulation et les changements de protocole. La liste complète visée est celle ci-dessus ; « progressivement » signifie que l’intégration complète sera livrée après le jalon de validation, pas que les 11 seront réputés compatibles au premier prototype.

### Jalon 4 — couverture fonctionnelle Hermes

Relier et tester dans l’extension les fonctionnalités exposées par l’API Hermes (sessions, exécutions longues, événements, outils, approbations, tâches, skills, capacités/toolsets, profils selon prise en charge). Maintenir les services d’arrière-plan et les intégrations de passerelle dans le compagnon, là où Hermes les exécute déjà. Publier une matrice indiquant pour chaque fonction : prise en charge par Hermes, exposée dans l’extension, testée de bout en bout, ou limitée au compagnon/CLI.

## Critères d’acceptation à conserver

- L’agent, l’exécution des outils et la gestion de leurs résultats restent ceux de Hermes, pas une réimplémentation parallèle.
- L’extension se connecte au compagnon de manière authentifiée et explicite ; aucune exposition publique du serveur Hermes par défaut.
- Les sessions, flux, erreurs, annulations et demandes d’approbation sont correctement propagés dans les deux sens.
- Les outils Hermes sont appelables lorsque le modèle sélectionné est un fournisseur web et leurs résultats sont repris dans la conversation.
- Les 11 fournisseurs ChromeClaw sont évalués et intégrés un par un avec des tests ; l’état réel de chaque fournisseur est visible à l’utilisateur.
- Les fonctions non accessibles dans l’API navigateur restent disponibles dans le compagnon, avec leurs limites documentées ; aucune promesse de parité du CLI dans le navigateur sans preuve de test.
- « 0 token » n’est jamais présenté comme gratuité ou absence de limites garantie.
- Les notices MIT et droits d’auteur des deux projets sont conservés dans les parties redistribuées.

## Sources locales vérifiées

### ChromeClaw

- [Dépôt amont](https://github.com/algopian/chromeclaw), commit `633fa6ffd5f09c0dd6ce0b25e53a38ba6f3b44b5`, licence MIT (copyright 2025 Algopian1@gmail.com).
- `docs/web-zero-token.md`
- `chrome-extension/src/background/agents/stream-bridge.ts`
- `chrome-extension/src/background/web-providers/web-llm-bridge.ts`
- `chrome-extension/src/background/web-providers/content-fetch-main.ts` et `content-fetch-relay.ts`
- `chrome-extension/src/background/web-providers/types.ts`, `plugin-types.ts`, `plugin-registry.ts`, `providers/*.plugin.ts`
- Preuve d’analyse statique REA : `.research/chromeclaw-rea-evidence.json` (fichier ignoré par Git).

### Hermes Agent

- [Dépôt officiel NousResearch](https://github.com/NousResearch/hermes-agent), commit `c314285f077e91937c995d419b9fa40af9eb4981`, licence MIT (copyright 2025 Nous Research).
- `providers/base.py`, `providers/__init__.py`, `agent/transports/`
- `website/docs/developer-guide/model-provider-plugin.md`
- `website/docs/user-guide/features/api-server.md`
- `README.md` et `pyproject.toml`

## État du dépôt de travail — 3 novembre 2026

Le dépôt contient maintenant le prototype vertical MV3, le compagnon Native Messaging/Python, le profil public `ProviderProfile`, le panneau latéral et les 11 adaptateurs ciblés. Build/typecheck/tests et audit npm passent; deux archives d’installation sont générées par `npm run package`. Le pont inclut sessions, streaming, relais d’outils et propagation de l’annulation, mais ceux-ci ne remplacent pas les tests e2e.

**Pas de validation production :** la découverte du plugin par le code officiel Hermes (`providers.get_provider_profile`) réussit sur un profil temporaire, y compris l’alias `hermes-web`; le serveur/runtime Hermes complet n’a pas été lancé. Aucun fournisseur connecté n’a été essayé. Un Chromium temporaire a été tenté, mais le binaire échoue au démarrage faute de `libnspr4.so`. Prochaine phase : fournir ou installer les bibliothèques système nécessaires, exécuter les parcours Chrome/OS réels et valider fournisseurs, outils, annulation, sessions et upgrade/désinstallation. Les sources amont et preuves REA restent sous `.research/`, ignorées par Git. Les choix maintenus sont **compagnon local accepté, les 11 fournisseurs visés, livraison progressive**, sans garantie de gratuité ni de compatibilité tant que les tests ne la prouvent pas.
