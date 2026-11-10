# Inngest

## What is this?

Inngest is a hosted queue that calls an endpoint in your app to run each step of a job, so it replaces background actions and scheduled actions without a worker process. Gadget's guide covers the setup and why each option maps the way it does: https://docs.gadget.dev/guides/moving-to-another-platform/inngest.

For Inngest itself (the SDK, keys, the serve endpoint, the Dev Server, syncs), load Inngest's `inngest-setup` skill, with `inngest-flow-control` and `inngest-durable-functions` for the options this file maps: `npx skills add inngest/inngest-skills` (https://github.com/inngest/inngest-skills). This file covers only what breaks or changes because the app came from Gadget.

Read [common.md](common.md) first, and [background-jobs.md](../background-jobs.md) for the option-by-option map from `api.enqueue`.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform inngest
```

| Check | What it catches |
|---|---|
| `inngest/function-not-served` | A `createFunction` result missing from the `functions` array, or no `serve()` or `connect()` at all. It never runs and nothing errors. |
| `inngest/bigint-in-send` | A `bigint` in event data, such as a Prisma `BigInt` id. `inngest.send` drops the field. |
| `inngest/key-field-missing` | An event sent without the field its function's `concurrency`, `idempotency`, or `singleton` key reads. Those events share one limit. |
| `inngest/send-in-transaction` | `inngest.send` inside `prisma.$transaction(...)`. A rollback leaves the event sent. |
| `inngest/work-outside-step` | An `await` in a handler outside `step.run`. It reruns every time the function resumes. |
| `inngest/cron-overlap` | A cron function that does its work with no `singleton`. Runs overlap, and the run can't be rerun from the dashboard. |
| `inngest/cron-synced-early` | A cron function served unconditionally. It runs as soon as production syncs, before the cutover. |
| `inngest/negative-priority` | A `priority.run` that can return a negative number, which delays a run even on an empty queue. |
| `inngest/account-scope` | `scope: "account"`, which shares the limit with staging. |
| `inngest/max-runtime` | No `checkpointing.maxRuntime`. The default is 10 seconds in 4.26.2 and unlimited in the docs. |
| `inngest/dev-flag-in-config` | `INNGEST_DEV` in a Dockerfile, `fly.toml`, `render.yaml`, or other deploy config. |
| `inngest/large-payload` | A whole webhook payload sent as event data. The Free plan's limit is 256 KiB and the Dev Server's is 3 MiB. |

What the script can't see:

- **Every function is registered, and production synced after the deploy.** The Dev Server's `function_count` counts each `createFunction` plus one for each `onFailure`, so 4 functions with 1 failure handler print 5. In production, check the app's function list in the Inngest dashboard, and sync after every deploy that changes a function, as `inngest-cli` describes.
- **Queues two Gadget actions shared.** The inventory's `api.enqueue` section lists each call's `queue` name. Every function that replaces an action on the same queue name needs the same `scope: "env"` key, as in the complete example below. A plain `key` gives each function its own limit.
- **The plan's step cap.** On 300 stores, a per-store limit of 2 allows 600 steps at once, above every plan's account cap on the [limits page](https://www.inngest.com/docs/durable-execution/limits). The account cap then decides throughput.
- **Keys per environment.** Staging's host needs the staging environment's `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`, not production's. Compare `ggt var list` with the host's variable names as [common.md](common.md#checks-to-run) says, and check each key's environment in the dashboard.

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| `fetch failed`, with the cause `connect ECONNREFUSED 127.0.0.1:8288` | `INNGEST_DEV=1` with no Dev Server: in production config, or locally before starting `inngest-cli dev` | Remove it from deploy config (`inngest/dev-flag-in-config`), or start the Dev Server |
| `Inngest API Error: 400 Event is over the max size: Max 3145728 bytes / Size 4194361 bytes` | The Dev Server's 3 MiB event limit. The Free plan's is 256 KiB | Send ids, and load records in a step |
| An event sent with `{ shopId: 123n, nested: { orderId: 5n }, list: [1n, 2] }` arrives as `{"list":[null,2],"nested":{}}` | `inngest.send` drops `bigint` fields at any depth and turns one in an array into `null` | Convert to strings first, as `toEventData` below does |
| A job runs, but every store waits behind the busiest one | The event lacks the field the concurrency key reads, so it lands in the keyless limit | `inngest/key-field-missing`. Put `shopId` in every event |
| `StepError [NonRetriableError]: order 1 no longer exists`, the run `FAILED` after one attempt | `NonRetriableError` thrown in a step: no retries, then `onFailure` runs once | Expected. Throw it only for errors a retry can't fix |
| `inngest.send` returns an id, and no run starts | A second event with the same `id` within 24 hours. It returns a new event id, not an error, even when the first run failed | Rerun the failed run from the dashboard instead of sending again ([Drop duplicate jobs](https://docs.gadget.dev/guides/moving-to-another-platform/inngest#drop-duplicate-jobs)) |
| A log line inside a handler prints twice for one run | Code outside `step.run` runs again each time the function resumes in a new request: after a sleep, a failed step, or a request that reached `maxRuntime` | Move side effects into steps (`inngest/work-outside-step`) |
| Each retry of a long step fails at the same second, such as a `504` after 5 minutes on Cloud Run | The request outlasts the host's timeout: `maxRuntime` plus the longest step is above it | Lower `maxRuntime`, or split the step ([Check your host's time limits](https://docs.gadget.dev/guides/moving-to-another-platform/inngest#check-your-host-s-time-limits)) |
| Gadget's scheduled action and the Inngest cron both ran last night | Production synced the cron function before the cutover | Serve crons behind `INNGEST_SCHEDULES`, as below |

## Complete examples

### The functions file

This maps every Gadget behavior the guide covers: a per-store limit that two functions share, Gadget's three priorities, `trigger.finalAttempt`, errors that shouldn't retry, and a scheduled action that can be rerun and is served only after the cutover. The guide's route at [Serve the endpoint](https://docs.gadget.dev/guides/moving-to-another-platform/inngest#serve-the-endpoint) serves `functions` unchanged.

```typescript
// in app/inngest.server.ts
import { Inngest, NonRetriableError } from "inngest";
import { notifyExternalSystem, OrderNotFoundError } from "./services/external.server";
import { deleteAuditLogsOlderThan } from "./services/audit-logs.server";
import { reportFailedJob } from "./services/alerts.server";

