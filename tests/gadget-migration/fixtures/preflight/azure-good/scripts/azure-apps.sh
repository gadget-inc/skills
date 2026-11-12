# in scripts/azure-apps.sh
# usage: bash scripts/azure-apps.sh production v42 <version of database-url> <shopify-api-secret> <migrate-database-url> <lock-database-url>
# Creates every app and job once, after azure-env.sh and after the four secrets are stored in Key Vault.
# Each later deploy runs scripts/deploy.sh instead.
set -euo pipefail
USAGE="usage: azure-apps.sh staging|production <tag> <versions of database-url shopify-api-secret migrate-database-url lock-database-url>"
ENV="${1:?$USAGE}"
TAG="${2:?$USAGE}"
DATABASE_URL_VERSION="${3:?$USAGE}"
SHOPIFY_SECRET_VERSION="${4:?$USAGE}"
MIGRATE_URL_VERSION="${5:?$USAGE}"
LOCK_URL_VERSION="${6:?$USAGE}"
RG="my-app-${ENV}"
VAULT_URL="https://my-app-${ENV}-vault.vault.azure.net/secrets"
IMAGE="myappregistry.azurecr.io/my-app:${TAG}"
APP_IDENTITY="$(az identity show --resource-group "$RG" --name my-app --query id --output tsv)"
APP_CLIENT_ID="$(az identity show --resource-group "$RG" --name my-app --query clientId --output tsv)"
MIGRATE_IDENTITY="$(az identity show --resource-group "$RG" --name my-app-migrate --query id --output tsv)"
SCALER_IDENTITY="$(az identity show --resource-group "$RG" --name my-app-scaler --query id --output tsv)"

# pinned to a version, so a new value reaches the apps only in the deploy that names it
SECRETS=(
  "database-url=keyvaultref:${VAULT_URL}/database-url/${DATABASE_URL_VERSION},identityref:${APP_IDENTITY}"
  "shopify-api-secret=keyvaultref:${VAULT_URL}/shopify-api-secret/${SHOPIFY_SECRET_VERSION},identityref:${APP_IDENTITY}"
  "lock-database-url=keyvaultref:${VAULT_URL}/lock-database-url/${LOCK_URL_VERSION},identityref:${APP_IDENTITY}"
)
# every app and job that imports shopify.server.ts stops at startup without the Shopify variables
ENV_VARS=(
  "APP_ENV=${ENV}"
  "SHOPIFY_APP_URL=https://app.example.com"
  "SHOPIFY_API_KEY=${ENV}-client-id"
  "SCOPES=write_products"
  "SERVICE_BUS_NAMESPACE=my-app-${ENV}-bus"
  "STORAGE_ACCOUNT=myapp${ENV}files"
  "AZURE_CLIENT_ID=${APP_CLIENT_ID}"
  "DATABASE_URL=secretref:database-url"
  "SHOPIFY_API_SECRET=secretref:shopify-api-secret"
  "LOCK_DATABASE_URL=secretref:lock-database-url"
)
COMMON=(--resource-group "$RG" --environment my-app-env --image "$IMAGE" --registry-server myappregistry.azurecr.io)

# 2 replicas at all times: a webhook that waits for a cold start past 5 seconds counts as failed
az containerapp create --name my-app-web "${COMMON[@]}" --registry-identity "$APP_IDENTITY" --user-assigned "$APP_IDENTITY" \
  --ingress external --target-port 3000 --command npm --args run start --min-replicas 2 --max-replicas 10 \
  --secrets "${SECRETS[@]}" --env-vars "${ENV_VARS[@]}"

# the scale rule reads the queue's length as my-app-scaler; the app's code signs in as my-app, through AZURE_CLIENT_ID
az containerapp create --name my-app-worker "${COMMON[@]}" --registry-identity "$APP_IDENTITY" --user-assigned "$APP_IDENTITY" "$SCALER_IDENTITY" \
  --command npm --args run worker --min-replicas 1 --max-replicas 5 \
  --scale-rule-name webhooks-queue --scale-rule-type azure-servicebus \
  --scale-rule-metadata "namespace=my-app-${ENV}-bus" "queueName=webhooks" "messageCount=20" \
  --scale-rule-identity "$SCALER_IDENTITY" \
  --secrets "${SECRETS[@]}" --env-vars "${ENV_VARS[@]}"

# work over 30 seconds: one execution per message, with an hour to finish
az containerapp job create --name my-app-long-jobs "${COMMON[@]}" --registry-identity "$APP_IDENTITY" --mi-user-assigned "$APP_IDENTITY" "$SCALER_IDENTITY" \
  --trigger-type Event --replica-timeout 3600 --replica-retry-limit 0 --min-executions 0 --max-executions 20 \
  --scale-rule-name long-jobs-queue --scale-rule-type azure-servicebus \
  --scale-rule-metadata "namespace=my-app-${ENV}-bus" "queueName=long-jobs" "messageCount=1" \
  --scale-rule-identity "$SCALER_IDENTITY" \
  --command npm --args run long-job \
  --secrets "${SECRETS[@]}" --env-vars "${ENV_VARS[@]}"

# create scheduled jobs in the cutover's Move scheduled work step: each one runs as soon as it exists
if [ "${CREATE_SCHEDULED_JOBS:-0}" = 1 ]; then
  az containerapp job create --name prune-audit-logs "${COMMON[@]}" --registry-identity "$APP_IDENTITY" --mi-user-assigned "$APP_IDENTITY" \
    --trigger-type Schedule --cron-expression "0 2 * * *" --replica-timeout 120 --replica-retry-limit 2 \
    --command npm --args run enqueue:prune-audit-logs \
    --secrets "${SECRETS[@]}" --env-vars "${ENV_VARS[@]}"
fi

# its own identity and its own secret: the admin user on port 5432, which owns the tables and skips row-level security
az containerapp job create --name my-app-migrate "${COMMON[@]}" --registry-identity "$MIGRATE_IDENTITY" --mi-user-assigned "$MIGRATE_IDENTITY" \
  --trigger-type Manual --replica-timeout 3600 --replica-retry-limit 0 \
  --command npx --args prisma migrate deploy \
  --secrets "migrate-database-url=keyvaultref:${VAULT_URL}/migrate-database-url/${MIGRATE_URL_VERSION},identityref:${MIGRATE_IDENTITY}" \
  --env-vars "DATABASE_URL=secretref:migrate-database-url"
