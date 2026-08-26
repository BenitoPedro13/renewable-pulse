# TASK-railway-deploy

## 1. Current scenario

Phases 1–4 are code-complete and running locally: `apps/ingest` (Go), `apps/consumer` (Node,
"persist" consumer group + migrations-on-startup), `apps/api` (Fastify REST + `/live`
WebSocket, also runs the "live" Kafka consumer group in-process), and `apps/web` (Next.js
dashboard) all work against a Docker-composed Redpanda + TimescaleDB locally
(`infra/docker-compose.yml`), with ~380k+ real rows ingested from ONS. ENTSO-E is code-complete
but unverified live pending a token (`ENTSOE_API_TOKEN` unset — `apps/ingest` self-disables that
poller, per `docs/architecture.md` §3).

**Nothing is deployed anywhere.** No Dockerfile exists for any of the four apps. No Railway
project exists. The user is already authenticated to the Railway CLI (`designmainnet@gmail.com`
— confirmed via `railway whoami`), and this is the account production should go on.

## 2. Planned changes

Six Railway services in one new project, one Railway environment (`production`):

| Service | Source | Public networking |
|---|---|---|
| `redpanda` | Docker image `docker.redpanda.com/redpandadata/redpanda:v26.2.2` | None — internal only |
| `timescaledb` | Docker image `timescale/timescaledb:latest-pg17` | None — internal only |
| `ingest` | `apps/ingest/Dockerfile`, build context = repo root | None (no ports) |
| `consumer` | `apps/consumer/Dockerfile`, build context = repo root | None (no ports) |
| `api` | `apps/api/Dockerfile`, build context = repo root | Railway-generated HTTPS domain, 1 replica (hard requirement) |
| `web` | `apps/web/Dockerfile`, build context = repo root | Railway-generated HTTPS domain |

Decided with the user (2026-08-26): self-host TimescaleDB on Railway rather than Timescale
Cloud (keeps billing/ops in one place); skip a Redpanda console service for now (DLQ already
has a CLI, `pnpm --filter consumer dlq`); provision and deploy for real once this doc + the
Dockerfiles are written, on the already-authenticated `designmainnet@gmail.com` account.

### 2.1 Redpanda service

Deployed from the public image directly (no repo Dockerfile). Single internal listener only —
nothing needs to reach Kafka from outside the project, so `pandaproxy`/`schema-registry`
listeners from the local compose file are dropped, not carried over:

```
redpanda start
  --kafka-addr internal://0.0.0.0:9092
  --advertise-kafka-addr internal://redpanda.railway.internal:9092
  --rpc-addr redpanda.railway.internal:33145
  --advertise-rpc-addr redpanda.railway.internal:33145
  --mode dev-container
  --smp 1
  --default-log-level=info
```

