# Background and scheduled actions

## What is this?

Background actions are actions Gadget ran later, outside the request that queued them, with retries. Scheduled actions are global actions with a `scheduler` trigger. Both need a job queue and a scheduler on the new platform, and the queue has to support each `api.enqueue` option your app uses. The inventory script lists every `api.enqueue` call and the options it passes.

## What each option did, and what replaces it

| `api.enqueue` option | What Gadget did | BullMQ | Cloud Tasks | Inngest | Trigger.dev |
|---|---|---|---|---|---|
| `retries` | 6 retries by default, 1 s apart and doubling, no jitter | `attempts: 7, backoff: { type: "exponential", delay: 1000 }` | Queue retry config: `maxAttempts`, `minBackoff`, `maxDoublings` | `retries` on the function, 0 to 20, with Inngest's own backoff | `retry: { maxAttempts: 7, factor: 2, minTimeoutInMs: 1000, randomize: false }` |
| `queue: { name, maxConcurrency }` | At most `maxConcurrency` jobs from that queue name at once: 1 by default, 100 at most | No per-key limit in the free version (see below) | `maxConcurrentDispatches`, per queue only | `concurrency: { limit, key }`, with `scope: "env"` and one key for every function on the same queue name | `concurrency: { perKey }` plus `concurrencyKey`, or one shared `queue({ concurrencyLimit })` for tasks on the same queue name |
| `priority` | `high` before `default` before `low` | `priority: 1`, `2`, `3` on every job (see below) | None: use a separate queue | `priority: { run }`, an expression in seconds from -600 to 600 | `priority` when triggering, in seconds |
| `startAt` | Runs at a future time | `delay` in ms | `scheduleTime` | `step.sleepUntil` | `delay` |
| `id` with `onDuplicateID` | Throws `GGT_DUPLICATE_BACKGROUND_ACTION_ID` for a second job with the same id, or returns the first job with `onDuplicateID: "ignore"`, until 1 day after the first succeeds or 7 days after it fails or is cancelled | `deduplication: { id, ttl }` | Task name, reserved for up to 24 hours after the task finishes | Event `id`, for 24 hours | `idempotencyKey` with `idempotencyKeyTTL: "1d"` (the default is 30 days) |

Three defaults to carry over on purpose:

