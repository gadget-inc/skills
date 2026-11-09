# Porting actions

## What is this?

A Gadget action is a file that exports `run` and, optionally, `onSuccess`. On the new platform each action becomes an ordinary function. The code inside mostly ports line by line. What gets lost is the order Gadget ran things in, which your code relied on without saying so:

- `run` in a model action runs inside a database transaction, unless the action sets `transactional: false`. If it throws, Gadget rolls back every write made with `save` and the Internal API.
- `onSuccess` runs only after that transaction commits.
- `api.internal.*` calls inside `run` share its transaction. Calling another action with `api.<model>.<action>()` starts a separate transaction that commits on its own, so a later throw in `run` doesn't undo it.
- Global actions run outside a transaction unless they set `transactional: true`.
- Gadget stops a transaction after 8 seconds (`GGT_TRANSACTION_TIMEOUT`). Actions on framework 1.4 and later stop after 15 seconds by default (`GGT_ACTION_TIMEOUT`), and `timeoutMS` raises that to at most 15 minutes.

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
      await tx.shopifyOrder.create({ data: { id: BigInt(order.id), shopId, totalPrice: order.total_price } });
      await tx.auditLog.create({ data: { event: "orderCreated", orderId: BigInt(order.id), shopId } });
    },
    { timeout: 8_000 } // Prisma's default is 5 seconds, shorter than Gadget's 8
  );

  // after the commit, like onSuccess
  await externalQueue.add("notifyExternalSystem", { orderId: String(order.id), shopId: String(shopId) }, { jobId: `order-${order.id}`, attempts: 7, backoff: { type: "exponential", delay: 1000 } });
}
```

The order and its audit log save together or not at all, and the job is only queued after both are saved.

### ❌ Calling out from inside the transaction

```typescript
await prisma.$transaction(async (tx) => {
  await tx.shopifyOrder.create({ data });
  await fetch("https://erp.example.com/orders", { method: "POST", body: JSON.stringify(data) }); // can't be rolled back
  await tx.auditLog.create({ data: audit }); // if this throws, the ERP still has the order
});
```

It also holds a database connection and its locks for as long as the remote call takes.

## A job that must never be lost

`onSuccess` and the "after the commit" line above share a gap: if the process dies between the commit and the `add`, the job is never queued. If that matters, write the job into a table in the same transaction and have a worker move rows from the table to the queue:

```sql
-- in db/migrations/outbox.sql
create table outbox (
  id bigserial primary key,
  job_name text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
```

The worker selects rows with `for update skip locked`, queues each with its `id` as the job id so a repeat is dropped, and deletes the row.

## The rest of the action context

| Gadget | Replacement |
|---|---|
| `applyParams`, `save` | Inserts and updates in your database client |
| `record.changed("field")` | Lock and read the stored row, then compare it with the new values before writing ([shopify-webhooks.md](shopify-webhooks.md) has the pattern) |
| `trigger.type`, such as `api`, `shopify_webhook`, `shopify_webhook_reconciliation`, `shopify_sync`, `scheduler`, `background-action` | Pass a `source` argument into the function if the code branches on it |
| `api.internal.<model>` | Database queries inside the same transaction |
| `api.<model>.<action>()` from another action | A call to that action's new function. On Gadget it ran in its own transaction; decide whether it should share the caller's now |
| `api.enqueue` | Your job queue ([background-jobs.md](background-jobs.md)) |
| `connections.shopify.current` | The template's `authenticate.admin(request)` client, or `unauthenticated.admin(shop)` in jobs and webhooks |
| `connections.shopify.forShopId(id)` | `unauthenticated.admin(shopDomain)` |
| `preventCrossShopDataAccess` | Row-level security or a scoped helper ([shop-tenancy.md](shop-tenancy.md)) |
| `logger` | Your host's logger |
| `emails.sendMail` | Your email provider's client. Gadget sent through its own service unless you called `emails.setTransport` |

## HTTP routes

Gadget route handlers are Fastify handlers (`export default async function route({ request, reply, api, logger, connections })`). On a Fastify server they move almost unchanged: register each one at the path its file name gave it (`api/routes/products/GET-[id].ts` is `GET /products/:id`), and replace `api` and `connections` as above. Route plugins in `+scope.ts` files become Fastify plugins registered on the same prefix.

## Common pitfalls

- **Outside calls inside the transaction.** They can't be rolled back, and they hold connections open.
- **Prisma's 5-second default timeout.** Transactions Gadget allowed 8 seconds for fail with `Transaction already closed`.
- **Assuming a called action shares the transaction.** On Gadget, `api.<model>.<action>()` committed on its own. Port the behavior you actually had.
- **Dropping `trigger` checks.** An action that skipped work for `shopify_sync` will do it for every backfilled record if the check disappears.

## Related references

- [background-jobs.md](background-jobs.md): what `onSuccess` usually queued
- [shop-tenancy.md](shop-tenancy.md): the `set_config` call each transaction starts with
