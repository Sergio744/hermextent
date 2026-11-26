# Journal de validation

Date : 3 novembre 2026. Les essais ci-dessous ont été faits localement dans le workspace; ils n’établissent pas une validation de production.

## Hermes Web Gateway 0.2.0 — tests du routeur local

- Ajout d’un serveur Node OpenAI-compatible sur `127.0.0.1:20128`, d’un profil de session Playwright isolé et d’un dashboard localhost pour ouvrir les pages de login.
- `npm test` valide le build des fournisseurs, les 11 IDs, les builders/adapters déjà testés, l’authentification bearer locale, les routes models/health, la liste de fournisseurs et le refus d’une origine web étrangère sur `/api/login`. Les tests gateway utilisent un `$HERMES_HOME` temporaire et ne lancent pas de navigateur.
- Les 11 handlers/providers sont inclus dans le bundle Node/browser-context. Cela ne valide pas que la fonction injectée démarre sous la CSP actuelle d’un site ou que les protocoles privés acceptent les requêtes.
- **Aucun lancement Playwright réel, aucune connexion fournisseur, aucune génération réelle, aucun appel Hermes Desktop ni outil Hermes complet n’a été exécuté.** Le système demeure expérimental et les fournisseurs ne sont pas validés.
- Le profil peut utiliser `HERMEXTENT_BRIDGE_TOKEN` comme mot de passe local API; sa valeur n’est jamais affichée par l’installateur ni le serveur.

## Historique de l’architecture Chrome-extension

Les essais Chrome/Chromium et l’intégration Native Messaging ci-dessous concernent l’ancienne architecture conservée comme chemin legacy. Ils ne valident pas le nouveau routeur Playwright.

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

## Hermes Web Gateway 0.4.0 — jeton d’interface local

- Cause identifiée d’après un rapport utilisateur Windows : l’en-tête `Origin` n’arrivait pas au gateway (extension, proxy ou suite de sécurité), donc l’ouverture de session était refusée par un 403 trompeur.
- Correctif : l’interface locale porte un jeton aléatoire par processus, exposé dans une balise meta et envoyé en en-tête `X-Hermes-UI-Token`; un cookie `HttpOnly; SameSite=Strict` est également posé. Le contrôle d’origine ne s’applique plus que si l’en-tête est réellement présent.
- Vérifié automatiquement : jeton absent → 403 explicite; jeton valide sans `Origin` → la requête atteint la validation du fournisseur; `Origin` externe avec jeton valide → 403 et aucune fenêtre lancée; le jeton de passerelle n’apparaît jamais dans le HTML.
- Non vérifié : ouverture réelle du navigateur et connexion aux 11 fournisseurs (aucun Chrome/Edge dans l’environnement de test).

## Hermes Web Gateway 0.5.0 — réutilisation du profil réel

- Demande utilisateur : ouvrir les sites fournisseurs dans ses vraies sessions Chrome plutôt que dans un profil neuf.
- Implémentation : `--profile chrome|edge` (ou `HERMES_BROWSER_PROFILE`), nom de profil validé (`Default`/`Profile N`), copie de `Local State` + dossier de profil vers `.hermes/browser-sessions/profile-backup/<mode>`, lancement avec `--profile-directory`. Le profil réel n’est jamais modifié ni supprimé.
- Messages d’erreur ajoutés : verrou de profil en cours d’utilisation, chemin de profil invalide, binaire navigateur introuvable.
- Vérifié automatiquement : résolution des trois modes, refus d’un nom de profil piégeux, copie réelle d’un faux profil Chrome (cookies présents dans la copie, source intacte), refus d’écrire dans le dossier navigateur d’origine, `/health` expose le profil effectif, dashboard et jeton anti-CSRF inchangés.
- Non vérifié : ouverture effective de Chrome/Edge avec un vrai profil (aucun navigateur dans l’environnement), comportement d’un profil verrouillé par une instance réellement active, validité des cookies copiés sur les sites fournisseurs.
- Limite documentée : Chrome lancé sans indicateur d’automatisation n’expose aucun canal de contrôle; le gateway ne peut pas s’attacher à une fenêtre déjà ouverte.
