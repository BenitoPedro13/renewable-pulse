#!/bin/bash
# Ships infra/aws/{compose.prod.yml,Caddyfile,deploy.sh} to the EC2 host and runs deploy.sh
# there, all through SSM Run Command (no SSH). Used from the Mac and from CI
# (docs/tasks/TASK-aws-infra.md §2.5).
#
#   infra/aws/remote-deploy.sh <image-tag> [s3://bucket/key.dump]
set -euo pipefail

IMAGE_TAG="${1:?usage: remote-deploy.sh <image-tag> [restore-s3-uri]}"
RESTORE_URI="${2:-}"
REGION=us-east-1
HERE="$(cd "$(dirname "$0")" && pwd)"

# Found by tag rather than a hard-coded ID, so an instance replacement needs no script change.
INSTANCE_ID="$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=tag:Name,Values=renewable-pulse-app Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
[ "$INSTANCE_ID" != "None" ] || { echo "no running renewable-pulse-app instance" >&2; exit 1; }

BUNDLE="$(tar -C "$HERE" -czf - compose.prod.yml Caddyfile deploy.sh | base64 | tr -d '\n')"

PARAMS="$(python3 -c '
import json, sys
bundle, tag, restore = sys.argv[1:4]
print(json.dumps({"commands": [
    "set -euo pipefail",
    "mkdir -p /opt/renewable-pulse",
    f"echo {bundle} | base64 -d | tar -xzf - -C /opt/renewable-pulse",
    f"bash /opt/renewable-pulse/deploy.sh {tag} {restore}".rstrip(),
], "executionTimeout": ["1800"]}))
' "$BUNDLE" "$IMAGE_TAG" "$RESTORE_URI")"

COMMAND_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "renewable-pulse deploy $IMAGE_TAG" \
  --parameters "$PARAMS" \
  --query Command.CommandId --output text)"
echo "deploy $IMAGE_TAG -> $INSTANCE_ID (command $COMMAND_ID)"

while true; do
  sleep 10
  STATUS="$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in
    Pending|InProgress|Delayed) continue ;;
    *) break ;;
  esac
done

aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" --query '[StandardOutputContent,StandardErrorContent]' --output text

echo "status: $STATUS"
[ "$STATUS" = "Success" ]