export const inngest = new Inngest({
  id: "my-app",
  // a request stops starting new steps after 4 minutes; with 3-second steps it ends by 4m03s, inside Cloud Run's 5-minute default
  checkpointing: { maxRuntime: "4m" },
});

// Gadget's external-${shopId} queue with maxConcurrency 2. scope "env" counts the runs of every function
// that uses this key, like a Gadget queue counted every action on it. The prefix keeps it apart from other per-store limits.
// An object, not a one-element array: TypeScript reads [{...}] as an array, which `concurrency` doesn't accept.
const externalQueue = { scope: "env" as const, key: '"external-" + event.data.shopId', limit: 2 };

// high, default, and low. Events with no priority field get 300, like default; nothing is negative, so nothing waits on an empty queue.
const gadgetPriority = { run: "event.data.priority == 'high' ? 600 : event.data.priority == 'low' ? 0 : 300" };

async function notify(orderId: string) {
  try {
    await notifyExternalSystem(orderId);
  } catch (error) {
    // Gadget retried every error. A retry can't bring back a deleted order.
    if (error instanceof OrderNotFoundError) throw new NonRetriableError(error.message, { cause: error });
    throw error;
  }
}

export const notifyExternalSystemFn = inngest.createFunction(
  {
    id: "notify-external-system",
    triggers: [{ event: "app/order.created" }],
    concurrency: externalQueue,
    priority: gadgetPriority,
    retries: 6,
    // where trigger.finalAttempt code goes: runs once, after the last retry or a NonRetriableError
    onFailure: async ({ error, event }) => {
      await reportFailedJob("notify-external-system", event.data.event.data.orderId, error.message);
    },
  },
  async ({ event, step }) => {
    await step.run("notify", () => notify(event.data.orderId));
  }
);