`redpanda.railway.internal` is Railway's private-network DNS name for a service named
`redpanda` (verify the exact hostname via `railway private-network status` once the service
exists — Railway's default private network is named `railway`). A Railway volume is attached at
`/var/lib/redpanda/data`, mirroring the local compose volume.

### 2.2 TimescaleDB service

Deployed from `timescale/timescaledb:latest-pg17` directly (no repo Dockerfile), matching the
local compose service. `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` set as service
variables (Railway-generated password, not the local `renewable_pulse`/`renewable_pulse` dev
credential). A Railway volume attached at `/var/lib/postgresql/data`. `DATABASE_URL` for
`consumer`/`api` is built from this service's own Railway-injected connection variables
(`${{timescaledb.PGHOST}}` etc., exact reference names confirmed once the service is created —
Railway's variable-reference syntax, not hand-typed).

### 2.3 Dockerfiles for the four apps

**`apps/ingest/Dockerfile`** — plain multi-stage Go build (no monorepo/pnpm involvement; the Go
module is self-contained under `apps/ingest`). `CGO_ENABLED=0`, `franz-go` is a pure-Go Kafka
client so a `distroless/static` final stage works. Root Directory in Railway = `apps/ingest`.

**`apps/consumer/Dockerfile`, `apps/api/Dockerfile`** — follow Turborepo's own documented Docker
pattern (`turbo prune <app> --docker`) rather than hand-copying files: a `pruner` stage computes
the minimal workspace subset (the target app + `packages/contracts` + `packages/config`), an
`installer` stage runs `pnpm install --frozen-lockfile` against the pruned lockfile then `turbo
build --filter=<app>` (satisfies `apps/consumer`/`apps/api`'s `dependsOn: ["^build"]` on
`packages/contracts` — this is the exact problem flagged in the deploy brief). Base image
`node:24-bookworm-slim` (glibc, not Alpine/musl) for both build and runtime stages, with
`build-essential`/`python3` installed in the installer stage — `@confluentinc/kafka-javascript`
compiles a native `librdkafka` binding via node-gyp, which needs a real toolchain and is a known
risk point on musl. Build context = repo root (Railway "Root Directory" = `.`, custom Dockerfile
path per service) so `turbo prune` can see the whole workspace.

**`apps/web/Dockerfile`** — same `turbo prune web --docker` shape, plus `output: "standalone"`
added to `apps/web/next.config.ts` (not currently set) so the runtime image only needs the
standalone server bundle, not the full `node_modules`. `NEXT_PUBLIC_API_BASE_URL` and
`NEXT_PUBLIC_MAPBOX_TOKEN` are build-time-inlined by Next.js (`NEXT_PUBLIC_*` convention) so they
must be present as Railway build-time variables, not just runtime ones.

### 2.4 Env vars (see `.env.example` for the full annotated list; values below are what changes for prod)

- `ingest`: `REDPANDA_BROKERS=redpanda.railway.internal:9092`, `READINGS_TOPIC=readings`,
  `POLL_INTERVAL=1h`, `MAX_IN_FLIGHT=64`, `EIA_API_KEY` (real value, from the user's local
  `.env` — set directly on Railway, never committed), `ENTSOE_API_TOKEN` left **unset** (not
  issued yet — poller self-disables, dashboard correctly shows missing data per the no-fake-data
  invariant).
- `consumer`: `DATABASE_URL` (Railway variable reference to `timescaledb`), `REDPANDA_BROKERS`,
  `READINGS_TOPIC`.
- `api`: `DATABASE_URL`, `REDPANDA_BROKERS`, `READINGS_TOPIC`, `PORT` (Railway injects this;
  `apps/api/src/index.ts` already reads `process.env.PORT` correctly), `HOST=0.0.0.0`,
  `ALLOWED_ORIGINS=https://<web's real Railway domain>` (not `localhost:3000`),
  `LIVE_GROUP_ID=live`, `LIVE_HEARTBEAT_MS=30000`, `EIA_API_KEY` (for `GET /plants?source=EIA_860`).
- `web`: `NEXT_PUBLIC_API_BASE_URL=https://<api's real Railway domain>`,
  `NEXT_PUBLIC_MAPBOX_TOKEN` (real token, borrowed from the sibling `flora` project's Mapbox
  account per the deploy brief).

`api`'s domain must be known before building `web` (build-time env var), and `web`'s domain must
be known before setting `api`'s `ALLOWED_ORIGINS` — provisioning order: create both services and
their domains first, then set the cross-referencing env vars, then deploy.

### 2.5 Single-replica constraint on `api`

`apps/api` runs a second in-process Kafka consumer group (`live`) fanning out over WebSocket —
`docs/architecture.md` §4 and the deploy brief both call out that more than one replica would
split that group's partitions and silently drop live events for some connected browsers. Railway
does not autoscale replicas by default, but this is set explicitly (not left to the default) on
the `api` service to guard against it being changed later without this constraint in mind.

## 3. Why

Turbo's own `--docker` prune flag exists specifically for this "monorepo app depends on an
internal package that must be built first" problem (per CLAUDE.md rule 2: use the official
CLI/generator, don't hand-roll it) — the alternative (copying the whole repo into every image and
running a full `turbo build` at the root) works but produces much larger images and rebuilds
unrelated apps on every deploy. Self-hosting Redpanda and TimescaleDB as raw Docker services
matches how `infra/docker-compose.yml` already runs them locally (same images, same one-broker/
one-Postgres shape), so there's no new operational model to learn for a case-study project.

## 4. Affected files

- New: `apps/ingest/Dockerfile`, `apps/consumer/Dockerfile`, `apps/api/Dockerfile`,
  `apps/web/Dockerfile`, root `.dockerignore`.
- Modified: `apps/web/next.config.ts` (`output: "standalone"`), `.env.example` (if any prod-only
  var needs documenting beyond what's already there), `README.md` (status line + a "Deployment"
  section once live), `docs/architecture.md` §6 (deployment row, currently says "Railway, own
  project" with no detail).
- Railway-side (not repo files): one new project, 6 services, 2 volumes, cross-service env vars,
  2 generated domains (`api`, `web`).

## 5. Verification

- ✅ Each Dockerfile builds successfully locally (`docker build`) before anything was pushed to
  Railway — caught a real bug this way: `turbo`/`pnpm` invoked via `npx`/`pnpm dlx` inside the
  image choke on this repo's root `devEngines.packageManager` range (`^11.21.0`) under Corepack's
  stricter validation ("Invalid package manager specification ... expected a semver version");
  fixed by installing `pnpm`/`turbo` as plain global `npm` packages instead (matches how pnpm is
  actually installed locally — a plain global install, not a Corepack shim).
- ✅ Live on Railway, project `renewable-pulse`, environment `production`:
  `https://renewable-pulse.up.railway.app` (web) and
  `https://api-production-31f3.up.railway.app` (api). `GET /pipeline-health` returns real,
  non-zero numbers (`dlqDepth: 0`, `consumerLag: 0` once drained, `lastPollBySource` populated
  for ONS and EIA with real timestamps) — confirms the full chain (ingest → Redpanda → consumer →
  TimescaleDB → api) is live on real infra.
- ✅ `web`'s dashboard loads (HTTP 200) with no `localhost` URLs in its bundle —
  `NEXT_PUBLIC_API_BASE_URL`/`ALLOWED_ORIGINS` wired to the real generated domains, not left at
  `.env.example` defaults.
- ✅ `api` runs at 1 replica (`replicas: { sfo: 1 }` in `.railway/railway.ts`).
- ✅ Idempotency spot-check: `ingest` was redeployed/restarted multiple times during setup; the
  full automated idempotency test already in `apps/consumer`'s suite is what actually guards this,
  this was just an informal sanity check that row counts didn't visibly explode.

### 5.1 Platform-specific issues hit and resolved (2026-08-26)

Worth recording since none of these are documented anywhere obvious and each cost real
debugging time:

1. **`docker.redpanda.com` is unreachable from Railway's build fleet.** `FROM
   docker.redpanda.com/redpandadata/redpanda:v26.2.2` in a custom Dockerfile fails near-instantly
   with zero build log output (confirmed via an isolated single-line-Dockerfile test, ruling out
   anything about our own Dockerfiles). The same image is mirrored to Docker Hub
   (`redpandadata/redpanda:v26.2.2`), which pulls fine — `infra/redpanda/Dockerfile` uses that
   instead. `infra/docker-compose.yml` (local dev) is unaffected and still uses the
   `docker.redpanda.com` reference directly.
2. **Railway's fresh volumes are root-owned; images with a non-root `USER` can't write to them.**
   Redpanda's official image runs as `USER redpanda`; on first boot it can't `mkdir`/`chown` into
   the mounted volume ("Operation not permitted" — confirmed even a `chown` attempt in the start
   command fails, since a non-root user can't `chown` a path it doesn't own). Fixed with a
   two-line Dockerfile wrapper (`infra/redpanda/Dockerfile`) that adds `USER root`.
3. **Railway's `startCommand` bypasses an image's `ENTRYPOINT` instead of appending to it** the
   way `docker-compose`'s `command:` does. Redpanda's image `ENTRYPOINT` (`/entrypoint.sh`) wraps
   the real binary via `rpk`, which translates CLI flags for the underlying Seastar binary calling
   the raw binary directly (skipping `/entrypoint.sh`) fails with `unrecognised option
   '--kafka-addr'` even though the flag is valid. Fixed by naming `/entrypoint.sh` explicitly as
   the first word of the Railway start command.
4. **Postgres/TimescaleDB's data volume mount point isn't empty on Railway** — it contains a
   `lost+found` directory (ext4 artifact), and `initdb` refuses to use a non-empty directory
   directly as its data directory. Fixed with `PGDATA=/var/lib/postgresql/data/pgdata` (a
   subdirectory under the mount) — a Railway/Postgres-specific setting, not something
   `.env.example` needs since local `docker-compose` doesn't hit this.
5. **Docker build-context vs. Dockerfile-path resolution differs from local `docker build -f
   apps/ingest/Dockerfile apps/ingest`.** `apps/ingest/Dockerfile`'s `COPY go.mod go.sum ./` was
   written assuming the build context is `apps/ingest` itself (exactly how it was tested
   locally). Pointing Railway's `build.dockerfilePath` at `"apps/ingest/Dockerfile"` against a
   repo-root context instead fails with `"/go.mod": not found` — `COPY` paths always resolve
   against the build context root, not the Dockerfile's own directory. Fixed by deploying
   `ingest` with `apps/ingest` itself as the upload root (`railway up ./apps/ingest
   --path-as-root --service ingest`) instead of the repo root; `consumer`/`api`/`web` correctly
   keep the repo-root context since `turbo prune` needs the whole workspace visible.
6. **The Redpanda topics (`readings`, `readings.dlq`) don't exist until something creates
   them** — `apps/ingest`'s producer got `UNKNOWN_TOPIC_OR_PARTITION` on the very first deploy
   despite Redpanda's `auto_create_topics_enabled` being on, because nothing had produced to (or
   explicitly created) those topics yet on the brand-new broker. Fixed with a one-time `railway
   ssh --service redpanda -- rpk topic create readings readings.dlq --brokers localhost:9092`.
   Local dev doesn't hit this because `infra/docker-compose.yml`'s own setup already creates these
   topics on first `docker-compose up` (see the Quickstart in `README.md`).
7. **Railway's `environment edit --service-config` CLI subcommand appears non-functional** in
   the tested CLI version (5.44.1) — every invocation (start command, a plain variable, even
   trying different flag combinations) silently returned `{"committed":false,"message":"No
   changes to apply"}` with no error. Worked around entirely via `.railway/railway.ts`
   (config-as-code) for structural service config and `railway variable set` for env vars — both
   confirmed working. `railway volume add --service <name>` also panicked
   (`Option::unwrap()` on `None`); worked around by `railway service link <name>` first, then
   `railway volume add --mount-path <path>` without the `--service` flag.