- **A `retries` object without `retryCount` retried 10 times, not 6.** `retries: 3` and no `retries` at all used the 1-second doubling schedule. An object could also set `initialInterval`, `maxInterval`, `backoffFactor`, and `randomizeInterval`.
- **A job with no `queue` had no limit of its own.** Gadget only capped the total an environment ran at once. On the new platform the worker's concurrency is that cap, and you have to pick it.
- **`api.enqueue` inside a transactional `run` was part of the transaction.** If `run` threw, the job was never queued. A `queue.add` call inside your new transaction is not undone by a rollback. Queue after the commit, or use the outbox table in [actions-and-transactions.md](actions-and-transactions.md#a-job-that-must-never-be-lost). A job queued only when the write changed something needs the outbox: if its `add` fails after the commit, the retry finds nothing left to change and never queues it.

The BullMQ column was run against BullMQ 5.81, and the Inngest snippet below against the Inngest dev server with SDK 4.26. The Cloud Tasks and Trigger.dev columns follow their documentation; check the option names against the version you install.

## Retries

Gadget retried a background action from the start: an API call that succeeded before a later error ran again on the retry. Most queues do the same. Inngest is the exception: each `step.run()` retries on its own and has its own retry count, so finished steps don't repeat. Code outside a step runs again every time the function resumes. Write every job so running it twice gives the same result as running it once, such as by sending a full update keyed on the record id instead of an increment.

BullMQ's exponential backoff waits `2^(attemptsMade - 1) * delay` ms, so `attempts: 7` with `delay: 1000` waits 1, 2, 4, 8, 16, and 32 seconds, the same schedule as Gadget's default 6 retries. A job with no `attempts` is never retried.

Code that read `trigger.attemptNumber` or `trigger.finalAttempt` needs the queue's equivalent. In a BullMQ processor, `job.attemptsMade` is 0 on the first run, and the final attempt is the one where `job.attemptsMade + 1 === job.opts.attempts`.

## Timeouts

A background action stopped at the action's timeout: 15 seconds by default on framework 1.4 and later, 3 minutes before that, and whatever `timeoutMS` set, up to 15 minutes. BullMQ has no job timeout, so a job that hangs on a remote call holds its slot until the worker restarts. Pass an `AbortSignal.timeout(ms)` to every `fetch` in a job. Cloud Tasks gives an HTTP handler 10 minutes by default and 30 at most.

The host has a limit too, and a job delivered as an HTTP request ends at whichever limit is shorter. Cloud Run fails a request with a `504` after 5 minutes by default, and 60 minutes is the most it allows. Vercel ends a function after 300 seconds by default, and `maxDuration` raises that up to your plan's maximum, on Vercel's [limits page](https://vercel.com/docs/functions/limitations#max-duration). So an action with `timeoutMS` of 12 minutes, delivered by Cloud Tasks to a Cloud Run service with default settings, fails at 5 minutes. Cloud Tasks retries it from the start, and it fails at 5 minutes on every attempt. Set the host's timeout and the queue's deadline above the longest `timeoutMS` the inventory lists, or split the work into jobs that each finish well inside the limit.

## Duplicate jobs

```typescript
// in app/queues.server.ts
await externalQueue.add("notifyExternalSystem", { orderId }, {
  // a second add with this id within a day is dropped
  deduplication: { id: `order-${orderId}`, ttl: 24 * 60 * 60 * 1000 },
  attempts: 7,
  backoff: { type: "exponential", delay: 1000 },
});
```

The `ttl` gives a fixed window, counted from when the first job was added rather than when it finished, and it keeps blocking after the first job completes. Without a `ttl`, the id is released as soon as the first job completes or fails.

A plain `jobId` also blocks duplicates, but only while the first job is still stored in Redis. That is forever by default, and no time at all for a queue that sets `removeOnComplete: true`.

## Priority

BullMQ runs lower numbers first, and runs jobs with no `priority` before every job that has one. If only the `high` jobs get a number, they run last. Give every job in the queue a number: 1 for `high`, 2 for `default`, 3 for `low`.

## A concurrency limit per store

This is the option that needs the most care. ``queue: { name: `external-${shopId}`, maxConcurrency: 2 }`` gave every store its own limit of 2: on 300 stores, up to 600 jobs at once, and one busy store never held up the others. A single queue with a limit of 2 makes every store wait behind the busiest one.

Inngest and Trigger.dev do this directly:

```typescript
// Inngest
export const notifyExternalSystem = inngest.createFunction(
  { id: "notify-external-system", triggers: [{ event: "orders/notify-external-system" }], concurrency: { limit: 2, key: "event.data.shopId" }, retries: 6 },
  async ({ event, step }) => {
    await step.run("notify", () => notify(event.data.orderId));
  }
);

// Trigger.dev
export const notifyExternalSystem = task({
  id: "notify-external-system",
  concurrency: { perKey: 2 },
  run: async (payload: { orderId: string; shopId: string }) => notify(payload.orderId),
});
await notifyExternalSystem.trigger({ orderId, shopId }, { concurrencyKey: shopId });
```

The Inngest function was run against the Inngest dev server: with 6 events for one store and 2 for another, each store never had more than 2 steps running, a failed step was retried, and the step before it did not run again. Inngest's limit counts steps that are running, so a function that is sleeping or waiting between steps doesn't hold a slot. The Trigger.dev task follows its documentation and wasn't run.

Gadget counted the limit across every action that used the queue name. An Inngest `key` or a Trigger.dev `perKey` counts one function or task, so two of them with a limit of 2 ran 4 jobs for one store at once. The inventory marks each `api.enqueue` call that passes `queue` but doesn't print the name, so read those calls. When two of them pass the same `queue.name`, give every Inngest function that replaces them `concurrency: { scope: "env", key: '"external-" + event.data.shopId', limit: 2 }`, or list one `queue({ name: "external", concurrencyLimit: 2 })` as `queue` on every Trigger.dev task and pass the store's id as `concurrencyKey` on each trigger. Gadget's [Inngest](https://docs.gadget.dev/guides/moving-to-another-platform/inngest#share-a-limit-between-functions) and [Trigger.dev](https://docs.gadget.dev/guides/moving-to-another-platform/trigger-dev#share-a-limit-between-tasks) guides ran both forms: each held one store to 2 jobs across two functions or tasks. A named Trigger.dev `concurrencyLimit()` shared by two tasks did not.

BullMQ has per-group limits only in BullMQ Pro. With open-source BullMQ, gate each job on a Postgres advisory lock per store and slot, and put the job back in the queue when every slot is taken:

```typescript
// in app/jobs/shopSlots.server.ts
import type { Pool } from "pg";

export class ShopBusyError extends Error {}

// Runs fn while holding one of `slots` locks for this queue and store. A session-level lock is
// released when the connection closes, so a crashed worker can't hold a slot forever.
export async function withShopSlot<T>(pool: Pool, queue: string, shopId: string, slots: number, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    for (let slot = 0; slot < slots; slot++) {
      const key = `${queue}:${shopId}:${slot}`;
      const { rows } = await client.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as locked", [key]);
      if (!rows[0].locked) continue;
      try {
        return await fn();
      } finally {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      }
    }
    throw new ShopBusyError(`${queue} is at its limit of ${slots} for shop ${shopId}`);
  } finally {
    client.release();
  }
}
```

```typescript
// in app/workers/external.server.ts
import { DelayedError, Worker } from "bullmq";

new Worker("external", async (job, token) => {
  try {
    await withShopSlot(pool, "external", job.data.shopId, 2, () => notify(job.data.orderId));
  } catch (error) {
    if (!(error instanceof ShopBusyError)) throw error;
    await job.moveToDelayed(Date.now() + 1000, token); // try again in a second without using an attempt
    throw new DelayedError();
  }
}, { connection, concurrency: 20 });
```

Each running job holds one pool connection while it works, so size the pool for the worker's `concurrency`.

`withShopSlot` uses session-level locks, so give it a pool on a direct database connection or a pooler in session mode. Behind a pooler in transaction mode, such as Supabase's port 6543 or Neon's `-pooler` host, the lock and the unlock can run on different server connections. The unlock then does nothing, the slot stays taken after the job finishes, and later jobs for that store are turned away while nothing is running. This was reproduced through PgBouncer 1.23 in transaction mode. RDS Proxy is different: it pins the client to one server connection when it sees a session-level advisory lock, so the lock works there.

## Scheduled actions

```typescript
// in api/actions/pruneAuditLogs.ts (Gadget)
export const options: ActionOptions = {
  triggers: { scheduler: [{ every: "day", at: "02:00 UTC" }] },
};
```

becomes a cron job with the schedule `0 2 * * *` that calls the same function. Gadget's scheduler made three promises, and not every replacement keeps them:

- **At most once a minute, starting within 10 seconds of the scheduled time.** Railway cron jobs must be at least 5 minutes apart. Vercel Schedules, in beta, start each run within a window after the scheduled time, and the window and how often a schedule can run depend on your plan ([Vercel's Schedules docs](https://vercel.com/docs/schedules)).
- **No overlapping runs.** Gadget skipped a run while the previous one was still going. Railway skips too, and Render delays the next run until the current one finishes. Vercel can start overlapping runs, and Vercel and Cloud Scheduler can deliver the same run twice. Those hosts protect only the cron command, so once it only adds a job to your queue, two jobs can run at once on a worker whose concurrency is above 1.
- **Retries.** Gadget retried a failed run, up to 5 attempts. Vercel doesn't retry a run that targets a function or a path. Cloud Scheduler doesn't retry unless you set a retry count on the job, which is 0 by default. Render's and Railway's documentation promise no retry. Without one, a failed nightly job waits a whole day.

For retries, keep the cron job small: have it add one job to your queue, and let the queue's retries do the rest. If that job's id drops a repeated run, build the id from the run's scheduled time, never the clock: with today's date, a 23:50 run that starts at 00:05 takes the next day's id, and the next day's real run adds nothing. Cloud Scheduler sends the scheduled time in the `X-CloudScheduler-ScheduleTime` header and Cloudflare in `controller.scheduledTime`; on a host that passes nothing, such as a crontab, use the most recent scheduled time at or before now. With BullMQ you can drop the host's cron and let the queue schedule the job. `upsertJobScheduler` is safe to call from every process at boot, because a second call with the same id replaces the schedule instead of adding another:

```typescript
// in app/cron/schedules.server.ts
await maintenanceQueue.upsertJobScheduler(
  "pruneAuditLogs",
  { pattern: "0 2 * * *", tz: "UTC" }, // without tz, BullMQ reads the pattern in the process's time zone
  { name: "pruneAuditLogs", opts: { attempts: 5, backoff: { type: "exponential", delay: 1000 } } }
);
```

In the job the queue runs, on every host, take a transaction-level advisory lock at the start and exit when another run holds it. Without a queue, put the same lock in the cron job wherever the host can overlap or repeat runs:

```typescript
// in app/cron/pruneAuditLogs.server.ts
import type { Pool } from "pg";

export async function pruneAuditLogs(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query("select pg_try_advisory_xact_lock(hashtextextended('cron:pruneAuditLogs', 0)) as locked");
    if (!rows[0].locked) {
      await client.query("rollback");
      return "skipped: another run holds the lock";
    }
    await client.query("delete from audit_log where created_at < now() - interval '90 days'");
    await client.query("commit"); // releases the lock
    return "done";
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
```

The transaction-level lock releases when the transaction ends, so a pooled connection never keeps it, and it works through a pooler in transaction mode. For work too long for one transaction, use `pg_try_advisory_lock` on a dedicated direct connection and unlock in `finally`.

This job deletes rows for every store. If the tables have a shop policy, it needs the cross-store role described in [shop-tenancy.md](shop-tenancy.md).

## What Gadget's queue did that yours has to

- **It kept jobs through restarts.** BullMQ keeps jobs in Redis. Run Redis with persistence on and `maxmemory-policy noeviction`, or a restart or a full cache drops queued jobs without an error.
- **It carried the store.** A background action ran as the session that queued it, so `connections.shopify.current` worked inside it. A job on the new queue knows only its payload. Put the shop id in every payload.
- **It paced Shopify API calls per store.** Jobs that call Shopify now see `429` responses themselves. Wait for the `Retry-After` header and try again, and keep the per-store concurrency limit low.

## Moving jobs at cutover

Let Gadget finish the background actions already queued, and watch the Queues dashboard in the Gadget editor until it is empty. Ones with a future `startAt` wait until that time, so create them again in the new queue. Turn off Gadget's scheduler triggers when the new cron jobs start, so each job runs in one place.

## Common pitfalls

- **No `attempts` in BullMQ.** The first error fails the job for good.
- **One shared concurrency limit.** Every store waits behind the busiest one, and a backfill for one store blocks webhook work for all of them.
- **Jobs that can't run twice.** Every queue retries. Increments and "send email" steps need an idempotency key.
- **Assuming the scheduler skips overlaps or retries.** Check the host's rules, and put the lock in the job that does the work. Once the cron job only adds a job to your queue, that is the queued job, whatever the host promises about the cron command.
- **Queuing inside the database transaction.** A rollback doesn't take the job back, and the worker can pick the job up before the commit and not find the row.
- **A host timeout shorter than the job.** The job fails at the same point on every retry. Check the host's request timeout as well as the queue's.
- **A priority on some jobs only.** In BullMQ the jobs with no priority run first.
- **A cron process that never exits.** Railway skips a run while the last one is still going, so a script that leaves a database pool or Redis connection open blocks every later run. Close them when the work is done.

## Related references

- [actions-and-transactions.md](actions-and-transactions.md): queuing a job after the commit, and the outbox table
- [shop-tenancy.md](shop-tenancy.md): setting the store inside a job
- [shopify-sync.md](shopify-sync.md): reconciliation, which runs per store on a schedule