// a second action that used the same Gadget queue: together the two run at most 2 jobs per store
export const notifyExternalSystemOfUpdateFn = inngest.createFunction(
  {
    id: "notify-external-system-of-update",
    triggers: [{ event: "app/order.updated" }],
    concurrency: externalQueue,
    priority: gadgetPriority,
    retries: 6,
  },
  async ({ event, step }) => {
    await step.run("notify", () => notify(event.data.orderId));
  }
);

// pruneAuditLogs at 0 2 * * *. The cron only sends an event: the dashboard can't rerun a cron run, and it can rerun this event's run.
export const pruneAuditLogsSchedule = inngest.createFunction(
  { id: "prune-audit-logs-schedule", triggers: [{ cron: "0 2 * * *" }] },
  async ({ event, step }) => {
    // the scheduled time, the same on every retry of this run, so a retry sends nothing new
    const day = new Date(event.ts ?? Date.now()).toISOString().slice(0, 10);
    await step.sendEvent("start-prune", { name: "app/audit-logs.prune", id: `prune-audit-logs-${day}`, data: { olderThanDays: 90 } });
  }
);

export const pruneAuditLogs = inngest.createFunction(
  {
    id: "prune-audit-logs",
    triggers: [{ event: "app/audit-logs.prune" }],
    // Gadget skipped a scheduled run while the last one was going
    singleton: { mode: "skip" },
    // 5 attempts, like Gadget's scheduler
    retries: 4,
  },
  async ({ event, step }) => {
    await step.run("delete-old-audit-logs", () => deleteAuditLogsOlderThan(event.data.olderThanDays));
  }
);

export const functions = [
  notifyExternalSystemFn,
  notifyExternalSystemOfUpdateFn,
  pruneAuditLogs,
  // Inngest runs a cron as soon as production syncs it. Set INNGEST_SCHEDULES=on in the cutover's "Move scheduled work" step, then sync.
  ...(process.env.INNGEST_SCHEDULES === "on" ? [pruneAuditLogsSchedule] : []),
];
```

With `INNGEST_SCHEDULES` unset, the cron is not in the sync and doesn't run. In the Dev Server, removing it from `functions` and syncing again removed the function and stopped its runs, which is also the way back if the cutover reverses.

### Sending jobs the way `api.enqueue` did

`api.enqueue` calls become `enqueue`. It puts the store in every payload, turns `bigint` values into strings, maps `startAt` to the event's `ts` and `priority` to the field `gadgetPriority` reads, and refuses an event over your plan's size before Inngest does:

```typescript
// in app/services/jobs.server.ts
import { inngest } from "../inngest.server";

export interface EnqueueOptions {
  // api.enqueue's id: a second event with it starts no run for 24 hours, even if the first run failed
  id?: string;
  priority?: "high" | "default" | "low";
  startAt?: Date;
}

// 256 KiB on the Free plan and 3 MiB on paid plans. The Dev Server accepts 3 MiB, so it can't catch this.
const MAX_EVENT_BYTES = Number(process.env.INNGEST_MAX_EVENT_BYTES ?? 256 * 1024);

// inngest.send drops bigint fields without an error, so convert them, nested ones too
export function toEventData(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toEventData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toEventData(item)]));
  return value;
}

// Call after the transaction commits, never inside it.
export async function enqueue(name: string, shopId: bigint | string, data: Record<string, unknown>, options: EnqueueOptions = {}) {
  const event = {
    name,
    data: {
      ...(toEventData(data) as Record<string, unknown>),
      shopId: String(shopId),
      ...(options.priority && options.priority !== "default" ? { priority: options.priority } : {}),
    },
    ...(options.id ? { id: options.id } : {}),
    ...(options.startAt ? { ts: options.startAt.getTime() } : {}),
  };
  const bytes = Buffer.byteLength(JSON.stringify(event));
  if (bytes > MAX_EVENT_BYTES) throw new Error(`${name} is ${bytes} bytes, over the ${MAX_EVENT_BYTES}-byte event limit: send ids and load records in the function`);
  const { ids } = await inngest.send(event);
  return ids[0];
}
```

``await enqueue("app/order.created", shopId, { orderId: order.id }, { id: `order-created-${order.id}` })`` replaces ``api.enqueue(api.notifyExternalSystem, { orderId }, { id: `order-created-${order.id}`, queue: { name: `external-${shopId}`, maxConcurrency: 2 } })``. The queue moves to the function's `concurrency`, so the call no longer names it.

### Re-creating jobs Gadget had scheduled

At cutover, background actions with a future `startAt` wait in Gadget, and Gadget runs them unless you stop it. List them from the records they were scheduled for, such as rows with a future `remindAt`, or from the Queues dashboard, into a JSON file, and send each one again with its time:

```typescript
// in scripts/requeue-scheduled-jobs.ts
// run once, on the host: node scripts/requeue-scheduled-jobs.ts scheduled-jobs.json
import { readFileSync } from "node:fs";
import { enqueue } from "../app/services/jobs.server";

