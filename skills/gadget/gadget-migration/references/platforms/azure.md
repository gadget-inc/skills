# Azure

## What is this?

On Azure, the app becomes container apps in one Container Apps environment: `my-app-web` behind external ingress, `my-app-worker` reading Service Bus, and jobs for long work, scheduled actions, and migrations. The database is a Flexible Server with its built-in PgBouncer, files go to Blob Storage, and secrets are Key Vault references. Most failures here come from defaults that differ from Gadget's: Service Bus delivers a failed message again at once, the SDK stops renewing a message's lock after 5 minutes, the admin user owns every table, PgBouncer turns prepared statements off, and a Key Vault reference follows the latest version. Gadget's guide: https://docs.gadget.dev/guides/moving-to-another-platform/azure

For Azure itself, load Microsoft's Azure Skills plugin: `/plugin install azure@claude-plugins-official` in Claude Code, or `npx skills add microsoft/azure-skills` (https://github.com/microsoft/azure-skills). Its `azure-prepare` and `azure-deploy` skills deploy with the Azure Developer CLI (`azd`), `azure-messaging` troubleshoots the Service Bus SDKs, and `azure-storage` covers Blob Storage. It has no skill for Flexible Server, and its `azure-cloud-migrate` moves apps from other clouds, not from Gadget. This file covers only what breaks or changes because the app came from Gadget, with plain `az` scripts instead of `azd`.

