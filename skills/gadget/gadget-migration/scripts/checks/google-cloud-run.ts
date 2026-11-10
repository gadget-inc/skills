// Checks for apps moving to Google Cloud Run. references/platforms/google-cloud-run.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/google-cloud-run`;

export const googleCloudRun: CheckModule = {
  platform: "google-cloud-run",
  title: "Google Cloud Run",
  detect: (repo) => "@google-cloud/tasks" in repo.dependencies() || repo.exists("cloudbuild.yaml") || repo.find(/\.(sh|ya?ml)$/).some((f) => /gcloud run (deploy|jobs)|serving\.knative\.dev/.test(repo.read(f) ?? "")),
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
