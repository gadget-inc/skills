# Porting actions

## What is this?

A Gadget action is a file that exports `run` and, optionally, `onSuccess`. On the new platform each action becomes an ordinary function. The code inside mostly ports line by line. What gets lost is the order Gadget ran things in, which your code relied on without saying so:

- `run` in a model action runs inside a database transaction, unless the action sets `transactional: false`. If it throws, Gadget rolls back every write made with `save` and the Internal API.
- `onSuccess` runs only after that transaction commits. An error in `onSuccess` doesn't undo the commit.
- `api.internal.*` calls inside `run` share its transaction. Calling another action with `api.<model>.<action>()` starts a separate transaction that commits on its own, so a later throw in `run` doesn't undo it.
- `api.enqueue` inside a transactional `run` is part of the transaction: if `run` throws, the job is never queued.
- Global actions run outside a transaction unless they set `transactional: true`.
- Gadget stops a transaction after 8 seconds (`GGT_TRANSACTION_TIMEOUT`). `run` and `onSuccess` together stop at the action's timeout (`GGT_ACTION_TIMEOUT`): 15 seconds by default on framework 1.4 and later, 3 minutes before that, and whatever `timeoutMS` sets, up to 15 minutes.

The split is the part most often lost. Suppose `run` calls a payment API and then a later write fails. The database rolls back, the payment doesn't, and the record says nothing happened. Your new code needs the same split: database writes inside the transaction, outside calls after it commits.

## ✅ The same action, before and after

```typescript
// in api/models/shopifyOrder/actions/create.ts (Gadget)
export const run: ActionRun = async ({ params, record, api }) => {
  applyParams(params, record);
  await preventCrossShopDataAccess(params, record);
  await save(record);
  await api.internal.auditLog.create({ event: "orderCreated", order: { _link: record.id }, shop: { _link: record.shopId } });
};

export const onSuccess: ActionOnSuccess = async ({ record, api }) => {
  await api.enqueue(api.notifyExternalSystem, { orderId: record.id }, { queue: { name: `external-${record.shopId}`, maxConcurrency: 2 } });
};
```

```typescript
// in app/services/orders.server.ts (Prisma and BullMQ)
export async function handleOrderCreated(shopId: bigint, order: OrderWebhookPayload) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`select set_config('app.shop_id', ${shopId.toString()}, true)`; // shop tenancy, see shop-tenancy.md
      // a retry after the commit finds the order already saved and skips both writes
      const { count } = await tx.shopifyOrder.createMany({
        data: [{ id: BigInt(order.id), shopId, totalPrice: order.total_price }],
        skipDuplicates: true,
      });
      if (count === 1) await tx.auditLog.create({ data: { event: "orderCreated", orderId: BigInt(order.id), shopId } });
    },
    { timeout: 8_000 } // Prisma's default is 5 seconds, shorter than Gadget's 8
  );

  // after the commit, like onSuccess, and on every retry, where the jobId stops a second job
  await externalQueue.add("notifyExternalSystem", { orderId: String(order.id), shopId: String(shopId) }, { jobId: `order-${order.id}`, attempts: 7, backoff: { type: "exponential", delay: 1000 } });
}
```

The order and its audit log save together or not at all, and the job is only queued after both are saved. A retry after the commit finds the order saved, skips both writes, and reaches the `add`, where the `jobId` stops a second job. With a plain `create`, a webhook job whose `add` failed after the commit throws on the order's id on every retry, and the job is never queued.

### ❌ Calling out from inside the transaction

```typescript
await prisma.$transaction(async (tx) => {
  await tx.shopifyOrder.create({ data });
  await fetch("https://erp.example.com/orders", { method: "POST", body: JSON.stringify(data) }); // can't be rolled back
  await tx.auditLog.create({ data: audit }); // if this throws, the ERP still has the order
});
```

It also holds a database connection and its locks for as long as the remote call takes. A `queue.add` in the same place has the same problem: a rollback doesn't take the job back.

## A job that must never be lost

`onSuccess` and the "after the commit" line above share a gap: if the process dies between the commit and the `add`, the job is never queued. A job queued only when the write changed something has a wider gap. Any failed `add` loses it, because the retry finds the change already committed and decides not to queue. [shopify-webhooks.md](shopify-webhooks.md) has two such jobs, one for an order whose payment status changed and one for a store that installed the app. An `api.enqueue` inside a transactional `run` didn't have either gap, because Gadget saved the job with the transaction. To keep that, write the job into a table in the same transaction and have a worker move rows from the table to the queue:

```sql
-- in db/migrations/outbox.sql
create table outbox (
  id bigserial primary key,
  job_name text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
```

Inside the transaction, `insert into outbox (job_name, payload) values ('notifyExternalSystem', '{"orderId": "5123456789"}')` replaces the `add`. A rollback removes the row with everything else.

```typescript
// in app/jobs/outbox.server.ts
import type { Pool } from "pg";

type OutboxJob = { id: string; name: string; payload: unknown };

// Moves up to `limit` rows from the outbox to the queue and returns how many it moved. Run it on a
// short timer. `add` must drop a second job with the same id, because a crash after `add` and
// before the commit leaves the row in place and the next run sends it again.
export async function drainOutbox(pool: Pool, add: (job: OutboxJob) => Promise<unknown>, limit = 100): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // skip locked lets two workers drain at once without sending the same row twice
    const { rows } = await client.query("select id, job_name, payload from outbox order by id limit $1 for update skip locked", [limit]);
    for (const row of rows) {
      await add({ id: `outbox-${row.id}`, name: row.job_name, payload: row.payload });
    }
    await client.query("delete from outbox where id = any($1::bigint[])", [rows.map((row) => row.id)]);
    await client.query("commit");
    return rows.length;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
```

