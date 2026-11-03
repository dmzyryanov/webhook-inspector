# Webhook Inspector

Webhook Inspector gives you a temporary webhook URL and shows every HTTP
request it receives, as it arrives: method, target, headers, query string, raw
body, source address, size and time. Point a system under test at the URL,
watch its webhooks come in, and tell it what to answer — a status, headers, a
body, a delay, a queue of answers or rules per path. No registration; sessions
are temporary, and are not meant for sensitive production data.

It is built for QA engineers and developers, designed for the desktop and
usable on tablets and phones. It is a service of QA Tools.

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

The documents cite decisions (`D123`) and issues (`#123`) by number. The
numbers are references to the decision log and the issue tracker of the QA
Tools project, which are not published.

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

Production runs on a single k3s server: the chart in `deploy/helm/qa-tools`
deploys the backend, the frontend, PostgreSQL, the nightly backup and a site
monitor into one namespace. The release, the namespace and the chart are named
`qa-tools`, the project's earlier name.

1. **The cluster.** k3s with the Traefik it packages, and cert-manager. Then,
   from this repository:
   - `deploy/cluster/traefik-config.yaml` — Traefik's redirect to HTTPS, its
     timeouts, and `externalTrafficPolicy: Local`, so the backend sees each
     sender's own address. Its header says where k3s takes it.
   - `deploy/cluster/letsencrypt-issuers.yaml` — the Let's Encrypt issuers.
     Put your own contact e-mail in it before applying it.
   - `deploy/cluster/gitlab-deployer.yaml` — only for deploying from CI: a
     ServiceAccount limited to the namespace.
2. **The images.** Build and push the three images to a registry the cluster
   can pull from, under `<registry>/backend:<tag>`, `<registry>/frontend:<tag>`
   and `<registry>/postgres:16-pgcron-1`:

   ```bash
   docker build -f apps/backend/Dockerfile -t <registry>/backend:<tag> .
   docker build -f apps/frontend/Dockerfile \
     --build-arg APP_ORIGIN=https://inspector.example \
     --build-arg RECEIVE_ORIGIN=https://hook.inspector.example \
     -t <registry>/frontend:<tag> .
   docker build -f deploy/postgres/Dockerfile -t <registry>/postgres:16-pgcron-1 deploy/postgres
   ```

   The frontend image names its address when it is built, so a copy on another
   address builds its own. It names its operator the same way, with three more
   build arguments, each left out when unset — the repository falls back to
   none of this site's:

   | Build argument    | What it names                                                                                                                                                                                                | Unset                                                                                                                                                       |
   | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `STATUS_PAGE_URL` | The status page, an http or https address with no query or fragment: the header's `Status ↗` link, the `/status` and `/status/` redirect, the status line of `llms.txt` and the API reference's sentence. | No status link and no such line; `/status` is the site's `Page not found`.                                                                                  |
   | `CONTACT_EMAIL`   | The contact address: the footer's `Contact:`, the about pages' last paragraph, `/.well-known/security.txt` and the API description's `info.contact`.                                                        | No address anywhere, and no `security.txt` (404).                                                                                                           |
   | `OPERATOR_TEXTS`  | `true` shows this site's own texts: the Terms of Use at `/terms`, the Privacy Policy at `/privacy`, the footer's links to them, and the about pages' lines on who runs the service and who pays for it.      | Neither page (`/terms` and `/privacy` are `Page not found`), no link to them, and the about pages describe the service alone. `true` needs the other two. |

   This site's image sets all three in `.gitlab-ci.yml`. The texts behind
   `OPERATOR_TEXTS` are this site's operator's and name its hosting; a copy
   leaves them off. `scripts/check-deployment.mjs` below still expects this
   site's contact address and legal pages, so a copy built without them
   fails those of its checks.
3. **The namespace and its Secrets.** The database password, which the chart
   reads and never holds:

   ```bash
   kubectl create namespace qa-tools
   kubectl -n qa-tools create secret generic qa-tools-postgres --from-literal=password=<password>
   ```

   For a private registry, a `docker-registry` Secret named `gitlab-registry`
   (`images.pullSecret`). The alerts (`alerts`, Secret `qa-tools-statuser`)
   and the off-server copy of the backups (`backup.offsite`, an S3-compatible
   bucket, Secret `qa-tools-offsite-backup`) take credentials of their own:
   the release installs and runs without them, and the site monitor and the
   nightly backup then report the missing credential as a failure in their
   logs. The nightly backup writes to the node's
   `/var/backups/qa-tools/nightly` (`backup.hostPath`), which must exist.
4. **DNS.** An `A` record for the site's host and one for the receive host,
   both pointing at the server.
5. **The release.** Migrations run in the backend's init container on every
   upgrade.

   ```bash
   helm upgrade --install qa-tools deploy/helm/qa-tools \
     --namespace qa-tools \
     --set-string images.registry=<registry> \
     --set-string images.tag=<tag> \
     --set-string ingress.host=inspector.example \
     --set-string receive.host=hook.inspector.example \
     --set-string alerts.siteUrl=https://inspector.example \
     --wait --timeout 10m
   ```

   Every value is described in `deploy/helm/qa-tools/values.yaml`.
   `node scripts/check-deployment.mjs https://inspector.example https://hook.inspector.example`
   then checks the deployed site from outside, as CI does after each
   deployment.

`.gitlab-ci.yml` does all of this on every merge to `main`: it validates,
builds the images into the project's registry, deploys with the command above
from a runner inside the server, and checks the result. A copy of the
repository in another GitLab project runs the same pipeline with its own
runners and the CI/CD variable `KUBECONFIG_DEPLOYER`; nothing is included
from another project.

## License

To be added.
