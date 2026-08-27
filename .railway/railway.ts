import { defineRailway, empty, image, preserve, project, service, volume } from "railway/iac";

// Structural config only (source/build/deploy shape) — env vars, including
// secrets and cross-service references (DATABASE_URL, REDPANDA_BROKERS,
// ALLOWED_ORIGINS), are set imperatively via `railway variable set` instead
// of here, so nothing secret ever lands in this committed file; they show up
// below as `preserve()` (pulled from the real project via `railway config
// pull`, which never writes actual secret values into this file) purely so
// `railway config apply` doesn't try to delete them. See
// docs/tasks/TASK-railway-deploy.md.
export default defineRailway(() => {
  const redpandaVolume = volume("redpanda-volume", { region: "sfo", sizeMB: 5000 });
  const timescaledbVolume = volume("timescaledb-volume", { region: "sfo", sizeMB: 5000 });

  const timescaledb = service("timescaledb", {
    source: image("timescale/timescaledb:latest-pg17"),
    replicas: { sfo: 1 },
    volumeMounts: { "/var/lib/postgresql/data": timescaledbVolume },
    env: { PGDATA: preserve(), POSTGRES_DB: preserve(), POSTGRES_PASSWORD: preserve(), POSTGRES_USER: preserve() },
  });

  const redpanda = service("redpanda", {
    // A thin FROM-wrapper (infra/redpanda/Dockerfile) that switches to
    // USER root — Railway's fresh volume is root-owned and the upstream
    // image's non-root USER can't mkdir/chown into it on first boot
    // (confirmed live). See docs/tasks/TASK-railway-deploy.md §2.1.
    source: empty(),
    build: { builder: "DOCKERFILE", dockerfilePath: "infra/redpanda/Dockerfile" },
    replicas: { sfo: 1 },
    volumeMounts: { "/var/lib/redpanda/data": redpandaVolume },
    // Single internal listener — nothing needs to reach Kafka from outside
    // this project. Railway's startCommand bypasses the image's own
    // ENTRYPOINT (/entrypoint.sh, which execs via `rpk` and translates
    // these flags for the underlying Seastar binary) rather than appending
    // to it like docker-compose's `command:` does — so /entrypoint.sh must
    // be named explicitly here to get the same rpk-wrapped invocation
    // local dev relies on.
    start:
      "/entrypoint.sh redpanda start --kafka-addr internal://0.0.0.0:9092 --advertise-kafka-addr internal://redpanda.railway.internal:9092 --rpc-addr 0.0.0.0:33145 --advertise-rpc-addr redpanda.railway.internal:33145 --mode dev-container --smp 1 --default-log-level=info",
  });

  // ingest/consumer/api build from this repo's own Dockerfiles via a local
  // `railway up` upload (source: empty() — no GitHub App connection
  // required). Build context is always the repo root (turbo prune needs
  // the whole workspace visible), so only dockerfilePath varies per
  // service — docs/tasks/TASK-railway-deploy.md §2.3. `web` was removed
  // from Railway (2026-08-27) — it now runs on Vercel only, which gets it
  // real edge-cached data (Next's fetch Data Cache), not just a Docker
  // deploy; see docs/tasks/TASK-railway-deploy.md §7.
  // ingest is deployed with the repo's apps/ingest directory itself as the
  // upload root (`railway up ./apps/ingest --path-as-root`), not the repo
  // root — its Dockerfile's COPY paths (go.mod, go.sum) are written
  // relative to apps/ingest, matching local `docker build -f
  // apps/ingest/Dockerfile apps/ingest` testing. Confirmed live: pointing
  // dockerfilePath at "apps/ingest/Dockerfile" against a repo-root context
  // instead fails with "/go.mod: not found" — COPY paths always resolve
  // against the build context root, not the Dockerfile's own directory.
  const ingest = service("ingest", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    env: {
      EIA_API_KEY: preserve(),
      ENTSOE_API_TOKEN: preserve(),
      MAX_IN_FLIGHT: preserve(),
      POLL_INTERVAL: preserve(),
      READINGS_TOPIC: preserve(),
      REDPANDA_BROKERS: preserve(),
    },
  });

  const consumer = service("consumer", {
    source: empty(),
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/consumer/Dockerfile" },
    env: { DATABASE_URL: preserve(), READINGS_TOPIC: preserve(), REDPANDA_BROKERS: preserve() },
  });

  // api must stay single-replica — it runs a second in-process Kafka
  // consumer group ("live") fanning out over WebSocket; more than one
  // replica would split that group's partitions and drop live events for
  // some connected browsers (docs/architecture.md §4).
  const api = service("api", {
    source: empty(),
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/api/Dockerfile" },
    replicas: { sfo: 1 },
    env: {
      ALLOWED_ORIGINS: preserve(),
      DATABASE_URL: preserve(),
      EIA_API_KEY: preserve(),
      HOST: preserve(),
      LIVE_GROUP_ID: preserve(),
      LIVE_HEARTBEAT_MS: preserve(),
      PORT: preserve(),
      READINGS_TOPIC: preserve(),
      REDPANDA_BROKERS: preserve(),
    },
  });

  return project("renewable-pulse", {
    resources: [timescaledb, redpanda, redpandaVolume, timescaledbVolume, ingest, consumer, api],
  });
});