```typescript
setInterval(() => {
  drainOutbox(pool, (job) => externalQueue.add(job.name, job.payload, { jobId: job.id, attempts: 7, backoff: { type: "exponential", delay: 1000 } })).catch((error) => logger.error(error));
}, 1000);
```

The `jobId` is what drops the repeat, so don't set `removeOnComplete: true` on this queue. Keep finished jobs for at least a few minutes, for example with `removeOnComplete: { age: 3600 }`.

## Nested actions and `api.transaction`

- **Nested actions.** One API call that created a record and its children, such as an order with `lineItems: [{ create: { ... } }]`, ran every action's `run` in one transaction, committed, and then ran every `onSuccess`. Port it as one transaction around all the writes, with the outside calls after it.
- **`api.transaction(async () => { ... })`** in an `onSuccess`, a route, or a non-transactional action is a transaction you opened yourself. It becomes one `$transaction` or one `begin` and `commit` pair, and it had the same 8-second limit.
- **Bulk actions** such as `api.widget.bulkCreate([...])` ran the action once per record, each in its own transaction, and reported errors per record. One failed record left the others saved, which is what a loop of separate transactions gives you.

## The rest of the action context

| Gadget | Replacement |
|---|---|
| `applyParams`, `save` | Inserts and updates in your database client. `save` also ran the field validations, which are now constraints or checks in code ([schema-mapping.md](schema-mapping.md)) |
| `record.changed("field")`, `record.changes()` | Lock and read the stored row, compare it with the new values before writing, and write any job the comparison decides on to the outbox above ([shopify-webhooks.md](shopify-webhooks.md) has the pattern) |
| `trigger.type`, such as `api`, `shopify_webhook`, `shopify_webhook_reconciliation`, `shopify_sync`, `scheduler`, `background-action` | Pass a `source` argument into the function if the code branches on it |
| `api.internal.<model>` | Database queries inside the same transaction. Port each `findMany` with three things Gadget did: `notEquals` also matched null, so use `is distinct from`; Gadget added `id` as the last sort key, so end the `order by` with `id`; and it returned 50 records unless `first` was passed. [frontend.md](frontend.md#three-things-gadget-did-on-every-read) has a query where `<>` returns 6 rows and Gadget returned 8 |
| `api.<model>.<action>()` from another action | A call to that action's new function. On Gadget it ran in its own transaction; decide whether it should share the caller's now |
| `api.enqueue` | Your job queue ([background-jobs.md](background-jobs.md)) |
| `api.actAsSession`, `api.actAsAdmin` | `api` in actions and routes had admin access unless the code used `actAsSession`. Loaders in `web/` had the session's access unless they used `actAsAdmin`. Port each call with the access it had ([shop-tenancy.md](shop-tenancy.md)) |
| `session`, `params` | The verified session from your sign-in provider or Shopify's template, and the validated request body. Gadget checked `params` against the action's inputs, so validate them yourself, for example with a schema library |
| `connections.shopify.current` | The template's `authenticate.admin(request)` client, or `unauthenticated.admin(shop)` in jobs and webhooks |
| `connections.shopify.forShopId(id)` | `unauthenticated.admin(shopDomain)` |
| `preventCrossShopDataAccess` | Row-level security or a scoped helper ([shop-tenancy.md](shop-tenancy.md)) |
| `signal` | An `AbortSignal` you create, such as `AbortSignal.timeout(15_000)`, passed to each `fetch` |
| `logger` | Your host's logger |
| `emails.sendMail` | Your email provider's client. Gadget sent through its own service unless you called `emails.setTransport` |

## HTTP routes

Gadget route handlers are Fastify handlers (`export default async function route({ request, reply, api, logger, connections })`). On a Fastify server they move almost unchanged: register each one at the path its file name gave it, and replace `api` and `connections` as above.

| Gadget file | Fastify route |
|---|---|
| `api/routes/products/GET-[id].ts` | `GET /products/:id` |
| `api/routes/GET-[[id]].ts` | `GET /:id?` |
| `api/routes/files/GET-[...].ts` | `GET /files/*` |
| `api/routes/admin/+auth.ts`, or any file whose name starts with `+` | A Fastify plugin registered on the `/admin` prefix, which covers that folder and its subfolders |
| `api/boot/*.ts` | A plugin registered on the root server before any route |

Routes had no transaction unless the code opened one with `api.transaction`, and `api` in a route had admin access. Any sign-in or role check on a route was code in the handler or in a `+` plugin, so port those checks as they are.

## Common pitfalls

- **Outside calls inside the transaction.** They can't be rolled back, and they hold connections open.
- **Prisma's 5-second default timeout.** Transactions Gadget allowed 8 seconds for fail with `Transaction already closed`.
- **Assuming a called action shares the transaction.** On Gadget, `api.<model>.<action>()` committed on its own. Port the behavior you actually had.
- **Moving an `api.enqueue` out of `run` without the outbox.** Inside a transactional `run` it committed with the writes. After the commit, a crash in between loses the job, and if the job depends on what the write changed, so does a failed `add`.
- **Dropping `trigger` checks.** An action that skipped work for `shopify_sync` will do it for every backfilled record if the check disappears.
- **Dropping the timeout.** A Gadget action stopped at 15 seconds unless `timeoutMS` said otherwise. A plain function waits on a stuck remote call for as long as the socket stays open.

## Related references

- [background-jobs.md](background-jobs.md): what `onSuccess` usually queued
- [shop-tenancy.md](shop-tenancy.md): the `set_config` call each transaction starts with
