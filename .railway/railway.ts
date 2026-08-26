import { defineRailway, empty, image, project, service, volume } from "railway/iac";

// Structural config only (source/build/deploy shape) — env vars, including
// secrets and cross-service references (DATABASE_URL, REDPANDA_BROKERS,
// ALLOWED_ORIGINS, NEXT_PUBLIC_*), are set imperatively via
// `railway variable set` instead of here, so nothing secret ever lands in
// this committed file. See docs/tasks/TASK-railway-deploy.md.
export default defineRailway(() => {
  const redpandaVolume = volume("redpanda-volume", { region: "sfo", sizeMB: 5000 });
  const timescaledbVolume = volume("timescaledb-volume", { region: "sfo", sizeMB: 5000 });

  const timescaledb = service("timescaledb", {
    source: image("timescale/timescaledb:latest-pg17"),
    replicas: { sfo: 1 },
    volumeMounts: { "/var/lib/postgresql/data": timescaledbVolume },
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

  // ingest/consumer/api/web build from this repo's own Dockerfiles via a
  // local `railway up` upload (source: empty() — no GitHub App connection
  // required). Build context is always the repo root (turbo prune needs
  // the whole workspace visible), so only dockerfilePath varies per
  // service — docs/tasks/TASK-railway-deploy.md §2.3.
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
  });

  const consumer = service("consumer", {
    source: empty(),
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/consumer/Dockerfile" },
  });

  // api must stay single-replica — it runs a second in-process Kafka
  // consumer group ("live") fanning out over WebSocket; more than one
  // replica would split that group's partitions and drop live events for
  // some connected browsers (docs/architecture.md §4).
  const api = service("api", {
    source: empty(),
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/api/Dockerfile" },
    replicas: { sfo: 1 },
  });

  const web = service("web", {
    source: empty(),
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/web/Dockerfile" },
  });

  return project("renewable-pulse", {
    resources: [timescaledb, redpanda, redpandaVolume, timescaledbVolume, ingest, consumer, api, web],
  });
});
