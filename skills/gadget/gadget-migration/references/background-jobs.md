# Background and scheduled actions

## What is this?

Background actions are actions Gadget ran later, outside the request that queued them, with retries. Scheduled actions are global actions with a `scheduler` trigger. Both need a job queue and a scheduler on the new platform, and the queue has to support each `api.enqueue` option your app uses. The inventory script lists every `api.enqueue` call and the options it passes.

## What each option did, and what replaces it

| `api.enqueue` option | What Gadget did | BullMQ | Cloud Tasks | Inngest | Trigger.dev |
|---|---|---|---|---|---|
| `retries` | 6 retries by default, 1 s apart and doubling, no jitter | `attempts: 7, backoff: { type: "exponential", delay: 1000 }` | Queue retry config | `retries` on the function | `retry` on the task |
| `queue: { name, maxConcurrency }` | At most `maxConcurrency` jobs from that queue name at once, 1 by default | No per-key limit in the free version (see below) | Per queue only | `concurrency: { limit, key }` | `concurrency` plus `concurrencyKey` |
| `priority` | `HIGH` before `DEFAULT` before `LOW` | `priority` | None: use a separate queue | Priority expressions | Queue priority |
| `startAt` | Runs at a future time | `delay` in ms | `scheduleTime` | `step.sleepUntil` | `delay` |
| `id` with `onDuplicateID` | Rejects or ignores a second job with the same id until 1 day after the first succeeds, or 7 days after it fails | `deduplication: { id, ttl }` | Task name, reserved for up to 24 hours after deletion | Event `id` | `idempotencyKey` |

The BullMQ column was run against BullMQ 5.81. The other columns follow each vendor's documentation; check the option names against the version you install.

## Retries

Gadget retried a background action from the start: an API call that succeeded before a later error ran again on the retry. Most queues do the same. Inngest is the exception: each `step.run()` retries on its own, so finished steps don't repeat, but code outside a step does. Write every job so running it twice gives the same result as running it once, such as by sending a full update keyed on the record id instead of an increment.

BullMQ's exponential backoff waits `2^(attemptsMade - 1) * delay` ms, so `attempts: 7` with `delay: 1000` waits 1, 2, 4, 8, 16, and 32 seconds, the same schedule as Gadget's default 6 retries. A job with no `attempts` is never retried.

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

A plain `jobId` also blocks duplicates, but only while the first job is still stored in Redis, which is forever unless you set `removeOnComplete`, and then only until it's removed. The `ttl` gives a fixed window, counted from when the first job was added rather than when it finished.

## A concurrency limit per store

This is the option that needs the most care. ``queue: { name: `external-${shopId}`, maxConcurrency: 2 }`` gave every store its own limit of 2: on 300 stores, up to 600 jobs at once, and one busy store never held up the others. A single queue with a limit of 2 makes every store wait behind the busiest one.

Inngest and Trigger.dev do this directly. These two follow their documentation and weren't run:

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

BullMQ has per-group limits only in the paid BullMQ Pro. With the free version, gate each job on a Postgres advisory lock per store and slot, and put the job back in the queue when every slot is taken:

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

`withShopSlot` uses session-level locks, so it needs a direct database connection or a pooler in session mode. Behind a pooler in transaction mode, such as Supabase's port 6543, Neon's pooled endpoint, or RDS Proxy, the lock and the unlock can run on different server connections, and the slot stays taken. If the job fits in one transaction, use `pg_try_advisory_xact_lock` inside it instead.

## Scheduled actions

```typescript
// in api/actions/pruneAuditLogs.ts (Gadget)
export const options: ActionOptions = {
  triggers: { scheduler: [{ every: "day", at: "02:00 UTC" }] },
};
```

becomes a cron job with the schedule `0 2 * * *` that calls the same function. Gadget's scheduler made three promises, and not every replacement keeps them:

- **At most once a minute.** Railway cron jobs must be at least 5 minutes apart, and Vercel Schedules run at most every 15 minutes on the Hobby plan.
- **No overlapping runs.** Gadget skipped a run while the previous one was still going. Railway skips too, and Render delays the next run until the current one finishes. Vercel can start overlapping runs, and Vercel and Cloud Scheduler can deliver the same run twice.
- **Retries.** Gadget retried a failed run, up to 5 attempts. Check whether your scheduler retries, or a failed nightly job waits a whole day.

Where runs can overlap or repeat, take a transaction-level advisory lock at the start and exit when another run holds it:

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

The transaction-level lock releases when the transaction ends, so a pooled connection never keeps it. For work too long for one transaction, use `pg_try_advisory_lock` on a dedicated connection and unlock in `finally`.

## Moving jobs at cutover

Let Gadget finish the background actions already queued. Ones with a future `startAt` wait until that time, so create them again in the new queue. Turn off Gadget's scheduler triggers when the new cron jobs start, so each job runs in one place.

## Common pitfalls

- **No `attempts` in BullMQ.** The first error fails the job for good.
- **One shared concurrency limit.** Every store waits behind the busiest one, and a backfill for one store blocks webhook work for all of them.
- **Jobs that can't run twice.** Every queue retries. Increments and "send email" steps need an idempotency key.
- **Assuming the scheduler skips overlaps or retries.** Check the host's rules, and add the lock.

## Related references

- [actions-and-transactions.md](actions-and-transactions.md): queuing a job after the commit
- [shopify-sync.md](shopify-sync.md): reconciliation, which runs per store on a schedule
