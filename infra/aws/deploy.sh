#!/bin/bash
# Runs ON the EC2 host, as root, from /opt/renewable-pulse (docs/tasks/TASK-aws-infra.md §2.4).
# Invoked through SSM Run Command by infra/aws/remote-deploy.sh (from the Mac or CI), never
# over SSH.
#
#   deploy.sh <image-tag> [s3://bucket/key.dump]
#
# With the optional second argument, restores that pg_dump into an EMPTY database before the
# app services start (first-time migration or disaster recovery). It refuses to restore over
# existing data.
set -euo pipefail

IMAGE_TAG="${1:?usage: deploy.sh <image-tag> [restore-s3-uri]}"
RESTORE_URI="${2:-}"
cd "$(dirname "$0")"

REGION=us-east-1
SSM_PATH=/renewable-pulse/prod
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

echo "==> deploy $IMAGE_TAG"

# --- Env file from SSM (root-only; values never printed) --------------------------------------
umask 077
{
  aws ssm get-parameters-by-path --region "$REGION" --path "$SSM_PATH" --with-decryption \
    --query 'Parameters[*].[Name,Value]' --output text |
    while IFS=$'\t' read -r name value; do
      key="${name##*/}"
      # "UNSET" is Terraform's placeholder: treat as absent, so optional pollers self-disable.
      [ "$value" = "UNSET" ] && value=""
      printf '%s=%s\n' "$key" "$value"
    done
  printf 'ECR_REGISTRY=%s\nIMAGE_TAG=%s\nCADDYFILE_SHA256=%s\n' "$ECR_REGISTRY" "$IMAGE_TAG" "$(sha256sum Caddyfile | cut -d' ' -f1)"
} > .env.new
mv .env.new .env
umask 022

if ! grep -qE '^POSTGRES_PASSWORD=.+' .env; then
  echo "POSTGRES_PASSWORD is not set in SSM ($SSM_PATH/POSTGRES_PASSWORD); refusing to deploy" >&2
  exit 1
fi

# --- Host directories on the data volume ------------------------------------------------------
mountpoint -q /data || { echo "/data is not mounted; refusing to deploy" >&2; exit 1; }
mkdir -p /data/redpanda /data/timescaledb /data/caddy /data/restore
chown 101:101 /data/redpanda # the redpanda image runs as uid 101

# --- Images --------------------------------------------------------------------------------------
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker compose -f compose.prod.yml pull --quiet

# --- Data services first ----------------------------------------------------------------------
docker compose -f compose.prod.yml up -d --wait --wait-timeout 300 redpanda timescaledb

# Topics must exist before the producer's first publish (TASK-railway-deploy.md §5.1 item 6).
for topic in readings readings.dlq; do
  docker compose -f compose.prod.yml exec -T redpanda rpk topic describe "$topic" >/dev/null 2>&1 ||
    docker compose -f compose.prod.yml exec -T redpanda rpk topic create "$topic"
done

psql_db() {
  docker compose -f compose.prod.yml exec -T timescaledb \
    psql -v ON_ERROR_STOP=1 -U renewable_pulse -d renewable_pulse -tAc "$1"
}

# --- Optional restore, only into an empty database -----------------------------------------
if [ -n "$RESTORE_URI" ]; then
  if [ "$(psql_db "SELECT to_regclass('public.readings') IS NOT NULL")" = "t" ]; then
    echo "restore requested but public.readings already exists; refusing to overwrite data" >&2
    exit 1
  fi
  echo "==> restoring $RESTORE_URI"
  aws s3 cp --only-show-errors "$RESTORE_URI" /data/restore/restore.dump
  # Official TimescaleDB sequence: pre_restore -> pg_restore (never -j) -> post_restore.
  psql_db "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();"
  # Rehearsed locally 2026-09-27 against the same image digest: a full dump restores with zero
  # errors, so ANY pg_restore error fails the deploy.
  set +e
  docker compose -f compose.prod.yml exec -T timescaledb \
    pg_restore -U renewable_pulse -d renewable_pulse --no-owner /restore/restore.dump 2> /data/restore/pg_restore.err
  set -e
  psql_db "SELECT timescaledb_post_restore();"
  errors="$(grep -c '^pg_restore: error' /data/restore/pg_restore.err || true)"
  echo "pg_restore: $errors error(s); full log in /data/restore/pg_restore.err"
  [ "$errors" -eq 0 ] || { cat /data/restore/pg_restore.err >&2; exit 1; }
  # Backfill the whole continuous aggregate (TASK-railway-deploy.md §5.1 item 8). post_restore
  # re-enables background jobs, and the aggregate's own policy often starts refreshing at the
  # same moment ("concurrent refresh", seen in the local rehearsal). Retry, then warn rather
  # than fail: the policy converges on its own.
  for attempt in 1 2 3 4 5 6; do
    psql_db "CALL refresh_continuous_aggregate('generation_hourly', NULL, NULL);" && break
    echo "continuous aggregate refresh attempt $attempt failed; retrying in 20s" >&2
    sleep 20
  done
  rm -f /data/restore/restore.dump
  psql_db "SELECT source, count(*) FROM readings GROUP BY 1 ORDER BY 1"
fi

# --- Apps + TLS proxy ---------------------------------------------------------------------------
docker compose -f compose.prod.yml up -d --wait --wait-timeout 300 --remove-orphans

docker compose -f compose.prod.yml exec -T api node -e \
  "fetch('http://127.0.0.1:3001/pipeline-health').then(r=>r.text()).then(t=>{console.log(t)})"

docker image prune -f >/dev/null
echo "==> deploy $IMAGE_TAG complete"
