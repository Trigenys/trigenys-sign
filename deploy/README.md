# Déploiement sur le VPS Trigenys

Cible : `sign.trigenys.com` derrière le Caddy existant du VPS (même schéma que `notify.trigenys.com`
et `fleet.trigenys.com`). Le port hôte 8790 est déjà utilisé localement par un autre service : adapter
le mapping dans `compose.yaml` si nécessaire (ex. `127.0.0.1:8791:8790`) et le snippet Caddy en conséquence.

## 1. Préparer

```bash
ssh ubuntu@<ip-du-vps>
git clone <repo> ~/trigenys-sign && cd ~/trigenys-sign
cp .env.example .env
```

Dans `.env` :

- `PUBLIC_BASE_URL=https://sign.trigenys.com`
- `SESSION_SECRET=$(openssl rand -hex 32)`
- `DEV_SHOW_LINKS=0`
- `NOTIFY_BASE_URL=https://trigenys-notify-staging-api.lawrynnjennifer.workers.dev`, `NOTIFY_PROJECT=trigenys-sign`
  (URL du Worker Notify, pas `notify.trigenys.com` qui est le proxy WAHA)
- `NOTIFY_EMAIL_INGEST_KEY` : clé déclarée côté Notify (`EMAIL_TRIGENYS_SIGN_INGEST_KEY`, projet ajouté à `EMAIL_PROJECTS_JSON`)
- `NOTIFY_WHATSAPP_DIRECT_INGEST_KEY` : clé de la route `whatsapp-direct` (une fois la PR Notify fusionnée et déployée)

## 2. DNS + Caddy

Enregistrement A `sign.trigenys.com` → `<ip-du-vps>`, puis ajouter au Caddyfile :

```
sign.trigenys.com {
    encode zstd gzip
    request_body {
        max_size 30MB
    }
    reverse_proxy 127.0.0.1:8790
}
```

`sudo systemctl reload caddy` (ou `docker compose exec caddy caddy reload` selon l'installation).

## 3. Lancer

```bash
docker compose up -d --build
docker compose logs -f sign
```

Vérification : `curl -s https://sign.trigenys.com/api/config` doit renvoyer la marque.

## 4. Mises à jour

```bash
git pull && docker compose up -d --build
```

Les données (SQLite + PDF) sont dans le volume `sign-data`. Sauvegarde : `docker run --rm -v trigenys-sign_sign-data:/data -v $PWD:/b alpine tar czf /b/sign-data.tgz /data`.
