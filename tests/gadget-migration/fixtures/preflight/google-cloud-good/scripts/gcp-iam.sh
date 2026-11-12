#!/bin/sh
set -eu
PROJECT=my-app-production
NUMBER=123456789
for name in my-app-web my-app-worker; do
  for role in roles/cloudtasks.enqueuer roles/cloudtasks.queueAdmin roles/cloudsql.client roles/secretmanager.secretAccessor; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$name@$PROJECT.iam.gserviceaccount.com" --role="$role"
  done
  gcloud iam service-accounts add-iam-policy-binding "tasks-invoker@$PROJECT.iam.gserviceaccount.com" --member="serviceAccount:$name@$PROJECT.iam.gserviceaccount.com" --role=roles/iam.serviceAccountUser
  gcloud iam service-accounts add-iam-policy-binding "$name@$PROJECT.iam.gserviceaccount.com" --member="serviceAccount:$name@$PROJECT.iam.gserviceaccount.com" --role=roles/iam.serviceAccountTokenCreator
done
gcloud iam service-accounts add-iam-policy-binding "tasks-invoker@$PROJECT.iam.gserviceaccount.com" --member="serviceAccount:service-$NUMBER@gcp-sa-cloudtasks.iam.gserviceaccount.com" --role=roles/iam.serviceAccountUser
gcloud pubsub topics add-iam-policy-binding shopify-webhooks-dead-letter --member="serviceAccount:service-$NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" --role=roles/pubsub.publisher
gcloud pubsub subscriptions add-iam-policy-binding shopify-webhooks-worker --member="serviceAccount:service-$NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" --role=roles/pubsub.subscriber
gcloud run services add-iam-policy-binding my-app-worker --region=us-central1 --member="serviceAccount:tasks-invoker@$PROJECT.iam.gserviceaccount.com" --role=roles/run.invoker
