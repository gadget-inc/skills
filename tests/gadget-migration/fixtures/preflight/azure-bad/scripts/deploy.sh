set -euo pipefail
RG=my-app-production
IMAGE=myappregistry.azurecr.io/my-app:v43
az acr build --registry myappregistry --image my-app:v43 .
az containerapp job update --resource-group "$RG" --name my-app-migrate --image "$IMAGE"
az containerapp job start --resource-group "$RG" --name my-app-migrate
az containerapp update --resource-group "$RG" --name my-app-web --image "$IMAGE"
