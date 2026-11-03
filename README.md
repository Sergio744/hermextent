# Hermes Browser

Extension Chrome MV3 + compagnon **Chrome Native Messaging** pour piloter le runtime officiel Hermes Agent. Le compagnon fournit une passerelle OpenAI-compatible authentifiée vers les modèles web et relaie l’API Hermes sans que le JavaScript de l’extension n’appelle `localhost` directement.

> **État : préversion empaquetable, non validée pour la production.** Le panneau, les 11 adaptateurs issus de ChromeClaw, le pont natif, la passerelle Hermes, l’annulation des générations et des archives d’installation sont présents. Les requêtes de chaque adaptateur sont vérifiées statiquement et les tests automatisés passent; aucun fournisseur, navigateur ni cycle Hermes complet n’a encore été validé en conditions réelles. Ne pas considérer les fournisseurs comme opérationnels sans essai sur leurs sessions web actuelles.

## Architecture du prototype

```text
Extension Chrome (side panel + service worker)
  ├─ Hermes API (/v1/chat/completions, port natif)
  └─ événements fournisseur web ← Native Messaging
          ↑                                   ↓
    Hermes Agent ← OpenAI Chat Completions → compagnon local
                           127.0.0.1:8765/v1
```

Le runtime Hermes reste responsable de son agent et de ses outils. Le profil `hermes-browser` pointe vers le relais local ; son modèle s’écrit `gemini-web:<model-id>` ou avec l’un des dix autres identifiants. L’extension fait la génération dans un onglet déjà connecté et restitue texte/appels d’outils au format OpenAI Chat Completions.

Les identifiants ciblés sont `chatgpt-web`, `claude-web`, `deepseek-web`, `doubao-web`, `gemini-web`, `glm-web`, `glm-intl-web`, `kimi-web`, `qwen-cn-web`, `qwen-web` et `rakuten-web`. Les schémas/adaptateurs sont importés de ChromeClaw et sa notice MIT est conservée. Les sites utilisent des protocoles web non contractuels, susceptibles de changer.

## Prérequis du prototype

- Chrome 116 ou plus récent, profil utilisateur connecté chez le fournisseur web.
- Python 3.11+.
- Hermes Agent installé et son API serveur activée sur `127.0.0.1:8642`, avec `API_SERVER_KEY`.
- Node.js 22+ pour construire l’extension.

## Construire

```sh
npm ci
npm run check
npm run package
```

`npm run package` exécute tous les contrôles puis crée `release/hermes-browser-chrome-0.1.0.zip` (archive Chrome, manifeste à la racine) et `release/hermes-browser-companion-0.1.0.zip` (compagnon, plugin Hermes et instructions). Ces archives sont générées localement et ignorées par Git. Les bundles de `extension/dist/` sont toutefois suivis dans Git afin que l’archive **Code → Download ZIP** soit directement chargeable. Après modification du code, reconstruire avec `npm ci && npm run build`. Dans `chrome://extensions`, activer le mode développeur, choisir **Charger l’extension non empaquetée** et sélectionner `extension/` (ou le dossier `extension/` de l’archive Chrome). Copier l’identifiant Chrome affiché, puis enregistrer le compagnon :

```sh
python companion/install.py --extension-id <32-caracteres-id-chrome>
```

`--browser chromium` et `--browser brave` sélectionnent leurs répertoires Native Messaging. L’installateur installe le profil Hermes sous `$HERMES_HOME/plugins/model-providers/hermes-browser`, crée un secret aléatoire dans `$HERMES_HOME/.env` avec permissions restreintes et enregistre le Native Messaging host. Redémarrer Hermes après installation. Ouvrir le side panel pour lancer le compagnon. Pour désenregistrer Native Messaging : `python companion/uninstall.py --browser chrome`; ajouter `--remove-plugin --remove-token` pour nettoyer uniquement les fichiers du plugin identiques à ceux livrés et la variable dédiée, en préservant les personnalisations et le reste de `.env`.

Configurer Hermes (exemple) :

