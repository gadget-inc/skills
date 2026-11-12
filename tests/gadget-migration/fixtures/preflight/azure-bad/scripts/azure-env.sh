set -euo pipefail
RG=my-app-production
DB=my-app-production-db
BUS=my-app-production-bus
az postgres flexible-server create --resource-group "$RG" --name "$DB" --location eastus \
  --version 17 --tier GeneralPurpose --sku-name Standard_D2ds_v5 --admin-user myadmin --public-access 0.0.0.0
az postgres flexible-server parameter set --resource-group "$RG" --server-name "$DB" --name pgbouncer.enabled --value true
az servicebus queue create --resource-group "$RG" --namespace-name "$BUS" --name webhooks --lock-duration PT1M --max-delivery-count 10
az servicebus queue create --resource-group "$RG" --namespace-name "$BUS" --name scheduled --enable-duplicate-detection true
az storage cors add --account-name myappproductionfiles --services b --methods GET PUT --origins https://app.example.com \
  --allowed-headers content-type --max-age 3600