interface ScheduledJob {
  // the Gadget background action's id, or your own stable key for the job
  id: string;
  action: string;
  shopId: string;
  params: Record<string, unknown>;
  startAt: string;
  priority?: "high" | "default" | "low";
}

// the Gadget action each event replaces
const EVENTS: Record<string, string> = { notifyExternalSystem: "app/order.created" };

export async function requeueScheduledJobs(jobs: ScheduledJob[], now = new Date()) {
  const sent: string[] = [];
  for (const job of jobs) {
    const name = EVENTS[job.action];
    if (!name) throw new Error(`no event for ${job.action}: add it to EVENTS`);
    const startAt = new Date(job.startAt);
    // a time already past runs now, as Gadget would have
    await enqueue(name, job.shopId, job.params, { id: `requeued-${job.id}`, priority: job.priority, startAt: startAt > now ? startAt : undefined });
    sent.push(job.id);
  }
  return sent;
}

if (process.argv[1]?.endsWith("requeue-scheduled-jobs.ts") && process.argv[2]) {
  console.log(`sent ${(await requeueScheduledJobs(JSON.parse(readFileSync(process.argv[2], "utf8")))).length} jobs`);
}
```

The event id makes a second run of the script within 24 hours send nothing new. In the Dev Server a job sent for 6 seconds ahead started after 5.3, so `ts` is good to about a second. After 24 hours it would send every job again, so run it once, and cancel the same jobs in Gadget, or turn off the code they call there, before its time comes.

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform/inngest#cut-over-to-the-new-platform) hold. What changes with Inngest:

- **Before the day:** deploy with `INNGEST_SCHEDULES` unset, sync production, and check in the dashboard that the cron functions aren't listed.
- **Move scheduled work:** turn off Gadget's scheduler triggers, set `INNGEST_SCHEDULES=on`, deploy, and sync. Then run `scripts/requeue-scheduled-jobs.ts` on the host.
- **Drain Gadget:** a webhook that reached both apps around the switch can queue the same job in each, because the event `id` only drops duplicates inside Inngest. Only the job itself can make the second run harmless, such as by sending the external system a full update keyed on the order id, as [background-jobs.md](../background-jobs.md#retries) describes.
- **Moving back:** unset `INNGEST_SCHEDULES`, deploy, sync, and turn Gadget's scheduler triggers back on. Events already sent still run in Inngest.

## What wasn't verified

Run with `inngest` 4.26.2 against the `inngest-cli` 1.51.0 Dev Server, served through the `inngest/remix` handler: the functions file, `enqueue`, and the requeue script, including the shared limit across two functions, priority, `ts`, duplicate ids, `NonRetriableError` with `onFailure`, `singleton`, the cron hand-off, and `INNGEST_SCHEDULES`. All blocks typecheck with TypeScript 5.9.3. The failure signatures were reproduced there, except the `504` row, which comes from the guide.

Not run, because they need an Inngest Cloud account: syncs, the dashboard's Rerun, branch environments, the plan's step and event-size caps (from the [limits page](https://www.inngest.com/docs/durable-execution/limits) and the guide), and whether Cloud archives a cron function that a later sync leaves out. The Dev Server passes the cron handler an `inngest/scheduled.timer` event with `ts`, which the example relies on, although Inngest's docs say a cron handler gets no event. The retry delays are the guide's Dev Server measurement; Inngest doesn't publish them.
