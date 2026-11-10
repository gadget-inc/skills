# Trigger.dev

## What is this?

Trigger.dev is a hosted queue that builds your tasks into a container and runs them on its own machines, so it replaces background actions and scheduled actions, and the host's request timeout no longer applies. Gadget's guide covers the setup and each option: https://docs.gadget.dev/guides/moving-to-another-platform/trigger-dev.

For Trigger.dev itself (project setup, writing tasks, queues, schedules), load Trigger.dev's skills: `npx trigger.dev@latest skills` (installs `trigger-getting-started` and `trigger-authoring-tasks`, pinned to your SDK version), or `npx skills add triggerdotdev/skills` (the same guides as `trigger-setup` and `trigger-tasks`) (https://github.com/triggerdotdev/skills). Neither covers deploys, so this file does. This file covers only what breaks or changes because the app came from Gadget.

Read [common.md](common.md) first, and [background-jobs.md](../background-jobs.md) for the option-by-option map from `api.enqueue`.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform trigger-dev
```

| Check | What it catches |
|---|---|
| `trigger-dev/cli-latest` | `trigger.dev@latest deploy` in a script, or `trigger.dev@latest` in a CI workflow that deploys. Deploys abort as soon as a CLI newer than your SDK ships. `trigger.dev@latest dev` is fine, and a command the script can't read is a warning. |
| `trigger-dev/version-mismatch`, `trigger-dev/sdk-version` | `@trigger.dev/*` packages at different versions or on `^` ranges that drift apart, and `concurrency` with an SDK older than 4.7.0, which ignores it: the version the lockfile installs, or with no lockfile an exact pin or a range such as `~4.6.0` that can't reach 4.7.0. |
| `trigger-dev/max-duration` | No `maxDuration` in `trigger.config.ts`. The type requires it, and the deploy build doesn't typecheck. |
| `trigger-dev/default-retries` | No `retries` in `trigger.config.ts`: tasks get 3 attempts, and Gadget made 7. |
| `trigger-dev/prisma-extension` | Tasks that import Prisma, with no `prismaExtension` in the build. |
| `trigger-dev/perkey-without-key` | A trigger of a `perKey` task with no `concurrencyKey`. Every store shares one pool. |
| `trigger-dev/idempotency-ttl` | An `idempotencyKey` with no `idempotencyKeyTTL`. The key blocks repeats for 30 days. |
| `trigger-dev/ttl-shorter-than-delay` | An `idempotencyKeyTTL` that ends before the `delay` does, so a repeat starts a second run. |
| `trigger-dev/priority-mixed`, `trigger-dev/negative-priority` | A task triggered with `priority` in some places and not others (none counts as 0, below `default`'s 300), and a negative `priority`, which holds a run back on an empty queue. |
| `trigger-dev/trigger-in-transaction` | A trigger inside `prisma.$transaction(...)`. A rollback leaves the run queued. |
| `trigger-dev/named-limit` | A `concurrencyLimit()` shared by tasks. It didn't hold on self-hosted 4.8.3. |
| `trigger-dev/schedule-window`, `trigger-dev/schedule-overlap` | A cron with no `window`, so each run starts some time in the hour after its cron time, and a scheduled task with no `concurrency: { total: 1 }`, so runs overlap. |
| `trigger-dev/schedule-deployed-early` | A declarative `cron`, which starts with the first production deploy. |
| `trigger-dev/db-client-in-run` | `new PrismaClient()` or `new Pool()` inside `run`, which opens a pool on every run. |
| `trigger-dev/env-vars` | The variables your tasks read. Trigger.dev doesn't see the host's. |
| `trigger-dev/on-failure-gaps` | `onFailure` hooks. They skip crashed, system-failed, timed-out, and canceled runs. |

What the script can't see:

- **Variables set on Trigger.dev.** `scripts/check-trigger-env.ts` below lists the names your tasks need that the project's production environment lacks.
- **The environment's concurrency limit.** On 300 stores, `perKey: 2` allows 600 runs, and the **Concurrency** page in the dashboard shows the environment's cap, which applies first. Each running task holds its own database pool, so size the pool for that cap: a cap of 200 runs with a pool of 1 needs 200 connections.
- **Static IPs.** A database that accepts only the host's network rejects tasks, which connect from Trigger.dev's machines. The addresses are on the dashboard's **Regions** page, on paid plans.
- **Each host's key.** A key belongs to one environment, and a run triggered with it goes there: with no deployment in that environment, it stays `QUEUED`. Check `TRIGGER_SECRET_KEY` starts with `tr_prod_` on production and `tr_stg_` on staging.

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| `ERROR: Version mismatch detected while running in CI. This won't end well. Aborting.`, then `CLI version: 4.8.4` and `- @trigger.dev/sdk@4.8.3`. Outside CI: `X Error: Your @trigger.dev packages don't match the CLI version (4.8.4).` | `npx trigger.dev@latest deploy` after a new CLI shipped | Run the CLI version your packages pin, such as `npx trigger.dev@4.8.3 deploy`, or add `trigger.dev` to `devDependencies` at the SDK's version (`trigger-dev/cli-latest`, [Deploy tasks](https://docs.gadget.dev/guides/moving-to-another-platform/trigger-dev#deploy-tasks)) |
| `Property 'maxDuration' is missing in type` from `tsc` on `trigger.config.ts` | No `maxDuration` | Set it above your longest action, such as `900` for Gadget's 15-minute maximum |
| `MAX_DURATION_EXCEEDED`, status **Timed out** | An attempt ran longer than `maxDuration`. `onFailure` doesn't run | Raise `maxDuration`, or split the task ([Check your host's time limits](https://docs.gadget.dev/guides/moving-to-another-platform/trigger-dev#check-your-host-s-time-limits)) |
| A run stays `QUEUED` and never starts | Triggered with another environment's key, or a negative `priority` on an empty queue | Use the environment's key; pass `0` for `low`. A run with no priority counts as 0, so `default` needs `300` |
| A second trigger with the same `idempotencyKey` starts a new run | The first run failed, which clears the key, or the TTL ran out | Expected. Gadget kept a failed job's id for 7 days, so make the job safe to run twice |
| Two tasks on one shared limit run 8 jobs for one store at once | A named `concurrencyLimit()` that isn't enforced, as on self-hosted 4.8.3 | Share a `queue({ concurrencyLimit })`, as below |
| `@prisma/client did not initialize yet` in a run | The deployed image has no generated Prisma client | `prismaExtension({ mode: "legacy", schema: "prisma/schema.prisma" })` in `build.extensions` |

## Complete examples

The guide's [Configure the project](https://docs.gadget.dev/guides/moving-to-another-platform/trigger-dev#configure-the-project) config is the base. These files add what the guide trims: variables synced on each deploy, a limit two tasks share, a scheduled task attached at cutover, and a helper that maps every `api.enqueue` option.

### The project config

```typescript
// in trigger.config.ts
import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

// every variable the tasks read; preflight's trigger-dev/env-vars finding lists them
const TASK_ENV = ["DATABASE_URL", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "EXTERNAL_API_TOKEN"];

export default defineConfig({
  project: "proj_abc123",
  dirs: ["./app/trigger"],
  // 15 minutes, Gadget's longest timeoutMS; time in wait.for doesn't count
  maxDuration: 900,
  retries: {
    enabledInDev: true,
    // Gadget's first attempt plus its 6 retries, 1 second apart and doubling
    default: { maxAttempts: 7, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 60_000, randomize: false },
  },
  build: {
    extensions: [
      prismaExtension({ mode: "legacy", schema: "prisma/schema.prisma" }),
      // copies values from the machine that runs deploy, such as CI secrets for production or staging
      syncEnvVars(({ environment }) => {
        const missing = TASK_ENV.filter((name) => !process.env[name]);
        if (missing.length) throw new Error(`set ${missing.join(", ")} before deploying to ${environment}`);
        return TASK_ENV.map((name) => ({ name, value: process.env[name]!, isSecret: true }));
      }),
    ],
  },
});
```

Deploy with the CLI version the packages pin, from the same CI job that holds each environment's secrets: `npx trigger.dev@4.8.3 deploy` for production and `npx trigger.dev@4.8.3 deploy --env staging` for staging. `TRIGGER_ACCESS_TOKEN` authenticates the deploy; `TRIGGER_SECRET_KEY` doesn't.

### Tasks on a shared limit

`externalQueue` is the guide's shared queue from [Share a limit between tasks](https://docs.gadget.dev/guides/moving-to-another-platform/trigger-dev#share-a-limit-between-tasks), in `app/trigger/queues.ts`. With the store's id as each trigger's `concurrencyKey`, every store gets its own pool of 2, shared by both tasks.

```typescript
// in app/trigger/notify-external-system.ts
import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { externalQueue } from "./queues";
import { notifyExternalSystem, OrderNotFoundError } from "../services/external.server";
import { reportFailedJob } from "../services/alerts.server";

export type NotifyPayload = { shopId: string; orderId: string };

async function notify(orderId: string) {
  try {
    await notifyExternalSystem(orderId);
  } catch (error) {
    // Gadget retried every error. A retry can't bring back a deleted order.
    if (error instanceof OrderNotFoundError) throw new AbortTaskRunError(error.message);
    throw error;
  }
}

export const notifyExternalSystemTask = task({
  id: "notify-external-system",
  queue: externalQueue,
  run: async (payload: NotifyPayload, { ctx }) => {
    // trigger.attemptNumber: 1 on the first attempt
    console.log(`order ${payload.orderId}, attempt ${ctx.attempt.number}`);
    await notify(payload.orderId);
  },
  // trigger.finalAttempt code: runs once after the last attempt or an AbortTaskRunError, but not for
  // crashed, system-failed, timed-out, or canceled runs, so alert on those in the dashboard too
  onFailure: async ({ payload, error }) => {
    await reportFailedJob("notify-external-system", payload.orderId, error instanceof Error ? error.message : String(error));
  },
});

// a second action that used the same Gadget queue: together the two run at most 2 jobs per store
export const notifyExternalSystemOfUpdateTask = task({
  id: "notify-external-system-of-update",
  queue: externalQueue,
  run: async (payload: NotifyPayload) => notify(payload.orderId),
});
```

### Triggering the way `api.enqueue` did

`enqueue` puts the store in `concurrencyKey`, passes a priority on every trigger, maps `startAt` to `delay`, and keeps an id for as long as Gadget did:

```typescript
// in app/services/jobs.server.ts
import { tasks, type AnyTask, type TaskIdentifier, type TaskPayload } from "@trigger.dev/sdk";

export interface EnqueueOptions {
  shopId: string;
  // api.enqueue's id: a repeat returns the first run while the key lasts. A failed run frees it at once.
  id?: string;
  priority?: "high" | "default" | "low";
  startAt?: Date;
}

// a run with no priority counts as 0, so default needs its own number
const PRIORITY = { high: 600, default: 300, low: 0 } as const;
const DAY = 24 * 60 * 60 * 1000;
// maxDuration in trigger.config.ts
const MAX_DURATION_MS = 900 * 1000;

// Call after the transaction commits, never inside it. Import tasks with `import type`.
export async function enqueue<TTask extends AnyTask>(id: TaskIdentifier<TTask>, payload: TaskPayload<TTask>, options: EnqueueOptions) {
  const delayMs = options.startAt ? Math.max(0, options.startAt.getTime() - Date.now()) : 0;
  return tasks.trigger<TTask>(id, payload, {
    concurrencyKey: options.shopId,
    priority: PRIORITY[options.priority ?? "default"],
    ...(options.startAt ? { delay: options.startAt } : {}),
    // Gadget kept an id until 1 day after the job succeeded. The TTL counts from the trigger, so add the delay and the run time.
    ...(options.id ? { idempotencyKey: options.id, idempotencyKeyTTL: `${Math.ceil((delayMs + MAX_DURATION_MS + DAY) / DAY)}d` } : {}),
  });
}
```

In the guide's `handleOrderCreated`, the trigger after the commit becomes ``await enqueue<typeof notifyExternalSystemTask>("notify-external-system", { shopId: String(shopId), orderId: String(order.id) }, { shopId: String(shopId), id: `order-created-${order.id}` })``, with the task imported by `import type`.

### A scheduled action, attached at cutover

A declarative `cron` starts running with the first production deploy. A scheduled task with no `cron` deploys idle, and a script attaches the schedule in the cutover's "Move scheduled work" step:

```typescript
// in app/trigger/prune-audit-logs.ts
import { schedules } from "@trigger.dev/sdk";
import { deleteAuditLogsOlderThan } from "../services/audit-logs.server";

export const pruneAuditLogs = schedules.task({
  id: "prune-audit-logs",
  // no cron here: scripts/attach-schedules.ts attaches 0 2 * * * at cutover
  // one run at a time, like Gadget, and a run that can't start within an hour expires
  concurrency: { total: 1 },
  ttl: "1h",
  // 5 attempts, like Gadget's scheduler
  retry: { maxAttempts: 5 },
  run: async () => {
    await deleteAuditLogsOlderThan(90);
  },
});
```

```typescript
// in scripts/attach-schedules.ts
// run at cutover with the environment's secret key, not a "Trigger only" one: TRIGGER_SECRET_KEY=tr_prod_... node scripts/attach-schedules.ts
// move back with: node scripts/attach-schedules.ts --detach
import { schedules } from "@trigger.dev/sdk";

const SCHEDULES = [{ task: "prune-audit-logs", cron: "0 2 * * *" }];

// deduplication keys are per project, not per environment, so the key names the environment
const environment = process.env.TRIGGER_SECRET_KEY?.match(/^tr_(\w+?)_/)?.[1] ?? "unknown";
const key = (task: string) => `${task}-${environment}`;

export async function attachSchedules() {
  // a second run updates the same schedules instead of adding more
  return Promise.all(SCHEDULES.map((s) => schedules.create({ ...s, timezone: "UTC", window: "0m", deduplicationKey: key(s.task) })));
}

export async function detachSchedules() {
  const keys = new Set(SCHEDULES.map((s) => key(s.task)));
  const detached: string[] = [];
  for await (const schedule of schedules.list()) {
    if (schedule.active && schedule.deduplicationKey && keys.has(schedule.deduplicationKey)) {
      await schedules.deactivate(schedule.id);
      detached.push(schedule.id);
    }
  }
  return detached;
}

if (process.argv[1]?.endsWith("attach-schedules.ts")) {
  console.log(process.argv.includes("--detach") ? await detachSchedules() : (await attachSchedules()).map((s) => `${s.task} ${s.generator.expression} ${s.id}`));
}
```

`window: "0m"` needs a paid plan. `check-trigger-env.ts` lists the variables your tasks read, from preflight's `trigger-dev/env-vars` finding, that an environment doesn't have:

```typescript
// in scripts/check-trigger-env.ts
// TRIGGER_SECRET_KEY=tr_prod_... node scripts/check-trigger-env.ts prod DATABASE_URL SHOPIFY_API_SECRET ...
import { envvars } from "@trigger.dev/sdk";

export async function missingTaskEnv(projectRef: string, environment: string, names: string[]) {
  const set = new Set((await envvars.list(projectRef, environment)).map((v) => v.name));
  return names.filter((name) => !set.has(name));
}

if (process.argv[1]?.endsWith("check-trigger-env.ts")) {
  const missing = await missingTaskEnv("proj_abc123", process.argv[2], process.argv.slice(3));
  console.log(missing.length ? `missing in ${process.argv[2]}: ${missing.join(", ")}` : "all set");
  process.exit(missing.length ? 1 : 0);
}
```

### Re-creating jobs Gadget had scheduled

List the background actions with a future `startAt`, from the records they were scheduled for or the Queues dashboard, and trigger each one again. The key's TTL covers the whole delay, so running the script twice starts nothing new:

```typescript
// in scripts/requeue-scheduled-jobs.ts
// run once, on the host: node scripts/requeue-scheduled-jobs.ts scheduled-jobs.json
import { readFileSync } from "node:fs";
import { enqueue } from "../app/services/jobs.server";

type ScheduledJob = { id: string; action: string; shopId: string; params: { orderId: string }; startAt: string; priority?: "high" | "default" | "low" };

// the Gadget action each task replaces
const TASKS: Record<string, string> = { notifyExternalSystem: "notify-external-system" };

export async function requeueScheduledJobs(jobs: ScheduledJob[], now = new Date()) {
  const runs: string[] = [];
  for (const job of jobs) {
    const task = TASKS[job.action];
    if (!task) throw new Error(`no task for ${job.action}: add it to TASKS`);
    const startAt = new Date(job.startAt);
    const handle = await enqueue(task, { shopId: job.shopId, ...job.params }, { shopId: job.shopId, id: `requeued-${job.id}`, priority: job.priority, startAt: startAt > now ? startAt : undefined });
    runs.push(handle.id);
  }
  return runs;
}

if (process.argv[1]?.endsWith("requeue-scheduled-jobs.ts") && process.argv[2]) {
  console.log(`triggered ${(await requeueScheduledJobs(JSON.parse(readFileSync(process.argv[2], "utf8")))).length} runs`);
}
```

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform/trigger-dev#cut-over-to-the-new-platform) hold. What changes with Trigger.dev:

- **Before the day:** deploy the tasks to production with no declarative `cron`, and check that `schedules.list()` with the production key returns nothing active.
- **Move scheduled work:** turn off Gadget's scheduler triggers, then run `scripts/attach-schedules.ts` and `scripts/requeue-scheduled-jobs.ts` with the production key.
- **Deploys during the move:** a run uses the version deployed when it started, and so do its retries, so a fix deploys for new runs only. Replay old runs from the dashboard.
- **Moving back:** `node scripts/attach-schedules.ts --detach`, then turn Gadget's scheduler triggers back on. Delayed runs already triggered still run; cancel them with `runs.cancel(id)`.

## What wasn't verified

Every TypeScript block typechecks with `@trigger.dev/sdk` and `@trigger.dev/build` 4.8.3 and TypeScript 5.9.3. `enqueue`, the two scripts, and `check-trigger-env.ts` ran against a local stand-in for Trigger.dev's API, which checked the requests the SDK sends: `concurrencyKey`, `priority`, `delay`, and an `idempotencyKeyTTL` that outlasts the delay. The version mismatch error was reproduced with the 4.8.3 and 4.8.4 CLIs and SDK.

Not run here: a real Trigger.dev instance, cloud or self-hosted, so the queue's per-store limit, priority, retries, schedules, `syncEnvVars`, `prismaExtension`, and the run statuses come from the guide's measurements on self-hosted 4.8.3 and from Trigger.dev's docs. Whether the server treats a schedule with no declarative `cron` as idle until `schedules.create` comes from the [scheduled tasks](https://trigger.dev/docs/tasks/scheduled) page, and which key types the schedules and environment variable endpoints accept wasn't checked. The Prisma row is Prisma's own message for a client that was never generated, not one seen from a deployed task.
