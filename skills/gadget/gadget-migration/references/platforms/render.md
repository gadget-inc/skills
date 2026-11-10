# Render

## What is this?

Render runs the web server, a background worker, cron jobs, Postgres, and Key Value (a Redis-compatible store) as services, described in one `render.yaml` Blueprint. Most of what goes wrong is in that file: a Key Value that deletes queued jobs, a worker that never hears `SIGTERM`, and migrations sent through the connection pool. Gadget's guide: https://docs.gadget.dev/guides/moving-to-another-platform/render

Read [common.md](common.md) first.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform render
```

| Check | What it catches | How to check by hand |
|---|---|---|
| `render/keyvalue-eviction` | The queue's Key Value without `maxmemoryPolicy: noeviction`. The default, `allkeys-lru`, deletes jobs when memory is full | `render kv get my-app-queue --environment production -o json` shows `"maxmemoryPolicy"`. Fix a live one with `render kv update my-app-queue --memory-policy noeviction` |
| `render/keyvalue-persistence` | A queue on the free plan or `persistenceMode: off` (memory only), or `snapshot` | The same `render kv get` output shows `"persistenceMode"` |
| `render/worker-command` | A worker with no `dockerCommand`, which runs the Dockerfile's `CMD` (the template's web server), or one that starts through `npm`, `yarn`, or `pnpm` | |
| `render/shutdown-delay` | A worker on the default 30 seconds between `SIGTERM` and `SIGKILL`, or a `maxShutdownDelaySeconds` over 300 | Compare the delay with the longest `timeoutMS` in `MIGRATION_INVENTORY.md` |
| `render/migrate-on-start`, `render/no-migrations` | A `dockerCommand` that migrates on every instance, or nothing that migrates at all | |
| `render/prisma-generate` | A `dockerCommand` that skips the template's `docker-start`, with no `prisma generate` in the Dockerfile | |
| `render/migrations-through-pool` | Prisma's `directUrl` variable, or the variable a migrating service uses, set from `connectionPoolString` | `render psql my-app-db -c "select pid from pg_locks where locktype = 'advisory' and objid = 72707369"` lists a stuck lock |
| `render/owner-skips-rls` | A table with row-level security that isn't forced, while the app connects with a `fromDatabase` URL, as the user that owns the tables. The guide's [Set up development and deploys](https://docs.gadget.dev/guides/moving-to-another-platform/render#set-up-development-and-deploys) gives the separate role | `psql "$DATABASE_URL" -f path/to/skills/gadget-migration/scripts/db-check.sql` |
| `render/health-check`, `render/single-instance` | A web service with no `healthCheckPath`, or one instance in production | `curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/healthz` prints `200` |
| `render/open-to-internet` | A database with no `ipAllowList`, or any `0.0.0.0/0` entry | |
| `render/env-group-secret`, `render/env-group-reference` | `sync: false` in a Blueprint environment group (never set), or a group that references a database or service (fails validation) | |
| `render/region` | A service that reads a database or service in another region | |
| `render/free-plan`, `render/disk` | Free plans in production, and a persistent disk used as file storage | |
| `render/cron-job` | Every cron job: it runs from the moment a sync creates it | Add it in the cutover step only |
| `render/workflows-start` | `startTask` called outside a rate-limited queue job, so a burst over the plan's limit gets `429` errors nothing retries | Copy the slug from the task's page in the dashboard |
| `render/blueprint-unreadable` | A `render.yaml` the script can't parse | Validate it against Render's schema, as in [Complete examples](#complete-examples) |

Three checks need Render itself:

- **The worker heard its eviction warning:** `render logs --resources <worker-service-id> --text "Eviction policy" --limit 5` prints nothing on a correct Key Value. BullMQ logs the warning once per connection.
- **A limit that must hold during deploys:** `render kv-cli my-app-queue`, then `HGET bull:external:meta concurrency`. It prints the global concurrency, or nothing when the only limit is each worker's `concurrency` option, which the deploy overlap doubles.
- **Outbound addresses for Shopify's allowlist:** the service's **Connect** > **Outbound** tab, looked up as [IP allowlists](https://docs.gadget.dev/guides/moving-to-another-platform/render#ip-allowlists) shows.

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| `IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"` in the worker log, and jobs that never run, though every `add` succeeded | Key Value created without `maxmemoryPolicy` | `maxmemoryPolicy: noeviction` in `render.yaml`, or `render kv update` as above ([Create a Key Value instance](https://docs.gadget.dev/guides/moving-to-another-platform/render#create-a-key-value-instance-for-your-queue)) |
| `Error: P1002` with `Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.` in the pre-deploy log | An earlier `prisma migrate deploy` ran through the pool on port 6432. The pool keeps Migrate's session-level lock on its server connection after Migrate exits, so even a migration over the direct URL waits for it | Set `directUrl`'s variable from `property: connectionString`, then end the holder: `select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = 72707369` ([Connect through the connection pool](https://docs.gadget.dev/guides/moving-to-another-platform/render#connect-through-the-connection-pool)) |
| ``The table `public.Session` does not exist in the current database.`` on the first request | `dockerCommand: npm run start` replaced the template's `docker-start`, and no `preDeployCommand` runs migrations | `preDeployCommand: npx prisma migrate deploy` on the web service |
| `prepared statement "s0" already exists` through `connectionPoolString` | Render doesn't publish its PgBouncer version, and its pool string has no query string for `pgbouncer=true` | Add the parameter in code, as in [Connect through the connection pool](https://docs.gadget.dev/guides/moving-to-another-platform/render#connect-through-the-connection-pool) |
| `job stalled more than allowable limit` after two deploys close together, or after an environment group edit | Each deploy killed a job that outlived the shutdown delay, and a group edit redeploys every linked service with auto-deploy on | Jobs shorter than `maxShutdownDelaySeconds`, or a Workflows task ([Check your host's time limits](https://docs.gadget.dev/guides/moving-to-another-platform/render#check-your-host-s-time-limits)) |
| `Failed to run task:` from `startTask`, a `ClientError` with `statusCode` `429` | More starts a minute than the workspace plan allows. Render rejects them instead of queuing | Start runs from a rate-limited queue, as in the example below |
| `relation "widget_import" already exists` on a second load | The load script ran through the pool URL, port 6432 | Use the external URL from the database's **Info** page, port 5432 ([Load your records](https://docs.gadget.dev/guides/moving-to-another-platform/render#load-your-records)) |

## Complete examples

### A Blueprint with production, staging, and previews

The guide's Blueprint has production only. This one adds a staging environment with its own database, Key Value, and Shopify app, and preview settings. It validates against Render's JSON schema, which you can run without a Render login: `npx ajv-cli@5.0.0 validate --spec=draft2020 --strict=false -s render.yaml.json -d render.yaml` prints `render.yaml valid` after `curl -o render.yaml.json https://render.com/schema/render.yaml.json`. `render blueprints validate render.yaml` needs `render login`.

```yaml
# in render.yaml
# a pull request whose title includes [render preview] gets a preview environment, on Pro and higher
previews:
  generation: manual
projects:
  - name: my-app
    environments:
      - name: production
        envVarGroups:
          # values only: a group defined here can't hold sync: false secrets or reference a database.
          # my-app-secrets is created in the dashboard: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, RENDER_API_KEY, and
          # DATABASE_URL, the pool URL of a role you create, because fromDatabase's user owns the tables and skips their policies
          - name: my-app-config
            envVars:
              - { key: APP_ENV, value: production }
              - { key: SHOPIFY_APP_URL, value: https://app.example.com }
              - { key: SCOPES, value: "read_products,write_products" }
        services:
          - type: web
            name: my-app-web
            runtime: docker
            region: oregon
            plan: 1c-2g
            numInstances: 2
            healthCheckPath: /healthz
            # the server only; migrations run once per deploy, before it starts
            dockerCommand: npm run start
            preDeployCommand: npx prisma migrate deploy
            autoDeployTrigger: checksPass
            domains: [app.example.com]
            previews: { plan: 0.5c-512mb, numInstances: 1 }
            envVars:
              # migrations run as the default user, which owns the tables
              - key: DIRECT_DATABASE_URL
                fromDatabase: { name: my-app-db, property: connectionString }
              - key: REDIS_URL
                fromService: { type: keyvalue, name: my-app-queue, property: connectionString }
              - fromGroup: my-app-config
              - fromGroup: my-app-secrets
          - type: worker
            name: my-app-worker
            runtime: docker
            region: oregon
            plan: 1c-2g
            # node itself, so SIGTERM reaches the worker; npm run build compiles it (see common.md)
            dockerCommand: node build/worker.js
            maxShutdownDelaySeconds: 300
            autoDeployTrigger: checksPass
            envVars:
              - key: REDIS_URL
                fromService: { type: keyvalue, name: my-app-queue, property: connectionString }
              - fromGroup: my-app-config
              - fromGroup: my-app-secrets
          # add in the cutover's Move scheduled work step, not before
          - type: cron
            name: my-app-prune-audit-logs
            runtime: docker
            region: oregon
            plan: 0.5c-512mb
            schedule: "0 2 * * *"
            dockerCommand: node build/enqueue-prune-audit-logs.js
            envVars:
              - key: REDIS_URL
                fromService: { type: keyvalue, name: my-app-queue, property: connectionString }
          - type: keyvalue
            name: my-app-queue
            region: oregon
            plan: 1g
            previewPlan: 256mb
            # a full instance fails new adds instead of deleting queued jobs
            maxmemoryPolicy: noeviction
            ipAllowList: []
        databases:
          - name: my-app-db
            region: oregon
            plan: 1c-4g
            # room for every model and its indexes before the load; storage never shrinks
            diskSizeGB: 100
            previewPlan: 0.1c-256mb
            previewDiskSizeGB: 5
            connectionPool: pgbouncer
            ipAllowList: []
      - name: staging
        envVarGroups:
          - name: my-app-staging-config
            envVars:
              - { key: APP_ENV, value: staging }
              - { key: SHOPIFY_APP_URL, value: https://staging.example.com }
              - { key: SCOPES, value: "read_products,write_products" }
        services:
          - type: web
            name: my-app-staging-web
            runtime: docker
            region: oregon
            plan: 0.5c-512mb
            healthCheckPath: /healthz
            dockerCommand: npm run start
            preDeployCommand: npx prisma migrate deploy
            domains: [staging.example.com]
            envVars:
              - key: DIRECT_DATABASE_URL
                fromDatabase: { name: my-app-staging-db, property: connectionString }
              - key: REDIS_URL
                fromService: { type: keyvalue, name: my-app-staging-queue, property: connectionString }
              - fromGroup: my-app-staging-config
              # the staging Shopify app's key and secret, and the app role's DATABASE_URL, created in the dashboard
              - fromGroup: my-app-staging-secrets
          - type: worker
            name: my-app-staging-worker
            runtime: docker
            region: oregon
            plan: 0.5c-512mb
            dockerCommand: node build/worker.js
            maxShutdownDelaySeconds: 300
            envVars:
              - key: REDIS_URL
                fromService: { type: keyvalue, name: my-app-staging-queue, property: connectionString }
              - fromGroup: my-app-staging-config
              - fromGroup: my-app-staging-secrets
          - type: keyvalue
            name: my-app-staging-queue
            region: oregon
            plan: 256mb
            maxmemoryPolicy: noeviction
            ipAllowList: []
        databases:
          - name: my-app-staging-db
            region: oregon
            plan: 0.5c-1g
            diskSizeGB: 10
            connectionPool: pgbouncer
            ipAllowList: []
```

The Dockerfile needs `RUN npx prisma generate` after `COPY . .`, because `npm run start` skips the template's `docker-start` ([common.md](common.md)). The app's own role is the one the guide's [Set up development and deploys](https://docs.gadget.dev/guides/moving-to-another-platform/render#set-up-development-and-deploys) creates; test it through the pool on staging, because Render doesn't say whether its pool accepts roles you create. Hobby workspaces get 2 environments per project, so this file fits, but previews need Pro.

### Start Workflows runs under the start limit

The guide says to start each Render Workflows run from a queued job, because Render rejects starts over its per-minute limit with a `429` instead of queuing them. With BullMQ, for example, the nightly cron job calls `queueReconciliations` with the 300 store ids, and this worker starts the runs at most 40 a minute, under Hobby's 50. BullMQ keeps the limiter in Redis, so it holds across every worker instance, including the old one during a deploy:

```typescript
// in app/jobs/reconcile-all-shops.server.ts
// connection is the ioredis connection from common.md's app/queues.server.ts
import { connection } from "../queues.server";
import { ClientError, Render } from "@renderinc/sdk";
import { Queue, Worker } from "bullmq";

// copied from the task's page in the Render Dashboard
const TASK_SLUG = "my-app-workflows/reconcileShop";

export const workflowStarts = new Queue("workflow-starts", { connection });

// one job per store and day, so a second cron run on the same day adds nothing
export async function queueReconciliations(shopIds: string[], day = new Date().toISOString().slice(0, 10)) {
  await workflowStarts.addBulk(
    shopIds.map((shopId) => ({
      name: "reconcileShop",
      data: { shopId, day },
      opts: { jobId: `reconcile-${shopId}-${day}`, attempts: 7, backoff: { type: "exponential", delay: 1000 } },
    }))
  );
}

export function startWorkflowStartsWorker() {
  // reads RENDER_API_KEY; created here, so a cron script that only queues jobs doesn't need the key
  const render = new Render();
  const worker: Worker = new Worker(
    "workflow-starts",
    async (job) => {
      try {
        // Render returns the first run for a repeated key within 24 hours, so a retry starts nothing new
        const run = await render.workflows.startTask(TASK_SLUG, [job.data.shopId], { idempotencyKey: `reconcile-${job.data.shopId}-${job.data.day}` });
        return run.taskRunId;
      } catch (error) {
        if (error instanceof ClientError && error.statusCode === 429) {
          // pause the whole queue for a minute without using one of the job's attempts
          await worker.rateLimit(60_000);
          throw Worker.RateLimitError();
        }
        throw error;
      }
    },
    { connection, concurrency: 5, limiter: { max: 40, duration: 60_000 } }
  );
  return worker;
}
```

A concurrency limit needs the same treatment. Each worker's `concurrency` option counts only its own jobs, so a deploy doubles it for a minute, and the old instance keeps finishing jobs for up to `maxShutdownDelaySeconds`. Set the limit on the queue once, such as `await externalQueue.setGlobalConcurrency(10)` when the worker starts: BullMQ stores it in `bull:external:meta`, and every instance shares it.

## Cutover

The order in [cutover.md](../cutover.md) holds. On Render, per [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform/render#cut-over-to-the-new-platform):

- **Backfill:** `render jobs create <worker-service-id> --start-command "npm run backfill"` runs it inside Render with the worker's latest build and variables, which Shopify's allowlist accepts. A one-off job runs up to 30 days, and a deploy of the worker doesn't stop it.
- **Move scheduled work:** add the cron services to `render.yaml` and sync in this step. The preflight lists each one as `render/cron-job`.
- **Before `shopify app deploy`:** the custom domain shows as verified, and `curl -sSf https://app.example.com/healthz` succeeds, which also proves the certificate.
- **During the switch:** don't edit an environment group. Render redeploys every linked service with auto-deploy on, and each worker gets at most `maxShutdownDelaySeconds` to finish its jobs.
- **Rolling back:** a dashboard rollback redeploys an earlier build with that deploy's variables and turns off auto-deploy for the service. It doesn't touch the database, so migrations stay applied. Turn auto-deploy back on once the fix ships ([Moving back](../cutover.md#moving-back)).

## What wasn't verified

Run locally: the Blueprint above against https://render.com/schema/render.yaml.json (fetched 10 November 2026) with Ajv 8.17.1, and through `preflight.ts`; the Workflows starter against a stand-in for Render's API with `@renderinc/sdk` 1.8.0 and BullMQ 6.7.3, typechecked with TypeScript 5.9.3; `allkeys-lru` and `noeviction` with BullMQ on `valkey/valkey:8` (8.1.11), the major version Render runs; a job stalled by two worker kills; `setGlobalConcurrency` across two workers; the `P1002` lock left by `prisma migrate deploy` (Prisma 6.19.3) through PgBouncer 1.25.2 in transaction mode, and the `P2021` error on an unmigrated database.

Not run, because they need a Render account: `render blueprints validate`, a Blueprint sync, the `render` CLI commands above (their flags come from `render --help` in CLI 2.36.0), Render's PgBouncer (its version is unpublished, so whether it keeps prepared statements and Migrate's lock the way 1.25.2 does is unknown), how preview environments treat a Blueprint with several project environments, the exact `429` body from Render's start limit, and whether Render runs `dockerCommand` through a shell, which decides whether `SIGTERM` reaches npm at all. pnpm not passing `SIGTERM` on is the Railway guide's test, not this file's. Deploy timing (60 seconds of overlap, then `SIGTERM`), the start limits, the rollback behavior, and that roles made with `create role` work come from Render's docs and the guide's fact-check, not a test.
