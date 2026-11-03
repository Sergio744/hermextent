# Notices des composants amont

## ChromeClaw — fournisseur web

- Source : <https://github.com/algopian/chromeclaw>
- Révision étudiée : `633fa6ffd5f09c0dd6ce0b25e53a38ba6f3b44b5`
- Licence : MIT ; copyright `2025 Algopian1@gmail.com`.
- Modules repris/adaptés : définitions et stratégies de fournisseurs web, adaptateurs de flux, analyseurs SSE/XML et handlers de fetch de page sous `extension/src/background/web-providers/`.
- Texte intégral de l’avis : `extension/src/background/web-providers/UPSTREAM-LICENSE`.

## Hermes Agent — runtime et extension de fournisseur

- Source : <https://github.com/NousResearch/hermes-agent>
- Révision étudiée : `c314285f077e91937c995d419b9fa40af9eb4981`.
- Licence : MIT ; copyright `2025 Nous Research`.
- Le plugin `plugins/model-providers/hermes-browser/` utilise le point d’extension public `ProviderProfile` documenté par Hermes. L’extension n’embarque pas une copie du runtime Hermes ; l’utilisateur installe ce dernier séparément.
- Le texte intégral de l’avis MIT Hermes est redistribué dans `third_party/HERMES-AGENT-LICENSE` et inclus dans les deux archives.
