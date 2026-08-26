# Build context = repo root (Railway Root Directory = "."). Combines
# Turborepo's `turbo prune --docker` (only web + packages/contracts) with
# Next.js's standalone output (apps/web/next.config.ts) — see
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
RUN turbo prune web --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, not
# read at runtime — Railway passes matching service variables in as
# --build-arg automatically when an ARG of the same name exists here.
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_MAPBOX_TOKEN
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_MAPBOX_TOKEN=$NEXT_PUBLIC_MAPBOX_TOKEN

RUN pnpm turbo run build --filter=web

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Next's standalone output traces the minimal server + node_modules subset
# but deliberately excludes public/ and .next/static — copied in separately
# per Next.js's own standalone-output docs.
COPY --from=installer /app/apps/web/public ./apps/web/public
COPY --from=installer /app/apps/web/.next/standalone ./
COPY --from=installer /app/apps/web/.next/static ./apps/web/.next/static

# Next's standalone server.js already reads process.env.PORT (Railway
# injects it) and defaults to 3000 locally.
CMD ["node", "apps/web/server.js"]
