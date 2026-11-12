set -euo pipefail
RG=my-app-production
IMAGE=myappregistry.azurecr.io/my-app:v42
IDENTITY_ID="$(az identity show --resource-group "$RG" --name my-app --query id --output tsv)"
az containerapp create --resource-group "$RG" --name my-app-web --environment my-app-env --image "$IMAGE" \
  --user-assigned "$IDENTITY_ID" --ingress external --target-port 3000 --command npm --args run start \
  --secrets "database-url=keyvaultref:https://my-app-production-vault.vault.azure.net/secrets/database-url,identityref:$IDENTITY_ID" \
  --env-vars "DATABASE_URL=secretref:database-url"
az containerapp job create --resource-group "$RG" --name my-app-migrate --environment my-app-env --image "$IMAGE" \
  --mi-user-assigned "$IDENTITY_ID" --trigger-type Manual --replica-timeout 3600 --replica-retry-limit 0 \
  --command npx --args prisma migrate deploy \
  --secrets "database-url=keyvaultref:https://my-app-production-vault.vault.azure.net/secrets/database-url/0f3c2a9d8e7b4c1a9f6e5d4c3b2a1f0e,identityref:$IDENTITY_ID" \
  --env-vars "DATABASE_URL=secretref:database-url"
