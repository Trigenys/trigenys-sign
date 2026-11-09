## 2026-11-09 09:12 — Création de trigenys-sign (backend + front + tests + docs)

- État : app complète (magic link, upload PDF, signataires, clés Ed25519 navigateur, signature animée,
  vérification, PDF final), 11/11 tests `npm test` verts, README / CLAUDE.md / Dockerfile / compose / deploy/README.md écrits.
- Notify : e-mail via route standard ; WhatsApp individuel dépend d'une route dédiée `whatsapp-direct`
  à ajouter dans `Trigenys/trigenys-notify` (session séparée, branche `whatsapp-direct-dispatch`, PR à ouvrir).
- Reste : déploiement VPS (DNS sign.trigenys.com, Caddy, clés Notify dans .env), dépôt git à initialiser et pousser.
- Décisions : pas de framework, SQLite `node:sqlite`, clés non exportables (perte = nouvelle clé, anciennes conservées),
  cadre signature simple/avancée (non qualifiée).
