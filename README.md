# Trigenys Sign

Signature électronique interne pour les documents PDF de Trigenys Group.

Un émetteur importe un PDF et désigne des signataires. Chaque signataire reçoit un lien personnel
par e-mail et WhatsApp (via Trigenys Notify). À sa première visite, il trace sa signature : une clé
Ed25519 est générée dans son navigateur (non exportable, stockée en IndexedDB). Signer = signer
cryptographiquement une charge utile canonique qui scelle l'empreinte SHA-256 du document. L'émetteur
reçoit à chaque signature un décompte des signatures manquantes. Une page de vérification publique et
un PDF final avec feuille de signatures sont produits.

## Stack

- Node ≥ 24, TypeScript (ESM), aucun framework : `node:http`, `node:sqlite`, `node:crypto`.
- `pdf-lib` pour l’incrustation des signatures dans leurs zones et la feuille de signatures ajoutée au PDF final (le fichier original stocké n’est jamais modifié).
- Front statique (`web/`) : WebCrypto Ed25519, canvas de signature, rejeu animé des tracés.
- Notifications : contrat Trigenys Notify V1 (`/v1/dispatch/{project}/email` et
  `/v1/dispatch/{project}/whatsapp-direct`). Sans clé configurée, mode console (liens journalisés).

## Démarrage

```bash
npm install
cp .env.example .env   # ajuster SESSION_SECRET (≥ 32 caractères) et PUBLIC_BASE_URL
npm run dev            # http://localhost:8790
npm test
```

En dev (`DEV_SHOW_LINKS=1`, pas de Notify), le lien de connexion est renvoyé dans la réponse API et
affiché sous le formulaire ; les liens des signataires sont dans les logs serveur.

## Configuration (`.env`)

| Variable | Rôle |
|---|---|
| `PORT`, `PUBLIC_BASE_URL` | Écoute et URL publique (utilisée dans les liens et la page de vérification) |
| `DATA_DIR` | SQLite + fichiers PDF (`data/` par défaut) |
| `SESSION_SECRET` | HMAC des cookies de session et du cookie signataire |
| `ALLOWED_EMAIL_DOMAINS` | Domaines autorisés à se connecter et émettre (vide = tous) |
| `BRAND_*` | Nom et couleurs appliqués aux pages et aux e-mails |
| `NOTIFY_BASE_URL`, `NOTIFY_PROJECT` | Trigenys Notify |
| `NOTIFY_EMAIL_INGEST_KEY` | Clé `EMAIL_{PROJECT}_INGEST_KEY` côté Notify |
| `NOTIFY_WHATSAPP_DIRECT_INGEST_KEY` | Clé `WHATSAPP_DIRECT_{PROJECT}_INGEST_KEY` côté Notify (route dédiée aux numéros individuels) |
| `HANDOFF_TTL_MINUTES` | Durée de vie d'un code QR « signer sur mon téléphone » (10 min par défaut) |
| `DEV_SHOW_LINKS` | Dev uniquement : renvoie le lien magique dans l'API |
| `ANCHORS_ENABLED` | Horodatage indépendant des documents complets (`1` par défaut, `0` pour couper) |
| `OTS_CALENDARS` | Calendriers OpenTimestamps (liste séparée par des virgules ; alice, bob, finney par défaut) |
| `TSA_URLS` | Autorités d'horodatage RFC 3161 essayées dans l'ordre (DigiCert puis freetsa.org par défaut) |
| `BTC_EXPLORER_URL` | API Esplora pour vérifier le bloc Bitcoin (blockstream.info par défaut) |
| `ANCHORS_SWEEP_MINUTES` | Période du balayage (relances, rattrapage des anciens documents, confirmation Bitcoin ; 30 min par défaut, 5 minimum) |

## Formulaire « Nouveau document »

