#!/bin/sh
set -e
hookdeck gateway connection upsert shopify-to-new-app \
  --source-name shopify --source-type SHOPIFY \
  --source-webhook-secret "$SHOPIFY_API_SECRET" \
  --destination-name new-app --destination-type HTTP \
  --destination-url https://app.example.com/webhooks/orders/updated \
  --rule-retry-strategy exponential --rule-retry-interval 60000 --rule-retry-count 10 \
  --rule-retry-response-status-codes "500-599" \
  --rule-deduplicate-window 3600 --rule-deduplicate-include-fields headers.x-shopify-webhook-id

hookdeck gateway connection upsert shopify-to-new-app \
  --rule-filter-headers '{"x-shopify-shop-domain": ["my-test-store.myshopify.com", "store-a.myshopify.com"]}'
