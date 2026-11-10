#!/bin/sh
set -e
hookdeck gateway connection upsert shopify-to-new-app \
  --source-name shopify --source-type SHOPIFY \
  --source-config "{\"auth\":{\"webhook_secret_key\":\"$SHOPIFY_API_SECRET\"}}" \
  --destination-name new-app --destination-type HTTP \
  --destination-url https://app.example.com \
  --rules '[
    { "type": "retry", "strategy": "exponential", "interval": 60000, "count": 10 },
    { "type": "deduplicate", "window": 3600000, "include_fields": ["headers.x-shopify-webhook-id"] }
  ]'

# store filters are written from the moved_store table
node scripts/hookdeck.ts filters --apply
