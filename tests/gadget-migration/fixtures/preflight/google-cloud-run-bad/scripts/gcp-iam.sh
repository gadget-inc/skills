#!/bin/sh
set -eu
PROJECT=my-app-production
for name in my-app-web my-app-worker; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$name@$PROJECT.iam.gserviceaccount.com" --role=roles/cloudtasks.enqueuer
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$name@$PROJECT.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor
done
gcloud run services add-iam-policy-binding my-app-worker --region=us-central1 --member="serviceAccount:tasks-invoker@$PROJECT.iam.gserviceaccount.com" --role=roles/run.invoker