Read [common.md](common.md) first.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform azure
```

It reads `az` commands in shell scripts, CI workflows, and Makefiles, with the variables and arrays a script assigns and the commands inside `$( )`, plus Key Vault references in Container Apps YAML and Bicep, and the app's Service Bus, Blob Storage, and nodemailer code.

| Check | What it catches | Command when the script can't see it |
|---|---|---|
| `azure/owner-skips-rls` | SQL migrations that turn on row-level security, while the migration job and an app or job read the database URL from the same Key Vault secret, so the app connects as the admin user that owns the tables | `psql "<app_user's URL>" -f path/to/skills/gadget-migration/scripts/db-check.sql`, and once as `myadmin`: `select rolbypassrls from pg_roles where rolname = current_user` |
| `azure/migrate-shared-identity` | A migration job that uses the same managed identity as an app or job, which can then read the admin URL | `az role assignment list --scope "<vault id>/secrets/migrate-database-url" --output table` should list only `my-app-migrate` |
| `azure/migrate-before-deploy` | A deploy script that starts the migration job and updates apps without waiting for the execution to end, or gives the job the new image and never starts it, or has no `set -e` | |
| `azure/pgbouncer-prepared` | PgBouncer turned on with `pgbouncer.max_prepared_statements` left at 0, in an app that uses Prisma, with no `pgbouncer=true` anywhere in the repository | `az postgres flexible-server parameter show --resource-group my-app-production --server-name my-app-production-db --name pgbouncer.max_prepared_statements` |
| `azure/extensions-allowlist` | A migration that creates an extension the scripts never add to `azure.extensions` | `az postgres flexible-server parameter show ... --name azure.extensions` |
| `azure/db-open-to-azure` | `--public-access 0.0.0.0` or `All`, or a firewall rule that starts at `0.0.0.0` | `az postgres flexible-server firewall-rule list --resource-group my-app-production --server-name my-app-production-db --output table` |
| `azure/lock-renewal` | A Service Bus receiver on the SDK's 5 minutes of lock renewal, or with renewal turned off | |
| `azure/receive-and-delete` | A receiver in `receiveAndDelete` mode, which loses a message whose job fails | |
| `azure/immediate-retry` | A worker that abandons failed messages, or lets the SDK abandon them, without scheduling a delayed copy | Messages in the dead-letter queue whose deliveries came within a second of each other |
| `azure/duplicate-detection` | A queue created without duplicate detection in an app that sets `messageId`, or with a window under 4 hours | `az servicebus queue show --resource-group my-app-production --namespace-name my-app-production-bus --name webhooks --query "{detection: requiresDuplicateDetection, window: duplicateDetectionHistoryTimeWindow}"` |
| `azure/scheduled-id-clock` | A scheduled script whose message id comes from the clock's date | |
| `azure/keyvault-unversioned` | A Key Vault reference with no version | `az containerapp secret list --resource-group my-app-production --name my-app-web --output table` |
| `azure/web-scale-to-zero` | An app with external ingress and no `--min-replicas`, or 0 | `az containerapp show --resource-group my-app-production --name my-app-web --query properties.template.scale` |
| `azure/prisma-generate` | An app or job started with `--command` while the Dockerfile never runs `prisma generate` | |
| `azure/blob-type-header` | A browser `PUT` of a file with no `x-ms-blob-type` header anywhere in the app | |
| `azure/blob-cors-header` | A Blob Storage CORS rule for `PUT` that doesn't allow `x-ms-blob-type` | `az storage cors list --account-name myappproductionfiles --services b` |
| `azure/smtp-port-25` | nodemailer on port 25 | |
| Readiness probe | The default probe only checks that the port opens, so a revision that can't reach the database takes traffic | `az containerapp show --resource-group my-app-production --name my-app-web --query "properties.template.containers[0].probes"` |
| `max_connections` after a resize | A server scaled up keeps the `max_connections` of the size it was created with | `az postgres flexible-server parameter show ... --name max_connections` |
| Outbound address | Every app and job sends from the NAT gateway's address | `az network public-ip show --resource-group my-app-production --name my-app-egress --query ipAddress --output tsv`, then the same address from a job that runs `curl -s https://checkip.amazonaws.com` |

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| A query with no store set returns every store's rows, and `scripts/db-check.sql` reports `owns tables with row-level security` or `role bypasses row-level security` | The app connects as `myadmin`, which isn't a superuser but ran the migrations and owns the tables, and Postgres skips the policies for a table's owner. On PostgreSQL 16 and later it very likely has `BYPASSRLS` as well, because Microsoft says it can create roles with `BYPASSRLS` | `app_user` on port 6432 in `database-url`, `myadmin` on port 5432 in `migrate-database-url` for the migration job only (`azure/owner-skips-rls`, [Rewrite permissions and shop tenancy](https://docs.gadget.dev/guides/moving-to-another-platform/azure#rewrite-permissions-and-shop-tenancy)) |
| `prepared statement "s0" does not exist` or `already exists` through port 6432, on some requests and not others | `pgbouncer.max_prepared_statements` is 0 by default. In a test of 300 Prisma queries through PgBouncer 1.26.1, about half failed | Set it to 200, or add `pgbouncer=true` to the app's URL (`azure/pgbouncer-prepared`, [Connect through PgBouncer](https://docs.gadget.dev/guides/moving-to-another-platform/azure#connect-through-pgbouncer)) |
| `Error: P1002` and `Timed out trying to acquire a postgres advisory lock` on port 5432 | An earlier `prisma migrate deploy` ran through port 6432 and left Prisma's lock held on an idle pooled connection, until `pgbouncer.server_idle_timeout`, 600 seconds by default | `select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = 72707369;` as `myadmin`, then migrate on port 5432 only |
| `remaining connection slots are reserved` (the rest names the reserved roles), or `sorry, too many clients already`, on port 5432 | Replicas times pool size passed the connections left, 844 for `Standard_D2ds_v5`, or a resized server kept its old `max_connections` | Connect apps through PgBouncer, cap `--max-replicas` and `--max-executions`, and set `max_connections` after every resize ([Limit connections from Container Apps](https://docs.gadget.dev/guides/moving-to-another-platform/azure#limit-connections-from-container-apps)) |
| `extension "vector" is not allow-listed for "azure_pg_admin" users in Azure Database for PostgreSQL` from the migration job | `vector` isn't in `azure.extensions`, which starts empty | `az postgres flexible-server parameter set --name azure.extensions --value vector` (`azure/extensions-allowlist`) |
| A long job runs twice, the first copy ends with `MessageLockLost` | The receiver renewed the lock for 5 minutes, the SDK's default, and Service Bus gave the message to another replica | `maxAutoLockRenewalDurationInMs` above the longest job, and a Container Apps job for work over 30 seconds (`azure/lock-renewal`, [Check your host's time limits](https://docs.gadget.dev/guides/moving-to-another-platform/azure#check-your-host-s-time-limits)) |
| Messages in the dead-letter queue after a short outage, all deliveries within a second of each other | An abandoned message goes back to the front of the queue at once | Complete it and schedule a copy with a doubling delay (`azure/immediate-retry`, [Process messages in a worker](https://docs.gadget.dev/guides/moving-to-another-platform/azure#process-messages-in-a-worker)) |
| A Shopify webhook processed twice, 20 minutes or more apart | The queue's duplicate detection window is 10 minutes, the default, and Shopify retries for 4 hours | `--duplicate-detection-history-time-window P1D` (`azure/duplicate-detection`) |
| A nightly job ran twice one night and not at all the next | Its message id came from the clock's date, so a retry after midnight took the next day's id | `lastScheduledRun` below (`azure/scheduled-id-clock`, [Replace scheduled actions](https://docs.gadget.dev/guides/moving-to-another-platform/azure#replace-scheduled-actions)) |
| `MessageSizeExceeded` from `sendMessages` | The payload is over the namespace's message size limit on Microsoft's [Service Bus quotas page](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-quotas) | Save the payload in the database and send its id |
| Every replica restarts at a time nobody deployed, cutting off jobs | A Key Vault reference without a version picked up a new value within 30 minutes of a rotation | Pin every reference to a version (`azure/keyvault-unversioned`, [Environment variables](https://docs.gadget.dev/guides/moving-to-another-platform/azure#environment-variables)) |
| `400` from Blob Storage on an upload from the browser | The `PUT` has no `x-ms-blob-type` | `x-ms-blob-type: BlockBlob` on the request (`azure/blob-type-header`) |
| The browser blocks the upload after a failed preflight, and Blob Storage answered `403` with `CorsPreflightFailure` | The CORS rule doesn't allow `x-ms-blob-type` | `--allowed-headers content-type x-ms-blob-type` (`azure/blob-cors-header`) |
| `The API version 2026-10-06 is not supported by Azurite` in development | Azurite 3.37.0 is behind `@azure/storage-blob` 12.34.0 | Start Azurite with `--skipApiVersionCheck` |
| A link to a file in a metafield or an email stops working within a week | A signed URL lasts at most 7 days | Store the URL of `app/routes/files.$.tsx` below instead |
| `connect ETIMEDOUT` to the mail server | Port 25 is unsupported from Container Apps | Port 587 (`azure/smtp-port-25`, [Email and custom domains](https://docs.gadget.dev/guides/moving-to-another-platform/azure#email-and-custom-domains)) |
| The first webhook after a quiet night fails in Shopify's delivery metrics | The web app scaled to zero, and a cold start took more than 5 seconds | `--min-replicas 2` (`azure/web-scale-to-zero`, [Receive webhooks](https://docs.gadget.dev/guides/moving-to-another-platform/azure#receive-webhooks)) |
| `403` from Shopify's Admin API in a job after enforcement, while the web app's calls succeed | The job's environment isn't on the VNet with the NAT gateway, so it sends from another address | Run every app and job in `my-app-env`, and check the address from a job ([IP allowlists](https://docs.gadget.dev/guides/moving-to-another-platform/azure#ip-allowlists)) |
| An imported user is asked to reset a correct password at first sign-in | Entra's just-in-time migration sends a password that fails Entra's complexity rules to `UpdatePassword`, and any password under 8 characters | Turn on `disableStrongPassword` for the migration period, as Microsoft's [just-in-time migration page](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-migrate-passwords-just-in-time) describes |

## Complete examples

One resource group per environment, `my-app-staging` and `my-app-production`, each with its own Container Apps environment, Flexible Server, Service Bus namespace, storage account, and Key Vault. The image is the template's Dockerfile with `RUN npx prisma generate` after `COPY . .` and `CMD ["npm", "run", "start"]`. Server, namespace, vault, and storage account names are global across Azure, so the scripts put the environment in each one.

Everything the guide creates for one environment, in its order. The guide's commands are spread over eight sections; here they run once per environment, and again after you store the secrets, because a grant on one secret needs that secret to exist:

```bash
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
for secret in database-url lock-database-url shopify-api-secret; do grant_secret "$APP_PRINCIPAL" "$secret"; done
grant_secret "$MIGRATE_PRINCIPAL" migrate-database-url

echo "outbound address: $EGRESS_IP. Add it to Shopify's IP allowlist next to Gadget's ASN 396982."
```

The script grants on each secret by name instead of on the vault, so only `my-app-migrate` can read `migrate-database-url`. Storing a secret needs the Key Vault Secrets Officer role on the vault for whoever runs `az keyvault secret set`. Create `app_user` with SQL as [Rewrite permissions and shop tenancy](https://docs.gadget.dev/guides/moving-to-another-platform/azure#rewrite-permissions-and-shop-tenancy) shows, then store its URL on port 6432 as `database-url`, on port 5432 as `lock-database-url` for the per-store lock, and the `myadmin` URL on port 5432 as `migrate-database-url`.

Every app and job, created once with the same variables and pinned secrets in one list, so a new job can't miss one:

```bash
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
```

`--scale-rule-identity` is a preview flag in Azure CLI 2.88.0 and comes with the `containerapp` extension. KEDA reads a queue's length with Manage access, which only Azure Service Bus Data Owner includes, so the scale rules use `my-app-scaler`, and the apps' code keeps signing in as `my-app` with its Sender and Receiver roles. Without that grant, the worker stays at its minimum and the long-jobs job never starts. Check on staging that both scale when messages arrive.

The guide's deploy, with a time limit on the wait and every job that runs the image:

```bash
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
```

The web app's readiness probe. `az containerapp create` has no flag for probes, so save the app's YAML with `az containerapp show --resource-group my-app-production --name my-app-web --output yaml > my-app-web.yaml`, add `probes` under the container in `properties.template.containers`, and apply it with `az containerapp update --resource-group my-app-production --name my-app-web --yaml my-app-web.yaml`:

```yaml
probes:
  - type: Readiness
    httpGet:
      path: /healthz
      port: 3000
    periodSeconds: 10
    failureThreshold: 3
```

```typescript
// in app/routes/healthz.tsx
// The web app's HTTP readiness probe: a revision that can't reach the database never takes traffic.
import prisma from "../db.server";

export const loader = async () => {
  await prisma.$queryRaw`select 1`;
  return new Response("ok");
};
```

Scheduled ids for any number of scheduled actions. The guide computes the latest 02:00 UTC inline for one job; a Gadget app often has several, some hourly. Each scheduled job runs this script with its action's name, and the worker runs the action with the queue's retries:

```typescript
// in app/scheduled-time.server.ts
// The time a run of a daily or hourly schedule was scheduled for: the most recent one at or before now.
// Container Apps passes no scheduled time to a job, so the job computes it, and a run that starts late
// or retries gets the same time, and so the same message id, as its first attempt.
export function lastScheduledRun(schedule: string, now = new Date()): Date {
  const [minute, hour, ...rest] = schedule.trim().split(/\s+/);
  const daily = /^\d+$/.test(hour ?? "");
  if (!/^\d+$/.test(minute ?? "") || !(daily || hour === "*") || rest.length !== 3 || rest.some((field) => field !== "*")) {
    throw new Error(`lastScheduledRun reads "M H * * *" and "M * * * *" in UTC, not "${schedule}"`);
  }
  const run = new Date(now);
  run.setUTCMinutes(Number(minute), 0, 0);
  if (daily) {
    run.setUTCHours(Number(hour));
    if (run > now) run.setUTCDate(run.getUTCDate() - 1);
  } else if (run > now) {
    run.setUTCHours(run.getUTCHours() - 1);
  }
  return run;
}
```

```typescript
// in scripts/enqueue-scheduled.ts
// One script for every scheduled action: each scheduled job runs it with its action's name, such as
// node build/enqueue-scheduled.js pruneAuditLogs, and the worker does the work with the queue's retries.
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { lastScheduledRun } from "../app/scheduled-time.server";

// the same cron expression as each job's --cron-expression, in UTC
const SCHEDULES: Record<string, string> = {
  pruneAuditLogs: "0 2 * * *",
  reconcileShops: "0 * * * *",
};

const job = process.argv[2];
const schedule = SCHEDULES[job];
if (!schedule) throw new Error(`no schedule for ${job}: add it to SCHEDULES`);

const credential = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID });
const client = new ServiceBusClient(`${process.env.SERVICE_BUS_NAMESPACE}.servicebus.windows.net`, credential);
const scheduledAt = lastScheduledRun(schedule).toISOString();
// one id per scheduled run, so a late start or a retry of the same run adds nothing to the queue
await client.createSender("scheduled").sendMessages({ body: { job, scheduledAt }, messageId: `${job}-${scheduledAt}` });
await client.close();
```

For `0 2 * * *`, a run that starts at 00:05 the next day still gets the 02:00 run before it, and for `0 * * * *`, a run at 14:59 gets 14:00. Every attempt of one run sends the same id, so the `scheduled` queue's 1-day window drops the repeats, and the next run gets its own.

Uploads and permanent file links, on top of the guide's [`files.server.ts`](https://docs.gadget.dev/guides/moving-to-another-platform/azure#search-files-and-other-services), which signs URLs with the managed identity. The route signs an upload for the store that asks, the browser sends the file straight to Blob Storage with the header Put Blob requires, and a second route stands in for a public file field's URL, which never expired on Gadget:

```typescript
// in app/routes/api.uploads.tsx
// Signs one upload for the store that asks, with a key the browser can't choose.
import { randomUUID } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { uploadUrl } from "../services/files.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { name } = (await request.json()) as { name: string };
  // one folder per store and a random prefix, so no upload can overwrite another store's file
  const key = `${session.shop}/${randomUUID()}-${name.replace(/[^\w.-]/g, "_")}`;
  return Response.json({ key, url: await uploadUrl(key) });
};
```

```typescript
// in app/upload.client.ts
// The browser's half: ask the app for a signed URL, then send the file straight to Blob Storage.
export async function uploadFile(file: File): Promise<string> {
  const signed = await fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name }),
  });
  if (!signed.ok) throw new Error(`signing the upload failed with ${signed.status}`);
  const { key, url } = (await signed.json()) as { key: string; url: string };
  const response = await fetch(url, {
    method: "PUT",
    // Put Blob answers 400 without x-ms-blob-type, and the account's CORS rule has to allow the header
    headers: { "x-ms-blob-type": "BlockBlob", "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!response.ok) throw new Error(`the upload failed with ${response.status}: ${await response.text()}`);
  return key;
}
```

```typescript
// in app/routes/files.$.tsx
// A link that never expires, for files whose URL goes into a Shopify metafield or an email. A signed
// Blob Storage URL lasts at most 7 days, so this route signs a new 3-hour one on every request.
import type { LoaderFunctionArgs } from "react-router";
import { privateFileUrl } from "../services/files.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const key = params["*"] ?? "";
  // only files saved under public/, like a public file field on Gadget, and no way out of that folder
  if (!key.startsWith("public/") || key.split("/").includes("..")) return new Response(null, { status: 404 });
  const url = await privateFileUrl(key);
  // caches keep the redirect for an hour, well inside the 3 hours the signed URL lasts
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "public, max-age=3600" } });
};
```

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform/azure#cut-over-to-the-new-platform) holds. On Azure:

- **Allow your new host to call Shopify:** add the NAT gateway's address, which `scripts/azure-env.sh` prints, to Shopify's IP allowlist next to Gadget's ASN `396982`. One allowlist holds addresses and ASNs, and Shopify checks the addresses first. Don't add Microsoft's ASN `8075` instead, which allows every Azure customer and every Microsoft service. Only an environment without a NAT gateway, whose outbound addresses can change, needs `8075` and its country. Run Shopify's test again after the first calls, and check it shows no other address.
- **Scheduled jobs run as soon as they exist:** create them in the Move scheduled work step, with `CREATE_SCHEDULED_JOBS=1 bash scripts/azure-apps.sh ...`, or with the `prune-audit-logs` command from that script on its own.
- **Background actions with a future `startAt`:** send each one again as a scheduled message with `sender.scheduleMessages(message, startAt)`, with its Gadget id as the `messageId`.
- **Backfill on Azure:** one message per store on `long-jobs`, which up to 20 executions run at once. Count their connections with the apps' replicas.
- **Load records as `myadmin` on port 5432,** from an address you add to the firewall for the load and remove afterwards. The load writes every store's rows without setting `app.shop_id`.
- **Resize before the day, not on it:** a larger compute size keeps the old `max_connections`, and setting it restarts the server.
- **App users in Entra External ID:** the just-in-time endpoint gets the typed password as an RSA-encrypted JWE with a `nonce` it must send back, and it needs the exported Gadget hashes until every user has signed in once. Keep the hashes and the endpoint after the switch.
- **Rollback:** `az containerapp update --image` with the previous tag, for the web app, the worker, and each job. Single revision mode has no way to move traffic back to an earlier revision, and migrations stay applied.

## What wasn't verified

No Azure account was used, so nothing was deployed. Run locally on 12 November 2026:

- `preflight.ts` against fixtures that reproduce each check and a fixture that passes all of them, plus the complete examples above.
- Every `az` command in `scripts/azure-env.sh`, `scripts/azure-apps.sh`, and `scripts/deploy.sh` was parsed by Azure CLI 2.88.0 in its Docker image, unauthenticated, for staging and production. The image has no extensions, so `--scale-rule-identity` was removed before parsing.
- The TypeScript blocks typecheck with `@azure/service-bus` 7.10.0, `@azure/storage-blob` 12.34.0, `@azure/identity` 4.14.1, `react-router` 7.18.2, and TypeScript 5.9.3. `lastScheduledRun` ran against daily and hourly schedules across midnight, month, and year boundaries.
- On Postgres 17.11, with a role standing in for `myadmin` (LOGIN, CREATEDB, CREATEROLE, BYPASSRLS, a member of `azure_pg_admin`, not a superuser): it reads all 3 stores' rows, `db-check.sql` reports both the ownership and `BYPASSRLS`, and the guide's `app_user` reads one store, and with none set fails with `unrecognized configuration parameter "app.shop_id"` on a fresh connection and `invalid input syntax for type bigint: ""` on one a transaction already used.
- Prisma 6.19.3 through PgBouncer 1.26.1 in transaction mode: with `max_prepared_statements` at 0, about half of 300 queries failed with `prepared statement "s0" does not exist` and the like; with `pgbouncer=true`, or at 200, all 300 succeeded.
- On Azurite 3.37.0: an upload without `x-ms-blob-type` got `400`, with no error code, `uploadFile` stored the file, the CORS preflight failed without the header in the rule, and `files.$.tsx` redirected to a working signed URL and refused keys outside `public/`.

Not run: Service Bus code against a queue (the emulator needs a license acceptance that wasn't given), so lock renewal, abandon, and duplicate detection behavior come from Microsoft's docs and the SDK's source. Also not run: user delegation SAS (Azurite signed with its account key instead), whether Flexible Server's admin user has `BYPASSRLS` (Microsoft's docs imply it on PostgreSQL 16 and later), the NAT gateway, the KEDA scale rules and the Data Owner role they need, Key Vault references and their 30-minute refresh, role assignments on a single secret, whether `az role assignment create` succeeds when the assignment exists, Entra External ID, and the `extension ... is not allow-listed` text, which comes from Microsoft's Q&A, not a server.
