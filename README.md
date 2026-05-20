# TP13 — Stack Docker complète

## Partie 1 — API & Dockerfile

### API Node.js

L'API est dans le dossier `api/` et expose trois routes :

| Route | Description |
|-------|-------------|
| `GET /` | Retourne le hostname du conteneur, la valeur de `PET` et un compteur de requêtes |
| `GET /healthz` | Répond `{ "status": "ok" }` avec HTTP 200 — utilisé par le Healthcheck Docker |
| `GET /metrics` | Expose les métriques Prometheus via `prom-client` |

Le compteur de requêtes est implémenté avec `prom-client` (`http_requests_total`) et exposé sur `/metrics` pour être scrappé par Prometheus.

### Dockerfile

Points clés du Dockerfile :

- **Image de base** : `node:20-alpine` — image minimale, moins de surface d'attaque (voir Partie 4)
- **Utilisateur non-root** : `USER node` — l'utilisateur `node` est intégré à l'image officielle Node.js
- **Dépendances de production uniquement** : `npm install --omit=dev`
- **Ordre des COPY** : `package*.json` en premier pour profiter du cache Docker lors des `npm install`, puis le code source
- **Healthcheck** : cible `/healthz` avec `interval=30s`, `timeout=5s`, `start-period=10s`

### Captures

Route `GET /` :

![Partie 1 - GET /](captures/partie_1_1.png)

Route `GET /healthz` :

![Partie 1 - GET /healthz](captures/partie_1_2.png)

---

## Partie 2 — Registry privé

### Architecture

Le registry est défini dans `docker-compose.registry.yml`, séparé de la stack principale :

- **`registry:2`** — registry Docker privé exposé sur le port `5000`
- **`joxit/docker-registry-ui`** — interface web exposée sur le port `8080`

La configuration du registry (`registry/config.yml`) active la suppression d'images et les en-têtes CORS pour l'interface web. L'interface utilise `NGINX_PROXY_PASS_URL` pour proxifier les appels API vers le registry côté serveur — ce qui permet d'y accéder depuis un navigateur distant (VPS) sans exposer le registry directement.

### Push de l'image

```bash
docker tag api-test localhost:5000/mon-api:1.0.0
docker push localhost:5000/mon-api:1.0.0
```

Le `docker-compose.yml` principal référence ensuite l'image depuis le registry privé :

```yaml
image: localhost:5000/mon-api:1.0.0
```

### Capture — Interface web avec l'image listée

![Partie 2 - Registry UI](captures/partie_2_1.png)

![Partie 2 - Image dans le registry](captures/partie_2_2.png)

---

## Partie 3 — Stack Compose & Nginx

### Routing Nginx

| Route | Comportement |
|-------|-------------|
| `GET /` | Round-robin entre `cat` et `dog` |
| `GET /cat` | Exclusivement vers le service `cat` |
| `GET /dog` | Exclusivement vers le service `dog` |


### Démonstration du round-robin

En appelant `GET /` plusieurs fois on observe l'alternance entre les deux instances. Le compteur `requestCount` est local à chaque conteneur — ce qui illustre pourquoi les applications distribuées ne doivent pas stocker d'état en mémoire (stateless design).

---

## Partie 4 — Sécurité

### Variables d'environnement — fichier `.env`

Toutes les valeurs configurables passent par `.env`

Le fichier `.env` est exclu du contexte de build Docker via `.dockerignore` et ne doit pas être versionné (ajouté au `.gitignore`).

### Scan Trivy

```bash
trivy image localhost:5000/mon-api:1.0.0
```

#### Justification du choix de `node:20-alpine`

`node:20-alpine` est basée sur Alpine Linux (~5 Mo), contre Debian/Ubuntu pour `node:latest` (~900 Mo). L'impact sécurité est direct :

| Image | Taille | CVE (total) |
|-------|--------|-------------|
| `node:20-alpine` | ~180 Mo | faible |
| `node:latest` | ~1,1 Go | élevé |

