# trigenys-sign

Signature électronique interne Trigenys (PDF, signataires multiples, clés Ed25519 navigateur).

- Stack : Node ≥ 24 + TypeScript ESM (NodeNext), `node:http`, `node:sqlite`, `pdf-lib`, front statique `web/`.
- Build : `npm run check` (types), `npm test` (node:test, sortie dans `dist/`), `npm run dev`.
- Structure : `src/config.ts` (env), `src/db.ts` (schéma SQLite), `src/crypto.ts` (Ed25519, JSON canonique),
  `src/service.ts` (logique métier), `src/server.ts` (routes), `src/notify.ts` (client Trigenys Notify V1),
  `src/pdf.ts` (incrustation des signatures dans leurs zones + feuille de signatures ; `parseField`), `src/messages.ts` (textes FR), `web/` (pages, `keys.js`, `pad.js`, `assets/logo.png` logo Trigenys Group repris de www.trigenys.com, utilisé par les pages, les e-mails et le PDF).
- Contrat à ne pas casser : `canonicalJson` et `keyFingerprint` sont dupliqués dans `web/keys.js` ; toute
  modification doit être faite des deux côtés et couverte par `test/crypto.test.ts`.
- Notifications : jamais d'adresse ou de numéro en clair dans les logs (`maskRecipient`). Sans clé Notify,
  mode console.
- Couleurs (Brand Book Trigenys Group v1) : sombre `#1A0A0E` (`BRAND_NAVY`), bordeaux `#872341` (`BRAND_ORANGE`, accents et boutons), clair `#F5F3F4` (`BRAND_OFFWHITE`), sarcelle `#22A699` pour les états validés (surchargeables via `BRAND_*`).
- Design (skill frontend-design) : Source Serif 4 pour les titres et le mot-marque en italique, Instrument Sans pour le texte ; fond papier, bordeaux = seule couleur d'action, sarcelle = « valide » ; signature manuscrite animée (SVG `pathLength`) dans le hero de connexion ; documents listés en registre (filets), fiches sobres (radius 6). Page de signature « Apple-like » : jetons `--radius-card/--radius-pill/--ease/--d1..d3`, transitions WAAPI dans `web/motion.js`, détection d'appareil `web/device.js`, `web/draft.js` (brouillon IndexedDB du formulaire), aperçu PDF toujours visible (`web/pdfview.js` + pdf.js vendu par `scripts/vendor.mjs`, dossier `web/vendor/` ignoré par git), relais QR vers le téléphone (`src/qr.ts`, `web/handoff.*`), placement des zones de signature sur l’aperçu (`web/fields.js`, fractions de page, suggestion depuis la couche texte « Signature »). Toute évolution UI passe par ce skill et des captures Playwright avant livraison.
- Horodatage indépendant : `src/anchors.ts` (table `anchors`, balayage périodique, vue/preuves), `src/ots.ts` (client OpenTimestamps minimal : sérialisation, stamp, upgrade, contrôle du bloc via Esplora), `src/tsa.ts` (RFC 3161 : DER à la main, nonce INTEGER minimal sinon freetsa refuse). Zéro dépendance ajoutée, volontairement. Tests hors ligne via `fetch` injecté (`test/anchors.test.ts`).
- Passation : `PASSATION.md` en ajout seulement.
- PWA : `web/pwa.js` (enregistrement SW + bannière d'installation), `web/sw.js` (cache des seuls `/static/*`, `VERSION` à incrémenter pour pousser le shell), manifest généré dans `src/server.ts` (`webManifest`). Tests `test/pwa.test.ts` (serveur HTTP réel sur port 0).
