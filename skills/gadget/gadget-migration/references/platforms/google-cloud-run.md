# Google Cloud Run

## What is this?

On Google Cloud, the app becomes two Cloud Run services from one image: public `my-app-web`, and private `my-app-worker`, which Cloud Tasks, Cloud Scheduler, and Pub/Sub call with Google-signed tokens. Most failures here are a missing IAM role, a variable one service lacks, or two time limits that disagree, so this file is mostly scripts that set those up the same way in every project. Gadget's guide: https://docs.gadget.dev/guides/moving-to-another-platform/google-cloud-run

Read [common.md](common.md) first.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform google-cloud-run
```

It reads `gcloud` commands in shell scripts, CI workflows, and `cloudbuild.yaml`, with the variables a script assigns, plus the app's Cloud Tasks and Cloud Storage code.

| Check | What it catches | Command when the script can't see it |
|---|---|---|
| `google-cloud-run/shopify-env-missing` | A `gcloud run deploy` that replaces the variables and secrets without `SHOPIFY_APP_URL`, `SHOPIFY_API_KEY`, or `SHOPIFY_API_SECRET` | `gcloud run services describe my-app-worker --region=us-central1 --format=yaml` lists `env` |
| `google-cloud-run/timeout-deadline` | A dispatch deadline shorter than the worker's `--timeout` (two copies run), or longer (504 and retry). Only a warning when the deadline is already Cloud Tasks' 30-minute maximum, and a check by hand when the deadline isn't a number or a constant in the same file | `gcloud run services describe my-app-worker --region=us-central1 --format="value(spec.template.spec.timeoutSeconds)"` |
| `google-cloud-run/iam-roles` | A role the code or commands need that the repo's IAM script or Terraform never grants, or, with no IAM setup in the repo, the list of roles to check | `gcloud projects get-iam-policy my-app-production --flatten=bindings --filter="bindings.members:serviceAccount:my-app-web@my-app-production.iam.gserviceaccount.com" --format="value(bindings.role)"` |
| `google-cloud-run/migrate-before-deploy` | A migration job that never runs, runs without `--wait`, or runs in a script without `set -e` | |
| `google-cloud-run/migrate-on-start` | A start script that runs `prisma db push` or `migrate deploy`, as in Shopify's Cloud Run guide | |
| `google-cloud-run/prisma-generate` | A `CMD` (or its start script) that doesn't run `prisma generate`, with none in the Dockerfile either | |
| `google-cloud-run/secret-latest` | A secret read as `latest` | |
| `google-cloud-run/task-route-public` | A `tasks.*`, `schedules.*`, or `pubsub.*` route with no `K_SERVICE` check, which the public service also serves | |
| `google-cloud-run/delete-queue` | `deleteQueue`, which blocks the name for 3 days | |
| `google-cloud-run/pubsub-expiration` | A subscription without `--expiration-period`, deleted after 31 quiet days | `gcloud pubsub subscriptions describe shopify-webhooks-worker --format="yaml(expirationPolicy)"` |
| `google-cloud-run/instance-limits` | A public service deployed without `--min` or `--max` | `gcloud run services describe my-app-web --region=us-central1 --format=yaml` shows the `minScale` and `maxScale` annotations |
| Traffic pinned by a rollback | The newest revision gets no traffic | `gcloud run services describe my-app-web --region=us-central1 --format="yaml(status.traffic)"` should show `latestRevision: true` at `percent: 100` |

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| `Detected an empty appUrl configuration`, `Missing values for: apiKey`, or `Missing values for: apiSecretKey`, and no revision becomes ready | A service or job that imports `shopify.server.ts` lacks `SHOPIFY_APP_URL`, `SHOPIFY_API_KEY`, or `SHOPIFY_API_SECRET` | Put them in the env vars file and secrets every service uses ([Set up development and deploys](https://docs.gadget.dev/guides/moving-to-another-platform/google-cloud-run#set-up-development-and-deploys)) |
| A task's attempt ends `DEADLINE_EXCEEDED` while its logs show the job still running, then a second copy starts | The dispatch deadline is shorter than the job and the worker's `--timeout` | Raise both above the longest job ([Check your host's time limits](https://docs.gadget.dev/guides/moving-to-another-platform/google-cloud-run#check-your-host-s-time-limits)) |
| Every attempt of a long job fails with `504` at 5 minutes | The worker kept Cloud Run's default `--timeout` | `--timeout=15m` on the worker, matching the dispatch deadline |
| `PERMISSION_DENIED` naming `cloudtasks.queues.create` on install | Cloud Tasks Enqueuer can't create queues | `roles/cloudtasks.queueAdmin` on the account that creates them |
| `SigningError: Permission 'iam.serviceAccounts.signBlob' denied on resource (or it may not exist).` | Signing a URL on Cloud Run goes through IAM, and the account can't sign as itself | Token Creator on its own account ([Search, files, and other services](https://docs.gadget.dev/guides/moving-to-another-platform/google-cloud-run#search-files-and-other-services)) |
| `createTask` fails with code `5` (`NOT_FOUND`) for one store | That store's queue was never created, such as for a store installed under Gadget, or it is reactivating after 30 idle days | `enqueueForShop` below creates it and retries ([Limit concurrency per store](https://docs.gadget.dev/guides/moving-to-another-platform/google-cloud-run#limit-concurrency-per-store)) |
| The fix you deployed after a rollback never gets traffic | `update-traffic --to-revisions` pinned traffic | `gcloud run services update-traffic my-app-web --to-latest --region=us-central1` |
| A webhook answered `200` but its order was never saved | Work after the response gets no CPU with request-based billing | Create the task before responding ([Receive webhooks](https://docs.gadget.dev/guides/moving-to-another-platform/google-cloud-run#receive-webhooks)) |

## Complete examples

With Cloud Tasks, Cloud SQL, Secret Manager, and Cloud Storage, one project per environment: `my-app-staging` and `my-app-production`. Each script takes the environment, so both are set up and deployed the same way. The image is the template's Dockerfile with `RUN npx prisma generate` before `RUN npm run build` and `CMD ["npm", "run", "start"]`, like the one in [fly-io.md](fly-io.md#complete-examples) without Supercronic.

Every account, role, and binding the guide names, in one script. Run it as a project owner once per project, and again after the first deploy, because the last section needs `my-app-worker` to exist:

```bash
# in scripts/gcp-iam.sh
# usage: bash scripts/gcp-iam.sh staging   or   bash scripts/gcp-iam.sh production
set -euo pipefail
ENV="${1:?usage: gcp-iam.sh staging|production}"
PROJECT="my-app-${ENV}"
REGION=us-central1
BUCKET="gs://${PROJECT}-files"
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
sa() { echo "$1@${PROJECT}.iam.gserviceaccount.com"; }
grant_project() { gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$1" --role="$2" --condition=None --quiet >/dev/null; }
grant_on_account() { gcloud iam service-accounts add-iam-policy-binding "$1" --project="$PROJECT" --member="serviceAccount:$2" --role="$3" --quiet >/dev/null; }

# each service runs as its own account, never the Compute Engine default; tasks-invoker, scheduler,
# and pubsub-invoker only sign the tokens that call the private worker
for name in my-app-web my-app-worker tasks-invoker scheduler pubsub-invoker; do
  gcloud iam service-accounts describe "$(sa "$name")" --project="$PROJECT" >/dev/null 2>&1 || gcloud iam service-accounts create "$name" --project="$PROJECT"
done
for secret in database-url shopify-api-secret; do
  gcloud secrets describe "$secret" --project="$PROJECT" >/dev/null 2>&1 || gcloud secrets create "$secret" --project="$PROJECT"
done
gcloud storage buckets describe "$BUCKET" >/dev/null 2>&1 || gcloud storage buckets create "$BUCKET" --project="$PROJECT" --location="$REGION"

for name in my-app-web my-app-worker; do
  grant_project "$(sa "$name")" roles/cloudsql.client            # --add-cloudsql-instances
  grant_project "$(sa "$name")" roles/cloudtasks.enqueuer        # createTask
  grant_project "$(sa "$name")" roles/cloudtasks.queueAdmin      # createQueue, one queue per store
  grant_on_account "$(sa tasks-invoker)" "$(sa "$name")" roles/iam.serviceAccountUser        # oidcToken as tasks-invoker
  grant_on_account "$(sa "$name")" "$(sa "$name")" roles/iam.serviceAccountTokenCreator     # signed URLs without a key file
  gcloud secrets add-iam-policy-binding database-url --project="$PROJECT" --member="serviceAccount:$(sa "$name")" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
  gcloud secrets add-iam-policy-binding shopify-api-secret --project="$PROJECT" --member="serviceAccount:$(sa "$name")" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
  gcloud storage buckets add-iam-policy-binding "$BUCKET" --member="serviceAccount:$(sa "$name")" --role=roles/storage.objectViewer >/dev/null   # signed reads
  gcloud storage buckets add-iam-policy-binding "$BUCKET" --member="serviceAccount:$(sa "$name")" --role=roles/storage.objectCreator >/dev/null  # signed uploads
done

# Cloud Tasks itself makes the OIDC token as tasks-invoker
grant_on_account "$(sa tasks-invoker)" "service-${NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com" roles/iam.serviceAccountUser

# only when Shopify publishes webhooks to Pub/Sub: lets Pub/Sub move failed messages to the dead-letter topic
if gcloud pubsub subscriptions describe shopify-webhooks-worker --project="$PROJECT" >/dev/null 2>&1; then
  gcloud pubsub topics add-iam-policy-binding shopify-webhooks-dead-letter --project="$PROJECT" --member="serviceAccount:service-${NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" --role=roles/pubsub.publisher >/dev/null
  gcloud pubsub subscriptions add-iam-policy-binding shopify-webhooks-worker --project="$PROJECT" --member="serviceAccount:service-${NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" --role=roles/pubsub.subscriber >/dev/null
fi

# the three callers of the private worker
if gcloud run services describe my-app-worker --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
  for name in tasks-invoker scheduler pubsub-invoker; do
    gcloud run services add-iam-policy-binding my-app-worker --project="$PROJECT" --region="$REGION" --member="serviceAccount:$(sa "$name")" --role=roles/run.invoker >/dev/null
  done
else
  echo "my-app-worker doesn't exist yet: deploy it, then run this script again"
fi
```

The variables both services and every job that imports `shopify.server.ts` need. `--env-vars-file` replaces all of a service's variables, so each file holds the whole list:

```yaml
# in production.env.yaml
APP_ENV: production
SHOPIFY_APP_URL: https://app.example.com
SHOPIFY_API_KEY: production-client-id
SCOPES: write_products
WORKER_URL: https://my-app-worker-123456789.us-central1.run.app
TASKS_SERVICE_ACCOUNT: tasks-invoker@my-app-production.iam.gserviceaccount.com
FILES_BUCKET: my-app-production-files
```

```yaml
# in staging.env.yaml
APP_ENV: staging
SHOPIFY_APP_URL: https://my-app-web-987654321.us-central1.run.app
SHOPIFY_API_KEY: staging-client-id
SCOPES: write_products
WORKER_URL: https://my-app-worker-987654321.us-central1.run.app
TASKS_SERVICE_ACCOUNT: tasks-invoker@my-app-staging.iam.gserviceaccount.com
FILES_BUCKET: my-app-staging-files
```

The deploy, with the guide's order (one image, migrations once, worker before web) and the two traffic commands that undo a pinned rollback:

```bash
# in scripts/deploy.sh
# usage: bash scripts/deploy.sh staging   or   bash scripts/deploy.sh production
set -euo pipefail
ENV="${1:?usage: deploy.sh staging|production}"
PROJECT="my-app-${ENV}"
REGION=us-central1
SQL="${PROJECT}:${REGION}:my-app-db"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/my-app/server:$(git rev-parse --short HEAD)"
# every secret a service reads, pinned; --set-secrets replaces the service's whole list
SECRETS="DATABASE_URL=database-url:1,SHOPIFY_API_SECRET=shopify-api-secret:1"

gcloud builds submit --project="$PROJECT" --tag="$IMAGE"

# --wait returns when the migration finishes, and set -e stops here if it failed (with pooling on, see the guide)
gcloud run jobs deploy my-app-migrate --project="$PROJECT" --region="$REGION" --image="$IMAGE" \
  --command=npx --args=prisma,migrate,deploy \
  --service-account="my-app-worker@${PROJECT}.iam.gserviceaccount.com" \
  --set-cloudsql-instances="$SQL" --set-secrets="$SECRETS" \
  --max-retries=0 --task-timeout=15m --wait

# the worker first, so it has every task route before the web creates tasks; --timeout matches enqueue's deadline
gcloud run deploy my-app-worker --project="$PROJECT" --region="$REGION" --image="$IMAGE" \
  --no-allow-unauthenticated --timeout=15m --max=5 \
  --service-account="my-app-worker@${PROJECT}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="$SQL" --env-vars-file="${ENV}.env.yaml" --set-secrets="$SECRETS"

# --min=1 so webhooks don't wait for a cold start; --max=10 times a pool of 10 stays under max_connections
gcloud run deploy my-app-web --project="$PROJECT" --region="$REGION" --image="$IMAGE" \
  --allow-unauthenticated --min=1 --max=10 \
  --service-account="my-app-web@${PROJECT}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="$SQL" --env-vars-file="${ENV}.env.yaml" --set-secrets="$SECRETS"

# a rollback with update-traffic pins traffic, and every later deploy gets none until this runs
gcloud run services update-traffic my-app-worker --project="$PROJECT" --region="$REGION" --to-latest
gcloud run services update-traffic my-app-web --project="$PROJECT" --region="$REGION" --to-latest
```

The guide's `enqueue` helper, with what a migrated app hits on top: stores installed under Gadget never run your install code, so their queues don't exist; a queue idle for 30 days answers `NOT_FOUND` while it wakes up; there's no emulator for development; and Gadget's `trigger.attemptNumber` becomes a header. With `@google-cloud/tasks`:

```typescript
// in app/tasks.server.ts
import { createHash } from "node:crypto";
import { CloudTasksClient, protos } from "@google-cloud/tasks";

const client = new CloudTasksClient();
const location = process.env.TASKS_LOCATION ?? "us-central1";
export const WORKER_SERVICE = "my-app-worker"; // Cloud Run sets K_SERVICE to the service's name
// gRPC status codes from Cloud Tasks
const NOT_FOUND = 5;
const ALREADY_EXISTS = 6;
const codeOf = (error: unknown) => (error as { code?: number }).code;

export interface EnqueueOptions {
  // the same on every delivery of the same work, such as a webhook id or "prune-audit-logs-2026-11-10"
  key?: string;
  startAt?: Date;
}

export async function enqueue(queue: string, path: string, body: unknown, options: EnqueueOptions = {}) {
  const url = new URL(path.replace(/^\/+/, ""), `${process.env.WORKER_URL}/`).toString();
  if (process.env.APP_ENV === "development") {
    // no emulator: post to the local server instead, without waiting, as a queue would
    const delay = options.startAt ? Math.max(0, options.startAt.getTime() - Date.now()) : 0;
    setTimeout(() => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(console.error), delay);
    return;
  }
  const parent = client.queuePath(await client.getProjectId(), location, queue);
  const task: protos.google.cloud.tasks.v2.ITask = {
    // a task name holds only letters, numbers, hyphens, and underscores; a hex SHA-256 always fits
    name: options.key ? `${parent}/tasks/${createHash("sha256").update(options.key).digest("hex")}` : undefined,
    scheduleTime: options.startAt ? { seconds: Math.floor(options.startAt.getTime() / 1000) } : undefined,
    // at or above the worker's --timeout of 15 minutes, so Cloud Tasks never retries a job that's still running
    dispatchDeadline: { seconds: 15 * 60 },
    httpRequest: {
      httpMethod: "POST",
      url,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
      oidcToken: { serviceAccountEmail: process.env.TASKS_SERVICE_ACCOUNT, audience: process.env.WORKER_URL },
    },
  };
  try {
    await client.createTask({ parent, task });
  } catch (error) {
    // a task with this key exists or finished recently, so this delivery is a duplicate
    if (codeOf(error) !== ALREADY_EXISTS) throw error;
  }
}

// queue: { name: `external-${shopId}`, maxConcurrency: 2 } on Gadget
export async function createShopQueue(shopId: string) {
  const projectId = await client.getProjectId();
  try {
    await client.createQueue({
      parent: client.locationPath(projectId, location),
      queue: {
        name: client.queuePath(projectId, location, `external-${shopId}`),
        rateLimits: { maxConcurrentDispatches: 2 },
        // 7 attempts, 1 second apart and doubling, like Gadget's 6 retries
        retryConfig: { maxAttempts: 7, minBackoff: { seconds: 1 }, maxDoublings: 5, maxBackoff: { seconds: 60 } },
      },
    });
  } catch (error) {
    if (codeOf(error) !== ALREADY_EXISTS) throw error;
  }
}

export async function enqueueForShop(shopId: string, path: string, body: unknown, options: EnqueueOptions = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await enqueue(`external-${shopId}`, path, body, options);
    } catch (error) {
      // after 3 tries the error reaches the caller, and Shopify's or the outer task's retry comes back later
      if (codeOf(error) !== NOT_FOUND || attempt === 3) throw error;
      await createShopQueue(shopId);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

// null on the public web service, which has every task route too
export function workerTask(request: Request) {
  if (process.env.K_SERVICE !== WORKER_SERVICE && process.env.APP_ENV !== "development") return null;
  // 0 on the first attempt; trust it only because Cloud Run checked the caller's token
  const retries = Number(request.headers.get("X-CloudTasks-TaskRetryCount") ?? "0");
  return { attempt: retries + 1, queue: request.headers.get("X-CloudTasks-QueueName") };
}
```

A task route for the `notifyExternalSystem` background action, per store:

```typescript
// in app/routes/tasks.notify-external-system.tsx
import type { ActionFunctionArgs } from "react-router";
import { workerTask } from "../tasks.server";
import { notifyExternalSystem } from "../services/external.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const task = workerTask(request);
  if (!task) return new Response(null, { status: 404 });
  const { orderId } = (await request.json()) as { orderId: string };
  console.log(`notifyExternalSystem for order ${orderId}, attempt ${task.attempt} of 7`);
  // a throw answers 500, and any status outside 200 to 299 makes Cloud Tasks retry
  await notifyExternalSystem(orderId);
  return new Response();
};
```

Callers use ``enqueueForShop(shopId, "tasks/notify-external-system", { orderId }, { key: `notify-${orderId}` })``. The guide's [signed URL helpers](https://docs.gadget.dev/guides/moving-to-another-platform/google-cloud-run#search-files-and-other-services) work as written once the IAM script has run.

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [cutover section](https://docs.gadget.dev/guides/moving-to-another-platform/google-cloud-run#cut-over-to-the-new-platform) holds. On Google Cloud:

- **Scheduler jobs run as soon as they exist.** Create them paused (`gcloud scheduler jobs create http ...` then `gcloud scheduler jobs pause prune-audit-logs --location=us-central1`) and resume them in the "Move scheduled work" step.
- **Per-store queues for existing stores.** `enqueueForShop` creates each one on first use. A project has [1,000 queues per region](https://docs.cloud.google.com/tasks/docs/quotas) by default, so an app on more stores than that asks for a quota increase before the switch.
- **Deploys don't cut off jobs.** Requests in progress finish on the old revision. An instance stopped for other reasons gets 10 seconds after `SIGTERM`, so the task's retry is what saves the job.
- **Rollback:** `gcloud run services update-traffic my-app-web --to-revisions=<revision>=100`, then the next `scripts/deploy.sh` moves traffic back to the latest. It doesn't undo migrations.

## What wasn't verified

No Google Cloud project was used, so nothing was deployed and no IAM grant was tested. Run locally on 10 November 2026:

- Every `gcloud` command in `scripts/gcp-iam.sh` and `scripts/deploy.sh` was parsed by Google Cloud SDK 593.0.0 in its Docker image, unauthenticated: a misspelled flag or a bad value such as `--timeout=abc` fails before the login check, and none did.
- `app/tasks.server.ts` and the task route typecheck with `@google-cloud/tasks` 7.3.1 and TypeScript 5.9.3. Their retry paths ran against a stubbed `CloudTasksClient`, not Cloud Tasks.
- The `Detected an empty appUrl configuration` and `Missing values for:` errors came from `@shopify/shopify-app-react-router` 3.0.2 with each variable removed.

From Google's docs, the guide, or its fact-check only, and not reproduced: the `DEADLINE_EXCEEDED` and `504` behavior, the `PERMISSION_DENIED` and `signBlob` messages (Google's standard IAM error text), whether `gcloud run jobs deploy --wait` exits non-zero when the execution fails, the 3-day queue name hold, `NOT_FOUND` from a reactivating queue, the Pub/Sub expiration and dead-letter roles, the Cloud Tasks service agent's Service Account User grant.
