# Webhook Inspector

Webhook Inspector gives you a temporary webhook URL and shows every HTTP
request it receives, as it arrives: method, target, headers, query string, raw
body, source address, size and time. Point a system under test at the URL,
watch its webhooks come in, and tell it what to answer — a status, headers, a
body, a delay, a queue of answers or rules per path. No registration; sessions
are temporary, and are not meant for sensitive production data.

It is built for QA engineers and developers, designed for the desktop and
usable on tablets and phones. It is a service of QA Tools.

## How it is built

The code, the tests and the documentation are written by AI agents; the owner
sets the tasks and takes the decisions. The process they follow is private,
and so are its issue tracker, its merge requests and its decision log: an
issue `#123`, a merge request `!12` or a decision `D123` cited in the
documents or in a commit message leads to nothing public. On GitHub, a `#123`
in a commit message links to the mirror's own issue of that number, if it has
one, which is not the issue meant.

## The hosted instance

- **https://qa-tools.ru** and **https://webhook.qa-tools.ru** — the site,
  which answers on both hosts. `webhook.qa-tools.ru` becomes its only host on
  the date the changelog's 1.16.0 entry names; the links below already use it.
- **`https://hook.qa-tools.ru/s/<session-id>`** — where a session receives its
  webhooks.
- **The API** — every session can be driven over HTTP: the reference is at
  [`/docs`](https://webhook.qa-tools.ru/docs) and the OpenAPI description at
  [`/openapi.json`](https://webhook.qa-tools.ru/openapi.json). The contract
  behind them is [`docs/API.md`](docs/API.md).
- **For AI agents** — [`/llms.txt`](https://webhook.qa-tools.ru/llms.txt) and
  [`/llms-full.txt`](https://webhook.qa-tools.ru/llms-full.txt), the whole
  guide in one Markdown file, and an MCP server at `/mcp`.
- **The relay script** —
  [`/webhook-inspector-relay.mjs`](https://webhook.qa-tools.ru/webhook-inspector-relay.mjs),
  one Node.js file that sends each request a session captures on to a service
  on your own machine. Its commands and SHA-256 are in the API reference.
- **The changelog** — [`/changelog`](https://webhook.qa-tools.ru/changelog),
  with Atom feeds of every release and of breaking changes alone; its source is
  [`CHANGELOG.md`](CHANGELOG.md).
- **The status page** — https://status.qa-tools.ru, the image's
  `STATUS_PAGE_URL` (see below).

## Install

Webhook Inspector runs on a [k3s](https://k3s.io) cluster from the Helm chart
in `deploy/helm/qa-tools`: the backend, the frontend, PostgreSQL and a nightly
backup, in one namespace. Before the commands below:

- **The cluster:** k3s 1.32 or newer with the Traefik it packages,
  cert-manager, and this repository's Traefik settings and certificate
  issuers, set up as step 1 of
  [Installing on k3s with the chart](#installing-on-k3s-with-the-chart) says.
  The backend sets the sysctl `net.ipv4.tcp_rmem`, which the kubelet allows
  from Kubernetes 1.32; an older cluster adds
  `--set-string backend.tcpRmem=` to the release.
- **Two host names** pointing at the server: the site's, and the receive
  host's, where sessions receive their webhooks.
- **A registry** the cluster can pull images from.
- **Where you run the commands:** this repository, Docker, `kubectl` and Helm
  reaching the cluster, and `openssl`.

These steps were followed on a test cluster with k3s 1.35, Helm 4.3,
kubectl 1.37 and cert-manager 1.21 ([On a test cluster](#on-a-test-cluster)).

Set the five values, then run the rest as it stands:

```bash
REGISTRY=registry.example.com/inspector  # the registry and path the cluster pulls from
TAG=$(git rev-parse --short HEAD)        # the images' tag
SITE_HOST=inspector.example.com          # the site's host
RECEIVE_HOST=hook.inspector.example.com  # the receive host
ISSUER=letsencrypt-production            # selfsigned on a test cluster

docker build -f apps/backend/Dockerfile -t $REGISTRY/backend:$TAG .
docker build -f apps/frontend/Dockerfile --build-arg APP_ORIGIN=https://$SITE_HOST \
  --build-arg RECEIVE_ORIGIN=https://$RECEIVE_HOST -t $REGISTRY/frontend:$TAG .
docker build -f deploy/postgres/Dockerfile -t $REGISTRY/postgres:16-pgcron-1 deploy/postgres
for image in backend:$TAG frontend:$TAG postgres:16-pgcron-1; do docker push $REGISTRY/$image; done

kubectl create namespace inspector
kubectl -n inspector create secret generic inspector-postgres --from-literal=password="$(openssl rand -hex 24)"
sudo install -d -o 999 -g 999 -m 0700 /var/backups/webhook-inspector  # on the node itself

helm upgrade --install inspector deploy/helm/qa-tools --namespace inspector \
  --set-string images.registry=$REGISTRY --set-string images.tag=$TAG \
  --set-string ingress.host=$SITE_HOST --set-string receive.host=$RECEIVE_HOST \
  --set-string ingress.tls.issuer=$ISSUER --wait --timeout 10m
```

The site then answers at `https://$SITE_HOST`, and a session receives its
webhooks at `https://$RECEIVE_HOST/s/<session-id>`: open the site, create a
session and send a `POST` to its receive URL to see it work. A private
registry needs its pull Secret, and the off-server copy of the backups, the
heartbeat monitor and every other value are options: all are in the full
section below.

## Technology

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **Backend:** Node.js 24 running TypeScript directly, Fastify
- **Database:** PostgreSQL 16 with pg_cron
- **Realtime:** WebSocket
- **Infrastructure:** k3s and Helm
- **CI/CD:** GitLab CI and the GitLab Container Registry

## Repository layout

```text
webhook-inspector/
├── apps/
│   ├── frontend/          # React + Vite application, and its Nginx image
│   └── backend/           # Fastify application and its migrations
├── packages/
│   └── shared/            # TypeScript contracts of both apps, and openapi.json
├── e2e/                   # the browser smoke suite (Playwright)
├── deploy/
│   ├── cluster/           # cluster prerequisites: Traefik, issuers, deploy identity
│   ├── helm/qa-tools/     # the Helm chart
│   └── postgres/          # the PostgreSQL image with pg_cron
├── docs/
│   ├── API.md             # the HTTP, realtime and MCP contract
│   ├── ARCHITECTURE.md    # how it is built and run
│   ├── PRODUCT.md         # what it does and how it looks
│   └── testing/           # the browser smoke suite and the record of flaky tests
├── scripts/               # the local database, CI checks and measurement harnesses
├── .gitlab/ci/validate.yml # the validate stage: lint, types, suites, smoke, checks
├── .gitlab-ci.yml         # image builds, deployment and main's validation gate
├── CHANGELOG.md           # the public changelog
├── VERSION                # the product version
└── package.json           # npm workspaces: apps/* and packages/*
```

## Running locally

Requirements: Node.js 24 (see `.nvmrc`), npm, and Docker. The frontend tests
also run `sh`, `curl` and `jq` from the `PATH`, and fail without them.

Only PostgreSQL runs in Docker. The backend and frontend run natively, so
restarts stay instant and the frontend reloads on change. The backend runs
TypeScript directly on Node 24 and `packages/shared` is consumed as source, so
neither needs a build step during development.

```bash
cp .env.example .env      # local configuration; .env is gitignored
npm install               # install all workspace dependencies
npm run db:rebuild        # once per machine: build the PostgreSQL image and start it
npm run db:up             # start PostgreSQL with pg_cron
npm run db:migrate        # apply the database migrations
npm run dev:backend       # start the backend
npm run dev:frontend      # start the frontend on http://localhost:5173
```

The Vite dev server listens on IPv6 only, so use `localhost:5173` rather than
`127.0.0.1:5173`. It proxies `/api/`, `/ws/`, `/s/` and `/mcp` to the backend's
application listener, as the Ingress does in production, so the browser sees a
single origin. Webhooks are not proxied: the backend receives them on a second
listener, `http://127.0.0.1:3001` by default (`RECEIVE_PORT`), and that is the
receive URL the session page shows, as production's shows
`https://hook.qa-tools.ru/s/<id>`.

The Compose project is named `webhook-inspector` in `docker-compose.yml`, so
every checkout of the repository on a machine shares one container,
`webhook-inspector-postgres-1`, one image, `webhook-inspector-postgres`, and
one volume, `webhook-inspector_postgres-data`. `npm run db:up` starts the image
already built and never builds or pulls one; it returns once the database
answers, and otherwise fails within three minutes. It needs
`npm run db:rebuild` first on a new machine, and again after `deploy/postgres/`
changes. Because the container is shared, `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB` and `POSTGRES_PORT` must be the same in every
checkout's `.env` — as in `.env.example` — or left unset; different values make
`npm run db:up` recreate the container, and a volume created with other
credentials then fails its health check. `COMPOSE_PROJECT_NAME` is not set
there: it would replace the project name.

Database commands:

```bash
npm run db:migrate        # apply pending database migrations
npm run db:rebuild        # rebuild the PostgreSQL image (needs Docker Hub), keeping data
npm run db:logs           # follow PostgreSQL logs
npm run db:down           # stop PostgreSQL, keeping data
npm run db:reset          # stop PostgreSQL and delete all local data
```

### A database from before the rename

Until 1.18.2 the Compose project, the image, the database and its role were
named `qa-tools` and `qa_tools`. On a machine set up before, the first
`npm run db:up` gives the image `qa-tools-postgres` its new name with
`docker tag`, building and pulling nothing, stops the old container
`qa-tools-postgres-1`, which would hold port 5432, and starts the new one on a
new, empty volume. It stops the old container only once the image has its new
name: when `docker tag` fails, `db:up` exits non-zero quoting what Docker said,
and when neither name is there Compose reports the image missing; either way
the old database keeps running. `npm run db:rebuild` builds the image under
its new name, stopping the old container first. The old container and its
volume `qa-tools_postgres-data`, with the sessions it held, are left as they
were. A `.env` copied from the old `.env.example` still names `qa_tools`; copy
`.env.example` again for the new names. When nothing in the old database is
wanted any more, remove what is left; the image stays, under its new name:

```bash
docker rm qa-tools-postgres-1
docker volume rm qa-tools_postgres-data
docker network rm qa-tools_default
docker image rm qa-tools-postgres   # the old name only
```

A test database of a task from before, `qa-tools-test-<task>`, goes with
`node scripts/db.mjs task-down <task>`, as the new one does.

## Tests and checks

```bash
npm test                  # backend and frontend suites; needs the database running and migrated
npm run typecheck         # TypeScript across all workspaces and the e2e suite
npm run lint              # ESLint
npm run format            # Prettier (code only; Markdown is hand-written)
npm run build             # production build of the frontend
npm run check:native-ts   # shared resolves as TypeScript source
npm run test:e2e          # the browser smoke suite; needs its own database and free ports
```

`node scripts/db.mjs task-test <name>` runs the backend suite against a
database of its own, in a disposable container started from the same image,
so that work on two branches never shares test data;
`node scripts/db.mjs task-down <name>` removes it.

`npm run test:e2e` runs against a separate `webhook_inspector_e2e` database
given by `E2E_DATABASE_URL`, never the one you develop against, and starts its
own backend and dev server. Setup, ports and how to read a failure are in
[`docs/testing/browser-smoke.md`](docs/testing/browser-smoke.md).

The script tests under `scripts/` run with `node --test`; CI runs them in the
`delivery-checks` and `operations-tests` jobs of `.gitlab/ci/validate.yml`.

## Installing on k3s with the chart

The chart in `deploy/helm/qa-tools` deploys the backend, the frontend,
PostgreSQL and a nightly backup into one namespace; an off-server copy of the
backups and a heartbeat monitor are options. Its defaults name no
installation: an install gives its own hosts and images, and nothing else is
needed (#367). The chart is named `qa-tools`, the project's earlier name; the
names it gives objects are the release's. The project's own production at
`qa-tools.ru` is one installation of it, deployed by `.gitlab-ci.yml` with
values its operator keeps in the project's CI/CD variables.

The commands below use the five values the [Install](#install) section sets:
`REGISTRY`, `TAG`, `SITE_HOST`, `RECEIVE_HOST` and `ISSUER`.

1. **The cluster.** k3s with the Traefik it packages, and cert-manager, which
   Helm installs:

   ```bash
   helm install cert-manager oci://quay.io/jetstack/charts/cert-manager --version v1.21.1 \
     --namespace cert-manager --create-namespace --set crds.enabled=true --wait
   ```

   Then, from this repository:
   - `deploy/cluster/traefik-config.yaml` — Traefik's redirect to HTTPS, its
     timeouts, and `externalTrafficPolicy: Local`, so the backend sees each
     sender's own address. k3s takes it from its manifests directory, on the
     server, and redeploys Traefik with it:
     `sudo install -m 600 deploy/cluster/traefik-config.yaml /var/lib/rancher/k3s/server/manifests/traefik-config.yaml`.
   - `deploy/cluster/letsencrypt-issuers.yaml` — the Let's Encrypt issuers:
     `letsencrypt-production`, the chart's `ingress.tls.issuer` unless set,
     and `letsencrypt-staging`. Replace the placeholder
     `acme-contact@example.com` with your own contact address, then
     `kubectl apply -f deploy/cluster/letsencrypt-issuers.yaml`; Let's Encrypt
     refuses the placeholder. Where Let's Encrypt cannot reach the server, a
     self-signed issuer takes their place
     ([On a test cluster](#on-a-test-cluster)).
   - `deploy/cluster/gitlab-deployer.yaml` — only for deploying from GitLab CI
     (below): a ServiceAccount limited to the namespace `qa-tools`, the one the
     pipeline installs into.
2. **The images.** Build and push the three images to a registry the cluster
   can pull from, as `$REGISTRY/backend:$TAG`, `$REGISTRY/frontend:$TAG` and
   `$REGISTRY/postgres:16-pgcron-1`:

   ```bash
   docker build -f apps/backend/Dockerfile -t $REGISTRY/backend:$TAG .
   docker build -f apps/frontend/Dockerfile --build-arg APP_ORIGIN=https://$SITE_HOST \
     --build-arg RECEIVE_ORIGIN=https://$RECEIVE_HOST -t $REGISTRY/frontend:$TAG .
   docker build -f deploy/postgres/Dockerfile -t $REGISTRY/postgres:16-pgcron-1 deploy/postgres
   for image in backend:$TAG frontend:$TAG postgres:16-pgcron-1; do docker push $REGISTRY/$image; done
   ```

   The frontend image names its address when it is built, so a copy on another
   address builds its own. It names its operator the same way, with three more
   build arguments, each left out when unset — the repository falls back to
   none of this site's:

   | Build argument    | What it names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Unset                                                                                                                                                                                                                                                                                                                                                 |
   | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `STATUS_PAGE_URL` | The status page, an http or https address with no query or fragment: the header's `Status ↗` link, the `/status` and `/status/` redirect, the status line of `llms.txt` and the API reference's sentence.                                                                                                                                                                                                                                                                                                                          | No status link and no such line; `/status` is the site's `Page not found`.                                                                                                                                                                                                                                                                            |
   | `CONTACT_EMAIL`   | The contact address: the footer's `Contact:`, the about pages' last paragraph, `/.well-known/security.txt` and the API description's `info.contact`.                                                                                                                                                                                                                                                                                                                                                                               | No address anywhere, and no `security.txt` (404).                                                                                                                                                                                                                                                                                                     |
   | `OPERATOR_TEXTS`  | `true` shows this site's own texts: the Terms of Use at `/terms`, the Privacy Policy at `/privacy`, the footer's links to them, the about pages' lines on who runs the service and who pays for it, the changelog of this site's releases — `/changelog`, `/changelog.md` and its two feeds — with the header's `Changelog` and every link to it, the footer's clause on how long backups keep captured requests, and the API description's Network section, which gives this site's server address and network for an allow-list. | Neither page (`/terms` and `/privacy` are `Page not found`), no link to them, and the about pages describe the service alone; no changelog (its four addresses are `Page not found`) and no link to it; the footer's line ends after the session's 7 days; the API reference and `llms-full.txt` have no Network section. `true` needs the other two. |

   This site's image sets all three from CI/CD variables of the project
   (Deploying from GitLab CI, below). The texts behind
   `OPERATOR_TEXTS` are this site's operator's and name its hosting; a copy
   leaves them off. Keep the three values: the check after the install
   (step 6) is given them, to check what the image was built with.
3. **The namespace and its Secrets.** The database password, which the chart
   reads and never holds, in the Secret `<release>-postgres`:

   ```bash
   kubectl create namespace inspector
   kubectl -n inspector create secret generic inspector-postgres --from-literal=password="$(openssl rand -hex 24)"
   ```

   For a private registry, a `docker-registry` Secret named `gitlab-registry`,
   or the name you give `images.pullSecret` (the test run below used a registry
   without credentials, so it did not run this command):

   ```bash
   kubectl -n inspector create secret docker-registry gitlab-registry --docker-server=<registry host> \
     --docker-username=<user> --docker-password=<token>
   ```

   A registry that takes no
   credentials needs none: add `--set-string images.pullSecret=` to the
   release, or every pod warns that it cannot find `gitlab-registry`
   (`FailedToRetrieveImagePullSecret`), and pulls without it.
4. **The backup directory.** The nightly backup dumps the database into a
   directory on the node, `backup.hostPath`, by default
   `/var/backups/webhook-inspector`. It must exist before the install, owned by
   the PostgreSQL image's user with mode 0700, or the backup's pod does not
   start. On the node itself:

   ```bash
   sudo install -d -o 999 -g 999 -m 0700 /var/backups/webhook-inspector
   ```

5. **DNS.** An `A` record for the site's host and one for the receive host,
   both pointing at the server.
6. **The release.** The two hosts and the images are the values every install
   sets; without the hosts, or the registry and tag, the chart refuses to
   render and names them. `ISSUER` names the ClusterIssuer of the two
   certificates.

   ```bash
   helm upgrade --install inspector deploy/helm/qa-tools --namespace inspector \
     --set-string images.registry=$REGISTRY --set-string images.tag=$TAG \
     --set-string ingress.host=$SITE_HOST --set-string receive.host=$RECEIVE_HOST \
     --set-string ingress.tls.issuer=$ISSUER --wait --timeout 10m
   ```

   Migrations run in the backend's init container on every upgrade. While
   PostgreSQL does not answer yet, as on the first install, it fails and is
   restarted until it does, then applies them;
   `kubectl -n inspector logs deploy/inspector-backend -c migrate` lists what
   it applied. Every value is described in `deploy/helm/qa-tools/values.yaml`;
   the TLS and database Secrets are named after the release unless set. The
   backend believes the sender's address Traefik passes on only from a peer
   in `backend.trustedProxyCidrs`, by default `10.42.0.0/24`, the pod network
   k3s gives its first node; a cluster whose Traefik pod has an address
   outside it sets its own range, or the receive host takes no webhook.
   Then check the deployed site from outside, as CI does after each
   deployment, giving the check the three settings the image was built with
   in step 2, each empty for one left out — for an image built with none of
   them, as above:

   ```bash
   node scripts/check-deployment.mjs https://$SITE_HOST https://$RECEIVE_HOST \
     --status-page= --contact-email= --operator-texts=
   ```

   With a setting, give its value, `--status-page=https://status.example.com/`,
   `--contact-email=hello@example.com` or `--operator-texts=true`. Each is
   checked as the image serves it: `/status` and `/status/` a 301 to the
   status page, or the site's `Page not found`; `/.well-known/security.txt`
   giving the contact address alone, or a 404; `/terms` and `/privacy` the
   Terms of Use and the Privacy Policy, or `Page not found`, and with
   `--operator-texts` empty or `false`, `/changelog`, `/changelog.md` and the
   changelog's two feeds `Page not found` too. A setting not given is not
   checked, and the first line the check prints names it, so
   `node scripts/check-deployment.mjs https://$SITE_HOST https://$RECEIVE_HOST`
   alone checks the rest — the changelog's two feeds among it, as served, so
   an image built without the operator's texts is checked with
   `--operator-texts=`. The check only reads: it creates no session, and
   nothing it asks for is stored.

Two options are off until configured:

- **An off-server copy of each backup**, encrypted to an OpenPGP public key
  whose private half stays with you, into a bucket of any S3-compatible
  storage taking path-style requests signed with Signature Version 4. Create
  the Secret with the storage's static access key, keys `access-key-id` and
  `secret-access-key` (by default `<release>-offsite-backup`,
  `backup.offsite.existingSecret`), then add to the install:

  ```bash
  --set-string backup.offsite.bucket=<bucket> \
  --set-string backup.offsite.endpoint=https://<storage host> \
  --set-string backup.offsite.region=<region> \
  --set-file backup.offsite.recipientKey=<public key file>.asc
  ```

  With a bucket set the chart refuses to render without the endpoint, the
  region or the key.
- **A heartbeat monitor**: every 5 minutes a CronJob probes the site and the
  receive host and checks the node's disk, and each backup reports its
  outcome, to any service that takes a POST to `<url>/<token>` for a success
  and `<url>/<token>/fail` for a failure. Create the Secret with one token
  each under the keys `site`, `disk` and `backup` (by default
  `<release>-heartbeat`, `alerts.existingSecret`), then add
  `--set-string alerts.heartbeatUrl=<url>`.

`helm template` with the values above shows what an install creates, and
`scripts/chart.test.mjs` renders the chart the same way with its own renderer,
`scripts/chart-render.mjs`.

### On a test cluster

The steps above were followed from scratch on 2026-11-04 on one machine with
k3d 5.9.0, which runs k3s 1.35.5 in Docker, its packaged Traefik 3.6 included,
with cert-manager 1.21.1, Helm 4.3.1, kubectl 1.37.2 and Docker 29.9, the two
options left off (#374). There the node is a container and Let's Encrypt
cannot reach the cluster, so these commands take the place of step 1 and
step 4:

```bash
CLUSTER=inspector-test
REGISTRIES=$(mktemp)
printf 'mirrors:\n  "localhost:15000":\n    endpoint:\n      - http://%s-registry:5000\n' $CLUSTER > $REGISTRIES
k3d cluster create $CLUSTER --api-port 127.0.0.1:16443 \
  -p '127.0.0.1:18080:80@loadbalancer' -p '127.0.0.1:18443:443@loadbalancer' \
  --registry-create $CLUSTER-registry:127.0.0.1:15000 --registry-config $REGISTRIES \
  --kubeconfig-update-default=false --wait
export KUBECONFIG=$(k3d kubeconfig write $CLUSTER)
docker cp deploy/cluster/traefik-config.yaml \
  k3d-$CLUSTER-server-0:/var/lib/rancher/k3s/server/manifests/traefik-config.yaml
helm install cert-manager oci://quay.io/jetstack/charts/cert-manager --version v1.21.1 \
  --namespace cert-manager --create-namespace --set crds.enabled=true --wait
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
EOF
docker exec k3d-$CLUSTER-server-0 install -d -o 999 -g 999 -m 0700 /var/backups/webhook-inspector
```

- The cluster gets a kubeconfig file of its own and a registry, which Docker
  pushes to as `localhost:15000` and the cluster pulls from under the same
  name. Its load balancer answers on `127.0.0.1`, ports 18080 and 18443, and
  its API on 16443.
- Traefik's settings go into the node's container, the self-signed issuer
  takes the place of the Let's Encrypt issuers, and the backup directory is
  made in the node's container: the [Install](#install) section's `sudo install`
  line is left out.
- The values are `REGISTRY=localhost:15000`, `SITE_HOST=inspector.localhost`
  and `RECEIVE_HOST=hook.inspector.localhost`, names under `localhost`, which
  most systems resolve to the machine itself (where they do not, add both to
  `/etc/hosts` as `127.0.0.1`), and `ISSUER=selfsigned`. The registry takes
  no credentials, so the pods warned `FailedToRetrieveImagePullSecret` until
  the release was run again with `--set-string images.pullSecret=` (step 3).
- The site is at `https://inspector.localhost:18443/`. A webhook URL it gives
  names the receive host without a port, so a webhook goes to port 18443 of
  that URL. The certificates are self-signed with no issuer name, so neither
  `curl --cacert` nor the check script, which needs both hosts, can trust
  them: `curl -k`, and
  `NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/check-deployment.mjs https://inspector.localhost:18443 https://hook.inspector.localhost:18443`,
  which then stopped at the Terms of Use: the check expected this site's
  legal pages and contact address until it was given the image's settings
  (#381), with which step 6's call checks such a copy as built. That call was
  not run on the test cluster.
- To remove it all, the cluster with its registry and kubeconfig file, the
  registry settings file and the images built:

  ```bash
  k3d cluster delete $CLUSTER && rm -f $REGISTRIES && unset KUBECONFIG
  docker image rm $REGISTRY/backend:$TAG $REGISTRY/frontend:$TAG $REGISTRY/postgres:16-pgcron-1
  ```

### Deploying from GitLab CI

`.gitlab-ci.yml` does all of this on every merge to `main`: it validates,
builds the images into the project's registry, deploys from a runner inside
the server, and checks the result. A copy of the repository in another GitLab
project runs the same pipeline, nothing being included from another project,
with its own runners and these CI/CD variables of the project; no file of the
repository holds an installation's values:

| Variable | What it is | Read by | Environment |
| --- | --- | --- | --- |
| `DEPLOY_APP_ORIGIN` | The site's origin, `https://<host>` | frontend image, `deploy`, `deployment-smoke` | all |
| `DEPLOY_RECEIVE_ORIGIN` | The receive host's origin | frontend image, `deploy`, `deployment-smoke` | all |
| `DEPLOY_APP_ALIAS_ORIGIN` | The site's second origin; empty for none (below) | frontend image, `deploy`, `deployment-smoke` | all |
| `DEPLOY_STATUS_PAGE_URL` | The image's `STATUS_PAGE_URL`; empty for none | frontend image, `deployment-smoke` | all |
| `DEPLOY_CONTACT_EMAIL` | The image's `CONTACT_EMAIL`; empty for none | frontend image, `deployment-smoke` | all |
| `DEPLOY_OPERATOR_TEXTS` | The image's `OPERATOR_TEXTS`, `true` or `false`; empty for `false` | frontend image, `deployment-smoke` | all |
| `DEPLOY_ALIAS_TLS_SECRET` | The second host's certificate Secret; with a second origin | `deploy` | `production` |
| `DEPLOY_RECEIVE_TLS_SECRET` | The receive host's certificate Secret | `deploy` | `production` |
| `DEPLOY_POSTGRES_USER`, `DEPLOY_POSTGRES_DATABASE` | The database role and database | `deploy` | `production` |
| `DEPLOY_BACKUP_HOST_PATH` | The backup directory on the node | `deploy` | `production` |
| `DEPLOY_BACKUP_BUCKET` | The off-server copy's bucket; empty for none | `deploy` | `production` |
| `DEPLOY_BACKUP_ENDPOINT`, `DEPLOY_BACKUP_REGION`, `DEPLOY_BACKUP_SECRET` | Its storage and the Secret holding its key; with a bucket | `deploy` | `production` |
| `DEPLOY_BACKUP_RECIPIENT_KEY` | Type File: the public key the copies are encrypted to; with a bucket | `deploy` | `production` |
| `DEPLOY_HEARTBEAT_URL` | The heartbeat endpoint; empty for no monitor | `deploy` | `production` |
| `DEPLOY_HEARTBEAT_SECRET` | The Secret holding the heartbeat tokens; with a heartbeat URL | `deploy` | `production` |
| `DEPLOY_RUNNER_TAG` | The tag of the runner inside the server: letters, digits, `.`, `_` and `-`, starting with a letter or digit | `deploy`'s `tags:`, the rules of `deploy`, `deployment-smoke` and `deploy-runner-tag` | all |
| `QA_TOOLS_RUNNER_TAG` | The tag of the runner for every other job but the smoke; unset, GitLab's shared runners | every job's `tags:` but those two | all |
| `KUBECONFIG_DEPLOYER` | Type File, protected: the kubeconfig of `gitlab-deployer.yaml`'s ServiceAccount | `deploy` | `production` |

Each variable is set with no environment scope, but those the table marks
`production`, which only `deploy`, the one job with that environment, reads;
those may be protected, and none of the others should be, since a protected
variable never reaches a merge request's pipeline. `DEPLOY_RUNNER_TAG`, the
origins and the operator variables must not be scoped to `production`: the
runner tag is read when the pipeline is created, and the others by the image
build and the smoke, which have no environment. In the project's Settings →
CI/CD → Variables, set "Minimum role to use pipeline variables" to "No one
allowed": a variable given to a pipeline when it is run outranks the project's
own, and could send `deploy` to another runner or give the chart other values.

The deploy job stops before `helm upgrade` and names every variable it reads
that is not set, so an unset one cannot switch the backup's off-server copy or
the monitor off. It stops the same way for one set empty, but for the three
options: an empty second origin, bucket or heartbeat URL is none, and its
companions are then not needed. It refuses a value holding anything but
letters, digits and `.`, `_`, `:`, `/` and `-`, naming the variable and never
printing the value. With `DEPLOY_RUNNER_TAG` not set, or holding anything but
one runner tag, neither `deploy` nor `deployment-smoke` is created, so the job
holding the cluster's credential never runs untagged on a shared runner, and
the job `deploy-runner-tag` fails the pipeline before anything is built, naming
the variable. The pipeline installs the release `qa-tools` into the namespace
`qa-tools`.

On `main` the frontend image is built once per commit and published under the
commit's SHA; a rerun of the pipeline reuses it. It reads its variables when it
is first built, so a change of `DEPLOY_APP_ORIGIN`, `DEPLOY_RECEIVE_ORIGIN`,
`DEPLOY_APP_ALIAS_ORIGIN` or an operator variable reaches the image only with a
new commit, while `deploy` and the smoke read the new value at once: the
smoke, which checks the site against the operator variables, fails on a
changed one until a new commit's image carries it. For the
same reason the build stops before building, naming the variable, when one of
the six is not set, or the site's or the receive host's origin is empty: an
image built from the frontend's fallbacks would stay that commit's. An empty
second origin or operator variable is left out of the image.

An empty `DEPLOY_APP_ALIAS_ORIGIN` while `DEPLOY_APP_ORIGIN` is this site's
own, `https://qa-tools.ru`, removes the second host's Ingresses and certificate,
while the frontend image still names `https://webhook.qa-tools.ru`, the
build's default for this site (`apps/frontend/scripts/site-origin.mjs`); a copy
on its own origins has no second origin by default and is unaffected.

## Issues, contributions and security

The GitHub repository,
[`dmzyryanov/webhook-inspector`](https://github.com/dmzyryanov/webhook-inspector),
is a read-only mirror of the project's GitLab repository, where the work is
done. Issues are welcome on GitHub: a bug, a question or an idea. Pull requests
are not accepted, since every change goes through the project's own process.
Report a security problem by mail to `contact@qa-tools.ru`, not in a public
issue; [`SECURITY.md`](SECURITY.md) says the same.

## License

Webhook Inspector is released under the MIT License; see [`LICENSE`](LICENSE).
