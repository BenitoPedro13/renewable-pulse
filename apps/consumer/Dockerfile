# Build context = repo root (Railway Root Directory = "."). Uses Turborepo's
# own `turbo prune --docker` so this image only carries apps/consumer + the
# internal packages it actually depends on (packages/contracts,
# packages/config), instead of the whole monorepo — see
# docs/tasks/TASK-railway-deploy.md §2.3.
FROM node:24-bookworm-slim AS base
# pnpm and turbo are installed as plain global npm packages, not via
# corepack. Corepack applies its own stricter devEngines.packageManager
# validation (requires an exact version, rejects the root package.json's
# "^11.21.0" range with "Invalid package manager specification ...
# expected a semver version") that a plain pnpm binary doesn't hit — this
# matches how pnpm is actually installed in local dev (a plain global
# install, not a corepack shim; confirmed via `which pnpm`).
RUN npm install -g pnpm@11.24.0 turbo@2.10.11

FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune consumer --docker

FROM base AS installer
WORKDIR /app
# @confluentinc/kafka-javascript compiles a native librdkafka binding via
# node-gyp — needs a real toolchain, which is why this stays on
# node:24-bookworm-slim (glibc) rather than an Alpine/musl base.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=consumer

FROM base AS runner
WORKDIR /app
COPY --from=installer /app .

CMD ["node", "apps/consumer/dist/index.js"]
