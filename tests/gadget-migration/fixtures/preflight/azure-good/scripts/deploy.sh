# in scripts/deploy.sh
# usage: bash scripts/deploy.sh staging v43   or   bash scripts/deploy.sh production v43
set -euo pipefail
ENV="${1:?usage: deploy.sh staging|production <tag>}"
TAG="${2:?usage: deploy.sh staging|production <tag>}"
RG="my-app-${ENV}"
IMAGE="myappregistry.azurecr.io/my-app:${TAG}"

az acr build --registry myappregistry --image "my-app:${TAG}" .

# migrations once, before any app runs the new image
az containerapp job update --resource-group "$RG" --name my-app-migrate --image "$IMAGE" >/dev/null
EXECUTION="$(az containerapp job start --resource-group "$RG" --name my-app-migrate --query name --output tsv)"
# job start returns once the execution exists, so wait for it to end, for at most its --replica-timeout
DEADLINE=$((SECONDS + 3600))
while true; do
  STATUS="$(az containerapp job execution show --resource-group "$RG" --name my-app-migrate \
    --job-execution-name "$EXECUTION" --query properties.status --output tsv)"
  case "$STATUS" in
    Succeeded) break ;;
    Failed|Stopped|Degraded) echo "migration $EXECUTION ended as $STATUS; its output is in the job's execution history"; exit 1 ;;
  esac
  if [ "$SECONDS" -ge "$DEADLINE" ]; then echo "migration $EXECUTION is still $STATUS after an hour"; exit 1; fi
  sleep 10
done

# readers before the web app, so every message a new web revision sends has a worker that knows it
az containerapp update --resource-group "$RG" --name my-app-worker --image "$IMAGE" >/dev/null
for job in my-app-long-jobs prune-audit-logs; do
  # prune-audit-logs exists only after the cutover's Move scheduled work step
  if az containerapp job show --resource-group "$RG" --name "$job" >/dev/null 2>&1; then
    az containerapp job update --resource-group "$RG" --name "$job" --image "$IMAGE" >/dev/null
  fi
done
az containerapp update --resource-group "$RG" --name my-app-web --image "$IMAGE" >/dev/null
