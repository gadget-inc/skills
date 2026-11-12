# in scripts/azure-env.sh
# usage: DB_ADMIN_PASSWORD=... bash scripts/azure-env.sh staging   or   ... production
# Creates one environment in the guide's order and skips each resource that exists. Run it again after
# you store the Key Vault secrets: access is granted to each secret by name, and a secret must exist first.
set -euo pipefail
ENV="${1:?usage: azure-env.sh staging|production}"
: "${DB_ADMIN_PASSWORD:?set DB_ADMIN_PASSWORD to the password for myadmin}"
RG="my-app-${ENV}"
LOCATION=eastus
DB="my-app-${ENV}-db"
BUS="my-app-${ENV}-bus"
VAULT="my-app-${ENV}-vault"
STORAGE="myapp${ENV}files"
REGISTRY=myappregistry
ORIGIN="https://app.example.com"
exists() { "$@" >/dev/null 2>&1; }
grant() { az role assignment create --assignee-object-id "$1" --assignee-principal-type ServicePrincipal --role "$2" --scope "$3" >/dev/null; }

az group create --name "$RG" --location "$LOCATION" >/dev/null

# one static outbound address for Shopify's allowlist and the database firewall; an environment's network is fixed when it's created
exists az network vnet show --resource-group "$RG" --name my-app-vnet ||
  az network vnet create --resource-group "$RG" --name my-app-vnet --address-prefixes 10.0.0.0/16 >/dev/null
exists az network public-ip show --resource-group "$RG" --name my-app-egress ||
  az network public-ip create --resource-group "$RG" --name my-app-egress --sku Standard --allocation-method Static >/dev/null
# Container Apps doesn't support the StandardV2 NAT gateway
exists az network nat gateway show --resource-group "$RG" --name my-app-nat ||
  az network nat gateway create --resource-group "$RG" --name my-app-nat --sku Standard --public-ip-addresses my-app-egress >/dev/null
exists az network vnet subnet show --resource-group "$RG" --vnet-name my-app-vnet --name apps ||
  az network vnet subnet create --resource-group "$RG" --vnet-name my-app-vnet --name apps \
    --address-prefixes 10.0.0.0/23 --delegations Microsoft.App/environments --nat-gateway my-app-nat >/dev/null
SUBNET_ID="$(az network vnet subnet show --resource-group "$RG" --vnet-name my-app-vnet --name apps --query id --output tsv)"
exists az containerapp env show --resource-group "$RG" --name my-app-env ||
  az containerapp env create --resource-group "$RG" --name my-app-env --location "$LOCATION" \
    --enable-workload-profiles --infrastructure-subnet-resource-id "$SUBNET_ID" >/dev/null
EGRESS_IP="$(az network public-ip show --resource-group "$RG" --name my-app-egress --query ipAddress --output tsv)"

# my-app for every app and job; my-app-migrate only for the migration job, the one that reads the admin URL;
# my-app-scaler only for the scale rules, which need Manage access to read a queue's length
for name in my-app my-app-migrate my-app-scaler; do
  exists az identity show --resource-group "$RG" --name "$name" || az identity create --resource-group "$RG" --name "$name" >/dev/null
done
APP_PRINCIPAL="$(az identity show --resource-group "$RG" --name my-app --query principalId --output tsv)"
MIGRATE_PRINCIPAL="$(az identity show --resource-group "$RG" --name my-app-migrate --query principalId --output tsv)"
SCALER_PRINCIPAL="$(az identity show --resource-group "$RG" --name my-app-scaler --query principalId --output tsv)"

# public access with no rule, then the NAT gateway's address only; never 0.0.0.0, which admits every Azure customer
exists az postgres flexible-server show --resource-group "$RG" --name "$DB" ||
  az postgres flexible-server create --resource-group "$RG" --name "$DB" --location "$LOCATION" \
    --version 17 --tier GeneralPurpose --sku-name Standard_D2ds_v5 --storage-size 128 \
    --admin-user myadmin --admin-password "$DB_ADMIN_PASSWORD" --public-access None >/dev/null
# the database is --name here: db create has no --database-name
exists az postgres flexible-server db show --resource-group "$RG" --server-name "$DB" --name shopify_app ||
  az postgres flexible-server db create --resource-group "$RG" --server-name "$DB" --name shopify_app >/dev/null
