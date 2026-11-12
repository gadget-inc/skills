#!/usr/bin/env bash
set -euo pipefail
PROJECT=my-app-production
REGION=us-central1
IMAGE="$REGION-docker.pkg.dev/$PROJECT/my-app/server:v42"
# database-url holds app_user's URL, a role that owns no tables, so row-level security applies to the services
SECRETS="DATABASE_URL=database-url:1,SHOPIFY_API_SECRET=shopify-api-secret:1"
# only the migration job connects as postgres, which owns the tables it creates
MIGRATE_SECRETS="DATABASE_URL=migrate-database-url:1"

gcloud builds submit --tag="$IMAGE"

gcloud run jobs deploy my-app-migrate --image="$IMAGE" --region="$REGION" \
  --command=npx --args=prisma,migrate,deploy --set-secrets="$MIGRATE_SECRETS" --execute-now --wait

gcloud run deploy my-app-worker --image="$IMAGE" --region="$REGION" \
  --no-allow-unauthenticated --timeout=15m \
  --add-cloudsql-instances="$PROJECT:$REGION:my-app-db" \
  --env-vars-file=production.env.yaml --set-secrets="$SECRETS"

gcloud run deploy my-app-web --image="$IMAGE" --region="$REGION" \
  --allow-unauthenticated --min=1 --max=10 \
  --env-vars-file=production.env.yaml --set-secrets="$SECRETS"

gcloud pubsub subscriptions create shopify-webhooks-worker \
  --topic=shopify-webhooks \
  --push-endpoint=https://my-app-worker-123456789.us-central1.run.app/pubsub/shopify \
  --dead-letter-topic=shopify-webhooks-dead-letter --max-delivery-attempts=10 \
  --expiration-period=never
