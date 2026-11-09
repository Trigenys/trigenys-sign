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
- `pdf-lib` pour la feuille de signatures ajoutée au PDF final (l'original n'est jamais modifié).
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
| `DEV_SHOW_LINKS` | Dev uniquement : renvoie le lien magique dans l'API |

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

## API

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/auth/request` | Demande de lien magique `{email}` |
| GET | `/auth/:token` | Consomme le lien, pose le cookie de session |
| GET/POST | `/api/me` | Profil (nom, WhatsApp) |
| GET/POST | `/api/documents` | Liste / création (corps PDF brut + en-tête `X-Document-Meta` base64 `{title, signers[]}`) |
| GET | `/api/documents/:id` | Détail et décompte |
| GET | `/api/documents/:id/original.pdf` | Original (émetteur ou signataire) |
| GET | `/api/documents/:id/signed.pdf` | PDF final avec feuille de signatures et manifeste JSON attaché |
| GET | `/api/verify/:id` | Vérification des signatures |
| GET | `/api/sign/:token/context` | Contexte signataire (document, clé active, charge utile) |
| POST | `/api/sign/:token/key` | Enregistre `{publicKeyJwk, signaturePng, strokes}` |
| POST | `/api/sign/:token` | Signe `{payload, signature}` |

## Déploiement (VPS, Docker + Caddy)

Voir `deploy/README.md`.