Le brouillon (titre, signataires, PDF) est enregistré dans l'IndexedDB du navigateur, par compte (`web/draft.js`), et restauré à la prochaine ouverture : un rechargement ou une mise à jour de l'application ne perd rien. Il est vidé à l'envoi réussi ou via « Vider le brouillon » ; « Annuler » le conserve.

### Emplacement des signatures

Dès qu’un PDF est choisi, ses pages s’affichent sous les signataires avec une zone par personne (`web/fields.js`). Les mentions « Signature » du texte du PDF sont détectées (couche texte pdf.js) et proposent un emplacement : sous le libellé quand plusieurs colonnes partagent la ligne, à droite sinon. Chaque zone se déplace et se redimensionne ; « Détecter « Signature » » relance la proposition. Les zones sont stockées en fractions de page (`{page, x, y, w, h}`, origine en haut à gauche, `signers.field_json`) et restent modifiables depuis la fiche du document (`PUT /api/documents/:id/fields`) à tout moment, y compris après signature (le PDF final est généré au téléchargement). Dans le PDF final, la signature est incrustée dans sa zone (rotation de page gérée) ; un signataire sans zone n’apparaît que sur la feuille de signatures, toujours annexée.

## Page de signature

- L'aperçu du PDF (pdf.js auto-hébergé, copié dans `web/vendor/pdfjs/` par `scripts/vendor.mjs` lors de `npm run build`) reste visible pendant tout le parcours ; sur petit écran le panneau devient une feuille en bas d'écran.
- Première signature : sur un appareil tactile, on trace directement ; sur ordinateur, un QR code ouvre `/h/<code>` sur le téléphone, le tracé revient sur l'ordinateur où la clé est créée et la signature confirmée. L'option « Ici, à la souris » reste disponible.
- La signature enregistrée (clé Ed25519 non extractible dans le navigateur + tracé) est réutilisée pour les documents suivants ; « Modifier ma signature » relance l'enrôlement.

## Modèle de signature

Charge utile signée (JSON canonique, clés triées) :

```json
{"documentId":"…","documentSha256":"…","keyFingerprint":"…","signedAt":"2026-11-09T10:00:00.000Z","signerId":"…","v":1}
```

- `keyFingerprint` : empreinte RFC 7638 (SHA-256) de la clé publique JWK.
- Le serveur vérifie la cohérence de la charge utile avec le document et le signataire, l'horodatage
  (±10 min) et la signature Ed25519 avec la clé publique enregistrée.
- `GET /api/verify/:id` recalcule l'empreinte du fichier conservé et revalide chaque signature.
- Perte de clé (autre navigateur) : le signataire, authentifié par son lien personnel, associe une
  nouvelle clé ; les anciennes clés sont conservées (`superseded_at`) pour rester vérifiables.

Cadre : signature électronique simple/avancée, pas une signature qualifiée.

## Horodatage indépendant (OpenTimestamps + RFC 3161)

Dès que la dernière signature est recueillie, l'empreinte SHA-256 du **sujet** (JSON canonique :
`documentId`, `documentSha256`, et pour chaque signataire `signerId`, `email`, `keyFingerprint`,
`signedAt`, `signature`) est horodatée hors de la plateforme, de deux façons complémentaires :

- **OpenTimestamps** : l'empreinte (plus un nonce aléatoire) est soumise aux calendriers publics, qui
  l'agrègent dans une transaction Bitcoin. La preuve `.ots` est d'abord *en attente* ; le balayage
  périodique la met à niveau (1 à 12 h) puis vérifie la racine de Merkle du bloc via l'API Esplora.
  Statut `confirmed` = « Horodaté sur Bitcoin le … » (heure du bloc).
- **RFC 3161** : une autorité d'horodatage signe l'empreinte immédiatement (jeton `.tsr`, réponse
  complète conservée). La signature CMS de la TSA n'est pas revérifiée côté serveur (pas de pile
  X.509 embarquée) : le jeton est la preuve, contrôlé sur l'empreinte et le nonce renvoyés.