```yaml
model:
  provider: hermes-browser
  model: gemini-web:gemini-3-flash
```

Le nom de modèle dépend du site et peut changer. Il est aussi sélectionnable depuis les réglages de l’extension. Activer/configurer au préalable `API_SERVER_ENABLED`, `API_SERVER_PORT=8642` et `API_SERVER_KEY` dans le profil Hermes. Le side panel passe cette clé par Native Messaging et mémorise `X-Hermes-Session-Id` ainsi que `X-Hermes-Session-Key` retournés par Hermes pour reprendre la session et son périmètre de mémoire.

## Modèle de sécurité

- L’extension ne fait que communiquer avec le compagnon par l’API Native Messaging de Chrome ; elle n’envoie pas de requête HTTP à `localhost`.
- Le relais HTTP du compagnon écoute uniquement sur `127.0.0.1:8765`, refuse les requêtes non loopback et protège les générations par `HERMEXTENT_BRIDGE_TOKEN` (généré dans `.env` Hermes).
- L’hôte Native Messaging n’accepte que l’origine de l’extension indiquée lors de l’installation. Le token de l’API Hermes est conservé dans le stockage local de l’extension ; il ne doit pas être partagé.
- La permission Chrome `cookies` et les accès hôtes sont nécessaires aux intégrations des fournisseurs. Le code récupéré des sessions web est sensible ; ne charge l’extension que depuis une source de confiance.
- L’API Hermes inclut des outils puissants comme le terminal. Garder l’API liée à la boucle locale, son bearer key secret, et ne pas exposer son port sur le réseau.
- Le relais n’est pas un endpoint public, un proxy général ou un mécanisme de contournement des quotas. Les politiques, abonnements et limites des services fournisseurs s’appliquent.

## Capacités et limites par fonction

Voir [la matrice de capacité](docs/capability-matrix.md) : elle distingue le code présent, les tests synthétiques et les essais réels manquants, et maintient explicites les fonctions Hermes qui ne sont pas encore exposées dans le panneau.

## Tests et limites actuelles

`npm test` vérifie les 11 builders HTTPS, les adaptateurs/parsers, les appels d’outils structurés, le réassemblage de frames Native Messaging, le cycle CLI installation/mise à jour/désinstallation dans un profil temporaire, la préservation des fichiers personnalisés et l’annulation. Le relais Python est testé pour l’authentification, le streaming SSE, les redirections non-loopback, la limite de concurrence et les grands messages segmentés. `npm run check` ajoute build, TypeScript et audit npm; `npm run package` produit ensuite les deux archives.

**Pas encore validé en conditions réelles :** aucun fournisseur avec compte connecté, aucune session Chrome réelle et aucun cycle de génération Hermes complet n’ont été exécutés ici. La découverte du plugin par le code officiel Hermes (`providers.get_provider_profile`) a maintenant réussi après installation dans un profil temporaire, y compris l’alias `hermes-web`; cela ne valide pas le runtime/API Hermes au complet. Un headless shell Chromium temporaire démarre; le HTML/CSS/JS du panneau a passé un smoke test avec `chrome.*` simulé, mais ce shell ne charge pas les extensions MV3 (pas de service worker, Native Messaging ni vrai side panel). Le test des builders ne prouve ni que l’authentification marche, ni que les endpoints privés sont encore compatibles. L’annulation est implémentée jusqu’au fetch du site, mais reste à vérifier dans un navigateur fonctionnel. Les protocoles peuvent évoluer, et certaines pages peuvent imposer des challenges ou des modalités non capturées par les tests.

Avant de déclarer la production : lancer la matrice Chrome/OS, vérifier le chargement du plugin dans une installation Hermes complète, exécuter des générations streaming et non-streaming ainsi que des outils/annulations, valider authentification et reprise de session, tester installation/upgrade/désinstallation sur Windows/macOS/Linux, puis publier une matrice réelle des capacités par fournisseur. Hermes doit être installé séparément; l’archive ne l’inclut pas.
