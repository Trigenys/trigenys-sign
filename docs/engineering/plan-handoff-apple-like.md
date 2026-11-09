# Plan : design Apple-like, aperçu permanent du document, hand-off QR vers le téléphone

Demande : garder les couleurs du brand book, design plus « Apple-like » avec animations sobres, document à signer toujours visible, enregistrement de la signature, QR code sur ordinateur pour tracer la signature sur son téléphone ; sur téléphone, tracer directement.

## Décision de conception

- Le QR encode une URL courte `/h/<code>`, à usage unique, limitée à **déposer un tracé**. Le téléphone ne reçoit jamais le jeton `/s/<token>` et ne signe pas.
- L'ordinateur récupère le tracé (polling), l'affiche pour confirmation, génère sa clé Ed25519 locale (`enrollKey` existant avec `handoffId`) et signe. Évite la boucle « relink » (clés non extractibles, IndexedDB par navigateur, `kp:<email>`).
- Jeton `/s/<token>` : réutilisable, n'expire pas (`resolveSignerToken`) ; seule la signature est unique (409).
- QR : Adopt `qrcode-generator` (zéro dépendance, MIT, types inclus) côté serveur, rendu SVG maison (`getModuleCount`/`isDark`), testable en node:test. Rejeté : `qrcode` (pngjs, yargs), encodeur vendorisé non versionné.
- Mise à jour ordinateur : polling (sans état, retries sûrs), pas SSE.
- Aperçu PDF mobile : iframe inutilisable (Android), donc `pdfjs-dist` auto-hébergé (`web/vendor/pdfjs/`, script `scripts/vendor.mjs` idempotent, gitignoré, exécuté au build Docker), chargé à la demande sur appareil tactile. Ordinateur : iframe native.

## Étapes

A. Back-end : table `handoffs(id, signer_id, code_hash UNIQUE, claim_hash, created_at, expires_at, claimed_at, submitted_at, signature_png, strokes_json, consumed_at, cancelled_at)` (CREATE IF NOT EXISTS) ; `HANDOFF_TTL_MINUTES` (10) ; `src/qr.ts qrSvg()` ; service : `validateDrawing`, `createHandoff(token)` (409 si signé, annule les ouverts, purge > 24 h, plafond 20/h → 429, code = randomToken, hash stocké, URL `${publicBaseUrl}/h/${code}`), `handoffStatus(token,id)` (anti-IDOR 404), `cancelHandoff`, `claimHandoff(code)` (404/410/409, `claim_hash`), `submitHandoffDrawing(code,{claim,signaturePng,strokes})` (403/409/410/400), `enrollKey(..., handoffId?)` consomme le hand-off dans la même transaction, `signerStatus(token)` léger pour le polling. Tests `test/handoff.test.ts` ; `test/service.test.ts` inchangé (non-régression).
B. Routes : `GET /h/:code` → handoff.html ; `POST /api/sign/:token/handoff` (201), `GET .../handoff/:id`, `POST .../handoff/:id/cancel`, `GET /api/sign/:token/status` ; `POST /api/handoff/:code/claim`, `POST /api/handoff/:code/drawing` ; `referrer-policy: no-referrer` sur `/s/` et `/h/` ; MIME `.mjs`.
C. Front : jetons `--ease: cubic-bezier(.32,.72,0,1)`, `--d1 180ms/--d2 320ms/--d3 520ms`, `--radius-card 14px`, pilules, topbar collante translucide, `:active scale(.97)`, classes existantes conservées ; `web/motion.js` (`swapStep`, `enter`, `reduced`) ; `web/device.js` (`canDrawHere` = pointer coarse | `?draw=here` | localStorage `ts.drawHere` ; `isCompact` ≤ 1023px) ; `pad.js` : ResizeObserver, offsetWidth/Height, `aspect-ratio: 2/1` partout (ratio identique téléphone/ordinateur).
D. sign.html/sign.js : ordinateur = document collant pleine hauteur + panneau 400px ; mobile = document dans le flux + barre d'action collante ouvrant une feuille `.sheet`. Machine à états `loading | enroll-remote | enroll-local | received | ready | signing | done` ; segmenté « Téléphone | Ici » ; hand-off polling 2 s, `/status` 6 s ; QR expiré → régénérer ; « Modifier ma signature ».
E. handoff.html/js : claim au chargement (POST), pad plein largeur 2/1, « Enregistrer ma signature » → drawing, écran de confirmation avec autographe animé, erreurs 409/410 claires. Aucune clé générée.
F. `web/pdfview.js renderPdf(container,url)` : import dynamique, worker, DPR ≤ 2, rendu paresseux (IntersectionObserver), repli lien PDF.
G. Accueil aux nouveaux jetons (hero conservé), CLAUDE.md/README/PASSATION, captures Playwright 1440×900 et 390×844 (QR, received, ready, done, /h/, feuille, reduced-motion), E2E deux contextes.

## Risques

- Ne pas toucher `canonicalJson`/`fingerprintOf` (web/keys.js ↔ src/crypto.ts).
- `enrollKey` avec `handoffId` ignore le PNG client ; consommation en transaction.
- Strokes historiques (ratio ~1,7) rejoués en 2/1 : légère déformation du rejeu seulement.
- Dimensionner le pad après la fin de l'animation.
- Cookie `ts_signer` unique : deux liens ouverts en parallèle s'écrasent (existant).
- Codes jamais journalisés ; hash seul stocké.