Les preuves sont jointes au PDF final (`trigenys-sign-preuve.ots`, `.tsr`) avec un bloc « Horodatage
indépendant » sur la feuille de signatures, et téléchargeables depuis la page publique de vérification.
Elles se vérifient sans la plateforme : `ots verify` (client OpenTimestamps) et
`openssl ts -verify -in preuve.tsr -digest <sha256 du sujet> -CAfile <chaîne de la TSA>`.

Mise en œuvre : clients minimaux maison (`src/ots.ts`, `src/tsa.ts`), aucune dépendance ajoutée
(le paquet npm `opentimestamps` traîne bitcore-lib/request obsolètes ; pkijs est surdimensionné pour
deux analyseurs DER). Idempotent : une ligne `anchors` par (document, type) ; une preuve en attente ou
confirmée n'est jamais refaite, un échec est relancé par le balayage. Rétroactif : les documents déjà
complets sont ancrés par le balayage au prochain démarrage. Rien n'est écrit sur une blockchain hors
de l'empreinte agrégée ; aucun portefeuille, aucun frais.

## API

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/auth/request` | Demande de lien magique `{email}` |
| GET | `/auth/:token` | Consomme le lien, pose le cookie de session |
| GET/POST | `/api/me` | Profil (nom, WhatsApp) |
| GET/POST | `/api/documents` | Liste / création (corps PDF brut + en-tête `X-Document-Meta` base64 `{title, signers[]}`) |
| GET | `/api/documents/:id` | Détail et décompte (`signers[].field`) |
| PUT | `/api/documents/:id/fields` | Emplacements `{fields: {signerId: {page,x,y,w,h} | null}}` (émetteur ; modifiable même après signature, le PDF final étant généré au téléchargement) |
| GET | `/api/contacts?q=` | Carnet de signataires de l'émetteur (personnes déjà sollicitées, plus récentes d'abord ; filtre nom/e-mail) |
| GET | `/api/documents/:id/original.pdf` | Original (émetteur ou signataire) |
| GET | `/api/documents/:id/signed.pdf` | PDF final avec feuille de signatures et manifeste JSON attaché |
| GET | `/api/verify/:id` | Vérification des signatures et état des horodatages (`anchors[]`) |
| GET | `/api/verify/:id/proof/:kind` | Télécharge la preuve `ots` (`.ots`) ou `tsa` (`.tsr`) |
| POST | `/api/documents/:id/anchor` | Émetteur : relance l'horodatage manquant/échoué et interroge la confirmation Bitcoin |
| GET | `/api/sign/:token/context` | Contexte signataire (document, clé active, charge utile) |
| GET | `/api/sign/:token/status` | `{signedAt, keyFingerprint}` (sondage léger de la page de signature) |
| POST | `/api/sign/:token/key` | Enregistre `{publicKeyJwk, signaturePng, strokes}` ou `{publicKeyJwk, handoffId}` (tracé reçu du téléphone) |
| POST | `/api/sign/:token/handoff` | Crée un code QR de relais vers le téléphone → `{id, url, qrSvg, expiresAt}` |
| GET | `/api/sign/:token/handoff/:id` | État du relais (`waiting`, `claimed`, `submitted`, `consumed`, `cancelled`, `expired`) et tracé reçu |
| POST | `/api/sign/:token/handoff/:id/cancel` | Annule le relais |
| GET | `/h/:code` | Page téléphone du relais (tracé au doigt, aucune clé générée) |
| POST | `/api/handoff/:code/claim` | Le téléphone réclame le code → `{claim, signerName, documentTitle}` |
| POST | `/api/handoff/:code/drawing` | Le téléphone envoie `{claim, signaturePng, strokes}` |
| POST | `/api/sign/:token` | Signe `{payload, signature}` |

## Déploiement (VPS, Docker + Caddy)

Voir `deploy/README.md`.