az postgres flexible-server firewall-rule create --resource-group "$RG" --server-name "$DB" --name container-apps \
  --start-ip-address "$EGRESS_IP" >/dev/null
# every extension the migrations create, before the first migration runs
az postgres flexible-server parameter set --resource-group "$RG" --server-name "$DB" --name azure.extensions --value vector >/dev/null
az postgres flexible-server parameter set --resource-group "$RG" --server-name "$DB" --name pgbouncer.enabled --value true >/dev/null
# 0 by default, which breaks clients that prepare statements, such as Prisma without pgbouncer=true
az postgres flexible-server parameter set --resource-group "$RG" --server-name "$DB" --name pgbouncer.max_prepared_statements --value 200 >/dev/null

# duplicate detection can't be turned on later, and a 1-day window outlasts Shopify's 4 hours of retries
exists az servicebus namespace show --resource-group "$RG" --name "$BUS" ||
  az servicebus namespace create --resource-group "$RG" --name "$BUS" --location "$LOCATION" --sku Standard >/dev/null
for queue in webhooks scheduled long-jobs; do
  exists az servicebus queue show --resource-group "$RG" --namespace-name "$BUS" --name "$queue" ||
    az servicebus queue create --resource-group "$RG" --namespace-name "$BUS" --name "$queue" \
      --enable-duplicate-detection true --duplicate-detection-history-time-window P1D \
      --lock-duration PT1M --max-delivery-count 10 >/dev/null
done

exists az storage account show --resource-group "$RG" --name "$STORAGE" ||
  az storage account create --resource-group "$RG" --name "$STORAGE" --location "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 --allow-blob-public-access false --min-tls-version TLS1_2 >/dev/null
az storage container create --account-name "$STORAGE" --name files >/dev/null
# the browser's upload sends x-ms-blob-type, so the preflight has to allow it
az storage cors clear --account-name "$STORAGE" --services b
az storage cors add --account-name "$STORAGE" --services b --methods GET PUT --origins "$ORIGIN" \
  --allowed-headers content-type x-ms-blob-type --max-age 3600

exists az keyvault show --name "$VAULT" ||
  az keyvault create --resource-group "$RG" --name "$VAULT" --location "$LOCATION" --enable-rbac-authorization true >/dev/null

BUS_ID="$(az servicebus namespace show --resource-group "$RG" --name "$BUS" --query id --output tsv)"
STORAGE_ID="$(az storage account show --resource-group "$RG" --name "$STORAGE" --query id --output tsv)"
VAULT_ID="$(az keyvault show --name "$VAULT" --query id --output tsv)"
REGISTRY_ID="$(az acr show --name "$REGISTRY" --query id --output tsv)"
grant "$APP_PRINCIPAL" "Azure Service Bus Data Sender" "$BUS_ID"
grant "$APP_PRINCIPAL" "Azure Service Bus Data Receiver" "$BUS_ID"
# KEDA reads queue lengths with Manage access, which Sender and Receiver don't include; without it nothing scales
grant "$SCALER_PRINCIPAL" "Azure Service Bus Data Owner" "$BUS_ID"
# includes the user delegation key that signs upload and download URLs
grant "$APP_PRINCIPAL" "Storage Blob Data Contributor" "$STORAGE_ID"
for principal in "$APP_PRINCIPAL" "$MIGRATE_PRINCIPAL"; do grant "$principal" AcrPull "$REGISTRY_ID"; done

# one grant per secret, so only my-app-migrate can read the admin URL
grant_secret() {
  if exists az keyvault secret show --vault-name "$VAULT" --name "$2"; then
    grant "$1" "Key Vault Secrets User" "$VAULT_ID/secrets/$2"
  else
    echo "store $2 in $VAULT, then run this script again"
  fi
}
for secret in database-url shopify-api-secret; do grant_secret "$APP_PRINCIPAL" "$secret"; done
grant_secret "$MIGRATE_PRINCIPAL" migrate-database-url

echo "outbound address: $EGRESS_IP. Add it to Shopify's IP allowlist next to Gadget's ASN 396982."