Alpine embarque beaucoup moins de paquets système, donc beaucoup moins de surface d'attaque. Les CVE détectées par Trivy sur `node:20-alpine` sont essentiellement dans les bibliothèques musl libc, en général de faible criticité.

#### Capture — Sortie Trivy

![Partie 4 - Trivy scan](captures/partie_4_1.png)

---

## Partie 5 — Validation de la stack

### Services en état `Up (healthy)`

![Partie 5 - docker compose ps](captures/partie_5_1.png)

### Round-robin sur `GET /` — alternance des hostnames

![Partie 5 - Round-robin](captures/partie_5_2.png)


### `/cat` et `/dog` — PET et compteurs distincts

![Partie 5 - /dog](captures/partie_5_3.png)

![Partie 5 - /cat](captures/partie_5_4.png)

---

## Partie 6 — Questions théoriques

### Question Swarm — `docker compose up` vs `docker stack deploy`

`docker compose up` lance les services définis dans `docker-compose.yml` sur **une seule machine**, en utilisant directement le daemon Docker local. C'est un outil de développement et de déploiement mono-nœud.

`docker stack deploy` déploie une stack sur un **cluster Docker Swarm** (plusieurs nœuds). Swarm s'occupe de distribuer les réplicas sur les nœuds disponibles, de gérer la haute disponibilité et le redémarrage automatique des services.

La directive `build:` n'est pas utilisable en mode Swarm car Swarm doit distribuer les conteneurs sur plusieurs nœuds — il ne sait pas sur lequel builder l'image, et les nœuds workers n'ont pas forcément accès aux fichiers source. Toutes les images doivent donc être **pré-buildées et disponibles dans un registry** accessible par l'ensemble des nœuds du cluster.

---

### Question Secrets — variable d'environnement vs Docker Secret

| | Variable d'environnement | Docker Secret |
|---|---|---|
| **Stockage** | En clair dans le processus | Chiffré dans Swarm (Raft) ou tmpfs en Compose |
| **Visibilité** | Exposée dans `docker inspect`, `/proc/PID/environ`, logs | Jamais exposée hors du conteneur |
| **Héritage** | Transmise à tous les processus fils | Uniquement montée dans le conteneur ciblé |

À l'intérieur du conteneur, le secret est accessible sous forme de fichier dans `/run/secrets/<nom_du_secret>`.

Lecture depuis Node.js :
```js
const secret = require('fs').readFileSync('/run/secrets/mon_secret', 'utf8').trim();
```

---

### Question Backup — que faut-il sauvegarder en production ?

**Recréable automatiquement** (depuis le code ou le registry) :
- Les images Docker — reconstruites via `docker build` ou tirées depuis le registry
- Les conteneurs — recréés depuis les images
- Les réseaux Docker — recréés par Compose/Swarm
- Les fichiers de configuration versionnés dans Git (`docker-compose.yml`, `nginx.conf`, `Dockerfile`...)

**Irremplaçable — à sauvegarder impérativement** :
- Les **volumes Docker** contenant des données persistantes (base de données, fichiers uploadés...)
- Le fichier **`.env`** de production avec les vraies valeurs des secrets (s'il n'est pas versionné)
- Les **Docker Secrets** et certificats TLS/SSL
- Les **images dans le registry privé** si elles ne sont pas reconstruibles (ex : registry self-hosted sans sauvegarde)

En résumé : tout ce qui est dans Git est recréable ; tout ce qui est en dehors de Git (données, secrets, certificats) doit être sauvegardé.

---

## Partie 7 — Observabilité & Production

### Stack de monitoring

Les services suivants sont ajoutés au `docker-compose.yml` principal :

| Service | Image | Rôle | Port |
|---------|-------|------|------|
| `prometheus` | `prom/prometheus:v2.53.0` | Scrape les métriques | `9090` |
| `grafana` | `grafana/grafana:11.0.0` | Dashboard de visualisation | `40110` |
| `node-exporter` | `prom/node-exporter:v1.8.1` | Métriques système hôte | interne |
| `cadvisor` | `gcr.io/cadvisor/cadvisor:v0.49.1` | Métriques conteneurs | interne |
| `portainer` | `portainer/portainer-ce:2.20.3` | Interface de gestion Docker | `40111` |

