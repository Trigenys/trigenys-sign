## 2026-11-09 09:12 — Création de trigenys-sign (backend + front + tests + docs)

- État : app complète (magic link, upload PDF, signataires, clés Ed25519 navigateur, signature animée,
  vérification, PDF final), 11/11 tests `npm test` verts, README / CLAUDE.md / Dockerfile / compose / deploy/README.md écrits.
- Notify : e-mail via route standard ; WhatsApp individuel dépend d'une route dédiée `whatsapp-direct`
  à ajouter dans `Trigenys/trigenys-notify` (session séparée, branche `whatsapp-direct-dispatch`, PR à ouvrir).
- Reste : déploiement VPS (DNS sign.trigenys.com, Caddy, clés Notify dans .env), dépôt git à initialiser et pousser.
- Décisions : pas de framework, SQLite `node:sqlite`, clés non exportables (perte = nouvelle clé, anciennes conservées),
  cadre signature simple/avancée (non qualifiée).

##  — Dépôt public créé

- Dépôt : https://github.com/Trigenys/trigenys-sign (public, branche `main`, commit initial `bb2fea2`).
- IP du VPS remplacée par `<ip-du-vps>` dans `deploy/README.md` (dépôt public).
- Identité git locale : EagleFox31 (noreply). Session Notify `whatsapp-direct` en cours (PR à venir).
- Prochaine étape : déploiement VPS (DNS, Caddy, clés Notify), puis brancher la clé WhatsApp quand la route est déployée.
