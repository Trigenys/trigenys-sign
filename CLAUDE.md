# trigenys-sign

Signature électronique interne Trigenys (PDF, signataires multiples, clés Ed25519 navigateur).

- Stack : Node ≥ 24 + TypeScript ESM (NodeNext), `node:http`, `node:sqlite`, `pdf-lib`, front statique `web/`.
- Build : `npm run check` (types), `npm test` (node:test, sortie dans `dist/`), `npm run dev`.
- Structure : `src/config.ts` (env), `src/db.ts` (schéma SQLite), `src/crypto.ts` (Ed25519, JSON canonique),
  `src/service.ts` (logique métier), `src/server.ts` (routes), `src/notify.ts` (client Trigenys Notify V1),
  `src/pdf.ts` (feuille de signatures), `src/messages.ts` (textes FR), `web/` (pages, `keys.js`, `pad.js`).
- Contrat à ne pas casser : `canonicalJson` et `keyFingerprint` sont dupliqués dans `web/keys.js` ; toute
  modification doit être faite des deux côtés et couverte par `test/crypto.test.ts`.
- Notifications : jamais d'adresse ou de numéro en clair dans les logs (`maskRecipient`). Sans clé Notify,
  mode console.
- Couleurs : navy `#102f52`, orange `#e07520`, off-white `#f7f7f2` (surchargeables via `BRAND_*`).
- Passation : `PASSATION.md` en ajout seulement.