Prometheus scrape trois sources : l'API (`cat:3000` et `dog:3000` via `/metrics`), node-exporter et cAdvisor. La configuration est dans `monitoring/prometheus.yml`.

### Dashboard Grafana — provisioning automatique

Le dashboard est provisionné automatiquement au démarrage via deux fichiers versionnés :

- `monitoring/grafana/provisioning/datasources/prometheus.yml` — déclare Prometheus comme datasource par défaut
- `monitoring/grafana/provisioning/dashboards/dashboard.yml` — indique le dossier de dashboards à charger
- `monitoring/grafana/dashboards/api-dashboard.json` — le dashboard JSON

Aucune configuration manuelle n'est nécessaire : le dashboard "API Stack — Monitoring" apparaît directement après `docker compose up`.

### Capture — Dashboard Grafana

![Partie 7 - Dashboard Grafana](captures/partie_7_1.png)

### Capture — Portainer

![Partie 7 - Portainer](captures/partie_7_2.png)

### Limites CPU/RAM — `docker-compose.prod.yml`

Le fichier `docker-compose.prod.yml` est un **override** à utiliser en production :

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Il ajoute des limites de ressources sur chaque service via `deploy.resources.limits`, sans modifier la configuration de base.

---

## Partie 8 — Volumes

### Volumes nommés vs bind mounts

La stack utilise deux types de montages, chacun avec un rôle distinct :

**Volumes nommés** — pour les données persistantes gérées par Docker :

| Volume | Service | Contenu |
|--------|---------|---------|
| `tp13note_grafana-data` | grafana | Base SQLite, sessions, plugins |
| `tp13note_prometheus-data` | prometheus | Séries temporelles (TSDB) |
| `tp13note_portainer-data` | portainer | Configuration et état Portainer |
| `tp13note_registry_data` | registry | Images poussées dans le registry |

**Bind mounts** — pour les fichiers de configuration injectés depuis l'hôte :

| Fichier hôte | Destination conteneur | Service |
|---|---|---|
| `./nginx/nginx.conf` | `/etc/nginx/conf.d/default.conf` | nginx |
| `./monitoring/prometheus.yml` | `/etc/prometheus/prometheus.yml` | prometheus |
| `./monitoring/grafana/provisioning` | `/etc/grafana/provisioning` | grafana |
| `./monitoring/grafana/dashboards` | `/var/lib/grafana/dashboards` | grafana |
| `./registry/config.yml` | `/etc/docker/registry/config.yml` | registry |

### Justification du choix

Les **volumes nommés** sont utilisés pour les données car Docker en gère le cycle de vie : elles survivent aux recreations de conteneurs et peuvent être sauvegardées indépendamment du code. Les **bind mounts** sont utilisés pour les configs car elles sont versionnées dans Git — modifier un fichier sur l'hôte suffit à reconfigurer le service sans rebuild.

### Captures

`docker volume ls` :

![Partie 8 - docker volume ls](captures/partie_8_1.png)

`docker volume inspect tp13note_grafana-data` :

![Partie 8 - docker volume inspect](captures/partie_8_2.png)

---

## Partie 9 — CI/CD avec GitHub Actions

### Workflow `.github/workflows/docker.yml`

Le pipeline se déclenche sur chaque push sur `main` et enchaîne trois étapes :

1. **Build** — construit l'image `./api` localement avec Docker Buildx (`load: true`) sans la pousser
2. **Scan Trivy** — analyse l'image et **fait échouer le pipeline** (`exit-code: 1`) si des CVE de sévérité `CRITICAL` non corrigées sont détectées
3. **Push** — pousse l'image vers GHCR uniquement si le scan est passé

### Capture — pipeline GitHub Actions

![Partie 9 - GitHub Actions](captures/partie_9_1.png)
