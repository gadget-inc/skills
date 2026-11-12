#!/bin/sh
PROJECT=my-app-production
REGION=us-central1
IMAGE="$REGION-docker.pkg.dev/$PROJECT/my-app/server:v42"
SECRETS="DATABASE_URL=database-url:latest"

gcloud builds submit --tag="$IMAGE"

gcloud run jobs deploy my-app-migrate --image="$IMAGE" --region="$REGION" \
  --command=npx --args=prisma,migrate,deploy --set-secrets="$SECRETS" --execute-now

gcloud run deploy my-app-worker --image="$IMAGE" --region="$REGION" \
  --no-allow-unauthenticated \
  --add-cloudsql-instances="$PROJECT:$REGION:my-app-db" \
  --env-vars-file=production.env.yaml --set-secrets="$SECRETS"

gcloud run deploy my-app-web --image="$IMAGE" --region="$REGION" \
  --allow-unauthenticated \
  --env-vars-file=production.env.yaml --set-secrets="$SECRETS"

gcloud pubsub subscriptions create shopify-webhooks-worker \
  --topic=shopify-webhooks \
  --push-endpoint=https://my-app-worker-123456789.us-central1.run.app/pubsub/shopify \
  --dead-letter-topic=shopify-webhooks-dead-letter --max-delivery-attempts=10
