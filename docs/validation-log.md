# Journal de validation

Date : 3 novembre 2026. Les essais ci-dessous ont été faits localement dans le workspace; ils n’établissent pas une validation de production.

## Hermes Agent — découverte du plugin

- Source officielle : `NousResearch/hermes-agent`, commit `c314285f077e91937c995d419b9fa40af9eb4981`.
- Le checkout de recherche était en sparse-checkout sans `pm/` et `hermes_platform/`; ces chemins ont été restaurés dans le checkout ignoré `.research/hermes-agent`.
- `ruamel.yaml==0.18.16` a été installé dans un venv temporaire de validation (pas dans les dépendances du produit).
- `companion/install.py` a installé le plugin dans un `$HERMES_HOME` temporaire; `providers.get_provider_profile()` du vrai code Hermes a découvert `hermes-browser` et son alias `hermes-web`.
- Profil obtenu : `ProviderProfile(name='hermes-browser', api_mode='chat_completions', base_url='http://127.0.0.1:8765/v1', auth_type='api_key', supports_streaming=True, supports_model_listing=False, supports_health_check=False, env_vars=('HERMEXTENT_BRIDGE_TOKEN',))`.
- Le profil temporaire et la registration Native Messaging de test ont été désinstallés après l’essai. Ceci valide la découverte du plugin, pas le démarrage du runtime/API Hermes ni une génération réelle.

## Chrome/Chromium

- `@sparticuz/chromium@153.0.0` et `playwright-core@1.64.1` ont été installés sous `/tmp` uniquement. Le binaire serveur est headless; `al2023.tar.br` contient les bibliothèques NSS/NSPR nécessaires, ajoutées temporairement via `LD_LIBRARY_PATH`.
- Le headless shell démarre (Chromium 153), mais `chrome://extensions` est inaccessible, aucun service worker d’extension n’apparaît et le chargement de l’extension MV3 n’est pas disponible dans ce shell. Native Messaging et le vrai side panel ne peuvent donc pas être exercés.
- Un smoke test UI séparé a chargé le HTML/CSS/JS du panneau dans Chromium avec une API `chrome.*` simulée : rendu d’un delta SSE, mémorisation des en-têtes de session et envoi du message d’annulation réussis. Ce test vérifie le code UI/DOM seulement; ce n’est pas un essai d’extension Chrome installée.

## Fournisseurs

- Les 11 builders sont testés avec des cookies/jetons factices et construisent des requêtes HTTPS.
- Aucun cookie/session réel, défi antibot, endpoint en direct, flux de tokens ou appel d’outil n’a été testé auprès d’un fournisseur. La compatibilité est **non vérifiée**.

## Suite requise

1. Environnement Chrome supporté avec `libnspr4`/`libnss3` et chargement MV3 activé.
2. Hermes Agent réellement installé/démarré avec son API locale, authentification et session persistante.
3. Essais de streaming, tool calls, refus/approbations, annulation et reprise de session.
4. Matrice par fournisseur et par OS, avec compte autorisé et protocole réel daté.
